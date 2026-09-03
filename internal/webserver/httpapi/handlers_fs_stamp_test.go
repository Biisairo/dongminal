package httpapi

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// NOTES_LIVE_EXPLORER_SRS 묶음 L 의 서버측 (V-7~V-12).
//
// 이 종단이 지키는 계약은 하나다 — **겹이 바뀌었는지만 값싸게 답한다.** 값의
// 뜻을 클라이언트가 해석하지 않으므로(FR-FSL-2) 여기서 검증하는 것은 "바뀌면
// 달라진다" 와 "루트 가드를 지난다" 둘이다.

// stampsOf 는 응답의 stamps 맵을 꺼낸다.
func stampsOf(t *testing.T, out map[string]any) map[string]string {
	t.Helper()
	raw, ok := out["stamps"].(map[string]any)
	if !ok {
		t.Fatalf("stamps 가 없다: %v", out)
	}
	got := map[string]string{}
	for k, v := range raw {
		s, ok := v.(string)
		if !ok {
			t.Fatalf("stamp 가 문자열이 아니다: %v", v)
		}
		got[k] = s
	}
	return got
}

func stampReq(t *testing.T, s *Server, root string, dirs []string) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(map[string]any{"root": root, "dirs": dirs})
	if err != nil {
		t.Fatal(err)
	}
	return fsReq(t, s, "POST", "/api/fs/stamp", string(b))
}

// V-7 (FR-FSL-1·2): 준 겹들의 스탬프를 돌려준다.
func TestFSStamp_ReturnsStampPerDir(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	seedRoot(t, ws, root)

	code, out := stampReq(t, srv, root, []string{root, sub})
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	got := stampsOf(t, out)
	if len(got) != 2 {
		t.Fatalf("stamps=%v, want 2개", got)
	}
	for _, d := range []string{root, sub} {
		if got[d] == "" {
			t.Fatalf("%s 의 스탬프가 없다: %v", d, got)
		}
	}
}

// V-8 (FR-FSL-2): 겹에 파일이 생기면 그 겹의 스탬프가 달라진다. 이것이 성립하지
// 않으면 묶음 L 전체가 아무것도 감지하지 못한다.
func TestFSStamp_ChangesWhenEntryAdded(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)

	_, out := stampReq(t, srv, root, []string{root})
	before := stampsOf(t, out)[root]

	// mtime 의 해상도가 초 단위인 파일시스템이 있다 (R-1). 시계를 기다리는 대신
	// 디렉터리의 mtime 을 명시적으로 앞당겨 결정론을 지킨다 — 검증하는 것은
	// "mtime 이 스탬프에 반영되는가" 이지 파일시스템의 해상도가 아니다.
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(root, st.ModTime(), st.ModTime().Add(2_000_000_000)); err != nil {
		t.Fatal(err)
	}

	_, out2 := stampReq(t, srv, root, []string{root})
	if after := stampsOf(t, out2)[root]; after == before {
		t.Fatalf("스탬프가 그대로다: %q", after)
	}
}

// V-9 (FR-FSL-3): 없는 겹은 응답에서 빠지고 나머지는 그대로 온다. 한 겹의
// 실패가 나머지 겹의 답을 막지 않는다.
func TestFSStamp_SkipsMissingDirs(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)
	gone := filepath.Join(root, "gone")

	code, out := stampReq(t, srv, root, []string{root, gone})
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	got := stampsOf(t, out)
	if _, ok := got[gone]; ok {
		t.Fatalf("사라진 겹이 실렸다: %v", got)
	}
	if got[root] == "" {
		t.Fatalf("남은 겹이 빠졌다: %v", got)
	}
}

// V-9: 파일은 겹이 아니다 — 빠진다.
func TestFSStamp_SkipsNonDir(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)
	f := filepath.Join(root, "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, out := stampReq(t, srv, root, []string{root, f})
	if _, ok := stampsOf(t, out)[f]; ok {
		t.Fatal("파일이 겹으로 실렸다")
	}
}

// V-10 (FR-FSL-4): 루트 가드는 조회·조작과 같다. 목록에 없는 루트는 거부된다.
func TestFSStamp_RejectsUnknownRoot(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)

	code, out := stampReq(t, srv, t.TempDir(), []string{root})
	if code != 400 && code != 403 {
		t.Fatalf("code=%d out=%v — 목록에 없는 루트는 거부되어야 한다", code, out)
	}
	if out["code"] != "outside_root" {
		t.Fatalf("code=%v, want outside_root", out["code"])
	}
}

// V-11 (FR-FSL-4): 루트 **밖**의 겹은 응답에서 빠진다. 루트를 지났다고 그 아래가
// 아닌 경로까지 답하면 가드가 무의미해진다.
func TestFSStamp_SkipsDirsOutsideRoot(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	outside := t.TempDir()
	seedRoot(t, ws, root)

	_, out := stampReq(t, srv, root, []string{root, outside})
	got := stampsOf(t, out)
	if _, ok := got[outside]; ok {
		t.Fatalf("루트 밖의 겹이 실렸다: %v", got)
	}
	if got[root] == "" {
		t.Fatalf("루트가 빠졌다: %v", got)
	}
}

// V-12 (FR-FSL-5): dirs 의 개수 상한. 한 요청이 서버에서 무한정 stat 하지 않는다.
func TestFSStamp_RejectsTooManyDirs(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)

	dirs := make([]string, fsStampMax+1)
	for i := range dirs {
		dirs[i] = root
	}
	code, out := stampReq(t, srv, root, dirs)
	if code != 400 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if out["code"] != "bad_request" {
		t.Fatalf("code=%v, want bad_request", out["code"])
	}
}

// FR-FSL-3: 빈 dirs 는 오류가 아니라 빈 답이다 — 물을 것이 없으면 답도 없다
// (`/api/fs/ignored` 의 빈 names 와 같은 규약).
func TestFSStamp_EmptyDirsIsEmptyAnswer(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)

	code, out := stampReq(t, srv, root, nil)
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if got := stampsOf(t, out); len(got) != 0 {
		t.Fatalf("stamps=%v, want 빈 맵", got)
	}
}

// FR-FSL-10: 조회 응답도 그 겹의 스탬프를 싣고, 그 값이 stamp 종단의 것과
// **같다.** 갈라지면 클라이언트가 조회로 기억한 값과 폴링으로 견주는 값이 매번
// 달라 목록을 끝없이 다시 읽는다.
func TestFSList_CarriesSameStampAsStampEndpoint(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)

	code, out := fsReq(t, srv, "GET",
		fmt.Sprintf("/api/fs/list?root=%s&path=%s", pathQ(root), pathQ(root)), "")
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	fromList, ok := out["stamp"].(string)
	if !ok || fromList == "" {
		t.Fatalf("list 응답에 stamp 가 없다: %v", out)
	}
	_, st := stampReq(t, srv, root, []string{root})
	if fromStamp := stampsOf(t, st)[root]; fromStamp != fromList {
		t.Fatalf("stamp 가 갈렸다: list=%q stamp=%q", fromList, fromStamp)
	}
}

// ── 묶음 N 의 종단측 (V-4·V-6) ──

// V-4 (FR-NOT-3): /api/editors 응답에 notes 가 있다.
func TestEditorsGet_IncludesNotes(t *testing.T) {
	srv, _, _ := fsTestServer(t)

	code, out := fsReq(t, srv, "GET", "/api/editors", "")
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	notes, ok := out["notes"].(string)
	if !ok || notes == "" {
		t.Fatalf("notes 가 없다: %v", out)
	}
	if !strings.HasSuffix(notes, string(filepath.Separator)+"notes") {
		t.Fatalf("notes=%q — DataDir 아래 notes 여야 한다", notes)
	}
	st, err := os.Stat(notes)
	if err != nil || !st.IsDir() {
		t.Fatalf("메모 루트가 만들어지지 않았다: %v", err)
	}
	// FR-NOT-3·7: 목록에 들어 있지 않다.
	if list, ok := out["list"].([]any); ok {
		for _, p := range list {
			if p == notes {
				t.Fatal("메모 루트가 list 에도 있다")
			}
		}
	}
}

// V-6 (FR-NOT-4): 메모 루트를 root 로 준 조회가 루트 가드를 통과한다. 이것이
// 메모장의 파일 조작 전부를 여는 한 줄이다.
func TestFSList_AcceptsNotesRoot(t *testing.T) {
	srv, _, _ := fsTestServer(t)

	_, ed := fsReq(t, srv, "GET", "/api/editors", "")
	notes, _ := ed["notes"].(string)
	if notes == "" {
		t.Fatalf("notes 가 없다: %v", ed)
	}
	if err := os.WriteFile(filepath.Join(notes, "memo.md"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	code, out := fsReq(t, srv, "GET",
		fmt.Sprintf("/api/fs/list?root=%s&path=%s", pathQ(notes), pathQ(notes)), "")
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if names := entryNames(t, out); len(names) != 1 || names[0] != "memo.md" {
		t.Fatalf("entries=%v, want [memo.md]", names)
	}
}

// V-6: 스탬프도 메모 루트에서 돈다 — git 저장소가 아니어도 목록은 따라간다
// (FR-FSL-13).
func TestFSStamp_WorksOnNotesRoot(t *testing.T) {
	srv, _, _ := fsTestServer(t)

	_, ed := fsReq(t, srv, "GET", "/api/editors", "")
	notes, _ := ed["notes"].(string)
	if notes == "" {
		t.Fatalf("notes 가 없다: %v", ed)
	}
	code, out := stampReq(t, srv, notes, []string{notes})
	if code != 200 {
		t.Fatalf("code=%d out=%v", code, out)
	}
	if stampsOf(t, out)[notes] == "" {
		t.Fatalf("메모 루트의 스탬프가 없다: %v", out)
	}
}

// tempdir 경로에 공백·비ASCII 가 섞여도 질의가 깨지지 않게 한다.
func pathQ(p string) string { return url.QueryEscape(p) }
