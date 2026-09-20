package run

import (
	"sync"
	"testing"
)

// SAFETY_CORRECTNESS_SRS 묶음 B (TC-SAF-3·4).
//
// 조회가 돌려준 `Record`/`Member` 는 **저장소의 내부를 공유하지 않는다.**
// 공유하면 두 가지가 한꺼번에 깨진다.
//
//  1. 호출자가 복사본이라 믿고 고친 것이 저장소에 닿는다.
//  2. 호출자가 잠금 **밖**에서 읽는 동안 저장소가 제자리 수정을 하면
//     데이터 레이스다 — `-race` 가 잡는다.
//
// 이 파일은 `store_messages.go:61` 이 `Messages` 에 대해 이미 적어 둔 처방을
// **나머지 참조 필드 넷**으로 넓힌다: `Record.Members` · `Record.Worktree` ·
// `Record.Coordinator` · `Member.Worktree` · `Member.FilesModified`.

// seedShared 는 참조 필드가 **전부 채워진** Run 하나를 만든다. 빈 필드는
// 공유될 것이 없어 이 검사를 통과시켜 버린다.
func seedShared(t *testing.T) (*Store, Record) {
	t.Helper()
	s := newTestStore(t, "epoch-share")
	rec, err := s.Start(StartOptions{
		Objective:         "공유 검사",
		Projection:        DedicatedWindow,
		Isolation:         IsolationNone,
		CoordinatorToolID: "coord",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := s.AddMember(rec.ID, MemberSpec{
		Role: "writer", Agent: "claude", ToolID: "tool-1", TabID: "tab-1",
		Worktree: &Worktree{Path: "/tmp/wt", Branch: "b1"},
	}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	// FilesModified 는 Report 로만 들어간다.
	if _, err := s.Report("tool-1", ReportSpec{
		RunID: rec.ID, Outcome: OutcomeSucceeded, Summary: "끝",
		FilesModified: []string{"a.go", "b.go"},
	}); err != nil {
		t.Fatalf("Report: %v", err)
	}
	cur, ok := s.Get(rec.ID)
	if !ok {
		t.Fatalf("Get: 방금 만든 Run 이 없다")
	}
	return s, cur
}

// TC-SAF-4 — Get 이 돌려준 Record 를 고쳐도 저장소가 바뀌지 않는다.
func TestStore_GetDoesNotShareInternals(t *testing.T) {
	s, got := seedShared(t)

	if len(got.Members) == 0 {
		t.Fatalf("멤버가 없다 — 검사의 전제가 깨졌다")
	}
	if got.Members[0].Worktree == nil {
		t.Fatalf("멤버의 Worktree 가 없다 — 검사의 전제가 깨졌다")
	}
	if len(got.Members[0].FilesModified) == 0 {
		t.Fatalf("FilesModified 가 비었다 — 검사의 전제가 깨졌다")
	}

	// 돌려받은 것을 호출자가 고친다. 복사본이라면 저장소는 그대로여야 한다.
	got.Members[0].Role = "무단수정"
	got.Members[0].Worktree.Branch = "무단수정"
	got.Members[0].FilesModified[0] = "무단수정"

	after, ok := s.Get(got.ID)
	if !ok {
		t.Fatalf("Get: Run 이 사라졌다")
	}
	if after.Members[0].Role != "writer" {
		t.Errorf("Members 배열이 공유된다: Role=%q (want writer)", after.Members[0].Role)
	}
	if after.Members[0].Worktree.Branch != "b1" {
		t.Errorf("Member.Worktree 포인터가 공유된다: Branch=%q (want b1)", after.Members[0].Worktree.Branch)
	}
	if after.Members[0].FilesModified[0] != "a.go" {
		t.Errorf("FilesModified 슬라이스가 공유된다: [0]=%q (want a.go)", after.Members[0].FilesModified[0])
	}
}

// TC-SAF-4b — Record 수준의 포인터 둘(Worktree·Coordinator)도 공유하지 않는다.
//
// 이 둘은 감사 보고서가 지목하지 못한 자리다 (`AUDIT-go-domain.md` 는
// `Members`·`Member.Worktree` 만 적었다). 타입을 직접 읽어 찾았다.
func TestStore_GetDoesNotShareRecordPointers(t *testing.T) {
	s := newTestStore(t, "epoch-ptr")
	rec, err := s.Start(StartOptions{
		Objective: "레코드 포인터", Projection: Inline, Isolation: IsolationNone,
		CoordinatorToolID: "coord",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// 조정자 관측을 하나 남겨 Coordinator 포인터를 채운다.
	if _, _, found := s.ObserveContext("coord",
		ContextObservation{Tokens: 100, HasTokens: true}, ContextPolicy{}); !found {
		t.Skip("ObserveContext 가 조정자를 찾지 못한다 — 이 검사의 전제가 아니다")
	}

	got, ok := s.Get(rec.ID)
	if !ok {
		t.Fatalf("Get: Run 이 없다")
	}
	if got.Coordinator == nil {
		t.Skip("Coordinator 가 nil — 이 검사의 전제가 아니다")
	}
	got.Coordinator.ContextTokens = -1

	after, _ := s.Get(rec.ID)
	if after.Coordinator != nil && after.Coordinator.ContextTokens == -1 {
		t.Errorf("Record.Coordinator 포인터가 공유된다")
	}
}

// TC-SAF-3 — 잠금 밖의 읽기와 저장소의 제자리 수정이 겹쳐도 레이스가 아니다.
//
// `-race` 로 돌 때만 뜻이 있다. `List()` 가 돌려준 배열을 읽는 동안
// `Report` 가 `&s.runs[ri].Members[mi]` 로 같은 배열을 고친다.
func TestStore_ListIsRaceFreeUnderConcurrentReport(t *testing.T) {
	s, rec := seedShared(t)
	if _, err := s.AddMember(rec.ID, MemberSpec{
		Role: "reader", Agent: "claude", ToolID: "tool-2", TabID: "tab-2",
	}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// 읽는 쪽 — 잠금 밖에서 Members 를 훑는다 (handlers_runs_peers.go:84 와 같은 모양).
	wg.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			for _, r := range s.List() {
				for _, m := range r.Members {
					_ = m.Role
					_ = m.State
					if m.Worktree != nil {
						_ = m.Worktree.Branch
					}
					for _, f := range m.FilesModified {
						_ = f
					}
				}
			}
		}
	})

	// 쓰는 쪽 — 제자리 수정을 반복한다.
	wg.Go(func() {
		for range 200 {
			_, _ = s.Report("tool-2", ReportSpec{
				RunID: rec.ID, Outcome: OutcomeSucceeded, Summary: "보고",
				FilesModified: []string{"c.go"},
			})
		}
		close(stop)
	})

	wg.Wait()
}
