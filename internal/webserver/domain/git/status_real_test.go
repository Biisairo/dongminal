package git

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// 실제 git 으로 porcelain v2 의 필드 배치를 고정한다. 단위 테스트의 픽스처는
// 내가 믿는 형식일 뿐이므로, git 이 형식을 바꾸면 여기서 먼저 깨져야 한다.
func TestServiceStatus_RealGit(t *testing.T) {
	repo := tempRepo(t)
	write := func(rel, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(repo, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("un tracked.txt", "u\n")
	if err := os.MkdirAll(filepath.Join(repo, "d ir"), 0o755); err != nil {
		t.Fatal(err)
	}
	write("d ir/한글 파일.txt", "k\n")
	gitIn(t, repo, "add", "d ir")
	gitIn(t, repo, "mv", "README.md", "RE ADME.md")
	write("RE ADME.md", "changed\n")

	st, err := New().Status(context.Background(), repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Branch != "main" || st.Detached || st.Initial || st.HasUpstream {
		t.Fatalf("헤더 = %+v", st)
	}
	if len(st.Oid) != 40 {
		t.Fatalf("Oid = %q", st.Oid)
	}
	// rename 은 스테이징돼 있고 작업 트리에서 또 고쳐졌다 → 양쪽에 든다.
	byPath := map[string]FileEntry{}
	for _, e := range append(append([]FileEntry{}, st.Staged...), st.Changes...) {
		byPath[e.Path] = e
	}
	ren, ok := byPath["RE ADME.md"]
	if !ok || ren.OrigPath != "README.md" || ren.Score != 100 {
		t.Fatalf("rename = %+v (전체 %v)", ren, byPath)
	}
	if _, ok := byPath["d ir/한글 파일.txt"]; !ok {
		t.Fatalf("유니코드 경로가 없다: %v", byPath)
	}
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "un tracked.txt" {
		t.Fatalf("Untracked = %+v", st.Untracked)
	}
	// 서로 다른 경로는 rename·추가·untracked 셋이다. rename 이 두 그룹에 들어도
	// 배지는 3 이어야 한다.
	if st.Total != 3 {
		t.Fatalf("Total = %d, want 3", st.Total)
	}
}
