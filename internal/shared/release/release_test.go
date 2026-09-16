package release

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewerIsSemVerNotString(t *testing.T) {
	for _, tc := range []struct {
		a, b string
		want bool
	}{
		{"v1.10.0", "v1.9.0", true},
		{"v1.9.0", "v1.10.0", false},
		{"v2.0.0", "v1.99.99", true},
		{"v1.0.1", "v1.0.0", true},
		{"v1.0.0", "v1.0.0", false},
		{"1.2.3", "v1.2.2", true},
		{"v1.2.3-rc1", "v1.2.3", false},
	} {
		if got := Newer(tc.a, tc.b); got != tc.want {
			t.Errorf("Newer(%q,%q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestComparable(t *testing.T) {
	for _, tc := range []struct {
		v    string
		want bool
	}{{"v1.0.0", true}, {"dev", false}, {"", false}, {"  ", false}} {
		if got := Comparable(tc.v); got != tc.want {
			t.Errorf("Comparable(%q) = %v", tc.v, got)
		}
	}
}

func TestLatestReadsTagAndLink(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Accept"); got != "application/vnd.github+json" {
			t.Errorf("Accept=%q", got)
		}
		w.Write([]byte(`{"tag_name":"v9.9.9","html_url":"https://example/rel"}`))
	}))
	defer srv.Close()
	tag, link, err := Latest(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if tag != "v9.9.9" || link != "https://example/rel" {
		t.Errorf("tag=%q link=%q", tag, link)
	}
}

// NFR-UPD-4: 요청이 나르는 것은 Accept 한 줄뿐이다.
func TestLatestSendsNoIdentity(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		w.Write([]byte(`{"tag_name":"v1.0.0"}`))
	}))
	defer srv.Close()
	if _, _, err := Latest(srv.URL); err != nil {
		t.Fatal(err)
	}
	for k := range seen {
		switch http.CanonicalHeaderKey(k) {
		case "Accept", "User-Agent", "Accept-Encoding":
		default:
			t.Errorf("보내지 않아야 할 헤더: %s", k)
		}
	}
}

func TestLatestRejectsEmptyTag(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":""}`))
	}))
	defer srv.Close()
	if _, _, err := Latest(srv.URL); err == nil {
		t.Error("빈 태그를 통과시켰다")
	}
}

func TestLatestRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
	}))
	defer srv.Close()
	if _, _, err := Latest(srv.URL); err == nil {
		t.Error("403 을 통과시켰다")
	}
}
