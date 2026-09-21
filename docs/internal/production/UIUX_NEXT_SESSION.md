# UI/UX 전면 개편 이어서 — 착수 프롬프트 (M6 · 동작의 자리)

**M1~M5 가 구현·커밋됐다. 남은 것은 M6 하나이고, 그것은 착수 전에 조사가 선행한다.**

- `dbddb7fe` docs(spec): UI/UX 전면 개편의 스펙을 세운다
- `249cf858` fix: 글꼴은 토큰에서 오고 상태색은 ANSI 에서 온다 (M1·M2)
- `0476003a` fix: 선 하나가 위계 하나 — 경계를 3단으로 가른다 (FR-HIE-1)
- `437392ba` fix: 포커스는 탭줄에서 말한다 — 4변 테두리를 걷는다 (FR-HIE-2)
- `30494ed8` fix: 행 높이는 3단이고 폴더는 `/` 로 끝난다 (FR-HIE-3·5)
- `f1061cb5` fix: 모바일 상태바는 한 줄이고 눌러서 펼친다 (FR-HIE-4 개정 · FR-TYP-3)
- `b943b246` fix: 빈 자리는 다음 할 일을 말하고 복귀는 복귀다 (FR-CPY-1~3)
- `8404163f` fix: 긴 도구 이름이 패널을 밀지 않는다 (FR-ACT-6 · FR-ACT-5 대조)
- `e9849d4d` fix: 조회는 한 자리에 모인다 — 모달 둘과 팝오버가 사라진다 (FR-ACT-1~4)

---

```
프로젝트: /Users/dykim/personal/dongminal

## 0. 먼저 할 일 — e2e 빚 갚기

**이 인계의 첫 항목이다.** 앞 세션이 전체 e2e 를 끝까지 돌렸다:

    1,749 통과 · 13 실패 · 3 간헐   (178 스펙, 23.8분)

실패 열셋 중 **여섯이 이번 개편이 만든 것**이다. 판정 근거는 §2 의 표에 있고,
고치는 순서는 아래가 권장이다 — 쉬운 것부터, 결정이 필요한 것을 뒤로.

### ① git-detect-tier V-GDT-12 — 문구 (작다)

`e2e/git-detect-tier.spec.ts:162`. `git.hist_no_commits` 의 **정확한 문자열**을
단정한다. M4 의 FR-CPY-2 가 그 문구에 다음 할 일을 붙였다:

    옛: '커밋이 아직 없습니다'
    새: '커밋이 아직 없습니다 — Changes 탭에서 첫 커밋을 만듭니다'

`toHaveText` → `toContainText` 이거나 기대값 갱신. **빈 저장소와 필터 결과를
가르는 것**이 그 검증의 뜻이므로(FR-GDT-21) 그 뜻만 살아 있으면 된다.

### ② explorer-root-keys V-EXR-42 — 기하 (작다)

헬퍼 `dblBlankTabs` (`e2e/explorer-root-keys.spec.ts:371`)가 탭 바의 **오른쪽
끝에서 6px** 을 더블클릭한다. FR-HIE-2 가 `.pn{border:2px solid transparent}` 를
걷으면서 탭줄이 분할 손잡이에 맞닿았고, `.sh::before` 의 히트 확장(±6px)이 그
6px 을 덮는다 — 로그가 `<div class="sh"></div> intercepts pointer events` 를 찍는다.
**죽은 영역이 4px → 6px 로 늘었다.**

헬퍼는 이미 여백 폭(`gap`)을 재고 `gap > 16` 을 단정한다. 끝에서 6px 대신
**여백의 한가운데**를 누르면 손잡이 기하와 무관해진다. 덮는 것이 아니다 — 그
검증이 묻는 것은 "여백을 누르면 탭이 서는가" 이고 한가운데가 더 정확하다.
다만 **4px → 6px 사실은 커밋 메시지에 남겨라.**

### ③ slot-title-boundary "분할 손잡이는 종전대로다" — **스펙 충돌이다**

`e2e/slot-title-boundary.spec.ts:232`. `Expected rgb(68,71,90)` ·
`Received rgb(131,133,143)`.

FR-HIE-1 이 `.sh`(분할 손잡이)를 **창·칸의 경계**로 보고 `--border` →
`--border-strong` 으로 올렸다. 그런데 `SLOT_TITLE_BOUNDARY_SRS` 는 *"분할
손잡이는 종전대로다"* 를 **검증으로 얼려 두었다** — 그 문서의 FR-STB-21~23 이
슬롯 경계색(`--slot-edge`)을 세우면서 **손잡이는 건드리지 않는다**는 것을
설계로 정했기 때문이다.

**§3 ② 와 같은 부류다.** 혼자 판정하지 말고:
  1. `docs/internal/SLOT_TITLE_BOUNDARY_SRS.md` 에서 그 요구의 **근거**를 읽는다
  2. 손잡이가 `--border` 여야 하는 이유가 남아 있으면 FR-HIE-1 을 되돌린다
     (`.sh` 만 `--border` 로. 나머지 17자리는 그대로)
  3. 그 이유가 FR-HIE-1 에 흡수됐으면 그 문서에 **개정을 적고** 검증을 고친다
  4. 갈리지 않으면 **사용자에게 묻는다**

### ④ ui-layout-defaults V-LAY-1 — 기준선 세 판 (결정이 필요하다)

    재지 않는 자리 299 (기준선 269) — 30 늘었다

드리프트 기준선(`FR-DSY-30`)이다. 늘어난 목록에 **`terminal|span.sb-act.sb-item`**
이 있다 — FR-ACT-3 의 `⚡` 진입점이다. 나머지 스물아홉은 이번 개편의 것인지 아닌지
**가려 보지 못했다** (`m-drawer-acts`·`ui-btn-label`·`kb-nav…` 등은 무관해 보인다).

**이것이 §4 의 R-1 이 경고한 바로 그 벽이고, M6 이 아니라 지금 왔다.**
기준선은 **판마다 하나**다 (`e2e/ui-layout-defaults.spec.ts` 머리말 — 글꼴
메트릭이 판을 건너면 달라진다):

    e2e/baseline/ui-layout.darwin.json   macOS 에서만 다시 뜰 수 있다
    e2e/baseline/ui-layout.linux.json    그 판에서 떠야 한다
    e2e/baseline/ui-layout.win32.json    같음

    갱신: LAYOUT_BASELINE=write npx playwright test ui-layout-defaults

선례가 있다 — `0a581c12` "드리프트 기준선을 파생해 세 판을 모두 채운다".
**사용자에게 세 판을 어떻게 채울지 먼저 확인하라.**

### ⑤ git-dialog D6 · slot-view-state TC-SVS-57 — 미분류

    git-dialog.spec.ts:229  D6  `Expected 0, Received 1`
    slot-view-state.spec.ts:1077  TC-SVS-57  `page.waitForFunction` 타임아웃

앞 세션이 **기준선 대조를 하지 못했다.** §3 ⑤ 의 방법으로 `793fc633` 에서 먼저
돌려라 — 기존 결함이면 손대지 않는다.

### 그 뒤

각 스펙을 개별로 확인한 뒤 **전체 e2e 를 한 번 더 돌린다.** 그러고 나서 §4 로 간다.

## 1. 먼저 읽을 것

`docs/internal/UIUX_OVERHAUL_SRS.md` — 이번 개편의 스펙. 특히:
  §1.2  **범위.** 무엇이 비포함인지가 이 문서의 절반이다
  §3.2  확정된 결정 D-1~D-5 (사용자 결정 2026-09-21)
  §3.3  원칙 여섯 — 특히 3번(accent 는 "지금 어디" 에만)
  §4.2  **이번에 할 일** (FR-CHR-1~7)
  §8    리스크 — **R-1 이 M6 의 선행 조건이다**
  §10   후속 과제. **여기 있는 것은 이번에 하지 않는다**

문서 안의 `> 인용 블록`들은 **앞 세션이 구현하며 되받아 적은 것**이다 — 초판이
틀렸던 자리, 사용자가 가른 자리, 다른 문서와 부딪힌 자리가 거기 있다. 건너뛰지
마라. 특히 FR-HIE-4 · FR-CPY-1 · FR-ACT-1~3 의 블록.

기준선 화면 8장: `tmp/uiux-baseline/uiux-0{1..8}-*.png` (git 밖이다)
  **그 8장은 낡은 인스턴스에서 찍혔다** — §3 ① 을 반드시 읽어라.
이번 개편 중 찍은 것: 같은 폴더의 `m3-*`·`m5-*`

## 2. e2e 실패 전수 — 판정표 (앞 세션 실측, 전체 1회 완주)

| 실패 | 판정 | 근거 |
|---|---|---|
| `a11y-keyboard` 6건 | **기존** | `793fc633`(인계 커밋)을 체크아웃해 돌렸고 같은 6건이 실패했다 |
| `editor-tab` E22 | **기존** | `793fc633` 에서도 실패. `Expected 310, Received undefined` |
| `editor-explorer` X8 | **기존·간헐** | 기준선에서 1회 실패 후 재시도 통과. `--git-st-add` 가 테마 추종에 매인다 |
| `git-detect-tier` V-GDT-12 | **이번 개편** | M4 FR-CPY-2 의 문구 (§0 ①) |
| `explorer-root-keys` V-EXR-42 | **이번 개편** | FR-HIE-2 의 기하 (§0 ②) |
| `slot-title-boundary` 손잡이 | **이번 개편 · 스펙 충돌** | FR-HIE-1 vs `SLOT_TITLE_BOUNDARY_SRS` (§0 ③) |
| `ui-layout-defaults` V-LAY-1 | **이번 개편(일부)** | 드리프트 기준선 269 → 299. `span.sb-act` 가 그중 하나 (§0 ④) |
| `git-dialog` D6 | **미분류** | `Expected 0, Received 1` |
| `slot-view-state` TC-SVS-57 | **미분류** | `waitForFunction` 타임아웃 |

**간헐 3건**은 이름이 기록되지 않았다 — 재시도로 통과한 것들이다.

## 3. 값을 치르고 안 것 — 다시 치르지 마라

**① 기준선 8장은 낡은 인스턴스의 화면이다. 스펙이 그것을 결함으로 적었다.**
기준선은 2026-09-21 에 **이미 돌고 있던 서버**(`:58146`, 가동 18h54m)에서 찍혔고,
웹 자산은 바이너리에 임베드되므로(`web/embed.go`) 그 인스턴스는 **옛 코드**를 들고
있었다. 그래서 스펙의 §2.5·§2.7 이 **이미 고쳐진 것을 결함으로 적었다**:

  · §2.7 "Runs 빈 상태가 해라체" → `4eca1d02`(2026-09-20, 스펙보다 하루 전)가
    카탈로그 전체를 합쇼체로 옮겼고 `check-honorific` 이 해라체 0 을 잠근다.
    **FR-CPY-1 은 할 일이 없었다.**
  · §2.5 "Agents 닫기 버튼이 `--danger` 빨강" → `.ag-close` 는 2026-06-22 이래
    `--text-muted` 다. 기준선의 그 픽셀도 빨강이 아니라 **노랑**이다
    (실측 `rgb(98,89,32)`). **FR-ACT-5 도 할 일이 없었다.**

**스펙의 §2(현재 상태)를 그대로 믿지 마라. 코드에서 다시 재라.** M6 의 §2.3·§2.4
(상단바 위계·문맥 이동)도 같은 의심을 받아야 한다.

**② 스펙끼리 부딪히는 자리가 실재한다. 발견하면 멈추고 사용자에게 물어라.**
FR-HIE-4(상태바 우선순위 접힘)가 `STATUS_BAR_REFLOW_SRS` 와 정면으로 부딪혔다 —
그 문서는 *"창 크기 따라서 알아서 2줄 3줄로"* 라는 **사용자 지시**를 받아
FR-SBR-1·3 으로 "어떤 폭에서도 전부 보인다" 를 정했고 D-1 이 접기를 명시적으로
버렸다. `UIUX_OVERHAUL_SRS` §1.4 참조 목록에 그 문서가 **없었다** — 알고 뒤집은
것이 아니라 못 본 것이었다.

사용자가 **"모바일만 접는다"** 로 갈랐다 (2026-09-21). 두 문서 모두에 개정을
기록했다. **M6 도 같은 위험이 있다** — `#topbar` 를 해체하기 전에 그 버튼들을
못박은 요구가 어디 있는지 먼저 찾아라 (§4 R-1).

**③ 다른 문서의 계약을 함께 고쳐야 한다.** 모달 둘을 없애는 일이 네 문서를
건드렸다: `DESIGN_TOKENS_SRS` TC-TOK-21(일곱→다섯)·FR-TOK-43 잔여표 ·
`KIT_COMPONENTS_SRS` FR-CMP-82·TC-CMP-16 · `ORCHESTRATION_V2_SRS` FR-RVZ-2 ·
`PANEL_SURFACE_SRS` FR-AGG-2·4. **계약을 느슨하게 만든 것이 아니라 대상이
줄었다** — 그 구별을 문서에 적어라.

**④ 화면 검증은 `--isolated` 로 한다. 운영 인스턴스를 건드리지 마라.**

    go build -o /tmp/dm-x ./cmd/dongminal
    /tmp/dm-x start --isolated          # 기동 출력이 포트를 찍는다
    …검증…
    pkill -f "dongminal-iso"            # stop 이 데몬을 못 죽일 때가 있다

**웹 자산은 바이너리에 임베드된다** — CSS·JS 를 고쳐도 돌고 있는 서버에는
반영되지 않는다. **재빌드해야 한다.** 이것이 ① 의 원인이기도 하다.

**⑤ e2e 는 `globalSetup` 이 시작 시점의 소스로 바이너리를 만든다.**
**도는 중에 파일을 고치거나 커밋을 오가지 마라** — 앞 세션이 기준선 대조를 하려고
도는 중에 `git checkout` 해서 전체 판 하나를 통째로 버렸다.

기준선 대조는 이렇게 한다 (전체가 멎은 뒤에):

    git stash push -u -m wip
    git checkout -q 793fc633
    DM_E2E_PORT0=47311 npx playwright test <스펙> --reporter=list -g "<이름>"
    git checkout -q main && git stash pop

**⑥ 모바일 터치 하한이 22px 짜리 상태바와 부딪힌다.**
`body.mobile .ui-btn{min-height:var(--touch-min)}`(44px)이 상태바에 버튼을 놓는
순간 바를 22 → 49px 로 키운다. FR-HIE-4 가 아끼려던 것이 정확히 그 30px 이었다.
**상태바에는 새 컨트롤을 놓지 않는다** — 누르는 대상은 바 자신이고 상태는
`::after` 글리프가 말한다. M6 이 상태바에 위치(FR-CHR-4)를 내릴 때 같은 벽을 만난다.

**⑦ 모듈 크기 게이트가 500줄에서 막는다.**
`app-statusbar.js` 가 그것을 두 번 넘었고 두 번 다 **뜻이 있는 경계**로 갈랐다
(`app-statusbar-fold.js` · 모달 제거). 가르려고 가르지 마라 — 갈랐으면
`FE_MODULE_BOUNDARY_SRS` §7.1 의 기준선을 갱신해야 게이트가 통과한다.

**⑧ 게이트가 줄 번호를 박아 둔 자리가 있다.**
`scripts/check-button-kit.mjs` 의 예외표가 `web/index.html:337` 을 가리킨다.
그 파일의 줄이 움직이면 게이트가 빨개진다 — 예외표의 숫자를 함께 고친다.

**⑨ `reconcileList` 는 `{el}` 항목을 받는다.**
활동 패널이 남의 표면(`_bgRow`·`_runsRow`·`.attn-item`)을 그대로 쓰는 방법이
이것이다 — `sig` 가 `el.outerHTML` 이라 값이 같으면 옛 요소가 산다. 매 회차
요소를 만드는 비용은 들지만 DOM 은 흔들리지 않는다 (FR-RPT-3).

**⑩ 표면을 옮기면 그 표면의 동작도 따라와야 한다.**
주의 팝오버를 걷을 때 머리글의 **"모두 제거"** 가 함께 사라져 `_attnClearAll` 의
호출처가 0 이 됐다. 구역 서술자에 `act` 자리를 만들어 되살렸다. **없앤 표면의
버튼을 하나씩 세어라.**

## 4. M6 — 동작의 자리 (FR-CHR-1~7) · 위험 HIGH

### R-1 조사 (착수 전 필수)

스펙 §8 R-1: *"e2e 191개 파일이 `#topbar`·`#split-h`·`#runs-btn` 셀렉터에
의존한다. **M6 착수 전 셀렉터 의존 전수 조사. 조사 없이 착수하지 않는다.**"*

앞 세션이 그 조사를 **절반**까지 했다. 실측:

| 셀렉터 | e2e 파일 | 자리 |
|---|---:|---:|
| `#topbar` | 2 | 4 |
| `#split-h` | 11 | 22 |
| `#split-v` | 6 | 7 |
| `#runs-btn` | 1 | 3 |
| `#bg-btn` | 4 | 15 |
| `#agents-toggle` | 4 | 9 |
| `#slot-add` · `#slot-remove` | 2 · 1 | 6 · 4 |
| `#window-name` | 2 | 3 |
| `#attn-badge` | 3 | 13 |
| `.tbtn` | 3 | **147** |
| `desktop-only` | 4 | **118** |

**뒤의 둘이 진짜 위험이다.** `.tbtn` 147 과 `desktop-only` 118 은 거의 전부가
**레이아웃 기준선 JSON** 에 있다:

    e2e/baseline/ui-layout.darwin.json   .tbtn 49 · desktop-only 39
    e2e/baseline/ui-layout.linux.json    같음
    e2e/baseline/ui-layout.win32.json    같음

`e2e/ui-layout-defaults.spec.ts` 의 머리말이 그 이유를 적는다 — **기준선은 판마다
하나**이고 글꼴 메트릭이 판을 건너면 달라지기 때문이다. 그래서:

  · macOS 에서는 `LAYOUT_BASELINE=write npx playwright test ui-layout-defaults`
    로 **darwin 판만** 다시 뜰 수 있다
  · linux·win32 는 **그 판에서 떠야 한다.** 선례가 있다 — `0a581c12`
    ("드리프트 기준선을 파생해 세 판을 모두 채운다")

**`#topbar` 를 해체하면 세 판의 기준선이 전부 어긋난다.** 착수 전에 사용자에게
그 비용을 말하고, 세 판을 어떻게 채울지 정한 뒤에 시작하라.

### 남은 조사

  · 상단바 버튼의 **id 를 못박은 요구**가 어느 문서에 있는지 (②의 교훈).
    `WORDING_COLOR_SRS` FR-WRD-51 이 이미 셋을 열거한다 — `FR-SBR-11`(`Background`
    이름) · `FR-RVZ-1`(상단바 구성과 `Runs`) · `GIT_UI_REVISION_SRS` V70
    (`Split H`·`Split V` 의 유무를 단정). **그 문서들을 같은 변경에서 고치지
    않는 한 낱말을 바꾸지 않는다** 는 것이 그 요구다
  · `PANEL_SHORTCUTS_SRS` 가 `FR-RVZ-1` 을 참조한다
  · 모바일 상단바는 **유지**다 (FR-CHR-6) — pane 페이저가 그 자리를 요구한다

### FR-CHR 의 요지 (스펙 §4.2 가 정본)

  FR-CHR-1  `#topbar`(32px)를 없앤다. 그 세로는 터미널이 받는다
  FR-CHR-2  pane 탭줄 오른쪽 끝에 고정 3구: `+` · `⊞`/`⊟` · `⋯`
  FR-CHR-3  **동작의 자리는 모드와 무관하게 고정.** 쓸 수 없으면 `disabled`,
            사라지지 않는다
  FR-CHR-4  현재 위치는 상태바 왼쪽으로. 클릭하면 사이드바의 그 항목으로
  FR-CHR-5  드문 것(슬롯 ± · 프리셋 · Runs)은 `⋯` 메뉴로. **단축키는 하나도
            바뀌지 않는다**
  FR-CHR-6  모바일 상단바는 유지
  FR-CHR-7  "새로 만든다" 의 자리를 둘로: 탭줄 · 사이드바 상단

**M5 가 남긴 것**: 상단바의 `Runs`·`Background`·`Agents` 세 버튼은 **지우지
않았다.** 셋 다 이제 같은 활동 패널을 여는 진입점이고, 해체는 M6 의 일이다.
상태바에는 이미 `⚡ n` 이 섰다 (`.sb-act`).

## 5. 규약 — 이 개편에서 변하지 않는 것

- **기능을 더하지 않는다** (D-4). 자리·위치·구분·디자인만 바꾼다
- **탭 이름·라벨의 구분은 별도 진행이다** (D-5). §10 ③ 참조
- **테마 팔레트의 값을 고치지 않는다.** 54종은 정본이다 (D-TOK-1)
- **기존 단축키를 하나도 없애지 않는다** (NFR-4)
- 커밋 전 `make gates` · `npm run unit`. **영향 스펙 e2e 도 돌린다**
- **커밋 메시지에 AI 서명(Co-Authored-By 등)을 넣지 않는다**
- 동작이 바뀌면 **이전 동작 / 새 동작 / 이유** 세 줄을 남긴다
- 다른 문서의 요구를 뒤집으면 **그 문서에 개정을 적는다** (③)

## 6. 사용자 결정 — 아직 유효하다

  D-1 타이포   역할로 가른다 — 기계값=mono, 사람말=sans (M1 구현)
  D-2 크롬     #topbar 해체 — 동작은 pane 탭줄, 위치·상태는 상태바 (**M6**)
  D-3 의미색   ANSI 6색 전면 사상 (M2 구현)
  D-4 범위     기능 추가 없음
  D-5 범위     탭 이름은 이 묶음이 다루지 않는다
  ─ 2026-09-21 추가 ─
  상태바 접힘  **모바일만 접는다.** 데스크톱은 종전대로 줄을 넘긴다
  숨은 지표    **상태바를 눌러 펼친다** (닿는 길을 둔다)

먼저 §0 의 e2e 빚 둘을 갚고, 그 다음 §4 의 R-1 조사를 끝낸 뒤 사용자에게
기준선 세 판의 비용을 말하라. **그 대화 전에 `#topbar` 를 건드리지 마라.**

다만 **§0 ④ 의 기준선 결정이 그보다 먼저 온다** — 그것이 이미 빨갛기 때문이다.
```
