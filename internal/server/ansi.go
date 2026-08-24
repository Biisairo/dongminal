package server

import (
	"regexp"
	"strings"
)

// CSI | OSC | 기타 2-char ESC.
var ansiRe = regexp.MustCompile(`\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][\x20-\x7e]*(?:\x07|\x1b\\)|\x1b[\x40-\x5f]`)

// stripANSI removes escape sequences and non-printable control bytes so a PTY
// scrollback reads as plain text. Used by GET /api/tools/output?strip=1
// (SKILL_INJECTION_SRS FR-API-1).
func stripANSI(b []byte) string {
	s := ansiRe.ReplaceAllString(string(b), "")
	var out strings.Builder
	out.Grow(len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\r' {
			continue
		}
		if c < 0x20 && c != '\n' && c != '\t' {
			continue
		}
		if c == 0x7f {
			continue
		}
		out.WriteByte(c)
	}
	return out.String()
}
