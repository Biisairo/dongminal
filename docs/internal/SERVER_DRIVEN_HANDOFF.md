# server-driven actions — 착수 문서 (2026-11-07 개정 · F·R 완료)

앞 세션(`server-driven-F`)에서 넘어온 일이다. 이 문서의 「착수 블록」 이 이번 세션의 지시 전부다.

## 착수 블록

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다.
2. `docs/internal/SERVER_DRIVEN_ACTIONS_SRS.md`(**승인·구현중**)를 전부 읽는다. 이것이 단일 진실 공급원이다. 결정 D-SDA-1~7 은 사용자가 정했거나 승인했다 — **다시 묻지 않는다.**
3. 항목 ID(G-·F-·K-)의 근거(file:line)는 `docs/internal/refactor/SERVER_DRIVEN_INVENTORY.md` 에 있다. ✔ 가 없는 줄은 조사 결과 그대로이므로 **쓰기 전에 코드로 다시 확인한다.** 조사가 틀린 적이 있다(§0 의 정정).
4. 묶음 M·GR·GT·GV·F·R 은 끝났다(아래 「앞 세션에서 끝난 것」). **묶음 X(그 밖)부터** 시작한다. 그다음 K → N. N 까지 끝나면 아래 「server-driven 다음 단계」로 넘어간다. 묶음이 크면 단계로 나눠 단계마다 커밋한다(GR-1~3·GT-1~2 처럼). 묶음마다:
   - SRS 의 해당 FR 을 코드에 대 보고, 설계 세부(동작 ID 목록, 사유 코드, 종단 경로)를 SRS 에 먼저 적는다
   - 시험을 먼저 쓰고 **실패(RED)를 확인**한다
   - 구현(GREEN) → 커밋 전 검증 → 사용자 확인 뒤 커밋
5. SRS 와 코드가 충돌하거나 SRS 가 답하지 않는 기능 결정이 나오면 멈추고 사용자에게 **하나씩**, 권장 답과 함께 묻는다.

## 변하지 않는 규약

- **사용자의 dongminal 을 재시작하지 않는다.** 설치 트리(`$DONGMINAL_HOME/bin`)도 다시 설치하지 않는다. e2e 는 자기 격리 서버를 띄우므로 돌려도 된다.
- 커밋은 사용자 확인 뒤에만. AI 서명(`Co-Authored-By` 등) 금지. push 하지 않는다.
- 커밋 전에 `make gates` · `make lint` · `go test ./...` · `npm run -s unit` · `npm run -s typecheck` 를 통과시킨다. 바꾼 화면을 지나는 e2e 를 돌린다.
- 새 Go 패키지를 만들면 `docs/internal/architecture.md` 패키지 표에 더한다(게이트가 잡는다). SRS 의 결정을 바꾸면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만든다.
- 동작이 바뀌면 SRS 변경 기록에 **이전 동작 / 새 동작 / 이유** 를 적는다. 새 거절은 CHANGELOG 에도 적는다(R-3).
- 사용자에게는 한국어로, 쉬운 말로 설명한다. 사용자는 "왜 그렇게 하는가" 와 "다른 도구는 어떻게 하는가" 를 자주 묻는다 — 그 근거를 갖고 말한다.
- `dmctl` 레이아웃 명령에 `--help` 를 붙여 도움말을 보지 않는다. `dmctl --help` 를 쓴다.

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

**같은 기간의 별건 수정** — `69226f81`: 그룹이 있으면 `winOrderNormalize` 가 window 객체를 복사해 이름 편집이 저장되지 않던 결함, 그룹 이름 더블클릭이 떨어진 요소에 걸리던 결함.

**알려진 흔들림(변경 전부터):** `e2e/git-hunk.spec.ts` 커서 툴바 묶음, `e2e/git-menu.spec.ts` N3. 시험의 `git status` 폴링이 서버 쓰기와 index.lock 을 다툰 BR8 은 `GIT_OPTIONAL_LOCKS=0` 으로 고쳤다 — 같은 꼴이 다른 스펙에 보이면 같은 처방이다.

**그 이전(리팩토링-2차)** — `docs/internal/refactor/PROD2.md`, 커밋 `129e2a6e`~`7c252679`.

## 묶음 X 를 시작할 때 알아 둘 것

- FR-SDA-70~73 · 전수 목록 §3 의 F-A6(샌드박스 런타임 시작)·F-A8(터미널 드롭 업로드)·F-A9(접근 제어 잠김 경고)·F-A10(UTF-8 변환). ✔ 없는 줄은 코드로 다시 확인한다. 넷이 서로 독립이므로 X-1~X-4 로 나눠 단계마다 커밋하는 것을 권한다.
- F-A9 는 SRS §2.1 의 "이미 어긋난 자리"다(화면은 IPv4 만). TC-SDA-9 는 IPv6·별칭·자기 주소를 포함한 Go 표 시험이고, 화면의 `_aclV4`·`_aclCidrHas`·`_aclCoversYou` 를 없애 게이트 목록에 더한다.
- F-A10 은 전수 목록에 "서버: 없음(미확인)" 이다 — 저장 종단이 무엇을 거절해야 하는지 먼저 코드로 확인하고, SRS 가 답하지 않으면 사용자에게 묻는다.

## 앞 세션이 값을 치르고 배운 것

- **SRS 문구와 기존 설계 근거가 부딪치면 묻는다.** R 의 FR-SDA-61("force 를 멈춘다")은 FUI-04 의 근거(일하는 Run 을 기록을 남기고 멈출 길)와 부딪쳤고, 사용자는 기존 뜻을 유지했다. F-4 도 "서버가 거절" 의 자리(workspace 저장 전체 vs dmctl)를 물었다 — 저장 전체를 거절하면 긴 이름 하나로 그 뒤 변경이 모두 저장되지 않는다.
- **오류 방언이 표면마다 다르다.** git `{error,args}`(`gitErrJSON`) · fs `{code,args}`(`fsFailBody`) · 평문(`httpErr`, `/api/commands`) · runs `{error,detail}`(`writeRunError`). 게이트 `check-http-error.sh` 가 렌더러 우회를 잡는다 — `fsJSON` 에 오류 상태를 직접 쓰면 실패한다.
- **게이트에 자주 걸리는 것:** 새 종단은 `docs/external/api.md` 에 줄을 더한다(api-docs). 새 코드는 `go run ./scripts/gen-errors`. SRS 결정을 더하면 `go run ./scripts/gen-decisions`. 새 사유 코드마다 `why.<code>` ko·en(action-reasons). 화면 파일의 줄 수 기준선(`file-tree-paint.js` 1012)이 있다 — 늘리지 말고 기존 줄에 붙이거나 다른 파일로 둔다.
- **e2e 가 서버 응답을 흉내 내는 스펙**(`runs.spec.ts` 의 `withActions`)은 서버 모양이 바뀌면 같이 고친다.
- **시험 함정:** 가짜 workspace 저장소는 `ws.raw` 를 바꿔도 rev 가 오르지 않아 `Entries.Roots` 기억이 낡는다. BSD sed 에는 `\b` 가 없다.
- 사유 코드의 fs 표면 상태는 `apierr.FSStatus` 에 등록해야 한다 — 빠지면 500 이 된다(F-2 의 `empty_name`).

## server-driven 다음 단계

- 묶음 N 까지 끝나면 `docs/internal/ISSUE_TREE_OPS_FINDINGS.md` 로 넘어간다(사용자 결정 2026-11-06: server-driven 이 끝난 뒤). issue-tree 운영 문제 8건 · 맥락 기준 migration 의 설정과 훅 · 표시줄에 포커스된 탭 이름이다.
- 그 문서는 **요구 입력**이다. 먼저 IEEE 29148 SRS 로 옮기고, 「dongminal 이 정한다」 로 남은 자리는 SRS 에서 결정한다. 사용자가 이미 정한 것(문서의 「사용자 결정」 넷)은 다시 묻지 않는다.

## 이 문서가 하지 않는 것

- 묶음의 세부 설계를 대신 정하지 않는다. 각 묶음에서 SRS 에 먼저 적는다.
