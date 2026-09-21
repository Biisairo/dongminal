# UI/UX 전면 개편 이어서 — 착수 프롬프트 (M6 마무리 · 빨강 열여덟)

**M1~M5 와 M6 의 본체가 구현·커밋됐다. 남은 것은 M6 이 만든 e2e 빨강 열여덟과
기준선 두 판이다.**

- `78ddf342` fix(e2e): 개편이 만든 빚 셋을 갚는다 — 문구·기하, 그리고 손잡이는 되돌린다
- `033dcd1d` fix(e2e): 드리프트 기준선을 269·116·116 에서 40 으로 내린다
- `e34b7206` fix(e2e): CI 가 건넨 linux·win32 기준선을 받는다 — 세 판이 전부 40
- `0f36da87` fix(ui): 쪼개는 동작은 자리를 지킨다 — 감추던 것을 비활성으로 (FR-CHR-3)
- `266d928e` feat(ui): 탭줄에 고정 구가 선다 — 분할이 pane 의 자리로 (FR-CHR-2)
- `40222d29` feat(ui): 드문 것이 `⋯` 로 모인다 — 칸 ± 와 Runs (FR-CHR-5)
- `cad8b43d` feat(ui): 상단바가 해체된다 — 동작은 탭줄로, 위치는 상태바로 (FR-CHR-1·4)

**푸시된 것은 `e34b7206` 까지다.** 뒤의 넷은 로컬에만 있다.

---

```
프로젝트: /Users/dykim/personal/dongminal

## 0. 먼저 할 일 — M6 이 만든 빨강 열여덟

전체 e2e 실측 (`cad8b43d`, 25.0분):

    1,743 통과 · 28 실패 · 1 flaky · 3 스킵

스물여덟의 판정은 **전수 끝났다.**

| 실패 | 수 | 판정 |
|---|---:|---|
| `a11y-keyboard` TC-A11Y-6a·6a-del·6b·6b-del·6d·7 | 5(+flaky 1) | **기존** — 인계 판정표가 확정 |
| `editor-tab` E22 | 1 | **기존** — `Expected 310, Received undefined` |
| `optimistic-layout` V-OPL-1·2·3e | 3 | **기존** — `fa04458b` 에서도 같은 셋이 진다 |
| `ui-layout-defaults` V-LAY-1 | 1 | **예정** — §2 가 닫는다 |
| **나머지** | **18** | **이번 개편이 만들었다 — 아래 여섯 갈래** |

원인은 여섯이고 **전부 좁혀 두었다.** 쉬운 것부터 적는다.

### ① tooltips 13건 — 한국어 툴팁 하나 (가장 크고 가장 쉽다)

    Error: 기본 화면: title 이 한국어인 버튼
      {"cls":"… pn-act pn-menu","title":"이 칸의 메뉴"}

`core.pane_menu_title` 이 **한국어**다. `FR-TIP-2` 는 *"툴팁은 영어다"* 이고
`tooltips.spec.ts` 의 C1~C15 가 화면마다 그것을 훑으므로 **한 자리가 열셋을
빨갛게 만든다.**

고치는 곳은 `web/js/i18n/ko.js` 의 그 한 줄이다 — `en.js` 는 이미 영어다.
`aria-label` 은 그대로 한국어여야 한다 (읽히는 말이므로). `_makePaneMenuBtn` 이
`title` 과 `aria-label` 에 같은 키를 쓰고 있으니 **둘을 가른다.**

### ② git-ui-metrics V80 — 히트 영역 24×26 (하한 30)

    히트 영역 30px 미만: pn-split(24×26) ×2 · pn-menu(24×26)

`.pn-act{width:24px}` 가 `GIT_UI_REVISION_SRS` V80(VSCode 하한)에 걸린다.
**`.pn-tab-add` 도 24px 인데 그것은 걸리지 않았다** — 그 검사가 무엇을 대상으로
삼는지 먼저 읽어라 (`e2e/git-ui-metrics.spec.ts:68`). 탭줄은 28px 이므로 높이를
키우면 줄이 자란다. `::before` 로 히트만 넓히는 길이 있다 (`.sh::before` 가
±6px 로 이미 쓰는 수법이고, 그 부작용은 §3 ② 가 적었다).

### ③ kit-button TC-KIT-6a — 버튼 수가 전제를 깼다

    expect(all.length, '버튼을 찾지 못했다').toBeGreaterThan(10)  → 9

기본 화면의 버튼이 상단바 해체로 줄었다. **검사의 전제였지 계약이 아니다** —
`> 10` 은 *"표본이 있는가"* 를 말하는 줄이다. 수를 낮추되 **왜 낮추는지**를
적어라. 대상 자체가 준 것이지 킷이 느슨해진 것이 아니다.

### ④ ui-kit-icons V-GAP-1 — `getComputedStyle(null)`

    TypeError: parameter 1 is not of type 'Element'

이 세션이 `#agents-toggle` 을 `ACT_BTN` 으로 바꾼 자리(`:63`)가 열던 표면을
그 뒤 `:119` 가 `querySelector` 로 다시 찾는다. 무엇이 null 인지 그 줄에서
확인하라.

### ⑤ git-window E6 — Repo 창에는 `.pn.focused` 가 없다

    Locator: '#area .pn.focused .pn-acts .pn-split' — element(s) not found

`SPLIT_H` 의 기본 `paneSel` 이 `#area .pn.focused` 인데 **Repo/Editor 창은
`.ed-win` 골격이라 그 선택자가 맞지 않는다.** `splitBtn(dir, paneSel)` 이 두
번째 인자를 받으므로 그 창의 자리를 주면 된다 — 먼저 Repo 창의 탭줄이 실제로
어느 요소 아래 서는지 보라 (`renderer-layout.js`).

**이것이 FR-CHR-2 의 미완이기도 하다.** 고정 구가 Repo 창의 탭줄에도 서는지
확인하라 — 서지 않는다면 그것은 e2e 가 아니라 **구현**이 할 일이다.

### ⑥ window-slots TC-WSL-54b — 창이 5가 되지 않는다

    #add-window 클릭 뒤 창 수가 4 에 멈춘다 (기대 5)

조사가 안 됐다. `#add-window` 는 사이드바 상단이고 이 개편이 건드리지 않았다 —
**부하성인지 먼저 가려라** (단독 실행). 기존 결함일 수도 있다: 이 세션은
`fa04458b` 대조를 `optimistic-layout` 에만 했다.

### 그 뒤

각 스펙을 개별로 확인한 뒤 **전체 e2e 를 한 번 더 돌린다.**

## 1. 기준선 두 판 — CI 가 건네야 닫힌다

`V-LAY-1` 은 **darwin 에서는 초록**이다. `linux`·`win32` 는 `cad8b43d` 가 파일을
지웠으므로 FR-LAY-53 의 길로 CI 가 다시 떠야 한다.

    1. §0 의 열여덟을 고치고 커밋한다
    2. origin/main 에 푸시한다
    3. CI 의 샤드 7/8 이 두 OS 에서 진다 — **설계대로다**
       ("이 판(linux)의 기준선이 없다 … e2e/baseline/ 로 커밋하라")
    4. gh run download <id> -n playwright-report-<os>-7 -D <dir>
       test-results/ui-layout.{linux,win32}.json 을 e2e/baseline/ 로 옮겨 커밋

**수는 이미 적혀 있다** — `UI_LAYOUT_DEFAULTS_SRS` §9 의 `드리프트: darwin=40
linux=40 win32=40`. 면제 수는 키 집합만 쓰고 키 집합은 판을 타지 않는다(§9 의
2026-09-21 정정). 앞 회차가 그 파생을 실측으로 확인했다 — 세 판의 키가 한 자리도
다르지 않았다.

**darwin 기준선을 다시 뜨지 마라.** §0 의 수정이 DOM 을 또 바꾸면 그때 뜬다:

    LAYOUT_BASELINE=write npx playwright test ui-layout-defaults

## 2. 값을 치르고 안 것 — 다시 치르지 마라

**① 없는 id 를 가드 없이 읽는 줄은 앱 전체를 끈다.**
`input-binding.js` 의 `bind()` 가 `getElementById('split-h').addEventListener(…)`
로 시작했다. 그 요소를 걷자 **거기서 예외가 나 그 뒤의 배선이 전부** 붙지 않았다
— 설정 버튼까지. a11y 스펙 일곱이 그것을 잡았고, 증상은 *"설정 모달이 열리지
않는다"* 였다. **요소를 걷을 때는 그것을 읽는 자리를 전수 조사하라**
(`grep "getElementById('<id>')"`).

**② `I18N.apply` 는 단축키 표가 없으면 그 요소를 통째로 건너뛴다.**
`if(d.i18nShortcut&&!sc) continue` — 아이콘만 있는 버튼이 그 회차를 이름 없이
지나면 axe `button-name` 이 올라온다. **이름은 단축키를 기다리면 안 된다**:
낱말 키로 `aria-label` 을 먼저 세우고 툴팁만 표가 온 뒤에 채워지게 둔다.

**③ `check-button-kit.mjs` 의 예외표가 `web/index.html` 의 줄을 숫자로 든다.**
이 세션에서 **두 번** 빨개졌다 (스프라이트 한 줄 추가로 337→338, 상단바 해체로
338→326). 그 파일의 줄이 움직이면 그 숫자를 함께 고쳐라.

**④ playwright 를 겹쳐 돌리지 마라.** 한 회차의 teardown 이 다른 회차의
바이너리를 지운다 (`spawn … ENOENT`). 이 세션이 그것으로 검증 하나를 통째로
버렸다. §3 ⑤ 의 같은 부류다.

**⑤ 모바일에서는 요소가 남고 CSS 가 감춘다.** `_rTabs` 는 판을 보지 않는다 —
판정은 `body.mobile` 한 자리다. 그래서 모바일 검증은 `toHaveCount(0)` 이 아니라
`toBeHidden()` 이다.

**⑥ `#area .slot` 은 칸이 하나면 DOM 에 서지 않는다.** 요소를 세면 0 에서 2 로
뛴다. 칸의 수는 `app.slotCount()` 에 물어라.

**⑦ 계약이 뒤집힌 검증은 지우지 말고 개정하라.** 이 세션이 둘을 그렇게 했다
(`TC-SBR-5` · `TC-WSL-21c`). 초판이 **무엇을 막으려 했는지**를 먼저 읽고, 그
목적이 남아 있으면 그것을 재는 문장으로 다시 적는다. 두 경우 모두 목적은 살아
있었다.

**⑧ 앞선 인계의 §3 ①~⑩ 은 여전히 유효하다.** 특히 ④(격리 인스턴스로 화면
검증) · ⑤(e2e 도는 중에 파일을 고치거나 커밋을 오가지 마라) · ⑦(모듈 크기
게이트) · ⑨(`reconcileList` 는 `{el}` 항목을 받는다).

**⑨ 스펙의 §2(현재 상태)를 그대로 믿지 마라 — 세 번 틀렸다.**
§2.7(Runs 빈 상태 해라체) · §2.5(Agents 닫기가 danger) 에 이어 이 세션이
**§2.3** 을 잡았다: *"`Background n` 이 `.ui-btn-attn` 노랑으로 시각 무게가 가장
높다"* 는 틀렸다. `#bg-btn` 은 `ui-btn-attn` 을 **가진 적이 없고**(마크업 이력
전수 확인) 노랑은 `Agents` 였으며, `#bg-btn.on` 은 M2 의 FR-SEM-1 이 이미
magenta 로 고쳤다.

## 3. 사용자 결정 — 아직 유효하다

  D-1 타이포   역할로 가른다 — 기계값=mono, 사람말=sans (M1)
  D-2 크롬     #topbar 해체 (M6 — **구현됨**)
  D-3 의미색   ANSI 6색 전면 사상 (M2)
  D-4 범위     기능 추가 없음
  D-5 범위     탭 이름은 이 묶음이 다루지 않는다
  ─ 2026-09-21 ─
  상태바 접힘  모바일만 접는다. 데스크톱은 종전대로 줄을 넘긴다
  숨은 지표    상태바를 눌러 펼친다
  분할 손잡이  `.sh` 는 `--border` 로 되돌린다 (FR-HIE-1 이 물러났다)
  기준선       세 판을 전부 다시 뜬다 (수만 올려 적지 않는다)
  비활성/감춤  **가르는 것은 모드가 아니라 컨트롤이다** — 쪼개는 동작(분할·칸 ±)은
               자리를 지키고 `disabled`, 탭 `+` 는 만들 대상이 없어 감춘다.
               Git·Editor 에 같은 로직
  주의 배지    `⚡` 가 대신한다 (별도 배지 없음)
  프리셋       `⋯` 에 넣지 않는다 — 이미 사이드바 상단이고 FR-CHR-7 이 그 자리를
               못박는다 (이 세션의 구현 판정, 스펙에 기록)

## 4. 규약 — 이 개편에서 변하지 않는 것

- **기능을 더하지 않는다** (D-4). 자리·위치·구분·디자인만 바꾼다
- **탭 이름·라벨의 구분은 별도 진행이다** (D-5)
- **테마 팔레트의 값을 고치지 않는다.** 54종은 정본이다 (D-TOK-1)
- **기존 단축키를 하나도 없애지 않는다** (NFR-4)
- 커밋 전 `make gates` · `npm run unit`. **영향 스펙 e2e 도 돌린다**
- **커밋 메시지에 AI 서명(Co-Authored-By 등)을 넣지 않는다**
- 동작이 바뀌면 **이전 동작 / 새 동작 / 이유** 세 줄을 남긴다
- 다른 문서의 요구를 뒤집으면 **그 문서에 개정을 적는다**
- **§1.4 참조 목록을 먼저 보라.** 이 개편에서 참조 누락이 **세 번** 부딪혔다
  (FR-HIE-4↔STATUS_BAR_REFLOW · FR-HIE-1↔SLOT_TITLE_BOUNDARY ·
  FR-CHR-3↔GIT_UI_REVISION+EDITOR_TAB). 세 번 다 목록에 없어서 부딪혔다

## 5. 먼저 읽을 것

`docs/internal/UIUX_OVERHAUL_SRS.md` — 이번 개편의 스펙. 특히:
  §1.4  참조 목록 (규약의 마지막 줄)
  §4.2  FR-CHR-1~7 — **인용 블록이 구현 판정을 담는다**
  §4.3  FR-ACT-1~6 — `⚡` 가 무엇을 세는지
  §10   후속 과제. **여기 있는 것은 이번에 하지 않는다**

`docs/internal/UI_LAYOUT_DEFAULTS_SRS.md` §9 — 기준선의 규약과 두 회차의 기록.

문서 안의 `> 인용 블록`은 **구현하며 되받아 적은 것**이다 — 초판이 틀렸던 자리,
사용자가 가른 자리, 다른 문서와 부딪힌 자리가 거기 있다. 건너뛰지 마라.

먼저 §0 의 ① 부터 시작하라 — 한 줄이 열셋을 고친다.
```
