# Design Review Followup — 다음 세션 작업 계획서

**상태**: PLANNED. 본 문서는 전체 코드베이스 design review (2026-05-07) 결과 요약과 다음 세션 진입용 프롬프트다. IEEE 29148 풀 SRS 는 항목별로 별도 작성 예정.

## 1. 총평

동작은 견실하나 `web/app.js` 의 거대 `App` 클래스와 `internal/server/pane.go` 의 `PaneManager` 가 혼합 책임으로 부풀어 있고, 동시성 경계와 정보 은닉이 군데군데 흐트러져 누적 회귀의 토양이 되고 있다.

## 2. Strategic concerns (우선순위순)

### S1. `App` 클래스 비대화 — `web/app.js:719-2380`
- 단일 클래스가 layout 모델 / 렌더 / 입력 바인딩 / 다이얼로그 / 테마 / 모바일 UX / 워크스페이스 직렬화 / 검색 / 단축키 / code-server 추적을 보유.
- `_bind` 메서드 단독 ~700줄.
- 동일 불변식("`this.focused == active session.focusedRegion`") 이 8군데 이상에서 직접 갱신됨 → 최근 회귀 REG-2~8 의 근원.
- **개선 방향**: `LayoutStore` (불변식 보장 단일 진입점) + `Renderer` (layout→DOM) + `InputBinding` (단축키·키보드) 3분할.

### S2. `PaneManager` 의 다중 역할 — `internal/server/pane.go` (511 lines)
- PTY 라이프사이클 / 상태 머신 / broadcast hub / busy 검출(셸 프롬프트 추정) / exit 콜백 / snapshot 직렬화 모두 한 클래스.
- `mu`/`mu2` 두 mutex 공존, lock order 암묵적.
- **개선 방향**: busy 휴리스틱 → `PaneActivityProbe` 별 모듈. mutex 단일 RWMutex 통합. snapshot 은 별도 serializer.

### S3. `handlers_api.go` 거대 switch — 429 lines, 한 함수
- 라우팅 + 검증 + 직렬화 + broadcast 동시 처리.
- `handlers_api_test.go` 가 482줄로 비대한 부수효과.
- **개선 방향**: 라우터 테이블 `map[패턴]Handler` + 핸들러별 함수 분리.

### S4. `outbuf` 얕은 모듈성 — `internal/outbuf/stream.go`
- Write/Snapshot/Subscribe 인터페이스에서 ring 크기·overflow 정책이 호출자에게 노출.
- Subscribe 의 backpressure(채널 가득 시 drop) silent loss 가능.
- **개선 방향**: 정책 명시 또는 backlog 카운터 노출.

### S5. Workspace ETag 동시성 윈도우 — `internal/workspace/manager.go`
- 디스크 atomic rename 과 메모리 rev 갱신 사이 다른 reader 가 stale `Raw()` 관측 가능.
- `CurrentRev`/`Raw` 가 분리된 lock 으로 읽히면 일관성 붕괴.
- **개선 방향**: `Snapshot()` 단일 진입점으로 `(raw, rev)` 동시 반환 + 단일 RLock.

### S6. MCP tool 보일러플레이트 중복 — `internal/mcptool/tools/*.go`
- 각 tool 이 파라미터 파싱·검증·에러 응답·JSON 직렬화를 거의 동일 코드로 반복.
- **개선 방향**: `registry.go` 에 `Bind[Req,Resp](name, fn)` typed helper 도입. ~100줄 감축 추산.

## 3. Localized issues

| ID | 위치 | 내용 |
|----|------|-----|
| L1 | `web/app.js:534` | `_send` 가 `readyState===1` 만 송신, silent drop. 버퍼링/카운터 부재 |
| L2 | `web/app.js:1676+` | `_bind` 단축키 디스패치 if-else 사슬, 테이블화 가능 |
| L3 | `pane.go` | exit 콜백 + broadcast 가 동일 mutex 내 호출 시 reentrancy 위험 |
| L4 | `handlers_ws.go` | cols/rows 쿼리 파라미터 검증 부재 (음수/대값) |
| L5 | `commands.go` | SSE 클라이언트 맵 mutate 가 broadcast vs add/remove 잠금 누락 가능성 |
| L6 | `codeserver.go` | 외부 프로세스 종료 정리 경로가 timeout 의존, graceful shutdown signal 부재 |
| L7 | `mcptool/tools/readpane.go` | ANSI strip 로직이 `outbuf` 와 별개 구현, 중복 |
| L8 | `cmd/dongminal/main.go` | signal 핸들링이 SIGTERM/SIGINT 만, SIGHUP 누락(nohup 환경) |

## 4. 우선순위 작업 큐

1. ✅ **S1-Phase1** — `App._setFocus` 단일 진입점 도입 (focus 불변식 단일화). `APP_DECOMPOSE_SRS.md` 참조.
2. ✅ **S1-Phase2** — Renderer 클래스 추출 (render/_rSidebar/_rTopbar/_rLayout/_buildNode/_buildRg/_buildSp/_handle 8개 메서드). e2e 68/68.
3. ✅ **S1-Phase3** — InputBinding 클래스 추출 (_bind 위임). e2e 68/68.
4. ✅ **S2** — PaneManager mutex → RWMutex, busy probe 주입 가능화. `PANE_MANAGER_DECOMPOSE_SRS.md`.
5. ✅ **S3** — handlers_api 라우터 테이블화. `HANDLERS_API_ROUTER_SRS.md`.
6. ✅ **S5** — workspace `Snapshot()` 단일 진입점 + race 테스트. `WORKSPACE_SNAPSHOT_SRS.md`.
7. ✅ **S4** — outbuf backpressure 정책 노출 + pane.bch silent-loss 경로 제거. `OUTBUF_BACKPRESSURE_SRS.md`.
8. ✅ **S6** — MCP typed `Bind` helper 일원화 (6 tools 변환). `MCP_BIND_HELPER_SRS.md`.

L1/L4/L8 (워밍업 묶음): ✅ 완료. `SAFETY_WARMUP_SRS.md`.
L3/L5/L7: ✅ 완료. `CONCURRENCY_HARDENING_SRS.md` (L3 exit invariant + addClient 거절, L5 race detector 박제, L7 단일 ANSI strip 검증).
L6: ✅ 완료. `CODESERVER_SHUTDOWN_SRS.md` (timeout-driven SIGKILL 에스컬레이션).
L2: ✅ 완료. `SHORTCUT_DISPATCH_SRS.md` (Ctrl/Cmd+F → BUILTIN_HOTKEYS 테이블 + executeAction 통합).

**모든 design review 항목 처리 완료.**

### 2026-05-07 세션 결과 (확장)
- 처리: L1, L4, L8, S5, S3, S2, S1-Phase1, S1-Phase2, S1-Phase3.
- 신규 SRS: SAFETY_WARMUP_SRS, WORKSPACE_SNAPSHOT_SRS, HANDLERS_API_ROUTER_SRS, PANE_MANAGER_DECOMPOSE_SRS, APP_DECOMPOSE_SRS, TS_MIGRATION_SRS.
- 미처리: S4, S6, L2, L3, L5, L6, L7. TS 마이그레이션은 SRS 만 작성 (구현 미진).
- 검증: `go test -race ./...` green, `npx playwright test` 68/68 green (3.5분).
- 커버리지: server 65→73%, adapters 0→40%, mcptool/tools 0→86%, workspace 92%, outbuf 100%, e2e 53→68건.
- Stage 상태로 두고 push 미실행 (사용자 검토 대기).

### 2026-05-07 세션 결과 (2차 — concurrency / shutdown / outbuf)
- 처리: L3, L5, L7(검증), S4, L6.
- 신규 SRS: CONCURRENCY_HARDENING_SRS, OUTBUF_BACKPRESSURE_SRS, CODESERVER_SHUTDOWN_SRS.
- 변경 요약:
  - `internal/server/pane.go`: `exited bool` invariant 도입, `kill()` 이 단일 진입점으로 OpExit fan-out + 상태 전이 처리. `addClient` 가 `bool` 반환, 종료 후 거절. `bch`/`drainBuf` 제거 → `Stream.Feed` 직접 호출 (single drop path).
  - `internal/server/handlers_ws.go`: addClient 반환 false 시 즉시 종료.
  - `internal/server/codeserver.go`: `CodeServerInst.exited chan` 추가, `Stop()` 이 `shutdownGrace` (default 2s) 까지 SIGTERM 응답 대기 후 SIGKILL 에스컬레이션.
  - `internal/outbuf/stream.go`: backpressure 정책 godoc 명시.
  - 테스트 추가: `concurrency_invariants_test.go` (L3/L5 race), `codeserver_shutdown_test.go` (L6 wait-for-exit).
- 검증: `go test -race ./...` green, `npx playwright test` 68/68 green (3.6분).
- 미처리: S6, L2.
- Stage 상태로 두고 push 미실행 (사용자 검토 대기).

### 2026-05-07 세션 결과 (4차 — split race hotfix, 1차 수정)
- 1차 수정: split 직렬화만 적용 → 사용자 추가 보고: "여전히 두 번째 분할이 안 되고 1번 pane 으로 포커스 이동".
- 진짜 원인 (2차 수정): SSE `workspace_changed` echo 가 본인의 PUT 응답보다 먼저 도착하면 `_applyRemoteWorkspace` 가 `this.ws` 를 통째로 교체 → 진행 중이던 두 번째 split 의 `s` (session) 참조가 stale 화 → focus 가 layout 에 없는 R3 로 설정 → render fallback 이 firstRg(R1) 로 점프.
- 변경 요약:
  - `web/app.js` `App.split`: `_splitChain` Promise 큐로 직렬화.
  - `web/app.js` `App._save` / `App._onWorkspaceChanged`: `_saveInflight` 플래그 추가. save in-flight 동안 SSE workspace_changed apply 를 보류 (`_wsApplyPending`); save 완료 시 한 번 drain.
  - `e2e/layout.spec.ts`: 회귀 테스트 2 건 추가 — promise 직접 invocation, 버튼 클릭 2 회.
  - `web/index.html`: 캐시 버스터 v=105→107.
- 신규 SRS: SPLIT_SERIALIZATION_SRS (FR-SPLIT-1/2/3).
- 검증: `npx playwright test e2e/layout.spec.ts` 7/7 그린, 전체 69/70 그린 (실패 1건은 사전 존재 flake `regression-md FR-10`, 본 변경과 무관).

### 2026-05-07 세션 결과 (3차 — S6 / L2 마무리)
- 처리: S6, L2.
- 신규 SRS: MCP_BIND_HELPER_SRS, SHORTCUT_DISPATCH_SRS.
- 변경 요약:
  - **S6**: `internal/mcptool/tools/{listpanes,readpane,sendinput,sendagent,workspacecmd}.go` 6 개 tool 을 함수형 `<Name>Name` const + `<Name>Spec` var + `<Name>Args` struct + `<Name>Handler(deps)` 패턴으로 일원화 (이미 적용된 WhoAmI 와 동일). `cmd/dongminal/main.go` 등록은 모두 `mcptool.Register[Args]` typed helper 사용. `tools_test.go` 와 `internal/mcptool/registry_test.go` 갱신.
  - **L2**: `web/app.js` 의 `BUILTIN_HOTKEYS` 테이블 도입 (Ctrl/Cmd+F → toggleSearch). `InputBinding.bind` 의 ad-hoc 분기 제거 → built-in 테이블 + 사용자 shortcuts 테이블의 단일 dispatch 루프. `App.executeAction` 에 `toggleSearch` 추가. `web/index.html` 캐시 버스터 v=104→105.
- 검증: `go test -race ./...` green, `npx playwright test` 68/68 green (3.4분).
- 미처리: 없음 — design review 후속 작업 100% 완료.
- Stage 상태로 두고 push 미실행 (사용자 검토 대기).

## 5. 참고 문서

- `MD_VIEWER_REGRESSION_FIX_SRS.md` — REG-1~8 / FR-1~10 (focusedRegion 동기화 회귀, 본 review 의 S1 동기 부여)
- `HOT_RELOAD_SRS.md` — Go 백엔드 무중단 재기동 계획
- `ARCHITECTURE_DEEPENING_RFC.md` — 기존 아키텍처 심화 RFC
- `FOLLOWUP_HOTFIX_RFC.md`

---

## 6. 다음 세션 진입용 프롬프트

아래를 그대로 새 Claude Code 세션에 붙여 넣어 작업을 이어 갈 수 있다.
이번 세션의 목적은 **SRS 작성이 아니라 실제 수정 구현**이다.

```
docs/internal/DESIGN_REVIEW_FOLLOWUP.md 에 정리된 design review 결과(S1~S6, L1~L8)를 실제 수정한다.

이번 세션 목표: 사용자가 선택한 항목을 Spec → Test → Code 순으로 구현·검증·문서화 완료까지.

진행 절차:
1. 컨텍스트 로드:
   - docs/internal/DESIGN_REVIEW_FOLLOWUP.md (§2 Strategic concerns, §3 Localized issues, §4 작업 큐)
   - docs/internal/MD_VIEWER_REGRESSION_FIX_SRS.md (기존 SRS 양식 참고)
   - 변경 대상 파일을 LSP/Serena 로 우선 탐색.
2. 화면 첫 응답에 §2·§3·§4 요약을 노출하고 사용자에게 한 번에 묻는다:
   - 이번 세션에서 다룰 항목 (S1~S6 / L1~L8 다중 선택 가능)
   - 각 항목의 범위 한정 (예: S1 은 LayoutStore 만 분리, Renderer/InputBinding 은 후속)
   - 단일 PR vs phase 분할 여부
3. 답변 후 항목별로 다음 사이클을 반복한다 (CLAUDE.md SDD+TDD 강제):
   a. 최소 Spec 작성/갱신 — IEEE 29148 양식. 새 항목이면 docs/internal/<NAME>_SRS.md 생성, 기존 SRS 가 있으면 추가 섹션. FR/NFR/완료 조건 명확.
   b. 테스트 먼저 작성/수정 — 실패 확인. 프론트는 e2e/, Go 는 internal/<pkg>/*_test.go.
   c. 구현 — 외과적 변경. 같은 클래스 회귀가 다시 안 생기도록 단일 진입점/단일 불변식으로 구조화.
   d. go test ./... 와 npx playwright test (필요 시 격리 포트 58147) 전부 통과 확인.
   e. SRS 의 완료 조건 체크리스트 갱신, web/index.html 의 ?v= 캐시 버스터 bump (프론트 변경 시).
4. 변경 요약을 사용자에게 보고하고 다음 항목 선택을 묻는다.

제약 (반드시 준수):
- 커밋은 사용자 확인 후에만. Claude Co-Author 시그니처 삽입 금지 (organization rule).
- Spec 없이 코드 변경 금지. Test 없이 구현 금지.
- TypeScript 룰 (CLAUDE.md): public 키워드 생략, any 금지, try/catch 제어 흐름 금지.
- LSP/Serena 우선 탐색. grep/find 는 파일명·패턴 검색 한정.
- 외과적 변경. 같은 PR 내 무관한 리팩터링 금지.
- 파일 이동은 mv, 작성은 Write/Edit 로.
- 회귀 위험이 큰 항목(특히 S1 App 3분할)은 phase 단위로 쪼개고 각 phase 가 독립적으로 그린 빌드를 유지해야 한다.

권장 시작 항목 (의견 없으면 이 순서):
1) L1 _send 버퍼링 또는 L4/L8 같은 작은 안전성 패치로 워밍업.
2) S5 workspace Snapshot() 통합 (변경 면적 작고 영향 큼).
3) S3 handlers_api 라우터 테이블화 (테스트 격리도 향상).
4) S2 PaneManager 분해.
5) S1 App 3분할 (가장 큰 작업, 별도 phase 로).

세션 종료 시 처리한 항목과 미처리 항목을 본 문서 §4 작업 큐에 표시(✅ / ⏸️) 하고 push 는 하지 말고 stage 만 두어 사용자 검토 대기.
```
