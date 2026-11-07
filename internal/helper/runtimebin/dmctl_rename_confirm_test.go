package runtimebin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TAB_NAME_DELIVERY_SRS 묶음 C: rename 은 반영을 확인하고, 반영되지 않으면 다시 보낸다.

const renameTestTab = "550e8400-e29b-41d4-a716-4466554400c1"

// withFastRenameConfirm 은 확인 창·간격을 시험 시간에 맞게 줄인다.
func withFastRenameConfirm(t *testing.T) {
	t.Helper()
	w, i := renameConfirmWindow, renameConfirmInterval
	renameConfirmWindow, renameConfirmInterval = 60*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { renameConfirmWindow, renameConfirmInterval = w, i })
}

// renameStateJSON 은 탭 하나가 든 창 하나의 `/api/state` 본문이다.
func renameStateJSON(winName, tabID, tabName, nameSource string) string {
	tab := map[string]any{"id": tabID, "name": tabName, "toolId": "t1", "type": "terminal"}
	if nameSource != "" {
		tab["nameSource"] = nameSource
	}
	ws := map[string]any{"windows": []any{map[string]any{
		"id": "w1", "name": winName,
		"layout": map[string]any{"type": "pane", "id": "p1", "tabs": []any{tab}},
	}}}
	b, _ := json.Marshal(map[string]any{"workspace": ws})
	return string(b)
}

// renameFake 는 POST 횟수를 세고, GET /api/state 에는 state(전송 횟수)를 답한다.
type renameFake struct {
	posts     atomic.Int32
	state     func(posts int32) string
	postReply func(posts int32) string
}

func (f *renameFake) handler(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && r.URL.Path == "/api/commands" {
		n := f.posts.Add(1)
		reply := `{"ok":true,"action":"renameTab","delivered":4}`
		if f.postReply != nil {
			reply = f.postReply(n)
		}
		w.Write([]byte(reply))
		return
	}
	if r.Method == http.MethodGet && r.URL.Path == "/api/state" {
		w.Write([]byte(f.state(f.posts.Load())))
		return
	}
	http.NotFound(w, r)
}

func runRename(t *testing.T, f *renameFake, args ...string) (rc int, stdout, stderr string) {
	t.Helper()
	withFastRenameConfirm(t)
	cleanup := withDmctlServer(t, f.handler)
	defer cleanup()
	var out, errb bytes.Buffer
	rc = runDmctl(args, &out, &errb)
	return rc, out.String(), errb.String()
}

// V-TND-4: 첫 확인에서 반영되면 한 번만 보낸다.
func TestRenameConfirm_AppliedFirstTime(t *testing.T) {
	f := &renameFake{state: func(int32) string {
		return renameStateJSON("W", renameTestTab, "ccr#32›91 층", "manual")
	}}
	rc, _, stderr := runRename(t, f, "rename-tab", "--at", renameTestTab, "ccr#32›91 층")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr)
	}
	if n := f.posts.Load(); n != 1 {
		t.Fatalf("전송 %d회, 1회여야 한다", n)
	}
}

// V-TND-5: 첫 전송이 사라지면 다시 보낸다. stdout 에는 응답 하나만 남는다.
func TestRenameConfirm_ResendsWhenLost(t *testing.T) {
	f := &renameFake{state: func(posts int32) string {
		if posts < 2 {
			return renameStateJSON("W", renameTestTab, "Shell", "")
		}
		return renameStateJSON("W", renameTestTab, "ccr#32›91 층", "manual")
	}}
	rc, stdout, stderr := runRename(t, f, "rename-tab", "--at", renameTestTab, "ccr#32›91 층")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr)
	}
	if n := f.posts.Load(); n != 2 {
		t.Fatalf("전송 %d회, 2회여야 한다", n)
	}
	if c := strings.Count(stdout, `"action"`); c != 1 {
		t.Fatalf("stdout 에 응답이 %d개다, 1개여야 한다: %q", c, stdout)
	}
}

// V-TND-6: 끝내 반영되지 않으면 상한까지 보내고 exit 1.
func TestRenameConfirm_GivesUpAfterLimit(t *testing.T) {
	f := &renameFake{state: func(int32) string {
		return renameStateJSON("W", renameTestTab, "Shell", "")
	}}
	rc, _, stderr := runRename(t, f, "rename-tab", "--at", renameTestTab, "ccr#32›91 층")
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if n := f.posts.Load(); n != int32(renameMaxSends) {
		t.Fatalf("전송 %d회, %d회여야 한다", n, renameMaxSends)
	}
	if !strings.Contains(stderr, renameTestTab) || !strings.Contains(stderr, "ccr#32›91 층") {
		t.Fatalf("stderr 에 uuid 와 이름이 없다: %q", stderr)
	}
}

// 이름은 같아도 출처가 manual 이 아니면 반영이 아니다 (FR-TND-11).
func TestRenameConfirm_RequiresManualSource(t *testing.T) {
	f := &renameFake{state: func(int32) string {
		return renameStateJSON("W", renameTestTab, "Shell", "")
	}}
	rc, _, _ := runRename(t, f, "rename-tab", "--at", renameTestTab, "Shell")
	if rc != 1 {
		t.Fatalf("rc=%d want 1 (auto 인 Shell 은 manual 이름 Shell 이 아니다)", rc)
	}
}

// V-TND-7: workspace 를 모르면 판정하지 않는다.
func TestRenameConfirm_UnknownWorkspaceSkips(t *testing.T) {
	f := &renameFake{state: func(int32) string { return `{"ok":true}` }}
	rc, _, stderr := runRename(t, f, "rename-tab", "--at", renameTestTab, "x")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr)
	}
	if n := f.posts.Load(); n != 1 {
		t.Fatalf("전송 %d회, 1회여야 한다", n)
	}
}

// V-TND-8: --auto 의 반영 조건.
func TestRenameConfirm_Auto(t *testing.T) {
	f := &renameFake{state: func(posts int32) string {
		if posts < 2 {
			return renameStateJSON("W", renameTestTab, "역할", "manual")
		}
		return renameStateJSON("W", renameTestTab, "Shell", "")
	}}
	rc, _, stderr := runRename(t, f, "rename-tab", "--at", renameTestTab, "--auto")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr)
	}
	if n := f.posts.Load(); n != 2 {
		t.Fatalf("전송 %d회, 2회여야 한다", n)
	}
}

// V-TND-8: rename-window 는 --at 탭이 든 창의 이름을 본다.
func TestRenameConfirm_Window(t *testing.T) {
	f := &renameFake{state: func(posts int32) string {
		if posts < 2 {
			return renameStateJSON("옛 창", renameTestTab, "Shell", "")
		}
		return renameStateJSON("ccr#32", renameTestTab, "Shell", "")
	}}
	rc, _, stderr := runRename(t, f, "rename-window", "--at", renameTestTab, "ccr#32")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, stderr)
	}
	if n := f.posts.Load(); n != 2 {
		t.Fatalf("전송 %d회, 2회여야 한다", n)
	}
}

// V-TND-9: 워크스페이스에 그 탭이 없으면 반영되지 않은 것이다.
func TestRenameConfirm_MissingTabIsNotApplied(t *testing.T) {
	f := &renameFake{state: func(int32) string {
		return renameStateJSON("W", "other-tab", "ccr#32›91 층", "manual")
	}}
	rc, _, _ := runRename(t, f, "rename-tab", "--at", renameTestTab, "ccr#32›91 층")
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if n := f.posts.Load(); n != int32(renameMaxSends) {
		t.Fatalf("전송 %d회, %d회여야 한다", n, renameMaxSends)
	}
}

// V-TND-10: 재전송이 배달되지 않으면 그 코드로 끝나고 더 보내지 않는다.
func TestRenameConfirm_ResendDeliveryFailureStops(t *testing.T) {
	f := &renameFake{
		state: func(int32) string { return renameStateJSON("W", renameTestTab, "Shell", "") },
		postReply: func(n int32) string {
			if n >= 2 {
				return `{"ok":true,"action":"renameTab","delivered":0}`
			}
			return `{"ok":true,"action":"renameTab","delivered":4}`
		},
	}
	rc, _, _ := runRename(t, f, "rename-tab", "--at", renameTestTab, "ccr#32›91 층")
	if rc != 1 {
		t.Fatalf("rc=%d want 1", rc)
	}
	if n := f.posts.Load(); n != 2 {
		t.Fatalf("전송 %d회, 2회여야 한다", n)
	}
}
