package telegram

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-41 — 완료 알림의 마지막 응답 (FR-TGB-53).
//
// 줄 모양은 2026-11-12 실측(Claude Code 2.1.322)의 키 구조를 따른다. 내용은 지어낸 것이다.
var sampleLines = []string{
	`{"type":"permission-mode","permissionMode":"default","sessionId":"s"}`,
	`{"type":"user","isSidechain":false,"message":{"role":"user","content":"고쳐줘"}}`,
	`{"type":"api-request-blob","message":{"content":[{"type":"text","text":"SYSTEM PROMPT user@example.com"}]}}`,
	`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"thinking","thinking":"SECRET THINKING"}]}}`,
	`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"파일을 **읽겠습니다**."}]}}`,
	`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test\nnpm run lint","description":"x"}}]}}`,
	`{"type":"user","isSidechain":false,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"TOOL OUTPUT SECRET"}]},"toolUseResult":{"stdout":"TOOL OUTPUT SECRET"}}`,
	`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/src/app.ts"}}]}}`,
	`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"tool_use","id":"t3","name":"Agent","input":{"description":"코드 조사","prompt":"PROMPT SECRET"}}]}}`,
	`{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"SIDECHAIN SECRET"}]}}`,
	`{"type":"attachment","attachment":{"content":"ATTACH SECRET"}}`,
	`{"type":"cost-state","totalCostUSD":1}`,
}

func TestLastReply(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	body := strings.Join(sampleLines, "\n") + "\n" +
		`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"끝났습니다."}]}}` + "\n"
	_ = os.WriteFile(p, []byte(body), 0o600)
	if got := LastReply(p); got != "끝났습니다." {
		t.Fatalf("마지막 응답 %q", got)
	}
	// 마지막 줄이 사이드체인·도구 호출·내부 줄이어도 main 의 마지막 글을 고른다.
	_ = os.WriteFile(p, []byte(body+strings.Join(sampleLines[5:], "\n")+"\n"), 0o600)
	if got := LastReply(p); got != "끝났습니다." {
		t.Fatalf("허용 목록 밖 줄을 골랐다: %q", got)
	}
	if LastReply(filepath.Join(t.TempDir(), "없음.jsonl")) != "" {
		t.Fatal("없는 파일인데 답이 있다")
	}
}
