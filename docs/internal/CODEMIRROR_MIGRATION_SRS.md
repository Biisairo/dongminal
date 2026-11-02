# SRS: 편집기 엔진 교체 — Monaco 에서 CodeMirror 6 으로 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: M8·M9 (단계 A) · M10~ (단계 B). M1~M7 완료.

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
닫힐 때 `didClose` 를 보낸다. 이를 위해 사용자 정의 `Workspace` 를 둔다. (`lsp-client` 가 들어오는 M8 에서 구현한다)

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

**FR-CMR-56** 수정본 쪽에는 일반 편집기와 같은 LSP·찾기 확장을 붙인다 (UX_BATCH10_SRS 묶음 D).
Diff 에는 미니맵이 없다 (D-M9-5). `diffMinimap` 설정(UX_BATCH10_SRS FR-UXB-42)은 걷는다 (동작 변경 §3.16, 2026-11-02 사용자 결정).

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

**FR-CMR-74** 편집기 칸의 세로 스크롤바는 직접 그린다. 브라우저 스크롤바는 숨긴다. track 과 thumb 는 DOM
요소이고, overview ruler 는 그 track 위에 겹친다. thumb 의 높이는 `clientHeight / scrollHeight` 비율(최소
높이 있음)이고, 세로 위치는 `scrollTop / (scrollHeight - clientHeight)` 비율이다. thumb 를 끌면 스크롤하고,
track 을 누르면 thumb 의 가운데가 그 자리로 온다(Monaco 기본값 `scrollByPage:false`). 휠 스크롤은 브라우저 동작 그대로다. (2026-11-02 사용자 결정 —
Monaco 도 스크롤바를 직접 그렸다)

### 3.9 묶음 K — Sticky scroll

**FR-CMR-80** 화면 맨 위 줄을 감싸는 범위(함수·클래스·블록 등)의 첫 줄을 편집기 위에 고정해
보여 준다. 최대 5줄이다. 바깥 범위가 위에 선다. 5줄을 넘으면 바깥 5줄을 남긴다. 범위의 첫 줄은 맨 위 줄보다
위에 있어야 한다 — 맨 위 줄 자신은 고정하지 않는다. 대상은 편집기 칸이다. Diff 뷰에는 없다 (§3.16, M7 사용자 결정).

**FR-CMR-81** 범위는 언어가 구문 트리를 주면(`StreamLanguage` 가 아닌 언어) 맨 위 줄을 감싸는 노드들의 첫 줄
가운데 `foldable()` 범위가 맨 위 줄에 닿는 줄로 정한다. 구문 트리가 없는 언어(legacy-modes)와 언어가 없는 파일은
들여쓰기로 정한다 — 맨 위 줄(빈 줄이면 그 아래 첫 글자 줄)보다 들여쓰기가 얕은 위쪽 줄을 차례로 고른다.

**FR-CMR-82** 고정된 줄을 누르면 커서를 그 줄 처음으로 옮기고, 그 줄이 그 줄을 감싸는 범위의 고정된 줄들
바로 아래에 보이도록 스크롤한다 — 고정된 줄이 그 줄을 덮지 않는다 (Monaco 와 같다).

**FR-CMR-83** 스크롤·문서 변경·구문 트리 갱신 때 다시 계산한다. 계산은 viewport 맨 위 줄 하나에 대해서만 한다.

**FR-CMR-84** 고정된 줄은 줄 번호와 그 줄의 글자를 편집기와 같은 구문 색으로 보인다. 줄바꿈하지 않는다.
가로 스크롤을 따라간다.

### 3.10 묶음 L — 브라우저 LSP

**FR-CMR-90** `@codemirror/lsp-client` 를 쓴다. 연결 단위는 **페이지 안의** (저장소 루트, 언어 서버)이며,
연결마다 `LSPClient` 하나다. 한 페이지의 편집기 칸·Diff 칸은 그 연결 하나를 같이 쓴다. 다른 페이지(브라우저
탭·창)는 자기 연결을 따로 연다. (M8 착수 중 결정 2)

**FR-CMR-91** `Transport` 는 `/api/lsp/ws?root=<루트>&server=<서술자 id(팩/서버)>` WebSocket 이다. 연결이 끊기면
`LSPClient.disconnect()` 하고, 그 연결을 다시 쓸 때 다시 연다.

**FR-CMR-92** A 단계에서 켜는 기능은 지금과 같다: hover, 정의로 이동(F12), 참조 찾기(Shift+F12),
진단 표시. 문서 동기화(`didChange`)는 진단 켜기/끄기와 관계없이 늘 동작한다. 진단 켜기/끄기(`lspDiagOn`)는
`textDocument/publishDiagnostics` 처리기가 본다 — 꺼져 있으면 그리지 않고 이미 그린 진단을 지운다. 받은 진단은
그룹의 문서(버퍼)에 보관하고, 다시 켜면 보관한 진단을 그 그룹의 모든 칸에 그린다. (M8 착수 중 결정 5)

**FR-CMR-93** 정의로 이동은 라이브러리의 `jumpToDefinition`, 참조 찾기는 라이브러리의 `findReferences`
(그 패널)다. 앱 단축키 `edGotoDef`·`edFindRefs` 가 이 명령을 부른다. 정의가 다른 파일을 가리키면
`Workspace.displayFile` 이 앱으로 그 파일을 열고, 편집기가 준비된 뒤 그 뷰를 돌려준다. 기존 결과 목록
(`_lspList`)과 뒤로 가기(`_lspNavBack`·`edNavBack`)는 걷는다. (M8 착수 중 결정 6, 동작 변경 §3.16)

**FR-CMR-94** hover Markdown 의 `sanitizeHTML` 은 `purify.js`(DOMPurify)다.

**FR-CMR-95** LSP 상태·설치·경로 패널(`_lspRefresh` 등)과 `/api/lsp/{status,install,paths}` 는 유지한다.

### 3.11 묶음 S — 서버 LSP 통로

**FR-CMR-100** `GET /api/lsp/ws` 를 더한다. 다른 경로와 같이 `accessGate`(출발지 기기)와 `requestGate`(출처)를
지난다. 제품에 인증은 없다. (M8 착수 중 결정 1 — 종전 문구 "인증" 은 사실과 달랐다)

**FR-CMR-101** 연결 하나에 언어 서버 프로세스 하나를 띄운다. 브라우저 → 서버 메시지는
`Content-Length` 머리를 붙여 stdin 에, stdout 의 메시지는 머리를 떼어 WebSocket 으로 보낸다.
메시지 내용은 해석하지 않는다(끼워 넣기 제외).

**FR-CMR-102** 기존의 동시 실행 상한(`MaxSessions`=6)과 유휴 정리(`IdleAfter`=20분, `Sweep`)를 통로 프로세스에도 적용한다.
(M8 착수 중 결정 3·4)

- 상한은 REST 세션과 통로 프로세스를 합쳐 센다. 상한에 걸리면 새 통로를 **거절**한다 — WebSocket 을 close code
  `LSP_WS_CLOSE_LIMIT`(4001), reason `limit` 으로 닫는다. 브라우저는 그것을 상태 패널에 보인다.
- 기존 LRU 정지(`evictOverLimit`)는 통로 프로세스를 정지 대상으로 고르지 않는다. 정지할 REST 세션이 없으면
  새 REST 세션은 상한 오류로 실패한다 (REST 가 사라지는 R 단위까지의 과도기).
- 유휴 판단의 기준(`LastUse`)은 통로를 지나는 프레임(양방향)마다 갱신한다. `IdleAfter` 동안 프레임이 없으면
  `Sweep` 이 프로세스를 끝내고 WebSocket 을 닫는다(FR-CMR-103). 브라우저는 다음에 그 연결을 쓸 때 다시 연다(FR-CMR-91).

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
| LSP 세션 단위 | (루트, 서버)당 프로세스 하나를 모든 탭이 공유 | 페이지마다 (루트, 서버)당 하나. 같은 페이지의 칸들은 공유한다 | `lsp-client` 는 클라이언트(브라우저)가 `initialize` 와 문서 상태를 맡는다. 페이지 사이에 공유하려면 서버가 내용을 해석해야 한다(FR-CMR-101 위배) (M8 결정 2) |
| LSP 동시 상한에 걸릴 때 | 가장 오래 안 쓴 세션을 정지(LRU) | 새 통로를 거절하고 상태 패널에 보인다. 열려 있는 통로는 빼앗기지 않는다 | 사용자가 보는 탭의 LSP 가 갑자기 끊기지 않게 한다 (M8 결정 3) |
| 정의가 여러 곳일 때 | 결과 목록(`_lspList`)에서 고른다 | 첫 항목으로 간다 | 사용자 결정 — 라이브러리 명령을 쓴다 (M8 결정 6) |
| 참조 찾기 | 앱의 결과 목록(`_lspList`). 열리지 않은 파일의 참조도 보인다 | `lsp-client` 의 참조 패널. 열리지 않은 파일의 참조는 빠진다 | 위와 같다. 라이브러리의 `requestFile` 은 열린 파일만 돌려준다 |
| 정의로 이동 뒤 돌아가기 | `edNavBack`(`Mod+Alt+Minus`)으로 직전 위치로 | 없음 — 단축키·설정 항목도 걷는다 | 사용자 결정 — 라이브러리에 대응 기능이 없다 (M8 결정 6) |
| e2e: 호버 provider 1회 · 요청 텍스트 생략(needText) | `editor-lsp-nav` 가 잰다 | 검사를 지운다 | Monaco provider 등록과 REST 텍스트 동기화의 개념이다 — CodeMirror·WS 통로에는 대응물이 없다 (M8 결정 8) |
| e2e: 참조 결과 목록 · 뒤로 가기 | `editor-lsp-nav` 가 잰다 | 목록 검사는 라이브러리 참조 패널 검사로 바꾸고, 뒤로 가기 검사는 지운다 | 위 두 줄의 동작 변경을 따른다 (M8 결정 6·8) |
| Diff 공백 무시 | Monaco `ignoreTrimWhitespace` | 줄 단위 정규화 비교 | 같은 결과를 목표로 한다. 줄 안의 강조 범위는 다를 수 있다 |
| `.tsx`·`.jsx` 강조 | Monaco `typescript`·`javascript` | TSX·JSX | language-data 에 전용 문법이 있다 — 태그가 강조된다 (M3) |
| 파일 이동·이름 변경 뒤 실행 취소 | 새 경로의 새 모델이라 사라졌다 | 남는다 | 경로로 찾는 모델 등록소가 없다 — 버퍼는 그대로이고 레지스트리 키만 옮긴다 (M3) |
| Diff 의 미니맵 | `diffMinimap` 설정(기본 끔)을 켜면 수정본 쪽에 미니맵 | 없음 — 설정도 걷는다 | 사용자 결정 (M6). MergeView 는 두 쪽이 한 스크롤 그릇을 나눠 써서 한쪽 미니맵이 따로 서지 않는다. FR-CMR-56·D-M9-5 와 맞춘다 |
| Diff 폭 전환 뒤 실행 취소 | 나란히 보기 ↔ 인라인 전환에도 수정본 모델의 기록이 남았다 | 전환하면 그 Diff 칸의 기록이 끊긴다 (내용·dirty 는 문서에 남는다) | 두 보기가 서로 다른 편집기(MergeView 와 unifiedMergeView 편집기)다. 기록은 칸의 것이다(FR-CMR-22) (M6) |
| Diff 의 sticky scroll | 두 쪽 편집기에 Monaco 기본 sticky scroll | 없음 | 사용자 결정 (M7). MergeView 의 두 편집기는 스스로 스크롤하지 않는다(바깥 그릇이 스크롤한다). 편집기 칸만 FR-CMR-80 을 따른다 |
| 비동기 적용 토큰 | 모델 판(alternativeVersionId)이 같으면 유효 — 고쳤다 되돌리면 유효 | 버퍼 판 번호가 같아야 유효 — 고쳤다 되돌려도 무효 | 판 번호는 실행 취소에도 오른다. 덮어쓸 위험 쪽으로 기울지 않는다 (M3) |

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
| 상한 (FR-CMR-102·104) | 동시 상한 초과 → close 4001 `limit` · REST 와 합쳐 센다 · LRU 가 통로를 고르지 않는다 · 본문 상한 초과 시 닫힘 |
| 유휴 (FR-CMR-102) | 양방향 프레임이 `LastUse` 를 갱신한다 · 프레임 없이 `IdleAfter` 가 지나면 `Sweep` 이 프로세스를 끝내고 WS 를 닫는다 |
| 게이트 (FR-CMR-100) | 다른 origin 거절 |
| 끼워 넣기 (FR-CMR-110~114) | 저장 → 루트 아래 통로에만 · git 변화 → 목록 계산(HEAD 이동·작업 트리·삭제·새 파일) · 상한 2000 · 브라우저 쪽으로는 아무것도 가지 않음 |
| 제거 (FR-CMR-105) | 제거된 경로가 404 |

### 4.3 e2e (Playwright)

- 기존 e2e 37개 파일이 FR-CMR-120 계층으로 옮겨진 뒤 통과한다 (§3.16 에 걸린 단언만 바뀐다).
- 새 시나리오: 여러 칸 동시 편집 · 칸별 실행 취소 · Diff 폭 전환 · 공백 무시 토글 · 미니맵과 스크롤바
  thumb 위치 일치(짧은 문서·긴 문서) · sticky scroll 표시와 클릭 · LSP hover/정의/참조/진단 · 브랜치 전환 뒤 진단 갱신.
- **LSP 기능 검사는 실제 gopls 로 한다** (M8 착수 중 결정 7). 작은 Go 픽스처 모듈을 열고 실제 통로(`/api/lsp/ws`)를
  지난다. CI(`e2e.yml`, ubuntu·windows)는 판을 고정한 gopls 를 설치한다. gopls 가 없으면 건너뛰지 않고 실패한다.
  가짜 언어 서버는 기능 검사에 쓰지 않는다 — 짜 둔 응답에 맞춘 검사는 실제 서버와 어긋나도 통과한다.
- 가짜는 **실패 주입에만** 쓴다: 상한 거절의 상태 패널 표시, 끊김 뒤 다시 연결, 요청 timeout, 프로세스 비정상 종료.
  Go 테스트(`fakeStarter`)로 충분한 것은 그쪽에서 재고, 브라우저 쪽 반응을 재야 하는 것만 e2e(`page.routeWebSocket`)에 둔다.
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
| **M4** | P | 여러 칸 편집 (FR-CMR-23 은 M8) |
| **M5** | R · M · D | ruler · 미니맵 포크 · dirty diff |
| **M6** | G | Diff 뷰 |
| **M7** | K | sticky scroll |
| **M8** | S · W · L (+ P 의 FR-CMR-23) | 통로 · 끼워 넣기 · 브라우저 LSP · 서버 문서 동기화 제거 · 그룹당 LSP 문서 하나 |
| **M9** | X | Monaco 제거 · 문서 개정 · 게이트 |
| — | **A 완료** | e2e 전체 통과, NFR 측정 통과 |
| **M10~** | B | §8 해소 후 기능별로 |

M2 를 엔진 교체보다 먼저 두는 이유: 테스트를 옮기는 일과 엔진을 바꾸는 일을 한 마일스톤에 섞으면
실패의 원인을 가를 수 없다.

### 7.1 브랜치와 중간 상태

편집기에 붙은 기능(D·M·R·K·L·문서 공유)은 편집기 엔진(M3)보다 뒤의 마일스톤에서 옮긴다. 그래서 M3~M8
사이에는 일부 기능과 그 e2e 가 동작하지 않는다.

- 단계 A 는 `codemirror-migration` 브랜치에서 진행한다. 마일스톤마다 그 브랜치에 커밋한다.
- `main` 은 단계 A 가 끝날 때까지 Monaco 상태로 동작한다. 단계 A 완료 조건(e2e 전체 통과·NFR 측정 통과)을
  채운 뒤 `main` 에 합친다.
- 마일스톤 사이에 실패하는 e2e 는 §7.2 표에 **실패 이유와 그것을 닫는 마일스톤**을 함께 적는다. 표에 없는
  실패는 회귀로 본다. 마일스톤을 커밋할 때 표를 갱신한다.

### 7.2 아직 옮기지 않은 기능 때문에 실패하는 e2e

측정: M3 마무리 작업 트리, 편집기 관련 e2e 42개 파일 — 534건 중 통과 485 · 실패 49 (2026-11-02). 표에 없는 실패는 없다.
M4 에서 `editor-multi-slot` 3건을 더했다 — 모두 통과(반복 3회). M4 는 앱 코드를 바꾸지 않았으므로 표는 그대로다.
M5 측정: 43개 파일(`editor-multi-slot` 포함) — 537건 중 통과 502 · 실패 35, 모두 아래 표의 M6·M8·M9 몫이다 (2026-11-02). `editor-scrollbar` 2건은 따로 통과(반복 3회).
M6 측정: 44개 파일(`codemirror-load` 포함) — 539건 중 통과 517 · 실패 22, 모두 아래 표의 M8·M9 몫이다 (2026-11-02). Diff 문서 공유 줄의 검사(`git-diff-doc` S1~S7 · `repo-diff-edit` D1·D3·E1·E2 · `git-subroot` F-3.1 두 건)와 `monaco-offline` TC-MVN-16 이 통과해 그 줄을 지웠다.
그 뒤 `git-diff-doc` S8(Diff 수정본 쪽 실제 키 입력)·`ux-batch10` "원본 쪽에 포커스가 있으면 찾기가 원본을 찾는다"(FR-UXB-49)를 더했다 — 모두 통과(반복 3회).
M7 측정: 45개 파일(`editor-sticky` 포함) — 544건 중 통과 522 · 실패 22, 모두 아래 표의 M8·M9 몫이다 (2026-11-02). `editor-sticky` 3건은 따로 통과(반복 3회).

| 스펙 · 테스트 | 실패 이유 | 닫는 마일스톤 |
|---|---|---|
| `editor-lsp-nav` 18건 · `slot-view-state` E-9.1 · `repo-tab` M4 · `ux-batch10` 호버 | LSP 연결이 아직 Monaco 편집기에 서 있다 (제안 띠 포함) | M8 |
| `editor-find-panel` "다른 Monaco 는 자기 위젯을 갖는다" | Monaco 고유 동작을 재는 검사다 — 편집기 칸에 Monaco 가 없다 (`edT.probe`) | M9 에서 폐기 또는 대체 |

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
| 페이지마다 프로세스 → 탭이 많으면 메모리 증가 | MEDIUM | 같은 페이지의 칸은 공유(FR-CMR-90) · 동시 상한 거절·유휴 정리 (FR-CMR-102) |
| 유휴 정리·끊김 뒤 다시 연결할 때 열린 문서를 다시 알려야 함 | MEDIUM | L1 단위 테스트로 재연결 뒤 `didOpen` 재전송을 먼저 잰다 |
| 실제 gopls e2e 의 시간 변동(콜드 기동·색인) | MEDIUM | 요청 timeout 을 기본 3000ms 보다 늘린다 · 픽스처를 작게 둔다 · CI 판 고정 |
| e2e 37개 이전 규모 | MEDIUM | M2 를 따로 둔다 |
| `lsp-client` 판 갱신으로 API 변경 | LOW | 판 고정 (FR-CMR-4) |

---

## 11. 설계 메모 (마일스톤별)

### 11.1 M3 — 편집기 코어·찾기

| 모듈 | 책임 | 비고 |
|---|---|---|
| `web/js/ui/cm-buffer.js` — `EdBuffer` | 문서 하나의 내용. 붙은 칸(sink)들 사이에 변경을 전달한다(FR-CMR-21). 디스크 재읽기(`replace`)는 칸마다 상태를 새로 세우되 선택을 문서 범위로 접어 남긴다(FR-ELR-31). 판 번호 `version` 은 변경마다 오른다. `onChange(fn)` 구독 | DOM 에 기대지 않는다 — sink 는 `{state, dispatch}` 다. Node 단위 테스트가 `EditorState` 로 잰다 |
| `web/js/ui/cm-setup.js` | 확장 구성(FR-CMR-10·11), Compartment(줄바꿈·글자 크기·읽기 전용·언어), CSS 변수 테마(FR-CMR-12), 언어 찾기·로드(FR-CMR-13), (줄, 열) ↔ offset 변환 | |
| `web/js/ui/cm-find.js` | 찾기 일치 계산 `edFindHits(doc, query, opts, max)` — 대소문자·정규식·단어 단위(`ED_FIND_WORD_SEPARATORS`)·캡처 | 순수 함수 |
| 문서 레지스트리 (`app-editor-doc.js`) | `d.model` → `d.buf`. dirty 는 `!d.buf.doc.eq(d.savedDoc)` (FR-CMR-16). 문서 토큰(`doc-token.js`)은 `version` 을 본다 | |
| `FileEditor` | `_editor` 필드에 `EditorView` 를 둔다(이름 유지) | |
| 줄 끝 (`EdBuffer.eol`·`text(doc)`) | CRLF·CR·LF 를 모두 줄 구분으로 나눈다 — 문서 줄에 `\r` 이 없다. 섞여 있으면 CRLF 가 절반을 넘을 때 CRLF 다(Monaco 규칙). 저장은 `buf.text(sentDoc)` 로 그 줄 끝을 되살린다 | 이전(M3 WIP): 줄에 `\r` 이 남아 줄 끝에 친 글자가 `\r` 뒤에 붙었고, 새 줄은 LF 로 섞였다 |
| 전역 키 게이트 (`input-binding.js` 의 `inText`) | contenteditable 도 글자를 치는 자리다 | Monaco 입력 영역은 textarea 였다. CodeMirror 의 `.cm-content` 가 빠지면 `Mod+Z` 등이 전역 단축키·브라우저 차단 경로로 가 `preventDefault` 되고, CodeMirror 는 막힌 키를 무시한다 |

M3 에서 **아직 옮기지 않는 것** — dirty diff(M5)·미니맵(M5)·ruler(M5)·Diff 뷰의 문서 공유(M6)·sticky(M7)·LSP(M8).
그 자리는 엔진이 없을 때처럼 조용히 건너뛴다(`if (this._dd)` 같은 기존 가드). 실패하는 e2e 는 §7.2 에 적는다.

단위 테스트는 커밋된 벤더 묶음(`web/vendor/codemirror/cm.js.gz`)을 풀어 Node 에서 `import` 한다 — CI 에서 따로
설치하지 않고, 배포되는 바이트를 그대로 잰다.

### 11.2 M4 — 같은 파일 여러 칸

| 요구 | 구현 자리 | 검증 |
|---|---|---|
| FR-CMR-20·21 | `EdBuffer.fromSink`·`attach` (M3 에 들어갔다) | `cm-buffer.test.mjs` · `editor-multi-slot` "두 칸에서 번갈아 쳐도" · `slot-view-state` TC-SVS-30~32 |
| FR-CMR-22 | 전달은 `addToHistory.of(false)` — 칸의 `history()` 에는 그 칸의 입력만 들어간다 | `cm-buffer.test.mjs` · `editor-multi-slot` "실행 취소는 칸마다 따로다" (실제 `Ctrl+Z`) |
| FR-CMR-24 | `EdBuffer.replace` — 모든 칸을 한 번에 바꾸고 기록을 끊는다 | `cm-buffer.test.mjs` FR-CMR-24 · FR-ELR-31 |
| NFR-CMR-4 | 전달이 같은 호출 안에서 끝난다 — 받는 칸의 DOM 도 그 자리에서 고쳐진다 | `editor-multi-slot` NFR-CMR-4: 칸 셋, 입력 12회 모두 다음 프레임 전에 섰다. 최대 2.1~2.4ms (5회, 2026-11-02, 로컬 Chromium) |
| FR-CMR-23 | — | M8 로 옮겼다. 사용자 정의 `Workspace` 는 `lsp-client` 의 것이고 M8 전에는 붙일 곳이 없다 |

e2e 의 브라우저는 Windows 로 보인다(`navigator.platform` = `Win32`). CodeMirror 의 `Mod` 가 `Ctrl` 이므로
스펙의 실행 취소 키는 `Control+z` 다.

### 11.3 M5 — 스크롤바 · overview ruler · dirty diff · 미니맵

| 모듈 | 책임 | 비고 |
|---|---|---|
| `web/js/ui/cm-scrollbar.js` | `edScrollThumb(geo)` (순수: thumb 의 top·height) · `edRulerY(top, contentH, trackH)` (순수) · `edCmScrollbar()` 확장 — track·thumb·ruler 를 `view.dom` 오른쪽에 겹쳐 그린다 (FR-CMR-70·71·73·74) | ruler 의 출처는 Facet `edRulerSource` 다. 출처 하나는 `(state) => [{from, to, lane:'left'\|'right', color}]` 이다. 그린 항목은 `edCmRulerItems(view)` 로 읽는다 (e2e 어댑터) |
| `web/js/ui/cm-find.js` | 찾기 일치를 ruler(오른쪽)·미니맵에 싣는 출처 | 색: 일치 `--accent`, 현재 일치 `--text-bright` (Monaco 테마의 매핑을 옮겼다) |
| `web/js/ui/file-editor-diff.js` | `EdDirtyDiff` 가 모델 대신 버퍼(`EdBuffer`)에 붙는다. 표시는 칸마다 StateField(`edDdField`)에 둔 `RangeSet<GutterMarker>` 이고 편집에 맞춰 `map` 된다 (FR-CMR-40). gutter 를 누르면 그 칸에만 block widget 팝업이 선다 (FR-CMR-41). 되돌리기는 그 칸의 트랜잭션이라 실행 취소가 듣는다. ruler(왼쪽)·미니맵 gutter 의 출처다 (FR-CMR-42) | 계산(`edDiffLines`)·스테이지·좌표 사상은 그대로다 |
| `scripts/codemirror/minimap/` | `@replit/codemirror-minimap` 0.5.2 의 `dist/index.js` 포크 (FR-CMR-60). 고친 자리: ① 뷰포트 표시(overlay)의 top·height 는 설정의 `thumb(view)` 가 준다 — 스크롤바와 같은 함수다 (FR-CMR-61) ② 설정 `marks(state)` 로 줄 위에 색을 찍는 층 (FR-CMR-62) ③ 그린 줄 표식을 읽는 `minimapDrawn(view)` | 포크의 README 에 고친 자리를 목록으로 적는다 (§9 리스크) |
| `web/js/ui/cm-setup.js` | 미니맵 Compartment. `editorMinimap` 설정이 켜고 끈다. 생성과 갱신은 한 함수(`edCmMinimap(enabled)`)가 만든다 (FR-CMR-63) | Diff 뷰에는 미니맵이 없다 (D-M9-5) |
| `e2e/editor.ts` | `scrollThumb`·`minimap`·`minimapSlider`·`overviewRuler` 선택자, `option('minimap…')`·`minimapLeft/Width`·`marks().ruler/minimap`·`lineMarks` 의 CodeMirror 갈래 | |

줄 높이는 정수 px 다 — `round(글자 크기 × 1.5)` (`ED_LINE_HEIGHT_RATIO`, Monaco 와 같다). M3 의 `line-height:1.5` 는
글자 크기 13px 에서 19.5px 가 되어 문서 높이가 소수였고, 문서 끝에서 미니맵(sticky)이 thumb 보다 반 픽셀 위에 섰다.

ruler·미니맵 표식이 "있는가" 를 e2e 가 재는 길: ruler 는 그린 항목 목록, 미니맵은 포크가 마지막으로 그린 표식 목록이다.
표식의 색 값은 묻지 않는다 (FR-EDD-23 이 값을 박지 않는다).

### 11.4 M6 — Git Diff 뷰

| 모듈 | 책임 | 비고 |
|---|---|---|
| `web/js/git/diff-cm.js` | 순수: `gitDiffIgnoreWs(a, b)` — 줄마다 앞뒤 공백을 걷은 줄 diff(`edDiffLines`)를 원문 offset 의 `Change` 로 (FR-CMR-53) · `gitDiffRulerItems(chunks, side)` — 조각을 ruler 항목으로. CodeMirror: hunk 툴바 tooltip 필드 · 커서 관측 | 상한(`ED_DD_MAX_LINES`)을 넘으면 기본 `diff` 로 돌아간다 |
| `GitDiffView` (`diff-view.js`) | 폭이 `renderSideBySideInlineBreakpoint`(900px) 이상이면 `MergeView`, 미만이면 `unifiedMergeView` 편집기 하나(FR-CMR-50·51). 폭이 문턱을 넘으면 다시 세우고 위쪽 줄을 지킨다. 원본 쪽은 늘 읽기 전용(FR-CMR-54). 변경 없는 구간 접기는 `collapseUnchanged`(FR-CMR-52). 오른쪽 밖에 Diff 전체의 ruler(`.git-diff-ruler`, FR-CMR-57) | 핸들: `_cm = {kind:'split'\|'unified', a?, b, scroller}`. `_orig`·`_mod` 는 쪽의 표지다 (`lspPathOf`) |
| `diff-view-doc.js` | 편집 가능한 축이면 수정본 편집기가 그 문서 버퍼의 칸이다 (`updateListener` → `EdBuffer.fromSink`, FR-CMR-54) — `GIT_DIFF_SHARES_DOC=true` 로 되돌린다 | 편집기 칸과 같은 실행 취소 규약(칸마다 따로) |
| `diff-view-parity.js` | 설정 반영(줄바꿈·글자 크기 Compartment) · 찾기 패널은 포커스 쪽 편집기의 `edFindEngineCm` · `lspPathOf` | 미니맵 갈래를 걷는다 |
| `panel-hunks.js` | 툴바는 수정본 편집기의 tooltip 이고 자리는 커서 줄이다(FR-CMR-55). 편집기에 닿는 자리는 `GitDiffView` 가 넘기는 커서 관측(`{sel, onCursor, onFocus, onBlur, place, unplace}`) 하나다 | hunk **좌표**는 지금처럼 서버의 `hunks` 다 — 패치는 서버가 만든다(D6). `getChunks()` 는 그리기에만 쓴다 |
| `e2e/editor.ts` | Diff 갈래 — `diffSide` 는 `{_view}` 핸들, `counts()` 는 살아 있는 Diff 편집기·Diff 뷰 수 | |
| e2e 추가 | `git-diff-doc` S8 — 수정본 쪽에 키보드로 친 글자가 편집기 탭의 문서에 닿고 `Mod+S` 로 저장된다 (FR-CMR-54) · `ux-batch10` — 나란히 보기에서 원본 쪽에 포커스가 있으면 찾기 패널이 원본을 찾고 원본은 고쳐지지 않는다 (FR-UXB-49) | 앞의 검사들은 편집기에 바로 dispatch 해 contenteditable 의 키 경로를 지나지 않았다 |

### 11.5 M7 — sticky scroll

| 모듈 | 책임 | 비고 |
|---|---|---|
| `web/js/ui/cm-sticky.js` | 순수: `edStickyLines(state, line, max)` — 줄 번호 `line` 을 감싸는 범위의 첫 줄 번호들(바깥 먼저, 최대 `max`, FR-CMR-80·81). CodeMirror: `edCmSticky()` 확장 — `view.dom` 위쪽에 겹친 `.cm-sticky` 에 줄을 그린다(FR-CMR-84). 줄 `n` 을 누르면 선택을 `n` 의 처음으로 두고 `scrollIntoView(줄 처음, {y:'start', yMargin: k × 줄 높이})` — `k` 는 `edStickyLines(state, n, max)` 의 길이다 (FR-CMR-82) | 최대 줄 수 `ED_STICKY_MAX`(5). 구문 색은 `highlightTree` + `highlightingFor(state, tags)` — 편집기 테마와 같은 클래스다. 오른쪽 끝은 미니맵 앞(없으면 스크롤 영역 끝)이다 |
| `web/js/ui/cm-setup.js` | 편집기 칸에만 `edCmSticky()` 를 넣는다 (`o.diff` 면 빠진다) | |
| `scripts/codemirror/entry.js` | `highlightTree` 를 내보낸다 | 묶음을 다시 만든다 (`VENDOR_VERSIONS.md`) |
| `e2e/editor.ts` | 선택자 `sticky`·`stickyLine`(`data-line` 이 줄 번호), `stickyLines(h)` — 그려진 줄 번호 | |

맨 위 줄은 `lineBlockAtHeight(scrollTop − documentPadding.top)` 의 줄이다. 고정된 줄이 덮는 아래 줄들은 다시 계산하지 않는다
(FR-CMR-83 — Monaco 와 달리 범위가 끝날 때 밀어 올리는 효과도 없다).

### 11.6 M8 — LSP (S · W · L + FR-CMR-23)

착수 중 결정 (2026-11-02, 사용자):

| # | 결정 | 반영 |
|---|---|---|
| 1 | 통로는 `accessGate`·`requestGate` 를 지난다. 인증은 없다 | FR-CMR-100 |
| 2 | 프로세스는 페이지마다 (루트, 서버)당 하나. 같은 페이지의 칸은 공유한다 | FR-CMR-90 · §3.16 |
| 3 | 상한에 걸리면 새 통로를 거절한다. LRU 는 통로를 정지하지 않는다 | FR-CMR-102 · §3.16 |
| 4 | 양방향 프레임마다 `LastUse` 갱신. 유휴 정리 뒤에는 다음에 쓸 때 다시 연결한다 | FR-CMR-102 |
| 5 | 문서 동기화는 늘 켠다. 진단 켜기/끄기는 알림 처리기가 본다 | FR-CMR-92 |
| 6 | 정의·참조는 라이브러리 명령·패널. `_lspList`·뒤로 가기는 걷는다 | FR-CMR-93 · §3.16 |
| 7 | LSP 기능 e2e 는 실제 gopls. 가짜는 실패 주입에만 | §4.3 |
| 8 | 호버 provider 1회·needText 생략·결과 목록·뒤로 가기 e2e 는 지우거나 바꾼다 | §3.16 |

단위와 순서 (L3 → S → L1 → L2 → T → W → R):

| 단위 | 내용 |
|---|---|
| L3 | `lspOfferFor` 가드를 CodeMirror 뷰 기준으로 — 설치 띠 복구 |
| S | `/api/lsp/ws`: 게이트, Starter 로 기동, `Content-Length` 프레이밍, 별도 읽기 한도(FR-CMR-104), close code · 상한 공유와 거절 · 프레임 touch · `Sweep` |
| L1 | 페이지 단위 연결 등록소 · WS `Transport` · `EdBuffer` 기반 사용자 정의 `Workspace`(그룹당 문서 하나, FR-CMR-23) · `displayFile` 준비 대기 · URI ↔ 경로(Go `platform.Paths` 와 같은 테스트 벡터) · timeout · hover(`sanitizeHTML` = DOMPurify) · 정의·참조 단축키 → 라이브러리 명령 |
| L2 | 진단: 버퍼에 보관, 그룹의 모든 칸에 그림, `lspDiagOn` 은 처리기에서 |
| T | e2e: 실제 gopls 픽스처 · CI gopls 설치 · 실패 주입 · 어댑터 CodeMirror 갈래(`e2e/editor.ts`) · `app.testing` 이름과 단위 테스트 정리 · `editor-lsp.spec.ts` 를 e2e 목록에 더한다 |
| W | 저장 시 끼워 넣기 · `git_changed` 에서 name-status 계산 · `LSP_WATCH_MAX` (FR-CMR-110~114) |
| R | REST 4종·서버 문서 동기화·hub `lsp_diagnostics` 제거 (FR-CMR-105). **W 뒤에 한다** — 브랜치 전환 뒤 열린 문서를 맞추던 `ResyncRepo` 의 몫을 W 가 넘겨받는다 |

S 설계:

| 자리 | 내용 |
|---|---|
| `domain/lsp` `Service.OpenTunnel(root, descID) (Tunnel, error)` | 서술자를 `ext.Service.ResolveID` 로 풀어 실행 파일을 찾고 `Starter` 로 띄운다. 통로 수가 이미 상한이면 프로세스를 띄우지 않고 `ErrLimit`. 띄운 뒤 REST 세션 + 통로가 상한을 넘으면 REST 세션만 LRU 로 정지한다 |
| `Tunnel` (인터페이스) | `Send(body)` — `Content-Length` 머리를 붙여 stdin 에 쓴다 · `Recv()` — stdout 의 프레임 하나에서 머리를 뗀 본문 · `Close()` — 프로세스를 끝내고 등록에서 뺀다(여러 번 불러도 한 번) · `LastUse()`. `Send`·`Recv` 가 `LastUse` 를 갱신한다 |
| `Service.session` (REST) | 통로 수가 상한이면 새 REST 세션을 `ErrLimit` 로 거절한다 |
| `Service.Sweep`·`Shutdown` | 통로도 정리한다 |
| `httpapi` `GET /api/lsp/ws` | `root` 는 `fsRoot` 가드, `server` 가 비면 400 — 둘 다 업그레이드 전에 HTTP 로 답한다. 업그레이드 뒤 읽기 한도는 `editorlimit.BodyMaxBytes(MaxTextBytes)` 다(넘으면 gorilla 가 1009 로 닫는다) |
| close code | `LSP_WS_CLOSE_LIMIT` 4001 `limit` (상한) · 4002 (기동 실패 — reason 은 사유, UTF-8 로 123바이트까지) · 4003 `ended` (프로세스 종료·유휴 정리) |

- `lsp-client` 는 `initialize` 를 브라우저가 보낸다. Go 핸드셰이크는 통로에서 쓰지 않고, `didChangeWatchedFiles`
  능력은 브라우저의 `clientCapabilities` 에 넣는다.
- 기본 `Workspace` 는 같은 파일을 두 번 열면 throw 한다. 사용자 정의 `Workspace` 가 그룹의 칸 수를 센다.

## 10. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-02 | 초안 — 인터뷰 결정·PoC 결과 반영 |
| 2026-11-02 | FR-CMR-1·4·60 개정, FR-CMR-1a·5a 추가 — 묶음 입력이 `web/vendor` 에 있으면 바이너리와 정적 서빙에 실린다 (M1 착수 중 발견) |
| 2026-11-02 | FR-CMR-121 개정 — 앱에 훅을 새로 두지 않고 어댑터가 엔진 핸들을 읽는다. 엔진을 바꿀 때 고칠 자리를 어댑터 하나로 둔다 (M2 착수 중 결정) |
| 2026-11-02 | FR-CMR-56 개정 — Diff 미니맵과 `diffMinimap` 설정을 걷는다 (M6 착수 중 사용자 결정) |
| 2026-11-02 | FR-CMR-74 추가 — 세로 스크롤바를 직접 그린다 (M5 착수 중 사용자 결정) |
| 2026-11-02 | FR-CMR-23 을 M8 로 옮겼다 — 사용자 정의 `Workspace` 는 `lsp-client` 에 붙는다. M4 완료: §11.2 (M4 착수 중 결정) |
| 2026-11-02 | M6 완료 — §7.2 에서 Diff 문서 공유 줄과 TC-MVN-16 을 지웠다. e2e 2건 추가 (§11.4) |
| 2026-11-02 | FR-CMR-80·81·82·83 구체화, FR-CMR-84 추가 — sticky 는 편집기 칸만, Diff 에는 없다 (M7 착수 중 사용자 결정). FR-CMR-82 는 누른 줄이 고정된 줄에 덮이지 않도록 고쳤다. §11.5 |
| 2026-11-02 | M7 완료 — §7.2 에 측정을 적었다 |
| 2026-11-02 | FR-CMR-90·92·93·100·102 개정, §3.16·§4.2·§4.3·§9 갱신, §11.6 추가 — M8 착수 중 사용자 결정 8건 |
