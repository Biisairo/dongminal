# 02 — 프론트엔드 아키텍처 · JS 코드 품질 · 리팩터링 기회

대상: `web/index.html`, `web/js/**` (core 33 · ui 23 · git 27 파일, 35,120 LOC). read-only 분석.
도구 메모: Serena 프로젝트가 비활성 상태(`No active project`)라 심볼 탐색은 CLI(grep/sed) 폴백으로 수행했다. 모든 근거는 실제로 읽은 줄이다.

## 0. 부팅 흐름 요약 (사실 관계)

- 모듈 시스템 없음. `index.html:470-594` 에 **classic `<script>` 93개**가 순차 로드된다 (`defer`/`async`/`type=module` 0개). 번들러·빌드 없음 (`scripts/build.sh` 는 Go 만, 프론트는 `go:embed`).
- 로드 순서가 곧 의존 순서다. `index.html` 의 주석이 그것을 문장으로 지킨다 (예: 479-482, 489-495, 499-507, 514-520, 573-585). 검사기는 없다.
- 진입: `core/main.js:4-33` — `new App()` → `window.app` → `/api/settings` 적용(`_settingsApply`) 과 `app.init()` 을 `Promise.allSettled` 로 기다려 `BootScreen.done()`.
- `App` 은 `core/app.js` 의 클래스 하나이고, 22개 `core/app-*.js` 가 `Object.assign(App.prototype, {...})` 로 증강한다 (grep: 22 파일 · 26 지점).
- 시간·전파는 `core/timer-hub.js`(`TIMERS` 전역 단일 인스턴스, 385줄) 와 `core/event-bus.js`(SSE + pub/sub, 319줄) 둘로 모였고, `state-registry.js:33-128` 가 7개 상태의 복원·병합·이벤트를 선언 데이터로 갖는다. `scripts/check-timers.sh` 가 원시 `setTimeout/setInterval/rAF/EventSource` 를 CI 에서 금지한다 (예외: timer-hub, event-bus, diag). 이 축은 설계·구현·게이트가 일치한다.
- 상태의 진실: 워크스페이스는 `app.ws` 하나 (서버 `/api/workspace` 가 권위, ETag/409 로 충돌 해소 `app.js:377-566`). 설정은 `helpers.js`/`constants.js` 의 **전역 `var`** 들(`statusBar`, `shortcuts`, `agentsPollInterval`…)에 `_settingsApply` 가 얹는다.

---

## P0

### [P0] 터미널 출력 → 상태바 innerHTML 로 스크립트 주입 (XSS)
- 위치:
  - 싱크: `web/js/core/app-statusbar.js:75-79` (`push('cwd', \`<span class="sb-item">📁 ${short}</span>\`)`), `:82` (hostname), `:66` (`title="dmctl 대상: ${loc}"`), 최종 삽입 `:119-122` (`t.innerHTML=i.html`).
  - 소스 1: `web/js/ui/term-pane.js:665-686` — **모든 터미널 출력 청크**에서 `/\x1b\]777;(\w+);([^\x07]*)\x07/g` 를 찾아 `Cwd` 면 `_onCwd(val)` → `app._cwd=cwd; app._updateStatusBar()`.
  - 소스 2: `app-statusbar.js:340` `/api/cwd` 응답의 실제 디렉터리 이름.
  - 이 파일에 `escHtml` 호출 0건 (`grep -c escHtml core/app-statusbar.js` = 0). 기본값 on (`core/helpers.js:353 cwd:{def:true}`).
- 현상: 셸에서 도는 **어떤 프로그램이든** `printf '\e]777;Cwd;<img src=x onerror=…>\a'` 한 줄로 웹 UI 문서 컨텍스트에서 JS 를 실행시킨다. `cat` 한 파일, `curl` 응답, SSH 원격 호스트의 프롬프트, 에이전트 출력 전부가 소스다. 디렉터리 이름에 `<` 가 들어 있어도(POSIX 허용) `/api/cwd` 경로로 같은 결과.
- 왜 프로덕션 문제인가: 이 UI 는 터미널·파일 시스템·git 쓰기·설정(ACL 포함) API 에 세션으로 닿는다. XSS = 원격 코드 실행에 준한다. `--expose` + Tailscale 환경에서 원격 호스트가 보낸 바이트 하나가 로컬 머신을 넘긴다. `index.html` 에 CSP 가 없어 2차 방어도 없다 (CSP 는 `/api/file/raw` 에만, `internal/webserver/httpapi/handlers_file_probe.go:168`).
- 조치: `_updateStatusBar` 의 `push()` 를 문자열 조립에서 `document.createElement` + `textContent` 로 바꾸거나, 최소한 모든 보간값을 `escHtml()` 로 감싼다(`_locationLabel`·`_stats.*` 포함 — 값의 출처가 아니라 싱크에서 막는다). e2e 에 `\e]777;Cwd;<img onerror>` 를 쏘는 회귀 테스트 추가. 추가로 `index.html` 에 CSP(`script-src 'self' https://cdn.jsdelivr.net`) 를 Go 쪽과 협의해 건다.
- 규모: S (싱크 수정) / M (CSP 포함).

### [P0] 부팅 실패 시 워크스페이스를 빈 판으로 덮어쓴다 (데이터 손실)
- 위치: `web/js/core/app.js:210-213` (`catch(e){ console.error(...); if(!this.ws.windows.length) await this._mkWindow(); }`) → `core/app-layout.js:117-160` `_mkWindow` 가 `this._save()` 호출(`:160`) → `app.js:388-389` `if(this.wsETag) headers['If-Match']=this.wsETag` — 실패 경로에선 `wsETag` 가 `null` 이라 **If-Match 없이 PUT**.
- 서버 확인: `internal/shared/workspace/manager.go:212` `if ifMatch != "" { …stale 검사… }` — 헤더가 비면 검사를 **건너뛰고 저장한다**.
- 현상: `/api/state` 가 일시적으로 5xx 를 주거나(데몬 재접속 중, `_fetchStateKnown` 의 `res.ok` 거짓 → `stRes.json()` 예외), 네트워크가 잠깐 끊긴 채 페이지가 열리면, 브라우저는 창 1개짜리 새 워크스페이스를 만들어 If-Match 없이 밀어 넣는다. 서버의 모든 창·핀·편집기 목록이 사라진다. `_save` 의 409 방어(`app.js:400-516`)는 If-Match 가 있을 때만 작동한다.
- 왜 프로덕션 문제인가: 복구 불가능한 사용자 상태 손실이며, 발생 조건(부팅 순간의 일시 장애)이 흔하다 — 서버 재시작 직후 자동 새로고침(`version-watch.js`)이 정확히 그 순간에 페이지를 다시 연다.
- 조치: (1) init 실패 시 `_save()` 를 금지 — `_mkWindow(opts)` 에 `{noSave:true}` 를 주거나 `wsETag===null` 이면 `_save` 가 PUT 을 거부하고 재조회부터 하게 한다. (2) 서버도 `If-Match` 부재를 거부(또는 `*` 만 허용)하도록 Go 감사 축과 조율. (3) 실패를 사용자에게 보인다(현재 `console.error` 뿐).
- 규모: S (클라이언트 가드) / S (서버 정책).

---

## P1

### [P1] 전역 스크립트 93개 · 암묵적 로드 순서 · ~1,600개 전역 바인딩
- 위치: `web/index.html:470-594`; 최상위 선언 수 `constants-git.js` 445, `constants-git-actions.js` 211, `constants-editor.js` 184, `constants.js` 155, `helpers.js` 77 (grep `^(const|let|var|class|function)`). 가변 전역 `var/let` 27개 (`helpers.js` 16, `constants-git.js` 3, `constants.js` 2 …), 이들을 다른 파일이 직접 대입한다 (`app-polling.js:36-70` `set:v=>{agentsPollInterval=v}`, `app-settings.js:343-345`).
- 현상: 모든 파일이 하나의 전역 렉시컬 스코프를 공유한다. 이름 충돌은 현재 0건(검사함)이지만 그것을 지키는 도구가 없다. `window.*` 명시 export 도 34개(대부분 `git/` 클래스: `GitHistory`, `GitBranches`… + `__dmReloading`, `__dongminalDebug`, `__dmAssetVersion`)로 관례가 두 벌이다 — 어떤 클래스는 `window.X=` 로, 어떤 것은 최상위 `class` 바인딩으로 노출.
- 왜 문제인가: 스크립트 한 줄을 옮기면 조용히 `ReferenceError`(런타임에만, 해당 경로가 실행될 때만). `FR-WBR-95` 가 기록한 "typeof 가드가 삼킨 결함" 이 바로 이 구조의 산물이다. 93개 순차 동기 스크립트는 첫 페인트도 늦춘다 (부팅 화면이 그것을 가리기 위해 존재한다, `index.html:83-106`).
- 조치: 단기 — `scripts/check-timers.sh` 와 같은 형태로 **로드 순서 검사기**(각 파일이 참조하는 상위 식별자가 앞선 스크립트에서 선언됐는지) 또는 eslint `no-undef` + `globals` 파일. 중기 — `type="module"` 로 점진 전환(순수 함수 파일 `hunk-coords.js`, `lanes.js`, `repaint.js`, `api.js` 부터).
- 규모: M (검사기) / L (모듈 전환).

### [P1] 계층 역전 — ui/·git/ 가 App 의 `_private` 를 직접 파고든다
- 위치 (distinct `app._xxx` 참조 수): `ui/renderer.js` 54, `ui/sidebar-tabs.js` 29, `ui/input-binding.js` 20, `ui/file-editor.js` 13, `git/panel-diff.js` 11, `ui/file-tree-edit.js` 8 … (git/ 전체 26개 distinct, ui/ 전체 60+). `window.app` 직접 참조 30건 (`ui/term-pane.js`, `ui/doc-render.js:414`, `git/dialog.js`, `git/history.js`, `git/menu.js`, `git/confirm.js` …).
- 현상: `docs/internal/architecture.md` 는 core/ui/git 을 디렉터리로 나눴지만, 언더스코어 메서드가 사실상 공개 API 다. `renderer.js` 는 `app._drag`, `app._mPaneIdx`, `app._prevFocus` 같은 **필드**까지 읽고 쓴다. `state-registry.js:136-161` 도 문자열 메서드 이름(`'_attnRestore'`)으로 App 을 호출한다.
- 왜 문제인가: App 내부 이름 변경이 3개 디렉터리 60+ 지점을 깨뜨리고, 어느 것이 계약인지 알 수 없다. 타입·린트가 없으므로 오타는 런타임까지 간다.
- 조치: App 의 공개 표면을 명시(`_` 없는 메서드로 승격 + 문서화)하거나, ui/git 가 필요한 것을 생성자 인자(콜백/인터페이스)로 받게 한다. 첫 단계로 `renderer.js` 가 쓰는 54개를 목록화해 `AppView` 인터페이스 하나로 묶는다.
- 규모: L.

### [P1] 린트·타입 안전망 전무 (35k LOC)
- 위치: 루트에 `.eslintrc*`/`eslint.config.*`/`tsconfig.json`/`jsconfig.json` 없음; `package.json` devDependency 는 `@playwright/test` 뿐; `// @ts-check` 0 파일; JSDoc `@param/@returns/@typedef` 총 9건; `.github/workflows/verify.yml` 은 Go build/vet/test + `check-seams.sh`/`check-timers.sh` 만 돌리고 Playwright 는 CI 에 없다.
- 현상: 프론트의 유일한 안전망은 로컬에서 수동 실행하는 e2e 135 스펙이다. 순수 함수 모듈(`hunk-coords.js` 5 함수, `lanes.js`, `repaint.js`, `helpers.js` 의 path/shortcut 함수)에 단위 테스트 0.
- 조치: (1) `jsconfig.json` + `checkJs` 와 `// @ts-check` 를 파일 단위로 점진 도입 — 전역 스크립트 구조에서도 `no-undef` 급 오류를 잡는다. (2) eslint 최소 규칙(`no-undef`, `no-unused-vars`, `no-empty`). (3) `node --test` 로 순수 모듈 단위 테스트(의존성 0). (4) verify.yml 에 최소 smoke e2e 1개.
- 규모: M.

### [P1] Monaco 를 런타임에 외부 CDN 에서 받는다
- 위치: `web/js/ui/file-editor.js:5` `MONACO_CDN='https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs'`, `:64-81` 로더 (SRI 없음).
- 현상: 나머지 자산은 전부 `go:embed` + `web/vendor/`(xterm, markdown-it, purify, highlight) 로 오프라인인데 편집기만 인터넷이 필요하다. Tailscale 전용·폐쇄망에서 편집기·LSP 뷰가 통째로 서지 않는다. 서드파티 CDN 이 곧 스크립트 공급망이다.
- 조치: `web/vendor/monaco/` 로 벤더링(라이선스 MIT). 크기가 부담이면 최소 언어 세트만. 그 전까지라도 SRI 는 AMD 로더 구조상 어려우므로 벤더링이 답이다.
- 규모: M.

### [P1] 조용히 삼켜지는 실패 — 설정 저장·부팅 설정·초기화
- 위치:
  - `core/app-settings.js:15` `_saveSettings`: `try{await fetch('/api/settings',{method:'PUT',…})}catch{}` — 실패해도 UI 는 저장된 것처럼 보인다. 응답 `ok` 도 보지 않는다.
  - `core/main.js:14-21` 설정 로드 실패 `catch{}` — 테마·단축키·폴링이 기본값으로 조용히 떨어진다.
  - `core/app.js:210-213` init 실패 → `console.error` 만.
  - `core/app-statusbar.js:41-44` stats 실패 `catch{}` (이건 허용 가능).
  - 전체: 빈 `catch{}` 122건. 대부분은 `sessionStorage`/`ws.close()` 같은 무해한 것이지만(`term-pane.js` 19, `app-layout.js` 11 확인), 위 셋은 사용자 결과가 달라진다.
- 조치: `_saveSettings` 는 `res.ok` 검사 + 실패 시 `Toast.show(..,'err')`; main.js 설정 실패는 부팅 화면 문구로 알림; init 실패는 P0-2 와 함께 처리.
- 규모: S.

### [P1] fetch 관용구 중복 — `gitFetch` 가 있는데 core 는 손으로 23벌
- 위치: `core/` 와 `ui/` 에 `await fetch(` 51곳; `catch{r=null}` 23건, `catch{d=null}` 25건, `'Content-Type':'application/json'` 24건 (예: `core/app-lsp.js:44-47,143-146,206-209,397-400,452-455`, `core/app-editor.js:109-110,864-867,890-891,1043-1045,1099-1102`). `git/api.js:1-31` 의 주석이 이 반복이 "버그 부류" 임을 스스로 적고 있다 — 그러나 git 밖에는 적용되지 않았다.
- 현상: 타임아웃(`AbortSignal.timeout`) 은 TimerHub 의 `ctx.fetch` 를 쓸 때만 붙고(4곳), 나머지 47곳은 무한 대기. 에러 본문 처리·JSON 파싱 실패·`ok` 판정이 자리마다 다르다.
- 조치: `git/api.js` 의 `gitFetch/gitPost` 를 `core/api.js` 로 일반화(`apiGet/apiPost`: 타임아웃·JSON·`{ok,data,status}`)하고 core/ui 호출부를 옮긴다. 기계적 치환이라 리스크 낮음.
- 규모: M.

---

## P2 (카테고리별)

### A. 거대 모듈 분리 지점 (6건)
1. `core/constants-git.js` (1282줄): 문자열 상수 328 + 객체 44 + 배열 15. 섹션 헤더가 이미 탭 단위다 (`:86` 사이드바, `:123` Changes, `:229` 스테이징, `:478` 커밋, `:545` 확인, `:656` Diff, `:742` Console, `:766` History, `:931` Branches, `:1016` Stash, `:1053` 원격, `:1165` Worktrees, `:1202` Submodules). UI 문구·CSS 클래스 맵·주기 상수(`:97,620`)·툴팁(`:452`)이 섞여 있다. → 탭별 파일 또는 문구/동작 상수 분리. 규모 S(기계적).
2. `git/history.js` (1274줄, 61 메서드): 가상 목록(`:513-620, 1228-1247`), refs 바(`:403-512`), 인라인 상세(`:790-884`), 로딩·검색·점프(`:893-1227`) 네 책임. → `HistoryRows`/`HistoryRefs`/`HistoryDetail` 로 분할. M.
3. `core/app-editor.js` (1155줄, 67 메서드가 `App.prototype` 에): 창 재조정(`:15-300`), 트리/스토어(`:493-660`), fs 변경(`:861-1030`), 서버 목록 동기(`:1053-1122`). → `EditorWorkspace` 클래스로 추출하고 App 은 위임. M.
4. `core/app-settings.js` (1000줄, 38 메서드): 테마(`:517-660`), 단축키(`:660-720`), 샌드박스(`:721-822`), ACL(`:823-1000`) 등 서로 무관한 패널이 한 파일. → 패널별 `settings-*.js`. S.
5. `git/branches.js` (990줄): 한 파일에 클래스 4개 (`:18 GitBranches`, `:800 GitBranchCreate`, `:900 GitBranchRename`, `:941 GitBranchUpstream`) + `_load` 한 메서드가 `:395-799` 400줄. → 다이얼로그 3개를 `branches-dialogs.js` 로, `_load` 를 파싱/그룹핑 순수 함수로. M.
6. `ui/renderer.js` (1160줄, 35 메서드): 응집도는 있으나 `render()`(`:134-160`) 가 사이드바·토프바·레이아웃·상태바·git 워치독을 **매번** 전부 지난다. 호출 지점 54곳, 합치기 없음. → `requestRender()` 를 `timers.frame({coalesce})` 로 감싸 같은 틱의 중복 렌더를 접는다. S.

### B. XSS 잠재 싱크·이스케이프 일관성 (3건)
1. `core/app-tool.js:369-378` `_confirmClose(msg,opts)`: `${msg}`·`${opts.bgLabel}` 를 이스케이프 없이 innerHTML. 현재 호출 4곳(`app-layout.js:189,200,546,567`)은 상수만 넘기지만, 바로 위 `_notify`(`:18-22`) 는 같은 이유로 `textContent` 를 쓴다고 주석에 적고 있다 — API 가 두 규약이다. → `textContent`. S.
2. `escHtml` 사용이 `core/app-lsp.js`(8), `ui/file-editor*.js`(7), `core/app-edsearch.js`(3) 에만 있고 `git/` 는 0건 — git/ 는 골격만 innerHTML 로 세우고 값은 `textContent` 로 넣는 규약(`history.js:735-742`, `remote.js:669-680`, `confirm.js:261`)이라 지금은 안전하다. 그러나 규약이 문서·검사기로 고정돼 있지 않다. → `check-timers.sh` 식으로 "`innerHTML` 에 `${`/`+변수` 가 들어간 줄" 을 잡는 `check-html.sh`. S.
3. `core/app-settings.js:981` `this._aclYou`(서버가 준 접속 IP) 를 innerHTML 에 연결. 서버 신뢰값이라 위험은 낮지만 같은 규약 위반. S.

### C. 하드코딩·상수 불일치 (5건)
1. 사이드바 폭 상·하한 `100/400` 리터럴 3곳: `index.html:27`, `core/app.js:171`, `core/app-cmd.js:370`. 상수 없음.
2. 저장소 키 리터럴: `'sidebarWidth'` 4곳(`index.html:27`, `ui/input-binding.js:110`, `core/app-cmd.js:372`, `core/app.js:173`) — `SIDEBAR_COLLAPSED_KEY` 는 상수인데 폭 키는 아니다; `sessionStorage.setItem('activeWindow', …)` 14곳; `index.html:34` 의 `'dm.themeVars'` 는 `constants.js:31 THEME_VARS_KEY` 와 손으로 동기 (주석으로만 고정).
3. `document.getElementById('…')` 182회 전부 리터럴; `index.html` id 158개. JS 만 참조하는 id 4개(`bg-modal`, `mkb-tip`, `runs-modal`, `ui-size-hud`)는 동적 생성이라 정상.
4. `core/app-statusbar.js:72` `cwd.replace(/^\/Users\/[^/]+/,'~')` — macOS 홈 경로만 축약. 프로젝트는 linux/windows 도 빌드 대상(`scripts/build.sh` TARGETS).
5. `_fmtBytes` 두 벌: `ui/file-editor.js:294`, `core/app-statusbar.js:316` (+ `doc-render.js` 의 `docFmtBytes`). `ETag||Etag` 헤더 이중 조회 4곳(`app.js:138,422,518` …).

### D. 상태 관리·이벤트 버스 (3건)
1. 설정이 전역 `var` 26개에 흩어져 있고(`helpers.js`, `constants.js`) `_settingsApply`(`app-settings.js:321-436`) 가 키마다 `if(saved.x!==undefined)` 분기를 손으로 쓴다 — `POLL_SETTINGS` 표처럼 나머지 설정도 서술자 표로 통일하면 `_saveSettings` 의 24개 키 나열(`:15`)도 파생된다. M.
2. 버스 토픽은 문자열 하드코딩: `'workspace_changed'`, `'server_hello'`, `'run_changed'`, `'sse:open'`, `'softreload'` (`app-cmd.js:64-78`, `state-registry.js:43-126`, `event-bus.js:179-222`). `LIFE_*` 만 상수. 서버 action 이름과 같은 공간을 쓰는 함정을 `event-bus.js:24-38` 주석이 경고하지만 상수화로 막지는 않았다. S.
3. `helpers.js:752 visiblePoll` 이 TimerHub 이후에도 4곳에서 쓰인다(`app-statusbar.js:30` 등) — 같은 일을 하는 표면이 둘(`TIMERS.every` vs `visiblePoll`). S.

### E. 성능·폴링 (3건)
1. 폴링 5종은 `app-polling.js:30-70` 표로 모여 있고 TimerHub 가 숨김 시 정지·복귀 시 1회 보상(`timer-hub.js:340-346`) — 구조 양호. 다만 `gitReposInterval`·`statsInterval` 최소 선택지 1초; 상태바는 3초마다 `/api/ping` + `/api/stats` 2요청(`app-statusbar.js:33-44`). 항목 단위 reconcile(`:119`)로 리페인트는 억제됨.
2. 디바운스는 `git/panel-poll.js:225` 한 곳뿐. `render()` 54 호출 지점 합치기 없음(A-6 참조). 리사이즈는 `_scheduleFit` 으로 접힘(`main.js:122`).
3. xterm `scrollback:50000`(`constants.js:246`) × 슬롯당 인스턴스(`app.js:284-297` 주석: 같은 도구를 두 슬롯에 그리면 인스턴스·WebSocket 둘). 탭이 많을 때 메모리 상한 없음.

### F. 이벤트 리스너 (1건, 확인 결과 양호)
- `addEventListener` 375 vs `removeEventListener` 19 이지만, 검사한 document/window 수준 리스너는 앱 수명(`event-bus.js:149-155`, `timer-hub.js:38`, `app-focus.js:113-119`) 이거나 `{once:true}`(`app-slots.js:424`, `app-attn.js:437-438`) 이거나 짝이 맞는다 (`ui-kit.js:332-340`, `git/menu.js:381-394`, `app-tool.js` keydown 4/4, `git/dialog.js`, `git/confirm.js`). 요소 수준 리스너는 DOM 과 함께 GC. `app-settings.js:478` 의 document keydown 은 `_initModal` 1회 등록. 누수 발견 없음.

### G. 테스트 (1건)
- e2e 135 스펙(Playwright)이 사실상 유일한 검증이고 CI 에 없다. 순수 모듈(`hunk-coords.js`, `lanes.js`, `repaint.js`, `helpers.js` path/shortcut, `git/api.js` 의 `gitEchoOk`)은 `node --test` 로 의존성 없이 단위 테스트 가능. S.

---

## 우선 실행 순서 제안
1. P0-1 상태바 싱크 수정 + 회귀 e2e (S, 즉시)
2. P0-2 init 실패 경로 `_save` 차단 + 서버 If-Match 필수화 (S, Go 축과 함께)
3. P1 `_saveSettings` 실패 피드백 (S)
4. `check-html.sh`(innerHTML 보간 검사) + eslint `no-undef` (M) — 이후 모든 리팩터의 안전망
5. `core/api.js` 로 fetch 관용구 통합 (M)
6. Monaco 벤더링 (M)
7. 거대 모듈 분리는 4 이후에 (A-1, A-4 먼저 — 기계적)
