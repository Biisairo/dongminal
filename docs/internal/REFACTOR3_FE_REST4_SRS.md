# SRS: 리팩토링 3차 PROD3 FE 나머지 R4 — CSS — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `refactor/PROD3.md` §2.1 FU-9 · §2.2 FU-18 · §2.3 FU-10 · §2.5 FU-11 · §2.6 FU-8 · §4.3 CSS 크기 줄, §7.1 「P3 FE 나머지 — 정리」 의 하위 묶음 R4)
- 사용자 결정: 진행은 묻지 않고 끝까지 한다(`REFACTOR_PROD3_HANDOFF_2.md` §8). 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다. 범위를 줄이거나 동작을 바꿔야 하면 멈추고 묻는다.
- 실측 기준: HEAD `2cc9e4b3`. 아래 `파일:줄` 은 그 커밋의 것이다. PROD3 의 줄 번호(`c96988c7`)와는 R3b 의 `.pv-*` 규칙만큼 어긋난다(`style.css` 2,492 → 2,545줄).
- 사용자 결정 (2026-11-22, R4b): "FU-10 은 이번에 끝까지 한다. 다만 모든 간격이 하드코딩돼 있어 서로 다른 값마다 상수를 만들면 너무 많아진다. 어느 정도 공통화해 묶어야 하고, 이 과정에서 달라지는 결과값(골든 변경)은 어느 정도 인정한다." 적용 규칙은 D-FR4-15~22 가 정한다.
- R4b 실측 기준: HEAD `a3b864ce`.
- 나눔: R4 는 둘로 나눈다. **R4a**(FU-18 · FU-8 · FU-9 · FU-11)는 화면을 바꾸지 않는 정리다. **R4b**(FU-10 간격 토큰)는 간격을 토큰으로 바꾸고 일부를 1~2px 붙인다(§2.5·§5). 둘 다 이 문서가 정한다.

## 1. 개요

### 1.1 목적

R4 는 CSS 를 정리한다. R4a 는 화면을 한 픽셀도 바꾸지 않는다. 규칙의 자리·선택자·파일만 바꾸고, 바꾸기 전과 후의 계산된 스타일을 견주어 확인한다. R4b 는 간격 리터럴을 토큰으로 바꾸고, 단에 맞지 않는 값은 가까운 단으로 붙인다. 그래서 R4b 는 일부 자리의 간격을 1~2px 바꾼다(사용자 결정, §5).

| 이슈 | 자리 | 지금 | 바꾸는 것 |
|---|---|---|---|
| FU-18 | `style.css:2229-2238` ↔ `style-runs.css:250-269` | 백그라운드 행(`.bg-row`)의 규칙이 두 파일에 나뉘어 있다. 바탕은 `style.css`, 종료 단추는 `style-runs.css` 다 | 한 파일(`style-runs.css`)로 모은다(§2.1) |
| FU-8 | `style.css` 14곳 · `style-panel.css` 8곳 | 레일 상태를 선택자마다 다시 적는다 — 메인 패널은 `html.sb-collapsed body:not(.mobile) #sidebar`, Activity 는 `body:not(.mobile) #agents-panel:not(.open)` | 패널 루트의 `data-rail` 속성 하나로 바꾸고, 그 속성은 JS 한 자리가 세운다(§2.2) |
| FU-9 | `style.css:874-876` | Activity 레일의 숨김 목록이 `:is()` 하나에 18항목(클래스 20개)이다. 그중 `.ag-title`·`.ag-refresh` 는 웹 어디에도 없다 | 죽은 둘을 지우고, 레일 숨김 목록의 클래스가 JS·HTML 에 실제로 있는지 대조하는 시험을 세운다(§2.3) |
| FU-11 | `style.css` 2,545줄 | CSS 에는 크기 게이트가 없다(`check-file-size.mjs` 는 `web/js` 만 본다) | CSS 크기 기준선 게이트를 더하고, `style.css` 를 영역별 연속 구간으로 나눈다(§2.4) |
| FU-10 | `web/style*.css` | 간격 px 리터럴이 870개이고 간격 토큰이 없다 | **R4b** — 간격 토큰 여덟 단 → 치환 → 게이트(§2.5). 화면의 간격이 일부 1~2px 바뀐다(§5) |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 레일 | 데스크톱에서 접힌 패널. 폭은 `--sb-rail-w`(40px)이고, 펼침과 같은 DOM 에서 40px 에 들지 않는 것만 숨긴다(PANEL_SURFACE_SRS FR-RAL · UX_BATCH12_SRS FR-ACF) |
| 레일 표식 | 패널 루트(`#sidebar`·`#agents-panel`)의 `data-rail` 속성. 있으면 레일이다. 값은 없다(빈 문자열) |
| 레일 판정 | 패널이 레일을 갖는 종류이고, 닫혀 있고, `body` 에 `mobile` 클래스가 없다 |
| 레일 숨김 목록 | 레일에서 `display:none` 으로 감추는 규칙의 선택자. 레일 표식을 가진 선택자 가운데 `display:none` 을 선언한 것 |
| 연속 구간 | `style.css` 의 원래 줄 순서에서 끊지 않고 이어진 줄 묶음. 나눈 파일은 각각 연속 구간 하나다 |
| 계산된 스타일 | `getComputedStyle` 의 모든 속성(사용자 정의 속성 포함)과 `::before`·`::after` 의 같은 값 |
| 간격 속성 | `gap`·`row-gap`·`column-gap`·`padding`·`padding-*`·`margin`·`margin-*` (R4b) |
| 간격 리터럴 | 간격 속성 값에서 함수 밖에 선 `Npx` 하나. 단축형(`padding:3px 8px`)은 값마다 따로 센다 |
| 단 | 간격 토큰 `--sp-1`~`--sp-8` 의 값 하나 |
| 붙이기 | 단이 아닌 간격 리터럴을 가까운 단의 토큰으로 바꾸는 것. 값이 바뀐다 |

### 1.3 범위 밖

- 간격 밖의 길이(폭·높이·`inset`·`line-height`·테두리 두께)와 JS·`index.html` 의 인라인 간격. R4b 는 `web/*.css` 의 간격 속성(§2.5)만 다룬다.
- 간격을 글자 배율(`--fs-scale`)에 태우는 일. 지금 간격은 배율을 타지 않고, R4b 도 그대로 둔다(D-FR4-19).
- 레일의 모양·동작 자체. 무엇을 숨기고 어떤 폭인지는 그대로다.
- `style.css` 밖의 500줄 넘는 CSS(`style-git-views.css` 824 · `style-git.css` 685 · `style-editor.css` 575 · `style-kit.css` 565)를 나누는 일. 기준선에는 그대로 센다(D-FR4-14).
- 레일 판정을 쓰는 JS(`LayoutController.sbRail`)를 표식 읽기로 바꾸는 일. 판정 자리는 그대로 두고 주석만 고친다(D-FR4-7).

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-R4-1 | 화면이 그대로다. 데스크톱·모바일의 주요 화면(사이드바 펼침·레일, 작업 패널 펼침·레일과 그 세 구역, 좌우를 바꾼 배치, Git 창, 설정)에서 모든 요소의 계산된 스타일이 바꾸기 전과 같다(TC-FR4-1) |
| INV-R4-2 | 첫 프레임이 그대로다. 접힌 사이드바는 첫 페인트 때 이미 레일이고(SIDEBAR_COLLAPSE_SRS FR-SBC-5), Activity 는 첫 페인트 때 데스크톱 레일이다 |
| INV-R4-3 | 다른 코드와 e2e 가 읽는 상태 이름은 그대로 산다 — `html.sb-collapsed`, `#agents-panel.open`, `#agents-handle.open`, `body.mobile`, 저장 키 `sidebarCollapsed`·`agentsPanelOpen` |
| INV-R4-4 | 캐스케이드 순서가 그대로다. 옮긴 규칙과 그 사이에 있던 규칙 가운데 같은 요소·같은 속성을 다투는 것이 없거나, 있으면 이긴 쪽이 그대로다 |
| INV-R4-5 | 게이트(`make gates`)·단위·typecheck 가 지나고 eslint 새 경고가 0 이다. 계층·로드 순서·i18n·CSS 토큰 게이트를 지킨다 |

## 2. 요구사항

### 2.1 FU-18 — 백그라운드 행의 규칙

| ID | 요구 |
|---|---|
| FR-FR4-1 | `style.css` 의 백그라운드 행 규칙(`.bg-row`·`.bg-row:hover`·`.bg-name`·`.bg-cwd`)과 그 결정 주석(FR-ACT-1·2, FR-TYP-1)을 `style-runs.css` 의 `track: bg-kill` 절 바로 앞으로 옮긴다. `.bg-row` 를 바탕으로 쓰는 규칙은 `style-runs.css` 한 파일에만 남는다(레일 규칙은 §2.2 가 다룬다) |
| FR-FR4-2 | 옮긴 규칙이 지나쳐 가는 구간(`style.css` 의 나머지 · `style-git.css` · `style-git-views.css` · `style-runs.css` 앞부분)에 같은 요소를 고르는 규칙이 없음을 확인한다(INV-R4-4). 단위 시험이 `.bg-row`·`.bg-name`·`.bg-cwd` 의 바탕 규칙이 `style-runs.css` 에만 있음을 본다 |

### 2.2 FU-8 — 레일 표식 `data-rail`

| ID | 요구 |
|---|---|
| FR-FR4-3 | `Panel`(`ui/panel.js`)이 선택 `rail` 을 받는다. 참이면 레일을 갖는 패널이다. `railSync()` 는 레일 판정(§1.2)으로 루트의 `data-rail` 을 세우거나 지운다. 레일을 갖지 않는 패널(`DrawerSheet`)에서는 아무것도 하지 않는다. 표식을 세우는 코드는 이 메서드 하나뿐이다 |
| FR-FR4-4 | `railSync` 를 부르는 자리는 셋이다 — 열림이 바뀐 직후(`Panel.setOpen`, 표식 다음), 모바일 판정이 바뀔 수 있는 자리(`MobileController.applyMobileMode`, `body.mobile` 을 바꾼 직후, 두 패널 모두), 부팅 때 작업 패널을 저장 값으로 여는 자리(`InputBinding` 의 `#agents-panel` 복원). `SidebarPanel`·`ActivityPanel` 은 `rail:true` 로 만든다 |
| FR-FR4-5 | 첫 프레임(INV-R4-2): `index.html` 의 `#agents-panel` 은 처음부터 `data-rail` 을 갖는다(그 시점의 판정 — 닫힘·`body.mobile` 없음 — 과 같다). `#sidebar` 는 여는 태그 바로 뒤의 인라인 스크립트가 `html.sb-collapsed` 를 보고 `data-rail` 을 붙인다. 머리 스크립트가 접힘을 읽는 자리(FR-SBC-5)는 그대로다 |
| FR-FR4-6 | CSS 의 레일 상태 선택자를 표식으로 바꾼다. `html.sb-collapsed body:not(.mobile) #sidebar` → `#sidebar[data-rail]`, 그 자손·형제 규칙도 같은 꼴(`#sidebar[data-rail] .x` · `#sidebar[data-rail]+#sb-handle`). `body:not(.mobile) #agents-panel:not(.open)` → `#agents-panel[data-rail]`. `style-panel.css` 의 두 패널 `:is()` 목록 → `.ui-panel[data-rail]`, 오른쪽 레일은 자리 속성(`data-sb-side`·`data-ag-side`)과 표식의 조합. 특이도가 달라지는 자리는 §3 D-FR4-8 대로 맞춘다 |
| FR-FR4-7 | 펼친 상태를 고르는 선택자(`style-panel.css:37` 의 `html:not(.sb-collapsed)…`)와 `LayoutController.sbRail` 은 그대로 둔다. `sbRail` 의 주석은 표식과의 관계로 고친다 |
| FR-FR4-8 | 단위 시험: 두 패널 × 열림 × 모바일의 판정, 모바일 진입·이탈 때 두 패널이 함께 다시 서는 것, `DrawerSheet` 가 표식을 건드리지 않는 것, 부팅 복원 뒤의 표식 |

### 2.3 FU-9 — 레일 숨김 목록

| ID | 요구 |
|---|---|
| FR-FR4-9 | Activity 레일 숨김 목록에서 `.ag-title`·`.ag-refresh` 를 지운다. 머리 절의 주석("제목 `.ag-title` 은 없다")은 사실이므로 둔다 |
| FR-FR4-10 | 단위 시험(D-FR4-10): 레일 숨김 목록(§1.2)의 선택자에서 클래스 이름을 모두 뽑아, 각각이 `web/js`(test 제외)·`web/index.html` 에 실제로 나오는지 본다. 없는 이름이 있으면 실패한다. 목록이 비면(선택자 꼴이 바뀌어 아무것도 못 읽으면) 실패한다 — 공회전하지 않는다 |

### 2.4 FU-11 — CSS 크기 게이트와 `style.css` 나누기

| ID | 요구 |
|---|---|
| FR-FR4-11 | `scripts/check-file-size.mjs` 가 `web/*.css`(vendor 제외)도 잰다. 지표는 JS 와 같은 둘 — 500줄 초과 파일 수와 최대 줄 수. 기준선은 `FE_MODULE_BOUNDARY_SRS` §7.1a 의 `CSS 500줄초과=N · 최대=M` 줄이 갖는다. 나빠지면 실패, 좋아지면 통과하고 갱신을 안내한다. JS 기준선 줄을 읽는 식은 CSS 줄과 섞이지 않는다. `make gates` 의 「모듈 크기」 단계가 이것을 돈다 |
| FR-FR4-12 | `style.css` 를 원래 순서의 연속 구간으로 나눈다. 각 파일은 500줄 이하다. 첫 구간(토큰 `:root`·`[hidden]`·바탕)은 `style.css` 이름을 지킨다. 나머지 구간은 영역 이름의 새 파일이고, `index.html` 에서 `style.css` 바로 뒤에 원래 순서대로 실린다. 파일 하나를 이어 붙이면 나누기 전의 `style.css` 와 바이트까지 같다(구간 머리 주석 한 줄씩은 뺀다) |
| FR-FR4-13 | CSS 파일 이름을 아는 자리를 함께 맞춘다 — `index.html` 의 `<link>` 순서, 이름으로 `style.css` 를 읽는 시험·게이트(`theme-preview`·`ux-scale`·`activity-tabs`·`text-dim` 시험 · `check-contrast`·`check-visibility`), `css-structure.test.mjs` 의 순서 검사, `check-visibility.sh` 의 `style.css` 예외(나누기 전의 `style.css` 전체였으므로 조각 모두에 선다), 옮긴 규칙을 `style.css` 로 가리키던 코드 주석과 `architecture.md` 한 줄. `style.css` 머리 주석의 "여기 사는 것" 목록은 조각 목록으로 고친다. `web/embed.go` 는 `*.css` 를 싣고 서비스 워커·캐시 목록은 없다(확인만). 기준선은 나눈 뒤의 값이다 |

### 2.5 FU-10 — 간격 토큰 (R4b)

실측(HEAD `a3b864ce`, 주석 제외, 함수 밖 최상위 값): 간격 선언 757개 가운데 px 리터럴이 있는 선언 665개, 리터럴 **870개**. 값별로 8px 177 · 6px 169 · 4px 152 · 10px 90 · 2px 62 · 12px 51 · 3px 50 · 14px 25 · 5px 24 · 16px 12 · 20px 6 · 7px 5 · 24px 4 · 18px 4 · 44px 3 · 9px 2 · 22·28·40·60px 각 1 · 1px 7 · 음수 23. 함수 안의 px 는 둘이다(`.ui-badge` 의 `calc(3px * var(--fs-scale))`, 편집기 제안 줄의 `var(--fe-offer-h,32px)`).

| ID | 요구 |
|---|---|
| FR-FR4-14 | `style.css` 의 `:root` 에 간격 토큰 여덟을 세운다 — `--sp-1` 2px · `--sp-2` 4px · `--sp-3` 6px · `--sp-4` 8px · `--sp-5` 10px · `--sp-6` 12px · `--sp-7` 16px · `--sp-8` 24px(D-FR4-15·19). 배율(`--fs-scale`)을 타지 않는다 |
| FR-FR4-15 | `web/*.css` 의 간격 리터럴을 값마다 따로 판정한다. 값이 단이면 그 단의 토큰으로 바꾼다. 단이 아니면 붙이기 규칙(D-FR4-16)대로 가까운 단의 토큰으로 바꾼다. 붙이기의 허용 폭은 ±2px 이다(D-FR4-17) |
| FR-FR4-16 | 다음은 바꾸지 않는다(D-FR4-18). ① `0` 과 `1px` ② 음수 여백 ③ 함수(`calc()`·`var()` 의 대체값·`env()`) 안의 값 ④ ±2px 안에 단이 없는 값(20·28·40·44·60px) ⑤ 레일(`[data-rail]`) 규칙과 근거 주석이 있는 자리의 단이 아닌 값. ③~⑤ 는 부록 B 예외 표에 사유와 함께 적는다 |
| FR-FR4-17 | 게이트 `scripts/check-spacing.mjs` 를 더하고 `make gates` 와 `verify.yml` 에 넣는다. 간격 리터럴(함수 안 포함)이 허용(①·②, `env()` 의 `0px`)도 예외 표 항목도 아니면 실패한다. 예외 표의 항목이 CSS 에 없으면(죽은 예외) 실패한다. 읽은 간격 선언이 600개 미만이면 공회전으로 보고 실패한다. 예외 표는 스크립트 안에 사유와 함께 둔다(D-FR4-21) |
| FR-FR4-18 | 킷 게이트(`check-kit-components.mjs`)와 킷 시험(`kit-key.test.mjs`)이 대조하는 값을 확인하고, 치환이 그 대조를 바꾸면 함께 맞춘다(D-FR4-22) |
| FR-FR4-19 | 값이 바뀐 자리를 부록 A 에 파일·선택자 단위로 전/후와 건수로 남긴다. 동작 변경은 §5 에 이전/새/이유로 적는다 |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FR4-1 | R4a 의 순서는 FU-18 → FU-8 → FU-9 → FU-11 이다. 이슈마다 커밋한다 | FU-9 의 시험은 FU-8 이 만든 표식(`[data-rail]`)을 열쇠로 레일 숨김 목록을 찾는다. FU-11 은 파일을 가르므로 마지막에 두어야 앞 이슈의 줄 참조가 한 번만 바뀐다 |
| D-FR4-2 | 백그라운드 행 규칙은 `style-runs.css` 로 모은다. `style.css` 로 모으지 않는다 | `style-runs.css` 에 종료 단추(bg-kill) 절이 이미 있고, `css-structure.test.mjs`(FEU-24)가 `.bg-row` 를 그 파일에서 찾는다. 옮기는 쪽이 앞 결정과 같은 방향이다 |
| D-FR4-3 | 표식의 자리는 패널 루트(`#sidebar`·`#agents-panel`)다. `html` 에 두지 않는다 | 루트에 두면 패널 템플릿의 레일 규칙이 패널 이름 없이 `.ui-panel[data-rail]` 하나로 선다 — FU-8 이 없애려는 "패널마다 다른 목록" 이 사라진다. `html` 에 두면 값마다(`sb`·`act`) 다른 선택자가 다시 생긴다 |
| D-FR4-4 | 표식은 `Panel.railSync` 가 명시적으로 세운다. `MutationObserver` 로 클래스를 지켜보지 않는다 | 관측자는 마이크로태스크 뒤에 돌아, 같은 틱 안에서 계산된 스타일을 읽는 코드·시험이 낡은 값을 본다. 열림과 모바일을 바꾸는 자리는 셋뿐이라 명시적으로 부르는 쪽이 단순하다 |
| D-FR4-5 | 모바일 판정은 `body.mobile` 클래스다. `app.isMobile` 이 아니다 | 지금 CSS 가 보는 것이 `body:not(.mobile)` 이다. 부팅 틈에 `isMobile` 과 클래스가 잠시 다를 수 있고, 그때도 화면은 클래스를 따랐다(INV-R4-1) |
| D-FR4-6 | 첫 프레임은 정적 속성(`#agents-panel`)과 여는 태그 뒤 인라인 스크립트(`#sidebar`)로 맞춘다 | 머리 스크립트가 돌 때 `#sidebar` 는 아직 없다(FR-SBC-5 D-2). 스크립트가 서야 표식이 붙으면 접힌 사이드바가 첫 프레임에 펼침 폭으로 한 번 펄럭인다. CSP 는 인라인 스크립트마다 해시를 실으므로(`static.go` `cspFor`) 따로 고칠 것이 없다 |
| D-FR4-7 | `html.sb-collapsed` 는 남긴다. `data-rail` 은 그것과 `body.mobile` 에서 파생한 표식이다 | 접힘은 저장·첫 프레임·e2e·`SidebarPanel.isOpen` 의 기준이다(INV-R4-3). 표식은 "레일로 그린다" 만 말한다. `sbRail` 도 지금 판정(`sidebarCollapsed && !isMobile`)을 지킨다 — 읽는 쪽을 바꾸면 D-FR4-5 의 부팅 틈에서 답이 달라질 수 있다 |
| D-FR4-8 | 새 선택자의 특이도는 옛 것과 다르다. 같은 요소·같은 속성을 다투는 규칙을 대조해, 이긴 쪽이 바뀌는 자리만 특이도를 올린다. 결과는 계산된 스타일 비교(TC-FR4-1)로 확인한다 | 옛 선택자는 상태 조건 때문에 특이도가 높았다(`(1,2,2)`). 그 값을 흉내 내려고 의미 없는 조건을 덧붙이면 FU-8 의 뜻이 사라진다. 다투는 규칙이 없는 자리는 낮아져도 화면이 같다 |
| D-FR4-9 | FU-9 의 장치는 게이트다. 숨길 요소에 표식 클래스를 다는 방법은 쓰지 않는다 | 표식 클래스는 Activity 를 그리는 곳(카드·백그라운드·Runs·채팅·Usage 바닥) 여러 파일의 DOM 을 바꾸고, e2e 가 읽는 클래스 목록을 바꾼다. 게이트는 화면과 DOM 을 건드리지 않고 죽은 선택자의 재발을 막는다. "새 클래스를 빠뜨려 글자가 샌다" 는 쪽은 `activity-rail` e2e(TC-ACF-1)가 지킨다 |
| D-FR4-10 | 게이트는 단위 시험(`css-structure.test.mjs`)에 둔다 | 같은 파일이 이미 CSS 규칙을 읽어 자리를 검사한다(FEU-24·29). 규칙 파서를 한 벌 더 만들지 않는다 |
| D-FR4-11 | CSS 크기는 `check-file-size.mjs` 가 함께 재고, 기준선 줄은 `FE_MODULE_BOUNDARY_SRS` §7.1a 에 JS 줄과 나란히 둔다 | 지표·규약(나빠지면 실패, 좋아지면 갱신 안내)이 JS 와 같다. 게이트와 기준선 문서를 하나씩 더 만들면 같은 규약이 두 벌이 된다 |
| D-FR4-12 | 나눈 파일은 원래 순서의 연속 구간이고, `index.html` 에서 `style.css` 바로 뒤에 순서대로 선다 | 연속 구간을 순서대로 이어 실으면 캐스케이드 순서가 나누기 전과 같다(INV-R4-4). 규칙을 영역별로 다시 모으면 순서가 바뀌어 다툼마다 확인해야 한다 |
| D-FR4-13 | 첫 구간(토큰·`[hidden]`·바탕)이 `style.css` 이름을 지킨다 | `check-contrast.mjs`(`:root` 값)·`check-visibility.sh`(`[hidden]` 의 한 자리)·`text-dim` 시험이 그 셋을 `style.css` 에서 찾는다. 이름을 지키면 그 자리는 고치지 않아도 된다 |
| D-FR4-14 | `style.css` 밖의 500줄 넘는 CSS 넷은 나누지 않고 기준선에 센다 | PROD3 FU-11 의 대상은 `style.css` 하나다. 기준선이 그 넷을 세므로 더 커지면 게이트가 잡는다 |
| D-FR4-15 | 간격 토큰은 여덟 단이다 — 2·4·6·8·10·12·16·24px (사용자 결정 2026-11-22 의 "어느 정도 공통화" 를 실측으로 정했다) | 실측 쓰임이 8px 177 · 6px 169 · 4px 152 · 10px 90 · 2px 62 · 12px 51 · 16px 12 · 24px 4 다. 이 여덟이 리터럴 870개 가운데 717개(82%)를 그대로 받는다. 10 은 넷째로 많은 값이라 단으로 둔다 — 빼면 90곳이 ±2px 바뀐다. 20 은 6곳뿐이고 둘 단(16·24) 모두에서 4px 떨어져 단으로 두지 않는다(예외, 부록 B). 24 는 4곳이지만 22px 1곳을 받고 상자 여백(`.confirm-box`)의 위쪽 끝이다 |
| D-FR4-16 | 붙이기 — ±2px 안의 가장 가까운 단으로 붙인다. 두 단과 같은 거리이면 쓰임이 많은 단으로 붙인다: 3→4 · 5→6 · 7→8 · 9→8 · 14→12. 한쪽만 단이면 그쪽이다: 18→16 · 22→24 | 공통화가 목적이므로 많이 쓰는 값으로 모은다. 작은 값(3·5·7)은 위로 붙어 상자가 줄지 않는다 — 터치·히트 하한을 단정하는 e2e(`git-ui-metrics`)를 깨지 않는 쪽이다. 같은 거리에서 늘 아래로(또는 늘 위로) 붙이는 규칙보다 바뀌는 자리의 체감이 적다 |
| D-FR4-17 | 허용 폭은 값 하나에 ±2px 이다. 넘는 값은 바꾸지 않고 예외 표에 둔다 (사용자 결정 2026-11-22) | 1~2px 는 리듬을 맞추는 정도의 변화다. 4px 이상은 배치가 눈에 띄게 달라져 이 정리의 범위를 넘는다 |
| D-FR4-18 | 바꾸지 않는 것: `0`·`1px`·음수 여백·함수 안의 값·±2px 밖의 값·레일(`[data-rail]`) 규칙의 홀수 값·근거 주석이 있는 값. 터치 하한(44px 등)은 간격 속성이 아니므로 대상이 아니다. e2e 가 간격 값을 단정하는 자리는 실측으로 찾았다 — TC-UIP-1 의 `.tp` 4px 8px 는 이미 단이라 바뀌지 않고, 그 밖에는 수치 단정이 없다 | `1px` 은 선의 두께와 짝인 값이고, 음수 여백은 이웃의 여백·테두리를 되먹는 값이라 단의 뜻이 없다. 함수 안의 값은 다른 크기와 함께 계산된다(`.ui-badge` 는 배율을 탄다). 레일은 폭 40px 안에 점·글자·배지를 넣는 값이라 1px 이 넘침을 가른다(`.sbl-item` 의 주석이 그 계산이다). `#add-sandbox-window` 의 5px 는 `#add-window` 의 `padding-right:60px` 와 주석의 실측(상자 48px + `right:5px`)으로 묶여 있다 |
| D-FR4-19 | 토큰 이름은 순번(`--sp-1`~`--sp-8`)이다. 값을 이름에 넣지 않는다. 글자 배율을 타지 않는다 | 이름에 값을 넣으면 단을 고칠 때 이름이 거짓말을 한다. 순번은 크기 순서만 말한다. 지금 간격은 배율과 무관하므로 배율을 걸면 글자 크기 설정의 동작이 바뀐다 — R4b 의 범위 밖이다 |
| D-FR4-20 | 치환은 두 단계로 확인한다. ① 값 그대로의 임시 토큰(`--sp-xN:Npx`)으로 바꾸고, 임시 토큰을 되돌리면 원문과 바이트까지 같음을 본다(기계 치환의 정확성). ② 임시 토큰을 붙이기 사상표대로 최종 토큰으로 바꾼다. 커밋마다 계산된 스타일을 HEAD 와 견주어, 차이가 나는 간격 속성이 모두 사상표의 쌍(±2px)인지 본다 | 단축형·함수·주석이 섞인 값을 정규식으로 바꾸면 틀리기 쉽다(R4a 착수 메모 위험 ②). 왕복 검사는 화면이 닿지 않는 자리(편집기·문서 렌더·Runs 뷰)까지 정확성을 보장한다. 화면 비교는 바뀐 값이 의도한 붙이기에서만 나오는지를 본다 |
| D-FR4-21 | 게이트의 예외 표는 `check-spacing.mjs` 안에 파일·선택자·속성·값을 열쇠로, 사유와 함께 둔다. 줄 번호를 열쇠로 쓰지 않는다 | `check-hardcoded-color.mjs` 의 꼴이다 — 조용한 예외는 구멍이다. 줄 번호는 다른 규칙을 고칠 때마다 밀린다. 죽은 예외를 실패로 잡아 표가 낡지 않게 한다 |
| D-FR4-22 | 킷 게이트와 킷 시험은 값을 대조하지 않는다 — 킷 클래스를 쓰는 선택자가 킷 밖에서 어떤 **속성**을 적는지만 본다. 치환은 속성을 더하거나 지우지 않으므로 맞출 것이 없다. 킷 파일(`style-kit.css`)의 간격도 같은 규칙으로 치환한다 | 실측: `check-kit-components.mjs` 의 규칙 여덟과 `kit-key.test.mjs` 의 TC-CMP-1d·10·12·14a 가 속성 이름만 읽는다. `gap:0` 단정(TC-CMP-14a)은 0 이라 대상이 아니다 |
| D-FR4-23 | 간격 토큰은 이 문서가 소유한다. `DESIGN_TOKENS_SRS` 는 색·글자 크기·z-index·모션을 소유하고 간격을 다루지 않는다 — 그 문서 §1.2 에 이 문서를 가리키는 줄을 더한다 | 토큰 목록이 두 문서로 흩어지지 않게, 찾는 사람이 디자인 토큰 문서에서 간격의 자리를 알게 한다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FR4-1 | 임시 e2e(`e2e/zz-tmp-*.spec.ts`, 같은 명령 안에서 지운다): 바꾸기 전(HEAD)과 후에 같은 화면 34개 — 데스크톱(1400×900) 사이드바 펼침·레일 × 탭 셋(창·Repo·채팅), 작업 패널 펼침·레일 × 구역 셋(Agents·Background·Runs), 좌우를 바꾼 배치 넷, Git 창(사이드바 펼침·레일), 설정 넷 / 모바일 기본·서랍·작업 시트 셋·설정 — 에서 모든 요소(터미널 내부 제외)의 계산된 스타일 해시를 견준다. HEAD 끼리 두 번 돌려 흔들림이 0 임을 먼저 확인한다. 차이가 0 이어야 한다 |
| TC-FR4-2 | 단위(`css-structure.test.mjs`): `.bg-row`·`.bg-name`·`.bg-cwd` 의 바탕 규칙은 `style-runs.css` 에만 있다(FR-FR4-2) |
| TC-FR4-3 | 단위(`panel-tabbar.test.mjs`): 레일 판정 — 메인 패널·작업 패널 × 열림·닫힘 × 데스크톱·모바일. 모바일 진입·이탈에 두 패널이 함께 다시 선다. `DrawerSheet` 의 열고 닫기는 `#sidebar` 의 `data-rail` 을 건드리지 않는다(FR-FR4-8) |
| TC-FR4-4 | 단위: CSS 에 옛 레일 상태 선택자(`html.sb-collapsed body:not(.mobile)` · `#agents-panel:not(.open)`)가 남지 않는다. `index.html` 의 첫 프레임 표식 둘(FR-FR4-5) |
| TC-FR4-5 | 단위(`css-structure.test.mjs`): 레일 숨김 목록의 클래스가 모두 JS·HTML 에 있다. 목록이 비면 실패한다(FR-FR4-10). 옛 코드(`.ag-title`·`.ag-refresh` 가 있는 목록)에서 실패하는 것을 확인한다 |
| TC-FR4-6 | 게이트(`check-file-size.mjs`): CSS 기준선을 읽고, 나빠지면 실패한다. 기준선 줄이 없으면 실패한다 — 공회전하지 않는다 |
| TC-FR4-7 | 단위(`css-structure.test.mjs`): `index.html` 의 스타일시트 순서가 `style-kit` → `style` → 나눈 파일들(원래 순서) → `style-git` … 이다. `style.css` 와 나눈 파일은 각각 500줄 이하다 |
| TC-FR4-8 | 관련 e2e — `grep -rl` 로 고른 레일·사이드바·Activity·레이아웃·모바일·Runs 계열 spec. 실패는 `git stash` 로 HEAD 와 견준다 |
| TC-FR4-9 | 치환 왕복(D-FR4-20 ①): 파일 묶음마다 임시 토큰 단계에서 `var(--sp-xN)` → `Npx` 로 되돌린 파일이 원래 파일과 바이트까지 같다 |
| TC-FR4-10 | 계산된 스타일(TC-FR4-1 의 방식, 화면 34개에 Git 뷰 일곱을 더한 41개): 커밋마다 HEAD 와 견준다. `--sp-*` 상속 변수는 비교에서 뺀다. 차이가 나는 요소마다 간격 속성의 전/후가 붙이기 사상표의 쌍(±2px)이고, 간격 밖의 차이는 상자 기하(폭·높이·위치·원점)뿐이다. 계산된 스타일은 다른데 간격·기하가 같은 요소(의도 밖 차이)는 HEAD 끼리의 흔들림을 빼고 0 이다 |
| TC-FR4-11 | 게이트(`check-spacing.mjs`): 지금 CSS 에서 통과한다. 탐침 — 간격 속성에 `7px` 를 넣으면 실패, 예외 표의 항목을 지우면 그 자리에서 실패, CSS 에 없는 예외를 더하면 실패 |
| TC-FR4-12 | 관련 e2e — 간격이 바뀐 화면(사이드바·Activity·Runs·모달·설정·메뉴·Git·편집기·문서 렌더·모바일)의 spec 과 기준선 대조 spec(`ui-layout-defaults`). 실패는 `git stash` 로 HEAD 와 견준다. 기준선이 바뀌면 다시 뜨고 뜬 spec 을 §6 에 적는다 |

## 5. 동작 변경 기록

R4a: 없다. 자리·선택자·파일 이름만 바꾼다(INV-R4-1·2).

R4b(FU-10): INV-R4-1(화면 불변)은 R4b 에 서지 않는다. 사용자 결정(2026-11-22)이 간격의 1~2px 변화를 허용한다.

- 이전 동작: 간격이 자리마다 px 리터럴이었다. 값은 1~60px 사이 스무 가지였다.
- 새 동작: 간격은 토큰 여덟 단(2·4·6·8·10·12·16·24px)에서 온다. 단이 아니던 값 105곳(3·5·7·9·14·18·22px)이 가까운 단으로 1~2px 바뀐다 — 3→4 45 · 5→6 23 · 14→12 25 · 7→8 5 · 18→16 4 · 9→8 2 · 22→24 1. 자리는 부록 A 다. 예외 20곳(부록 B)은 그대로다.
- 이유: 값이 뜻을 말하지 않으면 다음 사람은 옆줄을 베껴 쓴다(글자 크기·모서리·z-index 와 같은 근거). 서로 다른 값마다 토큰을 만들면 토큰이 너무 많아지므로 가까운 단으로 묶는다(사용자 결정).

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|
| `0cd6527c` | 이 SRS |
| `fb874af4` | FU-18 — `.bg-row`·`.bg-row:hover`·`.bg-name`·`.bg-cwd` 와 결정 주석을 `style.css` 에서 `style-runs.css` 의 bg-kill 절 앞으로. 사이 구간에 같은 요소를 고르는 규칙이 없다(`*` 는 움직임 줄이기의 `animation`·`transition` 뿐). 시험 `css-structure.test.mjs` TC-FR4-2(옛 코드에서 RED) |
| `abb8a5df` | FU-8 — `Panel` 의 `rail` 선택·`railSync()`, `SidebarPanel`·`ActivityPanel` 은 `rail:true`. 부르는 곳은 `Panel.setOpen` · `MobileController.applyMobileMode` · `InputBinding` 의 부팅 복원. 첫 프레임: `#agents-panel` 의 정적 `data-rail`, `#sidebar` 여는 태그 뒤의 인라인 스크립트. CSS 선택자 22곳(`style.css` 14 · `style-panel.css` 8)을 표식으로. `LayoutController.sbRail` 주석. 시험 `panel-tabbar.test.mjs` TC-FR4-3 셋 · `css-structure.test.mjs` TC-FR4-4(옛 코드에서 RED). 대역 둘(`activity-runs-refresh`·`activity-tabs`)을 표식에 맞췄다 |
| `3f3df12a` | FU-9 — 숨김 목록에서 `.ag-title`·`.ag-refresh` 를 걷었다. 시험 `css-structure.test.mjs` TC-FR4-5 — `[data-rail]` 규칙 가운데 `display:none` 인 것의 표식 뒤 클래스 25개를 `web/js`(test 제외)·`index.html` 과 대조한다. 옛 목록에서 RED |
| `8e87010d` | FU-11 — `check-file-size.mjs` 가 `web/*.css` 도 잰다(기준선 `FE_MODULE_BOUNDARY_SRS` §7.1a `CSS 500줄초과=4 · 최대=824`). `style.css`(2,539줄) → `style.css` 268 · `style-main-panel` 289 · `style-workspace` 298 · `style-activity` 364 · `style-modal` 385 · `style-status` 272 · `style-mobile` 330 · `style-system` 343. 조각의 첫 줄(머리 주석)을 빼고 이어 붙이면 나누기 전과 바이트까지 같다(`style.css` 머리 주석의 목록만 고쳤다). `index.html` 의 `<link>` 일곱, `check-visibility.sh` 의 예외, 시험 셋(`activity-tabs`·`theme-preview` 이 읽는 파일, TC-FR4-7), 코드 주석 다섯·`architecture.md` 한 줄 |

**화면 불변 확인(TC-FR4-1).** 임시 e2e `e2e/zz-tmp-r4a-styles.spec.ts`(명령마다 복사해 돌리고 같은 명령에서 지웠다)가 화면 34개에서 모든 요소(`body` 아래, `.xterm` 안쪽·`<script>` 제외, 요소당 `::before`·`::after` 포함)의 계산된 스타일 전체(사용자 정의 속성 포함, 속성 이름순)를 해시로 남긴다. 움직임 줄이기(`reducedMotion: reduce`)로 애니메이션을 멈췄다. HEAD(`2cc9e4b3`)에서 두 번 돌려 기준을 만들었고 둘의 차이는 4요소(모바일 Runs 시트·모바일 설정 화면의 Runs 행 `.runs-ago` 와 옆 단추 — 몇 분 전 글자 폭)였다. 결과: FU-18 0 · FU-8 0 · FU-9 4(같은 `.runs-ago` 와 옆 단추, 펼친 Runs 목록 — 레일 숨김 목록과 무관한 글자 폭 흔들림) · FU-11 0.

FU-8 은 특이도 대조도 했다. 옛·새 선택자의 특이도와 같은 요소·같은 속성을 다투는 모든 규칙(요소의 클래스 조합은 34개 화면에서 모은 실제 DOM 으로 판정)을 견주어 이긴 쪽이 바뀌는 자리를 찾았다. 바뀌는 셋을 고쳤다 — 두 루트(`body:not(.mobile) #sidebar`·`#agents-panel` 의 폭 `(1,1,1)` 을 덮어야 하므로 `#sidebar.ui-panel[data-rail]`·`#agents-panel.ui-panel[data-rail]`)와 사이드바 탭 배지(`style-sidebar.css` 의 창 탭 배지 `position` 이 이겨 왔으므로 `.ui-panel[data-rail] .sb-tab-badge`). 남은 둘은 조상 문맥이 다른 거짓 양성이다(`#sb-bottom>button`·`#sb-panel-windows .sb-actions>button` 대 `.ui-panel-tab`).

**SRS 와 다르게 한 것.**

1. FR-FR4-9 의 "낡은 주석 정리" — 머리 절 주석("제목 `.ag-title` 은 없다")은 사실이라 두었다. 요구를 그에 맞게 고쳤다.
2. FR-FR4-13 — 이름을 아는 자리가 둘 더 있었다. `check-visibility.sh` 는 `style.css` 전체를 `[hidden]` 되살림의 예외로 두고 있었으므로 조각 모두로 넓혔다(예외 범위는 그대로). 옮긴 규칙을 `style.css` 로 가리키던 코드 주석 다섯과 `architecture.md` 한 줄을 고쳤다.

**시험 결과.** 단위 1469 통과. `make gates`·`typecheck` 통과. eslint 는 main 트리에서 원래 2건(`theme-vars.js:86` · `claude-accounts-foot.test.mjs:728`)뿐이다 — 도중에 다른 세션의 잠긴 작업 트리 `.claude/worktrees/agent-a660b0eacc2abadec` 가 생겨 같은 두 건이 한 번 더 세어진다. e2e 는 이슈마다 `grep -rl` 로 고른 spec 을 돌렸다 — FU-18 6 spec 56 통과 · FU-8 37 spec 426 통과, 실패 3(`kit-components` TC-CMP-19 · `sidebar-actions` TC-SBA-1 · `ui-kit-icons` V-GAP-1, 셋 다 원래 실패), 흔들림 1(`activity-rail` TC-ACF-1) · FU-9 4 spec 50 통과 · FU-11 46 spec 511 통과, 실패 3(위의 원래 실패 셋), 흔들림 2(`activity-rail` TC-ACF-1 · `claude-accounts` TC-CAC-27 — 뒤의 것은 단독 2회 반복에서 2/2 통과). 원래 실패·흔들림은 `REFACTOR_PROD3_HANDOFF_4.md` §4 목록에 있다.

**남긴 것.** `style.css` 밖의 500줄 넘는 CSS 넷(D-FR4-14). 연속 구간이라 조각의 이름은 영역의 대강이다 — `style-workspace.css` 끝에 사이드바 행의 알람 규칙(`.sbl-item.attn …`) 몇 줄이 남았다(옮기면 순서가 바뀐다).

**R4b 착수 메모 (FU-10 간격 토큰).** 실측(R4a 뒤, `web/*.css` 주석 제외, 정규식 근사): `gap`·`row-gap`·`column-gap`·`padding*`·`margin*` 의 px 리터럴 **878개**(선언 664개). 속성별 padding 497 · gap 227 · margin 148 · row-gap 6. 값별 8px 177 · 6px 169 · 4px 152 · 10px 90 · 2px 62 · 12px 51 · 3px 51 · 14px 25 · 5px 24 · 16px 12, 음수(-8·-4·-10) 17. `gap` 만 보면 6px 69 · 8px 66 · 4px 45 · 2px 18 · 10px 10 · 3px 9. 파일별 코어 조각 합 433 · `style-git-views` 147 · `style-git` 101 · `style-editor` 80 · `style-runs` 47 · `style-kit` 43.
- 토큰 단 후보: 2·4·6·8 이 네 단(합 560, 64%)이고 10·12 를 더하면 여섯 단(77%). 3·5·7·14 는 근거가 주석에 있는 것이 많다(예: 레일 `.sbl-item` 의 `padding:0 3px` — "점과 글자가 40px 안에"). 리터럴로 두고 예외 표에 적는 편이 낫다.
- 위험: ① 킷 게이트(`check-kit-components.mjs`)가 킷 값을 밖에서 덮는지 본다 — 토큰 치환이 킷 규칙의 문자열을 바꾸면 그 대조를 함께 맞춰야 한다. ② `calc()` 안의 px(코어 36·킷 33·기타)와 단축형 섞임(`padding:0 3px` 같은 2값 이상 164선언)은 기계 치환이 틀리기 쉽다. ③ 터치 하한·`--row` 와 얽힌 값(44px 등)은 간격이 아니다. ④ 화면 불변 확인은 이 SRS 의 방식을 쓰되, `:root` 에 새 `--sp-*` 가 생기면 모든 요소의 계산된 스타일(상속된 사용자 정의 속성)이 달라지므로 비교에서 `--sp-*` 를 빼야 한다. ⑤ 게이트는 `check-radius.mjs`·`check-font-size.mjs` 꼴(리터럴이 남았는지 + 예외 표)을 따른다.


### 6.1 R4b (FU-10 간격 토큰)

| 커밋 | 요점 |
|---|---|
| `8f809850` | 이 SRS 의 R4b 분(§2.5 FR-FR4-14~19 · D-FR4-15~23 · TC-FR4-9~12 · §5 · 부록 A·B) |
| `92c59b26` | `style.css` `:root` 의 `--sp-1`~`--sp-8` 과 코어 조각 아홉(`style-main-panel`·`-workspace`·`-activity`·`-modal`·`-status`·`-mobile`·`-system`·`-panel`·`-sidebar`) — 치환 398 · 예외 13 |
| `6d46d4e1` | `style-git`·`style-git-views` — 치환 243 · 예외 3 |
| `d05e001a` | `style-editor`·`style-kit`·`style-runs`·`style-docrender` — 치환 181 · 예외 2(+ 함수 안 둘은 처음부터 리터럴로 둔다) |
| `0efcb302` | 게이트 `scripts/check-spacing.mjs`, `make gates`·`verify.yml` 의 「간격」 단계 |

**수.** 간격 리터럴 870개 = 치환 822(값 그대로 717 · 붙이기 105) + 예외 18 + `1px` 7 + 음수 23. 함수 안의 px 둘(`.ui-badge` 의 `calc()` · `var(--fe-offer-h,32px)`)도 예외 표에 있어 게이트의 예외는 20줄이다. 붙이기는 3→4 45 · 5→6 23 · 14→12 25 · 7→8 5 · 18→16 4 · 9→8 2 · 22→24 1(부록 A). 파일 줄 수는 그대로다(`style.css` 만 토큰 정의로 268 → 282줄, CSS 크기 기준선 안).

**치환의 정확성(TC-FR4-9).** 묶음마다 HEAD 의 파일을 값 그대로의 임시 토큰(`var(--sp-xN)`)으로 바꾼 뒤 되돌려 원문과 바이트까지 같음을 확인했고(셋 다 통과), 임시 토큰을 사상표대로 이름만 바꾼 결과가 커밋한 파일과 같음을 확인했다.

**화면 비교(TC-FR4-10).** 임시 e2e `e2e/zz-tmp-r4b-styles.spec.ts`(명령마다 복사해 돌리고 같은 명령에서 지웠다)가 R4a 의 34화면에 Git 뷰 일곱을 더한 41화면에서, 요소마다 계산된 스타일 해시(`--sp-*` 제외)와 기하 속성(간격·폭·높이·위치·원점 등 51개)을 남긴다. HEAD(`8f809850`)에서 두 번 떠 흔들림을 뺐다(Runs·백그라운드 행 단추의 `margin-left:auto` 글자 폭 흔들림 6요소). 결과(HEAD 대비, 세 커밋 누적): 차이 요소 11,590 — 간격 속성이 사상표의 쌍으로 바뀐 요소 11,445(3→4 · 5→6 · 7→8 · 14→12 · 18→16 만 나왔다) · 자기 간격은 그대로이고 기하만 바뀐 요소 141(이웃 간격의 귀결). 사상표 밖의 간격 차이는 `margin-left:auto` 의 사용값뿐이다(백그라운드·Runs 행의 닫기 단추 — 킷 단추가 2px 넓어진 귀결 — 와 테마 미리보기의 `.pv-st-err`). 기하가 같은데 해시만 다른 요소 4개는 설정 모달 상자(`#modal`)다 — `grid-template-rows:auto auto minmax(0,1fr)` 의 계산값이 머리(`.modal-header` 14→12px)의 높이를 따라 바뀐다. 그 밖의 의도 밖 차이는 0 이다. 커밋 사이의 차이(앞 커밋 대비)도 그 커밋의 사상표 쌍뿐이었다.

**게이트(TC-FR4-11).** 지금 CSS 에서 `spacing ok (간격 선언 757개 · 예외 20)`. 탐침 셋 — `gap:7px` 를 더하면 그 줄에서 실패, 예외 표에서 `.fe-error` 를 지우면 `style-system.css:24` 에서 실패, CSS 에 없는 예외를 더하면 「죽은 예외」 로 실패. 킷 게이트·킷 시험은 속성 이름만 대조해 맞출 것이 없었다(D-FR4-22).

**시험 결과.** 커밋마다 `make gates`(그 커밋 시점의 게이트)·단위 1469 통과·typecheck 통과. e2e 는 묶음 끝에 전량 한 번(`make e2e`, 8샤드): 2286 통과 · 실패 2 · 흔들림 7. 실패 둘은 원래 실패다 — `git-ui-metrics` V80(`.sb-collapse` 높이 26px — `--ui-btn-h` 이고 간격과 무관) · `sidebar-actions` TC-SBA-1(`새 창`·`그룹` 단추가 한 줄이 된 뒤의 위치 비교 — 간격과 무관). 흔들림은 `activity-rail` TC-ACF-1 · `slot-view-state` TC-SVS-3·13·50·56 · `tab-names` V-NAM-1·2·5(단독 2회 반복 2/2 통과). 시각 기준선 스크린샷을 쓰는 spec 은 없다. 계산값 기준선 spec `ui-layout-defaults`(V-LAY-1)는 통과해 기준선을 다시 뜨지 않았다(`e2e/baseline/` 그대로).

**SRS 와 다르게 한 것.** 없다. 착수 메모의 실측(878개)은 정규식 근사였고, 블록을 읽어 다시 잰 값이 870개다(§2.5).

**남긴 것.** JS·`index.html` 의 인라인 간격과 간격 밖의 길이(§1.3). 예외 20줄(부록 B) — 20px 여섯 곳은 단을 더하면 토큰이 되지만 사용자 결정의 6~8단 안에 두려고 남겼다.

## 부록 A. R4b 에서 값이 바뀌는 자리

붙이기(D-FR4-16)로 값이 바뀌는 간격 리터럴 105개다. 실측 기준은 HEAD `a3b864ce` 이다. 줄 번호 대신 선택자를 적는다. 표에 없는 리터럴 717개는 값이 그대로이고 토큰 이름만 바뀐다.

| 파일 | 선택자 { 속성: 전 → 후 } | 건수 |
|---|---|---|
| `style-activity.css` | `.chat-sub-h` { padding: 6px 10px 3px → 6px 10px 4px }<br>`.chat-row` { padding: 5px 10px → 6px 10px }<br>`.ag-group` { padding: 5px 8px 5px 16px → 6px 8px 6px 16px }<br>`.ag-usage` { margin-top: 3px → 4px }<br>`.ag-sub .ag-usage` { padding-left: 14px → 12px }<br>`.act-usage-reset` { margin-top: 3px → 4px }<br>`.cacct` { padding: 5px 12px 5px 44px → 6px 12px 6px 44px }<br>`.cacct.wide` { padding-bottom: 7px → 8px }<br>`.cacct-who` { gap: 2px 5px → 2px 6px }<br>`.cacct-cell` { padding-bottom: 3px → 4px }<br>`.cacct-pop-title,.cacct-pop-st` { padding-left: 14px → 12px }<br>`.cacct-swatches` { gap: 5px → 6px }<br>`.cacct-set-folder` { padding: 3px 6px → 4px 6px }<br>`.cacct-chip` { padding: 0 5px → 0 6px }<br>`.act-usage-sl-h` { padding-top: 3px → 4px }<br>`.act-usage-sl` { padding-bottom: 3px → 4px }<br>`.cacct-cells,.act-usage-sum .cacct-cells` { row-gap: 3px → 4px } | 19 |
| `style-docrender.css` | `.dr-body th,.dr-body td` { padding: 5px 10px → 6px 10px }<br>`.dr-html-note` { padding: 3px 8px → 4px 8px }<br>`.dr-table th,.dr-table td` { padding: 3px 8px → 4px 8px } | 3 |
| `style-editor.css` | `.ed-find-row` { padding: 5px 12px → 6px 12px }<br>`.fe-goto-q` { padding: 3px 6px → 4px 6px }<br>`.fe-find-r` { padding: 3px 6px → 4px 6px }<br>`.fe-find-q` { padding: 3px 6px → 4px 6px }<br>`.fe-note` { padding: 5px 10px → 6px 10px }<br>`.fe-dd-add,.fe-dd-mod,.fe-dd-del` { margin-left: 3px → 4px }<br>`.fe-dd-del` { margin-left: 3px → 4px } | 7 |
| `style-git-views.css` | `.git-hist-search` { padding: 3px 8px → 4px 8px }<br>`.git-hist-opts` { gap: 3px → 4px }<br>`.git-hist-rev` { padding: 3px 10px → 4px 10px }<br>`.git-hist-rev-mark` { padding: 0 5px → 0 6px }<br>`.git-refs-all,.git-ref` { padding: 3px 8px → 4px 8px }<br>`.git-hist-badge` { padding: 0 5px → 0 6px }<br>`.git-hist-d-who` { margin-top: 3px → 4px }<br>`.git-hist-foot` { padding: 3px 10px → 4px 10px }<br>`.git-br-group-head,.git-br-pfx-head` { padding: 3px 8px → 4px 8px }<br>`.git-stash-row` { padding: 3px 10px → 4px 10px }<br>`.git-sub-state` { padding: 0 5px → 0 6px }<br>`select` { padding: 0 22px 0 8px → 0 24px 0 8px }<br>`.git-rm-note` { padding: 3px 10px → 4px 10px } | 13 |
| `style-git.css` | `.git-job-auth` { gap: 3px → 4px }<br>`.git-job-auth-cmd` { padding: 3px 6px → 4px 6px }<br>`.git-job-opts` { gap: 3px → 4px }<br>`.git-dialog-field` { gap: 3px → 4px }<br>`.git-dialog-input` { padding: 5px 8px → 6px 8px }<br>`.git-group-acts` { padding-left: 14px → 12px }<br>`.git-file .git-file-acts,.git-dir .git-file-acts` { padding-left: 14px → 12px }<br>`.git-partial-list` { padding: 0 0 0 14px → 0 0 0 12px }<br>`.git-file-more` { padding: 3px 8px → 4px 8px } | 9 |
| `style-kit.css` | `.ui-btn` { gap: 5px → 6px }<br>`.ui-btn-sm` { padding: 0 7px → 0 8px }<br>`.ui-modal-body` { padding: 14px → 12px }<br>`.ui-menu` { padding: 3px → 4px }<br>`.ui-menu-item` { gap: 7px → 8px; padding: 5px 10px → 6px 10px }<br>`body.mobile .ui-menu-item` { padding: 0 14px → 0 12px }<br>`.ui-menu-sep` { margin: 3px 6px → 4px 6px }<br>`.ui-menu-label` { padding: 5px 10px 3px → 6px 10px 4px }<br>`.ui-input,.ui-select` { padding: 3px 8px → 4px 8px } | 11 |
| `style-main-panel.css` | `.rename-input` { padding: 0 3px → 0 4px }<br>`.sbx-workdir` { margin: 0 0 14px → 0 0 12px }<br>`.sbx-recent` { margin: -8px 0 14px → -8px 0 12px }<br>`.sbx-grade` { padding: 0 5px → 0 6px }<br>`.sbx-work` { padding: 0 5px → 0 6px }<br>`.sbx-progress` { padding: 8px 14px → 8px 12px } | 6 |
| `style-mobile.css` | `body.mobile .pn-tab` { padding: 0 14px → 0 12px }<br>`body.mobile .modal-header` { padding: 4px 6px 4px 14px → 4px 6px 4px 12px }<br>`body.mobile .modal-body` { padding: 14px → 12px }<br>`body.mobile #modal[data-mview="list"] .mtab-grp:not([hidden])` { padding: 18px 16px 6px → 16px 16px 6px }<br>`body.mobile .toast` { padding: 10px 14px → 10px 12px }<br>`body.mobile #m-act-btn.working` { gap: 5px → 6px }<br>`.m-seg-btn` { padding: 0 9px → 0 8px } | 7 |
| `style-modal.css` | `.modal-header` { padding: 14px 18px → 12px 16px }<br>`.modal-body` { padding: 18px → 16px }<br>`.tl-item` { padding: 7px 10px → 8px 10px }<br>`.pv-sb-row` { gap: 3px → 4px }<br>`.pv-btn` { padding: 0 3px → 0 4px }<br>`.ce-item` { padding: 3px 6px → 4px 6px }<br>`.sc-row` { padding: 5px 0 → 6px 0 }<br>`.search-bar input` { padding: 3px 8px → 4px 8px }<br>`body.mobile .tp-ov-acts .ui-btn` { padding: 0 14px → 0 12px } | 10 |
| `style-panel.css` | `.ui-panel-tab` { padding: 0 3px → 0 4px } | 1 |
| `style-runs.css` | `.run-view .run-summary` { gap: 6px 14px → 6px 12px; padding: 10px 14px → 10px 12px }<br>`.run-view .run-tree` { padding: 8px 14px → 8px 12px }<br>`.run-view.tree-run .run-tree` { padding: 12px 14px → 12px 12px; gap: 3px → 4px }<br>`.run-view .run-cards` { padding: 10px 14px → 10px 12px }<br>`.run-view .run-card` { padding: 5px 9px → 6px 8px }<br>`.run-view .run-timeline` { padding: 8px 14px 16px → 8px 12px 16px } | 9 |
| `style-status.css` | `.sb-item` { gap: 3px → 4px }<br>`.sbs-row` { gap: 14px → 12px }<br>`.preset-item` { padding: 7px 10px → 8px 10px }<br>`.ds-row` { gap: 14px → 12px }<br>`.ds-num,.ds-text` { padding: 3px 8px → 4px 8px }<br>`.ds-sec` { margin-top: 18px → 16px }<br>`.ds-sep` { margin: 14px 0 4px → 12px 0 4px } | 7 |
| `style-system.css` | `.sbx-mount input[type=text]` { padding: 3px 6px → 4px 6px }<br>`.sbx-flag` { gap: 3px → 4px }<br>`.acl-row input[type=text]` { padding: 3px 6px → 4px 6px } | 3 |

## 부록 B. R4b 예외 표 — 바꾸지 않는 간격 리터럴

규칙(D-FR4-18)으로 늘 허용하는 것(`0` · `1px` 7개 · 음수 23개 · `env()` 의 `0px`)은 적지 않는다. 아래 20개는 게이트(`check-spacing.mjs`)가 같은 열쇠로 지닌다.

| 파일 | 선택자 | 속성 | 값 | 사유 |
|---|---|---|---|---|
| `style-main-panel.css` | `#sidebar[data-rail] .sbl-item` | `padding` | 3px | 레일 40px 안에 점(5px)과 글자가 함께 들어야 한다 — 그 자리의 주석이 계산이다 |
| `style-main-panel.css` | `#sidebar[data-rail] .sbl-item` | `gap` | 3px | 위와 같다 |
| `style-main-panel.css` | `.ui-panel[data-rail] .sb-tab-badge` | `padding` | 3px | 레일 아이콘 귀퉁이의 12px 배지. 레일 폭 안의 값이다 |
| `style-activity.css` | `#agents-panel[data-rail] .ag-tab-n` | `padding` | 3px | 위와 같다(작업 패널 레일의 배지) |
| `style-activity.css` | `#agents-panel[data-rail] :is(.ag-card,.bg-row,.runs-row,.chat-row)` | `padding` | 3px | 레일 40px 안의 이름 두 줄. 좌우 1px 이 글자 폭을 가른다 |
| `style-main-panel.css` | `#add-sandbox-window` | `padding` | 5px | `#add-window` 의 `padding-right:60px` 와 주석의 실측(상자 48px + `right:5px`)으로 묶인 값 |
| `style-main-panel.css` | `#add-window` | `padding-right` | 60px | ±2px 안에 단이 없다. 안쪽 상자의 자리를 비우는 값이다 |
| `style-activity.css` | `.chat-person` | `padding-left` | 20px | ±2px 안에 단이 없다(들여쓰기) |
| `style-activity.css` | `.cacct` | `padding` | 44px | ±2px 안에 단이 없다. 왼쪽 색 막대 칸(40px)에 맞춘 들여쓰기다 |
| `style-activity.css` | `.act-usage-sl-h,.act-usage-sl` | `padding-left` | 44px | 위와 같다(`.cacct` 와 같은 열) |
| `style-docrender.css` | `.dr-body` | `padding` | 20px | ±2px 안에 단이 없다 |
| `style-docrender.css` | `.dr-body` | `padding` | 40px | ±2px 안에 단이 없다(문서 끝 여백) |
| `style-git-views.css` | `.git-br-pfx-head` | `padding-left` | 20px | ±2px 안에 단이 없다(브랜치 트리 들여쓰기) |
| `style-git-views.css` | `.git-br-pfx-body>.git-br-row` | `padding-left` | 44px | 위와 같다 |
| `style-git-views.css` | `.git-br-group-body>.git-br-row` | `padding-left` | 28px | 위와 같다 |
| `style-status.css` | `.confirm-box` | `padding` | 20px | ±2px 안에 단이 없다(같은 값의 24px 은 토큰이다) |
| `style-system.css` | `.fe-error` | `padding` | 20px | ±2px 안에 단이 없다 |
| `style-system.css` | `.boot-name` | `margin-top` | 20px | ±2px 안에 단이 없다 |
| `style-kit.css` | `.ui-badge` | `padding` | `calc(3px * var(--fs-scale))` | 함수 안. 배지 지름(`--ui-badge-h`)과 함께 글자 배율을 탄다 |
| `style-system.css` | `.file-editor:has(> .fe-offer) > .cm-editor` | `margin-top` | `var(--fe-offer-h,32px)` | 함수 안. 제안 줄의 높이를 대신하는 대체값이고 간격의 단이 아니다 |
