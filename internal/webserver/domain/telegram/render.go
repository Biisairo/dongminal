package telegram

import (
	"encoding/json"
	"html"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 메시지 모양 (FR-TGB-24·32·40·41·51). Telegram HTML 로 보낸다.

const (
	topicNameMax = 128
	screenMax    = 3500
	summaryMax   = 600
)

func stateEmoji(state string, ended bool) string {
	if ended {
		return "⏹"
	}
	switch state {
	case "working":
		return "🔧"
	case "waiting":
		return "⏳"
	default:
		return "✅"
	}
}

func esc(s string) string { return html.EscapeString(s) }

// cut 은 글자 경계에서 n 바이트 안으로 자른다.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[:n]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…"
}

// tail 은 끝 n 바이트를 글자 경계에서 남긴다.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	for !utf8.ValidString(s) {
		s = s[1:]
	}
	return s
}

func topicName(emoji, tab string) string {
	return cut(emoji+" "+tab, topicNameMax)
}

type button struct {
	Text string `json:"text"`
	Data string `json:"callback_data"`
}

func keyboard(rows ...[]button) map[string]any {
	out := make([][]button, 0, len(rows))
	for _, r := range rows {
		if len(r) > 0 {
			out = append(out, r)
		}
	}
	return map[string]any{"inline_keyboard": out}
}

func statusText(emoji, state, tab string) string {
	return emoji + " <b>" + esc(tab) + "</b> · " + esc(state)
}

func statusKeyboard() map[string]any {
	return keyboard([]button{{"⎋ Esc", "e"}, {"🖥 화면", "s"}})
}

func readButton(kind string) button { return button{"✓ 읽음", "r:" + kind} }

// permSummary 는 권한 요청의 도구 입력 요약이다 (FR-TGB-40). 원문이 없으면 Detail 이고,
// 그때는 전부를 보았다고 할 수 없으므로 whole 이 거짓이다.
func permSummary(tool string, input json.RawMessage, detail string) (s string, whole bool) {
	var m map[string]any
	if len(input) == 0 || json.Unmarshal(input, &m) != nil {
		return detail, false
	}
	for _, k := range []string{"command", "file_path", "notebook_path", "path", "url", "pattern"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v, true
		}
	}
	return string(input), true
}

// permissionText 는 요청 메시지다. 길면 앞과 뒤, 전체 길이를 보인다 (FR-TGB-40a).
// 둘째 값은 사용자가 요청을 다 볼 수 있는가다.
func permissionText(tool, summary string, whole bool) (string, bool) {
	body := summary
	if len(summary) > summaryMax {
		body = cut(summary, summaryMax/2) + "\n…(" + strconv.Itoa(len(summary)) + "바이트 중 일부)…\n" + tail(summary, summaryMax/3)
		whole = false
	}
	text := "🔐 <b>권한 요청</b> · " + esc(tool) + "\n<pre>" + esc(body) + "</pre>"
	if !whole {
		text += "\n<i>전체를 볼 수 없어 허용 버튼을 두지 않습니다. [화면] 으로 확인하고 PC 에서 허용하세요.</i>"
	}
	return text, whole
}

// permissionKeyboard 는 요청의 버튼이다. 다 볼 수 없으면 허용을 두지 않는다 (FR-TGB-40a).
func permissionKeyboard(rid string, whole bool) map[string]any {
	if !whole {
		return keyboard([]button{{"거절", "c:" + rid + ":esc"}, {"🖥 화면", "s"}}, []button{readButton("q")})
	}
	return keyboard(
		[]button{{"1 허용", "c:" + rid + ":1"}, {"2 항상 허용", "c:" + rid + ":2"}, {"거절", "c:" + rid + ":esc"}},
		[]button{readButton("q")})
}

type question struct {
	Question    string `json:"question"`
	Header      string `json:"header"`
	MultiSelect bool   `json:"multiSelect"`
	Options     []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}

// questionMessage 는 AskUserQuestion 의 메시지와 버튼이다 (FR-TGB-41). 버튼은 질문
// 하나의 단일 선택에만 단다 — 그 밖은 글로 답하거나 [화면] 으로 본다.
func questionMessage(rid string, input json.RawMessage) (string, map[string]any) {
	var in struct {
		Questions []question `json:"questions"`
	}
	if json.Unmarshal(input, &in) != nil || len(in.Questions) == 0 {
		return "❓ <b>질문</b>\n토픽에 글로 답하거나 [화면] 을 보세요.", keyboard([]button{readButton("q")})
	}
	var sb strings.Builder
	for i, q := range in.Questions {
		if i > 0 {
			sb.WriteString("\n\n")
		}
		sb.WriteString("❓ <b>" + esc(q.Header) + "</b>\n" + esc(q.Question))
		for j, o := range q.Options {
			sb.WriteString("\n" + strconv.Itoa(j+1) + ". " + esc(o.Label))
			if o.Description != "" {
				sb.WriteString(" — " + esc(o.Description))
			}
		}
	}
	q := in.Questions[0]
	if len(in.Questions) > 1 || q.MultiSelect {
		sb.WriteString("\n\n<i>여러 질문·복수 선택은 버튼을 지원하지 않습니다. 글로 답하거나 [화면] 을 보세요.</i>")
		return sb.String(), keyboard([]button{{"거절", "c:" + rid + ":esc"}, readButton("q")})
	}
	var row []button
	for j, o := range q.Options {
		row = append(row, button{cut(o.Label, 40), "c:" + rid + ":" + strconv.Itoa(j+1)})
	}
	sb.WriteString("\n\n<i>직접 입력은 토픽에 글로 쓰세요.</i>")
	return sb.String(), keyboard(row, []button{{"거절", "c:" + rid + ":esc"}, readButton("q")})
}

func alarmText(reason, tab string) string {
	switch reason {
	case "done":
		return "✅ <b>작업 끝남</b> · " + esc(tab)
	case "waiting":
		return "⏳ <b>입력 대기</b> · " + esc(tab)
	default:
		return "🔔 <b>알림</b> · " + esc(tab)
	}
}

func screenText(s string) string {
	s = strings.TrimRight(s, " \n")
	if s == "" {
		return "<i>(화면이 비어 있습니다)</i>"
	}
	return "<pre>" + esc(tail(s, screenMax)) + "</pre>"
}

// choiceKeys 는 선택의 원시 키다 (FR-TGB-42). 키 순서는 TC-TGB-31 실측으로 고친다.
func choiceKeys(arg string) []byte {
	if arg == "esc" {
		return []byte{0x1b}
	}
	return []byte(arg)
}
