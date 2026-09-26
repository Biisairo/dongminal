package browser

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// TC-BRT-4: 기동 인자 — 포트 없음, 프로필 폴더, 소리 끔.
func TestLaunchArgs(t *testing.T) {
	a := strings.Join(launchArgs("/h/browser/profiles/default", AudioOff), " ")
	if strings.Contains(a, "remote-debugging-port") {
		t.Fatalf("포트가 열린다: %s", a)
	}
	for _, want := range []string{"--remote-debugging-pipe", "--headless=new", "--user-data-dir=/h/browser/profiles/default", "--mute-audio"} {
		if !strings.Contains(a, want) {
			t.Fatalf("%s 가 없다: %s", want, a)
		}
	}
	if strings.Contains(a, "--no-sandbox") {
		t.Fatal("--no-sandbox 를 쓴다")
	}
}

// TC-BRT-80: 소리 셋 — server 만 음소거가 없고, viewer 만 확장 인자가 있다.
func TestLaunchArgsAudio(t *testing.T) {
	ext := "--allowlisted-extension-id=" + audioExtID
	for mode, want := range map[string][2]bool{AudioOff: {true, false}, AudioServer: {false, false}, AudioViewer: {true, true}} {
		a := strings.Join(launchArgs("/x", mode), " ")
		if strings.Contains(a, "--mute-audio") != want[0] {
			t.Errorf("%s: --mute-audio=%v want %v", mode, !want[0], want[0])
		}
		if strings.Contains(a, ext) != want[1] || strings.Contains(a, "--enable-unsafe-extension-debugging") != want[1] {
			t.Errorf("%s: 확장 인자 want %v: %s", mode, want[1], a)
		}
	}
}

// TC-BRT-80: 설정 값 — 없거나 모르는 값은 off 다.
func TestAudioSetting(t *testing.T) {
	home := t.TempDir()
	if got := AudioSetting(home); got != AudioOff {
		t.Fatalf("없음 → %q", got)
	}
	for in, want := range map[string]string{`"server"`: AudioServer, `"viewer"`: AudioViewer, `"loud"`: AudioOff, `true`: AudioOff} {
		os.WriteFile(filepath.Join(home, dmenv.SettingsFile), []byte(`{"browserAudio":`+in+`}`), 0o600)
		if got := AudioSetting(home); got != want {
			t.Errorf("%s → %q want %q", in, got, want)
		}
	}
}

// TC-BRT-82: 내장 확장의 key 에서 계산한 ID 가 기동 인자의 ID 다.
func TestAudioExtID(t *testing.T) {
	if got := extensionID(audioExtKey); got != audioExtID {
		t.Fatalf("key → %s, 상수 %s", got, audioExtID)
	}
	dir := t.TempDir()
	if err := installAudioExt(dir); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil || !strings.Contains(string(b), audioExtKey) {
		t.Fatalf("manifest: %v %s", err, b)
	}
}

// TC-BRT-3: 주 버전 판정.
func TestParseMajor(t *testing.T) {
	for in, want := range map[string]int{"HeadlessChrome/153.0.8010.53": 153, "Chrome/134.0.1": 134, "x": 0} {
		if got := parseMajor(in); got != want {
			t.Errorf("%q → %d want %d", in, got, want)
		}
	}
	if parseMajor("HeadlessChrome/134.0") >= MinChromeMajor || parseMajor("HeadlessChrome/135.0") < MinChromeMajor {
		t.Fatal("134 거절 · 135 통과가 아니다")
	}
}

// TC-BRT-10·11: 폴더 목록 = 프로필 목록, 이름 규칙, default 는 있고 지울 수 없다.
func TestProfiles(t *testing.T) {
	home := t.TempDir()
	m := New(Config{Home: home})
	ps, err := m.Profiles()
	if err != nil || len(ps) != 1 || ps[0].Name != DefaultProfile {
		t.Fatalf("default 가 없다: %v %v", ps, err)
	}
	if fi, err := os.Stat(filepath.Join(home, "browser")); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("browser/ 권한: %v %v", fi, err)
	}
	for _, bad := range []string{"", "A", "-x", "a/b", strings.Repeat("a", 33), "..", "한글"} {
		if err := m.CreateProfile(bad); err == nil {
			t.Errorf("%q 가 통과했다", bad)
		}
	}
	if err := m.CreateProfile("work"); err != nil {
		t.Fatal(err)
	}
	// 폴더를 손으로 만들어도 목록이다 — 목록 파일이 따로 없다.
	os.MkdirAll(filepath.Join(home, "browser", "profiles", "qa"), 0o700)
	ps, _ = m.Profiles()
	var names []string
	for _, p := range ps {
		names = append(names, p.Name)
	}
	if strings.Join(names, ",") != "default,qa,work" {
		t.Fatalf("목록=%v", names)
	}
	if err := m.DeleteProfile(DefaultProfile); err != ErrDefaultKeep {
		t.Fatalf("default 삭제: %v", err)
	}
	if err := m.DeleteProfile("work"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "browser", "profiles", "work")); !os.IsNotExist(err) {
		t.Fatal("폴더가 남았다")
	}
}

// TC-BRT-2: 엔진이 없으면 설치 안내로 실패한다.
func TestOpenWithoutEngine(t *testing.T) {
	m := New(Config{Home: t.TempDir(), Engine: fakeEngine{}})
	err := m.Open(context.Background(), OpenReq{Tab: "t1", URL: "about:blank"})
	if err == nil || !strings.Contains(err.Error(), "https://www.google.com/chrome/") {
		t.Fatalf("안내가 없다: %v", err)
	}
}

// root 거절 (FR-BRT-4).
func TestOpenAsRootRefused(t *testing.T) {
	m := New(Config{Home: t.TempDir(), Engine: fakeEngine{path: "/x/chrome"}, Euid: func() int { return 0 }})
	if err := m.Open(context.Background(), OpenReq{Tab: "t1"}); err != ErrRoot {
		t.Fatalf("root: %v", err)
	}
}

// 열 수 없는 scheme 은 페이지를 만들지 않는다 (FR-BRT-65).
func TestOpenRejectsScheme(t *testing.T) {
	m := New(Config{Home: t.TempDir(), Engine: fakeEngine{path: "/x/chrome"}})
	if err := m.Open(context.Background(), OpenReq{Tab: "t1", URL: "javascript:alert(1)"}); err == nil {
		t.Fatal("javascript: 가 열렸다")
	}
}

type fakeProc struct {
	alive  map[int]bool
	killed []int
}

func (f *fakeProc) Alive(pid int) bool { return f.alive[pid] }
func (f *fakeProc) Kill(pid int) error { f.killed = append(f.killed, pid); return nil }

// FR-BRT-7: 강제로 끝난 매니저가 남긴 Chrome 은 그 프로필을 잠근다 — 다음 기동 전에 그
// 잠금의 주인을 거둔다. 잠금이 없거나 주인이 죽었으면 아무것도 하지 않는다.
func TestReapStaleSingleton(t *testing.T) {
	dir := t.TempDir()
	p := &fakeProc{alive: map[int]bool{4242: true}}
	reapStaleSingleton(dir, p)
	if len(p.killed) != 0 {
		t.Fatal("잠금이 없는데 죽였다")
	}
	os.Symlink("host.local-4242", filepath.Join(dir, "SingletonLock"))
	reapStaleSingleton(dir, p)
	if len(p.killed) != 1 || p.killed[0] != 4242 {
		t.Fatalf("killed=%v", p.killed)
	}
	os.Remove(filepath.Join(dir, "SingletonLock"))
	os.Symlink("host-9", filepath.Join(dir, "SingletonLock"))
	reapStaleSingleton(dir, p)
	if len(p.killed) != 1 {
		t.Fatalf("죽은 주인을 죽였다: %v", p.killed)
	}
}

// TC-BRT-3: 가짜 피어 — 주 버전 134 는 기동 중에 거절하고 안내한다.
func TestOpenRejectsOldChrome(t *testing.T) {
	m := New(Config{Home: t.TempDir(), Engine: peerEngine{product: "HeadlessChrome/134.0.6998.0"}})
	t.Cleanup(m.Close)
	err := m.Open(context.Background(), OpenReq{Tab: "t", URL: "about:blank"})
	if err == nil || !strings.Contains(err.Error(), "135") {
		t.Fatalf("134 를 받았다: %v", err)
	}
}
