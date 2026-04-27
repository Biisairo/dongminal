# Dongminal

브라우저 기반 터미널 멀티플렉서. 분할 Pane, 탭, 세션, 테마, 파일 전송, code-server(원격 VSCode), dmctl 원격 제어 CLI, Claude Code MCP 연동을 지원합니다.

단일 Go 바이너리에 프론트엔드(xterm.js)와 런타임 헬퍼 스크립트가 모두 포함되어 있어 실행 파일 하나로 서비스가 가능합니다.

## 빠른 시작

```bash
./scripts/start.sh                  # 빌드 + 실행 (기본: localhost only, 포트 58146)
./scripts/internal.sh               # localhost 전용 실행 (동일 PC 에서만 접근)
./scripts/external.sh               # LAN 노출 실행 (사내망 다른 기기 접근 허용)
./scripts/stop.sh                   # 중지
./scripts/health.sh                 # 헬스 체크
PORT=8080 ./scripts/internal.sh     # 포트 지정
```

브라우저에서 `http://localhost:<PORT>/` 접속. `external.sh` 로 띄운 경우 같은 네트워크의 다른 기기에서 `http://<host-ip>:<PORT>/` 로도 접근됩니다.

상세한 설치·실행·환경변수는 [docs/external/getting-started.md](docs/external/getting-started.md).

## 문서

- **사용자**: [docs/external/](docs/external/) — 설치, 기능, 단축키, dmctl/edit CLI, MCP 연동, API.
- **개발자**: [docs/internal/](docs/internal/) — 아키텍처, RFC, TODO.

## 주요 기능

- **Pane/탭/세션** — 가로/세로 분할, 드래그 재배치, 레이아웃 프리셋, 워크스페이스 영속화.
- **code-server 연동** — pane 안에서 `edit <path>` 실행 → 브라우저 새 창으로 VSCode 열기.
- **dmctl CLI** — pane 내부에서 `dmctl split-h`, `dmctl new-tab`, `dmctl focus 1.2.1` 등으로 워크스페이스 원격 제어.
- **파일 업/다운로드** — 드래그앤드롭 업로드 + `download <path>` 명령.
- **Claude Code MCP** — `list_panes`, `send_input`, `who_am_i` 등 7개 툴로 Claude 가 pane 조작.
- **테마 21종 + 커스텀** — xterm.js 터미널과 UI 양쪽 일괄 테마.

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
                                           └ bin/ (dmctl, edit, download, shell hooks)
```

- 프론트엔드는 `go:embed` 로 바이너리에 포함.
- 런타임 헬퍼(`dmctl`, `edit`, `download`, zsh/bash cwd 훅)도 `go:embed` → 서버 기동 시 `$DONGMINAL_HOME/bin/` 에 풀림. 각 pane 의 shell 은 자동으로 이 경로를 `PATH` 에 얹고 `ZDOTDIR`/`BASH_ENV` 로 훅 연결.
- PTY 프로세스는 브라우저 새로고침해도 유지 (서버 메모리 버퍼).
- 워크스페이스(탭/분할) 는 `workspace.json` 에 비동기 영속화 (H5 latest-wins coalescing).
- Claude Code 에서 MCP 로 pane 조작 가능 (`./scripts/install-mcp.sh`).

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
│   ├── runtime/         # 임베드된 bin/ 스크립트 + Install()
│   │   └── scripts/     # dmctl, edit, download, bash-hook.sh, zdotdir/.zshrc
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
