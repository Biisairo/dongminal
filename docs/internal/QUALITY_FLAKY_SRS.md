# SRS: 「흔들림」 으로 받아들여 온 시험의 원인 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-22 (`QUALITY_FIX_SRS` 뒤. `REFACTOR_PROD3_HANDOFF_4.md` §4 「흔들림」 목록 · `PROD3.md` §7.1 「전체 시험」 행)
- 사용자 지시: 흔들림으로 받아들여 온 시험의 **원인을 찾아 고친다.** 재시도·시한을 늘려 덮지 않는다. 원인이 시험의 기다림 조건이면 상태가 바뀐 것을 기다리게 고치고, 원인이 앱의 경합이면 앱을 고친다.
- 실측 기준: HEAD `90ee3429`.

## 1. 개요

### 1.1 목적

전량 e2e 를 돌 때마다 서로 다른 몇 항목이 실패하고 다시 돌리면 통과한다. 이것을 「흔들림」 이라 부르며 받아들여 왔다. 흔들림은 실제 경합 결함을 가릴 수 있다. 이 문서는 항목마다 원인을 밝히고 판정(앱 결함 · 시험 경합 · 환경)과 고친 방법을 적는다.

| 이슈 | 자리 | 판정 | 고친 방법 |
|---|---|---|---|
| FL-1 | `e2e/activity-rail.spec.ts` TC-ACF-1 | 시험 경합 | 활동을 보고하기 전에 도구의 전경을 채운다(§2.1) |
| FL-2 | `e2e/slot-view-state.spec.ts` TC-SVS-3·13·50·55·56 | 시험 경합 | 탭을 가운데가 아니라 이름의 왼쪽 끝으로 고르고, 활성이 된 것을 기다린다(§2.2) |
| FL-3 | `e2e/tab-names.spec.ts` V-NAM-1·2·5 · V-TAN-2 (같은 원인으로 V-TAN-4·6·12·14·15 · V-NAM-4) | 시험 경합 + **앱 결함** | 시험은 진짜 전경 이름이 닿은 뒤에 흉내를 넣는다. 서버는 구독이 열릴 때 도구마다 지금의 전경 이름을 싣는다(§2.3) |
| FL-4 | `e2e/settings.spec.ts:256` 「고치던 이름은 덮지 않고…」 · 「규칙에 맞지 않는 이름은 거절」 | **앱 결함** | 프로필 패널의 읽기를 하나로 묶고, 읽는 사이에 고친 이름을 덮지 않는다(§2.4) |
| FL-5 | `e2e/ux-audit-fix.spec.ts` TC-UXF-1 · 「2묶음 두 모드」(TC-UXF-16) · `ux-audit-fix-7` TC-UXF-94 | 시험 경합(TC-UXF-1·16) · 재현 못 함(TC-UXF-94) | 기대값을 묻는 순간에 계산하고, 카드 안 배치는 한 번에 잰다. 공용 `waitForInit` 이 첫 구독의 재검증을 기다린다(§2.5) |
| FL-6 | `editor-ops` O7 · `edges-settings` 간선 주소·망 그림 · `claude-accounts` TC-CAC-27 · `tab` 단축키 · `kit-components` TC-CMP-19 | 시험 경합(`tab` 단축키 — FL-2 와 같은 원인) · 재현 못 함(나머지 넷) | `tab.spec` 의 탭 클릭을 `selectTab` 으로(§2.6) |
| FL-7 | 단위 `cm-sticky.test.mjs` · Go `gitapi` `TestWorktreeCreateInputAnswer` | 시험 경합(둘 다) | 시험의 상태 도우미가 다 된 구문 나무를 싣는다 · 생성 잡이 끝날 때까지 기다린다(§2.7) |

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

### 2.2 FL-2 — 칸별 활성 탭 (TC-SVS-3·13·50·55·56)

**재현.** HEAD 에서 다섯을 `PW_WORKERS=8 --repeat-each=16` 으로 돌리면 80회 중 43회 실패, 기본 워커 2 로도 15회 중 5회 실패. 한 워커에 TC-SVS-3 다음 TC-SVS-13 을 돌리면 거의 매번 실패하고, TC-SVS-13 만 돌리면 통과한다.

**원인(계측).** 실패 때 앱의 칸 상태는 화면과 같았다 — 칸 0 이 시험이 누른 탭이 아니라 그 전 탭을 보고 있었다. 탭 클릭 경로에 기록을 달아 보니 칸 0 의 탭 클릭에서 `switchTab` 이 불리지 않았고, 클릭의 대상이 `.pn-tab-x`(닫기 단추)였다. 셸 탭의 이름은 첫 전경 틱에서 `Shell` 이 `~` 로 바뀐다(FR-UXF-65). 이름이 `~` 인 탭은 폭이 44px 이고(이름 6px · 좌우 여백 10px · 닫기 단추 13px), 닫기 단추가 x 223~236 에 서서 탭의 가운데(225)를 덮는다. `locator.click()` 은 요소의 가운데를 누르므로, 이름이 바뀐 뒤에 누르면 탭이 닫힌다. 바뀌기 전(`Shell`, 62px)에는 가운데가 이름이다. 그래서 결과가 전경 틱과 클릭의 순서에 달렸다. TC-SVS-56 은 같은 이유로 탭이 닫혀 다음 클릭이 20초 동안 요소를 찾지 못했다.

**판정.** 시험 경합. 앱은 누른 자리대로 동작한다. 닫기 단추는 탭에 마우스를 올리면 보인다(`opacity` 0 → 보임) — 사람은 단추를 보고 누른다.

**관찰(이번 범위 밖).** 이름이 한 글자인 탭은 가운데가 닫기 단추다. 쉬는 셸 탭의 기본 이름이 `~` 이므로 이 모양은 흔하다. 탭의 최소 폭은 사용자가 정할 화면 결정이라 이번에 바꾸지 않는다.

| ID | 요구 |
|---|---|
| FR-FLK-2 | e2e 가 탭을 고를 때는 공용 도우미 `selectTab`(`fixtures.ts`)을 쓴다. 도우미는 탭 이름의 왼쪽 끝을 누르고, 그 탭이 활성이 될 때까지 기다린다. 탭 자신의 왼쪽 여백은 누르지 않는다 — 둘째 칸의 첫 탭은 그 자리를 칸 경계 손잡이가 덮는다 |

### 2.3 FL-3 — 전경 이름 흉내가 덮인다 (tab-names)

**재현.** HEAD 에서 `PW_WORKERS=8 --repeat-each=8` 136회 중 5회 실패(V-TAN-12 셋 · V-TAN-6 · V-NAM-4). 실패는 모두 「`vim`(또는 `claude`)을 기다렸는데 `~`」 이다.

**원인 1 — 시험 경합.** 이 spec 은 실제 프로세스를 띄우지 않고 전경 이름을 흉내낸다(`onToolForeground` 를 직접 부르고 `/api/state` 응답을 고친다). 그런데 서버의 **진짜** 알림도 온다: 셸이 뜬 뒤 데몬의 첫 전경 틱(2초 주기)이 쉬는 셸의 이름 `"" → "~"` 를 방송한다(UX_AUDIT_FIX_SRS FR-UXF-65). 흉내가 그보다 먼저 들어가면 뒤에 온 진짜 알림이 흉내를 덮는다. V-NAM-4 는 활동 카드도 화면에만 넣어, 다음 주기 조회(서버의 빈 목록)가 카드를 지울 수 있었다(FL-1 과 같은 모양).

**원인 2 — 앱 결함(계측).** 원인 1 을 고친 시험(진짜 이름이 브라우저에 닿을 때까지 기다린다)이 160여 회 중 4회, 서버는 `~` 인데 브라우저는 15초 동안 빈 이름에 머물렀다. 페이지에 `EventSource`·`fetch` 기록을 달아 보니 그 회차에는 `tool_foreground` 가 한 번도 오지 않았다: 부팅 조회 `/api/state`(도구 없음) → 첫 도구 생성(`POST /api/tools`, 521ms) → 구독 열림(591ms). 첫 틱이 도구 생성과 구독 사이(약 70ms, 부하가 걸리면 더 길다)에 떨어지면 그 방송을 받을 구독이 없다. 화면은 첫 구독에서 상태를 다시 받지 않으므로(FR-OPT-4-5 `bootCovered` — 부팅이 방금 받았다) 이름은 다음 변화(폴더 이동) 때까지 `Shell` 로 남는다. 새로고침 때도 같다 — 부팅 조회와 구독 사이에 시작하거나 끝난 프로그램의 이름은 받지 못한다.

**판정.** 시험 경합(원인 1)과 앱 결함(원인 2).

| ID | 요구 |
|---|---|
| FR-FLK-3 | 서버는 `/api/commands/sse` 구독이 열리면(칸 구독 `presence=1` 은 빼고) 인사 뒤에 도구마다 지금의 전경 이름을 `tool_foreground` 로 한 번 싣는다. 빈 이름도 싣는다. 도구 목록을 모르면(`ListOK` 가 거짓) 싣지 않는다 |
| FR-FLK-4 | tab-names 의 흉내(`pushForeground`, V-NAM-1·2·5·4)는 그 도구의 진짜 전경 이름이 브라우저에 닿은 뒤에 넣는다(`fgSettled`: 서버의 `fgName` 이 비지 않을 때까지 — cwd 를 못 읽는 기계는 5초 동안 빈 이름이면 자리잡은 것으로 본다 — 그리고 브라우저의 `fgNames` 가 그 값이 될 때까지). 스냅숏 흉내는 빈 이름도 흉내다 |
| FR-FLK-5 | V-NAM-4 는 활동을 서버에 `waiting` 으로 보고한다 |

### 2.4 FL-4 — 프로필 이름 칸 (settings 「고치던 이름은 덮지 않고…」 · 「규칙에 맞지 않는 이름은 거절」)

**재현.** 단독·파일 단위·`PW_WORKERS=8 --repeat-each=12` 에서는 0회 실패(8샤드 동시·전량에서만 실패하던 것). 응답을 늦춰 결정적으로 재현했다: `GET /api/profile` 를 400ms 늦추고 설정을 열어 Profile 탭을 누른 뒤 이름을 치면, 친 이름(`고치는중`)이 사라지고 안내가 서지 않는다(3/3).

**원인.** 두 가지가 겹친다. ① 설정을 열면 `ProfileSection.onOpen` 이 읽고(첫 탭이 Profile 이다, FR-STO-2), 시험이 Profile 탭을 누르면 `onTab` 이 **한 번 더** 읽는다 — 읽기가 둘 겹친다(서버 패널 다섯은 `_reread` 로 하나만 나지만 profile 은 그 목록 밖이다). ② 읽기의 답은 이름 칸을 읽은 값으로 칠하고 기준(`_liveMark`)을 그 값으로 둔다. 시험은 패널이 **보이면** 곧바로 이름을 친다. 읽기가 그 뒤에 닿으면 친 글자가 지워지고, 기준과 화면이 같아져 「고치던 값」 이 없어진다 — 「거절」 시험은 원래 이름을 저장해 200 을 받고, 「덮지 않고」 시험은 안내 대신 다시 읽기가 돈다. 부하가 걸려 답이 늦을 때만 드러난다.

**판정.** 앱 결함. 느린 망에서 설정을 열자마자 이름을 고치면 늦게 온 답이 사용자의 글자를 지운다.

| ID | 요구 |
|---|---|
| FR-FLK-6 | 프로필 패널의 읽기는 하나만 난다 — 읽는 중에 다시 부르면 그 읽기를 돌려준다. 읽는 사이에 이름 칸이 바뀌었으면(요청을 낼 때의 값과 다르면) 이름 칸은 칠하지 않고 번호·지문만 칠한다. 기준은 읽은 값이다(고친 이름은 저장하지 않은 수정으로 남는다). 그 사이에 선 「바뀌었다」 안내는 거두지 않는다 |

### 2.5 FL-5 — 상단바 제목 · 카드 배치 · 키바 (ux-audit-fix · ux-audit-fix-7)

**재현.** `ux-audit-fix`·`ux-audit-fix-7` 전체를 `PW_WORKERS=8 --repeat-each=4`(192회)로 0 실패. 네 spec 을 함께 `--repeat-each=3` 으로 돌린 회차에서 TC-UXF-16 이 한 번 실패했다: 상태 기호와 이름의 세로 중심이 82.5px 어긋났다(기대 ≤ 2).

**원인 1 — TC-UXF-16(시험 경합).** 네 요소(기호·이름·상태·detail)의 상자를 `rectOf` 로 **하나씩** 잰다. 그 사이에 활동 목록이 다시 그려지면 카드가 통째로 위아래로 옮겨 간다 — 82.5px 는 카드 한 장 높이에 가깝다. 시험이 재려는 것은 카드 **안**의 배치다.

**원인 2 — 화면에만 넣은 활동이 첫 구독의 재검증에 지워진다(시험 경합, TC-UXF-16·17·18 과 활동을 화면에 넣는 시험).** 이 시험들은 `/api/tools/activity` 만 가로채 흉내 활동을 돌려주고 `onToolActivity` 로 화면에 넣는다. 구독이 열리면(`sse:open`) 상태 레지스트리가 활동을 `/api/snapshot` 으로 다시 받는데, 이 요청은 가로채지 않는다. 공용 `waitForInit` 은 저장이 멎기(`waitSettled`)만 기다리고 구독이 열리기는 기다리지 않는다. 부하가 걸려 구독이 그 뒤에 열리면 서버의 빈 목록이 흉내 카드를 지운다. 구독을 1.5초 늦추는 탐침으로 결정적으로 재현했다(카드 0개, 2/2).

**원인 3 — TC-UXF-1(시험 경합, 추론).** 기대값(`창 이름 · 탭 이름`)을 한 번 찍어 두고 화면의 글자와 견준다. 탭 이름은 첫 전경 틱에서 `Shell` 이 `~` 로 바뀐다(FR-UXF-65). 찍은 직후 바뀌면 화면은 옳은데 기대값이 낡는다. 상단바가 전경 이름을 따라간다는 것은 탐침으로 확인했다(이름이 `~` 가 된 뒤 화면도 `Window · ~`). 이 시험의 실패 자체는 재현하지 못했다.

**TC-UXF-94 — 재현 못 함.** 시도한 조건: TC-UXF-94 둘을 `PW_WORKERS=8 --repeat-each=20`(40회), `ux-audit-fix-7` 전체를 `PW_WORKERS=8 --repeat-each=4`·`--repeat-each=3`, 같은 샤드(6/8) 32 spec 을 `PW_WORKERS=4` 로 한 번(249 통과). 키바 구성은 서버 설정이라 같은 워커의 앞 시험이 남긴 값이 영향을 줄 수 있으나, 같은 샤드에서 키바를 바꾸는 spec 은 없다(`mobile-android-touch` 는 키바를 읽기만 한다). 마지막 전량 실행의 결과로 다시 본다.

| ID | 요구 |
|---|---|
| FR-FLK-7 | 공용 `waitForInit` 은 저장이 멎은 뒤 구독이 열리고 첫 재검증의 활동 비행이 닫힐 때까지 기다린다(`app.testing.sse.readyState === 1` 이고 `app.testing.restoreLive('activity', null)`) |
| FR-FLK-8 | TC-UXF-1 은 기대값을 묻는 순간에 계산해 화면의 글자·툴팁과 견준다. TC-UXF-16 은 카드 안 네 요소의 상자를 한 번에 잰다 |

### 2.6 FL-6 — 나머지 다섯 (editor-ops · edges-settings · claude-accounts · tab · kit-components)

**재현.** 다섯 spec 을 `PW_WORKERS=8 --repeat-each=3`(204회)로 돌린 회차에서 `tab.spec` 「keyboard shortcut switches tabs」 가 한 번 실패했다: 둘째 탭을 찾지 못했다.

**원인 — `tab` 단축키(시험 경합).** FL-2 와 같다. 시험은 `first.click()` 으로 첫 탭을 누르는데, 이름이 `~` 가 된 뒤면 가운데가 닫기 단추라 탭이 닫히고 탭이 하나만 남는다. 같은 파일의 「tab switch by clicking another tab」 도 같은 클릭을 쓴다.

**나머지 넷 — 재현 못 함.** 시도한 조건: ① 대상 다섯을 `PW_WORKERS=8 --repeat-each=10`(100회, O7·간선 주소·망 그림·TC-CAC-27·TC-CMP-19 를 줄 번호로 골라) ② 다섯 spec 전체를 `PW_WORKERS=6 --repeat-each=4`(272회) — 그동안 다른 두 샤드(3/8·4/8)를 `PW_WORKERS=4` 로 함께 돌려 부하를 줬다. 모두 0 실패. 코드에서 보이는 위험: O7 은 「목록 요청이 정확히 1건·2건」 을 500ms 뒤에 센다(근거가 있는 고정 대기 예외 `TEST-16`) — 파일 관측의 알림이 늦게 와서 한 번 더 읽으면 수가 늘 수 있다. 실패를 보지 못해 고치지 않았다. 마지막 전량 실행의 결과로 다시 본다.

**부하 실험에서 함께 본 다른 실패(목록 밖).** 위 ② 의 부하로 돌린 두 샤드에서 셋이 실패했다 — `editor-cwd-inherit` V-CWD-2(`newWindow 가 탭을 만들지 않았다`) · `git-feedback` F-9.3(90초 시간 초과) · `explorer-copy` C5(메뉴 항목 클릭 20초 시간 초과). 이번 범위 밖이라 조사하지 않았다.

> **다시 돌렸다 — 재현 못 함 (2026-11-22, HEAD `22f590aa`, `REFACTOR3_FE_REST5_SRS` 합친 뒤).** 셋 다 `--retries=0`. ① 세 시험만 `--repeat-each=5`(워커 2, 15회) ② 세 spec 전체 `--repeat-each=5`(워커 4, 105회) ③ 세 spec 전체 `PW_WORKERS=8 --repeat-each=5`(105회) — 그동안 샤드 3/8 을 `E2E_PORT_BASE=62147 PW_WORKERS=4` 로 함께 돌려 부하를 줬다. 같은 날 REST5 영역 spec 104개(1,137건) 한 회차에서도 셋은 첫 시도에 통과했다. 실패를 보지 못해 고치지 않았다. 처음 실패한 조건(위 ② — 샤드 둘을 워커 4 로 함께 돌리는 중의 워커 6, 동시 브라우저 14)보다 부하가 낮았다.

| ID | 요구 |
|---|---|
| FR-FLK-9 | `tab.spec.ts` 의 탭 고르기(「tab switch by clicking another tab」·「keyboard shortcut switches tabs」)는 `selectTab` 을 쓴다(FR-FLK-2) |

### 2.7 FL-7 — 단위 cm-sticky · Go TestWorktreeCreateInputAnswer

**cm-sticky 재현.** 단독 30회 · `npm run unit` 8회 순차로는 0 실패. `npm run unit` 넷을 **동시에** 세 번(12회) 돌리면 3회 실패 — 늘 JS 구문 나무를 처음 쓰는 시험(「중첩 3단계」, 120~200ms)이다.

**cm-sticky 원인.** 시험의 `stateOf` 는 상태를 만들고 `ensureSyntaxTree(st, 끝, 5000)` 를 부른 뒤 그 상태를 돌려준다. 그런데 `EditorState.create` 는 첫 파싱에 20ms 만 쓰고(`Work.Apply`), 판정 함수가 읽는 `syntaxTree(state)` 는 **그때의 나무**다. `ensureSyntaxTree` 가 끝까지 민 결과는 파서 문맥에만 남고, 다음 트랜잭션이 상태로 받아 간다. 부하가 걸려 첫 20ms 안에 JS 파싱이 끝나지 않으면 덜 된 나무로 판정한다. 앱은 그렇지 않다 — 화면의 플러그인은 나무가 바뀌는 트랜잭션마다 다시 잰다(`update` 의 `syntaxTree` 비교).

**gitapi 원인.** `runInputCases` 의 「답이 참이면 실행해 본다」 는 `POST /api/git/worktrees/create` 를 부르고 4xx 가 아니면 곧바로 돌아온다. 이 종단은 **잡**을 열고 바로 답한다(REPO_FIX 01 §5.6). 시험이 끝나면 `t.TempDir` 정리가 도는데, 그때 잡의 `git worktree add` 가 아직 임시 폴더에 쓰고 있으면 `directory not empty` 다. 순차 150회로는 재현하지 못했지만(빨리 끝난다), 「돌아왔을 때 워크트리가 다 섰는가」 를 단정하면 5/5 실패한다 — 잡이 끝나기 전에 돌아온다는 것이 결정적이다.

**판정.** 둘 다 시험 경합.

| ID | 요구 |
|---|---|
| FR-FLK-10 | `cm-sticky.test.mjs` 의 `stateOf` 는 언어가 있으면 `ensureSyntaxTree` 가 다 됐음을 단정하고 빈 트랜잭션 하나로 그 나무를 실은 상태를 돌려준다 |
| FR-FLK-11 | `runInputCases` 는 실행 종단이 잡을 열었으면 그 잡이 끝날 때까지 기다린다(`gitJobDone`). `TestWorktreeCreateInputAnswer` 는 돌아온 뒤 만든 워크트리(`.git`)가 있는지 단정한다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FLK-1 | TC-ACF-1 은 상태를 `waiting` 으로 바꾸지 않고 전경을 채운다 | 이 시험은 레일에서 `working` 카드의 모양(이름만)을 잰다. 상태를 바꾸면 재는 대상이 바뀐다. 전경을 채우는 것이 실제 사용의 조건이다 |
| D-FLK-2 | 주기 조회 한 회차를 시험 안에서 직접 부른다 | 조회가 끼어드는 순간을 부하에 맡기면 시험이 결함을 우연히만 잡는다. 직접 부르면 옛 시험 조건에서 늘 실패한다(결정적 RED) |
| D-FLK-3 | 탭 이름이 자리잡기를 기다리지 않고 누르는 자리를 바꾼다 | 이름은 전경이 바뀔 때마다 바뀐다. 「다 바뀌었다」 를 정하는 조건이 없다. 이름의 왼쪽 끝은 이름의 길이와 무관하게 이름이다 |
| D-FLK-4 | 같은 모양의 클릭(`a11y-keyboard` TC-A11Y-6e 의 비활성 터미널 탭)도 같은 도우미로 바꾼다 | 목록에 없었지만 원인이 같다 — 이름이 `~` 인 탭의 가운데를 누른다 |
| D-FLK-5 | 틈은 서버가 닫는다 — 구독이 열릴 때 그 구독에만 이름을 싣는다. 화면이 첫 구독에서 `/api/state` 를 다시 받지 않는다 | 화면이 다시 받으면 FR-OPT-4-5 가 없앤 중복 조회(페이지 열 때마다 `/api/state` 두 번)가 돌아온다. 서버는 구독(`Add`)을 먼저 열고 목록을 읽으므로 그 뒤의 변화는 큐에 쌓여 실은 줄 **뒤에** 나간다 — 순서가 구조로 맞다. 목록 조회는 데몬의 목록 캐시를 지나고, 전경 push 가 캐시를 먼저 무효화하므로 방송보다 낡은 값을 싣지 않는다 |
| D-FLK-6 | 인사를 먼저 flush 하고 이름을 그 다음에 싣는다 | 목록 조회가 데몬 RPC 일 수 있다. 인사가 늦으면 화면의 생존 판정(FR-RLC-25)이 흔들린다 |
| D-FLK-7 | 빈 이름도 싣는다 | 부팅 조회와 구독 사이에 끝난 프로그램의 이름을 지우려면 빈 이름이 필요하다. 화면에서는 이름 하나를 지우고 그 탭만 다시 칠한다 |
| D-FLK-9 | 프로필의 겹친 읽기는 섹션 안의 단일 비행으로 묶는다. `SETTINGS_REREAD` 에 넣지 않는다 | profile 은 열 때의 다시 읽기를 자기 `onOpen` 이 한다(순서 계약 INV-S3). 목록에 넣으면 그 순서가 바뀐다 |
| D-FLK-10 | 읽는 사이의 수정은 「요청을 낼 때의 값과 지금 값이 다르다」 로 판정한다 | 패널의 기준(`_liveMark`)은 첫 읽기 전에는 비어 있어 「수정」 을 말할 수 없다. 요청 시점의 값은 언제나 있다 |
| D-FLK-11 | 첫 재검증 기다림은 공용 `waitForInit` 에 둔다. 흉내를 넣는 시험마다 `/api/snapshot` 을 가로채지 않는다 | 「앱이 떠서 멎었다」 는 구독과 그 재검증까지다(E2E_QUIESCENCE 의 뜻). 시험마다 가로채면 같은 구멍이 새 시험에서 다시 열린다 |
| D-FLK-12 | 「첫 재검증이 끝났다」 는 기존 계약 `restoreLive('activity', null)` 로 묻는다. 계약에 새 이름을 더하지 않는다 | 버스는 비행이 없었으면 `undefined`, 닫혔으면 `null` 을 든다 — 그 차이가 곧 「한 번 돌고 닫혔다」 다. 모든 비행이 닫혔는지는 물을 수 없다 — 알람 복원은 목록이 `null` 이면 비행을 닫지 않고 돌아온다(`_attnRestore`) |
| D-FLK-13 | cm-sticky 는 시험 도우미를 고친다. 판정 함수(`edStickyLines`)가 `ensureSyntaxTree` 를 부르게 하지 않는다 | 화면은 나무가 자라면 다시 잰다 — 판정 함수가 파싱을 밀면 스크롤마다 최대 5초를 막을 수 있다. 결함은 「상태를 만든 직후의 나무가 다 됐다」 고 본 시험의 전제다 |
| D-FLK-8 | V-NAM-4 의 활동은 `waiting` 으로 서버에 보고한다 | 이 시험이 재는 것은 카드의 이름이다. 화면에만 넣으면 주기 조회가 지우고, `working` 은 전경이 빈 셸에서 조회가 뺀다(FR-AAP-20) |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FLK-1 | e2e `activity-rail.spec.ts` 전체를 `PW_WORKERS=8 --repeat-each=30 --retries=0` 으로 돌려 0 실패. 반증: `keepToolBusy` 를 빼면 주기 조회 단정에서 3/3 실패한다 |
| TC-FLK-2 | e2e `slot-view-state.spec.ts` TC-SVS-3·13·50·55·56 을 `PW_WORKERS=8 --repeat-each=16` 으로 0 실패. `slot-view-state`·`a11y-keyboard` 전체를 `PW_WORKERS=6 --repeat-each=3` 으로 0 실패 |
| TC-FLK-4 | 단위 `profile-panel.test.mjs` 넷 — 겹친 읽기는 하나 · 읽는 사이에 고친 이름은 남고 뒤의 방송이 안내 · 읽는 사이에 선 안내를 읽기가 거두지 않음(셋 다 옛 코드에서 RED) · 고치지 않았으면 읽은 값. e2e: 응답 400ms 지연 탐침이 고친 뒤 3/3(읽기 1번, 이름 남음, 안내 섬). `settings.spec.ts` `PW_WORKERS=8 --repeat-each=6` 0 실패, 설정 관련 5 spec 통과 |
| TC-FLK-5 | 탐침(구독 1.5초 지연 · 활동 흉내 · 패널 열기 · 2.4초 관찰): 옛 `waitForInit` 에서 카드 0(2/2), 새 것에서 1(3/3). TC-UXF-16 `PW_WORKERS=8 --repeat-each=40` 0 실패. `ux-audit-fix`·`ux-audit-fix-7` `--repeat-each=3` 144 통과. 샤드 6/8 의 32 spec `PW_WORKERS=4` 249 통과(공용 기다림의 회귀) |
| TC-FLK-6 | `tab.spec.ts` 포함 다섯 spec `PW_WORKERS=6 --repeat-each=4` 272 통과(다른 두 샤드를 함께 돌린 부하), 대상 줄 `PW_WORKERS=8 --repeat-each=10` 100 통과 |
| TC-FLK-7 | 단위 `cm-sticky` 「stateOf 는 첫 파싱이 20ms 안에 끝나지 않는 문서도 다 된 나무로 준다」(JS 2만 줄 — 옛 도우미에서 RED). `npm run unit` 넷 동시 × 4회(16회) 0 실패(고치기 전 12회 중 3회). Go `TestWorktreeCreateInputAnswer` 의 워크트리 단정(옛 시험에서 5/5 RED) → `-count=20` 통과, `gitapi` `-race -shuffle=on` 통과 |
| TC-FLK-3 | Go `httpapi` `TestSSE_ForegroundOnConnect`(인사 뒤 도구마다 한 줄, 빈 이름 포함 — 옛 코드에서 RED) · `_UnknownList`(모르는 목록이면 없음) · `_PresenceSkips`(칸 구독이면 없음). e2e `tab-names.spec.ts` 전체 `PW_WORKERS=8 --repeat-each=10` 0 실패. 관련 e2e(재연결·새로고침·복원 비행·동기·skill-contract·version-autoreload 등 11 spec) 통과 |

## 5. 동작 변경 기록

| 이슈 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| FL-1 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |
| FL-2 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |
| FL-5 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |
| FL-6 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |
| FL-7 | — (시험만) | — | 앱 동작은 바뀌지 않는다 |
| FL-4 | 설정을 열면 프로필을 두 번 읽었고, 늦게 온 답이 그 사이에 고친 이름을 지웠다 | 읽기는 한 번이고, 읽는 사이에 고친 이름은 남는다(다른 곳에서 바뀌었으면 안내가 선다) | 느린 망에서 사용자의 글자가 사라졌다(FR-FLK-6) |
| FL-3 | 전경 이름은 바뀔 때의 방송뿐이었다. 부팅 조회와 구독 사이의 변화는 사라져, 새로 연 셸 탭이 폴더를 옮길 때까지 `Shell` 로 남을 수 있었다 | 구독이 열릴 때 서버가 도구마다 지금의 이름을 한 번 싣는다 | 부팅 조회와 구독 사이의 틈(FR-FLK-3, D-FLK-5) |

## 6. 구현 기록

| 이슈 | 요점 |
|---|---|
| FL-1 | `activity-rail.spec.ts` TC-ACF-1 — `keepToolBusy(page, pid)` 뒤에 `working` 을 보고하고, 카드가 선 뒤 `activityRestore()` 를 불러 카드가 남는지 본다(FR-FLK-1). RED: 주기 조회 단정만 더한 시험이 3/3 실패(카드 0개). 고친 뒤 `PW_WORKERS=8 --repeat-each=30` 90 통과(HEAD 에서는 같은 조건 90회 중 12회 실패) |
| FL-2 | `fixtures.ts` 에 `selectTab` — 이름의 왼쪽 끝(x 1px)을 누르고 활성을 기다린다(FR-FLK-2). `slot-view-state` 의 `clickTabId` 와 `a11y-keyboard` TC-A11Y-6e 가 쓴다. 원인 계측: 캡처 단계의 클릭 기록이 `tgt=pn-tab-x` 였고 `switchTab` 이 불리지 않았다. 첫 고침(탭 자신의 왼쪽 여백 x 3px)은 TC-SVS-56 에서 16/16 실패 — 둘째 칸 첫 탭의 왼쪽 끝을 칸 경계 손잡이(`.slot-handle`)가 덮었다. 이름 쪽으로 옮긴 뒤 `PW_WORKERS=8 --repeat-each=16` 80 통과(HEAD 80회 중 43회 실패), 두 spec 전체 `PW_WORKERS=6 --repeat-each=3` 132 통과 |
| FL-4 | `ProfileSection._loadProfilePanel` 은 단일 비행(`_pfReading`), 본문 `_pfRead` 는 요청 시점의 이름과 답이 왔을 때의 이름이 다르면 `_pfPaint(v,keepName)` 로 이름 칸을 두고 `_liveMark(k,r,{name: 읽은 값},keep)` 으로 안내를 둔다. `SettingsLive._liveMark` 에 넷째 인자 `keep`(FR-FLK-6). 시험 TC-FLK-4. 사용자 언어 CHANGELOG 「고침」 |
| FL-5 | `fixtures.ts` `waitSseRevalidated` 를 `waitForInit` 끝에(FR-FLK-7). `ux-audit-fix.spec.ts` TC-UXF-1 은 `expect.poll` 로 그 순간의 규칙 값과 글자·툴팁을 견주고, TC-UXF-16 은 `card.evaluate` 한 번으로 넷을 잰다(FR-FLK-8). 시험 TC-FLK-5. TC-UXF-94 는 재현 못 함 |
| FL-6 | `tab.spec.ts` 두 시험의 탭 클릭 셋을 `selectTab` 으로(FR-FLK-9). 나머지 넷은 재현 못 함(§2.6) |
| FL-7 | `cm-sticky.test.mjs` `stateOf` + 시험 하나(FR-FLK-10). `handlers_git_actions_input_test.go` `runInputCases` 의 잡 기다림과 워크트리 단정(FR-FLK-11). 시험 TC-FLK-7 |
| FL-3 | 서버: `hub.ForegroundSnapshot` · `Server.foregroundOnConnect`(`commands.go`) — 인사를 flush 한 뒤 칸 구독이 아니면 `ListOK` 의 도구마다 `tool_foreground` 를 싣고 flush(FR-FLK-3). Go 시험 `commands_sse_fg_test.go` 셋(옛 코드에서 첫째 RED: 인사 한 줄뿐). 시험: `tab-names.spec.ts` 의 `fgSettled`(서버 값은 `page.request` 로 읽어 스냅숏 흉내를 지나지 않는다) — `pushForeground` 가 도구마다 처음 한 번 부르고, V-NAM-1·2·5·4 가 직접 부른다. 스냅숏 흉내는 `fgStub.has` 로 빈 이름도 덮는다. V-NAM-4 는 활동을 `POST /api/tools/activity/set` 에 `waiting` 으로(FR-FLK-5). 원인 2 의 계측: 실패 회차의 페이지 기록에 `tool_foreground` 가 없고 구독은 도구 생성 70ms 뒤에 열렸다. 고친 뒤 `PW_WORKERS=8 --repeat-each=10` 170 통과(시험만 고친 상태에서 160여 회 중 4회 「브라우저에 닿지 않았다」). 관련 e2e 11 spec 96 통과. 사용자 언어 CHANGELOG 「고침」 |

## 7. 마지막 전량 e2e

`make e2e`(8샤드, 동시 2 × 워커 1), HEAD `18b75f11`. 샤드마다 `test-results/s*/report.json` 의 수를 직접 셌다.

| 샤드 | 통과 | 실패 | 흔들림 | 건너뜀 |
|---|---|---|---|---|
| 1 | 256 | 0 | 0 | 0 |
| 2 | 319 | 0 | 0 | 0 |
| 3 | 293 | 0 | 0 | 0 |
| 4 | 265 | 0 | 0 | 3 |
| 5 | 285 | 0 | 0 | 0 |
| 6 | 249 | 0 | 0 | 0 |
| 7 | 315 | 0 | 1 | 0 |
| 8 | 321 | 1 | 0 | 0 |
| 합 | 2303 | 1 | 1 | 3 |

**남은 것.**

1. 실패 — `ui-layout-defaults` V-LAY-1(샤드 8): 「재지 않는 자리」 가 기준선 40 에서 60 으로 늘었다. 늘어난 20 은 모두 `.sb-collapse`·`.ag-collapse` 가 `ui-btn-lg` 를 단 선택자다 — `QUALITY_FIX_SRS` QF-3(접기 단추 26 → 30px)이 클래스를 바꿨는데 레이아웃 기준선을 다시 만들지 않았다. 단독 실행에서도 늘 실패한다(흔들림이 아니다). 이 문서의 범위 밖이라 기준선을 고치지 않았다. → 2026-11-22 darwin 기준선을 다시 떠 닫았다(`UI_LAYOUT_DEFAULTS_SRS` §9 변경 기록). `linux`·`win32` 는 사용자가 `layout-baseline` 워크플로로 받는다.
2. 흔들림 — `ux-audit-fix` TC-UXF-1(샤드 7): 첫 시도가 `page.goto: net::ERR_INVALID_HTTP_RESPONSE` 로 실패하고 재시도에 통과했다. FR-FLK-8 이 고친 기대값 경합과 다른 원인이다 — 그 워커의 첫 페이지 열기에서 서버가 HTTP 가 아닌 답을 냈다. 조사하지 않았다.
3. 목록의 다른 항목(TC-ACF-1 · TC-SVS-3·13·50·55·56 · tab-names · settings 프로필 둘 · TC-UXF-16 · TC-UXF-94 · O7 · 간선 주소·망 그림 · TC-CAC-27 · `tab` 단축키 · TC-CMP-19)은 이 회차에서 모두 첫 시도에 통과했다.
