# 조사: 워크스페이스 안의 서버 측 브라우저 탭

> 이 문서는 **조사와 결정의 기록**이다. 요구사항은 `BROWSER_TAB_SRS.md` 가, 선행
> 보안 수정은 `REQUEST_GATE_ORIGIN_PORT_SRS.md` 가 갖는다. 여기 적힌 결정 D1~D17 은
> 2026-09-26~27 사용자 인터뷰에서 확정됐다.

## 1. 접수

> "현재 프로젝트의 windows 에서 브라우저 창을 여는 것에 대한걸 분석해보자."
> …
> "결과적으로 원하는건 브라우저가 **탭 안에** 들어가면서 **터미널에서 브라우저
> 컨트롤**이 가능해지고, 또한 해당 브라우저가 지금 방식처럼 url 만 가져오는 것이
> 아닌 **실제 서버가 열린 기기에서 실행**된다는게 중요한거야."

제약: **Go 단일 바이너리**, 외부 의존성 최소.

## 2. 현재 상태 (조사 시점)

| 기능 | 위치 | 동작 |
|---|---|---|
| `dongminal window` | `internal/ctl/cli/window.go`, `internal/shared/platform/browser.go` | Chrome/Edge `--app=<url>` frameless 창. Windows 체인: PATH `chrome.exe`/`msedge.exe` → 표준 설치 경로 → `rundll32` |
| `open-url` (VIEWER_URL_OPEN_SRS) | `internal/helper/runtimebin/openurl.go`, `internal/webserver/httpapi/openurl.go`, `web/js/ui/open-url.js`, `internal/shared/platform/opener.go` | 뷰어가 서버와 같은 기기면 호출한 쉘이 `open`/`xdg-open`/`rundll32` 실행, 원격이면 확인 모달 → `window.open` |
| 쉘 훅 | `toolhub/tool_env.go:38` (`BROWSER`), `shellhooks/posix/bash-hook.sh:55-73` | `open`/`xdg-open` 함수가 http/https 한 개 인자만 가로챔. **PowerShell 훅에는 가로채기가 없다** |
| 링크 클릭 | `web/js/ui/term-pane.js:177` · `web/js/ui/doc-render.js:78` · Monaco 기본 오프너 · `web/index.html:247` | 모두 뷰어 브라우저에서 연다 |
| 탭 타입 | `web/js/core/constants.js:557-561` | `terminal`·`editor`·`git`·`run`. 브라우저 탭 없음 |
| CSP | `internal/webserver/httpapi/static.go:130` | `frame-src` 없음 → `default-src 'self'`, `frame-ancestors 'none'` |

## 3. 레퍼런스 분석

| 대상 | 방식 | 판정 |
|---|---|---|
| zenbu-labs/terminal-browser | Electron(포크) offscreen rendering → kitty graphics protocol 로 터미널에 픽셀, 입력은 터미널 이벤트 + macOS Swift 헬퍼 | 부적합 — macOS·Linux 전용, xterm.js 의 kitty graphics 는 부분 구현(xtermjs#5592·#5707·#5713), 프레임이 PTY 바이트로 흐름 |
| stablyai/orca | 데스크톱은 Electron `<webview>`(host-guest), 원격·모바일은 서버 숨김 `BrowserWindow` + CDP `Page.startScreencast`(JPEG q70) + `Input.dispatch*`(stream-remote, 약 5,000줄) | 원격 스트림 구조가 dongminal 에 대응된다. 다만 키 매핑이 제한적이고 IME·네이티브 `<select>` 미해결(orca#15311) |
| alibaba/page-agent `page-controller` | 페이지 안 JS, 합성 DOM 이벤트(`isTrusted=false`), browser-use 의 `buildDomTree.js` 로 번호 붙은 단순 HTML | 실행부는 부적합(사용자 활성화 없음·교차 출처 iframe 불가·main world). **DOM 추출만 보조 snapshot 으로 차용** |
| Playwright | CDP 신뢰 입력 + 접근성 snapshot(ref) + actionability 대기 | **제어의 뼈대로 채택** (Go + CDP 로 방식만 구현, 라이브러리는 쓰지 않음) |
| peters/horizon PR #718 | screencast 에 안 잡히는 `<select>` 를 호스트 쪽에서 그림 | 3단계 위젯 재구성의 선례 |

## 4. 검토한 구조와 판정

| 안 | 설명 | 판정 |
|---|---|---|
| A1 | 시스템 Chrome headless + CDP screencast | **채택** |
| A2 | headful + OS 창 캡처 + WebRTC (neko류) | 기각 — Windows 에서 포커스·데스크톱 점유 |
| A4 | Electron offscreen | 기각 — OSR 도 `<select>` 팝업 미합성(electron#34047·#34095), 단일 바이너리 위반 |
| B1 | 포트 전달 + iframe (뷰어 렌더) | 기각 — 서버 실행 요구 불충족, 외부 사이트 iframe 불가 |
| B2 | 뷰어 쪽 제어 브라우저 + 서버 경유 프록시 | 기각 — 서버 실행·탭 내장 요구 불충족 |
| B3 | 데스크톱 셸 + 네이티브 webview | 기각 — 단일 바이너리 위반 |

## 5. 확인된 제약 (근거 있음)

| 제약 | 근거 |
|---|---|
| Chrome 136+ 는 **기본 데이터 폴더**에서 `--remote-debugging-port/pipe` 를 조용히 무시 → 전용 `--user-data-dir` 필수. 복사한 프로필은 키가 달라 쿠키가 풀리지 않음 | developer.chrome.com/blog/remote-debugging-port |
| branded Chrome 137+ 는 `--load-extension` 차단 → `Extensions.loadUnpacked` | chromium-extensions RFC, mozilla/web-ext#3388 |
| Go `os/exec` 의 `ExtraFiles` 는 Windows 미지원 → pipe 는 `STARTUPINFO.lpReserved2` 를 채운 `CreateProcessW` 직접 호출 필요 | golang/go#26182·#53686, chromedp#1607 |
| screencast 는 페이지 합성 화면만 — 네이티브 `<select>`·date/color 피커·datalist·자동완성·검증 말풍선·툴팁 미포함, 마우스도 닿지 않음 | orca#15311, puppeteer#10198 |
| Chrome 135+ `appearance: base-select` 의 `::picker(select)` 는 top-layer(페이지 안)에 그려짐 | developer.chrome.com/blog/a-customizable-select |
| CDP 에 오디오 스트림·탭 단위 음소거가 없다 (`--mute-audio` 는 프로세스 전체) | CDP 명세 |
| `Target.openDevTools(targetId, panelId?)` 는 DevTools 페이지의 targetId 를 반환 | cdproto/target |

## 6. 조사 중 발견한 결함 — 요청 게이트의 포트 무시

`normalizeHost` 가 `Origin` 의 포트를 버리고 호스트만 허용 집합과 대조한다
(`internal/webserver/httpapi/reqgate.go:66`). `/ws` 업그레이드는 GET 이라 ③
Sec-Fetch-Site 판정도 받지 않는다. 실측(가짜 tool id, 도구 미생성):

```
Origin: http://localhost:3000   → 101
Origin: https://evil.example    → 403
```

`tool` 을 생략하면 로그인 셸이 생기므로(`handlers_ws.go:81`) 이 기계의 **다른 포트**에서
서빙되는 페이지가 셸을 얻는다. 내장 브라우저는 dev 서버(`localhost:3000`)를 여는 것이
주 용도라 이 결함을 **주 사용 경로 위에** 올린다 → 0단계로 선행 수정
(`REQUEST_GATE_ORIGIN_PORT_SRS.md`).

## 7. 결정 (사용자 확정)

| # | 항목 | 결정 |
|---|---|---|
| D1 | 엔진 | 모든 OS 에서 **Google Chrome** 을 쓴다. 없으면 설치를 요구한다. Edge·배포판 chromium 은 쓰지 않는다 |
| D2 | CDP 연결 | **pipe** (`--remote-debugging-pipe`) + dongminal CDP 프록시. 디버깅 포트를 열지 않는다 |
| D3 | 프로필 | 이름 붙은 영구 프로필 **여럿을 동시에** — 쓰이는 프로필마다 Chrome 하나. 설정에서 추가·제거. `default` 는 삭제 불가. 각 프로필 안에서 `--isolated` 임시 컨텍스트 |
| D4 | 여는 위치 | 설정 토글 **분할(기본)** = 호출한 칸에서 `paneNavigate('right')` 가 도착하는 칸이 있으면 그 칸에 새 탭, 없으면 오른쪽 분할 / **새 탭** = 호출한 칸. 기존 탭은 재사용하지 않는다. 창 경계를 넘지 않는다. **브라우저 페이지 안에서 연 탭은 설정과 무관하게 그 브라우저 탭의 칸** |
| D5 | 링크 클릭 | dongminal 화면(터미널·문서 렌더·편집기·배지)의 링크 클릭은 설정 "링크를 클릭하면 열 곳"(기본 내장 브라우저). ⇧⌘/Shift+Ctrl + 클릭은 반대. **프로그램이 여는 URL(쉘 훅·에이전트 `open_url`)은 항상 내장 브라우저** |
| D6 | 네이티브 위젯 | 1단계 `base-select` 주입, 3단계 뷰어 재구성(date·color·datalist·검증 말풍선·툴팁) |
| D7 | 여러 기기 | 뷰포트는 창 소유권(FR-XDF)을 따른다. 비주인은 축소·dim. 탭별 고정 크기 옵션 |
| D8 | scheme | `http`·`https`·`file`·`about:blank`. 경로는 호출한 셸 cwd 로 풀고 Windows 경로를 변환. 페이지 안 비웹 링크는 3단계에서 뷰어로 |
| D9 | CDP 노출 | 다른 API 와 같은 범위(ACL + 요청 게이트). `Origin` 이 붙은 WS 거부. 상태를 깨는 메서드 거절. 0단계 선행 |
| D10 | 탭↔페이지 | 페이지가 연 탭은 같은 칸 옆(Chrome 포커스 관례). 외부 도구가 연 페이지도 탭(D4 규칙·포커스 유지). 닫기 양방향. 렌더러 크래시는 안내 |
| D11 | 복원·배경 | 지연 복원(임시 탭은 새 임시 컨텍스트로 URL 만). 보지 않는 탭은 screencast 만 멈추고 실행은 계속 |
| D12 | 터미널 제어 | `dmctl browser …` (1단계 탭·이동·환경, 2단계 관찰·조작·대기·진단). 접근성 snapshot + `--dom`. 텍스트/`--json`. 에이전트 동작 오버레이 |
| D13 | 키 배분 | dongminal 전역 → 브라우저 탭 UI → 페이지. 서버 OS 기준 `Mod` 변환. 뷰어 브라우저가 가져가는 키는 한계로 명시 |
| D14 | 소리 | **기본 끔**(`--mute-audio`). "서버에서 재생" 은 옵션. 뷰어 전송은 4단계 PoC |
| D15 | DevTools | `Target.openDevTools` 를 별도 탭으로. 실패 시 명령으로 대체 |
| D16 | 다운로드 | **서버에만 저장**. 기기로는 기존 download 기능으로 받는다 |
| D17 | 업로드 | **서버 파일만** (서버 파일 선택 창). 기기 파일은 기존 업로드로 먼저 올린다 |

부수 기본값(사용자 이의 없음): 클립보드는 터미널과 같이 뷰어 클립보드와 연동한다.

## 8. 미검증 항목 (PoC)

| PoC | 걸린 결정 |
|---|---|
| Windows `lpReserved2` + `CreateProcessW` pipe, Job Object 결합 | D2 |
| headless 에서 `base-select` 목록이 screencast 에 잡히고 클릭이 닿는가 | D6 |
| `Input.imeSetComposition` 으로 한글 조합 | 3단계 IME |
| headless `Target.openDevTools` | D15 |
| `Extensions.loadUnpacked`(pipe) + tabCapture 오디오 | D14 4단계 |
| Playwright·puppeteer·chrome-devtools-mcp 의 프록시 연결 형태 | D9 |

## 9. 출처

- https://github.com/zenbu-labs/terminal-browser · https://github.com/zenbu-labs/pixel
- https://github.com/stablyai/orca · https://github.com/stablyai/orca/issues/15311
- https://github.com/alibaba/page-agent · https://github.com/browser-use/browser-use
- https://github.com/peters/horizon/pull/718
- https://github.com/xtermjs/xterm.js/issues/5592 · /5707 · /5713
- https://github.com/electron/electron/issues/34047 · /34095
- https://developer.chrome.com/blog/remote-debugging-port
- https://developer.chrome.com/blog/a-customizable-select
- https://github.com/golang/go/issues/26182 · /53686 · https://github.com/chromedp/chromedp/issues/1607
- https://github.com/mozilla/web-ext/issues/3388
- https://pkg.go.dev/github.com/chromedp/cdproto/target
