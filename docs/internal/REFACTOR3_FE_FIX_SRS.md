# SRS: 리팩토링 3차 마무리 — 사용자가 고친다고 정한 다섯 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-22 (프로덕션 리팩토링 3차 마무리 · `refactor/PROD3.md` §6 Q7 · P8, `REFACTOR_PROD3_HANDOFF_4.md` §3 「찾은 결함」)
- **사용자 결정 (2026-11-22)**:
  1. **P8-2** — `UX_REMAINING_2026-11-20.md` §7 의 받아들인 한계 다섯 가운데 둘째(작업 중 점은 `aria-hidden` 이라 화면 낭독기가 "작업 중" 을 읽지 못한다)를 고친다. 작업 중인 탭과, 점이 있는 다른 자리(사이드바 창 행·Activity)의 툴팁과 `aria-label` 에 `working` 을 덧붙인다. 나머지 넷(데스크톱 상단바 표식 · 같은 이름의 셸 탭 · fish 등 훅 없는 셸 · 행 문법 둘)은 **그대로 둔다**.
  2. **설정 행 다시 칠하기** — 설정 statusbar 탭의 행을 설정을 열 때·다른 창(기기)의 설정 변경을 받을 때 다시 칠한다. 숫자 설정 행이 포커스된 입력란을 덮는다는 추정은 먼저 실측하고, 맞으면 다른 행의 포커스 가드와 같은 규칙으로 막는다.
  3. **설정 열 때 다시 읽기** — 설정을 열 때 access·sandbox·edges·telegram·server 를 서버에서 다시 읽는다. 요청 수·중복 요청·열고 닫기를 되풀이할 때의 경합을 막는다. 주석을 사실대로 고친다.
  4. **죽은 함수** — `core/git-sync.js` 의 `_gitAddRepo`·`_gitReorder` 를 지운다.
  5. **e2e 게이트 구멍** — `scripts/check-e2e-private.sh` 가 `<별칭>.app._x` 꼴을 잡게 고치고, 걸리는 자리를 계약(`app.testing`)으로 옮긴다. 계약의 App 에 없는 이름 둘(`_gitJobChip`·`_focusCh`)을 정리하고 시험의 알려진 예외를 걷는다.
- 다섯 모두 **동작 변경**이다(4·5 는 사용자 화면이 아니라 코드·시험·게이트의 동작). 이전/새/이유는 §5 에 적는다.
- 실측 기준: HEAD `3dfb1c17`.

## 1. 개요

### 1.1 목적

리팩토링 3차가 동작을 바꾸지 않으려고 미뤄 둔 결함과, 사용자가 다시 보고 고치기로 정한 받아들인 한계 하나를 고친다.

| 이슈 | 자리 | 지금 | 바꾸는 것 |
|---|---|---|---|
| FX-1 (P8-2) | `ui/renderer-pane.js` `_rTabs` · `ui/sidebar-list.js` `buildRow` · `core/tool-work.js` `_workRefresh` · `core/activity-tab-bar.js` `paintTab` | 작업 중 점은 `aria-hidden` 이고, 사이드바 창 행의 링은 CSS 뿐이다. Activity 에이전트 탭의 배지 수(`2`)는 무엇의 수인지 말하지 않는다 | 툴팁과 접근 이름이 `working` 을 말한다(§2.1) |
| FX-2 | `core/settings-statusbar.js` · `core/settings-row.js` · `core/settings-display.js` · `core/settings-terminal.js` | statusbar 행은 한 번 만들고 다시 칠하지 않는다. 숫자 행 다섯은 포커스된 입력란을 덮는다(실측, §2.2) | statusbar 섹션에 `paint()`. 숫자 행 다섯에 포커스 가드 |
| FX-3 | `core/settings-controller.js` `onOpen`·`onTab` · `core/settings-section.js` | 다섯 패널은 탭을 누를 때만 다시 읽는다 | 설정을 열 때 고른 탭이 다섯 가운데 하나면 다시 읽는다. 읽기는 섹션마다 하나만 난다(§2.3) |
| FX-4 | `core/git-sync.js` | 부르는 곳 없는 `_gitAddRepo`·`_gitReorder` 와 그것만 쓰던 도우미·문구 | 지운다(§2.4) |
| FX-5 | `scripts/check-e2e-private.sh` · `e2e/workspace-resync.spec.ts` · `core/app-testing.js` | `w.app._x` 를 못 잡는다(7곳). 계약에 App 에 없는 이름 둘 | 게이트가 잡는다. 7곳은 계약으로. 두 이름은 계약에서 걷고 없음은 다른 길로 잰다(§2.5) |

### 1.2 정의

- **작업 중**: 도구의 활동 보고가 `working` 이고 주의(`_attn`) 표식이 없는 상태. 판정은 `ToolWork.tabWorkDot`·`windowWorkDot` 이다(UX_AUDIT_FIX_SRS FR-UXF-61·62).
- **접근 이름**: 화면 낭독기가 읽는 요소의 이름. `aria-label` 이 있으면 그것이고, 없으면 내용 글자다.
- **포커스 가드**: `FormRow` 선언의 `guard:true`. 칠하기(`paint`)가 포커스를 쥔 입력란을 건너뛴다.
- **다섯 패널**: 설정의 access · sandbox · edges · telegram · server 탭. 서버에서 값을 읽어 그린다.

### 1.3 범위 밖

- `UX_REMAINING` §7 의 나머지 넷 — 사용자 결정으로 그대로 둔다.
- 부팅 적용과 `initModal` 사이의 순서 보장(`HANDOFF_4` §3 넷째) — 이번 결정에 들지 않았다.
- `_gitReorder`·`_gitAddRepo` 가 부르던 서버 종단(`/api/git/repos/reorder`·`/api/git/repo-at`)과 `GIT_API` 표의 두 줄 — 서버 API 이고 Go 시험이 지킨다. FE 표는 서버 경로의 거울이라 남긴다(D-FFX-9).
- 위임자 제거(`Controller.delegate` 표를 걷는 일) — 다음 리팩토링이다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-FFX-1 | `app.js` 에 위임자를 더하지 않는다. 바깥이 새 이름을 부르면 컨트롤러 파일 끝의 `Controller.delegate` 표에 더한다 |
| INV-FFX-2 | 시험이 App 인스턴스의 메서드를 덮어 쓰는 이름은 부품 안에서 `this.app.X()` 로 부른다 |
| INV-FFX-3 | 툴팁·`aria-label` 은 영어다. 사용자 데이터(탭·창 이름)는 그대로 싣는다 |
| INV-FFX-4 | 작업 중이 아닌 자리의 툴팁·접근 이름은 지금과 같다 |

## 2. 요구사항

### 2.1 FX-1 — 작업 중을 이름으로 말한다 (P8-2)

| ID | 요구 |
|---|---|
| FR-FFX-1 | 작업 중인 칸 탭(`.pn-tab`)의 툴팁 첫 줄 끝에 ` — working` 을 덧붙이고, `aria-label` 을 `<탭 이름> — working` 으로 둔다. 작업 중이 아니면 덧붙인 것을 걷고 `aria-label` 을 지운다. 툴팁의 둘째 줄(계정 틴트)은 그대로다 |
| FR-FFX-2 | 작업 중인 도구가 있는 사이드바 창 행(`.sbl-item.working`)도 같은 규칙이다. `aria-label` 의 이름 부분은 행의 보이는 글자(이름·계정 칩·샌드박스 배지, `aria-hidden` 자식 제외)다 |
| FR-FFX-3 | 표식만 고치는 길(`ToolWork._workRefresh`)도 같은 규칙으로 툴팁·`aria-label` 을 고친다. 다시 불러도 두 번 붙지 않는다(멱등) |
| FR-FFX-4 | Activity 의 Agents 탭은 작업 중인 수가 배지로 설 때 툴팁과 `aria-label` 이 `Show running agents — <n> working` 이다. 수가 없거나 알람 점이면 툴팁은 지금과 같고 `aria-label` 은 없다. 모바일 작업 단추(`TIP_MOBILE_ACTIVITY_WORKING`)는 이미 같은 꼴이라 고치지 않는다 |
| FR-FFX-5 | 문구는 상수 둘이다 — `TIP_WORKING_SUFFIX`(` — working`) · `TIP_WORKING_COUNT`(` — {n} working`). 하드코딩하지 않는다 |

### 2.2 FX-2 — 설정 행 다시 칠하기와 포커스 가드

| ID | 요구 |
|---|---|
| FR-FFX-6 | `StatusbarSection.paint()` 가 행마다 스위치를 `statusBar[k]` 로 칠한다. 칠하기 계기는 다른 섹션과 같다 — `SettingsController.paint()`(설정을 열 때 · `_settingsApply` 뒤, 곧 다른 창의 방송을 받은 뒤) |
| FR-FFX-7 | 실측(§6 FX-2)으로 확인한 대로, 숫자 행 다섯(`uiFontSize`·`termFontSize`·`claudeScrollSpeed`·`migrationHookCtxPct`·`issueTreeCtxPct`)에 탭 폭 행과 같은 포커스 가드(`guard:true`)를 단다. 포커스가 떠나면(`blur`) 입력란은 지금처럼 쓰이는 값으로 고쳐진다 |
| FR-FFX-8 | `FormRow` 머리 주석과 `StatusbarSection` 주석의 "다시 칠하지 않는다 · 다른 행에 새로 더하지 않는다(D-FES-2)" 를 새 동작에 맞춘다 |

### 2.3 FX-3 — 설정을 열 때 다섯 패널을 다시 읽는다

| ID | 요구 |
|---|---|
| FR-FFX-9 | 설정을 열 때(`SettingsController.onOpen`) 고른 탭이 다섯 패널 가운데 하나면 그 섹션을 다시 읽는다. 고르지 않은 넷은 읽지 않는다 — 탭을 누를 때 읽는다(지금 그대로) |
| FR-FFX-10 | 그 패널에 저장하지 않은 수정이 있으면(저장 단추의 판정 `SETTINGS_SAVE_BTNS`) 열 때 다시 읽지 않는다 — 수정을 지운다 |
| FR-FFX-11 | 다섯 패널의 읽기는 섹션마다 하나만 난다. 읽는 중에 다시 부르면(열기·탭 누르기·열고 닫기 되풀이) 새 요청을 내지 않고 진행 중인 읽기를 돌려준다 |
| FR-FFX-12 | `SettingsController.onTab`·`onOpen` 의 주석이 이 사실을 적는다 |

### 2.4 FX-4 — 죽은 함수

| ID | 요구 |
|---|---|
| FR-FFX-13 | `_gitAddRepo`·`_gitReorder` 를 지운다. 둘만 부르던 `_gitRepoAt`·`_gitAddRepoRun`·`_gitPinsSort` 와, 둘만 쓰던 문구 상수 `GIT_ADD_REPO_*` 여덟과 i18n 키를 함께 지운다. 지우기 전에 LSP·grep(웹·e2e·시험·위임자 표·계약)으로 부르는 곳이 0 임을 확인한다 |

### 2.5 FX-5 — e2e 게이트 구멍과 계약의 없는 이름

| ID | 요구 |
|---|---|
| FR-FFX-14 | `check-e2e-private.sh` 가 수신자 앞이 무엇이든 `.app._x`·`.app?._x` 를 잡는다(`w.app._x` · `(window as any).app._x` · `x?.app._x`). `e2e/workspace-resync.spec.ts` 의 7곳은 계약 `app.testing.onWorkspaceChanged`(읽기·쓰기)로 옮긴다 |
| FR-FFX-15 | 계약 `APP_TESTING_NAMES` 에서 `_gitJobChip`·`_focusCh` 를 걷는다. 두 이름의 "없음" 을 재던 e2e 두 곳은 계약을 거치지 않는 길로 잰다 — 상태바 chip 은 DOM 으로(이미 있다), BroadcastChannel 경로는 생성 횟수로. App 원형·위임자 표에 두 이름이 없음은 단위 시험이 본다. `app-state-owners.test.mjs` 의 알려진 예외를 걷는다(계약의 모든 이름이 App 에 있다) |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FFX-1 | 접근 이름은 `aria-label` 로 준다. 숨긴 글자(`.sr-only`)를 넣지 않는다 | 사용자 결정이 `aria-label` 을 말했다. 숨긴 글자는 탭 폭·말줄임 계산(`TabBar.fit`)과 레일의 글자 접기에 끼어든다 |
| D-FFX-2 | `aria-label` 은 작업 중일 때만 둔다 | 작업 중이 아닐 때 접근 이름은 지금처럼 내용 글자다(INV-FFX-4). 늘 두면 이름을 고칠 때마다 두 자리를 맞춰야 한다 |
| D-FFX-3 | 툴팁에는 첫 줄 끝에 붙인다 | 탭의 툴팁 둘째 줄은 계정 틴트다(FR-CAC-95). 끝에 붙이면 `working` 이 계정 이름에 붙어 읽힌다 |
| D-FFX-4 | Activity 의 접근 이름은 영어 툴팁과 같은 문장이다 | 모바일 작업 단추가 이미 같은 규칙이다(`Work — {n} working` 이 툴팁이자 `aria-label`). 한국어 탭 이름에 영어를 섞지 않는다(INV-FFX-3) |
| D-FFX-5 | Activity 카드(`.ag-dot`)는 고치지 않는다 | 카드 둘째 줄의 상태 글자(`작업 중 · Edit`)가 이미 읽힌다. 점만 말하지 못하는 자리는 칸 탭·창 행·Agents 탭 셋이다 |
| D-FFX-6 | 포커스 가드는 다섯 숫자 행 모두에 단다 | 실측에서 다섯 모두 덮였다(§6). 탭 폭 행이 이미 같은 장치를 쓰고 그 행만 덮이지 않았다 — 같은 종류의 행에 다른 규칙을 둘 근거가 없다 |
| D-FFX-7 | 열 때 다시 읽는 것은 고른 탭 하나다 | 다섯을 모두 읽으면 설정을 열 때마다 요청이 다섯이다. 보이지 않는 패널은 탭을 누를 때 어차피 다시 읽는다. profile·claude 도 같은 규칙(고른 탭일 때만)이다 |
| D-FFX-8 | 경합은 섹션마다 비행 하나(single flight)로 막는다. 세대 번호로 늦은 응답을 버리는 방식은 쓰지 않는다 | 비행이 하나면 늦게 온 옛 응답이 새 응답을 덮을 일이 없고 중복 요청도 없다. 세대 번호는 요청을 줄이지 못하고, 다섯 읽기 함수의 그리는 자리마다 검사를 넣어야 한다 |
| D-FFX-9 | 서버 종단과 `GIT_API` 의 두 줄은 남긴다 | 서버 API 는 다른 클라이언트(`curl`·CLI)도 부를 수 있고 Go 시험이 지킨다. FE 표는 서버 경로의 거울이다. 이번 결정은 FE 의 죽은 함수다 |
| D-FFX-10 | 게이트는 `.app._` 앞의 수신자를 가리지 않는다 | e2e 에서 `.app` 은 모두 `window.app` 이다. 수신자 이름을 좇으면 별칭마다 새 꼴이 생긴다(이번 구멍이 그랬다) |
| D-FFX-11 | 두 이름의 "없음" 은 계약 밖에서 잰다 | 계약에서 걷은 이름을 계약으로 재면 늘 `undefined` 라 시험이 공회전한다. BroadcastChannel 은 생성자를 세는 것이 경로가 없다는 사실을 직접 잰다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FFX-1 | 단위(`work-dot.test.mjs`): `workLabelSync` — 켜면 첫 줄 끝에 붙고 `aria-label` 이 보이는 글자 + 접미사, 두 번 불러도 한 번, 끄면 원래 툴팁으로 돌아가고 `aria-label` 이 없다. 둘째 줄은 그대로다 |
| TC-FFX-2 | e2e(`fe-fix.spec.ts`): 작업 중 보고 → 활성 탭과 그 창 행의 `title`·`aria-label` 이 `working` 을 말한다. `done` 이면 걷힌다. 주의가 있으면 붙지 않는다 |
| TC-FFX-3 | e2e: Agents 탭 — 둘이 작업 중이면 `title`·`aria-label` 이 `Show running agents — 2 working`, 모두 끝나면 `title` 이 원래 툴팁이고 `aria-label` 이 없다 |
| TC-FFX-4 | 단위(`settings-sections.test.mjs`): `StatusbarSection.paint` 가 스위치를 `statusBar` 로 칠한다. 숫자 행 다섯과 탭 폭 행이 `guard:true` 다 |
| TC-FFX-5 | e2e: 설정 statusbar 탭이 열린 채 다른 클라이언트가 statusbar 값을 바꾸면 스위치가 따라온다. 설정을 닫은 동안 바뀐 값도 다시 열면 보인다 |
| TC-FFX-6 | e2e: 숫자 행 다섯마다 — 입력란에 범위 밖 값을 치는 중에(포커스 유지) 다른 클라이언트가 설정을 바꿔도 입력란의 글자가 그대로다. HEAD 에서 실패한다(실측과 같은 시험) |
| TC-FFX-7 | 단위: `onOpen` 은 고른 탭이 다섯 가운데 하나이고 수정이 없을 때만 그 섹션을 다시 읽는다. 수정이 있으면 읽지 않는다. 비행 중에 다시 부르면 같은 약속을 돌려주고 읽기 함수는 한 번 돈다. 끝나면 다음 부름이 새로 읽는다 |
| TC-FFX-8 | e2e: access 탭을 고른 채 닫고, 다른 클라이언트가 허용 목록을 바꾼 뒤 다시 열면 새 항목이 보인다. 열고 닫기를 빠르게 되풀이해도 `GET /api/access` 가 비행 하나씩이다 |
| TC-FFX-9 | 정적: LSP `findReferences` 와 `grep -rn` (웹·e2e·시험·`scripts`)에서 지운 이름이 0. `make gates`(i18n 미사용 키 포함) |
| TC-FFX-10 | 게이트 탐침: 고친 게이트가 HEAD 의 `workspace-resync.spec.ts` 에서 7곳으로 실패하고, 옮긴 뒤 통과한다. 임시 파일에 `w.app._x`·`(window as any).app?._x` 를 넣으면 실패한다 |
| TC-FFX-11 | 단위(`app-state-owners.test.mjs`): 계약의 모든 이름이 App 에 있다(예외 없음). `_gitJobChip`·`_focusCh` 는 App 에 없다 |
| TC-FFX-12 | 관련 e2e — `grep -rl` 로 고른 spec(작업 중 표식·사이드바·Activity·설정·statusbar·글자 크기·save-pipeline·access·sandbox·edges·telegram·server·git 사이드바·workspace-resync·focus-owner·git-statusbar). 실패는 `git stash push -q -u -- web` 로 HEAD 와 견준다 |

## 5. 동작 변경 기록

| 이슈 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| FX-1 | 작업 중 표식은 눈으로만 보인다. 화면 낭독기는 탭·창 행·Agents 탭에서 "작업 중" 을 듣지 못한다 | 작업 중이면 툴팁 첫 줄과 접근 이름이 `— working`(Agents 탭은 `— <n> working`)을 말한다 | 사용자 결정 P8-2(2026-11-22). 받아들인 한계 §7 둘째 행을 다시 봤다 |
| FX-2 | statusbar 탭의 스위치는 처음 만든 값에 머문다. 숫자 행 다섯은 입력 중에 다른 창의 방송을 받으면 입력란의 글자가 쓰이는 값으로 바뀐다(실측) | 스위치가 열 때·방송 뒤에 지금 값으로 칠해진다. 숫자 행은 포커스가 있는 동안 덮이지 않고, 포커스가 떠날 때 쓰이는 값으로 고쳐진다 | 사용자 결정 2. 다른 기기에서 바꾼 값이 옛 상태로 보이면 켜진 줄로 읽는다. 치는 글자가 튀면 입력이 엉킨다 |
| FX-3 | 다섯 패널은 탭을 누를 때만 다시 읽는다. 설정을 다시 열면 닫기 전에 읽은 값이 남는다 | 열 때 고른 탭이 다섯 가운데 하나이고 수정이 없으면 다시 읽는다. 읽기는 섹션마다 하나만 난다 | 사용자 결정 3. 옛 주석("열 때마다 서버에 묻는다")이 약속한 동작이다 |
| FX-4 | 쓰이지 않는 함수 둘과 도우미 셋·문구 여덟이 남아 있다 | 없다 | 사용자 결정 4 |
| FX-5 | 게이트가 `w.app._x` 를 놓친다. 계약에 App 에 없는 이름 둘이 있고 시험이 그것을 예외로 둔다 | 게이트가 잡는다. 계약의 모든 이름이 App 에 있다 | 사용자 결정 5 |

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| `777e8629` | 이 문서 |
| FX-1 | `workLabelSync`(`core/tool-work.js`) — 칸 탭(`_rTabs`)·창 행(`SidebarList.buildRow`)·표식만 고치는 길(`_workRefresh`)이 부른다. Agents 탭은 구역 서술자의 `badgeWork` 와 `ActivityTabBar.paintTab`. 상수 `TIP_WORKING_SUFFIX`·`TIP_WORKING_COUNT`(`constants.js`). 시험 `work-dot.test.mjs` TC-FFX-1(옛 코드에서 RED) · e2e `fe-fix.spec.ts` TC-FFX-2·3(옛 코드에서 RED). `panel-tabbar.test.mjs` 의 가짜 원소에 `removeAttribute` 를 더했다 |
| FX-2 | 실측 먼저(HEAD `3dfb1c17`, 임시 e2e — 같은 명령에서 지웠다): 설정 탭에서 숫자 칸에 포커스를 둔 채 범위 밖 값을 치고(`9999`, 글자 크기 둘은 `1`), 저장(PUT)이 끝난 뒤 다른 클라이언트가 `statusBar.hostname` 을 뒤집었다. 방송을 받은 뒤 입력란 — `ds-uifs` `"1"`→`"8"` · `ds-termfs` `"1"`→`"8"` · `ds-scrollspeed` `"9999"`→`"20"` · `ds-mighookpct`·`ds-treemigpct` `"9999"`→`"100"`, 포커스는 그대로. 대조군 `ds-tabw`(가드)는 `"9999"` 그대로. **추정이 맞았다** — 다섯 모두 `_settingsApply` → `_paintSettingControls` → `FormRow.paint` 가 덮는다. 고친 것: 다섯 행에 `guard:true`, `StatusbarSection.paint`(스위치 표 `_sw`). 시험 `settings-sections.test.mjs` TC-FFX-4 · `settings-controls.test.mjs` FEC-26 의 가드 목록 개정 · e2e TC-FFX-5·6(옛 코드에서 RED — 실측과 같은 시험) |
| FX-3 | `SettingsController` — 표 `SETTINGS_REREAD`(다섯), 열 때 `_rereadOnOpen`(profile 의 `onOpen` 뒤, 모바일 화면 앞 — 검색 비우기가 고른 탭을 정한 뒤다), 비행 하나 `_reread`(탭 → 약속 `Map`, 끝나면 `finally` 로 걷는다). `onTab` 의 다섯도 `_reread` 를 지난다. 고른 탭은 `SettingsModal.current()`. 수정 판정은 저장 단추 표에서 `settingsPanelDirty`(`settings-save-state.js`), 저장 단추가 없는 server 는 `ServerSection.dirty()`(`_srvChanges`). 시험 `settings-sections.test.mjs` TC-FFX-7 셋(둘은 옛 코드에서 RED, "수정이 있으면 읽지 않는다" 는 옛 코드에서도 참) · e2e TC-FFX-8(옛 코드에서 RED — 닫힌 동안 바뀐 목록이 보이지 않았다) |
| FX-4 | 확인: LSP `findReferences`(`git-sync.js` 의 `_gitAddRepo`·`_gitReorder`) — 정의 한 곳씩뿐. `grep -rn` 웹·e2e·시험·`scripts`·위임자 표(`Controller.delegate(App,'git.sync',…)` 에 없음)·계약(`app-testing.js` 에 없음) — 부르는 곳 0, e2e 주석 하나(`git-worktrees.spec.ts`)뿐. 지운 것: `GitSync` 의 메서드 다섯(`_gitAddRepo`·`_gitRepoAt`·`_gitAddRepoRun`·`_gitReorder`·`_gitPinsSort`) · `constants-git.js` 의 `GIT_ADD_REPO_*` 여덟과 주석 · i18n 키 `git.add_repo_*` 여덟(ko·en). 주석 셋을 고쳤다(`editor-section.js` · e2e `git-worktrees`·`git-sidebar`). 남긴 것: `GIT_API.repoAt`·`reposReorder`·`GIT_ACTION.repoAdd`(서버 경로·동작 ID 의 거울, D-FFX-9) · `check-server-driven.sh` 의 금지 이름 `GIT_ADD_REPO_NEED_PATH`(되살아나지 않게 막는 표) |
| FX-5 | 게이트 — 둘째 꼴 `\)\.app._` 를 `\.app._` 로 넓혔다(수신자를 가리지 않는다, D-FFX-10). 고친 게이트가 옮기기 전 트리에서 `workspace-resync.spec.ts` 7곳으로 실패했고(RED), 탐침 파일의 `w.app._probeA()`·`(window as any).app?._probeB`·`foo?.app._probeC` 셋을 잡았다. 7곳은 계약 `app.testing.onWorkspaceChanged` 의 읽기(바인딩된 원본)·쓰기(인스턴스 덮어쓰기 — 구독이 `this.app._onWorkspaceChanged` 로 부르므로 닿는다)로. 계약에서 `_gitJobChip`·`_focusCh` 를 걷었다(150 → 148). e2e — `git-statusbar` B3 은 DOM 단정만 남기고, `focus-owner` TC-XDF-9 는 `BroadcastChannel` 생성자를 감싸 `dongminal-focus` 를 여는 생성이 없는지 본다. 단위 `app-state-owners.test.mjs` TC-FEA-3 — 예외 없음·두 이름이 App·계약에 없음(옛 계약에서 RED) |

**SRS 와 다르게 한 것.**

1. FR-FFX-9 — 열 때 다시 읽는 자리는 profile 의 `onOpen` 바로 뒤다(모바일 목록 화면 앞). 검색 비우기 뒤여야 고른 탭이 정해진다.
2. FR-FFX-11 — 비행 하나는 섹션이 아니라 `SettingsController` 가 든다(탭 → 약속). 섹션은 `onTab` 그대로이고, 열기·탭 누르기 두 길이 컨트롤러에서 만난다. 섹션 기반 클래스에 메서드를 더하지 않아도 된다.
3. FR-FFX-10 — server 패널은 저장 단추 표에 없어 `ServerSection.dirty()`(적용하지 않은 포트·노출)로 판정한다.
4. FR-FFX-13 — 지운 문구 상수와 i18n 키는 여덟씩이다(요구의 "여덟" 과 같다). `GIT_ACTION.repoAdd` 는 남겼다(D-FFX-9 와 같은 근거).

**시험 결과.** 이슈마다 `make gates`·`npm run -s typecheck` 통과. 단위 1478 통과(FX-5 뒤). 관련 e2e(`grep -rl` 로 고른 spec):

- FX-1: 50 spec 682 — 통과 679 · 실패 1 `ui-kit-icons` V-GAP-1(원래 실패) · 흔들림 2 `slot-view-state` TC-SVS-55·56(알려진 흔들림)
- FX-2: 27 spec 248 통과
- FX-3: 49 spec 555 — 통과 552 · 실패 1 V-GAP-1(원래 실패) · 흔들림 2 `edges-settings` 간선 주소 · `editor-ops` O7(알려진 흔들림, `edges-settings` 는 단독 2회 반복 10/10 통과)
- FX-4: 10 spec 153 통과
- FX-5: `workspace-resync`·`focus-owner`·`git-statusbar` 19 통과

**남긴 것.** 부팅 적용과 `initModal` 의 순서 보장(§1.3). 서버 종단 `/api/git/repo-at`·`/api/git/repos/reorder` 는 FE 에서 부르는 곳이 없어졌다 — 지울지는 따로 정한다. 다섯 패널의 다른 다시 읽기 길(저장 뒤·알림의 다시 불러오기 단추)은 비행 하나를 지나지 않는다(지금 그대로).
