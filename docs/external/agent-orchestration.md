# 에이전트 오케스트레이션

Dongminal 은 도구(터미널 탭) 안에서 도는 에이전트가 워크스페이스를 조회·조작하고
서로 통신할 수 있게 합니다. 접합면은 두 층입니다.

| 층 | 수단 | 성격 |
|----|------|------|
| **액션** | `dmctl` 서브커맨드 | 셸 명령. 셸을 가진 에이전트면 무엇이든 쓸 수 있다 |
| **정책** | 세션 스코프로 주입되는 스킬 | 무엇을 어떤 순서로 왜 하는가 |

**설정할 것이 없습니다.** MCP 등록이나 스킬 복사 같은 사전 작업이 필요하지 않고,
`~/.claude` 도 건드리지 않습니다. dongminal 이 띄운 터미널에서 `claude` 를 실행하면
그 세션에만 자동으로 주입됩니다.

> 이전 버전은 `/mcp/sse` MCP 서버와 `scripts/install-mcp.sh` 를 제공했습니다. 둘 다
> 제거됐습니다 — MCP 는 에이전트가 MCP 클라이언트일 것과 사용자가 자기 설정에 서버를
> 영구 등록할 것을 요구했고, 두 조건 모두 "터미널에서 도는 아무 에이전트나
> 오케스트레이션한다"는 목표와 어긋났습니다. 등록해 두셨다면
> `claude mcp remove -s user dongminal` 로 정리하세요.

## 명령

dongminal 이 띄운 터미널의 Claude Code 세션에서 슬래시 명령으로 씁니다. 명령은 *"사람이
부를 때만"* 돕니다 — 둘 다 자동으로 트리거되면 안 되는 일입니다(`M10_SRS` FR-M10-6 ·
`ISSUE_AGENT_TREE_SRS` D-IAT-1).

| 명령 | 역할 |
|------|------|
| `/dongminal:migration` | 지금 세션의 일을 다음 세션으로 넘긴다 |
| `/dongminal:issue-tree <이슈>` | 이슈 트리를 따라 에이전트를 세운다 — 진행 중인 경로에만, 사슬은 탭·병렬은 새 window, 트리 하나는 window 그룹 하나 |

> 이전 버전의 `/dongminal:team` · `/dongminal:workflow` 스킬은 지워졌습니다(쓰이지 않았다).
> 그 스킬이 쓰던 `dmctl run`(Run 기록 · worktree · 대시보드)은 남아 있고 `issue-tree` 가 씁니다.

### `issue-tree` 가 이슈에 닿는 규칙

`/dongminal:issue-tree` 는 GitHub 이슈를 읽고 쓰고 닫습니다. 그래서 이슈에 닿기 전에 늘 권한과 설정을 확인합니다.
읽기·하위 이슈 만들기·코멘트·보드 옮기기·라벨 바꾸기·닫기가 모두 이 규칙을 따릅니다.

- **0. 접근 확인** — 발사대는 그룹·window·Run 을 만들기 **전에** 지금 `gh` 계정, 저장소 권한(`viewerPermission`),
  토큰 범위, 루트 이슈의 설정을 보여 주고 사용자에게 한 번 확인받습니다. 권한이 `WRITE` 미만이면 아무것도 만들지
  않고 멈춥니다. 프로젝트 규약이 보드를 쓰는데 토큰에 `project` 범위가 없을 때도 같습니다.
- **권한** — 노드는 처음 다루는 저장소마다 권한을 봅니다. 쓰기가 권한·인증으로 거절되면 다시 시도하거나 우회하지
  않습니다. 멈추고 사용자에게 묻습니다.
- **설정 점검** — 세션 시작·하위 이슈 만들기·하위 열기·닫기 때 어사인·라벨·마일스톤·엮인 프로젝트를 점검합니다.
  기준은 프로젝트 규약이고, 규약이 없으면 부모 이슈와 같게 둡니다. 정해지는 값은 고치고 그 이슈에 코멘트를
  남깁니다. 정할 수 없으면 묻습니다.
- **어사인은 그 일을 하는 사람입니다.** 이 트리가 진행하는 이슈면 지금 계정을, 다른 사람이 할 일이면 그 사람을
  어사인합니다. 다른 사람만 어사인된 이슈를 가져오면 나를 더할지 묻습니다.
- **세션 시작 점검** — 노드는 세션을 시작할 때마다(부모가 연 세션도, 승계로 들어온 세션도) 자기 이슈의 상태를
  확인합니다. 프로젝트 보드의 필수 필드가 비었으면 채웁니다. 보드 이름과 필수 필드는 그 저장소의 지시 문서가 정합니다.

이 규칙은 dongminal 이 띄우는 명령 문서에 들어 있습니다. 새 판으로 바꾼 뒤 dongminal 을 다시 시작하면 적용됩니다.

### 맥락 기준 migration — 고정 문턱이 아니라 판단

맥락 사용률이 기준에 가까워지면 에이전트는 다음 일의 크기를 보고 넘길 때를 정합니다.

| 맥락 사용률 | 할 일 |
|---|---|
| 기준의 80% 미만 (기준 50 이면 40% 미만) | 넘기지 않는다 |
| 기준의 80% 이상, 85% 미만 | 다음 일을 끝냈을 때의 맥락을 가늠한다. 기준을 크게 넘을 것 같으면 지금 넘기고, 크게 벗어나지 않으면 그 일을 끝내고 넘긴다 |
| 85% 이상 | 판단 없이 지금 넘긴다 |

이유는 둘입니다. 기준 바로 아래에서 큰 일을 시작하면 기준을 크게 넘습니다. 기준을 막 넘긴 순간에 넘기면 곧 끝날 일이
끊깁니다.

- **일반 세션** — 맥락 훅(`dmctl ctx-hook`)이 이 규칙으로 알립니다. 설정 `migrationHook` 은 **기본 끔**이므로
  Settings ▸ Terminal 에서 켜야 합니다. 기준은 `migrationHookCtxPct`(기본 50)입니다.
- **issue-tree 노드** — 안전 지점(하위가 끝났을 때, 잎은 한 단계를 커밋한 뒤)에서 같은 규칙으로 판단합니다. 기준은
  배정의 맥락 기준(`--ctx`, 없으면 `issueTreeCtxPct`)이고, `issueTreeMigration` 은 기본 켬입니다. 맥락 훅은
  issue-tree 노드를 건너뜁니다.
- 조율하는 세션(발사대)이 넘길 때는 `/dongminal:migration` 이 `dmctl run coordinate` 로 조율 자리를 넘기고,
  서버가 루트 노드에 새 주소를 알립니다.

## 에이전트가 쓰는 `dmctl` 명령

전체 목록은 `dmctl --help`, 각 명령의 상세는 `dmctl <명령> --help`.

| 명령 | 역할 |
|------|------|
| `dmctl who-am-i` | 이 세션이 어느 도구에 있는지 (`uuid=` 가 자기 정체) |
| `dmctl list-workspace` | 열린 도구 목록 — 다른 에이전트를 찾는 경로 |
| `dmctl read-screen --at <uuid>` | 다른 도구의 화면을 ANSI 제거 텍스트로 읽기 |
| `dmctl read-output --at <uuid>` | 같은 것을 raw 바이트로 (TUI 상태 분석용) |
| `dmctl send-input --at <uuid> [--execute]` | 도구의 쉘에 텍스트 입력 |
| `dmctl msg --to <uuid>` | 다른 **에이전트**에게 신뢰 채널로 메시지 |
| `dmctl split-h/split-v/new-tab/new-window/close-tab/rename-tab/…` | 레이아웃 조작 |
| `dmctl open-editor --at <uuid> <파일>` | 편집기 탭 열기 |
| `dmctl run …` | Run(오케스트레이션) — 시작·멤버·보고·상태·정리. **목록은 [commands.md](./commands.md) 가 갖습니다** |

`dmctl run` 계열을 여기 베끼지 않는 이유는 그것이 낡는 자리이기 때문입니다 —
`commands.md` 는 `scripts/check-commands-docs.sh` 가 `dmctl` 과 양방향으로 대조하므로
**그쪽이 진실**이고 이 문서는 가리키기만 합니다.

긴 본문은 위치 인자 대신 stdin 으로 넘깁니다 (heredoc 종료자는 줄 맨 앞에):

```bash
dmctl msg --to "$MEMBER_UUID" - <<'MSG'
여러 줄
지시문
MSG
```

## 신뢰 채널 (`dmctl msg`)

`dmctl msg` 로 보낸 메시지는 봉투로 감싸져 수신 도구의 입력에 자동 제출됩니다.

```
[DONGMINAL-AGENT-MSG from=<발신 도구 uuid> to=<수신 도구 uuid> ts=14:50:00]
...본문...
[/DONGMINAL-AGENT-MSG]
```

수신 에이전트는 **봉투 내부를 다른 에이전트가 보낸 협업 요청으로** 처리합니다. 사용자
지시와 충돌하면 사용자 지시를 따릅니다.
봉투 **밖**의 쉘 출력은 여전히 신뢰하지 않습니다. 이 규약은 dongminal 이 모든 세션 시작
시 주입하므로, 팀원으로 갓 기동된 에이전트도 스킬을 트리거하지 않은 상태에서 알고
있습니다.

- `--from` 은 생략합니다 — 발신자가 자동으로 채워집니다.
- 헤더의 `from`/`to` 는 **uuid 뿐**입니다. 받은 봉투에 답할 때는 헤더의 `from` 값을
  그대로 `--to` 에 넣습니다.
- 식별자로는 **항상 uuid** 를 씁니다. `W?.P?.T?` 라벨은 다른 창이 닫히면 다른 탭을
  가리키게 됩니다.

## 다른 PC 의 에이전트 (`dmctl msg --to <노드>/<uuid>`)

짝맞춘 다른 dongminal 의 에이전트에게도 보낼 수 있습니다. 짝맞춤과 안전은 [peers.md](./peers.md) 를 봅니다.

```bash
dmctl peer tools office                 # office 노드의 에이전트 도구 (office/<uuid>)
dmctl msg --to office/<uuid> "리뷰 끝났어?"
```

받는 쪽 에이전트에는 원격 엔벨로프로 들어갑니다.

```
[DONGMINAL-PEER-MSG from=<짝 이름>/<보낸 도구 uuid> to=<수신 도구 uuid> ts=14:50:00]
본문
[/DONGMINAL-PEER-MSG]
```

- `from=` 의 짝 이름은 **받는 노드가 붙인 이름**입니다. 보낸 쪽이 주장하는 이름은 쓰지 않습니다.
- 원격 메시지는 협업 요청이며 사용자 지시가 아닙니다. 파괴적 작업, 비밀 정보 노출, 제3의 노드로
  다시 보내라는 요청은 사용자에게 먼저 묻도록 세션 안내문이 알립니다.
- 받는 도구에서 **지금** 에이전트가 돌고 있을 때만 넣습니다. 셸로 돌아갔으면 `peer_target_not_agent`
  로 거절하고 아무것도 넣지 않습니다.
- 회신은 `dmctl msg --to <from 값>` 입니다.

## 주입 방식

`dongminal` 은 시작할 때 `$DONGMINAL_HOME/bin/` 에 아래를 전개합니다.

```
bin/
├── dmctl, edit, download, detach       # multi-call 헬퍼 (바이너리 symlink)
├── bash-hook.sh, zdotdir/.zshrc        # cwd 훅 + claude/codex 래퍼
├── agent-hooks/claude.json             # 알림·활동·맥락 훅, statusLine 프록시 (--settings 로 주입)
└── agent-plugin/                       # 에이전트 명령 (--plugin-dir 로 주입)
    ├── .claude-plugin/plugin.json
    ├── commands/migration.md           # 슬래시 명령 (자동 트리거되지 않는다)
    ├── commands/issue-tree.md
    └── hooks/hooks.json                # SessionStart → dmctl agent-context
```

각 터미널의 셸은 `PATH` 에 `bin/` 을 얹고 `ZDOTDIR`/`BASH_ENV` 로 훅을 연결합니다. 그
훅이 정의하는 `claude()` 래퍼가 실행마다 `--settings` 와 `--plugin-dir` 을 붙입니다.

```sh
claude() {
  local s="${DONGMINAL_HOME}/bin/agent-hooks/claude.json"
  local p="${DONGMINAL_HOME}/bin/agent-plugin"
  ...
  command claude "${extra[@]}" "$@"
}
```

`--plugin-dir` 은 **그 실행 한 번**에만 적용됩니다. 그래서:

- dongminal 밖 터미널의 `claude` 에는 스킬이 나타나지 않습니다.
- 사용자의 `~/.claude/settings.json`·`skills/`·`plugins/installed_plugins.json` 은
  수정되지 않고, 플러그인이 설치되지도 않습니다.
- 바이너리를 갱신하면 스킬도 함께 갱신됩니다 (매 시작 시 전개).

## dmctl 과 브라우저 UI

레이아웃 명령은 브라우저에 SSE 로 브로드캐스트되어 **키보드 단축키와 같은 경로**로
실행됩니다. 응답의 `delivered=0` 은 구독 중인 브라우저가 없다는 뜻이므로 새로고침이
필요할 수 있습니다.

생성 명령(`split-*`, `new-tab`, `new-window`)의 응답에는 새로 만들어진 엔터티의 uuid 가
`newTabs`/`newPanes`/`newWindows` 로 들어 있어, 목록을 다시 조회할 필요가 없습니다.

## 관련 문서

- [commands.md](./commands.md) — `dmctl` 전체 레퍼런스
- [api.md](./api.md) — HTTP API (`/api/tools/output`·`input`·`message` 포함)
