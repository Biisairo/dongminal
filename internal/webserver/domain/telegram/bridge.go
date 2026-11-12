package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
)

// Event 는 hook 보고 하나다 (FR-TGB-80·81). 서버가 활동 보고에서 옮겨 넣는다.
type Event struct {
	ToolID, SessionID, State string
	Hook, ToolUseID, Source  string
	Tool, Detail             string
	Input                    json.RawMessage
	InputOver                bool
	// Transcript 는 대화 기록 파일의 경로다. 내용은 실리지 않는다.
	Transcript string
}

// AgentInfo 는 `/agents` 목록의 한 줄이다 (FR-TGB-23). hook 이 없는 에이전트는
// SessionID 가 비고, 브리지는 "tool:"+ToolID 를 대화로 본다.
type AgentInfo struct {
	SessionID, ToolID, Name, State string
}

// Host 는 브리지가 dongminal 에 닿는 자리다. 서버가 채운다.
type Host interface {
	// Paste 는 글을 붙여넣기 + 제출로 넣는다 (FR-TGB-30).
	Paste(toolID, text string) error
	// Keys 는 원시 키를 넣는다 (FR-TGB-31).
	Keys(toolID string, b []byte) error
	// Attend 는 PC 알람을 끈다 (FR-TGB-70·71).
	Attend(toolID string, typed bool)
	// LastBrowserInput 은 PC 브라우저에서 그 탭에 마지막으로 입력한 시각이다 (FR-TGB-53).
	LastBrowserInput(toolID string) time.Time
	ToolName(toolID string) string
	// Screen 은 화면 끝부분(ANSI 를 걷은 글)이다 (FR-TGB-32).
	Screen(toolID string) string
	Agents() []AgentInfo
}

const (
	queueSize    = 256
	renameEvery  = 10 * time.Second
	callTimeout  = 15 * time.Second
	pollTimeout  = 50
	backoffFirst = time.Second
	backoffMax   = time.Minute
	toolSIDPfx   = "tool:"
	// draftEvery 는 "작업 중" 표시를 다시 보내는 간격이다. draft 는 30초 미리보기다 (FR-TGB-65).
	draftEvery = 20 * time.Second
	// stopSettle 은 Stop 뒤 transcript 의 마지막 줄을 한 번 더 읽는 틈이다.
	stopSettle = 1500 * time.Millisecond
)

// item 은 작업자 큐의 한 칸이다.
type item struct {
	ev                   *Event
	attnTool, attnReason string
	flush                bool
	pumpSID              string
}

// conv 는 살아 있는 대화 하나다.
type conv struct {
	toolID      string
	state       string
	ended       bool
	lastToolUse string
	transcript  string
	tail        *Tail
	lastDraft   time.Time
}

// request 는 답을 기다리는 권한 요청·질문 하나다 (FR-TGB-40·41·43).
type request struct {
	sid, toolUseID string
	msgID          int64
	at             time.Time
	closed         bool
}

// Bridge 는 Telegram 브리지다. 사건은 큐로 받고(NFR-TGB-2), 작업자 하나와 polling
// 하나가 mu 아래에서 차례로 처리한다. 쓰는 사람이 하나라 직렬이면 충분하다.
type Bridge struct {
	st   *Store
	host Host
	base string
	now  func() time.Time
	pair *Pairing
	q    chan item

	mu         sync.Mutex
	live       map[string]*conv
	byTool     map[string]string
	reqs       map[string]*request
	lastRename map[string]time.Time
	dirty      map[string]bool
	seq        uint64
}

// NewBridge 는 브리지를 만든다. base 가 비면 Bot API 주소다.
func NewBridge(st *Store, host Host, base string, now func() time.Time) *Bridge {
	return &Bridge{st: st, host: host, base: base, now: now, pair: NewPairing(now),
		q: make(chan item, queueSize), live: map[string]*conv{}, byTool: map[string]string{},
		reqs: map[string]*request{}, lastRename: map[string]time.Time{}, dirty: map[string]bool{}}
}

func (b *Bridge) Pairing() *Pairing { return b.pair }

// OnActivity 는 hook 보고를 큐에 넣는다. 막지 않고, 차면 버린다 (NFR-TGB-2).
func (b *Bridge) OnActivity(ev Event) { b.enqueue(item{ev: &ev}) }

// OnAttention 은 PC 알람과 같은 판정의 알림 신호다 (FR-TGB-50).
func (b *Bridge) OnAttention(toolID, reason string) {
	b.enqueue(item{attnTool: toolID, attnReason: reason})
}

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

// nextID 는 버튼 데이터에 싣는 짧은 id 다.
func (b *Bridge) nextID() string {
	b.seq++
	return strings.ToLower(strings.TrimLeft(itob36(b.seq), "0"))
}

func itob36(n uint64) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	if n == 0 {
		return "0"
	}
	var out []byte
	for n > 0 {
		out = append([]byte{digits[n%36]}, out...)
		n /= 36
	}
	return string(out)
}

// threadNotFound 는 토픽이 지워졌다는 오류인가다 (FR-TGB-28).
func threadNotFound(err error) bool {
	var ae *APIError
	if !errors.As(err, &ae) {
		return false
	}
	d := strings.ToLower(ae.Description)
	return strings.Contains(d, "thread not found") || strings.Contains(d, "topic_deleted") ||
		strings.Contains(d, "topic_id_invalid") || strings.Contains(d, "invalid forum topic")
}
