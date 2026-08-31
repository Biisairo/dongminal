# SRS: Changes 크기조정 · Diff 개요 눈금 · Editor 검색 — IEEE 29148

## 1. 개요

### 1.1 목적

접수한 말은 셋이다.

> **① "changes 에서 diff 와 파일리스트 패널 사이 크기조정"**
>
> **② "diff 에서 스크롤에 vscode 와 같이 스크롤크기에 맞는 diff 표시 추가
> (diff 색상위치 스크롤에 표시하며 이 표시는 실제 파일에 동기화)"**
>
> **③ "editor 에서 파일찾기, 전체 파일에서 내용찾기, 현재 파일에서 내용찾기
> (vscode 기준 cmd + p, cmd + f, cmd + shift + f) 추가"**

셋 다 **이미 있는 것을 쓸 수 있게 만드는** 일이다 — ①의 두 칸은 이미 나란히
서 있고(폭이 고정일 뿐), ②의 눈금은 Monaco 가 그릴 줄 알며(꺼 두었을 뿐),
③의 `cmd+f` 는 Monaco 에 이미 있다(나머지 둘이 없을 뿐).

### 1.2 범위

**포함**
- Changes 탭의 파일 목록 ↔ 미리보기 경계 드래그와 그 값의 보존
- Monaco diff 의 개요 눈금(overview ruler)과 접기(hideUnchangedRegions) 토글
- Editor 창의 파일 이름 찾기(`cmd+p`)와 저장소 전체 내용 찾기(`cmd+shift+f`)
- 위 둘을 위한 서버 종단 두 개

**미포함**
- 찾은 결과의 일괄 치환 (§6 비목표 #1)
- 터미널 탭의 검색 (이미 `SearchAddon` 이 있다 — §6 비목표 #2)
- Git Diff 탭 안에서의 검색 (§6 비목표 #3)

### 1.3 착수 전 확정된 결정

사용자 인터뷰(2026-08-30)로 굳혔다. 스펙보다 앞선다.

| # | 물음 | 답 |
|---|---|---|
| **I-1** | ②에서 접기(`hideUnchangedRegions`)를 유지하는가 | **토글로 두고 기본은 끈다.** "실제 파일에 동기화"를 문자 그대로 지킨다 |
| **I-2** | ③의 전체 검색 백엔드 | **ripgrep 우선, 없으면 Go 폴백** |
| **I-3** | ③의 검색 루트 | **현재 Editor 탭의 루트** |

---

## 2. 현재 상태 (코드에서 확인한 사실)

### 2.1 ① Changes 탭의 두 칸은 폭이 박혀 있다

`web/style.css`:

```css
.git-changes-body{flex:1 1 auto;min-height:0;display:flex}
.git-files{ flex:0 0 42%; min-width:180px; overflow-y:auto; border-right:1px solid var(--border) }
.git-preview{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}
```

`42%` 가 고정이고 경계에 손잡이가 없다. 모바일은 세로로 쌓는다:

```css
body.mobile .git-changes-body{flex-direction:column}
body.mobile .git-files{flex:1 1 50%;border-right:none;border-bottom:1px solid var(--border)}
```

**이미 있는 것**: 같은 모양의 손잡이가 저장소에 셋 있다 — `#sb-handle`(사이드바),
`.ed-ex-handle`(Editor 탐색기), `.sp>.sh`(분할). `.ed-ex-handle` 이 가장 가깝고
(`renderer.js` `_rEdHandle`), 그 구현이 이 작업의 본이다:

- `mousedown` 에서 시작 좌표와 시작 폭을 잡는다
- `mousemove` 는 **화면만** 바꾼다
- `mouseup` 한 번에 확정하고 저장한다

### 2.2 ② 개요 눈금은 꺼져 있다

`web/js/core/constants.js`:

```js
const GIT_DIFF_OPTIONS={
  renderSideBySide:true,
  hideUnchangedRegions:{enabled:true},
  ...
  renderOverviewRuler:false,          // ← 명시적으로 꺼져 있다
};
```

Git 의 diff 는 **Monaco DiffEditor** 다 (`GitDiffView`, `panel.js:2584`).
Monaco 의 overview ruler 는 문서 전체를 스크롤바 높이에 사상해 변경 위치를
색으로 찍는다 — 사용자가 말한 것과 정확히 같은 물건이고, 우리가 그릴 필요가 없다.

**충돌**: `hideUnchangedRegions` 가 켜져 있으면 변경 없는 구간이 접힌다. 접힌
문서의 눈금은 접힌 좌표계 위에 서므로 **실제 파일의 줄 위치와 어긋난다.**
I-1 이 이것을 "기본은 끄고 토글로 둔다"로 정했다.

**이미 있는 것**: Diff 탭 머리(`.git-diff-bar`)에 토글 둘이 이미 있다 —
`.git-diff-mode`(side-by-side/unified), `.git-diff-ws`(공백 무시). 저장은
localStorage 이며 "기기별 취향"이라는 근거가 §3.3 에 적혀 있다.

### 2.3 ③ 셋 중 하나만 있다

| 요구 | 현재 |
|---|---|
| `cmd+f` 현재 파일 내용 찾기 | **이미 된다.** Monaco 의 find 위젯이 기본으로 켜져 있고 `file-editor.js` 가 끄지 않는다 |
| `cmd+p` 파일 이름 찾기 | **없다.** 서버에 이름 검색 종단이 없다 |
| `cmd+shift+f` 전체 내용 찾기 | **없다.** 서버에 내용 검색 종단이 없다 |

**서버**: `/api/fs/*` 는 `list·create·rename·delete·download·upload` 뿐이다
(`handlers_api.go:138~145`). 재귀 이름 색인도, 내용 검색도 없다.

**루트 가드는 이미 있다** — `fsRoot(w, raw)` 가 Editor 목록에 등록된 루트만
통과시킨다 (`handlers_fs.go:119`). 새 종단 둘이 그대로 딛는다. I-3 이 검색
루트를 "현재 Editor 탭의 루트"로 정한 것과 맞물린다 — 가드를 새로 쓰지 않는다.

### 2.4 키 배분의 제약 — 전역 핸들러는 Monaco 안에서 돌지 않는다

`input-binding.js:67`:

```js
const ae=document.activeElement;
if(ae.tagName==='INPUT'||(ae.tagName==='TEXTAREA'&&!ae.classList.contains('xterm-helper-textarea')))return;
```

**정정 (2026-08-30, 실측).** 착수 시점의 판단은 "Monaco 의 입력 대상은
`textarea.inputarea` 이므로 위 게이트에 걸려 **편집 중에는 전역 단축키가 한 줄도
돌지 않는다**"였다. **틀렸다.**

Monaco 0.56 은 EditContext API 를 쓴다. 포커스를 받는 요소는 textarea 가 아니라
`div.native-edit-context` 다 (실측: `document.activeElement` → `DIV.native-edit-context`).
`tagName` 이 `DIV` 이므로 위 게이트는 **빠져나가지 않고**, 전역 단축키는
편집 중에도 그대로 돈다.

이것이 뜻하는 바는 둘이다:

- `cmd+p`·`cmd+shift+f` 는 전역 경로만으로도 편집 중에 뜬다.
- 그러나 그것은 **Monaco 판에 딸린 우연**이다. 판이 오르거나 EditContext 를
  지원하지 않는 브라우저로 물러서면 다시 textarea 가 되고, 그러면 전역 경로가
  죽는다.

그러므로 두 조합은 **두 자리에 배선한다** — 우연에 기대지 않기 위해서다:
1. Monaco 안 — `editor.addCommand` (기존 `cmd+s` 저장과 같은 방식)
2. Monaco 밖 — 전역 keydown (탐색기·탭바에 포커스가 있을 때)

전역 경로가 먼저 돌고 `stopImmediatePropagation` 하므로 두 경로가 겹쳐 패널이
두 번 열리지 않는다. 검증(V-EKB-1)은 **선택자를 박지 않는다** — 어느 요소가
입력을 받는지는 판마다 다르므로 `editor.focus()` 로 포커스를 주고 그것이
`.file-editor` 안에 있는지로 확인한다.

> **교훈**: 이 절의 최초 서술은 코드를 읽고 세운 추론이었고 실측이 아니었다.
> 그 추론 위에 "두 자리 배선"이라는 옳은 결론이 섰기 때문에 결과는 무사했지만,
> 근거는 틀려 있었다.

`cmd+p` 는 브라우저의 인쇄다. `_blockBrowserDefault` 가 이미 수식키 조합의 기본
동작을 막지만, 그것은 **어느 단축키에도 매칭되지 않은** 키에만 적용된다. 우리가
매칭시키면 그 자리에서 `preventDefault` 한다.

---

## 3. 요구사항

### 3.1 묶음 D — Changes 두 칸의 크기조정 (FR-CSZ)

**FR-CSZ-1** Changes 탭의 파일 목록과 미리보기 **사이에 손잡이**가 선다.
가로 배치에서는 `col-resize`, 세로 배치(모바일)에서는 `row-resize` 다.

**FR-CSZ-2** 드래그 중에는 **화면만** 바꾸고, 확정은 놓는 순간 한 번이다.
`.ed-ex-handle` 과 같은 규약이다 — 드래그마다 저장하면 워크스페이스 쓰기가
초당 수십 번 난다.

**FR-CSZ-3** 크기는 `GIT_FILES_SIZE_MIN` 과 `GIT_FILES_SIZE_MAX`(둘 다 본문
크기에 대한 비율) 사이로 제한한다. 어느 쪽도 0 이 되지 않는다 — 사라진 칸은
되돌릴 손잡이도 함께 잃는다.

**FR-CSZ-4** 값은 **기기별로** 보존한다(localStorage). Git 창은 워크스페이스의
엔터티가 아니고, 이 값은 `gitDiffSideBySide`·`gitFileView` 와 같은 성질의
화면 취향이다.

**FR-CSZ-5** 가로 값과 세로 값은 **따로** 보존한다. 한 값을 공유하면 데스크톱에서
정한 폭이 모바일의 높이가 된다.

**FR-CSZ-6** 저장된 값이 없거나 망가졌으면 현행 기본(42%)을 쓴다.

**FR-CSZ-7** 손잡이는 터치에서도 잡힌다 — 3px 요소에 손가락이 닿지 않는다.
`.ed-ex-handle::before` 와 같은 방식으로 히트 영역을 넓힌다.

### 3.2 묶음 O — Diff 개요 눈금 (FR-DOR)

**FR-DOR-1** Monaco diff 의 개요 눈금을 **켠다** (`renderOverviewRuler:true`).
직접 그리지 않는다 — Monaco 가 이미 문서 전체를 스크롤바에 사상한다.

**FR-DOR-2** 접기(`hideUnchangedRegions`)의 **기본값은 꺼짐**이다 (I-1).
그래야 눈금의 위치가 실제 파일의 줄 위치와 일치한다.

**FR-DOR-3** 접기는 Diff 탭 머리의 **토글**로 켤 수 있다. 자리와 생김새는
기존 `.git-diff-ws`(공백 무시)와 같은 규약이다.

**FR-DOR-4** 접기 상태는 기기별로 보존한다(localStorage) — `gitDiffSideBySide`·
`gitDiffIgnoreWs` 와 같은 규약이다.

**FR-DOR-5** 토글은 Diff 탭과 Changes 탭 **미리보기에 함께** 걸린다. 둘은 같은
`GitDiffView` 계약을 쓰므로 상태가 갈리면 사용자가 어느 쪽을 보는지 모른다
(`_setIgnoreWs` 가 이미 그렇게 한다).

**FR-DOR-6** 눈금의 색은 테마에서 온다. `monacoTheme()` 이 이미 `--git-st-add`·
`--git-st-del` 로 diff 색을 매핑하므로, 눈금의 색도 같은 자리에서 정한다 —
매핑하지 않으면 Monaco 의 기본 초록·빨강이 테마와 어긋난 채 남는다
(`file-editor.js` 의 주석이 같은 함정을 기록하고 있다).

### 3.3 묶음 F — 파일 이름 찾기 (FR-EQO)

**FR-EQO-1** `GET /api/fs/find?root=&q=&limit=` 는 루트 아래에서 이름이 `q` 에
맞는 파일의 **상대경로 목록**을 돌려준다.

**FR-EQO-2** 루트 가드는 `fsRoot` 다 (§2.3). 새로 쓰지 않는다.

**FR-EQO-3** 매칭은 **부분 문자열, 대소문자 무시**다. 경로 구분자를 포함한
질의(`src/app`)도 상대경로 전체에 대해 매칭한다.

**FR-EQO-4** 결과는 `limit`(기본 `FS_FIND_LIMIT`) 에서 끊고 `truncated` 를
함께 돌려준다. `fsListDir` 이 이미 그 규약이다.

**FR-EQO-5** 탐색은 `FS_SKIP_DIRS` 에 있는 디렉터리로 내려가지 않는다
(`.git`·`node_modules`·`dist` 등). 내려가면 대형 저장소에서 응답이 초 단위가
되고, 그 결과는 사용자가 찾는 것이 아니다.

**FR-EQO-6** 심링크를 따라가지 않는다. 순환이 있으면 탐색이 끝나지 않는다.

**FR-EQO-7** 클라이언트는 `cmd+p` 로 **빠른 열기**를 띄운다. 결과를 고르면 그
파일이 현재 Editor 창의 탭으로 열린다.

**FR-EQO-8** 빠른 열기는 `Escape` 로 닫히고, `↑`·`↓` 로 옮기고, `Enter` 로
연다.

### 3.4 묶음 G — 전체 내용 찾기 (FR-EGS)

**FR-EGS-1** `GET /api/fs/grep?root=&q=&limit=&case=&regex=` 는 루트 아래 파일의
내용에서 `q` 에 맞는 **줄**을 돌려준다. 각 결과는 상대경로·줄 번호·줄 내용과
그 줄 안의 매칭 구간이다.

**FR-EGS-2** 루트 가드는 `fsRoot` 다.

**FR-EGS-3** **ripgrep 이 PATH 에 있으면 그것을 쓴다.** 없으면 Go 구현으로
물러선다 (I-2). 어느 쪽을 썼는지는 응답에 싣는다 — 결과 차이(예: `.gitignore`
존중 여부)를 사용자가 설명할 수 있어야 한다.

**FR-EGS-4** 두 경로의 **결과 형태는 같다.** 부르는 쪽이 어느 구현인지 몰라도
되게 한다.

**FR-EGS-5** 이진 파일은 건너뛴다. `FS_GREP_MAX_BYTES` 를 넘는 파일도
건너뛴다 — 한 파일이 응답 전체를 잡아먹지 않게 한다.

**FR-EGS-6** 결과는 `limit`(기본 `FS_GREP_LIMIT`)에서 끊고 `truncated` 를
돌려준다.

**FR-EGS-7** 탐색 제외는 FR-EQO-5 와 **같은 목록**이다. 두 벌로 두면 한쪽만
바뀐다.

**FR-EGS-8** 외부 프로세스는 반드시 **컨텍스트로 취소 가능**해야 한다. 요청이
끊겼는데 ripgrep 이 대형 저장소를 계속 훑으면 그 자원은 아무도 회수하지 않는다.

**FR-EGS-9** 질의는 ripgrep 에 **인자로** 넘긴다. 셸을 거치지 않는다.

**FR-EGS-10** 클라이언트는 `cmd+shift+f` 로 검색 패널을 띄운다. 결과 줄을 고르면
그 파일이 **해당 줄로** 열린다.

### 3.5 묶음 V — 열 수 있는 것과 없는 것 (FR-EVW)

접수한 말은 둘이다 (2026-08-30 추가).

> **④ "파일 보기에서 열 수 없는 형식은 열 수 없다고 알리고 열지 않기(바이너리같은거)"**
>
> **⑤ "파일보기에 이미지 보기를 지원하자"**

현재 `FileEditor._fetchFile()` 은 `/api/file/read` 의 응답을 **무조건
`r.text()` 로 읽어** Monaco 에 넣는다. 이진 파일이면 대체 문자(U+FFFD)로 뒤덮인
화면이 뜨고, 그것을 저장하면 **원본이 파괴된다** — 알림이 없는 것보다 나쁘다.

**FR-EVW-1** 서버가 파일의 종류를 알린다 — `GET /api/file/probe?path=<abs>` 는
`{kind, mime, size}` 를 준다. `kind` 는 `text` · `image` · `binary` 셋이다.

**FR-EVW-2** 판정은 **내용이 우선**이다. 확장자는 근거가 아니다 — `.txt` 로
저장된 PNG 도, 확장자 없는 스크립트도 흔하다.

**FR-EVW-3** 편집기는 열기 전에 종류를 묻는다. `binary` 면 **열지 않고**
사유를 보인다. Monaco 를 세우지 않으므로 저장 경로 자체가 생기지 않는다.

**FR-EVW-4** `image` 면 이미지 뷰어로 연다. 원본 비율을 지키고, 칸보다 크면
줄여 맞춘다.

**FR-EVW-5** 이미지 바이트는 `GET /api/file/raw?path=<abs>` 가 준다.
**이미지 MIME 만 인라인으로 내보낸다** — 그 밖의 형식은 415 다.

> **근거**: 임의의 파일을 같은 출처에서 추론된 MIME 으로 인라인 제공하면
> 저장형 XSS 가 된다(HTML 하나면 족하다). 기존 종단 둘은 이 함정을 각자
> 피하고 있다 — `/api/file/read` 는 언제나 `text/plain`, `/api/download` 는
> `application/octet-stream` + attachment 다. 새 종단만 예외일 수 없다.

**FR-EVW-6** `/api/file/raw` 는 `X-Content-Type-Options: nosniff` 를 함께
보낸다. 브라우저가 우리가 정한 형식을 다시 추론하지 않게 한다.

**FR-EVW-7** 이미지·이진 탭에서는 저장이 동작하지 않는다. Monaco 가 없으므로
`save()` 는 그 자리에서 돌아간다 — 더티 표시도 서지 않는다.

**FR-EVW-8** probe 가 실패하면 **텍스트로 가정한다.** 종단이 없는 옛 서버에
붙은 새 브라우저에서 편집기가 통째로 서지 않는 것보다, 지금까지의 동작을
유지하는 편이 낫다.

### 3.6 묶음 K — 키 배분 (FR-EKB)

**FR-EKB-1** 편집기 검색의 키는 **Monaco 안팎 두 자리에** 배선한다 (§2.4).
편집 중에도 떠야 한다. 판정은 한 벌이다(`_edTrySearchKey`) — 두 벌로 두면
설정에서 바꾼 키가 한쪽에만 반영된다.

**FR-EKB-2** 이 조합들은 브라우저 기본 동작을 막는다 (`cmd+p` = 인쇄).

**FR-EKB-3** 파일 내 검색은 **패널을 만들지 않는다.** Monaco 의 find 위젯이
이미 그 자리에 있고, 우리가 만들 어떤 것도 그보다 낫지 않다 — 여는 키만 우리가
갖고(FR-EKB-5), 여는 일은 `actions.find` 에게 시킨다.

**FR-EKB-4** 이 키들은 **Editor 창이 활성일 때만** 동작한다. 터미널 창에서
`cmd+p` 를 눌러도 아무 일이 없다 — 그 자리에는 검색할 루트가 없다.

그리고 그때 키를 **삼키지 않는다.** 파일 내 검색의 기본값은 터미널 검색과 같은
조합이므로(둘 다 `Mod+F`), 삼키면 터미널 창에서 터미널 검색이 죽는다.

**FR-EKB-5** 세 검색은 **설정에서 바꿀 수 있는 단축키**다 — 파일 내에서 검색
(`edFindInFile`) · 파일 검색(`edQuickOpen`) · 파일 전체에서 검색(`edGrep`).
다른 앱 단축키와 같은 체계(`SHORTCUT_DEFAULTS` · `executeAction` · Settings ▸
Shortcuts)를 딛는다. 종전에는 조합이 코드에 박혀 있어 바꿀 수 없었다.

기본값은 `Mod+F` · `Mod+P` · `Mod+Shift+F` 다. `Mod` 는 Ctrl 과 Cmd 중 **그
호스트가 쓰는 쪽**을 뜻하는 수식자다 — 설정은 서버에 한 벌로 사는데 두 OS 의
관용이 다르므로, 기본값을 한쪽으로 적으면 다른 쪽의 관용을 버려야 한다. 사용자가
직접 녹음한 키에는 이 수식자가 없다 (`fmtShortcut` 은 실제 조합을 굳힌다).

**FR-EKB-6** 파일을 여는 모든 경로는 그 파일이 **탐색기에서 보이게** 한다 —
조상 폴더를 루트까지 펼치고, 아직 읽지 않은 겹은 읽고, 그 행을 선택으로 표시한다
(`FileTree.revealPath`).

검색이 방금 알려 준 경로를 사용자가 손으로 다시 펼치게 두지 않기 위해서다. 두
검색(파일·전체)이 그 요구의 출처이지만 배선은 `_edOpenFile` 한 자리에 둔다 —
부름터마다 걸면 git 변경파일·`dmctl open` 이 갈라진다.

---

## 4. 검증

| ID | 대상 | 방법 |
|---|---|---|
| **V-CSZ-1** | FR-CSZ-1·2 | 손잡이를 드래그하면 두 칸의 크기가 바뀐다 |
| **V-CSZ-2** | FR-CSZ-3 | 상한·하한을 넘겨 끌어도 그 범위에서 멈춘다 |
| **V-CSZ-3** | FR-CSZ-4 | 다시 열어도 값이 남는다 |
| **V-CSZ-4** | FR-CSZ-5 | 가로 값과 세로 값이 서로를 덮지 않는다 |
| **V-CSZ-5** | FR-CSZ-6 | 저장값이 망가져 있어도 기본값으로 선다 |
| **V-CSZ-6** | FR-CSZ-1 | 모바일(세로 배치)에서 손잡이가 **높이**를 바꾼다 |
| **V-CSZ-7** | FR-CSZ-5 | 세로 드래그가 가로 키를 건드리지 않는다 |
| **V-CSZ-8** | FR-CSZ-3 | 세로에서도 하한 아래로 내려가지 않는다 |
| **V-DOR-1** | FR-DOR-1 | Diff 에 개요 눈금 요소가 그려진다 |
| **V-DOR-2** | FR-DOR-2 | 접기 기본값이 꺼짐이다 |
| **V-DOR-3** | FR-DOR-3·4 | 토글이 상태를 바꾸고 다시 열어도 남는다 |
| **V-DOR-4** | FR-DOR-5 | Diff 탭과 Changes 미리보기의 상태가 같다 |
| **V-EQO-1** | FR-EQO-1·3 | 부분 문자열·대소문자 무시로 찾는다 |
| **V-EQO-2** | FR-EQO-2 | 등록되지 않은 루트는 `outside_root` 다 |
| **V-EQO-3** | FR-EQO-4 | 상한에서 끊고 `truncated` 를 준다 |
| **V-EQO-4** | FR-EQO-5 | 제외 디렉터리 아래의 파일이 결과에 없다 |
| **V-EQO-5** | FR-EQO-6 | 순환 심링크가 있어도 끝난다 |
| **V-EQO-6** | FR-EQO-7·8 | `cmd+p` → 고르기 → 탭이 열린다 |
| **V-EGS-1** | FR-EGS-1 | 경로·줄번호·줄내용·매칭구간이 온다 |
| **V-EGS-2** | FR-EGS-3·4 | ripgrep 과 Go 폴백의 결과 형태가 같다 |
| **V-EGS-3** | FR-EGS-5 | 이진 파일과 초대형 파일이 결과에 없다 |
| **V-EGS-4** | FR-EGS-8 | 컨텍스트를 끊으면 외부 프로세스가 끝난다 |
| **V-EGS-5** | FR-EGS-9 | 셸 메타문자가 든 질의가 그대로 검색어로 쓰인다 |
| **V-EGS-6** | FR-EGS-10 | 결과를 고르면 그 줄로 열린다 |
| **V-EKB-1** | FR-EKB-1 | Monaco 에 포커스가 있어도 두 조합이 뜬다 |
| **V-EKB-2** | FR-EKB-4 | 터미널 창에서는 뜨지 않는다 |
| **V-EKB-3** | FR-EKB-5 | `Mod` 기본값이 Ctrl 과 Meta 를 모두 받는다 |
| **V-EKB-4** | FR-EKB-5 | 설정에서 바꾼 키로 열리고, 옛 기본값은 듣지 않는다 |
| **V-EKB-5** | FR-EKB-4 | 터미널 창의 `Mod+F` 는 종전대로 터미널 검색이다 |
| **V-EKB-6** | FR-EKB-6 | 전체 검색·파일 검색으로 연 파일의 조상이 모두 펼쳐진다 |
| **V-EVW-1** | FR-EVW-1·2 | 확장자가 거짓인 파일도 내용으로 판정된다 |
| **V-EVW-2** | FR-EVW-3 | 이진 파일은 Monaco 가 서지 않고 사유가 보인다 |
| **V-EVW-3** | FR-EVW-4 | 이미지는 `<img>` 로 그려진다 |
| **V-EVW-4** | FR-EVW-5 | 비이미지에 `/api/file/raw` 는 415 다 |
| **V-EVW-5** | FR-EVW-5·6 | 이미지 응답의 MIME 과 `nosniff` 헤더 |
| **V-EVW-6** | FR-EVW-7 | 이진·이미지 탭의 저장이 아무 것도 쓰지 않는다 |
| **V-EVW-7** | FR-EVW-8 | probe 실패는 텍스트로 떨어진다 |

---

## 5. 설계 결정

**D-1 — 눈금을 직접 그리지 않는다.** Monaco 의 overview ruler 가 사용자가 말한
바로 그 물건이다. 직접 그리면 접기·줄바꿈·side-by-side 의 좌표계를 우리가 다시
계산해야 하고, 그것은 Monaco 가 이미 하는 일이다.

**D-2 — 접기를 끄되 없애지 않는다.** 접기는 대형 파일의 작은 변경을 볼 때
유용하다. I-1 이 정한 것은 "기본을 끈다"이지 "기능을 뺀다"가 아니다.

**D-3 — 검색 루트는 Editor 루트다.** `fsRoot` 가 이미 그 목록을 가드하므로
경로 이탈 방어를 새로 쓰지 않는다. 새 가드를 쓰는 것은 새 구멍을 여는 것이다.

**D-4 — ripgrep 은 인자로만 부른다.** 셸을 거치면 질의 문자열이 명령이 된다.
`exec.CommandContext` 에 인자 슬라이스로 넘긴다 (FR-EGS-9).

**D-5 — 제외 목록은 한 벌이다.** 이름 찾기와 내용 찾기가 같은 상수를 딛는다.
두 벌이면 한쪽만 바뀌고, 그 어긋남은 "왜 이 파일은 이름으로는 찾히는데 내용으로는
안 찾히는가"로 나타난다.

**D-6 — 크기는 기기별이다.** Git 창은 워크스페이스 엔터티가 아니고, 이 값은
화면 크기에 딸린 취향이다. 워크스페이스에 넣으면 데스크톱에서 정한 폭이 폰에
동기화된다.

**D-7 — `cmd+f` 를 가로채지 않는다.** Monaco 의 find 는 정규식·대소문자·단어
단위·선택 영역 한정을 모두 갖췄다. 우리가 만들 어떤 것도 그보다 낫지 않다.

---

## 6. 비목표

1. **일괄 치환.** 검색 결과 위에서의 replace-all 은 되돌리기 설계가 따로
   필요하다. 찾기가 서고 나서 별건으로 다룬다.
2. **터미널 탭 검색.** `SearchAddon` 이 이미 붙어 있고 `app-search.js` 가 그것을
   쓴다. 이 작업의 대상이 아니다.
3. **Git Diff 탭 안에서의 검색.** Monaco DiffEditor 의 find 는 두 모델에 걸쳐
   있어 별도의 결정이 필요하다.
4. **검색 색인.** 매 요청마다 훑는다. 대형 저장소의 지연은 ripgrep 이 흡수하고,
   그것으로 부족하다는 근거가 나오면 그때 색인을 논한다.

---

## 7. 추적성

| 요구 | 코드 |
|---|---|
| FR-CSZ-1~7 | `web/js/git/panel.js`, `web/style.css`, `web/js/core/constants.js` |
| FR-DOR-1~6 | `web/js/core/constants.js`, `web/js/git/panel.js` |
| FR-EQO-1~6 · FR-EGS-1~9 | `internal/webserver/httpapi/handlers_fs_search.go`, `handlers_api.go` |
| FR-EQO-7·8 · FR-EGS-10 · FR-EKB-1~4 | `web/js/ui/file-editor.js`, `web/js/core/app-editor.js` |
| FR-EKB-5 | `web/js/core/helpers.js`(`Mod`·기본값), `web/js/core/app-edsearch.js`(`_edTrySearchKey`), `web/js/core/app-settings.js`(목록) |
| FR-EKB-6 | `web/js/ui/file-tree.js`(`revealPath`), `web/js/core/app-editor.js`(`_edOpenFile`) |
