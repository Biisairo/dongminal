package telegram

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-50·51 — transcript 의 허용 목록과 글 모양 (FR-TGB-60~64).
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

func TestTranscriptWhitelist(t *testing.T) {
	var got []Piece
	for _, l := range sampleLines {
		got = append(got, ParseTranscriptLine([]byte(l))...)
	}
	want := []Piece{
		{Kind: PieceText, Text: "파일을 **읽겠습니다**."},
		{Kind: PieceTool, Text: "🔧 Bash: npm test"},
		{Kind: PieceTool, Text: "📖 Read: /src/app.ts"},
		{Kind: PieceTool, Text: "🤖 서브에이전트: 코드 조사"},
	}
	if len(got) != len(want) {
		t.Fatalf("조각 %d개, 기대 %d개: %+v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("[%d] %+v, 기대 %+v", i, got[i], want[i])
		}
	}
	all := ""
	for _, p := range got {
		all += p.Text
	}
	if strings.Contains(all, "SECRET") || strings.Contains(all, "example.com") {
		t.Fatalf("허용 목록 밖의 내용이 나갔다: %s", all)
	}
}

func TestTranscriptTailReadsOnlyNewCompleteLines(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(p, []byte(sampleLines[4]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tl := NewTailAtEnd(p)
	if ps := tl.ReadNew(); len(ps) != 0 {
		t.Fatalf("열기 전 기록을 읽었다: %+v", ps)
	}
	f, _ := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(sampleLines[5] + "\n" + sampleLines[7][:20])
	ps := tl.ReadNew()
	if len(ps) != 1 || ps[0].Kind != PieceTool {
		t.Fatalf("새 줄 하나만 읽어야 한다: %+v", ps)
	}
	_, _ = f.WriteString(sampleLines[7][20:] + "\n")
	_ = f.Close()
	ps = tl.ReadNew()
	if len(ps) != 1 || ps[0].Text != "📖 Read: /src/app.ts" {
		t.Fatalf("이어 쓴 줄을 읽지 못했다: %+v", ps)
	}
}

func TestLastReply(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.jsonl")
	body := strings.Join(sampleLines, "\n") + "\n" +
		`{"type":"assistant","isSidechain":false,"message":{"content":[{"type":"text","text":"끝났습니다."}]}}` + "\n"
	_ = os.WriteFile(p, []byte(body), 0o600)
	if got := LastReply(p); got != "끝났습니다." {
		t.Fatalf("마지막 응답 %q", got)
	}
	if LastReply(filepath.Join(t.TempDir(), "없음.jsonl")) != "" {
		t.Fatal("없는 파일인데 답이 있다")
	}
}

func TestMarkdownToHTML(t *testing.T) {
	in := "**굵게** 와 `code` <tag>\n```go\nx := 1 < 2\n```"
	got := MarkdownToHTML(in)
	for _, want := range []string{"<b>굵게</b>", "<code>code</code>", "&lt;tag&gt;", "<pre>x := 1 &lt; 2\n</pre>"} {
		if !strings.Contains(got, want) {
			t.Fatalf("%q 가 없다: %s", want, got)
		}
	}
}

func TestSplitMessageKeepsFences(t *testing.T) {
	long := "앞\n```\n" + strings.Repeat("줄\n", 2000) + "```\n뒤"
	parts := SplitMessage(long)
	if len(parts) < 2 {
		t.Fatalf("나누지 않았다: %d", len(parts))
	}
	for i, p := range parts {
		if len(MarkdownToHTML(p)) > msgMax {
			t.Fatalf("[%d] %d바이트 > %d", i, len(MarkdownToHTML(p)), msgMax)
		}
		if strings.Count(p, "```")%2 != 0 {
			t.Fatalf("[%d] 코드 울타리가 깨졌다", i)
		}
	}
}

func TestSplitMessageCapsTotal(t *testing.T) {
	parts := SplitMessage(strings.Repeat("가", replyMax))
	total := 0
	for _, p := range parts {
		total += len(p)
	}
	if total > replyMax+200 || !strings.Contains(parts[len(parts)-1], "길어서 줄임") {
		t.Fatalf("상한을 지키지 않았다: %d바이트", total)
	}
}
