package runtimebin

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// PEER_NETWORK_SRS FR-PNW-73·74, PEER_DAEMON_SRS FR-PDM-70 — 노드 간 통신의 dmctl 명령 (간선 맺기).

const dmctlEdgesHelp = `dmctl edges [--json]
  노드 포트 상태, 간선 목록(이름·주소·상태), 승인 대기를 보인다.
`

const dmctlEdgeHelp = `dmctl edge — 노드 간 통신의 간선 맺기

  dmctl edge invite [--addr <주소>]           초대 코드를 만들어 출력한다 (10분, 한 번)
  dmctl edge add <코드> [--name <이름>]       초대 코드로 등록을 요청한다
  dmctl edge approve <요청 id> [--name <이름>]  승인 대기를 간선으로 저장한다
  dmctl edge reject <요청 id>                승인 대기를 거절한다
  dmctl edge remove <노드>                   간선을 끊는다

  상대에 닿지 못하면 사유 코드(edge_unreachable 등)를 내고 1 로 끝난다.
`

// edgeCallBudget 은 상대를 부르는 로컬 API(add·approve)의 예산이다. 서버의 원격
// 요청 시한(15초)보다 길어야 상대의 답을 받기 전에 끊지 않는다 (리뷰 C-1).
const edgeCallBudget = 20 * time.Second

// fpShown 은 화면에 보이는 지문 길이다 (FR-PNW-80).
const fpShown = 16

func runDmctlEdges(args []string, stdout, stderr io.Writer) int {
	asJSON := false
	for _, a := range args {
		switch a {
		case "-h", "--help":
			fmt.Fprint(stdout, dmctlEdgesHelp)
			return 0
		case "--json":
			asJSON = true
		default:
			fmt.Fprintf(stderr, "dmctl edges: 모르는 인자 %q\n", a)
			return 2
		}
	}
	raw, rc := edgeAPI("GET", "/api/edges", nil, stderr)
	if rc != 0 {
		return rc
	}
	if asJSON {
		printEdgeJSON(stdout, raw)
		return 0
	}
	printEdges(stdout, raw)
	return 0
}

type edgesOut struct {
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
	Edges []struct {
		Name  string `json:"name"`
		Addr  string `json:"addr"`
		Port  int    `json:"port"`
		FP    string `json:"fp"`
		State string `json:"state"`
	} `json:"edges"`
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

func printEdges(w io.Writer, raw []byte) {
	var v edgesOut
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
	for _, p := range v.Edges {
		state := p.State
		if state == "" {
			state = "paired"
		}
		fmt.Fprintf(w, "edge     name=%s  addr=%s  state=%s  fp=%s\n", clean(p.Name), clean(hostPort(p.Addr, p.Port)), clean(state), clean(shortFP(p.FP)))
	}
	for _, p := range v.Pending {
		fmt.Fprintf(w, "pending  id=%s  name=%s  addr=%s  fp=%s  expires=%s\n",
			clean(p.ID), clean(p.Name), clean(hostPort(p.Addr, p.Port)), clean(shortFP(p.FP)), clean(p.Expires))
	}
	if v.Invite != nil {
		fmt.Fprintf(w, "invite   expires=%s\n", clean(v.Invite.Expires))
	}
}

// subArgs 는 위치 인자와 플래그들이다. 모르는 플래그·값이 빠진 플래그는 오류다.
type subArgs struct {
	pos   []string
	flags map[string]string
	bools map[string]bool
	help  bool
	// stdin 은 본문 "-" 가 읽는다 (dmctl account 의 하위 명령).
	stdin io.Reader
}

func parseSubArgs(args []string, allowed, bools []string) (subArgs, error) {
	out := subArgs{flags: map[string]string{}, bools: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "-h" || a == "--help" {
			out.help = true
			continue
		}
		if a == "--" {
			out.pos = append(out.pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "--") {
			out.pos = append(out.pos, a)
			continue
		}
		name, value, inline := strings.Cut(strings.TrimPrefix(a, "--"), "=")
		if slices.Contains(bools, name) && !inline {
			out.bools[name] = true
			continue
		}
		if !slices.Contains(allowed, name) {
			return out, fmt.Errorf("모르는 플래그 %s", a)
		}
		if !inline {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return out, fmt.Errorf("%s 에 값이 없습니다", a)
			}
			value = args[i+1]
			i++
		}
		out.flags[name] = value
	}
	return out, nil
}

func runDmctlEdge(args []string, stdout, stderr io.Writer) int {
	return runDmctlEdgeStdin(os.Stdin, args, stdout, stderr)
}

func runDmctlEdgeStdin(stdin io.Reader, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, dmctlEdgeHelp)
		return 2
	}
	sub, rest := args[0], args[1:]
	if sub == "-h" || sub == "--help" || sub == "help" {
		fmt.Fprint(stdout, dmctlEdgeHelp)
		return 0
	}
	spec, ok := edgeSubs[sub]
	if !ok {
		fmt.Fprintf(stderr, "dmctl edge: 모르는 하위 명령 %q\n", sub)
		fmt.Fprint(stderr, dmctlEdgeHelp)
		return 2
	}
	pa, err := parseSubArgs(rest, spec.flags, spec.bools)
	pa.stdin = stdin
	if pa.help {
		fmt.Fprint(stdout, dmctlEdgeHelp)
		return 0
	}
	switch {
	case err != nil:
	case spec.rest && len(pa.pos) < spec.positional:
		err = fmt.Errorf("인자가 %d 개 이상이어야 합니다", spec.positional)
	case !spec.rest && len(pa.pos) != spec.positional:
		err = fmt.Errorf("인자가 %d 개여야 합니다", spec.positional)
	}
	if err != nil {
		fmt.Fprintf(stderr, "dmctl edge %s: %v\n", sub, err)
		return 2
	}
	return spec.run(pa, stdout, stderr)
}

type subSpec struct {
	positional int
	// rest 면 positional 은 최소 개수다. 마지막 인자 뒤의 낱말은 본문으로 잇는다.
	rest  bool
	flags []string
	bools []string
	run   func(pa subArgs, stdout, stderr io.Writer) int
}

var edgeSubs = map[string]subSpec{
	"invite":  {0, false, []string{"addr"}, nil, edgeInvite},
	"add":     {1, false, []string{"name"}, nil, edgeAdd},
	"approve": {1, false, []string{"name"}, nil, edgeApprove},
	"reject":  {1, false, nil, nil, edgeReject},
	"remove":  {1, false, nil, nil, edgeRemove},
}

func edgeInvite(pa subArgs, stdout, stderr io.Writer) int {
	raw, rc := edgeAPI("POST", "/api/edges/invite", map[string]any{"addr": pa.flags["addr"]}, stderr)
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
	fmt.Fprintf(stderr, "초대 코드는 %s 까지 한 번 쓸 수 있습니다. 상대 노드에서 dmctl edge add <코드> 를 실행하세요.\n", clean(v.Expires))
	return 0
}

func edgeAdd(pa subArgs, stdout, stderr io.Writer) int {
	body := map[string]any{"code": pa.pos[0]}
	if n := pa.flags["name"]; n != "" {
		body["name"] = n
	}
	raw, rc := edgeAPI("POST", "/api/edges/add", body, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name    string `json:"name"`
		Warning string `json:"warning"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s 에 등록을 요청했습니다. 상대가 승인하면 간선이 맺어집니다 (10분 안).\n", clean(v.Name))
	if v.Warning == "port_closed" {
		fmt.Fprintln(stderr, "주의: 이 노드의 노드 포트가 닫혀 있어 상대가 이 노드로 보낼 수 없습니다. 승인 통지도 받지 못합니다.")
	}
	return 0
}

func edgeApprove(pa subArgs, stdout, stderr io.Writer) int {
	body := map[string]any{"id": pa.pos[0]}
	if n := pa.flags["name"]; n != "" {
		body["name"] = n
	}
	raw, rc := edgeAPI("POST", "/api/edges/approve", body, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name      string `json:"name"`
		FP        string `json:"fp"`
		Confirmed bool   `json:"confirmed"`
		Reason    string `json:"reason"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s 를 간선으로 저장했습니다. 지문 %s — 상대 노드의 지문과 같은지 확인하세요.\n", clean(v.Name), clean(shortFP(v.FP)))
	if !v.Confirmed {
		fmt.Fprintf(stderr, "주의: 상대에게 승인을 알리지 못했습니다 (%s). 상대는 아직 이 노드를 간선으로 모릅니다.\n", clean(v.Reason))
	}
	return 0
}

func edgeReject(pa subArgs, stdout, stderr io.Writer) int {
	if _, rc := edgeAPI("POST", "/api/edges/reject", map[string]any{"id": pa.pos[0]}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintln(stdout, "거절했습니다.")
	return 0
}

func edgeRemove(pa subArgs, stdout, stderr io.Writer) int {
	if _, rc := edgeAPI("POST", "/api/edges/remove", map[string]any{"name": pa.pos[0]}, stderr); rc != 0 {
		return rc
	}
	fmt.Fprintf(stdout, "%s 와의 간선을 끊었습니다. 상대 쪽 기록은 상대가 따로 지웁니다.\n", pa.pos[0])
	return 0
}

// edgeAPI 는 로컬 API 한 번이다. 거절이면 `{code,message}` 를 stderr 에 내고 1 이다
// (FR-PNW-74).
func edgeAPI(method, path string, body map[string]any, stderr io.Writer) ([]byte, int) {
	var (
		status int
		raw    []byte
		err    error
	)
	if method == "GET" {
		status, raw, err = httpGet(baseURL() + path)
	} else {
		status, raw, err = httpPostJSONWithin(baseURL()+path, body, edgeCallBudget)
	}
	return apiResultWith(status, raw, err, stderr, printRefusal)
}

func printRefusal(w io.Writer, status int, raw []byte) {
	var e struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil && e.Code != "" {
		fmt.Fprintf(w, "dmctl: %s: %s\n", clean(e.Code), clean(e.Message))
		return
	}
	fmt.Fprintf(w, "dmctl: status %d: %s\n", status, clean(string(raw)))
}

// printEdgeJSON 은 응답을 한 줄 JSON 으로 낸다. JSON 문자열은 C1 제어 문자(U+0080~009F)를
// 이스케이프 없이 담을 수 있으므로 여기서도 지운다 (리뷰 S-5). 구조는 바뀌지 않는다.
func printEdgeJSON(w io.Writer, raw []byte) {
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		buf.Reset()
		buf.Write(raw)
	}
	fmt.Fprintln(w, clean(buf.String()))
}

// clean 은 상대 노드가 보낸 글자에서 제어 문자를 지운다 — 터미널에 찍히기 때문이다.
//
// 서식 문자(Cf: bidi 재정렬·zero-width)도 지운다. 이 출력은 사람과 로컬 에이전트가 읽는다.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
}
