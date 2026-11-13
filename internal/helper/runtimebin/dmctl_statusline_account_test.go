package runtimebin

import (
	"os"
	"path/filepath"
	"testing"
)

// CLAUDE_ACCOUNTS_SRS TC-CAC-29: statusLine 보고에 그 세션의 계정을 싣는다 (FR-CAC-78).

func writeClaudeJSON(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestStatuslineAccount(t *testing.T) {
	home, prof := t.TempDir(), t.TempDir()
	writeClaudeJSON(t, home, `{"oauthAccount":{"emailAddress":"a@x.com","organizationUuid":"org-a"},"theme":"dark"}`)
	writeClaudeJSON(t, prof, `{"oauthAccount":{"emailAddress":"b@x.com","organizationUuid":"org-b"}}`)

	a := statuslineAccount(map[string]string{"HOME": home})
	if a == nil || a.Email != "a@x.com" || a.OrgUUID != "org-a" {
		t.Fatalf("default config: %+v", a)
	}
	a = statuslineAccount(map[string]string{"HOME": home, "CLAUDE_CONFIG_DIR": prof})
	if a == nil || a.Email != "b@x.com" {
		t.Fatalf("CLAUDE_CONFIG_DIR wins: %+v", a)
	}
	if a := statuslineAccount(map[string]string{"HOME": t.TempDir()}); a != nil {
		t.Fatalf("missing file: %+v", a)
	}
	empty := t.TempDir()
	writeClaudeJSON(t, empty, `{"oauthAccount":{"organizationUuid":"o"}}`)
	if a := statuslineAccount(map[string]string{"HOME": empty}); a != nil {
		t.Fatalf("no email: %+v", a)
	}
	writeClaudeJSON(t, empty, `not json`)
	if a := statuslineAccount(map[string]string{"HOME": empty}); a != nil {
		t.Fatalf("broken: %+v", a)
	}
}
