package telegram

import (
	"encoding/json"
	"html"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// 알림 모양 (FR-TGB-51·52·52a·54·58). Telegram HTML 로 보낸다.

const (
	// contentMax 는 내용 원문의 글자 수 상한이다 (FR-TGB-54).
	contentMax = 3500
	cutMark    = "…(PC 에서 보기)"
	// callbackMax 는 버튼 데이터의 상한(바이트)이다 (Telegram).
	callbackMax = 64
	readPrefix  = "r:"
	cellSep     = " · "
	// divider 는 접힌 문단에서 위치와 내용을 나누는 줄이다 (FR-TGB-52).
	divider = "──────────"
)

func esc(s string) string { return html.EscapeString(s) }

// locationLines 는 기기·윈도우·탭을 한 줄씩 쓴다. 라벨은 고정폭이라 `:` 가 같은 자리에
// 온다. 윈도우를 모르면 그 줄을 뺀다 (FR-TGB-52·56).
func locationLines(l Location) string {
	line := func(label, name string) string { return "<code>" + label + " :</code> <b>" + esc(name) + "</b>" }
	lines := []string{line("Server", l.Device)}
	if l.Window != "" {
		lines = append(lines, line("Window", l.Window))
	}
	return strings.Join(append(lines, line("Tab   ", l.Tab)), "\n")
}

// cutRunes 는 contentMax 글자를 넘으면 앞부분만 남기고 cutMark 를 붙인다.
func cutRunes(s string) string {
	if utf8.RuneCountInString(s) <= contentMax {
		return s
	}
	return string([]rune(s)[:contentMax]) + cutMark
}

// alarmText 는 알림 전체다. bodyHTML 은 이미 옮긴 내용이다. 위치는 접힌 문단의 머리이고,
// 내용이 있으면 구분선 아래에 둔다 (FR-TGB-51·52).
func alarmText(k alarmKind, loc Location, bodyHTML string) string {
	head := k.emoji + " <b>" + k.label + "</b>"
	if k.tool != "" {
		head += " · " + esc(k.tool)
	}
	quote := locationLines(loc)
	if bodyHTML != "" {
		quote += "\n\n" + divider + "\n\n" + bodyHTML
	}
	return head + "\n<blockquote expandable>" + quote + "</blockquote>"
}

// readKeyboard 는 `[✓ 읽음]` 버튼이다. 데이터가 상한을 넘으면 nil 이다 (FR-TGB-58).
func readKeyboard(toolID string) map[string]any {
	data := readPrefix + toolID
	if len(data) > callbackMax {
		return nil
	}
	return map[string]any{"inline_keyboard": [][]map[string]string{{{"text": "읽음", "callback_data": data}}}}
}

// plainHTML 은 평문 내용이다. 비면 빈 글이다.
func plainHTML(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	return esc(cutRunes(s))
}

// codeHTML 은 권한 요청의 요약이다.
func codeHTML(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	return codeLines(strings.Split(cutRunes(s), "\n"))
}

// codeLines 는 여러 줄 코드를 줄마다 `<code>` 로 감싼다. 접힌 문단 안의 `<pre>` 는 상자를
// 끊으므로 쓰지 않는다 (FR-TGB-52b). 빈 줄은 그대로 둔다.
func codeLines(lines []string) string {
	out := make([]string, len(lines))
	for i, l := range lines {
		if strings.TrimSpace(l) != "" {
			out[i] = "<code>" + esc(l) + "</code>"
		}
	}
	return strings.Join(out, "\n")
}

// permSummary 는 권한 요청의 도구 입력 요약이다. 원문이 없으면 Detail 이다.
func permSummary(input json.RawMessage, detail string) string {
	var m map[string]any
	if len(input) == 0 || json.Unmarshal(input, &m) != nil {
		return detail
	}
	for _, k := range []string{"command", "file_path", "notebook_path", "path", "url", "pattern"} {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return string(input)
}

type question struct {
	Question string `json:"question"`
	Header   string `json:"header"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}

// questionHTML 은 AskUserQuestion 의 질문과 선택지다. 읽지 못하면 빈 글이다 (FR-TGB-52).
func questionHTML(input []byte) string {
	var in struct {
		Questions []question `json:"questions"`
	}
	if json.Unmarshal(input, &in) != nil {
		return ""
	}
	blocks := make([]string, 0, len(in.Questions))
	for _, q := range in.Questions {
		title := q.Question
		if q.Header != "" {
			title = "[" + q.Header + "] " + title
		}
		lines := []string{"<b>" + esc(title) + "</b>"}
		for j, o := range q.Options {
			line := strconv.Itoa(j+1) + ". " + o.Label
			if o.Description != "" {
				line += " — " + o.Description
			}
			lines = append(lines, esc(line))
		}
		blocks = append(blocks, strings.Join(lines, "\n"))
	}
	return strings.Join(blocks, "\n\n")
}

var (
	reHeading = regexp.MustCompile(`^#{1,6}\s+(.*)$`)
	reBullet  = regexp.MustCompile(`^(\s*)[-*+]\s+(.*)$`)
	reRule    = regexp.MustCompile(`^\s*(-{3,}|\*{3,}|_{3,})\s*$`)
	reTableSp = regexp.MustCompile(`^\s*\|?[\s:|-]+\|?\s*$`)
	reBold    = regexp.MustCompile(`\*\*([^*\n]+)\*\*`)
)

// mdToHTML 은 Markdown 을 Telegram HTML 로 옮긴다 (FR-TGB-52a).
func mdToHTML(md string) string {
	var out []string
	var fence []string
	inFence, inTable := false, false
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			if inFence {
				out = append(out, codeLines(fence))
				fence = nil
			}
			inFence = !inFence
			continue
		}
		if inFence {
			fence = append(fence, line)
			continue
		}
		trimmed := strings.TrimSpace(line)
		isRow := strings.HasPrefix(trimmed, "|")
		switch {
		case isRow && reTableSp.MatchString(trimmed):
		case isRow:
			cells := tableCells(trimmed)
			if inTable {
				out = append(out, "• "+strings.Join(cells, cellSep))
			} else {
				out = append(out, "<b>"+strings.Join(cells, cellSep)+"</b>")
			}
		case reRule.MatchString(line):
		default:
			out = append(out, mdLine(line))
		}
		inTable = isRow
	}
	if inFence {
		out = append(out, codeLines(fence))
	}
	return squeezeBlank(out)
}

func tableCells(row string) []string {
	parts := strings.Split(strings.Trim(row, "|"), "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = mdInline(strings.TrimSpace(p))
	}
	return cells
}

func mdLine(line string) string {
	if m := reHeading.FindStringSubmatch(line); m != nil {
		return "<b>" + mdInline(m[1]) + "</b>"
	}
	if m := reBullet.FindStringSubmatch(line); m != nil {
		return m[1] + "• " + mdInline(m[2])
	}
	if rest, ok := strings.CutPrefix(strings.TrimLeft(line, " "), ">"); ok {
		return mdInline(strings.TrimPrefix(rest, " "))
	}
	return mdInline(line)
}

// mdInline 은 한 줄 안의 코드와 굵게다. 코드 안은 바꾸지 않는다.
func mdInline(s string) string {
	parts := strings.Split(s, "`")
	var sb strings.Builder
	for i, p := range parts {
		switch {
		case i%2 == 1 && i < len(parts)-1:
			sb.WriteString("<code>" + esc(p) + "</code>")
		case i%2 == 1:
			sb.WriteString(esc("`" + p))
		default:
			sb.WriteString(reBold.ReplaceAllString(esc(p), "<b>$1</b>"))
		}
	}
	return sb.String()
}

// squeezeBlank 는 이어진 빈 줄을 하나로 줄이고 앞뒤 빈 줄을 걷는다.
func squeezeBlank(lines []string) string {
	var out []string
	for _, l := range lines {
		if strings.TrimSpace(l) == "" && (len(out) == 0 || out[len(out)-1] == "") {
			continue
		}
		if strings.TrimSpace(l) == "" {
			l = ""
		}
		out = append(out, l)
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}
