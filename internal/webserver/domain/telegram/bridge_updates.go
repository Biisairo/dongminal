package telegram

import (
	"strings"

	"dongminal/internal/shared/dmlog"
)

// handleUpdate 는 Telegram 에서 온 것 하나다. polling 이 부른다. 받는 것은 짝맞춤뿐이다.
func (b *Bridge) handleUpdate(u Update) {
	c := b.st.Config()
	if !c.Enabled || c.Token == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case u.Message != nil:
		b.onMessage(c, *u.Message)
	case u.CallbackQuery != nil:
		b.onCallback(c, *u.CallbackQuery)
	}
}

func (b *Bridge) reply(c Config, m Message, text string) {
	_ = b.call(c, "sendMessage", map[string]any{"chat_id": m.Chat.ID, "text": text}, nil)
}

func (b *Bridge) onMessage(c Config, m Message) {
	if m.From == nil {
		return
	}
	// 짝맞춤은 등록 전에도 받는다 (FR-TGB-11).
	if code, ok := strings.CutPrefix(strings.TrimSpace(m.Text), "/pair"); ok {
		if b.pair.Redeem(strings.TrimSpace(code)) {
			if err := b.st.SetUser(m.From.ID); err == nil {
				c.UserID = m.From.ID
				b.reply(c, m, "등록했습니다. 이제 이 대화방으로 알림을 보냅니다.")
				return
			}
		}
		dmlog.Infof(nil, "telegram: 짝맞춤 실패 from=%d", m.From.ID)
		if m.From.ID == c.UserID {
			b.reply(c, m, "코드가 틀렸거나 지났습니다.")
		}
		return
	}
	// 허용 계정이 아니면 답하지 않는다. 판정은 보낸 사람이다 (FR-TGB-12·13).
	if c.UserID == 0 || m.From.ID != c.UserID {
		dmlog.Infof(nil, "telegram: 등록되지 않은 사람의 message 를 버렸다 from=%d", m.From.ID)
		return
	}
	b.reply(c, m, "이 봇은 알림만 보냅니다.")
}

// onCallback 은 `[✓ 읽음]` 이다 (FR-TGB-58a). 그 밖의 버튼은 개정 1 의 메시지에 남은
// 것이므로 로딩으로 멈추지 않게 답만 한다 (FR-TGB-14).
func (b *Bridge) onCallback(c Config, q CallbackQuery) {
	if c.UserID == 0 || q.From.ID != c.UserID {
		dmlog.Infof(nil, "telegram: 등록되지 않은 사람의 버튼을 버렸다 from=%d", q.From.ID)
		return
	}
	toolID, ok := strings.CutPrefix(q.Data, readPrefix)
	if !ok || toolID == "" {
		b.answer(c, q.ID, "지원하지 않는 버튼입니다.")
		return
	}
	b.host.Attend(toolID, false)
	b.answer(c, q.ID, "읽음")
	if q.Message != nil {
		b.dropButton(c, q.Message.Chat.ID, q.Message.MessageID)
		b.forgetButton(toolID, q.Message.MessageID)
	}
}

func (b *Bridge) answer(c Config, id, text string) {
	_ = b.call(c, "answerCallbackQuery", map[string]any{"callback_query_id": id, "text": text}, nil)
}
