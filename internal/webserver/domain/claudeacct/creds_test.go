package claudeacct

import (
	"encoding/json"
	"strings"
	"testing"
)

// TC-CAC-3: 모르는 필드 보존, 공유 필드 병합과 삭제. TC-CAC-4 의 지문.

func credJSON(access, refresh string, extra string) string {
	s := `{"claudeAiOauth":{"accessToken":"` + access + `","refreshToken":"` + refresh + `","expiresAt":1700000000000,"refreshTokenExpiresAt":1800000000000,"scopes":["user:inference","user:profile"],"subscriptionType":"max","futureField":7}`
	if extra != "" {
		s += "," + extra
	}
	return s + "}"
}

func TestCredentialRoundTripKeepsUnknown(t *testing.T) {
	c, err := ParseCredential([]byte(credJSON("at", "rt", `"trustedDeviceToken":"tdt","newTop":{"x":1}`)))
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessToken() != "at" || c.RefreshToken() != "rt" || c.ExpiresAt() != 1700000000000 || c.RefreshTokenExpiresAt() != 1800000000000 {
		t.Fatalf("fields %q %q %d %d", c.AccessToken(), c.RefreshToken(), c.ExpiresAt(), c.RefreshTokenExpiresAt())
	}
	b, err := c.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["newTop"] == nil || m["trustedDeviceToken"] != "tdt" {
		t.Fatalf("top lost: %s", b)
	}
	o := m["claudeAiOauth"].(map[string]any)
	if o["futureField"] != float64(7) || o["subscriptionType"] != "max" {
		t.Fatalf("oauth lost: %s", b)
	}
}

func TestCredentialParseRejectsNonObject(t *testing.T) {
	for _, s := range []string{"", "null", "[]", "\"x\"", "{bad"} {
		if _, err := ParseCredential([]byte(s)); err == nil {
			t.Fatalf("%q must fail", s)
		}
	}
}

func TestCredentialEmpty(t *testing.T) {
	c, _ := ParseCredential([]byte(`{}`))
	if !c.IsEmpty() {
		t.Fatal("no oauth is empty")
	}
	c, _ = ParseCredential([]byte(`{"claudeAiOauth":{"accessToken":"","refreshToken":""}}`))
	if !c.IsEmpty() {
		t.Fatal("blank tokens is empty")
	}
	c, _ = ParseCredential([]byte(credJSON("a", "", "")))
	if c.IsEmpty() {
		t.Fatal("access only is not empty")
	}
}

func TestCredentialFingerprint(t *testing.T) {
	a, _ := ParseCredential([]byte(credJSON("at1", "rt", "")))
	b, _ := ParseCredential([]byte(credJSON("at2", "rt", "")))
	c, _ := ParseCredential([]byte(credJSON("at1", "rt2", "")))
	if a.Fingerprint() != b.Fingerprint() {
		t.Fatal("same refresh token → same fingerprint")
	}
	if a.Fingerprint() == c.Fingerprint() {
		t.Fatal("different refresh token → different fingerprint")
	}
	if len(a.Fingerprint()) != 12 || strings.Contains(a.Fingerprint(), "rt") {
		t.Fatalf("fingerprint %q", a.Fingerprint())
	}
	e, _ := ParseCredential([]byte(`{}`))
	if e.Fingerprint() != "" {
		t.Fatal("empty has no fingerprint")
	}
}

func TestCredentialWithShared(t *testing.T) {
	target, _ := ParseCredential([]byte(credJSON("t", "tr", `"mcpOAuth":{"old":1},"pluginSecrets":{"p":1},"trustedDeviceToken":"target-tdt"`)))
	live, _ := ParseCredential([]byte(credJSON("l", "lr", `"mcpOAuth":{"new":2},"mcpXaaIdp":{"z":3},"trustedDeviceToken":"live-tdt"`)))
	got := target.WithShared(live)
	b, _ := got.Marshal()
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if mo := m["mcpOAuth"].(map[string]any); mo["new"] != float64(2) {
		t.Fatalf("mcpOAuth must come from live: %s", b)
	}
	if m["mcpXaaIdp"] == nil {
		t.Fatalf("live-only shared field must be added: %s", b)
	}
	if _, ok := m["pluginSecrets"]; ok {
		t.Fatalf("shared field absent on live must be removed: %s", b)
	}
	if m["trustedDeviceToken"] != "target-tdt" || got.AccessToken() != "t" {
		t.Fatalf("account fields must stay with target: %s", b)
	}
}
