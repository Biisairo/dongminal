package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
)

// Event 는 hook 보고 하나다 (FR-TGB-80·81). 서버가 활동 보고에서 옮겨 넣는다.
type Event struct {
	ToolID, Hook string
	Tool, Detail string
	Input        json.RawMessage
	InputOver    bool
	// Transcript 는 대화 기록 파일의 경로다. 내용은 실리지 않는다.
	Transcript string
}

// Location 은 알림의 위치다 (FR-TGB-56). Window 가 비면 알림에서 뺀다.
type Location struct {
	Device, Window, Tab string
}

// Host 는 브리지가 dongminal 에 닿는 자리다. 서버가 채운다.
type Host interface {
	// LastBrowserInput 은 PC 브라우저에서 그 탭에 마지막으로 입력한 시각이다 (FR-TGB-57).
	LastBrowserInput(toolID string) time.Time
	Location(toolID string) Location
	// Attend 는 PC 알람을 끈다. typed 가 거짓이면 포커스를 준 것과 같다 (FR-TGB-58a).
	Attend(toolID string, typed bool)
}

const (
	queueSize = 256
	// maxButtonsPerTab 는 탭 하나가 기억하는 `[읽음]` 메시지 수다 (REFACTOR3_DEFECTS_SRS FR-RD3-42 · D-RD3-4).
	maxButtonsPerTab = 32
	callTimeout      = 15 * time.Second
	// pollTimeout 은 getUpdates long polling 의 대기다. Bot API 는 초 단위 정수를 받는다.
	pollTimeout = 50 * time.Second
	// pollClientTimeout 은 HTTP 클라이언트의 시한이다 — 서버가 pollTimeout 을 채우고 답하는
	// 시간에 여유를 더한다. pollTimeout 보다 짧으면 정상 응답 전에 끊긴다.
	pollClientTimeout = pollTimeout + 20*time.Second
	// disabledRecheck 는 꺼져 있을 때 설정을 다시 보는 간격이다.
	disabledRecheck = 3 * time.Second
	backoffFirst    = time.Second
	backoffMax      = time.Minute
)

// item 은 작업자 큐의 한 칸이다.
type item struct {
	ev                   *Event
	attnTool, attnReason string
	clearTool            string
	// goneTool 은 사라진 도구다 — 그 탭의 직전 hook 을 잊는다 (GD-12).
	goneTool string
	// notice 는 탭과 무관한 글이다 (CLAUDE_ACCOUNTS_SRS FR-CAC-100a).
	notice string
}

// Bridge 는 Telegram 알림이다. 사건은 큐로 받고(NFR-TGB-2), 작업자 하나와 polling
// 하나가 처리한다. mu 는 tabs·buttons 만 지킨다 — Telegram HTTP 는 mu 밖에서 부른다
// (REFACTOR3_DEFECTS_SRS FR-RD3-40). 이전에는 mu 를 쥔 채 HTTP 를 불러, 작업자가 응답을
// 기다리는 동안(호출당 최대 callTimeout) polling 이 멈췄다.
type Bridge struct {
	st   *Store
	host Host
	base string
	now  func() time.Time
	pair *Pairing
	q    chan item

	mu   sync.Mutex
	tabs map[string]*tabState
	// buttons 는 탭마다 `[읽음]` 이 남은 알림의 메시지 id 다 (FR-TGB-58b).
	buttons map[string][]int64
}

// NewBridge 는 브리지를 만든다. base 가 비면 Bot API 주소다.
func NewBridge(st *Store, host Host, base string, now func() time.Time) *Bridge {
	return &Bridge{st: st, host: host, base: base, now: now, pair: NewPairing(now),
		q: make(chan item, queueSize), tabs: map[string]*tabState{}, buttons: map[string][]int64{}}
}

func (b *Bridge) Pairing() *Pairing { return b.pair }

// OnActivity 는 hook 보고를 큐에 넣는다. 막지 않고, 차면 버린다 (NFR-TGB-2).
func (b *Bridge) OnActivity(ev Event) { b.enqueue(item{ev: &ev}) }

// OnAttention 은 PC 알람이다 (FR-TGB-50).
func (b *Bridge) OnAttention(toolID, reason string) {
	b.enqueue(item{attnTool: toolID, attnReason: reason})
}

// OnAttentionClear 는 PC 알람이 꺼진 것이다 (FR-TGB-58b).
func (b *Bridge) OnAttentionClear(toolID string) { b.enqueue(item{clearTool: toolID}) }

// OnNotice 는 탭과 무관한 글 한 통이다 (CLAUDE_ACCOUNTS_SRS FR-CAC-100a). 무음 규칙은 탭 입력 기준이라 쓰지 않는다.
func (b *Bridge) OnNotice(text string) { b.enqueue(item{notice: text}) }

// OnToolGone 은 도구가 끝났거나 지워진 것이다 (REFACTOR3_GO_STRUCT_SRS GD-12). 큐를 지나므로
// 그 앞에 들어온 그 도구의 사건이 먼저 처리된다. 꺼져 있어도 받는다 — 켜 있던 동안 쌓인 것을 걷는다.
//
//	이전: b.tabs 는 넣기만 했다 — 도구 N 개를 만들고 지우면 N 개가 남았다
func (b *Bridge) OnToolGone(toolID string) { b.push(item{goneTool: toolID}) }

func (b *Bridge) enqueue(it item) {
	if !b.st.Config().Enabled {
		return
	}
	b.push(it)
}

func (b *Bridge) push(it item) {
	select {
	case b.q <- it:
	default:
		dmlog.Warnf(nil, "telegram: 사건 큐가 가득 찼다 — 하나를 버린다")
	}
}

// Run 은 작업자와 polling 을 돌린다. ctx 가 끝나면 돌아온다.
func (b *Bridge) Run(ctx context.Context) {
	go b.pollLoop(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case it := <-b.q:
			b.process(it)
		}
	}
}

// process 는 큐의 한 칸을 처리한다. 작업자만 부른다(시험은 직접 부른다).
func (b *Bridge) process(it item) {
	if it.goneTool != "" {
		b.mu.Lock()
		delete(b.tabs, it.goneTool)
		b.mu.Unlock()
		return
	}
	c, ok := b.active()
	if !ok {
		return
	}
	switch {
	case it.ev != nil:
		b.mu.Lock()
		b.tab(it.ev.ToolID).observe(*it.ev)
		b.mu.Unlock()
	case it.clearTool != "":
		b.clearButtons(c, it.clearTool)
	case it.notice != "":
		if err := b.call(c, "sendMessage", map[string]any{"chat_id": c.UserID, "text": it.notice}, nil); err != nil {
			dmlog.Infof(nil, "telegram: 글을 보내지 못했다: %v", err)
		}
	default:
		b.alarm(c, it.attnTool, it.attnReason)
	}
}

func (b *Bridge) tab(toolID string) *tabState {
	ts, ok := b.tabs[toolID]
	if !ok {
		ts = &tabState{}
		b.tabs[toolID] = ts
	}
	return ts
}

func (b *Bridge) active() (Config, bool) {
	c := b.st.Config()
	return c, c.Enabled && c.Token != "" && c.UserID != 0
}

func (b *Bridge) client(c Config) *Client { return NewClient(b.base, c.Token, nil) }

func (b *Bridge) call(c Config, method string, params map[string]any, out any) error {
	ctx, cancel := context.WithTimeout(context.Background(), callTimeout)
	defer cancel()
	return b.client(c).Call(ctx, method, params, out)
}

func (b *Bridge) pollLoop(ctx context.Context) {
	var offset int64
	wait := backoffFirst
	for ctx.Err() == nil {
		c := b.st.Config()
		if !c.Enabled || c.Token == "" {
			if !sleepCtx(ctx, disabledRecheck) {
				return
			}
			continue
		}
		ups, err := b.client(c).GetUpdates(ctx, offset, int(pollTimeout/time.Second))
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			d := wait
			var ae *APIError
			if errors.As(err, &ae) && ae.RetryAfter > 0 {
				d = time.Duration(ae.RetryAfter) * time.Second
			}
			dmlog.Infof(nil, "telegram: 받기 실패 — %v 뒤 다시: %v", d, err)
			if !sleepCtx(ctx, d) {
				return
			}
			wait = min(wait*2, backoffMax)
			continue
		}
		wait = backoffFirst
		for _, u := range ups {
			offset = u.UpdateID + 1
			b.handleUpdate(u)
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
