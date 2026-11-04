# SRS: 편집기 링크 이동 · Markdown 언어 서버 교체 · 스크롤바 표식 · LSP 대화상자 테마 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 수동 검증 V-ELS-11·12 (실서버), e2e 스크린 V-ELS-10
>
> 2026-11-03 사용자 승인 — 검토 항목(ruler 칸 배치 · 색 · LSP 없는 편집기의 URL 클릭) 원안대로.

- 근거: 사용자 보고(2026-11-03) 네 건 · 사용자 인터뷰(같은 날) · stdio 직접 탐침(§2.2).
- 대체 조항: `CODEMIRROR_MIGRATION_SRS.md` §3.15 의 **FR-CMR-149**(수정키+클릭으로 정의 이동·링크 열기)를 이 문서가 연다.
  `DOCLANG_LSP_SRS.md`(archive) 의 markdown 서버 선택을 이 문서가 바꾼다.
- 요구사항 ID 접두어: `FR-ELS-` · `NFR-ELS-` · `D-ELS-`.

---

## 1. 개요

### 1.1 목적

CodeMirror 로 옮긴 뒤 편집기에서 다음 네 가지가 동작하지 않는다.

| # | 보고 | 원인 (§2) |
|---|---|---|
| 1 | md LSP 가 동작하지 않는다 | 동봉 서버가 표준이 아닌 클라이언트 요청을 요구한다 |
| 2 | 편집기의 링크, md 의 링크를 클릭해도 이동하지 않는다 | URL 열기가 없다. md 는 #1 때문에 실패한다. html 은 링크를 `documentLink` 로만 알리는데 라이브러리가 그것을 쓰지 않는다 |
| 3 | 스크롤바와 미니맵에 선택 영역과 같은 낱말이 표시되지 않는다 | 표식 출처에 없다 (FR-CMR-62·72) |
| 4 | LSP 오류 창이 테마와 맞지 않는다 | CodeMirror 대화상자·패널 클래스에 스타일이 없다 |
| 5 | 미니맵이 스크롤 위치와 맞지 않는다. 슬라이더가 보이지 않는다 | §3.5 |

### 1.2 범위

**포함**

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **M** | markdown 서버를 `marksman` 으로 바꾼다. 압축하지 않은 단일 실행 파일을 받는 조달을 더한다 | MEDIUM |
| **L** | 수정키+클릭으로 URL 열기 · 문서 링크(`documentLink`) 이동 · 정의 이동. 수정키를 누른 채 올리면 밑줄을 긋는다 | MEDIUM |
| **R** | 스크롤바 ruler 와 미니맵에 선택 영역 · 같은 낱말 · LSP 진단 · 커서 위치를 표시한다 | LOW |
| **T** | CodeMirror 대화상자 · 패널 · 버튼 · 입력 칸에 앱 테마를 입힌다 | LOW |
| **N** | 미니맵이 문서 전체를 스크롤 높이와 같은 비율로 그린다 · 슬라이더 색을 스크롤바 thumb 와 맞춘다 | MEDIUM |

**제외 (비목표)**

- `vscode-markdown-language-server` 의 `markdown/*` 요청을 구현하는 일 (사용자 결정, §2.3).
- LSP 오류를 앱 토스트로 옮기거나 문구를 번역하는 일 (사용자 결정 — 테마만 입힌다).
- 정의 이동 결과가 여럿일 때 목록 표시, 뒤로 가기 (`CODEMIRROR_MIGRATION_SRS` §3.16 의 결정을 유지).
- 정의가 있는지 서버에 물어서 밑줄을 긋는 일 (§3.2 FR-ELS-23).
- 문서 렌더 뷰(`doc-render.js`)의 링크. 이미 동작한다.

### 1.3 용어

| 용어 | 뜻 |
|---|---|
| 수정키 | macOS 는 `Cmd`, 그 밖은 `Ctrl`. 기존 `IS_MAC ? metaKey : ctrlKey` 판정과 같다 |
| ruler | 스크롤바 track 위에 겹쳐 그리는 표식 canvas (`cm-scrollbar.js`, FR-CMR-70) |
| 같은 낱말 | `highlightSelectionMatches` 가 편집기 안에서 칠하는 일치 |
| 문서 링크 | LSP `textDocument/documentLink` 의 결과 |

---

## 2. 현재 상태와 근거

### 2.1 서버가 클라이언트에 보내는 요청

`edLspServerReply`(`web/js/ui/cm-lsp.js`)는 표준 요청 네 가지(`workspace/configuration` · `client/registerCapability`·
`unregisterCapability` · `window/workDoneProgress/create` · `workspace/workspaceFolders`)에만 답한다. 나머지는 −32601 이다.

동봉 서버 9종 가운데 클라이언트 구현을 **반드시** 요구하는 것은 markdown 하나다 (설치본 `protocol.js`).

| 서버 | 비표준 서버→클라이언트 요청 | 기본 설정에서 나가는가 |
|---|---|---|
| markdown | `markdown/parse` · `markdown/fs/readFile`·`readDirectory`·`stat` · `markdown/fs/watcher/*` · `markdown/findMarkdownFilesInWorkspace` | **나간다** — 파서가 서버 안에 없다 |
| html | `fs/stat` · `fs/readDir` · `html/customDataContent` | 나가지 않는다. `handledSchemas` 기본값이 `['file']` 이라 서버가 디스크를 직접 읽고, `dataPaths` 가 없으면 custom data 를 묻지 않는다 |
| css | `fs/content` · `fs/stat` · `fs/readDir` | 나가지 않는다 (같은 이유) |
| json | `vscode/content` | http 스키마를 받을 때만 |

### 2.2 탐침 결과 (stdio 직접 연결, 2026-11-03)

| 서버 | 요청 | 결과 |
|---|---|---|
| vscode-markdown | definition · documentLink · hover | `markdown/parse` 를 거절당한 뒤 −32603 (`tokens is not iterable`). 화면의 "Find definition failed" 가 이것이다 |
| marksman 2026-02-08 (git 저장소 루트) | definition `[b](b.md)` | `b.md` 의 1행 |
| 〃 | definition `[h](#top)` | 같은 파일의 헤딩 |
| 〃 | hover · completion | 대상 헤딩 내용 · 파일 이름 완성 |
| 〃 | documentLink | −32601 (지원하지 않는다) |
| marksman (`.git`·`.marksman.toml` 없는 루트) | definition `[b](b.md)` | null — "Workspace folder is bogus" 로 **단일 파일 모드**가 된다 |
| html | definition `href="b.html"` | `[]` |
| 〃 | documentLink | `b.html` · `https://example.com` 두 링크 |
| 〃 | 스크립트 안 함수 definition · hover · completion | 정상 |

결론: **html 은 md 와 같은 오류가 없다.** 다만 html 의 `href` 는 정의가 아니라 문서 링크로만 오고, `@codemirror/lsp-client`
6.x 는 `documentLink` 를 요청하지 않는다. 그래서 html 링크 클릭도 지금은 아무 일도 하지 않는다. 묶음 L 이 함께 고친다.

### 2.3 markdown 서버 결정

| 안 | 판단 |
|---|---|
| **marksman 으로 교체** | 채택 (사용자 결정). 표준 LSP 만 쓴다. 다른 서버와 같은 경로다 |
| 브라우저에서 `markdown/*` 구현 | 기각. 이 서버 하나만을 위한 비표준 코드가 클라이언트에 남는다 |
| Go 통로에서 `fs/*` + 브라우저에서 `parse` | 기각. 구현이 두 곳으로 나뉜다 |

marksman 배포본은 **압축하지 않은 단일 실행 파일**이다. 지금 `archive` 조달은 tar.gz·zip 만 푼다 (`fetch.go` `extract`).

| 타깃 | 자산 | sha256 |
|---|---|---|
| darwin-arm64 · darwin-x64 | `marksman-macos` (universal) | `6a801c17b5ac0dba69787c5282b3b3bd416e66c96253fae098d311c6bbd1833b` |
| linux-x64 | `marksman-linux-x64` | `be5098e8213219269c47fc0d916a66fa31ce0602ec967475c722260aabf26087` |
| linux-arm64 | `marksman-linux-arm64` | `db8e124527f7f8048e3e6c91821b9c52ef173d92c01e47d221bf1337afd962fb` |
| win32-x64 | `marksman.exe` | `a6d05beb08ebe41b0a9f09c98a438540421436fa5531424c22e0bb1d22529705` |
| win32-arm64 | 없음 | — |

URL: `https://github.com/artempyanykh/marksman/releases/download/2026-02-08/<자산>`. 실행 인자는 `server` 다 (`--stdio` 는 거절한다).

---

## 3. 요구사항

### 3.1 묶음 M — markdown 서버 교체

**FR-ELS-1** `internal/webserver/domain/ext/builtin/marksman.json` 팩을 더한다. `kind:"server"` · `version:"2026-02-08"` ·
`source.kind:"archive"` · 타깃은 §2.3 의 표다. 서버 하나: `id:"marksman"` · `langs:["markdown"]` · `exts:[".md",".markdown"]` ·
`exe:"marksman"` · `args:["server"]`.

**FR-ELS-2** `vscode-langservers.json` 에서 `markdown` 서버 항목을 지운다. 팩의 판과 패키지는 그대로다.

**FR-ELS-3** `Target` 에 `raw`(bool) 를 더한다. `raw:true` 이면 받은 파일을 풀지 않고 `bin` 의 자리에 그대로 놓는다.
- 순서는 기존 규칙과 같다: 받고 → sha256 을 대조하고 → 옆 자리(`dest + ".new"`)에 놓고 → 통째로 갈아 끼운다 (FR-EXT-15·24).
- POSIX 에서 권한은 `0755` 다.
- `raw:true` 인데 `bin` 이 비었거나 격리 칸을 벗어나면 매니페스트 검증에서 거절한다. `strip` 이 0 이 아니어도 거절한다.

**FR-ELS-4** win32-arm64 처럼 타깃이 없는 플랫폼에서는 기존 문구("이 플랫폼의 조달처가 선언에 없습니다")를 그대로 쓴다.
PATH 에 `marksman` 이 있으면 기존 탐색 순서(설정 → PATH → 격리 칸, FR-EXT-27)로 그것을 쓴다.

**FR-ELS-5** LSP 루트에 `.git` 이나 `.marksman.toml` 이 없으면 marksman 은 단일 파일 모드다. 이것은 서버의 성질이며 이 문서는 바꾸지 않는다
(§6 제약 C-1).

### 3.2 묶음 L — 링크 이동

**FR-ELS-10** 편집기 본문에서 수정키+왼쪽 클릭을 하면 아래 순서로 **처음 맞는 하나만** 실행한다. 수정키 없는 클릭과 다른 버튼은 바꾸지 않는다.

| 순서 | 조건 | 동작 |
|---|---|---|
| 1 | 클릭한 자리가 URL 글자 범위 안 (FR-ELS-11) | 그 URL 을 새 브라우저 탭으로 연다 (`window.open(url, '_blank', 'noopener')`) |
| 2 | LSP 가 붙어 있고 서버가 `documentLinkProvider` 를 알렸고, 클릭한 자리를 포함하는 문서 링크의 `target` 이 `file:` | 그 파일을 편집기로 연다 (`edOpenFile`). `target` 의 `#L<줄>` 조각이 있으면 그 줄로 간다 |
| 3 | LSP 가 붙어 있다 | 기존 정의 이동 (`lspClickDef`, FR-LSP-60) |
| 4 | 그 밖 | 아무 일도 하지 않는다 (FR-ELS-15) |

**FR-ELS-11** URL 판정은 앱에 이미 있는 linkify-it(`markdownit().linkify`)의 **스킴 있는 링크**(`http:` · `https:`)만 쓴다. 맨 도메인(fuzzy)은
잡지 않는다 (`README.md` 를 링크로 잡는 문제, D-BDL-2). 판정 범위는 클릭한 줄 하나다.

**FR-ELS-12** 순서 1 은 **동기**로 판정하고 연다. `await` 뒤의 `window.open` 은 브라우저가 조용히 막는다 (FR-VUO-8 과 같은 이유).
그래서 문서 링크의 `target` 이 `http(s):` 인 경우는 순서 2 에서 열지 않는다 — 같은 글자가 순서 1 에서 이미 잡힌다.

**FR-ELS-13** 문서 링크 요청은 클릭할 때 한 번 보낸다. 미리 받아 두지 않는다. 요청이 실패하거나 시간을 넘기면 순서 3 으로 넘어간다.
`file:` 경로 풀이는 `edLspPath` 를 쓴다.

**FR-ELS-14** 수정키+클릭이 순서 1·2·3 중 하나를 실행하면 그 mousedown 의 기본 동작을 막는다 (지금 `_lspClickExt` 와 같다).

**FR-ELS-15** 수정키+클릭은 커서를 더하지 않는다 — 순서 1·2·3 이 할 일이 없으면 아무것도 하지 않는다 (2026-11-03 사용자 결정 — 옛 엔진의
`multiCursorModifier:'alt'` 와 같다). 커서 추가는 **Alt+클릭**이다.

**FR-ELS-16** 사각 선택은 **Shift+Alt+드래그**다 (옛 엔진과 같다). Alt 를 누를 때 십자 커서로 바꾸지 않는다.

**FR-ELS-20** 수정키를 누른 채 포인터를 올리면 그 자리의 **URL 범위**에 밑줄을 긋고 포인터를 손 모양으로 바꾼다.

**FR-ELS-21** LSP 가 붙은 편집기에서는 URL 이 아닌 자리에서 수정키를 누른 채 올리면 그 자리의 **낱말**(`state.wordAt`)에 같은 밑줄을 긋는다.

**FR-ELS-22** 수정키를 떼거나, 포인터가 편집기를 벗어나거나, 창이 포커스를 잃으면 밑줄을 지운다.

**FR-ELS-23** 밑줄을 그을 때 서버에 묻지 않는다. 그래서 정의가 없는 낱말에도 밑줄이 생길 수 있다 (비목표, §1.2).

**FR-ELS-24** 위 동작은 LSP 없는 편집기에도 있다 (순서 1·4, FR-ELS-20). Git Diff 뷰의 양쪽에는 넣지 않는다.

### 3.3 묶음 R — 스크롤바·미니맵 표식

**FR-ELS-30** ruler(`edRulerSource`)와 미니맵(`edMinimapSource`)에 출처 넷을 더한다. 기존 출처(찾기 일치 · dirty diff · Git Diff)는 그대로다.

| 출처 | 대상 | ruler 칸 | 미니맵 | 색 (CSS 변수) |
|---|---|---|---|---|
| 선택 영역 | 비어 있지 않은 모든 선택 범위 (다중 선택 포함) | 오른쪽 | `mark` | `--text` |
| 같은 낱말 | FR-ELS-31 의 일치. 선택 범위 자신은 뺀다 | 오른쪽 | `mark` | `--text-hint` |
| LSP 진단 | `error` · `warning` 만. `info` · `hint` 는 뺀다 | 왼쪽 | 더하지 않는다 — 미니맵 포크의 진단 층(`DiagnosticState`)이 이미 그린다 | error `--danger` · warning `--term-yellow` |
| 커서 위치 | 주 선택의 `head` 가 있는 줄 | 전체 폭 (`lane:'full'`) | 표시하지 않는다 (미니맵에는 뷰포트 표시가 있다) | `--text-bright` |

**FR-ELS-31** 같은 낱말의 판정은 편집기 강조(`highlightSelectionMatches` 기본값)와 같다: 선택이 **하나**이고 비어 있지 않으며 길이가
1~200 자일 때, 문서 **전체**에서 같은 글자열을 찾는다. 개수는 `ED_RULER_MATCH_MAX`(1000) 에서 자른다. 편집기 본문의 강조 범위(보이는 곳만)는
바꾸지 않는다.

**FR-ELS-32** 그리는 순서(뒤가 위): 같은 낱말 → 선택 영역 → 찾기 일치 → 진단 → 커서. 미니맵은 줄마다 한 색이므로 같은 순서로 뒤의 색이 이긴다.

**FR-ELS-33** `lane` 에 `'full'` 을 더한다. `full` 은 track 전체 폭에 높이 `ED_RULER_CURSOR_H`(2px) 로 그린다.

**FR-ELS-34** 진단 출처는 그 칸의 lint 상태(`@codemirror/lint` 의 진단)를 읽는다. 진단 표시가 꺼져 있으면(`lspDiagOn` 거짓) 칸에 진단이 없으므로 표식도 없다.

**FR-ELS-35** 다시 그리는 계기에 **선택 변경**을 더한다. 한 프레임에 한 번만 그리는 규칙(FR-CMR-73)은 그대로다.

**FR-ELS-36** Git Diff 뷰의 양쪽에는 더하지 않는다 (FR-CMR-56).

### 3.4 묶음 T — 대화상자 테마

**FR-ELS-40** `edCmTheme` 에 아래 클래스의 색을 앱 토큰으로 정한다. 모양(둥근 모서리 · 안쪽 여백)은 앱 버튼·입력 칸과 맞춘다.

| 클래스 | 배경 | 글자 | 테두리 |
|---|---|---|---|
| `.cm-panels` · `.cm-panel` | `--bg-alt` | `--text` | `--border` (편집기 쪽 한 변) |
| `.cm-dialog` · `.cm-lsp-message` | 〃 | 〃 | 〃 |
| `.cm-lsp-message-error` | 〃 | `--danger-text` | 〃 |
| `.cm-button` | 투명 | `--text-muted` | `--border`. hover 는 `.ui-btn` 과 같다 (`--accent-active` · `--accent-text` · `--accent-border`) |
| `.cm-textfield` | `--bg` | `--text` | `--border`. focus 는 `--focus-ring` |
| `.cm-dialog-close` (닫기 ×) | 투명 | `--text-muted` | 없음 |
| `.cm-lsp-reference-panel` 의 목록 · 선택 항목 | `--bg-alt` · `--accent-subtle` | `--text` | — |

**FR-ELS-41** 색 값을 하드코딩하지 않는다. 모두 `var(--…)` 다 (FR-CMR-12, `check-hardcoded-color`).

### 3.4a 묶음 T — hover 미리보기 크기 (사용자 보고 #6)

**FR-ELS-45** hover 미리보기(`.cm-tooltip-hover`)의 크기는 `ED_HOVER_MAX_W`(`min(600px, 70vw)`) ×
`ED_HOVER_MAX_H`(`min(320px, 45vh)`)를 넘지 않는다. 넘치는 내용은 미리보기 안에서 스크롤한다. md 링크의 대상 문서나 설명이
긴 클래스에 올려도 편집기 화면을 덮지 않는다 (2026-11-03 사용자 보고).

**FR-ELS-46** hover 미리보기 안의 스크롤바는 앱 킷 스크롤바(`style-kit.css` `.ui-scroll`)와 같다: 폭 `--ui-scroll-w`, 손잡이
`--text-dim`, hover `--text-muted`, 반경 4px. 브라우저 기본 스크롤바를 쓰지 않는다 (2026-11-03 사용자 보고).

### 3.5 묶음 N — 미니맵 좌표 (사용자 보고 #5)

**현재.** 포크(`scripts/codemirror/minimap/`)는 미니맵 줄 높이를 편집기 줄 높이의 1/4 로 **고정**해서 그린다.
문서 높이가 그보다 길면 미니맵 내용을 스크롤 비율로 밀어 올린다(`canvasStartAndEndIndex`). 뷰포트 표시(슬라이더)는
스크롤바 thumb 좌표(FR-CMR-61)를 쓴다. 두 좌표계가 달라서 다음 문제가 생긴다.

| 문서 | 증상 |
|---|---|
| 미니맵 내용이 편집기 높이보다 짧다 | 내용이 위쪽 일부만 채운다. 슬라이더는 전체 높이를 오가므로 아래쪽에서 빈 곳을 가리킨다 |
| 미니맵 내용이 편집기 높이보다 길다 | 끝은 맞지만 중간에서는 슬라이더가 실제로 보이는 줄과 어긋난다 (400줄 실측: 슬라이더 236px, 보이는 첫 줄 222px) |

슬라이더 색은 `rgb(121,121,121)` · 불투명도 0.2 다. 어두운 테마에서는 hover 해도 거의 보이지 않는다.

**FR-ELS-50** 미니맵은 문서 **전체**를 편집기 스크롤 영역 높이에 그린다. 문서 위치 `y`(px, 스크롤 영역 기준 —
`documentPadding.top + lineBlock.top`)는 미니맵에서 `y × clientHeight / scrollHeight` 에 선다. 스크롤바 thumb 와 같은 비율이다.
그래서 thumb(=슬라이더)의 위·아래 끝이 곧 편집기에 보이는 영역의 위·아래 끝이다. 예외는 thumb 최소 높이
(`ED_SCROLL_MIN_THUMB`)에 걸린 긴 문서뿐이다.

**FR-ELS-51** 줄마다 높이는 그 줄 블록의 높이(줄바꿈·접힘 반영)에 같은 비율을 곱한 값이다. 미니맵 내용은 스크롤되지 않는다.

**FR-ELS-52** 글자는 세로로 늘이지 않는다. 비율이 기본 크기(편집기 줄 높이의 1/4)보다 크면 기본 크기로 그 줄의 위에 그린다.
작으면 그 높이로 줄인다. 줄 표식(찾기 · 선택 · 같은 낱말 · dirty diff gutter · 진단 · 선택 영역)은 줄 높이 전체를 채운다.

**FR-ELS-53** 한 장치 픽셀 행에 여러 줄이 겹치면 그 행의 첫 줄만 그린다. 한 번 그릴 때 그리는 줄 수는 캔버스 행 수를 넘지 않는다.

**FR-ELS-54** 스크롤만으로는 미니맵 내용을 다시 그리지 않는다. 슬라이더 자리만 옮긴다.

**FR-ELS-55** 편집기 스크롤바 thumb 와 미니맵 슬라이더는 **옛 엔진 기본값과 같은 중립 회색 반투명**이다 (`deriveScrollSlider` →
`--ed-thumb*`·`--ed-slider*`). 테마 색을 섞지 않는다 — `--text-muted` 를 섞으면 푸른 테마에서 미니맵이 파랗게 물든다
(2026-11-04 사용자 보고). 어두운 테마: thumb `#797979` 40% · hover `#646464` 70% · 끌기 `#bfbfbf` 40%. 밝은 테마: `#646464` 40% ·
70% · 끌기 `#000` 60%. 슬라이더는 옛 엔진(thumb 의 절반)보다 한 단 진하다 — 늘 보이게 했으므로: 어두운 테마 30% · hover 45% ·
끌기 30%, 밝은 테마 30% · 45% · 끌기 `#000` 40% (2026-11-04 사용자 결정 "조금 더 잘 보이게"). 불투명하면 아래의 미니맵 줄과 ruler 표식이
가려진다.

**FR-ELS-58** 미니맵은 처음 설 때(파일을 열 때 · 설정으로 켤 때) 곧바로 그린다. 스크롤 같은 다음 갱신을 기다리지 않는다
(FR-ELS-54 의 회귀 — 2026-11-03 사용자 보고).

**FR-ELS-57** `--text-dim` 은 팔레트 dim 을 `--text` 쪽으로 `TEXT_DIM_LIFT`(0.3)만큼 옮긴 **파생값**이다 (`themeVarsOf`). 팔레트는 고치지
않는다 (D-TOK-1). 팔레트 dim 은 많은 테마에서 `--border` 와 같아 스크롤바 손잡이가 보이지 않았다 (2026-11-03 사용자 보고 —
"dim 값을 올린다" 사용자 결정). `style.css` 의 첫 페인트 값은 기본 테마의 파생값이다. `--text-dim` 을 쓰는 다른 자리(스위치 손잡이 ·
사이드바 점 · git·runs 화면)도 함께 진해진다. 보이는 때는 그대로 미니맵 hover 이다 (FR-CMR-63 —
옛 엔진의 마지막 설정 `showSlider:'mouseover'` 와 같다).

**FR-ELS-54a** 다시 그릴지는 갱신 신호가 아니라 **그릴 결과의 지문**(줄 위치 · 표식 · 선택 · 진단 · 문서 · 폭 · 테마)으로 정한다. 지난번과
같으면 그리지 않는다. 스크롤로 새 줄이 화면에 들어오면 CM 은 높이가 그대로여도 geometry·height 신호를 내기 때문이다. 구문 강조가
늦게 끝났을 때만 지문을 건너뛴다. 줄바꿈이 켜진 문서에서 CM 이 새로 잰 줄 높이로 위치가 실제로 바뀌면 그때는 다시 그린다 —
그것이 슬라이더와 맞는 위치다 (C-3).

**FR-ELS-55a** 미니맵 슬라이더는 **늘** 보인다 (`showOverlay:'always'`). **FR-CMR-63 을 개정한다** — 이전: 미니맵에 마우스를 올렸을 때만.
이유: 사용자 보고(2026-11-03) — hover 일 때만 보이는 슬라이더를 "없다" 고 두 번 접수했다.

#### 3.5a 미니맵 자체 배치 (2026-11-04 사용자 결정 — 안 A)

**현재.** 줄 위치를 CM 의 높이표에서 가져온다. 줄바꿈이 켜져 있으면 화면 밖 줄의 높이는 CM 의 **추정값**이고, 그 줄이
화면에 들어올 때 실측으로 바뀐다. 한글처럼 폭이 넓은 글자에서 추정이 크게 빗나가, 스크롤할 때마다 아래 줄 전체가 밀리며
꿈틀거린다(800줄·첫 바퀴 19회). 옛 엔진은 줄바꿈을 DOM 없이 직접 계산하므로 이런 보정이 없다.

**FR-ELS-60** 미니맵의 줄 배치는 **문서 내용과 편집기 폭으로만** 계산한다. CM 의 높이표를 쓰지 않는다.
- 줄 하나의 칸 수: 글자마다 1칸, 동아시아 넓은 글자(한글·한자·가나·전각·이모지)는 2칸, 탭은 다음 탭 멈춤까지. 접힌 구간은 1칸.
- 줄바꿈이 켜져 있으면 그 줄의 화면 줄 수는 `max(1, ceil(칸 수 / 한 줄 칸 수))` 다. 한 줄 칸 수는
  `floor((내용 폭 − 줄 안쪽 여백) / 글자 폭)` 이다. 꺼져 있으면 1 이다.
- 줄 높이는 화면 줄 수 × 편집기 기본 줄 높이다. 문서 높이는 그 합 + 위·아래 여백이다.
- 미니맵 높이에 대한 비율은 `미니맵 높이 / max(문서 높이, 보이는 높이)` 다 (짧은 문서는 편집기와 1:1 — FR-ELS-50 과 같다).

**FR-ELS-61** 그래서 스크롤만으로는 미니맵 줄 위치가 바뀌지 않는다. 문서 · 폭 · 줄바꿈 설정 · 접힘이 바뀔 때만 바뀐다.

**FR-ELS-62** 슬라이더의 위·아래 끝은 **실제로 보이는 첫 줄과 끝 줄**의 미니맵 자리다. 보이는 줄은 CM 이 실측했으므로 정확하다:
`scrollTop`(·`+ 보이는 높이`)이 걸린 줄과 그 줄 안의 비율을 구해, FR-ELS-60 배치의 같은 줄 · 같은 비율 자리에 놓는다. 높이가
`ED_SCROLL_MIN_THUMB` 보다 작으면 가운데를 지키며 늘린다.

**FR-ELS-63** 슬라이더를 끌거나 미니맵을 누르면 FR-ELS-62 의 역으로 스크롤한다 — 미니맵 자리 → (줄, 비율) → 그 줄의 실측 위치.
누른 자리는 슬라이더의 가운데가 된다.

**FR-ELS-64** (2026-11-04 개정, 사용자 보고 #7) 미니맵이 켜져 있으면 편집기 스크롤바도 **FR-ELS-60 배치**를 쓴다.

- thumb 의 자리와 높이는 FR-ELS-62 의 슬라이더와 같다. 최소 높이도 같다.
- thumb 를 끌거나 track 을 누르면 FR-ELS-63 의 역으로 스크롤한다.
- ruler 표식의 세로 자리는 그 줄의 FR-ELS-60 배치 자리다 (미니맵 표식과 같은 좌표).

그래서 슬라이더와 thumb 는 줄바꿈과 상관없이 늘 같은 자리다. 미니맵이 꺼져 있으면 스크롤바는 종전대로 CM 의 높이를 따른다.

개정 전에는 줄바꿈이 켜지면 둘이 몇 px 다를 수 있다고 두었다. thumb 가 CM 의 높이(실측과 추정이 섞인다)를 따랐기 때문이다.
사용자의 문서(968줄, 한글 긴 줄)에서 최대 15px 어긋났고 슬라이더가 약 5% 짧았다. 한글은 영문 한 칸의 약 1.7배 폭이고
브라우저는 낱말 경계에서 줄을 바꾸므로, 글자 수로 센 FR-ELS-60 배치가 실측과 다르다 (C-4).

**FR-ELS-66** 변경 줄 표시(dirty diff) gutter 칸은 표식이 화면에 없어도 폭(9px)을 지킨다. 접히면 스크롤 중에 본문이 좌우로 9px 흔들리고
줄바꿈 자리가 바뀐다 — 미니맵 자체 배치의 폭도 함께 바뀌어 다시 그리게 된다 (V-ELS-26 조사 중 발견, 2026-11-04).

**FR-ELS-65** 배치의 칸 수는 문서가 바뀔 때만, 화면 줄 수의 누적은 칸 수 · 폭 · 줄바꿈이 바뀔 때만 다시 센다 (NFR-ELS-3 과 같은 결).

**FR-ELS-56** e2e 어댑터가 읽게 `minimapDrawn(view)` 이 그린 줄의 자리 `rows:[{line, y, h}]`(CSS px)를 함께 낸다.

---

## 4. 비기능 요구사항

**NFR-ELS-1** 새 벤더 패키지를 더하지 않는다. 링크 판정은 이미 실린 markdown-it 의 linkify 를 쓴다.

**NFR-ELS-2** 수정키 hover 의 밑줄 갱신은 mousemove 마다 문서 전체를 훑지 않는다. 포인터가 있는 줄 하나만 본다.

**NFR-ELS-3** 같은 낱말 표식은 선택이 바뀔 때만 다시 센다. 상한(FR-ELS-31)을 넘는 일치는 세지 않는다.

**NFR-ELS-4** 기존 게이트(`npm run lint` · `typecheck` · `unit` · `scripts/check-*` · `go vet` · `go test ./...`)를 모두 통과한다.

---

## 5. 검증

| ID | 대상 | 방법 | 판정 |
|---|---|---|---|
| V-ELS-1 | FR-ELS-1·2 | Go 단위: 내장 매니페스트를 불러 markdown 확장자가 `marksman` 하나로 풀린다 | `.md` → `marksman`, 중복 없음 |
| V-ELS-2 | FR-ELS-3 | Go 단위: 가짜 fetch 로 raw 타깃을 받는다 | `bin` 자리에 같은 바이트, POSIX `0755`, `.new` 자리 남지 않음 |
| V-ELS-3 | FR-ELS-3 실패 | sha 불일치 · `bin` 비움 · `bin` 이 `../x` · `strip:1` | 각각 거절, 아무 파일도 남지 않음 |
| V-ELS-4 | FR-ELS-11 | node 단위: 줄 텍스트와 열 → URL 범위 | `https://a.b/c` 안 → 범위, 끝 문장부호 제외, `README.md` → 없음, `http:` 없는 도메인 → 없음 |
| V-ELS-5 | FR-ELS-10 순서 | node 단위(`cm-harness`): URL 자리 · 문서 링크 자리 · 그 밖 자리에서 어느 동작을 부르는가 | 각각 open · 파일 열기 · 정의, 하나만 |
| V-ELS-6 | FR-ELS-13 | 문서 링크 요청이 실패 · 빈 결과 · `http:` target | 정의 이동으로 넘어간다 |
| V-ELS-7 | FR-ELS-20~22 | node 단위: 수정키 상태와 포인터 위치 → 밑줄 데코레이션 | 키를 떼면 없음 |
| V-ELS-8 | FR-ELS-30~33 | node 단위: 상태 → ruler 항목 | 다중 선택 · 같은 낱말(선택 자신 제외, 상한) · 진단 error/warning 만 · 커서 `full` · 순서 |
| V-ELS-9 | FR-ELS-31 경계 | 빈 선택 · 두 범위 선택 · 201자 선택 | 같은 낱말 없음 |
| V-ELS-10 | FR-ELS-40·41 | `scripts/check-hardcoded-color.mjs` · e2e 스크린 한 장(어두운 테마에서 LSP 오류 대화상자) | 게이트 통과, 배경이 `--bg-alt` |
| V-ELS-11 | FR-ELS-1 실서버 | 수동: marksman 설치 뒤 git 저장소의 `.md` 에서 `[x](y.md)` 를 수정키+클릭 | `y.md` 가 열린다, 오류 대화상자 없음 |
| V-ELS-13 | FR-ELS-50·51 | e2e: 짧은 문서(120줄)와 긴 문서(400줄)에서 위·가운데·끝으로 스크롤 | 보이는 첫 줄의 미니맵 `y` 가 슬라이더 top 과, 마지막 줄의 `y+h` 가 슬라이더 bottom 과 ±2px. 문서 마지막 줄의 bottom 이 미니맵 높이 − 아래 여백의 비율값과 ±2px |
| V-ELS-14 | FR-ELS-54 | e2e: 스크롤 전후 `rows` | 같다 |
| V-ELS-15 | FR-ELS-55 | e2e: 슬라이더 배경 계산값 | thumb 의 배경과 같다 |
| V-ELS-16 | FR-ELS-15·16 | e2e: LSP 없는 편집기의 글자 위 수정키+클릭 · Alt+클릭 | 수정키는 커서 하나 그대로, Alt 는 커서 둘 |
| V-ELS-17 | FR-ELS-3 | Go 단위: 선언이 있는 자리에 raw·tar 를 받는다 | 선언이 그대로 남는다 |
| V-ELS-18 | FR-ELS-57 | node 단위: 54종의 `themeVarsOf` · `style.css` 첫 페인트 | 파생값과 같고 `--border` 와 다르다 |
| V-ELS-19 | FR-ELS-45 | e2e: 편집기에 500줄짜리 hover 미리보기를 띄운다 | 높이·폭이 상한 이하, 안에서 스크롤된다 |
| V-ELS-20 | FR-ELS-58 | e2e: 파일을 열고 스크롤하지 않는다 | 미니맵이 1행부터 그린 줄을 낸다 |
| V-ELS-21 | FR-ELS-53·58 | e2e: 30줄·400줄 문서를 열고, 파일을 밖에서 10줄로 바꾼다 | 그린 줄 번호가 엄격히 늘어난다(중복 없음). 바뀐 뒤 2초 안에 1~11줄이다 |
| V-ELS-22 | FR-ELS-46·55a | e2e: 미리보기 스크롤바 손잡이 색 · 마우스를 올리지 않은 미니맵 슬라이더의 불투명도 | `--text-dim` 계산값 · 1 |
| V-ELS-23 | FR-ELS-51·53 | e2e: 줄바꿈을 켜고 긴 문단이 섞인 400줄 문서를 연다 (스크롤하지 않는다) | 그린 줄이 400 이고 중복이 없다 |
| V-ELS-24 | FR-ELS-55 | e2e · node 단위: 슬라이더 · thumb 배경 | 회색(R=G=B), 알파 < 1, 슬라이더 = thumb 의 절반. 모드별 값이 옛 엔진 기본값과 같다 |
| V-ELS-25 | FR-ELS-54a | e2e: 줄바꿈이 꺼진 800줄 문서에서 60번 스크롤한다 | 미니맵을 한 번도 다시 그리지 않는다 |
| V-ELS-26 | FR-ELS-60·61 | e2e: 줄바꿈 켬, 한글·긴 문단이 섞인 800줄 문서를 열고 끝까지 두 바퀴 스크롤한다 | 첫 바퀴부터 미니맵을 다시 그리지 않는다 |
| V-ELS-27 | FR-ELS-62 | e2e: 줄바꿈 켬, 위·가운데·끝으로 스크롤한다 | 보이는 첫 줄의 미니맵 y 가 슬라이더 top 에, 끝 줄이 bottom 에 ±2px 로 걸린다 |
| V-ELS-28 | FR-ELS-63 | e2e: 줄바꿈 켬, 미니맵의 3/4 지점을 누른다 | 그 자리의 줄이 화면에 보인다 |
| V-ELS-30 | FR-ELS-64 | e2e: 줄바꿈 켬, 한글 긴 줄이 섞인 문서를 위·가운데·끝으로 스크롤한다. thumb 를 끝까지 끈다 | 매 위치에서 thumb 와 슬라이더의 top · bottom 이 ±1px 로 같다. 끈 뒤 마지막 줄이 보인다. 커서 줄 ruler 표식의 y 가 미니맵의 그 줄 자리와 ±1px 로 같다 |
| V-ELS-29 | FR-ELS-66 | e2e: 변경 표식이 위에만 있는 문서를 끝까지 스크롤한다 | 본문 폭이 바뀌지 않는다 |
| V-ELS-12 | §2.2 html | 수동: `.html` 의 `href="b.html"` 을 수정키+클릭 | `b.html` 이 열린다 |

---

## 6. 제약 · 가정 · 리스크

| ID | 내용 |
|---|---|
| C-1 | marksman 은 루트에 `.git`·`.marksman.toml` 이 없으면 단일 파일 모드다. 다른 파일로 가는 링크는 그때 이동하지 않는다 |
| C-2 | win32-arm64 에는 marksman 배포본이 없다 |
| C-3 | ~~줄바꿈이 켜진 문서에서 미니맵 줄 위치가 처음 지나가는 구간에서 고쳐진다~~ — FR-ELS-60 이 없앴다. 미니맵이 켜져 있으면 thumb 도 같은 배치를 따르므로 함께 움직이지 않는다 (FR-ELS-64 개정) |
| C-4 | FR-ELS-60 의 화면 줄 수는 추정이다 — 브라우저는 낱말 경계에서 줄을 바꾸므로 실제가 조금 더 많을 수 있다. 미니맵 안의 상대 위치만 조금 다르고, 슬라이더는 FR-ELS-62 로 보이는 줄에 맞는다 |
| A-1 | `@codemirror/lsp-client` 의 `LSPClient.request` 로 표준이 아닌 요청(`textDocument/documentLink`)을 보낼 수 있다 (공개 API) |
| A-2 | 이미 vscode-langservers 를 설치한 사용자는 marksman 을 새로 설치해야 md LSP 가 선다. 기존 설치 제안(FR-LSP-44)이 `.md` 를 열 때 그것을 제안한다 |
| R-1 (MEDIUM) | 실행 파일을 받는 새 경로 — sha256 대조와 격리 칸 검사를 기존 archive 와 같은 함수로 지난다 |
| R-2 (LOW) | 수정키+클릭이 CM 기본의 다중 커서 추가와 겹친다 — 커서 추가를 Alt+클릭으로 옮겨 없앴다 (FR-ELS-15) |

### 동작 변경 기록

| 항목 | 이전 동작 | 새 동작 | 이유 |
|---|---|---|---|
| markdown 언어 서버 | `vscode-markdown-language-server` (실제로는 동작하지 않음) | `marksman` | §2.1·2.3 |
| 수정키+클릭 (LSP 없는 편집기) | 다중 커서 추가 | URL 위면 URL 을 연다. 그 밖은 아무것도 하지 않는다 | FR-ELS-10·15 |
| 커서 추가 | 수정키+클릭 | Alt+클릭 | FR-ELS-15 — 옛 엔진과 같다 |
| 사각 선택 | Alt+드래그 (Alt 를 누르면 십자 커서) | Shift+Alt+드래그 (십자 커서 없음) | FR-ELS-16 — Alt+클릭과 겹치지 않게 |
| 수정키+클릭 (LSP 있는 편집기) | 정의 이동 | URL 열기 → 문서 링크 → 정의 이동 순 | FR-ELS-10 |
| ruler | 찾기 · dirty diff · Git Diff | 더하여 선택 · 같은 낱말 · 진단 · 커서 | 사용자 보고 #3 |
| LSP 대화상자 | CodeMirror 기본(흰 바탕) | 앱 테마 | 사용자 보고 #4 |
| 스크롤바 thumb · ruler (미니맵 켬) | CM 의 높이 비율. 줄바꿈 문서에서 미니맵 슬라이더와 몇 px 다르다 | 미니맵 배치(FR-ELS-60)를 따른다. 슬라이더와 늘 같은 자리다 | 사용자 보고 #7 — 둘이 어긋나 보였다 (FR-ELS-64) |
| 미니맵 내용 | 고정 줄 높이(1/4). 길면 스크롤 비율로 밀린다 | 문서 전체를 스크롤 높이 비율로 그린다. 스크롤되지 않는다 | 사용자 보고 #5 — 슬라이더 양 끝이 보이는 영역이어야 한다 |
| 미니맵 슬라이더 · 편집기 thumb 색 | 회색 0.2 (hover 때만) · `--text-dim` 50% | 옛 엔진 기본값의 중립 회색 반투명 (thumb 40%, 슬라이더 20%) | 테마 색을 섞으면 물든다 · 불투명하면 아래가 가려진다 |
| `--text-dim` | 팔레트 값 그대로 | 팔레트 dim 을 text 쪽으로 30% (앱 전체) | FR-ELS-57 |
| ruler 의 선택 · 같은 낱말 · 커서 색 | (승인 원안) `--text-muted` · `--text-dim` · `--text` | `--text` · `--text-hint` · `--text-bright` | `--text-dim` 이 보이지 않았다 (사용자 보고) |
