# SRS: 편집기 엔진 교체 — Monaco 에서 CodeMirror 6 으로 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: M3~M9 (단계 A) · M10~ (단계 B). M1(묶음 V)·M2(묶음 T)는 완료.

- 근거: 사용자 인터뷰(2026-11-02) · PoC(`/tmp/cm-poc`, §2.6).
- 대체 문서: `MONACO_VENDORING_SRS.md` 의 묶음 V 는 이 문서의 묶음 V 가 대체한다.
  다른 SRS 의 Monaco 의존 조항은 §6 의 규칙으로 개정한다.
- 요구사항 ID 접두어: `FR-CMR-` · `NFR-CMR-` · `D-CMR-`.

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

편집기·Diff 뷰·LSP 연동이 Monaco(`monaco-editor@0.56.0`)에 서 있다. 교체 이유는 둘이다.

| 이유 | 지금 |
|---|---|
| **크기** | 첫 로드 약 1.0MB(gz), 벤더 전체 5.66MB(gz)·풀면 23.3MB. `static.go` 에 이 크기만을 위한 처리가 따로 있다 |
| **커스텀** | 기본 UI 를 바꾸려면 우회해야 한다. 찾기 위젯과 Monaco 기본 키를 무력화하는 코드(`_findKillWidgetKeys`·`_lspKillMonacoKeys`)가 그 흔적이다 |

이 문서는 편집 엔진을 **CodeMirror 6** 으로 바꾸는 요구사항을 정한다. 지금 쓰는 기능은
모두 옮기고(묶음 A), 그 뒤에 CodeMirror 에서 쉽게 얻는 기능을 더한다(묶음 B).
LSP 는 서버 중개(REST)를 걷어 내고 `@codemirror/lsp-client` 와 WebSocket 통로로 바꾼다.
**Monaco 의 잔재는 남기지 않는다.**

### 1.2 범위 (Scope)

**포함 — 단계 A (1:1 이전)**

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **V** | CodeMirror 묶음 스크립트·벤더링·판 기록 | LOW |
| **E** | 편집기 코어 (옵션·테마·언어·화면 상태·키) | MEDIUM |
| **P** | 같은 파일을 여러 칸에서 편집 (상태 전달) | HIGH |
| **F** | 파일 안 찾기/바꾸기 패널의 엔진 교체 | LOW |
| **D** | 변경 줄 표시(dirty diff)와 미리보기 | MEDIUM |
| **G** | Git Diff 뷰 (`@codemirror/merge`) | HIGH |
| **M** | 미니맵 (`@replit/codemirror-minimap` 포크) | MEDIUM |
| **R** | Overview ruler (직접 구현) | MEDIUM |
| **K** | Sticky scroll (직접 구현) | MEDIUM |
| **L** | 브라우저 LSP (`@codemirror/lsp-client`) | MEDIUM |
| **S** | 서버 LSP 통로 (WebSocket ↔ stdio) | HIGH |
| **W** | 열리지 않은 파일의 변경 알림 (`didChangeWatchedFiles`) | MEDIUM |
| **T** | e2e 테스트의 편집기 접근 계층 | MEDIUM |
| **X** | Monaco 제거와 문서 개정 | LOW |

**포함 — 단계 B (기능 추가, A 의 e2e 회귀 통과 뒤 착수)** — 묶음 **B**, §3.15.

**미포함** — §5.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| **칸** | 편집기 하나가 그려지는 pane. 같은 파일을 여러 칸에서 열 수 있다 |
| **문서 그룹** | 같은 파일을 연 칸들의 묶음. 칸마다 `EditorState` 가 따로 있다 |
| **통로** | 서버의 `/api/lsp/ws` 종단. WebSocket 메시지와 언어 서버 stdio 를 잇는다 |
| **끼워 넣기** | 통로가 브라우저를 거치지 않고 언어 서버 쪽으로 직접 보내는 알림 |
| **offset** | CodeMirror 의 문서 위치. 문서 앞에서부터 센 UTF-16 코드 단위 수 |
| **Monaco 좌표** | 1 부터 세는 (줄, 열). LSP 좌표는 0 부터 센다 |
| **포크** | 외부 패키지 소스를 저장소로 가져와 고쳐 쓰는 것. 원본 라이선스를 유지한다 |

### 1.4 참조 (References)

- `MONACO_VENDORING_SRS.md` — 벤더링·사전압축 서빙. 묶음 Z(사전압축)·C(CSP)는 그대로 유효하다.
- `EDITOR_LSP_SRS.md` · `LSP_PLUGIN_SRS.md` · `DOCLANG_LSP_SRS.md` — LSP 상태·설치·선언. 관리 기능은 유지한다.
- `EDITOR_FIND_PANEL_SRS.md` · `EDITOR_REPLACE_AND_SEED_SRS.md` — 찾기/바꾸기 패널.
- `EDITOR_DIRTY_DIFF_SRS.md` — 변경 줄 표시.
- `EDITOR_MINIMAP_TOGGLE_SRS.md` · `UX_BATCH8_SRS.md` FR-MMP-2 · `M9_SRS.md` — 미니맵.
- `GIT_UI_REVISION_SRS.md` · `UX_BATCH10_SRS.md` — Diff 뷰.
- `EDITOR_LIVE_RELOAD_SRS.md` · `EDITOR_EXTERNAL_CHANGE_SRS.md` — 바깥 변경 반영.
- `VENDOR_VERSIONS.md` · `scripts/check-vendor.sh`.
- CodeMirror 6 reference manual — <https://codemirror.net/docs/ref/>.

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 Monaco 를 쓰는 자리

- 프런트엔드 파일 약 30개. 핵심은 `file-editor.js`(1002줄) · `file-editor-diff.js`(528) ·
  `file-editor-find.js`(460) · `git/diff-view*.js` · `core/lsp-client.js`(702).
- 명시적으로 켠 옵션 (`edTextOptions`·`edMinimapOpts`·`GIT_DIFF_OPTIONS`):

| 옵션 | 값 |
|---|---|
| `wordWrap` | 설정값 (`editorWordWrap`, 기본 끔) |
| `fontSize` · `fontFamily` · `lineHeight` | `edFontSize()` · `ED_FONT_FAMILY` · 1.5 |
| `tabSize` · `insertSpaces` | 4 · true |
| `lineNumbers` | on |
| `renderWhitespace` | selection |
| `bracketPairColorization` · `guides` | 켬 · 괄호 쌍·들여쓰기 가이드 켬 |
| `smoothScrolling` · `cursorBlinking` · `cursorSmoothCaretAnimation` | 켬 · blink · 끔 |
| `scrollBeyondLastLine` | false |
| `minimap` | 설정값 (`editorMinimap`), `size:'fill'`, `showSlider:'mouseover'` |
| `readOnly` | 디코딩 실패 문서 · Diff 원본 |
| Diff: `renderSideBySide` · 폭 900 미만이면 인라인 · `hideUnchangedRegions` · `ignoreTrimWhitespace` · `renderOverviewRuler` | 토글 · 자동 · 기본 끔 · 토글 · 켬 |

- Monaco 기본값으로 켜져 있던 기능: sticky scroll(`enabled:true`, 최대 5줄 — 벤더 번들에서
  확인), 우클릭 메뉴, F1 명령 팔레트, 코드 접기, 다중 커서, 괄호 자동 닫기, 문서 단어 자동완성 등.
- 언어 매핑 `LANG_MAP`(`file-editor.js:15`) — 확장자 약 60개 → 언어 약 40개.

### 2.2 크기 — 실측

| | Monaco 0.56 (지금) | CodeMirror 6 (PoC) |
|---|---|---|
| 첫 로드 (gz) | 약 1.0MB (`editor`·`toggleHighContrast`·`editorWorkerHost`·`loader`) | **약 186KB** (묶음 A 확장 전체) |
| 전체 (gz) | 5.66MB (138파일) | 약 0.6MB (언어 115개 포함) |
| 언어 | 번들 안 | 언어마다 청크 하나, 쓸 때만 받는다 |

### 2.3 서버 LSP — 지금 구조

- 서버가 언어 서버 프로세스와 문서 동기화를 맡는다. 브라우저는 REST 만 부른다:
  `/api/lsp/{status,paths,close,install,definition,references,hover}` (`handlers_api.go:196-204`).
- 진단은 hub 의 `lsp_diagnostics` 액션으로 브라우저에 밀어 준다.
- 이 API 를 부르는 쪽은 **웹 편집기 하나뿐**이다. dmctl·CLI 는 쓰지 않는다.
- `ResyncPath`(파일 저장 뒤)·`ResyncRepo`(`git_changed` 뒤)는 **열린 문서만** 디스크 판으로
  맞춘다. 열리지 않은 파일은 알리지 않는다 (`manager.go:414` 주석이 비목표로 밝힌다).
- `git_changed` 는 저장소 경로만 싣는다. 바뀐 파일 목록은 없다 (`deps.go:167`).
- CSP `connect-src 'self' ws: wss:` — WebSocket 종단을 새로 더해도 CSP 는 바뀌지 않는다.

### 2.4 테스트·문서의 Monaco 의존

- e2e 파일 37개가 Monaco 를 직접 잡는다: `.monaco-editor`(43) · `.monaco-diff-editor`(9) ·
  `monaco.editor.getEditors`(5) · `.monaco-hover`(3) · `EditorOption.*` 등.
- 단위 테스트(`web/js/test`)에는 Monaco 의존이 없다.
- `docs` 아래 79개 문서, 그중 SRS 40개가 Monaco 를 언급한다.
- 스크립트: `check-vendor.sh` · `check-font-family.mjs`.

### 2.5 묶는 방식의 제약

- 벤더 자산은 모두 저장소에 커밋되고 `go:embed` 로 바이너리에 든다. `go build` 에는 Node 가
  필요 없다. 이 성질을 유지한다.
- 프런트엔드는 번들러 없이 `<script>` 로 읽는 고전 스크립트다. `import()` 는 고전 스크립트에서도
  쓸 수 있다.

### 2.6 PoC 결과 (`/tmp/cm-poc`)

| # | 항목 | 결과 |
|---|---|---|
| 1 | 크기 | §2.2 |
| 2 | 미니맵 `@replit/codemirror-minimap` 0.5.2 | dirty diff 표시(`gutters`)·슬라이더 마우스오버(`showOverlay`)·진단·선택 표시는 된다. **`fill` 좌표계와 찾기 결과 표시는 없다** |
| 3 | `@codemirror/merge` 공백 무시 | 옵션 없음. `diffConfig.override` 로 비교 함수를 바꿔 끼울 수 있다 |
| 4 | legacy-modes | Makefile·VimL 은 Monaco 에도 없다(변화 없음). **Bat 만 빠진다** |
| 5 | 괄호 쌍 색 패키지 | `rainbowbrackets` 2.0.2 하나뿐(개인 저장소, 2023-04 이후 갱신 없음) |
| 6 | 단어 단위 검색 | 언어마다 단어 문자가 다르다(JS 는 `$` 포함). `SearchQuery({test})` 로 판정을 바꿀 수 있다 |
| 7 | LSP (gopls, WebSocket 통로) | 초기화 0.3~0.5초, 진단·hover 정상. 끼워 넣은 `didChangeWatchedFiles` 로 진단이 사라진다. **알리지 않으면 15초 뒤에도 남는다(대조 실험)** — gopls 는 스스로 감시하지 않는다 |

추가 발견:

- `lsp-client` 6.3.0 이 지원하는 메서드: `didOpen`·`didChange`·`didClose`·`hover`·`definition`·
  `declaration`·`implementation`·`typeDefinition`·`references`·`completion`·`signatureHelp`·
  `rename`·`formatting`·`publishDiagnostics`. `workspace/didChangeWatchedFiles`·
  `client/registerCapability` 는 지원하지 않는다.
- 기본 `Workspace` 는 **파일 하나에 편집기 하나**만 허용한다.
- hover 의 Markdown 렌더링에 `marked` 를 쓴다. `sanitizeHTML` 자리가 있다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 V — 묶음 스크립트와 벤더링

**FR-CMR-1** `scripts/build-codemirror.mjs` 가 esbuild 로 CodeMirror 패키지를 묶는다.
출력은 ESM 이고 코드 분할을 켠다. 진입점은 `scripts/codemirror/entry.js` 하나이며 출력 진입 파일은 `cm.js` 다.

**FR-CMR-1a** 묶음의 **입력**(`entry.js`·`package.json`·`package-lock.json`·포크 소스)은 `scripts/codemirror/` 에 둔다.
`web/vendor/` 에는 **출력만** 둔다 — `web/embed.go` 가 `vendor/*` 를 통째로 바이너리에 넣으므로, 입력을 두면
배포본에 실리고 정적 파일로 공개된다.

**FR-CMR-2** 출력은 `web/vendor/codemirror/` 아래에 `.gz` 로만 담는다 (`MONACO_VENDORING_SRS`
FR-MVN-5 규칙). 저장소에 raw 사본을 두지 않는다.

**FR-CMR-3** 언어는 `@codemirror/language-data` 의 동적 로드로 나뉜다. 첫 로드에 언어 청크가
들어가지 않는다.

**FR-CMR-4** 묶음은 사람이 판을 올릴 때만 다시 만든다. `scripts/build.sh` 는 이 스크립트를
부르지 않는다. 묶음 스크립트용 패키지 판은 `scripts/codemirror/package.json`(정확한 판)과 `package-lock.json` 에 고정한다.
같은 입력으로 다시 묶으면 출력 바이트가 같다 (gzip 머리의 시각은 0).

**FR-CMR-5** `VENDOR_VERSIONS.md` 에 패키지별 판과 라이선스를 적는다. `check-vendor.sh` 는
`codemirror` 디렉터리 자산의 집계 해시를 검사한다 (monaco 와 같은 방식).

**FR-CMR-5a** 묶음에 들어간 패키지(esbuild metafile 의 입력 기준)의 `LICENSE` 를 모아
`THIRD_PARTY_LICENSES.txt.gz` 로 출력에 함께 담는다. 패키지마다 이름·판·라이선스 본문이 선다.

**FR-CMR-6** 앱은 진입점의 공개 이름을 전역 `CM` 하나로 받는다. 다른 파일은 패키지를 직접
import 하지 않는다.

### 3.2 묶음 E — 편집기 코어

**FR-CMR-10** §2.1 의 명시 옵션을 모두 같은 결과로 옮긴다:

| Monaco | CodeMirror 6 |
|---|---|
| 줄 번호 | `lineNumbers()` |
| `wordWrap` | `EditorView.lineWrapping` (Compartment 로 켜고 끈다) |
| 글꼴·크기·줄 높이 | `EditorView.theme` (CSS 변수) |
| 탭 4·공백 | `EditorState.tabSize` 4 · `indentUnit` 공백 4 |
| `readOnly` | `EditorState.readOnly` |
| `renderWhitespace:'selection'` | 선택 범위 안의 공백만 표시하는 데코레이션 (직접 구현) |
| 괄호 쌍 색 | 구문 트리 기반 데코레이션 (직접 구현, 깊이별 색 6개를 순환) |
| 들여쓰기·괄호 쌍 가이드 | `@replit/codemirror-indentation-markers` |
| 커서 깜박임·애니메이션 끔 | `drawSelection()` 기본값 |
| 부드러운 스크롤 | 프로그램이 스크롤할 때 `scroll-behavior: smooth` |
| `scrollBeyondLastLine:false` | `scrollPastEnd()` 를 넣지 않는다 |
| `automaticLayout` | 기본 동작. `layout()` 호출을 모두 없앤다 |

**FR-CMR-11** Monaco 가 기본으로 주던 편집 동작을 넣는다: 실행 취소(`history`), 괄호 자동 닫기,
괄호 짝 강조, 입력 시 자동 들여쓰기, 코드 접기(`foldGutter`), 다중 커서·사각 선택, 같은 단어 강조,
현재 줄 강조, 주석 토글·줄 이동·줄 복제(`defaultKeymap`), 문서 단어 자동완성.

**FR-CMR-12** 테마는 CSS 변수를 직접 읽는 `EditorView.theme` + `HighlightStyle` 이다. 테마를 바꾸면
다시 정의하지 않고 변수만 바뀐다. `monacoTheme()`·`defineTheme` 파생 코드는 없앤다.
Diff 의 추가·삭제 색은 지금처럼 터미널 팔레트에서 파생한다 (FR-GIT-119).

**FR-CMR-13** 언어 매핑은 `LANG_MAP` 을 유지하되 값은 `language-data` 의 언어 이름이다. 첫 열기에서
그 언어 청크를 받는다. 받는 동안에는 일반 텍스트로 보이고, 받은 뒤 강조가 붙는다.

**FR-CMR-14** `.bat`·`.cmd` 는 일반 텍스트다. Makefile·VimL 은 지금처럼 일반 텍스트다.

**FR-CMR-15** 화면 상태(커서·선택·스크롤·접힘)를 문서를 바꿀 때 보관하고 되돌린다.
`EditorState` 를 보관하고 스크롤은 `view.scrollSnapshot()` 으로 되돌린다.

**FR-CMR-16** 수정 여부(dirty)는 저장한 시점의 `Text` 와 지금 `Text` 를 `eq()` 로 비교해 정한다.
`getAlternativeVersionId` 를 쓰는 자리는 모두 이것으로 바꾼다.

**FR-CMR-17** 키 처리는 지금 구조를 유지한다 — 설정 가능한 단축키는 기존 keydown 경로가 받는다
(FR-EKB-5). 편집기 안의 `keymap` 은 편집 동작만 둔다. Monaco 의 기본 키를 무력화하던 코드
(`_findKillWidgetKeys`·`_lspKillMonacoKeys`)는 없앤다 — 무력화할 기본 키를 처음부터 넣지 않는다.

**FR-CMR-18** sticky scroll 을 제외한 Monaco 기본 UI 중 CodeMirror 에 없는 것은 넣지 않는다 (§3.16).

### 3.3 묶음 P — 같은 파일을 여러 칸에서 편집

**FR-CMR-20** 같은 파일을 연 칸들은 문서 그룹이 된다. 칸마다 `EditorState` 가 따로 있다.

**FR-CMR-21** 한 칸의 변경은 같은 그룹의 다른 칸에 전달된다. 전달된 변경은 받는 칸의 실행 취소
기록에 들어가지 않는다 (`Transaction.addToHistory.of(false)`). 전달 표식 annotation 이 있는 변경은
다시 전달하지 않는다.

**FR-CMR-22** 실행 취소는 칸마다 따로다 — 그 칸에서 입력한 변경만 되돌린다. (동작 변경 §3.16)

**FR-CMR-23** LSP 에는 그룹당 문서 하나로 보인다. 그룹의 첫 칸이 열 때 `didOpen`, 마지막 칸이
닫힐 때 `didClose` 를 보낸다. 이를 위해 사용자 정의 `Workspace` 를 둔다.

**FR-CMR-24** 바깥 변경으로 다시 읽을 때(`EDITOR_LIVE_RELOAD_SRS`)는 그룹 전체를 한 번에 바꾼다.

### 3.4 묶음 F — 찾기/바꾸기 패널

**FR-CMR-30** 패널 UI 는 그대로 두고 검색 엔진만 바꾼다. `search()` 위젯은 넣지 않는다.

**FR-CMR-31** 대소문자·정규식·단어 단위 옵션은 `SearchQuery` 로 옮긴다. 단어 단위 판정은
`SearchQuery({test})` 로 `ED_FIND_WORD_SEPARATORS` 를 쓴다 — 언어마다 결과가 달라지지 않는다.

**FR-CMR-32** 일치는 최대 `ED_FIND_MAX_HITS`(20000)까지 센다.

**FR-CMR-33** 바꾸기 1건·모두 바꾸기는 각각 트랜잭션 하나다 (실행 취소 한 번에 되돌아간다).
`userEvent` 는 `ED_FIND_EDIT_SOURCE` 에서 만든다.

**FR-CMR-34** 일치 표시는 `Decoration.mark` 로 하고, 클래스는 `ED_FIND_HIT_CLASS`·
`ED_FIND_HIT_CUR_CLASS` 를 그대로 쓴다. 일치 위치는 overview ruler(오른쪽)와 미니맵에도 찍힌다.

**FR-CMR-35** 잘못된 정규식은 `SearchQuery.valid` 로 판정하고 `ED_FIND_BAD_RE` 를 보인다.

### 3.5 묶음 D — 변경 줄 표시

**FR-CMR-40** 추가·수정·삭제 표시는 `gutter()` + `GutterMarker` 다. 표시 범위는 편집에 맞춰
`RangeSet.map` 으로 옮겨진다. 경계에서 입력해도 범위가 늘어나지 않는다.

**FR-CMR-41** gutter 표시를 누르면 그 변경의 원본을 줄 사이에 끼워 보여 준다
(`Decoration.widget({block:true})`). 표시가 없는 줄을 누르면 닫힌다.

**FR-CMR-42** 변경 위치는 overview ruler(왼쪽)와 미니맵 gutter 에도 찍힌다.

### 3.6 묶음 G — Git Diff 뷰

**FR-CMR-50** 나란히 보기는 `MergeView`, 인라인은 `unifiedMergeView` 다.

**FR-CMR-51** 폭이 `renderSideBySideInlineBreakpoint`(900px) 미만이면 인라인으로 바꾼다. 다시 넓어지면
나란히 보기로 돌아간다. 바꿀 때 스크롤 위치를 유지한다.

**FR-CMR-52** 변경 없는 구간 접기는 `collapseUnchanged` 로 한다. 기본은 끔이다 (FR-DOR-2).

**FR-CMR-53** 앞뒤 공백 무시를 켜면 `diffConfig.override` 가 줄 단위로 앞뒤 공백을 걷어 낸 텍스트를
비교한다. 결과 범위는 원래 텍스트의 offset 으로 되돌려 낸다. 공백만 다른 줄은 변경으로 보이지 않는다.

**FR-CMR-54** 원본 쪽은 읽기 전용이다. 수정본 쪽은 `GIT_AXIS_EDITABLE` 축에서만 편집할 수 있다
(FR-RTU-50). 편집할 수 있으면 같은 파일의 문서 그룹(§3.3)에 들어간다.

**FR-CMR-55** hunk 조작 막대는 `showTooltip` 으로 hunk 의 첫 줄 위에, 자리가 없으면 아래에 띄운다.
hunk 좌표는 `getChunks()` 에서 얻는다.

**FR-CMR-56** 수정본 쪽에는 일반 편집기와 같은 LSP·찾기·미니맵 확장을 붙인다 (UX_BATCH10_SRS 묶음 D).
Diff 에는 지금처럼 미니맵이 없다 (D-M9-5).

**FR-CMR-57** Diff 전체의 변경 위치를 overview ruler 에 찍는다 (FR-DOR-1).

### 3.7 묶음 M — 미니맵

**FR-CMR-60** `@replit/codemirror-minimap` 0.5.2 를 `scripts/codemirror/minimap/` 으로 포크한다.
MIT 라이선스 파일과 원본 판·커밋을 함께 둔다.

**FR-CMR-61** 미니맵 높이는 문서 길이와 상관없이 편집기 높이와 같다 — `fill` 좌표계 (FR-MMP-2).
미니맵 안의 뷰포트 표시는 스크롤바 thumb 와 같은 세로 위치·높이에 선다 (허용 오차 ±2px).

**FR-CMR-62** 찾기 일치(FR-CMR-34)와 현재 일치를 미니맵 줄 위에 색으로 찍는 층을 더한다.

**FR-CMR-63** 슬라이더는 마우스를 올렸을 때만 보인다. 켜고 끄기는 `editorMinimap` 설정이다
(EDITOR_MINIMAP_TOGGLE_SRS). 생성과 갱신은 한 함수(`edMinimapOpts` 후속)에서 만든다 (FR-MMT-5).

### 3.8 묶음 R — Overview ruler

**FR-CMR-70** 스크롤바 옆에 겹쳐 그리는 overview ruler 확장을 직접 만든다. 칸은 왼쪽·오른쪽 둘이다.

**FR-CMR-71** 표시의 세로 위치는 `lineBlockAt(pos).top / contentHeight` 비율이다. 줄바꿈과 접힌
구간이 있어도 실제 스크롤 위치와 맞는다. (D-1 개정: 좌표 계산의 주인은 Monaco 가 아니라 이 확장이다.)

**FR-CMR-72** 표시의 출처는 셋이다: 찾기 일치(오른쪽), dirty diff(왼쪽), Git Diff 변경(양쪽).
색은 테마 CSS 변수에서 온다.

**FR-CMR-73** 문서가 바뀌거나 높이가 바뀌면 다음 프레임에 한 번만 다시 그린다.

### 3.9 묶음 K — Sticky scroll

**FR-CMR-80** 화면 맨 위 줄을 감싸는 범위(함수·클래스·블록 등)의 첫 줄을 편집기 위에 고정해
보여 준다. 최대 5줄이다. 바깥 범위가 위에 선다.

**FR-CMR-81** 범위는 구문 트리가 있으면 `foldable()` 범위로 정한다. 구문 트리가 없는 언어
(legacy-modes)는 들여쓰기로 정한다.

**FR-CMR-82** 고정된 줄을 누르면 그 줄로 스크롤한다.

**FR-CMR-83** 스크롤·문서 변경 때 다시 계산한다. 계산은 viewport 맨 위 줄 하나에 대해서만 한다.

### 3.10 묶음 L — 브라우저 LSP

**FR-CMR-90** `@codemirror/lsp-client` 를 쓴다. 연결 단위는 (저장소 루트, 언어 서버)이며, 연결마다
`LSPClient` 하나다.

**FR-CMR-91** `Transport` 는 `/api/lsp/ws?root=<루트>&server=<서버 id>` WebSocket 이다. 연결이 끊기면
`LSPClient.disconnect()` 하고, 그 연결을 다시 쓸 때 다시 연다.

**FR-CMR-92** A 단계에서 켜는 기능은 지금과 같다: hover, 정의로 이동(F12), 참조 찾기(Shift+F12),
진단 표시. 진단 켜기/끄기(`lspDiagOn`)는 `serverDiagnostics()` 확장을 Compartment 로 넣고 뺀다.

**FR-CMR-93** 정의·참조가 다른 파일을 가리키면 앱이 그 파일을 연다. 참조 결과는 기존 결과 목록
패널(`_lspList`)에 보인다. 뒤로 가기(`_lspNavBack`)는 유지한다.

**FR-CMR-94** hover Markdown 의 `sanitizeHTML` 은 `purify.js`(DOMPurify)다.

**FR-CMR-95** LSP 상태·설치·경로 패널(`_lspRefresh` 등)과 `/api/lsp/{status,install,paths}` 는 유지한다.

### 3.11 묶음 S — 서버 LSP 통로

**FR-CMR-100** `GET /api/lsp/ws` 를 더한다. 기존 WebSocket 종단과 같은 요청 게이트(same-origin·인증)를
지난다.

**FR-CMR-101** 연결 하나에 언어 서버 프로세스 하나를 띄운다. 브라우저 → 서버 메시지는
`Content-Length` 머리를 붙여 stdin 에, stdout 의 메시지는 머리를 떼어 WebSocket 으로 보낸다.
메시지 내용은 해석하지 않는다(끼워 넣기 제외).

**FR-CMR-102** 기존의 동시 실행 상한(`MaxSessions`=6)과 유휴 정리(`IdleAfter`=20분, `Sweep`)를 통로 프로세스에도 적용한다. 상한에
걸리면 연결을 거절하고 WebSocket close reason 에 코드를 싣는다. 브라우저는 그것을 상태 패널에 보인다.

**FR-CMR-103** WebSocket 이 닫히면 프로세스를 끝낸다. 프로세스가 끝나면 WebSocket 을 닫는다.

**FR-CMR-104** 메시지 크기 상한은 `MaxTextBytes`(= `editorlimit.FileMaxBytes`)에 JSON 머리 몫을 더한 값이다. 넘으면 연결을 닫는다.

**FR-CMR-105** 제거: `/api/lsp/{definition,references,hover,close}` 핸들러, 서버의 문서 동기화
(`doclife`·`needText`·`ResyncPath`·`ResyncRepo`·`CloseDoc`), hub 의 `lsp_diagnostics` 액션과 슬롯.

### 3.12 묶음 W — 열리지 않은 파일의 변경 알림

**FR-CMR-110** 파일 저장 API(`handlers_files.go`)가 파일을 쓰면, 그 경로가 루트 아래에 있는 모든
통로에 `workspace/didChangeWatchedFiles`(새 파일 `Created`, 있던 파일 `Changed`)를 끼워 넣는다.

**FR-CMR-111** `git_changed` 가 오면 그 저장소의 바뀐 파일 목록을 계산해 끼워 넣는다. 목록은
(직전 HEAD → 지금 HEAD 의 `git diff --name-status`) ∪ (직전 작업 트리 변경 집합) ∪
(지금 작업 트리 변경 집합)이다. 서버는 저장소마다 직전 HEAD 와 작업 트리 변경 집합을 기억한다.

**FR-CMR-112** 삭제된 파일은 `Deleted`, 새 파일은 `Created`, 나머지는 `Changed` 다.

**FR-CMR-113** 한 번에 보내는 변경이 `LSP_WATCH_MAX`(기본 2000)를 넘으면 앞에서부터 그 수만 보낸다.

**FR-CMR-114** 끼워 넣기는 언어 서버 쪽 방향에만 쓴다. 브라우저 쪽 메시지 흐름에는 아무것도 더하지
않는다.

### 3.13 묶음 T — e2e 접근 계층

**FR-CMR-120** e2e 가 편집기를 읽고 조작하는 함수를 `e2e/editor.ts` 한 곳에 둔다 (기존 `fixtures.ts` 와 같은 자리)
(내용 읽기·쓰기, 커서, 옵션 상태, 진단 수, hover 열림, Diff 뷰 찾기 등).

**FR-CMR-121** 엔진 핸들(칸의 편집기 객체·Diff 의 양쪽·문서 레지스트리의 문서)을 읽는 코드는
`e2e/editor.ts` 의 페이지 안 어댑터 `edT` 하나다. 스펙은 `edT` 와 선택자 객체 `ED_SEL` 만 쓰고, 엔진 전역
(`monaco.*`)·엔진 DOM 클래스·엔진 핸들 필드(`_editor`·`_mod`·`_orig`·`.model`)를 직접 쓰지 않는다.
어댑터는 fixtures 가 모든 페이지에 초기화 스크립트로 심는다.

**FR-CMR-122** 기존 e2e 37개 파일은 이 계층으로 옮긴다. 검증하는 동작은 바꾸지 않는다 — 바뀌는 것은
§3.16 의 동작 변경에 걸린 단언뿐이다.

### 3.14 묶음 X — Monaco 제거

**FR-CMR-130** `web/vendor/monaco/` 를 지운다. `loadMonaco`·`MONACO_*` 상수를 지운다.

**FR-CMR-131** `static.go` 의 Monaco 전용 주석·처리를 정리한다. 사전압축 서빙 규칙(FR-MVN-6~11)은
monaco 전용이 아니므로 유지한다.

**FR-CMR-132** 완료 시점에 `git grep -i monaco` 결과는 다음 자리에만 남는다: `CHANGELOG.md`,
`docs/internal/archive/`, 이 문서, `MONACO_VENDORING_SRS.md`(대체 표시).

**FR-CMR-133** `check-font-family.mjs` · `check-vendor.sh` · `eslint.config.mjs` · `playwright.config.ts` 의
Monaco 언급을 CodeMirror 에 맞춘다.

### 3.15 묶음 B — 기능 추가 (단계 B)

| ID | 기능 | 출처 |
|---|---|---|
| **FR-CMR-140** | LSP 자동완성 · 시그니처 도움말 · 이름 바꾸기 · 포맷팅 · 선언/구현/타입 정의로 이동 | `lsp-client` 확장 |
| **FR-CMR-141** | 구문 트리 기반 선택 확장 | `selectParentSyntax` |
| **FR-CMR-142** | Vim / Emacs 키맵 (설정으로 고른다) | `@replit/codemirror-vim` · `-emacs` |
| **FR-CMR-143** | 언어 패키지가 주는 스니펫 완성 | `@codemirror/autocomplete` |
| **FR-CMR-144** | 린트 gutter · 진단 목록 패널 · 다음/이전 진단 이동 | `@codemirror/lint` |
| **FR-CMR-145** | 특수 문자 강조 | `highlightSpecialChars` |
| **FR-CMR-146** | 줄 끝 공백 강조 | `highlightTrailingWhitespace` |
| **FR-CMR-147** | 빈 문서 안내 문구 (메모장 등) | `placeholder` |
| **FR-CMR-148** | CSS 색 미리보기·색상 선택기 | `@replit/codemirror-css-color-picker` |
| **FR-CMR-149** | 수정키+클릭으로 정의 이동 · 링크 열기 | `@replit/codemirror-interact` |
| **FR-CMR-150** | 인라인 git blame | 위젯 데코레이션 + `/api/git/blame` |

B 묶음은 별도 패키지 청크(`extras`)로 묶는다. 켜지 않은 기능의 청크는 받지 않는다.
B 착수 전에 §8 의 미해결 질문을 해소한다.

### 3.16 동작 변경 기록

| 항목 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| 여러 칸의 실행 취소 | 파일 단위 기록 하나. 어느 칸에서든 마지막 편집을 되돌린다 | 칸마다 따로. 그 칸의 편집만 되돌린다 | 사용자 결정. CodeMirror 에 공유 모델이 없다 |
| 우클릭 메뉴 | Monaco 메뉴 | 브라우저 기본 메뉴 | 사용자 결정 — 기본값으로 따라온 기능이고 CodeMirror 에 없다 |
| F1 명령 팔레트 | Monaco 팔레트 | 없음 | 위와 같다 |
| `.bat`·`.cmd` 강조 | Monaco `bat` | 일반 텍스트 | 사용자 결정 — legacy-modes 에 없다 |
| 열리지 않은 파일의 변경 | 언어 서버에 알리지 않는다 (낡은 결과) | 저장·git 변화를 `didChangeWatchedFiles` 로 알린다 | 사용자 결정 — PoC 대조 실험에서 낡은 결과 확인 |
| LSP 구조 | 서버가 중개(REST), 진단은 hub 로 | 브라우저 `lsp-client` ↔ WebSocket 통로 | Monaco 잔재 제거 |
| LSP 세션 단위 | (루트, 서버)당 프로세스 하나를 모든 탭이 공유 | 연결마다 하나 | `lsp-client` 는 클라이언트 하나가 서버 하나를 독점한다고 가정한다 |
| Diff 공백 무시 | Monaco `ignoreTrimWhitespace` | 줄 단위 정규화 비교 | 같은 결과를 목표로 한다. 줄 안의 강조 범위는 다를 수 있다 |

### 3.17 비기능 요구 (NFR)

**NFR-CMR-1 (첫 로드)** 편집기를 처음 열 때 받는 CodeMirror 자산은 gzip 250KB 이하다 (언어 청크·B 묶음 제외).

**NFR-CMR-2 (벤더 총량)** `web/vendor/codemirror` 의 `.gz` 합은 1.5MB 이하다.

**NFR-CMR-3 (열기)** 10,000줄 TypeScript 파일을 열어 첫 화면이 그려지기까지 언어 청크가 캐시된
상태에서 300ms 이하다 (e2e, 로컬 Chromium).

**NFR-CMR-4 (입력)** 같은 파일을 연 칸이 셋일 때, 한 칸의 입력이 다른 두 칸에 반영되는 시간은
1프레임(16ms) 안이다.

**NFR-CMR-5 (LSP 연결)** 통로 연결부터 `initialize` 완료까지 서버 몫의 지연(프로세스 시작 제외)은
50ms 이하다.

**NFR-CMR-6 (접근성)** 편집기 영역은 기존 접근성 기준(`ACCESSIBILITY_BASELINE_SRS`)의 axe 검사를 통과한다.

---

## 4. 검증 (Verification)

### 4.1 단위 테스트 (`node --test`, `web/js/test/`)

| 대상 | 정상 | 경계 | 실패 |
|---|---|---|---|
| 공백 무시 diff (FR-CMR-53) | 공백만 다른 줄은 변경 0 | 빈 줄·탭·CRLF·문서 끝 개행 없음 | 정규화 뒤 offset 이 원문 범위를 넘지 않음 |
| 단어 단위 판정 (FR-CMR-31) | 구분자 경계 일치 | 문서 처음·끝, 한글, `$` | 단어 안의 일치는 거절 |
| 칸 사이 전달 (FR-CMR-21) | 변경이 모든 칸에 같음 | 동시 입력 두 칸 | 전달된 변경은 다시 전달되지 않음·history 에 없음 |
| sticky 범위 (FR-CMR-81) | 중첩 3단계 | 5단계 초과 → 5줄 | 구문 트리 없는 언어 → 들여쓰기 경로 |
| ruler 좌표 (FR-CMR-71) | 비율 위치 | 접힘·줄바꿈 | 빈 문서 |
| dirty 판정 (FR-CMR-16) | 편집 후 dirty | 편집 후 원상 복귀 → clean | — |

### 4.2 Go 테스트 (`internal/webserver/...`)

| 대상 | 내용 |
|---|---|
| 프레이밍 (FR-CMR-101) | 여러 메시지가 한 번에 오거나 쪼개져 와도 경계가 맞다 · 멀티바이트 본문 길이 |
| 수명 (FR-CMR-103) | WS 닫힘 → 프로세스 종료 · 프로세스 종료 → WS 닫힘 |
| 상한 (FR-CMR-102·104) | 동시 상한 초과 거절 · 본문 상한 초과 시 닫힘 |
| 게이트 (FR-CMR-100) | 다른 origin 거절 |
| 끼워 넣기 (FR-CMR-110~114) | 저장 → 루트 아래 통로에만 · git 변화 → 목록 계산(HEAD 이동·작업 트리·삭제·새 파일) · 상한 2000 · 브라우저 쪽으로는 아무것도 가지 않음 |
| 제거 (FR-CMR-105) | 제거된 경로가 404 |

### 4.3 e2e (Playwright)

- 기존 e2e 37개 파일이 FR-CMR-120 계층으로 옮겨진 뒤 통과한다 (§3.16 에 걸린 단언만 바뀐다).
- 새 시나리오: 여러 칸 동시 편집 · 칸별 실행 취소 · Diff 폭 전환 · 공백 무시 토글 · 미니맵과 스크롤바
  thumb 위치 일치(짧은 문서·긴 문서) · sticky scroll 표시와 클릭 · LSP hover/정의/참조/진단(gopls 가
  있는 환경) · 브랜치 전환 뒤 진단 갱신.
- NFR-CMR-1·3·4 측정.

### 4.4 게이트

- `check-vendor.sh` 가 `codemirror` 집계 해시를 검사한다.
- FR-CMR-132 의 grep 결과를 스크립트로 검사한다.

---

## 5. 비목표 (Non-goals)

1. **실시간 협업 편집** (`@codemirror/collab` 의 다중 사용자 용도). 칸 사이 전달은 같은 브라우저 안의 일이다.
2. **우클릭 메뉴·F1 명령 팔레트** 재구현 (§3.16).
3. **Bat 구문 강조** 직접 작성.
4. **문서 단위 공유 실행 취소** (§3.16).
5. **언어 서버 자체 기능 개선** — 서버 판·설정은 `LSP_PLUGIN_SRS` 의 몫이다.
6. **모바일 전용 편집 UI** — CodeMirror 기본 동작 이상의 것은 하지 않는다.
7. **TypeScript 언어 서비스를 브라우저에서 돌리기** (Monaco 의 TS worker 대체) — 지금도 쓰지 않는다.

---

## 6. 기존 문서 개정

- `MONACO_VENDORING_SRS.md` — 머리에 "묶음 V 는 CODEMIRROR_MIGRATION_SRS 가 대체" 를 적는다.
  묶음 Z·C 는 유효하다.
- Monaco 를 언급하는 SRS 40개 — 조항을 다음 규칙으로 읽는다. 마일스톤 X 에서 각 문서 머리에
  개정 표시를 한 줄씩 단다.

| 옛 조항이 말하는 것 | 새 근거 |
|---|---|
| Monaco 옵션·API | §3.2 의 대응표 |
| Monaco 모델 공유 | §3.3 |
| Monaco find 위젯 무력화 | FR-CMR-17·30 (무력화할 것이 없다) |
| 미니맵 `size:'fill'` | FR-CMR-61 |
| `renderOverviewRuler` / D-1 | FR-CMR-70~73 |
| LSP REST·서버 문서 동기화 | §3.10·3.11 |

- `EDITOR_LSP_SRS.md` — 정의·참조·hover·진단의 전달 경로 조항을 §3.10·3.11 로 대체한다.
- `REPO_FIX 02 §3A-6`(ResyncPath/ResyncRepo) — FR-CMR-105·110·111 로 대체한다.

---

## 7. 마일스톤

순서는 의존 관계를 따른다. 각 마일스톤은 Spec → Test → Code 순서이고, 끝에 e2e 를 돌린다.

| # | 묶음 | 완료 조건 |
|---|---|---|
| **M1** | V | 묶음 스크립트·벤더·판 기록. 빈 페이지에서 `CM` 로드 확인 |
| **M2** | T | e2e 접근 계층을 Monaco 위에 먼저 만들고 37개 파일을 옮긴다 (엔진 교체 전 회귀 기준선) |
| **M3** | E · F | 일반 편집기와 찾기 패널 교체 |
| **M4** | P | 여러 칸 편집 |
| **M5** | R · M · D | ruler · 미니맵 포크 · dirty diff |
| **M6** | G | Diff 뷰 |
| **M7** | K | sticky scroll |
| **M8** | S · W · L | 통로 · 끼워 넣기 · 브라우저 LSP · 서버 문서 동기화 제거 |
| **M9** | X | Monaco 제거 · 문서 개정 · 게이트 |
| — | **A 완료** | e2e 전체 통과, NFR 측정 통과 |
| **M10~** | B | §8 해소 후 기능별로 |

M2 를 엔진 교체보다 먼저 두는 이유: 테스트를 옮기는 일과 엔진을 바꾸는 일을 한 마일스톤에 섞으면
실패의 원인을 가를 수 없다.

---

## 8. 미해결 질문 (B 착수 전 해소)

| # | 질문 | 권장 |
|---|---|---|
| Q1 | Vim/Emacs 키맵 설정을 서버 설정 블롭에 둘지, 기기별(localStorage)에 둘지 | 기기별 — 키 버릇은 손의 것이다 (`ED_FIND_OPTS_KEY` 와 같은 근거) |
| Q2 | Vim 모드에서 앱 단축키와 충돌할 때 어느 쪽이 이기는지 | 앱 단축키 — Vim 은 편집 영역 안에서만 |
| Q3 | 줄 끝 공백 강조의 기본값 | 끔, 설정으로 켠다 |
| Q4 | 인라인 blame 의 표시 방식 (현재 줄만 / 모든 줄) · 기본값 | 현재 줄만, 기본 끔 |
| Q5 | LSP 자동완성을 문서 단어 자동완성과 함께 보일지 | 함께, LSP 결과를 위에 |

---

## 9. 리스크

| 리스크 | 등급 | 대응 |
|---|---|---|
| 여러 칸 편집에서 상태가 갈라짐 | HIGH | 단위 테스트(전달 불변식) + e2e 동시 입력. 갈라지면 그룹 전체를 첫 칸의 상태로 맞춘다 |
| Diff 뷰 hunk 좌표가 기존 git 조작(`panel-hunks.js`·`hunk-coords.js`)과 어긋남 | HIGH | M6 전에 hunk 좌표 변환 단위 테스트를 먼저 쓴다 |
| 미니맵 포크의 유지 부담 | MEDIUM | 고친 자리를 포크 README 에 목록으로 남긴다 |
| 연결마다 프로세스 → 탭이 많으면 메모리 증가 | MEDIUM | 기존 동시 상한·유휴 정리 (FR-CMR-102) |
| e2e 37개 이전 규모 | MEDIUM | M2 를 따로 둔다 |
| `lsp-client` 판 갱신으로 API 변경 | LOW | 판 고정 (FR-CMR-4) |

---

## 10. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-02 | 초안 — 인터뷰 결정·PoC 결과 반영 |
| 2026-11-02 | FR-CMR-1·4·60 개정, FR-CMR-1a·5a 추가 — 묶음 입력이 `web/vendor` 에 있으면 바이너리와 정적 서빙에 실린다 (M1 착수 중 발견) |
| 2026-11-02 | FR-CMR-121 개정 — 앱에 훅을 새로 두지 않고 어댑터가 엔진 핸들을 읽는다. 엔진을 바꿀 때 고칠 자리를 어댑터 하나로 둔다 (M2 착수 중 결정) |
