# SRS: daemon 모드에서 pane busy 상태 해석 버그 수정 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
daemon 모드(`Panes` 가 `PaneClient`)에서 `GET /api/panes/{id}/busy` 가 해당 pane 의 **실제 실행 중 프로세스 유무**(busy 상태)를 반환하도록 한다. 현재 daemon 모드에서는 pane 에 foreground 프로세스가 실행 중이어도 항상 `busy=false` 가 반환되어, 프론트엔드의 탭/세션 닫기 시 "실행 중인 프로세스가 있습니다" 확인 다이얼로그가 표시되지 않는 버그를 수정한다.

### 1.2 범위 (Scope)
- 백엔드(`internal/server`): `PaneHub` 인터페이스에 `Busy(id)` 노출, `apiPaneBusy`(`/api/panes/{id}/busy` 읽기 경로)의 동일 결함 수정.
- 비포함: 프론트엔드(`web/app.js`) 변경 없음 — `_isPaneBusy` / `/api/panes/{id}/busy` 인터페이스 및 confirm 다이얼로그 로직 유지.
- 비포함: daemon(`dongminald`) 프로토콜 변경 없음 — `busy` RPC(`paned.go:303` `panedConn.busy`)는 이미 존재하며 그대로 사용.
- 비포함: in-process 모드의 동작(현재 정상)은 변경하지 않는다.
- 비포함: busy 판정 알고리즘(`pgrep -P <pid>` 자식 프로세스 존재) 자체는 변경하지 않는다.

### 1.3 정의 (Definitions)
- **in-process 모드**: `server.Deps.Panes` 가 `*PaneManager`. `Get(id)` 가 셸 프로세스(`cmd`)가 붙은 실제 Pane 을 반환.
- **daemon 모드**: `server.Deps.Panes` 가 `*PaneClient`(PaneHub). pane 의 셸은 별도 프로세스(`dongminald`)가 보유.
- **busy**: pane 의 셸이 직접 자식 프로세스를 보유한 상태. `Pane.IsBusy()`(`pane.go:160`)가 `paneBusyProbe`(`pgrep -P <pid>`)로 판정.

## 2. 현황 (Current State)
- `PaneHub` 인터페이스(`internal/server/deps.go:15`)는 `Busy(id string) bool` 을 노출하지 않는다.
- 두 구현 모두 `Busy(id) bool` 메서드를 보유한다: `PaneManager.Busy`(`pane.go:949`), `PaneClient.Busy`(`pane_client.go:517`, daemon RPC).
- daemon RPC 핸들러 `panedConn.busy`(`paned.go:303`)는 이미 `pm.Busy(id)` 를 호출하도록 구현되어 있다.
- `apiPaneBusy`(`handlers_api.go:257-267`)는 `s.Panes.Get(id).IsBusy()` 로 busy 를 구한다.
- `PaneClient.Get`(`pane_client.go:463-473`)은 `List()` 로 존재만 확인한 뒤 `&Pane{ID, Name}`(=`cmd==nil`)을 반환한다.
- `Pane.IsBusy()`(`pane.go:160-165`)는 `cmd==nil` 이면 즉시 `false` 를 반환한다.
- **결과(daemon 모드)**: `Get()` 이 빈 Pane → `IsBusy()` 가 `false` 반환 → 프로세스 실행 중에도 `busy=false` → 프론트(`web/app.js` `closeTab`/`delSession`)가 confirm 다이얼로그를 건너뜀.
- in-process 모드는 `Get()` 이 실제 Pane 을 반환하므로 영향 없음.
- 본 결함은 `DAEMON_CWDPANE_RESOLVE_SRS`(cwd) 와 동일 클래스의 누락이다. `PaneHub.Cwd` 주석(`deps.go:19-21`)이 이미 동일 함정을 명시하나, busy 경로에는 같은 수정이 적용되지 않았다.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-1 | daemon 모드에서 `GET /api/panes/{id}/busy` 는 해당 pane 의 **실제 busy 상태**(daemon `busy` RPC 결과)를 반환해야 한다. 프로세스 실행 중이면 `{"busy":true}`. | 필수 |
| FR-2 | in-process 모드에서 `GET /api/panes/{id}/busy` 동작은 회귀 없이 기존과 동일(실제 pane 의 `IsBusy()` 결과)해야 한다. | 필수 |
| FR-3 | 존재하지 않는 pane 에 대한 조회는 `{"busy":false}` 와 HTTP 200 을 반환해야 한다(기존 동작 유지). | 필수 |
| FR-4 | 응답 본문 형식(`{"busy":<bool>}`)과 상태 코드(200)는 변경하지 않는다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 변경은 외과적이어야 하며 `PaneHub` 의 기존 메서드 시그니처/동작을 바꾸지 않는다(메서드 1개 추가만).
- NFR-2 프론트엔드/daemon 프로토콜 추가 없이 백엔드 단일 인터페이스 보강 + 단일 호출지점 수정.
- NFR-3 `go test ./...` 및 기존 e2e 회귀 통과.

### 3.3 제약 (Constraints)
- `/api/panes/{id}/busy` 의 응답 인터페이스 변경 금지.
- daemon `busy` RPC 프로토콜 변경 금지.
- `PaneManager`/`PaneClient` 의 기존 `Busy(id)` 시그니처 변경 금지.
- `Pane.IsBusy()` 및 `paneBusyProbe` 변경 금지.

## 4. 설계 (Design)

### 4.1 인터페이스 보강
`internal/server/deps.go` 의 `PaneHub` 인터페이스에 메서드 추가:
```
// Busy reports whether pane id has a running foreground process.
// In daemon mode this routes through the daemon busy RPC; Get(id).IsBusy()
// is not usable there because Get returns a cmd-less Pane.
Busy(id string) bool
```
- `*PaneManager` 와 `*PaneClient` 모두 이미 동일 시그니처 메서드를 구현하므로 추가 구현 불필요.
- 테스트 페이크(`fakePaneHub`)는 `PaneHub` 를 구현하므로 컴파일 보장을 위해 `Busy` 메서드 추가 필요. (`expandedPaneHubFake` 는 이미 `Busy` 보유.)

### 4.2 `apiPaneBusy` 패치
`handlers_api.go` 의 busy 조회부:
```
// 변경 전
if s.Panes != nil {
    if pane := s.Panes.Get(id); pane != nil {
        busy = pane.IsBusy()
    }
}
// 변경 후
if s.Panes != nil {
    busy = s.Panes.Busy(id)
}
```
- `Get()`+`pane.IsBusy()` 대신 `PaneHub.Busy(id)` 직접 호출 → daemon 모드는 RPC 경유, in-process 는 PaneManager 경유로 모두 라이브 busy 획득.
- FR-3: 미존재 pane 은 `PaneManager.Busy`/`PaneClient.Busy` 모두 `false` 를 반환하므로 `busy=false` 유지.

## 5. 검증 (Validation)

### 5.1 단위/통합 테스트 (Go)
`internal/server/handlers_api_test.go`:
1. **FR-1 (daemon 시뮬레이션, RED→GREEN)**: `Get(id)` 가 cmd-less Pane 을 반환하고 `Busy(id)=true` 인 `fakePaneHub`(daemon `PaneClient` 와 동형) 로 `GET /api/panes/{id}/busy` → 응답이 `{"busy":true}` 인지 검증. 수정 전에는 `Get().IsBusy()`(cmd==nil) → `{"busy":false}` 로 **실패(RED)**, 수정 후 `{"busy":true}` 로 **통과(GREEN)**.
2. **FR-3 (미존재)**: 기존 `TestHandleAPI_PaneBusy`(handlers_api_test.go:18) — 미존재 pane 이 `{"busy":false}` 반환. 갱신된 경로로도 통과(회귀).

### 5.2 수동 확인 (daemon 모드)
- daemon 모드로 dongminal 기동 → 터미널 pane 에서 장시간 실행 명령(예: `sleep 100`) 실행 → 해당 탭/세션 닫기 → "실행 중인 프로세스가 있습니다" 확인 다이얼로그 표시.
- 프로세스 미실행(셸 프롬프트) 상태에서 닫기 → 다이얼로그 없이 즉시 닫힘.
- (수정 전) 위 첫 경우에 다이얼로그가 뜨지 않던 것과 대비.

## 6. 배포 영향 (Deployment Impact)
- 본 수정은 `dongminal`(웹 서버) 바이너리에 한정. `dongminald`(daemon) 변경 없음.
- 적용: `dongminal` 재빌드 + 재시작으로 충분. **`--restart-daemon` 불필요**(daemon 재시작은 라이브 pane 손실 유발).

## 7. 완료 조건 (Definition of Done)
- [ ] `PaneHub` 인터페이스에 `Busy(id string) bool` 추가.
- [ ] `apiPaneBusy` 의 busy 조회를 `s.Panes.Busy(id)` 로 변경.
- [ ] `fakePaneHub` 에 `Busy` 메서드(+ busy 기록 헬퍼) 추가하여 컴파일/테스트 보장.
- [ ] FR-1 Go 테스트 추가, 수정 전 RED → 수정 후 GREEN.
- [ ] FR-3 기존 테스트 회귀 통과.
- [ ] `go test ./...` 및 기존 e2e 회귀 통과.
- [ ] 본 SRS 문서 commit.
