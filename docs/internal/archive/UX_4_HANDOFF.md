# 인계 — UI/UX 진단 반영 4차 (남은 항목 전부) + 채팅 창 분리 + 코드 리팩터링

> 넘긴 날: 2026-11-20. 앞 세션의 맥락이 기준(60%)에 다가가 같은 일을 이어 간다.

## 착수 블록 — 이번 세션의 지시 전부

처음 받은 사용자 지시(그대로): *"uiux 관련은 전부 진행. 추가로 코드레벨에서도 리팩토링 대상(중복제거, 함수분리, 상수화 등등)이 있으면 확인하여 전부 진행"*

1. `docs/internal/UX_AUDIT_FIX_SRS.md` 를 먼저 읽는다. 지금까지의 FR(FR-UXF-1~43)과 **사용자 결정 D-1~D-12**(§2.1)가 모두 여기 있다
2. 남은 진단 항목을 진행한다(아래 3절 순서). 묶음마다 **스펙(이 SRS 에 절 추가, IEEE 29148) → 테스트 RED → 구현 → 검사 → 문서 개정 → 사용자 확인 뒤 커밋·푸시**
3. **D-7 채팅 창 분리**는 규모가 커서 **새 SRS** 로 따로 쓴다(인터뷰부터). O3(출력 미리 보기)·O5(명령 팔레트)도 각자 SRS 를 쓴다
4. 코드 리팩터링: 조사 → 목록 문서 → 진행 (`UX_3_HANDOFF.md` 4절의 후보가 출발점)
5. **결정이 필요한 갈림길은 진행 전에 사용자에게 묻는다.** 질문은 하나씩, 권장안을 첫 선택지에. 화면 위치·낱말이 섞인 질문은 자리를 쉽게 풀어 쓴다(사용자가 "1,2,3 이 뭘 말하는 거야"라고 되물은 적이 있다)

## 1. 어디까지 왔나 (모두 푸시됨)

| 커밋 | 내용 |
|---|---|
| `28d0317e` | 모바일 UX 2차 (MOBILE_UX_OVERHAUL_SRS §3.8) |
| `da77b15a` | 패널 템플릿 (PANEL_TEMPLATE_SRS) + 진단 문서 `UX_AUDIT_2026-11-19.md` + `UX_3_HANDOFF.md` |
| `2f71fc55` | 진단 1묶음 FR-UXF-1~12 — D1·D3·D8·D11·D14·M3·M7·M9·X5·X7·O4 |
| `43168017` | 진단 2묶음 FR-UXF-20~31 — M5·M6·D9·D16·M11·M12·X2 + D-9(두 패널 접기 단추) + D-10(수동 새로고침 제거·갱신 실패 처리) |
| `ceb45f9d` | 3묶음 X1 FR-UXF-40~43 — 한국어 화면 말 통일, Activity 의 부르는 이름 **작업 / Work** |

검증(마지막 회차): `make gates` ok · unit 1091 · typecheck · 관련 e2e 1687 통과(flaky 1) · V-LAY-1 darwin 다시 뜸.
**linux·win32 기준선은 아직이다** — 사용자에게 `layout-baseline` 워크플로 실행을 부탁해 두었다(푸시 세 번).

## 2. 먼저 읽을 것

1. `docs/internal/UX_AUDIT_FIX_SRS.md` 전체 — 특히 §2.1 결정, §3.5.1(영어로 남기는 것)·§3.5.2(옮긴 말)
2. `docs/internal/UX_AUDIT_2026-11-19.md` — 진단 원문(항목 D·M·X·O)
3. `docs/internal/UX_3_HANDOFF.md` 3·4·5절 — 격리 인스턴스, V-LAY-1 절차, 리팩터링 후보, 규약(여전히 유효)
4. `docs/internal/PANEL_TEMPLATE_SRS.md` — 두 패널 공통 골격(새 패널·채팅 창 작업의 기준)

## 3. 남은 일과 순서

1. **3묶음 나머지**: D19(글자 10.34·9px, 모서리 3·2px, 단추 높이 22·26·32·36 → 토큰 눈금 — 글자 11 이상, 모서리 4/6/8, 단추 26/30), X9(설정 행 문법 하나 — 좁으면 라벨 위·입력 아래, 넓으면 좌우, 컨테이너 쿼리). M13·M14·D7 이 X9 와 겹친다
2. **4묶음 시그니처**: X6·O1·O2(작업 중 표식 ● 을 pane 탭·사이드바 창 행·레일에도), O1/D2(이름 없는 탭은 실행 중 명령·cwd 로 이름 짓기, `fgNames` 가 있다), M2(모바일 탭 × 는 활성 탭에만)
3. **D-7 채팅 창 분리 SRS** — 결정: 사이드바에 채팅 탭, Repo 창처럼 **채팅 전용 창**이 메인 화면과 짝을 이룬다. 작업 패널에는 에이전트·백그라운드·Run 만 남는다. 방 나가기는 방 안(`⋯` 메뉴)과 채팅 목록(방 행) 두 곳에서 된다(D-22). 지금 채팅은 방을 누르면 현재 창의 포커스 칸에 채팅 탭이 생긴다(`app-chat.js` `_chatOpenTab` → `addTab(this.focused, TAB_TYPE_CHAT)`). 창 저장·복원, 모바일 세그먼트, dmctl 표시, PEER_CHAT_SRS 개정이 걸린다
4. **진단 6절에 없던 항목**(남김없이): D4(Slot 단추 → 아이콘+툴팁/칸 수), D5(설정 모달 높이·섹션 접기), **D6(설정 저장 규칙 — 결정 필요)**, D7·M14(지문 4자 띄어쓰기·복사), D10(진입점 라벨 넓을 때 보이기), D12(fetch·pull·push 라벨), D13·M8(diff 도구 줄 문법), D15(LSP 제안 띠), **D17·X8(데스크톱 사용량 바닥 요약 — MOBILE_UX_OVERHAUL FR-MUX-73 개정, 결정 필요)**, D18(메뉴 단축키 키캡), D20·X3(선택 행 동작 늘 보임), M1(모바일 상태바 → 상단바 점), M4·O7(키바 순서·사용자 구성), M10·O6(서랍 빈 자리), M13(Profile 입력), X4(데스크톱 찾기 돋보기), O8(빈 상태 문구)
5. **O3·O5** — 각자 SRS
6. **코드 리팩터링** — 조사 → 목록 문서 → 진행

금지(이미 거절된 결정): 하단 탭 내비(MOBILE D-2), 칸 스와이프(MOBILE D-5). 제안하지 않는다.

## 4. 값을 치르고 배운 것

- **e2e 를 두 실행이 동시에 돌리면 서로 깨진다** — 결과 폴더와 서버 바이너리를 공유해 `spawn … ENOENT`, 아티팩트 ENOENT 가 난다. 서브에이전트가 e2e 를 도는 동안 메인은 e2e 를 돌리지 않는다. `DM_E2E_KEEP_PEERS=1` 을 붙이면 다른 실행의 teardown 이 서버를 지우는 일을 줄인다
- **`UIKit.button` 은 label·title 이 없으면 던진다.** 부팅 경로(`InputBinding.bind()` → `applyPanelDock()`)에서 던지면 그 뒤 초기화(단축키·상태바·폴링…)가 모두 빠지고, **pageerror 없이** git 자동 갱신이 죽는다(실측)
- 모바일 시트는 미끄러져 들어온다 — 좌표를 재기 전에 `expect.poll(() => panel.left).toBe(0)` 로 전환 끝을 기다린다. 따로 잰 두 rect 는 다른 프레임일 수 있다
- 떠 있는 표면 등장에 `transform` 을 쓰면 메뉴 뒤집기 계산과 화면 덮기 판정이 그 순간의 상자를 재서 틀린다 — fade 만 쓴다(FR-UXF-11)
- 넓은 e2e 회차의 V-LAY-1 실패는 다른 시험의 상태 오염일 수 있다 — 단독으로 다시 돌려 확인한다. 데스크톱 DOM·CSS·글자를 바꾸면 `LAYOUT_BASELINE=write npx playwright test e2e/ui-layout-defaults.spec.ts -g "V-LAY-1 "` 로 darwin 을 다시 뜨고 `UI_LAYOUT_DEFAULTS_SRS.md` §9 끝에 기록한다
- 게이트에서 걸린 것: `check-focus`(outline 을 지우면 같은 바탕 선택자에 `:focus-visible` 링 필요 — 링을 감추려면 `outline-color:transparent`), `kit-key.test` TC-CMP-10b(새 `ui-notice` 는 NOTICE 목록에 등록), decisions 색인(결정 표를 바꾸면 `go run ./scripts/gen-decisions`), 모듈 500줄(`app-settings.js` 500, `commit.js` 492, `app-agents.js` 450 근처)
- 단위 하네스의 `document` 에는 `addEventListener`·`getElementById` 가 없다 — `typeof … === 'function'` 로 지킨다
- 모바일 Repo 창은 Editor 세그먼트로 시작한다 — Changes 는 `#m-repo-seg .m-seg-btn` hasText **`변경`** 을 눌러 연다(X1 이후 글자)
- ko 카탈로그에 영어 값을 더하면 TC-UXF-40(`web/js/test/ux-wording-ko.test.mjs`) 허용 목록을 같이 고쳐야 한다
- `_activityRestore` 같은 스냅샷은 **실패를 빈 목록으로 읽지 않는다** — 실패 시 목록 유지 + 실패 횟수(FR-UXF-28)
- e2e 픽스처: `gitFixture` 의 `basic` 은 스테이지가 있다(커밋 접기 시험에는 `detached` 를 쓴다)
- 섞인 미커밋 변경을 둘로 나눠야 하면 줄 단위 필터로 `git apply --cached --unidiff-zero --recount` 한다 — 순수 삽입 hunk 의 새 쪽 시작 줄은 `old+1+누적 변위` 여야 제자리에 들어간다(앞 세션 실측)

## 5. 변하지 않는 규약

- 순서: 스펙 → 테스트 RED → 구현 → `make gates` · `npm run -s unit` · `npm run -s typecheck` · 관련 e2e → 문서 개정 → **사용자 확인 뒤** 커밋·푸시(메시지 미리보기를 보인다)
- 동작이 바뀌면 SRS·코드 주석에 이전/새/이유. 기존 e2e 단정을 바꿀 때도 `// UX_AUDIT_FIX_SRS FR-UXF-NN 로 개정: 이전 … / 지금 … / 이유 …`
- 커밋 메시지에 AI 서명 금지. `git checkout <파일>` 류 되돌리기는 분류기가 막는다 — 직접 편집
- 문서와 코드가 어긋나면 코드가 진실. 어긋남은 끝에 보고하고 사용자가 고르면 고친다
- 문서 개정 관례: 역사 서술은 지우지 않고 아래에 `> **<SRS> FR-… 으로 개정 (날짜)**: 이전 … / 지금 … / 이유 …`. 표 안에 끼우지 말고 표 아래에 둔다. `docs/external/features.md` · CHANGELOG `[Unreleased]` 도 고친다
- 툴팁(`title`)·`aria-label` 은 영어(FR-TIP-2), 보이는 글자는 로케일(FR-UXF-40)

## 6. 아직 유효한 사용자 결정

- `UX_AUDIT_FIX_SRS` §2.1 D-1~D-12 전부. 요점: 상태바 기본값만 변경(D-1) · 모바일 diff 기본 통합(D-2) · discard 단추 자리 유지(D-3) · 머리 줄 합치되 구분선, 커밋 접기는 모바일만(D-4) · 카드 두 줄 + 막대, 서브 펼침(D-5) · 화면 말은 로케일(D-6) · **채팅 창 분리(D-7)** · Activity 이름 작업/Work(D-8) · 두 패널 접기 단추는 바깥 끝(D-9) · 수동 새로고침 제거·실패 시 앱 새로고침 안내(D-10) · git 명령어는 영어(D-11) · Run 은 영어(D-12)
- `UX_3_HANDOFF.md` 6절(MOBILE_UX_OVERHAUL D-1~D-6·E-1~E-5, PANEL_TEMPLATE D-1~D-5, unslop 방향: 조용함·정확함·손에 맞음 / 야간 관제실의 계기판 / 시그니처는 살아 있는 상태 점)

## 7. 보고할 문서·코드 어긋남 (사용자가 고르면 고친다)

- `scripts/check-i18n-html.mjs` 머리 주석이 "설정 탭 열둘과 모달 제목은 lang="en"" 이라고 적었다 — 이제 아니다
- `docs/external/shortcuts.md` 의 "저장소·Editor 행" — 화면 글자인지 확인 필요
- `docs/internal/DESIGN_TOKENS_SRS.md` 의 `--z-sticky` 표가 `.git-files-bar` 를 센다 — 그 요소는 없어졌다(FR-UXF-23)
