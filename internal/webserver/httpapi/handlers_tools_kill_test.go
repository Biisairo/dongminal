package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/toolclient"

	"dongminal/internal/shared/testpath"
)

// 묶음 X 검증 (CONVENIENCE_SRS §3.2). 서버측은 V-BGK-8/9/10 이 닿는다 —
// 나머지는 모달 동작이므로 e2e/bg-kill.spec.ts 가 맡는다.

// shortGrace 는 유예를 테스트 시간 규모로 줄인다. 3 초를 실제로 기다리는 테스트는
// 재현 가능하지만 느리고, 검증하려는 것은 "유예가 있는가" 이지 그 길이가 아니다.
// 서버 하나의 값이다 — 같은 프로세스의 다른 서버는 영향받지 않는다 (M8 `GO-9`).
func shortGrace(s *Server, d time.Duration) { s.limits.toolKillGrace = d }

// waitFor 는 가짜 셸이 남기는 준비 표식을 기다린다.
func waitFor(t *testing.T, path string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Skipf("가짜 셸이 뜨지 않음(환경): %s", path)
}

func postKill(s *Server, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	s.apiToolKill(rec, apiTestRequest(http.MethodPost, "/api/tools/kill", strings.NewReader(body)))
	return rec
}

func TestApiToolKill_RejectsMissingToolID(t *testing.T) {
	s := &Server{Deps: Deps{Tools: toolhub.NewToolManager(toolTempDir(t), nil)}}
	for _, body := range []string{``, `{}`, `{"toolId":""}`} {
		if got := postKill(s, body).Code; got != http.StatusBadRequest {
			t.Errorf("body=%q status=%d, want 400", body, got)
		}
	}
}

// V-BGK-10 의 서버측 근거: 알 수 없는 도구는 404 다. 조용히 성공하면 모달이
// 낡은 행을 지우고 사용자는 무엇이 잘못됐는지 알 수 없다.
func TestApiToolKill_UnknownToolIs404(t *testing.T) {
	s := &Server{Deps: Deps{Tools: toolhub.NewToolManager(toolTempDir(t), nil)}}
	if got := postKill(s, `{"toolId":"nope"}`).Code; got != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", got)
	}
}

func TestApiToolKill_NoHubIs404(t *testing.T) {
	s := &Server{}
	if got := postKill(s, `{"toolId":"nope"}`).Code; got != http.StatusNotFound {
		t.Fatalf("status=%d, want 404", got)
	}
}

// V-BGK-8: 종료 후 GET /api/tools/background 에서 사라진다 (FR-BGK-6 — Delete 가
// background 맵에서도 제거한다).
func TestApiToolKill_RemovesFromBackgroundList(t *testing.T) {
	dir := toolTempDir(t)
	m := toolhub.NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)
	tl, err := m.Create(dir, 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	m.SetBackground(tl.ID, true)
	s := &Server{Deps: Deps{Tools: m}}
	shortGrace(s, 200*time.Millisecond)

	rec := postKill(s, `{"toolId":`+testpath.JSONQuote(tl.ID)+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s, want 200", rec.Code, rec.Body.String())
	}
	var got struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || !got.OK {
		t.Fatalf("body=%s err=%v, want {\"ok\":true}", rec.Body.String(), err)
	}
	if list := m.BackgroundList(); len(list) != 0 {
		t.Errorf("종료 후 백그라운드 목록 = %+v, want 없음", list)
	}
	if m.Get(tl.ID) != nil {
		t.Error("종료 후에도 도구가 조회됨")
	}

	// 같은 도구를 다시 종료하면 404 — 행은 이미 사라졌다.
	if again := postKill(s, `{"toolId":`+testpath.JSONQuote(tl.ID)+`}`).Code; again != http.StatusNotFound {
		t.Errorf("두 번째 종료 status=%d, want 404", again)
	}
}

// V-BGK-9: SIGTERM 을 무시하는 프로세스는 유예가 지난 뒤 SIGKILL 로 죽는다
// (FR-BGK-7). 가짜 셸을 $SHELL 로 세워 TERM 을 받고도 살아 있게 한다.
//
// 무시는 **핸들러가 아니라 `trap ” TERM`(SIG_IGN)** 이어야 한다. 이 PTY 배치에서
// 핸들러 트랩은 실측상 셸을 살려 두지 못했다 (SIGTERM 이 그대로 죽인다). 그래서
// SIGTERM 전달 자체는 파일 표식이 아니라 **유예를 다 쓴다는 사실**로 관측한다 —
// 무시하지 못했다면 셸은 즉시 죽고 대기는 조기 종료됐을 것이다.
func TestApiToolKill_SigtermThenKillAfterGrace(t *testing.T) {
	// 가짜 셸이 `#!/bin/sh` 스크립트이고, 검사 대상이 SIGTERM trap 이다.
	// Windows 에는 둘 다 없다 (FR-XPR-3 — 그쪽의 정중한 종료는 Ctrl+Break 다).
	if !testpath.POSIXShell() {
		t.Skip("POSIX 셸 스크립트와 SIGTERM 이 없는 OS 다")
	}
	const grace = 400 * time.Millisecond
	dir := toolTempDir(t)
	shell := filepath.Join(dir, "stubborn.sh")
	ready := filepath.Join(dir, "ready")
	// 준비 표식은 경합 제거용이다 — trap 이 걸리기 전에 SIGTERM 이 닿으면 셸은
	// 그냥 죽고, 이 테스트는 유예를 보지 못한 채 통과도 실패도 아닌 것이 된다.
	script := "#!/bin/sh\ntrap '' TERM\n: > " + ready + "\nwhile :; do sleep 0.05; done\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatalf("가짜 셸 작성: %v", err)
	}
	t.Setenv("SHELL", shell)

	m := toolhub.NewToolManager(dir, nil)
	t.Cleanup(m.StopSaving)
	tl, err := m.Create(dir, 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	pid := tl.CmdProcessPID()
	if pid <= 0 {
		t.Fatal("pid 를 얻지 못함")
	}
	waitFor(t, ready)
	m.SetBackground(tl.ID, true)

	s := &Server{Deps: Deps{Tools: m}}
	shortGrace(s, grace)
	start := time.Now()
	done := make(chan int, 1)
	go func() {
		done <- postKill(s, `{"toolId":`+testpath.JSONQuote(tl.ID)+`}`).Code
	}()

	// 유예 도중: 아직 죽이지 않았다. 이 확인이 없으면 "그냥 유예만큼 잤다" 와
	// 구별되지 않는다.
	time.Sleep(grace / 2)
	if m.Get(tl.ID) == nil {
		t.Error("유예가 끝나기 전에 도구가 제거됐다")
	}

	code := <-done
	elapsed := time.Since(start)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if elapsed < grace {
		t.Errorf("소요=%v, want >= %v — 유예 없이 죽였다", elapsed, grace)
	}
	if platform.Current().Process.Alive(pid) {
		t.Errorf("pid=%d 가 아직 살아 있음 — 강제 종료로 넘어가지 않았다", pid)
	}
	if list := m.BackgroundList(); len(list) != 0 {
		t.Errorf("종료 후 백그라운드 목록 = %+v, want 없음", list)
	}
}

// M8 FBE-05/12: **데몬 모드에서도** 유예가 3초(여기서는 줄인 값)다. 종전에는 유예를
// 서버가 pid 를 보고 기다렸는데, 데몬 모드의 Get 은 pid 없는 합성 Tool 을 주므로
// 유예가 통째로 건너뛰어지고 데몬의 Delete 가 50ms 만 기다렸다 (실측 50ms).
// 이제 유예는 도구가 있는 프로세스 — 데몬 — 가 `terminate` RPC 로 기다린다.
//
// 가짜 셸은 TERM 을 받으면 **이력 표식을 남기고** 그 뒤에도 살아 있다 — 백그라운드
// claude 세션이 SIGTERM 에 이력을 적는 것과 같은 자리다. 표식이 남고, 유예가 다
// 지나고, 그 뒤 강제 종료된다.
func TestApiToolKill_DaemonModeHonorsGrace(t *testing.T) {
	if !testpath.POSIXShell() {
		t.Skip("POSIX 셸 스크립트와 SIGTERM 이 없는 OS 다")
	}
	const grace = 400 * time.Millisecond
	dir := toolTempDir(t)
	shell := filepath.Join(dir, "stubborn.sh")
	ready := filepath.Join(dir, "ready")
	history := filepath.Join(dir, "history")
	script := "#!/bin/sh\ntrap ': > " + history + "' TERM\n: > " + ready + "\nwhile :; do sleep 0.05; done\n"
	if err := os.WriteFile(shell, []byte(script), 0o755); err != nil {
		t.Fatalf("가짜 셸 작성: %v", err)
	}
	t.Setenv("SHELL", shell)

	// 데몬 + 클라이언트 — 서버는 ToolClient 를 ToolHub 로 든다.
	pm := toolhub.NewToolManager(dir, nil)
	t.Cleanup(pm.StopSaving)
	sockPath := filepath.Join(dir, "s")
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ps.Close()
	go func() { ps.Accept() }()
	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()

	tl, err := pc.Create(dir, 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	waitFor(t, ready)
	pid := pm.Get(tl.ID).CmdProcessPID()
	pc.SetBackground(tl.ID, true)

	s := &Server{Deps: Deps{Tools: pc}}
	shortGrace(s, grace)
	start := time.Now()
	code := postKill(s, `{"toolId":`+testpath.JSONQuote(tl.ID)+`}`).Code
	elapsed := time.Since(start)
	if code != http.StatusOK {
		t.Fatalf("status=%d, want 200", code)
	}
	if elapsed < grace {
		t.Errorf("소요=%v, want >= %v — 데몬 모드에서 유예 없이 죽였다", elapsed, grace)
	}
	if _, err := os.Stat(history); err != nil {
		t.Errorf("SIGTERM 이 닿지 않았다 — 이력 표식이 없다: %v", err)
	}
	if platform.Current().Process.Alive(pid) {
		t.Errorf("pid=%d 가 아직 살아 있음 — 유예 뒤 강제 종료로 넘어가지 않았다", pid)
	}
	if pm.Get(tl.ID) != nil {
		t.Error("데몬 레지스트리에 도구가 남았다")
	}
}
