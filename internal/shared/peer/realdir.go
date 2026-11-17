package peer

import "strings"

// trimFinalPathPrefix 는 GetFinalPathNameByHandle 이 붙이는 `\\?\` 접두를 뗀다.
// UNC 는 `\\?\UNC\srv\share` 로 오므로 `\\srv\share` 로 되돌린다.
func trimFinalPathPrefix(p string) string {
	if rest, ok := strings.CutPrefix(p, `\\?\UNC\`); ok {
		return `\\` + rest
	}
	return strings.TrimPrefix(p, `\\?\`)
}
