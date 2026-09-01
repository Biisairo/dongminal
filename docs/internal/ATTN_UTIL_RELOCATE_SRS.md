# SRS: `app-attn.js` 의 공용 유틸을 제자리로 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`APP_STATE_EXTRACT_SRS` §7.4 가 남긴 관측 — **`app-attn.js` 가 알림과 무관한
공용 유틸을 정의하고 있다** — 를 해소한다.

이것은 `RunsPanel` 같은 **객체 추출이 아니다.** 옮기는 것들은 `App` 의 메서드로
그대로 남으므로 **위임 껍데기가 필요 없고**, 호출부도 한 줄도 바뀌지 않는다.
파일만 옮긴다.

문제의 형태는 `APP_STATE_EXTRACT_SRS` 와 반대다. 거기서는 "바깥이 많이 부른다" 가
추출 부적합의 증거였다. 여기서는 **알림과 무관한 세 파일이 부른다는 것이 그 메서드가
알림의 것이 아니라는 증거**다.

### 1.2 범위 (Scope)

| 이동 | 대상 | 도착 | 근거 |
|---|---|---|---|
| R1 | `_findToolLocation(toolId)` | `app-tool.js` | 도착지가 이미 `_isToolInActiveWindow(toolId)` — **같은 모양의 layout walk** — 를 들고 있다 |
| R2 | `_toolName(toolId,fallback)` | `app-tool.js` | `toolId → 표시 이름`. R1 에 의존하며, 부르는 셋 중 알림은 없다 |

**범위는 둘뿐이다.** `_jumpToTool` 은 옮기지 않는다 (§5 N1).

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **주제 혼재** | 어떤 요구사항 때문에 존재하는지와, 어느 파일에 사는지가 어긋난 상태 |
| **제자리로 돌려보내기** | 프로토타입 메서드를 다른 `app-*.js` 의 `Object.assign` 블록으로 옮기는 것. 런타임 `App` 은 바뀌지 않는다 |
| **공용임의 증거** | 서로 다른 주제의 파일 셋 이상이 부르고, 그중 정의 파일의 주제가 없는 것 |

### 1.4 참고 (References)

- `APP_STATE_EXTRACT_SRS.md` §7.4 — 이 SRS 를 요구한 관측
- `SPLIT_REFACTOR_SRS.md` §7.3 — 선행 주석이 경계에서 떨어지는 결함 (§2.3 에서 재발견)
- `web/js/core/app-tool.js` — 도착지. `_aw`·`_isToolInActiveWindow` 가 사는 자리

---

## 2. 전체 기술 (Overall Description)

### 2.1 무엇이 공용임을 말하는가 — 실측

`_findToolLocation` 을 부르는 곳 (정의 파일 제외):

| 부르는 곳 | 무엇을 하려고 |
|---|---|
| `app-cmd.js:437` | 서버 이벤트가 가리키는 도구의 창을 찾는다 |
| `app-agents.js:116` | 활동 카드가 살아 있는 pane 인지 판별한다 |
| `runs-panel.js:683` | Run 멤버를 클릭했을 때 갈 자리가 있는지 본다 |

`_toolName` 을 부르는 곳:

| 부르는 곳 | 무엇을 하려고 |
|---|---|
| `app-statusbar.js:219,258` | ⏻ 모달의 백그라운드 도구 이름 |
| `app-agents.js:128,162` | 활동 카드의 도구 이름 |
| `e2e/ux-revision.spec.ts:501` | 이름 규칙 검사 |

**여섯 자리 중 알림인 것은 하나도 없다.** `_toolName` 은 본문이 세 줄이고 그중
둘이 `helpers.js` 의 `toolDisplayName` 과 `_findToolLocation` 에 위임한다 — 알림의
상태를 하나도 만지지 않는다.

### 2.2 도착지가 `app-tool.js` 인 이유

`app-tool.js` 는 이미 **같은 모양의 layout walk 를 toolId 로 하고 있다**:

```js
// app-tool.js — 활성 창 안에 있는가
_isToolInActiveWindow(toolId){ … walk(s.layout) … }
// app-attn.js — 모든 창에서 어디 있는가
_findToolLocation(toolId){ … for(const s of this.ws.windows) walk(s.layout,s) … }
```

후자는 전자의 일반형이다. `app-layout.js` 의 `_findEditorTab(filePath)` 도 형태가
같지만 **키가 `filePath` 이고 `type==='editor'` 로 걸러** 에디터 주제에 속한다.
`toolId` 로 도구를 조회하는 자리는 `app-tool.js` 다.

### 2.3 함께 고치는 결함 하나 — 떨어진 선행 주석

현재 `app-attn.js:190`:

```js
  // 모든 창 layout 트리를 walk 해 toolId 를 가진 tab 위치 반환 (FR-PAN-16)
  /** FR-NAM-1: 도구 이름을 묻는 자리는 … */
  _toolName(toolId,fallback){
```

첫 줄은 **`_findToolLocation` 의 주석인데 `_toolName` 위에 놓여 있다.**
`SPLIT_REFACTOR_SRS` §7.3 이 기록한 부류의 결함이며, 이번 이동이 그 둘을 갈라놓기
때문에 **지금 고치지 않으면 주석이 남의 메서드에 붙어 남는다.** 주석은
`_findToolLocation` 을 따라간다.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항

**FR-AUR-1** `_findToolLocation` 과 `_toolName` 의 **본문을 한 글자도 바꾸지 않고**
`app-attn.js` 에서 `app-tool.js` 의 `Object.assign(App.prototype,{…})` 블록으로
옮긴다.

**FR-AUR-2** 메서드 이름을 바꾸지 않는다. `App.prototype` 의 메서드로 남으므로
**호출부는 한 줄도 바뀌지 않는다** — `this._toolName(…)`·`app._findToolLocation(…)`
가 그대로 해소된다.

**FR-AUR-3** 두 메서드는 `_toolName` → `_findToolLocation` 순서로, 서로 붙여
`app-tool.js` 의 `_isToolInActiveWindow` **뒤에** 놓는다. 조회 계열이 한자리에 모인다.

**FR-AUR-4** §2.3 의 떨어진 주석을 `_findToolLocation` 위로 되돌린다. 이것이
본문 밖에서 유일하게 허용되는 편집이다.

**FR-AUR-5** `app-attn.js` 에는 위임 껍데기를 **남기지 않는다.** `App` 이 여전히
그 메서드를 들고 있으므로 남길 것이 없다 — 이 이동이 `RunsPanel` 추출과 다른 점이다.

**FR-AUR-6** 자산이 바뀌었으므로 `web/index.html` 의 `?v=` 와 `web/assets.lock`
을 함께 올린다.

### 3.2 제약 (Constraints)

| # | 제약 |
|---|---|
| C-1 | `app-tool.js` 는 `index.html` 에서 `app-attn.js` **보다 먼저** 로드된다(287 vs 291). 둘 다 최상위에서 이 메서드를 부르지 않으므로 순서는 무관하지만, 순서가 바뀌어도 무관함을 이 제약으로 못박는다 |
| C-2 | e2e 스펙 수(927)는 변하지 않는다. 이 이동은 검사가 보는 표면을 바꾸지 않는다 |
| C-3 | `App.prototype` 의 메서드 이름 집합이 이동 전후로 **동일**해야 한다 |

---

## 4. 검증 (Verification)

| # | 검증 |
|---|---|
| TC-AUR-1 | `go build ./...`·`go vet ./...`·`go test ./...` 전량 통과 |
| TC-AUR-2 | 이동한 두 메서드의 본문이 `git show` 기준 **삭제줄 = 추가줄** 로 일치 (FR-AUR-1) |
| TC-AUR-3 | `App.prototype` 메서드 이름 집합이 이동 전후 동일 (C-3) |
| TC-AUR-4 | e2e 전량 통과, 개수 927 동일. 실패 1건은 단독 재실행으로 산발/회귀를 가른다 |
| TC-AUR-5 | `app-attn.js` 에 두 메서드의 **정의**가 남지 않는다. 호출(`this._findToolLocation` 2곳 · `this._toolName` 1곳)은 남는 것이 정상이다 — 이동은 정의 자리만 바꾼다 |

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| **N1** | `_jumpToTool` 을 옮기는 것 | **`APP_STATE_EXTRACT_SRS` §7.4 의 판단을 정정한다.** 재조사해 보면 이것은 공용 유틸이 **아니다** — 본문이 `_attnClear` 와 `_attnLand` 를 직접 부르고, 주석이 그 존재 이유로 **FR-ATA-6**("해제는 여기서 한다")·**FR-ATJ-1·2**(탭 없는 도구의 착지)를 든다. 알림 요구사항이 본문의 절반이다. 옮기면 FR 이 자기 파일에서 떨어진다. `_findToolLocation` 과 달리 **이동이 주제를 정리하지 않고 흩는다** |
| N2 | `_initAttn` 안의 `agents-poll` 설정 배선 | 알림이 아니라 에이전트 폴링 설정이다(`app-attn.js:406-413`). 그러나 이것은 **메서드가 아니라 메서드 안의 13줄**이라 옮기려면 `_initAttn` 을 쪼개야 하고, 그 편집은 "옮기기만 했다" 를 diff 로 증명할 수 없다. 별도 판단이 필요하다 |
| N3 | `_findEditorTab`·`_isToolInActiveWindow`·`_findToolLocation` 셋의 통합 | 세 layout walk 가 중복인 것은 맞지만 키(`filePath`/`toolId`)와 범위(활성 창/전체)가 다르다. 통합은 본문을 바꾸는 일이며 이 SRS 의 "옮기기만 한다" 와 양립하지 않는다 |
| N4 | `_toolName` 을 `helpers.js` 로 내리는 것 | `this._findToolLocation`·`this._fgNames` 에 의존한다. 순수 함수가 아니므로 `App` 의 메서드로 남아야 한다 |

---

## 6. 실행 결과 (Outcome)

### 6.1 이동

| | 전 | 후 |
|---|---|---|
| `app-attn.js` | 436줄 · 메서드 26 | **411줄 · 메서드 24** |
| `app-tool.js` | 169줄 · 메서드 13 | **194줄 · 메서드 15** |
| `App.prototype` 메서드 총수 | 328 | **328** |

`git diff` 는 **삭제 25줄 · 추가 25줄**이고 두 집합이 정렬하면 완전히 일치한다 —
본문이 한 글자도 바뀌지 않았다는 기계적 증명이다 (TC-AUR-2).

`app-attn.js` 에 남은 `_findToolLocation` 2곳·`_toolName` 1곳은 **호출**이다
(`_jumpToTool`·`_attnDesktopNotify`·`_attnCenterRender`). 알림이 공용 유틸을
쓰는 것은 옳고, 이제 **정의하지는 않는다.**

### 6.2 검증

| # | 결과 |
|---|---|
| TC-AUR-1 | `go build`·`go vet`·`go test ./...` **29개 패키지 전량 통과** |
| TC-AUR-2 | 삭제줄 집합 == 추가줄 집합 (25줄) **통과** |
| TC-AUR-3 | `App.prototype` 메서드 이름 328개, HEAD 와 **완전 동일** |
| TC-AUR-4 | e2e — §6.3 |
| TC-AUR-5 | `app-attn.js` 에 두 정의 **없음** |

자산이 바뀌었으므로 `index.html` 의 `?v=217→218`(69곳)과 `web/assets.lock` 을
함께 올렸다 (FR-AUR-6).

### 6.3 e2e

```
927 passed (12.8m)
```

**927개 전량 통과, 실패 0건**(TC-AUR-4 · C-2). 이 저장소가 927개 중 1개꼴로 겪는
산발 흔들림도 이번 실행에서는 나오지 않아 단독 재실행으로 가를 것이 없었다.

이동한 두 메서드는 `runs-panel.js`·`app-cmd.js`·`app-agents.js`·`app-statusbar.js`
와 e2e 두 스펙(`slot-view-state`·`ux-revision`)이 부르는데, **호출부를 한 줄도
고치지 않았고 전부 통과했다** — `App.prototype` 의 메서드로 남는다는 §1.1 의 전제가
실행으로 확인됐다.
