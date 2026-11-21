# SRS: 리팩토링 3차 P3a 단계 5 — Git 탭 기반 클래스 `GitView` — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: `GitView`·세대 가드 한 벌·일곱 뷰 이주·`remote.js` 파일 분할 구현과 시험

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/FE_OBJECT_MODEL.md` §2 행 7·§3·§6 단계 5)
- 사용자 결정(2026-11-21, `FE_OBJECT_MODEL.md` §7): 자체 클래스 계층, 클래스 하나 = 파일 하나. 진행은 묻지 않고 끝까지 한다. 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.

## 1. 개요

### 1.1 목적

Git 창의 탭 뷰는 모두 같은 수명을 따른다. 패널이 칸을 주면 `mount(el)` 이 골격을 세우고, `paint()` 가 저장소가 바뀌었는지 보고 바뀌었으면 상태를 비우고 다시 받으며, 저장소가 없어지면 `unmount()` 가 칸을 놓는다. 이 수명을 뷰마다 따로 적었고, 그 결과 다음이 갈라졌다.

| 갈라진 것 | 지금 |
|---|---|
| 루트 이름 | `GitListTab` 만 `el`(단계 4), 나머지는 `_el`. 공용 `gitLoadList` 가 둘 다 보도록 `gitViewMounted` 를 덧댔다 |
| 저장소 교체 판정 | `this.panel.repo!==this._repo` 를 뷰마다 적는다. `_repo` 의 처음 값은 `undefined`, `GitCommit` 만 `null` |
| 응답 짝 맞추기(세대 가드) | 세 종류 — ① 패널 토큰(`panel.token()`·`panel.isStale(tok)`) ② 뷰 자체 일련번호(`GitConsole._seq`·`GitCommit._askSeq`) ③ 공용 표(`gitLoadTicket`·`gitLoadTaken`, 뷰의 `_loadGen`·`_abort` 필드) |

대상 뷰는 일곱이다: `GitStash`(`stash.js`) · `GitBranches`(`branches.js`) · `GitHistory`(`history.js` + mixin 넷) · `GitConsole`(`console.js`) · `GitCommit`(`commit.js` + `commit-draft.js`) · `GitRemoteList`(`remote.js`, Branches 안의 원격 목록) · `GitListTab`(`git-list-tab.js`, `GitWorktrees`·`GitSubmodules` 의 부모).

### 1.2 범위

| 항목 | 내용 |
|---|---|
| `GitView` | `git/git-view.js`. `View` 의 하위. 패널 참조, 받은 칸을 루트로 삼는 `mount(el)`, `unmount()`, 저장소 교체(`_repo`·`_syncRepo()`·`_adopt()`·`reset()`·`_load()`·`reload()`), 세대 가드 한 벌(`ticket`·`superseded`·`stale`·`dropTicket`) |
| 일곱 뷰 | `GitView` 의 하위로 옮긴다. 루트는 모두 `el` 이다 |
| `GitListTab` | `ListView` 대신 `GitView` 를 상속하고, 행 그리기는 `ListView` 인스턴스를 부품(`rows`)으로 든다 |
| 공용 조각 | `gitLoadList` 가 뷰의 `ticket`·`superseded`·`stale` 을 쓴다. `gitLoadTicket`·`gitLoadTaken`·`gitViewMounted` 를 지운다 |
| `remote.js` | 네 클래스를 파일 넷으로 나눈다(`mv`·잘라 옮기기): `remote.js` `GitRemote` · `remote-opts.js` `GitRemoteOpts` · `remote-list.js` `GitRemoteList` · `remote-add.js` `GitRemoteAdd` |

### 1.3 범위 밖

- `GitRemote` 자체의 책임 나누기(FU-12 의 "실행·스트림 / 표시"). `GitRemote` 는 탭 뷰가 아니라 Changes 머리에 얹힌 작업 표시기다(D-FEV-4). 클래스 안을 나누는 일은 git 패널 부품을 클래스로 옮기는 단계 7 에서 `GitJobs` 와 함께 한다.
- 뷰 안의 다른 `reconcileList` 호출(Stash 두 목록·Branches 트리 셋·History refs·상세 파일·원격 행). 한 뷰에 목록이 여럿이라 부품 하나로 묶이지 않는다. 단계 7·9 에서 다시 본다.
- 한 파일에 클래스가 둘 이상인 대화상자 파일(`branches-dialogs.js`·`stash-dialogs.js`·`tag.js`·`worktrees.js` 의 `GitWorktreeCreate`). 탭 뷰가 아니다. 단계 7 에서 나눈다.
- 패널 쪽 호출(`panel-views.js` `_renderView`·`panel-life.js` `dropView`·`detach`·`_repoSwitchView`)의 모양. 이름(`mount`·`paint`·`unmount`·`reset`·`reload`)을 그대로 두므로 바꾸지 않는다.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-V1 | DOM(클래스·`data-*`·`role`·`aria-*`)과 행 서명의 바이트는 바뀌지 않는다 |
| INV-V2 | 패널과 e2e 가 쓰는 이름(`mount`·`paint`·`unmount`·`reset`·`reload`·`_loading`·`_refs`·`_commits`·`_search`, 필드 이름 `_historyView` 등)은 그대로다 |
| INV-V3 | 보이는 동작은 바뀌지 않는다. 낡은 응답을 버리는 판정은 같거나 더 엄격해질 뿐 느슨해지지 않는다. 낡은 응답에서도 `_loading` 잠금을 놓는 순서(FR-GRF-24)는 그대로다 |
| INV-V4 | 계층·로드 순서·크기·킷 게이트를 지킨다 |

## 2. 요구사항

| ID | 요구 |
|---|---|
| FR-FEV-1 | `GitView extends View`(`git/git-view.js`). 생성자는 `(panel)` 을 받아 `panel`·`app`(`panel.app`)을 두고 `_repo` 를 `undefined`(아직 받지 않음)로 둔다. `null` 은 "저장소 없음" 이다 |
| FR-FEV-2 | `mount(el)` 은 `View.mount(host)` 를 덮는다. `el` 이 없으면 아무것도 하지 않는다. 있으면 `adopt(el)` 하고 하위 훅 `_build(el)` 로 골격을 세운 뒤 `_repo` 를 `undefined` 로 되돌린다. 칸의 주인은 패널이므로 `dispose` 가 칸을 떼지 않는다 |
| FR-FEV-3 | `unmount()` 는 `el` 을 `null` 로, `_repo` 를 `undefined` 로 둔다. 하위가 놓을 것이 더 있으면 덮어쓰고 `super.unmount()` 를 부른다 |
| FR-FEV-4 | `_syncRepo()` 는 `panel.repo!==this._repo` 이면 `_adopt()` 를 부르고, 그 뒤에도 붙어 있는지(`!!this.el`)를 돌려준다. `_adopt()` 의 기본은 `_repo=panel.repo` → `reset()` → 저장소가 있으면 `_load()` 다. `reset()`·`_load()` 의 기본은 빈 동작, `reload()` 의 기본은 `_load()` 다 |
| FR-FEV-5 | 세대 가드는 한 벌이다. `ticket(ch)` 는 `{ch, gen, tok, signal}` 을 돌려준다 — `tok` 은 `panel.token()`. `ch`(채널 이름)를 주면 같은 채널의 앞선 표를 이긴다: 세대를 올리고 앞선 `AbortController` 를 끊는다. `superseded(t)` 는 같은 채널에 더 새 표가 있으면 참이다(채널이 없으면 언제나 거짓). `stale(t)` 는 `superseded(t)` 이거나 `panel.isStale(t.tok)` 이면 참이다. `dropTicket(ch)` 는 그 채널의 세대를 올리고 끊는다(진행 중 응답을 버린다) |
| FR-FEV-6 | 뷰의 모든 비동기 응답은 FR-FEV-5 로만 짝을 본다. 옮김표: `panel.token()`/`panel.isStale(tok)` → `ticket()`/`stale(t)` · `gitLoadTicket`/`gitLoadTaken` → `ticket('load')`/`superseded(t)` · `GitConsole._seq` → `ticket('records')`(`reset()` 은 `dropTicket('records')`) · `GitCommit._askSeq` → `ticket('ask')`. 응답 본문의 echo 대조(`echo`·`_sameReq`·`requested.repo`)와 선택 대조(`this._sel!==oid` 등)는 다른 층이므로 그대로 둔다 |
| FR-FEV-7 | `gitLoadList(view, spec)` 는 `view.ticket('load')` 을 받고, `superseded` 면 잠금을 건드리지 않고 돌아가며, 그다음 `_loading=false` 를 놓고, `res.stale` 이면 돌아간다(지금 순서). 칠하기 조건은 `view.el` 이다. `gitLoadTicket`·`gitLoadTaken`·`gitViewMounted` 를 지운다 |
| FR-FEV-8 | 일곱 뷰는 `GitView` 의 하위다. 루트 필드는 `el` 하나다 — 뷰 파일과 그 mixin 파일, 바깥 읽기(`history.js` `GitHistory.applyTheme` 의 `h._el`)에 `_el` 이 남지 않는다. 저장소 교체 판정은 `_syncRepo()`·`_adopt()` 를 지난다(`GitCommit` 은 자기 `_reset(repo)` 를 `_adopt` 자리에 쓴다). `GitCommit._repo` 의 처음 값도 `undefined` 다 |
| FR-FEV-9 | `GitListTab extends GitView`. 행 그리기는 부품 `this.rows`(`ListView` 인스턴스)가 한다 — 부품의 `key`·`sigParts`·`buildRow` 는 `GitListTab` 의 같은 이름 메서드에 맡긴다. 그래서 `GitWorktrees`·`GitSubmodules` 의 훅 이름은 바뀌지 않는다. 부품의 수명은 `GitListTab` 의 수명에 쌓는다(`own`) |
| FR-FEV-10 | `remote.js` 의 네 클래스를 파일 넷으로 나눈다. `index.html` 은 지금 `remote.js` 자리에 `remote.js` → `remote-opts.js` → `remote-list.js` → `remote-add.js` 순으로 싣는다. `git/git-view.js` 는 `git/view-util.js` 바로 뒤에 싣는다 |
| FR-FEV-11 | 단위 시험 하네스에 묶음 상수 `GITVIEW`(`git/git-view.js`)를 `LIST` 뒤에 둔다. 다시 그리기 등록부(`PERFORMANCE_BUDGET.md` §2-5)와 파일을 이름으로 읽는 시험의 경로를 새 파일에 맞춘다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FEV-1 | **세대 가드 정책:** 겹은 둘이다. ① 저장소 교체는 `_syncRepo()` 한 자리에서 `_repo` 로 판정한다 ② 응답 짝은 `ticket`/`stale` 한 벌이다 — 패널 세대(저장소가 바뀌었는가)는 언제나 보고, 같은 종류의 겹친 요청(뒤 것이 이긴다)은 채널을 준 곳만 본다 | 세 종류는 사실 두 질문이었다: "저장소가 바뀌었는가"(패널 토큰)와 "내 뒤에 같은 요청이 또 나갔는가"(일련번호·`gitLoadTicket`). 일련번호와 `gitLoadTicket` 은 같은 질문의 두 구현이다. 채널을 모든 요청에 강제하지 않는 이유: History 의 로그·refs·상세 조회는 지금 겹친 요청을 서로 이기게 하지 않는다(`_loadP` 로 따로 줄 세운다). 채널을 붙이면 뒤 요청이 앞 응답을 버려 동작이 바뀐다 |
| D-FEV-2 | `superseded` 와 `stale` 을 따로 둔다 | FR-GRF-24: 겹친 요청에 밀린 응답은 잠금을 건드리지 않고, 낡은 저장소의 응답은 잠금을 놓은 뒤 버린다. 하나로 합치면 이 순서를 지킬 수 없다 |
| D-FEV-3 | `GitListTab` 은 `GitView` 를 상속하고 `ListView` 를 부품으로 든다 | `FE_OBJECT_MODEL.md` 는 §3 표에서 `GitListTab` 을 `ListView` 아래에, §6 단계 5 에서 `GitView` 아래에 두었다(문서 안의 어긋남). 공용 `gitLoadList` 가 세대 가드를 뷰에서 찾으므로 `GitListTab` 은 `GitView` 여야 한다. 둘 다 상속할 수 없고, `GitView extends ListView` 는 목록이 없는 `GitCommit` 에 행 훅을 얹고 상속 깊이를 늘린다. 이 결정으로 `REFACTOR3_FE_LIST_SRS` FR-FEL-5 의 상속을 바꾼다(그 SRS §6 에 적는다) |
| D-FEV-4 | `GitRemote` 는 `GitView` 하위가 아니다. 설계 §3 의 `GitRemote` 자리에는 원격 목록 `GitRemoteList` 가 온다 | `GitRemote` 는 자기 루트가 없고(파일 머리 주석) 칸을 부를 때마다 받는다(`bind(el)`·`paint(el)`). 저장소가 바뀔 때도 `detachRepo()` 로 작업을 놓을 뿐 다시 받지 않는다. 탭 뷰의 수명이 아니다 |
| D-FEV-5 | `GitConsole` 은 `_syncRepo()` 를 쓰지 않는다. 저장소가 바뀌면 지금처럼 패널(`_repoSwitchView`)이 `reset()` 을 부른다 | Console 은 `_repo` 를 들지 않고 받을 때마다 `panel.repo` 를 읽는다. `paint()` 에서 교체를 판정하게 바꾸면 비우는 시점이 "탭을 칠할 때" 로 늦어진다 |
| D-FEV-6 | 수명 이름은 git 뷰의 `mount(el)`·`paint()`·`unmount()` 를 그대로 둔다. 설계의 `render()` 로 바꾸지 않는다 | 패널 셋(`panel-views.js`·`panel-life.js`)과 서술자 표가 이 이름을 부르고, `GitCommit.paint(st)` 는 인자를 받는다. 이름만 바꾸면 위임자가 생길 뿐 얻는 것이 없다. `GitView` 는 `View.mount(host)` 를 덮어 "받은 칸이 곧 루트" 로 쓴다(D-FEL-3 을 일곱 뷰로 넓힌다) |
| D-FEV-7 | `GitCommit._ask` 의 짝 판정에 패널 세대가 더해진다 | 지금은 일련번호와 `this._repo!==repo` 만 본다. `stale(t)` 는 패널 세대도 보므로 저장소가 바뀐 직후 칠하기 전에 온 답도 버린다. 더 엄격해질 뿐 보이는 차이는 없다(INV-V3) |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FEV-1 | 단위: `GitView` 는 `View` 의 하위다. `mount(el)` 뒤 `el` 이 그 칸이고 `_build` 가 한 번 불리며 `_repo` 는 `undefined` 다. `mount(null)` 은 아무것도 하지 않는다. `dispose` 가 칸을 떼지 않는다. `unmount` 뒤 `el`·`_repo` 가 비워진다 |
| TC-FEV-2 | 단위: `_syncRepo` 는 저장소가 같으면 `_adopt` 를 부르지 않고, 다르면 `_adopt` → `reset` → (저장소가 있으면) `_load` 를 부른다. 붙어 있는지를 돌려준다 |
| TC-FEV-3 | 단위: `ticket('x')` 를 두 번 받으면 앞 표는 `superseded`·`stale` 이고 앞 신호는 끊긴다. 채널이 다르면 서로 이기지 않는다. 채널 없는 표는 `superseded` 가 거짓이다. 패널 세대가 바뀌면 모든 표가 `stale` 이다. `dropTicket('x')` 뒤 앞 표는 `superseded` 다 |
| TC-FEV-4 | 단위: `gitLoadList` — 밀린 응답은 `_loading` 을 건드리지 않고, 낡은 응답은 `_loading=false` 를 놓은 뒤 목록을 바꾸지 않으며, 성공은 `_list` 를 채우고 붙어 있으면 `paint` 를 부른다. `gitLoadTicket`·`gitLoadTaken`·`gitViewMounted` 가 정의되지 않는다 |
| TC-FEV-5 | 단위(소스 검사): 일곱 뷰 클래스의 원형 사슬에 `GitView`·`View` 가 있다. 대상 파일(`stash.js`·`branches.js`·`branches-tree.js`·`history*.js`·`console.js`·`commit.js`·`commit-draft.js`·`remote-list.js`·`git-list-tab.js`·`worktrees.js`·`submodules.js`)에 `_el\b`·`_seq\b`·`_askSeq`·`panel.token(`·`panel.isStale(`·`gitLoadTicket` 이 없다. `remote*.js` 넷이 각각 클래스 하나다 |
| TC-FEV-6 | 단위: `GitListTab` 은 `GitView` 하위이고 `rows` 가 `ListView` 인스턴스다. `rows.sig(e)` 가 하위의 `sigParts` 를 `RPT_SEP` 로 이은 값이다(서명 바이트 불변) |
| TC-FEV-7 | e2e(기존): git 탭(history·branches·stash·console·worktrees·submodules·커밋·원격·저장소 전환·새로고침) 관련 spec 이 모양을 바꾸지 않고 통과한다 |

## 5. 동작 변경 기록

| 이전 | 새 | 이유 |
|---|---|---|
| 커밋 답(`_ask`)은 일련번호와 뷰의 `_repo` 만 견줬다 | 패널 세대도 본다 | D-FEV-7. 보이는 차이는 없다 |

## 6. 구현 기록

(구현 커밋에서 채운다.)
