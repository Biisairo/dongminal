# 11 — git 관측·폴링·갱신 감사

범위: 프론트 `web/js/git/*`·`web/js/core/app-git.js`·`web/js/ui/renderer.js`·`web/js/core/timer-hub.js`,
백엔드 `internal/webserver/hub/gitwatch.go`·`gitapi/`·`domain/git/{query,store,jobs,core,write}`.
기존 173건과 겹치는 것은 ID 참조만 한다 (`GO-33`, `FE-14`, `TEST-5`, `TEST-16`).

**모든 발견은 파일을 읽어 확인한 코드 근거를 단다. 런타임으로 재현하지 않은 것은 그렇게 표시했다.**

---

## 0. 관측 구조 지도 (조사로 확정한 사실)

```
[서버]  StartGitWatch (main.go:543 → hub/gitwatch.go:284)
          └ 1초 티커 → Tick(ctx) → 감시 대상 저장소마다 Store.Status() = **git status 실행**
            → obsMark 비교 → 바뀌었으면 Broadcast({action:"git_changed", repo, mark})
          감시 대상: GET /api/git/status 가 Note() 로 등록 (handlers_git.go:417, 유일한 호출처)
          TTL 90초(GitWatchTTL) · 상한 16(GitWatchCap) · 관측 실패 시 대상에서 제거

[브라우저] GitObserver = **저장소(root)마다 1개** (app-git.js:24)
           GitPanel   = **(root, 슬롯)마다 1개** (app-git.js:108), 관측 상태는 전부 observer 통로
           ① SSE git_changed → _onGitChanged (app-git.js:544) → collect()
           ② 안전망 폴링 gitStatusInterval (기본 30초) → obs.tick() → collect()
           ③ 워치독 1초 (constants-git.js:623) → _watchdog (panel-poll.js:359)
           ④ 즉시 신호 signal() 150ms 디바운스 — visibilitychange·focus (panel-poll.js:219)
           ⑤ 새로고침 버튼 refresh() — 전 뷰 강제 재조회 (panel-poll.js:115)
           ⑥ 사이드바 배지: /api/git/repos?observe=1 3초 폴링 (app-git.js:458) — Note 를 갱신하지 않는다
           ⑦ Console 탭: gitConsoleInterval 자체 폴링 (console.js:83)
```

핵심 의존: **서버 푸시(①)는 브라우저의 status 요청(②·④·⑤)이 90초 안에 한 번은 나가야만 살아 있다.**
`Note()` 호출처가 `apiGitStatus` 하나뿐이기 때문이다.

---

## 1. P0

### [P0] GP-1 — `gitStatusInterval` 을 `끔`/`2분` 으로 두면 **서버 푸시까지 함께 죽는다**

- **위치**
  - `web/js/core/app-polling.js:46-53` — 선택지 `[10초, 30초, 1분, 2분, 끔(0)]`, `off:true`
  - `internal/webserver/hub/gitwatch.go:50` — `GitWatchTTL = 90 * time.Second`
  - `internal/webserver/gitapi/handlers_git.go:417` — `s.Watch.Note(root, obs)` (**유일한 등록/갱신 지점**)
  - `web/js/git/panel-poll.js:326` — `if(st>0) this._stPoll=TIMERS.every(...)`
- **현재 동작**
  `Note()` 는 `GET /api/git/status` 가 도착할 때마다 `seenAt` 을 갱신한다. 그 요청을 내는 정기 경로는
  안전망 폴링 하나뿐이다(`_applyCadence` → `TIMERS.every`). 주기가 `0` 이면 타이머 자체를 걸지 않고,
  `120000` 이면 90초 TTL 보다 길다. 어느 쪽이든 `evictLocked` 가 감시를 걷고
  (`gitwatch.go:169-177`) **`git_changed` 방송이 그 저장소에 대해 영구히 멎는다.**
  `/api/git/repos?observe=1`(3초)은 `gitObservePins` → `Store.Status` 를 직접 부르므로
  `Note` 를 지나지 않는다 (`handlers_git.go:118`) — 갱신 효과가 없다.
- **기대 동작과 근거**
  `GIT_PUSH_OBSERVE_SRS` **FR-GPO-11**: "브라우저의 안전망 폴링(FR-GPO-20)이 그보다 잦으므로,
  보고 있는 동안에는 만료되지 않는다." `gitwatch.go:48-49` 주석도 "브라우저의 안전망 폴링(30초)보다
  세 배 길다" 로 그 전제를 못박는다.
  `POLL_INTERVAL_SETTINGS_SRS` **FR-PIS-9** 는 이 전제를 검증하지 않고 `120초`와 `0`을 추가했다.
  FR-PIS-9 가 "0 을 허용해도 되는" 근거로 든 것은 "나머지 넷은 갱신의 **유일한** 경로여서 끄면
  화면이 멎는다"(즉 gitStatusInterval 은 유일 경로가 아니다)인데, **그 진술이 틀렸다** —
  푸시 경로가 이 폴링에 종속돼 있다.
- **재현 조건**
  1) 설정 → Polling → `git 상태 안전망` 을 `끔`(또는 `2분`)으로 바꾼다.
  2) Repo 창을 열고 Changes 를 보이게 둔다. 창을 떠나지 않고 90초 이상 기다린다
     (탭 전환·창 포커스 이동을 하지 않는다 — 그것이 `signal()` 을 깨워 TTL 을 갱신한다).
  3) 같은 화면의 터미널에서 `touch newfile.txt` / `git commit` 을 실행한다.
  4) 화면이 바뀌지 않는다. `끔`이면 영원히, `2분`이면 최대 2분.
  서버 로그에 `[gitwatch] 관심 표명 만료 — 감시를 걷는다 (repo=… idle=…)` 가 남는다
  (`gitwatch.go:172`) — 이것이 확정 증거다.
- **사용자 영향**: 사용자가 "요청을 줄이려고" 고른 설정이 자동 갱신을 통째로 끈다. 화면에는
  아무 표시도 없다(§GP-4). 접수된 "폴링-업데이트가 미흡하다"의 가장 큰 후보.
- **제안 조치**
  (a) `gitStatusInterval` 선택지에서 `2분`·`끔` 을 제거하거나, 서버 TTL 을 그 최댓값보다 크게 잡는다.
  (b) 더 나은 쪽: **관심 표명을 status 요청에 업지 않는다.** SSE 구독 자체(또는 전용 `keepalive`)를
      Note 의 계기로 삼으면 폴링 주기와 푸시 수명이 분리된다. `_gitObserveRestore`(app-git.js:578)가
      이미 `sse:open` 을 잡고 있으므로 자리도 있다.
  (c) 최소한 `POLL_INTERVAL_SETTINGS_SRS` FR-PIS-9 와 `GIT_PUSH_OBSERVE_SRS` FR-GPO-11 의 충돌을
      문서에서 해소한다.
- **규모**: (a) **S** / (b) **M**

---

## 2. P1

### [P1] GP-2 — 주기 `0` 에서는 워치독이 스스로 물러난다 → 첫 관측을 놓치면 영구 정지

- **위치**: `web/js/git/panel-poll.js:364` (`if(st<=0) return false;`), `:285-330`(`_applyCadence`),
  `:379`(`_reschedule`), `web/js/core/app-git.js:125`
- **현재 동작**
  `_watchdog()` 은 `const st=this._cadence(gitStatusInterval); if(st<=0) return false;` 로
  주기 0 에서 아무 일도 하지 않는다("사용자가 끈 것을 되살리지 않는다").
  한편 `_reschedule()` 은 `_applyCadence()` 가 `true` 를 돌려줄 때만 `collect()` 한다.
  `_applyCadence` 는 `if(this._pollOn&&this._pollSt===st) return false;` 이므로,
  **`_pollOn=true, _pollSt=0` 이 한 번 서면 그 뒤의 모든 `_reschedule()` 이 거짓을 돌려주고
  수집을 하지 않는다.** 주기 0 에서는 타이머도 없으므로(`:326` `if(st>0)`) 남는 계기가
  `signal()`(포커스/가시성, **활성 패널 하나만** — app-git.js:352 주석)과 새로고침 버튼뿐이다.
- **기대 동작**: `GIT_OBSERVE_REVIVE_SRS` FR-GOR-1·D-3 — "타이머는 도는데 답이 오지 않는" 것과
  "타이머가 조용히 걷힌" 것 둘 다 되살린다. 주기 0 은 "요청을 주기적으로 내지 않는다"이지
  "한 번도 관측하지 않는다"가 아니다.
- **재현 조건**: `PUT /api/settings {"gitStatusInterval":0}` → 저장소를 연다 → 패널이 만들어지는
  시점(`gitPanel`:125 의 `_reschedule`)에 그 표면이 아직 화면에 없으면(`_pollOk` 거짓 → `_stop()`)
  이후 포커스 이벤트가 오기 전까지 status 가 **0건**이다.
- **사용자 영향**: e2e `git-polling` **P4** 의 확정 원인 (아래 §5 매핑). 사용자에게는 "안전망을 껐더니
  Changes 가 영영 '불러오는 중'".
- **제안 조치**: `_watchdog` 의 `st<=0` 반환을 "주기를 다시 걸지 않는다"로 좁히고,
  **`_lastObsAt` 이 `null`(한 번도 관측 없음)일 때는 주기와 무관하게 1회 수집**한다.
- **규모**: **S**

### [P1] GP-3 — `_gitMissing` 은 참이 되면 **되돌아오는 코드가 없다** (git 재설치·PATH 복구 후에도 폴링 영구 정지)

- **위치**: `web/js/git/panel-poll.js:576` (`this._gitMissing=true`), `:241` (`_pollOk` 에서 거짓 반환),
  `:221` (`signal()` 조기 반환), `web/js/git/observer.js:37`(생성자에서만 `false`)
- **현재 동작**: 전체 코드베이스에서 `_gitMissing=false` 는 **생성자 한 줄뿐**이다
  (`grep -rn "_gitMissing" web/js/` 결과 5건 확인). `git` 실행 파일을 찾지 못한 응답 한 번이면
  그 저장소의 observer 는 페이지 수명 내내 `_pollOk()===false`·`signal()` 무시 상태가 된다.
  `_applyStatus` 의 성공 경로(`:465-520`)에도 해제가 없어, 새로고침 버튼으로 성공해도
  자동 갱신은 돌아오지 않는다.
- **비교**: `_notRepo`(`:565`)와 `_missing`(`_leaveMissing`, panel-life.js)은 둘 다 복구 경로가 있다.
  `git_missing` 만 빠졌다.
- **재현 조건**: git 이 PATH 에 없는 상태로 저장소를 연다 → git 설치/PATH 수정 → 새로고침을 눌러
  목록이 뜬다 → 이후 터미널에서 파일을 만들어도 자동 갱신이 오지 않는다. (코드 근거로 확정,
  런타임 미확인)
- **제안 조치**: `_applyStatus` 의 성공 경로에서 `this._gitMissing=false` 를 놓고 `_applyCadence()` 를
  지나게 한다 (`_leaveMissing`·`_notRepo=false` 와 같은 자리).
- **규모**: **S**

### [P1] GP-4 — "갱신 실패(낡음)" 표시가 **Changes 뷰 한 곳에만** 있다

- **위치**: `web/js/git/panel-changes.js:193`(`.git-stale-note` 골격은 `_buildChanges` 안에만 존재),
  `:298-300`(칠하기), `constants-git.js:188`(`GIT_STALE_NOTE='갱신 실패'`)
- **현재 동작**: `_staleNote`/`_errMsg` 는 observer 의 값이라 모든 패널이 공유하지만,
  그것을 **그리는 요소는 Changes 골격 안에만 있다.** History·Branches·Stash·Console·Worktrees·
  Submodules·Diff 탭을 보고 있는 동안 망 실패·서버 재시작·권한 상실이 나면 화면은
  **마지막으로 성공한 목록을 아무 표시 없이 계속 보인다.**
  상태바 chip(`updateStatusBar`)에도 stale 표시가 없다.
- **기대 동작**: `GIT_REPO_MISSING_SRS` 의 소실 안내는 `_render` 한 자리에서 **모든 탭**에 걸리도록
  설계돼 있다(panel-life.js `_renderMissing`). 실패/낡음은 같은 대우를 받지 못한다.
- **재현 조건**: Repo 창 → History 탭 → 서버를 죽인다(`dmctl stop`) → 30초 이상 둔다 →
  화면에 아무 변화가 없다. Changes 로 돌아가야만 "갱신 실패"가 보인다.
- **제안 조치**: 소실 분기와 같은 자리(panel-life.js `_render`)에서 stale 배너를 뷰 공통으로 그린다.
- **규모**: **S/M**

### [P1] GP-5 — `gitFetch` 에 시한이 없다 → History 의 `_loading` 잠금이 영구히 남을 수 있다

- **위치**: `web/js/git/api.js:80` (`try{r=await fetch(url)}catch{...}` — `AbortSignal` 없음),
  `web/js/git/history.js:928` (`if(this._loading){ ... return this._loadP }`),
  대조: `web/js/git/panel-poll.js:427` (`AbortSignal.timeout(GIT_STATUS_FETCH_TIMEOUT_MS)`)
- **현재 동작**: `FR-RMS-29` 는 정확히 이 결함("single-flight 인데 답이 오지 않으면 잠금이 영구히
  남는다")을 **status 경로에서만** 고쳤다. `gitFetch`/`gitPost` 를 쓰는 나머지 전부
  (`/api/git/log`, `/api/git/refs`, `/api/git/stash`, `/api/git/records`, `/api/git/worktrees`,
  `/api/git/remotes`, `/api/git/diff` …)에는 시한이 없다.
  History 는 그중 유일하게 **잠금**을 갖는다(`_loading`) — 응답이 오지도 거부되지도 않는
  연결(터널 끊김·Tailscale 재협상·프록시 중단)에서 `finally` 가 실행되지 않아
  **커밋 목록이 영구히 멎는다.** `history.js:970` 주석이 지키려던 것은 "거부"였고 "무응답"이 아니다.
- **재현 조건**: History 탭을 연 상태에서 네트워크를 블랙홀로 만든다(응답도 RST 도 없는 상태).
  이후 커밋을 만들어도 목록이 갱신되지 않고, 좌측 refs(`_loadRefs`, 별도 경로)만 계속 움직인다 —
  `history.js:975` 주석이 접수한 "한쪽만 살아 있는" 모양 그대로다. (코드 근거로 확정, 런타임 미확인)
- **제안 조치**: `gitFetch`/`gitPost` 에 `AbortSignal.timeout(GIT_STATUS_FETCH_TIMEOUT_MS)` 를 기본으로
  넣는다. 상수는 이미 있다.
- **규모**: **S**

### [P1] GP-6 — `_rSide` 가 매 render 마다 사이드를 새로 만들어 **Changes 뷰 DOM 을 이동**시킨다

- **위치**: `web/js/ui/renderer.js:609-662`(`_rSide` — `document.createElement('div')` 로
  `.ed-side`·`.ed-side-body`·`.ed-side-tabs` 를 매번 생성), `:652`(`p.elFor(...)` 로 캐시된
  `.git-view` 를 새 body 에 `appendChild`), `:565-573`(`_rEditorWin` 이 매 render 마다 `_rSide` 호출),
  `:664-678`(`_rSideActions` — 진입점 버튼 6개도 매번 재생성)
- **현재 동작**: 창 골격(`edwin:`)·pane(`pane:`)·탭(`tab:`)은 전부 `_keep` 으로 재사용되지만
  (`PANE_DOM_RECONCILE_SRS`), **사이드만 예외로 남아 있다** — `:571` 주석이 그것을 명시한다:
  "사이드 안쪽은 이 SRS 의 범위 밖이므로 종전대로 매번 세운다".
  `.git-view` 요소 자체는 살아남지만 **다른 부모로 옮겨진다** = 문서에서 떼었다 붙인다.
  이때 값으로 되살릴 수 없는 것이 사라진다:
  - **포커스** — 커밋 메시지 `textarea`(`commit.js:48`)에 커서가 있으면 blur 된다
  - **글자 선택** (`window.getSelection`)
  - 진행 중인 native 드래그 세션, `:hover`, 진행 중 transition, 표시 중 `title` 툴팁
  - **진입점/새로고침 버튼은 요소 자체가 교체**되므로 mousedown↔mouseup 사이에 render 가 끼면
    `click` 이 아예 만들어지지 않는다 (`:641` 새로고침, `:670` 진입점 6개)
  스크롤만은 `_keepScrollAll`/`_restoreScroll`(`:180-210`)이 지킨다 — **대비가 스크롤 하나뿐이다.**
- **폴링과의 관계 (중요)**: git 관측은 `render()` 를 부르지 않는다 —
  `_applyStatus` → `gitReposRefresh` → `_rGitSection()`(=`_rLists`+`_rTopbar`)뿐이다
  (`app-git.js:610-614`, "전체 render() 를 부르지 않는다"). 따라서 **이 결함은 폴링이 아니라
  render 계기(SSE `workspace_changed`, 창/탭/레이아웃 조작)에 걸린다.**
- **재현 조건**: Repo 창의 커밋 메시지 칸에 타이핑 중, 다른 브라우저 창(또는 `dmctl`)에서
  워크스페이스를 바꾼다 → `workspace_changed` → `render()` → 커서가 사라진다. 입력값 자체는
  남는다(`commit.js` 가 `paint` 에서 값을 건드리지 않는다).
- **제안 조치**: `_rSide` 를 `_keep('edwin:'+slot+':'+id+'/side')` 로 재사용하고 탭 바 라벨·활성
  클래스만 갱신한다. `_rTabs`(`:846`)가 이미 그 골격을 보여 준다.
- **규모**: **M**

### [P1] GP-7 — 서버 감시가 `signature` 가 아니라 **`git status`** 를 1초마다 돌린다 — SRS 의 비용 논거가 무효인데 문서는 그대로

- **위치**: `internal/webserver/hub/gitwatch.go:242`(`w.git.Status(ctx, repo)`), `:46`(1초),
  `:66-90`(`obsMark` 가 파일 목록 전체를 해시), 대조 `docs/internal/GIT_PUSH_OBSERVE_SRS.md:22-38`
- **현재 동작**: SRS §1.2 "왜 `fsnotify` 가 아닌가" 의 결정 근거는 **"`ReadSignature` = read 1회 +
  stat 2회 = 0.02ms"** 였다. 구현은 그 자리에서 `Store.Status()` 를 부른다 — TTL 200ms 캐시를
  지나지만 1초 주기에서는 **매 회차 실제 `git status --porcelain=v2` 프로세스가 뜬다.**
  `gitwatch.go:29-36` 이 그 전환 이유(signature 가 작업 트리를 못 본다)를 적어 두었으나
  **SRS §1.2 의 비용표는 갱신되지 않았다.**
  결과: 저장소를 하나 열어 두면 **아무 변화가 없어도 서버가 1초마다 `git status` 를 영구히 실행**한다
  (최대 16개 저장소 동시). 브라우저 폴링은 30초로 줄었으므로 **git 실행 횟수는 종전 대비 그대로거나
  더 많다** — SRS 가 약속한 "비용은 옮겨질 뿐 늘지 않는다"가 성립하지 않는다.
  브라우저가 숨어도 최대 90초(TTL) 동안 계속 돈다.
- **사용자 영향**: 큰 저장소·노트북 배터리·컨테이너에서 상시 CPU/IO. `obsMark` 는 변경 파일이
  수천 개면 그 목록 전체를 매 초 해시한다.
- **제안 조치**: (a) 2단 감지 — `ReadSignature`(0.02ms)를 1초로 돌리고, 값이 바뀌었을 때 + 워크트리
  확인용 저빈도(예: 3~5초) 회차에서만 `git status` 를 돌린다. (b) SRS §1.2 를 실제 구현에 맞게 고친다.
- **규모**: (a) **M** / (b) **S**

### [P1] GP-8 — `Tick` 이 감시 대상을 **순차** 관측한다 → 느린 저장소 하나가 전체 감지를 막는다

- **위치**: `internal/webserver/hub/gitwatch.go:241-268` (`for _, repo := range repos { w.git.Status(...) }`),
  `:284-297`(`time.NewTicker(1s)`)
- **현재 동작**: 최대 16개 저장소를 한 고루틴에서 차례로 `git status` 한다. 저장소 하나가 3초 걸리면
  그 회차 전체가 3초 이상이고, `time.Ticker` 는 밀린 틱을 버리므로 **다른 저장소의 감지가 함께
  늦어진다.** 대조로 `gitObservePins`(`handlers_git.go:123`)는 `gitObserveMax=4` 의 세마포어로
  병렬화돼 있다 — 같은 문제를 아는 자리가 이미 있는데 감시 회차만 순차다.
  `ctx` 는 `context.Background()`(`:291`)라 개별 관측에 시한도 없다 (기존 **GO-33** 과 같은 줄).
- **재현 조건**: 큰 저장소(수만 파일)와 작은 저장소를 두 창에 동시에 연다 → 작은 쪽의 터미널
  변경 감지가 큰 쪽의 `git status` 시간만큼 지연된다. (코드 근거로 확정, 런타임 미확인)
- **제안 조치**: `gitObservePins` 와 같은 세마포어 병렬화 + 회차당 `context.WithTimeout`.
- **규모**: **S**

### [P1] GP-9 — Branches 트리와 Stash 목록이 `innerHTML=''` 로 전면 교체된다 (FR-RPT-3 미적용)

- **위치**: `web/js/git/branches.js:173`(`box.innerHTML=''` in `_paintTree`),
  `web/js/git/stash.js:163`·`:229`(`box.innerHTML=''` in `_paintList`/`_paintPreview`)
  — 대조: `panel-changes.js:427`·`list-tab.js:114`·`ui/repaint.js:61` 은 `reconcileList` 를 쓴다
- **현재 동작**: `GIT_REVIEW4_SRS` FR-RPT-1~7 이 "바깥 계기의 다시 그리기"에서 목록을 비우지 말라고
  정하고 `reconcileList`/`paintIfChanged` 를 공용으로 만들었다(`repaint.js:1-19`).
  Changes·Console·Worktrees·Submodules·사이드바·상태바·Agents 는 그것을 쓴다.
  **Branches 와 Stash 만 옛 방식으로 남아 있다.**
  두 뷰 모두 바깥 계기로 다시 그려진다:
  - Branches: `paintStatus()`(`branches.js:133`) — 관측마다, HEAD 가 바뀌면 `_load()` → `paint()` → `_paintTree()`
  - Stash: `paintStatus()`(`stash.js:106`) + `_reloadViews`(`panel-poll.js:157`)의 `reload()`
  결과: hover, 더블클릭의 첫 클릭, 우클릭 메뉴의 앵커 행, 글자 선택, 다중 선택 체크(`_sel`) 표시가
  갱신 회차마다 끊긴다.
- **검증 공백**: `e2e/git-repaint.spec.ts` 는 Changes 행(P1·P2·P3)·GIT 섹션(P6)·상태바(P7)·
  Console(P8)·Agents(P9)·WINDOWS(P10)를 재렌더 생존으로 검증하지만 **Branches·Stash·History 행은
  대상에 없다.**
- **재현 조건**: Branches 탭에서 브랜치 행에 마우스를 올려 hover 동작 버튼을 띄운 상태로,
  터미널에서 `git checkout -b tmp` 를 친다 → 관측이 닿는 순간 버튼이 손 밑에서 사라진다.
- **제안 조치**: 두 `_paintTree`/`_paintList` 를 `reconcileList` 로 옮기고 `git-repaint.spec.ts` 에
  P14·P15 를 더한다.
- **규모**: **M**

### [P1] GP-10 — Console 이 "사용자의 쓰기 이력"이 아니다: 자동 갱신 조회가 쓰기로 분류돼 맨 위를 차지한다

- **위치**
  - `internal/webserver/domain/git/core/write.go:52-54` — `IsWriteCommand` 는 **`argv[0]` 만** 본다
  - `internal/webserver/domain/git/write/stash.go:103` — `stash list` 를 `ExecWrite` 로 실행
    (`:314` `stash show` 도 같다) → `RecordWrite` → `Write:true`
  - `web/js/git/console.js:114` — 기본 필터 `r.write||r.exitCode!==0||r.err`
  - `web/js/git/panel-poll.js:152-157` — 관측 회차마다 `_reloadViews()` 가 Stash·History·Branches·
    Worktrees·Submodules 를 다시 받는다
- **현재 동작**: `git stash list` 는 읽기지만 `argv[0]==="stash"` 라 **쓰기로 기록**된다.
  `panel-poll.js:157-161` 의 주석 — "Console 은 기본으로 받지 않는다. 그 목록은 dongminal 자신의
  쓰기로만 늘어나고 … 폴링이 받아 봐야 늘 같은 값이다" — 의 전제가 **거짓**이다.
  사용자가 파일 하나를 스테이지하면: `git add` 기록 → `_viewFp` 변화 → `reloadViewsAll()` →
  `stash list` 기록. **Console 맨 위는 사용자가 친 적 없는 `stash list` 가 된다.**
  같은 분류 결함이 `branch --list`·`tag -l`·`remote -v`·`checkout` 계열 읽기에도 걸린다.
- **재현 조건**: Repo 창에서 파일 하나를 stage → Console 탭 → 맨 위 행이 `git stash list …`.
  (e2e `git-console` K2 가 이 자리를 간헐로 잡아 왔다 — §5 매핑 참조.)
- **사용자 영향**: 명령 이력이 자기 조작으로 읽히지 않는다. 감사 목적(무엇을 했나)을 잃는다.
- **제안 조치**: `IsWriteCommand` 를 (동사, 하위명령) 쌍으로 판정한다 —
  `stash list|show`, `branch --list|-l`, `tag -l`, `remote -v|show`, `checkout --` 등은 읽기.
  실행 허용목록(`ExecWrite` 게이트)과 표시 분류를 분리하거나, `WriteSpec` 에 `ReadOnly` 플래그를 둔다.
- **규모**: **S/M**

---

## 3. 상태 보존 표 (요구 B-7·B-8)

갱신 계기를 셋으로 나눠 본다.
**(a) 관측 갱신**(폴링/푸시 → `obs.paintAll()` / `reloadViewsAll()`),
**(b) 전체 render()**(SSE `workspace_changed`·창/탭 조작),
**(c) 뷰 remount**(`built=''` 로 되돌아가는 경로 — `!repo`·`_notRepo`·`_missing`, 그리고 탭이 사라졌다 다시 서는 경우).

| # | 사용자 상태 | (a) 관측 갱신 | (b) render() | (c) 뷰 remount | 근거 |
|---|---|---|---|---|---|
| 1 | Changes 목록 스크롤 | **보존** (reconcileList, 요소 재사용) | **보존** (`_keepScrollAll`/`_restoreScroll`) | 소실 | `panel-changes.js:427`; `renderer.js:180-210` |
| 2 | Changes 행 선택 `_sel` | **보존** (패널 필드, sig 에 포함돼 클래스만 갱신) | **보존** | **보존** (필드는 산다) | `panel.js:79`; `panel-changes.js:449` |
| 3 | 스테이징 대상 = 선택 상태 | **보존** | **보존** | **보존** | 위와 동일 — **체크박스가 아니라 Set 이라 DOM 과 독립** |
| 4 | 펼친 그룹/디렉터리 (`_collapsed`,`_dirCollapsed`) | **보존** | **보존** | **보존** | `panel.js:71-72` |
| 5 | 무한스크롤로 늘린 행 수 `_shown` | **보존** | **보존** | **보존**(리포 전환 시만 초기화) | `panel.js:73`; `panel-life.js:63` |
| 6 | 커밋 메시지 입력값 | **보존** (`paint` 가 값을 건드리지 않음) | **보존** | **소실 후 draft 복원** — 디바운스 저장 전 마지막 타이핑은 잃는다 | `commit.js:8-10,40,130`; `_input` 디바운스 |
| 7 | 커밋 입력 **포커스/커서 위치** | 보존 | **소실** (사이드 DOM 이동) | 소실 | GP-6, `renderer.js:644-655` |
| 8 | 글자 선택 (stderr 복사 등) | Console 은 **보존**(`paintIfChanged`) · Branches/Stash 는 **소실** | **소실** | 소실 | `console.js:139-152`; GP-9 |
| 9 | 열린 컨텍스트 메뉴 | **조건부** — 메뉴 자체는 살지만 앵커 행이 재생성되면 좌표가 어긋난다. 스크롤 복원이 메뉴를 닫는다 | 소실 | 소실 | `git-branch-actions.spec.ts:474-478` 주석이 그 동작을 명시 |
| 10 | 열린 다이얼로그/확인창 | **보존** (별도 오버레이, `GitConfirm.notify`/`GitDialog.notify` 로 대상 변경만 통지) | 보존 | 보존 | `panel-poll.js:528-529` |
| 11 | 마우스 hover 상태 | Changes/Console **보존** · Branches/Stash **소실** · History 행은 `_ver` 가 오를 때 소실 | **소실** | 소실 | GP-9; `history.js:594` |
| 12 | History 스크롤 위치 | **보존** (가상 스크롤, `_top` + 스페이서) | **보존** | **조건부** — 높이 0 이면 `_awaitLayout` 이 rAF 로 최대 60프레임 기다린다 | `history.js:540-575` |
| 13 | History 펼친 커밋 상세 `_open` | **보존** | **보존** | **보존** | `history.js:887` |
| 14 | History 검색/필터 입력 | **보존** | 보존 | 보존 | `history.js:1103` |
| 15 | Branches 검색어 `_q` | **보존** (리포 전환 시만 초기화) | 보존 | 보존 | `branches.js:158-161` |
| 16 | Branches 다중 선택 `_sel` | **보존**(필드) — 다만 행 DOM 이 매번 교체돼 **체크 표시가 깜빡인다** | 소실(hover) | 보존 | `branches.js:37,173` |
| 17 | Diff 뷰 스크롤/커서 | **조건부** — `dirty` 면 재조회 안 함(`panel-diff.js:807`), 아니면 Monaco 모델 교체 | 보존 | 소실 | `panel-diff.js:806-818` |
| 18 | Diff 저장 안 한 편집 | **보존** (`_diffView.dirty` 가 폴링 재조회를 막는다) | 보존 | **소실** (`dropView` 가 `destroy()`) | `panel-diff.js:807`; `panel-life.js:120-131` |
| 19 | Console 펼친 상세 `_open` | **보존** | 보존 | 소실 | `console.js:20,150` |
| 20 | 활성 git 뷰 탭 | 보존 | **조건부** — `_onWorkspaceChanged` 가 서버 레이아웃을 채택하면 **탭이 통째로 사라진다** | — | `app-cmd.js:306-330`; `fixtures.ts:270-273` 이 그 현상을 기록 |

**결론**: 스크롤·선택·펼침처럼 **패널 필드에 사는 상태는 잘 보존된다**(설계가 의도적으로 그렇다).
소실되는 것은 **DOM 에만 사는 상태** — 포커스, 글자 선택, hover, 메뉴 앵커, 그리고 **레이아웃에 사는
탭 자체**다. 그리고 그 소실의 계기는 **폴링이 아니라 render() 와 workspace 재채택**이다.

---

## 4. 감지(관측) 정확성 — 무엇을 놓치는가

`obsMark`(gitwatch.go:76-90) = signature.Value + Oid + Branch + Detached + Ahead + Behind +
(staged/changes/untracked/conflicts 의 경로·XY·Sub 전부).
`signature`(query/signature.go) = `.git/HEAD` 내용 + `index` mtime·size + 현재 브랜치 ref mtime
(없으면 `packed-refs`) + `refs/` **디렉터리** mtime 합 + `refs/` **항목 이름** 해시.

### 감지되는 것 (코드로 확인)
| 외부 조작 | 감지 경로 |
|---|---|
| 작업 트리 파일 생성/수정/삭제 | status 파일 목록 → obsMark |
| `git add` / `reset` | index mtime + status |
| `git commit` / `commit --amend` | HEAD ref mtime + Oid |
| `git checkout` / `switch` | `.git/HEAD` 내용 + Oid + Branch |
| `git branch` / `tag` 생성·삭제 | `refs/` 이름 해시(`RefsShape`) — mtime 지연에 강함 |
| `git fetch` / `push` (원격 ref 이동) | Ahead/Behind |
| 병합 충돌 발생 | Conflicts 목록 (`gitwatch.go:80` 주석이 이 누락을 이미 고쳤다) |
| `git stash push` / `pop` | 작업 트리 변화 |

### [P2] GP-11 — 감지되지 **않는** 변경 (확정 목록)

| # | 외부 조작 | 왜 놓치는가 | 화면 결과 |
|---|---|---|---|
| a | `git stash drop` / `stash clear`(2개 이상 중 하나) | `refs/stash` **파일 내용**만 바뀐다. `refsTree` 는 디렉터리 mtime 과 **이름**만 본다(`signature.go:150-172`) → 이름 그대로, 디렉터리 mtime 그대로 | Stash 목록이 낡은 채 남는다 |
| b | `git remote add/remove/set-url` (터미널) | `.git/config` 는 signature 에 **한 톨도 들어 있지 않다** | Branches 탭의 원격 목록이 낡는다 |
| c | `git config` 전반 (user.name, core.hooksPath …) | 같음 | preflight/gpgSign 표시가 낡는다 |
| d | `git worktree prune` / `remove` (ref 를 남기지 않는 경우) | `.git/worktrees/` 가 signature 밖 | Worktrees 목록이 낡는다 |
| e | `git cherry-pick --quit` / `revert --quit` / 표식 수동 삭제 | `CHERRY_PICK_HEAD` 등 표식 파일은 signature 밖이고 `obsMark` 에 `Operation` 이 **없다** (`gitwatch.go:78-82` 확인) | "진행 중" 바가 남아 있는 채로 굳는다 |
| f | ref 가 **제자리에서** 움직임 (`git update-ref` 로 다른 브랜치를 이동) | `signature.go:132-137` 주석이 이미 남는 한계로 적어 둔 것 | History 의 배지가 낡는다 |
| g | `git bisect start/good/bad/reset` | `DetectOperation`(operation.go:44-50)에 bisect 표식이 없다. HEAD 이동은 잡히지만 **"bisect 중"이라는 사실과 출구가 화면에 없다** | detached HEAD 로만 보이고 나갈 길이 없다 |
| h | 원격 저장소의 새 커밋 (fetch 없이) | 정의상 로컬에서 알 수 없다 — **fsnotify 로도 불가능** | ahead/behind 가 낡는다 (설계상 정상) |
| i | 원격 인증 상태 변화 | 같음 | — |

- **제안 조치**: (a)(d) `refsTree` 에 `refs` 아래 **파일 mtime**을 상한 안에서 접거나,
  `logs/refs/stash` 를 signature 에 더한다 (stat 1회). (b)(c) `.git/config` 의 mtime·size 를
  signature 에 더한다 (stat 1회, 비용 0). (e) `obsMark` 에 `Operation.Kind` 를 더한다 (필드 하나).
  (g) `operationMarkers` 에 `BISECT_LOG` 를 더하고 `git bisect reset` 출구를 준다.
- **규모**: 각 **S**, (g)만 **S/M**

### [P2] GP-12 — `_onGitChanged` 가 `document.hidden` 과 `_pollOk` 를 보지 않는다

- **위치**: `web/js/core/app-git.js:544-570`
- **현재 동작**: 방송은 모든 클라이언트에 간다. 숨어 있는 탭이나 보이지 않는 창의 observer 도
  `p.collect()` 를 낸다. `GIT_LIVE_TRIGGERS_SRS` FR-GLW-3 은 "숨으면 전 패널이 조건을 다시 보고
  폴링을 걷어야 한다"이며 `_gitLifecycle` 이 그것을 하는데, 방송 경로만 그 가드 밖이다.
  부수효과로 **숨은 탭이 낸 status 가 서버의 Note 를 갱신해** 그 저장소의 1초 감시를 계속 살린다.
- **규모**: **S**

### [P2] GP-13 — 실패 백오프가 기본 설정에서 **무효**다

- **위치**: `constants-git.js:611`(`GIT_STATUS_POLL_MS=30000`), `:640`(`GIT_FAIL_BACKOFF_MAX_MS=30000`),
  `panel-poll.js:270-275`(`_cadence`)
- **현재 동작**: `Math.min(st*2**n, GIT_FAIL_BACKOFF_MAX_MS)` = `min(30000*2ⁿ, 30000)` = **항상 30000**.
  기준 주기가 1초일 때 만들어진 상수 쌍이 30초로 올라가며 뜻을 잃었다.
  `GIT_PUSH_OBSERVE_SRS` FR-GPO-24 는 "백오프는 그대로 산다"고 적었지만 살아 있지 않다.
  10초 설정에서만 1단계(20초) 동작한다.
- **규모**: **S** (상한을 5분 등으로 올리거나 조항을 폐기)

### [P2] GP-14 — 낡은 요청을 **취소하지 않는다** (AbortController 부재)

- **위치**: `web/js/git/api.js:80,105`; `web/js/git/panel-poll.js:427`(timeout 전용);
  `history.js:900-905`(`_sameReq` 로 도착 후 폐기)
- **현재 동작**: 순서 역전 방어는 **도착 후 폐기**로 정확히 되어 있다(`_seq`·`_gen`·`requested` echo,
  `_sameReq`). 다만 저장소를 빠르게 갈아타거나 필터를 연타하면 **버려질 요청이 계속 서버에서 git 을
  돌린다.** `AbortController` 는 코드베이스 전체에 없다.
- **규모**: **S/M**

### [P2] GP-15 — status 응답에 **크기 상한이 없다**

- **위치**: `internal/webserver/domain/git/query/status.go`(entries 무제한),
  `gitwatch.go:82-88`(전 항목 해시)
- **현재 동작**: 변경/미추적 파일이 수만 개인 저장소(빌드 산출물, `node_modules` 미무시)에서
  `/api/git/status` 가 그 목록 전체를 JSON 으로 싣는다. 서버는 1초마다 그것을 만들어 해시하고,
  브라우저는 관측마다 `JSON.stringify(d.status)`(`panel-poll.js:512`)로 전체를 문자열화한다.
  History 는 300/100 페이징이 있는데(`GIT_LOG_INITIAL`) status 만 상한이 없다.
- **규모**: **M**

### [P2] GP-16 — 감시 상한 16 초과·퇴출이 **조용하다**

- **위치**: `gitwatch.go:178-189`(`evictLocked` 의 cap 절), 대조 `:170-176`(TTL 만료에는 로그가 있다)
- **현재 동작**: 상한 초과 퇴출에는 로그도 사용자 표시도 없다. 그 저장소는 30초 안전망으로만
  갱신되는데 화면은 정상과 구분되지 않는다.
- **규모**: **S**

### [P2] GP-17 — 빈 저장소(`Initial`)를 프론트가 **읽지 않는다**

- **위치**: `query/status.go:44`(`Initial bool`), `grep -rn "Initial" web/js/git/` → **0건**
- **현재 동작**: 커밋 없는 저장소에서 `git log` 는 exit 128 → `query/log.go:114-117` 이 오류로
  올린다 → `history.js:981` 이 `GIT_HIST_LOAD_FAIL`("불러오지 못했습니다")을 보인다.
  "커밋이 아직 없다"와 "조회에 실패했다"가 같은 문구가 된다. Branches 도 빈 목록이 된다.
  (코드 경로로 확정, 런타임 미확인)
- **규모**: **S**

### [P2] GP-18 — `git am` 진행 중이 `rebase` 로 표시된다

- **위치**: `query/operation.go:47`(`{OpRebase, []string{rebaseMergeDir, rebaseApplyDir}}`)
- **현재 동작**: `rebase-apply` 디렉터리는 `git am` 도 만든다. 화면은 "리베이스 중"으로 적고
  출구 버튼이 `git rebase --continue/--abort` 를 낸다 — `git am` 진행 중에는 그 명령이 맞지 않다.
- **규모**: **S**

---

## 5. flaky 9건 근본 원인 매핑 (요구: 별도 섹션)

**판정: TEST-5 의 "아홉 모두 관측 → 전체 재렌더 → DOM 교체라는 동일 기전"은 절반만 맞다.**
코드를 읽어 보면 기전이 **셋**으로 갈리고, 그중 가장 많은 다섯은 **관측과 무관하다.**

| # | 스펙 | 증상 | 판정 기전 | 코드 근거 | 제품/테스트 |
|---|---|---|---|---|---|
| 1 | `git-console` K2 | 맨 위 행이 `git stash list`(기대 `add`) | **제품 결함 — GP-10.** `stash list` 가 쓰기로 분류되고, `_reloadViews` 가 관측마다 그것을 실행한다 | `core/write.go:52`, `write/stash.go:103`, `panel-poll.js:157` | **제품** |
| 2 | `git-polling` P4 | `openGit` 의 첫 관측 대기 30초 초과 | **제품 결함 — GP-2.** `gitStatusInterval:0` 에서 타이머도 워치독도 없다 | `panel-poll.js:364`, `:295`, `fixtures.ts:676` | **제품** |
| 3 | `git-history` H14 | `.git-hist-opts` **detached** | **뷰 remount / 뷰 요소 제거.** `.git-hist-opts` 는 `mount()` 의 `innerHTML` 로만 만들어진다 → 목록 재칠하기로는 절대 detach 되지 않는다. `_hideOthers` 의 `c.remove()` 또는 `built=''` 재마운트가 유일한 설명 | `history.js:123`(mount 전용), `renderer.js:790-796`(`c.remove()`), `panel-views.js:63` | **제품** |
| 4 | `git-commit-actions` D1 | `.git-view.vis` 15초 미발견 | **뷰/탭 유실.** `_onWorkspaceChanged` 가 서버 레이아웃을 채택하면 방금 연 git 뷰 탭이 사라진다 | `app-cmd.js:306-330`, `app.js:531-556`, `fixtures.ts:270-273` | **제품** |
| 5 | `git-branch-actions` BR11 | `.git-view.vis` 없음, 15초 | 4번과 동일 | 동일 | **제품** |
| 6 | `repo-tab` X4 | `.git-file[data-path]` 없음, 20초 | 4번과 동일 (사이드가 Changes 로 서지 않음) + GP-6 (`_rSide` 재생성) | `renderer.js:609,646-655` | **제품** |
| 7 | `git-head-mobile` V10-13 | 탭 수 `7 → 1` | 4번과 동일. `waitForTimeout(800)` 부족은 **증상이지 원인이 아니다** | `app-cmd.js:306`, `openView`→`addTab`→디바운스 `save` | **제품** |
| 8 | `git-branches` B6 | 행 개수 0 (≥2 기대), 20초 | **제품 결함.** `paint()` → `panel.repo!==this._repo` → `_adopt()` → `reset()` 이 `_refs=[]` 로 비우고, `if(!this._repo) return` 이면 **다시 받지 않는다.** 그 뒤 관측이 같으면 `_obsSig` 가드로 `paintAll` 도 오지 않아 빈 목록이 굳는다 | `branches.js:118-120,145-152,28-38` | **제품** |
| 9 | `git-history` H15 | `.git-hist-loaded` 없음, 20초 | **미확정.** `.git-hist-loaded` 도 `mount()` 전용 요소(`history.js:146`)이므로 3번과 같은 뷰 유실 가족일 가능성이 높으나, GP-5(무응답 fetch 잠금)로도 설명된다. 둘을 가르려면 실패 트레이스의 `/api/git/log` 요청 유무를 봐야 한다 | `history.js:146,928` | **미확정** |

### 결론
- **9건 중 8건이 제품 측 결함으로 설명된다.** "테스트가 취약한 것"이 아니다.
- 기전은 셋:
  1. **뷰/탭 유실** (3·4·5·6·7, 가능성 9) — `_onWorkspaceChanged` 의 서버 레이아웃 채택과
     `_hideOthers` 의 `c.remove()`. **관측과 무관하다.**
  2. **관측 파생 상태 초기화** (8) — `_adopt`/`reset` 이 목록을 비우고 재조회 없이 나간다.
  3. **관측이 만드는 부수 요청** (1) 과 **관측 자체가 서지 않음** (2).
- **`fixtures.ts:224-233` 의 "재렌더는 앱의 정상 동작이므로 견디는 쪽은 테스트다" 는 근거가 없다.**
  git 관측은 `render()` 를 부르지 않고(`app-git.js:610` "전체 render() 를 부르지 않는다"),
  탭 바는 `_rTabs`(`renderer.js:846`)가 이미 reconcile 한다.
  탭이 사라지는 진짜 이유는 **워크스페이스 재채택**이고, 그것은 정상 동작이 아니라 고쳐야 할 자리다.
- **TEST-5 의 조치 (2)("`reconcileList`/탭 바가 노드를 교체하지 않게")는 이 아홉 중 최대 1건에만 닿는다.**
  실제로 필요한 것은 ① 로컬 레이아웃 변경이 서버 채택에 지지 않게 하는 것(낙관적 레이아웃 보호),
  ② GP-2·GP-8(branches `_adopt`)·GP-10 세 개의 국소 수정이다.

---

## 6. 갱신 흐름 — 나머지 항목

### 낙관적 업데이트 (B-9): **없다. 그리고 그것이 옳다.**
모든 쓰기가 `panel-write.js:155-167` 의 `post()` 한 곳을 지나고, 응답에 실린 **실행 후 status** 를
`adopt(d)`(`:193`)로 채택한다. 실패도 status 를 싣고 오므로 충돌로 멈춘 상태가 그대로 반영된다
(`applyWriteFail`). 되돌림 로직이 필요 없는 구조다. **결함 없음.**

### 작업 중 갱신 충돌 가드 (B-10): **부분적**
- `_writing` 가드가 있는 곳: 스테이지/언스테이지/discard(`panel-files.js:20,28,41,220`),
  hunk 적용(`panel-diff.js:601`), 버튼 disabled(`panel-diff.js:554`). — **사용자 조작을 막는 가드**다.
- **갱신을 미루는 가드는 어디에도 없다.** 커밋 메시지 입력 중·메뉴 연 중·행 선택 중에 관측이
  도착하면 그대로 칠한다. Changes 는 reconcileList 로 견디지만 Branches/Stash 는 견디지 못한다(GP-9).
- 다이얼로그만 예외적으로 "대상이 바뀌었다"를 통지받는다(`GitConfirm.notify`/`GitDialog.notify`,
  `panel-poll.js:528`) — 실행을 막지는 않는다(설계 명시).

### 장시간 작업 (B-11): **양호**
`jobs/job.go` — 잡 id, SSE 스트림(`Subscribe`), `Cancel`(`:272`), `WithCeiling` 시한(`:246`),
`cmd.Cancel = group.Terminate`(프로세스 그룹 종료, `:522`). 프론트는 `remote.js` 가 진행 중 상태·
취소 버튼·스트림 재연결 재시도(`:475`)·완료 후 `afterRemoteJob`(Console 재조회)를 갖는다.
**결함 없음.** 다만 잡 완료 후 History/Branches 재조회를 폴링에 맡기는데(`panel-write.js:70-80`),
그 판정 근거가 ahead/behind 이므로 **아무것도 바뀌지 않은 fetch** 는 Console 에만 남는다(의도된 설계).

### 대용량 (B-13)
- Changes: `GIT_FILE_ROW_CHUNK=200` + IntersectionObserver 증분 — 양호.
- History: 300 + 100 페이징, 가상 스크롤 — 양호.
- Console: 500 버퍼 — 양호.
- **status 만 상한이 없다** — GP-15.
- 서버 감시 비용 — GP-7·GP-8.

---

## 7. D. 아키텍처 대안 평가

### D-1. 전제 검증 — **사용자 전제("현재 git 폴링만 한다")는 틀렸다**

`gitwatch.go` 는 **파일시스템 이벤트가 아니라 주기적 관측**이다:
1초 티커(`GitWatchInterval`)로 감시 대상 저장소마다 `Store.Status()` = **`git status` 실행**,
결과를 `obsMark` 로 접어 **직전 값과 다를 때만** `git_changed` 를 SSE 로 방송한다.

프론트와의 관계는 **보완**이다 — 중복이 아니다:
- **서버가 민다** — 실질 감지 주기 1초. 이것이 주 경로다.
- **브라우저가 묻는다** — 30초 안전망. 두 가지를 겸한다:
  ① 푸시가 끊겼을 때의 회복, ② **감시 등록(`Note`)의 갱신** (여기가 GP-1 의 결함 지점).

`01-go-arch.md` 가 지적한 `gitwatch.go:291` 의 `context.Background()`(**GO-33**)는 이 티커의 것이고,
종료 시 진행 중 `git status` 를 취소하지 못한다 — 개별 회차 시한도 없다(GP-8).

**즉 이 프로젝트는 이미 "브라우저 폴링" 에서 "서버 감시 + 저빈도 안전망" 으로 한 번 옮겨 왔다.**
사용자가 겪는 문제는 그 이전 구조의 문제가 아니다.

### D-2. 감지 결함 vs 갱신 결함 — 증상 분류

| 증상 | 감지 결함 | 갱신 결함 | fsnotify 로 해결되는가 |
|---|---|---|---|
| GP-1 설정에 따라 자동 갱신이 통째로 멎음 | ✔ (감시 등록 수명) | | **아니오** — 등록/수명 설계 문제. fsnotify 여도 "누가 보고 있나"는 똑같이 필요하다 |
| GP-2 주기 0 에서 첫 관측 없음 | ✔ | | **아니오** — 클라이언트 스케줄러 문제 |
| GP-3 `git_missing` 영구 정지 | ✔ | | **아니오** |
| GP-11a `stash drop` 미감지 | ✔ | | **예** (`.git/refs/stash` write 이벤트) |
| GP-11b/c `config` 변경 미감지 | ✔ | | **예** (`.git/config` write 이벤트) |
| GP-11d `worktree prune` 미감지 | ✔ | | **예** |
| GP-11e operation 표식 제거 미감지 | ✔ | | **예** |
| GP-11g bisect 미표시 | | ✔ (표시/도메인) | **아니오** |
| GP-11h 원격 커밋 | — | — | **아니오** (fetch 없이는 불가) |
| GP-4 낡음 표시 없음 | | ✔ | **아니오** |
| GP-5 무응답 fetch 잠금 | | ✔ | **아니오** |
| GP-6 사이드 DOM 이동 → 포커스 소실 | | ✔ | **아니오** |
| GP-9 Branches/Stash 전면 교체 | | ✔ | **아니오** |
| GP-10 Console 오분류 | | ✔ | **아니오** |
| flaky #3~9 (뷰/탭 유실) | | ✔ | **아니오** |
| GP-7/8 서버 CPU | ✔ (비용) | | **예** — fsnotify 의 최대 강점 |

**비중: 확인된 18건 중 감지 결함 9 · 갱신(표시/DOM/도메인) 결함 9.
그리고 fsnotify 로 해결되는 것은 9건 중 5건(GP-11a~e)과 비용(GP-7/8)뿐이다 — 전체의 약 1/3.**
**감지를 fsnotify 로 바꿔도 P0(GP-1)·P1 8건 중 6건이 그대로 남는다.**

### D-3. fsnotify 타당성 — 이 프로젝트 조건에서

**결정적 사실 1 — 이 결정은 이미 두 번 검토돼 기각됐고, 근거가 문서에 남아 있다.**
`docs/internal/GIT_PUSH_OBSERVE_SRS.md:22-38` §1.2 "왜 `fsnotify` 가 아닌가":
> `EVENT_TIMER_HUB_SRS` 초안은 이 일을 "서버에 파일 감시를 도입한다" 고 적었다. **틀렸다.**
> … 파일 감시로 바꾸면 이 지식이 버려진다.
그 "지식"은 실측 두 건이다 — `RefsMtimeNs`(부모 디렉터리 mtime)와 `RefsShape`
("Windows 러너에서 `git branch` 뒤 45초 동안 `refs/heads` mtime 이 그대로였다",
`CI_E2E_MATRIX_SRS` FR-CEM-32). **파일시스템의 시각 신호를 믿을 수 없다는 실측이 이미 있다.**

**결정적 사실 2 — 그 기각의 비용 논거는 지금 무효다(GP-7).**
SRS 는 "`ReadSignature` = 0.02ms" 를 근거로 들었으나 구현은 `git status` 를 1초마다 돌린다.
**"싸니까 폴링해도 된다"가 더는 성립하지 않는다.**

**감시 범위**: `.git/` 만으로는 부족하다 — 이 저장소가 `gitwatch.go:29-36` 에서 명시적으로
확인한 사실이다("작업 트리에 파일을 만드는 e2e 가 방송을 받지 못했다"). 워크트리까지 감시해야 하고,
그러면 `.gitignore` 를 fsnotify 계층이 스스로 해석해야 한다(git 이 하던 일을 다시 구현).
**이 저장소 자신(`node_modules`, `playwright-report/`, `test-results/`, `bin/`)이 정확히 그 문제의
사례다** — `e2e/` 실행 중에는 `test-results/` 아래에 초당 수십 파일이 생긴다.

**동시 감시 대상 수**: `GitWatchCap=16`(`gitwatch.go:54`). 창마다 다른 저장소가 가능하고
(`_gitObservers` 는 root 마다, app-git.js:24) 핀 목록도 무제한이므로,
워크트리 재귀 감시 × 16 = macOS FSEvents 스트림 16개 또는 Linux inotify watch 수만 개.

**이벤트 폭풍**: `git status` 하나가 `.git/index` 를 다시 쓰고, 모든 쓰기가 `index.lock` 을
만들었다 지운다. 디바운스·합치기 계층이 **필수**인데 **현재 코드에는 없다** — `obsMark` 비교가
그 역할을 대신하고 있고, 그것은 "값을 다시 읽는" 폴링 모델에서만 성립한다.

**의존성 제약**: 로드맵의 "새 런타임 의존 추가 금지"(`go.mod` 직접 의존 2개 유지)에 걸린다.
표준 라이브러리만의 대안은 결국 **좁힌 주기적 stat** 인데, 그것이 바로 지금의 `ReadSignature` 다 —
**즉 "표준 라이브러리 대안" 은 새 설계가 아니라 이미 있는 것을 다시 켜는 일이다**(D-4 의 (C)).

### D-4. 결론 — 권장안

#### (A) 현행 유지 + 갱신 계층 수정
- **해결**: GP-4·5·6·9·10, flaky 8/9건, 상태 보존 표의 7·8·11·20행
- **남음**: GP-11a~e 미감지, GP-7/8 서버 비용
- **위험**: 낮음. 전부 국소 수정
- **규모**: **M** (GP-6 이 가장 큼)
- **선행 조건**: 없음

#### (B) fsnotify(또는 표준 mtime 감시) + 저빈도 안전망 + 조작 후 즉시 갱신
- **해결**: GP-11a~e, GP-7/8
- **남음**: **P0 GP-1 과 P1 6건이 그대로.** flaky 8건 중 7건 그대로
- **새 위험**: 이벤트 폭풍 디바운스 계층 신설, `.gitignore` 재구현, inotify/FSEvents 한도,
  네트워크 FS·컨테이너 바인드 마운트·심볼릭 링크 워크트리에서 무동작(이 프로젝트는 `/tmp`↔`/private/tmp`
  심링크를 이미 실측으로 밟았다 — `app-git.js:553-561`), 서드파티 의존 추가로 로드맵 제약 위반
- **규모**: **L~XL**
- **선행 조건**: 제약 완화 결정 + 디바운스 설계 + 무동작 환경 폴백(=결국 폴링 유지)

#### (C) 권장 — **2단 감지로 서버 감시를 되돌리고, 갱신 계층을 먼저 고친다**

두 단계로 나눈다. **순서가 요점이다.**

**1단계 (즉시, 규모 M) — 갱신·수명 계층 수정. 감지는 손대지 않는다.**
1. GP-1: 관심 표명을 status 폴링에서 떼어 SSE 구독에 붙이거나, `2분`·`끔` 선택지를 없앤다 (S)
2. GP-2: 워치독이 "한 번도 관측 없음"에서는 주기 0 이어도 1회 수집 (S)
3. GP-3: 성공한 관측이 `_gitMissing` 을 푼다 (S)
4. GP-5: `gitFetch`/`gitPost` 에 시한 (S)
5. GP-4: 낡음 배너를 뷰 공통으로 (S/M)
6. GP-9: Branches/Stash 를 `reconcileList` 로 (M)
7. GP-10: `IsWriteCommand` 를 (동사, 하위명령)으로 (S/M)
8. flaky 뿌리: `_onWorkspaceChanged` 가 **아직 저장되지 않은 로컬 레이아웃 변경을 덮지 않게** 한다
   (탭 추가는 로컬 우선, 서버 스냅샷과 병합). `app.js:531-556` 이 이미 rev 비교로 절반을 하고 있다 (M)
9. GP-6: `_rSide` 를 `_keep` 으로 (M)

**2단계 (1단계 이후, 규모 S/M) — 감지 비용과 구멍만 좁힌다. fsnotify 는 쓰지 않는다.**
10. GP-7: 감시 회차를 **2단**으로 — `ReadSignature`(0.02ms)를 1초로 돌리고,
    ① signature 가 바뀐 회차 ② 그리고 워크트리용 저빈도 회차(3~5초)에서만 `git status`.
    이렇게 하면 `.git` 안의 변화는 지금과 같은 1초 반응을 유지하면서 상시 `git status` 가 사라진다
11. GP-8: 회차 병렬화 + 회차당 시한 (`gitObservePins` 의 세마포어 재사용) (S)
12. GP-11b/c: signature 에 `.git/config` stat 1회 추가 (S)
13. GP-11a/d: `refs/` 파일 mtime 또는 `logs/refs/stash` stat 추가 (S)
14. GP-11e: `obsMark` 에 `Operation.Kind` 추가 (S)

**왜 (B) 가 아닌가 — 근거 넷**
1. **감지를 고쳐도 남는 문제가 다수다** (D-2: 18건 중 12건이 그대로).
   사용자가 겪는 "가끔 안 눌린다·화면이 낡았다"의 8/9 는 갱신·수명 계층에 있다.
2. **fsnotify 가 여는 구멍(GP-11a~e)은 stat 3~4회로 같은 값에 메울 수 있다.** 비용 대비가 압도적이다.
3. **이 저장소는 파일시스템 시각 신호를 믿을 수 없다는 실측을 이미 갖고 있다**
   (Windows 45초 mtime 지연, FR-CEM-32). 그 실측 위에 `RefsShape` 라는 대응책을 세워 두었다.
   fsnotify 로 옮기면 그 지식을 버리고 플랫폼별 한계를 새로 떠안는다.
4. **의존성 제약**(직접 의존 2개 유지)을 깨야 하는데, 깨서 얻는 것이 "1초 `git status` 를 없애는 것"
   하나다. 그 하나는 2단 signature 감지로 **의존성 없이** 얻을 수 있다.

**단, 사용자 제안이 옳게 짚은 것이 하나 있다**: 지금 구조는 **"변경이 없어도 1초마다 git 을 돌린다"** 가
맞다(GP-7). 사용자의 문제 진단은 정확했고, 해법만 갈린다 — 필요한 것은 파일 감시가 아니라
**서버가 원래 쓰기로 했던 signature 를 다시 1차 게이트로 세우는 것**이다.

---

## 8. 특수 git 상태 — 깨지는 것

| 상태 | 판정 | 근거 |
|---|---|---|
| 빈 저장소(커밋 없음) | **깨짐** — History 가 "불러오지 못했습니다"로 표시. `Status.Initial` 을 프론트가 읽지 않는다 (GP-17) | `query/status.go:44`; `web/js/git/` 에 `Initial` 0건 |
| detached HEAD | 양호 — `headName()` 이 `#<oid>` 로 구분(`panel-views.js`), `_commitIsHead` 가 oid 비교 | `panel-views.js:191-195` |
| 병합 충돌 중 | 양호 — Conflicts 그룹 + operation 바 + 출구. `obsMark` 에 Conflicts 포함 | `gitwatch.go:80`; `panel-write.js:214-232` |
| rebase 중 | 양호 — 진행 위치(`at/total`)까지. 단 `git am` 과 구분 못 함 (GP-18) | `operation.go:89-101` |
| cherry-pick / revert 중 | 양호. 단 `--quit` 후 표식만 사라지면 미감지 (GP-11e) | `operation.go:44-50` |
| **bisect 중** | **깨짐** — 감지·표시·출구가 전부 없다 (GP-11g). detached HEAD 로만 보인다 | `operation.go:20-25` 에 bisect 없음; `handlers_git_operation_test.go:46` 이 거부를 검증 |
| **`git am` 중** | **깨짐(표시)** — "리베이스 중"으로 적고 `git rebase --abort` 를 낸다 (GP-18) | `operation.go:47` |
| 서브모듈 | 양호 — `FileEntry.Sub`, Submodules 탭(`list-tab.js` reconcile) | `query/status.go:24` |
| 워크트리 다중 | 양호 — `commonDir` 로 refs 공용 처리. 단 `worktree prune` 미감지 (GP-11d) | `signature.go:88-92` |
| 원격 없음 | 양호 — `HasUpstream:false`, ahead/behind 미표시 | `query/status.go:46` |
| 원격 인증 실패 | 양호 — 잡 실패 화면 + 복사 가능한 명령(`git-job-auth`) | `panel-changes.js:170-178` |
| git 저장소가 아님 | 양호 — `_notRepo` + `git init` 버튼 + 폴링 정지 + 3개 복구 경로 | `panel-poll.js:551-570` |
| 저장소 도중 삭제 | 양호 — `GIT_RMS_CODE` → 소실 안내 + 30초 고정 재확인 + 자동 복구 | `panel-life.js:180-260` |
| **git 실행 파일 없음** | **깨짐** — `_gitMissing` 이 되돌아오지 않는다 (GP-3) | `panel-poll.js:576` |
| **감시 대상 17개 이상** | **조용히 저하** — 가장 오래된 것이 푸시를 잃는다 (GP-16) | `gitwatch.go:178-189` |

---

## 9. P2 카테고리별 개수

| 카테고리 | 건수 | ID |
|---|---|---|
| 감지 구멍 (특정 조작 미감지) | 7 | GP-11 a·b·c·d·e·f·g |
| 서버 감시 비용·건전성 | 3 | GP-7(P1)·GP-8(P1)·GP-16 |
| 클라이언트 스케줄링·수명 | 3 | GP-12·GP-13·GP-14 |
| 대용량·상한 | 1 | GP-15 |
| 특수 상태 표시 | 2 | GP-17·GP-18 |

**P2 총 9건** (GP-11 을 1건으로 세면 5건 · 항목별로 세면 위 표대로).

**대표 5건**: GP-11b(`.git/config` 미감지 → 원격 목록 낡음) · GP-11e(operation 표식 미감지) ·
GP-12(숨은 탭이 방송에 반응) · GP-13(백오프 무효) · GP-15(status 상한 없음).

---

## 10. 미확인 (조사했으나 확정하지 못한 것)

1. **flaky H15** 가 뷰 유실인지 `_loading` 잠금인지 — 실패 트레이스의 `/api/git/log` 요청 유무로만
   갈린다. `playwright-report/data/*.zip` 을 `npx playwright show-trace` 로 열어야 한다.
2. **`_edReconcile` 이 같은 루트의 창을 새 id 로 다시 만드는 빈도** — `app-editor.js:215`,
   `app-cmd.js:326-330`(`_edKeepActive` 주석이 그 사건을 명시한다). 그것이 flaky 4·5·6·7 의
   실제 계기인지는 코드상 가능하나 실행으로 확인하지 못했다.
3. **GP-17(빈 저장소)·GP-3(git_missing)·GP-5(무응답 fetch)** 는 코드 경로로 확정했으나
   런타임 재현은 하지 않았다.
4. **모바일 경로**(`mobileOnSide`, `app-mobile.js`)에서 사이드/본문이 한 번에 하나만 서는 모양의
   `_pollOk` 판정 — 표면이 화면에 없는 동안 `gitSurfaceOn` 이 참을 유지하는지 확인하지 않았다.
5. **`GIT_HIST_LAYOUT_FRAMES=60`** 상한 이후의 복구 경로 — 60프레임 안에 높이가 서지 않는
   화면에서 무엇이 다시 부르는지 추적하지 않았다.
