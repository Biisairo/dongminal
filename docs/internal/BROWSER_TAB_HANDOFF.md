# 인수인계 — 브라우저 탭을 Orca 방식(숨긴 headful Chrome)으로 옮긴다

> 근거 SRS: `BROWSER_TAB_SRS.md`(승인·구현완료 — 이번 일로 개정한다) · `BROWSER_TAB_INVESTIGATION.md`.
> 브랜치 `main`. 직전 커밋은 엔벨로프에 있다.

## 착수 블록 — 이번 세션의 지시 전부

1. **먼저 권한부터 확인한다 (§4 첫 항목).** 이 일은 자동 모드 분류기가 두 번 거부한 결과와 같은 목적이다.
   사용자가 권한을 풀었는지(기본 권한 모드로 바꿨거나 허용 규칙을 더했는지) 묻고, 풀리지 않았으면
   **착수하지 말고** 그 사실을 말한다. 분류기의 판단을 다른 경로로 돌아가지 않는다.
2. §2 의 순서대로 간다: PoC → SRS 개정 → Test(RED) → Code(GREEN) → CI + 로컬 e2e.
   PoC 결과로 갈래가 갈린다(C1 확정 / C2 검토) — C2 로 갈 때는 사용자에게 먼저 보고한다.
3. 결정이 필요하면 SRS·조사 문서에서 답을 찾고, 없으면 **더 단순한 쪽**을 골라 SRS 변경 기록에
   "구현 중 결정" 으로 적는다. 되돌리기 어렵거나 밖으로 나가는 일은 먼저 묻는다.
4. 항목(또는 묶음)마다 **자기 파일만 경로로 골라** 커밋하고 `git push origin main` 으로 CI 를 돌린다.
   **사용자 지시: CI 를 돌릴 때 로컬 e2e(`npm run e2e`)도 함께 돌린다.** CI 가 초록이 될 때까지 고친다.
5. 끝나면 최종 보고를 화면에 남기고 `dmctl notify "브라우저 탭 headful 전환 완료"` 를 부른다.

## 0. 한 줄 상태

뒷정리 다섯 항목은 끝났다(§1). 실사용에서 Cloudflare 가 브라우저 탭을 막는다. UA 의 `HeadlessChrome` 은
`a0d2b787` 로 걷었지만 **`navigator.webdriver === true`** 가 남아 Turnstile 체크박스가 끝없이 다시 뜬다
(사용자 확인). 사용자 결정: **Orca 와 같은 방식 — 서버의 Chrome 을 숨긴 headful 창으로 띄운다(C1).**
사이트를 기기의 일반 브라우저로 여는 우회는 **거부**됐다.

## 1. 어디까지 왔나

| 커밋 | 내용 |
|---|---|
| `6c7b979b` | 뒷정리 1 — `paned.go` terminate 가 IPC 읽기 루프에서 유예를 기다리던 결함 (FR-BGK-7). 회귀 시험 RED→GREEN |
| `3b7ce400` | 뒷정리 2 — SRS "검증 한계(TC-BRT-6 Windows·Linux Chrome 샌드박스)" 해소 기록 |
| `5a487abd` | 뒷정리 3 — `TestDaemonConcurrentPushAndRequest` 는 시험의 시간 가정(darwin 은 cwd·busy 마다 lsof·pgrep, 400회 13~25초 vs 상한 30초; 실제 겹침은 첫 0.1초뿐). 출력 끝 표식에서 멈춘다 |
| `5b4d5f34` | (추가) `TestRealFind` — 찾기가 격리 world 준비 전에 불렸다 (Windows CI) |
| `d06f48f7` | (추가) e2e X9 (V-EDT-47) — 여는 순간의 git/status 셋이 셈 뒤에 도착 (Windows CI trace) |
| `a0d2b787` | **FR-BRT-92** — UA 에서 `HeadlessChrome` 을 뺀다. UA 만 덮으면 Chrome 이 Client Hints 를 비우므로 기동 때 `chrome://version/` 에서 자신의 값을 읽어 함께 건다(탐침 컨텍스트의 attach 는 페이지로 세지 않는다). D-BRT-20 |
| `889143a2` | 뒷정리 4 — TC-BRT-81 소리 flaky 의 원인: offscreen 문서가 target 으로 보여도 스크립트가 아직 안 돌아 `__dmOffer is not defined` 로 거절, 뷰어는 재청하지 않음. 신호 식을 함수 정의 뒤에 계산 (FR-BRT-91) |
| `69cb46eb` | 뒷정리 5 — TC-GLR-1: 워치독 문턱을 연 뒤 멈춤과 확인을 두 evaluate 로 나눠 그 틈에 되살아났다. 같은 동기 식에서 읽는다 |

`a0d2b787`·`69cb46eb` CI 는 초록이었다(verify·e2e). 이 문서를 싣는 커밋의 CI 와 로컬 e2e 결과는 뒤에 나온다 —
`gh run list --branch main -R Biisairo/dongminal` 로 확인하고, 빨가면 그것부터 고친다.

## 2. 남은 일과 순서

| # | 할 일 | 끝나는 조건 |
|---|---|---|
| 0 | 권한 확인 (착수 블록 1) | 사용자가 풀었다고 답함 |
| 1 | **PoC**: `launchArgs`(`internal/shared/browser/manager.go`)에서 `--headless=new` 를 뺀 숨긴 창 + `--remote-debugging-pipe` 로 띄워 **로컬 httptest 페이지**에서 `navigator.webdriver` 를 잰다. 외부 사이트 통과 여부는 사용자가 실사용으로 확인한다 | 값이 적힘. `false` → C1 확정. `true` → 원격 디버깅 스위치가 원인 — **C2 를 사용자에게 보고하고 멈춘다** |
| 2 | **SRS 개정**: A1(headless) → 숨긴 headful. 이전/새/이유. 창을 숨기는 방법(macOS·Windows — 화면 밖 위치·`--window-position` 등 후보를 실측으로 고른다), 화면이 없는 Linux 의 동작(가상 디스플레이 요구 또는 headless 로 떨어지기 — 더 단순한 쪽), 포커스를 뺏지 않을 것(A2 기각 사유), 창 크기와 뷰포트(FR-BRT-40·57)의 관계 | `check-srs-status`·`check-srs-progress`·`check-decisions`·`gen-decisions -check` |
| 3 | Test(RED): TC 추가 — 실제 Chrome 로컬 페이지에서 `navigator.webdriver === false`, 창이 보이지 않음/포커스를 뺏지 않음(잴 수 있는 만큼), 기존 TC-BRT-83 유지 | 구현 전 RED |
| 4 | Code(GREEN) + 전량 | `make all` · browser 패키지 `-race` · CI(verify·e2e) · 로컬 e2e |

## 3. 먼저 읽을 것

1. `BROWSER_TAB_INVESTIGATION.md` §3(레퍼런스 — Orca 는 데스크톱 `<webview>`, 원격은 **숨긴 `BrowserWindow` + CDP screencast**) · §4(A1 채택·A2 기각 사유) · §7 D1·D2
2. `BROWSER_TAB_SRS.md` §1.1 · FR-BRT-4~7(기동·수명) · FR-BRT-92 · §6 D-BRT-20 · §7 마지막 행들
3. `internal/shared/browser/manager.go` `launchArgs` · `engine.go` 기동(`Browser.getVersion`·`probeUserAgent`·`setAutoAttach`)
4. `platform` 패키지의 Chrome 기동(`StartPiped`) — OS 분기는 `platform` 안에서만

## 4. 이 세션이 값을 치르고 배운 것

- **권한**: 자동 모드 분류기가 거부한 것 — ① 외부 사이트(`console.typesafe.ai`)에서 webdriver 를 끄고 통과되는지 재는 임시 시험
  ("Third-Party Attack") ② 그 목적의 `launchArgs` 시험 읽기(사유 없음). 거부는 "같은 결과" 전체에 걸린다. 다시 시도하지 말고
  사용자에게 권한을 받는다. 로컬 e2e 결과 로그 읽기도 한 번 거부됐다가 사용자가 직접 요청해 풀렸다.
- **실측(사용자의 실사용 탭, 새 빌드)**: `navigator.userAgent` = `…Chrome/153.0.0.0…`, brands 정상, **`navigator.webdriver` = true**.
  Cloudflare: 기본 UA → 403 "Attention Required", UA 수정 → "Just a moment..." 에서 멈춤, 체크박스를 눌러도 다시 뜸.
- **확인이 필요한 기술 가정(미검증)**: Chrome 은 headless 가 아니어도 `--remote-debugging-pipe/port` 가 있으면 자동화로 표시할 수 있다.
  Orca 에 표식이 없는 것은 Electron 이 디버거를 프로세스 안에서 붙이기 때문으로 보인다. 그래서 PoC 가 첫 걸음이다.
  C2 = 평소처럼 뜬 Chrome + dongminal 확장의 `chrome.debugger`(branded Chrome 은 `--load-extension` 차단 — 설치 경로가 문제, "디버깅 중" 막대).
  C3 = OS webview(WebView2·WKWebView) — 단일 바이너리 원칙과 충돌(B3 기각).
- **UA 만 덮으면 Client Hints 가 빈다**(`Sec-CH-UA`·`userAgentData.brands`). `about:blank` 는 보안 문맥이 아니라 `userAgentData` 가 없다 — `chrome://version/` 에서 읽었다.
  탐침에서 부른 `Target.attachToTarget` 은 `attachedToTarget` **이벤트**를 내고 작업자가 dispose 뒤에 처리한다 — 그 컨텍스트를 적어 두고 건너뛴다(안 그러면 탭이 하나 생긴다; `TestRealDevTools` 가 잡았다).
- **실사용 확인 요령**: 데몬이 브라우저를 소유한다(FR-BRT-8). 웹서버만 다시 띄우면 옛 Chrome 이 남는다 — `ps` 로 `--user-data-dir=~/.dongminal/browser/…` Chrome 의 기동 시각을 본다.
  탭 안의 값은 `dmctl browser eval "<js>" --tab <uuid>` 로 읽는다(읽기만).
- **느림(미해결)**: 사용자가 "반응이 너무 느리다" 고 했다. 원인 미확인 — 후보는 원격 뷰어(Tailscale `100.x`, 두 기기 동시 시청 시 프레임 두 벌), 프레임 크기(JPEG q70 × CSS폭×DPR, `page.go` `startScreencast`), 로컬 e2e 부하. headful 전환과 함께 다시 잰다. 사용자에게 로딩/입력 중 무엇이 느린지·원격 여부를 아직 못 들었다.
- **CI**: `gh` 계정은 collaborator 가 아니다 — push 는 SSH, run 목록·로그·산출물은 읽힌다. flaky 는 산출물을 남기지 않는다(`if: failure()`) — 첫 시도의 실패는 run 로그에서 읽는다.
  `gh run download <id> -n playwright-report-<os>-<샤드>` · trace.zip 의 `*.network` 로 요청 시각을 본다.
- **로컬 e2e 를 다른 시험과 함께 돌릴 때**: `E2E_PORT_BASE=59147` 로 포트 뿌리를 가른다(FR-EPL-14). macOS 에 `timeout` 명령이 없다.
- **고친 흔들림(`889143a2` verify Ubuntu)**: `TestRealLogsScreenshotEval` — console 기록은 이벤트 작업자를 거쳐 evaluate 응답보다 늦게 적힐 수 있다. 시험이 기록을 기다린다.
- **고친 흔들림(`2f002dd7` e2e Windows)**: TC-BRT-32·35 — 페이지는 기본 폭(756)으로 뜬 뒤 칸 폭(562)으로 바뀌는데, 그 사이의
  클릭은 페이지에 **닿지 않았다**(계측: mousedown 없음, 로컬 1/10 재현). 시험은 `waitSized` 로 크기가 확정된 뒤 누른다.
  **제품 쪽 미해결 가능성**: 실사용에서도 탭이 막 뜬 직후의 클릭이 사라질 수 있다 — headful 전환 때 뷰포트 적용 순서와 함께 다시 본다.
- **관찰만 한 흔들림**: `TestRealCloseLeavesNoChrome`(Ubuntu, `5b4d5f34`) — Chrome 이 `getVersion` 에 15초 무응답. 증거가 없어 고치지 않았다. 다시 나오면 조사.
- 그 밖(이전 인계에서 이어짐): `sleep` 은 `until …; do sleep N; done` 을 `run_in_background` 로. 게이트는 시험 파일에도 적용 —
  `runtime.GOOS` 금지. 이 작업 트리에서 다른 세션이 동시에 커밋할 수 있다 — `git add -A` 금지, push 전 `git fetch`.

## 5. 변하지 않는 규약

- `~/.claude/CLAUDE.md` — SDD(IEEE 29148) · TDD(구현 전에 RED) · 최소 구현 · 국소 변경 · 동작 변경은 이전/새/이유 기록.
- **커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다** (사내 규정). 형식 `feat|fix|test|docs(scope): 한국어 요약 (FR-…)`.
- 새 런타임 의존 금지. `platform` 밖 OS 분기 금지(시험 포함). 단일 바이너리.
- 검사: `make all` · `npm run e2e` · `scripts/check-{srs-status,srs-progress,decisions,settings-docs,shortcuts-docs,env-docs,commands-docs,api-docs}.sh` ·
  `go run ./scripts/gen-decisions -check`(`decisions.md` 는 생성물 — `go run ./scripts/gen-decisions` 로 다시 만든다).
- 프로젝트 루트의 스크린샷(`스크린샷 2026-09-27 오후 1.28.01.png`)은 사용자의 것이다 — 커밋하지 않는다.

## 6. 아직 유효한 사용자 결정

- **Orca 방식(C1, 숨긴 headful Chrome)으로 간다** (2026-09-27). 기기의 일반 브라우저로 여는 우회는 거부.
- CI 는 **main 에 push** 해서 돌린다. **CI 와 함께 로컬 e2e 도 돌린다.**
- 에이전트 `open_url` 은 걷었다(비목표 11) · `<select>` 는 base-select.
- 원격의 `dependabot/*` 브랜치 넷은 지우지 않는다.
- 그 밖: `BROWSER_TAB_INVESTIGATION.md` §7 D1~D17, `BROWSER_TAB_SRS.md` §6 D-BRT-1~20.
