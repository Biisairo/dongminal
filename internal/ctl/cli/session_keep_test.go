package cli

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/shared/handover"
)

// recorder 는 daemonOps 의 가짜다. 실제 데몬·포트에는 닿지 않는다.
type recorder struct {
	running  bool
	outcome  handover.Outcome
	confirm  error
	reloads  int
	confirms int
	stops    int
}

func (r *recorder) ops() daemonOps {
	return daemonOps{
		running: func() bool { return r.running },
		reload:  func() handover.Outcome { r.reloads++; return r.outcome },
		confirm: func() error { r.confirms++; return r.confirm },
		stop:    func() bool { r.stops++; return true },
		notice:  func() string { return "dongminald 실행 중" },
	}
}

func prepare(o StartOpts, r *recorder) (bool, int, string, string) {
	var out, errb bytes.Buffer
	proceed, code := prepareDaemon(o, r.ops(), &out, &errb)
	return proceed, code, out.String(), errb.String()
}

// TC-DSK-1 (FR-DSK-1·2): 데몬이 돌면 교체를 요청하고, 확인되면 진행한다.
func TestPrepareDaemon_SwapsThenProceeds(t *testing.T) {
	r := &recorder{running: true, outcome: handover.Outcome{Kind: handover.Swapped}}
	proceed, code, out, _ := prepare(StartOpts{}, r)
	if !proceed || code != 0 {
		t.Fatalf("proceed=%v code=%d, want 진행", proceed, code)
	}
	if r.reloads != 1 || r.confirms != 1 || r.stops != 0 {
		t.Fatalf("reload=%d confirm=%d stop=%d", r.reloads, r.confirms, r.stops)
	}
	if !strings.Contains(out, "세션") {
		t.Fatalf("교체 사실을 알리지 않는다: %q", out)
	}
}

// TC-DSK-1 (FR-DSK-2·D-DSK-4): 거절되면 아무것도 끄지 않고 종료 코드 1, 다음 할 일을 알린다.
func TestPrepareDaemon_RefusedStopsEverything(t *testing.T) {
	r := &recorder{running: true, outcome: handover.Outcome{
		Kind: handover.Refused, Reason: handover.ReasonPreflight, Detail: "판이 다르다"}}
	proceed, code, _, errOut := prepare(StartOpts{}, r)
	if proceed || code != 1 {
		t.Fatalf("proceed=%v code=%d, want 멈춤·1", proceed, code)
	}
	if r.stops != 0 || r.confirms != 0 {
		t.Fatalf("거절인데 stop=%d confirm=%d", r.stops, r.confirms)
	}
	for _, want := range []string{handover.ReasonPreflight, "판이 다르다", "--refresh-daemon"} {
		if !strings.Contains(errOut, want) {
			t.Fatalf("stderr 에 %q 가 없다: %q", want, errOut)
		}
	}
}

// TC-DSK-11 (FR-DSK-17): 성공 답 뒤 확인에 실패하면 서버를 끄지 않고 종료 코드 1.
func TestPrepareDaemon_UnconfirmedSwapStops(t *testing.T) {
	r := &recorder{running: true, outcome: handover.Outcome{Kind: handover.Swapped},
		confirm: errors.New("pid 가 바뀌었다")}
	proceed, code, _, errOut := prepare(StartOpts{}, r)
	if proceed || code != 1 {
		t.Fatalf("proceed=%v code=%d, want 멈춤·1", proceed, code)
	}
	if !strings.Contains(errOut, "pid 가 바뀌었다") {
		t.Fatalf("상황을 알리지 않는다: %q", errOut)
	}
}

// TC-DSK-2 (FR-DSK-3·D-DSK-8): 옛 데몬이면 서버만 다시 띄우고 경고한다. 종료 코드는 0 이다.
func TestPrepareDaemon_UnsupportedRestartsServerOnly(t *testing.T) {
	r := &recorder{running: true, outcome: handover.Outcome{Kind: handover.Unsupported}}
	proceed, code, out, _ := prepare(StartOpts{}, r)
	if !proceed || code != 0 {
		t.Fatalf("proceed=%v code=%d, want 진행·0", proceed, code)
	}
	if r.stops != 0 || r.confirms != 0 {
		t.Fatalf("미지원인데 stop=%d confirm=%d", r.stops, r.confirms)
	}
	if !strings.Contains(out, "--refresh-daemon") || !strings.Contains(out, "옛 판") {
		t.Fatalf("경고가 없다: %q", out)
	}
}

// FR-DSK-1: 데몬이 없으면 요청하지 않는다 — 서버가 새로 띄운다.
func TestPrepareDaemon_NotRunningJustProceeds(t *testing.T) {
	r := &recorder{running: false}
	proceed, code, _, _ := prepare(StartOpts{}, r)
	if !proceed || code != 0 || r.reloads != 0 || r.stops != 0 {
		t.Fatalf("proceed=%v code=%d reload=%d stop=%d", proceed, code, r.reloads, r.stops)
	}
}

// TC-DSK-3 (FR-DSK-4): --server-only 는 데몬에 아무것도 묻지 않는다.
func TestPrepareDaemon_ServerOnlyTouchesNothing(t *testing.T) {
	r := &recorder{running: true}
	proceed, code, out, _ := prepare(StartOpts{ServerOnly: true}, r)
	if !proceed || code != 0 || r.reloads != 0 || r.stops != 0 {
		t.Fatalf("proceed=%v code=%d reload=%d stop=%d", proceed, code, r.reloads, r.stops)
	}
	if !strings.Contains(out, "dongminald 실행 중") {
		t.Fatalf("데몬 안내가 빠졌다: %q", out)
	}
}

// TC-DSK-3 (FR-DSK-5): --refresh-daemon 은 교체하지 않고 데몬을 끈다.
func TestPrepareDaemon_RefreshStopsDaemon(t *testing.T) {
	r := &recorder{running: true}
	proceed, code, out, _ := prepare(StartOpts{RefreshDaemon: true}, r)
	if !proceed || code != 0 || r.stops != 1 || r.reloads != 0 {
		t.Fatalf("proceed=%v code=%d stop=%d reload=%d", proceed, code, r.stops, r.reloads)
	}
	if !strings.Contains(out, "세션을 잃습니다") {
		t.Fatalf("세션 손실을 알리지 않는다: %q", out)
	}
}

// TC-DSK-3 (FR-DSK-6): --restart-daemon 은 없어졌다. 새 명령을 안내하는 오류다(종료 코드 2).
func TestParseStart_RestartDaemonRemoved(t *testing.T) {
	_, err := ParseStart([]string{"--restart-daemon"})
	if err == nil {
		t.Fatal("--restart-daemon 이 아직 받아들여진다")
	}
	for _, want := range []string{"없어졌습니다", "dongminal start", "--refresh-daemon"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("안내에 %q 가 없다: %v", want, err)
		}
	}
	var out, errb bytes.Buffer
	if code, done := settle("start", err, &out, &errb); !done || code != 2 {
		t.Fatalf("settle = %d,%v want 2,true", code, done)
	}
}

// TC-DSK-3 (FR-DSK-6): 두 플래그를 함께 주면 거절한다.
func TestParseStart_ServerOnlyAndRefreshConflict(t *testing.T) {
	if _, err := ParseStart([]string{"--server-only", "--refresh-daemon"}); err == nil {
		t.Fatal("함께 준 두 플래그를 받아들였다")
	}
}

func TestParseStart_NewFlags(t *testing.T) {
	o, err := ParseStart([]string{"--server-only"})
	if err != nil || !o.ServerOnly || o.RefreshDaemon {
		t.Fatalf("--server-only: %+v %v", o, err)
	}
	o, err = ParseStart([]string{"--refresh-daemon"})
	if err != nil || !o.RefreshDaemon || o.ServerOnly {
		t.Fatalf("--refresh-daemon: %+v %v", o, err)
	}
}

// FR-ACT-3a 승계: 도구 안에서 데몬을 끄는 것은 이제 --refresh-daemon 뿐이다. 교체는 셸을 끊지 않는다.
func TestShouldHandOffRestart_OnlyRefresh(t *testing.T) {
	if !shouldHandOffRestart(true, "", "tool-1") {
		t.Fatal("도구 안의 --refresh-daemon 을 넘기지 않는다")
	}
	if shouldHandOffRestart(false, "", "tool-1") {
		t.Fatal("교체(플래그 없음)를 대리에게 넘긴다")
	}
}
