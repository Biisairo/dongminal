# 계획: 사용자 확인 피드백 반영 (user_checklist.md)

- **입력 문서**: `user_checklist.md` (오류 3건 · 수정사항 4건 · 확인 필요 1건)
- **스펙**: `docs/internal/USER_CHECKLIST_FIXES_SRS.md`
- **작성 시점 기준 커밋**: 워킹트리 기준 (`docs/`, `web/`, `internal/`, `scripts/`)

## 1. 목적

사용자 실사용 확인에서 나온 8개 항목을 근본 원인 단위로 묶어, 스펙 → 테스트 → 코드 순서로
순차 해소한다. 항목별 근본 원인은 SRS §2 에 파일·라인 근거와 함께 실측 기록한다.

## 2. 항목 → 묶음 매핑

| 입력 항목 | 증상 | 묶음 | 요구사항 |
|---|---|---|---|
| 오류 1 | 확인창 "백그라운드로" 버튼만 네이티브 스타일 | **A** | FR-BGU-1 |
| 수정 1 | 백그라운드 배지가 상태바 지표에 묻힘 → 우측 끝 버튼화 | **A** | FR-BGU-2..5 |
| 수정 2 | 백그라운드 목록이 앵커 팝오버 → 중앙 모달 | **A** | FR-BGU-6..9 |
| 수정 3 | `dongminal migrate` 안내가 실행 불가 | **B** | FR-MIG-1..5 |
| 오류 2 | 모바일 키바 터치 무반응 · 슬라이드 불가 | **C** | FR-MTB-1..7 |
| 확인 1 | 백그라운드 복귀 대상 pane 지정 불가 | **D** | FR-BGR-1..6 |
| 오류 3 | 외부 기기 접속 시 off-focus 미동작 | **E** | FR-XDF-1..14 |
| 수정 4 | 모바일 키보드 표출 시 화면 스크롤 발생 | **F** | FR-MKV-* (미확정) |

**확인 1 은 "정상 동작"으로 판정됐다** (FR-BG-7 명세대로 동작). 사용자 제안에 따라 기능
확장(대상 지정)으로 전환해 묶음 D 가 됐다.

## 3. 실행 순서와 의존성

```
A ─┬─▶ D        A 가 _restoreTool 호출 경로를 건드리므로 D 보다 먼저
   │
B ─┘  (독립)
C     (독립)
E     (스펙 확정 — §6.1 결정 7건 해소)
F     (스펙 인터뷰 필요)
```

| 순서 | 묶음 | 규모 | 게이트 | 상태 |
|---|---|---|---|---|
| 1 | A — 백그라운드 UI 일관화 | 소 | 스펙 확정 (본 문서 함께) | **완료** `eec0ddd` |
| 2 | B — 마이그레이션 진입점 | 소 | 스펙 확정 | **완료** `e6463e1` |
| 3 | C — 모바일 키바 터치 | 소 | 스펙 확정 + `hasTouch` e2e 프로젝트 | **완료** `18c7f14` |
| 4 | D — 복귀 대상 지정 | 소~중 | **FR-BG-7/8 개정 선행** | **완료** `a906418` |
| 5 | E — 크로스 기기 포커스 | 중 | ~~인터뷰 → 스펙 확정~~ **해소 완료** (§6.1) | **완료** (미커밋) |
| 6 | F — 모바일 키보드 뷰포트 | 중 | **인터뷰 → 스펙 확정** (§6.2) | 미착수 |

B 는 구현 중 §2.5a 의 실패 양식을 만나 FR-MIG-3 개정 + FR-MIG-6/7 신설로
범위가 늘었다. C 는 `hasTouch:true` 프로젝트 신설이 전제였고 그대로 수행했다.

A→D 의존성 근거: A 가 `_bgPopoverRender` 를 모달로 대체하며 항목 클릭 → `_restoreTool`
호출부를 재작성한다. D 는 그 `_restoreTool` 의 시그니처를 `(toolId, opts)` 로 확장한다.
역순으로 하면 같은 호출부를 두 번 고친다.

## 4. 묶음별 상세

### 4.1 묶음 A — 백그라운드 UI 일관화

| 항목 | 내용 |
|---|---|
| 영향 파일 | `web/style.css`, `web/index.html`, `web/js/app.js` |
| 주요 심볼 | `_confirmClose`, `_updateStatusBar`, `_bgPopoverToggle`, `_bgPopoverRender` |
| 규모 | 소 |
| 리스크 | **LOW** — 순수 프론트엔드, 서버 계약 무변화 |
| 회귀 주의 | `e2e/mobile-keybar.spec.ts` TC-6 (상태바가 키바와 겹치지 않음) |
| 검증 | e2e 신규 (TC-BGU-1..9) + 기존 스위트 전량 |

### 4.2 묶음 B — 마이그레이션 진입점

| 항목 | 내용 |
|---|---|
| 영향 파일 | `scripts/migrate.sh`(신규), `cmd/dongminal/main.go`, `docs/internal/architecture.md`, `docs/internal/ENTITY_MODEL_HANDOFF.md` |
| 규모 | 소 |
| 리스크 | **LOW** — 기존 `runMigrate` 로직 무변화. 진입점만 추가 |
| 회귀 주의 | `internal/migrate` 는 구 어휘가 입력이다 (`ENTITY_MODEL_HANDOFF.md:192`) — 일괄 치환 금지 |
| 검증 | 스크립트 수동 검증 + `internal/migrate` 기존 유닛 테스트 유지 |

### 4.3 묶음 C — 모바일 키바 터치

| 항목 | 내용 |
|---|---|
| 영향 파일 | `web/js/app.js`, `web/style.css`, `playwright.config.ts`, `e2e/mobile-keybar.spec.ts` |
| 주요 심볼 | `_initMobileKeybar` |
| 규모 | 소 |
| 리스크 | **MEDIUM** — 롱프레스·모디파이어 스티키·스크롤이 같은 제스처 축을 공유한다. 실기기 검증 없이는 확신할 수 없다 |
| 회귀 주의 | TC-T2/T3(롱프레스), TC-D1(sticky/lock), TC-D2(mousedown 포커스 가드) |
| 검증 | **`hasTouch:true` Playwright 프로젝트 신설이 전제**. 이것 없이는 같은 회귀가 재발한다 |

### 4.4 묶음 D — 복귀 대상 지정

| 항목 | 내용 |
|---|---|
| 영향 파일 | `web/js/app.js`, `internal/runtimebin/detach.go`, `docs/external/{api,commands,features}.md`, `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` |
| 주요 심볼 | `_execRemote`(restoreTool 분기), `_restoreTool`, `runDetach`, `detachRestore` |
| 규모 | 소~중 (코드는 국소, 문서·스펙 면이 넓다) |
| 리스크 | **LOW** — 서버 무변화. `location` 미지정 시 기존 동작 유지 (하위 호환) |
| 선행 | **FR-BG-7 / FR-BG-8 개정** — "현재 Pane" → "지정 Pane (미지정 시 현재 Pane)" |
| 검증 | 유닛(`detach.go` 인자 파싱) + e2e(TC-BGR-1..6) |

### 4.5 묶음 E — 크로스 기기 포커스 (스펙 확정)

| 항목 | 내용 |
|---|---|
| 근본 원인 | `BroadcastChannel` 은 동일 브라우저·동일 origin 한정 |
| 영향 범위 | `web/js/app.js` 포커스 소유권 블록 전체 + `internal/server` 신규 상태·엔드포인트 2종 + SSE 이벤트 1종(전체 맵) + `handleCommandSSE` 의 `clientId` 결선 |
| 규모 | 중 |
| 리스크 | **HIGH** — PTY 리사이즈 권한(`_resizeCheck`)이 같은 상태를 공유한다. 소유권 오판은 터미널 크기 깨짐으로 직결 |
| 연관 | `README.md` TODO "focused browser 자동 동기화" 와 동일 뿌리 |
| 게이트 | ~~§6.1 결정 5건~~ **7건 해소 완료.** SRS §3.5 FR-XDF-1..14 확정 |

### 4.6 묶음 F — 모바일 키보드 뷰포트 (스펙 미확정)

| 항목 | 내용 |
|---|---|
| 근본 원인 | iOS Safari 는 키보드 표출 시 layout viewport 를 줄이지 않고 visual viewport 를 스크롤한다. body padding 보정으로는 상쇄 불가 |
| 영향 범위 | `web/style.css` 높이 체계, `web/index.html` viewport meta, `web/js/app.js` visualViewport 블록 |
| 규모 | 중 |
| 리스크 | **HIGH** — 레이아웃 높이의 단일 진실 공급원을 교체한다. 데스크톱 경로까지 영향 |
| 검증 제약 | **iOS 실기기 수동 검증 필수.** Playwright/CDP 로 iOS 의 layout viewport 고정 거동을 재현할 수 없다 |
| 게이트 | §6.2 결정 5건 해소 후 스펙 확정 |

## 5. 공통 완료 정의 (묶음 단위)

각 묶음은 아래를 모두 만족할 때 완료로 인정한다.

1. 해당 FR 전건에 대응하는 테스트가 구현 **전에 실패**하고 구현 **후에 통과**한다
2. `go build ./...` · `go test ./...` 통과
3. `npx playwright test` 전량 통과 (묶음 C 는 `hasTouch` 프로젝트 포함)
4. 미사용 import 없음, 새 코드에 TODO 없음
5. 스펙 범위를 넘는 동작 변경 없음
6. 동작이 변경된 항목은 **이전 동작 / 새 동작 / 이유**를 SRS §7 변경 기록에 남긴다
7. 외부 계약이 바뀐 항목은 `docs/external/` 동반 갱신 (묶음 B·D)

## 6. 열린 결정 (착수 전 해소 필요)

### 6.1 묶음 E — **해소 완료.** SRS §3.5 (FR-XDF-1..14) 로 확정됐다

| # | 결정 사항 | 확정 | 근거 |
|---|---|---|---|
| E-1 | 소유권 상태의 권위 위치 — 서버 in-memory vs `workspace.json` 영속 | **in-memory** (권장안) | 클라이언트 소유권은 휘발성이다. 서버 재시작 시 전원 해제가 안전하다 → FR-XDF-1 |
| E-2 | 해제 트리거 — SSE 구독 해제 즉시 vs grace period | **즉시** (권장안) | 재연결 시 재획득(E-6·FR-XDF-12)이 어차피 필요하고, 그것이 있으면 즉시 해제의 잔여 비용은 dim 깜빡임뿐이다. PTY 리플로우는 사용자가 비소유 기기를 실제로 건드릴 때만 일어나며 그건 E-7 정책상 정상이다. grace 는 만료 타이머·시간 의존 e2e 를 낳는다 → FR-XDF-9 |
| E-3 | `BroadcastChannel` 병행 유지 여부 | **완전 대체** (권장안) | 두 경로가 같은 상태를 쓰면 충돌 원인이 된다. origin 이 다르면 로컬 경로도 이미 무효다 → FR-XDF-5 |
| E-4 | `_resizeCheck`(PTY 리사이즈 권한) 동반 이전 여부 | **동반** (권장안) | 실은 선택지가 아니다. 같은 필드(`_windowFocusOwner`)를 읽으므로 전파 경로만 바꾸면 자동으로 따라온다 → FR-XDF-4 |
| E-5 | README TODO "focused browser 자동 동기화"(마지막 이벤트 기준) 포함 여부 | **미포함** (권장안) | 별건으로 분리 — 최소 구현 원칙 → SRS §3.5.5 |
| **E-6** | **SSE 구독↔Client 결선 방법** (본 문서 초판에 없던 결정. 구현 표면 조사에서 발견) | **`clientId` 쿼리 파라미터** | `handleCommandSSE`(`commands.go:232`)의 `cmdSub` 에는 신원이 없고 `EventSource('/api/commands/sse')`(`app.js:180`)도 `clientId` 를 보내지 않는다. E-2 의 "구독 해제 시 해제"는 이 결선 없이 성립하지 않는다. 쿼리 파라미터는 기존 SSE payload 규약과 `CommandBroker` 인터페이스(`deps.go:74`)를 건드리지 않는다 → FR-XDF-8 |
| **E-7** | **소유권 획득 정책** (본 문서 초판에 없던 결정. 사용자 확인) | **last-focus-wins — 현행 유지** | 사용자 판단: "같은 화면을 보는 PC 사용자와 모바일 사용자 중 한 명은 어쨌든 렌더가 깨진다. 결국 한 명이 깨지는 거면 마지막 접근자가 가지는 방식이 맞고, off-focus 시 dim 이 되므로 정상 동작이다." 대안(작은 화면은 주장 안 함 / 명시적 인수)은 FR 을 늘리거나 새 UI 표면을 요구한다 → FR-XDF-2 |

**E-7 이 왜 결정이 되어야 했는가.** 현재 크로스 기기 동기화가 안 되므로 원격 기기의
`_windowFocusOwner` 에는 자기 자신만 들어 있고, `_resizeCheck` 는 사실상 항상 `true` 를
돌려준다 — **모든 기기가 각자 PTY 를 리사이즈하고 마지막 것이 이긴다.** 묶음 E 이후에는
소유자 하나만 보낸다. 즉 E 는 "동기화 결손을 고치는 것"에 그치지 않고 **여태 발현되지
않았던 리사이즈 권한 게이팅을 처음으로 켜는 작업**이다. 리스크 HIGH 의 실체가 이것이고,
그래서 획득 정책이 곧 PTY 크기 정책이 된다.

**무테스트 영역이다.** 본 문서 §4.5 와 SRS 초판 §4.5 는 `e2e/focus.spec.ts` ·
`focus-invariant.spec.ts` · `regression-focus.spec.ts` 를 회귀 주의 대상으로 적었으나
**사실이 아니다.** 세 스펙은 `s.focusedPane` 불변식만 검증하고 `_windowFocusOwner` 는
참조하지 않는다. 소유권 경로에는 기존 테스트가 없으므로 TC-XDF-* 가 유일한 안전망이다.
크로스 기기 프록시는 `browser.newContext()`(`e2e/sync.spec.ts` 패턴) — `BroadcastChannel`
스코프와 `clientId` 가 모두 격리된다.

### 6.2 묶음 F

| # | 결정 사항 | 권장안 |
|---|---|---|
| F-1 | 높이 권위 — `--vvh`(visualViewport.height) 전면 이전 vs 키보드 상태만 별도 처리 | **전면 이전.** 부분 처리는 현재 body padding 해킹의 재판이 된다 |
| F-2 | iOS 강제 스크롤 상쇄 방법 | `vv.offsetTop` 관측 + 컨테이너 보정. `window.scrollTo` 반복은 스크롤 경합을 만든다 |
| F-3 | viewport meta 에 `interactive-widget=resizes-content` 추가 여부 | **추가.** Android 경로가 단순해진다. 단 기존 TC-A1..A4 가 깨지므로 동반 개정 |
| F-4 | 키보드 표출 시 줄일 대상 — 터미널 영역만 vs 상태바까지 숨김 | **터미널 영역만** (요구 원문 그대로). 상태바 숨김은 별건 |
| F-5 | 검증 수단 | 자동화 가능 범위(Android/Chrome 경로)는 e2e, iOS 는 `docs/internal/test-checklist.md` 에 수동 항목 추가 |

## 7. 문서 갱신 대상

| 문서 | 묶음 | 갱신 내용 |
|---|---|---|
| `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` | D | FR-BG-7/8 개정, TC-BG-7 확장 |
| `docs/external/api.md` | D | `restoreTool` 의 `location` 수용 (§"detachTab/restoreTool 은 location 이 아니라 toolId") |
| `docs/external/commands.md` | D | `detach --restore` 사용법 |
| `docs/external/features.md` | A, D | 배지 → 버튼, 팝오버 → 모달, 복귀 대상 지정 |
| `docs/internal/architecture.md` | B | `dongminal migrate` → `scripts/migrate.sh` |
| `docs/internal/ENTITY_MODEL_HANDOFF.md` | B | 동일 |
| `docs/internal/test-checklist.md` | C, F | 실기기 수동 검증 항목 |
| `README.md` | B | 스크립트 목록에 `migrate.sh` |
