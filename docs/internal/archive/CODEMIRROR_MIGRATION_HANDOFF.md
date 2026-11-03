# 인계: 편집기 엔진 교체 (Monaco → CodeMirror 6) — 단계 A 완료·`main` 합침, 단계 B 부터

> 작성: 2026-11-03 · 단계 A 는 `main` 에 합쳤다(`af77ddd1`) · 근거 SRS `docs/internal/CODEMIRROR_MIGRATION_SRS.md`

## 착수 블록 (이번 세션의 지시 전부)

1. 이 문서를 끝까지 읽는다. 그다음 SRS 의 §7 · §7.1 · §7.3 · §8 · §3.15 · §11.7 을 읽는다.
2. `git status` 와 `git log --oneline -8` 로 출발점을 확인한다.
3. **단계 A 는 끝났고 `main` 에 합쳤다**(M1~M9, SRS §7.3). 다음 일은 단계 B(M10~)다. 착수 전에 §8 의 질문 5건을 하나씩 묻는다(권장 답과 함께). 따로 남은 것: windows CI 의 `file-path-link` TC-FPL-5(터미널, M9 와 무관).
4. 커밋은 사용자 확인 후에만, AI 서명 금지.

## 어디까지 왔나

| 마일스톤 | 상태 | 근거 |
|---|---|---|
| M1~M5 | 완료 | `6633910c` · `a81a3920` · `e5d03f72` · `ef0d5953` · `6971b5ee` |
| M6 Git Diff 뷰 | 완료 | `b1418594`(WIP) + `b195ab47` |
| M7 sticky scroll | 완료 | `eb16d707` |
| **M8 LSP (S·W·L + FR-CMR-23)** | **완료** — L3·S·L1·L2·T·W·R | `8213444d`(L3·S) + L1 WIP 커밋 · SRS §11.6 |
| M9 Monaco 제거 | **완료** — G·X1·X2·X3·V·N | SRS §11.7 · §7.3 |

마지막 e2e 측정(M7, 45개 파일): 544건 중 통과 522 · 실패 22. 실패는 모두 §7.2 표의 M8(21건) · M9(1건) 몫이다.

### M8 에서 한 일 (커밋됨, 이 세션)

- 결정 8건 → SRS 반영 (FR-CMR-90·91·92·93·100·102 개정, §3.16 7줄, §4.2·§4.3·§9, §11.6). 요지: 페이지마다 (루트, 서술자)당 WS 하나 · 상한이면 거절(4001), LRU 는 통로를 못 빼앗음 · 프레임마다 touch · 진단 토글은 처리기에서 · **정의·참조는 라이브러리 명령·패널, `_lspList`·뒤로 가기(`edNavBack`) 제거** · **LSP 기능 e2e 는 실제 gopls, 가짜는 실패 주입만** · Monaco 전용 e2e 개념은 지운다
- L3: `lspOfferFor` 가드 `_editor` → `_view`. 단위 `lsp-offer.test.mjs` 6건. 설치 띠 e2e 4건이 풀렸다
- S: `domain/lsp/tunnel.go` (`OpenTunnel`·`Tunnel`·`ErrLimit`, 상한 합산·REST 만 LRU·Sweep·Shutdown), `ext.Service.ResolveID`, `httpapi/handlers_lsp_ws.go` (`GET /api/lsp/ws`, close 4001 `limit`·4002 사유·4003 `ended`, 읽기 한도 1009). Go 테스트 `tunnel_test.go` 10건 · `handlers_lsp_ws_test.go` 8건. `docs/external/api.md` 에 종단
- L1: `web/js/ui/cm-lsp.js` (`edLspUri`·`edLspPath`·`edLspLangId`·`edLspServerReply`·`edLspWorkspaceClass`·`EdLspSocket`·`EdLspConn`), `lsp-client.js` 의 정의·참조 구간 교체(`lspExtFor`·`_lspConn`·`_lspRun`·`_lspDisplay`·`_lspClickExt`), `cm-setup.js` `cmp.lsp` + `edCmLspAttach`, `FileEditor.whenView()`·`_lspAttach()`, Diff 는 `_bindEdit` 에서 붙인다. URI 벡터 `internal/shared/platform/testdata/file_uri_vectors.json`(Go `TestFileURIVectorsShared` 와 JS 가 함께 읽는다). 단위 `cm-lsp.test.mjs` 22건. 상수 `LSP_WS_*`·`ED_LSP_TIMEOUT_MS`·`ED_LSP_RETRY_MS` 는 `constants-editor.js`
- L2: `EdBuffer.diagnostics`·`setDiagnostics`·`sinks`(편집을 따라 위치를 옮기고, 디스크 재읽기면 비운다), `cm-lsp.js` 의 `edLspDiagItems`·`edLspDiagShow`·`edLspDiagnostics`(라이브러리 `serverDiagnostics` 의 능력·autoSync 를 쓰고 처리기만 바꾼다), Workspace `hooks.joined`, `_lspSetDiag` 는 레지스트리의 모든 버퍼를 다시 그린다. 어댑터 `edT.diagnostics`·`docDiagnostics`·`docSetDiagnostic` CodeMirror 갈래. 단위 13건 추가. `slot-view-state` E-9.1 이 풀렸다. 실제 gopls 스모크(진단 표시·끄기/켜기·고친 뒤 걷힘) 통과. `editor-lsp-nav` 남은 14건 실패는 모두 T 몫(REST stub · hub seam `lspOnDiagnostics` 진단 3건)
- T: `editor-lsp-nav` 를 실제 gopls 픽스처(go.mod)로 다시 썼다 — `lspTap`(`routeWebSocket` 이 실제 서버에 잇고 프레임 method 를 기록)·`ready`(첫 진단 알림) · 실패 주입 2건(4001 상한 → 알림 줄·상태 패널, 4003 끊김 → 다시 연결). `ux-batch10` 호버도 실제 gopls. `edLspCloseNote`·`_lspConnNote`(상태 패널 `.lsp-msg`)·`LSP_WS_LIMIT_NOTE`. 어댑터 `showHover` CodeMirror 갈래·`ED_SEL.refPanel`·`refItem`·`lintError`. 걷기: `edNavBack` 전부, `_lspPush`·`_lspNavBack`·`_lspCanBack`, hub seam(`_lspOnDiagnostics`·구독·`LSP_DIAG_ACTION`·`LSP_DIAG_SEVERITY`), 쓰이지 않는 LSP 상수·i18n, 문서 `shortcuts.md`·`features.md`. CI `e2e.yml` gopls v0.20.0 설치. **사용자 결정: 정의·참조 결과가 비면 아무것도 표시하지 않는다** (FR-CMR-93·§3.16)
- R: REST 4종(`definition`·`references`·`hover`·`close`)과 REST 세션 전부(`session.go`·`conn.go`·세션 표·실패 기억·LRU·확장자 표 캐시·`Resync*`·`CloseDoc`)를 걷었다. `Starter`·`StartProcess` 는 `process.go`, `pathToURI` 는 `watch.go` 로. 상한은 통로만 센다(FR-CMR-102 개정). `SetPaths` 는 값이 바뀐 서술자의 통로를 닫는다(4003 → 브라우저가 새 실행 파일로 다시 연다). hub 진단 슬롯·SSE 갈래·`OnDiagnostics` 배선 제거. 브라우저 Monaco 갈래(`lspHoverRegister` 등 11개)·접근자 `_lspHoverLangs`·`_lspDefLangs`·`lspDocClosed` 호출처·REST 상수 제거, `lsp-text-sync.test.mjs` 폐기. `api.md` 갱신. Go `TestLSP_RemovedRoutes404`·`TestSetPaths_ClosesTunnelsOfChangedDesc`
- R 에서 발견: W 의 어댑터 검사(`cmd/dongminal/lsp_watch_test.go`)가 git 을 직접 띄워 `TestNoDirectGitExecOutsidePackage`(FR-GIT-1)에 걸렸다 — `gittest` 로 바꿨다. **게이트의 `go test` 는 바뀐 패키지만이 아니라 `./...` 로 돌린다**
- e2e(M8 끝): 46개 파일 544건 중 543 통과, 실패는 `editor-find-panel` 1건(M9)
- W: `domain/lsp/watch.go` — `NotifyFiles`(루트 아래만, `WatchMax`=2000, 통로마다 순서 있는 줄 16 + 작업 goroutine, `initialized` 전에는 넣지 않음, `LastUse` 를 옮기지 않음), `RepoWatch`(`Seen` 기준선·`Changed`, HEAD 가 바뀔 때만 name-status), 순수 `repoEvents`. gitwatch 는 첫 표명에 `git_changed` 를 내지 않으므로 기준선 훅 `SetOnBaseline`(→ `Deps.OnGitBaseline` → `RepoWatch.Seen`)을 더했다. 합성 루트 `cmd/dongminal/lsp_watch.go` 의 `lspRepoView`(`Store.Observed` + `diff-tree --name-status -r -z -M`). 저장 처리기가 쓰기 전 존재 여부로 Created/Changed. 브라우저 `clientCapabilities.workspace.didChangeWatchedFiles`. e2e 2건(열지 않은 파일 저장 · 브랜치 전환 — 실제 gopls 진단이 따라 바뀐다)
- e2e(W 끝): 46개 파일 545건 중 544 통과, 실패는 `editor-find-panel` 1건(M9)
- e2e(T 끝): 46개 파일 543건 중 541 통과. `editor-find-panel` 1건(M9)·`editor-scrollbar` 1건(띠가 thumb 를 덮음 — 스펙이 상태를 세워 고침, 반복 3회 통과)
- 실제 gopls 스모크(임시 스펙, 지움): 호버 `func helper() int` · Shift+F12 참조 2건 · F12 로 다른 파일 4줄 — 모두 동작
- e2e 지금: `editor-lsp-nav` 24건 중 15건 실패 — REST stub 검사(T 에서 실제 gopls 로 다시 쓴다)와 진단(L2). LSP 와 무관한 편집기·Diff 6개 파일 68건은 통과

### M8 남은 단위

| 단위 | 내용 |
|---|---|
| L2 | 진단: `textDocument/publishDiagnostics` 처리기(`EdLspConn` 의 `notificationHandlers` 또는 `extensions` 의 처리기)가 진단을 **문서(버퍼)에 보관**하고 그룹의 **모든 칸**에 `setDiagnostics`. `lspDiagOn` 은 처리기가 본다(꺼지면 그리지 않고 지움, 다시 켜면 보관분을 그림). autoSync(`serverDiagnostics().editorExtension`)는 늘 둔다. `slot-view-state` E-9.1 · `editor.ts` 의 `markersOf` CodeMirror 갈래(`:141`, `:295-308`)가 걸린다. 기존 `_lspOnDiagnostics`·`app.testing.lspOnDiagnostics` seam 을 어떻게 둘지 정한다 |
| T | e2e: `editor-lsp-nav` 를 실제 gopls 픽스처로 다시 쓴다(go.mod 필요, **gopls 가 패키지를 다 읽은 뒤** 검사 — 첫 진단 알림을 기다린다) · 실패 주입(상한 4001 상태 패널 표시, 끊김 뒤 재연결)은 `page.routeWebSocket` · CI `e2e.yml` 에 판 고정 gopls 설치(로컬 v0.20.0), 없으면 실패 · `edNavBack` 단축키·설정 항목·i18n·`_lspPush`/`_lspNavBack`/`_lspCanBack`·`app-edsearch.js:142` 제거 · 쓰이지 않게 된 상수(`LSP_REFS_HINT` 등) 정리 · `editor-lsp.spec.ts` 를 e2e 목록에 · `app-state-owners.test.mjs` 이름 표 갱신 |
| W | 저장 시 끼워 넣기 · `git_changed` 에서 name-status 계산 · `LSP_WATCH_MAX` (FR-CMR-110~114). `Tunnel` 에 끼워 넣기 메서드를 더한다(`Send` 와 같은 `wmu`). 브라우저 `clientCapabilities` 에 `workspace.didChangeWatchedFiles` 를 넣는다 |
| R | REST 4종·서버 문서 동기화(doclife·needText·Resync*·CloseDoc)·hub `lsp_diagnostics` 제거, `lsp-client.js` 의 Monaco 갈래(`lspHoverRegister`·`_lspOpenerRegister`·`_lspProvideDef`·`_lspHover*`·`_lspAsk`·`_lspPathOfModel`·`_lspUriPathOf`·`_lspVersionOf`·`lspDocClosed`·`lspClearDiagnostics`) 제거, `lsp-text-sync.test.mjs` 폐기. **W 뒤에 한다** |

### M6·M7 에서 한 일 (커밋됨)

- M6 마무리: `git-diff-doc` S8(Diff 수정본 쪽에 실제 키 입력 → 편집기 탭에 보이고 저장) · `ux-batch10` FR-UXB-49(원본 쪽 포커스면 찾기가 원본을 찾음) e2e 추가. §7.2 에서 Diff 문서 공유 줄·TC-MVN-16 을 지웠다
- M7: `web/js/ui/cm-sticky.js` — 순수 `edStickyLines(state, line, max)`(트리 경로 / `StreamLanguage`·언어 없음은 들여쓰기 경로) + `edCmSticky()` 확장. 편집기 칸에만(`cm-setup.js` 의 `o.diff ? [] : edCmSticky()`). 상수 `ED_STICKY_MAX`. 단위 `cm-sticky.test.mjs` 8건, e2e `editor-sticky.spec.ts` 3건, 어댑터 `ED_SEL.stickyLine`·`edT.stickyLines(h)`
- M7 사용자 결정: **Diff 에는 sticky 가 없다** (§3.16). FR-CMR-82 개정 — 고정된 줄을 누르면 커서를 그 줄로 옮기고, 고정된 줄들에 덮이지 않게 스크롤한다(`yMargin = k × 줄 높이`)
- 벤더 묶음에 `highlightTree` 를 더했다(`scripts/codemirror/entry.js`). `VENDOR_VERSIONS.md` 해시 `c94d3e217400c19f…`

## M8 조사 결과 (2026-11-02, 읽기 전용 조사)

### 지금 상태

- **브라우저 LSP 는 지금 전혀 동작하지 않는다.** `web/js/core/lsp-client.js`(702줄)는 전역 `monaco` 와 `view._editor` 를 쓴다. Monaco 는 더 실리지 않고 FileEditor 는 `_view` 만 있다. 정의·참조·호버·진단·설치 띠가 모두 조용히 빈 값이다
  - `_lspWhere`(170)가 늘 null → F12·참조가 죽는다. `lspHoverRegister`(284)·`_lspOpenerRegister`(365)는 호출처가 없다
  - `lspOfferFor`(545)는 가드 `!view._editor`(546) 때문에 늘 return → 설치 띠가 뜨지 않는다
  - `_lspOnDiagnostics`(627)는 `typeof monaco` 가드(633)로 늘 return
  - `_lspPush`·`_lspNavBack`(677·693)은 순수 JS 라 동작한다
- 호출처: 단축키 `shortcuts.js:160-163`(ED_LSP_ACTIONS) → `app.js:401-403` → `app-lsp.js:12-31` · 뒤로 가기 게이트 `app-edsearch.js:141` · 진단 구독 `app-cmd.js:126` · 토글 `app-settings.js:412-416`, 기본값 `lsp-paths.js:21`(`lspDiagOn`) · 띠 `file-editor.js:276·701·719` · 테스트 노출 `app-testing.js:115-117`
- **불일치**: `lsp-client.js:498-520` `_lspPathOfModel(model)` 은 `d.lspPathOf(model)` 로 모델을 넘긴다. `diff-view-parity.js:76-82` `lspPathOf(side)` 는 쪽 핸들을 기대한다
- 단위 테스트 `lsp-text-sync.test.mjs`(REST 판·needText — 폐기 대상) · `app-state-owners.test.mjs:24-28`(`lspHoverRegister` 등 이름 고정)

### Go 서버

- 패키지 `internal/webserver/domain/lsp/`(비테스트 1,927줄). 세션 키 (루트, 팩/서버, exe) — **루트·서버당 하나를 공유**(`manager.go:42-46`). 지연 기동, 핸드셰이크 한도 60s(`session.go:28`)
- MaxSessions=6 은 넘치면 **가장 오래 안 쓴 세션을 정지**한다 — 거절하지 않는다(`manager.go:356-381`). IdleAfter 20분·Sweep 2분은 `LastUse` 만 본다(`manager.go:429-447`)
- 문서 동기화: didOpen → 전체 텍스트 didChange, sha256 중복 방지, `ErrNeedText`(`session.go:377-428`). `ResyncPath` ← 저장(`handlers_files.go:579-580`), `ResyncRepo` ← `git_changed`(`main.go:418`, `hub/gitwatch.go:159-168`) — **열린 문서만**
- REST: `handlers_api.go:196-204`, 본체 `handlers_lsp.go`. 진단은 `main.go:367-381` → hub SSE 슬롯 `hub/commands.go:330-341`
- `git_changed` payload 는 `{repo, mark}` 뿐이다(`hub/gitwatch.go:124`) — 바뀐 파일 목록은 W 가 계산해야 한다
- WebSocket: gorilla/websocket v1.5.3. Upgrader 의 CheckOrigin 은 늘 true, Origin 판정은 requestGate(`toolhub/conn.go:65-80`, `reqgate.go:169-220`). 게이트 순서 `server.go:336`. **인증은 없다**(`server.go:316-322`). 터미널 WS 읽기 한도 1MiB(`handlers_ws.go:22`) — 재사용하지 않는다
- 가짜 서버는 Starter 주입(`session_test.go:72` fakeStarter, `manager_test.go:21`). WS Origin 테스트 본보기 `handlers_ws_test.go:532-575`

### `@codemirror/lsp-client` 6.3.0 (`scripts/codemirror/node_modules/@codemirror/lsp-client`)

- Transport 는 JSON 문자열(머리 없음) — 프레이밍은 Go 가 맡는다(FR-CMR-101 과 맞다). **initialize 를 클라이언트가 보낸다** → Go 핸드셰이크는 WS 통로에서 우회되고, `didChangeWatchedFiles` 능력은 브라우저 clientCapabilities 에 넣어야 한다
- **DefaultWorkspace 는 같은 파일의 두 번째 `openFile` 에서 throw 한다**(`index.js:278-283`). LSPPlugin 이 뷰마다 open/close 를 부른다(`index.js:96·152`) → 사용자 정의 Workspace 가 뷰 수를 센다(FR-CMR-23). `EdBuffer` 의 sink 집합(`cm-buffer.js:16-45`)이 자연스럽다
- `requestFile` 기본은 열린 파일만 — 참조 결과의 열리지 않은 파일은 조용히 빠진다(`index.js:1609-1613`). `displayFile` 은 준비된 뷰를 돌려줘야 한다 — FileEditor 생성은 비동기이고 준비 신호가 없다(`file-editor.js:379` `_pendingReveal` 뿐)
- `jumpToDefinition` 은 첫 항목만, `findReferences` 는 자체 패널 → FR-CMR-93(`_lspList`)을 지키려면 사용자 정의 명령이 필요하다
- `serverDiagnostics()` 의 editorExtension 은 `autoSync`(didChange 송신)다. Compartment 로 빼면 동기화도 멈춘다(조사자 추정, 실측 아님). 진단 적용은 `file.getView()` 한 뷰에만 간다
- 기본 timeout 3000ms — 콜드 gopls 첫 요청이 넘을 수 있다
- `sanitizeHTML` 은 클라이언트 설정. DOMPurify 3.4.15 가 `web/vendor/purify.js` 에 있다(`index.html:655`) — FR-CMR-94 는 `html => DOMPurify.sanitize(html)`

### e2e

- `editor-lsp-nav` 는 `page.route` 로 REST 를 가로챈다(`:85`, `:157-167`). WS 로 바꾸면 무효다. 진단은 `app.testing.lspOnDiagnostics` 로 직접 주입(`:570-572`) — 그 seam 은 유지할 수 있다
- 호버 "provider 1회"(`:424-516`) · 텍스트 생략(`:518-566`)은 개념이 사라진다 — 다시 쓰거나 지운다(§3.16 에 적는다)
- `e2e/editor.ts` 의 LSP 갈래(`:141` markersOf, `:295-308` 진단·`showHover`)는 Monaco 만 있다. CodeMirror 갈래를 채운다
- `slot-view-state` E-9.1 은 첫 단언에서 결정적으로 실패한다(`editor.ts:296` 이 `[]`) — 진단을 버퍼(문서)에 두면 풀린다
- 가짜 언어 서버: (a) `page.routeWebSocket`(Playwright 1.59.1 지원, 아직 쓴 적 없음) — 빠르고 결정적 / (b) `PUT /api/lsp/paths` 로 가짜 실행 파일 지정(`editor-lsp.spec.ts` 가 그 경로를 쓴다) — 프레이밍까지 실측, 가짜 바이너리가 새로 필요. 조사자 권장: 통로 한두 건만 (b), 나머지 (a)

### 제안된 분할 (조사자 안 — 확정 아님)

| 단위 | 내용 | 위험 |
|---|---|---|
| L3 | `lspOfferFor` 가드를 CodeMirror 뷰 기준으로 — 설치 띠 복구 | L |
| S1 | `/api/lsp/ws` 골격: 게이트 재사용, Starter 로 기동, Content-Length 프레이밍, 별도 읽기 한도, close reason | M |
| S2 | 프로세스 정책: 상한 거절, idle, REST 와 상한 공유 | H |
| L1 | LSPClient + WS Transport, EdBuffer 기반 Workspace, hover·정의·참조(사용자 정의 명령), URI ↔ 경로, timeout, displayFile 준비 대기 | H — 단위 테스트로 먼저 잡는다 |
| L2 | 진단: 모든 sink 에 `setDiagnostics`, 진단을 버퍼에 보관(E-9.1) | M |
| T | e2e 이관, 어댑터 CodeMirror 갈래, `app.testing` 이름·단위 테스트 정리 | M |
| W | 저장 시 끼워 넣기, `git_changed` 에서 name-status 계산, `LSP_WATCH_MAX` | M-H |
| R | REST 4종·close, doclife·needText·Resync*·CloseDoc, hub `lsp_diagnostics` 제거 | M — **반드시 W 뒤**(Resync 가 하던 "브랜치 전환 뒤 열린 문서 맞추기"가 사라진다) |

권장 순서 L3 → S1(+S2) → L1 → L2 → T → W → R.

## M8 착수 전 결정 (끝남 — 기록용)

> **2026-11-02 결정 끝** — 결과는 SRS §11.6. 6 은 라이브러리 명령·패널, 뒤로 가기 제거. 7 은 실제 gopls(가짜는 실패 주입만). 나머지는 권장 답.

1. **FR-CMR-100 의 "인증"** — 제품에 인증이 없다. 권장: "accessGate 와 requestGate 를 지난다" 로 고친다 (문구 정정, 사실 확인만 받는다)
2. **프로세스 단위 (FR-CMR-90·101)** — 연결마다 하나면 탭·창이 여럿일 때 같은 루트에 gopls 가 여럿 뜬다(수백 MB, `manager.go:14-17`). 권장: 브라우저(페이지)당 (루트, 서버) WS 하나를 공유하고 상한을 적용
3. **상한 정책 (FR-CMR-102)** — 기존 LRU 정지와 SRS 의 "거절" 이 다르다. 권장: WS 는 거절, REST 가 남아 있는 동안 LRU 가 WS 세션을 빼앗지 않는다(REST 는 R 에서 사라진다)
4. **idle (FR-CMR-102·103)** — WS 가 열려 있어도 Sweep 이 20분 뒤 죽인다. 권장: 프레임이 오갈 때 touch, 끊기면 다음 요청 때 다시 연결(FR-CMR-91)
5. **진단 토글 (FR-CMR-92)** — Compartment 로 빼면 didChange 도 멈춘다. 권장: autoSync 는 늘 두고, 알림 처리기 안에서 `lspDiagOn` 을 본다
6. **정의·참조 표시 (FR-CMR-93)** — 권장: 라이브러리 명령 대신 사용자 정의 명령으로 기존 `_lspList`·`_lspNavBack` 에 잇는다
7. **e2e 의 가짜 언어 서버** — 권장: 대부분 `routeWebSocket`, 통로 실측 한두 건은 가짜 실행 파일
8. **사라지는 e2e 개념** — 호버 provider 1회 · needText 판 생략 검사는 지우고 §3.16 에 적는다 (권장)

URI ↔ 경로 변환은 브라우저가 맡는다(FR-CMR-101 은 서버가 내용을 해석하지 않는다). Windows 규칙이 Go `platform.Paths`(`session.go:769-776`)와 같아야 한다 — 같은 테스트 벡터로 묶는다.

## M9 에서 한 일 (커밋됨)

- 결정: FR-CMR-132 에 글꼴 예외 없음(글꼴 차례에서도 뺐다) · 끝난 문서 57개는 `archive/`, 남긴 문서는 본문 수정 · `editor-find-panel` V-EFP-21 은 `ux-batch10` 의 Diff 찾기 키 검사로 대체 · 찾기는 앱 패널 유지(`@codemirror/search` 패널·keymap 을 넣지 않는다) · `GIT_DIFF_OPTIONS` → `GIT_DIFF_INLINE_BREAKPOINT` · NFR-3 은 e2e, NFR-5 는 Go
- 게이트 `scripts/check-old-editor-name.sh`(`verify.yml`). 패턴은 `m[o]naco` — 스스로 걸리지 않는다. **보관 문서의 파일 이름에 엔진 이름이 있으면 어디서 가리켜도 걸린다** — 그래서 벤더링 SRS 는 `archive/EDITOR_VENDORING_SRS.md` 로 이름을 바꿨다
- 결정 색인은 `docs/internal/*_SRS.md` 만 모은다 — 보관한 SRS 의 결정이 빠져 1,059 → 777건
- `e2e/a11y-axe.spec.ts` 는 `ACCESSIBILITY_BASELINE_SRS.md` §6 예외 표를 **경로로 읽는다** — 문서를 옮길 때 e2e 도 본다
- 측정·결과는 SRS §7.2·§7.3

## M9 (기록용 — 착수 전 메모)

`LSP_DIAG_OWNER`(`constants-editor.js`)는 e2e 어댑터의 Monaco 갈래(`markersOf`·`docSetDiagnostic`)와 `e2e/globals.d.ts` 만 읽는다 — 그 갈래와 함께 걷는다. `web/vendor/monaco/` 삭제, `static.go` 정리, `e2e/editor.ts` 의 Monaco 갈래·`probe` 제거(`editor-find-panel` "다른 Monaco 는 자기 위젯을 갖는다" 폐기·대체 — §7.2), `GIT_DIFF_OPTIONS`(e2e V-MMP-2b·editor-git-ux 가 읽는다)와 그 검사 정리, i18n `git.diff_monaco_fail` 이름 정리, 문서 개정.

## 먼저 읽을 것

- SRS — §2.3, §3.3, §3.10~§3.12, §3.16, §7.2, §11
- `web/js/core/lsp-client.js` · `web/js/ui/cm-buffer.js` · `internal/webserver/domain/lsp/manager.go`·`session.go` · `internal/webserver/httpapi/handlers_lsp.go`·`handlers_ws.go`
- `scripts/codemirror/node_modules/@codemirror/lsp-client/dist/index.d.ts`
- `e2e/editor-lsp-nav.spec.ts` · `e2e/editor.ts`

## 이 작업에서 값을 치르고 배운 것

- **`lsp-client` 6.3.0 의 `disconnect()` 는 `transport` 를 비우지 않고 `initializing` 을 새 대기 약속으로 바꾼다.** 끊기는 순간에 부르면 그 뒤 요청·알림이 영원히 기다려 다시 연결할 계기가 사라진다 → 다시 열 때 `connect()` 직전에 부른다. initialize 전에 닫히면 내부 `client.init.resolve(null)` 로 풀어야 처리되지 않은 rejection 이 남지 않는다
- **라이브러리는 서버 요청(`workspace/configuration` 등)을 모두 −32601 로 답한다** — 소켓이 가로채 Go 세션의 표대로 답한다(`edLspServerReply`)
- **gopls 는 패키지를 다 읽기 전의 호버에 빈 답을 줄 수 있다.** 실제 gopls e2e 는 준비 신호(첫 `publishDiagnostics`)를 기다린다
- **Go 핸들러 테스트에서 WS 101 은 핸들러가 다음 일을 하기 전에 온다** — 가짜에 기록된 값은 메시지가 통로에 닿은 뒤에 읽는다(데이터 경합)
- **vm 하네스의 배열·객체는 다른 realm 이다.** `assert.deepEqual` 이 프로토타입에서 걸린다 — JSON 으로 옮겨 견준다. vm 컨텍스트에는 `TextEncoder`·`URLSearchParams`·`queueMicrotask` 가 없다 — globals 로 넘긴다

- **e2e 브라우저는 Windows 로 보인다** (`navigator.platform` = `Win32`). CodeMirror 의 `Mod` 는 `Ctrl` 이다. `ControlOrMeta` 는 mac 에서 Meta 가 되어 듣지 않는다
- **contenteditable 안의 키는 전역 배선이 앱 단축키를 돌리지 않는다** (`inText`). 편집기 표면마다 capture 리스너에서 `app.edTrySearchKey(e)` 를 부른다 (`FileEditor._onKeyCapture` · `GitDiffView` 생성자). LSP 단축키(F12 등)도 같은 문제를 겪을 수 있다
- **CodeMirror 는 갱신 도중 같은 편집기에 `dispatch` 하면 거부한다.** `updateListener` 안에서 그 편집기를 고치는 일은 `queueMicrotask` 로 미룬다
- **tooltip 노드를 tooltip 사이에서 공유하면 사라진다** — tooltip 마다 그릇을 둔다
- **MergeView 의 두 편집기는 스스로 스크롤하지 않는다** — 스크롤 그릇은 `.cm-mergeView`
- **merge 의 기본 색을 이기려면 선택자를 그릇부터 적는다**. `color-mix()` 의 계산값은 `color(srgb …)` 다
- **`--term-*` 는 보정된 값이다.** 팔레트 원색이 필요하면 `themeVarsOf` 의 vars 리터럴 안에 새 변수를 두고 `style.css :root` 에 기본값을 둔다
- **클래식 스크립트의 `class`·`const` 는 `window` 의 속성이 아니다.** 어댑터에서는 `(0, eval)('typeof X === "undefined" ? null : X')`
- **zsh 는 `$var` 를 단어로 나누지 않는다.** check 목록: `grep -oE "run: (node )?scripts/check-[A-Za-z0-9_.-]+" .github/workflows/verify.yml | sed 's/^run: //' | while IFS= read -r c; do eval "$c" >/dev/null 2>&1 || echo "FAIL $c"; done`
- **e2e 를 두 벌 동시에 돌릴 때는 `DM_E2E_KEEP_PEERS=1` 과 다른 `E2E_PORT_BASE`(예: 59300)**. 돌리는 중에 작업 트리를 고치면 결과가 섞인다
- **e2e 전체**: 목록 `/tmp/cm-e2e-files.txt` 가 없으면 이 문서 아래 목록으로 만든다 (`grep '^e2e/a11y-axe' 이 문서 | tr ' ' '\n' | grep .` — 코드 블록 범위를 sed 로 자르면 여는 줄에서 끝나 빈 목록이 된다). `xargs npx playwright test --reporter=json < 목록 > /tmp/out.json` (약 12분). 집계는 `suites[].specs[].tests[].status` (`expected` 가 통과)
- **벤더 묶음을 다시 만들면** `node scripts/build-codemirror.mjs` 뒤 `bash scripts/check-vendor.sh` 가 알려 주는 집계 해시로 `VENDOR_VERSIONS.md` 를 고친다
- **단위 테스트 RED 는 빈 자리 함수로 단언 실패를 본다** (파일이 없어서 나는 실패는 RED 로 치지 않는다)
- **화면 배치는 스크린샷으로 확인한다** — M7 에서 sticky 가 미니맵을 가리는 것을 그렇게 찾았다. 임시 스펙(`e2e/zz-tmp-*.spec.ts`)으로 찍고 지운다
- **Serena 는 이 프로젝트에서 활성 프로젝트가 없다고 실패할 수 있다.** Go·JS 심볼은 Claude Code 의 LSP 도구(gopls·tsserver)가 동작한다. `Object.assign` 믹스인 메서드는 findReferences 가 놓친다 — 그때만 텍스트 검색으로 폴백한다
- 인계한 세션은 넘긴 뒤 탭을 닫으므로 `dmctl msg` 응답이 가지 않을 수 있다

## e2e 파일 목록 (46개)

```
e2e/a11y-axe.spec.ts e2e/a11y-keyboard.spec.ts e2e/codemirror-load.spec.ts e2e/doc-render.spec.ts e2e/editor-dirty-derived.spec.ts e2e/editor-dirty-diff.spec.ts e2e/editor-doc-registry.spec.ts e2e/editor-encoding.spec.ts e2e/editor-external-change.spec.ts e2e/editor-find-panel.spec.ts e2e/editor-git-ux.spec.ts e2e/editor-live-reload.spec.ts e2e/editor-lsp-nav.spec.ts e2e/editor-minimap.spec.ts e2e/editor-multi-slot.spec.ts e2e/editor-ops.spec.ts e2e/editor-replace-seed.spec.ts e2e/editor-save.spec.ts e2e/editor-scrollbar.spec.ts e2e/editor-traffic.spec.ts e2e/explorer-root-keys.spec.ts e2e/file-size-gate.spec.ts e2e/font-size.spec.ts e2e/git-diff-doc.spec.ts e2e/git-diff.spec.ts e2e/git-dir-entry.spec.ts e2e/git-history.spec.ts e2e/git-hunk.spec.ts e2e/git-stash.spec.ts e2e/git-subroot.spec.ts e2e/git-view-refresh.spec.ts e2e/git-write-order.spec.ts e2e/kit-button.spec.ts e2e/kit-components.spec.ts e2e/kit-scroll.spec.ts e2e/editor-offline.spec.ts e2e/notes-live-explorer.spec.ts e2e/repo-diff-edit.spec.ts e2e/repo-tab.spec.ts e2e/slot-view-state.spec.ts e2e/tooltips.spec.ts e2e/touch-targets.spec.ts e2e/ux-batch10.spec.ts e2e/view-scroll-restore.spec.ts e2e/editor-sticky.spec.ts e2e/editor-lsp.spec.ts
```

`editor-lsp.spec.ts` 는 M8 T 에서 더했다 (상태·경로 패널, FR-CMR-95).

## 변하지 않는 규약

- CLAUDE.md: 중·대 규모는 Spec → Test → Code. 테스트는 구현 전에 단언 실패를 확인한다. 커밋은 사용자 확인 후에만, AI 서명 금지. 마일스톤 WIP 를 이을 때는 새 커밋(amend 금지)
- 게이트: `npm run unit` · `npm run -s typecheck` · `npx eslint .` · `verify.yml` 의 `scripts/check-*` 전부 · Go 를 고치면 `go test ./internal/...` 의 해당 패키지와 `go vet`
- e2e 는 엔진에 직접 닿지 않는다 — `e2e/editor.ts` 의 `edT`·`ED_SEL` 만 쓴다 (`scripts/test/e2e-editor-boundary.test.mjs`)
- §7.2 에 없는 e2e 실패는 회귀다. 마일스톤을 커밋할 때 표를 갱신한다
- 동작이 바뀌면 SRS §3.16 에 이전 / 새 / 이유를 적는다. SRS 상태 값은 enum(`check-srs-status.sh`), `승인·구현중` 이면 `> **남은 것**:` 줄이 있어야 한다

## 아직 유효한 사용자 결정

- 대상은 CodeMirror 6. 단계 A(1:1 이전) 먼저, 단계 B 는 그 뒤. §8 의 B 단계 질문 5건은 B 착수 전에 묻는다
- 우클릭 메뉴·F1 명령 팔레트·Bat 강조는 넣지 않는다. 일부러 설정한 기능은 CodeMirror 에 없어도 직접 구현해 유지한다
- 편집기 칸의 세로 스크롤바는 직접 그린다 (FR-CMR-74). Diff 에는 미니맵도 `diffMinimap` 설정도 없다 (FR-CMR-56). **Diff 에는 sticky 도 없다** (M7)
- 같은 파일 여러 칸의 실행 취소는 칸마다 따로다. FR-CMR-23(그룹당 LSP 문서 하나)은 M8 에서 한다
- LSP 는 `@codemirror/lsp-client` + WebSocket 통로. Monaco 시절의 REST·서버 문서 동기화는 걷는다 (프로세스 단위는 위 결정 2 로 다시 묻는다)
- 열리지 않은 파일의 변경은 통로가 `didChangeWatchedFiles` 로 끼워 넣는다 — 파일 저장 + git 변화 모두
- 단계 A 는 `codemirror-migration` 브랜치에서 하고, 끝난 뒤 `main` 에 합친다
