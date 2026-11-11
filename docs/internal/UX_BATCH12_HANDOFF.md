# 인계: UX_BATCH12 이어가기 (2026-11-11, 네 번째 세션으로)

## 1. 착수 블록 — 이번 세션의 지시 전부

1. `docs/internal/UX_BATCH12_SRS.md` 의 **§0 요구사항 대장**을 읽는다. 남은 행은 **R19 → R24** 순서다. R19 스펙은 확정됐다: **§3.5f FR-RTB-1~14**, 검증은 **§4 TC-RTB-1~6**. R24 는 **질의응답으로 규칙을 정한 뒤** 진행한다(§3a).
2. 순서는 고정이다: (스펙은 이미 있다) → 실패하는 테스트(RED 확인) → 구현 → 관련 테스트 통과 → 대장 상태 고침 → **커밋**. R19 는 크므로 아래 §3 의 묶음 단위로 나눠 커밋해도 된다.
3. 사용자 지시: "요구사항을 다 완료할 때까지 이어서 커밋하고 진행해." 검증을 통과하면 스스로 커밋한다. 커밋에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
4. R19 의 규칙은 질의응답으로 모두 정했다(§4). 스펙과 코드가 부딪히거나 스펙이 답하지 않는 갈림이 나오면 **멈추고 사용자에게 묻는다** — 질문은 한 번에 하나, 권장안과 함께.
5. 끝나면 회귀 검사(§6)를 돌리고 사용자에게 보고한다. 보고에는 §5 의 문서-코드 어긋남도 넣는다.

## 2. 어디까지 왔나

작업 트리는 깨끗하다(`git status`). 이번(세 번째) 세션의 커밋:

| 커밋 | 내용 |
|---|---|
| `f08c7e69` | R18 Activity 레일 (FR-ACF-1~11) |
| `7dafb08a` | R23 그룹 추가 단추 여백 (FR-SBA-1) |
| `5093eb52` | R21 포커스 이동 알람 해제 (FR-AFC-1·2, ATTENTION_FIRING FR-ATA-1 개정) |
| `18bee3e2` | R22 그룹 머리 삼각형 (FR-RGT-1·2) |
| `4839c2d5` | R20 편집기 검색 색 (FR-EFC-1~3) |
| `d9065cb9` · `ae6ddbb0` | R19 스펙 FR-RTB-1~14 |

## 3. R19 — 할 일 (권장 순서)

스펙 §3.5f 를 먼저 읽는다. 아래는 코드에서 확인한 출발점이다(다시 조사하지 않아도 된다).

**지금 구현의 자리**

- 편집기 탭 열기: `_addEditorTab`(`web/js/core/app-layout.js` 약 542행). `_findEditorTab(filePath)` 는 **창·칸을 가리지 않고** 찾는다 → FR-RTB-4 는 "지금 칸" 으로 좁혀야 한다.
- 미리보기 대체: `_retargetPreview(s, opts)`(같은 파일). `_findPreviewTab(s)`(약 398행)는 **창 단위**로 찾고, 대체 뒤 `setFocusState(prev.pane.id)` 로 **포커스를 그 칸으로 옮긴다** — FR-RTB-1·2 의 핵심 변경 지점이다.
- 고정: `pinPreviewTab`(약 406행, `delete tab.preview`). Explorer 더블클릭 고정은 `app-editor-pane.js:89`.
- 파일 열기 진입: `app-editor-file.js:22` 근처(`open` 이 있으면 그 창·칸).
- git 뷰 탭: `findGitViewTab(s, view)` 가 창에 하나를 찾는다(약 521행). **Diff 를 여기서 빼고** History 등은 그대로 둔다(FR-RTB-11).
- Diff 대상: Git 패널의 `_diffTarget()`·`previewFile`(`web/js/git/panel-diff.js`). 지금은 창(=패널)마다 대상 하나다 → Diff 탭마다 대상을 가져야 한다(FR-RTB-7·13). 탭 레코드에 대상(루트·경로·축)을 싣고 워크스페이스에 저장한다.
- Diff 보기 본체: `web/js/git/diff-view.js` `_cmBuild`(약 414행). `edCmExtensions({diff:true,…})` 는 링크·LSP 클릭 정의 이동을 끈다(`web/js/ui/cm-setup.js:128` `o.diff ? [] : edCmLinks(...)`). FR-RTB-10 은 **수정 가능한 오른쪽**(워킹 트리)에만 켠다. LSP 경로 판정은 `lspPathOf`(diff-view.js 98행 주석)를 본다.
- 하이라이트: `core/app-focus-hl.js` `focusHighlightSync` 가 Diff 탭이면 `panel._diffTarget()` 을 읽는다 → **포커스된 Diff 탭의 대상**을 읽게 바꾼다(FR-RTB-12).
- Changes 행 클릭: `git/panel-diff.js` 의 `_select` 와 행 배선. 더블클릭 고정(FR-RTB-6 ③)은 D-RTU-23 이 걷은 것을 다시 세우는 일이다.

**권장 묶음과 커밋 단위**

1. 칸마다 미리보기(편집기만): FR-RTB-1·2·4·5·6(①②④⑤). TC-RTB-1·2(편집기 부분).
2. Diff 탭 다중화 + Diff 미리보기·고정: FR-RTB-3·6③·7·8·9·13·14. TC-RTB-3·6, TC-RTB-2(Diff 부분), TC-RTB-5(새로고침).
3. 하이라이트 연동: FR-RTB-12. TC-RTB-5.
4. Diff 오른쪽 LSP·링크: FR-RTB-10. TC-RTB-4.

**바뀌어야 할 기존 시험(예상)**: 미리보기·Diff 탭이 하나라는 전제를 쓰는 e2e — `grep -rln "pn-tab-preview\|preview" e2e` 와 `repo-tab*.spec.ts`·`git-diff*.spec.ts`·`focus-highlight.spec.ts`·`editor-preview*.spec.ts` 를 먼저 훑는다. 기존 SRS(REPO_TAB_UNIFY_SRS, `docs/internal/archive/`)의 FR-RTU-31·40·42·43·45·D-RTU-23 은 FR-RTB 가 개정한다 — 그 문서에 개정 한 줄씩을 남긴다.

## 3a. R24 — 뒤로·앞으로, 닫은 탭 다시 열기 (R19 다음)

- 사용자 원문: "기존 vsc 의 뒤로가기 앞으로가기(파일 닫은거 다시열고, 이전에 연 파일, 탭으로 이동하고 하는 동작) 있긴 한건지, 어떻게 하는지 모르겠고, 방금 닫은 탭 다시 여는것도 있으면 좋을거같긴한데."
- 확인한 사실: 뒤로·앞으로는 있다 — 액션 `focusBack`·`focusForward`(기본 `Ctrl+Shift+Comma`·`Ctrl+Shift+Period`, `core/shortcuts.js:115`), 마우스 4·5번(`ui/input-binding.js` FR-M9-26). 기록은 `core/app-focus.js` 의 `_navBack`·`_navFwd`(창·칸·탭 포커스, `FOCUS_NAV_MAX`). 닫힌 자리는 건너뛴다(FR-M9-24) — VS Code 처럼 닫은 파일을 다시 열지 않는다. 편집기 안 정의 이동의 되돌아가기는 `_lspBack`(FR-LSP-27)로 따로다. 닫은 탭 다시 열기는 없다.
- 사용자에게 먼저 알린다: 지금 있는 것과 쓰는 법(위 단축키·마우스 버튼).
- 질의응답으로 정할 것(하나씩, 권장안과 함께): ① 다시 열기 대상(편집기·Diff 탭만 권장 — 터미널은 프로세스가 끝나 되살릴 수 없다) ② 단축키(VS Code `Cmd+Shift+T` 는 브라우저가 먼저 먹을 수 있다 — 앱 단축키 막기 규약 `_blockBrowserDefault` 확인) ③ 뒤로가기가 닫힌 파일 자리를 만나면 건너뛸지(지금) 다시 열지(VS Code) ④ 편집기 안 커서 위치까지 기록할지(VS Code 는 그렇다).

## 4. R19 사용자 결정 (모두 유효)

- 칸은 서로 영향을 주지 않는다. 미리보기는 **칸마다 하나(편집기·Diff 종류 무관)**, 포커스 칸에 생긴다.
- 고정 계기 다섯: 탭 더블클릭 · Explorer 행 더블클릭 · Changes 행 더블클릭 · 미리보기에서 수정 시작 · 미리보기에서 저장. 본문 더블클릭은 고정이 아니다.
- Diff 도 미리보기·고정이 있고, 오른쪽(워킹 트리)은 일반 편집기처럼 수정·저장·정의로 이동이 된다.
- 다른 칸에만 열린 대상은 지금 칸에 미리보기로 연다.
- 고정 Diff 의 ‹ › 는 그 탭을 두고 같은 칸의 미리보기로 다음 파일을 연다. 미리보기 Diff 에서는 그 탭의 대상을 바꾼다.
- History·Branches·Stash·Console·Worktrees 탭은 지금처럼 창마다 하나.
- 포커스 탭 하이라이트(FR-FHL)는 미리보기·고정 구분 없이 포커스 탭 하나를 따른다.

## 5. 작업 끝에 사용자에게 보고할 것

- 문서-코드 어긋남: `core/constants.js:294` 주석과 SIDEBAR_COLLAPSE_SRS FR-SBC-4 는 "localStorage" 라고 하나 코드는 sessionStorage 다. UIUX_OVERHAUL_SRS FR-ACT-3 은 철회됐다.
- R18 로 상단바 Activity 단추가 없어졌으나 UIUX_OVERHAUL_SRS FR-CHR-15~18·STATUS_BAR_REFLOW_SRS FR-SBR-8·9·WINDOW_SLOTS_SRS FR-WSL-50 본문은 아직 그 단추를 말한다(UX_BATCH12_SRS §3.5a·§3.6 이 개정을 적었다). 외부 문서 `docs/external/features.md` 도 확인 대상이다. 고칠지는 사용자가 정한다.
- R18 기준선: `e2e/baseline/ui-layout.{linux,win32}.json` 에 레일 요소 키를 **darwin 값으로** 넣었다(그 판에서 직접 뜬 값이 아니다). CI 에서 값이 다르면 그 판에서 다시 떠야 한다.

## 6. 이 묶음에서 배운 것

- 전체 e2e 는 14분이다 — **관련 스펙만** 돌린다. 도구 제한 10분. `--workers=4` 로 여러 스펙을 함께 돌리면 빠르다.
- JS 500줄·최대 줄 게이트(`FE_MODULE_BOUNDARY_SRS §7.1`): 넘으면 파일을 나눈다. `core/app-attn.js` 는 486줄이다(여유가 적다).
- `ui/`·`git/` 은 App 의 `_` 이름을 부를 수 없다(계층 게이트) — 공개 이름으로 올린다.
- eslint: 지역 이름 `t` 금지. z-index 는 `var(--z-*)` 만. `make gates` 의 숨김 어휘 검사: 규칙의 주체(마지막 선택자)가 클래스 둘 이상으로 `display:none` 을 켜면 실패한다.
- `decisions.md` 는 생성물 — SRS 를 고치면 `go run ./scripts/gen-decisions`.
- `ui-layout-defaults.spec.ts` V-LAY-1: 화면에 새 요소가 보이거나 폭이 바뀌면 실패한다. `LAYOUT_BASELINE=write` 로 통째로 다시 뜨면 **무관한 자리까지** 바뀐다 — 지금 스냅샷을 따로 떠서 바뀐 키만 기준선 JSON 에 합친다(이번 세션 방식: 원본 백업 → write → 새 키만 병합 → 원본 복원).
- 전역 함수(`applyThemeObj`·`THEMES`)는 `window` 속성이 아니다 — e2e 에서는 `(0, eval)("…")` 로 부른다. 테마 Cobalt²(강조색 노랑)가 색 확인에 좋다.
- 알람: 칸 안의 pointerdown 은 **그 순간의 활성 탭** 알람을 끈다(FR-ATA-3). 탭 바 클릭 시험에서 옛 탭의 알람도 함께 꺼진다.
- `httpErr` 의 오류 코드는 헤더(`apierr.CodeHeader`)로 간다.

## 7. 변하지 않는 규약

- 회귀 검사: `make unit`, `make gates`, `make lint`, `npm run typecheck --silent`, `go vet ./... && go test ./...`(Go 를 바꿨을 때), 바꾼 곳의 e2e 스펙만.
- 스펙과 코드가 충돌하면 멈추고 묻는다. 동작이 바뀌면 이전/새/이유를 SRS 에 적는다.
- 사용자의 dongminal 을 재시작하지 않는다.
