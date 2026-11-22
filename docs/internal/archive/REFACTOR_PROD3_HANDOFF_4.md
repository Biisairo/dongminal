# 인계 — 프로덕션 리팩토링 3차 (넷째 세션): P3a 이후의 남은 일과 마무리

> 넘긴 날: 2026-11-21. 넘긴 세션: `리팩터-3차-3`(셋째 세션). P3a 단계 5~9 를 끝내고 넘겼다. 앞 인계서는 `REFACTOR_PROD3_HANDOFF_3.md`·`_2.md`·`REFACTOR_PROD3_HANDOFF.md` 다. **앞 문서들의 배운 것·규약·결정(HANDOFF_2 §6·§7·§8, HANDOFF_3 §4)은 그대로 유효하다** — 이 문서는 거기에 더한 것만 적는다.

## 착수 블록 — 이번 세션의 지시 전부

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다. **main 은 origin 보다 앞서 있고 푸시 전이다. 푸시는 사용자 확인 뒤에만 한다.**
2. **사용자 지시(유효): "하나씩 완료되면 커밋해. 알아서 끝까지 진행해."** 큰 일은 "이슈를 나눠서 진행" 한다(셋째 세션의 사용자 답 — 범위를 줄이지 말고 하위 이슈로 나눈다). 묶음 사이에는 간단한 시험(단위·typecheck·게이트·관련 e2e)만, **전체 시험(e2e 전량)은 모든 묶음이 끝난 뒤 한 번**.
3. 먼저 읽는다: `REFACTOR_PROD3_HANDOFF_2.md` §2(남은 일 8~11번)·§3(마지막에 할 것)·§4(문서 어긋남)·§5(묻지 않은 것) · `REFACTOR_PROD3_HANDOFF_3.md` §4·§5 · `docs/internal/refactor/PROD3.md` §2(FE 항목 ID)·§7.1 진행 기록 · 이 문서 §3·§4.
4. 남은 일을 아래 「2」 순서대로 한다. 끝나면 `HANDOFF_2.md` §3 「마지막에 할 것」.
5. 규약: 중·대 규모는 SRS(IEEE 29148) → 시험(RED) → 구현. 코드·설계 문서로 답이 나오는 갈림길은 권장안으로 정하고 SRS 결정 표(D-*)에 이유를 적는다. **사용자가 이미 정한 범위를 줄여야 할 때는 묻는다.**

## 1. 어디까지 왔나 (셋째 세션)

| 묶음 | SRS | 커밋 |
|---|---|---|
| P3a 5 `GitView` | `REFACTOR3_FE_GITVIEW_SRS` | `b8989b38` · `d60b5e44` |
| P3a 6 `Menu`·`EscapeStack` 두 층 (FC-13·14) | `REFACTOR3_FE_ESC_SRS` | `84affef7` · `8a81f81d` |
| P3a 7 git 패널 mixin → 부품 11 | `REFACTOR3_FE_GITPANEL_SRS` | `7081f55c` · `2f29a3a8`…`8304ddc3` |
| P3a 8 설정 섹션·행·`SettingsController` (FC-04) | `REFACTOR3_FE_SETTINGS_SRS` | `e3138d51` · `9afbb9fe`…`02293a32` |
| P3a 9 App mixin 57 → 주제별 Controller (9a~9k) | `REFACTOR3_FE_APPCTL_SRS` | `71e9f3d4` · `b0e3b411`…`9959fff4` |

결과: `Object.assign(App.prototype` · `Object.assign(GitPanel.prototype` 가 코드에서 0. 500줄 초과 파일 17 → 12. 단위 1203 → 1365 통과. typecheck·`make gates` 통과, eslint 는 원래 2건(theme-vars.js `t` 가림, claude-accounts-foot.test.mjs 미사용 변수). e2e 는 묶음마다 관련 spec 만 돌렸다(전량은 아직).

## 2. 남은 일과 순서

| # | 일 | 근거 | 비고 |
|---|---|---|---|
| 1 | **PROD3 의 나머지 FE 항목** — FC-03(색 거리 redmean 통일, Q1 결정 — 알림색이 바뀌는 테마를 SRS 에), FC-11(자동 전환 범위 서버 원천), FU-17(서브모듈 stage 금지 server-driven, Q3 — Go gitapi 도), FU-8·9(레일 선택자 `data-rail`·숨김 목록, `DOC-15`), FU-10(간격 토큰 821건, 크기 L), FU-11(CSS 크기 게이트), FC-05~10·12·15~22, FU-13~16·18·19. **P3a 가 흡수한 것부터 지운다**: §7.1 의 P3a 3~9 행과 각 SRS 를 보고 처리된 ID 에 「처리함」(FC-04 방식) | `PROD3.md` §2 | 하위 이슈로 나눈다 |
| 2 | Go **FR-RGS-1** — 80줄 넘는 처리기 20개를 파싱·판정·렌더로, 판정 순수 함수 단위 시험. httpapi `go test -v` PASS 이름 목록과 대조(`/tmp/prod3/sh-httpapi-pass-baseline.txt` — 없으면 지금 다시 뽑는다) | `REFACTOR3_GO_STRUCT_SRS` FR-RGS-1 | |
| 3 | **P7 문서 동기화** — Q6: 전부 코드 기준. PROD3 §4.2 DOC-1~20 + HANDOFF_2 §4 + HANDOFF_3 §5 + 이 문서 §4 | `PROD3.md` §4 | |
| 4 | **P8** — `UX_REMAINING_2026-11-20.md` §7 받아들인 한계 다섯을 사용자에게 하나씩 다시 묻는다(Q7) | | 사용자 질문 |
| 5 | 이 문서 §3 의 「찾은 결함」 을 사용자에게 보고하고 고칠지 묻는다 | | 사용자 질문 |
| 6 | `HANDOFF_2.md` §3 마지막에 할 것(전체 시험·CHANGELOG 정리·보고·푸시 질문) | | |

## 3. 찾은 결함 (리팩토링 중 발견, 동작을 바꾸지 않으려고 고치지 않음 — 보고 대상)

- 설정 statusbar 탭의 행은 설정을 열 때·다른 창의 변경을 받을 때 다시 칠해지지 않는다(생성 1회) — `REFACTOR3_FE_SETTINGS_SRS` §6
- 숫자 설정 행(`uiFontSize`·`termFontSize`·`migrationHookCtxPct`·`issueTreeCtxPct`·`claudeScrollSpeed`)이 포커스된 입력란을 가드 없이 덮을 수 있다(정적 추정, 실측 필요)
- `_settingsOnTab` 의 옛 주석과 달리 설정을 열 때 access·sandbox·edges·telegram·server 를 다시 읽지 않는다
- 부팅 적용(`main.js:20` `_settingsApply`)과 `initModal` 사이 순서가 코드로 보장되지 않는다(null 가드로 버틴다)
- 계약 `core/app-testing.js` 의 `_gitJobChip`·`_focusCh` 는 App 에 없는 이름이다(시험에 알려진 예외로 고정)
- 호출하는 곳 없는 `_gitAddRepo`·`_gitReorder`(`core/git-sync.js`) — 지울지 사용자 결정
- 게이트 구멍: `scripts/check-e2e-private.sh` 가 `<별칭>.app._x` 를 못 잡는다(`e2e/workspace-resync.spec.ts` 의 `w.app._onWorkspaceChanged` 7곳)

## 4. 이 세션이 값을 치르고 배운 것

- **구현은 에이전트에게, 주 세션은 SRS·검증·커밋 정리.** 큰 단계는 먼저 읽기 전용 분석 에이전트(acorn 으로 `this.X`·호출 그래프·필드 소유를 센다)를 돌려 경계를 실측하고 SRS 를 쓴 뒤, 구현 에이전트 하나에 하위 이슈 3개씩 맡겨 이슈마다 커밋하게 했다. 브리프에 앞 에이전트가 보고한 함정을 그대로 옮겨 적으면 되묻지 않고 끝까지 간다.
- **다른 에이전트가 트리에서 일하는 동안 주 세션이 파일을 만들지 않는다.** 단계 8 SRS 초안을 커밋하지 않고 두었다가 7단계 에이전트의 게이트(decisions)를 깨고 그 커밋에 섞였다.
- **에이전트가 보고 뒤에도 백그라운드 작업(e2e)을 남기는 일이 있다.** 다음 에이전트의 e2e 와 포트가 부딪치므로 `TaskStop` 으로 멈추고 다음을 띄운다. 브리프 끝에 "띄운 백그라운드 작업을 정리하고 보고하라" 를 넣는다.
- **e2e·단위 시험이 App·패널 인스턴스의 메서드를 덮어 쓴다**(App 54개+, 패널 `_pollOk`·`collect`·`copyText`·`_paint` 등). 부품·컨트롤러 안에서는 그런 이름을 `this.app.X()`/`this.p.X()` 로 불러야 덮은 것을 본다. 시험 파일에 `app.X =` 를 새로 쓰면 그 이름이 곧 덮어쓰기 대상이 된다(TC-FEA-2 정적 검사가 주석의 `this.X` 까지 잡는다).
- **zsh 에서 따옴표 없는 `$S` 는 낱말로 갈리지 않는다** — e2e spec 목록은 파일에 담아 `xargs npx playwright test < list`.
- **분석·변환 도구**(세션 밖 `/tmp`, 재부팅하면 사라진다): `/tmp/fep/conv.mjs`·`audit.mjs`, `/tmp/fea/{conv,plan,audit,paths,e2e}.mjs`, `/tmp/fe9e/{scan,calls}.mjs`, `/tmp/fe9k/plan2.mjs`. 없으면 같은 일을 acorn 으로 다시 짠다.
- **위임자는 컨트롤러 파일 끝의 `Controller.delegate(host, to, names)` 표**다. `app.js`(769줄)에 위임자를 더하지 않는다. 위임자 제거(부르는 쪽을 컨트롤러 경로로 옮기기)는 다음 리팩토링이다.

### 알려진 e2e 실패·흔들림 (전체 시험 보고에 쓴다)

- 원래 실패(앞 커밋에서도 남): `sidebar-actions` TC-SBA-1 · `git-ui-metrics` V80 · `kit-components` TC-CMP-19 · `ui-kit-icons` V-GAP-1 · `version-autoreload` TC-RLC-25
- 환경 실패: `skill-contract.spec.ts:451`(fgName `"~"`)
- 흔들림: `activity-rail` TC-ACF-1 · `editor-ops` O7 · `settings.spec.ts` 이름 거절 · `ux-audit-fix-7` TC-UXF-94 · `ux-audit-fix` TC-UXF-1 · `edges-settings` 간선 주소 · `slot-view-state` TC-SVS-* · `tab-names` V-TAN-2 · `tab.spec` keyboard shortcut · 단위 `cm-sticky.test.mjs` · Go `gitapi` `TestWorktreeCreateInputAnswer`

## 5. 모아 둔 문서 어긋남 (P7 — HANDOFF_2 §4·HANDOFF_3 §5 에 더한다)

- 옛 파일 이름(`app-*.js`·`panel-*.js`·`app-settings-*.js`·`remote.js` 한 파일 등)을 적은 문서가 `docs/internal/` 에 약 80편. 대부분 이력 기록 — Q6("전부 코드 기준")에 따라 살아 있는 문서(`architecture.md` 등)만 고칠지 정한다
- 옛 파일 이름을 가리키는 코드 주석: `ui/file-editor-diff.js:476` · `ui/sidebar-tabs.js:232` · `core/git-controller.js:100` · `core/helpers.js:14·74` · `core/editor-doc-render.js:116` · e2e 주석 셋(`editor-cwd-inherit`·`git-worktree-repo`·`notes-live-explorer`) · `scripts/check-i18n.mjs` 예외 사유(`app-activity.js`·`app-claude-accounts.js`)
- `FE_OBJECT_MODEL.md` §2 행 6 "app-settings* 14파일"(실제 12) · §3 의 `GitListTab` 자리(D-FEV-3 으로 `GitView` 하위) · §3 의 `GitRemote` 자리(D-FEV-4 로 `GitRemoteList`)
- `PROD3.md` FC-F1 의 옛 경로 `app-settings-theme.js` · FC-13·14 행에 처리 표시 없음(§7.1 P3a 6 에서 처리) · PROD3 P3a 3 행의 "initModal 135 → 8줄"(단계 8 에서 한 줄)
- `FE_MODULE_BOUNDARY_SRS.md` 160~163·436·488행의 옛 파일 표
- `PERFORMANCE_BUDGET.md` 상태바 행의 계기 "설정 탭 전환"(실제는 부팅 때 한 번)
- `index.html:1194` 주석의 옛 이름 `_gitSignal`

## 6. 변하지 않는 규약 · 유효한 사용자 결정

`REFACTOR_PROD3_HANDOFF_2.md` §7·§8 과 같다. 더한 것: 단계 9 는 "이슈를 나눠 전부" (셋째 세션).
