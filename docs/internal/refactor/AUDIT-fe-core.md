# 감사 보고서 — 프론트엔드 코어 (`web/js/core/`, `web/js/i18n/`, `web/index.html`)

> **성격**: 읽기 전용 전수 감사. 소스는 한 줄도 고치지 않았다.
> **범위**: `web/js/core/` 60파일 18,604줄 · `web/js/i18n/` 2파일 2,055줄 · `web/index.html` 825줄
> **제외**: `web/vendor/`(서드파티) · `web/js/ui/` · `web/js/git/`(다른 담당)
> **기준선 확인**: `check-i18n`·`check-shortcuts-docs`·`check-load-order`·`check-layer`·`check-api-docs`·`check-error-docs`·`eslint` **전부 통과 상태**에서 감사했다. 아래 항목은 전부 **게이트가 보지 않는 자리**다.

---

## 0. 요약

| # | 등급 | 제목 | 위치 | 공수 |
|---|---|---|---|---|
| H1 | HIGH | `_killToolInstances`·`toolAny` 가 슬롯 0·1 만 본다 (`SLOT_MAX=4`) | `app-tool.js:566` · `app.js:315` | S |
| H2 | HIGH | 사용자 노출 영문 문자열 **113개**가 카탈로그 밖 — `t()` 를 지나지 않는다 | `constants*.js` 9파일 | L |
| H3 | HIGH | 모달 골격 여섯이 `UIKit.dialogOpen` 을 건너뛴다 (D-A11Y-7 위반) | `app-tool.js` ×4 · `app-editor-file.js` · `app-statusbar.js` | M |
| H4 | HIGH | "활성 창 전환" 이 13곳에 흩어져 각자 다른 부분집합을 수행한다 | `app-layout.js` 외 7파일 | M |
| H5 | HIGH | `TimerHub._tick` 이 `after` 콜백 예외를 막지 않는다 — 스케줄러가 멎는다 | `timer-hub.js:321` | S |
| M1 | MED | `'Shell'` 이 상수 둘 + 리터럴 셋 — `tabNameSource` 판정이 리터럴에 매여 있다 | `helpers.js:763,926` 외 3곳 | S |
| M2 | MED | `_execRemote` 184줄 if-체인 — `EventBus._onMessage`(FR-BUS-4)가 이미 지나온 형태 | `app-cmd.js:476` | M |
| M3 | MED | `save()` 184줄 · `init()` 153줄 · `addTab()` 160줄 — 분할 경계가 명확하다 | `app.js:457,138` · `app-layout.js:462` | M |
| M4 | MED | `initMobileKeybar` 203줄 — 표·툴팁·버튼배선·뷰포트가 한 함수 | `app-mobile.js:163` | M |
| M5 | MED | localStorage/sessionStorage 키가 상수와 리터럴로 갈려 있다 | 11파일 + `index.html` | S |
| M6 | MED | `const t=` 가 전역 `t()` 를 30곳에서 가린다 | core 전역 | S |
| M7 | MED | 빈 `catch{}` 67개 — 실패가 `ErrorLog` 에도 콘솔에도 남지 않는다 | core 18파일 | M |
| M8 | MED | `addTab` 의 "이미 있는 탭으로 옮기기" 3벌이 미묘하게 다르다 | `app-layout.js:494,576,533` | S |
| M9 | MED | `index.html` 선주입 스크립트의 키·범위 **6개**가 상수와 손으로 동기화된다 | `index.html:38,49,53` | S |
| L1 | LOW | `_kill`/`_killTool` · `apiGet('/api/tools?cols=120&rows=40')` 등 잔여 하드코딩 | `app-tool.js:544,573,578` | S |
| L2 | LOW | `t('…')+' — '+((err&&err.message)||err)` 관용구 5벌 | 4파일 | S |
| L3 | LOW | `main.js` 가 부트스트랩이 아니라 샌드박스 창 생성 흐름을 들고 있다 | `main.js:35-95` | S |

| # | 등급 | 성능 개선 기회 | 위치 |
|---|---|---|---|
| P1 | MED | `_pollStats` 가 3왕복을 직렬로 — 최소 1초 주기 | `app-statusbar.js:33` |
| P2 | LOW | `doSearch` 가 키 입력마다 `getComputedStyle` 3회 | `app-search.js:99-101` |
| P3 | LOW | `initMobileKeybar` 가 버튼 19개 × 리스너 6개 = 114개 클로저 | `app-mobile.js:230-345` |

| # | 등급 | 문서-구현 괴리 / UI 누락 | 근거 |
|---|---|---|---|
| D1 | HIGH | `lspServerPaths` 를 **편집할 UI 가 없다** — FR-LSP-3·4①·46④ 가 영구 미도달 | `EDITOR_LSP_SRS`(승인·구현완료) |
| D2 | MED | 500줄 초과 파일 DoD 가 22 → **26** 으로, 최대 파일이 1,336 → **1,586** 으로 역행 | `FE_MODULE_BOUNDARY_SRS §7.1` |
| D3 | MED | `helpers.js` 979 → **1,136**, 섹션 8개 — N4 비목표의 전제("주제 하나")가 깨졌다 | `FE_MODULE_BOUNDARY_SRS §5 N4` |
| D4 | LOW | `check-i18n.mjs` 는 **한글만** 잡는다 — H2 가 새어 나간 통로 | `scripts/check-i18n.mjs:36` |

---

## 1. HIGH

### [HIGH] H1 — `_killToolInstances`·`toolAny` 가 슬롯 0·1 만 본다 (`SLOT_MAX=4`)

- **위치**
  - `web/js/core/app-tool.js:566-571` (`_killToolInstances`)
  - `web/js/core/app.js:315-322` (`toolAny`)
  - 대비: `web/js/core/app-slots.js:549-590` (`_slotReap`) — **올바른 쪽**
  - 상수: `web/js/core/app-slots.js:21` `const SLOT_MAX=4;`
  - 생성: `web/js/ui/renderer.js:1075` `this.app.mkTool(at.toolId, at.name||'', slot)` — `slot` 은 0..3
- **현상**: 칸이 3~4개일 때 슬롯 2·3 의 터미널 인스턴스가 도구 삭제 경로에서 회수되지 않고, 조회 경로에서도 보이지 않는다.
- **비용**: `_killToolInstances` 의 바로 위 주석이 *"FR-WSL-22: 도구를 지우는 경로는 **모든 슬롯의 인스턴스**를 파괴한다. 슬롯 1 의 인스턴스가 남으면 이미 죽은 PTY 로 재연결을 시도한다"* 라고 적고 있는데, 코드는 `[pid, this.slotKey(pid,1)]` 두 칸만 돈다. 슬롯 2·3 에 같은 창을 띄운 상태에서 도구를 죽이면 그 인스턴스가 살아남아 **죽은 PTY 로 무한 재접속**한다 — 주석이 예고한 실패 모드가 그대로 남는다. `toolAny` 쪽은 `slotKey(id,focused) || id || slotKey(id,1)` 이라, 슬롯 2·3 에만 있는 도구는 상태바 `termsize`·검색·전경 이름 갱신에서 조용히 `null` 이 된다.
- **어느 쪽이 맞나**: `_slotReap` 이다. 같은 파일에서 `for(let i=1;i<SLOT_MAX;i++)` 로 순회하고 `_slotOf(k)` 로 키를 되읽어 판정한다 — `_gitPanelReap`(`app-git.js:214`)·`_slotSyncSubs`(`app-slots.js:195`)·`_slotCloseAllSubs`(`:211`) 도 전부 `SLOT_MAX` 를 돈다. `_killToolInstances`·`toolAny` 둘만 손으로 적은 목록이고, 손으로 적은 목록이 `SLOT_MAX` 가 2에서 4로 자랄 때 따라오지 못했다.
- **제안**:
  - `App.prototype.slotKeysOf(id)` 를 하나 세우고(`[id, ...Array.from({length:SLOT_MAX-1},(_,i)=>this.slotKey(id,i+1))]`), `_killToolInstances` 와 `toolAny` 가 그것을 돈다.
  - `toolAny` 는 포커스 칸 → 슬롯 0 → 나머지 칸 오름차순 순서를 유지한다(지금 의도가 그것이다).
- **위험도**: LOW (순회 범위를 넓힐 뿐 동작 규약이 바뀌지 않는다)
- **공수**: S

---

### [HIGH] H2 — 사용자 노출 영문 문자열 113개가 카탈로그 밖에 있다

- **위치** (`^const NAME='Xxx …'` 꼴, core 한정 실측 113건)
  - `constants.js` 26 — `TAB_ADD_TITLE:477` · `TAB_CLOSE_TITLE:479` · `WINDOW_CLOSE_UNDO_LABEL:488` · `WINDOW_CLOSE_UNDO_TITLE:489` · `TIP_*:495-520`(16) · `SHORTCUT_REBIND_TITLE:523` · `SHORTCUT_RESET_TITLE:524`
  - `constants-git-actions.js` 35 · `constants-git-changes.js` 17 · `constants-git-commit.js` 7 · `constants-git-refs.js` 7 · `constants-git-remote.js` 7 · `constants-git-diff.js` 6 · `constants-editor.js` 4 · `constants-git-history.js` 4
  - 상수조차 거치지 않고 인라인인 것 5곳: `app-backup.js:242` `btn.title='Revert the window layout to this generation'` · `app-attn.js:340` `title="Clear every attention alert"` · `app-settings-theme.js:67,157` `aria-label` · `app-mobile.js:124` `'Close the sidebar'`
  - 실제 도달 확인: `ui/renderer.js:919` `b.title=GIT_REFRESH_TITLE` · `ui/renderer.js:1336` `add.title=TAB_ADD_TITLE` · `app-tool.js:400` `mk('…',TIP_CLOSE_TOOL,t('core.close'))`
- **현상**: 기본 로케일이 `ko`(`i18n.js:16` `I18N_DEFAULT='ko'`)인데, 툴팁·`aria-label` 113개가 영어 리터럴로 고정돼 한국어 사용자에게 영어로 뜬다. `app-tool.js:400` 처럼 **같은 버튼의 라벨은 `t('core.close')` 이고 툴팁만 영어**인 자리가 있다.
- **비용**: `M8_UNIFIED_SRS FR-B-1`(전수 번역)이 실질적으로 절반만 서 있다. 그리고 `en` 카탈로그가 971키인데 툴팁 113개는 그 바깥이라, **로케일을 `en` 으로 바꿔도 이 문자열들은 카탈로그의 통제를 받지 않는다** — 문구를 고치려면 코드를 고쳐야 하고, 이것이 카탈로그를 만든 이유(FR-B-8 "문장의 소유가 프론트로 넘어갔다")를 무효화한다. 또 `UX_BATCH5_SRS FR-TIP-4` 는 *"문자열은 상수 표에 산다"* 까지만 요구했고 그 표가 카탈로그여야 한다는 요구로 이어지지 않아 그대로 굳었다.
- **왜 게이트가 못 잡았나** → D4 참조: `scripts/check-i18n.mjs:36` 의 `const KR = /[가-힣ㄱ-ㆎ]/` 가 **한글만** 본다. 영문 사용자 문구는 정의상 통과한다.
- **제안**:
  1. 113개를 `tip.*`·`git.tip_*` 키로 옮긴다 — `TIP_CLOSE_TOOL` → `t('tip.close_tool')`. 상수 이름은 남겨도 되고(`const TIP_CLOSE_TOOL=t('tip.close_tool')`), 그러면 호출부 0줄 변경이다(`constants.js` 가 이미 `t()` 를 그렇게 쓴다 — `:483` `CLOSE_DIRTY_MSG=t('core.close_dirty_msg')`).
  2. 인라인 5곳은 상수화 없이 곧바로 `t()` 로 간다.
  3. `check-i18n.mjs` 에 **영문 UI 문구 검출**을 더한다 — `title`·`aria-label`·`placeholder` 에 대입되는 리터럴과, `^const [A-Z_]+=` 로 선언된 2낱말 이상 영문 리터럴. 예외는 등록부에 사유와 함께 적는다(`app-mobile.js:198` 의 `FULL_NAMES` 는 `FR-TIP-2` 가 영어로 고정한 표이므로 예외 대상이다).
- **위험도**: LOW (문구만 바뀐다. 다만 e2e 가 영문 툴팁을 단정하는 자리가 있으면 함께 고쳐야 한다)
- **공수**: L (113건 + 게이트)

---

### [HIGH] H3 — 모달 골격 여섯이 `UIKit.dialogOpen` 을 건너뛴다

- **위치**
  - `app-tool.js:19` `_notify` · `:78` `_sbxRuntimeModal` · `:212` `_pickSandbox` · `:382` `_confirmClose`
  - `app-editor-file.js:154` `_edConfirm`
  - `app-statusbar.js:177` `_bgModalRender`
  - 대비(계약을 지키는 쪽): `app-settings.js:356` `releaseDlg=UIKit.dialogOpen(modal,{…})` · `app-settings-access.js:225` `UIKit.modal({…})`
  - 계약 본체: `ui/ui-kit.js:256-303` `dialogOpen(box, spec)`
- **현상**: 이 여섯은 `role="dialog"`·`aria-modal`·접근 이름·`Tab` 트랩·닫을 때 포커스 복귀를 **하나도** 갖지 않는다. `document.body.appendChild(ov)` 뒤 버튼 하나에 `.focus()` 만 준다.
- **비용**: `ACCESSIBILITY_BASELINE_SRS` 의 **D-A11Y-7** 이 이 문제를 정면으로 결정했다 — *"이 저장소에는 모달 껍데기가 일곱이다 … 골격이 일곱이어도 **계약은 한 벌이다** … 컨테이너 하나를 받는 함수(`UIKit.dialogOpen(box, spec)`)로 충분하다."* 실측하면 일곱 중 **둘만** 그 함수를 부른다(`#modal-overlay`·`.ui-modal`). 나머지 다섯 중 **셋이 core 에 있다**(`.confirm-overlay` ×5 · `.bg-modal`). 즉 FR-A11Y-18(포커스 트랩·복귀)은 설정 모달에서만 참이고, 도구 닫기 확인창·파일 삭제 확인창·백그라운드 모달에서는 `Tab` 이 모달 밖으로 새고 닫아도 포커스가 `<body>` 로 떨어진다. `TC-A11Y-8c`(Tab 60회) 는 설정 모달만 잰다.
  - 부수: `_notify`(`app-tool.js:28`)만 `document.addEventListener('keydown',onKey)` 를 **버블**로 달고 나머지 넷은 **캡처**(`:425`, `app-editor-file.js:176`)다. D-A11Y-8 이 *"캡처가 먼저 돌고 전파를 끊으므로 안쪽이 먹는다"* 로 고정한 Escape 순서가 `_notify` 에서만 깨진다 — git 다이얼로그 위에 `_notify` 가 뜨면 Escape 가 바깥을 먼저 닫는다.
  - 부수: `_notify` 만 `Enter` 도 닫기로 받는다. `_confirmClose`(`:415` FR-PDA-2)·`_edConfirm`(`app-editor-file.js:179`)는 *"`Enter` 는 가로채지 않는다"* 로 수렴했는데 `_notify` 는 그 수렴 밖이다.
- **제안**:
  - 여섯 각각에서 상자를 `document.body` 에 붙인 직후 `const release=UIKit.dialogOpen(box,{labelledBy:msgEl, label:…, focus:defBtn})` 를 부르고, 기존 `cleanup`/`done`/`_bgModalToggle(false)` 에서 `release()` 를 부른다. 골격·CSS·버튼 순서는 건드리지 않는다 — D-A11Y-7 이 그것을 분리한 이유가 그것이다.
  - `_notify` 의 keydown 을 캡처로 바꾸고 `Enter` 갈래를 뗀다(포커스가 `.confirm-ok` 에 있으므로 브라우저 기본이 같은 일을 한다).
  - `e2e/a11y-dialog.spec.ts` 의 표면 목록을 `.ui-modal` 을 가진 오버레이에서 **파생**시킨다 — FR-A11Y-13·28 이 이미 요구하는 규약이고, 손으로 적은 목록이 이 다섯을 놓쳤다.
- **위험도**: MED (`dialogOpen` 이 `TIMERS.frame` 으로 포커스를 주므로 기존 동기 `.focus()` 와 타이밍이 다르다 — `focus` 인자로 같은 버튼을 넘기면 결과는 같다)
- **공수**: M

---

### [HIGH] H4 — "활성 창 전환" 이 13곳에 흩어져 각자 다른 부분집합을 수행한다

- **위치**
  - 정본: `app-layout.js:349-385` `switchWindow(sid)`
  - 부분 수행: `app-layout.js:163,274,341,497,578,831,843` · `app-cmd.js:686,756` · `app-attn.js:227` · `app-docrender.js:168` · `app-slots.js:327,449` · `app-editor-pane.js:62`
  - 키: `sessionStorage.setItem('activeWindow', …)` — **16곳 전부 리터럴**
- **현상**: `switchWindow` 가 열 걸음을 밟는다 — ① `cur.focusedPane` 저장 ② `_rememberReturn('plain'|'editor')` ③ `ws.activeWindow=` ④ **`_slotOnSwitch(sid)`** ⑤ `sessionStorage['activeWindow']` ⑥ `sessionStorage[ACTIVE_EDITOR_ROOT_KEY]` set/remove ⑦ `setFocusState` ⑧ `mPaneIdx=0` ⑨ 드로어 닫기 ⑩ `_focusWindow`. 다른 12곳은 이 중 2~6개만 한다.
- **비용**: 둘이 구체적이다.
  - **④ `_slotOnSwitch` 누락.** `app-layout.js:158-160` 의 주석이 이 누락의 증상을 이미 기록했다 — *"화면은 `ws.activeWindow` 가 아니라 **칸이 가리키는 창**을 그린다(`slotWindow`). 이 한 줄이 없던 동안 모델만 새 창이 되고 화면은 옛 창을 그대로 보였다 — 칸이 나뉘어 있을 때만 드러났고, 그대로 접수됐다."* `addTab` 의 "이미 있는 탭으로 옮기기"(`:497`·`:578`), `app-docrender.js:168`, `app-attn.js:227`, `app-cmd.js:756` 은 전부 ④ 가 없다. 즉 칸이 나뉜 상태에서 **이미 열려 있는 편집기 탭을 다시 열거나 주의 알림을 눌러 창을 옮기면** 같은 증상이 재발한다.
  - **⑥ `ACTIVE_EDITOR_ROOT_KEY` 낡음.** 이 키를 관리하는 곳은 `switchWindow`(`:373-377`)와 `_edKeepActive`(`app-editor-pane.js:62`) **둘뿐**이다. 나머지 11곳으로 Editor 창(또는 일반 창)에 도착하면 이 키는 **직전 값 그대로** 남는다. `app.js:229-252` 의 부팅 폴백이 `activeWindow` id 를 못 찾을 때(= Repo 창이 새 id 로 재조정된 흔한 경우, D-RTU-18) 이 낡은 루트로 창을 고르므로, 새로고침 뒤 **엉뚱한 저장소의 Repo 창이 활성으로 뜬다**. D-RTU-18 이 막으려던 바로 그 실패다.
- **어느 쪽이 맞나**: `switchWindow` 다. 나머지는 전부 그 부분집합이고, 빠진 걸음들은 전부 *"없으면 조용히 틀린다"* 는 성질(④ 는 화면만 어긋남, ⑥ 은 다음 새로고침에만 드러남)을 갖는다. 다만 일부 호출부는 **의도적으로** 일부를 건너뛴다(`_mkWindow` 의 `keepFocus`, `slotRemove` 의 단일 슬롯 전환) — 그 의도는 옵션으로 표현해야지 코드 누락으로 표현하면 안 된다.
- **제안**:
  - `constants.js` 에 `const ACTIVE_WINDOW_KEY='activeWindow';` 를 세운다(`ACTIVE_EDITOR_ROOT_KEY`·`SIDEBAR_COLLAPSED_KEY` 와 같은 자리, `:227` 부근).
  - `App.prototype.activateWindow(sid, opts)` 를 `app-layout.js` 에 세운다. `opts`: `{keepFocus, skipSlot, skipReturn, skipDrawer}`. 본문은 지금 `switchWindow` 의 열 걸음이고, `switchWindow(sid)` 는 `if(this.ws.activeWindow===sid){…} ; this.activateWindow(sid)` 로 줄인다.
  - 13곳이 `this.activateWindow(x, {...})` 한 줄이 된다. 각 자리에서 **지금 무엇을 건너뛰고 있었는지**가 `opts` 로 diff 에 드러난다 — 그것이 이 리팩터의 값이다.
  - 게이트: `scripts/check-active-window.sh` — `core/` 밖에서도 `sessionStorage.setItem('activeWindow'` 가 `activateWindow` 바깥에 있으면 잡는다(`check-layer.sh` 와 같은 꼴).
- **위험도**: MED (13곳의 의도를 하나씩 옵션으로 옮겨야 한다. 승격 전 사본을 떠 두는 `FE_MODULE_BOUNDARY_SRS §7.5` 의 교훈이 그대로 적용된다)
- **공수**: M

---

### [HIGH] H5 — `TimerHub._tick` 이 `after` 콜백의 예외를 막지 않는다

- **위치**: `web/js/core/timer-hub.js:321-333` (`_tick`) · `:316` (`_reschedule` 의 `setTimeout`)
- **현상**:
  ```js
  this._nextT=setTimeout(()=>{ this._nextT=null; this._tick() }, …);
  ...
  _tick(){
    for(const [id,r] of Array.from(this._ones)){
      if(r.kind!=='after'||r.at>now) continue;
      this._ones.delete(id);
      r.fn();                      // ← 던지면 아래가 전부 죽는다
    }
    for(const j of …) if(…) this._fire(j);
    this._reschedule();            // ← 도달하지 못한다
  }
  ```
  `after` 콜백 하나가 던지면 그 tick 의 남은 `after` 들, 마감이 찬 모든 `every` job, 그리고 마지막 `_reschedule()` 이 함께 죽는다. `_nextT` 는 이미 `null` 이라 **다음 예약이 서지 않는다** — 새로운 `every`/`after` 등록이 들어올 때까지 앱의 유일한 스케줄러가 멎는다.
- **비용**: 이 저장소에서 시간은 하나다(INV-1). 멎으면 상태바·git 폴링·SSE 침묵 감시·워크스페이스 저장 홀드가 **전부** 함께 멎고, 증상은 "화면이 갱신되지 않는다" 로만 보인다 — 원인 함수와 증상이 완전히 분리된다. `EventBus.publish`(`event-bus.js:95-98`)는 정확히 이 위험을 `try{ r.fn(…) }catch(e){ console.error('[bus]',topic,e) }` 로 막고 그 주석이 *"하나가 던져도 나머지는 받는다 — 종전 if-체인은 한 분기의 예외가 그 뒤 전부를 삼켰다"* 라고 적는다. 버스는 막았고 허브는 막지 않았다. `_fire` 는 `try{ await job.run(ctx) }catch{ failed=true }` 로 막고 있으므로(`:160`) **`after` 만 구멍**이다.
- **부수**: `_fire` 의 `catch{ failed=true }` 는 예외를 **완전히 삼킨다** — `console.error` 도 `ErrorLog.push` 도 없다. `error-log.js` 가 `window.onerror`/`unhandledrejection` 을 걸어 두었지만 여기서 잡힌 예외는 둘 다에 닿지 않는다. 폴링 job 이 매 회차 던져도 아무 흔적이 남지 않고 백오프만 늘어난다(`failStreak`).
- **제안**:
  ```js
  _safe(label, fn){ try{ fn() }catch(e){ console.error('[timers]',label,e); ErrorLog.push('timer',String(e&&e.message||e),{id:label}) } }
  ```
  - `_tick` 의 `r.fn()` 과 `this._fire(j)` 를 `this._safe(id, …)` 로 감싼다.
  - `_tick` 전체를 `try{…}finally{ this._reschedule() }` 로 두른다 — `_reschedule` 은 어떤 경우에도 돌아야 한다.
  - `_fire` 의 `catch{ failed=true }` 를 `catch(e){ failed=true; console.error('[timers]',job.id,e) }` 로 바꾼다. `ErrorLog` 까지 밀지는 않는다(폴링 실패는 흔하고 50칸 버퍼를 덮는다) — 콘솔 한 줄이면 `?diag=1` 이 답할 수 있다.
  - 검사: `web/js/test/timer-hub.test.mjs` 에 "던지는 `after` 뒤에도 같은 tick 의 다른 `after` 가 돈다" · "그 뒤 `_reschedule` 이 섰다" 두 건.
- **위험도**: LOW (방어를 더하는 것뿐이다)
- **공수**: S

---

## 2. MED

### [MED] M1 — `'Shell'` 이 상수 둘 + 리터럴 셋, 판정이 리터럴에 매여 있다

- **위치**: `helpers.js:763` `DEFAULT_TOOL_NAME='Shell'` · `helpers.js:926` `TAB_NAME_DEFAULT='Shell'` · 리터럴 `app-tool.js:522` · `app-layout.js:815` · `app-presets.js:57`
- **현상**: 같은 값이 다섯 자리에 있다. 탭 레코드를 만드는 세 자리가 리터럴을 쓴다.
- **비용**: `tabNameSource()`(`helpers.js:955`)가 `return tab.name===TAB_NAME_DEFAULT?NAME_SOURCE_AUTO:NAME_SOURCE_MANUAL` 로 **값 비교**를 한다. 지금 셋이 도는 이유는 리터럴이 우연히 상수와 같기 때문이다. `TAB_NAME_DEFAULT` 를 바꾸는 순간 그 세 경로가 만든 탭은 전부 `manual` 로 분류되고, **전경 프로세스 이름 파생(FR-TAN-15·20)이 그 탭들에서만 조용히 죽는다.** 동시에 `addTab`(`app-layout.js:608`)은 `TAB_NAME_DEFAULT` 를 쓰므로 그 탭만 정상 — 같은 앱 안에서 탭마다 동작이 갈린다.
- **`DEFAULT_TOOL_NAME` vs `TAB_NAME_DEFAULT`**: 둘은 **다른 뜻**이다. 앞은 "탭이 없는 도구의 표시 이름"(`toolDisplayName` 의 최종 폴백, FR-UNI-8), 뒤는 "auto/manual 판정의 기준값"(FR-TAN-4). 값이 같다고 합치면 안 된다 — 합치면 FR-UNI-8 의 폴백을 바꾸는 순간 FR-TAN-4 의 판정이 함께 바뀐다. **주석으로 그 구분을 적고 값이 같음이 우연임을 명시**해야 한다(지금은 둘 다 `'Shell'` 이라고만 적혀 있다).
- **제안**: 리터럴 세 곳을 `TAB_NAME_DEFAULT` 로 바꾼다(탭 레코드를 만드는 자리이므로 이쪽이다). `helpers.js:926` 위에 *"`DEFAULT_TOOL_NAME` 과 값이 같은 것은 우연이다 — 저쪽은 탭 없는 도구의 표시 이름이고 이쪽은 auto/manual 판정의 기준값이다"* 를 적는다.
- **위험도**: LOW
- **공수**: S

### [MED] M2 — `_execRemote` 184줄 if-체인

- **위치**: `app-cmd.js:476-659`
- **현상**: `action` 문자열로 11갈래를 가르는 if-체인. 각 갈래가 ①인자 검증 ②`_resolveLocation` ③수행 ④`_echoResult` 를 각자 재구현한다. `_resolveLocation(args.location)` 이 5번(`:513,545,566,595,627`), "대상 없음" 경고가 4번 반복된다.
- **비용**: `EventBus._onMessage`(`event-bus.js:264`)의 주석이 이 형태를 명시적으로 떠났다 — *"**13분기 if-체인이 라우팅 테이블이 된다** (FR-BUS-4)"*. 그 리팩터는 SSE `action` 계층만 바꿨고, 그 바로 아래 `_fallback` 이 부르는 `_execRemote` 는 옛 형태 그대로다. 결과: 새 원격 명령을 더하려면 이 184줄 어디에 끼울지 판단해야 하고, `return` 을 빠뜨리면 아래 공통 경로로 떨어져 `executeAction(action)` 이 **엉뚱한 탭을 닫는다** — `FR-RUN-6b`(`:648`)가 바로 그 사고를 사후에 막은 기록이다.
- **제안**: `app-cmd.js` 에 `REMOTE_ACTIONS` 서술자 배열을 둔다. `state-registry.js:60` 의 `STATE_REGISTRY` 와 같은 모양이다.
  ```js
  const REMOTE_ACTIONS={
    focus:        {needs:'location', gate:a=>!a.sourcePane||app._isToolInActiveWindow(a.sourcePane), run:(app,a)=>app._focusLocation(a.location)},
    openUrl:      {run:(app,a)=>OpenUrl.handle(a.url)},
    openEditorTab:{require:['filePath'], run:…},
    renameTab:    {require:['location'], resolve:true, run:…, echo:false},
    newWindow:    {run:…, echo:c=>({newWindows:[c.win],newPanes:[c.pane],newTabs:[c.tab]})},
    …
  };
  ```
  `_execRemote` 는 표를 찾아 ①`require` 검증 ②`resolve` 면 `_resolveLocation` ③`_viewMark`/`_viewRestore` ④`echo` 를 **한 자리에서** 수행한다. 표에 없는 `action` 은 지금의 마지막 공통 경로(`executeAction`)로 간다.
- **위험도**: MED (11갈래의 순서·`return` 시점이 계약이다. `FR-BUS-5` 가 게이팅 순서 보존을 요구한 것과 같은 성질 — 표의 순회 순서를 지금 if-체인 순서와 같게 두어야 한다)
- **공수**: M

### [MED] M3 — 80줄 넘는 함수 14개 · 분할 경계

- **위치 / 실측** (brace 매칭, 80줄 이상):

| 줄 | 위치 | 제안 경계 |
|---|---|---|
| 203 | `app-mobile.js:163 initMobileKeybar` | M4 참조 |
| 184 | `app-cmd.js:476 _execRemote` | M2 참조 |
| 184 | `app.js:457 save` | `_saveBody()`(직렬화·PUT) / `_saveResolveConflict(res)`(409·428 · git·editors·windows 채택 · 백오프) / `_saveFlushDeferred()`(`_wsDeferRev` 처리). 지금 `run()` 안의 `while` 이 셋을 다 들고 있어 `try` 가 세 겹이다 |
| 160 | `app-layout.js:462 addTab` | `TAB_KINDS` 표 + `_addTabRun`/`_addTabGitView`/`_addTabEditor`/`_addTabTerminal`. 창 타입 가드(`:467-482`)만 `addTab` 에 남는다. M8 도 함께 해소된다 |
| 153 | `app.js:138 init` | `_initWorkspace()`(`try` 안 전부) / `_initRestoreSession()`(`sessionStorage` 복원 블록) / `_initWire()`(`_bind`~`_initSlots`). 지금 `try{…}catch{}` 가 155~262 두 덩이로 앉아 있어 어디까지가 한 단계인지 이름이 없다 |
| 149 | `app-tool.js:212 _pickSandbox` | 모달 DOM 조립 / 프로파일 목록 그리기 / 작업방식 라디오 / 최근 경로. H3 의 `dialogOpen` 도입과 같은 커밋이 자연스럽다 |
| 147 | `app-cmd.js:317 _applyRemoteWorkspace` | — 응집도가 있다. 분할하지 않는 쪽을 권한다 |
| 145 | `app-layout.js:623 closeTab` | 확인창 갈래 / 도구 처분 갈래 / 레이아웃 붕괴 갈래 |
| 133 | `app-settings.js:314 initModal` | 탭 배선 / 열기·닫기 / `dialogOpen` |
| 108 | `app-layout.js:185 delWindow` | 확인 / 도구 정리 / undo 무장 |
| 97·89 | `app-settings-theme.js:37,135` | — 렌더 함수다. 그대로 둔다 |
| 85 | `app-cmd.js:70 _subscribeCommands` | — 배선 나열이다. 그대로 둔다 |
| 83 | `app-tool.js:78 _sbxRuntimeModal` | — 그대로 둔다 |

- **파일 단위 분할 경계** (요청된 7파일):
  - `helpers.js`(1,136): 섹션 주석이 이미 8개다 — `:5 Shortcut parsing` `:30 경로 잇기` `:158 HTML escaping` `:176 Theme helpers` `:308 Shortcut state` `:459 Status bar state` `:637 Layout helpers` `:924 탭 이름의 출처`. `helpers-path.js`(30-175, 순수·테스트 가능) · `helpers-theme.js`(176-307) · `helpers-layout.js`(637-923) 셋을 떼면 helpers.js 가 ~450줄이 된다. **D3 참조** — `FE_MODULE_BOUNDARY_SRS §5 N4` 가 이 분할을 비목표로 두었으나 그 근거("주제가 하나")가 지금 성립하지 않는다. 뒤집으려면 N4 를 개정해야 한다.
  - `app-layout.js`(997): `addTab`·`closeTab`·`split` 이 566줄이다. `app-layout-tab.js`(`:396-785`)로 떼면 창 생성·삭제·전환(`:93-395`)과 pane 이동·사이드바(`:786-997`)가 남는다.
  - `app-git.js`(880): `:8-315` 레지스트리·패널 수명 / `:316-500` 좌측 GIT 섹션·열기 / `:501-880` 관측·핀·폴링. `app-git-observe.js` 하나만 떼도 셋 중 가장 응집된 덩이가 나간다.
  - `app-cmd.js`(787): M2 의 `REMOTE_ACTIONS` 표를 `constants-remote-actions.js` 로 빼면 `_execRemote` 가 ~40줄이 되고 파일이 ~600줄이 된다.
  - `app-slots.js`(719): 섹션 주석 9개가 이미 있고 응집도가 좋다. **분할하지 않는 쪽을 권한다.**
  - `constants.js`(681): `constants-git*.js` 가 이미 8벌로 갈린 관행이 있다(`FR-FMB-3`). `constants-tip.js`(툴팁 26개, H2 와 같은 커밋) · `constants-mobile.js`(`:144-172` MKB_*·MTI_*) 둘을 떼면 ~500줄.
  - `app.js`(677): M3 의 `init`·`save` 분할 후 `app-save.js`(`:457-640`)를 떼면 ~440줄. 클래스 본문이므로 `Object.assign(App.prototype,…)` 증강이다 — `FR-FMB-10` 의 묶음 B 와 같은 절차.
- **위험도**: LOW(구간 이동) ~ MED(`save`·`addTab` 은 흐름이 얽혀 있다)
- **공수**: M

### [MED] M4 — `initMobileKeybar` 203줄

- **위치**: `app-mobile.js:163-365`
- **현상**: 한 함수가 ①키 서술자 표 19개(`:167-199`) ②`FULL_NAMES` 표(`:200-212`) ③툴팁 show/hide DOM(`:223-232`) ④버튼 19개 × 리스너 6개 배선(`:233-345`) ⑤`visualViewport` 배선(`:356-364`)을 전부 한다.
- **비용**: ①②는 **데이터**인데 함수 스코프 안에 있어 테스트·게이트가 닿지 못한다(`MKB_LONG_PRESS_MS` 등 시간 상수는 `constants.js:144-147` 에 이미 나가 있는데 키 목록만 남았다). ④는 버튼마다 `lastTap`·`pressTimer`·`longPressFired`·`startPt`·`moved`·`lastTouchEndAt` 여섯 변수와 `cancelPress`/`activate` 두 클로저를 닫는다 — 19벌이 동시에 산다. `activate()` 안에 `kb`/`raw`/`mod`/`send` 네 갈래가 또 들어 있어 실제 분기 깊이가 4단이다.
- **제안**:
  - `constants.js`(또는 새 `constants-mobile.js`)로 `MKB_KEYS`·`MKB_FULL_NAMES` 를 뺀다. `FR-TIP-2` 가 `MKB_FULL_NAMES` 를 영어로 고정했으므로 H2 의 게이트 예외 등록부에 사유와 함께 적는다.
  - `_mkbTip()` / `_mkbTipHide()` 를 메서드로 올린다(`#mkb-tip` 은 문서에 하나뿐이다 — `UIKit._hudEl` 과 같은 규약).
  - `_mkbActivate(k)` 를 메서드로 올린다 — 네 갈래가 `k` 만 있으면 되고 클로저 변수를 보지 않는다.
  - `_mkbButton(k)` 가 버튼 하나를 만들어 돌려준다. 제스처 상태 여섯은 그 함수의 지역으로 남는다(그것은 진짜로 버튼별 상태다).
  - `_mkbVvWatch()` 로 `visualViewport` 배선을 뗀다.
  - 남는 `initMobileKeybar` 는 `bar.innerHTML=''` + `for(const k of MKB_KEYS) bar.appendChild(this._mkbButton(k))` + `this._mkbOverflowWatch(bar)` + `this._mkbVvWatch()` 로 ~10줄.
- **위험도**: LOW (구간 이동 + 메서드 승격. 리스너 부착 순서가 보존되면 동작 불변)
- **공수**: M

### [MED] M5 — 저장소 키가 상수와 리터럴로 갈려 있다

- **위치**

| 키 | 상수 | 리터럴 사용처 |
|---|---|---|
| `activeWindow` | **없음** | 16곳 (H4) |
| `sidebarWidth` | **없음** | `app.js:184` · `app-cmd.js:454` · `index.html:38` |
| `lspDiagnostics` | `LSP_DIAG_KEY` (`constants-editor.js:239`) | `helpers.js:628` **리터럴** / `app-lsp.js:612` 상수 — **한 키를 두 방식으로** |
| `lspServerPaths` | **없음** | `helpers.js:632` (읽기 전용 — D1) |
| `agentsPanelOpen` | 없음 | `app-agents.js:56` |
| `agentsGroupFold` | 없음 | `app-agents.js:199,208` |
| `agentsPollMs` | 없음 | `app-polling.js:162,164` (이관 대상) |
| `dm.sbx.recent` | 없음 | `app-tool.js:199,208` |
| `attnDesktop` · `attnSound` | 없음 | `app.js:328,329,348,353` |
| `displayMode` · `mobileBreakpoint` · `focusedPanes` | 없음 | `app.js:71,79,86,254` |
| `dm.themeVars` · `dm.themeFollow` | `THEME_VARS_KEY`·`THEME_FOLLOW_KEY` | `index.html:49` 리터럴 (M9) |
| `dm.locale` | `I18N_STORAGE_KEY` | `index.html:53` 리터럴 (M9) |
| `sidebarCollapsed` | `SIDEBAR_COLLAPSED_KEY` | `index.html:38` 리터럴 (M9) |

- **현상**: 같은 종류의 값인데 절반은 상수, 절반은 리터럴이다. `lspDiagnostics` 는 **같은 키가 한 파일에서는 리터럴이고 다른 파일에서는 상수**다 — `constants-editor.js` 가 `helpers.js` 보다 먼저 로드되므로(`index.html:664` vs `:685`) `helpers.js:628` 이 `LSP_DIAG_KEY` 를 못 써서가 **아니다**.
- **비용**: 키 이름을 바꾸거나 접두(`dm.`)를 통일할 때 grep 이 유일한 안전망이 된다. 그리고 키가 상수가 아니면 "이 앱이 브라우저에 무엇을 저장하는가" 를 한 화면에서 답할 자리가 없다 — 사생활 모드 대응·초기화 기능·백업(`app-backup.js`)이 전부 그 목록을 필요로 한다.
- **제안**: `constants.js` 에 `// ── 브라우저 저장소 키 ──` 절을 세우고 전부 모은다. `dm.` 접두가 있는 것과 없는 것이 섞여 있는데 **접두는 건드리지 않는다**(값이 바뀌면 사용자 설정이 초기화된다) — 상수 이름만 통일한다. 게이트 `scripts/check-storage-keys.mjs`: `localStorage.`/`sessionStorage.` 에 넘어가는 첫 인자가 리터럴이면 잡는다(`index.html` 은 예외, M9 가 따로 덮는다).
- **위험도**: LOW
- **공수**: S

### [MED] M6 — `const t=` 가 전역 `t()` 를 30곳에서 가린다

- **위치** (core 실측 30곳, 대표)
  - 스냅샷 토큰 7곳: `app-agents.js:27` · `app-attn.js:97` · `app-cmd.js:241` · `app-focus.js:314` · `app-settings.js:277` · `app-tool.js:454` · `app-update.js:21` — 전부 `const t=this._restoreBegin('…')`
  - 엔터티 id 2곳: `app-tool.js:520` · `app-layout.js` 의 `const t=newEntityId()` 계열
  - DOM 요소: `app-settings.js:189` · `app-slots.js:603,617` · `app-statusbar.js:122`
  - 테마: `app-settings-theme.js:16,50,77,92,136`
  - 반복 변수: `app-polling.js:117` `for(const [v,t] of spec.opts)`
- **현상**: 전역 `t(key)` 가 이 스코프들 안에서 가려진다.
- **비용**: `check-i18n.mjs:checkShadow`(`:212`)가 *"`t()` 이 지역 이름 `t`(N행)에 가려진다 — 지역 이름을 바꿔라"* 로 **호출이 실제로 있을 때만** 잡는다. 지금은 30곳 어디에도 `t()` 호출이 없어 초록이다. 즉 게이트는 **사고가 일어난 뒤에** 울리고, 그때 개발자는 "왜 여기서만 번역이 안 되지" 가 아니라 CI 실패를 보게 된다(이쪽이 낫긴 하다). 문제는 `app-settings-theme.js` 처럼 `const t=THEMES[name]` 이 다섯 번 나오는 렌더 함수에 문구를 하나 넣는 것이 **정상적인 다음 변경**이라는 점이다.
- **제안**: 의미를 담은 이름으로 바꾼다 — `flight`(스냅샷 토큰) · `tabId`(엔터티 id) · `theme`(테마) · `el`(DOM) · `label`(`app-polling.js:117`). `check-i18n` 의 `checkShadow` 를 **호출 유무와 무관하게** 전역 `t`/`tn` 가려짐 자체를 잡도록 넓히고, 이 30곳을 정리한 뒤 게이트를 조인다.
- **위험도**: LOW (지역 이름만 바뀐다)
- **공수**: S

### [MED] M7 — 빈 `catch{}` 67개

- **위치**: `app-layout.js` 12 · `app.js` 10 · `app-slots.js` 10 · `app-cmd.js` 4 · `app-attn.js` 4 · `helpers.js` 3 · `event-bus.js` 3 · `app-tool.js` 3 · `app-mobile.js` 3 · `app-backup.js` 3 · `app-agents.js` 3 · 그 외 7파일
- **현상**: 대부분은 정당하다 — `try{localStorage.setItem(…)}catch{}` 는 사생활 모드 대응이고 그 사실이 여러 곳에 주석으로 적혀 있다(`app-docrender.js:168` 이 `/* 사생활 모드 */` 로 명시).
- **정당하지 않은 것 셋**:
  1. `app.js:229-262` — `sessionStorage` 복원 블록 **전체**가 하나의 `try{…}catch{}` 다. 그 안에 `this._restoreReturn()`(`:252`)과 `JSON.parse(savedFocus)`(`:256`)가 들어 있다. `focusedPanes` 가 깨진 JSON 이면 **그 뒤의 pane 포커스 복원이 통째로 건너뛰어지고** 아무 흔적이 없다. 저장소 접근과 로직이 한 `try` 에 있다.
  2. `app.js:551` — 409 충돌 해소의 `try{ const gr=await apiGet('/api/workspace'); … }catch{}`. `apiGet` 은 던지지 않는다고 `api.js` 머리가 명시하므로(*"던지지 않는다"*), 이 `catch` 가 실제로 잡는 것은 `_edPatchList`·`_edReconcile`·`_applyRemoteWorkspace` 의 예외다 — **워크스페이스 채택 실패가 완전히 무음**이 된다. `FR-WSC-2` 가 "창까지 채택한다" 로 고친 그 경로다.
  3. `timer-hub.js:160` `catch{ failed=true }` — H5 참조.
- **제안**:
  - `app.js:229-262` 를 셋으로 가른다: `try{…}catch{}` 는 **`sessionStorage.getItem` 호출 하나만** 감싸고, 파싱·적용은 밖으로 뺀다. `JSON.parse` 는 별도 `try` 로 감싸되 `console.warn('[init] focusedPanes 파싱 실패',e)` 를 남긴다.
  - `app.js:551` 의 `catch{}` 를 `catch(e){ console.error('[save] 충돌 해소 실패',e) }` 로 바꾼다.
  - `error-log.js` 의 `ErrorLog.push` 를 "삼키되 남긴다" 용 손잡이로 노출한다 — `app-reload.js:88` 의 `_softStep` 이 이미 그 패턴(*"한 갈래의 실패를 삼키되 삼킨 사실은 남긴다"*)을 갖고 있다. 그것이 정본이다.
  - 게이트: 저장소 접근(`localStorage`/`sessionStorage`) **한 줄만** 감싼 `catch{}` 는 허용, 그 밖의 빈 `catch{}` 는 잡는다.
- **위험도**: LOW
- **공수**: M

### [MED] M8 — `addTab` 의 "이미 있는 탭으로 옮기기" 3벌이 미묘하게 다르다

- **위치**: `app-layout.js:494-505`(run) · `:576-589`(editor) · `:531-538`(git view)

| 걸음 | run | editor | git view |
|---|---|---|---|
| `cur.focusedPane=this.focused` | ✅ | ✅ | ❌ |
| `ws.activeWindow=` + sessionStorage | ✅ | ✅ | ❌ |
| `_slotOnSwitch` | ❌ | ❌ | ❌ |
| `paneTabSet` + `setFocusState` | ✅ | ✅ | ✅ |
| `_focusWindow` | ✅ | ✅ | ❌ |
| `editor.refresh()` | — | ✅ | — |
| 반환값 | `return;` | `return;` | `return {uuid}` |

- **현상**: git view 가 적게 하는 것은 **정당하다** — `findGitViewTab(s, view)` 가 그 창 안에서만 찾으므로(FR-RTU-31: *"저장소마다 자기 History 가 있어야 한다"*) 창을 옮길 일이 없다. run/editor 는 `_findRunTab`·`_findEditorTab` 이 전 창을 뒤지므로 창 전환이 필요하다.
- **정당하지 않은 차이 둘**:
  1. **반환값.** run/editor 는 기존 탭을 찾았을 때 `undefined` 를 주고 git view 는 `{uuid}` 를 준다. `_execRemote` 의 `newTab`(`app-cmd.js:558`)이 `.then((tab)=>{ if(args.reqId&&tab) this._echoResult(…) })` 로 받으므로, **이미 열려 있는 탭으로 옮겨 간 경우 echo 가 나가지 않는다** — `dmctl` 쪽에서는 `timedOut` 으로 읽힌다(`M8 D-A-25`). 셋 다 `{uuid}` 를 주는 쪽이 맞다.
  2. **`_slotOnSwitch` 누락 셋 다.** H4 참조. run/editor 는 창을 바꾸므로 반드시 필요하다.
- **제안**: `_focusExistingTab(win, pane, tab, opts)` 를 하나 세운다. `activateWindow`(H4)를 부르고, `paneTabSet`·`setFocusState`·`render`·`save` 를 하고, `{uuid:tab.id}` 를 돌려준다. git view 는 `{sameWindow:true}` 로 창 전환을 건너뛴다. M3 의 `addTab` 분할과 같은 커밋으로 처리한다.
- **위험도**: LOW
- **공수**: S

### [MED] M9 — `index.html` 선주입 스크립트가 상수 6개를 손으로 동기화한다

- **위치**: `index.html:38`(`sidebarWidth`·`100`·`400`·`sidebarCollapsed`·`sb-collapsed`) · `:49`(`dm.themeVars`·`dm.themeFollow`) · `:53`(`dm.locale`·`'en'`/`'ko'`)
- **현상**: 첫 페인트 전에 돌아야 하므로 `constants.js` 를 볼 수 없다. 주석 셋이 전부 그 사실과 *"고칠 때 `web/js/core/constants.js` 의 그 둘을 함께 고친다"* 를 적는다.
- **비용**: 집행자가 **사람의 눈**이다. 이 저장소의 나머지는 정확히 그 이유로 게이트를 세웠다 — `check-load-order`·`check-shortcuts-docs`·`check-css-vars`·`check-i18n`·`check-env-docs` 가 전부 "두 곳이 같은가" 를 잰다. `SPLIT_REFACTOR_SRS` 의 *"손으로 적은 목록은 새 항목을 놓친다"* 가 여기에만 적용되지 않았다. 어긋나면 증상은 "새로고침할 때 사이드바가 한 번 펄럭인다"·"첫 페인트가 기본 테마다" 로, e2e 가 잡기 어려운 것들이다.
- **제안**: `scripts/check-boot-inline.mjs` — `index.html` 의 `<head>` 인라인 `<script>` 에서 문자열·숫자 리터럴을 뽑아 `constants.js`/`i18n.js` 의 `THEME_VARS_KEY`·`THEME_FOLLOW_KEY`·`SIDEBAR_COLLAPSED_KEY`·`SIDEBAR_W_MIN_PX`·`SIDEBAR_W_MAX_PX`·`I18N_STORAGE_KEY`·`I18N_LOCALES` 와 대조한다. `sidebarWidth` 는 상수가 없으므로 M5 에서 먼저 세운다. 검출 확인용 탐침을 넣었다 지우는 `FR-FMB-43` 의 규약을 따른다.
- **위험도**: LOW (게이트만 더한다)
- **공수**: S

---

## 3. LOW

### [LOW] L1 — 잔여 하드코딩

- **위치 / 값**
  - `app-tool.js:544` `apiPost('/api/tools?cols=120&rows=40'+q)` — 초기 PTY 치수. `constants.js` 에 `TOOL_INIT_COLS=120`·`TOOL_INIT_ROWS=40` 이 없다. 쿼리도 손으로 이어 붙이는데 `api.js:apiUrl(path, query)`(`:53`)가 이미 `URLSearchParams` 조립을 제공한다 — `apiPost('/api/tools',null,{query:{cols:…,rows:…,cwd,…}})` 가 이 겹이 존재하는 이유(FR-CAPI-6: *"호출자가 `encodeURIComponent` 를 빠뜨릴 자리가 없다"*)다. 지금은 `q` 를 손으로 `encodeURIComponent` 하고 있다(`:531-542`).
  - `app-tool.js:573-582` `_kill(pid)` / `_killTool(pid)` — 본문 3줄이 같고 `await` 유무만 다르다. `_kill` 이 `_killTool` 을 부르고 `await` 하는 형태로 줄일 수 있다.
  - `app.js:79,86` `mobileBreakpoint` 의 `320`·`2000`·`768` 이 getter/setter 둘에 각각 박혀 있다. `SETTINGS_SCHEMA` 에 없는 값이지만(기기별) `constants.js` 로 뺄 자리다.
  - `app-mobile.js:414` `return isFinite(v)?v:38` — `--m-kb-h` 폴백 38px 이 CSS 와 여기 두 곳에 있다.
- **제안**: 위 넷을 `constants.js` 의 해당 절로 옮기고, `_newTool` 의 쿼리 조립을 `apiUrl` 에 넘긴다.
- **위험도**: LOW · **공수**: S

### [LOW] L2 — 오류 알림 관용구 5벌

- **위치**: `main.js:93` · `app-cmd.js:538,559` · `app-layout.js:928` · `app.js:384`
- **현상**: `.catch(err=>this._notify(t('core.open_window_fail')+' — '+((err&&err.message)||err)))` 가 문자열 조립까지 그대로 5번.
- **제안**: `App.prototype._notifyErr(key, err){ this._notify(t(key)+' — '+((err&&err.message)||err)) }`. `api.js:apiErrText(r, what)`(`:145`)가 이미 "봉투 → 사용자 문장" 을 한 자리로 모았으므로, 이쪽은 "예외 → 사용자 문장" 의 짝이다.
- **위험도**: LOW · **공수**: S

### [LOW] L3 — `main.js` 가 부트스트랩이 아니다

- **위치**: `main.js:35-95` (`#add-window` 클릭 핸들러 61줄)
- **현상**: 파일 머리가 `bootstrap entry point` 인데, 샌드박스 런타임 확인 → 프로파일 조회 → `_pickSandbox` → 진행 토스트 → `addWindow` 까지 전 흐름을 들고 있다. `App.prototype` 의 다른 `_init*` 들과 달리 이 배선만 모듈 최상위에 있다.
- **비용**: `app-tool.js` 가 `_sbxRuntime`·`_sbxRuntimeModal`·`_pickSandbox`·`_sbxProgress`·`_sbxRemember` 다섯을 갖고 있는데 그것을 **엮는 순서**만 다른 파일에 있다. 샌드박스 창 생성 흐름을 읽으려면 두 파일을 열어야 하고, 같은 흐름을 다른 진입점(예: 명령 팔레트·`dmctl`)에서 부르려면 복사해야 한다.
- **제안**: `App.prototype._sbxAddWindow()` 로 옮기고 `main.js` 는 `document.getElementById('add-window').addEventListener('click', e=>app._sbxAddWindow(e))` 한 줄로 남긴다. `executeAction.newWindow`(`app.js:377`)와 같은 규약(*"버튼과 단축키가 같은 함수를 부른다"* — `FR-WSL-51·74`·`FR-PSC-3` 이 반복해 적은 것)이 된다.
- **위험도**: LOW · **공수**: S

---

## 4. 성능 개선 기회

### [MED] P1 — `_pollStats` 가 3왕복을 직렬로 돈다

- **위치**: `app-statusbar.js:33-45`
  ```js
  const ping=await apiGet('/api/ping');     // ①
  const st=await apiGet('/api/stats');      // ②
  await this._pollGitJobs();                // ③ → app-git.js:849 apiGet('/api/git/jobs'…)
  ```
- **현상**: 주기는 `statsInterval`(기본 3000ms, **하한 1000ms** — `settings-schema.js:32`). 매 회차 세 요청이 앞의 답을 기다린다.
- **비용**: RTT 를 `r` 이라 하면 한 회차가 `3r`. LAN 에서 `r≈5ms` 면 무시할 수 있지만, 이 제품은 `start.sh --expose` 로 원격 접속을 명시 지원한다(`helpers.js:768` 의 `newUUID` 주석이 그 시나리오를 적는다). `r=80ms` 면 240ms 이고, `statsInterval=1000` 으로 내린 사용자에게는 주기의 **24%** 가 대기다. 그리고 ①은 **지연 측정 자체가 목적**이라(`:35-38`) ②③ 뒤에 붙으면 측정이 오염되지만, 앞에 두는 것만으로 충분하고 ②③이 직렬일 이유는 없다.
- **제안**:
  ```js
  const t0=performance.now();
  const ping=await apiGet('/api/ping');             // 지연 측정은 홀로
  this._latency=ping.status?Math.round(performance.now()-t0):null;
  const [st]=await Promise.all([apiGet('/api/stats'), this._pollGitJobs()]);
  if(st.ok&&st.data) this._stats=st.data;
  this.updateStatusBar();
  ```
  ①의 순수성은 유지되고 ②③만 겹친다. `TimerHub` 의 `overlap:'drop'` 기본값이 회차 겹침을 이미 막으므로(`timer-hub.js:148`) 추가 가드가 필요 없다.
- **측정**: `?diag=1` 오버레이가 `TIMERS.pending()`(`:361`)의 `inflight` 를 읽는다. `performance.mark`/`measure` 로 `_pollStats` 구간을 재고, `r=80ms` 를 에뮬레이션(DevTools throttling)해 전후 비교. 기대: 회차당 `3r → 2r`(약 33% 단축).
- **위험도**: LOW · **공수**: S

### [LOW] P2 — `doSearch` 가 키 입력마다 `getComputedStyle` 3회

- **위치**: `app-search.js:99-101`
  ```js
  const accent=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const ab=getComputedStyle(document.documentElement).getPropertyValue('--accent-border').trim();
  const danger=getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
  ```
- **현상**: `doSearch('next')` 는 `incremental:true` 로 타이핑마다 불린다. `getComputedStyle` 은 호출마다 스타일 재계산을 강제할 수 있고, 여기서는 같은 요소에 **세 번** 부른다.
- **비용**: 검색 입력 중의 프레임 지터. 절대값은 작지만 `xterm` 검색 하이라이트와 같은 프레임에 걸린다.
- **제안**: 두 단계.
  1. 즉시: `const cs=getComputedStyle(document.documentElement)` 한 번 잡고 세 번 읽는다(지역 이름 `cs` 는 `:90` 의 `const cs=this._searchOpt('search-case')` 와 충돌하므로 `rootStyle` 로 둔다). 3회 → 1회.
  2. 근본: 이 세 값은 `themeVarsOf()`(`helpers.js:210`)가 이미 만들어 `localStorage[THEME_VARS_KEY]` 에 캐시하는 맵 안에 있다. `applyThemeObj`(`:283`)가 그 맵을 메모리에도 들고(`var currentThemeVars=vars`) 검색이 그것을 읽으면 `getComputedStyle` 이 **0회**가 된다. `DESIGN_TOKENS_SRS FR-TOK-13`(*"대비 파생은 여기 한 자리에서만 일어난다"*)의 연장이다.
- **측정**: DevTools Performance 로 검색어 20자 타이핑을 기록하고 `Recalculate Style` 이벤트 수를 센다. 기대: 60 → 0.
- **위험도**: LOW · **공수**: S

### [LOW] P3 — 키바가 리스너 114개와 클로저 19벌을 든다

- **위치**: `app-mobile.js:233-345`
- **현상**: 버튼 19개 각각에 `mousedown`·`touchstart`·`touchmove`·`touchcancel`·`touchend`·`click` 여섯 리스너와 상태 변수 여섯을 닫는 클로저 둘(`cancelPress`·`activate`)이 붙는다.
- **비용**: 누수는 **아니다** — `initMobileKeybar` 는 `InputBinding.bind()`(`ui/input-binding.js:231`)에서 **한 번만** 불리고, 다시 불려도 `bar.innerHTML=''`(`:166`)이 버튼과 리스너를 함께 버린다. 비용은 모바일 첫 렌더의 고정 비용과 메모리이며, `activate` 가 `k`·`this`·`full`·`refresh`·`sendToFocused`·`showTip` 를 닫아 함수 스코프 전체가 버튼 수명만큼 산다.
- **제안**: M4 의 `_mkbActivate(k)` 메서드 승격이 그대로 이 문제를 푼다 — 클로저가 잡는 것이 `k` 하나로 줄고 `sendToFocused`·`showTip` 도 메서드가 된다. 리스너 수를 줄이려면 `bar` 하나에 위임(`event delegation`)하고 `e.target.closest('.mkb-btn')` 으로 가르는 길이 있으나, **권하지 않는다** — `touchstart`/`touchmove` 의 롱프레스·슬롭 판정이 버튼별 상태를 요구하고, 위임하면 그 상태를 `WeakMap` 으로 다시 들어야 해서 지금보다 복잡해진다.
- **측정**: `getEventListeners(document.getElementById('mobile-keybar'))` 와 Memory 프로필의 retained size. 개선은 메모리만이고 체감 가능한 수준은 아니다 — **M4 의 부수 효과로만 처리**하고 이것만을 위한 작업은 권하지 않는다.
- **위험도**: LOW · **공수**: S (M4 에 포함)

---

## 5. 문서-구현 괴리

### [HIGH] D1 — `lspServerPaths` 를 편집할 UI 가 없다 — FR-LSP-3·4①·46④ 가 영구 미도달

- **위치**
  - `helpers.js:622` `var lspServerPaths={};`
  - `helpers.js:631-634` `localStorage.getItem('lspServerPaths')` — **읽기만 한다**
  - `app-lsp.js:33` `_lspOverrides(){ return lspServerPaths||{} }`
  - `app-lsp.js:42,505` `apiPost(LSP_STATUS_API,{overrides:this._lspOverrides()})`
  - 설정 화면: `index.html:431-438` — `#lsp-hint` · `#lsp-list` · `#lsp-diag` 셋뿐
  - 전수 확인: `grep -rn 'lspServerPaths' web/js/ e2e/` → **`setItem` 0건**
- **현상**: `localStorage['lspServerPaths']` 에 쓰는 코드가 저장소 전체에 없다. 따라서 `_lspOverrides()` 는 **언제나 `{}`** 이고, 서버로 가는 `overrides` 는 항상 빈 표다.
- **비용**: `EDITOR_LSP_SRS` 는 **문서 상태: 승인·구현완료** 다. 그 문서가 요구하는 것:
  - `FR-LSP-3` *"사용자는 **서술자를 설정으로 더하거나 덮을 수 있다**(I-3). 확장자와 실행 명령을 짝지어 적는 표이며, 기본 셋도 그 표에서 덮인다."*
  - `FR-LSP-4` *"탐색의 순서는 셋이다: ① 사용자가 설정에 적은 절대경로 ② `PATH` ③ 전용 디렉터리"* — **①이 영구히 비어 있다.** 실효 순서는 ②③ 둘이다.
  - `FR-LSP-46` *"설정에 **Editor ▸ 코드 탐색** 자리가 있다: 언어별 상태 · 설치 버튼 · 진단 토글, 그리고 **서술자 표(FR-LSP-3)**"* — 앞의 셋은 있고 **넷째가 없다**.
  - 서버 쪽은 `{overrides}` 를 받는 계약이 이미 서 있으므로(`LSP_STATUS_API`), **없는 것은 화면뿐이다.**
  - 코드 주석이 이 사실을 알고 있다: `app-lsp.js:31` *"M1 에서 이 표는 비어 있다 — 그것을 편집하는 자리는 M5 의 것이다."* 그러나 M5 요구(FR-LSP-44~48)는 같은 문서에 있고 그 문서는 구현완료로 닫혔다. **주석이 아는 것을 문서 상태가 모른다.**
- **제안**: 둘 중 하나를 고르되 **지금의 중간 상태는 유지하지 않는다**.
  - (A) UI 를 세운다 — `index.html` 의 `#lsp-list` 아래에 `#lsp-overrides` 표(확장자·절대경로 두 칸, 행 추가/삭제)를 두고 `app-lsp.js` 에 `_lspOverridesPaint()`/`_lspOverrideSet(id,path)` 를 더한다. 저장은 `LSP_PATHS_KEY` 상수(M5)로 `localStorage` 에, 반영은 `_lspStatusInvalidate()` + `_lspRefresh()`. 서버 계약은 이미 있으므로 프론트만이다.
  - (B) SRS 를 개정한다 — FR-LSP-3·4①·46④ 를 **철회**하고 `lspServerPaths`·`_lspOverrides`·요청의 `overrides` 필드를 걷는다. 지금 남아 있는 것은 도달 불가능한 코드다.
  - **(A) 를 권한다.** `FR-LSP-4 ③`(전용 디렉터리)가 설치 기능과 묶여 있어 사용자가 직접 넣은 서버(예: `mise`·`asdf`·`nix` 로 깐 `gopls`)를 가리킬 길이 지금 **없고**, 그것이 ①이 존재하는 이유다.
- **위험도**: LOW(A — 새 화면, 기존 경로 불변) / MED(B — 서버 계약까지 걷는다)
- **공수**: M(A) / S(B)

### [MED] D2 — 500줄 초과 파일 DoD 가 22 → 26 으로, 최대 파일이 1,336 → 1,586 으로 역행

- **위치**: `docs/internal/FE_MODULE_BOUNDARY_SRS.md §4.3`(DoD 수치 기록 요구) · `§7.1`(실행 결과)
- **기록 vs 실측**

| 지표 | §2.1 기준선 (2026-09-12) | §7.1 달성 기록 | **지금 실측** |
|---|---|---|---|
| `web/js` 합계 | 38,586줄 | — | **44,393줄** (+15%) |
| 500줄 초과 파일 | 27 | **22** | **26** |
| 최대 파일 | `ui/renderer.js` 1,336 | 1,336 (N3 로 비목표) | `ui/renderer.js` **1,586** (+19%) |

- **비용**: `§4.3` 이 *"분할 후 500줄 초과 파일 수와 최대 파일 줄 수를 기록한다(로드맵 §M6 DoD)"* 로 이 수치를 DoD 로 올렸는데, **그 DoD 에는 게이트가 없다.** 이 저장소의 다른 24종 게이트가 전부 "두 곳이 같은가" 를 재는데, 유일하게 수치 DoD 만 문서에 적히고 집행되지 않아 8일 만에 4파일이 되돌아왔다. `§4.3` 이 수치를 요구한 이유(*"값을 옮기는 것보다 다시 흩어지지 않게 하는 것이 본체다"* — `FR-FMB-43`)가 자기 자신에게 적용되지 않았다.
- **제안**: `scripts/check-file-size.mjs` — `web/js`(vendor 제외)의 500줄 초과 파일 수와 최대 줄 수를 세어, `docs/internal/FE_MODULE_BOUNDARY_SRS.md §7.1` 의 표와 대조하고 **악화하면 실패**한다. 개선은 통과시키되 표를 갱신하라고 안내한다(`check-error-docs.sh` 가 생성물과 코드를 대조하는 것과 같은 꼴). 기준선을 지금 값(26 / 1,586)으로 다시 잡을지, 22 / 1,336 으로 되돌릴지는 로드맵의 결정이다 — **게이트를 먼저 세우고 기준선을 정하는 순서**를 권한다.
- **위험도**: LOW (게이트만 더한다) · **공수**: S

### [MED] D3 — `helpers.js` 979 → 1,136, 섹션 8개 — N4 비목표의 전제가 깨졌다

- **위치**: `FE_MODULE_BOUNDARY_SRS.md §5 N4` · `web/js/core/helpers.js`
- **기록**: N4 가 `helpers.js`(**979**) 분할을 비목표로 두며 근거를 *"`FE-9`~`13` 에 없다. **각자 주제가 하나이고 이름이 이미 답한다**(`FR-MSP` N3 와 같은 근거)"* 로 적었다.
- **실측**: 1,136줄. 최상위 섹션 구분선 **8개**:
  `:5 Shortcut parsing` · `:30 경로 잇기` · `:158 HTML escaping` · `:176 Theme helpers` · `:308 Shortcut state` · `:459 Status bar state` · `:637 Layout helpers` · `:924 탭 이름의 출처`
  그 외에 git 헬퍼 5개(`gitGroupTruncated`·`gitGroupEntries`·`gitStateChar`·`gitSubParts`·`gitBadgeStale`)와 폴링 래퍼(`visiblePoll`)가 구분선 없이 꼬리에 붙어 있다.
- **비용**: N4 의 근거는 *"주제가 하나"* 였고 그것이 지금 참이 아니다. 실질적 영향 셋:
  1. `FE_MODULE_BOUNDARY_SRS` 가 `constants-git.js` 분할을 정당화한 논거 `FR-FMB-3`(*"그 사이 파일이 1,245 → 1,325줄로 자랐다. 섹션이 이미 스무 개다"*)이 `helpers.js` 에 **그대로** 적용된다(979 → 1,136, 섹션 8개).
  2. `C-5`(격리 하네스가 전역을 손으로 싣는다)가 `helpers.js` 에도 걸린다 — `web/js/test/path-relative.test.mjs`·`font-size.test.mjs` 가 순수 함수를 재려면 1,136줄 전체의 전역(`app`·`THEMES`·`SETTINGS_BY_KEY`…)을 함께 감당해야 한다. 경로 함수 7개(`:30-157`)는 의존이 0인데 그 파일에 있다는 이유로 격리가 비싸다.
  3. `@ts-check` 를 켤 후보 1순위가 순수 모듈인데(`jsconfig.json` 주석: *"늘리는 순서는 `05-test.md §3.4` 의 순수 모듈 우선순위표를 따른다"*), `helpers.js` 는 순수부(경로·escape)와 전역 상태부(`var shortcuts`·`var statusBar`·`var layoutPresets`…)가 한 파일이라 켤 수 없다.
- **제안**: N4 를 개정하고 `helpers-path.js`(`:30-175`, 의존 0 · `@ts-check` 즉시 가능) 하나만 먼저 뗀다. 나머지는 그 분할의 값이 측정된 뒤에 정한다 — `FR-FMB-3` 이 *"분할이 값을 버는지 아직 증거가 없다"* 를 뒤집을 때 쓴 것과 같은 절차다.
- **위험도**: LOW (순수 구간 이동. `index.html` 에 `helpers-path.js` 를 `contrast.js` 와 `helpers.js` 사이에 넣으면 `check-load-order.mjs` 가 검증한다)
- **공수**: S

### [LOW] D4 — `check-i18n.mjs` 는 한글만 잡는다

- **위치**: `scripts/check-i18n.mjs:36` `const KR = /[가-힣ㄱ-ㆎ]/;`
- **현상**: 게이트의 머리 주석은 *"문구를 카탈로그로 옮긴 뒤 이 게이트가 없으면 다음 커밋이 그것을 되돌린다 — 한 줄의 `'저장했습니다'` 는 아무 검사에도 걸리지 않고, 걸리지 않는 것은 늘어난다"* 로 목적을 적는다. 그 논리는 영문에도 그대로 성립하는데 검출은 한글에만 걸려 있다.
- **비용**: H2 의 113건이 정확히 이 구멍으로 들어왔다. `FR-B-1`(전수 번역)은 로케일 둘을 요구하므로 **영문 리터럴도 위반**인데 게이트가 그것을 말하지 않는다.
- **제안**: H2 의 3항 참조. CSS 검사(`checkCss`, `:180`)가 이미 *"주석 밖 `content:` 값의 한글 **또는 2자 이상의 라틴 단어**"* 로 영문을 잡고 있다(`FR-B-6`) — 같은 판정을 JS/HTML 로 넓히면 된다. 규약은 이미 이 파일 안에 있다.
- **위험도**: LOW · **공수**: S (H2 에 포함)

---

## 6. UI 에서 빠진 부분

### [HIGH] U1 — LSP 서버 경로 표 (D1 과 동일)

백엔드 계약(`POST {overrides}`)·클라이언트 읽기 경로(`_lspOverrides`)·저장소 키(`'lspServerPaths'`)가 전부 있는데 **입력 화면만 없다.** 상세는 D1.

### [MED] U2 — `attnSound` 가 켜질 수 있지만 그 사실을 말하는 화면이 없다

- **위치**: `app.js:342-353` (`attnSound` getter/setter) · `app.js:355-361` (`attnDesktopBlocked`)
- **현상**: `attnSound` 의 기본값이 **환경에 따라 갈린다** — `get attnSound(){ … return !window.isSecureContext }`. 즉 평문 HTTP 접속에서는 켜지고 HTTPS 에서는 꺼진다. `attnDesktopBlocked` 는 "브라우저가 아예 막았다"(사용자가 고칠 수 없다)와 "권한 미승인"(고칠 수 있다)을 가르는 판정을 들고 있다.
- **비용**: getter 의 JSDoc 이 *"사용자는 토글을 켜 두고도 아무 알림을 받지 못한다 … 남는 조치는 **표시와 대체 수단**뿐이고, 그 대체 수단의 하나가 이것이다"* 로 **표시**를 조치의 절반으로 명시한다. 그런데 `attnDesktopBlocked` 를 읽어 화면에 말하는 자리를 확인하지 못했다 — `app-attn.js` 는 권한 요청(`:510-511`)과 알림 발행만 한다. 결과: 평문 접속 사용자는 소리가 왜 나는지, HTTPS 사용자는 데스크톱 알림이 왜 안 오는지 알 길이 없다.
- **제안**: 설정 ▸ 알림 절에 `attnDesktopBlocked` 가 참일 때 *"이 접속은 보안 컨텍스트가 아니어서 브라우저가 데스크톱 알림을 막습니다 — 대신 알림음이 켜져 있습니다"* 한 줄(`t('attn.desktop_blocked')`)을 세운다. `app-update.js:39-44` 가 503 일 때 설정 행을 `row.hidden=!u` 로 감추는 규약(*"누를 수 없는 것을 보여 주는 것은 고장으로 읽힌다"*)의 반대 방향 짝이다.
- **위험도**: LOW · **공수**: S

### [MED] U3 — 여섯 확인창에 로딩·실패 상태가 없다

- **위치**: `app-tool.js:382 _confirmClose` · `app-editor-file.js:154 _edConfirm`
- **현상**: 확인 버튼을 누르면 즉시 `cleanup(true)` 로 창이 닫히고, 그 뒤의 비동기 작업(도구 종료·파일 삭제)의 진행·실패는 이 창에서 말하지 않는다.
- **비용**: `app-statusbar.js:227-231` 의 백그라운드 모달은 같은 문제를 이미 풀었다 — *"서버가 SIGTERM 유예(3초)를 기다리므로 응답은 즉답이 아니다. **아무 표시가 없으면 사용자는 눌리지 않았다고 보고 행을 다시 누른다** — 그것이 복귀다"*(`t('runs.closing')` 표시 + `_bgError` 인라인 오류). 확인창 쪽에는 그 학습이 전파되지 않았다. 파일 삭제 실패는 `_notify` 로 뜨지만(별도 모달), 도구 종료 실패는 `_kill`(`app-tool.js:573`)이 `apiDel` 의 결과를 **읽지 않아** 아무 데도 가지 않는다.
- **제안**:
  - `_kill`/`_killTool` 이 `apiDel` 의 봉투를 읽고 실패 시 `Toast.show(apiErrText(r, t('core.close_tool_fail')),'err')`. `api.js:apiErrText`(`:145`)가 그 문장을 만드는 한 자리다.
  - 확인창은 그대로 닫되(`FR-PDA-2` 의 흐름을 바꾸지 않는다) 실패를 `Toast` 로 보낸다 — `FR-A11Y-19` 가 라이브 리전을 `Toast` 하나로 모았으므로 그쪽이 맞다.
- **위험도**: LOW · **공수**: S

### [LOW] U4 — `gitStatusInterval` 을 `끔` 으로 두었을 때 그 사실을 화면이 말하지 않는다

- **위치**: `app-polling.js:53-63` (`off:true` · 선택지에 `[0, t('core.off')]`)
- **현상**: 다섯 주기 중 이것만 `0`(끔)을 받는다. 껐을 때 "안전망 폴링이 꺼져 있고 push 관측이 본줄이다" 를 말하는 배지·힌트가 없다.
- **비용**: 주석이 *"그 진술이 오래 **거짓**이었다 — 서버 감시의 임대가 이 폴링에 매달려 있어서, 끄면 본줄인 push 까지 죽었다(GP-1)"* 로 이 스위치가 한 번 배신한 이력을 적는다. 지금은 참이지만, 사용자가 "꺼도 되는가" 를 판단할 근거가 `hint` 한 줄뿐이다.
- **제안**: `hint` 에 끔 상태일 때의 문장을 덧붙이거나(`spec.hintOff`), `_pollPaintRows`(`:151`)가 값이 0 이면 행에 `.ds-hint--warn` 을 붙인다. 기존 표 구조(`POLL_SETTINGS`)에 필드 하나를 더하는 일이다.
- **위험도**: LOW · **공수**: S

---

## 7. 흠잡지 않은 것 (참고)

리팩터 대상에서 **제외**를 권하는 자리다. 감사 중 확인한 근거를 남긴다.

- **`core/api.js`(177)** — 봉투 계약·`fetch` 1회 읽기·시한 옵트인·주입 가능한 `fetch` 가 정확하고, JSDoc 이 core 에서 가장 조밀하다(`@param`/`@returns` 7건). `check-fetch.sh` 게이트가 단일 경로를 지킨다.
- **`core/timer-hub.js`(386)** — H5 의 `_tick` 방어 하나만 빼면 설계가 정확하다. `@ts-check` 가 켜진 6파일 중 하나이고, `_arm` 의 재무장 규약(`FR-SRA-1`)·`refreshChanged` 의 "바뀐 것만"(`D-8a`)·`frame` 의 "먼저 잡힌 예약이 이긴다"가 전부 실측 근거를 달고 있다.
- **`core/state-registry.js`(187)** — 선언 데이터와 배선 파생이 깔끔하고, `wireStateRegistry` 의 `call()` 이 *"이름이 사라졌으면 소리를 낸다"* 로 `typeof` 가드의 실패 모드(`FR-WBR-95`)를 닫았다. `@ts-check` 적용됨.
- **`core/app-polling.js`(173)** — 서술자 표 하나가 값·화면·기본값·선택지를 전부 지고, `pollValue` 가 검증의 유일한 자리다. `initPollingSettings` 의 `t` 가림(M6)만 정리하면 된다.
- **`core/settings-schema.js`(110)** — Go 와 같은 바이트를 읽는 제약(`FR-CFG-10`)을 위해 JS 표현식을 금하고, `settingValue`(저장값 해석, 범위 밖 → 기본값)와 `clampSetting`(입력값, 범위 밖 → 자름)의 구분을 주석이 정확히 설명한다.
- **`core/event-bus.js`(319)** — 라우팅 테이블 전환·비행 식별(`beginSnapshot`)·`life:` 접두 규약이 전부 실패 사례에서 역산돼 있다. `publish` 의 구독자별 `try/catch` 는 H5 가 허브에 요구하는 것의 정본이다.
- **`core/app-reload.js`(138)** — `_softStep`/`_softStepAsync` 가 "삼키되 남긴다" 의 정본이다. M7 의 제안이 이 패턴을 확산시키는 것이다.
- **`i18n/ko.js`·`en.js`** — 키 958/971. 차이 13개는 전부 `*.one` 복수형이고 `ko` 는 `.other` 만 두는 것이 설계다(`i18n.js:106` · `check-i18n.mjs:pluralOne`). **키 불일치는 0건이다** — 검사했고 문제 없다.
- **`core/app-slots.js`(719)** — 섹션 9개가 각각 FR 을 달고 응집돼 있다. `_slotReap` 이 `SLOT_MAX` 순회의 정본이고(H1), `_slotRenderArm` 의 `{once:true}` + 재무장 가드가 정확하다. **분할하지 않는 쪽을 권한다.**

---

## 8. 권장 순서

| 순 | 항목 | 근거 |
|---|---|---|
| 1 | **H5**(타이머 방어) · **H1**(슬롯 순회) | 둘 다 S 이고 게이트 없이 잡히지 않는 실제 결함이다 |
| 2 | **M5**(저장소 키 상수) | H4 의 선행. 상수가 없으면 `activateWindow` 를 세울 때 키가 또 리터럴이 된다 |
| 3 | **H4**(`activateWindow`) + **M8**(`_focusExistingTab`) | 같은 결합. M8 은 H4 의 첫 호출부다 |
| 4 | **H3**(`dialogOpen` 여섯) | 접근성 선언이 걸려 있고, e2e 표면 파생(FR-A11Y-13)이 재발을 막는다 |
| 5 | **D4 게이트 → H2**(영문 113개) | 게이트를 먼저 세우고 그것이 잡는 것을 고친다. 순서를 뒤집으면 다시 샌다 |
| 6 | **M2**(`REMOTE_ACTIONS`) → **M3**(`addTab`·`save`·`init` 분할) | M2 가 `app-cmd.js` 를 600줄로 줄이고, M3 가 D2 의 수치를 실제로 움직인다 |
| 7 | **D2 게이트**(파일 크기) · **M9 게이트**(선주입 동기화) | 6 이 얻은 것을 고정한다 |
| 8 | **D1**(LSP 서술자 표) · M4 · M6 · M7 · P1 · L1~L3 | 독립적이다 |

`D3`(`helpers-path.js`)는 어느 시점에 넣어도 되지만 **6 이전**이 낫다 — `@ts-check` 를 켤 첫 후보가 생기고, 그것이 M3 의 나머지 분할에 선례가 된다.
