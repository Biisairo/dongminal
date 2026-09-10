# SRS: UI 레이아웃 기본값 — 켜기/끄기 · 스크롤 소유권 · 골격 배치 — IEEE 29148

| | |
|---|---|
| 접수 | `U-7`(결함) · `U-8`(구조 변경) — 사용자 보고 2026-09-10 |
| 범위 결정 | **C1+C2+C3 전부 한 묶음** (사용자 2026-09-10) |
| 방향 결정 | **기본값을 실사용에 맞춘다** — 재정의를 지우는 방향 (사용자 2026-09-10) |
| 성격 | 구조 변경. 성공 판정은 **아무것도 달라지지 않는 것** |

---

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 요구는 둘이고, 하나가 다른 하나의 일반형이다.

> · **"blame 의 스크롤이 다른 뷰와 다르다"** (`U-7`)
> · **"git view 뿐만이 아닌 전체 ui 의 기본을 미리 설정해두고 가는 게 안전할 것
>   같다. 또 이렇게 맞지 않는 ui 가 나오면 안 되잖아."** (`U-8`)

`U-8` 의 뒷문장이 요구의 절반이다 — **재발 방지**다. 이 저장소는 규약을 게이트로
지키는 문화가 있고(`check-seams`·`check-timers`·`check-gitwrite`·`check-html`·
`check-fetch`), 그 파일들의 주석이 이유를 적고 있다: **"규약은 선언으로 지켜지지
않는다."**

### 1.2 범위 (Scope)

CSS 여섯 파일 4,194줄 전체를 대상으로 세 형태를 다룬다.

| # | 형태 | 이 스펙이 하는 일 |
|---|---|---|
| **C1** | 켜기/끄기 규약 | 표현 여섯 종을 **`[hidden]` 하나로** 수렴 + 게이트 |
| **C2** | 스크롤 소유권 | 기본값을 실사용에 맞추고 재정의를 지운다 + 게이트 |
| **C3** | 골격 배치 | **선언을 바꾸지 않는다** — 어긋난 자리가 없다(§2.4). 게이트만 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| **켜기/끄기** | 같은 요소를 보였다 감추는 것. 조건부 정적 숨김(`:empty`·`body.mobile`)이 아니다 |
| **스크롤 소유권** | 넘치는 내용을 **누가** 구르게 하는가. 바깥 컨테이너인가 안쪽 목록인가 |
| **골격** | 칸을 가득 채우는 컨테이너 — `position:absolute;inset:0` |
| **되돌려 적기** | 기본값이 실사용과 반대여서 자리마다 그것을 다시 뒤집는 것 |

### 1.4 참조 (References)

- `docs/internal/production/M2_PROGRESS.md` §3.4 `U-7`·`U-8` — 접수와 1차 실측
- [`./EXPLORER_ROOT_KEYS_SRS.md`](./EXPLORER_ROOT_KEYS_SRS.md) §7.1 — 같은 부류의
  교훈("렌더가 요소를 떼는 앱에서 `tabindex` 는 절반이다"). 여기서는 **기본값이
  절반**이고 나머지 절반이 게이트다
- `scripts/check-seams.sh` 주석 — *"D1 이 이 검사를 그냥 통과해 들어온 뒤에
  추가됐다."* 게이트가 왜 필요한지의 기록
- `GIT_REVIEW4_SRS` `FR-GIT-240~244` · `UX_BATCH5_SRS` `FR-SUB-*` — `worktrees`·
  `submodules` 뷰. §2.3 의 결함이 사는 자리

---

## 2. 현재 상태 (조사로 확정한 사실)

측정은 이 세션이 다시 했다. 1차 실측(`M2_PROGRESS` §3.4)의 숫자 하나를 정정한다 —
`overflow` 선언은 148이 아니라 **139** 이다(148에는 `text-overflow:ellipsis` 49 중
일부가 섞여 있었다).

### 2.1 C1 — 켜기/끄기를 표현하는 방법이 여섯 종이다

```
.vis            51 선택자 (JS 69 자리: toggle 42 · contains 15 · remove 7 · add 5)
[hidden]         4 자리   ← 플랫폼의 것이며 **이미 쓰고 있다**
.hidden          2 자리   (.search-bar · .status-bar)
.off             1 자리   (.git-diff-body)
.gone            1 자리   (.git-group)
.git-hidden      1 자리
```

`display:none` 선언은 92 선택자이고 그중 51이 `.vis` 짝을 갖는다. 나머지 41 중
아홉이 위의 다른 표현이고, 남은 것은 조건부 정적 숨김(`:empty` 4 · `body.mobile`·
`html.sb-collapsed` 8 등)이라 이 규약의 대상이 아니다.

**`.vis` 가 켤 때 주는 값이 네 종이다** — `block` 26 · `flex` 23 ·
`inline-block` 4 · `inline` 3. 그래서 `.vis` 를 붙이는 것만으로는 켜지지 않고,
**그 요소가 원래 어떤 display 였는지를 CSS 가 다시 알려 줘야 한다.** 빠뜨리면
켜지지 않거나 레이아웃이 무너진다.

#### 이 함정은 이미 겪고 주석으로 남아 있다

```css
web/style.css:1015-1020
.bk-confirm{ … display:flex;flex-direction:column;gap:10px; }
/* `display:flex` 가 `[hidden]` 의 기본 `display:none` 을 이긴다 — 되돌려 놓는다. */
.bk-confirm[hidden]{display:none}
```

`[hidden]` 의 UA 기본은 `display:none` 이지만 **작성자 규칙(0-1-0)이 그것을
이긴다.** 그래서 네 자리가 각자 `[hidden]{display:none}` 을 되돌려 적고 있다
(`.bk-confirm` · `.sb-tab` · `.sb-tab-badge` · `.sb-panel`).

**`.git-view` 의 여섯 재정의와 정확히 같은 형태다** — 기본값이 실사용과 반대여서
자리마다 되돌려 적는다.

### 2.1b 착수 실측이 최초 스펙의 전제 셋을 뒤집었다

최초 판은 "표현 여섯 종을 `[hidden]` 하나로 수렴" 이었다. 착수 전 실측이 그것을
셋에서 뒤집었다.

**① `.vis` 는 켜기/끄기만 하지 않는다 — `[hidden]` 으로 표현할 수 없는 자리가 넷.**

```
.fe-note.vis{opacity:1}              display 가 아니다 (전이)
.tp-overlay.visible{opacity:1}       일곱째 어휘 `.visible` (term-pane.js:627)
.fe-find.vis ~ .fe-note{top:38px}    형제 결합자 — 다른 요소를 바꾼다
.tp.vis>.xterm{height:100%}          자식 결합자
```

**② 어휘가 여섯이 아니라 일곱이었다** — `.visible` 을 세지 못했다.

**③ 죽은 규칙이 있다.** `.doc-render.vis{display:flex}` 는 기본이 이미
`display:flex` 이고 그것을 숨기는 CSS 가 하나도 없다. `.status-bar.hidden` 도
그 클래스를 붙이는 자리가 하나도 없다. **규약이 여러 벌이면 어느 것이 진짜인지
알 수 없다** 의 사례다.

#### 그래서 C1 의 증거가 두 층으로 갈린다

| 부분 | 증거 | 크기 |
|---|---|---|
| `[hidden]{display:none!important}` + 재정의 네 자리 삭제 | **(a)급.** 네 자리가 똑같은 수정을 각자 하고 있고 `style.css:1019` 가 그 함정을 주석으로 남겼다 | 5줄 |
| `.vis` 51선택자 · JS 69자리 이관 | **결함 증거 0.** C2 의 870px 잘림 같은 것이 하나도 없다 | 120자리 |

C2 는 살아 있는 결함이 있어 (a)급이었다. C1 의 **이관 부분**은 §2 의 (a)~(d)
어디에도 없다. 그래서 **증거 있는 부분 + 어휘 게이트**로 확정했다 (사용자 결정
2026-09-10 · D-7).

### 2.1c 작업 중 찾은 결함 하나 — 닫히지 않은 주석

`web/style.css:1419` 의 `/*` 가 **닫히지 않았다.** 그 설명은 `:1375` 에 이미
있었으므로 `*/` 를 잃은 **중복 붙여넣기**다. 파일 끝이라 잃는 것이 없어 아무도
몰랐지만, **그 뒤에 규칙을 하나만 더 붙이면 브라우저가 그것을 삼킨다.**

주석 균형 검사를 `check-skeleton.sh` 에 넣었다 (`FR-LAY-32`).

### 2.2 C2 — `.git-view` 의 기본이 실사용과 반대다

```css
web/style-git.css:12-13
.git-view{position:absolute;inset:0;display:none;overflow:auto;background:var(--bg)}
.git-view.vis{display:block}
```

**여덟 뷰 중 여섯이 그 둘을 뒤집는다** — 같은 두 줄이 여섯 벌이다.

```
.git-view.git-changes {overflow:hidden}  .git-view.git-changes.vis {display:flex;flex-direction:column}
.git-view.git-diff    {overflow:hidden}  .git-view.git-diff.vis    {display:flex;flex-direction:column}
.git-view.git-history {overflow:hidden}  .git-view.git-history.vis {display:flex;flex-direction:column}
.git-view.git-console {overflow:hidden}  .git-view.git-console.vis {display:flex;flex-direction:column}
.git-view.git-branches{overflow:hidden}  .git-view.git-branches.vis{display:flex;flex-direction:column}
.git-view.git-stash   {overflow:hidden}  .git-view.git-stash.vis   {display:flex;flex-direction:column}
```

뷰 이름은 `panel-life.js:84` 가 `'git-view git-'+view` 로 조립한다.

바깥이 `overflow:auto` 인 채로 안쪽 목록도 `overflow-y:auto` 면 스크롤러가 둘이
되어 머리가 함께 밀린다 — `style-git-views.css:88` 의 주석이 그 사실을 이미 적고
있다(*"목록만 스크롤한다. 바·refs·푸터는 고정이다"*).

### 2.3 그 결과 — **살아 있는 결함 둘** (실측)

`GIT_VIEWS` 는 **여덟**이다 (`changes`·`diff`·`history`·`branches`·`stash`·
`console`·`worktrees`·`submodules`). 재정의가 있는 것은 **여섯**이다.

남은 둘은 재정의를 아예 빼먹은 것이 아니라 **다른 선택자로 적었다.**

```css
web/style-git-views.css:596  .git-worktrees {display:flex;flex-direction:column;min-height:0;overflow:hidden}
web/style-git-views.css:657  .git-submodules{display:flex;flex-direction:column;min-height:0;overflow:hidden}
```

`.git-worktrees` 는 **0-1-0** 이고 `.git-view.vis` 는 **0-2-0** 이다. **진다.**

임시 탐침으로 행 60개를 넣고 계산값을 쟀다 (재고 지웠다).

| 뷰 | `display` | 뷰 `scrollHeight/clientHeight` | 목록 `scrollHeight/clientHeight` |
|---|---|---|---|
| `submodules` | **block** | **1504 / 634** | 1440 / 1440 (스크롤 안 함) |
| `worktrees` | **block** | **1509 / 634** | 1470 / 1470 (스크롤 안 함) |
| `branches` (대조) | flex | 634 / 634 | 목록이 자기 스크롤러 |

**870px 이상이 잘려 닿을 수 없다.** `display:flex` 를 적었는데 `block` 이
계산되므로 `.git-wt-list{flex:1 1 auto;min-height:0;overflow-y:auto}` 가 전부
무력화된다 — 목록의 높이가 곧 내용 높이라 자기 스크롤러가 서지 않고, 부모의
`overflow:hidden` 이 그것을 자른다.

**항목이 적은 픽스처에서는 드러나지 않아 e2e 가 통과하고 있었다.** `U-8` 이 말한
"이렇게 맞지 않는 ui" 가 가정이 아니라 **지금 화면에 있다.**

### 2.3b C1 쪽에서도 살아 있는 결함이 하나 — 모바일의 `m-add-tab`

`[hidden]` 을 세우고 탐침으로 모바일을 쟀더니 이것이 나왔다 (재고 지웠다).

```
m-add-tab: hidden=true  display=flex   ← 감추라고 했는데 보인다
split-h  : hidden=true  display=none
slot-add : hidden=true  display=none
```

`body.mobile .mtbtn.mobile-only{display:flex!important}` 가 **0-3-0 !important** 라
숨김 규칙(0-1-0 !important)을 이긴다. `FR-EDT-54` 는 *"Editor 창에는 편집기 탭만
있다 — 새 탭 버튼의 대상이 없다. 눌리지만 아무 일도 하지 않는 버튼은 고장으로
읽힌다"* 인데, **모바일에서 그것이 지켜지지 않았다.**

**어휘 통일 이전부터 있던 결함이다** — 옛 `.git-hidden{display:none!important}` 도
0-1-0 !important 여서 똑같이 졌다. 다시 말해 이 결함은 이 작업이 만든 것이
아니고, 이 작업이 **드러낸** 것이다.

`FR-LAY-1b` 가 그것을 닫는다. 명시도로 이기게 만들려면 해킹(`:not(#\9)` 류)이
필요하고 그러면 다음 사람이 왜 그런지 모른다 — 뜻을 적는 쪽을 골랐다.

### 2.4 C3 — 어긋난 자리가 **하나도 없다** (실측)

`position:absolute;inset:0` 22 · `position:relative` 26. 두 주석이 함정을 적고
있다.

```
style-editor.css:91   `.git-view` 가 `position:absolute;inset:0` 이므로 담는 쪽이 위치 기준이어야 한다.
style-editor.css:103  `.pn`·`.sp` 가 `position:absolute;inset:0` 이므로 담는 쪽이 위치 기준이어야 한다.
```

정적으로는 판정할 수 없다 — 담는 쪽이 실제로 위치 기준인지는 **DOM 부모 관계**다.
탐침으로 터미널 화면과 git 여덟 뷰의 모든 요소를 훑어 `position:absolute` 이고
`inset:0` 인 것의 `offsetParent` 가 부모인지 봤다.

**어긋난 자리가 없다.** 두 히트(`slider`·`i`)는 오탐이었다 — 부모가 이미
`position:relative`/`fixed` 이고 `offsetParent` 가 `null` 인 것은 그 요소가 숨은
서브트리에 있어서다.

  → **위 두 주석은 그 함정을 *겪고 고친* 기록이다.** 그러므로 C3 에서 바꿀 선언이
    없다. 산출물은 **게이트 하나**이고, 그것이 `U-8` 이 요구하는 재발 방지다
    (D-4).

### 2.5 이 저장소의 게이트 관용

여섯이 있고 전부 같은 형태다 — `scripts/check-*.sh` 가 grep 으로 규약 위반을
찾고 `make gates` 가 그것을 부른다. `check-seams.sh` 의 주석이 왜 있는지를
적는다: *"D1 이 이 검사를 그냥 통과해 들어온 뒤에 추가됐다."*

**정적 검사는 위반이 없을 때도 통과한다** (`M3_REFACTOR_NEXT_SESSION` §0-B).
그래서 새 게이트는 **임시 탐침으로 실제 검출을 확인하고 지운다** (`FR-LAY-40`).

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — C1: 숨김의 어휘를 하나로 굳힌다

**착수 실측이 최초 스펙의 전제 셋을 뒤집었다** (§2.1b). 이관을 전부 하는 안은
사용자가 기각했고(2026-09-10), **증거 있는 부분과 어휘 게이트**로 확정됐다.

#### 극성이 둘이다

| 극성 | 뜻 | 어휘 |
|---|---|---|
| **있으면 보임** | 켜는 클래스 | `.vis` (51자리 · 유지) |
| **있으면 숨김** | 끄는 표시 | **`[hidden]`** (플랫폼의 것) |

**FR-LAY-1** `[hidden]` 의 `display:none` 은 **한 자리**에서 온다.

```css
[hidden]{display:none!important}
```

`!important` 인 것은 작성자 규칙(0-1-0 이상)이 UA 기본을 이기기 때문이다(§2.1).
그것이 없으면 자리마다 되돌려 적어야 하고, **그것이 지금 네 자리에서 일어나는
일이다.** 가장 먼저 실리는 파일(`style-kit.css`)에 둔다.

**FR-LAY-1b** **"모바일에서는 보인다" 가 `hidden` 을 이기지 않는다.**
`[hidden]` 은 0-1-0 이라 `body.mobile .mtbtn.mobile-only{display:flex!important}`
(0-3-0 !important)에 **진다.** 그 세 규칙에 `:not([hidden])` 을 붙여 뜻을 정확히
적는다 — "모바일이면 보인다, **감추라고 하지 않았다면**".

  → **이것이 살아 있는 결함이었다** (§2.3b). 옛 `.git-hidden{display:none!important}`
    (0-1-0 !important)도 같은 이유로 졌으므로 **어휘 통일 이전부터** 있었다.

**FR-LAY-2** 그 한 줄이 서면 아래 네 재정의를 **지운다** — 되돌릴 것이 없다.
`.bk-confirm[hidden]` · `.sb-tab[hidden]` · `.sb-tab-badge[hidden]` ·
`.sb-panel[hidden]`.

**FR-LAY-3** **"있으면 숨김" 어휘 넷을 `[hidden]` 으로 모은다.** 넷 다
`display:none` 을 클래스로 켜는 형태이며, 그것이 곧 `[hidden]` 의 일이다.

| 어휘 | CSS | JS |
|---|---|---|
| `.hidden` | `.search-bar.hidden` | `app-search.js` 4자리 · `index.html:190` 의 초기 클래스 |
| `.off` | `.git-diff-body.off` | `panel-diff.js:254` |
| `.gone` | `.git-group.gone` + `.git-group.gone+.git-group` | `panel-changes.js:401` |
| `.git-hidden` | `.git-hidden{display:none!important}` | `renderer.js` 4자리 |

결합자는 그대로 표현된다 — `[hidden]` 은 속성 선택자이므로
`.git-group[hidden]+.git-group` 이 성립한다.

**FR-LAY-4** **죽은 규칙 둘을 지운다.**
- `.doc-render.vis{display:flex}` — 기본이 **이미** `display:flex` 이고 그것을
  숨기는 CSS 가 하나도 없다. `.vis` 를 붙이든 말든 아무 일도 없다
- `.status-bar.hidden{display:none}` — 그 클래스를 붙이는 자리가 **하나도 없다**
  (`index.html:199` 에도 없고 JS 에도 없다)

**FR-LAY-5** `.vis` 51자리는 **그대로 둔다.** 이관의 근거가 없다 — C2 의 870px
잘림 같은 결함이 하나도 나오지 않았고, `M3_REFACTOR_NEXT_SESSION` §2 가 "근거가
(a)~(d) 어디에도 없으면 하지 마라" 다.

**FR-LAY-6 (개정)** **`display` 를 다루지 않는 것은 이 규약의 대상이 아니다.**
- `#boot.gone{opacity:0;pointer-events:none}` · `.tp-overlay.visible{opacity:1}` ·
  `.fe-note.vis{opacity:1}` — **전이(transition)** 다. `display:none` 으로 바꾸면
  전이가 죽는다
- `.fe-find.vis ~ .fe-note{top:38px}` · `.tp.vis>.xterm{height:100%}` — 결합자로
  **다른 요소**를 바꾼다. 켜기/끄기가 아니다
- 조건부 정적 숨김 — `:empty` 4 · `body.mobile …` · `html.sb-collapsed …` 8

  → **`.gone` 이 두 뜻으로 쓰인다** — `.git-group.gone` 은 숨김이고
    `#boot.gone` 은 페이드다. 전자만 옮기고 후자는 남는다. 게이트가 그 구분을
    `display` 를 다루는가로 판정한다 (FR-LAY-30).

**FR-LAY-7** `[hidden]` 은 **접근성도 함께 준다** — 스크린 리더가 그 서브트리를
건너뛴다. `.hidden`·`.off`·`.gone` 은 그것을 주지 못했다. 이 변경의 부수 효과이며
되돌리지 않는다.

### 3.2 묶음 B — C2: 스크롤 소유권의 기본을 실사용에 맞춘다

**FR-LAY-20** `.git-view` 의 기본을 **실사용에 맞춘다.**

```css
.git-view{position:absolute;inset:0;display:flex;flex-direction:column;
          min-height:0;overflow:hidden;background:var(--bg)}
```

- 이전: `display:none` + `overflow:auto`, 켜면 `display:block`
- 새로: `display:flex;flex-direction:column;overflow:hidden`, 끄기는 `[hidden]`
- 이유: **여덟 중 여섯이 이미 그것으로 되돌리고 있었다.** 기본이 다수와 반대다

**FR-LAY-21** 그 기본이 서면 **여섯 뷰의 재정의 열두 줄을 지운다.**

**FR-LAY-22** `worktrees`·`submodules` 의 `.git-worktrees`·`.git-submodules`
규칙도 지운다 — 그 내용이 기본이 된다. **이것이 §2.3 결함의 수정이다.**

**FR-LAY-23** 바깥이 스크롤러이길 **정말로 원하는** 뷰는 그 사실을 명시한다.
지금 그런 뷰는 없다 — 여덟이 전부 "안쪽 목록만 구른다" 다.

**FR-LAY-24 (`U-7`)** `blame` 의 스크롤 소유권을 같은 규약으로 맞춘다.
`.git-blame{overflow:auto}`(`style-git-views.css:42`)는 **브라우저 네이티브**
스크롤이고, 같은 자리의 diff 는 `.git-diff-host` 안의 **Monaco 내부** 스크롤이다.
소유자·축·감각이 셋 다 다르다.

blame 은 Monaco 를 쓰지 않으므로 **Monaco 와 같아질 수는 없다.** 맞출 수 있는 것은
**소유권과 축**이다 — 바깥(`.git-blame`)이 `overflow:hidden` 이고 안쪽
(`.git-blame-rows`)이 `overflow-y:auto` 인 형태로 다른 일곱 뷰와 같게 한다.

**FR-LAY-25** **스크롤러는 겹치지 않는다.** 조상과 자손이 같은 축에서 동시에
스크롤러가 되면 머리가 함께 밀린다. 이것이 게이트의 대상이다 (`FR-LAY-31`).

**FR-LAY-26** 기본에 **`min-height:0` 을 넣는다.**

정확히 적는다 — `.git-view` 는 `position:absolute;inset:0` 이므로 **자기**
`min-height` 는 높이에 영향이 없다. 그것을 기본에 넣는 이유는 둘이다.

1. **지금 그것을 들고 있는 두 뷰**(`.git-worktrees`·`.git-submodules`, §2.3)의
   규칙을 지우면서 값을 잃지 않는다. 스냅샷의 `minHeight` 가 그 보존을 잰다.
2. `.git-view` 가 언젠가 flex 자식이 되면 그때 필요해진다 — 그 순간 여덟 자리에
   각자 더하는 일이 다시 생긴다.

**자손의 `min-height:0` 은 자손이 들고 있고 그대로 둔다** — `.git-wt-list`·
`.git-sub-list` 등이 이미 갖고 있으며, 그것이 "flex 열에서 자손이 줄어들 수
있다" 를 만드는 자리다.

#### `U-17` 과의 관계 — **덮지 않는다**

`U-17`("가끔 스크롤이 안 될 때가 있다. 새로고침하면 풀린다", 2026-09-10 접수)은
**이 스펙이 닫지 않는다.** 명시도 문제는 새로고침으로 풀리지 않으므로 §2.3 의
결함과 성질이 다르다 — 그쪽은 런타임 상태가 굳는 것이다.

다만 `FR-LAY-26` 이 **그 표면을 줄일 수는 있다.** "flex 자손이 줄어들지 못해
스크롤러가 서지 않는다" 는 `U-17` 의 유력한 후보 하나이고, 기본에 `min-height:0`
이 있으면 그 부류가 자리마다 빠뜨려질 수 없다.

  → **`U-17` 은 이 작업이 끝난 뒤 별도로 조사한다.** 이 스펙의 스냅샷(§5.1)이
    그 조사의 출발점이 된다 — "어느 자리가 어떤 계산값이어야 하는가" 가 파일로
    남기 때문이다.

### 3.3 묶음 C — 게이트 (요구의 절반)

**FR-LAY-30 (C1)** `scripts/check-visibility.sh` — 켜기/끄기가 `[hidden]` 밖으로
새는 것을 잡는다.
- `.vis`·`.hidden`·`.off`·`.gone`·`.git-hidden` 을 켜기/끄기로 쓰는 선택자가
  **하나도 없다**
- `[hidden]{display:none…}` 을 **되돌려 적는 자리가 없다** (`FR-LAY-2` 의 한
  자리만 허용)
- `classList.*('vis')` 가 JS 에 **하나도 없다**

**FR-LAY-31 (C2)** `scripts/check-scroll.sh` — 스크롤 소유권의 규약을 잡는다.
- `.git-view.git-*` 에 `overflow`·`display` 재정의가 **하나도 없다** (기본이
  옳으므로 재정의는 곧 기본이 틀렸다는 신호다)
- 뷰 이름 목록(`GIT_VIEWS`)과 CSS 가 어긋나지 않는다 — **여덟 뷰 중 일부만
  다루는 규칙이 없다.** §2.3 이 이 검사가 없어서 생겼다

**FR-LAY-32 (C3)** `scripts/check-skeleton.sh` — 골격 배치의 위치 기준을 잡는다.
`position:absolute` 와 `inset:0` 을 함께 선언한 규칙마다, 그 요소를 담는 쪽이
위치 기준을 갖는지 **정적으로 확인할 수 없다**(§2.4). 그러므로 이 게이트는
**선언 형태**만 본다 — `inset:0` 과 `position:absolute` 가 **같은 규칙 안에**
있어야 한다. 갈라 적으면 한쪽만 고쳐진다.

**FR-LAY-33** 세 게이트를 `make gates` 에 넣는다.

**FR-LAY-34** CI 의 게이트 잡(`.github/workflows/verify.yml`)에도 넣는다 —
기존 여섯이 거기 있다.

  → **`dongminal verify` 명령이 아니다.** 처음에 M2 DoD 의 "`dongminal verify` 에
    게이트 항목 추가" 를 그 명령으로 읽었는데 **틀렸다.** 그 명령은 서버를 띄워
    HTTP 표면을 두드리는 **런타임 종단간** 검사이며(`verify.go` 의 머리 주석:
    *"doctor 는 서버 없이 플랫폼 계층을 in-process 로 보고, verify 는 프로세스
    경계를 넘은 뒤를 본다"*), 정적 CSS 검사의 자리가 아니다. 기존 여섯 게이트도
    그 명령이 아니라 `make gates`·`verify.yml` 에 있다 (`M2_PROGRESS` §2.7).

**FR-LAY-40** **새 게이트는 임시 탐침으로 실제 검출을 확인하고 지운다.** "초록" 은
그 검사가 동작한다는 증거가 아니다 — 이 저장소의 `FR-GIT-1` 게이트가 git 실행
다섯 자리를 하나도 보지 못하면서 계속 초록이었다
(`M3_REFACTOR_NEXT_SESSION` §0-B).

### 3.4 묶음 D — 검증 수단

**FR-LAY-50** 성공 판정은 **아무것도 달라지지 않는 것**이다. 이 저장소에 시각
회귀 기준선이 없으므로 **계산값 스냅샷**을 쓴다.

이 변경이 만지는 속성은 넷뿐이다 — `display`·`overflow`·`position`·`inset`.
그러므로 전 화면의 모든 요소에서 그 넷과 **상자 기하**(`scrollHeight`·
`clientHeight`·상자 크기)를 떠서 변경 전후가 **같음**을 단정한다.

스크린샷보다 이 변경에 정확하고 결정론적이다 — 폰트 렌더링·안티앨리어싱이
끼어들 자리가 없다.

**FR-LAY-51** 스냅샷은 **§2.3 이 고쳐지는 자리만 예외**다. 그 둘은 달라져야
하며(`block`→`flex`, 잘림 해소), 그 차이가 스냅샷에 **명시적으로** 적혀야 한다.
"전부 같다" 로 뭉개면 결함 수정이 회귀와 구별되지 않는다.

---

## 4. 설계 결정 (Design Decisions)

**D-1 `[hidden]` 으로 수렴한다 — 새 클래스를 만들지 않는다.** `.u-off` 같은 것을
만들 수도 있지만 `[hidden]` 은 **플랫폼의 것**이고 이 저장소가 **이미 네 자리에서
쓰고 있다**(§2.1). 접근성(`FR-LAY-7`)도 딸려 온다. JS 도 `el.hidden = !on` 한 줄로
줄어 클래스 이름을 기억할 자리가 사라진다.

**D-2 `!important` 를 쓴다.** 이 저장소에서 `!important` 는 드물게 써야 하는
것이지만, 여기서는 **그것이 없으면 규약이 성립하지 않는다** — 작성자 규칙이 UA
기본을 이기고, 그것이 네 자리의 되돌려 적기를 만든 원인이다(§2.1). 한 자리의
`!important` 가 네 자리의 되돌려 적기와 앞으로의 전부를 없앤다.

**D-3 기본값을 뒤집는다 — 유틸리티 클래스를 도입하지 않는다** (사용자 결정
2026-09-10). `.u-fill`·`.u-scroll-y` 를 만들면 뜻이 이름으로 드러나 게이트가 잡기
쉬워지지만, 모든 뷰의 HTML 조립을 손대야 하고 **두 체계가 공존하는 기간**이
생긴다. 기본값을 뒤집는 쪽은 **선언이 줄어드는 방향**이라 회귀 면이 좁다.

**D-4 C3 는 선언을 바꾸지 않는다.** 실측에서 어긋난 자리가 **하나도 없다**(§2.4).
`M3_REFACTOR_NEXT_SESSION` §2 가 "근거가 (a)~(d) 어디에도 없으면 하지 마라" 이고,
C3 의 근거는 없다. 22곳을 근거 없이 흔들면 회귀 면만 커진다. 그러나 `U-8` 이
요구하는 **재발 방지**는 C3 에도 필요하므로 게이트는 세운다 —
**게이트는 근거 없이도 정당하다.** 그것이 요구의 절반이기 때문이다.

**D-5 게이트를 셋으로 가른다.** 하나로 합칠 수도 있지만 이 저장소의 관용이
"형태 하나에 검사 하나" 다(`check-seams`·`check-timers`·`check-gitwrite`·
`check-html`·`check-fetch`). 실패 문구가 무엇을 어겼는지 바로 말해야 한다.

**D-6 blame 을 Monaco 로 옮기지 않는다** (`FR-LAY-24`). `U-7` 은 "다른 뷰와
다르다" 이고 diff 는 Monaco 내부 스크롤이다. blame 을 Monaco 로 옮기는 것은
기능 변경이며 이 스펙의 범위가 아니다 — 맞출 수 있는 것은 **소유권과 축**이고
그것으로 요구는 만족된다.

---

## 5. 검증 (Verification)

### 5.1 계산값 스냅샷 (`FR-LAY-50`·`51`)

새 e2e 스펙 `e2e/ui-layout-defaults.spec.ts`.

| ID | 요구 | 검증 |
|---|---|---|
| **V-LAY-1** | FR-LAY-50 | 터미널 화면·Editor 창·git 여덟 뷰의 모든 요소에서 `display`·`overflow`·`position`·`inset` 과 상자 기하가 **기준선과 같다** |
| **V-LAY-2** | FR-LAY-51 | 예외는 `worktrees`·`submodules` 둘뿐이고, 그 둘은 `display` 가 `block`→`flex` 로 **달라진다** |

#### 기준선을 C1 단계에서 한 번 다시 떴다 — 그 이유와, 그래서 무엇이 C1 을 증명하는가

C2 단계는 스냅샷이 정확히 의도한 집합만 짚었다(§8 의 2단계 판정 통과). **C1 은
그럴 수 없었다** — 식별자가 클래스(`.gone`·`.git-hidden`)에서 **속성**으로 옮겨
가면서 클래스로 만든 키가 합쳐졌다. 기준선의 27개 키(`.git-hidden`·`.gone` 을
가진 것)가 사라지고, 숨은 요소가 보이는 요소의 키를 차지해 대조가 어긋났다.

그래서 둘을 했다.

1. **키에 `[hidden]` 을 넣었다** — 앞으로는 숨은 것과 보이는 것이 갈린다.
2. **C1 의 증명을 직접 검증으로 옮겼다** — 스냅샷이 아니라 `V-LAY-20`·`21`·`22`
   와 회귀 넷 378건이 답한다.

  → **재기준화는 "달라진 것이 없다" 의 증명이 아니다.** 그 사실을 여기 적어 둔다 —
    다음 사람이 이 기준선을 근거로 C1 이 무해했다고 읽으면 안 된다.

### 5.2 결함 수정 (`U-7` · §2.3)

| ID | 요구 | 검증 |
|---|---|---|
| **V-LAY-10** | FR-LAY-22 | `worktrees` 뷰에 행을 60개 넣어도 **잘리지 않는다** — 뷰의 `scrollHeight == clientHeight` 이고 목록이 자기 스크롤러다(`scrollHeight > clientHeight`) |
| **V-LAY-11** | FR-LAY-22 | `submodules` 도 같다 |
| **V-LAY-12** | FR-LAY-20 | 여덟 뷰 전부 `display:flex`·`flex-direction:column`·`overflow:hidden` 이다 — **하나도 예외가 없다** |
| **V-LAY-13** | FR-LAY-24 | `blame` 의 바깥이 `overflow:hidden` 이고 안쪽 행 목록이 `overflow-y:auto` 다 |
| **V-LAY-14** | FR-LAY-25 | 여덟 뷰 어디에도 **조상과 자손이 같은 축에서 동시에 스크롤러인 자리가 없다** |

### 5.3 켜기/끄기 (`FR-LAY-1`~`7`)

| ID | 요구 | 검증 |
|---|---|---|
| **V-LAY-20** | FR-LAY-1 | `[hidden]` 을 붙이면 `display` 가 `none` 이고, 떼면 **원래 값으로 돌아온다** — `flex`·`block`·`inline-block`·`inline` 네 종 각각. 돌아오는 것이 요점이다: `.vis` 규약이 켤 때의 값을 다시 적어야 했던 이유가 그것이다 |
| **V-LAY-21** | FR-LAY-3 | 옮긴 자리가 여전히 꺼지고 켜진다 — `#search-bar` 의 초기 상태(`index.html` 의 속성)와 `toggleSearch`·`closeSearch` |
| **V-LAY-22** | FR-LAY-1b | 모바일에서 `hidden` 이 `.mobile-only` 를 이긴다 — §2.3b 의 결함 |

### 5.4 게이트 (`FR-LAY-30`~`40`)

| ID | 요구 | 검증 |
|---|---|---|
| **V-LAY-30** | FR-LAY-30 | `check-visibility.sh` 가 통과한다. **그리고 임시 탐침**(`.vis` 를 쓰는 규칙 하나, `classList.toggle('vis')` 하나)을 넣으면 **실패한다** |
| **V-LAY-31** | FR-LAY-31 | `check-scroll.sh` 가 통과한다. 탐침(`.git-view.git-diff{overflow:auto}`)에 **실패한다** |
| **V-LAY-32** | FR-LAY-32 | `check-skeleton.sh` 가 통과한다. 탐침(`inset:0` 만 있고 `position` 이 없는 규칙)에 **실패한다** |
| **V-LAY-33** | FR-LAY-33·34 | `make gates` 와 `verify.yml` 의 게이트 잡이 새 검사를 부른다 |

### 5.5 회귀 넷

`[hidden]` 전환이 **켜기/끄기를 쓰는 화면 전부**에 닿는다. 51 선택자의 계열로
고른다.

```
git 계열     git-changes · git-diff · git-history · git-branches · git-stash ·
             git-console · git-worktrees · git-submodules · git-commit ·
             git-operation · git-blame(있으면) · git-hunk · git-dialog · git-confirm
editor 계열  editor-explorer · editor-ops · editor-tab · editor-find-panel ·
             editor-dirty-diff · repo-tab · repo-diff-edit · doc-render
그 밖        sidebar-tabs · sidebar-collapse · background-ui · runs · attention ·
             statusbar-xss · settings · layout · popup-default-action ·
             explorer-root-keys
```

---

## 6. 비목표 (Non-goals)

1. **색·간격·타이포그래피의 기본값.** 이 스펙은 **레이아웃 세 형태**만 다룬다.
2. **유틸리티 클래스 체계의 도입** (D-3).
3. **C3 의 선언 변경** (D-4) — 게이트만 세운다.
4. **blame 을 Monaco 로 옮기는 것** (D-6).
5. **시각 회귀(스크린샷) 기준선의 도입.** 이 변경의 판정에는 계산값 스냅샷이
   더 정확하다(`FR-LAY-50`). 스크린샷 기준선은 그 자체로 별도 작업이다.
6. **`GIT_VIEWS` 목록·뷰의 기능 변경.**
7. **모바일 전용 규칙(`body.mobile …`)과 조건부 숨김(`:empty`)** (FR-LAY-6).

---

## 7. 위험 (Risks)

| 위험 | 등급 | 완화 |
|---|---|---|
| **`[hidden]` 전환이 51 선택자·JS 69 자리에 닿는다** — 한 자리를 빠뜨리면 그 요소가 켜지지 않거나 꺼지지 않는다 | **HIGH** | 게이트(`FR-LAY-30`)가 **남은 `.vis` 를 하나도 허용하지 않는다** — 빠뜨림이 구조적으로 통과할 수 없다. 그리고 계산값 스냅샷(`V-LAY-1`)이 전후 동일성을 잰다 |
| `!important` 가 다른 규칙을 뜻밖에 이긴다 | MEDIUM | `[hidden]` 인 요소는 보이지 않아야 하는 것이고, 그것을 이기려는 규칙이 있다면 그 규칙이 결함이다. `V-LAY-20` 이 네 종 각각을 잰다 |
| 계산값 스냅샷의 기준선을 **변경 후에** 뜨면 아무것도 검증하지 못한다 | **HIGH** | 기준선을 **먼저** 떠서 파일로 커밋한다. 그것이 이 작업의 첫 단계다 |
| 시각적 차이(여백·경계)가 계산값 넷 밖에서 생긴다 | MEDIUM | 상자 기하(`clientHeight`·`scrollHeight`·`getBoundingClientRect`)를 함께 뜬다 — 여백이 바뀌면 기하가 바뀐다 |
| C3 게이트가 형태만 보므로 실제 위치 기준 누락을 못 잡는다 | LOW (수용) | §2.4 가 그 판정이 정적으로 불가능함을 적었다. 런타임 탐침은 이 스펙의 산출물이 아니다 — 필요해지면 e2e 로 옮긴다 |
| 묶음 A(C1)와 묶음 B(C2)를 한 번에 바꾸면 회귀의 출처를 가릴 수 없다 | MEDIUM | **단계를 나눈다** — 기준선 → C2(작다, 결함 수정 포함) → C1(크다) → 게이트. 각 단계마다 스냅샷을 대조한다 (§8) |

---

## 8. 실행 순서

성공 판정이 "아무것도 달라지지 않는 것" 이므로 **회귀의 출처를 좁히는 순서**로 간다.

```
1. 계산값 스냅샷의 기준선을 뜬다 (변경 **전**). 파일로 커밋한다
2. 묶음 B — C2: `.git-view` 기본 뒤집기 + 재정의 12줄 삭제 + §2.3 결함 수정
   + `U-7`(blame). 스냅샷 대조 — **worktrees·submodules 둘만 달라져야 한다**
3. 묶음 C 의 게이트 둘(scroll·skeleton). 탐침으로 검출 확인하고 지운다
4. 묶음 A — C1: `[hidden]` 수렴. 스냅샷 대조 — **하나도 달라지지 않아야 한다**
5. 묶음 C 의 게이트 하나(visibility). 탐침으로 검출 확인하고 지운다
6. 회귀 넷 (§5.5)
```

**2번과 4번 사이에 게이트를 세우는 이유**: `check-scroll.sh` 는 C2 가 끝나야
통과하고, `check-visibility.sh` 는 C1 이 끝나야 통과한다. 게이트를 먼저 세우면
그 사이 `make gates` 가 빨간 채로 남아 다른 실패를 가린다.

---

## 9. 변경 기록

- 2026-09-10 최초 작성. 범위(C1+C2+C3)와 방향(기본값을 실사용에 맞춘다)을 사용자
  결정으로 확정했다. 실측에서 **살아 있는 결함 둘**(§2.3)을 찾았고, **C3 는 어긋난
  자리가 하나도 없음**을 확인해 선언 변경을 비목표로 뒀다(D-4). 1차 실측의
  `overflow` 개수(148)를 **139** 로 정정했다.
- 2026-09-10 C1 을 착수 실측으로 개정했다 (§2.1b · D-7). 최초 판의 "표현 여섯
  종을 `[hidden]` 하나로 수렴" 이 전제 셋에서 틀렸다 — `.vis` 가 전이·결합자에도
  쓰이고(`[hidden]` 으로 표현 불가), 어휘가 **일곱**이었고, 죽은 규칙이 둘 있었다.
  이관 부분은 결함 증거가 0 이어서(C2 의 870px 잘림과 대조) **증거 있는 부분 +
  어휘 게이트**로 확정했다 (사용자 결정).
- 2026-09-10 구현·검증 완료.
  · **닫은 결함 셋** — `worktrees`·`submodules` 의 870px 잘림(§2.3) ·
    `blame` 의 스크롤 소유권(`U-7`) · **모바일 `m-add-tab`**(§2.3b, 어휘 통일
    이전부터 있던 것) · 그리고 `style.css` 끝의 **닫히지 않은 주석**(§2.1c)
  · **지운 선언** — 뷰별 재정의 14 · `[hidden]` 재정의 4 · 죽은 규칙 2
  · **게이트 셋** — `check-visibility.sh`·`check-scroll.sh`·`check-skeleton.sh`.
    `make gates` 와 `verify.yml` 에 넣었고, **일곱 형태의 위반을 탐침으로 하나씩
    확인하고 지웠다** (`FR-LAY-40`)
  · **검증** — `ui-layout-defaults.spec.ts` 7건 · 회귀 넷 378건 · 실패 0 ·
    `make gates` · `go test ./...` · `typecheck` · `lint` · `unit` 64건
  · **`FR-LAY-34` 를 정정했다** — "`dongminal verify` 에 넣는다" 로 썼는데 그
    명령은 런타임 종단간 검사이며 정적 CSS 검사의 자리가 아니다. 기존 여섯도
    `make gates`·`verify.yml` 에 있다
  · **기준선을 C1 단계에서 한 번 다시 떴다** — 그것이 무엇을 증명하지 **않는지**를
    §5.1 에 적었다
