# SRS: 컨텍스트 메뉴 한 벌 — `UIKit.menu` 위의 `GitMenu` 와 세 표면 (IEEE 29148)

> **문서 상태**: 승인·구현완료

- 접수: 2026-09-13 (로드맵 M7 `UX-26` "컨텍스트 메뉴 두 벌의 동작이 다름" ·
  `FUI-26` "`UIKit.menu` 가 비활성 항목의 사유를 보이지 않는다" · `FUI-08·12·17`
  "탭·빈 여백·터미널 본문에 컨텍스트 메뉴가 없다")
- 마일스톤: M7 — 디자인 시스템·UX. P2 묶음 하나.
- 짝: [UI_KIT_SRS](./UI_KIT_SRS.md) FR-UIK-8·26 (메뉴의 기본형) · 이 문서가 그
  요구를 **키 이동·비활성 사유**까지 넓힌다.

---

## 1. 개요

### 1.1 목적

메뉴가 두 벌이다. `UIKit.menu`(드롭다운·`open-url`·history 옵션)는 키보드 이동이
없고 비활성 사유를 보이지 않으며, `GitMenu`(git 뷰·탐색기 행)는 둘 다 갖되 자기
DOM·CSS 를 따로 그린다. 그리고 셋에는 메뉴가 아예 없다 — 분할 칸 **탭**, 탐색기의
**빈 여백**, 터미널 **본문**.

### 1.2 범위

**포함**
- `UIKit.menu` 가 `GitMenu` 가 하던 것을 갖는다: ↑↓ 이동(비활성 건너뜀) · Enter
  실행 · Esc · 바깥 클릭 · 스크롤·리사이즈에 닫힘 · 비활성의 **사유가 `title`** ·
  `cur` 표시 · `role=menu`/`menuitem`.
- `GitMenu.openList` 가 `UIKit.menu` 의 **얇은 어댑터**가 된다 — 항목 표를
  키트 항목으로 옮기고 확인 게이트(`_pick`)만 자기 것으로 남긴다.
- 메뉴 셋: 탭(FUI-08) · 탐색기 빈 여백(FUI-12) · 터미널 본문(FUI-17).

**비포함**
- 메뉴 항목의 **내용** 변경(git 항목 표 `GIT_MENUS`). 골격만 옮긴다.
- 하위 메뉴(서브메뉴). 지금 어느 메뉴도 쓰지 않는다.

## 2. 현재 상태

| | `UIKit.menu` | `GitMenu` |
|---|---|---|
| 키 이동 | 없음 | ↑↓ Enter, 비활성 건너뜀 (`.active`) |
| 비활성 사유 | `disabled:true` 만, 사유 없음 | `disabled(target)` 가 문자열 사유 → `title` |
| 닫힘 | Esc · 바깥 mousedown | Esc · 바깥 mousedown · 스크롤 · 리사이즈 |
| DOM | `.ui-menu` `.ui-menu-item` `.ui-menu-sep` | `.git-menu` `.git-menu-item` `.git-menu-sep` (e2e 27·25·1 파일이 짚는다) |
| CSS | `style-kit.css` | `style-git.css:679~691` — 같은 상자·항목 규칙 한 벌 더 |

메뉴가 없는 자리: `.pn-tab`(우클릭 = 브라우저 메뉴) · 탐색기 목록의 행 밖
(`_onCtx` 가 `.ed-row` 가 아니면 돌아간다) · `.tp-term`(xterm 본문).

## 3. 요구사항

| ID | 요구 | 등급 |
|---|---|---|
| FR-CMU-1 | `UIKit.menu` 항목의 `disabled` 는 **불리언 또는 문자열**이다. 문자열이면 비활성이고 그것이 `title` 이다 — 왜 못 누르는지 보이지 않으면 사용자는 고장으로 읽는다 (FUI-26). | 필수 |
| FR-CMU-2 | `UIKit.menu` 가 열리면 ↑↓ 가 활성 가능한 항목 사이를 돌고(`.active`, 비활성 건너뜀, 끝에서 감김), Enter 가 그 항목을 실행하고, Home/End 가 처음·끝이다. 처음에는 아무 항목도 활성이 아니다 — 첫 ↓ 가 첫 항목이다 (`GitMenu` N2 의 계약 그대로). | 필수 |
| FR-CMU-3 | 스크롤·리사이즈에도 닫힌다 — 좌표에 매인 팝오버는 그 좌표가 무효해지면 남아 있을 이유가 없다. | 필수 |
| FR-CMU-4 | 메뉴는 `role="menu"`, 항목은 `role="menuitem"`, 비활성은 `aria-disabled="true"` 다. 키 이동의 활성 항목이 포커스를 갖는다 — 스크린리더가 그것을 읽는다. | 필수 |
| FR-CMU-5 | `opts.cls`·`opts.itemCls`·`opts.sepCls` 로 옛 이름을 **함께** 붙일 수 있다 (D-5 병기). `GitMenu` 는 `git-menu`·`git-menu-item`·`git-menu-sep` 을 붙여 e2e 가 짚는 이름을 지킨다. `.cur`·`.disabled`·`.active` 도 그대로다. | 필수 |
| FR-CMU-6 | `GitMenu.openList` 는 항목 표를 키트 항목으로 옮기고 **`UIKit.menu` 를 부른다.** 확인 게이트 `_pick` 과 `primary`/`runPrimary` 는 그대로다. `GitMenu.close` 는 `UIKit.closeMenu` 다. 자기 DOM·키 리스너·`_cur` 는 사라진다. | 필수 |
| FR-CMU-7 | `style-git.css` 의 `.git-menu`·`.git-menu-item`·`.git-menu-sep` 외형 규칙은 사라진다 — 골격은 `.ui-menu` 다. 남는 것은 `.git-menu-item.cur`(지금 서 있는 자리, FR-GIT-282)뿐이다. | 필수 |
| FR-CMU-8 | **탭 메뉴** (FUI-08): `.pn-tab` 우클릭 → `새 탭` · `이름 변경` · `탭 닫기`. git 뷰 탭은 이름 변경이 비활성이고 사유가 보인다(FR-RTU-33). Editor·Git 창은 `새 탭` 이 비활성이다(FR-GIT-179·FR-EDT-54). 각 항목은 이미 있는 함수를 부른다 — `addTab`·`renameTab`·`closeTab`. **에이전트 탭**(`M8_UNIFIED_SRS` FR-AGT-10)은 `새 탭` 뒤에 `터미널로 열기` 하나가 더 있다 — 에이전트 탭 **만들기**는 여기 없고 `+` 우클릭 메뉴(FR-CMU-8a)에 있다. | 필수 |
| FR-CMU-8a | **`+` 메뉴** (`M8_UNIFIED_SRS` FR-AGT-1): 탭 바의 `+` 우클릭 → `새 탭` · 등록부의 에이전트마다 `에이전트 탭: <id>` (프로토콜 표면과 실행 파일이 있는 것만, `GET /api/agents`). 좌클릭은 종전대로 터미널 탭 하나다. | 필수 |
| FR-CMU-9 | **탐색기 빈 여백 메뉴** (FUI-12): 목록의 행 밖 우클릭 → `새 파일` · `새 폴더` · `업로드` · `폴더 업로드` · `붙여넣기`. 자리는 **루트**다. 행 메뉴의 같은 항목과 같은 함수를 부른다. | 필수 |
| FR-CMU-10 | **터미널 본문 메뉴** (FUI-17): `.tp-term` 우클릭 → `복사`(선택이 없으면 비활성, 사유) · `붙여넣기`(`navigator.clipboard.readText` 가 없으면 비활성, 사유) · `모두 선택` · `찾기` · `새 탭`. 복사는 `TermClipboard.write`, 붙여넣기는 `term.paste`, 찾기는 `toggleSearch` 다. | 필수 |
| FR-CMU-11 | 새 메뉴 셋도 `UIKit.menu` 다 — `GitMenu.openList` 를 거치지 않는다(확인 게이트가 필요한 항목이 없다). | 필수 |

## 4. 설계 결정

**D-CMU-1: 어댑터는 `GitMenu` 쪽이다.** 로드맵 DoD 의 문장이고, `UIKit.menu` 의
호출자가 셋(open-url · history 옵션 · 이 문서의 새 셋)인 데 비해 `GitMenu` 의
호출자는 git 뷰 전부 + 탐색기다. 많은 쪽이 얇은 어댑터를 지나 적은 쪽으로
간다 — 항목 표(`GIT_MENUS`)의 어휘(`run`·`disabled(target)`·`tip`·`cur`)는 그대로
두고 어댑터가 번역한다.

**D-CMU-2: 키 이동의 활성 항목이 포커스를 갖는다.** `GitMenu` 는 `.active`
클래스만 옮기고 포커스는 문서에 남겼다 — 스크린리더는 아무것도 듣지 못했다.
항목에 `tabindex=-1` 을 주고 이동할 때 `focus()` 한다. 닫으면 연 자리로 돌아간다
(`dialogOpen` 과 같은 규약).

**D-CMU-3: 터미널의 붙여넣기는 권한이 없으면 비활성이다 — 조용히 실패하지
않는다.** `readText` 는 secure context 와 권한을 요구한다. 없으면 항목이 사유를
들고 비활성이다; 있는데 거절되면 `Toast` 로 알린다.

## 5. 검증

| ID | 무엇 |
|---|---|
| TC-CMU-1 (`git-menu.spec.ts` N1~N3, 기존) | 어댑터 뒤에도 그대로 통과한다 — 이름·`.active`·`.disabled`+`title`·Esc·바깥 클릭 |
| TC-CMU-2 (e2e, `git-menu.spec.ts` 신규) | `UIKit.menu` 자체가 문자열 `disabled` 를 `title` 로 보이고 ↑↓ Enter 가 N2 와 같이 동작한다 — `GitMenu` 를 거치지 않고 |
| TC-CMU-3 (e2e, `tab-names.spec.ts` 또는 `tab-width`) | 탭 우클릭 → 메뉴 셋. `이름 변경` 이 `renameTab` 의 input 을 연다 |
| TC-CMU-4 (e2e, `editor-explorer.spec.ts`) | 빈 여백 우클릭 → 메뉴가 뜨고 `새 파일` 이 루트에 입력 행을 만든다 |
| TC-CMU-5 (e2e, `terminal.spec.ts`) | 터미널 우클릭 → 메뉴가 뜨고 선택이 없으면 `복사` 가 비활성이며 사유가 있다; `모두 선택` 뒤에는 활성이다 |
| TC-CMU-6 (자) | `node scripts/count-css-class-decls.mjs git-menu git-menu-item git-menu-sep` — `.git-menu-item` 의 `.cur` 한 규칙만 남는다 |

## 6. 비목표

1. 항목 표의 내용. 2. 서브메뉴. 3. 모바일 길게 누르기(터치 컨텍스트 메뉴) — 별개 항목.

## 7. 리스크

| 리스크 | 등급 | 완화 |
|---|---|---|
| `GitMenu` 의 호출자가 `_cur`·DOM 에 기대고 있다 | MEDIUM | grep 으로 확인: e2e 는 `GitMenu.open`·`primary`·`_pick` 만 부른다. `_cur` 는 e2e 가 짚지 않는다 |
| xterm 이 우클릭을 먹는다 | LOW | `contextmenu` 는 DOM 이벤트로 올라온다(`rightClickSelectsWord` 는 선택만 바꾼다). TC-CMU-5 가 실측 |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-13 | M8 P3. FR-CMU-8 에 에이전트 탭의 `터미널로 열기`(FR-AGT-10) 명시 · FR-CMU-8a `+` 우클릭 메뉴 신설(에이전트 탭 만들기). P3 첫 세션이 탭 메뉴에도 만들기를 넣었다가 전량 e2e TC-CMU-3 이 잡아 `+` 메뉴로만 두었다 |
| 2026-09-13 | 초안·구현. TC-CMU-2~6 GREEN, 기존 N1~N3 그대로 통과. `.git-menu*` 선언 18 → `.cur` 2 (+ `style-git-views.css` 의 히트 영역 하한은 도메인 규칙으로 남는다) |
