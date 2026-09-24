package query

import (
	"context"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"golang.org/x/text/encoding/korean"
)

// REPO_FIX 03 §3A-3 — diff side 별 인코딩 디코드.

func TestDiffContent_DecodeAsPerSide(t *testing.T) {
	cp, err := korean.EUCKR.NewEncoder().String("한글 줄\n")
	if err != nil {
		t.Fatal(err)
	}
	repo := diffRepo(t)
	// 변환 저장 뒤: index 는 CP949, 작업 트리는 UTF-8.
	diffWrite(t, repo, "k.txt", "한글 줄\n")
	f := newDiffFake()
	f.blobs[":k.txt"] = cp
	dc, err := DiffContentOf(core.New(core.WithRunner(f.run)), context.Background(), repo, AxisWorktreeIndex, "k.txt", "")
	if err != nil {
		t.Fatal(err)
	}
	dc.DecodeAs("cp949")
	if dc.Original.Content != "한글 줄\n" || dc.Original.Encoding != "cp949" {
		t.Fatalf("index 쪽 = %+v", dc.Original)
	}
	if dc.Modified.Content != "한글 줄\n" || dc.Modified.Encoding != "utf-8" {
		t.Fatalf("작업 트리 쪽 = %+v", dc.Modified)
	}
	if dc.Original.Decodable == nil || !*dc.Original.Decodable {
		t.Fatal("decodable 이 없다")
	}
}

// UTF-16 BOM side 는 NUL 검사 전에 디코드한다. 진짜 이진은 그대로 binary.
func TestDiffContent_DecodeAsUTF16AndBinary(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "w.txt", string([]byte{0xFF, 0xFE, 'h', 0, 'i', 0}))
	f := newDiffFake()
	f.blobs[":w.txt"] = string([]byte{0x00, 0x01, 0x02, 0x03})
	dc, err := DiffContentOf(core.New(core.WithRunner(f.run)), context.Background(), repo, AxisWorktreeIndex, "w.txt", "")
	if err != nil {
		t.Fatal(err)
	}
	if dc.Modified.Kind != DiffKindBinary {
		t.Fatalf("파라미터 없으면 현행(binary): %+v", dc.Modified)
	}
	dc.DecodeAs("utf-16le")
	if dc.Modified.Kind != DiffKindText || dc.Modified.Content != "hi" || dc.Modified.Encoding != "utf-16le" {
		t.Fatalf("utf-16 side = %+v", dc.Modified)
	}
	if dc.Original.Kind != DiffKindBinary {
		t.Fatalf("이진 side 가 바뀌었다: %+v", dc.Original)
	}
}

// 어느 규칙으로도 풀리지 않으면 text + 치환 디코드 + decodable:false.
func TestDiffContent_DecodeAsUndecodable(t *testing.T) {
	repo := diffRepo(t)
	diffWrite(t, repo, "x.txt", string([]byte{0xFF, 0xFF, 0x80, 'a'}))
	f := newDiffFake()
	f.blobs[":x.txt"] = "a\n"
	dc, err := DiffContentOf(core.New(core.WithRunner(f.run)), context.Background(), repo, AxisWorktreeIndex, "x.txt", "")
	if err != nil {
		t.Fatal(err)
	}
	dc.DecodeAs("utf-8")
	if dc.Modified.Kind != DiffKindText || dc.Modified.Decodable == nil || *dc.Modified.Decodable {
		t.Fatalf("= %+v", dc.Modified)
	}
}
