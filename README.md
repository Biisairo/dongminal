# Dongminal

브라우저 기반 터미널 멀티플렉서. 분할 Pane, 탭, 세션, 테마, 파일 전송, Claude Code MCP 연동을 지원합니다.

단일 Go 바이너리에 프론트엔드(xterm.js)가 포함되어 있어 실행 파일 하나로 서비스가 가능합니다.

## 빠른 시작

```bash
./scripts/start.sh                  # 빌드 + 실행 (기본 포트 58146)
./scripts/stop.sh                   # 중지
PORT=8080 ./scripts/start.sh        # 포트 지정
```

상세는 [docs/external/getting-started.md](docs/external/getting-started.md).

## 문서

- **사용자**: [docs/external/](docs/external/) — 설치, 기능, 단축키, MCP 연동, API.
- **개발자**: [docs/internal/](docs/internal/) — 아키텍처, RFC, TODO.

## 아키텍처 개요

```
Browser (xterm.js) ← Binary WebSocket → Go Server (PTY) → Shell
                                          ↕
                                     settings.json / workspace.json
```

- 프론트엔드는 `go:embed` 로 바이너리에 포함.
- PTY 프로세스는 브라우저 새로고침해도 유지 (서버 메모리 버퍼).
- 워크스페이스(탭/분할) 는 `workspace.json` 에 비동기 영속화.
- Claude Code 에서 MCP 로 pane 조작 가능 (`./scripts/install-mcp.sh`).

자세한 패키지 구조와 핫패스 성능 설계는 [docs/internal/architecture.md](docs/internal/architecture.md).

## 프로젝트 구조

```
dongminal/
├── cmd/dongminal/       # main (composition root)
├── internal/            # adapters, clientpid, mcptool, outbuf, pane, runtime, server, workspace
├── web/                 # 프론트엔드 (HTML/CSS/JS, go:embed)
├── scripts/             # start/stop/health/install-mcp
├── docs/
│   ├── external/        # 사용자 가이드
│   └── internal/        # 개발자 문서 (RFC, TODO, 아키텍처)
├── go.mod
└── README.md
```

## 기술 스택

- **백엔드**: Go, `creack/pty`, `gorilla/websocket`, `go:embed`
- **프론트엔드**: xterm.js v5 (fit, search, web-links, unicode11 addons)

