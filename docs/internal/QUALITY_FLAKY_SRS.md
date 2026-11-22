# SRS: 「흔들림」 으로 받아들여 온 시험의 원인 — IEEE 29148

> **문서 상태**: 승인·구현중

> **남은 것**: FL-2 ~ FL-7 의 재현·원인·고침, 마지막 전량 e2e.

- 접수: 2026-11-22 (`QUALITY_FIX_SRS` 뒤. `REFACTOR_PROD3_HANDOFF_4.md` §4 「흔들림」 목록 · `PROD3.md` §7.1 「전체 시험」 행)
- 사용자 지시: 흔들림으로 받아들여 온 시험의 **원인을 찾아 고친다.** 재시도·시한을 늘려 덮지 않는다. 원인이 시험의 기다림 조건이면 상태가 바뀐 것을 기다리게 고치고, 원인이 앱의 경합이면 앱을 고친다.
- 실측 기준: HEAD `90ee3429`.

## 1. 개요

### 1.1 목적

전량 e2e 를 돌 때마다 서로 다른 몇 항목이 실패하고 다시 돌리면 통과한다. 이것을 「흔들림」 이라 부르며 받아들여 왔다. 흔들림은 실제 경합 결함을 가릴 수 있다. 이 문서는 항목마다 원인을 밝히고 판정(앱 결함 · 시험 경합 · 환경)과 고친 방법을 적는다.

| 이슈 | 자리 | 판정 | 고친 방법 |
|---|---|---|---|
| FL-1 | `e2e/activity-rail.spec.ts` TC-ACF-1 | 시험 경합 | 활동을 보고하기 전에 도구의 전경을 채운다(§2.1) |
| FL-2 | `e2e/slot-view-state.spec.ts` TC-SVS-3·13·50·55·56 | (조사 중) | |
| FL-3 | `e2e/tab-names.spec.ts` V-NAM-1·2·5 · V-TAN-2 | (조사 중) | |
| FL-4 | `e2e/settings.spec.ts:256` · 「규칙에 맞지 않는 이름은 거절」 | (조사 중) | |
| FL-5 | `e2e/ux-audit-fix.spec.ts` TC-UXF-1 · 「2묶음 두 모드」 · `ux-audit-fix-7` TC-UXF-94 | (조사 중) | |
| FL-6 | `editor-ops` O7 · `edges-settings` 간선 주소·망 그림 · `claude-accounts` TC-CAC-27 · `tab` 단축키 · `kit-components` TC-CMP-19 | (조사 중) | |
| FL-7 | 단위 `cm-sticky.test.mjs` · Go `gitapi` `TestWorktreeCreateInputAnswer` | (조사 중) | |

### 1.2 정의

- **흔들림**: 같은 커밋·같은 조건에서 어떤 회차는 통과하고 어떤 회차는 실패하는 시험.
- **반복 실행**: `npx playwright test <spec> --repeat-each=N --retries=0`. 부하는 `PW_WORKERS=<n>` 으로 워커를 늘려 준다.
- **시험 경합**: 시험이 앱이 보장하지 않는 순서·시점에 기대는 것. 앱은 옳게 동작한다.
- **앱 결함**: 앱 안의 두 흐름의 순서가 정해지지 않아 사용자가 볼 수 있는 상태가 틀어지는 것.
- **스냅샷 정리**: 활동 목록 조회(`GET /api/tools/activity`)가 전경 프로세스가 없는 도구의 `working` 카드를 빼는 규칙(FR-AAP-20). 비정상 종료한 에이전트의 「작업 중」 카드가 남지 않게 한다.

### 1.3 범위 밖

- 시험을 지우거나 단정을 약하게 해서 통과시키는 것.
- 재시도 횟수(`retries`)·대기 상한을 늘리는 것.
- `REFACTOR_PROD3_HANDOFF_4.md` 는 이력 문서라 고치지 않는다.

## 2. 요구사항

### 2.1 FL-1 — 활동 레일의 카드가 사라진다 (TC-ACF-1)

**재현.** HEAD 에서 `PW_WORKERS=6 --repeat-each=20` 60회 중 1회, `PW_WORKERS=8 --repeat-each=30` 90회 중 12회 실패. 단독(`--repeat-each=10`)에서는 0회. 실패는 늘 같은 자리다: 패널을 펼친 뒤 카드의 `.ag-state` 를 찾지 못한다(카드가 없다).

**원인(trace).** 시험은 셸 탭의 도구에 `working` 을 보고한다(`POST /api/tools/activity/set`, 200). SSE 알림으로 카드가 선다. 90ms 뒤 주기 조회(5초 주기의 `GET /api/tools/activity`)가 `{"activities":[]}` 를 돌려주었고 화면이 카드를 지웠다. 서버는 조회 때 전경 프로세스가 없는 도구의 `working` 을 뺀다(스냅샷 정리, FR-AAP-20 — `AttnTracker.ActivitySnapshot` 의 바쁨 검사). 시험의 셸은 프롬프트에 서 있으므로 전경이 비었다. 그래서 카드는 **다음 주기 조회까지만** 산다. 단독 실행에서는 시험이 그 전에 끝나고, 부하가 걸리면 단정 사이에 조회가 끼어든다.

**판정.** 시험 경합. 앱은 FR-AAP-20 대로 동작한다. 실제 에이전트가 `working` 을 보고할 때는 그 에이전트가 전경이다. 같은 조건을 다른 시험은 이미 맞춘다(`fixtures.ts` `keepToolBusy` — FR-M11-12, `git-repaint` P9 은 `waiting` 을 쓴다).

| ID | 요구 |
|---|---|
| FR-FLK-1 | TC-ACF-1 은 `working` 을 보고하기 전에 그 도구의 전경을 채운다(`keepToolBusy`). 카드가 선 직후 주기 조회 한 회차(`app.testing.activityRestore()`)를 직접 부르고 카드가 남는지 단정한다 — 주기를 우연에 맡기지 않는다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FLK-1 | TC-ACF-1 은 상태를 `waiting` 으로 바꾸지 않고 전경을 채운다 | 이 시험은 레일에서 `working` 카드의 모양(이름만)을 잰다. 상태를 바꾸면 재는 대상이 바뀐다. 전경을 채우는 것이 실제 사용의 조건이다 |
| D-FLK-2 | 주기 조회 한 회차를 시험 안에서 직접 부른다 | 조회가 끼어드는 순간을 부하에 맡기면 시험이 결함을 우연히만 잡는다. 직접 부르면 옛 시험 조건에서 늘 실패한다(결정적 RED) |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FLK-1 | e2e `activity-rail.spec.ts` 전체를 `PW_WORKERS=8 --repeat-each=30 --retries=0` 으로 돌려 0 실패. 반증: `keepToolBusy` 를 빼면 주기 조회 단정에서 3/3 실패한다 |

## 5. 동작 변경 기록

| 이슈 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| FL-1 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |

## 6. 구현 기록

| 이슈 | 요점 |
|---|---|
| FL-1 | `activity-rail.spec.ts` TC-ACF-1 — `keepToolBusy(page, pid)` 뒤에 `working` 을 보고하고, 카드가 선 뒤 `activityRestore()` 를 불러 카드가 남는지 본다(FR-FLK-1). RED: 주기 조회 단정만 더한 시험이 3/3 실패(카드 0개). 고친 뒤 `PW_WORKERS=8 --repeat-each=30` 90 통과(HEAD 에서는 같은 조건 90회 중 12회 실패) |
