# 인계 — UI/UX 3차 (진단 항목 전부) + 코드 리팩터링

> 넘긴 날: 2026-11-19. 앞 세션의 맥락이 기준(60%)에 다가가 같은 일을 이어 간다.

## 착수 블록 — 이번 세션의 지시 전부

사용자 지시(그대로): *"uiux 관련은 전부 진행. 추가로 코드레벨에서도 리팩토링 대상(중복제거, 함수분리, 상수화 등등)이 있으면 확인하여 전부 진행"*

1. **커밋부터 묻는다(가장 먼저).** 작업 트리에 앞 두 작업이 **커밋되지 않은 채** 있다(아래 1절). 사용자 규칙상 커밋은 확인 뒤에만 한다. `AskUserQuestion` 으로 "두 커밋으로 나눌지(① 모바일 UX 2차 ② 패널 템플릿) / 하나로 묶을지" 를 묻고, 메시지 안을 보인 뒤 커밋한다. 푸시도 확인을 받는다. 푸시 뒤에는 사용자에게 `layout-baseline` 워크플로 실행(linux·win32 기준선)을 부탁한다
2. `docs/internal/UX_AUDIT_2026-11-19.md` 의 항목 **전부**를 진행한다 — D1~D20 · M1~M14 · X1~X9 · O1~O8. 권장 순서는 그 문서 6절이다. O3(출력 미리 보기)·O5(명령 팔레트)는 규모가 커서 **각자 SRS 를 따로** 쓴다
3. 코드 리팩터링: 조사 → 목록 문서 → 진행. 범위는 2·3차에서 손댄 web 프론트부터(아래 4절에 이미 본 후보)
4. 큰 묶음마다 스펙(IEEE 29148, 새 SRS 또는 기존 SRS 에 FR 추가) → e2e/unit RED → 구현 → 검사 → 문서 개정 → 사용자 확인 뒤 커밋

**결정이 필요한 갈림길은 진행 전에 사용자에게 묻는다.** 이미 보이는 것들:
- X1 말 통일 — 화면 문구 로케일 하나 + 영어로 남길 것의 표. 어느 쪽을 기본으로 할지(한국어 UI 인데 설정 섹션은 영어) 묻는다
- D6 설정 저장 규칙(즉시 적용 vs 저장) 통일 방식
- D3 상태바 기본 항목 변경(기존 사용자 설정값을 건드리지 않는 방법)
- D17/X8 데스크톱 사용량 바닥도 요약으로 접기 — MOBILE_UX_OVERHAUL_SRS FR-MUX-73(데스크톱 불변)을 개정해야 한다
- M6 discard 를 길게 누르기 메뉴로 옮기기, M7 모바일 diff 기본 통합 보기 — 동작 변경
- 금지: 하단 탭 내비(D-2), 칸 스와이프(D-5)는 이미 거절된 결정이다. 제안하지 않는다

## 1. 어디까지 왔나

- 직전 커밋 `e0ce852c`(2차 인계 문서). 그 앞 `e3abb163`(모바일 UX 1차)·`5156da4e` 는 푸시됨
- **미커밋 작업 둘** (작업 트리 43개 파일):
  - **모바일 UX 2차** — `MOBILE_UX_OVERHAUL_SRS.md` §3.8 FR-MUX-70~82: 사용량 한 줄 요약, 상단바 Activity 단추(`#m-act-btn`), Repo 세그먼트(`#m-repo-seg`), unslop 정리(3px 단색 막대·`사용 중` 조용한 글자·등록 계정 statusLine 줄 제거). 새 모듈 `web/js/core/app-mobile-nav.js`
  - **패널 템플릿** — `PANEL_TEMPLATE_SRS.md` FR-PNT-1~20: 메인 패널·Activity 같은 골격(`ui-panel`·`ui-panel-head`·`ui-panel-tabs`·`ui-panel-tab`·`ui-panel-acts`), 새 CSS `web/style-panel.css`(마지막에 로드), 모바일 시트(화면 전체, 좌/우 미끄러짐, 열림 표식 `.open`), 모바일 Activity 누른 뒤 유지·닫힘(`actSheetLeave`)
- 검증 상태(마지막): `make gates` 0 · unit 1087 통과 · typecheck 통과 · 관련 e2e 497 통과(1 flaky 고침) · `e2e/panel-template.spec.ts` 11 · V-LAY-1 darwin 다시 뜸(2516자리)
- **진단 문서** `docs/internal/UX_AUDIT_2026-11-19.md` 도 미커밋(새 파일)
- 내부 문서 개정 완료: CHANGELOG `[Unreleased]`, `docs/external/features.md` 모바일 절, `docs/internal/README.md`, UX_BATCH12·UIUX_OVERHAUL·STATUS_BAR_REFLOW·WINDOW_SLOTS·CLAUDE_ACCOUNTS·UI_LAYOUT_DEFAULTS(§9 기록)

## 2. 먼저 읽을 것

1. `docs/internal/UX_AUDIT_2026-11-19.md` — 전 항목, 6절 순서
2. `docs/internal/PANEL_TEMPLATE_SRS.md` — 템플릿 규약(새 패널·떠 있는 표면 작업 때 기준)
3. `docs/internal/MOBILE_UX_OVERHAUL_SRS.md` §3.8, §7 구현 위치
4. `docs/internal/MOBILE_UX_2_HANDOFF.md` 4~5절 — 아래 6·7절에 요점을 옮겼다
5. `web/style-panel.css`, `web/js/core/app-mobile-nav.js`, `web/js/core/app-mobile-sheets.js`

## 3. 값을 치르고 배운 것

- **격리 인스턴스로만 점검한다**(운영 인스턴스에 모바일 뷰포트로 붙으면 그쪽 터미널 크기가 바뀐다):
  ```sh
  go build -o /tmp/dm-mobile/dongminal ./cmd/dongminal
  mkdir -p /tmp/dm-mobile/home/tool-home
  # 새 탭(dmctl new-tab -n --at <자기 탭 uuid> --name mobile-test-server) 에서:
  env -u DONGMINAL_HOST -u DONGMINAL_PORT -u DONGMINAL_TOOL_ID -u DONGMINAL_HISTFILE \
    DONGMINAL_HOME=/tmp/dm-mobile/home DONGMINAL_TOOL_HOME=/tmp/dm-mobile/home/tool-home \
    DONGMINAL_NO_UPDATE_CHECK=1 /tmp/dm-mobile/dongminal start --foreground --port 61990
  ```
  web 자산은 임베드된다 — 고칠 때마다 다시 빌드·재기동. 끝나면 그 탭을 `close-tab --force` 로 닫아 서버를 내린다(사용자 요청)
- Playwright MCP 모바일: `browser.newContext({viewport:{width:412,height:839},deviceScaleFactor:2,isMobile:true,hasTouch:true})`. `globalThis` 에 페이지를 저장해도 다음 호출에 남지 않는다 — `page.context().browser().contexts()` 에서 찾는다
- **e2e 의 활동 목은 서버 응답에도 넣는다.** 패널을 열면 `/api/tools/activity` 를 다시 받아 없는 활동을 지운다(FR-RSF-8) — `page.route('**/api/tools/activity', …{activities:[…],limits:[]})` 와 `app.testing.onToolActivity` 를 함께
- Runs 행 단추는 서버 답(`actions:{'run.delete':{ok:true}}`)이 있어야 선다(FR-SDA-61)
- 계정 목: `e2e/mobile-ux-overhaul.spec.ts` 의 `mockAccounts`. statusLine "계정 모르는 줄" 은 다른 시험이 공유 서버에 보고할 수 있다 — 단정은 `.act-usage-sl.cacct-sl` 처럼 좁힌다
- **V-LAY-1**: 키 = 선택자(클래스 목록). 요소에 클래스를 더하면 키가 옮겨 **다른 요소가 그 키를 이어받아** 값이 "바뀐" 것처럼 보인다. 대조는 양쪽에 있는 키만 하고, 지금에만 있는 키는 드리프트 수(SRS §9 `드리프트:`)에 든다. 데스크톱 DOM/CSS 를 바꾸면 darwin 은 `LAYOUT_BASELINE=write npx playwright test e2e/ui-layout-defaults.spec.ts -g "V-LAY-1 "` 로 다시 뜨고, linux·win32 는 CI 워크플로(사용자 실행)다. 바꿀 때마다 `UI_LAYOUT_DEFAULTS_SRS.md` §9 끝에 기록한다
- id 선택자(1,0,0)는 클래스 규칙을 이긴다 — 템플릿이 이기도록 패널의 폭·경계 규칙은 `body:not(.mobile) #…` 로 좁혀 두었다
- `visibility` 는 한쪽 끝이 visible 이면 전환 내내 visible — `transition:transform var(--dur-slow) ease,visibility var(--dur-slow)` 하나로 열고 닫힘이 맞는다. 시간 리터럴(`0s`)은 게이트(FR-TOK-47)가 막는다
- 머리 아래 선은 `box-shadow:inset 0 -1px 0` — border 면 탭이 1px 낮아 모바일 터치 하한(44) 미달(touch-targets TC-A11Y-13b 가 잡는다)
- `make gates` 에서 걸린 것: `<button>` 은 킷 등급 클래스(`ui-btn …`) 필수 · font-size 토큰만 · 모듈 500줄(`app-mobile.js` 477, `app-settings.js` 500 — 더하면 새 모듈) · CSS 링크 순서 단위 시험(`css-structure.test.mjs` FEU-24: git-views→runs→sidebar→editor 연속) · SRS 상태 `승인·구현중` 이면 바로 아래 `> **남은 것**:` 줄 필수 · SRS 결정 표를 바꾸면 `go run ./scripts/gen-decisions`
- 단위 시험 하네스는 일부 모듈만 싣는다 — 다른 파일 메서드는 `if(this.x) this.x()` 로 지킨다
- 전체 e2e(2,200건)는 길다 — 관련 스펙만: `grep -lE "<바꾼 선택자들>" e2e/*.spec.ts` 로 모아 돌린다(지난 회차 약 500건·5분)
- `git checkout <파일>` 류 되돌리기는 권한 분류기가 막는다 — 직접 편집으로 걷는다

## 4. 리팩터링 후보 — 이미 본 것 (조사 출발점)

- `app-agents.js` `agentsRender` 의 `reconcileList` 세 번(머리·몸통·바닥) — 항목 분배를 서술자로
- `app-activity.js`·`app-claude-accounts.js` 의 작은 DOM 헬퍼(`actEl`·`chatEl`·`runDiv`)가 파일마다 따로 있다 — 공용 헬퍼 하나로
- 레일 상태 선택자(`html.sb-collapsed body:not(.mobile) #sidebar`, `body:not(.mobile) #agents-panel:not(.open)`)가 `style-panel.css`·`style.css` 여러 곳에 반복된다
- `style.css` 의 Activity 레일 숨김 목록(`#agents-panel:not(.open) :is(...)`)이 길다
- 모바일 판정·시트 닫기 경로가 `app-mobile.js`·`app-mobile-sheets.js`·`app-mobile-nav.js` 셋에 흩어졌다
- 진단 1절의 눈금 밖 값(글자 10.34px·9px, 모서리 3px·2px, 단추 높이 22·26·32·36) — 토큰화(D19 와 겹친다)
- 조사는 프론트 `web/js/**`·`web/*.css` 중심. 큰 파일·중복 함수·하드코딩 상수(`git grep` 로 px·ms 리터럴, 같은 문자열)부터

## 5. 변하지 않는 규약

- 순서: 스펙(IEEE 29148) → 테스트 RED → 구현 → `make gates` · `npm run -s unit` · `npm run -s typecheck` · 관련 e2e → 문서 개정 → **사용자 확인 뒤** 커밋·푸시
- 동작이 바뀌면 SRS·코드 주석에 이전/새/이유. 기존 e2e 단정을 바꿀 때도 같다
- 커밋 메시지에 AI 서명 금지
- 문서와 코드가 어긋나면 코드가 진실. 어긋남은 끝에 보고하고 사용자가 고를 때 고친다
- 문서 개정 관례: 역사 서술은 지우지 않고 틀린 문장 바로 아래에 `> **<SRS> FR-… 으로 개정 (날짜)**: 이전 … / 지금 … / 이유 …`. `docs/external/features.md` 와 CHANGELOG `[Unreleased]` 도 고친다
- 데스크톱 DOM 을 바꾸지 않아도 되면 모바일에서 처음 필요할 때 만든다(V-LAY-1 보호)

## 6. 아직 유효한 사용자 결정

- MOBILE_UX_OVERHAUL D-1~D-6(상단바 유지·전체 높이 시트·하단 탭 내비 없음·칸 스와이프 없음·상태바 연결·cwd), E-1~E-5
- PANEL_TEMPLATE D-1~D-5(같은 템플릿, 모바일 두 시트 전체 화면·좌우 미끄러짐, 머리는 탭 줄 + 끝 단추, 기준선 darwin+CI, 누른 뒤 유지·닫힘)
- unslop 방향: 조용함·정확함·손에 맞음 / 야간 관제실의 계기판 / 시그니처는 살아 있는 상태 점(● 작업 중 · ✓ 끝남)
- 점검이 끝나면 점검용 dongminal(격리 서버·탭)을 내린다
