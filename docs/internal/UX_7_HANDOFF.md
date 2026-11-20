# 인계 — UI/UX 남은 일 (7묶음부터) + 커밋 안 한 6.5묶음 + 코드 리팩터링

> 넘긴 날: 2026-11-20. 넘긴 까닭: 맥락 사용률이 48% 였고, 남은 7묶음을 끝내면 기준(60%)을 크게 넘는다. 같은 일을 이어 간다.

## 착수 블록 — 이번 세션의 지시 전부

처음 받은 사용자 지시(그대로, 여전히 유효): *"uiux 관련은 전부 진행. 추가로 코드레벨에서도 리팩토링 대상(중복제거, 함수분리, 상수화 등등)이 있으면 확인하여 전부 진행"*
이어진 지시: *"테스트는 최소한, 지금 수정 관련된거만 하고 커밋 후 남은 일 전체 하나씩 진행."*
**이 세션의 마지막 지시(가장 중요)**: *"그럼 모든 구현 하고 그다음 하는거야."* — **남은 구현(7묶음)을 모두 끝낸 뒤에** e2e·화면 확인·V-LAY-1 기준선·커밋 미리보기를 **한 번에** 한다. 구현 도중에 관련 e2e 묶음을 돌리지 않는다(사용자가 도중의 e2e 를 멈추게 했다). 단위·게이트·타입은 구현 중에 돌려도 된다.

1. **작업 트리는 깨끗하지 않다 — 커밋하지 않은 6.5묶음이 있다(아래 1절).** 커밋은 사용자 확인 뒤에만 한다(전역 규칙). 지우거나 되돌리지 마라
2. **7묶음을 구현한다.** 스펙은 끝났다 — `UX_AUDIT_FIX_SRS.md` §3.11(FR-UXF-90~96, TC-UXF-90~95), 결정 D-30~D-34. **시험(RED)부터.** 결정은 모두 받았다(2절) — 다시 묻지 않는다
3. 7묶음 구현이 끝나면: `make gates`·`npm run -s unit`·`npm run -s typecheck` → **관련 e2e 한 번에**(6.5묶음 + 7묶음, 3절 목록) → 화면 확인(스크린샷) → V-LAY-1 darwin 기준선 → 문서 개정 → **커밋 미리보기를 보이고 사용자 확인 뒤 커밋**(6.5묶음과 7묶음을 나눌지 사용자에게 묻는다)
4. 그 뒤 순서: O3·O5(각자 새 SRS, 인터뷰부터) → 코드 리팩터링(`UX_REMAINING` §5, 조사 → 목록 문서 → 진행) → 문서·코드 어긋남(사용자가 고른다) → 받아들인 한계 목록을 다시 보이고 바꿀지 묻기
5. **푸시는 하지 않았다.** main 은 origin 보다 **7커밋 앞서 있다**(`769a27c5` 4묶음 … `cfba2114` 6묶음). 푸시와 e2e 전량은 사용자에게 묻는다 — 묻지 않고 시작하지 않는다
6. 갈림길은 하나씩, 선택지마다 결과를 풀어 쓰고 화면 낱말이 섞이면 ASCII `preview` 를 붙여 묻는다. **질문 도중 사용자가 "지금은 어떻게 되어있지?" 처럼 되물으면 현재 상태를 먼저 쉽게 설명한다**(이 세션에서 실제로 났다 — 키바 매크로 질문)
7. 끝났다고 보고하기 전에 스스로 점검한다. 사용자가 *"e2e 한다는건 모든 구현 완료된거야? 확실해?"* 라고 물었다 — 끝난 것·안 한 것·한계를 정직하게 나눠 답했다

## 1. 어디까지 왔나

| 커밋 | 내용 | 푸시 |
|---|---|---|
| `769a27c5` … `02aaee58` | 4묶음 · 5묶음 · 채팅 창 (`UX_6_HANDOFF.md` 1절) | 안 됨 |
| `a501bf41` | 6묶음 스펙·5차 인계 | 안 됨 |
| `cfba2114` | **6묶음** — diff 도구 줄 고스트·모바일 한 줄 `⋯`, LSP 제안 한 번 + 상태바 `LSP` 표식, 메뉴 키캡 (FR-UXF-80~85) | 안 됨 |
| **(커밋 안 함, 작업 트리)** | **6.5묶음** — 아래 넷 + 7묶음 스펙 | — |

### 6.5묶음 (작업 트리에 있다, 구현 끝, 단위 1122·게이트·타입 통과)

사용자가 7묶음 도중에 넣은 지시 넷이다. SRS 는 `UX_AUDIT_FIX_SRS.md` 에 있다.

| 일 | 스펙 | 결정 | 상태 |
|---|---|---|---|
| 패널 탭: 좁으면 아이콘만, 넓으면 아이콘 + 라벨(두 패널 여섯 탭) | §3.12 FR-UXF-98·99, TC-UXF-96·97 | D-35 | 구현 끝. `UIKit.tabsFit`/`tabsFitWatch`(ui-kit.js), `style-panel.css` `.ui-panel-tabs.labeled`. 기본 폭은 아이콘만(사용자 확인 — 메인 200px 은 `저장소` 가 6px 모자람, ~220px 부터 라벨; 작업 260px 은 ~340px 부터) |
| 아이콘 통일 — 문자 아이콘·16×16 SVG 를 스프라이트로 | §3.13 FR-UXF-100~102, TC-UXF-98·99 | D-36 | 구현 끝. 새 심볼 6(`app-window`·`file-plus`·`folder-plus`·`link`·`triangle-alert`·`corner-down-right`), `UIKit.caret`, 게이트 `web/js/test/icon-glyph.test.mjs`. CSS `content` 꺾쇠는 `--ui-chev-*` 마스크(style-kit.css) |
| 작업 패널 순서 결함("배치가 계속 바뀐다") | §3.14 FR-UXF-110~112, TC-UXF-110~112 | D-37 (FR-UXF-12 철회) | 구현 끝. `_agentOrderSync` 가 저장 순서를 지우지 않고 새 id 를 사전순(UUID v7=생성순)으로 붙인다. 대기 끌어올리기 제거. `web/js/test/agents-order.test.mjs` |
| 레일 접기 단추 맨 위 | FR-UXF-31 개정, TC-UXF-31b | D-38 | 구현 끝. `style-panel.css` 레일 `.ui-panel-acts{order:-1}`. 메인 패널 접기 단추 `size:'lg'` 를 빼 작업 패널과 같은 크기로(두 레일의 탭 선이 4px 어긋났다) |

**6.5묶음에서 아직 하지 않은 것**: 관련 e2e 전체(도중에 사용자 지시로 멈췄다 — 앞선 회차들에서 개별로는 통과), 화면 확인(바뀐 아이콘을 실제 화면으로 못 봤다), V-LAY-1 기준선(접기 단추 클래스 `ui-btn-lg` 가 빠졌으니 다시 떠야 할 가능성이 크다).
개정한 기존 시험(이전/새/이유 주석 있음): `explorer-transfer-ignore`·`file-transfer`(`.ed-tw` 의 `data-open="1"`), `runs.spec` 334, `activity.spec` 584, `sidebar-collapse` SBC7, `sidebar-tabs` T3, `ux-audit-fix` TC-UXF-11, 단위 `activity-state-subagent`·`agent-subagents`·`claude-accounts-foot`·`claude-accounts-settings`·`app-state-owners`(LSP), `harness.mjs`(가짜 원소 `prepend`).

## 2. 7묶음 — 받은 결정 전부 (다시 묻지 않는다)

`UX_AUDIT_FIX_SRS.md` §2.1 D-30~D-34, §3.11 이 정본이다. 요약:

- **M1 (D-30)**: 모바일 상태바 줄을 없앤다. 연결 = 상단바 `#window-name` 앞 점(`.m-conn-dot`, ok/err), cwd = `#window-name` 의 `title`, 새 판 = `#m-drawer-toggle` 의 점(`.m-update-dot`) + 서랍 바닥 `#sb-bottom` 의 `#m-update-link`(배지와 같은 글자·주소, `app-update.js` `_updateRender`)
  - 상태바가 없어지면 `style.css` 의 모바일 상태바 꺾쇠(`--ui-chev-up/down` 마스크, `sb-folded`·`sb-expanded`)와 `app-statusbar-fold.js` 의 모바일 접기가 죽은 코드가 된다 — 걷는다(시험 `TC-MUX-12` 등 개정)
- **M4·O7 (D-31)**: 설정 `터미널` 탭에 `모바일 키바` 구역. 키마다 켜기·끄기, 위·아래, `기본값으로`(순서·켜기만 되돌림, 매크로는 남김). `⌨` 는 맨 왼쪽 고정·구성 대상 아님. **매크로 = 키 조합 하나**(Ctrl·Alt·Shift 중 하나 이상 + 키), 라벨 자동(`^D`·`⌥B`·`^⇧↑`, 1~8자, 고칠 수 있음), 누르면 `^C` 처럼 sticky 를 거치지 않고 곧바로 보낸다. **서버 설정**(`/api/settings` 키 `keybar` — `settings-schema.js` 에 `{"key":"keybar","type":"object","def":{},"where":"Terminal ▸ 모바일 키바"}` 를 더하고 `SETTINGS_ACCESS` 에 같은 키를 둔다, TC-CFG-1 이 두 표를 대조한다). 바이트 표는 §3.11 FR-UXF-94(`mkbComboBytes`), 순서 규칙은 FR-UXF-93(`keybarResolve`), 기본 키 id 는 FR-UXF-93 의 18개 — `MKB_KEYS`(constants.js:156)에 `id` 필드를 더한다
  - 사용자가 처음 "글자+Enter" 식 매크로를 고르려 할 때 질문을 끊고 *"^C 같은건 ctrl+c 인거잖아. 이런식의 매크로를 말하는거야"* 라고 했다 — 매크로는 **키 조합**이다
- **M10 (D-32)**: 모바일 서랍 `#sb-panel-windows .sb-actions` 한 줄(`새 창`·`샌드박스`·`그룹`), 넘치면 말줄임, 높이 `--touch-min`
- **O6 (D-33)·D9 (D-34)**: 하지 않는다

## 3. 마지막에 한 번에 돌릴 관련 e2e (6.5 + 7묶음)

6.5묶음: `editor-explorer` `explorer-transfer-ignore` `file-transfer` `ux-batch10` `git-branches` `git-changes` `git-remote` `git-commit` `activity` `activity-rail` `runs` `sidebar-tabs` `sidebar-collapse` `doc-render` `claude-accounts` `sandbox-window` `ux-audit-fix-6` `ux-audit-fix` `editor-tab` `git-sidebar` `tooltips` `mobile-ux-overhaul` `panel-template` `panel-dock` `agent-card-focus` `kit-components`
7묶음: 새 시험(`ux-audit-fix-7.spec.ts` 등) + 상태바(`statusbar*`·`mobile-*`)·설정(`settings*`)·키바(`mobile-keybar*`·`mkb*`)를 grep 으로 찾는다. 앞선 회차 실패: `activity-rail` TC-ACF-1 은 전체 실행에서만 한 번 졌다(단독 통과).
V-LAY-1 은 **단독**으로(`--workers=1`) — 병렬이면 history 행 키가 흔들려 한 번 진다.

## 4. 먼저 읽을 것

1. `docs/internal/UX_AUDIT_FIX_SRS.md` — §2.1 D-30~D-38, **§3.11(7묶음)**, §3.12~3.14(6.5묶음), §3.10(6묶음)
2. `docs/internal/UX_REMAINING_2026-11-20.md` — 남은 일 정본(6차 세션 진행 표시가 있다. 6.5묶음은 아직 적지 않았다 — 커밋 때 더한다)
3. `docs/internal/UX_6_HANDOFF.md` 4·5·6절 — 값을 치르고 배운 것·규약·유효 결정(여전히 유효)

## 5. 값을 치르고 배운 것 (이 세션)

- **모듈 크기 게이트**: `file-tree-paint.js` 가 최대 기준선 975 에 붙어 있다 — 한 줄도 늘릴 수 없다(이 세션에서 975 로 맞췄다). `run-dashboard.js`(500)·`panel-diff.js`(499)도 500 경계다. 늘리면 줄을 합치거나 함수를 킷(`ui-kit.js`, 916)으로 옮긴다
- **e2e 는 `app.testing.<이름>` 만 쓴다**(게이트 FR-ATC-1) — `app._toggleSidebar()` 를 썼다가 졌다. 사이드바 접기는 `app.testing.setSidebarCollapsed(true)`
- **`UIKit` 은 `window` 에 없다**(`const`) — 임시 화면 시험에서 `window.UIKit` 은 undefined. 스프라이트는 `<svg><use href="#i-…">` 로 직접 그린다
- 임시 화면 시험 `e2e/zz-tmp-shot.spec.ts` 는 찍은 명령 안에서 지운다(TEST-16). 메뉴는 애니메이션 중에 찍히면 흐리다 — `document.getAnimations()` 의 `finished` 를 기다린다
- 단위 시험의 가짜 `UIKit` 들에 `icon` 이 없다 — 킷 아이콘을 쓰는 코드를 바꾸면 그 시험의 대역에 `icon: (n) => ({ className: 'ui-icon', icon: n, children: [] })` 를 더한다
- 상태 `data-*` 로 판정하라 — 표식을 아이콘으로 바꾸면 글자(`▾`) 단정이 깨진다(`UIKit.caret` 은 `data-open="1|0"`)
- `sidebar-list.js` `_sig` 의 구분자는 보이지 않는 `\x02` — 문자열 치환이 안 맞으면 `repr` 로 본다
- 도구 id 는 UUID v7 — 사전순이 생성순이다(`internal/shared/uuid/uuid.go:148`)
- 다른 패널 탭 폭 판정(`tabsFit`)은 라벨이 하나도 보이지 않으면(레일) `labeled` 를 달지 않는다 — 처음엔 달아서 기준선이 흔들렸다
- 바뀐 기본 동작을 사용자에게 보일 때는 **잰 숫자**(`저장소` 6px 모자람)와 스크린샷으로 묻는다 — 바로 고를 수 있었다

## 6. 변하지 않는 규약

`UX_5_HANDOFF.md` 5절 그대로: 스펙 → RED → 구현 → 게이트·단위·타입 → (마지막에) 관련 e2e → 화면 → 문서 개정 → 확인 뒤 커밋. 동작이 바뀌면 SRS·주석·기존 시험에 이전/새/이유. 커밋 메시지에 AI 서명 금지. 툴팁·`aria-label` 은 영어, 보이는 글자는 로케일. 모서리 토큰 넷, 글자 `--fs-*`. `features.md`·`CHANGELOG [Unreleased]`(6.5묶음 항목은 이미 썼다)·필요하면 `shortcuts.md` 를 함께. 결정 표를 바꾸면 `go run ./scripts/gen-decisions`. 새 SRS 머리에 `> **문서 상태**`·`> **남은 것**` 두 줄.

## 7. 아직 유효한 사용자 결정

- `UX_AUDIT_FIX_SRS` §2.1 **D-1~D-38 전부**(D-29 이후 이 세션: D-30~D-34 7묶음, D-35 패널 탭, D-36 아이콘 통일, D-37 순서·FR-UXF-12 철회, D-38 레일 단추 맨 위)
- 문자로 남긴 예외(FR-UXF-101): 탭 제목의 `●`(변경)·`◈`(렌더), 업로드 알림의 `✓`, 문장 속 `▸`·`→`·`·`. 사용자에게 "바꾸길 원하면 따로" 라고 알렸다 — 아직 답은 없다
- `CHAT_WINDOW_SRS` D-CW-1~6, `UX_3_HANDOFF.md` 6절, `FR-UIK-12`
- 금지(거절된 것): 하단 탭 내비(MOBILE D-2), 칸 스와이프(MOBILE D-5), discard 길게 누르기(D-3), 모바일 분할 단추 감춤(D-2), 설정 모달 높이 가변(D-23), 빈 상태 행동 단추(D-28), O6(D-33), D9(D-34), 키바 자동 빈도 정렬(D-31)

## 8. 문서·코드 어긋남 (모았다가 끝에 보고 — 사용자가 고른다)

`UX_REMAINING` §8 의 셋 + `architecture.md`·`sidebar-tabs.js` 머리 주석의 사이드바 탭 이름 + 이 세션의 하나: **FR-UXF-85 가 말한 "사이드바 창 행 메뉴" 는 코드에 없다**(§3.10 구현 메모에 적었다 — 창 행 메뉴를 새로 만들지 사용자에게 아직 묻지 않았다).
