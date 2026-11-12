package telegram

import (
	"strings"
	"time"

	"dongminal/internal/shared/dmlog"
)

// process 는 큐의 한 칸을 처리한다. 작업자만 부른다(시험은 직접 부른다).
func (b *Bridge) process(it item) {
	c, ok := b.active()
	if !ok {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case it.ev != nil:
		b.onEvent(c, *it.ev)
	case it.attnTool != "":
		b.onAttention(c, it.attnTool, it.attnReason)
	case it.flush:
		b.flushLocked(c)
	case it.pumpSID != "":
		b.pump(c, it.pumpSID)
	}
}

// sidOf 는 도구의 대화다. 모르면 도구 자체를 대화로 본다 (FR-TGB-23).
func (b *Bridge) sidOf(toolID string) string {
	if sid, ok := b.byTool[toolID]; ok {
		return sid
	}
	return toolSIDPfx + toolID
}

func (b *Bridge) convOf(sid, toolID string) *conv {
	cv, ok := b.live[sid]
	if !ok {
		cv = &conv{toolID: toolID}
		b.live[sid] = cv
	}
	return cv
}

func (b *Bridge) onEvent(c Config, ev Event) {
	sid := ev.SessionID
	if sid == "" {
		sid = b.sidOf(ev.ToolID)
	}
	cv := b.convOf(sid, ev.ToolID)
	if cv.toolID != ev.ToolID {
		delete(b.byTool, cv.toolID)
	}
	cv.toolID = ev.ToolID
	b.byTool[ev.ToolID] = sid
	if t, ok := b.st.Topic(sid); ok && t.ToolID != ev.ToolID {
		t.ToolID = ev.ToolID
		_ = b.st.PutTopic(sid, t)
	}
	if ev.Transcript != "" && ev.Transcript != cv.transcript {
		cv.transcript, cv.tail = ev.Transcript, nil
	}
	ended := ev.State == "ended"
	if cv.state != ev.State || cv.ended != ended {
		cv.state, cv.ended = ev.State, ended
		b.markName(c, sid)
	}
	if ended {
		delete(b.byTool, ev.ToolID)
	}
	switch ev.Hook {
	case "PreToolUse":
		cv.lastToolUse = ev.ToolUseID
		if ev.Tool == "AskUserQuestion" && len(ev.Input) > 0 {
			b.sendQuestion(c, sid, ev)
		}
	case "PermissionRequest":
		if ev.Tool == "AskUserQuestion" {
			if !b.hasOpen(sid, cv.lastToolUse) {
				ev.ToolUseID = cv.lastToolUse
				b.sendQuestion(c, sid, ev)
			}
			return
		}
		ev.ToolUseID = cv.lastToolUse
		b.sendPermission(c, sid, ev)
	case "PostToolUse", "PostToolUseFailure":
		b.closeRequests(c, sid, ev.ToolUseID)
	case "Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "SessionStart":
		b.closeRequests(c, sid, "")
	}
	b.pump(c, sid)
	if ev.Hook == "Stop" || ev.Hook == "StopFailure" {
		time.AfterFunc(stopSettle, func() { b.enqueue(item{pumpSID: sid}) })
	}
	if cv.state == "working" {
		b.draftWorking(c, sid, cv)
	}
}

// pump 는 열린 토픽의 transcript 에서 새 조각을 읽어 보낸다 (FR-TGB-60~62). 토픽이
// 없으면 읽지 않는다 (NFR-TGB-5). 출력은 알림이 아니므로 소리 없이 보낸다.
func (b *Bridge) pump(c Config, sid string) {
	cv, ok := b.live[sid]
	if !ok || cv.transcript == "" {
		return
	}
	if _, open := b.st.Topic(sid); !open {
		return
	}
	if cv.tail == nil {
		cv.tail = NewTailAtEnd(cv.transcript)
		return
	}
	var tools []string
	flushTools := func() {
		if len(tools) > 0 {
			_, _ = b.send(c, sid, esc(strings.Join(tools, "\n")), nil, true)
			tools = nil
		}
	}
	for _, p := range cv.tail.ReadNew() {
		if p.Kind == PieceTool {
			tools = append(tools, p.Text)
			continue
		}
		flushTools()
		b.sendReply(c, sid, p.Text)
	}
	flushTools()
}

func (b *Bridge) sendReply(c Config, sid, md string) {
	for _, part := range SplitMessage(md) {
		_, _ = b.send(c, sid, MarkdownToHTML(part), nil, true)
	}
}

// draftWorking 은 작업 중 표시(점 세 개)다 (FR-TGB-65).
func (b *Bridge) draftWorking(c Config, sid string, cv *conv) {
	t, open := b.st.Topic(sid)
	if !open || b.now().Sub(cv.lastDraft) < draftEvery {
		return
	}
	cv.lastDraft = b.now()
	_ = b.call(c, "sendMessageDraft", map[string]any{"chat_id": c.UserID, "message_thread_id": t.ThreadID,
		"draft_id": t.ThreadID, "text": ""}, nil)
}

func (b *Bridge) hasOpen(sid, toolUseID string) bool {
	for _, r := range b.reqs {
		if r.sid == sid && !r.closed && r.toolUseID == toolUseID {
			return true
		}
	}
	return false
}

// closeRequests 는 그 대화의 열린 요청을 닫는다. toolUseID 가 비면 전부다 (FR-TGB-43).
func (b *Bridge) closeRequests(c Config, sid, toolUseID string) {
	for id, r := range b.reqs {
		if r.sid != sid || r.closed || (toolUseID != "" && r.toolUseID != toolUseID) {
			continue
		}
		r.closed = true
		delete(b.reqs, id)
		_ = b.call(c, "editMessageReplyMarkup", map[string]any{"chat_id": c.UserID, "message_id": r.msgID,
			"reply_markup": keyboard()}, nil)
	}
}

func (b *Bridge) silent(c Config, toolID string) bool {
	if c.SilenceMin <= 0 {
		return false
	}
	last := b.host.LastBrowserInput(toolID)
	return !last.IsZero() && b.now().Sub(last) < time.Duration(c.SilenceMin)*time.Minute
}

func (b *Bridge) sendPermission(c Config, sid string, ev Event) {
	rid := b.nextID()
	summary, whole := permSummary(ev.Tool, ev.Input, ev.Detail)
	text, whole := permissionText(ev.Tool, summary, whole && !ev.InputOver)
	id, err := b.send(c, sid, text, permissionKeyboard(rid, whole), b.silent(c, ev.ToolID))
	if err != nil {
		return
	}
	b.reqs[rid] = &request{sid: sid, toolUseID: ev.ToolUseID, msgID: id, at: b.now()}
}

func (b *Bridge) sendQuestion(c Config, sid string, ev Event) {
	rid := b.nextID()
	text, kb := questionMessage(rid, ev.Input)
	id, err := b.send(c, sid, text, kb, b.silent(c, ev.ToolID))
	if err != nil {
		return
	}
	b.reqs[rid] = &request{sid: sid, toolUseID: ev.ToolUseID, msgID: id, at: b.now()}
}

// onAttention 은 입력 필요 알림이다 (FR-TGB-50~53). 권한·질문 메시지를 막 보냈으면
// 같은 기다림을 두 번 알리지 않는다.
func (b *Bridge) onAttention(c Config, toolID, reason string) {
	sid := b.sidOf(toolID)
	b.convOf(sid, toolID)
	if reason == "waiting" {
		for _, r := range b.reqs {
			if r.sid == sid && !r.closed {
				return
			}
		}
	}
	// 알림이 토픽을 새로 열면 그때까지의 응답을 따라오지 못했다. 마지막 응답을 싣는다 (FR-TGB-52).
	if _, open := b.st.Topic(sid); !open && reason == "done" {
		if cv := b.live[sid]; cv != nil && cv.transcript != "" {
			if reply := LastReply(cv.transcript); reply != "" {
				b.sendReply(c, sid, reply)
			}
		}
	}
	_, _ = b.send(c, sid, alarmText(reason, b.host.ToolName(toolID)), keyboard([]button{readButton("a")}), b.silent(c, toolID))
}

// ensureTopic 은 대화의 토픽을 돌려주고, 없으면 만든다 (FR-TGB-22).
func (b *Bridge) ensureTopic(c Config, sid string) (Topic, error) {
	if t, ok := b.st.Topic(sid); ok {
		return t, nil
	}
	cv := b.convOf(sid, "")
	tab := b.host.ToolName(cv.toolID)
	emoji := stateEmoji(cv.state, cv.ended)
	var created struct {
		ThreadID int64 `json:"message_thread_id"`
	}
	if err := b.call(c, "createForumTopic", map[string]any{"chat_id": c.UserID, "name": topicName(emoji, tab)}, &created); err != nil {
		dmlog.Infof(nil, "telegram: 토픽을 만들지 못했다: %v", err)
		return Topic{}, err
	}
	t := Topic{ThreadID: created.ThreadID, Name: topicName(emoji, tab), ToolID: cv.toolID}
	var msg struct {
		MessageID int64 `json:"message_id"`
	}
	if err := b.call(c, "sendMessage", map[string]any{"chat_id": c.UserID, "message_thread_id": t.ThreadID,
		"text": statusText(emoji, cv.state, tab), "parse_mode": "HTML", "reply_markup": statusKeyboard(),
		"disable_notification": true}, &msg); err == nil {
		t.StatusMsgID = msg.MessageID
		_ = b.call(c, "pinChatMessage", map[string]any{"chat_id": c.UserID, "message_id": msg.MessageID,
			"disable_notification": true}, nil)
	}
	b.lastRename[sid] = b.now()
	if cv.transcript != "" {
		cv.tail = NewTailAtEnd(cv.transcript)
	}
	if err := b.st.PutTopic(sid, t); err != nil {
		return Topic{}, err
	}
	return t, nil
}

// send 는 대화의 토픽에 보낸다. 토픽이 지워졌으면 다시 만들어 한 번 더 보낸다 (FR-TGB-28).
func (b *Bridge) send(c Config, sid, text string, kb map[string]any, silent bool) (int64, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		t, err := b.ensureTopic(c, sid)
		if err != nil {
			return 0, err
		}
		var msg struct {
			MessageID int64 `json:"message_id"`
		}
		p := map[string]any{"chat_id": c.UserID, "message_thread_id": t.ThreadID, "text": text, "parse_mode": "HTML"}
		if kb != nil {
			p["reply_markup"] = kb
		}
		if silent {
			p["disable_notification"] = true
		}
		lastErr = b.call(c, "sendMessage", p, &msg)
		if lastErr == nil {
			return msg.MessageID, nil
		}
		if !threadNotFound(lastErr) {
			break
		}
		_ = b.st.DeleteTopic(sid)
	}
	dmlog.Infof(nil, "telegram: 보내지 못했다: %v", lastErr)
	return 0, lastErr
}

// markName 은 토픽 이름을 고칠 표시다. 10초에 한 번까지 고치고, 나머지는 타이머가
// 모아서 고친다 (FR-TGB-24).
func (b *Bridge) markName(c Config, sid string) {
	if _, ok := b.st.Topic(sid); !ok {
		return
	}
	b.dirty[sid] = true
	wait := renameEvery - b.now().Sub(b.lastRename[sid])
	if wait <= 0 {
		b.renameLocked(c, sid)
		return
	}
	time.AfterFunc(wait, func() { b.enqueue(item{flush: true}) })
}

// flushNames 는 밀린 이름 고치기를 모두 한다.
func (b *Bridge) flushNames() {
	c, ok := b.active()
	if !ok {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.flushLocked(c)
}

func (b *Bridge) flushLocked(c Config) {
	for sid := range b.dirty {
		b.renameLocked(c, sid)
	}
}

func (b *Bridge) renameLocked(c Config, sid string) {
	delete(b.dirty, sid)
	t, ok := b.st.Topic(sid)
	if !ok {
		return
	}
	cv := b.convOf(sid, t.ToolID)
	tab := b.host.ToolName(cv.toolID)
	emoji := stateEmoji(cv.state, cv.ended)
	name := topicName(emoji, tab)
	b.lastRename[sid] = b.now()
	if name == t.Name {
		return
	}
	if err := b.call(c, "editForumTopic", map[string]any{"chat_id": c.UserID, "message_thread_id": t.ThreadID, "name": name}, nil); err != nil {
		dmlog.Infof(nil, "telegram: 토픽 이름을 고치지 못했다: %v", err)
		return
	}
	t.Name = name
	_ = b.st.PutTopic(sid, t)
	if t.StatusMsgID != 0 {
		_ = b.call(c, "editMessageText", map[string]any{"chat_id": c.UserID, "message_id": t.StatusMsgID,
			"text": statusText(emoji, cv.state, tab), "parse_mode": "HTML", "reply_markup": statusKeyboard()}, nil)
	}
}
