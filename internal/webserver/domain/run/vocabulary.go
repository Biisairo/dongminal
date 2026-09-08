// Run 의 **어휘**다 (RUN_ORCHESTRATION_SRS 묶음 R).
//
// `store.go` 에서 갈라 나왔다 (DRIFT_RECLAIM_SRS FR-DRC-13). 이 패키지는 이미
// 주제별로 갈려 있고(`store_context.go` · `store_headless.go` ·
// `store_messages.go`), 남아 있던 마지막 덩어리가 이것이었다 — **무엇이 있는가**
// (여기)와 **그것을 어떻게 다루는가**(`store.go`)는 다른 질문이다.
//
// 여기 있는 것은 전부 파일에 그대로 쓰이는 모양이다. 그래서 필드 하나를 고치면
// 디스크의 `runs.json` 이 함께 바뀐다 — `schemaVersion` 의 근거가 그 사실이다.
package run

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
	// Succeeded 는 일을 **마친** 것이 아니라 **넘긴** 것이다 (FR-CBG-10).
	// done 도 failed 도 아니며, 그 일은 승계자가 마친다. 따라서 Close 의 미보고
	// 검사에서 보고한 것으로 친다 — 아래 settled 를 보라.
	Succeeded MemberState = "succeeded"
)

// settled 는 Close 의 미보고 검사에서 "더 기다릴 것이 없다" 로 치는 상태다.
//
// Released 는 조정자가 명시적으로 놓아준 멤버이고, Succeeded 는 후임에게 일을
// 넘긴 멤버다 (FR-CBG-10). 둘 다 보고를 기다리는 것이 무의미하다.
func (m Member) settled() bool {
	return m.Reported() || m.State == Released || m.State == Succeeded
}

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

/**
 * ContextState 는 한 에이전트의 컨텍스트 관측이다.
 *
 * ALERT_MOBILE_CONTEXT_SRS FR-RCX-8: **멤버와 조정자가 같은 어휘를 쓴다.** 값이
 * 같은 뜻인데 이름이 다르면 화면이 둘을 다르게 그리게 되고, 등급 판정도 두 벌이
 * 된다. 멤버에는 임베드되므로 JSON 모양은 종전 그대로다.
 *
 * ContextLevel 은 추정이 불가능할 때 **빈 값**으로 남는다 (FR-CBG-5) —
 * "모른다" 와 "괜찮다" 는 다르므로 ok 로도 "unknown" 문자열로도 채우지 않는다.
 * omitempty 가 그 의미를 그대로 실어 나른다.
 */
type ContextState struct {
	ContextBytes int64   `json:"contextBytes,omitempty"` // transcript 크기 (stat 1회)
	ContextRatio float64 `json:"contextRatio,omitempty"` // 0.0~1.0+ 사용률
	// UX_BATCH6_SRS FR-CTX-1: **실측 토큰**이다. transcript 의 마지막 assistant
	// 줄이 적은 usage 합이며, 그것이 그 요청이 실제로 모델에 보낸 컨텍스트다.
	// 없으면 종전대로 `ContextBytes` 로 추정한다 (FR-CTX-4).
	ContextTokens int64 `json:"contextTokens,omitempty"`
	// FR-CTX-5·7: 컨텍스트 창 크기. 모델이 말했거나(`[1m]`) 관측이 넓힌 값이며,
	// 한 번 넓혀지면 좁아지지 않는다 — 압축으로 사용량이 내려가도 창은 그대로다.
	ContextLimit float64 `json:"contextLimit,omitempty"`
	ContextLevel string  `json:"contextLevel,omitempty"` // "" | ok | warn | critical
	ContextAt    int64   `json:"contextAt,omitempty"`    // 마지막 관측 시각
	CompactCount int     `json:"compactCount,omitempty"` // PreCompact 도달 횟수
	SessionID    string  `json:"sessionId,omitempty"`    // 에이전트 세션 결속
}

// Member 는 Run 에 속한 참여자 하나이며 Tool 과 1:1 이다 (FR-RUN-2).
//
// ORCHESTRATION_V2 의 세 묶음이 더한 필드는 전부 omitempty 이며, 기존 runs.json 은
// 그대로 읽힌다 (마이그레이션 없음). Step 0 에서 자리만 만들었고 아직 아무도 쓰지
// 않는다 — 채우는 것은 각 묶음의 워크스트림이다.
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

	// 묶음 H — 헤드리스 멤버 (FR-HLM-2). TabID 가 비고 Headless 가 참이면
	// 어떤 탭도 이 도구를 참조하지 않는다. 부착(FR-HLM-6)되면 TabID 가 채워진다.
	Headless bool `json:"headless,omitempty"`

	// 묶음 C — 컨텍스트 예산 (FR-CBG-3). 어휘는 조정자와 공유한다 (FR-RCX-8) —
	// **임베드이므로 JSON 모양은 종전 그대로다.**
	ContextState

	// 묶음 C — 승계 (FR-CBG-9/10). 양방향으로 기록해 사슬을 어느 쪽에서도 따라갈
	// 수 있게 한다.
	SucceededBy   string `json:"succeededBy,omitempty"`   // 이 멤버를 승계한 새 멤버
	SucceededFrom string `json:"succeededFrom,omitempty"` // 이 멤버가 승계한 이전 멤버

	// HandoffSummary 는 이 멤버가 후임에게 남긴 인수인계 요약이다. SRS §3.3.3 이
	// 필드를 명시하지 않았지만 FR-CBG-9 의 3단계(새 멤버 프리앰블에 인수인계 절을
	// 넣는다)가 저장 위치를 요구한다 — 프리앰블 조립은 승계 호출보다 뒤에 일어난다.
	HandoffSummary string `json:"handoffSummary,omitempty"`

	// HandoffPending 은 **요약을 청했으나 아직 오지 않았다**는 뜻이다
	// (UX_BATCH6_SRS FR-RUN-4).
	//
	// 승계가 시한 안에 요약을 받지 못하면 여기 표식이 남는다. 후임의 프리앰블을
	// 만드는 종단이 그 표식을 보고 기다리므로, **어느 쪽이 빨랐든 요약은 버려지지
	// 않는다** — 종전에는 시한을 넘긴 요약이 전임자 레코드에만 남고 후임에게는
	// 닿지 않았다 (SRS §2.11).
	HandoffPending bool `json:"handoffPending,omitempty"`
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
	/**
	 * ALERT_MOBILE_CONTEXT_SRS FR-RCX-6·7 / D-13 — **조정자의 컨텍스트 관측.**
	 *
	 * 훅은 조정자에게도 붙어 실측 토큰과 모델을 이미 보내고 있었다. 서버가 그
	 * `toolId` 를 멤버 목록에서만 찾고(`findByTool`) 못 찾으면 **그대로 버렸다** —
	 * 접수한 물음("조정자 스스로의 context 사용량은 확인 못하나?")의 답이 그것이다.
	 * 신호는 도착해 있었고 앉을 자리가 없었다.
	 *
	 * 멤버 배열에 가짜 멤버를 넣지 않는다 (D-13): 멤버 수·목록·승계·메시지
	 * 라우팅이 전부 그 배열을 딛고 있고, 조정자는 그중 어느 것의 대상도 아니다.
	 *
	 * 포인터인 것은 "관측이 없다" 와 "0 이다" 를 가르기 위해서다 — 필드가 없던
	 * 옛 레코드는 nil 이고 화면에 아무것도 그리지 않는다 (FR-RCX-11).
	 */
	Coordinator *ContextState `json:"coordinator,omitempty"`
	WindowID    string        `json:"windowId,omitempty"`
	Members     []Member      `json:"members,omitempty"`
	// Repo·Base·Worktree 는 격리 Run 에서만 채워진다 (FR-WKT-5). Repo 는 Run 을
	// 연 시점 조정자 cwd 의 저장소 루트이고, Base 는 그때의 HEAD 다 — 나중에
	// "이 브랜치가 무엇에서 갈라졌나"를 물을 근거이며 정리의 대상 저장소다.
	Repo        string    `json:"repo,omitempty"`
	Base        string    `json:"base,omitempty"`
	Worktree    *Worktree `json:"worktree,omitempty"` // per-run 의 공유 트리
	CreatedAt   int64     `json:"createdAt"`
	ClosedAt    int64     `json:"closedAt,omitempty"`
	AbortReason string    `json:"abortReason,omitempty"`

	// 묶음 V — 메시지 로그 (FR-RVZ-14). 관계 그래프의 유일한 원천이다.
	// 최근 500건만 보관하며 초과분은 앞에서 버린다.
	Messages []MsgEvent `json:"messages,omitempty"`
}

// MsgEvent 는 신뢰 채널 통신 하나의 **사실**이다 (FR-RVZ-14).
//
// **본문은 담지 않는다.** 팀 통신은 산출물이 아니라 과정이고, 영속시킬 이유가 없다.
// 또한 본문에는 코드·비밀이 실릴 수 있다 (NFR-RVZ-3).
//
// 발신·수신 중 어느 쪽도 그 Run 의 멤버가 아니면 기록하지 않는다 — 팀 밖 통신은
// Run 의 관심사가 아니다.
type MsgEvent struct {
	From string `json:"from"` // 발신 멤버 uuid (조정자는 "coordinator")
	To   string `json:"to"`   // 수신 멤버 uuid
	At   int64  `json:"at"`
	Kind string `json:"kind,omitempty"` // agent | server-alert
	Size int    `json:"size"`           // 본문 바이트 수
}
