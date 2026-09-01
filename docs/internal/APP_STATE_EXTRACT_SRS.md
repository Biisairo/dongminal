# SRS: App 의 상태를 소유자에게 돌려준다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`SPLIT_REFACTOR_SRS` 가 `App` 을 `app-*.js` 로 가른 것은 **파일**이었다. 런타임의
`App` 은 여전히 필드 107개를 든 한 객체다.

근본 문제는 `App` 이 크다는 것이 아니라 — **한 파일에서만 쓰이는 상태가 모두의
것인 자리에 놓여 있어서, 그 상태를 누가 소유하는지 코드가 말하지 않는다는 것**이다.

측정된 증거:

| | `GitPanel` | **`App`** |
|---|---|---|
| 서로 다른 인스턴스 필드 | 44 | **107** |
| **한 파일에서만 쓰이는 필드** | 14 | **60 (56%)** |
| 셋 이상이 공유하는 필드 | 대부분 | `ws`(14) · `focused`(12) · `tools`(11) **정도** |

`GitPanel` 은 주제 그룹끼리 필드를 10~21개씩 공유해서 **떼면 참조만 늘어난다**.
`App` 은 반대다 — 절반 이상이 자기 파일 안에서만 산다.

**이 저장소는 이 일을 이미 두 번 했다.** `GitObserver`(앱에 하나인 관측)와
`FileTreeStore`(루트마다 하나인 관측)가 그것이고, 둘 다 `constructor(app)` 으로
앱을 받는다. 관행이 서 있는데 `App` 의 나머지가 따르지 않았다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **A** | `RunsPanel` 추출 — `app-runs.js` 의 상태 11개와 메서드 33개 | **MEDIUM** |

**묶음 A 만 이 SRS 의 범위다.** `SoftReload`·`AttentionNotifier`·`EditorRegistry`
는 A 가 절차를 검증한 뒤 별도 SRS 로 다룬다 (§5 N1).

`RunsPanel` 을 먼저 고른 이유는 **가장 독립적**이기 때문이다 — 공유 필드 접촉이
`this.ws` 2회, `this.focused` 1회뿐이다.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **소유** | 그 상태를 읽고 쓰는 코드가 사는 자리. 지금은 `App` 이 들고 `app-runs.js` 만 만진다 |
| **위임 껍데기** | `App` 에 남는 한 줄짜리 메서드. 바깥 호출자가 이름을 그대로 쓰도록 유지한다 |
| **메서드 테이블 의존** | 검사가 `app.<메서드>` 를 **갈아 끼워** 내부 호출을 관찰하는 것. 위임 껍데기로는 유지되지 않는다 (§2.2) |

### 1.4 참고 (References)

- `web/js/git/observer.js`·`web/js/ui/file-tree-store.js` — 같은 패턴의 선례
- `docs/internal/SLOT_VIEW_STATE_SRS.md` — 관측 하나 / 뷰 여럿의 원본
- `docs/internal/SPLIT_REFACTOR_SRS.md` — 파일을 가른 앞 단계

---

## 2. 전체 기술 (Overall Description)

### 2.1 무엇이 옮겨지고 무엇이 남는가

`app-runs.js` 의 상태 11개는 **전부 이 파일 안에서만** 쓰인다 (실측):

```
_runsList _runsErr _runsPending _runsModalOpen _runsModalKey
_runsConfirm _runsDelErr _runDefsSeq _runViews _runViewMap …
```

바깥이 부르는 메서드는 **여섯**이고, 그 이름은 바뀌지 않는다:

| 메서드 | 부르는 곳 |
|---|---|
| `_runsModalToggle` | `app.js` |
| `_findRunTab` | `app-layout.js` |
| `_runViewEl` | `renderer.js` |
| `_runDisposeView` | `app-slots.js` |
| `_onRunChanged` | `app-cmd.js` · **e2e 2개** |
| `_runPaint` | **e2e 1개** |

### 2.2 위임 껍데기로 해결되지 않는 자리 하나

`slot-run-view.spec.ts` 는 `App` 의 **메서드 테이블에 의존한다**:

```js
const orig = app._runPaint.bind(app);
app._runPaint = (v) => { seen.push(String(v.tabId)); return orig(v) };  // 갈아 끼운다
app._onRunChanged({ runId: rid });                                      // 내부 호출을 관찰
```

`_onRunChanged` 가 `RunsPanel` 안에서 `this.paint()` 를 부르면 이 갈아 끼우기는
**아무것도 잡지 못한다.** 위임 껍데기는 바깥 호출자를 지키지만, 안쪽 호출을
관찰하던 검사는 지키지 못한다.

그래서 이 검사 하나는 **함께 고친다** — `app.runs.paint` 를 갈아 끼우도록. **재는
것은 바뀌지 않는다**: "Run 이 바뀌면 그것을 보는 뷰 전부가 다시 그려지는가".

### 2.3 바깥이 붙잡는 것은 메서드만이 아니다

**조사가 두 번 모자랐다.** 처음에는 "바깥이 부르는 메서드" 만 셌는데, 실제로 바깥은
**상태 필드에도 직접 손을 뻗고 있었다.**

| 놓친 자리 | 형태 | 어떻게 드러났나 |
|---|---|---|
| `slot-run-view.spec.ts:81` | `app._runViews` 를 읽어 키를 센다 | Run e2e 2건 실패 |
| `app-slots.js:503` | `this._runViews` 를 **순회하며 지운다** | 칸 회수 e2e 1건 실패 |

두 번째가 특히 중요하다. `app-slots.js` 는 `App` 의 메서드 안에 있으므로 `app.` 이
아니라 `this._runViews` 로 접근한다 — `app\._run` 으로 찾으면 걸리지 않는다.

**그래서 추출 대상을 정할 때 세 가지를 모두 세어야 한다**: 바깥이 부르는 메서드,
바깥이 읽는 필드, 그리고 **같은 `this` 를 공유하는 형제 파일이 만지는 필드**.
마지막 것이 프로토타입 증강 분할의 함정이다 — 파일은 갈렸어도 `this` 는 하나다.

### 2.4 제약 (Constraints)

| # | 제약 | 출처 |
|---|---|---|
| C-1 | 외부 관측 동작(UI·HTTP·CLI) 불변 | 사용자 지시 |
| C-2 | Go 테스트와 e2e 가 **전량 통과**하고 **개수가 같다** | 사용자 지시 |
| C-3 | 바깥 호출자 6개의 이름은 유지한다 (위임 껍데기) | §2.1 |
| C-4 | 새 파일은 `js/*/*.js` 2레벨을 지킨다. `?v=` 와 `assets.lock` 을 올린다 | `web/embed.go`·`version_test.go` |
| C-5 | `index.html` 로드 순서 — `RunsPanel` 정의가 `app-runs.js` 보다 앞 | 번들러 없음 |

---

## 3. 상세 요구사항 (Specific Requirements)

**FR-ASE-1** `web/js/ui/runs-panel.js` 에 `class RunsPanel` 을 둔다. `constructor(app)`
로 앱을 받는다 — `GitObserver`·`FileTreeStore` 와 같은 형태다.

**본문은 `Object.assign(RunsPanel.prototype, { … })` 로 얹는다.** 원본이 이미
`Object.assign(App.prototype, { … })` 의 객체 리터럴이므로, 받는 쪽을 같은 모양으로
두면 **메서드 끝의 쉼표까지 그대로**다 — 클래스 본문에 넣으면 33개 메서드에서
쉼표를 떼야 하고, 그 편집이 diff 를 덮어 구간 이동임을 증명할 수 없게 된다.
`App`·`GitPanel`·`FileTree` 가 이미 쓰는 증강 형태이기도 하다.

**FR-ASE-2** `app-runs.js` 의 상태 11개와 메서드 33개를 `RunsPanel` 로 옮긴다.
메서드 본문은 **구간 이동**이고, 편집은 **앱으로 나가는 8곳뿐**이다:

```
this.ws (2)  this.focused (1)  this.addTab (1)  this._jumpToTool (1)
this._findToolLocation (1)  this._slotKey (1)  this._slotBase (1)
                              → this.app.<같은 이름>
```

**메서드 이름은 바꾸지 않는다** — `RunsPanel._runPaint` 처럼 접두어가 남지만,
이름까지 함께 다듬으면 33개 메서드의 **내부 호출 전부**가 diff 에 섞여 구간
이동임을 증명할 수 없게 된다. 이름 정리는 이 SRS 의 일이 아니다 (§5 N5).

**FR-ASE-3** `App` 은 `runs` 접근자 하나로 그것을 지연 생성한다
(`_gitObs()` 와 같은 규약 — Run 을 쓰지 않는 브라우저는 만들지 않는다).

**FR-ASE-4** `app-runs.js` 에는 **위임 껍데기 여섯**만 남는다 (C-3).

**FR-ASE-5** 바깥이 `RunsPanel` 의 것을 붙잡는 자리 셋을 함께 고친다 (§2.3):

| 자리 | 전 | 후 |
|---|---|---|
| `slot-run-view.spec.ts` 몽키패치 | `app._runPaint` | `app._runsPanel()._runPaint` |
| `slot-run-view.spec.ts` `viewKeys` | `app._runViews` | `app._runsPanel()._runViews` |
| `app-slots.js` 칸 회수 | `this._runViews` | `this._runs` (지연 생성하지 않는다) |

**재는 내용은 바뀌지 않는다.** 앞의 둘은 "Run 이 바뀌면 그것을 보는 뷰 전부가 다시
그려지는가"·"칸마다 뷰가 하나인가", 셋째는 "사라진 칸의 뷰가 거둬지는가" 그대로다.

**FR-ASE-6** `App` 의 인스턴스 필드가 11개 줄어든다. 그것이 이 묶음의 측정 가능한
결과다.

---

## 4. 검증 (Verification)

| # | 검증 |
|---|---|
| TC-ASE-1 | `go build`·`go vet`·`go test ./...` 전량 통과 |
| TC-ASE-2 | e2e **927개 전량 통과**, 개수 동일 (C-2) |
| TC-ASE-3 | `RunsPanel` 의 메서드 이름 집합이 옮기기 전 `app-runs.js` 의 것과 일치 |
| TC-ASE-4 | `App.prototype` 에 남은 run 관련 메서드가 정확히 여섯 |

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| N1 | `SoftReload`·`AttentionNotifier`·`EditorRegistry` 추출 | 묶음 A 가 절차를 검증한 뒤에 한다. 한 번에 넷을 옮기면 실패했을 때 어느 것이 원인인지 갈리지 않는다 |
| N2 | `GitPanel` 을 객체로 분해 | 실측이 반대를 말한다 — 주제 그룹끼리 필드를 10~21개 공유해서 떼면 참조만 늘어난다 |
| N3 | `ws`·`focused`·`tools` 를 옮기는 것 | 그것이 진짜 공유 상태다. `App` 에 있는 것이 옳다 |
| N4 | 위임 껍데기를 없애 호출부를 고치는 것 | 바깥 호출자 6개 + e2e 3개가 그 이름을 쓴다. 이름을 지키는 편이 변경을 작게 한다 |
| N5 | `RunsPanel` 안의 `_run*` 접두어 정리 | FR-ASE-2. 이름을 바꾸면 구간 이동의 증명이 무너진다. 옮긴 것이 옮긴 그대로임을 먼저 보이고, 다듬는 것은 그 다음이다 |
