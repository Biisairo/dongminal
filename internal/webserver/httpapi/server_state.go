package httpapi

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/fswatch"
)

// Server 의 도메인별 하위 상태 (REFACTOR3_GO_STRUCT_SRS FR-RGS-3). 묶음마다 자기 잠금을
// 쥐고, 다른 묶음의 잠금을 잡지 않는다. 전부 제로값이 곧 빈 상태다 — `New` 를 거치지 않고
// `&Server{}` 로 짓는 시험도 그대로 돈다.

// agentState 는 도구·에이전트별 메모리 상태다. 저장소마다 자기 잠금을 쥔다.
type agentState struct {
	// usage 는 도구별 statusLine 사용량이다 (ISSUE_AGENT_TREE_SRS FR-SLP-10). 메모리에만 둔다.
	usage usageStore
	// subagents 는 도구별 서브에이전트 목록이다 (SUBAGENT_USAGE_SRS FR-SAU-10). 메모리에만 둔다.
	subagents subagentStore
	// subActs 는 도구별 서브에이전트 활동(훅)이다 (ACTIVITY_STATE_SUBAGENT_SRS FR-ASV-10). 메모리에만 둔다.
	subActs subagentActivityStore
	// rateLimits 는 에이전트별 마지막 계정 한도다 (FR-ASV-20). 도구가 죽어도 남는다.
	rateLimits rateLimitStore
	// migrationUnknownTold 는 「맥락 사용률을 모른다」 를 이미 알린 도구다 (ISSUE_TREE_OPS_SRS
	// FR-ITM-13). 도구마다 한 번만 알린다.
	migrationUnknownTold sync.Map
}

// sandboxState 는 샌드박스 정의 PUT 의 잠금이다.
type sandboxState struct {
	// putMu 는 PUT 의 지문 검사와 저장을 한 덩이로 묶는다 (UX_BATCH12 FR-LIV-2).
	putMu sync.Mutex
}

// runAux 는 Run 표면의 서버 쪽 보조 상태다.
type runAux struct {
	// recoverProbe·recoverDirs 는 Run 복구의 셸 판정과 설정 폴더 목록을 바꿔 끼우는 자리다
	// (RUN_RECOVERY_SRS). 비면 데몬·계정 서비스에 묻는다. 시험만 채운다.
	recoverProbe func(toolID string, pids []int) toolhub.ShellState
	recoverDirs  func() []string
	// recoverHeld 는 재개줄을 막 넣은 도구다 (FR-RRC-18). 제로값이 빈 표다.
	recoverHeld recoverHolds
	// contextNotices 는 이미 보낸 컨텍스트 통지를 기억한다 (FR-CBG-7). 서버
	// 수명이지 프로세스 수명이 아니다.
	contextNotices contextNoticeLog
}

// connStats 는 연결 진단의 계수다. 잠금 없이 원자값으로만 센다.
type connStats struct {
	// misses 는 "없는 도구를 향한 WebSocket 요청"의 되풀이를 센다
	// (RECONNECT_STORM_SRS FR-RCS-9). 제로값이 곧 빈 추적기라 New 가 세우지 않는다.
	misses missTracker

	// holds 는 지금 **붙잡고 있는** 미스 연결의 수다
	// (CONNECTIVITY_RESILIENCE_SRS FR-CNR-2·4). 소켓을 닫지 않는 것이 재연결의
	// 고리를 끊는 유일한 수단이므로(D-2), 그 대가인 열린 연결 수에 상한이 있어야
	// 한다.
	holds atomic.Int64

	// lastReq·lastWS 는 마지막 요청·WS 연결의 단조 시각(나노초)이다
	// (FR-CNR-8·11). **핫패스 필터로 로그에서 빠지는 요청도 여기는 갱신한다** —
	// 로그에 안 남는 것과 오지 않은 것은 다르며, 그 차이가 진단의 전부다.
	lastReq atomic.Int64
	lastWS  atomic.Int64

	// wsOpen 은 지금 붙어 있는 WebSocket 수다 (FR-CNR-8). 붙잡힌 연결도 여기
	// 포함된다 — 그것이 자원을 쓰고 있다는 사실이 진단에 실려야 한다.
	wsOpen atomic.Int64

	// presenceSubs 는 지금 열린 칸 SSE(`presence=1`) 수다 (FR-OPT-4-12). 방송
	// 구독이 아니어서 허브의 상한(04-secops P1-4)에 잡히지 않으므로 여기서 센다.
	presenceSubs atomic.Int64
}

// rebindState 는 실행 중 리바인드의 상태다 (HOT_REBIND_SRS 묶음 R).
type rebindState struct {
	// bind 는 Run 이 세운다 — Run 밖에서 만든 서버는 nil 이고 리바인드가
	// bind_unavailable 이다. listen·grace 는 시험이 바꾼다.
	bind   *rebinder
	listen func(network, addr string) (net.Listener, error)
	grace  time.Duration
	carry  *carryStore
}

// fsState 는 탐색기의 파일 조작 잠금과 감시다.
type fsState struct {
	// ops 는 탐색기의 파일 조작을 직렬화한다 (FR-EDT-115). 잡는 구간은
	// **실제 파일 조작**뿐이다 — 본문 읽기·경로 판정·세기는 밖에서 한다.
	ops sync.Mutex
	// writes 는 편집기 저장의 표식 검사~쓰기를 경로마다 한 번에 하나로 묶는다 (REFACTOR3_DEFECTS_SRS FR-RD3-20).
	writes pathLocks
	// watch 는 화면에 보이는 디렉터리를 감시해 `fs_changed` 를 방송한다
	// (EDITOR_LIVE_RELOAD_SRS 묶음 W). 임대는 SSE 구독이 쥔다 (FR-ELR-52).
	watch *fswatch.Manager
}
