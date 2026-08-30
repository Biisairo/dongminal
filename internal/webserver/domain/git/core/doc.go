// Package core 는 dongminal 의 모든 git 실행이 통과하는 단일 지점이다
// (GIT_SRS 묶음 A, FR-GIT-1~8).
//
// **진입점은 둘이다.** 읽기는 Exec, 저장소를 변경하는 것은 ExecWrite 이며
// (write.go), 각각 readCommands·writeCommands 허용 목록에 있는 하위 명령만
// 실행한다 (FR-GIT-7). 경계를 지키는 것은 **두 목록의 교집합이 비어 있어야
// 한다**는 불변식이다 (FR-GIT-95) — 겹치면 어느 경로로도 실행 가능한 명령이
// 생겨 진입점이 둘이라는 사실 자체가 뜻을 잃는다.
//
// 파괴적 여부는 하위 명령이 정하지 않는다. 호출자가 선언하며(`reset --soft` 와
// `--hard` 가 같은 명령이다), 그 선언과 거부된 호출까지 실행 기록에 남는다
// (FR-GIT-5).
//
// 그 밖에 하지 않는 것: 상태 파싱·diff 해석·signature 계산은 호출자의 일이고,
// 실행 기록은 남기기만 하며 표시하지 않는다 (Console 탭, M6). 셸을 경유하지 않고
// (FR-GIT-2), 실패를 빈 결과로 낮추지 않는다 (FR-GIT-8).
//
// internal/webserver/domain/worktree 는 Run 격리 전용 경로로 자기 git 실행을 그대로 유지한다 —
// FR-GIT-1 이 명시한 유일한 예외다.
package core
