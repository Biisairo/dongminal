package gitapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/wsentry"

	"dongminal/internal/shared/testpath"
)

// Git 핀 ↔ Editor 행 연동의 서버측 (EDITOR_TAB_SRS §3.4, V-EDT-17·18·22·25·26).
// 핀의 기존 동작(멱등·문자열 일치 제거·2회 재시도·브로드캐스트)은 그대로다.

func editorsOf(t *testing.T, out map[string]any) []string {
	t.Helper()
	arr, ok := out["editors"].([]any)
	if !ok {
		t.Fatalf("응답에 editors 가 없다: %v", out)
	}
	list := make([]string, 0, len(arr))
	for _, v := range arr {
		s, _ := v.(string)
		list = append(list, s)
	}
	return list
}

// V-EDT-17·26 (FR-EDT-31·39): pin → 같은 경로 editor 행이 생기고 응답에 실린다.
func TestGitPin_CreatesEditorRow(t *testing.T) {
	t.Setenv(testpath.HomeEnv(), t.TempDir())
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+qWorkRepo+`}`)
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if eds := editorsOf(t, out); len(eds) != 1 || eds[0] != absWorkRepo {
		t.Fatalf("editors=%v", eds)
	}
	var doc map[string]any
	if err := json.Unmarshal(ws.raw, &doc); err != nil {
		t.Fatalf("workspace 파싱: %v (%s)", err, ws.raw)
	}
	e, _ := doc["editors"].(map[string]any)
	if list, _ := e["list"].([]any); len(list) != 1 || list[0] != absWorkRepo {
		t.Fatalf("editors.list=%v (%s)", e, ws.raw)
	}
}

// V-EDT-18·26 (FR-EDT-32·39): unpin → 같은 경로 editor 행이 사라진다.
func TestGitUnpin_RemovesEditorRow(t *testing.T) {
	t.Setenv(testpath.HomeEnv(), t.TempDir())
	g := newGitFake(t)
	s, _, ws, _ := gitTestServer(t, g)
	ws.raw = []byte(`{"schemaVersion":2,"git":{"pinned":[` + qWorkRepo + `]},"editors":{"list":[` + qWorkRepo + `,` + qOther + `]}}`)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":`+qWorkRepo+`}`)
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if pins, _ := out["pinned"].([]any); len(pins) != 0 {
		t.Fatalf("pinned=%v", out["pinned"])
	}
	eds := editorsOf(t, out)
	if len(eds) != 1 || eds[0] != absOther {
		t.Fatalf("editors=%v", eds)
	}
}

// V-EDT-22 (FR-EDT-35): 연동 변경이 rev 를 한 번만 올리고 브로드캐스트도 한 번이다.
func TestGitPin_LinkedChangeSavesOnce(t *testing.T) {
	t.Setenv(testpath.HomeEnv(), t.TempDir())
	g := newGitFake(t)
	s, _, ws, cb := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

	if code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+qWorkRepo+`}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if ws.saves != 1 {
		t.Fatalf("저장 %d회, want 1 — 두 목록이 따로 저장됐다", ws.saves)
	}
	cb.mu.Lock()
	defer cb.mu.Unlock()
	if len(cb.published) != 1 {
		t.Fatalf("브로드캐스트 %d건, want 1", len(cb.published))
	}
}

// V-EDT-25 (FR-EDT-37·38): 홈을 핀해도 editor 행이 생기지 않고, unpin 해도
// root 행의 근거(홈)는 목록 밖에 그대로 있다.
func TestGitPin_HomeMakesNoEditorRow(t *testing.T) {
	home := t.TempDir()
	t.Setenv(testpath.HomeEnv(), home)
	norm := wsentry.NormalizePath(home)

	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: norm + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+jsonQ(norm)+`}`)
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if eds := editorsOf(t, out); len(eds) != 0 {
		t.Fatalf("홈 핀이 editor 행을 만들었다: %v", eds)
	}
	code, out = gitReq(t, s, http.MethodPost, "/api/git/repos/unpin", `{"path":`+jsonQ(norm)+`}`)
	if code != 200 {
		t.Fatalf("unpin code=%d body=%v", code, out)
	}
	if eds := editorsOf(t, out); len(eds) != 0 {
		t.Fatalf("editors=%v", eds)
	}
}

// FR-EDT-24 (D-15): 핀도 Editor 추가와 **같은** 정규화 함수를 지난다. 그러지
// 않으면 macOS 의 /tmp → /private/tmp 에서 짝이 조용히 깨진다.
func TestGitPin_NormalizesRootLikeEditorAdd(t *testing.T) {
	t.Setenv(testpath.HomeEnv(), t.TempDir())
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("심볼릭 링크를 만들 수 없다: %v", err)
	}
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: link + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodPost, "/api/git/repos/pin", `{"path":`+jsonQ(link)+`}`)
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	want := wsentry.NormalizePath(real)
	if out["root"] != want {
		t.Fatalf("root=%v want=%v", out["root"], want)
	}
	if pins, _ := out["pinned"].([]any); len(pins) != 1 || pins[0] != want {
		t.Fatalf("pinned=%v", out["pinned"])
	}
}
