# 인계: UX_BATCH12 이어가기 (2026-11-11, 다섯 번째 세션으로)

## 1. 착수 블록 — 이번 세션의 지시 전부

1. `docs/internal/UX_BATCH12_SRS.md` 의 **§0 요구사항 대장**을 읽는다. 남은 행은 **R24 하나**다. 스펙은 확정됐다: **§3.5g FR-RTR-1~14**, 검증은 **§4 TC-RTR-1~7**. 규칙은 질의응답으로 모두 정했다(아래 §4).
2. 순서는 고정이다: (스펙은 이미 있다) → 실패하는 테스트(RED 확인) → 구현 → 관련 테스트 통과 → 대장 상태 고침 → **커밋**. 아래 §3 의 묶음 단위로 나눠 커밋해도 된다.
3. 사용자 지시: "요구사항을 다 완료할 때까지 이어서 커밋하고 진행해." 검증을 통과하면 스스로 커밋한다. 커밋에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
4. 스펙과 코드가 부딪히거나 스펙이 답하지 않는 갈림이 나오면 **멈추고 사용자에게 묻는다** — 질문은 한 번에 하나, 권장안과 함께.
5. 끝나면 회귀 검사(§7)를 돌리고 사용자에게 보고한다. 보고에는 §5 의 문서-코드 어긋남과 기존 실패 e2e 도 넣는다.

## 2. 어디까지 왔나

작업 트리는 깨끗하다(`git status`). 이번(네 번째) 세션의 커밋:

| 커밋 | 내용 |
|---|---|
| `96df0311` | R19 묶음 1 — 편집기 미리보기는 칸마다 하나 (FR-RTB-1·2·4·5·6). `core/app-preview.js` 신설 |
| `264a254f` | R19 묶음 2~4 — Diff 탭 다중화·미리보기·고정, 하이라이트, Diff 오른쪽 정의 이동 (FR-RTB-3·6~14) |
| `c245686c` · `cbb58c68` | R24 스펙 FR-RTR-1~14 |

R19 는 끝났다(대장 "완료").

## 3. R24 — 할 일 (권장 순서)

스펙 §3.5g 를 먼저 읽는다. 아래는 코드에서 확인한 출발점이다.

**지금 구현의 자리**

- 기록: `web/js/core/app-focus.js` 의 `_navPlace`(창·칸·탭)·`_navNote`(setFocusState 가 부르는 한 자리)·`_navAlive`·`_navGo`·`_navMove`(사라진 자리는 건너뜀)·`navBack`/`navForward`·`_navCounts`(app.testing 계약에 있음). 상한 `FOCUS_NAV_MAX`(`core/constants.js:786`).
- 단축키 표: `web/js/core/shortcuts.js` (`focusBack:'Ctrl+Shift+Comma'`, `focusForward:'Ctrl+Shift+Period'`, 라벨 `SHORTCUT_LABELS`). 쓰이는 Ctrl+Shift 글자: H V N T W D A S X B O E K. **`tabReopen:'Ctrl+Shift+KeyU'`** 를 더한다. `make gates` 의 `shortcuts-docs` 가 기본값·라벨·설정 화면·문서가 한 벌인지 본다.
- 마우스 4·5번: `web/js/ui/input-binding.js` 약 317~345행(FR-M9-26 블록, `navBtn`, mousedown·auxclick). **통째로 없앤다**(FR-RTR-11). 기존 e2e 중 마우스 4·5를 재는 것이 있으면 TC-RTR-6 로 바꾼다(`grep -rn "button: 3\|button:3\|mouse4\|FR-M9-26" e2e`).
- 탭 닫기: `closeTab`(`web/js/core/app-layout.js`) — 여기서 Repo 창 탭(편집기·git)을 닫힌 탭 목록에 넣는다. 편집기 커서·스크롤은 닫기 전에 편집기 인스턴스(`this.editorAny(tab.id)`)에서 읽는다. Diff 탭은 `tab.diffTarget` 이 대상이다.
- 다시 열기: 편집기는 `addTab(rid,TAB_TYPE_EDITOR,{filePath,windowId})`, Diff 는 `gitDiffOpen(root,target,{paneId,commit})`(`core/app-diff-tab.js`, 미리보기 아님), git 뷰는 `addTab(rid,TAB_TYPE_GIT,{gitView})`(창에 하나 — 있으면 그리로). 위치(칸 안 index)는 넣은 뒤 `pn.tabs` 에서 옮긴다.
- 파일 안 점프(FR-RTR-8): 검색 결과 줄 이동은 `edOpenFile` 의 `opts.line` 분기(`core/app-editor-file.js`), 정의 이동은 `core/lsp-client.js` (`lspClickDef`·`_lspRunOn`·`_lspBack` FR-LSP-27), 참조 목록 고르기도 lsp-client 쪽. 점프 직전에 (창, 칸, 탭, 커서)를 기록에 넣는다 — `_navPlace` 에 `pos` 를 더하는 모양이 자연스럽다. `_navSame` 비교도 같이 본다.
- 스크롤 보존(FR-RTR-10): **원인 미조사.** 사용자 말: "탭을 열고 스크롤 내린 뒤 포커스를 옮겼다가(windows 를 갔다 돌아온다거나) 돌아오면 스크롤이 맨 위". 편집기 인스턴스는 탭마다 살아 있으므로(`fileEditors`) DOM 을 떼었다 붙일 때 CodeMirror 의 scrollTop 이 0 으로 읽히는 쪽이 의심된다. `file-editor.js` 에 `restoreView()`/`_viewState` 가 있다. Diff 는 `panel-life.js` `elFor` 의 `diff-layout` 프레임. 조사 결과를 SRS FR-RTR-10 아래에 적는다.
- 버튼(FR-RTR-13·14): 상단바 오른쪽, **슬롯 버튼의 왼쪽**, 간격·구분선으로 묶음이 갈려 보이게. Repo 창일 때만 보인다. 상단바는 `web/index.html` + `web/js/ui/renderer-chrome.js`. 슬롯 버튼 선택자를 먼저 찾는다(`grep -n "slot" web/index.html`). 비활성 판정은 "건너뛰지 않고 갈 수 있는 자리"(열린 자리 또는 다시 열 수 있는 자리)가 있는가다 — `_navMove` 의 건너뛰기 규칙과 한 함수로 묶는다. 상단바에 새 요소가 보이면 `ui-layout-defaults.spec.ts` V-LAY-1 기준선이 깨진다(§6 참조).

**권장 묶음**

1. 마우스 4·5 철회 + `tabReopen` 단축키 + 닫힌 탭 목록·다시 열기 (FR-RTR-1~6·11·12). TC-RTR-1·2·6.
2. 뒤로가기의 다시 열기 (FR-RTR-7). TC-RTR-3.
3. 버튼 (FR-RTR-13·14). TC-RTR-7.
4. 파일 안 점프 기록 (FR-RTR-8·9). TC-RTR-4.
5. 스크롤 보존 (FR-RTR-10) — 조사 먼저. TC-RTR-5.

## 4. R24 사용자 결정 (모두 유효)

- 다시 열기 대상: 터미널을 뺀 Repo 창의 탭 전부(편집기·Diff·git 뷰).
- 단축키: "브라우저랑 안 겹치는 걸로" → `Ctrl+Shift+U` 로 정했다.
- 뒤로가기가 닫힌 탭 자리를 만나면 다시 연다(VS Code).
- 파일 안 큰 점프도 기록한다(VS Code).
- 창을 오갔다 오면 스크롤이 맨 위로 가는 문제도 함께 고친다.
- 마우스 4·5번은 앱에서 빼고 브라우저에 맡긴다.
- 뒤로·앞으로 버튼: Repo 창일 때 상단바 오른쪽, 슬롯 버튼 왼쪽, 거리를 두고 구분감 있게. 갈 곳이 없으면 비활성.
- 다시 연 탭은 보통 탭이다(미리보기 아님 — FR-RTB-1 을 깨지 않으려고. 스펙 FR-RTR-4 에 적은 판단이다).

## 5. 작업 끝에 사용자에게 보고할 것

- 문서-코드 어긋남: `core/constants.js:294` 주석과 SIDEBAR_COLLAPSE_SRS FR-SBC-4 는 "localStorage" 라고 하나 코드는 sessionStorage 다. UIUX_OVERHAUL_SRS FR-ACT-3 은 철회됐다.
- R18 로 상단바 Activity 단추가 없어졌으나 UIUX_OVERHAUL_SRS FR-CHR-15~18·STATUS_BAR_REFLOW_SRS FR-SBR-8·9·WINDOW_SLOTS_SRS FR-WSL-50 본문은 아직 그 단추를 말한다. `docs/external/features.md` 도 확인 대상이다. 고칠지는 사용자가 정한다.
- R18 기준선: `e2e/baseline/ui-layout.{linux,win32}.json` 의 레일 요소 키는 darwin 값이다.
- **기존 실패 e2e (변경 전 코드에서도 실패, 이번 일과 무관)**: `git-history.spec.ts` H5(폭이 줄면 Commit→Date→Author 순으로 숨김), `ux-batch10.spec.ts:428`(나란히 보기에서 원본 쪽 찾기 — side-by-side 가 서지 않음). flaky: `editor-ops.spec.ts` O7.
- R19 에서 바뀐 동작(보고용): Diff 탭은 탭마다 전용 GitPanel 이다. dirty 미리보기는 대체하지 않고 고정한다(REPO_FIX 05 §3A-3 F-2.4 의 "전환 전 묻기" 는 Repo 창에서 일어나지 않음). 미리보기에서 입력해도 고정되지 않던 기존 결함을 고쳤다.

## 6. 이 묶음에서 배운 것

- 전체 e2e 는 14분이다 — **관련 스펙만** 돌린다. 도구 제한 10분. 오래 걸리면 `run_in_background` 로 돌리고 로그를 파일에 남긴다. playwright 를 **두 개 동시에 돌리지 않는다**(같은 서버 포트).
- 실패 요약: `LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g' log > clean` 뒤 `^\s+[0-9]+\) \[chromium\]` 다음 줄들에서 Error/Expected 를 뽑는다.
- 회귀가 원인 모를 때는 파일 단위로 되돌려 이분한다: `git diff HEAD -- f > p; git checkout HEAD -- f; 시험; git apply p`.
- 기존 결함 여부는 `git stash -u` → 시험 → `git stash pop` 으로 변경 전 코드에서 재 본다.
- JS 500줄·최대 줄 게이트: 최대 파일은 `app-layout.js`(기준선 1008, 지금 약 966). 넘으면 파일을 나눈다(이번에 `app-preview.js`·`app-diff-tab.js`·`git/panel-diff-tab.js` 로 나눴다). 새 파일은 `web/index.html` 에 `<script>` 를 더한다.
- `ui/`·`git/` 은 App 의 `_` 이름을 부를 수 없다(계층 게이트) — 공개 이름으로 올린다.
- eslint: 지역 이름 `t` 금지(i18n `t()` 를 가린다). 쓰지 않는 변수 금지.
- LSP 도구(findReferences)는 이 저장소의 `Object.assign(App.prototype, …)` 패턴을 따라가지 못한다 — 참조 찾기는 텍스트 검색으로 내려간다.
- e2e 에서 Diff 를 읽을 때는 `edT.diffPanel()`(e2e/editor.ts)을 쓴다 — 포커스된 Diff 탭의 패널, 없으면 유일한 Diff 탭 패널, 그것도 없으면 `app.gitPanel`. `app.gitPanel` 은 Changes 쪽 패널이고 Diff 를 들지 않는다. 앱 쪽은 `app.gitDiffPanelActive()`.
- 관측기(`obs.panels`)를 도는 순회는 Diff 탭 패널(`p.diffTabId`)도 돈다 — 작업 표시(`adoptJobs`)처럼 그 패널에 맞지 않는 순회는 빼야 한다(이번에 G1 회귀가 그것이었다).
- `ui-layout-defaults.spec.ts` V-LAY-1: 새 요소가 보이면 실패한다. `LAYOUT_BASELINE=write` 로 통째로 뜨면 무관한 자리까지 바뀐다 — 원본 백업 → write → 새 키만 병합 → 원본 복원.
- `decisions.md` 는 생성물 — SRS 를 고치면 `go run ./scripts/gen-decisions`.
- 전역 상수(`IS_MAC` 등)는 e2e 에서 `(0, eval)('IS_MAC')` 로 읽는다.

## 7. 변하지 않는 규약

- 회귀 검사: `make unit`, `make gates`, `make lint`, `npm run typecheck --silent`, `go vet ./... && go test ./...`(Go 를 바꿨을 때), 바꾼 곳의 e2e 스펙만.
- 스펙과 코드가 충돌하면 멈추고 묻는다. 동작이 바뀌면 이전/새/이유를 SRS 에 적는다. 다른 SRS 의 조항을 개정하면 그 문서에 개정 한 줄을 남긴다(이번 예: `docs/internal/archive/M9_SRS.md` FR-M9-24·26, `REPO_TAB_UNIFY_SRS.md`).
- 사용자의 dongminal 을 재시작하지 않는다.
