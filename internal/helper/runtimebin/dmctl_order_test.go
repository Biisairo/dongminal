package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// ISSUE_AGENT_TREE_SRS 묶음 G·O — dmctl 그룹·순서 명령 (TC-WGR-4 · TC-ORD-2~4 의 CLI 쪽).

const (
	uW1 = "01a1a425-9038-7000-9e50-7d21894145a9"
	uW2 = "01a1a425-9038-7000-9e50-7d21894145aa"
	uG1 = "01a1a425-9038-7000-9e50-7d21894145ab"
)

type postedCmd struct {
	Action string         `json:"action"`
	Args   map[string]any `json:"args"`
}

func runOrder(t *testing.T, reply string, argv ...string) (postedCmd, int, string, string) {
	t.Helper()
	var got postedCmd
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		json.Unmarshal(body, &got)
		w.Write([]byte(reply))
	})
	defer cleanup()
	var stdout, stderr bytes.Buffer
	rc := runDmctl(argv, &stdout, &stderr)
	return got, rc, stdout.String(), stderr.String()
}

const okMove = `{"ok":true,"delivered":1,"timedOut":false,"position":{"container":"top","index":2,"count":3}}`

func TestDmctlMoveWindow_Index(t *testing.T) {
	got, rc, out, errs := runOrder(t, okMove, "move-window", "--at", uW1, "--index", "2")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errs)
	}
	if got.Action != "moveWindow" || got.Args["window"] != uW1 || got.Args["index"] != float64(2) {
		t.Fatalf("posted=%+v", got)
	}
	if _, ok := got.Args["location"]; ok {
		t.Errorf("window uuid 를 location 으로 실으면 서버가 탭 좌표로 번역하려 든다: %+v", got.Args)
	}
	if !strings.Contains(out, `"position"`) {
		t.Errorf("최종 위치가 출력되지 않았다: %s", out)
	}
}

func TestDmctlMove_PositionSpecExactlyOne(t *testing.T) {
	for _, argv := range [][]string{
		{"move-window", "--at", uW1},
		{"move-window", "--at", uW1, "--index", "1", "--next"},
		{"move-window", "--at", uW1, "--to", uG1, "--prev"},
		{"move-window", "--at", uW1, "--ungroup", "--to", uG1},
		{"move-group", "--at", uG1, "--to", uG1, "--index", "1"},
		{"move-tab", "--at", uW1, "--before", uW2, "--after", uW2},
		{"move-window", "--index", "1"},
		{"move-window", "--at", uW1, "--index", "x"},
	} {
		_, rc, _, _ := runOrder(t, okMove, argv...)
		if rc != 2 {
			t.Errorf("%v: rc=%d, 2 를 기대", argv, rc)
		}
	}
}

func TestDmctlMove_RejectsLabels(t *testing.T) {
	for _, argv := range [][]string{
		{"move-window", "--at", "W1", "--index", "1"},
		{"move-tab", "--at", uW1, "--after", "W1.P1.T2"},
		{"move-window", "--at", uW1, "--to", "4.1"},
	} {
		_, rc, _, errs := runOrder(t, okMove, argv...)
		if rc != 2 {
			t.Errorf("%v: rc=%d (stderr=%s), 좌표·라벨은 거부해야 한다 (FR-WGR-35)", argv, rc, errs)
		}
	}
}

func TestDmctlMoveWindow_UngroupAndTo(t *testing.T) {
	got, rc, _, errs := runOrder(t, okMove, "move-window", "--at", uW1, "--ungroup")
	if rc != 0 || got.Args["to"] != "top" {
		t.Fatalf("rc=%d args=%+v stderr=%s", rc, got.Args, errs)
	}
	got, _, _, _ = runOrder(t, okMove, "move-window", "--at", uW1, "--to", uG1, "--index", "1")
	if got.Args["to"] != uG1 || got.Args["index"] != float64(1) {
		t.Fatalf("args=%+v", got.Args)
	}
}

func TestDmctlMove_ErrorReplyExits1(t *testing.T) {
	_, rc, _, errs := runOrder(t, `{"ok":true,"delivered":1,"timedOut":false,"error":"out_of_range"}`,
		"move-tab", "--at", uW1, "--index", "9")
	if rc != 1 || !strings.Contains(errs, "out_of_range") {
		t.Fatalf("rc=%d stderr=%s", rc, errs)
	}
}

func TestDmctlMoveTab_Args(t *testing.T) {
	got, _, _, _ := runOrder(t, okMove, "move-tab", "--at", uW1, "--after", uW2)
	if got.Action != "moveTab" || got.Args["tab"] != uW1 || got.Args["after"] != uW2 {
		t.Fatalf("posted=%+v", got)
	}
	got, _, _, _ = runOrder(t, okMove, "move-tab", "--at", uW1, "--to", uW2)
	if got.Args["to"] != uW2 {
		t.Fatalf("posted=%+v", got)
	}
	got, _, _, _ = runOrder(t, okMove, "move-tab", "--at", uW1, "--prev")
	if got.Args["prev"] != true {
		t.Fatalf("posted=%+v", got)
	}
}

func TestDmctlMoveGroup_Args(t *testing.T) {
	got, rc, _, _ := runOrder(t, okMove, "move-group", "--at", uG1, "--before", uW1)
	if rc != 0 || got.Action != "moveGroup" || got.Args["group"] != uG1 || got.Args["before"] != uW1 {
		t.Fatalf("rc=%d posted=%+v", rc, got)
	}
}

func TestDmctlGroupCommands(t *testing.T) {
	got, rc, out, errs := runOrder(t, `{"ok":true,"delivered":1,"timedOut":false,"newGroups":["`+uG1+`"]}`,
		"new-group", "--name", "ccr#32 Rust 포팅", "--tree", "hancomins/common-chart-renderer-ts#32")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errs)
	}
	tree, _ := got.Args["tree"].(map[string]any)
	if got.Action != "newGroup" || got.Args["name"] != "ccr#32 Rust 포팅" || tree["repo"] != "hancomins/common-chart-renderer-ts" || tree["root"] != float64(32) {
		t.Fatalf("posted=%+v", got)
	}
	if !strings.Contains(out, uG1) {
		t.Errorf("새 그룹 uuid 가 출력되지 않았다: %s", out)
	}
	if _, rc, _, _ := runOrder(t, `{}`, "new-group"); rc != 2 {
		t.Errorf("이름 없는 new-group rc=%d", rc)
	}
	if _, rc, _, _ := runOrder(t, `{}`, "new-group", "--name", "G", "--tree", "repo-without-number"); rc != 2 {
		t.Errorf("잘못된 --tree rc=%d", rc)
	}
	got, rc, _, _ = runOrder(t, `{"ok":true,"delivered":1}`, "rename-group", "--at", uG1, "새 이름")
	if rc != 0 || got.Action != "renameGroup" || got.Args["group"] != uG1 || got.Args["name"] != "새 이름" {
		t.Fatalf("rc=%d posted=%+v", rc, got)
	}
	got, rc, _, _ = runOrder(t, `{"ok":true,"delivered":1}`, "delete-group", "--at", uG1)
	if rc != 0 || got.Action != "deleteGroup" || got.Args["group"] != uG1 {
		t.Fatalf("rc=%d posted=%+v", rc, got)
	}
}

func TestDmctlCreateWithPosition(t *testing.T) {
	reply := `{"ok":true,"delivered":1,"timedOut":false}`
	got, rc, _, errs := runOrder(t, reply, "new-window", "-n", "--group", uG1)
	if rc != 0 || got.Action != "newWindow" || got.Args["group"] != uG1 {
		t.Fatalf("rc=%d posted=%+v stderr=%s", rc, got, errs)
	}
	got, _, _, _ = runOrder(t, reply, "new-tab", "--at", uW1, "--after", uW2)
	if got.Args["after"] != uW2 {
		t.Fatalf("posted=%+v", got)
	}
	got, _, _, _ = runOrder(t, reply, "new-tab", "--index", "1")
	if got.Args["index"] != float64(1) {
		t.Fatalf("posted=%+v", got)
	}
}

// FR-ORD-30·31 · FR-WGR-34: 행 배열을 유지하고 순서 필드를 더한다.
func TestListWorkspaceRows_OrderFields(t *testing.T) {
	pane := func(id string, tabs ...string) *wsLayout {
		l := &wsLayout{Type: "pane", ID: id}
		for _, tb := range tabs {
			l.Tabs = append(l.Tabs, wsTab{ID: tb, Name: tb})
		}
		return l
	}
	ws := &wsTree{
		WindowGroups: []wsGroup{{ID: "g", Name: "G"}},
		Windows: []wsWindow{
			{ID: "a", Name: "A", Layout: pane("pa", "t1", "t2")},
			{ID: "b", Name: "B", GroupID: "g", Layout: pane("pb", "t3")},
			{ID: "c", Name: "C", GroupID: "g", Layout: pane("pc", "t4")},
			{ID: "git", Name: "Git", Type: "git", Layout: pane("pg", "t5")},
		},
	}
	rows := buildListWorkspaceRows(ws, nil, nil, nil, func() bool { return false })
	by := map[string]listWorkspaceRow{}
	for _, r := range rows {
		by[r.UUID] = r
	}
	if r := by["t2"]; r.WindowContainer != "top" || r.WindowIndex != 1 || r.WindowCount != 2 || r.TabIndex != 2 || r.TabCount != 2 || r.GroupUUID != "" {
		t.Errorf("t2=%+v", r)
	}
	if r := by["t4"]; r.WindowContainer != "g" || r.WindowIndex != 2 || r.WindowCount != 2 || r.GroupUUID != "g" || r.Group != "G" {
		t.Errorf("t4=%+v", r)
	}
	line := listWorkspaceLine(by["t4"]).Render()
	for _, want := range []string{`group="G"`, "win_pos=2/2", "tab_pos=1/1"} {
		if !strings.Contains(line, want) {
			t.Errorf("글자 출력에 %s 가 없다: %s", want, line)
		}
	}
	if r := by["t5"]; r.WindowContainer != "" || r.WindowIndex != 0 {
		t.Errorf("git 창은 그룹·순서 목록 밖이다: %+v", r)
	}
}

func TestListGroupsRows(t *testing.T) {
	ws := &wsTree{
		WindowGroups: []wsGroup{{ID: "empty", Name: "E"}, {ID: "g", Name: "G", Tree: &wsGroupTree{Repo: "o/r", Root: 3}}},
		Windows: []wsWindow{
			{ID: "a", Name: "A"},
			{ID: "b", GroupID: "g"},
			{ID: "c", GroupID: "g"},
		},
	}
	rows := buildGroupRows(ws)
	if len(rows) != 2 || rows[0].UUID != "g" || rows[0].Index != 2 || rows[0].Windows != 2 || rows[0].Tree == nil {
		t.Fatalf("rows=%+v", rows)
	}
	if rows[1].UUID != "empty" || rows[1].Index != 0 || rows[1].Windows != 0 {
		t.Fatalf("빈 그룹은 끝, 자리 0: %+v", rows[1])
	}
}
