# SRS: 시간과 전파를 두 클래스가 소유한다 — IEEE 29148

> 상태: **초안**. 착수 전 검토 대상.

> **후속 문서가 이 SRS 의 일부를 보강했다.**
>
> | 보강된 것 | 어떻게 | 어디서 |
> |---|---|---|
> | FR-SCH-3 (마감 힙은 **단일 타이머**) | 그 설계가 성립하려면 모든 job 의 `nextAt` 이 미래여야 한다는 것이 요구로 서 있지 않았다. `_fire` 의 조기 반환 둘이 마감을 과거에 남겨, 조건이 바뀔 때까지 `setTimeout(…,0)` 이 되풀이됐다 (실측 400ms 에 85회) | SCHEDULER_REARM_SRS FR-SRA-1·2 |
> | FR-SCH-6·7 (조건과 겹침 정책) | 판정의 **의미는 그대로**이고, 돌지 않은 회차도 다음 마감을 건다는 것만 명시됐다 | SCHEDULER_REARM_SRS FR-SRA-3·4 |

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

브라우저 쪽 갱신에는 **두 개의 축**이 있다 — *언제* 도는가(시간)와 *무엇이 누구에게*
가는가(전파). 지금 이 두 축은 각각 33개 파일과 13개 `if` 분기에 흩어져 있고,
같은 규약이 서로를 모른 채 최대 **4벌** 재구현돼 있다.

근본 문제는 타이머가 많다는 것이 아니라 — **하나의 상태를 갱신하는 경로가 셋인데
(주기·푸시·복구), 그 셋이 만나는 자리를 아무도 소유하지 않는다는 것**이다.

그 결과가 이미 코드에 기록돼 있다. `app-reload.js` 의 주석이다:

> 이전 동작: `w.editor.refresh()` — `w.editor` 는 창 레코드의 `{root, side}` 라
> `refresh` 가 없고, `typeof` 가드가 그것을 **조용히 삼켰다**
> … 내부 새로고침은 "서버 상태를 다시 받는" 기능인데 탐색기만 낡은 채 남았다

**이 저장소는 이 일을 이미 한 번 시도했다.** `helpers.js` 의 `visiblePoll` 이
그것이고, 다섯 축(visibility · 낡은 응답 폐기 · single-flight · 백오프 · 타임아웃)
중 **첫 하나만** 흡수하고 멈췄다. 그 함수의 주석이 병을 정확히 진단해 놓았다 —
"`console.js` 가 가장 정확한 판정에 도달했다. 그 지식이 나머지 넷에 전파되지 않았다."

이 SRS 는 그 통합을 **끝까지** 밀고, 다시 흩어지지 않도록 CI 게이트로 못박는다.

### 1.2 불변 조항 (Invariant) — 이 문서의 유일한 결론

> **모든 시간과 모든 전파는 한 군데에서 관리할 수 있어야 한다.**

이 조항이 다른 모든 요구사항보다 앞선다. 설계 선택이 갈릴 때 판정 기준은
"어느 쪽이 더 우아한가" 가 아니라 **"어느 쪽이 한 군데에서 관리되는가"** 다.

파생되는 규칙 셋:

| # | 규칙 |
|---|---|
| **INV-1** | 앱의 모든 타이머는 `Scheduler` 를 지난다. API 가 여럿이어도 **주체는 하나**다 |
| **INV-2** | 앱의 모든 이벤트는 `EventBus` 를 지난다. 소스가 여럿이어도 **경유지는 하나**다 |
| **INV-3** | 예외는 **집행 스크립트에 적힌 것뿐**이고, 그 목록은 규칙과 함께 읽힌다 |

INV-3 이 중요하다. 예외를 0 으로 만드는 것이 목적이 아니라 — **예외가 어디에
몇 개인지를 한 군데에서 볼 수 있게 하는 것**이 목적이다. 지금은 33개 파일을
열어야 알 수 있다 (§2.1).

이 조항에 비추어 §6 의 네 결정이 내려졌다. 넷 다 "표면이 늘어도 주체는 하나"
쪽을 골랐다.

### 1.3 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **S** | `Scheduler` — 앱의 모든 시간(주기·1회 지연·프레임)을 소유 | **LOW** |
| **B** | `EventBus` — 앱의 모든 전파(SSE·스케줄·생명주기·사용자 액션)를 소유 | **LOW** |
| **H** | 상태 선언 테이블과 5개 상태 이관 | **MEDIUM** |
| **G** | `check-timers.sh` — "예외 없음" 의 집행 | **LOW** |
| **O** | `GitObserver` 흡수 | **MEDIUM~HIGH** |

**묶음 O 는 이 SRS 의 범위이되 마지막이다.** S~H 가 설계를 검증한 뒤에만 착수한다
(§5). `GitObserver` 는 다섯 축을 **전부** 자체 구현해 둔 유일한 자리이고, 그 각
줄에 실측 근거가 붙어 있다 — 그것을 한 톨이라도 흘리면 이 리팩터는 순손해다.

**범위 밖**: 서버(Go). 서버가 signature 를 감시해 폴링을 푸시로 바꾸는 일은
별개의 SRS 다 (`GIT_PUSH_OBSERVE_SRS`). 다만 이 구조가 그 이관의 **선행 조건**이다 — 상태별 갱신 경로가
한 곳에 선언돼 있어야 `every` 를 지우고 `events` 를 더하는 것으로 옮길 수 있다.

### 1.4 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **시간** | "언제 발화하는가". 주기·1회 지연·다음 프레임. `Scheduler` 소유 |
| **전파** | "무엇이 누구에게 가는가". 발행·구독·순서·중복 해소. `EventBus` 소유 |
| **스냅샷** | 서버가 주는 그 상태의 **전체 판**. `/api/tools/activity` 같은 것 |
| **증분** | SSE 가 나르는 **변화 한 조각**. `tool_activity` 같은 것 |
| **재검증(revalidate)** | 스냅샷을 다시 받는 일. 계기는 재연결·소프트리로드·복귀·주기 |
| **경쟁** | 스냅샷 비행 중에 증분이 도착하는 것. 늦게 온 스냅샷이 더 새로운 증분을 덮는다 |
| **집행(enforcement)** | 규약을 문서가 아니라 CI 가 지키게 하는 것. `check-seams.sh` 의 방식 |

### 1.5 참조 (References)

- `web/js/core/helpers.js:680` — `visiblePoll`. 이 통합의 1차 시도와 그 진단
- `web/js/core/app-cmd.js:26` — `_restore*` 프로토콜 (FR-RSF-3·5·7). 경쟁의 반창고
- `web/js/core/app-cmd.js:66` — 재연결 복구 목록 (첫째 나열)
- `web/js/core/app-reload.js:42` — 소프트리로드 복구 목록 (둘째 나열)
- `web/js/git/panel-poll.js:270` — `_cadence`·`_applyCadence` (FR-RMS-22·28)
- `scripts/check-seams.sh` — 구조 규약을 CI grep 으로 집행하는 선례
- `docs/internal/E2E_QUIESCENCE_SRS.md` — "언제 조용해졌나" 를 재는 앞 문제
- `docs/internal/RELOAD_CONTINUITY_SRS.md` — SSE 생존 판정 (FR-RLC-20·25·28)
- `docs/internal/SLOT_VIEW_STATE_SRS.md` — 관측 하나 / 뷰 여럿의 원본
- `docs/internal/GIT_REPO_MISSING_SRS.md` — FR-RMS-22·28·29 (백오프·재계산·시한)
- `e2e/sse-resilience.spec.ts` — 격리 계약 테스트의 관용구

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 타이머 66개와 채널 3개가 34개 파일에 흩어져 있다

실측 (`web/js`, vendor 제외, **주석 줄 제외한 실제 호출**):

| 종류 | 전체 | `diag.js`(항구적 예외) | **이관 대상** |
|---|---|---|---|
| `setTimeout` | 45 | 3 | **42** |
| `setInterval` | 6 | 2 | **4** |
| `requestAnimationFrame` | 15 | 0 | **15** |
| `new EventSource` | 3 | 0 | **3** |
| **타이머 소계** | **66** | 5 | **61** |
| **합계 (채널 포함)** | **69** | 5 | **64** |
| (참고) `clearTimeout` | 39 | — | — |

타이머는 **33개 파일**, `EventSource` 는 3개 파일, 합집합 **34개 파일**이다.

`setTimeout` 42개의 성격별 분해 — 이 분류가 §6 D-7·D-8 의 근거다:

| 성격 | 수 | API |
|---|---|---|
| 디바운스·만료·재시도 | **29** | `after` |
| 지연 0 — 순서 미루기 | **9** | `defer` |
| `await new Promise(…)` 대기 | **4** | `sleep` |

`term-pane.js:242` 는 한 줄에 중첩 두 개다(`setTimeout(()=>setTimeout(…,0),0)`).
줄로 세면 9줄, 호출로 세면 10이다 — 아래는 **호출 기준**이되 그 한 줄을 하나로
묶어 9로 센다. 중첩 자체가 하나의 계약이기 때문이다 (D-7).

`setTimeout` 45 대 `clearTimeout` 39 는 일대일 대응이 아니다 — 취소가 불필요한
fire-and-forget 이 섞여 있고, 하나의 `clearTimeout` 이 여러 자리를 덮기도 한다.
**이 차이가 곧 누수라고 단정하지 않는다.** 확정된 사실은 이것이다 — 어떤 타이머가
취소되는지 알려면 **파일 33개를 열어야 한다.** 화면 하나가 파괴될 때 그에 걸린
타이머가 전부 걷혔는지 확인할 방법이 없다.

### 2.2 같은 규약이 최대 4벌 따로 구현돼 있다

| 규약 | 구현 벌수 | 자리 |
|---|---|---|
| 낡은 응답 폐기 | **4** | `_gitReposRefresh`(FR-GRR-1) · `console.reload`(seq+token+repo) · `GitObserver`(gen+seq) · `_restore*`(집합 동일성) |
| single-flight | **3** | `GitObserver._busy/_again`(boolean) · `_restore*`(집합 동일성) · `FileTreeStore.busy`(경로별 Set) |
| visibility | **2** | `visiblePoll` (5곳) · `GitObserver._pollOk` |
| 실패 백오프 | **2** | `GitObserver._cadence` · `editorGitBackoffMs()` (옛 `EDITOR_GIT_BACKOFF_MS` — POLL_INTERVAL_SETTINGS_SRS FR-PIS-12 로 계수 파생이 됐다) |
| fetch 타임아웃 | **1** | `/api/git/status` 만 (`GIT_STATUS_FETCH_TIMEOUT_MS`) |

마지막 줄이 특히 중요하다. 그 타임아웃은 추측이 아니라 실측에서 왔다 — TC-SVS-64,
Windows 러너에서 **46초 동안 signature 요청만 돌았다.** 응답이 오지 않아 `_busy`
가 영구히 참으로 남고 이후 모든 `collect()` 가 조용히 되돌아간 것이다. 같은 실패
모드가 나머지 폴링 전부에 열려 있으며, 그중 어느 것도 이 방어를 갖고 있지 않다.

### 2.3 같은 갱신 목록이 세 곳에 손으로 나열돼 있다

| 상태 | SSE 분기 | 재연결 복구 | 소프트리로드 복구 | 주기 | 경쟁 방어 |
|---|---|---|---|---|---|
| attention | `tool_attention`/`_clear` | `_attnRestore` | `_softStep('attn')` | ❌ | `touched` |
| activity | `tool_activity` | `_activityRestore` | `_softStep('activity')` | ✅ 5s | `touched` |
| foreground | `tool_foreground` | `_fgRestore` | `_softStep('foreground')` | ❌ | `touched` |
| background | `tools_background_changed`(신호) | `_bgRefresh` | `_softStep('background')` | ❌ | `latest` — 증분 없음 |
| focus | `window_focus`(전체 판) | `_focusRestore` | `_softStep('focus')` | ❌ | `latest` — 증분 없음 |

- `app-cmd.js:66` — `es.onopen` **한 줄**에 다섯 개가 이어 붙어 있다
- `app-reload.js:42~46` — `_softStep` **다섯 줄**에 같은 다섯 개
- `app-cmd.js` `onmessage` — **13개** `if` 분기

**새 상태를 하나 더하면 세 곳을 다 고쳐야 하고, 하나를 빠뜨리면 조용히 안 갱신된다.**

### 2.4 그 나열이 실제로 빠뜨린 사례가 주석에 남아 있다

`app-reload.js` 의 `trees` 단계다 (WORKBENCH_REVIEW_SRS FR-WBR-95). `refresh` 가
없는 객체에 `refresh()` 를 부르고 있었고 `typeof` 가드가 그것을 삼켰다. 내부
새로고침을 눌러도 **탐색기만** 낡은 채 남았다.

`_softStep` 다섯 줄은 전부 같은 형태의 가드를 달고 있다:

```js
this._softStep('attn',()=>this._attnRestore&&this._attnRestore());
```

이 `&&` 는 같은 실패를 같은 방식으로 삼킬 수 있다. 이름이 하나 바뀌면 그 상태는
**조용히** 갱신 대상에서 빠진다.

### 2.5 푸시와 스냅샷이 경쟁한다 — 다만 다섯 중 셋만 그 경쟁을 갖는다

> **이 절의 초안 진단은 틀렸다.** 처음에는 `background` 와 `focus` 에 방어가
> "빠졌다" 고 적었다. 다섯을 한 화면에 놓고 보니(그것이 §6 D-5 의 논거였다) 그
> 둘은 **증분 자체가 없는** 상태였다 — `tools_background_changed` 는 "목록을 다시
> 받으라" 는 신호이고(FR-BGV-1), `window_focus` 는 전체 소유권 맵이다(FR-XDF-14,
> 멱등). 만진 id 라는 개념이 성립하지 않으므로 보호할 것도 없다.
>
> 남는 결함은 다른 종류다 — **스냅샷끼리의 추월**. 두 복원이 겹치면 늦게 떠난
> 것이 먼저 도착해 새 목록을 낡은 것으로 되돌린다. 이것은 다섯 전부에 해당하고,
> `background`·`focus` 에는 그 방어도 없었다. 등록부의 `merge` 가 두 값을 갖는
> 이유가 이것이다 — `touched`(증분 보호 + 추월 방어) 와 `latest`(추월 방어만).

`_restoreBegin`/`_restoreLive`/`_restoreNote`/`_restoreVoid`/`_restoreEnd`
(FR-RSF-3·5·7) 는 정교한 장치다 — 비행을 **집합의 동일성**으로 식별하고, 비행 중에
증분이 만진 id 는 스냅샷이 덮지 못하게 한다.

이것이 필요한 이유는 명확하다. 스냅샷이 도는 중에 도착한 증분은 더 새로운데, 늦게
도착한 스냅샷이 그것을 되돌린다. 그런데 이 방어는 `fg`·`attn`·`activity` **셋에만**
있다. `background` 와 `focus` 는 같은 경쟁에 열려 있고 방어가 없다.

### 2.6 SSE 라우팅은 13분기 if-체인이고 자기 구독자를 모른다

`app-cmd.js` `onmessage` 는 `m.action` 을 13번 비교해 `this._onXxx()` 를 직접
부른다. 결과:

- 한 action 에 구독자가 **둘 이상**일 수 없다. 두 곳이 알아야 하면 한쪽이 다른
  쪽을 직접 부르는 배선이 생긴다
- 어떤 이벤트가 몇 번 왔고 누가 받았는지 관측할 자리가 없다. 진단은
  `console.error('[cmd] parse')` **한 줄**이 전부다
- 구독을 뗄 방법이 없다. 화면이 사라져도 분기는 남는다

### 2.7 같은 생명주기 신호를 다섯 곳이 각자 듣는다

`visibilitychange` 리스너 실측:

| 자리 | 하는 일 |
|---|---|
| `version-watch.js:101` | 자산 버전 확인 |
| `app-cmd.js:188` | 잠든 SSE 깨우기 |
| `helpers.js:699` | `visiblePoll` 의 복귀 갱신 |
| `panel-poll.js:200` | git 폴링 재개 |

같은 신호를 넷이 각자 해석한다. 순서 보장이 없다 — SSE 를 깨우기 전에 폴링이 먼저
돌면 그 회차는 죽은 채널을 딛는다.

### 2.8 `visiblePoll` 이 멈춘 이유는 게이트가 없어서다

`visiblePoll` 은 옳은 방향이었고 5곳을 흡수했다. 그러나 그 뒤로 추가된 폴링은 그것을
쓰지 않았고 — `GitObserver` 는 자기 것을 유지했다 — 아무도 그것을 막지 않았다.
**규약은 선언으로 지켜지지 않는다.**

### 2.9 이 저장소는 규약을 CI 로 집행하는 관용구를 이미 갖고 있다

`scripts/check-seams.sh` 다. 규칙 하나("OS 의존 호출은 `platform` 안에만"), 예외
경로 명시, 금지 패턴 목록, `.github/workflows/verify.yml:76` 에서 게이트.

그 주석에 이력까지 남아 있다 — *"아래 둘은 D1 이 이 검사를 그냥 통과해 들어온 뒤에
추가됐다"*. 게이트가 실제로 작동하고 진화해 왔다는 증거다.

**이 SRS 는 그 관용구를 그대로 따른다.**

### 2.10 제약 (Constraints)

| # | 제약 | 출처 |
|---|---|---|
| C-1 | 외부 관측 동작(UI·HTTP·CLI) 불변 | 사용자 지시 |
| C-2 | Go 테스트와 e2e 가 **전량 통과**하고 **개수가 같다**(현재 e2e 121) | 저장소 관례 |
| C-3 | 번들러가 없다. `index.html` 로드 순서가 곧 의존 순서다 — `Scheduler`·`EventBus` 는 `helpers.js` **앞**에 온다 | `web/index.html` |
| C-4 | 새 파일은 `js/*/*.js` 2레벨. `?v=` 와 `assets.lock` 을 올린다 | `web/embed.go`·`web/version_test.go` |
| C-5 | 기존 SRS 의 계약을 하나도 잃지 않는다. 특히 FR-RSF-3·5·7 · FR-RMS-22·28 · FR-RLC-25·28 · FR-SVS-30·31·45 · FR-GIT-21·22·23 · FR-RST-23 · TC-SVS-64 | §4 |
| C-6 | 순환 의존 없음 — `EventBus` 는 `Scheduler` 를 모른다 | §3.2 D-2 |

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 S — `Scheduler` (시간)

**FR-SCH-1** `web/js/core/scheduler.js` 에 클래스 하나. 앱당 인스턴스 하나.

**FR-SCH-2** 다섯 종류를 받는다. 그 밖은 없다. **표면이 다섯이어도 주체는
하나다** (INV-1) — 전부 같은 소유자 등록부와 같은 `dispose` 를 지난다.

| API | 뜻 | 대체 대상 | 마감 힙 |
|---|---|---|---|
| `every(spec)` | 주기 발화 | `setInterval` 4 · `visiblePoll` 5 | **지난다** |
| `after(ms, fn, opts)` | 1회 지연 | `setTimeout` 29 | **지난다** |
| `defer(fn, opts)` | 순서 미루기 | `setTimeout(…,0)` 9 | 우회 |
| `sleep(ms, opts)` | async 대기 | `await new Promise(setTimeout)` 4 | 우회 |
| `frame(fn, opts)` | 다음 프레임 | `requestAnimationFrame` 15 | 우회 |

**FR-SCH-3** 마감 힙을 지나는 것은 `every` 와 `after` 뿐이다. 내부는 **단일
`setTimeout` 체인**이다 — 등록된 일 중 **가장 이른 마감 하나만** 예약하고, 발화
후 다시 계산한다. 고정 tick 브로드캐스트가 아니다: 주기가 500ms 부터 5000ms
까지 섞여 있고 백오프로 2ⁿ 배까지 변하므로, 공통 tick 은 최소 주기로 깨어나
나머지를 헛돈다.

**FR-SCH-3a** `defer`·`sleep`·`frame` 은 **힙을 우회하고 원시 호출을 그대로
통과시킨다.** 셋 다 "언제" 가 아니라 다른 것을 재기 때문이다 — `defer` 는
매크로태스크 경계, `frame` 은 렌더 파이프라인 위치, `sleep` 은 호출자의 흐름.
힙에 넣어 마감을 계산하면 그 계약이 깨진다 (§6 D-6·D-7·D-8).

**우회해도 관리는 스케줄러가 한다** — 소유자 등록·취소·`pending()` 집계는 다섯
API 가 모두 동일하다. INV-1 이 요구하는 것은 한 지점을 지나는 것이지 한 큐에
들어가는 것이 아니다.

**FR-SCH-4** `every` 의 주기는 **값이 아니라 함수**를 받는다.

```js
every: () => this._cadence(gitStatusInterval)
```

`_cadence` 의 특수 규칙 — 실패 누적 시 2ⁿ 백오프(FR-RMS-22), 저장소 소실 시
`GIT_REPO_MISSING_POLL_MS` 고정(FR-RMS-6) — 이 스케줄러를 건드리지 않고 살아남는다.

**FR-SCH-5** 주기 변경은 **재계산일 뿐 발화가 아니다.** FR-RMS-28 의 계약이
구조적으로 성립한다 — 관측 결과로 주기를 바꾸는 자리에서 수집이 다시 시작되면
관측이 관측을 부른다 (D-RMS-10).

**FR-SCH-6** 공통 규약을 스케줄러가 **강제**한다. job 은 정책만 고른다.

| 규약 | 선언 | 기본 |
|---|---|---|
| visibility | `whenHidden: 'pause' \| 'run'` | `pause` |
| 복귀 시 1회 | `revalidateOnShow: bool` | `true` (FR-RST-23) |
| 조건 | `when: () => bool` | 항상 참 |
| 겹침 | `overlap: 'queue' \| 'drop'` | `drop` |
| 실패 백오프 | `backoff: {factor, max}` | 없음 |
| 타임아웃 | `timeout: ms` | 없음 |

**FR-SCH-7** `overlap` 을 하나로 통일하지 않는다. `queue` 는 `GitObserver._again`
의 계약("쓰기 직후의 상태를 반드시 한 번 더 본다"), `drop` 은 agents 의 계약
("최신 스냅샷만 있으면 된다")이다. **둘 다 옳다.**

**FR-SCH-8** `ctx.fetch(url)` 을 준다. `timeout` 이 선언돼 있으면
`AbortSignal.timeout` 을 건다. TC-SVS-64 의 실패 모드 — 응답이 오지 않아
single-flight 잠금이 영구히 남는 것 — 가 **구조적으로 불가능**해진다.

**FR-SCH-9** `ctx.stale()` 을 준다. 스케줄러가 job 마다 세대 번호를 쥐고, 그
호출 이후에 새 발화가 있었으면 참이다. §2.2 의 4벌이 한 줄이 된다. job 고유
조건(`d.repo !== repo` 등)은 job 이 덧댄다.

**FR-SCH-10** **소유자 단위 일괄 취소.** 모든 등록은 `owner` 를 받고,
`scheduler.disposeOwner(o)` 가 그 소유자의 대기 중인 일을 전부 걷는다. 화면이
파괴될 때 그에 걸린 타이머가 남아 죽은 객체를 붙드는 일이 사라진다.

**FR-SCH-11** `scheduler.pending()` — 대기 중인 일의 목록(id·소유자·남은 시간·
마지막 실행·연속 실패). e2e 정지 판정(E2E_QUIESCENCE_SRS)이 추정에서 사실이 된다.

**FR-SCH-12** `Scheduler` 는 `EventBus` 를 **모른다.** 발화는 등록 시 받은 콜백을
부르는 것이고, 그 콜백이 버스에 발행할지는 등록자가 정한다 (C-6).

**FR-SCH-13** `defer(fn)` — 내부는 `setTimeout(fn, 0)` 하나다. 큐잉도 병합도
하지 않는다. `term-pane.js:242` 의 이중 `defer` 는 xterm 내부의 `setTimeout(0)`
**뒤에 서려는 계약**이므로, 순서를 바꾸는 어떤 최적화도 금지한다. 이름이 의도를
남긴다 — 이것은 기다리는 것이 아니라 순서를 미루는 것이다.

**FR-SCH-14** `sleep(ms, {owner})` — `await` 로 쓴다. 소유자가 파괴되면
**resolve 하지 않는다.** 그 자리에서 async 함수가 멈추고 GC 된다. reject 하지
않는 이유는 호출부마다 `try/catch` 가 생기기 때문이다 — 이 저장소는 흐름 제어에
`try/catch` 를 쓰지 않는다. 파괴된 화면의 뒤 작업이 이어지지 않는 것이 옳다.

**FR-SCH-15** `frame(fn, {owner, coalesce})` — 내부는 `requestAnimationFrame`
하나다. 지연을 넣지 않는다. `coalesce` 는 **먼저 잡힌 예약이 이긴다** — 나중이
이기면 재예약이 프레임보다 잦은 연속 입력(터치 스크롤·리사이즈)에서 영영
실행되지 않는다. 실제 코드 세 곳(`_wheelRaf`·`_mFitRaf`·`_docRenderRaf`)이
`if(this._xRaf) return` 으로 이미 그렇게 하고 있었고, 접힌 동안의 변화는 누적
상태(`_wheelPend` 같은)가 들고 있다가 한 번에 반영된다. `coalesce:true` 면 같은 소유자·같은 키의 대기 중
프레임을 하나로 접는다 (`_wheelRaf`·`_mFitRaf`·`_docRenderRaf` 가 손으로 하던
일). 나머지 11개는 id 를 붙들지 않는 fire-and-forget 이었고 — 화면이 파괴된 뒤
죽은 DOM 을 만졌다 — `owner` 가 그것을 닫는다.

### 3.2 묶음 B — `EventBus` (전파)

**FR-BUS-1** `web/js/core/event-bus.js` 에 클래스 하나. 앱당 인스턴스 하나.

**FR-BUS-2** 앱의 **모든** 이벤트가 이 버스를 지난다. 소스는 넷이다.

| 소스 | 예 |
|---|---|
| 외부 채널(SSE) | `tool_activity` · `workspace_changed` · `run_changed` … |
| 스케줄 발화 | `tick:sys.stats` · `tick:git.status` |
| 생명주기 | `sse:open` · `sse:silent` · `visible` · `hidden` · `softreload` · `ws:reconnect` |
| 사용자 액션 | `user:refresh` |

**FR-BUS-3** `subscribe(topic, fn, {owner})` / `publish(topic, args)`. 한 topic 에
구독자가 여럿일 수 있다. `disposeOwner(o)` 로 뗀다.

**FR-BUS-4** 13분기 `if` 체인은 **라우팅 테이블**로 대체된다. `m.action` 이 곧
topic 이다. 서버가 새 action 을 더해도 `app-cmd.js` 는 바뀌지 않는다.

**FR-BUS-5** 게이팅은 라우팅 **앞**에 선다. `m.execClientId` 지명(FR-SXE-3),
`server_hello`(FR-RLC-20·24), LSP 진단(FR-LSP-32)의 현재 처리 순서를 보존한다.

**FR-BUS-6** **경쟁 해소를 버스가 소유한다.** `_restore*` 프로토콜(FR-RSF-3·5·7)
이 버스의 `merge:'touched'` 정책이 된다 — 스냅샷 비행을 집합 동일성으로 식별하고,
비행 중 증분이 만진 id 는 스냅샷이 덮지 않는다. **다섯 상태 전부에 적용되되 정책이 둘이다** — `touched`(증분이 개별 id 를
만지는 셋)와 `latest`(증분이 없어 추월만 막으면 되는 둘). `background` 와
`focus` 에 없던 추월 방어가 이관과 함께 생긴다 (§2.5).

**FR-BUS-7** 채널의 **건강**은 버스가 갖는다 — 구독·백오프 재연결(FR-RCS-6),
침묵 판정(FR-RLC-25·28), 강제 재연결 손잡이(FR-SRL-3). 침묵 감시는 **스케줄러에
등록된 일**이 되며, 지금의 방어 없는 raw `setInterval` 을 대체한다.

**FR-BUS-8** 생명주기 신호를 버스가 **단독으로** 듣고 topic 으로 발행한다.
`visibilitychange` 리스너는 앱 전체에 **하나**다 (§2.7). 순서가 결정된다 —
`sse:open` 이 `tick` 보다 먼저다.

**FR-BUS-9** `bus.stats()` — topic 별 발행 횟수·마지막 시각·구독자 수. `?diag=1`
오버레이에 얹는다. "이벤트가 안 온다" 가 재현 대신 스냅샷으로 해결된다.

**FR-BUS-10** 부가 채널도 버스가 연다 — `openChannel(id,url)` ·
`closeChannel(id)` · `channels()`. 대상은 둘이다: git job 스트림(이벤트를
나른다)과 슬롯 소유권 구독(**메시지를 처리하지 않는다** — 칸의 소유권은 그
신원의 구독이 살아 있는 동안만 유지되므로 여는 것 자체가 목적이다,
FR-WSL-11 · FR-XDF-9). 뒤엣것에 나를 이벤트가 없다고 관리 밖은 아니다 —
"지금 이 앱이 몇 개의 구독을 들고 있는가" 는 한 곳이 답해야 한다 (INV-2).

재연결·침묵 감시는 붙이지 않는다. 커맨드 SSE 는 끊기면 앱 전체가 낡지만
(FR-RCS-6), job 스트림은 자기 재시도 정책을 갖고 슬롯 구독은 슬롯 수가 바뀔 때
다시 열린다.

**D-1** 터미널 WebSocket 의 **바이트 스트림은 버스에 태우지 않는다.** 초당 수천
프레임이 전파 계층을 지날 이유가 없다. **연결 생명주기**(open·close·reconnect)만
태운다. 예외가 아니라 경계 정의다.

**D-2** 의존은 단방향이다: `Scheduler → (콜백) → 등록자 → EventBus`. 버스가
스케줄러를 참조하면 침묵 감시(버스 → 스케줄러 → 버스)에서 순환이 생긴다.

### 3.3 묶음 H — 상태 선언과 이관

**FR-HUB-1** 세 번째 클래스를 만들지 않는다. 상태별 갱신 경로는 **선언 데이터**로
산다 — `web/js/core/state-registry.js` **한 파일**. 런타임 주체는 두 클래스뿐이다.

선언을 각 상태 파일에 흩고 등록만 모으는 안을 검토해 버렸다. 그렇게 하면
"세 곳 나열" 은 낫지만 **재검증 정책과 merge 를 비교하려면 여전히 다섯 파일을
열어야 한다** — §2.5 의 결함(background·focus 만 방어 없음)을 아무도 못 본 이유가
정확히 그것이다. 다섯 선언이 한 화면에 나란히 놓이면 빈 칸이 보인다 (INV-1·§6 D-5).

구현 함수(`snapshot`·`apply`)의 본체는 기존 다섯 파일에 남는다. 옮기는 것은
**선언뿐**이다.

**FR-HUB-2** 선언의 형태:

```js
{
  id: 'tool.activity',
  owner: 'app',
  snapshot: (ctx) => ctx.fetch('/api/tools/activity'),
  events:   { tool_activity: (args, s) => s.patch(args) },
  every:    () => app.agentsPollMs,
  revalidateOn: ['sse:open', 'softreload', 'visible'],
  merge:  'touched',
  apply:  (s) => app._activityPaint(s),
}
```

**FR-HUB-3** §2.3 의 세 나열이 이 파일에서 **파생**된다.

| 지금 | 파생 |
|---|---|
| `onopen` 5줄 | `revalidateOn` 에 `sse:open` 이 있는 정의를 순회 |
| `_softStep` 5줄 | 같은 순회 (`softreload`) |
| `onmessage` 13분기 | `events` 키로 라우팅 테이블 구성 |
| 폴링 6곳 | `every` → `Scheduler` |

**새 상태를 더할 때 고치는 곳이 셋에서 하나가 된다.** `typeof` 가드가 조용히
삼킬 자리 자체가 없어진다 (§2.4).

**FR-HUB-4** 이관 대상 5개: `attention` · `activity` · `background` · `focus` ·
`foreground`.

**FR-HUB-5** `_pollStats` 의 직렬 3요청(`/api/ping` → `/api/stats` →
`_pollGitJobs`)을 **별개의 셋으로 가른다.** ping 은 지연 측정이라 주기가 달라도
되고, gitJobs 는 진행 중인 job 이 없으면 물을 이유가 없다. 지금은 셋이 줄서서
가고 앞이 늦으면 뒤가 함께 늦는다.

**FR-HUB-6** `visiblePoll` 은 **삭제하지 않고** 스케줄러 위의 얇은 래퍼로 남긴다.
호출부 5곳이 무변경이고, `when`/`immediate` 의 시맨틱이 이미 그 안에 문서화돼
있다. 새 코드는 `visiblePoll` 을 쓰지 않는다 (§3.4).

**FR-HUB-7** 위임 껍데기를 남긴다 — `_attnRestore`·`_activityRestore`·
`_bgRefresh`·`_focusRestore`·`_fgRestore` 는 이름이 유지된다. e2e 와
`app-agents.js:171`(새로고침 버튼)이 이 이름을 붙잡고 있다.

### 3.4 묶음 G — 예외 없음의 집행

**FR-GTE-1** `scripts/check-timers.sh` 를 세운다. `check-seams.sh` 와 같은 형태 —
규칙 하나, 예외 경로 명시, 금지 패턴 목록, `--help`.

**FR-GTE-2** 규칙은 하나다: **시간과 전파는 두 클래스 안에만 있다** (INV-1·2).

```
금지: setTimeout(  ·  setInterval(  ·  requestAnimationFrame(  ·  new EventSource(
대상: web/js/**/*.js   (vendor 제외)

항구적 예외 — 셋뿐이고, 이 목록이 곧 "예외의 전부" 다 (INV-3)
  web/js/core/scheduler.js   추상화 그 자체
  web/js/core/event-bus.js   추상화 그 자체
  web/js/ui/diag.js          진단 계층 (D-3)
```

이관이 끝나면 이 세 줄 밖에서는 원시 타이머가 **하나도** 나오지 않는다. 지금
34개 파일에 흩어진 64개(§2.1)가 그 상태가 되는 것이 완료 판정이다.

**FR-GTE-3** `.github/workflows/verify.yml` 에 `check-seams.sh` 와 나란히 건다.

**FR-GTE-4** 게이트는 **묶음 S·B 직후**에 세운다. 이관(H·O)이 끝나기 전에 세워야
이관 중에 새 위반이 들어오지 않는다. 미이관 파일은 명시적 예외 목록으로 두고,
이관될 때마다 그 줄을 지운다 — **남은 예외 줄 수가 곧 진척도**다.

**D-3** `diag.js` 는 예외라기보다 **규칙 하나로 표현된다**: *진단 계층은
피진단 계층에 의존하지 않는다.* `Scheduler` 의 결함을 `Scheduler` 위에서 진단할
수 없고, `?diag=1` 오버레이는 앱이 망가진 뒤에도 살아야 한다. `check-seams.sh` 가
`sysstat` 을 예외로 명시한 것과 같은 형태로, 스크립트 안에 근거와 함께 적는다.

같은 규칙에서 반대 방향도 나온다 — `scheduler.pending()` 과 `bus.stats()`
(FR-SCH-11·FR-BUS-9)는 진단 계층이 **읽을 수 있게** 공개된다. 진단은 두 클래스
위에 서지 않되, 두 클래스를 들여다볼 수는 있어야 한다.

### 3.5 묶음 O — `GitObserver` 흡수

**FR-OBS-1** `_cadence`·`_applyCadence`·`_reschedule`·`_stop`·`_busy`/`_again`·
`_seq` 가 스케줄러 선언으로 **남김없이** 표현된다.

**FR-OBS-2** 표현되지 않는 것이 **하나라도** 나오면 이관을 멈추고, 그것이 왜
특수한지부터 확정한다. 억지로 밀어 넣지 않는다.

**FR-OBS-3** FR-SVS-30 이 보존된다 — 콜백은 특정 패널이 아니라 observer 를 지난다.
FR-SVS-31·45(칸이 넷이어도 요청·쓰기는 한 벌)도 같다.

### 3.6 비기능 요구 (NFR)

| # | 요구 |
|---|---|
| NFR-1 | 네트워크 요청 수가 늘지 않는다. 이관 전후로 30초간 요청 수를 세어 비교한다 |
| NFR-2 | 숨은 탭에서 도는 일의 수는 이관 후 **줄거나 같다** (FR-STAT-17) |
| NFR-3 | 두 클래스 합계 **코드 500줄** 이하(주석·빈 줄 제외 — 이 저장소의 주석 밀도는 40~50%다). 넘으면 책임이 새고 있다는 신호다 |
| NFR-4 | `scheduler.pending()`·`bus.stats()` 는 O(등록 수). 진단이 부하가 되지 않는다 |

---

## 4. 검증 (Verification)

### 4.1 계약 고정 — 착수 전제

**이 테스트가 서기 전에는 어떤 이관도 시작하지 않는다.** 현재 코드에 대해 먼저
통과해야 하고, 이관 후에도 같은 것이 통과해야 한다.

조사 결과 **넷은 이미 서 있었다.** 다시 쓰지 않고 그대로 계약으로 삼는다.

| ID | 고정하는 계약 | 근거 | 기존 검사 |
|---|---|---|---|
| T-1 | 스냅샷 비행 중 도착한 증분을 늦게 온 스냅샷이 덮지 않는다 | FR-RSF-3·7 | **없음 → 신규** |
| T-2 | 전체 초기화는 만진 id 로 표현되지 않는다 — 그 비행은 통째로 버린다 | FR-RSF-5 | **없음 → 신규** |
| T-3 | 45초 침묵이면 `readyState` 와 무관하게 재연결한다 | FR-RLC-25 | ✅ TC-RLC-25 |
| T-4 | **모든** 수신이 생존의 증거다 (인사만 세지 않는다) | FR-RLC-28 | ✅ TC-RLC-27 |
| T-5 | 실패 누적 시 주기가 2ⁿ 로 늘고 상한에서 멈춘다 | FR-RMS-22 | **없음 → 신규** |
| T-6 | 주기를 다시 걸어도 **즉시 수집하지 않는다** | FR-RMS-28 · D-RMS-10 | **없음 → 신규** |
| T-7 | 응답이 오지 않아도 single-flight 잠금이 풀린다 | **FR-RMS-29** | **없음 → 신규** |
| T-8 | 칸이 넷이어도 status 요청은 한 벌 | FR-SVS-31 | ✅ TC-SVS-22 |
| T-9 | 쓰기 한 번은 한 번이다 | FR-SVS-45 | ✅ TC-SVS-53 |
| T-10 | 숨은 탭에서는 돌지 않고, 복귀하면 즉시 한 번 돈다 | FR-RST-23 · FR-STAT-17 | **없음 → 신규** |
| T-11 | 주기 0 은 그 계층을 걸지 않는다 | FR-GIT-23 | **없음 → 신규** |
| T-12 | 소프트리로드가 다섯 상태를 **전부** 재검증한다 | §2.4 · FR-WBR-95 | **없음 → 신규** |

**T-7 의 근거를 정정한다.** 초안은 `TC-SVS-64` 를 근거로 적었으나 그것은 이
결함이 **발현된 테스트의 이름**이고, 계약 자체는 사후 추가된 **FR-RMS-29** 다 —
*"status 요청은 클라이언트에서도 시한이 있다(20초). `collect()` 는 single-flight
라 답이 오지 않는 요청 하나가 `_busy` 를 영구히 참으로 남기고, 그 뒤의 모든
수집이 조용히 되돌아간다."* 검사가 재는 것은 시한값이 아니라 **잠금이 풀리는가**
다. 값을 재면 상수를 바꿀 때 검사가 깨지는데, 계약은 값이 아니다.

T-12 는 지금 코드에 **없는** 검사다. §2.4 의 결함이 그대로 재발할 수 있다는 뜻이다.
이관과 무관하게 먼저 세운다.

신규 여덟은 `e2e/event-timer-hub-contract.spec.ts` 한 파일에 선다. 재는 방식은
`sse-resilience.spec.ts` 의 관용구를 따른다 — 빈 페이지에 대상 파일만 얹고 계약만
시험한다 (T-12 만 실앱이 필요하다).

#### 4.1.1 단계 0 결과 — **완료**

12개 검사가 섰고 **전부 통과한다** (4.2초). 경계 사례를 넷 더해 열둘이 됐다:

| 검사 | 재는 것 |
|---|---|
| T-1 · **T-1b** | `touched` 가 있으면 스냅샷이 덮지 않고, 없으면 스냅샷이 전부를 정한다 (FR-RSF-3·7) |
| T-2 · **T-2b** | 초기화는 비행을 버리고, 나중 비행이 앞선 비행을 무효로 만든다 (FR-RSF-5·3) |
| T-5 · T-11 | 2ⁿ 백오프와 상한 · 기준 0 은 0 으로 남는다 |
| T-6 | 주기 재계산이 수집을 부르지 않는다 |
| T-7 · **T-7b** | 잠금이 풀린다 · 비행 중 요청은 "끝나면 한 번 더" 로 남는다 (FR-GIT-21) |
| T-10 · **T-10b** | 숨김 정지와 복귀 1회 · `when` 이 거짓이면 보여도 돌지 않는다 |
| T-12 | 소프트리로드가 다섯 상태를 전부 재검증한다 |

**T-12 가 지금 코드에서 통과한다** — 다섯 이름이 살아 있고 전부 불린다. 그러나
그것을 지키는 것은 구조가 아니라 `app-reload.js` 의 다섯 줄이다. 이 검사는 그
다섯 줄이 `state-registry` 로 대체될 때까지 그 자리를 지킨다.

#### 4.1.2 계약 테스트를 쓰며 확정한 두 원칙

이관 중에도 지킨다.

**① 계약은 값이 아니다.** T-5 는 백오프 상한을 `30000` 으로 재지 않는다 — 실패
20회와 40회의 결과가 **같다는 것**으로 상한의 존재를 증명한다. 상수를 조정할 때
깨지는 검사는 계약이 아니라 구현을 붙잡고 있는 것이다. 같은 이유로 T-7 은 시한
20초를 재지 않고 **잠금이 풀리는가**만 잰다.

**② 갈아 끼우는 것을 최소로 한다.** T-5·T-7 은 `_applyStatus` 를 덮지 않는다.
실패가 `_fail()` 을 지나 `_failStreak` 를 올리고 백오프를 다시 거는 **그 경로가
곧 계약의 실질**이기 때문이다. 덮으면 검사는 통과하되 아무것도 지키지 못한다.

### 4.2 구조 검증

| ID | 검증 |
|---|---|
| V-1 | `check-timers.sh` 가 위반을 실제로 잡는다 — 일부러 `setTimeout` 을 넣고 실패를 확인 |
| V-2 | 예외 목록의 줄 수가 이관마다 줄어든다 |
| V-3 | `visibilitychange` 리스너가 앱 전체에 하나다 |
| V-4 | `bus.stats()` 의 topic 집합 = `state-registry` 의 `events` 키 합집합 ∪ 생명주기 topic |
| V-5 | 순환 의존 없음 — `event-bus.js` 가 `Scheduler` 를 참조하지 않는다 |
| V-6 | `defer()` 가 원시 `setTimeout(…,0)` 의 순서를 보존한다 — xterm 조합 입력 e2e 로 잰다 (D-7) |
| V-7 | `disposeOwner` 가 **다섯 API 전부**의 대기 항목을 걷는다. `pending()` 이 그 소유자에 대해 빈다 (INV-1) |
| V-8 | `sleep()` 은 소유자 파괴 후 resolve 하지 않는다. 뒤 작업이 실행되지 않음을 확인한다 (D-8) |
| V-9 | **완료 판정**: 예외 3줄 밖에서 원시 타이머·`EventSource` 가 **0개**. `check-timers.sh` 가 예외 목록 없이 통과한다 |

### 4.3 회귀

| ID | 검증 |
|---|---|
| R-1 | e2e **121개 전량 통과, 개수 동일** (C-2) |
| R-2 | Go 테스트 전량 통과 |
| R-3 | 30초 요청 수 이관 전후 동일 (NFR-1) |
| R-4 | `?v=`·`assets.lock` 갱신, `version_test.go` 통과 (C-4) |

---

## 5. 구현 계획

| 단계 | 내용 | 리스크 | 종료 조건 |
|---|---|---|---|
| **0** ✅ | §4.1 계약 테스트를 **현재 코드**에 대해 세운다 → `e2e/event-timer-hub-contract.spec.ts` | LOW | **완료** — 12개 통과 (§4.1.1) |
| **1** ✅ | `EventBus` — SSE 구독·재연결·침묵감시·라우팅 테이블을 `app-cmd` 에서 분리 | LOW | **완료** — `app-cmd.js` 720→659줄 |
| **2** ✅ | `TimerHub` — 마감 힙 + 5종 API(`every`·`after`·`defer`·`sleep`·`frame`)·규약 6종. `visiblePoll` 을 래퍼로 | LOW | **완료** (§6 D-9 의 개명 포함) |
| **3** ✅ | `check-timers.sh` + CI. 미이관 파일은 예외 목록 | LOW | **완료** — V-1 확인(위반 주입 → exit 1) |
| **4** ✅ | `state-registry` + 5개 상태 이관 | MEDIUM | **완료** — 세 나열이 한 파일에서 파생 |
| **5a** ✅ | `after` · `defer` — 디바운스·만료·순서 조정 | MEDIUM | **완료** |
| **5b** ✅ | `sleep` 4 · `frame` 15 — async 대기·렌더 동기화. 예외 목록을 비운다 | MEDIUM | **완료** — **V-9 통과** |
| **6** ✅ | `GitObserver` 흡수 | MEDIUM~HIGH | **완료** — FR-OBS-2 에 걸리지 않았다 (§5.2) |

**단계 3 이 4 보다 앞선 이유**: 게이트 없이 이관하면 이관하는 동안 새 위반이 들어온다.
`visiblePoll` 이 정확히 그렇게 멈췄다 (§2.8).

**단계 5 를 4 뒤에 둔 이유**: 57개(`after` 29·`defer` 9·`sleep` 4·`frame` 15)는
수가 많을 뿐 위험하지 않다. 4 에서 설계가 검증된 뒤 기계적으로 옮긴다.

**5a·5b 를 가른 이유**: 5a 는 마감 힙을 지나는 것(`after`)과 그것을 우회하는 것
(`defer`)이 섞여 있어 D-7 의 순서 계약을 실제로 밟는다. 5b 는 우회 API 둘뿐이라
성격이 다르다. **V-9 는 5b 의 종료 조건이자 이 SRS 전체의 완료 판정**이다 —
그 시점에 §1.2 의 불변 조항이 코드에서 참이 된다.

**중단 지점**: 단계 6 에서 FR-OBS-2 에 걸리면 거기서 멈춘다. 1~5 만으로도 §2.3~2.7
의 결함은 전부 닫힌다.

### 5.2 이관에서 확정한 것

**FR-OBS-2 에 걸리지 않았다.** `GitObserver` 의 다섯 축이 선언으로 남김없이
표현됐다. 다만 두 곳에서 **표현 방식을 좁혀야** 했다:

| 자리 | 판단 |
|---|---|
| `every` | 주기를 **함수가 아니라 값**으로 넘긴다. 이 자리는 `_applyCadence` 가 이미 실효 주기를 계산해 넘긴 뒤이고, 주기가 바뀌면 그것이 `_stop()` 후 다시 건다. 스케줄러가 또 계산하면 두 곳이 같은 판단을 하게 되고, 어긋나면 어느 쪽이 맞는지 알 수 없다 |
| `when`·`whenHidden` | **조건을 주지 않는다.** `whenHidden:'run'` 이고 `when` 은 없다 |

**두 번째 것은 회귀가 잡았다.** 처음에는 `when:()=>this._pollOk()` 를 줬다.
가시성 판정이 스케줄러의 것보다 넓다는 이유였다 — `_pollOk()` 는
`document.hidden` 뿐 아니라 창이 보이는지, 이 패널의 표면이 화면에 있는지까지
본다 (FR-RTU-62 · FR-SVS-39a). 그런데 그 자리 **바로 위 주석**이 계약을 이미
적어 두고 있었다:

> 조건이 거짓이면 `clearInterval` 로 **완전히 멈춘다** — 콜백에서 return 으로
> 넘기지 않는다. 참이 되면 **즉시 1회 수집하고** 주기를 건다 (FR-GIT-22).

`when` 을 주면 정확히 그 금지된 모양이 된다 — 타이머는 살아 있고 콜백만 빈손으로
돌아가며, 조건이 참으로 바뀐 순간의 즉시 수집이 사라진다. 조건은
`_applyCadence`/`_reschedule` 의 것이고 스케줄러는 주기만 안다.

전체 회귀에서 git 계열 7건이 흔들렸고 그중 `git-console K2`(쓰기 뒤 그 명령이
맨 위에 나타나는가)는 즉시 수집이 사라진 자리였다. `when` 을 걷어내자 3회 연속
통과했다.

**이것이 FR-OBS-2 가 지키려던 것이다** — 표현되지 않는 것이 나오면 억지로 밀어
넣지 말라는 조항. 밀어 넣을 수는 있었고 구문도 통과했지만, 계약이 달라졌다.

둘 다 "스케줄러가 job 의 판단을 가져가지 않는다" 는 같은 규칙이다 (FR-SCH-4).

### 5.3 최종 수치

| | 이관 전 | 이관 후 |
|---|---|---|
| 원시 타이머·채널 (예외 3파일 밖) | **64** | **0** |
| 그것을 든 파일 | 34 | 0 |
| `app-cmd.js` | 720줄 | **664줄** |
| 두 클래스 코드 (NFR-3 ≤ 500) | — | **340** (`TimerHub` 180 · `EventBus` 160) |
| `state-registry.js` | — | 70 |
| 갱신 목록이 손으로 나열된 곳 | 3 | **1** (선언) |
| 같은 규약의 중복 구현 | 최대 4벌 | 1벌 |

`TIMERS` 를 쓰는 파일 27개, `bus` 를 쓰는 파일 4개. 전자가 많은 것이 정상이다 —
시간은 모든 화면이 쓰고, 전파는 상태를 가진 곳만 쓴다.

### 5.1 파일 단위 영향 범위

| 파일 | 변경 |
|---|---|
| `web/js/core/scheduler.js` | **신규** |
| `web/js/core/event-bus.js` | **신규** |
| `web/js/core/state-registry.js` | **신규** |
| `e2e/event-timer-hub-contract.spec.ts` | **신규 (단계 0 — 완료)** |
| `scripts/check-timers.sh` | **신규** |
| `.github/workflows/verify.yml` | 게이트 한 줄 |
| `web/index.html` | 신규 3개를 `helpers.js` 앞에 (C-3) |
| `web/js/core/app-cmd.js` | 구독·라우팅·`_restore*` 이관 (가장 큰 감소) |
| `web/js/core/app-reload.js` | `_softStep` 5줄 → 순회 |
| `web/js/core/helpers.js` | `visiblePoll` → 래퍼 |
| `web/js/core/app-{agents,attn,tool,focus,statusbar,git,editor}.js` | 폴링 등록 형태 변경 |
| `web/js/git/{observer,panel-poll,console}.js` | 단계 6 |
| `web/js/ui/term-pane.js` | `defer` 로 이관. **D-7 의 순서 계약이 걸린 자리** (단계 5a) |
| 나머지 20여 파일 | 단계 5a·5b, 타이머 호출 형태만 |

---

## 6. 설계 결정 (확정)

넷 다 **§1.2 불변 조항**에서 파생됐다. 판정 기준은 하나였다 — *어느 쪽이 한
군데에서 관리되는가.* 넷 다 "표면이 늘어도 주체는 하나" 쪽으로 결정됐다.

### D-5 상태 선언은 한 파일에 모은다

**대안**: 선언을 다섯 상태 파일에 두고 등록 호출만 모은다 (응집도가 높다).

**기각 근거**: 그렇게 해도 §2.3 의 "세 곳 나열" 은 낫지만, **재검증 정책과
merge 를 비교하려면 다섯 파일을 열어야 한다.** §2.5 의 결함 — `background` 와
`focus` 에만 경쟁 방어가 없다 — 을 여태 아무도 못 본 이유가 정확히 그것이다.
다섯 선언이 한 화면에 나란히 서면 빈 칸이 보인다. (FR-HUB-1)

### D-6 rAF 15개를 전부 `frame()` 으로 받는다

**쟁점**: rAF 는 시간 축이 다르다. `after(16)` 으로 대체할 수 없고, 브라우저가
레이아웃을 확정한 직후라는 **렌더 파이프라인 위치**에 종속된다.

**결정**: 그래서 힙을 우회하고 rAF 를 그대로 통과시키되(FR-SCH-3a), 등록·취소·
집계는 스케줄러가 한다. 값어치는 지연이 아니라 소유권에 있다 — 15개 중 **11개가
id 를 붙들지 않는 fire-and-forget** 이고, 화면이 파괴된 뒤 죽은 DOM 을 만진다.
`disposeOwner` 가 그것을 닫는다. (FR-SCH-15)

### D-7 `setTimeout(…, 0)` 은 `defer()` 라는 전용 이름을 갖는다

**쟁점**: 42개 중 9개가 지연 0이다. 이것은 기다리는 것이 아니라 **매크로태스크
경계를 넘기는 것**이다. `term-pane.js:242` 의 이중 호출은 xterm 내부의
`setTimeout(0)` 뒤에 서려는 계약이고, 순서가 바뀌면 IME 가 깨진다.

**대안**: `after(0)` 으로 통일하고 스케줄러가 0 을 특수 처리한다.

**기각 근거**: "0 은 다르게 동작한다" 는 **숨은 규칙**이 생긴다. 이 저장소는
숨은 규칙을 싫어한다 — 같은 이유로 `_stateChar` 를 한 자리로 모았고(FR-RST-22),
`visiblePoll` 로 규약을 드러냈다. 이름이 다르면 의도가 코드에 남는다.
(FR-SCH-13)

### D-8 `sleep()` 은 소유자 파괴 시 resolve 하지 않는다

**쟁점**: `await new Promise(r=>setTimeout(r,ms))` 4개 — `app-tool.js:187·443`,
`app.js:107·360`. 소유자가 파괴될 때
이 promise 를 어떻게 하는가.

**대안**: `resolve(false)` 로 깨워 호출부가 정리하게 한다.

**기각 근거**: 네 호출부를 전부 고쳐야 하고, 검사하지 않으면 지금과 같다.
reject 는 더 나쁘다 — 호출부마다 `try/catch` 가 생기는데 이 저장소는 흐름
제어에 `try/catch` 를 쓰지 않는다. **파괴된 화면의 뒤 작업이 이어지지 않는
것이 옳은 동작**이므로, 그 자리에서 멈추고 GC 되게 둔다. (FR-SCH-14)

### D-9 클래스 이름은 `TimerHub` 다 — `Scheduler` 는 브라우저의 것이다

`class Scheduler` 로 쓰고 검사를 돌리자 `Illegal constructor` 가 났다.
`window.Scheduler` 는 **브라우저 내장 전역**이다 (Prioritized Task Scheduling
API). 앱 코드는 최상위 `class` 선언이 렉시컬 전역이라 우연히 동작했지만 —
`new Scheduler()` 가 내 클래스를 잡는다 — 검사가 `window.Scheduler` 로 접근하는
순간 내장 쪽이 나왔다.

**조용히 깨지는 종류의 충돌이다.** 앱은 돌고 검사만 이상해 보인다. 이름을
`TimerHub` 로 바꿨고(문서명 `EVENT_TIMER_HUB` 와도 맞는다), 조사해 보니 남은
후보 중 내장과 겹치는 것은 `Scheduler` 하나뿐이었다.

여기서 나온 두 번째 사실이 검사 작성 방식을 정했다 — **최상위 `class`·`const`·
`let` 은 전역 객체의 프로퍼티가 아니다.** `window.TimerHub` 도 `window.
GIT_FAIL_BACKOFF_MAX_MS` 도 `undefined` 다. 검사는 `page.evaluate` 본문에서
**이름으로 직접** 조회한다 (`declare const` 로 타입만 만족시킨다).

### D-10 전역 인스턴스 `TIMERS` 를 둔다

`App` 의 필드 하나로만 두면 `BootScreen`·`TermPane`·`Toast`·`GitPanel` 이 닿지
못한다 — 앞엣것은 `App` 이 생기기 전에 화면을 덮고 자기 시한을 걸며, 나머지
셋은 `app` 참조 없이 자기 타이머를 건다. 전역이 없으면 그 파일들이 각자
인스턴스를 만들게 되고 **그 순간 "한 군데" 가 깨진다** (INV-1).

`TIMERS` 는 모듈 로드 시점에 서고 `App` 은 그것을 `this.timers` 로 든다. 검사는
`new TimerHub()` 로 격리한 인스턴스를 쓴다.

---

## 7. 열린 항목

| # | 항목 | 처리 |
|---|---|---|
| O-1 | git 폴링을 푸시로 전환 | **별도 SRS** — `GIT_PUSH_OBSERVE_SRS.md`. 초안은 이것을 "`fsnotify` 도입" 이라 적었는데 **틀렸다**: `ReadSignature` 는 git 을 실행하지 않고 read 1회 + stat 2회로 0.02ms 다(FR-GIT-19 §2.6). 서버가 그것을 확인하는 비용은 무시할 수준이며, 무엇보다 그 signature 는 실측으로 다듬어진 것이다 — `RefsShape` 는 "Windows 러너에서 `git branch` 뒤 디렉터리 mtime 이 45초 동안 그대로였다" 는 관측에서 나왔다(FR-CEM-32). 파일 감시로 바꾸면 그 지식을 버리고 플랫폼별 워처의 한계를 새로 떠안는다 |
| O-2 | 묶음 O(`GitObserver`)가 FR-OBS-2 에 걸릴 경우의 처리 | 걸리면 거기서 멈춘다. 단계 1~5 만으로 §2.3~2.7 의 결함은 전부 닫힌다 (§5) |
