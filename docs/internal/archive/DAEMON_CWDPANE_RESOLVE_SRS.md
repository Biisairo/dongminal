# SRS: daemon 모드에서 cwdPane 기반 신규 pane cwd 해석 버그 수정 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
daemon 모드(`Panes` 가 `PaneClient`)에서 `/api/panes?cwdPane=<refID>` 로 신규 pane 을 생성할 때, 부모(참조) pane 의 **실제 작업 디렉터리**가 신규 pane 의 cwd 로 전달되도록 한다. 현재 daemon 모드에서는 부모 cwd 대신 dongminal 서버 프로세스의 시작 디렉터리(`os.Getwd()`)가 잘못 전달되는 버그를 수정한다.

### 1.2 범위 (Scope)
- 백엔드(`internal/server`): `PaneHub` 인터페이스에 `Cwd(id)` 노출, `apiPanesCreate`(쓰기 경로) 및 `apiCwd`(`/api/cwd`, 읽기 경로)의 동일 결함 수정.
- 비포함: 프론트엔드(`web/app.js`) 변경 없음 — `cwdPane` 쿼리 인터페이스 유지.
- 비포함: daemon(`dongminald`) 프로토콜 변경 없음 — `cwd` RPC(`paned.go:169`)는 이미 존재하며 그대로 사용.
- 비포함: in-process 모드의 동작(현재 정상)은 변경하지 않는다.

### 1.3 정의 (Definitions)
- **in-process 모드**: `server.Deps.Panes` 가 `*PaneManager`. `Get(id)` 가 셸 프로세스(`cmd`)가 붙은 실제 Pane 을 반환.
- **daemon 모드**: `server.Deps.Panes` 가 `*PaneClient`(PaneHub). pane 의 셸은 별도 프로세스(`dongminald`)가 보유.
- **cwdPane 해석**: `apiPanesCreate` 가 `cwd` 쿼리가 비었을 때 `cwdPane=<refID>` 로 참조 pane 의 cwd 를 구해 신규 pane 의 시작 cwd 로 사용하는 동작.

## 2. 현황 (Current State)
- `PaneHub` 인터페이스(`internal/server/deps.go:15`)는 `Cwd(id string) string` 을 노출하지 않는다.
- 두 구현 모두 `Cwd(id) string` 메서드를 보유한다: `PaneManager.Cwd`(`pane.go:938`), `PaneClient.Cwd`(`pane_client.go:508`, daemon RPC).
- `apiPanesCreate`(`handlers_api.go:242-249`)는 `s.Panes.Get(refID).Cwd()` 로 cwd 를 구한다.
- `PaneClient.Get`(`pane_client.go:463-473`)은 `List()` 로 존재만 확인한 뒤 `&Pane{ID, Name}`(=`cmd==nil`)을 반환한다.
- `Pane.Cwd()`(`pane.go:167-187`)는 `cmd==nil` 이면 라이브 조회를 건너뛰고 `os.Getwd()` 로 폴백한다.
- **결과(daemon 모드)**: `Get()` 이 빈 Pane → `Cwd()` 가 `os.Getwd()`(dongminal 서버 시작 디렉터리) 반환 → 신규 pane 이 부모 cwd 가 아닌 서버 시작 디렉터리에서 시작.
- in-process 모드는 `Get()` 이 실제 Pane 을 반환하므로 영향 없음.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-1 | daemon 모드에서 `/api/panes?cwdPane=<refID>` 생성 시, 신규 pane 의 cwd 는 refID pane 의 **현재 작업 디렉터리**(daemon `cwd` RPC 결과)여야 한다. | 필수 |
| FR-2 | in-process 모드에서 `/api/panes?cwdPane=<refID>` 동작은 회귀 없이 기존과 동일(참조 pane 의 실제 cwd)해야 한다. | 필수 |
| FR-3 | `cwd` 쿼리가 명시되면 `cwdPane` 보다 우선하며 명시된 cwd 를 그대로 사용해야 한다(기존 동작 유지). | 필수 |
| FR-4 | `cwdPane` 이 존재하지 않는 pane 을 가리키거나 cwd 조회가 빈 문자열이면, cwd 를 비워 서버 폴백(`Create("")`)에 위임해야 한다. | 권장 |
| FR-5 | `GET /api/cwd?pane=<id>` 는 daemon 모드에서도 해당 pane 의 **현재 작업 디렉터리**(daemon `cwd` RPC 결과)를 반환해야 한다. 조회 실패 시에만 `os.Getwd()` 폴백을 사용한다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 변경은 외과적이어야 하며 `PaneHub` 의 기존 메서드 시그니처/동작을 바꾸지 않는다(메서드 1개 추가만).
- NFR-2 프론트엔드/daemon 프로토콜 추가 없이 백엔드 단일 인터페이스 보강 + 단일 호출지점 수정.
- NFR-3 `go test ./...` 및 기존 e2e 회귀 통과.

### 3.3 제약 (Constraints)
- `/api/panes` 의 쿼리 인터페이스(`cwd`, `cwdPane`) 변경 금지.
- daemon `cwd` RPC 프로토콜 변경 금지.
- `PaneManager`/`PaneClient` 의 기존 `Cwd(id)` 시그니처 변경 금지.

## 4. 설계 (Design)

### 4.1 인터페이스 보강
`internal/server/deps.go` 의 `PaneHub` 인터페이스에 메서드 추가:
```
Cwd(id string) string
```
- `*PaneManager` 와 `*PaneClient` 모두 이미 동일 시그니처 메서드를 구현하므로 추가 구현 불필요.
- 테스트 페이크가 `PaneHub` 를 구현한다면 `Cwd` 메서드 추가 필요(컴파일 보장용).

### 4.2 `apiPanesCreate` 패치
`handlers_api.go` 의 cwdPane 해석부:
```
// 변경 전
if ref := s.Panes.Get(refID); ref != nil {
    cwd = ref.Cwd()
}
// 변경 후
cwd = s.Panes.Cwd(refID)
```
- `Get()`+`ref.Cwd()` 대신 `PaneHub.Cwd(refID)` 직접 호출 → daemon 모드는 RPC 경유, in-process 는 PaneManager 경유로 모두 라이브 cwd 획득.
- `apiPanesAttention`(`handlers_api.go`)이 인터페이스 메서드를 직접 쓰는 기존 패턴과 일관.
- FR-4: `Cwd(refID)` 가 빈 문자열을 반환하면 `cwd==""` 가 되어 기존 폴백(`Create("")`)으로 자연 위임.

### 4.3 `apiCwd` 패치
`handlers_api.go` 의 `/api/cwd` 핸들러:
```
// 변경 전
if pane := s.Panes.Get(paneID); pane != nil {
    cwd = pane.Cwd()
}
// 변경 후
cwd = s.Panes.Cwd(paneID)
```
- 이후 `if cwd == "" { cwd, _ = os.Getwd() }` 폴백은 유지(FR-5).

## 5. 검증 (Validation)

### 5.1 단위/통합 테스트 (Go)
`internal/server/handlers_api_test.go`:
1. **FR-1 (daemon)**: `cwd` RPC 가 `"/parent/dir"` 를 반환하도록 설정한 PaneHub 페이크로 `POST /api/panes?cwdPane=ref` → 페이크 `Create` 에 전달된 cwd 가 `"/parent/dir"` 인지 검증. (현재 버그라면 `os.Getwd()` 또는 빈 값이 와서 실패해야 함.)
2. **FR-3 (cwd 우선)**: `POST /api/panes?cwd=/explicit&cwdPane=ref` → `Create` cwd 가 `"/explicit"`.
3. **FR-4 (미존재/빈 cwd)**: 페이크 `Cwd` 가 `""` 반환 → `Create` cwd 가 `""`.
4. 기존 `TestHandleAPI_PanesCreate_CwdPaneRef`(handlers_api_test.go:721)가 갱신된 경로로도 통과하는지 확인(회귀).

### 5.2 수동 확인 (daemon 모드)
- daemon 모드로 dongminal 기동 → 터미널 pane 에서 `cd /tmp/sub` → 같은 region split(`Ctrl+\`) → 새 터미널 `pwd` 가 `/tmp/sub`.
- 새 탭(`+`) → `pwd` 가 `/tmp/sub`.
- (수정 전) 위 두 경우 모두 dongminal 시작 디렉터리가 나오는 것과 대비.

## 6. 배포 영향 (Deployment Impact)
- 본 수정은 `dongminal`(웹 서버) 바이너리에 한정. `dongminald`(daemon) 변경 없음.
- 적용: `dongminal` 재빌드 + 재시작으로 충분. **`--restart-daemon` 불필요**(오히려 daemon 재시작은 라이브 pane 손실 유발).

## 7. 완료 조건 (Definition of Done)
- [ ] `PaneHub` 인터페이스에 `Cwd(id string) string` 추가.
- [ ] `apiPanesCreate` 의 cwdPane 해석을 `s.Panes.Cwd(refID)` 로 변경.
- [ ] 테스트 페이크/`PaneHub` 구현체 컴파일 보장(필요 시 `Cwd` 추가).
- [ ] FR-1/FR-3/FR-4 Go 테스트 추가, 수정 전 RED → 수정 후 GREEN.
- [ ] `go test ./...` 및 기존 e2e 회귀 통과.
- [ ] 본 SRS 문서 commit.
