# SRS: 리팩토링 3차 PROD3 FE 나머지 R3 — 큰 함수·클래스 — IEEE 29148

> **문서 상태**: 승인·구현완료

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
| FC-05 · FC-12 · FU-12 · FU-13 · FU-14·15·16 | PROD3 §2.1·§2.5 | 큰 함수 다섯(100~180줄)·인라인 `style` 45곳·671줄 클래스·킷의 끌기와 HUD | **R3b** — 단계·순수 판정·클래스로 나눈다(§2.3~2.7) |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 적용기 | `_applyRemoteWorkspace`. 원격 스냅샷(`sv`)을 앱 워크스페이스로 받아들이는 한 목. SSE 경로(`_onWorkspaceChanged`, 2026-11-24 PERF M1 뒤로는 채널 `workspace` 토픽)와 409 채택(`_saveAdoptRemote`)이 함께 지난다 |
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
| INV-R3-5 | 계층·로드 순서·크기(`check-file-size` 기준선)·킷·i18n 게이트를 지킨다. `index.html` 의 스크립트 목록은 바꾸지 않는다. 단 R3b 는 FR-FR3-13·15 가 정한 새 파일 셋(`git/remote-view.js`·`ui/size-hud.js`·`ui/size-drag.js`)만 더한다 |
| INV-R3-6 | (R3b) 화면이 그대로다 — 테마 미리보기의 모든 요소의 계산된 스타일이 나누기 전과 같다(TC-FR3-35). e2e 가 만지는 이름(`GitRemote` 의 `_busy`·`_busyKey`·`_paint`, `#ui-size-hud`·`.ui-size-box`, `UIKit.drag`·`UIKit.grid`)은 그대로 산다 |

## 2. 요구사항

### 2.1 FC-07 — 적용기

| ID | 요구 |
|---|---|
| FR-FR3-1 | `core/layout-tree.js` 의 `mergeUnseenLayout` 앞에 적용기의 순수 판정 넷을 둔다(D-FR3-8): `wsLiveTools(serverPanes, known)` → `{ids, live}`(알면 받은 id 와 그 집합, 모르면 `[]` 와 `TOOLS_ALL_LIVE`) · `wsPinsKey(git)`(`git.pinned` 의 JSON, 없으면 `[]`) · `wsViewOf(windows, flatten)` → `{focus, tabs}`(창 id → 포커스 칸, 칸 id → 보는 탭) · `wsViewRestore(windows, view, flatten)`(받은 창에 그 칸·탭이 있을 때만 되얹는다 — 인자 `windows` 를 고친다) |
| FR-FR3-2 | `WsSyncController` 에 단계 메서드를 둔다: `_reapDeadTools(ids, live)`(받은 id 적기, 죽은 인스턴스·id·부팅 표시·알람 거두기, 거뒀으면 알람 다시 그리기) · `_reconcileIncoming(sv, live)`(정규화 → 목록 → 재조정 → 활성 잇기 → 폴백, 바꿨으면 참) · `_viewKeep()`(로컬 시선 집기) · `_mergeUnseen(sv, seenBefore)`(병합, 일어났으면 폴백 한 번 더, 일어났으면 참) · `_viewRestore(view)`(활성 창·칸·탭·리포 되얹기) |
| FR-FR3-3 | `_applyRemoteWorkspace(sv, serverPanes, toolsKnown)` 는 서명을 그대로 두고 위 단계를 지금 순서대로 잇는다. 주석(결정 기록)은 해당 단계로 옮긴다. 코드 줄(주석·빈 줄 제외)은 50 이하다 |

### 2.2 FC-09 — 저장

| ID | 요구 |
|---|---|
| FR-FR3-4 | `app.js` 의 `class App` 뒤에 순수 판정 넷을 둔다: `wsSaveBody(ws)`(벗기는 키 `activeWindow`·`focusedPane`·`dirty`, 현재 `WS_SCHEMA_VERSION` 을 실은 JSON) · `wsSaveSame(last, body, etag)`(마지막으로 성공한 본문·ETag 와 같은가) · `wsGitAdopt(mine, remGit)`(원격 git 에 내 `drafts`·`favorites` 를 얹어 그 객체를 돌려준다 — 인자 `remGit` 을 고친다) · `wsSaveHoldMs(conflicts)`(`min(WS_SAVE_BACKOFF_MS*n, WS_SAVE_BACKOFF_MAX_MS)`) |
| FR-FR3-5 | `save` 의 고리 한 바퀴에서 PUT 한 번을 `_savePut(body)` 로 뺀다. 충돌(409·428)이면 채택한 뒤 참을 돌려주고 고리는 멈춘다. 직렬화·같은 본문 판정은 고리 안에 남는다(INV-R3-2) |
| FR-FR3-6 | `_saveAdoptRemote` 는 연속 충돌 수 세기 → 조회 → ETag → `_adoptRemote(rem)` → `_saveBackoff(conflicts)` 다. `_adoptRemote` 는 git → editors → 창 순서로 채택한다. `_saveBackoff` 는 미룰 시각과 잦음 경고를 적는다 |
| FR-FR3-7 | `save`·`_saveAdoptRemote` 의 코드 줄은 각각 50 이하다. `method-size.test.mjs` 가 고정한다 |

### 2.3 FC-05 — 창 닫기 (R3b)

실측(HEAD `7adaeb18`, acorn): `core/layout-controller.js:201` `delWindow` 108줄. 편집 확인 → 프로세스 확인 → 도구 처리(되돌리기 유예 / 배경 / 죽이기) → 배열에서 빼기 → 되돌리기 열기 → 슬롯 정리 → 다음 활성 창 → 포커스 → 그리기·저장을 한 함수가 한다.

| ID | 요구 |
|---|---|
| FR-FR3-8 | `LayoutController` 에 단계 메서드 넷을 둔다: `_delWinDirtyOk(s,opts)`(편집 확인 — 계속하면 참) · `_delWinAsk(pids,opts)`(busy 판정과 프로세스 확인 — 취소면 `null`, 아니면 `{asked, keep}`) · `_delWinTools(pids,asked,keep)`(묻지 않은 닫기는 앞 유예를 최종으로 하고 전부 배경으로, 물은 닫기는 `keep` 만 배경·나머지 죽이기) · `_delWinAfter(sid,i)`(빈 워크스페이스·다음 활성 창·포커스·그리기·저장) |
| FR-FR3-9 | `delWindow(sid,opts)` 는 서명을 그대로 두고 위 단계를 지금 순서대로 잇는다. 배열에서 빼기·`_winUndoArm`·`_slotOnWindowGone` 은 `delWindow` 에 남는다. 코드 줄은 50 이하다. 새 메서드는 위임자 표에 넣지 않는다(INV-R3-4) |

### 2.4 FC-12 — 테마 미리보기 (R3b)

실측: `core/settings-theme.js:179` `_renderPreview` 90줄. 마크업 문자열에 인라인 `style=` 45곳이 팔레트 값을 보간한다(`${u.accent}` 등). 사용자 정의 테마의 값은 `sanitizeCustomTheme` 이 걸러 XSS 는 막혀 있다(FC-F1).

| ID | 요구 |
|---|---|
| FR-FR3-10 | 미리보기 마크업은 **보간이 없는 고정 문자열**(`THEME_PREVIEW_HTML`)이다. 인라인 `style=` 은 0 이다. 모양은 `web/style.css` 의 `.pv-*` 규칙이 갖는다 |
| FR-FR3-11 | 색은 순수 함수 `themePreviewVars(u,c,ah)` 가 낸 맵(`'--pv-…'` 이름 → 값)을 `pv.style.setProperty` 로 세운다. CSS 는 `var(--pv-…)` 로 읽는다. 하드코딩 색은 없다. 글자 크기 6px·모서리 2px 는 `.theme-preview-panel` 의 자기 눈금(`--pv-fs-2xs`·`--pv-radius`)으로 둔다 — 지금의 `--pv-fs-*` 와 같은 근거다 |
| FR-FR3-12 | `_renderPreview` 의 코드 줄은 50 이하다. 접근성 속성(`role=img`·`aria-label`)과 견본의 `title`(색 이름)은 그대로다 |

### 2.5 FU-12 — 원격 잡 표시기 (R3b)

실측: `git/remote.js:30` `GitRemote` 671줄(메서드 40), 파일 704줄(500줄 초과 목록). `GitJobs`(`jobs.js`)가 칸마다 `GitRemote` 하나를 세우고 `bind`·`bindHead`·`paint`·`paintHead`·`detachRepo`·`notifyStatus`·`adoptJobs`·`_launch`·`_attach`·`awaitJob`·`dismiss`·`holds` 와 필드 `_busy`·`_busyKey`·`_job`·`_done` 을 쓴다. e2e(`git-head-mobile`)는 `views.index._busy`·`_busyKey` 를 쓰고 `_paint()` 를 부른다.

| ID | 요구 |
|---|---|
| FR-FR3-13 | 표시를 `git/remote-view.js` 의 `GitRemoteView` 로 옮긴다: `bind(el)`·`bindHead(head)`·`paintHead(head)`·`paintJob(el)`(옛 `_paintJob`)·`_box`·`_logCollapsed`·`_state`·`_paintFail`·`_paintLog`·`_termCmd`·`_copyLog`. 뷰는 `this.r`(그 `GitRemote`)의 상태를 읽고, 동작(`cancel`·`dismiss`·`_click`·`_opts`·`_fix`)과 다시 그리기(`_paint`)는 `this.r.X()` 로 부른다 |
| FR-FR3-14 | `GitRemote` 는 상태·실행·스트림·잡 수명을 갖는다. 생성자에서 `this.view=new GitRemoteView(this)` 를 세운다. `paint(el)`(충돌 판정 → `view.paintJob`)·`_paint()`·`busy()` 는 `GitRemote` 에 남는다. `GitJobs` 는 `bind`·`bindHead`·`paintHead` 를 `v.view.X` 로 부른다. 필드 이름(`_busy`·`_logOpen` 등)은 바꾸지 않는다. `remote.js` 는 500줄 아래가 된다 |

### 2.6 FU-13 — 킷의 끌기·HUD (R3b)

실측: `ui/ui-kit.js` 685줄. `drag`(:523, 41줄)와 HUD(`_hudEl`·`_hud`·`_hudHide` :565~619, 상수 `UIK_HUD_EDGE_*`·`uikClamp` :21~24)가 남았다. `_hud*` 를 부르는 곳은 `drag` 뿐이다. 바깥은 `UIKit.drag` 10곳을 쓴다.

| ID | 요구 |
|---|---|
| FR-FR3-15 | HUD 를 `ui/size-hud.js` 의 `SizeHud`(정적 `el()`·`show(axis,px,py,sides)`·`hide()`)로, 끌기를 `ui/size-drag.js` 의 `SizeDrag`(정적 `bind(handle,opts)`)로 옮긴다. 상수 `UIK_HUD_EDGE_X_PX`·`UIK_HUD_EDGE_Y_PX` 와 `uikClamp` 는 `size-hud.js` 로 간다. `UIKit.drag` 는 `SizeDrag.bind` 에 맡기는 입구로 남는다(`UIKit.menu`→`Menu` 와 같은 꼴). `UIKit._hudEl`·`_hud`·`_hudHide` 는 없어진다 |
| FR-FR3-16 | 로드 순서는 `ui-kit.js` 바로 뒤 `size-hud.js` → `size-drag.js` 다(`index.html`). 단위 시험 하네스에 묶음 상수 `HANDLE` 을 더한다: BASE → repaint → ui-kit → HANDLE → DIALOG → LIST → MENU. `PERFORMANCE_BUDGET.md` §2-5 등록부의 `ui-kit.js \| _hud \| b` 행은 `size-hud.js \| show \| b` 가 된다. 타이머 주인 이름(`'ui-kit'`)·합치기 키(`'size-hud'`)는 그대로다 |

### 2.7 FU-14·15·16 — Git 의 큰 함수 넷 (R3b)

실측: `git/lanes.js:42` `buildLaneGraph` 180줄 · `git/git-changes.js:165` `_buildChanges` 121 · `git/git-change-rows.js:203` `_rowEl` 107 · `git/git-poll.js:514` `_applyStatus` 120. 파일은 `git-changes.js` 469 · `git-change-rows.js` 456 줄이다(500줄 경계).

| ID | 요구 |
|---|---|
| FR-FR3-17 | `buildLaneGraph(commits)` 는 서명과 결과를 그대로 두고 셋으로 나눈다: 순수 `laneParentRows(commits)`(부모 → 행 번호, 창 밖·위쪽 부모는 `n`) · 걸음 상태와 R1~R4 의 동작을 갖는 클래스 `LaneWalk`(`take`·`heldAt`·`availColor`·`connect`·`follow`·`run`) · 순수 `laneRows(commits, walk)`(행 모양 조립과 `maxLanes`). `// @ts-check` 가 지난다 |
| FR-FR3-18 | `_buildChanges(el)` 는 순수 `gitChangesHTML(boxes)`(골격 문자열)와 `_wireChangesBar(el)`(부분 노트·lock·진행 중 작업 단추)·`_groupEl(g)`(그룹 하나의 요소)로 나눈다. 배선 순서는 그대로다 |
| FR-FR3-19 | `_rowEl(group,e,depth)` 는 순수 `gitRowTitle(e,partial,dirTitle)`(행 `title`)·`gitRowActTitle(a,e,op)`(동작 단추 `title`, 막힘 사유 전)와 `_rowActBtn(group,e,a)`·`_rowWire(d,group,e)`(클릭·더블클릭·메뉴)로 나눈다 |
| FR-FR3-20 | `_applyStatus(tok,r,d)` 는 순수 `gitStatusVerdict(r,d,repo)`(`net`·`error`·`drop`·`not_repo`·`ok`)와 `_applyNetFail()`·`_adoptObs(d)`(실패 누적·관측 시각·주기·`_status`·`_lastSig`·뷰 따라가기·오류 표식 풀기)·`_paintObs(d)`(관측 근거 → 칠하기·배지·상태바·충돌 판정·대화상자 알림)로 나눈다. 세대 검사가 맨 앞이고 순서는 그대로다 |
| FR-FR3-21 | 위 넷과 FC-05·FC-12 의 함수는 `method-size.test.mjs` 의 상한(코드 50줄)에 든다. 새 순수 함수에는 단위 시험이 있다(TC-FR3-38~41) |

**남기는 것.** 100줄 남짓의 나머지(`ui/version-watch.js:30` 익명 126 · `ui/renderer-pane-wire.js:12` `_makeTab` 109 · `ui/file-tree.js:35` constructor 104 · `core/settings-theme.js:78` `_renderThemePanel` 100)는 이 묶음에서 다루지 않는다(D-FR3-14).

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
| D-FR3-8 | 적용기의 순수 판정 넷은 `ws-sync-controller.js` 가 아니라 `core/layout-tree.js` 에 둔다 | `ws-sync-controller.js` 는 471줄이다. 판정과 그 결정 주석(FR-TLU-5~8·FR-VTL-1)을 같은 파일에 두면 530줄이 되어 크기 게이트(500줄 초과 12 → 13)를 깬다. `layout-tree.js` 는 창 배열·레이아웃의 순수 함수 자리이고 적용기가 이미 거기서 `mergeUnseenLayout`·`findPane`·`firstPane` 을 받는다. `index.html` 에서 `ws-sync-controller.js` 보다 앞에 실린다 |
| D-FR3-9 | (FC-05) 단계는 `LayoutController` 메서드다. 순수 함수로 뺄 판정이 없다 | 모든 단계가 확인창·도구·워크스페이스를 만진다. busy 집합 계산 두 줄은 `_delWinAsk` 안에 둔다 — 따로 빼면 이름이 본문보다 길다 |
| D-FR3-10 | (FC-12) 미리보기는 DOM API 로 하나씩 세우지 않고, **보간 없는 고정 마크업 + CSS 변수**로 그린다 | 위험은 값이 마크업에 섞이는 데 있었다. 고정 문자열에는 값이 들어갈 자리가 없고, 값은 `setProperty` 로만 들어가 마크업이 될 수 없다. 같은 안전을 DOM API 로 얻으려면 요소 60여 개를 손으로 세워야 해 그림의 구조가 읽히지 않는다 |
| D-FR3-11 | (FC-12) 색 변수 이름은 리터럴 맵(`'--pv-bg':u.bg` 꼴)으로 적는다. 반복문으로 이름을 조립하지 않는다 | `check-css-vars.mjs` 는 `'--x':` 와 `setProperty('--x'` 리터럴로 세워진 이름을 센다. 조립한 이름은 그 검사에 안 보여 CSS 가 읽는 `var(--pv-…)` 가 "세워지지 않는다" 로 잡힌다 |
| D-FR3-12 | (FU-12) 나누는 금은 "상태·수명 / 칠하기" 다. `_logOpen` 은 상태 쪽에 둔다 | `_logOpen` 은 사용자의 뜻이지만 잡 수명(`_launch`·`_attach`·`detachRepo`)이 되돌린다. 뷰가 가지면 수명이 뷰를 만져야 한다. e2e 가 `_busy`·`_busyKey`·`_paint` 를 표시기에서 쓰므로 그 셋도 `GitRemote` 에 남긴다. 뷰는 `GitPart` 를 상속하지 않는다 — 패널 부품이 아니라 표시기 하나의 칠하기이고, `GitRemote` 도 `GitPart` 가 아니다 |
| D-FR3-13 | (FU-13) `SizeHud`·`SizeDrag` 는 정적 메서드만 가진 클래스다. `View`·`Component` 를 상속하지 않는다 | HUD 는 문서에 하나뿐인 겹이고 지우지 않는다(D-10). 끌기는 핸들에 수신기를 거는 함수 하나다. 해제할 것이 없으므로 기반 클래스의 수명이 필요 없다. `UIKit.grid`·`cellSize`·`cellFit` 은 호출처가 `sides` 를 계산할 때 쓰는 입구라 `UIKit` 에 남긴다 |
| D-FR3-14 | 100줄 남짓의 나머지 넷은 남긴다 | 브리프가 "시간이 되면" 으로 둔 것이다. 넷 다 이 묶음의 파일과 겹치지 않고(`_renderThemePanel` 만 같은 파일) 동작을 고정하는 시험이 없다 — 나누려면 R3a 처럼 고정 시험부터 세워야 한다 |
| D-FR3-15 | (FU-14·15·16) 순수 함수는 그 클래스와 같은 파일, 클래스 앞에 둔다 | `git-changes.js`·`git-change-rows.js` 가 500줄 경계에 있지만 나눈 뒤 줄 수는 늘지 않는다(본문이 옮겨갈 뿐). 새 파일은 로드 순서·하네스를 바꾼다(D-FR3-4 와 같은 판단) |
| D-FR3-16 | (FC-05) `delWindow` 가 단계 메서드를 `await` 하는 데서 생기는 마이크로태스크 몇 칸은 동작 변경으로 보지 않는다 | 편집이 깨끗할 때 종전에는 `_toolsBusy` 를 같은 동기 구간에서 불렀고, 지금은 `_delWinDirtyOk` 의 약속이 풀린 뒤에 부른다. 둘 다 사용자 입력 한 번 안의 일이고 타이머·요청·화면 순서는 그대로다(TC-FR3-31~33). D-FR3-6 과 같은 판단이다 |
| D-FR3-17 | (FU-15) 행 동작 단추의 제목을 만들 때 진행 중 조작(`_op()`)은 `ours`·`theirs` 에서만 묻는다 | 종전에도 그 둘에서만 물었다. 순수 함수에 `op` 를 늘 넘기려고 단추마다 묻게 하면 행마다 preflight 막힘 목록을 다시 훑는다 — 횟수가 바뀌지 않게 부르는 쪽이 가린다 |

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
| TC-FR3-31 | 단위(`del-window.test.mjs`, 나누기 전에 GREEN): `delWindow` 의 순서 — 편집 확인(취소·저장 실패면 멈춤, `force` 면 묻지 않음) → busy 조회 → 프로세스 확인(취소면 멈춤) → 도구 처리 → 배열에서 빼기 → 되돌리기 열기 → 슬롯 정리 → 활성 창 → 포커스 → 그리기 → 저장 |
| TC-FR3-32 | 묻지 않은 닫기: 앞 유예를 최종으로 하고 모든 도구를 배경으로 보낸 뒤 `_bgRefresh` 한 번, `_winUndoArm` 을 부른다. 물은 닫기: `background` 면 busy 만 배경·나머지 죽이기, 아니면 전부 죽이기. `keepTool` 이면 묻지 않고 busy 만 배경. 되돌리기는 열지 않는다 |
| TC-FR3-33 | 마지막 창이면 새 창을 만들고 그리기만 한다(저장 없음). 활성 창을 닫았는데 일반 창이 없으면 새 창 → 그리기 → 저장. 다음 창이 있으면 그리로 간다. 포커스는 남은 포커스 칸, 없으면 첫 칸 |
| TC-FR3-34 | 단위(`theme-preview.test.mjs`): `THEME_PREVIEW_HTML` 에 `style=`·`${` 가 없다. `themePreviewVars` 는 받은 팔레트 값을 이름마다 그대로 싣고, CSS 가 읽는 `var(--pv-…)` 이름이 전부 그 맵에 있다(색 변수에 한해) |
| TC-FR3-35 | 임시 e2e(`e2e/zz-tmp-pv.spec.ts`, 같은 명령에서 지운다): 테마 셋(기본 어둠·밝음·사용자 정의)에서 `#theme-preview` 안 모든 요소의 계산된 스타일(색·배경·테두리·글자 크기·굵기·간격·모서리·크기)이 나누기 전과 같다 |
| TC-FR3-36 | 단위(`git-job-outcome`·`git-job-labels`·`git-view` 개정): 상태 글자와 접기 판정은 `GitRemoteView` 에서 같은 답을 낸다. `remote-view.js` 도 클래스 하나다. `GitRemote` 원형에 표시 메서드가 없다 |
| TC-FR3-37 | 단위(`kit-handle.test.mjs`): `UIKit.drag` 는 `SizeDrag.bind` 에 맡긴다. `SizeHud.show` 는 상자 둘의 글자(px·칸·%)와 정렬 클래스, 화면 가장자리 자르기를 지금처럼 한다. `UIKit` 에 `_hud*` 가 없다 |
| TC-FR3-38 | 단위(`lanes.test.mjs` 더함): `laneParentRows` 의 창 밖·위쪽 부모는 `n`. 나눈 뒤 기존 레인 시험 전부가 그대로 지난다 |
| TC-FR3-39 | 단위(`git-parts-pure.test.mjs`): `gitChangesHTML` 의 골격 순서(커밋 → 머리 → 잡 → 진행 중 작업 → 부분 노트 → 목록) · `gitRowTitle`(이름 바꿈·점수·일부 스테이지·디렉터리) · `gitRowActTitle`(ours/theirs 는 진행 중 조작으로, 새 파일 폐기는 삭제 문구로) |
| TC-FR3-40 | 단위(같은 파일): `gitStatusVerdict` — 상태 0 은 `net`, 실패는 `error`, 요청값이 다르거나 본문이 없으면 `drop`, `isRepo:false` 는 `not_repo`, 나머지 `ok` |
| TC-FR3-41 | 단위(`method-size.test.mjs`): `delWindow`·`_renderPreview`·`buildLaneGraph`·`_buildChanges`·`_rowEl`·`_applyStatus` 코드 50줄 이하 |
| TC-FR3-42 | e2e(기존, 이슈마다 `grep -rl` 로 고른다): FC-05 창 닫기·되돌리기·슬롯 · FC-12 `theme-seed`·설정 · FU-12 원격 잡·머리 · FU-13 `handle-size-hud`·폭 핸들 · FU-14~16 Git 변경 목록·히스토리 그래프·폴링. HEAD 와 같은 결과다 |

## 5. 동작 변경 기록

없다. 자리와 이름만 바꾼다(INV-R3-1·6). D-FR3-6·16 의 마이크로태스크는 드러나지 않는다.

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| `af16d851` | 이 SRS |
| `0d4af0dc` | 시험 고정 — `ws-apply-save.test.mjs` TC-FR3-1~26. 나누기 전 코드에서 GREEN 을 확인하고 커밋했다(D-FR3-1) |
| `94d73ccd` | FC-07 — `layout-tree.js` 에 `wsLiveTools`·`wsPinsKey`·`wsViewOf`·`wsViewRestore`(D-FR3-8), `WsSyncController` 에 `_reapDeadTools`·`_reconcileIncoming`·`_viewKeep`·`_mergeUnseen`·`_viewRestore`. `_applyRemoteWorkspace` 136 → 40줄(코드 66 → 22). 시험 TC-FR3-27(FC-07 셋)·`method-size.test.mjs`·`app-cmd-split.test.mjs`(D-FR3-7) |
| `18aa0a35` | FC-09 — `app.js` 의 `class App` 뒤에 `wsSaveBody`·`wsSaveSame`·`wsGitAdopt`·`wsSaveHoldMs`, App 에 `_savePut`·`_adoptRemote`·`_saveBackoff`. `save` 90 → 34줄(코드 43 → 23), `_saveAdoptRemote` 88 → 14줄(코드 30 → 10). 시험 TC-FR3-27(FC-09 넷)·`method-size.test.mjs` |
| `7a0390a1` | R3b 요구 — §2.3~2.7 · D-FR3-9~15 · TC-FR3-31~42 |
| `61f2e97b` | FC-05 시험 고정 — `del-window.test.mjs` TC-FR3-31~33. 나누기 전 코드에서 GREEN |
| `4a418d40` | FC-05 — `LayoutController` 에 `_delWinDirtyOk`·`_delWinAsk`·`_delWinTools`·`_delWinAfter`. `delWindow` 108 → 18줄(코드 56 → 13) |
| `26bafe55` | FC-12 — `settings-theme.js` 에 `themePreviewVars`·`themePreviewSwatches`·`THEME_PREVIEW_HTML`, `style.css` 의 `.pv-*` 규칙과 눈금 `--pv-fs-2xs`·`--pv-radius`. 인라인 `style=` 45 → 0, `_renderPreview` 코드 77 → 11. 시험 `theme-preview.test.mjs`(TC-FR3-34). 임시 e2e(TC-FR3-35)로 테마 넷(Tokyo Night·Dracula·GitHub Light·사용자 정의)의 86개 요소 계산된 스타일이 같고, 이름 있는 테마 셋은 스크린샷도 바이트까지 같다(사용자 정의의 스크린샷은 HEAD 끼리도 흔들린다) |
| `ccb4da87` | FU-12 — `git/remote-view.js` `GitRemoteView`(241줄). `remote.js` 704 → 482줄, 500줄 초과 12 → 11(`FE_MODULE_BOUNDARY_SRS` 기준선 갱신). `GitJobs` 가 `v.view.bind`·`bindHead`·`paintHead` 를 부른다. `PERFORMANCE_BUDGET.md` §2-5 두 행의 파일명. 시험 `git-job-outcome`(TC-FR3-36)·`git-job-labels`·`git-view` |
| `ed802920` | FU-13 — `ui/size-hud.js` `SizeHud` · `ui/size-drag.js` `SizeDrag`, `UIKit.drag` 는 입구. `ui-kit.js` 685 → 582줄. `index.html`·하네스 `HANDLE`·`PERFORMANCE_BUDGET.md` §2-5 한 행. 시험 `kit-handle.test.mjs`(TC-FR3-37) |
| `b40a3086` | FU-14 — `laneParentRows`·`LaneWalk`·`laneRows`. `buildLaneGraph` 코드 121 → 5. 시험 `lanes.test.mjs` 둘(TC-FR3-38). 무작위 DAG 2만 개(창 밖·위쪽·겹친 부모 포함)에서 옛 함수와 결과 JSON 이 같았다 |
| `47a00334` | FU-15·16 — `gitChangesHTML`·`_wireChangesBar`·`_groupEl`(`_buildChanges` 코드 73 → 22) · `gitRowTitle`·`gitRowActTitle`·`_rowActBtn`·`_rowWire`(`_rowEl` 60 → 28) · `gitStatusVerdict`·`_applyNetFail`·`_adoptObs`·`_paintObs`(`_applyStatus` 32 → 9). 시험 `git-parts-pure.test.mjs`(TC-FR3-39·40)·`method-size.test.mjs`(TC-FR3-41) |

**SRS 와 다르게 한 것.**

1. 적용기의 순수 판정 넷은 처음 정한 `ws-sync-controller.js` 머리가 아니라 `core/layout-tree.js` 에 두었다. 같은 파일에 두면 530줄이 되어 크기 게이트가 깨졌다. FR-FR3-1 을 고치고 D-FR3-8 을 더했다.
2. (R3b) `LaneWalk` 에 FR-FR3-17 의 목록 밖 메서드 `nextTarget(v)` 를 더했다 — `follow`·`run` 이 같은 식을 세 번 쓴다. `method-size.test.mjs` 는 TC-FR3-41 의 여섯에 `LaneWalk.follow` 를 더 지킨다.
3. (R3b) 시험 파일 이름: TC-FR3-36 은 새 파일이 아니라 `git-job-outcome.test.mjs` 에 더했다. 미리보기 견본은 고정 문자열을 싣는 때 한 번 만드는 함수(`themePreviewSwatches`)로 세웠다 — 견본 `title` 을 리터럴로 적으면 `literal-sweep` 의 툴팁 리터럴 검사와 줄 길이 검사에 걸렸다. D-FR3-16·17 을 구현 중에 더했다.

**시험 결과.** 단위 1426 통과. `make gates`·`typecheck` 통과. eslint 는 원래 2건(`theme-vars.js:86` · `claude-accounts-foot.test.mjs:728`)뿐이다. e2e(TC-FR3-29 의 13 spec, 165건)는 FC-07·FC-09 두 번 모두 실패 0 이다. `slot-view-state` TC-SVS-13·56 은 첫 회차(FC-07)에 실패했으나, 재시도 없이 나누기 전 코드(`0d4af0dc`)로 돌려도 같은 둘이 실패했다(HANDOFF_4 §4 의 흔들림). `tab-names` V-NAM-1·2·5 는 FC-09 회차에 재시도로 통과했고, 단독 2회 반복에서 34/34 통과했다.

**R3b 시험 결과.** 단위 1462 통과. `make gates`·`typecheck` 통과. eslint 는 원래 2건뿐이다. e2e 는 이슈마다 `grep -rl` 로 고른 spec 을 돌렸다 — FC-05 14 spec 187 통과 · FC-12 9 spec 122 통과 · FU-12 14 spec 135 통과, 1 실패(`git-ui-metrics` V80, 원래 실패) · FU-13 13 spec 231 통과, 흔들림 1(`activity-rail` TC-ACF-1) · FU-14~16 59 spec 777 통과, 2 실패(`git-ui-metrics` V80 · `ui-kit-icons` V-GAP-1, 둘 다 원래 실패) · 흔들림 3(`slot-view-state` TC-SVS-3·13·50). 원래 실패·흔들림은 `REFACTOR_PROD3_HANDOFF_4.md` §4 목록에 있다.

**남긴 것.** 저장 기계를 컨트롤러로 옮기는 일과 위임자 제거(§1.3). 100줄 남짓의 나머지 넷(`version-watch` 익명 126 · `_makeTab` 109 · `file-tree` constructor 104 · `_renderThemePanel` 100, D-FR3-14). `ui-kit.js`(582)·`git-poll.js`(718)는 여전히 500줄을 넘는다.
