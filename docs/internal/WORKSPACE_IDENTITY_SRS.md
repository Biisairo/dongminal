# SRS: 워크스페이스 식별자와 단일 실행자 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

다중 클라이언트가 정상 경로가 된 뒤(FR-XDF-\*, 창 포커스 소유권이 서버 권위로 이동)
**엔터티 식별자가 클라이언트별 카운터로 만들어져 충돌하고, 생성 명령이 구독 중인 모든
클라이언트에서 각자 실행되어 자원을 중복 할당한다.** 두 결함은 오케스트레이터가
`Run→Member→Tool` 을 결속하기 전에 닫아야 한다 — 에이전트가 캡처한 id 가 실제 도구를
가리키지 않으면 그 위에 쌓는 모든 결속이 무효다.

본 SRS 는 (1) 식별자 생성을 클라이언트별 카운터에서 **uuid** 로 바꾸고, (2) 엔터티를
생성하는 브로드캐스트 명령을 **단일 실행자**만 수행하게 한다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| I | 프론트엔드 엔터티 id 를 `crypto.randomUUID()` 로 생성. `_s`/`_r`/`_t` 카운터와 seeding 제거 |
| X | 서버가 생성 명령의 **실행자를 지명**해 브로드캐스트 페이로드에 실어 보내고, 지명되지 않은 클라이언트는 그 명령을 건너뛴다 |

**미포함:** §5 비목표. 특히 워크스페이스 PUT 의 last-write-wins(§2.4 (iii))는 본 SRS 가
고치지 않는다.

### 1.3 정의 (Definitions)

`Client` / `Window` / `Pane` / `Tab` / `Tool` 은 `ENTITY_MODEL_RESTRUCTURE_SRS.md`
§1.3 을 따른다. 본 SRS 고유 용어만 정의한다.

| 용어 | 정의 |
|------|------|
| **엔터티 id** | `workspace.json` 안에서 Window·Pane·Tab 을 지목하는 문자열. 현행 `s{n}`/`r{n}`/`t{n}` |
| **좌표 라벨** | `W{n}.P{n}.T{n}`. 위치에서 파생되며 다른 창이 닫히면 reflow 된다. 엔터티 id 와 별개다 |
| **생성 명령** | 새 엔터티를 워크스페이스 트리에 추가하는 브로드캐스트 명령. §3.2 가 집합을 확정한다 |
| **실행자 (executor)** | 한 브로드캐스트 명령을 실제로 수행하도록 서버가 지명한 단일 Client |
| **live 구독** | `/api/commands/sse?clientId=…` 로 연결되어 `FocusRegistry.live` 에 등록된 Client |

### 1.4 참고 (References)

- `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` — 엔티티 모델, 좌표계
- `docs/internal/USER_CHECKLIST_FIXES_SRS.md` §3.5 — FR-XDF-\*, `FocusRegistry`
- `docs/internal/archive/REMOTE_COMMAND_RESULT_SRS.md` — `creatingActions`, `reqId` echo
- `docs/internal/archive/UUID_IDENTITY_SRS.md` — 컬럼명·필드명만 적용되고 실제 id 체계에는
  적용되지 않았다 (§2.5)
- `docs/internal/NEXT_SESSION_PROMPT.md` §0-B — 본 SRS 의 착수 지시

### 1.5 개요 (Overview)

§2 실측된 현황, §3 요구사항(묶음 I·X), §4 검증, §5 비목표, §6 기존 요구사항 개정,
§7 변경 기록.

---

## 2. 현황 (Identified Issue)

### 2.1 충돌은 재현된다 — 정상 경로에서

두 브라우저 컨텍스트를 붙인 뒤 `POST /api/commands {action:newTab}` 을 **한 번** 보냈다.

```
A before {"counters":{"s":1,"r":1,"t":1},"tabs":[{"id":"t1","toolId":"1"}]}
B before {"counters":{"s":1,"r":1,"t":1},"tabs":[{"id":"t1","toolId":"1"}]}
서버 도구 수 before=1

newTab -> {"delivered":2, "newTabs":[{"uuid":"t2","toolId":"2"}], ...}

A after  {"counters":{"s":1,"r":1,"t":2},"tabs":[{"id":"t1","toolId":"1"},{"id":"t2","toolId":"3"}]}
B after  {"counters":{"s":1,"r":1,"t":2},"tabs":[{"id":"t1","toolId":"1"},{"id":"t2","toolId":"3"}]}
서버 도구 수 after=3
서버 탭   [{"id":"t1","toolId":"1"},{"id":"t2","toolId":"3"}]
```

관측된 사실 네 가지다.

1. `delivered=2` — **두 클라이언트가 각자 실행했다.** 게이팅이 없다.
2. 둘 다 같은 탭 id `t2` 를 만들었다. 카운터가 같은 값에서 seeding 됐기 때문이다.
3. 도구가 1개에서 **3개**로 늘었다. 각 클라이언트가 `POST /api/tools` 로 자기 PTY 를
   만들었고, 워크스페이스는 하나만 참조하므로 **1개는 즉시 고아**다.
4. 명령 응답의 `newTabs[0].toolId` 는 `2` 인데 수렴한 트리의 `t2` 는 `toolId 3` 이다 —
   **CLI·에이전트가 받은 id 가 아무도 보지 않는 PTY 를 가리킨다.**

두 클라이언트가 브로드캐스트 없이 **각자 로컬로** 탭을 만드는 경로(사람 둘이 각자
브라우저에서 새 탭)도 같은 결과였다 — 같은 id, 고아 PTY, 그리고 한쪽 탭이 사라지는
lost update.

### 2.2 (i) 식별자 — 카운터는 클라이언트별 상태다

```
web/js/app.js:15    this._s=0;this._r=0;this._t=0;
web/js/app.js:126   const n=parseInt(s.id.replace(/\D/g,''),10); if(n>this._s) this._s=n;   // 초기 로드
web/js/app.js:267   (동일 — 워크스페이스 재동기화)
web/js/app.js:501-502  Pane·Tab 카운터 seeding
```

생성부는 `s${++this._s}` / `r${++this._r}` / `t${++this._t}` 8곳이다. 카운터는 로드된
워크스페이스의 최댓값에서 seeding 되므로 **같은 상태를 본 두 클라이언트는 반드시 같은
다음 값을 낸다.** 동기화 전에 둘 다 생성하면 충돌은 우연이 아니라 필연이다.

### 2.3 (ii) 실행 모델 — 게이팅이 없다

`/api/commands` 는 페이로드를 모든 SSE 구독자에게 브로드캐스트하고
(`internal/server/commands.go` `handleCommandPost`), 각 브라우저는 수신 즉시
`_execRemote` 를 부른다 (`web/js/app.js:214`). 어느 클라이언트가 수행할지를 정하는
장치가 **없다**. `focus` 처럼 클라이언트마다 각자 수행하는 것이 옳은 명령과, `newTab`
처럼 한 번만 수행해야 하는 명령이 같은 경로를 탄다.

### 2.4 (iii) 저장 — last-write-wins (본 SRS 비목표)

`_save`(`app.js:1591`)는 `If-Match` 로 낙관적 잠금을 걸지만, 409 를 받으면 ETag 만 새로
받아 **자기 상태를 그대로 재PUT** 한다. 머지가 없으므로 동시 편집은 뒤에 쓴 쪽이
전부 이긴다. (i)(ii)를 고쳐도 사람 둘이 각자 브라우저에서 동시에 탭을 만들면 한쪽이
유실된다. 오케스트레이터 경로(`dmctl` → `/api/commands` → 브로드캐스트)는 묶음 X 가
덮으므로 본 SRS 의 목표에서 제외한다 (§5).

### 2.5 부수 검증 사실

| 사실 | 근거 |
|---|---|
| `internal/uuid` 의 v7 생성기는 **저장소 전체에서 import 0건**이다 | `grep -rn "internal/uuid"` 가 문서 2건만 반환. 테스트도 in-package |
| `internal/migrate` 는 uuid 를 만들지 않는다 | 패키지 내 `uuid` 참조 0건 |
| 엔터티 id 는 전 계층에서 **opaque 문자열**이다 | 접두사로 종류를 판별하는 코드 0건 (JS·Go·e2e). id 형태를 단정하는 정규식 0건. id 로 정렬하는 코드 0건 |
| id 는 DOM 에서 **속성 선택자**로만 쓰인다 | `[data-tab-id="…"]`·`[data-paneid]`. `#id` 형태 선택자 없음 → 숫자로 시작하는 값도 안전 |
| `internal/toolline` 에 고정 폭 가정이 없다 | 폭 지정 포맷 0건 |
| 서버는 이미 탭 id 를 인덱싱한다 | `workspace.Manager.IsKnownTabID` |
| 서버는 이미 연결된 clientId 집합을 안다 | `FocusRegistry.live` (`/api/commands/sse?clientId=` 에서 `Attach`) |

**따라서 id 형식 변경은 `workspace.json` 마이그레이션을 필요로 하지 않는다** — 구 id
(`s1`/`t1`)와 신 id(uuid)는 같은 트리에 섞여도 무해하다. 이것이 "서버 발급"이 아니라
"프론트 uuid 생성"을 택한 근거다 (§6 결정 기록).

### 2.6 문서와 어긋난 사실

| 문서 서술 | 실측 |
|---|---|
| 사용자 인스턴스는 v1 이고 마이그레이션 미실행 | **이미 v2.** `~/.dongminal/{workspace,panes,settings}.json.v1.bak` 3개가 존재하고 `panes.json`→`tools.json` 전환이 끝나 있다 |
| 루트 `./dongminal` 은 17일째 도는 낡은 바이너리 | HEAD 시점으로 재빌드돼 있다 |
| — | `~/.dongminal/runs.json` 에 UUID v7 기반 Run 레코드(`projection`·`isolation`·`state`)가 있으나 **커밋된 코드에 소비자가 없다.** 실행 중 바이너리에 `runs.json` 문자열조차 없다 — 어떤 바이너리도 만들지 않은 산출물이다 |

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 I — 식별자

**FR-WID-1** Window·Pane·Tab 의 id 는 생성 시점에 `crypto.randomUUID()` 로 만든다.
클라이언트별 카운터(`_s`/`_r`/`_t`)와 그 seeding 코드를 제거한다.

**FR-WID-2** 기존 id(`s{n}`/`r{n}`/`t{n}`)는 그대로 유효하다. 마이그레이션하지 않으며
구 id 와 uuid 가 한 트리에 섞이는 것을 정상으로 취급한다. `workspace.json`
`schemaVersion` 은 올리지 않는다.

**FR-WID-3** 좌표 라벨(`W{n}.P{n}.T{n}`)의 생성 규칙은 변경하지 않는다. 좌표는 위치에서
파생되며 엔터티 id 와 무관하다.

**FR-WID-4** 두 클라이언트가 동기화 전에 각각 엔터티를 만들어도 id 가 충돌하지 않는다.

### 3.2 묶음 X — 단일 실행자

**FR-SXE-1** 다음 action 은 **단일 실행자 명령**이다 — 새 엔터티를 워크스페이스 트리에
추가하기 때문이다.

`newWindow` · `newTab` · `splitH` · `splitV` · `openEditorTab` · `restoreTool`

그 외 action(`focus`·`rename*`·`closeTab`·`closeWindow`·`detachTab`·`tab*`·`window*`·
`pane*`)은 기존대로 전 클라이언트가 수행한다. `focus` 는 클라이언트마다 자기 뷰를
움직이는 것이 정의상 옳고, 나머지는 멱등이다.

**FR-SXE-2** 서버는 단일 실행자 명령을 브로드캐스트할 때 페이로드 최상위에
`execClientId` 를 실어 실행자를 지명한다. 그 외 명령에는 필드를 넣지 않는다.

**FR-SXE-3** 클라이언트는 수신한 페이로드에 `execClientId` 가 있고 자기 `clientId` 와
다르면 그 명령을 **수행하지 않는다**. 판정은 action 종류를 보지 않는다 — 어떤 명령을
게이팅할지는 서버만 정한다.

**FR-SXE-4** 실행자는 **live 구독 중인 Client 중 가장 최근에 창 포커스를 주장한
Client** 다. 주장 이력이 있는 live Client 가 없으면 가장 오래된 live 구독을 쓴다.

근거: "가장 오래된 구독" 만으로 정하면 다른 기기에 잊힌 배경 탭이 영구 실행자가 되어,
`location` 없는 생성 명령이 **사람이 보고 있지 않은 곳**에 계속 쌓인다. 포커스 주장
이력은 "지금 작업 중인 사람"의 가장 값싼 근사다.

**FR-SXE-5** live 구독이 하나도 없으면 `execClientId` 를 비운다. 그러면 FR-SXE-3 이
게이팅하지 않으므로 동작이 현행과 같아진다 — `clientId` 를 보내지 않는 구독자에 대한
안전한 열화다.

**FR-SXE-6** `delivered` 의 의미는 바꾸지 않는다 — 브로드캐스트 수신자 수다. 실제
수행자는 1 이지만, 이 값은 "구독 중인 브라우저가 있는가"를 판정하는 데 쓰인다.

**FR-SXE-7** `reqId` echo(`FR-RCR-*`)는 실행자 하나에서만 오므로, 생성 명령 응답의
`newTabs`/`newPanes`/`newWindows` 는 실제로 수렴한 트리와 일치한다.

### 3.3 오케스트레이터 식별자 계약

**FR-SXE-8** `location` 없는 생성 명령은 **실행자의 포커스 Pane** 에 들어간다. 실행자는
서버가 정하므로 호출자가 통제할 수 없다. 따라서 오케스트레이터는 Run 멤버의 도구를
다룰 때 **항상 `location` 을 명시한다** — 0-A 의 `restoreTool` 규약과 같은 방어이며,
`RUN_ORCHESTRATION_SRS` 가 이를 규약으로 싣는다.

---

## 4. 검증 (Verification)

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-WID-1 | FR-WID-1 | 탭·분할 칸·창을 하나씩 생성 | 세 id 모두 uuid 형식. `s{n}`/`r{n}`/`t{n}` 아님 |
| TC-WID-2 | FR-WID-2 | 구 id 가 든 워크스페이스를 로드하고 탭 추가 | 구 id 보존, 신규만 uuid. `schemaVersion` 2 유지 |
| TC-WID-3 | FR-WID-4 | 두 클라이언트가 동기화 전 각각 로컬 생성 | 두 id 가 다르다 |
| TC-WID-4 | FR-WID-3 | 창 2개에서 좌표 라벨 조회 | `W{n}.P{n}.T{n}` 형식 유지 |
| TC-SXE-1 | FR-SXE-4 | live 0·1·다수, 포커스 주장 이력 유무 | 지명 규칙대로. 결정적 |
| TC-SXE-2 | FR-SXE-4 | 실행자가 Detach 된 뒤 재선출 | 남은 live 중에서 고른다 |
| TC-SXE-3 | FR-SXE-2 | 단일 실행자 명령 POST | 페이로드에 `execClientId` |
| TC-SXE-4 | FR-SXE-2 | `focus` 등 비게이팅 명령 POST | `execClientId` 없음 |
| TC-SXE-5 | FR-SXE-5 | live 구독 0 | `execClientId` 빈 값 |
| TC-SXE-6 | FR-SXE-1/3/7 | 클라이언트 2개 + `newTab` 1회 (§2.1 재현) | 탭 1개만 생성. 서버 도구 +1. 응답 `newTabs[0].toolId` 가 수렴 트리와 일치 |
| TC-SXE-7 | FR-SXE-3 | 클라이언트 2개 + `focus` | 두 클라이언트 모두 수행 (게이팅 안 됨) |

전체 회귀: `go test ./...`, `npx playwright test` 전량 통과.

---

## 5. 비목표 (Non-goals)

| 항목 | 근거 |
|---|---|
| 워크스페이스 PUT 의 머지 (§2.4 (iii)) | 사람 둘이 각자 브라우저에서 동시에 편집하는 경로에만 남는다. 오케스트레이터 경로는 묶음 X 가 덮는다. 머지는 트리 구조 CRDT 급 설계라 별도 SRS |
| 서버가 id 를 발급 | §2.5 대로 프론트 uuid 로 충돌이 닫히고 마이그레이션이 불필요하다. 서버 발급은 엔터티 생성마다 왕복이 생기고 낙관적 생성 흐름을 재작성해야 한다 |
| `internal/uuid`(Go v7) 사용 | 소비자가 0개인 죽은 패키지다. 본 SRS 는 브라우저에서 생성하므로 되살릴 이유가 없다. 제거 여부는 별건 |
| 고아 도구 회수 | 묶음 X 가 **생성 자체를 막으므로** 회수기가 필요 없다. 기존 고아는 `fixtures.ts`·수동 정리 대상 |
| `delivered` 의미 변경 | FR-SXE-6 |
| Run 레코드 (`runs.json`) | `RUN_ORCHESTRATION_SRS` |

---

## 6. 기존 요구사항 개정 (Amendments)

| 문서 | 개정 |
|---|---|
| `archive/UUID_IDENTITY_SRS.md` | 컬럼명(`uuid=`)·필드명(`TabUUID`)만 적용됐고 실제 id 체계는 카운터로 남아 있었다. 본 SRS FR-WID-1 이 그 간극을 닫는다 |
| `archive/REMOTE_COMMAND_RESULT_SRS.md` | `creatingActions` 는 `reqId` echo 대상 집합으로 유지. 단일 실행자 대상 집합(FR-SXE-1)은 그보다 넓다 (`openEditorTab`·`restoreTool` 포함) — 두 집합을 분리한다 |
| `USER_CHECKLIST_FIXES_SRS.md` §3.5 | `FocusRegistry` 에 실행자 선출 책임이 추가된다. 소유권 의미(FR-XDF-\*)는 불변 |
| `docs/internal/README.md` | "프론트엔드 id 가 UUID 가 아니다" 항목 해소. 사용자 인스턴스 마이그레이션 항목은 §2.6 대로 이미 완료 |

**결정 기록 (사용자, 2026-08-24)**

| 결정 | 선택 | 대안과 근거 |
|---|---|---|
| 식별자 발급 주체 | **프론트가 uuid 생성** | 서버 발급은 왕복·흐름 재작성·스키마 영향. 카운터+접두사는 lost update 를 남기고 id 가 클라이언트 출처를 노출. uuid 는 §2.5 대로 마이그레이션이 불필요하다 |
| 생성 명령 실행자 | **단일 실행자 선출** | 현행 유지는 고아 PTY 와 echo 불일치를 남긴다. 서버 직접 수행은 워크스페이스 변경 권위를 브라우저에서 서버로 옮기는 대공사 |

---

## 7. 변경 기록 (Change log)

| 이전 동작 | 새 동작 | 이유 |
|---|---|---|
| 엔터티 id = 클라이언트별 카운터 (`s{n}`/`r{n}`/`t{n}`) | `crypto.randomUUID()` | 같은 상태를 본 두 클라이언트가 같은 값을 내는 것이 필연이었다 (§2.2) |
| 브로드캐스트 생성 명령을 모든 구독 클라이언트가 실행 | 서버가 지명한 실행자 하나만 실행 | 클라이언트 수만큼 PTY 가 생기고 1개만 참조돼 나머지가 고아가 됐다. 명령 응답의 id 도 수렴 결과와 어긋났다 (§2.1) |
| `location` 없는 생성 명령의 착지점 | 실행자의 포커스 Pane (결정적) | 이전에도 비결정적이었다 — 전원이 각자 자기 포커스에 만들고 마지막 저장이 이겼다. 오케스트레이터는 FR-SXE-8 대로 `location` 을 명시한다 |
