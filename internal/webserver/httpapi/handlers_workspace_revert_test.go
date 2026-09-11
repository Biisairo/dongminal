package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/workspace"
)

// liveNone 은 아무 도구도 살아 있지 않다고 답한다 — 이 검사는 배치의 되돌리기만
// 재고 도구의 생사는 묻지 않는다.
type liveNone struct{}

func (liveNone) IsLive(string) bool { return false }

// M5 `G4-7` — 워크스페이스 되돌리기.
//
// M3 이 상태 파일에 **세대**를 남겼고 `dongminal rollback` 이 그것을 CLI 에서
// 되돌린다. 다만 그 명령은 **서버가 내려가 있어야** 쓸 수 있다 — 돌고 있으면
// 곧 자기 메모리로 덮기 때문이다. 화면에서 되돌릴 길이 이 종단이다.

func revertHome(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "workspace.json")
	if err := os.WriteFile(path, []byte(`{"schemaVersion":2,"windows":[{"id":"w1","name":"now"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		body := fmt.Sprintf(`{"schemaVersion":2,"windows":[{"id":"w1","name":"gen%d"}]}`, i)
		if err := os.WriteFile(fmt.Sprintf("%s.bak.%d", path, i), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, err := workspace.New(liveNone{}, workspace.FilePersister{Path: path})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })
	return &Server{Deps: Deps{Work: m}, cfg: Config{DataDir: dir}}, path
}

// 목록은 **되돌릴 수 있는 자리**를 보인다.
func TestWorkspaceRevisionsList(t *testing.T) {
	srv, _ := revertHome(t)
	rec := httptest.NewRecorder()
	srv.apiWorkspaceRevisions(rec, httptest.NewRequest("GET", "/api/workspace/revisions", nil))
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Rev  uint64 `json:"rev"`
		Gens []struct {
			Gen   int   `json:"gen"`
			Bytes int64 `json:"bytes"`
		} `json:"generations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Gens) != 3 {
		t.Fatalf("세대 %d개, 기대 3개: %s", len(body.Gens), rec.Body.String())
	}
	if body.Gens[0].Gen != 1 {
		t.Errorf("가장 최근이 먼저여야 한다: %+v", body.Gens)
	}
	for _, g := range body.Gens {
		if g.Bytes <= 0 {
			t.Errorf("크기가 없다: %+v", g)
		}
	}
}

func postRevert(t *testing.T, srv *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/workspace/revert", bytes.NewBufferString(body))
	srv.apiWorkspaceRevert(rec, r)
	return rec
}

// 되돌리면 그 세대가 **현재**가 된다.
func TestWorkspaceRevertLoadsGeneration(t *testing.T) {
	srv, _ := revertHome(t)
	before := srv.Work.CurrentRev()

	rec := postRevert(t, srv, `{"gen":2}`)
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.Contains(srv.Work.Raw(), []byte("gen2")) {
		t.Errorf("세대 2 가 올라오지 않았다: %s", srv.Work.Raw())
	}
	// **rev 는 올라간다.** 되돌리기도 하나의 변경이고, 그래야 다른 창이
	// 자기 판이 뒤졌음을 안다.
	if srv.Work.CurrentRev() <= before {
		t.Errorf("rev 가 오르지 않았다: %d → %d", before, srv.Work.CurrentRev())
	}
}

// **되돌리기도 되돌릴 수 있다.** 직전 판이 세대 사슬의 맨 앞으로 들어간다 —
// 새 자리를 만들지 않고 이미 있는 장치를 쓴다.
func TestWorkspaceRevertIsItselfUndoable(t *testing.T) {
	srv, path := revertHome(t)
	if rec := postRevert(t, srv, `{"gen":2}`); rec.Code != 200 {
		t.Fatalf("status %d", rec.Code)
	}
	// 비동기 쓰기를 기다린다 — Close 가 큐를 비운다.
	srv.Work.(*workspace.Manager).Close()

	gen1, err := os.ReadFile(path + ".bak.1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(gen1, []byte("now")) {
		t.Errorf("직전 판이 세대 1 에 없다: %s", gen1)
	}
}

// 범위 안이지만 **파일이 없는** 세대는 404 다.
//
// 범위 밖(`gen:9`)과 가른다 — 앞의 것은 "있을 수 있었는데 없다" 이고 뒤의 것은
// "애초에 그런 자리가 없다" 다. 사용자가 할 일이 다르다.
func TestWorkspaceRevertMissingGeneration(t *testing.T) {
	srv, path := revertHome(t)
	if err := os.Remove(path + ".bak.3"); err != nil {
		t.Fatal(err)
	}
	if rec := postRevert(t, srv, `{"gen":3}`); rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, 기대 404", rec.Code)
	}
	// 범위 밖은 400 이고, 그 문구가 범위를 말한다.
	rec := postRevert(t, srv, `{"gen":9}`)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("범위 밖 status = %d, 기대 400", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("1..3")) {
		t.Errorf("문구가 범위를 말하지 않는다: %s", rec.Body.String())
	}
}

// 세대 번호가 범위 밖이면 **파일을 만지기 전에** 거절한다 — 경로를 짓게 하지 않는다.
func TestWorkspaceRevertRejectsBadGen(t *testing.T) {
	srv, _ := revertHome(t)
	for _, body := range []string{`{"gen":0}`, `{"gen":-1}`, `{"gen":999}`, `{}`, `nope`} {
		rec := postRevert(t, srv, body)
		if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
			t.Errorf("%s → %d", body, rec.Code)
		}
	}
}

// 깨진 세대는 **올리지 않는다.** 되돌리기가 빈 판을 만들면 그것이 `FE-2` 다.
func TestWorkspaceRevertRejectsCorruptGeneration(t *testing.T) {
	srv, path := revertHome(t)
	if err := os.WriteFile(path+".bak.1", []byte(`{망가짐`), 0o600); err != nil {
		t.Fatal(err)
	}
	before := string(srv.Work.Raw())
	rec := postRevert(t, srv, `{"gen":1}`)
	if rec.Code == 200 {
		t.Error("깨진 세대를 올렸다")
	}
	if string(srv.Work.Raw()) != before {
		t.Error("거절했는데 현재 판이 바뀌었다")
	}
}
