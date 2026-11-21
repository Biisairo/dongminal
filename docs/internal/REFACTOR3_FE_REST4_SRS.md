# SRS: 리팩토링 3차 PROD3 FE 나머지 R4 — CSS — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: R4b(FU-10 간격 토큰, §2.5). R4a(FU-18 · FU-8 · FU-9 · FU-11)는 끝났다(§6). R4b 는 다음 에이전트가 §2.5·§3·§4 에 이어 쓴다.

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `refactor/PROD3.md` §2.1 FU-9 · §2.2 FU-18 · §2.3 FU-10 · §2.5 FU-11 · §2.6 FU-8 · §4.3 CSS 크기 줄, §7.1 「P3 FE 나머지 — 정리」 의 하위 묶음 R4)
- 사용자 결정: 진행은 묻지 않고 끝까지 한다(`REFACTOR_PROD3_HANDOFF_2.md` §8). 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다. 범위를 줄이거나 동작을 바꿔야 하면 멈추고 묻는다.
- 실측 기준: HEAD `2cc9e4b3`. 아래 `파일:줄` 은 그 커밋의 것이다. PROD3 의 줄 번호(`c96988c7`)와는 R3b 의 `.pv-*` 규칙만큼 어긋난다(`style.css` 2,492 → 2,545줄).
- 나눔: R4 는 둘로 나눈다. **R4a**(FU-18 · FU-8 · FU-9 · FU-11)는 화면을 바꾸지 않는 정리이고 이 문서가 정한다. **R4b**(FU-10 간격 토큰)는 다음 에이전트가 같은 문서의 §2.5·§3·§4 에 이어 쓴다.

## 1. 개요

### 1.1 목적

R4 는 CSS 를 정리한다. R4a 는 화면을 한 픽셀도 바꾸지 않는다. 규칙의 자리·선택자·파일만 바꾸고, 바꾸기 전과 후의 계산된 스타일을 견주어 확인한다.

| 이슈 | 자리 | 지금 | 바꾸는 것 |
|---|---|---|---|
| FU-18 | `style.css:2229-2238` ↔ `style-runs.css:250-269` | 백그라운드 행(`.bg-row`)의 규칙이 두 파일에 나뉘어 있다. 바탕은 `style.css`, 종료 단추는 `style-runs.css` 다 | 한 파일(`style-runs.css`)로 모은다(§2.1) |
| FU-8 | `style.css` 14곳 · `style-panel.css` 8곳 | 레일 상태를 선택자마다 다시 적는다 — 메인 패널은 `html.sb-collapsed body:not(.mobile) #sidebar`, Activity 는 `body:not(.mobile) #agents-panel:not(.open)` | 패널 루트의 `data-rail` 속성 하나로 바꾸고, 그 속성은 JS 한 자리가 세운다(§2.2) |
| FU-9 | `style.css:874-876` | Activity 레일의 숨김 목록이 `:is()` 하나에 18항목(클래스 20개)이다. 그중 `.ag-title`·`.ag-refresh` 는 웹 어디에도 없다 | 죽은 둘을 지우고, 레일 숨김 목록의 클래스가 JS·HTML 에 실제로 있는지 대조하는 시험을 세운다(§2.3) |
| FU-11 | `style.css` 2,545줄 | CSS 에는 크기 게이트가 없다(`check-file-size.mjs` 는 `web/js` 만 본다) | CSS 크기 기준선 게이트를 더하고, `style.css` 를 영역별 연속 구간으로 나눈다(§2.4) |
| FU-10 | `web/style*.css` | 간격 px 리터럴이 많고 간격 토큰이 없다 | **R4b** — 간격 토큰 3~4단 → 치환 → 게이트(§2.5) |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 레일 | 데스크톱에서 접힌 패널. 폭은 `--sb-rail-w`(40px)이고, 펼침과 같은 DOM 에서 40px 에 들지 않는 것만 숨긴다(PANEL_SURFACE_SRS FR-RAL · UX_BATCH12_SRS FR-ACF) |
| 레일 표식 | 패널 루트(`#sidebar`·`#agents-panel`)의 `data-rail` 속성. 있으면 레일이다. 값은 없다(빈 문자열) |
| 레일 판정 | 패널이 레일을 갖는 종류이고, 닫혀 있고, `body` 에 `mobile` 클래스가 없다 |
| 레일 숨김 목록 | 레일에서 `display:none` 으로 감추는 규칙의 선택자. 레일 표식을 가진 선택자 가운데 `display:none` 을 선언한 것 |
| 연속 구간 | `style.css` 의 원래 줄 순서에서 끊지 않고 이어진 줄 묶음. 나눈 파일은 각각 연속 구간 하나다 |
| 계산된 스타일 | `getComputedStyle` 의 모든 속성(사용자 정의 속성 포함)과 `::before`·`::after` 의 같은 값 |

### 1.3 범위 밖

- FU-10 간격 토큰(R4b).
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

R4b 가 이어 쓴다. 착수 메모는 §6 끝에 있다.

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

## 5. 동작 변경 기록

없다. 자리·선택자·파일 이름만 바꾼다(INV-R4-1·2).

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

**남긴 것.** R4b(FU-10). `style.css` 밖의 500줄 넘는 CSS 넷(D-FR4-14). 연속 구간이라 조각의 이름은 영역의 대강이다 — `style-workspace.css` 끝에 사이드바 행의 알람 규칙(`.sbl-item.attn …`) 몇 줄이 남았다(옮기면 순서가 바뀐다).

**R4b 착수 메모 (FU-10 간격 토큰).** 실측(R4a 뒤, `web/*.css` 주석 제외, 정규식 근사): `gap`·`row-gap`·`column-gap`·`padding*`·`margin*` 의 px 리터럴 **878개**(선언 664개). 속성별 padding 497 · gap 227 · margin 148 · row-gap 6. 값별 8px 177 · 6px 169 · 4px 152 · 10px 90 · 2px 62 · 12px 51 · 3px 51 · 14px 25 · 5px 24 · 16px 12, 음수(-8·-4·-10) 17. `gap` 만 보면 6px 69 · 8px 66 · 4px 45 · 2px 18 · 10px 10 · 3px 9. 파일별 코어 조각 합 433 · `style-git-views` 147 · `style-git` 101 · `style-editor` 80 · `style-runs` 47 · `style-kit` 43.
- 토큰 단 후보: 2·4·6·8 이 네 단(합 560, 64%)이고 10·12 를 더하면 여섯 단(77%). 3·5·7·14 는 근거가 주석에 있는 것이 많다(예: 레일 `.sbl-item` 의 `padding:0 3px` — "점과 글자가 40px 안에"). 리터럴로 두고 예외 표에 적는 편이 낫다.
- 위험: ① 킷 게이트(`check-kit-components.mjs`)가 킷 값을 밖에서 덮는지 본다 — 토큰 치환이 킷 규칙의 문자열을 바꾸면 그 대조를 함께 맞춰야 한다. ② `calc()` 안의 px(코어 36·킷 33·기타)와 단축형 섞임(`padding:0 3px` 같은 2값 이상 164선언)은 기계 치환이 틀리기 쉽다. ③ 터치 하한·`--row` 와 얽힌 값(44px 등)은 간격이 아니다. ④ 화면 불변 확인은 이 SRS 의 방식을 쓰되, `:root` 에 새 `--sp-*` 가 생기면 모든 요소의 계산된 스타일(상속된 사용자 정의 속성)이 달라지므로 비교에서 `--sp-*` 를 빼야 한다. ⑤ 게이트는 `check-radius.mjs`·`check-font-size.mjs` 꼴(리터럴이 남았는지 + 예외 표)을 따른다.
