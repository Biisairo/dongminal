package runtimebin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// PEER_NETWORK_SRS FR-PNW-73·74 — 노드 간 통신의 dmctl 명령 (단계 2: 짝맞춤).

const dmctlPeersHelp = `dmctl peers [--json]
  노드 포트 상태, 짝 목록(이름·주소·상태), 승인 대기를 보인다.
`

const dmctlPeerHelp = `dmctl peer — 노드 간 통신의 짝맞춤

  dmctl peer invite [--addr <주소>]           초대 코드를 만들어 출력한다 (10분, 한 번)
  dmctl peer add <코드> [--name <이름>]       초대 코드로 등록을 요청한다
  dmctl peer approve <요청 id> [--name <이름>]  승인 대기를 짝으로 저장한다
  dmctl peer reject <요청 id>                승인 대기를 거절한다
  dmctl peer remove <노드>                   짝을 해제한다
  dmctl peer info <노드>                     상대 노드의 이름·판·받는 명령·설치된 에이전트
  dmctl peer tools <노드> [--json]           상대 노드의 에이전트 도구 목록 (<노드>/<uuid>)
  dmctl msg --to <노드>/<uuid> <메시지>       상대 노드의 에이전트에게 원격 엔벨로프로 보낸다
  dmctl peer spawn <노드> --agent <id> --cwd <경로> [--tab --at <uuid>] [--name <이름>] <프롬프트>
                                             상대 노드에 에이전트를 띄운다. 성공하면 <노드>/<uuid> 를 낸다.
                                             폴더는 상대가 허용한 폴더 안이어야 한다. 권한 모드는 상대의 것이다
  dmctl peer status <노드>/<uuid> [--json]    working · idle · waiting · ended · unknown
  dmctl peer close <노드>/<uuid>              자기가 띄운 에이전트를 끝내고 닫는다

  상대에 닿지 못하면 사유 코드(peer_unreachable 등)를 내고 1 로 끝난다.
`

// fpShown 은 화면에 보이는 지문 길이다 (FR-PNW-80).
const fpShown = 16

func runDmctlPeers(args []string, stdout, stderr io.Writer) int {
	asJSON := false
	for _, a := range args {
		switch a {
		case "-h", "--help":
			fmt.Fprint(stdout, dmctlPeersHelp)
			return 0
		case "--json":
			asJSON = true
		default:
			fmt.Fprintf(stderr, "dmctl peers: 모르는 인자 %q\n", a)
			return 2
		}
	}
	raw, rc := peerAPI("GET", "/api/peers", nil, stderr)
	if rc != 0 {
		return rc
	}
	if asJSON {
		var buf bytes.Buffer
		if json.Compact(&buf, raw) != nil {
			buf.Reset()
			buf.Write(raw)
		}
		fmt.Fprintln(stdout, buf.String())
		return 0
	}
	printPeers(stdout, raw)
	return 0
}

type peersOut struct {
	Node struct {
		Enabled     bool   `json:"enabled"`
		Port        int    `json:"port"`
		Bind        string `json:"bind"`
		Name        string `json:"name"`
		Advertise   string `json:"advertise"`
		Fingerprint string `json:"fingerprint"`
		Listening   bool   `json:"listening"`
		Error       string `json:"error"`
	} `json:"node"`
	Peers []struct {
		Name     string `json:"name"`
		Addr     string `json:"addr"`
		Port     int    `json:"port"`
		FP       string `json:"fp"`
		State    string `json:"state"`
		LastSeen string `json:"lastSeen"`
	} `json:"peers"`
	Pending []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Addr    string `json:"addr"`
		Port    int    `json:"port"`
		FP      string `json:"fp"`
		Expires string `json:"expires"`
	} `json:"pending"`
	Invite *struct {
		Expires string `json:"expires"`
	} `json:"invite"`
}

func shortFP(fp string) string {
	if len(fp) > fpShown {
		return fp[:fpShown]
	}
	return fp
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func hostPort(addr string, port int) string {
	if strings.Contains(addr, ":") {
		return "[" + addr + "]:" + strconv.Itoa(port)
	}
	return addr + ":" + strconv.Itoa(port)
}

func printPeers(w io.Writer, raw []byte) {
	var v peersOut
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Fprintln(w, clean(string(raw)))
		return
	}
	n := v.Node
	fmt.Fprintf(w, "node     name=%s  enabled=%s  bind=%s  port=%d  listening=%s  fp=%s",
		clean(n.Name), yesNo(n.Enabled), clean(n.Bind), n.Port, yesNo(n.Listening), clean(shortFP(n.Fingerprint)))
	if n.Advertise != "" {
		fmt.Fprintf(w, "  advertise=%s", clean(n.Advertise))
	}
	fmt.Fprintln(w)
	if n.Error != "" {
		fmt.Fprintf(w, "         port error: %s\n", clean(n.Error))
	}
	for _, p := range v.Peers {
		state := p.State
		if state == "" {
			state = "paired"
		}
		seen := ""
		if p.LastSeen != "" {
			seen = "  lastSeen=" + clean(p.LastSeen)
		}
		fmt.Fprintf(w, "peer     name=%s  addr=%s  state=%s  fp=%s%s\n", clean(p.Name), clean(hostPort(p.Addr, p.Port)), clean(state), clean(shortFP(p.FP)), seen)
	}
	for _, p := range v.Pending {
		fmt.Fprintf(w, "pending  id=%s  name=%s  addr=%s  fp=%s  expires=%s\n",
			clean(p.ID), clean(p.Name), clean(hostPort(p.Addr, p.Port)), clean(shortFP(p.FP)), clean(p.Expires))
	}
	if v.Invite != nil {
		fmt.Fprintf(w, "invite   expires=%s\n", clean(v.Invite.Expires))
	}
}

// peerArgs 는 위치 인자와 플래그들이다. 모르는 플래그·값이 빠진 플래그는 오류다.
type peerArgs struct {
	pos   []string
	flags map[string]string
	bools map[string]bool
	help  bool
}

func parsePeerArgs(args []string, allowed, bools []string) (peerArgs, error) {
	out := peerArgs{flags: map[string]string{}, bools: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "-h" || a == "--help" {
			out.help = true
			continue
		}
		if !strings.HasPrefix(a, "--") {
			out.pos = append(out.pos, a)
			continue
		}
		name := strings.TrimPrefix(a, "--")
		if slices.Contains(bools, name) {
			out.bools[name] = true
			continue
		}
		ok := false
		for _, f := range allowed {
			ok = ok || f == name
		}
		if !ok {
			return out, fmt.Errorf("모르는 플래그 %s", a)
		}
		if i+1 >= len(args) {
			return out, fmt.Errorf("%s 에 값이 없습니다", a)
		}
		out.flags[name] = args[i+1]
		i++
	}
	return out, nil
}

func runDmctlPeer(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, dmctlPeerHelp)
		return 2
	}
	sub, rest := args[0], args[1:]
	if sub == "-h" || sub == "--help" || sub == "help" {
		fmt.Fprint(stdout, dmctlPeerHelp)
		return 0
	}
	spec, ok := peerSubs[sub]
	if !ok {
		fmt.Fprintf(stderr, "dmctl peer: 모르는 하위 명령 %q\n", sub)
		fmt.Fprint(stderr, dmctlPeerHelp)
		return 2
	}
	pa, err := parsePeerArgs(rest, spec.flags, spec.bools)
	if pa.help {
		fmt.Fprint(stdout, dmctlPeerHelp)
		return 0
	}
	if err == nil && len(pa.pos) != spec.positional {
		err = fmt.Errorf("인자가 %d 개여야 합니다", spec.positional)
	}
	if err != nil {
		fmt.Fprintf(stderr, "dmctl peer %s: %v\n", sub, err)
		return 2
	}
	return spec.run(pa, stdout, stderr)
}

type peerSub struct {
	positional int
	flags      []string
	bools      []string
	run        func(pa peerArgs, stdout, stderr io.Writer) int
}

var peerSubs = map[string]peerSub{
	"invite":  {0, []string{"addr"}, nil, peerInvite},
	"add":     {1, []string{"name"}, nil, peerAdd},
	"approve": {1, []string{"name"}, nil, peerApprove},
	"reject":  {1, nil, nil, peerReject},
	"remove":  {1, nil, nil, peerRemove},
	"info":    {1, nil, nil, peerInfo},
	"tools":   {1, nil, []string{"json"}, peerTools},
	"spawn":   {2, []string{"agent", "cwd", "at", "name"}, []string{"tab"}, peerSpawn},
	"status":  {1, nil, []string{"json"}, peerStatus},
	"close":   {1, nil, nil, peerClose},
}

func peerInvite(pa peerArgs, stdout, stderr io.Writer) int {
	raw, rc := peerAPI("POST", "/api/peers/invite", map[string]any{"addr": pa.flags["addr"]}, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Code    string `json:"code"`
		Expires string `json:"expires"`
	}
	_ = json.Unmarshal(raw, &v)
	// stdout 은 코드 한 줄이다 — 파이프로 그대로 넘길 수 있게 한다.
	fmt.Fprintln(stdout, v.Code)
	fmt.Fprintf(stderr, "초대 코드는 %s 까지 한 번 쓸 수 있습니다. 상대 노드에서 dmctl peer add <코드> 를 실행하세요.\n", v.Expires)
	return 0
}

func peerAdd(pa peerArgs, stdout, stderr io.Writer) int {
	body := map[string]any{"code": pa.pos[0]}
	if n := pa.flags["name"]; n != "" {
		body["name"] = n
	}
	raw, rc := peerAPI("POST", "/api/peers/add", body, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name    string `json:"name"`
		Warning string `json:"warning"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s 에 등록을 요청했습니다. 상대가 승인하면 짝이 됩니다 (10분 안).\n", v.Name)
	if v.Warning == "port_closed" {
		fmt.Fprintln(stderr, "주의: 이 노드의 노드 포트가 닫혀 있어 상대가 이 노드로 보낼 수 없습니다. 승인 통지도 받지 못합니다.")
	}
	return 0
}

func peerApprove(pa peerArgs, stdout, stderr io.Writer) int {
	body := map[string]any{"id": pa.pos[0]}
	if n := pa.flags["name"]; n != "" {
		body["name"] = n
	}
	raw, rc := peerAPI("POST", "/api/peers/approve", body, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name      string `json:"name"`
		Confirmed bool   `json:"confirmed"`
		Reason    string `json:"reason"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s 를 짝으로 저장했습니다.\n", v.Name)
	if !v.Confirmed {
		fmt.Fprintf(stderr, "주의: 상대에게 승인을 알리지 못했습니다 (%s). 상대는 아직 이 노드를 짝으로 모릅니다.\n", v.Reason)
	}
	return 0
}

func peerReject(pa peerArgs, stdout, stderr io.Writer) int {
	if _, rc := peerAPI("POST", "/api/peers/reject", map[string]any{"id": pa.pos[0]}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintln(stdout, "거절했습니다.")
	return 0
}

func peerRemove(pa peerArgs, stdout, stderr io.Writer) int {
	if _, rc := peerAPI("POST", "/api/peers/remove", map[string]any{"name": pa.pos[0]}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintf(stdout, "%s 와의 짝을 해제했습니다. 상대 쪽 기록은 상대가 따로 지웁니다.\n", pa.pos[0])
	return 0
}

// peerAPI 는 로컬 API 한 번이다. 거절이면 `{code,message}` 를 stderr 에 내고 1 이다
// (FR-PNW-74).
func peerAPI(method, path string, body map[string]any, stderr io.Writer) ([]byte, int) {
	var (
		status int
		raw    []byte
		err    error
	)
	if method == "GET" {
		status, raw, err = httpGet(baseURL() + path)
	} else {
		status, raw, err = httpPostJSON(baseURL()+path, body)
	}
	return apiResultWith(status, raw, err, stderr, printPeerRefusal)
}

func printPeerRefusal(w io.Writer, status int, raw []byte) {
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Code != "" {
		fmt.Fprintf(w, "dmctl: %s: %s\n", e.Code, e.Message)
		return
	}
	fmt.Fprintf(w, "dmctl: status %d: %s\n", status, raw)
}

// clean 은 상대 노드가 보낸 글자에서 제어 문자를 지운다 — 터미널에 찍히기 때문이다.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

// peerCall 은 짝에 프로토콜 명령 하나를 보낸다 (POST /api/peers/call).
func peerCall(node, op, from string, args map[string]any, stderr io.Writer) ([]byte, int) {
	body := map[string]any{"peer": node, "op": op, "args": args}
	if from != "" {
		body["from"] = from
	}
	return peerAPI("POST", "/api/peers/call", body, stderr)
}

func peerInfo(pa peerArgs, stdout, stderr io.Writer) int {
	raw, rc := peerCall(pa.pos[0], "node.info", "", nil, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name        string   `json:"name"`
		Version     string   `json:"version"`
		Proto       int      `json:"proto"`
		Commands    []string `json:"commands"`
		Agents      []string `json:"agents"`
		AllowedDirs []string `json:"allowedDirs"`
	}
	_ = json.Unmarshal(raw, &v)
	join := func(xs []string) string {
		out := make([]string, len(xs))
		for i, x := range xs {
			out[i] = clean(x)
		}
		return strings.Join(out, ",")
	}
	fmt.Fprintf(stdout, "name=%s  version=%s  proto=%d\ncommands=%s\nagents=%s\nallowedDirs=%s\n",
		clean(v.Name), clean(v.Version), v.Proto, join(v.Commands), join(v.Agents), join(v.AllowedDirs))
	return 0
}

func peerTools(pa peerArgs, stdout, stderr io.Writer) int {
	node := pa.pos[0]
	raw, rc := peerCall(node, "agents.list", "", nil, stderr)
	if rc != 0 {
		return rc
	}
	if pa.bools["json"] {
		var buf bytes.Buffer
		if json.Compact(&buf, raw) != nil {
			buf.Reset()
			buf.WriteString(clean(string(raw)))
		}
		fmt.Fprintln(stdout, buf.String())
		return 0
	}
	var v struct {
		Agents []struct {
			ToolID       string `json:"toolId"`
			Agent        string `json:"agent"`
			Window       string `json:"window"`
			Tab          string `json:"tab"`
			State        string `json:"state"`
			Cwd          string `json:"cwd"`
			SpawnedByYou bool   `json:"spawnedByYou"`
		} `json:"agents"`
	}
	_ = json.Unmarshal(raw, &v)
	for _, a := range v.Agents {
		mine := ""
		if a.SpawnedByYou {
			mine = "  spawnedByYou"
		}
		fmt.Fprintf(stdout, "%s/%s  agent=%s  state=%s  window=%q  tab=%q  cwd=%s%s\n",
			node, clean(a.ToolID), clean(a.Agent), clean(a.State), clean(a.Window), clean(a.Tab), clean(a.Cwd), mine)
	}
	if len(v.Agents) == 0 {
		fmt.Fprintf(stderr, "%s 에 에이전트 도구가 없습니다.\n", node)
	}
	return 0
}

// runDmctlMsgRemote 는 `--to <노드>/<uuid>` 의 갈래다 (FR-PNW-73). 보낸 도구는 서버가
// 지금 도구로 해석해 채운다 (FR-PNW-72).
func runDmctlMsgRemote(to, from, message string, stdout, stderr io.Writer) int {
	node, uuid, _ := strings.Cut(to, "/")
	if node == "" || uuid == "" {
		fmt.Fprintln(stderr, "usage: dmctl msg --to <노드>/<uuid> <메시지>")
		return 2
	}
	raw, rc := peerCall(node, "message.send", from, map[string]any{"to": uuid, "message": message}, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Len int `json:"len"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "원격 메시지 전송 완료: → %s/%s, 본문 %d 자\n", node, uuid, v.Len)
	return 0
}

// splitRemote 는 `<노드>/<uuid>` 를 가른다.
func splitRemote(s string, stderr io.Writer) (string, string, bool) {
	node, uuid, ok := strings.Cut(s, "/")
	if !ok || node == "" || uuid == "" {
		fmt.Fprintf(stderr, "dmctl peer: <노드>/<uuid> 모양이어야 합니다: %q\n", s)
		return "", "", false
	}
	return node, uuid, true
}

func peerSpawn(pa peerArgs, stdout, stderr io.Writer) int {
	agent, cwd := pa.flags["agent"], pa.flags["cwd"]
	if agent == "" || cwd == "" {
		fmt.Fprintln(stderr, "dmctl peer spawn: --agent 와 --cwd 가 필요합니다")
		return 2
	}
	args := map[string]any{"agent": agent, "cwd": cwd, "prompt": pa.pos[1], "placement": "window"}
	if pa.bools["tab"] {
		if pa.flags["at"] == "" {
			fmt.Fprintln(stderr, "dmctl peer spawn: --tab 에는 --at <uuid> 가 필요합니다")
			return 2
		}
		args["placement"] = "tab"
		args["at"] = pa.flags["at"]
	}
	if n := pa.flags["name"]; n != "" {
		args["name"] = n
	}
	node := pa.pos[0]
	raw, rc := peerCall(node, "agent.spawn", selfToolID(), args, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		ToolID   string `json:"toolId"`
		Headless bool   `json:"headless"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s/%s\n", node, clean(v.ToolID))
	if v.Headless {
		fmt.Fprintln(stderr, "상대 노드에 연결된 브라우저가 없어 헤드리스 도구로 띄웠습니다. 상대 화면의 백그라운드 목록에서 붙일 수 있습니다.")
	}
	return 0
}

func peerStatus(pa peerArgs, stdout, stderr io.Writer) int {
	node, uuid, ok := splitRemote(pa.pos[0], stderr)
	if !ok {
		return 2
	}
	raw, rc := peerCall(node, "agent.status", "", map[string]any{"toolId": uuid}, stderr)
	if rc != 0 {
		return rc
	}
	if pa.bools["json"] {
		var buf bytes.Buffer
		if json.Compact(&buf, raw) != nil {
			buf.Reset()
			buf.WriteString(clean(string(raw)))
		}
		fmt.Fprintln(stdout, buf.String())
		return 0
	}
	var v struct {
		State string `json:"state"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintln(stdout, clean(v.State))
	return 0
}

func peerClose(pa peerArgs, stdout, stderr io.Writer) int {
	node, uuid, ok := splitRemote(pa.pos[0], stderr)
	if !ok {
		return 2
	}
	if _, rc := peerCall(node, "agent.close", "", map[string]any{"toolId": uuid}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintf(stdout, "%s/%s 를 닫았습니다.\n", node, uuid)
	return 0
}
