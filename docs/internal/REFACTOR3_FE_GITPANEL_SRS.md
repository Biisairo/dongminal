# SRS: 리팩토링 3차 P3a 단계 7 — Git 패널 mixin 을 부품 클래스로 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 하위 단계 7a~7g 구현과 시험

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 16·§6 단계 7)
- 사용자 결정(2026-11-21, `FE_OBJECT_MODEL.md` §7): 자체 클래스 계층, 클래스 하나 = 파일 하나, 0~9 단계 전부. 진행은 묻지 않고 끝까지 한다. 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.

## 1. 개요

### 1.1 목적

`class GitPanel`(`git/panel.js`)의 본문에는 생성자와 관측 접근자만 있다. 메서드 237개는 mixin 파일 열하나가 `Object.assign(GitPanel.prototype, …)` 로 얹는다. 모든 메서드가 같은 `this` 의 필드 약 60개를 함께 읽고 쓴다. 그래서 어느 메서드가 어느 상태를 바꾸는지 파일 경계로 알 수 없다.

정적 분석(HEAD `8a81f81d`, AST 로 `this.X` 를 셈)의 결과는 다음과 같다.

| 파일 | 메서드 | 혼자 쓰는 필드 | 다른 파일 호출이 많은 상대 |
|---|---|---|---|
| `panel-life.js` | 23 | — (diff·hunk·blame 상태를 되돌린다) | views 9 · poll 5 · diff 3 |
| `panel-changes.js` | 33 | `_fileView`·`_initBusy`·`_initErr`·`_io` | files 11 · views 9 · diff 7 |
| `panel-views.js` | 40 | 뷰 필드 8 · `_knownRefs` | changes 2 |
| `panel-write.js` | 28 | `_opActs`·`_opActsP` | changes 5 · views 4 · poll 3 |
| `panel-files.js` | 25 | — | write 15 · changes 4 · views 3 |
| `panel-diff.js` | 22 | `_diffAsking`·`_diffShown`·`_diffStale`·`_diffDirtyShown` | poll 17 · hunks 8 · files 5 |
| `panel-diff-tab.js` | 7 | `_dtKey`·`_dtPendingView` | diff 2 |
| `panel-blame.js` | 7 | — (`_blame*` 넷을 life 가 함께 되돌린다) | changes 5 · files 2 |
| `panel-hunks.js` | 20 | `_hunkBar*`·`_hunkErr`·`_hunkErrKey` | write 7 · files 3 |
| `panel-dir-entry.js` | 2 | — | poll 1 · diff 1 |
| `panel-poll.js` | 30 | `_fold`·`_refsRound` (`_sideBy`·`_ignWs` 는 diff 보기 설정) | life 5 · diff 3 · changes 3 |

- 파일 사이 호출은 411곳 중 163곳(40%)이고, 열한 파일이 **하나의 순환**으로 묶인다.
- 패널 바깥(뷰·메뉴·`branches-ops.js`·`remote.js`·`core/app-git.js`·e2e)이 부르는 메서드는 99개다. e2e 는 `openView`·`refresh`·`statusOf`·`_pollOk`·`_pollOn`·`_lastObsAt`·`_failStreak`·`_historyView`·`_diffView` 등을 이름으로 쓴다.
- 여러 파일이 함께 쓰는 필드: `previewFile`·`commitFile`·`_diffView`·`_diffKey`·`_diffPos`·`_hunks`·`_hunkKey`·`_anchor`·`_sel`·`_shown`·`_collapsed`·`_staleViews`·`_blame*`·`_note`(여섯 파일).
- 죽은 필드: `_hunkBarWidget`·`_hunkBarSubs`(생성자 밖 참조 없음).

이 문서는 mixin 을 **필드까지 소유하는 부품 클래스**로 옮기고, `GitPanel` 은 부품을 만들어 들고 공용 상태를 갖는 조립자로 남긴다.

### 1.2 범위 — 부품과 하위 단계

| 단계 | 부품 | 파일 | 담는 것 | 소유 필드 |
|---|---|---|---|---|
| 7a | `GitPart` · `GitBlame` | `git/git-part.js` · `git/git-blame.js` | 부품 기반 · blame 7 | `_blame*` 넷 |
| 7b | `GitHunks` | `git/git-hunks.js` | 부분 스테이징·hover 툴바 20 | `_hunkBar*`·`_hunkErr`·`_hunkErrKey` (`_hunks`·`_hunkKey` 는 공용) |
| 7c | `GitDiffPane` | `git/git-diff-pane.js` | diff 22 + Diff 탭 7 + 보기 설정 4(`_sideBySidePref`·`_ignoreWsPref`·`_toggleSideBySide`·`_setIgnoreWs`) | `_diffAsking`·`_diffShown`·`_diffStale`·`_diffDirtyShown`·`_dtKey`·`_dtPendingView`·`_sideBy`·`_ignWs` |
| 7d | `GitPoll` | `git/git-poll.js` | 폴링·상태 적용 26 | `_fold`·`_refsRound` |
| 7e | `GitWrite` | `git/git-write.js` | 쓰기 전후 28 | `_opActs`·`_opActsP` |
| 7f | `GitChanges` | `git/git-changes.js`(+ 크기에 따라 `git/git-files.js`) | Changes 33 + 파일 작업 25 + 디렉터리 항목 2 | `_fileView`·`_initBusy`·`_initErr`·`_io` |
| 7g | `GitViews` | `git/git-views.js` | 뷰 지연 생성·상태 접근·브랜치/태그 파사드 40 | 뷰 필드 9 · `_knownRefs` |
| 7g | `GitPanel` | `git/panel.js` | 생성자·접근자·부품 조립 + life 23(리포 전환·뷰 루트·파괴·소실 복구) | 공용 상태 |

하위 단계 하나가 끝날 때마다 mixin 파일 하나 이상이 사라지고, 단위·게이트·관련 e2e 를 지난 뒤 커밋한다.

### 1.3 범위 밖

- 바깥 호출처(`menu-items.js`·`branches-ops.js`·`remote.js`·`commit-ops.js`·`core/app-git.js`·e2e)를 부품 경로(`panel.views.X`)로 옮기는 일. 이 문서는 패널에 위임자를 남긴다. 위임자를 지우는 일은 단계 9(App 컨트롤러)에서 부르는 쪽과 함께 한다(D-FEL-1·INV-F2 와 같은 규약).
- 공용 상태를 객체 하나로 묶는 일(`panel.target` 등). e2e 가 `_diffView`·`previewFile` 같은 이름을 직접 읽는다.
- 관측(`GitObserver`)과 뷰(`GitView` 하위)·`GitDiffView`·`GitJobs`.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-P1 | 보이는 동작·DOM·요청·폴링 주기는 바뀌지 않는다 |
| INV-P2 | 패널 바깥과 e2e 가 쓰는 이름(메서드 99개, 필드 `_historyView`·`_diffView`·`previewFile`·`commitFile`·관측 접근자 등)은 `GitPanel` 인스턴스에서 그대로 읽히고 불린다 |
| INV-P3 | 관측 접근자(getter/setter 23쌍)와 `repo` 는 `GitPanel` 클래스 본문에 남는다(`Object.assign` 이 getter 를 값으로 굳히는 문제) |
| INV-P4 | 계층·로드 순서·크기(파일 500줄 이하, 넘는 파일 수를 늘리지 않는다)·킷 게이트를 지킨다 |

## 2. 요구사항

| ID | 요구 |
|---|---|
| FR-FEP-1 | `GitPart extends Component`(`git/git-part.js`): 생성자가 `(panel)` 을 받아 `this.p`(패널)와 `this.app`(`panel.app`)을 둔다. 부품의 해제는 패널 수명(`destroy`)에서 `dispose()` 로 한 번 부른다 |
| FR-FEP-2 | 부품은 §1.2 의 메서드를 인스턴스 메서드로 갖는다. 혼자 쓰는 필드는 부품이 소유한다(부품 필드 이름은 지금 이름 그대로). 공용 필드·관측 접근자·다른 부품의 메서드는 `this.p.X` 로 읽고 부른다 |
| FR-FEP-3 | `GitPanel` 생성자가 부품을 만들어 든다: `this.blame`·`this.hunks`·`this.diffPane`·`this.poll`·`this.write`·`this.changes`·`this.views`. 부품 이름이 기존 메서드·필드 이름과 부딪치면 그 부품만 다른 이름을 쓰고 §6 에 적는다 |
| FR-FEP-4 | 패널 바깥이나 다른 부품이 부르는 메서드는 `GitPanel` 에 같은 이름의 **위임자**(한 줄)로 남는다. 위임자는 클래스 본문에 둔다. 부품 안에서만 쓰는 메서드는 위임자를 두지 않는다 |
| FR-FEP-5 | e2e·바깥이 부품 소유 필드를 이름으로 읽으면(예: e2e 의 관측 필드) 그 필드는 패널에 남기거나 패널에 접근자를 둔다. 어느 쪽인지 §6 에 적는다 |
| FR-FEP-6 | 죽은 필드 `_hunkBarWidget`·`_hunkBarSubs` 를 지운다(7b) |
| FR-FEP-7 | 7g 끝에서 `Object.assign(GitPanel.prototype` 이 저장소에 없다. life 의 메서드는 `GitPanel` 클래스 본문으로 온다. `panel.js` 가 500줄을 넘으면 뷰 루트(`elFor`·`_render`·`dropView` 류)를 부품(`GitViewRoots`)으로 나눈다 |
| FR-FEP-8 | `index.html` 은 `git-part.js` 를 `panel.js` 앞에, 부품 파일을 지금 mixin 자리에 싣는다. 부품 클래스는 `panel.js` 보다 먼저 정의될 필요가 없다(생성자 호출 시점에만 읽는다) — 다만 로드 순서 게이트가 요구하면 따른다. 파일을 이름으로 읽는 시험·`PERFORMANCE_BUDGET.md` 등록부·`panel.js` 머리 주석의 파일 목록을 고친다 |
| FR-FEP-9 | 단위 시험 하네스에 git 패널 묶음 상수를 지금 순서대로 고친다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FEP-1 | 설계의 "mixin 파일 하나 = 클래스 하나(여섯)" 대신 §1.2 의 일곱 부품으로 나눈다: Changes 와 파일 작업·디렉터리 항목을 합치고, diff 와 Diff 탭·보기 설정을 합치며, blame·hunk 는 따로 둔다. life 는 패널 본문이 된다 | 분석: changes↔files 가 서로 15번 부르고 필드를 함께 쓴다. 보기 설정 넷은 poll 파일에 있지만 diff 의 것이다. life 는 리포 전환 때 diff·hunk·blame 상태를 되돌리는 조정자이므로 부품이 아니라 조립자의 일이다. 파일 경계를 그대로 클래스로 삼으면 경계를 가로지르는 호출이 그대로 위임자가 된다 |
| D-FEP-2 | 필드까지 부품이 소유한다(공용 필드만 패널) | 부품이 `this.p.X` 로 모든 필드를 읽는 방식은 바꿀 줄이 약 540이고 "누가 무엇을 바꾸나" 가 여전히 안 보인다. 소유 방식은 약 280~490줄이고 혼자 쓰는 필드가 파일 경계 안으로 들어온다 |
| D-FEP-3 | 한 번에 다 하지 않고 결합이 약한 부품부터 하나씩(7a→7g) 옮기고 하위 단계마다 커밋한다 | 열한 파일이 한 순환이라 한 번에 옮기면 e2e 실패의 원인을 좁힐 수 없다. blame(위임자 1)·hunk(2)가 가장 약하다 |
| D-FEP-4 | 위임자는 남긴다 | 바깥 호출 259곳·e2e 를 함께 바꾸면 이 단계의 위험이 두 배가 된다. 부르는 쪽을 옮기는 것은 단계 9 의 일이다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FEP-1 | 단위: 하위 단계마다 그 부품이 `GitPart`·`Component` 하위이고, `GitPanel` 이 그 부품을 들며, 위임자가 부품 메서드를 같은 인자로 부르고 값을 돌려준다 |
| TC-FEP-2 | 단위(소스 검사): 옮긴 mixin 파일이 없다. 하위 단계가 끝날 때마다 `Object.assign(GitPanel.prototype` 의 수가 준다. 7g 뒤에는 0 이다 |
| TC-FEP-3 | 단위: 부품 소유 필드가 패널 원형·생성자에 없다(FR-FEP-5 의 예외 제외). 죽은 필드 둘이 없다 |
| TC-FEP-4 | e2e(기존): 하위 단계마다 git 관련 spec(changes·diff·blame·hunk·history·branches·stash·commit·remote·repo 전환·refresh·polling·mobile git) 이 모양을 바꾸지 않고 통과한다 |

## 5. 동작 변경 기록

없다.

## 6. 구현 기록

| 하위 단계 | 커밋 | 요점 |
|---|---|---|
| 7a | `2f29a3a8` | `GitPart`(`git-part.js`, `panel.js` 앞)·`GitBlame`(`git-blame.js`, `panel-blame.js` 를 `git mv`) — 메서드 7, 위임자 3(`openBlame`·`blameStale`·`_paintBlame`), 소유 필드 `_blameKey`·`_blameData`·`_blameErr`·`_blameAll`. `_blameOn` 은 diff·hunk·`app-diff-tab.js` 가 함께 쓰므로 패널에 남는다(SRS 의 "넷" 이 이 넷이다). life 의 되돌림은 `this.blame.reset()`(옛 줄과 같이 `_blameAll` 은 두지 않는다), 해제는 `destroy` 끝에서 `this.blame.dispose()`. 하네스에 `GITPANEL` 묶음을 새로 둔다(옛 묶음 상수가 없었다). 단위 `git-panel-parts.test.mjs` 5. e2e 6 spec 72 통과 |
| 7b | `ad2468f0` | `GitHunks`(`git-hunks.js`, `panel-hunks.js` 를 `git mv`) — 메서드 20, 위임자 9(`_paintHunks`·`_hunkText`·`_hunkNote`·`_hunkBarWire`·`_hunkBarDispose`·`_hunkBarHide`·`_hunkBarPaint`·`_diffChanged` 는 diff·life 가, `_hunkAct` 는 e2e 가 부른다 — SRS 가 셈한 2 는 패널 바깥만 센 수다). 소유 필드 `_hunkBarEd`·`_hunkBarEl`·`_hunkBarPos`·`_hunkBarHunk`·`_hunkBarFocus`·`_hunkBarOff`(생성자 밖에서 처음 서던 것)·`_hunkErr`·`_hunkErrKey`. e2e 가 `_hunkBarEd`(git-hunk.spec)·`_hunkBarPos`(editor.ts)를 읽으므로 패널에 **읽기 접근자**를 둔다(FR-FEP-5). 죽은 필드 `_hunkBarWidget`·`_hunkBarSubs` 를 지웠다(FR-FEP-6). `git-hunk-fresh.test.mjs` 는 부품을 패널 대역 위에 세운다. 단위 5(묶음 시험 확장). e2e 7 spec 102 통과 |
| 7c | `4f55f987` | `GitDiffPane`(`git-diff-pane.js`, `panel-diff.js` 를 `git mv`, `panel-diff-tab.js` 는 `git rm` 후 본문을 옮김) — Diff 17 + Diff 탭 7 + 보기 설정 4(`panel-poll.js` 앞쪽) = 메서드 28, 위임자 12(`_renderDiff`·`_diffInvalidate`·`_fileList`·`_diffIndex`·`_diffMove`·`reloadDiff`·`_destroyViews`·`diffTabApply`·`diffViewKeep`·`diffViewRestore`·`diffTabViewState`·`diffTabViewApply`). 소유 필드 `_diffAsking`·`_diffShown`·`_diffStale`·`_diffDirtyShown`·`_dtKey`·`_dtPendingView`·`_sideBy`·`_ignWs`. **SRS 와 다르게 한 것**: diff 22 중 행 선택에서 diff 로 가는 다섯(`_noBaseline`·`_openInEditor`·`_select`·`_openDiff`·`openView`)은 부품에 넣지 않고 `panel-files.js` mixin(선택의 자리)으로 옮겼다 — 다 넣으면 `git-diff-pane.js` 가 약 580줄로 500줄을 넘는다. 다섯은 부품 소유 필드를 쓰지 않으므로 7f 의 `GitChanges`/`git-files.js` 가 함께 가져간다. `_showTarget` 의 `this[slot]`(slot=`'_diffKey'`)은 `this.p[slot]`, `gitDiffStep(this,…)` 는 `gitDiffStep(this.p,…)` 로 손으로 고쳤다(정규식이 못 잡는 계산된 이름·맨 `this`). e2e 19 spec 270 통과(flaky 1: slot-view-state TC-SVS-56, 단독 재실행 통과) |
| 7d | (이 커밋) | `GitPoll`(`git-poll.js`, `panel-poll.js` 를 `git mv`) — 메서드 26 + `refsRound()` 1, 위임자 20(`_foldPref`·`_setFold`·`absPath`·`repoTop`·`openFileDiff`·`copyText`·`refresh`·`_reloadViews`·`_staleTake`·`_inRefsRound`·`_reloadStaleViews`·`init`·`signal`·`_pollOk`·`_cadence`·`_applyCadence`·`_watchdog`·`_reschedule`·`_stop`·`collect`). 소유 필드 `_fold`·`_refsRound`. **SRS 와 다르게 한 것**: ① `panel-views.js` 의 `fetchRefs` 가 `_refsRound` 를 직접 읽었다 — `this.poll.refsRound()` 로 바꿨다(옮긴 채 두면 회차 공유가 조용히 꺼진다). ② 타이머 주인은 종전대로 패널(`owner:this.p`)이다. ③ 부품 안의 `collect`·`_pollOk` 부름은 `this.p.collect()`·`this.p._pollOk()` 로 패널 위임자를 지난다 — e2e(git-observe-revive TC-GLR-3·R-6, event-timer-hub-contract T-6)가 패널 인스턴스에서 그 둘을 덮어 재므로, 부품 안에서 바로 부르면 덮은 것을 못 본다(첫 회차 3건 실패로 드러났다). ④ `git-poll.js` 는 690줄로 500줄을 넘는다 — 옛 `panel-poll.js`(712줄)도 넘던 파일이라 넘는 파일 수는 17 그대로다. 나누는 일은 이 단계 밖으로 둔다. `event-timer-hub-contract.spec.ts` 의 합성 페이지는 `component.js`·`git-part.js`·`git-poll.js` 를 싣고 패널 대역에 위임자 다섯을 둔다(재는 계약은 그대로). `git-panel-obs.test.mjs` 는 부품을 패널 대역 위에 세운다. e2e: git 관련 전부 72 spec 797 — 실패 4(알려진 git-ui-metrics V80 + 위 ③ 3건), ③ 을 고친 뒤 폴링 관련 15 spec 171 통과 |
