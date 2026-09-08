# 인계 노트 — 2026-09-08 접수 열 건 (묶음 A·B·C)

이 세션에서 **스펙 셋을 쓰고 그중 일부를 구현**했다. 다음 세션은 여기서 이어 간다.

- 스펙: [`UI_KIT_SRS`](./UI_KIT_SRS.md)(A) · [`PANEL_SURFACE_SRS`](./PANEL_SURFACE_SRS.md)(B) ·
  [`ALERT_MOBILE_CONTEXT_SRS`](./ALERT_MOBILE_CONTEXT_SRS.md)(C)
- 인터뷰로 확정한 결정은 각 문서의 **§2 사용자 결정**에 있다. 다시 묻지 않는다.

---

## 1. 접수한 요구와 지금 상태

| # | 요구 | 묶음 | 상태 |
|---|---|---|---|
| ① | agents 패널에 창별 그룹 · 그룹 안 드래그 | B | **완료** |
| ② | 알림 시 가장자리 점멸 (0~10, 기본 5) | C | **완료** |
| ③ | 모바일: `⌨` 눌렀을 때만 키보드 · `⌨` 를 맨 왼쪽 · `^C` 추가 | C | **완료** |
| ④ | 접힌 사이드바에서도 목록 보이기 | B | **완료** |
| ⑤ | 아이콘이 작다 — 버튼을 꽉 채우게 | A | **완료** (표면 10/10 — 키바는 근거를 두고 제외) |
| ⑥ | 버튼·탭 등 중복 UI 공통화 (JS 팩토리까지) | A | **완료** (키트 완성, 이전 10/10) |
| ⑦ | Changes 에서 changes/untracked 통합 | B | **완료** |
| ⑧ | 크기조절 핸들에 양쪽 크기 실시간 표시 | A | **완료** — 여섯 자리 전부 배선 |
| ⑨ | History 검색 둘을 하나로 · 옵션은 드롭다운 | B | **완료** |
| ⑩ | Run 의 context 표기 + 조정자 자신의 사용량 | C | **완료** |
| ⑪ | **폴링 주기를 설정에서 조절** (2026-09-08 접수) | — | **완료** ([`POLL_INTERVAL_SETTINGS_SRS`](./POLL_INTERVAL_SETTINGS_SRS.md)) |

**2026-09-08 후반에 추가로 접수한 다섯:**

| 접수한 말 | 한 일 |
|---|---|
| "git changes 에서 open file/stage/discard 버튼이 너무 많아서 못생겼다… 정렬이 안되었다… 좁아지면 버튼이 아래로 간다" → 인터뷰 답: **"hover 에서만 펼치고 아이콘만 남기고 테두리 제거, 열도 맞춰"** | 행·폴더의 동작을 **흐름 밖의 겹**으로 옮겼다 (`.git-file-acts{position:absolute;right:6px}`). 안 보일 때 이름이 폭을 다 쓰고(220px 에서 120→185px 실측), 보일 때는 오른쪽 오프셋이 같아 그룹 머리·파일·폴더의 열이 **구조로** 맞는다. 열은 `GIT_ACT_COLS` 셋이고 없는 자리는 `.git-act-gap` 이 메운다. 머리의 일괄은 같은 겹이되 **늘 보인다** |
| "git fetch, pull, push 아이콘이 너무 작다… 모든 버튼안에는 아이콘이 꽉 차야한다" | git 패널의 문자 라벨을 스프라이트 아이콘으로 옮겼다 (UI_KIT_SRS §7.1 의 표 그대로). `⤓↓↑`→`download`·`arrow-down`·`arrow-up`, `↗+−↺`→`external-link`·`plus`·`minus`·`undo`, `⟳`→`refresh-cw`, `⊟☰`→`folder`·`list`, `▾`→`chevron-down`. 크기는 버튼 높이에서 파생한다 (FR-GLY-5) |
| "diff 를 열면 상단에 불러오는중이 계속 깜빡인데 풀링으로 인한 문제로 보인다" | `GitDiffView.show()` 가 **매번** `_setNote(GIT_LOADING_HINT)` 를 세우고 있었고 `reloadDiff` 는 관측 회차마다 부른다 (FR-GLV-1). 그릴 것이 이미 서 있으면(`this._editor`) 조용히 받는다 |
| "여전히 git 이 실시간 업데이트가 되지 않음… 새로고침을 눌러서만 갱신이 됨" | 격리 인스턴스에서는 **재현되지 않았다** (아래 §4 참고). 조사 중 결함 둘을 찾아 고쳤다: ① `_onGitChanged` 가 방송의 경로와 패널의 경로를 문자열 그대로 견주어, 심볼릭 링크로 연 저장소는 방송을 한 건도 받지 못했다, ② 서버의 `obsMark` 에 `Conflicts` 가 빠져 있어 머지 중 충돌 파일의 변화가 방송되지 않았다 |
| "staged 에 들어간 파일이 수정되지 않았다면 원본/파일간의 diff 를, 수정되었다면 staged/수정된 결과물간의 diff 를" | 실측 결과 **이미 그렇게 동작한다.** 부분 스테이지 파일에서 STAGED 행은 `index↔HEAD`(`ko`→`ko,both`), CHANGES 행은 `worktree↔index`(`ko,both`→`ko,both,and more`) 다. 스테이지된 것이 없는 파일에서 index 가 HEAD 와 같아 "HEAD ↔ 작업본" 처럼 보이는 것은 비교 대상이 실제로 그것뿐이기 때문이다 |
| "새파일이든 수정파일이든 하는거야 … 실제 vsc 동작처럼" → "새 파일은 그냥 editor 로 열리는데 새 파일을 스테이징한 뒤 수정하고 diff 를 열면 diff 로 보이는거야. 다시 스테이징하거나 언스테이징하면 editor 로 열리고" | 가르는 규칙을 **그룹에서 항목으로** 옮겼다 (`_noBaseline`). 판정은 "그 행의 축에서 **왼쪽이 실재하는가**" 하나이며, 없는 자리는 둘뿐이다 — 워킹 그룹의 새 파일(index 에 없다)과 staged 그룹의 추가 `A`(HEAD 에 없다). 삭제는 없는 것이 **오른쪽**이므로 그대로 diff 다 |
| "conflicts 그룹은 컨플릭트 있을때만 나타나게 하자" | `GIT_GROUPS` 에 `hideEmpty` 를 두고 충돌에만 붙였다 (FR-CMG-1a) |

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

### 2.4 git 그룹은 **화면의 것**이고 출신은 **항목의 것**이다

`GIT_GROUPS` 는 화면이 보이는 묶음이고, 서버 응답의 배열 이름과 더는 1:1 이 아니다.
그 사상은 `GIT_GROUP_SRC` 한 자리에 있고 `gitGroupEntries(status,key)` 가 그것을 읽는다 —
그리는 쪽(`_paintGroup`)·대상을 모으는 쪽(`_group`)·다이얼로그 지문이 **같은 함수**를 지난다.

행이 무엇인지는 그룹이 아니라 **항목**이 말한다:

| 물음 | 판정 |
|---|---|
| 새 파일인가 | `e.untracked` (서버가 이미 싣는다) |
| 폐기가 삭제인가 | `i.untracked` — `_target()` 이 대상마다 싣는다 |
| 편집기로 열 것인가 | `_noBaseline(group,e)` — 그 축의 **왼쪽이 실재하는가** |

**그룹 이름으로 갈래를 만들지 않는다.** 워킹 그룹에는 두 출신이 함께 있으므로
`group==='untracked'` 류의 판정은 전부 거짓이 된다.

### 2.5 git 패널의 동작 버튼은 **흐름 밖의 겹**이다

`.git-file-acts` 는 `position:absolute;right:6px` 이고 hover·선택에서만 보인다.
열은 `GIT_ACT_COLS` 셋(열기·스테이지·폐기)이며 없는 자리는 `.git-act-gap` 이 메운다.
그룹 머리(`GIT_BULK_COLS`, 두 열)는 같은 오른쪽 오프셋을 쓰므로 **구조로** 정렬된다 —
오른쪽 정렬이라 앞 열이 몇 개든 뒤가 맞는다.

> **함정** — 165px 아래에서는 컨테이너 쿼리로 옛 규약(흐름 안 + 줄 늘리기)으로
> 되돌린다. `REPO_SIDE_W_MIN` 이 100px 이고 거기에는 30px 짜리 열 셋이 들어가지
> 않는다 (실측: 100px 에서 `discard` 의 오른쪽이 사이드보다 17px 밖). 되돌릴 때
> `.git-file-acts` 에 `flex:0 1 auto;min-width:0` 을 주어야 한다 — `flex:0 0 auto`
> 로는 묶음이 자기 자연폭을 고집해 줄을 넘겨도 여전히 넘친다.

### 2.3 설정이 상태가 됐다

`_settingsApply(saved)` 하나가 얹는 일을 전부 지고, 부팅·SSE·소프트 리로드가 같은 길을 지난다.
`STATE_REGISTRY` 에 `settings` 항목이 있다. **새 설정을 더하면 `_saveSettings` 의 키 목록과
`_settingsApply` 두 곳만 고치면 된다.**

`opts.boot` 는 "부팅에서만 해야 하는 일" 을 가르는 자리이며, ⑪ 이 그 첫 손님이다
(`agentsPollMs` 의 localStorage → 서버 이사). SSE 방송마다 로컬을 다시 보면 그 사이
다른 창에서 바꾼 값을 옛 로컬 값이 덮는다.

### 2.6 주기는 표 하나가 진다 (⑪ 이 만든 자리)

`web/js/core/app-polling.js` 의 **`POLL_SETTINGS`** 가 폴링 주기 다섯의 유일한 진실이다 —
설정 키 · 화면 id · 라벨 · 안내 문구 · 기본값 · 읽기/쓰기 · 선택지 · `0` 허용 여부가 한 행에 있다.
`Polling` 탭의 행도 이 배열에서 그려지므로 index.html 에 다섯을 손으로 적지 않는다.

**주기를 더할 때 고치는 자리는 두 곳이다**: 이 배열 한 행과 `_saveSettings` 의 키 목록.

> **함정 둘**
> - `const` 의 TDZ. `gitConsoleInterval` 은 `GIT_CON_POLL_MS`(`constants-git.js` 아래쪽)
>   **뒤**에 선언해야 한다 — 다른 주기 변수와 나란히 위쪽에 두면 로드가
>   `ReferenceError` 로 죽는다.
> - 도는 타이머에 닿는 길은 **`TIMERS.refreshChanged()` 하나**다. 핸들마다
>   `refresh()` 를 부르면 핸들에 닿을 수 있는 것에만 통한다 (git 콘솔의 타이머는
>   `observer → panels → panel._consoleView` 세 단 아래에 있다). 그 함수는 **주기가
>   실제로 바뀐 job 만** 다시 걸고 **발화하지 않는다** — 전부 다시 걸면 설정을 한 번
>   만질 때마다 모든 폴링의 다음 회차가 뒤로 밀리고, 발화하면 다른 창에서 바뀐 값의
>   SSE 하나가 열려 있는 창 전부에서 즉시 요청을 낸다.

`visiblePoll` 의 첫 인자는 이제 **값이거나 함수**다. 함수로 주면 주기가 설정을 읽는다.

---

## 3. 다음에 할 일 — 권장 순서

### 3.1 묶음 B (사용자 체감이 가장 큼, git 충돌 위험 해소됨)

> ①·⑦ 은 **끝났다.** 아래 1·2 는 무엇을 했는지의 기록이고, 남은 것은 3·4 다.

1. ~~**① agents 창 그룹**~~ (`app-agents.js`) — `_agentsRender` 가 `_findToolLocation` 으로 창을 이미
   알고 있다. 그룹은 **파생**이며 `ws` 에 저장하지 않는다 (D-9). 순서는 `ws.agentsOrder` 그대로 두고
   창별로 거른다 (D-10). 카드의 `.ag-loc` 에서 창 이름을 빼고 머리로 올린다 (FR-AGG-13).
2. ~~**⑦ changes/untracked 통합**~~ (`constants-git.js`·`panel-changes.js`) — 서버 응답은 건드리지 않고
   화면에서만 합친다 (D-7). 그룹 키는 `working` 하나(D-8). **일괄 폐기는 확인창이 유일한 방어선**이므로
   그 경로 없이 실행되는 길이 없어야 한다 (FR-CMG-7).
3. ~~**⑨ History 검색 통합**~~ (`history.js`) — 입력 하나 + 옵션 드롭다운(`UIKit.menu`). 저장소 전체 확장은
   `--grep` 갈래만이다 (D-13). 리비전으로 해석되면 결과 맨 위에 한 줄 (D-12).
   **구현이 밝힌 예외 하나**: 입력이 리비전으로 해석되면 `--grep` 확장을 **하지 않는다** —
   해시를 메시지 검색으로 보내면 0건이 돌아와 목록이 비고, 방금 뜬 리비전 줄이 가리키는
   커밋조차 사라져 누를 곳으로 갈 수 없게 된다 (PANEL_SURFACE_SRS §5.1).
4. ~~**④ 레일 목록**~~ (`style.css` 의 `html.sb-collapsed` 절 + `SidebarList`) — 서술자를
   그대로 쓰고 레일 전용 데이터를 만들지 않았다 (D-11). 앞 세션이 되돌리기 전에 확인한
   것 둘이 그대로 맞았고, 그 위에 셋을 더 알았다 — **PANEL_SURFACE_SRS §4.1** 에 적었다.
   요점: `title` 은 조건부일 수 없고, 재배치 차단의 판정은 `app._sbRail()` 한 자리이며
   (CSS 선택자 `html.sb-collapsed body:not(.mobile)` 와 같은 뜻이다 — 모바일을 함께
   빼야 FR-RAL-10 이 선다), 레일의 점 색은 `.active` 가 이미 accent 를 쓰고 `.attn` 이
   덮여서는 안 되므로 `has-badge:not(.attn)` 로 한정한다.
   e2e 는 `sidebar-collapse.spec.ts` 의 `묶음 RAL` 여덟이고, 같은 파일의 **SBC5 를
   함께 고쳤다** (`.sb-panel` 이 숨는다고 재던 자리 = 옛 FR-SBC-11).

### 3.1a ~~⑪ 폴링 주기 설정~~ (2026-09-08 접수 · **완료**)

> "polling 이 한쪽에 모여있잖아? setting 에서 이 값을 조절할 수 있도록."

스펙은 [`POLL_INTERVAL_SETTINGS_SRS`](./POLL_INTERVAL_SETTINGS_SRS.md) 다. 이 메모의
방향("값을 옮기는 것이 아니라 **그 선언이 설정을 읽게** 한다")이 그대로 D-4 가 됐고,
전파는 `_settingsApply` 한 자리를 지난다.

조사가 메모를 두 군데 넓혔다:

- **주기는 다섯이 아니라 여섯이었다.** 목록에 없던 것이 `GIT_CON_POLL_MS`(2초, git
  콘솔)이고, 상수라 설정 블롭에 자리조차 없었다.
- **여섯 중 하나는 켜지지 않는 계층이었다.** 브라우저 signature 폴링
  (`gitSignatureInterval`, 기본 0)이며 GIT_PUSH_OBSERVE 로 대체된 잔재다. 사용자 지시는
  "사용하지 않는 건 지우고 나머지 전부" 였고, 없이도 성립하는지 **먼저 확인했다** —
  `git-push-observe`+`git-polling`+`event-timer-hub-contract` 26건 전량 통과가 그 근거다
  (SRS §2.4). 그 뒤에 지웠다.

지금 상태: `Polling` 탭 하나에 다섯이 나란히 서고(흩어져 있던 둘도 그리로 옮겼다),
`agentsPollMs` 는 서버 설정으로 이사했다. **주기를 더할 때 고치는 자리는
`POLL_SETTINGS` 배열 한 행이다** — `_saveSettings` 의 키 목록만 함께 본다.

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

- **최종 회귀 (2026-09-08): 1320건 중 1316 통과.** 남은 넷 중 셋(`git-changes` C12 ·
  `git-history` H14 · `git-repaint` P8)은 단독 재실행으로 통과하는 플레이키이고,
  넷째(`repo-diff-edit` D5)는 위의 "상태 문자를 기다린다" 로 고쳤다.
- 회귀는 `npx playwright test` 다. 이 세션에서 `unfocused-edge.spec.ts` 를 **새 규약에 맞게 고쳤다**
  (세기가 곧 opacity · `backdrop-filter` · 마스크 5장). 그것은 회귀가 아니라 의도된 변경이다.
- 묶음 B 는 e2e **열여덟**을 함께 고쳤다 (§5 가 넷으로 봤던 것). 목록과 함정 둘은
  PANEL_SURFACE_SRS §5 에 적었다.
- **행 동작이 hover 규약이 되면서 e2e 의 습관이 하나 바뀌었다**: `.git-file-act` 를
  누르기 전에 그 행을 `hover()` 해야 한다. 겹이 `pointer-events:none` 이므로
  hover 없이는 클릭이 닿지 않는다 (`git-improve` V132·V133, `slot-view-state`
  TC-SVS-23 이 그 자리였다). 그리고 투명해지는 것은 **묶음**이므로 opacity 를 잴
  때는 `.git-file-acts` 를 봐야 한다 — opacity 는 상속되는 값이 아니라 자식의
  계산값은 1 로 남는다.
- **⑦ 이후 "행이 보인다" 는 상태 전환의 증거가 아니다.** 같은 파일이 상태가 바뀌어도
  같은 워킹 그룹에 그대로 있으므로, 스테이지 전후를 가르려면 **상태 문자**(`?`→`M`,
  `A`)를 기다려야 한다 (`repo-diff-edit` D5 가 그 자리였다).
- **스펙별 검사가 통과해도 전량이 잡는 것이 있다** (2026-09-08 실측). 이 세션의
  전량 회귀(1377건)가 여덟을 냈고, 그중 **다섯이 진짜 회귀**였다: 이름을 잃은
  자리를 고칠 때 같은 파일의 다른 검사를 놓친 것 둘(`_cadence` 를 딛는 T-5·B3),
  새 규칙이 검사의 전제를 깬 것 둘(`git-repo-missing` B1·B2 — 주기 범위 검사가
  검사용 1초를 기본값으로 되돌렸다), 표에서 뺀 키를 검사에 반영하지 않은 것 하나
  (`settings-backup`). 나머지 셋은 단독 재실행으로 통과했다.
  **가리는 순서**: 단독 재실행 → 실패하면 오류 문구를 읽는다. 셋 중 하나
  (`git-repaint` P8)는 **앞 세션이 hover 규약을 만들며 놓친 자리**였고 내
  변경과 무관했다 — 그런 것도 나오므로 `git log -- <파일>` 로 소유를 확인한다.
- **e2e 를 도는 중에 소스를 고치지 마라.** 브라우저가 파일을 디스크에서 읽으므로
  달리는 검사가 반쯤 바뀐 코드를 본다 — 이 세션에서 1321건 중 388건이 그렇게 깨졌고,
  그 결과는 회귀의 증거가 아니었다.
- 화면을 눈으로 확인할 때는 **격리 인스턴스**를 쓴다:
  `DONGMINAL_HOME=<임시홈> ./dm start --port 58999`.
  **`dongminal stop` 과 `pkill -f dongminal` 은 쓰지 않는다** — 홈을 격리해도 사용자의 서버가 함께 죽는다
  (이 세션에서 실제로 죽였다). 띄운 PID 를 파일에 적어 두고 그것만 끈다.
