package peer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/dmenv"
)

// FR-PNW-3: `[A-Za-z0-9._-]` 1~32자.
func TestValidName(t *testing.T) {
	ok := []string{"office", "a", "A.b_c-1", strings.Repeat("x", NameMaxLen)}
	for _, n := range ok {
		if err := ValidName(n); err != nil {
			t.Errorf("ValidName(%q) = %v, 기대 nil", n, err)
		}
	}
	bad := []string{"", strings.Repeat("x", NameMaxLen+1), "a b", "a/b", "한글", "a:b", "office\n"}
	for _, n := range bad {
		if err := ValidName(n); !errors.Is(err, ErrInvalidName) {
			t.Errorf("ValidName(%q) = %v, 기대 ErrInvalidName", n, err)
		}
	}
}

// 기본 이름(호스트 이름)도 FR-PNW-3 을 지켜야 한다.
func TestDefaultName(t *testing.T) {
	cases := map[string]string{
		"Mac-Pro.local": "Mac-Pro.local",
		"my host!":      "my-host-",
		"한글pc":          "--pc",
		"":              "node",
	}
	for in, want := range cases {
		if got := DefaultName(in); got != want {
			t.Errorf("DefaultName(%q) = %q, 기대 %q", in, got, want)
		}
	}
	long := DefaultName(strings.Repeat("y", 40))
	if len(long) != NameMaxLen {
		t.Errorf("긴 호스트 이름의 길이 %d, 기대 %d", len(long), NameMaxLen)
	}
	if err := ValidName(long); err != nil {
		t.Errorf("자른 이름이 유효하지 않다: %v", err)
	}
}

// FR-PNW-2: 파일이 없으면 기본값.
func TestOpenStoreDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeersFile)
	s := OpenStore(path, "host-a")
	c := s.Config()
	if c.Enabled {
		t.Error("enabled 기본값이 true 다")
	}
	if c.Port != DefaultPort || DefaultPort != 58147 {
		t.Errorf("port = %d, 기대 58147", c.Port)
	}
	if c.Bind != "0.0.0.0" {
		t.Errorf("bind = %q", c.Bind)
	}
	if c.Name != "host-a" {
		t.Errorf("name = %q", c.Name)
	}
	if c.Advertise != "" || len(c.AllowedDirs) != 0 || len(c.Peers) != 0 {
		t.Errorf("빈 기본값이 아니다: %+v", c)
	}
	// NFR-PNW-1: 손대지 않으면 파일을 만들지 않는다.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("열기만 했는데 파일이 생겼다: %v", err)
	}
}

func TestStoreSaveAndReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeersFile)
	s := OpenStore(path, "host-a")
	c := s.Config()
	c.Enabled = true
	c.Port = 60001
	c.Bind = "127.0.0.1"
	c.Name = "office"
	c.Advertise = "office.example"
	c.AllowedDirs = []string{"/work"}
	c.Peers = []Peer{{Name: "home", Addr: "10.0.0.2", Port: 58147, Fingerprint: strings.Repeat("ab", 32)}}
	if err := s.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	got := OpenStore(path, "other").Config()
	want, _ := json.Marshal(c)
	have, _ := json.Marshal(got)
	if string(want) != string(have) {
		t.Fatalf("다시 읽은 값이 다르다:\n  %s\n  %s", have, want)
	}
}

// 하나라도 틀리면 아무것도 저장하지 않는다 (access.json 과 같은 규약).
func TestStoreSaveRejectsInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeersFile)
	s := OpenStore(path, "host-a")
	cases := []struct {
		name   string
		mutate func(*Config)
		want   error
	}{
		{"이름", func(c *Config) { c.Name = "a b" }, ErrInvalidName},
		{"포트 0", func(c *Config) { c.Port = 0 }, ErrInvalidPort},
		{"포트 초과", func(c *Config) { c.Port = 65536 }, ErrInvalidPort},
		{"주소", func(c *Config) { c.Bind = "not-an-ip" }, ErrInvalidBind},
	}
	for _, tc := range cases {
		c := s.Config()
		tc.mutate(&c)
		if err := s.Save(c); !errors.Is(err, tc.want) {
			t.Errorf("%s: Save = %v, 기대 %v", tc.name, err, tc.want)
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("거절된 저장이 파일을 만들었다: %v", err)
	}
	if s.Config().Name != "host-a" {
		t.Error("거절된 저장이 메모리 값을 바꿨다")
	}
}

// 쓰기에 실패하면 메모리도 되돌린다 (FR-SAF-1·2 와 같은 규약).
func TestStoreSaveFailureRestores(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(filepath.Join(blocker, dmenv.PeersFile), "host-a")
	c := s.Config()
	c.Name = "changed"
	if err := s.Save(c); !errors.Is(err, ErrSaveFailed) {
		t.Fatalf("Save = %v, 기대 ErrSaveFailed", err)
	}
	if s.Config().Name != "host-a" {
		t.Fatal("쓰기 실패 뒤 메모리 값이 남았다")
	}
}

// 읽기 실패가 서버를 멈추지 않는다 — 꺼진 기본값으로 선다.
func TestOpenStoreCorruptFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeersFile)
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := OpenStore(path, "host-a").Config()
	if c.Enabled || c.Port != DefaultPort || c.Name != "host-a" {
		t.Fatalf("기본값이 아니다: %+v", c)
	}
}

// 일부 필드만 적힌 파일은 나머지를 기본값으로 채운다.
func TestOpenStorePartialFillsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeersFile)
	if err := os.WriteFile(path, []byte(`{"enabled":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	c := OpenStore(path, "host-a").Config()
	if !c.Enabled || c.Port != DefaultPort || c.Bind != DefaultBind || c.Name != "host-a" {
		t.Fatalf("기본값을 채우지 않았다: %+v", c)
	}
}

func TestStoreIsPeer(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.PeersFile)
	s := OpenStore(path, "host-a")
	fp := strings.Repeat("cd", 32)
	if s.IsPeer(fp) {
		t.Fatal("빈 목록에서 짝이라고 답했다")
	}
	c := s.Config()
	c.Peers = []Peer{{Name: "b", Addr: "10.0.0.3", Port: 58147, Fingerprint: fp}}
	if err := s.Save(c); err != nil {
		t.Fatal(err)
	}
	if !s.IsPeer(fp) {
		t.Fatal("저장한 짝을 모른다")
	}
	if s.IsPeer(strings.Repeat("ef", 32)) || s.IsPeer("") {
		t.Fatal("모르는 지문을 짝이라고 답했다")
	}
}

func newTestStore(t *testing.T, clk *fakeClock) *Store {
	t.Helper()
	s := OpenStore(filepath.Join(t.TempDir(), dmenv.PeersFile), "host-a")
	s.now = clk.now
	return s
}

func fpOf(b string) string { return strings.Repeat(b, 32) }

// 짝 항목도 저장 전에 검증한다.
func TestStoreRejectsInvalidPeer(t *testing.T) {
	s := newTestStore(t, newFakeClock())
	cases := []Peer{
		{Name: "a b", Addr: "h", Port: 1, Fingerprint: fpOf("aa")},
		{Name: "a", Addr: "h", Port: 0, Fingerprint: fpOf("aa")},
		{Name: "a", Addr: "h", Port: 1, Fingerprint: "xyz"},
		{Name: "a", Addr: "", Port: 1, Fingerprint: fpOf("aa")},
		{Name: "a", Addr: "h", Port: 1, Fingerprint: fpOf("aa"), State: "weird"},
	}
	for _, p := range cases {
		if err := s.AddPeer(p); !errors.Is(err, ErrInvalidPeer) && !errors.Is(err, ErrInvalidName) {
			t.Errorf("AddPeer(%+v) = %v", p, err)
		}
	}
	if len(s.Config().Peers) != 0 {
		t.Fatal("거절된 짝이 남았다")
	}
}

// FR-PNW-26·27·29: pending-out 은 짝이 아니고, 10분 안에 승격되며, 지나면 사라진다.
func TestStorePendingOutLifecycle(t *testing.T) {
	clk := newFakeClock()
	s := newTestStore(t, clk)
	fp := fpOf("aa")
	if err := s.AddPeer(Peer{Name: "b", Addr: "10.0.0.2", Port: 58147, Fingerprint: fp, State: StatePendingOut, Expires: clk.t.Add(PendingTTL)}); err != nil {
		t.Fatal(err)
	}
	if s.IsPeer(fp) {
		t.Fatal("pending-out 을 짝으로 셌다")
	}
	if !s.IsPendingOut(fp) {
		t.Fatal("pending-out 을 모른다")
	}
	if !s.Promote(fp) {
		t.Fatal("승격하지 못했다")
	}
	if !s.IsPeer(fp) || s.IsPendingOut(fp) {
		t.Fatal("승격 뒤 상태가 틀렸다")
	}
	got := OpenStore(s.path, "x").Config().Peers
	if len(got) != 1 || got[0].State != "" || !got[0].Expires.IsZero() {
		t.Fatalf("승격이 저장되지 않았다: %+v", got)
	}
}

func TestStorePendingOutExpires(t *testing.T) {
	clk := newFakeClock()
	s := newTestStore(t, clk)
	fp := fpOf("aa")
	if err := s.AddPeer(Peer{Name: "b", Addr: "h", Port: 1, Fingerprint: fp, State: StatePendingOut, Expires: clk.t.Add(PendingTTL)}); err != nil {
		t.Fatal(err)
	}
	clk.advance(PendingTTL + time.Second)
	if s.IsPendingOut(fp) || s.Promote(fp) {
		t.Fatal("만료된 pending-out 이 살아 있다")
	}
	if s.NameTaken("b") {
		t.Fatal("만료된 pending-out 이 이름을 쥐고 있다")
	}
	for _, p := range s.Config().Peers {
		if p.Fingerprint == fp {
			t.Fatal("만료된 pending-out 이 목록에 보인다")
		}
	}
}

// FR-PNW-30: 이름은 겹치지 않는다. 같은 지문이 다시 오면 그 항목을 갈아 끼운다.
func TestStoreNamesAndReplace(t *testing.T) {
	s := newTestStore(t, newFakeClock())
	if err := s.AddPeer(Peer{Name: "b", Addr: "h", Port: 1, Fingerprint: fpOf("aa")}); err != nil {
		t.Fatal(err)
	}
	if !s.NameTaken("b") || s.NameTaken("c") {
		t.Fatal("NameTaken 이 틀렸다")
	}
	if err := s.AddPeer(Peer{Name: "b", Addr: "h", Port: 1, Fingerprint: fpOf("bb")}); !errors.Is(err, ErrNameTaken) {
		t.Fatalf("같은 이름 = %v", err)
	}
	if err := s.AddPeer(Peer{Name: "b2", Addr: "h2", Port: 2, Fingerprint: fpOf("aa")}); err != nil {
		t.Fatalf("같은 지문 = %v", err)
	}
	got := s.Config().Peers
	if len(got) != 1 || got[0].Name != "b2" || got[0].Addr != "h2" {
		t.Fatalf("갈아 끼우지 않았다: %+v", got)
	}
}

// FR-PNW-31·32: 해제와 주소 수정.
func TestStoreRemoveAndAddress(t *testing.T) {
	s := newTestStore(t, newFakeClock())
	fp := fpOf("aa")
	if err := s.AddPeer(Peer{Name: "b", Addr: "h", Port: 1, Fingerprint: fp}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAddress("b", "10.0.0.9", 60000); err != nil {
		t.Fatal(err)
	}
	if p := s.Config().Peers[0]; p.Addr != "10.0.0.9" || p.Port != 60000 || p.Fingerprint != fp {
		t.Fatalf("주소 수정: %+v", p)
	}
	if err := s.SetAddress("b", "", 1); !errors.Is(err, ErrInvalidPeer) {
		t.Fatalf("빈 주소 = %v", err)
	}
	if err := s.SetAddress("nope", "h", 1); !errors.Is(err, ErrPeerNotFound) {
		t.Fatalf("없는 짝 주소 = %v", err)
	}
	if err := s.Remove("b"); err != nil {
		t.Fatal(err)
	}
	if s.IsPeer(fp) {
		t.Fatal("해제 뒤에도 짝이다")
	}
	if err := s.Remove("b"); !errors.Is(err, ErrPeerNotFound) {
		t.Fatalf("두 번째 해제 = %v", err)
	}
}

// FR-PNW-30 (I-5): 겹치지 않는 이름을 만든다.
func TestStoreFreeName(t *testing.T) {
	s := newTestStore(t, newFakeClock())
	if got := s.FreeName("b"); got != "b" {
		t.Fatalf("FreeName = %q", got)
	}
	_ = s.AddPeer(Peer{Name: "b", Addr: "h", Port: 1, Fingerprint: fpOf("aa")})
	_ = s.AddPeer(Peer{Name: "b-2", Addr: "h", Port: 1, Fingerprint: fpOf("bb")})
	if got := s.FreeName("b"); got != "b-3" {
		t.Fatalf("FreeName = %q", got)
	}
	long := strings.Repeat("x", NameMaxLen)
	_ = s.AddPeer(Peer{Name: long, Addr: "h", Port: 1, Fingerprint: fpOf("cc")})
	if got := s.FreeName(long); ValidName(got) != nil || got == long {
		t.Fatalf("긴 이름의 FreeName = %q", got)
	}
}

// FR-PNW-59: 허용 폴더 판정. 심볼릭 링크를 푼 실제 경로로 본다.
func TestDirAllowed(t *testing.T) {
	root := t.TempDir()
	allowed := filepath.Join(root, "work")
	inside := filepath.Join(allowed, "proj")
	outside := filepath.Join(root, "other")
	for _, d := range []string{inside, outside} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if got, ok := DirAllowed(inside, []string{allowed}); !ok || got == "" {
		t.Fatalf("안쪽 = %q %v", got, ok)
	}
	if _, ok := DirAllowed(allowed, []string{allowed}); !ok {
		t.Fatal("허용 폴더 자신을 거절했다")
	}
	for _, c := range []string{outside, root, allowed + "x", "relative/path", filepath.Join(root, "missing")} {
		if _, ok := DirAllowed(c, []string{allowed}); ok {
			t.Errorf("%q 를 허용했다", c)
		}
	}
	if _, ok := DirAllowed(inside, nil); ok {
		t.Fatal("허용 폴더가 비었는데 허용했다")
	}
	link := filepath.Join(allowed, "escape")
	if err := os.Symlink(outside, link); err == nil {
		if _, ok := DirAllowed(link, []string{allowed}); ok {
			t.Fatal("밖을 가리키는 링크를 허용했다")
		}
	}
}
