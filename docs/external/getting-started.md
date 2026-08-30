# 시작하기

## 요구사항

**받아서 쓰는 데 필요한 것은 없습니다.** 의존이 없는 단일 바이너리이고, 프론트엔드와
런타임 헬퍼까지 안에 들어 있습니다. Go 도 필요 없습니다.

| 항목 | 필요 여부 |
|---|---|
| macOS · Linux · WSL · **Windows 10 1809+** | 넷 다 지원 |
| Go 툴체인 | **불필요** (소스에서 빌드할 때만 — Go 1.24+) |
| zsh · bash · PowerShell | 셸은 자동으로 고릅니다 |
| `claude` CLI | 선택 — 에이전트 오케스트레이션용 |

Windows 최소 버전이 1809 인 이유는 ConPTY(`CreatePseudoConsole`)입니다. Windows 에서
PTY 의미론을 얻는 유일한 공식 경로이며 그 버전에서 도입됐습니다.

## 설치

[Releases](https://github.com/Biisairo/dongminal/releases/latest) 에서 자기 OS 것
**하나만** 받으면 됩니다.

### macOS

```bash
# Apple Silicon
curl -fL -o dongminal https://github.com/Biisairo/dongminal/releases/latest/download/dongminal-darwin-arm64
# Intel 이면 위 줄의 darwin-arm64 를 darwin-amd64 로

chmod +x dongminal
xattr -d com.apple.quarantine dongminal   # 서명·공증을 하지 않았으므로 필요합니다
./dongminal start
./dongminal window                        # 창을 띄웁니다 (선택)
```

`xattr` 를 건너뛰면 macOS 가 **"개발자를 확인할 수 없어 열 수 없습니다"** 로 막습니다.
프로그램이 깨진 것이 아닙니다.

### Linux · WSL

```bash
curl -fL -o dongminal https://github.com/Biisairo/dongminal/releases/latest/download/dongminal-linux-amd64
# ARM64 면 linux-arm64

chmod +x dongminal
./dongminal start
```

WSL 은 별도 대상이 아닙니다 — `linux-amd64` 를 그대로 씁니다.

### Windows 10 1809+

PowerShell 에서:

```powershell
curl.exe -fL -o dongminal.exe https://github.com/Biisairo/dongminal/releases/latest/download/dongminal-windows-amd64.exe
.\dongminal.exe start
.\dongminal.exe window                    # 창을 띄웁니다 (선택)
```

### 받은 파일 확인

```bash
curl -fLO https://github.com/Biisairo/dongminal/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

### 판 확인

```bash
./dongminal version
# dongminal v1.0.3 darwin/arm64 go1.25.4
```

`dev` 가 나오면 릴리스가 아니라 소스에서 빌드한 것입니다.

## 소스에서 빌드 (선택)

고치려는 사람만 필요합니다. Go 1.24+ 가 있으면 됩니다.

```bash
git clone https://github.com/Biisairo/dongminal
cd dongminal
./scripts/build.sh             # 호스트용 → ./dongminal
./dongminal start
```

교차 컴파일은 `./scripts/build.sh --help` 를 보세요. **`go build` 를 손으로 부르지
마세요** — macOS 대상은 cgo 가 필요한데 go 가 교차 빌드에서 그것을 자동으로 끄고,
그러면 CPU·메모리 지표가 빠진 바이너리가 조용히 나옵니다.

## 실행

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
| `doctor` | 이 호스트에서 플랫폼 계층이 실제로 도는지 계층별로 진단한다 |
| `verify` | 격리 인스턴스를 띄워 종단간 표면을 훑는다 (개발·CI) |
| `version` | 판·대상·go 런타임을 찍는다 (`--version` 도 동일) |

`start` 는 다음을 수행합니다.

1. `--expose` 를 해석해 바인드 주소 결정 (기본 `127.0.0.1`).
2. 대상 포트를 점유한 이전 프로세스가 있으면 `lsof` 로 종료. **`--isolated` 일 때는 하지 않습니다.**
3. `--restart-daemon` 이면 dongminald 를 정지하고 `paned.pid`·`paned.sock` 을 제거.
4. 자기 자신을 `start --foreground` 로 재실행해 백그라운드로 띄우고, 로그를 `$DONGMINAL_LOG` 로 리다이렉트.
5. `/api/ping` 이 응답할 때까지 최대 5초 대기.
6. 결과 안내 출력 (`local-only` / `LAN 노출` 표기).

창은 `start` 가 열지 않습니다 — `dongminal window` 가 따로 엽니다.

빌드는 하지 않습니다 — `./scripts/build.sh` 의 책임입니다.

### 훅이 죽을 때 — `health`

에이전트 훅이 `bin/dmctl: No such file or directory` 로 실패하면 설치된 헬퍼가
깨진 것입니다. `dongminal health` 가 그 사실을 알려 줍니다.

```bash
./dongminal health
```

고치는 방법은 서버를 다시 띄우는 것입니다 — 기동이 헬퍼를 다시 설치합니다.

### 안 될 때 — `doctor`

터미널이 뜨지 않거나 비어 보이면 먼저 이것을 돌립니다.

```bash
./dongminal doctor
```

서버가 쓰는 **바로 그 코드**를 계층별로 실제 실행합니다 — 헬퍼·셸 훅 설치, 셸 선택,
의사 터미널 기동과 명령 왕복, 도구 계층, 콘솔 없는 프로세스, 로컬 IPC, 프로세스 제어.
어느 계층에서 무슨 오류로 막혔는지 그대로 나오므로, 증상만으로 추측하지 않아도 됩니다.

「의사 터미널」이 세 단계인 것이 요점입니다 — **[단순 명령]** 이 실패하면 셸과 무관한
배관 문제이고, [맨 셸] 은 되는데 [훅 얹은 셸] 이 안 되면 범인은 훅입니다.

### `start` 옵션

| 옵션 | 설명 |
|---|---|
| `--expose` | `0.0.0.0` 에 바인드 (사내망 다른 기기에서 접근 가능) |
| `--restart-daemon` | dongminald 도 재시작 (터미널 세션을 잃습니다). dongminal 도구 안에서 실행하면 재시작을 대리 프로세스가 이어서 수행하고 출력은 `$DONGMINAL_HOME/restart.log` 에 남습니다 — 데몬을 내리는 순간 명령 자신도 함께 끊기기 때문입니다 |
| `--isolated` | 임시 홈 + 비어 있는 포트로 띄웁니다. 운영 인스턴스를 건드리지 않습니다 |
| `--foreground` | 터미널을 점유하며 실행 (`^C` 로 정지) |
| `--port <n>` / `--home <path>` | 모든 액션 공통. 환경변수보다 우선합니다 |

### 창 열기 — `window`

```bash
./dongminal window
```

**돌고 있는 서버에 주소창 없는 창을 하나 엽니다. 서버를 띄우지도, 죽이지도
않습니다.** 서버가 떠 있지 않으면 창을 열지 않고 그 사실을 알립니다 — 빈 화면을
띄우고 원인을 찾게 하지 않기 위해서입니다.

`--port` 로 겨눌 서버를 고릅니다(기본은 `start` 와 같은 규칙). 창을 여는 수단은
Chrome/Chromium 계열의 `--app` 이고, 없으면 기본 브라우저로 내려갑니다.

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
