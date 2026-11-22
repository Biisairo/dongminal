# 인계 — 프로덕션 리팩토링 3차 (셋째 세션): P3a 단계 5 부터 끝까지

> 넘긴 날: 2026-11-21. 넘긴 세션: `리팩터-3차-2`(둘째 세션). 단계 3·4 를 끝내고 단계 5 앞의 경계에서 넘겼다. 앞 인계서는 `REFACTOR_PROD3_HANDOFF_2.md`(둘째 세션 착수 문서)와 `REFACTOR_PROD3_HANDOFF.md`(첫 세션)다. **두 문서의 §6·§7·§8(배운 것·규약·결정)은 그대로 유효하다** — 이 문서는 거기에 더한 것만 적는다.

## 착수 블록 — 이번 세션의 지시 전부

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다. **main 은 origin 보다 앞서 있고 푸시 전이다. 푸시는 사용자 확인 뒤에만 한다.**
2. **사용자 지시(유효): "하나씩 완료되면 커밋해. 알아서 끝까지 진행해."** 묶음·단계가 끝날 때마다 묻지 않고 커밋한다(AI 서명 금지). 묶음 사이에는 간단한 시험(단위·typecheck·게이트·관련 e2e)만 돌리고, **전체 시험(e2e 전량 포함)은 모든 묶음이 끝난 뒤 한 번** 돌린다.
3. 먼저 읽는다:
   - `docs/internal/REFACTOR_PROD3_HANDOFF_2.md` 전부 — 남은 일 표(§2), 마지막에 할 것(§3), 모아 둔 문서 어긋남(§4), 사용자에게 아직 묻지 않은 것(§5), 배운 것(§6), 규약(§7), 결정(§8)
   - `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 7·§3·§6 — 단계 5 의 근거
   - `docs/internal/REFACTOR3_FE_DIALOG_SRS.md`·`REFACTOR3_FE_LIST_SRS.md` — 단계 3·4 에서 한 것과 SRS 와 다르게 한 것(§7·§6 구현 기록)
   - `docs/internal/refactor/PROD3.md` §7.1 진행 기록
4. 남은 일을 아래 「2. 남은 일과 순서」 대로 한다. 끝나면 `REFACTOR_PROD3_HANDOFF_2.md` §3 「마지막에 할 것」 을 한다.
5. 수정 규약: 중·대 규모는 SRS(IEEE 29148) → 시험(RED, 옛 코드에서 실패 확인) → 구현. 갈림길은 사용자에게 하나씩 묻고 권장안을 첫째로 둔다. 다만 사용자가 "알아서 끝까지" 라고 했으므로, 코드와 설계 문서로 답이 나오는 것은 권장안으로 정하고 SRS 의 결정 표(D-*)에 이유를 적는다(단계 3·4 가 그렇게 했다).

## 1. 어디까지 왔나

| 묶음 | 커밋 | 내용 |
|---|---|---|
| (앞 세션들) | `REFACTOR_PROD3_HANDOFF_2.md` §1 | P1 결함 · P2 Go 중복 · P3a 설계·단계 0~2 · Go P4~P6 |
| P3a 단계 3 | SRS `9ce09866`, 구현 `cececf13` | `REFACTOR3_FE_DIALOG_SRS` — `ui/dialog.js` `Dialog`(View 하위) 아래 `ui/kit-modal.js` `KitModal`(`UIKit.modal` 은 한 줄 입구) · `git/git-modal-base.js` `GitModalBase`(git 칠하기 셋만) → `git/git-confirm.js` `GitConfirm`·`git/git-dialog.js` `GitDialog` · `core/settings-modal.js` `SettingsModal`(설정 모달의 열기·닫기·탭 고르기·tablist). 키는 대화상자 스택 맨 위만 받는다(Git 모달의 동작 변경, CHANGELOG 고침). `ui-kit.js` 934 → 817줄, `app-settings.js` 500 → 445줄 |
| P3a 단계 4 | SRS `623caa88`, 구현 `75c3f645` | `REFACTOR3_FE_LIST_SRS` — `ui/list-view.js` `ListView`(`key`·`sigParts`·`sig`·`buildRow`·`reconcile`·`bindKeys`) 아래 `SidebarList`(객체 → 서술자별 인스턴스, 정적 입구 유지, 인스턴스는 클래스의 `WeakMap`) · `git/git-list-tab.js` `GitListTab`(루트 `el`, `mount(el)` 은 받은 칸을 `adopt`) → `GitWorktrees`·`GitSubmodules` |

검증(단계 4 커밋 시점): `npm run -s unit` 1203 통과 · `npm run -s typecheck` · `make gates` 통과. e2e 는 단계별 관련 spec 만 — 단계 3: 18 spec 180건(흔들림 1: `edges-settings` 간선 주소, 단독 3회 반복 15/15 통과) · 단계 4: 18 spec 270건, 실패 1 = `sidebar-actions.spec.ts` TC-SBA-1(**HEAD 에서도 실패한다 — 원래부터 있던 실패**, 전체 시험 보고에 넣는다).

## 2. 남은 일과 순서

`REFACTOR_PROD3_HANDOFF_2.md` §2 표의 3번부터다.

| # | 일 | 근거 | 비고 |
|---|---|---|---|
| 1 | **P3a 단계 5 `GitView`** — git 탭 여섯. **세대 가드 정책을 먼저 하나로 정한다.** SRS 새로 | FE_OBJECT_MODEL §6 단계 5 · §2 행 7 | 아래 「3. 단계 5 조사 메모」 |
| 2 | 단계 6 `Menu`·`EscapeStack` 으로 Esc 처리 15파일(FC-13·14). 패널 등록(INV-F3)과 **설정 모달의 Esc 순서**(아래 §4) | 단계 6 | |
| 3 | 단계 7 git 패널 mixin → 클래스 | 단계 7 | 위험 H |
| 4 | 단계 8 설정 섹션·행 — `initModal` 에 남은 `_init*` 나열(FC-04 의 나머지)도 여기서 | 단계 8 | 위험 H |
| 5 | 단계 9 App mixin 68파일 → 주제별 `Controller`. 위임자·정적 입구(`SidebarList.paint` 등, D-FEL-1)는 부르는 쪽을 옮긴 뒤에 지운다 | 단계 9 | 위험 H, 가장 큼 |
| 6 | PROD3 의 나머지 FE 항목 | HANDOFF_2 §2 의 8번 | 단계마다 PROD3 ID 를 지우며 간다 |
| 7 | Go FR-RGS-1 | HANDOFF_2 §2 의 9번 | |
| 8 | P7 문서 동기화 | HANDOFF_2 §2 의 10번 + 아래 §5 | |
| 9 | P8 받아들인 한계 다섯 | HANDOFF_2 §2 의 11번 | 사용자 질문 |

## 3. 단계 5 조사 메모 (둘째 세션이 읽은 것 — 확인 전 표본)

- 대상 클래스와 크기: `git/stash.js` `GitStash` 385 · `git/branches.js` `GitBranches` 228 · `git/history.js` `GitHistory` 409 · `git/remote.js`(943줄, 클래스 넷 — FU-12, 이 단계에서 파일마다 나눈다) · `git/console.js` `GitConsole` 280 · `git/commit.js` `GitCommit` 492. `GitListTab`(단계 4)도 `GitView` 의 하위가 된다(설계 §3: `GitView → GitListTab`). 이 경우 `GitListTab extends ListView` 와 겹치므로 **`ListView` 를 상속할지 `GitView` 를 상속할지 먼저 정한다** — 설계 §3 표는 `GitListTab` 을 `ListView` 아래에 두었고 §6 단계 5 는 "`GitListTab` 은 그 하위" 라고 적었다(문서 안의 어긋남). 권장: `GitView extends View` 에 저장소 수명(`_repo`·`_adopt`·`reset`·`reload`)을 두고, `GitListTab` 은 `GitView` 하위로 옮기고 행 그리기는 `ListView` 를 **부품으로 든다**(상속 깊이와 다중 상속 문제를 피한다). 갈림길이면 사용자에게 묻는다
- 패널이 뷰를 다루는 자리: `git/panel-views.js` `GIT_VIEW_KINDS`(지연 생성 `make`)·`_viewOf`·`_renderView(key, el)`(`el.dataset.built` 로 한 번 `mount(el)`, 그다음 `paint()`, 저장소가 없으면 `unmount()`). `commit`·`remote` 는 `_commit()`·`_remote()`(`GitJobs`) 로 따로 만든다
- **세대 가드가 세 종류다.** ① `this.panel.repo!==this._repo` 로 저장소 교체 판정(stash·branches·history·list-tab, `_repo` 의 처음 값은 `undefined`, commit 만 `null`) ② 패널 토큰 `const tok=this.panel.token()` … `this.panel.isStale(tok)`(stash·branches·`gitLoadList`) ③ 자기 일련번호 `_seq`(console, commit 의 `_askSeq`). 그 위에 `gitLoadTicket`·`gitLoadTaken`(`git/view-util.js`)이 겹친 받기를 거른다
- **루트 이름이 둘이다.** `GitListTab` 은 단계 4 에서 `el` 이 됐고 나머지 뷰는 아직 `_el` 이다. 공용 `gitLoadList` 가 `_el` 만 읽어 worktrees·submodules 가 받은 목록을 칠하지 않는 결함이 생겼고, e2e 가 잡아 `gitViewMounted(view)`(`el`·`_el` 둘 다)로 막았다. **단계 5 에서 모두 `el` 로 모으고 `gitViewMounted` 를 지운다.** `history.js:109` 가 다른 뷰의 `h._el` 을 읽는다 — 이런 바깥 읽기를 먼저 센다: `grep -rnE "[a-zA-Z)\]]\._el\b" web/js e2e`
- 수명 이름: 설계는 `mount(host)`·`render()`·`dispose()` 다. git 뷰는 `mount(el)`(받은 칸이 루트)·`unmount()`·`paint()` 다. 단계 4 는 `GitListTab.mount(el)` 을 `adopt` 로 두고(D-FEL-3) 통일을 단계 5 로 미뤘다

## 4. 이 세션이 값을 치르고 배운 것

- **기반 클래스의 이름과 하위의 이름이 부딪친다.** `GitDialog` 에 이미 `_labelEl(text)` 가 있어 `Dialog` 의 이름 훅을 `_nameEl()` 로 바꿨다. 하위를 기반 아래로 옮기기 전에, 기반이 가진 이름 전부를 하위 파일에서 찾는다: `Component`(`own`·`listen`·`observe`·`after`·`every`·`on`·`dispose`·`disposed`·`_disposers`·`_timers`·`_bus`) · `View`(`el`·`_adopted`·`build`·`adopt`·`mount`·`render`) · `Dialog`(`ov`·`box`·`busy`·`err`·`isTop`·`_attach`·`_detach`·`_openOff`·`_onKey`·`_dismiss`·`_nameEl`·`_show`·`_close`·`_exec`·`_front`·`_copy`·`_failText`·`_escCapture`·`_resolve`) · `ListView`(`key`·`sig`·`sigParts`·`buildRow`·`reconcile`·`bindKeys`)
- **이름을 바꾸면 그 이름을 읽는 공용 함수를 먼저 센다.** `_el` → `el` 이 `view-util.js` 의 `gitLoadList` 를 조용히 깨뜨렸다(예외 없이 행만 안 그려졌다). 단위 시험은 못 잡고 e2e 12건이 잡았다. 원인 찾기: 실패 spec 하나를 `--trace=on` 으로 돌리고 trace.zip 을 풀어 `grep -oE 'api/git/[a-zA-Z/_-]+' *.network` 로 요청이 나갔는지 본다(이번엔 목록 요청이 나갔는데 칠하지 않았다)
- **`ui/`·`git/` 의 클래스는 App 에 필드를 얹을 수 없다**(계층 게이트, FR-FMB-40). 인스턴스를 App 별로 들어야 하면 클래스 정적 `WeakMap` 을 쓴다(`SidebarList._byApp`)
- **설정 모달의 Esc 는 버블이어야 한다.** 모바일 상세 화면의 Esc(`app-mobile-sheets.js` `_initSettingsMobile`, 캡처·`stopImmediatePropagation`)가 먼저 돌아 목록으로 물러서야 한다. 같은 노드의 리스너는 등록 순서로 도므로 설정 닫기를 캡처로 옮기면 그 앞에 선다(D-FED-5). 단계 6 에서 Esc 를 모을 때 이 순서를 지킨다
- `SettingsModal` 은 `initModal` 과 **같은 시점**에 만들어야 한다 — `_initSettingsMobile` 이 `#settings-btn`·`.mtab` 에 붙이는 클릭 리스너가 그 뒤에 붙어 뒤에 돈다는 순서에 기대고 있다
- 파일을 `git mv` 로 옮기면 `docs/internal/PERFORMANCE_BUDGET.md` §2-5 다시 그리기 등록부가 옛 경로로 게이트를 깬다 — 등록부의 경로도 함께 고친다. `kit-key.test.mjs` 처럼 파일을 이름으로 읽는 단위 시험도 있다: `grep -rn "<옛 경로>" web/js/test scripts docs/internal/PERFORMANCE_BUDGET.md`
- 새 SRS 를 "승인·구현중" 으로 커밋하면 게이트(`SRS 진행 근거`)가 상태 줄 아래 `> **남은 것**: …` 한 줄을 요구한다. 구현 커밋에서 "승인·구현완료" 로 바꾸고 그 줄을 지운다
- 하네스 묶음 상수가 늘었다: `BASE` → `ui/repaint.js` → `ui/ui-kit.js` → `DIALOG`(`ui/dialog.js`·`ui/kit-modal.js`) → `LIST`(`ui/list-view.js`). `Component.dispose` 는 `TIMERS.disposeOwner` 를 부르므로 단위 시험의 전역 대역에 `TIMERS: { disposeOwner() {} }` 가 있어야 한다
- 이 세션의 e2e 는 관련 spec 을 백그라운드로 한 번에 돌리고(`> /tmp/<이름>.log`), 실패가 있으면 `git stash push -q -u -- web` → 같은 spec → `git stash pop -q` 로 HEAD 와 견줬다. 18 spec 이 2~6분이다

## 5. 모아 둔 문서 어긋남 (P7 에서 코드 기준으로 고친다 — HANDOFF_2 §4 에 더한다)

- `FE_OBJECT_MODEL.md` §2 행 4 의 "손으로 짠 것(`term-pane.js:600`·`app-claude-accounts.js:427`)" — 둘 다 대화상자가 아니다(연결 상태 오버레이·계정 팝오버). `REFACTOR3_FE_DIALOG_SRS` §6 에 적었다
- `FE_OBJECT_MODEL.md` §3 표는 `GitListTab` 을 `ListView` 아래에, §6 단계 5 는 `GitView` 아래에 둔다(위 §3)
- 옛 파일 이름 `git/confirm.js`·`git/dialog.js`·`git/modal-base.js`·`git/list-tab.js` 가 지난 SRS·기록 문서 약 20개에 남아 있다(`OPTIMIZE_REFACTOR_SRS`·`KIT_COMPONENTS_SRS`·`POPUP_DEFAULT_ACTION_SRS`·`production/*` 등). 당시 기록이라 고치지 않았다 — P7 에서 사용자 결정 Q6("전부 코드 기준")에 따라 살아 있는 문서(`architecture.md` 등)만 고칠지 정한다

## 6. 변하지 않는 규약 · 유효한 사용자 결정

`REFACTOR_PROD3_HANDOFF_2.md` §7·§8 과 같다. 바뀐 것 없음.
