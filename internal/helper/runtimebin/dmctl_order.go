package runtimebin

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// ISSUE_AGENT_TREE_SRS 묶음 G·O — window 그룹과 순서 명령.
//
// 대상 uuid 는 `location` 이 아니라 자기 이름의 키(`window`·`group`·`tab`)로 싣는다.
// 서버는 `location` 을 탭 좌표로 번역하는데, window·그룹 uuid 는 탭이 아니다.

const dmctlOrderHelp = `dmctl — window 그룹과 순서 (ISSUE_AGENT_TREE_SRS)

그룹:
  dmctl new-group --name <이름> [--tree <owner/repo#N>]   # 빈 그룹을 만들고 uuid 를 낸다
  dmctl rename-group --at <그룹> <이름>
  dmctl delete-group --at <그룹>                          # window 는 닫지 않고 풀어 둔다
  dmctl list-groups [--json]                              # 빈 그룹까지 (index 0 = 빈 그룹)

순서 — 위치 지정은 정확히 하나:
  --index N            담는 곳 안의 자리 (1부터). 범위 밖은 오류
  --prev / --next      한 칸. 끝에서는 오류
  --before <uuid> / --after <uuid>   기준의 바로 앞·뒤. 기준이 다른 담는 곳이면 그리로 간다

  dmctl move-tab    --at <탭>    <위치> [--to <칸|window>]
  dmctl move-window --at <window> <위치> [--to <그룹> | --ungroup]
  dmctl move-group  --at <그룹>  <위치>
  --to 는 담는 곳을 바꾼다. 위치 없이 쓰면 그 끝이고 --index 와 함께 쓸 수 있다.

만들 때 자리 지정:
  dmctl new-window --group <그룹>          # 그 그룹의 끝
  dmctl new-tab --after <탭> | --index N   # 그 칸 안의 자리

결과의 position 은 {container, index, count} 다. 실패하면 error 를 적고 exit 1.
uuid 만 받는다 — 좌표·라벨(W1.P1.T1)은 거부한다.
`

// coordLike 는 좌표·라벨의 모양이다 (_parseLocation 과 같은 모양). uuid 자리에 오면 거부한다.
var coordLike = regexp.MustCompile(`^[Ww]?\d+(?:[.\s]+[Pp]?\d+)?(?:[.\s]+[Tt]?\d+)?$`)

var errNotUUID = errors.New("uuid 만 받는다 — 좌표·라벨은 거부한다 (list-workspace 의 uuid 컬럼 값을 쓴다)")

func setUUID(dst *string) func(string) error {
	return func(v string) error {
		if v == "" || coordLike.MatchString(v) {
			return errNotUUID
		}
		*dst = v
		return nil
	}
}

func setPositiveInt(dst **int) func(string) error {
	return func(v string) error {
		n, err := strconv.Atoi(v)
		if err != nil {
			return fmt.Errorf("--index 는 정수다: %s", v)
		}
		*dst = &n
		return nil
	}
}

type orderFlags struct {
	at, before, after, to string
	index                 *int
	prev, next, ungroup   bool
}

func (f orderFlags) positionCount() int {
	n := 0
	if f.index != nil {
		n++
	}
	if f.prev {
		n++
	}
	if f.next {
		n++
	}
	if f.before != "" {
		n++
	}
	if f.after != "" {
		n++
	}
	return n
}

// spec 은 FR-ORD-1·5 의 위치 지정을 확인하고 원격 인자로 옮긴다.
// allowTo 는 `--to`·`--ungroup` 을 받는 명령인지다.
func (f orderFlags) spec(allowTo bool) (map[string]any, error) {
	if f.at == "" {
		return nil, errors.New("--at <uuid> 가 필요하다")
	}
	n := f.positionCount()
	hasTo := f.to != "" || f.ungroup
	if !allowTo && hasTo {
		return nil, errors.New("이 명령은 --to·--ungroup 을 받지 않는다")
	}
	if f.to != "" && f.ungroup {
		return nil, errors.New("--to 와 --ungroup 은 함께 쓸 수 없다")
	}
	if hasTo {
		if n > 1 || f.prev || f.next || f.before != "" || f.after != "" {
			return nil, errors.New("--to 와 함께 쓰는 위치는 --index 하나뿐이다")
		}
	} else if n != 1 {
		return nil, errors.New("위치 지정이 정확히 하나 필요하다: --index · --prev · --next · --before · --after")
	}
	args := map[string]any{}
	if f.index != nil {
		args["index"] = *f.index
	}
	if f.prev {
		args["prev"] = true
	}
	if f.next {
		args["next"] = true
	}
	if f.before != "" {
		args["before"] = f.before
	}
	if f.after != "" {
		args["after"] = f.after
	}
	if f.to != "" {
		args["to"] = f.to
	}
	if f.ungroup {
		args["to"] = windowContainerTop
	}
	return args, nil
}

func runDmctlMove(cmd string, args []string, stdout, stderr io.Writer) int {
	var f orderFlags
	spec := argSpec{
		help: dmctlOrderHelp,
		vals: map[string]func(string) error{
			"--at": setUUID(&f.at), "-l": setUUID(&f.at),
			"--before": setUUID(&f.before), "--after": setUUID(&f.after),
			"--to": setUUID(&f.to), "--index": setPositiveInt(&f.index),
		},
		bools: map[string]*bool{"--prev": &f.prev, "--next": &f.next, "--ungroup": &f.ungroup},
	}
	if code, proceed := spec.run(cmd, args, stdout, stderr); !proceed {
		return code
	}
	action, key, allowTo := "moveTab", "tab", true
	switch cmd {
	case "move-window":
		action, key = "moveWindow", "window"
	case "move-group":
		action, key, allowTo = "moveGroup", "group", false
	}
	if cmd == "move-tab" && f.ungroup {
		fmt.Fprintf(stderr, "%s: --ungroup 은 move-window 의 것이다\n", cmd)
		return 2
	}
	payload, err := f.spec(allowTo)
	if err != nil {
		fmt.Fprintf(stderr, "%s: %v\n", cmd, err)
		return 2
	}
	payload[key] = f.at
	return dmctlPostResult(action, payload, stdout, stderr)
}

// dmctlPostResult 는 결과를 돌려받는 명령의 전송이다 — 회신의 `error` 를 exit 1 로 옮긴다 (FR-ORD-6).
func dmctlPostResult(action string, args map[string]any, stdout, stderr io.Writer) int {
	var resp []byte
	code := dmctlPostRawCapture(action, args, stdout, stderr, &resp)
	if code != 0 {
		return code
	}
	var got struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(resp, &got) == nil && got.Error != "" {
		fmt.Fprintf(stderr, "dmctl: %s 실패: %s\n", action, got.Error)
		return 1
	}
	return 0
}

var repoIssueRef = regexp.MustCompile(`^([\w.-]+/[\w.-]+)#(\d+)$`)

func runDmctlGroup(cmd string, args []string, stdout, stderr io.Writer) int {
	var at, name, tree string
	var positional []string
	spec := argSpec{
		help: dmctlOrderHelp,
		vals: map[string]func(string) error{
			"--at": setUUID(&at), "-l": setUUID(&at),
			"--name": setStr(&name), "--tree": setStr(&tree),
		},
		rest: &positional,
	}
	if code, proceed := spec.run(cmd, args, stdout, stderr); !proceed {
		return code
	}
	if name == "" && len(positional) > 0 {
		name = strings.Join(positional, " ")
	}
	switch cmd {
	case "new-group":
		if strings.TrimSpace(name) == "" {
			fmt.Fprintln(stderr, "usage: dmctl new-group --name <이름> [--tree <owner/repo#N>]")
			return 2
		}
		payload := map[string]any{"name": name}
		if tree != "" {
			m := repoIssueRef.FindStringSubmatch(tree)
			if m == nil {
				fmt.Fprintf(stderr, "new-group: --tree 는 owner/repo#N 꼴이다: %s\n", tree)
				return 2
			}
			root, _ := strconv.Atoi(m[2])
			payload["tree"] = map[string]any{"repo": m[1], "root": root}
		}
		return dmctlPostResult("newGroup", payload, stdout, stderr)
	case "rename-group":
		if at == "" || strings.TrimSpace(name) == "" {
			fmt.Fprintln(stderr, "usage: dmctl rename-group --at <그룹 uuid> <이름>")
			return 2
		}
		return dmctlPost("renameGroup", map[string]any{"group": at, "name": name}, stdout, stderr)
	default: // delete-group
		if at == "" {
			fmt.Fprintln(stderr, "usage: dmctl delete-group --at <그룹 uuid>")
			return 2
		}
		return dmctlPost("deleteGroup", map[string]any{"group": at}, stdout, stderr)
	}
}

func runDmctlListGroups(args []string, stdout, stderr io.Writer) int {
	var jsonOut bool
	spec := argSpec{help: dmctlOrderHelp, bools: map[string]*bool{"--json": &jsonOut}}
	if code, proceed := spec.run("list-groups", args, stdout, stderr); !proceed {
		return code
	}
	ws, code := fetchWorkspaceTree(stderr)
	if code != 0 {
		return code
	}
	rows := buildGroupRows(ws)
	if jsonOut {
		if rows == nil {
			rows = []groupRow{}
		}
		_ = json.NewEncoder(stdout).Encode(rows)
		return 0
	}
	if len(rows) == 0 {
		fmt.Fprintln(stdout, "(no groups)")
		return 0
	}
	for _, r := range rows {
		line := fmt.Sprintf("uuid=%s  name=%q  index=%d  windows=%d", r.UUID, r.Name, r.Index, r.Windows)
		if r.Tree != nil {
			line += fmt.Sprintf("  tree=%s#%d", r.Tree.Repo, r.Tree.Root)
		}
		fmt.Fprintln(stdout, line)
	}
	return 0
}
