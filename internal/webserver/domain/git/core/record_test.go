package core

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// 케이스 7 (V15, FR-GIT-5): 성공·실패·거부 세 경로 전부가 기록에 남는다.
func TestRecords_AllPaths(t *testing.T) {
	s := New(WithRunner(func(_ context.Context, _ string, args []string) (Output, error) {
		if args[0] == "status" {
			return Output{Stdout: "## main\n", ExitCode: 0, DurationMs: 7}, nil
		}
		return Output{Stderr: "fatal: bad object\n", ExitCode: 128, DurationMs: 3}, nil
	}))
	ctx := context.Background()
	if _, err := s.Exec(ctx, absTmpRepo, "status", "--porcelain"); err != nil {
		t.Fatalf("성공 경로: %v", err)
	}
	if _, err := s.Exec(ctx, absTmpRepo, "show", "deadbeef"); err == nil {
		t.Fatal("실패 경로에서 오류가 없다")
	}
	if _, err := s.Exec(ctx, absTmpRepo, "commit", "-m", "x"); !errors.Is(err, ErrWriteCommand) {
		t.Fatalf("거부 경로: %v", err)
	}

	recs := s.Records(0)
	if len(recs) != 3 {
		t.Fatalf("기록 %d 건, want 3", len(recs))
	}
	for i, r := range recs {
		if len(r.Argv) == 0 || r.Cwd != absTmpRepo {
			t.Fatalf("recs[%d] argv/cwd 누락: %+v", i, r)
		}
		if r.AtUnixMs <= 0 || r.Seq != uint64(i+1) {
			t.Fatalf("recs[%d] seq/시각: %+v", i, r)
		}
		if r.Destructive {
			t.Fatalf("recs[%d] M1 은 파괴적 동작이 없다: %+v", i, r)
		}
	}

	ok, fail, denied := recs[0], recs[1], recs[2]
	if ok.ExitCode != 0 || ok.DurationMs != 7 || ok.StdoutBytes != len("## main\n") || ok.Err != "" {
		t.Fatalf("성공 기록: %+v", ok)
	}
	if fail.ExitCode != 128 || fail.DurationMs != 3 || !strings.Contains(fail.Stderr, "bad object") || fail.Err == "" {
		t.Fatalf("실패 기록: %+v", fail)
	}
	if denied.ExitCode != -1 || denied.Err == "" || denied.Argv[0] != "commit" {
		t.Fatalf("거부 기록: %+v", denied)
	}
}

// 케이스 9 (V15): 링이 넘치면 오래된 것이 밀려나고 Seq 는 되돌아가지 않는다.
func TestRecorder_RingEviction(t *testing.T) {
	r := NewRecorder(3)
	for i := 0; i < 5; i++ {
		r.Add(Record{Cwd: "/x"})
	}
	if r.Len() != 3 {
		t.Fatalf("Len = %d, want 3", r.Len())
	}
	recs := r.Recent(0)
	if len(recs) != 3 {
		t.Fatalf("Recent(0) = %d 건", len(recs))
	}
	for i, want := range []uint64{3, 4, 5} {
		if recs[i].Seq != want {
			t.Fatalf("recs[%d].Seq = %d, want %d", i, recs[i].Seq, want)
		}
	}
	if tail := r.Recent(2); len(tail) != 2 || tail[1].Seq != 5 {
		t.Fatalf("Recent(2) = %+v — 최신이 마지막이어야 한다", tail)
	}
	if r.Recent(99)[0].Seq != 3 {
		t.Fatal("n 이 보유량보다 크면 보유분 전부여야 한다")
	}
}

func TestNewRecorder_CapFallback(t *testing.T) {
	for _, c := range []int{0, -1} {
		r := NewRecorder(c)
		for i := 0; i < DefaultRecordCap+10; i++ {
			r.Add(Record{})
		}
		if r.Len() != DefaultRecordCap {
			t.Fatalf("cap %d → Len %d, want %d", c, r.Len(), DefaultRecordCap)
		}
	}
}

// 케이스 10 (V15): 동시 접근이 race detector 에서 깨끗하다.
func TestRecorder_Concurrent(t *testing.T) {
	rec := NewRecorder(16)
	s := New(WithRecorder(rec), WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{Stdout: "x", DurationMs: 1}, nil
	}))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_, _ = s.Exec(context.Background(), absTmpRepo, "status")
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_ = s.Records(5)
				_ = rec.Len()
			}
		}()
	}
	wg.Wait()
	if rec.Len() != 16 {
		t.Fatalf("Len = %d, want 16", rec.Len())
	}
	// 반환된 슬라이스는 복사여야 한다 — 호출자가 내부 링을 들고 있으면 경합한다.
	got := rec.Recent(4)
	got[0].Cwd = "mutated"
	if rec.Recent(4)[0].Cwd == "mutated" {
		t.Fatal("Recent 가 내부 저장을 그대로 넘겼다")
	}
}

// WithRecorder 를 주지 않아도 Service 는 기록을 갖는다.
func TestService_DefaultRecorder(t *testing.T) {
	s := New(WithRunner(func(_ context.Context, _ string, _ []string) (Output, error) {
		return Output{}, nil
	}))
	if _, err := s.Exec(context.Background(), absTmpRepo, "status"); err != nil {
		t.Fatal(err)
	}
	if len(s.Records(0)) != 1 {
		t.Fatal("기본 Recorder 가 없다")
	}
	if DefaultTimeout != 30*time.Second || DefaultMaxOutput != 1<<20 || DefaultRecordCap != 500 {
		t.Fatal("기본값 상수가 계약과 다르다")
	}
}

// FR-OPT-4-8 (DOM-27): 커서 뒤의 것만 준다. 링이 커서와 보유분 사이를 버렸거나 커서가
// 마지막 Seq 보다 크면(서버가 다시 떴다) 증분으로 이을 수 없으므로 Gap 과 보유분 전부다.
func TestRecorder_Since(t *testing.T) {
	r := NewRecorder(3)
	if recs, span := r.Since(0); len(recs) != 0 || span.Gap || span.Last != 0 || span.First != 1 {
		t.Fatalf("빈 링: %+v %+v", recs, span)
	}
	for i := 0; i < 5; i++ {
		r.Add(Record{})
	}
	seqs := func(recs []Record) []uint64 {
		out := make([]uint64, 0, len(recs))
		for _, rc := range recs {
			out = append(out, rc.Seq)
		}
		return out
	}
	cases := []struct {
		after uint64
		want  []uint64
		gap   bool
	}{
		{5, []uint64{}, false},
		{4, []uint64{5}, false},
		{2, []uint64{3, 4, 5}, false},
		{1, []uint64{3, 4, 5}, true},
		{0, []uint64{3, 4, 5}, true},
		{9, []uint64{3, 4, 5}, true},
	}
	for _, c := range cases {
		recs, span := r.Since(c.after)
		if got := seqs(recs); len(got) != len(c.want) || (len(got) > 0 && (got[0] != c.want[0] || got[len(got)-1] != c.want[len(c.want)-1])) {
			t.Fatalf("Since(%d) = %v, want %v", c.after, got, c.want)
		}
		if span.Gap != c.gap || span.First != 3 || span.Last != 5 {
			t.Fatalf("Since(%d) span = %+v, want gap=%v first=3 last=5", c.after, span, c.gap)
		}
	}
}
