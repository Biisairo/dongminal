package run

import (
	"os"
	"path/filepath"
	"testing"
)

// `FBE-17`(PRODUCTION_ROADMAP §M3) — **저장이 실패하면 메모리를 되돌린다.**
//
// 변경은 메모리에 먼저 반영되고 그다음 저장한다. 저장이 실패하면 오류는 돌아가지만
// **메모리는 바뀐 채로 남아** `runs.json` 과 갈라진다. 그 뒤의 조회는 디스크에 없는
// Run 을 보여 주고, 재기동하면 사라진다.

// roStore 는 쓰기가 반드시 실패하는 저장소다 — 디렉터리를 읽기 전용으로 만든다.
func roStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s := NewStore(dir, "e1")
	if err := s.Load(); err != nil {
		t.Fatal(err)
	}
	return s
}

func freeze(t *testing.T, s *Store) {
	t.Helper()
	if err := os.Chmod(s.dir, 0o500); err != nil {
		t.Skipf("디렉터리를 읽기 전용으로 만들 수 없다: %v", err)
	}
	t.Cleanup(func() { os.Chmod(s.dir, 0o700) })
	// 이미 있는 파일은 지운다 — 남아 있으면 원자 쓰기가 임시 파일을 못 만들어도
	// 옛 파일이 읽히며, 이 검사가 재려는 것은 **쓰기 실패**다.
	os.Remove(filepath.Join(s.dir, fileName))
}

// 저장이 실패하면 그 변경이 메모리에도 남지 않는다.
func TestStartRollsBackOnSaveFailure(t *testing.T) {
	s := roStore(t)
	freeze(t, s)

	before := len(s.List())
	if _, err := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone}); err == nil {
		t.Fatal("쓰기가 실패해야 하는데 성공했다")
	}
	if got := len(s.List()); got != before {
		t.Fatalf("목록 길이=%d want %d — 저장이 실패했는데 메모리에 남았다 (FBE-17)", got, before)
	}
}

// 성공하면 그대로 남는다 (회귀).
func TestStartKeepsOnSuccess(t *testing.T) {
	s := roStore(t)
	if _, err := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone}); err != nil {
		t.Fatal(err)
	}
	if got := len(s.List()); got != 1 {
		t.Fatalf("목록 길이=%d want 1", got)
	}
}

// 되돌림은 **멤버까지** 간다. `Record` 만 얕게 복사하면 멤버는 같은 배열을
// 가리키므로, 제자리 수정이 복사본에도 그대로 보인다.
func TestRollbackIsDeepEnoughForMembers(t *testing.T) {
	s := roStore(t)
	rec, err := s.Start(StartOptions{Objective: "x", Projection: Background, Isolation: IsolationNone})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "worker", Agent: "claude", ToolID: "t1"}); err != nil {
		t.Fatal(err)
	}
	before := len(s.List()[0].Members)

	freeze(t, s)
	if _, err := s.AddMember(rec.ID, MemberSpec{Role: "worker", Agent: "codex", ToolID: "t2"}); err == nil {
		t.Fatal("쓰기가 실패해야 하는데 성공했다")
	}
	if got := len(s.List()[0].Members); got != before {
		t.Fatalf("멤버 수=%d want %d — 멤버가 되돌려지지 않았다", got, before)
	}
}
