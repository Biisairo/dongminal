package platform

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// RECONNECT_STORM_SRS 묶음 A. 헬퍼 설치는 목적 경로를 한 순간도 비우지 않는다
// (FR-ATI-1). 이 파일의 검사는 전부 "설치가 도는 동안 dst 를 고빈도로 들여다본
// 관찰자가 무엇을 보았는가"로 판정한다 — 구현이 remove→create 로 되어 있으면
// 관찰자가 소실을 본다.

// canReplaceOpenFile 은 이 호스트가 **열려 있는 파일을 대체할 수 있는가**를
// 실제로 해 보고 답한다. POSIX 는 할 수 있다. Windows 는 읽기 핸들이
// FILE_SHARE_DELETE 없이 열려 있으면 할 수 없고(Go 의 os.Open 이 그렇다),
// 그러면 **관찰자가 복사 자체를 실패시킨다** — 관찰 대상을 관찰이 망가뜨린다.
//
// runtime.GOOS 로 가르지 않는 이유는 저장소의 규약이다 (testpath 패키지 머리말)
// — OS 이름으로 가르면 대상이 늘 때마다 갈래가 는다. 능력을 직접 물으면 갈래는
// 언제나 하나다.
func canReplaceOpenFile(t *testing.T) bool {
	t.Helper()
	dir := t.TempDir()
	a := filepath.Join(dir, "a")
	b := filepath.Join(dir, "b")
	if err := os.WriteFile(a, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b, []byte("b"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(a)
	if err != nil {
		return false
	}
	defer f.Close()
	return os.Rename(b, a) == nil
}

// watchDst 는 stop 이 닫힐 때까지 path 를 Lstat 하며 소실 횟수를 센다.
// 반환된 함수를 부르면 감시를 멈추고 소실 횟수를 돌려준다.
func watchDst(path string) (stop func() int) {
	done := make(chan struct{})
	var wg sync.WaitGroup
	misses := 0
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			if _, err := os.Lstat(path); err != nil && os.IsNotExist(err) {
				misses++
			}
		}
	}()
	return func() int {
		close(done)
		wg.Wait()
		return misses
	}
}

// V-ATI-1·2: 대상이 바뀌는 재설치를 반복하는 동안 dst 는 항상 존재한다.
// 대상을 번갈아 주는 이유는 FR-ATI-3 의 no-op 로 빠지지 않게 하려는 것이다 —
// 같은 대상이면 아무 일도 일어나지 않아 이 검사가 공회전한다.
func TestLinkOrCopyNeverLeavesDestinationMissing(t *testing.T) {
	dir := t.TempDir()
	srcA := filepath.Join(dir, "srcA")
	srcB := filepath.Join(dir, "srcB")
	dst := filepath.Join(dir, "dmctl")
	for _, s := range []string{srcA, srcB} {
		if err := os.WriteFile(s, []byte(filepath.Base(s)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	p := Current().Paths
	if err := p.LinkOrCopy(srcA, dst); err != nil {
		t.Fatalf("최초 설치: %v", err)
	}

	stop := watchDst(dst)
	for i := 0; i < 300; i++ {
		src := srcA
		if i%2 == 1 {
			src = srcB
		}
		if err := p.LinkOrCopy(src, dst); err != nil {
			stop()
			t.Fatalf("재설치 %d: %v", i, err)
		}
	}
	if misses := stop(); misses != 0 {
		t.Fatalf("설치 중 dst 소실 %d회 — FR-ATI-1 위반", misses)
	}
}

// V-ATI-5: 관찰자가 읽은 내용은 언제나 **완전한 한 벌**이다. 부분 내용이 보이면
// O_TRUNC 로 제자리를 비우고 쓰는 구현이라는 뜻이다 (FR-ATI-2).
func TestLinkOrCopyNeverExposesPartialContent(t *testing.T) {
	dir := t.TempDir()
	// 먼저 순차로 확인한다 — 이 절반은 어느 호스트에서나 성립해야 한다.
	// 동시 관찰은 그 위의 강한 검사이고, 열린 파일을 대체할 수 없는 호스트에서는
	// 관찰이 대상을 망가뜨리므로 성립하지 않는다 (FR-WTP-31: 이식 가능한 절반을
	// 함께 빼지 않는다).
	// 부분 쓰기가 관측될 만큼 크게 잡는다. 작으면 한 번의 write 로 끝나 창이
	// 열리지 않고, 검사가 통과해도 아무 것도 증명하지 못한다.
	blobA := bytes.Repeat([]byte("A"), 1<<20)
	blobB := bytes.Repeat([]byte("B"), 1<<20)
	srcA := filepath.Join(dir, "srcA")
	srcB := filepath.Join(dir, "srcB")
	dst := filepath.Join(dir, "dmctl")
	if err := os.WriteFile(srcA, blobA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(srcB, blobB, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		src  string
		want []byte
	}{{srcA, blobA}, {srcB, blobB}, {srcA, blobA}} {
		if err := copyExecutable(tc.src, dst); err != nil {
			t.Fatalf("순차 복사: %v", err)
		}
		got, err := os.ReadFile(dst)
		if err != nil {
			t.Fatalf("순차 읽기: %v", err)
		}
		if !bytes.Equal(got, tc.want) {
			t.Fatalf("순차 내용이 온전하지 않다: len=%d", len(got))
		}
	}

	if !canReplaceOpenFile(t) {
		t.Skip("이 호스트는 열려 있는 파일을 대체할 수 없다 — 관찰자가 복사를 막는다")
	}

	done := make(chan struct{})
	var wg sync.WaitGroup
	var bad string
	var mu sync.Mutex
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			got, err := os.ReadFile(dst)
			if err != nil {
				mu.Lock()
				bad = "읽기 실패: " + err.Error()
				mu.Unlock()
				return
			}
			if !bytes.Equal(got, blobA) && !bytes.Equal(got, blobB) {
				mu.Lock()
				bad = "부분 내용 관측: len=" + itoa(len(got))
				mu.Unlock()
				return
			}
		}
	}()
	for i := 0; i < 30; i++ {
		src := srcA
		if i%2 == 1 {
			src = srcB
		}
		if err := copyExecutable(src, dst); err != nil {
			close(done)
			wg.Wait()
			t.Fatalf("복사 %d: %v", i, err)
		}
	}
	close(done)
	wg.Wait()
	mu.Lock()
	defer mu.Unlock()
	if bad != "" {
		t.Fatalf("%s — FR-ATI-2 위반", bad)
	}
}

// V-ATI-4: 설치가 끝나면 임시 파일이 남지 않는다 (FR-ATI-4).
func TestLinkOrCopyLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	srcA := filepath.Join(dir, "srcA")
	srcB := filepath.Join(dir, "srcB")
	dst := filepath.Join(dir, "dmctl")
	for _, s := range []string{srcA, srcB} {
		if err := os.WriteFile(s, []byte(filepath.Base(s)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	p := Current().Paths
	for _, s := range []string{srcA, srcB, srcA} {
		if err := p.LinkOrCopy(s, dst); err != nil {
			t.Fatalf("설치: %v", err)
		}
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"srcA": true, "srcB": true, "dmctl": true}
	for _, e := range ents {
		if !want[e.Name()] {
			t.Fatalf("잔여물 %q — FR-ATI-4 위반", e.Name())
		}
	}
}

// V-ATI-3: 같은 대상을 다시 설치하면 아무 것도 하지 않는다 (FR-ATI-3).
// 심링크가 서지 않는 호스트(Windows)에서는 복사가 매번 일어나므로 검사 대상이
// 아니다 — 그곳의 계약은 FR-ATI-2 가 대신 지킨다.
func TestLinkOrCopySameTargetIsNoop(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src")
	dst := filepath.Join(dir, "dmctl")
	if err := os.WriteFile(src, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	p := Current().Paths
	if err := p.LinkOrCopy(src, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Readlink(dst); err != nil {
		t.Skip("이 호스트는 심링크로 설치하지 않는다")
	}
	before, err := os.Lstat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.LinkOrCopy(src, dst); err != nil {
		t.Fatal(err)
	}
	after, err := os.Lstat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatalf("같은 대상인데 다시 걸었다 — FR-ATI-3 위반")
	}
}

// 설치 뒤 dst 가 실제로 src 를 가리키는지 — 원자화가 대상을 바꿔치기하지 않았음을
// 확인한다. 심링크·복사 어느 쪽이든 성립해야 한다.
func TestLinkOrCopyResolvesToSource(t *testing.T) {
	dir := t.TempDir()
	srcA := filepath.Join(dir, "srcA")
	srcB := filepath.Join(dir, "srcB")
	dst := filepath.Join(dir, "dmctl")
	if err := os.WriteFile(srcA, []byte("payload-A"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(srcB, []byte("payload-B"), 0o755); err != nil {
		t.Fatal(err)
	}
	p := Current().Paths
	for _, tc := range []struct{ src, want string }{
		{srcA, "payload-A"},
		{srcB, "payload-B"},
		{srcA, "payload-A"},
	} {
		if err := p.LinkOrCopy(tc.src, dst); err != nil {
			t.Fatalf("설치 %s: %v", tc.src, err)
		}
		got, err := os.ReadFile(dst)
		if err != nil {
			t.Fatalf("읽기: %v", err)
		}
		if strings.TrimSpace(string(got)) != tc.want {
			t.Fatalf("내용 = %q, want %q", got, tc.want)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
