# SRS: Diff 탭의 부분 스테이징을 hover 툴바로 — IEEE 29148

## 1. 개요

### 1.1 목적

접수한 말은 하나다.

> **"diff 에서 inline 으로 stage/revert 하는 기능이 하단에 떠서 공간을 가린다.
> 그렇게 말고 할 것만 그때그때 할 수 있나? VSCode 처럼."**

지금 Diff 탭은 같은 diff 를 **두 자리에** 그린다 — 위는 Monaco DiffEditor, 아래는
`.git-hunks` 가 서버의 unified diff 를 텍스트로 다시 그린 것이다. 그 아래 자리가
최대 42% 를 먹는다. 접수한 말의 "공간을 가린다" 가 그것이다.

VSCode 는 아래 자리를 갖지 않는다. diff 위에서 마우스가 올라간 조각에만 작은
툴바가 뜨고, 손을 떼면 사라진다. 줄 범위는 **에디터의 텍스트 선택**이 정한다.

### 1.2 범위

**포함**
- `.git-hunks` 패널과 그 안의 커스텀 diff 렌더링·줄 선택 UI 폐기
- Monaco **content widget** 으로 뜨는 hunk 동작 툴바 (hover 트리거)
- Monaco 텍스트 선택을 서버 hunk 좌표로 옮기는 사상
- 조각 관측의 로딩·없음·거부 사유를 `.git-diff-bar` 한 줄로 옮기기

**미포함** — §6.

### 1.3 착수 전 확정된 결정

사용자 인터뷰로 굳혔다. 스펙보다 앞선다.

| # | 물음 | 답 |
|---|---|---|
| **I-1** | hunk 동작 툴바의 트리거 | **hunk hover** — 모디파이드 쪽 diff 에서 마우스가 어느 hunk 위에 오면 그 hunk 첫 줄에 작은 툴바가 Monaco **content widget** 으로 뜬다. 세로 공간을 밀지 않고, 손을 떼면 사라진다. VSCode 의 SCM diff editor 와 같은 동작. **view zone 은 쓰지 않는다** (공간을 밀기 때문에 이번 요구를 어긴다) |
| **I-2** | 줄 범위 부분 스테이징 | **Monaco 텍스트 선택으로 옮긴다** — 에디터에서 줄을 드래그 선택하면 툴바 라벨이 `Stage lines`/`Revert lines` 로 바뀌고 그 범위에만 적용된다. VSCode 의 Stage Selected Ranges 방식. 커스텀 줄 선택 UI(`.git-hunk-line` 클릭·Shift·`Clear` 버튼, `_hunkPick`, `GIT_HUNK_HINT`, `GIT_HUNK_CLEAR*`)는 **폐기** |
| **I-3** | 하단 `.git-hunks` 패널과 그 안내문 | **패널 완전 제거.** 로딩·`GIT_HUNK_NONE`·바이너리 사유·stale 거부 사유(`_hunkErr`)는 상단 `.git-diff-bar` 에 한 줄로 보인다. 세로 공간을 전혀 먹지 않는다 |

---

## 2. 현재 상태 (코드에서 확인한 사실)

### 2.1 같은 diff 가 두 자리에 그려진다

`web/js/git/panel-diff.js:145` `_buildDiff` 가 `.git-diff-body`(Monaco DiffEditor)
**아래에** `.git-hunks` 를 세운다. 그 안을 채우는 것은 우리 코드다 —
`_drawHunks`(:348)가 조각마다 `_hunkEl`(:371)을 만들고, `_hunkEl` 이
`hunk.lines` 를 `.git-hunk-line` 으로 한 줄씩 그린다.

`web/style-git-views.css:805`:

```css
.git-hunks{ display:none;flex:0 0 auto;max-height:42%;overflow:auto; … }
```

### 2.2 줄 선택은 커스텀이다

`_hunkClick`(:413)·`_hunkPick`(:434)이 `.git-hunk-line` 클릭·Shift 클릭으로
`this._hunkSel={hunk,from,to,anchor}` 를 잡는다. `from`/`to` 는 서버
`hunk.lines` 의 1-기반 인덱스다. 안내문 `GIT_HUNK_HINT` 가 그 조작법을 설명한다 —
**사용자가 배워야 하는 조작**이며, 그 자리 바로 위의 에디터는 이미 텍스트 선택을
안다.

### 2.3 쓰기 경로는 이미 좌표만 보낸다 — 이 규약은 건드리지 않는다

`_hunkAct`(:453):

```js
const body={repo:f.repo,axis:f.axis,path:f.path,op,hunk:idx,
  from:sel?sel.from:0,to:sel?sel.to:0,diffId:h.diffId};
```

패치는 서버가 만든다 (GIT_ACTIONS_SRS D6). `_hunkRevert`(:469)가 파괴적 동작의
확인과 recovery hint 를 지나고, `_afterHunk`(:490)가 관측을 놓는다.

**바뀌는 것은 `hunk`·`from`·`to` 의 출처뿐이다.**

### 2.4 서버는 필요한 것을 이미 다 준다

`GET /api/git/hunks` 가 `diffId` 와
`hunks[]{index,header,oldStart,oldLines,newStart,newLines,lines}` 를 준다
(`query/diff.go:344`, `handlers_git_patch.go:63`). **서버는 손대지 않는다.**

`from`/`to` 의 뜻도 서버가 정해 두었다 (`write/patch.go:169~218`):

- `hunk.lines` 안의 **1-기반 인덱스**이며, 둘 다 0 이면 덩어리 전체다
- **문맥 줄(`' '`)은 선택 여부와 무관하게 언제나 남는다**
- 고르지 않은 `+`/`-` 의 처리는 방향에 따라 뒤집힌다 — `stage` 는 고르지 않은
  `+` 를 빼고 고르지 않은 `-` 를 문맥으로 바꾼다

마지막 항목이 사상의 제약을 만든다: **수정 짝(`-`와 `+`)은 함께 골라야 한다.**
`+TEN` 만 고르고 `-line10` 을 빼면 그 `-` 가 문맥이 되어 index 에 `line10` 과
`TEN` 이 **둘 다** 남는다.

### 2.5 이미 있는 선례 — 좌표 사상은 편집기 쪽에 이미 있다

`web/js/ui/file-editor-diff.js` 가 편집기에서 VSCode 방식을 이미 한다
(EDITOR_DIRTY_DIFF_SRS FR-EDD-30~49). 그중 둘이 이 작업의 재료다:

| 함수 | 하는 일 |
|---|---|
| `edDdStageCoords(hunks,change)` (:129) | 조각 → `{hunk,from,to,wide}` |
| `edDdLineRange(hunk,change)` (:146) | 새 줄 범위 + 옛 줄 범위 → `lines` 인덱스 범위. 삭제 줄·문맥 줄·`\ No newline` 표식을 이미 다룬다 |

**두 벌을 만들지 않는다** (사용자 지시). 다만 입력이 다르다 — 편집기는 조각의
**옛 줄 범위까지** 알고(기준 내용을 갖고 있다), Diff 탭의 Monaco 선택은 **새 줄
범위만** 준다. §5 D-2 가 그 차이를 다룬다.

### 2.6 e2e 8개가 전부 폐기되는 DOM 에 걸려 있다

`e2e/git-hunk.spec.ts` 의 G1~G8 이 `.git-hunk-line`·`.git-hunk-act`·
`.git-hunk-note.fail` 을 딛는다. **검증의 값은 그 DOM 이 아니라 마지막 몇 줄**이다 —
`indexOf(repo)`·`worktreeOf(repo)` 로 실제 저장소를 읽는다. 그 규약은 그대로 두고
조작 부분만 다시 쓴다.

### 2.7 Monaco 가 필요한 것을 다 준다 (실측)

`monaco-editor@0.56.0/esm/vs/editor/editor.api.d.ts` 확인:

| API | 줄 | 쓰임 |
|---|---|---|
| `addContentWidget` / `removeContentWidget` | 6361 | 툴바 (I-1) |
| `ContentWidgetPositionPreference.{EXACT,ABOVE,BELOW}` | 5557 | 자리 |
| `allowEditorOverflow` | 5613 | 첫 줄에서 잘리지 않게 |
| `onMouseMove` / `onMouseLeave` | 6112 / 6117 | hover |
| `onDidChangeCursorSelection` | 6035 | 라벨 갱신 (I-2) |

`GitDiffView` 는 `getModifiedEditor()` 를 이미 쓴다 (`diff-view.js:238`).

---

## 3. 요구사항

### 3.1 묶음 R — 하단 패널 폐기 (FR-DHB-1~6)

**FR-DHB-1** `.git-hunks` 와 그 하위 DOM 을 **걷는다.** `_buildDiff` 는 그 자리를
만들지 않는다.

**FR-DHB-2** 함께 폐기되는 것: `_drawHunks`·`_hunkEl`·`_hunkClick`·`_hunkPick`·
`this._hunkSel`·`gitHunkSpan`, 상수 `GIT_HUNK_HINT`·`GIT_HUNK_CLEAR`·
`GIT_HUNK_CLEAR_TITLE`·`GIT_HUNK_LINE_CLASS`, CSS
`.git-hunks`·`.git-hunk`·`.git-hunk-head`·`.git-hunk-body`·`.git-hunk-line`·
`.git-hunk-clear`·`.git-hunk-range`·`.git-hunk-spacer`·`.git-hunk-note`·
`.git-hunk-header`.

**FR-DHB-3** 유지되는 것: `GIT_HUNK_LABEL`·`GIT_HUNK_LINE_LABEL`·`GIT_HUNK_TITLE`·
`GIT_HUNK_ACTS`·`GIT_HUNK_AXES`·`GIT_HUNK_LOADING`·`GIT_HUNK_LOAD_FAIL`·
`GIT_HUNK_NONE`·`GIT_HUNK_REVERT_TITLE`·`GIT_HUNK_REVERT_NOTE`·`GIT_WRITE_ERR`
확장, 그리고 쓰기 경로 셋(`_hunkAct`·`_hunkRevert`·`_afterHunk`).

`GIT_HUNK_SEL_LABEL`·`GIT_HUNK_SEL_SEP`(`선택 3~7`)도 **남는다** — 줄 범위를
고르는 UI 는 사라지지만 그 범위를 **말해야 하는 자리**가 남기 때문이다: revert
확인 대화의 대상 라벨이다 (FR-DHB-42). 무엇을 되돌리는지 밝히지 않는 파괴적 확인은
확인이 아니다.

**FR-DHB-4** 조각 관측의 상태는 `.git-diff-bar` 의 **한 줄**로 보인다 (I-3) —
새 요소 `.git-diff-hunk-note`. 세로 공간을 먹지 않는다.

**FR-DHB-5** 그 한 줄이 말하는 것 넷이다: 받는 중(`GIT_HUNK_LOADING`) ·
받지 못함(`GIT_HUNK_LOAD_FAIL`) · 나눌 조각이 없음(서버의 `note` 또는
`GIT_HUNK_NONE`) · 거부 사유(`_hunkErr`).

**FR-DHB-6** 거부 사유는 **누른 자리에** 남는다 (FR-GIT-278 의 요구를 그대로
지킨다). 그 자리가 이제 Diff 탭의 머리이며, 실패는 `.fail` 로 구분된다.

### 3.2 묶음 B — hover 툴바 (FR-DHB-10~22)

**FR-DHB-10** 툴바는 Monaco **content widget** 이다 (I-1). view zone 을 쓰지
않는다 — 그것은 세로 공간을 밀고, 그것이 이번 요구가 없애려는 것이다.

**FR-DHB-11** 트리거는 **모디파이드 에디터의 hover** 다. 마우스가 어느 hunk 의 줄
위에 있으면 그 hunk 의 툴바가 뜨고, 다른 hunk 로 넘어가면 그쪽으로 옮겨간다.

**FR-DHB-12** 자리는 그 hunk 의 **첫 줄**이다 (`hunk.newStart`). 선호는
`ABOVE` 이고 자리가 없으면 `BELOW` 다 — 첫 줄의 hunk 에서 화면 밖으로 나가지
않는다. `allowEditorOverflow` 로 에디터 경계에 잘리지 않는다.

**FR-DHB-13** 마우스가 에디터를 떠나면 사라진다 (`onMouseLeave`). **툴바 자신에
올라가 있는 동안은 사라지지 않는다** — 그러지 않으면 버튼을 누를 수 없다.

**FR-DHB-14** hunk 가 아닌 줄(문맥만 있는 자리) 위에서는 뜨지 않는다.

**FR-DHB-15** 붙는 동작은 **축이 정한다** — `GIT_HUNK_ACTS`(constants-git.js:1301).
worktree↔index 는 `stage`·`revert`, index↔HEAD 는 `unstage` 뿐이다.

**FR-DHB-16** 라벨은 영어다 (FR-GIT-202): 선택이 없으면 `GIT_HUNK_LABEL`
(`Stage hunk`), 선택이 걸리면 `GIT_HUNK_LINE_LABEL`(`Stage lines`).

**FR-DHB-17** `revert` 는 파괴적이므로 색으로도 그 사실이 보인다 (기존
`.git-hunk-act[data-act="revert"]` 규약을 유지한다).

**FR-DHB-18** 쓰기 중에는 버튼이 비활성이다 (`this._writing`) — 기존과 같다.

**FR-DHB-19** blame 모드·커밋 축·부분 스테이징이 없는 축에서는 툴바가 **서지
않는다** (`_paintDiff:200` 의 판정을 그대로 딛는다).

**FR-DHB-20** 툴바는 **관측이 도착한 뒤에만** 뜬다. 조각 경계를 모르는 동안 뜨는
버튼은 무엇에 걸리는지 말할 수 없다.

**FR-DHB-21** 툴바의 DOM 은 **하나**다. hunk 를 옮겨 다닐 때 만들고 버리지 않고
자리와 라벨만 바꾼다.

**FR-DHB-22** 에디터가 사라지면(탭·리포 전환, `GitDiffView.clear()`) 위젯과
리스너도 함께 간다 (FR-GIT-56). GitPanel 이 들고 있던 참조도 끊는다.

### 3.3 묶음 S — 선택 → 좌표 (FR-DHB-30~38)

**FR-DHB-30** 줄 범위는 **모디파이드 에디터의 텍스트 선택**이다 (I-2).

**FR-DHB-31** 선택이 비어 있으면(커서만 있음) 동작의 대상은 **hunk 전체**이며
좌표는 `{from:0,to:0}` 다.

**FR-DHB-32** 선택이 있으면 **그 툴바가 속한 hunk 와의 교집합**만 대상이다.
선택이 여러 hunk 를 걸쳐도 적용되는 것은 그 하나뿐이다 — 서버 `patch` 는 hunk
번호 **하나**를 받으므로(§2.4) 그것이 규약의 한계이고, 화면이 그것을 넘어서는
약속을 하지 않는다.

> 이것이 옛 G8("선택이 조각을 넘지 않는다")의 새 뜻이다. 옛 규약에서는 클릭이
> 다른 조각으로 선택을 **옮겼다**. 새 규약에서 선택은 에디터의 것이므로 막을 수
> 없고, 대신 **적용 범위가 hunk 경계에서 잘린다.**

**FR-DHB-33** 교집합의 줄 범위는 `lines` 인덱스로 옮긴다. 사상은 §2.4 의 제약을
지킨다 — **수정 짝은 함께 간다**: 선택된 새 줄이 어떤 변경 블록의 `+` 줄이면 그
블록의 `-` 줄도 범위에 든다.

**FR-DHB-34** 사상이 서지 않으면(선택에 바뀐 줄이 하나도 없다) **hunk 전체로
물러서고 라벨도 `Stage hunk` 로 돌아간다.** 조용히 다른 범위를 올리지 않는다.

**FR-DHB-35** 삭제만 있는 변경은 모디파이드 쪽에 줄이 없으므로 텍스트 선택으로
고를 수 없다. 그 조각은 **hunk 전체 동작**으로만 다룬다 — VSCode 도 같다.

**FR-DHB-36** 좌표 사상은 **순수 함수**이며 편집기 쪽과 **같은 파일**에 산다
(§2.5, D-2). 두 벌을 만들지 않는다.

**FR-DHB-37** 선택이 바뀌면 라벨이 곧바로 따라온다
(`onDidChangeCursorSelection`) — 무엇에 걸리는 동작인지 누르기 전에 보인다.

**FR-DHB-38** 좌표는 **누를 때** 다시 읽는다. 툴바가 떠 있는 동안 선택이 바뀔 수
있으므로, 라벨을 그린 시점의 값을 들고 있지 않는다.

### 3.4 묶음 W — 쓰기 (FR-DHB-40~44)

**FR-DHB-40** 요청은 지금과 **같다** — `POST /api/git/patch`
`{repo,axis,path,op,hunk,from,to,diffId}`. 패치 문자열을 조립하는 코드를
클라이언트에 만들지 않는다 (D6).

**FR-DHB-41** `diffId` 로 stale 거부가 성립한다. 409 를 받으면 사유를 보이고
조각을 다시 받는다 (`_afterHunk` 의 기존 동작).

**FR-DHB-42** `revert` 는 `GitDialog.confirm` 을 지난다. 대상 라벨은 선택 여부에
따라 조각 머리 또는 `선택 <from>~<to>` 이며, recovery hint(`git stash push`)를
유지한다 (FR-GIT-91·92).

**FR-DHB-43** 성공하면 관측을 놓고 다시 받는다 — 조각을 적용하면 남은 덩어리의
번호가 밀린다 (`_afterHunk` 의 근거 그대로).

**FR-DHB-44** 쓰기 뒤 툴바는 **다시 hover 로만** 뜬다. 사라진 조각 위에 남지
않는다.

### 3.5 묶음 P — 폴링 (FR-DHB-50~53)

**FR-DHB-50** 조각 관측은 대상이 그대로면 다시 받지 않는다 — 기존 `_hunkKey`
규약을 유지한다.

**FR-DHB-51** 폴링(3초)이 **Monaco 선택을 초기화하지 않는다.** 대상이 같으면
모델을 다시 만들지 않으므로(`_showTarget`) 선택은 그대로다.

**FR-DHB-52** 폴링이 툴바를 없애거나 옮기지 않는다. 툴바의 계기는 hover 와 선택
둘뿐이다.

**FR-DHB-53** `.git-diff-hunk-note` 는 내용이 같으면 다시 쓰지 않는다 — 기존
`box.dataset.sig` 가 막던 것을 같은 근거로 이 한 줄에도 둔다.

---

## 4. 비기능 요구

**NFR-DHB-1** Diff 탭의 세로 공간을 조각 UI 가 **한 픽셀도** 먹지 않는다. 이것이
접수한 말의 요구다.

**NFR-DHB-2** side-by-side 와 inline 두 모드에서 다 선다
(`GIT_DIFF_OPTIONS.renderSideBySideInlineBreakpoint:900`). 툴바는 모디파이드
에디터에 붙으므로 두 모드에서 같은 자리다.

**NFR-DHB-3** 사용자 파일 내용은 언제나 `textContent` 로 넣는다 (`gitHunkSpan` 의
근거). 툴바에는 파일 내용이 들어가지 않지만 조각 머리(`hunk.header`)가 확인
대화의 라벨로 가므로 그 경로가 그대로다.

**NFR-DHB-4** Monaco 인스턴스·위젯·리스너는 탭·리포 전환에서 반드시 정리된다
(FR-GIT-56).

**NFR-DHB-5** 상수는 `constants-git.js` 에 둔다. 라벨·안내문을 코드에 박지 않는다.

---

## 5. 설계 결정

**D-1 툴바는 content widget 이다.** view zone 은 줄 사이에 자리를 만들어 문서를
밀어낸다 — 편집기의 dirty diff 팝업이 그것을 쓰는 것은 그 화면의 요구가 "이전
내용을 보여 달라" 였기 때문이다(EDITOR_DIRTY_DIFF_SRS FR-EDD-30). 여기의 요구는
**정반대**다: 공간을 먹지 말라는 것이다. 그래서 같은 목적의 두 화면이 서로 다른
Monaco 기능을 쓴다.

**D-2 좌표 사상은 한 파일로 승격하고 진입점을 둘 둔다.**

`edDdStageCoords`·`edDdLineRange` 는 `web/js/ui/file-editor-diff.js` 안에 있었고,
그것은 편집기의 파일이다. Diff 탭이 그것을 부르면 git 뷰가 편집기의 내부를 딛는
꼴이 된다. 그러므로 **`web/js/core/hunk-coords.js`** 로 옮긴다 — 서버 hunk 좌표의
클라이언트 측 사상은 편집기의 것도 git 뷰의 것도 아니고 **서버 규약의 것**이다.

입력이 둘인 이유는 부르는 쪽이 아는 것이 다르기 때문이다:

| 진입점 | 부르는 쪽 | 아는 것 |
|---|---|---|
| `gitHunkCoordsForChange(hunks,change)` | 편집기 (FR-EDD-46) | 새 줄 범위 **와** 옛 줄 범위 (기준 내용을 갖고 있다) |
| `gitHunkCoordsForLines(hunks,hunkIndex,from,to)` | Diff 탭 (FR-DHB-33) | 새 줄 범위만 (Monaco 선택) |

둘의 하부는 하나다 — `gitHunkScan(hunk)` 이 `lines` 를 훑어 줄마다
`{i,mark,newLine,oldLine}` 를 매기고, 두 진입점이 그 위에서 자기 판정만 한다.
그래서 "문맥 줄은 새 쪽과 옛 쪽을 함께 소비한다"·"`\` 는 앞 줄에 딸린다" 같은
규약이 한 자리에만 있다.

**D-3 선택은 hunk 경계에서 잘린다.** 서버 `patch` 가 hunk 번호 하나를 받는 것이
그 근거다 (§2.4). 여러 hunk 에 걸친 선택을 여러 요청으로 쪼개 보내는 길도 있으나,
그러면 중간에 실패한 요청이 남기는 상태를 화면이 설명할 수 없다 — 하나는
올라가고 하나는 stale 로 거부된 결과를 "부분 성공" 으로 보이는 화면은 만들지
않는다.

**D-4 `GitDiffView` 에 여는 것은 훅 하나다.** 이 클래스의 설계 원칙은 "탭도 관측도
모른다"(`diff-view.js:87`)이다. 그러므로 hunk 관측을 넣지 않고
`onEditor(modifiedEditor|null)` 콜백만 더한다 — 에디터가 서거나 사라졌다는 사실은
이 클래스가 아는 것이고, 그 위에 무엇을 붙일지는 부르는 쪽(GitPanel)이 안다.

**D-5 좌표는 누를 때 읽는다** (FR-DHB-38). 라벨을 그린 시점과 누르는 시점 사이에
선택이 바뀔 수 있고, 그 사이의 값을 들고 있으면 화면이 말한 것과 보내는 것이
달라진다.

---

## 6. 비목표

1. **선택을 여러 hunk 에 걸쳐 한 번에 적용** — D-3.
2. **툴바에서 다음/이전 조각으로 이동** — Diff 탭 머리의 ‹ › 는 **파일** 이동이고
   (FR-GIT-53), 조각 이동은 Monaco 의 diff 항해(`goToDiff`)가 이미 안다.
3. **삭제 줄의 줄 범위 선택** — FR-DHB-35.
4. **서버 변경** — 종단·좌표 규약 모두 그대로다 (§2.4).
5. **편집기 쪽 dirty diff 의 동작 변경** — 좌표 함수의 **자리**만 옮기고 뜻은
   그대로다 (D-2). EDITOR_DIRTY_DIFF_SRS 의 FR 은 하나도 바뀌지 않는다.
6. **`.git-hunks` 를 접을 수 있게 만들기** — 접히는 패널은 여전히 자리를 갖고,
   접는 조작을 배워야 한다. 접수한 말은 그 자리를 없애 달라는 것이다.

---

## 7. 검증

E2E 는 `e2e/git-hunk.spec.ts` 를 다시 쓴다. **검증은 화면 글자가 아니라 실제
저장소의 index·워킹 트리에서** 한다 — 기존 파일의 규약이며 그대로 유지한다 (§2.6).

| # | 검증 |
|---|---|
| **V-DHB-1** | Diff 탭에 `.git-hunks` 가 **없다.** 조각 UI 가 세로 공간을 먹지 않는다 (NFR-DHB-1) |
| **V-DHB-2** | (G1) 조각 셋 중 하나 위에 마우스를 올려 `Stage hunk` 를 누르면 그 조각만 index 에 오르고 나머지는 워킹 트리에 남는다 |
| **V-DHB-3** | (G2) staged 행(index↔HEAD)의 툴바에는 `unstage` 만 있다 — `stage`·`revert` 는 없다 (FR-DHB-15) |
| **V-DHB-4** | (G3) 관측이 그 사이 바뀌었으면 거부되고, 사유가 `.git-diff-hunk-note.fail` 에 남으며 index 는 그대로다 (FR-DHB-6·41) |
| **V-DHB-5** | (G4) 모디파이드 에디터에서 한 변경 짝의 줄을 선택하면 라벨이 `Stage lines` 로 바뀌고, 누르면 그 범위만 index 에 오른다. 고르지 않은 변경은 원래 내용으로 남는다 (FR-DHB-30·33) |
| **V-DHB-6** | (G5) 같은 일이 `unstage` 축에서도 성립한다 |
| **V-DHB-7** | (G6) `revert lines` 는 확인 대화를 지나고 `git stash push` hint 를 보이며, 확인 뒤 워킹 트리의 그 범위만 되돌아간다 (FR-DHB-42) |
| **V-DHB-8** | (G7) 확인을 취소하면 워킹 트리가 그대로다 |
| **V-DHB-9** | (G8·새 뜻) 선택이 두 조각을 걸쳐도 적용되는 것은 툴바가 속한 조각 안의 범위뿐이다 — 다른 조각은 index 에 오르지 않는다 (FR-DHB-32) |
| **V-DHB-10** | 툴바는 hunk 위에서만 뜨고, 마우스가 에디터를 떠나면 사라진다 (FR-DHB-11·13·14) |
| **V-DHB-11** | blame 모드와 커밋 축에서는 툴바가 서지 않는다 (FR-DHB-19) |
| **V-DHB-12** | 선택에 바뀐 줄이 없으면 라벨이 `Stage hunk` 로 돌아가고 동작은 조각 전체다 (FR-DHB-34) |
| **V-DHB-13** | 단위(`page.evaluate`): `gitHunkScan`·`gitHunkCoordsForLines`·`gitHunkCoordsForChange` 가 문맥 줄·삭제 줄·`\ No newline`·수정 짝을 규약대로 다룬다 (FR-DHB-33·36) |
| **V-DHB-14** | 회귀: `e2e/editor-dirty-diff.spec.ts` 전량이 통과한다 — 좌표 함수의 자리를 옮겨도 편집기의 뜻은 그대로다 (비목표 5) |
| **V-DHB-15** | 회귀: 기존 git e2e 전량이 통과한다 |
