package jobs

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/uuid"
	"dongminal/internal/webserver/domain/git/core"
)

// 원격 작업은 다른 git 실행과 성질이 다르다: 초 단위가 아니라 분 단위이고, 출력이
// 진행 상황이며, 취소할 수 있어야 한다. 그래서 Exec/ExecWrite 와 별도 경로다
// (GIT_SRS §3B.1 FR-GIT-101~104).

// 상한은 상수로 못박는다 — 호출 지점마다 다른 숫자가 흩어지면 상한이 상한이
// 아니게 된다.
const (
	// RemoteOpCeiling 은 원격 작업 하나의 상한이다 (O9). **실질 종료 수단은
	// 취소이고 이것은 고아 프로세스 안전망이다** — 브라우저를 닫은 사용자의
	// 프로세스가 영구히 남지 않게 한다.
	RemoteOpCeiling = 10 * time.Minute
	// JobLineCap 은 보존 줄 수 상한이다. 초과분은 앞에서 버린다.
	JobLineCap = 2000
	// JobRetention 은 끝난 작업을 들고 있는 기간이다. 취소·실패의 이유를 사용자가
	// 뒤늦게 볼 수 있어야 한다.
	JobRetention = 5 * time.Minute
	// JobKillGrace 는 SIGTERM 뒤 SIGKILL 까지의 유예다.
	JobKillGrace = 3 * time.Second
	// JobLineMax 는 한 줄의 바이트 상한이다. 구분자 없는 스트림 하나가 메모리를
	// 삼키지 않게 한다.
	JobLineMax = 4096
)

// Line 의 스트림 이름. 진행 상황은 stderr 로 오지만 그것은 오류가 아니다 —
// 표시 계층이 구분할 수 있어야 한다.
const (
	LineStdout = "stdout"
	LineStderr = "stderr"
)

// 후속 선택지의 이름 (FR-GIT-105). 서버 응답과 클라이언트의 선택 화면이 같은
// 문자열을 봐야 하므로 한 자리에 둔다.
const (
	FixFetchRebase    = "fetch_rebase"
	FixFetchMerge     = "fetch_merge"
	FixForceWithLease = "force_with_lease"
)

// RemoteRejectOptions 는 push 거부 뒤의 후속 선택지다. **순서가 곧 우선순위다** —
// force 는 마지막이고 기본 제안이 아니다 (FR-GIT-105·97).
var RemoteRejectOptions = []string{FixFetchRebase, FixFetchMerge, FixForceWithLease}

var (
	// ErrJobBusy 는 같은 리포에 진행 중인 작업이 있다는 것이다 (FR-GIT-101).
	ErrJobBusy = errors.New("job_busy")
	// ErrJobKind 는 작업 경로를 탈 수 없는 명령이다.
	ErrJobKind = errors.New("job_kind_not_allowed")
)

// jobKinds 는 작업 경로를 탈 수 있는 하위 명령이다. **원격 작업만 이 경로를
// 탄다** — 짧은 명령을 여기 태우면 취소·스트리밍 기계장치가 값어치 없이 붙는다.
var jobKinds = map[string]bool{"fetch": true, "pull": true, "push": true}

// authPatterns 는 인증이 필요해 실패했음을 알리는 stderr 조각이다 (O10).
// GIT_TERMINAL_PROMPT=0 이므로 git 은 매달리지 않고 이 문장과 함께 즉시 끝난다 —
// 그래서 감지가 실패 처리와 같아진다.
//
// "could not read " 는 git 이 사용자명·비밀 어느 쪽을 물으려 했든 내는 앞머리다.
// 물으려던 것을 나눠 적지 않는 이유는 **자격증명의 이름을 코드에 두지 않는
// 것**이 정적 검증(R10)의 전제이기 때문이다.
var authPatterns = []string{
	"could not read ",
	"authentication failed", "permission denied (publickey)",
	"terminal prompts disabled", "no such identity",
	"host key verification failed",
}

// rejectPatterns 는 non-fast-forward 거부다 (FR-GIT-105). "stale info" 는
// --force-with-lease 가 막은 경우다.
var rejectPatterns = []string{"non-fast-forward", "! [rejected]", "fetch first", "stale info"}

// Job 은 진행 중인(또는 끝난) 장기 실행 git 이다.
//
// Argv 는 **자격증명이 지워진** 값이다 (FR-GIT-104). 실제로 실행되는 argv 는
// 밖으로 나가지 않는다.
type Job struct {
	ID       string   `json:"id"`
	Repo     string   `json:"repo"`
	Kind     string   `json:"kind"` // fetch | pull | push | submodule (D-A-27)
	Argv     []string `json:"argv"`
	Started  int64    `json:"startedUnixMs"`
	Done     bool     `json:"done"`
	ExitCode int      `json:"exitCode"`
	Err      string   `json:"err,omitempty"`
	Canceled bool     `json:"canceled"`

	// 아래 넷은 **끝난 뒤에만** 채워진다. 실패를 사용자에게 설명하기 위한 것이며,
	// 즉시 돌려주는 응답에는 담길 값이 없다.
	AuthRequired bool     `json:"authRequired"`         // FR-GIT-104. 안내만 한다 — 자격증명을 받지 않는다
	Rejected     bool     `json:"rejected"`             // FR-GIT-105. non-fast-forward 거부
	Options      []string `json:"options,omitempty"`    // FR-GIT-105. 순서가 곧 우선순위다
	StderrTail   string   `json:"stderrTail,omitempty"` // FR-GIT-108·96
}

// Line 은 작업 출력 한 줄이다. git 은 진행 상황을 stderr 로 낸다 — 그것이 오류가
// 아니라 진행이므로 스트림을 구분해 보낸다.
type Line struct {
	Seq    uint64 `json:"seq"`
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

// JobRunner 는 스트리밍 실행 한 번이다. Runner 를 그대로 쓰지 않는 이유는 출력을
// 모아 돌려주면 진행 상황이 **끝난 뒤에** 도착하기 때문이다 (FR-GIT-103).
//
// emit 은 줄이 생길 때마다 불린다. 돌려주는 값은 exit 코드와 실행 오류다.
type JobRunner func(ctx context.Context, dir string, args []string, emit func(stream, text string)) (int, error)

// Jobs 는 리포별로 **동시에 하나만** 허용한다 (FR-GIT-101).
type Jobs struct {
	svc       *core.Service
	run       JobRunner
	ceiling   time.Duration
	retention time.Duration
	lineCap   int
	now       func() time.Time
	onDone    func(*Job)

	mu     sync.Mutex
	byID   map[string]*jobState
	active map[string]string // repo → 진행 중 작업의 id
}

// jobState 는 작업 하나의 전부다. raw 를 job 과 나눠 두는 이유가 핵심이다 —
// 실행에는 원본 argv 가 필요하고, 밖으로 나가는 것은 지운 값이어야 한다.
type jobState struct {
	job  Job
	raw  []string
	spec core.WriteSpec
	// unguarded 는 인가를 호출자가 진 작업의 사유다 (D-A-27). 비어 있지 않으면
	// 기록이 Unguarded 표식을 든다.
	unguarded string
	cancel    context.CancelFunc
	canceled  bool
	lines     []Line
	stderr    []string
	seq       uint64
	subs      map[*jobSub]struct{}
	doneAt    time.Time
}

type jobSub struct {
	ch   chan Line
	once sync.Once
}

func (s *jobSub) close() { s.once.Do(func() { close(s.ch) }) }

type JobsOption func(*Jobs)

// WithCeiling 은 작업 하나의 상한이다 (O9).
func WithCeiling(d time.Duration) JobsOption { return func(j *Jobs) { j.ceiling = d } }

// WithJobRunner 는 스트리밍 실행기를 주입한다. **WithRunner·WithWriteRunner 는
// 작업 경로를 막아 주지 않는다** — 원격 작업까지 격리해야 하는 테스트는 이것을
// 함께 준다.
func WithJobRunner(r JobRunner) JobsOption { return func(j *Jobs) { j.run = r } }

// WithOnDone 은 작업의 끝이 **공개되기 직전** 불릴 훅이다 — 받은 스냅샷은
// 최종 상태(Done=true)이지만 Get·SSE 는 아직 그것을 보여 주지 않는다. status
// 캐시 무효화(FR-GIT-107)가 이것을 딛는다 — Jobs 는 Store 를 모르고, 알아야 할
// 이유도 없다.
func WithOnDone(f func(*Job)) JobsOption { return func(j *Jobs) { j.onDone = f } }

// WithJobClock 은 테스트가 시간을 지배하게 한다. 보존 기간 검증이 실제 5분 경과에
// 의존하면 결정론을 잃는다.
func WithJobClock(now func() time.Time) JobsOption {
	return func(j *Jobs) {
		if now != nil {
			j.now = now
		}
	}
}

func NewJobs(svc *core.Service, opts ...JobsOption) *Jobs {
	j := &Jobs{
		svc:       svc,
		ceiling:   RemoteOpCeiling,
		retention: JobRetention,
		lineCap:   JobLineCap,
		now:       time.Now,
		byID:      map[string]*jobState{},
		active:    map[string]string{},
	}
	for _, o := range opts {
		o(j)
	}
	if j.ceiling <= 0 {
		j.ceiling = RemoteOpCeiling
	}
	if j.retention <= 0 {
		j.retention = JobRetention
	}
	if j.lineCap <= 0 {
		j.lineCap = JobLineCap
	}
	if j.run == nil {
		j.run = execStreamGit
	}
	return j
}

// Start 는 작업을 띄우고 **즉시** 돌아온다 (FR-GIT-102). 같은 리포에 진행 중인
// 작업이 있으면 ErrJobBusy 다 (FR-GIT-101).
//
// 거부는 기록에 남지 않는다 — 프로세스가 뜨지 않았고 호출자가 오류를 받으므로,
// 실행 기록에 exit -1 을 남기면 Console 에 "실행되지 않은 실행"이 쌓인다.
func (j *Jobs) Start(repo string, kind string, spec core.WriteSpec) (*Job, error) {
	if strings.TrimSpace(repo) == "" || !filepath.IsAbs(repo) {
		return nil, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", core.ErrUnsafeArgument, repo)
	}
	if !jobKinds[kind] {
		return nil, fmt.Errorf("%w: %q 는 원격 작업이 아니다", ErrJobKind, kind)
	}
	// 쓰기 허용 목록을 그대로 거친다 (FR-GIT-95) — 작업 경로가 별도라고 해서
	// 검사가 별도가 되면 안 된다.
	if err := core.GuardWriteArgs(spec.Argv); err != nil {
		return nil, err
	}
	if spec.Argv[0] != kind {
		return nil, fmt.Errorf("%w: kind %q 와 argv %q 가 어긋난다", ErrJobKind, kind, spec.Argv[0])
	}

	return j.launch(repo, kind, spec, "")
}

// StartUnguarded 는 **인가를 호출자가 진** 작업이다 (M8 D-A-27, FBE-08) — `submodule
// update` 가 이 길로 온다. 허용 목록(GuardWriteArgs)을 지나지 않는 대신 사유를
// 요구하며(ExecUnguarded 와 같은 규약), 기록은 Unguarded 표식과 그 사유를 든다.
// 배타·취소·상한·스트리밍·자격증명 지움은 Start 와 같은 기계장치다. 호출자는
// `core` 의 unguardedAllowed 에 든 도메인이어야 한다 — 경로 가드는 그쪽의 것이다.
func (j *Jobs) StartUnguarded(repo, kind string, argv []string, reason string) (*Job, error) {
	if strings.TrimSpace(repo) == "" || !filepath.IsAbs(repo) {
		return nil, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", core.ErrUnsafeArgument, repo)
	}
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("%w: Reason 이 비었다 — 인가를 건너뛰는 사유를 적어야 한다", core.ErrUnsafeArgument)
	}
	if len(argv) == 0 || strings.TrimSpace(kind) == "" {
		return nil, fmt.Errorf("%w: 인자가 없다", core.ErrUnsafeArgument)
	}
	if argv[0] != kind {
		return nil, fmt.Errorf("%w: kind %q 와 argv %q 가 어긋난다", ErrJobKind, kind, argv[0])
	}
	return j.launch(repo, kind, core.WriteSpec{Argv: argv, Destructive: true}, reason)
}

// launch 는 검사를 마친 작업을 띄운다 — Start 와 StartUnguarded 의 공통 몸통.
func (j *Jobs) launch(repo, kind string, spec core.WriteSpec, unguarded string) (*Job, error) {
	j.mu.Lock()
	j.sweepLocked()
	if id, busy := j.active[repo]; busy {
		j.mu.Unlock()
		return nil, fmt.Errorf("%w: %s 에 진행 중인 작업이 있다 (%s)", ErrJobBusy, repo, id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), j.ceiling)
	st := &jobState{
		job: Job{
			ID:       uuid.NewString(),
			Repo:     repo,
			Kind:     kind,
			Argv:     core.SanitizeArgv(spec.Argv),
			Started:  j.now().UnixMilli(),
			ExitCode: -1,
		},
		raw:       append([]string(nil), spec.Argv...),
		spec:      spec,
		unguarded: unguarded,
		cancel:    cancel,
		subs:      map[*jobSub]struct{}{},
	}
	j.byID[st.job.ID] = st
	j.active[repo] = st.job.ID
	snapshot := st.job
	j.mu.Unlock()

	go j.run1(ctx, cancel, st)
	return &snapshot, nil
}

// Cancel 은 프로세스를 끝낸다. **부분 적용 가능성은 호출자가 사용자에게 알린다**
// (FR-GIT-102) — 원격에 절반이 올라간 뒤 끊길 수 있다.
func (j *Jobs) Cancel(id string) bool {
	j.mu.Lock()
	st, ok := j.byID[id]
	if !ok || st.job.Done {
		j.mu.Unlock()
		return false
	}
	st.canceled = true
	cancel := st.cancel
	j.mu.Unlock()
	cancel()
	return true
}

// Get 은 작업의 현재 모습이다. 끝난 작업도 JobRetention 동안 답한다.
func (j *Jobs) Get(id string) (*Job, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.sweepLocked()
	st, ok := j.byID[id]
	if !ok {
		return nil, false
	}
	snapshot := st.job
	return &snapshot, true
}

// Active 는 진행 중인 작업 전부다. 상태바가 읽는다 (FR-GIT-112).
func (j *Jobs) Active() []*Job {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.sweepLocked()
	out := make([]*Job, 0, len(j.active))
	for _, id := range j.active {
		if st, ok := j.byID[id]; ok {
			snapshot := st.job
			out = append(out, &snapshot)
		}
	}
	// 순서를 못박는다 — 맵 순회 순서가 화면 순서가 되면 목록이 매 폴링마다 흔들린다.
	sort.Slice(out, func(a, b int) bool {
		if out[a].Started != out[b].Started {
			return out[a].Started < out[b].Started
		}
		return out[a].ID < out[b].ID
	})
	return out
}

// Subscribe 는 afterSeq 이후의 줄을 받는 채널을 준다. 작업이 끝나면 닫힌다.
//
// 보존된 줄을 **먼저** 흘려보내므로 재연결이 끊긴 구간을 비우지 않는다. 등록과
// 재생을 한 잠금 안에서 하는 이유는 그 사이에 도착한 줄이 새면 안 되기 때문이다.
func (j *Jobs) Subscribe(id string, afterSeq uint64) (<-chan Line, func(), bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	st, ok := j.byID[id]
	if !ok {
		return nil, nil, false
	}
	sub := &jobSub{ch: make(chan Line, j.lineCap)}
	for _, ln := range st.lines {
		if ln.Seq > afterSeq {
			select {
			case sub.ch <- ln:
			default:
			}
		}
	}
	if st.job.Done {
		sub.close()
		return sub.ch, func() {}, true
	}
	st.subs[sub] = struct{}{}
	return sub.ch, func() { j.unsubscribe(id, sub) }, true
}

func (j *Jobs) unsubscribe(id string, sub *jobSub) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if st, ok := j.byID[id]; ok {
		delete(st.subs, sub)
	}
	sub.close()
}
