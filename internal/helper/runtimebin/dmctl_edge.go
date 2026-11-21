package runtimebin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/termtext"
)

// PEER_NETWORK_SRS FR-PNW-73·74, PEER_DAEMON_SRS FR-PDM-70, EDGE_PAIRING_SRS FR-EPR-60 — 노드 간
// 통신의 dmctl 명령 (간선 맺기).

const dmctlEdgesHelp = `dmctl edges [--json]
  노드 포트 상태와 간선 목록(지문 앞자리·이름#번호·주소)을 보인다. 바뀐 내 정보를 아직 받지
  못한 간선은 "알림 대기", 간선 연결을 모르는 옛 판은 "옛 판" 을 줄 끝에 적는다.
`

const dmctlEdgeHelp = `dmctl edge — 노드 간 통신의 간선 맺기

  dmctl edge invite [--addr <주소>]   초대 코드를 만들어 출력한다 (10분, 한 번)
  dmctl edge add <코드>               초대 코드로 간선을 맺는다
  dmctl edge remove <이름#번호|지문 앞자리>
                                      간선을 끊는다. 상대 쪽에서도 지워진다
  dmctl edge notify <이름#번호|지문 앞자리>
                                      내 이름·노드 포트·알릴 주소를 그 간선에 지금 알린다

  이름#번호(예: 동민#0427)나 8자리 이상의 지문 앞자리로 가리킨다. 간선 하나에만 맞아야
  한다(dmctl edges 로 본다).

  상대에 닿지 못하면 사유 코드(edge_unreachable 등)를 내고 1 로 끝난다.
`

// edgeCallBudget 은 상대를 부르는 로컬 API(add·remove)의 예산이다. 서버의 원격
// 요청 시한(15초)보다 길어야 상대의 답을 받기 전에 끊지 않는다 (리뷰 C-1).
const edgeCallBudget = 20 * time.Second

func runDmctlEdges(args []string, stdout, stderr io.Writer) int {
	asJSON := false
	spec := argSpec{help: dmctlEdgesHelp, bools: map[string]*bool{"--json": &asJSON}}
	if code, proceed := spec.run("dmctl edges", args, stdout, stderr); !proceed {
		return code
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
		Tag         string `json:"tag"`
		Advertise   string `json:"advertise"`
		Fingerprint string `json:"fingerprint"`
		Listening   bool   `json:"listening"`
		Error       string `json:"error"`
	} `json:"node"`
	Edges []struct {
		Name     string `json:"name"`
		Tag      string `json:"tag"`
		Addr     string `json:"addr"`
		Port     int    `json:"port"`
		FP       string `json:"fp"`
		Pending  bool   `json:"pending"`
		Outdated bool   `json:"outdated"`
	} `json:"edges"`
	Invite *struct {
		Expires string `json:"expires"`
	} `json:"invite"`
}

// shortFP 는 화면에 보이는 지문이다 (FR-PNW-80).
func shortFP(fp string) string { return termtext.Cut(fp, termtext.FPShown) }

// handle 은 `이름#번호` 다. 번호가 없으면(구버전 서버) 이름만이다 (PROFILE_NAME_SRS FR-PFN-23).
func handle(name, tag string) string {
	if tag == "" {
		return name
	}
	return name + "#" + tag
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// hostPort 는 주소:포트다. 주소를 모르는 간선(상대의 노드 포트가 닫혀 있었음)은 `-` 다.
func hostPort(addr string, port int) string {
	if addr == "" {
		return "-"
	}
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
		clean(handle(n.Name, n.Tag)), yesNo(n.Enabled), clean(n.Bind), n.Port, yesNo(n.Listening), clean(shortFP(n.Fingerprint)))
	if n.Advertise != "" {
		fmt.Fprintf(w, "  advertise=%s", clean(n.Advertise))
	}
	fmt.Fprintln(w)
	if n.Error != "" {
		fmt.Fprintf(w, "         port error: %s\n", clean(n.Error))
	}
	for _, p := range v.Edges {
		fmt.Fprintf(w, "edge     fp=%s  name=%s  addr=%s", clean(shortFP(p.FP)), clean(handle(p.Name, p.Tag)), clean(hostPort(p.Addr, p.Port)))
		// EDGE_MESH_SRS FR-EGM-63
		if p.Pending {
			fmt.Fprint(w, "  알림 대기")
		}
		if p.Outdated {
			fmt.Fprint(w, "  옛 판")
		}
		fmt.Fprintln(w)
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
			return out, errors.New(unknownArg(a))
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
	"invite": {0, false, []string{"addr"}, nil, edgeInvite},
	"add":    {1, false, nil, nil, edgeAdd},
	"remove": {1, false, nil, nil, edgeRemove},
	"notify": {1, false, nil, nil, edgeNotify},
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
	raw, rc := edgeAPI("POST", "/api/edges/add", map[string]any{"code": pa.pos[0]}, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name string `json:"name"`
		FP   string `json:"fp"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s(%s)와 간선을 맺었습니다.\n", clean(v.Name), clean(shortFP(v.FP)))
	return 0
}

func edgeRemove(pa subArgs, stdout, stderr io.Writer) int {
	raw, rc := edgeAPI("POST", "/api/edges/remove", map[string]any{"fp": pa.pos[0]}, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name     string `json:"name"`
		FP       string `json:"fp"`
		Notified bool   `json:"notified"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "%s(%s) 간선을 끊었습니다.\n", clean(v.Name), clean(shortFP(v.FP)))
	if !v.Notified {
		fmt.Fprintln(stderr, "상대에게 알리지 못했습니다. 다시 이어지면 상대 쪽에서도 지워집니다.")
	}
	return 0
}

// edgeNotify 는 간선 하나에 내 직접 정보를 지금 알린다 (EDGE_MESH_SRS FR-EGM-62).
func edgeNotify(pa subArgs, stdout, stderr io.Writer) int {
	raw, rc := edgeAPI("POST", "/api/edges/notify", map[string]any{"fp": pa.pos[0]}, stderr)
	if rc != 0 {
		return rc
	}
	var v struct {
		Name string `json:"name"`
		Tag  string `json:"tag"`
	}
	_ = json.Unmarshal(raw, &v)
	fmt.Fprintf(stdout, "알렸습니다: %s\n", clean(handle(v.Name, v.Tag)))
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
	raw, code, _ := httpExit(status, raw, err, stderr, codeRule())
	return raw, code
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
func clean(s string) string { return termtext.Strip(s) }
