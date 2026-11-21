# 인계 — 프로덕션 리팩토링 3차 (둘째 세션): P3a 단계 3~9 부터 끝까지

> 넘긴 날: 2026-11-21. 넘긴 세션: `리팩터-3차`(첫 세션). 맥락 51% 에서 넘겼다. 첫 세션의 착수 문서는 `REFACTOR_PROD3_HANDOFF.md` 다.

## 착수 블록 — 이번 세션의 지시 전부

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다. **main 은 origin 보다 앞서 있고 푸시 전이다. 푸시는 사용자 확인 뒤에만 한다.**
2. **사용자 지시(유효): "하나씩 완료되면 커밋해. 알아서 끝까지 진행해."** 묶음·단계가 끝날 때마다 묻지 않고 커밋한다(AI 서명 금지). 묶음 사이에는 간단한 시험만 돌리고, **전체 시험(e2e 전량 포함)은 모든 묶음이 끝난 뒤 한 번** 돌린다.
3. 먼저 읽는다:
   - `docs/internal/refactor/PROD3.md` — 목록 전체. §6 결정 Q1~Q7, §7 진행 순서와 §7.1 진행 기록
   - `docs/internal/refactor/FE_OBJECT_MODEL.md` — **프론트 클래스 계층 설계(사용자 확정)**. §3 계층, §4 파일 배치, §5 로드, §6 단계
   - `docs/internal/REFACTOR3_FE_BASE_SRS.md` §5·§6 — 단계 0~2 에서 한 것과 남긴 것
   - `docs/internal/REFACTOR3_GO_STRUCT_SRS.md` §6 — Go 쪽에서 남긴 것(FR-RGS-1)
4. 남은 일을 아래 「2. 남은 일과 순서」 대로 한다. 끝나면 「3. 마지막에 할 것」 을 한다.
5. 수정 규약: 중·대 규모는 SRS(IEEE 29148) → 시험(RED, 옛 코드에서 실패 확인) → 구현. 갈림길은 사용자에게 하나씩 묻고 권장안을 첫째로 둔다. 사용자가 질문 도중에 되물으면 지금 상태부터 쉽게 설명한다.

## 1. 어디까지 왔나

| 묶음 | 커밋 | 내용 |
|---|---|---|
| 조사 | `08922b9b` 에 포함 | `refactor/PROD3.md` 목록(영역 여섯의 조사, 결함 15·후보 약 130·성능 14·문서 약 20) |
| P1 결함 | `08922b9b` | `REFACTOR3_DEFECTS_SRS` — 결함 아홉(테마 값 XSS, ReapTargets 레이스, 같은 표식 저장 경합, 상한 초과 코드, 텔레그램 잠금, FetchNow 중복, dmctl edit 종료 코드, chatsock Cf, 서랍 아이콘) |
| P2 Go 중복 | `56dffed0` · `d94b16bd` · `a0372852` · `994d9805` (합침 `cef773f3`), 문서 `43bf4c1b` | `REFACTOR3_DEDUP_GO_SRS` — 오류 렌더러·디코더 한 벌(`httpresp.Fail`·`httpreq.DecodeJSON`), dmctl `httpExit`·`parseRefusal`·`fetchState`, `shared/termtext`·`apipath` 이전 단계, 도메인 쌍둥이 |
| P3a 설계 | `177973be` | `FE_OBJECT_MODEL.md` 확정 — `Component` → `View`(화면 부품 전부) / `Controller`(App 주제별 조정자), App 은 조립자, **클래스 하나 = 파일 하나**, 외부 프레임워크 없음 |
| P3a 단계 0·1 | `6a30fc80` | `domEl`·`svgEl`, 죽은 함수, `tabsFitWatch`·`roving` 해제 함수, `web/js/core/base/`(component·view·controller·escape-stack·scroll-memo·badge), `web/embed.go` 에 `js/core/base/*.js` |
| P3a 단계 2 | `d8b92b63`, 문서 `9c4390cc` | `Panel`·`TabBar` → `SidebarPanel`·`ActivityPanel`·`DrawerSheet`·`SidebarTabBar`·`ActivityTabBar`. 라벨 판정은 `TabBar.fit()` 한 자리. App 메서드·`SidebarTabs` 는 위임자 |
| Go P4·P5·P6 | SH `b429a39a`…`6cb999d1` · SD `8c2cc91d`·`7d7891f8`·`cd12d4cb` · SC `d60365c6`…`c2389f95` (합침 `b13406a3`·`9ab7c188`·`1af24478`), 문서 `469f5709` | `REFACTOR3_GO_STRUCT_SRS` — 큰 파일·`Server` 구조체 분할, 성능(전후 수치는 그 SRS §4·§6), `apipath`, 시간 예산. **남은 것: FR-RGS-1** |

검증(마지막 합침 뒤): `gofmt` 0 · `go vet ./...` · `go test ./...` · `make gates` · `npm run -s unit`(1190) 통과. e2e 는 단계별 관련 spec 만 돌렸다(전량은 아직).

## 2. 남은 일과 순서

| # | 일 | 근거 | 비고 |
|---|---|---|---|
| 1 | **P3a 단계 3 `Dialog`** — `GitModalBase` 를 일반화, `GitConfirm`·`GitDialog` 이름 유지하고 상속만 바꿈, 손으로 짠 모달(`term-pane.js:600`·`app-claude-accounts.js:427`)·`UIKit.modal` 호출처 이주 | FE_OBJECT_MODEL §6 단계 3 | SRS 새로 |
| 2 | 단계 4 `ListView` — `SidebarList`·`GitListTab` | 단계 4 | |
| 3 | 단계 5 `GitView` — git 탭 여섯, 세대 가드 정책 하나로 먼저 | 단계 5 | |
| 4 | 단계 6 `Menu`·`EscapeStack` 으로 Esc 처리 15파일(FC-13·14). **단계 2 가 EscapeStack 에 패널을 등록하지 않았다** — 모바일 `app-mobile-sheets.js:44` 의 Esc 처리기와 같은 버블에서 두 번 반응하고, 데스크톱 작업 패널은 지금 Esc 로 안 닫힌다(INV-F3). 여기서 순서를 정해 등록한다 | 단계 6 | |
| 5 | 단계 7 git 패널 mixin 6~8파일 → 클래스(`GitChanges` 외). 위험 H(접근자 getter 가 Object.assign 으로 굳는 문제, `git/panel.js` 주석) | 단계 7 | |
| 6 | 단계 8 설정 섹션·행(`core/app-settings*.js` 14파일) | 단계 8 | 위험 H |
| 7 | 단계 9 App mixin 68파일 → 주제별 `Controller`. 위임자는 e2e·다른 파일이 새 경로로 옮겨 간 뒤에만 지운다 | 단계 9 | 위험 H, 가장 큼 |
| 8 | PROD3 의 나머지 FE 항목: FC-03(색 거리 redmean 통일 — Q1 결정, 알림색 바뀌는 테마를 SRS 에), FC-11(자동 전환 범위 서버 원천), FU-17(서브모듈 stage 금지 server-driven — Q3 결정, Go gitapi 도), FU-8·9(레일 선택자 `data-rail`·숨김 목록 — `DOC-15` 죽은 선택자 포함), FU-10(간격 토큰 821건, 크기 L), FU-11(CSS 크기 게이트), FC-04~10·12·13·15~22, FU-12~16·18·19 — 대부분 위 단계에 흡수되므로 단계마다 PROD3 ID 를 지우며 간다 | PROD3 §2 | |
| 9 | Go **FR-RGS-1** — 80줄 넘는 처리기 20개(`apiRunSucceed`·`handleCommandSSE`·`handleCommandPost`·`apiGitStatus`·`server.New`·`apiFileWrite` + 표본 14)를 파싱·판정·렌더로, 판정 순수 함수 단위 시험. 나눌 때마다 httpapi `go test -v` PASS 1049 이름 목록과 대조(기준 파일 사본 `/tmp/prod3/sh-httpapi-pass-baseline.txt` — 없으면 지금 다시 뽑는다) | GO_STRUCT_SRS FR-RGS-1 | |
| 10 | **P7 문서 동기화** — Q6 결정: 전부 코드 기준으로 고친다. PROD3 §4.2 DOC-1~20 + 아래 「4. 모아 둔 문서 어긋남」. 게이트 사각지대(§4.3)도 가능한 것은 게이트로 | PROD3 §4 | |
| 11 | **P8** — `UX_REMAINING_2026-11-20.md` §7 받아들인 한계 다섯을 사용자에게 하나씩 다시 묻는다(Q7 결정: 다시 본다) | PROD3 §7 | 사용자 질문 |

## 3. 마지막에 할 것

1. 전체 시험: `make gates` · `npm run -s unit` · `npm run -s typecheck` · `go test -race -shuffle=on ./...` · `make lint` · **e2e 전량**(`make e2e`, 샤드 요약에서 `N failed` 를 직접 센다 — 종료 코드를 믿지 않는다). 원래부터 있던 실패: `git-ui-metrics.spec.ts` V80(접기 단추 26px). 흔들림으로 받아들인 것: `activity-rail` TC-ACF-1·`editor-ops` O7·`settings.spec.ts` 이름 거절·`ux-audit-fix-7` TC-UXF-94, Go `gitapi` `TestWorktreeCreateInputAnswer`(임시 폴더 정리 `directory not empty`). V-LAY-1 은 단독(`--workers=1`)
2. `CHANGELOG.md [Unreleased]` 정리 — 같은 절 안에서 서로 뒤집는 항목 4쌍(DOC-12)을 최종 동작 기준으로 합친다
3. 끝난 것·안 한 것·한계를 나눠 사용자에게 보고하고, 푸시할지 묻는다

## 4. 모아 둔 문서 어긋남 (P7 에서 코드 기준으로 고친다)

- `OPTIMIZE_REFACTOR_SRS.md:265` 개정 메모의 `ensureDir` → `ensureRoot`(56dffed0)
- `docs/internal/README.md` 색인의 `SERVER_DRIVEN_ACTIONS_SRS` 라벨 "승인·구현중" ↔ 문서 머리 "승인·구현완료"
- `WORKSPACE_IDENTITY_SRS.md:159` `shortCodeOf` → `workspace.ShortCode`
- `PEER_DAEMON_SRS.md:194` `printRefusal` → `printCodeRefusal`
- `PERFORMANCE_HARDENING_SRS.md:302·396` `isBinary` 자리 → `handlers_file_probe.go`
- `architecture.md:502` · `UI_KIT_SRS.md:407` — 탭을 만드는 자리는 이제 `SidebarTabBar`(`SidebarTabs` 는 위임자)
- `SAFETY_CORRECTNESS_SRS.md:205-218` 의 `body_too_big` 오기
- PROD3 §4.2 의 DOC-1~20 전부

## 5. 사용자에게 아직 묻지 않은 것·답을 기다리는 것

- **FU-20:** 사용자가 "두 패널 상단 탭의 글자 표시가 따로 움직인다" 고 했다. 단계 2 가 판정 경로를 `TabBar.fit()` 하나로 모았지만, 바꾸기 전에도 판정 결과의 차이를 실측으로 재현하지 못했다(임시 e2e 로 사건별 낡은 판정 0건). 첫 세션이 "다시 보이면 어느 화면·조작인지 알려 달라" 고 사용자에게 말했다. 답이 오면 그 조건으로 재현한다
- `UIKit.tabsFitWatch` 는 앱 안 호출이 0 이 됐다(`TabBar` 가 직접 관측). 지울지는 단계 3 이후 UIKit 흡수 때 정한다(FR-FEB-3·TC-FEB-2 가 남겨 두라고 한 것 — SRS 를 고쳐 지우는 것이 자연스럽다)

## 6. 이 세션이 값을 치르고 배운 것

- **디스크가 가득 찼다(남은 1.5 GiB).** Go 빌드 캐시가 17 GB 였고 병렬 작업 트리 셋이 빌드·시험을 돌려 쌓였다. `go clean -cache` 로 비웠다(사용자 결정 없이 했다 — 순수 캐시라 다시 만들어진다. 보고에 적었다). **병렬 작업 트리를 띄우기 전에 `df -h /System/Volumes/Data` 를 본다.** 측정 시험은 메모리 안에서, 작은 규모로만 — 수만 번 디스크에 저장하는 측정이 볼륨을 채웠을 수 있다
- **격리 작업 트리(`isolation: worktree`)가 main HEAD 가 아니라 오래된 커밋(`097d6a73`)에서 시작한 일이 있다.** 에이전트 지시의 첫 줄에 "HEAD 를 보고 SRS 가 없으면 `git merge --ff-only main` 으로 감아라" 를 넣는다
- 병렬 에이전트가 main 트리에서 일하는 동안 문서를 커밋할 때는 `git commit -- <경로>` 로 자기 파일만 담는다
- 다른 작업 트리의 gofmt 위반이 `make gates` 첫 단계(`gofmt -l .` 가 `.claude/worktrees` 를 읽는다)를 깨뜨린다 — 작업 트리를 정리한 뒤 게이트를 돈다
- 단계 2 에이전트의 실측: "보이는 차이" 를 주장하기 전에 사건별 판정 결과를 세는 임시 e2e(`e2e/zz-tmp-*.spec.ts`, 같은 명령 안에서 지운다)로 확인한다
- 구현 에이전트에게 맡길 때 SRS 를 먼저 커밋하고, 브리프에 자리(file:line)·불변 조건·규약(킷·계층·크기·embed·harness)을 적어 주면 되묻지 않고 끝까지 간다. 묶음 밖 변경과 SRS 와 다르게 한 것을 보고하게 하면 SRS 정정을 놓치지 않는다
- 첫 인계서의 배운 것 목록(`REFACTOR_PROD3_HANDOFF.md` §4)은 그대로 유효하다

## 7. 변하지 않는 규약

`REFACTOR_PROD3_HANDOFF.md` §5 와 같다: 스펙(IEEE 29148) → 시험(RED) → 구현 → 게이트·단위·typecheck·(Go)`go test` → 관련 e2e → 문서 개정(`features.md`·`CHANGELOG [Unreleased]`·필요하면 `shortcuts.md`) → 커밋. 동작이 바뀌면 SRS·주석·기존 시험에 이전/새/이유. 툴팁·`aria-label` 은 영어, 보이는 글자는 로케일. 하드코딩 색 금지. 문서와 코드가 충돌하면 코드를 우선한다. 결정 표·SRS 를 바꾸면 `go run ./scripts/gen-decisions`. 새 SRS 는 `docs/internal/README.md` 색인에 넣는다.

## 8. 아직 유효한 사용자 결정

- PROD3 §6: Q1 색 거리 redmean 통일 · Q2 검색도 UTF-16 BOM 을 텍스트로(적용됨) · Q3 서브모듈 stage 금지 server-driven · Q4 workspace 순회 shared 로(적용됨) · Q5 FR-UXF-85 에서 「사이드바 창 행 메뉴」 를 지운다 · Q6 문서는 전부 코드 기준 · Q7 받아들인 한계 다섯을 다시 본다
- FU-20: 라벨 표시 규칙은 패널별, 판정 경로는 한 자리
- 프론트: 다른 프레임워크처럼 클래스로 만들고 상속받아 나눠 쓰고 다시 쓰는 구조, 클래스 하나 = 파일 하나, `Component` → `View`/`Controller`, 0~9 단계 전부
- 진행: 묶음마다 커밋, 끝까지 묻지 않고 진행, 전체 시험은 마지막에 한 번, 푸시는 사용자 확인 뒤
- `REFACTOR_PROD3_HANDOFF.md` §6 의 결정 전부(UX D-1~D-44 등)
