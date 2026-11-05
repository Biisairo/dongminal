# 프로덕션 리팩토링 2차 — 분석과 처리 기록

> 2026-11-05 · `main` · 기준 커밋 `fed7ef0e`
> 착수 문서: `docs/internal/REFACTOR_PROD2_HANDOFF.md`. 1차 감사는 [`README.md`](README.md)(기준 `ba13ec92`, 종결 `0a581c12`)에 있다.

## 1. 범위

사용자가 정한 범위는 **"현재 코드에 당장 있는 문제를 해결한다"** 이다. 출발점은 인계 문서의 후보 8건이다.
1차 감사가 끝난 뒤 바뀐 코드(331커밋 · 코드 +6.8만/−1.8만 줄) 전체는 아직 분석하지 않았다.

## 2. 후보 8건 — 확인 결과와 처리

| # | 분류 | 후보 | 확인 결과 | 처리 |
|---|---|---|---|---|
| 3 | 하드코딩 | `check-button-kit.mjs` 의 예외를 줄 번호로 등록 | **사실.** `index.html` 첫 줄 뒤에 한 줄을 넣는 탐침으로 게이트가 실패했다 | **고쳤다.** 예외는 그 줄의 표지(`mark`)로 찾는다. 같은 탐침에서 통과한다. 표지가 아무 자리에도 닿지 않으면 낡은 예외로 보고 실패한다 |
| 6 | 성능 | `usageStore` 가 죽은 도구의 사용량을 지우지 않음 | **사실.** 넣기·읽기만 있었다. 도구 ID 는 다시 쓰지 않으므로 틀린 값을 보이지는 않고, 서버가 사는 동안 쌓이기만 한다 | **고쳤다.** `usageStore.prune(live)` 를 더하고 Run 수거 루프(`StartRunReaper`, 15초)의 틱에서 `toolLive` 로 부른다. `toolLive` 는 로컬 판정이라 IPC 가 늘지 않는다 |
| 7 | 성능 | 트리 대시보드가 모든 `run_changed` 에 트리를 다시 받음 | **사실.** 트리 뷰는 어느 Run 이 바뀌어도 `/graph` 와 `/tree` 를 다시 받았다 | **고쳤다** (`ISSUE_AGENT_TREE_SRS` FR-ITD-7 · TC-ITD-4). 서버는 트리 Run 의 `run_changed` 에 `tree` 를 싣고, 트리 뷰는 자기 Run 이거나 같은 트리일 때만 받는다. 방송 세 곳을 `broadcastRunChanged` 하나로 모았다 |
| 1 | 중복 로직 | 그룹 순서 규칙이 JS `winOrderItems` 와 Go `windowPositions` 두 벌 | 지금은 같은 규칙이다. 결함은 없고, 한쪽만 고쳐도 막는 장치가 없다 | 남김 — 같은 표본으로 두 쪽을 시험하는 골든이 처방 후보다 |
| 2 | 중복 로직 | statusLine 허용 목록이 `slFields` 와 `toolUsage` 두 벌 | 지금은 맞는다. 막는 장치가 없다 | 남김 — 1 과 같은 처방 |
| 4 | 시험 잡음 | `argparse.golden` 이 플래그 구조체 덤프 | 사실. 결함은 아니다 | 남김 |
| 5 | 큰 파일 | `app-cmd.js` 805줄 | 사실 | 남김 — 구조 작업이다 |
| 8 | 미흡 | Windows statusLine 하위 명령 미실측(TC-SLP-6) | 이 기계에서는 잴 수 없다 | 남김 |

## 3. 성능 개선 후보 (모아 둔 것)

| 자리 | 현상 | 상태 |
|---|---|---|
| `usageStore` | 죽은 도구의 항목이 남는다 | 처리함 (§2 #6) |
| 트리 대시보드 | 무관한 Run 변경에도 요청 두 개 | 처리함 (§2 #7) |

## 4. 문서에는 있으나 미구현·미흡·잘못

| 자리 | 내용 | 상태 |
|---|---|---|
| `ISSUE_AGENT_TREE_SRS` TC-SLP-6 | Windows 셸 실측 | 미실측 (§2 #8) |
| `ISSUE_AGENT_TREE_SRS` FR-WGR-25 | 키보드 조작의 e2e | SRS 「남은 것」 그대로 |
| `ISSUE_AGENT_TREE_SRS` TC-IAT-3 | 시범 | SRS 「남은 것」 그대로 |

## 5. 검증 (이 기록의 변경 전체)

- `make gates` · `make lint`(golangci-lint 0 issues, eslint) · `go test ./...` · `npm run -s unit`(748 통과)이 모두 통과했다.
- e2e: `run-tree` · `runs` · `slot-run-view` · `small-traffic` · `steady-traffic` 에서 36항목이 돌았다. 실패 0, flaky 0이다.
- RED 확인: #3 은 탐침 줄로 게이트 실패를 확인했다. #6 은 `prune` 이 없어 컴파일이 실패했다. #7 은 Go 1건과 JS 2건이 단언 실패했다.

## 6. 남은 것

- §2 의 #1·#2(두 벌 규칙의 골든) · #4 · #5 · #8
- 1차 감사 종결 뒤 변화분 전체의 분석
