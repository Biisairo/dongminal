# 시작하기

## 요구사항

- Go 1.21+
- macOS 또는 Linux (PTY, `ps`, `lsof` 의존)
- zsh 또는 bash (현재 디렉터리 상태 바 표시용 — 선택)
- `claude` CLI (에이전트 오케스트레이션 — 선택)

## 설치 & 실행

```bash
git clone <repo>
cd dongminal
./scripts/build.sh             # 빌드 — 저장소의 유일한 스크립트
./dongminal start              # 실행 (기본: localhost only, 포트 58146)
```

운영 동작은 모두 바이너리의 **액션**입니다. 액션 없이 실행하면 도움말이 나옵니다.

```bash
./dongminal                    # 도움말 (-h, --help 도 동일)
./dongminal <action> --help    # 액션별 옵션
```

| 액션 | 설명 |
|---|---|
| `start` | 서버를 띄운다 |
| `stop` | 서버를 정지한다 |
| `migrate` | 워크스페이스 데이터를 최신 스키마로 변환한다 (1회성) |
| `health` | 서버와 dongminald 의 상태를 확인한다 |

`start` 는 다음을 수행합니다.

1. `--expose` 를 해석해 바인드 주소 결정 (기본 `127.0.0.1`).
2. 대상 포트를 점유한 이전 프로세스가 있으면 `lsof` 로 종료. **`--isolated` 일 때는 하지 않습니다.**
3. `--restart-daemon` 이면 dongminald 를 정지하고 `paned.pid`·`paned.sock` 을 제거.
4. 자기 자신을 `start --foreground` 로 재실행해 백그라운드로 띄우고, 로그를 `$DONGMINAL_LOG` 로 리다이렉트.
5. `/api/ping` 이 응답할 때까지 최대 5초 대기.
6. 결과 안내 출력 (`local-only` / `LAN 노출` 표기). `--open` 이면 frameless window 를 엽니다.

빌드는 하지 않습니다 — `./scripts/build.sh` 의 책임입니다.

### `start` 옵션

| 옵션 | 설명 |
|---|---|
| `--expose` | `0.0.0.0` 에 바인드 (사내망 다른 기기에서 접근 가능) |
| `--restart-daemon` | dongminald 도 재시작 (터미널 세션을 잃습니다) |
| `--isolated` | 임시 홈 + 비어 있는 포트로 띄웁니다. 운영 인스턴스를 건드리지 않습니다 |
| `--open` | 준비되면 frameless window(Chrome `--app`)를 엽니다 |
| `--foreground` | 터미널을 점유하며 실행 (`^C` 로 정지) |
| `--port <n>` / `--home <path>` | 모든 액션 공통. 환경변수보다 우선합니다 |

### 외부 노출/비노출 선택

기본값은 **localhost 전용**(127.0.0.1) 으로, 동일 PC 외에는 접근할 수 없습니다. 사내망의 다른 기기에서도 접근하려면 `--expose` 로 띄워야 합니다.

```bash
./dongminal start                              # 127.0.0.1 바인딩 (동일 PC 에서만 접근)
./dongminal start --expose                     # 0.0.0.0 바인딩 (사내망 다른 기기에서도 접근)
DONGMINAL_HOST=0.0.0.0 ./dongminal start       # 동등한 형태
```

### 격리 실행

운영 인스턴스(`~/.dongminal`, 포트 58146)를 건드리지 않고 별도 인스턴스를 띄웁니다. 검증·실험용입니다.

```bash
./dongminal start --isolated
# → 임시 홈과 빈 포트를 골라 띄우고, 정지 명령을 함께 출력합니다.
#   격리 홈은 자동으로 지우지 않습니다.
```

`--port` / `--home` 을 함께 주면 그 값이 이깁니다.

### 중지 / 헬스 체크

```bash
./dongminal stop                  # 서버만 정지 (dongminald 는 세션 유지)
./dongminal stop --all            # dongminald 까지 정지
./dongminal health                # HTTP 응답 + dongminald 소켓·pid 확인
```

## 환경 변수

| 변수 | 기본 | 설명 |
|------|------|------|
| `PORT` | `58146` | HTTP 서버 포트. `--port` 가 우선 |
| `DONGMINAL_HOME` | `~/.dongminal` | 설치 루트. `bin/`(런타임 헬퍼), `settings.json`, `workspace.json`, `tools.json` 모두 이 아래. 없으면 서버 기동 시 자동 생성 |
| `DONGMINAL_PORT` | = `PORT` | 서버가 자식 PTY 프로세스에 주입. `dmctl`, `edit` 가 서버로 HTTP 콜 할 때 사용 |
| `DONGMINAL_HOST` | `127.0.0.1` | HTTP 서버 바인딩 주소. `127.0.0.1` 은 동일 PC 전용, `0.0.0.0` 은 LAN 노출. `--expose` 가 우선. `dmctl` 도 이 값으로 서버에 접속 |
| `DONGMINAL_LOG` | `/tmp/dongminal.log` | `start` 가 배경 모드에서 서버 로그를 리다이렉트할 파일 |
| `BINARY` | `dongminal` | `./scripts/build.sh` 가 만들 바이너리 이름 |

우선순위는 **플래그 > 환경변수 > 기본값**입니다. 레포 루트의 `.env` 는 더 이상
읽히지 않습니다 — 셸 환경변수로 주거나 `--port`/`--home` 을 쓰세요.

### 런타임 헬퍼 배포 (자동)

서버 기동 시 `internal/shared/runtime` 이 `$DONGMINAL_HOME/bin/` 을 채웁니다. helper CLI 는 dongminal 바이너리를 가리키는 symlink, 셸 훅은 `go:embed` 로 번들한 실제 파일입니다.

- `bin/dmctl` — 워크스페이스 원격 제어 CLI (분할/탭/포커스/목록/알림)
- `bin/edit` — 내장 편집기 탭으로 파일 열기
- `bin/download` — 파일을 브라우저로 다운로드
- `bin/detach` — 현재 도구를 백그라운드로 보내고 탭 닫기
- `bin/bash-hook.sh`, `bin/zdotdir/.zshrc` — 현재 디렉터리 OSC 리포트 훅
- `bin/agent-hooks/` — claude 래퍼가 주입하는 hooks settings

각 터미널 도구의 shell 은 서버가 다음을 주입한 환경으로 스폰되므로 PATH 를 수동 설정할 필요가 없습니다.

- `PATH=<기존 PATH>:$DONGMINAL_HOME/bin`
- zsh → `ZDOTDIR=$DONGMINAL_HOME/bin/zdotdir`
- bash → `BASH_ENV=$DONGMINAL_HOME/bin/bash-hook.sh`
- `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG/LC_ALL/LC_CTYPE=en_US.UTF-8`
- `DONGMINAL_PORT=<서버 포트>`, `DONGMINAL_TOOL_ID=<도구 id>`

외부 터미널에서도 `dmctl`/`edit` 를 쓰고 싶다면 별도로 `PATH`/`DONGMINAL_PORT` 를 export 하면 됩니다.

## 접속

브라우저에서 `http://localhost:<PORT>/` 를 열면 즉시 터미널이 뜨고 첫 도구가 자동 생성됩니다.

## 다음 단계

- 기능 전체: [features.md](./features.md)
- 단축키 커스터마이징: [shortcuts.md](./shortcuts.md)
- 터미널 안에서 쓰는 `dmctl` / `edit` / `download` CLI: [commands.md](./commands.md)
- 에이전트 오케스트레이션: [agent-orchestration.md](./agent-orchestration.md)
- HTTP/WebSocket/SSE/OSC: [api.md](./api.md)
