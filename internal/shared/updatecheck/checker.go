// Package updatecheck 는 **최신 판이 무엇인지를 한 칸에 담아 둔다**
// (UPDATE_NOTICE_SRS 묶음 확인).
//
// 이 패키지의 결론은 §1.2 의 불변 조항 하나다 — **끈 것은 실제로 나가지 않아야
// 한다.** 토글이 표시만 감추고 뒤에서 네트워크를 계속 쓰면 그것은 기능이 아니라
// 거짓말이다. 그래서 꺼짐 판정은 확인의 **입구**에 있고, 날아가는 중에 꺼졌으면
// 돌아온 답도 버린다.
//
// **낡음 가드를 두지 않는다** (D-UPD-8). 트리거가 오면 확인한다. 가드를 씌우면
// 요청은 줄지만 낡음 기준·시각 영속·실패 시각 분리·백오프 넷이 따라 들어오고,
// 배지 하나에 그 넷은 균형이 맞지 않는다. 억제는 single-flight 하나뿐이며 그것은
// 절약이 아니라 정합성이다 — 창 넷이 같은 질문을 동시에 던지는 것은 "캐시" 라는
// 말과 어긋난다.
package updatecheck

import (
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/release"
	"dongminal/internal/shared/serverconf"
)

// EnvNoCheck 는 확인을 통째로 막는 환경변수다 (FR-UPD-11).
//
// **다른 모든 계층을 이긴다.** 에어갭·CI 환경이 이 한 줄에 달려 있고, 검사의
// 결정론성도 마찬가지다 — 기본이 켜짐이므로 이것이 없으면 검사가 진짜 그물로
// 나간다.
const EnvNoCheck = "DONGMINAL_NO_UPDATE_CHECK"

// DefaultInterval 은 트리거 ③ 의 주기다 (FR-UPD-2).
//
// **보조다.** 갱신의 주된 계기는 사용자가 화면을 여는 순간이고, 이 타이머는
// 한 번도 끄지 않고 띄워 둔 세션만을 위한 것이다.
const DefaultInterval = 24 * time.Hour

// Snapshot 은 지금 캐시에 든 것 전부다. 화면이 배지를 세울지 말지는 이 값만
// 보고 정한다.
type Snapshot struct {
	Enabled   bool   `json:"enabled"`
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Newer     bool   `json:"newer"`
	Link      string `json:"link,omitempty"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Failed    bool   `json:"failed"`
}

// Options 는 확인기의 재료다.
type Options struct {
	// Home 은 토글이 남는 자리다 (`server.json`).
	Home string
	// Current 는 지금 도는 판이다. `dev` 면 견줄 기준이 없다.
	Current string
	// Enabled 는 기동 시점의 토글이다.
	Enabled bool
	// Endpoint 는 검사가 바꿔 끼우는 자리다. 비면 실제 릴리스 API 다.
	Endpoint string
	// Interval 은 트리거 ③ 의 주기다. 0 이면 DefaultInterval.
	Interval time.Duration
	// Getenv 는 킬스위치를 읽는 자리다. 검사가 프로세스 환경을 건드리지 않기
	// 위해 주입받는다.
	Getenv func(string) string
	// Broadcast 는 **결과가 바뀌었을 때만** 불린다 (FR-UPD-8a·8b).
	Broadcast func()
}

// Checker 는 캐시 한 칸과 그것을 채우는 규약이다.
type Checker struct {
	opt    Options
	killed bool

	mu       sync.Mutex
	enabled  bool
	snap     Snapshot
	inflight bool
	timer    *time.Timer
	stopped  bool

	// onSettle 은 확인 한 회가 끝났음을 알린다. 검사만 건다 — 비동기 동작을
	// 재우기로 기다리면 그 검사는 기계가 느린 날 흔들린다.
	onSettle func()
}

// New 는 확인기를 만든다. **아무것도 시작하지 않는다** — 시작은 Start 다.
func New(opt Options) *Checker {
	if opt.Interval <= 0 {
		opt.Interval = DefaultInterval
	}
	getenv := opt.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	opt.Getenv = getenv
	c := &Checker{opt: opt, enabled: opt.Enabled}
	c.killed = getenv(EnvNoCheck) == "1"
	c.snap = Snapshot{Enabled: c.effective(), Current: opt.Current}
	return c
}

// effective 는 지금 실제로 확인이 도는가다. 화면에도 이 값을 답한다 — 환경변수로
// 막혀 있는데 "켜짐" 이라고 말하면 그것은 거짓이다.
func (c *Checker) effective() bool { return c.enabled && !c.killed }

// Start 는 트리거 ① 이다. 기동 확인 한 번과 마감 타이머를 건다.
func (c *Checker) Start() {
	c.Trigger()
	c.mu.Lock()
	defer c.mu.Unlock()
	c.arm()
}

// Trigger 는 트리거 ②·③·④ 의 공통 입구다. **기다리지 않는다** — 부르는 자리가
// SSE 연결 수립과 기동이라 그 둘을 막으면 안 된다 (NFR-UPD-2).
func (c *Checker) Trigger() {
	c.mu.Lock()
	if c.stopped || !c.effective() || c.inflight {
		// 진행 중인 확인이 있으면 그 결과에 합류한다 — 두 번째 요청을
		// 만들지 않는다 (FR-UPD-2b).
		c.mu.Unlock()
		return
	}
	c.inflight = true
	c.mu.Unlock()
	go c.run()
}

// Snapshot 은 캐시를 읽는다. **네트워크도 디스크도 만지지 않는다** (NFR-UPD-3).
func (c *Checker) Snapshot() Snapshot {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.snap
	s.Enabled = c.effective()
	return s
}

// SetEnabled 는 토글을 바꾸고 `server.json` 에 적는다 (FR-UPD-13·14).
//
// 끔→켬 만이 트리거 ④ 다. 이미 켜진 것을 또 켜는 것은 계기가 아니다.
func (c *Checker) SetEnabled(on bool) error {
	c.mu.Lock()
	was := c.enabled
	c.enabled = on
	if !on {
		c.disarm()
	}
	c.mu.Unlock()

	if err := serverconf.SetUpdateCheck(c.opt.Home, on); err != nil {
		return err
	}
	if on && !was {
		c.Trigger()
		c.mu.Lock()
		c.arm()
		c.mu.Unlock()
	}
	return nil
}

// Stop 은 타이머를 푼다. 진행 중인 확인은 끝나되 그 결과는 쓰이지 않는다.
func (c *Checker) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopped = true
	c.disarm()
}

// arm 은 다음 마감을 건다. 호출자가 mu 를 쥔다.
func (c *Checker) arm() {
	c.disarm()
	if c.stopped || !c.effective() {
		return
	}
	c.timer = time.AfterFunc(c.opt.Interval, c.Trigger)
}

// disarm 은 마감을 푼다. 호출자가 mu 를 쥔다.
func (c *Checker) disarm() {
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
}

// run 은 확인 한 회다. **밖으로 나가는 유일한 자리**이며, 여기 닿기 전에
// Trigger 가 꺼짐을 걸렀다.
func (c *Checker) run() {
	tag, link, err := release.Latest(c.opt.Endpoint)

	c.mu.Lock()
	changed := false
	// 날아간 사이에 꺼졌을 수 있다. 그때 돌아온 답은 **버린다** (§1.2) —
	// 끈 뒤에 배지가 서면 껐다는 말이 거짓이 된다.
	if c.effective() && !c.stopped {
		next := c.snap
		next.Current = c.opt.Current
		if err != nil {
			// 실패는 캐시를 바꾸지 않는다 (FR-UPD-2e). 직전 결과가 있으면
			// 그대로 남고, 없으면 "모름" 이다.
			next.Failed = true
			// FR-UPD-4: **조용하다.** 사용자 화면에 오류를 띄우지 않고 로그에만
			// 남긴다 — 망이 없는 것은 사용자가 할 일이 아니다. 그래도 남기는
			// 것은, 배지가 영영 안 뜨는 이유를 물을 사람이 있기 때문이다.
			dmlog.Warnf(nil, "판 확인 실패: %v", err)
		} else {
			next.Failed = false
			next.Latest = tag
			next.Link = link
			next.Newer = release.Comparable(c.opt.Current) && release.Newer(tag, c.opt.Current)
			next.CheckedAt = time.Now().UTC().Format(time.RFC3339)
		}
		changed = notable(c.snap) != notable(next)
		c.snap = next
	}
	c.inflight = false
	c.arm()
	cast := c.opt.Broadcast
	settle := c.onSettle
	c.mu.Unlock()

	if changed && cast != nil {
		cast()
	}
	if settle != nil {
		settle()
	}
}

// notable 은 **화면이 달라지는 부분**만 남긴 값이다 (FR-UPD-8b).
//
// 확인 시각은 매번 바뀌지만 그것으로 방송하면 하루 한 번 바뀌는 값이 연결마다
// 방송된다 — 그것은 소음이다.
type notableView struct {
	latest string
	newer  bool
	link   string
	failed bool
}

func notable(s Snapshot) notableView {
	return notableView{latest: s.Latest, newer: s.Newer, link: s.Link, failed: s.Failed}
}
