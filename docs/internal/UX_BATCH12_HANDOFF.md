# 인계: UX_BATCH12 이어가기 (2026-11-11)

## 1. 착수 블록 — 이번 세션의 지시 전부

1. `docs/internal/UX_BATCH12_SRS.md` 를 처음부터 끝까지 읽는다. **§0 요구사항 대장**이 할 일 목록이다.
2. 대장에서 상태가 `진행 전`·`진행 중`·부분 완료인 행을 모두 `완료` 로 만든다. 남은 행: **R5 · R9 · R11 · R12 · R13(프런트) · R14 · R17**.
3. 행마다 순서는 고정이다: 스펙 확인(모자라면 SRS 를 먼저 고친다) → 실패하는 테스트(RED 확인) → 구현 → 관련 테스트 통과.
4. 행을 끝낼 때마다 대장의 상태 칸을 고친다. 사용자 지시: "요구사항 한쪽에 정리하고 스펙 제대로 써 가면서 진행해. 요구사항 준거 다 해야해. 까먹지마."
5. 모든 행이 끝나면 회귀 검사(아래 §5)를 돌리고 사용자에게 보고한다. **커밋은 사용자 확인 뒤에만** 하고, AI 서명(`Co-Authored-By` 등)을 넣지 않는다.

권장 순서: R14·R9 (클립보드 목록화가 둘의 공통 바탕) → R13 프런트 → R11(사각형 선택) → R12·R17(하이라이트) → R5(실시간 갱신 7건).

## 2. 어디까지 왔나

직전 커밋은 `91138a1c` (v1.2.6 릴리스)이다. **작업 트리에 미커밋 변경이 많다** — 지우거나 되돌리지 마라. `git status` 로 보면 아래가 나온다.

| 묶음 | 상태 | 파일 |
|---|---|---|
| R3 Run 대시보드 실시간 갱신 (`RUN_VIEW_LIVE_SRS`, 승인·구현완료) | 검증 끝 | `handlers_runs.go`·`handlers_runs_context.go`(run_changed 보강), `handlers_runs_live_test.go`, `handlers_runs_graph_test.go`(기존 시험 1건 수정), `state-registry.js`(`run.views`), `runs-panel.js`(`_runViewsRefresh`·`_onMemberActivity`), `app-runs.js`, `app-ws-sync.js`, `run-view-live.test.mjs`, `e2e/run-view-live.spec.ts`, `ORCHESTRATION_V2_SRS.md`(FR-RVZ-16 개정 주석) |
| R10 서브에이전트 목록 고정 | 검증 끝 (단위 + `activity.spec.ts` 15건) | `app-agents.js`, `app-agents-sub.js`, `pref-store.js`, `style.css`, `activity-state-subagent.test.mjs`, `e2e/activity.spec.ts` |
| R6~R8 Run 트리 미니맵·휠 줌 | 검증 끝 (`run-tree.spec.ts` 3건, 화면 확인) | `run-tree.js`, `run-tree-cam.js`(`runCamGrab`·`runCamDragTo`), `style-runs.css`, `run-tree-minimap.test.mjs`, `e2e/run-tree.spec.ts` |
| R13 서버 `GET /api/fs/download-many` | Go 시험 통과 | `handlers_fs_zip.go`(`zipWithinLimits`·`writeZipTree` 가변 인자, `apiFSDownloadMany`, `zipManyName`), `handlers_api.go`(경로 등록), `handlers_fs_zip_many_test.go` |
| 스펙 | — | `UX_BATCH12_SRS.md`, `RUN_VIEW_LIVE_SRS.md`, `decisions.md`(생성물) |

`ISSUE_TREE_OPS_SRS.md` FR-ITC-13(⌘+휠 줌)은 UX_BATCH12 FR-RMM-5 가 개정했다. 그 문서에도 개정 주석을 한 줄 넣어야 한다 — 아직 안 했다.

## 3. 이미 확인한 사실 (다시 조사하지 마라)

### Explorer (R9·R11·R13·R14)

- 파일: `web/js/ui/file-tree.js`(상태: `_sel` 앵커 + `_selSet`), `file-tree-paint.js`(`_onClick` 빈 여백 → `_selectRoot`, Shift `_selRange`, Cmd `_selToggle`, `_selTargets(fallback)` = 조상 포함 자손 제외, `_moveSel`, **`_onKey`**, `_targetDir`), `file-tree-xfer.js`(`download(p)`, **`_onCtx`** 메뉴, `copyPath(p,rel)`, `_initDnd` dragstart/dragover/drop), `file-tree-edit.js`(`doDelete(p)` 는 이미 선택 전체, `doPasteInto(dir)`, `doDuplicate(p)`, `doMoveMany(pairs)`).
- 클립보드: `core/app-editor-file.js:99` `edClipSet(root,path,move)` → `{root,path,move}` **경로 하나**. 쓰는 곳: `file-tree-edit.js` 362·392·423·424·428, `file-tree-paint.js` 379, `file-tree-xfer.js` 190·241·244·246, `e2e/editor-ops.spec.ts` 995·999(R4-6: `edClipSet(r,p,true)` 뒤 `edClipGet().move` 를 읽음). 설계: `paths` 목록으로 바꾸고 문자열 하나도 받는다(호환).
- 메뉴(`_onCtx`): 이미 `paths=[p,...this._selTargets(p)]` 로 `edFsActions` 에 묻는다. 메뉴 항목은 `GitMenu.openAsked([...{id,label,act,disabled:()=>사유문자열,run}])`. 이름 바꾸기 비활성용 문구(i18n ko/en)가 새로 필요하다.
- 단축키(`_onKey`): 있음 — Delete·Backspace(선택 전체), F2, ⌘C(**앵커 하나만**), ⌘V, 화살표, Enter. 없음 — ⌘X, ⌘A, Escape, ⌘+Backspace. 처리한 키만 `take()` 로 삼킨다.
- dragstart: `effectAllowed='move'`, `text/plain` 과 `FILE_TREE_DRAG_TYPE` 만 싣는다. dragover 는 `dropEffect=ext?'copy':'move'` 를 스스로 정한다(`_isFileDrag` 는 `Files` 형식만 본다 → `DownloadURL` 과 겹치지 않음). `DownloadURL` 형식은 `<mime>:<이름>:<절대 URL>`, Chromium 전용, 하나만 싣는다. 여러 항목은 `download-many` URL(쿼리 `root`, `path` 반복)로 싣는다.
- 종단 상수: `FS_DOWNLOAD_API='/api/fs/download'`, `FS_DOWNLOAD_DIR_API='/api/fs/download-dir'` (`core/constants-editor.js:424·427`). `download-many` 상수는 새로 둔다.
- 행 DOM: `.ed-tree .ed-row[data-path][data-kind]`, 목록 컨테이너는 `this.list`(스크롤은 `.ed-tree`, `overflow:auto`).
- e2e 도우미: `e2e/editor-ops.spec.ts` 의 `mkRoot`·`row`·`enterExplorer`(fixtures) 패턴. 파괴적 조작은 `mkdtemp` 아래 자기 루트에서만. 끌기 시험은 `page.evaluate` 안에서 `new DataTransfer()` 로 `DragEvent('dragstart')` 를 직접 보내 `getData('DownloadURL')` 를 읽는다.

### 하이라이트 (R12)

- 걸 자리: `core/app.js:712` `render(){ … this.edWatchSync() }` — 그리기마다 지난다. 여기서 포커스 탭이 **바뀌었을 때만** 동기화한다(FR-FHL-6).
- 포커스 칸: `this.focused`(pane id), `findPane(s.layout, s.focusedPane||this.focused)` (`app-edsearch.js:95` 참고). 탭 종류: `TAB_TYPE_EDITOR`(`tab.filePath`), `TAB_TYPE_GIT` + `tab.gitView==='diff'`.
- Explorer: 창의 포커스 칸 트리는 `this._edTreeFor(w)`, 드러내기는 `tree.revealPath(p)`(조상 펼침·스크롤·선택). 선택 지우기는 `_selOnly('')` 류.
- Changes: `git/panel-changes.js` 의 `_sel`(Set, 키 `_selKey(group,path)`), 행 클래스 `sel`. Diff 대상은 `git/panel-diff.js` `_diffTarget()`(경로·축), 창의 Diff 탭은 `app.findGitViewTab(w,'diff')`.

### 에이전트 카드 하이라이트 (R17)

- 카드 클래스 `focused` 는 `core/app-agents.js` `_agCardEl` 에서 `this._isToolFocusedActive(toolId)` 로 붙고, 재조정 근거(`sig`)에도 들어 있다. 이 판정의 정의를 먼저 읽고, 포커스 탭에 에이전트가 없을 때도 다른 카드가 남는지·포커스 전환 때 다시 그려지는지 확인한다. 하이라이트 동기화는 R12 와 같은 자리(`app.render()`)에서 하면 된다.

### 실시간 갱신 (R5) — 조사 결과의 근거 위치

- 접속 허용 목록: 프런트 `core/app-settings-access.js`(`_loadAccessPanel`·`_aclCollect`·`_aclSave`), 서버 `internal/webserver/httpapi/access.go` `apiAccessGet`(643)·`apiAccessPut`(661, 690에서 `access_changed` 방송 — 구독자 없음).
- 샌드박스: `core/app-settings-sandbox.js`(`_loadSandboxPanel`·`_sbxCollect`), 서버 `handlers_api.go` 625~646(방송 없음).
- 짝 노드 폼: `core/app-settings-peers.js` `_pnNodePaint`(28)·`_peersPaint`(57~69, 폼을 안 그림)·저장 289, 서버 `peer_api.go` 108~127. 마지막 응답 시각: `peer_commands.go:257`(보낸 호출만 갱신).
- 저장 충돌 선례: 워크스페이스 저장 `handlers_api.go` 418~470 — `ETag`/`If-Match`, 낡으면 409 `apierr.CodeStaleRev`. 같은 방식으로 하되 `If-Match` 가 없으면 지금처럼 저장(FR-LIV-2).
- Background 목록: `state-registry.js` 의 `tool.background` 에 `every:(app)=>app.agentsPollMs`, `when:(app)=>app._agentsPanelOpen()` 를 더하면 된다(`run.list` 와 같은 모양). 등록부 시험은 `web/js/test/state-registry.test.mjs`.
- Git 저장소 목록 배지: `core/git-repos-list.js:33`(주기 `gitStatusInterval`), 관측 조건 `core/app-git.js:577~584`(`_gitObserveOk`).
- LSP 캐시: `core/lsp-client.js` `_lspStatusCached`.

## 4. 이 세션이 값을 치르고 배운 것

- **전체 e2e(`make e2e`)는 약 14분**이다(10코어에서 4샤드씩 두 번). 사용자가 너무 오래 걸린다고 했다 — **관련 스펙만** 돌린다(R15). 도구 시간 제한이 10분이라 전량은 백그라운드로만 돌릴 수 있다.
- e2e 에서 활동 주기를 줄일 때는 서버 설정을 바꾸지 말고 `Object.defineProperty(app,'agentsPollMs',{value:300})` 로 그 페이지만 바꾼다(`e2e/activity-runs-refresh.spec.ts` 참고).
- 패널을 열면 이제 활동 목록을 다시 받는다(FR-ARR-4). 서버에 없는 가짜 활동(`testing.onToolActivity`)은 **패널을 연 뒤에** 넣어야 지워지지 않는다(비행 표시 규약 FR-RSF-3).
- `web/js/test/cm-sticky.test.mjs` FR-CMR-80 은 전체 단위 시험에서 가끔 흔들린다(단독으로는 통과). 이번 변경과 무관하다.
- zsh 에서 `F="a b"; git diff $F` 는 나뉘지 않는다 — 배열 `F=(a b)` 를 쓴다.
- `docs/internal/decisions.md` 는 생성물이다. SRS 를 고친 뒤 `go run ./scripts/gen-decisions` 를 돌려야 `make gates` 가 통과한다. SRS 상태 값은 `초안·승인대기·승인·구현중·승인·구현완료·폐기·대체` 중 하나다.
- JS 파일은 500줄 게이트가 있다(넘으면 파일을 나눈다). `file-tree-paint.js` 는 이미 1012줄이라 예외 목록에 있을 수 있다 — 새 코드는 늘리기 전에 `make gates` 로 확인한다.

## 5. 변하지 않는 규약

- 회귀 검사: `make unit`, `make gates`, `make lint`, `npm run typecheck --silent`, `go vet ./... && go test ./...`, 그리고 **바꾼 곳의 e2e 스펙만**.
- 스펙과 코드가 충돌하면 멈추고 사용자에게 묻는다. 동작이 바뀌면 이전/새/이유를 SRS §3.6 에 적는다.
- 커밋은 사용자 확인 뒤. AI 서명 금지.
- 외부 문서(`docs/external/*`)에 서브에이전트 폴더 보기·⌘+휠 줌 설명이 있으면 맞춘다(`make gates` 의 문서 검사가 잡을 수 있다).

## 6. 아직 유효한 사용자 결정

- 실시간 갱신은 조사 항목 중 **설정 패널 3종 · Background 목록 · 자잘한 3건**(Git 배지·짝 마지막 응답·LSP 캐시)을 고친다. 상태바 cwd 는 고치지 않는다.
- 여러 항목 우클릭: **이름 바꾸기·새 파일·새 폴더·업로드 밖은 전부** 선택 전체.
- 드래그 다중 선택은 **빈 여백에서 사각형**. 행 끌기는 파일 옮기기 그대로.
- 탭을 바꾸면 선택도 **그 파일 하나로**(Changes·Explorer 통틀어 하이라이트 하나). Changes/Explorer 사이드 탭은 자동 전환하지 않는다.
- Finder 로 끌기: 한 개·여러 개 모두. 여러 개는 zip 하나(`download-many`), 메뉴 다운로드도 여러 개면 같은 zip.
- 미니맵: 노드가 작게 보이고 보기 상자를 끌어 옮긴다. 트리 줌은 수식키 없는 휠.
