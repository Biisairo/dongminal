package run

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// AGENT_RECORD_DAEMON_SRS FR-ARD-3·7 (TC-ARD-3) — **Run 의 열림은 저장하지 않는다.**
//
// 종전에는 서버가 뜰 때 지난 기동의 열린 Run 을 `aborted` 로 저장했다(펜싱).
// 데몬이 답하지 못한 순간의 "모른다"가 그 판정에서 "죽었다"가 되어, 살아 있는
// Run 이 영구히 닫혔다 (§2.2). 열림은 이제 물을 때마다 계산한다 (FR-ARD-4).

const legacyRunsJSON = `{"schemaVersion":1,"runs":[` +
	`{"id":"00000000-0000-7000-8000-000000000001","short":"00000000","objective":"open","projection":"background","isolation":"none","state":"open","epoch":"epoch-old","coordinatorToolId":"tool-a","createdAt":1},` +
	`{"id":"00000000-0000-7000-8000-000000000002","short":"00000000","objective":"aborted","projection":"background","isolation":"none","state":"aborted","epoch":"epoch-old","createdAt":1,"closedAt":2,"abortReason":"daemon-restart"}` +
	`]}`

func writeLegacyRuns(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, fileName), []byte(legacyRunsJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// 지난 기동의 열린 Run 은 열린 채고, 파일은 바뀌지 않는다.
func TestLoadKeepsOpenRunFromPreviousEpoch(t *testing.T) {
	dir := writeLegacyRuns(t)
	s := NewStore(dir)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	got, ok := s.Get("00000000-0000-7000-8000-000000000001")
	if !ok || got.State != Open {
		t.Fatalf("state=%v ok=%v want open — 펜싱이 남아 있다 (FR-ARD-3)", got.State, ok)
	}
	blob, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(blob, []byte(legacyRunsJSON)) {
		t.Fatalf("Load 가 runs.json 을 고쳐 썼다:\n%s", blob)
	}
}

// 옛 aborted·epoch 는 그대로 읽힌다 (FR-ARD-7).
func TestLoadReadsLegacyAbortedAndEpoch(t *testing.T) {
	s := NewStore(writeLegacyRuns(t))
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	ab, ok := s.Get("00000000-0000-7000-8000-000000000002")
	if !ok || ab.State != Aborted || ab.AbortReason != AbortDaemonRestart || ab.ClosedAt != 2 {
		t.Fatalf("옛 aborted 레코드가 바뀌었다: %+v", ab)
	}
	op, _ := s.Get("00000000-0000-7000-8000-000000000001")
	if op.Epoch != "epoch-old" {
		t.Fatalf("옛 epoch 를 잃었다: %q", op.Epoch)
	}
}

// 새 Run 은 epoch 를 쓰지 않는다 (FR-ARD-7).
func TestStartDoesNotWriteEpoch(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	rec, err := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone})
	if err != nil {
		t.Fatal(err)
	}
	if rec.Epoch != "" {
		t.Fatalf("epoch=%q want 빈 값", rec.Epoch)
	}
	blob, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte(`"epoch"`)) {
		t.Fatalf("runs.json 에 epoch 가 있다:\n%s", blob)
	}
}

// 직접 모드는 종전 결과 그대로다 (§3.4a): 서버가 다시 뜨면 에이전트가 죽었으므로
// 열린 Run 을 aborted 로 저장한다. 끝난 Run 은 끝난 이유를 그대로 둔다.
func TestAbortOpenOnLoadForDirectMode(t *testing.T) {
	dir := writeLegacyRuns(t)
	s := NewStore(dir, WithAbortOpenOnLoad(), WithClock(func() int64 { return 99 }))
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	op, _ := s.Get("00000000-0000-7000-8000-000000000001")
	if op.State != Aborted || op.AbortReason != AbortDaemonRestart || op.ClosedAt != 99 {
		t.Fatalf("직접 모드의 열린 Run 이 닫히지 않았다: %+v", op)
	}
	ab, _ := s.Get("00000000-0000-7000-8000-000000000002")
	if ab.ClosedAt != 2 {
		t.Fatalf("이미 끝난 Run 의 종료 시각을 고쳤다: %+v", ab)
	}
	again := NewStore(dir)
	if err := again.Load(); err != nil {
		t.Fatal(err)
	}
	if g, _ := again.Get(op.ID); g.State != Aborted {
		t.Fatalf("닫은 것이 저장되지 않았다: %+v", g)
	}
}
