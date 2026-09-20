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
	"os"
	"path/filepath"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/uuid"
)

// schemaVersion 은 1을 유지한다 (FR-RUN-3) — 프로토타입이 이미 1로 쓰여 있고
// 구조가 아니라 필드만 늘어나므로 판별에 버전이 필요 없다.
const schemaVersion = 1

const fileName = "runs.json"

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
	// persistedBlob 은 **마지막으로 디스크에 실제로 쓰인 바이트**다 (`FBE-17`).
	//
	// 변경은 메모리에 먼저 반영되고 그다음 저장한다. 저장이 실패하면 오류는
	// 돌아가지만 메모리는 바뀐 채로 남아 `runs.json` 과 갈라진다 — 그 뒤의 조회는
	// 디스크에 없는 Run 을 보여 주고, 재기동하면 사라진다.
	//
	// 되돌림을 **저장 한 자리**에 두는 이유: 변경 지점이 열 곳이고, 그 열 곳을
	// 각자 고치면 다음에 생기는 열한 번째가 또 빠진다.
	//
	// PERFORMANCE_HARDENING_SRS FR-PRF-73:
	//
	//	이전: `[]Record` 의 **깊은 복사**를 저장이 성공할 때마다 떴다
	//	새:   방금 쓴 바이트를 그대로 붙든다 — 복사가 0 이다
	//	이유: 성공 경로가 비용을 물고 **실패 경로만 쓰는 것**을 만들고 있었다.
	//	      팀 통신 한 줄마다 저장이 돌므로(`store_messages.go`) 그 비용이
	//	      통신 속도에 그대로 실린다
	//
	// 되돌릴 때 해석한다 — 그쪽은 디스크 쓰기가 실패한 드문 갈래다. 바이트가 곧
	// 파일의 형식이므로 왕복은 `Load()` 가 이미 딛고 있는 계약이다.
	persistedBlob []byte
	// alive 는 도구의 생존을 묻는 길이다 (`FBE-03`). nil 이면 묻지 않는다.
	alive func(toolID string) bool
}

// cloneMember 는 Member 의 참조 필드를 끊는다 (SAFETY_CORRECTNESS_SRS FR-SAF-4).
//
// 임베드 `ContextState` 와 `Worktree` 의 본문은 전부 스칼라이므로, 포인터 대상은
// 값 복제 한 번으로 끝난다.
func cloneMember(in Member) Member {
	out := in
	if in.Worktree != nil {
		wt := *in.Worktree
		out.Worktree = &wt
	}
	if in.FilesModified != nil {
		fs := make([]string, len(in.FilesModified))
		copy(fs, in.FilesModified)
		out.FilesModified = fs
	}
	return out
}

// cloneRun 은 Record 가 **저장소의 내부를 공유하지 않도록** 끊는다
// (SAFETY_CORRECTNESS_SRS FR-SAF-4).
//
// 잠금 밖으로 나가는 참조 필드는 다섯이다 — `Members`·`Worktree`·`Coordinator`
// (Record) 와 `Worktree`·`FilesModified` (Member). 얕게만 복사하면 둘이 깨진다:
// 호출자가 복사본이라 믿고 고친 것이 저장소에 닿고, 호출자가 잠금 **밖**에서
// 읽는 동안 `&s.runs[ri].Members[mi]` 제자리 수정이 겹치면 데이터 레이스다.
//
// `Messages` 는 `store_messages.go` 가 이미 같은 이유로 새 배열로 옮긴다 —
// 그 처방이 나머지 넷에 닿지 않아 이 함수가 생겼다.
//
// **깊이는 여기 한 자리다.** 타입에 참조 필드가 늘면 이 함수만 고친다.
func cloneRun(in Record) Record {
	out := in
	if in.Members != nil {
		ms := make([]Member, len(in.Members))
		for i := range in.Members {
			ms[i] = cloneMember(in.Members[i])
		}
		out.Members = ms
	}
	if in.Worktree != nil {
		wt := *in.Worktree
		out.Worktree = &wt
	}
	if in.Coordinator != nil {
		cs := *in.Coordinator
		out.Coordinator = &cs
	}
	if in.Messages != nil {
		ms := make([]MsgEvent, len(in.Messages))
		copy(ms, in.Messages)
		out.Messages = ms
	}
	return out
}

// cloneRuns 는 되돌릴 수 있는 깊이까지 복사한다.
//
// `Record` 만 얕게 복사하면 **멤버가 같은 배열을 가리킨다** — 코드가
// `&s.runs[ri].Members[mi]` 로 제자리 수정을 하므로, 그 수정이 복사본에도 그대로
// 보여서 되돌릴 것이 남지 않는다.
//
// FR-SAF-4a: 깊이를 `cloneRun` 에 맡긴다. 종전에는 `Members` 만 끊었고, 되돌림에
// 필요한 깊이와 조회에 필요한 깊이가 **다른 두 벌**로 갈라져 있었다.
func cloneRuns(in []Record) []Record {
	if in == nil {
		return nil
	}
	out := make([]Record, len(in))
	for i := range in {
		out[i] = cloneRun(in[i])
	}
	return out
}

// Option customizes a Store for deterministic tests.
type Option func(*Store)

// WithLiveness 는 "그 도구가 지금 살아 있는가" 를 묻는 길이다 (`FBE-03`).
//
// 펜싱의 기준을 `epoch`(웹서버 기동)에서 **실체의 생존**으로 옮긴다. 데몬 모드에서
// PTY 를 가진 것은 데몬이고 데몬은 서버보다 오래 산다 — 서버만 재시작했다고 살아
// 있는 멤버를 죽이면, 그것이 `FR-HLM-3`(헤드리스 복원)이 세운 것을 같은 기동의
// 회수기가 지우는 일이다.
//
// 주지 않으면 **종전대로** 펜싱한다. 모른다고 살려 두면 고아 Run 이 영원히 열린
// 채 남는다 — direct 모드와 옛 배선의 길이다.
func WithLiveness(fn func(toolID string) bool) Option {
	return func(s *Store) { s.alive = fn }
}

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
			dmlog.Errorf(nil, "[run] runs.json 읽기 실패 — 빈 상태로 시작한다: %v", err)
		}
		s.runs = nil
		s.persistedBlob = nil
		return nil
	}
	var body fileBody
	if err := json.Unmarshal(blob, &body); err != nil {
		dmlog.Errorf(nil, "[run] runs.json 파싱 실패 — 빈 상태로 시작한다: %v", err)
		s.runs = nil
		s.persistedBlob = nil
		return nil
	}
	s.runs = body.Runs
	// `FBE-17`: **적재한 것이 곧 디스크의 상태다.** 여기서 세우지 않으면 첫 저장
	// 실패가 빈 목록으로 되돌리고, 그것은 손실을 막으려던 장치가 손실을 만드는
	// 일이다. 아래 `save()` 가 도는 갈래에서는 그쪽이 다시 세운다.
	s.persistedBlob = blob

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
		// `FBE-03`: **실체가 살아 있으면 닫지 않는다.** 기준이 "웹서버가 새로
		// 떴는가" 였기에, 데몬을 보존한 채 서버만 재시작해도 멤버가 죽었다.
		if s.runHasLiveMember(r) {
			// epoch 를 이 기동의 것으로 옮긴다 — 그러지 않으면 다음 기동이
			// 같은 판정을 되풀이한다.
			r.Epoch = s.epoch
			changed = true
			continue
		}
		r.State = Aborted
		r.AbortReason = AbortDaemonRestart
		r.ClosedAt = s.now()
		changed = true
	}
	return changed
}

// runHasLiveMember 는 그 Run 의 멤버 중 **도구가 실제로 살아 있는 것**이 있는지다
// (`FBE-03`).
//
// 하나라도 살아 있으면 그 Run 은 도는 중이다. 전부 죽었으면 되살릴 실체가 없다.
func (s *Store) runHasLiveMember(r *Record) bool {
	if s.alive == nil {
		return false
	}
	for _, m := range r.Members {
		if m.ToolID != "" && s.alive(m.ToolID) {
			return true
		}
	}
	return false
}

// save writes runs.json atomically (FR-RUN-4): a temp file in the same
// directory, then rename. A partial write must never become the live file.
//
// 그 방법은 이제 platform.WriteFileAtomic 하나가 안다 (FR-CAF-11). 여기 있던
// 구현이 옳았기에 그것을 공용으로 올렸고, 옳게 하던 자리를 그대로 두면 구현이
// 둘이 되어 한쪽만 고쳐지는 날이 온다.
func (s *Store) save() error {
	body := fileBody{SchemaVersion: schemaVersion, Runs: s.runs}
	if body.Runs == nil {
		body.Runs = []Record{}
	}
	blob, err := json.Marshal(body)
	if err != nil {
		return err
	}
	if err := platform.WriteStateFile(s.path(), blob, 0644); err != nil {
		// `FBE-17`: **쓰지 못했으면 메모리도 되돌린다.** 그러지 않으면 목록과
		// 디스크가 갈라지고, 사용자는 재기동에서야 그 사실을 만난다.
		s.runs = s.rollbackRuns()
		return err
	}
	s.persistedBlob = blob
	return nil
}

// rollbackRuns 는 마지막으로 쓰인 바이트를 목록으로 되돌린다 (FR-PRF-73).
//
// 해석이 실패하면 **메모리를 그대로 둔다.** 그 바이트는 우리가 방금 쓴 것이므로
// 해석되지 않을 이유가 없고, 그래도 안 되면 지금 메모리가 유일하게 남은 상태다 —
// 버리면 되돌림이 손실을 만든다 (`FBE-17` 이 막으려던 바로 그 모양이다).
func (s *Store) rollbackRuns() []Record {
	if len(s.persistedBlob) == 0 {
		return nil
	}
	var body fileBody
	if err := json.Unmarshal(s.persistedBlob, &body); err != nil {
		dmlog.Errorf(nil, "[run] 되돌림 스냅샷 해석 실패 — 메모리를 그대로 둔다: %v", err)
		return s.runs
	}
	return body.Runs
}
