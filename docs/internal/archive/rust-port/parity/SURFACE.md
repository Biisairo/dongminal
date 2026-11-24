# 관측 표면 목록 (Go 기준선)

이 문서는 Rust 포팅이 같게 만들어야 하는 관측 표면(RUST_PORT_SRS 1.3)을 빠짐없이 적는다. 항목마다 담당 이슈를 단다. 이후 이슈는 자기 ID 를 찾아 무엇이 같아야 하는지 확인한다.

- 기준선: 커밋 `127ff7d9` 를 go1.27.2(GOEXPERIMENT 기본값)로 빌드한 바이너리
- 만든 이슈: 0.3. 근거는 각 표의 Go 파일이다(경로의 `internal/` 은 생략한다)
- 담당 이슈: 그 표면을 Rust 로 만드는 이슈다. "도메인 이슈" 는 응답 내용을 만드는 하위 crate 의 이슈다
- 차분 시나리오: 9절. `rust/parity/run.sh` 가 돌린다
- 이 목록을 다시 만들 때: CLI 는 `ctl/cli/actions.go` 의 `actionsOf()` 와 각 `Parse*`, 헬퍼는 `helper/runtimebin/dispatch.go`·`dmctl.go` 의 표, HTTP 는 `webserver/httpapi/handlers_api.go` 의 `apiRoutes`·`webserver/gitapi/routes.go` 의 `routes`·`webserver/httpapi/server.go` 의 `Handler()`, 홈 파일은 `ctl/cli/homelayout.go` 의 `homeLayout()` 에서 뽑는다

## 1. 제어 CLI (`internal/ctl/cli`, 담당 6.1)

### 1.1 최상위 분기 (`Dispatch`, `ctl/cli/actions.go`)

| 입력 | 결과 |
|---|---|
| 인자 없음, `-h`, `--help`, `help` | `Help()` 를 stdout, 종료 0 |
| `--version` | `version` 액션과 같다 |
| 모르는 액션 | `UnknownAction(name)`(오류 줄 + 전체 도움말)을 stderr, 종료 2 |
| `<액션> -h`·`--help` | 그 액션의 `Usage` 를 stdout, 종료 0 (`settle`) |
| 액션 인자 오류 | 오류 문구를 stderr, 종료 2, 액션을 실행하지 않는다 (`settle`). 모르는 플래그의 문구는 `알 수 없는 옵션: X` + 빈 줄 + 그 액션의 `Usage` 다 |

`dongminal d`·argv0 `dongminald` 는 데몬 진입점이고 액션 목록에 없다(7, 데몬 본체 3.3). 데몬 인자는 `handover.ParseDaemonArgs`(`--handover-fd <n>`, `--handover-version`) 다(2.1).

### 1.2 액션과 옵션

공통 옵션 `--port <1~65535>`·`--home <경로>` 는 `Common.take` 가 읽는다(`--k v`·`--k=v`). 값이 없으면 `--port 에 값이 없습니다`, 포트가 아니면 `--port 값이 포트 번호가 아닙니다: X` 다. 포트는 플래그 > `PORT` > 기본값, 홈은 플래그 > `DONGMINAL_HOME` > `~/.dongminal` 이다.

| 액션 | 옵션 | 실제 실행이 하는 일 | 담당 |
|---|---|---|---|
| `start` | `--expose` `--server-only` `--refresh-daemon` `--isolated` `--foreground` + 공통. `--restart-daemon` 은 없어졌다는 안내 오류, `--server-only`+`--refresh-daemon` 은 함께 못 쓴다 | 서버·데몬 기동. **포트를 쥔 프로세스를 종료한다** | 6.1 |
| `stop` | `--all` + 공통 | 포트의 서버와 데몬 정지 | 6.1 |
| `migrate` | `--dry-run`/`-n` + 공통 | 워크스페이스 스키마 변환 | 6.1 (변환 6.2) |
| `rollback` | `--gen <1이상>` `--file <이름>` `--home <경로>` (공통 파서를 쓰지 않는다, 모르는 인자는 `알 수 없는 인자: "X"`) | `workspace.json` 백업 세대 복원 | 6.1 |
| `window` | 공통 | 돌고 있는 서버에 frameless 창 | 6.1 |
| `backup` | `--out <파일.zip>`(필수) + 공통 | 홈을 zip 으로 | 6.1 |
| `restore` | `<zip>`(하나) `--yes`/`-y` + 공통 | zip 을 홈에 되돌림 | 6.1 |
| `uninstall` | `--dry-run`/`-n` `--yes`/`-y` `--purge` + 공통 | 지울 목록 출력, `--yes` 면 삭제 | 6.1 |
| `service` | `install`(유일한 하위 명령) `--out` + 공통 | launchd·systemd 정의 생성 | 6.1 |
| `update` | `--check` (그 밖은 모두 모르는 옵션) | 최신 판 확인(`--check` 일 때만 네트워크) | 6.1 (확인 2.6) |
| `config` | `show`·`validate`·`get`·`set <port\|expose> <값>`, `--json` + 공통 | 설정 실효값·출처, `server.json` 쓰기 | 6.1 (해석 1.5, 스키마 1.3) |
| `health` | `--daemon` + 공통 | 서버·데몬 상태 확인 | 6.1 |
| `doctor` | `--probe-pty <값>` `--bundle <경로>` + 공통 | 플랫폼 계층 자기 시험 | 6.1 |
| `verify` | `--repo <경로>`(`--k=v` 가능). `--port`·`--home` 은 거절 | 격리 인스턴스 종단 시험 | 6.1 |
| `otp` (옛 이름 `helper`) | `status` `install` `uninstall` `run`, `-h`·`--help`·`help`. 인자 없음 → `Usage` stderr 2, 모르는 하위 명령 → `알 수 없는 하위 명령: X` + `Usage` stderr 2, macOS 가 아니면 `도우미는 아직 macOS 만 된다 (FR-PCH-79)` 1 | 특권 도우미 설치·실행(sudo) | 6.2 |
| `version` | 인자 없음만. `-h`·`--help` 는 Usage, 그 밖은 모르는 옵션 | `dongminal <Version> <GOOS>/<GOARCH> <go 런타임>` | 6.1 (각인 7) |

## 2. 런타임 헬퍼 (`internal/helper/runtimebin`, 담당 6.3)

`cmd/dongminal/main.go` 는 맨 먼저 `runtimebin.Dispatch(os.Args)` 를 부른다. `HelperName(argv[0])` 은 basename 에서 `.exe`·`.com`·`.bat`·`.cmd`(대소문자 무시)만 떼고, 이름이 아래 표에 있으면 헬퍼를 실행한다. 없으면 제어 CLI 로 넘어간다. `dongminald` 판정은 표 밖에서 `main.go` 가 따로 한다(7).

### 2.1 헬퍼 이름

| argv0 | 진입 (Go 파일) | 담당 |
|---|---|---|
| `dmctl` | `runDmctl` (`dmctl.go`) | 6.3 |
| `edit` | `runEdit` (`edit.go`) | 6.3 |
| `download` | `runDownload` (`download.go`) | 6.3 |
| `detach` | `runDetach` (`detach.go`) | 6.3 |
| `open-url` | `runOpenURL` (`openurl.go`) | 6.3 |
| `claude` (`agentadapter.ShimCommands()` 가 더한다) | `runAgentShim` (`claude_shim.go`) | 6.3 (셈 목록은 2.1) |

`chat-mcp` 는 argv0 헬퍼가 아니라 `dmctl chat-mcp` 하위 명령이다. `toolline` 은 명령이 아니라 `list-workspace`·`who-am-i` 의 줄 형식이다(1.2).

### 2.2 `dmctl` 공통 동작

- 인자 없음, `-h`/`--help`/`help` → `dmctlHelp`(`dmctl_help.go`) 를 stdout, 종료 0.
- raw 가 아닌 명령에서 인자 어디든 `-h`/`--help` → 도움말 stdout, 종료 0, 서버에 보내지 않는다.
- 모르는 하위 명령 → 배치 인자 파서 오류가 먼저, 그다음 `--force`/`--background` 검사, 그다음 `unknown command: <cmd>` + 도움말을 stderr, 종료 2.
- 배치 인자 파서(`parseDmctlFlags`): 값 `--at`/`-l` `--name` `--sandbox` `--workdir` `--cwd` `--group` `--after` `--index`, 불리언 `--no-focus`/`-n` `--auto` `--force` `--background`. 오류는 `flag X requires value`·`unknown argument: X` 를 stderr, 종료 2. `--k=` 빈 값은 거절한다.
- raw 명령의 파서(`argSpec.run`, `argparse.go`): 오류는 `<접두어>: flag X requires value`·`<접두어>: unknown argument: X`·`<접두어>: <값 오류>` 를 stderr, 종료 2.
- `/api/commands` 로 보내는 명령: 400 이상이면 본문을 stderr, 연결 오류·`delivered==0`·`timedOut` 이면 종료 1, 성공이면 본문을 stdout.
- 서버 주소: 주소 파일(`run/server.addr`) → `server.json` → 기본값 순서로 요청마다 다시 읽는다. 컨테이너 안(`DONGMINAL_HOST=host.docker.internal`)은 `/run/dongminal/server.addr`, 없으면 `DONGMINAL_PORT`.
- 시간 예산(`budgets.go`): HTTP 기본 10초, 훅 2초, statusline 보고 100ms, account 40초, edge 20초, 셈 3초, 채팅 다이얼 1초(셈 300ms), 안 읽은 글 확인 700ms, `wait` 은 제한 시간 + 10초.

### 2.3 `dmctl` 하위 명령

| 하위 명령 | 인자 | 원격 | 부작용 |
|---|---|---|---|
| `send` | `<action> [json]` (플래그 해석 없음) | POST `/api/commands` | 있음 |
| `list-workspace` | `--json` `--window` `--tab` (일치 없음 → 1) | GET `/api/state`, 필요하면 GET `/api/settings` | 없음 |
| `who-am-i` | `--json` | GET `/api/whoami?toolId=` | 없음 |
| `notify` | `[label]` | 보고 소켓 `report.notify`, 실패하면 POST `/api/tools/attention/set` (+`report.activity`·`/api/tools/activity/set`) | 있음 |
| `activity` | `<agent>`, stdin 훅 JSON, 언제나 0 | `report.activity`→`/api/tools/activity/set`, POST `/api/runs/context` | 있음 |
| `agent-context` | `[<agent>]`, stdin, 언제나 0 | POST `/api/runs/context`, SessionStart 훅 JSON 출력 | 있음 |
| `ctx-hook` | `<agent>`, stdin, 언제나 0 | GET `/api/tools/migration-advice?id=`, `chat.sock` `unread` | 없음 |
| `chat-mcp` | `-h`/`--help` 만. stdio MCP(`initialize` `ping` `tools/list` `tools/call`) | `chat.sock`(hello, `online` `rooms` `create` `direct` `join` `leave` `send`), GET `/api/whoami` | 있음 |
| `read-screen`·`read-output` | `--at`/`-l` `--bytes N` (기본 16384·8192) | GET `/api/tools/output?id=&bytes=[&strip=1]` | 없음 |
| `send-input` | `--at`/`-l` `--execute`/`-x`, 텍스트 또는 `-` | POST `/api/tools/input` | 있음 |
| `msg` | `--to`(필수) `--from`, 텍스트 또는 `-` | POST `/api/tools/message` | 있음 |
| `open-editor` | 배치 인자, `--at`·경로 필수, `--name` | `/api/commands` `openEditorTab` | 있음 |
| `open-url` | `<url>` 하나 | `/api/commands` `openUrl` | 있음 |
| `status` | `--at`/`-l` `--member`(`--at` 과 함께 못 씀) `--json` | GET `/api/tools/activity/get`, `--member` 면 GET `/api/runs/preamble` | 없음 |
| `wait` | `status` 인자 + `--for ready\|done`(필수) `--timeout-ms`. 종료 0·1·2·4(시간 초과)·5(blocked) | GET `/api/tools/activity/wait` (long-poll) | 없음 |
| `run` | 2.4 | `/api/runs*` | 섞임 |
| `edges` | `--json` | GET `/api/edges` | 없음 |
| `edge` | 2.5 | `/api/edges/*` | 있음 |
| `account` | 2.6 | `/api/claude-accounts*` | 섞임 |
| `move-tab`·`move-window`·`move-group` | `--at`(필수) `--before` `--after` `--to` `--index` `--prev` `--next` `--ungroup`(move-window) 중 위치 하나 | `/api/commands` `moveTab`·`moveWindow`·`moveGroup` | 있음 |
| `new-group`·`rename-group`·`delete-group` | `--at` `--name` `--tree owner/repo#N` | `/api/commands` `newGroup`·`renameGroup`·`deleteGroup` | 있음 |
| `list-groups` | `--json` | GET `/api/state` | 없음 |
| `statusline`·`subagent-statusline` | 인자 무시, stdin JSON | `report.usage`·`report.subagents` → `/api/tools/usage`·`/api/tools/subagents`, 사용자 statusLine 명령 실행 | 있음 |
| `split-h`·`split-v` | 배치 인자, `[N]` 은 2 이상 | `/api/commands` `splitH`·`splitV` | 있음 |
| `focus` | `<uuid>` 또는 `--at` | `/api/commands` `focus` | 있음 |
| `rename-tab`·`rename-window` | `--at` + 이름, `--auto`(rename-tab). 3회 재시도 후 `/api/state` 로 확인 | `/api/commands` `renameTab`·`renameWindow` | 있음 |
| `close-tab`·`close-window` | `--at` `--force` `--background` (둘을 함께 주면 2) | `/api/commands` `closeTab`·`closeWindow` | 있음 |
| `new-window`·`new-tab` | 배치 인자 | `/api/commands` `newWindow`·`newTab` | 있음 |
| `window-next`·`window-prev`·`tab-next`·`tab-prev` | 배치 인자 | `/api/commands` 같은 이름 | 있음 |
| `tool-up`·`tool-down`·`tool-left`·`tool-right` | 배치 인자 | `/api/commands` `paneUp`·`paneDown`·`paneLeft`·`paneRight` | 있음 |

### 2.4 `dmctl run <sub>`

인자 없음 → 도움말 stderr, 2. 첫 인자 `-h`/`--help` → 도움말 stdout, 0. 플래그를 먼저 해석하고(오류 접두어 `run <sub>`, 2), 모르는 하위 명령은 `run: 알 수 없는 서브커맨드: X` + 도움말 stderr, 2. 모든 하위 명령이 같은 플래그 집합을 받는다. 값: `--run --member --role --agent --brief --model --at/-l --objective --projection --isolation --window --outcome --summary --files --base --timeout-ms --tree --ref --issue --title --parent --goal --ctx --to`. 불리언: `--force --headless --keep-worktrees --keep-tools --json --text --branch --parallel --no-commit --self --coordinator`.

| sub | 원격 | 부작용 |
|---|---|---|
| `start` | POST `/api/runs` | Run 생성 |
| `member` | POST `/api/runs/members` | 멤버 생성 |
| `launch` | GET `/api/runs/preamble` | 없음 |
| `report` | POST `/api/runs/report` | 있음 |
| `status`·`list` | GET `/api/runs[?id=]` | 없음 |
| `close` | POST `/api/runs/close` | 탭·worktree 정리 |
| `delete` | DELETE `/api/runs/{id}` | 기록 삭제 |
| `graph` | GET `/api/runs/{id}/graph` | 없음 |
| `tree` | GET `/api/runs/tree?ref=` | 없음 |
| `attach`·`detach` | POST `/api/runs/attach`·`/api/runs/detach` | 있음 |
| `team` | GET `/api/runs/team` | 없음 |
| `succeed` | POST `/api/runs/succeed` | 후임 멤버 생성 |
| `handoff` | POST `/api/runs/handoff` | 있음 |
| `assign` | POST `/api/runs/assign` | 있음 |
| `coordinate` | POST `/api/runs/coordinate` | 있음 |
| `recover` | POST `/api/runs/recover` (요청 오류 2, 재개 없음 1) | 에이전트 재개 |

### 2.5 `dmctl edge <sub>`

인자 없음 → 도움말 stderr, 2. `-h`/`--help`/`help` → stdout, 0. 모르는 하위 명령 → `dmctl edge: 모르는 하위 명령 "X"` + 도움말 stderr, 2. 값이 없으면 `X 에 값이 없습니다`, 2. `invite --addr` → POST `/api/edges/invite`, `add <code>` → `/api/edges/add`, `remove <대상>` → `/api/edges/remove`, `notify <대상>` → `/api/edges/notify`.

### 2.6 `dmctl account <sub>`

`edge` 와 같은 분기 규칙이고, 거절은 종료 1 이다. `list`(GET `/api/claude-accounts`), `add`(POST `…/add`), `switch <계정>|--strategy next|next-available|best`(POST `…/switch`), `usage [계정] --refresh --json`, `reset <계정> --program juniper_tide|cedar_ember --grant --yes`(stdin 확인), `auto on|off|status --json`(PUT·GET `…/autoswitch`), `history --limit 1-1000`, `pin <계정>|--clear --tab`, `map <계정> [경로]`, `unmap [경로]`, `maps`(모두 `…/mappings`).

### 2.7 그 밖의 헬퍼

| 헬퍼 | 인자 | 오류·종료 코드 | 원격 |
|---|---|---|---|
| `edit` | `<경로>` | 인자 없음·`-h`·`--help` → 도움말 stdout 0, 파일 없음·디렉터리 → `edit: 파일 없음` 1 | `/api/commands` `openEditorTab {name,filePath}` |
| `download` | `[경로]` | 언제나 0, 도움말 없음 | 없음. stdout 에 `ESC ]777;Download;<절대경로> BEL` |
| `detach` | `--list`/`-l` `--restore`/`-r` `--at` `--run` `--cwd` | `-h` → stdout 0, 값 없음 2, 모르는 인자 `detach: unknown argument: X` + 도움말 2, 조합 오류 2, `DONGMINAL_TOOL_ID` 없음 1 | `detachTab`·`restoreTool`, GET `/api/tools/background`, POST `/api/tools/headless` |
| `open-url` | `<url>` 하나 | `-h` → stdout 0, 인자 수 오류 → 도움말 stderr 2, 400 → 1, 서버 없음 → 로컬로 연다 | `/api/commands` `openUrl` |
| `claude` 셈 | 모두 진짜 `claude` 에 넘긴다 | 진짜 명령 없음 127, execve 실패 126 | POST `/api/claude-accounts/launch`, `chat.sock` 다이얼 300ms, `--settings`·`--plugin-dir`·`--append-system-prompt`·`--mcp-config`·`--allowedTools=mcp__dongminal` 주입, `CLAUDE_CONFIG_DIR` |

## 3. HTTP

### 3.1 최상위 mux (`webserver/httpapi/server.go` `Handler()`, 담당 5.5)

| 경로 | 핸들러 | 담당 |
|---|---|---|
| `/` (정적 자산, 내용 기반 ETag) | `newStaticHandler` (`webserver/httpapi/static.go`) | 5.5, 자산 집합은 7 (`web/embed.go`) |
| `/ws` | `handleWS` (4절) | 5.5 |
| `/api/` | `handleAPI`: `/api/git/` 로 시작하면 gitapi 표만, 아니면 아래 표를 위에서부터 훑는다. 아무것도 맞지 않으면 `httpErr(w, "not found", 404, apierr.CodeNotFound)` | 5.5 (오류 형식 5.1) |
| `/api/commands` | `handleCommandPost` (`commands.go`) | 5.5 |
| `/api/commands/sse` | `handleCommandSSE` (4절) | 5.5 |
| `/api/command-result` | `handleCommandResult` | 5.5 |
| `/api/open-url/where` | `handleOpenURLWhere` (`openurl.go`) | 5.5 |

미들웨어 순서는 로깅 → 접근 게이트(출발지 IP) → 요청 게이트(Origin·Host·Sec-Fetch·Content-Type) → recover → mux 다. 인증 게이트는 없다(5.5).

### 3.2 라우트 표 (`apiRoutes` 와 gitapi `routes`, 226개)

`httproute`(1.3) 의 규칙: 표의 위에서부터 메서드(빈 값이면 아무 메서드)와 경로 일치를 보고 처음 맞는 것을 부른다. "접두 `…`" 는 `Under(prefix)`·`UnderWith(prefix, suffix)` 이다. 경로가 같고 메서드가 다른 행은 서로 다른 라우트다. gitapi 의 일부 핸들러는 `needGit` 로 감싸여 git 이 없으면 거절한다.

| 메서드 | 경로 | 일치 | 핸들러 (Go 파일:줄) | 담당 | 도메인 이슈 |
|---|---|---|---|---|---|
| GET | `/api/state` | 정확 | `apiStateGet` (webserver/httpapi/handlers_api.go:311) | 5.5 | — |
| GET | `/api/snapshot` | 정확 | `apiSnapshot` (webserver/httpapi/handlers_snapshot.go:49) | 5.5 | — |
| GET | `/api/whoami` | 정확 | `apiWhoAmI` (webserver/httpapi/handlers_whoami.go:13) | 5.5 | — |
| POST | `/api/tools` | 정확 | `apiToolsCreate` (webserver/httpapi/handlers_api.go:352) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/attention` | 정확 | `apiToolsAttention` (webserver/httpapi/handlers_attention.go:23) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/attention/set` | 정확 | `apiToolAttentionSet` (webserver/httpapi/handlers_attention.go:32) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/attention/clear` | 정확 | `apiToolAttentionClear` (webserver/httpapi/handlers_attention.go:67) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/attention/clear-all` | 정확 | `apiToolAttentionClearAll` (webserver/httpapi/handlers_attention.go:89) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/attention/claim` | 정확 | `apiToolAttentionClaim` (webserver/httpapi/attention_claim.go:100) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/activity` | 정확 | `apiToolsActivity` (webserver/httpapi/handlers_attention.go:96) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/output` | 정확 | `apiToolOutput` (webserver/httpapi/handlers_toolio.go:60) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/input` | 정확 | `apiToolInput` (webserver/httpapi/handlers_toolio.go:93) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/message` | 정확 | `apiToolMessage` (webserver/httpapi/handlers_toolio.go:129) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/background` | 정확 | `apiToolsBackground` (webserver/httpapi/handlers_attention.go:198) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/background/set` | 정확 | `apiToolBackgroundSet` (webserver/httpapi/handlers_attention.go:226) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/activity/set` | 정확 | `apiToolActivitySet` (webserver/httpapi/handlers_attention.go:105) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/activity/get` | 정확 | `apiToolStatus` (webserver/httpapi/handlers_status.go:234) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/migration-advice` | 정확 | `apiMigrationAdvice` (webserver/httpapi/handlers_migration_advice.go:114) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/activity/wait` | 정확 | `apiToolStatusWait` (webserver/httpapi/handlers_status.go:255) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/usage` | 정확 | `apiToolUsage` (webserver/httpapi/handlers_usage.go:80) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/subagents` | 정확 | `apiToolSubagents` (webserver/httpapi/handlers_subagents.go:73) | 5.5 | 5.2·5.3 |
| GET | `/api/runs` | 정확 | `apiRunsGet` (webserver/httpapi/handlers_runs.go:215) | 5.5 | 4.4 |
| POST | `/api/runs` | 정확 | `apiRunStart` (webserver/httpapi/handlers_runs.go:237) | 5.5 | 4.4 |
| POST | `/api/runs/members` | 정확 | `apiRunMemberAdd` (webserver/httpapi/handlers_runs.go:305) | 5.5 | 4.4 |
| POST | `/api/runs/report` | 정확 | `apiRunReport` (webserver/httpapi/handlers_runs.go:510) | 5.5 | 4.4 |
| POST | `/api/runs/close` | 정확 | `apiRunClose` (webserver/httpapi/handlers_runs_close.go:26) | 5.5 | 4.4 |
| GET | `/api/runs/preamble` | 정확 | `apiRunPreamble` (webserver/httpapi/handlers_runs.go:437) | 5.5 | 4.4 |
| GET | `/api/runs/team` | 정확 | `apiRunTeam` (webserver/httpapi/handlers_runs_team.go:42) | 5.5 | 4.4 |
| POST | `/api/runs/attach` | 정확 | `apiRunAttach` (webserver/httpapi/handlers_runs_headless.go:125) | 5.5 | 4.4 |
| POST | `/api/runs/detach` | 정확 | `apiRunDetach` (webserver/httpapi/handlers_runs_headless.go:192) | 5.5 | 4.4 |
| POST | `/api/runs/succeed` | 정확 | `apiRunSucceed` (webserver/httpapi/handlers_runs_context.go:295) | 5.5 | 4.4 |
| POST | `/api/runs/handoff` | 정확 | `apiRunHandoff` (webserver/httpapi/handlers_runs_context.go:519) | 5.5 | 4.4 |
| POST | `/api/runs/assign` | 정확 | `apiRunAssign` (webserver/httpapi/handlers_runs_assign.go:125) | 5.5 | 4.4 |
| POST | `/api/runs/coordinate` | 정확 | `apiRunCoordinate` (webserver/httpapi/handlers_runs_tree.go:288) | 5.5 | 4.4 |
| POST | `/api/runs/recover` | 정확 | `apiRunRecover` (webserver/httpapi/handlers_runs_recover.go:242) | 5.5 | 4.4 |
| GET | `/api/runs/tree` | 정확 | `apiRunsTree` (webserver/httpapi/handlers_runs_tree.go:131) | 5.5 | 4.4 |
| POST | `/api/runs/context` | 정확 | `apiRunContext` (webserver/httpapi/handlers_runs_context.go:134) | 5.5 | 4.4 |
| POST | `/api/tools/headless` | 정확 | `apiToolsHeadless` (webserver/httpapi/handlers_runs_headless.go:47) | 5.5 | 5.2·5.3 |
| POST | `/api/tools/kill` | 정확 | `apiToolKill` (webserver/httpapi/handlers_tools_kill.go:27) | 5.5 | 5.2·5.3 |
| GET | `/api/runs/…/graph` | 접두 `…` | `apiRunGraph` (webserver/httpapi/handlers_runs_graph.go:148) | 5.5 | 4.4 |
| DELETE | `/api/runs/…` | 접두 `…` | `apiRunDelete` (webserver/httpapi/handlers_runs_delete.go:29) | 5.5 | 4.4 |
| GET | `/api/tools/busy` | 정확 | `apiToolsBusy` (webserver/httpapi/handlers_api.go:425) | 5.5 | 5.2·5.3 |
| GET | `/api/tools/…/busy` | 접두 `…` | `apiToolBusy` (webserver/httpapi/handlers_api.go:410) | 5.5 | 5.2·5.3 |
| DELETE | `/api/tools/…` | 접두 `…` | `apiToolDelete` (webserver/httpapi/handlers_api.go:448) | 5.5 | 5.2·5.3 |
| GET | `/api/focus` | 정확 | `apiFocusGet` (webserver/httpapi/focus.go:23) | 5.5 | — |
| POST | `/api/focus/claim` | 정확 | `apiFocusClaim` (webserver/httpapi/focus.go:33) | 5.5 | — |
| GET | `/api/sandbox/profiles` | 정확 | `apiSandboxProfiles` (webserver/httpapi/handlers_api.go:572) | 5.5 | 2.5 |
| GET | `/api/sandbox/runtime` | 정확 | `apiSandboxRuntime` (webserver/httpapi/handlers_api.go:599) | 5.5 | 2.5 |
| POST | `/api/sandbox/runtime/start` | 정확 | `apiSandboxRuntimeStart` (webserver/httpapi/handlers_api.go:647) | 5.5 | 2.5 |
| GET | `/api/sandbox/config` | 정확 | `apiSandboxConfigGet` (webserver/httpapi/handlers_api.go:653) | 5.5 | 2.5 |
| PUT | `/api/sandbox/config` | 정확 | `apiSandboxConfigPut` (webserver/httpapi/handlers_api.go:671) | 5.5 | 2.5 |
| GET | `/api/workspace` | 정확 | `apiWorkspaceGet` (webserver/httpapi/handlers_api.go:461) | 5.5 | 1.5 |
| GET | `/api/meta` | 정확 | `apiMeta` (webserver/httpapi/entity_name.go:62) | 5.5 | — |
| PUT | `/api/workspace` | 정확 | `apiWorkspacePut` (webserver/httpapi/handlers_api.go:476) | 5.5 | 1.5 |
| GET | `/api/settings` | 정확 | `apiSettingsGet` (webserver/httpapi/handlers_settings.go:123) | 5.5 | 1.3 |
| PUT | `/api/settings` | 정확 | `apiSettingsPut` (webserver/httpapi/handlers_settings.go:155) | 5.5 | 1.3 |
| GET | `/api/server/bind` | 정확 | `apiServerBindGet` (webserver/httpapi/rebind.go:141) | 5.5 | — |
| POST | `/api/server/bind` | 정확 | `apiServerBind` (webserver/httpapi/rebind.go:158) | 5.5 | — |
| POST | `/api/server/carry` | 정확 | `apiServerCarryPost` (webserver/httpapi/carry.go:82) | 5.5 | — |
| GET | `/api/server/carry/…` | 접두 `…` | `apiServerCarryGet` (webserver/httpapi/carry.go:101) | 5.5 | — |
| GET | `/api/update` | 정확 | `apiUpdateGet` (webserver/httpapi/handlers_update.go:18) | 5.5 | 2.6 |
| PUT | `/api/update` | 정확 | `apiUpdatePut` (webserver/httpapi/handlers_update.go:30) | 5.5 | 2.6 |
| GET | `/api/access` | 정확 | `apiAccessGet` (webserver/httpapi/access_api.go:87) | 5.5 | 1.5 |
| PUT | `/api/access` | 정확 | `apiAccessPut` (webserver/httpapi/access_api.go:106) | 5.5 | 1.5 |
| POST | `/api/access/check` | 정확 | `apiAccessCheck` (webserver/httpapi/access_api.go:161) | 5.5 | 1.5 |
| POST | `/api/upload` | 정확 | `apiUpload` (webserver/httpapi/handlers_files_transfer.go:96) | 5.5 | — |
| GET | `/api/download` | 정확 | `apiDownload` (webserver/httpapi/handlers_files_transfer.go:239) | 5.5 | — |
| GET | `/api/cwd` | 정확 | `apiCwd` (webserver/httpapi/handlers_files_transfer.go:261) | 5.5 | — |
| GET | `/api/file/read` | 정확 | `apiFileRead` (webserver/httpapi/handlers_files_rw.go:25) | 5.5 | 1.2 |
| POST | `/api/file/write` | 정확 | `apiFileWrite` (webserver/httpapi/handlers_files_rw.go:96) | 5.5 | 1.2 |
| POST | `/api/file/stamps` | 정확 | `apiFileStamps` (webserver/httpapi/handlers_files_stamp.go:67) | 5.5 | 1.2 |
| GET | `/api/file/probe` | 정확 | `apiFileProbe` (webserver/httpapi/handlers_file_probe.go:118) | 5.5 | 1.2 |
| GET | `/api/file/raw` | 정확 | `apiFileRaw` (webserver/httpapi/handlers_file_probe.go:150) | 5.5 | 1.2 |
| GET | `/api/fs/list` | 정확 | `apiFSList` (webserver/httpapi/handlers_fs.go:298) | 5.5 | 4.7 |
| POST | `/api/fs/stamp` | 정확 | `apiFSStamp` (webserver/httpapi/handlers_fs_stamp.go:58) | 5.5 | 4.7 |
| POST | `/api/fs/stamps` | 정확 | `apiFSStamps` (webserver/httpapi/handlers_fs_stamp.go:107) | 5.5 | 4.7 |
| PUT | `/api/fs/watch` | 정확 | `apiFSWatch` (webserver/httpapi/handlers_fs_watch.go:32) | 5.5 | 4.7 |
| GET | `/api/fs/find` | 정확 | `apiFSFind` (webserver/httpapi/handlers_fs_search.go:89) | 5.5 | 4.7 |
| GET | `/api/fs/grep` | 정확 | `apiFSGrep` (webserver/httpapi/handlers_fs_search.go:191) | 5.5 | 4.7 |
| POST | `/api/fs/ignored` | 정확 | `apiFSIgnored` (webserver/httpapi/handlers_fs_ignored.go:46) | 5.5 | 4.7 |
| POST | `/api/fs/create` | 정확 | `apiFSCreate` (webserver/httpapi/handlers_fs.go:391) | 5.5 | 4.7 |
| POST | `/api/fs/rename` | 정확 | `apiFSRename` (webserver/httpapi/handlers_fs_mutate.go:45) | 5.5 | 4.7 |
| POST | `/api/fs/delete` | 정확 | `apiFSDelete` (webserver/httpapi/handlers_fs_mutate.go:186) | 5.5 | 4.7 |
| POST | `/api/fs/actions` | 정확 | `apiFSActions` (webserver/httpapi/handlers_fs_actions.go:27) | 5.5 | 4.7 |
| POST | `/api/fs/validate-name` | 정확 | `apiFSValidateName` (webserver/httpapi/handlers_fs_actions.go:162) | 5.5 | 4.7 |
| POST | `/api/fs/copy` | 정확 | `apiFSCopy` (webserver/httpapi/handlers_fs_copy.go:44) | 5.5 | 4.7 |
| GET | `/api/fs/download` | 정확 | `apiFSDownload` (webserver/httpapi/handlers_fs_transfer.go:11) | 5.5 | 4.7 |
| GET | `/api/fs/download-dir` | 정확 | `apiFSDownloadDir` (webserver/httpapi/handlers_fs_zip.go:32) | 5.5 | 4.7 |
| GET | `/api/fs/download-many` | 정확 | `apiFSDownloadMany` (webserver/httpapi/handlers_fs_zip.go:82) | 5.5 | 4.7 |
| POST | `/api/fs/upload` | 정확 | `apiFSUpload` (webserver/httpapi/handlers_fs_transfer.go:30) | 5.5 | 4.7 |
| POST | `/api/lsp/status` | 정확 | `apiLSPStatus` (webserver/httpapi/handlers_lsp.go:64) | 5.5 | 4.6 |
| GET | `/api/lsp/paths` | 정확 | `apiLSPPathsGet` (webserver/httpapi/handlers_lsp.go:109) | 5.5 | 4.6 |
| PUT | `/api/lsp/paths` | 정확 | `apiLSPPathsPut` (webserver/httpapi/handlers_lsp.go:122) | 5.5 | 4.6 |
| POST | `/api/lsp/install` | 정확 | `apiLSPInstall` (webserver/httpapi/handlers_lsp.go:87) | 5.5 | 4.6 |
| GET | `/api/lsp/ws` | 정확 | `apiLSPWS` (webserver/httpapi/handlers_lsp_ws.go:48) | 5.5 | 4.6 |
| GET | `/api/editors` | 정확 | `apiEditorsGet` (webserver/httpapi/handlers_editors.go:28) | 5.5 | 1.2 |
| POST | `/api/editors/add` | 정확 | `apiEditorsAdd` (webserver/httpapi/handlers_editors.go:61) | 5.5 | 1.2 |
| POST | `/api/editors/validate` | 정확 | `apiEditorsValidate` (webserver/httpapi/handlers_editors.go:138) | 5.5 | 1.2 |
| POST | `/api/editors/remove` | 정확 | `apiEditorsRemove` (webserver/httpapi/handlers_editors.go:84) | 5.5 | 1.2 |
| POST | `/api/editors/reorder` | 정확 | `apiEditorsReorder` (webserver/httpapi/handlers_editors.go:111) | 5.5 | 1.2 |
| * | `/api/ping` | 정확 | `apiPing` (webserver/httpapi/handlers_api.go:533) | 5.5 | — |
| GET | `/api/health` | 정확 | `apiHealth` (webserver/httpapi/handlers_health.go:55) | 5.5 | — |
| GET | `/api/diag` | 정확 | `apiDiag` (webserver/httpapi/handlers_diag.go:59) | 5.5 | — |
| GET | `/api/workspace/revisions` | 정확 | `apiWorkspaceRevisions` (webserver/httpapi/handlers_workspace_revert.go:49) | 5.5 | 1.5 |
| POST | `/api/workspace/revert` | 정확 | `apiWorkspaceRevert` (webserver/httpapi/handlers_workspace_revert.go:70) | 5.5 | 1.5 |
| GET | `/api/stats` | 정확 | `apiStats` (webserver/httpapi/handlers_api.go:540) | 5.5 | 1.2 |
| GET | `/api/chat` | 정확 | `apiChatGet` (webserver/httpapi/chat_api.go:36) | 5.5 | 3.1 |
| POST | `/api/chat/create` | 정확 | `apiChatCreate` (webserver/httpapi/chat_api.go:37) | 5.5 | 3.1 |
| POST | `/api/chat/direct` | 정확 | `apiChatDirect` (webserver/httpapi/chat_api.go:40) | 5.5 | 3.1 |
| POST | `/api/chat/join` | 정확 | `apiChatJoin` (webserver/httpapi/chat_api.go:43) | 5.5 | 3.1 |
| POST | `/api/chat/leave` | 정확 | `apiChatLeave` (webserver/httpapi/chat_api.go:44) | 5.5 | 3.1 |
| POST | `/api/chat/send` | 정확 | `apiChatSend` (webserver/httpapi/chat_api.go:47) | 5.5 | 3.1 |
| POST | `/api/chat/kill` | 정확 | `apiChatKill` (webserver/httpapi/chat_api.go:50) | 5.5 | 3.1 |
| POST | `/api/chat/kick` | 정확 | `apiChatKick` (webserver/httpapi/chat_api.go:51) | 5.5 | 3.1 |
| GET | `/api/edges` | 정확 | `apiEdgesGet` (webserver/httpapi/edge_api.go:72) | 5.5 | 2.3·2.4 |
| PUT | `/api/edges/node` | 정확 | `apiEdgesNodePut` (webserver/httpapi/edge_api.go:75) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/invite` | 정확 | `apiEdgesInvite` (webserver/httpapi/edge_api.go:79) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/add` | 정확 | `apiEdgesAdd` (webserver/httpapi/edge_api.go:82) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/remove` | 정확 | `apiEdgesRemove` (webserver/httpapi/edge_api.go:83) | 5.5 | 2.3·2.4 |
| PUT | `/api/edges/address` | 정확 | `apiEdgesAddress` (webserver/httpapi/edge_api.go:86) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/notify` | 정확 | `apiEdgesNotify` (webserver/httpapi/edge_api.go:91) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/invite/send` | 정확 | `apiEdgesInviteSend` (webserver/httpapi/edge_api.go:94) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/invite/accept` | 정확 | `apiEdgesInviteAccept` (webserver/httpapi/edge_api.go:97) | 5.5 | 2.3·2.4 |
| POST | `/api/edges/invite/reject` | 정확 | `apiEdgesInviteReject` (webserver/httpapi/edge_api.go:100) | 5.5 | 2.3·2.4 |
| GET | `/api/profile` | 정확 | `apiProfileGet` (webserver/httpapi/profile_api.go:14) | 5.5 | — |
| PUT | `/api/profile` | 정확 | `apiProfilePut` (webserver/httpapi/profile_api.go:18) | 5.5 | — |
| GET | `/api/claude-accounts` | 정확 | `apiClaudeAccountsList` (webserver/httpapi/claude_accounts_api.go:79) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/add` | 정확 | `apiClaudeAccountsAdd` (webserver/httpapi/claude_accounts_api.go:108) | 5.5 | 4.5 |
| PUT | `/api/claude-accounts/item` | 정확 | `apiClaudeAccountsItem` (webserver/httpapi/claude_accounts_api.go:127) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/remove` | 정확 | `apiClaudeAccountsRemove` (webserver/httpapi/claude_accounts_api.go:144) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/order` | 정확 | `apiClaudeAccountsOrder` (webserver/httpapi/claude_accounts_api.go:162) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/switch` | 정확 | `apiClaudeAccountsSwitch` (webserver/httpapi/claude_accounts_api.go:180) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/refresh` | 정확 | `apiClaudeAccountsRefresh` (webserver/httpapi/claude_accounts_api.go:205) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/reset` | 정확 | `apiClaudeAccountsReset` (webserver/httpapi/claude_accounts_api.go:229) | 5.5 | 4.5 |
| GET | `/api/claude-accounts/history` | 정확 | `apiClaudeAccountsHistory` (webserver/httpapi/claude_accounts_api.go:251) | 5.5 | 4.5 |
| GET | `/api/claude-accounts/autoswitch` | 정확 | `apiClaudeAccountsAutoswitchGet` (webserver/httpapi/claude_accounts_api.go:273) | 5.5 | 4.5 |
| PUT | `/api/claude-accounts/autoswitch` | 정확 | `apiClaudeAccountsAutoswitchPut` (webserver/httpapi/claude_accounts_api.go:281) | 5.5 | 4.5 |
| GET | `/api/claude-accounts/mappings` | 정확 | `apiClaudeAccountsMappingsGet` (webserver/httpapi/claude_accounts_mappings.go:46) | 5.5 | 4.5 |
| PUT | `/api/claude-accounts/mappings` | 정확 | `apiClaudeAccountsMappingsPut` (webserver/httpapi/claude_accounts_mappings.go:55) | 5.5 | 4.5 |
| GET | `/api/claude-accounts/resolve` | 정확 | `apiClaudeAccountsResolve` (webserver/httpapi/claude_accounts_mappings.go:86) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/launch` | 정확 | `apiClaudeAccountsLaunch` (webserver/httpapi/claude_accounts_mappings.go:101) | 5.5 | 4.5 |
| GET | `/api/claude-accounts/unclaimed` | 정확 | `apiClaudeAccountsUnclaimed` (webserver/httpapi/claude_accounts_mappings.go:140) | 5.5 | 4.5 |
| POST | `/api/claude-accounts/unclaimed/remove` | 정확 | `apiClaudeAccountsUnclaimedRemove` (webserver/httpapi/claude_accounts_mappings.go:147) | 5.5 | 4.5 |
| GET | `/api/telegram` | 정확 | `apiTelegramGet` (webserver/httpapi/telegram_api.go:63) | 5.5 | 4.7 |
| PUT | `/api/telegram/token` | 정확 | `apiTelegramToken` (webserver/httpapi/telegram_api.go:72) | 5.5 | 4.7 |
| PUT | `/api/telegram/enabled` | 정확 | `apiTelegramEnabled` (webserver/httpapi/telegram_api.go:104) | 5.5 | 4.7 |
| PUT | `/api/telegram/silence` | 정확 | `apiTelegramSilence` (webserver/httpapi/telegram_api.go:117) | 5.5 | 4.7 |
| POST | `/api/telegram/pair` | 정확 | `apiTelegramPair` (webserver/httpapi/telegram_api.go:131) | 5.5 | 4.7 |
| DELETE | `/api/telegram/pair` | 정확 | `apiTelegramUnpair` (webserver/httpapi/telegram_api.go:148) | 5.5 | 4.7 |
| GET | `/api/git/repos` | 정확 | `apiGitRepos` (webserver/gitapi/handlers_git.go:106) | 5.4 | 4.1 |
| POST | `/api/git/init` | 정확 | `apiGitInit` (webserver/gitapi/handlers_git_init.go:24) | 5.4 | 4.2 |
| POST | `/api/git/repos/pin` | 정확 | `apiGitPin` (webserver/gitapi/handlers_git.go:287) | 5.4 | 4.2 |
| POST | `/api/git/repos/unpin` | 정확 | `apiGitUnpin` (webserver/gitapi/handlers_git.go:321) | 5.4 | 4.2 |
| GET | `/api/git/status` | 정확 | `apiGitStatus` (webserver/gitapi/handlers_git.go:356) | 5.4 | 4.1 |
| GET | `/api/git/signature` | 정확 | `apiGitSignature` (webserver/gitapi/handlers_git.go:502) | 5.4 | 4.1 |
| GET | `/api/git/diff-content` | 정확 | `apiGitDiffContent` (webserver/gitapi/handlers_git.go:545) | 5.4 | 4.1 |
| GET | `/api/git/blob` | 정확 | `apiGitBlob` (webserver/gitapi/handlers_git_blob.go:24) | 5.4 | 4.1 |
| GET | `/api/git/preflight` | 정확 | `apiGitPreflight` (webserver/gitapi/handlers_git_policy.go:19) | 5.4 | 4.1 |
| GET | `/api/git/policy` | 정확 | `apiGitPolicy` (webserver/gitapi/handlers_git_policy.go:40) | 5.4 | 4.1 |
| GET | `/api/git/recovery` | 정확 | `apiGitRecovery` (webserver/gitapi/handlers_git_policy.go:68) | 5.4 | 4.1 |
| POST | `/api/git/stage` | 정확 | `apiGitStage` (webserver/gitapi/handlers_git_write.go:81) | 5.4 | 4.2 |
| POST | `/api/git/unstage` | 정확 | `apiGitUnstage` (webserver/gitapi/handlers_git_write.go:101) | 5.4 | 4.2 |
| POST | `/api/git/discard` | 정확 | `apiGitDiscard` (webserver/gitapi/handlers_git_write.go:124) | 5.4 | 4.2 |
| POST | `/api/git/resolve` | 정확 | `apiGitResolve` (webserver/gitapi/handlers_git_write.go:138) | 5.4 | 4.2 |
| POST | `/api/git/commit` | 정확 | `apiGitCommitCreate` (webserver/gitapi/handlers_git_write.go:207) | 5.4 | 4.2 |
| POST | `/api/git/undo-last` | 정확 | `apiGitUndoLast` (webserver/gitapi/handlers_git_write.go:303) | 5.4 | 4.2 |
| GET | `/api/git/log` | 정확 | `apiGitLog` (webserver/gitapi/handlers_git_history.go:118) | 5.4 | 4.1 |
| GET | `/api/git/blame` | 정확 | `apiGitBlame` (webserver/gitapi/handlers_git_blame.go:26) | 5.4 | 4.1 |
| GET | `/api/git/commit` | 정확 | `apiGitCommit` (webserver/gitapi/handlers_git_history.go:240) | 5.4 | 4.1 |
| GET | `/api/git/refs` | 정확 | `apiGitRefs` (webserver/gitapi/handlers_git_history.go:275) | 5.4 | 4.1 |
| GET | `/api/git/records` | 정확 | `apiGitRecords` (webserver/gitapi/handlers_git_records.go:50) | 5.4 | 4.1 |
| POST | `/api/git/records/replay` | 정확 | `apiGitReplay` (webserver/gitapi/handlers_git_replay.go:35) | 5.4 | 4.2 |
| POST | `/api/git/fetch` | 정확 | `apiGitFetch` (webserver/gitapi/handlers_git_remote.go:116) | 5.4 | 4.2 |
| POST | `/api/git/pull` | 정확 | `apiGitPull` (webserver/gitapi/handlers_git_remote.go:127) | 5.4 | 4.2 |
| POST | `/api/git/push` | 정확 | `apiGitPush` (webserver/gitapi/handlers_git_remote.go:144) | 5.4 | 4.2 |
| POST | `/api/git/job/cancel` | 정확 | `apiGitJobCancel` (webserver/gitapi/handlers_git_remote.go:301) | 5.4 | 4.2 |
| GET | `/api/git/job/events` | 정확 | `apiGitJobEvents` (webserver/gitapi/handlers_git_remote.go:329) | 5.4 | 4.2 |
| GET | `/api/git/jobs` | 정확 | `apiGitJobs` (webserver/gitapi/handlers_git_remote.go:321) | 5.4 | 4.2 |
| GET | `/api/git/remotes` | 정확 | `apiGitRemotes` (webserver/gitapi/handlers_git_remote.go:430) | 5.4 | 4.1 |
| POST | `/api/git/remote/add` | 정확 | `apiGitRemoteAdd` (webserver/gitapi/handlers_git_remote.go:448) | 5.4 | 4.2 |
| POST | `/api/git/remote/remove` | 정확 | `apiGitRemoteRemove` (webserver/gitapi/handlers_git_remote.go:464) | 5.4 | 4.2 |
| POST | `/api/git/checkout` | 정확 | `apiGitCheckout` (webserver/gitapi/handlers_git_branch.go:53) | 5.4 | 4.2 |
| POST | `/api/git/operation` | 정확 | `apiGitOperation` (webserver/gitapi/handlers_git_operation.go:35) | 5.4 | 4.2 |
| POST | `/api/git/branch` | 정확 | `apiGitBranchCreate` (webserver/gitapi/handlers_git_branch.go:101) | 5.4 | 4.2 |
| GET | `/api/git/actions` | 정확 | `apiGitActions` (webserver/gitapi/handlers_git_actions.go:22) | 5.4 | 4.1 |
| GET | `/api/git/branch/validate` | 정확 | `apiGitBranchValidate` (webserver/gitapi/handlers_git_branch.go:135) | 5.4 | 4.1 |
| POST | `/api/git/branch/rename` | 정확 | `apiGitBranchRename` (webserver/gitapi/handlers_git_branch.go:294) | 5.4 | 4.2 |
| POST | `/api/git/branch/delete` | 정확 | `apiGitBranchDelete` (webserver/gitapi/handlers_git_branch.go:322) | 5.4 | 4.2 |
| POST | `/api/git/branch/merge` | 정확 | `apiGitBranchMerge` (webserver/gitapi/handlers_git_branch.go:409) | 5.4 | 4.2 |
| POST | `/api/git/branch/rebase` | 정확 | `apiGitBranchRebase` (webserver/gitapi/handlers_git_branch.go:431) | 5.4 | 4.2 |
| POST | `/api/git/branch/upstream` | 정확 | `apiGitBranchUpstream` (webserver/gitapi/handlers_git_branch.go:460) | 5.4 | 4.2 |
| GET | `/api/git/branch/merge-preview` | 정확 | `apiGitBranchMergePreview` (webserver/gitapi/handlers_git_branch.go:491) | 5.4 | 4.1 |
| POST | `/api/git/branch/push` | 정확 | `apiGitBranchPush` (webserver/gitapi/handlers_git_branch.go:518) | 5.4 | 4.2 |
| POST | `/api/git/branch/fetch` | 정확 | `apiGitBranchFetchInto` (webserver/gitapi/handlers_git_branch.go:540) | 5.4 | 4.2 |
| POST | `/api/git/branch/delete-both` | 정확 | `apiGitBranchDeleteBoth` (webserver/gitapi/handlers_git_actions_branch.go:299) | 5.4 | 4.2 |
| POST | `/api/git/branch/delete-remote` | 정확 | `apiGitBranchDeleteRemote` (webserver/gitapi/handlers_git_branch.go:564) | 5.4 | 4.2 |
| GET | `/api/git/stash` | 정확 | `apiGitStashList` (webserver/gitapi/handlers_git_stash.go:76) | 5.4 | 4.1 |
| GET | `/api/git/stash/show` | 정확 | `apiGitStashShow` (webserver/gitapi/handlers_git_stash.go:95) | 5.4 | 4.1 |
| POST | `/api/git/stash/push` | 정확 | `apiGitStashPush` (webserver/gitapi/handlers_git_stash.go:134) | 5.4 | 4.2 |
| POST | `/api/git/stash/apply` | 정확 | `apiGitStashApply` (webserver/gitapi/handlers_git_stash.go:165) | 5.4 | 4.2 |
| POST | `/api/git/stash/pop` | 정확 | `apiGitStashPop` (webserver/gitapi/handlers_git_stash.go:176) | 5.4 | 4.2 |
| POST | `/api/git/stash/drop` | 정확 | `apiGitStashDrop` (webserver/gitapi/handlers_git_stash.go:187) | 5.4 | 4.2 |
| POST | `/api/git/tag` | 정확 | `apiGitTagCreate` (webserver/gitapi/handlers_git_tag.go:64) | 5.4 | 4.2 |
| GET | `/api/git/tag/validate` | 정확 | `apiGitTagValidate` (webserver/gitapi/handlers_git_tag.go:154) | 5.4 | 4.1 |
| POST | `/api/git/tag/delete` | 정확 | `apiGitTagDelete` (webserver/gitapi/handlers_git_tag.go:95) | 5.4 | 4.2 |
| POST | `/api/git/tag/push` | 정확 | `apiGitTagPush` (webserver/gitapi/handlers_git_tag.go:128) | 5.4 | 4.2 |
| POST | `/api/git/tag/delete-remote` | 정확 | `apiGitTagDeleteRemote` (webserver/gitapi/handlers_git_tag.go:139) | 5.4 | 4.2 |
| POST | `/api/git/stash/branch` | 정확 | `apiGitStashBranch` (webserver/gitapi/handlers_git_stash.go:218) | 5.4 | 4.2 |
| POST | `/api/git/ignore` | 정확 | `apiGitIgnoreAdd` (webserver/gitapi/handlers_git_ignore.go:79) | 5.4 | 4.2 |
| GET | `/api/git/file-head` | 정확 | `apiGitFileHead` (webserver/gitapi/handlers_git_ignore.go:118) | 5.4 | 4.1 |
| POST | `/api/git/uncommitted/reset` | 정확 | `apiGitUncommittedReset` (webserver/gitapi/handlers_git_uncommitted.go:36) | 5.4 | 4.2 |
| POST | `/api/git/uncommitted/clean` | 정확 | `apiGitUncommittedClean` (webserver/gitapi/handlers_git_uncommitted.go:51) | 5.4 | 4.2 |
| GET | `/api/git/hunks` | 정확 | `apiGitHunks` (webserver/gitapi/handlers_git_patch.go:63) | 5.4 | 4.1 |
| POST | `/api/git/patch` | 정확 | `apiGitPatch` (webserver/gitapi/handlers_git_patch.go:82) | 5.4 | 4.2 |
| POST | `/api/git/cherry-pick` | 정확 | `apiGitCherryPick` (webserver/gitapi/handlers_git_commit_ops.go:61) | 5.4 | 4.2 |
| POST | `/api/git/revert` | 정확 | `apiGitRevert` (webserver/gitapi/handlers_git_commit_ops.go:66) | 5.4 | 4.2 |
| POST | `/api/git/reset` | 정확 | `apiGitReset` (webserver/gitapi/handlers_git_commit_ops.go:113) | 5.4 | 4.2 |
| POST | `/api/git/drop` | 정확 | `apiGitDrop` (webserver/gitapi/handlers_git_commit_ops.go:149) | 5.4 | 4.2 |
| GET | `/api/git/commit-range` | 정확 | `apiGitCommitRange` (webserver/gitapi/handlers_git_commit_ops.go:195) | 5.4 | 4.1 |
| GET | `/api/git/submodules` | 정확 | `apiGitSubmodules` (webserver/gitapi/handlers_git_submodule.go:70) | 5.4 | 4.3 |
| POST | `/api/git/submodules/update` | 정확 | `apiGitSubmoduleUpdate` (webserver/gitapi/handlers_git_submodule.go:136) | 5.4 | 4.3 |
| POST | `/api/git/submodules/sync` | 정확 | `apiGitSubmoduleSync` (webserver/gitapi/handlers_git_submodule.go:157) | 5.4 | 4.3 |
| GET | `/api/git/worktrees` | 정확 | `apiGitWorktrees` (webserver/gitapi/handlers_git_worktree.go:84) | 5.4 | 4.3 |
| POST | `/api/git/worktrees/create` | 정확 | `apiGitWorktreeCreate` (webserver/gitapi/handlers_git_worktree.go:156) | 5.4 | 4.3 |
| POST | `/api/git/worktrees/remove` | 정확 | `apiGitWorktreeRemove` (webserver/gitapi/handlers_git_worktree.go:287) | 5.4 | 4.3 |
| POST | `/api/git/lock/remove` | 정확 | `apiGitLockRemove` (webserver/gitapi/handlers_git_lock.go:36) | 5.4 | 4.2 |

## 4. WebSocket·SSE

### 4.1 엔드포인트

| 경로 | 방식 | 핸들러 (Go 파일) | 담당 이슈 |
|---|---|---|---|
| `/ws` (`?tool=` `?cols=` `?rows=` `?since=`) | WebSocket, 바이너리 프레임 | `handleWS`·`handleWSDaemon` (`webserver/httpapi/handlers_ws.go`) | 5.5 (프레임 상수는 2.2 `toolhub`, 응답석은 5.2 `hub`) |
| `/api/lsp/ws?root=&server=` | WebSocket, 텍스트 프레임 | `apiLSPWS` (`webserver/httpapi/handlers_lsp_ws.go`) | 5.5 (LSP 프로세스는 4.6) |
| `/api/commands/sse` (`?clientId=` `?presence=1`) | SSE, 이름 없는 `data:` 프레임 | `handleCommandSSE` (`webserver/httpapi/commands.go`) | 5.5 (SSE 작성기는 1.3 `sse`, 명령 허용 목록은 5.2 `hub`) |
| `/api/git/job/events?id=&after=` | SSE, 이름 있는 이벤트 | `apiGitJobEvents` (`webserver/gitapi/handlers_git_remote.go`) | 5.4 (작업 구조는 4.2 `git/jobs`) |
| `/edge/v1/link` (데몬의 노드 포트, TLS) | HTTP/1.1 `Upgrade: dmlink1` (WS·SSE 아님) | `Mesh.Handler`→`edge.AcceptUpgrade` (`shared/edgemesh/mesh.go`, `shared/edge/upgrade.go`) | 2.4 (업그레이드 원형은 2.3) |

SSE 공통 머리(`webserver/sse/sse.go`, 1.3): `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. 프레임 형식은 주석 `: x`, `data: x`, `event: name\ndata: x` 다.

### 4.2 `/ws` 바이너리 프레임 (담당 5.5, 상수 2.2)

모든 메시지는 `[op 1바이트][payload]` 다. 상수는 `shared/toolhub/conn.go` 에 있다.

| 방향 | 이름 | 바이트 | payload |
|---|---|---|---|
| 클라→서버 | `OpInput` | 0x00 | 입력 바이트 |
| 클라→서버 | `OpResize` | 0x01 | cols u16 BE, rows u16 BE (5바이트 미만이면 무시) |
| 서버→클라 | `OpOutput` | 0x00 | PTY 바이트 (재생·모드 복원·실시간, 프레임당 64 KiB 이하) |
| 서버→클라 | `OpError` | 0x01 | `도구를 만들지 못했습니다: <오류>` |
| 서버→클라 | `OpExit` | 0x02 | 없음 |
| 서버→클라 | `OpToolID` | 0x03 | 도구 ID |
| 서버→클라 | `OpSeq` | 0x04 | offset u64 BE + flags 1바이트 (`full`=1, `alt`=2) |
| 서버→클라 | `OpSize` | 0x05 | cols u16 BE + rows u16 BE |
| 서버→클라 | `OpReplySeat` | 0x06 | 1 = 응답석 보유, 0 = 아님 (`webserver/hub/replyseat.go`) |

연결 직후의 순서: `OpToolID` → (`OpSize`) → `OpReplySeat` → `OpOutput` 재생(전체 재생이면 reset·clear·alt 접두) → 모드 복원 `OpOutput` → `OpSeq` → 실시간 프레임. 오프셋에 틈이 생기면 `OpExit` 없이 닫는다. Ping 주기 54초, PongWait 60초, 읽기 한도 1 MiB.

### 4.3 `/api/lsp/ws` (담당 5.5)

LSP JSON-RPC 를 텍스트 프레임으로 그대로 오간다. 닫기 코드: 4001 `limit`, 4002 시작 오류(123바이트로 자름), 4003 `ended`.

### 4.4 `/api/commands/sse` 의 `action` (담당 5.5, 생산자별 이슈는 괄호)

모든 프레임은 `data: {"action":…,"args":…}` 다(`webserver/sse/payload.go`). 연결하면 `: connected` → `server_hello` → (presence 가 아니면) 도구마다 `tool_foreground` 를 보낸다. `server_hello` 는 15초마다 다시 보낸다.

| action | args | 생산자 (이슈) |
|---|---|---|
| `server_hello` | `{assetVersion}` | httpapi (5.5) |
| `subscribeRejected` | 없음 | httpapi (5.5) |
| `workspace_changed` | `{rev}` | httpapi·wsentry (5.5·4.3) |
| `tool_foreground` | `{toolId,name}` | hub (5.2) |
| `tool_attention` | `{toolId,reason,seq}` | hub (5.2) |
| `tool_attention_clear` | `{toolId}` | hub (5.2) |
| `tool_activity` | `{toolId,state,tool,detail}` | hub (5.2) |
| `tool_subagent_activity` | `{toolId,agentId,agentType,state,tool,detail}` | httpapi (5.5) |
| `tools_background_changed` | 없음 | hub (5.2) |
| `update_changed` | 없음 | hub (5.2), 판 확인은 2.6 |
| `git_changed` | `{repo,mark}` | hub (5.2) |
| `git_jobs_changed` | 없음 | gitapi (5.4) |
| `window_focus` | `{owners}` | httpapi (5.5) |
| `fs_changed` | `{changes:[{path,type}]}` 또는 `{overflow:true}` | httpapi (5.5), 감시는 4.7 |
| `settings_changed` | `{origin?}` | httpapi (5.5) |
| `access_changed` | `{}` | httpapi (5.5) |
| `sandbox_changed` | `{}` | httpapi (5.5) |
| `edges_changed` | `{paired?,removed?,byPeer?,invited?}` | httpapi (5.5) |
| `chat_message` | `{msg}` | httpapi (5.5), 채팅은 3.1 |
| `chat_changed` | `{}` | httpapi (5.5) |
| `server_moving` | `{port}` | httpapi (5.5) |
| `claude_accounts_changed` | 없음 | hub (5.2) |
| `claude_account_alert` | `claudeacct.Alert` | hub (5.2), 내용은 4.5 |
| `run_changed` | `{runId,tree?}` | httpapi (5.5), Run 은 4.4 |
| `closeTab`·`restoreTool`·`detachTab` (layout 방송) | `{location,force}`·`{toolId,location?}`·`{toolId}` | httpapi (5.5) |
| UI 명령 중계 (`POST /api/commands`) | `{action,args,reqId?,execClientId?}` | httpapi (5.5), 허용 목록은 hub (5.2) |

UI 명령 허용 목록(`cmdActions`, `webserver/hub/commands.go`): `newWindow` `newTab` `splitH` `splitV` `openEditorTab` `restoreTool` `openUrl` `focus` `closeTab` `closeWindow` `detachTab` `windowNext` `windowPrev` `tabNext` `tabPrev` `paneUp` `paneDown` `paneLeft` `paneRight` `renameTab` `renameWindow` `newGroup` `renameGroup` `deleteGroup` `moveTab` `moveWindow` `moveGroup`. 결과가 필요한 명령(`newWindow` `newTab` `splitH` `splitV` `newGroup` `moveTab` `moveWindow` `moveGroup`)은 `reqId` 를 받고, 브라우저가 `POST /api/command-result` 로 답한다.

### 4.5 `/api/git/job/events` (담당 5.4)

| `event:` | data |
|---|---|
| (주석) `: connected`, 15초마다 `: keep` | — |
| `line` | `{seq,stream,text}`, `stream` 은 `stdout`·`stderr` |
| `done` | `jobs.Job` (`{id,repo,kind,argv,startedUnixMs,done,exitCode,err?,canceled,authRequired,rejected,…}`). 작업이 만료되었으면 `{id,done:true}` |

## 5. IPC 소켓

모든 소켓은 `$DONGMINAL_HOME/<이름>` 이다(`platform.SiblingSocket`, 1.4). named pipe 는 없고 Windows 도 AF_UNIX 를 쓴다. 리스너는 `net.Listen("unix")` 뒤 `chmod 0600` 한다.

| 소켓 | 듣는 쪽 → 거는 쪽 | 프레이밍 | 메시지 종류 | 담당 이슈 |
|---|---|---|---|---|
| `paned.sock` | 데몬(`daemon/ipc/paned_server.go`) ← 웹 서버(`webserver/toolclient`) | 줄바꿈 JSON. 요청 `{id,method,params}`, 응답 `{id,result}`·`{id,error:{code,message}}`, 푸시 `{event,…}`. `ProtocolVersion=1` | 메서드: `hello` `create` `restore` `kill` `terminate` `write` `paste` `resize` `list` `snapshot` `cwd` `busy` `busymany` `setbackground` `backgroundlist` `recordset` `records` `attnconfig` `attend` `attendall` `report` `edge` `edgeport` `chat` `shellprobe`, 알림 `input` `resizenotify`. 이벤트: `output` `fg` `exit` `size` `report` `attn` `edges` `chat`. 기능: `fgtick` `snapnotfound` `notify` `busymany` `records` `reports` `attention` `edge` `chat` `shellprobe`. 오류 코드 -32601 -32602 -32603 -32000 -32010(`CodeToolCap`) -32011(`CodeNotFound`). 기록 종류 `agent` `usage` `subagents` `subagentActs` `migrationTold` `limits`. attn 종류 `attention` `clear` `activity`. chat 푸시 `msg` `changed`. `edge` op: `get` `node` `profile` `profile_name` `invite` `add` `remove` `address` `notify` `invite_send` `invite_accept` `invite_reject` | 서버 쪽 3.2, 와이어 2.2(`toolipc`), 클라이언트 5.3, `edge` op 2.4, `chat` op 3.1 |
| `report.sock` | 데몬(`daemon/ipc/report.go`) ← dmctl(`runtimebin/report.go`), `start`(`handover/reload.go`) | 연결마다 JSON 요청 하나·응답 하나. `{method,body}` → `{ok,error}`. 제한 시간 2초(제어는 12초), 요청 64 KiB | `report.activity` `report.usage` `report.subagents` `report.notify`, 제어 `daemon.reload` `daemon.hello`. 거절 이유 `reload_exe` `reload_version` `reload_busy` `reload_unsupported` `reload_preflight` `reload_state` `reload_no_reply`. 모르는 메서드 문구 `보고 소켓이 받지 않는 메서드다` 로 `start` 가 옛 데몬을 알아본다 | 서버 쪽 3.2, 와이어 2.1(`agentrec`·`handover`), dmctl 6.3 |
| `chat.sock` | 데몬(`daemon/chatsock`) ← `dmctl chat-mcp`·`ctx-hook`, claude 셈(다이얼만) | JSON 줄, 줄 한도 1 MiB, 필드 `t`. 첫 프레임은 5초 안에 `hello` 또는 `unread` | 종류: `hello` `error` `call` `reply` `msg` `rise` `count?` `count` `unread`. call op: `online` `rooms` `create` `direct` `join` `leave` `send` `state` `kill` `kick`. 오류 코드: `bad_request` `daemon_unavailable` `participants_full` `bad_code` `locked` `no_helper` | 3.1, 와이어 2.2(`chatwire`) |
| `node.sock` | 데몬(`edgerelay.ListenNode`) ← 웹 서버(TCP 노드 포트 중계) | 머리 줄 `DMRELAY1 <addr>\n`(256바이트 이하) 뒤 원시 바이트. TLS 는 데몬에서 끝난다. 안쪽은 edge mesh JSON 줄 `{t,b,s}`: `ping` `hello` `net` `invite` | 2.4 |
| `dial.sock` | 웹 서버(`edgerelay.ListenDial`) ← 데몬(`edgerelay.Dialer`) | 요청 줄 `DMDIAL1 <addr>\n`, 응답 `OK\n`·`ERR <msg>\n`, 그 뒤 원시 바이트 | 2.4 |
| `/var/run/com.dongminal.helper.sock` (홈 밖, macOS 루트 도우미) | `dongminal otp run`(root) ← 데몬 chatsock(`humancmd.Client`) | JSON 줄, 64 KiB, 왕복 하나, 3초. `{t,code,req,key,lockedUntil,until,b,s}` | 종류 `info` `sign` `signed` `error`, op `kill` `kick`, 코드 `bad_code` `locked` `bad_request` `no_helper` `unavailable`, 서명 도메인 `dmhuman1` | 6.2, 와이어 1.5(`humancmd`). 격리 실행에서 시험하지 않는다 (C-RSP-1) |
| `doctor/paned.sock` | `dongminal doctor` 자기 시험(에코) | — | — | 6.1 |
| handover fd (소켓 아님) | 옛 데몬 → `dongminal d --handover-fd <n>` (사전 확인 `--handover-version`) | JSON 하나 `State{version,tools,global,panedFd,reportFd}`, `HandoverTool{id,name,fd,pid,cols,rows,background,sandboxed,screen,offset,modes,cwd,agent,records}`. Linux 는 memfd `dongminal-handover`, 그 밖은 지운 임시 `$HOME/.handover-*`. `handover.Version=1` | 3.2(`swap`), 2.1(`handover`), 2.2(`toolhub`) |

## 6. 홈 아래 파일 (`homeLayout()`, `internal/ctl/cli/homelayout.go`)

표시: B=백업 대상, K=보존, E=일시, R=rollback 대상.

| 이름 | 종류 | 표시 | 쓰는 쪽 | 담당 이슈 |
|---|---|---|---|---|
| `workspace.json` | 파일 | B K R | 웹 서버 (데몬 부팅이 읽는다) | 1.5(`workspace`), 5.5 |
| `settings.json` | 파일 | B K R | 웹 서버 | 5.5 (스키마 1.3) |
| `access.json` | 파일 | B K R | 웹 서버 | 5.5 |
| `lsp-paths.json` | 파일 | B K | 웹 서버 | 4.6 |
| `runs.json` | 파일 | B K R | 웹 서버 (`domain/run/store.go`) | 4.4 (파일 이름 1.3 `runfile`) |
| `tools.json` | 파일 | B K R | 데몬 (`toolhub/persist.go`) | 2.2 |
| `server.json` | 파일 | B K | ctl(`config`·`start`) | 1.5(`serverconf`), 6.1 |
| `sandbox.json` | 파일 | B K | 사용자. sandboxplace 가 읽는다 | 2.5 |
| `edges.json` | 파일 | B K | 데몬 (`edge/config.go`) | 2.3 |
| `edge-cert.pem`·`edge-key.pem` | 파일 | B K | 데몬 (`edge/identity.go`) | 2.3 |
| `telegram.json` | 파일(0600) | B K | 웹 서버 | 4.7 |
| `claude-accounts/` | 디렉터리(0700) | B K | 웹 서버 | 4.5 |
| `notes/` | 디렉터리 | B K | 웹 서버 | 5.5 |
| `bin/` (`agent-hooks`·`agent-shims`·`zdotdir` 포함) | 디렉터리 | E | 웹 서버·데몬(`runtime.EnsureInstalled`) | 2.1 |
| `tool-history/` | 디렉터리 | E | 데몬 | 2.2 |
| `paned.sock`·`paned.pid`·`paned.build` | 소켓·파일 | E | 데몬 | 3.2 |
| `.lastexit` | 파일 | E | 웹 서버 | 7 (형식 1.4 `platform`) |
| `server.log` | 파일 | E | ctl `start` | 6.1 |
| `daemon.log` | 파일 | E | 웹 서버가 데몬을 띄울 때 | 7 |
| `restart.log` | 파일 | E | ctl handoff | 6.1 |
| `run/server.addr` | 디렉터리·파일 | E | 웹 서버 | 1.5(`serverconf`) |
| `git-worktrees/` | 디렉터리 | B K | 웹 서버 | 4.3 |
| `panes.json` | 파일 | B K | 옛 형식. migrate 가 읽는다 | 6.2 |
| `worktrees/` | 디렉터리 | E | 웹 서버 (Run 격리) | 4.4 |
| `ext/` | 디렉터리 | E | 웹 서버 (확장·언어 서버) | 4.6 |
| `cache/` | 디렉터리 | E | 샌드박스 도우미 (Linux) | 2.5 |
| `tool-home/` | 디렉터리 | E | ctl `start` (격리 기동) | 6.1 |
| `doctor/`·`doctor-tools/`·`doctor-probe.txt` | — | E | ctl doctor | 6.1 |
| `verify-too-large.bin` | 파일 | E | ctl verify | 6.1 |

`homeLayout()` 에 없는 홈 항목:

| 이름 | 비고 | 담당 이슈 |
|---|---|---|
| `report.sock`·`chat.sock`·`node.sock`·`dial.sock` | 일시 소켓. `scripts/check-home-layout.sh` 는 `filepath.Join(home, …)` 형태만 보므로 `SiblingSocket` 으로 만든 소켓을 놓친다 | 3.2·3.1·2.4·2.4 |
| `.handover-*` | Linux 가 아닌 OS 에서 만들자마자 지운다 | 3.2 |
| `peers.json` | `edges.json` 의 옛 이름. 이전할 때 읽는다 | 2.3 |
| `node-cert.pem`·`node-key.pem` | 지우기만 한다 | 2.3 |
| `peer-spawns.json` | 지우기만 한다 | 2.4 |

## 7. 환경변수

### 7.1 읽는 것

| 이름 | 쓰임 | 읽는 곳 | 담당 이슈 |
|---|---|---|---|
| `DONGMINAL_HOME` | 인스턴스 홈 | ctl·cmd·toolhub·httpapi·runtimebin | 1.4.1(`dmenv`), 각 사용처 |
| `DONGMINAL_TOOL_ID` | 셸이 속한 도구 | runtimebin, ctl handoff | 6.3·6.1 |
| `DONGMINAL_TOOL_HOME` | 도구 셸 HOME 덮어쓰기 | toolhub | 2.2 |
| `DONGMINAL_HOST` | 헬퍼 서버 호스트, 컨테이너 판정 | runtimebin, serverconf(경고만) | 6.3·1.5 |
| `DONGMINAL_PORT` | 헬퍼 서버 포트(컨테이너) | runtimebin, serverconf(경고만) | 6.3·1.5 |
| `PORT` | 옛 포트 변수 | ctl options, serverconf(경고) | 6.1·1.5 |
| `DONGMINAL_AGENT_BIN_DIR` | 에이전트 바이너리를 먼저 찾을 곳(e2e) | agentadapter | 2.1 |
| `DONGMINAL_SHELL` | 도구 셸(Windows) | platform | 1.4 |
| `DONGMINAL_LOG_LEVEL` | 로그 수준 | serverconf, cmd | 1.5·7 |
| `DONGMINAL_LOG` | 로그 파일 | serverconf, ctl start·logcap | 1.5·6.1 |
| `DONGMINAL_NO_UPDATE_CHECK` | 판 확인 끄기 | updatecheck, ctl update_notice | 2.6·6.1 |
| `DONGMINAL_RESTART_RUNNER` | 재시작 대리 표시 | ctl handoff | 6.1 |
| `DONGMINAL_ATTENTION_IDLE_MS` | 유휴 알림 문턱 | toolhub | 2.2 |
| `DONGMINAL_ATTENTION_BELL` | BEL 을 알림으로 | toolhub | 2.2 |
| `DONGMINAL_CMD_RESULT_TIMEOUT_MS` | 명령 결과 long-poll 상한 | hub | 5.2 |
| `DONGMINAL_URL_OPEN` | URL 열기 판정 강제(local·viewer) | httpapi openurl | 5.5 |
| `CLAUDE_CODE_SESSION_ID` | 채팅 MCP 세션 | runtimebin | 6.3 |
| `CLAUDE_CONFIG_DIR` | Claude 계정 디렉터리 | runtimebin | 6.3 |
| `HOME`·`USERPROFILE` | statusline 설정 찾기 | runtimebin | 6.3 |
| `PATH` | 도구 PATH, 셈 찾기, git·ext PATH | toolhub, runtimebin, ext, git/core | 2.2·6.3·4.6·4.1 |
| `PATHEXT` | Windows 실행 확장자 | platform, runtimebin | 1.4·6.3 |
| `SHELL`·`ComSpec` | 도구 셸 | platform | 1.4 |
| `APPDATA` | PowerShell 기록 위치 | toolhub | 2.2 |
| `LOCALAPPDATA`·`ProgramFiles`·`ProgramFiles(x86)` | Windows 로그·브라우저 찾기 | platform | 1.4 |
| `USER` | macOS 키체인 계정 | platform | 1.4 |
| `SUDO_UID`·`SUDO_USER` | 특권 도우미 설치 대상 사용자 | privhelper | 6.2 |
| `DM_GITTEST_LOG` | 시험용 git 횟수 기록 | gittest | 1.5 |

`DONGMINAL_HISTFILE` 은 Go 가 심기만 하고 읽지 않는다(zdotdir rc 가 읽는다, 2.1·2.2).

### 7.2 자식 프로세스에 심는 것

| 변수 | 대상 | 담당 이슈 |
|---|---|---|
| `TERM=xterm-256color` `COLORTERM=truecolor` `PATH=<PATH>:<home>/bin` `HOME=<toolHome>` `DONGMINAL_TOOL_ID` `BROWSER=<bin>/open-url` `USER` `LOGNAME` + extraEnv (`os.Environ()` 뒤에 덧붙인다) | 도구 셸 | 2.2 |
| `HISTFILE` `DONGMINAL_HISTFILE` | 도구 셸 | 2.2 |
| `LANG`·`LC_ALL`·`LC_CTYPE=en_US.UTF-8` `SHELL_SESSIONS_DISABLE=1` `SHELL` `ZDOTDIR=<bin>/zdotdir`(zsh) | POSIX 도구 셸 | 1.4 |
| `CLAUDE_CODE_NO_FLICKER=1` `CLAUDE_CODE_SCROLL_SPEED=<n>` | 에이전트 도구 | 5.5 |
| docker `-e TERM` `DONGMINAL_HOST` `DONGMINAL_PORT` `DONGMINAL_TOOL_ID` | 샌드박스 컨테이너 | 2.5 |
| `DONGMINAL_HOME` | 데몬 `dongminal d` | 7 |
| `os.Environ()` 그대로 | 데몬 reload 재실행 | 3.2 |
| `DONGMINAL_HOME` `DONGMINAL_TOOL_HOME`, 지움: `DONGMINAL_RESTART_RUNNER` `DONGMINAL_TOOL_ID` `PORT` `DONGMINAL_PORT` `DONGMINAL_HOST` | 백그라운드 `start --foreground` | 6.1 |
| `DONGMINAL_RESTART_RUNNER=1` | 재시작 대리 | 6.1 |
| `TERM` `DONGMINAL_HOME` | doctor 프로브 | 6.1 |
| `CLAUDE_CONFIG_DIR`(없을 때만) | 셈이 띄우는 진짜 claude | 6.3 |
| MCP 설정 env `DONGMINAL_HOME` `DONGMINAL_TOOL_ID` | `dmctl chat-mcp` | 6.3 |
| `GIT_TERMINAL_PROMPT=0` `GIT_ASKPASS=` `SSH_ASKPASS=` `SSH_ASKPASS_REQUIRE=never` `GIT_OPTIONAL_LOCKS=0` `GIT_PAGER=cat` `PAGER=cat` `GIT_EDITOR=true` `GIT_SEQUENCE_EDITOR=true` `LC_ALL=C` | git | 4.1 |
| `HOME` `USERPROFILE` `XDG_*` `npm_config_*` `GOMODCACHE` `GOCACHE` `GOBIN` `GOFLAGS=` `NODE_OPTIONS=` `NPM_CONFIG_PREFIX=` `PATH` | 확장·언어 서버 설치 | 4.6 |
| `GOOS=linux` `GOARCH` `CGO_ENABLED=0` | 샌드박스 도우미 빌드 | 2.5 |
| plist·systemd 의 `DONGMINAL_HOME`, 비움: `DONGMINAL_HOST` `DONGMINAL_PORT` `PORT` | OS 서비스 | 6.1 |

## 8. 환경 의존 값

같은 기계에서 두 바이너리를 돌리면 같은 값이 나오지만, 기계마다 값이 다른 것들이다. 차분 실행은 같은 기계에서 Go 와 Rust 가 같은 값을 내는지만 비교한다. 정규화하지 않는다.

| 값 | 나오는 곳 | 무엇에 따라 갈리나 |
|---|---|---|
| `"helper":true\|false` | GET `/api/chat` 본문 (`chatwire.State.Helper`) | 이 기계에 특권 OTP 도우미가 설치되어 있는가. 데몬이 시작할 때와 30초마다 `/var/run/com.dongminal.helper.sock` 에 `info` 를 묻는다(`daemon/boot/edge.go` `watchHelper`). 격리 실행에서도 묻는다. `info` 조회는 C-RSP-1 의 예외로 허용되었다(조정자 결정, 2026-11-23). `sign`·`kill`·`kick` 은 금지다 |
| 호스트 이름 (예: `…-Macmini-local`) | `/api/chat`·`/api/edges`·`/api/profile` 의 노드 이름 | 기계 이름 |
| `darwin/arm64` | `version` 출력 | OS·아키텍처 |
| `/api/fs/*`·`/api/cwd` 의 경로 | 기본 경로가 HOME(격리 홈) 아래일 때는 `<USERHOME>` 으로 정규화된다 | 홈 밖 경로를 가리키면 기계마다 다르다 |
| 셸·`PATH`·로캘 | 도구 셸, 에이전트 감지 | 사용자 환경 |

정규화하는 값(실행마다 바뀐다): 시각(RFC 3339), UUID, 노드 신원(간선 인증서 지문 64 hex, 앞 12 hex, 태그 4자리, 채팅 참가자 ID), `nextTickAt`(유닉스 초), Go 런타임 판(`go1.27.2` → `<GORUNTIME>`). 규칙은 `src/scenarios/*.rs` 에 시나리오마다 선언되어 있다.

## 9. 차분 시나리오 목록

`rust/parity/run.sh --list` 로 이름과 담당 이슈를 볼 수 있다. 담당 이슈가 `done` 이 아니면 차이를 실패가 아니라 보류(`PEND`)로 보고한다.

| 시나리오 | 담당 | 덮는 표면 |
|---|---|---|
| `cli-version`, `cli-version-flag` | 6.1 | `version`, `--version` |
| `cli-help`, `cli-empty`, `cli-unknown-action` | 6.1 | 최상위 도움말, 인자 없음, 모르는 액션(`bogus`·`--bogus`·`Start`) |
| `cli-<액션>-help` (15개) | 6.1 | `start` `stop` `migrate` `rollback` `window` `backup` `restore` `uninstall` `service` `update` `config` `health` `doctor` `verify` `version` 의 `--help`·`-h` |
| `cli-<액션>-args` (15개) | 6.1 | 같은 액션의 모르는 플래그와 액션별 인자 오류(값 없음, 잘못된 포트·번호, 금지된 조합, 남는 인자) |
| `cli-otp` | 6.2 | `otp`·`helper` 의 도움말과 모르는 하위 명령 |
| `helper-dmctl` | 6.3 | `dmctl` 도움말, 모르는 하위 명령, 배치 인자 오류, raw 명령 인자 오류, `chat-mcp --help` |
| `helper-dmctl-sub` | 6.3 | `dmctl run`·`edge`·`account` 의 도움말과 인자 오류 |
| `helper-misc` | 6.3 | `edit` 도움말, `download` OSC 출력, `detach` 도움말·인자 오류, `open-url` 도움말·인자 수 오류 |
| `http-get-api` | 5.5 | 3.2 의 정확 일치 GET 50개(질의 없음, 빠진 인자에 대한 오류 응답 포함), 접두 라우트 3개, 모르는 `/api/nope` (54단계) |
| `http-get-git` | 5.4 | gitapi GET 26개와 `/api/git/nope` |
| `http-static` | 7 | `/`, `/index.html`, 없는 자산 |
| `home-config` | 6.1 | 빈 홈의 `config show/validate/get`(`--json` 포함), `config set port/expose` 로 만든 `server.json`, 홈 트리 |
| `home-after-start` | 7 | 서버를 한 번 띄웠다 내린 뒤의 `server.json` `settings.json` `workspace.json` `access.json` `runs.json` `tools.json` 과 홈 트리(일시 항목 제외) |

모든 시나리오는 Go 대 Go 로 3회 연속 같았다(`run.sh --self-test`, 0.3 진행 기록).

### 9.1 아직 시나리오가 없는 표면

다음 표면은 상태를 바꾸거나, 실제 대상(git 저장소, 에이전트, 다른 노드)이 필요해서 0.3 에서 시나리오로 만들지 않았다. 담당 이슈가 필요한 시나리오를 더한다.

- POST·PUT·DELETE 라우트 전부 (5.4·5.5, 도메인 이슈와 함께)
- git 저장소가 있어야 의미가 있는 gitapi GET (질의를 준 경우, 5.4·4.1)
- WebSocket·SSE 스트림 (`Step` 에 WS·SSE 단계를 더해야 한다, 5.5·5.4)
- IPC 소켓 프레이밍 (3.1·3.2·2.4, 소켓 단계가 필요하다)
- 서버에 실제로 요청하는 `dmctl` 명령 (6.3, 격리 서버를 띄운 시나리오로)
- `start`·`stop`·`health`·`window`·`backup`·`restore`·`migrate`·`doctor`·`verify` 의 실제 실행 경로 (6.1)

### 9.2 시나리오 안전 근거 (C-RSP-1)

| 위험 | 막는 방법 |
|---|---|
| `start` 는 포트를 쥔 프로세스를 종료한다 | 서버 시나리오의 포트는 `{port}` 뿐이고, 실행기가 60147 이상에서 아무도 쥐지 않은 포트만 고른다(C-PAR-2). 60147 미만 숫자 `--port` 는 시나리오 검증에서 거절된다(C-PAR-3) |
| `stop`·`service`·`uninstall`·`update`·`rollback`·`restore`·`migrate`·`backup` 의 실제 실행 | `cli-*-args`·`cli-*-help` 의 입력은 모두 `Parse*` 가 첫 잘못된 인자에서 오류를 내거나 `ErrHelp` 를 돌려주는 것이다. `settle` 은 이때 액션을 부르지 않는다(`ctl/cli/actions.go`). `update` 는 `--check` 가 없으면 네트워크에 나가지 않는다. `tests/go_self.rs` 의 `go_observations_match_scenario_intent` 가 `cli-*-args` 의 모든 단계가 종료 코드 2, `cli-*-help` 가 0 임을 확인한다 |
| `otp status`·`install`·`uninstall`·`run` 은 특권 도우미에 닿는다 | `cli-otp` 는 인자 없음, 도움말, 모르는 하위 명령만 쓴다. 이 셋은 `privhelper.Main` 의 첫 `switch` 에서 끝난다 |
| 헬퍼는 격리 홈에 주소 파일이 없으면 기본 포트로 붙는다 | 네트워크를 쓰는 헬퍼(`dmctl` `edit` `detach` `open-url`)는 같은 시나리오에서 격리 서버를 먼저 띄운 뒤에만 실행된다(C-PAR-7, 실행기가 검증한다). 그래서 요청은 격리 서버의 `run/server.addr` 로 간다. 또 헬퍼 입력은 모두 요청 전에 끝나는 도움말·인자 오류이고, 자기 검증이 종료 코드가 0·2 뿐(1 = 요청 실패가 아님)임을 확인한다 |
| `claude` 셈은 진짜 `claude` 를 실행한다 | argv0 `claude`·`dongminald` 는 시나리오 검증에서 거절된다(C-PAR-7) |
| 데몬이 남는다 | 정리 단계가 serve 자식과 `paned.pid` 의 데몬(실행 파일이 그 쪽 바이너리일 때만)을 끈다(C-PAR-4). 자기 검증이 정리 뒤 데몬이 없음을 확인한다 |
| 특권 도우미 | 격리 데몬도 `info` 를 묻는다(8절). 조정자가 허용했다. 서명이 필요한 채팅 명령(`kill`·`kick`)은 시나리오에 없다 |

## 10. 담당을 정하지 못한 항목과 발견 사항

담당을 정하지 못한 항목은 없다. 다만 다음을 조정자에게 알린다.

- `scripts/check-home-layout.sh` 는 `filepath.Join(home, …)` 형태만 보므로 `report.sock`·`chat.sock`·`node.sock`·`dial.sock` 이 `homeLayout()` 표에서 빠져 있어도 잡지 못한다. 이것은 기준선 Go 의 문서·게이트 결함이고, Rust 포팅은 소켓을 기준선과 같은 이름·자리에 만들면 된다.
- 격리 데몬이 운영 특권 도우미에 `info` 를 묻는 것(8절)은 Rust 판 데몬도 같게 해야 한다(3.1·3.3). 시험할 때 이 조회가 운영 도우미에 닿는다는 점은 그대로 남는다.
