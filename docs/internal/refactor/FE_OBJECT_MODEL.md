# 프론트 객체 모델 — 설계안 (리팩토링 3차 P3a)

> 2026-11-21 · `main` · 기준 커밋 `56dffed0`
> 출발점: `PROD3.md` P3a. **사용자 지시:** 단순히 파일을 나누는 것이 아니라, 다른 프레임워크처럼 각 구조를 클래스로 만들고 상속받아 나눠 쓰고 다시 쓰는 구조를 만든다. 파일도 클래스 단위로(클래스 하나 = 파일 하나) 정리한다.
> 이 문서는 **설계안**이다. 사용자 확인 뒤 단계마다 SRS 를 쓰고 구현한다. 개수는 grep 표본이고, `?` 는 추측이다.

## 1. 지금 모양

- `web/js` 는 약 61k 줄이고 모듈이 아니다. `index.html` 이 `<script>` 를 순서대로 싣고, 최상위 이름을 전역으로 서로 본다.
- 주류는 mixin 이다. `Object.assign(App.prototype, …)` 가 68개 파일이고, `Object.assign(GitPanel.prototype, …)` 가 6~8개 파일이다.
  - 단계 9 완료(2026-11-21, `REFACTOR3_FE_APPCTL_SRS`): `Object.assign(App.prototype, …)` 는 0 이다. App 은 주제별 `Controller` 를 드는 조립자이고, 바깥이 부르는 이름은 위임자 표로 남는다. (`GitPanel` 의 mixin 은 단계 7 에서 0 이 됐다.)
- 이미 있는 기반은 다음과 같다.
  - `UIKit`(객체 리터럴 930줄): `tab`·`button`·`modal`·`menu`·`dialogOpen`·`roving`·`tabsFit`·`fadeWatch`
  - `reconcileList`(호출 약 20곳)
  - 상속을 이미 쓰는 클래스: `GitModalBase`(`GitDialog`·`GitConfirm` 의 부모), `GitListTab`(`GitSubmodules`·`GitWorktrees` 의 부모)
  - 수명 도구: `GitObserver`, `TimerHub.disposeOwner`, `EventBus.disposeOwner`
- 한 파일에 클래스가 둘 이상인 곳: `git/remote.js`(4) · `git/branches-dialogs.js`(3) · `git/stash-dialogs.js`·`git/tag.js`·`git/worktrees.js`·`ui/cm-lsp.js`(각 2).
- 수명 메서드 이름이 여섯 가지다: `mount`·`destroy`·`dispose`·`close`·`detach`·`unmount`. `mount` 의 뜻도 파일마다 다르다.
- 해제 경로가 없는 것: `UIKit.tabsFitWatch` 의 ResizeObserver, `UIKit.roving` 의 keydown.

## 2. 같은 종류의 부품 — 계열

| # | 계열 | 지금 구현 자리(표본) | 공통 / 다른 것 | 기반 클래스 | 위험 |
|---|---|---|---|---|---|
| 1 | 패널 열림·닫힘 | `app-agents.js:104` `setAgentsPanelOpen` · `app-mobile.js:19` `_toggleDrawer` · `app-mobile-sheets.js:44` · `app-settings.js:437` · `'open'` 토글 6파일 | 열림 판정·Esc 닫기·모바일 시트 연동이 같다. 상태가 필드·body 클래스·DOM 클래스 세 곳에 따로 있다 | `Panel` → `SidebarPanel`·`ActivityPanel`·`DrawerSheet` | M |
| 2 | 탭 줄 | `sidebar-tabs.js` `SidebarTabs` ↔ `app-activity.js` `_actTab*` | 서술자·단추를 한 번 만들기·활성/배지 그리기·라벨 맞춤·직행 키가 같다. 영속 키·스크롤 보관 방식(요소 vs Map)·점 배지·`onEnter/onLeave` 가 다르다 | `TabBar` → `SidebarTabBar`·`ActivityTabBar` | M |
| 3 | 목록 | `repaint.js:66` `reconcileList` 와 호출 약 20곳 · `sidebar-list.js` 서술자 · `git/list-tab.js` | 키·서명·빌드·빈 줄이 같다. 서명 규약·빈 문구·키보드 배선이 다르다 | `ListView` → `SidebarList`·`GitListTab` | M |
| 4 | 대화상자·확인창 | `UIKit.modal` 19곳 · `UIKit.dialogOpen` 2곳 · `GitModalBase` 하위 2 · 손으로 짠 것(`term-pane.js:600`·`app-claude-accounts.js:427`) | 여는 순서·포커스 복귀·닫는 길 셋·실행 상태기계가 같다 | `Dialog` → `ConfirmDialog`(=`GitConfirm`)·`FormDialog`(=`GitDialog`)·`SettingsModal` | M |
| 5 | 메뉴 | `UIKit.menu` 13곳 · `git/menu.js` `GitMenu`(선언형) | 열기·화살표·Esc 가 같다. GitMenu 는 데이터 층이다 | `Menu`(GitMenu 는 그 위의 데이터 층, 합치지 않는다) | M |
| 6 | 설정 섹션·행 | `core/app-settings*.js` 14파일 · `settings-schema.js` | 선언(schema)은 있고, 그리기·저장 배선이 파일마다 다르다 `?` | `SettingsSection` → 섹션별 · `FormRow` | H |
| 7 | git 탭 뷰(폴링) | `list-tab.js`·`stash.js`·`branches.js`·`history.js`·`remote.js`·`console.js`·`commit.js` 의 `mount/unmount` · `_adopt` 5곳 · 저장소 가드 12곳 | 마운트·언마운트·저장소가 바뀌면 다시 받기·세대 가드가 같다. 세대 가드가 세 종류다 | `GitView` → 탭 여섯(`GitListTab` 은 그 하위) | M |
| 8 | 툴바·머리 단추 | `list-tab.js:50`·`stash.js:57` 의 문자열 조립 | 버튼 모양·툴팁 | `Toolbar`(얇은 층) | L |
| 9 | 배지·점 | `sidebar-tabs.js` `updateBadges` · `app-activity.js:256` · `UIKit.tab` · `git-badge` | 0 은 숨김·수 또는 점·잘림 `+` | `Badge` 값 모델(상속 아님) | L |
| 10 | 스크롤 보존 | `UIKit.scrollSave/Restore` ↔ `app-activity.js:225` `_actScroll` | 값을 두는 자리만 다르다 | `ScrollMemo`(상속 아님) | L |
| 11 | Esc·키보드 | `'Escape'` 처리 15파일 · document 수준 처리기 4곳(순서 의존, FC-13·14) | "맨 위 것 하나만 닫는다" 판정이 흩어졌다 | `EscapeStack`(static) | M |
| 12 | 리스너·옵저버·타이머 수명 | 해제 규약이 셋(owner id · 해제 함수 · 없음) | 주인이 죽을 때 한꺼번에 놓는다 | `Component` 의 `own`·`listen`·`observe` | M |
| 13 | 상태 보관(PrefStore) | `SB_TAB_KEY` · `STORE_KEYS.activityTab` 외 | 키·기본값·모르는 값은 첫 값 | `Panel`·`TabBar` 의 `persistKey` | L |
| 14 | DOM 생성 헬퍼 | `actEl`·`chatEl`·`runDiv`·`runSvg`·`meshSvg` 외 10 | 태그·클래스·글자 | `core/helpers.js` 의 `domEl`·`svgEl`(함수) | L |
| 15 | 수명 이름 | `file-tree.js` `mount/destroy` · `file-editor.js` `destroy` · `term-pane.js` `destroy` · `cm-buffer.js` `dispose` · `observer.js` `detach` · git `unmount` | 만들기 → 그리기 → 끝내기 | `Component` 표준 이름 `mount(host)`·`render()`·`dispose()`(옛 이름은 한동안 별칭) | M |
| 16 | git 패널 본체 | `git/panel.js`(생성자·접근자) + mixin 6~8파일이 메서드 187개를 얹는다 | 주제별 묶음 | mixin 파일 하나를 클래스 하나로: `GitChanges`·`GitDiffPane`·`GitFiles`·`GitWrite`·`GitPoll`·`GitLife`. 패널은 조립한다 | H |
| 17 | App 본체 | `Object.assign(App.prototype, …)` 68파일 | 주제별 묶음(레이아웃·슬롯·git·설정·모바일·활동·채팅…) | 주제마다 컨트롤러 클래스(`LayoutController`·`SlotController`·`MobileController` …). `App` 은 조립자이자 조정자로 남는다 | H |

## 3. 클래스 계층

**결정(사용자, 2026-11-21): 이 구조로 0~9 단계를 전부 진행한다.** 화면 부품은 모두 `View` 의 파생이고, App 의 주제별 일은 모두 `Controller` 의 파생이며, 둘 다 `Component` 에서 나온다.

```
Component                    core/base/component.js     수명 주기(dispose) · own·listen·observe · 타이머·이벤트 주인
├─ View                      core/base/view.js          자기 DOM 요소(el) · mount(host)·render() — 화면 부품은 모두 여기서
│   ├─ Panel                 ui/panel.js                open/close/toggle · 열림 기준은 DOM 하나 · persistKey · onClose · EscapeStack
│   │   ├─ SidebarPanel      ui/sidebar-panel.js
│   │   ├─ ActivityPanel     core/activity-panel.js
│   │   └─ DrawerSheet       ui/drawer-sheet.js
│   ├─ TabBar                ui/tab-bar.js              서술자 · 한 번 만들기 · paint · 라벨 맞춤(패널별 규칙) · roving · onSelect · 배지
│   │   ├─ SidebarTabBar     ui/sidebar-tab-bar.js      onEnter/onLeave · 직행 키 · visible
│   │   └─ ActivityTabBar    core/activity-tab-bar.js   점 배지 · 보이는 구역만
│   ├─ ListView              ui/list-view.js            items·key·sig·build·빈 문구·roving·행 동작 (reconcileList 를 감싼다)
│   │   ├─ SidebarList       ui/sidebar-list.js
│   │   └─ GitListTab        git/git-list-tab.js        (GitWorktrees·GitSubmodules 가 하위)
│   ├─ Dialog                ui/dialog.js               overlay·box·head·body·foot · _show/_exec/_close · EscapeStack
│   │   ├─ GitConfirm        git/git-confirm.js         (확인창 — 이름 유지)
│   │   ├─ GitDialog         git/git-dialog.js          (옵션 폼 — 이름 유지)
│   │   └─ SettingsModal     core/settings-modal.js
│   ├─ Menu                  ui/menu.js                 └─ GitMenu(데이터 층) git/git-menu.js
│   └─ GitView               git/git-view.js            GitObserver 구독 · 저장소가 바뀌면 _adopt · reset · _load · paint
│       └─ GitStash·GitBranches·GitHistory·GitRemote·GitConsole·GitCommit
└─ Controller                core/base/controller.js    화면 없는 조정자 · 앱 참조 · 수명
    └─ LayoutController·SlotController·MobileController·ActivityController·SettingsController …

App                          core/app.js                부품을 만들어 들고 서로 잇는 조립자
클래스가 아닌 것             EscapeStack(static 등록부) · ScrollMemo · Badge 값 계산 · domEl/svgEl · 상수
UIKit                        ui/ui-kit.js               만들기 함수(tab·modal·menu …)는 해당 클래스가 흡수하고, UIKit 은 기존 호출처·e2e 를 위한 얇은 입구로 남는다
```

상속 깊이는 `Component` 아래 넷까지로 제한한다(`Component → View → TabBar → SidebarTabBar`).

## 4. 파일 배치 — 클래스 하나 = 파일 하나

```
web/js/core/base/   component.js · view.js · controller.js · escape-stack.js · scroll-memo.js · badge.js
web/js/ui/          panel.js · tab-bar.js · list-view.js · dialog.js · menu.js
                    sidebar-panel.js · sidebar-tab-bar.js · sidebar-list.js · drawer-sheet.js
web/js/core/        activity-panel.js · activity-tab-bar.js · settings-modal.js · <주제>-controller.js
web/js/git/         git-view.js · git-list-tab.js · git-dialog.js · git-confirm.js · git-menu.js · git-panel.js
                    git-changes.js · git-diff-pane.js · git-files.js · git-write.js · git-poll.js · git-life.js
                    (remote.js 의 네 클래스 등 한 파일 여러 클래스는 해당 단계에서 파일마다 나눈다 — 이동은 `mv`)
```

파일마다 500줄 이하(`check-file-size`)를 지킨다. 클래스가 그보다 크면 그 클래스 안의 책임을 하위 부품 클래스로 나눈다.

## 5. 모듈이 아닌 구조에서 상속을 싣는 법

- **순서가 곧 의존이다.** `class SidebarTabBar extends TabBar` 는 로드 시점에 `TabBar` 를 읽는다. 그래서 `index.html` 에 `core/base/*` → 기반(`ui/tab-bar.js`) → 하위(`ui/sidebar-tab-bar.js`) 순서로 싣는다. 순서가 틀리면 TDZ 오류가 난다.
- 최상위 `class` 선언은 같은 realm 의 모든 스크립트에서 보인다. `GitModalBase` 가 이미 이 방식으로 동작한다. 다만 `window` 속성은 아니다. e2e 는 문자열 평가로 읽는다.
- **단위 시험:** `harness.mjs` 의 `load()` 는 파일 배열을 그 순서대로 한 컨텍스트에서 돌린다. 기반을 앞에 적는다. 묶음 상수(`TERM_PANE` 같은)를 계층마다 둔다.
- **로드 순서 게이트:** `check-load-order.mjs` 가 `extends` 의 우변을 로드 시점 참조로 잡는지 확인한다. 잡지 못하면 그 규칙을 더한다 `?`.
- **App 과의 공존:** App 이 인스턴스를 든다(`this.activity = new ActivityPanel(this)`). 옮긴 mixin 메서드는 한동안 위임자로 남는다. 위임자는 e2e 와 다른 파일이 새 경로로 옮겨 간 뒤에 지운다.
- **외부 프레임워크는 쓰지 않는다**(권장). 빌드·ESM 전환·캐시 버스팅(`__ASSETV__`)·하네스를 한꺼번에 다시 설계해야 한다. 이미 동작하는 기반 클래스 방식(`GitModalBase`·`GitListTab`)을 넓히는 편이 위험이 작다.

## 6. 단계

| 단계 | 내용 | 위험 |
|---|---|---|
| 0 | 선행 정리: `domEl`·`svgEl`(FU-1) · 죽은 함수(FU-2~6) · `tabsFitWatch`·`roving` 해제 경로 | L |
| 1 | `Component`·`View`·`Controller`·`EscapeStack`·`ScrollMemo`·`Badge` 를 **더하기만** 한다. 단위 시험 먼저 | L |
| 2 | `Panel`·`TabBar` → 두 패널(FU-20, 사용자 요청). DOM id·클래스·직행 키는 그대로. 라벨 판정 규칙은 패널별로 두고, 판정 시점은 한 자리에서 정한다. 두 패널의 판정 시점 차이를 먼저 표로 적는다 | M |
| 3 | `Dialog` — `GitModalBase` 를 일반화한다. `GitConfirm`·`GitDialog` 는 이름을 유지하고 상속만 바꾼다. 손으로 짠 모달을 옮긴다 | M |
| 4 | `ListView` — `SidebarList`·`GitListTab` 를 옮긴다 | M |
| 5 | `GitView` — git 탭 여섯. 세대 가드 정책을 먼저 하나로 정한다 | M |
| 6 | `Menu`·`EscapeStack` 으로 Esc 처리 15파일을 모은다(FC-13·14) | M |
| 7 | git 패널 mixin → 클래스(`GitChanges` 외) | H |
| 8 | 설정 섹션·행 | H |
| 9 | App mixin 68파일 → 주제별 `Controller` 클래스. App 은 조립자로 남는다 | H |

단계마다 SRS(IEEE 29148) → RED → 구현 → 간단 시험. 전체 e2e 는 사용자 결정대로 모든 묶음이 끝난 뒤에 돌린다.

## 7. 결정 (사용자 확인 2026-11-21 — 전부 채택)

1. 외부 프레임워크 없이 **자체 클래스 계층**을 세운다. App 은 조립자로 남고, 옮긴 mixin 은 한동안 위임자로 남는다.
2. 클래스 하나 = 파일 하나. 기반은 `core/base/` 에 둔다.
3. e2e 가 이름으로 쓰는 클래스(`GitConfirm`·`GitDialog`·`UIKit`·`TimerHub`·`GitPanel`·`EventBus`)는 이름을 유지한다.
4. 범위: 0~9 단계 전부(App 본체의 컨트롤러 분해 포함).
