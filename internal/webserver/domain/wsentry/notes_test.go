package wsentry

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// NOTES_LIVE_EXPLORER_SRS 묶음 N 의 서버측 (V-1·V-2·V-3·V-5).
//
// 메모 루트는 **파생값**이다 — 저장하지 않고 `NotesDir` 에서 매번 만든다. 그것이
// 홈(FR-EDT-17)과 같은 규약이며, 이 파일이 지키는 것은 그 파생이 Roots 에 닿는
// 경로 하나다: 닿지 않으면 메모 루트에 대한 모든 파일 조작이 루트 가드에 막힌다.

// V-1 (FR-NOT-1·2): Notes 는 NotesDir 를 정규화해 주고, 없으면 만든다.
func TestNotes_CreatesAndNormalizes(t *testing.T) {
	dir := t.TempDir()
	notes := filepath.Join(dir, "notes")
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	s.NotesDir = notes

	got, err := s.Notes()
	if err != nil {
		t.Fatalf("Notes: %v", err)
	}
	if want := NormalizePath(notes); got != want {
		t.Fatalf("Notes()=%q, want %q", got, want)
	}
	st, err := os.Stat(notes)
	if err != nil {
		t.Fatalf("메모 루트가 만들어지지 않았다: %v", err)
	}
	if !st.IsDir() {
		t.Fatal("메모 루트가 디렉터리가 아니다")
	}
}

// V-1: 이미 있으면 그대로 쓴다 — 내용이 지워지지 않는다.
func TestNotes_KeepsExistingContent(t *testing.T) {
	dir := t.TempDir()
	notes := filepath.Join(dir, "notes")
	if err := os.MkdirAll(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	memo := filepath.Join(notes, "a.md")
	if err := os.WriteFile(memo, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	s.NotesDir = notes

	if _, err := s.Notes(); err != nil {
		t.Fatalf("Notes: %v", err)
	}
	b, err := os.ReadFile(memo)
	if err != nil || string(b) != "hi" {
		t.Fatalf("메모가 보존되지 않았다: %q %v", b, err)
	}
}

// V-2 (FR-NOT-11): NotesDir 가 비면 메모 루트가 없다. Roots 는 그대로다 —
// 메모장 행 하나가 없을 뿐 Editor 표면 전체가 죽지 않는다.
func TestNotes_UnavailableWithoutDir(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	s, w, _ := newTestStore(t, home)
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":["/x"]}}`)

	if _, err := s.Notes(); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Notes err=%v, want ErrUnavailable", err)
	}
	roots, err := s.Roots()
	if err != nil {
		t.Fatalf("Roots: %v", err)
	}
	if want := []string{NormalizePath(home), "/x"}; !reflect.DeepEqual(roots, want) {
		t.Fatalf("Roots()=%v, want %v", roots, want)
	}
}

// V-3 (FR-NOT-4): Roots 는 [home, notes, ...list] 다. 이 순서가 곧 고정 행의
// 자리이자 파일 조작이 신뢰하는 루트의 전부다.
func TestRoots_IncludesNotesAfterHome(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	notes := filepath.Join(dir, "notes")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	s, w, _ := newTestStore(t, home)
	s.NotesDir = notes
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":["/x","/y"]}}`)

	roots, err := s.Roots()
	if err != nil {
		t.Fatalf("Roots: %v", err)
	}
	want := []string{NormalizePath(home), NormalizePath(notes), "/x", "/y"}
	if !reflect.DeepEqual(roots, want) {
		t.Fatalf("Roots()=%v, want %v", roots, want)
	}
}

// V-3: List 는 그대로다 — 메모 루트는 목록이 아니다 (FR-NOT-3·7).
func TestList_DoesNotContainNotes(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	notes := filepath.Join(dir, "notes")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	s, w, _ := newTestStore(t, home)
	s.NotesDir = notes
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":["/x"]}}`)

	_, list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !reflect.DeepEqual(list, []string{"/x"}) {
		t.Fatalf("List()=%v, want [/x]", list)
	}
}

// V-5 (FR-NOT-5): 메모 루트를 행으로 더하려 하면 오류가 아니라 무변경이다.
// 홈에 대한 규약(FR-EDT-16)과 같다 — 고정 행이 이미 대표한다.
func TestEditorAdd_NotesRootIsNoop(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	notes := filepath.Join(dir, "notes")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(notes, 0o755); err != nil {
		t.Fatal(err)
	}
	s, w, _ := newTestStore(t, home)
	s.NotesDir = notes
	w.raw = []byte(`{"schemaVersion":2}`)

	l, err := s.EditorAdd(t.Context(), notes)
	if err != nil {
		t.Fatalf("EditorAdd(notes): %v", err)
	}
	if len(l.Editors) != 0 {
		t.Fatalf("editors=%v, want 빈 목록", l.Editors)
	}
	if w.saves != 0 {
		t.Fatalf("saves=%d, want 0 — 무변경이면 저장도 없다", w.saves)
	}
}
