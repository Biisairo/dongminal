package telegram

import (
	"slices"
	"time"

	"dongminal/internal/shared/dmlog"
)

// askTool 은 사용자에게 선택지를 묻는 도구다.
const askTool = "AskUserQuestion"

// tabState 는 탭 하나의 직전 hook 이다 (FR-TGB-51·55). 알람이 울릴 때 종류와 내용을 정한다.
type tabState struct {
	transcript string
	// ask·perm 은 열린 질문·권한 요청이다. 닫는 hook 이 오면 지운다.
	ask, perm *Event
	notice    string
	// failure 는 StopFailure 의 error 다. failed 가 참일 때만 뜻이 있다.
	failed  bool
	failure string
}

func (ts *tabState) close() {
	ts.ask, ts.perm, ts.notice, ts.failed, ts.failure = nil, nil, "", false, ""
}

func (ts *tabState) observe(ev Event) {
	if ev.Transcript != "" {
		ts.transcript = ev.Transcript
	}
	switch ev.Hook {
	case "PreToolUse":
		if ev.Tool == askTool {
			ts.ask = &ev
		}
	case "PermissionRequest":
		ts.perm = &ev
	case "Notification":
		ts.notice = ev.Detail
	case "StopFailure":
		ts.close()
		ts.failed, ts.failure = true, ev.Detail
	case "PostToolUse", "PostToolUseFailure", "Stop", "UserPromptSubmit", "SessionStart", "SessionEnd":
		ts.close()
	}
}

// alarmKind 는 알림의 종류다 (FR-TGB-51).
type alarmKind struct {
	emoji, label, tool string
}

var (
	kindDone       = alarmKind{emoji: "✅", label: "완료"}
	kindError      = alarmKind{emoji: "❌", label: "오류"}
	kindQuestion   = alarmKind{emoji: "❓", label: "질문"}
	kindPermission = alarmKind{emoji: "🔐", label: "권한 요청"}
	kindWaiting    = alarmKind{emoji: "⏳", label: "입력 대기"}
	kindOther      = alarmKind{emoji: "🔔", label: "알림"}
)

// classify 는 알람 사유와 직전 hook 으로 종류와 내용(HTML)을 정한다. ts 가 nil 이면 hook 이
// 없는 에이전트다 (FR-TGB-52·59).
func classify(reason string, ts *tabState) (alarmKind, string) {
	if ts == nil {
		ts = &tabState{}
	}
	switch reason {
	case "done":
		if ts.failed {
			return kindError, plainHTML(ts.failure)
		}
		if ts.transcript == "" {
			return kindDone, ""
		}
		return kindDone, mdToHTML(cutRunes(LastReply(ts.transcript)))
	case "waiting":
		if p := ts.perm; p != nil && p.Tool != askTool {
			k := kindPermission
			k.tool = p.Tool
			return k, codeHTML(permSummary(p.Input, p.Detail))
		}
		if ts.ask != nil || ts.perm != nil {
			return kindQuestion, questionHTML(questionInput(ts))
		}
		return kindWaiting, plainHTML(ts.notice)
	}
	return kindOther, ""
}

// questionInput 은 질문의 입력이다. 권한 요청에 입력이 없으면 앞서 연 질문의 것이다 (FR-TGB-55).
func questionInput(ts *tabState) []byte {
	if ts.perm != nil && len(ts.perm.Input) > 0 {
		return ts.perm.Input
	}
	if ts.ask != nil {
		return ts.ask.Input
	}
	return nil
}

func (b *Bridge) alarm(c Config, toolID, reason string) {
	kind, body := classify(reason, b.tabs[toolID])
	p := map[string]any{"chat_id": c.UserID, "text": alarmText(kind, b.host.Location(toolID), body), "parse_mode": "HTML"}
	kb := readKeyboard(toolID)
	if kb != nil {
		p["reply_markup"] = kb
	}
	if b.silent(c, toolID) {
		p["disable_notification"] = true
	}
	var msg struct {
		MessageID int64 `json:"message_id"`
	}
	if err := b.call(c, "sendMessage", p, &msg); err != nil {
		dmlog.Infof(nil, "telegram: 알림을 보내지 못했다: %v", err)
		return
	}
	if kb != nil {
		b.buttons[toolID] = append(b.buttons[toolID], msg.MessageID)
	}
}

// clearButtons 는 그 탭의 남은 `[읽음]` 을 모두 걷는다 (FR-TGB-58b).
func (b *Bridge) clearButtons(c Config, toolID string) {
	for _, id := range b.buttons[toolID] {
		b.dropButton(c, c.UserID, id)
	}
	delete(b.buttons, toolID)
}

// forgetButton 은 이미 걷은 메시지를 목록에서 뺀다.
func (b *Bridge) forgetButton(toolID string, msgID int64) {
	ids := slices.DeleteFunc(b.buttons[toolID], func(id int64) bool { return id == msgID })
	if len(ids) == 0 {
		delete(b.buttons, toolID)
		return
	}
	b.buttons[toolID] = ids
}

func (b *Bridge) dropButton(c Config, chatID, msgID int64) {
	_ = b.call(c, "editMessageReplyMarkup", map[string]any{"chat_id": chatID, "message_id": msgID,
		"reply_markup": map[string]any{"inline_keyboard": [][]any{}}}, nil)
}

func (b *Bridge) silent(c Config, toolID string) bool {
	if c.SilenceMin <= 0 {
		return false
	}
	last := b.host.LastBrowserInput(toolID)
	return !last.IsZero() && b.now().Sub(last) < time.Duration(c.SilenceMin)*time.Minute
}
