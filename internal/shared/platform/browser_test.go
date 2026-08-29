package platform

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// fakeLook 은 주어진 이름들만 찾아지는 LookPath 대역이다. 반환 경로는
// /usr/bin/<name> 로 고정해 인자 조립만 검사한다.
func fakeLook(found ...string) lookFn {
	set := map[string]struct{}{}
	for _, n := range found {
		set[n] = struct{}{}
	}
	return func(name string) (string, error) {
		if _, ok := set[name]; ok {
			return "/usr/bin/" + name, nil
		}
		return "", os.ErrNotExist
	}
}

func noEnv(string) string  { return "" }
func noFile(string) error  { return os.ErrNotExist }
func anyFile(string) error { return nil }

func TestMacBrowser(t *testing.T) {
	name, args, err := macBrowser().FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "open" {
		t.Fatalf("name = %q", name)
	}
	want := []string{"-na", "Google Chrome", "--args", "--app=http://x/"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

func TestUnixBrowserPrefersFirstChromium(t *testing.T) {
	// chromium 과 google-chrome 이 둘 다 있으면 목록 순서가 이긴다.
	name, args, err := unixBrowser(fakeLook("chromium", "google-chrome")).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/google-chrome" {
		t.Fatalf("name = %q, want google-chrome", name)
	}
	if !reflect.DeepEqual(args, []string{"--app=http://x/"}) {
		t.Fatalf("args = %v", args)
	}
}

// WSL 안에 리눅스 크로미움이 있으면 그것이 이긴다 — 호스트로 나가는 것은
// 폴백이지 우선 경로가 아니다. OS 를 묻지 않고 순서만으로 정해진다.
func TestUnixBrowserChromiumBeatsHostOpener(t *testing.T) {
	name, _, err := unixBrowser(fakeLook("chromium", "wslview", "powershell.exe")).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/chromium" {
		t.Fatalf("name = %q, want chromium", name)
	}
}

// 같은 체인이 WSL 에서는 wslview 로 이어진다. 분기가 아니라 가용성이 고른다.
func TestUnixBrowserFallsBackToWslview(t *testing.T) {
	name, args, err := unixBrowser(fakeLook("wslview", "powershell.exe")).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/wslview" {
		t.Fatalf("name = %q", name)
	}
	if !reflect.DeepEqual(args, []string{"http://x/"}) {
		t.Fatalf("args = %v", args)
	}
}

func TestUnixBrowserFallsBackToPowershell(t *testing.T) {
	name, args, err := unixBrowser(fakeLook("powershell.exe")).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/powershell.exe" {
		t.Fatalf("name = %q", name)
	}
	want := []string{"-NoProfile", "-Command", "Start-Process", "http://x/"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

// 평범한 리눅스에 브라우저가 없으면 호스트 수단도 없다 — 오류다.
func TestUnixBrowserNoneFound(t *testing.T) {
	_, _, err := unixBrowser(fakeLook()).FramelessCommand("http://x/")
	if err == nil {
		t.Fatal("아무 수단도 없는데 성공했다")
	}
}

func TestWinBrowserPrefersPATH(t *testing.T) {
	name, args, err := winBrowser(fakeLook("chrome.exe"), noEnv, noFile).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/chrome.exe" {
		t.Fatalf("name = %q", name)
	}
	if !reflect.DeepEqual(args, []string{"--app=http://x/"}) {
		t.Fatalf("args = %v", args)
	}
}

func TestWinBrowserFindsStandardInstall(t *testing.T) {
	base := filepath.Join("C:", "Program Files")
	want := filepath.Join(base, chromeRelPath)
	env := func(k string) string {
		if k == "ProgramFiles" {
			return base
		}
		return ""
	}
	stat := func(p string) error {
		if p == want {
			return nil
		}
		return os.ErrNotExist
	}
	name, args, err := winBrowser(fakeLook(), env, stat).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != want {
		t.Fatalf("name = %q, want %q", name, want)
	}
	if !reflect.DeepEqual(args, []string{"--app=http://x/"}) {
		t.Fatalf("args = %v", args)
	}
}

// 크로미움이 없어도 여는 것은 성공해야 한다 — frameless window 만 포기한다.
func TestWinBrowserFallsBackToDefaultHandler(t *testing.T) {
	name, args, err := winBrowser(fakeLook(), noEnv, noFile).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("기본 브라우저 위임은 실패하지 않아야 한다: %v", err)
	}
	if name != "rundll32" {
		t.Fatalf("name = %q", name)
	}
	want := []string{"url.dll,FileProtocolHandler", "http://x/"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args = %v, want %v", args, want)
	}
}

// 환경변수가 비어 있으면 그 후보는 검사조차 하지 않아야 한다. 빈 값을 Join 하면
// 상대 경로가 만들어져 엉뚱한 파일을 가리킨다 — anyFile 이 전부 참이므로,
// 건너뛰지 않으면 여기서 잘못된 경로를 답한다.
func TestWinBrowserSkipsEmptyEnv(t *testing.T) {
	name, _, err := winBrowser(fakeLook(), noEnv, anyFile).FramelessCommand("http://x/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "rundll32" {
		t.Fatalf("빈 환경변수 후보를 골랐다: %q", name)
	}
}
