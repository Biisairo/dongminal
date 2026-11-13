package claudeacct

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultClaudePaths(t *testing.T) {
	home := t.TempDir()
	p := DefaultClaudePaths(home)
	if p.ConfigHome != filepath.Join(home, ".claude") || p.GlobalConfig != filepath.Join(home, ".claude.json") ||
		p.Credentials != filepath.Join(home, ".claude", ".credentials.json") || p.KeychainService != "Claude Code-credentials" {
		t.Fatalf("%+v", p)
	}
	locks := p.CredLockDirs()
	if len(locks) != 2 || locks[0] != filepath.Join(home, ".claude", ".oauth_refresh.lock") || locks[1] != filepath.Join(home, ".claude.lock") {
		t.Fatalf("locks %v", locks)
	}
	if p.ConfigLockDir() != filepath.Join(home, ".claude.json.lock") {
		t.Fatalf("config lock %s", p.ConfigLockDir())
	}
}

func TestDefaultClaudePathsLegacyConfig(t *testing.T) {
	home := t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, ".claude"), 0o700)
	legacy := filepath.Join(home, ".claude", ".config.json")
	_ = os.WriteFile(legacy, []byte(`{"a":1}`), 0o600)
	if p := DefaultClaudePaths(home); p.GlobalConfig != legacy {
		t.Fatalf("non-empty legacy wins: %s", p.GlobalConfig)
	}
	_ = os.WriteFile(legacy, nil, 0o600)
	_ = os.WriteFile(filepath.Join(home, ".claude.json"), []byte(`{}`), 0o600)
	if p := DefaultClaudePaths(home); p.GlobalConfig != filepath.Join(home, ".claude.json") {
		t.Fatalf("empty legacy with existing global loses: %s", p.GlobalConfig)
	}
}

func TestProfileClaudePaths(t *testing.T) {
	dir := "/tmp/profiles/abc"
	p := ProfileClaudePaths(dir)
	if p.ConfigHome != dir || p.GlobalConfig != filepath.Join(dir, ".claude.json") || p.Credentials != filepath.Join(dir, ".credentials.json") {
		t.Fatalf("%+v", p)
	}
	// sha256("/tmp/profiles/abc") 의 앞 8자 (cswap session.py 와 같은 규칙).
	if p.KeychainService != "Claude Code-credentials-"+profileHash(dir) || len(profileHash(dir)) != 8 {
		t.Fatalf("service %s", p.KeychainService)
	}
	// NFC 정규화: 조합형과 완성형이 같은 해시를 낸다.
	if profileHash("/tmp/한") != profileHash("/tmp/한") {
		t.Fatal("must normalize NFC")
	}
}
