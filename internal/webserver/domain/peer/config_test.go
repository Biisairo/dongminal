package peer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
