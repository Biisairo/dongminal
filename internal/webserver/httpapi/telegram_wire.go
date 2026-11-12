package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/webserver/domain/telegram"
)

// telegramSink 는 브리지가 받는 두 사건이다. 시험은 기록기를 꽂는다.
type telegramSink interface {
	OnActivity(ev telegram.Event)
	OnAttention(toolID, reason string)
	OnAttentionClear(toolID string)
}

// telegramWire 는 서버와 Telegram 브리지의 이음매다.
type telegramWire struct {
	st     *telegram.Store
	sink   telegramSink
	bridge *telegram.Bridge
}

func newTelegramWire(st *telegram.Store, sink telegramSink) *telegramWire {
	return &telegramWire{st: st, sink: sink}
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

// wireTelegramAttention 은 PC 알람과 그 해제를 브리지에 넘긴다 (FR-TGB-50·58b).
func (s *Server) wireTelegramAttention() {
	if s.tg == nil {
		return
	}
	if h, ok := s.Commands.(interface {
		SetAttentionObserver(func(id, reason string))
		SetAttentionClearObserver(func(id string))
	}); ok {
		h.SetAttentionObserver(s.tg.sink.OnAttention)
		h.SetAttentionClearObserver(s.tg.sink.OnAttentionClear)
	}
}

// telegramActivity 는 main 에이전트의 hook 보고를 브리지 사건으로 옮긴다 (FR-TGB-80·81).
// 꺼져 있으면 아무것도 하지 않는다 (FR-TGB-82 · NFR-TGB-1).
func (s *Server) telegramActivity(req agentrec.ActivityReport) {
	if s.tg == nil || !s.tg.st.View().Enabled {
		return
	}
	s.tg.sink.OnActivity(telegram.Event{
		ToolID: req.ToolID, Hook: req.Hook, Tool: req.Tool, Detail: req.Detail,
		Input: req.Input, InputOver: req.InputOver, Transcript: req.Transcript,
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

// Attend 는 PC 알람을 끈다. 포커스와 같은 문이다 (FR-TGB-58a).
func (h telegramHost) Attend(toolID string, typed bool) {
	h.s.attention().Attend(toolID, typed)
}

func (h telegramHost) LastBrowserInput(toolID string) time.Time {
	return h.s.LastBrowserInput(toolID)
}

// Location 은 기기 › 윈도우 › 탭 이다 (FR-TGB-56). 기기는 페이지 제목, 비면 호스트 이름이다
// (D-TGB-17). 탭 이름이 없으면 전경 이름, 그것도 없으면 도구 id 다.
func (h telegramHost) Location(toolID string) telegram.Location {
	loc := telegram.Location{Device: h.device(), Tab: toolID}
	if h.s.WorkIndex != nil {
		for _, e := range h.s.WorkIndex.Entries() {
			if e.ToolID == toolID {
				loc.Window = e.WindowName
				if e.TabName != "" {
					loc.Tab = e.TabName
					return loc
				}
				break
			}
		}
	}
	if h.s.ToolIO != nil {
		for _, t := range h.s.ToolIO.List() {
			if t.ID == toolID && t.ForegroundName != "" {
				loc.Tab = t.ForegroundName
			}
		}
	}
	return loc
}

func (h telegramHost) device() string {
	if h.s.Settings != nil {
		if t := h.s.Settings.PageTitle(); t != "" {
			return t
		}
	}
	name, _ := os.Hostname()
	return name
}
