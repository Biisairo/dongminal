package core

import (
	"regexp"
	"strings"
)

// remoteCreds 는 URL 의 userinfo 다. `scheme://user:pass@host` 의 `user:pass` 는
// 물론이고 **콜론이 없어도** 지운다 — `https://ghp_…@github.com` 처럼 토큰이
// 사용자명 자리에 오는 형태가 흔하다.
//
// scp 형태(`git@host:path`)는 손대지 않는다: scheme 이 없고 비밀이 들어갈 자리도
// 없다.
var remoteCreds = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\s]+@`)

// SanitizeRemote 는 자격증명을 지운다. **저장 전에** 부른다 (FR-GIT-104, V43) —
// argv·출력 줄·실행 기록·SSE·응답 중 한 곳만 늦게 지우면 그곳이 유출 경로가 된다.
func SanitizeRemote(s string) string {
	if !strings.Contains(s, "://") {
		return s
	}
	return remoteCreds.ReplaceAllString(s, "${1}***@")
}

func SanitizeArgv(argv []string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		out[i] = SanitizeRemote(a)
	}
	return out
}
