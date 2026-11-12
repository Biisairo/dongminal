package httpapi

import (
	"context"
	"path/filepath"
	"sync"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/webserver/domain/telegram"
)

// telegramScreenTail 은 [화면] 이 읽는 PTY 끝부분의 바이트 수다 (FR-TGB-32). 브리지가
// 다시 3500자로 자른다.
const telegramScreenTail = 16 << 10

// telegramSink 는 브리지가 받는 두 사건이다. 시험은 기록기를 꽂는다.
type telegramSink interface {
	OnActivity(ev telegram.Event)
	OnAttention(toolID, reason string)
}

// telegramWire 는 서버와 Telegram 브리지의 이음매다 (TELEGRAM_BRIDGE_SRS ⑤).
type telegramWire struct {
	st     *telegram.Store
	sink   telegramSink
	bridge *telegram.Bridge

	mu sync.Mutex
	// sessions 는 도구의 마지막 session_id 다. 브리지가 켜져 있을 때만 쓴다 (FR-TGB-82).
	sessions map[string]string
}

func newTelegramWire(st *telegram.Store, sink telegramSink) *telegramWire {
	return &telegramWire{st: st, sink: sink, sessions: map[string]string{}}
}

func (w *telegramWire) session(toolID string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sessions[toolID]
}

func (w *telegramWire) remember(toolID, state, sid string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	switch {
	case state == activity.Ended:
		delete(w.sessions, toolID)
	case sid != "":
		w.sessions[toolID] = sid
	}
}

// initTelegram 은 설정 파일과 브리지를 세운다. 기동은 StartTelegram 이 한다.
func (s *Server) initTelegram() {
	if s.cfg.DataDir == "" {
		return
	}
	st := telegram.OpenStore(filepath.Join(s.cfg.DataDir, dmenv.TelegramFile))
	b := telegram.NewBridge(st, telegramHost{s}, s.cfg.TelegramAPI, time.Now)
	s.tg = newTelegramWire(st, b)
	s.tg.bridge = b
	s.wireTelegramAttention()
}

// wireTelegramAttention 은 PC 알람과 같은 판정을 브리지에 넘긴다 (FR-TGB-50).
func (s *Server) wireTelegramAttention() {
	if s.tg == nil {
		return
	}
	if h, ok := s.Commands.(interface {
		SetAttentionObserver(func(id, reason string))
	}); ok {
		h.SetAttentionObserver(s.tg.sink.OnAttention)
	}
}

// telegramActivity 는 main 에이전트의 활동 보고를 브리지 사건으로 옮긴다 (FR-TGB-80·81).
// 꺼져 있으면 아무것도 하지 않는다 (FR-TGB-82 · NFR-TGB-1).
func (s *Server) telegramActivity(req agentrec.ActivityReport) {
	if s.tg == nil || !s.tg.st.View().Enabled {
		return
	}
	s.tg.remember(req.ToolID, req.State, req.SessionID)
	s.tg.sink.OnActivity(telegram.Event{
		ToolID: req.ToolID, SessionID: req.SessionID, State: req.State,
		Hook: req.Hook, ToolUseID: req.ToolUseID, Source: req.Source,
		Tool: req.Tool, Detail: req.Detail, Input: req.Input, InputOver: req.InputOver,
		Transcript: req.Transcript,
	})
}

// StartTelegram 은 브리지를 돌리고, stop 이 닫히면 멈춘다. 돌려준 채널은 멈춘 뒤 닫힌다.
// 꺼져 있으면 브리지는 Telegram 에 아무 요청도 하지 않는다 (NFR-TGB-1).
func (s *Server) StartTelegram(stop <-chan struct{}) <-chan struct{} {
	done := make(chan struct{})
	if s.tg == nil || s.tg.bridge == nil {
		close(done)
		return done
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-stop
		cancel()
	}()
	go func() {
		defer close(done)
		s.tg.bridge.Run(ctx)
	}()
	return done
}

// telegramHost 는 telegram.Host 의 서버 구현이다. 기존 문만 지난다.
type telegramHost struct{ s *Server }

func (h telegramHost) Paste(toolID, text string) error {
	return h.s.deliverToTool(toolID, text, true)
}

func (h telegramHost) Keys(toolID string, b []byte) error {
	return h.s.ToolIO.Write(toolID, b)
}

func (h telegramHost) Attend(toolID string, typed bool) {
	h.s.attention().Attend(toolID, typed)
}

func (h telegramHost) LastBrowserInput(toolID string) time.Time {
	return h.s.LastBrowserInput(toolID)
}

// ToolName 은 워크스페이스의 탭 이름이다. 없으면 전경 이름, 그것도 없으면 도구 id 다.
func (h telegramHost) ToolName(toolID string) string {
	if h.s.WorkIndex != nil {
		for _, e := range h.s.WorkIndex.Entries() {
			if e.ToolID == toolID && e.TabName != "" {
				return e.TabName
			}
		}
	}
	if h.s.ToolIO != nil {
		for _, t := range h.s.ToolIO.List() {
			if t.ID == toolID && t.ForegroundName != "" {
				return t.ForegroundName
			}
		}
	}
	return toolID
}

// Screen 은 화면 끝부분을 ANSI 를 걷어 돌려준다 (FR-TGB-32). 없는 도구는 빈 글이다.
func (h telegramHost) Screen(toolID string) string {
	if h.s.ToolIO == nil {
		return ""
	}
	data, _, ok := h.s.ToolIO.Snapshot(toolID)
	if !ok {
		return ""
	}
	if len(data) > telegramScreenTail {
		data = data[len(data)-telegramScreenTail:]
	}
	return stripANSI(data)
}

// Agents 는 활동 보고가 있는 도구들이다 — 활동 패널과 같은 원천이다 (FR-TGB-23).
func (h telegramHost) Agents() []telegram.AgentInfo {
	snap := h.s.attention().ActivitySnapshot()
	out := make([]telegram.AgentInfo, 0, len(snap))
	for _, a := range snap {
		sid := ""
		if h.s.tg != nil {
			sid = h.s.tg.session(a.ToolID)
		}
		out = append(out, telegram.AgentInfo{SessionID: sid, ToolID: a.ToolID, Name: h.ToolName(a.ToolID), State: a.State})
	}
	return out
}
