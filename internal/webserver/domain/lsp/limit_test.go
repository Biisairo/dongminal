package lsp

import (
	"context"
	"os"
	"strings"
	"testing"

	"dongminal/internal/shared/editorlimit"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-15-1 · DOM-30: 요청 텍스트와 디스크 재동기화가 **같은**
// 상한 하나를 쓴다. 종전에는 8 MiB 와 10 MiB 로 갈려, 8~10 MiB 파일은 재동기화로는
// 보내지고 요청으로는 거절됐다.
func TestLimit_TextIsEditorLimit(t *testing.T) {
	if MaxTextBytes != editorlimit.FileMaxBytes {
		t.Fatalf("MaxTextBytes=%d want editorlimit.FileMaxBytes=%d", MaxTextBytes, editorlimit.FileMaxBytes)
	}
}

// 상한과 같은 크기의 텍스트는 요청으로 실리고, 같은 크기의 디스크 판은 재동기화된다.
// 한 바이트 넘으면 재동기화는 문서를 닫는다.
//
// 상한을 낮춰 잰다. 32 MiB 그대로면 가짜 서버가 didChange 를 JSON 으로 푸는 데
// -race 의 CI 러너에서 waitN 의 2초를 넘겨 [didOpen] 만 보였다.
func TestLimit_AtLimitRequestAndResync(t *testing.T) {
	prev := MaxTextBytes
	MaxTextBytes = 64 << 10
	t.Cleanup(func() { MaxTextBytes = prev })
	svc, rec := docSvc(t)
	root, p := docRoot(t)
	at := strings.Repeat("a", MaxTextBytes)
	if _, err := svc.Definition(context.Background(), root, Doc{Path: p, Text: at}, 1, 1); err != nil {
		t.Fatalf("상한과 같은 텍스트가 거절됐다: %v", err)
	}
	if err := os.WriteFile(p, []byte(strings.Repeat("b", MaxTextBytes)), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.ResyncPath(p)
	if got := rec.waitN(t, 2); len(got) != 2 || got[1] != "textDocument/didChange" {
		t.Fatalf("상한과 같은 디스크 판 = %v want didChange", got)
	}
	if err := os.WriteFile(p, []byte(strings.Repeat("c", MaxTextBytes+1)), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.ResyncPath(p)
	if got := rec.waitN(t, 3); len(got) != 3 || got[2] != "textDocument/didClose" {
		t.Fatalf("상한을 넘은 디스크 판 = %v want didClose", got)
	}
}
