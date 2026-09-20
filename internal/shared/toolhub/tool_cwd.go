package toolhub

import (
	"os"

	"dongminal/internal/shared/platform"
)

// Cwd 는 도구 셸의 작업 디렉터리다. 조회할 수 없는 처지(Windows, 또는 PTY 없는
// 합성 Tool)에서는 **빈 값**이다 — ToolHub.Cwd 의 계약이 "empty if unknown"
// 이며(hub.go), 여기서 서버의 cwd 로 덮으면 그것이 `source:"tool"` 을 달고 나가
// `+ Add` 의 자동채움에 남의 경로로 앉는다 (FR-ETR-31, §2.4). 도구의 실제
// cwd 는 셸 훅의 OSC 777 로도 들어오므로 이 경로는 보조다 (FR-XPI-6).
//
// 폴백이 없어진 것은 아니다 — 그것을 딛는 자리가 cwdOrServer 로 직접 부른다.
func (p *Tool) Cwd() string {
	if pid := p.CmdProcessPID(); pid > 0 {
		if cwd, ok := platform.Current().Info.CWD(pid); ok {
			return cwd
		}
	}
	// 직접 조회가 안 되는 처지(Windows)에서는 **셸 훅이 알린 값**이 답이다
	// (FR-WTC-3). 순서가 이러한 이유는 신선도다: 직접 조회는 지금의 값이고,
	// 보고는 마지막 프롬프트의 값이다 — 둘 다 있으면 앞의 것이 낫다.
	if v, ok := p.reportedCwd.Load().(string); ok && v != "" {
		return v
	}
	return ""
}

// noteCwdReport 는 셸 훅의 보고를 기록한다 (FR-WTC-2).
func (p *Tool) noteCwdReport(cwd string) {
	if cwd != "" {
		p.reportedCwd.Store(cwd)
	}
}

// cwdOrServer 는 종전 Cwd 의 동작이다. 도구의 cwd 를 **비워 둘 수 없는** 자리가
// 쓴다 — 영속이 빈 값을 저장하면 재기동 때 홈으로 되살아나고, CWD 를 제공하지
// 않는 Windows 에서는 그것이 모든 도구에 걸린다.
func cwdOrServer(p *Tool) string {
	if cwd := p.Cwd(); cwd != "" {
		return cwd
	}
	cwd, _ := os.Getwd()
	return cwd
}

// cwdOrServerFrom 은 `cwdOrServer` 와 같은 답을 내되 **미리 받아 둔 표**를 읽는다
// (PERFORMANCE_HARDENING_SRS FR-PRF-76).
//
// 순서는 `Cwd()` 와 같다 — 직접 조회가 먼저, 없으면 셸 훅의 보고, 그래도 없으면
// 서버의 cwd. 두 벌이 되지 않게 **순서의 근거는 위 `Cwd()` 의 주석 하나**이고
// 여기서는 그것을 되풀이하지 않는다.
//
// 표에 없는 pid 는 **모름**이다 (NFR-XP-6) — 빈 문자열과 구분되지 않지만, 둘 다
// 다음 갈래로 내려가므로 답이 갈리지 않는다.
func cwdOrServerFrom(p *Tool, byPID map[int]string) string {
	if pid := p.CmdProcessPID(); pid > 0 {
		if cwd := byPID[pid]; cwd != "" {
			return cwd
		}
	}
	if v, ok := p.reportedCwd.Load().(string); ok && v != "" {
		return v
	}
	cwd, _ := os.Getwd()
	return cwd
}
