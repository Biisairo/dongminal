package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/toolipc"
)

// PROFILE_NAME_SRS §3.2.
type profileBody struct {
	Name        string `json:"name"`
	Tag         string `json:"tag"`
	Handle      string `json:"handle"`
	Fingerprint string `json:"fingerprint"`
}

func profileDo(t *testing.T, srv *Server, method, body string) (*httptest.ResponseRecorder, profileBody) {
	t.Helper()
	var rd *strings.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	var req *http.Request
	if rd != nil {
		req = apiTestRequest(method, "/api/profile", rd)
	} else {
		req = apiTestRequest(method, "/api/profile", nil)
	}
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	var got profileBody
	if rec.Code == http.StatusOK {
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("body %q: %v", rec.Body.String(), err)
		}
	}
	return rec, got
}

// FR-PFN-10·11: 읽고, 이름만 바꾸고, 틀린 이름은 400 이다.
func TestProfileAPI(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	rec, got := profileDo(t, srv, http.MethodGet, "")
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") == "" {
		t.Fatalf("GET %d etag=%q", rec.Code, rec.Header().Get("ETag"))
	}
	if len(got.Fingerprint) != 64 || got.Tag != edge.Tag(got.Fingerprint) || got.Handle != got.Name+"#"+got.Tag {
		t.Fatalf("GET = %+v", got)
	}
	rec, got = profileDo(t, srv, http.MethodPut, `{"name":"동민"}`)
	if rec.Code != http.StatusOK || got.Name != "동민" || got.Handle != "동민#"+got.Tag {
		t.Fatalf("PUT %d %+v %s", rec.Code, got, rec.Body.String())
	}
	if _, again := profileDo(t, srv, http.MethodGet, ""); again.Name != "동민" {
		t.Fatalf("다시 읽은 이름 = %q", again.Name)
	}
	if rec, _ = profileDo(t, srv, http.MethodPut, `{"name":"동민#1"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("틀린 이름 PUT = %d", rec.Code)
	}
}

// FR-PFN-21: Telegram 기기 이름은 핸들이다.
func TestTelegramDeviceIsHandle(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	if rec, _ := profileDo(t, srv, http.MethodPut, `{"name":"동민"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT %d", rec.Code)
	}
	want := edge.Handle("동민", srv.edgeNode.Identity().Fingerprint)
	if got := (telegramHost{srv}).device(); got != want {
		t.Fatalf("device = %q, 기대 %q", got, want)
	}
	// NFR-PFN-3: 이름을 바꾸면 기억한 핸들을 버린다.
	if rec, _ := profileDo(t, srv, http.MethodPut, `{"name":"새이름"}`); rec.Code != http.StatusOK {
		t.Fatalf("PUT %d", rec.Code)
	}
	if got, want := (telegramHost{srv}).device(), edge.Handle("새이름", srv.edgeNode.Identity().Fingerprint); got != want {
		t.Fatalf("바꾼 뒤 device = %q, 기대 %q", got, want)
	}
}

// FR-PFN-32·33: 두 축 모두 이름표를 저장하지도 응답하지도 않는다. 옛 파일의 이름표는 다음 저장 때 사라진다.
func TestAccessLabelDropped(t *testing.T) {
	home := t.TempDir()
	old := `{"enabled":false,"entries":[{"id":"a","value":"10.0.0.1","label":"phone","enabled":true}],` +
		`"hosts":[{"id":"h","value":"macmini-office","label":"tailnet","enabled":true}]}`
	if err := os.WriteFile(filepath.Join(home, "access.json"), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	srv.Access.lookupHost = func(string) ([]string, error) { return nil, nil }
	req := apiTestRequest(http.MethodGet, "/api/access", nil)
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), `"label"`) {
		t.Fatalf("GET %d — 이름표가 응답에 있다: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "10.0.0.1") {
		t.Fatalf("항목이 사라졌다: %s", rec.Body.String())
	}
	body := `{"enabled":false,"entries":[{"id":"a","value":"10.0.0.1","label":"phone","enabled":true}],` +
		`"hosts":[{"id":"h","value":"macmini-office","label":"tailnet","enabled":true}]}`
	req = apiTestRequest(http.MethodPut, "/api/access", strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:5000"
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT %d %s", rec.Code, rec.Body.String())
	}
	disk, err := os.ReadFile(filepath.Join(home, "access.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(disk), "label") || !strings.Contains(string(disk), "10.0.0.1") {
		t.Fatalf("저장된 파일 = %s", disk)
	}
}

// countingEdgeDaemon 은 profile 연산의 IPC 횟수를 센다.
type countingEdgeDaemon struct {
	ready  bool
	handle string
	calls  int
}

func (d *countingEdgeDaemon) EdgeReady() bool { return d.ready }
func (d *countingEdgeDaemon) Edge(p toolipc.EdgeParams) (toolipc.EdgeResult, error) {
	d.calls++
	body, _ := json.Marshal(map[string]string{"handle": d.handle})
	return toolipc.EdgeResult{Status: http.StatusOK, Body: body}, nil
}
func (d *countingEdgeDaemon) EdgePort(toolipc.EdgePortParams) error { return nil }

// NFR-PFN-3: 핸들은 기억해 두고, 노드 설정이 바뀐 신호에서만 다시 묻는다.
func TestProfileHandleCached(t *testing.T) {
	d := &countingEdgeDaemon{ready: true, handle: "동민#0427"}
	srv, err := New(Config{DataDir: shortHome(t)}, Deps{EdgeDaemon: d})
	if err != nil {
		t.Fatal(err)
	}
	h := telegramHost{srv}
	for range 3 {
		if got := h.device(); got != "동민#0427" {
			t.Fatalf("device = %q", got)
		}
	}
	if d.calls != 1 {
		t.Fatalf("IPC %d번, 기대 1번", d.calls)
	}
	d.handle = "새이름#0427"
	srv.edgesChanged(edgenode.Change{})
	if got := h.device(); got != "새이름#0427" || d.calls != 2 {
		t.Fatalf("바뀐 뒤 device = %q, IPC %d번", got, d.calls)
	}
}

// NFR-PFN-3: 노드가 답하지 못한 결과는 기억하지 않는다.
func TestProfileHandleNotCachedWhenUnavailable(t *testing.T) {
	d := &countingEdgeDaemon{ready: false, handle: "동민#0427"}
	srv, err := New(Config{DataDir: shortHome(t)}, Deps{EdgeDaemon: d})
	if err != nil {
		t.Fatal(err)
	}
	host, _ := os.Hostname()
	if got := (telegramHost{srv}).device(); got != host {
		t.Fatalf("준비 전 device = %q, 기대 호스트 이름", got)
	}
	d.ready = true
	if got := (telegramHost{srv}).device(); got != "동민#0427" {
		t.Fatalf("준비 뒤 device = %q", got)
	}
}
