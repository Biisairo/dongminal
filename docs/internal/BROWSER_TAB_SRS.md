# SRS: 브라우저 탭 — 서버에서 도는 Chrome 을 탭 안에, 터미널에서 조종한다 — IEEE 29148

> **문서 상태**: 승인·구현완료

| 항목 | 값 |
|---|---|
| 문서 | BROWSER_TAB_SRS |
| 조사·결정 | `BROWSER_TAB_INVESTIGATION.md` (D1~D17 사용자 확정) |
| 선행 | `REQUEST_GATE_ORIGIN_PORT_SRS` (0단계) |
| 대체 | `VIEWER_URL_OPEN_SRS` — 판정·확인 모달·localhost 재작성·`platform.Opener` 를 걷는다 (§3.8) |
| FR 접두 | FR-BRT |

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수:

> 결과적으로 원하는건 브라우저가 **탭 안에** 들어가면서 **터미널에서 브라우저 컨트롤**이
> 가능해지고, 또한 해당 브라우저가 지금 방식처럼 url 만 가져오는 것이 아닌 **실제 서버가
> 열린 기기에서 실행**된다는게 중요한거야.

세 요구를 동시에 만족하는 구조는 하나다 — **서버 기기의 Google Chrome 을 headless 로 띄워
CDP 로 조종하고, 그 화면을 워크스페이스의 탭으로 스트리밍한다.** 사람은 탭에서, 에이전트는
`dmctl browser` 와 CDP 엔드포인트로 **같은 브라우저**를 만진다.

제약: **Go 단일 바이너리**, 외부 의존 최소 — CDP 클라이언트는 쓰는 메서드만 직접 구현한다
(`chromedp`·`cdproto`·Playwright 를 쓰지 않는다).

### 1.2 범위 (Scope) — 단계

| 단계 | 내용 | 끝나는 조건 |
|---|---|---|
| **0** | 요청 게이트 결함 (`REQUEST_GATE_ORIGIN_PORT_SRS`) | 그 문서 §4 통과 |
| **1** | 엔진·수명·프로필·CDP 층, `browser` 탭(스트림·입력·주소창), 여는 위치, 쉘 훅 전환과 옛 방식 제거, 링크 라우팅, scheme, `base-select`, `dmctl browser` 탭·이동·환경, 여러 기기 뷰포트 | §4.1~4.6 통과 |
| **2** | `dmctl browser` 관찰·조작·대기·진단, CDP 프록시 엔드포인트, 외부 도구 페이지의 탭화, 에이전트 동작 오버레이 | §4.7~4.8 통과 |
| **3** | 충실도 — 클립보드·IME 캐럿·JS 대화상자·HTTP 인증·파일 업로드·다운로드·팝업·컨텍스트 메뉴·커서·위젯 재구성·찾기·확대·DevTools·비웹 링크 | §4.9 통과 |
| **4** | 오디오의 뷰어 전송 (PoC 결과에 따라) | §4.10 — PoC 가 실패하면 비목표로 옮기고 이 문서를 개정 |

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **엔진** | 서버 기기에 설치된 Google Chrome 실행 파일 |
| **프로필** | `$DONGMINAL_HOME/browser/profiles/<이름>/` — Chrome 의 `--user-data-dir`. 쿠키·저장소·로그인·기록 |
| **프로필 브라우저** | 프로필 하나를 쓰는 Chrome 프로세스 하나. 쓰이는 프로필마다 하나 |
| **임시 컨텍스트** | 프로필 브라우저 안의 `Target.createBrowserContext`. 디스크에 남지 않는다 |
| **페이지** | CDP `type: "page"` target |
| **브라우저 탭** | `type: 'browser'` 인 dongminal 탭. 페이지 하나에 대응한다 |
| **브라우저 매니저** | 프로필 브라우저들과 페이지↔탭 대응을 소유하는 서버 측 구성 요소. 데몬 모드에서는 데몬에, 직접 모드에서는 웹 서버 프로세스에 산다 |
| **뷰어** | 브라우저 탭을 화면에 그리는 dongminal 클라이언트 |
| **호출 칸** | 탭을 열게 한 도구(`DONGMINAL_TOOL_ID`)가 있는 칸 |
| **CDP 프록시** | dongminal 이 외부 도구에 주는 CDP 엔드포인트 (`/api/browser/<프로필>/cdp`) |

### 1.4 참조 (References)

- `BROWSER_TAB_INVESTIGATION.md` — 레퍼런스 분석·제약 근거·결정 D1~D17
- `REQUEST_GATE_SRS` · `REQUEST_GATE_ORIGIN_PORT_SRS` · `ACCESS_ALLOWLIST_SRS`
- `VIEWER_URL_OPEN_SRS` (대체 대상) · `WORKSPACE_IDENTITY_SRS` (FR-XDF 소유권 · FR-SXE 단일 실행자)
- `SANDBOX_WINDOW_SRS` §3.3 · `FILE_TRANSFER_SRS` · `WINDOW_CLOSE_UNDO_SRS` · `DOC_RENDER_VIEW_SRS`
- 코드: `internal/shared/platform/browser.go` · `process_windows.go:106-182`(Job Object) ·
  `internal/webserver/httpapi/reqgate.go:149-158`(`gateExempt`) · `hub/commands.go:98-131`(`cmdActions`) ·
  `hub/focus.go`(`FocusRegistry`) · `web/js/core/app-layout.js:917`(`paneNavigate`) ·
  `web/js/core/app-docrender.js:147-150`(`splitPaneWithTab` 선례) · `web/js/ui/term-pane.js:177` ·
  `web/js/ui/doc-render.js:71-81·425-428` · `web/js/core/lsp-client.js:367`(`registerEditorOpener`) ·
  `internal/shared/toolipc/protocol.go` · `internal/shared/workspace/manager_parse.go:26`(`WsTab`)

---

## 2. 현재 상태와 검증된 사실

### 2.1 현재 상태

`BROWSER_TAB_INVESTIGATION.md` §2. 요약: URL 은 **뷰어 기기**의 브라우저에서 열린다. 서버
기기에서 실행되는 브라우저도, 브라우저 탭도, 터미널 제어도 없다.

### 2.2 PoC 로 확인한 것 (2026-09-27, macOS · Chrome 153.0.8010.53 · Go 표준 라이브러리만)

| # | 확인 | 결과 |
|---|---|---|
| P1 | `--headless=new --remote-debugging-pipe` + `os/exec.ExtraFiles`(fd3 읽기·fd4 쓰기), NUL 구분 JSON | **동작** — `Browser.getVersion` 응답 |
| P2 | `Page.startScreencast`(jpeg q70) 프레임 수신·ack | **동작** |
| P3 | 네이티브 `<select>` | 포커스만 잡히고 목록이 프레임에 없다 (재현) |
| P4 | `appearance: base-select` 주입 | **동작** — 목록이 프레임에 그려지고, 옵션 좌표 클릭으로 값이 바뀐다. **단, `select, ::picker(select)` 를 한 선택자 목록으로 묶으면 규칙 전체가 무효다** — 규칙을 둘로 나눈다. **문서 시작 시점에 `<style>` 을 붙이면 `head` 가 없어 실패한다** — 격리 world 에서 `adoptedStyleSheets` 로 붙이면 문서 시작부터 적용되고 페이지 DOM 에 흔적이 없다 |
| P5 | `Input.imeSetComposition` ×6 → `Input.insertText("한글")` | **동작** — `compositionstart`·`compositionupdate`(ㅎ→하→한→한ㄱ→한그→한글)·`compositionend` 가 순서대로, 값 `한글` |
| P6 | `Target.openDevTools(targetId)` (headless) | **동작** — `devtools://devtools/bundled/devtools_app.html…` 페이지 target 을 돌려주고, 그 페이지를 screencast 하면 DevTools 전체가 그려진다 |
| P7 | pipe 에서 `Extensions.loadUnpacked` (`--enable-unsafe-extension-debugging`) | **동작** — 확장 id 반환 |
| P8 | Playwright `connectOverCDP` 의 주소 해석 (`playwright-core/lib/server/chromium/chromium.js:343-350`) | `ws…` 는 그대로, `http…` 는 **경로 접두사를 보존한 채** `json/version/` 을 붙인다 |

**미검증 (구현 중 첫 검증)**: Windows 의 pipe(`lpReserved2`) · 오디오 tabCapture · puppeteer
`browserURL` 형태.

### 2.3 제약 (Constraints)

- Chrome 136+ 는 기본 데이터 폴더에서 원격 디버깅을 조용히 무시한다 → 프로필은 언제나 전용 폴더.
- Go `os/exec` 의 `ExtraFiles` 는 Windows 미지원 → `STARTUPINFOW.lpReserved2` 를 채운
  `CreateProcessW` 직접 호출 (`x/sys/windows` — 이미 의존성에 있다).
- `gateExempt`(`reqgate.go:157`)는 **`/api/` 로 시작하지 않고 `/ws` 도 아닌 경로를 정적 자산으로
  보고 게이트를 건너뛴다.** 새 종단은 전부 `/api/` 아래에 둔다 (NFR-BRT-S1).
- 새 런타임 의존을 넣지 않는다 (`gorilla/websocket`·`x/sys`·`x/text`·`creack/pty` 만).

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 E — 엔진과 수명 (1단계)

**FR-BRT-1 (엔진 탐색)** 엔진은 **Google Chrome 만** 쓴다 (D1). OS 별 탐색:

| OS | 순서 |
|---|---|
| Windows | PATH `chrome.exe` → `%ProgramFiles%`·`%ProgramFiles(x86)%`·`%LOCALAPPDATA%` 의 `Google\Chrome\Application\chrome.exe` |
| macOS | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` → `~/Applications/…` 같은 경로 |
| Linux | PATH `google-chrome` → `google-chrome-stable` |

Edge·배포판 `chromium` 은 찾지 않는다. `dongminal window` 의 탐색 체인(`platform.Browser`)은
**바꾸지 않는다** — 그 명령은 이 문서의 범위가 아니다. 탐색은 `platform` 패키지에 둔다
(FR-XPL-3: OS 분기는 `platform_<goos>.go` 만).

**FR-BRT-2 (없을 때)** 엔진이 없으면 브라우저 탭은 **설치를 요구하는 안내**를 그리고, 쉘 훅·
`dmctl browser` 는 같은 문구를 stderr 에 내고 종료 코드 1 로 끝난다. 안내는 OS 별 설치 경로
(공식 다운로드 주소)를 담는다. 다른 브라우저로 대체하지 않는다.

**FR-BRT-3 (최소 버전)** 프로필 브라우저를 띄운 직후 `Browser.getVersion` 으로 주 버전을 읽는다.
**135 미만이면** 그 브라우저를 닫고 FR-BRT-2 와 같은 경로로 "Chrome 업데이트가 필요합니다
(135 이상)" 를 알린다. 근거: `base-select`(FR-BRT-60).

**FR-BRT-4 (기동 인자)** 프로필 브라우저는 아래로만 띄운다.

```
--headless=new --remote-debugging-pipe
--user-data-dir=<프로필 폴더> --no-first-run --no-default-browser-check
--mute-audio            (FR-BRT-90 의 "서버에서 재생" 이 꺼져 있을 때 — 기본)
--disable-blink-features=AutomationControlled   (FR-BRT-93)
```

`--no-sandbox` 를 쓰지 않는다. Linux 에서 root 로 실행 중이면 Chrome 이 샌드박스 없이는 뜨지
않으므로 FR-BRT-2 경로로 "root 에서는 브라우저 탭을 쓸 수 없습니다" 를 알린다.
`--enable-unsafe-extension-debugging`·`--allowlisted-extension-id` 는 `browserAudio=viewer` 일 때만
더한다 (FR-BRT-91).

**FR-BRT-5 (pipe)** CDP 는 **pipe 로만** 잇는다 (D2). 디버깅 포트를 열지 않는다.

- macOS·Linux: `ExtraFiles` 로 fd 3(Chrome 이 읽음)·fd 4(Chrome 이 씀).
- Windows: `STARTUPINFOW.lpReserved2` 에 MSVCRT 형식(개수 `int32` · 플래그 바이트 배열 ·
  `HANDLE` 배열; 0·1·2 는 표준 입출력, 3·4 가 pipe)을 채워 `CreateProcessW` 를 부른다.
  핸들은 상속 가능으로 만들고 부모 쪽 끝은 상속을 끈다. 기존 Job Object 그룹 생성
  (`CREATE_SUSPENDED` → `AssignProcessToJobObject` → 재개, `process_windows.go:106-160`)과
  **같은 경로**로 합친다 — 프로필 브라우저의 자식 트리 전체가 Job 에 든다.
- 메시지는 NUL(`\x00`)로 끝나는 JSON 하나다.

**FR-BRT-6 (정책 차단 감지)** pipe 를 열었는데 15초 안에(결정 ㊾) `Browser.getVersion` 이 답하지 않거나
Chrome 이 즉시 종료하면, 원인 후보로 **엔터프라이즈 정책**(`RemoteDebuggingAllowed`·
`HeadlessMode`)을 함께 알린다. 원인을 단정하지 않는다.

**FR-BRT-7 (수명)** 프로필 브라우저는 **그 프로필의 페이지가 처음 필요해질 때** 뜬다. 그
프로필의 페이지가 하나도 없으면(닫혔거나 아직 불러오지 않음) 종료한다. 브라우저 매니저가
끝나면(데몬 종료) pipe 가 닫히고 Chrome 은 끝난다 — Job Object·프로세스 그룹이 잔여를
거둔다. 비정상 종료한 프로필 브라우저는 **다음에 필요해질 때** 다시 띄운다 (자동 재시작 루프를
돌지 않는다).

**FR-BRT-8 (소유 자리)** 브라우저 매니저는 **데몬 모드에서는 데몬(`dongminald`)** 이 소유한다
— PTY 와 같은 자리이며 웹 서버 재시작을 넘긴다. 직접 모드에서는 웹 서버 프로세스가 소유한다
(`toolhub` 와 같은 이중 실행). 웹 서버↔데몬 사이는 `toolipc` 에 브라우저용 메서드·이벤트를
더하고 `hello.features` 에 기능 이름을 싣는다. 그 기능이 없는 데몬(옛 판)과 붙으면 브라우저
탭은 "데몬을 다시 시작하세요" 를 안내한다.

**FR-BRT-92 (UA 의 headless 표식)** 페이지가 보내는 User-Agent 와 `navigator.userAgent` 에는
`HeadlessChrome` 이 **없다** — 같은 판의 Chrome 이 내는 `Chrome/<판>` 이다. 기동 때
`Browser.getVersion` 의 `userAgent` 에서 그 한 낱말만 바꾸고, 페이지·iframe·worker 가 멈춘 채
붙을 때 **풀기 전에** 건다 — 첫 요청부터 바뀐 값이 나간다. 판 번호·OS 는 그대로다. UA 만 덮으면
Chrome 이 Client Hints(`Sec-CH-UA`·`navigator.userAgentData`)를 비우므로(실측) 기동 때 Chrome
자신의 값을 `chrome://version/`(보안 문맥)에서 읽어 함께 건다 — 자동 붙기 전, 버리는 컨텍스트
에서 읽으므로 탭이 되지 않는다. 그 값을 못 읽으면 덮지 않는다(종전 UA). 봇 차단(Cloudflare 등)이
headless 표식만으로 막는 것을 피하려는 것이고, 차단 우회를 약속하지는 않는다 (D-BRT-20).

**FR-BRT-93 (`navigator.webdriver`)** 페이지와 iframe(교차 출처 포함)의 `navigator.webdriver` 는
`false` 다. Chrome 은 `--headless`·`--remote-debugging-pipe` 중 하나만 있어도 이 값을 `true` 로
두므로(Chromium `content/child/runtime_features.cc`; headful + pipe 도 `true`, 실측) 기동 인자에
`--disable-blink-features=AutomationControlled` 를 더한다 — 그 파일에서 이 스위치가 앞의 판정보다
뒤에 적용된다. headless·pipe 는 그대로다(FR-BRT-4·5). 차단 우회를 약속하지는 않는다 (D-BRT-21).

### 3.2 묶음 P — 프로필 (1단계)

**FR-BRT-10** 프로필은 `$DONGMINAL_HOME/browser/profiles/<이름>/` 이다. **폴더 목록이 곧 프로필
목록**이다 (별도 목록 파일을 두지 않는다 — 두 벌이면 한쪽만 고쳐진다). 이름은
`[a-z0-9][a-z0-9_-]{0,31}` 이다.

**FR-BRT-11** `default` 는 언제나 있다. 없으면 만든다. 삭제할 수 없다.

**FR-BRT-12 (설정 UI)** 설정 화면에 "브라우저 프로필" 항목을 둔다 — 목록·추가·삭제. 추가·삭제는
서버 API(`/api/browser/profiles`)가 한다. 설정 값 저장소(`settings.json`)에 목록을 두지 않는다.

**FR-BRT-13 (삭제)** 사용 중인 프로필을 지우면 확인 한 번(`CONFIRM_ONE_STAGE_SRS`) 뒤에 그
프로필의 브라우저 탭을 닫고, 프로필 브라우저를 끝내고, 폴더를 지운다.

**FR-BRT-14 (새 탭의 프로필)** 설정 `browser.defaultProfile`(기본 `default`)을 쓴다.
`dmctl browser open --profile <이름>` 이 덮는다. 페이지가 연 탭은 연 탭의 프로필을 따른다.

**FR-BRT-15 (임시 컨텍스트)** `dmctl browser open --isolated` 는 그 프로필 브라우저에
`Target.createBrowserContext` 로 컨텍스트를 만들어 연다. 그 컨텍스트의 마지막 페이지가 닫히면
`Target.disposeBrowserContext` 한다. 탭에 "임시" 배지를 단다. 기본 프로필이 아닌 탭에는 프로필
배지를 단다.

**FR-BRT-16** 동시에 여러 프로필을 쓸 수 있다 (D3). 프로필마다 프로필 브라우저·pipe·CDP 프록시
주소가 따로다.

### 3.3 묶음 C — CDP 층 (1·2단계)

**FR-BRT-20 (클라이언트)** CDP 클라이언트는 표준 라이브러리로 짓는다. 요청 id 상관·flat
세션(`sessionId`)·이벤트 구독·요청별 제한 시간을 갖는다. 쓰는 메서드만 타입을 둔다.

**FR-BRT-21 (다중화)** pipe 하나에 매니저 자신과 외부 CDP 클라이언트 N 개가 함께 탄다. 매니저는
**클라이언트마다 요청 id 를 다시 매기고**, 응답은 요청한 클라이언트에만 보낸다. 세션 이벤트는
그 세션을 붙인 클라이언트에, 브라우저 수준 이벤트(`Target.*` 등)는 그것을 켠 클라이언트에 보낸다.

**FR-BRT-22 (CDP 프록시, 2단계)** 외부 도구용 종단:

```
GET  /api/browser/<프로필>/cdp/json/version     → {"webSocketDebuggerUrl": "ws://<Host>/api/browser/<프로필>/cdp/ws", …}
WS   /api/browser/<프로필>/cdp/ws               → 브라우저 수준 CDP
```

`dmctl browser cdp-url [--profile <이름>]` 이 **WS 주소**를 출력한다. 호출한 도구가 있으면
`?tool=<DONGMINAL_TOOL_ID>` 를 붙인다(FR-BRT-44). 접근 범위는 다른 API 와 같다 — `accessGate` +
`requestGate` (D9).

**FR-BRT-23 (Origin 거부)** CDP 프록시 WS 는 **`Origin` 헤더가 있으면 거부**한다(403). 브라우저에서
온 연결에는 언제나 `Origin` 이 있고 CDP 도구는 싣지 않는다. 단 하나의 예외는 FR-BRT-84 의
DevTools 페이지(`devtools://devtools`)다 — 웹 페이지가 만들 수 없는 출처다.

**FR-BRT-24 (거절 메서드)** 외부 클라이언트의 아래 요청은 오류로 답하고 Chrome 에 보내지 않는다.

| 메서드 | 이유 |
|---|---|
| `Browser.close` · `Browser.crash` · `Browser.crashGpuProcess` | 수명은 매니저가 소유한다 |
| `Browser.setDownloadBehavior` | FR-BRT-80 의 다운로드 경로를 덮는다 |
| `Page.setInterceptFileChooserDialog` 의 `enabled:false` | FR-BRT-81 을 끈다 |
| 남이 만든 컨텍스트의 `Target.disposeBrowserContext` | 다른 클라이언트의 임시 탭을 없앤다 |

### 3.4 묶음 T — 탭과 페이지 (1·2단계)

**FR-BRT-30 (탭 스키마)** 새 탭 타입 `browser`(`TAB_TYPE_BROWSER`). 탭 필드(`workspace.json`,
프론트 소유 — 기존 관례):

| 필드 | 뜻 |
|---|---|
| `url` | 마지막으로 확정된 주소 (복원의 근거) |
| `name` | 페이지 제목 (NAME_SOURCE 규약을 따른다) |
| `profile` | 프로필 이름 |
| `isolated` | 임시 컨텍스트 여부 |
| `viewport` | 고정 크기 `{w,h}` 또는 없음 (FR-BRT-52) |
| `popup` | 페이지가 크기를 지정해 연 창인가 (FR-BRT-42) |
| `devtoolsOf` | DevTools 탭이면 대상 탭 id (FR-BRT-84) |

서버가 탭 없이 복원하고 `dmctl` 이 탭을 찾을 수 있도록 `WsTab`(`manager_parse.go:26`)이
`type`·`url`·`profile`·`isolated` 를 읽는다. 스키마 버전을 올리지 않는다 — 필드가 없던 파일의
뜻이 그대로이기 때문이다(`Sandbox` 필드 선례).

**FR-BRT-31 (대응)** 브라우저 탭 하나 = 페이지 하나. 매니저가 탭 uuid ↔ `targetId` 를 메모리에
든다. 대응은 **Chrome 의 페이지 목록과 dongminal 의 탭 목록이 같다**를 불변식으로 한다.
`type: "page"` 만 탭이 된다 — service worker·background page·`browser_ui` 는 아니다.
DevTools 페이지는 FR-BRT-84 로만 탭이 된다.

**FR-BRT-32 (여는 위치 — 터미널에서 열 때)** 설정 `browser.openPlacement`:

| 값 | 동작 |
|---|---|
| `split` (기본) | 호출 칸에서 `paneNavigate('right')` 의 규칙(가로 분할을 거슬러 올라가 다음 형제의 `firstPane`)으로 **도착하는 칸이 있으면 그 칸에 새 탭**, 없으면 호출 칸을 `splitPaneWithTab(…,'right')` 로 나눠 연다 |
| `tab` | 호출 칸에 새 탭 |

기존 탭을 재사용하지 않는다. 그 칸에 어떤 탭이 있는지 보지 않는다. **창 경계를 넘지 않는다**
(`slotNavigate` 로 넘어가지 않는다). `_paneSiblingOf`(`app-docrender.js:189`)는 쓰지 않는다 —
방향을 보지 않고 이전 형제로도 가기 때문이다. `dmctl browser open --split right|down|none` 이
설정을 덮는다. 호출 칸이 없으면(UI·도구 밖 `dmctl`) 그 창의 포커스 칸을 호출 칸으로 쓴다.

**FR-BRT-33 (여는 위치 — 브라우저 안에서 열 때)** 페이지가 연 새 페이지(`target=_blank`·
`window.open`·Ctrl/⌘/가운데 클릭)는 설정과 무관하게 **연 탭의 칸, 연 탭 바로 뒤**에 연다.
포커스는 Chrome 관례를 따른다 — 일반 클릭·`window.open` 은 앞으로, Ctrl/⌘/가운데 클릭은 뒤에.
판별 근거는 `Target.targetCreated` 의 `openerId` 다.

**FR-BRT-34 (포커스)** 쉘 훅(FR-BRT-70)으로 연 탭은 포커스를 옮긴다. `dmctl browser open` 은
기본으로 옮기지 않고 `--focus` 가 옮긴다. 외부 도구가 만든 페이지(FR-BRT-44)는 옮기지 않는다.

**FR-BRT-35 (단일 실행)** 서버가 탭을 만들게 하는 액션(`openBrowserTab`)은 `cmdActions` 에
`creating: true, single: true` 로 둔다 — 탭 uuid 를 `dmctl` 에 돌려주고(reqId 에코), 여러 기기
중 한 곳에서만 배치한다.

**FR-BRT-36 (뷰어가 없을 때)** 페이지는 **뷰어 유무와 무관하게 즉시** 만든다 — `claude login`
같은 흐름은 페이지가 떠야 진행한다. 배치할 클라이언트가 없으면 매니저가 "배치 대기" 로 들고,
클라이언트가 붙으면 FR-BRT-32 규칙(기록해 둔 호출 도구 기준)으로 배치한다.

**FR-BRT-37 (닫기)** 탭 닫기 → `Target.closeTarget`. 페이지가 닫힘(`window.close`·외부 도구의
`page.close()`) → 탭 닫기. 닫기 되돌리기(`WINDOW_CLOSE_UNDO_SRS`)는 URL 로 다시 연다.

**FR-BRT-38 (크래시)** `Inspector.targetCrashed` → 탭을 닫지 않고 "페이지가 멈췄습니다 ·
새로고침" 을 덮는다. 프로필 브라우저 전체가 끝나면 그 프로필의 탭에 같은 안내를 덮고, 다음에
보일 때 FR-BRT-7 로 다시 띄운다.

**FR-BRT-39 (지연 복원)** 데몬 재시작·재부팅 뒤 브라우저 탭은 저장된 `name` 으로 즉시 그려지고,
페이지는 **처음 보일 때**(어느 뷰어에서든 그 탭이 화면에 나타날 때) 또는 `dmctl`·CDP 가 그 탭을
가리킬 때 `url` 로 만든다. 임시 탭은 **새 임시 컨텍스트**에서 연다. 뒤로/앞으로 기록·폼 입력·
스크롤은 복원하지 않는다 (CDP 에 기록을 심는 API 가 없다).

**FR-BRT-40 (보지 않는 탭)** 어느 뷰어에도 보이지 않는 탭은 screencast 만 멈춘다. 페이지는
계속 실행된다. 다시 보이면 `Page.captureScreenshot` 한 장을 먼저 보내고 screencast 를 재개한다.

**FR-BRT-41 (탭 UI)** 브라우저 탭은 위에서부터 도구 막대(뒤로·앞으로·새로고침/중지·주소창·
프로필/임시 배지·메뉴), 화면(canvas), 아래 다운로드 줄(FR-BRT-80)로 선다. 주소창은 입력이
URL·경로가 아니면 거절 안내를 낸다(검색 엔진 연동은 비목표).

**FR-BRT-42 (팝업)** 크기를 지정한 `window.open`(OAuth 류)도 탭으로 열고 "팝업" 표시를 단다.
`window.opener` 관계는 Chrome 안에서 유지된다.

**FR-BRT-43 (샌드박스 창)** 샌드박스 창에 연 브라우저 탭도 호스트에서 호스트 네트워크로 돈다.
탭에 그 사실을 표시한다 (`SANDBOX_WINDOW_SRS` §3.3 의 격리 등급과 별개임을 드러낸다).

**FR-BRT-44 (외부 도구의 페이지, 2단계)** CDP 프록시로 만들어진 페이지(`Target.createTarget`,
Playwright `newPage()`)도 탭이 된다. 위치는 FR-BRT-32 이며 호출 칸은 연결 주소의 `tool` 값으로
정한다. 없으면 포커스 칸. 새 `browserContext` 의 페이지는 "임시" 배지를 단다.

### 3.5 묶음 V — 화면과 입력 (1단계)

**FR-BRT-50 (스트림 종단)** 뷰어는 `WS /api/browser/stream?tab=<uuid>` 로 붙는다(게이트 아래,
NFR-BRT-S1). 서버→뷰어는 바이너리 프레임(JPEG) + 텍스트 이벤트(제목·URL·로딩·커서·다운로드
등), 뷰어→서버는 입력·명령 JSON 이다. 한 페이지의 screencast 는 **하나**이며 붙은 뷰어 전부에
같은 프레임을 보낸다. 느린 뷰어는 **최신 프레임만** 받는다(밀린 프레임을 쌓지 않는다). 매니저는
`Page.screencastFrameAck` 를 보내 Chrome 의 속도를 조절한다.

**FR-BRT-94 (뷰어의 받음 확인)** `ack=1` 로 붙은 뷰어는 받은 프레임마다(그렸든 버렸든) `{op:"frameAck"}` 를
보낸다. 서버는 그 뷰어에게 **확인받지 못한 프레임을 2장까지만** 내보낸다 — 넘으면 최신 한 장만 들고
확인을 기다린다. 링크가 좁을 때 프레임이 TCP 에 쌓여 입력의 결과가 그 뒤로 밀리던 것을 막는다.
`ack=1` 이 없는 뷰어(옛 판)는 종전대로 받는다.

**FR-BRT-95 (화질 적응)** 탭의 screencast JPEG 품질은 40~70(기본 70), 10 단위다. 확인을 기다리느라
프레임을 들고 있었던 1초에 그 뷰어에게 보낸 프레임이 **30장 미만**이면, 직전 변경에서 1초가 지났을 때
품질을 10 내린다. 어느 뷰어도 5초 동안 기다리지 않았고 직전 변경에서 5초가 지났으면 10 올린다. 해상도·
`everyNthFrame` 은 바꾸지 않는다. 탭의 첫 뷰어가 붙으면 70 에서 시작한다. 매니저 조작은
`quality {tab, q}` — 범위 밖은 가장자리로 자르고, 보고 있는 중에 바뀌면 screencast 를 다시 켠다 (D-BRT-22).

**FR-BRT-51 (뷰포트 소유)** 뷰포트(CSS 폭·높이·DPR)는 그 탭이 속한 **창의 주인**(FR-XDF,
`FocusRegistry.owners`)이 정한다. 매니저가 `Emulation.setDeviceMetricsOverride` 로 적용한다.
주인이 아닌 뷰어는 같은 프레임을 비율 유지·여백으로 그리고 터미널과 같이 dim 한다. 주인이 아닌
뷰어가 브라우저 탭에 입력하면 기존 규칙대로 주인이 된다. **`dmctl`·CDP 의 조작은 주인을 바꾸지
않는다.**

**FR-BRT-52 (고정 크기)** `dmctl browser viewport <W>x<H>|auto` 와 탭 메뉴가 탭을 고정 크기로
바꾼다. 고정 중에는 FR-BRT-51 을 적용하지 않고 모든 뷰어가 축소해 그린다.

**FR-BRT-53 (마우스·휠·터치)** `Input.dispatchMouseEvent`(이동·누름·뗌·`clickCount`·`buttons`)와
`mouseWheel`(픽셀 델타) 로 보낸다. 좌표는 뷰어가 페이지 CSS 좌표로 환산해 보낸다. 터치 기기는
탭→클릭, 끌기→휠로 옮긴다.

**FR-BRT-54 (키)** `Input.dispatchKeyEvent` 에 `type`·`key`·`code`·`windowsVirtualKeyCode`·`text`·
`unmodifiedText`·`location`·`modifiers`·`autoRepeat` 를 채운다. 뷰어의 `Mod` 는 **서버 OS 가 쓰는
쪽**으로 바꾼다 (Mac 뷰어 → Windows 서버: ⌘ → Ctrl). 서버가 macOS 면 편집 명령(`selectAll`·
`copy`·`paste`·`cut`·`undo`·`redo`)을 `commands` 로 함께 보낸다.

**FR-BRT-55 (텍스트 입력과 IME)** 뷰어는 화면 위에 숨긴 textarea 를 두고 `composition*` 을 받는다.
조합 중에는 `Input.imeSetComposition`, 확정·일반 문자 입력은 `Input.insertText` (P5 로 확인).
1단계의 textarea 위치는 화면 왼쪽 위다 — 캐럿 추적은 3단계(FR-BRT-71).

**FR-BRT-56 (키 배분)** 브라우저 탭에 포커스가 있을 때:

1. dongminal 전역 단축키(사용자 설정 포함) — 터미널 탭과 같다
2. 브라우저 탭 UI 단축키 — 기본값 `Mod+L` 주소창 · `Mod+R`/`F5` 새로고침 · `Mod+Shift+R` 강력
   새로고침 · `Mod+[`·`Alt+ArrowLeft` 뒤로 · `Mod+]`·`Alt+ArrowRight` 앞으로 · `Mod+=`/`Mod+-`/
   `Mod+0` 확대 · (3단계) `Mod+F` 찾기 · `F12`/`Mod+Alt+KeyI` DevTools. **단축키 표(`SHORTCUT_DEFAULTS`)
   에 들어가 사용자가 바꿀 수 있다.** 뷰어에서 `preventDefault` 해 dongminal 페이지 자체의
   새로고침을 막는다
3. 나머지는 페이지로

뷰어 브라우저가 가져가는 `Mod+W`·`Mod+T`·`Mod+N`·`Mod+Q` 는 받을 수 없다 — 문서에 명시한다.

**FR-BRT-57 (확대)** 브라우저 확대는 CSS 뷰포트를 `1/z` 로 줄이고 DPR 을 `z` 배로 올려 구현한다
(CDP 에 줌 API 가 없다). 탭별로 기억한다.

**FR-BRT-58 (주소창·이동)** `Page.navigate`·`Page.reload(ignoreCache)`·`Page.getNavigationHistory`
+`navigateToHistoryEntry` 로 뒤로/앞으로. `Page.frameNavigated`(최상위)가 `url` 을 갱신한다.

**FR-BRT-96 (Chrome 에 로그인)** 탭 메뉴의 "Chrome 에 로그인" 은 그 탭을 `chrome://settings/people`
로 옮긴다(`nav` 의 `signin`). 사용자는 그 페이지의 "Chrome 에 로그인" 을 누르고, Chrome 이 여는
Google 로그인 페이지(새 탭)에서 계정으로 로그인한다 — 그 프로필 브라우저가 그 계정의 Chrome 프로필이
된다. 이 한 주소만 FR-BRT-65 의 예외다 — 사용자가 적은 주소가 아니라 고정 값이다 (D-BRT-23).

**FR-BRT-60 (`<select>`, D6 1단계)** 모든 문서에 격리 world(`Page.addScriptToEvaluateOnNewDocument`
의 `worldName`, `runImmediately`)로 **두 규칙**을 `adoptedStyleSheets` 에 붙인다.

```css
select { appearance: base-select }
::picker(select) { appearance: base-select }
```

한 선택자 목록으로 묶지 않는다(P4 — 규칙 전체가 무효가 된다). `<style>` 요소로 붙이지 않는다
(P4 — 문서 시작 시점에 `head` 가 없다).

### 3.6 묶음 S — scheme (1단계)

**FR-BRT-65** 주소창·`dmctl browser open/goto`·쉘 훅·링크 클릭이 여는 주소는 `http`·`https`·
`file`·`about:blank` 만 허용한다 (D8). 그 밖(`chrome:`·`devtools:`·`chrome-extension:`·
`javascript:`·`data:` 등)은 거절하고 이유를 알린다. 페이지 안에서 일어나는 이동은 Chrome 의
규칙을 따른다.

**FR-BRT-66** `dmctl browser open` 과 쉘 훅은 URL 이 아닌 인자를 **경로**로 읽는다 — 호출한
셸의 cwd 기준으로 절대 경로로 풀고 `file://` URL 로 바꾼다(Windows `C:\a\b.html` →
`file:///C:/a/b.html`). 없는 경로는 거절한다.

**FR-BRT-67 (비웹 링크, 3단계)** 페이지 안의 `mailto:`·`tel:`·그 밖의 등록 scheme 링크 클릭은
격리 world 가 감지해 뷰어에 "이 기기에서 열기" 확인을 띄운다. 1·2단계에서는 아무 일도
일어나지 않는다(headless 의 기본 동작).

### 3.7 묶음 L — 링크 라우팅 (1단계)

**FR-BRT-68** dongminal 화면의 링크 클릭은 설정 `browser.linkTarget`(`internal` 기본 · `viewer`)을
따른다. 수정키(⌘⇧ / Ctrl+Shift) + 클릭은 반대로 연다. 대상:

| 출처 | 자리 |
|---|---|
| 터미널 링크 | `term-pane.js:177` 의 `WebLinksAddon` 콜백 |
| 문서 렌더 링크 | `doc-render.js` `_onLinkClick` — http(s) 도 가로챈다 (지금은 통과시킨다 `:428`) |
| 편집기 URL (Monaco ⌘/Ctrl-클릭) | `monaco.editor.registerLinkOpener` — ⌘⇧/Ctrl+Shift 가 반대 |
| 업데이트 배지 | `index.html:247` |

`viewer` 로 열 때는 클릭 핸들러 안에서 `window.open(url,'_blank')` 한다(제스처 안).
**브라우저 탭 안의 클릭은 이 규칙의 대상이 아니다** — 키와 클릭은 페이지로 간다(FR-BRT-56).

**FR-BRT-69** 프로그램이 여는 URL(쉘 훅 FR-BRT-70)은 설정과 무관하게
**언제나 브라우저 탭**으로 연다.

### 3.8 묶음 H — 쉘 훅 전환과 옛 방식 제거 (1단계)

**FR-BRT-70 (훅 전환)** 진입점은 그대로 둔다 — `BROWSER=$DONGMINAL_HOME/bin/open-url`,
bash/zsh 의 `open`/`xdg-open` 함수(http/https 한 개 인자만), `dmctl open-url`. 셋 다
`dmctl browser open <url>` 과 **같은 코드 경로**로 브라우저 탭을 연다(호출 칸 = 호출 도구,
포커스 이동). 에이전트 프로토콜의 `open_url` 은 다루지 않는다 (비목표 11, 결정 ㊹).

**FR-BRT-71 (제거)** 다음을 걷는다. 걷은 뒤 쓰이지 않게 되는 코드·키·스타일·시험도 함께 걷는다.

| 대상 | 자리 |
|---|---|
| 뷰어 판정·`DONGMINAL_URL_OPEN`·`/api/open-url/where` | `internal/webserver/httpapi/openurl.go`, `commands.go:217` 분기 |
| `openUrl` 액션 | `hub/commands.go:124`, `web/js/core/app-cmd.js:36` |
| 확인 모달·localhost 재작성 | `web/js/ui/open-url.js`, `openurl.*` i18n 키, `.openurl-*` CSS, `index.html` 의 스크립트 |
| 로컬 실행 | `runtimebin/openurl.go` 의 `systemOpenURL`·`openHere` |
| `platform.Opener` | `platform/opener.go`(+시험), `Platform.Opener` 필드, `platform_*.go` 배선 |
| 문서 | `DONGMINAL_URL_OPEN` 환경 변수 문서, 사용자 문서의 open-url 설명 |

`VIEWER_URL_OPEN_SRS` 의 상태를 `대체` 로 바꾸고 이 문서를 가리킨다. `platform.Browser`
(`dongminal window`) 는 남긴다.

**동작 변경 기록**

| | |
|---|---|
| 이전 | 쉘이 연 URL 은 뷰어가 서버와 같은 기기면 그 기기의 기본 브라우저, 원격이면 확인 모달 뒤 뷰어 브라우저 |
| 새 | 언제나 서버 기기의 Chrome 에서 도는 브라우저 탭 |
| 이유 | 사용자 요구 — 서버 기기에서 실행되는 것이 핵심 (§1.1). `localhost` 콜백이 서버로 돌아온다 |

### 3.9 묶음 A — 터미널 제어 `dmctl browser` (1·2단계)

**FR-BRT-75 (명령)**

| 단계 | 명령 |
|---|---|
| 1 | `open <url\|path> [--profile P] [--isolated] [--split right\|down\|none] [--focus]` · `list` · `close` · `focus` · `goto <url>` · `back` · `forward` · `reload [--hard]` · `viewport <W>x<H>\|auto` · `profile list` |
| 2 | `snapshot [--dom]` · `screenshot [--full] [-o 파일]` · `url` · `title` · `click <ref>` · `fill <ref> <text>` · `type <text>` · `press <key>` · `select <ref> <value>` · `hover <ref>` · `scroll <up\|down\|ref>` · `upload <ref> <서버 경로>` · `wait --text T \| --ref R \| --url GLOB \| --load [--timeout D]` · `eval <js>` · `console [--limit N]` · `network [--limit N]` · `downloads` · `devtools [--panel P]`(3단계) · `cdp-url [--profile P]` |

대상 탭은 `--tab <uuid>` 로 지정한다. 없으면 **호출 도구가 마지막으로 열거나 다룬 브라우저
탭**이다. 좌표 라벨은 받지 않는다(FR-IDU-9 관례).

**FR-BRT-76 (실행 방식)** 조작은 **신뢰 입력**이다 — 요소의 `backendNodeId` → `DOM.scrollIntoViewIfNeeded`
→ `DOM.getContentQuads` 중심 → `Input.*`. 조작 전에 **actionability** 를 기다린다: 붙어 있음 ·
보임 · 위치 안정(연속 두 프레임) · 활성 · 그 좌표의 hit-test 가 그 요소(또는 자손). 제한 시간
(기본 10초)을 넘으면 이유를 담아 실패한다. `fill` 은 선택 후 `Input.insertText`, `select` 는
`<select>` 에 값을 넣고 `input`·`change` 를 일으킨다. 교차 출처 iframe 은 `Target.setAutoAttach`
의 프레임 세션으로 다룬다.

**FR-BRT-77 (snapshot)** 기본은 접근성 트리(`Accessibility.getFullAXTree`)를 들여쓴 목록으로
낸다 — `- <role> "<name>" [ref=eN] [상태…]` (Playwright MCP 와 같은 모양). `--dom` 은 격리 world
에서 DOM 을 걸어 상호작용 후보(접근성 정보가 없는 `onclick`·`cursor:pointer` 포함)에 번호를 붙이고
스크롤 힌트를 머리말로 둔다 (browser-use `buildDomTree` 의 판정을 따르며 출처를 적는다 — MIT).
ref 는 `backendNodeId` 에 매이고 **이동·문서 교체 뒤 무효**다 — 무효 ref 는 "다시 snapshot"
오류다. 교차 출처 iframe 의 요소도 ref 를 받는다.

**FR-BRT-78 (출력)** 기본은 사람이 읽는 텍스트, `--json` 은 기계용. 종료 코드 0 성공 · 1 동작
실패(요소 없음·시간 초과·엔진 없음) · 2 사용법 오류. `screenshot` 은 파일로 쓰고 경로를 낸다.

**FR-BRT-79 (오버레이, 2단계)** `click`·`fill`·`hover`·`select` 가 돌 때 뷰어 탭 위(페이지 DOM 이
아닌 dongminal 오버레이)에 커서와 대상 강조를 잠깐 그린다.

### 3.10 묶음 F — 파일 (3단계)

**FR-BRT-80 (다운로드)** `Browser.setDownloadBehavior(allowAndName → 이름 복원, eventsEnabled)` 로
**서버에만** 저장한다 (D16). 저장 폴더는 설정 `browserDownloadDir`(기본: 서버의 `~/Downloads`).
받는 동안은 프로필 폴더 안의 대기 폴더에 두고, 끝날 때 **그때의** 설정 폴더로 옮긴다 (결정 ⑲).
진행·완료를 다운로드 줄에 보이고, 완료 항목에는 "탐색기에서 보기" 만 둔다. 뷰어로 보내지 않는다 —
필요하면 기존 download 기능으로 받는다. `dmctl browser downloads` 가 목록과 경로를 낸다.

**FR-BRT-81 (업로드)** `Page.setInterceptFileChooserDialog(true)` → `Page.fileChooserOpened` 에서
뷰어에 **서버 파일 선택 창**(서버 폴더 목록 모달, `multiple` 존중 — 결정 ㉑)을 띄우고 고른 경로를
`DOM.setFileInputFiles` 로 넘긴다 (D17). 뷰어 기기의 파일은 다루지 않는다 — 먼저 기존 업로드로
서버에 올린다. 취소하면 빈 목록을 넘긴다.

### 3.11 묶음 Q — 충실도 (3단계)

**FR-BRT-82 (클립보드)** 페이지에서의 복사(격리 world 의 `copy`/`cut` 리스너 + 선택 텍스트)는
뷰어 클립보드에 쓴다. 뷰어에서의 붙여넣기(`paste` 이벤트의 텍스트)는 `Input.insertText` 로 넣는다.
터미널의 클립보드 동작과 같은 규약(`term-clipboard.js`)을 쓴다.

**FR-BRT-83 (IME 캐럿)** 숨긴 textarea 를 페이지의 캐럿 좌표(격리 world 가 보고)로 옮겨 후보창이
제자리에 뜨게 한다.

**FR-BRT-84 (DevTools, D15)** `Target.openDevTools(targetId, panelId?)` 가 돌려준 페이지를 탭으로
연다 — `devtoolsOf` = 대상 탭, 위치 FR-BRT-32(호출 칸 = 대상 탭의 칸), 제목 "DevTools · <대상
제목>". 대상 탭이 닫히면 함께 닫는다. 그 페이지는 Chrome 안에서 대상에 붙으므로 CDP 프록시를
지나지 않는다 — FR-BRT-23 의 예외는 없다 (결정 ⑮).

**FR-BRT-85 (대화상자)** `Page.javascriptDialogOpening`(alert·confirm·prompt·beforeunload) →
뷰어 모달 → `Page.handleJavaScriptDialog`. 한 대화상자에 답은 한 번이다(중복 답은 첫 답을 따른다).
에이전트가 조작 중이면 `dmctl browser` 가 그 사실을 오류로 알린다(`--accept`/`--dismiss` 옵션).

**FR-BRT-86 (HTTP 인증)** `Fetch.authRequired` → 뷰어 프롬프트 → `Fetch.continueWithAuth`. 먼저
**모든 요청을 멈추지 않고 인증만 받는** `Fetch.enable(handleAuthRequests:true, patterns:…)` 구성이
가능한지 검증한다(미검증). 모든 요청을 멈춰야만 한다면 지연을 측정해 기록하고, NFR-BRT-P1 을 어기면
이 FR 을 비목표로 옮겨 이 문서를 개정한다.

**FR-BRT-87 (컨텍스트 메뉴)** 우클릭은 먼저 페이지로 간다. 페이지가 `preventDefault` 하지 않았으면
(격리 world 가 보고) dongminal 메뉴를 띄운다 — 뒤로·앞으로·새로고침 · 링크 복사·새 탭에서 열기·
**이 기기에서 열기** · 이미지 복사 · 선택 복사 · 검사(FR-BRT-84).

**FR-BRT-88 (커서·툴팁·위젯)** 격리 world 가 보고한다 — 계산된 `cursor`(canvas 에 반영), `title`
툴팁, 검증 말풍선(`invalid`), `<input type=date|time|datetime-local|month|week|color>` 와
`<datalist>` 가 열리려는 순간. 뷰어는 캔버스 위 같은 자리에 **자기 기기의 입력 요소**(가능하면
`showPicker()`) 또는 자체 목록을 띄우고, 고른 값을 격리 world 의 함수(`Runtime.evaluate`, 결정 ㉒)로 넣은 뒤 `input`·
`change` 를 일으킨다. 네이티브 팝업은 열리지 않게 막는다. `<select>` 는 이 방식으로 옮기지 않는다 — FR-BRT-60 의 `base-select` 로 확정한다 (결정 ㊺).

**FR-BRT-89 (찾기)** `Mod+F`(고정 키, 결정 ㊵)는 탭의 찾기 막대를 연다. 격리 world 가 CSS Custom
Highlight 로 칠하고 다음/이전으로 스크롤한다. 교차 출처 iframe 안은 찾지 않는다 — 막대의 ⓘ 가 그 한계를
알린다.

### 3.12 묶음 U — 소리 (1·4단계)

**FR-BRT-90** 기본은 **소리 끔**(`--mute-audio`) (D14). 설정 `browserAudio` 는 `off`(기본)·`server`·
`viewer` 셋이다 — `server` 는 `--mute-audio` 없이 서버 스피커로 내고, `viewer` 는 FR-BRT-91 이다. CDP 에 탭
단위 음소거가 없으므로 값은 **프로필 브라우저를 다음에 띄울 때** 적용된다 — 설정 설명에 그렇게 적는다.
(개정: 1단계의 `browserServerAudio` 켬/끔을 이 셋으로 바꾼다 — 출시 전이라 옮길 값이 없다.)

**FR-BRT-91 (4단계, 뷰어로 소리)** `browserAudio=viewer` 면 소리를 **보고 있는 기기**로 보낸다.

1. **확장**: 매니저가 내장 확장(고정 `key` → 고정 ID)을 `<Home>/browser/audio-ext/` 에 쓰고, 기동 인자에
   `--enable-unsafe-extension-debugging`·`--allowlisted-extension-id=<ID>` 를 더한 뒤(`--mute-audio` 는
   유지한다 — 음소거여도 캡처된다, 실측) `Extensions.loadUnpacked` 로 싣는다. allowlist 가 있으면
   `chrome.tabCapture.getMediaStreamId` 가 사용자의 확장 호출 없이 된다(실측, Chrome 153). 확장은
   offscreen 문서에서 탭 소리를 받는다. 확장은 페이지 main world·격리 world 어느 것에도 스크립트를
   넣지 않는다.
2. **신호**: 뷰어 WS 의 `{op:'audio', action:'offer'}` → 매니저가 offscreen 문서에서 그 탭의 소리로
   `RTCPeerConnection` 을 만들고 ICE 수집이 끝난 offer 를 돌려준다 → 서버가 그 뷰어에게만
   `{t:'audio', info:{peer, sdp}}` 로 보낸다 → 뷰어의 `{op:'audio', action:'answer', peer, sdp}` →
   연결. `{action:'stop', peer}` 로 끝낸다. 뷰어 WS 가 끊기면 서버가 그 뷰어의 peer 를 모두 끝낸다.
   trickle 없이 한 번에 주고받고, STUN·TURN 을 쓰지 않는다(외부 서버에 닿지 않는다) — 뷰어가 서버에
   **UDP 로 직접** 닿아야 한다(같은 LAN·VPN). 닿지 못하면 소리 없이 탭은 그대로 돈다.
3. **뷰어**: 설정이 `viewer` 이고 탭이 **보이는** 동안만 받는다 — 숨기면 끝낸다. 재생이 자동 재생
   정책에 막히면 다음 입력(포인터·키) 때 다시 튼다.
4. **한계**: `--isolated` 탭(임시 컨텍스트)은 확장이 닿지 않아 소리가 없다.

### 3.13 비기능 요구 (NFR)

**NFR-BRT-S1 (종단의 자리)** 새 HTTP·WS 종단은 전부 `/api/` 아래다 — `gateExempt` 가 그 밖을 정적
자산으로 보고 게이트를 건너뛴다(§2.3). 시험이 이것을 고정한다(TC-BRT-S1).

**NFR-BRT-S2 (격리 world)** 주입 스크립트는 격리 world 에서만 돈다. 격리 world 가 보내는 값
(옵션 문구·툴팁·URL)은 **신뢰하지 않는 데이터**다 — 뷰어는 텍스트로만 그린다(`textContent`).

**NFR-BRT-S3 (프로필 폴더)** `browser/` 는 홈과 같은 권한(`0700`)이다. `backup` 대상 여부는
`STRUCTURE_CLEANUP_SRS` 의 홈 목록 규약을 따라 **담지 않는다**(쿠키·로그인 — 다른 기기에서 풀리지
않는다, §2.3 Chrome 키) — 홈 목록에 `Backup: false` 로 등록한다.

**NFR-BRT-S4** 파일 입출력은 서버 기준이다 — 뷰어 기기의 파일 시스템에 닿는 새 경로를 만들지 않는다.

**NFR-BRT-P1** 보이는 탭 하나에서 입력→화면 반영이 LAN 에서 체감 지연 없이(목표 p50 ≤ 100ms)
돈다. 보이지 않는 탭은 screencast 비용이 0 이다(FR-BRT-40).

**NFR-BRT-P2** 서버 메모리는 **쓰이는 프로필 수**에 비례한다 — 창·탭 수에 비례해 Chrome 프로세스가
늘지 않는다.

**NFR-BRT-Q1** `-race` 통과. CDP 층은 가짜 피어(`os.Pipe`)로 단위 시험한다. 실제 Chrome 이 필요한
시험은 Chrome 이 없으면 건너뛰되, CI(Linux·Windows)는 Chrome 을 갖춘다.

**NFR-BRT-Q2** 새 설정 키·단축키·환경 변수·`dmctl` 서브커맨드·API 는 각 문서 검사
(`check-settings-docs`·`check-shortcuts-docs`·`check-env-docs`·`check-commands-docs`·`check-api-docs`)를
통과한다. 새 문구는 i18n 규약(`check-i18n*`)을 따른다.

---

## 4. 검증 (Verification)

### 4.1 엔진·수명 (Go)

| ID | 확인 |
|---|---|
| TC-BRT-1 | OS 별 탐색 표(FR-BRT-1) — 주입한 `look`/`stat`/`env` 로 세 체인 전부를 어느 호스트에서도 시험. Edge·chromium 만 있으면 "없음" |
| TC-BRT-2 | 엔진 없음 → 안내 문구 · `dmctl browser open` 종료 코드 1 |
| TC-BRT-3 | 주 버전 134 → 거절, 135 → 통과 (가짜 피어) |
| TC-BRT-4 | 기동 인자에 `--remote-debugging-port` 가 **없고** `--user-data-dir` 이 프로필 폴더다. `browserAudio` 가 `server` 가 아니면 `--mute-audio` 가 있다 |
| TC-BRT-5 | pipe 전송: NUL 구분·부분 읽기·큰 메시지(>1MiB 프레임) (가짜 피어) |
| TC-BRT-6 | **Windows**: `lpReserved2` 로 띄운 자식이 fd 3 을 읽고 fd 4 에 쓴다 (도우미 자식 프로세스로), 그리고 실제 Chrome 에서 `Browser.getVersion` |
| TC-BRT-7 | 프로필의 마지막 페이지가 닫히면 프로필 브라우저가 끝난다. 매니저 종료 시 자식이 남지 않는다 (Windows: Job) |
| TC-BRT-8 | 데몬 기능 플래그 없는 옛 데몬 → 안내 |
| TC-BRT-83 | 실제 Chrome: 새 페이지의 첫 요청 User-Agent 헤더와 `navigator.userAgent` 에 `HeadlessChrome` 이 없고 `Chrome/<판>` 이 있다. `Sec-CH-UA` 와 `navigator.userAgentData.brands` 가 비지 않는다 (FR-BRT-92) |
| TC-BRT-84 | 기동 인자에 `--disable-blink-features=AutomationControlled` 가 있다(소리 설정 셋 모두). 실제 Chrome: 최상위 페이지와 교차 출처 iframe 의 `navigator.webdriver` 가 `false` 다 (FR-BRT-93) |

### 4.2 프로필

| ID | 확인 |
|---|---|
| TC-BRT-10 | 폴더 목록 = 프로필 목록. 이름 규칙 위반 거절 |
| TC-BRT-11 | `default` 삭제 거절, 없으면 생성 |
| TC-BRT-12 | 사용 중 프로필 삭제 → 탭 닫힘 · 프로세스 종료 · 폴더 삭제 |
| TC-BRT-13 | 두 프로필 동시 사용 → 프로세스 둘, 쿠키가 섞이지 않는다 (실제 Chrome) |
| TC-BRT-14 | `--isolated` 탭은 기본 컨텍스트의 쿠키를 보지 않고, 마지막 탭이 닫히면 컨텍스트가 사라진다 |

### 4.3 CDP 층

| ID | 확인 |
|---|---|
| TC-BRT-20 | id 재매김 — 두 클라이언트가 같은 id 를 보내도 응답이 섞이지 않는다 |
| TC-BRT-21 | 세션 이벤트가 붙인 클라이언트에만 간다 |
| TC-BRT-22 | 거절 메서드 표(FR-BRT-24) 전부 오류, Chrome 에 가지 않는다 |
| TC-BRT-23 | CDP 프록시 WS 에 `Origin: http://localhost:58146` → 403, `Origin` 없음 → 101, `devtools://devtools` → 403 (결정 ⑮) |
| TC-BRT-24 | Playwright `chromium.connectOverCDP(<ws 주소>)` 와 `(<http 접두 주소>)` 가 붙어 `page.goto`·`click` 이 된다 (e2e) |

### 4.4 탭·배치 (JS 단위 + e2e)

| ID | 확인 |
|---|---|
| TC-BRT-30 | `split`: 오른쪽 칸 있음 → 그 칸에 새 탭(그 칸의 기존 탭 종류 무관) · 없음 → 오른쪽 분할 · 오른쪽이 위아래로 나뉘어 있음 → `firstPane` · 호출 칸이 창의 오른쪽 끝 → 분할(옆 창 슬롯으로 넘어가지 않음) |
| TC-BRT-31 | `tab`: 호출 칸에 새 탭 |
| TC-BRT-32 | 브라우저 안에서 연 탭은 설정과 무관하게 연 탭 바로 뒤 · 일반 클릭 앞으로 · Ctrl/⌘ 클릭 뒤에 |
| TC-BRT-33 | 기존 브라우저 탭을 재사용하지 않는다 — 같은 URL 두 번 → 탭 둘 |
| TC-BRT-34 | 뷰어 없음 → 페이지는 즉시 생성, 클라이언트 접속 시 호출 도구 기준 배치 |
| TC-BRT-35 | 닫기 양방향 · `window.close()` · 크래시 안내 |
| TC-BRT-36 | 데몬 재시작 뒤 지연 복원 — 보이기 전에는 페이지가 없다, 보이면 `url` 로 생긴다, 임시 탭은 새 컨텍스트 |
| TC-BRT-37 | 보이지 않는 탭은 프레임을 보내지 않는다 · 다시 보이면 첫 프레임이 즉시 |
| TC-BRT-38 | 여러 기기 동시 접속 시 배치는 한 곳에서만 (`single`) |

### 4.5 화면·입력

| ID | 확인 |
|---|---|
| TC-BRT-40 | 창 주인 전환 → 뷰포트가 새 주인 크기로 · 비주인은 축소·dim · `dmctl` 조작은 주인 불변 |
| TC-BRT-41 | 고정 크기 → 주인 전환에도 불변 |
| TC-BRT-42 | 키 변환 표 — Mac 뷰어 ⌘C → Windows 서버 Ctrl+C · macOS 서버 `commands` 동반 (단위) |
| TC-BRT-43 | 한글 조합 입력 → 페이지 `compositionstart/update/end` · 값 (P5 재현, e2e) |
| TC-BRT-44 | 키 배분 — 전역 단축키는 페이지에 가지 않는다 · `Mod+R` 이 dongminal 을 새로고침하지 않고 탭을 새로고침 |
| TC-BRT-45 | `base-select` — 네이티브 select 목록이 프레임에 보이고 옵션 클릭으로 값이 바뀐다 (P4 재현) |
| TC-BRT-46 | 확대 `Mod+=` → `innerWidth` 가 `1/z` |
| TC-BRT-88 | 실제 Chrome: `nav signin` → 탭이 `chrome://settings/people` 이고 로그인 버튼(`#signIn`)이 있다. `goto chrome://settings` 는 여전히 거절된다 (FR-BRT-96) |
| TC-BRT-89 | e2e: 탭 메뉴 "Chrome 에 로그인" → 탭 주소가 `chrome://settings/people` (FR-BRT-96) |
| TC-BRT-85 | `ack=1` 뷰어: 확인 없이는 프레임이 2장까지만 오고, 확인하면 최신 프레임이 온다. `ack` 없는 뷰어는 종전대로 받는다 (FR-BRT-94) |
| TC-BRT-86 | 화질 결정(순수 함수): 기다림 + 30장 미만 → 10 내림(1초 간격, 40 에서 멈춤) · 5초 기다림 없음 → 10 올림(70 에서 멈춤) · 기다렸어도 30장 이상이면 그대로 (FR-BRT-95) |
| TC-BRT-87 | 매니저 `quality`: 범위 밖은 40·70 으로 자른다(단위). 실제 Chrome: 보는 중에 바꾸면 screencast 가 다시 켜져 프레임이 오고, 같은 화면의 q40 프레임이 q70 보다 작다 (FR-BRT-95) |

### 4.6 훅·링크·scheme·제거

| ID | 확인 |
|---|---|
| TC-BRT-50 | `open https://x`·`xdg-open`·`$BROWSER`·`dmctl open-url` → 브라우저 탭 (실 zsh·bash). `open .`·`open a.pdf` 는 위임 (VUO V10 승계) |
| TC-BRT-51 | 링크 클릭 네 출처 × 설정 두 값 × 수정키 유무 |
| TC-BRT-52 | 프로그램이 연 URL 은 `linkTarget=viewer` 에서도 브라우저 탭 |
| TC-BRT-53 | scheme 표 — 허용 넷 통과, `javascript:`·`data:`·`chrome:` 거절 · 상대 경로·Windows 경로 → `file://` |
| TC-BRT-54 | 제거 확인 — `openUrl` 액션·`/api/open-url/where`·`open-url.js`·`platform.Opener`·`DONGMINAL_URL_OPEN` 이 저장소에 없다 (grep 0건, 문서의 이력 제외) |
| TC-BRT-55 | (삭제 — 비목표 11, 결정 ㊹) |

### 4.7 터미널 제어 (2단계)

| ID | 확인 |
|---|---|
| TC-BRT-60 | 시험 페이지에서 snapshot → click/fill/select/press/wait 흐름 · 무효 ref 오류 · 교차 출처 iframe 요소 |
| TC-BRT-61 | actionability — 덮인 요소 click 은 시간 초과로 실패하고 이유를 낸다 |
| TC-BRT-62 | `--dom` 이 `div onclick` 을 잡는다 |
| TC-BRT-63 | `--json` 형태·종료 코드 |
| TC-BRT-64 | screenshot 파일 · console/network 기록 |

### 4.8 외부 도구 (2단계)

| ID | 확인 |
|---|---|
| TC-BRT-65 | Playwright `newPage()` → dongminal 탭 생성 (`tool` 칸 기준) · `page.close()` → 탭 닫힘 · `newContext()` → 임시 배지 |

### 4.9 충실도 (3단계)

| ID | 확인 |
|---|---|
| TC-BRT-70 | 다운로드 → 서버 폴더에 파일 · 뷰어로 전송 없음 · `dmctl browser downloads` |
| TC-BRT-71 | 파일 선택 → 서버 파일 선택 창 → `setFileInputFiles` · 취소 · `multiple` |
| TC-BRT-72 | alert/confirm/prompt/beforeunload 모달 · 중복 답 |
| TC-BRT-73 | HTTP 기본 인증 |
| TC-BRT-74 | 컨텍스트 메뉴 — 페이지가 막으면 안 뜬다 |
| TC-BRT-75 | 커서·툴팁·검증 말풍선·date/color/datalist |
| TC-BRT-76 | 클립보드 복사/붙여넣기 |
| TC-BRT-77 | DevTools 탭 — 열림·대상 닫힘 시 닫힘 (P6 재현) |
| TC-BRT-78 | 찾기 |
| TC-BRT-79 | 비웹 링크 확인 |

### 4.10 소리 (4단계)

| ID | 확인 |
|---|---|
| TC-BRT-80 | 기본(`off`)·`viewer` 는 `--mute-audio` · `server` 는 인자에 없다 · `viewer` 만 확장 인자 둘이 있다 · 모르는 값은 `off` |
| TC-BRT-81 | 시험 페이지의 톤이 뷰어의 WebRTC 트랙에 도착한다(수신 에너지 > 0) · 뷰어가 끊기면 peer 가 끝난다 |
| TC-BRT-82 | 내장 확장의 `key` 에서 계산한 ID 가 기동 인자의 ID 와 같다 |

### 4.11 보안·문서

| ID | 확인 |
|---|---|
| TC-BRT-S1 | 새 종단 전부가 `gateExempt` 에 걸리지 않는다 — 경로 목록을 돌며 `gateExempt(req)==false` |
| TC-BRT-S2 | `file://` 페이지·`http://localhost:<다른 포트>` 페이지에서 dongminal API·`/ws`·CDP 프록시 호출 → 거절 (0단계와 FR-BRT-23 의 합) |
| TC-BRT-S3 | 격리 world 문자열이 뷰어에서 마크업으로 해석되지 않는다 |
| TC-BRT-S4 | 문서 검사 다섯(NFR-BRT-Q2)·`check-srs-status`·`check-srs-progress`·`check-decisions` |

---

## 5. 비목표 (Non-goals)

1. Edge·Chromium·Firefox 엔진, 엔진 다운로드(Chrome for Testing) — D1.
2. 디버깅 포트 — D2.
3. 뷰어 기기의 카메라·마이크·패스키(WebAuthn)·비밀번호 관리자·확장 프로그램, DRM(Widevine) 재생.
4. 사용자의 평소 Chrome 프로필 가져오기 — 암호화 키가 달라 쿠키가 풀리지 않는다.
5. 뒤로/앞으로 기록·폼 상태의 복원.
6. 주소창 검색 엔진 연동.
7. `dongminal window` 의 탐색 체인 변경.
8. PowerShell 의 `Start-Process` 가로채기 — Windows 는 `BROWSER` 를 존중하는 도구와 `dmctl` 직접
   호출만 잡힌다(`VIEWER_URL_OPEN_SRS` 비목표 승계).
9. 녹화·PDF·기기 프리셋 등 Playwright 의 넓은 표면 — CDP 프록시로 진짜 Playwright 를 쓴다.
10. 뷰어 기기 파일의 직접 업로드, 다운로드의 뷰어 자동 전송 — D16·D17.
11. 에이전트 프로토콜(omp `extension_ui_request`)의 `open_url` 을 브라우저 탭으로 여는 것 — 그 이벤트를
    받아 실행할 경로가 없다(AGENT_GUI_REMOVAL). 터미널에서 도는 에이전트는 `open`·`$BROWSER` 로 연다 (결정 ㊹).

---

## 6. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| **D-BRT-1** | 엔진은 모든 OS 에서 Google Chrome 만, 없으면 설치 요구 | 사용자 결정. 제조사 자동 업데이트에 보안 패치를 맡긴다 |
| **D-BRT-2** | CDP 는 pipe + dongminal CDP 프록시, 포트를 열지 않는다 | 사용자 결정("포트 노출은 별로야"). 보안 경계가 게이트 하나로 모인다. Playwright 가 Windows 포함 pipe 를 쓴다 |
| **D-BRT-3** | 이름 붙은 프로필 여럿을 동시에, 설정에서 추가·제거, 프로필마다 임시 컨텍스트 | 사용자 결정 |
| **D-BRT-4** | 여는 위치는 설정 토글(분할 기본 = 오른쪽 칸 있으면 새 탭, 없으면 분할 / 새 탭). 재사용 없음. 브라우저 안에서 연 탭은 그 칸 | 사용자 결정 — "해당 브라우저도 함께 보는중일수도 있다" |
| **D-BRT-5** | dongminal 화면의 링크 클릭은 설정(기본 내장), 수정키 반대. 프로그램이 여는 URL 은 언제나 내장 | 사용자 결정. 제스처 없는 `window.open` 은 막히므로 프로그램 URL 을 뷰어로 보내려면 제거 대상 모달이 되살아난다 |
| **D-BRT-6** | `<select>` 는 1단계 `base-select`, 나머지 위젯은 3단계 뷰어 재구성 | 사용자 결정. P4 로 확인 |
| **D-BRT-7** | 뷰포트는 창 소유권을 따르고, 탭별 고정 크기 | 사용자 결정. 기존 FR-XDF 재사용 |
| **D-BRT-8** | scheme 은 http·https·file·about:blank | 사용자 결정. 사람·에이전트가 이미 가진 권한을 넘지 않는다 |
| **D-BRT-9** | CDP 프록시는 다른 API 와 같은 범위, Origin 붙은 WS 거부, 위험 메서드 거절, 0단계 선행 | 사용자 결정 |
| **D-BRT-10** | 페이지 목록과 탭 목록을 일치시킨다(외부 도구의 페이지 포함) | 사용자 결정 — 사람과 에이전트가 같은 브라우저를 본다 |
| **D-BRT-11** | 지연 복원, 보지 않는 탭은 스트림만 멈춘다 | 사용자 결정 |
| **D-BRT-12** | 제어는 Playwright 방식(신뢰 입력·접근성 snapshot·actionability)을 Go+CDP 로, DOM 추출은 browser-use 방식을 보조로 | 사용자 결정. page-agent 의 합성 이벤트는 사용자 활성화·교차 출처 iframe 이 없다 |
| **D-BRT-13** | 키는 전역 → 탭 UI → 페이지, 서버 OS 기준 `Mod` 변환 | 사용자 결정 |
| **D-BRT-14** | 소리는 기본 끔, 서버 재생은 옵션, 뷰어 전송은 4단계 | 사용자 결정 — "대부분 원격이기때문에 끄는게 맞다" |
| **D-BRT-15** | DevTools 는 `Target.openDevTools` 페이지를 탭으로 | 사용자 결정. P6 로 headless 동작 확인 |
| **D-BRT-16** | 다운로드는 서버에만 | 사용자 결정 — 기기로는 기존 download 로 받는 것이 합당 |
| **D-BRT-17** | 업로드는 서버 파일만 | 사용자 결정 — 파일 입출력은 서버 기준, 기기 간 이동은 기존 전송 기능 |
| **D-BRT-18** | 페이지는 뷰어 유무와 무관하게 즉시 만들고 배치만 미룬다 | `claude login` 류는 페이지가 떠야 진행한다. 탭 배치는 프론트가 소유하므로 클라이언트가 붙을 때 한다 |
| **D-BRT-19** | 새 종단은 전부 `/api/` 아래 | `gateExempt` 가 그 밖을 정적 자산으로 보고 게이트를 건너뛴다 |
| **D-BRT-20** | UA 에서 `HeadlessChrome` 한 낱말만 `Chrome` 으로 바꾼다 | 사용자 결정(2026-09-27) — 실측: `console.typesafe.ai` 가 기본 UA 는 Cloudflare 403 차단, 바꾼 UA 는 확인 화면. 지문 위장(webdriver·플러그인 등)은 하지 않는다 — 최소 변경. webdriver 는 D-BRT-21 이 바꾼다 |
| **D-BRT-23** | 회사 계정의 "Chrome 에 로그인해야 합니다" 는 탭 안에서 Chrome 로그인으로 푼다 — 설정 페이지 하나만 연다 | 사용자 결정(2026-09-27, 안 A) — "your organization requires you to sign into chrome". PoC(Chrome 153 headless): `chrome://signin-internals` 는 DICE·미로그인, `chrome://settings/people` 에 `Sign in to Chrome`(`#signIn`) 이 있고 누르면 `accounts.google.com/signin/chrome/sync`(`GlifDesktopChromeSync`) 가 **새 페이지 탭**으로 열린다. 로그인 뒤의 확인 창(동기화·관리 프로필)이 headless 에서 보이는지는 **미확인** — 실사용으로 본다. 서버 화면에 일반 창을 띄우는 안(B)은 원격에서 쓸 수 없다 |
| **D-BRT-22** | 느린 링크는 받음 확인(2장) + JPEG 품질 적응(40~70)으로 맞춘다. 초당 30장을 지키는 쪽으로 품질을 먼저 내리고, 해상도는 건드리지 않는다 | 사용자 결정(2026-09-27) — "못해도 30프레임, 너무 프레임을 낮춰도·화질을 낮춰도 안 된다. 간단하지만 효과적인 방법." 실측: 로컬 전 구간 클릭→그림 p50 21ms, 스크롤 중 약 50장/초 × 76KB ≈ 31~34Mbps — 원격(Tailscale, 인터넷 경유 RTT 21ms)에서 업로드가 그보다 좁으면 프레임이 쌓인다. H.264·WebRTC 는 의존과 복잡도가 커서 두지 않는다 |
| **D-BRT-21** | `navigator.webdriver` 를 기동 스위치 하나로 끈다(FR-BRT-93). 숨긴 headful 창 전환(조사의 C1)은 보류한다 | 사용자 결정(2026-09-27) — 실사용에서 `webdriver === true` 로 Turnstile 이 끝없이 다시 떴다. PoC: headful + pipe 도 `true`(원인은 pipe 스위치), headless + pipe + 이 스위치는 최상위·교차 출처 iframe 모두 `false`. 창 숨김·포커스 문제가 없는 가장 작은 변경이다. 그래도 막히면 교차 출처 iframe 의 `Runtime.enable`, 그다음 headful 을 다시 본다 |

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-27 | 초안. 조사·인터뷰(D1~D17)와 macOS PoC(P1~P8) 반영. 사용자 지시로 구현 세션에 인계 |
| 2026-09-27 | **1단계 구현.** `shared/platform`(Chrome 탐색·pipe 기동, Windows `lpReserved2`) · `shared/cdp`(NUL 프레이밍·id 재매김 다중화·거절 메서드) · `shared/browser`(매니저) · 데몬 IPC `browser` · `/api/browser/*` · `dmctl browser` · 브라우저 탭 뷰어 · 설정 ▸ Browser · 링크 라우팅 · 옛 방식 제거. **구현 중 결정** 아래 열셋 |
| 2026-09-27 | 결정 ① **FR-BRT-4 개정**: 기동 인자에 `--no-startup-window` 를 더한다 — Chrome 이 스스로 연 새 탭은 탭 목록과 페이지 목록을 어긋나게 하고(FR-BRT-31), 뒤늦게 닫으면 렌더러를 나눠 쓰던 첫 페이지의 이동이 깨진다(실측). ② `Emulation.setFocusEmulationEnabled` 를 쓰지 않는다 — Chrome 153 에서 교차 프로세스 이동 때 렌더러가 죽는다(실측). ③ 새 페이지는 `waitForDebuggerOnStart` 로 멈춘 채 붙고, 준비 요청은 **답을 기다리지 않고** 흘려보낸 뒤 풀어 준다(멈춘 페이지는 `Page.enable` 에 답하지 않는다). 풀린 뒤 이동 전에 왕복 한 번(`Page.getFrameTree`)을 기다린다 — 곧바로 교차 프로세스 이동을 걸면 Page 이벤트가 오지 않았다(실측) |
| 2026-09-27 | 결정 ④ **설정 키는 기존 평면 관례를 따른다**: `browser.openPlacement`→`browserOpenPlacement`, `browser.linkTarget`→`browserLinkTarget`, `browser.defaultProfile`→`browserDefaultProfile`, `browser.serverAudio`→`browserServerAudio` (`settings-schema.js`). ⑤ **FR-BRT-35 개정**: `openBrowserTab` 은 `single` 이고 `creating` 이 아니다 — 페이지를 즉시 만들어야 하므로(FR-BRT-36) 탭 uuid 는 서버가 먼저 정하고 `POST /api/browser/open` 이 그것을 돌려준다. 에코를 기다릴 일이 없다. ⑥ 배치 대기(FR-BRT-36)는 `POST /api/browser/placements/claim` 로 화면이 가져간다(SSE 구독이 열릴 때). 서버가 한 번만 내준다 |
| 2026-09-27 | 결정 ⑦ 탭 목록과 페이지 목록의 정합(FR-BRT-31)은 **워크스페이스 저장 뒤** 서버가 한다 — 한 번 워크스페이스에 나타났다가 사라진 탭의 페이지를 닫는다. 아직 배치되지 않은 탭은 건드리지 않는다. 화면의 탭 닫기는 그와 별도로 `POST /api/browser/close` 를 부른다. ⑧ `F5`·`Alt+←/→` 는 **고정 보조 키**다 — 단축키 표에는 `Mod` 조합 여덟만 든다(FR-BRT-56 의 "사용자가 바꿀 수 있다" 는 그 여덟). ⑨ `dmctl browser open`·주소창은 스킴 없는 `host:port`(`localhost:3000`)를 http 로 읽는다 — 그 밖은 FR-BRT-66 대로 경로다 |
| 2026-09-27 | 결정 ⑩ 에이전트 `open_url`(FR-BRT-70·TC-BRT-55)은 해석층이 `open_url` 이벤트(`EvOpenURL`)로 낸다. **그 이벤트를 소비하는 실행 경로가 지금 없다**(AGENT_GUI_REMOVAL 뒤 프로토콜 표면은 해석까지만 선다) — 터미널에서 도는 에이전트는 `$BROWSER`·`open` 으로 같은 길을 탄다. 소비처가 생기면 `POST /api/browser/open`(focus) 으로 보낸다. ⑪ 데몬 IPC 는 메서드 `browser`(`{op, params}`) 하나·이벤트 `browser` 하나다. 조작은 읽기 루프 밖에서 돌고 입력만 안에서 줄에 선다 — 입력은 페이지마다 한 줄로 차례로 가고 하나에 5초 상한이 있다 |
| 2026-09-27 | 결정 ⑫ 매니저의 거절(엔진 없음·판 낮음·scheme·프로필 이름)은 HTTP **409** 로 문구 그대로 간다 — `dmctl` 은 그것을 보이고 1 로 끝난다. ⑬ 홈 목록: `browser/` 는 `InBackup:false`·`KeepOnUninstall:true` — 사용자의 로그인이라 맨 uninstall 은 보존한다(`--purge` 가 지운다). **검증 한계**: TC-BRT-6 의 Windows 판정·Linux CI 의 Chrome 샌드박스(ubuntu 의 AppArmor userns 제한)는 이 기기에서 잴 수 없다 — CI 가 판정한다 |
| 2026-09-27 | **2단계 구현.** 매니저의 조작(`act.go`: 접근성 snapshot·`--dom`·ref·actionability·click/hover/fill/select/type/press/scroll/upload·wait·eval·screenshot·console/network 기록) · `/api/browser/act` · CDP 프록시(`/api/browser/<프로필>/cdp/json/version`·`…/cdp/ws`, `dmctl browser cdp-url`) · 외부 도구 페이지의 탭화 · 에이전트 동작 오버레이. **구현 중 결정** 아래 넷 |
| 2026-09-27 | 결정 ⑭ **FR-BRT-24 개정**: `Browser.setDownloadBehavior` 와 `Page.setInterceptFileChooserDialog(enabled:false)` 는 **보내지 않고 빈 성공**으로 답한다 — Playwright 가 컨텍스트마다 전자를 부르고 실패하면 컨텍스트를 만들지 못한다(`crBrowser.js:305`). 뜻(경로·가로채기를 dongminal 이 소유)은 그대로다. `Browser.close`·`crash`·`crashGpuProcess`·남의 컨텍스트 삭제는 종전대로 오류다 (TC-BRT-22 개정). ⑮ **FR-BRT-23 개정**: `Origin: devtools://devtools` 예외를 두지 않는다 — 0단계 FR-ROP-3 이 비 http(s) Origin 을 게이트에서 먼저 거절하고, `Target.openDevTools` 의 페이지는 Chrome 안에서 대상에 붙으므로 프록시를 지나지 않는다 (TC-BRT-23 개정: 셋 다 403) |
| 2026-09-27 | 결정 ⑯ 외부 도구마다 `Target.attachToBrowserTarget` 로 **자기 브라우저 세션**을 준다 — 세션 없는 요청은 그 세션으로 가고 그 세션의 소식은 세션을 떼고 돌아온다. 루트 연결을 나눠 쓰면 매니저가 이미 건 `setAutoAttach` 가 도구의 자동 부착을 삼키고, 매니저의 부착이 도구에 새어 "Duplicate target" 이 났다(실측). ⑰ 교차 출처 iframe 은 페이지 세션의 `Target.setAutoAttach` 로 붙이고, 그 안의 ref 는 `DOM.getFrameOwner` 의 `<iframe>` 위치를 더해 최상위 좌표로 옮긴다. 조작은 pipe 가 있는 매니저 안에서 돈다(요청 하나가 CDP 왕복 수십 번) |
| 2026-09-27 | **3단계 구현.** `browser/fidelity.go`(대화상자·파일 선택·HTTP 인증·다운로드·DevTools) · `browser/agent.go`(격리 world 보고자: 커서·툴팁·검증 말풍선·위젯·컨텍스트 메뉴·복사·캐럿·찾기) · 뷰어 `browser-view-fid.js` · `dmctl browser dialog`·`devtools`·`downloads` · `GET /api/browser/downloads` · 설정 ▸ Browser ▸ 다운로드 폴더 · 단축키 `brvFind`(Mod+F)·`brvDevtools`(Mod+Alt+I, `F12` 고정). **구현 중 결정** 아래 |
| 2026-09-27 | 결정 ⑱ **FR-BRT-86 판정**: `Fetch.enable` 의 `patterns` 를 비우면 `authRequired` 가 오지 않는다(실측, Chrome 153) — 인증을 받으려면 모든 요청을 멈춰야 한다. 멈춘 요청은 매니저가 곧바로 `Fetch.continueRequest` 로 풀고, 그 지연은 요청당 약 0.28ms 였다(실측) — NFR-BRT-P1 안이므로 FR 을 유지한다. ⑲ **FR-BRT-80 개정**: 다운로드는 프로필 안의 대기 폴더(`DMDownloads`)에 guid 로 받고, 끝날 때 설정을 읽어 제안된 이름으로 옮긴다(같은 이름이면 ` (1)`, 다른 볼륨이면 복사) — 설정을 바꾸면 브라우저를 다시 띄우지 않아도 다음 다운로드부터 적용된다. ⑳ DevTools 페이지는 target 종류가 `page` 가 아니라 `other` 로 온다(실측) — `devtools://` 주소의 `other` 는 페이지로 받는다. 이동(`nav`)은 답을 기다리지 않는다 — HTTP 인증처럼 페이지가 멈춘 동안에도 이동 요청이 막히지 않는다 |
| 2026-09-27 | 결정 ㉑ **FR-BRT-81 개정**: 파일 선택 창은 탐색기 트리를 재사용하지 않고 `/api/fs/list` 로 폴더를 걷는 목록 모달이다 — 트리는 에디터 창의 상태(열린 폴더·선택)를 품어 모달 안에서 따로 쓰기 어렵다. ㉒ 위젯 값은 격리 world 가 들고 있는 요소에 `Runtime.evaluate` 로 넣는다 — 페이지의 main world 에 흔적을 남기지 않는다. ㉓ 붙여넣기는 뷰어의 `paste` 이벤트 텍스트를 `Input.insertText` 로 보낸다. 복사는 격리 world 가 보고한 글을 기존 클립보드 쓰기 경로(포커스가 있을 때만)로 쓴다. ㉔ 찾기는 CSS Custom Highlight — 칠한 것은 페이지 문서의 `CSS.highlights` 에 들어가므로 페이지 스크립트가 볼 수 있다(이름 `dm-find*`). ㉕ `F12` 는 `F5` 와 같은 고정 보조 키다(결정 ⑧) |
| 2026-09-27 | **4단계 구현.** PoC 통과(Chrome 153 headless=new·pipe): `Extensions.loadUnpacked` 확장의 `chrome.tabCapture` 가 탭 소리를 받는다 — `--mute-audio` 여도 캡처된다. FR-BRT-91 을 구현 수준으로 개정하고(위 §3.12) `browser/audio.go`(내장 확장·offscreen 문서의 WebRTC·신호) · 뷰어 `browser-view-audio.js` · 뷰어 WS `audio` · 설정 `browserAudio` 를 더한다. **구현 중 결정** 아래 |
| 2026-09-27 | 결정 ㉖ 사용자의 확장 호출(activeTab) 없이는 `getMediaStreamId` 가 거절된다(실측). `Extensions.triggerAction`(tab target) 으로 호출을 흉내내는 길도 됐지만(실측) page target → tab target 대응을 찾을 CDP 가 없어, `--allowlisted-extension-id` 로 허용하는 쪽을 택한다(실측으로 된다). ID 는 manifest `key` 로 고정한다. page target → Chrome 탭 id 는 확장의 `chrome.debugger.getTargets()` 가 준다(붙지 않으므로 경고 막대가 없다). ㉗ 신호는 trickle 없이 offer·answer 한 번씩이고 STUN·TURN 을 쓰지 않는다 — 외부 서버에 닿지 않는 대신 뷰어가 서버에 UDP 로 닿아야 한다. ㉘ 한 탭을 여러 뷰어가 받으면 캡처 하나를 나눠 쓴다(같은 탭을 두 번 캡처하면 Chrome 이 거절한다). offer 는 ICE 수집까지 몇 초 걸리므로 뷰어 WS 의 읽기 루프 밖에서 돈다. 신호의 거절은 화면 오류 막을 띄우지 않는다. ㉙ **FR-BRT-90 개정**: `browserServerAudio`(켬/끔)를 `browserAudio`(off·server·viewer)로 바꾼다 — 출시 전이라 옮길 값이 없다. **검증 한계**(1단계 결정 ⑬ 승계): TC-BRT-6 의 Windows 판정·Linux CI 의 Chrome 샌드박스는 이 기기에서 잴 수 없어 CI 가 판정한다 |
| 2026-09-27 | **추적 감사 보완.** FR·TC 전수 대조에서 드러난 빈 곳을 채운다. **구현 중 결정** 아래 |
| 2026-09-27 | 결정 ㉚ **FR-BRT-39**: `dmctl`·화면이 가리킨 탭에 페이지가 없으면 `/api/browser/act`·`nav`·`viewport`·스트림이 **워크스페이스의 탭 레코드**(url·프로필·임시·고정 크기)로 만든다 — 데몬이 다시 뜨면 매니저의 기억(ghost)이 없기 때문이다. ghost 가 있으면 그것이 더 새것이라 그쪽을 쓴다. ㉛ **FR-BRT-84**: DevTools 탭은 대상 탭의 칸을 호출 칸으로 여는 자리 설정(FR-BRT-32)을 따른다. 이름은 DevTools 페이지가 제 제목을 실어 와도 "DevTools · <대상 제목>" 으로 둔다. 데몬이 다시 뜬 뒤의 DevTools 탭은 다시 만들 수 없어 닫는다(대상에서 다시 연다). ㉜ **FR-BRT-30·52**: 탭 메뉴에 고정 크기 셋(1280×800·1024×768·390×844)과 "창 크기에 맞춤" 을 둔다. 상태의 `viewport` 는 고정이면 `{w,h}`, 아니면 `null` 이고, 화면이 그것을 탭 레코드 `viewport` 로 적고 지운다. 복원 때 페이지를 **만들면서** 건다. `devtoolsOf` 도 탭 레코드에 적는다 |
| 2026-09-27 | 결정 ㉝ **FR-BRT-41**: 주소창의 경로는 **절대 경로만**(POSIX `/…`·Windows `C:\…`) 받는다 — 주소창에는 기준 폴더가 없다. 상대 경로는 `dmctl browser open` 이 셸의 폴더로 푼다. ㉞ **FR-BRT-83**: 입력란·textarea 의 캐럿은 격리 world 가 글자 폭(붙이지 않은 canvas 의 `measureText`)으로 잰다 — DOM 에 거울 요소를 세우면 페이지의 MutationObserver 가 본다. 줄 바꿈은 `\n` 만 세고 자동 줄 바꿈은 근사다. ㉟ **FR-BRT-87**: "이미지 복사" 는 이미지 요소의 자리를 `Page.captureScreenshot(clip)` 으로 뜬 PNG 다 — 원본을 받지 않으므로 교차 출처 이미지도 된다. 뷰어는 누른 순간에 약속으로 클립보드 쓰기를 걸고, 이미지 쓰기가 막힌 기기(비보안 문맥)면 주소를 복사한다. "이미지 주소 복사" 도 둔다. ㊱ **FR-BRT-89**: 찾기 막대의 ⓘ 가 교차 출처 iframe 한계를 알린다 |
| 2026-09-27 | 결정 ㊲ **FR-BRT-80**: 다운로드 기록은 매니저가 든다 — 프로필 브라우저가 끝나도 남고 데몬이 끝나면 사라진다(파일은 남는다). 설정 문구를 결정 ⑲("다음 다운로드부터") 에 맞춘다. ㊳ **FR-BRT-5**: Job Object 생성·한도(`KILL_ON_JOB_CLOSE`)를 `process_windows.go` 의 `newKillOnCloseJob` 하나로 모아 도구의 그룹과 브라우저 기동이 함께 쓴다. 기동 자체는 `CreateProcessW` 를 직접 부른다 — os/exec 는 `lpReserved2` 를 채울 길이 없다. ㊴ **FR-BRT-33**: ⌘/Ctrl·가운데 클릭으로 연 탭에는 Chrome 이 `openerId` 를 싣지 않는다(실측) — 같은 컨텍스트에서 2초 안에 그렇게 누른 페이지가 연 것으로 보고 그 탭 바로 뒤, 뒤 탭으로 둔다 |
| 2026-09-27 | 결정 ㊵ **FR-BRT-56·89**: 찾기 `Mod+F` 를 단축키 표에서 빼 **고정 키**로 둔다 — 표의 Editor 찾기(`edFindInFile`)와 같은 조합이라 기본 키 중복 검사(V-PSC-1)에 걸린다. 터미널 검색(`Mod+F` 고정)과 같은 규약이다. ㊶ **NFR-BRT-P1 측정**: 서버 몫(입력이 매니저에 닿은 때 → 그 결과의 screencast 프레임)은 p50 9.5ms · p90 10.0ms(n=20, macOS·Chrome 153, `TestRealInputToFrameLatency`)다. 네트워크 구간은 LAN 에서 이 위에 더해진다. 시험은 서버 몫 p50 ≤ 100ms 를 고정한다 |
| 2026-09-27 | 결정 ㊷ **FR-BRT-54 개정(결함 수정)**: `nativeVirtualKeyCode` 를 싣지 않는다 — Windows 가상 키코드를 그 자리에 넣으면 macOS 서버에서 다른 키로 읽힌다(Meta 91 → Keypad8, 페이지에 "8" 이 들어갔다, 실측). `windowsVirtualKeyCode`·`code`·`key` 로 충분하다(Playwright 와 같다). ㊸ 뷰어는 누름을 보내지 않은 키(탭·전역 단축키가 가져갔다)의 뗌을 보내지 않는다 — 짝 없는 keyup 이 페이지에 갔다. TC-BRT-44 가 둘을 고정한다 |
| 2026-09-27 | 결정 ㊹ **사용자 결정 — 에이전트 `open_url` 을 걷는다.** 결정 ⑩ 에서 더한 `EvOpenURL` 은 받는 곳이 없어 남길 이유가 없다 — 해석층을 1단계 전으로 되돌리고(`open_url` 은 종전대로 본문 줄), FR-BRT-69·70 에서 에이전트를 빼고 TC-BRT-55 를 지우며 비목표 11 로 둔다. ㊺ **사용자 결정 — `<select>` 는 `base-select` 로 확정한다**(FR-BRT-88 의 열린 조항을 닫는다). 목록이 페이지 안에 그려져 화면으로 오고 옵션을 누르면 값이 바뀐다(TC-BRT-45) |
| 2026-09-27 | 결정 ㊻ **FR-BRT-81·85·86**: 매니저가 답을 기다리는 대화상자·파일 선택·HTTP 인증을 들고, 뷰어가 붙으면 그것부터 보낸다(`pending`) — 뷰어가 없던 때 열린 것이 답 없이 남지 않는다. 파일 선택 창은 누른 화면이 띄우고, 누른 화면이 없으면(에이전트의 클릭·뒤늦게 붙음) **창 주인 화면**이 띄운다. 한 곳에서 답하면 다른 화면의 창은 닫힌다. ㊼ **FR-BRT-36**: 배치 대기는 웹서버의 메모리에 있다 — 웹서버만 다시 뜨면 잃는다. 그래서 웹서버의 **첫** claim 에서 매니저에 살아 있는데 워크스페이스에 없는 탭을 배치로 되돌려 준다(한 번뿐 — 막 열려 저장을 기다리는 탭을 두 번 놓지 않는다). ㊽ **FR-BRT-51 동작 변경**: 이전 — OS 포커스를 잃은 화면은 창 주인이어도 흐려지고 크기를 정하지 않았다. 새 — 주인은 포커스를 잃어도 주인이다; 주인이 없을 때만 포커스가 있는 화면이 정한다. 이유 — 한 기기만 쓸 때 다른 앱으로 옮기면 탭이 흐려졌고, 두 화면이 다투지 않게 하는 데는 "주인이 없을 때" 의 조건이면 충분하다 |
| 2026-09-27 | **CI 판정(첫 main push) 반영.** 결정 ㊾ **FR-BRT-6 개정**: `Browser.getVersion` 대기 상한 5초 → 15초 — Windows 러너의 첫 기동이 5초를 넘어 정책 차단으로 잘못 판정됐다. ㊿ **FR-BRT-13 결함(Windows)**: 프로필 삭제가 "다른 프로세스가 쓰는 중" 으로 실패했다 — 주 프로세스가 끝난 뒤에도 Job 의 나머지 자식이 핸들을 늦게 놓는다. 폴더 지우기를 5초까지 다시 해 본다(OS 분기 없음). 결정 51 **FR-BRT-38**: 렌더러 크래시를 브라우저 수준 `Target.targetCrashed` 로도 받는다 — Linux headless 에서는 페이지 세션의 `Inspector.targetCrashed` 가 오지 않았다. 결정 52 **FR-BRT-80**: 뷰어가 붙기 전에 시작·완료된 그 탭의 다운로드를 붙을 때 보낸다(Windows 에서 뷰어보다 다운로드가 먼저 끝났다). 결정 53 macOS Chrome 탐색의 사용자 경로는 `path.Join` 으로 짓는다 — macOS 경로는 POSIX 이고 TC-BRT-1 은 어느 호스트에서도 돈다. TC-BRT-50·52(셸 `open` 훅)는 Windows 에서 건너뛴다(비목표 8). **이 SRS 밖의 회귀 둘도 고친다**: `editor-tab` E11 은 FR-OPT-5-1(같은 본문은 보내지 않는다) 뒤로 409 를 받지 못했다 — 시험이 본문을 바꿔 저장한다. `soft-reload` SR8 은 FR-OPT-4-2 뒤로 탐색기 틱이 `_edGitPoll` 로 옮겨 시험이 폴링을 멈추지 못했다 — 시험 계약의 죽은 이름 `_edGitInterval` 을 `_edGitPoll` 로 바꾼다. 레이아웃 기준선(linux·win32)에 설정 ▸ Browser 의 새 요소를 더한다 |
| 2026-09-27 | **CI 2회차 반영.** 크래시 시험은 `Page.crash` 대신 `chrome://crash` 이동으로 죽인다 — Linux headless 에서 `Page.crash` 는 렌더러를 죽이지 않았다(두 회차 실측). TC-BRT-41 은 resize 보고 대신 페이지 폭을 직접 읽는다(Windows 에서 보고가 오지 않았다). TC-BRT-61 은 페이지가 다 읽힌 뒤 5초 상한으로 잰다(부하 걸린 러너에서 1.5초 안에 첫 판정도 못 했다). **이 SRS 밖**: git 기록의 "사라진 ref" 사유(REPO_FIX 05 F-8.1)가 뒤이은 자동 재적재에 지워졌다 — 사용자가 ref 를 다시 고를 때까지 둔다 |
| 2026-09-27 | **CI 3회차 반영.** 결정 54 **FR-BRT-50 결함**: 뷰어 WS 가 열리기 전에 보낸 조작(탭이 뜨자마자 누른 고정 크기 등)이 조용히 버려졌다 — 여는 중에는 64개까지 모았다가 열리면 보내고, 끊겨 있으면 버린다(다시 붙으면 상태를 새로 받는다). 결정 55 `adoptForeign` 이 등록 뒤 잠금 없이 `pg.st.Title` 을 읽던 경합(`-race`, Linux CI)을 고친다. 크래시 시험은 렌더러 프로세스를 죽인다 — `Page.crash`·`chrome://crash` 는 Linux headless 에서 렌더러를 죽이지 않았다(두 회차 실측). TC-BRT-76 은 입력란의 포커스가 선 뒤에 붙인다. **이 SRS 밖**: `UIKit.dialogOpen` 이 다음 프레임에 주는 기본 포커스가 그 사이 창 안으로 옮긴 포커스를 덮었다(git 확인 J6, 느린 러너) — 창 안에 이미 포커스가 있으면 두지 않는다 |
| 2026-09-27 | **검증 한계 해소**(결정 ⑬·㉙): TC-BRT-6 의 Windows 판정·Linux CI 의 Chrome 샌드박스를 CI 가 판정했다 — `77df484b` 에서 verify `test (windows-latest)`·`test (ubuntu-latest)` 가 초록이고(Windows 전용 `TestPipedChildReadsFD3WritesFD4` 포함), e2e 의 `browser-tab.spec.ts` 가 두 판 모두 실제 Chrome 으로 돌았다(건너뜀은 Windows 의 POSIX 셸 훅 둘뿐) |
| 2026-09-27 | 결정 56 **FR-BRT-92 추가 (동작 변경)**: 이전 — 페이지의 UA 가 `HeadlessChrome/<판>` 이었다. 새 — `Chrome/<판>` 이다. 이유 — 실사용에서 Cloudflare 가 headless 표식만으로 사이트를 막았다(사용자 캡처, `console.typesafe.ai`; 같은 판 Chrome 으로 UA 만 바꾸면 차단 대신 확인 화면). TC-BRT-83 을 더한다 (D-BRT-20) |
| 2026-09-27 | 결정 57 **FR-BRT-91 결함**: offscreen 문서가 target 으로 보이는 순간 붙어 식을 계산했는데, 그때 그 스크립트가 아직 돌지 않았을 수 있다 — offer 가 `__dmOffer is not defined` 로 거절되고(verify CI `d06f48f7` 실측) 뷰어는 다시 청하지 않아 소리가 끝내 오지 않았다. 새 프로필을 띄우자마자 offer 를 보내는 TC-BRT-81(e2e)의 Ubuntu flaky 가 같은 경로다(재시도는 데워진 뒤라 통과). 신호 식은 함수가 정의된 뒤(5초 상한)에 계산한다 |
| 2026-09-27 | 결정 58 **FR-BRT-93 추가 (동작 변경)**: 이전 — 페이지의 `navigator.webdriver` 가 `true` 였다. 새 — `false` 다(기동 인자 `--disable-blink-features=AutomationControlled`). 이유 — 실사용에서 UA 를 고친 뒤에도 Cloudflare Turnstile 체크박스가 끝없이 다시 떴다(사용자 확인, `webdriver === true`). PoC(macOS · Chrome 153): headful + pipe 도 `true` — 숨긴 headful 로는 풀리지 않는다. 같은 PoC 에서 교차 출처 iframe 안의 CDP 클릭은 `screenX ≠ clientX`(172 대 100)로, 알려진 좌표 결함(Chromium 40280325)은 이 판에 없다. TC-BRT-84 를 더한다 (D-BRT-21). 적용 뒤 사용자가 실사용으로 Cloudflare 통과를 확인했다 |
| 2026-09-27 | 결정 59 **FR-BRT-94·95 추가 (동작 변경)**: 이전 — 매니저가 프레임을 받자마자 ack 해 Chrome 이 뷰어의 속도와 무관하게 최대로 찍었고, 품질은 70 고정이었다. 새 — 뷰어가 받음을 확인하고(미확인 2장까지), 링크가 막혀 초당 30장 아래로 떨어지면 품질을 40 까지 내렸다가 여유가 생기면 되돌린다. 이유 — 원격에서 "반응이 느리다"(사용자). 서버 몫은 5ms 로 빠르고, 스트림이 30Mbps 를 넘어 좁은 링크에서 쌓였다(측정은 D-BRT-22). TC-BRT-85~87 을 더한다. 측정(뷰어 쪽 DevTools 스로틀 10Mbps·지연 20ms, 스크롤 8초, 색 있는 줄 400개 페이지 642×787): 종전 초당 7장·115KB/장 → 새 9.5장·85KB/장(품질이 3초 안에 40 까지 내려감), 스크롤 직후 클릭→화면 22~133ms → 6~128ms. 미확인 프레임 상한을 3 으로 올려도 같았다(대역폭이 한계). **잔여**: 이 정도 화면은 q40 에서도 10Mbps 로 초당 30장이 되지 않는다 — 약 20Mbps 가 필요하다 |
| 2026-09-27 | 결정 60 **FR-BRT-96 추가**: 탭 메뉴 "Chrome 에 로그인" → `chrome://settings/people`. FR-BRT-65 의 예외는 이 고정 주소 하나다. TC-BRT-88·89 를 더한다 (D-BRT-23) |
