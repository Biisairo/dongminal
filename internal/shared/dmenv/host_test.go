package dmenv_test

import (
	"testing"

	"dongminal/internal/shared/dmenv"
)

// TLS-2: 노출 판정이 **한 벌**이다.
//
// 종전에는 두 벌이었다 — `start.go:154`·`main.go:573` 은 `0.0.0.0`/`::` 만 노출로
// 보아 `DONGMINAL_HOST=192.168.1.5` 를 `local-only` 로 **거짓 표시**했고,
// `start.go:53` 의 ACL 게이트는 `host != DefaultHost` 로 보아 `::1` 바인드를
// **ACL 로 막았다**. 같은 물음에 두 답이 나오던 자리다.
func TestIsExposedHost(t *testing.T) {
	for _, tc := range []struct {
		host string
		want bool
	}{
		// 로컬 — 이 기계 밖에서 닿지 않는다.
		{"127.0.0.1", false},
		{"127.0.0.53", false},
		{"::1", false},
		{"localhost", false},
		{"LocalHost", false},
		{"[::1]", false},
		{"", false}, // 비면 DefaultHost 다

		// 노출 — 이 기계 밖에서 닿는다.
		{"0.0.0.0", true},
		{"::", true},
		{"[::]", true},
		{"192.168.1.5", true},
		{"10.0.0.2", true},
		{"172.16.0.1", true},
		{"8.8.8.8", true},
		{"fe80::1", true},
		{"myhost.local", true}, // 해석되지 않는 이름은 보수적으로 노출로 본다
	} {
		if got := dmenv.IsExposedHost(tc.host); got != tc.want {
			t.Errorf("IsExposedHost(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}
}

// 두드릴 주소는 노출 여부가 아니라 **미지정 주소인가**로 갈린다.
// `0.0.0.0` 은 바인드 대상이지 접속 대상이 아니다.
func TestDialHost(t *testing.T) {
	for _, tc := range []struct{ host, want string }{
		{"0.0.0.0", dmenv.DefaultHost},
		{"::", dmenv.DefaultHost},
		{"[::]", dmenv.DefaultHost},
		{"", dmenv.DefaultHost},
		{"192.168.1.5", "192.168.1.5"},
		{"127.0.0.1", "127.0.0.1"},
		{"::1", "::1"},
		{"localhost", "localhost"},
	} {
		if got := dmenv.DialHost(tc.host); got != tc.want {
			t.Errorf("DialHost(%q) = %q, want %q", tc.host, got, tc.want)
		}
	}
}

// 표시 문구도 한 자리에서 나온다 — `start.go` 와 `main.go` 가 각자 문자열을
// 만들면 또 갈린다.
func TestExposureLabel(t *testing.T) {
	if got := dmenv.ExposureLabel("127.0.0.1"); got != "local-only" {
		t.Errorf("ExposureLabel(loopback) = %q", got)
	}
	if got := dmenv.ExposureLabel("192.168.1.5"); got != "exposed" {
		t.Errorf("ExposureLabel(lan) = %q", got)
	}
}
