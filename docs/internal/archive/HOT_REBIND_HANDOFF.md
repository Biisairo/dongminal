# 인계: 포트·expose 의 실행 중 변경 (HOT_REBIND) 구현

> 이 문서는 다음 세션의 착수 지시다. 진실은 `docs/internal/HOT_REBIND_SRS.md`(승인·구현중)다.
> 작성: 2026-11-18, 앞 세션(DAEMON_SESSION_KEEP 구현 세션)이 넘긴다.

## 1. 착수 블록

1. `git status` 로 확인한다. 브랜치 `main`. 직전 커밋은 이 문서와 SRS 를 담은 커밋이다. `e523835d`(데몬 세션 유지 교체)는 **아직 push 하지 않았다** — push 는 사용자가 말할 때만.
2. `docs/internal/HOT_REBIND_SRS.md` 를 끝까지 읽는다. 결정 D-HRB-1~8 은 사용자와 인터뷰로 정했다(1~5 는 사용자 결정, 6~8 은 앞 세션이 관례로 정하고 사용자가 승인).
3. 묶음 순서는 **S → D → R → U** 다. 묶음마다 **Spec(이미 있음) → Test(RED 확인) → Code → 검사** 순서다.
   - S: `serverconf.Resolve` 에서 바인드 환경 변수 계층을 뺀다(FR-HRB-1·2·8), `start --port`·`--expose` 가 `server.json` 에 쓴다(FR-HRB-3·4·5), 서비스 파일(FR-HRB-6), 대상 해석(FR-HRB-7). e2e 의 `PORT` 환경 변수(`e2e/fixtures.ts:267`)와 스크립트(`scripts/perf-probe.sh`, `scripts/shots/shoot.sh`)도 `--port` 로 바꾼다 — e2e 는 **돌리지 않는다**.
   - D: 주소 파일 `server.addr`(FR-HRB-10), `app.go:55·56` 의 `os.Setenv` 삭제(FR-HRB-11), `dmctl` 주소 찾기(FR-HRB-12·14, `internal/helper/runtimebin/http.go:22`), 샌드박스 마운트(FR-HRB-13, `internal/shared/sandboxplace/wire.go:41`).
   - R: `POST /api/server/bind`·`/api/server/carry`, 리스너 갈아 끼우기(`internal/webserver/httpapi/server.go` `Run`·`hostAllow`).
   - U: Settings 의 Server 구역, `dongminal config set|get`.
4. 묶음마다 검사를 통과하면 사용자에게 보고하고 커밋 여부를 묻는다(사용자 규칙: 커밋은 사용자가 말할 때만).
5. 구현 중 SRS 와 코드가 어긋나면 멈추고 묻는다. 결정은 한 번에 하나, 권장 답과 함께 `AskUserQuestion` 으로.

## 2. 사용자 규칙 (유효)

- **사용 중인 서버와 데몬을 절대 건드리지 않는다.** 재시작·종료·그 포트를 쓰는 실행(e2e 포함)을 하지 않는다. `dongminal start`·`stop` 을 실제로 부르지 않는다. 사용 중인 데몬은 pid 1845(11월 17일부터), 홈은 `~/.dongminal` 이다. 시험은 임시 홈(`os.MkdirTemp("", "짧은접두어")`)과 빈 포트에서만 돈다. 시험 시작 때 그 홈이 `~/.dongminal` 아래가 아닌지 확인하는 줄을 둔다(`cmd/dongminal/session_keep_posix_test.go` 참고).
- 커밋·push 는 사용자가 말할 때만. 커밋 메시지에 AI 서명 금지.
- 문서와 코드가 다르면 코드를 따르고, 끝난 뒤 보고하고 사용자 선택으로 문서를 고친다.
- 보고는 쉽고 자세하게, 한국어로.

## 3. 먼저 읽을 것

- `docs/internal/HOT_REBIND_SRS.md` 전부.
- `docs/internal/CONFIG_MANAGEMENT_SRS.md` FR-CFG-13~15, §6 — 이 일이 우선순위 규칙과 비목표 §6-3 을 바꾼다. 구현 뒤 그 문서를 고칠지 사용자에게 묻는다.
- `docs/internal/REQUEST_GATE_SRS.md`·`REQUEST_GATE_ORIGIN_PORT_SRS.md` — Host·Origin 허용 집합이 포트에 묶인다.
- `docs/internal/ACCESS_ALLOWLIST_SRS.md` — expose 때의 허용 목록.
- 코드 출발점: `internal/shared/serverconf/conf.go`(`Resolve`·`pick`), `internal/ctl/cli/start.go`(334~336 이 자식에게 환경 변수로 바인드를 넘긴다), `internal/ctl/cli/service.go`(160·193), `internal/ctl/cli/options.go`(`ResolveTarget`), `cmd/dongminal/app.go`(55·56), `internal/webserver/httpapi/server.go`(`Run` 413~, `hosts` 282), `internal/helper/runtimebin/http.go`(`baseURL`), `internal/shared/sandboxplace/wire.go`.

## 4. 앞 세션이 배운 것

- 검사는 `make gates > /tmp/g.log 2>&1; echo $?` 처럼 종료 코드를 따로 본다.
- 커밋 전 검사: `make gates`, `make lint`, `go test ./...`(httpapi 가 70초 넘게 걸린다 — 바꾼 패키지 먼저), `npm run typecheck`, `npm run unit`. 교차 빌드 `GOOS=windows go build ./...`, `GOOS=linux go build ./...`.
- **이음매 게이트**: `runtime.GOOS`, `syscall.Kill`·`syscall.SIG*`, `net.Listen("unix", …)`, 종단 파일명 문자열(`"paned.sock"`), `/proc` 직접 읽기, `ps` 실행은 **`internal/shared/platform` 밖에 두면 `make gates` 가 실패한다(시험 파일 포함)**. `platform.Current().OS`, `platform.Current().Process.Kill/Terminate`, `platform.Current().IPC.Listen/Dial/Endpoint` 를 쓴다.
- 새 Go 패키지는 `docs/internal/architecture.md` 패키지 표에 올려야 `make gates` 가 통과한다.
- SRS 문서 상태가 `승인·구현중` 이면 바로 아래에 `> **남은 것**: …` 줄이 있어야 게이트가 통과한다. 상태 값은 `초안 승인대기 승인·구현중 승인·구현완료 폐기 대체` 중 하나.
- SRS 의 결정(D-)을 고치면 `go run ./scripts/gen-decisions`, 오류 코드를 바꾸면 `go run ./scripts/gen-errors`.
- 린트: 내장 함수 이름(`real` 등)을 변수로 쓰지 않는다. x/sys 의 deprecated 직접 syscall 은 이유를 단 `//nolint:staticcheck // …` 로만.
- 자동 보안 검토가 커밋·변경마다 돈다. 새 로컬 API 는 "누가 부를 수 있는가"(expose 상태의 같은 망, 홈을 마운트한 샌드박스 컨테이너)를 먼저 따진다. 앞 세션에서 `daemon.reload` 가 샌드박스 탈출 경로로 지적돼 대상 바이너리를 데몬 자신의 경로로 고정했다.
- 프런트 게이트: `web/js/ui/` 가 App 의 `_` 로 시작하는 내부 이름을 부르면 실패한다(FE_MODULE_BOUNDARY).
- 화면 모양 확인은 임시 HTML 을 빈 포트의 `python3 -m http.server` 로 띄워 Playwright 로 찍는다(`file:` 은 막혀 있다). 끝나면 서버와 파일을 지운다.
- `gitapi` 의 `TestWorktreeCreateInputAnswer` 가 가끔 실패한다(무관, 다시 돌리면 통과).

## 5. 이 브랜치의 최근 상태 (참고)

- `a22e08d9` 묶음 C(`start` 의 세션 유지 교체, `--server-only`·`--refresh-daemon`), `e523835d` 묶음 H·R(데몬 exec 교체·되살리기 세 겹). `DAEMON_SESSION_KEEP_SRS` 는 승인·구현중, 남은 것은 사용자의 실제 첫 교체 확인이다.
- **사용자가 아직 답하지 않은 것** (이 일이 끝난 뒤 다시 묻는다):
  1. `DAEMON_STALENESS_SRS` 의 비목표("부분 재시작은 별개의 큰 주제")와 FR-DFP-8 출력표가 새 동작과 다르다 — 고칠지.
  2. `docs/internal/DAEMON_SESSION_KEEP_HANDOFF.md`(옛 착수 지시)를 고칠지·지울지.
  3. `e523835d` push 여부.
- 다음 큰 일(이 일 뒤): **Run 복구 + 상태 복원**. 데몬이 실제로 죽은 뒤 되살아난 빈 셸에서 에이전트를 세션 id 로 재개(`claude --resume <id>`)한다. Run 복구는 `runs.json` 의 `sessionId` 를, 상태 복원(Run 밖 에이전트 탭)은 도구마다 `{agent, sessionId, cwd}` 를 새로 저장해 쓴다. 훅이 이미 `session_id` 를 보내고 데몬이 버리고 있다(`internal/shared/agentrec/agentrec.go:78`). 상태 복원을 먼저, Run 복구를 그 위에 얹는 것을 앞 세션이 권했다.
