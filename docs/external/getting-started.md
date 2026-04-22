# 시작하기

## 요구사항

- Go 1.21+
- macOS 또는 Linux (PTY, `ps`, `lsof` 의존)
- zsh 또는 bash (현재 디렉터리 상태 바 표시용 — 선택)
- `code-server` (pane 에서 `edit <path>` 로 원격 VSCode 열 때만 필요 — 선택)
- `claude` CLI (MCP 자동 등록 시 — 선택)

## 설치 & 실행

```bash
git clone <repo>
cd dongminal
./scripts/start.sh             # 빌드 + 실행 (기본 포트 58146)
```

`start.sh` 는 다음을 수행합니다.

1. 레포 루트의 `.env` 가 있으면 자동 `source`.
2. 대상 포트를 점유한 이전 프로세스가 있으면 `lsof` 로 종료.
3. `go build -o $BINARY ./cmd/dongminal` 로 빌드.
4. `PORT=$PORT DONGMINAL_HOME=$DONGMINAL_HOME ./$BINARY` 로 백그라운드 기동, 로그는 `$LOG` 로 리다이렉트.
5. 포트 바인드 확인 후 `http://localhost:$PORT` 안내 출력.

바이너리를 직접 실행할 수도 있습니다(빌드는 수동).

```bash
go build -o dongminal ./cmd/dongminal
PORT=58146 ./dongminal            # 기본값은 8080 (start.sh 없이 직접 실행 시)
```

중지 / 헬스 체크:

```bash
./scripts/stop.sh                 # 포트 점유 프로세스 종료
./scripts/health.sh               # HTTP GET 으로 응답 확인
```

## 환경 변수

| 변수 | 기본 | 설명 |
|------|------|------|
| `PORT` | `58146` (start.sh) / `8080` (바이너리 직접 실행) | HTTP 서버 포트 |
| `DONGMINAL_HOME` | `~/.dongminal` | 설치 루트. `bin/`(런타임 헬퍼 스크립트), `settings.json`, `workspace.json`, `panes/` 모두 이 아래. 없으면 서버 기동 시 자동 생성 |
| `DONGMINAL_PORT` | = `PORT` | 서버가 자식 PTY 프로세스에 주입. `dmctl`, `edit` 가 서버로 HTTP 콜 할 때 사용 |
| `DONGMINAL_HOST` | `127.0.0.1` | `dmctl` 이 사용하는 호스트 (필요 시 pane 에서 수동 export) |
| `LOG` | `/tmp/dongminal.log` | `start.sh` 가 서버 로그를 리다이렉트할 파일 |
| `BINARY` | `dongminal` | 빌드될 바이너리 이름 |

### `.env` 로드

레포 루트의 `.env` 는 `start.sh` / `stop.sh` / `health.sh` 가 자동으로 `set -a; source .env; set +a` 방식으로 로드합니다. 샘플은 `.env.example`:

```
PORT=58146
BINARY=dongminal
LOG=/tmp/dongminal.log
DONGMINAL_HOME=~/.dongminal
```

### 런타임 헬퍼 배포 (자동)

서버 기동 시 `internal/runtime` 이 `go:embed` 로 번들한 스크립트를 `$DONGMINAL_HOME/bin/` 으로 풀어냅니다.

- `bin/dmctl` — 워크스페이스 원격 제어 CLI (분할/탭/포커스)
- `bin/edit` — code-server 런처
- `bin/download` — 파일을 브라우저로 다운로드
- `bin/bash-hook.sh`, `bin/zdotdir/.zshrc` — 현재 디렉터리 OSC 리포트 훅

각 pane 의 shell 은 서버가 다음을 주입한 환경으로 스폰되므로 PATH 를 수동 설정할 필요가 없습니다.

- `PATH=<기존 PATH>:$DONGMINAL_HOME/bin`
- zsh → `ZDOTDIR=$DONGMINAL_HOME/bin/zdotdir`
- bash → `BASH_ENV=$DONGMINAL_HOME/bin/bash-hook.sh`
- `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG/LC_ALL/LC_CTYPE=en_US.UTF-8`

외부 터미널에서도 `dmctl`/`edit` 를 쓰고 싶다면 별도로 `PATH`/`DONGMINAL_PORT` 를 export 하면 됩니다.

## 접속

브라우저에서 `http://localhost:<PORT>/` 를 열면 즉시 터미널이 뜨고 첫 Pane 이 자동 생성됩니다.

## 다음 단계

- 기능 전체: [features.md](./features.md)
- 단축키 커스터마이징: [shortcuts.md](./shortcuts.md)
- pane 내부에서 쓰는 `dmctl` / `edit` / `download` CLI: [commands.md](./commands.md)
- Claude Code MCP 연동: [mcp-setup.md](./mcp-setup.md)
- HTTP/WebSocket/SSE/OSC: [api.md](./api.md)
