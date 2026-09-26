package platform

import (
	"bufio"
	"bytes"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// TC-BRT-1: OS 별 탐색 표 (FR-BRT-1). 세 체인 전부를 어느 호스트에서도 시험한다.
func TestChromeFinderMac(t *testing.T) {
	env := func(k string) string {
		if k == "HOME" {
			return "/Users/u"
		}
		return ""
	}
	only := func(want string) statFn {
		return func(p string) error {
			if p == want {
				return nil
			}
			return os.ErrNotExist
		}
	}
	sys := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if p, err := macChromeFinder(env, anyFile).find(); err != nil || p != sys {
		t.Fatalf("시스템 Applications 가 먼저다: %q %v", p, err)
	}
	user := "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if p, err := macChromeFinder(env, only(user)).find(); err != nil || p != user {
		t.Fatalf("사용자 Applications: %q %v", p, err)
	}
	if _, err := macChromeFinder(env, noFile).find(); !errors.Is(err, ErrChromeNotFound) {
		t.Fatalf("없으면 ErrChromeNotFound: %v", err)
	}
}

func TestChromeFinderLinux(t *testing.T) {
	if p, err := linuxChromeFinder(fakeLook("google-chrome-stable", "google-chrome")).find(); err != nil || p != "/usr/bin/google-chrome" {
		t.Fatalf("google-chrome 이 먼저다: %q %v", p, err)
	}
	if p, err := linuxChromeFinder(fakeLook("google-chrome-stable")).find(); err != nil || p != "/usr/bin/google-chrome-stable" {
		t.Fatalf("google-chrome-stable: %q %v", p, err)
	}
	// 배포판 chromium 은 찾지 않는다 (D-BRT-1).
	if _, err := linuxChromeFinder(fakeLook("chromium", "chromium-browser")).find(); !errors.Is(err, ErrChromeNotFound) {
		t.Fatalf("chromium 만 있으면 없음이다: %v", err)
	}
}

func TestChromeFinderWindows(t *testing.T) {
	env := func(k string) string {
		return map[string]string{"ProgramFiles": `C:\PF`, "ProgramFiles(x86)": `C:\PF86`, "LOCALAPPDATA": `C:\LA`}[k]
	}
	if p, err := winChromeFinder(fakeLook("chrome.exe"), env, noFile).find(); err != nil || p != "/usr/bin/chrome.exe" {
		t.Fatalf("PATH 가 먼저다: %q %v", p, err)
	}
	var tried []string
	stat := func(p string) error {
		tried = append(tried, p)
		if strings.Contains(p, "LA") {
			return nil
		}
		return os.ErrNotExist
	}
	p, err := winChromeFinder(fakeLook(), env, stat).find()
	if err != nil || !strings.Contains(p, "LA") {
		t.Fatalf("LOCALAPPDATA: %q %v", p, err)
	}
	if len(tried) != 3 {
		t.Fatalf("세 자리를 차례로 본다: %v", tried)
	}
	// Edge 는 찾지 않는다 (D-BRT-1).
	if _, err := winChromeFinder(fakeLook("msedge.exe"), env, noFile).find(); !errors.Is(err, ErrChromeNotFound) {
		t.Fatalf("Edge 만 있으면 없음이다: %v", err)
	}
}

// FR-BRT-2: 안내는 공식 다운로드 주소를 담는다.
func TestChromeInstallHint(t *testing.T) {
	for _, f := range []chromeFinder{macChromeFinder(noEnv, noFile), linuxChromeFinder(fakeLook()), winChromeFinder(fakeLook(), noEnv, noFile)} {
		if !strings.Contains(f.hint, chromeDownloadURL) {
			t.Errorf("안내에 설치 주소가 없다: %q", f.hint)
		}
	}
}

// TC-BRT-6 의 모양 절반: lpReserved2 인코딩이 MSVCRT 의 배치와 같고 되읽힌다.
func TestCRTFDsRoundTrip(t *testing.T) {
	hs := []uint64{1, 2, 3, 0x1234, 0xdeadbeef}
	fl := []byte{0x41, 0x41, 0x41, 0x09, 0x09}
	for _, ps := range []int{4, 8} {
		b := encodeCRTFDs(hs, fl, ps)
		if len(b) != 4+5+5*ps {
			t.Fatalf("ptr=%d len=%d", ps, len(b))
		}
		gh, gf, err := decodeCRTFDs(b, ps)
		if err != nil || !reflect.DeepEqual(gh, hs) || !bytes.Equal(gf, fl) {
			t.Fatalf("ptr=%d 왕복 실패: %v %v %v", ps, gh, gf, err)
		}
	}
	if _, _, err := decodeCRTFDs([]byte{5, 0, 0, 0, 1}, 8); err == nil {
		t.Fatal("짧은 버퍼를 받아들였다")
	}
}

// TC-BRT-6 (실제 Chrome): pipe 로 띄운 Chrome 이 `Browser.getVersion` 에 답한다.
// Chrome 이 없으면 건너뛴다 — CI(Linux·Windows)는 Chrome 을 갖춘다 (NFR-BRT-Q1).
func TestChromePipeRealBrowser(t *testing.T) {
	c := Current().Chrome
	path, err := c.Find()
	if err != nil {
		t.Skip("Chrome 없음")
	}
	dir := t.TempDir()
	p, err := c.StartPiped(PipedSpec{Path: path, Args: []string{
		"--headless=new", "--remote-debugging-pipe", "--user-data-dir=" + dir,
		"--no-first-run", "--no-default-browser-check", "--mute-audio"}})
	if err != nil {
		t.Fatalf("StartPiped: %v", err)
	}
	defer func() {
		p.Kill()
		p.Wait()
	}()
	if _, err := p.ToChild.Write([]byte(`{"id":1,"method":"Browser.getVersion"}` + "\x00")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(p.FromChild).ReadString(0)
		got <- s
	}()
	select {
	case s := <-got:
		if !strings.Contains(s, `"product"`) {
			t.Fatalf("응답에 product 가 없다: %q", s)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("Browser.getVersion 응답이 없다")
	}
}
