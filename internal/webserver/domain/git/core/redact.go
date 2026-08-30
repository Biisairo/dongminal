package core

// RedactSecrets 는 URL 에 박힌 자격증명을 `***` 로 바꾼다. 화면으로 나가는
// 경로(Console 탭)가 쓴다 (FR-GIT-218).
//
// 규칙 자체는 갖지 않고 SanitizeRemote 에 그대로 맡긴다 — 같은 URL 이 기록이냐
// 실행 argv 냐에 따라 다르게 보이면 안 되고, 무엇보다 마스킹 규칙이 두 벌이면
// 새 형태가 나왔을 때 한쪽만 고쳐진다.
//
// git 이 스스로 가려 주는 버전에 기대지 않는다. 가려 주지 않는 경로가 하나라도
// 있으면 토큰이 화면과 브라우저 캐시로 흐른다 (FR-GIT-104, 보안 기준 S.1·S.2).
func RedactSecrets(s string) string { return SanitizeRemote(s) }

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
