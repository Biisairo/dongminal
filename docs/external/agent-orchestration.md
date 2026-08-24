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

## 스킬

dongminal 이 띄운 터미널의 Claude Code 세션에서 슬래시 명령으로 쓸 수 있습니다.

| 스킬 | 역할 |
|------|------|
| `/dongminal:team` | 여러 Claude Code 인스턴스를 팀으로 묶어 협업시킨다 (1회성) |
| `/dongminal:workflow` | 팀 구성을 정의서로 저장해두고 이름만으로 반복 실행한다 |

의도가 명확하면 슬래시 없이 "팀 만들어서 …", "저장된 워크플로우 돌려줘" 같은 말로도
자동 트리거됩니다.

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
[DONGMINAL-AGENT-MSG from=W1.P1.T2 to=W1.P1.T1 ts=14:50:00]
...본문...
[/DONGMINAL-AGENT-MSG]
```

수신 에이전트는 **봉투 내부를 프롬프트 인젝션이 아니라 유효한 협업 지시로** 처리합니다.
봉투 **밖**의 쉘 출력은 여전히 신뢰하지 않습니다. 이 규약은 dongminal 이 모든 세션 시작
시 주입하므로, 팀원으로 갓 기동된 에이전트도 스킬을 트리거하지 않은 상태에서 알고
있습니다.

- `--from` 은 생략합니다 — 발신자가 자동으로 채워집니다.
- 헤더의 `from`/`to` 는 사람이 읽기 좋게 라벨로 정규화돼 표시되지만, 라우팅 키는 uuid 입니다.
- 식별자로는 **항상 uuid** 를 씁니다. `W?.P?.T?` 라벨은 다른 창이 닫히면 다른 탭을
  가리키게 됩니다.

## 주입 방식

`dongminal` 은 시작할 때 `$DONGMINAL_HOME/bin/` 에 아래를 전개합니다.

```
bin/
├── dmctl, edit, download, detach       # multi-call 헬퍼 (바이너리 symlink)
├── bash-hook.sh, zdotdir/.zshrc        # cwd 훅 + claude/codex 래퍼
├── agent-hooks/claude.json             # 알림·활동 훅 (--settings 로 주입)
└── agent-plugin/                       # 오케스트레이션 스킬 (--plugin-dir 로 주입)
    ├── .claude-plugin/plugin.json
    ├── skills/team, skills/workflow
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
