// Run 레코드의 저장소다 (RUN_ORCHESTRATION_SRS 묶음 R).
//
// 지금까지 실행 상태의 유일한 저장소는 조정자 에이전트의 대화 기록이었다 — 팀원
// uuid 매핑표가 컨텍스트 압축을 넘지 못하면 팀을 정리할 주체가 사라졌다. 여기서
// 그 기록을 파일로 내린다.
//
// 이 패키지는 서버를 모른다. 공간 계층 조작(탭 닫기)·활동 상태 파생은 호출자의
// 몫이고, 여기 있는 것은 "무엇이 누구의 것인가"와 그 상태 전이뿐이다.
package run

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/agentadapter"
	"dongminal/internal/uuid"
)

// schemaVersion 은 1을 유지한다 (FR-RUN-3) — 프로토타입이 이미 1로 쓰여 있고
// 구조가 아니라 필드만 늘어나므로 판별에 버전이 필요 없다.
const schemaVersion = 1

const fileName = "runs.json"

// State 는 Run 의 생명주기다.
type State string

const (
	Open    State = "open"
	Closed  State = "closed"
	Aborted State = "aborted"
)

// AbortDaemonRestart 는 epoch 펜싱이 남기는 사유다 (FR-RUN-5).
const AbortDaemonRestart = "daemon-restart"

// Isolation 은 멤버가 파일시스템을 나누는 방식이다 (FR-WKT-1). 기본은 none 이며,
// 격리의 실제 수행은 묶음 W 의 몫이다 — 여기서는 기록만 한다.
type Isolation string

const (
	IsolationNone      Isolation = "none"
	IsolationPerRun    Isolation = "per-run"
	IsolationPerMember Isolation = "per-member"
)

func (i Isolation) Valid() bool {
	switch i {
	case IsolationNone, IsolationPerRun, IsolationPerMember:
		return true
	}
	return false
}

// MemberState 는 멤버의 상태다. done/failed/released 는 영속되고, 나머지는
// 호출자가 관측(도구 생존 + 활동 상태)에서 파생한다 (FR-RUN-6).
type MemberState string

const (
	Starting MemberState = "starting"
	Ready    MemberState = "ready"
	Working  MemberState = "working"
	Waiting  MemberState = "waiting"
	Done     MemberState = "done"
	Failed   MemberState = "failed"
	Lost     MemberState = "lost"
	Released MemberState = "released"
)

// Outcome 은 보고의 결말이다. 실패를 산문에만 담지 않게 하는 장치다 (FR-PRE-3).
type Outcome string

const (
	OutcomeSucceeded Outcome = "succeeded"
	OutcomeFailed    Outcome = "failed"
)

// Worktree 는 격리된 멤버의 작업 트리다 (묶음 W).
//
// Removed·Residue 는 정리 **결과**다. 기록에 남기는 이유는 FR-WKT-12 다 — 지우지
// 못한 자원은 조용히 남지 않고, close 를 지켜보지 못한 다음 세션도 run status 로
// 그 사실을 읽을 수 있어야 한다.
type Worktree struct {
	Path    string `json:"path"`
	Branch  string `json:"branch"`
	Base    string `json:"base,omitempty"`
	Removed bool   `json:"removed,omitempty"`
	Residue string `json:"residue,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

// Member 는 Run 에 속한 참여자 하나이며 Tool 과 1:1 이다 (FR-RUN-2).
type Member struct {
	ID            string      `json:"id"`
	RunID         string      `json:"runId,omitempty"`
	Role          string      `json:"role"`
	Agent         string      `json:"agent"`
	Brief         string      `json:"brief,omitempty"`
	ToolID        string      `json:"toolId"`
	TabID         string      `json:"tabId,omitempty"`
	Worktree      *Worktree   `json:"worktree,omitempty"`
	State         MemberState `json:"state"`
	Outcome       Outcome     `json:"outcome,omitempty"`
	Summary       string      `json:"summary,omitempty"`
	FilesModified []string    `json:"filesModified,omitempty"`
	ReportedAt    int64       `json:"reportedAt,omitempty"`
	CreatedAt     int64       `json:"createdAt"`
}

// Reported reports whether the member has sent its one terminal report.
func (m Member) Reported() bool { return m.ReportedAt != 0 }

// Record 는 Run 하나다 (FR-RUN-1). 필드 이름은 기존 runs.json 프로토타입을 보존한다.
type Record struct {
	ID                string     `json:"id"`
	Short             string     `json:"short"`
	Objective         string     `json:"objective"`
	Projection        Projection `json:"projection"`
	Isolation         Isolation  `json:"isolation"`
	State             State      `json:"state"`
	Epoch             string     `json:"epoch,omitempty"`
	CoordinatorToolID string     `json:"coordinatorToolId,omitempty"`
	WindowID          string     `json:"windowId,omitempty"`
	Members           []Member   `json:"members,omitempty"`
	// Repo·Base·Worktree 는 격리 Run 에서만 채워진다 (FR-WKT-5). Repo 는 Run 을
	// 연 시점 조정자 cwd 의 저장소 루트이고, Base 는 그때의 HEAD 다 — 나중에
	// "이 브랜치가 무엇에서 갈라졌나"를 물을 근거이며 정리의 대상 저장소다.
	Repo        string    `json:"repo,omitempty"`
	Base        string    `json:"base,omitempty"`
	Worktree    *Worktree `json:"worktree,omitempty"` // per-run 의 공유 트리
	CreatedAt   int64     `json:"createdAt"`
	ClosedAt    int64     `json:"closedAt,omitempty"`
	AbortReason string    `json:"abortReason,omitempty"`
}

type fileBody struct {
	SchemaVersion int      `json:"schemaVersion"`
	Runs          []Record `json:"runs"`
}

// 거부 사유는 타입으로 열거한다 (FR-PRE-6) — 조용한 성공도, 뭉뚱그린 오류도 아니다.
var (
	ErrUnknownRun = errors.New("unknown_run")
	ErrRunClosed  = errors.New("run_closed")
	// ErrRunOpen 은 정리 재진입(Sweep)을 아직 열려 있는 Run 에 쓴 경우다.
	ErrRunOpen           = errors.New("run_open")
	ErrSenderNotMember   = errors.New("sender_not_member")
	ErrUnknownMember     = errors.New("unknown_member")
	ErrRunMemberMismatch = errors.New("run_member_mismatch")
	ErrAlreadyReported   = errors.New("member_already_reported")
	ErrToolAlreadyMember = errors.New("tool_already_member")
	ErrUnreportedMembers = errors.New("unreported_members")
	ErrInvalidArgument   = errors.New("invalid_argument")
)

// Store 는 runs.json 을 소유한다. 모든 변경은 즉시 영속된다.
type Store struct {
	mu    sync.Mutex
	dir   string
	epoch string
	now   func() int64
	newID func() string
	runs  []Record // 최근 것이 앞 (FR-RUN-8)
}

// Option customizes a Store for deterministic tests.
type Option func(*Store)

func WithClock(now func() int64) Option  { return func(s *Store) { s.now = now } }
func WithIDGen(gen func() string) Option { return func(s *Store) { s.newID = gen } }

// NewStore returns a store over dir. epoch identifies this server incarnation
// and fences Runs left open by a previous one (FR-RUN-5).
func NewStore(dir, epoch string, opts ...Option) *Store {
	s := &Store{
		dir:   dir,
		epoch: epoch,
		now:   func() int64 { return time.Now().Unix() },
		newID: uuid.NewString,
	}
	for _, o := range opts {
		o(s)
	}
	return s
}

func (s *Store) path() string { return filepath.Join(s.dir, fileName) }

// Load reads runs.json and fences Runs from previous epochs. A missing file is
// the normal state; an unreadable or corrupt one degrades to an empty list with
// a warning — the orchestrator is optional and must never block boot
// (FR-RUN-4 / NFR-RUN-1/2).
func (s *Store) Load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	blob, err := os.ReadFile(s.path())
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("[run] runs.json 읽기 실패 — 빈 상태로 시작한다: %v", err)
		}
		s.runs = nil
		return nil
	}
	var body fileBody
	if err := json.Unmarshal(blob, &body); err != nil {
		log.Printf("[run] runs.json 파싱 실패 — 빈 상태로 시작한다: %v", err)
		s.runs = nil
		return nil
	}
	s.runs = body.Runs

	if s.fenceStale() {
		return s.save()
	}
	return nil
}

// fenceStale marks every Run left open by a previous incarnation as aborted.
// Closed and aborted Runs keep their original ending — a restart must not
// overwrite why a Run ended.
func (s *Store) fenceStale() bool {
	changed := false
	for i := range s.runs {
		r := &s.runs[i]
		if r.State != Open || r.Epoch == s.epoch {
			continue
		}
		r.State = Aborted
		r.AbortReason = AbortDaemonRestart
		r.ClosedAt = s.now()
		changed = true
	}
	return changed
}

// save writes runs.json atomically (FR-RUN-4): a temp file in the same
// directory, then rename. A partial write must never become the live file.
func (s *Store) save() error {
	body := fileBody{SchemaVersion: schemaVersion, Runs: s.runs}
	if body.Runs == nil {
		body.Runs = []Record{}
	}
	blob, err := json.MarshalIndent(body, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, ".runs-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // rename 이 성공하면 사라진 이름이라 무해하다
	if _, err := tmp.Write(blob); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0644); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path())
}

// StartOptions is the input of Start.
type StartOptions struct {
	// ID 를 호출자가 미리 정할 수 있다. 격리 Run 이 그렇게 한다 — worktree 경로가
	// run.short 에서 파생되므로(FR-WKT-3) 레코드가 생기기 **전에** id 가 필요하고,
	// 생성이 실패하면 레코드가 아예 없어야 고아 Run 이 남지 않는다. 비우면 저장소가
	// 발급한다.
	ID                string
	Objective         string
	Projection        Projection
	Isolation         Isolation
	CoordinatorToolID string
	WindowID          string
	Repo              string
	Base              string
	Worktree          *Worktree
}

// Start opens a Run.
func (s *Store) Start(opt StartOptions) (Record, error) {
	if strings.TrimSpace(opt.Objective) == "" {
		return Record{}, fmt.Errorf("%w: objective 는 비어 있을 수 없다", ErrInvalidArgument)
	}
	if !opt.Projection.Valid() {
		return Record{}, fmt.Errorf("%w: 알 수 없는 projection: %q", ErrInvalidArgument, opt.Projection)
	}
	if !opt.Isolation.Valid() {
		return Record{}, fmt.Errorf("%w: 알 수 없는 isolation: %q", ErrInvalidArgument, opt.Isolation)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	id := strings.TrimSpace(opt.ID)
	if id == "" {
		id = s.newID()
	}
	rec := Record{
		ID:                id,
		Short:             Short(id),
		Objective:         strings.TrimSpace(opt.Objective),
		Projection:        opt.Projection,
		Isolation:         opt.Isolation,
		State:             Open,
		Epoch:             s.epoch,
		CoordinatorToolID: opt.CoordinatorToolID,
		WindowID:          opt.WindowID,
		Repo:              opt.Repo,
		Base:              opt.Base,
		Worktree:          opt.Worktree,
		CreatedAt:         s.now(),
	}
	s.runs = append([]Record{rec}, s.runs...)
	if err := s.save(); err != nil {
		return Record{}, err
	}
	return rec, nil
}

// MemberSpec is the input of AddMember.
type MemberSpec struct {
	// ID 는 StartOptions.ID 와 같은 이유로 미리 정할 수 있다 — worktree 경로가
	// member.short 에서 파생된다 (FR-WKT-3).
	ID    string
	Role  string
	Agent string
	// Brief 는 이 멤버가 할 일의 본문이다. 프리앰블에 그대로 실리며, 기록에
	// 남기는 이유는 조정자가 컨텍스트를 잃어도 프리앰블을 다시 만들 수 있어야
	// 하기 때문이다 (FR-PRE-1).
	Brief    string
	ToolID   string
	TabID    string
	Worktree *Worktree
}

// AddMember binds a tool to a Run. The binding is 1:1 — a tool that already
// belongs to an open Run cannot be claimed by another (FR-RUN-2).
func (s *Store) AddMember(runID string, spec MemberSpec) (Member, error) {
	if strings.TrimSpace(spec.Role) == "" || strings.TrimSpace(spec.Agent) == "" || strings.TrimSpace(spec.ToolID) == "" {
		return Member{}, fmt.Errorf("%w: role·agent·toolId 는 모두 필요하다", ErrInvalidArgument)
	}
	// FR-ADP-3: 알 수 없는 에이전트 id 를 기록에 들이지 않는다. 들어오면 훅도
	// 프리앰블도 기동줄도 만들 수 없는 멤버가 남고, 그 사실이 한참 뒤에야 드러난다.
	if _, err := agentadapter.Get(strings.TrimSpace(spec.Agent)); err != nil {
		return Member{}, fmt.Errorf("%w: %v", ErrInvalidArgument, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Member{}, ErrUnknownRun
	}
	if s.runs[idx].State != Open {
		return Member{}, ErrRunClosed
	}
	if _, _, ok := s.findByTool(spec.ToolID); ok {
		return Member{}, ErrToolAlreadyMember
	}
	memberID := strings.TrimSpace(spec.ID)
	if memberID == "" {
		memberID = s.newID()
	}
	m := Member{
		ID:        memberID,
		RunID:     runID,
		Role:      strings.TrimSpace(spec.Role),
		Agent:     strings.TrimSpace(spec.Agent),
		Brief:     strings.TrimSpace(spec.Brief),
		ToolID:    spec.ToolID,
		TabID:     spec.TabID,
		Worktree:  spec.Worktree,
		State:     Starting,
		CreatedAt: s.now(),
	}
	s.runs[idx].Members = append(s.runs[idx].Members, m)
	if err := s.save(); err != nil {
		return Member{}, err
	}
	return m, nil
}

// ReportSpec is the input of Report. RunID/MemberID are corroboration only —
// the sender's identity decides which member is reporting (FR-PRE-5).
type ReportSpec struct {
	RunID         string
	MemberID      string
	Outcome       Outcome
	Summary       string
	FilesModified []string
}

// Report records a member's one terminal report.
func (s *Store) Report(senderToolID string, spec ReportSpec) (Member, error) {
	switch spec.Outcome {
	case OutcomeSucceeded, OutcomeFailed:
	default:
		return Member{}, fmt.Errorf("%w: outcome 은 succeeded 또는 failed 여야 한다: %q", ErrInvalidArgument, spec.Outcome)
	}
	if strings.TrimSpace(spec.Summary) == "" {
		return Member{}, fmt.Errorf("%w: summary 는 비어 있을 수 없다 — 조정자가 먼저 읽는 것이다", ErrInvalidArgument)
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	ri, mi, ok := s.findByTool(senderToolID)
	if !ok {
		// 닫힌 Run 의 멤버였다면 "멤버가 아니다"는 오진이다 — 늦은 보고와
		// 남의 보고는 다른 문제이고, 조정자가 다르게 대응해야 한다.
		if s.wasMemberOfClosedRun(senderToolID) {
			return Member{}, ErrRunClosed
		}
		return Member{}, ErrSenderNotMember
	}
	rec := &s.runs[ri]
	m := &rec.Members[mi]
	// 페이로드를 아는 것은 권한이 아니다 — 실려 온 id 는 발신자와 일치해야 한다.
	if (spec.RunID != "" && spec.RunID != rec.ID) || (spec.MemberID != "" && spec.MemberID != m.ID) {
		return Member{}, ErrRunMemberMismatch
	}
	if m.Reported() {
		return Member{}, ErrAlreadyReported
	}
	m.Outcome = spec.Outcome
	m.Summary = strings.TrimSpace(spec.Summary)
	m.FilesModified = spec.FilesModified
	m.ReportedAt = s.now()
	if spec.Outcome == OutcomeSucceeded {
		m.State = Done
	} else {
		m.State = Failed
	}
	out := *m
	if err := s.save(); err != nil {
		return Member{}, err
	}
	return out, nil
}

// Close ends a Run. Without force it refuses while any member has not reported
// and returns that list (FR-RUN-11) — a worker that never reported is not
// proof of completion, and closing would drop the only record of it.
func (s *Store) Close(runID string, force bool) (Record, []Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Record{}, nil, ErrUnknownRun
	}
	rec := &s.runs[idx]
	if rec.State != Open {
		return Record{}, nil, ErrRunClosed
	}
	var pending []Member
	for _, m := range rec.Members {
		if !m.Reported() && m.State != Released {
			pending = append(pending, m)
		}
	}
	if len(pending) > 0 && !force {
		return Record{}, pending, ErrUnreportedMembers
	}
	rec.State = Closed
	rec.ClosedAt = s.now()
	out := *rec
	if err := s.save(); err != nil {
		return Record{}, nil, err
	}
	return out, pending, nil
}

// Sweep 는 이미 끝난 Run(closed·aborted)의 **정리 재진입**이다 (FR-WKT-8a).
//
// 상태를 바꾸지 않는다. 끝난 사실은 기록이고 정리가 그것을 고쳐 쓰지 않는다 —
// aborted 가 closed 로 둔갑하면 왜 끝났는지 아는 유일한 근거가 사라진다. 미보고
// 멤버 검사도 하지 않는다(FR-RUN-11): 기다릴 보고가 남아 있지 않다.
func (s *Store) Sweep(runID string) (Record, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return Record{}, ErrUnknownRun
	}
	if s.runs[idx].State == Open {
		return Record{}, ErrRunOpen
	}
	return s.runs[idx], nil
}

// WorktreeMark 는 정리 한 건의 결과다. Path 로 대상을 지목한다.
type WorktreeMark struct {
	Path    string
	Removed bool
	Residue string
	Detail  string
}

// MarkWorktrees 는 정리 결과를 기록에 반영한다 (FR-WKT-12).
//
// Path 로 지목하는 이유는 per-run 의 공유 트리가 레코드와 멤버 양쪽에 걸려 있기
// 때문이다 — 같은 경로를 가리키는 모든 자리에 같은 결과가 적혀야 조회가 엇갈리지
// 않는다.
func (s *Store) MarkWorktrees(runID string, marks []WorktreeMark) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return ErrUnknownRun
	}
	rec := &s.runs[idx]
	for _, mk := range marks {
		if mk.Path == "" {
			continue
		}
		apply := func(w *Worktree) {
			if w == nil || w.Path != mk.Path {
				return
			}
			w.Removed, w.Residue, w.Detail = mk.Removed, mk.Residue, mk.Detail
		}
		apply(rec.Worktree)
		for mi := range rec.Members {
			apply(rec.Members[mi].Worktree)
		}
	}
	return s.save()
}

// WorktreeTargets 는 이 Run 이 **만든** worktree 만 돌려준다 (FR-WKT-9).
//
// 정리의 유일한 근거다. 파일시스템을 훑어 "worktree 처럼 보이는 것"을 지우지
// 않는다 — 사용자가 만든 트리가 그 안에 있어도 알 방법이 없기 때문이다.
func (r Record) WorktreeTargets() []Worktree {
	seen := map[string]bool{}
	var out []Worktree
	add := func(w *Worktree) {
		// 이미 제거된 트리는 대상이 아니다 — 정리 재진입(FR-WKT-8a)이 사라진
		// 경로를 다시 지우려 들면 없던 잔여물을 만들어 낸다.
		if w == nil || w.Path == "" || w.Removed || seen[w.Path] {
			return
		}
		seen[w.Path] = true
		out = append(out, *w)
	}
	add(r.Worktree)
	for _, m := range r.Members {
		add(m.Worktree)
	}
	return out
}

// Get returns a Run by id.
func (s *Store) Get(runID string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.indexOf(runID); i >= 0 {
		return s.runs[i], true
	}
	return Record{}, false
}

// List returns every Run, newest first.
func (s *Store) List() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, len(s.runs))
	copy(out, s.runs)
	return out
}

// MemberByTool resolves a tool to its member in an open Run. This is the
// authority check behind Report (FR-PRE-5).
func (s *Store) MemberByTool(toolID string) (Member, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ri, mi, ok := s.findByTool(toolID)
	if !ok {
		return Member{}, false
	}
	return s.runs[ri].Members[mi], true
}

// FindMember resolves a member id to its Run and member row, across every Run
// regardless of state. This is what makes a preamble re-derivable: a
// coordinator that lost its context can still recover what a member was told
// (FR-PRE-1), and a closed Run stays inspectable.
func (s *Store) FindMember(memberID string) (Record, Member, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if memberID == "" {
		return Record{}, Member{}, false
	}
	for ri := range s.runs {
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ID == memberID {
				return s.runs[ri], s.runs[ri].Members[mi], true
			}
		}
	}
	return Record{}, Member{}, false
}

// findByTool locates a tool's member among OPEN runs only. Callers hold s.mu.
// Closed Runs keep their member rows for the record, but those tools are no
// longer claimed — the tool may be reused by a later Run.
func (s *Store) findByTool(toolID string) (runIdx, memberIdx int, ok bool) {
	if toolID == "" {
		return 0, 0, false
	}
	for ri := range s.runs {
		if s.runs[ri].State != Open {
			continue
		}
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ToolID == toolID {
				return ri, mi, true
			}
		}
	}
	return 0, 0, false
}

// wasMemberOfClosedRun reports whether the tool belonged to a Run that has
// since ended. Callers hold s.mu.
func (s *Store) wasMemberOfClosedRun(toolID string) bool {
	if toolID == "" {
		return false
	}
	for ri := range s.runs {
		if s.runs[ri].State == Open {
			continue
		}
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ToolID == toolID {
				return true
			}
		}
	}
	return false
}

// indexOf finds a Run by id. Callers hold s.mu.
func (s *Store) indexOf(runID string) int {
	for i := range s.runs {
		if s.runs[i].ID == runID {
			return i
		}
	}
	return -1
}

// Short is the log/path-friendly alias — the first 8 chars of the uuid, the
// same rule workspace labels already use. worktree 경로·브랜치가 이 값에서
// 파생되므로(FR-WKT-3) 호출자도 같은 규칙을 쓸 수 있어야 한다.
func Short(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// PathSlug 는 uuid 에서 **충돌하지 않는** 경로·브랜치 조각을 만든다 (FR-WKT-3/4).
//
// short 만으로는 부족하다 — uuid v7 의 앞 48비트는 밀리초 타임스탬프이고, 그
// 상위 32비트(=앞 8자)는 49일에 한 번 바뀐다. 즉 **같은 기간에 열린 Run·Member 는
// 전부 같은 short 를 갖는다.** 실측으로 확인했다: 연속으로 만든 Run 두 개가
// 01a0370c 로 같았고, short 로 만든 경로가 그대로 겹쳤다. 뒤 8자는 난수 구간이라
// 여기에 붙여 유일성을 회복한다. 경로 재사용은 남의 대화 이력을 물려주는 것이므로
// (FR-WKT-4) 이 유일성은 편의가 아니라 요구사항이다.
func PathSlug(id string) string {
	clean := strings.ReplaceAll(id, "-", "")
	if len(clean) < 16 {
		return Short(id)
	}
	return Short(id) + "-" + clean[len(clean)-8:]
}
