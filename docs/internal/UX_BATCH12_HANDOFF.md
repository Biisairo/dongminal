# 인계: UX_BATCH12 이어가기 (2026-11-11, 세 번째 세션으로)

## 1. 착수 블록 — 이번 세션의 지시 전부

1. `docs/internal/UX_BATCH12_SRS.md` 의 **§0 요구사항 대장**을 읽는다. 남은 행은 **R18 → R21 → R22 → R20 → R19** 순서다(R21·R22 는 2026-11-11 마지막에 더한 결함·요구다).
2. 행마다 순서는 고정이다: 스펙(SRS 를 먼저 고친다) → 실패하는 테스트(RED 확인) → 구현 → 관련 테스트 통과 → 대장 상태 고침 → **커밋**.
3. 사용자 지시: "요구사항을 다 완료할 때까지 이어서 커밋하고 진행해." 검증을 통과하면 스스로 커밋한다. 커밋에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
4. **R20·R19 는 질의응답으로 규칙을 정한 뒤 진행한다** (사용자 지시). 질문은 한 번에 하나, 권장안과 함께.
5. 모든 행이 끝나면 회귀 검사(§5)를 돌리고 사용자에게 보고한다.

## 2. 어디까지 왔나

작업 트리는 깨끗하다(`git status`). 이 묶음의 커밋:

| 커밋 | 내용 |
|---|---|
| `e54c3be3` | SRS·RUN_VIEW_LIVE 스펙 |
| `ab92a69c` | R3 Run 대시보드 실시간 |
| `333c3c14` | R10 서브에이전트 목록 고정 |
| `546d5429` | R6~R8 미니맵·휠 줌 |
| `ef7ffa74` | R9·R13·R14 Explorer 다중 우클릭·단축키·끌어 내려받기 |
| `7ae36872` | R11 사각형 선택 |
| `794b94b8` | R17 에이전트 카드 하이라이트 |
| `0eaafc23` | R12 포커스 탭 하이라이트 (`core/app-focus-hl.js`) |
| `d8d8869b` | R5 일부 FR-LIV-7~10 |
| `b7a04c94` | R5 나머지 FR-LIV-1~6 (설정 ETag·If-Match, `core/settings-live.js`) |

## 3. R18 — Activity 패널 접기 (다음에 할 일)

요구(대장 R18): Activity 패널을 메인 좌측 패널(사이드바)처럼 완전히 닫지 않고 좁게 접는다. 상단바 Activity 버튼을 지운다. 접힘 상태는 **창 레이아웃 저장**에 함께 들어가야 한다(사용자가 "주의해서 확인" 하라고 했다).

사용자 결정(2026-11-11): 접힌 레일에는 구역 아이콘(Agents·Runs·Background)을 두고, **아이콘을 누르면 그 구역으로 펼친다**. 사이드바 레일(눌러도 펼치지 않음, FR-SBC-17)과 다르다. 사용자 덧붙임 원문 "이미 메인 패널은 그룹에서 폴더를 지원하고있다" 는 뜻이 분명하지 않다 — **구현 전에 사용자에게 뜻을 확인한다.** 모바일 서랍의 Activity 버튼(`#m-drawer-acts`)은 남긴다.

### 이미 확인한 사실 (조사 결과, 다시 조사하지 마라)

- 사이드바 접기: `<html>.sb-collapsed`, `setSidebarCollapsed(on)`(`core/app-layout.js:973`), `_toggleSidebar`(`:982`), 키 `sidebarToggle`=Ctrl+Shift+E. 레일 폭 `--sb-rail-w` 40px(`style.css:215·429-431`). 펼치는 길은 `#sb-handle` 끌기(임계 `SIDEBAR_COLLAPSE_AT_PX=70`, `ui/input-binding.js:149-185`)와 키. 저장은 `PrefStore.session` `sidebarCollapsed`. 첫 페인트는 `index.html:43` 인라인.
- Activity: 상태는 `#agents-panel.open`(`_agentsPanelOpen()`, `core/app-agents.js:94`), 토글 `agentsToggle()`(`:75-87`, session `agentsPanelOpen`, 열 때 `_actRefresh`), 구역 진입 `actPanelOpen(key)`(`core/app-activity.js:191`), 키 `agentsToggle`=Ctrl+Shift+A. 상단바 버튼 `#agents-toggle`(`index.html:221`, 배선 `input-binding.js:45·47`), 패널 머리 닫기 `.ag-close`(`app-agents.js:325`). 닫히면 `display:none`(`style.css:793-797`), 손잡이 `#agents-handle` 도 숨는다.
- `.open` 에 기대는 곳: `state-registry.js` 의 `tool.activity`·`run.list`·`tool.background` 주기 `when`, `agentsRender()` 게이트(`app-agents.js:166`), `app-dock.js:65` `_layoutState`. 권장 설계: `.open` 은 "펼침" 그대로 두고 레일은 별도 클래스로 둔다(주기·그리기 게이트를 덜 건드린다).
- 레이아웃 저장(`core/panel-layout.js`, PANEL_LAYOUT_SRS): 모양 `{v:1, dock, repoSide, sidebar:{ratio,collapsed}, repoSideW, activity:{ratio,open}}`. 접힘 필드를 넣으려면 `layoutParse`(`:46-68`)·`layoutCapture`(`:70-86`)·`layoutSeedEntries`(`:88-106`)·`layoutFromLegacy`(`:108-127`)·`app-dock.js` `_layoutState`(`:58-73`)를 함께 고친다. 단위 `panel-layout.test.mjs`.
- 도크(PANEL_DOCK_SRS): `data-ag-side` 로 좌우가 바뀐다. 사이드바 레일의 오른쪽 규칙(`style.css:807-808`)과 대칭인 규칙이 Activity 에 필요하다. Activity 가 닫혀 폭 0 이면 드롭 순서를 정하지 않는다(FR-PDK-32) — 레일이면 폭이 있다.
- 바뀌어야 할 시험(버튼 `#agents-toggle` 을 직접 쓴다): `activity.spec.ts`, `background-ui.spec.ts`(TC-SBR-5·TC-CHR-18·TC-ACT-4 등), `window-slots.spec.ts` TC-WSL-21c(상단바 마지막 버튼), `mobile-keybar.spec.ts:502-505`, `panel-layout.spec.ts` `arrange()`, `panel-dock.spec.ts` PDK3, 단위 `width-handle.test.mjs:25-26`. 관련 SRS: SIDEBAR_COLLAPSE_SRS, PANEL_LAYOUT_SRS, PANEL_DOCK_SRS, UIUX_OVERHAUL_SRS FR-CHR-15~18, ACTIVITY_RUNS_REFRESH_SRS FR-ARR-4·5, PANEL_SHORTCUTS_SRS FR-PSC-3.
- 문서-코드 어긋남(작업 끝에 사용자에게 보고): `core/constants.js:294` 주석과 SIDEBAR_COLLAPSE_SRS FR-SBC-4 가 "localStorage" 라고 하나 코드는 sessionStorage 다. UIUX_OVERHAUL_SRS FR-ACT-3 은 철회됐다.

## 3a. R21·R22 (조사 전)

- R21 알람 끄기: 알람 판정의 자리는 `core/app-attn.js`(`_isToolFocusedActive`, 알람 억제는 FR-SVS-13·ATTENTION_FIRING_SRS FR-ATA-2·7). "포커스를 그 탭으로 옮기는 동작"이 알람을 지우는 길을 찾는다 — 지금은 탭 화면 클릭만 지운다. 포커스 이동의 단일 통로는 `switchTab`(`core/app-layout.js:789`)·`setFocusState`·창 전환이다. 이미 포커스가 있는 탭은 지금처럼 클릭으로 지운다.
- R22 그룹 삼각형: Windows 사이드바 목록(`ui/sidebar-list.js`)의 그룹 접기 단추. 빠른 클릭(더블클릭)으로 글자 선택이 생기는 것으로 보인다 — `user-select:none` 또는 mousedown 기본 동작 막기를 확인한다.

## 4. 이 묶음에서 배운 것

- 전체 e2e 는 14분이다 — **관련 스펙만** 돌린다. 도구 제한 10분.
- JS 500줄·최대 줄 게이트(`FE_MODULE_BOUNDARY_SRS §7.1`): 넘으면 파일을 나눈다(이번에 `file-tree-keys.js`·`file-tree-download.js`·`file-tree-marquee.js` 를 나눴다). 좋아지면 기준선을 그 값으로 갱신하라고 게이트가 실패시킨다.
- `ui/`·`git/` 은 App 의 `_` 이름을 부를 수 없다(계층 게이트) — 공개 이름으로 올린다.
- eslint: 지역 이름 `t` 금지(i18n 함수를 가린다). z-index 는 `var(--z-*)` 층 변수만.
- `decisions.md` 는 생성물 — SRS 를 고치면 `go run ./scripts/gen-decisions`.
- e2e 에서 가짜 활동(`testing.onToolActivity`)은 칸 추가·패널 열기 같은 재조회 뒤에 다시 넣어야 한다.
- `editor-ops` O7(이동 뒤 재조회 수)은 여러 스펙을 함께 돌릴 때 가끔 흔들린다(단독 6/6 통과). 이번 변경과 무관.
- `httpErr` 의 오류 코드는 본문이 아니라 헤더(`apierr.CodeHeader`)로 간다. peer 종단은 본문 JSON.

## 5. 변하지 않는 규약

- 회귀 검사: `make unit`, `make gates`, `make lint`, `npm run typecheck --silent`, `go vet ./... && go test ./...`, 바꾼 곳의 e2e 스펙만.
- 스펙과 코드가 충돌하면 멈추고 묻는다. 동작이 바뀌면 이전/새/이유를 SRS 에 적는다.
- 사용자의 dongminal 을 재시작하지 않는다.
