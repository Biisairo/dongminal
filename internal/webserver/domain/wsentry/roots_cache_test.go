package wsentry

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-2 (DOM-25) — Roots 는 파일 API 요청마다 불린다. workspace
// rev 가 그대로면 파싱·정규화를 다시 하지 않는다. rev 가 바뀌면 다시 만든다.
func TestRoots_MemoizedByWorkspaceRev(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	real := filepath.Join(dir, "real")
	link := filepath.Join(dir, "link")
	for _, d := range []string{home, real} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	s, w, _ := newTestStore(t, home)
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":["` + link + `"]}}`)
	w.rev = 1

	got, err := s.Roots()
	if err != nil {
		t.Fatal(err)
	}
	// 정규화된 루트를 준다 — 호출자가 루트마다 EvalSymlinks 를 다시 하지 않는다.
	want := []string{NormalizePath(home), NormalizePath(real)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Roots = %v, want %v", got, want)
	}

	// 같은 rev 에서 바이트만 바뀐 것은 보지 않는다 — 기억은 rev 로 무효화된다.
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":["/elsewhere"]}}`)
	if again, _ := s.Roots(); !reflect.DeepEqual(again, want) {
		t.Fatalf("같은 rev 에서 다시 파싱했다: %v", again)
	}
	// 받은 쪽이 고쳐도 기억이 오염되지 않는다.
	got[0] = "/mutated"
	if again, _ := s.Roots(); again[0] != NormalizePath(home) {
		t.Fatalf("Roots 가 기억을 그대로 내준다: %v", again)
	}

	// 무효화 조건: rev.
	w.rev = 2
	if again, _ := s.Roots(); !reflect.DeepEqual(again, []string{NormalizePath(home), "/elsewhere"}) {
		t.Fatalf("rev 가 바뀌었는데 옛 목록이다: %v", again)
	}
}

// 메모 루트의 "없으면 만든다"(FR-NOT-1·2)는 기억과 무관하게 매번 지킨다.
func TestRoots_MemoStillEnsuresNotesDir(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	notes := filepath.Join(dir, "notes")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	s, _, _ := newTestStore(t, home)
	s.NotesDir = notes
	if _, err := s.Roots(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(notes); err != nil {
		t.Fatal(err)
	}
	roots, err := s.Roots()
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(notes); err != nil || !st.IsDir() {
		t.Fatalf("지워진 메모 루트를 다시 만들지 않았다: %v", err)
	}
	if len(roots) < 2 || roots[1] != NormalizePath(notes) {
		t.Fatalf("roots = %v", roots)
	}
}
