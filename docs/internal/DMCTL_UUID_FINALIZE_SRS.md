# SRS: dmctl UUID 전환 마무리 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`UUID_IDENTITY_SRS` 완료 후, dmctl 의 **입력** 측은 uuid 를 수용하지만 두 가지가 미완 상태로 남았다:
- **D1**: dmctl 사용자가 uuid 를 **얻을** 수 있는 명령 자체가 없음 (`/api/state` 를 직접 호출해 JSON 을 파싱해야 함).
- **D2**: `dmctl focus <uuid>` 같은 호출의 서버 응답이 `{"ok":true,"delivered":N}` 만 반환 — uuid 가 어느 좌표로 매핑됐는지 dmctl 측에서 추적 불가.

본 SRS 는 두 결함을 동시에 보완해 dmctl 만으로 "uuid 조회 → uuid 로 동작 → 동작 결과 추적" 의 폐회로를 완성한다.

### 1.2 범위 (Scope)
- `internal/runtimebin/dmctl.go` — `list-panes` 명령 추가 + 응답 처리 정정.
- `internal/server/commands.go` — `handleCommandPost` 응답에 변환 정보 필드 추가 (additive).
- 테스트: `internal/runtimebin/dmctl_test.go`, `internal/server/commands_uuid_test.go`.
- 문서: dmctl `--help`, `docs/external/commands.md`.

### 1.3 정의 (Definitions)
- **list-panes 명령**: dmctl 의 신규 read-only 명령. `/api/state` 호출 → workspace.json 의 session/region/tab 트리 + panes 정보를 합쳐 사람 가독성 텍스트 (또는 `--json` 시 JSON) 로 출력.
- **요청 식별자 (requested)**: dmctl 사용자가 `--at` / focus positional 등으로 전달한 원본 값 (uuid 또는 좌표).
- **변환 좌표 (resolved)**: 서버가 broadcast 직전 정규화한 좌표 형식 (`S{n}.P{n}.T{n}`).

### 1.4 참고 (References)
- `UUID_IDENTITY_SRS.md` — dmctl 입력 uuid 수용 (FR-UID-8, NFR-UID-0).
- `WORKSPACE_SNAPSHOT_SRS.md` — `/api/state` 가 사용하는 Snapshot 의 일관성.

### 1.5 개요 (Overview)
2장 현황, 3장 요구사항, 4장 검증, 5장 비목표.

---

## 2. 현황 (Identified Issues)

### 2.1 D1 — uuid 조회 능력 부재
- **위치**: `internal/runtimebin/dmctl.go`. 명령 catalog 는 11개 (newSession/newTab/splitH/splitV/focus/closeTab/closeSession/sessionNext-Prev/tabNext-Prev/paneUp-Down-Left-Right) + `send` (raw). 어느 것도 read-only 정보 조회 아님.
- **현상**: dmctl 사용자가 uuid 를 얻으려면 `curl http://localhost:58146/api/state | jq` 류 외부 명령 필요.
- **영향**: dmctl 만으로 "조회 → 행동" 워크플로우 불가. UUID 도입이 dmctl 쪽에서 완결되지 않은 상태.

### 2.3 D3 — list-panes 의 uuid 컬럼이 실제 작동하지 않는 경우 (라이브 검증에서 발견)
- **위치**: `internal/workspace/manager.go` 의 `Resolve` / `CoordinateOf`.
- **현상**: `Resolve` 와 `CoordinateOf` 가 `isUUIDForm()` (36자 hex-dash) 가드 안에서만 `uuidToID` 매칭을 시도. 워크스페이스의 tab.id 가 legacy 짧은 형식 (예: `t1`, `t42`) 일 때 — UUID_IDENTITY_SRS Phase 1 도입 이전 또는 비호환 마이그레이션 상태 — `dmctl list-panes` 는 `uuid=t1` 으로 노출하지만 같은 값을 `dmctl focus t1` 에 넣어도 `CoordinateOf` 가 pass-through 해서 브라우저가 좌표 형식 못 파싱하고 노옵.
- **영향**: list-panes 의 uuid 컬럼이 거짓 정보. "조회 → uuid 로 작동" 폐회로 미완성. NFR-UID-0 (좌표/라벨/paneId pass-through) 의 의도는 보존하되, **tab.id 자체는 형식과 무관하게 좌표로 변환**해야 한다 — `uuidToID` 인덱스는 이미 모든 tab.id 를 보유.

### 2.4 D4 — 좌표/라벨/paneId 입력 전면 금지 (정책 강화)
- **위치**: `internal/server/commands.go` (handleCommandPost), `internal/mcptool/tools/workspacecmd.go` (WorkspaceCommandHandler).
- **현상**: D3 보강으로 `list-panes` 의 모든 `uuid=` 값이 좌표로 변환되지만, **기존 입력 형식인 좌표(`4.1.1`/`S2.P1.T1`)와 paneId 도 여전히 pass-through 로 허용**. 사용자가 reflow 위험이 있는 좌표를 무의식적으로 쓰는 사고 표면이 남음.
- **영향**: UUID 도입의 안정성 이점이 흐려진다. NFR-UID-0 (행위 보존) 와 충돌하지만 사용자 정책 결정으로 **breaking change** 채택 — location 인자는 `list-panes` 가 노출한 `uuid=` 값(= `uuidToID` 매칭) 만 받는다.

### 2.2 D2 — 명령 응답에 변환 추적성 부재
- **위치**: `internal/server/commands.go:182-187` (handleCommandPost 응답 인코딩), `internal/runtimebin/dmctl.go:179-190` (dmctlPost stdout 출력).
- **현상**: `dmctl focus <uuid>` 호출 시:
  ```
  $ dmctl focus 550e8400-e29b-41d4-a716-446655440003
  {"delivered":1,"ok":true}
  ```
  uuid 가 어느 좌표로 매핑됐는지 응답에 없음. 서버 로그 (`[cmd] action=focus location=S2.P1.T1 uuid=550e8400-... delivered=1`) 에는 있지만 dmctl 사용자가 접근 불편.
- **영향**: 사용자가 자기 호출의 결과를 추적 불가. uuid 가 stale 인지, 어느 좌표로 갔는지, 빈 location 으로 갔는지 알 길 없음.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-DMC-1 | `dmctl list-panes` 신규 명령 추가. `GET /api/state` 를 호출해 workspace.json 의 session/region/tab 트리를 순회하며 라벨 (`S{n}.P{n}.T{n}`) 을 재계산하고 각 tab 의 정보 (label, uuid, short_code, paneId, shellPid, session 이름, tab 이름, focused 여부) 를 한 줄에 한 pane 으로 사람 가독성 텍스트로 출력한다. | 필수 |
| FR-DMC-2 | `dmctl list-panes --json` 플래그 — 위 정보를 JSON 배열로 출력. 스크립트 친화. | 필수 |
| FR-DMC-3 | 출력 라인 형식 (기본 텍스트):<br>`▶ S1.P1.T1  uuid=550e8400-...  short=550e8400  paneId=12  shellPid=12345  session="Main"  tab="Shell"`<br>포커스 pane 만 `▶`, 비포커스는 두 칸 공백. MCP `list_panes` 의 라인 끝 부착 방식과 일치하지만 dmctl 은 처음부터 uuid 포함 형식으로 시작. | 필수 |
| FR-DMC-4 | `/api/commands` 응답 스키마 확장:<br>• 기존 필드 `ok` (bool), `delivered` (int) — **영구 유지** (NFR-UID-0).<br>• 신규 필드 `action` (string, 요청 action 그대로), `location` (string, 변환 후 좌표 — 입력에 location 이 없었으면 빈 문자열), `requestedLocation` (string, 사용자가 보낸 원본 값 — 좌표일 수도 uuid 일 수도 있음).<br>변환이 발생했을 때 (`location != requestedLocation`) 양쪽 노출로 추적 가능. | 필수 |
| FR-DMC-5 | dmctl 의 응답 출력은 **기존 동작 유지** — 서버 응답 JSON 통째로 stdout 출력 (NFR-UID-0). 신규 필드는 JSON 안에 추가되어 자동 노출. | 필수 |
| FR-DMC-6 | `dmctl --help` 에 `list-panes` 명령 + `--json` 플래그 안내 추가. dmctl `list-panes` 도 -h/--help 지원. | 필수 |
| FR-DMC-7 | `docs/external/commands.md` 의 명령 표에 `list-panes` 행 추가. | 필수 |
| FR-DMC-8 | `workspace.Manager.Resolve` 와 `CoordinateOf` 가 tab.id 의 형식(36자 UUID 여부) 과 무관하게 `uuidToID` 인덱스 매칭을 시도한다. 매칭 성공 시 좌표로 변환, 미매칭 + 36자 UUID 형식이면 stale uuid 명시적 에러, 그 외(좌표/라벨/paneId/숫자) 는 pass-through. `list-panes` 가 노출하는 모든 tab.id 가 다른 명령의 location 인자로 그대로 작동. | 필수 |
| FR-DMC-9 | `/api/commands` 와 MCP `workspace_command` 의 `location` 인자는 **`uuidToID` 매칭(즉 `list-panes` 가 노출한 `uuid=` 값) 만 허용**. 좌표(`4.1.1`/`S2.P1.T1`), 라벨, paneId(숫자), 그 외 미지 식별자는 400 응답 + 명확한 에러("list-panes 의 uuid 만 허용"). 빈 location 은 기존대로 허용(action 자체에 location 불필요한 경우). NFR-UID-0/NFR-DMC-0 의 좌표 pass-through 정책을 의도적으로 폐기. | 필수 |
| FR-DMC-10 | `workspace.Manager.IsKnownTabID(id) bool` 신규 메서드 — `uuidToID` 인덱스 매칭 여부를 boolean 으로 빠르게 검사. server `WorkspaceStore` 와 mcptool `WorkspaceReader` 인터페이스에 추가, 두 API 엔트리포인트가 거부 게이트로 사용. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-DMC-0 | **행위 보존** — 기존 dmctl 명령의 입력/출력/exit code 는 변경 없음. `/api/commands` 응답의 기존 필드 (`ok`, `delivered`) 와 순서·타입 유지. UUID_IDENTITY_SRS NFR-UID-0 와 동일 정신. |
| NFR-DMC-1 | `dmctl list-panes` 는 `/api/state` 한 번만 호출. 추가 round-trip 없음. |
| NFR-DMC-2 | `/api/state` 호출 실패 (서버 미실행, 네트워크 등) 시 stderr 에 명확한 오류 + rc=1. dmctlPost 와 동일 패턴. |
| NFR-DMC-3 | `list-panes` 텍스트 출력은 `awk` / `grep` 으로 컬럼 단위 파싱 가능 (공백 구분, 라벨/uuid/short/paneId 등 `KEY=VALUE` 형태). |
| NFR-DMC-4 | UUID 가 36자라 한 줄이 길어질 수 있음. 줄바꿈 없이 그대로 출력 (사용자 터미널이 wrap). |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-DMC-1 | dmctl 의 외부 의존 0 유지. `encoding/json` 등 표준 라이브러리만. |
| DC-DMC-2 | `list-panes` 의 출력 컬럼 순서는 MCP `list_panes` 의 라인 끝 부착 순서와 일치 (label → uuid → short → paneId → shellPid → session → tab). |
| DC-DMC-3 | 신규 응답 필드명 (`action`, `location`, `requestedLocation`) 은 향후 다른 응답에 추가될 가능성 고려해 충돌 없는 일반 이름 사용. |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

- **TC-DMC-1** (list-panes 텍스트): fake `/api/state` 가 panes + workspace 반환 → `dmctl list-panes` 가 각 tab 의 라벨·uuid·short·paneId·shellPid 를 줄당 1개로 출력. 포커스된 pane 에 ▶.
- **TC-DMC-2** (list-panes --json): 위 입력에 대해 `--json` 시 JSON 배열 반환. `jq '.[] | .uuid'` 류 파싱 가능.
- **TC-DMC-3** (list-panes 빈 워크스페이스): workspace 가 비었거나 nil 이면 "(no panes)" 류 안내 + rc=0.
- **TC-DMC-4** (list-panes 서버 오류): /api/state 404/500 → stderr 명확한 오류, rc=1.
- **TC-DMC-5** (응답 신규 필드 — uuid 변환): `/api/commands` 에 uuid 인 location 으로 POST → 응답 JSON 에 `action`, `location` (좌표), `requestedLocation` (uuid) 모두 존재.
- **TC-DMC-6** (응답 신규 필드 — 좌표 pass-through): 좌표로 POST → `location == requestedLocation`, 둘 다 좌표.
- **TC-DMC-7** (응답 신규 필드 — location 없음): focus 외 액션에 location 없이 POST → `location == ""`, `requestedLocation == ""`. 기존 응답에 없던 키지만 빈 문자열로 존재.
- **TC-DMC-8** (행위 보존 — 기존 응답 필드): 모든 시나리오에서 `ok` (true) 와 `delivered` (int) 가 존재하고 타입·값 변경 없음 (NFR-DMC-0).
- **TC-DMC-9** (행위 보존 — dmctl 기존 명령): 기존 dmctl 명령들의 동작·exit code·stderr 메시지 무변화. 기존 `dmctl_test.go` 전체 무수정 통과.
- **TC-DMC-10** (--help 갱신): `dmctl -h` 출력에 `list-panes` 안내 포함.
- **TC-DMC-11** (short tab.id 변환): workspace.json 의 tab.id 가 `t1`, `t42` 같은 비 UUID 형식이어도 `CoordinateOf("t1")` 이 `"S1.P1.T1"` 로 변환되고, `Resolve("t42")` 가 해당 paneId 반환. `dmctl focus t1` 라이브 호출 시 응답에 `location="S1.P1.T1"`, `requestedLocation="t1"` 노출.
- **TC-DMC-12** (`CoordinateOf` 자체 pass-through): 좌표 `"4.1.1"`, 라벨 `"S2.P1.T1"`, paneId `"342"`, 빈 문자열에 대해 `CoordinateOf` 자체는 여전히 pass-through(유틸리티 시맨틱 보존). 정책 거부는 별도 게이트에서.
- **TC-DMC-13** (D4 거부 게이트 — /api/commands): `POST /api/commands` 에 `args.location` 으로 좌표 `"4.1.1"`, 라벨 `"S2.P1.T1"`, paneId `"303"`, stale uuid 보내면 모두 400 + "list-panes 의 uuid 만 허용" 류 에러 메시지. 빈 location 또는 location 자체 부재(action=`newSession` 등) 는 200 유지.
- **TC-DMC-14** (D4 거부 게이트 — MCP `workspace_command`): 동일한 거부 의미. 좌표/라벨/paneId/stale uuid → tool error(MCP RPC error). uuid 매칭은 정상 broadcast.

### 4.2 완료 조건 (DoD)

- [ ] `dmctl list-panes` 구현 + `--json` 플래그.
- [ ] `/api/state` 호출 코드 + JSON 파싱.
- [ ] `handleCommandPost` 응답에 `action` / `location` / `requestedLocation` 추가.
- [ ] dmctl --help 갱신 (list-panes 안내).
- [ ] `docs/external/commands.md` 갱신.
- [ ] TC-DMC-1 ~ TC-DMC-10 통과.
- [ ] `go test -race -count=1 ./...` green.
- [ ] 기존 e2e 회귀 (Playwright) 무수정 통과 — `npx playwright test`.
- [ ] `go vet ./...` 에서 본 SRS 작업 신규 파일 vet clean (잔여는 사전 존재 경고만).

---

## 5. 비목표 (Non-goals)

- `dmctl who-am-i` 같은 현재 쉘 추적 명령 — 별도 SRS 후속 검토. 본 SRS 는 `list-panes` 의 포커스 마커 (▶) 로 우회 가능.
- 응답에 더 풍부한 메타 (`paneId`, `tabId`, `sessionId` 등) 추가 — 필요 시 후속. 본 SRS 는 추적성 핵심인 `requestedLocation` ↔ `location` 만.
- dmctl 의 자연어/단축 명령 (예: `dmctl ls` alias) — 후속.
- `--json` 의 정확한 스키마 안정성 보증 — 첫 도입이라 v1 으로 명시, 후속 변경 시 추가 SRS.
- 서버 응답의 streaming/asynchronous 결과 — 본 SRS 는 broadcast 결과만 (sync return).
- `/api/commands` 응답 필드의 **순서** 보장 — Go encoding/json 의 map 순서는 보장 안 됨. 클라이언트는 키 기반 파싱.

---

## 6. 의존 SRS / 후속 SRS

- 의존: `UUID_IDENTITY_SRS` (Phase 0~3 + 보강 완료 상태가 전제).
- 후속:
  - `DMCTL_WHO_AM_I_SRS` (선택) — 현재 쉘이 속한 pane uuid 도출.
  - `HIERARCHICAL_TEAM_SRS` — 본 SRS 완료 후 dmctl 이 계층 팀 운영 시 정보 조회용으로 활용 가능.
