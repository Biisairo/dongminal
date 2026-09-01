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

---

## 7. 실행 결과 (Outcome)

### 7.1 묶음 A — 완료

| | 전 | 후 |
|---|---|---|
| `app-runs.js` | 730줄 | **38줄** (위임 6 + 접근자 1 + 배선 IIFE) |
| `web/js/ui/runs-panel.js` | — | 731줄 (상태 11 · 메서드 34) |
| `App` 의 진짜 인스턴스 필드 | 88 | **77** |

메서드 34개가 그대로 34개(TC-ASE-3 통과), 실제 편집은 앱으로 나가는 여섯 줄뿐이다.
Go 전량 통과, e2e 926 통과·1 실패(무관한 산발 흔들림, §7.4).

### 7.2 §1.1 의 측정은 틀렸다 — 정정

이 SRS 의 §1.1 이 근거로 삼은 **"필드 107개 중 60개(56%)가 한 파일 전용"** 은
**과장이다.** 측정이 `this.<이름>` 을 전부 필드로 셌는데, 그중 상당수는 **다른
파일이 정의한 메서드의 호출**이었다.

```js
// app-reload.js — 이것은 app-reload 의 "필드" 가 아니라 app-attn 의 메서드다
this._softStep('attn', () => this._attnRestore && this._attnRestore());
```

어느 파일이 무엇을 **정의**하는지 먼저 매핑하고 다시 세면:

| | 정정 전 (틀림) | **정정 후** |
|---|---|---|
| App 의 인스턴스 필드 | 107 | **88** |
| 한 파일 전용 | 60 (56%) | **41 (46%)** |
| 파일당 전용 필드 최댓값 | "8~9" | **7** (`app-statusbar.js`) |

`GitPanel` 과의 대비는 **여전히 성립한다** — `GitPanel` 은 주제 그룹끼리 10~21개를
공유하고 App 은 46%가 전용이다. 그러나 **"App 은 분해 가능하다" 를 파일 단위로
일반화한 것은 틀렸다.**

### 7.3 남은 후보 셋의 판정 — 세 조건을 다 만족해야 한다

`RunsPanel` 이 잘 떨어진 이유는 조건 셋이 **동시에** 맞았기 때문이다:

1. 상태가 **전부 그 파일 전용**일 것 (11/11)
2. 바깥이 부르는 메서드가 **적을 것** (34개 중 6개)
3. 앱으로 나가는 길이 **좁을 것** (6줄)

실측한 남은 셋은 이 조건을 만족하지 않는다:

| 대상 | 정의 메서드 | **바깥이 부름** | 전용 필드 | 판정 |
|---|---|---|---|---|
| `app-editor.js` | 50 | **35** | 5 | **부적합.** 위임 껍데기가 본체보다 커진다. `_isEditorWin` 하나만 14곳이 부른다 |
| `app-attn.js` | 26 | **14** | 6 | **부적합.** 게다가 주제가 섞였다 (§7.4) |
| `app-reload.js` | 6 | 2 | **3** | **이득 없음.** 옮길 상태가 셋뿐이다 |

### 7.4 대신 드러난 진짜 문제 — `app-attn.js` 의 주제 혼재

`app-attn.js` 는 **알림과 무관한 공용 유틸을 정의하고 있다**:

| 메서드 | 부르는 곳 |
|---|---|
| `_findToolLocation` | `runs-panel.js` · `app-cmd.js` · `app-agents.js` |
| `_jumpToTool` | `runs-panel.js` · `app-agents.js` · e2e |
| `_toolName` | `app-statusbar.js` · `app-agents.js` · e2e |

"도구를 찾고·이동하고·이름 짓는" 일은 알림의 것이 아니다. 같은 파일이 `_bg`·
`_slots`·`_agentsTimer` 처럼 **다른 주제의 상태**까지 만진다.

여기서는 **외부 호출이 많다는 것이 부적합의 증거가 아니라 공용임의 증거**다.
객체로 뽑을 것이 아니라 **제자리로 돌려보낼** 대상이며, `App` 의 메서드로 남으므로
위임 껍데기가 필요 없다 — 파일만 옮기면 된다.

### 7.5 남은 것

- 묶음 B~D (`EditorRegistry`·`AttentionNotifier`·`SoftReload`) — §7.3 근거로
  **보류**. 다음 세션이 재검토한다
- `app-attn.js` 의 공용 유틸 분리 — §7.4. **별도 SRS 가 필요하다**
- `app-statusbar.js`(전용 7) 는 이번에 조사하지 않았다

---

## 8. 재검토 (2차 세션) — 남은 후보 넷, **전부 패스**

### 8.1 어떻게 셌나

§7.2 가 정정한 실수(=`this.<이름>` 을 전부 필드로 셈)를 반복하지 않도록, **먼저
어느 파일이 어느 `App.prototype` 메서드를 정의하는지 전수 매핑**한 뒤 셌다.

```
web/js/**/*.js 의 Object.assign(App.prototype,{…}) · class App 본문에서
2칸 들여쓴 멤버를 뽑아 이름 → 정의 파일 사전을 만든다 (중복 정의 0건 확인)
→ 대상 파일의 this.X 중 그 사전에 없는 것만 "필드 후보"
→ 각 이름을 web/js 전체 + e2e/*.ts 에서 `\.이름\b` 로 다시 훑어
   대상 밖 참조가 하나라도 있으면 "공유", 없으면 "전용"
```

**핵심은 마지막 줄**이다. 형제 `app-*.js` 는 `app.` 이 아니라 `this.` 로 접근하므로
`app\.` 으로 찾으면 걸리지 않는다 — 앞 세션이 e2e 3건을 깬 함정이다. `\.이름\b` 는
`this.`·`app.`·`this.app.` 을 모두 잡는다. 과다 계상 쪽으로 틀리므로 "전용" 판정은
보수적이다.

### 8.2 실측 (모든 수치를 다시 잼)

| 대상 | 정의 메서드 | **바깥이 붙잡음** | 필드 후보 | **전용** | 판정 |
|---|---|---|---|---|---|
| `app-statusbar.js` | 19 | 6 | 15 | **6** | **부적합** — 조건 1 |
| `app-editor.js` | 50 | **35** | 12 | **2** | **부적합** — 조건 1·2 |
| `app-attn.js` | 26 | **15** | 15 | **6** | **부적합** — 조건 1·2 |
| `app-reload.js` | 6 | 2 | 5 | **1** | **이득 없음** |

(`RunsPanel` 의 값: 34개 중 6 · 11/11 전용)

§3.2 의 잠정치와 어긋난 곳은 `app-attn.js` 의 바깥 호출 **14→15**,
`app-reload.js` 의 전용 필드 **3→1** 이다. 어느 쪽도 판정을 뒤집지 않는다.

### 8.3 후보별 사유

#### `app-statusbar.js` — 부적합 (미조사였던 것)

전용 필드가 남은 것 중 가장 많다는 §3.2 의 기대는 **틀렸다.** 전용은 6개
(`_bgConfirm _bgError _bgPending _sbRo _statsInterval _statsVisHook`)뿐이고,
나머지 9개는 **다른 파일이 쓰는 상태**다:

| 필드 | 누가 만지나 |
|---|---|
| `_gitJobs` | **`app-git.js` 가 13곳에서 쓴다.** 상태바는 초기화하고 읽을 뿐이다 |
| `_bg` | `app-tool.js` 가 채우고 · `app-attn.js` 가 읽고 · **e2e 4개가 `app._bg` 로 직접 읽는다** |
| `_bgModalOpen`·`_bgModalKey` | `app.js`·`app-cmd.js`·`app-tool.js` |
| `_cwd` | **`term-pane.js:525` 가 `app._cwd=cwd` 로 쓴다** |
| `_stats`·`_latency` | `app.js` 생성자가 함께 초기화한다 |

**떼면 `app-git.js` 가 남의 객체를 13번 만지게 된다.** 조건 1 이 6/15 로 깨진다.

#### `app-editor.js` — 부적합

50개 중 **35개**를 바깥이 붙잡는다. `_isEditorWin` 하나만 `app-cmd`·`app-dnd`·
`app-edsearch`·`app-git`·`app-layout`·`app-presets` 등에서 부른다. 전용 필드는
**둘**(`_edGitInterval`·`_edLastActive`)뿐이고 `_edDocs`·`_edTrees`·`_edStores`
는 e2e 가 `app.` 으로 직접 읽는다. **위임 껍데기 35개가 본체를 압도한다.**

#### `app-attn.js` — 부적합 (그러나 §7.4 의 값은 유효하다)

26개 중 15개를 바깥이 붙잡고, 전용 필드는 6개다. 객체 추출은 부적합이다.
**대신 §7.4 의 주제 혼재가 실측으로 확인됐고**, 그 처리는
`ATTN_UTIL_RELOCATE_SRS.md` 로 분리했다 — 단, §7.4 가 공용 유틸로 지목한 셋 중
`_jumpToTool` 은 **알림 전용이 맞다**(그 SRS §5 N1 에서 정정).

#### `app-reload.js` — 이득 없음

전용 필드가 **하나**(`_softReloading`)다. §3.2 의 "3" 도 과다였다 — `_sse`·`_sseKick`
은 `app-cmd.js` 가 쓰고, `gitPanel`·`tools` 는 앱 전체의 것이다. 옮길 상태가 없다.

### 8.4 결론

**§7.5 의 묶음 B~D 를 보류가 아니라 종결한다.** `RunsPanel` 은 조건 셋이 동시에
맞은 예외였고, 남은 넷은 하나도 맞지 않는다. §7.2 가 이미 말한 대로 **"App 은
파일 단위로 분해 가능하다" 는 명제가 틀렸다** — `App` 의 46%가 전용 필드인 것은
사실이지만, 그 전용 필드들이 **파일 경계와 정렬돼 있지 않다.**

추가 추출은 위임 계층만 늘린다. **하지 않는 것이 이 SRS 의 결과다.**
