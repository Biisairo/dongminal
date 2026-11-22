# 인계 — 프로덕션 리팩토링 3차: 프론트·백·데몬 전체

> 넘긴 날: 2026-11-21. 넘긴 세션: `UIUX-8차+리팩터`(UX_8_HANDOFF 의 일 — accent2 링 통일과 메인색 — 을 끝냈다). 사용자가 리팩토링은 새 세션에서 하겠다고 했다.

## 착수 블록 — 이번 세션의 지시 전부

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다. **main 은 origin 보다 앞서 있고 푸시 전이다** — 푸시·커밋은 사용자 확인 뒤에만 한다(사용자는 "커밋"·"커밋푸시" 처럼 말한다)
2. 아래 「사용자의 요청」 을 전부 읽는다. **범위는 사용자가 정했다: 프론트(web/js·css·html), 백(Go 서버 internal/webserver·domain 등), 데몬(daemon/dmctl 쪽 Go) 전부.** 범위를 다시 묻지 않는다
3. **같은 요청으로 한 감사가 두 번 있었다.** 먼저 읽는다:
   - `docs/internal/refactor/README.md` — 1차 전수 감사(2026-09-20, 기준 `ba13ec92`, 214건, 종결 `0a581c12`). 그 표의 `AUDIT-*.md` 다섯 장
   - `docs/internal/refactor/PROD2.md` — 2차(2026-11-05, 기준 `fed7ef0e`). 후보 10건 처리 기록. **#9·#10(git 작업 슬롯·stash 판정의 JS/Go 두 벌)은 처리 방식 미정으로 남았다** — 다시 묻는다
   - 두 감사와 그 뒤 SRS 들이 처리한 것은 다시 하지 않는다. 2차 기준 `fed7ef0e` 뒤로 **362커밋**이 쌓였다(`git log --oneline fed7ef0e..HEAD | wc -l`) — 그 변화분과, 2차가 "아직 분석하지 않았다" 고 적은 1차 이후 전체가 이번 대상이다
4. 순서: **조사 → 목록 문서(`docs/internal/refactor/PROD3.md`) → 사용자에게 목록을 보이고 진행 순서를 확인 → 진행.** 조사는 영역이 커서(프론트·백·데몬) 영역별로 나눠도 된다. 목록 문서에는 요청의 아홉 항목 분류를 그대로 쓰고, **성능 개선 후보**와 **「문서·기록에는 있으나 미구현·미흡·잘못 구현」** 은 따로 모은 절로 둔다(요청의 마지막 두 항목)
5. 수정은 사내 규정대로: 중·대 규모는 SRS(IEEE 29148) → 시험(RED, 옛 코드에서 실패 확인) → 구현. 소규모는 작업 이해·가정·검증 계획을 말한 뒤 바로. 갈림길은 하나씩, 선택지마다 결과를 풀어 쓰고 권장안을 첫 번째로. **사용자가 질문 도중 되물으면 지금 상태를 먼저 쉽게 설명한다**
6. 끝났다고 보고하기 전에 스스로 점검한다(끝난 것·안 한 것·한계를 나눈다)

## 사용자의 요청 (원문)

> 리팩토링은 프론트, 백, 데몬 전부 진행할거야.
>
> 하드코딩 제거
> 중복로직 제거
> 상수 분리
> 쓸데없는 복잡한 로직 단순화
> 너무 큰 함수, 클래스 분할
> 충분한 추상화
> 비슷한 로직 모아서 하나의 클래스로 전환
> 사람의 가독성을 고려한 코드로 수정
> 성능상 개선이 가능한 부분은 모아놨다가 한번에 처리할 수 있게 분석하면서 정리해줘.
> 문서, 기록에는 있으나 구현이 되지않았거나 구현이 미흡하거나, 구현이 잘못된 경우도 정리해줘.
> 모든 과정은 제품을 프로덕선 레벨로 올리기 위함이야.

## 1. 어디까지 왔나

| 커밋 | 내용 | 푸시 |
|---|---|---|
| `690e4b92` | 두 패널 탭의 같은 동작(UX_AUDIT_FIX_SRS §3.15, D-41) | 안 됨 |
| `5277ebdb` | 8차 인계 문서 `UX_8_HANDOFF.md` | 안 됨 |
| `4a29a599` | 실행 중 색 `accent2`(테마 슬롯, 54종 명시값 — 5종은 손으로), 사이드바 작업 표식을 선택 점 링으로, 실행 중 색 통일 (§3.16, D-42~44) | 안 됨 |
| `c037c793` | 메인색(`THEME_SEED_COLOR_SRS`) — OKLCH 색상 회전·의미색 15° 조화, 설정 ▸ 테마 맨 위 행, `accent2` 파생은 3:1 까지 끌어올림(FR-UXF-126 개정) | 안 됨 |

UX 쪽(`UX_REMAINING_2026-11-20.md`)에서 남은 것: §5 리팩터링 후보(이번 일의 출발점 일부), §6 검증·운영, §7 받아들인 한계(사용자에게 다시 보이고 바꿀지 묻기 — 아직 안 함), §8 문서·코드 어긋남.

## 2. 리팩터 후보로 이미 알려진 것 (조사의 출발점, 확인 전)

- `UX_REMAINING_2026-11-20.md` §5 전부: `app-agents.js` `agentsRender` 의 `reconcileList` 세 번, 파일마다 따로 있는 DOM 헬퍼(`actEl`·`chatEl`·`runDiv`), 레일 상태 선택자 반복(`style-panel.css`·`style.css`), Activity 레일 숨김 목록, 모바일 판정·시트 닫기 경로가 `app-mobile*.js` 셋에 흩어짐, 큰 파일·px·ms 리터럴
- `refactor/PROD2.md` #9·#10(JS/Go 두 벌 규칙, 처리 방식 미정)
- `app-settings.js` 가 모듈 크기 게이트 경계(500줄)에 붙어 있다 — 이번 세션에서 줄을 짜내 겨우 넣었다. 나눌 후보
- `pickAttnColor`(plain RGB 제곱 거리)와 `colorDistance`(redmean)가 색 거리 계산 두 벌이다(`web/js/core/theme-vars.js`·`contrast.js`)

## 3. 보고할 것으로 모아 둔 것 (목록 문서의 「미구현·미흡·잘못」 절에 넣는다)

- `UIUX_OVERHAUL_SRS` FR-SEM-1 이 "working 은 green" 이라고 적었다 — D-43 으로 `--accent2` 가 됐다(CSS 주석에는 이전/새/이유가 있다, 본문은 안 고쳤다)
- `UX_7_HANDOFF.md` 8절의 넷: `UX_REMAINING` §8 의 셋(`check-i18n-html.mjs` 머리 주석, `shortcuts.md` 의 "저장소·Editor 행", `DESIGN_TOKENS_SRS` 의 `--z-sticky` 표) + `architecture.md`·`sidebar-tabs.js` 머리 주석의 사이드바 탭 이름 + FR-UXF-85 의 "사이드바 창 행 메뉴"(코드에 없다)
- **원래부터 있던 e2e 실패**: `git-ui-metrics.spec.ts` V80 — 사이드바 접기 단추(`sb-collapse`) 높이 26px 가 하한 미달. HEAD 에서도 실패함을 확인했다
- **흔들리는 유닛 시험 하나**: `npm run -s unit` 이 열 번에 두 번꼴로 1건 실패하고 다시 돌리면 통과한다. 어느 시험인지 못 잡았다(실패한 회차의 로그를 남기지 않았다 — 다음엔 `> log` 로 남긴다)
- `UX_REMAINING` §6: V-LAY-1 의 `linux`·`win32` 기준선은 사용자가 `layout-baseline` 워크플로를 돌려야 한다. 이번에 `darwin` 기준선만 다시 썼다(메인색 행 추가). `settings.spec.ts` 전량 flaky 1건 원인 미조사

## 4. 이 세션들이 값을 치르고 배운 것

- **바뀐 동작을 시험이 정말 재는지 옛 코드로 확인한다**: `git stash push -q -u -- web <새 시험 파일>` → 시험(실패해야 한다) → `git stash pop -q`. 같은 명령 안에서 pop 한다
- 원래부터 있던 실패인지 가릴 때도 같은 stash 로 HEAD 에서 돌린다(V80 이 그렇게 드러났다)
- **e2e 를 백그라운드로 돌릴 때 출력을 요약 줄만 남기게 거르지 않는다** — 실패 이름을 잃는다. 잃었으면 `npx playwright test --last-failed`
- **`settings-schema.js` 에 키를 더하면** Go `internal/shared/settingsschema/schema_test.go` 의 개수(지금 34)와 `SETTINGS_ACCESS` 키 집합 대조가 함께 걸린다. **Go 시험은 `SETTINGS_ACCESS` 를 줄 단위로 읽는다** — 두 항목을 한 줄에 합치면 하나를 놓친다
- 문자열 설정은 기본값 `null` 선례가 없다 — 끔은 `""`
- `const` 최상위 이름(`THEMES`·`customTheme` 의 `var` 아닌 것)은 `window` 속성이 아니다 — e2e 는 문자열 평가(`page.evaluate("THEMES[...]")`)로 읽는다. 함수 선언·`var` 는 `window` 에 있다
- 유닛 `harness.mjs` 의 `load` 는 vm 컨텍스트라 객체 원형이 다르다 — `deepEqual` 대신 `JSON.stringify` 로 비교
- 킷 게이트: `createElement('button')` 뒤 3줄 안에 `ui-btn…` 등급 클래스가 있어야 한다(FR-KIT-21)
- V-LAY-1 은 **단독**(`--workers=1`). 새 요소가 생기면 "지금에만 N" 으로 실패한다 — 의도한 차이면 `LAYOUT_BASELINE=write` 로 다시 뜨고 다시 대조, 기준선 diff 가 그 요소뿐인지 본다
- 결정 표·SRS 를 바꾸면 `go run ./scripts/gen-decisions` (게이트가 잡는다)
- 모듈 크기 게이트: `app-settings.js` 500(지금 500), `file-tree-paint.js`·`app-layout.js` 975
- zsh 는 따옴표 없는 변수를 단어로 나누지 않는다 — `${=files}`
- 중단된 도구 호출도 일부 실행됐을 수 있다 — 끊긴 뒤에는 `git diff` 로 본다
- `dmctl`·화면 시험은 `app.testing.<이름>` 만(FR-ATC-1). `ui/`·`git/` 에서 App 의 `_` 이름을 부르면 계층 게이트가 막는다
- 다시 그리기 등록부: `innerHTML=''` 꼴은 `PERFORMANCE_BUDGET.md` §2-5-1 표에 올린다
- `activity-rail` TC-ACF-1·`editor-ops` O7 은 전체 실행에서만 가끔 진다(받아들인 흔들림)

## 5. 변하지 않는 규약

스펙(IEEE 29148) → 시험(RED) → 구현 → `make gates`·`npm run -s unit`·`npm run -s typecheck`·(Go 를 고쳤으면) `go test ./...` → 관련 e2e → 화면 확인(임시 시험 `e2e/zz-tmp-*.spec.ts` 는 같은 명령 안에서 지운다) → 문서 개정(`features.md`·`CHANGELOG [Unreleased]`·필요하면 `shortcuts.md`) → 커밋 미리보기 → 사용자 확인 뒤 커밋. 동작이 바뀌면 SRS·주석·기존 시험에 이전/새/이유. 커밋 메시지에 AI 서명 금지. 툴팁·`aria-label` 은 영어, 보이는 글자는 로케일. 모서리 토큰 넷, 글자 `--fs-*`, 하드코딩 색 금지(게이트). 문서와 코드가 충돌하면 코드를 우선하고, 어긋남은 모아 두었다가 끝에 보고해 사용자가 고르게 한다.

## 6. 아직 유효한 사용자 결정

- `UX_AUDIT_FIX_SRS` §2.1 **D-1~D-44 전부**(D-42 는 accent2 하나만, accent3~5 는 만들지 않음), FR-UXF-126 개정(파생 accent2 는 3:1 까지 끌어올림, 사용자가 고른 값은 그대로)
- `THEME_SEED_COLOR_SRS` D-SEED-1~6
- `ISSUE_AGENT_TREE_SRS` FR-WGR-24 개정(2026-11-20), 키바 설정 `keybar`(D-31)
- 금지(거절된 것): `UX_7_HANDOFF.md` 7절 목록 + O3·O5(D-39·D-40) + 에이전트 실행 중 색에 `--term-green`
