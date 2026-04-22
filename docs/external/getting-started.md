# 시작하기

## 요구사항

- Go 1.21+
- macOS 또는 Linux (PTY, `ps`, `lsof` 의존)
- zsh 또는 bash (cwd 훅용, 선택)

## 설치 & 실행

```bash
git clone <repo>
cd dongminal
./scripts/start.sh             # 빌드 + 실행 (기본 포트 58146)
```

포트 변경:

```bash
PORT=8080 ./scripts/start.sh
# 또는 빌드 후 직접 실행
PORT=8080 ./dongminal
```

중지:

```bash
./scripts/stop.sh
```

헬스 체크:

```bash
./scripts/health.sh
```

## 환경 변수

| 변수 | 기본 | 설명 |
|------|------|------|
| `PORT` | `8080` | HTTP 서버 포트 |
| `DATA_DIR` | `.` (현재 디렉터리) | `settings.json`, `workspace.json`, `panes/` 저장 위치 |
| `LOG` | `/tmp/dongminal.log` | `start.sh` 가 서버 로그를 리다이렉트할 파일 |
| `BINARY` | `dongminal` | 빌드될 바이너리 이름 |

`.env` 파일을 레포 루트에 두면 `start.sh` 가 자동 로드합니다 (`PORT=...` 한 줄씩).

## 접속

브라우저에서 `http://localhost:<PORT>/` 열면 바로 터미널이 뜹니다. 첫 Pane 은 자동 생성됩니다.



```

```



## 다음 단계

- 기능 전체는 [features.md](./features.md) 참고.
- 단축키 커스터마이징은 [shortcuts.md](./shortcuts.md).
- Claude Code 에 MCP 로 연결하려면 [mcp-setup.md](./mcp-setup.md).
