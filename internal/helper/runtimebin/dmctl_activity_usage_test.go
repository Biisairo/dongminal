package runtimebin

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// UX_BATCH6_SRS 묶음 C — 실측 토큰의 훅 절반 (FR-CTX-1·2·3).

// assistantLine 은 Claude Code 가 남기는 assistant 줄의 모양이다. 필요한 것은
// `message.model` 과 `message.usage` 뿐이므로 나머지는 줄이고, 대신 본문 자리에
// 카나리아를 넣어 그것이 새지 않음을 함께 잰다.
func assistantLine(model string, in, write, read, out int64, body string) string {
	return fmt.Sprintf(
		`{"type":"assistant","message":{"model":%q,"content":[{"type":"text","text":%q}],`+
			`"usage":{"input_tokens":%d,"cache_creation_input_tokens":%d,`+
			`"cache_read_input_tokens":%d,"output_tokens":%d}}}`,
		model, body, in, write, read, out)
}

func writeLines(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("transcript 생성 실패: %v", err)
	}
	return p
}

// V-CTX-1 (FR-CTX-1): 세는 것은 `input + cache_creation + cache_read` 다.
// `output_tokens` 는 그 요청의 **답**이라 입력 컨텍스트가 아니다.
func TestTranscriptUsage_SumsInputSide(t *testing.T) {
	p := writeLines(t, assistantLine("claude-opus-5", 2, 1570, 200613, 840, "본문"))
	u, ok := transcriptUsage(p)
	if !ok {
		t.Fatal("usage 를 읽지 못했다")
	}
	if u.tokens != 2+1570+200613 {
		t.Errorf("tokens = %d, want %d (출력 토큰이 섞였는지 보라)", u.tokens, 2+1570+200613)
	}
	if u.model != "claude-opus-5" {
		t.Errorf("model = %q", u.model)
	}
}

// V-CTX-1 (FR-CTX-1): **마지막** assistant 줄이다. 앞줄을 고르면 대화가 길어질수록
// 실제보다 작은 값을 말한다.
func TestTranscriptUsage_PicksLastLine(t *testing.T) {
	p := writeLines(t,
		assistantLine("claude-opus-5", 1, 0, 1000, 5, "예전"),
		`{"type":"user","message":{"content":"사용자 줄에는 usage 가 없다"}}`,
		assistantLine("claude-opus-5[1m]", 1, 0, 480000, 7, "지금"),
	)
	u, ok := transcriptUsage(p)
	if !ok {
		t.Fatal("usage 를 읽지 못했다")
	}
	if u.tokens != 1+480000 {
		t.Errorf("tokens = %d — 마지막 줄이 아니다", u.tokens)
	}
	if u.model != "claude-opus-5[1m]" {
		t.Errorf("model = %q — 마지막 줄이 아니다", u.model)
	}
}

// V-CTX-1: usage 가 하나도 없으면 **모른다**이며 0 이 아니다 (FR-CBG-5 의 규약).
func TestTranscriptUsage_UnknownWhenAbsent(t *testing.T) {
	p := writeLines(t, `{"type":"user","message":{"content":"안녕"}}`)
	if _, ok := transcriptUsage(p); ok {
		t.Fatal("usage 가 없는 파일에서 값을 만들어 냈다")
	}
	if _, ok := transcriptUsage(""); ok {
		t.Fatal("빈 경로에서 값을 만들어 냈다")
	}
	if _, ok := transcriptUsage(filepath.Join(t.TempDir(), "없다.jsonl")); ok {
		t.Fatal("없는 파일에서 값을 만들어 냈다")
	}
}

// V-CTX-1 (FR-CTX-2): 파일 전체를 읽지 않는다. 꼬리 상한 밖에 있는 줄은 보지
// 않으며, **잘린 첫 줄을 해석하지 않는다** — 그것이 이 읽기의 유일한 함정이다.
func TestTranscriptUsage_ReadsOnlyTail(t *testing.T) {
	pad := strings.Repeat("x", usageTailMax)
	p := writeLines(t,
		assistantLine("claude-opus-5", 9, 9, 9, 9, pad), // 꼬리 밖으로 밀려난다
		assistantLine("claude-opus-5", 1, 2, 3, 4, "끝"),
	)
	u, ok := transcriptUsage(p)
	if !ok {
		t.Fatal("꼬리에서 읽지 못했다")
	}
	if u.tokens != 1+2+3 {
		t.Errorf("tokens = %d — 꼬리 밖의 줄을 읽었거나 잘린 줄을 해석했다", u.tokens)
	}
	st, _ := os.Stat(p)
	if st.Size() <= usageTailMax {
		t.Fatalf("전제가 깨졌다: 파일이 꼬리 상한보다 작다 (%d)", st.Size())
	}
}

// V-CTX-2 / NFR-4: 반환 타입에 본문을 실을 자리가 없다는 것이 첫 방벽이지만,
// 값으로도 새지 않음을 고정한다.
func TestTranscriptUsage_CarriesNoContent(t *testing.T) {
	const canary = "CANARY-SECRET-DO-NOT-TRANSMIT"
	p := writeLines(t, assistantLine("claude-opus-5", 1, 2, 3, 4, canary))
	u, ok := transcriptUsage(p)
	if !ok {
		t.Fatal("usage 를 읽지 못했다")
	}
	if strings.Contains(u.model, canary) {
		t.Fatalf("본문이 모델 이름으로 새 나왔다: %q", u.model)
	}
}
