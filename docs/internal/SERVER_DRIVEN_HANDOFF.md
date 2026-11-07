# server-driven 다음 단계 — 착수 문서 (2026-11-07 개정 · server-driven 완료)

앞 세션(`server-driven-K2`)에서 넘어온 일이다. 이 문서의 「착수 블록」 이 이번 세션의 지시 전부다.

## 착수 블록

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다.
2. **server-driven 은 끝났다.** `docs/internal/SERVER_DRIVEN_ACTIONS_SRS.md` 는 승인·구현완료다(묶음 M·GR·GT·GV·F·R·X·K·N). 다시 열지 않는다.
3. 이번 일은 `docs/internal/ISSUE_TREE_OPS_FINDINGS.md` 다. 그 문서의 머리와 아래 「server-driven 다음 단계」 를 먼저 읽는다. 끝에 덧붙인 「참고: server-driven 구현 내용」 도 읽는다.
4. 그 문서는 **요구 입력**이다. 구현하기 전에 IEEE 29148 SRS 로 옮긴다(Spec → Test(RED) → Code). 1~8번은 `ISSUE_AGENT_TREE_SRS.md` 의 개정이나 새 SRS 로, 맥락 migration 과 표시줄은 각각 묶음이나 SRS 로 만든다. 일이 크면 SRS 를 묶음으로 나누고 묶음마다 커밋한다.
5. 사용자가 이미 정한 것(문서의 「사용자 결정」 넷과 13·14번의 원문)은 다시 묻지 않는다. 「dongminal 이 정한다」 로 남은 자리와 SRS 가 답하지 않는 기능 결정은 사용자에게 **하나씩**, 권장 답과 함께 묻는다.
6. 9번(GitHub 트리 그래프)은 조사가 먼저이고, 구현할지는 조사 결과를 보고 사용자가 정한다.

## 변하지 않는 규약

- **사용자의 dongminal 을 재시작하지 않는다.** 설치 트리(`$DONGMINAL_HOME/bin`)도 다시 설치하지 않는다. e2e 는 자기 격리 서버를 띄우므로 돌려도 된다.
- 커밋은 사용자 확인 뒤에만. AI 서명(`Co-Authored-By` 등) 금지. push 하지 않는다.
- 커밋 전에 `make gates` · `make lint` · `go test ./...` · `npm run -s unit` · `npm run -s typecheck` 를 통과시킨다. 바꾼 화면을 지나는 e2e 를 돌린다.
- 새 Go 패키지를 만들면 `docs/internal/architecture.md` 패키지 표에 더한다(게이트가 잡는다). SRS 의 결정을 바꾸면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만든다.
- 동작이 바뀌면 SRS 변경 기록에 **이전 동작 / 새 동작 / 이유** 를 적는다. 새 거절은 CHANGELOG 에도 적는다(R-3).
- 사용자에게는 한국어로, 쉬운 말로 설명한다. 사용자는 "왜 그렇게 하는가" 와 "다른 도구는 어떻게 하는가" 를 자주 묻는다 — 그 근거를 갖고 말한다.
- `dmctl` 레이아웃 명령에 `--help` 를 붙여 도움말을 보지 않는다. `dmctl --help` 를 쓴다.
- **사용자 지시(2026-11-07):** 단계마다 검증을 통과하면 스스로 커밋하고 계속 진행한다. 구현상 결정이 필요할 때만 묻는다. 컨텍스트가 차면 `/dongminal:migration` 으로 넘긴다.

## 앞 세션에서 끝난 것

**server-driven (이 갈래)** — 커밋 `7ba5f781`~`38d22f2c`. 설계는 SRS §3.1a(M)·§3.2a(GR)·§3.3a(GT)·§3.4a(GV), 경위는 §8 변경 기록.

- **장치(M):** `internal/webserver/action`(답 `{ok,why,args}`·`Catalog`·`First`), 사유 코드 = `apierr` 와이어 코드, 문구 `why.<code>`(ko·en), 게이트 `check-action-reasons.sh`(문구)·`check-server-driven.sh`(없앤 화면 판정 이름 — 묶음마다 목록에 더한다). 화면은 `web/js/core/action-answer.js` 의 `actionState(answer,pending)` 하나.
- **종단:** 1층은 `GET /api/git/status` 의 `actions`(칸·상태 사실). 2층은 `GET /api/git/actions` — `action=git.stash.create|git.commit`(입력을 받는 것), `kind=commit&oid=`·`kind=branch&ref=<전체 ref>`(메뉴). 실행 거절은 `gitWrite.rejectAnswer`(서버 문구 `message` 를 싣지 않는다).
- **판정 함수(gitapi):** `slotsAnswer`·`stashCreateAnswer`·`resetAnswer`·`cleanAnswer`·`commitMessageAnswer`·`commitStateAnswer`·`commitOpAnswer`·`opAnswer`·`branchAnswer`·`branchPair`·`worktreeRemoveAnswer`. 브랜치 판정은 `query.Refs` 로 실제 ref 에 대 본다(`handlers_git_actions_branch.go`).
- **새 종단:** `POST /api/git/branch/delete-both`(사용자 결정 2026-11-06). 원격 이름 분리 `splitRemoteRef`(원격 목록과 맞춤) — GV 의 G-B8 이 이것을 다시 쓸 수 있다.
- **화면 메뉴:** `GitMenu` 항목의 `busy:`(1층 답)·`act:`(2층 답, 열 때 묻는다, `GIT_MENU_ASK`). 항목 표는 `web/js/git/menu-items.js` 로 갈랐다(모듈 크기 기준선).
- **사용자 결정:** worktree 지우기 답은 목록 행마다(GR-1h) · 양쪽 삭제는 새 종단 하나(GT-e).

- **GV(2026-11-06, `95595260`·`9317c83e`·`9fd7cc57`·`38d22f2c`):** 대화상자 입력은 `GET /api/git/actions?action=<id>&<입력>` 로 묻는다(GV-a). 화면 장치는 `web/js/git/input-answer.js` 의 `GitInputAnswer`(디바운스·세대·다시 묻는 동안 앞선 사유 유지). 판정 함수는 `handlers_git_actions_input.go`(`errAnswer`·`upstreamAnswer`·`stashBranchAnswer`·`worktreeCreateAnswer`·`remoteAddAnswer`·`compareAnswer`·`repoAddAnswer`). `git.repo.add` 는 repo 없이 묻는다. 원격 ref 는 화면이 `ref`(전체 이름)로 보내고 서버가 가른다(`gitWrite.remoteBranchOf`), `/api/git/refs` 의 원격 ref 는 `remote` 를 싣는다. `/api/git/policy` 가 `tagKinds`·`resetModes` 를 싣는다. 태그 종류의 입력 이름은 `tagKind`(`kind` 는 GT 의 대상 종류).

- **F(2026-11-07, `34f80eff`·`210518e4`·`fee7f381`·`19d8ed27`):** 설계 §3.5a.
  - F-1: `POST /api/fs/actions {root, paths}` → `{actions:{fs.rename·fs.move·fs.copy·fs.delete}, count}`. `paths[0]` 은 메뉴를 연 행. 판정 `fsProtectAnswer`·`fsMoveAnswer`·`fsCopyAnswer`·`fsDeleteAnswer`(`handlers_fs_actions.go`). 참인 답은 `args` 를 싣지 않으므로 항목 수는 답 밖 `count`. 파일 표면 거절은 `fsRejectAnswer` → `fsFailBody`(본문 `{code,args}`, `message` 없음). 새 코드의 상태는 `apierr.FSStatus` 표가 정한다(`fsDeny`). 화면 메뉴는 `GitMenu.openAsked(items,kind,target,ev,ask)` 로 묻는다(git 메뉴와 공용). 거절 문구는 `edFsReason`(표 → `why.<code>` → message).
  - F-2: `POST /api/fs/validate-name` · `fsNameAnswer` · 만들기 `{parent,name}`·이름 바꾸기 `{from,name}` · `into_self`(`fsIntoSelfAnswer`). 인라인 입력의 묻기는 `file-tree-edit.js` 의 `_askName`(GitDialog 가 아니라 `GitInputAnswer` 를 못 씀).
  - F-3: `wsentry.CheckEditorPath` · `POST /api/editors/validate` · `GitInputAnswer` 가 `ask(p,stale)` 를 주입받는다.
  - F-4: 사용자 결정 D-SDA-8 — 이름 상한(64, UTF-16 단위)은 `/api/commands` 에서만 거절(`name_too_long`, 평문 방언), workspace 저장은 막지 않는다. **새 `GET /api/meta`**(`entityNameMax`) — 묶음 K 가 여기에 상수를 더한다. 화면은 `applyServerMeta`(constants.js)로 받고 받기 전엔 자르지 않는다.
- **R(2026-11-07, `1991b623`):** 설계 §3.6a. 사용자 결정 D-SDA-9 — 종료 버튼은 `force` 뜻을 유지하고 서버가 그 뜻으로 판정(FR-SDA-61 문구 개정). 도메인 `run.CheckClose(rec, force)`. 목록·그래프의 Run·멤버에 `actions`(`run.close`·`run.delete`·`run.member.detach`), 목록 Run 에 `unreported`. Run 코드는 sentinel 참조 `apierr.CodeRunClosed`·`CodeMemberNotAttached`(var), 카탈로그 시험은 `apierr.Runs.Codes()` 도 와이어 코드로 본다. 화면 공용 `actionOk(o,id)`(action-answer.js).

- **K(2026-11-07, `6758492e`·`f20a89e3`·`e6eb4d68`·`2cee00f9`·`ffd50236`):** 설계 §3.8a · 사용자 결정 D-SDA-11·12.
  - K-1: `/api/git/policy` 의 `jobLineCap`·`logLimits`, `/api/meta` 의 `fsStampMax`·`fileStampsMax`·`fsWatchDirsMax`·`encodings`, `/api/editors` 의 `fixed`.
  - K-2 잡: 잡 JSON 의 `fixes`·`indicator`, 정책의 `jobSlots`.
  - K-2 샌드박스(K-i): `/api/sandbox/runtime` 의 `ready`·`installed`, 프로파일의 `workPicks`(`[{work, copies}]`), 헤더 `X-Sandbox-Only-Default`(D-SDA-12, 배열 모양 유지). 화면 `sandboxWorkLabel`·`sandboxWorkTitle`·`sbxRuntimeText`.
  - K-3: 게이트 `scripts/check-shared-constants`(Go 쪽은 `go/parser` 로 읽는다) · `jobs.IndicatorKinds()` · 공유 표본 `gitapi/testdata/oid_digest_vectors.json`·`httpapi/testdata/term_query_report_vectors.json` + `web/js/test/shared-vectors.test.mjs`.
  - K-4: `fullscreenDefault`(스키마 `def`) · `/api/tools/background` 의 `runShort`.
- **N(2026-11-07, `4979072c`):** 낡은 주석. 다섯 중 셋은 앞 묶음에서 이미 없어졌다.
- **X(2026-11-07, `28082a63`·`1b8ff89e`·`c5912720`·`699bfa65`):** 설계 §3.7a. 사용자 결정 D-SDA-10(UTF-8 변환은 `convertFrom` 으로 일반 저장과 가른다).
  - X-1: `GET /api/sandbox/runtime` 에 `actions["sandbox.runtime.start"]`, 시작 요청은 `Probe` 뒤 `sandboxStartAnswer` 로 거절(`runtime_missing`·`runtime_start_manual`). 시험 이음매는 `writeSandboxRuntime`·`writeSandboxStart`(상태·실행자를 받는다).
  - X-2: `GET /api/cwd` 에 `actions["term.upload"]`, 새 모양 `POST /api/upload?tool=<id>`(그 순간의 도구 cwd, `dir` 무시, `upload_no_tool_cwd`). `dir` 모양은 그대로(진단 오버레이). e2e 는 셸 cwd 를 못 정하므로 `toolCwdAt` 이 `tool` 모양을 확인한 뒤 `dir` 로 바꿔 보낸다.
  - X-3: `POST /api/access/check`(본문 = PUT) → `access.save` 답(`locks_you_out`, 거절 아님·경고). 판정 `accessStore.checkSave` = `normalizeAccessConfig` + `buildMatcher` + `accessMatcher.allowed`(게이트와 같은 함수). **e2e 브라우저는 loopback 이라 서버는 잠기지 않는다고 답한다** — 확인창 시험은 답을 위조한다.
  - X-4: 읽기 헤더 `X-File-Actions`·저장 응답 `actions` 의 `file.convert_utf8`(`convertUTF8Answer`), 저장의 `convertFrom` 이면 디스크 바이트로 거절(`encoding_undecodable` 422·`already_utf8` 409). 화면의 저장은 409 를 `file_changed_on_disk` 코드일 때만 경합으로 읽는다.

**같은 기간의 별건 수정** — `69226f81`: 그룹이 있으면 `winOrderNormalize` 가 window 객체를 복사해 이름 편집이 저장되지 않던 결함, 그룹 이름 더블클릭이 떨어진 요소에 걸리던 결함.

**알려진 흔들림(변경 전부터):** `e2e/git-hunk.spec.ts` 커서 툴바 묶음, `e2e/git-menu.spec.ts` N3. 시험의 `git status` 폴링이 서버 쓰기와 index.lock 을 다툰 BR8 은 `GIT_OPTIONAL_LOCKS=0` 으로 고쳤다 — 같은 꼴이 다른 스펙에 보이면 같은 처방이다.

**그 이전(리팩토링-2차)** — `docs/internal/refactor/PROD2.md`, 커밋 `129e2a6e`~`7c252679`.

## 앞 세션이 값을 치르고 배운 것

- **K-i·K-3·K-4(2026-11-07) 에서 배운 것:**
  - 맨 배열 응답에 목록 단위 사실을 실을 자리가 없으면 헤더로 싣는다(D-SDA-12, `X-File-Actions` 선례). 공개 응답 모양을 바꾸는 것은 사용자에게 묻는다.
  - 새 Go 프로그램(`scripts/<이름>/`)도 `docs/internal/architecture.md` 패키지 표에 더해야 게이트가 통과한다.
  - 파이썬 heredoc 에 `\"` 가 섞이면 비-UTF-8 오류가 났다 — 긴 한국어 치환은 `/tmp` 의 `# -*- coding: utf-8 -*-` 스크립트 파일로 돌린다.
  - docker 가 없는 호스트에서 `sandbox-window.spec.ts` 는 건너뛴다. 복사 배지 경로는 실제 런타임에서만 잰다.
- **K(2026-11-07) 에서 배운 것:**
  - 정책·meta 를 기다리는 화면은 "받기 전" 을 상수마다 정했다(SRS §3.8a). 잡 칸은 정책을 받은 뒤 `GitJobs._build` 가 상자·머리·잡 목록을 다시 건다 — 같은 꼴이 K-i 에서도 필요할 수 있다.
  - **e2e 의 가짜 서버 응답은 새 필드도 실어야 한다.** `git-remote` R16 이 가짜 잡에 `indicator`·`slots` 가 없어 실패했다(HEAD 6/6 통과로 회귀를 가렸다). 회귀인지는 `git stash` 로 HEAD 와 `--retries=0 --repeat-each` 를 견줘 가린다.
  - i18n 키 규약은 `-` 를 받지 않는다(`git.job_kind.cherry_pick`). 조립하는 키의 접두는 `scripts/check-i18n.mjs` 의 `DYNAMIC_PREFIXES` 에 등록한다.
  - 게이트 탐침은 **코드 줄**로 넣는다 — `check-server-driven.sh` 는 주석을 보지 않는다.
  - 플러그인 행(FR-EXT-9b)이 이제 선다(K-e 에서 찾은 결함, 사용자 결정). 창이 하나 늘었다.
  - **알려진 흔들림(변경 전부터):** `editor-find-panel.spec.ts:431`(개요 눈금)·`view-scroll-restore.spec.ts:117` — HEAD 에서도 재시도 없이 12회 중 7회 실패한다.

- **SRS 문구와 기존 설계 근거가 부딪치면 묻는다.** R 의 FR-SDA-61("force 를 멈춘다")은 FUI-04 의 근거(일하는 Run 을 기록을 남기고 멈출 길)와 부딪쳤고, 사용자는 기존 뜻을 유지했다. F-4 도 "서버가 거절" 의 자리(workspace 저장 전체 vs dmctl)를 물었다 — 저장 전체를 거절하면 긴 이름 하나로 그 뒤 변경이 모두 저장되지 않는다.
- **오류 방언이 표면마다 다르다.** git `{error,args}`(`gitErrJSON`) · fs `{code,args}`(`fsFailBody`) · 평문(`httpErr`, `/api/commands`) · runs `{error,detail}`(`writeRunError`). 게이트 `check-http-error.sh` 가 렌더러 우회를 잡는다 — `fsJSON` 에 오류 상태를 직접 쓰면 실패한다.
- **게이트에 자주 걸리는 것:** 새 종단은 `docs/external/api.md` 에 줄을 더한다(api-docs). 새 코드는 `go run ./scripts/gen-errors`. SRS 결정을 더하면 `go run ./scripts/gen-decisions`. 새 사유 코드마다 `why.<code>` ko·en(action-reasons). 화면 파일의 줄 수 기준선(`file-tree-paint.js` 1012)이 있다 — 늘리지 말고 기존 줄에 붙이거나 다른 파일로 둔다.
- **e2e 가 서버 응답을 흉내 내는 스펙**(`runs.spec.ts` 의 `withActions`)은 서버 모양이 바뀌면 같이 고친다.
- **시험 함정:** 가짜 workspace 저장소는 `ws.raw` 를 바꿔도 rev 가 오르지 않아 `Entries.Roots` 기억이 낡는다. BSD sed 에는 `\b` 가 없다.
- 사유 코드의 fs 표면 상태는 `apierr.FSStatus` 에 등록해야 한다 — 빠지면 500 이 된다(F-2 의 `empty_name`).
- `action.Answer.Status` 는 직렬화하지 않는다(`json:"-"`). 응답에서 받은 답으로 거절 상태를 견주지 말고 판정 함수에서 가져온다(X-2 에서 한 번 틀렸다).
- 메뉴 항목의 꺼진 사유는 글자가 아니라 `title` 에 있다(`UIKit.menu`) — e2e 는 `toHaveAttribute('title', …)` 로 잰다.
- 화면 변경의 RED 는 화면 파일만 `git show HEAD:<파일>` 로 잠시 되돌려 새 e2e 가 실패하는지로 확인했다(탐침 뒤 복원).

## server-driven 다음 단계 — issue-tree 운영 (2026-11-07 완료)

- `docs/internal/ISSUE_TREE_OPS_FINDINGS.md` 는 `docs/internal/ISSUE_TREE_OPS_SRS.md`(승인·구현완료)로 옮겨 구현했다. 커밋 `09a5fcff`(SRS)·`9cb52995`(A)·`27ea2536`(B)·`04df2cb8`(C·S)·`fc217bcf`(M)·`6a3eb577`(W)·`b87d3efb`(E).
  - A: 트리 멤버의 배정(`run member --issue …`, `run assign`)과 트리 프리앰블. 질문은 노드가 직접 묻고 결정은 이슈 코멘트(D-ITO-3). 형제 이동·탭 닫기는 부모가 한다. 끼어든 이슈는 WIP 커밋 + 이슈 메모(D-ITO-4).
  - B: `run succeed --self`(자기 승계) · 트리 승계 알림 · `node_taken` 안내 · `who-am-i` 의 `member` · `migration.md` 의 멤버 갈래.
  - C·S: 배정 부모로 세운 트리 · 끝난 노드 흔적 · `waiting-children` · 트리 Run 대시보드의 중심이 트리 · `dmctl status` 의 `run_state=`·사용량 줄.
  - M: 설정 넷(`migrationHook`·`migrationHookCtxPct`·`issueTreeMigration`·`issueTreeCtxPct`) · `dmctl ctx-hook`(PostToolUse·UserPromptSubmit) · `GET /api/tools/migration-advice`.
  - W: 표시줄·칸 머리글에 포커스 탭 이름. E: 편집기 키가 CodeMirror 에 먼저 닿게 하고 Monaco 키를 더했다(§3.6a).
  - 9번(GitHub 이슈 트리 그래프)은 조사로 끝냈다(D-ITO-9, SRS §2.9).
- 사용자가 설치를 갱신하고 트리를 재가동해 확인했다(2026-11-07). 막지 않는 남은 것은 SRS 머리에 적었다.

## 이 문서가 하지 않는 것

- 묶음의 세부 설계를 대신 정하지 않는다. 각 묶음에서 SRS 에 먼저 적는다.
