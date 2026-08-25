# 설계 계약 — M1 7단계 Diff (묶음 F, FR-GIT-43~56)

GIT_SRS.md §3.6 이다. 검증은 V10·V11·V12·V26.
전제: 1·2·3·5·6단계가 끝나 있다.

diff 렌더링은 **새로 만들지 않는다.** `monaco.editor.createDiffEditor` 가
VSCode 의 diff 뷰어 그 자체이고 이미 로드되는 자산이다 (FR-GIT-43).

## 0. 파일 배치

| 파일 | 변경 |
|---|---|
| `internal/git/diff.go` | `DiffSide`·`DiffContent`·`Service.DiffContent` |
| `internal/server/handlers_git.go` | `/api/git/diff-content` 추가 |
| `internal/server/handlers_api.go` | 라우트 1개 추가 |
| `web/js/file-editor.js` | Monaco 로더를 공용 함수로 꺼낸다 (최소 리팩터) |
| `web/js/git-panel.js` | Diff view + Changes 탭 미리보기 |
| `web/js/constants.js` | diff 상수 |
| `web/style.css` | `/* ── Git diff ── */` 구획 |
| `e2e/git-diff.spec.ts` | **신규** — V11·V12·V26 |

## 1. 서버 — `/api/git/diff-content` (FR-GIT-44~48, 62)

### 1.1 요청

```
GET /api/git/diff-content
    ?repo=<절대경로>
    &axis=worktree-index | index-head | worktree-head
    &path=<리포 상대경로>            ← modified 쪽 경로
    &origPath=<리포 상대경로>        ← 선택. original 쪽 경로 (rename 대응). 없으면 path
```

`axis` 값은 상수로 못박는다. 모르는 값은 400 `bad_request`.
`commit-parent` 축은 M4 다 — **지금 만들지 않는다.**

### 1.2 축별 양쪽 (FR-GIT-44)

| axis | original | modified |
|---|---|---|
| `worktree-index` | `git show :<origPath>` (index) | 워킹 트리 파일 |
| `index-head` | `git show HEAD:<origPath>` | `git show :<path>` |
| `worktree-head` | `git show HEAD:<origPath>` | 워킹 트리 파일 |

**unified diff 텍스트를 반환하지 않는다.** Monaco DiffEditor 는 두 모델을
요구하므로 양쪽 전체 내용을 준다.

### 1.3 응답

```json
{
  "requested": {"repo":"…","axis":"…","path":"…","origPath":"…"},
  "repo": "/abs/root",
  "axis": "worktree-index",
  "path": "rel/path",
  "origPath": "rel/path",
  "original": {"kind":"text","content":"…","size":123},
  "modified": {"kind":"absent","content":"","size":0},
  "note": "새로 추가된 파일입니다"
}
```

`requested` 는 클라이언트가 보낸 값 그대로다 — stale 가드(FR-GIT-54)의 서버측
절반이며, 식별자는 `(리포, 축, 경로, 리비전)` 이다.

```go
// DiffSide 는 비교 한쪽이다. kind 가 text 가 아니면 content 는 비어 있다 —
// 뷰어는 본문 대신 안내를 보인다.
type DiffSide struct {
    Kind    string `json:"kind"`    // text | absent | binary | lfs | too_large
    Content string `json:"content"` // Kind=="text" 일 때만 채운다
    Size    int64  `json:"size"`
    // LFS 포인터의 메타. Kind=="lfs" 일 때만 (FR-GIT-47)
    LFSOid  string `json:"lfsOid,omitempty"`
    LFSSize int64  `json:"lfsSize,omitempty"`
}
```

| `kind` | 뜻 | FR |
|---|---|---|
| `text` | 본문이 있다 | — |
| `absent` | 그 쪽에 파일이 없다 (추가·삭제). `content:""` 로 다뤄 diff 는 성립한다 | 45 |
| `binary` | 바이너리. 본문을 주지 않는다 | 46 |
| `lfs` | Git LFS 포인터. 메타만 준다 | 47 |
| `too_large` | 상한 초과. 본문을 주지 않는다 | 48 |

`note` 는 사람이 읽는 한 줄이다. 양쪽 중 하나라도 `text` 가 아니면 채운다.

### 1.4 판정 순서 (각 쪽마다)

1. **존재 확인 → 크기**
   - blob 쪽(`:<p>` / `HEAD:<p>`): `git cat-file -s <rev>` 로 크기를 얻는다.
     실패하면 `absent`.
   - 워킹 트리 쪽: `os.Stat`. `IsNotExist` 면 `absent`. 디렉터리면 `absent`.
2. **크기 상한** — `size > DiffMaxBytes` 면 `too_large` (본문을 읽지 않는다).
3. **본문 읽기** — blob 은 `git show <rev>`, 워킹 트리는 `os.ReadFile`.
   워킹 트리 읽기는 **`repo` 아래인지 확인한 뒤에만** 한다 (FR-GIT-62).
   `path` 에 `..` 이 있거나 절대경로면 400 `bad_request`.
4. **LFS 포인터** — 크기가 `LFSMaxPointerBytes` 이하이고 본문이
   `version https://git-lfs.github.com/spec/` 로 시작하면 `lfs`.
   `oid sha256:<hex>` 와 `size <n>` 을 뽑는다.
5. **바이너리** — 앞 `BinarySniffBytes` 안에 NUL 바이트가 있으면 `binary`
   (git 의 판정과 같은 휴리스틱).
6. 그 밖은 `text`.

```go
const (
    DiffMaxBytes         = 1 << 20 // 1MiB (O2, FR-GIT-48)
    LFSMaxPointerBytes   = 1024    // LFS 포인터는 작다
    BinarySniffBytes     = 8000    // git 의 휴리스틱과 같은 폭
)
```

`internal/git` 은 워킹 트리 파일을 직접 읽는다 — git 을 경유할 이유가 없고
`git show` 는 index/HEAD 만 안다. 그 읽기는 `repo` 아래로 제한된다.

`readCommands` 허용 목록에 `cat-file`·`show` 는 이미 있다. **목록을 늘리지 않는다.**

### 1.5 오류

2단계 §5.1 의 규약을 그대로 쓴다. 추가로:
- 모르는 `axis` → 400 `bad_request`
- `path` 가 비었거나 리포를 벗어남 → 400 `bad_request`
- **양쪽이 모두 `absent`** → 404 `not_found` (요청 자체가 잘못된 것이다)

## 2. Monaco 로더 공용화 (`web/js/file-editor.js`)

`FileEditor._loadMonaco` 안의 로직을 모듈 수준 함수로 꺼낸다.

```js
// Monaco 는 CDN 로드다. 한 번만 로드하고 대기 중인 호출자들이 같은 Promise 를
// 공유한다. 실패는 캐시하지 않는다 — 네트워크가 돌아오면 다시 시도할 수 있어야 한다.
function loadMonaco(){ … }   // Promise<void>

// 테마는 CSS 변수에서 파생한다. 테마를 바꾸면 diff 색도 따라 바뀐다.
function monacoTheme(){ … }  // 'dongminal' 등 테마 이름
```

`FileEditor` 는 이 함수들을 부르도록 고친다. **동작을 바꾸지 않는다.**
`FileEditor` 의 기존 `_loadMonaco`·`_resolveTheme` 는 얇은 위임으로 남기거나
호출부를 직접 바꾼다 — 어느 쪽이든 기존 e2e 가 그대로 통과해야 한다.

## 3. 클라이언트 (FR-GIT-49~56)

### 3.1 상수

```js
// DiffEditor 옵션. ignoreTrimWhitespace 는 Monaco 기본값(true)을 뒤집는다 —
// git 은 공백 변경을 변경으로 취급하기 때문이다 (FR-GIT-50).
const GIT_DIFF_OPTIONS={
  renderSideBySide:true,
  useInlineViewWhenSpaceIsLimited:true,
  renderSideBySideInlineBreakpoint:900,
  hideUnchangedRegions:{enabled:true},
  ignoreTrimWhitespace:false,
  readOnly:true,
  originalEditable:false,
  automaticLayout:true,
  scrollBeyondLastLine:false,
  renderOverviewRuler:false,
};
// Changes 탭의 미리보기는 좁다. 접기와 inline 전환을 더 이르게 건다.
const GIT_PREVIEW_INLINE_BREAKPOINT=560;
const GIT_AXIS={STAGED:'index-head', UNSTAGED:'worktree-index', CONFLICT:'worktree-head'};
```

### 3.2 `GitDiffView` — 두 자리에서 쓰는 하나의 뷰

Changes 탭의 미리보기와 Diff 탭은 같은 것을 다른 크기로 보인다. **하나의 클래스로
만들고 두 번 인스턴스화한다.** 코드를 두 번 쓰지 않는다.

```js
/**
 * Monaco DiffEditor 한 개를 감싼다.
 *
 * 인스턴스는 탭·리포 전환에서 반드시 정리된다 (FR-GIT-56) — Monaco 에디터는
 * DOM 을 떼는 것으로 해제되지 않고, 남으면 모델과 리스너가 누적된다.
 */
class GitDiffView {
  constructor(opts)          // {inlineBreakpoint}
  get el()
  // show 는 (리포, 축, 경로) 를 받아 내용을 불러 그린다. stale 가드를 자기가 건다.
  async show(target, token)  // target={repo,axis,path,origPath}
  clear(message)             // 본문 대신 안내를 보인다
  setSideBySide(on)          // FR-GIT-51
  setIgnoreWhitespace(on)    // FR-GIT-50 의 사용자 토글
  layout()
  destroy()                  // FR-GIT-56. 모델까지 dispose
}
```

- `show` 는 `loadMonaco()` 를 먼저 기다린다. 실패하면 `clear(사유)` 로 끝내고
  **예외를 밖으로 던지지 않는다** — Git 창의 나머지가 계속 동작해야 한다
  (FR-GIT-55).
- `kind` 가 `text` 가 아닌 쪽이 있으면 DiffEditor 를 만들지 않고 `note` 를
  안내로 보인다 (FR-GIT-46·47·48).
- 언어는 `path` 의 확장자로 `LANG_MAP` 에서 뽑는다.
- 모델은 `monaco.editor.createModel` 로 만들고, 새 내용을 보일 때 **이전 모델을
  dispose** 한다.

### 3.3 Diff 탭 (FR-GIT-51·53)

```
.git-view.git-diff
├ .git-diff-bar
│   [‹][›]  <경로>  (2/3)   [side-by-side ▾]  ☐ 공백무시
└ .git-diff-body   ← GitDiffView
```

- `‹ ›` 는 **Changes 탭의 현재 목록과 같은 순서**를 돈다 (FR-GIT-53). 목록은
  `GitPanel` 이 들고 있는 평탄화된 파일 배열이며, 그룹 순서(conflicts → staged →
  changes → untracked)를 따른다.
- `2/3` 은 현재 위치다. 목록이 비면 `0/0` 이고 `‹ ›` 는 disabled.
- 파일이 목록에서 사라지면(커밋·discard 로) 인덱스를 경계로 클램프하고 그 사실을
  바에 한 줄로 보인다. **아무 파일이나 임의로 보이지 않는다.**
- side-by-side ↔ unified 전환과 공백무시 토글은 `localStorage` 에 남긴다.
- Diff 탭에서 파일을 이동하면 Changes 탭의 선택도 따라 움직인다 (같은 상태다).

### 3.4 Changes 탭 미리보기 (FR-GIT-52)

- 단일 클릭 → 우측 `.git-preview` 의 `GitDiffView.show(...)`.
- 더블클릭 → Diff 탭으로 전환하고 그 파일을 대상으로 둔다 (5단계가 이미 전환까지
  해 두었다. 여기서 내용을 붙인다).
- 미리보기 인스턴스는 `renderSideBySide:false` 를 기본으로 한다 — 좁은 자리에서
  좌우 비교는 읽히지 않는다. `useInlineViewWhenSpaceIsLimited` 가 있어도
  기본값을 inline 으로 두는 것이 이 자리에 맞다.

### 3.5 정리 (FR-GIT-56, 검증 V12)

`GitPanel` 은 다음마다 `destroy()`/`clear()` 를 부른다:

| 시점 | 동작 |
|---|---|
| 활성 리포 변경 | 두 뷰 모두 `clear()` + 대상 초기화 |
| Git 창 삭제 (`detach`) | 두 뷰 모두 `destroy()` |
| Diff 탭에서 다른 탭으로 전환 | `destroy()` 하지 않는다 (같은 파일로 돌아올 때 재로드 비용) — 단 **모델은 하나만 살아 있어야 한다** |

V12 의 "전환 반복 후 인스턴스 누수 없음" 은
`monaco.editor.getModels().length` 와 `getDiffEditors().length` 로 e2e 에서
확인한다. 반복 전후로 늘어나지 않아야 한다.

### 3.6 stale 가드 (FR-GIT-54)

식별자는 `(리포, 축, 경로, 리비전)` 이다. `GitPanel.token()` 에 대상까지 실어
`isStale` 을 확장하거나, `GitDiffView` 가 자기 요청 일련번호를 들고 응답을
비교한다. **둘 중 하나를 반드시 하고, 응답의 `requested` 도 함께 확인한다.**

## 4. e2e (`e2e/git-diff.spec.ts`)

| # | 검증 | 내용 |
|---|---|---|
| D1 | V26 | 파일 단일 클릭이 미리보기를 채운다 |
| D2 | V26 | 더블클릭이 Diff 탭으로 이동하고 그 파일을 보인다 |
| D3 | V26 | `‹ ›` 로 이전/다음 파일로 이동하고 `n/m` 이 바뀐다 |
| D4 | V11 | side-by-side ↔ unified 전환이 동작한다 |
| D5 | V11 | 폭을 900px 아래로 줄이면 inline 으로 전환된다 |
| D6 | V11 | 공백무시 토글이 동작한다 (공백만 다른 파일로 확인) |
| D7 | V12 | Monaco CDN 을 차단(`page.route` 로 abort)해도 Git 창의 파일 목록·헤더가 동작하고 diff 영역이 사유를 보인다 |
| D8 | V12 | 탭·리포를 20회 왕복해도 `monaco.editor.getModels().length` 가 늘지 않는다 |
| D9 | V10 | 바이너리 파일은 본문 대신 안내를 보인다 |
| D10 | V10 | 새로 만든 파일(추가)과 지운 파일(삭제)이 각각 그려진다 |

서버측 V10 은 Go 단위 테스트로 고정한다:

| # | 내용 |
|---|---|
| G1 | 3개 축 각각이 맞는 `git show` 인자를 만든다 (주입 Runner 의 argv 확인) |
| G2 | 추가된 파일 → original `absent`, modified `text` |
| G3 | 삭제된 파일 → original `text`, modified `absent` |
| G4 | 바이너리(NUL 포함) → `binary`, content 비어 있음 |
| G5 | LFS 포인터 → `lfs` + oid·size 파싱 |
| G6 | 상한 초과 → `too_large`, content 비어 있음, git show 를 부르지 않음 |
| G7 | rename: `origPath` 가 original 쪽에 쓰인다 |
| G8 | `path` 에 `..` / 절대경로 → 거부 (보안, FR-GIT-62) |
| G9 | 양쪽 모두 absent → 오류 |
| G10 | 응답의 `requested` 가 요청값과 같다 (stale 가드) |

## 5. 하지 않는 것

- `commit-parent` 축 — M4.
- hunk/line 단위 스테이징 — 비목표.
- 자체 diff 하이라이트 엔진 — FR-GIT-43 이 금지한다.
- 3-way merge editor — 비목표.
