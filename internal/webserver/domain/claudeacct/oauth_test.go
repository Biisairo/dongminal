package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TC-CAC-9: 갱신 요청 본문과 영구·일시 실패.

func TestClientRefresh(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/oauth/token" || r.Method != http.MethodPost {
			w.WriteHeader(404)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"access_token":"new-at","refresh_token":"new-rt","expires_in":3600,"scope":"user:inference user:profile"}`))
	}))
	defer srv.Close()
	tr, err := Client{TokenBase: srv.URL}.Refresh(context.Background(), "old-rt")
	if err != nil {
		t.Fatal(err)
	}
	if body["grant_type"] != "refresh_token" || body["refresh_token"] != "old-rt" || body["client_id"] != oauthClientID {
		t.Fatalf("body %v", body)
	}
	if tr.AccessToken != "new-at" || tr.RefreshToken != "new-rt" || tr.ExpiresIn != 3600 || len(tr.Scopes) != 2 {
		t.Fatalf("%+v", tr)
	}
}

func TestClientRefreshErrors(t *testing.T) {
	cases := map[string]struct {
		status    int
		body      string
		permanent bool
	}{
		"invalid_grant":  {400, `{"error":"invalid_grant"}`, true},
		"invalid_client": {401, `{"error":"invalid_client"}`, true},
		"other 400":      {400, `{"error":"invalid_request"}`, false},
		"marker in text": {400, `{"error":"x","error_description":"invalid_grant"}`, false},
		"500":            {500, `{"error":"invalid_grant"}`, false},
		"garbage":        {403, `<html>`, false},
	}
	for name, c := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		}))
		_, err := Client{TokenBase: srv.URL}.Refresh(context.Background(), "rt")
		srv.Close()
		if err == nil {
			t.Fatalf("%s: want error", name)
		}
		if errors.Is(err, ErrReloginRequired) != c.permanent {
			t.Fatalf("%s: permanent=%v err=%v", name, c.permanent, err)
		}
	}
}

func TestCredentialWithTokens(t *testing.T) {
	c, _ := ParseCredential([]byte(credJSON("at", "rt", `"mcpOAuth":{"m":1}`)))
	n := c.WithTokens(TokenResult{AccessToken: "a2", ExpiresIn: 60, Scopes: []string{"s"}}, 1_000_000)
	if n.AccessToken() != "a2" || n.RefreshToken() != "rt" || n.ExpiresAt() != 1_000_000+60_000 {
		t.Fatalf("%q %q %d", n.AccessToken(), n.RefreshToken(), n.ExpiresAt())
	}
	n = c.WithTokens(TokenResult{AccessToken: "a3", RefreshToken: "r3", ExpiresIn: 60}, 0)
	if n.RefreshToken() != "r3" {
		t.Fatal("refresh token replaced when returned")
	}
	b, _ := n.Marshal()
	var m map[string]json.RawMessage
	_ = json.Unmarshal(b, &m)
	if string(m["mcpOAuth"]) != `{"m":1}` {
		t.Fatal("other fields kept")
	}
	if c.AccessToken() != "at" {
		t.Fatal("original untouched")
	}
}
