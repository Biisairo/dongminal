# SRS: 폴링 주기 설정 — 한 자리에 모으고 죽은 계층을 걷는다 (IEEE 29148)

- 문서 상태: 승인 · **구현 완료** (2026-09-08)
- 접수: 2026-09-08 (요구 ⑪)
- 인계 노트: [`UX_BATCH7_HANDOFF`](./UX_BATCH7_HANDOFF.md) §3.1a

---

## 1. 개요

### 1.1 목적

접수한 말은 하나다.

> ⑪ **"polling 이 한쪽에 모여있잖아? setting 에서 이 값을 조절할 수 있도록."**

앞부분은 이미 참이다 — 주기의 진실은 `STATE_REGISTRY` 의 선언과 `constants-git.js`
의 상수 몇으로 모였다 (EVENT_TIMER_HUB_SRS 가 한 일). 참이 아닌 것은 뒷부분이다:
**여섯 주기 중 둘만 화면에서 바꿀 수 있고, 그 둘조차 서로 다른 탭에 있다.** 나머지
넷은 손잡이가 없어 `settings.json` 을 손으로 고치거나 소스를 고쳐야 바뀐다.

그리고 여섯 중 하나는 **켜지지 않는다** — 서버 push 로 대체된 뒤 0(꺼짐)으로 남은
브라우저 signature 폴링이다. 손잡이를 다는 일의 절반은 **달 자리가 아닌 것을
가려내는 일**이다.

### 1.2 범위

**포함**
- `Polling` 설정 탭 신설과 다섯 주기의 컨트롤
- 흩어져 있던 컨트롤 둘(활동·상태바)의 이전
- `agentsPollMs` 의 저장 자리를 localStorage → 서버 설정으로 이전
- 상수였던 둘(`GIT_REPOS_POLL_MS`·`GIT_CON_POLL_MS`)의 설정 키 신설
- 브라우저 signature 폴링 계층의 **제거**
- 주기 변경이 도는 타이머에 닿는 경로 (발화 없이)

**비포함**
- 서버의 signature 감시자와 `/api/git/signature` 종단 — **남는다** (D-5)
- `_lastSig` 와 그것을 딛는 것들(확인창·히스토리 재조회·다이얼로그 지문) — 남는다 (D-5)
- 실패 백오프·소실 고정 주기 (`GIT_REPO_MISSING_POLL_MS`·`GIT_FAIL_BACKOFF_MAX_MS`) —
  사용자가 정하는 값이 아니다. 그것은 **실패에 대한 정책**이고 기준 주기에서 파생한다
- 열려 있는 편집기 탭의 내용을 디스크에서 다시 읽는 경로 — 지금 없고, 별건이다 (§5)
- `GIT_SIGNAL_DEBOUNCE_MS`(150ms, 즉시 신호 합치기) — 주기가 아니라 합치는 창이다

### 1.3 정의

| 용어 | 정의 |
|------|------|
| **주기** | 브라우저가 서버에 스스로 물어보는 간격. 서버 push 는 주기가 아니다 |
| **안전망 폴링** | push 가 놓친 것을 줍는 그물. git 상태의 30초가 그것이다 |
| **signature 폴링** | 브라우저가 경량 지문을 물어 변화를 **스스로 찾던** 계층. 지금 0 이다 |
| **재무장(refresh)** | 주기가 바뀐 타이머의 다음 마감만 다시 계산하는 일. **발화하지 않는다** |

### 1.4 참조

- [`./EVENT_TIMER_HUB_SRS.md`](./EVENT_TIMER_HUB_SRS.md) — `TimerHub`·`STATE_REGISTRY`
- [`./GIT_PUSH_OBSERVE_SRS.md`](./GIT_PUSH_OBSERVE_SRS.md) — signature 폴링을 대체한 push
- [`./ALERT_MOBILE_CONTEXT_SRS.md`](./ALERT_MOBILE_CONTEXT_SRS.md) FR-SYN-1~7 — 설정 전파
- [`./SETTINGS_PORTABILITY_SRS.md`](./SETTINGS_PORTABILITY_SRS.md) — `BACKUP_KEYS`
- [`./SYSTEM_STATS_SRS.md`](./SYSTEM_STATS_SRS.md) FR-STAT-17 — 숨은 탭에서 멈춤
- [`./GIT_SRS.md`](./GIT_SRS.md) FR-GIT-19·23 — signature 계층과 주기 0 의 뜻

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 주기는 여섯이고 손잡이는 둘이다

| # | 값 | 기본 | 무엇을 묻는가 | 손잡이 | 저장 |
|---|---|---|---|---|---|
| ① | `agentsPollMs` | 5초 | 모든 도구의 활동 스냅샷. agents 패널 카드와 탭의 활동 표시 | Notifications 탭 | **localStorage** |
| ② | `statsInterval` | 3초 | `/api/ping`(지연) + `/api/stats` + git 작업. 하단 상태바 | Status Bar 탭 | 서버 |
| ③ | `gitStatusInterval` | 30초 | git 상태 **안전망**. push 가 놓친 것을 줍는다 | **없음** | 서버 |
| ④ | `gitSignatureInterval` | **0 (꺼짐)** | 경량 지문. 서버 push 로 대체된 잔재 | **없음** | 서버 |
| ⑤ | `GIT_REPOS_POLL_MS` | 3초 | 리포 목록 배지 + 편집기 트리의 git 색·파일 목록 | **없음** | **상수** |
| ⑥ | `GIT_CON_POLL_MS` | 2초 | git 콘솔(명령 로그). 그 탭이 보이는 동안만 | **없음** | **상수** |

배선의 자리:

- ① `state-registry.js:54` — `tool.activity` 의 `every:(app)=>app.agentsPollMs`.
  다섯 상태 중 **유일하게 주기를 갖는다**: 서버가 활동 변화를 전부 SSE 로 밀지 않는다.
- ② `app-statusbar.js:30` — `visiblePoll(statsInterval,…,{immediate:true})`.
- ③④ `panel-poll.js:291` — `_cadence(gitStatusInterval,gitSignatureInterval)` 가
  실효 주기를 내고 `:317·319` 가 두 계층을 건다. **주기 0 은 그 계층을 걸지 않는다**
  (FR-GIT-23).
- ⑤ `app-git.js:370`(리포 목록) 와 `app-editor.js:572`(편집기 트리) 둘이 같은 값을 딛는다.
  후자는 한 틱에 `pollGit()`(git 색)과 `pollStamp()`(겹 지문 → 바뀐 겹만 재조회)를
  함께 부른다. 둘을 한 타이머로 묶은 것은 의도된 것이다 (FR-FSL-7) — 갈리면 "색은
  바뀌었는데 목록은 그대로인" 중간 상태가 보인다.
- ⑥ `console.js:83` — 판정이 `_el.isConnected && .vis` 까지 본다.

### 2.2 ⑤ 와 ⑥ 은 상수여서 설정 블롭에 자리가 없다

③④ 는 `_saveSettings` 가 이미 실어 보내고 `_settingsApply` 가 받는다 —
손잡이만 없다. ⑤⑥ 은 그것조차 없어 **키를 새로 만들어야 한다.**

⑤ 에서 파생하는 것이 셋 있고, 셋 다 `const` 로 **로드 시점에 굳는다**:

| 파생 | 식 | 소비 지점 |
|---|---|---|
| `GIT_BADGE_STALE_MS` | `GIT_REPOS_POLL_MS*4` | `helpers.js:673` (`gitBadgeStale`) |
| `EDITOR_GIT_POLL_MS` | `GIT_REPOS_POLL_MS` | `app-editor.js:572` |
| `EDITOR_GIT_BACKOFF_MS` | `EDITOR_GIT_POLL_MS*10` | `file-tree-paint.js:300` · `file-editor-diff.js:246` |

소비 지점이 넷뿐이므로 **파생을 계수로 남기고 곱셈을 소비 지점으로 옮기면** 설정이
바뀔 때 파생이 따라간다. `EDITOR_GIT_POLL_MS` 는 별칭일 뿐이라 이름이 사라진다 —
"둘이 같아야 한다"(FR-EDT-77)는 요구는 **한 이름을 쓰는 것**으로 더 강하게 지켜진다.

### 2.3 `visiblePoll` 은 값을 닫아 잡는다

`helpers.js:696` 은 `every:()=>ms` 로 **호출 시점의 값**을 고정한다. 그래서 지금
주기를 바꾸는 유일한 길은 `visiblePoll` 을 **다시 부르는 것**이고, `_startStatsPoll`
이 그 선례다. 그 길에는 값이 하나 붙어 온다: `immediate:true` 인 호출부는 설정이
바뀔 때마다 **즉시 1회 요청**을 낸다.

그런데 `TimerHub` 는 그것을 위한 손잡이를 이미 갖고 있다 (`timer-hub.js:76`):

```
refresh:()=>{const j=this._jobs.get(id); if(j) this._arm(j)},
// 주기가 바뀌었음을 알린다. **발화하지 않는다** (FR-SCH-5·FR-RMS-28)
```

`every` 를 함수로 주면 `_arm` 이 매번 재평가한다 (`:82`). 즉 **필요한 것은 이미
있고, `visiblePoll` 이 그것을 가리고 있다.**

### 2.4 ④ 는 켜지지 않은 채로 전부가 성립한다 (실측 2026-09-08)

`git-push-observe.spec.ts` + `git-polling.spec.ts` + `event-timer-hub-contract.spec.ts`
**26건 전량 통과**. 그중 근거가 되는 것:

- `B-1`~`B-3` — 기본 설정(signature 꺼짐)에서 서버 push 로 화면이 따라온다
- `B-4` — push 가 끊겨도 **안전망 폴링이 따라잡는다**
- `B-5` — 변화 없는 10초의 git 요청이 한 자릿수다
- `P1`~`P9` — 클라이언트 감지 규약 전부가 signature 없이 성립한다

즉 이 계층은 **잃을 기능이 없다.** 남겨 두면 손잡이를 달 수 있게 되고, 켜지는 순간
GIT_PUSH_OBSERVE 가 없앤 60초당 120회 요청이 되살아난다.

**다만 `signature` 라는 이름이 붙은 것을 다 지우면 안 된다.** 다음 셋은 성질이 다르다:

| 이름 | 무엇인가 | 판정 |
|---|---|---|
| 서버의 `StartGitWatch` | signature 를 감시해 `git_changed` 를 방송한다 | **push 의 근거다 — 남긴다** |
| `/api/git/signature` 종단 | 공개 API. Go 테스트가 딛고 있다 | **남긴다** |
| `_lastSig` | **status 응답이 실어 오는** 지문. 확인창·히스토리 재조회·다이얼로그 지문이 딛는다 | **남긴다** (`panel-poll.js:384`) |
| `_sigT` | 즉시 신호의 150ms 합치기 창. 이름만 비슷하다 | **남긴다** |

지우는 것은 브라우저의 **폴링 계층**뿐이다: `gitSignatureInterval` ·
`GIT_SIGNATURE_POLL_MS` · `_pollSignature` · `_sigPoll` · `_pollSig` · `_sigBusy` ·
`observer.tick('sig')` 의 갈래.

### 2.5 사용자 결정 (2026-09-08 인터뷰)

- **D-1** **사용하지 않는 것은 지우고 나머지 전부**에 컨트롤을 만든다. ④ 는 없이도
  제대로 동작하는지 **확인한 뒤** 지운다 (§2.4 가 그 확인이다).
- **D-2** 자리는 **새 `Polling` 탭 하나**다. 흩어져 있던 둘(①②)도 그리로 옮긴다.
- **D-3** ① `agentsPollMs` 는 **서버 설정으로 옮긴다.**

### 2.6 설계 결정

- **D-4 선언이 설정을 읽게 한다.** 값을 옮기지 않는다 — 주기의 진실은 여전히
  선언(`STATE_REGISTRY`·`_applyCadence`·`visiblePoll` 호출부)이고, 그 선언이 설정
  변수를 읽을 뿐이다. 전파는 `_settingsApply` 한 자리를 지난다 (FR-SYN-1~7) —
  **새 전파 경로를 만들지 않는다.**
- **D-5 서버의 signature 는 남는다** (§2.4 의 표). 지우는 것은 브라우저 폴링 계층이며,
  `/api/git/signature` 종단 제거는 공개 API 축소여서 이 요구의 범위가 아니다.
- **D-6 값은 드롭다운이다.** 자유 입력은 `100ms` 를 허용하고, 그 값 하나가 서버를
  두들긴다. 선택지는 각 주기의 성질에 맞춰 다르게 준다 — 안전망 30초와 콘솔 2초에
  같은 목록을 주면 목록의 절반이 뜻 없는 값이 된다 (FR-PIS-10).
- **D-7 파생은 계수로 남고 곱셈이 소비 지점으로 간다** (§2.2). `const` 로 굳은
  파생을 두면 설정을 바꿔도 배지의 "낡음" 기준과 백오프가 옛 값에 남는다.
- **D-8 `visiblePoll` 이 함수를 받는다.** 첫 인자가 함수면 `TimerHub` 에 그대로
  넘긴다 (한 줄). 그러면 주기 변경은 재무장으로 닿고 **발화하지 않는다** —
  다른 브라우저 창에서 바뀐 값이 SSE 로 올 때 열려 있는 창 전부가 즉시 요청을
  내는 일이 없다 (§2.3).
- **D-8a 재무장의 진입점은 `TIMERS` 하나다.** 핸들마다 `refresh()` 를 부르는 길은
  핸들에 닿을 수 있는 것에만 통한다 — git 콘솔의 타이머는 `observer → panels →
  panel._consoleView` 세 단 아래에 있고, 그 길을 `_settingsApply` 가 알아야 할
  이유가 없다. 대신 `TimerHub` 가 **마지막으로 건 주기**(`armedMs`)를 기억하고,
  `refreshChanged()` 가 `every()` 의 값이 그것과 다른 job 만 다시 건다.
  안 바뀐 job 의 마감은 손대지 않는다 — 전부 다시 걸면 설정을 한 번 만질 때마다
  모든 폴링의 다음 회차가 뒤로 밀린다.
- **D-9 이사는 한 번이고 조용하다.** localStorage 의 `agentsPollMs` 가 있으면 첫
  부팅에서 서버로 올리고 지운다. 서버에 이미 값이 있으면 서버가 이긴다 — 여러 기기가
  각자 옛 값을 들고 있을 때 마지막에 뜬 기기가 남의 설정을 덮으면 안 된다.
- **D-10 `Polling` 탭은 서술자 배열이 아니다.** 설정 모달의 탭은 `index.html` 의
  `.mtab` 로 손으로 둔다 (기존 아홉이 그렇다) — 사이드바 탭(`SB_TAB_DEFS`)과 다른
  계층이며, 여기서 서술자화를 시작하는 것은 이 요구의 범위가 아니다.

---

## 3. 요구사항

### 3.1 죽은 계층의 제거 (요구 ⑪ 의 절반)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-PIS-1 | 브라우저 signature 폴링 계층을 제거한다: `GIT_SIGNATURE_POLL_MS` · `gitSignatureInterval` · `_pollSignature` · `_sigPoll` · `_pollSig` · `_sigBusy` · `observer.tick('sig')` 의 갈래 · `panel.js` 의 통로 접근자 셋. | 필수 |
| FR-PIS-2 | `_saveSettings` 의 본문과 `_settingsApply` 에서 `gitSignatureInterval` 키가 사라진다. 저장된 옛 값은 **읽지 않고 버린다** — 다시 읽을 계층이 없으므로 남겨도 아무 일도 하지 않는다. | 필수 |
| FR-PIS-3 | 서버의 `StartGitWatch` · `/api/git/signature` 종단 · `_lastSig` · `_sigT` 는 **그대로 남는다** (D-5). `_lastSig` 는 status 응답이 채우므로(`panel-poll.js:384`) 확인창·히스토리 재조회·다이얼로그 지문이 종전과 같이 동작한다. | 필수 |
| FR-PIS-4 | `_cadence(st,sig)` 는 `_cadence(st)` 가 된다 — 실패 백오프와 소실 고정 주기의 규약은 그대로다. | 필수 |
| FR-PIS-5 | 제거 뒤에도 §2.4 의 26건이 통과한다. signature 를 세워 재던 자리(`event-timer-hub-contract` · `git-polling`)는 **함께 고친다** — 회귀가 아니라 제거의 증거다. | 필수 |

### 3.2 주기가 설정이 된다

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-PIS-6 | 다섯 주기가 서버 설정의 키다: `agentsPollInterval` · `statsInterval` · `gitStatusInterval` · `gitReposInterval` · `gitConsoleInterval`. | 필수 |
| FR-PIS-7 | 값을 얹는 자리는 `_settingsApply` **하나**다 (D-4). 부팅 · SSE `settings_changed` · 소프트 리로드가 같은 길을 지난다 — 새 전파 경로를 만들지 않는다. | 필수 |
| FR-PIS-8 | 범위 밖·정수 아님은 **기본값으로 떨어진다.** 손으로 고친 `settings.json` 하나가 초당 폴링을 만들지 않아야 한다 (FR-UFE-12·13 과 같은 근거). 하한은 각 주기의 선택지 최소값이다. | 필수 |
| FR-PIS-8a | **미저장 키는 손대지 않는다** — `saved[key]!==undefined` 가드는 `_settingsApply` 의 다른 설정 전부와 같은 규약이다. 부팅에서는 변수가 이미 상수 기본값이라 결과가 같고, 갱신에서 되돌려 버리면 그 자리에 값을 직접 넣어 둔 쪽의 값을 방송 하나가 지운다. | 필수 |
| FR-PIS-9 | `0` 은 `gitStatusInterval` **하나에서만** 뜻을 갖는다 — "이 계층을 걸지 않는다" (FR-GIT-23). 나머지 넷에는 0 선택지가 없다: 그 넷은 갱신의 **유일한** 경로여서 끄면 화면이 멎는다. | 필수 |
| FR-PIS-10 | 선택지는 주기마다 다르다 (D-6). 안전망(③)은 10·30·60·120초와 `끔`, 콘솔(⑥)은 1·2·5·10초, 나머지 셋은 1·2·3·5·10·30초 계열이다. | 필수 |
| FR-PIS-11 | `GIT_REPOS_POLL_MS` · `GIT_CON_POLL_MS` · `AGENTS_POLL_DEFAULT` 는 **기본값 상수로 남는다.** 설정 변수의 초기값이자 값이 깨졌을 때 돌아갈 자리다 — `gitStatusInterval` 이 이미 그 모양이다. | 필수 |
| FR-PIS-12 | ⑤ 의 파생 셋은 계수로 남고 곱셈이 소비 지점으로 간다 (D-7): `GIT_BADGE_STALE_FACTOR`(4) · `EDITOR_GIT_BACKOFF_FACTOR`(10). `EDITOR_GIT_POLL_MS` 는 별칭이므로 사라지고 소비 지점이 `gitReposInterval` 을 직접 읽는다. | 필수 |
| FR-PIS-13 | `visiblePoll` 의 첫 인자가 함수면 그대로 `TimerHub` 에 넘긴다 (D-8). 값을 주는 기존 호출 방식은 **그대로 동작한다** — 계약이 넓어질 뿐 깨지지 않는다. | 필수 |
| FR-PIS-14 | 주기가 바뀌면 도는 타이머가 **다음 마감부터** 새 주기를 쓴다. 재무장은 `TIMERS.refreshChanged()` 한 줄이며 **발화하지 않는다** (D-8·D-8a) — 30초에서 2초로 내렸을 때 최대 30초를 기다리지 않고, 동시에 열린 창 전부가 즉시 요청을 내지도 않는다. | 필수 |
| FR-PIS-14a | `refreshChanged()` 는 **주기가 실제로 바뀐 job 만** 다시 건다 (D-8a). 안 바뀐 job 의 다음 마감은 그대로다. | 필수 |
| FR-PIS-15 | ③ 의 변경은 종전 경로(`gitPanel._reschedule()`)를 그대로 쓴다 — `_applyCadence` 가 주기를 값으로 읽어 다시 걸고, 그 계층은 백오프·소실 판정·활성 저장소 판정을 함께 쥐고 있어 주기만 떼어 올 수 없다. | 필수 |

### 3.3 `agentsPollMs` 의 이사

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-PIS-16 | ① 의 저장 자리가 서버 설정이 된다 (D-3). 키 이름은 `agentsPollInterval` — 나머지 넷과 어휘를 맞춘다. | 필수 |
| FR-PIS-17 | localStorage 에 옛 값이 있으면 첫 부팅에서 서버로 **한 번** 올리고 지운다. 서버에 이미 값이 있으면 서버가 이긴다 (D-9). | 필수 |
| FR-PIS-18 | `BACKUP_KEYS` 에서 `{store:'local', key:'agentsPollMs'}` 를 뺀다 — 서버 설정은 이식 표의 대상이 아니다 (그 표는 localStorage·sessionStorage 만 담는다). | 필수 |
| FR-PIS-19 | `app.agentsPollMs` 접근자는 남는다 — `state-registry.js:54` 가 그것을 딛고 있고, 이 요구는 **저장 자리**를 옮기는 것이지 선언을 고치는 것이 아니다. | 필수 |

### 3.4 `Polling` 탭

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-PIS-20 | 설정 모달에 `Polling` 탭이 선다. 다섯 컨트롤이 한 화면에 나란히 있다 (D-2). | 필수 |
| FR-PIS-21 | 각 행은 **무엇을 얼마나 자주 묻는지**를 말한다. 값 이름(`gitReposInterval`)이 아니라 사용자가 보는 것("사이드바 변경 개수 배지 · 탐색기 파일 목록과 git 색")으로 적는다. | 필수 |
| FR-PIS-22 | Notifications 탭의 `에이전트 패널 새로고침 주기` 와 Status Bar 탭의 `갱신 주기` 는 **그 자리에서 빠진다** — 같은 값의 손잡이가 두 자리에 있으면 어느 쪽이 진실인지 화면이 말하지 않는다. | 필수 |
| FR-PIS-23 | 탭은 `#modal` 의 고정 크기 안에 든다 (FR-UIK-12·13). 스크롤은 `.modal-body` 하나다. | 필수 |
| FR-PIS-24 | 컨트롤은 공통 키트를 쓴다 — `.ds-row` 골격과 `.sbs-select`(기존 두 자리가 쓰던 것 그대로). 새 클래스를 만들지 않는다. | 필수 |
| FR-PIS-25 | 안내 한 줄이 **폴링이 도는 조건**을 적는다: 숨은 탭·보이지 않는 표면에서는 돌지 않고 돌아오면 즉시 한 번 갚는다 (FR-RST-23). 주기를 늘려도 화면이 낡은 채 남지 않는 이유가 그것이다. | 권장 |

---

## 4. 검증

| ID | 대상 | 검증 방법 |
|----|------|----------|
| V-1 (FR-PIS-1·4) | e2e: `_sigPoll`·`_pollSignature` 가 없고, `gitSignatureInterval` 을 설정에 넣어도 `/api/git/signature` 요청이 0건이다 |
| V-2 (FR-PIS-3) | e2e: status 응답 뒤 `_lastSig` 가 채워지고, 확인창의 지문 비교가 종전대로 동작한다 |
| V-3 (FR-PIS-5) | §2.4 의 26건 통과 (고친 자리 포함) |
| V-4 (FR-PIS-6·7) | e2e: 다섯 키를 `PUT /api/settings` 로 넣으면 다섯 컨트롤의 값이 따라오고, 두 번째 브라우저 창도 SSE 로 따라온다 |
| V-5 (FR-PIS-8·9) | e2e: `gitReposInterval:1` · `"x"` · `-5` 를 넣으면 기본값이 되고, `gitStatusInterval:0` 만 폴링을 끈다 |
| V-5a (FR-PIS-8a) | e2e: 값을 직접 넣어 둔 뒤 그 키가 없는 설정 방송이 와도 넣어 둔 값이 남는다 |
| V-6 (FR-PIS-12) | e2e: `gitReposInterval` 을 바꾸면 `gitBadgeStale` 의 기준과 트리 백오프가 **같은 배수로** 따라간다 |
| V-7 (FR-PIS-13) | 단위: `visiblePoll` 에 값과 함수를 각각 주고 둘 다 도는 것을 잰다 (`event-timer-hub-contract` 의 격리 방식) |
| V-8 (FR-PIS-14) | e2e: 주기를 30초→2초로 내리면 다음 요청이 2초 안에 오고, **내린 순간에는 요청이 나가지 않는다** |
| V-8a (FR-PIS-14a) | 단위: 주기가 다른 job 둘을 걸고 하나만 바꾼 뒤 `refreshChanged()` 를 부르면 그 하나의 `nextAt` 만 움직인다 |
| V-9 (FR-PIS-17) | e2e: localStorage 에 `agentsPollMs` 를 두고 뜨면 서버 설정에 실리고 localStorage 에서 사라진다. 서버에 값이 있으면 서버가 이긴다 |
| V-10 (FR-PIS-20·22) | e2e: `Polling` 탭에 컨트롤 다섯이 있고, Notifications·Status Bar 에는 주기 컨트롤이 **없다** |
| V-11 (FR-PIS-23) | e2e: `Polling` 탭에서도 `#modal` 의 치수가 다른 탭과 같다 |
| V-12 (NFR-1) | `npx playwright test` 전량 통과 |

### 4.1 구현이 남긴 자리 (2026-09-08)

검증은 `poll-interval.spec.ts` 의 스물(PIS1~PIS19 + PIS7a)이다. **이름을 잃은 자리 여섯을
함께 고쳤다** — 회귀가 아니라 제거·개칭의 증거다:

| 자리 | 무엇이 바뀌었나 |
|---|---|
| `event-timer-hub-contract` T-11 | `_cadence(0,500)` → `_cadence(0)`·`_cadence(500)` 둘로 나눠 잰다. 종전에 "켜 둔 계층" 으로 쓰던 것이 signature 였고, 재던 것은 계층 수가 아니라 **0 이 백오프를 이긴다**는 것이었다 |
| `event-timer-hub-contract` 스텁 | `_sigPoll` 필드와 `gitSignatureInterval` 주입을 걷었다 |
| `git-polling` P4·P5·`defaultIntervals` | `gitSignatureInterval` 을 끄던 세 자리. P4 의 signature 카운터는 **남겼다** — 이제 "주기 0 이라 안 돈다" 가 아니라 "계층이 없어 안 돈다" 를 잰다 |
| `git-repo-missing` 두 자리 | 같은 키의 제거 |
| `editor-explorer` 넷 | `EDITOR_GIT_POLL_MS` → `gitReposInterval`. 별칭이 사라졌으므로 검사도 한 이름을 본다 |
| `notes-live-explorer` 주석 | 같은 개칭 |

**이름을 잃은 자리는 e2e 밖에도 있었다.** 다른 SRS 여섯이 그 이름들을 딛고 있어
함께 개정했다 — 스펙이 코드보다 오래 남으므로, 사라진 이름을 가리킨 채 두면 다음
사람이 그것이 아직 무엇을 잡는다고 읽는다:

| 문서 | 무엇을 고쳤나 |
|---|---|
| `GIT_SRS` FR-GIT-18·19 | **감지 3계층 → 2계층.** FR-GIT-19 는 폐기가 아니라 개정이다 — signature 를 쓰는 **주체가 브라우저에서 서버로 옮겼을** 뿐 값 자체는 남는다. 옛 문장은 `FR-GIT-19-old` 로 남겼다 |
| `GIT_PUSH_OBSERVE_SRS` FR-GPO-20 | "없앤다" 가 **이제 문자 그대로다.** 그 조항은 주기를 0 으로 두고 계층은 남겨 "설정으로 되살릴 수 있다" 고 적었는데, 되살릴 수 있다는 것 자체가 위험이었다 |
| `EDITOR_TAB_SRS` FR-EDT-77 | `EDITOR_GIT_POLL_MS` → `gitReposInterval`. "둘이 같아야 한다" 는 요구가 **이름을 하나로 만들어** 더 강하게 지켜진다 |
| `GIT_REPO_MISSING_SRS` FR-RMS-13·14·23 | 백오프·소실 주기의 대상이 두 계층에서 하나가 됐다 |
| `SETTINGS_PORTABILITY_SRS` FR-SPT-2 | 예로 들던 둘이 더는 그 예가 아니다. FR-PIS-18 로 이식 표에서 한 줄이 빠진 것도 함께 적었다 |
| `EVENT_TIMER_HUB_SRS` · `GIT_DIR_ENTRY_SRS` · `NOTES_LIVE_EXPLORER_SRS` · `GIT_REVIEW4_SRS` | 개칭된 이름의 병기 |

소스 주석 셋도 고쳤다 — `constants.js`·`constants-git.js`·`constants-editor.js` 의
**로드 순서 근거**가 `EDITOR_GIT_POLL_MS → GIT_REPOS_POLL_MS` 참조를 들고 있었다.
근거는 여전히 유효하지만(`ED_DD_AXIS` 가 `GIT_AXIS` 를 참조한다) 예로 든 이름이
사라졌고, "버킷을 넘는 참조는 그 하나뿐" 이라는 주장은 애초에 사실이 아니었다.

구현이 밝힌 것 넷:

- **필요한 손잡이가 이미 있었다.** `TimerHub` 핸들의 `refresh()` 가 "주기가
  바뀌었음을 알린다 — 발화하지 않는다" 를 이미 계약으로 갖고 있었고(`timer-hub.js:76`),
  `every` 를 함수로 주면 `_arm` 이 매번 재평가한다. `visiblePoll` 이 `every:()=>ms`
  로 값을 닫아 잡아 그것을 가리고 있었을 뿐이다 (§2.3). 새로 만든 것은
  `armedMs` 와 `refreshChanged()` 뿐이다.
- **`const` 의 TDZ 가 선언 자리를 정했다.** `gitConsoleInterval` 은
  `GIT_CON_POLL_MS`(같은 파일 아래쪽) 뒤에 있어야 한다 — 다른 둘과 나란히 두면
  로드가 `ReferenceError` 로 죽는다. 주석이 그 이유를 그 자리에 적는다.
- **`_pollSignature` 를 지우는 일은 국소적이지 않았다.** 통로 접근자(`panel.js`)·
  관측자 필드(`observer.js`)·전환 시 되돌림(`panel-life.js`)·`tick` 의 갈래가
  함께 걷혀야 했다. 반면 **남겨야 할 것**은 이름이 비슷해 가려내야 했다 —
  `_lastSig`(status 응답이 채운다)와 `_sigT`(150ms 합치기 창)는 성질이 다르다 (§2.4 의 표).
- **`agentsPollMs` 의 setter 가 사라졌다.** 저장 자리가 서버로 가면서 쓰기는
  `POLL_SETTINGS` 의 `set` 을 지나므로, 접근자는 읽기만 남는다 (FR-PIS-19).
- **표로 내리자 `_settingsApply` 의 규약이 하나 어긋날 뻔했다** (FR-PIS-8a).
  첫 판은 `for(const spec of POLL_SETTINGS) spec.set(pollValue(saved[spec.key],spec))`
  였고, 그것은 **미저장 키를 기본값으로 되돌린다.** 이 파일의 다른 설정 전부는
  `saved.x!==undefined` 가드를 쓰며, 그 차이가 실제로 위험했다 — 주기를 화면 안에서
  직접 줄여 놓고 재는 자리가 여섯 있고(`git-polling` 의 `fastSafetyNet` 등), 그 키가
  없는 설정 방송 하나가 그 값을 지우면 그 검사들이 타이밍에 따라 무작위로 깨진다.
  `_settingsApply` 의 머리 주석이 "`saved.x===undefined` 일 때 기본으로 되돌리기는
  부팅과 갱신에서 뜻이 다를 수 있다" 고 이미 적어 둔 자리였다. 가드를 되돌리고
  PIS7a 로 그것을 고정했다.

### 4.2 이 변경이 악화시킨 것 하나

설정 모달의 탭이 아홉에서 **열**이 되면서 `.modal-tabs` 의 가로 넘침이 심해졌다.
잘리는 것은 아니다 — `overflow-x:auto` 가 이미 있어 스크롤된다 (`style.css:604`) —
그러나 **스크롤바가 숨겨져 있어(`scrollbar-width:none`) 넘쳤다는 사실이 보이지
않는다.** 탭이 하나 더 늘면 이 자리는 손을 봐야 한다. 이 요구의 범위는 아니다.

---

## 5. 리스크

- **MEDIUM — e2e 를 함께 고쳐야 한다.** signature 를 세워 재던 자리
  (`event-timer-hub-contract.spec.ts` 의 T-2·T-3 계열, `git-polling.spec.ts` 의
  `patchSettings` 여섯 자리)와 `EDITOR_GIT_POLL_MS` 를 읽던 자리
  (`editor-explorer.spec.ts` 넷)가 이름을 잃는다. 의도된 변경이며 고친 내용이
  곧 새 규약의 증거다.
- **LOW — 주기를 늘리면 체감이 느려진다.** 사용자가 고른 결과이며 FR-PIS-25 의
  안내가 조건을 적는다. 즉시 계기(창 전환·SSE·쓰기 직후)는 주기와 무관하게 남는다.
- **LOW — `0` 의 뜻이 주기마다 다르다.** FR-PIS-9 가 선택지에서 그것을 가른다 —
  뜻이 없는 자리에는 그 선택지를 두지 않는 것이 설명보다 강하다.

### 5.1 이 요구가 드러낸 별건

**열려 있는 편집기 탭의 내용은 디스크에서 다시 읽지 않는다.** `_edDocs` 의 Monaco
모델은 한 번 읽고 그대로이고, `pollStamp` 가 갱신하는 것은 **목록**이지 열린 문서가
아니다 (재읽기 경로가 코드에 없다). 밖에서 파일이 바뀌면 열어 둔 탭은 옛 내용을
보이며, 그 상태로 저장하면 남의 변경을 덮는다. 주기 설정으로 해결되는 문제가
아니므로 이 문서의 범위에 넣지 않았다 — **별건으로 접수해야 한다.**
