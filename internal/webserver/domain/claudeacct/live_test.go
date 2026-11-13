package claudeacct

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TC-CAC-2: 활성 저장소 읽기 순서와 쓰기 규칙 (FR-CAC-5·6).

func newLive(t *testing.T, sec *memSecrets) (LiveStore, ClaudePaths) {
	t.Helper()
	p := DefaultClaudePaths(t.TempDir())
	return LiveStore{Paths: p, Sec: sec, RetryDelay: time.Millisecond}, p
}

func TestLiveReadKeychainFirst(t *testing.T) {
	sec := newMemSecrets()
	l, p := newLive(t, sec)
	_ = sec.Set(p.KeychainService, sec.Account(), credJSON("kc", "r", ""))
	_ = os.MkdirAll(p.ConfigHome, 0o700)
	_ = os.WriteFile(p.Credentials, []byte(credJSON("file", "r", "")), 0o600)
	c, ok, err := l.Read()
	if err != nil || !ok || c.AccessToken() != "kc" {
		t.Fatalf("%v %v %q", ok, err, c.AccessToken())
	}
}

func TestLiveReadFallsBackToFile(t *testing.T) {
	sec := newMemSecrets()
	l, p := newLive(t, sec)
	_ = os.MkdirAll(p.ConfigHome, 0o700)
	_ = os.WriteFile(p.Credentials, []byte(credJSON("file", "r", "")), 0o600)
	c, ok, err := l.Read()
	if err != nil || !ok || c.AccessToken() != "file" {
		t.Fatalf("%v %v %q", ok, err, c.AccessToken())
	}
	sec.off = true
	c, ok, err = l.Read()
	if err != nil || !ok || c.AccessToken() != "file" {
		t.Fatalf("no keychain: %v %v %q", ok, err, c.AccessToken())
	}
}

func TestLiveReadNothing(t *testing.T) {
	l, _ := newLive(t, newMemSecrets())
	_, ok, err := l.Read()
	if ok || err != nil {
		t.Fatalf("%v %v", ok, err)
	}
}

func TestLiveReadKeychainErrorWithoutFile(t *testing.T) {
	sec := newMemSecrets()
	sec.failGet = true
	l, _ := newLive(t, sec)
	if _, _, err := l.Read(); err == nil {
		t.Fatal("keychain error and no file must be an error")
	}
}

func TestLiveWriteKeychainTouchesExistingFile(t *testing.T) {
	sec := newMemSecrets()
	l, p := newLive(t, sec)
	_ = os.MkdirAll(p.ConfigHome, 0o700)
	_ = os.WriteFile(p.Credentials, []byte(credJSON("old", "r", "")), 0o600)
	c, _ := ParseCredential([]byte(credJSON("new", "r2", "")))
	if err := l.Write(c); err != nil {
		t.Fatal(err)
	}
	v, _, _ := sec.Get(p.KeychainService, sec.Account())
	got, _ := ParseCredential([]byte(v))
	if got.AccessToken() != "new" {
		t.Fatalf("keychain %q", v)
	}
	b, _ := os.ReadFile(p.Credentials)
	f, _ := ParseCredential(b)
	if f.AccessToken() != "new" {
		t.Fatalf("existing file must be rewritten: %s", b)
	}
	if st, _ := os.Stat(p.Credentials); st.Mode().Perm() != 0o600 {
		t.Fatalf("perm %v", st.Mode())
	}
}

func TestLiveWriteKeychainDoesNotCreateFile(t *testing.T) {
	sec := newMemSecrets()
	l, p := newLive(t, sec)
	c, _ := ParseCredential([]byte(credJSON("new", "r", "")))
	if err := l.Write(c); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p.Credentials); !os.IsNotExist(err) {
		t.Fatal("file must not be created when keychain write succeeds")
	}
}

func TestLiveWriteKeychainFailureFallsBackToFile(t *testing.T) {
	sec := newMemSecrets()
	l, p := newLive(t, sec)
	sec.items[sec.key(p.KeychainService, sec.Account())] = credJSON("stale", "r", "")
	sec.failSet = true
	c, _ := ParseCredential([]byte(credJSON("new", "r", "")))
	if err := l.Write(c); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(p.Credentials)
	if err != nil {
		t.Fatal(err)
	}
	if f, _ := ParseCredential(b); f.AccessToken() != "new" {
		t.Fatalf("file %s", b)
	}
	if _, ok := sec.items[sec.key(p.KeychainService, sec.Account())]; ok {
		t.Fatal("stale keychain item must be deleted")
	}
}

func TestLiveWriteNoKeychain(t *testing.T) {
	sec := newMemSecrets()
	sec.off = true
	l, p := newLive(t, sec)
	c, _ := ParseCredential([]byte(credJSON("new", "r", "")))
	if err := l.Write(c); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(p.ConfigHome, ".credentials.json")); err != nil {
		t.Fatal(err)
	}
}
