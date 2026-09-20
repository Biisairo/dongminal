package dmenv

import (
	"net"
	"net/netip"
	"strings"
)

// 이 파일은 **바인드 주소 하나를 읽는 방법**이다 (TLS-2).
//
// 종전에는 같은 물음에 두 답이 있었다. `start.go`·`main.go` 의 표시는
// `0.0.0.0`/`::` 만 노출로 보아 `DONGMINAL_HOST=192.168.1.5` 를 `local-only` 라
// **거짓으로** 찍었고, `start.go` 의 ACL 게이트는 `host != DefaultHost` 로 보아
// `::1` 바인드까지 허용 목록을 강제했다. 판정이 갈리면 한쪽을 고쳐도 다른 쪽이
// 남는다 — 그래서 한 함수로 모은다.
//
// **여기에 TLS 는 없다.** 기밀성은 제품이 제공하지 않고 오버레이 망에 위임한다
// (결정 9). 이 파일이 답하는 것은 "이 바인드가 이 기계 밖에서 닿는가" 하나다.

// normalizeHost 는 대괄호·대소문자·후행 점을 걷어낸다.
// `[::1]` 과 `::1` 은 같은 주소이고, `LocalHost` 와 `localhost` 도 같다.
func normalizeHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	h = strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
	return strings.TrimSuffix(h, ".")
}

// IsUnspecifiedHost 는 host 가 **모든 인터페이스**를 뜻하는 미지정 주소인지 본다
// (`0.0.0.0`·`::`). 바인드 대상이지 접속 대상이 아닌 주소다.
func IsUnspecifiedHost(host string) bool {
	addr, err := netip.ParseAddr(normalizeHost(host))
	return err == nil && addr.IsUnspecified()
}

// IsExposedHost 는 host 에 바인드했을 때 **이 기계 밖에서 닿는지** 본다.
//
// loopback 만 로컬이다. 종전의 "`0.0.0.0`/`::` 만 노출" 도, "`DefaultHost` 가
// 아니면 노출" 도 아니다 — 앞의 것은 `192.168.x` 를 놓치고 뒤의 것은 `::1` 을
// 잘못 잡는다.
//
// 해석되지 않는 이름은 **노출로 본다.** 여기서 DNS 를 두드릴 수는 없고
// (이 패키지는 의존이 없고 판정은 요청 경로에서도 쓰인다), 틀릴 때의 대가가
// 한쪽으로 기운다 — 로컬을 노출로 보면 ACL 을 한 번 더 요구할 뿐이지만
// 노출을 로컬로 보면 무단 기기에 문이 열린다.
func IsExposedHost(host string) bool {
	h := normalizeHost(host)
	if h == "" {
		h = DefaultHost
	}
	if h == "localhost" {
		return false
	}
	if addr, err := netip.ParseAddr(h); err == nil {
		return !addr.IsLoopback()
	}
	return true
}

// DialHost 는 host 에 뜬 서버를 실제로 두드릴 주소다.
//
// 갈리는 기준이 IsExposedHost 와 **다르다** — 미지정 주소만 바꿔 준다.
// `192.168.1.5` 는 노출이지만 그 주소로 두드리면 된다.
func DialHost(host string) string {
	h := normalizeHost(host)
	if h == "" || IsUnspecifiedHost(h) {
		return DefaultHost
	}
	return h
}

// ListenAddr 는 net.Listen 에 그대로 넘길 주소다.
//
// **판정과 조립은 다른 일이다.** normalizeHost 가 `[::1]` 의 대괄호를 떼는 것은
// 판정(IsExposedHost·DialHost)에 맞는 일이고, 조립에는 붙이는 것이 맞다. 둘이
// 한 함수의 출력을 공유하면 한쪽이 언제나 틀린다:
//
//	net.Listen("tcp", "::1:9911")   -> too many colons in address
//	net.Listen("tcp", "[::1]:9911") -> ok
//
// `DONGMINAL_HOST=::1` 은 문서가 지원한다고 적은 값이다 (getting-started 의
// loopback 셋). 종전에는 그 값으로 기동하면 자식이 net.Listen 에서 죽고 부모는
// "기동 실패" 만 냈다 — **어느 값이 문제인지가 없었다.**
//
// host 를 미지정 주소로 바꾸지 않는 이유: 바인드는 사용자가 적은 그 주소에 해야
// 한다. 미지정을 loopback 으로 바꿔 주는 것은 **두드리는 쪽**의 일이다 (DialHost).
func ListenAddr(host, port string) string {
	return net.JoinHostPort(normalizeHost(host), port)
}

// BaseURL 은 그 서버를 두드릴 http URL 이다. DialHost 를 지난 뒤 대괄호를 되붙인다.
//
// 여기에 TLS 는 없다 — 기밀성은 제품이 제공하지 않고 오버레이 망에 위임한다
// (결정 9). 이 파일의 머리말과 같은 이유다.
func BaseURL(host, port string) string {
	return "http://" + net.JoinHostPort(DialHost(host), port)
}

// ExposureLabel 은 기동 로그와 `start` 출력이 함께 쓰는 표시다.
// 문구를 각자 만들면 또 갈린다.
func ExposureLabel(host string) string {
	if IsExposedHost(host) {
		return "exposed"
	}
	return "local-only"
}
