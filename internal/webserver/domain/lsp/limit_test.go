package lsp

import (
	"testing"

	"dongminal/internal/shared/editorlimit"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-15-1 · DOM-30: 통로 메시지의 상한(FR-CMR-104)이 딛는 텍스트 상한은
// 편집기 파일 상한이다.
func TestLimit_TextIsEditorLimit(t *testing.T) {
	if MaxTextBytes != editorlimit.FileMaxBytes {
		t.Fatalf("MaxTextBytes=%d want editorlimit.FileMaxBytes=%d", MaxTextBytes, editorlimit.FileMaxBytes)
	}
}
