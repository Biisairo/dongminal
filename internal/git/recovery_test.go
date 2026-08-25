package git

import (
	"strconv"
	"sync"
	"testing"
)

// 묶음 J — recovery hint (GIT_SRS §3A.3 FR-GIT-92·93, 검증 V37).

// W12 (FR-GIT-93): Seq 는 단조 증가하고 링이 넘치면 오래된 것이 버려진다.
// Seq 가 되돌아가면 무엇이 유실됐는지 알 수 없다.
func TestHintLog_SeqAndEviction(t *testing.T) {
	l := NewHintLog(3)
	for i := 0; i < 5; i++ {
		got := l.Add(Hint{Repo: "/r", Action: ActionDiscard, Targets: []string{strconv.Itoa(i)}})
		if got.Seq != uint64(i+1) {
			t.Fatalf("%d 번째 Add 의 Seq = %d, want %d", i, got.Seq, i+1)
		}
		if got.AtUnixMs == 0 {
			t.Fatalf("%d 번째 hint 에 시각이 없다: %+v", i, got)
		}
	}
	recent := l.Recent(0)
	if len(recent) != 3 {
		t.Fatalf("보유량 = %d, want 3 (링 용량)", len(recent))
	}
	// 최신이 마지막이다.
	for i, h := range recent {
		if h.Seq != uint64(i+3) || h.Targets[0] != strconv.Itoa(i+2) {
			t.Fatalf("recent[%d] = %+v", i, h)
		}
	}
	if got := l.Recent(1); len(got) != 1 || got[0].Seq != 5 {
		t.Fatalf("Recent(1) = %+v", got)
	}
	if got := l.Recent(99); len(got) != 3 {
		t.Fatalf("Recent(99) = %d 개, want 3", len(got))
	}
	// 호출자가 받은 것은 복사본이다 — 내부 링을 들고 있으면 다음 Add 와 경합한다.
	recent[0].Action = "바뀜"
	if l.Recent(0)[0].Action != ActionDiscard {
		t.Fatal("Recent 가 내부 링을 노출한다")
	}
}

// W12: 제로값도 쓸 수 있다 — 기본 용량으로 자리를 잡는다. "hint 로그가 없어서
// 기록하지 못했다" 는 경로를 만들지 않는다.
func TestHintLog_ZeroValueUsesDefaultCap(t *testing.T) {
	var l HintLog
	if h := l.Add(Hint{Action: ActionResetHard}); h.Seq != 1 {
		t.Fatalf("Seq = %d, want 1", h.Seq)
	}
	if l.Len() != 1 {
		t.Fatalf("Len = %d, want 1", l.Len())
	}
	if got := len(NewHintLog(0).Recent(0)); got != 0 {
		t.Fatalf("빈 로그의 Recent = %d 개", got)
	}
}

// W12: 동시 접근이 안전하다 (go test -race).
func TestHintLog_ConcurrentAccess(t *testing.T) {
	l := NewHintLog(16)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				l.Add(Hint{Action: ActionStashDrop})
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_ = l.Recent(4)
			}
		}()
	}
	wg.Wait()
	if l.Len() != 16 {
		t.Fatalf("Len = %d, want 16", l.Len())
	}
	// 400 번 Add 했으므로 마지막 Seq 는 400 이다 — 경합으로 Seq 가 겹치면 안 된다.
	if last := l.Recent(1)[0].Seq; last != 400 {
		t.Fatalf("마지막 Seq = %d, want 400", last)
	}
}

// W12 (FR-GIT-93): Service 는 항상 hint 로그를 갖는다. 세션 동안 조회 가능해야 한다.
func TestServiceHints(t *testing.T) {
	s := New()
	if got := s.Hints(0); len(got) != 0 {
		t.Fatalf("초기 hints = %d 개", len(got))
	}
	h := s.AddHint(Hint{
		Repo:    "/r",
		Action:  ActionBranchDelete,
		Targets: []string{"feature"},
		Values:  []string{"1111111111111111111111111111111111111111"},
		Command: "git branch feature 1111111111111111111111111111111111111111",
	})
	if h.Seq != 1 {
		t.Fatalf("Seq = %d, want 1", h.Seq)
	}
	got := s.Hints(0)
	if len(got) != 1 || got[0].Command != h.Command {
		t.Fatalf("hints = %+v", got)
	}
}
