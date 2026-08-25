package git

import "sync"

// Record 는 실행 한 번의 구조화된 기록이다 (FR-GIT-5). M1 은 기록만 하고
// 표시하지 않는다 — Console 탭(M6)이 이것을 읽는다.
type Record struct {
	Seq             uint64   `json:"seq"`
	AtUnixMs        int64    `json:"atUnixMs"`
	Argv            []string `json:"argv"`
	Cwd             string   `json:"cwd"`
	ExitCode        int      `json:"exitCode"`
	DurationMs      int64    `json:"durationMs"`
	Stderr          string   `json:"stderr"`
	StdoutBytes     int      `json:"stdoutBytes"`
	StdoutTruncated bool     `json:"stdoutTruncated"`
	StderrTruncated bool     `json:"stderrTruncated"`
	Destructive     bool     `json:"destructive"` // FR-GIT-95. M1 은 항상 false
	Err             string   `json:"err,omitempty"`
}

// Recorder 는 고정 길이 링 버퍼다. 무한히 자라지 않는다.
type Recorder struct {
	mu   sync.Mutex
	buf  []Record
	next int    // 다음에 쓸 자리
	n    int    // 보유량
	seq  uint64 // 마지막으로 부여한 Seq
}

func NewRecorder(cap int) *Recorder {
	if cap <= 0 {
		cap = DefaultRecordCap
	}
	return &Recorder{buf: make([]Record, cap)}
}

// Add 는 Seq 를 부여해 기록한다. 링이 넘쳐 오래된 것이 버려져도 Seq 는 되돌아가지
// 않는다 — Console 이 "무엇이 유실됐는지" 알 수 있어야 한다.
func (r *Recorder) Add(rec Record) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.seq++
	rec.Seq = r.seq
	r.buf[r.next] = rec
	r.next = (r.next + 1) % len(r.buf)
	if r.n < len(r.buf) {
		r.n++
	}
}

// Recent 는 최신이 마지막인 복사본을 준다. n<=0 이면 보유분 전부다. 복사인 이유는
// 호출자가 내부 링을 들고 있으면 다음 Add 와 경합하기 때문이다.
func (r *Recorder) Recent(n int) []Record {
	r.mu.Lock()
	defer r.mu.Unlock()
	if n <= 0 || n > r.n {
		n = r.n
	}
	out := make([]Record, n)
	start := (r.next - n + len(r.buf)*2) % len(r.buf)
	for i := 0; i < n; i++ {
		out[i] = r.buf[(start+i)%len(r.buf)]
	}
	return out
}

func (r *Recorder) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n
}
