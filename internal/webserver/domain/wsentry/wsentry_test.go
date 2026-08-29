package wsentry

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"dongminal/internal/shared/workspace"
)

// ── fake ────────────────────────────────────────────
//
// gitapi 의 fakeWorkspaceStore 와 같은 동작을 유지한다 — 다르게 만들면 회귀와
// fake 결함을 구별할 수 없다.

type fakeWork struct {
	mu    sync.Mutex
	raw   []byte
	rev   uint64
	saves int
	// staleOnce 는 첫 Save 만 ErrStale 로 만든다 (V-EDT-15 의 1회 재시도).
	staleOnce bool
}

func (f *fakeWork) Snapshot() ([]byte, uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]byte(nil), f.raw...), f.rev
}

func (f *fakeWork) Save(blob []byte, _ string) (uint64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.staleOnce {
		f.staleOnce = false
		return 0, workspace.ErrStale
	}
	f.raw = append([]byte(nil), blob...)
	f.rev++
	f.saves++
	return f.rev, nil
}

type fakeBroker struct {
	mu   sync.Mutex
	sent [][]byte
}

func (f *fakeBroker) Broadcast(p []byte) int {
	f.mu.Lock()
	f.sent = append(f.sent, append([]byte(nil), p...))
	f.mu.Unlock()
	return 1
}

func (f *fakeBroker) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func newTestStore(t *testing.T, home string) (*Store, *fakeWork, *fakeBroker) {
	t.Helper()
	w := &fakeWork{}
	b := &fakeBroker{}
	return &Store{Work: w, Commands: b, HomeFn: func() (string, error) { return home, nil }}, w, b
}

func docOf(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("workspace 파싱: %v (%s)", err, raw)
	}
	return doc
}

// ── 영속 ────────────────────────────────────────────

// V-EDT-10 (FR-EDT-19·22): 추가·제거가 editors.list 에 반영되고 다른 키가 보존된다.
func TestEditorAddRemove_PersistsAndPreservesOtherKeys(t *testing.T) {
	dir := t.TempDir()
	s, w, _ := newTestStore(t, filepath.Join(dir, "home"))
	w.raw = []byte(`{"schemaVersion":2,"windows":[{"id":"w1"}],"activeWindow":"w1","git":{"pinned":["/p"],"drafts":{"a":"b"}}}`)

	target := filepath.Join(dir, "proj")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	norm := NormalizePath(target)

	l, err := s.EditorAdd(context.Background(), target)
	if err != nil {
		t.Fatalf("EditorAdd: %v", err)
	}
	if !reflect.DeepEqual(l.Editors, []string{norm}) {
		t.Fatalf("editors=%v", l.Editors)
	}
	doc := docOf(t, w.raw)
	if doc["schemaVersion"] != float64(2) || doc["activeWindow"] != "w1" {
		t.Fatalf("다른 키가 사라졌다: %v", doc)
	}
	g, _ := doc["git"].(map[string]any)
	if g == nil || g["drafts"] == nil {
		t.Fatalf("git 하위 키가 사라졌다: %v", doc["git"])
	}
	e, _ := doc["editors"].(map[string]any)
	if e == nil {
		t.Fatalf("editors 키가 없다: %s", w.raw)
	}
	if list, _ := e["list"].([]any); len(list) != 1 || list[0] != norm {
		t.Fatalf("editors.list=%v", e["list"])
	}

	if l, err = s.EditorRemove(norm); err != nil {
		t.Fatalf("EditorRemove: %v", err)
	}
	if len(l.Editors) != 0 {
		t.Fatalf("제거 후 editors=%v", l.Editors)
	}
	if pins := docOf(t, w.raw)["git"].(map[string]any)["pinned"].([]any); len(pins) != 1 {
		t.Fatalf("git.pinned 가 함께 지워졌다: %v", pins)
	}
}

// V-EDT-11 (FR-EDT-25): 같은 경로를 두 번 추가해도 목록이 그대로다.
func TestEditorAdd_Idempotent(t *testing.T) {
	dir := t.TempDir()
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	target := filepath.Join(dir, "proj")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		l, err := s.EditorAdd(context.Background(), target)
		if err != nil {
			t.Fatalf("%d번째 add: %v", i, err)
		}
		if len(l.Editors) != 1 {
			t.Fatalf("%d번째 add editors=%v", i, l.Editors)
		}
	}
}

// V-EDT-8 (FR-EDT-16): 홈 경로의 추가는 성공이되 목록을 바꾸지 않는다.
func TestEditorAdd_HomeSucceedsWithoutChangingList(t *testing.T) {
	dir := t.TempDir()
	home := filepath.Join(dir, "home")
	if err := os.Mkdir(home, 0o755); err != nil {
		t.Fatal(err)
	}
	s, w, _ := newTestStore(t, home)
	l, err := s.EditorAdd(context.Background(), home)
	if err != nil {
		t.Fatalf("홈 추가가 오류다: %v", err)
	}
	if len(l.Editors) != 0 {
		t.Fatalf("editors=%v", l.Editors)
	}
	if w.saves != 0 {
		t.Fatalf("목록이 안 변하는데 %d회 저장했다", w.saves)
	}
}

// FR-EDT-23: 존재하지 않거나 디렉터리가 아니면 거부한다.
func TestEditorAdd_RejectsMissingAndFile(t *testing.T) {
	dir := t.TempDir()
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	if _, err := s.EditorAdd(context.Background(), filepath.Join(dir, "nope")); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err=%v, want ErrNotFound", err)
	}
	f := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EditorAdd(context.Background(), f); !errors.Is(err, ErrNotDir) {
		t.Fatalf("err=%v, want ErrNotDir", err)
	}
	if _, err := s.EditorAdd(context.Background(), "rel/path"); !errors.Is(err, ErrNotAbsolute) {
		t.Fatalf("err=%v, want ErrNotAbsolute", err)
	}
}

// V-EDT-12 (FR-EDT-26): 사라진 디렉터리의 행도 제거된다 — 문자열 완전 일치.
func TestEditorRemove_StringMatchOnVanishedPath(t *testing.T) {
	s, w, _ := newTestStore(t, absHomeU)
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":["/gone/dir","/still/here"]}}`)
	l, err := s.EditorRemove("/gone/dir")
	if err != nil {
		t.Fatalf("EditorRemove: %v", err)
	}
	if !reflect.DeepEqual(l.Editors, []string{"/still/here"}) {
		t.Fatalf("editors=%v", l.Editors)
	}
}

// V-EDT-13 (FR-EDT-27): reorder 델타가 반영되고, 없는 src/target 은 배열을 바꾸지 않는다.
func TestEditorReorder_Delta(t *testing.T) {
	s, w, _ := newTestStore(t, absHomeU)
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":[` + qA + `,` + qB + `,` + qC + `]}}`)

	got, err := s.EditorReorder(absC, absA, true)
	if err != nil {
		t.Fatalf("reorder: %v", err)
	}
	if !reflect.DeepEqual(got, []string{absC, absA, absB}) {
		t.Fatalf("list=%v", got)
	}
	if got, err = s.EditorReorder("/zz", absA, true); err != nil || !reflect.DeepEqual(got, []string{absC, absA, absB}) {
		t.Fatalf("없는 src 가 배열을 바꿨다: %v (%v)", got, err)
	}
	// 목록에 없는 target 도 배열을 그대로 둔다 — 화면이 낡았다는 뜻이므로 src 와
	// 같은 근거다 (FR-EDT-27).
	if got, err = s.EditorReorder(absC, "/zz", true); err != nil || !reflect.DeepEqual(got, []string{absC, absA, absB}) {
		t.Fatalf("없는 target 이 배열을 바꿨다: %v (%v)", got, err)
	}
	// 빈 target 만 "맨 끝" 이다 — 목록 아래 빈 자리에 놓는 드롭이 그 값을 보낸다
	// (FR-EDT-111).
	if got, err = s.EditorReorder(absC, "", false); err != nil || !reflect.DeepEqual(got, []string{absA, absB, absC}) {
		t.Fatalf("빈 target 이 맨 끝이 아니다: %v (%v)", got, err)
	}
}

// V-EDT-14 (FR-EDT-30): editors 가 배열이 아니거나 항목이 문자열이 아니면 조용히 버린다.
func TestParse_DropsMalformedEditors(t *testing.T) {
	cases := []string{
		`{"schemaVersion":2,"editors":"nope"}`,
		`{"schemaVersion":2,"editors":{"list":"nope"}}`,
		`{"schemaVersion":2,"editors":{"list":[1,null,{"a":1},"/ok",""]}}`,
		`{"schemaVersion":2,"editors":[1,2]}`,
	}
	want := [][]string{{}, {}, {"/ok"}, {}}
	for i, raw := range cases {
		s, w, _ := newTestStore(t, absHomeU)
		w.raw = []byte(raw)
		_, list, err := s.List()
		if err != nil {
			t.Fatalf("[%d] List: %v", i, err)
		}
		if !reflect.DeepEqual(list, want[i]) {
			t.Fatalf("[%d] list=%v want=%v", i, list, want[i])
		}
	}
}

// V-EDT-93 (FR-EDT-30): blob 이 JSON `null` 이어도 패닉하지 않는다.
//
// json.Unmarshal 은 `null` 을 만나면 map 을 **nil 로 둔다** — 이어지는 쓰기가
// "assignment to entry in nil map" 으로 종단 전체를 죽인다. 읽기와 쓰기를 둘 다
// 태워야 그 자리가 실제로 막혔음을 안다.
func TestParse_NullBlobDoesNotPanic(t *testing.T) {
	for _, raw := range []string{"null", " null\n"} {
		s, w, _ := newTestStore(t, absHomeU)
		w.raw = []byte(raw)

		home, list, err := s.List()
		if err != nil {
			t.Fatalf("List(%q): %v", raw, err)
		}
		if home != absHomeU || len(list) != 0 {
			t.Fatalf("List(%q)=%q %v", raw, home, list)
		}
		// 쓰기 경로. 여기가 nil map 에 대입하는 자리다.
		l, err := s.Mutate(func(cur Lists) Lists {
			cur.Editors = append(cur.Editors, absX)
			return cur
		})
		if err != nil {
			t.Fatalf("Mutate(%q): %v", raw, err)
		}
		if !reflect.DeepEqual(l.Editors, []string{absX}) {
			t.Fatalf("editors=%v", l.Editors)
		}
		// schemaVersion 이 없는 블롭은 Save 가 거부한다 (FR-EM-2a) — 되살린 문서에
		// 그 키가 들어갔는지 함께 본다.
		if doc := docOf(t, w.raw); doc["schemaVersion"] != float64(2) {
			t.Fatalf("schemaVersion 이 없다: %s", w.raw)
		}
	}
}

// V-EDT-15 (FR-EDT-22): 낡은 rev 로 Save 하면 1회 재시도로 성공한다.
func TestMutate_RetriesOnceOnStale(t *testing.T) {
	s, w, b := newTestStore(t, absHomeU)
	w.raw = []byte(`{"schemaVersion":2}`)
	w.staleOnce = true
	l, err := s.Mutate(func(cur Lists) Lists {
		cur.Editors = append(cur.Editors, absX)
		return cur
	})
	if err != nil {
		t.Fatalf("재시도로 성공해야 한다: %v", err)
	}
	if len(l.Editors) != 1 {
		t.Fatalf("editors=%v", l.Editors)
	}
	if w.saves != 1 {
		t.Fatalf("saves=%d", w.saves)
	}
	if b.count() != 1 {
		t.Fatalf("브로드캐스트 %d건, want 1", b.count())
	}
}

func TestMutate_GivesUpAfterSecondStale(t *testing.T) {
	w := &alwaysStale{}
	s := &Store{Work: w, HomeFn: func() (string, error) { return absHomeU, nil }}
	// 목록을 **실제로 바꾸는** 변이여야 한다 — 무변경은 저장을 건너뛰므로
	// (FR-EDT-27) 재시도 경로에 도달하지 않는다.
	mut := func(c Lists) Lists { c.Editors = append(c.Editors, absA); return c }
	if _, err := s.Mutate(mut); !errors.Is(err, workspace.ErrStale) {
		t.Fatalf("err=%v, want ErrStale", err)
	}
	if w.tries != 2 {
		t.Fatalf("시도 %d회, want 2", w.tries)
	}
}

// FR-EDT-27·38a: 목록이 그대로면 저장도 브로드캐스트도 없다. rev 가 오르면
// `workspace_changed` 가 모든 브라우저에 나가 재조정을 돌린다 — 바뀐 것이
// 없는데 치를 비용이 아니다.
func TestMutate_NoopDoesNotSave(t *testing.T) {
	w := &fakeWork{raw: []byte(`{"schemaVersion":2,"editors":{"list":[` + qA + `,` + qB + `]}}`)}
	b := &fakeBroker{}
	s := &Store{Work: w, Commands: b, HomeFn: func() (string, error) { return absHomeU, nil }}

	// 목록에 없는 경로의 제거, 그리고 src 가 없는 재정렬 — 둘 다 무변경이다.
	if _, err := s.EditorRemove("/nope"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.EditorReorder("/nope", absA, true); err != nil {
		t.Fatal(err)
	}
	if w.saves != 0 {
		t.Fatalf("saves=%d, want 0", w.saves)
	}
	if b.count() != 0 {
		t.Fatalf("브로드캐스트 %d건, want 0", b.count())
	}

	// 대조군 — 실제로 바뀌면 한 번 저장된다.
	if _, err := s.EditorRemove(absA); err != nil {
		t.Fatal(err)
	}
	if w.saves != 1 {
		t.Fatalf("saves=%d, want 1", w.saves)
	}
}

type alwaysStale struct{ tries int }

func (a *alwaysStale) Snapshot() ([]byte, uint64) { return []byte(`{"schemaVersion":2}`), 0 }
func (a *alwaysStale) Save([]byte, string) (uint64, error) {
	a.tries++
	return 0, workspace.ErrStale
}

// V-EDT-22 (FR-EDT-35): 연동 변경이 workspace rev 를 한 번만 올린다 — 두 목록이
// 따로 저장되면 그 사이에 다른 브라우저가 절반만 반영된 상태를 본다.
func TestLinkedChange_BumpsRevOnce(t *testing.T) {
	dir := t.TempDir()
	s, w, b := newTestStore(t, filepath.Join(dir, "home"))
	target := filepath.Join(dir, "repo")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	s.RepoRoot = func(_ context.Context, p string) (string, error) { return p, nil }

	before := w.rev
	if _, err := s.EditorAdd(context.Background(), target); err != nil {
		t.Fatalf("EditorAdd: %v", err)
	}
	if w.rev != before+1 {
		t.Fatalf("rev 가 %d→%d 올랐다, want +1", before, w.rev)
	}
	if b.count() != 1 {
		t.Fatalf("브로드캐스트 %d건, want 1", b.count())
	}
	doc := docOf(t, w.raw)
	norm := NormalizePath(target)
	pins := doc["git"].(map[string]any)["pinned"].([]any)
	list := doc["editors"].(map[string]any)["list"].([]any)
	if len(pins) != 1 || pins[0] != norm || len(list) != 1 || list[0] != norm {
		t.Fatalf("한 번의 저장에 두 목록이 함께 담기지 않았다: %s", w.raw)
	}
}

// V-EDT-19·20 (FR-EDT-33): 저장소 루트만 핀이 생긴다.
func TestEditorAdd_PinsOnlyRepoRoot(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	sub := filepath.Join(repo, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	root := NormalizePath(repo)

	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	s.RepoRoot = func(context.Context, string) (string, error) { return repo, nil }

	l, err := s.EditorAdd(context.Background(), repo)
	if err != nil {
		t.Fatalf("EditorAdd: %v", err)
	}
	if len(l.Pinned) != 1 || l.Pinned[0] != root {
		t.Fatalf("pinned=%v", l.Pinned)
	}

	l, err = s.EditorAdd(context.Background(), sub)
	if err != nil {
		t.Fatalf("EditorAdd(sub): %v", err)
	}
	if len(l.Pinned) != 1 {
		t.Fatalf("루트가 아닌 경로가 핀을 만들었다: %v", l.Pinned)
	}
	if len(l.Editors) != 2 {
		t.Fatalf("editors=%v", l.Editors)
	}
}

// V-EDT-24 (FR-EDT-24, D-15): 심볼릭 링크 경로로 추가해도 핀과 짝이 맞는다.
// macOS 의 /tmp → /private/tmp 처럼 두 정규화가 갈리면 짝이 조용히 깨진다.
func TestEditorAdd_NormalizesSymlinkedPath(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("심볼릭 링크를 만들 수 없다: %v", err)
	}
	s, _, _ := newTestStore(t, filepath.Join(dir, "home"))
	// RepoRoot 는 링크를 푼 경로를 답한다 — git rev-parse 가 그렇게 답한다.
	s.RepoRoot = func(context.Context, string) (string, error) { return real, nil }

	l, err := s.EditorAdd(context.Background(), link)
	if err != nil {
		t.Fatalf("EditorAdd: %v", err)
	}
	want := NormalizePath(real)
	if len(l.Editors) != 1 || l.Editors[0] != want {
		t.Fatalf("editors=%v want=[%s]", l.Editors, want)
	}
	if len(l.Pinned) != 1 || l.Pinned[0] != want {
		t.Fatalf("pinned=%v want=[%s] — 짝이 어긋났다", l.Pinned, want)
	}
}

// FR-EDT-29: 목록 조회는 {home, list} 를 주고 home 은 list 에 없다.
func TestList_HomeIsNotInList(t *testing.T) {
	s, w, _ := newTestStore(t, absHomeU)
	w.raw = []byte(`{"schemaVersion":2,"editors":{"list":[` + qA + `]}}`)
	home, list, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if home != absHomeU {
		t.Fatalf("home=%q", home)
	}
	for _, p := range list {
		if p == home {
			t.Fatalf("home 이 list 에 있다: %v", list)
		}
	}
	roots, err := s.Roots()
	if err != nil {
		t.Fatalf("Roots: %v", err)
	}
	if !reflect.DeepEqual(roots, []string{absHomeU, absA}) {
		t.Fatalf("roots=%v", roots)
	}
}

// FR-EDT-24: 링크를 풀지 못하는(사라진) 경로는 Clean 만 한 값이 된다 — 사라진
// 저장소의 핀도 목록에 남아야 하기 때문이다.
func TestNormalizePath_FallsBackToCleanWhenMissing(t *testing.T) {
	if got := NormalizePath(filepath.Join(absNoSuchDir, "..", "dir")); got != absNoSuchDir {
		t.Fatalf("got=%q", got)
	}
}

func TestMutate_WithoutWorkspaceFails(t *testing.T) {
	s := &Store{}
	if _, err := s.Mutate(func(c Lists) Lists { return c }); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err=%v", err)
	}
}

// 빈 블롭에서 시작해도 Save 가 거부하지 않도록 schemaVersion 을 세운다 (FR-EM-2a).
func TestMutate_SeedsSchemaVersionOnEmptyBlob(t *testing.T) {
	s, w, _ := newTestStore(t, absHomeU)
	if _, err := s.Mutate(func(c Lists) Lists { c.Editors = []string{absA}; return c }); err != nil {
		t.Fatalf("Mutate: %v", err)
	}
	if !strings.Contains(string(w.raw), `"schemaVersion"`) {
		t.Fatalf("workspace=%s", w.raw)
	}
}
