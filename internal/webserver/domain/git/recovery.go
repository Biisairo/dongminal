package git

import (
	"sync"
	"time"
)

// DefaultHintCap 은 세션 동안 들고 있을 hint 수다. 상한은 상수로 못박는다.
const DefaultHintCap = 200

// Hint 는 파괴적 동작 직전에 기록한 복구 수단이다. **값을 기록하는 것이 본질이다**
// — 안내문만으로는 지워진 ref 를 되살릴 수 없다 (FR-GIT-92).
//
// 값을 못 얻으면 Values 를 비우고 Note 에 **왜 못 얻었는지**를 남긴다. 조용히 빈
// hint 를 만들지 않는다.
type Hint struct {
	Seq      uint64   `json:"seq"`
	AtUnixMs int64    `json:"atUnixMs"`
	Repo     string   `json:"repo"`
	Action   string   `json:"action"`  // discard | branch_delete | stash_drop | …
	Targets  []string `json:"targets"` // 대상 목록 (경로·ref 이름)
	Values   []string `json:"values"`  // 되살리는 데 필요한 값 (ref 의 sha 등)
	Command  string   `json:"command"` // 사용자가 터미널에 붙여넣을 명령
	Note     string   `json:"note"`
}

// HintLog 는 세션 동안의 hint 를 들고 있다 (FR-GIT-93). 고정 길이 링 버퍼이며
// 무한히 자라지 않는다. 제로값도 쓸 수 있다 — 첫 Add 가 기본 용량으로 자리를 잡고,
// "hint 로그가 없어서 기록하지 못했다" 는 경로를 만들지 않는다.
type HintLog struct {
	mu   sync.Mutex
	buf  []Hint
	cap  int    // 0 이면 DefaultHintCap
	next int    // 다음에 쓸 자리
	n    int    // 보유량
	seq  uint64 // 마지막으로 부여한 Seq
}

func NewHintLog(cap int) *HintLog { return &HintLog{cap: cap} }

// Add 는 Seq 를 채워 기록하고 그 값을 돌려준다 — 호출자가 사용자에게 보일 것이
// 기록된 것과 같아야 한다. 링이 넘쳐 오래된 것이 버려져도 Seq 는 되돌아가지 않는다.
//
// 시각이 비어 있으면 채운다. 시각 없는 hint 는 "언제의 복구 수단인지" 를 잃는다.
func (l *HintLog) Add(h Hint) Hint {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.buf) == 0 {
		size := l.cap
		if size <= 0 {
			size = DefaultHintCap
		}
		l.buf = make([]Hint, size)
	}
	l.seq++
	h.Seq = l.seq
	if h.AtUnixMs == 0 {
		h.AtUnixMs = time.Now().UnixMilli()
	}
	l.buf[l.next] = h
	l.next = (l.next + 1) % len(l.buf)
	if l.n < len(l.buf) {
		l.n++
	}
	return h
}

// Recent 는 최신이 마지막인 복사본을 준다. n<=0 이면 보유분 전부다. 복사인 이유는
// 호출자가 내부 링을 들고 있으면 다음 Add 와 경합하기 때문이다.
func (l *HintLog) Recent(n int) []Hint {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n <= 0 || n > l.n {
		n = l.n
	}
	out := make([]Hint, n)
	if n == 0 {
		return out
	}
	start := (l.next - n + len(l.buf)*2) % len(l.buf)
	for i := 0; i < n; i++ {
		out[i] = l.buf[(start+i)%len(l.buf)]
	}
	return out
}

func (l *HintLog) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.n
}

// AddHint 는 파괴적 동작 직전의 복구 수단을 기록한다 (FR-GIT-92). Seq 가 채워진
// 값을 돌려준다.
func (s *Service) AddHint(h Hint) Hint { return s.hints.Add(h) }

// Hints 는 세션 동안 기록된 hint 를 준다 (최신이 마지막). n<=0 이면 보유분 전부다
// (FR-GIT-93).
func (s *Service) Hints(n int) []Hint { return s.hints.Recent(n) }
