package wsentry

import "path/filepath"

// NormalizePath 는 경로 정규화의 **유일한** 함수다 (FR-EDT-24, D-15).
//
// Editor 추가와 Git 핀 추가가 같은 함수를 지나야 연동의 "같은 경로" 짝짓기가
// 성립한다. 두 정규화 결과가 갈리면 (macOS 의 `/tmp` → `/private/tmp`) 짝이
// **조용히** 깨진다.
//
// 링크를 풀지 못하면 Clean 만 한 값을 준다 — 사라진 디렉터리의 핀·행도 목록에
// 남아 있어야 지울 수 있다 (FR-EDT-26).
func NormalizePath(p string) string {
	cleaned := filepath.Clean(p)
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		return cleaned
	}
	return filepath.Clean(resolved)
}
