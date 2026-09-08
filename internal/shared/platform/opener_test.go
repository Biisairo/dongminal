package platform

import (
	"reflect"
	"testing"
)

// VIEWER_URL_OPEN_SRS FR-VUO-2 의 로컬 경로. Browser 와 달리 **평범한 창**을
// 연다 — frameless 앱 창(--app)이 아니다.

func TestMacOpener_UsesPlainOpen(t *testing.T) {
	name, args, err := macOpener().OpenCommand("https://x.dev/a?b=1")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "open" {
		t.Fatalf("name = %q, want open", name)
	}
	if !reflect.DeepEqual(args, []string{"https://x.dev/a?b=1"}) {
		t.Fatalf("args = %v — --app 이 붙으면 앱 창이 된다", args)
	}
}

func TestUnixOpener_PrefersXdgOpen(t *testing.T) {
	name, args, err := unixOpener(fakeLook("xdg-open")).OpenCommand("https://x.dev/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/xdg-open" {
		t.Fatalf("name = %q", name)
	}
	if !reflect.DeepEqual(args, []string{"https://x.dev/"}) {
		t.Fatalf("args = %v", args)
	}
}

// WSL 에는 xdg-open 이 없을 수 있다. 그때 호스트로 넘기는 수단이 답한다 —
// Browser 와 같은 체인을 쓰므로 이 판정에 OS 를 묻는 코드가 없다.
func TestUnixOpener_FallsBackToHostOpener(t *testing.T) {
	name, _, err := unixOpener(fakeLook("wslview")).OpenCommand("https://x.dev/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "/usr/bin/wslview" {
		t.Fatalf("name = %q, want wslview", name)
	}
}

func TestUnixOpener_NothingAvailable(t *testing.T) {
	if _, _, err := unixOpener(fakeLook()).OpenCommand("https://x.dev/"); err == nil {
		t.Fatal("열 수단이 없는데 err 가 nil 이다")
	}
}

// Windows 는 기본 핸들러에 위임한다. rundll32 는 어디에나 있으므로 실패하지 않는다.
func TestWinOpener_DefaultHandler(t *testing.T) {
	name, args, err := winOpener().OpenCommand("https://x.dev/")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if name != "rundll32" {
		t.Fatalf("name = %q", name)
	}
	if !reflect.DeepEqual(args, []string{"url.dll,FileProtocolHandler", "https://x.dev/"}) {
		t.Fatalf("args = %v", args)
	}
}

// 이 빌드의 번들에는 Opener 가 있어야 한다 — dmctl 의 로컬 경로가 그것을 부른다.
func TestCurrentPlatform_HasOpener(t *testing.T) {
	if Current().Opener == nil {
		t.Fatal("Platform.Opener 가 비어 있다")
	}
}
