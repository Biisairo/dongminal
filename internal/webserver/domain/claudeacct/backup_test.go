package claudeacct

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBackupKeychainRoundTripAndPrev(t *testing.T) {
	sec := newMemSecrets()
	b := BackupStore{Dir: t.TempDir(), Sec: sec}
	c1, _ := ParseCredential([]byte(credJSON("a1", "r1", "")))
	c2, _ := ParseCredential([]byte(credJSON("a2", "r2", "")))
	if err := b.Write("id1", c1); err != nil {
		t.Fatal(err)
	}
	if err := b.Write("id1", c2); err != nil {
		t.Fatal(err)
	}
	got, ok, err := b.Read("id1")
	if err != nil || !ok || got.AccessToken() != "a2" {
		t.Fatalf("%v %v %q", ok, err, got.AccessToken())
	}
	prev, ok, _ := b.ReadPrev("id1")
	if !ok || prev.AccessToken() != "a1" {
		t.Fatalf("prev %v %q", ok, prev.AccessToken())
	}
	if v, ok := sec.items[sec.key(backupService, "account-id1")]; !ok || v == "" {
		t.Fatal("must live in keychain under dongminal service")
	}
	if _, err := os.Stat(filepath.Join(b.Dir, "credentials", "id1.json")); !os.IsNotExist(err) {
		t.Fatal("no file when keychain works")
	}
}

func TestBackupFileWhenNoKeychain(t *testing.T) {
	sec := newMemSecrets()
	sec.off = true
	b := BackupStore{Dir: t.TempDir(), Sec: sec}
	c, _ := ParseCredential([]byte(credJSON("a", "r", "")))
	if err := b.Write("x", c); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(b.Dir, "credentials", "x.json")
	st, err := os.Stat(p)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", err, st)
	}
	if dst, _ := os.Stat(filepath.Join(b.Dir, "credentials")); dst.Mode().Perm() != 0o700 {
		t.Fatalf("dir perm %v", dst.Mode())
	}
	got, ok, _ := b.Read("x")
	if !ok || got.AccessToken() != "a" {
		t.Fatal("read back")
	}
}

func TestBackupKeychainFailureFallsBackToFile(t *testing.T) {
	sec := newMemSecrets()
	b := BackupStore{Dir: t.TempDir(), Sec: sec}
	sec.items[sec.key(backupService, "account-x")] = credJSON("stale", "r", "")
	sec.failSet = true
	c, _ := ParseCredential([]byte(credJSON("new", "r", "")))
	if err := b.Write("x", c); err != nil {
		t.Fatal(err)
	}
	if _, ok := sec.items[sec.key(backupService, "account-x")]; ok {
		t.Fatal("keychain item must be deleted after falling back")
	}
	got, _, _ := b.Read("x")
	if got.AccessToken() != "new" {
		t.Fatalf("file must win: %q", got.AccessToken())
	}
}

func TestBackupDelete(t *testing.T) {
	sec := newMemSecrets()
	b := BackupStore{Dir: t.TempDir(), Sec: sec}
	c, _ := ParseCredential([]byte(credJSON("a", "r", "")))
	_ = b.Write("x", c)
	_ = b.Write("x", c)
	if err := b.Delete("x"); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := b.Read("x"); ok {
		t.Fatal("deleted")
	}
	if _, ok, _ := b.ReadPrev("x"); ok {
		t.Fatal("prev deleted")
	}
	if len(sec.items) != 0 {
		t.Fatalf("items %v", sec.items)
	}
}

func TestBackupRejectsBadID(t *testing.T) {
	b := BackupStore{Dir: t.TempDir(), Sec: newMemSecrets()}
	c, _ := ParseCredential([]byte(credJSON("a", "r", "")))
	if err := b.Write("../x", c); err == nil {
		t.Fatal("path traversal id must fail")
	}
}
