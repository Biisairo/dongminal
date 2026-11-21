package platform

import (
	"net"
	"strconv"
)

// ProcInfo 는 프로세스·포트에 대한 읽기 전용 조회다 (FR-XPI-1).
//
// 조회는 모두 실패할 수 있고, 실패는 오류가 아니라 **모름**이다. 호출자는
// 추측으로 채우지 않고 해당 기능만 비운다 (NFR-XP-6).
type ProcInfo interface {
	// HasChildren 은 pid 에 직계 자식이 있는지다. 도구 busy 판정의 근거다.
	HasChildren(pid int) bool

	// ChildrenOf 는 pid 들의 HasChildren 을 **한 번에** 답한다 (OPTIMIZE_REFACTOR_SRS
	// FR-OPT-8-3). `CWDs`·`Names` 와 같은 이유다 — darwin 에서 도구마다 pgrep 을
	// 띄우면 활동 스냅샷·busy 일괄 조회가 도구 수만큼 fork 한다.
	// 읽지 못하면 false 다 — HasChildren 과 같은 규약이다.
	ChildrenOf(pids []int) map[int]bool

	// CWD 는 프로세스의 현재 작업 디렉터리다.
	CWD(pid int) (string, bool)

	// CWDs 는 pid 들의 cwd 를 **한 번에** 읽는다
	// (PERFORMANCE_HARDENING_SRS FR-PRF-76). 바로 아래 `Names` 와 **같은 이유**다 —
	// 도구마다 외부 프로세스를 띄우면 도구 100개에서 갱신 주기를 넘긴다 (NFR-XP-4).
	//
	// 그 논증이 `CWD` 에도 그대로 있었는데 일괄이 없었다: `ToolManager.SaveAll` 이
	// 도구마다 `lsof` 를 fork 했고, `persist.go` 의 주석이 그 비용을 이미 알면서
	// (*"Cwd() can take tens to hundreds of ms on macOS (lsof)"*) **횟수는 줄이지
	// 않았다** — 잠금 밖으로 빼기만 했다.
	//
	// 읽지 못한 pid 는 **표에 없다.** 빈 문자열로 채우지 않는 것은 "모름" 과
	// "빈 cwd" 가 다른 사실이기 때문이다 (NFR-XP-6).
	CWDs(pids []int) map[int]string

	// Names 는 pid 들의 프로세스 이름을 **한 번에** 읽는다. 도구마다 외부
	// 프로세스를 띄우면 도구 100개에서 갱신 주기를 넘긴다 (NFR-XP-4).
	Names(pids []int) map[int]string

	// ListenerPIDs 는 TCP 포트를 LISTEN 으로 점유한 pid 들이다. 접속만 한
	// 클라이언트는 포함하지 않는다 — 포함하면 서버를 내리는 자리에서 사용자의
	// 브라우저 탭을 함께 죽인다 (종전 cli/proc.go 주석).
	ListenerPIDs(port string) []int

	// ParentPID 는 pid 의 부모다 (FR-XPI-7).
	ParentPID(pid int) (int, bool)

	// Parents 는 모든 프로세스의 pid → 부모 pid 표를 **한 번에** 읽는다
	// (RUN_RECOVERY_SRS FR-RRC-10). 읽지 못하면 ok 가 거짓이다 — 빈 표와 "모름" 을 가른다.
	Parents() (map[int]int, bool)

	// ConnectionOwnerPID 는 이 서버에 붙은 로컬 TCP 연결의 **반대쪽 끝**을
	// 소유한 프로세스다. remoteAddr 는 "host:port" 이고, 그 port 를 로컬
	// 포트로 갖는 소켓의 주인이 곧 클라이언트다. 서버 자신은 제외한다.
	ConnectionOwnerPID(remoteAddr string) (int, bool)
}

// remotePort 는 "host:port" 에서 포트를 뽑는다.
func remotePort(remoteAddr string) (uint16, bool) {
	_, port, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return 0, false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return 0, false
	}
	return uint16(n), true
}

// dedupPositive 는 0 이하와 중복을 걷어낸 pid 목록이다. 조회 대상을 줄이는
// 것이 목적이며, 원래 순서를 지킨다.
func dedupPositive(pids []int) []int {
	out := make([]int, 0, len(pids))
	seen := make(map[int]struct{}, len(pids))
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		out = append(out, pid)
	}
	return out
}
