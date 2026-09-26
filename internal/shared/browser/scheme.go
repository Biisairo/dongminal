package browser

import (
	"errors"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
)

// CheckURL 은 브라우저 탭이 **열 수 있는** 주소인가다 (FR-BRT-65, D-BRT-8).
// `http`·`https`·`file`·`about:blank` 만 받는다 — 사람과 에이전트가 이미 가진 권한을
// 넘지 않는다. 페이지 안의 이동은 이 판정의 대상이 아니다(Chrome 의 규칙).
func CheckURL(raw string) error {
	if raw == "about:blank" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" {
		return errors.New("열 수 없는 주소입니다: " + raw)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
		if u.Host == "" {
			return errors.New("호스트가 없는 주소입니다: " + raw)
		}
		return nil
	case "file":
		return nil
	}
	return errors.New("브라우저 탭은 http·https·file·about:blank 만 엽니다 (" + u.Scheme + ": 는 열지 않습니다)")
}

// hostPortRe 는 스킴 없이 적은 `host:port[/…]` 다 — `localhost:3000` 이 흔하다.
// 호스트는 `localhost` 이거나 점을 가진다 — 그래야 `javascript:1` 이 주소로 읽히지 않는다.
var hostPortRe = regexp.MustCompile(`^(localhost|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+):[0-9]{1,5}(/.*)?$`)

// ResolveTarget 은 `dmctl browser open` 과 쉘 훅의 인자를 열 주소로 바꾼다
// (FR-BRT-66). URL 이 아니면 **경로**로 읽어 cwd 기준 절대 경로의 `file://` 로
// 바꾼다. 없는 경로는 거절한다.
//
// exists 는 "그 경로가 있는가" 다 (nil 이면 있다). 경로는 호출한 셸이 사는 기기 —
// 서버 — 에서 본다.
func ResolveTarget(arg, cwd string, exists func(string) error) (string, error) {
	arg = strings.TrimSpace(arg)
	if arg == "" {
		return "", errors.New("열 주소가 없습니다")
	}
	if hasScheme(arg) {
		return arg, CheckURL(arg)
	}
	if hostPortRe.MatchString(arg) {
		u := "http://" + arg
		return u, CheckURL(u)
	}
	p := arg
	if !filepath.IsAbs(p) && filepath.VolumeName(p) == "" {
		p = filepath.Join(cwd, p)
	}
	if err := exists(p); err != nil {
		return "", errors.New("없는 경로입니다: " + p)
	}
	return fileURL(p), nil
}

// hasScheme 은 인자가 스킴을 가진 URL 인가다. 한 글자 스킴은 Windows 드라이브다
// (`C:\a`).
func hasScheme(s string) bool {
	if s == "about:blank" {
		return true
	}
	i := strings.Index(s, ":")
	if i <= 1 {
		return false
	}
	for _, r := range s[:i] {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '+' || r == '-' || r == '.') {
			return false
		}
	}
	if hostPortRe.MatchString(s) {
		return false
	}
	return true
}

// fileURL 은 절대 경로를 `file://` URL 로 바꾼다. 드라이브가 있으면 Windows
// 모양이다 (`file:///C:/a/b.html`).
func fileURL(p string) string {
	if filepath.VolumeName(p) != "" {
		return winPathURL(p)
	}
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(p)}).String()
}

// winPathURL 은 `C:\a\b` 를 `file:///C:/a/b` 로 바꾼다. 어느 호스트에서도 같게
// 동작하도록 역슬래시를 직접 바꾼다.
func winPathURL(p string) string {
	return (&url.URL{Scheme: "file", Path: "/" + strings.ReplaceAll(p, `\`, "/")}).String()
}
