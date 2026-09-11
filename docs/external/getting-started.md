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

### 브라우저 (M5 `G10-2`)

**화면은 브라우저에 있습니다.** 서버가 어디서 돌든 여러분이 보는 것은 브라우저이고,
그래서 그쪽의 최소 버전이 이 제품의 요구사항입니다.

| 브라우저 | 최소 | 비고 |
|---|---|---|
| Chrome · Edge · Brave 등 Chromium 계열 | 111 | **권장.** `dongminal window` 의 frameless 창(`--app`)이 여기만 있습니다 |
| Safari | 16.4 | 동작합니다. frameless 창은 기본 브라우저로 내려갑니다 |
| Firefox | 121 | 동작합니다. 같음 |

버전 하한은 CSS `:has()` 와 중첩 규칙이 정합니다 — 스타일이 그 위에 서 있어서,
그보다 낮으면 화면이 어긋난 채로 뜹니다.

### 모바일

**읽고 가볍게 만지는 데까지**를 지원합니다. 모바일 전용 키바가 있고 레이아웃이
좁은 화면을 따라갑니다. 하지만 **긴 작업의 자리로 설계하지 않았습니다** — 분할
칸과 다중 창이 모바일에서 뜻을 잃습니다.

- iOS Safari 16.4+ · Android Chrome 111+
- **데스크톱 알림은 동작하지 않습니다** (§보안 참고 — 평문 접속이면 어디서나 같습니다)
- 홈 화면에 추가하면 독립 창으로 뜹니다 (웹 앱 매니페스트)

### 선택 의존 — 없으면 어떻게 되나 (M5 `G10-2`)

**셋 다 없어도 서버는 뜹니다.** 없으면 그 기능만 조용히 빠지는 것이 아니라,
**화면이 그 사실을 말합니다.**

| 도구 | 쓰는 곳 | 없으면 |
|---|---|---|
| `git` | Git 사이드바 전부 · 편집기의 dirty-diff | Git 표면이 `git_missing` 코드로 답합니다. 터미널·편집기는 그대로 동작합니다 |
| `docker` | 샌드박스 창 | 샌드박스 창을 만들 때 *"컨테이너 런타임이 설치되어 실행 중인지 확인하세요"* 가 뜹니다. **설치됐는데 멎어 있는 경우와 가릅니다** — 사용자가 할 일이 다르기 때문입니다 |
| `rg` (ripgrep) | 파일 내용 검색 | 느린 내장 검색으로 내려갑니다. 결과는 같고 큰 저장소에서 시간이 걸립니다 |

### `linux/arm64` 는 검증되지 않았습니다 (M5 `G10-5`)

릴리스에 `dongminal-linux-arm64` 를 올리지만 **그 대상에서 실기 검증을 하지
않습니다.** CI 는 `ubuntu-latest`(x86_64) · `windows-latest` · `macos`(arm64)
셋에서 돌고, 리눅스 ARM 은 **교차 컴파일만 확인**합니다.

빌드가 되는 것과 도는 것은 다른 물음입니다. 라즈베리파이나 ARM 서버에서 쓰시면
동작할 가능성이 높지만 **우리가 그것을 보증하지 않습니다.** 문제가 있으면
알려 주세요 — 그 보고가 이 칸을 채우는 유일한 길입니다.

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

**`--expose` 만으로는 아무 보호가 없습니다.** 이 서버가 여는 것은 터미널·파일·명령
실행이므로, 노출된 상태에서 그 네트워크의 누구나 그 전부에 접근할 수 있습니다.

#### 접속 허용 목록 (Settings ▸ Access)

들여보낼 출발지를 지정합니다. 토글을 켜야 적용되며, 기본값은 꺼짐(지금까지의 동작)입니다.

| 넣는 값 | 예 |
|---|---|
| IP | `100.117.248.111` |
| 대역(CIDR) | `192.168.0.0/24` |
| 이름 | `macmini`, `macmini.tail5da9ae.ts.net` |

- 이름은 서버가 주기적으로 **정방향 해석**해 IP 와 대조합니다. 해석된 주소는 설정
  화면의 줄 끝에 보이고, 해석되지 않으면 그 줄은 아무도 통과시키지 않습니다.
  `*.local`(mDNS)은 해석되지 않습니다.
- **서버가 도는 컴퓨터에서는 목록과 무관하게 언제나 접속됩니다.** 이름·VPN 종류와
  무관합니다 — 잘못 설정해도 그 컴퓨터에서 되돌릴 수 있습니다.
- 같은 기기라도 **Tailscale 로 붙을 때와 같은 LAN 에서 붙을 때 출발지가 다릅니다.**
  두 경로를 다 쓴다면 두 값을 모두 넣으세요. 설정 화면이 "지금 내 주소" 를 보여줍니다.
- 목록은 `$DONGMINAL_HOME/access.json` 에 저장됩니다.

이것은 **기기**를 가리는 수단이지 인증이 아닙니다. 허용된 출발지 뒤의 사람이 누구인지
서버는 알지 못하며, 통신은 평문 HTTP 그대로입니다.

#### 이 컴퓨터의 별명 (Settings ▸ Access)

접속에는 축이 둘입니다. 위의 허용 목록이 **누가 들어오는가**(출발지 IP)를 보고, 이 칸이
**뭐라고 불리며 들어오는가**(`Host` 이름)를 봅니다.

서버는 자기 이름을 운영체제 컴퓨터 이름으로만 압니다. 그것이 접속에 쓰는 이름과 다르면
(예: macOS 컴퓨터 이름은 `MyMac`, Tailscale 노드 이름은 `macmini-office`) **정적 화면은
뜨지만 `/api/*`·`/ws` 가 421 로 끊깁니다.** 그 이름을 이 칸에 넣으면 통합니다.

| 넣는 값 | 예 |
|---|---|
| MagicDNS 짧은 이름 | `macmini-office` |
| FQDN | `macmini-office.tail5da9ae.ts.net` |
| mDNS 이름 | `macmini.local` |

- **적용 토글과 무관하게 항상 적용됩니다.** 이름 판정은 DNS 리바인딩 방어이고, 그것은
  허용 목록을 켰는지와 별개로 돌아야 합니다.
- 이름은 **해석하지 않고 그대로 비교**합니다. 그래서 위 목록과 달리 `.local` 도 유효합니다.
- **와일드카드(`*.ts.net`)는 쓸 수 없습니다.** 이 칸은 리바인딩 방어의 화이트리스트이므로
  넓힐 수 있는 문법을 두지 않습니다 — 넣을 것은 이 컴퓨터가 불리는 이름뿐입니다.
- 이미 이름으로 막힌 브라우저에서는 이 칸을 고칠 수 없습니다(설정 화면도 `/api/*` 를
  씁니다). 서버가 도는 컴퓨터에서, 또는 IP 로 접속해 고치세요.
- 목록은 같은 `access.json` 의 `hosts` 에 저장됩니다.

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

여기 있는 것이 **전부**입니다. 코드에 있는데 이 표에 없는 변수(또는 그 반대)는
CI 가 잡습니다 (`scripts/check-env-docs.sh`) — 문서는 조용히 낡으므로 사람의 눈을
집행자로 두지 않습니다.

### 서버 기동

| 변수 | 기본 | 설명 |
|------|------|------|
| `PORT` | `58146` | HTTP 서버 포트. `--port` 가 우선. **숫자가 아니거나 1~65535 밖이면 기동 전에 거부**되고, 그 문구에 변수 이름과 값이 실립니다 |
| `DONGMINAL_PORT` | = `PORT` | 같은 포트를 가리키는 두 번째 이름. `PORT` 가 먼저입니다. 서버가 자식 PTY 프로세스에 주입하므로 `dmctl`·`edit` 가 이 값으로 서버에 되붙습니다 |
| `DONGMINAL_HOST` | `127.0.0.1` | HTTP 서버 바인딩 주소. `--expose`(=`0.0.0.0`) 가 우선. `dmctl` 도 이 값으로 서버에 접속합니다.<br>**loopback(`127.0.0.1`·`::1`·`localhost`)이 아니면 전부 "노출" 입니다** — `192.168.x` 같은 주소도 노출이고, 그때는 Settings ▸ Access 의 허용 목록을 켜야 서버가 뜹니다 |
| `DONGMINAL_HOME` | `~/.dongminal` | 설치 루트. `bin/`(런타임 헬퍼), `server.json`, `settings.json`, `access.json`(접속 허용 목록), `workspace.json`, `tools.json`, `notes/`(메모장) 모두 이 아래. 없으면 서버 기동 시 자동 생성 |
| `DONGMINAL_LOG` | `/tmp/dongminal.log`<br>(Windows: `%LOCALAPPDATA%` 아래) | `start` 가 배경 모드에서 서버 로그를 리다이렉트할 파일 |
| `DONGMINAL_LOG_LEVEL` | `info` | 로그 수준 — `debug`·`info`·`warn`·`error`. 알 수 없는 값은 `info` 로 떨어집니다 |
| `DONGMINAL_RESTART_RUNNER` | (내부) | **직접 설정하지 마세요.** `--restart-daemon` 이 재시작을 대리 프로세스에 넘길 때 그 대리에게 심는 표시입니다 — 대리가 다시 위임하지 않게 하는 것이 전부입니다 |

### 도구 셸에 주입되는 값

서버가 도구(터미널 탭)의 셸에 직접 심는 값입니다. **사용자가 설정할 것이
아니라**, 그 셸 안에서 도는 프로그램이 자기 자리를 알기 위해 읽는 값입니다.

| 변수 | 기본 | 설명 |
|------|------|------|
| `DONGMINAL_TOOL_ID` | (주입) | 이 셸이 어느 도구 안인지. `dmctl` 이 자기 정체를 이것으로 압니다 |
| `DONGMINAL_TOOL_HOME` | 사용자 홈 | 도구 셸이 자기 `HOME` 으로 여길 곳. 비면 사용자 홈입니다. 검사·격리 기동이 도구 셸을 사용자 홈에서 떼어내는 자리입니다 |
| `DONGMINAL_HISTFILE` | `<home>/tool-history/…` | 도구 셸이 쓸 히스토리 파일. macOS `/etc/zshrc` 가 `HISTFILE` 을 무조건 덮으므로, 값은 서버가 정하고 zdotdir 의 rc 가 이 변수로 되살립니다 |
| `DONGMINAL_SHELL` | 로그인 셸 | 도구 셸로 띄울 프로그램을 강제합니다. 비면 플랫폼 계층이 고릅니다 |

### 동작 조정

| 변수 | 기본 | 설명 |
|------|------|------|
| `DONGMINAL_ATTENTION_IDLE_MS` | `10000` | 도구가 이만큼 조용하면 "대기" 로 봅니다(L2 판정). `0` 이면 그 판정을 끕니다 |
| `DONGMINAL_ATTENTION_BELL` | (꺼짐) | `1` 이면 맨 BEL(`\a`) 하나도 주의 신호로 셉니다. 기본이 꺼짐인 것은 BEL 이 시끄럽기 때문입니다 — 탭 자동완성 하나에도 울립니다 |
| `DONGMINAL_CMD_RESULT_TIMEOUT_MS` | `3000` | 명령 결과를 기다리는 long-poll 상한 |
| `DONGMINAL_URL_OPEN` | (자동 판정) | `local` 또는 `viewer`. 서버가 URL 을 **어디서** 열지의 판정을 강제합니다 |

### 빌드

| 변수 | 기본 | 설명 |
|------|------|------|
| `BINARY` | `dongminal` | `./scripts/build.sh` 가 만들 바이너리 이름 |

### 우선순위

**플래그 > 환경변수 > `$DONGMINAL_HOME/server.json` > 기본값** 입니다.
레포 루트의 `.env` 는 더 이상 읽히지 않습니다.

빈 값은 "정하지 않음" 이라 다음 계층으로 넘어갑니다. 지금 실효값이 무엇이고
**어디서 왔는지**는 이것으로 봅니다:

```bash
dongminal config show          # 값과 출처(flag/env/file/default)
dongminal config validate      # 설정 파일을 스키마에 대조 (불일치가 있으면 exit 1)
```

### `server.json` — 기계마다 다른 기동값을 고정합니다

`$DONGMINAL_HOME/server.json` 에 두면 셸 프로필이나 래퍼 스크립트 없이 기동값이
따라옵니다. 없는 것이 정상이고, 없으면 조용히 넘어갑니다.

```json
{
  "host": "127.0.0.1",
  "port": "58146",
  "logLevel": "info",
  "logFile": "/tmp/dongminal.log"
}
```

**깨져 있어도 서버는 뜹니다.** 경고를 내고 다음 계층으로 갑니다 — 설정 파일
하나가 서버를 못 뜨게 만들면 그것을 고칠 화면에 닿을 수 없기 때문입니다.
(`access.json` 은 반대로 읽지 못하면 loopback 만 통과시킵니다. 그쪽은 **경계**고
이쪽은 **편의**라 답이 갈립니다.)

브라우저 설정(테마·단축키·상태바·레이아웃)은 여기가 아니라 `settings.json` 이며,
**서버는 그것을 해석하지 않습니다.** `dongminal config validate` 로 대조할 수는
있지만, 그것은 사람이 부를 때만 도는 진단이고 요청 경로에 없습니다.

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

## 데이터가 어디 있나요 (M5 `G10-3`)

전부 `$DONGMINAL_HOME`(기본 `~/.dongminal`) 아래에 있습니다. **이 폴더 밖에
상태를 두지 않습니다** — 로그 하나만 예외입니다.

| 자리 | 무엇 | 옮겨지나 |
|---|---|---|
| `workspace.json` | 창·칸·탭의 배치 | ✅ `backup` 이 담습니다 |
| `settings.json` | 테마·단축키·상태바·레이아웃 프리셋 | ✅ |
| `access.json` | 접속 허용 목록 | ✅ |
| `runs.json` | Run(오케스트레이션) 기록 | ✅ |
| `tools.json` | 도구의 이름·작업 폴더 | ✅ |
| `server.json` | 서버 기동값 | ✅ |
| `sandbox.json` | 샌드박스 프로파일 | ✅ |
| `notes/` | 메모장 | ✅ |
| `bin/` | 런타임 헬퍼 | ❌ 기동마다 다시 채웁니다 |
| `tool-history/` | 도구 셸의 히스토리 | ❌ |
| `paned.sock` · `paned.pid` | 데몬 IPC | ❌ |
| `.lastexit` | 마지막 종료가 정상이었는지 | ❌ |
| `server.log` · `daemon.log` · `restart.log` | 로그 | ❌ |
| `$DONGMINAL_LOG` (기본 `/tmp/dongminal.log`) | 배경 모드 기동 로그 — **홈 밖입니다** | ❌ |

```bash
dongminal backup --out ~/dm-backup.zip   # 옮겨지는 것 전부
dongminal restore ~/dm-backup.zip --yes  # 되돌리기
dongminal uninstall --dry-run            # 지울 것을 먼저 봅니다
```

**브라우저에도 일부가 삽니다.** 기기별 취향(알림 켬/끔·슬롯 방향)은
`localStorage` 에, 탭별 값(표시 모드)은 `sessionStorage` 에 있습니다.
Settings ▸ Backup 의 내보내기가 그 셋을 한 파일로 담습니다.

## 지원 범위와 폐기 정책 (M5 `G10-4`)

### 지원하는 것

- **최신 릴리스 한 판.** 옛 판의 수정본을 따로 내지 않습니다. 문제가 있으면
  최신으로 올려 주세요 — `dongminal update --check` 가 그것이 있는지 알려 줍니다.
- 위 §요구사항의 OS·브라우저 조합.

### 스키마 호환 약속

- **`workspace.json` 의 `schemaVersion` 은 위아래 모두 거부합니다.** 판이 뒤진
  서버가 앞선 파일을 열면 빈 배치를 저장해 **덮어쓰기** 때문입니다. 판을 올릴 때
  `dongminal migrate` 가 변환합니다.
- **`settings.json` 은 모르는 키를 무시합니다.** 판이 앞선 브라우저가 쓴 값이
  뒤진 서버에서 지워지지 않습니다. `dongminal config validate` 로 대조할 수는
  있지만, 알 수 없는 키는 **경고이지 오류가 아닙니다.**
- **`server.json` 은 깨져도 기동을 막지 않습니다.** 경고를 내고 다음 계층으로
  갑니다 — 설정 파일 하나가 서버를 못 뜨게 하면 그것을 고칠 화면에 닿을 수 없습니다.

### 폐기 정책

- **없앨 것은 한 판 앞서 알립니다.** CHANGELOG 에 적고, 해당 표면이 경고를 냅니다.
- **환경변수의 이름은 계약입니다.** 바꾸지 않습니다.
- **인증과 TLS 는 확정된 비목표입니다.** 추가 예정이 아니며, 그 경계는
  [`SECURITY.md`](../../SECURITY.md) 에 적혀 있습니다.

## 다음 단계

- **노출해서 쓸 때의 경계: [SECURITY.md](../../SECURITY.md)** — 무엇을 보증하고
  무엇을 보증하지 않는지
- 기능 전체: [features.md](./features.md)
- 오류 코드와 복구 안내: [errors.md](./errors.md)
- 단축키 커스터마이징: [shortcuts.md](./shortcuts.md)
- 터미널 안에서 쓰는 `dmctl` / `edit` / `download` CLI: [commands.md](./commands.md)
- 에이전트 오케스트레이션: [agent-orchestration.md](./agent-orchestration.md)
- HTTP/WebSocket/SSE/OSC: [api.md](./api.md)
