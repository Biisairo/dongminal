# SRS: dmctl who-am-i + paneline 통일 — IEEE 29148

부제: dmctl `list-panes` / `who-am-i` 와 MCP `list_panes` / `who_am_i` 의 출력 라인 형식을 합집합 단일 포맷으로 통일하고, dmctl 에 `who-am-i` 신규 명령을 추가한다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`DMCTL_UUID_FINALIZE_SRS` 의 비목표(5장)로 남았던 후속 작업이다. 두 가지를 동시에 해결한다:

- **W1**: dmctl 만으로 "지금 내 쉘이 어느 pane uuid 에 속하는지" 알 방법이 없다. `list-panes` 의 ▶ 마커로 우회 가능하지만, 다중 세션·여러 단말이 동시에 떠 있을 때 ▶ 가 어느 단말의 포커스인지 모호하다.
- **W2**: dmctl 의 `list-panes` 출력 라인과 MCP 의 `list_panes` / `who_am_i` 출력 라인이 컬럼 순서·키 부착 여부·노출 필드가 다르다. 두 채널을 오가는 사용자/에이전트가 파싱·재현 시 분기 처리 필요.

본 SRS 는 (a) dmctl 에 `who-am-i [--json]` 명령을 추가하고, (b) dmctl·MCP 양쪽의 라인 형식을 **합집합 단일 포맷**으로 재정렬한다.

### 1.2 범위 (Scope)
- **신규**: `GET /api/whoami` 엔드포인트 (JSON only). `internal/server/handlers_api.go` 라우트 + 신규 핸들러.
- **신규**: `dmctl who-am-i [--json]` 명령. `internal/runtimebin/dmctl_whoami.go`.
- **신규 공용 패키지**: `internal/paneline` — `PaneLine` struct + `Render(p, focused) string` 한 줄 렌더러. dmctl 과 MCP `list_panes`/`who_am_i` 가 공유.
- **개편**: `internal/mcptool/tools/listpanes.go`, `internal/mcptool/tools/whoami.go` — `paneline.Render` 호출로 교체.
- **개편**: `internal/runtimebin/dmctl_listpanes.go` — `paneline.Render` 호출로 교체 (output 텍스트 변경; JSON 행 스키마는 유지하되 필드 추가 — additive).
- **개편**: `docs/external/commands.md`, dmctl `--help`.
- **테스트**: `internal/paneline/paneline_test.go`, `internal/server/handlers_api_test.go`, `internal/runtimebin/dmctl_test.go`, `internal/mcptool/tools/tools_test.go` + `tools_uuid_test.go`.

### 1.3 정의 (Definitions)
- **표준 라인**: 본 SRS 가 정의하는 KEY=VALUE 공백 구분 한 줄 텍스트 (3.1 FR-PL-1 참조).
- **포커스 마커**: 라인 prefix `▶ ` (사용자 브라우저 포커스 일치) 또는 `  ` (두 칸 공백).
- **자기 pane (self pane)**: `who-am-i` / `who_am_i` 호출자의 client PID 조상 체인에서 매칭된 pane.
- **합집합 (union)**: MCP `who_am_i` 가 노출하는 모든 컬럼(`label paneId shellPid size session tab uuid short session_uuid region_uuid`) + dmctl `list-panes` 의 포커스 마커.

### 1.4 참고 (References)
- `DMCTL_UUID_FINALIZE_SRS.md` — 5장 비목표 (`dmctl who-am-i` 후속 검토 명시), 6장 후속 SRS 항목.
- `UUID_IDENTITY_SRS.md` — FR-UID-6 (`who_am_i` 가 uuid/short_code 부착).
- `internal/clientpid/` — `Parent`, `FromRemoteAddr`. 조상 체인 추적 표준 경로.
- `internal/adapters/client.go` — `Client.ResolveClientPane(remoteAddr) (paneID, shellPID, error)`. MCP `who_am_i` 가 사용하는 32단계 조상 체인 매칭.

### 1.5 개요 (Overview)
2장 현황, 3장 요구사항, 4장 검증, 5장 비목표, 6장 의존/후속.

---

## 2. 현황 (Identified Issues)

### 2.1 W1 — dmctl 측 self-identification 부재
- **위치**: `internal/runtimebin/dmctl.go` 의 명령 catalog. 현재 read-only 명령은 `list-panes` 한 가지.
- **현상**: 다중 세션·다중 단말 환경에서 "지금 이 쉘이 어느 pane 인지" 알려면 `list-panes` 의 ▶ 마커에 의존. 그러나 ▶ 는 **브라우저 사용자 포커스**라 별도 단말에서 dmctl 을 호출하는 쉘이면 ▶ 가 다른 pane 을 가리킬 수 있다.
- **영향**: 스크립트에서 `$(dmctl who-am-i --json | jq -r .uuid)` 같은 패턴 불가능. 자기 자신을 식별해 send_agent_message 류 명령에 from 으로 넣는 표준 흐름이 dmctl 쪽에서 막힘.

### 2.2 W2 — 라인 형식 불일치
3채널 비교:

| 채널 | 컬럼 순서 |
|---|---|
| MCP `list_panes` | `{▶\|  } {label}  paneId  shellPid  size  session  tab  uuid  short` (label 키 없음) |
| MCP `who_am_i` | `label=  paneId  shellPid  size  session  tab  uuid  short  session_uuid  region_uuid` (마커 없음, label 키 있음) |
| dmctl `list-panes` | `{▶\|  } {label}  uuid  short  paneId  shellPid  session  tab` (label 키 없음, size 없음, session_uuid/region_uuid 없음) |

- **현상**:
  - label 키 부착 여부 불일치 → awk/grep 의 컬럼 인덱스가 채널마다 다름.
  - uuid 위치 다름 (MCP 는 라인 끝, dmctl 은 중간).
  - dmctl 은 size/session_uuid/region_uuid 자체 누락.
- **영향**: 사용자가 dmctl 과 Claude(MCP) 양쪽에서 같은 정보를 보지만 파싱 코드는 분기. uuid 도입의 통일 효과가 표면 형식에서 깨짐.

### 2.3 W3 — 빌더 코드 중복
- **위치**: `dmctl_listpanes.go` 의 `buildListPanesRows` 와 MCP `listpanes.go`/`whoami.go` 의 inline `fmt.Fprintf` 가 각자 라벨/필드를 조립.
- **영향**: 향후 컬럼 추가 시 두 곳을 동기화해야. 합집합 통일 후에도 같은 함수가 두 곳에 머물면 발산 위험.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-PL-1** | 표준 라인 포맷을 정의한다:<br>`{focus_marker}label={L}  uuid={U}  short={S}  paneId={P}  shellPid={H}  size={W}x{R}  session={Q}  tab={Q}  session_uuid={SU}  region_uuid={RU}`<br>• `{focus_marker}` = `▶ ` (브라우저 포커스 일치) 또는 `  ` (두 칸 공백). 항상 2 컬럼 폭.<br>• `{Q}` = Go `%q` (큰따옴표 + 이스케이프). 그 외는 raw 값.<br>• 컬럼 구분자 = 두 칸 공백.<br>• 컬럼 순서 고정. 새 컬럼은 끝에만 추가. | 필수 |
| **FR-PL-2** | 빈 값 정책: `uuid` / `short` / `session_uuid` / `region_uuid` 중 빈 문자열이면 **해당 컬럼 통째로 생략**. `size` 가 `0x0` 이면 size 컬럼 생략. `paneId` / `shellPid` / `session` / `tab` 은 빈 값이라도 컬럼 생성(키 안정성). | 필수 |
| **FR-PL-3** | 신규 공용 패키지 `internal/paneline` 에 다음 export:<br>• `type Line struct { FocusMarker bool; Label, UUID, Short, PaneID string; ShellPID int; SizeCols, SizeRows int; Session, Tab, SessionUUID, RegionUUID string }`<br>• `func (l Line) Render() string` — FR-PL-1/2 따라 단일 라인 반환 (개행 없음).<br>외부 의존 0 (stdlib `fmt` 만). | 필수 |
| **FR-DMC-WAI-1** | `dmctl who-am-i` 신규 명령. `GET /api/whoami` 호출, 응답 JSON 을 `paneline.Line` 으로 매핑, `Render()` 결과를 stdout 출력 + 개행. rc=0. | 필수 |
| **FR-DMC-WAI-2** | `dmctl who-am-i --json` — `/api/whoami` 의 JSON 응답을 그대로 stdout 출력 (compact 한 줄, dmctl 의 다른 `--json` 명령 패턴과 일치). | 필수 |
| **FR-DMC-WAI-3** | `dmctl who-am-i -h` / `--help` — 명령 안내 출력 후 rc=0. `dmctl --help` 최상위 도움말에도 항목 추가. | 필수 |
| **FR-DMC-WAI-4** | `/api/whoami` 호출이 4xx/5xx 또는 네트워크 실패 → stderr 명확한 오류 + rc=1. 서버가 매칭 실패(`clientPID 가 어느 pane 에도 속하지 않음`) 시 404 + JSON `{"error":"..."}`. dmctl 은 에러 메시지를 stderr 로 흘리고 rc=1. | 필수 |
| **FR-API-WAI-1** | `GET /api/whoami` 신규 라우트. `r.RemoteAddr` 에서 `clientpid.FromRemoteAddr` 로 clientPID 추출 → `Client.ResolveClientPane` 로 paneID/shellPID → workspace.json 에서 entry 매칭 → JSON 응답.<br>응답 스키마:<br>```json<br>{<br>  "label":"S1.P1.T1","uuid":"...","short":"...",<br>  "paneId":"12","shellPid":12345,<br>  "sizeCols":80,"sizeRows":24,<br>  "session":"Main","tab":"Shell",<br>  "sessionUuid":"...","regionUuid":"...",<br>  "focused":true<br>}```<br>매칭 실패: 404 + `{"error":"clientPID=N 가 어느 pane 에도 속하지 않음"}`.<br>workspace 미등록(paneID 매칭은 됐으나 entry 없음): 200 + 위 스키마 중 paneId/shellPid/sizeCols/sizeRows 만 채워서 반환 (label/uuid 등은 빈 문자열). | 필수 |
| **FR-API-WAI-2** | `/api/whoami` 의 응답 JSON 스키마는 v1. 향후 필드 추가는 끝에 append 만 허용 (additive). 기존 키 rename/삭제 금지. | 필수 |
| **FR-MCP-1** | MCP `list_panes` 핸들러는 각 행 텍스트를 `paneline.Line.Render()` 로 생성. 기존 헤더 `"Pane 목록 (▶ = 사용자 포커스):\n"` 와 `[workspace 미등록]` 섹션은 유지. orphan 라인은 별도 짧은 포맷 유지(`paneId=  shellPid=  size=  name=`). | 필수 |
| **FR-MCP-2** | MCP `who_am_i` 핸들러는 자기 pane 한 행을 `paneline.Line.Render()` 로 생성. workspace 미등록 경로는 `paneline.Line{}` 의 부분 필드만 채워 Render. | 필수 |
| **FR-DMC-LP-1** | dmctl `list-panes` 의 텍스트 출력은 `paneline.Line.Render()` 로 생성. 한 줄당 한 pane, 헤더·`(no panes)` 안내는 기존 유지. | 필수 |
| **FR-DMC-LP-2** | dmctl `list-panes --json` 의 행 스키마에 다음 필드 추가 (additive): `sizeCols int`, `sizeRows int`, `sessionUuid string`, `regionUuid string`. 기존 필드(label/uuid/short/paneId/shellPid/session/tab/focused) 는 키·타입 무변경. | 필수 |
| **FR-DMC-LP-3** | dmctl `list-panes` 의 `/api/state` 요청은 그대로 유지 (기존 패턴). `/api/state` 응답에 size·sessionUuid·regionUuid 가 이미 노출되지 않는다면 `/api/state` 응답 스키마도 additive 로 확장 — 단 이 확장은 별도 sub-요구로 FR-API-STATE-1 분리. | 필수 |
| **FR-API-STATE-1** | `/api/state` 의 panes[] 각 원소에 `sizeCols int`, `sizeRows int` 필드 additive 추가. workspace.json 의 sessions[].layout 트리 노드(tab) 에 이미 sessionId/regionId 가 있는지 확인하고, 없다면 wsSession 응답에 `uuid string`, region wsLayout 노드에 `uuid string` 을 additive 추가 — dmctl 측 `buildListPanesRows` 가 session_uuid / region_uuid 를 채우려면 둘 다 필요. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-WAI-0 | **행위 보존** — 기존 dmctl 명령(`list-panes` 의 JSON 행 스키마 기존 키 포함)·MCP 도구의 컬럼 데이터 의미는 무변경. 라인의 **컬럼 순서·키 부착**만 본 SRS 가 명시적으로 변경한다 (FR-PL-1). |
| NFR-WAI-1 | `/api/whoami` 는 round-trip 1회만. 추가 워크스페이스 조회 없음 — server 내부에서 Workspace.Entries() 한 번. |
| NFR-WAI-2 | `paneline` 패키지는 외부 의존 0 (stdlib 만). server/mcptool/runtimebin 어디서나 import 가능. |
| NFR-WAI-3 | dmctl 의 신규 `who-am-i` 명령도 외부 의존 0 유지 (DC-DMC-1 계승). |
| NFR-WAI-4 | `paneline.Render()` 는 deterministic — 같은 `Line` 입력은 byte-level 같은 결과. fmt 의 map 순회 같은 비결정 요소 사용 금지. |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-WAI-1 | 본 SRS 의 변경은 W2 의 라인 포맷을 일괄 전환한다 — Playwright e2e 회귀에 텍스트 영향 없는지 확인(텍스트가 UI 가 아니라 stdout/MCP 응답이므로 통상 무영향). 영향 시 해당 e2e 갱신. |
| DC-WAI-2 | 컬럼 폭 정렬(공백 정렬)은 하지 않는다. 단순 두 칸 공백 구분만. |
| DC-WAI-3 | `paneline.Line` 의 필드 타입은 stdlib primitive 만 — 외부 패키지 type alias 금지 (의존 경량성). |
| DC-WAI-4 | `/api/whoami` 의 HTTP 메소드는 GET 만. POST 미허용 (read-only). |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-PL-1** | `paneline.Line{FocusMarker:true, Label:"S1.P1.T1", UUID:"550e8400-...", Short:"550e8400", PaneID:"12", ShellPID:12345, SizeCols:80, SizeRows:24, Session:"Main", Tab:"Shell", SessionUUID:"...", RegionUUID:"..."}.Render()` | 정확히 FR-PL-1 의 라인 (byte-level 비교) |
| **TC-PL-2** | uuid/short 빈 값 | uuid/short 컬럼 통째 생략, 나머지 위치 유지 |
| **TC-PL-3** | session_uuid/region_uuid 빈 값 | 해당 컬럼 생략 |
| **TC-PL-4** | size 0x0 | size 컬럼 생략 |
| **TC-PL-5** | FocusMarker=false | `  ` (두 칸 공백) prefix |
| **TC-PL-6** | session/tab 안에 `"` 포함 | `%q` 이스케이프 |
| **TC-API-WAI-1** | 정상: 알려진 clientPID 가 paneID 매칭 + workspace entry 매칭 | 200 + 완전한 JSON (label/uuid/short/.../regionUuid) |
| **TC-API-WAI-2** | 매칭 실패 (조상 체인 32단계 안에 매칭 없음) | 404 + `{"error":"clientPID=N ..."}` |
| **TC-API-WAI-3** | paneID 매칭은 됐으나 workspace.json 에 entry 없음 (스타트업 중) | 200 + paneId/shellPid/sizeCols/sizeRows 만 채움, 나머지 빈 문자열 |
| **TC-API-WAI-4** | `clientpid.FromRemoteAddr` 가 에러 | 404 + 에러 메시지 |
| **TC-API-WAI-5** | POST /api/whoami | 405 |
| **TC-DMC-WAI-1** | fake server 200 + 완전한 JSON | stdout 한 줄 = `paneline.Render()` 와 일치, rc=0 |
| **TC-DMC-WAI-2** | `--json` | stdout = 서버 JSON 그대로 (compact 한 줄), rc=0 |
| **TC-DMC-WAI-3** | fake server 404 | stderr 에러 메시지 + rc=1 |
| **TC-DMC-WAI-4** | 서버 unreachable | stderr 명확한 오류 + rc=1 |
| **TC-DMC-WAI-5** | `dmctl who-am-i -h` | help 출력 + rc=0 |
| **TC-DMC-WAI-6** | `dmctl who-am-i --unknown` | stderr `unknown argument: --unknown` + rc=2 |
| **TC-MCP-LP-1** | MCP `list_panes` 출력 행 텍스트가 `paneline.Line.Render(...)` 호출 결과와 byte-level 일치 | 통과 |
| **TC-MCP-LP-2** | orphan 섹션(`[workspace 미등록]`) 의 라인은 기존 짧은 포맷 유지 | 통과 |
| **TC-MCP-WAI-1** | MCP `who_am_i` 출력 1행이 `paneline.Line.Render(...)` 결과와 일치 (라인 끝 개행 없음) | 통과 |
| **TC-DMC-LP-1** | dmctl `list-panes` 출력 각 행이 `paneline.Line.Render(...)` 결과와 일치 | 통과 |
| **TC-DMC-LP-2** | dmctl `list-panes --json` 행 스키마: 신규 필드(sizeCols, sizeRows, sessionUuid, regionUuid) 가 키로 존재, 기존 필드는 무변경 | 통과 |
| **TC-CROSS-1** | 같은 paneline.Line 데이터를 dmctl 과 MCP 양 채널이 받았을 때 두 텍스트가 byte-level 동일 | 통과 — 본 SRS 의 핵심 회귀 방지 검증 |
| **TC-API-STATE-1** | `/api/state` 응답의 panes[] 에 sizeCols/sizeRows 필드 존재, sessions[].uuid 와 region.uuid 존재 (FR-API-STATE-1) | 통과 |

### 4.2 완료 조건 (DoD)

- [ ] `internal/paneline` 패키지 + 단위 테스트.
- [ ] `GET /api/whoami` 라우트 + 핸들러 + 핸들러 테스트.
- [ ] `/api/state` 응답 additive 확장 (sizeCols/sizeRows, session uuid, region uuid).
- [ ] MCP `list_panes` / `who_am_i` 핸들러를 `paneline.Render` 호출로 개편.
- [ ] dmctl `list-panes` 의 텍스트 출력 경로를 `paneline.Render` 호출로 개편 + `--json` 행 스키마 확장.
- [ ] `dmctl who-am-i` 신규 명령 + 단위 테스트.
- [ ] `dmctl --help` 갱신.
- [ ] `docs/external/commands.md` 갱신 (who-am-i 항목, 표준 라인 형식 박스).
- [ ] `go test -race -count=1 ./...` green.
- [ ] `go vet ./...` 본 SRS 신규 파일 clean.
- [ ] Playwright `npx playwright test` 무수정 통과 (DC-WAI-1).
- [ ] 라이브 검증 (`script/test_start.sh`):
  - `.test-dongminal/bin/dmctl list-panes` 와 `.test-dongminal/bin/dmctl who-am-i` 출력 시각 확인.
  - MCP `list_panes` / `who_am_i` 호출 결과를 dongminal MCP 로 확인 (다른 단말에서 호출 시).

---

## 5. 비목표 (Non-goals)

- dmctl 의 추가 read-only 명령 (예: `dmctl tree`, `dmctl sessions`) — 후속.
- `paneline.Line` 의 JSON 마샬링 표준 (서버·dmctl 의 JSON 응답이 동일 키 셋을 쓰도록 강제) — 본 SRS 는 텍스트 라인만 통일. JSON 키 명명은 채널별 기존 컨벤션 유지(서버 = lowerCamelCase, dmctl `--json` 도 lowerCamelCase 로 신규 키 통일).
- 컬럼 폭 정렬·테이블 렌더링.
- 인증/권한 — `/api/whoami` 도 기존 API 들과 같이 localhost-only daemon 정책 계승.
- MCP `list_panes` 의 헤더/안내 문자열(`Pane 목록 (▶ = 사용자 포커스):`) 의 다국어/i18n.
- `who_am_i` MCP 도구의 SSE 의존 자체 제거 — 본 SRS 는 dmctl 측 HTTP 경로 신설일 뿐, MCP 측 SSE 경로는 유지.

---

## 6. 의존 / 후속

- **의존**: `DMCTL_UUID_FINALIZE_SRS` (D1~D4 완료), `UUID_IDENTITY_SRS` (FR-UID-6 노출 컬럼 셋).
- **후속**:
  - `HIERARCHICAL_TEAM_SRS` — `who-am-i` 결과를 계층 팀 운영의 self-identification 기반으로 사용.
  - `DMCTL_TREE_SRS` (가설) — `list-panes` 가 평면이고 트리 시각화는 별도.
