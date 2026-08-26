package jobs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
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
	Kind     string   `json:"kind"` // fetch | pull | push
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
	job      Job
	raw      []string
	spec     core.WriteSpec
	cancel   context.CancelFunc
	canceled bool
	lines    []Line
	stderr   []string
	seq      uint64
	subs     map[*jobSub]struct{}
	doneAt   time.Time
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

// WithOnDone 은 작업이 끝난 직후 불릴 훅이다. status 캐시 무효화(FR-GIT-107)가
// 이것을 딛는다 — Jobs 는 Store 를 모르고, 알아야 할 이유도 없다.
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
		raw:    append([]string(nil), spec.Argv...),
		spec:   spec,
		cancel: cancel,
		subs:   map[*jobSub]struct{}{},
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

// run1 은 작업 하나의 수명이다.
func (j *Jobs) run1(ctx context.Context, cancel context.CancelFunc, st *jobState) {
	defer cancel()
	started := j.now()
	exit, err := j.run(ctx, st.job.Repo, st.raw, func(stream, text string) {
		j.appendLine(st, stream, text)
	})
	// 상한 초과는 실행기가 무엇을 돌려주든 **이것이** 사유다 (O9). 실행기의
	// 오류로 남기면 "왜 끝났는가"가 실행기 구현에 따라 달라진다.
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = fmt.Errorf("%w: 상한 %v 를 넘겨 종료했다", core.ErrTimeout, j.ceiling)
	}
	j.finish(st, exit, err, j.now().Sub(started))
}

// appendLine 은 줄 하나를 보존하고 구독자에게 흘려보낸다.
//
// **자격증명은 저장 전에 지운다** (FR-GIT-104) — 보존분·SSE·기록이 같은 값을
// 보게 되고, 한 곳만 늦게 지우는 경로가 생기지 않는다.
func (j *Jobs) appendLine(st *jobState, stream, text string) {
	text = core.SanitizeRemote(text)
	if text == "" {
		return
	}
	if stream != LineStdout {
		stream = LineStderr
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if st.job.Done {
		return
	}
	st.seq++
	ln := Line{Seq: st.seq, Stream: stream, Text: text}
	st.lines = append(st.lines, ln)
	if len(st.lines) > j.lineCap {
		st.lines = append(st.lines[:0], st.lines[len(st.lines)-j.lineCap:]...)
	}
	if stream == LineStderr {
		st.stderr = append(st.stderr, text)
		if len(st.stderr) > core.DefaultStderrTailLines {
			st.stderr = append(st.stderr[:0], st.stderr[len(st.stderr)-core.DefaultStderrTailLines:]...)
		}
	}
	for sub := range st.subs {
		select {
		case sub.ch <- ln:
		default:
			// 느린 구독자 때문에 작업을 멈추지 않는다. 놓친 줄은 보존분에 남으므로
			// after=<seq> 재연결이 되찾는다.
		}
	}
}

// finish 는 작업을 닫는다. 실패의 **사유와 후속 선택지**를 여기서 정한다 —
// 클라이언트가 stderr 를 다시 해석하면 판정이 두 벌이 된다.
func (j *Jobs) finish(st *jobState, exit int, runErr error, dur time.Duration) {
	j.mu.Lock()
	st.job.Done = true
	st.job.ExitCode = exit
	st.job.Canceled = st.canceled
	tail := strings.Join(st.stderr, "\n")
	st.job.StderrTail = tail
	switch {
	case st.canceled:
		st.job.Err = "취소했다. 원격에 일부가 적용됐을 수 있다"
	case runErr != nil:
		st.job.Err = core.SanitizeRemote(runErr.Error())
	case exit != 0:
		// exit 만으로도 실패는 실패다. 사유를 비워 두면 클라이언트가 exitCode 를
		// 직접 해석해야 하고, 그 판정이 두 벌이 된다. 자세한 내용은 StderrTail 이다.
		st.job.Err = fmt.Sprintf("git %s 가 exit %d 로 끝났다", st.job.Kind, exit)
	}
	if !st.canceled {
		st.job.AuthRequired = matchesAny(tail, authPatterns)
		st.job.Rejected = matchesAny(tail, rejectPatterns)
		if st.job.Rejected {
			st.job.Options = append([]string(nil), RemoteRejectOptions...)
		}
	}
	st.doneAt = j.now()
	if j.active[st.job.Repo] == st.job.ID {
		delete(j.active, st.job.Repo)
	}
	for sub := range st.subs {
		delete(st.subs, sub)
		sub.close()
	}
	snapshot := st.job
	j.mu.Unlock()

	// 기록은 **지운 argv** 로 남는다 (FR-GIT-104). 파괴적 선언은 호출자가 준
	// spec 을 그대로 옮긴다 (I5).
	var recErr error
	if snapshot.Err != "" {
		recErr = errors.New(snapshot.Err)
	}
	j.svc.RecordWrite(snapshot.Repo,
		core.WriteSpec{Argv: snapshot.Argv, Destructive: st.spec.Destructive, Stdin: st.spec.Stdin},
		core.Output{Stderr: tail, ExitCode: exit, DurationMs: dur.Milliseconds()}, recErr)
	if j.onDone != nil {
		j.onDone(&snapshot)
	}
}

// sweepLocked 는 보존 기간이 지난 작업을 버린다. 진행 중인 것은 건드리지 않는다.
func (j *Jobs) sweepLocked() {
	now := j.now()
	for id, st := range j.byID {
		if st.job.Done && !now.Before(st.doneAt.Add(j.retention)) {
			delete(j.byID, id)
		}
	}
}

func matchesAny(s string, pats []string) bool {
	low := strings.ToLower(s)
	for _, p := range pats {
		if strings.Contains(low, p) {
			return true
		}
	}
	return false
}

// execStreamGit 은 작업 경로의 기본 실행이다.
func execStreamGit(ctx context.Context, dir string, args []string, emit func(stream, text string)) (int, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		return -1, fmt.Errorf("%w: %v", core.ErrGitMissing, err)
	}
	return execStream(ctx, dir, bin, args, emit)
}

// execStream 은 프로세스를 **자기 프로세스 그룹**에 띄우고 줄 단위로 읽는다.
//
// 그룹으로 띄우는 이유는 취소다 (FR-GIT-102): git 이 띄운 ssh·git-remote-https 가
// 남으면 취소가 취소가 아니다. 취소는 그룹 전체에 SIGTERM 이고, 유예를 넘기면
// SIGKILL 로 올린다.
//
// StdoutPipe 대신 os.Pipe 를 쓰는 이유는 Wait 의 의미다 — StdoutPipe 는 파이프가
// 닫히기를 기다리므로, 파이프를 잡은 자식이 남으면 Wait 가 돌아오지 않는다.
//
// bin 을 인자로 받는 이유는 이 경로 자체를 git 없이 검증할 수 있어야 하기
// 때문이다. 실제 호출자는 execStreamGit 뿐이다.
func execStream(ctx context.Context, dir, bin string, args []string, emit func(stream, text string)) (int, error) {
	outR, outW, err := os.Pipe()
	if err != nil {
		return -1, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return -1, err
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Stdout = outW
	cmd.Stderr = errW
	cmd.Env = core.Env()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return signalGroup(cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = JobKillGrace

	if serr := cmd.Start(); serr != nil {
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return -1, fmt.Errorf("%s %s: %w", filepath.Base(bin), strings.Join(args, " "), serr)
	}
	// 부모 쪽 쓰기단을 닫는다 — 닫지 않으면 자식이 끝나도 읽기가 EOF 를 못 본다.
	outW.Close()
	errW.Close()
	pgid := cmd.Process.Pid

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); defer outR.Close(); readLines(outR, func(t string) { emit(LineStdout, t) }) }()
	go func() { defer wg.Done(); defer errR.Close(); readLines(errR, func(t string) { emit(LineStderr, t) }) }()
	read := make(chan struct{})
	go func() { wg.Wait(); close(read) }()

	waitErr := cmd.Wait()
	// 리더가 끝났어도 그룹에 남은 자식이 파이프를 잡고 있을 수 있다. 유예까지
	// 기다린 뒤 그룹을 쓸어낸다 — 작업이 영원히 끝나지 않는 것보다 낫다.
	if !waitFor(read, JobKillGrace) {
		signalGroup(pgid, syscall.SIGKILL)
		waitFor(read, JobKillGrace)
	}

	exit := -1
	if cmd.ProcessState != nil {
		exit = cmd.ProcessState.ExitCode()
	}
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return exit, fmt.Errorf("%w: git %s 가 상한을 넘겨 종료됐다", core.ErrTimeout, strings.Join(args, " "))
	case ctx.Err() != nil:
		// 취소다. 사유는 호출자가 안다 — 여기서 오류로 올리면 취소가 실패로 보인다.
		return exit, nil
	case waitErr != nil && exit <= 0:
		return exit, fmt.Errorf("%s %s: %w", filepath.Base(bin), strings.Join(args, " "), waitErr)
	}
	return exit, nil
}

// signalGroup 은 프로세스 그룹 전체에 신호를 보낸다. Setpgid 로 띄웠으므로 pgid 는
// 리더의 pid 와 같다. 남은 구성원이 없으면 ESRCH 이며 그것은 성공과 같다.
func signalGroup(pid int, sig syscall.Signal) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(-pid, sig)
}

func waitFor(done <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		return false
	}
}

// readLines 는 r 을 줄 단위로 읽어 emit 한다. **`\r` 과 `\n` 모두가 줄 끝이다** —
// git 의 진행 표시는 `\r` 로 같은 줄을 덮으므로, `\n` 만 보는 분할은 진행을
// 통째로 놓친다 (FR-GIT-103).
//
// 빈 줄은 내보내지 않는다. CRLF 가 두 줄로 세지는 것을 막고, 진행 표시에 빈 줄이
// 끼어들지 않게 한다.
//
// 상한을 넘긴 줄은 상한에서 끊어 내보낸다 — 구분자 없는 스트림 하나가 메모리를
// 삼키거나 읽기를 멈추게 하지 않는다.
func readLines(r io.Reader, emit func(string)) {
	br := bufio.NewReaderSize(r, JobLineMax)
	buf := make([]byte, 0, JobLineMax)
	flush := func() {
		if len(buf) > 0 {
			emit(string(buf))
			buf = buf[:0]
		}
	}
	for {
		b, err := br.ReadByte()
		if err != nil {
			flush()
			return
		}
		if b == '\n' || b == '\r' {
			flush()
			continue
		}
		buf = append(buf, b)
		if len(buf) >= JobLineMax {
			flush()
		}
	}
}
