package agentadapter

import (
	"encoding/json"
	"testing"
)

// V-M11-61 (M11_SRS FR-M11-30 / M11-B28): **첨부가 있으면 content 가 배열이다.**
//
// 실측(§2.11 (4))에서 claude 는 `content` 배열의 `image` 블록을 받는다 — 8×8 빨강 PNG
// 를 보내고 *"빨강"* 이라는 답을 받았다. 막힌 것은 프로토콜이 아니라 `claudePrompt` 의
// 한 줄이었다.
func TestClaudePrompt_Attachments(t *testing.T) {
	ad, err := Get("claude")
	if err != nil {
		t.Fatalf("claude 어댑터: %v", err)
	}
	p := ad.Proto
	if !p.Attachments {
		t.Fatal("claude 는 첨부를 받는다 — 선언이 그렇게 말해야 화면이 붙여넣기를 연다")
	}

	// ① 첨부가 없으면 **종전 그대로 문자열**이다. 이미 도는 모든 턴의 와이어를 함께
	//    바꾸는 것은 이 요구가 청한 일이 아니다.
	fr := p.Prompt("안녕", nil, &ProtoState{})
	if len(fr) != 1 {
		t.Fatalf("프레임 수: %d", len(fr))
	}
	var plain struct {
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(fr[0], &plain); err != nil {
		t.Fatalf("프레임: %v", err)
	}
	var s string
	if json.Unmarshal(plain.Message.Content, &s) != nil || s != "안녕" {
		t.Fatalf("첨부가 없는데 문자열이 아니다: %s", plain.Message.Content)
	}

	// ② 첨부가 있으면 배열이고, **이미지가 앞**이다 (실측한 모양 — 글이 그림을 가리킨다).
	fr = p.Prompt("무슨 색?", []Attachment{{MediaType: "image/png", Data: "iVBORw0K"}}, &ProtoState{})
	if err := json.Unmarshal(fr[0], &plain); err != nil {
		t.Fatalf("프레임: %v", err)
	}
	var blocks []map[string]any
	if err := json.Unmarshal(plain.Message.Content, &blocks); err != nil {
		t.Fatalf("첨부가 있는데 배열이 아니다: %s", plain.Message.Content)
	}
	if len(blocks) != 2 || blocks[0]["type"] != "image" || blocks[1]["type"] != "text" {
		t.Fatalf("블록 순서·종류: %+v", blocks)
	}
	src, _ := blocks[0]["source"].(map[string]any)
	if src["type"] != "base64" || src["media_type"] != "image/png" || src["data"] != "iVBORw0K" {
		t.Fatalf("이미지 블록이 실측한 모양이 아니다: %+v", src)
	}
	if blocks[1]["text"] != "무슨 색?" {
		t.Fatalf("글이 실리지 않았다: %+v", blocks[1])
	}

	// ③ 반쪽 첨부(미디어 타입이나 본문이 빈 것)는 **싣지 않는다** — 실을 수 없는 것을
	//    실으면 프레임이 통째로 거절된다.
	fr = p.Prompt("글만", []Attachment{{MediaType: "image/png"}}, &ProtoState{})
	if err := json.Unmarshal(fr[0], &plain); err != nil {
		t.Fatalf("프레임: %v", err)
	}
	if json.Unmarshal(plain.Message.Content, &s) != nil || s != "글만" {
		t.Fatalf("반쪽 첨부가 배열을 만들었다: %s", plain.Message.Content)
	}

	// ④ 받지 않는다고 말한 어댑터는 **그 선언이 거짓이다** — 화면이 그것을 보고 막는다.
	for _, id := range []string{"codex", "omp"} {
		other, err := Get(id)
		if err != nil || other.Proto == nil {
			continue
		}
		if other.Proto.Attachments {
			t.Fatalf("%s: 재지 않은 것을 받는다고 말한다 (FR-M11-30)", id)
		}
	}
}
