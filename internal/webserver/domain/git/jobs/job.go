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
	// JobLineCap 은 보존 줄 수 상한이다. 초과분은 앞에서 버린다.
	JobLineCap = 2000
	// JobRetention 은 끝난 작업을 들고 있는 기간이다. 취소·실패의 이유를 사용자가
	// 뒤늦게 볼 수 있어야 한다.
	JobRetention = 5 * time.Minute
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
	Kind     string   `json:"kind"` // §6.1 jobKinds·unguardedKinds 의 키 (REPO_FIX 01)
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

	// REPO_FIX 01 §6.3. Slots 는 시작부터 있다 — 프런트 잠금의 유일한 출처다.
	Slots     []string       `json:"slots,omitempty"`
	ErrorCode string         `json:"errorCode,omitempty"` // server_shutdown | index_locked | git_timeout
	Lock      *core.LockInfo `json:"lock,omitempty"`      // errorCode=index_locked
	Result    *Result        `json:"result,omitempty"`    // 완료 처리가 채운다
}

// 분류된 실패의 이름 (§6.3). apierr 의 코드와 같은 문자열이다.
const (
	ErrorServerShutdown = "server_shutdown"
	ErrorIndexLocked    = "index_locked"
	ErrorTimeout        = "git_timeout"
)

// Finisher 는 잡 하나의 완료 처리다 (§6.3 ④~⑦). Done 공개 **전**에, 기록·lock 판정·
// 공용 훅(무효화) 뒤에 불린다. ctx 는 서버 루트 파생 + 15s 이며 루트가 이미
// 취소됐으면 끝난 ctx 다 — 그때는 재조회를 건너뛰고 반납만 한다.
type Finisher func(ctx context.Context, jb *Job)

// StartOption 은 잡 하나의 선택이다.
type StartOption func(*jobState)

// OnFinish 는 그 잡의 완료 처리를 준다.
func OnFinish(f Finisher) StartOption { return func(st *jobState) { st.finish = f } }

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
//
// stdin 이 비어 있으면 파이프를 만들지 않는다 (§6.2).
type JobRunner func(ctx context.Context, dir string, args []string, stdin string, emit func(stream, text string)) (int, error)

// Jobs 는 칸(index·common)마다 **동시에 하나만** 허용한다 (FR-GIT-101, REPO_FIX 01 §5.4).
type Jobs struct {
	svc       *core.Service
	run       JobRunner
	ceiling   time.Duration
	retention time.Duration
	lineCap   int
	now       func() time.Time
	onDone    func(*Job)
	// root 는 서버 수명이다 (§8). 잡 상한·완료 처리 ctx 가 이것에서 파생하고, 이것이
	// 취소되면 잡은 server_shutdown 으로 끝난다.
	root context.Context

	// excl 은 칸의 주인이다 (REPO_FIX 01 §5.4). 동기 쓰기가 같은 인스턴스로 칸을
	// 보므로 Jobs 가 자기 것을 따로 들면 안 된다 — WithExclusion 으로 받는다.
	excl *Exclusion

	mu   sync.Mutex
	byID map[string]*jobState
}

// jobState 는 작업 하나의 전부다. raw 를 job 과 나눠 두는 이유가 핵심이다 —
// 실행에는 원본 argv 가 필요하고, 밖으로 나가는 것은 지운 값이어야 한다.
type jobState struct {
	job  Job
	keys Keys
	raw  []string
	spec core.WriteSpec
	// unguarded 는 인가를 호출자가 진 작업의 사유다 (D-A-27). 비어 있지 않으면
	// 기록이 Unguarded 표식을 든다.
	unguarded string
	cancel    context.CancelFunc
	finish    Finisher
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

// WithExclusion 은 서버의 배타 상태를 준다 (§5.4). 주지 않으면 자기 것을 만든다 —
// 그때는 동기 쓰기와 칸을 나누지 못하므로 단독 배선(테스트)에서만 뜻이 있다.
func WithExclusion(x *Exclusion) JobsOption { return func(j *Jobs) { j.excl = x } }

// WithRoot 는 서버 수명 ctx 를 준다. 주지 않으면 Background 다.
func WithRoot(ctx context.Context) JobsOption {
	return func(j *Jobs) {
		if ctx != nil {
			j.root = ctx
		}
	}
}

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
		ceiling:   core.JobCeiling,
		retention: JobRetention,
		lineCap:   JobLineCap,
		now:       time.Now,
		root:      context.Background(),
		byID:      map[string]*jobState{},
	}
	for _, o := range opts {
		o(j)
	}
	if j.ceiling <= 0 {
		j.ceiling = core.JobCeiling
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
	if j.excl == nil {
		j.excl = NewExclusion()
	}
	return j
}

// Start 는 작업을 띄우고 **즉시** 돌아온다 (FR-GIT-102). kind 가 차지할 칸
// (SlotsOf) 에 진행 중인 작업이 있으면 ErrJobBusy 다 (FR-GIT-101, REPO_FIX 01 §5.4).
//
// repo 는 실행 cwd·Job.Repo 이고 keys 는 배타 키다 — 둘을 따로 받는다 (§5.1).
//
// 거부는 기록에 남지 않는다 — 프로세스가 뜨지 않았고 호출자가 오류를 받으므로,
// 실행 기록에 exit -1 을 남기면 Console 에 "실행되지 않은 실행"이 쌓인다.
//
//	이전 동작: fetch·pull·push 만 받았다
//	새  동작: §6.1 표의 kind 를 모양 제약과 함께 받는다
//	이유:     느린 쓰기(커밋 훅·checkout·rebase)를 잡으로 옮긴다 (사용자 결정)
func (j *Jobs) Start(repo string, keys Keys, kind string, spec core.WriteSpec, opts ...StartOption) (*Job, error) {
	if strings.TrimSpace(repo) == "" || !filepath.IsAbs(repo) {
		return nil, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", core.ErrUnsafeArgument, repo)
	}
	// 쓰기 허용 목록을 그대로 거친다 (FR-GIT-95) — 작업 경로가 별도라고 해서
	// 검사가 별도가 되면 안 된다.
	if err := core.GuardWriteArgs(spec.Argv); err != nil {
		return nil, err
	}
	if err := checkShape(jobKinds, kind, spec.Argv, spec.Stdin); err != nil {
		return nil, err
	}
	return j.launch(repo, keys, kind, spec, "", opts)
}

// StartUnguarded 는 **인가를 호출자가 진** 작업이다 (M8 D-A-27, FBE-08) — `submodule
// update` 가 이 길로 온다. 허용 목록(GuardWriteArgs)을 지나지 않는 대신 사유를
// 요구하며(ExecUnguarded 와 같은 규약), 기록은 Unguarded 표식과 그 사유를 든다.
// 배타·취소·상한·스트리밍·자격증명 지움은 Start 와 같은 기계장치다. 호출자는
// `core` 의 unguardedAllowed 에 든 도메인이어야 한다 — 경로 가드는 그쪽의 것이다.
func (j *Jobs) StartUnguarded(repo string, keys Keys, kind string, argv []string, reason string, opts ...StartOption) (*Job, error) {
	if strings.TrimSpace(repo) == "" || !filepath.IsAbs(repo) {
		return nil, fmt.Errorf("%w: cwd 는 절대 경로여야 한다: %q", core.ErrUnsafeArgument, repo)
	}
	if strings.TrimSpace(reason) == "" {
		return nil, fmt.Errorf("%w: Reason 이 비었다 — 인가를 건너뛰는 사유를 적어야 한다", core.ErrUnsafeArgument)
	}
	if len(argv) == 0 || strings.TrimSpace(kind) == "" {
		return nil, fmt.Errorf("%w: 인자가 없다", core.ErrUnsafeArgument)
	}
	// 이전: kind 무제한 / 새: submodule·worktree(add) 만 (§6.1).
	if err := checkShape(unguardedKinds, kind, argv, ""); err != nil {
		return nil, err
	}
	return j.launch(repo, keys, kind, core.WriteSpec{Argv: argv, Destructive: true}, reason, opts)
}

// launch 는 검사를 마친 작업을 띄운다 — Start 와 StartUnguarded 의 공통 몸통.
//
//	이전 동작: 저장소(repo 문자열)당 잡 하나 — fetch 중 pull·push 모두 job_busy
//	새  동작: index·common 두 칸. 같은 칸끼리만 job_busy, pull 은 두 칸
//	이유:     index 무관 원격 잡이 commit 등을 막지 않게 하고(§5.4), 같은 common
//	          dir 을 쓰는 worktree 들의 원격 잡끼리는 계속 배타로 둔다
func (j *Jobs) launch(repo string, keys Keys, kind string, spec core.WriteSpec, unguarded string, opts []StartOption) (*Job, error) {
	id := uuid.NewString()
	j.mu.Lock()
	j.sweepLocked()
	if err := j.excl.claim(keys, SlotsOf(kind), id); err != nil {
		j.mu.Unlock()
		return nil, err
	}
	ctx, cancel := context.WithTimeout(j.root, j.ceiling)
	st := &jobState{
		keys: keys,
		job: Job{
			ID:       id,
			Repo:     repo,
			Kind:     kind,
			Argv:     core.SanitizeArgv(spec.Argv),
			Started:  j.now().UnixMilli(),
			ExitCode: -1,
			Slots:    SlotsOf(kind),
		},
		raw:       append([]string(nil), spec.Argv...),
		spec:      spec,
		unguarded: unguarded,
		cancel:    cancel,
		subs:      map[*jobSub]struct{}{},
	}
	for _, o := range opts {
		o(st)
	}
	j.byID[st.job.ID] = st
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
	// byID 를 돈다 — 두 칸을 쥔 pull 이 칸 목록에서는 두 번 보인다 (§6.3).
	out := []*Job{}
	for _, st := range j.byID {
		if !st.job.Done {
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
