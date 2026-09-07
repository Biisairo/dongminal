# SRS: 접수한 결함 16건 — IME 순서 · 실시간 갱신 · 컨텍스트 측정 · 백그라운드 수명 — IEEE 29148

| 항목 | 값 |
|---|---|
| 문서 | UX_BATCH6_SRS |
| 상태 | **구현 완료** (2026-09-07) — Go 단위 40개 · e2e 21개(`ux-batch6`(16) · `sandbox-pick`(+2) · 개정 3) |
| 선행 | MOBILE_TUI_INPUT_SCROLL_SRS(FR-MTI-30·35) · SANDBOX_PICK_COPY_SRS(FR-SPK-1~23) · SANDBOX_WINDOW_SRS(FR-SBX-23·39~41) · REPO_TAB_UNIFY_SRS(FR-RTU-12·60~65) · SLOT_VIEW_STATE_SRS(FR-SVS-30~46) · GIT_VIEW_REFRESH_SRS(FR-GVR-4·8) · ORCHESTRATION_V2_SRS(FR-CBG-1~12 · FR-HLM-2 · FR-RVZ-13) · UX_REVISION_SRS(FR-BGV-1) |
| 후속 | 없음 |
| 개정 대상 | REPO_TAB_UNIFY_SRS **FR-RTU-12**(기본 사이드 탭) · SANDBOX_PICK_COPY_SRS **FR-SPK-5**(작업 방식의 표기 자리) · ORCHESTRATION_V2_SRS **FR-RUN-11**(close 가 정리까지 한다) |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말은 15줄이고, 작업 중에 한 줄이 더 왔다.

> 1. docker 가 꺼져있음에도 샌드박스가 열린다. 샌드박스 new 버튼을 누르는 순간 docker 여부를 확인하여 도커가 실행중이지 않는 경우 도커를 설치, 실행시키라는 팝업이 떠야한다.
> 2. 샌드박스 new 팝업에 마운트가 없다. scratch(격리) 밖에 보이지 않는다.
> 3. 한글 텍스트 입력 시 문제. 모바일에서는 한글을 치고 기호, 스페이스 등을 누르면 마지막으로 친 글자 이전에 해당 기호, 스페이스 등이 들어간다. 컴퓨터에서는 한글을 치고 엔터를 누르면 마지막글자 전에 엔터가 들어간다. 둘다 한글 조합기가 완료되어 입력되기 전 바로 입력되는 문자를 쳤을 때의 문제인 것 같다.
> 4. explorer/changes 탭에서 기본은 changes 로 되어있어야한다.
> 5. diff 를 열어놓은 상태에서 해당 파일이 수정되면 실시간으로 바뀌어야한다.
> 6. 슬롯에 열어둔 git 이 실시간으로 변경되지 않는다.
> 7. diff 를 보기위해 change 를 클릭할 때 마다 스크롤이 맨 위로 복귀. 스크롤 관련해서 다른 부분도 이런 오류 있는지 확인할 것.
> 8. run 에서 하위 세션 클릭했을 때 해당 세션으로 이동하지 않음 오류. 다이어그램과 아래 로그 사이에있는 라벨을 클릭함
> 9. run 에서 감지하는 사용량과 실제 사용량의 차이가 크다. 1M 컨텍스트 사용중이며 15% 사용하였으나 70% 사용으로 감지한다. 18%를 105로, 12%를 71%로 말한다. 200k 기준으로 측정하는 것인지 측정방식의 문제인 것인지 확실하게 확인하라. 또한 컨텍스트 크기도 그때그때 달라질 수 있다.
> 10. run 에서 조정자가 역할을 다한 세션과 창을 닫지 않는다.
> 11. background 에는 무조건 프로세스가 돌아가고 있어야한다. 헤드리스는 창을 연 다음 프로세스를 실행시킨다. 동작이 이상하다. bg 에 창을 열 때 인자로 시킬 프로세스 명령을 넣을 수 있다. 프로세스가 끝나면 자동으로 background 에서 창이 사라져야한다.
> 12. run 승계 시 승계 내용이 해당 세션 생성보다 빠르다. 승계 문서가 버려진다.
> 13. run 에서 조정자가 빈 터미널을 만든다.
> 14. git 의 tags 의 순서 반대로. 위로 갈수록 최신으로 보여야한다.
> 15. background 버튼에 있는 갯수가 다른 브라우저에서 갱신되는 경우 갱신되지 않는다.
> 16. (추가 접수) 에디터 및 diff 의 우측 스크롤 미리보기와 스크롤바의 동기화가 되지 않는다.

인터뷰에서 확정한 것 (2026-09-07):

| # | 접수한 말의 모호함 | 확정 |
|---|---|---|
| 2 | 마운트를 어떻게 낼 것인가 | **"마운트가 없어도 마운트 선택 가능. 마운트가 없는 마운트 프로파일일 뿐. 경로가 있을때 마운트/복사 한다는거지 경로가없다고 격리는 아니다."** → 작업 방식을 **선택창에서 고른다**. 프로파일 정의와 무관하게 언제나 고를 수 있다 |
| 9 | 어디까지 고칠 것인가 | **실측 토큰 + 설정 한계 + 자동 확장.** 추가 지시(2026-09-07): *"200, 1 이거 상수가 아니라 모델에 맞춰서"* → 한계의 1차 근거는 **모델 문자열**이고 자동 확장은 그물로 남는다 |
| 11 | 무엇이 "살아 있다" 인가 | **"명령이 끝나고말고 할것없이 프로세스가 있으면 살아있고 없으면 죽는것"** → 도구의 프로세스가 곧 수명이다. 헤드리스 생성에 명령 인자를 준다 |
| 10·13 | 강제 수단 | **`dmctl run close` 가 직접 정리 + 스킬 문서 개정** (둘 다) |

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 | 접두어 | 접수 # |
|---|---|---|---|
| **I** IME | 조합 중에 들어온 확정 키의 전송 순서 | FR-IME | 3 |
| **M** 샌드박스 작업 방식 | 선택창에서 마운트/복사를 고른다. 등급 표기 | FR-SBM | 1·2 |
| **V** 실시간 갱신 | Diff 뷰 재적재 · 관측 타이머의 재정착 | FR-GLV | 5·6 |
| **R** 스크롤 | 다시 붙는 캐시 DOM 의 스크롤 보존 | FR-SCR | 7 |
| **C** 컨텍스트 | 실측 토큰 · 설정 한계 · 자동 확장 | FR-CTX | 9 |
| **B** 백그라운드 | 프로세스 수명 = 목록 수명 · 명령 인자 · 방송 | FR-BGP | 11·15 |
| **N** Run 이동·승계·정리 | 슬롯 인지 점프 · 인수인계 유실 · 조정자 정리 | FR-RUN | 8·10·12·13 |
| **T** 표시 | 사이드 기본 탭 · 태그 순서 | FR-DSP | 4·14 |
| **P** 미리보기 | Monaco 미니맵과 스크롤바의 좌표계 | FR-MMP | 16 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **확정 키** | 조합을 끝맺는 입력 — Enter·스페이스·기호. `isComposing` 이 참인 채로 오거나 `compositionend` 보다 앞선다 |
| **작업 방식 (work kind)** | 고른 작업 폴더를 컨테이너가 다루는 방식 — `mount`·`copy`·`none` |
| **관측자 (observer)** | 저장소 하나의 `git status` 폴링을 소유하는 객체. 칸마다의 `GitPanel` 들이 공유한다 |
| **재정착 (resettle)** | 패널 하나가 사라진 뒤, 남은 패널의 조건으로 관측 주기를 다시 세우는 일 |
| **실측 토큰** | transcript 의 마지막 assistant 줄이 적은 `usage` 합 — `input + cache_creation + cache_read` |

### 1.4 참조 (References)

- `web/js/ui/term-pane.js` — `_onBeforeInput` · `_imeClose`
- `web/js/git/panel-life.js:143` `destroy` / `:150` `detach` — `_stop()` 이 관측자의 타이머를 끈다
- `web/js/git/panel-poll.js:146` `_reloadViews` — Diff 가 목록에 없다
- `web/js/ui/renderer.js:423` `_rSide` — 캐시된 뷰를 매 render 마다 옮겨 붙인다
- `web/js/core/app-attn.js:223` `_jumpToTool` — `_slotOnSwitch` 를 부르지 않는다
- `internal/webserver/domain/run/store_context.go:45` `DefaultContextPolicy` — `LimitTokens: 200000`
- `internal/helper/runtimebin/dmctl_activity.go:110` `transcriptSize` — stat 1회
- `internal/webserver/httpapi/handlers_attention.go:210` `apiToolBackgroundSet` — 방송이 없다
- `internal/webserver/domain/git/query/refs.go:70` `Refs` — `--sort` 가 없다

---

## 2. 현재 상태 (조사로 확정한 사실)

**파일:줄로만 적는다.**

### 2.1 ①은 이미 고쳐져 있다 — 배포되지 않았을 뿐이다

`f7f8176` 이 `/api/sandbox/runtime` 과 상태별 갈래(FR-SRT-5~8)를 이미 넣었다. 접수 시점의
실행 인스턴스는 그 커밋 이전 빌드다 — 실측:

```
$ curl -s localhost:58146/api/sandbox/runtime   → not found (404)
$ curl -s localhost:56805/api/sandbox/runtime   → {"state":"stopped","startTryable":true,...}
                                                   (같은 소스로 새로 빌드한 인스턴스)
```

**따라서 ①에 새 요구사항은 없다.** 회귀 방지만 §4 가 맡는다.

### 2.2 조합 중의 확정 키는 xterm 이 즉시 내보낸다

`term-pane.js:158` `_onBeforeInput` 은 `if(!A || !A.isMobile) return` 으로 **데스크톱을
통째로 비껴간다.** 그래서 FR-MTI-30 의 보류(`_imeQueue`)는 모바일에서만 산다.

그리고 모바일에서도 **`beforeinput` 으로 오지 않는 확정 키**는 보류되지 않는다.
`vendor/xterm.js` 의 `CompositionHelper.keydown` 은 조합 중에 keyCode 229·16·17·18 이
아닌 키를 보면 `_finalizeComposition(false)` 를 부르고 `true` 를 돌려준다 — 그 즉시
`_keyDown` 이 그 키의 데이터를 내보낸다. `_finalizeComposition(false)` 가 잘라 보내는
범위는 `_compositionPosition.end` 이고, 그 값은 `compositionupdate` 의
**`setTimeout(...,0)` 안에서** 갱신되므로 마지막 조합 갱신과 확정 키가 같은 tick 이면
**한 글자 낡아 있다.** 그것이 "마지막 글자 전에 엔터가 들어간다" 의 자리다.

### 2.3 선택창의 작업 방식은 프로파일이 고정한다

`ProfileInfo.Work` 는 프로파일의 것이고(`profiles.go:110`), `_pickSandbox` 는 그 값을
**표기만** 한다(`app-tool.js:275-287`). `scratch` 는 `WorkCopy` 고정(`sandbox.go:79`),
`dev` 는 `WorkMount` 고정(`config.go:...Profiles`)이며 `dev` 는 사용자가 `sandbox.json` 에
이미지를 적어야만 생긴다(FR-SBX-3 이 기본 이미지를 금한다).

실측 — 이 기기의 응답이다.

```
$ curl -s localhost:56805/api/sandbox/profiles
[{"name":"scratch","image":"debian:stable-slim","isolated":true,"helper":false,"work":"copy"}]
```

> **따라서 마운트를 고를 길이 화면에 없다.** 고를 수 있는 것은 프로파일 하나뿐이고
> 그것은 복사다.

### 2.4 Diff 는 자동 재적재의 대상이 아니다

```js
web/js/git/panel-poll.js:146  _reloadViews(withConsole){
    history · branches · stash · (console) · worktrees · submodules
```

**Diff 가 없다.** 열려 있는 diff 탭은 `_diffKey` 가 같은 한 다시 받지 않으므로,
파일이 바뀌어도 화면은 그대로다.

### 2.5 패널 하나가 죽으면 저장소 전체의 관측이 멎는다

`GitPanel` 의 `_sigPoll`·`_stPoll`·`_pollOn` 은 **관측자로 가는 통로**다
(`panel.js:120-124`). 그런데

```js
web/js/git/panel-life.js:143  destroy(){ this.detach(); … this.obs.detach(this) }
web/js/git/panel-life.js:150  detach(){ this._stop(); … }
```

`_stop()` 은 그 통로를 지나 **공유 타이머를 끈다.** 살아 있는 형제 패널이 있어도
끄고, 다시 거는 자리가 없다.

`_gitPanelReap`(`app-git.js`)은 칸 수가 줄면 초과 칸의 패널을 `destroy()` 한다.
그러므로 **칸을 늘렸다 줄이면 그 저장소의 폴링이 통째로 멎는다** — 남은 칸의 Git 창은
눈앞에 있는데도 갱신되지 않는다.

### 2.6 캐시된 뷰는 매 render 마다 DOM 에서 떼였다 붙는다

`_rSide`(`renderer.js:423`)는 `.ed-side`·`.ed-side-body` 를 **매번 새로 만들고**
`p.elFor('changes')` 가 든 캐시 DOM 을 그리로 옮긴다. 요소를 문서에서 떼면 그 하위의
스크롤 위치는 브라우저가 버린다 — 스크롤러는 `.git-files`(`style-git.css:407`)이며
`.git-view` 안쪽이다.

터미널은 이미 이 문제를 알고 있었다 — `_rLayout` 이 `.xterm-viewport` 의 `scrollTop` 을
직접 갈무리한다(`renderer.js:160-163`). **같은 대비가 git 뷰와 탐색기에는 없다.**

### 2.7 컨텍스트는 파일 크기로 추정하고 한계는 200k 고정이다

```go
internal/webserver/domain/run/store_context.go:45
  ContextPolicy{BytesPerToken: 3.6, LimitTokens: 200000, WarnRatio: 0.70, CriticalRatio: 0.85}
internal/helper/runtimebin/dmctl_activity.go:110
  transcriptSize → os.Stat(path).Size()
```

실측 — 이 세션의 transcript 다.

| 값 | 실측 |
|---|---|
| transcript 파일 크기 | 968,757 B |
| 지금 공식의 사용률 | 968757 ÷ 3.6 ÷ 200000 = **134%** |
| 마지막 assistant 의 `usage` 합 | 2 + 1,570 + 200,613 = **202,185 토큰** |
| 1M 창 기준 실제 사용률 | **20.2%** |

접수한 세 쌍(15→70 · 18→105 · 12→71)에 이 두 오차를 대면 답이 갈린다.
`105% × (200k/1M) = 21%` 대 실제 18% — **바이트 추정의 오차는 ±20% 안이고, 지배적
오차는 한계값이다.** 즉 **200k 기준으로 재는 것이 맞다.**

`LimitTokens` 를 바꿀 입력이 없다는 것도 사실이다. transcript 에는 컨텍스트 창 크기가
적히지 않으며(`grep 1000000` 무소득), `message.model` 은 `claude-opus-5` 로만 나와
`[1m]` 여부를 담지 않는다. 훅 페이로드에도 없다.

### 2.8 백그라운드 목록의 변화는 방송되지 않는다

`tools_background_changed` 를 내는 자리는 **하나뿐이다** —
`handlers_runs_headless.go:86` 의 헤드리스 생성. `apiToolBackgroundSet`
(`handlers_attention.go:210`)도, 도구가 죽어 `ToolManager.Delete` 가 목록에서 지우는
경로(`manager.go:438`)도 아무것도 알리지 않는다.

브라우저의 `_bgRefresh` 는 자기 행동과 SSE 재연결(`app-cmd.js:66`)에서만 돈다.
**그래서 다른 브라우저의 배지는 낡고, 프로세스가 끝나 사라진 도구도 배지에 남는다.**

### 2.9 헤드리스는 셸을 띄우고 그 뒤에 명령을 타이핑한다

`createHeadlessTool`(`handlers_runs_headless.go:76`)은 `Tools.Create` 로 **로그인 셸**을
띄운다. 실행할 명령은 나중에 `dmctl run launch | dmctl send-input` 이 타이핑한다.
따라서 명령이 끝나도 셸이 남고, 도구는 살아 있으며 목록에도 남는다.

### 2.10 슬롯 모드에서 `_jumpToTool` 은 화면을 바꾸지 않는다

```js
web/js/core/app-attn.js:227  this.ws.activeWindow=loc.win.id;   // ← 이것뿐이다
web/js/core/app-layout.js:238  switchWindow: this._slotOnSwitch(sid);
```

슬롯 모드에서 무엇이 보이는가는 `_slots.windows` 가 정하므로(`app-slots.js:154`),
`activeWindow` 만 바꾸면 **아무 일도 일어나지 않는다.** Run 카드 클릭
(`runs-panel.js:675` → `_runJumpToMember` → `_jumpToTool`)이 그 길을 지난다.

### 2.11 인수인계는 30초 안에 오지 않으면 버려진다

`handlers_runs_context.go:28` `handoffWaitDefault = 30 * time.Second`.
`requestHandoff` 는 전임자에게 엔벨로프를 붙여 넣고 그 시간만 기다린다. 넘기면
`baseline`(=빈 값)을 돌려주고 승계는 **요약 없이** 끝난다.

`HandoffClause`(`store_context.go:330`)가 전임자의 `HandoffSummary` 를 **프리앰블을
만드는 시점에 다시 읽는다**는 사실은 다행이다 — 그러나 조정자는 `succeed` 가 돌아온
직후 `run launch` 를 치라는 안내를 받으므로(`dmctl_run_context.go:93`), 실제로는 그
사이에 요약이 도착할 시간이 없다.

에이전트가 요약을 작성하는 데 걸리는 시간은 30초보다 길다 — 그것이 이 시한이 거의
언제나 초과되는 이유다.

### 2.12 조정자는 정리를 스스로 해야 한다

`dmctl run close` 는 도구를 닫지 않는다(SKILL.md §8) — 정리 대상 목록만 돌려주고
`/exit` → `close-tab` 은 조정자의 몫이다. 조정자가 그 절차를 건너뛰면 탭과 창이 남고,
`run member --at <탭>` 을 위해 만들어 둔 탭에 아무도 앉지 않으면 **빈 터미널**이 남는다.

### 2.13 태그는 refname 오름차순이다

`refs.go:70` 의 `for-each-ref` 에 `--sort` 가 없다. git 의 기본은 refname 오름차순이며
`branches.js:194` 의 `_members` 도 받은 순서를 그대로 그린다. 그래서 화면의 맨 위가
가장 오래된 태그이고, `v1.10` 이 `v1.9` 보다 위에 온다.

### 2.14 사이드의 기본 탭은 Explorer 다

`constants-editor.js:246` `const REPO_SIDE_DEFAULT=REPO_SIDE_EXPLORER;`

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 I — IME 전송 순서

**FR-IME-1.** 조합이 열려 있는 동안 도착한 **키다운**은 xterm 에 넘기지 않고 보류한다.
보류 대상에서 제외하는 것은 조합 자체를 나르는 키뿐이다 — keyCode `229`(IME), `16`·`17`·`18`
(Shift·Ctrl·Alt).

**근거.** 제외 목록은 `CompositionHelper.keydown` 이 이미 쓰는 것과 **같은 것**이다.
다른 목록을 두면 어느 한쪽만 고쳐질 때 조합이 깨진다.

**FR-IME-2.** 보류한 키는 `compositionend` 뒤에 **원래 이벤트를 다시 발행**해서
내보낸다. 우리가 키를 데이터로 번역하지 않는다 — 그 표(`evaluateKeyboardEvent`)는
xterm 의 것이고, 두 벌이 되면 Ctrl·Alt·커서 키의 해석이 갈린다.

**FR-IME-3.** 재발행은 조합 문자열이 나간 **뒤**여야 한다. `compositionend` 를 캡처
단계에서 받고 두 tick 뒤에 흘려 보낸다 — xterm 은 자기 bubble 핸들러에서
`setTimeout(...,0)` 로 조합을 보내므로 그 뒤가 된다 (기존 `_imeClose` 의 규약과 같다).

**FR-IME-4.** 보류한 키는 `preventDefault` 한다. 그러지 않으면 그 키의 기본 동작이
textarea 를 고쳐 xterm 의 조합 계산(`_compositionPosition`)을 어긋나게 한다.

**FR-IME-5.** 조합이 닫히지 않은 채 포커스를 잃으면(`blur`) 보류분을 흘려 보내고
조합 상태를 내린다. `compositionend` 가 오지 않는 경로에서 입력이 영영 갇히지 않아야
한다.

**FR-IME-6.** 기존 `beforeinput` 보류(FR-MTI-30)는 **그대로 둔다.** 두 길은 서로
다른 것을 잡는다 — 이쪽은 키다운, 저쪽은 소프트 키보드의 `insertText` 다. 같은 큐를
쓰되 순서는 도착 순이다.

**FR-IME-7.** 데스크톱과 모바일에 같은 규칙이 적용된다. `isMobile` 게이트는
`beforeinput` 경로에만 남는다 (그쪽은 xterm 이 이미 처리하는 경로와 겹치기 때문이다).

### 3.2 묶음 M — 샌드박스 작업 방식

**FR-SBM-1.** 선택창은 **작업 방식을 고르는 자리**를 갖는다 — `마운트` · `복사` 둘.
프로파일 정의와 무관하게 언제나 보이고 언제나 고를 수 있다.

**FR-SBM-2.** 기본 선택은 **목록 첫 프로파일**의 `work` 다. 그것이 `none` 이거나
없으면 `copy` 로 떨어진다 — 되돌아오는 통로가 없는 쪽이 안전한 기본이다.

`none` 인 프로파일을 고르면 작업 방식과 작업 폴더가 **함께 버려진다** (FR-SPK-6 의
규약 그대로이며, 그 사실은 그 버튼의 툴팁이 밝힌다). 선택 줄을 프로파일마다
비활성으로 바꾸지 않는 이유는 순서다 — 방식을 고르는 것이 프로파일을 고르는 것보다
앞이고, 앞선 선택을 뒤의 선택이 되돌아가 잠그면 창이 손 밑에서 움직인다.

**FR-SBM-3.** 고른 작업 방식은 창 생성 요청에 실린다. 서버는 그 값으로 프로파일의
`Work` 를 **덮어** 컨테이너를 만든다. 값이 없거나 모르는 값이면 프로파일의 것을 쓴다.

**FR-SBM-4.** 격리 등급 배지는 **프로파일의 정책**을 말한다 — 헬퍼·네트워크·기본
마운트. 작업 방식은 등급의 근거가 아니다.

**근거.** 접수한 말이 그것이다("경로가없다고 격리는 아니다"). 등급은 프로파일이
무엇인가이고, 마운트 여부는 이번에 무엇을 고르는가다. 둘을 한 배지에 섞으면 같은
프로파일이 눌릴 때마다 다른 등급으로 보인다.

**FR-SBM-5.** 그러나 **마운트를 고르고 작업 폴더를 넣으면** 그 사실을 선택창이
말한다 — "이 창 안의 코드가 그 폴더를 고칠 수 있습니다". 등급 배지와 다른 자리에,
고른 것이 바뀔 때마다 갱신된다.

**FR-SBM-6.** 서버의 `ProfileInfo.Isolated` 는 `Work` 를 보지 않는다 —
`!Helper && Network=="none" && BaseMounts 없음` 이다.

**근거.** 지금 있는 두 프로파일의 값은 바뀌지 않는다 (scratch: true, dev: false).
바뀌는 것은 **근거**뿐이며, `Work` 가 선택값이 된 이상 그것이 프로파일의 등급을
정할 수 없다.

**FR-SBM-7.** ①의 런타임 갈래(FR-SRT-5~8)는 그대로다. 새 빌드가 배포되면 성립한다.

### 3.3 묶음 V — 실시간 갱신

**FR-GLV-1.** Diff 뷰는 자동 재적재의 대상이다. `_reloadViews` 가 열려 있는 diff 를
다시 받는다.

**FR-GLV-2.** 재적재는 **지금 보고 있는 대상**을 다시 받는 것이다. 새로 고르는 것이
아니므로 선택·스크롤·side-by-side 설정은 그대로다.

**FR-GLV-3.** 내용이 같으면 다시 그리지 않는다 — Monaco 모델을 같은 값으로 갈아
끼우면 커서와 스크롤이 튄다 (FR-GIT-227 과 같은 근거).

**FR-GLV-6. 거부당한 대상은 다시 묻지 않는다.** 서버가 HTTP 오류로 답했거나 그릴 수
없는 종류(바이너리·상한 초과)면 그 대상에 표식이 남고, 자동 재적재는 그것을 건너뛴다.
사용자가 다른 대상을 고르거나 다시 부르면 표식은 풀린다.

**근거 (실측).** FR-GLV-1 을 넣고 잘못된 축으로 diff 를 열었더니 `/api/git/diff-content`
가 **매초 400 을 냈다** — 자동 재적재가 실패를 그만큼 되풀이한 것이다. 닿지 못한
것(네트워크)은 표식의 대상이 아니다: 그쪽은 일시적일 수 있다.

**FR-GLV-6a.** 사용자가 누른 **새로고침은 그 표식을 넘는다** (D-8: 새로고침은
백업이다). 자동 경로가 멈춘 자리에서 손으로 다시 시도할 길이 없으면 그 화면은 사유에
갇힌다.

**FR-GLV-4.** 패널이 사라져도 **남은 패널이 있으면 관측은 계속된다.** `detach`·
`destroy` 는 타이머를 끈 뒤 **재정착**한다 — 같은 관측자의 패널 중 조건이 참인 것으로
주기를 다시 세운다.

**FR-GLV-5.** 남은 패널이 없으면 종전대로 멎는다. 관측자 회수(`_gitObsReap`)의 규약은
바뀌지 않는다.

### 3.4 묶음 R — 스크롤 보존

**FR-SCR-1.** render 가 캐시된 DOM 을 다시 붙일 때 그 안의 스크롤 위치는 보존된다.
대상은 **옮겨지는 요소와 그 하위 전부**다 — 어느 것이 스크롤러인지 렌더러가 알 필요가
없어야 한다.

**FR-SCR-2.** 복원은 요소가 문서에 붙은 **뒤에** 한다. 떼어진 요소의 `scrollTop` 은
쓸 수 없다.

**FR-SCR-3.** 대상은 **git 뷰**다 — 사이드의 Changes 와 본문의 여섯.

탐색기와 터미널은 대상이 아니다. 둘은 이미 자기 대비를 갖고 있다 —
`FileTree.mount` 의 `_scrollY`(FR-EDT-68)와 `_rLayout` 의 `.xterm-viewport`. 같은 일을
두 벌로 하면 어느 쪽이 이겼는지 말할 수 없다.

**FR-SCR-4.** 값이 0 인 요소는 기록하지 않는다 — 복원할 것이 없고, 복원이 오히려
새 요소의 자연스러운 자리를 덮는다.

### 3.5 묶음 C — 컨텍스트 측정

**FR-CTX-1.** 관측은 **실측 토큰**을 싣는다. transcript 의 마지막 assistant 줄이 적은
`usage` 에서 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` 를
더한 값이다.

**근거.** 이것이 그 요청이 실제로 모델에 보낸 컨텍스트다. 파일 크기는 대화 전체의
누적이라 압축·잘림과 무관하게 자란다 (§2.7 실측: 파일로는 134%, 실측 토큰으로는 20%).

**FR-CTX-2.** 읽는 방법은 **파일 끝의 제한된 조각**이다. 상한 안에서 뒤에서부터 줄을
갈라 `usage` 를 가진 마지막 줄을 찾는다. 파일 전체를 읽지 않는다 (NFR-CBG-1 을 지킨다).

**FR-CTX-3.** 서버로 가는 것은 **숫자뿐이다.** transcript 의 본문도, 경로도 보내지
않는다 (NFR-4 는 그대로다).

**FR-CTX-4.** 실측 토큰을 얻지 못하면 종전의 바이트 추정으로 떨어진다. 둘 다 없으면
"모른다" 이며 등급을 매기지 않는다 (FR-CBG-5).

**FR-CTX-5. 한계는 모델이 말한다.** 관측은 그 줄이 적은 `message.model` 을 함께
싣고, 서버가 그 문자열에서 컨텍스트 창을 얻는다.

근거는 실측이다 — 이 기기의 전사 기록 전량을 세면 모델 문자열이 **긴 컨텍스트 판을
접미어로 구분한다**.

```
$ grep -ho '"model":"[^"]*"' ~/.claude/projects/*/*.jsonl | sort | uniq -c | sort -rn
97045 "model":"claude-opus-5"
 1105 "model":"claude-sonnet-5"
  824 "model":"claude-fable-5-1"
   35 "model":"claude-opus-5[1m]"      ← 1M 판
   10 "model":"claude-haiku-4-5-20251001"
```

`[1m]` 접미어가 있으면 1,000,000 이다. 그 밖의 이름은 **답하지 못한 것**으로 다룬다 —
모르는 이름을 기본값으로 단정하면 다음 조항의 넓히기가 "설정이 틀렸다" 와 "표에
없다" 를 구분하지 못한다.

**FR-CTX-6. 관측이 그물이다.** 모델이 답하지 못했고 관측된 토큰이 지금 창을 넘으면,
**아는 다음 창**으로 넓힌다.

**근거.** 위 표의 수가 그 필요를 말한다 — 97,045 대 35 다. 접미어 없이 기록되는 1M
세션이 실제로 있다(실측: 이 세션의 마지막 usage 는 485,800 토큰이고 모델은
`claude-opus-5` 로 적힌다). 창을 넘는 사용률은 **불가능한 관측**이므로, 그것을 본
순간 창이 더 크다는 것은 추측이 아니라 확정이다.

**FR-CTX-6a.** 아는 창의 목록은 **한 자리에 산다** (`contextWindows`). 모델 판정도
넓히기도 그 목록에서 파생되며, 200000·1000000 이라는 수가 코드의 다른 곳에 적히지
않는다.

**FR-CTX-6b.** 관측이 목록의 마지막보다도 크면 **관측값 자신**이 창이 된다. 표에
없는 판을 만나도 100% 를 넘는 수를 보이지 않는다.

**FR-CTX-5a.** `ContextPolicy.LimitTokens` 는 종전대로 설정값이며(`orchestration.
contextLimitTokens`, 기본 200000) **출발점**으로만 쓰인다 — 모델도 관측도 답하지
않은 동안의 값이다.

**FR-CTX-7.** 넓혀진 한계는 그 멤버의 레코드에 남는다 — 다음 관측이 다시 좁히지
않는다. 압축이 일어나 사용량이 내려가도 창 크기는 그대로다.

**FR-CTX-8.** 표시는 여전히 `~` 를 단다. 실측 토큰이라도 **다음 요청의** 컨텍스트는
아니기 때문이다.

**FR-CTX-9.** 등급 경계(warn 0.70 · critical 0.85)와 압축 우선 규칙(FR-CBG-4)은 그대로다.

### 3.6 묶음 B — 백그라운드 수명

**FR-BGP-1.** 백그라운드 목록은 **살아 있는 프로세스의 목록**이다. 도구의 프로세스가
끝나면 그 자리에서 목록에서 사라진다.

**FR-BGP-2.** 목록이 바뀌면 **방송한다** (`tools_background_changed`). 바뀌는 자리는
셋이다 — 백그라운드로 보냄, 되돌림, 도구의 죽음. 세 자리 전부가 방송한다.

**근거.** 접수 ⑮가 그것이다. 방송이 없으면 다른 브라우저의 배지는 SSE 재연결까지
낡은 채로 남는다.

**FR-BGP-3.** 헤드리스 도구 생성은 **실행할 명령을 인자로 받는다.** 명령이 주어지면
로그인 셸 대신 그 명령이 도구의 프로세스가 된다.

**FR-BGP-4.** 그러므로 명령이 끝나면 도구가 죽고, FR-BGP-1 에 따라 목록에서 사라진다.
"명령의 종료" 를 따로 감지하는 자리는 없다 — 프로세스가 있으면 살아 있고 없으면 죽은
것이다.

**FR-BGP-5.** 명령을 주지 않으면 종전대로 로그인 셸이다. Run 의 멤버 기동
(`run launch | send-input`)은 그 경로를 그대로 쓴다.

**FR-BGP-6.** `dmctl` 에 그 인자를 낸다 — `dmctl detach --headless --cmd <명령>` 이
아니라 헤드리스 생성 종단의 인자다 (§3.6 의 CLI 표면은 `dmctl run headless` 가 없으므로
HTTP 종단과 `dmctl run succeed --headless` 만 대상이다).

### 3.7 묶음 N — Run 이동 · 승계 · 정리

**FR-RUN-1.** `_jumpToTool` 은 **포커스 칸이 그 창을 받게 한다** — `switchWindow` 와
같은 한 줄(`_slotOnSwitch`)을 지난다.

**포커스 칸을 옮기지 않는다.** 그 창이 이미 다른 칸에 보인다고 그리로 포커스를
옮기면 FR-SVS-12 가 깨진다 — 알람이 부른 탭은 사용자가 서 있는 칸에 떠야 하고,
사용자는 포커스 칸에 있다. 처음에 "이미 있는 칸으로 포커스를 옮긴다" 로 만들었다가
`slot-view-state` TC-SVS-56 이 그것을 잡았다.

**FR-RUN-2.** 단일 슬롯 모드의 동작은 종전과 같다.

**FR-RUN-3.** 인수인계 대기의 기본 상한을 **180초**로 올린다. 에이전트가 요약을
작성하는 데 걸리는 시간이 30초보다 길다는 것이 §2.11 의 사실이다.

**FR-RUN-4. 늦게 온 요약도 버리지 않는다.** 승계가 요약 없이 끝났으면 전임자에게
**요약을 청한 사실**이 남고, 후임의 프리앰블을 만드는 종단(`/api/runs/preamble`)은
그 요약이 도착할 때까지 상한 안에서 기다린다.

**근거.** 프리앰블은 이미 전임자의 요약을 **그 시점에 다시 읽는다**
(`HandoffClause`, §2.11). 빠진 것은 "아직 오는 중" 이라는 사실뿐이고, 그것을 알면
기다릴 수 있다. 승계 시점에 얼어붙이지 않는 편이 어느 쪽이 빠르든 옳다.

**FR-RUN-5.** 기다림에도 오지 않으면 요약 없이 낸다. 프리앰블은 그 사실을 적는다
(기존 `HandoffClause` 의 문안 그대로다).

**FR-RUN-6.** `dmctl run close` 는 **탭 부착 멤버의 정리까지 수행한다** — 멤버마다
`/exit` 을 보내고, 셸로 돌아온 뒤 그 탭을 닫는다. 헤드리스 도구는 종전대로 close 가
닫는다.

**FR-RUN-6a. 자리는 uuid 로 지목한다.** 서버가 직접 방송하는 `closeTab` 은 탭
uuid 를 싣고, 브라우저의 `_resolveLocation` 이 그것을 받는다.

**근거.** 좌표(`W1.P1.T1`)는 **자리**라 앞의 탭이 닫히면 뒤의 것이 밀린다. 여러 탭을
한 번에 닫는 이 명령이 좌표를 미리 계산해 보내면 두 번째부터 엉뚱한 탭을 가리킨다.
`/api/commands` 가 uuid 를 좌표로 바꿔 보내는 경로(FR-DMC-9)는 그대로다.

**FR-RUN-6b. 자리를 찾지 못한 `closeTab` 은 아무것도 닫지 않는다.**

**근거 (실측).** 종전에는 공통 경로로 떨어져 `_focusLocation` 이 실패한 뒤
`executeAction('closeTab')` 이 **포커스 탭**을 닫았다. 이미 닫힌 탭을 한 번 더 닫으라는
요청이 사용자의 터미널 창을 통째로 없애는 것을 e2e(`skill-contract` 의 "사용자 공간이
전후로 같다")가 잡았다.

**FR-RUN-6c.** 종료 명령은 **도는 것이 있을 때만** 보낸다. 셸 프롬프트에 `/exit` 를
치면 "그런 파일이 없다" 한 줄이 남을 뿐이고, 그것은 정리가 아니라 잡음이다.

**FR-RUN-7.** 정리는 **Run 창에 남은 빈 탭까지** 대상이다. 멤버가 결속되지 않은 채
셸만 도는 탭은 조정자가 만들었으나 쓰이지 않은 자리다.

**FR-RUN-8.** `--keep-tools` 를 주면 아무것도 닫지 않는다 — 종전 규약이 그대로 남는다.

**FR-RUN-9.** 정리 결과는 응답에 실린다 — 무엇을 닫았고 무엇이 남았는가. 조용히
사라지는 자원이 없어야 한다는 기존 규약(잔여물 보고)과 같다.

**FR-RUN-10.** 팀 스킬 문서(`skills/team/SKILL.md`)는 위에 맞춰 고친다 — 조정자가
직접 치던 `/exit` → `close-tab` 이 `close` 안으로 들어갔고, 빈 탭을 만들지 말라는
규칙이 더해진다.

### 3.8 묶음 T — 표시

**FR-DSP-1.** Repo 창 사이드의 기본 탭은 **Changes** 다.

**FR-DSP-2.** 이미 저장된 창의 선택은 그대로다 — 기본값은 **키가 없을 때**의 답이다.

**FR-DSP-1a. 저장소가 아님이 확정되면 관측이 멈춘다.**

**근거 (실측).** 기본이 Changes 가 되면 **저장소가 아닌 루트**도 그 표면을 갖는다 —
`~` 와 메모장이 그렇다. 그런데 `not_a_git_repo` 갈래는 사유만 그리고 주기를 그대로
두었고, `_applyCadence` 는 성공 경로에만 있어 실패 백오프도 걸리지 않았다: 기준
주기(3초)로 영원히 물었다. 그 자리에서 물을 것은 없다 — 화면에 서는 것은 목록이
아니라 `git init` 버튼이다.

되살아나는 길은 셋이다: 창·탭 포커스의 `signal()`(그쪽은 `_pollOk` 를 보지 않는다),
새로고침 버튼, 그리고 이 창의 `git init`(FR-RTU-26·28).

**FR-DSP-1c. 연 파일을 드러내는 일은 사이드가 Changes 여도 살아 있다.** 탐색기가
아직 만들어지지 않았으면 경로를 창마다 기억해 두고, 그 자리에 갔을 때 드러낸다.

**근거 (실측).** `_edTreeFor` 는 트리가 **만들어졌을 때만** 그것을 준다. 사이드가
Changes 인 창은 `_edTree` 를 지나지 않으므로 트리가 없고, 그러면 `revealPath` 가
통째로 건너뛰어졌다 — 검색·`dmctl open`·변경 클릭이 모두 이 자리를 지나므로
"연 파일이 탐색기 어디에 있는가"(FR-EDT-63)가 사라진다. e2e
`editor-nested-root` N4 가 잡았다.

**FR-DSP-1b.** 탐색기를 재는 e2e 는 그 자리를 **명시로 연다** (`openExplorerSide`).
기본값에 기대던 동안은 기본값이 바뀌는 날 전부가 함께 무너진다 — 이 개정 하나에
일곱 스펙이 걸린 것이 그 증거다.

**FR-DSP-3.** 태그는 **최신이 위**다. 정렬 근거는 `creatordate` 내림차순이며, 그것은
`Ref.AtUnixMs` 가 이미 싣고 있는 값이다.

**FR-DSP-4.** 로컬·원격 브랜치의 순서는 바뀌지 않는다. 접수한 것은 태그다.

### 3.9 묶음 P — 미리보기와 스크롤바

**FR-MMP-1.** 편집기와 diff 의 **미니맵은 스크롤바와 같은 좌표계**에 선다 —
`minimap.size: 'fit'`. 파일 전체가 미리보기 높이에 들어가므로 두 슬라이더의 자리와
높이가 같다.

**근거 (실측).** Monaco 의 기본값은 `'proportional'` 이고, 그때 미리보기는 파일이
길면 **자신도 함께 스크롤한다.** 800줄 파일을 45% 지점으로 옮기고 잰 값이다.

| | 미니맵 슬라이더 | 스크롤바 슬라이더 |
|---|---|---|
| `proportional` (종전) | `top 517, h 118` | `top 531, h 86` |
| `fit` (새) | `top 531, h 86` | `top 531, h 86` |

diff 에서는 근거가 하나 더 있다 — 그쪽에는 개요 눈금(`renderOverviewRuler`)이
함께 서고(FR-DOR-1), 눈금은 언제나 스크롤바의 좌표계다. 미리보기만 다른 좌표계에
있으면 **같은 문서의 같은 자리를 세 표시가 다르게 가리킨다.**

---

## 4. 검증 (Verification)

| ID | 요구 | 방법 |
|---|---|---|
| V-IME-1 | FR-IME-1·3 | e2e — 데스크톱에서 조합 중 Enter → 전송 순서가 `조합문자열` → `\r` |
| V-IME-2 | FR-IME-1 | e2e — 조합 중 keyCode 229·16·17·18 은 보류되지 않는다 |
| V-IME-3 | FR-IME-5 | e2e — 조합 중 blur 하면 보류분이 나간다 |
| V-IME-4 | FR-IME-6 | e2e — 기존 TC-MTI-28·29 가 그대로 통과한다 |
| V-SBM-1 | FR-SBM-1·2 | e2e — scratch 하나뿐인 응답에서도 선택창에 작업 방식 둘이 보인다 |
| V-SBM-2 | FR-SBM-3 | Go 단위 — `Placement.Work` 가 프로파일의 `Work` 를 덮는다 |
| V-SBM-3 | FR-SBM-5 | e2e — 마운트 + 폴더를 고르면 경고 줄이 뜬다. 폴더를 지우면 사라진다 |
| V-SBM-4 | FR-SBM-6 | Go 단위 — `Info().Isolated` 가 `Work` 에 좌우되지 않는다 |
| V-GLV-1 | FR-GLV-1·2 | e2e — diff 를 연 채 파일을 고치면 화면이 따라온다 |
| V-GLV-2 | FR-GLV-4 | e2e — 칸을 늘렸다 줄인 뒤에도 Changes 가 갱신된다 |
| V-GLV-3 | FR-GLV-6 | e2e — 거부당한 대상은 폴링이 다시 받지 않는다 |
| V-SCR-1 | FR-SCR-1·2 | e2e — 목록을 내린 뒤 행을 클릭해도 스크롤이 그대로다 |
| V-SCR-2 | FR-SCR-3 | e2e — 목록의 자리가 `render()` 한 번을 건넌다 |
| V-CTX-1 | FR-CTX-1·2 | Go 단위 — 마지막 usage 를 골라 합한다. 그 앞줄이 아니다 |
| V-CTX-2 | FR-CTX-3 | Go 단위 — 페이로드에 본문·경로가 없다 (기존 카나리아 확장) |
| V-CTX-3 | FR-CTX-5 | Go 단위 — `[1m]` 접미어가 창을 1M 으로 정하고, 그 밖의 이름은 답하지 않는다 |
| V-CTX-4 | FR-CTX-6·6b·7 | Go 단위 — 창을 넘는 관측이 아는 다음 창으로 넓히고, 목록 밖이면 관측값이 창이 되며, 되돌아가지 않는다 |
| V-CTX-5 | FR-CTX-8 | Go 단위 — 응답과 `dmctl run status` 가 분자·분모를 함께 낸다 |
| V-BGP-1 | FR-BGP-1·2 | Go 단위 — 도구가 죽으면 목록에서 빠지고 방송이 나간다 |
| V-BGP-2 | FR-BGP-2 | Go 단위 — `background/set` 이 방송한다 |
| V-BGP-3 | FR-BGP-3·4 | Go 단위 — 명령을 준 헤드리스는 그 명령이 프로세스이고, 끝나면 목록에서 사라진다 |
| V-BGP-4 | FR-BGP-6 | Go 단위 — `detach --run` 이 헤드리스 종단에 명령·자리를 싣고, 인자 규약을 지킨다 |
| V-RUN-1 | FR-RUN-1 | e2e — 두 칸에서 옆 칸 창의 도구로 점프하면 그 칸이 포커스를 받는다 |
| V-RUN-2 | FR-RUN-4·5 | Go 단위 — 승계 뒤 도착한 요약이 프리앰블에 실린다 |
| V-RUN-3 | FR-RUN-6·7·8 | Go 단위 — close 가 탭과 빈 탭을 닫고, `--keep-tools` 는 닫지 않는다 |
| V-RUN-4 | FR-RUN-6a·6b | e2e — uuid 로 지목한 탭이 닫히고, 없는 자리를 지목하면 아무것도 닫히지 않는다 |
| V-DSP-1 | FR-DSP-1·2 | e2e — 새 Repo 창의 사이드가 Changes 다. 저장된 선택은 유지된다 |
| V-DSP-3 | FR-DSP-1a | e2e — 저장소가 아닌 루트의 `git status` 요청 수가 늘지 않는다 (`editor-explorer` X9) |
| V-DSP-4 | FR-DSP-1c | e2e — 사이드가 Changes 인 창에서 연 파일이 탐색기로 가면 드러난다 (`editor-nested-root` N4) |
| V-DSP-2 | FR-DSP-3 | Go 단위 — 태그가 creatordate 내림차순이다 |
| V-SRT-1 | FR-SBM-7 | 기존 `sandbox-runtime.spec.ts` 가 그대로 통과한다 (①의 회귀 방지) |
| V-MMP-1 | FR-MMP-1 | e2e — 긴 파일을 중간으로 스크롤했을 때 미니맵 슬라이더와 스크롤바 슬라이더의 top·height 가 같다 |

---

## 5. 비목표 (Non-goals)

- **모델 이름의 전수 표.** 창 크기를 실제로 가르는 것은 `[1m]` 접미어 하나이고, 그
  밖의 이름은 전부 같은 기본 창이다 — 이름마다 줄을 적으면 새 모델이 나올 때마다
  이 표가 낡고, 낡은 표는 없는 표보다 나쁘다. 판정에 쓰는 것은 접미어와 아는 창
  목록(FR-CTX-6a)뿐이다
- **transcript 파싱의 일반화.** 읽는 것은 마지막 `usage` 하나이며 대화 내용은 어떤
  경로로도 읽지 않는다
- **조정자를 대신하는 판단.** close 가 정리를 대신할 뿐, 언제 접을지는 여전히
  조정자와 사용자의 것이다
- **xterm 의 `CompositionHelper` 수정.** FR-MTI-35 가 정한 대로 건드리지 않는다 —
  조합의 전송·미리보기·증분 계산은 그쪽의 것이다
