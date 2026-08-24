# SRS: Safety Warmup Patches (L1 / L4 / L8) — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`DESIGN_REVIEW_FOLLOWUP.md` §3 의 소형 안전성 결함 3 건 (L1, L4, L8) 을 외과적으로 보강하여 silent drop / 잘못된 자원 사용 / 비정상 종료 신호 누락 위험을 제거한다.

### 1.2 범위 (Scope)
- L1: `web/app.js` 의 `Term._send` 가 ws 비정상 상태에서 입력을 silent drop.
- L4: `internal/server/pane.go` `ParseSize` 가 cols/rows 의 상한선을 검증하지 않아 비정상 거대값(예: 65535×65535) 으로 PTY 가 resize 됨.
- L8: `cmd/dongminal/main.go` 의 graceful shutdown 시그널 집합에 `SIGHUP` 누락.

### 1.3 정의 (Definitions)
- **silent drop**: 송신 의도된 메시지가 사용자 알림이나 카운터 없이 버려지는 현상.
- **graceful shutdown**: 시그널 수신 시 진행 중 작업 정리 후 종료.
- **PTY 안전 한계**: 대다수 셸/터미널 구현에서 cols·rows 는 실용상 1000 이하. 본 시스템은 **4096 / 4096** 을 상한으로 정의한다 (xterm.js 가정 충분).

## 2. 현황 (Identified Issues)

### L1: `_send` silent drop
- **위치**: `web/app.js:534`
- **현상**: `if(this.ws&&this.ws.readyState===1)this.ws.send(m)` — readyState 가 0/2/3 인 동안 송신 호출은 흔적 없이 버려진다. 재연결 직전·직후 짧은 윈도우에서 사용자 입력 손실.
- **분류**: 정보 은닉 부족 + silent failure.

### L4: `ParseSize` 상한 미검증
- **위치**: `internal/server/pane.go:501-511`
- **현상**: cols/rows 가 0 이면 기본값으로 폴백하지만, 상한은 `uint16` 자체 (65535) 까지 허용. 악의적·실수성 거대값이 PTY ioctl 까지 그대로 전달됨.
- **분류**: 입력 검증 부재.

### L8: SIGHUP 누락
- **위치**: `cmd/dongminal/main.go:114`
- **현상**: `signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)` 만 등록. `nohup` 환경에서도 컨트롤러가 SIGHUP 을 보내는 경우(ssh 세션 종료, systemd `KillSignal=SIGHUP`) graceful shutdown 경로를 우회.
- **분류**: 신호 처리 누락.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-W1 | `Term._send(m)` 는 `ws.readyState !== 1` 일 때 메시지를 드롭한 횟수를 누적 카운터(`this._sendDropCount`) 에 기록한다. | 필수 |
| FR-W2 | `Term._send(m)` 는 readyState 가 `CONNECTING(0)` 일 때 최대 N=64 개까지 내부 큐(`this._sendQueue`) 에 적재 후, `onopen` 에서 순서 보존 flush 한다. CLOSING(2)/CLOSED(3) 는 큐잉하지 않고 카운트만 한다. | 필수 |
| FR-W3 | `_sendQueue` 가 N 을 초과하면 가장 오래된 항목을 폐기하고 drop 카운터를 증가시킨다 (FIFO bounded). | 필수 |
| FR-W4 | `ParseSize` 는 cols 또는 rows 가 `MaxTerminalDim` (=4096) 을 초과하면 해당 값만 기본값(120 / 40) 으로 폴백한다. | 필수 |
| FR-W5 | `cmd/dongminal/main.go` 의 `signal.NotifyContext` 는 `os.Interrupt`, `syscall.SIGTERM`, `syscall.SIGHUP` 을 모두 등록한다. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
| ID | 요구사항 |
|----|----------|
| NFR-W1 | 변경은 외과적이어야 하며 무관한 리팩터링을 포함하지 않는다. |
| NFR-W2 | 모든 신규 동작은 결정적인 자동화 테스트로 검증한다 (`pane_test.go` Go, `e2e/*.spec.ts` Playwright). |
| NFR-W3 | `_sendDropCount` 와 `_sendQueue.length` 는 디버깅 목적으로만 노출되며 런타임 UI 영향 없음. |

## 4. 검증 (Verification)

### 4.1 테스트 케이스
- **TC-W1 (L4)**: `ParseSize` — `?cols=65535&rows=10` → cols 폴백(120), rows 유지(10). `?cols=4097` → 폴백. `?cols=4096` → 4096 유지.
- **TC-W2 (L1)**: e2e — 의도적 ws close 후 입력 시도 → 페이지 노출 카운터(`window.__dongminalDebug.sendDropCount`) 가 증가. CONNECTING 상태에서 send → 큐 적재 후 open 시점에 flush.
- **TC-W3 (L8)**: 본 패치는 신호 등록 자체의 단위 테스트 작성이 어렵다 (`signal.NotifyContext` 내부 검증 불가). **검증 방식**: 코드 리뷰로 충분, 추가로 `go vet` 및 `go test ./...` green 확인.

### 4.2 완료 조건 (Definition of Done)
- [ ] `go test ./...` 모두 통과.
- [ ] `npx playwright test e2e/terminal.spec.ts` 의 신규 케이스 통과 (격리 포트 58147).
- [ ] `web/index.html` `?v=` 캐시 버스터 bump (프론트 변경 포함).
- [ ] 이 SRS §3 의 FR-W1~W5 모두 구현 확인.
- [ ] `DESIGN_REVIEW_FOLLOWUP.md` §4 작업 큐의 L1/L4/L8 항목에 ✅ 표시.

## 5. 비목표 (Non-Goals)
- 큐의 영속화 (메모리 휘발 허용).
- 사용자 가시 UI (toast/배지) 추가 — 후속 검토 사항.
- ws 자동 재연결 정책 변경 — 별 항목.
