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
	queueSize    = 256
	callTimeout  = 15 * time.Second
	pollTimeout  = 50
	backoffFirst = time.Second
	backoffMax   = time.Minute
)

// item 은 작업자 큐의 한 칸이다.
type item struct {
	ev                   *Event
	attnTool, attnReason string
	clearTool            string
}

// Bridge 는 Telegram 알림이다. 사건은 큐로 받고(NFR-TGB-2), 작업자 하나와 polling
// 하나가 mu 아래에서 차례로 처리한다.
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

func (b *Bridge) enqueue(it item) {
	if !b.st.Config().Enabled {
		return
	}
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
	c, ok := b.active()
	if !ok {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	switch {
	case it.ev != nil:
		b.tab(it.ev.ToolID).observe(*it.ev)
	case it.clearTool != "":
		b.clearButtons(c, it.clearTool)
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
			if !sleepCtx(ctx, 3*time.Second) {
				return
			}
			continue
		}
		ups, err := b.client(c).GetUpdates(ctx, offset, pollTimeout)
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
