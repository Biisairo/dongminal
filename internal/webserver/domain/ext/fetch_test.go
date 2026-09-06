package ext

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
)

type tarEntry struct {
	name string
	body string
	mode int64
	typ  byte
	link string
}

func makeTarGz(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		hdr := &tar.Header{Name: e.name, Mode: mode, Size: int64(len(e.body)), Typeflag: typ, Linkname: e.link}
		if typ != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeZip(t *testing.T, entries []tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		w, err := zw.Create(e.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// blobFetch 는 네트워크 대신 메모리를 준다. 조달의 판정을 남의 기계에 네트워크
// 없이 잴 수 있어야 한다 (§2.5 ③).
func blobFetch(blob []byte, err error) Fetch {
	return func(_ context.Context, _ string, w io.Writer) error {
		if err != nil {
			return err
		}
		_, e := w.Write(blob)
		return e
	}
}

// TC-EXT-40 (FR-EXT-11): 아카이브가 풀리고 앞 디렉터리가 벗겨진다.
//
// `strip` 이 필요한 이유는 공식 배포본들이 한 겹을 씌우기 때문이다 — 그것을 그대로
// 두면 선언의 `bin` 경로가 그 한 겹을 알아야 하고, 판이 바뀔 때마다 이름이 바뀐다.
func TestFetchArchive_ExtractsAndStrips(t *testing.T) {
	root := t.TempDir()
	blob := makeTarGz(t, []tarEntry{
		{name: "node-v1/bin/node", body: "#!/bin/sh\n", mode: 0o755},
		{name: "node-v1/README", body: "hi"},
	})
	dest := filepath.Join(root, "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: sum(blob), Strip: 1}

	if err := FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest); err != nil {
		t.Fatalf("조달이 실패했다: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "README")); err != nil || string(b) != "hi" {
		t.Fatalf("앞 디렉터리가 벗겨지지 않았다: %v %q", err, b)
	}
	exe := filepath.Join(dest, "bin", "node")
	if !isExecutable(exe) {
		t.Fatalf("실행 비트가 보존되지 않았다: %s", exe)
	}
}

// TC-EXT-41 (FR-EXT-15 / V-EXT-5): **해시가 어긋나면 풀지 않는다.**
//
// 네트워크에서 받은 것을 검증 없이 실행하지 않는다는 조항이며, 이것이 없으면
// 조달처가 바뀐 날 우리가 임의의 바이너리를 사용자 기계에서 돌린다.
func TestFetchArchive_RejectsChecksumMismatch(t *testing.T) {
	root := t.TempDir()
	blob := makeTarGz(t, []tarEntry{{name: "bin/node", body: "x", mode: 0o755}})
	dest := filepath.Join(root, "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: hex64}

	err := FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest)
	if err == nil {
		t.Fatal("해시가 어긋났는데 통과했다 (FR-EXT-15)")
	}
	if !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("사유가 해시를 말하지 않는다: %v", err)
	}
	// 실패한 조달은 **아무것도 남기지 않는다** — 반쯤 풀린 자리가 남으면 다음
	// 탐색이 그것을 서버로 삼는다.
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("실패한 조달이 자리를 남겼다: %v", err)
	}
}

// TC-EXT-42 (FR-EXT-39 / V-EXT-6): 아카이브가 격리 칸 밖에 쓰지 못한다.
//
// tar·zip 은 엔트리 이름으로 아무 경로나 적을 수 있다. 이 가드가 없으면 매니페스트
// 하나로 사용자 홈의 파일이 덮인다.
func TestFetchArchive_RejectsEscapingEntries(t *testing.T) {
	cases := []struct {
		name    string
		entries []tarEntry
	}{
		{"상위로", []tarEntry{{name: "../escaped", body: "x"}}},
		{"절대경로", []tarEntry{{name: "/etc/passwd", body: "x"}}},
		{"가운데로 파고드는", []tarEntry{{name: "a/../../escaped", body: "x"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			blob := makeTarGz(t, c.entries)
			dest := filepath.Join(root, "out")
			tg := Target{URL: "https://example.test/a.tar.gz", SHA256: sum(blob)}
			if err := FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest); err == nil {
				t.Fatal("격리 칸을 벗어나는 엔트리가 통과했다 (FR-EXT-39)")
			}
			if _, err := os.Stat(filepath.Join(root, "escaped")); err == nil {
				t.Fatal("격리 칸 밖에 파일이 쓰였다")
			}
		})
	}
}

// TC-EXT-43 (FR-EXT-39): 격리 칸 밖을 가리키는 링크도 막는다.
//
// 엔트리 **이름**만 보면 막지 못하는 갈래다 — 이름은 안쪽이고 가리키는 곳이 밖이다.
func TestFetchArchive_RejectsEscapingLinks(t *testing.T) {
	if !testpath.Symlinks() {
		t.Skip("이 호스트에서 심링크를 만들 수 없다")
	}
	root := t.TempDir()
	blob := makeTarGz(t, []tarEntry{
		{name: "inside", typ: tar.TypeSymlink, link: "../../outside"},
	})
	dest := filepath.Join(root, "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: sum(blob)}
	if err := FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest); err == nil {
		t.Fatal("칸 밖을 가리키는 링크가 통과했다 (FR-EXT-39)")
	}
}

// TC-EXT-44 (FR-EXT-11): zip 도 푼다 — Windows 의 공식 배포본이 zip 이다 (§2.2).
func TestFetchArchive_Zip(t *testing.T) {
	root := t.TempDir()
	blob := makeZip(t, []tarEntry{{name: "node-v1/node.exe", body: "MZ"}})
	dest := filepath.Join(root, "out")
	tg := Target{URL: "https://example.test/a.zip", SHA256: sum(blob), Strip: 1}

	if err := FetchArchive(context.Background(), blobFetch(blob, nil), tg, dest); err != nil {
		t.Fatalf("zip 이 풀리지 않았다: %v", err)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "node.exe")); err != nil || string(b) != "MZ" {
		t.Fatalf("zip 의 내용이 다르다: %v %q", err, b)
	}
}

// TC-EXT-45 (FR-EXT-18): 받지 못하면 사유가 남고 자리는 깨끗하다.
func TestFetchArchive_FetchFailure(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "out")
	tg := Target{URL: "https://example.test/a.tar.gz", SHA256: hex64}
	err := FetchArchive(context.Background(), blobFetch(nil, errors.New("연결 실패")), tg, dest)
	if err == nil {
		t.Fatal("받지 못했는데 성공했다")
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("실패한 조달이 자리를 남겼다")
	}
}

// TC-EXT-46 (FR-EXT-24): 다시 조달하면 옛 내용이 남지 않는다.
//
// 남으면 판이 섞이고, 그 섞임은 오류가 아니라 조용한 오동작으로 나타난다 (§2.5 ①).
func TestFetchArchive_ReplacesPrevious(t *testing.T) {
	root := t.TempDir()
	dest := filepath.Join(root, "out")
	old := makeTarGz(t, []tarEntry{{name: "old-file", body: "old"}})
	if err := FetchArchive(context.Background(), blobFetch(old, nil),
		Target{URL: "https://e.test/a.tar.gz", SHA256: sum(old)}, dest); err != nil {
		t.Fatal(err)
	}
	next := makeTarGz(t, []tarEntry{{name: "new-file", body: "new"}})
	if err := FetchArchive(context.Background(), blobFetch(next, nil),
		Target{URL: "https://e.test/b.tar.gz", SHA256: sum(next)}, dest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, "old-file")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("옛 판의 파일이 남았다 — 두 판이 섞인다")
	}
}
