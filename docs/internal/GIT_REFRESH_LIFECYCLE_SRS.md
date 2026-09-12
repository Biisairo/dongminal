# SRS: git 갱신·수명 규약 — 멈춘 것은 스스로 돌아오고, 멈춘 사실은 보인다 — IEEE 29148

> **문서 상태**: 초안

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`11-git-polling.md` 가 git 관측·폴링·갱신을 전수 감사해 18건을 확정했다. 그중
**감지(무엇이 바뀌었는가)가 아니라 갱신(그것이 화면에 오는가)** 쪽의 결함이
아홉이다. 본 SRS 는 그 아홉을 닫는다.

증상은 하나로 읽힌다 — **"가끔 안 눌린다 · 화면이 낡았다 · 새로고침해야 돈다."**
원인은 하나가 아니다:

| 갈래 | 결함 |
|---|---|
| **한 번도 시작하지 않는다** | `GP-2` 주기 0 에서 첫 관측이 없다 |
| **한 번 멈추면 돌아오지 않는다** | `GP-3` `_gitMissing` · `GP-5` 무응답 fetch 잠금 · Branches/Stash 의 빈 목록이 굳는다 |
| **멈춘 것이 보이지 않는다** | `GP-4` 낡음 표시가 Changes 한 곳뿐 |
| **갱신이 사용자의 조작을 지운다** | `GP-6` 사이드 DOM 이동 · `GP-9` Branches/Stash 전면 교체 |
| **기록이 사용자의 것이 아니다** | `GP-10` 자동 조회가 쓰기로 분류된다 |
| **절약 장치가 듣지 않는다** | `GP-12` 숨은 탭 · `GP-13` 무효한 백오프 · `GP-14` 취소 없음 |

### 1.2 범위 (Scope)

| 묶음 | 내용 | 감사 ID |
|---|---|---|
| **A** 첫 관측 | 주기 0 이어도 **한 번은** 관측한다 | GP-2 |
| **B** 복귀 | 성공한 관측이 `git_missing` 을 푼다 | GP-3 |
| **C** 시한 | `gitFetch`/`gitPost` 에 기본 시한. 잠금이 영구히 남지 않는다 | GP-5 |
| **D** 낡음 표시 | 소실 안내와 **같은 자리**에서 모든 git 뷰에 걸린다 | GP-4 |
| **E** 사이드 재사용 | `_rSide` 를 `_keep` 으로 — 포커스·선택·진행 중 클릭이 산다 | GP-6 |
| **F** 목록 조정 | Branches·Stash 를 `reconcileList` 로 | GP-9 |
| **G** 재조회 | 빈 목록이 굳지 않는다 — "받은 적 없음" 을 기억하고 다시 받는다 | flaky B6 |
| **H** 쓰기 분류 | `IsWriteCommand` 를 (동사, 하위명령) 쌍으로 | GP-10 |
| **I** 절약 | 숨은 탭의 방송 무시 · 백오프 상한 · 낡은 요청 취소 | GP-12·13·14 |

**미포함**: 감지 계층(`GP-7`·`GP-8`·`GP-11`·`GP-15`~`18`)은
[`./GIT_DETECT_TIER_SRS.md`](./GIT_DETECT_TIER_SRS.md) 다. 레이아웃 보호는
[`./OPTIMISTIC_LAYOUT_SRS.md`](./OPTIMISTIC_LAYOUT_SRS.md) 다.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **관측** | `GET /api/git/status` 한 번과 그 채택. `collect()` 가 그것이다 |
| **첫 관측** | `_lastObsAt` 이 아직 `null` 인 관측기의 관측 |
| **낡음(stale)** | 마지막 관측이 실패했고 화면이 그 이전 값을 보이고 있는 상태 |
| **바깥 계기** | 사용자가 만들지 않은 다시 그리기 — 폴링·서버 푸시·워크스페이스 채택 |
| **쓰기 분류** | Console 목록이 "사용자가 한 일" 을 가리는 기준(`Record.Write`). 실행 게이트(`ExecWrite` 허용목록)와 **다른 것**이다 |

### 1.4 참조 (References)

- [`./GIT_OBSERVE_REVIVE_SRS.md`](./GIT_OBSERVE_REVIVE_SRS.md) FR-GOR-1·D-3 —
  워치독의 계약. 본 SRS 묶음 A 는 그 계약의 **빠진 갈래**를 채운다
- [`./GIT_REPO_MISSING_SRS.md`](./GIT_REPO_MISSING_SRS.md) FR-RMS-29 —
  시한을 status 경로에만 넣었다. 묶음 C 가 나머지에 넣는다
- [`./GIT_REVIEW4_SRS.md`](./GIT_REVIEW4_SRS.md) FR-RPT-1~7 — `reconcileList`
  규약. 묶음 F 는 그것을 **적용하지 않은 두 자리**에 적용한다
- [`./PANE_DOM_RECONCILE_SRS.md`](./PANE_DOM_RECONCILE_SRS.md) — `_keep` 규약.
  묶음 E 는 그 SRS 가 "범위 밖" 으로 남긴 사이드를 거둔다
- [`./GIT_PUSH_OBSERVE_SRS.md`](./GIT_PUSH_OBSERVE_SRS.md) FR-GPO-24 — 백오프가
  "그대로 산다" 고 적었으나 살아 있지 않다 (묶음 I)
- [`./production/11-git-polling.md`](./production/11-git-polling.md) §2·§3·§5 —
  전량의 근거

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 주기 0 은 "끈 것" 이 아니라 "한 번도 안 하는 것" 이 됐다

`panel-poll.js:364` 의 `if(st<=0) return false;` 는 워치독을 통째로 물러나게
한다. 그런데 `_applyCadence` 는 `if(this._pollOn&&this._pollSt===st) return false`
이므로 **`_pollOn=true, _pollSt=0` 이 한 번 서면 그 뒤의 모든 `_reschedule()`
이 거짓을 돌려준다.** 주기 0 에서는 타이머도 없다(`:326` `if(st>0)`). 남는 계기는
포커스·가시성 신호와 새로고침 버튼뿐이고, 그 둘이 오지 않으면 status 는 **0건**
이다 — e2e `git-polling` P4 의 확정 원인이다.

### 2.2 `_gitMissing` 은 생성자에서만 거짓이 된다

`grep -rn "_gitMissing" web/js/` 다섯 건 중 `=false` 는 `observer.js:37`
하나뿐이다. `_applyStatus` 의 성공 경로에도 해제가 없어, 새로고침 버튼으로
목록을 되살려도 자동 갱신은 돌아오지 않는다. 비교 대상인 `_notRepo`·`_missing`
은 둘 다 복구 경로를 갖는다.

### 2.3 `gitFetch` 에는 시한이 없다

`git/api.js:80`·`:105` 는 `AbortSignal` 없이 `fetch` 한다. `FR-RMS-29` 가 이
결함을 **status 경로에서만** 고쳤다(`panel-poll.js:427`). History 는 그 밖의
경로 중 유일하게 **잠금**(`_loading`)을 가지므로, 응답도 거부도 오지 않는 연결
에서 커밋 목록이 영구히 멎는다.

### 2.4 낡음을 그리는 요소가 Changes 골격 안에만 있다

`_staleNote`/`_errMsg` 는 관측기의 값이라 모든 패널이 공유하는데,
`.git-stale-note` 는 `_buildChanges` 안에서만 만들어진다
(`panel-changes.js:193`). History·Branches·Stash·Console·Worktrees·Submodules·
Diff 를 보는 동안에는 **아무 표시 없이 마지막으로 성공한 목록**이 계속 보인다.
소실 안내(`panel-life.js` `_renderMissing`)는 `_render` 한 자리에서 모든 탭에
걸리도록 설계돼 있다 — 낡음만 그 대우를 받지 못한다.

### 2.5 사이드만 `_keep` 밖에 남아 있다

`renderer.js:609-662` 의 `_rSide` 가 매 render 마다 `.ed-side`·`.ed-side-body`·
`.ed-side-tabs` 를 새로 만들고 캐시된 `.git-view` 를 새 body 로 `appendChild`
한다 = 문서에서 떼었다 붙인다. 그때 값으로 되살릴 수 없는 것이 사라진다 —
커밋 메시지 `textarea` 의 **포커스**, 글자 선택, `:hover`, 진행 중 드래그,
그리고 **진입점·새로고침 버튼은 요소 자체가 교체**되므로 mousedown↔mouseup
사이에 render 가 끼면 `click` 이 아예 만들어지지 않는다.

### 2.6 Branches·Stash 만 `innerHTML=''` 로 남아 있다

`branches.js:173`·`stash.js:163`·`:229`. 대조로 Changes·Console·Worktrees·
Submodules·사이드바·상태바·Agents 는 전부 `reconcileList` 를 쓴다. 두 뷰 모두
**바깥 계기로 다시 그려진다** — Branches 는 `paintStatus()` 가 HEAD 변화에서
`_load()`→`paint()`, Stash 는 `_reloadViews`(`panel-poll.js:157`)의 `reload()`.

### 2.7 빈 목록이 굳는다

`branches.js:_load()` 는 `if(res.stale) return;` 으로 빠져나가면서 `_loading`
을 **참으로 남긴다**. 그 뒤에는 `_refs=[]` 이고 `_loading=true` 이며, 목록을
다시 받는 계기는 리포 교체(`_adopt`)와 ref 쓰기(`reload`)뿐이다. `_adopt` 가
리포 없이 도는 회차(`if(!this._repo) return`)도 같은 자리를 남긴다 — 그 상태
에서 관측 signature 가 같으면 `_obsSig` 가드가 `paintAll` 까지 막는다.
flaky `git-branches` B6 이 그 모양이다(행 0, 20초).

### 2.8 Console 이 "사용자의 쓰기 이력" 이 아니다

`IsWriteCommand` 는 `argv[0]` **만** 본다(`core/write.go:52`). 그래서
`write/stash.go:103` 의 `git stash list` 와 `:314` 의 `git stash show` 가
**쓰기로 기록된다**. `panel-poll.js:152-157` 이 관측 회차마다 `_reloadViews()`
로 Stash 를 다시 받으므로, 사용자가 파일 하나를 stage 하면 Console 맨 위는
사용자가 친 적 없는 `stash list` 가 된다.

**증상이 두 자리에 있다** (2026-09-12 확인): `git-console` K2 와
`git-view-refresh` **G3**·**G5**. 셋 다 "Console 맨 위" 를 단언한다.
`git-view-refresh` 의 둘은 이미 `stopConsolePoll(page)` 를 부르는데도 무너졌다 —
끼어든 `stash list` 는 Console 폴링이 아니라 `_reloadViews` 에서 왔다.

### 2.9 절약 장치 셋이 무효하거나 새어 있다

- `app-git.js:544-570` 의 `_onGitChanged` 는 `document.hidden` 도 `_pollOk` 도
  보지 않는다 — 숨은 탭이 낸 status 가 서버의 임대를 계속 살린다
- `_cadence` 의 백오프는 `min(30000*2ⁿ, 30000)` = **항상 30000** 이다
- `AbortController` 가 코드베이스 전체에 없다 — 버려질 요청이 계속 서버에서
  git 을 돌린다

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 첫 관측 (GP-2)

**FR-GRF-1** 주기 `0` 은 *"요청을 주기적으로 내지 않는다"* 이지 *"한 번도
관측하지 않는다"* 가 아니다. 워치독은 `_lastObsAt` 이 `null` 인 관측기에
대해서는 **주기와 무관하게 1회 수집**한다.

**FR-GRF-2** 주기 `0` 에서 워치독은 여전히 **타이머를 걸지 않는다**. 사용자가
끈 것을 되살리지 않는다 (`FR-GIT-23`).

**FR-GRF-3** 그 1회 수집에도 요청 문턱(`_wdTryAt`)이 선다. 주기가 0 이면
문턱의 간격은 기본 status 주기(`GIT_STATUS_POLL_MS`)를 쓴다 — 문턱이 없으면
워치독 회차(1초)마다 한 건이 나간다.

### 3.2 묶음 B — 복귀 (GP-3)

**FR-GRF-4** 성공한 관측은 `_gitMissing` 을 푼다. 자리는 `_notRepo=false` 와
같은 곳(`_applyStatus` 의 성공 경로)이다.

**FR-GRF-5** 풀린 뒤에는 주기를 다시 건다 — 해제만 하고 `_applyCadence()` 를
지나지 않으면 타이머가 걷힌 채 남는다.

### 3.3 묶음 C — 시한 (GP-5)

**FR-GRF-6** git 조회·쓰기에는 **시한이 있다.** 자리는 둘이다:

| 자리 | 대상 |
|---|---|
| `gitFetch`·`gitPost` 의 기본값 | Changes·Branches·Stash·Worktrees·Submodules·Remotes |
| `apiGet` 을 직접 부르는 넷 | History(`_get`) · Console · Diff 뷰 · Diff 패널 |

**뒤의 넷을 놓치면 안 된다** — History 는 `gitFetch` 를 쓰지 않고 `_get` 이라는
자기 얇은 겹을 지난다. `GP-5` 가 지목한 영구 잠금이 바로 그쪽이다.

**장시간 작업(jobs)의 시작·구독(`remote.js`)은 대상이 아니다.** 그 요청은 응답을
기다리는 것이 일이며, 끊으면 화면은 시작하지 않은 것으로 읽고 잡은 계속 돈다.

**FR-GRF-7** 기본값은 **읽기와 쓰기가 다르다.**

| 경로 | 값 | 왜 |
|---|---|---|
| `gitFetch` (읽기) | `GIT_STATUS_FETCH_TIMEOUT_MS` = 20s | status 경로가 이미 쓰던 값. 서버 상한(30s)보다 짧다 — 늦으면 **말하고 다시 묻는다** |
| `gitPost` (쓰기) | `GIT_WRITE_FETCH_TIMEOUT_MS` = 35s | 서버 상한보다 **길다**. 먼저 끊으면 쓰기는 일어나는데 화면은 실패로 읽고, 사용자가 같은 쓰기를 두 번 낸다 |

호출자가 `timeout` 을 주면 그것이 이긴다. `0` 은 "시한 없음" 이다.

**FR-GRF-8** 시한으로 끊긴 요청은 **망 실패와 같은 길**을 간다 — 이전 화면을
지키고 사유를 보인다. 잠금(`_loading`)은 반드시 풀린다.

### 3.4 묶음 D — 낡음 표시 (GP-4)

**FR-GRF-9** 낡음 배너는 **소실 안내와 같은 자리**(`panel-life.js` 의 `_render`)
에서 그려진다. 그러므로 모든 git 뷰에 걸린다.

**FR-GRF-10** 배너의 값은 관측기의 것(`_staleNote`·`_errMsg`)이며 새 상태를
만들지 않는다.

**FR-GRF-11** Changes 뷰의 기존 `.git-stale-note` 는 **사라진다** — 두 벌이면
한쪽만 고쳐진다.

**FR-GRF-12** 소실(`_missing`)이 참이면 소실 안내가 이긴다. 두 안내를 겹쳐
보이지 않는다 — 소실은 확정된 사실이고 낡음은 그 상위 집합이다.

### 3.5 묶음 E — 사이드 재사용 (GP-6)

**FR-GRF-13** `_rSide` 는 `_keep` 으로 골격을 재사용한다. 키는 창과 칸을 함께
든다 — 같은 창이 두 칸에 보일 수 있다.

**FR-GRF-14** 재사용되는 것은 `.ed-side`·`.ed-side-body`·`.ed-side-tabs`·
사이드 탭 버튼·진입점 버튼이다. 갱신되는 것은 라벨·활성 클래스·`hidden` 뿐이다.

**FR-GRF-15** 본문(`.git-view`)은 `p.elFor(view)` 가 주는 캐시된 요소 그대로다.
**이미 그 body 에 붙어 있으면 다시 붙이지 않는다** — `appendChild` 는 같은
부모라도 요소를 떼었다 붙인다.

**FR-GRF-16** 폭 조절 손잡이의 드래그 세션은 render 를 넘어 산다.

### 3.6 묶음 F — 목록 조정 (GP-9)

**FR-GRF-17** Branches 트리와 Stash 목록·미리보기는 `reconcileList` 를 쓴다.

**FR-GRF-18** Branches 는 **세 겹**(그룹 → 접두사 → 행)이며 각 겹이 자기
`reconcileList` 를 갖는다. 겹의 껍데기는 **자기 신원만**으로 판정하고(그래서
개수가 바뀌어도 재생성되지 않는다), 개수·펼침은 껍데기를 되쓴다.

**FR-GRF-19** 행의 판정 근거(`sig`)는 **보이는 값 전부**다 — 이름·현재 표시·
선택·즐겨찾기·ahead/behind·upstream. 좁히면 갱신이 조용히 멈춘다 (`FR-RPT-2`).

**FR-GRF-20** 빈 목록 안내도 같은 목록의 한 항목이다 — 따로 붙이면 다음
조정이 그것을 "규약을 지키지 않는 자식" 으로 지운다.

**FR-GRF-21** `git-repaint.spec.ts` 에 **P14(Branches)·P15(Stash)** 가 더해진다.
그 자리가 비어 있던 것이 이 결함이 오래 산 이유다.

### 3.7 묶음 G — 재조회 (flaky B6)

**FR-GRF-22** Branches·Stash 는 **"이 리포의 목록을 받은 적이 있는가"** 를
기억한다. 값은 받아 본 리포 경로이며, 받기를 끝낸 순간(성공·실패 모두)에 선다.

**FR-GRF-23** `paint()` 는 리포가 있고 아직 받은 적이 없으며 받는 중도 아니면
**다시 받는다.** 실패도 "받은 적 있음" 이므로 실패가 되풀이되지 않는다.

**FR-GRF-24** 낡은 응답(`res.stale`)으로 빠져나갈 때도 `_loading` 은 풀린다.
낡은 응답은 **그 값을 쓰지 않는 것**이지 잠금을 영원히 쥐는 것이 아니다.

### 3.8 묶음 H — 쓰기 분류 (GP-10)

**FR-GRF-25** `IsWriteCommand` 는 **(동사, 하위명령) 쌍**으로 판정한다.
`stash list`·`stash show`·`branch --list|-l|--show-current`·`tag -l|--list`·
`remote -v|--verbose|show` 는 읽기다.

**FR-GRF-26** **실행 게이트는 바뀌지 않는다.** `ExecWrite` 의 허용목록은 여전히
`argv[0]` 로 판정하고 두 목록의 교집합은 비어 있다 (`FR-GIT-95`). 달라지는 것은
**기록의 분류**(`Record.Write`)뿐이다.

**FR-GRF-27** 분류가 바뀌어도 기록 자체는 남는다 — Console 의 "전체" 필터에서
는 여전히 보인다. 사라지는 것은 기본 필터에서의 자리다.

### 3.9 묶음 I — 절약 (GP-12·13·14)

**FR-GRF-28** `_onGitChanged` 는 `document.hidden` 이면 수집하지 않는다. 대신
**되돌아올 때 한 번 갚는다** — `signal()` 이 그 자리다.

**FR-GRF-29** 방송으로 수집하는 패널은 `_pollOk()` 가 참인 것뿐이다.

**FR-GRF-30** 실패 백오프의 상한은 기준 주기보다 **크다**. 값은 5분
(`GIT_FAIL_BACKOFF_MAX_MS`)이며, 30초 기준에서 30초 → 60초 → 120초 → 240초 →
300초로 는다.

**FR-GRF-31** `gitFetch`·`gitPost` 는 **호출자가 준 `AbortSignal` 을 받는다.**
같은 뷰가 새 요청을 내면 앞선 것을 끊는다.

적용 대상은 **목록 재조회** 경로다 — Branches·Stash·Worktrees·Submodules.
**History 는 대상이 아니다**(D-GRF-8a): 그쪽은 `_loading`+`_loadP` 의
single-flight 와 `_sameReq` 의 도착 후 폐기를 함께 갖고, 끊으면 합쳐질 것이
사라진다. History 의 영구 잠금은 묶음 C(시한)가 이미 닫는다.

**끊긴 응답은 실패가 아니라 낡음이다.** `gitFetch` 가 `signal.aborted` 를 보고
`stale:true` 로 접는다 — 실패로 읽으면 화면이 없는 사유를 보인다.

**끊긴 요청은 잠금을 풀지 않는다.** 새 요청이 `_loading=true` 를 세운 **뒤에**
깨어나므로, 세대(`_loadGen`)로 임자를 가린다.

### 3.10 비기능 요구 (Non-functional)

**NFR-GRF-1** 정상 회차에서 요청 수는 **늘지 않는다.** 묶음 A 가 내는 추가
요청은 "한 번도 관측이 없는" 관측기당 최대 1건이다.

**NFR-GRF-2** 묶음 F 의 조정은 항목 수의 선형이며 정렬하지 않는다.

**NFR-GRF-3** 묶음 E 는 DOM 노드 수를 줄인다 — render 마다 만들던 것을 재사용
하므로 GC 압력이 함께 줄어든다.

---

## 4. 설계 결정 (Design Decisions)

**D-GRF-1: 워치독의 `st<=0` 을 "타이머를 걸지 않는다" 로 좁힌다.**
통째로 물러나게 하면 "끈 것을 되살리지 않는다" 는 뜻이 "한 번도 보지 않는다"
가 된다. 사용자가 끈 것은 **주기**이지 관측 자체가 아니다.

**D-GRF-2: 낡음을 소실과 같은 자리에 둔다 (새 계층을 만들지 않는다).**
`_render` 는 이미 모든 뷰가 지나는 목이고 소실 안내가 거기 산다. 다른 자리에
두면 다음 뷰가 늘 때 한쪽만 따라온다 — 이 결함이 생긴 이유가 바로 그것이다.

**D-GRF-3: `_rSide` 의 본문은 옮기지 않는다 — 이미 붙어 있으면 둔다.**
`appendChild` 는 같은 부모라도 `remove`+`insert` 다. 골격만 재사용하고 본문을
매번 다시 붙이면 얻는 것이 없다.

**D-GRF-4: Branches 를 세 겹으로 조정한다 (평평하게 펴지 않는다).**
평평하게 펴면 그룹·접두사의 펼침 상태를 행마다 들고 다녀야 하고, 접힌 그룹의
행을 목록에서 빼는 판단이 렌더러 밖으로 샌다. 겹마다 조정하면 각 겹의 규약이
자기 자리에 남는다.

**D-GRF-5: 쓰기 분류와 실행 게이트를 가른다 (`WriteSpec.ReadOnly` 를 두지
않는다).**
플래그를 두면 호출자마다 그것을 옳게 채워야 하고, 빠뜨린 자리는 조용히 틀린다.
argv 는 이미 그 사실을 담고 있다 — **판정 함수 하나**가 그것을 읽으면 호출자가
할 일이 없다.

**D-GRF-6: 백오프 상한을 올린다 (조항을 폐기하지 않는다).**
`FR-GPO-24` 가 약속한 것은 "실패가 이어지면 뜸해진다" 이고 그것은 여전히 옳다.
무효했던 것은 상한값이지 조항이 아니다.

**D-GRF-7: 숨은 탭의 방송은 버리되 복귀에서 갚는다.**
그냥 버리면 숨은 동안의 변화를 영영 놓친다. `GIT_LIVE_TRIGGERS_SRS FR-GLW-1~3`
이 이미 복귀 신호를 갖고 있으므로 새 장치가 필요 없다.

**D-GRF-9: 읽기의 시한은 서버 상한보다 짧고, 쓰기의 시한은 길다.**
두 실패의 값이 다르다. 늦은 **읽기**를 끊으면 사용자는 낡은 화면과 사유를 보고
다시 물을 수 있다 — 잃는 것이 없다. 늦은 **쓰기**를 끊으면 저장소는 바뀌었는데
화면은 바뀌지 않았다고 말한다. 그 어긋남이 사용자를 같은 쓰기로 두 번 보낸다.
그래서 쓰기는 서버가 먼저 포기하게 두고, 클라이언트의 시한은 *답이 아예 오지
않는 연결*만 걷어내는 그물로 쓴다.

**D-GRF-8: 취소는 목록 재조회에만 넣는다 (status·History 에는 넣지 않는다).**
status 는 single-flight 이고 `_again` 으로 합쳐진다 — 끊으면 합쳐질 것이
사라진다. History 도 같은 성질을 `_loadP`·`_sameReq` 로 갖는다 (D-GRF-8a).
취소가 값을 갖는 곳은 **사용자가 연타할 수 있는** 목록 경로다.

---

## 5. 검증 (Verification)

| ID | 검증 | 자리 |
|---|---|---|
| **V-GRF-1** | `gitStatusInterval:0` 에서 저장소를 열면 status 가 **1회** 나간다 | e2e |
| **V-GRF-2** | 그 뒤 주기 타이머는 서지 않는다 (2주기를 기다려도 추가 요청 0) | e2e |
| **V-GRF-3** | git 을 못 찾은 뒤 성공한 관측 하나가 자동 갱신을 되살린다 | e2e |
| **V-GRF-4** | 응답하지 않는 `/api/git/log` 에서 History 잠금이 시한 뒤 풀린다 | e2e |
| **V-GRF-5** | History 탭을 연 채 관측이 실패하면 **그 탭에** 낡음 배너가 뜬다 | e2e |
| **V-GRF-6** | 소실 안내가 있으면 낡음 배너는 뜨지 않는다 | e2e |
| **V-GRF-7** | 커밋 메시지 입력 중 render 가 와도 **커서가 유지된다** | e2e |
| **V-GRF-8** | Branches 행이 갱신 회차를 넘어 **같은 요소로 남는다** (P14) | e2e |
| **V-GRF-9** | Stash 행이 갱신 회차를 넘어 같은 요소로 남는다 (P15) | e2e |
| **V-GRF-10** | 파일 하나를 stage 한 뒤 Console 맨 위가 `git add` 다 | e2e (K2·G3·G5) |
| **V-GRF-11** | `stash list` 가 `write:false` 로 기록된다 | Go 단위 |
| **V-GRF-12** | `stash push` 는 여전히 `write:true` 다 | Go 단위 |
| **V-GRF-13** | 백오프가 실패 횟수에 따라 실제로 는다 | 프론트 단위 |
| **V-GRF-14** | 숨은 탭은 방송에 수집하지 않고, 돌아오면 한 번 수집한다 | e2e |

---

## 6. 비목표 (Non-goals)

- **낙관적 업데이트 도입** — `11 §6` 이 "없다. 그리고 그것이 옳다" 로 판정했다.
  모든 쓰기가 `post()` 한 곳을 지나 실행 후 status 를 채택하는 구조를 바꾸지 않는다
- **갱신을 미루는 가드** (입력 중에는 칠하지 않는다) — 묶음 E·F 가 보존으로
  같은 값을 얻는다. 미루면 화면이 낡고, 낡은 화면은 이 SRS 가 없애려는 것이다
- **감지 계층** — 별도 SRS
- **`fixtures.ts` 의 재시도 헬퍼 제거** — 묶음 F 가 닫는 것은 목록이고, 탭 바의
  재시도는 그 뒤에 다시 본다
