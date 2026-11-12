package telegram

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
)

// transcript 읽기 (FR-TGB-60~64). 보내는 것은 허용 목록의 셋뿐이다 — 응답 글, 도구
// 호출 한 줄, 서브에이전트 시작 한 줄. 도구 결과·생각·시스템 줄·첨부는 버린다.

const (
	PieceText = "text"
	PieceTool = "tool"

	// msgMax 는 Telegram 메시지 한 개의 상한이다.
	msgMax = 4096
	// replyMax 는 응답 하나에서 보내는 상한이다 (FR-TGB-64).
	replyMax    = 16000
	tailReadMax = 1 << 20
	lastScanMax = 512 << 10
	toolLineMax = 200
)

// Piece 는 보낼 조각 하나다.
type Piece struct {
	Kind string
	Text string
}

type tline struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type tblock struct {
	Type  string         `json:"type"`
	Text  string         `json:"text"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`
}

// ParseTranscriptLine 은 transcript 한 줄의 허용 조각이다.
func ParseTranscriptLine(line []byte) []Piece {
	var l tline
	if json.Unmarshal(line, &l) != nil || l.Type != "assistant" || l.IsSidechain {
		return nil
	}
	var blocks []tblock
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		return nil
	}
	var out []Piece
	for _, b := range blocks {
		switch b.Type {
		case "text":
			if s := strings.TrimSpace(b.Text); s != "" {
				out = append(out, Piece{PieceText, s})
			}
		case "tool_use":
			out = append(out, Piece{PieceTool, toolLine(b.Name, b.Input)})
		}
	}
	return out
}

func str(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// toolLine 은 도구 호출 한 줄이다 (FR-TGB-61). 입력 전체를 싣지 않는다.
func toolLine(name string, in map[string]any) string {
	first := func(s string) string {
		s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
		return cut(s, toolLineMax)
	}
	switch name {
	case "Bash":
		return "🔧 Bash: " + first(str(in, "command"))
	case "Read":
		return "📖 Read: " + first(str(in, "file_path"))
	case "Edit", "MultiEdit", "Write":
		return "✏️ " + name + ": " + first(str(in, "file_path"))
	case "NotebookEdit":
		return "✏️ " + name + ": " + first(str(in, "notebook_path"))
	case "Grep", "Glob":
		return "🔍 " + name + ": " + first(str(in, "pattern"))
	case "Agent", "Task":
		return "🤖 서브에이전트: " + first(str(in, "description"))
	}
	return "🔧 " + name
}

// Tail 은 transcript 를 이어 읽는다. 열 때의 끝에서 시작한다 — 지난 기록은 보내지 않는다.
type Tail struct {
	path string
	off  int64
}

func NewTailAtEnd(path string) *Tail {
	t := &Tail{path: path}
	if st, err := os.Stat(path); err == nil {
		t.off = st.Size()
	}
	return t
}

// ReadNew 는 지난번 뒤로 붙은 완성된 줄의 조각이다. 끝의 덜 쓴 줄은 다음에 읽는다.
func (t *Tail) ReadNew() []Piece {
	f, err := os.Open(t.path)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil
	}
	if st.Size() < t.off {
		t.off = st.Size()
		return nil
	}
	if _, err := f.Seek(t.off, io.SeekStart); err != nil {
		return nil
	}
	buf, err := io.ReadAll(io.LimitReader(f, tailReadMax))
	if err != nil {
		return nil
	}
	end := bytes.LastIndexByte(buf, '\n')
	if end < 0 {
		return nil
	}
	t.off += int64(end + 1)
	var out []Piece
	for _, line := range bytes.Split(buf[:end], []byte{'\n'}) {
		out = append(out, ParseTranscriptLine(line)...)
	}
	return out
}

// LastReply 는 마지막 응답 글이다 (FR-TGB-52). 끝 512KB 만 본다.
func LastReply(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	from := max(st.Size()-lastScanMax, 0)
	if _, err := f.Seek(from, io.SeekStart); err != nil {
		return ""
	}
	buf, _ := io.ReadAll(f)
	last := ""
	for _, line := range bytes.Split(buf, []byte{'\n'}) {
		for _, p := range ParseTranscriptLine(line) {
			if p.Kind == PieceText {
				last = p.Text
			}
		}
	}
	return last
}

var (
	reInlineCode = regexp.MustCompile("`([^`\n]+)`")
	reBold       = regexp.MustCompile(`\*\*([^*\n]+)\*\*`)
)

// MarkdownToHTML 은 Telegram HTML 로 옮긴다. 코드 울타리·인라인 코드·굵게만 다룬다.
func MarkdownToHTML(md string) string {
	var sb strings.Builder
	inFence := false
	for i, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "```") {
			if inFence {
				sb.WriteString("</pre>")
			} else {
				if i > 0 {
					sb.WriteString("\n")
				}
				sb.WriteString("<pre>")
			}
			inFence = !inFence
			continue
		}
		if inFence {
			sb.WriteString(esc(line) + "\n")
			continue
		}
		if i > 0 && !strings.HasSuffix(sb.String(), "</pre>") {
			sb.WriteString("\n")
		} else if i > 0 {
			sb.WriteString("\n")
		}
		s := esc(line)
		s = reInlineCode.ReplaceAllString(s, "<code>$1</code>")
		s = reBold.ReplaceAllString(s, "<b>$1</b>")
		sb.WriteString(s)
	}
	if inFence {
		sb.WriteString("</pre>")
	}
	return sb.String()
}

// SplitMessage 는 응답 글을 메시지 여러 개로 나눈다 (FR-TGB-64). 옮긴 HTML 이 상한 안이
// 되게 줄 단위로 나누고, 코드 울타리가 나뉘면 닫고 다시 연다. 전체는 replyMax 까지다.
func SplitMessage(md string) []string {
	if len(md) > replyMax {
		md = cut(md, replyMax) + "\n(길어서 줄임)"
	}
	const limit = msgMax - 200
	var parts []string
	var cur []string
	fenced := func(lines []string) bool {
		n := 0
		for _, l := range lines {
			if strings.HasPrefix(strings.TrimSpace(l), "```") {
				n++
			}
		}
		return n%2 == 1
	}
	closed := func(lines []string) string {
		s := strings.Join(lines, "\n")
		if fenced(lines) {
			s += "\n```"
		}
		return s
	}
	for _, line := range strings.Split(md, "\n") {
		for len(MarkdownToHTML(line)) > limit {
			cutAt := limit / 6
			line = line[:0] + cut(line, cutAt)
		}
		next := append(append([]string{}, cur...), line)
		if len(cur) > 0 && len(MarkdownToHTML(closed(next))) > limit {
			parts = append(parts, closed(cur))
			if fenced(cur) {
				cur = []string{"```", line}
			} else {
				cur = []string{line}
			}
			continue
		}
		cur = next
	}
	if len(cur) > 0 {
		parts = append(parts, closed(cur))
	}
	return parts
}
