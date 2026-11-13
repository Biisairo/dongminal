package claudeacct

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TC-CAC-18: 경로 정규화, 해석 순서, 삭제된 계정 무시, 탭 지정 정리.

func TestNormalizeFolder(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(filepath.Join(real, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("symlink 를 만들 수 없다")
	}
	want, _ := filepath.EvalSymlinks(real)
	for _, in := range []string{real, real + string(filepath.Separator), link, filepath.Join(link, "sub", "..")} {
		got, err := NormalizeFolder(in, false)
		if err != nil || got != want {
			t.Errorf("NormalizeFolder(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	// 없는 경로도 받는다 — 있는 가장 가까운 상위까지만 링크를 푼다.
	missing := filepath.Join(link, "nope", "x") + string(filepath.Separator)
	if got, err := NormalizeFolder(missing, false); err != nil || got != filepath.Join(want, "nope", "x") {
		t.Errorf("missing: %q %v", got, err)
	}
	if _, err := NormalizeFolder("rel/dir", false); !errors.Is(err, ErrInvalid) {
		t.Errorf("relative: %v", err)
	}
	if _, err := NormalizeFolder("", false); !errors.Is(err, ErrInvalid) {
		t.Errorf("empty: %v", err)
	}
	// Windows 는 대소문자를 구분하지 않는다.
	if got, _ := NormalizeFolder(filepath.Join(root, "nope", "ABC"), true); got != filepath.Join(lowerPath(root), "nope", "abc") {
		t.Errorf("fold: %q", got)
	}
}

func lowerPath(p string) string {
	got, _ := NormalizeFolder(p, true)
	return got
}

func TestResolveOrder(t *testing.T) {
	e := twoAccounts(t)
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	deep := filepath.Join(repo, "pkg", "x")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	// 연결이 없으면 none.
	r, err := e.svc.Resolve("t1", deep)
	if err != nil || r.Source != SourceNone || r.AccountID != "" || r.ConfigDir != "" {
		t.Fatalf("none: %+v %v", r, err)
	}
	if err := e.svc.SetFolder(root, "id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetFolder(repo, "id2"); err != nil {
		t.Fatal(err)
	}
	// 가장 가까운 상위가 이긴다.
	r, _ = e.svc.Resolve("", deep)
	if r.Source != SourceFolder || r.AccountID != "id2" || r.ConfigDir != e.svc.ProfileDir("id2") {
		t.Fatalf("folder: %+v", r)
	}
	wantRepo, _ := NormalizeFolder(repo, false)
	if r.Folder != wantRepo {
		t.Fatalf("folder path: %q", r.Folder)
	}
	// 이름이 앞부분만 같은 형제 폴더는 상위가 아니다.
	sib := filepath.Join(root, "repo-other")
	r, _ = e.svc.Resolve("", sib)
	if r.AccountID != "id1" {
		t.Fatalf("sibling: %+v", r)
	}
	// 탭 지정이 폴더보다 앞선다.
	if err := e.svc.SetTab("t1", "id1"); err != nil {
		t.Fatal(err)
	}
	r, _ = e.svc.Resolve("t1", deep)
	if r.Source != SourceTab || r.AccountID != "id1" {
		t.Fatalf("tab: %+v", r)
	}
	// 다른 탭은 폴더 연결을 따른다.
	r, _ = e.svc.Resolve("t2", deep)
	if r.AccountID != "id2" {
		t.Fatalf("other tab: %+v", r)
	}
	if _, err := e.svc.Resolve("t1", "relative"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("relative cwd: %v", err)
	}
}

// FR-CAC-88a · D-CAC-30: 답의 path 는 cwd 를 매핑 키와 같은 규칙으로 정규화한 값이다 — 계정이 없어도 싣는다.
func TestResolveCarriesNormalizedPath(t *testing.T) {
	e := twoAccounts(t)
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skip("심볼릭 링크를 만들 수 없다:", err)
	}
	want, _ := NormalizeFolder(real, foldCase)
	r, err := e.svc.Resolve("", link+string(filepath.Separator))
	if err != nil || r.Path != want || r.Source != SourceNone {
		t.Fatalf("none: %+v %v (want path %q)", r, err, want)
	}
	if err := e.svc.SetFolder(real, "id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetTab("t1", "id2"); err != nil {
		t.Fatal(err)
	}
	r, _ = e.svc.Resolve("", link)
	if r.Path != want || r.Folder != want {
		t.Fatalf("folder: %+v", r)
	}
	r, _ = e.svc.Resolve("t1", link)
	if r.Path != want || r.Source != SourceTab {
		t.Fatalf("tab: %+v", r)
	}
}

func TestResolveIgnoresDeletedAccount(t *testing.T) {
	e := twoAccounts(t)
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := e.svc.SetFolder(root, "id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetFolder(repo, "id2"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetTab("t1", "id2"); err != nil {
		t.Fatal(err)
	}
	// 저장소만 지운 것처럼: 매핑이 남아 있어도 없는 계정이면 건너뛴다.
	if err := e.svc.Store.Update(func(st *State) error {
		st.Accounts = st.Accounts[:1]
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	r, _ := e.svc.Resolve("t1", repo)
	if r.Source != SourceFolder || r.AccountID != "id1" {
		t.Fatalf("%+v", r)
	}
}

func TestSetMappingValidation(t *testing.T) {
	e := twoAccounts(t)
	dir := t.TempDir()
	if err := e.svc.SetFolder(dir, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
	if err := e.svc.SetFolder("rel", "id1"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("relative: %v", err)
	}
	if err := e.svc.SetTab("", "id1"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("empty tool: %v", err)
	}
	if err := e.svc.SetFolder(dir, "id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetTab("t1", "id1"); err != nil {
		t.Fatal(err)
	}
	// 빈 계정은 지운다.
	if err := e.svc.SetFolder(dir+string(filepath.Separator), ""); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetTab("t1", ""); err != nil {
		t.Fatal(err)
	}
	m, err := e.svc.Mappings()
	if err != nil || len(m.Folders) != 0 || len(m.Tabs) != 0 {
		t.Fatalf("%+v %v", m, err)
	}
	st, err := os.Stat(filepath.Join(e.data, mappingsFile))
	if err != nil || st.Mode().Perm() != fileMode {
		t.Fatalf("mappings file: %v %v", st, err)
	}
}

// FR-CAC-81a: 살아 있지 않은 도구의 지정만 지운다.
func TestPruneTabs(t *testing.T) {
	e := twoAccounts(t)
	for _, id := range []string{"t1", "t2"} {
		if err := e.svc.SetTab(id, "id1"); err != nil {
			t.Fatal(err)
		}
	}
	changed, err := e.svc.PruneTabs(func(id string) bool { return id == "t1" })
	if err != nil || !changed {
		t.Fatalf("%v %v", changed, err)
	}
	m, _ := e.svc.Mappings()
	if _, ok := m.Tabs["t1"]; !ok || len(m.Tabs) != 1 {
		t.Fatalf("%+v", m.Tabs)
	}
	changed, _ = e.svc.PruneTabs(func(string) bool { return true })
	if changed {
		t.Fatal("nothing to prune")
	}
}

// FR-CAC-12: 삭제는 그 계정을 가리키는 매핑·탭 지정·프로필을 지운다.
func TestRemoveDropsMappingsAndProfile(t *testing.T) {
	e := twoAccounts(t)
	dir := t.TempDir()
	if err := e.svc.SetFolder(dir, "id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetTab("t1", "id1"); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.SetTab("t2", "id2"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.PrepareProfile("id1"); err != nil {
		t.Fatal(err)
	}
	pdir := e.svc.ProfileDir("id1")
	svc := ProfileClaudePaths(pdir).KeychainService
	if _, ok, _ := e.sec.Get(svc, e.sec.Account()); !ok {
		t.Fatal("profile keychain item")
	}
	if err := e.svc.Remove("id1"); err != nil {
		t.Fatal(err)
	}
	m, _ := e.svc.Mappings()
	if len(m.Folders) != 0 || len(m.Tabs) != 1 || m.Tabs["t2"].AccountID != "id2" {
		t.Fatalf("%+v", m)
	}
	if _, err := os.Stat(pdir); !os.IsNotExist(err) {
		t.Fatal("profile dir removed")
	}
	if _, ok, _ := e.sec.Get(svc, e.sec.Account()); ok {
		t.Fatal("profile keychain item removed")
	}
}
