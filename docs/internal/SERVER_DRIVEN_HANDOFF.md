# server-driven actions — 착수 문서 (2026-11-06 개정)

앞 세션(`server-driven-M`)에서 넘어온 일이다. 이 문서의 「착수 블록」 이 이번 세션의 지시 전부다.

## 착수 블록

1. `git status` 가 깨끗한지, 브랜치가 `main` 인지 본다. 직전 커밋은 이 문서를 담은 커밋이다.
2. `docs/internal/SERVER_DRIVEN_ACTIONS_SRS.md`(**승인·구현중**)를 전부 읽는다. 이것이 단일 진실 공급원이다. 결정 D-SDA-1~7 은 사용자가 정했거나 승인했다 — **다시 묻지 않는다.**
3. 항목 ID(G-·F-·K-)의 근거(file:line)는 `docs/internal/refactor/SERVER_DRIVEN_INVENTORY.md` 에 있다. ✔ 가 없는 줄은 조사 결과 그대로이므로 **쓰기 전에 코드로 다시 확인한다.** 조사가 틀린 적이 있다(§0 의 정정).
4. 묶음 M·GR·GT 는 끝났다(아래 「앞 세션에서 끝난 것」). **묶음 GV(git 입력 검증)부터** 시작한다. 그다음 F → R → X → K → N. 묶음이 크면 단계로 나눠 단계마다 커밋한다(GR-1~3·GT-1~2 처럼). 묶음마다:
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

**server-driven (이 갈래)** — 커밋 `7ba5f781`~`a71b0b32`. 설계는 SRS §3.1a(M)·§3.2a(GR)·§3.3a(GT), 경위는 §8 변경 기록.

- **장치(M):** `internal/webserver/action`(답 `{ok,why,args}`·`Catalog`·`First`), 사유 코드 = `apierr` 와이어 코드, 문구 `why.<code>`(ko·en), 게이트 `check-action-reasons.sh`(문구)·`check-server-driven.sh`(없앤 화면 판정 이름 — 묶음마다 목록에 더한다). 화면은 `web/js/core/action-answer.js` 의 `actionState(answer,pending)` 하나.
- **종단:** 1층은 `GET /api/git/status` 의 `actions`(칸·상태 사실). 2층은 `GET /api/git/actions` — `action=git.stash.create|git.commit`(입력을 받는 것), `kind=commit&oid=`·`kind=branch&ref=<전체 ref>`(메뉴). 실행 거절은 `gitWrite.rejectAnswer`(서버 문구 `message` 를 싣지 않는다).
- **판정 함수(gitapi):** `slotsAnswer`·`stashCreateAnswer`·`resetAnswer`·`cleanAnswer`·`commitMessageAnswer`·`commitStateAnswer`·`commitOpAnswer`·`opAnswer`·`branchAnswer`·`branchPair`·`worktreeRemoveAnswer`. 브랜치 판정은 `query.Refs` 로 실제 ref 에 대 본다(`handlers_git_actions_branch.go`).
- **새 종단:** `POST /api/git/branch/delete-both`(사용자 결정 2026-11-06). 원격 이름 분리 `splitRemoteRef`(원격 목록과 맞춤) — GV 의 G-B8 이 이것을 다시 쓸 수 있다.
- **화면 메뉴:** `GitMenu` 항목의 `busy:`(1층 답)·`act:`(2층 답, 열 때 묻는다, `GIT_MENU_ASK`). 항목 표는 `web/js/git/menu-items.js` 로 갈랐다(모듈 크기 기준선).
- **사용자 결정:** worktree 지우기 답은 목록 행마다(GR-1h) · 양쪽 삭제는 새 종단 하나(GT-e).

**같은 기간의 별건 수정** — `69226f81`: 그룹이 있으면 `winOrderNormalize` 가 window 객체를 복사해 이름 편집이 저장되지 않던 결함, 그룹 이름 더블클릭이 떨어진 요소에 걸리던 결함.

**알려진 흔들림(변경 전부터):** `e2e/git-hunk.spec.ts` 커서 툴바 묶음, `e2e/git-menu.spec.ts` N3. 시험의 `git status` 폴링이 서버 쓰기와 index.lock 을 다툰 BR8 은 `GIT_OPTIONAL_LOCKS=0` 으로 고쳤다 — 같은 꼴이 다른 스펙에 보이면 같은 처방이다.

**그 이전(리팩토링-2차)** — `docs/internal/refactor/PROD2.md`, 커밋 `129e2a6e`~`7c252679`.

## 묶음 GV 를 시작할 때 알아 둘 것

- FR-SDA-40~43 · 전수 목록 §2.2(G-B1~B9). 선례는 `branch/validate`·`tag/validate`(200 본문에 판정)와 M 의 `GET /api/git/actions?action=`(입력을 받는 답). 둘 중 어느 모양으로 묶을지 먼저 SRS 에 적는다.
- G-B8(`origin/x` 가르기)은 서버에 `splitRemoteRef` 가 이미 있다. 화면의 `GitBranches._split` 과 그것을 쓰는 원격 fetch·삭제 요청(`remote`·`branch` 로 갈라 보냄)을 서버 쪽 분리로 옮기는 일이 남았다.
- 대화상자의 비동기 검증 선례: `branches-dialogs.js` 의 이름 검증(세대 가드)·`stash-dialogs.js`(M-9).

## 이 문서가 하지 않는 것

- 묶음의 세부 설계를 대신 정하지 않는다. 각 묶음에서 SRS 에 먼저 적는다.
