package claudeacct

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientProfile(t *testing.T) {
	var gotAuth, gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/oauth/profile" {
			w.WriteHeader(404)
			return
		}
		gotAuth, gotUA = r.Header.Get("Authorization"), r.Header.Get("User-Agent")
		_, _ = w.Write([]byte(`{"account":{"uuid":" acc-1 ","email":"a@x.com"},"organization":{"uuid":"org-1"}}`))
	}))
	defer srv.Close()
	c := Client{Base: srv.URL, UserAgent: "dongminal/test"}
	id, err := c.Profile(context.Background(), "tok")
	if err != nil {
		t.Fatal(err)
	}
	if id != (Identity{AccountUUID: "acc-1", Email: "a@x.com", OrgUUID: "org-1"}) {
		t.Fatalf("%+v", id)
	}
	if gotAuth != "Bearer tok" || gotUA != "dongminal/test" {
		t.Fatalf("headers %q %q", gotAuth, gotUA)
	}
}

func TestClientProfileErrors(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"401":     func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) },
		"no uuid": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"account":{"email":"a"}}`)) },
		"garbage": func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`<html>`)) },
	} {
		srv := httptest.NewServer(h)
		_, err := Client{Base: srv.URL}.Profile(context.Background(), "secret-token")
		srv.Close()
		if err == nil {
			t.Fatalf("%s: want error", name)
		}
		var se *HTTPStatusError
		if name == "401" && (!errors.As(err, &se) || se.Status != 401) {
			t.Fatalf("401 must be HTTPStatusError: %v", err)
		}
		if contains(err.Error(), "secret-token") {
			t.Fatal("error leaks token")
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
