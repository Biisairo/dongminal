package runtimebin

import (
	"time"

	"dongminal/internal/shared/runwait"
)

// 이 파일은 헬퍼(dmctl·shim·훅)가 서버·데몬을 부를 때 쓰는 **시간 예산 전부**다
// (REFACTOR3_GO_STRUCT_SRS FR-RGS-41). 종전에는 명령 파일마다 흩어져 있어 같은 뜻의
// 값이 두 이름으로 갈라졌다(run·wait 의 여유). 값마다 근거를 옆에 둔다.

// 공용 HTTP.
const (
	// httpDefaultBudget 은 예산을 따로 주지 않은 요청의 상한이다 (httpClient).
	httpDefaultBudget = 10 * time.Second

	// hookBudget 은 에이전트 훅이 부르는 보고(activity·context·attention)의 예산이다
	// (OPTIMIZE_REFACTOR_SRS FR-OPT-8-5 · SHR-10). 훅은 에이전트 턴의 핫패스이고 결과를
	// 기다릴 까닭이 없다 — 서버가 받아 놓고 멈추면(데드락·GC 정지·과부하) 공용 10초가
	// 턴마다 그대로 실린다. 서버가 없을 때는 연결 거절로 곧 돌아오므로 근거가 아니다.
	hookBudget = 2 * time.Second

	// slReportBudget 은 statusLine 의 서버 보고 시한이다 (NFR-SLP-1). 넘기면 버리고 표시로 간다.
	slReportBudget = 100 * time.Millisecond
)

// 서버가 요청을 붙잡는 종단 (M8 D-A-1). 예산 = 서버 상한 + 여유.
const (
	// clientSlack 은 서버 상한 위에 클라이언트가 얹는 여유다 — run 과 wait 가 같은
	// 뜻의 값을 따로 들고 있었다 (FR-OPT-10-2 · SHR-17). 기본 예산은 서버 기본과 같은
	// 상수(`runwait`)에서 나온다 — 사본이 아니다 (M8 D-A-24 · D-A-1).
	clientSlack = 10 * time.Second

	preambleBudget = runwait.PreambleWait + clientSlack

	// closeClientRoom 은 /exit 대기 뒤의 헤드리스 종료 유예·worktree 정리다. 큰
	// worktree(node_modules·빌드 산출물)를 지우는 시간을 기다린다 (ISSUE_TREE_CLOSE_SRS FR-ITX-51).
	closeClientRoom = 5 * time.Minute
	closeBudget     = runwait.ExitSettle + closeClientRoom
)

// 서버가 다른 것을 기다리는 종단.
const (
	// accountCallBudget 은 계정 전환의 예산이다. 전환은 Claude Code 의 락 셋을 각각 최대 9초 기다린다.
	accountCallBudget = 40 * time.Second

	// edgeCallBudget 은 상대를 부르는 로컬 API(add·remove)의 예산이다. 서버의 원격
	// 요청 시한(15초)보다 길어야 상대의 답을 받기 전에 끊지 않는다 (리뷰 C-1).
	edgeCallBudget = 20 * time.Second
)

// shimBudget 은 claude shim 의 실행 준비 API 예산이다. 변수인 것은 시험이 시간 초과를 재기 위해서다.
var shimBudget = 3 * time.Second

// 데몬 채팅 소켓.
const (
	// shimChatDialWait 는 shim 이 채팅 소켓이 열려 있는지 보는 시한이다. claude 기동 앞이라 짧다.
	shimChatDialWait = 300 * time.Millisecond
	// chatDialWait 는 채팅 MCP 의 소켓 연결 시한이다.
	chatDialWait = time.Second
	// chatCallWait 는 채팅 MCP 가 데몬의 답을 기다리는 시한이다.
	chatCallWait = 5 * time.Second
	// chatTabWait 는 채팅 MCP 가 탭 이름을 서버에 묻는 시한이다.
	chatTabWait = time.Second
	// chatUnreadWait 는 ctx-hook 이 채팅 소켓에 안 읽은 수를 묻는 예산이다.
	chatUnreadWait = 700 * time.Millisecond
)

// FR-TND-12: rename-tab 의 확인 창 · 확인 간격. 시험이 줄인다.
var (
	renameConfirmWindow   = 1500 * time.Millisecond
	renameConfirmInterval = 100 * time.Millisecond
)
