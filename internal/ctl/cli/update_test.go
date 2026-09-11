package cli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// M5 `G3-3` — `dongminal update --check`.
//
// **옵트인이다.** 이 제품은 스스로 판을 확인하지 않는다 — 상시 노출된 작업
// 도구가 묻지 않고 밖으로 나가면, 그 사실 자체가 사용자가 통제하지 못하는
// 트래픽이 된다.

func releaseServer(t *testing.T, tag string) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tag_name":"` + tag + `","html_url":"https://example/rel/` + tag + `"}`))
	}))
	t.Cleanup(s.Close)
	return s
}

func TestUpdateCheckReportsNewer(t *testing.T) {
	srv := releaseServer(t, "v9.9.9")
	var out, errw bytes.Buffer
	o, err := ParseUpdate([]string{"--check"})
	if err != nil {
		t.Fatal(err)
	}
	o.endpoint = srv.URL
	if code := runUpdateWith(o, "v1.0.0", &out, &errw); code != 0 {
		t.Fatalf("exit %d: %s", code, errw.String())
	}
	s := out.String()
	for _, want := range []string{"v9.9.9", "v1.0.0"} {
		if !strings.Contains(s, want) {
			t.Errorf("%q 가 없다:\n%s", want, s)
		}
	}
}

func TestUpdateCheckSaysUpToDate(t *testing.T) {
	srv := releaseServer(t, "v1.0.0")
	var out, errw bytes.Buffer
	o, _ := ParseUpdate([]string{"--check"})
	o.endpoint = srv.URL
	if code := runUpdateWith(o, "v1.0.0", &out, &errw); code != 0 {
		t.Fatalf("exit %d: %s", code, errw.String())
	}
	if !strings.Contains(out.String(), "최신") {
		t.Errorf("최신임을 말하지 않았다:\n%s", out.String())
	}
}

// 개발 빌드(`dev`)는 **견줄 기준이 없다.** 그것을 "뒤졌다" 로 말하면 거짓이다.
func TestUpdateCheckDevBuild(t *testing.T) {
	srv := releaseServer(t, "v1.0.0")
	var out, errw bytes.Buffer
	o, _ := ParseUpdate([]string{"--check"})
	o.endpoint = srv.URL
	runUpdateWith(o, "dev", &out, &errw)
	if !strings.Contains(out.String()+errw.String(), "개발") {
		t.Errorf("개발 빌드임을 말하지 않았다:\n%s%s", out.String(), errw.String())
	}
}

// **`--check` 없이는 밖으로 나가지 않는다.** 옵트인이 이 명령의 계약이다.
func TestUpdateWithoutCheckDoesNotFetch(t *testing.T) {
	var hit int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit++
	}))
	defer srv.Close()

	var out, errw bytes.Buffer
	o, _ := ParseUpdate(nil)
	o.endpoint = srv.URL
	runUpdateWith(o, "v1.0.0", &out, &errw)
	if hit != 0 {
		t.Errorf("--check 없이 %d회 나갔다", hit)
	}
	if !strings.Contains(out.String()+errw.String(), "--check") {
		t.Error("무엇을 해야 하는지 말하지 않았다")
	}
}

// 그물이 끊겨도 **실패로 끝나되 조용하다.** 판 확인이 안 된다고 해서 사용자가
// 할 일이 생기지는 않는다.
func TestUpdateCheckNetworkFailure(t *testing.T) {
	var out, errw bytes.Buffer
	o, _ := ParseUpdate([]string{"--check"})
	o.endpoint = "http://127.0.0.1:1/nope"
	if code := runUpdateWith(o, "v1.0.0", &out, &errw); code == 0 {
		t.Error("닿지 못했는데 성공으로 끝났다")
	}
	if strings.Contains(errw.String(), "panic") {
		t.Error("패닉")
	}
}

// 판 비교는 SemVer 다 — 문자열 비교면 `v1.10.0` 이 `v1.9.0` 보다 작아진다.
func TestVersionNewer(t *testing.T) {
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
	} {
		if got := versionNewer(tc.a, tc.b); got != tc.want {
			t.Errorf("versionNewer(%q,%q) = %v, want %v", tc.a, tc.b, got, tc.want)
		}
	}
}
