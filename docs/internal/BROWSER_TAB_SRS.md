# SRS: 브라우저 탭 — 서버에서 도는 Chrome 을 탭 안에, 터미널에서 조종한다 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 전 단계(1~4) — 구현 세션에 인계됨. 선행 0단계는 `REQUEST_GATE_ORIGIN_PORT_SRS`.

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
```

`--no-sandbox` 를 쓰지 않는다. Linux 에서 root 로 실행 중이면 Chrome 이 샌드박스 없이는 뜨지
않으므로 FR-BRT-2 경로로 "root 에서는 브라우저 탭을 쓸 수 없습니다" 를 알린다.
`--enable-unsafe-extension-debugging` 은 4단계(FR-BRT-91)가 필요로 할 때만 더한다.

**FR-BRT-5 (pipe)** CDP 는 **pipe 로만** 잇는다 (D2). 디버깅 포트를 열지 않는다.

- macOS·Linux: `ExtraFiles` 로 fd 3(Chrome 이 읽음)·fd 4(Chrome 이 씀).
- Windows: `STARTUPINFOW.lpReserved2` 에 MSVCRT 형식(개수 `int32` · 플래그 바이트 배열 ·
  `HANDLE` 배열; 0·1·2 는 표준 입출력, 3·4 가 pipe)을 채워 `CreateProcessW` 를 부른다.
  핸들은 상속 가능으로 만들고 부모 쪽 끝은 상속을 끈다. 기존 Job Object 그룹 생성
  (`CREATE_SUSPENDED` → `AssignProcessToJobObject` → 재개, `process_windows.go:106-160`)과
  **같은 경로**로 합친다 — 프로필 브라우저의 자식 트리 전체가 Job 에 든다.
- 메시지는 NUL(`\x00`)로 끝나는 JSON 하나다.

**FR-BRT-6 (정책 차단 감지)** pipe 를 열었는데 5초 안에 `Browser.getVersion` 이 답하지 않거나
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

**FR-BRT-69** 프로그램이 여는 URL(쉘 훅 FR-BRT-70 · 에이전트 `open_url`)은 설정과 무관하게
**언제나 브라우저 탭**으로 연다.

### 3.8 묶음 H — 쉘 훅 전환과 옛 방식 제거 (1단계)

**FR-BRT-70 (훅 전환)** 진입점은 그대로 둔다 — `BROWSER=$DONGMINAL_HOME/bin/open-url`,
bash/zsh 의 `open`/`xdg-open` 함수(http/https 한 개 인자만), `dmctl open-url`. 셋 다
`dmctl browser open <url>` 과 **같은 코드 경로**로 브라우저 탭을 연다(호출 칸 = 호출 도구,
포커스 이동). 에이전트 어댑터의 `open_url`(`omp_decode.go:442`)도 같은 경로로 연다.

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
**서버에만** 저장한다 (D16). 저장 폴더는 설정 `browser.downloadDir`(기본: 서버의 `~/Downloads`).
진행·완료를 다운로드 줄에 보이고, 완료 항목에는 "탐색기에서 보기" 만 둔다. 뷰어로 보내지 않는다 —
필요하면 기존 download 기능으로 받는다. `dmctl browser downloads` 가 목록과 경로를 낸다.

**FR-BRT-81 (업로드)** `Page.setInterceptFileChooserDialog(true)` → `Page.fileChooserOpened` 에서
뷰어에 **서버 파일 선택 창**(기존 탐색기 트리 재사용, `multiple` 존중)을 띄우고 고른 경로를
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
제목>". 대상 탭이 닫히면 함께 닫는다. 그 페이지가 CDP 프록시에 붙을 때의 `Origin: devtools://devtools`
만 FR-BRT-23 의 예외다.

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
`showPicker()`) 또는 자체 목록을 띄우고, 고른 값을 `Runtime.callFunctionOn` 으로 넣은 뒤 `input`·
`change` 를 일으킨다. 네이티브 팝업은 열리지 않게 막는다. `<select>` 를 이 방식으로 옮길지는
FR-BRT-60 의 모양 문제를 실제 사이트에서 본 뒤 정한다 (이 문서를 개정한다).

**FR-BRT-89 (찾기)** `Mod+F` 는 탭의 찾기 막대를 연다. 격리 world 가 CSS Custom Highlight 로 칠하고
다음/이전으로 스크롤한다. 교차 출처 iframe 안은 찾지 않는다(한계로 표시).

### 3.12 묶음 U — 소리 (1·4단계)

**FR-BRT-90** 기본은 **소리 끔**(`--mute-audio`) (D14). 설정 `browser.serverAudio`(기본 `false`)를
켜면 서버 스피커로 낸다. CDP 에 탭 단위 음소거가 없으므로 값은 **프로필 브라우저를 다음에 띄울 때**
적용된다 — 설정 설명에 그렇게 적는다.

**FR-BRT-91 (4단계, PoC 게이트)** 확장 프로그램(`Extensions.loadUnpacked` — P7 로 pipe 에서 확인)의
`chrome.tabCapture` → WebRTC 로 소리를 뷰어에 보낸다. 신호 교환은 스트림 종단(FR-BRT-50)을 쓴다.
설정 값은 `off`(기본)·`server`·`viewer` 가 된다. **PoC 가 headless 에서 소리를 얻지 못하면** 이 FR 을
비목표로 옮긴다.

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
| TC-BRT-4 | 기동 인자에 `--remote-debugging-port` 가 **없고** `--user-data-dir` 이 프로필 폴더다. `serverAudio=false` 면 `--mute-audio` 가 있다 |
| TC-BRT-5 | pipe 전송: NUL 구분·부분 읽기·큰 메시지(>1MiB 프레임) (가짜 피어) |
| TC-BRT-6 | **Windows**: `lpReserved2` 로 띄운 자식이 fd 3 을 읽고 fd 4 에 쓴다 (도우미 자식 프로세스로), 그리고 실제 Chrome 에서 `Browser.getVersion` |
| TC-BRT-7 | 프로필의 마지막 페이지가 닫히면 프로필 브라우저가 끝난다. 매니저 종료 시 자식이 남지 않는다 (Windows: Job) |
| TC-BRT-8 | 데몬 기능 플래그 없는 옛 데몬 → 안내 |

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
| TC-BRT-23 | CDP 프록시 WS 에 `Origin: http://localhost:58146` → 403, `Origin` 없음 → 101, `devtools://devtools` → 101 |
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

### 4.6 훅·링크·scheme·제거

| ID | 확인 |
|---|---|
| TC-BRT-50 | `open https://x`·`xdg-open`·`$BROWSER`·`dmctl open-url` → 브라우저 탭 (실 zsh·bash). `open .`·`open a.pdf` 는 위임 (VUO V10 승계) |
| TC-BRT-51 | 링크 클릭 네 출처 × 설정 두 값 × 수정키 유무 |
| TC-BRT-52 | 프로그램이 연 URL 은 `linkTarget=viewer` 에서도 브라우저 탭 |
| TC-BRT-53 | scheme 표 — 허용 넷 통과, `javascript:`·`data:`·`chrome:` 거절 · 상대 경로·Windows 경로 → `file://` |
| TC-BRT-54 | 제거 확인 — `openUrl` 액션·`/api/open-url/where`·`open-url.js`·`platform.Opener`·`DONGMINAL_URL_OPEN` 이 저장소에 없다 (grep 0건, 문서의 이력 제외) |
| TC-BRT-55 | 에이전트 `open_url` → 브라우저 탭 |

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
| TC-BRT-80 | 기본 `--mute-audio` · `serverAudio=true` 는 다음 기동에서 인자에 없다 |
| TC-BRT-81 | (PoC 통과 시) 시험 페이지의 톤이 뷰어의 WebRTC 트랙에 도착 |

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

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-27 | 초안. 조사·인터뷰(D1~D17)와 macOS PoC(P1~P8) 반영. 사용자 지시로 구현 세션에 인계 |
