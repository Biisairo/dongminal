package core

import (
	"sync"
	"time"
)

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
	Destructive     bool     `json:"destructive"` // FR-GIT-95. 호출자의 선언(I5)
	// Write 는 하위 명령이 writeCommands 에 있는지다 (FR-GIT-218). Destructive 와
	// 다르다 — `add` 는 쓰기지만 파괴적이지 않다. Console 이 폴링을 감출 때
	// 딛는 값이고, 판정을 새로 만들지 않으려고 실행 경로와 같은 목록을 쓴다.
	Write      bool   `json:"write"`
	StdinBytes int    `json:"stdinBytes"` // FR-GIT-77. **내용은 남기지 않는다** (I6)
	Err        string `json:"err,omitempty"`
}

// newRecord 는 실행 결과를 기록 한 줄로 옮긴다. 읽기·쓰기가 같은 매핑을 쓰도록 한
// 자리에 둔다 — 한쪽만 필드를 늘리면 Console 이 보는 것이 경로마다 달라진다.
//
// **stdin 은 받지 않는다** (I6). 파괴적 여부와 stdin 바이트 수는 쓰기 경로가
// 자기 선언으로 채운다.
func newRecord(dir string, argv []string, out Output, err error) Record {
	rec := Record{
		AtUnixMs:        time.Now().UnixMilli(),
		Write:           IsWriteCommand(argv),
		Argv:            append([]string(nil), argv...),
		Cwd:             dir,
		ExitCode:        out.ExitCode,
		DurationMs:      out.DurationMs,
		Stderr:          out.Stderr,
		StdoutBytes:     len(out.Stdout),
		StdoutTruncated: out.StdoutTruncated,
		StderrTruncated: out.StderrTruncated,
	}
	if err != nil {
		rec.Err = err.Error()
	}
	return rec
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
