package core

import (
	"crypto/rand"
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
	// Unguarded 는 이 실행이 **명령 화이트리스트를 지나지 않았다**는 표식이다
	// (GIT_EXEC_UNIFY_SRS FR-GXU-5). `domain/worktree`·`domain/submodule`·
	// `checkIgnore` 가 자기 인가를 거친 뒤 실행 층만 공유하는 경로다.
	//
	// 이 표식이 없으면 Console 에서 두 부류가 한 목록에 섞이고, 그 목록을 근거로
	// 삼는 판단이 틀린다. **Write 와 함께 읽어야 한다** — 이 경로의 argv 는
	// writeCommands 에 없으므로 Write 가 false 이며, 그것이 뜻하는 것은 "쓰기가
	// 아니다"가 아니라 "쓰기 목록에 없다"이다.
	Unguarded bool `json:"unguarded,omitempty"`
	// Reason 은 인가를 건너뛴 사유다. 빈 값으로는 실행되지 않는다 (FR-GXU-1).
	Reason string `json:"reason,omitempty"`
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
	// epoch 는 이 링의 세대다. 서버가 다시 뜨면 Seq 가 처음부터라 커서만으로는 옛 세대의
	// 커서를 가려내지 못한다 — 새 Seq 가 옛 커서를 넘어서면 증분처럼 보인다 (FR-OPT-4-8).
	epoch string
}

func NewRecorder(cap int) *Recorder {
	if cap <= 0 {
		cap = DefaultRecordCap
	}
	return &Recorder{buf: make([]Record, cap), epoch: rand.Text()}
}

// Epoch 는 이 링의 세대다. 링마다 다르고 수명 동안 바뀌지 않는다.
func (r *Recorder) Epoch() string { return r.epoch }

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

// RecordSpan 은 Since 가 본 링의 범위다. First 는 보유분 중 가장 오래된 Seq(없으면
// Last+1), Last 는 마지막으로 부여한 Seq 다. Gap 은 요청한 커서에서 증분으로 이을 수
// 없다는 뜻이다 — 링이 그 사이를 버렸거나, 커서가 Last 보다 크다(서버가 다시 떠 Seq 가
// 처음부터다), 커서의 세대가 이 링의 것이 아니다.
type RecordSpan struct {
	First uint64
	Last  uint64
	Gap   bool
	Epoch string
}

// Since 는 Seq 가 after 보다 큰 기록을 준다 (최신이 마지막, OPTIMIZE_REFACTOR_SRS
// FR-OPT-4-8). Gap 이면 보유분 전부를 준다 — 호출자는 받은 것으로 갈아 끼운다.
// epoch 는 커서를 받은 세대다. 빈 값(세대를 모르는 물음)이면 Seq 로만 판정한다.
func (r *Recorder) Since(after uint64, epoch string) ([]Record, RecordSpan) {
	r.mu.Lock()
	defer r.mu.Unlock()
	span := RecordSpan{First: r.seq - uint64(r.n) + 1, Last: r.seq, Epoch: r.epoch}
	span.Gap = after > span.Last || after+1 < span.First || (epoch != "" && epoch != r.epoch)
	n := r.n
	if !span.Gap {
		n = int(span.Last - after)
	}
	out := make([]Record, n)
	start := (r.next - n + len(r.buf)*2) % len(r.buf)
	for i := 0; i < n; i++ {
		out[i] = r.buf[(start+i)%len(r.buf)]
	}
	return out, span
}

func (r *Recorder) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n
}
