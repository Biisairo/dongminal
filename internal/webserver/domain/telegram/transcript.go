package telegram

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
)

// transcript 읽기 (FR-TGB-53). main 의 응답 글만 고른다 — 도구 호출·결과·생각·사이드체인·
// 시스템 줄·첨부는 버린다.

// lastScanMax 는 끝에서 읽는 상한이다 (NFR-TGB-5).
const lastScanMax = 512 << 10

type tline struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type tblock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// replyText 는 transcript 한 줄의 마지막 응답 글이다. 없으면 빈 글이다.
func replyText(line []byte) string {
	var l tline
	if json.Unmarshal(line, &l) != nil || l.Type != "assistant" || l.IsSidechain {
		return ""
	}
	var blocks []tblock
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		return ""
	}
	last := ""
	for _, b := range blocks {
		if s := strings.TrimSpace(b.Text); b.Type == "text" && s != "" {
			last = s
		}
	}
	return last
}

// LastReply 는 마지막 응답 글이다. 끝 512KB 만 본다.
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
		if s := replyText(line); s != "" {
			last = s
		}
	}
	return last
}
