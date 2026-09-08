# 인계 노트 — 2026-09-08 접수 열 건 (묶음 A·B·C)

이 세션에서 **스펙 셋을 쓰고 그중 일부를 구현**했다. 다음 세션은 여기서 이어 간다.

- 스펙: [`UI_KIT_SRS`](./UI_KIT_SRS.md)(A) · [`PANEL_SURFACE_SRS`](./PANEL_SURFACE_SRS.md)(B) ·
  [`ALERT_MOBILE_CONTEXT_SRS`](./ALERT_MOBILE_CONTEXT_SRS.md)(C)
- 인터뷰로 확정한 결정은 각 문서의 **§2 사용자 결정**에 있다. 다시 묻지 않는다.

---

## 1. 접수한 요구와 지금 상태

| # | 요구 | 묶음 | 상태 |
|---|---|---|---|
| ① | agents 패널에 창별 그룹 · 그룹 안 드래그 | B | 미착수 |
| ② | 알림 시 가장자리 점멸 (0~10, 기본 5) | C | **완료** |
| ③ | 모바일: `⌨` 눌렀을 때만 키보드 · `⌨` 를 맨 왼쪽 · `^C` 추가 | C | 미착수 |
| ④ | 접힌 사이드바에서도 목록 보이기 | B | 미착수 |
| ⑤ | 아이콘이 작다 — 버튼을 꽉 채우게 | A | **진행 중** (표면 4/10) |
| ⑥ | 버튼·탭 등 중복 UI 공통화 (JS 팩토리까지) | A | **진행 중** (키트 완성, 이전 4/10) |
| ⑦ | Changes 에서 changes/untracked 통합 | B | 미착수 |
| ⑧ | 크기조절 핸들에 양쪽 크기 실시간 표시 | A | **팩토리만 완료** — 여섯 자리 배선이 남음 |
| ⑨ | History 검색 둘을 하나로 · 옵션은 드롭다운 | B | 미착수 |
| ⑩ | Run 의 context 표기 + 조정자 자신의 사용량 | C | 미착수 |

**작업 중 추가로 접수한 넷** (전부 완료):

| 접수한 말 | 한 일 |
|---|---|
| "설정창 팝업 크기가 탭에 따라 달라지는데 크기 고정하고… 스크롤" | `#modal` 을 580×`min(80vh,720px)` 로 고정, 스크롤은 `.modal-body` 하나 (FR-UIK-12·13) |
| "포커스안됐을때 효과 보색으로… 그냥 흰색같아서" | 반전에 `saturate(10)` 을 얹었다. 실측: 배경 h≈230° 에 대해 띠가 h55°·s41% |
| "모서리쪽 색상 겹치면서 보색의보색" → "한번에… 사각형으로" → "액자처럼 대각으로" → "색상이 안쪽으로 들어갈수록 흐려지는거지?" | 겹 하나 + 마스크 액자로 확정 (UNFOCUSED_EDGE_SRS **D-5e**). 기각한 두 안과 그 실측이 거기 적혀 있다 |
| "설정값이 바뀌었을 때 다른 브라우저창은 바로 갱신이 안된다" | `_settingsApply` 한 자리 + `settings_changed` SSE (ALERT_MOBILE_CONTEXT_SRS **FR-SYN-1~7**) |

---

## 2. 이 세션이 만든 것 (다음 세션이 딛고 설 자리)

### 2.1 공통 UI 키트

- `web/style-kit.css` — 크기 토큰(`--ui-btn-h` 26px 등) · `.ui-btn`(+`-icon/-sm/-lg/-primary/-danger/-ghost/-attn`) ·
  `.ui-tab` · `.ui-modal*` · `.ui-menu*` · `.ui-field/input/select/badge/hint` · `#ui-size-hud`.
  **`<link>` 는 `xterm.css` 뒤·`style.css` 앞**이다 (키트가 먼저 서고 기존이 덮는다).
- `web/js/ui/ui-kit.js` — `UIKit.icon/iconHTML/button/tab/modal/menu/field/drag/cellSize/cellFit`.
  로드 순서는 `repaint.js` 뒤·`sidebar-tabs.js` 앞.
- `index.html` 의 `#ui-sprite` — Lucide(MIT) 심볼 **32종**. 새 아이콘은 여기 한 줄이면 된다.

**규약 셋** (어기면 e2e 131개가 깨진다):
1. 기존 클래스를 **지우지 않는다.** `class="ui-btn ui-btn-icon tbtn"` 처럼 함께 붙인다.
2. 아이콘만 있는 버튼은 `title` 이 **필수**다 (`UIKit.button` 이 없으면 던진다).
3. 팩토리는 상태를 갖지 않는다 — `reconcileList` 가 요소를 재사용하기 때문이다.

### 2.2 가장자리 표시 둘이 모양을 공유한다

`#focus-edge`(포커스 잃음, 반전색)와 `#attn-edge`(알림, `--attn` 색 + 2초 맥박)가
**같은 마스크 규약**을 쓴다 — `--edge-fade`(64px) 하나가 둘의 액자를 정한다.
겹은 하나이고, 세기는 `opacity` 다.

> **함정 둘** (둘 다 실측으로 확인했다 — 다시 밟지 말 것)
> - 부모에 `opacity:<1` 을 두면 backdrop root 가 생겨 자식의 `backdrop-filter` 가 **바깥 화면을 보지 못한다.**
> - 같은 요소의 `clip-path` 는 `mask-image` 를 **무효로 만든다.**

### 2.3 설정이 상태가 됐다

`_settingsApply(saved)` 하나가 얹는 일을 전부 지고, 부팅·SSE·소프트 리로드가 같은 길을 지난다.
`STATE_REGISTRY` 에 `settings` 항목이 있다. **새 설정을 더하면 `_saveSettings` 의 키 목록과
`_settingsApply` 두 곳만 고치면 된다.**

---

## 3. 다음에 할 일 — 권장 순서

### 3.1 묶음 B (사용자 체감이 가장 큼, git 충돌 위험 해소됨)

1. **① agents 창 그룹** (`app-agents.js`) — `_agentsRender` 가 `_findToolLocation` 으로 창을 이미
   알고 있다. 그룹은 **파생**이며 `ws` 에 저장하지 않는다 (D-9). 순서는 `ws.agentsOrder` 그대로 두고
   창별로 거른다 (D-10). 카드의 `.ag-loc` 에서 창 이름을 빼고 머리로 올린다 (FR-AGG-13).
2. **⑦ changes/untracked 통합** (`constants-git.js`·`panel-changes.js`) — 서버 응답은 건드리지 않고
   화면에서만 합친다 (D-7). 그룹 키는 `working` 하나(D-8). **일괄 폐기는 확인창이 유일한 방어선**이므로
   그 경로 없이 실행되는 길이 없어야 한다 (FR-CMG-7).
3. **⑨ History 검색 통합** (`history.js`) — 입력 하나 + 옵션 드롭다운(`UIKit.menu`). 저장소 전체 확장은
   `--grep` 갈래만이다 (D-13). 리비전으로 해석되면 결과 맨 위에 한 줄 (D-12).
4. **④ 레일 목록** (`style.css` 의 `html.sb-collapsed` 절 + `SidebarList`) — 서술자를 그대로 쓰고
   레일 전용 데이터를 만들지 않는다 (D-11).

### 3.2 묶음 A 잔여

5. **⑧ 핸들 6종** — `UIKit.drag`·`_hud`·`cellSize`·`cellFit` 은 **이미 있다.** 여섯 자리
   (`#sb-handle` `input-binding.js:45`, `#agents-handle` `:15`, `.sh` `renderer.js:784`,
   `.slot-handle` `app-slots.js:575`, `.ed-ex-handle` `renderer.js:560`, `.git-commit-resize` `commit.js:85`)를
   옮기고 `sides()` 를 주면 된다. 표시는 px → (터미널이면) C×R → % 를 **세로로**.
6. **git 패널 아이콘** — 소비 지점이 일곱 줄뿐이다. 표는 `UI_KIT_SRS` §7.1.
7. 확인창·다이얼로그 · 편집기·탐색기 · Runs·Agents · 키바.

### 3.3 묶음 C 잔여

8. **③ 모바일 키보드** — `inputmode='none'` 을 `TerminalTool` 이 소유하고(D-10), `⌨` 가 유일한 해제
   손잡이다. 키보드가 내려가면 `visualViewport` 경로에서 되돌린다 (D-11). `^C` 는 `Ctrl` 옆, 즉시 `0x03`.
9. **⑩ Run 컨텍스트** — 서버가 조정자 관측을 버리는 자리는 `store_context.go:153`
   (`findByTool` 실패 → 폐기). Run 레코드에 조정자 필드를 두고(D-13), 등급 통지는 보내지 않는다(D-14).

---

## 4. 확인·검증 메모

- 회귀는 `npx playwright test` 다. 이 세션에서 `unfocused-edge.spec.ts` 를 **새 규약에 맞게 고쳤다**
  (세기가 곧 opacity · `backdrop-filter` · 마스크 5장). 그것은 회귀가 아니라 의도된 변경이다.
- 묶음 B 는 `git-changes`·`git-discard-all`·`git-history`·`git-dialog`·`activity`·`sidebar-collapse` 를
  **함께 고쳐야 한다** (PANEL_SURFACE_SRS §5).
- 화면을 눈으로 확인할 때는 **격리 인스턴스**를 쓴다:
  `DONGMINAL_HOME=<임시홈> ./dm start --port 58999`.
  **`dongminal stop` 과 `pkill -f dongminal` 은 쓰지 않는다** — 홈을 격리해도 사용자의 서버가 함께 죽는다
  (이 세션에서 실제로 죽였다). 띄운 PID 를 파일에 적어 두고 그것만 끈다.
