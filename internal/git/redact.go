package git

import "regexp"

// 자격증명이 박힌 URL 은 `scheme://[user[:secret]@]host` 꼴이다. 비밀은 `:` 뒤에
// 있고, 그것만 지운다 — `user` 는 사용자가 어느 계정으로 붙는지 알 자리이고,
// `git@host` 처럼 scheme 이 없는 ssh 형태는 비밀이 아니다 (FR-GIT-218).
//
// git 이 스스로 가려 주는 버전에 기대지 않는다. 가려 주지 않는 경로가 하나라도
// 있으면 토큰이 화면과 브라우저 캐시로 흐른다 (FR-GIT-104, 보안 기준 S.1·S.2).
var secretURL = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)([^/@\s:]+)(?::([^/@\s]*))?@`)

// RedactSecrets 는 URL 에 박힌 비밀을 `***` 로 바꾼다.
//
// 비밀이 `user` 자리에만 있는 형태(`https://token@host`)도 있다. 그때는 그 자리가
// 곧 비밀이므로 통째로 가린다 — 사용자 이름인지 토큰인지 구분할 방법이 없고,
// 구분할 수 없으면 **가리는 쪽**이 안전하다.
func RedactSecrets(s string) string {
	if s == "" {
		return s
	}
	return secretURL.ReplaceAllStringFunc(s, func(m string) string {
		g := secretURL.FindStringSubmatch(m)
		if g[3] == "" && !hasColonSecret(m) {
			return g[1] + "***@"
		}
		return g[1] + g[2] + ":***@"
	})
}

// hasColonSecret 은 `user:` 형태였는지 본다 — 빈 비밀(`user:@host`)과 비밀 없음
// (`user@host`)은 뜻이 다르다.
func hasColonSecret(m string) bool {
	for i := 0; i < len(m); i++ {
		if m[i] == ':' && i+2 < len(m) && m[i+1] == '/' && m[i+2] == '/' {
			i += 2
			continue
		}
		if m[i] == ':' {
			return true
		}
	}
	return false
}

// Redacted 는 화면으로 나갈 수 있는 사본이다. **원본을 건드리지 않는다** — 기록은
// 링 버퍼에 남아 다시 읽힌다.
func (r Record) Redacted() Record {
	out := r
	out.Argv = make([]string, len(r.Argv))
	for i, a := range r.Argv {
		out.Argv[i] = RedactSecrets(a)
	}
	out.Stderr = RedactSecrets(r.Stderr)
	out.Err = RedactSecrets(r.Err)
	return out
}
