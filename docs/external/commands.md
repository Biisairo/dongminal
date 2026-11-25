# 터미널 내부 CLI (`otterctl`, `edit`, `download`, `detach`)

Otterminal 서버는 기동 시 `$OTTERMINAL_HOME/bin/` 에 헬퍼를 설치하고, 각 터미널 도구의 shell 은 이 디렉터리를 `PATH` 에 자동 주입받습니다. 즉 터미널에서 바로 아래 명령을 쓸 수 있습니다.

헬퍼는 otterminal 바이너리를 가리키는 symlink 입니다 (multi-call CLI) — 서버와 헬퍼의 버전이 어긋날 수 없습니다.

공통 환경 변수 (서버가 자동 주입):

- `OTTERMINAL_PORT` — 서버 포트 (기본 58146 또는 `PORT` 값)
- `OTTERMINAL_HOST` — 기본 `127.0.0.1`
- `OTTERMINAL_TOOL_ID` — 그 셸이 속한 도구 id (`detach` 가 사용)

## `otterctl` — 워크스페이스 원격 제어

실행 중인 브라우저(들)에게 `/api/commands` 로 명령을 브로드캐스트합니다. 채널(`/channel`, `hello.client` 를 밝힌 연결)로 구독 중인 모든 탭이 동일한 동작을 수행합니다.

### 서브커맨드

| 명령 | 설명 |
|------|------|
| `otterctl new-window [--name <이름>] [-n] [--sandbox <프로파일>] [--workdir <경로>]` | 새 창 생성. `--name` 으로 잡 이름 지정, `-n` 이면 백그라운드 생성 (사용자 포커스·화면 무변화 — 목록 패널에만 추가). `--sandbox` 는 그 창의 도구를 컨테이너 안에서 실행 (`scratch` · `dev`), `--workdir` 는 그 창의 작업 폴더 |
| `otterctl new-tab [--name <이름>] [-n] [--at <uuid>]` | 새 탭. `--at` 은 그 **탭**이 속한 칸을 가리킨다(칸 uuid 는 받지 않는다). **생략하면 포커스 칸**이며 부르는 쪽의 칸이 아니다. `-n` 이면 활성 탭도 포커스도 그대로 둔 채 백그라운드 추가 |
| `otterctl split-h [N]` | 가로 분할. N 지정 시 N 개로 균등 분할 (기본 2) |
| `otterctl split-v [N]` | 세로 분할. 동일 |
| `otterctl focus <uuid>` | 특정 탭으로 포커스. **uuid 만 허용** (`list-workspace` 의 `uuid=` 컬럼). 좌표/라벨/toolId 는 400 거부 |
| `otterctl close-tab` | 현재 탭 닫기. 확인창의 답은 `--force` 또는 `--background` 로 미리 준다 |
| `otterctl close-window` | 현재 창 닫기. 확인창의 답은 `--force` 또는 `--background` 로 미리 준다 |
| `otterctl window-next` / `window-prev` | 창 이동 |
| `otterctl tab-next` / `tab-prev` | 탭 이동 |
| `otterctl tool-up` / `tool-down` / `tool-left` / `tool-right` | 방향키식 분할 칸 포커스 이동 (action 은 `paneUp`/`paneDown`/`paneLeft`/`paneRight`) |
| `otterctl rename-tab --at <uuid> <이름>` | 탭 표시 이름 변경 (예: 팀 도구에 역할명). 포커스 무영향. `--name <이름>` 플래그도 동등 |
| `otterctl rename-window --at <uuid> <이름>` | 그 탭이 **속한 창**의 이름 변경. 포커스 무영향 |
| `otterctl new-group --name <이름> [--tree <owner/repo#N>]` | 빈 window 그룹을 만들고 그룹 uuid 를 낸다(`newGroups`). `--tree` 는 이슈 트리 표지 — 같은 표지의 그룹은 하나뿐이다 |
| `otterctl rename-group --at <그룹> <이름>` | 그룹 이름 바꾸기 |
| `otterctl delete-group --at <그룹>` | 그룹 지우기. window 는 닫지 않고 그룹 밖으로 풀어 둔다 |
| `otterctl list-groups [--json]` | 빈 그룹까지 포함한 그룹 목록. `index` 는 최상위 목록 안 자리(빈 그룹은 0), `windows` 는 window 수 |
| `otterctl move-tab --at <탭> <위치> [--to <칸\|window>]` | 탭 순서 바꾸기. `--to` 나 다른 칸의 기준 탭으로 칸·window 를 넘는다(UI 끌어 놓기와 같다) |
| `otterctl move-window --at <window> <위치> [--to <그룹> \| --ungroup]` | window 순서 바꾸기. 기준이 그룹 안 window 면 그 그룹에 들어간다. `--ungroup` 은 그룹에서 뺀다 |
| `otterctl move-group --at <그룹> <위치>` | 그룹을 통째로 옮긴다. 빈 그룹은 옮길 수 없다 |
| `otterctl statusline` | Claude Code 의 statusLine 프록시. otterminal 이 띄운 claude 세션에서 Claude Code 가 부른다 — 사용량을 서버에 남기고, 원래 등록된 statusLine 명령에 같은 입력을 그대로 넘긴다(그 명령은 고치지 않는다). 직접 부를 일은 없다 |
| `otterctl subagent-statusline` | Claude Code 의 subagentStatusLine 프록시. otterminal 이 띄운 claude 세션에서 Claude Code 가 부른다 — 서브에이전트의 종류·모델·effort·맥락 토큰을 서버에 남기고, 원래 등록된 subagentStatusLine 명령에 같은 입력을 그대로 넘긴다. 원래 명령이 없으면 아무것도 출력하지 않아 Claude Code 의 기본 행이 그대로 보인다. 직접 부를 일은 없다 |
| `otterctl list-workspace [--json] [--window <substr>] [--tab <substr>]` | 열린 도구 목록 조회. 표준 KEY=VALUE 라인 (아래 박스). ▶ 표시는 현재 포커스. `--window`/`--tab` 으로 이름 필터 (부분 일치·대소문자 무시, AND, 0건이면 rc=1). `--json` 시 JSON 배열 |
| `otterctl who-am-i [--json]` | 현재 쉘이 속한 탭의 식별 정보. 같은 표준 라인 한 줄. 스크립트에서 `UUID=$(otterctl who-am-i --json \| jq -r .uuid)` 패턴으로 자기 식별 |
| `otterctl send <action> [json]` | 원시 action 전송 (확장용) |

#### 에이전트 접합면 — 다른 도구의 화면을 읽고 입력을 넣는다

| 명령 | 설명 |
|------|------|
| `otterctl read-screen [--at <uuid>] [--bytes N]` | 그 도구의 화면을 **데몬이 그린 화면의 글자**로 읽습니다 — TUI 는 지금 보이는 화면, 셸은 화면과 그 위 기록 (기본 16384바이트). 사람이 보는 것과 같은 내용입니다 |
| `otterctl read-output [--at <uuid>] [--bytes N]` | 같은 자리를 **raw 바이트**로 읽습니다 — ANSI 를 포함합니다 (기본 8192바이트). 색·커서 이동까지 봐야 할 때만 쓰세요 |
| `otterctl send-input --at <uuid> [--execute] <텍스트>` | 그 도구의 **셸에 입력**을 넣습니다. `--execute` 면 Enter 까지 칩니다. 텍스트 자리에 `-` 를 주거나 생략하면 stdin 을 읽습니다 |
| `otterctl msg --to <uuid> [--from <uuid>] <메시지>` | 그 도구의 **에이전트에게** 신뢰 엔벨로프로 메시지를 보냅니다. `send-input` 과 다릅니다 — 이쪽은 상대가 에이전트임을 전제하고 봉투를 씌웁니다. `--to <노드>/<uuid>` 는 짝맞춘 다른 노드의 에이전트이며 원격 엔벨로프로 들어갑니다 |
| `otterctl status [--at <uuid> \| --member <uuid>] [--json]` | 그 도구의 에이전트 상태(`idle`/`working`/`waiting`/`done`). `--member` 는 헤드리스 멤버를 지목한다 (`wait` 와 같다). 계정 한도가 관측됐으면 창마다 `claude 5h 34% (resets in 2h 0m)` 꼴의 줄이 더해진다. 데몬이 잠시 답하지 못해 도구의 생존을 모르면 `live=unknown` 으로 쓴다(`--json` 은 `live:false`, `liveUnknown:true`). 죽었다는 뜻이 아니다 |
| `otterctl wait [--at <uuid> \| --member <uuid>] --for ready\|done [--timeout-ms N]` | 그 상태가 될 때까지 기다립니다. 서버가 long-poll 로 잡아 주므로 폴링 루프를 짜지 마세요. 도구가 사라졌다고 확인되면 `gone` 으로 1 을 내고 끝납니다. 생존을 모르는 동안에는 `gone` 으로 끝내지 않고 계속 기다립니다 |

#### 노드 간 통신 — 짝맞춘 다른 otterminal

| 명령 | 설명 |
|------|------|
| `otterctl account <list\|add\|switch\|usage\|reset\|auto\|history\|pin\|map\|unmap\|maps> …` | Claude 다중 계정을 다룹니다. `list [--json]` 은 등록한 계정을 봅니다(`*` 가 활성 계정). `add` 는 Claude Code 에 지금 로그인한 계정을 등록합니다. `switch <id\|별칭\|이메일>` 은 그 계정으로 전환합니다. `switch --strategy next\|next-available\|best` 는 순서상 다음 계정, 다음이되 한도가 찼거나 사용량을 모르는 계정은 건너뛴 계정, 여유가 가장 큰 계정으로 전환합니다. `best` 가 전환하지 않으면 그 이유를 보입니다. 새로 시작하는 Claude Code 세션부터 새 계정을 씁니다. 실행 중인 세션은 건드리지 않습니다. `usage [<계정>] [--refresh] [--json]` 은 사용량을 봅니다. 계정을 주지 않으면 모든 계정을 봅니다. 창마다 사용률과 초기화까지 남은 시간이 나오고, 70% 이상은 `(경고)`, 90% 이상은 `(위험)` 이 붙습니다. 주간 사용 속도 예측, 추가 사용량, 로그인 만료일도 나옵니다. `--refresh` 는 먼저 바로 조회합니다. 3분(180초) 안에 조회했거나 물러나는 중인 계정은 서버가 거절합니다. 이때 나머지 계정과 출력은 계속하고 종료 코드는 1 입니다. 쓸 수 있는 제한 초기화가 있으면 그 줄도 나옵니다. `reset <계정> --program juniper_tide\|cedar_ember [--grant <id>] [--yes]` 는 제한 초기화를 씁니다. `juniper_tide` 는 주간 5시간 초기화, `cedar_ember` 는 초기화 티켓이고 `--grant` 로 티켓을 고릅니다(`usage` 출력에 id 가 나옵니다). `--yes` 가 없으면 채우는 창, 남은 횟수, 기한, 주간 한도 차감 여부를 보이고 `y` 를 받아야 보냅니다. 결과가 초기화가 아니면 종료 코드는 1 입니다. `auto on\|off` 는 자동 전환을 켜고 끕니다. `cswap auto` 가 돌고 있으면 켜지 않고 종료 코드는 1 입니다. `auto status [--json]` 은 설정, 상태, 마지막 전환, 격리된 계정을 봅니다. `history [--limit N]` 은 전환 기록을 최신 먼저 봅니다(기본 20건, 1~1000). `pin [--tab <toolId>] <계정>\|--clear` 는 탭(기본은 이 탭)에 계정을 지정하거나 풉니다. 탭을 닫으면 지정이 지워집니다. `map <계정> [경로]` 는 폴더(기본은 현재 폴더)와 그 아래에서 claude 를 그 계정으로 실행하게 연결하고, `unmap [경로]` 는 연결을 풉니다. `maps` 는 폴더 연결과 탭 지정 목록을 봅니다. 탭 지정이 폴더 연결보다 앞섭니다. 지정은 실행 중인 claude 에는 적용되지 않고 다음 실행부터 적용됩니다. 전환한 계정이 고정 실행 중인 탭이 있으면 그 사실을 한 줄로 알립니다 |
| `otterctl edges [--json]` | 이 노드의 노드 포트 상태와 간선 목록(지문 앞자리·표시 이름·주소)을 봅니다. 지문은 앞 16자만 보입니다 |
| `otterctl edge invite \| add \| remove …` | 간선 맺기·끊기입니다. 자세히는 [edges.md](./edges.md) 를 봅니다. `invite [--addr <주소>]` 가 초대 코드를 만들고(10분, 한 번), 상대가 `add <코드>` 로 붙여 넣으면 바로 양쪽이 간선입니다. `remove <지문 앞자리>` 는 간선을 끊고 상대 쪽에서도 지웁니다. 지문 앞자리는 8자리 이상입니다. 상대에 닿지 못하면 사유 코드를 내고 1 로 끝납니다 |

#### 에이전트 훅에서 부르는 것

이 넷은 사람이 직접 치는 명령이 아닙니다. 에이전트의 훅이 부릅니다.

데몬 모드에서 `notify`·`activity`(그리고 `statusline`·`subagent-statusline`)는 보고를 데몬의 보고 소켓(`report.sock`)에 먼저 보냅니다. 서버가 꺼져 있어도 데몬이 기록해 두었다가, 서버가 다시 붙으면 그 상태를 보입니다. 보고 소켓이 없거나(샌드박스 창·옛 데몬) 실패하면 이전처럼 서버에 HTTP 로 보냅니다. 두 시도를 합쳐도 이전 시한을 넘지 않습니다. 보고 소켓은 데몬을 다시 띄워야 생깁니다(`otterminal start`. 교체를 모르는 옛 데몬이면 `otterminal start --refresh-daemon`).

| 명령 | 설명 |
|------|------|
| `otterctl notify [label]` | 현재 도구에 **주의 알림**을 세웁니다. 탭·분할 칸에 표시가 뜨고, 설정에 따라 데스크톱 알림·소리가 납니다 |
| `otterctl activity <agent>` | 현재 도구의 **작업 상태**를 보고합니다. 훅 JSON 을 stdin 으로 읽습니다. Telegram 알림을 위해 훅 이름과 대화 기록 파일의 경로를 함께 보내고, 권한 요청·질문(`AskUserQuestion`)이면 도구 입력도 보냅니다. 서브에이전트가 `SubagentHandback` 을 부르면 그 서브에이전트는 `done` 으로 보고합니다 |
| `otterctl agent-context` | 세션에 상시 주입할 **컨텍스트**를 냅니다 (이 도구가 어느 워크스페이스의 무엇인지) |
| `otterctl ctx-hook <agent>` | 설정 `migrationHook`(기본 끔)이 켜져 있고 맥락 사용률이 기준(`migrationHookCtxPct`, 기본 50)의 80% 이상이면 다음 일의 크기를 보고 `/otterminal:migration` 시점을 정하라고 알리고, 85% 이상이면 지금 넘기라고 알립니다. 데몬 모드에서는 노드 망 채팅의 읽지 않은 글 수도 함께 알립니다. 에이전트 훅(PostToolUse·UserPromptSubmit)이 부릅니다 |
| `otterctl chat-mcp` | 노드 망 채팅의 MCP 서버입니다. 데몬 모드에서 otterminal 탭의 `claude` 를 띄우면 shim 이 주입합니다. 사람이 직접 실행하는 명령이 아닙니다 |

#### 파일·URL 열기

| 명령 | 설명 |
|------|------|
| `otterctl open-editor --at <uuid> [--name <이름>] <파일 절대경로>` | 그 분할 칸에 **편집기 탭**을 엽니다. 경로는 절대 경로여야 합니다 |
| `otterctl open-url <url>` | **보고 있는 기기의 브라우저**로 엽니다. 서버가 도는 기계가 아닙니다 — 원격에서 쓰는 것이 이 제품의 기본 형태이기 때문입니다. 판정을 강제하려면 `OTTERMINAL_URL_OPEN=local\|viewer` |

#### 오케스트레이션 실행 기록 — 누가 어느 Run 의 팀원인가

| 명령 | 설명 |
|------|------|
| `otterctl run start --objective <목적> [--projection <p>] [--isolation <i>]` | Run 을 연다 |
| `otterctl run member --run <uuid> --role <이름> --agent <id> --at <탭 uuid> [--brief -]` | 그 Run 에 팀원을 등록한다 |
| `otterctl run launch --member <uuid> [--model <m>]` | 그 팀원의 **기동줄**(프리앰블 포함)을 낸다 |
| `otterctl run report --outcome succeeded\|failed --summary <3문장>` | 자기 몫의 결과를 보고한다 |
| `otterctl run status [--run <uuid>] [--json]` · `otterctl run list` | 조회. `--json` 이면 열린 Run 에 생존(`liveness`)이 실린다 — `open`(살아 있다)·`gone`(데몬이 답했는데 도구가 없다)·`unknown`(데몬이 답하지 못해 모른다) |
| `otterctl run close --run <uuid> [--force] [--keep-worktrees] [--keep-tools]` | Run 을 닫고 탭과 worktree 를 정리한다. 서버는 otterctl 의 연결과 무관하게 정리를 끝까지 한다. otterctl 은 5분 20초까지 기다리고, 넘기면 `otterctl run status --run <id>` 로 결과를 보라고 알린다. worktree 의 경로와 브랜치가 모두 없으면 정리된 것으로 본다 |
| `otterctl run delete --run <uuid>` | 레코드를 지운다 — close 와 달리 미보고 검사 없이 (웹 UI 의 삭제와 같다). 잔여물은 보고한다 |
| `otterctl run coordinate --to <toolId>` | 이 세션이 조율하는 열린 Run 을 그 도구로 넘긴다(조율 migration). 넘긴 Run 이 없으면 `(조율하는 열린 Run 없음)` 을 낸다 |
| `otterctl run recover --run <uuid> [--member <uuid> \| --coordinator] [--force] [--json]` | 데몬이 죽은 뒤 빈 셸이 된 조정자·팀원의 에이전트를 기록된 세션 id 로 재개한다(claude·omp). 대상마다 `resumed`·`skipped <사유>` 한 줄을 낸다. 세션이 이미 돌거나 셸에서 다른 프로그램이 돌면 건너뛴다. 셸을 판정하지 못하면(`unknown`) 건너뛰고, 화면을 확인한 뒤 `--member`·`--coordinator` 와 `--force` 로 하나씩 재개한다. 방금 재개한 도구는 15초 동안 `recovering` 으로 건너뛴다. 재개한 대상이 있으면 종료 코드 0, 없으면 1, 요청 오류(서버의 거절 포함)는 2 다. 웹의 Run 대시보드에도 같은 「복구」 버튼이 있다 |
| `otterctl run graph --run <uuid> [--json]` | 멤버·메시지 간선·타임라인 — 대시보드가 그리는 그것 |
| `otterctl run tree --ref <owner/repo#N> [--json]` | 이슈 트리의 열린 노드를 사슬 순서로 — 대시보드의 「이슈 트리」 가 그리는 그것. `run start --tree <ref> [--branch]` 로 연 Run 이 대상이다 |

각 서브커맨드의 상세는 `otterctl run <서브커맨드> --help` 로 봅니다.
이슈 트리를 따라 여러 에이전트를 세우는 절차는 `/otterminal:issue-tree` 명령에 있습니다.

#### 표준 라인 포맷 (list-workspace / who-am-i 공통)

```
{▶|  } label=W1.P1.T1  uuid=<36자>  short=<8자>  toolId=<n>  shellPid=<n>  size=<W>x<H>  window="<이름>"  tab="<이름>"  window_uuid=<36자>  pane_uuid=<36자>
```

- 모든 컬럼 KEY=VALUE, 두 칸 공백 구분. `awk` / `grep` 으로 컬럼 단위 파싱 가능.
- `▶` = 사용자 브라우저 포커스 일치. 비포커스는 두 칸 공백.
- 빈 값(uuid/short/windowUuid/paneUuid 미지정, size=0x0)은 해당 컬럼 통째 생략.
- `window` / `tab` 은 Go `%q` 이스케이프.
- `--json` 의 키는 lowerCamelCase (`toolId`, `shellPid`, `sizeCols`, `sizeRows`, `windowUuid`, `paneUuid`, `focused`).

### 공통 플래그

| 플래그 | 설명 |
|--------|------|
| `--at <uuid>` / `-l <uuid>` | 대상 탭 지정. 미지정 시 현재 포커스. **uuid 만 허용** — `list-workspace` 의 `uuid=` 컬럼 값. 좌표/라벨/toolId 는 거부 |
| `--force` | 닫기 전용. 실행 중인 프로세스가 있어도 **확인창 없이** 닫고 도구를 종료한다. 브라우저의 "그냥 닫기" 와 같다 |
| `--background` | 닫기 전용. 확인창 없이 닫되 **도구는 살려 배경으로** 보낸다. 브라우저의 "백그라운드로 보내기" 와 같다. `--force` 와 함께 쓸 수 없다 |
| `--no-focus` / `-n` | 실행 전후로 사용자 포커스를 옮기지 않음. `split-h/v` 후 새 분할 칸으로 포커스가 튀지 않음. `close-tab` 등에도 동일 적용 |
| `-h` / `--help` | 도움말 |

### 순서의 위치 지정

`move-*` 는 위치 지정을 **정확히 하나** 받는다: `--index N`(담는 곳 안의 자리, 1부터, 범위 밖은 오류) · `--prev`/`--next`(한 칸, 끝에서는 오류) · `--before <uuid>`/`--after <uuid>`(기준의 바로 앞·뒤). `--to` 는 담는 곳을 바꾸고 위치 없이 쓰면 그 끝, `--index` 와 함께 쓰면 그 안의 자리다. 결과에는 `position: {container, index, count}` 가 실리고, 실패하면 `error`(`out_of_range` · `at_edge` · `not_found` · `bad_spec` · `empty_group`)와 함께 exit 1 이다. 만들 때 자리를 정하려면 `new-window --group <그룹>`, `new-tab --after <탭>` · `--index N` 을 쓴다. `list-workspace` 의 행에는 `group` · `win_pos` · `tab_pos`(JSON 은 `groupUuid` · `windowContainer` · `windowIndex` · `windowCount` · `tabIndex` · `tabCount`)가 실린다.

### 위치 식별자 — uuid 만 허용

`/api/commands` 의 `args.location` 인자는 **`list-workspace` 가 노출하는 `uuid=` 컬럼 값만** 받는다. 좌표(`4.1.1`/`W4.P1.T1`), 라벨, toolId 는 400 거부 — 다른 창 닫힘 시 reflow 되어 다른 탭을 가리키는 사고를 차단하기 위함.

상태 표시줄의 `현재 위치 (otterctl 대상)` 항목(`W1.P2.T1`, 기본 꺼짐)은 사람용 표시다. 명령에는 같은 행의 `uuid=` 값을 쓴다.

### 예

```bash
otterctl list-workspace                                # 안정 식별자 확인
UUID=$(otterctl list-workspace --json | jq -r '.[0].uuid')
otterctl focus "$UUID"                             # uuid 로 이동
otterctl split-h 3 --at "$UUID"                    # uuid 위치에 가로 3 분할
otterctl new-tab --at "$UUID" -n                   # 그 탭의 칸에, 포커스 변경 없이 탭 추가
otterctl split-v --no-focus                        # 현재 포커스 유지하며 분할
otterctl send splitH '{"count":2}'                 # raw API 호출
SELF=$(otterctl who-am-i --json | jq -r .uuid)     # 자기 자신 uuid (스크립트 자기 식별)
NEW=$(otterctl split-v --at "$UUID" -n | jq -r '.newTabs[0].uuid')  # 새로 생긴 tab uuid
```

### 생성 명령의 결과 (새 엔터티 uuid 반환)

`splitH`/`splitV`/`newTab`/`newWindow` 은 **생성 명령**이다. 응답에 그 명령으로 새로 생긴 엔터티가 포함된다 (브라우저가 처리 후 echo → 서버가 long-poll 로 상관 → 한 번의 요청-응답):

```json
{ "ok": true, "delivered": 1, "action": "splitV",
  "newWindows": [], "newPanes": ["r110"],
  "newTabs": [ {"uuid": "t139", "toolId": "439"} ],
  "timedOut": false }
```

- `newTabs` 각 원소는 `{uuid, toolId}` — uuid→toolId 재조회 불필요.
- `newWindow` 은 `newWindows`/`newPanes`/`newTabs` 각 1개.
- 구독 브라우저가 없거나(`delivered=0`) 응답이 늦으면 `timedOut: true` + 빈 배열 — 명령 자체는 broadcast 됨. 이 경우 `list-workspace` 로 확인.
- **`otterctl` 은 그 둘을 실패로 본다** — `delivered=0` 이면 "구독 중인 브라우저가 없습니다" 와 exit 1, 생성 명령이 `timedOut` 이면 "만들어지지 않았을 수 있습니다" 와 exit 1. 본문은 그대로 stdout 에 남는다. 비생성 명령도 `delivered=0` 은 exit 1 이다 (`detach` 와 같은 판정).
- 비생성 명령(`focus`/`close*`/`rename*`/`tool-*` 등)은 이 필드들이 없다 (기존 응답 그대로).

### 허용된 action (서버 화이트리스트)

`newWindow`, `newTab`, `splitH`, `splitV`, `openEditorTab`, `focus`, `closeTab`, `closeWindow`, `windowNext`, `windowPrev`, `tabNext`, `tabPrev`, `paneUp`, `paneDown`, `paneLeft`, `paneRight`, `renameTab`, `renameWindow`, `detachTab`, `restoreTool`, `newGroup`, `renameGroup`, `deleteGroup`, `moveTab`, `moveWindow`, `moveGroup`.

그 외 action 은 서버가 400 으로 거절. `openEditorTab` 은 `edit`, `detachTab`/`restoreTool` 은 `detach` 가 사용합니다.

## `edit` — 내장 편집기로 파일 열기

```
edit <path>          # 그 경로에 연결된 Repo 창에서 열기
edit -h, --help      # 도움말
```

동작: `POST /api/commands` 로 `openEditorTab` 을 브로드캐스트하고, 브라우저가 그 탭에 편집기(CodeMirror 6)를 띄운 뒤 `GET /api/file/read` 로 내용을 읽습니다. 저장은 `POST /api/file/write`.

**어느 창에서 열리는가.** 편집기는 일반 창에 열리지 않습니다. 파일 경로를 자기 루트 아래에 포함하는 **Repo 창**(목록 패널 `저장소` 탭의 행 — 영어 화면에서는 `Repo`)에서 열리며, 그런 창이 둘 이상이면 루트가 가장 깊은 것이 이깁니다. 하나도 없으면 `~` 의 root 에디터에서 열립니다.

- 상대경로는 절대경로로 변환됩니다. 파일이 없거나 디렉터리면 rc=1.
- 구독 중인 브라우저가 없으면 `delivered=0` — 페이지를 새로고침해야 합니다.

과거에는 `code-server`(원격 VSCode) 프로세스를 띄우고 `/cs/<id>/` 로 프록시했으나 내장 편집기로 대체되며 제거됐습니다. `edit -l` / `edit -s` 도 함께 사라졌습니다.

## `detach` — 도구를 백그라운드로

탭을 닫아도 도구가 계속 돌게 합니다. 이름이 `bg` 가 아닌 이유는 `bg` 가 zsh/bash 의 작업 제어 빌트인이기 때문입니다.

```
detach                   # 현재 탭의 도구를 백그라운드로 (탭은 닫힘)
detach --run <명령>      # 백그라운드에 새 도구를 만들어 그 명령을 돌린다
detach --run <명령> --cwd <경로>   # 그 명령을 이 디렉터리에서
detach --list, -l        # 백그라운드 도구 목록
detach --restore <id>    # 백그라운드 도구를 현재 분할 칸의 새 탭으로 복귀
                         #   (-r <id>, --restore=<id>, -r=<id> 도 같다)
detach --restore <id> --at <uuid>   # 지정한 탭이 속한 분할 칸으로 복귀
detach -h, --help        # 도움말
```

`--at` 은 `otterctl list-workspace` 의 uuid 를 받습니다. 복귀는 분할 칸 단위이므로 좌표의 탭 성분은 무시됩니다 — 그 탭이 **속한 분할 칸**이 대상입니다 (`newTab`·`splitH` 와 같은 해석). `--at` 없이 쓰면 브라우저가 현재 포커스한 분할 칸으로 복귀합니다. `otterctl` 은 `-l` 을 `--at` 의 단축으로 쓰지만 `detach` 에서 `-l` 은 `--list` 이므로 그 단축은 제공하지 않습니다. `--at` 은 `--restore` 와 함께만 유효합니다.

`--run` 으로 만든 도구는 **그 명령이 곧 프로세스**입니다. 대화형 셸을 띄우고 그 안에 타이핑하는 것이 아니므로, 명령이 끝나면 도구가 죽고 백그라운드 목록에서 스스로 사라집니다 — 끝난 뒤에도 남아 기다리는 셸이 없습니다.

명령 자체는 그 호스트의 셸에 `-c`(Windows PowerShell 은 `-Command`, cmd.exe 는 `/c`)로 넘어가므로 파이프·리디렉션·`&&` 가 그대로 동작합니다. 끝난 뒤에도 자리를 남기고 싶으면 그것까지 명령에 적습니다 (`npm test; exec $SHELL`).

종단은 `POST /api/tools/headless` 이며 브라우저를 거치지 않습니다 — 만드는 것이 탭 없는 도구이므로 화면에 자리를 잡을 필요가 없습니다.

동작: `OTTERMINAL_TOOL_ID` 로 자기 도구를 식별해 `POST /api/commands` 로 `detachTab` 을 보냅니다. 전환과 탭 닫기를 **하나의 명령**으로 처리하는 이유는, 두 단계로 나누면 그 사이에 탭이 닫혀 도구가 종료될 수 있기 때문입니다. `--list` 는 `GET /api/tools/background` 를 직접 조회합니다.

- `OTTERMINAL_TOOL_ID` 가 없으면(otterminal 터미널 밖) rc=1.
- 터미널 도구만 대상입니다. 편집기 탭은 `backgroundCapable=false` 라 브라우저가 무시합니다 (Repo 창에만 존재합니다).
- **데몬을 재시작하면 백그라운드 도구는 복원되지 않습니다** — 복원해도 돌던 작업이 아니라 같은 cwd 의 빈 셸이 되살아날 뿐입니다.

작업 패널의 `백그라운드 도구` 탭(`Ctrl+Shift+B`)에서 항목을 눌러도 같은 목록·복귀 경로를 씁니다.

## `download` — 파일을 브라우저로 내려받기

```bash
download <path>
```

OSC 777 `Download;<abs-path>` 시퀀스를 출력해 브라우저가 `/api/download?path=<abs>` 로 실제 다운로드를 트리거합니다. 상대경로는 `realpath` 로 절대경로 변환. 파일이 없으면 서버 측에서 404. 보이는(깨어 있는) 터미널에서 친 경우에만 내려받습니다 — 숨어서 잠든 터미널에 온 요청은 버립니다.

반대 방향(업로드)은 터미널에 파일을 드래그앤드롭 → 해당 도구의 `cwd` 에 저장 (중복 시 `(1)`, `(2)` 자동 넘버링). 업로드가 끝나도 **셸에 엔터를 보내지 않는다** — 그 순간 도는 것이 셸이 아니면 그 프로그램이 엔터를 받는다.

폴더째 주고받으려면 Repo 창의 탐색기(`Explorer`)를 쓴다 — 우클릭 다운로드가 폴더면 zip 으로
오고, 폴더를 끌어다 놓으면 하위 구조가 그대로 올라간다
([features.md](./features.md#파일-편집기)).

## cwd 훅

`zdotdir/.zshrc` 와 `bash-hook.sh` 는 `PROMPT_COMMAND` / `precmd` / `chpwd` 훅으로 OSC 777 `Cwd;<path>` 를 매 프롬프트마다 발신합니다. 프론트엔드가 수신해서 상태 바의 "현재 디렉터리" 와 파일 드래그앤드롭 업로드 타깃 디렉터리에 사용. 이 훅은 기존 `~/.zshrc` / `~/.bashrc` 를 먼저 `source` 한 뒤 추가되므로 사용자 설정과 충돌하지 않습니다.
