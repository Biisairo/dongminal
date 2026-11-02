# 인계: 편집기 엔진 교체 (Monaco → CodeMirror 6) — M6 마무리부터

> 작성: 2026-11-02 · 브랜치 `codemirror-migration` · 근거 SRS `docs/internal/CODEMIRROR_MIGRATION_SRS.md`

## 착수 블록 (이번 세션의 지시 전부)

1. 이 문서를 끝까지 읽는다. 그다음 SRS 의 §3(요구사항)·§3.16(동작 변경)·§7(마일스톤·§7.1·§7.2)·§11.3(M5 설계)·§11.4(M6 설계)를 읽는다.
2. `git status` 와 `git log --oneline -5` 로 출발점을 확인한다. 브랜치는 `codemirror-migration` 이어야 한다. 맨 위 커밋은 M6 의 WIP 커밋이다.
3. **M6 를 닫는다** (아래 "남은 일" 1~3). 편집기·Diff 관련 e2e 전체를 돌려 §7.2 와 비교하고, 표에 없는 실패를 고친다.
4. M6 를 닫는 커밋을 만든다. **커밋 전에 사용자에게 확인을 받는다** (CLAUDE.md). 커밋 메시지에 AI 서명을 넣지 않는다.
5. 그다음 M7 → M8 → M9 순서로 진행한다. 마일스톤마다 Spec → Test → Code 순서이고, 끝에 e2e 를 돌려 §7.2 를 갱신한다.

## 어디까지 왔나

| 마일스톤 | 상태 | 근거 |
|---|---|---|
| M1 벤더 묶음·로더 | 완료 | `6633910c` |
| M2 e2e 편집기 접근 계층 | 완료 | `a81a3920` |
| M3 편집기 코어·찾기 | 완료 | `791e28bb`(WIP) + `e5d03f72` |
| M4 같은 파일 여러 칸 | 완료 | `ef0d5953` (FR-CMR-23 은 M8 로 옮겼다) |
| M5 스크롤바·ruler·dirty diff·미니맵 포크 | 완료 | `6971b5ee` |
| M6 Git Diff 뷰 → `@codemirror/merge` | **구현 끝, 검증 덜 끝남 — WIP 커밋** | 아래 "M6 에서 한 일" |

`main` 에는 단계 A 가 끝나 e2e 전체가 통과할 때까지 합치지 않는다 (SRS §7.1).

### M3~M5 요약 (커밋됨)

- M3 마무리: 전역 키 판정(`input-binding.js` 의 `inText`)이 contenteditable 도 글자 입력칸으로 본다. `EdBuffer` 는 CRLF·CR·LF 를 줄 구분으로 나누고 `eol` 을 기억한다. 저장은 `buf.text(doc)` 로 줄 끝을 되살린다
- M4: `e2e/editor-multi-slot.spec.ts` — 칸 셋 반영 시간(최대 2.4ms), 두 칸 번갈아 입력, 칸별 실행 취소
- M5: `web/js/ui/cm-scrollbar.js`(직접 그리는 세로 스크롤바 + overview ruler, FR-CMR-74), dirty diff 의 CodeMirror 이전(`file-editor-diff.js` 의 `edDdField`·`edDdExtensions`), 미니맵 포크(`scripts/codemirror/minimap/`, README 에 고친 자리 5곳), 줄 높이 정수 px(`ED_LINE_HEIGHT_RATIO`)

### M6 에서 한 일 (WIP 커밋에 있다)

- 새 파일 `web/js/git/diff-cm.js` — `gitDiffIgnoreWs`(공백 무시 diff override, FR-CMR-53) · `gitDiffRulerItems`(FR-CMR-57) · `gitDiffHunkBar`(hunk 툴바 tooltip 필드) · `gitDiffCursorHost`(panel-hunks 가 편집기에 닿는 유일한 자리). 단위 테스트 `web/js/test/diff-cm.test.mjs` 6건
- `web/js/git/diff-view.js` — `GitDiffView` 가 `_cm = {kind:'split'|'unified', mv?, a?, b, scroller, cmpA, cmpB, host, wrap, rul, ruler, resize}` 를 든다. 폭 ≥ 900px 이면 `MergeView`, 미만이면 `unifiedMergeView` 편집기 하나. 보기 옵션(나란히·공백 무시·접기)이 바뀌거나 폭이 문턱을 넘으면 `_cmBuild()` 로 다시 세운다(스크롤 비율 유지). 바깥 그릇 `.git-diff-cm`(나란히면 `side-by-side` 클래스) · 본문 `.git-diff-pane` · 본문 밖 ruler `canvas.git-diff-ruler`. 쪽 표지 클래스 `git-diff-side-orig`·`git-diff-side-mod`. 살아 있는 뷰는 `GitDiffView.live`(e2e `counts`)
- `diff-view-doc.js` — 편집 가능 축이면 수정본 편집기가 문서 버퍼의 칸이다(`updateListener` → `buf.fromSink`, `buf.attach(c.b)`). `GIT_DIFF_SHARES_DOC` 와 그 분기를 걷었다. 읽기 전용은 `cmpB.ro` Compartment
- `diff-view-parity.js` — `applyTextOptions`(줄바꿈·글자 크기 Compartment), 찾기 패널은 포커스 쪽 편집기의 `edFindEngineCm`(`_view` 그릇), `lspPathOf(side)`
- `panel-hunks.js` — 툴바 배선이 `gitDiffCursorHost` 를 받는다. `_hunkBarPos` 는 `{line}`. 툴바 노드는 tooltip 마다 얇은 그릇(`.git-hunk-tip`)에 옮겨 담는다
- `diff-view.js` 생성자 — capture keydown 이 먼저 `app.edTrySearchKey(e)` 를 부른다(편집기 칸의 `_onKeyCapture` 와 같다). 이것이 없으면 Diff 에서 `Mod+F` 가 듣지 않는다
- `app-edsearch.js` `_edActiveDiff` — `d._cm` 을 본다
- 색: 새 테마 변수 `--diff-add`·`--diff-del`(`theme-vars.js` 의 vars 리터럴, `style.css :root` 기본값) = 팔레트의 green·red **그대로**(Monaco 의 diffEditor.* 매핑과 같다). `style-git-views.css` 가 줄 20%·글자 36% 로 섞는다. ruler 색 `GIT_DIFF_RULER_ADD/_DEL`
- `diffMinimap` 설정을 걷었다 (사용자 결정, §3.16): 스키마·`settings-state`·`app-settings(-init)`·`index.html` 스위치·i18n·`docs/external/features.md`·Go `schema_test.go`(29 → 28)·`settings-controls.test.mjs`
- 죽은 Monaco 코드 제거: `file-editor.js` 위쪽 `MONACO_*`·`loadMonaco`·`monaco*`·`LANG_MAP`(약 220줄), 찾기의 `edFindEngineMonaco`·`_findKillMonacoKeys`, `constants-editor.js` 의 `ED_FIND_RULER_COLOR*`·`ED_FIND_MINIMAP_COLOR*`, `FileEditor.applyTheme` 의 Monaco 갈래
- `cm-setup.js` `edCmExtensions({diff:true})` — dd·직접 그린 스크롤바·미니맵이 빠진 Diff 한쪽 구성
- e2e: `e2e/editor.ts` 의 Diff 갈래(`diffSide` 는 `{_view}` 핸들, 인라인이면 `orig` 는 null · `diffText/SetText/Append` · `diffChangeCount`=`dv.chunks()` · `counts()` · `probeDiff` 는 MergeView), 선택자 `diffSurface`·`diffModified`·`diffRuler`·`diffInsLine`·`diffDelLine`, `ED_VENDOR_ROUTE='**/vendor/{monaco,codemirror}/**'`. `git-diff.spec.ts` D11 은 `color(srgb …)` 도 받고 선택자를 어댑터로 옮겼다. `ux-batch10.spec.ts` V-UXB-12 는 "Diff 에는 미니맵도 스위치도 없다" 를 잰다
- SRS: FR-CMR-56 개정, §3.16 두 줄(Diff 미니맵 · Diff 폭 전환 뒤 실행 취소), §11.4 설계 메모, 변경 기록

### 마지막 측정 (M6 작업 트리)

- `npm run unit` 626 통과 · typecheck · eslint · `verify.yml` 의 check 37개 · `go test ./internal/shared/settingsschema/` 통과
- Diff 관련 e2e 8개 파일(git-diff · git-diff-doc · repo-diff-edit · git-hunk · git-subroot · git-write-order · ux-batch10 · editor-git-ux): 고친 뒤 git-hunk 19/19, git-diff + ux-batch10 30/31. 남은 1건 "편집 가능 축의 diff 에서 호버가 그 파일의 좌표로 나간다" 는 §7.2 의 M8 몫이다
- **편집기·Diff 관련 e2e 전체(44개 파일)는 돌리다 멈췄다.** 그 뒤에 Monaco 도우미 제거·`probeDiff` 교체를 했으므로 결과가 없다

## 남은 일 (순서대로)

1. **e2e 전체를 다시 돌린다** (아래 파일 목록, 약 20분). `--reporter=json` 으로 받아 테스트 단위로 §7.2 와 비교한다. 특히 볼 것:
   - `monaco-offline.spec.ts` TC-MVN-16 이 CodeMirror `probeDiff` 로 통과하는가 (통과하면 §7.2 의 그 줄을 지운다)
   - `git-diff-doc` S1~S7 · `repo-diff-edit` D1·D3·E1·E2 · `git-subroot` F-3.1 — 문서 공유를 되살렸으므로 통과해야 한다 (부분 실행에서는 통과했다)
   - `editor-find-panel` "다른 Monaco 는 자기 위젯을 갖는다" — `edT.probe` 가 Monaco 를 쓴다. Monaco 를 더는 싣지 않으므로 M9 에서 폐기·대체할 것이다(§7.2 그대로)
2. **§7.2 를 고친다** — M6 가 닫은 줄(`git-diff-doc`·`repo-diff-edit`·`git-subroot` M6 줄, TC-MVN-16)을 지우고 측정값을 적는다. 문서 머리 "남은 것" 을 `M7~M9 … M1~M6 완료` 로 바꾼다
3. 아직 손대지 않은 M6 의 빈자리를 확인한다:
   - Diff 의 수정본 쪽에서 실제 키보드로 친 글자가 편집기 탭에 보이고 저장되는가 (e2e `git-diff-doc` 이 잰다)
   - 나란히 보기에서 원본 쪽에 포커스가 있을 때 찾기 패널이 원본을 찾는가 (FR-UXB-49)
4. M6 커밋 (사용자 확인 후). WIP 커밋에 이어 마무리 커밋을 하나 더 올린다 — 이력을 다시 쓰지 않는다 (M3 때 사용자가 고른 방식)
5. **M7 (sticky scroll, 묶음 K)** — FR-CMR-80~ 를 읽고 직접 구현한다(사용자 결정: 단계 A 에 넣는다)
6. **M8 (LSP, 묶음 S·W·L)** — `web/js/core/lsp-client.js` 가 아직 Monaco API(`v._editor`·`getModel`·`setModelMarkers`)를 쓴다. `@codemirror/lsp-client` + WebSocket 통로로 바꾼다. M4 에서 넘긴 FR-CMR-23(그룹당 LSP 문서 하나, 사용자 정의 `Workspace`)을 함께 한다. §7.2 의 M8 줄(editor-lsp-nav 18건 등)을 닫는다
7. **M9 (Monaco 제거, 묶음 X)** — `web/vendor/monaco/` 삭제, `static.go` 정리, `e2e/editor.ts` 의 Monaco 갈래·`probe` 제거, `GIT_DIFF_OPTIONS`(지금은 e2e V-MMP-2b·editor-git-ux 가 상수를 읽는다)와 그 검사 정리, i18n 의 Monaco 문구(`git.diff_monaco_fail` 의 이름) 정리, 문서 개정

### e2e 파일 목록 (남은 일 1)

```
e2e/a11y-axe.spec.ts e2e/a11y-keyboard.spec.ts e2e/codemirror-load.spec.ts e2e/doc-render.spec.ts e2e/editor-dirty-derived.spec.ts e2e/editor-dirty-diff.spec.ts e2e/editor-doc-registry.spec.ts e2e/editor-encoding.spec.ts e2e/editor-external-change.spec.ts e2e/editor-find-panel.spec.ts e2e/editor-git-ux.spec.ts e2e/editor-live-reload.spec.ts e2e/editor-lsp-nav.spec.ts e2e/editor-minimap.spec.ts e2e/editor-multi-slot.spec.ts e2e/editor-ops.spec.ts e2e/editor-replace-seed.spec.ts e2e/editor-save.spec.ts e2e/editor-scrollbar.spec.ts e2e/editor-traffic.spec.ts e2e/explorer-root-keys.spec.ts e2e/file-size-gate.spec.ts e2e/font-size.spec.ts e2e/git-diff-doc.spec.ts e2e/git-diff.spec.ts e2e/git-dir-entry.spec.ts e2e/git-history.spec.ts e2e/git-hunk.spec.ts e2e/git-stash.spec.ts e2e/git-subroot.spec.ts e2e/git-view-refresh.spec.ts e2e/git-write-order.spec.ts e2e/kit-button.spec.ts e2e/kit-components.spec.ts e2e/kit-scroll.spec.ts e2e/monaco-offline.spec.ts e2e/notes-live-explorer.spec.ts e2e/repo-diff-edit.spec.ts e2e/repo-tab.spec.ts e2e/slot-view-state.spec.ts e2e/tooltips.spec.ts e2e/touch-targets.spec.ts e2e/ux-batch10.spec.ts e2e/view-scroll-restore.spec.ts
```

목록을 파일에 두고 `xargs npx playwright test --reporter=json > /tmp/out.json` 로 넘긴다. 결과 집계는 JSON 의 `suites[].specs[].tests[].status` 를 돈다(`expected` 가 통과).

## 먼저 읽을 것

- SRS `docs/internal/CODEMIRROR_MIGRATION_SRS.md` — §3, §3.16, §7, §7.1, §7.2, §11.3, §11.4
- `web/js/git/diff-view.js` 의 `_draw`·`_cmBuild`·`_cmDestroy`·`_cmRuler*` · `web/js/git/diff-cm.js` · `web/js/git/diff-view-doc.js`
- `e2e/editor.ts` — 어댑터. 엔진을 아는 e2e 코드는 이 파일 하나다 (FR-CMR-121, `scripts/test/e2e-editor-boundary.test.mjs`)

## 이 세션이 값을 치르고 배운 것

- **e2e 브라우저는 Windows 로 보인다** (`navigator.platform` = `Win32`). CodeMirror 의 `Mod` 가 `Ctrl` 이다 — 스펙의 키는 `Control+…` 이다. `ControlOrMeta` 는 mac 에서 Meta 가 되어 듣지 않는다
- **contenteditable 안의 키는 전역 배선이 앱 단축키를 돌리지 않는다** (`inText`). 편집기 표면마다 자기 capture 리스너에서 `app.edTrySearchKey(e)` 를 불러야 한다 (`FileEditor._onKeyCapture` · `GitDiffView` 생성자). Monaco 때는 입력 요소가 textarea 가 아니어서 이 문제가 없었다
- **CodeMirror 는 갱신 도중 같은 편집기에 `dispatch` 하면 거부한다.** `updateListener` 안에서 그 편집기를 고치는 일(툴바 배치)은 `queueMicrotask` 로 미룬다. 다른 편집기에 보내는 것(`EdBuffer.fromSink`)은 괜찮다
- **tooltip 노드를 tooltip 사이에서 공유하면 사라진다** — 엔진이 새 것을 붙인 뒤 옛 것을 떼며 노드까지 뗀다. tooltip 마다 그릇을 둔다
- **MergeView 의 두 편집기는 스스로 스크롤하지 않는다.** 스크롤 그릇은 `.cm-mergeView` 이고 CSS 로 높이·`overflow:auto` 를 줘야 한다. 그래서 Diff 에는 직접 그린 스크롤바(`edCmScrollbar`) 대신 본문 밖 ruler 를 둔다
- **merge 의 기본 색을 이기려면 선택자가 더 구체적이어야 한다** — style-mod 가 `<head>` 끝에 붙어 같은 구체성이면 이긴다. `.git-diff-cm .git-diff-pane .git-diff-side-mod .cm-changedLine` 처럼 그릇부터 적는다
- **`color-mix()` 의 계산값은 `color(srgb …)` 다** (`rgb(…)` 가 아니다)
- **`--term-*` 는 대비 보정과 `brightX` 우선을 거친 값이다.** 팔레트 원색이 필요하면 새 변수를 `themeVarsOf` 의 vars **리터럴 안에** 둔다(밖에서 대입하면 `check-hardcoded-color`·`check-css-vars` 가 "런타임이 덮지 않는 이름" 으로 잡는다). `style.css :root` 에 기본값도 둔다
- **미니맵(sticky)은 문서 높이가 소수면 끝에서 반 픽셀 밀린다.** 줄 높이를 정수 px 로 둔 이유다
- **클래식 스크립트의 `class`·`const` 는 `window` 의 속성이 아니다.** 어댑터에서는 `(0, eval)('typeof X === "undefined" ? null : X')` 로 읽는다
- **zsh 는 `$var` 를 단어로 나누지 않는다.** 명령 목록을 돌릴 때는 `eval "$c"` 다 (`verify.yml` 의 check 목록: `grep -oE "run: (node )?scripts/check-[A-Za-z0-9_.-]+" .github/workflows/verify.yml | sed 's/^run: //'`)
- **e2e 를 두 벌 동시에 돌릴 때는 `DM_E2E_KEEP_PEERS=1` 과 다른 `E2E_PORT_BASE`(예: 59300)가 필요하다.** 돌리는 중에 작업 트리를 고치면 그 실행의 결과는 섞인다
- **벤더 묶음을 다시 만들면** `node scripts/build-codemirror.mjs` 뒤 `bash scripts/check-vendor.sh` 가 알려 주는 집계 해시로 `docs/internal/VENDOR_VERSIONS.md` 의 codemirror 줄을 고친다. 청크 이름이 바뀌어 삭제·추가가 함께 나온다(정상)
- 포크(`scripts/codemirror/<이름>/`)의 LICENSE 는 빌드 스크립트가 `THIRD_PARTY_LICENSES.txt.gz` 에 함께 싣는다. 미니맵 원본에는 LICENSE 파일이 없어 package.json 의 MIT 선언으로 문안을 적었다(README 에 밝혔다)
- **Serena 는 이 프로젝트에서 Go 만 띄운다.** JS 심볼 탐색은 Claude Code 의 LSP 도구(`findReferences`)가 동작한다. 수정은 Edit·스크립트로 폴백한다

## 변하지 않는 규약

- CLAUDE.md: 중·대 규모는 Spec → Test → Code. 테스트는 구현 전에 실패를 확인한다(M6 의 `diff-cm.test.mjs` 는 이 단계를 빠뜨렸다 — 되풀이하지 않는다). 커밋은 사용자 확인 후에만, AI 서명 금지
- 도구 우선순위: 심볼은 LSP → Serena → grep. 수정은 Serena → Edit
- 게이트: `npm run unit` · `npm run -s typecheck` · `npx eslint .` · `verify.yml` 의 `scripts/check-*` 전부 · 설정 스키마를 고치면 `go test ./internal/shared/settingsschema/`
- e2e 는 엔진에 직접 닿지 않는다 — `e2e/editor.ts` 의 `edT`·`ED_SEL` 만 쓴다
- §7.2 에 없는 e2e 실패는 회귀로 본다. 마일스톤을 커밋할 때 표를 갱신한다
- 동작이 바뀌면 SRS §3.16 에 이전 동작 / 새 동작 / 이유를 적는다
- SRS 상태 값은 enum 이다(`check-srs-status.sh`). `승인·구현중` 이면 바로 아래 `> **남은 것**:` 줄이 있어야 한다

## 아직 유효한 사용자 결정

- 대상은 CodeMirror 6. 단계 A(1:1 이전) 먼저, 단계 B(기능 추가)는 그 뒤
- 우클릭 메뉴·F1 명령 팔레트·Bat 강조는 넣지 않는다. sticky scroll 은 단계 A 에 넣는다(직접 구현)
- 일부러 설정한 기능은 CodeMirror 에 없어도 직접 구현해 유지한다
- 편집기 칸의 세로 스크롤바는 직접 그린다 (FR-CMR-74, M5)
- Diff 에는 미니맵이 없고 `diffMinimap` 설정도 걷는다 (FR-CMR-56, M6)
- 같은 파일 여러 칸의 실행 취소는 칸마다 따로다
- FR-CMR-23(그룹당 LSP 문서 하나)은 M8 에서 한다
- LSP 는 `@codemirror/lsp-client` + WebSocket 통로. 연결마다 언어 서버 하나. Monaco 시절의 REST·서버 문서 동기화는 걷는다
- 열리지 않은 파일의 변경은 통로가 `didChangeWatchedFiles` 로 끼워 넣는다 — 파일 저장 + git 변화 모두
- 묶음은 스크립트로 만들어 커밋한다. 미니맵은 포크해서 쓴다. Diff 공백 무시는 `diffConfig.override` 로 줄 단위 정규화
- 마일스톤 WIP 를 이어 마무리할 때는 새 커밋을 올린다(amend 하지 않는다)
- 단계 A 는 `codemirror-migration` 브랜치에서 하고, 끝난 뒤 `main` 에 합친다
- §8 의 B 단계 질문 5건은 B 착수 전에 묻는다
