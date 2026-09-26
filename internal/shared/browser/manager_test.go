package browser

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TC-BRT-4: 기동 인자 — 포트 없음, 프로필 폴더, 소리 끔.
func TestLaunchArgs(t *testing.T) {
	a := strings.Join(launchArgs("/h/browser/profiles/default", false), " ")
	if strings.Contains(a, "remote-debugging-port") {
		t.Fatalf("포트가 열린다: %s", a)
	}
	for _, want := range []string{"--remote-debugging-pipe", "--headless=new", "--user-data-dir=/h/browser/profiles/default", "--mute-audio"} {
		if !strings.Contains(a, want) {
			t.Fatalf("%s 가 없다: %s", want, a)
		}
	}
	// TC-BRT-80: serverAudio=true 는 --mute-audio 가 없다.
	if strings.Contains(strings.Join(launchArgs("/x", true), " "), "--mute-audio") {
		t.Fatal("serverAudio 인데 음소거다")
	}
	if strings.Contains(a, "--no-sandbox") {
		t.Fatal("--no-sandbox 를 쓴다")
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
