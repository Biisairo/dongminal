# Dongminal

브라우저 기반 터미널 멀티플렉서. 분할 Pane, 탭, 세션, 테마, 파일 전송, code-server(원격 VSCode), dmctl 원격 제어 CLI, Claude Code MCP 연동, 에이전트 주의 알림, 에이전트 활동 모아보기를 지원합니다.

단일 Go 바이너리에 프론트엔드(xterm.js)와 런타임 헬퍼 스크립트가 모두 포함되어 있어 실행 파일 하나로 서비스가 가능합니다.

## 빠른 시작

```bash
./scripts/start.sh                  # 빌드 + 실행 (기본: localhost only, 포트 58146)
./scripts/start.sh                   # 기본 실행 (localhost only, 세션 유지)
PORT=8080 ./scripts/start.sh          # 포트 지정
./scripts/start.sh --expose           # LAN 노출 실행 (사내망 다른 기기 접근 허용)
./scripts/start.sh --restart-daemon   # dongminald까지 재시작 (세션 초기화)
./scripts/stop.sh                     # 중지 (세션 유지)
./scripts/stop.sh --all               # 전체 중지 (dongminald 포함)
./scripts/health.sh                   # 헬스 체크
```

브라우저에서 `http://localhost:<PORT>/` 접속. `--expose` 로 띄운 경우 같은 네트워크의 다른 기기에서 `http://<host-ip>:<PORT>/` 로도 접근됩니다.

상세한 설치·실행·환경변수는 [docs/external/getting-started.md](docs/external/getting-started.md).

## 문서

- **사용자**: [docs/external/](docs/external/) — 설치, 기능, 단축키, dmctl/edit CLI, MCP 연동, API.
- **개발자**: [docs/internal/](docs/internal/) — 아키텍처, RFC, TODO.

## 주요 기능

- **Pane/탭/세션** — 가로/세로 분할, 드래그 재배치, 레이아웃 프리셋, 워크스페이스 영속화.
- **주의 알림 (Pane Attention)** — pane 안 에이전트(Claude Code·Codex 등)·CLI가 작업을 끝내거나 입력을 기다리면, 보고 있지 않은 탭/세션을 강조 + 🔔 모아보기(클릭 점프) + 브라우저 탭 제목 배지 + (권한 허용 시) OS 데스크톱 알림으로 알림. **에이전트 무관**한 터미널 출력 감시(OSC/idle) + `dmctl notify`(claude/codex 투명 래퍼가 hook 자동 주입) 기반.
- **에이전트 활동 모아보기 (Agent Activity Panel)** — 동시에 도는 여러 에이전트가 *지금 무엇을 하는지*(작업 중/완료/대기 상태 + 실행 툴·명령·파일)를 우측 접이식 패널에 카드로 모아 표시. 카드 클릭 시 해당 pane 으로 포커스 점프, attention 알람도 카드에 합성 표시. claude(PreToolUse/Stop/Notification hook)는 풍부하게, codex(turn-complete)는 보통, 그 외는 출력 기반 추정. 토글 단축키·새로고침 주기 설정 지원.
- **code-server 연동** — pane 안에서 `edit <path>` 실행 → 브라우저 새 창으로 VSCode 열기.
- **dmctl CLI** — pane 내부에서 `dmctl split-h`, `dmctl new-tab`, `dmctl new-session`, `dmctl focus <uuid>`, `dmctl notify`, `dmctl activity` 등으로 워크스페이스 원격 제어·알림·활동 보고.
- **파일 업/다운로드** — 드래그앤드롭 업로드 + `download <path>` 명령.
- **Claude Code MCP** — `list_panes`, `read_pane_output`, `read_pane_screen`, `send_input`, `send_agent_message`, `who_am_i`, `workspace_command` 7개 툴로 Claude 가 pane 조작.
- **테마 44종 + 커스텀** — 다크 33 · 라이트 11. xterm.js 터미널과 UI 양쪽 일괄 테마.

## 아키텍처 개요

```
Browser (xterm.js) ── Binary WebSocket ──▶ Go Server (PTY hub) ──▶ Shell
       ▲  ▲                                     │       │
       │  └─ SSE /api/commands/sse ◀────────────┤       │
       │                                        │       └─ code-server 서브프로세스
       └──── code-server 리버스 프록시 /cs/<id>/ ◀┘
                                                 ↕
                                         DONGMINAL_HOME/
                                           ├ settings.json
                                           ├ workspace.json
                                           ├ panes/<id>.json
                                           └ bin/ (dmctl/edit/download, agent-hooks, shell hooks)
```

- 프론트엔드는 `go:embed` 로 바이너리에 포함.
- 런타임 헬퍼(`dmctl`, `edit`, `download`, zsh/bash cwd 훅)도 `go:embed` → 서버 기동 시 `$DONGMINAL_HOME/bin/` 에 풀림. 각 pane 의 shell 은 자동으로 이 경로를 `PATH` 에 얹고 `ZDOTDIR`/`BASH_ENV` 로 훅 연결.
- PTY 프로세스는 브라우저 새로고침해도 유지 (서버 메모리 버퍼).
- 워크스페이스(탭/분할) 는 `workspace.json` 에 비동기 영속화 (H5 latest-wins coalescing).
- Claude Code 에서 MCP 로 pane 조작 가능 (`./scripts/install-mcp.sh`).
- 주의 알림: 서버가 pane 출력을 관찰(OSC 9/99/777·idle)하거나 `dmctl notify`(claude/codex 투명 래퍼가 자동 주입한 hook 이 호출)로 주의 상태를 잡아 SSE(`pane_attention`) 로 브라우저에 전달. 자세히는 [docs/internal/PANE_ATTENTION_NOTIFY_SRS.md](docs/internal/PANE_ATTENTION_NOTIFY_SRS.md).
- 에이전트 활동: attention 과 직교하는 "현재 작업 상태(activity)" 레이어. 에이전트 hook 이 `dmctl activity` 로 보고(stdin hook JSON 파싱) → `POST /api/panes/activity/set` → SSE(`pane_activity`) 발행. pane 당 최신 1개 상태만 보관(히스토리 없음). 자세히는 [docs/internal/AGENT_ACTIVITY_PANEL_SRS.md](docs/internal/AGENT_ACTIVITY_PANEL_SRS.md).

자세한 패키지 구조와 핫패스 성능 설계는 [docs/internal/architecture.md](docs/internal/architecture.md).

## 프로젝트 구조

```
dongminal/
├── cmd/dongminal/       # main (composition root)
├── internal/
│   ├── adapters/        # mcptool ↔ server/workspace 브리지
│   ├── clientpid/       # remoteAddr → client PID
│   ├── mcptool/         # MCP 레지스트리 + 7개 툴 구현
│   ├── outbuf/          # PTY 출력 바운디드 스트림
│   ├── pane/            # pane 도메인 타입
│   ├── runtime/         # bin/ 설치(Install) + 임베드 shellhooks + agent-hooks 생성
│   │   └── shellhooks/  # bash-hook.sh, zdotdir/.zshrc (cwd 훅 + claude/codex 래퍼)
│   ├── runtimebin/      # dmctl/edit/download/mdview multi-call CLI (dmctl notify·activity 포함)
│   ├── server/          # HTTP/WS/SSE 핸들러, PaneManager, CodeServerManager, CommandHub
│   └── workspace/       # workspace.json Manager (atomic + async writer)
├── web/                 # 프론트엔드 (HTML/CSS/JS, go:embed)
├── scripts/             # start/stop/health/install-mcp (운영자용)
├── docs/
│   ├── external/        # 사용자 가이드
│   └── internal/        # 개발자 문서 (RFC, TODO, 아키텍처)
├── .env.example         # PORT, BINARY, LOG, DONGMINAL_HOME 샘플
├── go.mod
└── README.md
```

## 기술 스택

- **백엔드**: Go 1.21+, `creack/pty`, `gorilla/websocket`, `go:embed`
- **프론트엔드**: xterm.js v5 (fit, search, web-links, unicode11 addons)
- **선택 의존성**: `code-server` (edit 명령 사용 시), `claude` CLI (MCP 등록 시)

## TODO

- focused browser 자동 동기화 — 현재는 마지막으로 새로고침한 브라우저의 창 크기가 적용됨 (마지막 이벤트 기준으로 개선 필요)
- 주의 알림: 서버 호스트(브라우저 없는 원격 머신)용 OS 알림/웹훅·모바일 푸시 — 현재는 접속한 브라우저에만 표시됨
- code-server 재검토
- 데스크톱 래핑 (tauri, electron 등)
- mobile mode: Ctrl+C/D/Z 단발 버튼, 키 커스터마이즈, modifier sticky/lock 시각 강화 (RFC §8)