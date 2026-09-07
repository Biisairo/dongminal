package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func setTestServer(t *testing.T, srv *httptest.Server) {
	t.Helper()
	u, _ := url.Parse(srv.URL)
	t.Setenv("DONGMINAL_HOST", u.Hostname())
	t.Setenv("DONGMINAL_PORT", u.Port())
}

// FR-BG-2/6/7: detach 는 현재 도구를 백그라운드로 보내고 탭을 닫는다.
// 명령 이름으로 bg 를 쓰지 않는다 — zsh/bash 작업 제어 빌트인과 충돌한다.

func TestDetach_SendsCurrentToolToBackground(t *testing.T) {
	var gotPath, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := new(bytes.Buffer)
		b.ReadFrom(r.Body)
		gotPath, gotBody = r.URL.Path, b.String()
		w.Write([]byte(`{"delivered":1}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)
	t.Setenv("DONGMINAL_TOOL_ID", "42")

	var out, errOut bytes.Buffer
	if rc := runDetach(nil, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	if gotPath != "/api/commands" {
		t.Errorf("경로 = %s, want /api/commands", gotPath)
	}
	if !strings.Contains(gotBody, "detachTab") {
		t.Errorf("바디에 detachTab 없음: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"42"`) {
		t.Errorf("바디에 도구 id 없음: %s", gotBody)
	}
}

func TestDetach_RequiresToolID(t *testing.T) {
	t.Setenv("DONGMINAL_TOOL_ID", "")
	var out, errOut bytes.Buffer
	if rc := runDetach(nil, &out, &errOut); rc == 0 {
		t.Error("DONGMINAL_TOOL_ID 없이 성공했음")
	}
	if !strings.Contains(errOut.String(), "DONGMINAL_TOOL_ID") {
		t.Errorf("안내 메시지 없음: %s", errOut.String())
	}
}

func TestDetach_ListPrintsBackgroundTools(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"background": []map[string]any{
			{"toolId": "7", "name": "Shell #7", "cwd": "/repo/web", "since": 1700000000000000000},
			{"toolId": "9", "name": "Shell #9", "cwd": "/repo/api", "since": 1700000001000000000},
		}})
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--list"}, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	got := out.String()
	for _, want := range []string{"toolId=7", "/repo/web", "toolId=9", "/repo/api"} {
		if !strings.Contains(got, want) {
			t.Errorf("출력에 %q 없음:\n%s", want, got)
		}
	}
}

func TestDetach_ListEmptyIsZeroExit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"background": []any{}})
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--list"}, &out, &errOut); rc != 0 {
		t.Errorf("빈 목록 rc=%d, want 0", rc)
	}
	if !strings.Contains(out.String(), "없") {
		t.Errorf("빈 목록 안내 없음: %s", out.String())
	}
}

func TestDetach_RestoreSendsCommand(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := new(bytes.Buffer)
		b.ReadFrom(r.Body)
		gotBody = b.String()
		w.Write([]byte(`{"delivered":1}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--restore", "7"}, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	if !strings.Contains(gotBody, "restoreTool") || !strings.Contains(gotBody, `"7"`) {
		t.Errorf("복귀 명령 바디: %s", gotBody)
	}
}

func TestDetach_RestoreRequiresID(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--restore"}, &out, &errOut); rc == 0 {
		t.Error("--restore 인자 없이 성공했음")
	}
}

func TestDetach_UnknownFlag(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--nope"}, &out, &errOut); rc != 2 {
		t.Errorf("rc=%d, want 2", rc)
	}
}

// FR-BGR-1/3: --at <uuid> 로 복귀 대상 Pane 을 지정한다. 서버의
// translateLocationUUID 는 action 종류를 보지 않으므로, location 을 실어 보내면
// 그대로 좌표로 변환되어 브로드캐스트된다.

func restoreBody(t *testing.T, args ...string) (string, int) {
	t.Helper()
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := new(bytes.Buffer)
		b.ReadFrom(r.Body)
		gotBody = b.String()
		w.Write([]byte(`{"delivered":1}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	rc := runDetach(args, &out, &errOut)
	return gotBody, rc
}

func TestDetach_RestoreWithAtSendsLocation(t *testing.T) {
	body, rc := restoreBody(t, "--restore", "7", "--at", "t42")
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	var req struct {
		Action string `json:"action"`
		Args   struct {
			ToolID   string `json:"toolId"`
			Location string `json:"location"`
		} `json:"args"`
	}
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("바디 파싱: %v (%s)", err, body)
	}
	if req.Action != "restoreTool" || req.Args.ToolID != "7" || req.Args.Location != "t42" {
		t.Errorf("action=%q toolId=%q location=%q", req.Action, req.Args.ToolID, req.Args.Location)
	}
}

func TestDetach_RestoreWithAtEqualsForm(t *testing.T) {
	body, rc := restoreBody(t, "--restore", "7", "--at=t42")
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(body, `"location":"t42"`) {
		t.Errorf("--at= 형태가 location 을 싣지 않음: %s", body)
	}
}

// --at 순서는 자유다. --restore 앞에 와도 같은 결과여야 한다.
func TestDetach_RestoreAtBeforeRestore(t *testing.T) {
	body, rc := restoreBody(t, "--at", "t42", "--restore", "7")
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if !strings.Contains(body, `"location":"t42"`) || !strings.Contains(body, `"toolId":"7"`) {
		t.Errorf("바디: %s", body)
	}
}

// --at 없는 기존 호출은 location 을 싣지 않는다 (FR-BGR-4 하위 호환).
func TestDetach_RestoreWithoutAtOmitsLocation(t *testing.T) {
	body, rc := restoreBody(t, "--restore", "7")
	if rc != 0 {
		t.Fatalf("rc=%d", rc)
	}
	if strings.Contains(body, "location") {
		t.Errorf("--at 없이 location 이 실렸다: %s", body)
	}
}

func TestDetach_AtRequiresValue(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--restore", "7", "--at"}, &out, &errOut); rc == 0 {
		t.Error("--at 값 없이 성공했음")
	}
}

// FR-BGR-3: --at 은 --restore 와 함께만 유효하다.
func TestDetach_AtWithoutRestoreIsRejected(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--at", "t42"}, &out, &errOut); rc == 0 {
		t.Error("--restore 없는 --at 이 성공했음")
	}
}

// FR-BGR-3: detach 에서 -l 은 --list 다 (dmctl 의 --at 단축이 아니다).
func TestDetach_DashLStaysList(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tools/background" {
			t.Errorf("-l 이 목록 조회가 아닌 %s 를 호출했다", r.URL.Path)
		}
		w.Write([]byte(`{"background":[]}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"-l"}, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	if !strings.Contains(out.String(), "백그라운드 도구 없음") {
		t.Errorf("목록 출력이 아니다: %s", out.String())
	}
}

// UX_BATCH6_SRS FR-BGP-3·6 — `detach --run <명령>` 의 CLI 절반.
//
// 브라우저를 거치지 않는다 — 만드는 것이 **탭 없는 도구**이므로 화면에 자리를 잡을
// 필요가 없고, 종단은 헤드리스 생성이 쓰는 그것이다.
func TestDetach_RunPostsHeadlessWithCommand(t *testing.T) {
	var path, body string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Write([]byte(`{"toolId":"t-9"}`))
	}))
	defer srv.Close()
	setTestServer(t, srv)

	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--run", "npm run build", "--cwd", "/w"}, &out, &errOut); rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut.String())
	}
	if path != "/api/tools/headless" {
		t.Fatalf("종단이 다르다: %s", path)
	}
	if !strings.Contains(body, `"command":"npm run build"`) {
		t.Errorf("명령이 실리지 않았다: %s", body)
	}
	if !strings.Contains(body, `"cwd":"/w"`) {
		t.Errorf("작업 자리가 실리지 않았다: %s", body)
	}
	if !strings.Contains(out.String(), "t-9") {
		t.Errorf("만들어진 도구를 알리지 않았다: %s", out.String())
	}
}

// `--cwd` 는 `--run` 의 인자다. 단독 사용은 오해이므로 조용히 무시하지 않는다
// (`--at` 과 같은 규약, FR-BGR-3).
func TestDetach_CwdWithoutRunIsRejected(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--cwd", "/w"}, &out, &errOut); rc == 0 {
		t.Error("--run 없는 --cwd 가 성공했다")
	}
}

// 빈 명령은 무동작이 아니라 오류다 — 무엇을 돌릴지 말하지 않은 요청이다.
func TestDetach_RunRequiresCommand(t *testing.T) {
	for _, args := range [][]string{{"--run"}, {"--run", "   "}, {"--run="}} {
		var out, errOut bytes.Buffer
		if rc := runDetach(args, &out, &errOut); rc == 0 {
			t.Errorf("%v 가 성공했다", args)
		}
	}
}

// `--run` 은 목록·복귀와 함께 쓸 수 없다 — 셋은 서로 다른 일이다.
func TestDetach_RunIsExclusive(t *testing.T) {
	var out, errOut bytes.Buffer
	if rc := runDetach([]string{"--run", "ls", "--list"}, &out, &errOut); rc == 0 {
		t.Error("--run 과 --list 가 함께 성공했다")
	}
}
