// Package runwait 는 Run 종단이 요청을 붙잡는 **상한**이다 (M8_UNIFIED_SRS D-A-1).
//
// 서버(`httpapi`)가 기다리는 시간과 `dmctl`(`runtimebin`)이 그 응답을 기다려 주는
// 예산은 같은 수에서 나와야 한다. 종전에는 서버만 이 값을 알았고 CLI 는 10초 공용
// 클라이언트였다 — 정상 경로(요약 작성에 수십 초)가 늘 "실패" 로 보고된 뒤 서버
// 쪽에서 성공해 있었다 (10-func-backend FBE-01). 두 축이 함께 읽는 것은 `shared/`
// 에 있어야 한다 (M8 `GO-4`).
package runwait

import "time"

const (
	// HandoffWaitDefault 는 `run succeed` 가 인수인계 요약을 기다리는 기본 상한이다.
	// 조정자가 `--timeout-ms` 로 줄이거나 늘린다 (UX_BATCH6_SRS FR-RUN-3: 180초).
	HandoffWaitDefault = 180 * time.Second
	// PreambleWait 는 `GET /api/runs/preamble` 이 늦은 요약을 기다리는 상한이다
	// (FR-RUN-4). 승계보다 짧다 — 여기 오기까지 이미 승계의 시한만큼 기다렸다.
	PreambleWait = 90 * time.Second
	// ExitSettle 은 `POST /api/runs/close` 가 `/exit` 뒤 셸로 돌아오기를 기다리는
	// 상한이다 (UX_BATCH6_SRS FR-RUN-6). 넘겨도 닫는다.
	ExitSettle = 20 * time.Second
	// ActivityWaitDefault·ActivityWaitMax 는 `GET /api/tools/activity/wait` 의 기본·
	// 최대 상한이다 (RUN_ORCHESTRATION_SRS FR-STA-2). `dmctl wait` 의 기본 예산이 이
	// 기본에서 나온다 — 종전에는 그쪽이 300_000 을 **베껴** 두었다 (M8 D-A-24).
	ActivityWaitDefault = 5 * time.Minute
	ActivityWaitMax     = 30 * time.Minute
)
