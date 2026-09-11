package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/platform"
)

// M5 `SEC-23` — 웹서버 프로세스를 감독하는 것이 없다.
//
// 죽으면 아무도 되살리지 않는다. 그 사실을 사용자가 아는 방법은 브라우저가
// 붙지 않는 것뿐이고, 그때 이미 세션은 끊긴 뒤다.
//
// **우리가 감독자를 만들지 않는다.** OS 마다 이미 있다 — launchd · systemd ·
// 작업 스케줄러. 우리가 할 일은 그것에 넣을 정의를 **정확히** 써 주는 것이다.

func writeServiceTo(t *testing.T, kind platform.OSKind, out string) (string, string) {
	t.Helper()
	home := t.TempDir()
	isolateEnv(t, home)
	var so, se bytes.Buffer
	o, err := ParseService([]string{"install", "--out", out})
	if err != nil {
		t.Fatal(err)
	}
	o.osKind = kind
	o.exe = "/opt/dongminal/dongminal"
	if code := RunService(o, &so, &se); code != 0 {
		t.Fatalf("exit %d: %s", code, se.String())
	}
	return so.String(), home
}

// launchd 는 plist 다. `KeepAlive` 가 없으면 감독이 아니다.
func TestServiceDarwinPlist(t *testing.T) {
	out := filepath.Join(t.TempDir(), "dm.plist")
	stdout, home := writeServiceTo(t, platform.Darwin, out)
	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	for _, want := range []string{
		"<key>KeepAlive</key>", "<key>RunAtLoad</key>",
		"/opt/dongminal/dongminal", "start", "--foreground",
		"DONGMINAL_HOME", home,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("plist 에 %q 가 없다:\n%s", want, s)
		}
	}
	// 다음에 할 일을 안내한다 — 파일만 써 두고 끝내면 아무 일도 일어나지 않는다.
	if !strings.Contains(stdout, "launchctl") {
		t.Errorf("적용 방법을 안내하지 않았다:\n%s", stdout)
	}
}

// systemd 는 user unit 이다. **시스템 단위가 아니다** — 이 제품은 사용자의
// 세션과 홈에 매여 있다.
func TestServiceLinuxUnit(t *testing.T) {
	out := filepath.Join(t.TempDir(), "dm.service")
	stdout, home := writeServiceTo(t, platform.Linux, out)
	body, _ := os.ReadFile(out)
	s := string(body)
	for _, want := range []string{
		"[Unit]", "[Service]", "[Install]",
		"Restart=always", "ExecStart=/opt/dongminal/dongminal start --foreground",
		"Environment=DONGMINAL_HOME=" + home,
		"WantedBy=default.target",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("unit 에 %q 가 없다:\n%s", want, s)
		}
	}
	if strings.Contains(s, "User=root") {
		t.Error("시스템 단위로 썼다 — 이 제품은 사용자 세션의 것이다")
	}
	if !strings.Contains(stdout, "systemctl --user") {
		t.Errorf("적용 방법을 안내하지 않았다:\n%s", stdout)
	}
}

// WSL 도 systemd 로 본다 — 빌드가 linux 와 같다.
func TestServiceWSLUsesSystemd(t *testing.T) {
	out := filepath.Join(t.TempDir(), "dm.service")
	writeServiceTo(t, platform.WSL, out)
	body, _ := os.ReadFile(out)
	if !strings.Contains(string(body), "[Service]") {
		t.Errorf("WSL 이 systemd unit 을 받지 못했다:\n%s", body)
	}
}

// Windows 는 지원하지 않는다. **조용히 빈 파일을 쓰지 않는다** — 그것이 가장 나쁘다.
func TestServiceWindowsIsUnsupported(t *testing.T) {
	home := t.TempDir()
	isolateEnv(t, home)
	out := filepath.Join(t.TempDir(), "x")
	var so, se bytes.Buffer
	o, _ := ParseService([]string{"install", "--out", out})
	o.osKind = platform.Windows
	o.exe = "C:\\dm\\dongminal.exe"
	if code := RunService(o, &so, &se); code == 0 {
		t.Error("지원하지 않는데 성공으로 끝났다")
	}
	if _, err := os.Stat(out); err == nil {
		t.Error("지원하지 않으면서 파일을 썼다")
	}
	if !strings.Contains(se.String(), "Windows") {
		t.Errorf("사유를 말하지 않았다: %s", se.String())
	}
}

// `--out` 없이 부르면 **화면에 낸다.** 사용자가 보고 옮길 수 있다.
func TestServicePrintsWhenNoOut(t *testing.T) {
	home := t.TempDir()
	isolateEnv(t, home)
	var so, se bytes.Buffer
	o, _ := ParseService([]string{"install"})
	o.osKind = platform.Linux
	o.exe = "/opt/dongminal/dongminal"
	if code := RunService(o, &so, &se); code != 0 {
		t.Fatalf("exit %d: %s", code, se.String())
	}
	if !strings.Contains(so.String(), "[Service]") {
		t.Errorf("정의를 내지 않았다:\n%s", so.String())
	}
}
