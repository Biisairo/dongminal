# SRS: 리팩토링 3차 PROD3 FE 나머지 R3 — 큰 함수·클래스 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: R3a FC-07 · FC-09 구현 · R3b(FC-05 `delWindow` · FC-12 · FU-12 `GitRemote` · FU-13 drag·HUD · FU-14·15·16) 요구·구현

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `refactor/PROD3.md` §2.5 FC-05·07·09·12 · FU-12·13·14·15·16, §7.1 「P3 FE 나머지 — 정리」 의 하위 묶음 R3)
- 사용자 결정: 진행은 묻지 않고 끝까지 한다(`REFACTOR_PROD3_HANDOFF_2.md` §8). 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.
- 실측 기준: HEAD `4120301f`. 아래 `파일:줄` 은 그 커밋의 것이다.
- 나눔: R3 는 둘로 나눠 진행한다. **R3a**(FC-07·09, 위험 H — 순서·충돌을 시험으로 먼저 고정한다)를 이 문서가 먼저 정한다. **R3b**(FC-05 `delWindow` · FC-12 · FU-12 · FU-13 · FU-14·15·16)는 다음 에이전트가 같은 문서의 §2.3·§3·§4 에 이어 쓴다.

## 1. 개요

### 1.1 목적

R3 는 동작을 바꾸지 않고 큰 함수·클래스를 나눈다. R3a 는 워크스페이스 동기화의 두 목 — 원격 스냅샷을 받아 적용하는 함수와 로컬 워크스페이스를 서버에 쓰는 함수 — 을 다룬다. 두 함수는 순서에 기대는 규칙(기억을 갈기 전에 집기, 교체 전에 병합하기, 저장 비행 중의 유예, 충돌 시 포기·채택)을 주석으로 지키고 있다. 그래서 먼저 지금 동작을 단위 시험으로 고정하고, 그 시험이 그대로 지나는 채로 판정(순수 함수)과 적용(메서드)으로 나눈다.

| 이슈 | 자리 | 지금 | 바꾸는 것 |
|---|---|---|---|
| FC-07 | `core/ws-sync-controller.js:307` `_applyRemoteWorkspace` | 136줄(주석 포함). 도구 거두기·정규화·재조정·로컬 시선 집기·병합·교체·시선 되얹기·되쓰기 판정을 한 함수가 한다 | 순수 판정 넷과 단계 메서드 다섯으로 나눈다(§2.1) |
| FC-09 | `core/app.js:478` `save` · `:573` `_saveAdoptRemote` | 90줄 · 88줄. 직렬화·같은 본문 판정·PUT·충돌 갈래·성공 기록, 그리고 git 병합·editors·창 채택·백오프를 각각 한 함수가 한다 | 순수 판정 넷과 메서드 넷으로 나눈다(§2.2) |
| FC-05 · FC-12 · FU-12 · FU-13 · FU-14·15·16 | PROD3 §2.5 | — | **R3b** — 이 문서에 이어 쓴다 |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 적용기 | `_applyRemoteWorkspace`. 원격 스냅샷(`sv`)을 앱 워크스페이스로 받아들이는 한 목. SSE 경로(`_onWorkspaceChanged`)와 409 채택(`_saveAdoptRemote`)이 함께 지난다 |
| 비행 | `save` 의 `run` 한 번. `_saveInflight` 가 참인 동안 |
| 로컬 시선 | 이 브라우저가 보는 자리 — 활성 창, 창마다 포커스 칸, 칸마다 보는 탭, Git 창의 리포 |
| 되쓰기 | 적용기가 받은 스냅샷을 고쳤을 때 그 결과를 서버에 다시 쓰는 `save()` 한 번 |
| 순수 판정 | DOM·앱 상태를 만지지 않고 입력만으로 답을 내는 함수. 인자로 받은 객체를 고치는 것은 이름과 주석에 밝힌다 |

### 1.3 범위 밖

- 저장·채택의 규칙 자체(WORKSPACE_SAVE_CONFLICT_SRS·OPTIMISTIC_LAYOUT_SRS·TOOL_LIST_UNKNOWN_SRS·UX_BATCH12_SRS FR-VTL). 자리만 옮긴다.
- `_onWorkspaceChanged`·`_saveFlushDeferred`·`_wsMarkSaved`·`_wsIdsOf`. 지금 크기가 작다.
- 저장 기계 전체를 컨트롤러로 옮기는 일. 저장 경로가 함께 쓰는 필드(`wsETag`·`_saveInflight` 등)는 App 에 남는다(REFACTOR3_FE_APPCTL_SRS §2.2). 위임자 제거와 함께 다음 리팩토링이다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-R3-1 | 요청(경로·본문·머리)·저장 값·화면이 그대로다. 앱 메서드를 부르는 순서와 횟수가 그대로다(TC-FR3-1~26 이 고정한다) |
| INV-R3-2 | 같은 본문 건너뛰기는 지금처럼 `await` 없이 끝난다 — 비행이 동기로 닫혀 `_saveChain` 을 붙들지 않는다(TC-FR3-16) |
| INV-R3-3 | 적용기는 앱 표면을 `this.app.X` 로 부른다. 시험이 App 인스턴스에 갈아 끼운 이름을 컨트롤러 경로도 본다(HANDOFF_4 §4, TC-FEA-2) |
| INV-R3-4 | 위임자를 더하지 않는다. 새 메서드는 컨트롤러 안·App 안에서만 불린다(HANDOFF_4 §4) |
| INV-R3-5 | 계층·로드 순서·크기(`check-file-size` 기준선)·킷·i18n 게이트를 지킨다. `index.html` 의 스크립트 목록은 바꾸지 않는다 |

## 2. 요구사항

### 2.1 FC-07 — 적용기

| ID | 요구 |
|---|---|
| FR-FR3-1 | `ws-sync-controller.js` 머리(클래스 앞)에 순수 판정 넷을 둔다: `wsLiveTools(serverPanes, known)` → `{ids, live}`(알면 받은 id 와 그 집합, 모르면 `[]` 와 `TOOLS_ALL_LIVE`) · `wsPinsKey(git)`(`git.pinned` 의 JSON, 없으면 `[]`) · `wsViewOf(windows, flatten)` → `{focus, tabs}`(창 id → 포커스 칸, 칸 id → 보는 탭) · `wsViewRestore(windows, view, flatten)`(받은 창에 그 칸·탭이 있을 때만 되얹는다 — 인자 `windows` 를 고친다) |
| FR-FR3-2 | `WsSyncController` 에 단계 메서드를 둔다: `_reapDeadTools(ids, live)`(받은 id 적기, 죽은 인스턴스·id·부팅 표시·알람 거두기, 거뒀으면 알람 다시 그리기) · `_reconcileIncoming(sv, live)`(정규화 → 목록 → 재조정 → 활성 잇기 → 폴백, 바꿨으면 참) · `_viewKeep()`(로컬 시선 집기) · `_mergeUnseen(sv, seenBefore)`(병합, 일어났으면 폴백 한 번 더, 일어났으면 참) · `_viewRestore(view)`(활성 창·칸·탭·리포 되얹기) |
| FR-FR3-3 | `_applyRemoteWorkspace(sv, serverPanes, toolsKnown)` 는 서명을 그대로 두고 위 단계를 지금 순서대로 잇는다. 주석(결정 기록)은 해당 단계로 옮긴다. 코드 줄(주석·빈 줄 제외)은 50 이하다 |

### 2.2 FC-09 — 저장

| ID | 요구 |
|---|---|
| FR-FR3-4 | `app.js` 의 `class App` 뒤에 순수 판정 넷을 둔다: `wsSaveBody(ws)`(벗기는 키 `activeWindow`·`focusedPane`·`dirty`, 현재 `WS_SCHEMA_VERSION` 을 실은 JSON) · `wsSaveSame(last, body, etag)`(마지막으로 성공한 본문·ETag 와 같은가) · `wsGitAdopt(mine, remGit)`(원격 git 에 내 `drafts`·`favorites` 를 얹어 그 객체를 돌려준다 — 인자 `remGit` 을 고친다) · `wsSaveHoldMs(conflicts)`(`min(WS_SAVE_BACKOFF_MS*n, WS_SAVE_BACKOFF_MAX_MS)`) |
| FR-FR3-5 | `save` 의 고리 한 바퀴에서 PUT 한 번을 `_savePut(body)` 로 뺀다. 충돌(409·428)이면 채택한 뒤 참을 돌려주고 고리는 멈춘다. 직렬화·같은 본문 판정은 고리 안에 남는다(INV-R3-2) |
| FR-FR3-6 | `_saveAdoptRemote` 는 연속 충돌 수 세기 → 조회 → ETag → `_adoptRemote(rem)` → `_saveBackoff(conflicts)` 다. `_adoptRemote` 는 git → editors → 창 순서로 채택한다. `_saveBackoff` 는 미룰 시각과 잦음 경고를 적는다 |
| FR-FR3-7 | `save`·`_saveAdoptRemote` 의 코드 줄은 각각 50 이하다. `method-size.test.mjs` 가 고정한다 |

### 2.3 R3b

다음 에이전트가 이어 쓴다. 대상: FC-05 `delWindow`(`core/layout-*.js`) · FC-12 테마 미리보기 인라인 `style` · FU-12 `GitRemote` 안 나누기 · FU-13 `UIKit` drag·HUD · FU-14·15·16(`buildLaneGraph`·`_buildChanges`·`_rowEl`·`_applyStatus` 외).

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FR3-1 | 나누기 전에 지금 동작을 고정하는 시험(`ws-apply-save.test.mjs`)을 따로 커밋한다. 그 시험은 처음부터 GREEN 이다 | 동작 불변 리팩토링의 기준은 "나누기 전과 같다" 이다. RED 로 시작하는 시험은 새 동작을 정하는 것이라 이 묶음의 목적과 다르다 |
| D-FR3-2 | 시험은 앱 표면을 객체 대역(`host`)으로 세우고 부수 효과가 있는 이름의 호출 순서를 로그로 견준다. 앱 대역에 `app.X =` 꼴을 쓰지 않는다 | 순서가 이 두 함수의 핵심 규칙이다(기억 집기→갈기, 병합→교체, 되쓰기→그리기). `app.X =` 꼴은 TC-FEA-2 의 덮어쓰기 대상 목록을 늘려 다른 컨트롤러 검사를 흔든다 |
| D-FR3-3 | 적용기의 판정은 클래스 밖 순수 함수, 단계는 컨트롤러 메서드다. 새 메서드는 위임자 표에 넣지 않는다 | 단계는 `this.app` 을 쓰므로 메서드여야 한다. 바깥은 `_applyRemoteWorkspace` 만 부른다. REFACTOR3_FE_REST2_SRS D-FR2-1 과 같은 꼴이다 |
| D-FR3-4 | 저장 쪽 순수 함수는 `app.js` 의 `class App` 뒤에 둔다. 새 파일을 만들지 않는다 | 저장 기계는 App 에 남는다(§1.3). 새 파일은 `index.html` 로드 순서·하네스 묶음을 바꾸는데, 그 값어치는 저장 기계를 옮길 때 생긴다 |
| D-FR3-5 | `wsPinsKey` 는 적용기만 쓴다. `_adoptRemote` 의 핀 비교(내 것 ↔ 받은 것)는 그 자리에 둔다 | `app.js` 가 뒤에 싣는 파일의 함수를 부르게 하면 단위 시험이 그 파일까지 실어야 한다. 비교식 하나를 공유하려고 로드 의존을 늘리지 않는다 |
| D-FR3-6 | `_savePut` 을 `await` 하는 데서 생기는 마이크로태스크 한 칸은 동작 변경으로 보지 않는다 | `apiPut` 은 지금처럼 같은 틱에 나간다(async 함수는 첫 `await` 까지 동기로 돈다). 늘어나는 것은 응답 뒤의 마이크로태스크 한 칸이며 타이머·요청·화면 어디에도 드러나지 않는다. 같은 본문 건너뛰기는 고리 안에 남겨 동기 종료를 지킨다(INV-R3-2) |
| D-FR3-7 | `app-cmd-split.test.mjs` 의 "합치면 33개" 는 나누기 전 이름(`SYNC`)으로 센다. 새 단계 메서드는 따로 적는다 | 그 시험의 뜻은 `app-cmd.js` 를 둘로 나눌 때 메서드를 잃지 않았는가다. 단계 메서드는 그 뒤에 생긴 것이다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FR3-1 | 단위(`ws-apply-save.test.mjs`): 적용기의 기본 순서 — `_wsSeen` → `_wsMarkSaved` → 정규화 → 재조정 → 활성 잇기 → 폴백 → 병합 → (교체) → 활성 창 → 기기 키 → 포커스 → 칸 시선 → 그리기. 교체 뒤 `ws` 는 받은 스냅샷이다 |
| TC-FR3-2 | 병합은 갈기 전의 기억(`seenBefore`)·교체 전의 로컬 창·받은 창을 받는다. 편집기가 꺼지면 루트 판정은 `null` |
| TC-FR3-3 | 편집기가 켜지면 루트 판정은 지금 목록의 루트다 |
| TC-FR3-4 | 도구를 알면: 받은 id 를 적고, 칸 접미(`@n`)를 떼고 견주어 죽은 인스턴스·id·부팅 표시를 거두고 알람을 내린다. 거둔 것이 있으면 `_attnRefresh` 한 번 |
| TC-FR3-5 | 거둔 알람이 없으면 `_attnRefresh` 를 부르지 않는다 |
| TC-FR3-6 | 도구를 모르면 거두지도 적지도 않고, 정규화는 `TOOLS_ALL_LIVE` 를 받는다 |
| TC-FR3-7 | `editors` 목록은 앱에 편집기가 있고 받은 쪽에 `editors` 가 있을 때만, 재조정 앞에서 갈아 끼운다 |
| TC-FR3-8 | 되쓰기는 정규화·재조정·병합·기기 키 벗기기 가운데 하나라도 바꿨을 때 한 번이고 그리기 앞이다. 아무것도 안 바꿨으면 없다 |
| TC-FR3-9 | 병합이 일어나면 폴백을 한 번 더 부른다 |
| TC-FR3-10 | 로컬 활성 창·포커스 칸·보는 탭·리포가 이긴다. 받은 쪽에 그 칸·탭이 없으면 받은 값을 쓴다 |
| TC-FR3-11 | 로컬 활성 창이 받은 쪽에 없으면 바꾸지 않는다. 로컬 리포가 없으면 받은 리포를 쓴다. 핀이 바뀌면 그리기 뒤에 `gitReposKick` |
| TC-FR3-12 | `save`: 부팅에 실패한 판은 저장하지 않는다 |
| TC-FR3-13 | 본문은 `activeWindow`·`focusedPane`·`dirty` 를 벗기고 현재 스키마 판을 싣는다. `If-Match` 로 나간다. 성공하면 ETag·기억(직렬화 시점의 창·탭)·마지막 본문을 적고 연속 충돌을 되돌린다. 비행 중 `_saveInflight`·`_saveChain`, 끝에 둘 다 풀리고 `_saveFlushDeferred` 한 번 |
| TC-FR3-14 | ETag 가 없으면 조건 머리가 없다. 응답에 ETag 가 없으면 지금 값을 둔다 |
| TC-FR3-15 | 비행 중의 저장은 같은 약속을 돌려받고, 대기분은 같은 비행에서 새 ETag 로 한 번 더 나간다 |
| TC-FR3-16 | 마지막으로 성공한 본문·ETag 와 같으면 보내지 않고 비행이 동기로 끝난다(INV-R3-2). ETag 가 바뀌면 같은 본문도 보낸다 |
| TC-FR3-17 | 미룰 시각이 남았으면 그만큼 잔 뒤에 나간다 |
| TC-FR3-18 | 409·428 이면 `/api/workspace` 를 다시 받아 채택하고 이 저장을 포기한다. 대기분은 이 비행에서 보내지 않는다 |
| TC-FR3-19 | 그 밖의 실패 응답은 아무것도 적지 않는다. 예외는 `[save] PUT failed` 경고로 남기고 대기분을 이어 보낸다 |
| TC-FR3-20 | 직렬화가 던져도 비행이 닫히고 끝 처리를 부른다 |
| TC-FR3-21 | `_saveAdoptRemote`: 조회 → ETag → git 병합(내 `drafts`·`favorites` 가 이긴다, 받은 객체 그대로) → 핀이 바뀌면 `gitReposKick` → editors(`_edPatchList` → 인자 없는 `_edReconcile`) → 창 적용(`[]`, `false`) → 미루기 |
| TC-FR3-22 | 핀이 같으면 목록을 받지 않는다. 내 쪽에 `drafts`·`favorites` 가 없으면 받은 것을 그대로 둔다 |
| TC-FR3-23 | 편집기가 꺼지면 editors 를 받지 않는다. `git`·`windows` 가 없으면 그 갈래를 건너뛴다. ETag 는 응답의 것으로 갈린다(없으면 `null`) |
| TC-FR3-24 | 조회가 실패하면 아무것도 채택하지 않고 미루기만 한다 |
| TC-FR3-25 | 조회가 던지면 `ErrorLog.push('workspace', …)` 하고 미루기는 한다 |
| TC-FR3-26 | 연속 충돌 수는 호출을 넘어 늘고, 미루기는 `200·n` ms 에 상한 2000 ms, 넷째부터 경고한다 |
| TC-FR3-27 | 단위(`ws-apply-save.test.mjs`): 순수 판정 여덟(FR-FR3-1·4)의 경계 — 모름·빈 목록·없는 칸·없는 탭·같은 본문·다른 ETag·없는 키·상한 |
| TC-FR3-28 | 단위(`method-size.test.mjs`): `_applyRemoteWorkspace`·`save`·`_saveAdoptRemote` 코드 50줄 이하. `app-cmd-split.test.mjs`·`app-cmd-fg.test.mjs` 의 서명·이름 고정이 지난다 |
| TC-FR3-29 | e2e(기존): `workspace-resync`·`workspace-save-conflict`·`optimistic-layout`·`tool-list-unknown`·`reconnect-storm`·`sse-resilience`·`boot-reuse`·`tab-names`·`slot-view-state`·`editor-tab`·`notes-live-explorer`·`event-timer-hub-contract`·`layout` 이 HEAD 와 같은 결과다 |
| TC-FR3-30 | 게이트: `make gates`·`npm run -s typecheck`·eslint(원래 2건 밖 새 경고 0) |

## 5. 동작 변경 기록

없다. 자리와 이름만 바꾼다(INV-R3-1). D-FR3-6 의 마이크로태스크 한 칸은 드러나지 않는다.

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
