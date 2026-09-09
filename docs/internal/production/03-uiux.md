# 03 — UI/UX · 접근성 · 시각 디자인 · 인터랙션 감사

대상: `/Users/dykim/personal/dongminal/web` (vanilla JS + CSS, 빌드 없음)
방식: read-only. `index.html`, 6개 CSS, `js/ui/*`, `js/core/*`, `js/git/{confirm,dialog,menu,history}.js` 를 읽고, `docs/images/{terminal,git,settings}.png` 를 실제로 열어 확인했다. 아래 모든 발견은 `파일:라인` 근거를 단다. 확인하지 않은 것은 "미확인" 으로 표기했다.

우선순위 정의: P0 = 사용 불가·데이터 손실급 / P1 = 실사용에서 명확한 마찰 / P2 = 품질 개선.

---

## 0. 요약

| 등급 | 건수 |
|---|---|
| P0 | 0 |
| P1 | 8 |
| P2 | 18 |

P0 는 없다. 파괴적 git 동작(reset·stash drop·force checkout)은 서버 정책 기반 확인창(`GitConfirm`)이 취소를 기본으로, `Enter`≠실행으로 막고 있어 데이터 손실 경로가 보호된다. 다만 **같은 앱 안의 다른 확인창(`_confirmClose`)은 정반대 규약**이고, **창 삭제 `×` 는 확인 없이 세션을 kill** 하므로 그 둘을 P1 최상단에 두었다.

접근성 총평: 마우스·단축키 사용자에게는 잘 다듬어져 있으나, **키보드 Tab 순회와 스크린리더 기준으로는 대부분의 목록·탭·카드가 `div` 이고 포커스 불가**하며 라이브 리전이 0 개다. 설정 모달은 `role="dialog"` 도 포커스 이동도 없다.

디자인 시스템 총평: 색 토큰(`--bg`·`--accent`…)과 크기 토큰(`--ui-btn-h`…)이 `style-kit.css` 로 정리되기 시작했으나, 정의되지 않은 토큰(`--bg-alt`)을 4곳이 참조하고, 위험색·구분선·상태색이 Tokyo Night 값으로 하드코딩되어 나머지 43개 테마에서 어긋난다.

---

## 1. P1 발견

### [P1] 확인창 두 벌의 `Enter` 규약이 정반대 — 실행 중 프로세스를 `Enter` 한 번으로 kill
- **위치**: `web/js/core/app-tool.js:366-392` (`_confirmClose`), 대조: `web/js/git/confirm.js:203-210`, `web/js/git/dialog.js:191-201`
- **현상**: `_confirmClose` 는 초기 포커스를 위험 버튼(`.confirm-ok` "닫기" 또는 `.confirm-save`)에 두고(`:382`), `Enter` 를 **실행(닫기)** 으로 처리한다(`:384`). 같은 앱의 `GitConfirm` 은 "초기 포커스는 취소, `Enter` 의 기본 동작도 취소"(`confirm.js:18-20`, `:203-210`)를 명시적 규약으로 둔다. 창·탭 닫기에서 "실행 중인 프로세스가 있습니다" 를 물을 때(`app-layout.js:200`, `:567`) 사용자가 반사적으로 `Enter` 를 치면 프로세스가 죽는다.
- **영향**: Git 화면에서 익힌 "Enter 는 안전" 근육기억이 터미널 닫기에서 배신당한다. 되돌릴 수 없다(kill).
- **조치**: `_confirmClose` 를 `GitConfirm`/`GitDialog` 규약에 맞춘다 — 초기 포커스 `.confirm-cancel`, `Enter`=취소(또는 최소한 포커스된 버튼만 활성화), 위험 버튼은 클릭/Space. 가능하면 `UIKit.modal` 위에 세워 골격을 하나로 줄인다.
- **규모**: S

### [P1] 창 `×` 는 확인 없이 세션을 kill 하고 되돌릴 길이 없다
- **위치**: `web/js/core/app-layout.js:167-215`, `web/js/ui/sidebar-list.js:130-139`, `web/style.css:79-85`
- **현상**: `delWindow` 는 dirty 편집기(`:188`) 또는 busy 프로세스(`:199`)가 있을 때만 묻고, 한가한 셸이면 즉시 `_kill`(`:210`) 후 목록에서 지운다. `×` 는 hover 시에만 나타나는(`style.css:83-84` `opacity:0`) 16px 아이콘이고 hit 영역은 30px 이다. Undo 는 없다(git 커밋의 `git-undo-toast` 와 대비 — `js/git/commit.js:437-443`).
- **영향**: 셸의 스크롤백·작업 디렉터리·환경이 클릭 한 번에 사라진다. 모바일에서는 `×` 가 항상 보이고(`style.css:1134`) 24px 이라 행 탭과 오탭이 쉽다.
- **조치**: (a) 창 삭제에 짧은 Undo 토스트(5초, 서버에서 kill 을 지연) 또는 (b) 탭 2개 이상/셸 외 프로세스일 때 항상 확인. 최소한 `×` 를 `<button>` 으로 바꾸고 `:focus-within` 에서도 보이게.
- **규모**: M

### [P1] 설정 모달에 다이얼로그 시맨틱·포커스 관리가 없다
- **위치**: `web/index.html:212-235`, `web/js/core/app-settings.js:445-484`
- **현상**: `#modal-overlay` 는 `role="dialog"`·`aria-modal`·`aria-labelledby` 가 없다. 열 때 포커스를 모달 안으로 옮기지 않고(`:448-475`), 닫을 때 원래 자리로 돌려놓지 않으며, 포커스 트랩이 없어 `Tab` 이 뒤의 사이드바·터미널로 빠진다. 탭 버튼 `.mtab` 은 `role="tab"`/`aria-selected` 없이 `style.display` 토글(`:479-484`). `Escape` 리스너는 `document` 전역(`:478`)이라 그 위에 뜬 `GitDialog`/`UIKit.modal` 과 중첩 시 둘이 함께 닫힐 수 있다(각자 `capture:true` 로 `stopPropagation` 하므로 대체로 막히지만 순서 의존적 — 미확인).
- **영향**: 키보드 사용자는 모달을 열어도 포커스가 어디 있는지 모르고, 스크린리더는 모달이 열렸다는 사실을 알지 못한다.
- **조치**: `role="dialog" aria-modal="true" aria-labelledby=".modal-title"`, open 시 첫 탭 버튼 `focus()`, close 시 `#settings-btn` 으로 복귀, `Tab` 순환 트랩. `.mtab` 에 `role="tablist"/"tab"`, `.mpanel` 에 `role="tabpanel"`. 같은 조치를 `UIKit.modal`(`ui-kit.js:139-189`)에도 — 그곳이 "상자를 만드는 한 자리" 인데 시맨틱이 없다.
- **규모**: M

### [P1] 목록·탭·카드가 전부 `div` — Tab 키로 도달 불가, 스크린리더에 보이지 않음
- **위치**:
  - 사이드바 항목: `web/js/ui/sidebar-list.js:97` (`div.sbl-item`), `×` 는 `span` (`:131`)
  - 분할 칸 탭: `web/js/ui/renderer.js:894` (`div.pn-tab`), 닫기 `span.pn-tab-x` (`:896`)
  - 탐색기 행: `web/js/ui/file-tree-paint.js:597` (`div.ed-row`), 키 이벤트는 인라인 입력에만(`:638`)
  - 에이전트 카드·그룹: `web/js/core/app-agents.js:214-234`, `:260`
  - 알림 센터 항목: `web/js/core/app-attn.js:349-355`
  - 컨텍스트 메뉴 항목: `web/js/ui/ui-kit.js:211` (`div.ui-menu-item`, `role` 없음, 화살표 이동 없음) — 대조: `js/git/menu.js:397-415` 는 ↑/↓/Enter 를 구현
- **현상**: `tabIndex` 는 코드베이스 전체에 3곳(`doc-render.js:246`, `file-editor.js:188`, `app-mobile.js:222`)뿐. `aria-*` 사용 파일 15개 중 대부분이 아이콘 버튼 `aria-label` 이다. `role` 은 `ui-kit.js:104`(tab)·`confirm.js:171`·`dialog.js:156` 세 곳.
- **영향**: 단축키(`Ctrl+Shift+]`, `Ctrl+Tab` 등)가 있어 키보드만으로 "동작" 은 가능하지만, 단축키를 모르는 사용자는 Tab 으로 창 목록·탭·파일 트리에 닿을 수 없다. 스크린리더는 목록의 존재 자체를 읽지 못한다. 탐색기 파일 열기는 `Cmd+P` 없이는 키보드로 불가능하다.
- **조치**: 단계적으로 — (1) 클릭 가능한 `div` 에 `tabindex="0"` + `role`(`listbox/option`, `tablist/tab`, `tree/treeitem`, `menu/menuitem`) + `Enter/Space` 활성화 + 화살표 이동을 `SidebarList._build`·`Renderer._makeTab`·`FileTree._el` 세 팩토리에 한 번씩만 넣는다(이미 "만드는 자리 하나" 구조라 비용이 낮다). (2) `×` 는 `UIKit.button({icon:'x',title})` 로 교체(팩토리가 `aria-label` 을 자동으로 붙인다 — `ui-kit.js:82`). (3) `UIKit.menu` 에 `GitMenu` 의 키 처리(`menu.js:397-415`)를 옮겨 두 메뉴를 하나로.
- **규모**: L

### [P1] 정의되지 않은 토큰 `--bg-alt` 를 4곳이 참조 — 배경이 투명으로 떨어진다
- **위치**: 사용: `web/style.css:137` (`.sbx-progress`), `web/style.css:531` (`.ag-group`), `web/style-git.css:557`, `web/style-git-views.css:80`. 정의: 없음 — `style.css:11-40` `:root` 에도, `js/core/helpers.js:198-217` `applyThemeObj` 의 변수 맵에도 없다. `style-docrender.css:16,63,154` 만 `var(--bg-alt,var(--bg))` 폴백을 쓴다.
- **현상**: `background:var(--bg-alt)` 는 무효 → 배경 없음. `.sbx-progress` 는 화면 하단에 `position:fixed` 로 떠 있는 진행 배너(NFR-SPK-2)인데 배경이 투명이라 아래 터미널 글자와 겹쳐 읽히지 않는다. 에이전트 패널의 창 그룹 머리(`.ag-group`)도 카드와 구분되지 않는다.
- **영향**: 샌드박스 복사 진행 안내가 실질적으로 안 보인다. 에이전트 패널 정보 구조가 평평해진다.
- **조치**: `applyThemeObj` 에 `'--bg-alt': mixHex(ui.bg, ui.sidebarBg, .5)` 류로 파생값을 추가하고 `:root` 에 첫 페인트용 기본값을 둔다. 또는 네 자리를 `var(--sidebar-bg)` 로 바꾼다. CSS 린트(예: stylelint `custom-property-no-missing-var-function` 류 또는 간단한 grep 테스트)로 재발을 막는다.
- **규모**: S

### [P1] 보조 텍스트 색 대비가 WCAG 기준에 크게 미달
- **위치**: 기본 팔레트 `web/style.css:12-14`; 사용처 `.ds-hint`(`style.css:942`, `--text-dim`, 11px), `.ui-hint`(`style-kit.css:167`), `.sbl-x`·`.pn-tab-x`(`--text-dim`), `.tbtn`·`.ui-btn` 기본 글자(`--text-muted`, `style-kit.css:55`), `#window-name`(`style.css:313`), `#m-pane-indicator`(`:1047`)
- **현상**: Tokyo Night 기준 실측 대비(계산):
  - `--text-dim #414868` / `--bg #1a1b26` = **1.91:1**
  - `--text-muted #565f89` / `--bg` = **2.76:1**, / `--sidebar-bg` = 2.91:1
  - 참고: `--text` 8.10:1, `--accent` 6.79:1, `--attn` 8.55:1 (양호)
  설정 패널의 모든 설명문(`.ds-hint`, 수십 개)과 툴바 버튼의 기본 글자가 AA(4.5:1)·AA Large(3:1) 모두 미달. 스크린샷 `settings.png` 에서도 하단 안내문과 비활성 탭 라벨이 흐리게 보인다.
- **영향**: 저시력·밝은 환경·저품질 모니터에서 설정 설명을 읽지 못한다. 이 앱은 설정 설명이 곧 매뉴얼이다(README 가 "Settings ▸ …" 로 안내).
- **조치**: 테마 팔레트를 건드리지 않고 **용도별 파생 토큰**을 둔다 — `--text-hint: mixHex(ui.textMuted, ui.text, .5)` 를 `applyThemeObj` 에서 계산해 최소 4.5:1 을 보장(대비가 모자라면 `ui.text` 쪽으로 더 섬). `.ds-hint`·`.ui-hint`·버튼 기본 글자를 그 토큰으로 옮긴다. 44개 테마 전부에 대해 대비를 계산하는 스크립트를 테스트에 추가.
- **규모**: M

### [P1] 모바일 터치 타겟이 44px 하한에 미달하는 자리 다수
- **위치**: `web/style.css:1139` (`.pn-tab-x` 18px), `:1134` (`.sbl-x` 24px), `:1108` (`.mkb-btn` height 30px), `:1041` (`.mtbtn` 30×26), `web/style-editor.css:149-152` (`.ed-row` height 22px — `body.mobile` 오버라이드 없음), `web/style-git-views.css:384` (`.git-repo-xslot` 24px)
- **현상**: 모바일 전용 규칙이 있는 곳(`.sbl-item` 40px, `.runs-row` 44px `style-git-views.css:961`, `GitConfirm` 버튼 `padding:12px`)은 배려가 있으나, 탭 닫기·탐색기 행·키바 버튼은 하한 미달. `.ed-row` 22px 은 폴더 트리를 손가락으로 조작하기 어렵다.
- **영향**: 아이패드/휴대폰(README 의 명시 사용 시나리오)에서 탭 닫기 오탭, 파일 트리 오선택.
- **조치**: `body.mobile .ed-row{height:36px}`, `.pn-tab-x`/`.sbl-x` 는 시각 크기는 두고 `min-width/min-height:44px` 의 히트 박스(`.sbl-x` 가 데스크톱에서 이미 쓰는 `--sbl-hit` 기법 `style.css:63,80`)를 모바일에도 적용, `.mkb-btn` 높이 38→44 로 `--m-kb-h` 조정.
- **규모**: S

### [P1] 사용자 피드백이 스크린리더에 전달되지 않음 — 라이브 리전 0 개, 알림 채널 4종 분산
- **위치**: `aria-live`/`role="status"` 검색 결과 0 (`index.html`, `js/**`). 채널: `Toast`(`js/ui/toast.js`, 사용처 `term-pane.js:691` 단 1곳, 우하단), `.git-undo-toast`(`style-git.css:372`, 하단 중앙), `.sbx-progress`(`style.css:136`, 하단 중앙 고정), 탐색기 인라인 `_fail`(`file-tree-paint.js:671`), 부팅 단계 `#boot-step`(`index.html:104`), 연결 오버레이 `.tp-overlay`(`term-pane.js:615-617`)
- **현상**: 같은 "알림" 이 자리·수명·색 규약이 다른 4개 컴포넌트로 나뉘어 있고, 어느 것도 `aria-live` 가 없다. `Toast` 는 재사용 가능한 API 인데 한 파일만 쓴다.
- **영향**: 시각 사용자도 "알림이 어디 뜨는지" 를 매번 다른 자리에서 찾는다. 스크린리더 사용자는 업로드 성공/실패, 재연결, 커밋 Undo 기회를 전혀 듣지 못한다.
- **조치**: `Toast` 호스트에 `role="status" aria-live="polite"`, 오류는 `aria-live="assertive"`. `.git-undo-toast` 를 `Toast.show(text,'ok',5000)` + 액션 버튼 옵션으로 흡수, `.sbx-progress` 도 `Toast` 진행형(`ms:0`)으로. `#boot-step` 에 `aria-live="polite"`.
- **규모**: M

---

## 2. P2 발견

### 2.1 접근성 (5건)

#### [P2] `<html lang="en">` 인데 UI 대부분이 한국어
- **위치**: `web/index.html:2`; 본문 문구 예 `index.html:104,251,254,268-339`
- **현상/영향**: 스크린리더가 한국어를 영어 음성 엔진으로 읽는다. 브라우저 자동 번역 제안도 어긋난다.
- **조치**: `lang="ko"`. 영어 툴팁이 섞이면 해당 요소에 `lang="en"` 을 붙이는 편이 정확하다(아래 언어 혼용 항목 참조).
- **규모**: S

#### [P2] 검색 입력에 라벨 없음
- **위치**: `web/index.html:192` (`placeholder="검색..."` 만 있음)
- **조치**: `aria-label="터미널 검색"`. `#search-count` 에 `aria-live="polite"` 를 주면 "3/12" 가 읽힌다.
- **규모**: S

#### [P2] 시각 전용 정보: CSS `content` 문구·색만으로 전달되는 상태
- **위치**: `web/style.css:376` (`.slot-empty>.slot-body::after{content:'사이드바에서 창을 고르세요'}`), `:772` (`'Drop files here'`), `:818` (`'클릭하여 포커스'`); git 상태색 `style-editor.css:192-194`(수정=accent·추가=초록·삭제=danger 색만)
- **현상/영향**: `::after` 텍스트는 대부분의 스크린리더에서 읽히지 않거나 불안정하고 i18n 불가. 탐색기의 git 상태는 색 외 표식이 없다(`?`/`M` 같은 글자 마크는 Git 패널에만 — `git.png` 스크린샷 확인).
- **조치**: 빈 슬롯 문구는 DOM 텍스트로; 탐색기 행에 `title` 또는 `.ed-mark` 에 상태 글자(M/A/D) 추가.
- **규모**: S

#### [P2] `prefers-reduced-motion` 이 일부 애니메이션만 덮는다
- **위치**: 덮는 곳: `web/style.css:1291-1295` (부팅), `:1414` (attn-edge), `web/style-git-views.css:1111-1115` (attn 맥박). 덮지 않는 곳: `style.css:578-579` (`sr-spin` 무한 회전), `:737-738` (`sc-pulse`), `:1057` (드로어 `transform .22s`), `:1063` (`#drawer-backdrop`), `:810` (`.tp-overlay opacity .3s`), `:1165` (`.pn-drop-indicator transition:all`).
- **조치**: 전역 `@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}` 한 줄 + 부팅 바처럼 정지 대체가 필요한 것만 개별 규칙 유지.
- **규모**: S

#### [P2] 포커스 표시가 키트 밖 컨트롤에는 없다
- **위치**: `outline:none` 17곳 vs `:focus-visible` 9곳 (CSS 전체 grep). 예: `.rename-input`(`style.css:74`), `.search-bar input`(`:758`), `.sbx-input`(`:1216`), `.acl-row input`(`:1236`) — `border-color` 변화만으로 포커스를 표시(대비 낮음).
- **조치**: `.ui-input:focus-visible` 규칙 하나로 통일하고 각 입력에 `ui-input` 클래스를 병기.
- **규모**: S

### 2.2 디자인 시스템 일관성 (6건)

#### [P2] 위험색·상태색이 Tokyo Night 값으로 하드코딩되어 테마를 무시
- **위치**: `web/style-kit.css:84-85,149` (`rgba(247,118,142,…)` = Tokyo Night `#f7768e`), `web/style.css:85,907-908`, `web/style-git-views.css:952,956,1143,1148`; `style.css:845` (`.sb-dot.ok{background:#4caf50}`); `style.css:30` (`--git-st-add:#9ece6a` — `applyThemeObj` 가 세우지 않음, `helpers.js:198-217`); `style-git-views.css:998` (`.run-view{--run-ok:#9ece6a}`); `style-editor.css:364` (`.tc-copy-do{color:#16161e}`)
- **현상/영향**: Dracula(`danger #ff5555`)·Gruvbox(`#fb4934`)·라이트 11종에서 위험 버튼의 배경 틴트가 글자색과 다른 계열이 된다. 상태바 "연결됨" 점의 초록과 git 추가 초록이 테마와 무관하게 고정.
- **조치**: `applyThemeObj` 에 `--danger-subtle: hexToRgba(ui.danger,.12)`, `--danger-active: hexToRgba(ui.danger,.2)`, `--ok: terminal.green`, `--git-st-add: terminal.green` 추가. `themes.js` 각 테마는 이미 `terminal.green` 을 갖고 있다.
- **규모**: S

#### [P2] 라이트 테마에서 사라지는 구분선
- **위치**: `web/style.css:728,853,929`, `web/style-kit.css:158` (`border-bottom:1px solid rgba(255,255,255,.03)`)
- **현상/영향**: 흰 배경 위 3% 흰색 = 보이지 않음. 설정 행 구분이 라이트 11종에서 사라진다. `themes.js` 는 `mode:'light'` 를 알고 있으나 CSS 가 그 사실을 쓰지 않는다.
- **조치**: `--row-sep: hexToRgba(ui.text,.06)` 토큰으로 교체.
- **규모**: S

#### [P2] 모달/오버레이 골격 7벌, z-index 스택 비체계
- **위치**: `#modal-overlay`(`style.css:590`, z100), `.ui-modal`(`style-kit.css:114`, z200), `.confirm-overlay`(`style.css:886`, z200), `.bg-modal`(`style.css:1195`, z200), `.gc-modal`(`style-git-views.css:391`, z300), `.git-dialog`(`style-git.css:210`), `.runs-modal`(`style-git-views.css:913`); 그 외 `.ui-menu` z3000, `.toast-host` z420, `#ui-size-hud` z450, `#focus-edge` z500, `#attn-edge` z501, `#boot` z1000, diag z9997/9999. z-index 값 28종.
- **현상/영향**: 설정 모달(z100)이 `.ui-modal`(z200)보다 아래 — 설정 안에서 `UIKit.modal`(`app-settings.js:985`)을 띄우면 의도대로 위에 오지만 반대 순서는 불가. 각 골격이 `rgba(0,0,0,.6)`+`blur(2px)`+`box-shadow 0 8px 32px` 를 반복 선언(5회 이상).
- **조치**: `--z-modal/--z-menu/--z-toast/--z-overlay` 토큰 4~5개로 계층을 선언하고, `.confirm-overlay`·`.bg-modal`·`.runs-modal` 을 `.ui-modal` 위에 세운다(`UIKit.modal` 이 이미 그 목적). 백드롭 색도 `--backdrop` 토큰으로.
- **규모**: L

#### [P2] 버튼 외형 선언이 키트 밖에 6벌 이상 남아 있다
- **위치**: `.tbtn`(`style.css:338-342`), `.mtbtn`(`:1038-1045`), `.sc-key`(`:731-737`), `.ds-toggle`(`:946-952`), `.preset-btn`(`:878-884`), `.sbx-now/.sbx-recent-item/.sbx-work-opt/.sbx-settings`(`:102-143`), `.gc-cancel/.gc-go`(`style-git-views.css:430-434`), `.git-br-new`(`:465-469`), `.git-undo-btn`(`style-git.css:379-383`)
- **현상/영향**: 같은 "테두리 1px·반경 4px·hover accent" 를 자리마다 다시 적어 값이 조금씩 갈린다(반경 3/4/5/6px, 높이 22/24/26/30px). `style-kit.css` 머리말이 "기존 클래스를 지우지 않는다(D-5)" 로 의도한 과도기이지만 종료 조건이 없다.
- **조치**: e2e 가 짚는 클래스명은 유지하되 선언은 `.ui-btn` 상속으로 비운다(`.tbtn{}` 빈 규칙). 반경·높이는 `--ui-radius`·`--ui-btn-h*` 로.
- **규모**: M

#### [P2] 글자 크기 12종이 토큰 없이 산재
- **위치**: CSS 전체 `font-size` 분포 — 11px 180회, 12px 91, 10px 52, 13px 16, 14px 15, 9px 8, 8px 3, 7px 1, 11.5px 1, 15/18/20px. 토큰은 `--ui-font:11px`(`style-kit.css:26`)와 `--sb-rail-fs:9px`(`style.css:39`) 둘.
- **현상/영향**: 7~9px 은 테마 미리보기(`style.css:697-703`)라 정당하지만, 본문 10px(`.ce-item label`, `.sbx-flag`, `.acl-state`, `.preset-desc`)은 가독성 하한 아래다.
- **조치**: `--fs-xs:10 / --fs-sm:11 / --fs-md:12 / --fs-lg:13 / --fs-xl:14` 다섯으로 수렴, 10px 본문은 11px 로.
- **규모**: M

#### [P2] 시스템 다크/라이트 추종 없음
- **위치**: `prefers-color-scheme`·`matchMedia` 검색 결과 0 (`js/**`, `*.css`). 테마 데이터는 `mode:'dark'|'light'` 를 가진다(`js/ui/themes.js:7,12,…`).
- **조치**: 설정 ▸ Theme 에 "시스템 따라가기(다크 테마 / 라이트 테마 각 1개 지정)" 옵션. 첫 페인트 선주입(`index.html:34`)이 캐시 맵을 그대로 세우므로 두 맵을 캐시하면 깜빡임 없이 가능.
- **규모**: M

### 2.3 정보 구조 · 문구 (3건)

#### [P2] 한국어·영어 혼용이 같은 화면 안에서 규칙 없이 섞인다
- **위치**:
  - 툴바: `Split H / Split V / Runs / Background / Agents`(`index.html:166-184`) vs 상태바 `연결됨`(`terminal.png`), 슬롯 빈 문구 한국어(`style.css:376`)
  - Display 패널 한 화면: `페이지 제목`·`슬롯 방향`(`index.html:268,274`) vs `Display Mode`·`Mobile Breakpoint (px)`(`:286,294`)
  - 버튼 라벨 한국어 + 툴팁 영어: `닫기` + `title="Close this tool and end its session"`(`app-tool.js:369`, `constants.js:330-333`), `취소` + `"Close without running anything"`(`constants-git.js:559`), 사이드바 `New/Add/Preset`(`index.html:123-137`) + 한국어 힌트
  - 상수 표: `GIT_LOADING_HINT='불러오는 중…'`(`constants-git.js:187`) vs `GIT_TIP_RETRY='Try loading this list again'`(`:464`)
- **현상**: 주석(`app-agents.js:241-242`, `sidebar-tabs.js:37`, `app-mobile.js:190`)은 "툴팁은 영어" 를 의도(FR-TIP-2)로 적었지만, 라벨은 한국어·영어가 화면 단위로 갈린다.
- **영향**: 처음 보는 사용자가 "Runs" 가 무엇인지 라벨로 알 수 없고(툴팁 `Run orchestration` 도 영어), 같은 패널에서 언어가 바뀌면 번역 누락으로 읽힌다.
- **조치**: 규칙을 하나로 — (권장) 라벨·툴팁·힌트 모두 한국어, 고유명사(Git·Split·Slot)만 영어. 문자열이 이미 `constants*.js` 에 모여 있어 표 하나만 고치면 된다. 최소 조치로는 Display 패널 두 행과 툴바 `Runs/Background` 를 한국어로.
- **규모**: M

#### [P2] 툴팁의 단축키 표기가 정적 — 재바인딩하면 거짓이 된다
- **위치**: `web/index.html:166-167,179,181` (`title="Split Horizontal (Ctrl+Shift+H)"` 등 4곳); `renderer.js`·`app-slots.js` 에 title 갱신 코드 없음(grep). 단축키는 설정에서 전부 변경 가능(`helpers.js:237-267`, README).
- **조치**: `_rTopbar` 에서 `displayKey(shortcuts.splitH)` 로 title 을 다시 쓴다. `SHORTCUT_LABELS`(`helpers.js:283-307`)와 버튼 id 를 한 표로 묶으면 한 자리.
- **규모**: S

#### [P2] 단축키 발견 가능성 — 화면 안 진입점이 설정 ▸ Shortcuts 하나
- **위치**: `web/index.html:220`(설정 탭), `SHORTCUT_LABELS`(`helpers.js:283-307`, 30여 개)
- **현상**: 탭 바·사이드바·컨텍스트 메뉴 어디에도 키 힌트가 없다. `GitMenu`/`UIKit.menu` 항목에 단축키 열이 없다. `?` 로 치트시트를 띄우는 길이 없다.
- **조치**: `Ctrl+/` 또는 `?` 에 읽기 전용 치트시트 모달(`SHORTCUT_LABELS`+`shortcuts` 를 그대로 그리면 데이터는 이미 있다). 메뉴 항목에 `kbd` 열.
- **규모**: S

### 2.4 인터랙션 · 마이크로 (4건)

#### [P2] 드래그 가능한 요소에 사전 어포던스가 없다
- **위치**: `cursor:grab/move` 검색 0 (CSS 전체). draggable: 탭 `renderer.js:897`, 탐색기 행 `file-tree-paint.js:612`, 사이드바 항목 `sidebar-list.js:203`, 에이전트 카드(`.ag-card.dragging` `style.css:541`)
- **현상/영향**: 드롭 존 표시(`.pn-drop-indicator` `style.css:1161-1171`, `.ed-drop` `style-editor.css:220-224`, `.drop-into` `style.css:1152`)는 잘 되어 있으나, "끌 수 있다" 는 사실은 끌어 보기 전엔 알 수 없다. README 가 이 기능을 설명하는 유일한 자리.
- **조치**: `.pn-tab:active`, `.sbl-item:active`, `.ed-row:active` 에 `cursor:grabbing`; hover 시 좌측 6px 그립 점(`⋮⋮`) 페이드인.
- **규모**: S

#### [P2] 탭 줄 오버플로가 보이지 않는다
- **위치**: `web/style.css:410-415` (`.pn-tabs{overflow-x:auto}` + `::-webkit-scrollbar{height:0}`)
- **현상/영향**: 탭이 폭을 넘어도 스크롤바가 없고 페이드/화살표도 없어 잘린 탭의 존재를 알 수 없다. 탭 고정폭 옵션 힌트(`index.html:307`)가 "가로로 스크롤합니다" 라고 말하지만 시각 단서가 없다.
- **조치**: 양 끝 `mask-image` 페이드(6~12px) 또는 넘칠 때만 `‹ ›` 버튼. 휠 세로 스크롤을 가로로 변환(`wheel` → `scrollLeft`).
- **규모**: S

#### [P2] 파일 삭제는 "영구" 인데 되돌릴 길이 없다
- **위치**: `web/js/ui/file-tree-edit.js:193-211`, `web/js/core/app-editor.js:1007-1023` (`EDITOR_DEL_PERMANENT` 문구로 경고), 대조: git 커밋 Undo `js/git/commit.js:437-443`
- **현상**: 확인창은 개수·dirty 탭까지 세어 보이고(우수) 기본 포커스도 안전한 쪽이지만, 실행 후 복구 수단이 없다. 서버가 `~/.dongminal/` 을 갖고 있어 휴지통 구현 여지는 있다.
- **조치**: 서버 측 `trash/`(24h 보관) + 삭제 직후 Undo 토스트. 규모가 크면 최소한 git 저장소 안이면 "`git checkout -- <path>` 로 되돌릴 수 있습니다" 힌트를 `GitConfirm` 의 recovery hint 처럼 표시.
- **규모**: M (힌트만이면 S)

#### [P2] 컨텍스트 메뉴 두 벌의 동작이 다르다
- **위치**: `web/js/ui/ui-kit.js:199-255` (`UIKit.menu` — Esc·바깥 클릭·스크롤 닫힘, 키 이동 없음) vs `web/js/git/menu.js:340-415` (`GitMenu` — ↑/↓/Enter/Esc, disabled 건너뜀). 탐색기 우클릭은 `GitMenu.openList`(`file-tree-xfer.js:185`).
- **영향**: 어떤 메뉴는 화살표로 움직이고 어떤 메뉴는 안 움직인다. `ui-kit.js` 머리말이 정확히 이런 분산을 없애려던 취지(`ui-kit.js:4-6`).
- **조치**: `GitMenu` 를 `UIKit.menu` 의 얇은 어댑터로 바꾸고 키 처리는 키트로.
- **규모**: M

---

## 3. 항목별 점검 결과 (요청 8축)

### 3.1 접근성
- 시맨틱: 정적 마크업(`index.html`)은 `<button>` 을 잘 쓴다. 동적 목록·탭·카드·메뉴는 `div`(P1 참조).
- `aria-*`: 아이콘 버튼 `aria-label` 은 `UIKit.button` 이 강제(`ui-kit.js:72,82` — 이름 없는 버튼은 throw). 다이얼로그 시맨틱은 `GitConfirm`/`GitDialog` 두 곳만(`confirm.js:171`, `dialog.js:156`).
- 포커스 관리: `GitConfirm`(`confirm.js:305-308`)·`GitDialog`(`dialog.js:335-343`)·`_confirmClose`(`app-tool.js:382`)·샌드박스 선택(`app-tool.js:362`)은 초기 포커스를 준다. 설정 모달·`UIKit.modal`·`bg-modal`·`attn-center` 는 없다. 포커스 복귀(닫은 뒤 원래 자리)는 어디에도 없다.
- 키보드 도달성: 단축키 체계는 풍부(30여 개, 전부 재바인딩 가능 `helpers.js:237-267`). Tab 순회는 정적 버튼·입력에 한정.
- `tabindex` 남용: 없음(3곳, 적절).
- `prefers-reduced-motion`: 부분 대응(P2).
- 색상 대비: 보조 텍스트 미달(P1).
- 라이브 리전: 없음(P1).

### 3.2 디자인 시스템
- 토큰: 색 10 + 파생 8(`helpers.js:198-217`), 크기 10(`style-kit.css:17-35`). 우회: `--bg-alt` 미정의(P1), 위험색·상태색·구분선 하드코딩(P2), 폰트 크기 미토큰(P2).
- 중복: 모달 7벌·버튼 6벌(P2). 파일 간 책임: `style.css` 머리말이 "네 파일의 link 순서가 캐스케이드" 라고 명시(`style.css:6-7`) — 순서 의존이 곧 결함 표면. `style-kit.css` 가 그것을 풀기 시작했으나 `!important` 가 `style.css` 에 9개 남아 있다(`:1030-1035,1077,1130,827`).
- 테마 누락: `mode:'light'` 를 CSS 가 소비하지 않음(P2 구분선), `rgba(0,0,0,.6)` 백드롭은 라이트에서도 무난.

### 3.3 반응형/모바일
- 구조: `body.mobile` 클래스 + 사용자 설정 Breakpoint(`index.html:286-297`) — 미디어쿼리 대신 JS 판정. 드로어(`style.css:1051-1064`), 키바(`:1096-1116`), pane 순회(`app-mobile.js:86-98`), 소프트 키보드 보정(`app-mobile.js:359-424`, `viewport interactive-widget` `index.html:9`)은 실측 기반으로 정교하다.
- 깨지는 지점: 터치 타겟(P1). Git 창 7탭이 390px 에서 `padding:0 6px;font-size:12px`(`style.css:1136-1138`) — 들어가긴 하나 여백 없음. 설정 모달은 `min(760px,94vw)`·탭 줄 `flex-wrap`(`style.css:610,641`)으로 가로 스크롤 방지 ✓.
- 가로 스크롤: `html,body{overflow:hidden}`(`style.css:42`)로 페이지 단위는 봉쇄. 내부는 `.pn-tabs`(P2)·`.modal-body{overflow-x:hidden}` ✓.

### 3.4 사용자 피드백
- 로딩: 텍스트형("불러오는 중…" `constants-git.js:187,898`, "Loading editor…" `file-editor.js:202`, "그리는 중…" `constants-docrender.js:40`). 스켈레톤/스피너 없음 — 터미널 도구 성격상 허용 범위. 부팅 화면은 불확정 진행바(`index.html:101-104`) ✓. 사이드바 리포 목록은 "아직 모름 vs 없음" 을 구분(`sidebar-list.js:58-60`) ✓.
- 에러: 코드→문구 표(`GIT_WRITE_ERR` `constants-git-actions.js:15-30`, `EDITOR_FS_ERR_MSG` `constants-editor.js:435-443`) ✓. git 실패는 stderr tail + 복사 버튼(`confirm.js:288-291`) ✓. 업로드 실패는 항목별 재시도/건너뛰기/중단(`file-tree-xfer.js:109-129`) ✓. 복구 안내는 git 만 있고 파일 삭제엔 없음(P2).
- Toast 일관성: 1곳만 사용(P1).
- 위험 동작: git — 서버 정책(`/api/git/policy`) 기반 판정, 모르면 파괴적으로 간주(`confirm.js:78-82`), 개수+목록+recovery hint 동시 표시(`confirm.js:244-291`) — **모범 사례**. 백그라운드 도구 kill 은 행 안 인라인 확인(`app-statusbar.js:255-268`) ✓. Run 삭제 인라인 확인(`runs-panel.js:193-204`) ✓. 창/탭 닫기는 P1.

### 3.5 빈 상태 · 첫 실행
- 부팅: 정적 마크업 + 테마 선주입으로 FOUC 없음(`index.html:27-34,83-106`), 6초 상한(`constants.js:36`) ✓.
- 첫 창: 창이 없으면 자동 생성(`app.js:206,212`) — 사용자는 바로 셸을 본다(`terminal.png`). 터미널 안에 안내는 없다.
- 빈 목록: Repo 탭 `+ Add 로 경로를 추가하세요`(`constants-editor.js:31`) ✓; Windows 탭은 `emptyText` 미지정(`sidebar-tabs.js:47-101`) — 창은 항상 1개 이상이므로 실질 문제 없음. 편집기 빈 화면 `탐색기에서 파일을 열면 여기에 나타납니다`(`constants-editor.js:44`) ✓. 에이전트 패널 `활동 중인 에이전트 없음`(`app-agents.js:254`) — "어떻게 나타나게 하는지" 안내 없음(README 는 "설정이 필요 없다" 고 함 → 문구에 그 사실을 넣으면 좋다).
- 슬롯 빈 상태 문구는 CSS `content`(P2).

### 3.6 정보 구조
- 사이드바 탭 2개(Windows / Repo) — Git+Editor 통합 근거가 주석에 명확(`sidebar-tabs.js:105-115`). 접힌 레일에서 이름 2줄 클램프(`style.css:262-266`) ✓.
- 설정 모달 탭 11개(`index.html:219-234`) — Theme·Shortcuts·Status Bar·Polling·Presets·Display·Code·Notifications·Access·Sandbox·Backup. 한 줄에 서도록 폭을 넓혔지만(`style.css:596-608`) 11개는 많다. "Polling" 과 "Notifications" 의 에이전트 주기, "Display" 의 알림 가장자리(`index.html:331-338`)처럼 경계가 섞인 항목이 있다. 그룹화(일반/화면/알림/고급) 제안 — 규모 M.
- 라벨 일관성: 언어 혼용(P2).

### 3.7 성능 체감
- History: 행 높이 기반 윈도잉 + 오버스캔(`history.js:584-600`) ✓, 스크롤 끝 페이지 로드(`:1228-1236`) ✓.
- Diff: Monaco DiffEditor(`diff-view.js:232`), 폭에 따라 inline 전환(`:76`) ✓. 서버가 `too_large`/`binary` 를 가른다(`constants-git.js:725`) ✓.
- Console: `GIT_CON_LIMIT=500`(`constants-git.js:759`) ✓.
- 터미널: scrollback 50000(`constants.js:246`) — 분할 칸 여러 개 × 50k 는 메모리 부담 가능(미측정). 폴링은 숨은 탭에서 멈춤(`index.html:380` 힌트).
- 탐색기: 폴더 단위 로드 + 잘림 표시(`file-tree-paint.js:576-580`) ✓.
- 결론: 성능 관련 P1/P2 발견 없음.

### 3.8 마이크로 인터랙션
- 트랜지션: 짧고 절제됨(.1~.22s). 드래그 크기 HUD(`ui-kit.js:356-387`)는 px·cols·% 를 보여 주는 드문 배려 ✓.
- 드래그 어포던스: 사전 단서 없음(P2). 드롭 표식 ✓. 스프링 로딩 폴더 펼침(`file-tree-xfer.js:341-352`) ✓.
- 호버: `.sbl-x`·`.pn-tab-x` hover 전용(P1 항목에 포함). 모바일은 항상 표시로 보정 ✓.
- 알림 맥박은 표식 속성만 움직여 글자를 흔들지 않음(`style.css:451-489`) ✓.

---

## 4. 잘 되어 있는 것 (유지 권고)

1. 파괴적 git 확인의 설계 — 정책 서버 소유, 취소 기본, `Enter`≠실행, 영향 목록+복구 힌트+stderr 복사(`confirm.js` 전체).
2. `UIKit.button` 이 이름 없는 아이콘 버튼을 **만들지 못하게** 함(`ui-kit.js:72`).
3. 아이콘 스프라이트 `currentColor` 로 44개 테마 자동 대응(`index.html:37-82`, `style-kit.css:40-44`).
4. 부팅 화면의 FOUC 제거와 reduced-motion 대체(`index.html:24-34`, `style.css:1289-1295`).
5. 닫기 전 dirty·busy 이중 가드와 "실행 중인 것만 백그라운드로" 선택지(`app-layout.js:188-206`).
6. 모바일 소프트 키보드 보정의 실측 주석(`index.html:5-8`, `app-mobile.js:342-424`).
7. 힛 영역 하한을 두 목록에 같게 맞춘 결정(`style.css:77-80`).

---

## 5. 권장 착수 순서

1. (S) `--bg-alt` 정의 · `_confirmClose` Enter 규약 통일 · `lang="ko"` · 검색 입력 라벨 — 반나절.
2. (M) 설정 모달·`UIKit.modal` 다이얼로그 시맨틱+포커스 관리 — 이후 모든 모달이 상속.
3. (M) `--text-hint` 파생 토큰으로 대비 확보 + 위험색/구분선 토큰화 — `applyThemeObj` 한 함수.
4. (M) 창 삭제 Undo 또는 확인.
5. (L) 목록·탭·트리 팩토리 3곳에 `role`/`tabindex`/키 이동 — 접근성의 본체.
6. (S) 모바일 터치 타겟, 툴팁 단축키 동기화, 탭 줄 오버플로 표식.
