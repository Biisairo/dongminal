# SPA 프로파일 — Worker 대상과 부팅 스크립트 (이슈 3.1, 2026-11-24)

> 근거: PERF_OPTIMIZATION_SRS FR-SPA-1·2·5, OQ-2
> 대상: `perf-m1` 판 바이너리(1.13 병합 직후, 1.14 이전), 격리 인스턴스(포트 61850)
> 브라우저: Playwright Chromium 새 헤드리스(GPU), 창 1600×1000
> 측정 도구: Chromium 트레이스(`devtools.timeline`·`v8.cpu_profiler`) + JS 커버리지. 측정 스크립트는 커밋하지 않았다(`/private/tmp/otter-perf/profile-spa.mjs`)

측정할 때 다른 프로젝트의 `cargo test` 하나가 함께 돌았다. 값이 조금 부풀었을 수 있다.

## 1. 재는 법

- 단계마다 트레이스를 따로 떴다. 렌더러 메인 스레드에서 **16 ms 를 넘는 작업(RunTask)** 만 골랐다.
- 작업마다 세 값을 적었다.
  - 스크립트 시간: 함수 호출·컴파일·타이머 콜백
  - DOM 시간: 스타일·레이아웃·그리기
  - 그 구간의 CPU 표본이 가장 많이 머문 앱 함수
- "Worker 로 옮길 수 있는가" 는 그 함수가 DOM(요소·레이아웃·canvas)을 만지는지를 코드로 확인해 정했다.

## 2. 16 ms 를 넘는 작업

| 단계 | 16 ms 초과 작업 | 가장 큰 것 | 무엇이 시간을 썼나 |
|---|---|---|---|
| 부팅 | 4건 | 28 ms | `_gpuAttach`(WebGL 붙이기)·`TerminalTool.open`, 앱 `init`·`tabsFit`, 스타일 계산 |
| 터미널 출력 — 줄, 보이는 칸 | 0 | — | — |
| 터미널 출력 — TUI, 보이는 칸 | 0 | — | — |
| git 창 열기 | 0 | — | — |
| 마크다운 파일을 편집기로 열기 | 3건 | 24 ms | `FileEditor._mountView`·`dispatchTransactions`, 탭 배치 |
| 큰 파일(2만 3천 줄 JS)을 편집기로 열기 | 5건 | **79 ms** | CodeMirror 언어 파서(vendor `nextInner`·`addActions`) 79 ms, 미니맵 `edMinimapScale` + canvas `fillText` 38 ms, 첫 트랜잭션 21 ms |
| 큰 파일에서 찾기(글자 하나마다) | 16건 | **62 ms** | **`edFindHits`(js/ui/cm-find.js) 가 작업의 86%**. 글자를 칠 때마다 50~60 ms |

재지 못한 것:

- **git diff(큰 파일)**: 측정 스크립트의 선택자가 Changes 목록의 행을 찾지 못했다. 다시 재야 한다.
- **git 기록 화면(커밋 401개)**: 기록 뷰를 연 뒤 트레이스 종료가 4분 넘게 돌아오지 않았다. 페이지 충돌 신호는 없었다. 메인 스레드가 멈췄을 가능성이 있다 → **3.2 에서 먼저 재현한다**.
- **문서 렌더(markdown-it·highlight)**: 위 실행이 중간에 끊겨 렌더 화면 단계를 재지 못했다.
- **Run 그래프·채팅**: 데이터(Run·짝 PC)를 만드는 비용이 커서 이번에는 재지 않았다.

## 3. Worker 후보

| 후보 | 파일 | 1회 시간 | 빈도 | DOM 접근 | Worker 로 옮길 수 있나 | 권장 |
|---|---|---|---|---|---|---|
| 찾기 일치 계산 `edFindHits` | `js/ui/cm-find.js:13` | 50~60 ms (2만 3천 줄) | 찾기 입력의 글자마다 | 없음 — CodeMirror 문서 텍스트만 훑는다 | **예**. 다만 매번 문서 전체를 Worker 로 보내면 그 복사가 비싸다. Worker 가 문서 사본을 들고 변경분만 받아야 한다 | 먼저 **입력 지연(디바운스) + 보이는 구간 먼저·나머지는 나눠 계산** 으로 16 ms 아래로 내린다. 그래도 넘으면 Worker |
| 언어 파싱 | vendor CodeMirror(lezer) | 79 ms(처음 열 때 1회) | 큰 파일을 열 때 | 없음 | 어렵다 — 파서 상태를 편집기가 직접 쓴다 | CodeMirror 의 시간 나눔 파싱 설정(작업 예산)을 확인한다. Worker 대상 아님 |
| 미니맵 그리기 | `js/ui/cm-scrollbar.js:43` + canvas | 38 ms | 큰 파일을 열 때·스크롤 | 있음 — 레이아웃을 읽고 canvas 에 그린다 | OffscreenCanvas 라면 가능하지만 레이아웃 읽기는 남는다 | Worker 대상 아님. 큰 파일에서 미니맵 그리기를 나눠 하거나 늦춘다 |
| 부팅의 WebGL 붙이기 | `js/ui/term-gpu.js:61` | 12 ms 안팎(28 ms 작업의 42%) | 부팅 때 보이는 칸마다 | 있음 | 아니다 | M3 스케줄러로 첫 페인트 뒤로 미룬다 |

**결론(OQ-2)**: 지금 측정에서 Worker 로 옮길 만한 비 DOM 계산은 **찾기 일치 계산 하나**다. 터미널 출력(보이는 칸)과 부팅에는 Worker 대상이 없다. 터미널 출력의 해석 비용은 잠든 터미널이 원인이고, 이것은 M2(구독 해지)가 없앤다.

## 4. 부팅 스크립트 (FR-SPA-1·2)

부팅 때 싣는 스크립트는 **300개, 3,675 KB**(압축 전)다. 부팅을 마치고 4초 동안 **함수를 한 번도 부르지 않은 스크립트는 111개, 1,126 KB** 다.

| 묶음 | 파일 | 크기 | 부팅 때 호출 없음 |
|---|---|---|---|
| `js/git` | 56 | 663 KB | **43개 · 469 KB** |
| `js/ui` | 80 | 840 KB | 39개 · 382 KB |
| `js/core` | 149 | 1,284 KB | 29개 · 274 KB |
| vendor `markdown-it`·`highlight`·`purify` | 3 | 266 KB | 감싸는 함수만 돈다 — 첫 화면에 필요 없다 |
| `js/i18n` (ko·en 두 벌) | 2 | 208 KB | 활성 언어 하나만 필요(약 100 KB 줄일 수 있다) |
| vendor `xterm`·애드온 | 6 | 406 KB | 첫 화면에 필요하다 |

부팅 때 호출이 없는 큰 파일(앞 20개): `run-dashboard.js` 24 KB · `diff-view.js` 24 · `file-tree-xfer.js` 24 · `file-tree-edit.js` 23 · `git-change-rows.js` 23 · `branches-ops.js` 23 · `file-tree-load.js` 22 · `file-editor.js` 21 · `doc-render.js` 21 · `history-load.js` 21 · `file-editor-diff.js` 20 · `remote.js` 19 · `tool-cmd.js` 19 · `git-write.js` 19 · `menu-items.js` 19 · `run-tree.js` 19 · `cm-setup.js` 18 · `git-confirm.js` 17 · `cm-lsp.js` 17 · `history-rows.js` 16.

주의할 점:

- `constants*.js`(예: `constants.js` 26 KB, `constants-git-changes.js` 23 KB)는 함수가 불리지 않아도 **데이터로 쓰인다**. 그대로 지연 로딩 대상이 되는 것은 아니다. 해당 화면의 상수만 그 화면 묶음으로 옮겨야 한다.
- `tool-cmd.js` 는 서버 명령을 받을 때 쓴다. 부팅 4초 안에 명령이 오지 않았을 뿐이므로 첫 화면 묶음에 남긴다.

### 지연 로딩 묶음 제안

| 묶음 | 들어갈 것 | 줄어드는 부팅 JS |
|---|---|---|
| git | `js/git/*` 의 화면 코드와 git 상수 | 약 470~660 KB |
| 편집기·탐색기 | `file-editor*`·`file-tree-*`·`cm-*`·`editor-*`, 편집기 상수 | 약 250 KB |
| 문서 렌더 | `doc-render*` + vendor markdown-it·highlight·purify | 약 290 KB |
| Run 화면 | `run-dashboard`·`run-tree`·Run 그래프 | 약 60 KB |
| 언어 | 비활성 언어 파일 | 약 100 KB |

모두 합치면 부팅 JS 가 3.6 MB 에서 **약 2.2~2.4 MB** 로 준다. 목표 1.5 MB(NFR-PRF-12)에 닿으려면 `js/core` 의 화면별 컨트롤러(설정 탭들·채팅·간선 등)도 등록부로 나눠야 한다.

## 5. M3 하위 이슈 제안

| ID | 제목 | 내용 |
|---|---|---|
| 3.2 | git 기록 화면 멈춤 재현과 측정 | 커밋 수백 개 저장소에서 기록 뷰를 열 때 메인 스레드가 멈추는지 재현한다. 멈추면 결함으로 고친다(가상 목록·나눠 그리기). git diff(큰 파일)·문서 렌더·Run 그래프·채팅도 이때 함께 잰다 |
| 3.3 | 찾기 일치 계산을 16 ms 아래로 | `edFindHits` 에 입력 지연과 나눠 계산을 넣는다. 그래도 넘으면 Worker(문서 사본 유지 방식). 시험: 2만 줄 파일에서 글자마다 메인 스레드 작업 16 ms 이하 |
| 3.4 | 화면 등록부와 지연 로딩 (FR-SPA-1·2·6) | 클래식 스크립트 지연 로딩기, 등록부(이름 → 싣기 함수), 위 묶음 다섯 개. 부팅 요청 80·부팅 JS 1.5 MB 를 목표로 `js/core` 의 화면별 컨트롤러도 나눈다 |
| 3.5 | 생명주기 wake/sleep (FR-SPA-3) | 보이지 않는 화면의 구독·타이머·그리기를 멈춘다 |
| 3.6 | 프레임 스케줄러 (FR-SPA-4) | DOM 쓰기 합치기, 입력·깬 터미널 우선, 8 ms 예산. 부팅의 `_gpuAttach`·`tabsFit` 을 첫 페인트 뒤로 |
| 3.7 | 큰 파일 열기 | 언어 파서의 시간 나눔 설정과 미니맵 그리기 지연(편집기 79 ms·38 ms 작업) |
