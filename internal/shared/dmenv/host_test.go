package dmenv_test

import (
	"net"
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

// FR-STR-20 · TC-STR-5: **판정과 조립은 다른 일이다.**
//
// `normalizeHost` 가 `[::1]` 의 대괄호를 떼는 것은 판정에 맞고, 조립에는 붙이는
// 것이 맞다. 둘이 한 함수의 출력을 공유하는 동안 `DONGMINAL_HOST=::1` 로는
// 서버가 뜨지 않았다 — 문서가 지원한다고 적은 값인데도.
func TestListenAddr(t *testing.T) {
	for _, tc := range []struct{ host, port, want string }{
		// IPv6 는 대괄호가 필요하다. 이것이 이 함수가 생긴 이유다.
		{"::1", "9911", "[::1]:9911"},
		{"[::1]", "9911", "[::1]:9911"},
		{"::", "9911", "[::]:9911"},
		// 바인드는 **사용자가 적은 그 주소**에 한다 — 미지정을 loopback 으로
		// 바꾸는 것은 두드리는 쪽의 일이다 (DialHost).
		{"0.0.0.0", "9911", "0.0.0.0:9911"},
		{"127.0.0.1", "9911", "127.0.0.1:9911"},
		{"localhost", "9911", "localhost:9911"},
		// 빈 host 는 모든 인터페이스다 — 종전 접합(`""+":"+port`)과 같은 값이다.
		{"", "9911", ":9911"},
	} {
		if got := dmenv.ListenAddr(tc.host, tc.port); got != tc.want {
			t.Errorf("ListenAddr(%q, %q) = %q, want %q", tc.host, tc.port, got, tc.want)
		}
	}
}

// ListenAddr 의 결과는 **net.Listen 이 실제로 받는 것**이어야 한다. 값 비교만
// 하면 다음 사람이 형식을 바꿨을 때 이 검사가 함께 틀린다.
func TestListenAddrIsDialable(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "::1"} {
		ln, err := net.Listen("tcp", dmenv.ListenAddr(host, "0"))
		if err != nil {
			t.Errorf("net.Listen(%q) 실패: %v", dmenv.ListenAddr(host, "0"), err)
			continue
		}
		ln.Close()
	}
}

// FR-STR-20 · TC-STR-5: 두드리는 주소는 DialHost 를 지난 뒤 대괄호를 되붙인다.
func TestBaseURL(t *testing.T) {
	for _, tc := range []struct{ host, port, want string }{
		{"0.0.0.0", "9911", "http://127.0.0.1:9911"},
		{"::", "9911", "http://127.0.0.1:9911"},
		{"", "9911", "http://127.0.0.1:9911"},
		{"::1", "9911", "http://[::1]:9911"},
		{"192.168.1.5", "9911", "http://192.168.1.5:9911"},
		{"localhost", "9911", "http://localhost:9911"},
	} {
		if got := dmenv.BaseURL(tc.host, tc.port); got != tc.want {
			t.Errorf("BaseURL(%q, %q) = %q, want %q", tc.host, tc.port, got, tc.want)
		}
	}
}
