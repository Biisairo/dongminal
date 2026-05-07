# SRS: 마크다운 뷰어 스크롤 동기화 (IEEE 29148 준수)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
md 뷰어 탭의 스크롤 위치를 서버에 영속화하여, 새로고침/다중 창 환경에서도 복원·동기화한다. README TODO "md scroll 동기화" 항목의 단일 원천 스펙.

### 1.2 범위 (Scope)
- 백엔드: 새 영속 스토어(`mdscroll.json`) + REST 엔드포인트 + SSE 브로드캐스트.
- 프론트엔드: `MdViewer` 의 스크롤 캡처/복원, 페이지 부팅 시 일괄 적용, SSE 수신 시 동기화.
- 비포함: 동일 .md 를 새 탭으로 다시 여는 경우의 자동 복원(사용자 결정), 모바일 전용 동작 변경, 스크롤 애니메이션.

### 1.3 정의 (Definitions)
- **scrollKey**: 스크롤 위치 식별자. 본 스펙에서는 **tab id** 를 사용한다. 같은 .md 를 다른 탭으로 열면 별개 위치를 가진다.
- **mdScroll 엔트리**: `{ top: number, ratio: number, ts: number }`.
  - `top`: `scrollTop`(px). 동일 viewport 폭에서 정확 복원에 사용.
  - `ratio`: `scrollTop / max(1, scrollHeight - clientHeight)`. viewport/폰트가 달라 `top` 이 범위를 벗어날 때 보정 복원에 사용.
  - `ts`: 갱신 시각(ms). 충돌/디버깅용.
- **clientId**: 페이지 로드마다 생성되는 랜덤 식별자. 자기 자신이 보낸 브로드캐스트 echo 를 식별.

### 1.4 관련 문서
- `docs/internal/MD_VIEWER_REGRESSION_FIX_SRS.md` (REG-7 의 `_scrollTop` 메모리 보존)
- `docs/internal/WORKSPACE_SNAPSHOT_SRS.md` (Manager/ETag/coalescing 패턴)

## 2. 회귀/현황 (Current State)
- `MdViewer` 는 `_scrollTop` 휘발성 캐시만 보유. 새로고침·다른 창에서는 항상 0으로 복귀.
- `workspace.json` 에 스크롤 정보가 없으며, 추가하면 잦은 rev 증가로 다른 영속화와 충돌(coalescing 손실 가능). → 별도 스토어로 분리.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-1 | `MdViewer.el` 에서 사용자가 스크롤하면, `tabId` 기준으로 `{top, ratio, ts}` 엔트리가 서버에 저장된다(throttle 50ms, leading + trailing). | 필수 |
| FR-2 | 페이지 로드 시 `App` 은 모든 mdScroll 엔트리를 1회 조회하여 `App.mdScrolls` 맵에 적재한다. | 필수 |
| FR-3 | `MdViewer` 가 마크다운 본문 렌더를 마치고 처음 활성화될 때(또는 fetch 완료 직후), 해당 `tabId` 의 엔트리가 있으면 `top` 으로 스크롤하고, `top > scrollHeight - clientHeight` 이면 `ratio` 기반으로 보정한다. | 필수 |
| FR-4 | 서버는 `PUT /api/md-scroll` 성공 시 `md_scroll_changed` 액션을 SSE 로 브로드캐스트한다. payload: `{tabId, top, ratio, ts, by}`. `by` 는 요청자 `clientId`. | 필수 |
| FR-5 | SSE `md_scroll_changed` 수신 시: 자신의 `clientId === by` 이면 무시. 아니면 `App.mdScrolls` 를 갱신하고, 해당 `tabId` 의 활성 `MdViewer` 가 있으면 즉시 `scrollTop` 을 적용한다(보정 규칙은 FR-3 와 동일). | 필수 |
| FR-6 | `App.render()` 가 REG-7 패치(휘발성 `_scrollTop`)를 유지하면서, 영속 엔트리가 있을 경우 그것을 우선한다(휘발성 값보다 신선하면 사용; 동등이면 둘 다 0이 아닌 한 휘발성 우선으로 이질감 방지). | 필수 |
| FR-7 | 탭 닫기/세션 삭제로 `tabId` 가 사라져도 서버는 즉시 삭제하지 않는다. 페이지 로드 시 워크스페이스에 없는 `tabId` 엔트리는 서버가 lazy GC 한다. | 권장 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-1 변경은 외과적이어야 하며 비-md 경로(터미널 탭, workspace 영속화)의 동작을 바꾸지 않는다.
- NFR-2 PUT 빈도는 viewer 당 50ms throttle(leading + trailing). 연속 스크롤 시 최대 ~20Hz, 한 번의 PUT 페이로드는 < 200B.
- NFR-3 영속 파일 손상/누락 시 빈 맵으로 시작하고 로그 1줄만 남긴다(부팅 차단 X).
- NFR-4 `go test ./...` 통과.

### 3.3 제약 (Constraints)
- 워크스페이스 데이터 모델/`tab.type`/`tab.filePath` 변경 금지.
- 새 명령어 액션은 `allowedCmdActions` 에 추가하되 외부 dmctl 호출 대상이 아니므로 SSE 전용.
- 스토리지 경로는 `$DONGMINAL_HOME/mdscroll.json`, atomic write(임시파일+rename) 또는 동등 수준.

## 4. 설계 개요 (Design)

### 4.1 백엔드
- 신규 패키지 `internal/mdscroll`:
  - `Store` 인터페이스 + `Manager`(in-memory map + 비동기 latest-wins writer).
  - `Get(tabId) (Entry, bool)`, `Set(tabId, Entry)`, `Snapshot() map[string]Entry`, `Reconcile(validIds set)`.
- `internal/server`:
  - `Deps.MdScroll MdScrollStore` 추가(nil 허용; 테스트는 fake 주입).
  - 라우트: `GET /api/md-scroll`, `PUT /api/md-scroll`.
  - `commands.go` 의 `allowedCmdActions` 에 `md_scroll_changed` 추가(SSE-only — POST 거부 대상은 아니지만 dmctl 사용 의도 없음).
  - PUT 핸들러는 Set 후 `CommandHub.Broadcast` 로 액션 전송.
- `cmd/dongminal/main.go`:
  - `mdscroll.New(...)` 후 `Deps.MdScroll` 주입. 종료 시 `Close()` flush.
  - Reconcile 은 부팅 시 workspace 파싱 결과로 1회 실행(또는 첫 GET 시 lazy).

### 4.2 프론트엔드
- `App.clientId = crypto.randomUUID()` 부팅 시 1회.
- `App.mdScrolls = Map<tabId, Entry>` 도입. 부팅 시 `GET /api/md-scroll` → 적재.
- `MdViewer`:
  - 생성자에 `App` 참조(또는 콜백) 주입(현재 `app` 글로벌 사용 중) — 글로벌 활용 유지로 surgical 변경.
  - `fetchAndRender` 완료 후, 활성 부착 시점에 `_applyPersistedScroll()` 호출.
  - `el.addEventListener('scroll', ...)` 디바운스 250ms 로 PUT.
- SSE 핸들러: `md_scroll_changed` 분기 추가 → `App._onMdScrollRemote(args)`.
- REG-7 의 휘발성 `_scrollTop` 보존 로직은 유지하되, 부착 시 우선순위: `viewer._scrollTop` (있고 0 아님) → 영속 엔트리(`top` 보정 규칙).

### 4.3 동시성·장애 시나리오
- 같은 탭이 두 창에서 보임 → 한쪽 스크롤 PUT → SSE → 다른 창 적용. echo 차단은 `by` 비교로.
- 빠른 연속 스크롤 → 디바운스로 1회 PUT. 페이지 닫힘 직전 `pagehide` 시 `navigator.sendBeacon` 으로 마지막 값 flush(가능하면).
- 영속 파일 깨짐 → 빈 맵 시작; 새 PUT 으로 덮어씀.

## 5. 검증 계획 (Validation)

### 5.1 단위/통합 (Go)
- `internal/mdscroll/manager_test.go`:
  - Set/Get round-trip, Reconcile 이 stale id 제거, 빈 파일 로드.
- `internal/server/handlers_api_test.go`(추가 케이스):
  - GET 빈 응답 `{}`, PUT 잘못된 JSON → 400, 정상 PUT 후 GET 반영, PUT 시 CommandHub.Broadcast 호출 검증(fake hub).

### 5.2 e2e (Playwright)
- `e2e/md-scroll-sync.spec.ts`:
  1. md 탭 열기 → 스크롤 → 새로고침 → 동일 위치 복원.
  2. 두 브라우저 컨텍스트 동시 → A 스크롤 → B 가 짧은 시간 내 동일 위치로 이동.

### 5.3 수동 체크
- 동일 탭을 2개 창에서 띄운 후 한쪽 스크롤이 다른 쪽에 반영.
- 새 탭으로 동일 .md 를 열면 0에서 시작(자동 복원 X — 사용자 합의 사항).

## 6. 완료 조건 (Definition of Done)
- [ ] `internal/mdscroll/` 패키지 + 단위 테스트 통과.
- [ ] `GET/PUT /api/md-scroll` 핸들러 + 테스트 통과.
- [ ] 프론트 `MdViewer` 스크롤 capture/restore + SSE sync 구현.
- [ ] e2e 스펙 추가, 로컬 1회 통과.
- [ ] `go test ./...` 통과.
- [ ] 본 SRS 문서 commit.
