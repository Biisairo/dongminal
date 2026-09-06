# SRS: Editor 편집기의 변경 표시 (dirty diff) — IEEE 29148

## 1. 개요

### 1.1 목적

접수한 말은 하나다.

> **"editor 에서도 편집 페이지에서 git diff 를 적용. 즉 스크롤에는 바뀐부분을
> 표시하고 좌측에서도 바뀐 부분 표시. vsc 와 동일."**

VS Code 가 *dirty diff* 라 부르는 것이다 — 편집기 안, 줄번호 왼쪽의 좁은 세로
막대와 스크롤바(overview ruler) 위의 색 자국. 지금 그것을 갖고 있는 화면은 **Diff
탭 하나**이고, 파일을 여는 화면(Editor 탭의 편집기)에는 git 이 한 자국도 없다.

### 1.2 범위

**포함**
- 편집기(`FileEditor` 의 `IStandaloneCodeEditor`)의 좌측 여백·overview ruler·
  미니맵에 변경 줄 표시
- 그 표시를 **편집 중에도** 따라오게 하는 클라이언트 diff
- 막대를 누르면 그 조각의 이전 내용을 편집기 안에 펼치는 인라인 팝업
- 팝업에서의 **되돌리기**와 **스테이지**

**미포함** — §6 에 근거와 함께 적는다.

### 1.3 착수 전 확정된 결정

사용자 인터뷰(2026-09-06)로 굳혔다. 스펙보다 앞선다.

| # | 물음 | 답 |
|---|---|---|
| **I-1** | 막대의 상호작용을 어디까지 잡는가 | **표시 + 인라인 팝업 + 되돌리기/스테이지** — VS Code 전체 동작 |
| **I-2** | 편집 중(dirty)에 스테이지를 누르면 | **자동 저장 후 스테이지** — 저장하고, hunk 를 다시 받아 새 `diffId` 로 올린다 |

---

## 2. 현재 상태 (코드에서 확인한 사실)

### 2.1 편집기에는 git 표시가 하나도 없다

`web/js/ui/file-editor.js:333` `_createEditor` 가 세우는 편집기의 데코레이션은
둘뿐이다 — 찾기 하이라이트(`_findDecos`)와 LSP 진단. git 은 이 파일 어디에도
없다. `minimap` 은 켜져 있고(`enabled:true`) overview ruler 는 Monaco 의 기본값
그대로다.

### 2.2 git diff 표시는 Diff 탭 전용이다

`web/js/git/diff-view.js:186` 이 `monaco.editor.createDiffEditor` 로 세우는 그
화면이다. `EDITOR_GIT_UX_SRS` FR-DOR-1~6 이 그 overview ruler 를 켰지만, 대상은
**DiffEditor** 이고 그것은 파일을 편집하는 화면이 아니다.

### 2.3 서버는 이미 필요한 것을 다 준다

| 종단 | 주는 것 |
|---|---|
| `GET /api/git/status?repo=<abs>` | `repo`(git 이 해석한 저장소 루트) · `repoResolved` · `rootMatch`. 캐시·TTL·single-flight 를 지난다 (`handlers_git.go:413`) |
| `GET /api/git/diff-content?repo=&axis=&path=` | `original`·`modified` 의 `{kind,content,size}`. binary·LFS·상한·absent 판정을 이미 한다 (`handlers_git.go:490`) |
| `GET /api/git/hunks?repo=&axis=&path=` | `diffId` 와 `hunks[]{index,header,oldStart,oldLines,newStart,newLines,lines}` (`handlers_git_patch.go:63`) |
| `POST /api/git/patch` | 좌표(`hunk`,`from`,`to`,`diffId`)만 받아 서버가 패치를 짓는다 (`handlers_git_patch.go:80`) |

**서버에 새 종단을 만들지 않는다.** 이 넷으로 요구가 전부 선다.

### 2.4 Monaco 는 diff 계산을 공개하지 않는다 (실측)

CDN 의 `monaco-editor@0.56.0/esm/vs/editor/editor.api.d.ts` 를 받아 확인했다.
`diff` 로 잡히는 공개 진입점은 `createDiffEditor`·`getDiffEditors`·
`createMultiFileDiffEditor` 와 `IDiffEditor.getLineChanges()` 뿐이다 — **두 문서를
받아 변경 목록을 돌려주는 함수가 없다.**

그러므로 셋 중 하나다:

1. 클라이언트가 줄 단위 diff 를 직접 계산한다 — 편집 중 실시간이 되고 의존이
   늘지 않는다
2. 화면 밖 `DiffEditor` 를 하나 더 세워 `getLineChanges()` 를 읽는다 — 편집기마다
   숨은 에디터가 붙는다
3. 서버 `/api/git/hunks` 에 의존한다 — 서버는 **디스크만** 안다. 저장 전에는
   표시가 갱신되지 않으므로 "vsc 와 동일" 이 성립하지 않는다

§5 D-1 이 1 을 고른다.

표시 수단은 확인됐다 — `IModelDecorationOptions` 에
`linesDecorationsClassName`(1770) · `overviewRuler`(1733) · `minimap`(1737) 이 있고,
`ITextModel.deltaDecorations`(2250) 는 폐기 대상이 아니다(폐기된 것은
`ICodeEditor` 쪽 6316 이다). 인라인 팝업의 자리는 `changeViewZones`(6400) 다.

### 2.5 부분 스테이징 규약이 축을 강제한다

`domain/git/write/patch.go:105` 가 op 마다 축을 못박는다 — `stage`·`revert` 는
`worktree-index`, `unstage` 는 `index-head`. `query.HunksOf` 도 그 두 축만 받는다
(`query/diff.go:376`).

**이것이 기준(base)을 정한다.** 편집기의 막대를 `HEAD` 기준으로 그리면, 스테이지된
변경이 섞인 파일에서 화면의 조각과 서버가 적용할 조각의 경계가 어긋난다. 그리고
VS Code 도 실제로 index 기준이다 — 변경을 스테이지하면 그 막대가 사라진다.

`from`·`to` 의 뜻도 확인했다 (`patchSelect`·`patchBody`, `patch.go:169~218`):
덩어리 본문(`hunk.lines`) 안의 **1-기반 인덱스**이며, 둘 다 0 이면 덩어리 전체다.
**문맥 줄(`' '`)은 선택 여부와 무관하게 언제나 남는다** — 그러므로 범위에 문맥이
섞여 들어와도 결과가 달라지지 않는다. 위험한 것은 다른 조각의 `+`/`-` 줄이 범위에
들어가는 경우 하나뿐이다.

`diffId` 는 **디스크의** diff 원문 해시다 (`query/diff.go:400`). 편집 버퍼를
고치는 것은 디스크를 바꾸지 않으므로, dirty 상태의 stage 는 stale 로 걸리지 않고
그대로 통과한다 — 화면이 고른 조각과 서버가 올리는 조각이 다를 수 있다. I-2 가
이것을 "저장하고, 다시 받아서 올린다"로 닫는다.

### 2.6 색 규약은 이미 셋이다

탐색기 트리가 쓰는 것이 그대로 근거다 (`web/style-editor.css:175~177`):

```css
.ed-row.st-add .ed-name,.ed-row.st-new .ed-name{color:var(--git-st-add)}
.ed-row.st-mod .ed-name{color:var(--accent)}
.ed-row.st-del .ed-name{color:var(--danger)}
```

추가는 `--git-st-add`, 수정은 `--accent`, 삭제는 `--danger` 다. 편집기의 막대도
같은 셋을 쓴다 — 같은 창의 두 표면이 같은 사실에 다른 색을 쓰면 그중 하나는
거짓말이 된다.

### 2.7 즉시 갱신 계기는 이미 하나다

`App._gitSignal`(`app-git.js:265`)이 그 자리이고, `app-editor.js:1014` 가 이미
그것을 감싸 탐색기 폴링을 잇는다. `FileEditor.save` 가 그것을 부른다
(`file-editor.js:522`). **두 번째 진입점을 만들지 않는다.**

### 2.8 모델은 문서의 것이다

같은 파일을 두 칸에서 열면 Monaco 모델은 하나다 (`_edDoc`, FR-SVS-50·51).
데코레이션을 **모델**에 걸면 계산 한 번이 그 파일을 보는 모든 칸에 함께 뜬다.
편집기에 걸면 칸마다 계산과 컬렉션이 따로 생긴다.

---

## 3. 요구사항

### 3.1 묶음 B — 기준(base) 취득 (FR-EDD-1~9)

**FR-EDD-1** 기준은 **index** 다 — `worktree-index` 축의 `original` 이다
(`GIT_AXIS.UNSTAGED`). HEAD 가 아니다 (§2.5).

**FR-EDD-2** 기준 내용은 `GET /api/git/diff-content?repo=<저장소 루트>&
axis=worktree-index&path=<상대경로>` 의 `original.content` 다. 새 종단을 만들지
않는다.

**FR-EDD-3** 저장소 루트와 상대경로는 `GET /api/git/status?repo=<창의 루트>` 가
준 `repo`·`repoResolved` 에서 낸다. 탐색기 트리의 `_prefixOf`(`file-tree-paint.js:312`)와
**같은 규약**이며, 클라이언트가 심볼릭 링크를 풀려 하지 않는다 (그 자리의 §2.5
결함이 그것이었다).

**FR-EDD-4** 그 status 는 이미 탐색기가 3초마다 부르는 것과 같은 요청이므로
서버의 캐시·single-flight 에 실린다. **편집기가 자기 주기로 status 를 폴링하지
않는다.**

**FR-EDD-5** 기준은 **문서마다 하나** 캐시한다 (§2.8). 같은 파일을 두 칸에서
열어도 취득은 한 번이다.

**FR-EDD-6** `original.kind` 가 `text` 가 아니면(absent·binary·LFS·상한) 표시를
**하지 않는다.** untracked 파일은 index 에 없어 `absent` 로 오며, 그것이 VS Code
와 같은 동작이다.

**FR-EDD-7** 저장소가 아닌 루트, git 없음(503), 그 밖의 실패에서는 표시하지 않고
**조용히 멎는다.** 편집기가 서지 않거나 오류를 띄우는 일은 없다.

**FR-EDD-8** 503 은 굳힌다(다시 묻지 않는다). 4xx 는 늦춘다 — `_gitOff`·
`_gitRetryAt` 의 관례를 그대로 쓴다 (`file-tree-paint.js:262` 의 표와 같다).

**FR-EDD-9** 기준을 못 얻은 동안 편집기의 다른 기능(찾기·LSP·저장)은 영향을 받지
않는다.

### 3.2 묶음 C — diff 계산 (FR-EDD-10~16)

**FR-EDD-10** diff 는 **클라이언트가** 계산한다. 왼쪽은 FR-EDD-2 의 기준 내용,
오른쪽은 **모델의 현재 값**이다 — 디스크가 아니다. 그래서 편집 중에도 표시가
따라온다.

**FR-EDD-11** 계산은 줄 단위이며 결과는 세 종류의 조각이다:
`add`(기준에 없던 줄) · `mod`(대응하는 줄이 바뀜) · `del`(기준에만 있던 줄).

**FR-EDD-12** 알고리즘은 ① 공통 접두·접미 트림 ② 남은 구간에 대한 Myers greedy
편집 거리다. 트림은 편집 중의 흔한 경우(파일 한 곳만 고침)를 상수 시간에 가깝게
만든다.

**FR-EDD-13** 상한을 둔다 — 파일 줄 수 상한과 편집 거리 상한. 둘 중 하나를 넘으면
표시를 **생략한다**(계산을 끝까지 밀지 않는다). 값은 상수로 두며 코드에 박지
않는다.

**FR-EDD-14** 재계산은 모델 변경에 **디바운스**로 잇는다. 값은 상수다.

**FR-EDD-15** 계산 결과와 데코레이션은 **모델**에 건다 (§2.8) —
`ITextModel.deltaDecorations`. 같은 문서를 보는 모든 칸이 한 번의 계산을 나눠
쓴다.

**FR-EDD-16** 문서가 버려질 때(`_edDocDrop`) 데코레이션과 캐시도 함께 걷는다.
남기면 다시 열었을 때 낡은 막대가 먼저 보인다 (FR-LSP-35 와 같은 근거).

### 3.3 묶음 M — 표시 (FR-EDD-20~28)

**FR-EDD-20** 좌측 여백에 세로 막대를 세운다 — `linesDecorationsClassName`.
`add`·`mod` 는 그 줄들에 걸리고, `del` 은 줄이 없으므로 **삭제가 일어난 자리의
경계**에 표식을 둔다.

**FR-EDD-21** overview ruler 에 같은 조각을 찍는다 —
`overviewRuler:{color,position}`. 이것이 접수한 말의 "스크롤에는 바뀐부분을 표시"
다.

**FR-EDD-22** 미니맵에도 찍는다 — `minimap:{color,position}`. 미니맵은 이미 켜져
있고, VS Code 도 그 자리에 표시한다.

**FR-EDD-23** 색은 §2.6 의 셋에서 파생한다 — `add`=`--git-st-add`,
`mod`=`--accent`, `del`=`--danger`. **색 값을 코드에 박지 않는다** (FR-GIT-119 와
같은 근거). overview ruler·미니맵은 CSS 클래스가 아니라 색 문자열을 받으므로,
`monacoTheme()` 이 이미 하는 것처럼 `getComputedStyle` 로 변수를 읽는다.

**FR-EDD-23b** 테마를 바꾸면 그 색도 **곧바로** 따라온다. 자리는
`FileEditor.applyTheme`(`file-editor.js:970`)이며, 그것이 이미 살아 있는 편집기와
diff 뷰의 테마를 다시 세우는 훅이다 (FR-GIT-49) — 두 번째 훅을 만들지 않는다.

**FR-EDD-24** 막대는 **좁다** — 본문의 자리를 빼앗지 않는다. 편집기의
`lineDecorationsWidth` 를 늘리지 않는다.

**FR-EDD-25** 표시는 **읽기 전용 파일에서도** 뜬다. 그것은 사실의 표시이고 편집
권한과 무관하다.

**FR-EDD-26** 기준과 현재 내용이 같으면 데코레이션은 **없다** — 빈 컬렉션이다.

**FR-EDD-27** 이진·이미지 파일은 편집기를 세우지 않으므로(FR-EVW-3) 이 묶음의
대상이 아니다.

**FR-EDD-28** 표시가 있고 없음은 **줄 번호와 어긋나지 않는다.** 코드 접기가
켜져 있어도 데코레이션은 모델 좌표에 걸리므로 Monaco 가 그 사상을 맡는다 —
`hideUnchangedRegions` 를 이 화면에 켜지 않는다 (FR-DOR-2 와 같은 근거).

### 3.4 묶음 P — 인라인 팝업 (FR-EDD-30~37)

**FR-EDD-30** 좌측 막대를 누르면 그 조각의 팝업이 **편집기 안에서** 열린다 —
`changeViewZones` 로 자리를 만들고 그 위에 DOM 을 얹는다.

**FR-EDD-31** 팝업은 그 조각의 **기준 쪽 내용**을 보인다 — `del`·`mod` 는 사라진/
바뀐 이전 줄들, `add` 는 이전에 아무것도 없었다는 사실. 내용은 FR-EDD-5 의 캐시에서
꺼낸다 — **서버를 다시 부르지 않는다.**

**FR-EDD-32** 팝업의 본문은 사용자의 파일 내용이므로 **마크업으로 넣지 않는다**
(`diff-view.js:8` 이 세운 규약).

**FR-EDD-33** 팝업은 한 번에 하나다. 다른 막대를 누르면 그쪽으로 옮겨간다.

**FR-EDD-34** 닫는 길이 둘이다 — 닫기 버튼과 `Escape`. `Escape` 는 찾기 패널이
떠 있으면 그쪽이 먼저 먹는다 (FR-EFP 의 규약을 깨지 않는다).

**FR-EDD-35** 팝업에는 동작 둘이 있다 — **되돌리기**와 **스테이지** (§3.5).

**FR-EDD-36** 표시가 갱신되어 그 조각이 사라지면(편집·저장·기준 갱신) 팝업도
닫힌다. 없는 조각에 대한 동작 버튼을 남기지 않는다.

**FR-EDD-37** 팝업이 열린 동안에도 편집은 막히지 않는다 — view zone 은 문서의
내용이 아니다.

### 3.5 묶음 A — 되돌리기 · 스테이지 (FR-EDD-40~49)

**FR-EDD-40** **되돌리기는 서버를 부르지 않는다.** 그 조각의 줄들을 기준 내용으로
치환하는 **모델 편집**이다 — `executeEdits` 로 넣으므로 `Cmd+Z` 로 되돌릴 수
있고, 저장 전까지 디스크는 그대로다. VS Code 도 그 자리에서 버퍼를 되돌린다.

> 서버에 `patch{op:'revert'}` 가 있지만 그것은 **파괴적이고**(`confirm:true` 를
> 요구하며 워킹 트리를 즉시 덮는다, `patch.go:88`) 되돌릴 길이 없다. 편집기 안에서
> 같은 일을 undo 가능한 편집으로 할 수 있으므로 그 경로를 쓰지 않는다 (D-3).

**FR-EDD-41** 되돌리기 뒤 문서는 dirty 가 된다. 저장은 사용자가 한다 —
자동 저장하지 않는다.

**FR-EDD-42** 되돌린 직후 표시는 다시 계산되어 그 조각이 사라진다 (FR-EDD-14 의
경로를 그대로 지난다).

**FR-EDD-43** **스테이지는 서버가 한다** — `POST /api/git/patch`
`{op:'stage', axis:'worktree-index', repo, path, hunk, from, to, diffId}`.
클라이언트는 좌표만 보낸다 (D6 을 깨지 않는다).

**FR-EDD-44** 문서가 dirty 면 **먼저 저장한다** (I-2). 저장은 `FileEditor.save`
의 경로 하나이며(`/api/file/write`) 새 쓰기 표면을 만들지 않는다. 저장이 실패하면
스테이지하지 않고 사유를 팝업에 보인다.

**FR-EDD-45** 저장 뒤 `GET /api/git/hunks?axis=worktree-index` 를 **그 자리에서**
받아 새 `diffId` 와 새 경계를 얻는다. 화면이 들고 있던 좌표를 그대로 보내지
않는다.

**FR-EDD-46** 클라이언트 조각 → 서버 hunk 좌표의 사상은 이렇다:

1. 조각의 **새 쪽 줄 범위**와 겹치는 서버 hunk 를 찾는다
   (`newStart … newStart+newLines-1`).
2. 그 hunk 의 `lines` 를 훑어 새 쪽 줄 번호를 세고, 조각에 해당하는 `+`·`-` 줄의
   **1-기반 인덱스 최소~최대**를 `from`·`to` 로 낸다. 문맥 줄이 범위에 섞여도
   결과는 같다 (§2.5).
3. 겹치는 hunk 가 없거나 사상이 서지 않으면 **덩어리 전체**(`from:0,to:0`)로
   물러서고, 그 사실을 팝업에 적는다 — 조용히 다른 범위를 올리지 않는다.

**FR-EDD-47** 서버가 `stale_observation`(409)으로 거부하면 사유를 팝업에 보이고
경계를 다시 받는다. 낡은 번호로 재시도하지 않는다.

**FR-EDD-48** 스테이지 성공은 즉시 신호다 — `App._gitSignal` 을 부른다 (§2.7).
그리고 기준을 다시 받는다: index 가 방금 바뀌었으므로 그 조각의 막대는 사라져야
한다.

**FR-EDD-49** 스테이지는 파괴적이 아니다(`patch.go:80`) — `GitDialog.confirm` 을
거치지 않는다. 되돌리기도 모델 편집이므로 확인을 거치지 않는다 (undo 가 그 자리를
맡는다).

### 3.6 묶음 R — 갱신 계기 (FR-EDD-50~55)

**FR-EDD-50** 기준을 받는 계기는 셋이다 — ① 편집기가 처음 설 때 ② `_gitSignal`
이 올 때 ③ 스테이지 성공 직후(FR-EDD-48).

**FR-EDD-51** `_gitSignal` 에 잇는 자리는 `app-editor.js:1014` 의 **그 감싸기
하나**다. 두 번째 진입점을 만들지 않는다 (§2.7).

**FR-EDD-52** 편집기는 자기 주기의 폴링을 **갖지 않는다.** 터미널에서 `git add` 를
해도 다음 `_gitSignal` 이나 파일 열기까지 막대가 낡을 수 있다 — 그 대가로 요청이
탭 수에 비례해 늘지 않는다 (D-5).

**FR-EDD-53** 표시를 다시 계산하는 계기는 ① 모델 변경(디바운스) ② 기준 갱신
③ 파일 새로고침(`refresh`)이다.

**FR-EDD-54** 같은 문서를 보는 칸이 둘이면 계기가 어느 쪽에서 오든 계산은 한
번이고 결과는 양쪽에 뜬다 (FR-EDD-15).

**FR-EDD-55** 탭을 닫아도 문서가 남아 있으면(다른 칸이 보고 있으면) 기준 캐시도
남는다. 문서가 버려질 때 함께 버린다 (FR-EDD-16).

---

## 4. 비기능 요구

**NFR-EDD-1** 편집 중 입력 지연이 없어야 한다. 계산은 디바운스 뒤 한 번이며,
상한을 넘는 파일은 계산하지 않는다 (FR-EDD-13).

**NFR-EDD-2** 요청 수가 **탭 수·칸 수에 비례하지 않는다.** 기준은 문서마다
하나이고(FR-EDD-5), status 는 서버 캐시에 실린다(FR-EDD-4), 편집기 폴링은
없다(FR-EDD-52).

**NFR-EDD-3** git 이 없거나 저장소가 아닌 자리에서도 편집기는 지금과 똑같이
동작한다 (FR-EDD-7).

**NFR-EDD-4** 상수는 `constants-editor.js` 에 둔다. 색·주기·상한을 코드에 박지
않는다.

**NFR-EDD-5** 새 파일은 기존 분업을 따른다 — 편집기의 표면은 `web/js/ui/`,
데코레이션 계산은 그 옆의 자기 파일, 상수는 `web/js/core/constants-editor.js`,
CSS 는 `web/style-editor.css`.

---

## 5. 설계 결정

**D-1 diff 는 클라이언트가 계산한다.** Monaco 가 계산을 공개하지 않고(§2.4),
서버는 디스크만 안다. 숨은 `DiffEditor` 는 편집기마다 에디터 하나를 더 세운다.
남는 것은 직접 계산이며, 그것이 "편집 중에도 따라온다"를 유일하게 만족한다.

**D-2 기준은 index 다.** 서버 patch 가 축을 강제하고(§2.5), VS Code 도 그렇다.
HEAD 를 쓰면 스테이지된 파일에서 화면과 서버의 조각이 어긋난다.

**D-3 되돌리기는 모델 편집, 스테이지는 서버.** 되돌리기는 undo 가능한 편집으로
같은 결과를 낼 수 있으므로 파괴적 서버 경로를 열지 않는다. 스테이지는 index 를
바꾸는 일이라 클라이언트가 흉내낼 수 없다.

**D-4 데코레이션은 모델에 건다.** 문서 하나에 계산 하나다 (§2.8).

**D-5 편집기는 폴링하지 않는다.** 계기는 `_gitSignal` 과 열기뿐이다. 탭마다
3초 폴링을 붙이면 요청이 탭 수에 비례해 늘고, 그 대가로 얻는 것은 "터미널에서
`git add` 한 결과가 몇 초 빨리 보이는 것" 뿐이다.

**D-6 서버 종단을 새로 만들지 않는다.** 절대경로 → (저장소 루트, 상대경로) 변환은
`status` 가 이미 주는 값으로 서고(§2.3), 그 규약은 탐색기가 검증하고 있다.

**D-7 테마 전환은 이미 있는 훅에 잇는다.** 착수 시의 판단은 "Monaco 테마를 다시
세우는 자리가 편집기 생성밖에 없으므로 즉시 재칠은 범위 밖" 이었다. **틀렸다** —
`FileEditor.applyTheme`(`file-editor.js:970`)가 그 훅이고 `applyThemeObj` 가 그것을
부른다 (FR-GIT-49). 데코레이션의 색도 그 자리에서 다시 세운다 (FR-EDD-23b).

---

## 6. 비목표

1. **`unstage`** — 편집기가 보는 축은 `worktree-index` 하나다. 내리는 축
   (`index-head`)의 조각은 편집기의 버퍼와 대응하지 않으므로 그 화면은 Changes·
   Diff 탭의 것이다.
2. **이전/다음 변경으로 이동하는 버튼** — Diff 탭에 이미 있고(`goToDiff`),
   편집기에서 그것을 다시 만드는 것은 표시가 아니라 항해다.
3. **줄 하나 단위의 스테이지** — 조각 단위로 올린다. 줄 범위 선택 UI 는 Changes·
   Diff 탭의 `.git-hunks` 가 이미 갖고 있다 (FR-GIT-279).
4. **`hideUnchangedRegions`(접기)** — FR-DOR-2 와 같은 근거다. 편집기는 파일을
   그대로 보이는 자리다.
5. **터미널의 git 조작을 즉시 반영** — D-5.
6. **Diff 탭·Changes 사이드의 변경** — 그 화면들은 그대로다.

---

## 7. 검증

E2E 는 `e2e/git_fixture.sh` 규약을 그대로 쓴다 (`editor-git-ux.spec.ts` 와 같다).

| # | 검증 |
|---|---|
| **V-EDD-1** | 커밋된 파일을 편집기로 열고 한 줄을 고치면(저장 없이) 그 줄에 좌측 막대가 뜬다 |
| **V-EDD-2** | 같은 상태에서 overview ruler 에 데코레이션이 실린다 (모델 데코레이션의 `overviewRuler` 로 확인) |
| **V-EDD-3** | 줄을 지우면 `del` 표식이 그 경계에, 새 줄을 넣으면 `add` 막대가 그 줄에 뜬다 |
| **V-EDD-4** | 기준과 같아지도록 되돌려 놓으면(직접 편집) 데코레이션이 **0** 이 된다 |
| **V-EDD-5** | untracked 파일에는 막대가 뜨지 않는다 (FR-EDD-6) |
| **V-EDD-6** | 저장소가 아닌 루트의 파일을 열어도 편집기가 정상이고 막대가 없다 (FR-EDD-7) |
| **V-EDD-7** | 같은 파일을 두 칸에서 열면 양쪽에 같은 막대가 뜬다 — 한쪽에서 고치면 양쪽이 함께 갱신된다 (FR-EDD-15·54) |
| **V-EDD-8** | 막대를 누르면 팝업이 열리고 그 안에 **기준 쪽 줄**이 보인다 (FR-EDD-31) |
| **V-EDD-9** | 팝업의 되돌리기를 누르면 그 조각이 기준 내용으로 돌아가고 문서는 dirty 가 된다. `Cmd+Z` 로 다시 되돌아온다 (FR-EDD-40·41) |
| **V-EDD-10** | dirty 상태에서 스테이지를 누르면 ① 파일이 저장되고 ② `hunks` 를 다시 받고 ③ 그 조각이 index 에 올라가며 ④ 막대가 사라진다 (FR-EDD-44~48) |
| **V-EDD-11** | 변경이 두 곳인 파일에서 한쪽 조각만 스테이지하면 **다른 쪽은 그대로** 남는다 (FR-EDD-46 의 좌표 사상) |
| **V-EDD-12** | 파일을 스테이지한 뒤 열면 막대가 없다 — 기준이 index 이기 때문이다 (FR-EDD-1, D-2) |
| **V-EDD-13** | 줄 수 상한을 넘는 파일에서는 계산을 건너뛰고 편집기가 지연 없이 뜬다 (FR-EDD-13) |
| **V-EDD-14** | 편집기 탭을 여닫아도 status·diff-content 요청이 탭 수에 비례해 늘지 않는다 (NFR-EDD-2) |
| **V-EDD-15** | `Escape` 로 팝업이 닫히고, 찾기 패널이 떠 있으면 그쪽이 먼저 닫힌다 (FR-EDD-34) |
| **V-EDD-16** | 테마를 바꾸면 막대와 눈금의 색이 그 자리에서 따라온다 (FR-EDD-23b) |
