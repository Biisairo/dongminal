package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// RECONNECT_STORM_SRS 묶음 L — 로그 크기 상한. 검증 V-LOG-1~5.

func writeLog(t *testing.T, path string, n int) {
	t.Helper()
	if err := os.WriteFile(path, bytes.Repeat([]byte("x"), n), 0o644); err != nil {
		t.Fatal(err)
	}
}

func sizeOf(t *testing.T, path string) int64 {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st.Size()
}

// V-LOG-1: 상한 아래면 손대지 않는다 (FR-LOG-1).
func TestCapLogLeavesSmallFileAlone(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "dongminal.log")
	writeLog(t, p, 100)

	if err := capLog(p, 1000, 400); err != nil {
		t.Fatalf("capLog: %v", err)
	}
	if got := sizeOf(t, p); got != 100 {
		t.Fatalf("크기 = %d, want 100 — 상한 아래인데 손댔다", got)
	}
	if _, err := os.Stat(p + ".1"); err == nil {
		t.Fatal(".1 이 생겼다 — 상한 아래에서는 아무 것도 하지 않아야 한다")
	}
}

// V-LOG-2: 상한을 넘으면 줄어들고, **같은 파일**이다 (FR-LOG-1·3).
//
// inode 를 보는 이유가 핵심이다. 이름을 바꿔 새 파일을 만들면 서버의 fd 는 옛
// inode 를 계속 가리켜 새 로그가 영영 비어 있게 된다.
func TestCapLogTruncatesInPlace(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "dongminal.log")
	writeLog(t, p, 5000)
	before, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}

	if err := capLog(p, 1000, 400); err != nil {
		t.Fatalf("capLog: %v", err)
	}
	after, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if after.Size() != 0 {
		t.Fatalf("본체 크기 = %d, want 0", after.Size())
	}
	if !os.SameFile(before, after) {
		t.Fatal("파일이 바뀌었다 — 자르기가 아니라 갈아치웠다 (FR-LOG-3 위반)")
	}
}

// V-LOG-3: 최근 기록이 `.1` 로 남는다 (FR-LOG-2). 사고 직후에 필요한 것이 그
// 직전 기록이다.
func TestCapLogKeepsRecentTail(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "dongminal.log")
	// 앞은 'a', 끝 400바이트는 'b' — 남은 것이 **끝**인지 앞인지 가른다.
	body := append(bytes.Repeat([]byte("a"), 4600), bytes.Repeat([]byte("b"), 400)...)
	if err := os.WriteFile(p, body, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := capLog(p, 1000, 400); err != nil {
		t.Fatalf("capLog: %v", err)
	}
	kept, err := os.ReadFile(p + ".1")
	if err != nil {
		t.Fatalf(".1 이 없다: %v", err)
	}
	if len(kept) != 400 {
		t.Fatalf(".1 크기 = %d, want 400", len(kept))
	}
	if !bytes.Equal(kept, bytes.Repeat([]byte("b"), 400)) {
		t.Fatal(".1 에 남은 것이 끝부분이 아니다 — FR-LOG-2 위반")
	}
}

// V-LOG-4: 자르기 뒤 O_APPEND fd 의 다음 쓰기가 이어진다 (FR-LOG-3).
// 서버의 stdout·stderr 가 바로 그 fd 다.
func TestCapLogKeepsAppendFDWriting(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "dongminal.log")
	writeLog(t, p, 5000)

	// 서버와 같은 방식으로 연 fd 를 흉내낸다.
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	if err := capLog(p, 1000, 400); err != nil {
		t.Fatalf("capLog: %v", err)
	}
	if _, err := f.WriteString("after\n"); err != nil {
		t.Fatalf("자르기 뒤 쓰기 실패: %v", err)
	}
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "after\n" {
		t.Fatalf("자르기 뒤 내용 = %q, want %q — fd 가 이어 쓰지 못했다", got, "after\n")
	}
}

// V-LOG-5: 없는 경로·빈 경로는 조용히 no-op 이다 (FR-LOG-4).
// 로그 위생 때문에 서버가 서지 않아서는 안 된다.
func TestCapLogIsQuietOnMissingPath(t *testing.T) {
	dir := t.TempDir()
	for _, p := range []string{"", filepath.Join(dir, "nope.log"), dir} {
		if err := capLog(p, 1000, 400); err != nil {
			t.Fatalf("path=%q 에서 오류가 났다: %v — FR-LOG-4 위반", p, err)
		}
	}
}

// 상한을 되풀이해 넘겨도 `.1` 은 하나이고 최신으로 갈린다.
func TestCapLogReplacesPreviousKeep(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "dongminal.log")

	writeLog(t, p, 5000)
	if err := capLog(p, 1000, 400); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, bytes.Repeat([]byte("z"), 5000), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := capLog(p, 1000, 400); err != nil {
		t.Fatal(err)
	}
	kept, err := os.ReadFile(p + ".1")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(kept, bytes.Repeat([]byte("z"), 400)) {
		t.Fatal(".1 이 최신 기록으로 갈리지 않았다")
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(ents) != 2 {
		t.Fatalf("디렉터리 항목 %d개 — 로그와 .1 둘뿐이어야 한다", len(ents))
	}
}
