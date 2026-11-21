# SRS: 리팩토링 3차 PROD3 FE 나머지 R1 — 동작 변경·서버 원천 — IEEE 29148

> **문서 상태**: 승인·구현중

> **남은 것**: FR-FR1-1~14 의 구현과 §6 구현 기록. 이슈마다 커밋한다(FC-03 → FU-17 → FC-11 → FC-21).

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `refactor/PROD3.md` §2 FC-03·FC-11·FU-17, §3 행 13 FC-21, §7.1 「P3 FE 나머지 — 정리」 의 하위 묶음 R1)
- 사용자 결정(2026-11-21, `PROD3.md` §6): **Q1** 색 거리는 redmean 하나로 통일한다. 바뀌는 테마와 이전/새 색을 SRS 에 적는다. **Q3** 서브모듈 stage 금지는 서버도 막고 server-driven 으로 옮긴다. 진행은 묻지 않고 끝까지 한다. 코드와 설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 §3 에 이유를 적는다.

## 1. 개요

### 1.1 목적

R1 은 하위 이슈 넷이다. 앞의 셋은 같은 사실을 두 벌로 판정하던 자리를 한 벌로 줄이고, 넷째는 상태바 폴링의 왕복을 줄인다.

| 이슈 | 자리 (HEAD `f959e13e`) | 지금 | 바꾸는 것 |
|---|---|---|---|
| FC-03 | `core/theme-vars.js:18-33` `pickAttnColor` ↔ `core/contrast.js:55` `colorDistance` | 알림색은 제곱 RGB 거리로 고르고, 실행 중 색(`pickAccent2`)은 redmean 거리로 고른다. `pickAccent2` 가 피할 색으로 알림색을 받으므로 한 계산에 두 거리가 섞인다 | 알림색도 `colorDistance`(redmean)로 고른다 |
| FU-17 | `git/git-change-rows.js:257-260` · `core/constants-git-changes.js:351` ↔ `domain/git/write/stage.go:49-56` · `gitapi/handlers_git_write.go:75` | 서브모듈 행의 Stage 를 화면만 끈다. 서버는 그 요청을 받아 `git add` 를 실행하고 200 으로 답한다(아무것도 담기지 않는다) | 서버가 판정하고 거절한다. 화면은 서버의 답으로 버튼을 끈다 |
| FC-11 | `core/settings-claude-rows.js:11-18` `CACCT_AUTO_FIELDS` ↔ `domain/claudeacct/autoswitch.go:77-84` `Validate` · `store.go:22-23` | 자동 전환 숫자 칸 여섯의 범위가 JS 와 Go 에 따로 적혀 있다. 대조하는 게이트가 없다 | 서버가 범위를 응답에 싣고, 화면은 그것을 쓴다 |
| FC-21 | `core/statusbar-controller.js:71-86` `_pollStats` | ping 이 끝난 뒤 stats 를 보낸다(회차당 직렬 2왕복) | 둘을 함께 보낸다. 지연은 그대로 ping 의 왕복만 잰다 |

### 1.2 정의

| 말 | 뜻 |
|---|---|
| 알림색 | `--attn`. 주의가 필요한 탭·칸·카드의 강조색. 테마의 터미널 색 중 `accent` 와 가장 먼 색이다(FR-PAN-10) |
| 실행 중 색 | `--accent2`. 명시값(`ui.accent2`)이 없으면 `pickAccent2` 가 고른다(FR-UXF-126) |
| redmean | `colorDistance` 의 가중 RGB 거리(0~약 765) |
| 메인색 변환 | `seedTheme(theme, seed)`. 결과에는 `accent2` 명시값이 없다(TC-SEED-5) |
| 안쪽만 바뀐 서브모듈 | porcelain v2 `sub` 필드가 `S` 로 시작하고, 커밋 몫(`C`)이 없으며, 안쪽 변경(`M` 또는 `U`)이 있는 항목. `SUBMODULE_DIRTY_NOTICE_SRS` 의 상태 B. `git add` 가 index 에 올릴 것이 없다 |
| 행 답 | 변경 목록의 행 하나에 대한 동작 답(`{ok, why, args}`, `SERVER_DRIVEN_ACTIONS_SRS` FR-SDA-1) |

### 1.3 범위 밖

- 계정 행의 숫자 칸(계정별 한도 50~100·우선순위 0~1000·별칭 24자, `settings-claude.js` `_cacctAccountRow`). FC-11 의 대상은 자동 전환 칸 여섯이다. 같은 모양의 두 벌이 남는다(§6 남긴 것).
- 자동 전환 범위 **값**. 값은 바꾸지 않는다.
- 알림색의 후보 목록(노랑·자홍·청록·초록의 bright 우선)과 최후 폴백. 거리만 바꾼다.
- 상태바의 표시 모양, 폴링 주기, `TimerHub` 겹침 가드.

### 1.4 불변 조건

| ID | 조건 |
|---|---|
| INV-R1-1 | 알림색·실행 중 색의 후보·폴백·대비 끌어올리기 규칙은 그대로다. 바뀌는 것은 거리 계산 하나다 |
| INV-R1-2 | 내장 테마 54종이 대비 게이트(`check-contrast`)를 그대로 지난다. 실행 중 색은 accent·알림색·danger 와 구분 거리 120 이상이다(FR-UXF-125) |
| INV-R1-3 | 커밋 몫이 있는 서브모듈(상태 A·C)과 서브모듈이 아닌 행의 Stage 는 지금처럼 된다. 여러 행을 함께 담는 요청(그룹 일괄·선택)은 담을 것이 하나라도 있으면 지금처럼 실행된다 |
| INV-R1-4 | 꺼진 Stage 의 툴팁 글은 지금과 같은 영어 문장이다 |
| INV-R1-5 | 자동 전환 칸의 범위 값, 칸 순서, 라벨, 저장 본문은 그대로다 |
| INV-R1-6 | `_latency` 는 `/api/ping` 한 번의 왕복 시간이다. ping 실패(status 0)면 `null` 이다. stats 실패면 `_stats` 를 그대로 둔다. 회차마다 `updateStatusBar()` 는 한 번, 두 응답을 받은 뒤에 불린다 |
| INV-R1-7 | 계층·로드 순서·크기·킷·i18n·server-driven 게이트를 지킨다 |

## 2. 요구사항

### 2.1 FC-03 — 색 거리 한 벌

| ID | 요구 |
|---|---|
| FR-FR1-1 | `pickAttnColor(theme)` 은 후보마다 `colorDistance(c, ui.accent)` 를 재고 가장 큰 후보를 고른다. 같으면 앞선 후보다. 제곱 RGB 거리 식은 `theme-vars.js` 에서 없어진다 |
| FR-FR1-2 | 내장 테마의 바뀌는 색은 §5 표와 같다. Ayu Mirage 의 실행 중 색 명시값을 `pickAccent2` 가 새 거리로 고르는 값(`#dfbfff`)으로 바꾼다(D-FR1-2) |
| FR-FR1-3 | 시험 `accent2.test.mjs`·`seed-color.test.mjs` 가 새 거리를 고정한다. 알림색이 redmean 으로 고른 색이고, 제곱 거리로는 다른 색이 나오는 팔레트에서 redmean 쪽을 고르며, Ayu Mirage 의 알림색과 실행 중 색이 §5 값이다 |

### 2.2 FU-17 — 서브모듈 stage 금지를 서버로

| ID | 요구 |
|---|---|
| FR-FR1-4 | 도메인: `query.FileEntry.SubmoduleInnerOnly()` 가 안쪽만 바뀐 서브모듈인지 답한다. 판정 근거는 `Sub` 필드 하나다 |
| FR-FR1-5 | 새 사유 코드 `submodule_inner_only`(409, 상태 때문)를 `apierr` 에 더하고 오류 카탈로그 안내(`codes_doc.go`)를 적는다. 새 동작 ID `git.stage` 를 `action.Catalog` 에 그 사유와 함께 더한다 |
| FR-FR1-6 | 판정 함수 `stageAnswer(st, paths)` 하나: 요청 경로가 하나 이상이고 **모두** 그 status 의 안쪽만 바뀐 서브모듈이면 409 `submodule_inner_only`, 아니면 허용이다(D-FR1-3) |
| FR-FR1-7 | `POST /api/git/stage` 는 실행 전 status(`snapshot`)로 `stageAnswer` 를 부르고, 거짓이면 실행하지 않고 `rejectAnswer` 로 거절한다(본문 `{"error":"submodule_inner_only", requested, repo, status}`, 헤더 `X-Error-Code`). `unstage` 는 바뀌지 않는다 |
| FR-FR1-8 | `GET /api/git/status` 의 전량 응답은 `rowActions` 를 싣는다: 서브모듈 행(`Dir` 이고 `Sub` 가 `S` 로 시작)마다 `{"<path>": {"git.stage": 답}}`. 답은 `stageAnswer(st, [path])` 다. 서브모듈 행이 없으면 빈 객체다. `unchanged` 응답은 싣지 않는다 — 관측(`mark`) 안의 사실이고, 화면은 앞 응답의 것을 이어 쓴다(`gitStatusMerge`) |
| FR-FR1-9 | 화면: 행의 Stage 는 `rowActions[path]['git.stage']` 가 있으면 `actionState(답, false)` 로 켜고 끈다. 없으면 행 단위 판정이 없다(지금처럼 켜짐, D-FR1-5). 꺼진 버튼의 `title` 은 사유 코드로 고른 영어 문장 표 `GIT_STAGE_WHY_TITLE` 의 값이고, 표에 없는 코드면 `actionState` 의 사유다. `gitSubParts` 로 Stage 를 판정하던 코드와 `GIT_TIP_SUB_STAGE_OFF` 를 없앤다 |
| FR-FR1-10 | 거절 문구: `why.submodule_inner_only` 를 `ko.js`·`en.js` 에 더한다(`check-action-reasons` 게이트). 거절된 쓰기는 기존 `writeReason`(M-10)이 그 문구로 보인다 |
| FR-FR1-11 | `scripts/check-server-driven.sh` 의 없앤 이름 목록에 `GIT_TIP_SUB_STAGE_OFF` 를 더한다. 단위 시험(소스 검사)이 `git-change-rows.js` 의 Stage 판정에 `gitSubParts` 가 없음을 확인한다 |

### 2.3 FC-11 — 자동 전환 범위를 서버 원천으로

| ID | 요구 |
|---|---|
| FR-FR1-12 | Go: `claudeacct.AutoRanges`(키 → `{min, max}`)가 숫자 칸 여섯의 범위를 갖는다. 키는 `AutoSettings` 의 JSON 이름이다. `Validate` 는 이 표로 범위를 본다(리터럴 없음). `AutoView` 는 `ranges` 로 이 표를 싣는다 — `GET`·`PUT /api/claude-accounts/autoswitch` 응답 둘 다다 |
| FR-FR1-13 | JS: `CACCT_AUTO_FIELDS` 에서 `min`·`max` 를 없앤다. 칸의 `min`·`max` 속성은 응답의 `ranges[key]` 로 세운다(`cacctAutoRange(ranges, key)`). 그 키의 범위를 받지 못하면 속성을 세우지 않는다 — 범위 판정은 서버의 400 `claude_account_invalid` 가 한다(D-FR1-9) |

### 2.4 FC-21 — ping·stats 를 함께

| ID | 요구 |
|---|---|
| FR-FR1-14 | `_pollStats` 는 `/api/ping` 을 먼저 보내고 곧바로 `/api/stats` 를 보낸다(응답을 기다리지 않는다). `_latency` 는 ping 을 보내기 직전부터 ping 응답이 온 때까지다. 두 응답이 모두 온 뒤 지금 순서대로 처리한다: `_latency` → `_gitJobsSettle` → `_stats` → `updateStatusBar()` |

## 3. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-FR1-1 | 알림색의 거리는 `colorDistance`(redmean) 하나다. 후보와 폴백, 동점의 순서는 그대로 둔다 | 사용자 결정 Q1. 실행 중 색은 이미 redmean 으로 알림색과 떨어지도록 고른다(FR-UXF-125·126). 알림색만 제곱 거리로 고르면 두 판정이 서로 다른 "멀다" 를 쓴다. redmean 은 눈의 감도를 반영해 초록 차이에 무게를 더 준다 |
| D-FR1-2 | Ayu Mirage 의 `ui.accent2` 명시값을 `#6dcbfa` 에서 `#dfbfff` 로 바꾼다 | 새 알림색 `#95e6cb` 와 옛 `accent2` 의 거리가 111 이라 구분 거리 게이트(120, FR-UXF-125)를 깬다. 내장 54종 중 49종의 명시값이 `pickAccent2` 가 고르는 값과 같다 — 명시값은 그 파생으로 정한 값이다. 새 거리로 같은 파생을 돌리면 `#dfbfff` 가 나온다(accent 228 · 알림색 165 · danger 226 · 대비 9.63/10.25). 게이트의 하한을 낮추는 것은 거절한다 — 한 색처럼 읽힌다는 실측에서 나온 값이다 |
| D-FR1-3 | 서버의 거절은 **요청 경로가 모두** 안쪽만 바뀐 서브모듈일 때만이다. 섞인 요청은 그대로 실행한다 | 그룹 일괄 Stage(`_bulk`)와 선택 Stage 는 그 서브모듈 행을 함께 보낸다. 경로 하나라도 걸리면 거절하면 서브모듈 안이 더러운 저장소에서 "모두 Stage" 가 막힌다. 그 서브모듈에 대한 `git add` 는 아무것도 하지 않으므로 함께 실행해도 해가 없다. 행 하나의 답은 같은 함수에 그 경로 하나를 넣은 것이다(FR-SDA-3 — 답과 거절이 같은 함수) |
| D-FR1-4 | 사유 코드는 새 `submodule_inner_only`(409)다 | 기존 코드 중 같은 뜻이 없다. `nothing_staged`(커밋, 400)·`nothing_to_stash`(stash)는 다른 동작의 말이다. 요청이 틀린 것이 아니라 저장소 상태 때문이므로 409 다(FR-SDA-3). 이름은 `untracked_only` 와 같은 꼴이다 |
| D-FR1-5 | 행 답은 status 응답의 최상위 `rowActions`(경로 → 동작 → 답)로 싣는다. 서브모듈 행에만 싣고, 없는 행에는 행 단위 판정이 없다 | 도메인 `FileEntry` 는 관측을 그대로 옮기는 구조체이고(`SUBMODULE_DIRTY_NOTICE_SRS` D-1), 도메인 패키지는 `action` 을 들여오지 않는다. 행 답을 행마다 실으면 변경 수천 개의 응답에 `{"ok":true}` 가 그만큼 붙는다. 판정이 거짓일 수 있는 행은 서브모듈 행뿐이다. 행에 답이 없을 때 끄면(FR-SDA-6 의 `loading`) 모든 행의 Stage 가 꺼진다 — FR-SDA-6 은 첫 응답 전의 규칙이고, 여기서는 응답이 이미 왔다 |
| D-FR1-6 | 사실은 도메인(`FileEntry.SubmoduleInnerOnly`), 답은 HTTP 계층(`gitapi.stageAnswer`)이다 | `SERVER_DRIVEN_ACTIONS_SRS` M-4 와 같은 나눔이다(`write.StashableCount` ↔ `stashCreateAnswer`) |
| D-FR1-7 | 툴팁은 사유 코드 → 영어 문장 표(`GIT_STAGE_WHY_TITLE`)로 고른다 | 버튼 `title` 은 영어다(FR-TIP-2). 커밋 버튼(`GIT_COMMIT_WHY_TITLE`, GR-3f)과 같은 방식이다. 보이는 문장은 지금과 같다(INV-R1-4) |
| D-FR1-8 | 자동 전환 범위는 기존 `autoswitch` 응답의 `ranges` 로 싣는다. 새 종단을 만들지 않는다 | 설정 패널은 그 응답을 이미 받아 칸을 그린다. 저장(`PUT`) 응답도 같은 모양이라 다시 받을 때도 범위가 따라온다 |
| D-FR1-9 | 범위를 받지 못하면 칸에 `min`·`max` 를 세우지 않는다. 화면에 기본값 사본을 두지 않는다 | 사본을 두면 두 벌이 그대로 남는다. 칸의 `min`·`max` 는 입력 보조일 뿐이고(저장 본문은 숫자인지만 본다), 범위 밖 값은 서버가 400 으로 거절하고 화면은 오류를 보인 뒤 서버 값으로 되돌린다(`_cacctDo`). 범위를 못 받는 것은 옛 서버뿐이다 |
| D-FR1-10 | ping·stats 를 함께 보내고 `_latency` 는 ping 의 왕복만 잰다(권장안) | 측정 정의는 그대로다. 종전 주석(FR-PRF-36~38)이 걱정한 오염은 같은 줄에 서는 것이다. 브라우저는 두 요청을 따로 보내고(HTTP/1.1 은 연결 여럿, HTTP/2 는 다중화), 서버의 stats 계산은 ping 처리기를 막지 않는다. stats 응답은 작다. 회차 대기가 RTT 두 번에서 한 번(둘 중 늦은 것)으로 준다 |

## 4. 검증

| ID | 시험 |
|---|---|
| TC-FR1-1 | 단위(`accent2.test.mjs`): 제곱 거리와 redmean 이 다른 답을 내는 팔레트에서 `pickAttnColor` 가 redmean 쪽을 고른다. Ayu Mirage 의 알림색이 `#95e6cb`, `--accent2` 가 `#dfbfff` 다. 나머지 내장 53종의 알림색은 바뀌지 않는다(옛 식으로 고른 값과 같다) |
| TC-FR1-2 | 게이트: `check-contrast` 가 54종·메인색 조합 432개를 지난다 |
| TC-FR1-3 | Go(`query`): `SubmoduleInnerOnly` 의 표 시험 — `S.M.`·`S..U`·`S.MU` 참, `SC..`·`SCM.`·`SC.U`·`S...`·빈 값·`N...` 거짓 |
| TC-FR1-4 | Go(`gitapi`): `stageAnswer` 표 시험 — 경로 없음 허용, 상태 B 하나 거절(409, `submodule_inner_only`, `action.Catalog.MayGive`), 상태 B + 파일 허용, 상태 C 허용, status 에 없는 경로 허용 |
| TC-FR1-5 | Go(`gitapi`, 실제 git): 서브모듈 안에 파일만 더한 저장소에서 `POST /api/git/stage {paths:["sub"]}` 이 409 `submodule_inner_only` 이고 index 가 그대로다. `["sub","x"]` 는 200 이고 `x` 가 담긴다. `GET /api/git/status` 의 `rowActions.sub["git.stage"]` 가 `{ok:false, why:"submodule_inner_only"}` 이고, 커밋 몫이 생기면 `{ok:true}` 다 |
| TC-FR1-6 | 단위(JS): 행의 Stage 가 `rowActions` 의 거짓 답이면 꺼지고 `title` 이 영어 문장이다. 참 답이거나 답이 없으면 켜진다. 소스 검사: `git-change-rows.js` 에 `gitSubParts(e.sub)` 로 Stage 를 판정하는 코드가 없다 |
| TC-FR1-7 | Go(`claudeacct`): `AutoRanges` 의 키가 여섯이고 `AutoSettings` 의 JSON 이름이다. 키마다 하한·상한은 `Validate` 를 지나고, 하한 아래·상한 위는 `ErrInvalid` 다. `View()` 가 `ranges` 를 싣는다 |
| TC-FR1-8 | 단위(JS): `cacctAutoRange` 가 받은 범위를 돌려주고, 없으면 `null` 이다. `CACCT_AUTO_FIELDS` 에 `min`·`max` 가 없다 |
| TC-FR1-9 | 단위(JS): `_pollStats` 가 ping 응답 전에 stats 를 보낸다. `_latency` 는 ping 이 끝난 시각으로 잰다(stats 가 늦어도 늘지 않는다). ping 실패면 `null`, stats 실패면 `_stats` 를 두고 `_gitJobsSettle(jt, null)`. `updateStatusBar` 는 두 응답 뒤 한 번 |
| TC-FR1-10 | e2e(기존): `git-submodule-notice`(Stage 꺼짐·툴팁·상태 C 켜짐)·테마·대비·상태바·설정 Claude 계정 spec 이 모양을 바꾸지 않고 지난다 |

## 5. 동작 변경 기록

| 이전 | 새 | 이유 |
|---|---|---|
| Ayu Mirage(dark)의 알림색 `--attn` 이 `#dfbfff`(자홍) | `#95e6cb`(청록) | D-FR1-1. accent `#ffcc66` 에서 제곱 거리로는 자홍(157)이 청록(149)보다 멀고, redmean 으로는 청록(238)이 자홍(228)보다 멀다 |
| Ayu Mirage 의 실행 중 색 `--accent2` 가 `#6dcbfa` | `#dfbfff` | D-FR1-2. 새 알림색과 구분 거리를 지킨다 |
| 메인색 변환 결과·`accent2` 가 없는 사용자 정의 테마의 알림색·실행 중 색 | 바뀔 수 있다. 내장 54종 × 색상 8개(대비 게이트의 조합 432개) 중 알림색 31개·실행 중 색 29개가 바뀐다(§7) | D-FR1-1. 같은 거리를 쓰는 결과다 |
| 안쪽만 바뀐 서브모듈만 담는 `POST /api/git/stage` 가 200 으로 답하고 아무것도 담지 않았다 | 409 `submodule_inner_only` 로 거절한다. 화면에서 그 요청이 가는 길(행 버튼)은 이미 꺼져 있었고, 그룹 일괄에 그 행만 남은 경우 등은 사유를 보인다 | 사용자 결정 Q3. 화면을 거치지 않은 요청도 같은 판정을 받는다(FR-SDA-9) |
| 상태바 회차가 ping 응답을 기다린 뒤 stats 를 보냈다 | 둘을 함께 보낸다 | D-FR1-10. 회차당 대기 2왕복 → 1왕복 |

## 6. 구현 기록

| 커밋 | 요점 |
|---|---|

## 7. 부록 — 메인색 변환에서 바뀌는 색 (TC-FR1-2 의 조합, 실측)

조합은 `check-contrast.mjs` 와 같다: 테마마다 accent 의 밝기·채도(최소 0.1)로 색상 0·45·…·315° 의 메인색. 열은 이전 → 새.

| 테마 | 색상 | 알림색 | 실행 중 색 |
|---|---|---|---|
| Nord | 135 | `#ddd18c` → `#ba8da3` | `#ba8da3` → `#79a4bd` |
| Catppuccin | 90 | `#fcc1da` → `#9de2c6` | `#73baf5` → `#f8e3af` |
| Monokai | 225 | `#cfe380` → `#70eb67` | `#70eb67` → `#e6c672` |
| GitHub Dark | 90 | `#e3a2f0` → `#5bd6ca` | `#21aef6` → `#d284ed` |
| Material Ocean | 0 | `#dbe17d` → `#d78cd9` | `#9ba2fd` → `#dbe17d` |
| Material Ocean | 45 | `#a1d7ff` → `#d78cd9` | `#d78cd9` → `#a1d7ff` |
| Night Owl | 90 | `#d78cd9` → `#8bdbb9` | `#4ec68f` → `#d78cd9` |
| Cobalt² | 270 | `#e4d825` → `#00fa9c` | `#00fa9c` → `#e4d825` |
| Everforest | 180 | `#cec280` → `#cf9bc3` | `#cf9bc3` → `#cec280` |
| Kanagawa | 90 | `#9a88a4` → `#e3c584` | `#e3c584` → `#6ca1d5` |
| Synthwave '84 | 90 | `#ff86bb` → `#93ed9d` | `#93ed9d` → `#8984bc` |
| VSCode Dark+ | 135 | `#05bcca` → `#e56abc` | `#e56abc` → `#0096d9` |
| VSCode Dark Modern | 135 | `#e56abc` → `#13d7da` | `#13d7da` → `#d6ff61` |
| Vesper | 90 | `#a9fed0` → `#fe8563` | `#a0a0a0` → `#a9fed0` |
| Vitesse Dark | 90 | `#5eaca9` → `#e7cb77` | `#dbd7ca` → `#5598b9` |
| Houston | 90 | `#eca0ee` → `#75e9bd` | `#00dce8` → `#eca0ee` |
| Andromeda | 90 | `#dd40ce` → `#52e7a9` | `#52e7a9` → `#dd40ce` |
| Iceberg | 135 | `#a1a4d7` → `#e1b682` | `#e1b682` → `#a1a4d7` |
| Iceberg | 315 | `#eead94` → `#cec588` | 그대로 |
| Tomorrow Night | 90 | `#d093ca` → `#eac447` | 그대로 |
| Monokai Pro | 0 | `#c5d460` → `#7ed9f5` | `#7ed9f5` → `#c5d460` |
| Snazzy | 135 | `#99eff1` → `#ff72a0` | `#ff72a0` → `#3acdf1` |
| Oceanic Next | 135 | `#ce91b8` → `#e7d164` | `#e7d164` → `#ce91b8` |
| Tomorrow Night Eighties | 135 | `#d596be` → `#ecd567` | `#ecd567` → `#559ec6` |
| Gruvbox Material | 180 | `#c9ad55` → `#d6878a` | `#d6878a` → `#95bb73` |
| Mariana | 315 | `#ffa871` → `#60b1bf` | `#60b1bf` → `#ffc381` |
| Hopscotch | 180 | `#e8d65d` → `#cb5f64` | `#66c863` → `#e8d65d` |
| One Light | 180 | `#8b7000` → `#9432bc` | `#9432bc` → `#0085dc` |
| Everforest Light | 0 | `#a59800` → `#56a466` | `#538ac5` → `#958b0a` |
| Vitesse Light | 135 | `#c2505f` → `#38a5a6` | `#007faa` → `#006f99` |
| Vitesse Light | 315 | `#178b75` → `#469fc0` | `#4d73b7` → `#007560` |
