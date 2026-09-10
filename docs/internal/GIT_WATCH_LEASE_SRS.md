# SRS: 감시 임대를 SSE 구독에 맡긴다 — IEEE 29148

> 상태: **초안**. `GIT_PUSH_OBSERVE_SRS` FR-GPO-10·11 의 개정이며
> `POLL_INTERVAL_SETTINGS_SRS` FR-PIS-9 의 전제를 고친다.
> 근거 감사: `docs/internal/production/11-git-polling.md` §1 (`GP-1`, **P0**).

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`gitStatusInterval` 을 `끔`이나 `2분`으로 두면 **서버의 자동 push 까지 함께 죽는다.**
사용자가 "요청을 줄이려고" 고른 설정이 자동 갱신을 통째로 끄고, 화면에는 아무 표시도
없다.

원인은 관측도 방송도 아니다. **감시 임대**다.

서버는 등록된 저장소만 관측한다(`gitwatch.go:227-240`). 그 등록을 유지하는 유일한
계기가 `GET /api/git/status` 이고(`handlers_git.go:417` — `Note()` 의 유일한 호출처),
90초간 그 요청이 없으면 `evictLocked` 가 감시를 걷는다. 그 요청을 정기적으로 내는
유일한 경로가 브라우저의 안전망 폴링이므로, **안전망을 끄면 본줄이 끊긴다.**

**임대의 주체를 요청에서 연결로 옮긴다.** 브라우저가 SSE 로 붙어 있는 동안이 곧
"보고 있는 동안" 이므로, 폴링 주기와 push 수명이 분리된다.

### 1.2 왜 지금 이것을 하는가 — 원래 판단이 유효하지 않다

`Note` 앞 주석(`gitwatch.go:140-146`)이 별도 API 를 만들지 않은 이유를 적어 두었다:

> status 요청이 곧 "지금 이것을 본다" 이기 때문이다 — **구독 등록·해제와 연결 끊김
> 처리를 새로 다룰 값어치가 없다.**

그 판단의 전제는 "등록·해제·끊김 처리를 새로 만들어야 한다" 였다. **그 전제가 더는
성립하지 않는다.** 이후 `USER_CHECKLIST_FIXES_SRS` FR-XDF-8~10 이 정확히 그 세 가지를
만들었고 지금 돌고 있다:

| 필요한 것 | 이미 있는 것 | 위치 |
|---|---|---|
| 클라이언트 신원 | `clientId` 가 SSE 쿼리에 실려 온다 | `app-cmd.js:105` → `/api/commands/sse?clientId=…` |
| 구독↔신원 결선 | `Focus.AttachFrom(cid, addr)` | `httpapi/commands.go:68-77` |
| 끊김 즉시 해제 | 같은 핸들러의 `defer Detach` — grace period 없음 | 같은 곳 |
| 재연결 경합 방지 | `epoch` — 옛 연결의 늦은 정리가 새 연결의 등록을 지우지 못한다 | `hub/focus.go:147,166` |

**새로 설계할 것이 없다.** `FocusRegistry` 가 같은 문제(연결이 살아 있는 동안만 상태를
유지)를 이미 이 패턴으로 풀었고, `GitWatcher` 만 그것을 쓰지 않고 TTL 로 때우고 있다.
이 SRS 는 그 패턴을 한 번 더 적용한다.

### 1.3 왜 TTL 을 더 늘리는 것으로는 안 되는가

두 후보를 실제로 검토했고 둘 다 기각한다.

**(1) 서버 `GitWatchTTL` 을 최댓값보다 크게.** `2분`은 덮지만 `끔`은 못 덮는다.
`끔`이면 정기 요청이 0건이라 갱신 계기 자체가 없고, TTL 이 얼마든 그만큼 뒤에 죽는다.
게다가 되살아나지 못한다 — 재등록 계기는 다음 status 요청인데, 남은 계기가 이벤트성
(포커스 복귀·사용자 조작)과 `git_changed` 수신뿐이고 **`git_changed` 는 이미 멎었으므로
자기 자신을 되살릴 수 없다.**

**(2) `끔`·`2분` 선택지 제거.** P0 은 닫지만 증상만 막는다. 임대가 여전히 폴링에
매달려 있으므로, 폴링이 멈추는 **다른** 경로가 같은 결함을 다시 만든다. 그런 경로가
이미 있다: `_pollOk()` 가 거짓이면 `_applyCadence` 가 계층을 **완전히 멈춘다**
(`panel-poll.js:300-330`) — 창을 다른 데로 옮기거나 git 패널이 화면 밖으로 나가면
폴링이 0이 되고, 90초 뒤 감시가 걷힌다. `panel-poll.js:335-345` 의 주석이 이 결함을
이미 적어 두었다.

`/api/git/repos?observe=1`(3초)을 임대 갱신에 쓰는 우회도 검토했으나 안 된다.
**사이드바 Git 탭이 활성일 때만** 나가고(`constants-git.js:88`), 관측 대상도 핀 목록이라
Repo 창이 열린 저장소를 보장하지 못한다.

### 1.4 확정된 사용자 요구

사용자 원문: **"오래 안 본다고 지우는 건 안 될 거 같아. 띄워놓고 보고만 있을 수도
있으니까 작업하면서."**

이것이 FR-GWL-2 의 근거다. 유휴 시간은 임대 만료의 사유가 **아니다.** 사용자는 Repo
창을 띄워 두고 터미널에서 작업하다 이따금 볼 수 있고, 그동안 화면 갱신이 죽어 있으면 안
된다. 만료의 유일한 사유는 **연결이 끊긴 것**이다.

### 1.5 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **L** | 임대를 SSE 구독에 묶는다 (서버) | **MEDIUM** |
| **C** | status 요청이 `clientId` 를 싣는다 (브라우저) | LOW |
| **S** | `gitStatusInterval` 선택지 정리 | LOW |

**비목표**

- signature 가 놓치는 변경의 확대 (`GP-11` 9건 — `.git/config`, `stash drop`, `bisect` 등).
  그것은 감지 정확도의 문제이고 이 SRS 는 감시 **수명**만 다룬다.
- `GP-2`(주기 0 에서 워치독이 스스로 물러난다) · `GP-3`(`_gitMissing` 이 되돌아오지
  않는다) · `GP-5`~`GP-10`. 폴링 계층 재설계의 나머지는 로드맵 M6 이 한다.
- 안전망 폴링의 제거. 임대에서 풀려날 뿐 그물로는 남는다 (§1.6).
- 다중 사용자·다중 기기의 임대 정책. 멀티유저는 미지원 선언이다.

### 1.6 안전망 폴링은 왜 남는가

지금 그 폴링은 두 가지 일을 겸한다 — (a) 놓친 방송을 줍는 그물, (b) 임대 갱신.
설계상 필요한 것은 (a)뿐이고 (b)는 사고다. 이 SRS 는 (b)만 떼어 낸다.

(a)는 여전히 값이 있다. `obsMark` 가 보지 못하는 변경이 확정 9건 있고(`GP-11`),
그 중 `.git/config` 변경·`stash drop`·`cherry-pick --quit` 은 터미널에서 흔하다.
다만 그 빈도는 초 단위가 아니므로 `끔`~`30초` 어디에 두어도 제품이 죽지 않는다 —
**그것이 이 SRS 가 만들려는 상태다.**

### 1.7 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **표명**(Note) | "이 저장소를 지금 본다" 는 신호. 지금은 `GET /api/git/status` 하나 |
| **임대**(Lease) | 표명이 감시를 살려 두는 기간 |
| **임차인**(Holder) | 임대를 쥔 주체. 이 SRS 이후 `clientId` |
| **유휴 만료**(TTL) | 마지막 표명에서 `GitWatchTTL` 이 지나 감시를 걷는 것 |
| **epoch** | 구독마다 증가하는 정수. 옛 연결의 늦은 정리가 새 연결을 지우는 것을 막는다 |

### 1.8 참조 (References)

- `GIT_PUSH_OBSERVE_SRS` FR-GPO-10·11 — 표명과 TTL 을 정한 원본. 이 SRS 가 개정한다.
- `POLL_INTERVAL_SETTINGS_SRS` FR-PIS-9 — `0` 을 허용한 근거가 틀렸다 (§2.3).
- `GIT_LIVE_TRIGGERS_SRS` FR-GLW-1~8 — 복귀 계기와 만료·탈락 로그 분리.
- `USER_CHECKLIST_FIXES_SRS` FR-XDF-8~10 — 이 SRS 가 따르는 Attach/Detach/epoch 규약.
- `docs/internal/production/11-git-polling.md` §0·§1·§4 — 관측 구조 지도와 `GP-1` 실측.

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 세 층 중 깨진 것은 하나뿐이다

| 층 | 코드 | 상태 |
|---|---|---|
| 관측 정확도 | `obsMark` = signature + Oid + Branch + Detached + Ahead/Behind + 파일 목록 전체 (`gitwatch.go:75-90`) | 정상. 예외 9건은 `GP-11`(전부 P2) |
| push 전달 | `Tick` → `hub.Broadcast(git_changed)` → SSE (`gitwatch.go:270-277`) | 정상 |
| **감시 임대** | `Note()` ← `GET /api/git/status` 하나, TTL 90초 | **P0** |

### 2.2 연쇄 (코드로 확정)

```
gitStatusInterval = 0
  → panel-poll.js:326 `if(st>0)` 이 거짓 → 타이머를 걸지 않는다
  → GET /api/git/status 가 나가지 않는다
  → Note() 가 불리지 않는다 → seenAt 고정
  → 90초 뒤 evictLocked 가 delete            (gitwatch.go:184-192)
  → Tick 의 repos 목록에서 빠진다            (gitwatch.go:233-238)
  → w.git.Status() 호출 자체가 사라진다      ← 관측 중단
  → Broadcast 0
```

`120000`도 같은 자리다. 갱신 간격 120초 > TTL 90초라 매 주기 30초짜리 공백이 생기고 그
구간에서 지워진다.

확정 증거는 서버 로그다: `[gitwatch] 관심 표명 만료 — 감시를 걷는다 (repo=… idle=…)`
(`gitwatch.go:189`).

### 2.3 FR-PIS-9 의 근거가 틀렸다

`POLL_INTERVAL_SETTINGS_SRS` FR-PIS-9 는 `gitStatusInterval` 에만 `0`을 허용하면서
근거를 이렇게 적었다 — "나머지 넷은 갱신의 **유일한** 경로여서 끄면 화면이 멎는다"
(즉 이것은 유일 경로가 아니다). **그 진술이 틀렸다.** 본줄인 push 가 이 폴링에 종속돼
있었으므로 이것도 유일 경로였다.

FR-GPO-11 은 반대 방향에서 같은 전제를 적었다 — "브라우저의 안전망 폴링(FR-GPO-20)이
그보다 잦으므로, 보고 있는 동안에는 만료되지 않는다." 그 전제는 FR-PIS-9 가 `120초`와
`0`을 추가하면서 깨졌고, 두 SRS 중 어느 쪽도 상대를 보지 않았다.

이 SRS 가 그 충돌을 해소한다: **FR-GPO-11 의 전제를 폴링에서 연결로 바꾼다.**

### 2.4 `Note` 는 첫 등록에 기준선을 함께 받는다

`gitwatch.go:174` — 첫 표명은 `lastMark` 를 함께 세운다. 표명과 첫 회차 사이의 변화를
놓치지 않기 위한 것이다(`GIT_PUSH_OBSERVE_SRS` §2.8). 재표명은 기준선을 덮지 **않는다**
(`:161-166`).

이 규약은 그대로 둔다. 임차인이 바뀌어도 기준선의 주인은 저장소이지 임차인이 아니다.

### 2.5 상한과 비용

`GitWatchCap = 16`, `GitWatchInterval = 1s`. 감시 하나당 1초마다 `git status` 하나가
돈다. 상한이 있는 이유가 이것이고, 임대를 늘리면 그 비용이 늘어난다 — 그래서 상한은
유지하고 퇴출 규칙만 다시 쓴다 (FR-GWL-6).

### 2.6 저장된 설정은 스스로 정리된다

`pollValue`(`app-polling.js:82-91`)는 선택지 범위 밖 값을 기본값으로 떨어뜨리고, `0`은
`spec.off` 인 주기에서만 통과시킨다. 그러므로 **선택지에서 빼면 이미 저장한 값도 다음
부팅에 기본값으로 돌아간다** — 별도 마이그레이션 코드가 필요 없다.

### 2.7 제약 (Constraints)

- 새 런타임 의존을 넣지 않는다.
- `gitapi` 는 `hub` 를 참조하지 않는다 (`gitapi.go:52` — 방향은 합성 루트에서만 만난다).
  `RepoWatcher` 인터페이스를 넓히는 방식으로만 서버 쪽을 잇는다.
- `Watch` 가 nil 인 구성에서도 핸들러가 그대로 돌아야 한다 (`gitapi.go:53-54`).
- `clientId` 없는 표명은 계속 받아야 한다. 옛 화면·스크립트·`curl` 이 그렇게 부른다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 L — 임대 (서버)

**FR-GWL-1** `GitWatcher` 는 저장소마다 **임차인 집합**(`clientId → epoch`)을 든다.
`NoteFor(repo, obs, clientID)` 는 `clientID` 가 비어 있지 않고 그 신원의 SSE 구독이
살아 있으면 그 저장소의 임차인 집합에 넣는다.

**FR-GWL-2** **임차인이 하나라도 있는 저장소는 유휴 시간으로 만료되지 않는다.**
`evictLocked` 의 TTL 검사는 임차인 집합이 빈 항목에만 적용된다.
근거는 §1.4 의 사용자 요구다 — 띄워 두고 보기만 하는 동안에도 갱신이 살아 있어야 한다.

**FR-GWL-3** SSE 구독이 열리면 `Attach(clientID) → epoch`, 닫히면
`Detach(clientID, epoch)` 로 그 신원을 **모든** 저장소의 임차인 집합에서 뺀다.
**grace period 는 없다** — 구독이 끝나는 것이 곧 해제다 (FR-XDF-9 와 같은 규약).
`Detach` 는 `ep` 가 그 신원의 최신 구독일 때만 동작한다 — 재연결 뒤 도착한 옛 연결의
정리가 새 임대를 지우면 안 된다 (FR-XDF-10 과 같은 규약).

**FR-GWL-4** 임차인이 모두 빠진 저장소는 종전 규칙으로 돌아간다 — 마지막 표명에서
`GitWatchTTL` 이 지나면 만료. 브라우저를 닫으면 감시가 곧 걷힌다는 뜻이다.

**FR-GWL-5** `clientID` 가 빈 표명은 종전과 같이 **TTL 임대**다. 기존 `Note(repo, obs)`
는 시그니처를 유지하고 `NoteFor(repo, obs, "")` 와 동치다.

**FR-GWL-6** 상한 `GitWatchCap` 은 유지한다. 초과 시 퇴출 순서는
① 임차인 없는 것 중 표명이 가장 오래된 것,
② 그래도 넘으면 임차인 있는 것 중 표명이 가장 오래된 것.
**퇴출을 로그로 남긴다** — 종전에는 조용했다 (`GP-16` 해소). 만료·탈락·퇴출 셋이
로그에서 갈려야 한다 (FR-GLW-7 의 연장).

**FR-GWL-7** `RepoWatcher` 인터페이스에 `NoteFor` 를 더한다. `gitapi` 는 `hub` 를
계속 참조하지 않는다.

**FR-GWL-8** `Watch` 가 nil 이거나 `Attach`/`Detach` 가 불리지 않는 구성에서도 종전
동작(TTL 임대)이 그대로 성립한다.

### 3.2 묶음 C — 브라우저

**FR-GWL-9** `GET /api/git/status` 가 `clientId` 를 쿼리에 싣는다. 값은 `App.clientId`
— SSE 를 여는 것과 같은 신원이다 (`app-cmd.js:105`).

**FR-GWL-10** 응답의 `requested` echo 검증(FR-GIT-16)은 영향받지 않는다. `clientId` 는
echo 대조 대상이 아니다.

### 3.3 묶음 S — 설정

**FR-GWL-11** `gitStatusInterval` 의 선택지에서 `1분`(60000)·`2분`(120000)을 뺀다.
남는 것은 `[10초, 30초, 끔]` 이다.
근거: 임대가 폴링에서 풀리면 긴 안전망은 뜻이 없다 — 놓친 것을 줍는 그물이 1~2분에 한
번이면 그물이라기보다 없는 것에 가깝고, 그 사이는 push 가 이미 덮는다. 짧게 두거나
끄거나 둘 중 하나다.

**FR-GWL-12** `off:true` 와 `끔`(0)은 유지한다. FR-GWL-1~4 이후 `끔`은 안전하다 —
폴링이 0건이어도 SSE 가 붙어 있는 한 감시가 유지되고 변경 즉시 push 가 온다.

**FR-GWL-13** 저장된 `60000`·`120000` 은 `pollValue` 의 범위 검사에 걸려 기본값
(`GIT_STATUS_POLL_MS` = 30000)으로 돌아간다. 마이그레이션 코드를 쓰지 않는다 (§2.6).

### 3.4 비기능 요구 (NFR)

**NFR-GWL-1** 감시 대상 수의 상한은 종전과 같다(`GitWatchCap`). 임대가 길어져도 `git`
실행 빈도의 상한은 바뀌지 않는다.

**NFR-GWL-2** 임차인 집합의 조작은 `GitWatcher.mu` 안에서만 일어난다. `Detach` 는 저장소
수에 선형이고 저장소 수는 상한이 16이다.

**NFR-GWL-3** `-race` 에서 통과해야 한다. SSE 핸들러(요청 고루틴)와 `Tick`(티커 고루틴)이
같은 맵을 만진다.

---

## 4. 검증 (Verification)

### 4.1 서버 (Go, `internal/webserver/hub/gitwatch_test.go`)

| ID | 확인 |
|---|---|
| TC-GWL-1 | `Attach` 한 신원으로 `NoteFor` 한 저장소는 **TTL 의 몇 배가 지나도** 감시에 남는다 (FR-GWL-2) |
| TC-GWL-2 | 그 상태에서 signature 가 바뀌면 여전히 방송된다 — 임대만 살아 있고 관측이 죽어 있지 않다 |
| TC-GWL-3 | `Detach` 뒤에는 TTL 만료가 다시 적용돼 감시가 걷힌다 (FR-GWL-4) |
| TC-GWL-4 | 옛 epoch 의 `Detach` 는 새 구독의 임대를 지우지 않는다 (FR-GWL-3) |
| TC-GWL-5 | `clientID` 가 빈 `NoteFor` 는 종전 TTL 임대다 (FR-GWL-5) |
| TC-GWL-6 | 임차인 둘 중 하나만 `Detach` 하면 감시가 남는다 |
| TC-GWL-7 | 상한 초과 시 임차인 없는 것이 먼저 나가고, 퇴출이 로그에 남는다 (FR-GWL-6) |
| TC-GWL-8 | `Attach` 없이 `NoteFor(repo, obs, "cid")` 를 부르면 TTL 임대로 떨어진다 (FR-GWL-8) |

기존 `TestGitWatch_InterestExpires`·`_NoteRefreshes`·`_CapEvictsOldest` 는 그대로
통과해야 한다 — FR-GWL-5 가 그 경로를 보존한다.

### 4.2 배선 (Go, `internal/webserver/httpapi`)

| ID | 확인 |
|---|---|
| TC-GWL-9 | `clientId` 를 실은 SSE 를 열면 `Attach` 가 불리고, 끊으면 `Detach` 가 불린다 |
| TC-GWL-10 | `clientId` 없는 SSE 는 임대를 만들지 않는다 (종전 호출 형태 하위 호환) |

### 4.3 브라우저 (e2e)

| ID | 확인 |
|---|---|
| TC-GWL-11 | `gitStatusInterval=0` 에서 Repo 창을 열고 TTL 을 넘겨 기다린 뒤(탭 전환·포커스 이동 없이) 터미널에서 파일을 만들면 **화면이 갱신된다** |
| TC-GWL-12 | 같은 조건에서 서버 로그에 `관심 표명 만료` 가 **남지 않는다** |
| TC-GWL-13 | `pi-gitstatus` 의 선택지가 `[10초, 30초, 끔]` 이다 (FR-GWL-11) |

TC-GWL-11·12 는 브라우저 없이 더 곧게 잴 수 있고, 실제로 그렇게 쟀다 (§4.5).
e2e 에 남는 몫은 **status 요청이 자기 신원을 싣는가** 하나다(GWL1) — 임대의 계약
자체는 Go 가 이미 다 재기 때문이다.

### 4.5 재현 검증 — 실제 실행 결과 (2026-09-10)

`GP-1` 재현 절차(`11-git-polling.md §1`)를 실제 바이너리로 돌렸다. 브라우저 대신
`curl` 로 SSE 를 열고 status 를 **한 번만** 보낸 뒤 100초를 침묵했다 — `끔` 설정과
같은 조건이다(요청을 내는 정기 경로가 없다).

| | status 요청 | 100초 침묵 뒤의 변경 | 서버 로그 |
|---|---|---|---|
| **처리군** | `?repo=…&clientId=…` | `git_changed` **1건 도착** | `관심 표명 만료` **없음** |
| **대조군** | `?repo=…` (신원 없음) | **오지 않음** | `관심 표명 만료 … idle=1m30s` |

대조군이 실패한다는 것이 이 검증이 실제로 무언가를 잰다는 근거다 — 대조군은 개정
전 동작 그대로이고, 거기서 `GP-1` 이 그대로 재현된다.

**남은 수동 확인 하나**: 위는 서버 계약을 잰다. 브라우저에서 설정을 `끔`으로 두고
Repo 창을 연 채 90초 이상 기다린 뒤(탭 전환·포커스 이동 금지) 터미널에서 파일을
만들어 화면이 갱신되는 것을 눈으로 보는 절차는 자동화하지 않았다. TTL 을 줄이는
시험 전용 노브를 제품 코드에 새로 내는 값이 그 자동화의 값보다 크다고 판단했다.

### 4.4 회귀 — 이 SRS 가 고쳐야 하는 기존 검사

| 파일 | 무엇이 왜 바뀌는가 |
|---|---|
| `e2e/poll-interval.spec.ts` PIS4 | `gitStatusInterval: 60000` 이 선택지에서 빠졌다. `30000` 으로 (FR-GWL-11·13) |
| `e2e/poll-interval.spec.ts` PIS18 | `끔`(0) 선택지는 그대로 남으므로 **변경 없음** (FR-GWL-12) |
| `e2e/git-polling.spec.ts` P4·P5 | 주기 0 으로 폴링을 끄고 재는 검사다. `끔`이 남으므로 **변경 없음** |

`끔`을 지우지 않는 것이 회귀 비용을 여기까지 줄인다 — 그것이 FR-GWL-12 의 실무적 근거다.

---

## 5. 구현 계획

| 순서 | 대상 | 내용 |
|---|---|---|
| 1 | `hub/gitwatch.go` | `gitWatchEntry.holders` · `Attach`/`Detach`/`NoteFor` · `evictLocked` 개정 · 퇴출 로그 |
| 2 | `hub/gitwatch_test.go` | TC-GWL-1~8 |
| 3 | `gitapi/gitapi.go` | `RepoWatcher` 에 `NoteFor` 추가 |
| 4 | `gitapi/handlers_git.go:417` | `NoteFor(root, obs, r.URL.Query().Get("clientId"))` |
| 5 | `httpapi/commands.go:68` | 기존 `Focus.AttachFrom` 옆에 `gitWatch.Attach` · `defer Detach` |
| 6 | `httpapi/*_test.go` | TC-GWL-9·10 |
| 7 | `web/js/git/panel-poll.js:430` | status 요청에 `clientId` |
| 8 | `web/js/core/app-polling.js:52` | 선택지에서 `1분`·`2분` 제거 |
| 9 | `e2e/poll-interval.spec.ts` | PIS4 의 60000 → 30000 |
| 10 | 문서 | `GIT_PUSH_OBSERVE_SRS` FR-GPO-11 · `POLL_INTERVAL_SETTINGS_SRS` FR-PIS-9 에 개정 표시 |

### 5.1 이전 동작 / 새 동작 / 이유

| | 이전 | 새 |
|---|---|---|
| 감시 임대의 주체 | `GET /api/git/status` 요청 | SSE 구독(`clientId`). 요청은 하위 호환 경로로 남는다 |
| 유휴 만료 | 마지막 요청에서 90초. 예외 없음 | 임차인이 있으면 만료 없음. 없으면 종전과 같다 |
| `gitStatusInterval = 끔` | 90초 뒤 자동 갱신 영구 정지 | 정상. push 가 본줄이고 폴링은 그물이었다는 원래 설계대로 |
| `gitStatusInterval` 선택지 | `10초·30초·1분·2분·끔` | `10초·30초·끔` |
| 상한 초과 퇴출 | 조용함 | 로그에 남는다 |

이유: 안전망 폴링이 임대 갱신까지 겸하고 있었고, 그 겸직이 "안전망을 끄면 본줄이 끊긴다"
는 결함을 만들었다. 임대를 연결로 옮기면 두 일이 분리되고, 사용자가 요청 수를 줄이려고
고른 설정이 제품을 망가뜨리지 않는다.
