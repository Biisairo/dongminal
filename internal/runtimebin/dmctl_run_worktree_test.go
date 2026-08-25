package runtimebin

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
)

// 묶음 W 의 CLI 절반 (RUN_ORCHESTRATION_SRS §3.4).

// FR-WKT-5: 격리 Run 은 **조정자의 cwd** 를 실어 보낸다. 서버의 cwd 가 아니다 —
// 서버는 조정자가 어느 저장소에서 일하는지 알 방법이 없다.
func TestDmctlRun_StartSendsCoordinatorCwd(t *testing.T) {
	ts, calls := runStub(t, map[string]string{"/api/runs": `{"id":"run-1","state":"open","isolation":"per-member"}`})
	pointDmctlAtServer(t, ts, "tool-a")

	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	code := runDmctlRun([]string{"start", "--objective", "x", "--isolation", "per-member", "--base", "main"}, io.Discard, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	body := (*calls)[0].Body
	if body["cwd"] != wd {
		t.Fatalf("cwd 가 실리지 않았다: %+v", body)
	}
	if body["isolation"] != "per-member" || body["base"] != "main" {
		t.Fatalf("격리 인자가 어긋난다: %+v", body)
	}
}

// FR-WKT-1: 비격리 Run 은 cwd 를 보내지 않는다 — 쓰이지 않는 정보이고, Run 이
// 저장소와 무관하다는 사실이 요청 본문에 그대로 보여야 한다.
func TestDmctlRun_StartOmitsCwdWithoutIsolation(t *testing.T) {
	ts, calls := runStub(t, map[string]string{"/api/runs": `{"id":"run-1","state":"open"}`})
	pointDmctlAtServer(t, ts, "tool-a")

	if code := runDmctlRun([]string{"start", "--objective", "x"}, io.Discard, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if _, ok := (*calls)[0].Body["cwd"]; ok {
		t.Fatalf("비격리인데 cwd 를 보냈다: %+v", (*calls)[0].Body)
	}
}

// FR-WKT-6: - 로 시작하는 base 는 서버에 가기 전에 막는다.
func TestDmctlRun_StartRejectsDashBase(t *testing.T) {
	ts, calls := runStub(t, map[string]string{"/api/runs": `{"id":"run-1"}`})
	pointDmctlAtServer(t, ts, "tool-a")

	var errOut bytes.Buffer
	code := runDmctlRun([]string{"start", "--objective", "x", "--isolation", "per-run", "--base", "-x"}, io.Discard, &errOut)
	if code != 2 {
		t.Fatalf("exit = %d, want 2 (%s)", code, errOut.String())
	}
	if len(*calls) != 0 {
		t.Fatalf("거부해야 할 요청이 나갔다: %+v", *calls)
	}
}

// FR-WKT-8/12: close 는 --keep-worktrees 를 보내고, 잔여물을 **눈에 띄게** 낸다.
func TestDmctlRun_CloseReportsResidue(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/close": `{"id":"run-1","state":"closed","cleanup":[],"residue":1,"worktrees":[
			{"path":"/home/wt/a","branch":"dmn/r/a","removed":true},
			{"path":"/home/wt/b","branch":"dmn/r/b","removed":false,"residue":"dirty"}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"close", "--run", "run-1", "--keep-worktrees"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if (*calls)[0].Body["keepWorktrees"] != true {
		t.Fatalf("--keep-worktrees 가 전달되지 않았다: %+v", (*calls)[0].Body)
	}
	text := out.String()
	if !strings.Contains(text, "잔여물") || !strings.Contains(text, "/home/wt/b") || !strings.Contains(text, "dirty") {
		t.Fatalf("잔여물이 보고되지 않았다: %q", text)
	}
	if strings.Contains(text, "/home/wt/a") {
		t.Fatalf("제거된 트리를 잔여물로 냈다: %q", text)
	}
}

// FR-WKT-12: status 도 잔여물을 말한다. close 를 지켜보지 못한 다음 세션이
// 그 사실을 알 유일한 경로다.
func TestDmctlRun_StatusShowsWorktrees(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs": `{"id":"run-1","short":"run-1","state":"closed","isolation":"per-member","objective":"x",
			"worktree":null,
			"members":[{"id":"m1","role":"작가","state":"done","toolId":"t1","tabId":"tab-1",
				"worktree":{"path":"/home/wt/a","branch":"dmn/r/a","base":"main","residue":"dirty"}}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"status", "--run", "run-1"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	text := out.String()
	if !strings.Contains(text, "/home/wt/a") || !strings.Contains(text, "dmn/r/a") {
		t.Fatalf("작업 트리가 보이지 않는다: %q", text)
	}
	if !strings.Contains(text, "dirty") {
		t.Fatalf("잔여물이 보이지 않는다: %q", text)
	}
}

// FR-WKT-3: 격리 멤버의 등록 출력은 작업 트리를 같은 줄에 담는다. 조정자가
// 기동 전에 cd 로 보내야 하는 경로이기 때문이다 — 도구의 셸은 ~ 에서 시작한다.
func TestDmctlRun_MemberShowsWorktree(t *testing.T) {
	ts, _ := runStub(t, map[string]string{
		"/api/runs/members": `{"id":"m1","role":"작가","agent":"claude","toolId":"t1","tabId":"tab-1","state":"starting",
			"worktree":{"path":"/home/wt/a","branch":"dmn/r/a","base":"main"}}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	code := runDmctlRun([]string{"member", "--run", "run-1", "--role", "작가", "--agent", "claude", "--at", "tab-1"}, &out, io.Discard)
	if code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if !strings.Contains(out.String(), "worktree=/home/wt/a") {
		t.Fatalf("작업 트리가 등록 출력에 없다: %q", out.String())
	}
}
