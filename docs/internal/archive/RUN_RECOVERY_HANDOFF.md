# 인계: 데몬이 죽은 뒤 Run 복구 (+ 상태 복원)

> 이 문서는 다음 세션의 착수 지시다. 진실은 이 일로 새로 쓸 SRS 다(아직 없다).
> 작성: 2026-11-18. 앞 세션(HOT_REBIND 구현 세션)이 맥락 56% 에서 넘긴다.

## 1. 착수 블록

1. `git status` 로 작업 트리를 확인한다. 브랜치는 `main` 이고, 직전 커밋은 이 문서를 담은 커밋이다. `origin/main` 은 그 앞의 `9eaa9ea1` 까지 push 됐다.
2. 사용자 요청(2026-11-18): **"run 복구 명령을 만들자."** 데몬이 실제로 죽은 뒤 되살아나면 셸이 비어 있다. 그 빈 셸에서 에이전트를 **세션 id 로 재개**(`claude --resume <id>`)하는 명령을 만든다.
3. **중·대 규모**다. 순서는 바꾸지 않는다: **인터뷰 → SRS(IEEE 29148, 저장) → 시험(RED) → 구현**.
   - 결정은 **한 번에 하나씩, 권장 답과 함께** `AskUserQuestion` 으로 묻는다.
   - 코드를 보면 답이 나오는 것은 묻지 말고 조사한다.
4. 먼저 §3 을 읽고 지금 구조를 조사한다. 그다음 아래 범위를 사용자와 인터뷰로 정한다.
   - **범위 질문 1**: "Run 복구" 만 할지, Run 밖 에이전트 탭의 "상태 복원" 도 함께 할지.
     - 앞 세션은 **상태 복원을 먼저 하고 Run 복구를 그 위에 얹는 것**을 권했다(§4).
     - 사용자는 이번에 "run 복구 명령" 이라고 말했다. 그러니 둘의 관계를 설명하고 범위를 확인한다.
   - **범위 질문 2**: 명령의 모양.
     - 예: `dmctl run recover` / `dongminal recover` / 데몬 기동 때 자동으로 할지, 사람이 부르게 할지
     - 대상 단위: Run 전체인지, 멤버 하나인지
5. 단계마다 검사를 통과하면 사용자에게 보고하고 커밋 여부를 묻는다(커밋·push 는 사용자가 말할 때만).

## 2. 사용자 규칙 (유효)

- **사용 중인 서버와 데몬을 절대 건드리지 않는다.**
  - 재시작·종료·그 포트를 쓰는 실행(e2e 포함)을 하지 않는다. `dongminal start`·`stop` 을 실제로 부르지 않는다.
  - 사용 중인 홈은 `~/.dongminal` 이다.
  - 시험은 임시 홈(`os.MkdirTemp("", "짧은접두어")`)과 빈 포트에서만 돈다. 시험 시작 때 그 홈이 `~/.dongminal` 아래가 아닌지 확인하는 줄을 둔다(`cmd/dongminal/session_keep_posix_test.go`, `internal/ctl/cli/bind_source_test.go` 의 `tempHome` 참고).
  - **비격리 `RunStart` 시험은 그 포트를 `killPort` 로 비운다.** 포트가 기본값(58146, 사용 중인 서버)으로 풀리면 사용 중인 서버를 죽인다. 늘 빈 포트를 플래그나 `server.json` 으로 준다.
- 커밋·push 는 사용자가 말할 때만 한다. 커밋 메시지에 AI 서명을 넣지 않는다.
- 문서와 코드가 다르면 코드를 따른다. 끝난 뒤 보고하고, 사용자가 고르게 해서 문서를 고친다.
- 보고는 한국어로, 쉽고 자세하게 쓴다. 미사여구는 뺀다.

## 3. 먼저 읽을 것

- `docs/internal/DAEMON_SESSION_KEEP_SRS.md` 전부 — 데몬 교체 중 세션 유지(인계 상태·exec·되살리기 세 겹). **이 일은 그것이 실패하거나 데몬이 실제로 죽은 경우**다.
- `docs/internal/DAEMON_SESSION_KEEP_HANDOFF.md` 의 머리 상태 블록 — 요청 1(지금 이 일)이 남은 경위.
- `docs/internal/AGENT_RECORD_DAEMON_SRS.md` — 서버 재시작에도 Run·카드·알람이 남게 한 일(FR-ARD-*).
- `docs/internal/ISSUE_AGENT_TREE_SRS.md`·`ORCHESTRATION_V2_SRS.md` — Run·멤버·승계(`dmctl run succeed`·`launch`), 이슈 트리.
- 코드 출발점:
  - `internal/shared/agentrec/agentrec.go:78` — 훅이 `sessionId` 를 실어 보내는데 **쓰지 않고 버린다**(FR-AGR-9). 여기서 출발한다.
  - `runs.json`(`internal/shared/runfile`) — Run·멤버 기록. 멤버에 `sessionId` 가 없으면 더해야 한다.
  - `tools.json` — 도구 복원 정보(이름·cwd). 상태 복원은 여기에 `{agent, sessionId, cwd}` 를 더하는 쪽이다.
  - `internal/daemon/boot/`(데몬 기동·`tools.json` 의 빈 셸 생성), `internal/shared/toolhub/`, `internal/helper/runtimebin/`(dmctl), `internal/webserver/httpapi/handlers_runs*.go`
  - `dmctl run launch` — 멤버 기동줄(프리앰블)을 만든다. 재개 명령도 이것과 같은 경로를 쓰는지 본다.

## 4. 앞 세션의 권고 (HOT_REBIND_HANDOFF §5 에서 옮김)

- **Run 복구**: `runs.json` 멤버의 `sessionId` 로 재개한다.
- **상태 복원**(Run 밖 에이전트 탭): 도구마다 `{agent, sessionId, cwd}` 를 새로 저장해 쓴다.
- 상태 복원을 먼저 만들고 Run 복구를 그 위에 얹는 것을 권했다. 둘 다 "도구 → 세션 id" 기록이 바탕이기 때문이다.
- 에이전트마다 재개 방법이 다르다(claude 는 `--resume <id>`). 에이전트 등록부(`agents` 관련 코드)에 재개 인자를 둘지 인터뷰 대상이다.

## 5. 앞 세션이 배운 것 (이 저장소의 함정)

- 검사: `make gates > /tmp/g.log 2>&1; echo $?` 처럼 종료 코드를 따로 본다. 커밋 전에 `make gates`, `make lint`, `go test ./...`(httpapi 가 오래 걸리니 바꾼 패키지 먼저), `npm run typecheck`, `npm run unit`, `GOOS=windows go build ./...`, `GOOS=linux go build ./...` 를 돌린다.
- **이음매 게이트**: `runtime.GOOS`, `syscall.Kill`·`SIG*`, `net.Listen("unix")`, `/proc` 직접 읽기, `ps` 실행은 `internal/shared/platform` 밖에 두면 실패한다(시험 파일 포함).
- 새 Go 패키지는 `docs/internal/architecture.md` 패키지 표에 올린다. 홈에 새 파일·폴더를 쓰면 `internal/ctl/cli/homelayout.go` 표와 `docs/external/getting-started.md` 의 홈 표에 함께 올린다(게이트가 잡는다).
- SRS 상태가 `승인·구현중` 이면 바로 아래에 `> **남은 것**: …` 줄이 있어야 한다. 결정(D-)을 고치면 `go run ./scripts/gen-decisions`, 오류 코드를 바꾸면 `go run ./scripts/gen-errors` 를 돌린다.
- 새 API 경로는 `docs/external/api.md` 에, 새 환경변수는 `getting-started.md` 표에(**한 행에 변수 하나**), 새 SSE 이벤트는 `api.md` SSE 표에 적는다.
- 프런트:
  - `web/js/core/app-settings.js` 는 정확히 500줄이다(크기 게이트 경계). 줄을 더하려면 다른 줄을 묶어 자리를 만든다.
  - `localStorage` 는 `PrefStore` 로만 쓴다(`scripts/check-storage.mjs`).
  - i18n 키는 조립하지 말고 리터럴로 쓴다. 한국어 조사는 `{으로로}` 같은 마커를 쓴다.
  - 하네스 vm 안에서 만든 객체는 `JSON.parse(JSON.stringify(x))` 로 바꾼 뒤 견준다. `URL` 은 전역으로 넘겨 줘야 한다.
- `runtimebin` 시험은 `TestMain` 이 `DONGMINAL_HOME` 을 지우고, 물러설 홈(`fallbackHome`)을 빈 임시 폴더로 바꾼다. 서버를 겨눌 때는 `pointAt(t, host, port)` 를 쓴다 — 사용 중인 `~/.dongminal/run/server.addr` 를 읽지 않게 하기 위해서다.
- 자동 보안 검토가 커밋·push 마다 돈다. 새 로컬 API 는 "누가 부를 수 있는가"(expose 상태의 같은 망, 홈을 마운트한 샌드박스 컨테이너, `tailscale serve` 뒤의 원격)를 먼저 따진다. 재개 명령은 에이전트를 띄우는 일이므로 특히 따진다.
- 흔들리는 시험(이번 변경과 무관): `gitapi` 의 `TestWorktreeCreateInputAnswer`, `runtimebin` 의 `TestChatMCPInboxCapAndRead`(10번 중 1번 꼴).

## 6. 지금 상태 (참고)

- HOT_REBIND(포트·expose 를 실행 중에 바꾸기) 네 묶음과 그 뒤 수정은 모두 `main` 에 있다.
  - 커밋: `fa212bb3`·`2145d68e`·`607a0bda`·`30dfac7d`·`0d36723f`
  - 사용자가 다른 컴퓨터에서 확인했고 "잘 된다" 고 했다.
  - SRS 상태는 `승인·구현중` 이고, 남은 것은 e2e 다.
- 그 밖에 이 세션에서 한 일:
  - `eac98a29`: git 잡 버튼이 빈 네모로 보이던 결함 수정
  - `9eaa9ea1`: OTP 도우미 명령의 이름을 `helper` 에서 `otp` 로 바꿈(`helper` 는 별칭)
- 바인드는 이제 `server.json` 하나가 정하고(환경변수 무시), 헬퍼는 `$DONGMINAL_HOME/run/server.addr` 로 서버를 찾는다. 셸에는 `DONGMINAL_PORT` 를 넣지 않는다.
