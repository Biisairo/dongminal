package telegram

import (
	"encoding/json"
	"html"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
	"unicode/utf8"
)

// ATTIC_FIX_SRS TC-ATF-40.

// tgLimit 은 Bot API sendMessage 의 글 상한이다 — 엔티티를 푼 뒤의 UTF-16 단위다 (D-ATF-6).
const tgLimit = 4096

// visibleUnits 는 Telegram 이 세는 길이다. 태그를 걷고 HTML 이스케이프를 푼 글의 UTF-16 단위다.
func visibleUnits(text string) int {
	return len(utf16.Encode([]rune(html.UnescapeString(reTag.ReplaceAllString(text, "")))))
}

func wantFits(t *testing.T, text string) {
	t.Helper()
	if !utf8.ValidString(text) {
		t.Fatal("자르다 글자를 깼다")
	}
	if n := visibleUnits(text); n > tgLimit {
		t.Fatalf("UTF-16 %d 단위 — 상한 %d 를 넘었다", n, tgLimit)
	}
}

// TC-ATF-40: 긴 한국어 질문·선택지도 상한 안에서 잘려 간다 (AT-TG-1).
func TestBridgeLongQuestionFits(t *testing.T) {
	r := newRig(t)
	in, _ := json.Marshal(map[string]any{"questions": []any{
		map[string]any{"header": strings.Repeat("머", 300), "question": strings.Repeat("가", 5000),
			"options": []any{
				map[string]any{"label": strings.Repeat("나", 3000), "description": strings.Repeat("다", 3000)},
				map[string]any{"label": "<b>&"},
			}},
		map[string]any{"question": strings.Repeat("라", 3000)},
	}})
	r.act(Event{ToolID: tabA, Hook: "PreToolUse", Tool: askTool, Input: in})
	r.attn(tabA, "waiting")
	text := r.sent(t)
	wantFits(t, text)
	wantHas(t, folded(text), cutMark, "<b>[머")
}

// TC-ATF-40: 상한은 UTF-16 으로 센다 — 이모지(보조 평면)는 한 글자에 2단위다 (AT-TG-2).
func TestBridgeEmojiReplyFits(t *testing.T) {
	r := newRig(t)
	tp := filepath.Join(t.TempDir(), "s.jsonl")
	writeLines(t, tp, replyLine(strings.Repeat("😀", 5000)))
	r.act(Event{ToolID: tabA, Hook: "Stop", Transcript: tp})
	r.attn(tabA, "done")
	text := r.sent(t)
	wantFits(t, text)
	got := folded(text)
	if !strings.HasSuffix(got, cutMark) || len(utf16.Encode([]rune(strings.TrimSuffix(got, cutMark)))) != contentMax {
		t.Fatalf("UTF-16 %d 단위로 자르지 않았다: %d단위", contentMax, len(utf16.Encode([]rune(got))))
	}
}

// TC-ATF-40: 위치 이름·도구 이름도 사용자·에이전트 글이다.
func TestBridgeLongNamesFit(t *testing.T) {
	r := newRig(t)
	r.host.locs[tabA] = Location{Device: strings.Repeat("기", 5000), Window: strings.Repeat("😀", 5000), Tab: strings.Repeat("<&", 3000)}
	r.act(Event{ToolID: tabA, Hook: "PermissionRequest", Tool: strings.Repeat("T", 5000),
		Input: json.RawMessage(`{"command":"` + strings.Repeat("y", 5000) + `"}`)})
	r.attn(tabA, "waiting")
	wantFits(t, r.sent(t))
}

// TC-ATF-40: Markdown 을 옮기면 글이 늘 수 있다(표의 칸 나눔). 그래도 태그를 깨지 않고 상한 안이다.
func TestBridgeExpandingMarkdownFits(t *testing.T) {
	r := newRig(t)
	tp := filepath.Join(t.TempDir(), "s.jsonl")
	writeLines(t, tp, replyLine("|h|i|j|k|\n|-|-|-|-|\n"+strings.Repeat("|a|b|c|d|\n", 1000)))
	r.act(Event{ToolID: tabA, Hook: "Stop", Transcript: tp})
	r.attn(tabA, "done")
	text := r.sent(t)
	wantFits(t, text)
	wantHas(t, folded(text), "• a · b · c · d")
}

// TC-ATF-40: 자르기는 UTF-16 단위로 세고, 보조 평면 글자를 반으로 쪼개지 않는다.
func TestCutUnits(t *testing.T) {
	cases := []struct {
		name, in string
		limit    int
		want     string
	}{
		{"안", "가나", 2, "가나"},
		{"넘침", "가나다", 2, "가나" + cutMark},
		{"이모지 경계", "😀😀😀", 4, "😀😀" + cutMark},
		{"이모지 반쪽", "😀😀", 3, "😀" + cutMark},
		{"0", "a", 0, cutMark},
		{"빈 글", "", 0, ""},
	}
	for _, tc := range cases {
		if got := cutUnits(tc.in, tc.limit); got != tc.want {
			t.Errorf("%s: %q, 기대 %q", tc.name, got, tc.want)
		}
	}
}

// TC-ATF-40: 상한 안의 질문은 이전 모양 그대로다. 넘치면 첫 넘친 자리에서 끊고 뒤는 버린다.
func TestQuestionHTMLBudget(t *testing.T) {
	in := []byte(`{"questions":[{"question":"가나","options":[{"label":"a"},{"label":"b"}]},{"question":"다"}]}`)
	if got := questionHTML(in, &budget{left: contentMax}); got != "<b>가나</b>\n1. a\n2. b\n\n<b>다</b>" {
		t.Fatalf("%q", got)
	}
	// 가나(2) + \n(1) + "1. a"(4) = 7, 다음 \n 에서 넘친다.
	if got := questionHTML(in, &budget{left: 7}); got != "<b>가나</b>\n1. a"+cutMark {
		t.Fatalf("%q", got)
	}
}
