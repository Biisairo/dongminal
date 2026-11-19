# SRS: UI/UX 진단 반영 — UX_AUDIT_2026-11-19 의 항목 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 2묶음(밀도·위계) 이후. 이 판은 1묶음(빠른 효과) FR-UXF-1~12 만 담는다. V-LAY-1 의 linux·win32 기준선은 푸시 뒤 `layout-baseline` 워크플로(사용자 실행)

요구사항 식별자 접두어: `FR-UXF-`

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말:

> **"uiux 관련은 전부 진행"**

`UX_AUDIT_2026-11-19.md` 의 항목(D1~D20 · M1~M14 · X1~X9 · O1~O8)을 진단 문서 6절의 순서로 반영한다. 이 문서는 묶음마다
절을 더한다. 규모가 큰 O3(출력 미리 보기)·O5(명령 팔레트)는 각자 SRS 를 따로 쓴다.

### 1.2 범위 (Scope)

**포함(이 판):** 1묶음 — D1·D3·D8·D11·D14·M3·M7·M9·X5·X7·O4.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **진단** | `UX_AUDIT_2026-11-19.md`. 항목 번호(D·M·X·O)는 그 문서의 것이다 |
| **떠 있는 표면** | 문서 흐름 밖에 떠서 나타나는 표면 — 컨텍스트 메뉴(`.ui-menu`), 토스트(`.toast`), 모달 상자(`.ui-modal-box`·설정 `.modal`) |
| **입력 방식** | 마지막 사용자 입력이 포인터(마우스·터치)였는지 키보드였는지 |

### 1.4 참조 (References)

- `UX_AUDIT_2026-11-19.md` — 진단
- `PANEL_TEMPLATE_SRS.md`, `MOBILE_UX_OVERHAUL_SRS.md` — 패널·모바일 규약
- `ISSUE_TREE_OPS_SRS.md` FR-ITW-1~5 — 상단바·칸 머리글 제목
- `UI_LAYOUT_DEFAULTS_SRS.md` — 계산값 기준선 V-LAY-1

---

## 2. 전체 설명 (Overall Description)

### 2.1 사용자 결정 (2026-11-19)

| # | 결정 |
|---|---|
| D-1 | D3 상태바 기본 항목은 **기본값만** 바꾼다. 이미 저장된 사용자 값은 건드리지 않는다 |
| D-2 | M7 모바일 diff 는 **저장값이 없을 때만** 통합 보기로 시작한다. 나란히/통합 분할 단추는 남긴다 |

### 2.2 제약 (Constraints)

| # | 제약 |
|---|---|
| C-1 | 시간은 토큰(`--dur-fast` 등)만 쓴다(FR-TOK-47). 애니메이션은 `transform`·`opacity` 만 움직인다(FR-PRF-35) |
| C-2 | 움직임 줄이기(`prefers-reduced-motion`)는 전역 규칙이 멎게 한다 |
| C-3 | 포커스가 가는 **자리**는 바꾸지 않는다(접근성 규약 a11y-dialog). 바꾸는 것은 링을 그리는지뿐이다 |
| C-4 | 기존 id·클래스는 남긴다. 기존 e2e 단정을 바꾸면 이전/새 동작을 적는다 |

---

## 3. 요구사항 (Specific Requirements)

### 3.1 1묶음 — 빠른 효과

**FR-UXF-1 (D1)** — 상단바와 칸 머리글의 제목은 `창 이름 · 탭 이름` 이다. 사이드바 탭 라벨(`창`·`Repo` 등)은 앞에 붙이지 않는다.
창 이름이 비었으면 라벨을 이름 자리에 쓴다. 같은 말은 겹쳐 적지 않는다(종전 규칙).

> 이전 동작: `라벨 · 창 이름 · 탭 이름` (예: `창 · Window · Shell`).
> 새 동작: `Window · Shell`.
> 이유: 라벨은 사이드바 탭 이름이라 제목에서 정보가 없다 (진단 D1).

**FR-UXF-2 (D1)** — 제목의 구분점 `·` 은 흐린 글자(`.tt-sep`, `--text-hint`)로 그린다. `title` 속성은 전체 문자열 그대로다.

**FR-UXF-3 (D3)** — 상태바 항목의 **기본값**: 연결·cwd·인코딩만 켜짐이다. 위치(`location`)·지연(`latency`)·메모리(`memory`)는 기본
꺼짐이다. 저장된 값이 있으면 그것을 따른다 (D-1).

**FR-UXF-4 (D8)** — 포인터로 연 모달이 첫 요소에 포커스를 줄 때, 그리고 모달을 닫아 여는 단추로 포커스를 돌려줄 때 포커스 링을
그리지 않는다. 키보드로 열었거나, 그 뒤 키를 누르면 링은 종전대로 그린다. 포커스의 자리는 바뀌지 않는다 (C-3).

**FR-UXF-5 (D11)** — Changes 파일 행의 discard 단추(`[data-act="discard"]`)는 늘 위험색(`--danger-text`)이고, 앞 단추와
간격(`--ui-gap`)을 둔다. 흐림은 행 동작 공통의 투명도 규칙(FR-GIT-236)을 따른다 — 따로 낮추지 않는다.

**FR-UXF-6 (D14)** — 편집기 미리보기 단추(`.fe-render`)는 데스크톱에서도 편집기 오른쪽 아래에 선다(줄 번호와 겹치지 않는다).

**FR-UXF-7 (M3)** — 모바일 키바의 키보드 키(`data-act="kb"`)는 글자 `⌨` 대신 키보드 아이콘(`i-keyboard`)을 그린다. 켜짐
표식(`.sticky`)과 이름(`aria-label`)은 유지한다.

**FR-UXF-8 (M7)** — diff 보기 저장값(`gitDiffSideBySide`)이 없으면 모바일은 통합 보기로, 데스크톱은 나란히 보기로 시작한다.
저장값이 있으면 그것을 따른다 (D-2).

**FR-UXF-9 (M9)** — 미리보기 탭의 이름은 기울임꼴이 아니라 흐린 글자(`--text-muted`)다. 툴팁은 종전 문구(`editor.repo_preview_title`)다.

**FR-UXF-10 (X5)** — 앱 새로고침 단추(`#soft-reload-btn`)는 `rotate-ccw` 아이콘을 쓴다. `refresh-cw` 는 목록 새로고침(Activity·git)
에만 남는다.

**FR-UXF-11 (X7)** — 떠 있는 표면(컨텍스트 메뉴·토스트·모달 상자)은 나타날 때 같은 동작 하나를 쓴다: `--dur-fast` 동안 투명도
0→1 (`@keyframes ui-surface-in`). 위치는 움직이지 않는다.

> 진단의 제안(fade + 4px rise)에서 rise 를 뺐다. 이유: 메뉴를 화면 안으로 뒤집는 계산과 화면 덮기 판정이 나타나는 순간의 상자를
> 잰다 — transform 이 그 값을 4px 흔들었다(실측: 메뉴 아래 끝 721.4 > 720, 모바일 설정 top 2.76).

**FR-UXF-12 (O4)** — Activity 의 에이전트 구역에서 승인 대기(`waiting`) 카드는 그 창 그룹의 맨 위에 선다. 승인 대기 카드가 있는
창 그룹은 다른 그룹보다 위에 선다. 나머지 순서는 종전(`ws.agentsOrder`, `ws.windows`)이다. 저장된 순서는 바꾸지 않는다.

> 이전 동작: 순서는 끌어 놓은 순서(`agentsOrder`)와 창 순서뿐이었다.
> 새 동작: 승인 대기가 위로 온다. 대기가 풀리면 원래 자리로 간다.
> 이유: 사람이 손대야 하는 것이 가장 급하다 (진단 O4).

---

## 4. 검증 (Verification)

| TC | 요구 | 방법 |
|---|---|---|
| TC-UXF-1 | FR-UXF-1·2 | e2e(데스크톱): `#window-name` 의 글자가 `창 · ` 으로 시작하지 않고 `<창 이름> · <탭 이름>` 이다. `.tt-sep` 이 있다 |
| TC-UXF-2 | FR-UXF-3 | unit: `STATUS_ITEMS` 의 `location`·`latency`·`memory` 의 `def` 가 false, `connection`·`cwd`·`encoding` 은 true |
| TC-UXF-3 | FR-UXF-4 | e2e: ⚙ 를 마우스로 눌러 설정을 열면 포커스가 `#modal-close` 이고 outline 이 없다. `Esc` 로 닫으면 포커스가 `#settings-btn` 이고 outline 이 없다. `Tab` 을 누르면 outline 이 있다 |
| TC-UXF-4 | FR-UXF-5 | e2e: hover 없이 discard 단추의 색이 `--danger-text` 이고 앞 단추와 간격이 있다 |
| TC-UXF-5 | FR-UXF-6 | e2e(데스크톱): `.fe-render` 의 오른쪽 끝이 편집기 오른쪽 끝 가까이(< 40px) 있다 |
| TC-UXF-6 | FR-UXF-7 | e2e(모바일): kb 키 안에 `svg use[href="#i-keyboard"]` 가 있고 글자 `⌨` 가 없다 |
| TC-UXF-7 | FR-UXF-8 | e2e(모바일): 저장값 없이 diff 를 열면 통합 보기다. 데스크톱은 나란히다 |
| TC-UXF-8 | FR-UXF-9 | e2e: 미리보기 탭 이름의 `font-style` 이 normal 이다 |
| TC-UXF-9 | FR-UXF-10 | e2e: `#soft-reload-btn use` 의 href 가 `#i-rotate-ccw` 다 |
| TC-UXF-10 | FR-UXF-11 | e2e: `.ui-menu`·`.toast`·`.ui-modal-box` 의 `animation-name` 이 `ui-surface-in` 이다 |
| TC-UXF-11 | FR-UXF-12 | e2e: 같은 창의 카드 둘 중 뒤의 것을 `waiting` 으로 보고하면 그것이 앞에 선다. `done` 이면 원래 자리다 |
| 회귀 | C-3·C-4 | 관련 e2e(상단바 제목·대화상자 포커스·git 행·키바·Activity) 회귀 없음 |

---

## 5. 리스크

| 리스크 | 등급 | 대응 |
|---|---|---|
| 제목 단정을 가진 기존 e2e 가 라벨을 기대한다 | MEDIUM | FR-UXF-1 로 개정하고 이전/새 동작을 적는다 |
| 제목에 span 이 생겨 V-LAY-1 키가 늘어난다 | LOW | 데스크톱 DOM 변경 — darwin 기준선 다시 뜸, §9 기록 |
| 링 억제가 키보드 사용자의 링까지 지운다 | MEDIUM | 키를 누르면 억제 표식을 걷는다. TC-UXF-3 이 `Tab` 뒤 링을 본다 |
| O4 의 순서 바꿈이 끌어 놓기 재정렬과 부딪힌다 | LOW | 저장 순서는 그대로 두고 그릴 때만 옮긴다 |

## 6. 비목표 (Non-goals)

- 이미 저장된 상태바 설정을 옮기는 일 (D-1)
- 모바일에서 나란히 보기 단추를 감추는 일 (D-2)
- fetch·pull 단추의 라벨(진단 D12 — 뒤 묶음)
- 시트(모바일 서랍·Activity)의 미끄러짐 — 패널 템플릿이 정했다

## 7. 구현 위치

| 자리 | 내용 |
|---|---|
| `web/js/ui/renderer-chrome.js` | `_rWinTitle` 라벨 제외, 구분점 span (FR-UXF-1·2) |
| `web/js/core/settings-state.js` | `STATUS_ITEMS` 기본값 (FR-UXF-3) |
| `web/js/ui/ui-kit.js`, `web/style-kit.css` | 입력 방식 추적·링 억제 `.ui-focus-quiet` (FR-UXF-4), `ui-surface-in` (FR-UXF-11) |
| `web/style-git.css` | discard 단추 (FR-UXF-5) |
| `web/style-docrender.css` | `.fe-render` 자리 (FR-UXF-6) |
| `web/js/core/app-mobile.js` | kb 키 아이콘 (FR-UXF-7) |
| `web/js/git/panel-poll.js` | diff 보기 기본값 (FR-UXF-8) |
| `web/style.css` | 미리보기 탭 글자 (FR-UXF-9), 토스트·설정 모달 (FR-UXF-11) |
| `web/index.html` | `i-rotate-ccw` 심볼, `#soft-reload-btn` (FR-UXF-10) |
| `web/js/core/app-agents.js` | `_agWindowItems` 대기 우선 (FR-UXF-12) |
| `e2e/ux-audit-fix.spec.ts` (신규) | TC-UXF-1·3~11 |
