# 인계 — 모바일 UX 2차 (Activity 접근 · Repo 세그먼트 · 사용량 요약 · unslop 정리)

> 넘긴 날: 2026-11-19. 앞 세션의 맥락이 차서 같은 일을 이어 간다.

## 1. 어디까지 왔나

- `e3abb163` — 모바일 UX 1차 개편. 스펙은 `docs/internal/MOBILE_UX_OVERHAUL_SRS.md`(FR-MUX-1~61, 이미 구현됨)
  - 서랍·Activity·설정을 전체 높이 시트로 통일. 설정은 목록 → 상세
  - 키바는 터미널 칸에서만, 상태바는 연결·cwd 만
  - 길게 누르기 → 컨텍스트 메뉴, 터치 크기, 결함 교정, 가로 휴대폰 판정
  - 내부·외부 문서와 CHANGELOG `[Unreleased]` 개정
- `5156da4e` — 에이전트 주입 안내문 개정 (`internal/shared/runtime/agentmemory/CLAUDE.md`). 이번 일과 관계없다
- 둘 다 `main` 에 푸시했다. 작업 트리는 깨끗하다(이 문서의 커밋만 더해진다)
- **아직 시작하지 않은 일**: 아래 2의 네 가지. 코드 변경은 없다

## 2. 남은 일과 순서 — 사용자가 확정한 결정

사용자 접수: *"패널 열고 액티비티로 접근해 들어가는 점, 에디터 탭이 있으면 git 이나 탐색기 패널을 못 보는 점이 불편하고,
모바일에서는 액티비티의 사용량이 너무 커서 불편해. /unslop 도 적극 이용해봐"*

| # | 결정 | 메모 |
|---|---|---|
| ① | 모바일 상단바의 ☰ 옆에 **Activity 단추**를 둔다. 작업 중인 에이전트가 있으면 **상태 점과 수**를 보인다. 서랍 안의 Activity 단추(`#m-drawer-acts`, `app-mobile.js` `initMobile`)는 **뺀다** — 문은 하나 | 단추는 `x`(닫기)인 Activity 시트를 연다. 상태는 `ACTIVITY_STATE`·`AGENT_STATE_ICON`(constants.js), 에이전트 목록은 `app-agents.js` 를 본다 |
| ② | Repo 창(모바일)에서 `‹ n/m ›` 칸 순회와 사이드의 `Changes │ Explorer` 탭 줄을 **한 줄 세그먼트** `[Changes] [Explorer] [편집기 n]` 로 합친다. 어느 화면에서나 한 번에 간다 | 순회 자리 모델은 `app-mobile.js` 의 `mobileSideSlots`·`mobileOnSide`·`mobileShowPane`·`navMobilePane`(사이드 = 자리 0). 사이드 탭은 `app.testing.edSetSide(w,'changes'|'explorer')`. 일반 터미널 창은 종전대로 `‹ n/m ›` |
| ③ | 모바일 Activity 의 사용량(`#agents-foot`)은 **사용 중 계정 한 줄 요약**(이름·세션 %·주간 %)만 둔다. **누르면 전체가 펼쳐진다** | 실측: 계정 셋에 839px 중 270px. 구성은 `app-activity.js` `_actItems`·`_actUsageFootEl`, `app-claude-accounts.js` `_claudeAcctEl` |
| ④ | unslop 정리(light slop → polish 모드)를 **데스크톱까지** 적용한다 | 아래 목록 |

④의 정리 목록 — 진단에서 찾은 흔적:

- 계정 행 왼쪽의 **색 번짐 띠**(`.cacct-bar` 의 넓은 그라데이션) → 얇은 단색 막대
- statusLine 줄에 **같은 계정의 사용량이 한 번 더** 나온다(계정 묶음의 `Work` 와 statusLine 의 `Work`) → 중복을 뺀다
- `사용 중` **테두리 알약** → 조용한 글자(보조 글자색)
- 서랍 Activity 단추의 **경고색(attn)** → ①에서 단추 자체가 빠진다

unslop 방향 (사용자 확인함):

- 제품: 브라우저에서 터미널·편집기·Git·에이전트를 돌보는 개발자용 원격 작업대. 모바일은 "밖에서 에이전트를 지켜보고 가볍게 손보는" 자리
- 성격: 조용함, 정확함, 손에 맞음
- 세계: 야간 관제실의 계기판 — 꺼져 있는 화면 위의 상태 램프
- 모먼트: Activity 의 에이전트 상태와 사용량 막대 하나. 나머지 크롬은 조용히 둔다
- 시그니처: 살아 있는 상태 점(작업 중 ● / 끝남 ✓). ①의 상단바 단추에도 쓴다

권장 순서: ③ → ① → ② → ④. ③·①은 Activity 한 덩이이고, ②가 가장 크며, ④는 ①·③을 그리는 동안 함께 손대는 자리가 많다.

## 3. 먼저 읽을 것

1. `docs/internal/MOBILE_UX_OVERHAUL_SRS.md` — §2.2 사용자 결정, §3 요구사항, §7 구현 위치. **이 문서에 FR 을 더한다**(새 절 `3.8`, 번호는 `FR-MUX-70~`)
2. `web/js/core/app-mobile-sheets.js` — `mobileChromeSync`(시트·키바·상태바), 설정 목록→상세, 길게 누르기
3. `web/js/core/app-mobile.js` — 순회 자리 모델, `initMobile`
4. `web/style.css` 의 `/* ── MOBILE_UX_OVERHAUL_SRS ──` 블록
5. `e2e/mobile-ux-overhaul.spec.ts` — 새 검사는 여기에 더한다
6. `/Users/dykim/.claude/skills/unslop/SKILL.md` — 아홉 단계(spacing → color → icons → copy → type → layout → details → visuals → motion)와 체크리스트

## 4. 값을 치르고 배운 것

- **운영 인스턴스에 모바일 뷰포트로 붙지 않는다.** 그 쪽 터미널 크기가 바뀐다. 격리 인스턴스를 쓴다:
  ```sh
  go build -o /tmp/dm-mobile/dongminal ./cmd/dongminal
  mkdir -p /tmp/dm-mobile/home/tool-home
  # 새 탭에서 (dmctl new-tab -n --at <자기 탭 uuid> --name mobile-test-server 뒤 send-input):
  env -u DONGMINAL_HOST -u DONGMINAL_PORT -u DONGMINAL_TOOL_ID -u DONGMINAL_HISTFILE \
    DONGMINAL_HOME=/tmp/dm-mobile/home DONGMINAL_TOOL_HOME=/tmp/dm-mobile/home/tool-home \
    DONGMINAL_NO_UPDATE_CHECK=1 /tmp/dm-mobile/dongminal start --foreground --port 61990
  # 끝나면: /tmp/dm-mobile/dongminal stop --all --home /tmp/dm-mobile/home --port 61990
  ```
  web 자산은 바이너리에 임베드된다 — **CSS·JS 를 고칠 때마다 다시 빌드하고 서버를 재기동**해야 화면에 닿는다. 사용자는 점검이 끝나면 점검용 서버를 내려 달라고 했다
- Playwright MCP 로 모바일을 보려면 `browser.newContext({viewport:{width:412,height:839},deviceScaleFactor:2,isMobile:true,hasTouch:true})`. 길게 누르기는 CDP `Input.dispatchTouchEvent`(touchStart → 700ms → touchEnd)로 재현한다
- 사용량 목 데이터는 `e2e/claude-accounts.spec.ts` 의 `mockState()` 형태로 `**/api/claude-accounts**` 의 `GET /` 를 route 한다(계정 3개면 실측과 같은 화면이 나온다)
- **데스크톱 DOM 을 바꾸면 `V-LAY-1`(계산값 기준선, `e2e/baseline/ui-layout.{darwin,linux,win32}.json`)이 깨진다.** 기준선은 세 판이고 여기서는 darwin 만 다시 뜰 수 있다. 그래서 1차에서는 모바일 전용 요소를 **모바일에서 처음 필요할 때** 만들고(`_settingsMobileHead`), 속성도 모바일에서만 바꿨다(`nav.hidden=isMobile&&n<=1`). ①②도 같은 방식으로 한다. ④는 데스크톱 CSS 값을 바꾸므로 V-LAY-1 의 값 대조에 걸릴 수 있다 — 걸리면 `UI_LAYOUT_DEFAULTS_SRS.md` §9 의 절차를 읽고 판단하고, 세 판 기준선을 다시 떠야 하면 **사용자에게 묻는다**
- `make gates` 에서 걸렸던 것: 모듈 500줄(`app-mobile.js` 478, `app-settings.js` 500 — 더하면 넘는다, 새 모듈로 가른다) · font-size 는 토큰만(`--fs-*`, px 금지) · 새 관측자는 이름에 묶는다(`this._xxxMo=`) · 구르는 표면은 만드는 자리에서 `ui-scroll-sm` · e2e 는 `app.testing.<이름>` 만(계약은 `app-testing.js`, 앞 `_` 를 뗀 이름) · e2e 고정 대기는 `TEST-16` 표식과 사유 · SRS 결정이 바뀌면 `go run ./scripts/gen-decisions`
- 단위 테스트 하네스는 일부 모듈만 싣는다. 다른 파일의 메서드를 부를 때는 `if(this.x) this.x()` 로 지킨다(1차에서 `setAgentsPanelOpen` 이 이것으로 4건 깨졌다)
- 전체 e2e 는 2,200건이라 오래 걸린다 — 사용자가 길다고 했다. 관련 스펙만 돌린다:
  `e2e/mobile-ux-overhaul.spec.ts e2e/mobile-keybar.spec.ts e2e/settings.spec.ts e2e/ui-layout-defaults.spec.ts e2e/activity-rail.spec.ts e2e/a11y-dialog.spec.ts e2e/touch-targets.spec.ts e2e/git-head-mobile.spec.ts e2e/ux-batch13.spec.ts e2e/claude-accounts.spec.ts e2e/activity.spec.ts e2e/repo-tab.spec.ts`
- `git checkout <파일>` 같은 되돌리기는 권한 분류기가 막는다. 고친 것을 걷을 때는 직접 편집한다. 커밋과 푸시는 따로 부른다

## 5. 변하지 않는 규약

- 순서: 스펙(SRS 에 FR 추가, IEEE 29148) → e2e RED → 구현 → `make gates` · `npm run -s unit` · `npm run -s typecheck` · 관련 e2e → 문서 개정 → **사용자 확인 뒤** 커밋·푸시
- 동작을 바꾸면 SRS·코드 주석에 이전 동작 / 새 동작 / 이유를 적는다. 기존 e2e 단정을 바꿀 때도 같다
- 커밋 메시지에 AI 서명을 넣지 않는다
- 문서와 코드가 어긋나면 코드가 진실이다. 어긋남은 끝에 보고하고 사용자가 고를 때 고친다
- 문서 개정은 1차 관례를 따른다: 역사 서술은 지우지 않고, 틀린 말이 된 문장 바로 아래에 `> **MOBILE_UX_OVERHAUL_SRS FR-MUX-n 으로 개정 (날짜)**: 이전 … / 지금 … / 이유 …` 를 단다. `docs/external/features.md` 의 `## 모바일` 절과 CHANGELOG `[Unreleased]` 도 고친다

## 6. 아직 유효한 사용자 결정

- 1차의 D-1~D-6(`MOBILE_UX_OVERHAUL_SRS.md` §2.2): 상단바 유지·전체 높이 시트·하단 탭 내비 없음·칸 스와이프 없음·상태바 연결·cwd 만
- 이 문서 2의 ①~④와 unslop 방향
- 점검이 끝나면 점검용 dongminal(격리 서버·데몬·탭)을 내린다
