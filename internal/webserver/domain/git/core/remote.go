package core

import (
	"regexp"
	"strings"
)

// remoteCreds 는 URL 의 userinfo 다. `scheme://user:pass@host` 의 `user:pass` 는
// 물론이고 **콜론이 없어도** 지운다 — `https://ghp_…@github.com` 처럼 토큰이
// 사용자명 자리에 오는 형태가 흔하다.
//
// userinfo 를 통째로 가리는 이유는 구분이 불가능하기 때문이다. `user` 자리에
// 든 것이 계정 이름인지 토큰인지 알 방법이 없고, 알 수 없으면 **가리는 쪽**이
// 안전하다 (FR-GIT-104, 보안 기준 S.1·S.2).
//
// scp 형태(`git@host:path`)는 손대지 않는다: scheme 이 없고 비밀이 들어갈 자리도
// 없다.
//
// **이 저장소의 유일한 URL 마스킹 규칙이다.** 규칙을 두 벌로 두면 새 URL 형태가
// 나왔을 때 한쪽만 고쳐지고, 고쳐지지 않은 쪽이 유출 경로가 된다.
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
