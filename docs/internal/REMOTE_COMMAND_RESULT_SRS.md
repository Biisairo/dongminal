# SRS: 원격 명령 결과 반환 (long-poll correlation) — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`splitH/splitV/newTab/newSession` 등 **새 엔터티를 만드는 원격 명령**의 호출자(dmctl/MCP)가 그 명령으로 생성된 엔터티의 uuid 를 **한 번의 요청-응답으로 정확히** 받도록 한다.

현재 새 엔터티 식별자(session/region/tab id)는 브라우저가 카운터로 생성하고(`web/app.js`), 명령은 SSE 비동기 broadcast 라서, 호출자는 `list_panes` 재조회 + diff/이름필터 휴리스틱에 의존한다 — 동시성·중복이름에 취약. `DMCTL_WHO_AM_I_SRS`/`REMOTE_SESSION_TAB_CREATE_SRS` 가 "새 uuid 동기 반환"을 명시적 비범위로 미뤄둔 부분이다.

본 SRS 는 **request-response correlation** 으로 해결한다: 서버가 명령마다 `reqId` 를 발급하고 그 명령의 결과(브라우저가 echo 한 새 id 목록)가 도착할 때까지 HTTP 응답(또는 MCP 도구 반환)을 hold 한 뒤, 새 uuid 를 포함해 반환한다. 폴링 루프 없이 reqId 로 그 명령의 결과만 매칭하므로 다른 동작이 끼어들 여지가 구조적으로 없다.

### 1.2 범위 (Scope)
- `internal/server/commands.go` — `CommandHub` 에 pending(reqId→결과채널) 맵 + `BroadcastAndAwait` + `DeliverResult`. `handleCommandPost` long-poll. 신규 `handleCommandResult` (`POST /api/command-result`).
- `internal/server/server.go`, `internal/server/deps.go` — 라우트 등록, `CommandBroadcaster` 인터페이스 확장.
- `internal/mcptool/tools/workspacecmd.go` — broadcast 결과(새 id) 를 결과 텍스트에 포함.
- `internal/mcptool/*` (`CommandBroadcaster`), `internal/adapters/command.go` — await 경로 브리지.
- `web/app.js` — `_execRemote` 가 새 엔터티 id 수집 후 `POST /api/command-result` echo. `split`/`_mkSession`/`addTab` 이 새 id 를 반환하도록.
- `internal/runtimebin/dmctl.go` — 생성 명령 응답의 새 id 노출 (응답 JSON 통째 출력이라 자동, 필요 시 정리).
- 테스트·문서.

### 1.3 정의 (Definitions)
- **생성 명령 (creating action)**: 새 엔터티를 만드는 명령 — `splitH`, `splitV`, `newTab`, `newSession`. 그 외(`focus`/`close*`/`*Next`/`pane*`/`rename*`/`openMdTab`)는 **비생성 명령**으로 long-poll 대상이 아니다.
- **reqId**: 서버가 생성 명령마다 발급하는 1회성 상관 키.
- **echo**: 브라우저가 명령 처리 후 `POST /api/command-result {reqId, newSessions, newRegions, newTabs}` 로 보내는 결과.
- **결과 페이로드**: `{newSessions:[uuid...], newRegions:[uuid...], newTabs:[{uuid, paneId}...]}`. session/region 은 컨테이너라 uuid 만, tab 은 `{uuid, paneId}` 쌍 (호출자가 uuid→paneId 재조회 불필요). 각 배열은 그 명령으로 새로 생긴 엔터티.

### 1.4 참고 (References)
- `REMOTE_SESSION_TAB_CREATE_SRS.md`, `DMCTL_WHO_AM_I_SRS.md` — 새 uuid 반환 비범위로 명시한 선행.
- `internal/server/commands.go` — `CommandHub`, `handleCommandPost`, `Broadcast`.
- `web/app.js` `_execRemote`(~1536), `split`/`_splitInner`(~1890), `_mkSession`(~1714), `addTab`(~1799) — 새 id 생성 위치.
- `DMCTL_UUID_FINALIZE_SRS.md` — 기존 명령 응답 필드(`ok/delivered/action/location/requestedLocation`) 보존.

### 1.5 개요
2장 현황, 3장 요구사항, 4장 검증, 5장 비목표, 6장 의존.

---

## 2. 현황 (Identified Issues)

### 2.1 RCR-1 — 새 엔터티 uuid 동기 식별 불가
- **원인**: id 생성이 브라우저 카운터(`s${++this._s}`/`r${++this._r}`/`t${++this._t}`), 명령은 SSE 비동기 broadcast. 서버는 명령 응답 시점에 새 id 를 모른다.
- **현상**: 호출자는 `list_panes` 재조회 후 "기존에 없던 행" 추정. 동시 워크플로우·사용자 동작·count=N 복수 생성 시 오염/모호.
- **영향**: 워크플로우 자동화에서 "split → 새 uuid 로 다음 작업" 체인이 견고하지 못함.

### 2.2 RCR-2 — dmctl/MCP 경로 이원화
- dmctl 은 `POST /api/commands`(HTTP), MCP 는 in-process `CommandHub.Broadcast`. 결과 반환을 양쪽에 주려면 공통 await 로직이 필요.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-RCR-1** | `CommandHub` 가 생성 명령마다 1회성 `reqId` 를 발급하고, broadcast 페이로드에 `reqId` 를 포함한다. 비생성 명령은 reqId 없이 기존대로 즉시 broadcast (행위 보존). | 필수 |
| **FR-RCR-2** | `CommandHub.BroadcastAndAwait(payload, reqId, timeout)` — broadcast 후 해당 reqId 의 결과 채널을 열고, 결과 도착 또는 timeout 까지 대기해 `(결과, timedOut)` 반환. delivered=0 이면 대기하지 않고 즉시 `(빈 결과, timedOut=false, delivered=0)` 반환 (대기 무의미). | 필수 |
| **FR-RCR-3** | 신규 `POST /api/command-result` (`handleCommandResult`): body `{reqId, newSessions[], newRegions[], newTabs[]}` 를 받아 `CommandHub.DeliverResult(reqId, result)` 로 대기 중 핸들러에 전달. 미지/만료 reqId 는 무시(200, no-op) — 늦게 온 echo 가 에러를 일으키지 않게. | 필수 |
| **FR-RCR-4** | `handleCommandPost` 가 생성 명령이면 reqId 발급 → `BroadcastAndAwait` → 응답에 `newSessions/newRegions/newTabs` 추가. 기존 필드(`ok/delivered/action/location/requestedLocation`) 는 **그대로 유지**. timeout 또는 delivered=0 이면 세 배열을 빈 배열로 두고 `timedOut`(bool) 표시. | 필수 |
| **FR-RCR-5** | 비생성 명령의 `handleCommandPost` 응답은 **완전히 기존과 동일** (새 필드 없음, 대기 없음). | 필수 |
| **FR-RCR-6** | `web/app.js` `_execRemote` 가 broadcast 페이로드의 `reqId` 를 받으면, 명령 처리(split/newTab/newSession)가 만든 **새 엔터티 id 들을 수집**해 `POST /api/command-result` 로 echo. 이를 위해 `split`/`_splitInner`/`_mkSession`/`addTab` 이 생성한 id 들을 반환하도록 한다. reqId 없는(비생성) 명령은 echo 하지 않는다. | 필수 |
| **FR-RCR-7** | echo 결과 분류: newSession → `newSessions`+`newRegions`+`newTabs` 각 1개. splitH/splitV(count=N) → `newRegions` N-1(또는 N)개 + `newTabs` 동수. newTab → `newTabs` 1개. 각 `newTabs` 원소는 `{uuid, paneId}` 쌍이며 브라우저가 `_newPane()` 으로 받은 paneId 를 그대로 담는다. 브라우저가 실제 생성한 것만 담는다. | 필수 |
| **FR-RCR-8** | MCP `workspace_command` 가 생성 명령이면 `BroadcastAndAwait` 경로로 결과를 받아 결과 텍스트에 `newTabs=[uuid(paneId) ...]` (해당 시 newSessions/newRegions 도) 부착 — uuid 와 paneId 를 함께 표시. 비생성 명령은 기존 출력 유지. `CommandBroadcaster` 인터페이스를 await 지원하도록 확장. | 필수 |
| **FR-RCR-9** | dmctl 생성 명령(`split-h/v`, `new-tab`, `new-session`) 응답에 새 id 가 노출된다 (응답 JSON 통째 stdout 패턴이라 자동). `--json` 친화 유지. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-RCR-0 | **행위 보존** — 비생성 명령·기존 응답 필드·dmctl 기존 명령 동작 무변경. echo 미지원(구버전) 브라우저에서도 timeout 후 기존 응답 형태로 정상 반환 (graceful degradation). |
| NFR-RCR-1 | long-poll timeout 기본값은 named 상수로 정의(하드코딩 금지)하고 환경변수로 조정 가능. 기본은 브라우저 1회 라운드트립을 충분히 덮되 과하지 않은 값(예: 수 초). dmctl/HTTP 클라이언트 타임아웃은 이보다 길게. |
| NFR-RCR-2 | pending 맵은 reqId 만료(timeout 시 정리)로 누수 없음. `DeliverResult` 와 timeout 정리 간 경합 안전(채널 1회성, mutex 보호). |
| NFR-RCR-3 | **단일 활성 클라이언트 가정** — delivered>1(다중 브라우저)일 때 첫 echo 를 채택하고 reqId 채널을 닫는다. 나머지 브라우저의 중복 생성/echo 는 본 SRS 범위 밖(기존 멀티브라우저 동작과 동일하게 workspace_changed 로 수렴). |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-RCR-1 | await 로직은 `CommandHub` 한 곳에 두고 HTTP(handleCommandPost)·in-process(MCP adapters) 양 경로가 공유 (RCR-2 이원화 해소). |
| DC-RCR-2 | `reqId` 발급·결과 페이로드 키는 lowerCamelCase, 충돌 없는 일반 이름. |
| DC-RCR-3 | 브라우저 echo 실패(네트워크)는 무시 — 서버 timeout 이 백스톱. echo 는 best-effort. |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-RCR-1** (Go) | `BroadcastAndAwait` 후 다른 goroutine 이 `DeliverResult(reqId, {newTabs:[{uuid,paneId}]})` | 결과 반환(uuid+paneId), timedOut=false |
| **TC-RCR-2** (Go) | `BroadcastAndAwait` + DeliverResult 없음 | timeout 후 빈 결과 + timedOut=true |
| **TC-RCR-3** (Go) | delivered=0 (구독자 없음) | 즉시 반환, 대기 없음, timedOut=false, 빈 결과 |
| **TC-RCR-4** (Go) | `POST /api/commands` action=splitH + 별도 goroutine 이 `POST /api/command-result` | 응답에 newTabs(각 {uuid,paneId})/newRegions 포함, 기존 필드 유지 |
| **TC-RCR-5** (Go) | `POST /api/commands` action=focus (비생성) | 기존 응답과 동일, 새 필드 없음, 대기 없음 |
| **TC-RCR-6** (Go) | `POST /api/command-result` 미지 reqId | 200 no-op, 패닉/에러 없음 |
| **TC-RCR-7** (Go) | MCP `workspace_command(newSession,...)` + DeliverResult | 결과 텍스트에 newSessions/newTabs 부착 |
| **TC-RCR-8** (Go) | MCP 비생성(`focus`) | 기존 텍스트 유지 |
| **TC-RCR-9** (e2e) | `_execRemote('splitV',{reqId, location, count})` 처리 후 | `POST /api/command-result` 가 새 region uuid + tab {uuid,paneId} 로 호출됨(네트워크 가로채 검증), 포커스 무영향 |
| **TC-RCR-10** (e2e) | reqId 없는 명령(`splitV` 단축키 경로) | echo 호출 없음 (기존 동작) |
| **TC-RCR-11** (Go) | pending 누수 — timeout 다수 발생 후 맵 비어 있음 | 누수 없음 |

### 4.2 완료 조건 (DoD)
- [ ] `CommandHub` pending/await/deliver + `handleCommandResult` 라우트.
- [ ] `handleCommandPost` 생성/비생성 분기 + 응답 확장.
- [ ] MCP workspace_command await 경로 + `CommandBroadcaster` 확장 + adapters 브리지.
- [ ] web `_execRemote` echo + split/_mkSession/addTab 반환값.
- [ ] TC-RCR-1~11 통과, `go test -race ./...` 그린(특히 -race 로 pending 경합 검증), playwright 그린.
- [ ] commands.md / dmctl --help / workspace_command description 갱신 (새 응답 필드 문서화).
- [ ] dongminal-workflow 스킬: 시드/팀원 식별을 명령 응답의 newTabs 로 단순화 (list_panes diff 대체).

---

## 5. 비목표 (Non-goals)
- 다중 브라우저 동시 실행 시 중복 생성 해결 (기존 멀티브라우저 이슈, NFR-RCR-3 가정으로 회피).
- 비생성 명령의 결과 반환 (close 후 무엇이 사라졌는지 등) — 후속.
- 클라이언트 제공 id 주입(B-2 방식) — 본 SRS 는 echo-back 채택.
- reqId 의 호출자 노출/재시도 API — 서버 내부 상관용.

---

## 6. 의존 / 후속
- 의존: `REMOTE_SESSION_TAB_CREATE_SRS`(name/keepFocus), `LIST_PANES_NAME_FILTER_SRS`(폴백 식별), `DMCTL_UUID_FINALIZE_SRS`(응답 필드 보존).
- 후속: dongminal-workflow 스킬 본문을 newTabs 응답 기반으로 갱신(본 DoD 포함). closeTab/closeSession 의 "사라진 id" 반환은 별도 검토.
