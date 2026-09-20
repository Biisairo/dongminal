# 프로덕션 승격 감사 — 종합

> 2026-09-20 · 브랜치 `refactor` · 기준 커밋 `ba13ec92`
> 1단계(전수 분석)의 산출물. 소스는 아직 한 줄도 고치지 않았다.

## 읽는 순서

| 문서 | 범위 | 규모 | HIGH/MED/LOW |
|---|---|---:|---|
| [`AUDIT-uiux.md`](AUDIT-uiux.md) | **화면을 눌러 본 기록** — UI/UX·일관성·접근성·스크롤 | 실사용 | 15 / 15 / 5 |
| [`AUDIT-fe-ui.md`](AUDIT-fe-ui.md) | `web/js/ui/` · `web/js/git/` | 23,734줄 · 57파일 | 7 / 11 / 5 |
| [`AUDIT-fe-core.md`](AUDIT-fe-core.md) | `web/js/core/` · `i18n/` · `index.html` | 21,484줄 · 63파일 | 7 / 14 / 7 |
| [`AUDIT-design.md`](AUDIT-design.md) | CSS 6벌 · 토큰 · 54종 테마 | 4,518줄 | 3 / 6 / 8 |
| [`AUDIT-go-http.md`](AUDIT-go-http.md) | `httpapi`·`gitapi`·`httproute`·`httpreq`·`apierr`·`seam`·`toolclient` | — | 9 / 14 / 11 |
| [`AUDIT-go-domain.md`](AUDIT-go-domain.md) | `domain/**` · `hub/**` | — | 12 / 16 / 6 |
| [`AUDIT-go-infra.md`](AUDIT-go-infra.md) | `shared/` · `daemon/` · `ctl/` · `helper/` · `cmd/` | 29,500줄 | 8 / 11 / 8 |
| [`AUDIT-docs-gap.md`](AUDIT-docs-gap.md) | SRS 167건 ↔ 코드 | — | 5 / 7 / 4 |
| | | **합계 214건** | **66 / 94 / 54** |

---

## 1. 이 저장소에 대한 정직한 평가

**요청에 담긴 전제 하나는 사실과 다르다.** "문서·기록에는 있으나 구현이
되지 않았거나, 미흡하거나, 잘못된 경우" 를 찾아 달라고 하셨는데, 전수 대조
결과는 이렇다 (`AUDIT-docs-gap.md` §1.2):

| 분류 | 건수 |
|---|---:|
| 미구현 (완료 표기인데 코드 없음) | **0** |
| 잘못 구현 | **0** |
| 고아 SRS | **0** |
| 1급 코드의 TODO/FIXME/HACK | **0** |
| 생성물(`errors.md`·`decisions.md`) 비동기 | **0** (diff 0줄) |
| 구현 미흡 | 1 |
| 문서가 낡음 | 6 |
| 상태 라벨 오류 | 5 |

`make gates` 33종 전량 통과. SRS 167건 중 색인 누락 0, 끊긴 링크 0.
**기계가 재는 자리는 전부 초록이다.**

그래서 214건의 발견은 거의 전부 **게이트가 재지 않는 표면**에 있다. 이 보고서의
값어치도 거기에 있고, 뒤에 이어질 작업의 절반은 **게이트를 넓히는 일**이어야 한다.

---

## 2. 가로지르는 발견 — 세 가지 패턴

214건을 원인별로 묶으면 서로 다른 여덟 영역에서 **같은 세 모양**이 반복된다.

### 패턴 A — "단일 출처를 세우고 호출부 일부만 옮겼다"

가장 많고, 가장 고치기 쉽고, 가장 조용히 새는 종류다.

| 세운 것 | 닿은 곳 | 안 닿은 곳 |
|---|---|---|
| `.ui-scroll` (스크롤바 한 벌) | **1곳** | 스크롤 표면 **33곳**이 브라우저 기본 |
| `UIKit.button()` | **1곳** | `createElement('button')` **34곳** |
| `.ui-btn` (포커스 링 포함) | 다수 | 버튼 **약 30종**이 UA 기본 링만 |
| `UIKit.dialogOpen` (Tab 트랩·포커스 복귀) | **2곳** | 모달 골격 **5벌**에 트랩 없음 |
| `apierr.CodeHeader` (`X-Error-Code`) | `gitFail`·`jsonFail` | fs 표면 **전체** + gitapi **11곳** |
| `failRead` (본문 읽기 실패 코드) | 1곳 | **6곳**이 언제나 `body_too_large` 를 낸다 |
| `t()` (i18n) | 958키 | 영문 리터럴 **113개**가 카탈로그 밖 |
| `timer-hub` | 다수 | 직접 `setTimeout` 하는 자리 |
| `dmenv.DialHost` | `start` | `dmctl`·`health`·`doctor` 가 각자 |
| `reconcileList` | 11곳 | `innerHTML=''` 전량 재생성 **6곳** |
| `homeLayout()` ("전수 목록") | — | `git-worktrees/`·`ext/`·`worktrees/` 누락 |

**왜 게이트가 못 막았나.** 게이트가 "이미 병기된 것" 만 세도록 만들어져 있다.
`DESIGN_TOKENS_SRS` §7.6 잔여표가 대표적이다 — *"키트 클래스와 함께 붙는 옛
클래스를 열거한다"* 이므로 **한 번도 병기되지 않은 것은 세어지지 않는다.**
그래서 표는 "탭 넷만 남았다" 고 말하지만 실제로는 여섯 종 98개가 남아 있다
(`AUDIT-uiux.md` §5A.5).

### 패턴 B — "게이트의 사각지대"

| 게이트 | 보는 것 | 못 보는 것 | 새어 나간 것 |
|---|---|---|---|
| `check-hardcoded-color` | `web/*.css` 의 `:root` **밖** | `:root` **안** · `web/js/**` · `index.html` | 색 위반 **25건** (라이트 테마 11종 파탄 1건 포함) |
| `check-i18n` | **한글** 리터럴 | **영어** 리터럴 | 영문 **113개** |
| `check-focus` | `outline:none` 쓴 자리의 짝 | 애초에 링을 안 그리는 자리 | 버튼 **30종** |
| `check-css-vars` 등 | `web/*.css` | `readdirSync` 가 비재귀 | 하위 디렉터리 |

### 패턴 C — "잠금 밖으로 내부를 내보낸다 / 경계를 안 지킨다"

Go 쪽의 진짜 결함이 모인 곳이다.

- `run.Store` 의 조회 11개가 잠금 밖으로 `Members` 배열과 `*Worktree` 포인터를
  그대로 내보낸다. **같은 패키지가 `Messages` 에 대해서는 이미 이 위험을 알고
  고쳐 두었다** — 처방이 있는데 두 필드에 적용되지 않았다. `-race` 가 잡는 진짜
  레이스다.
- `query.StatusOf` 만 `StdoutTruncated` 를 보지 않는다 (나머지 8개 조회는 본다).
  `--untracked-files=all` + 1MiB 상한이라, FR-GDT-22 가 겨냥한 바로 그 대형
  저장소에서 파싱이 깨진다.
- `PUT /api/access` 가 **디스크 쓰기 실패를 삼키고 200 을 답한다.** 접근 제어
  목록이다 — 사용자는 켰다고 믿고 다음 기동에서 열린 서버를 만난다.
- 본문 상한 없는 종단 **7개** (`httpreq` 패키지의 존재 이유가 그것인데).

---

## 3. 가장 먼저 고쳐야 할 열 가지

등급은 **사용자에게 닿는 피해 × 고치는 비용**으로 다시 매겼다.

| # | 발견 | 왜 여기 | 출처 | 공수 |
|---|---|---|---|---|
| 1 | `PUT /api/access` 가 쓰기 실패를 삼키고 200 | 보안 경계가 조용히 안 걸린다 | go-http H-3 | S |
| 2 | `run.Store` 조회가 잠금 밖으로 내부 배열·포인터 노출 | 진짜 데이터 레이스, 처방이 이미 패키지 안에 있다 | go-domain H-1 | M |
| 3 | 본문 상한 없는 종단 7개 | 인증 없는 제품에서 메모리를 요청자가 정한다 | go-http H-2 | M |
| 4 | 스크롤 표면 33곳이 브라우저 기본 스크롤바 | Linux·WSL·Windows 에서 54종 다크 테마 위에 밝은 회색 바 | uiux 5A.1 | M |
| 5 | `--git-st-add` 가 라이트 테마 11종을 깨뜨린다 · `#f44` | 실사용 화면이 깨진다 | design A등급 2건 | S |
| 6 | `git/` 에 `tabindex` 0곳 — git 뷰 전체가 마우스 전용 | WCAG 2.1.1. 제품의 핵심 화면 하나가 키보드로 안 된다 | fe-ui H-5 | M |
| 7 | 모달 5벌에 Tab 트랩·포커스 복귀 없음 | 열면 포커스가 뒤로 샌다 | fe-ui H-4 · fe-core H3 | M |
| 8 | `X-Error-Code` 가 fs 전체 + gitapi 11곳에서 빠짐 | 방금 세운 오류 계약이 가장 자주 실패하는 경로에서 안 선다 | go-http H-1 | M |
| 9 | `TimerHub._tick` 이 콜백 예외를 안 막는다 — 스케줄러가 멎는다 | 한 번 터지면 앱의 모든 주기 작업이 죽는다 | fe-core H5 | S |
| 10 | `_killToolInstances`·`toolAny` 가 슬롯 0·1 만 본다 (`SLOT_MAX=4`) | 슬롯 2·3 의 도구가 정리되지 않는다 | fe-core H1 | S |

---

## 4. 성능 — 한 번에 처리할 목록

요청하신 대로 **모아만 두었다.** 지금 고치지 않는다 — 구조 정리가 끝난 뒤
한 묶음으로 처리하고, 각 항목은 아래 "측정" 열의 방법으로 전후를 잰다.

### 4.1 효과가 큰 순서

| # | 자리 | 현상 | 기대 효과 | 측정 | 출처 |
|---|---|---|---|---|---|
| 1 | `httpapi` 자산 서빙 | **사전압축 자산을 요청마다 통째로 읽고 필요하면 통째로 푼다** | 첫 화면의 정적 자산 왕복 전부 | 자산 요청의 p50/p99 + `pprof` alloc | go-http P-1 |
| 2 | LSP `session()` | **요청마다 플러그인 칸 전체 재파싱** — 호버 한 번이 `ReadDir` + 팩 수만큼 JSON 파싱 + `LookPath` | 호버·정의이동 지연 | 호버 1회의 `ReadDir`·`Open` 횟수 | go-domain P1 / H-3 |
| 3 | `ui/renderer.js render()` | **호출 지점 57곳**, 무엇이 바뀌었든 9개 하위 렌더를 전부 지난다 | rAF 합치기로 연속 N회 → 1회 | `render()` 진입 카운터 (탭 열기·창 전환·폴링 1분) | fe-ui P-5 |
| 4 | `git/panel-diff.js:293` | **blame 비가상화** (행당 6노드 · 상한 없음) | 5,000줄 파일에서 노드 30,000 → 창 크기×6 (≈99%↓) | `.git-blame-row` 개수 + `performance.measure` | fe-ui P-1 |
| 5 | `run.Store` | 변경마다 **전량 재직렬화 + 깊은 복사 2회** | Run 수에 선형인 쓰기 비용 | 저장 1회의 alloc · 바이트 | go-domain P3 |
| 6 | `git/remote.js:702` · `history-refs.js` 외 5곳 | 폴링 회차마다 **목록 전면 교체** (`innerHTML=''`) | DOM 변이 N행 → 0 (값 불변 시) · hover/선택 보존 | `MutationObserver` 로 60초간 변이 수 | fe-ui P-2·P-4 |
| 7 | `httpapi` `etags` | **요청자가 키를 정하는 무한 성장 음수 캐시** | 메모리 상한 | 캐시 엔트리 수 추이 | go-http P-2 |
| 8 | `ui/renderer.js:1424` | pane 마다 **미수거 `ResizeObserver`** | 누수 제거 | pane 20회 생성·삭제 후 힙 스냅샷 | fe-ui P-6 |
| 9 | `ToolManager.SaveAll` | 도구마다 **`lsof` fork** (darwin) | 도구 수에 선형인 fork | `SaveAll` 1회의 자식 프로세스 수 | go-infra P2 |
| 10 | `app-statusbar.js:33` `_pollStats` | 3왕복을 **직렬**로, 최소 1초 주기 | 3왕복 → 1왕복(병렬 또는 합친 종단) | 상태바 갱신 1회의 요청 수·시간 | fe-core P1 |
| 11 | `runtime.Install` | **부팅마다 두 번** (서버 + 데몬) | 기동 시간 | `start` 의 벽시계 | go-infra P1 / 항목 8 |
| 12 | `refsTree` | **1Hz `ReadDir` 워크** | 유휴 시 디스크 I/O | 유휴 60초의 `ReadDir` 수 | go-domain P4 |
| 13 | `gitPinnedEntries` | 핀마다 `RepoRoot` 를 **순차** 호출 | 핀 N개 → 병렬 | 핀 10개일 때 응답 시간 | go-http P-3 |
| 14 | `boot-flow` | **`left` 를 애니메이션** (부팅 중에) | `transform` 으로 바꿔 리페인트 제거 | 부팅 구간의 Layout 이벤트 수 | design 10-1 |
| 15 | `grepWithGo` | 파일마다 **전체를 두 번 복사** | 할당 절반 | grep 1회의 alloc | go-http P-4 |

### 4.2 확인만 하고 손대지 않을 것

- `ui/renderer.js` 28건 · `doc-render.js` 15건의 레이아웃 읽기 — **루프 안의
  강제 리플로는 실측에서 찾지 못했다.** "확인 대상" 이지 결함이 아니다.
- 부팅 경로의 블로킹 구간 — `AUDIT-go-infra.md` P5 가 **현재 구조는 건전하다**
  고 결론.
- `will-change` 남용 없음, blur 최소, 셀렉터 비용 정상 (design 10-2·10-3).

---

## 5. 문서 ↔ 구현

`AUDIT-docs-gap.md` 전문 참조. 요점만:

**고칠 것 (코드가 아니라 문서 쪽이 대부분이다).**

1. **상태 라벨 5건이 전부 틀렸다** — `승인·구현중` 인 5건 중 실제로 진행 중인
   것이 없다. 라벨을 실제에 맞춘다.
2. **손으로 적는 문서 6건이 낡았다** — `features.md`·`architecture.md`·색인
   설명문. 기계가 재는 문서는 전부 동기 상태다.
3. **구현 미흡 1건** — `AUDIT-docs-gap.md` §3 M5.
4. **`lspServerPaths` 를 편집할 UI 가 없다** — `EDITOR_LSP_SRS` 가
   `승인·구현완료` 인데 FR-LSP-3·4①·46④ 가 **영구 미도달**이다. 설정 값은
   있는데 사용자가 손댈 자리가 없다 (fe-core D1). 이것이 유일한 "UI 에서 빠진
   기능" 이다.
5. **FE 모듈 경계 DoD 가 역행했다** — 500줄 초과 파일 22 → **26**, 최대 파일
   1,336 → **1,586**, `helpers.js` 979 → **1,136**
   (`FE_MODULE_BOUNDARY_SRS` §7.1 기준선 대비). 문서의 완료 선언과 현재 수치가
   어긋난다.

**게이트를 넓혀야 할 곳** (패턴 B 참조): `check-hardcoded-color` 를 `:root`
안·`web/js/**`·`index.html` 까지, `check-i18n` 을 영어 리터럴까지, `check-focus`
를 "링을 안 그리는 자리" 까지, `check-css-vars` 의 `readdirSync` 를 재귀로.
`.ui-scroll` 검사와 "키트 클래스 없는 `<button>`" 검사를 새로 세운다.

---

## 6. 다음 단계 (2단계)

이 감사를 근거로 **리팩토링 SRS** 를 쓰고 승인받은 뒤 구현에 들어간다.
제안하는 묶음 순서는 다음과 같다. 각 묶음 끝에 `make all`, 묶음 경계에서 e2e 전량.

| 묶음 | 내용 | 근거 | 위험 | 상태 |
|---|---|---|---|---|
| **B0** | **게이트를 먼저 넓힌다** — 지금 새고 있는 네 통로를 막고, 새 검사 둘을 세운다. 탐침으로 검출을 확인하고 지운다 (규약 3-3) | 패턴 B | LOW | **폐기** — B0 을 따로 두지 않고 각 묶음과 함께 세운다 (D-SAF-4, 사용자 결정) |
| **B1** | **안전·정확성** — §3 의 1·2·3·8·9·10 | 패턴 C + 계약 누락 | MED | **끝났다** (`SAFETY_CORRECTNESS_SRS`) |
| **B2** | **킷을 끝까지 적용한다** — `.ui-scroll` 47곳 · 버튼 **70자리**(실측; "98개" 는 한 화면의 표본이었다) · 모달 골격 다섯의 접근성 계약 · 포커스 링 · 게이트 둘 | 패턴 A (UI) | MED | **끝났다** (`KIT_APPLICATION_SRS`) |
| **B2-K** | **키보드 도달** — git 뷰 8개 · 스크롤 표면 47개. `tabindex` 는 여기로 옮겼다 (사용자 결정 2026-09-20, D-KIT-8): 결손이 git 에만 있지 않고, `FR-A11Y-16` 이 도달 대상을 **손으로 열거**하는 것이 근본 원인이다 | `AUDIT-fe-ui.md` H-5 | MED | **별도 작업** |
| **B3** | **킷에 없는 컴포넌트 8종을 세우고 옮긴다** — `.ui-key`·`.ui-switch`·`.ui-section-head`·`.ui-segment`·`.ui-notice`·`.ui-empty`·`.ui-split`·`.ui-badge` + 넘침 페이드 · 모달 chrome | uiux §1·§4 | MED | **끝났다** (`KIT_COMPONENTS_SRS`) |
| **B4** | **말을 고친다** — 낱말 통일, 영문 리터럴, 조사 헬퍼, 존댓말 등급, 색 위반 25건. **B3 이 넘긴 둘**: 머리글의 낱말 통일(`STAGED`→`스테이지됨` 류 — B3 은 대소문자만 고쳤다) · `300개 로드`→상태로 읽히는 말 (FR-CMP-85) | uiux §2 · design | LOW | **끝났다** (`WORDING_COLOR_SRS`) |
| **B5** | **구조 정리** — 패턴 A 의 Go 쪽 잔여, 과대 함수·모듈 분할, `internal/shared` 응집도. **B3 이 넘긴 것**: 공용 클립보드 헬퍼 추출 (`git/confirm.js`·`git/dialog.js` 가 같은 textarea 수법을 각자 갖고 있어 세 번째 자리를 만들 수 없었다 — FR-CMP-63a) | 각 보고서 | MED | |
| **B6** | **성능 한 묶음** — §4.1 의 15건, 전후 측정과 함께 | §4 | MED | |
| **B7** | **문서 동기화** — 상태 라벨 5건, 낡은 문서 6건, DoD 수치 갱신 | §5 | LOW | |

**색에 관한 불변 제약.** `DESIGN_TOKENS_SRS` FR-TOK-16 이 팔레트 값 변경을
금지하고 테마는 54종이다. 위 전부는 **기존 토큰의 조합**으로만 한다.
새 hex 를 넣지 않는다.
