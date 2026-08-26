package runtimebin

import "dongminal/internal/shared/agentadapter"

// 훅 파서는 어댑터 레지스트리로 옮겼다 (FR-ADP-2). 이동은 **무동작 리팩터**이고,
// 그것을 증명하는 회귀 검출기가 dmctl_activity_test.go 다 — 그 테스트를 한 줄도
// 고치지 않고 통과시키기 위해 옛 이름을 **테스트 스코프에서만** 유지한다.
//
// 이 파일은 _test.go 라 프로덕션 바이너리에 들어가지 않는다. 즉 옛 이름이
// 죽은 코드로 남지 않으면서, 이동 전 전수 케이스가 이동 후 레지스트리 파서를
// 그대로 겨눈다.
type activityReport = agentadapter.Report

func parseClaudeHook(data []byte) (activityReport, bool) { return hookParse("claude", data) }
func parseCodexHook(data []byte) (activityReport, bool)  { return hookParse("codex", data) }

func hookParse(agent string, data []byte) (activityReport, bool) {
	ad, err := agentadapter.Get(agent)
	if err != nil {
		return activityReport{}, false
	}
	return ad.HookParse(data)
}
