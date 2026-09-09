# SRS: 레이아웃 DOM 재조정 — 살아 있는 위젯을 움직이지 않는다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

TUI(claude code·pi agent 등)를 띄운 터미널에서 화면이 스스로 맨 위로 올라가고,
아무 키나 누르면 맨 아래로 되돌아오는 결함을 **근본 원인에서** 없앤다.

근본 원인은 스크롤 복원 코드의 계산 실수가 아니다. `render()` 가 레이아웃 DOM 을
매번 통째로 다시 짓고, 그 안에 사는 **살아 있는 위젯(xterm·편집기·Git 패널·Run
뷰)** 을 DOM 에서 옮기는 것이다. 스크롤 스냅샷/복원(`archive/PANE_SCROLL_PRESERVE_SRS.md`)
은 그 이동을 사후에 수습하려는 보정이며, 보정이 성립하려면 "그 사이 버퍼가
정지해 있다"는 전제가 필요하다. TUI 는 그 전제를 상시로 깬다.

이 문서는 보정을 정교하게 만드는 대신 **이동 자체를 없앤다**.

### 1.2 범위 (Scope)

- `web/js/ui/renderer.js` — `_rLayout` / `_rWindowInto` / `_buildNode` /
  `_buildPane` / `_buildSp` / `_mountTabBody` / `_handle`.
- 위 함수가 부르는 App 측 조회(`_mkTool`·`_gitPanel`·`_runViewEl`·`fileEditors`)
  의 **호출 규약**. 그 구현은 바꾸지 않는다.
- 신규·변경 e2e.

비포함:
- 서버·프로토콜·xterm 버전.
- `render()` 를 부르는 54곳의 호출 빈도 자체(줄이지 않는다 — 자주 불려도 무해한
  것이 이 작업의 목표다).
- 사이드바·토프바·모바일 순회(`_mPaneIdx`) 의 구조.
- Git 패널·편집기 **내부**의 DOM 관리(이미 자기 캐시를 갖는다).

### 1.3 정의 (Definitions)

- **라이브 위젯**: 자기 상태(스크롤백·ydisp·커서·미저장 내용·hover)를 DOM 노드에
  담고 있어 다시 만들면 그 상태를 잃는 요소. `.tp`(TerminalTool), FileEditor·
  DocRender, GitPanel `elFor`, Run 뷰가 이에 해당한다.
- **골격**: 라이브 위젯을 담는 레이아웃 요소 — `.slot` / `.sp` / `.sc` / `.pn` /
  `.pn-tabs` / `.pn-body`. 상태를 갖지 않으나, **이동하면 자식의 상태를 깬다.**
- **재조정(reconcile)**: 목표 상태와 현재 DOM 을 비교해 같은 자리의 같은 종류
  요소를 재사용하고, 다른 것만 만들거나 지우는 갱신 방식. 전면 재생성의 반대말.
- **bottom-follow**: `buffer.ydisp === buffer.ybase`. xterm 이 새 출력에 뷰포트를
  따라 올리는 유일한 조건이다.
- **viewportY**: `term.buffer.active.viewportY`(= ydisp). 뷰포트 최상단이 버퍼의
  몇 번째 줄인지.

### 1.4 참조 (References)

- `docs/internal/archive/PANE_SCROLL_PRESERVE_SRS.md` — 이 결함의 1·2·3차 패치와
  그 실패 이유. 본 문서가 그 FR-1~FR-4 를 대체한다.
- `docs/internal/WINDOW_SLOTS_SRS.md` — 슬롯 구조(`_rSlot`·`_slotKey`).
- `docs/internal/SLOT_VIEW_STATE_SRS.md` — 칸별 활성 탭(`paneTab`).
- `docs/internal/REPO_TAB_UNIFY_SRS.md` — 탭의 종류와 자격.
- `e2e/regression-pane-scroll.spec.ts` — 기존 회귀 검사.

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 `render()` 는 레이아웃 DOM 을 전면 재생성한다

`_rLayout`(renderer.js:212~) 의 순서는 이렇다.

1. 살아 있는 pane 을 `#area` 로 **대피**시킨다 (renderer.js:216-225).
2. `.sp`·`.pn`·`.ed-win`·`.slot`·`.slot-handle` 을 **전부 지운다**
   (renderer.js:227-230).
3. `_buildNode` → `_buildPane`/`_buildSp` 가 골격을 **처음부터 새로 만든다**
   (renderer.js:590-593, 662, 786).
4. `_mountTabBody` 가 대피시킨 위젯을 새 `.pn-body` 에 **다시 붙인다**
   (renderer.js:619-660).

즉 레이아웃이 하나도 바뀌지 않은 render 에서도 골격은 매번 새 객체다.

### 2.2 스크롤 스냅샷/복원은 그 이동을 수습하는 사후 보정이다

떼기 직전 `.xterm-viewport.scrollTop` 과 `viewportY` 를 갈무리하고
(renderer.js:222-223), 다음 프레임에 되돌린다 (renderer.js:329-348). 이것이
`archive/PANE_SCROLL_PRESERVE_SRS.md` FR-1~FR-4 다.

### 2.3 그 보정은 "버퍼가 정지해 있다"를 전제한다

갈무리는 **절대 위치**뿐이다. bottom-follow 였는지는 기록하지 않는다. 복원은
rAF 콜백이므로 최소 한 프레임 뒤에 실행된다. 그 사이에 출력이 들어오면:

```
캡처:  ydisp = ybase = N            (사용자는 맨 아래를 보고 있었다)
출력:  ybase = N+k
복원:  scrollToTop() → scrollToLine(N)
결과:  ydisp(N) ≠ ybase(N+k)  →  xterm 은 이후 출력을 따라가지 않는다
```

xterm v5 는 `ydisp===this.ybase` 일 때만 뷰포트를 따라 올린다(`web/vendor/xterm.js`
확인). 그래서 화면은 그 자리에 못 박히고, 출력이 쌓일수록 상대적으로 위로 밀린다.
키를 누르면 `scrollOnUserInput` 이 `scrollToBottom()` 을 불러 되돌아온다 — 사용자가
보고한 그대로다.

셸은 명령과 명령 사이에 출력이 멈춰 있어 이 어긋남이 드러나지 않았다. **TUI 는
항상 출력하므로 항상 어긋난다.** 이것이 "왜 TUI 에서만"의 답이다.

### 2.4 `target===0` 분기는 명시적으로 맨 위로 보낸다

```js
}else if(max>0){
  p.term.scrollToBottom();
  p.term.scrollToTop();      // renderer.js:337-339
}
```

TUI 가 화면을 지운 직후(스크롤백이 짧아진 순간)에 갈무리되면 `_viewportY===0`
이고, 그 뒤 버퍼가 다시 길어지면 이 분기가 즉시 맨 위로 보낸다.

### 2.5 픽셀 안전망이 xterm 의 올바른 복원을 덮는다

renderer.js:345-347 은 가드 없이 옛 `scrollTop` 픽셀을 대입한다. xterm 이
`_innerRefresh` 로 맨 아래를 권위 있게 세팅해도 이 한 줄이 다시 끌어내린다.

### 2.6 alt screen 을 구분하지 않는다

`buffer.active` 는 활성 버퍼다. 갈무리 때와 복원 때의 활성 버퍼가 다르면 라인
번호의 의미 자체가 달라진다. 판정이 없다.

### 2.7 `render()` 는 레이아웃과 무관한 사건에도 불린다

`this.render()` 호출 지점이 54곳이며, 그 밖에 SSE `workspace_changed`
(app-cmd.js:74 → `_onWorkspaceChanged`)가 **다른 브라우저·다른 에이전트의
`dmctl` 조작마다** 부른다. 레이아웃이 그대로여도 전면 재생성이 돈다.

### 2.8 "다시 만들지 않는다" 는 이 저장소의 기존 규약이다

- renderer.js:88 — *"FR-RPT-3: 목록을 비우고 다시 만들지 않는다."* 사이드바
  목록이 hover·더블클릭·드래그를 잃던 것을 재생성 중단으로 풀었다.
- app-attn.js:289 — *"탭/리전 강조도 타깃 토글 — 전체 render() 를 피해 포커스
  플리커(xterm blur/refocus)를 막는다."*
- renderer.js:646-648 — Run 뷰의 루트 DOM 을 탭마다 캐시한다. 이유가 같다:
  *"pane 을 다시 그려도 SVG 가 새로 만들어지지 않아야 hover 가 살아남는다."*

같은 결론에 세 번 도달했고, 터미널 pane 만 아직 닿지 않았다.

### 2.9 e2e 는 `.pn` 계층에 의존한다 — 위젯을 트리 밖으로 뺄 수 없다

`#area .pn.focused .pn-tab`, `#area .pn.focused .xterm-helper-textarea`,
`#area .pn .pn-tab` 같은 선택자가 attention·bg-kill-touch·attention-pulse 등
여러 spec 에 있다. 터미널을 절대배치 레이어로 분리하는 설계(L1')는 이 계약을
전부 깬다. **DOM 계층은 지금 모습 그대로 두어야 한다.**

### 2.10 핸들러는 클로저로 가변 컨텍스트를 잡는다 — 재사용의 최대 함정

`_buildPane` 은 `const slot=this._rSlot||0`(renderer.js:667)과 `n`·`tab` 을
클로저로 잡아 click·dblclick·dragstart·dragover·drop·mousedown 핸들러를 건다.
요소를 재사용하면서 핸들러를 다시 걸면 **중복 실행**이고, 다시 걸지 않으면
**낡은 컨텍스트**를 본다. 어느 쪽도 허용되지 않으므로 컨텍스트 전달 방식을
바꿔야 한다. 이것이 이 작업의 실질적 난이도다.

### 2.11 위젯의 이동이 완전히 사라지지는 않는다

같은 슬롯에서 창을 바꾸면 pane id 집합이 통째로 달라지고, 탭을 다른 pane 으로
끌면 그 위젯의 부모가 바뀐다. 이 경로들에서는 이동이 **의미상 불가피**하다.
재조정은 "바뀌지 않은 것을 건드리지 않는" 것이지 "무엇도 움직이지 않는" 것이
아니다.

### 2.12 다시 그리기가 DOM 을 새로 만드는 것에 기대는 코드가 있다

`_renameTab`(app-layout.js:67)은 탭 라벨을 input 으로 **교체**하고, 확정할 때
`render()` 를 부른다. 그 input 을 스스로 걷지 않는다 — 다시 그리기가 탭을 새로
만들어 없애 주기 때문이다.

재사용은 그 전제를 깬다. 라벨이 영영 돌아오지 않고, 그다음 갱신이 없는 요소를
만진다. e2e 세 건이 그 자리를 잡았다 — `V-TAN-5`, `V-TAN-6`,
`tab can be renamed via double-click`.

**이 계열은 탭 하나가 아니다.** "render 가 다시 만들어 준다" 는 이 저장소에서
오래된 전제이며, 재사용으로 옮겨 갈 때마다 그 전제에 기댄 코드를 하나씩 만나게
된다. FR-PDR-4a 는 그 만남의 일반형이다 — **밖에서 구조가 바뀐 요소는 재사용하지
않는다.**

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 재조정

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-PDR-1 | `_rLayout` 은 골격을 무조건 파괴하지 않는다. 같은 자리에 같은 종류의 노드가 다시 오면 기존 요소를 재사용한다. 파괴는 **사라진 노드**에만 적용한다 | 필수 |
| FR-PDR-2 | pane 은 `data-paneid` + 슬롯 번호로 식별한다. 같은 키가 같은 부모 자리에 오면 `.pn` 요소를 그대로 두고 (a) 클래스(`focused`·`attn`), (b) 탭 바, (c) 본문만 갱신한다 | 필수 |
| FR-PDR-3 | 활성 탭이 바뀌지 않았으면 `.pn-body` 의 자식을 **떼지도 다시 붙이지도 않는다.** 같은 부모에 `appendChild` 를 다시 부르는 것도 이동이며 금지한다 | 필수 |
| FR-PDR-4 | 탭 요소는 `data-tab-id` 로 매칭한다. 사라진 것만 제거하고, 새 것만 만들고, 남은 것은 라벨·`title`·클래스만 갱신한다. 순서가 바뀌면 요소를 **옮긴다**(다시 만들지 않는다) | 필수 |
| FR-PDR-4a | 밖에서 구조가 바뀐 탭은 재사용하지 않고 다시 만든다. 이름 변경은 라벨을 input 으로 **갈아 끼우고**(`_renameTab` 의 `el.replaceWith`) 확정 뒤의 다시 그리기가 그 자리를 되돌리는 것에 기댄다 — 재사용은 그 전제를 깬다 (§2.12) | 필수 |
| FR-PDR-5 | `.sp` 는 (부모 안 위치, `direction`, 자식 수)가 같으면 재사용하고 `sizes` 만 반영한다. 하나라도 다르면 그 서브트리만 다시 만든다 | 필수 |
| FR-PDR-6 | 슬롯 컨테이너(`.slot`·`.slot-handle`)는 인덱스로 재사용한다. 칸 수·방향이 바뀌면 그 차이분만 만들거나 지운다 | 필수 |
| FR-PDR-7 | 이벤트 핸들러는 **요소를 새로 만들 때 1회만** 건다. 재사용 경로에서 다시 걸지 않는다 | 필수 |
| FR-PDR-8 | 핸들러가 읽는 가변 컨텍스트(슬롯 번호, layout 노드, 탭 객체)는 클로저가 아니라 요소에 부착된 최신 컨텍스트에서 읽는다. 재조정은 요소를 재사용할 때마다 그 컨텍스트를 갱신한다 | 필수 |
| FR-PDR-9 | 이번 render 에서 어디에도 마운트되지 않은 라이브 위젯만 `.vis` 를 잃고 `#area` 로 물러난다. 마운트된 위젯은 대피 대상이 아니다 | 필수 |

### 3.2 묶음 B — 불가피한 이동의 처리

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-PDR-10 | 라이브 위젯이 **실제로 부모를 바꾼 경우에만** 스크롤 사후 처리를 한다. 재사용 경로에서는 어떤 스크롤 API 도 부르지 않는다 | 필수 |
| FR-PDR-11 | 사후 처리는 bottom-follow 를 먼저 본다. 이동 직전이 `viewportY >= baseY` 였으면 `scrollToBottom()` 만 하고 픽셀 대입은 하지 않는다. 아니면 종전대로 라인 기준으로 되돌리고 픽셀을 안전망으로 쓴다 | 필수 |
| FR-PDR-12 | 이동 직전의 활성 버퍼가 `alternate` 였거나 이동 후가 `alternate` 이면 사후 처리를 하지 않는다. alt 화면에는 되돌릴 스크롤이 없고, 대입은 해가 된다 | 필수 |

### 3.3 묶음 C — 제거

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-PDR-20 | `_rLayout` 의 무조건 갈무리(renderer.js:222-223)와 rAF 무조건 복원(renderer.js:329-348)을 제거한다. 남는 것은 FR-PDR-10~12 의 조건부 경로뿐이다 | 필수 |
| FR-PDR-21 | rAF 콜백의 나머지 책임(`open()`·`doFit()`·포커스·`_resendWindowSizes`)은 그대로 둔다. `doFit()` 은 크기가 실제로 바뀐 pane 에만 불러도 되나, 그 최적화는 이 작업의 비목표다 | 필수 |
| FR-PDR-22 | `archive/PANE_SCROLL_PRESERVE_SRS.md` 의 FR-1~FR-4 는 본 문서로 대체됨을 그 문서 머리에 적는다 | 필수 |

### 3.4 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-PDR-1 | 레이아웃이 바뀌지 않은 render 는 **골격 요소를 하나도 만들지 않아야** 한다(텍스트·클래스 갱신만). 살아 있는 위젯 안쪽은 이 요구의 대상이 아니다 — xterm 은 화면을 그릴 때마다 행을 새로 만들고 커서가 깜빡이는 것만으로도 노드가 오간다 (Windows CI 실측). 검증은 골격 클래스로 가려서 센다 |
| NFR-PDR-2 | 기존 e2e 가 의존하는 선택자 계층(`.pn` > `.pn-tabs`/`.pn-body` > 위젯)은 변하지 않는다 |
| NFR-PDR-3 | 재조정은 App 상태를 읽기만 한다. `_setFocus` 등 기존 부작용은 지금 있는 자리에 그대로 둔다 |

## 4. 설계 결정 (Design Decisions)

- **D-1. 보정을 정교하게 만들지 않고 이동을 없앤다.** 보정이 성립하려면 (a) 버퍼가
  정지해 있고 (b) detach 후 브라우저의 스크롤 이벤트 순서가 결정적이어야 한다.
  (a)는 TUI 에서 깨지고 (b)는 원래부터 없다(§2.3, archive SRS 의 (a)~(d) 네 경우).
  세 번의 패치가 실패한 이유가 전제에 있으므로 네 번째 패치가 아니라 전제를 바꾼다.
- **D-2. 위젯을 레이아웃 트리 밖으로 빼지 않는다.** 절대배치 레이어는 DOM 이동을
  0 으로 만들지만 §2.9 의 e2e 계약과 `inset:0` CSS 구조를 전부 깬다. 얻는 것보다
  잃는 것이 크다.
- **D-3. `.pn` 만 재사용해서는 안 된다.** `.sp`/`.sc`/`.slot` 이 다시 만들어지면
  `.pn` 은 새 부모로 `appendChild` 되고, 부모가 바뀌는 것만으로 브라우저는 스크롤을
  버린다. 재사용은 **뿌리부터** 이어져야 뜻이 있다. 그래서 FR-PDR-5·6 이 필수다.
- **D-4. 컨텍스트는 요소에 붙이고 핸들러는 그것을 읽는다.** 대안은 (i) 매번
  핸들러를 떼고 다시 걸기 — 재생성과 다를 바 없고 드래그 중이면 깨진다,
  (ii) 상위 위임 — 핸들러 수는 줄지만 `.pn-tab` 마다 다른 drag 상태를 다루기
  어렵다. 요소별 컨텍스트 부착이 변경 폭이 가장 작다.
- **D-5. split 노드는 위치로 매칭한다.** layout 의 split 에는 id 가 없고
  (`app-layout.js` 의 노드 생성부는 pane 에만 `id` 를 준다), `_buildSp` 가 붙이는
  `el._node` 는 SSE 로 워크스페이스를 다시 받으면 새 객체가 되어 identity 가 끊긴다.
  그래서 (위치, direction, 자식 수) 삼중 키를 쓴다. 셋 중 하나라도 다르면 그
  서브트리는 구조가 바뀐 것이므로 재생성이 옳다.
- **D-6. 이동이 남는 경로에서도 bottom-follow 를 먼저 본다.** FR-PDR-11 은 옛
  보정의 축소판이 아니라 **다른 규칙**이다. 절대 위치보다 "맨 아래에 붙어 있었다"가
  사용자의 의도에 가깝고, 그것이 참일 때는 값이 낡아도 결과가 옳다.

- **D-9. 쓰이지 않은 골격은 그 그리기에서 바로 거둔다.** 캐시를 오래 들고 있으면
  창을 오갈 때도 재사용이 되지만, 닫힌 창·지운 칸의 DOM 이 언제 사라지는지가
  흐려진다. 비활성 창의 pane 은 다음에 그려질 때 다시 서며, 그때의 이동은
  §2.11 이 인정한 경로이므로 FR-PDR-10~12 가 받는다. 캐시 수명을 늘리는 것은
  이 결함과 무관한 별개의 최적화다.

## 5. 검증 (Verification)

### 5.1 기존 e2e — 무변경 통과

`regression-pane-scroll.spec.ts`(세션 전환·탭 전환 후 스크롤 보존),
`terminal.spec.ts`, `attention.spec.ts`, `attention-pulse.spec.ts`,
`slot-view-state.spec.ts`, `bg-kill-touch.spec.ts`, git 계열 전부.

### 5.2 신규 e2e

| TC | 시나리오 | 기대 |
|----|---------|------|
| TC-PDR-1 | TUI 모사: `term.write` 로 출력을 흘리는 도중 `app.render()` 를 10회 부른다 | 매 회 후 `viewportY === baseY` (bottom-follow 유지) |
| TC-PDR-2 | 스크롤을 중간(예: `baseY-50`)으로 올린 뒤 출력 없이 `render()` | `viewportY` 불변, `.xterm-viewport.scrollTop` 불변 |
| TC-PDR-3 | 스크롤을 중간에 둔 채 출력을 흘리며 `render()` | `viewportY` 불변(따라 올라가지 않는다 — xterm 의 정상 동작) |
| TC-PDR-4 | render 전후 DOM identity | `.pn` 요소와 `.tp` 요소가 `===` 로 같은 노드 |
| TC-PDR-5 | 레이아웃 불변 render 시 노드 생성 0 (NFR-PDR-1) | MutationObserver 로 `childList` 추가 0건 |
| TC-PDR-6 | 탭 클릭 1회 | `switchTab` 1회만 호출(핸들러 중복 없음) |
| TC-PDR-7 | 탭 추가·삭제·순서 변경(드래그) | 남은 탭 요소는 같은 노드, 사라진 것만 제거 |
| TC-PDR-8 | 분할·분할 해제 | 영향받지 않은 pane 의 `.tp` 는 같은 노드이고 스크롤 불변 |
| TC-PDR-9 | 창 전환 후 복귀(위젯 이동이 실제로 일어나는 경로) | 떠날 때 맨 아래였으면 돌아와서도 맨 아래 |
| TC-PDR-10 | alt screen(`\x1b[?1049h`) 상태에서 render | 스크롤 API 미호출, 화면 불변 |
| TC-PDR-11 | 칸 추가·삭제(슬롯 변경) | 유지되는 칸의 pane 은 같은 노드 |
| TC-PDR-12 | 탭 이름 변경(더블클릭 → 확정) | 라벨이 돌아오고 새 이름이 보인다 (기존 e2e: V-TAN-5·6, tab.spec) |

### 5.3 수동 검증

TUI 를 띄운 탭에서 다른 브라우저 창의 `dmctl` 로 워크스페이스를 바꿔
`workspace_changed` 를 유발한다. 화면이 움직이지 않아야 한다.

## 6. 비목표 (Non-goals)

- `render()` 호출 횟수를 줄이는 것. 자주 불려도 무해하게 만드는 것이 목표다.
- 사이드바·토프바·상태바의 재조정.
- Git 패널·편집기 내부 DOM 관리.
- 모바일 pane 순회(`_mPaneIdx`) 구조 변경. 모바일도 재조정의 대상이지만 순회
  방식 자체는 그대로다.
- `doFit()` 호출 최적화.
- xterm 업그레이드.

## 7. 리스크 (Risks)

| ID | 리스크 | 등급 | 완화 |
|----|--------|------|------|
| R-PDR-1 | 핸들러 컨텍스트 전환(FR-PDR-8)이 누락된 자리가 남아 낡은 슬롯·탭을 본다 | HIGH | 클로저로 캡처하던 식별자를 전수 조사해 목록화하고, TC-PDR-6·11 로 슬롯·탭 오배치를 잡는다 |
| R-PDR-2 | 드래그 앤 드롭 중 재조정이 끼어들어 드래그 소스가 사라진다 | MEDIUM | 드래그 중 render 는 지금도 문제였다(FR-RPT-3 의 근거와 같다). 재사용은 오히려 이 위험을 줄인다. 드롭 계열 e2e 로 확인 |
| R-PDR-3 | 재사용 판정이 틀려 다른 pane 의 본문이 남는다 | HIGH | 키(paneid+slot)를 단일 함수에서만 만들고, TC-PDR-4·8·11 로 노드 동일성을 직접 잰다 |
| R-PDR-4 | `_rWindowInto`/`_rEditorWin` 의 조기 반환 경로(레이아웃 없는 창, 모바일 사이드)에서 재조정이 이전 DOM 을 남긴다 | MEDIUM | "이번 render 에서 마운트되지 않은 것은 물러난다"(FR-PDR-9)를 단일 회수 단계로 두고 그 자리에서만 판정 |
| R-PDR-5 | 변경 폭이 `_buildPane` 전체(핸들러 12개 이상)에 걸쳐 리뷰가 어렵다 | MEDIUM | 마일스톤을 나눈다: M1 골격 재조정(.slot/.sp/.sc) → M2 pane 재사용 + 컨텍스트 전환 → M3 탭 바 재조정 → M4 옛 복원 제거. 각 M 마다 e2e 전량 |
