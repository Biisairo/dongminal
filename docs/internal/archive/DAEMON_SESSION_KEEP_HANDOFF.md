# 인계: 데몬 재시작 뒤 Run 복구 · 데몬 재시작에도 터미널 세션 유지

> **상태 (2026-11-18): 요청 2 는 끝났고, 요청 1 은 남았다.** 이 문서는 기록으로만 남긴다.
> 아래 착수 블록은 그 당시의 지시이며, 지금 작업 트리와 맞지 않는다.
>
> - **요청 2(세션 유지)는 끝났다.** 진실은 `DAEMON_SESSION_KEEP_SRS` 다. 구현 커밋은
>   `a22e08d9`(묶음 C) 와 `e523835d`(묶음 H·R) 이고 `main` 에 있다. `feat/peer-daemon` 브랜치는 지웠다.
> - **`--restart-daemon` 은 없어졌다.** 플래그 없는 `dongminal start` 가 세션을 유지하며 데몬을 교체한다.
>   세션을 버리고 새로 띄우는 길은 `--refresh-daemon`, 데몬을 두고 서버만 다시 띄우는 길은
>   `--server-only` 다.
> - **요청 1(데몬이 실제로 죽은 뒤 Run 복구)은 아직이다.** 다음 큰 일로 남아 있다.
>   계획은 `HOT_REBIND_HANDOFF.md` §5 의 마지막 항목(상태 복원을 먼저, Run 복구를 그 위에)을 본다.

> 이 문서는 다음 세션의 착수 지시다. 진실은 이 일로 새로 쓸 SRS 다(아직 없다).
> 작성: 2026-11-18, 앞 세션(EDGE_PAIRING 구현 세션)이 맥락 54% 에서 넘긴다.

## 1. 착수 블록

1. `git status` 로 확인한다. 브랜치 `feat/peer-daemon`, 직전 커밋 `c9165b52`, 원격(`origin/feat/peer-daemon`)과 같다. 커밋하지 않은 파일은 **이 문서 하나**뿐이다 — 사용자가 커밋을 허락할 때 함께 커밋한다.
2. 사용자 요청 두 가지(2026-11-18, 원문):
   1. "데몬 전체를 내렸다 올렸을 때 터미널이 다 새로 만들어지는데 이 경우의 run 복구 기능"
   2. "dongminal start 시 reset daemon 에서 터미널 세션을 유지하기" — `dongminal start --restart-daemon` 을 해도 터미널 세션이 끊기지 않게 한다.
3. 둘 다 **중·대 규모**다. 순서는 고정: **인터뷰 → SRS(IEEE 29148, 저장) → 시험(RED) → 구현**. 구현 전에 결정은 **한 번에 하나씩, 권장 답과 함께** `AskUserQuestion` 으로 묻는다. 코드를 보면 답이 나오는 것은 묻지 말고 조사한다.
4. 먼저 할 일: 아래 §3 의 문서를 읽고 지금 구조를 조사한 뒤, 두 요청이 서로 어떻게 얽히는지(2가 되면 1의 상당 부분이 필요 없어지는가) 정리해 사용자와 **어느 것부터, 어디까지** 할지 인터뷰로 정한다.

## 2. 사용자 규칙 (유효)

- **커밋·push 는 사용자가 말할 때만** 한다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다.
- **사용 중인 데몬과 서버를 절대 건드리지 않는다.** 재시작·종료·그 포트를 쓰는 실행(e2e 포함)을 하지 않는다. e2e 의 `start` 는 격리 모드가 아니라서 포트를 쥔 프로세스를 죽인다(`ctl/cli/start.go` `killPort`). 2026-11-17 에 이 경로로 사용자의 운영 서버가 내려갔다. 검증은 Go·JS 단위 시험과 `make gates`·`make lint` 로 한다.
- 문서와 코드가 다르면 코드를 따르고, 끝난 뒤 보고하고 사용자 선택으로 문서를 고친다.
- 보고는 쉽고 자세하게, 한국어로.

## 3. 먼저 읽을 것

- `docs/internal/DAEMON_STALENESS_SRS.md` — `--restart-daemon` 과 데몬 판 판정(`paned.build`, `dongminal health --daemon`).
- `docs/internal/AGENT_RECORD_DAEMON_SRS.md` — 서버 재시작에도 Run·카드·알람이 남게 한 일(FR-ARD-*). 펜싱 제거(FR-ARD-3·7)는 데몬 모드에만 적용됐다. 이번 1번 요청은 **서버가 아니라 데몬**이 내려가는 경우다.
- `docs/internal/ISSUE_AGENT_TREE_SRS.md`·`ORCHESTRATION_V2_SRS.md` — Run·멤버·승계(`dmctl run succeed`·`launch`), 이슈 트리.
- `docs/internal/PEER_DAEMON_HANDOFF.md` §4 "배운 것" — 데몬 IPC 구조, 시험 요령(유닉스 소켓 경로 104바이트 한도 → `os.MkdirTemp("", "짧은접두어")`, `platform.Current().IPC.Dial`), 게이트 요령.
- 코드 출발점: `internal/ctl/cli/start.go`(재시작 흐름), `internal/daemon/boot/`(데몬 기동), `internal/daemon/ipc/`(PanedServer), `internal/shared/toolhub/`(도구·PTY), `internal/webserver/toolclient/`(서버의 데몬 클라이언트, 재접속 `SetOnResync`), Run 저장은 `internal/webserver/httpapi/handlers_runs*.go`.

## 4. 앞 세션이 배운 것

- 검사는 `make gates > /tmp/g.log 2>&1; echo $?` 처럼 종료 코드를 따로 본다. 파이프(`| tail`)로 이으면 실패해도 이어진다.
- 커밋 전 검사: `make gates`, `make lint`, `go test ./...`(httpapi 가 70초 넘게 걸린다 — 바꾼 패키지 먼저), `npm run typecheck`, `npm run unit`.
- `gitapi` 의 `TestWorktreeCreateInputAnswer` 가 임시 폴더 정리 경합으로 가끔 실패한다(무관, 다시 돌리면 통과).
- 프런트 게이트: `web/js/ui/` 가 App 의 `_` 로 시작하는 내부 이름을 부르면 실패한다(FE_MODULE_BOUNDARY). 이름을 승격한다.
- 데몬 hello 기능 목록을 바꾸면 와이어 골든 두 곳(`daemon/ipc/wire_typed_test.go`, `webserver/toolclient/wire_typed_test.go`)을 같이 고친다.
- 새 Go 패키지는 `docs/internal/architecture.md` 패키지 표에 올려야 `make gates` 가 통과한다.
- SRS 의 결정(D-)을 고치면 `go run ./scripts/gen-decisions` 로 `decisions.md` 를 다시 만든다. 오류 코드를 바꾸면 `go run ./scripts/gen-errors`.
- 자동 보안 검토가 커밋마다 돈다. 새 경로를 만들면 악의적 입력부터 따진다.
- 화면 모양 확인은 임시 HTML 을 빈 포트(예: 47391)의 `python3 -m http.server` 로 띄워 Playwright 로 찍는다(`file:` 은 막혀 있다). 끝나면 서버와 파일을 지운다.

## 5. 이 브랜치의 최근 상태 (참고)

- EDGE_PAIRING E1~E4·후속 수정, 사이드패널 그룹 수정, Activity 탭 아이콘까지 커밋·push 됐다(`c9165b52`).
- 실제 실행 확인이 남은 것: 데몬·서버 재시작 후 e2e(`edges-settings.spec.ts`), e2e 기준선(`eg-add-name`) 갱신, 데몬 기동 코드의 간선 배선 두 곳 — 사용자 몫.
