# M3 설계 — 3.4 화면 등록부·지연 로딩 · 3.5 생명주기 · 3.6 프레임 스케줄러

> **승인 2026-11-25, 결정 확정.** 사용자가 하위 이슈 분할(3.5·3.6 의 deps 를 3.4 에서 뗌)과 §4 의 결정 D-M3-1~12 를 모두 권장안으로 골랐다. SRS 결정 번호는 D-29~D-40 이다(§4 첫 표). 구현 중 결정 D-41(설정·간선 묶음, 3.4.9.2)·D-42(묶음 주석 걷기, NFR-PRF-12 → 1.55 MB, 3.4.10)이 더해졌다.
> **2026-11-25 정합(PERF 3.4.11)**: 구현 뒤 코드에 맞춰 §1·§3·§4 의 어긋난 문장을 고쳤다(`perf/M3_DOC_SYNC.md`). §2 는 착수 때 조사로 남긴다.
> 근거: PERF_OPTIMIZATION_SRS FR-SPA-1~4·6, NFR-PRF-11·12, D-3·D-16 · `perf/SPA_PROFILE_2026-11-24.md` §2·§2-1·§4 · `perf/M2_DESIGN.md` D-M2-2 · 이슈 3.3·3.7·3.8 진행 기록
> 기준 코드: `perf-m1` 01589b21 (3.8 병합 뒤)

## 1. 한 줄 요약

- **3.4**: 서버가 스크립트를 **묶음 파일**로 이어 붙여 낸다. 부팅 묶음 둘(`pre`·`boot`)과 화면 묶음 여럿(git·편집기·문서 렌더·Run·설정 등)을 둔다. 화면을 처음 열 때 등록부가 그 묶음을 클래식 스크립트로 싣는다. 언어 파일은 한 벌만 싣는다.
- **3.5**: 탭 본문의 주인(터미널·편집기·git 패널·Run·채팅…)이 `wake`·`sleep` 계약을 갖는다. 렌더러가 "지금 보이는 것"을 한 자리에서 정해 전이를 부른다. 잠든 화면의 구독·타이머는 걷힌다.
- **3.6**: 새 스케줄러를 만들지 않는다. 앱의 모든 rAF 가 이미 지나는 `TimerHub.frame` 에 **합치기 키·우선순위·8 ms 예산**을 더한다. 측정된 자리(부팅 `_gpuAttach`·`tabsFit`, 파일 열기)에만 먼저 적용한다.

## 2. 지금 구조 (파일:줄 근거)

> **2026-11-25 착수 전 조사(`01589b21`)다.** 줄 번호·개수는 그때 값이다. 지금 구조는 §3 과 코드(`web/bundles.txt`, `web/js/core/screens.js`, `web/js/ui/screen-life.js`, `web/js/core/timer-hub.js`)를 본다. 아래 「지금은」 줄만 정정했다(PERF 3.4.11, 2026-11-25).

### 2.1 스크립트 싣기

- `web/index.html` 은 클래식 `<script>` **296개**(head 3 + 본문 293)를 순서대로 싣는다. `type="module"` 은 없다. 본문 목록은 `web/index.html:928`(vendor xterm) 에서 `:1348`(diag.js) 까지다.
  - 디렉터리별: `js/core` 146 · `js/ui` 80 · `js/git` 56 · `js/i18n` 2 · vendor 9.
  - 크기(압축 전, 지금 HEAD): **3.88 MB**. 앱 JS 3.19 MB 가운데 **주석이 1.53 MB(48%)** 다(espree 로 잼, 측정 스크립트는 커밋하지 않음).
- CSS 는 `<link>` 20개, 415 KB(`web/index.html:22~47`). git·편집기·문서 렌더 CSS 도 부팅 때 모두 싣는다.
- 순서는 계약이다.
  - `error-log.js` 가 가장 앞이다(`web/index.html:939`).
  - 언어 카탈로그(`i18n.js` → `ko.js`·`en.js`, `:947~949`)는 **모든 상수보다 앞**이다. `constants*.js` 가 로드 시점에 `const X=t('…')` 로 문장을 읽기 때문이다(`web/js/core/i18n.js:4~8`).
  - 로케일은 한 번 정해지고, 바꾸면 페이지를 다시 연다(D-B-1, `i18n.js:6~8`). 그래서 "언어 바꾸기" 는 지금도 새로고침이다.
- 판(`?v=__ASSETV__`)은 서버가 index 를 낼 때 채운다. 판은 `vendor/` 를 뺀 모든 JS·CSS 내용의 해시다(`rust/crates/webserver/httpapi/src/asset_version.rs:40`). 자산은 `rust_embed` 로 바이너리에 들어간다(`rust/crates/web/src/lib.rs:11`). 인라인 스크립트는 CSP 해시로 허용된다(`static_assets.rs:95`) — 인라인을 고쳐도 해시는 서버가 다시 만든다.
- 이미 있는 지연 로딩은 하나다. CodeMirror 묶음을 `import()` 로 싣는다(`web/js/ui/file-editor.js:9~28`, `loadCodeMirror`). 같은 Promise 를 나누고, 실패는 기억하지 않고, 다시 시도할 때 URL 을 바꾼다. 3.4 의 로더가 이 규약을 그대로 따른다.
- 게이트 `scripts/check-load-order.mjs:45` 는 **index.html 의 `<script src>` 순서**를 읽어 로드 시점 TDZ 를 잡는다.
- 시험 하네스 `web/js/test/harness.mjs:305` 의 `load(files)` 는 **소스 파일을 직접** 읽어 `vm` 에 같은 순서로 넣는다. index.html 을 읽지 않는다. 묶음을 도입해도 하네스는 그대로 돈다(FR-SPA-6).

### 2.2 화면 수명

- 기반 클래스는 `Component`(`web/js/core/base/component.js`) → `View`·`Controller` 다. `Component` 는 리스너·관측·타이머·구독을 **주인(owner)** 으로 쌓고 `dispose()` 한 번으로 놓는다(`component.js:43~59`). `View` 는 `mount`·`render`·`dispose` 만 있다(`view.js`). **wake/sleep 은 없다.**
- `View` 하위는 7개, `Controller` 하위는 59개다. **탭 본문의 주인은 View 가 아니다**: `TerminalTool`(`ui/term-pane.js:5`), `FileEditor`(`ui/file-editor.js:30`), `DocRender`(`ui/doc-render.js:14`), `GitPanel`(`git/panel.js:34`), `RunsPanel`(`ui/runs-panel.js:96`), 채팅은 `ChatViews extends Controller`.
- App 생성자가 컨트롤러 20개를 **부팅 때 모두** 만든다(`web/js/core/app.js:66~85`) — `SettingsController`·`EdgesController`·`ChatController`·`GitController` 등. 설정 창 섹션도 `app.init` 안의 `initModal` 이 부팅 때 세운다(`web/js/core/main.js` 주석). 지연 로딩하려면 이 자리를 "얇은 껍데기 + 처음 쓸 때 싣는 본체" 로 나눠야 한다.
  - 지금은: 설정 창은 처음 열 때 `settingsBuild`(`web/js/core/settings-open.js`, `settings` 묶음)가 세운다. `initModal` 은 없다(D-41, PERF 3.4.11, 2026-11-25).

### 2.3 숨김 처리

- 보이는 탭 본문을 정하는 자리는 렌더러 하나다.
  - `_mountTabBody`(`web/js/ui/renderer-pane.js:47`) 가 탭 타입별로 실체를 고르고(git 패널·편집기/문서 렌더·Run·채팅·터미널) `vis` 를 붙인다. 이때 `new FileEditor`·`new DocRender` 를 **동기로** 만든다(`:77~80`).
  - `_hideOthers`(`:145`) 가 옛 위젯을 떼고, `_gcWidgets`(`renderer-layout.js:108`) 가 이번에 붙지 못한 터미널·편집기의 `vis` 를 걷는다.
  - `_afterLayout`(`renderer-layout.js:140`) 이 한 프레임에서 보이는 터미널마다 `open`·`syncGpu(true)`·`doFit` 을 하고, 숨은 터미널은 `syncGpu(false)` 한다.
- 브라우저 탭 숨김(`document.hidden`)을 듣는 자리는 앱 전체에 하나다: `TimerHub` 생성자(`web/js/core/timer-hub.js:34~39`, FR-BUS-8). `every` 작업은 기본이 `whenHidden:'pause'` 다(`:124`). 채널은 숨김 동안 ping 간격만 늘린다(`web/js/core/channel.js:226`).
  - 지금은: `visibilitychange` 리스너가 셋이다 — `TimerHub`(`timer-hub.js`), `EventBus.startLifecycle`(`event-bus.js`, `life:*` 토픽), `VersionWatch`(`version-watch.js`, 판 확인). 생명주기(`ScreenLife`)는 `TimerHub` 의 신호를 받는다(PERF 3.4.11, 2026-11-25).
- 터미널의 잠듦(숨고 2초 뒤 `term.close`)은 M2 이슈 2.5 가 할 일이고 **아직 todo** 다. 브라우저 탭 숨김 규칙은 D-M2-2 가 3.5 로 넘겼다.
  - 지금은: 2.5 done. `TerminalTool` 의 `wake`·`sleep` 이 `term.open{snap}`·`term.close` 를 한다(PERF 3.4.11, 2026-11-25).

### 2.4 타이머·구독

- M1 뒤 남은 주기 작업은 적다: `settings-telegram.js:99`, `state-registry.js:268`(상태 레지스트리), `settings-edges.js:229`, `helpers.js:104`(`visiblePoll`), `git/git-poll.js:223`(git status 회복용, **실패 중일 때만**, `whenHidden:'run'`).
- 채널 토픽 구독(`channel.js:94` `sub`)은 주인을 받는다. 같은 토픽의 마지막 구독자가 빠지면 서버에 `unsub` 을 보낸다(`:133~138`). 다시 구독하면 순번·epoch 로 이어 받는다(`:140~144`). 그래서 **잠들 때 구독을 놓고 깰 때 다시 거는 것만으로 서버 쪽 비용이 사라진다.**
  - 화면이 직접 거는 토픽: `git:<root>`·`git.jobs`(`core/git-topics.js`), `gitconsole:<root>`(`git/console.js:94`), `run:<id>`(`ui/runs-panel.js:485`), `stats:*`(`core/statusbar-controller.js:72`, 상태 줄은 늘 보인다).
  - git 은 이미 반쯤 한다: 보는 패널이 하나라도 있을 때만 `git:<root>` 를 구독한다(`git-poll.js:210`, `pollOkAny`).
    - 지금은: 패널 말고도 탐색기(`editor-pane.js` `_edGitWatchSync`)와 저장소 핀 목록(`git-repos-list.js` `_gitPinsWatchSync`)이 같은 토픽을 따로 구독한다. 그래서 패널이 잠들어도 탐색기가 보이면 `git:<root>` 구독은 남는다(3.5.2, PERF 3.4.11, 2026-11-25).
- 게이트 `scripts/check-timers.sh` 가 `setTimeout`·`setInterval`·`requestAnimationFrame` 을 TimerHub 밖에서 막는다. 원시 rAF 는 0, `TIMERS.frame` 호출은 28곳이다.

### 2.5 DOM 쓰기 경로

- 프레임 단위 일은 모두 `TimerHub.frame`(`timer-hub.js:263`)을 지난다. 지금은 호출마다 rAF 를 하나씩 건다. 합치기·우선순위·예산이 없다.
- 목록 다시 그리기는 `paintIfChanged`·`reconcileList`(`web/js/ui/repaint.js`)가 "바뀐 것만" 을 맡는다. 이것은 **같은 내용의 쓰기를 건너뛰는** 장치이고, 한 프레임 안의 여러 번 쓰기를 합치지는 않는다.
- 측정된 비싼 자리:
  - 부팅 28 ms 작업의 42% 가 `_gpuAttach`(`web/js/ui/term-gpu.js:61`, 칸마다 약 12 ms)다(SPA_PROFILE §3).
  - `UIKit.tabsFit`(`web/js/ui/ui-kit.js:160`)은 쓰기(`labeled` 붙임) → 읽기(`scrollWidth`) → 쓰기를 한 번에 한다. 강제 레이아웃이다. 탭 줄 ResizeObserver(`ui/tab-bar.js:67`)와 `Panel`(`ui/panel.js:55`)이 부른다. git 기록 뷰 18 ms, 탭 열기 49 ms 의 주 원인이다(§2-1-3).
  - 파일 열기 `edOpenFile` 67~74 ms(`tabsFit`·`apiSend`·`_placeLayout`, 3.7 기록). 편집기 밖이다.
    - 지금은: 67~74 ms 는 측정 잡음이다 — 단계마다 트레이스를 새로 걸면 CpuProfiler 시작 비용(약 65 ms)이 첫 JS 작업에 얹힌다. 예열 뒤 실제 작업은 8~9 ms 이고 16 ms 초과 목록에 없다(3.6.3, PERF 3.4.11, 2026-11-25).

## 3. 설계안과 하위 이슈

### 3.4 화면 등록부와 지연 로딩 (FR-SPA-1·2·6)

**왜 묶음이 필요한가.** 부팅 때 호출되지 않은 스크립트(111개)를 모두 빼도 부팅 스크립트는 약 185개다. 파일마다 요청 하나이면 NFR-PRF-11(부팅 요청 80 이하)에 닿을 수 없다. 그래서 부팅 스크립트도 묶음으로 이어 붙여야 한다(D-M3-1. 구현은 `pre`·`boot` 둘).

**모양(권장안 기준)**

1. **묶음 정의 한 자리** — `web/bundles.txt`(줄 단위: `[이름]` 아래 `.js`·`.css` 줄, 순서가 곧 로드 순서). 부팅 묶음은 `pre`(error-log·pref-store·panel-dock·i18n.js)와 `boot` 둘이다 — 언어 파일이 `i18n.js` 뒤·상수 앞에 서야 하기 때문이다. index.html 에는 vendor 8개, head 의 src 스크립트 셋(server-move·storage-rename·panel-layout), 부팅 CSS `<link>`, `b/pre.js` → 언어 인라인 → `b/boot.js` 가 남는다. (정정 2026-11-25, PERF 3.4.11 — 처음 안은 `web/bundles.json`(가칭)·`boot` 하나였다. 3.4.2 조정자 결정)
2. **서버가 묶음을 만든다** — `StaticAssets` 가 시작할 때 묶음 정의를 읽어 파일을 순서대로 이어 붙이고 `/b/<name>.js` 로 낸다. 이미 하는 일(해시·`.gz` 바이트를 한 번만 만들어 기억, `static_assets.rs:3`)에 얹는다. 파일 사이에 `/* ==== js/… ==== */` 경계를 남긴다(하네스와 같은 규약). 판 해시에 묶음 정의도 넣는다.
3. **등록부와 로더(프론트)** — `js/core/screens.js`. `boot` 묶음 안, 렌더러와 `screen-life.js` 앞이다.
   - `Screens.register(name, {bundle, css, tab})` — 이름과 싣기 정보. `tab(at)` 은 이 화면이 맡는 탭인가를 답한다.
   - `Screens.forTab(at)` — 탭을 맡는 화면 이름(없으면 null, 부팅 묶음에 있다).
   - `Screens.load(name)` → Promise. 같은 이름은 같은 Promise 를 나눈다. `<link>` 와 `<script src="b/<bundle>.js?v=…">`(클래식 스크립트, FR-SPA-6)를 붙이고 둘 다 끝나면 푼다. 실패는 기억하지 않고 URL 을 바꿔 다시 시도한다(`loadCodeMirror` 와 같은 규약).
   - `Screens.ready(name)` — 동기 질문. 이미 실렸는가.
4. **진입점** — 화면 클래스를 동기로 만드는 자리가 대상이다.
   - 렌더러 `_mountTabBody`: 묶음이 아직이면 그 자리에 **자리표시**(빈 상태 킷 `.ui-empty.ui-empty-center` + 문구 `core.screen_loading`)를 붙이고 `Screens.load` 를 건다. 다 실리면 `app.render()` 한 번. 렌더러는 계속 동기다.
   - 메뉴·단축키·서버 명령(`tool-cmd.js`)·모달 여는 자리: 진입 함수 첫 줄에서 `await Screens.load(…)`. `edOpenFile` 은 이미 async 다.
   - App 생성자의 화면 컨트롤러(설정·채팅·간선·Run 등)는 "부팅에 남는 얇은 껍데기(상태·토픽 연결) + 묶음에 든 본체" 로 나눈다. 어디까지가 껍데기인지는 3.4.4 게이트가 알려 준다.
5. **경계 게이트** — `scripts/check-lazy-boundary.mjs`(가칭). 부팅 묶음 파일이 화면 묶음의 전역(클래스·상수·함수)을 참조하면 실패한다. 허용은 등록된 진입점(앞 줄에서 `Screens.load` 를 기다린 함수)뿐이다. 이것이 "옮겼더니 런타임에서 `ReferenceError`" 를 미리 잡는다(`check-load-order.mjs` 머리말의 같은 함정).
6. **언어 한 벌** — `b/pre.js` 바로 뒤의 인라인 한 줄이 `I18N.locale`(pre 의 `i18n.js` 가 정함)로 활성 언어 파일 하나만 `document.write` 로 싣는다(D-M3-6). head 인라인은 `lang` 속성만 정한다. (정정 2026-11-25, PERF 3.4.11 — 처음 안은 "head 인라인". `i18n.js` 뒤여야 해서 body 끝이 됐다) 언어 바꾸기는 지금처럼 새로고침이다.

**묶음 경계(첫 제안, 숫자는 압축 전)**

| 묶음 | 들어갈 것 | 대략 크기 |
|---|---|---|
| `boot` | 창·탭·터미널·목록 패널, 채널, 상태 줄, 껍데기 컨트롤러, `tool-cmd.js` | 나머지 전부 |
| `git` | `js/git/*` 56개, `constants-git*.js` 9개, `style-git*.css` 4개 | 약 680 KB + 상수 |
| `editor` | `file-editor*`·`cm-*`·`editor-*` 중 화면 부분·`file-tree-*`·LSP, `constants-editor`·`constants-explorer`, `style-editor*.css` | 약 440 KB |
| `docrender` | `doc-render*`, vendor `markdown-it`·`purify`·`highlight`, `constants-docrender`, `style-docrender.css` | 약 320 KB |
| `run` | `run-dashboard`·`run-tree`·Run 그래프, `style-runs.css` | 약 80 KB |
| `settings` | `settings-*` 섹션 30개(설정 창 본체) | 약 200 KB |
| `chat`·`edges` | 채팅 화면, 간선 화면 | 약 60 KB |

**묶음 경계(구현 결과, 2026-11-25 PERF 3.4.11 — `web/bundles.txt`, 숫자는 주석 걷기 전 원본 바이트)**

| 묶음 | 든 것 | 원본 크기 |
|---|---|---|
| `pre` | error-log·pref-store·panel-dock·i18n.js 4개 | 20,859 B |
| `boot` | 나머지 175개. git 의 `api.js`·`status-hub.js`, `constants-git.js`·`constants-git-detect.js`, `constants-editor.js`, 공용 CodeMirror 층(`cm-*`·`file-editor-find`·`file-editor-diff`·`cm-buffer`), 화면 껍데기(Run 목록·채팅 컨트롤러·설정 컨트롤러)가 여기 남는다 | 1,790,432 B |
| `git` | `js/git` 54개, `constants-git*.js` 7개, `style-git*.css` 4개 | 859,501 B(CSS 93,637 포함) |
| `editor` | `constants-explorer.js`, `file-editor*` 7개(화면 부분), `file-tree*` 11개 — 19개. `style-editor*.css` 는 Repo 사이드·터미널 복사창 규칙이 섞여 부팅 CSS 에 남는다 | 203,094 B |
| `docrender` | vendor `highlight`, `constants-docrender`, `doc-render*` 3개, `style-docrender.css`. markdown-it·DOMPurify 는 터미널·편집기 링크와 LSP hover 가 써서 부팅에 남는다(3.4.8) | 172,056 B |
| `run` | `run-view*`·`run-graph-fit`·`run-dashboard`·`run-tree*`·`run-recover` 7개, `style-run-view.css`. `style-runs.css` 는 활동 패널 목록이 써서 부팅이다 | 77,308 B |
| `settings` | 설정 모달·섹션·`settings-open.js`(처음 열 때 세우기)·간선 망 그림 `edges-mesh-view.js` — 23개. 간선 화면은 설정 ▸ Edges 탭이라 따로 묶지 않았다(D-41) | 147,459 B |
| `chat` | `chat-views.js` 1개 | 9,195 B |

- 모두 빼면 부팅 JS 는 주석을 둔 채로 **약 1.9~2.0 MB** 로 예상한다. 1.5 MB 에는 못 미친다. 주석(48%)을 묶음에서 걷으면 **약 1.2~1.3 MB** 로 예상한다(D-M3-7).
  - 실측(PERF 3.4.10): 나눈 뒤 **2,505,579 B**, 주석·줄 끝 공백을 걷은 뒤 **1,543,764 B**. 예상보다 큰 것은 markdown-it·DOMPurify(144 KB)가 부팅에 남고, 묶음 밖에서 부팅 때 실리는 양(vendor 8·`ko.js`·head 3)이 약 0.69 MB 이기 때문이다. 목표는 D-42 로 1.55 MB 가 됐고, 1.5 MB 아래로는 3.4.12 가 다시 한다.
- 부팅 요청은 HTML 1 + CSS 약 11 + JS 약 12(vendor 6·head 3·언어 1·`boot` 1·기타) + 그 밖 약 19(아이콘·매니페스트·API) ≈ **45 안팎**으로 예상한다. 80 이하다.

**하위 이슈**

| ID | 제목 | 내용 | deps | 크기 | 병렬 |
|---|---|---|---|---|---|
| 3.4.1 | 부팅 지표 재기 | `scenario.mjs` boot 단계에 **부팅 JS 바이트**(스크립트 응답의 풀린 크기 합, CDP `Network.dataReceived.dataLength`), 요청 종류별 수, 부팅 중 16 ms 초과 작업 수(트레이스 `RunTask` — `longtask` 는 50 ms 이상만 보고해 쓰지 않았다, 정정 PERF 3.4.11)를 더한다. 지금 값을 기준선으로 적는다 | — | S | 예(첫 번째) |
| 3.4.2 | 서버 묶음 서빙 | 묶음 정의 파일, `/b/<name>.js` 이어 붙이기·ETag·gz, 판 해시에 정의 포함, 소스맵(줄 오프셋만), `pre`·`boot` 둘로 index.html 정리(처음 안은 `boot` 하나). `check-load-order` 가 정의 파일을 읽게 고친다 | 3.4.1 | M | 3.5.1·3.6.1 과 병렬 |
| 3.4.3 | 등록부·로더·자리표시 | `Screens` 와 렌더러 자리표시 + 다시 그리기. 아직 어떤 화면도 옮기지 않는다(빈 묶음으로 시험) | 3.4.2 | M | — |
| 3.4.4 | 경계 게이트 | `check-lazy-boundary.mjs` 와 진입점 허용 목록 | 3.4.2 | S | 3.4.3 과 병렬 |
| 3.4.5 | 언어 한 벌 | 인라인 한 줄(구현은 `b/pre.js` 뒤)에서 활성 언어 파일 하나만 싣는다 | 3.4.2 | S | 3.4.3 과 병렬 |
| 3.4.6 | git 묶음 | git 화면·상수·CSS 를 옮기고 진입점에 `Screens.load` | 3.4.3·3.4.4 | L | 3.4.7~9 와 병렬(정의 파일 병합은 조정자가 차례로) |
| 3.4.7 | 편집기·탐색기 묶음 | 위와 같다. `FileTree` 는 편집기 창이 만든다(`core/editor-open.js:347`) | 3.4.3·3.4.4 | L | 예 |
| 3.4.8 | 문서 렌더 묶음 | vendor 셋 포함(구현은 highlight 만 — markdown-it·DOMPurify 는 부팅에 남음) | 3.4.3·3.4.4 | M | 예 |
| 3.4.9 | 설정·Run·채팅·간선 묶음 | App 생성자의 컨트롤러를 껍데기/본체로 나눈다. 설정 창 `initModal` 을 처음 열 때로(구현은 `settingsBuild`, 3.4.9.1·3.4.9.2 로 나뉨) | 3.4.3·3.4.4 | L | 예 |
| 3.4.10 | 묶음의 주석 걷기 | 3.4.6~9 뒤 재서 1.5 MB 를 넘을 때만(D-35) | 3.4.6~9 | M | — |
| 3.4.11 | 재측정·문서 정합 | SRS §7 에 M3 값, FR-SPA-1·2 상태 | 전부 | S | — |

**RED 로 쓸 핵심 시험**

- 서버(Rust 단위): 묶음 바이트 = 정의 순서대로 이은 파일 + 경계 줄. 정의에 없는 이름은 404. 묶음 안 파일 하나가 바뀌면 판이 바뀐다. gz 를 받는 클라이언트에 `Content-Encoding: gzip`.
- 프론트(하네스 단위, 가짜 `document`): 같은 이름을 두 번 `load` 하면 `<script>` 는 하나. 실패하면 reject 하고 다음 `load` 는 새 URL 로 다시 붙인다. CSS 와 JS 가 둘 다 끝나야 푼다. 등록되지 않은 이름은 reject.
- 게이트: 부팅 파일이 화면 묶음의 `const` 를 로드 시점이나 진입점 밖 함수에서 읽는 고정 예제가 실패한다.
- e2e(SRS §6): 부팅 때 `b/git.js` 요청이 없다 → git 창을 열면 실리고 그려진다. 부팅 때 복원된 git 탭이 있으면 자리표시 뒤 그려진다. `locale=en` 이면 `ko.js` 요청이 없고 화면이 영어다.

**목표를 재는 법**

- 부팅 요청(NFR-PRF-11): 지금처럼 `scenario.mjs` 의 `requests`(이동부터 `#boot` 사라짐 + 2초까지).
- 부팅 JS(NFR-PRF-12): 3.4.1 에서 더하는 "스크립트 응답의 풀린 바이트 합". 같은 구간이다. 숫자 정의(주석을 걷은 바이트를 그대로 세는가)는 D-M3-7 이 정한다.
- 둘 다 3.4.1 에서 기준선을 다시 잰다(지금 SRS 값 332·3.8 MB 는 M1 시점이다).

### 3.5 생명주기 wake/sleep (FR-SPA-3)

**모양(권장안 기준)**

1. **계약** — 탭 본문의 주인이 갖는 메서드 넷: `mount(host)`·`wake()`·`sleep()`·`unmount()`. 기반 클래스를 강제하지 않는다(D-M3-9). `View` 에는 기본 구현을 둔다.
2. **깬 동안만 사는 것** — `Component` 에 `awake(fn)` 을 더한다. `fn` 은 깰 때마다 불려 구독·타이머·관측을 건다. 그 안에서 건 것은 `sleep` 때 모두 걷힌다(깬 동안의 주인은 `Awake` 인스턴스다. `Component` 하위이고 `parent` 로 본 주인을 가리킨다 — `core/base/component.js`. 정정 PERF 3.4.11, 처음 안은 `{owner: this, phase:'awake'}` 객체). `Component` 가 아닌 주인(`TerminalTool` 등)은 같은 일을 하는 작은 도우미 `Awake` 를 쓴다.
3. **누가 정하는가** — 렌더러 한 자리. 그릴 때마다 렌더러가 "이번에 붙은 본문 집합"(`_mounted`, `Map<요소, 주인>`)에서 보이는 주인을 모아 `ScreenLife.commit`(`ui/screen-life.js`)에 넘기고, `ScreenLife` 가 지난 집합과 견주어 새로 보인 것은 `wake`, 빠진 것은 `sleep` 예약을 건다. 브라우저 탭 숨김은 `TimerHub` 의 `visibilitychange` 신호(`onVisibility`)에서 받는다 — 생명주기용 새 리스너를 두지 않는다. 앱의 `visibilitychange` 리스너는 이것 말고도 `EventBus.startLifecycle`·`VersionWatch` 에 하나씩 있다. (정정 PERF 3.4.11)
4. **지연** — `sleep` 은 곧바로가 아니라 `SCREEN_SLEEP_MS`(2초, D-16 과 같은 값) 뒤다. 그 안에 다시 보이면 취소한다. 터미널의 `term.close` 도 이 길을 탄다(2.5 가 그 안을 채운다).
5. **깰 때** — 잠든 동안 놓친 상태는 다시 받아 그린다. 토픽은 다시 구독하면 서버가 최신 전체 값이나 이어지는 변화량을 준다(FR-CON-4). 화면은 `wake` 에서 한 번 `render` 한다.
6. **시험용 관측** — `app.testing.sleepers()`: 잠든 주인 목록과 각자의 남은 타이머·구독 수(`TIMERS.pending()`·`channel` 의 주인별 수).

**하위 이슈**

| ID | 제목 | 내용 | deps | 크기 | 병렬 |
|---|---|---|---|---|---|
| 3.5.1 | 생명주기 기반 | 계약·`awake`·렌더러 전이·지연·브라우저 탭 숨김 신호·시험용 관측. 화면은 아직 옮기지 않는다 | — (3.4 와 무관) | M | 3.4.2·3.6.1 과 병렬. 2.5 와의 순서는 D-M3-10 |
| 3.5.2 | git·Run·채팅 화면 적용 | `git:<root>`·`gitconsole:<root>`·`run:<id>` 구독과 화면 타이머를 `awake` 로 옮긴다. git 의 `pollOkAny` 판정을 이 신호로 바꾼다 | 3.5.1 | M | 3.5.3 과 병렬 |
| 3.5.3 | 편집기·문서 렌더 적용 | 찾기 계산(`TIMERS.after`·`defer`, 3.3)·LSP 진단 표시·미니맵 나눠 그리기를 잠든 동안 멈춘다 | 3.5.1 | M | 예 |
| 3.5.4 | 브라우저 탭 숨김 규칙 | D-M3-8 의 선택대로. 터미널 쪽은 2.5 가 끝난 뒤 | 3.5.1·2.5 | S | — |

**RED 로 쓸 핵심 시험**

- 단위(하네스): 전이 `mount→wake→sleep→wake→unmount`. `sleep` 을 두 번 불러도 한 번만 걷는다. `awake` 안에서 건 구독·타이머가 `sleep` 뒤 0, `wake` 뒤 다시 1. 지연 안에 다시 보이면 `sleep` 이 불리지 않는다. `unmount` 는 잠든 상태에서도 모두 놓는다.
- e2e(SRS §6 "잠든 화면의 타이머 0"): git 창을 열었다가 다른 탭으로 바꾸고 2초 뒤 → 그 패널 주인의 타이머 0, 채널의 `git:<root>` 구독 0(다른 칸에서 보지 않을 때). 다시 열면 상태가 서버와 같다.
- e2e: 브라우저 탭 숨김 뒤 D-M3-8 의 규칙대로 잠든다. 숨김은 `visibilitychange` 신호를 흉내 내고(`document.hidden`·`visibilityState` 를 덮고 이벤트를 냄) 그 뒤 경로(TimerHub → ScreenLife → `term.close` → 깨움 스냅숏)는 실제로 돈다. 러너에서 실제 숨김은 불가하다 — 시도한 방법: 새 탭+`bringToFront`, CDP `Browser.setWindowBounds` 최소화, 헤드리스 셸·새 헤드리스(풀 Chromium)·헤드풀, 백그라운드 억제 플래그 제거, 포커스 에뮬레이션 끔(2026-11-25 실측, 사용자 수용).

### 3.6 프레임 스케줄러 (FR-SPA-4)

**모양(권장안 기준)**

- `TimerHub.frame(fn, opts)` 의 옵션을 넓힌다. 기존 호출 28곳은 고치지 않아도 지금처럼 돈다.
  - `key` — 같은 프레임에 같은 키가 또 오면 앞의 것을 버리고 마지막 것만 돈다(합치기).
  - `prio` — `'input'`(입력 반응) > `'term'`(깬 터미널) > `'normal'`(기본) > `'idle'`(비필수).
  - 예산 — 한 프레임에 rAF 는 하나만 건다. 그 안에서 우선순위대로 돌린다. `'idle'` 은 프레임 시작부터 8 ms(`FRAME_BUDGET_MS`)를 넘었거나 `navigator.scheduling.isInputPending()` 이 참이면 다음 프레임으로 미룬다. 미루기는 `FRAME_IDLE_MAX_DEFER`(6) 프레임까지이고 그 뒤에는 돈다 — 입력이 이어져도 굶지 않는다(3.6.2, 정정 PERF 3.4.11). `'input'`·`'term'`·`'normal'` 은 미루지 않는다(화면이 틀리면 안 된다).
  - 주인 정리(`disposeOwner`)·`pending()` 은 지금처럼 모든 대기 작업을 본다.
- xterm 자신의 그리기는 vendor 안의 rAF 다. 순서를 바꿀 수 없다. 대신 우리 쪽 비필수 일이 같은 프레임을 오래 잡지 않게 해서 "깬 터미널이 먼저" 를 지킨다.
- 측정된 자리에 적용한다.
  - 부팅: `_afterLayout` 에서 `open`·`doFit` 은 그 프레임에 하고, `syncGpu(true)` 는 칸마다 `'idle'` 프레임(`coalesce:'gpu'`, 주인은 그 칸)으로 미룬다(`_gpuLater`). 붙이기 전의 `doFit` 은 WebGL 칸 크기 예측값으로 잰다(D-40 A안). **부팅 때만** — 보이는 터미널이 처음 선 렌더 한 번에서만 미루고, 그 뒤 렌더(탭 전환 등)는 그 프레임에 `syncGpu(true)` → `doFit` 이다(사용자 결정, D-40). 첫 페인트는 DOM 렌더러로 그리고 WebGL 은 뒤 프레임에서 붙는다. (정정 PERF 3.4.11 — 처음 안은 키 `gpu:<id>`, 모든 렌더)
  - `tabsFit`: ResizeObserver·패널이 부를 때 곧바로 재지 않고 `frame(…, {key:'tabsFit:<줄 번호>'})` 로 미룬다. 줄 번호는 `TabBar.fitSeq` 로 인스턴스마다 나눈다. 한 프레임에 탭 줄마다 한 번만 잰다.
  - 파일 열기 `edOpenFile`: 먼저 트레이스로 세 부분(`tabsFit`·`apiSend`·`_placeLayout`)을 나눠 잰 뒤, 레이아웃 읽기를 같은 프레임의 쓰기 뒤로 모은다. (정정 PERF 3.4.11 — 3.6.3 이 예열 뒤 다시 재 보니 `edOpenFile` 은 8~9 ms 였다. 67~74 ms 는 CpuProfiler 시작 비용이 얹힌 측정 잡음이라 세 부분 나눠 재기의 근거는 약했다)

**하위 이슈**

| ID | 제목 | 내용 | deps | 크기 | 병렬 |
|---|---|---|---|---|---|
| 3.6.1 | `TimerHub.frame` 확장 | 한 rAF 묶음, `key`, `prio`, 8 ms 예산, `isInputPending` | — (3.4 와 무관) | S~M | 3.4.2·3.5.1 과 병렬 |
| 3.6.2 | 부팅 적용 | `_afterLayout` 의 GPU 붙이기 나누기, `tabsFit` 합치기 | 3.6.1·3.4.1 | M | 3.6.3 과 병렬 |
| 3.6.3 | 파일 열기 적용 | `edOpenFile` 을 나눠 재고 16 ms 초과를 줄인다(67~74 ms 는 측정 잡음, 실제 8~9 ms — 정정 PERF 3.4.11) | 3.6.1 | M | 예 |

**RED 로 쓸 핵심 시험**

- 단위(하네스, 가짜 rAF·시계): 같은 `key` 두 번 → 한 번 돈다(마지막 것). 순서는 `input > term > normal > idle`. `idle` 이 예산을 넘으면 남은 것은 다음 프레임. `isInputPending` 이 참이면 `idle` 을 돌리지 않는다. 주인을 정리하면 대기 중인 프레임 작업도 사라진다. 옵션 없는 호출은 지금과 같은 순서로 돈다.
- 단위: 탭 줄 하나에 ResizeObserver 콜백이 한 프레임에 다섯 번 와도 `tabsFit` 은 한 번.
- 측정(3.4.1 의 boot 지표): 부팅 16 ms 초과 작업 수. 지금 4건(최대 28 ms) → 목표는 **1건 이하, 최대 16 ms 대**(제안, 확정은 3.6.2 착수 때 기준선을 다시 재고 정한다). 파일 열기는 3.7 의 측정 스크립트로 `edOpenFile` 작업 길이.
  - 정정(PERF 3.4.11): 3.6.2 가 예열 뒤 다시 잰 기준선은 칸 3개 1~2건(최대 38~63 ms), 칸 1개 1~2건이었다. 적용 뒤 칸 3개 1건(최대 20~27 ms), 칸 1개 0~1건이다(부하 아래 값, 3.6.2 측정 표). "지금 4건(최대 28 ms)" 은 3.1 의 값이다.

### 3.7 순서와 병렬 한눈에

```
3.4.1 ─┬─ 3.4.2 ─┬─ 3.4.3 ─┬─ 3.4.6 git ──────┐
       │         ├─ 3.4.4 ─┤  3.4.7 편집기 ───┤
       │         └─ 3.4.5  │  3.4.8 문서 렌더 ┼─ (3.4.10) ─ 3.4.11
       │                   └─ 3.4.9 설정 등 ──┘
       └─ 3.6.2 (3.6.1 뒤)
3.5.1 ─┬─ 3.5.2      3.6.1 ─┬─ 3.6.2
       ├─ 3.5.3             └─ 3.6.3
       └─ 3.5.4 (2.5 뒤)
```

- 이슈 3.5·3.6 의 deps 를 3.4 에서 뗐다(승인). 3.5.1·3.6.1 은 묶음과 무관하다.
- **렌더러 파일 병합 순서(권장)**: 3.4.3·3.5.1·3.6.2 가 `web/js/ui/renderer-pane.js`·`renderer-layout.js` 를 함께 만진다. **3.5.1 → 3.4.3 → 3.6.2** 차례로 병합한다.
  - 3.5.1 이 먼저다. 렌더러의 "이번에 붙은 본문 집합" 비교(`_mounted`)와 전이 호출을 세운다. 이 자리는 2.5(터미널 잠듦)도 딛는다(D-38).
  - 3.4.3 이 다음이다. `_mountTabBody` 의 자리표시는 "아직 실리지 않은 본문" 이다. 3.5.1 의 전이에서 자리표시는 `wake`·`sleep` 대상이 아니라는 규칙을 그 위에서 더한다.
  - 3.6.2 가 마지막이다. `_afterLayout` 의 `syncGpu`·`doFit` 을 프레임 우선순위로 나눈다. 앞의 둘이 붙인 본문 집합이 정해진 뒤라야 무엇을 미룰지 판단할 수 있다.
  - 셋을 동시에 진행해도 된다. 뒤에 병합하는 쪽이 앞의 것 위로 다시 맞춘다(rebase).
- 묶음 정의 파일은 3.4.6~9 가 모두 고친다. 파일 목록을 옮기는 일이라 충돌은 작지만 병합은 차례로 한다.

## 4. 결정 (확정 2026-11-25)

모두 권장안으로 확정했다. 아래 각 항목의 표는 당시 선택지와 근거를 그대로 남긴다.

| 이 문서 | SRS | 확정 |
|---|---|---|
| D-M3-1 | D-29 | 서버가 시작할 때 묶음을 이어 붙여 `/b/<name>.js` |
| D-M3-2 | D-30 | `await Screens.load(name)` + 렌더러 자리표시 뒤 다시 그리기 |
| D-M3-3 | D-31 | 미리 싣지 않는다. 복원된 탭의 묶음만 부팅 때 |
| D-M3-4 | D-32 | 상수 파일을 이름 그대로 그 화면 묶음 맨 앞으로 |
| D-M3-5 | D-33 | 묶음 정의 파일이 로드 순서의 한 자리, 하네스 그대로 |
| D-M3-6 | D-34 | head 인라인이 활성 언어 하나만 `document.write` |
| D-M3-7 | D-35 | 나눈 뒤 재고, 1.5 MB 를 넘으면 서버 묶음에서 주석 걷기 |
| D-M3-8 | D-36 | 가려지면 2초 뒤 잠. 브라우저 탭 숨김은 터미널 밖 2초·터미널 30초 |
| D-M3-9 | D-37 | 계약(메서드 넷) + `awake` 도우미 |
| D-M3-10 | D-38 | 3.5.1 먼저, 2.5 는 그 위에 |
| D-M3-11 | D-39 | `TimerHub.frame` 을 넓히고 측정된 자리에만. FR-SPA-4 문구 개정 |
| D-M3-12 | D-40 | GPU 붙이기를 첫 페인트 뒤로 |
| (3.4.9.2) | D-41 | 설정 창·간선 망 그림은 `settings` 묶음, 처음 열 때. 간선은 따로 묶지 않는다 |
| (3.4.10) | D-42 | 주석과 줄 끝 공백만 걷는다. NFR-PRF-12 목표 1.55 MB |

구현 중 바뀐 것(2026-11-25 정합, PERF 3.4.11): D-29 의 부팅 묶음은 `pre`·`boot` 둘이 됐다. D-34 의 언어 인라인은 head 가 아니라 `b/pre.js` 뒤다. D-32(D-M3-4)에서 부팅 코드가 읽는 상수 파일(`constants-git.js`·`constants-git-detect.js`·`constants-editor.js`)은 boot 에 남았다. D-35(D-M3-7)는 D-42 로 이어졌다.

FR-SPA-3("화면(View)" → "화면(탭 본문의 주인)", D-37)과 FR-SPA-4(D-39)의 문구를 SRS 에서 개정 표시와 함께 고쳤다.

### D-M3-1 지연 로딩 단위 — 묶음 파일인가, 파일 목록인가

| 선택지 | 내용 |
|---|---|
| **A. 서버가 묶음을 만든다 (권장)** | 묶음 정의 한 파일. 서버가 시작할 때 이어 붙여 `/b/<name>.js` 로 낸다. 부팅 스크립트도 `boot` 하나다 |
| B. 빌드 스크립트가 묶음 파일을 만들어 커밋 | `scripts/build-bundles.mjs` 출력을 저장소에 둔다(CodeMirror 묶음과 같은 방식) + 동기화 게이트 |
| C. 파일 목록을 차례로 싣는다 | 묶음 없음. 등록부가 파일 이름 목록을 `async=false` 로 붙인다 |

- 근거: C 는 부팅 스크립트가 약 185개 남아 요청 80 에 닿지 못한다. B 는 에이전트 여럿이 함께 일하는 이 저장소에서 생성 파일이 커밋마다 충돌하고, 소스만 고치고 다시 만들기를 잊는 일이 생긴다. A 는 소스가 그대로 진실이고, 개발 빌드(`rust_embed` 가 디스크에서 읽음)에서도 바로 반영된다. 하네스는 소스를 읽으므로 영향이 없다.
- 위험: MEDIUM. 묶음 안 한 파일이 로드 중에 던지면 같은 묶음의 뒤 파일도 서지 않는다(지금은 파일마다 따로 죽는다). 오류 줄 번호가 묶음 기준이 된다 → 서버가 줄 오프셋 소스맵을 함께 낸다.

### D-M3-2 로더 API 와 진입 방식

| 선택지 | 내용 |
|---|---|
| **A. 등록부 + `await Screens.load(name)` + 렌더러 자리표시 (권장)** | 렌더러는 동기로 남고, 아직 안 실린 화면 자리에 자리표시를 두었다가 다 실리면 다시 그린다. 다른 진입점은 첫 줄에서 기다린다 |
| B. 진입점마다 따로 로더 | `loadCodeMirror` 를 화면마다 복제 |
| C. 부팅 뒤 유휴 때 모두 미리 싣고 진입점은 그대로 동기 | 진입점을 고치지 않는다 |

- 근거: B 는 같은 규약(나눈 Promise·재시도·CSS)이 여러 벌 생긴다(TimerHub 가 없앤 바로 그 모양). C 는 부팅 요청 수는 맞추지만 부팅 직후의 파싱·힙은 그대로이고, 미리 싣기 전에 열면 `ReferenceError` 다.
- 위험: MEDIUM. 진입점을 빠뜨리면 런타임 오류다 → 경계 게이트(3.4.4)가 막는다.

### D-M3-3 미리 싣기

| 선택지 | 내용 |
|---|---|
| **A. 하지 않는다 — 처음 열 때만, 부팅 때 복원된 탭의 묶음은 바로 싣는다 (권장)** | 가장 단순하다 |
| B. 부팅 뒤 유휴 때 모두 | 처음 여는 지연이 없다 |
| C. 사용 기록으로 고른 묶음만 | 최근 연 화면 |

- 근거: B 는 힙(NFR-PRF-9 60 MB)과 remote 대역을 다시 쓴다. 처음 여는 지연은 로컬에서 수십 ms, remote(150 ms)에서 git 묶음 약 0.3~0.5초로 예상한다. 3.4.6 에서 재 보고 길면 C 를 더한다.
- 위험: LOW.

### D-M3-4 상수 파일을 어떻게 나누는가

| 선택지 | 내용 |
|---|---|
| **A. 파일 단위로 그 화면 묶음의 맨 앞에 옮긴다 (권장)** | `constants-git*.js` 9개·`constants-editor`·`constants-explorer`·`constants-docrender` 를 이름 그대로 옮긴다. 부팅 코드가 읽는 상수는 게이트가 찾아 부팅 쪽 상수 파일로 옮긴다. (구현 결과: `constants-git*.js` 가운데 7개가 `git` 묶음, `constants-explorer` 가 `editor` 묶음, `constants-docrender` 가 `docrender` 묶음으로 갔다. `constants-git.js`·`constants-git-detect.js`·`constants-editor.js` 는 부팅이 읽는 상수를 받는 쪽으로 boot 에 남았다 — 3.4.6·3.4.7, 정정 PERF 3.4.11) |
| B. 상수는 모두 부팅에 남긴다 | 약 210 KB 가 남는다 |
| C. 화면 상수를 함수 뒤로 감싸 늦게 평가 | `gitConst().X` 꼴 |

- 근거: 상수는 함수가 불리지 않아도 데이터로 쓰인다(SPA_PROFILE §4 주의). A 는 이름·내용을 바꾸지 않고 자리만 옮긴다. C 는 호출처 수백 곳이 바뀐다. B 는 1.5 MB 목표를 더 멀게 한다.
- 위험: LOW(게이트가 있으면). 상수 파일이 `t('…')` 를 로드 시점에 읽으므로 언어 파일이 묶음보다 먼저 서 있어야 한다 — 부팅 때 이미 서 있으므로 지켜진다.

### D-M3-5 시험 하네스·게이트 영향

| 선택지 | 내용 |
|---|---|
| **A. 묶음 정의 파일을 로드 순서의 한 자리로 삼는다 (권장)** | `check-load-order` 는 index.html 대신 정의 파일(`boot` 다음 각 묶음)을 읽는다. 하네스의 묶음 상수(`HELPERS`·`TERM_PANE` 등)와 `load(files)` 는 그대로 둔다 |
| B. 하네스도 정의 파일에서 목록을 읽게 바꾼다 | 하네스의 손 목록을 없앤다 |

- 근거: FR-SPA-6 은 하네스를 유지하라고 한다. 하네스는 "검사 대상이 실제로 무엇에 기대는지" 를 보이려고 일부러 최소 목록을 쓴다(`harness.mjs:297~301`). B 는 그 규약을 깬다.
- 함께 바뀌는 것: e2e 가운데 화면을 열기 전에 그 화면의 전역(`window.X`)을 부르는 스펙은 깨진다. `app.testing.loadScreen(name)` 도우미(TC-FEA-3 규약의 이름, 처음 안은 `app.testing.load` — 정정 PERF 3.4.11)를 두고 그 스펙만 고친다. 영향 받는 스펙 수는 3.4.3 에서 센다.
- 위험: LOW.

### D-M3-6 언어 파일 한 벌만 싣기

| 선택지 | 내용 |
|---|---|
| **A. head 인라인이 활성 언어 파일 하나를 `document.write` 로 싣는다 (권장)** | 지금 두 줄(`web/index.html:948~949`)을 인라인 한 줄로 바꾼다. 파서가 그 자리에서 멈추고 실으므로 순서(`i18n.js` 뒤, 상수 앞)가 그대로다 |
| B. 서버가 쿠키를 보고 index 를 바꾼다 | 로케일 거울을 쿠키에도 둔다. 서버가 `__LOCALE__` 을 채운다 |
| C. 부팅 묶음을 언어별 두 벌로 | `boot.ko.js`·`boot.en.js`, 고르는 방법은 A 와 같다 |

- 근거: 동적으로 붙인 `<script>` 는 파서가 넣은 스크립트와 순서를 맞출 수 없다. A 는 순서 계약을 건드리지 않는 가장 작은 변경이다. Chromium 이 막는 `document.write` 스크립트는 다른 출처·느린 망뿐이다(같은 출처는 해당 없음). CSP 해시는 서버가 다시 만든다. B 는 index 가 쿠키마다 달라져 캐시·ETag 규약이 늘어난다.
- 바뀌는 동작: 영어일 때 영어 카탈로그에 없는 키는 지금 한국어로 폴백한다(`i18n.js:37~46`). 한국어 파일을 싣지 않으면 키 자체가 보인다. `check-i18n.mjs` 가 두 카탈로그의 키 집합이 같음을 이미 막으므로 실제로는 생기지 않는다.
- 언어 바꾸기: 지금처럼 새로고침이다(D-B-1). 바뀌지 않는다.
- 위험: LOW.

### D-M3-7 부팅 JS 1.5 MB 와 주석

| 선택지 | 내용 |
|---|---|
| **A. 화면 묶음을 먼저 나누고 다시 잰다. 1.5 MB 를 넘으면 서버 묶음에서 주석을 걷는다 (권장)** | 걷기는 3.4.10. 묶음의 토큰 열이 원본 토큰 열과 같은지 e2e 하나가 espree 로 견준다 |
| B. 주석은 걷지 않고 목표를 고친다 | NFR-PRF-12 를 "2.0 MB" 또는 "주석을 뺀 바이트" 로 |
| C. 주석은 걷지 않고 `js/core` 를 더 쪼갠다 | 메뉴·원격·도움말 등 |

- 근거: 앱 JS 의 48% 가 주석이다. 화면 묶음을 모두 빼도 주석을 둔 채로 약 1.9~2.0 MB 로 예상한다. C 만으로는 닿기 어렵다. 걷기는 전송·파싱 바이트를 줄이지만 바이너리·소스의 주석은 그대로 남는다.
- 결과(PERF 3.4.10, 정정 3.4.11): 나눈 뒤 실측 2,505,579 B, 주석·줄 끝 공백을 걷은 뒤 1,543,764 B 로 1.5 MB 에 닿지 않았다(markdown-it·DOMPurify 부팅 잔류, 묶음 밖 약 0.69 MB). 목표를 1.55 MB 로 고쳤다(D-42). 1.5 MB 아래는 3.4.12.
- 위험: A — MEDIUM. 정규식 리터럴·템플릿 문자열 안의 `//`·`/*` 를 잘못 걷으면 코드가 깨진다. 토큰 비교 시험이 이것을 막는다. 소스맵의 줄 맞춤이 어려워지므로 걷을 때는 줄바꿈을 남겨 줄 번호를 지킨다.

### D-M3-8 잠든 화면의 정의 (D-M2-2 에서 넘어온 것 포함)

| 선택지 | 내용 |
|---|---|
| A. 칸·탭에서 안 보일 때만 | 브라우저 탭 숨김·창 최소화는 지금처럼 TimerHub 의 주기 작업만 멈춘다 |
| B. A + 브라우저 탭 숨김이면 모든 화면이 2초 뒤 잔다(터미널 포함) | 창 최소화·다른 창이 완전히 가림도 Chromium 에서는 숨김이다 |
| **C. A + 브라우저 탭 숨김이면 터미널 밖 화면은 2초 뒤, 터미널은 30초 뒤 잔다 (권장)** | 짧게 다른 창을 봤다 돌아오는 경우는 그대로, 오래 둔 탭만 터미널 출력을 끊는다 |

- 근거: 창·탭이 많은 상황(D-1)에서 숨은 브라우저 탭마다 보이는 터미널의 출력을 계속 해석한다. B 는 이것을 가장 많이 줄이지만, 잠깐 다른 앱을 봤다 돌아올 때마다 보이는 터미널 전부가 비었다가 스냅숏으로 다시 그려진다. 또 잠든 동안 온 내려받기 요청(OSC 777)은 버려진다(D-24). C 는 이 둘을 30초 밖으로 밀어낸다.
- 위험: MEDIUM. 30초 넘게 숨겼다 돌아오면 깨우는 동안(NFR-PRF-14, p95 100 ms) 화면이 잠깐 빈다. 30초 값은 상수로 두고 설정으로 내지 않는다(필요해지면 그때).

### D-M3-9 생명주기를 누가 지니는가

| 선택지 | 내용 |
|---|---|
| **A. 계약(메서드 넷) + `awake` 도우미 (권장)** | 탭 본문의 주인이 지금 클래스 그대로 메서드를 갖는다 |
| B. 탭 본문의 주인을 모두 `View` 하위로 옮긴다 | `TerminalTool`·`FileEditor`·`DocRender`·`GitPanel`·`RunsPanel` |

- 근거: FR-SPA-3 은 "화면(View)" 이라 적었지만 실제 탭 본문의 주인 다섯은 View 가 아니다(§2.2). B 는 생명주기와 무관한 큰 구조 변경이다. A 로 시작하고, 각 클래스가 따로 View 로 옮겨질 때 기본 구현을 받는다.
- 위험: LOW.

### D-M3-10 3.5.1 과 M2 2.5(터미널 깨움·잠듦)의 순서

| 선택지 | 내용 |
|---|---|
| **A. 3.5.1 을 먼저 작게, 2.5 는 그 위에 (권장)** | 2.5 는 터미널의 `sleep`·`wake` 안(`term.close`·`term.open{snap}`)만 채운다 |
| B. 2.5 먼저, 3.5 가 나중에 흡수 | 2.5 가 자기 2초 지연을 만들고 3.5 가 옮긴다 |
| C. 병렬, 계약만 문서로 먼저 합의 | |

- 근거: B 는 "숨은 뒤 2초" 판정이 두 벌 생겼다가 하나로 합쳐진다(D-M2-2 가 피하려던 모양). 3.5.1 은 화면을 옮기지 않는 기반이라 작다. 다만 2.5 가 이미 착수했다면 C 로 계약만 맞춘다.
- 위험: LOW.

### D-M3-11 스케줄러 도입 범위

| 선택지 | 내용 |
|---|---|
| **A. `TimerHub.frame` 을 넓히고 측정된 자리에만 적용 (권장)** | 부팅 GPU 붙이기·`tabsFit`·파일 열기 |
| B. 모든 DOM 쓰기를 스케줄러로 | `frame` 28곳 + 동기 쓰기 전부 |
| C. 새 스케줄러 클래스를 따로 | TimerHub 옆에 |

- 근거: B 는 모든 그리기 경로의 순서를 바꾼다. 그 순서에 기대는 규약이 많다(`_afterLayout` 의 "붙은 뒤 잰다", 스크롤 복원). 측정 없이 바꾸면 이득은 모르고 위험만 크다. C 는 "모든 시간이 한 지점을 지난다"(EVENT_TIMER_HUB_SRS INV-1)와 `check-timers` 게이트를 깬다.
- 위험: LOW. FR-SPA-4 의 "DOM 쓰기는 스케줄러에 맡긴다" 를 모든 쓰기로 읽으면 A 는 부분 충족이다 → SRS 문구를 "프레임 단위 DOM 작업은 `TimerHub.frame` 을 지난다(이미 게이트로 지켜진다). 합치기·우선순위·예산은 측정된 자리에 쓴다" 로 고쳤다(2026-11-25, D-39).

### D-M3-12 GPU 붙이기를 첫 페인트 뒤로 미루는 것

| 선택지 | 내용 |
|---|---|
| **A. 미룬다 (권장)** | 첫 프레임은 DOM 렌더러, 한두 프레임 뒤 WebGL |
| B. 미루지 않는다 | 부팅 28 ms 작업이 남는다 |

- 근거: SPA_PROFILE §3 의 권장이다. 칸마다 약 12 ms 를 첫 작업에서 빼낸다.
- 위험: MEDIUM. DOM → WebGL 로 바뀌는 순간 글자 그리기가 미세하게 달라 깜빡일 수 있다. 3.6.2 의 e2e 에서 화면 비교로 확인하고, 깜빡이면 B 로 돌린다.

## 5. 위험

| 위험 | 정도 | 대응 |
|---|---|---|
| 진입점을 빠뜨려 화면을 열 때 `ReferenceError` | HIGH(게이트 없을 때) → LOW | 3.4.4 경계 게이트를 화면 묶음 이동보다 먼저 넣는다 |
| 묶음 안 한 파일의 로드 오류가 같은 묶음 전체를 멈춤 | MEDIUM | `error-log.js` 는 묶음 밖 맨 앞에 남긴다. 묶음 경계 주석·소스맵으로 위치를 찾는다 |
| App 생성자의 컨트롤러 나누기(3.4.9)가 부팅 순서를 바꿈 | MEDIUM | 껍데기는 지금 생성자 자리에 남기고 본체만 뒤로. 부팅·소프트 리로드 e2e 를 함께 돌린다 |
| 렌더러 세 파일을 3.4.3·3.5.1·3.6.2 가 함께 만짐 | MEDIUM | 병합 순서를 조정자가 정한다 |
| 깨울 때 상태를 다시 받지 못해 낡은 화면 | MEDIUM | 토픽 재구독은 서버가 최신 값을 준다. 토픽이 없는 화면(REST 로 받는 화면)은 `wake` 에서 다시 받는다. 화면마다 e2e 하나 |
| 부팅 직후 처음 여는 화면의 지연(remote) | LOW | 3.4.6 에서 재고, 길면 D-M3-3 의 C |
| 주석 걷기의 오작동 | MEDIUM | 토큰 비교 e2e. D-M3-7 이 A 일 때만 |

## 6. 비목표

- ES 모듈·번들러(esbuild 등)로 옮기기(FR-SPA-6). 이름 바꾸기·압축(minify)은 하지 않는다. 주석 걷기는 D-M3-7 의 조건부 범위뿐이다.
- CodeMirror vendor 묶음의 싣기 방식(`import()`)은 바꾸지 않는다.
- 모든 `TimerHub.frame` 호출처와 동기 DOM 쓰기를 스케줄러로 옮기기(D-M3-11).
- 탭 본문 주인의 `View` 상속 전환(D-M3-9).
- 언어를 새로고침 없이 바꾸기(D-B-1 유지).
- Worker 이전(FR-SPA-5) — 3.3 에서 Worker 대상이 아님을 확인했다.
- CSS 묶음 합치기 — 화면 CSS 는 그 화면 묶음과 함께 싣지만, 부팅 CSS 11개 남짓을 하나로 합치는 일은 요청 80 에 필요하지 않아 하지 않는다.

## 7. 코드와 어긋난 문서 (고치지 않음, 보고만)

- `web/js/test/harness.mjs:10` 은 "`<script>` 85개", `scripts/check-load-order.mjs:6` 은 "90여 개" 라고 적었다. 지금은 296개다. — 2026-11-25 두 머리말을 `web/bundles.txt` 기준으로 고쳐 해소(PERF 3.4.11).
- `perf/SPA_PROFILE_2026-11-24.md` §4 의 "300개, 3,675 KB" 와 SRS NFR-PRF-12 기준선 "3.8 MB" 는 지금 HEAD 와 다르다(296개, 3.88 MB). 3.4.1 에서 다시 잰다. — 해소: 3.4.1 이 다시 쟀고(332건·3,891,882 B), SPA_PROFILE 은 3.1 시점 측정 기록, NFR-PRF-12 기준선 열은 M0 값으로 둔다. 목표는 D-42 로 1.55 MB(PERF 3.4.11).
- 그 밖의 M3 문서 정합 목록은 `perf/M3_DOC_SYNC.md` 다.
- SRS FR-SPA-3 은 생명주기를 "화면(View)" 에 두었다. 실제 탭 본문 주인은 View 가 아니다(D-M3-9) — 2026-11-25 SRS 개정으로 해소.
- 이슈 3.5·3.6 의 deps 는 3.4 였지만 기반 작업(3.5.1·3.6.1)은 3.4 와 무관하다(§3.7) — 2026-11-25 이슈 갱신으로 해소.
