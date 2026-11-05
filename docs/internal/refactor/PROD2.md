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
| 1 | 중복 로직 | 그룹 순서 규칙이 JS `winOrderItems` 와 Go `windowPositions` 두 벌 | 지금은 같은 규칙이다. 결함은 없고, 한쪽만 고쳐도 막는 장치가 없다 | **골든으로 묶었다** (§7). 합칠 수 없다: 한쪽은 브라우저(사이드바·이동), 한쪽은 `dmctl` 프로세스다. 두 쪽 규칙을 각각 바꾸는 탐침으로 시험 실패를 확인했다 |
| 2 | 중복 로직 | statusLine 허용 목록이 `slFields` 와 `toolUsage` 두 벌 | 지금은 맞는다. 막는 장치가 없다 | **합쳤다** (§6). `internal/shared/statusline.Usage` 한 벌을 `dmctl` 과 서버가 함께 쓴다 |
| 4 | 시험 잡음 | `argparse.golden` 이 플래그 구조체 덤프 | 사실. 결함은 아니다 | **고쳤다.** 파서 결과는 기본값이 아닌 필드만 찍는다(`setFields`). 골든을 한 번 다시 만들었고, 옛 줄에서 기본값 필드를 지운 것이 새 줄과 557줄 모두 같음을 스크립트로 대조했다. 플래그 구조체에 가짜 필드를 넣는 탐침이 전에는 골든을 깼고 지금은 깨지 않는다 |
| 5 | 큰 파일 | `app-cmd.js` 805줄 | 사실 | **갈랐다** (§8). `app-cmd.js` 370 · `app-ws-sync.js` 444. 500줄 초과 18 → 17 |
| 8 | 미흡 | Windows statusLine 하위 명령 미실측(TC-SLP-6) | 이 기계에서는 잴 수 없다 | 남김 |
| 9 | 중복 로직 | git 작업 슬롯: JS `gitJobSlotsOf`(`web/js/core/constants-git-remote.js`) ↔ Go `jobs.SlotsOf`(`domain/git/jobs/exclusion.go`) | #1 을 조사하다 찾았다. 주석("같은 규칙")뿐이고, JS 시험(`git-feedback.test.mjs`)은 그 함수를 가짜로 바꿔 끼워 어긋나도 아무것도 실패하지 않는다. **열어 보니 같은 규칙의 두 벌이 아니다** — JS 는 화면의 요청 키(`branch/push`·`tag-push`·`tag-delete-remote` …)를, Go 는 서버의 작업 종류(`fetch`·`push`·`submodule`·`worktree` …)를 받는다. `branch/delete-remote`·`tag-*` 는 서버에서 작업이 아니라 동기 요청이다(`gitlock.go`). 겹치는 것은 "pull 은 두 칸, 원격은 common, 나머지는 index" 뿐이다 | 남김 — 처리 방식 미정(§7a 의 결정을 다시 묻는다) |
| 10 | 중복 로직 | stash 판정: JS `stash-dialogs.js` ↔ Go `write.StashableCount` | #9 와 같은 상태다 | 남김 — #9 와 같다 |

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
- #4·#5 (셋째 회차): `make gates` · `make lint` · `npm run -s typecheck` · `go test ./...` · `npm run -s unit`(752) 통과. e2e 는 워크스페이스 동기화·원격 명령·SSE 를 지나는 20개 파일 273항목이 실패 0 · flaky 0. #5 의 구조 시험(`app-cmd-split.test.mjs`)은 옮기기 전에 3건 모두 실패했다.
- #1·#2 (둘째 회차): `make gates`(architecture.md 패키지 표에 `statusline` 추가) · `make lint` · `go test ./...` · `npm run -s unit`(749) 통과. e2e `skill-contract` · `window-groups` 33항목 통과. #2 는 `statusline.FromInput` 이 없어 컴파일이 실패하는 것을 먼저 보았고, 기존 TC-SLP-4 · TC-SLP-7 은 모양을 바꾸지 않고 통과한다(R-SLU-5).

## 6. 설계 — statusLine 사용량 타입 한 벌 (#2)

**문제.** 같은 허용 목록이 두 자리에 있다. `dmctl` 의 `slFields`(입력 경로 → 내보낼 경로 표)와 서버의 `toolUsage` 구조체다. 한쪽에만 필드를 더하면 값이 조용히 사라진다. `dmctl` 이 서버가 모르는 값을 보내면 서버가 버리고, 서버에만 더하면 아무도 채우지 않는다.

**목록을 서버 한 곳으로 옮길 수 없는 이유.** FR-SLP-2a 가 경로와 본문을 `dmctl` 에서 걸러 보내라고 요구한다. 그래서 `dmctl` 이 목록을 알아야 한다.

**요구.**

| ID | 요구 |
|---|---|
| R-SLU-1 | 허용 목록은 `internal/shared/statusline` 의 `Usage` 타입 **하나**로 선언한다. 필드마다 `json` 태그(내보내는 이름)와 `sl` 태그(statusLine 입력의 이름)를 둔다 |
| R-SLU-2 | `statusline.FromInput(raw)` 가 입력에서 `Usage` 를 만든다. 입력 경로는 `sl` 태그에서 얻는다. 값이 `null` 이거나 없거나 **타입이 다르면** 그 필드를 싣지 않는다. 채운 값이 하나도 없으면 nil 이다 |
| R-SLU-3 | `rate_limits` 는 창 이름이 `^[a-z0-9_]{1,32}$` 인 것만 싣고, 이름을 camelCase 로 바꾼다(`five_hour` → `fiveHour`). 지금과 같다 |
| R-SLU-4 | `dmctl statusline` 은 `FromInput` 의 결과를 보낸다. 서버는 같은 타입으로 받는다(`toolUsage` 는 `Usage` 를 품고 `observedAt` 만 더한다) |
| R-SLU-5 | 보내는 JSON 과 `dmctl status --json` 의 `usage` 모양은 바뀌지 않는다. TC-SLP-4 · TC-SLP-7 이 그대로 통과한다 |
| R-SLU-6 | `Usage` 의 끝 필드 가운데 `sl` 태그가 없는 것이 있으면 시험이 실패한다. 실측 표본 하나로 모든 끝 필드가 채워지는지 시험한다 |

**동작 변경 하나.** 이전에는 타입이 다른 값(예: 숫자 자리에 문자열)도 `dmctl` 이 그대로 보냈고, 서버는 본문 디코딩에 실패해 그 보고 **전체**를 400 으로 버렸다. 이제는 그 필드 하나만 빠진다. 이유: 한 필드 때문에 나머지 사용량을 잃을 까닭이 없다.

## 7. 설계 — window 순서 규칙의 골든 (#1)

같은 표본(`testdata/window-order/*.json`: window 목록 → 기대 위치)을 JS 단위 시험과 Go 단위 시험이 함께 읽는다. 한쪽 규칙만 바뀌면 그쪽 시험이 실패한다.

### 7a. JS·Go 두 벌을 묶는 방식 — 이 저장소의 선례

| 방식 | 사례 |
|---|---|
| ① 공유 표본(골든) | 파일 URI(`platform/testdata/file_uri_vectors.json`) · window 순서(#1) |
| ② 한쪽이 원천, 다른 쪽이 그 파일을 읽는다 | 설정 스키마(`shared/settingsschema` 가 `settings-schema.js` 를 읽는다) |
| ③ 게이트가 두 목록을 대조 | 활동 어휘(`scripts/check-activity-vocab.sh`) |
| ④ 주석만 | #9 · #10 |

**결정(사용자, 2026-11-05).** #9·#10 은 나중에 ② 로 바꾼다 — 한쪽이 원천이고 다른 쪽은 그것을 읽는다. 어느 쪽을 원천으로 둘지는 그 작업에서 정한다.

**정정.** 결정할 때 "둘 다 표로 줄어드는 모양" 이라고 적었는데 #9 는 그렇지 않았다(§2 #9). #10 은 JS 로직을 Go 가 읽을 수 없으므로 서버가 원천이 되고, status 응답에 계산 결과를 싣는 API 변경이 된다. 두 건의 처리 방식은 다시 정한다.

## 8. 설계 — `app-cmd.js` 분할 (#5)

**문제.** `web/js/core/app-cmd.js` 가 805줄이다(500줄 기준선 FR-STR-40). 한 파일에 주제가 둘이다. 하나는 서버 워크스페이스와 맞추는 일(SSE 구독 배선, `workspace_changed` 적용, 전경 이름, 복원 비행 껍데기)이고, 다른 하나는 `dmctl` 이 보낸 원격 명령의 실행(`REMOTE_ACTIONS`, `_execRemote`, `_remote*`, 위치 해석)이다.

| ID | 요구 |
|---|---|
| R-ACS-1 | 워크스페이스 동기화 쪽을 `web/js/core/app-ws-sync.js` 로 **옮기기만** 한다. 옮기는 것: `_restoreBegin`~`_restoreEnd` · `_subscribeCommands` · `_wsDefer` · `_onWorkspaceChanged` · `_onToolForeground` · `_fgMap` · `_fgApply` · `_fgRepaint` · `_applyRemoteWorkspace` · `_sse` 계열 속성 껍데기(`Object.defineProperties`) |
| R-ACS-2 | `app-cmd.js` 에는 원격 명령이 남는다: `_closeOpts` · `REMOTE_ACTIONS` · `_echoResult` 부터 `_focusLocation` 까지 |
| R-ACS-3 | 메서드 본문은 한 글자도 바꾸지 않는다. 두 파일의 메서드 집합은 겹치지 않고, 합치면 옮기기 전과 같다 |
| R-ACS-4 | `index.html` 은 `app-ws-sync.js` 를 `app-cmd.js` 바로 뒤에 싣는다(둘 다 `main.js` 앞) |
| R-ACS-5 | 소스를 경로로 읽는 시험·e2e 는 메서드가 간 파일을 읽는다. 지금 위치를 가리키는 주석도 고친다. 지난 일을 적은 주석("종전에는 `app-cmd.js` 의 …")은 그때의 사실이므로 그대로 둔다 |
| R-ACS-6 | 크기 기준선(`FE_MODULE_BOUNDARY_SRS` §7.1a)을 새 값으로 적는다 |

**검증.** R-ACS-3 을 단위 시험으로 고정한다(옮기기 전에는 새 파일이 없어 실패). 그 밖에 `make gates` · `npm run -s unit` · `typecheck` 와 SSE·원격 명령 e2e 를 돌린다.

## 9. 남은 것

- §2 의 #8 · #9 · #10
- `web/js/core/app-statusbar.js` 의 `_bgModalToggle` 주석이 부르는 자리로 `app-cmd.js` 를 적고 있으나, 지금은 그 파일에 호출이 없다(§8 분할 전부터). 주석만 낡았다
- 1차 감사 종결 뒤 변화분 전체의 분석
