package ext

import (
	"archive/tar"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
)

// TC-ATF-22 (FR-ATF-22 / AT-EXT-3): 팩 id 는 `.new` 로 끝날 수 없다 — 조달의 옆 자리
// (`<id>.new`)와 이름이 겹치면 `X` 의 조달이 팩 `X.new` 를 지운다.
func TestParseManifest_RejectsStagingSuffixID(t *testing.T) {
	for _, id := range []string{"x.new", "vscode.new"} {
		js := strings.Replace(packJSON, `"id": "vscode-langservers-extracted"`, `"id": "`+id+`"`, 1)
		if _, err := ParseManifest([]byte(js)); err == nil {
			t.Fatalf("id=%q 가 통과했다", id)
		}
	}
	js := strings.Replace(packJSON, `"id": "vscode-langservers-extracted"`, `"id": "x.newer"`, 1)
	if _, err := ParseManifest([]byte(js)); err != nil {
		t.Fatalf("id=x.newer 가 거절됐다: %v", err)
	}
}

func fetchInto(t *testing.T, entries []tarEntry, strip int) (root, dest string, err error) {
	t.Helper()
	root = t.TempDir()
	blob := makeTarGz(t, entries)
	dest = filepath.Join(root, "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: sum(blob), Strip: strip}
	err = FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest)
	return root, dest, err
}

// TC-ATF-20 (FR-ATF-20 / AT-EXT-1): 두 홉 링크(`b→c/..`, `a→b/..`)는 링크 문자열만
// 보면 칸 안이지만 따라가면 칸의 부모다. 그 뒤의 파일이 칸 밖에 쓰이지 않는다.
func TestFetchArchive_RejectsTwoHopLinkEscape(t *testing.T) {
	if !testpath.Symlinks() {
		t.Skip("이 호스트에서 심링크를 만들 수 없다")
	}
	root, _, err := fetchInto(t, []tarEntry{
		{name: "c/", typ: tar.TypeDir},
		{name: "b", typ: tar.TypeSymlink, link: "c/.."},
		{name: "a", typ: tar.TypeSymlink, link: "b/.."},
		{name: "a/evil", body: "x"},
	}, 0)
	if err == nil {
		t.Fatal("두 홉 링크 뒤의 파일이 통과했다 (FR-ATF-20)")
	}
	if _, e := os.Stat(filepath.Join(root, "evil")); e == nil {
		t.Fatal("격리 칸 밖에 파일이 쓰였다")
	}
}

// TC-ATF-20 (FR-ATF-20): 파일 엔트리가 앞서 놓인 링크를 거쳐 칸 밖을 덮지 않는다.
func TestFetchArchive_FileDoesNotFollowEscapingLink(t *testing.T) {
	if !testpath.Symlinks() {
		t.Skip("이 호스트에서 심링크를 만들 수 없다")
	}
	root, _, err := fetchInto(t, []tarEntry{
		{name: "c/", typ: tar.TypeDir},
		{name: "b", typ: tar.TypeSymlink, link: "c/.."},
		{name: "f", typ: tar.TypeSymlink, link: "b/../victim"},
		{name: "f", body: "x"},
	}, 0)
	if _, e := os.Stat(filepath.Join(root, "victim")); e == nil {
		t.Fatalf("링크를 따라 칸 밖에 파일이 쓰였다 (err=%v)", err)
	}
}

// TC-ATF-20 (FR-ATF-20 / AT-EXT-8): tar 하드링크는 strip 을 적용한 칸 안 대상을 복사한다.
func TestFetchArchive_HardlinkCopiesStrippedTarget(t *testing.T) {
	_, dest, err := fetchInto(t, []tarEntry{
		{name: "pkg/bin/real", body: "payload", mode: 0o755},
		{name: "pkg/bin/alias", typ: tar.TypeLink, link: "pkg/bin/real"},
	}, 1)
	if err != nil {
		t.Fatalf("조달이 실패했다: %v", err)
	}
	alias := filepath.Join(dest, "bin", "alias")
	fi, err := os.Lstat(alias)
	if err != nil {
		t.Fatalf("하드링크가 놓이지 않았다: %v", err)
	}
	if !fi.Mode().IsRegular() {
		t.Fatalf("하드링크가 보통 파일이 아니다: %v", fi.Mode())
	}
	if b, _ := os.ReadFile(alias); string(b) != "payload" {
		t.Fatalf("하드링크 내용 = %q", b)
	}
}

// TC-ATF-20 (FR-ATF-20): 하드링크 대상도 칸 안이어야 한다.
func TestFetchArchive_HardlinkRejectsEscapingTarget(t *testing.T) {
	if _, _, err := fetchInto(t, []tarEntry{
		{name: "alias", typ: tar.TypeLink, link: "../outside"},
	}, 0); err == nil {
		t.Fatal("칸 밖을 가리키는 하드링크가 통과했다")
	}
}
