# SRS: 리팩토링 3차 PROD3 FE 나머지 R2 — JS 작은 정리 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `refactor/PROD3.md` §2 FC-06·08·10·15·16·18·19·20·22 · FU-19 · FU-2~6 의 `cm-lsp` `unsubscribe`, §7.1 「P3 FE 나머지 — 정리」 의 하위 묶음 R2, `UIKit.tabsFitWatch`)
- 사용자 결정: 진행은 묻지 않고 끝까지 한다(`REFACTOR_PROD3_HANDOFF_2.md` §8). 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.
- 실측 기준: HEAD `cb679daf`. 아래 `파일:줄` 은 그 커밋의 것이다.

## 1. 개요

### 1.1 목적

R2 는 동작을 바꾸지 않는 JS 정리다. 큰 함수를 빌더로 나누고, 상수 파일 안의 함수를 쓰는 쪽으로 옮기고, 이름·리터럴·긴 줄을 규약에 맞춘다.

| 이슈 | 자리 | 지금 | 바꾸는 것 |
|---|---|---|---|
| FC-06 | `core/tool-controller.js:223` `_pickSandbox` | 155줄. 작업 폴더 줄·방식 고르기 줄·경고·프로파일 버튼·안내·등급 배지를 한 함수가 세운다 | 순수 판정 셋과 DOM 빌더로 나눈다 |
| FC-08 | `core/statusbar-controller.js:105` `updateStatusBar` | 122줄. 항목 열 가지를 한 함수가 만든다 | 항목 목록을 만드는 빌더로 나눈다 |
| FC-10 | `core/constants.js` (939줄) | 함수 9개가 상수 파일에 있다 | 쓰는 쪽 또는 알맞은 모듈로 옮긴다(§2.2 표) |
| FC-15 | `core/agents-controller.js:243-249` | 항목 배열을 `filter` 4번·`find` 1번으로 다섯 번 훑는다 | 한 번 훑어 구역 표로 가른다 |
| FC-16 | `core/statusbar-controller.js:271` `_bgModalToggle(open)` | 모달 시절 이름. `open===false` 분기는 부르는 곳이 없어 죽었다 | `_bgPanelOpen()` 으로 바꾸고 죽은 분기를 지운다 |
| FU-2~6 | `ui/cm-lsp.js:361` `unsubscribe` · `ui/ui-kit.js:183` `UIKit.tabsFitWatch` | 앱 안 호출 0 | `tabsFitWatch` 를 지운다. `unsubscribe` 는 남긴다(D-FR2-9) |
| FC-18 | `web/js` 198자 넘는 줄 17줄(10파일) | 한 줄에 문장 여럿·긴 표 | 읽을 수 있게 나눈다 |
| FC-19·20·22 | `*1000` 환산 · 파일별 타이밍 상수 · 숫자 리터럴 지연 · 툴팁 리터럴 | `constants*.js`·`TIP_*` 규약 밖 | 이름으로 모은다(§2.6 표) |
| FU-19 | JS 모달 폭 리터럴 9줄 | `UIKit.modal({width:'min(420px,90vw)'})` 처럼 폭을 JS 문자열로 박았다 | CSS 폭 클래스 |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 빌더 | 화면 조각 하나를 세워 돌려주는 메서드나 함수 |
| 순수 판정 | DOM 을 만지지 않고 입력만으로 답을 내는 함수 |
| 코드포인트 길이 | 줄의 글자 수. `[...line].length` 로 잰다(한글 한 자 = 1) |
| 서술자 표 | `{id,label,icon,title,…}` 처럼 한 항목의 이름·아이콘·툴팁을 함께 선언하는 객체(`GIT_VIEWS`·`SB_TAB_DEFS` 등) |

### 1.3 범위 밖

- 150자 넘고 198자 이하인 줄(75줄 중 나머지 58줄). D-FR2-10.
- `_runsModalToggle` 등 다른 모달 시절 이름. FC-16 은 `_bgModalToggle` 하나다.
- 위임자 제거(`Controller.delegate` 표를 걷는 일). `_bgModalToggle` 의 위임자만 이름과 함께 정리한다.
- 서술자 표 안의 `title`·`diag.js` 마크업 안의 `title`(D-FR2-13).
- CSS 간격·크기 토큰(R4).

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-R2-1 | 화면·DOM(태그·클래스·글자·속성·순서)·요청·저장 값이 그대로다. 툴팁 문장은 글자 하나 바뀌지 않는다 |
| INV-R2-2 | 시각이 그대로다. 모달 상자의 계산된 폭은 지금과 같다 |
| INV-R2-3 | 시간 값(밀리초)은 그대로다. 이름만 붙는다 |
| INV-R2-4 | 계층·로드 순서·크기(`check-file-size` 기준선 `500줄초과=12 · 최대=971`)·킷·i18n·server-driven 게이트를 지킨다. 줄면 기준선을 갱신한다 |
| INV-R2-5 | e2e·단위 시험·계약(`core/app-testing.js`)이 부르는 이름은 그대로 산다. 바꾸는 이름(`_bgModalToggle`)은 부르는 곳을 함께 고친다 |

## 2. 요구사항

### 2.1 FC-06·08 — 빌더 분리

| ID | 요구 |
|---|---|
| FR-FR2-1 | `tool-controller.js` 에 순수 판정 셋을 둔다: `sbxWorkPicks(list)`(프로파일들의 `workPicks` 를 방식으로 합친다, 서버 순서, 같은 방식은 첫 것), `sbxDefaultWork(list, picks)`(첫 프로파일의 방식 → `copies` 인 것 → 첫 것 → `null`), `sbxPickResult(p, work, workdir)`(프로파일 버튼을 누른 결과 `{profile,work,copies,workdir}`). 규칙은 지금 `_pickSandbox` 안의 식 그대로다 |
| FR-FR2-2 | `_pickSandbox` 의 DOM 은 빌더로 나눈다: 작업 폴더 줄(입력·지금 자리·최근 자리), 방식 고르기 줄, 프로파일 버튼(`actions`), 프로파일 정의 안내, 등급 배지. `_pickSandbox` 는 그것을 잇고 `UIKit.ask` 를 부른다. 함수 본문은 60줄 이하다 |
| FR-FR2-3 | `updateStatusBar` 는 항목 목록을 빌더(`_sbItems()`)에서 받아 `reconcileList` 에 넘긴다. 업타임 조각은 그 빌더의 하위 빌더(`_sbUptimeEl()`)다. 항목의 키·순서·마크업은 그대로다. `updateStatusBar` 본문은 30줄 이하다 |

### 2.2 FC-10 — 상수 파일의 함수 9개

| ID | 요구 |
|---|---|
| FR-FR2-4 | 아래 표대로 옮긴다. `constants.js` 에 `function` 선언이 남지 않는다(즉시 실행 화살표 `IS_MAC` 은 상수다) |

| 함수 | 부르는 곳 (HEAD, `web/js` 운영 코드) | 갈 곳 |
|---|---|---|
| `agentsWidthOk` | 0 | 지운다 (D-FR2-4) |
| `clampSidebarWidth` | `constants.js:380`(`sidebarWidthStore`) 1 | `ui/input-binding.js` |
| `sidebarWidthStore` | `ui/input-binding.js:188` 1 | `ui/input-binding.js` |
| `clampEntityName` (+ `ENTITY_NAME_MAX`) | `layout-groups.js` 2 · `layout-controller.js` 2 · `layout-tab-add.js` 2 · `repo-win-controller.js` · `chat-controller.js` · `repo-preview.js` · `app.js` · `chat-window.js` · `tool-cmd.js` — 13 | 새 `core/server-meta.js` (D-FR2-5) |
| `capToServer` (+ `serverMeta`) | `ui/file-tree-store.js` · `core/editor-open.js` · `core/editor-watch.js` — 3 (`serverMeta` 는 `statusbar-enc.js` 도) | `core/server-meta.js` |
| `applyServerMeta` | `core/app.js:160` 1 | `core/server-meta.js` |
| `sandboxWorkLabel` · `sandboxWorkTitle` | `core/tool-controller.js` 1 · 2 | `core/tool-controller.js` |
| `sbxRuntimeText` | `core/tool-controller.js` 2 | `core/tool-controller.js` |

| ID | 요구 |
|---|---|
| FR-FR2-5 | `core/server-meta.js` 는 `index.html` 에서 `constants.js` 바로 뒤에 싣는다. `META_API` 는 `constants.js` 에 남는다(경로 상수다). 단위 시험 `entity-name.test.mjs`·`server-meta.test.mjs` 는 새 파일을 싣는다 |

### 2.3 FC-15·16 · FU-2~6

| ID | 요구 |
|---|---|
| FR-FR2-6 | `agentsRender` 의 그리기 끝은 항목 배열을 한 번 훑어 구역 넷(`tabs`·`head`·`body`·`foot`)으로 가른다. `reconcileList` 는 받는 곳이 셋(`#agents-head`·몸통·바닥)이므로 세 번 그대로다. 각 받는 곳에 가는 항목과 순서(머리는 `tabs` 뒤 `head`)는 지금과 같다 |
| FR-FR2-7 | `_bgModalToggle(open)` 을 `_bgPanelOpen()` 으로 바꾼다. `open===false` 분기를 지운다. 단축키 `bgToggle`(`app.js:412`)은 `this.statusbar._bgPanelOpen()` 을 부르고, `Controller.delegate` 표에서 `_bgModalToggle` 을 뺀다(새 위임자를 두지 않는다). 시험 `app-controllers.test.mjs` 의 위임자 목록을 맞춘다 |
| FR-FR2-8 | `UIKit.tabsFitWatch` 를 지운다. `kit-dispose.test.mjs` 의 그 시험 둘을 지운다. `REFACTOR3_FE_BASE_SRS` FR-FEB-3·TC-FEB-2 아래에 개정 줄을 단다 |
| FR-FR2-9 | `ui/cm-lsp.js` 의 `unsubscribe` 는 남긴다. 주석에 부르는 자리(`cm.js` 의 `LSPClient.connect`·`disconnect`)를 적는다 |

### 2.4 FC-18 — 긴 줄

| ID | 요구 |
|---|---|
| FR-FR2-10 | `web/js` 에서 `i18n/`·`test/`·`vendor/`·`ui/themes.js` 를 뺀 `.js` 파일의 줄은 코드포인트 길이 198 이하다. 지금 넘는 17줄은 아래다 |
| FR-FR2-11 | 단위 시험이 FR-FR2-10 을 고정한다(넘는 줄이 하나라도 있으면 그 `파일:줄` 을 보이고 실패) |

| 파일:줄 | 길이 | 무엇 |
|---|---:|---|
| `core/agents-controller.js:443` | 229 | `dragstart` 처리기 한 줄 |
| `core/agents-controller.js:444` | 387 | `dragover` 처리기 한 줄 |
| `core/attn-center.js:76` | 202 | 머리 마크업 템플릿 |
| `core/constants.js:135` | 226 | `AGENT_STATE_LABEL` 표 |
| `core/layout-dnd.js:9` | 263 | `getDragZone` 한 줄 |
| `core/layout-dnd.js:10` | 232 | `showBodyDropIndicator` 한 줄 |
| `core/settings-presets.js:64` | 214 | 이름 입력의 `cssText` |
| `core/settings-theme.js:252` | 199 | 테마 미리보기 마크업 (줄을 태그 **안**에서 가른다 — 원소 사이에 공백 글자를 만들지 않는다) |
| `core/shortcuts.js:41` | 257 | `displayKey` 의 `replace` 열 개 |
| `core/theme-vars.js:10` | 388 | `UI_LABELS` 표 |
| `core/theme-vars.js:12` | 294 | `TERM_ANSI_LABELS` 표 |
| `ui/file-editor-find.js:58·65·66·67·221` | 262·213·215·209·212 | 버튼 마크업 문자열 잇기 |
| `ui/input-binding.js:59` | 206 | Activity 폭 복원 블록 |

### 2.5 FU-19 — 모달 폭

| ID | 요구 |
|---|---|
| FR-FR2-12 | `style-kit.css` 에 모달 상자 폭 클래스 셋을 둔다: `ui-modal-sm` = `min(420px,90vw)` · `ui-modal-md` = `min(460px,90vw)` · `ui-modal-lg` = `min(520px,90vw)`. 아래 9줄은 `width:` 대신 `boxCls:` 로 그 클래스를 준다. `KitModal` 의 `width` 선택지는 쓰는 곳이 없어지므로 지운다 |

| 파일:줄 | 지금 | 클래스 |
|---|---|---|
| `ui/open-url.js:74` | `min(520px,90vw)` | `ui-modal-lg` |
| `core/claude-accounts-controller.js:137` | `min(420px,90vw)` | `ui-modal-sm` |
| `core/claude-accounts-controller.js:192` | `min(520px,92vw)` | `ui-modal-lg` (D-FR2-12) |
| `core/settings-claude.js:95` | `min(420px,90vw)` | `ui-modal-sm` |
| `core/editor-doc.js:282·316` | `min(460px,90vw)` | `ui-modal-md` |
| `core/settings-access.js:171` | `min(460px,90vw)` | `ui-modal-md` |
| `core/settings-edges.js:154` | `min(420px,90vw)` | `ui-modal-sm` |

### 2.6 FC-19·20·22 — 시간·툴팁 리터럴 (전수)

세는 범위는 `web/js/{core,ui,git}` 에서 `i18n`·`vendor` 를 뺀 것이다.

| ID | 요구 |
|---|---|
| FR-FR2-13 | `constants.js` 에 `MS_PER_SEC=1000` 을 둔다. 초 ↔ 밀리초 환산은 그 이름을 쓴다. 대상은 정규식 `[*/] ?1000\b\|1000 ?\*` 에 걸리는 아래 24줄이다 |
| FR-FR2-14 | 한 파일 안에 있던 타이밍 상수는 `constants*.js` 로 옮긴다. 숫자 리터럴 지연(`after(N)`·`setTimeout(…,N)`·`setInterval(…,N)`, N≠0)과 지연의 덧셈 리터럴은 이름을 붙인다(아래 표) |
| FR-FR2-15 | 코드 안 툴팁 리터럴(`title:'…'`·`.title='…'`)은 `constants.js` 의 `TIP_*` 로 옮긴다. 같은 문장 두 자리는 이름 하나를 쓴다(아래 표). 서술자 표와 `diag.js` 는 남긴다(D-FR2-13) |

**`*1000` 환산 (24줄).**

| 파일:줄 | 식 | 처리 |
|---|---|---|
| `core/edges-controller.js:40` | `ms/1000` | `MS_PER_SEC` |
| `core/activity-list.js:77` | `LIMIT_STALE_MS=10*60*1000` | `constants.js` 로 옮기고 `10*60*MS_PER_SEC` |
| `core/activity-list.js:133` | `resetsAt*1000` | `MS_PER_SEC` |
| `core/state-registry.js:38` | `CLAUDE_ACCT_POLL_MS=30*1000` | 남긴다 (D-FR2-11) |
| `core/constants-git-detect.js:100` | `GIT_REPO_MISSING_POLL_MS/1000` | `MS_PER_SEC` |
| `core/claude-accounts-view.js:37·44·73·81·101·116·118·182·198` (9줄) | Unix 초 `*1000` · `Date.now()/1000` | `MS_PER_SEC` |
| `core/settings-claude-rows.js:53·156` | Unix 초 `*1000` | `MS_PER_SEC` |
| `ui/run-dashboard.js:41·50·153·488·497` | `Date.now()/1000` · `soonest*1000` · `ts*1000` | `MS_PER_SEC` |
| `ui/diag.js:66·103` | 경과 ms → 초 | `MS_PER_SEC` |
| `git/git-poll.js:426` | `age/1000` | `MS_PER_SEC` |

**타이밍 상수와 지연 리터럴.**

| 파일:줄 | 지금 | 처리 |
|---|---|---|
| `core/activity-list.js:77` | `LIMIT_STALE_MS` | `constants.js` |
| `core/settings-telegram.js:13` | `TG_PAIR_TICK_MS=2000` | `constants.js` |
| `core/settings-edges.js:16` | `EDGE_REMAIN_TICK_MS=1000` | `constants.js` |
| `ui/runs-panel.js:33` | `RUN_RECENT_SEC=30` | `constants.js` |
| `core/state-registry.js:38` | `CLAUDE_ACCT_POLL_MS` | 남긴다 (D-FR2-11) |
| `core/tool-search.js:32` | `after(50,…)` | `SEARCH_FIRST_DELAY_MS=50` (`constants.js`) |
| `ui/file-editor.js:611` | `after(500,…)` | `FILE_SAVE_FAIL_FLASH_MS=500` (`constants.js`, `FILE_SAVE_FAIL` 옆) |
| `ui/run-dashboard.js:50` | `+ 50` | `RUN_DECAY_SLACK_MS=50` (`constants.js`) |
| `ui/diag.js:196·205·269` | `setInterval(…,1000)` | 파일 머리의 `HOOK_RETRY_MS` (D-FR2-13) |
| `ui/diag.js:357` | `setTimeout(env,800)` | 파일 머리의 `ENV_DELAY_MS` (D-FR2-13) |

`setTimeout(…,0)`(다음 차례로 미루기, `timer-hub.js:225`·`diag.js:143·164`)은 지연 값이 아니라 대상이 아니다.

**툴팁 리터럴 (정규식 `\.title\s*=\s*['"\`]\|title:\s*['"\`][A-Za-z]\|setAttribute\(\s*['"]title['"]…\|\btitle="[A-Za-z]\|tip:\s*['"\`][A-Za-z]`, 31줄).**

| 파일:줄 | 문장 | 처리 |
|---|---|---|
| `core/edges-controller.js:161` · `core/chat-views.js:44` | Send an edge invite to this node | `TIP_EDGE_INVITE_SEND` |
| `core/edges-controller.js:165` · `core/settings-edges.js:141` | Send my name, node port and address to this edge | `TIP_EDGE_NOTIFY` |
| `core/edges-controller.js:198` | Make an edge with this node | `TIP_EDGE_INVITE_ACCEPT` |
| `core/edges-controller.js:200` | Discard this invite | `TIP_EDGE_INVITE_REJECT` |
| `core/activity-list.js:284` | Rate limits reported by the Claude Code statusLine | `TIP_LIMIT_STATUSLINE` |
| `core/chat-controller.js:101` | Create a group chat | `TIP_CHAT_NEW_GROUP` |
| `core/chat-controller.js:118` | More actions for this room | `TIP_CHAT_ROOM_MORE` |
| `core/chat-views.js:46` | Room actions | `TIP_CHAT_ROOM_ACTIONS` |
| `core/layout-dock.js:59` | Collapse the panel | `TIP_PANEL_COLLAPSE` |
| `core/settings-theme.js:47` | `'Hue '+h+'°'` (`title`·`aria-label`) | `TIP_THEME_HUE` 머리말 (`TIP_THEME_PREVIEW` 와 같은 꼴) |
| `core/constants-editor.js:328·329·346` · `core/constants-git.js:82-87` (9줄) | 서술자 표의 `title` | 남긴다 — 이미 상수 파일의 표다 |
| `ui/sidebar-tabs.js:64·149` · `ui/sidebar-tab-chat.js:11` | 탭 서술자의 `title` | 남긴다 (D-FR2-13) |
| `ui/diag.js:37-43` (7줄) | 진단 오버레이 마크업의 `title` | 남긴다 (D-FR2-13) |
| `core/layout-dock.js:63` · `core/agents-controller.js:318·376` · `core/settings-terminal.js:115·116` | 삼항식·도우미 인자 안의 툴팁(위 정규식이 못 잡는 꼴): Expand the panel · Close the panel · Expand/Collapse this window group · Move up · Move down · Delete macro | `TIP_PANEL_EXPAND`·`TIP_PANEL_CLOSE`·`TIP_AG_GROUP_EXPAND`·`TIP_AG_GROUP_COLLAPSE`·`TIP_KEYBAR_UP`·`TIP_KEYBAR_DOWN`·`TIP_KEYBAR_DEL` (구현 중 더 찾았다, §6) |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FR2-1 | `_pickSandbox` 의 판정(방식 합치기·기본 선택·누른 결과)은 클래스 밖 순수 함수로 뺀다. DOM 빌더는 컨트롤러 메서드로 둔다 | 판정은 DOM 없이 단위 시험으로 고정할 수 있다. 빌더는 `this._sbxRecent()`·`this.app._openSettings` 를 쓰므로 메서드여야 한다. 새 메서드는 위임자 표에 넣지 않는다 — 바깥이 부르지 않는다 |
| D-FR2-2 | `updateStatusBar` 의 빌더는 `StatusBarController` 메서드(`_sbItems`·`_sbUptimeEl`)다. 위임자를 더하지 않는다 | 시험이 덮어쓰는 이름은 `updateStatusBar` 뿐이다(HANDOFF_4 §4). 빌더는 컨트롤러 안에서만 불린다 |
| D-FR2-3 | FC-06·08 의 회귀 시험은 기존 e2e(`sandbox-pick`·`sandbox-window`·`sandbox-runtime` · `statusbar-xss`·`git-statusbar`·`status-bar-reflow`·`editor-encoding`·`editor-lsp-nav`)가 진다. 새 단위 시험은 뽑아낸 순수 판정만 본다 | 단위 하네스의 원소 대역은 레이아웃도 전파도 없다. DOM 결과의 동일성은 실제 브라우저가 더 정확히 본다 |
| D-FR2-4 | `agentsWidthOk` 은 지운다 | 운영·시험 호출이 0 이다. Activity 폭의 접기는 `input-binding.js:59` 가 `AGENTS_W_MIN_PX`·`AGENTS_W_MAX_PX` 로 직접 한다 |
| D-FR2-5 | 서버 상한(`ENTITY_NAME_MAX`·`serverMeta`)과 그 함수 셋은 새 파일 `core/server-meta.js` 로 간다 | 부르는 곳이 열여섯 파일에 흩어져 "쓰는 쪽" 하나가 없다. 둘 다 부팅 때 서버 답으로 채워지는 **상태**라 상수 파일에 둘 이유도 없다. 파일 하나 = 주제 하나(`GET /api/meta` 의 답) |
| D-FR2-6 | `clampSidebarWidth`·`sidebarWidthStore` 는 `ui/input-binding.js` 로 간다. 상수(`SIDEBAR_W_*`·`SIDEBAR_W_KEY`)는 `constants.js` 에 남는다 | 부르는 곳이 손잡이 하나다. 상수는 `index.html` 첫 페인트 스크립트의 주석과 `check-preinject.mjs` 가 `constants.js` 에서 찾는다 |
| D-FR2-7 | FC-15 는 훑기를 한 번으로 줄이고 `reconcileList` 세 번은 남긴다 | 받는 곳이 셋이다. 탭 줄 칠하기(`_actTabsPaint`)가 머리를 그린 뒤·몸통 전에 서야 하므로 표 순회로 셋을 묶으면 그 순서가 조건문으로 숨는다 |
| D-FR2-8 | `_bgModalToggle` 의 새 이름은 `_bgPanelOpen` 이고 위임자를 두지 않는다 | 이름을 지키던 주석(:263)의 이유는 "이 변경의 범위가 아니다" 였다 — e2e·계약·시험 덮어쓰기는 부르지 않는다(`grep -rn _bgModalToggle e2e web docs` 에서 운영 호출은 `app.js:412` 하나, 시험은 위임자 목록 하나). 단축키는 컨트롤러를 직접 부른다(HANDOFF_4 §4 — `app.js` 에 위임자를 더하지 않는다) |
| D-FR2-9 | `cm-lsp.js` `unsubscribe` 는 지우지 않는다 | 호출처 0 이 아니다. 번들 `vendor/codemirror/cm.js` 의 `LSPClient` 가 `connect` 에서 앞 transport 를, `disconnect` 에서 지금 transport 를 `transport.unsubscribe(this.receiveMessage)` 로 끊는다. 지우면 연결을 끊는 순간 `TypeError` 다. `REFACTOR3_FE_BASE_SRS` FR-FEB-2 의 판단과 같다 |
| D-FR2-10 | 긴 줄의 기준은 198 코드포인트다. 150~198 은 이번에 손대지 않는다 | PROD3 FC-18 이 문제 삼은 줄(198자)이 기준이다. 150자 넘는 줄 75줄은 대부분 긴 문장의 주석·`t()` 인자·SVG 경로다 — 나누면 grep 으로 찾기 어려워진다 |
| D-FR2-11 | `CLAUDE_ACCT_POLL_MS=30*1000` 은 `state-registry.js` 에 그대로 둔다 | 그 자리의 주석이 이유를 적었다: 등록부만 싣는 페이지(`e2e/sse-resilience.spec.ts`·`state-registry.test.mjs`)에서도 정의돼야 한다. 그 페이지는 `constants.js` 를 싣지 않으므로 `MS_PER_SEC` 도 쓸 수 없다 |
| D-FR2-12 | `min(520px,92vw)` 는 `ui-modal-lg`(`90vw`)로 합친다 | `.ui-modal-box` 의 `max-width:90vw` 가 이미 92vw 를 90vw 로 누른다. 계산된 폭은 같다(INV-R2-2) |
| D-FR2-13 | 서술자 표의 `title` 과 `diag.js` 의 리터럴은 남긴다. `diag.js` 의 지연은 파일 머리의 이름(`MAX` 와 같은 자리)으로 둔다 | 서술자 표는 이름·아이콘·툴팁을 한 항목으로 선언한다 — 툴팁만 떼면 한 탭의 정의가 두 자리로 갈린다. 상수 파일의 표(`GIT_VIEWS`·`REPO_SIDE`)는 이미 규약 안이다. `diag.js` 는 `?diag=1` 일 때만 도는 자체 완결 진단 오버레이다(파일 머리 — 테마 밖, WORDING_COLOR_SRS D-WRD-8). 그 값은 다른 곳이 쓰지 않는다 |
| D-FR2-14 | `KitModal` 의 `width` 선택지를 지운다 | 아홉 호출이 모두 클래스로 가면 쓰는 곳이 없다. 남기면 다음 사람이 다시 JS 로 폭을 박는다 |
| D-FR2-15 | 새 툴팁 상수는 `constants.js` 의 `TIP_*` 줄 끝에 더한다. git 쪽 `GIT_TIP_*` 는 건드리지 않는다 | 대상 열두 줄이 모두 git 밖(간선·채팅·Activity·레이아웃·테마)이다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FR2-1 | 단위(`sandbox-pick.test.mjs`): `sbxWorkPicks` 가 방식을 서버 순서로 합치고 같은 방식은 첫 것을 남긴다 · `workPicks` 가 없거나 배열이 아니면 건너뛴다. `sbxDefaultWork` 가 첫 프로파일 방식 → `copies` → 첫 것 → `null` 순으로 고른다. `sbxPickResult` 가 고른 방식을 받으면 그것, 아니면 프로파일 방식, 아니면 첫 것이고 고를 것이 없으면 `{work:p.work, copies:false, workdir:''}` 이다 |
| TC-FR2-2 | 단위(`server-meta.test.mjs`·`entity-name.test.mjs`): 새 파일을 실어 지금과 같은 단정이 지난다. 소스 검사: `constants.js` 에 `function` 선언이 없다 |
| TC-FR2-3 | 단위(`app-controllers.test.mjs`): 위임자 목록에 `_bgModalToggle` 이 없고 `StatusBarController.prototype._bgPanelOpen` 이 있다. 소스 검사: `_bgModalToggle` 이 `web/js` 에 없다 |
| TC-FR2-4 | 단위(`line-length.test.mjs`): FR-FR2-10 |
| TC-FR2-5 | 단위(`literal-sweep.test.mjs`): 소스 검사 — §2.6 의 정규식이 대상 파일에서 남긴 것(D-FR2-11·13) 말고 걸리지 않는다. `KitModal` 에 `width` 선택지가 없고 `web/js` 에 `width:'min(` 이 없다 |
| TC-FR2-6 | e2e(기존): D-FR2-3 의 spec 과 `activity*`·`agents*`·`settings*`·`edges-settings`·`peer-chat*`·`claude-accounts*`·`open-url*`·`editor-encoding`·`editor-conflict*`·`kit-components` 가운데 바뀐 파일을 부르는 것(`grep -rl`)이 모양을 바꾸지 않고 지난다 |
| TC-FR2-7 | 게이트: `make gates`·`npm run -s typecheck`·eslint(원래 2건 밖 새 경고 0) |

## 5. 동작 변경 기록

없다. 이 묶음은 이름·자리·줄 나눔만 바꾼다(INV-R2-1~3).

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| `903526b9` | 이 SRS |
| `7cfe190b` | FC-06·08 — `sbxWorkPicks`·`sbxDefaultWork`·`sbxPickResult`(순수) · `_sbxWorkdirRow`·`_sbxWorkRow`·`_sbxProfileAction`·`_sbxDevHint`·`_sbxGradeBadges`. `_pickSandbox` 155 → 41줄. `_sbItems`·`_sbUptimeEl`, `updateStatusBar` 122 → 22줄. 시험 `sandbox-pick.test.mjs`(TC-FR2-1 넷) |
| `49136bd7` | FC-10 — `core/server-meta.js`(`ENTITY_NAME_MAX`·`clampEntityName`·`serverMeta`·`capToServer`·`applyServerMeta`, `index.html` 에서 `constants.js` 뒤) · `clampSidebarWidth`·`sidebarWidthStore` → `ui/input-binding.js` · `sandboxWorkLabel`·`sandboxWorkTitle`·`sbxRuntimeText` → `core/tool-controller.js` · `agentsWidthOk` 삭제. `constants.js` 939 → 869줄. 시험 `server-meta.test.mjs`(TC-FR2-2)·`entity-name.test.mjs`·`chat-window.test.mjs` 가 새 파일을 싣는다 |
| `854590b2` | FC-15·16 · FU-2~6 — `agentsRender` 의 구역 표 `zone`(한 번 훑기) · `_bgPanelOpen`(단축키가 `this.statusbar._bgPanelOpen()`, 위임자 없음) · `UIKit.tabsFitWatch` 삭제 · `cm-lsp` `unsubscribe` 주석에 부르는 자리. `REFACTOR3_FE_BASE_SRS` FR-FEB-3 개정 줄. 시험 `app-controllers.test.mjs`·`kit-dispose.test.mjs`(TC-FR2-3) |
| `7cd0bb29` | FC-18 — 17줄 나눔. 시험 `line-length.test.mjs`(TC-FR2-4) |
| `b3fe9935` | FC-19·20·22 — `MS_PER_SEC`, 24줄 환산 · `LIMIT_STALE_MS`·`TG_PAIR_TICK_MS`·`EDGE_REMAIN_TICK_MS`·`RUN_RECENT_SEC` → `constants.js` · `SEARCH_FIRST_DELAY_MS`·`FILE_SAVE_FAIL_FLASH_MS`·`RUN_DECAY_SLACK_MS` · `diag.js` 머리의 `HOOK_RETRY_MS`·`ENV_DELAY_MS` · `TIP_*` 열일곱. 시험 `literal-sweep.test.mjs`(TC-FR2-5 넷), 단위 시험 다섯의 전역 대역에 새 이름 |
| `324d7922` | FU-19 — `style-kit.css` `.ui-modal-box.ui-modal-sm·md·lg`, 9줄이 `boxCls`, `KitModal` 의 `width` 삭제. 시험 `literal-sweep.test.mjs`(TC-FR2-5). 임시 e2e 로 계산된 폭이 옛 인라인 폭과 같음을 1280·400 폭에서 쟀다(420/460/520/520 · 360×4) |

**SRS 와 다르게 한 것.**

1. `FILE_SAVE_FAIL_FLASH_MS` 는 `constants-editor.js` 가 아니라 `constants.js` 의 `FILE_SAVE_FAIL` 옆에 두었다 — 그 문구가 거기 있다. §2.6 표를 고쳤다.
2. 툴팁 리터럴을 일곱 더 옮겼다(§2.6 표 끝 행). `TIP_PANEL_COLLAPSE` 를 만들고 보니 같은 버튼의 반대 문장(`Expand the panel`)이 삼항식에 남아 있었다. 그런 꼴(삼항식·도우미 인자)을 따로 찾아 다섯 줄(상수 일곱)을 옮겼다. 정규식이 못 잡는 꼴이라 TC-FR2-5 는 그 다섯 줄을 고정하지 않는다.
3. `RUN_DECAY_SLACK_MS`·`RUN_RECENT_SEC` 는 `constants.js` 의 Run 목록 구역에 두었다.

**남긴 것.** `CLAUDE_ACCT_POLL_MS`(D-FR2-11) · 서술자 표·`diag.js` 의 툴팁(D-FR2-13) · `cm-lsp` `unsubscribe`(D-FR2-9) · 150~198자 줄 58줄(D-FR2-10). 위임자 표를 걷는 일은 다음 리팩토링이다.
