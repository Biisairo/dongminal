# SRS: Activity 접기 단추 방향 · 편집기 줄 이동 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요

### 1.1 목적

접수한 요청은 두 가지입니다.

1. "activity 에서 창 열고 닫는 버튼 방향이 오른쪽 고정임. 좌/우/모바일일때 확인하여 열고 닫는 버튼 변경"
2. "에디터에서 ctrl + g 로 줄 찾아가기 기능이 내장되어있으나 동작하지 않음. 검색 기능처럼 내장 끄고 기능으로 도입"

### 1.2 범위

**포함**
- Activity 머리의 접기/펼치기 단추(`.ag-collapse`) 아이콘이 패널 위치(좌/우)와 모바일 여부를 따른다.
- 편집기와 Diff 탭에 앱이 소유한 줄 이동 패널을 둔다. CodeMirror 내장 `gotoLine` 묶음은 뺀다.

**미포함**
- 줄 이동 중 실시간 미리보기 (Enter 로만 이동한다).
- 줄 이동 기록(이전 입력값 기억).

### 1.3 결정

| # | 질문 | 결정 | 근거 |
|---|---|---|---|
| D-1 | 모바일에서 접기 아이콘 | `chevron-up` | 모바일 패널은 화면 위에서 내려온다(`style.css` `body.mobile #agents-panel.open`). 닫으면 위로 사라진다 |
| D-2 | 줄 이동 기본 키 | `Ctrl+KeyG` (두 OS 공통) | VS Code 의 관용이다. 종전 내장 키와 같다 |
| D-3 | 입력 형식 | `줄` 또는 `줄:열` | VS Code 와 같다 |
| D-4 | 범위 밖 값 | 줄은 `1..마지막 줄`, 열은 그 줄의 `1..길이+1` 로 접는다 | CodeMirror 내장 `gotoLine` 과 같다 |
| D-5 | 찾기 패널과의 관계 | 한쪽을 열면 다른 쪽은 닫힌다 | 두 패널은 같은 자리(편집기 오른쪽 위)에 선다 |

## 2. 현재 상태 (코드 근거)

- `.ag-collapse` 아이콘은 `open?'chevron-right':'chevron-left'` 로 고정이다 (`web/js/core/app-agents.js` `_agHeadEl`). 머리의 다시 그리기 근거(`sig`)는 `open`/`rail` 뿐이다.
- 패널 위치는 `document.documentElement.dataset.agSide` 에 실린다 (`app-dock.js` `applyPanelDock`).
- 편집기 키맵의 `Ctrl-g` 는 `CM.gotoLine` 에 묶여 있다 (`web/js/ui/cm-setup.js` `edVscodeKeymap`). 이 명령은 CodeMirror 의 내장 대화창을 쓴다. 찾기는 이미 내장 위젯 대신 앱 패널(`ED_FIND_MIXIN`)을 쓴다 (EDITOR_FIND_PANEL_SRS FR-EFP-25).
- 내장 대화창이 동작하지 않은 원인: `FileEditor` 의 `focusin` 처리기(`file-editor.js` `_wireFocus`)는 `.fe-find` 밖의 포커스를 모두 편집기 본문으로 되돌린다. 대화창 입력 칸이 포커스를 받자마자 본문으로 빼앗겼다. 새 패널(`.fe-goto`)은 이 처리기의 예외에 든다.

## 3. 요구사항

### 3.1 Activity 접기 단추 (FR-ACB)

- **FR-ACB-1** 데스크톱에서 패널이 오른쪽에 있으면, 펼친 상태의 아이콘은 `chevron-right`, 레일 상태의 아이콘은 `chevron-left` 다.
- **FR-ACB-2** 데스크톱에서 패널이 왼쪽에 있으면, 펼친 상태의 아이콘은 `chevron-left`, 레일 상태의 아이콘은 `chevron-right` 다.
- **FR-ACB-3** 모바일에서 아이콘은 `chevron-up` 이다 (D-1).
- **FR-ACB-4** 아이콘은 순수 함수 `agCollapseIcon(open, side, mobile)` 하나가 정한다.
- **FR-ACB-5** 패널 위치가 바뀌거나 모바일 여부가 바뀌면 머리를 다시 그린다. 머리의 `sig` 는 FR-ACB-4 의 결과를 포함한다.

### 3.2 편집기 줄 이동 (FR-EGL)

- **FR-EGL-1** `edVscodeKeymap` 에서 `Ctrl-g` 묶음을 뺀다.
- **FR-EGL-2** 앱 단축키 `edGotoLine` 을 둔다. 기본값은 `Ctrl+KeyG` 다 (D-2). Settings ▸ Shortcuts 의 편집기 이동 그룹에 보이고 바꿀 수 있다.
- **FR-EGL-3** `edGotoLine` 은 `edFindInFile` 과 같은 게이트를 쓴다. 편집기가 없는 탭이나 Repo 창이 아닌 곳에서는 키를 삼키지 않는다.
- **FR-EGL-4** 키를 누르면 활성 편집기(또는 Diff 탭의 포커스 쪽)에 줄 이동 패널(`.fe-goto`)이 열리고 입력 칸에 포커스가 간다. 입력 칸의 안내문은 `줄[:열] (1–N)` 꼴이며 N 은 문서의 줄 수다.
- **FR-EGL-5** Enter 를 누르면 입력값을 해석한다. 해석은 순수 함수 `edGotoParse(text, lineCount)` 가 한다. 결과는 `{line, col}` 이고, 열이 없으면 `col` 은 `null` 이다. 해석할 수 없으면 `null` 이다.
- **FR-EGL-6** 해석 결과가 있으면 커서를 그 자리로 옮기고 화면 가운데로 스크롤한 뒤 패널을 닫고 편집기에 포커스를 준다. 열 값은 그 줄 범위로 접는다 (D-4).
- **FR-EGL-7** 해석할 수 없으면 패널을 닫지 않고 입력 칸을 오류 표시(`.bad`)로 바꾼다. 다시 입력하면 오류 표시가 사라진다.
- **FR-EGL-8** Esc 를 누르거나 닫기 단추를 누르면 패널이 닫히고 편집기에 포커스가 돌아간다.
- **FR-EGL-9** 패널 안에서 누른 키는 밖으로 전파되지 않는다 (FR-EFP-11 과 같은 규약).
- **FR-EGL-10** 줄 이동 패널을 열면 찾기 패널이 닫히고, 찾기 패널을 열면 줄 이동 패널이 닫힌다 (D-5).
- **FR-EGL-11** `edGotoParse` 규칙:
  - 앞뒤 공백은 무시한다.
  - `^\d+$` 또는 `^\d+:\d+$` 만 받는다. 그 밖(빈 값, 음수, 문자 등)은 `null` 이다.
  - 줄은 `1..lineCount` 로 접는다. `0` 은 `1` 이 된다.
  - 열은 `1` 이상으로 접는다. 줄 길이에 맞춘 접기는 엔진이 한다.

## 4. 검증

| TC | 대상 | 방법 |
|---|---|---|
| TC-ACB-1 | FR-ACB-1~3 | `agCollapseIcon` 단위 테스트 (6가지 조합) |
| TC-EGL-1 | FR-EGL-1 | `edVscodeKeymap` 에 `Ctrl-g` 가 없다 |
| TC-EGL-2 | FR-EGL-2 | `SHORTCUT_DEFAULTS.edGotoLine === 'Ctrl+KeyG'`, 라벨이 있다 |
| TC-EGL-3 | FR-EGL-11 | `edGotoParse` 정상·경계·실패 입력 |
| TC-EGL-4 | FR-EGL-4~8 | 브라우저에서 수동 확인 |

## 5. 동작 변경 기록

| 항목 | 이전 | 새 동작 | 이유 |
|---|---|---|---|
| Activity 접기 아이콘 | 위치와 무관하게 오른쪽 기준 | 좌/우/모바일에 맞춤 | 왼쪽 도킹·모바일에서 방향이 반대로 보였다 |
| `Ctrl+G` | CodeMirror 내장 `gotoLine` (동작하지 않음) | 앱 줄 이동 패널 | 찾기와 같은 방식으로 앱이 소유한다 |
