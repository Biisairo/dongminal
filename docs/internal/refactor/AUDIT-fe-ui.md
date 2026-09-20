# 감사: 프론트엔드 뷰 계층 (`web/js/ui/` · `web/js/git/`)

> **읽기 전용 감사.** 소스는 한 줄도 바꾸지 않았다. 브랜치 `refactor`, 측정 시점 2026-09-20.
>
> 범위: `web/js/ui/` 24파일 · `web/js/git/` 33파일 = **23,734줄**.
> `web/js/core/`·`i18n/`·`test/`·`vendor/` 는 다른 감사의 몫이며, 이 문서가
> 그쪽 파일을 인용할 때는 **호출부가 내 범위에 있을 때만**이고 그렇게 표시했다.
>
> **`web/js/lsp/` 와 `web/js/term/` 는 존재하지 않는다** — `web/js` 아래는
> `core · git · i18n · test · ui` 다섯뿐이다. 과제가 지목한 두 디렉터리는
> 감사 대상이 없다.

---

## 0. 요약

### 0.1 수치

| 측정 | 값 | 비고 |
|---|---|---|
| `ui/`+`git/` 합계 | 23,734줄 · 57파일 | |
| 500줄 초과 | **12파일** | 최대 `ui/renderer.js` **1,586** |
| `renderer.js` 증가 | 1,336 → **1,586** (+250) | `FE_MODULE_BOUNDARY_SRS` §7.1 기준선(2026-09-12) 대비 |
| 80줄 초과 함수 | **16개** | 최대 `input-binding.js:7 constructor` 230줄 |
| `document.createElement('button')` | **34곳** | |
| `UIKit.button(...)` | **1곳** (`git/history.js`) | 34:1 |
| `ui-btn` 클래스가 **없는** 버튼 | **약 30종** | §UI-표 참조 |
| `:focus-visible` 규칙을 가진 버튼 선택자 | **`.ui-btn` 하나** | 위 30종은 전부 UA 기본 링 |
| `UIKit.dialogOpen` 호출 | **2곳** (`ui-kit.js` 자신 · `core/app-settings.js`) | 모달 골격 7벌 중 **5벌**이 트랩·복귀 없음 |
| `reconcileList` 사용 | 11곳 | 목록 렌더 전체의 절반 미만 |
| JS 안의 색 리터럴 | `ui/file-editor.js:842` **1곳** (+ `themes.js` 팔레트 정본 · `diag.js` 진단 오버레이) | CSS 게이트는 `web/*.css` 만 본다 |

### 0.2 게이트 현황 (실행 확인)

| 게이트 | 결과 | 이 감사가 덧붙이는 것 |
|---|---|---|
| `check-hardcoded-color.mjs` | ok (`:root` 밖 0) | **`web/*.css` 만 읽는다** — JS 인라인 스타일은 사각지대 (H-2) |
| `check-focus.mjs` | ok (지움 20 · 링 31) | **`outline:none` 을 쓴 자리만 짝을 맞춘다** — 애초에 링을 안 그리는 30종은 안 본다 (H-3) |
| `check-css-vars` · `check-z-index` · `check-contrast` · `check-font-size` | 전부 ok | — |
| `check-i18n.mjs` | ok (한글 0 · 958키) | **한글만 잡는다** — 영어 리터럴은 범위 밖 (L-3) |
| UI_KIT_SRS V-4 "문자 인벤토리 스크립트" | **존재하지 않음** | `scripts/` 에 해당 파일 없음 (M-7) |

### 0.3 우선순위 요약

| # | 등급 | 제목 | 위치 | 공수 |
|---|---|---|---|---|
| H-1 | HIGH | `GitRemoteList._load` 가 stale 응답에서 `_loading` 을 영구히 쥔다 | `git/remote.js:774` | S |
| H-2 | HIGH | JS 에 박힌 색 리터럴 `#f44` — 게이트 사각지대 | `ui/file-editor.js:842` | S |
| H-3 | HIGH | 버튼 34곳이 손으로 조립되고 30종이 `ui-btn` 밖에 산다 | 34곳 | L |
| H-4 | HIGH | 모달 골격 7벌 중 5벌에 `Tab` 트랩·포커스 복귀가 없다 (FR-A11Y-18) | `ui/runs-panel.js:98` · `git/confirm.js` · `git/dialog.js` | M |
| H-5 | HIGH | `git/` 에 `tabindex` 가 0곳 — git 뷰 전체가 마우스 전용 (WCAG 2.1.1) | `git/` 전역 | M |
| H-6 | HIGH | Runs 모달이 `UIKit.modal` 을 안 쓰고 오버레이를 통째로 다시 만든다 | `ui/runs-panel.js:98-124` | M |
| M-1 | MED | `GitRemoteList` 가 `GitListTab` 의 복제인데 `innerHTML=''` 로 전면 교체한다 | `git/remote.js:648-791` | M |
| M-2 | MED | `panel-views.js` 의 뷰 여섯이 바이트 동일한 블록 6벌 | `git/panel-views.js:52-166` | S |
| M-3 | MED | `TermPane.connect()` 와 `_reconnect()` 가 WS 배선을 두 벌로 갖는다 | `ui/term-pane.js:720,937` | M |
| M-4 | MED | `_rLayout` 168줄 — 여섯 책임이 한 함수 | `ui/renderer.js:542` | M |
| M-5 | MED | 빈/로딩/오류 상태를 그리는 방식이 **다섯 벌** | 5곳 | M |
| M-6 | MED | `ResizeObserver` 를 잡지 않고 버린다 (pane 마다 1개) | `ui/renderer.js:1424` | S |
| M-7 | MED | `▸ ▾` 트위스티 5곳 · `▣` 1곳이 스프라이트 밖 문자 글리프 | 6곳 | S |
| M-8 | MED | blame 이 가상화 없이 전 줄을 DOM 으로 만든다 | `git/panel-diff.js:293-303` | M |
| M-9 | MED | `renderer.js` 1,586줄 — 기준선 대비 +250, 분할 경계가 이미 보인다 | `ui/renderer.js` | L |
| M-10 | MED | 고정 `height:` + 배율 폰트 — 큰 `uiFontSize` 에서 글자가 잘린다 | `style-editor.css:137,203` · `style.css:217,933` | S |
| M-11 | MED | `--git-*` 크기 토큰이 `--fs-scale` 밖 — FR-FSS-5 의 범위 누락 | `style-git-views.css:743-745` | S |
| L-1 | LOW | `input-binding.js` 생성자 230줄 · `160/480` 매직 넘버 2벌 | `ui/input-binding.js:7,31,46` | S |
| L-2 | LOW | `TIMERS.after(300, …)` 한 줄이 term-pane 에 두 벌 | `ui/term-pane.js:731,955` | S |
| L-3 | LOW | 서명 구분자가 `\u0001` 과 `\u0000` 두 벌 | 8곳 | S |
| L-4 | LOW | `UIKit.menu`·`_hud` 의 여백 매직 넘버 (`4`·`62`·`40`·`48`·`28`) | `ui/ui-kit.js:444-447,608,629` | S |
| L-5 | LOW | `GIT_TREE_PAD0=6` ≠ `--git-tree-pad0:9px` — 주석이 "같은 값" 이라 적었다 | `constants-git-changes.js:117` · `style-git-views.css:745` | S |

---

## 1. HIGH

### [HIGH] H-1 `GitRemoteList._load` 가 stale 응답에서 `_loading` 을 영구히 쥔다

- 위치: `web/js/git/remote.js:774-791` (판정을 읽는 자리 `web/js/git/remote.js:707`)
- 현상:
  ```js
  this._loading=true;
  const res=await gitFetch('/api/git/remotes',{repo},{stale:…,echo:{repo}});
  if(res.stale) return;      // ← _loading 이 true 인 채로 나간다
  this._loading=false;
  ```
  `_paintRows` 가 `(this._loading&&this._repo)?GIT_HIST_LOADING:GIT_RM_EMPTY` 로
  가르므로, **stale 한 번 뒤에는 원격이 0개인 저장소가 영영 "불러오는 중" 으로 남는다.**
- 비용: 이것은 `GIT_REFRESH_LIFECYCLE_SRS` **FR-GRF-24** 가 이름 붙여 고친 바로 그
  실패 모드다. 공용 헬퍼 `gitLoadList`(`git/view-util.js:60-64`)의 주석이 그것을
  적어 두었다 — *"낡은 응답은 그 값을 쓰지 않는 것이지 잠금을 영원히 쥐는 것이
  아니다. 종전에는 여기서 `_loading=true` 인 채로 빠져나갔다."* `branches.js:202` ·
  `stash.js:300` · `worktrees.js:152` · `submodules.js:136` 은 전부 고쳤고
  **`remote.js` 만 옛 순서를 그대로 들고 있다.** `panel-poll.js:186`
  (`reloadRemotesIfOpen`)이 관측 회차마다 이 경로를 돈다.
- 제안: `gitLoadTicket`/`gitLoadTaken`(`git/view-util.js:43,51`)을 도입하고 순서를
  `if(gitLoadTaken(this,t)) return; this._loading=false; if(res.stale) return;`
  로 뒤집는다. 더 나은 길은 M-1 — `gitLoadList(this,{url:'/api/git/remotes',
  key:'remotes',failMsg:GIT_RM_LOAD_FAIL})` 한 줄로 대체하면 이 함수 자체가 사라진다.
  덤으로 `AbortController` 도 따라온다 (지금 remote 만 없다).
- 위험도: LOW (단일 함수, 공용 헬퍼가 이미 검증됨)
- 공수: S

### [HIGH] H-2 JS 에 박힌 색 리터럴 `#f44` — 하드코딩 색 게이트의 사각지대

- 위치: `web/js/ui/file-editor.js:842`
  ```js
  this.el.style.boxShadow = 'inset 0 0 0 2px #f44';
  ```
- 현상: 저장 실패 플래시의 붉은 테두리가 테마 토큰이 아니라 리터럴이다.
- 비용: `DESIGN_TOKENS_SRS` FR-TOK-6·7·29 가 *"색은 토큰에서 온다"* 를 요구하고
  `scripts/check-hardcoded-color.mjs` 가 그것을 지킨다 — 그러나 그 스크립트는
  `const CSS_DIR='web'` 아래 **`.css` 파일만** 읽는다(`:82`). `web/js` 는 한 번도
  열리지 않으므로 이 자리는 게이트가 초록인 채로 산다. `#f44` 는 54종 테마 중
  어느 팔레트의 값도 아니고, 밝은 테마에서 `--danger` 와 눈에 띄게 다르다.
  DESIGN_TOKENS_SRS §3.3 이 *"인라인 스타일을 재는 것은 이 문서의 범위가 아니다"* 라
  스스로 구멍을 적어 두었다 — 그 구멍에 실제로 값이 들어와 있다.
- 제안: `var(--danger)` 로 바꾼다(토큰은 이미 있고 54종 전부에서 파생된다).
  재발 방지는 `check-hardcoded-color.mjs` 에 `web/js/**/*.js` 의
  `.style.*=` · `style.cssText=` · `<style>` 문자열을 훑는 두 번째 패스를 더하고
  예외 둘을 등록부에 적는 것이다 — `ui/themes.js`(팔레트 정본, FR-TOK-16 이
  *"한 바이트도 바뀌지 않는다"* 로 보호) · `ui/diag.js`(`?diag=1` 전용 진단 오버레이,
  테마가 죽어도 읽혀야 하므로 의도적으로 독립).
- 위험도: LOW
- 공수: S (수정) / M (게이트 확장)

### [HIGH] H-3 버튼 34곳이 손으로 조립되고 30종이 `ui-btn` 밖에 산다

- 위치 (`ui/`, 전부):
  `ui/file-tree.js:203` · `ui/renderer.js:880,916,962,1334` ·
  `ui/term-clipboard.js:162,173` · `ui/term-pane.js:1002` ·
  `ui/version-watch.js:126` · `ui/runs-panel.js:196,208,230,237,806` ·
  `ui/toast.js:68`
- 위치 (`git/`, 전부):
  `git/remote.js:246,727` · `git/commit.js:332` ·
  `git/panel-changes.js:51,268,554,625` · `git/submodules.js:92` ·
  `git/dialog.js:276` · `git/panel-life.js:381,387` · `git/console.js:196` ·
  `git/panel-diff.js:605` · `git/worktrees.js:91` · `git/diff-view.js:212,224,475`
- 위치 (`innerHTML` 골격 안의 `<button class=…>`, 30여 개):
  `git/panel-changes.js:162-223,842-843` · `git/list-tab.js:58` ·
  `git/commit.js:53-54` · `git/console.js:36` · `git/stash.js:55,61` ·
  `git/branches.js:81,85` · `git/panel-diff.js:145,146,160,161` ·
  `git/history.js:134,139,147` · `git/worktrees.js:25` ·
  `git/submodules.js:25,26,28` · `git/remote.js:667` · `ui/diag.js:26-32`
- 현상: `ui/ui-kit.js:70 UIKit.button(spec)` 이 있는데 `ui/`+`git/` 에서 그것을
  부르는 자리는 **`git/history.js` 한 곳**이다. 나머지는 `createElement('button')`
  뒤에 클래스 문자열·`title`·`type`·리스너를 손으로 얹는다.
- 비용: `UIKit` 머리말이 이 파일의 존재 이유를 적었다 — *"지금까지 같은 것이
  열한 벌(버튼)로 흩어져 있었고, 그래서 한쪽에만 있는 동작이 생겼다."* 실측으로
  그 동작 차이가 지금 다시 벌어져 있다:

  | 계약 | `UIKit.button` | 손 조립 실측 |
  |---|---|---|
  | `type='button'` | 항상 | `ui/renderer.js:880,916,962` · `git/panel-changes.js:268,554,625` · `git/console.js:196` 등 **미설정** |
  | 아이콘만인 버튼의 `aria-label` | `title` 과 함께 자동 | `git/panel-changes.js:268`(일괄) · `:554`(폴더 동작) · `ui/renderer.js:916`(새로고침) **없음** — `title` 만 |
  | 이름 없는 버튼 금지(`throw`) | 강제 | 강제 없음 |
  | `:focus-visible` 링 (`--focus-ring`) | `.ui-btn:focus-visible` (`style-kit.css:74`) | 30종 **없음** → UA 기본 링 (H-3b) |

- 제안: 세 갈래로 나눈다.
  1. **이미 `ui-btn*` 문자열을 손으로 적는 곳** (`ui/file-tree.js:203` ·
     `ui/renderer.js:963` · `ui/toast.js:68` · `ui/version-watch.js:128` ·
     `ui/runs-panel.js:197,209,231,238,807` · `git/panel-changes.js:52,555,626` ·
     `git/submodules.js:93` · `git/worktrees.js:92` · `git/panel-diff.js:606` ·
     `git/dialog.js:278` · `ui/term-pane.js:1003`) — 기계적 치환이다.
     `UIKit.button({icon,label,title,kind,size,cls})` 로 바꾸면 클래스 문자열이
     사라지고 `type`·`aria-label` 이 공짜로 붙는다. 위험 0.
  2. **`ui-btn` 이 아예 없는 곳** — `.ui-btn` 계열로 승격하고 기존 클래스는
     `cls` 로 함께 준다(FR-UIK-10 / D-5 의 규약 그대로). 대상과 대응 변형:

     | 클래스 | 지금 | 제안 |
     |---|---|---|
     | `git-group-bulk` | CSS 12선언 자작 | `UIKit.button({icon,title,kind:'ghost',size:'lg',cls:'git-group-bulk'})` |
     | `git-job-opt` · `git-job-cancel/copy/close/fold` · `git-job-auth-copy` | 각자 규칙 | `size:'sm'`, `cls` 유지 |
     | `git-rm-add` · `git-rm-del` | 각자 규칙 | `size:'sm'` / `kind:'danger'` |
     | `git-con-refresh` | **CSS 규칙 0개** | `size:'sm'` |
     | `git-con-replay` · `git-img-mode` · `git-img-as-text` · `git-diff-note-act` · `git-preflight-copy` | 각자 규칙 | `size:'sm'` |
     | `git-missing-unpin` · `git-missing-recheck` | `.git-missing-acts button` 후손 규칙 | `size:'sm'`, 후손 규칙 삭제 |
     | `tc-copy-do` · `tc-copy-close` | `.tc-copy-row button` 후손 규칙 | `kind:'primary'` / 기본 |
     | `pn-tab-add` · `ed-side-tab` · `ed-side-refresh` | 각자 규칙 | `ed-side-tab` 은 `UIKit.tab`, 나머지는 `kind:'ghost'` |
  3. **`innerHTML` 골격 안의 버튼** — `UIKit.iconHTML` 이 이미 문자열 형태를
     주므로(`ui-kit.js:55`), 같은 규약으로 `UIKit.buttonHTML(spec)` 을 하나 더
     세우는 것이 자연스럽다. 이것은 새 API 이므로 `UI_KIT_SRS` 개정이 선행한다.
- 위험도: MED (①은 LOW, ②는 CSS 가 함께 바뀌므로 MED, ③은 스펙 개정 필요)
- 공수: L

### [HIGH] H-3b 포커스 링이 `.ui-btn` 에만 있다 — 게이트가 못 본다

- 위치: `web/style-kit.css:74` 가 유일한 버튼 포커스 규칙.
  `web/*.css` 전체의 `:focus-visible` 선택자 28개 중 버튼을 덮는 것은 이 하나와
  `.ui-tab`(`:115`) · `.ui-menu-item`(`:166`) · `.pn-tab`(`:614`) ·
  `.ds-switch button`(`:1163`) · `.fe-find-toggle`(`:296`) 뿐이다.
- 현상: H-3 의 30종은 `:focus-visible` 규칙이 없어 브라우저 기본 링을 받는다 —
  앱의 `--focus-ring` 과 색·두께가 다르다.
- 비용: `scripts/check-focus.mjs` 는 *"`outline:none` 을 가진 규칙"* 을 기준으로
  짝을 맞춘다(머리말 참조). 이 30종은 `outline:none` 을 쓰지 않으므로 **게이트가
  애초에 이들을 세지 않는다.** FR-TOK-25 는 *"링은 `var(--focus-ring)` 을 쓴다"* 를
  요구하고, 그 요구는 실제로는 `.ui-btn` 안에서만 지켜지고 있다. 지금 게이트가
  초록인 것은 위반이 0 이어서가 아니라 **세는 모집단이 좁아서**다 —
  `FE_MODULE_BOUNDARY_SRS` §4.4a 가 `check-e2e-private.sh` 에 대해 적은 것과
  같은 형태다 (*"초록인 게이트와 재고 있는 게이트는 다르다"*).
- 제안: H-3 ②를 하면 이 항목은 저절로 닫힌다 (`.ui-btn:focus-visible` 이 덮는다).
  게이트 쪽은 `check-focus.mjs` 에 *"`<button>` 을 그리는 클래스는 `.ui-btn` 계열이
  거나 자기 `:focus-visible` 을 가진다"* 를 더한다 — 판정 모집단을 CSS 의
  `button` 선택자에서 파생시키면 손으로 적은 목록이 되지 않는다.
- 위험도: LOW
- 공수: S (H-3 에 편승)

### [HIGH] H-4 모달 골격 7벌 중 5벌에 `Tab` 트랩과 포커스 복귀가 없다

- 위치:
  - 트랩 있음: `core/app-settings.js:356`(설정) · `ui/ui-kit.js:384`(`UIKit.modal`)
  - **트랩 없음**: `ui/runs-panel.js:98`(Runs) · `git/confirm.js:174,303`(git 확인창) ·
    `git/dialog.js:161,347`(git 다이얼로그) · `core/app-layout.js`(확인창) ·
    `core/app-tool.js`(백그라운드) — 뒤 둘은 `core/` 소유
  - 골격 목록의 정본: `e2e/a11y-dialog.spec.ts:216-250` (`SKELETONS` 일곱)
- 현상: `UIKit.dialogOpen`(`ui-kit.js:256`)이 FR-A11Y-18 의 계약 전부를 한 함수로
  갖는데(역할·`aria-modal`·`aria-labelledby`·`Tab` 트랩 스택·포커스 복귀), 그것을
  부르는 곳이 **둘뿐**이다. `git/confirm.js` 와 `git/dialog.js` 는 `role="dialog"`
  `aria-modal="true"` 를 직접 적고 `_focus()` 로 여는 포커스만 준다 — `Tab` 은
  상자 밖으로 나가고, 닫아도 연 컨트롤로 돌아오지 않는다.
- 비용: `ACCESSIBILITY_BASELINE_SRS` **FR-A11Y-18** 이 두 가지를 함께 요구한다 —
  *"`Tab` 이 밖으로 나가지 않는다"* 와 *"닫으면 **연 컨트롤로 돌아간다**"*. 지금
  e2e 의 트랩 단정(`a11y-dialog.spec.ts:47-57`)은 `#modal`(설정) 하나만 본다.
  나머지 다섯은 재지 않으므로 초록이다. `UX-16`(골격 수렴)은 **겉모습**만
  수렴시켰고(`TC-TOK-21` 이 `.ui-modal`·반경·백드롭을 잰다) 접근성 계약은 함께
  가지 않았다 — 그 둘이 다른 일이라는 것을 `ui-kit.js:193-199` 주석이 이미
  적어 두었는데, 실제로는 **겉모습만 일곱이 맞고 계약은 둘뿐**이다.
- 제안: 세 자리를 각각 한 줄로 닫는다.
  ```js
  // git/confirm.js — _show() 안, 상자를 만든 뒤
  this._release = UIKit.dialogOpen(box, {labelledBy:'.gc-title', focus:this._defBtn});
  // close() 에서 this._release?.()
  ```
  `git/dialog.js` 도 같은 꼴(`labelledBy:'.git-dialog-head'`),
  `ui/runs-panel.js` 는 H-6 과 묶어 처리한다. `dialogOpen` 은 스택을 들고
  캡처에서 한 리스너만 쓰므로(ui-kit.js:212-216) 중첩에서도 안전하고,
  각 모달의 기존 `Escape` 처리는 건드리지 않는다.
  e2e 는 `a11y-dialog.spec.ts` 의 `SKELETONS` 표를 그대로 돌며 트랩·복귀를 재는
  테스트 하나로 일곱을 한꺼번에 덮는다 — 목록을 새로 적지 않는다(FR-A11Y-13 규약).
- 위험도: MED (포커스 이동은 e2e 가 민감하다)
- 공수: M

### [HIGH] H-5 `git/` 에 `tabindex` 가 0곳 — git 뷰 전체가 마우스 전용

- 위치: `web/js/git/**` 전수 — `tabIndex`·`tabindex`·`role=` 설정이 **하나도 없다**
  (`setAttribute('role'` 은 `git/` 에서 0건, `ui/` 에서 9건).
  클릭 리스너가 달린 비버튼 요소:
  `git/history-rows.js:132,214,253`(커밋 행·배지) ·
  `git/history-refs.js:27,90`(refs 사이드바) ·
  `git/history-detail.js:34,54,95`(커밋 상세·부모 해시·파일 행) ·
  `git/branches-tree.js:67,144,186`(그룹·접두사·즐겨찾기) ·
  `git/stash.js:236,282`(stash 행·파일 행) ·
  `git/panel-changes.js:564`(폴더 행) · `git/console.js:202`(기록 행) ·
  `git/panel-diff.js:486`
- 현상: History 커밋 목록 · Branches 트리 · Stash 목록 · Changes 폴더 행 ·
  Console 기록 · Diff 파일 행 — git 의 **모든 목록**이 `<div>` + `click` 이고
  키보드로 닿을 길이 없다. `git/` 안의 `keydown` 리스너는 넷뿐이고 그중 둘은
  다이얼로그의 `Escape`, 둘은 검색 입력의 `Enter` 다.
- 비용: `UIKit.roving`(`ui-kit.js:150`)이 이 계약을 정확히 갖고 있고
  `ui/renderer.js`(3) · `ui/sidebar-list.js`(2) · `core/app-settings-theme.js`(2)
  가 이미 쓴다 — **`git/` 만 쓰지 않는다.** FR-A11Y-16 의 문자 범위는
  *"창 목록 항목 · 분할 칸 탭 · 탐색기 행"* 셋이므로 이 항목이 그 요구의 위반은
  아니다. 그러나 **FR-A11Y-22** 가 *"여기 없는 미적용은 결함이다"* 로 §6 예외
  등록부를 유일한 면제 경로로 못 박았고, §6 의 예외는 **넷**(xterm 캔버스 ·
  Monaco 위젯 · 모바일 키바 가로 · 탭 닫기 가로)뿐이며 **git 목록은 없다.**
  WCAG 2.1.1(키보드 조작 가능, Level A) 기준으로 이 목록들은 대체 경로가 없다 —
  커밋 상세를 여는 다른 길이 없고, Stash 를 고르는 다른 길이 없다.
  axe 는 `div`+`click` 을 규칙으로 잡지 못하므로 `a11y-axe.spec.ts` 도 초록이다.
- 제안: 목록마다 컨테이너 하나에 6줄이다. `list-tab.js` 와 `branches-tree.js` ·
  `history-rows.js` · `stash.js` 각각의 목록 컨테이너에:
  ```js
  UIKit.roving(box, {
    items: () => [...box.querySelectorAll('.git-hist-row')],
    activate: (el) => el.click(),
  });
  ```
  그리고 행을 만들 때 `d.setAttribute('role','option')` + `d.tabIndex=-1`,
  컨테이너에 `role="listbox"` — `ui/sidebar-list.js:71,167` 이 이미 쓰는 꼴 그대로다.
  그리기마다 `UIKit.rove(items, cur)` 를 부른다(`ui-kit.js:187` 의 계약).
  우선순위는 **History → Branches → Stash → Changes 폴더 행** 순이 맞는다 —
  행 수와 사용 빈도 순이다.
  `ACCESSIBILITY_BASELINE_SRS` §6 에 "git 목록" 을 예외로 등록하는 길도 있지만
  FR-A11Y-24 가 **재검토 조건**을 요구하므로 *"언제 이 예외가 없어지는가"* 를
  적을 수 없다 — 즉 예외가 아니라 범위 축소이고, 그것은 문서를 고쳐야 한다.
- 위험도: MED (포커스가 생기면 `renderer.js:666` 의 `:focus-visible` 유지 규칙과
  상호작용한다. 그 규칙이 이미 `.kb-nav` 를 다루므로 `UIKit.roving` 이 붙이는
  `kb-nav` 클래스로 자동으로 덮인다)
- 공수: M

### [HIGH] H-6 Runs 모달이 `UIKit.modal` 을 안 쓰고 오버레이를 통째로 다시 만든다

- 위치: `web/js/ui/runs-panel.js:98-124` (`_runsModalRender`) ·
  `:76-84`(`_runsModalToggle`) · `:108`(`ov.innerHTML=''`)
- 현상:
  ```js
  ov = runDiv('runs-modal ui-modal'); ov.id = 'runs-modal';
  …
  ov.innerHTML = '';
  const box = runDiv('runs-box ui-modal-box');
  ```
  키트의 **클래스 이름만** 빌려 오고 `UIKit.modal`/`dialogOpen` 은 부르지 않는다.
  결과로 빠진 것: `role="dialog"` · `aria-modal` · `aria-labelledby` ·
  `Tab` 트랩 · 포커스 복귀 · **닫기 버튼**.
- 비용: 세 가지가 겹친다.
  ① H-4 의 접근성 계약 부재.
  ② `UIKit.modal` 머리말이 못 박은 계약 — *"닫는 길 셋(닫기 버튼·바깥 클릭·Esc)이
     같은 `onClose` 로 간다 — 지금까지 셋 중 둘만 있는 상자가 있었다"* — 여기가
     정확히 **셋 중 둘**인 상자다. `ui-modal-head`/`ui-modal-close` 가 없어
     터치 기기에서 닫을 길이 배경 탭 하나뿐이다.
  ③ `_runsRefresh()`(`:87`)가 응답마다 `_runsModalRender()` 를 부르고 그것이
     `ov.innerHTML=''` 로 전부 버린다 — `repaint.js` 머리말이 금지하는 바로 그것
     (`:hover`·글자 선택·진행 중 transition·더블클릭의 첫 클릭이 사라진다).
     같은 파일이 **다른 네 자리에서는** `reconcileList` 를 제대로 쓴다
     (`:605,668,735,885`) — Run 그래프 쪽이다. 목록 모달만 빠졌다.
- 제안:
  ```js
  const m = UIKit.modal({
    title: tn('runs.head', rows.length),
    cls: 'runs-modal', width: …,
    closeTitle: TIP_RUNS_MODAL_CLOSE,
    onClose: () => this._runsModalToggle(false),
  });
  reconcileList(m.body, rows, {
    key: rv => rv.id,
    sig: rv => this._runsRowSig(rv),
    build: rv => this._runsRow(rv),
  });
  ```
  `m.box` 에 `.runs-box` 를 `cls` 로 함께 주면 기존 CSS 가 그대로 산다(D-5).
  `_runsModalKey`(Escape)와 배경 클릭 리스너는 `UIKit.modal` 이 가져가므로
  `:83`·`:104-106` 이 통째로 사라진다 — 리스너 관리 코드가 줄어드는 것이 덤이다.
  `TC-TOK-21` 의 Runs 항목은 `.ui-modal`/`.ui-modal-box` 를 그대로 보므로 깨지지 않고,
  `.runs-box` 를 찾는 선택자만 `cls` 로 유지하면 된다.
- 위험도: MED (`e2e/a11y-dialog.spec.ts:228` 이 `#runs-modal .runs-box` 를 본다)
- 공수: M

---

## 2. MED

### [MED] M-1 `GitRemoteList` 가 `GitListTab` 의 복제인데 전면 교체로 그린다

- 위치: `web/js/git/remote.js:648-791` (클래스 전체) vs `web/js/git/list-tab.js`
- 현상: 두 클래스의 골격이 1:1 로 대응한다.

  | `GitListTab` | `GitRemoteList` | 차이 |
  |---|---|---|
  | `mount()` → `-head`/`-note`/`-list`/`-empty` | `mount()` → `-head`/`-note`/`-rows` | `-empty` 를 행 안에 인라인으로 만든다 |
  | `_paintNote()` → `gitPaintNote` | `note.textContent=this._err` 직접 | `kind` dataset 없음 · **닫기 버튼 없음** |
  | `_paintList()` → `reconcileList` | `_paintRows()` → **`box.innerHTML=''`** | 전면 교체 |
  | `_load()` → `gitLoadList` | 자작 `_load()` | H-1 의 버그 · `AbortController` 없음 |
  | 빈 문구 `GIT_LOADING_HINT` | **`GIT_HIST_LOADING`** | History 의 문구를 빌려 쓴다 |
  | `_sig()` 구분자 규약 | 없음 (서명 자체가 없다) | |

- 비용: `list-tab.js` 머리말이 이 감사가 찾아낸 것을 예고한다 — *"규칙이 하나여야
  한다고 적고 두 벌로 구현했다. 복제는 표기부터 갈라져 있었다."* 그때 Worktrees·
  Submodules 둘을 합쳤고 **Remotes 는 그 통합에 들어가지 않았다.**
  전면 교체의 비용은 `stash.js:167-176` 이 기록해 두었다 — *"이 뷰는 바깥 계기로
  다시 그려진다 … 전면 교체는 hover·선택·글자 선택·우클릭 앵커를 그때마다
  끊었다."* Remotes 도 `panel-poll.js:186` 이 관측 회차마다 `reload()` 하므로
  **같은 조건**이다. 원격 URL 을 드래그로 선택해 복사하려는 손이 다음 폴링에서
  선택을 잃는다.
- 제안: `class GitRemoteList extends GitListTab` 로 옮긴다. 채울 훅은
  `_headHTML()`(제목·개수·추가 버튼) · `_mountHead()` · `_paintHead()` ·
  `_emptyText(){return GIT_RM_EMPTY}` · `_key(r){return r.name}` ·
  `_sigParts(r){return [r.name,r.url||'',r.pushUrl||'']}` · `_rowEl(r)` ·
  `_load(){return gitLoadList(this,{url:'/api/git/remotes',key:'remotes',
  failMsg:GIT_RM_LOAD_FAIL})}`. CSS 접두사는 `'git-rm'` 그대로이므로
  `.git-rm-head`·`.git-rm-note`·`.git-rm-list` 만 맞추면 되고 `.git-rm-rows`
  →`.git-rm-list` 이름 하나가 바뀐다. H-1 이 이 안에서 함께 닫힌다.
- 위험도: MED (CSS 클래스 하나가 바뀐다 · e2e `git-remote*.spec.ts` 확인 필요)
- 공수: M

### [MED] M-2 `panel-views.js` 의 뷰 여섯이 바이트 동일한 블록 6벌

- 위치: `web/js/git/panel-views.js:52-166`
  (`_renderHistory` · `_renderBranches` · `_renderConsole` · `_renderWorktrees` ·
  `_renderSubmodules` · `_renderStash`)
- 현상: 여섯이 아래를 글자 그대로 반복한다.
  ```js
  _renderXxx(el){
    if(!this.repo){
      el.dataset.built=''; el.innerHTML='';
      this._xxx().unmount();
      const d=document.createElement('div'); d.className='git-empty';
      d.textContent=this._errMsg||GIT_NO_REPO_HINT;
      el.appendChild(d);
      return;
    }
    if(el.dataset.built!=='1'){this._xxx().mount(el);el.dataset.built='1'}
    this._xxx().paint();
  }
  ```
  다른 것은 뷰 접근자 이름 하나뿐이고, History 만 끝에 `this._paintHeadIn(el)`
  한 줄이 더 붙는다.
- 비용: 94줄 중 84줄이 복제다. "리포 없음" 화면의 문구·클래스·`unmount` 순서를
  고치려면 여섯 자리를 고쳐야 하고, 이 저장소가 반복해서 만난 실패 모드는
  **그중 하나가 빠지는 것**이다.
- 제안: 서술자 표 + 진입점 하나. `GIT_TAB_VIEWS` 를 `constants-git-history.js`
  계열에 두는 것이 아니라 이 파일 머리에 두는 것이 맞는다 — 이 표가 뜻하는 것은
  상수가 아니라 **이 파일의 구조**다.
  ```js
  const GIT_VIEW_DEFS = [
    {key:'history',   make:p=>p._history(),   after:(p,el)=>p._paintHeadIn(el)},
    {key:'branches',  make:p=>p._branches()},
    {key:'console',   make:p=>p._console()},
    {key:'worktrees', make:p=>p._worktrees()},
    {key:'submodules',make:p=>p._submodules()},
    {key:'stash',     make:p=>p._stash()},
  ];
  _renderView(el,def){ … }   // 지금의 본문 하나
  ```
  뷰가 늘 때 표에 한 줄을 더하는 것이 곧 등록이므로, 손으로 적은 목록이
  새 항목을 놓치는 경로가 사라진다.
- 위험도: LOW (순수 구간 이동 + 표 파생)
- 공수: S

### [MED] M-3 `TermPane.connect()` 와 `_reconnect()` 가 WS 배선을 두 벌로 갖는다

- 위치: `web/js/ui/term-pane.js:720-758`(`connect`) · `:937-973`(`_reconnect`)
- 현상: 두 함수가 `new WebSocket(this._wsURL())` · `binaryType` · `onopen` ·
  `onmessage` · `onclose` · `onerror` 를 각각 적는다. `onmessage` 본문은
  바이트 동일하고, `onopen` 의 오버레이 숨김 한 줄도 동일하다:
  ```js
  TIMERS.after(300,()=>{this._hideOverlay();this.el.style.opacity='1';
    this._reconnecting=false;if(this.term)this.term.scrollToBottom()},
    {owner:this,label:'overlay-hide'});
  ```
  **그러나 미묘하게 다르다** — 이것이 이 항목의 요점이다:

  | | `connect()` | `_reconnect()` |
  |---|---|---|
  | 오버레이 숨김 | `if(this._reconnecting)` 일 때만 | 무조건 |
  | `onclose` 의 세대 가드 | **없음** | `if(this.ws&&this.ws!==ws) return` |
  | `_pendingWs` 관리 | 없음 | 있음 |
  | `this.ws` 대입 시점 | 생성 즉시 | `onopen` 에서 |

  `connect()` 의 `onclose` 에 세대 가드가 없다 — `connect()` 로 연 소켓이
  나중에 닫힐 때 `reconnectNow()` 가 이미 다른 소켓을 세웠다면 그 닫힘이
  살아 있는 연결 위에 "연결 끊김" 오버레이를 띄우고 재연결을 예약한다.
  `connect()` 는 최초 연결 전용이라 지금은 좁은 창이지만, `:726-729` 주석이
  *"`reconnectNow()` 가 오버레이를 띄운 채 이 함수를 부르게 되면서 그것이
  결함이 됐다"* 고 이미 한 번 같은 종류를 겪었다고 적었다.
- 제안: `_wireSocket(ws,{adoptNow})` 하나로 모은다 — `onmessage`·`onclose`·
  `onerror`·`onopen` 의 공통부를 여기 두고, 다른 것 둘(`adoptNow`, 오버레이
  조건)만 인자로 받는다. `TIMERS.after(300,…)` 은 `_onWsReady()` 로 승격하고
  `300` 은 `RECONNECT_OVERLAY_HIDE_MS` 상수로 뺀다 (L-2 가 함께 닫힌다).
  `RECONNECT_STORM_SRS` 의 백오프 수치(`200`·`500`·`1000`·`2.5`·`1.2`·`10000`,
  `:942-945`)도 같은 김에 상수로 옮긴다 — `core/constants.js:176,184` 가 이미
  같은 SRS 의 다른 수치를 상수로 들고 있어 규약이 반쪽이다.
- 위험도: MED (`reconnect-storm.spec.ts` 가 이 경로를 격리로 잰다)
- 공수: M

### [MED] M-4 `_rLayout` 168줄 — 여섯 책임이 한 함수

- 위치: `web/js/ui/renderer.js:542-709`
- 현상: 한 함수가 순서대로 여섯을 한다.
  ① 스크롤 갈무리(`:547`) ② 칸 골격 세우기(`:556-603`)
  ③ 살아 있는 탭 id 수집 + 편집기 Map 회수(`:604-616`)
  ④ 죽은 Git 패널 detach(`:617-627`) ⑤ 안 붙은 위젯 `vis` 해제 + `_domGC`(`:628-631`)
  ⑥ `TIMERS.frame` 안의 사후 처리 — fit · 스크롤 복원 · 포커스 재지정(`:632-708`)
- 비용: ⑥ 하나가 77줄이고 그 안에 주석 40줄이 들어 있다 — 실제 로직은
  `held` 판정 3줄, 포커스 분기 12줄이다. 근거 주석이 로직을 덮어서 *"이 프레임이
  무엇을 하는가"* 를 한눈에 읽을 수 없다.
- 제안: 네 개로 가른다. 전부 **구간 이동**이고 한 줄도 바뀌지 않는다.
  | 새 메서드 | 원본 구간 | 주제 |
  |---|---|---|
  | `_rSlots()` | 556-603 | 칸 골격·머리·손잡이 |
  | `_gcWidgets()` | 604-631 | 탭 id 수집 · 편집기 회수 · 패널 detach · `_domGC` |
  | `_afterLayout()` | 633-708 | `TIMERS.frame` 본문 — fit · 스크롤 복원 |
  | `_refocus()` | 655-704 | 포커스 재지정 (`held` 판정과 분기) |
  `_rLayout` 에 남는 것은 진행 순서 6줄이다.
  `SPLIT_REFACTOR_SRS` 의 구간 이동 규약과 `FR-FMB-33`(선행 주석 끌어올리기)을
  그대로 쓴다.
- 위험도: LOW
- 공수: M

### [MED] M-5 빈/로딩/오류 상태를 그리는 방식이 다섯 벌

- 위치와 방식:

  | # | 자리 | 기제 | 셋을 구분하나 |
  |---|---|---|---|
  | 1 | `git/list-tab.js:107-112` (Worktrees·Submodules) | `.{p}-empty` 한 요소 + `classList.toggle('vis')` | 예 (`_err` / `_loading` / `_emptyText()`) |
  | 2 | `git/stash.js:184-198` | 같은 문구를 **목록의 한 항목**으로 `reconcileList` 에 태운다 | 예 (+ "필터에 안 걸림" 을 따로 가른다) |
  | 3 | `git/remote.js:702-711` | 매번 `<div class="git-rm-empty">` 를 새로 만든다 | 로딩/빔만 (오류는 별도 `-note`) |
  | 4 | `git/panel-views.js:56-59` 외 5곳 | 매번 `<div class="git-empty">` 를 새로 만든다 | 아니오 (`_errMsg \|\| GIT_NO_REPO_HINT` 한 줄) |
  | 5 | `ui/doc-render.js:326`(`_note`) | 전용 `_note(text)` 한 함수 | 예 (7가지 사유를 각각) |
  | 6 | `ui/runs-panel.js:113-121` | `.runs-empty` + 제목·힌트 **두 줄** 구조 | 예 |

- 비용: 여섯 자리가 같은 물음("지금 비어 있는데, 왜?")에 여섯 가지로 답한다.
  ②가 가장 옳다 — 안내문이 목록의 한 항목이면 `reconcileList` 가 그것도
  보존하므로 상태 전환에서 깜빡임이 없고(`stash.js:176` 이 *"안내문도 같은
  목록의 한 항목이다 (FR-GRF-20)"* 로 근거를 적었다), 로딩·빔·필터-없음의
  **세 사실을 뭉개지 않는다.** ④가 가장 나쁘다 — 오류와 "리포 없음" 이 같은
  문자열 자리를 나눠 쓰므로 사용자는 실패를 "저장소가 없다" 로 읽는다.
  ⑥의 2줄 구조(제목+힌트)는 **가장 쓸모 있는 형태**이지만 혼자만 쓴다.
- 제안: ② + ⑥ 을 합쳐 `git/view-util.js` 에 `gitEmptyRow({err,loading,text,hint})`
  를 세운다 — 반환은 요소 하나이고 `reconcileList` 의 항목으로 태울 수 있다.
  ①③④를 여기로 모은다. ④는 M-2 의 표 파생과 같은 커밋에서 닫히고,
  ③은 M-1 의 `GitListTab` 상속으로 닫힌다. `ui/doc-render.js` 의 `_note` 는
  git 접두사 규약 밖이므로 그대로 두되, 문구 구조(제목+힌트)만 맞춘다.
- 위험도: LOW
- 공수: M

### [MED] M-6 `ResizeObserver` 를 잡지 않고 버린다

- 위치: `web/js/ui/renderer.js:1424`
  ```js
  if(typeof ResizeObserver!=='undefined') new ResizeObserver(markOverflow).observe(tabs);
  ```
- 현상: `_makePane()` 이 만드는 pane 마다 하나씩 생기고 어디에도 저장되지 않아
  `disconnect()` 할 길이 없다. pane 골격은 `_domGC()`(`:80-88`)가 DOM 에서
  떼지만 옵저버에는 알리지 않는다.
- 비용: 같은 파일군의 다른 세 자리는 전부 참조를 들고 끊는다 —
  `ui/file-editor.js:1099`→`:1144,1153` · `ui/runs-panel.js:559`→`:429` ·
  `git/history.js:189`→`:187,201`. **`renderer.js` 만 규약 밖이다.**
  엄밀히 말해 옵저버와 대상이 서로만 참조하면 함께 수거될 수 있으므로 영구
  누수라고 단정하지 않는다. 실제 비용은 둘이다: (a) 떼어진 pane 이 `_dom` 에서
  사라진 뒤에도 GC 전까지 콜백이 돌 수 있고, (b) **규약이 세 자리에서 지켜지고
  한 자리에서 깨진 상태**라 다음 사람이 어느 쪽이 규칙인지 알 수 없다.
- 제안: `el._tabOverflowRo = new ResizeObserver(markOverflow)` 로 요소에 얹고
  (`el._markTabOverflow` 를 이미 그렇게 얹고 있다, `:1425`), `_domGC()` 에서
  ```js
  if(el&&el._tabOverflowRo) el._tabOverflowRo.disconnect();
  ```
  를 `el.remove()` 앞에 둔다. `_domGC` 가 이 저장소에서 유일한 골격 수거
  지점이므로 자리가 하나다.
- 위험도: LOW
- 공수: S

### [MED] M-7 `▸ ▾` 트위스티 5곳 · `▣` 1곳이 스프라이트 밖 문자 글리프 · V-4 게이트 부재

- 위치:
  - `git/panel-changes.js:433` `box.querySelector('.git-group-caret').textContent=collapsed?'▸':'▾';`
  - `git/panel-changes.js:532` (폴더 행 캐럿, 같은 꼴)
  - `git/branches-tree.js:79,156,168` (그룹·접두사·트위스트, 같은 꼴)
  - `ui/sidebar-tabs.js:77` `badge:s.sandbox?{text:'▣ '+s.sandbox+…}`
  - (`core/` 소유) `core/constants-editor.js:351-355` `EDITOR_TREE_TW_OPEN='▾'` ·
    `TW_CLOSED='▸'` · `LINK='↗'` — 호출부가 `ui/file-tree-paint.js` 다
- 현상: 같은 삼각형 ternary 가 다섯 자리에 그대로 복제돼 있다. 스프라이트에는
  `chevron-down`·`chevron-right` 가 **이미 있다**(`index.html`, 심볼 38개).
- 비용: `UI_KIT_SRS` **FR-GLY-4** 가 *"§2.6 의 문자 아이콘을 **전부** 교체한다"* 로
  `▲ ▼`→`chevron-up/down` 을 명시했고, **V-4** 가 *"§2.6 표의 문자가
  `web/js`·`index.html` 어디에도 남아 있지 않다(문자 인벤토리 스크립트)"* 를
  검증 방법으로 적었다. `scripts/` 에 **그 스크립트가 없다** (24종 게이트 중
  글리프 검사는 하나도 없다). 게이트가 서지 않은 채 남은 글리프가 여섯이다.
  문자 글리프는 `.ui-icon` 의 `currentColor`·굵기를 받지 못하므로 54종 테마에서
  선 굵기가 스프라이트 아이콘과 다르고, 폰트에 따라 자형이 바뀐다.
- 제안: 두 걸음.
  1. `ui-kit.js` 에 `UIKit.twisty(open)` 를 세운다 — `this.icon(open?'chevron-down':'chevron-right',{size:'sm'})`.
     다섯 자리가 `el.replaceChildren(UIKit.twisty(open))` 한 줄이 된다.
     `▣`(샌드박스 배지)는 스프라이트의 `box` 로 간다 — FR-GLY-4 의 사상표가
     `▣`→`box` 를 이미 적었다.
  2. V-4 의 인벤토리 스크립트를 `scripts/check-glyphs.mjs` 로 세운다.
     사상표(FR-GLY-4)를 데이터로 읽어 `web/js`·`web/index.html` 의 **문자열
     리터럴 안**(주석 밖)에 그 문자가 남아 있는지 본다. 주석에서의 언급은
     통과시켜야 한다 — `panel-diff.js:196` 처럼 근거를 적은 주석이 여럿이다.
- 위험도: LOW
- 공수: S (치환) / S (게이트)

### [MED] M-8 blame 이 가상화 없이 전 줄을 DOM 으로 만든다

- 위치: `web/js/git/panel-diff.js:293-303`(`_drawBlame`) · `:305-330`(`_blameRow`)
- 현상:
  ```js
  rows.innerHTML='';
  const frag=document.createDocumentFragment();
  for(const ln of d.lines) frag.appendChild(this._blameRow(ln,d.commits[ln.oid]||{}));
  ```
  `_blameRow` 는 행마다 `<div>` 1 + `<span>` 5 = **6 노드**를 만든다. 상한이
  없으므로 5,000줄 파일이면 30,000 노드다.
- 비용: 같은 저장소의 History 는 가상 스크롤을 갖고 있고
  (`git/history-rows.js:4` — *"가상 스크롤의 행 창 (FR-GIT-116, 검증 V48)"*,
  `:109-110` 이 스페이서 두 개로 창을 민다), 탐색기는 페이징을 갖는다
  (`ui/file-tree-paint.js:186` `st.entries.slice(0,st.page0)`),
  Changes 는 `IntersectionObserver` 로 이어 그린다
  (`git/panel-changes.js:292-296` `_growGroup`). **blame 만 전부 그린다.**
  `_drawBlame` 은 `paintIfChanged` 대신 자체 `box.dataset.sig` 비교를 쓰므로
  (`:295-297`) 같은 파일을 다시 열면 다시 그리지는 않지만, 첫 그리기 한 번의
  비용이 파일 길이에 비례한다.
- 제안: `history-rows.js` 의 창 기제를 그대로 쓴다 — `_blameRow` 가 이미 순수
  팩토리이고 행 높이가 고정이므로 옮길 것이 스페이서 둘과 스크롤 핸들러뿐이다.
  더 싼 1차 조치는 `GIT_BLAME_MAX_ROWS` 상한과 "N줄 이후는 보이지 않습니다 +
  전체 보기" 안내다 — `ui/doc-render.js:520`(`DOC_RENDER_TABLE_MAX_ROWS`)이
  같은 저장소에서 같은 문제를 그렇게 풀었다.
- 측정: 5,000줄 파일에서 `openBlame` → `_drawBlame` 구간의
  `performance.measure`. 기대치는 노드 수 30,000 → 창 크기 × 6.
- 위험도: MED (스크롤 동기가 Monaco 와 맞물린다)
- 공수: M

### [MED] M-9 `renderer.js` 1,586줄 — 기준선 대비 +250

- 위치: `web/js/ui/renderer.js`
- 현상: `FE_MODULE_BOUNDARY_SRS` §2.1 이 2026-09-12 에 잰 값은 **1,336** 이고
  §7.1 이 *"저장소 최대 파일은 `ui/renderer.js` 1,336줄 그대로다"* 로 닫았다.
  지금은 **1,586** — 일주일 남짓에 **+250줄(+19%)** 이다.
- 비용: 그 문서의 비목표 **N3** 가 분할하지 않은 근거는 *"응집도가 있다
  (`02-fe-arch` A-6: 응집도는 있으나 `render()` 가 매번 전부 지난다). 그것은
  `FE-14`·`FE-27`(합치기)의 문제이지 분할이 아니다"* 였다. 그 판단은 그때
  옳았지만 **근거가 줄 수가 아니라 응집도였으므로, 줄이 늘어도 판단은 자동으로
  재검토되지 않는다.** 실측으로 이 파일은 지금 넷을 한다 — 골격 캐시·배치 유틸
  (`_keep`/`_place`/`_placeLayout`/`_domGC`, 39-88), 스크롤 갈무리·복원
  (92-277·324-415), 사이드바·탑바 그리기(416-541), 레이아웃·pane·탭 조립
  (542-1586).
- 제안: `FE_MODULE_BOUNDARY_SRS` 의 증강 분할 규약(묶음 B·C 와 동일)으로 넷을
  가른다. `Renderer.prototype` 에 `Object.assign` 하므로 계약은 한 글자도
  바뀌지 않는다.
  | 새 파일 | 구간 | 주제 | 예상 |
  |---|---|---|---|
  | `renderer.js` | 1-91 · 278-323 | 클래스 본문 · `_keep`/`_place`/`_domGC` · `render()` | ~140 |
  | `renderer-scroll.js` | 92-277 · 324-415 | 스크롤 갈무리·복원·터미널 시선 | ~280 |
  | `renderer-chrome.js` | 416-541 | 사이드바 탭 · 목록 · 창 이름 · 탑바 | ~126 |
  | `renderer-layout.js` | 542-1017 | 칸 · 창 · 편집기 창 · 사이드 · 핸들 | ~475 |
  | `renderer-pane.js` | 1018-1586 | 노드 · pane · 탭 · 탭 조립 · 분할 | ~570 |
  `check-load-order.mjs` 가 증강 파일이 클래스 정의 뒤인지 강제하므로(C-2)
  `index.html` 순서만 맞추면 된다. **먼저 M-4 를 하는 것이 맞는다** — 함수
  경계가 서야 파일 경계가 보인다.
  되돌리려면 N3 판정을 개정해야 한다: 근거는 위 "넷을 한다" 와 +250 이다.
- 위험도: LOW (구간 이동 · 증강)
- 공수: L

### [MED] M-10 고정 `height:` + 배율 폰트 — 큰 `uiFontSize` 에서 글자가 잘린다

- 위치: `web/style-editor.css:137-140`(`.ed-row{height:22px;font-size:var(--fs-md)}`) ·
  `web/style-editor.css:203-207`(`.ed-input{height:18px;font-size:var(--fs-md)}`) ·
  `web/style.css:217`(`.sbl-item{height:30px;font-size:var(--fs-md)}`) ·
  `web/style.css:933-938`(`.search-bar button{height:24px}`)
  — 그리는 코드는 `ui/file-tree-paint.js:825`(`_el`) · `:907`(`_elInput`) ·
  `ui/sidebar-list.js:167`
- 현상: 상자 높이는 px 리터럴이고 안의 글자는 `var(--fs-md)` 로 **배율을 받는다.**
  `FONT_SIZE_SETTING_SRS` FR-FSS-2a 가 `uiFontSize` 를 **8~32px** 로 열어 두었고
  FR-FSS-2b 가 `--fs-scale = uiFontSize / 14` 이므로 최대 배율은 32/14 ≈ **2.29** 다.
  그때 `--fs-md` = 12 × 2.29 ≈ **27px** 이 `height:22px` 인 `.ed-row` 와
  `height:18px` 인 `.ed-input` 안에 들어간다.
- 비용: FR-FSS-5 는 배율을 **`--ui-btn-h`·`-sm`·`-lg`·`--ui-tab-h`·`--ui-icon-*`·
  `--ui-btn-px`·`--ui-gap`** 여덟에 건다고 열거했다 — 키트 밖의 고정 높이는
  그 목록에 없다. `check-font-size.mjs` 는 *"font-size 선언이 토큰인가"* 만 보고
  **그 글자가 들어갈 상자**는 보지 않으므로 초록이다. 탐색기는 이 앱에서
  가장 행이 많은 목록이고, 글자를 키우는 사용자가 곧 이 설정을 쓰는 사용자다.
- 제안: 셋을 `min-height` 로 바꾸고 배율을 건다 —
  `.ed-row{min-height:calc(22px * var(--fs-scale))}` ·
  `.ed-input{min-height:calc(18px * var(--fs-scale))}` ·
  `.sbl-item{min-height:calc(30px * var(--fs-scale))}`.
  `.ed-row` 의 `body.mobile` 재정의(`style-editor.css:143`, `--touch-min`)는
  `min-height` 라도 그대로 이긴다.
  재발 방지는 `check-font-size.mjs` 에 *"`font-size:var(--fs-*)` 를 가진 규칙이
  고정 `height:` 를 함께 가지면 잡는다"* 한 줄을 더하는 것이다 — 예외는
  `--fs-scale` 이 곱해진 `calc()` 뿐이다.
- 위험도: LOW (`min-height` 로 바꾸는 것은 기본 배율 1 에서 화면이 같다)
- 공수: S

### [MED] M-11 `--git-*` 크기 토큰이 `--fs-scale` 밖

- 위치: `web/style-git-views.css:743-745`
  ```css
  :root{--git-hit:30px;--git-btn-h:30px;--git-row-min:30px;
    --git-indent:12px;--git-tree-pad0:9px}
  ```
- 현상: `--fs-scale` 을 읽는 토큰은 `style-kit.css:27-48` 의 아홉과
  `style.css:53-57` 의 다섯뿐이다. git 뷰의 크기 다섯은 **고정 px** 이고,
  `.git-view button,.git-dialog button,#git-confirm button,.git-menu-item`
  (`:747-749`)이 `min-height:var(--git-btn-h)` 를 바닥으로 건다.
- 비용: `uiFontSize < 14`(배율 < 1)에서 `--ui-btn-h-lg` 는 30×배율로 줄어드는데
  git 뷰 버튼은 30px 바닥에 걸려 줄지 않는다 — **같은 설정 한 번에 앱의 절반만
  작아진다.** FR-FSS-5 가 `--ui-*` 여덟만 열거했고 git 접두어 토큰은 그 목록에
  없어서 생긴 범위 누락이다.
  **바닥 자체는 의도된 것이다** — `style-git-views.css:740-742` 가
  *"`min-*` 만 쓰므로 모바일의 더 큰 값은 그대로 남는다 (FR-GIT-199)"* 로
  히트 영역의 하한임을 적었고 FR-A11Y-27(모바일 44px)이 그것을 딛는다.
  그러므로 고칠 것은 "바닥을 없애는 것" 이 아니라 **바닥도 배율을 받게 하는
  것**이다.
- 제안: `--git-hit`·`--git-btn-h`·`--git-row-min` 셋에
  `calc(30px * var(--fs-scale))` 을 건다. `--git-indent`·`--git-tree-pad0` 은
  JS 상수와 짝이므로 건드리지 않는다 (L-5 참조 — 그쪽은 다른 문제다).
  `FONT_SIZE_SETTING_SRS` FR-FSS-5 의 열거에 이 셋을 더하는 것이 같은 커밋의 몫이다.
- 위험도: LOW (기본 배율 1 에서 값이 같다)
- 공수: S

---

## 3. LOW

### [LOW] L-1 `input-binding.js` 생성자 230줄 · `160/480` 매직 넘버 2벌

- 위치: `web/js/ui/input-binding.js:7-236`(생성자) · `:31` · `:46`
- 현상: `ui/`+`git/` 최대 함수다. 생성자 하나가 드래그 배선(`:54-70`) ·
  전역 키(`:117-193`) · 마우스 네비게이션(`:194-202`) · 사이드바/에이전트 폭
  복원(`:31,46,96`)을 전부 한다. 그리고 폭 하한·상한 `160`/`480` 이
  `:31` 과 `:46` 에 두 벌 적혀 있다.
- 비용: 생성자 안이라 단위 테스트가 부를 수 있는 진입점이 없다. 폭 범위가 두
  벌이면 한쪽만 바뀐다 — 이 저장소가 여러 SRS 에서 반복해 기록한 실패 모드다.
- 제안: `AG_WIDTH_MIN=160`·`AG_WIDTH_MAX=480` 상수(`core/constants.js` 의
  레이아웃 절)로 뺀 뒤 `clampAgentsWidth(w)` 한 함수로 모은다.
  생성자는 `this._bindDrag()` · `this._bindKeys()` · `this._bindMouse()` ·
  `this._restoreWidths()` 네 줄로 줄인다 (구간 이동).
- 위험도: LOW
- 공수: S

### [LOW] L-2 `TIMERS.after(300, …)` 한 줄이 term-pane 에 두 벌

- 위치: `web/js/ui/term-pane.js:731` · `:955` (문자 그대로 동일)
- 제안: M-3 의 `_onWsReady()` 로 흡수하고 `300` 을 상수로.
- 위험도: LOW · 공수: S

### [LOW] L-3 서명 구분자가 `\u0001` 과 `\u0000` 두 벌

- 위치:
  `\u0001` — `git/list-tab.js:129` · `ui/file-tree-paint.js:719,728,756,773,774` ·
  `git/panel-changes.js:455,466` · `git/history-refs.js:46`
  `\u0000` — `git/stash.js:205,267` · `git/panel-diff.js:262,293,364,415` ·
  `git/history-refs.js:46`
- 현상: `history-refs.js:46` 은 한 줄에서 **둘을 함께** 쓴다.
- 비용: `list-tab.js:120-127` 이 구분자의 규약을 명시적으로 적어 두었다 —
  *"하위는 `_sigParts` 만 정하고 이 규칙은 건드리지 않는다."* 그 규칙이
  `list-tab` 밖에서는 서지 않는다. 동작상 문제는 없다(둘 다 값에 나타나지 않는
  제어문자다). 문제는 **어느 쪽이 규약인지 읽을 수 없다**는 것이다.
- 제안: `repaint.js` 에 `const RPT_SEP='\u0001'` 을 두고 전부 그것을 쓴다 —
  서명 규약의 임자가 `repaint.js` 이므로 자리가 거기다.
- 위험도: LOW · 공수: S

### [LOW] L-4 `UIKit` 안의 여백 매직 넘버

- 위치: `web/js/ui/ui-kit.js:444-447`(`innerWidth-4` · `Math.max(4,…)`) ·
  `:608`(`gapX=62, gapY=40`) · `:629-630`(`48`·`28`)
- 현상: 메뉴가 화면 밖으로 나가지 않게 미는 여백 `4px`, HUD 상자의 오프셋과
  화면 안쪽 여백이 리터럴이다. `UI_KIT_SRS` 가 크기 토큰
  (`--ui-btn-h`·`--ui-radius`·`--ui-icon-*`)을 세운 파일에서 여백만 리터럴이다.
- 제안: `MENU_EDGE_GAP=4` · `HUD_OFFSET_X=62` · `HUD_OFFSET_Y=40` ·
  `HUD_EDGE_X=48` · `HUD_EDGE_Y=28` 로 `ui-kit.js` 머리에 모은다. CSS 토큰으로
  올리지 않는 이유는 이 값들이 **레이아웃 계산의 입력**이지 그리기 값이 아니기
  때문이다 — `--fs-*` 를 JS 에서 문자열로 읽으면 `calc()` 가 온다는 것을
  `DESIGN_TOKENS_SRS` §3.3 이 이미 비싸게 배웠다.
- 위험도: LOW · 공수: S

### [LOW] L-5 `GIT_TREE_PAD0=6` ≠ `--git-tree-pad0:9px` — 주석의 주장이 사실이 아니다

- 위치: `core/constants-git-changes.js:116-117`(`GIT_TREE_INDENT=12` ·
  `GIT_TREE_PAD0=6`) · `web/style-git-views.css:744-745`
  (`/* GIT_TREE_INDENT · GIT_TREE_PAD0 (constants.js) 과 같은 값 */`
  `--git-indent:12px;--git-tree-pad0:9px`)
  호출부: `ui/file-tree-paint.js:819` · `git/panel-changes.js:582`
  (둘 다 `paddingLeft=(GIT_TREE_PAD0+depth*GIT_TREE_INDENT)+'px'`) ·
  `web/style-git.css:485`(`background-position:var(--git-tree-pad0) 0`)
- 현상: 주석이 **"같은 값"** 이라 적었으나 들여쓰기 폭은 12=12 로 맞고
  기준 여백은 **6 ≠ 9** 다. 깊이 세로선은 x=9 에서 시작하고
  (`style-git.css:481-485` 의 `repeating-linear-gradient`), 행의 글자는
  깊이 ≥ 1 에서 `6 + 12d` 로 앉는다 — 두 계열이 3px 어긋난 격자 위에 산다.
  깊이 0 에서는 JS 가 `if(d)` 로 건너뛰므로(`panel-changes.js:582`)
  `.git-file,.git-dir{padding:0 6px 0 9px}`(`style-git.css:478`)의 9px 이 서고,
  깊이 1부터 18px·30px… 으로 간다.
- 비용: 화면이 실제로 어긋나 보이는지는 읽기만으로 단정하지 않는다 —
  세로선이 글자 **앞**에 서는 것이 의도일 수 있다. 확실한 것은 **주석이
  거짓**이라는 것이고, 그래서 다음 사람이 한쪽만 고치면 다른 쪽이 조용히
  따라오지 않는다. 같은 값이 두 언어에 두 벌 있고 **게이트가 없다** —
  이 저장소가 `check-shortcuts-docs.mjs`·`check-css-vars.mjs` 로 다른 축에서는
  정확히 이 부류를 막고 있다.
- 제안: 둘 중 하나로 정한다.
  (a) 의도가 "같은 값" 이면 `--git-tree-pad0` 을 6 으로 내린다 — 주석이
      이미 그렇게 주장하고 있으므로 이것이 기본이다.
  (b) 9 가 의도된 값이면 주석을 고치고 **왜 다른지**를 적는다
      (세로선의 기준과 글자의 기준이 다르다는 사실).
  어느 쪽이든 재발 방지는 `scripts/check-css-vars.mjs` 옆에
  *"`GIT_TREE_*` 와 `--git-*` 의 짝을 대조한다"* 한 줄을 더하는 것이다 —
  CSS 주석이 JS 상수 이름을 인용하는 자리에서 값을 파생시킨다.
- 위험도: LOW · 공수: S

---

## 4. 성능 개선 기회

| # | 자리 | 현상 | 예상 효과 | 측정 방법 |
|---|---|---|---|---|
| P-1 | `git/panel-diff.js:293-303` | blame 비가상화 (행당 6노드 · 상한 없음) | 5,000줄 파일에서 노드 30,000 → 창 크기×6 (≈99% 감소) | `openBlame` → `_drawBlame` 사이 `performance.measure` + `document.querySelectorAll('.git-blame-row').length` |
| P-2 | `git/remote.js:702` | 관측 회차마다 원격 목록 전면 교체 | 폴링당 DOM 교체 N행 → 0 (값이 안 바뀌면) · hover/선택 보존 | `MutationObserver` 로 `.git-rm-rows` 의 `childList` 변이 수를 60초 폴링 동안 센다 |
| P-3 | `ui/runs-panel.js:108` | `_runsRefresh` 마다 모달 오버레이 통째 재구축 | 목록 N행 재생성 → `reconcileList` 로 변경분만 | 같은 방법으로 `#runs-modal` 의 변이 수 |
| P-4 | `git/history-refs.js:23` · `git/history-detail.js:44,71,82` · `git/panel-write.js:277` · `git/confirm.js:248` | `innerHTML=''` 후 전량 재생성 (`reconcileList` 미적용 6곳) | refs 사이드바는 브랜치 수만큼, 커밋 상세 파일 목록은 변경 파일 수만큼 | 위와 동일 |
| P-5 | `ui/renderer.js:278-304` (`render()`) | 무엇이 바뀌었든 `_rSbTabs`·`_rLists`·`_rTopbar`·`_rLayout`·`_restoreScroll`·`updateCwd`·`updateStatusBar`·`applyFocusOverlay`·`gitWatchdogAll` 전부를 지난다. **호출 지점 57곳** | 합치기(rAF coalesce) 하나로 연속 호출 N회 → 1회 | `render()` 진입에 카운터를 놓고 대표 시나리오(탭 열기·창 전환·폴링 1분) 동안 센다 |
| P-6 | `ui/renderer.js:1424` | pane 마다 미수거 `ResizeObserver` | 옵저버 수가 pane 생성 누적을 따라가지 않게 한다 | pane 을 20번 만들고 지운 뒤 `_dom.size` 와 힙 스냅샷의 `ResizeObserver` 수 |
| P-7 | `ui/renderer.js` 28건 · `ui/doc-render.js` 15건 | 레이아웃 읽기(`getBoundingClientRect`/`offset*`/`scroll*`)가 가장 몰린 두 파일 | — | 읽기와 쓰기가 같은 프레임에 교차하는 자리를 `performance` 의 `Layout` 이벤트로 확인. **루프 안의 강제 리플로는 실측에서 찾지 못했다** — 이 항목은 "확인 대상" 이지 결함이 아니다 |

**P-5 는 이미 추적 중이다.** `PRODUCTION_ROADMAP.md:631` 이 `FE-14·FE-27`
*"`render()` 합치기·디바운스 없음"* 을 P2·공수 S 로 열어 두었고, §5-1 의 편승
규칙(`:1098`)이 *"M6 가 `renderer.js` 를 열면 `FE-14`·`FE-27` 을 함께"* 라고
적었다. M6 는 묶음 E 에서 이 파일의 **이름만** 만졌으므로(N6) 편승이 발동하지
않았다. M-9(분할)가 이 파일을 다시 여는 순간 편승 규칙이 다시 적용된다.

**리스너 누수는 실측에서 심각하지 않다.** `ui/`+`git/` 의 `document`/`window`
리스너 13곳 중 11곳은 1회성 부트 배선(`input-binding.js` 생성자 · `diag.js` ·
`version-watch.js`)이고, 수명이 있는 둘(`runs-panel.js:106` ·
`git/dialog.js:213` · `git/confirm.js:225`)은 전부 짝이 되는 `remove` 가 있다.
요소에 붙인 리스너는 `_keep` 의 "배선은 `make()` 안에서 한 번"(FR-PDR-7) 규약이
지켜지고 있어 중복 배선도 찾지 못했다. **남은 것은 M-6 하나다.**

---

## 5. UI 일관성 위반 목록

| 역할 | 위치 A | 위치 B | 어느 쪽이 맞는가 |
|---|---|---|---|
| 목록 행의 인라인 동작 버튼 | `git/panel-changes.js:555,626` — `ui-btn ui-btn-icon ui-btn-ghost ui-btn-**lg**` | `git/submodules.js:93` · `git/worktrees.js:92` — `ui-btn ui-btn-**sm**` · `ui/runs-panel.js:197` — `ui-btn ui-btn-sm` | **`lg`.** `style-git-views.css:747` 이 `.git-view button` 의 하한을 `--git-btn-h`(30px)로 정했고 `--ui-btn-h-lg` 가 그 값이다. `sm` 은 그 하한에 눌려 실제 크기는 같아지되 **글자 크기만 작아진다**(`--fs-sm` vs `--fs-md`) — 같은 역할에 두 글자 크기 |
| 그룹 일괄 동작 | `git/panel-changes.js:269` — `git-group-bulk`, `ui-btn` **없음**, CSS 12선언 자작 | `git/panel-changes.js:555` — 같은 열에 서는 폴더 동작은 `ui-btn ui-btn-icon ui-btn-ghost ui-btn-lg` | **`ui-btn`.** 같은 파일 주석(`:261-263`)이 *"머리와 행의 오른쪽 끝이 어긋나면 … 그것이 접수한 말의 '정렬이 안되었다'"* 로 둘이 같은 열임을 요구한다. 지금은 열은 맞고 **포커스 링과 disabled 표현이 다르다** |
| 목록 추가 버튼 | `git/worktrees.js:25`(`git-wt-add`) · `git/submodules.js:25`(`git-sub-bulk`) · `git/stash.js:55`(`git-stash-new`) · `git/branches.js:81`(`git-br-new`) · `git/remote.js:667`(`git-rm-add`) — 전부 `ui-btn` 없음, 각자 CSS 2~4규칙 | `git/panel-changes.js:222`(`git-files-mode`) — `ui-btn ui-btn-icon ui-btn-lg` | **`ui-btn`.** 다섯이 같은 역할(뷰 머리의 주 동작)인데 다섯 벌의 CSS 를 갖는다 |
| 재시도 버튼 | `git/branches.js:85`(`git-br-retry`) · `git/history.js:147`(`git-hist-retry`) — 각자 CSS | `git/panel-life.js:387`(`git-missing-recheck`) — `.git-missing-acts button` 후손 규칙 | **`UIKit.button({kind:'ghost',size:'sm'})`.** 셋이 같은 뜻인데 세 기제 |
| 확인 예/아니오 | `ui/runs-panel.js:231,238` — `ui-btn ui-btn-sm ui-btn-danger` / `ui-btn ui-btn-sm` (행 안 인라인) | `git/confirm.js` — 모달 안 `.gc-*` · `core/app-statusbar.js:262,264` — `ui-btn ui-btn-sm ui-btn-danger bg-yes` | **행 인라인이 맞는 자리와 모달이 맞는 자리가 다르다.** `runs-panel.js:216` 이 근거를 적었다(*"모달 위의 모달은 Escape 처리와 포커스 관리를 복잡하게"*). 문제는 **둘 다 `UIKit.button` 을 안 쓴다**는 것 |
| 모드 전환 토글 | `git/diff-view.js:213`(`git-img-mode` + `.active`) — `ui-btn` 없음 | `ui/renderer.js:881`(`ed-side-tab` + `.active`) — `ui-btn` 없음 · `ui/sidebar-tabs.js` — `UIKit.tab` | **`UIKit.tab`.** `role="tab"`·`aria-selected` 가 따라온다. 지금 `git-img-mode` 와 `ed-side-tab` 은 선택 상태가 **접근성 트리에 없다** |
| 아이콘만인 버튼의 이름 | `UIKit.button` — `title` + `aria-label` 둘 다 | `git/panel-changes.js:268,554` · `ui/renderer.js:916` — `title` 만 | **둘 다.** `title` 만으로도 axe 의 `button-name` 은 통과하지만 `UIKit` 계약 ③(`ui-kit.js:14-15`)과 FR-UIK-21 은 `aria-label` 을 함께 요구한다. `ui/renderer.js:965` 는 손으로 조립하면서도 둘 다 붙였다 — **같은 파일 안에서도 갈린다** |
| 포커스 링 | `.ui-btn:focus-visible` → `var(--focus-ring)` | `ui-btn` 밖 30종 → UA 기본 | **`--focus-ring`** (FR-TOK-25) |
| 모달 골격 | `UIKit.modal` — 닫기 버튼·바깥 클릭·Esc 셋 + 트랩 + 복귀 | `ui/runs-panel.js:98` — 바깥 클릭·Esc 둘 · `git/confirm.js`·`git/dialog.js` — 역할·`aria-modal`·여는 포커스만 | **`UIKit.modal`/`dialogOpen`** (FR-A11Y-18 · FR-UIK-25) |
| 빈/로딩/오류 | 다섯 기제 | — | **`stash.js:184` 방식** (목록의 한 항목 + `reconcileList`) — §M-5 |
| 목록 재그리기 | `reconcileList` 11곳 | `innerHTML=''` 후 전량 재생성 — `git/remote.js:702` · `git/history-refs.js:23` · `git/history-detail.js:44,71,82` · `git/panel-write.js:277` · `git/confirm.js:248` · `ui/runs-panel.js:108` | **`reconcileList`** (FR-RPT-1~7). 위 7곳 중 **폴링이 부르는 것**(`remote` · `history-refs`)이 우선이다 |
| 트위스티 | `chevron-down`/`chevron-right` 스프라이트 | `'▸':'▾'` 문자 5곳 | **스프라이트** (FR-GLY-2·4) |
| 서명 구분자 | `\u0001` (`list-tab.js` 가 규약으로 적음) | `\u0000` 6곳 | **`\u0001`** — 다만 둘 다 안전하므로 값보다 **한 자리에 두는 것**이 요점 |
| 글자 배율에 따른 크기 | `--ui-btn-h*`·`--ui-tab-h`·`--ui-icon-*` — `calc(… * var(--fs-scale))` | `--git-hit`·`--git-btn-h`·`--git-row-min` 고정 30px · `.ed-row` 고정 22px · `.ed-input` 고정 18px · `.sbl-item` 고정 30px | **`calc(… * var(--fs-scale))`** (FR-FSS-5). 지금은 설정 한 번에 앱의 절반만 따라간다 — M-10·M-11 |

---

## 6. UI 에서 빠진 부분

| # | 자리 | 빠진 것 | 근거 |
|---|---|---|---|
| U-1 | git 목록 전부 (History · Branches · Stash · Console · Changes 폴더 행 · refs) | **키보드 경로 전체** | H-5. `git/` 에 `tabindex` 0곳 |
| U-2 | Runs 모달 (`ui/runs-panel.js:98`) | **닫기 버튼** — 배경 탭과 `Escape` 뿐 | H-6. 터치 기기에 `Escape` 가 없다 |
| U-3 | git 확인창 · git 다이얼로그 (`git/confirm.js` · `git/dialog.js`) | **`Tab` 트랩 · 포커스 복귀** | H-4 / FR-A11Y-18 |
| U-4 | `git/panel-views.js` 의 여섯 뷰 | **오류와 "리포 없음" 의 구분** — `this._errMsg\|\|GIT_NO_REPO_HINT` 한 줄이 둘을 겸한다 | M-5 ④ |
| U-5 | `git/remote.js:707` | 빈 목록이 stale 이후 영영 "불러오는 중" | H-1 |
| U-6 | `git/diff-view.js:213`(이미지 모드) · `ui/renderer.js:881`(사이드 탭) | **선택 상태가 접근성 트리에 없다** — `.active` 클래스만, `aria-selected` 없음 | §5 표 |
| U-7 | `git/panel-diff.js:293`(blame) | **상한과 "더 보기"** — 긴 파일에서 그리는 동안 응답이 멎는다 | M-8 |
| U-8 | `ui/term-clipboard.js:141-190` (복사 대체 상자) | **`role="dialog"`·트랩·복귀** — `document.body` 에 붙는 겹인데 모달 계약이 없다 | `ui-kit.js:256` `dialogOpen` 한 줄로 닫힌다 |

**되돌리기 없는 파괴적 동작은 실측에서 찾지 못했다.** `GitDialog.confirm`/
`GitConfirm` 이 22곳에서 쓰이고, stash drop · remote remove · 파일 폐기 ·
브랜치 삭제 · worktree 제거 · submodule 조작이 전부 그것을 지난다
(`git/remote.js:743` 이 `hint.command` 로 되돌리는 명령까지 보인다).
`ui/runs-panel.js:222` 는 *"삭제는 되돌릴 수 없다 (FR-DEL-7). 무엇이 함께
사라지는지 적는다"* 로 문구를 갖췄다. **이 축은 양호하다.**

---

## 7. 문서-구현 괴리

| # | 요구 | 문서 | 실측 | 등급 |
|---|---|---|---|---|
| D-1 | *"모든 심볼은 `viewBox="0 0 24 24"`"* · 스프라이트가 유일한 자리 | `UI_KIT_SRS` FR-GLY-1·2 | `core/constants-editor.js:362,417,425` 가 **`viewBox="0 0 16 16"`** 인 인라인 SVG 셋을 갖고, `ui/file-tree.js:204` 가 `innerHTML` 로 넣는다. `.ui-icon` 클래스가 없어 굵기·크기가 스프라이트와 다르다. 특히 `EDITOR_TREE_REFRESH` 는 스프라이트의 `i-refresh-cw` 와 **같은 뜻**이다 | MED (정의는 `core/`, 호출부는 `ui/`) |
| D-2 | *"§2.6 의 문자 아이콘을 **전부** 교체한다"* + 문자 인벤토리 스크립트 | `UI_KIT_SRS` FR-GLY-4 · V-4 | `▸ ▾` 5곳 · `▣` 1곳 잔존. **인벤토리 스크립트가 `scripts/` 에 없다** (게이트 24종 중 글리프 검사 0) | MED (M-7) |
| D-3 | *"색은 토큰에서 온다"* · `:root` 밖 리터럴 0 | `DESIGN_TOKENS_SRS` FR-TOK-6·7·29 | 게이트가 `web/*.css` 만 읽어 `ui/file-editor.js:842` 의 `#f44` 를 못 본다 | HIGH (H-2) |
| D-4 | *"링은 `var(--focus-ring)` 을 쓴다"* | `DESIGN_TOKENS_SRS` FR-TOK-25 | `ui-btn` 밖 30종은 `:focus-visible` 규칙 자체가 없다. 게이트는 `outline:none` 을 쓴 자리만 짝 맞추므로 모집단 밖 | HIGH (H-3b) |
| D-5 | *"`Tab` 이 밖으로 나가지 않는다 … 닫으면 연 컨트롤로 돌아간다"* | `ACCESSIBILITY_BASELINE_SRS` FR-A11Y-18 | 골격 7벌 중 2벌만 `dialogOpen` 을 지난다. e2e 트랩 단정은 `#modal`(설정) 하나만 잰다 | HIGH (H-4) |
| D-6 | *"여기 없는 미적용은 결함이다"* (§6 예외 등록부) | `ACCESSIBILITY_BASELINE_SRS` FR-A11Y-22 | git 목록 전체가 키보드 미도달인데 §6 예외 넷(E-1~E-4)에 없다 | HIGH (H-5) |
| D-7 | *"낡은 응답은 … 잠금을 영원히 쥐는 것이 아니다"* | `GIT_REFRESH_LIFECYCLE_SRS` FR-GRF-24 | `git/remote.js:781` 만 옛 순서 | HIGH (H-1) |
| D-8 | *"`box.innerHTML=''` 후 전부 다시 만들던 것을 `reconcileList` 로"* | 같은 문서 FR-GRF-17·20 · `GIT_REVIEW4_SRS` FR-RPT-1~7 | 폴링이 부르는 경로 중 `git/remote.js:702` · `git/history-refs.js:23` 이 아직 전면 교체 | MED (M-1) |
| D-9 | *"`title` 은 영어이되 **ko 카탈로그의 데이터**로 유지된다"* | `M8_UNIFIED_SRS:417` · `README.md:214` | `core/constants.js` 의 `TIP_*` **19개 전부**와 `constants-git*.js` 의 `GIT_TIP_*` 전부가 `t()` 를 지나지 않는 영어 리터럴이다 (`t(` 를 쓰는 `TIP_` 상수 **0개**). 규약이 "카탈로그 데이터" 가 아니라 "소스 리터럴" 로 구현돼 있다 | LOW · **`core/` 소유** — 호출부만 내 범위(`ui/runs-panel.js:199` 등). `audit-fe-core` 에 넘긴다 |
| D-10 | *"저장소 최대 파일은 `ui/renderer.js` 1,336줄 그대로다"* | `FE_MODULE_BOUNDARY_SRS` §7.1 (2026-09-12) | **1,586** (+250) | MED (M-9). 비목표 N3 를 개정할 근거가 생겼다 |
| D-11 | `FE-14`·`FE-27` — `render()` 합치기·디바운스 | `PRODUCTION_ROADMAP.md:631,1098` | **여전히 열려 있다.** 호출 지점 57곳, 합치기 없음 | 추적 중 (P-5) |
| D-12 | *"크기 토큰 … 에 같은 배율이 걸린다"* — 열거된 것은 `--ui-*` 여덟 | `FONT_SIZE_SETTING_SRS` FR-FSS-5 | `--git-hit`·`--git-btn-h`·`--git-row-min` 셋과 `.ed-row`·`.ed-input`·`.sbl-item` 의 고정 `height:` 가 배율 밖 | MED (M-10 · M-11) |
| D-13 | *"GIT_TREE_INDENT · GIT_TREE_PAD0 (constants.js) 과 같은 값"* | `style-git-views.css:744` (코드 주석) | `GIT_TREE_PAD0=6` vs `--git-tree-pad0:9px` — **같지 않다** | LOW (L-5) |

---

## 8. 확인했고 문제가 아닌 것

감사가 **찾지 못한** 것도 기록한다 — 다음 사람이 같은 자리를 다시 파지 않게.

1. **리스너 중복 배선 없음.** `_keep`/`make()` 규약(FR-PDR-7)이 `ui/renderer.js`
   전역에서 지켜진다. `git/list-tab.js`·`git/panel-views.js` 의 `dataset.built`
   가드도 같은 일을 한다.
2. **전역 리스너 누수 없음.** 13곳 중 수명이 있는 셋은 전부 `remove` 짝이 있다.
3. **파괴적 동작의 확인 누락 없음.** `GitDialog.confirm`/`GitConfirm` 22곳.
4. **CSS 게이트 6종 전부 초록** — 실행으로 확인했다(§0.2). 문제는 값이 아니라
   **모집단**이다.
5. **i18n 한글 리터럴 0** — `check-i18n.mjs` 실행 확인 (958키 · 호출 897).
   `ui/`+`git/` 에서 한글 하드코딩을 하나도 찾지 못했다.
6. **루프 안의 강제 리플로 없음.** `getBoundingClientRect` 가 반복문 안에서
   쓰기와 교차하는 자리를 찾지 못했다. `ui-kit.js:574`(`TIMERS.frame` +
   `coalesce:'size-hud'`)와 `git/history-rows.js` 의 스페이서 기법이 둘 다
   프레임당 1회를 지킨다.
7. **History 가상 스크롤 · Changes 점진 확장 · 탐색기 페이징**은 전부 있다.
   가상화가 없는 큰 목록은 **blame 하나**다 (M-8).
8. **`git/view-util.js` 의 공용 헬퍼가 옳다** — `gitLoadTicket`/`gitLoadTaken`/
   `gitLoadList`/`gitPaintNote`. 네 뷰가 쓴다. 문제는 헬퍼가 아니라
   **안 쓰는 한 뷰**(`remote.js`)다.

---

## 9. 권장 순서

| 순 | 묶음 | 항목 | 근거 |
|---|---|---|---|
| 1 | **버그** | H-1 | 실동작 결함. 단일 함수. 오늘 고칠 수 있다 |
| 2 | **토큰** | H-2 + 게이트 확장 | 한 줄 수정 + 재발 방지. 게이트가 없으면 내일 다시 생긴다 |
| 3 | **중복 제거(저위험)** | M-2 · M-6 · M-10 · M-11 · L-1 · L-3 · L-4 · L-5 | 전부 구간 이동·상수화·`calc()` 부착. 기본 배율에서 화면 변경 0 |
| 4 | **뷰 통합** | M-1 (→ H-1 · M-5 ③ 흡수) | `GitListTab` 상속. CSS 클래스 하나가 바뀐다 |
| 5 | **접근성** | H-4 → H-6 → H-5 | `dialogOpen` 둘(싸다) → Runs 모달(중간) → git 목록 roving(넓다) |
| 6 | **키트 수렴** | H-3 ① → H-3 ② → H-3b | ①은 기계적 치환, ②는 CSS 동반, ③은 ②에 편승 |
| 7 | **글리프** | M-7 + `check-glyphs.mjs` | V-4 가 요구한 게이트를 세운다 |
| 8 | **구조** | M-4 → M-9 | 함수 경계가 서야 파일 경계가 보인다. N3 개정이 선행 |
| 9 | **성능** | M-8 · P-4 · P-5 | blame 가상화 → 남은 전면 교체 6곳 → `render()` 합치기(FE-14·27) |

**1~3 은 서로 독립이고 전부 LOW 위험이다.** 4 부터는 e2e 표적 검증이 필요하고,
5·6 은 `a11y-*.spec.ts` 와 `ui-kit-*.spec.ts` 를 함께 본다. 8 은
`FE_MODULE_BOUNDARY_SRS` 비목표 N3 의 개정이 선행해야 한다 — 근거는 D-10 이다.
