# SRS: 되살리기의 **계기** — 앱당 한 벌의 복귀 신호와 주기를 가진 워치독 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요

### 1.1 목적

접수한 것은 한 줄이다.

> **탭을 한참 두었다 돌아오면 git 화면이 낡은 채로 서 있다. 아무 것도 누르지 않으면
> 영영 그대로다.**

git 실시간 갱신의 주 경로는 서버의 `git_changed` 방송이고(`GIT_PUSH_OBSERVE_SRS`),
**그 방송의 생명선은 브라우저의 `/api/git/status` 요청**이다. 그 요청이 곧 관심
표명이며(`gitapi/handlers_git.go:417` 의 `s.Watch.Note`), 90초 동안 표명이 없으면
서버가 그 저장소 감시를 걷는다 (`hub/gitwatch.go:49` `GitWatchTTL=90s`). 감시는
**저장소 단위**이므로 한 클라이언트가 표명을 멎으면 그 저장소의 방송이 **서버 전체
에서** 멎는다. `Note` 의 호출처는 그 한 곳뿐이다.

서버 경로에는 결함이 없다 — 방송 도착은 런타임 실측으로 확인했고
`e2e/git-push-observe.spec.ts` 는 HEAD 에서 통과한다. 결함은 **브라우저가 표명을
다시 시작하는 계기** 둘이다.

이 문서는 새 기능을 세우지 않는다. `UX_BATCH9_SRS` 묶음 B 가 세운 되살리기 장치
(FR-GLR-1~7)와 `GIT_OBSERVE_REVIVE_SRS` 가 고친 그 장치의 몸통은 그대로 두고,
**그것이 실제로 불리게 하는 계기**를 고친다.

### 1.2 범위

**포함**
- 가시성·포커스 복귀 계기를 **앱당 한 벌**로 세우고 **살아 있는 관측기 전부**에
  닿게 하는 것 (§2.1)
- 워치독에 **주기 계기**를 주는 것. 지금 그것은 렌더에만 얹혀 있어 주기가 없다 (§2.2)
- 서버 감시가 사라지는 두 경로(만료·탈락)를 로그에서 구분하는 것 (§2.4)
- 버스 생명주기 토픽에 **이름공간**을 주는 것 (§2.3 — 구현 중 드러난 결함)

**미포함** — §6 비목표

---

## 2. 현재 상태 (근거)

### 2.1 복귀 계기가 관측기 하나에만 결선돼 있다

문서 리스너(`visibilitychange`·`focus`)를 다는 자리는 앱 전체에 하나다.

```js
// web/js/git/panel-poll.js:205
init(){
  if(this.obs._inited){ this._reschedule(); return }
  this.obs._inited=true;
  const live=()=>this.obs.any();
  document.addEventListener('visibilitychange',()=>{ … });
  window.addEventListener('focus',()=>{ … });
  this._reschedule();
},
```

세 가지가 겹쳐 있다.

1. **가드가 관측기의 것이다** — `this.obs._inited`. 관측기는 저장소마다 서므로
   (FR-SVS-30 개정 · FR-RTU-64) 이 가드는 "앱당 한 번" 이 아니라 **"관측기마다
   한 번"** 이다.
2. **되살리는 대상이 그 관측기뿐이다** — `live=()=>this.obs.any()` 는 리스너를 단
   관측기의 패널 하나를 준다.
3. **호출처가 하나다** — `init()` 을 부르는 자리는 코드베이스 전체에서
   `web/js/core/app-git.js:290` 의 `this.gitPanel.init()` 하나이고,
   `_initGitSection` 은 부팅에서 한 번 돈다 (`app.js:269`).

그리고 `gitPanel` getter 는 `_gitPanel(this._gitRootOfActive(),…)` 이며
(`app-git.js:772`), `_gitRootOfActive()` 는 활성 창이 Repo 창이 아니면 **`''`** 를
준다 (`app-git.js:202`).

**결과**: 부팅 시 활성 창이 터미널이면 리스너는 루트 `''` 의 관측기에 붙고, 사용자가
그 뒤에 여는 저장소의 관측기는 가시성·포커스 계기를 **한 번도 갖지 못한다.** 탭을
90초 넘게 숨겼다 돌아와도 status 가 나가지 않고, 서버 감시는 만료된 채 남는다.

대체 계기는 없다 (전부 확인).

| 후보 | 상태 |
|---|---|
| 버스 생명주기 토픽 | 발행은 된다 (`event-bus.js:122~127`). **구독자가 하나도 없다** — 그 사실이 §2.3 의 지뢰를 가리고 있기도 했다 |
| `_gitRescheduleAll` | 호출처는 사이드 전환·창 전환·git 뷰 탭 개폐뿐 (`app-editor.js:683`, `app-layout.js:286·440·578`). 가시성이 아니다 |
| SSE `sse:open` | 연결이 살아 있으면 발화하지 않는다 |
| 서버 | 관심 복구 계기가 없다 |

### 2.2 워치독이 렌더에만 얹혀 있어 주기가 없다

```js
// web/js/ui/renderer.js:155  (render() 의 끝)
this.app._gitWatchdogAll();
```

이것이 `_gitWatchdogAll` 의 **유일한** 호출처다. `render()` 는 사용자 조작과 SSE
`workspace_changed` 로만 돈다 — 주기적이지 않다. `UX_BATCH9_SRS` D-4 는 "이미 도는
것에 얹는다" 고 했으나 그 계기가 실제로는 성기다.

§2.1 과 겹치면 결과가 확정적이다: 복귀했는데 **아무 조작도 하지 않는** 동안 관측은
영영 낡은 채다. 두 안전망이 같은 조건에서 함께 비어 있다.

### 2.3 버스 토픽과 SSE 명령이 **같은 이름공간**을 쓴다 (구현 중 발견)

§2.1 의 처방(버스 구독)을 넣자 무관해 보이는 검사가 깨졌다 —
`e2e/workspace-identity.spec.ts` 의 TC-SXE-7, "pane 포커스 명령이 두 클라이언트
모두에서 수행된다". 원인은 라우팅의 첫 줄이다.

```js
// web/js/core/event-bus.js  _onMessage
if(this.has(m.action)){ this.publish(m.action, m.args||{}); return }   // ← 여기서 끝난다
if(m.execClientId&&m.execClientId!==this.app.clientId) return;
if(this._fallback) this._fallback(m.action, args);                     // ← 진짜 명령 처리기
```

**구독자가 있는 `action` 은 지명 검사 앞에서 가로채인다** — FR-BUS-5 가 의도한
순서이고 그 자체는 옳다. 문제는 `startLifecycle` 이 발행하던 이름이
`online`·`focus`·`hidden`·`visible` 로 **접두가 없었다**는 것이다. 서버는
`{"action":"focus", …}` 를 보내고 그것이 pane 포커스를 옮긴다
(`app-cmd.js` `_execRemote`). 그러므로 `focus` 토픽을 구독하는 순간 **그 명령이
죽는다.**

이 겹침은 이번에 만들어진 것이 아니다. 넷은 예전부터 그 이름으로 발행됐고, 오늘까지
**구독자가 하나도 없어서** 드러나지 않았을 뿐이다 (`grep` 확인). 이 문서의 구독이
첫 번째였다.

선례는 같은 파일 안에 있다 — `sse:open`. 접두가 있는 토픽은 겹칠 수 없다.

### 2.4 서버 로그가 만료와 탈락을 구분하지 않는다

감시 대상이 사라지는 경로는 둘이다.

```go
// internal/webserver/hub/gitwatch.go:183   TTL 만료
if now.Sub(e.seenAt) > w.ttl { delete(w.watch, repo) }
// internal/webserver/hub/gitwatch.go:246   Tick 읽기 오류로 탈락
if err != nil { delete(w.watch, repo); … }
```

둘 다 조용하다. "방송이 오지 않았다" 를 사후에 조사할 때 **표명이 끊겨 만료된
것인지, `git status` 가 실패해 탈락한 것인지** 로그로 가릴 수 없다.

---

## 3. 요구사항

### 3.1 기능 요구 (Functional)

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-GLW-1 | 가시성·포커스 복귀 계기는 **앱당 한 벌**이고, 살아 있는 **관측기 전부**의 폴링 조건을 다시 보게 한다. 어느 관측기가 먼저 섰는지가 결과를 바꾸지 않는다 | 필수 |
| FR-GLW-2 | 그 계기는 문서·창에 리스너를 새로 달지 않고 `EventBus` 의 생명주기 토픽(`life:visible`·`life:focus`·`life:hidden`)을 지난다. 문서 이벤트는 앱당 한 벌이다 (FR-SVS-30 · FR-BUS-8) | 필수 |
| FR-GLW-3 | **숨김 신호도 같은 자리를 지난다.** 숨으면 전 패널이 조건을 다시 보고 폴링을 걷는다 — 종전 리스너가 하던 일이 빠지지 않는다 (FR-GLR-3 · NFR-RTU-1) | 필수 |
| FR-GLW-4 | 워치독은 **주기 계기**를 갖는다. `GIT_WATCHDOG_CHECK_MS` 마다 `_gitWatchdogAll` 이 돈다. 렌더 훅은 그대로 남는다 | 필수 |
| FR-GLW-5 | 그 주기 계기는 숨김 중에 돌지 않는다 (`whenHidden:'pause'`). 아무도 보지 않는 동안 되살릴 것이 없다 | 필수 |
| FR-GLW-6 | 정상 상태에서 이 두 계기가 내는 git 요청은 **0** 이다. 나이 판정이 앞서 돌아가므로 산술만 돈다 (FR-GLR-7 · FR-GOR-3 계승) | 필수 |
| FR-GLW-7 | 서버는 감시 대상이 사라지는 두 경로 — **TTL 만료**와 **Tick 오류 탈락** — 를 각각 로그 한 줄로 구분해 남긴다 | 필수 |
| FR-GLW-8 | 버스의 **생명주기 토픽 이름은 SSE `action` 이름과 겹치지 않는다.** 그 토픽을 구독해도 같은 이름의 서버 명령이 `_fallback` 에 그대로 닿아야 한다 (FR-BUS-4·5 보강) | 필수 |

### 3.2 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-GLW-1 | 새 종단·새 상태·새 설정을 만들지 않는다. 서버 API 표면은 한 줄도 바뀌지 않는다 |
| NFR-GLW-2 | 복귀 신호 한 번이 내는 요청은 **살아 있는 관측기 수 이하**다. 신호가 관측기 수만큼 되풀이되어서는 안 된다 (FR-SVS-30) |
| NFR-GLW-3 | 새 타이머는 `TimerHub` 를 지난다. `scripts/check-timers.sh` 가 그것을 강제한다 (FR-GTE-2) |
| NFR-GLW-4 | 폴링 주기·백오프·소실 규칙(`_cadence`)과 `_pollOk` 의 판정 의미는 한 줄도 바뀌지 않는다 |

---

## 4. 설계 결정

- **D-1. 계기는 `_initGitSection` 에서 한 번 등록하고 버스 토픽을 지난다.**

  검토한 대안은 `state-registry.js` 의 `git.observe` 항목에
  `revalidateOn:['visible','focus']` 를 더하는 것이었다. **버렸다.** 그 배선은
  `d.restore` 하나만 부르고, git 의 `restore` 는 `_gitObserveRestore` 이며 그것은
  **수집만 한다** (`app-git.js:518`). 우리에게 모자란 절반은 수집이 아니라 **주기의
  재무장**이다. 거기에 재무장을 얹으면 같은 함수를 딛는 `sse:open` 의 의미까지 함께
  바뀐다 (조용한 동작 변경).

  그리고 그 파일이 자기 손으로 경계를 그어 두었다:

  > 안전망 폴링은 여기 없고 `GitObserver` 의 `_applyCadence` 가 갖는다 — 그 계층은
  > 백오프(FR-RMS-22)·소실 고정 주기(FR-RMS-6)·활성 저장소 판정(`_pollOk`)을 함께
  > 쥐고 있어서, 주기만 떼어 올 수 없다. (`state-registry.js:104~106`)

  이 문서가 고치는 것이 정확히 **그 떼어 올 수 없는 계층**이다. 그러므로 자리는
  등록부가 아니라 git 자신의 배선 자리(`_initGitSection`)이고, 그 자리는 이미
  "정적 요소의 리스너를 한 번만 붙이는" 곳이다.

- **D-2. 문서에 리스너를 직접 달지 않는다.** `EventBus.startLifecycle` 이 이미
  `visibilitychange`·`focus` 를 한 번 듣고 세 토픽으로 발행한다
  (`event-bus.js:111~128`, FR-BUS-8). 거기에 구독을 하나 붙이면 FR-SVS-30 이
  **구조적으로** 지켜진다 — 관측기가 몇이든 리스너는 앱에 하나다. §2.1 의 결함은
  그 규칙을 "가드"로 지키려다 가드가 관측기의 것이어서 생긴 일이다.

- **D-3. 되살리기의 수집은 `_gitRescheduleAll` 이 낸다. `signal()` 은 종전대로
  포커스 패널 하나에만 준다.**

  숨김 동안 폴링은 걷혀 있으므로(FR-GLW-3), 복귀 시 `_reschedule()` 은
  `_applyCadence()` 가 참을 돌려주고 **그 자리에서 수집한다** (FR-GIT-22). 보이는
  표면마다 status 가 한 건씩 나가고 그것이 곧 저장소마다의 관심 표명이다 — 필요한
  것은 그것뿐이다.

  관측기 전부에 `signal()` 까지 주면 **보이지 않는 표면**까지 복귀 신호마다 요청을
  하나씩 낸다. 종전 리스너가 `signal()` 을 준 대상도 하나였고, 그 값을 딛는 것은
  상태바 chip 과 사이드바 배지 — 즉 **포커스 패널**이다 (`panel-poll.js` 의 `signal`
  주석). 그래서 넓히는 것은 `_reschedule` 쪽뿐이다 (NFR-GLW-2).

- **D-4. 주기 워치독은 `TimerHub.every` 로 두고 `whenHidden:'pause'` 를 준다.**

  `when` 은 주지 않는다. 이 job 의 콜백(`_gitWatchdogAll`)은 **그 자체가 판정**이고
  (`_gitWdAt` 문턱 → 패널마다 `_watchdog()` → 나이 판정), 조건을 스케줄러로 옮기면
  같은 판단이 두 곳에 서게 된다 (FR-SCH-4 의 정신).

  `whenHidden:'pause'` 인 것은 git status job 이 `'run'` 인 것과 어긋나 보이나 근거가
  다르다. status job 은 "조건이 참이 된 순간 즉시 1회 수집" 이라는 계약을 스케줄러에
  넘길 수 없어서 `'run'` 이다 (`panel-poll.js:320~329`). 워치독은 반대다 — 숨김
  중에는 모든 `_pollOk()` 가 거짓이라 되살릴 것이 **정의상** 없고, 다시 보이는 순간의
  복귀는 FR-GLW-1 의 `visible` 계기가 이미 든다. 두 계기가 그 자리에서 맞물린다.

- **D-5. 렌더 훅을 남긴다.** 검사는 요청을 내지 않으므로 싸고(FR-GLW-6), 표면이 막
  바뀐 직후를 가장 이르게 잡는 것은 여전히 렌더다. 두 계기는 `_gitWdAt` 문턱을
  공유하므로 합쳐도 검사는 `GIT_WATCHDOG_CHECK_MS` 당 한 번을 넘지 않는다.

- **D-7. 생명주기 토픽에 `life:` 접두를 준다** (§2.3).

  대안 셋을 검토했다. ① `_onMessage` 가 `cmd:<action>` 으로 발행하게 하는 것 —
  가장 근본적이지만 `state-registry.js` 의 모든 `events:` 선언과 그 구독자를 함께
  옮겨야 하고, 이 문서의 범위를 크게 넘는다. ② 가로채기를 없애고 명령을 항상
  `_fallback` 에도 흘리는 것 — FR-BUS-5 가 보존한 게이팅 순서를 깨뜨린다
  ("순서를 바꾸면 워크스페이스 변경이 지명받지 못한 클라이언트에 도달하지 않는다").
  ③ git 만 다른 이름을 쓰는 것 — 지뢰를 옮길 뿐 없애지 않는다.

  접두는 **발행하는 쪽 한 곳**(`startLifecycle`)만 고치면 되고, 같은 파일이 이미
  `sse:open` 으로 쓰던 규약이다. 오늘 그 넷의 구독자는 이 문서의 것뿐이므로
  파급도 그것뿐이다. 상수는 `event-bus.js` 에 둔다 — 발행하는 쪽이 거기이고,
  계약 검사가 그 파일 하나만 올려 놓고 돌기 때문이다.

- **D-6. 서버는 로그 두 줄만 는다.** 만료와 탈락은 **다른 사건**이다 — 앞은 브라우저가
  말을 멈춘 것이고 뒤는 저장소가 읽히지 않은 것이다. 사후 조사에서 그 둘을 가르지
  못하면 다음 접수도 같은 자리에서 막힌다. 접두는 `commands.go:202` 의 `[cmd]` 와 같은
  모양으로 `[gitwatch]` 다. 상한 퇴출(cap)은 남기지 않는다 — 그것은 정책이 의도한
  동작이고 `GitWatchCap=16` 에 닿는 일 자체가 드물다.

---

## 5. 검증

| ID | 상황 | 기대 |
|----|------|------|
| TC-GLW-1 | 부팅 뒤 저장소 창을 연다(관측기 둘: `''` 와 그 루트). 그 루트의 폴링을 멎힌 뒤 `window` 에 `focus` | 그 패널의 폴링이 다시 돈다 (FR-GLW-1·2) |
| TC-GLW-2 | 같은 준비에서 `document` 에 `visibilitychange` (보이는 상태) | 같다 (FR-GLW-1·2) |
| TC-GLW-3 | `document.hidden` 을 참으로 두고 `visibilitychange` | 그 루트의 폴링이 걷힌다 (FR-GLW-3) |
| TC-GLW-4 | 렌더를 끊고 폴링을 멎힌 뒤 아무 조작 없이 기다린다 | 주기 계기가 되살린다 (FR-GLW-4) |
| TC-GLW-5 | 주기 job 의 등록 내용 | `whenHidden==='pause'` (FR-GLW-5) |
| TC-GLW-6 | 렌더를 끊고 정상 상태로 기다린다 | status 요청 0건 (FR-GLW-6) |
| TC-GLW-7 | 서버: 표명을 TTL 너머로 묵힌 뒤 `Tick`, 그리고 `Status` 가 오류인 저장소에 `Tick` | 로그에 만료 한 줄·탈락 한 줄이 **서로 다른 문구로** 남는다 (FR-GLW-7) |
| T-14 | 생명주기가 발행하는 토픽 전부를 구독한 상태에서 같은 이름의 SSE 명령 넷을 밀어 넣는다 | 토픽에 전부 접두가 있고, 명령 넷이 `_fallback` 에 닿으며, 생명주기 계기도 살아 있다 (FR-GLW-8) |

기존 TC-GLR-1~4 · TC-GOR-1~7 · T-13 은 그대로 통과해야 한다 (회귀).

---

## 6. 비목표

1. **감시 수명을 SSE 구독에 결선하거나 TTL 을 늘리는 것.** FR-GPO-10 이 "별도 API 를
   만들지 않는다" 로 정한 결정을 뒤집는 일이다. 표명이 status 요청인 한, 고칠 것은
   요청이 나가는 계기이지 수명이 아니다.
2. **`_pollOk` 의 판정 의미 변경** — 숨은 탭에서 폴링을 유지하는 것. FR-GLR-3 이
   그것을 금한다.
3. **적재 시 첫 수집 유실 경로의 특정.** `GIT_OBSERVE_REVIVE_SRS` §6-1 그대로다.
4. **cap 퇴출 로그** (D-6).

---

## 7. 리스크

| ID | 리스크 | 등급 | 완화 |
|----|--------|------|------|
| R-GLW-1 | 복귀 신호가 관측기 수만큼 요청을 낸다 | MEDIUM | D-3 — 넓히는 것은 `_reschedule` 쪽뿐이고 그것은 보이는 표면에만 걸린다. NFR-GLW-2 · TC-GLW-6 |
| R-GLW-2 | 주기 워치독이 새 요청원이 된다 | MEDIUM | 나이 판정(FR-GLR-2)과 시도 문턱(FR-GOR-2)이 앞에 있다. TC-GLW-6 이 0 을 잰다 |
| R-GLW-3 | 숨김 처리가 버스로 옮겨지면서 폴링이 숨김 중에도 남는다 | MEDIUM | FR-GLW-3 · TC-GLW-3 이 그 자리를 직접 잰다 |
| R-GLW-5 | 접두를 놓친 새 생명주기 토픽이 다시 명령을 가로챈다 | MEDIUM | T-14 가 **발행된 토픽 전부**에 접두가 있는지 잰다 — 이름을 검사에 적지 않고 버스에서 받아 오므로 새 토픽도 자동으로 걸린다 |
| R-GLW-4 | 서버 로그가 시끄러워진다 | LOW | 만료는 저장소당 90초에 한 번이 상한이고 탈락은 그 저장소를 대상에서 뺀 뒤이므로 되풀이되지 않는다 |
