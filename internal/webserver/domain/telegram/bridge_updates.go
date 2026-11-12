package telegram

import (
	"strconv"
	"strings"

	"dongminal/internal/shared/dmlog"
)

// handleUpdate 는 Telegram 에서 온 것 하나다. polling 이 부른다.
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
	p := map[string]any{"chat_id": m.Chat.ID, "text": text, "parse_mode": "HTML"}
	if m.ThreadID != 0 {
		p["message_thread_id"] = m.ThreadID
	}
	_ = b.call(c, "sendMessage", p, nil)
}

func (b *Bridge) onMessage(c Config, m Message) {
	if m.From == nil {
		return
	}
	text := strings.TrimSpace(m.Text)
	// 짝맞춤은 등록 전에도 받는다 (FR-TGB-11).
	if code, ok := strings.CutPrefix(text, "/pair"); ok {
		if b.pair.Redeem(strings.TrimSpace(code)) {
			if err := b.st.SetUser(m.From.ID); err == nil {
				c.UserID = m.From.ID
				b.reply(c, m, "등록했습니다. /agents 로 대화를 고르세요.")
				return
			}
		}
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
	switch {
	case text == "/agents" || text == "/start":
		b.sendAgents(c, m)
	case text == "/cleanup":
		b.cleanup(c, m)
	case text == "/close":
		b.closeTopic(c, m)
	case text == "":
	default:
		b.input(c, m, text)
	}
}

// sidByThread 는 토픽의 대화다.
func (b *Bridge) sidByThread(c Config, thread int64) (string, Topic, bool) {
	if thread == 0 {
		return "", Topic{}, false
	}
	for sid, t := range c.Topics {
		if t.ThreadID == thread {
			return sid, t, true
		}
	}
	return "", Topic{}, false
}

// toolFor 는 대화의 현재 탭이다. 서버가 다시 떠서 아직 보고가 없으면 Agents 목록으로 찾는다.
func (b *Bridge) toolFor(sid string, t Topic) (string, bool) {
	if cv, ok := b.live[sid]; ok {
		if cv.ended {
			return "", false
		}
		return cv.toolID, cv.toolID != ""
	}
	for _, a := range b.host.Agents() {
		if a.SessionID == sid || (a.SessionID == "" && toolSIDPfx+a.ToolID == sid) {
			b.live[sid] = &conv{toolID: a.ToolID, state: a.State}
			return a.ToolID, true
		}
	}
	return "", false
}

func (b *Bridge) input(c Config, m Message, text string) {
	sid, t, ok := b.sidByThread(c, m.ThreadID)
	if !ok {
		b.reply(c, m, "대화 토픽이 아닙니다. /agents 로 대화를 고르세요.")
		return
	}
	tool, live := b.toolFor(sid, t)
	if !live {
		b.reply(c, m, "⏹ 지금 실행 중이 아닙니다.")
		return
	}
	if err := b.host.Paste(tool, text); err != nil {
		b.reply(c, m, "넣지 못했습니다.")
		return
	}
	b.host.Attend(tool, true)
}

func (b *Bridge) sendAgents(c Config, m Message) {
	var rows [][]button
	for _, a := range b.host.Agents() {
		sid := a.SessionID
		if sid == "" {
			sid = toolSIDPfx + a.ToolID
		}
		rows = append(rows, []button{{cut(stateEmoji(a.State, false)+" "+a.Name, 60), "a:" + sid}})
	}
	if len(rows) == 0 {
		b.reply(c, m, "실행 중인 에이전트가 없습니다.")
		return
	}
	_ = b.call(c, "sendMessage", map[string]any{"chat_id": m.Chat.ID, "text": "열 대화를 고르세요.",
		"reply_markup": keyboard(rows...)}, nil)
}

func (b *Bridge) deleteTopic(c Config, sid string, t Topic) {
	if err := b.call(c, "deleteForumTopic", map[string]any{"chat_id": c.UserID, "message_thread_id": t.ThreadID}, nil); err != nil && !threadNotFound(err) {
		dmlog.Infof(nil, "telegram: 토픽을 지우지 못했다: %v", err)
		return
	}
	_ = b.st.DeleteTopic(sid)
	for id, r := range b.reqs {
		if r.sid == sid {
			delete(b.reqs, id)
		}
	}
}

// closeTopic 은 토픽만 지운다. 에이전트는 그대로다 (FR-TGB-27).
func (b *Bridge) closeTopic(c Config, m Message) {
	sid, t, ok := b.sidByThread(c, m.ThreadID)
	if !ok {
		b.reply(c, m, "대화 토픽 안에서 쓰세요.")
		return
	}
	b.deleteTopic(c, sid, t)
}

// cleanup 은 실행 중이 아닌 대화의 토픽을 모두 지운다.
func (b *Bridge) cleanup(c Config, m Message) {
	n := 0
	for sid, t := range c.Topics {
		if _, live := b.toolFor(sid, t); live {
			continue
		}
		b.deleteTopic(c, sid, t)
		n++
	}
	b.reply(c, m, "끝난 토픽 "+strconv.Itoa(n)+"개를 지웠습니다.")
}

func (b *Bridge) answer(c Config, id, text string) {
	p := map[string]any{"callback_query_id": id}
	if text != "" {
		p["text"] = text
	}
	_ = b.call(c, "answerCallbackQuery", p, nil)
}

func (b *Bridge) onCallback(c Config, q CallbackQuery) {
	if c.UserID == 0 || q.From.ID != c.UserID {
		dmlog.Infof(nil, "telegram: 등록되지 않은 사람의 버튼을 버렸다 from=%d", q.From.ID)
		return
	}
	var thread int64
	var msgID int64
	if q.Message != nil {
		thread, msgID = q.Message.ThreadID, q.Message.MessageID
	}
	op, rest, _ := strings.Cut(q.Data, ":")
	if op == "a" {
		if _, err := b.ensureTopic(c, rest); err != nil {
			b.answer(c, q.ID, "토픽을 열지 못했습니다.")
			return
		}
		b.answer(c, q.ID, "토픽을 열었습니다.")
		return
	}
	sid, t, ok := b.sidByThread(c, thread)
	if !ok {
		b.answer(c, q.ID, "대화를 찾지 못했습니다.")
		return
	}
	tool, live := b.toolFor(sid, t)
	switch op {
	case "c":
		rid, arg, _ := strings.Cut(rest, ":")
		r, open := b.reqs[rid]
		if !open || r.closed || !live {
			b.answer(c, q.ID, "이미 처리됐습니다.")
			_ = b.call(c, "editMessageReplyMarkup", map[string]any{"chat_id": c.UserID, "message_id": msgID, "reply_markup": keyboard()}, nil)
			return
		}
		if err := b.host.Keys(tool, choiceKeys(arg)); err != nil {
			b.answer(c, q.ID, "넣지 못했습니다.")
			return
		}
		b.host.Attend(tool, true)
		b.answer(c, q.ID, "보냈습니다.")
	case "r":
		if live {
			b.host.Attend(tool, false)
		}
		b.answer(c, q.ID, "읽음")
		if rest == "a" {
			_ = b.call(c, "editMessageReplyMarkup", map[string]any{"chat_id": c.UserID, "message_id": msgID, "reply_markup": keyboard()}, nil)
		}
	case "e":
		if !live {
			b.answer(c, q.ID, "실행 중이 아닙니다.")
			return
		}
		if err := b.host.Keys(tool, []byte{0x1b}); err != nil {
			b.answer(c, q.ID, "넣지 못했습니다.")
			return
		}
		b.host.Attend(tool, true)
		b.answer(c, q.ID, "Esc")
	case "s":
		b.answer(c, q.ID, "")
		if !live {
			return
		}
		_, _ = b.send(c, sid, screenText(b.host.Screen(tool)), nil, true)
	default:
		b.answer(c, q.ID, "")
	}
}
