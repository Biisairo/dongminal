package tools

import (
	"context"
	"fmt"
	"log"

	"dongminal/internal/mcptool"
)

const SendInputName = "send_input"

var SendInputSpec = map[string]any{
	"name":        SendInputName,
	"description": "pane 의 쉘/프로그램에 임의 텍스트 입력. execute=false(기본) 면 엔터 없이 타이핑만 — 사용자가 터미널에서 엔터 쳐야 실행. execute=true 면 paste 종료 후 자동 엔터. ※ 다른 CC 에이전트에게 메시지를 보낼 땐 send_input 대신 send_agent_message 를 써야 수신측이 신뢰 채널로 인식한다.",
	"inputSchema": map[string]any{
		"type": "object",
		"properties": map[string]any{
			"id":      idSchema,
			"text":    map[string]any{"type": "string", "description": "주입할 텍스트"},
			"execute": map[string]any{"type": "boolean", "description": "true: 자동 엔터, false: 사용자 확정 대기 (기본 false)"},
		},
		"required": []string{"id", "text"},
	},
}

type SendInputArgs struct {
	ID      string `json:"id"`
	Text    string `json:"text"`
	Execute bool   `json:"execute"`
}

type SendInputDeps struct {
	PM mcptool.PaneReader
	WS mcptool.WorkspaceReader
}

func SendInputHandler(d SendInputDeps) func(context.Context, SendInputArgs) (mcptool.Result, error) {
	return func(_ context.Context, a SendInputArgs) (mcptool.Result, error) {
		pid, err := d.WS.Resolve(a.ID)
		if err != nil {
			return nil, err
		}
		if !d.PM.Has(pid) {
			return nil, fmt.Errorf("pane 없음: %s", pid)
		}
		if err := d.PM.SendPaste(pid, []byte(a.Text), a.Execute); err != nil {
			return nil, err
		}
		log.Printf("[mcp] send_input pane=%s execute=%v textLen=%d", pid, a.Execute, len(a.Text))
		mode := "타이핑만 (paste + 엔터 대기)"
		if a.Execute {
			mode = "paste + 자동 엔터"
		}
		return mcptool.TextResult(fmt.Sprintf("입력 주입 완료: pane=%s textLen=%d 모드=%s", pid, len(a.Text), mode)), nil
	}
}
