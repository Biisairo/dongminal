# Dongminal

브라우저 기반 터미널 멀티플렉서. 분할 칸, 탭, 창, 테마, 파일 전송, 내장 편집기, 백그라운드 도구, dmctl 원격 제어 CLI, 에이전트 오케스트레이션, 에이전트 주의 알림, 에이전트 활동 모아보기를 지원합니다.

단일 Go 바이너리에 프론트엔드(xterm.js)와 런타임 헬퍼 스크립트가 모두 포함되어 있어 실행 파일 하나로 서비스가 가능합니다.

## 설치

**의존이 없는 단일 바이너리입니다.** 받아서 실행하면 끝이고 Go 도 필요 없습니다 —
프론트엔드(xterm.js)와 런타임 헬퍼까지 안에 들어 있습니다.

[Releases](https://github.com/Biisairo/dongminal/releases/latest) 에서 자기 OS 것
하나만 받으면 됩니다.

**macOS (Apple Silicon)**

```bash
curl -fL -o dongminal https://github.com/Biisairo/dongminal/releases/latest/download/dongminal-darwin-arm64
chmod +x dongminal && xattr -d com.apple.quarantine dongminal
./dongminal start --open
```

Intel 맥은 `darwin-arm64` 를 `darwin-amd64` 로 바꿉니다. `xattr` 한 줄이 필요한
이유는 코드 서명·공증을 하지 않았기 때문입니다 — 없으면 "열 수 없음" 에서 막힙니다.

**Linux · WSL**

```bash
curl -fL -o dongminal https://github.com/Biisairo/dongminal/releases/latest/download/dongminal-linux-amd64
chmod +x dongminal
./dongminal start
```

ARM64 는 `linux-amd64` 를 `linux-arm64` 로 바꿉니다.

**Windows 10 1809+** (PowerShell)

```powershell
curl.exe -fL -o dongminal.exe https://github.com/Biisairo/dongminal/releases/latest/download/dongminal-windows-amd64.exe
.\dongminal.exe start --open
```

받은 파일이 맞는지 확인하려면 같은 릴리스의 `SHA256SUMS` 를 씁니다.

```bash
curl -fLO https://github.com/Biisairo/dongminal/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

## 빠른 시작

```bash
./dongminal                           # 도움말 (-h, --help 도 동일)
./dongminal version                   # 판·대상·go 런타임 (--version 도 동일)
./dongminal start                     # 실행 (localhost only, 포트 58146, 창 유지)
PORT=8080 ./dongminal start           # 포트 지정 (--port 8080 도 동일)
./dongminal start --expose            # LAN 노출 실행 (사내망 다른 기기 접근 허용)
./dongminal start --restart-daemon    # dongminald까지 재시작 (창 초기화)
./dongminal start --open              # 실행 후 frameless window 열기
./dongminal start --isolated          # 임시 홈 + 빈 포트로 격리 실행 (운영 인스턴스 무관)
./dongminal start --foreground        # 터미널을 점유하며 실행 (^C 로 정지)
./dongminal stop                      # 중지 (창 유지)
./dongminal stop --all                # 전체 중지 (dongminald 포함)
./dongminal health                    # 헬스 체크
./dongminal doctor                    # 이 호스트에서 플랫폼 계층이 도는지 진단
./dongminal migrate --dry-run         # 스키마 변환 계획 확인
./dongminal migrate                   # 스키마 변환 (서버 정지 후)
```

액션 없이 실행하면 도움말이 나옵니다. 액션별 옵션은 `./dongminal <action> --help`.

브라우저에서 `http://localhost:<PORT>/` 접속. `--expose` 로 띄운 경우 같은 네트워크의 다른 기기에서 `http://<host-ip>:<PORT>/` 로도 접근됩니다.

터미널이 뜨지 않거나 비어 보이면 **`./dongminal doctor`** 를 먼저 돌립니다 — 셸 선택,
의사 터미널 기동, 로컬 IPC, 프로세스 제어를 계층별로 실제 실행해 어디서 막혔는지
그대로 보여 줍니다.

상세한 설치·실행·환경변수는 [docs/external/getting-started.md](docs/external/getting-started.md).

## 지원 플랫폼

macOS · Linux · **WSL** · **Windows 10 1809+** (native).

OS 마다 달라지는 것은 전부 `internal/shared/platform` 뒤에 있다 — PTY,
프로세스 제어·그룹, 프로세스 조회, 셸 선택과 훅, 로컬 IPC 종단, 경로 규약,
브라우저 실행. **그 패키지 밖에는 OS 분기가 한 줄도 없다.** 그 규칙을 강제하는
것이 `scripts/check-seams.sh` 다.

Windows 최소 버전이 1809 인 이유는 ConPTY(`CreatePseudoConsole`)다 — Windows 에서
PTY 의미론을 얻는 유일한 공식 경로이며 그 버전에서 도입됐다.

### 소스에서 빌드

받아서 쓰는 사람에게는 필요 없다 — 위 [설치](#설치)면 끝이다. 이 절은 고치는
사람을 위한 것이다. Go 1.24+ 가 필요하다.

Go 는 교차 컴파일이 기본이라 별도 툴체인이 필요 없다. 맥에서 윈도우·리눅스
바이너리가 그대로 나온다.

```bash
scripts/build.sh                        # 호스트용 하나 → ./dongminal
scripts/build.sh --os windows           # 윈도우용 → dist/dongminal-windows-amd64.exe
scripts/build.sh --os linux --arch arm64
scripts/build.sh --all                  # 배포 대상 5종 → dist/
VERSION=v1.0.0 scripts/build.sh --all   # 판을 새겨서 (릴리스가 쓰는 형태)
```

`VERSION` 을 주지 않으면 `dongminal version` 이 `dev` 를 낸다. 소스 빌드와 릴리스
산출물을 구별하기 위해서다.

대상은 darwin/arm64 · darwin/amd64 · linux/amd64 · linux/arm64 · windows/amd64 다.
WSL 은 별도 대상이 아니다 — `linux/amd64` 를 그대로 쓴다.

**cgo 주의.** 이 저장소의 cgo 는 하나뿐이다 — `sysstat` 의 mach 호출(macOS 의
CPU 사용률·메모리 사용량). linux·windows 는 그 지표를 `/proc` 과 WinAPI 로 읽으므로
cgo 가 필요 없고 정적 바이너리로 나온다.

문제는 go 가 GOOS/GOARCH 가 호스트와 다르면 `CGO_ENABLED` 를 자동으로 0 으로
내린다는 점이다. arm64 맥에서 `GOOS=darwin GOARCH=amd64 go build` 를 직접 부르면
**그 바이너리만 CPU·메모리 지표를 잃는다.** `build.sh` 가 darwin 대상에 한해
cgo 를 다시 켜므로, 손으로 `go build` 하지 말고 스크립트를 쓴다.

darwin 이 아닌 호스트에서 darwin 대상을 빌드하면 cgo 를 켤 수 없다. 그때는
건너뛰지 않고 지표가 빠진 채로 빌드하며 화면에 경고를 남긴다.

### 검사

```bash
scripts/check-cross.sh     # 5개 대상 build + vet (테스트 파일까지 타입 검사)
scripts/check-seams.sh     # OS 의존 호출이 platform 밖에 없는지
scripts/verify-isolated.sh # 격리 인스턴스를 띄워 종단간 22항목 (dongminal verify)
```

종단간 검사의 정의는 **Go 한 벌**이다 (`internal/ctl/cli/verify.go`). 세 OS 가 같은
목록을 돌고, CI 의 Linux·Windows 도 같은 것을 부른다 — 검사를 셸 스크립트로 두 벌
적던 것을 접었다. 설계는
[docs/internal/E2E_UNIFICATION_SRS.md](docs/internal/E2E_UNIFICATION_SRS.md).

### 배포

태그 `v*` 를 밀면 `.github/workflows/release.yml` 이 세 OS 에서 게이트(단위 테스트 ·
`doctor` · `verify`)를 돌리고, 다섯 대상을 빌드해 GitHub Releases 에 첨부한다.
바이너리는 저장소에 커밋하지 않는다 — 이유와 설계는
[docs/internal/RELEASE_SRS.md](docs/internal/RELEASE_SRS.md).

설계와 이음매 목록은 [docs/internal/CROSS_PLATFORM_SRS.md](docs/internal/CROSS_PLATFORM_SRS.md).

세 OS 모두 **실기에서 검증된다.** CI(`.github/workflows/verify.yml`)가 매 푸시마다
Linux·Windows 에서 단위 테스트 · `doctor` · `verify` 를 돌리고, macOS 는 개발자가
로컬에서 같은 것을 돈다. WinAPI 호출(ConPTY·Job Object·toolhelp)도 실제 Windows
러너에서 실행된다.

## 테스트

Go 테스트는 의존이 없다:

```bash
go test ./...            # 호스트(darwin·linux)
scripts/check-cross.sh   # 5개 대상 build + vet — 테스트 파일까지 타입 검사된다
```

e2e(Playwright)는 npm 이 필요하다. **빌드에는 필요 없다** — 프론트엔드는 번들러가
없고 `web/vendor/xterm.js` 가 저장소에 있어 `go build` 하나로 끝난다:

```bash
npm ci                    # Playwright 설치 (e2e 전용)
npx playwright install     # 브라우저 바이너리
npx playwright test        # 전량 (약 5분)
npx playwright test e2e/git-panel.spec.ts   # 스펙 하나
```

e2e 는 `go run ./cmd/dongminal start --foreground` 로 포트 58147 에 서버를 직접
띄우고 임시 홈을 쓴다 (`playwright.config.ts`). 운영 인스턴스와 겹치지 않는다.

수동으로 실동작을 확인할 때도 **운영 인스턴스를 건드리지 않는 경로**를 쓴다:

```bash
./dongminal start --isolated    # 임시 홈 + 빈 포트. 기존 서버를 죽이지 않는다
```

`dongminal stop` 은 홈이 아니라 **포트**로 대상을 찾는다. `--port` 없이 부르면
기본 포트(58146)의 인스턴스를 정지시키므로, 격리 인스턴스를 접을 때는 `start` 가
출력한 정지 명령(`--port`·`--home` 이 채워진 형태)을 그대로 쓴다.

종단간은 `dongminal verify` 다. 격리 인스턴스를 **스스로** 띄워 22항목을 훑고
치운다:

```bash
./dongminal verify           # 또는 scripts/verify-isolated.sh (빌드까지 함께)
```

검사 범위는 데몬 기동·`paned.sock`·`/api/ping`, 도구 생성(PTY+IPC 왕복)·조회·busy
RPC·출력 조회·**입력→출력 왕복**, 워크스페이스·설정·상태 조회, git 읽기 표면 8종과
없는 git 경로의 404, `index.html` 이 실제로 로드하는 `<script>` 전량 200, 구 평면
경로(`/js/app.js`) 404 다.

`verify` 는 `--port`·`--home` 을 **받지 않는다.** 언제나 임시 홈과 빈 포트에서 돌고,
`stop` 대신 자기가 띄운 PID 와 격리 홈의 `paned.pid` 만 직접 끝낸다 — 운영
인스턴스를 건드릴 방법이 없다. 홈이 격리 홈이 아니거나 포트가 58146 이면 아무것도
띄우지 않고 중단한다.

git 검사 대상은 **실제 리포**여야 한다 — 비-git 디렉터리는 `ErrNotRepo` 로 정당하게
404 라서 라우팅 누락과 구별되지 않는다. 저장소가 아니면 그 항목들은 이유와 함께
건너뛴다.

## 문서

- **변경 이력**: [CHANGELOG.md](CHANGELOG.md)
- **사용자**: [docs/external/](docs/external/) — 설치, 기능, 단축키, dmctl/edit/detach CLI, 에이전트 오케스트레이션, API.
- **개발자**: [docs/internal/](docs/internal/) — 아키텍처, 테스트 체크리스트, 인계 문서. 완료된 SRS·RFC 기록은 [docs/internal/archive/](docs/internal/archive/).

## 주요 기능

- **창/분할 칸/탭/도구** — 가로/세로 분할, 드래그 재배치, 레이아웃 프리셋, 워크스페이스 영속화.
- **주의 알림 (Tool Attention)** — 터미널 안 에이전트(Claude Code·Codex 등)·CLI가 작업을 끝내거나 입력을 기다리면, 보고 있지 않은 탭/창을 강조 + 🔔 모아보기(클릭 점프) + 브라우저 탭 제목 배지 + (권한 허용 시) OS 데스크톱 알림으로 알림. **에이전트 무관**한 터미널 출력 감시(OSC/idle) + `dmctl notify`(claude/codex 투명 래퍼가 hook 자동 주입) 기반.
- **에이전트 활동 모아보기 (Agent Activity Panel)** — 동시에 도는 여러 에이전트가 *지금 무엇을 하는지*(작업 중/완료/대기 상태 + 실행 툴·명령·파일)를 우측 접이식 패널에 카드로 모아 표시. 카드 클릭 시 해당 도구로 포커스 점프, attention 알람도 카드에 합성 표시. claude(PreToolUse/Stop/Notification hook)는 풍부하게, codex(turn-complete)는 보통, 그 외는 출력 기반 추정. 토글 단축키·새로고침 주기 설정 지원.
- **내장 편집기** — 터미널 안에서 `edit <path>` 실행 → 현재 분할 칸에 Monaco 편집기 탭.
- **백그라운드 도구** — `detach` 로 탭을 닫아도 도구가 계속 돈다. 상태 바 `⏻` 배지에서 목록 조회·복귀. tmux 의 detach 에 대응.
- **dmctl CLI** — 터미널 안에서 `dmctl split-h`, `dmctl new-tab`, `dmctl new-window`, `dmctl focus <uuid>`, `dmctl list-workspace`, `dmctl notify`, `dmctl activity` 등으로 워크스페이스 원격 제어·조회·알림·활동 보고.
- **파일 업/다운로드** — 드래그앤드롭 업로드 + `download <path>` 명령.
- **에이전트 오케스트레이션** — `dmctl read-screen`/`send-input`/`msg` 로 에이전트가 워크스페이스를 조회·조작하고 서로 통신. `/dongminal:team`·`/dongminal:workflow` 스킬이 dongminal 세션에만 주입된다 (사용자 설정 무오염, 설정 불필요).
- **테마 44종 + 커스텀** — 다크 33 · 라이트 11. xterm.js 터미널과 UI 양쪽 일괄 테마.

## 아키텍처 개요

바이너리는 하나인데 **프로세스 역할은 넷**이다. `main()` 이 argv 로 갈라진다.

```
Browser (xterm.js)                    ┌─ ② dongminald ─────────────┐
   │  Binary WebSocket                │   PTY 소유 · ToolManager    │
   ├────────────────────▶ ③ dongminal │   브라우저 새로고침에도 유지 │──▶ Shell
   │                       (웹 서버)  └────────────┬───────────────┘
   └─ SSE /api/commands/sse ◀── HTTP/WS/SSE        │ Unix socket
                                  │               │ (paned.sock)
                                  ↕               ↕
                          DONGMINAL_HOME/
                            ├ settings.json
                            ├ workspace.json   (schemaVersion 2)
                            ├ tools.json
                            └ bin/ ──▶ ① dmctl / edit / download / detach
                                       (같은 바이너리의 multi-call symlink)

④ dongminal start|stop|health|migrate   — 제어 CLI. ③ 을 띄우고 접는다
```

데몬이 PTY 를 들고 있어서 웹 서버를 재시작해도 터미널 세션이 살아남는다. 데몬이
없으면 ③ 이 자기 프로세스에 ToolManager 를 만든다(direct mode) — 그래서
`shared/toolhub` 를 ②③ 이 함께 실행한다.

- 프론트엔드는 `go:embed` 로 바이너리에 포함.
- 런타임 헬퍼(`dmctl`, `edit`, `download`, `detach`)는 multi-call CLI — `$DONGMINAL_HOME/bin/` 에 바이너리를 가리키는 symlink 로 설치된다. zsh/bash cwd 훅은 `go:embed` 로 풀린다. 각 터미널의 shell 은 자동으로 이 경로를 `PATH` 에 얹고 `ZDOTDIR`/`BASH_ENV` 로 훅 연결.
- PTY 프로세스는 브라우저 새로고침해도 유지 (서버 메모리 버퍼).
- 워크스페이스(창/분할 칸/탭) 는 `workspace.json` 에 비동기 영속화 (H5 latest-wins coalescing). 탭이 참조하는 도구는 `tools.json` 에 기록되고, 백그라운드 도구는 기록되지 않아 데몬 재시작을 넘기지 않는다.
- 에이전트 접합면: 액션은 `dmctl` 서브커맨드, 정책은 `--plugin-dir`/`--settings` 로 세션 스코프 주입되는 스킬·훅. 등록 절차 없음. 자세히는 [docs/external/agent-orchestration.md](docs/external/agent-orchestration.md).
- 주의 알림: 서버가 도구 출력을 관찰(OSC 9/99/777·idle)하거나 `dmctl notify`(claude/codex 투명 래퍼가 자동 주입한 hook 이 호출)로 주의 상태를 잡아 SSE(`tool_attention`) 로 브라우저에 전달. 자세히는 [docs/internal/archive/PANE_ATTENTION_NOTIFY_SRS.md](docs/internal/archive/PANE_ATTENTION_NOTIFY_SRS.md).
- 에이전트 활동: attention 과 직교하는 "현재 작업 상태(activity)" 레이어. 에이전트 hook 이 `dmctl activity` 로 보고(stdin hook JSON 파싱) → `POST /api/tools/activity/set` → SSE(`tool_activity`) 발행. 도구당 최신 1개 상태만 보관(히스토리 없음). 자세히는 [docs/internal/archive/AGENT_ACTIVITY_PANEL_SRS.md](docs/internal/archive/AGENT_ACTIVITY_PANEL_SRS.md).

자세한 패키지 구조와 핫패스 성능 설계는 [docs/internal/architecture.md](docs/internal/architecture.md).

## 프로젝트 구조

`internal/` 은 **프로세스 축**으로 묶여 있다. 판정 기준은 "링크되냐"가 아니라
"어느 프로세스가 실제로 실행하냐"다 — 단일 바이너리라 링크 클로저는 네 프로세스가
모두 같아서 그것으로는 아무것도 갈리지 않는다. 둘 이상이 실행하는 것만 `shared/` 다.

```
dongminal/
├── cmd/dongminal/           # main (composition root) — 진입점 판별 + 의존 조립
├── internal/
│   ├── helper/              # ① dmctl/edit/download/detach 프로세스
│   │   ├── runtimebin/      #   multi-call CLI (dmctl notify·activity 포함)
│   │   └── toolline/        #   dmctl 공용 한 줄 렌더러
│   ├── daemon/              # ② dongminald 프로세스 — PTY 소유
│   │   ├── boot/            #   데몬 진입점 (runDaemon)
│   │   └── ipc/             #   PanedServer — Unix socket accept 루프
│   ├── webserver/           # ③ 웹 서버 프로세스 — HTTP/WS/SSE
│   │   ├── httpapi/         #   HTTP/WS/SSE 라우팅 + settingsStore + 잔여 핸들러
│   │   ├── gitapi/          #   /api/git/* 핸들러 (GitServer)
│   │   ├── hub/             #   CommandHub·SSE·FocusRegistry·AttnTracker
│   │   ├── toolclient/      #   ToolClient — 데몬에 붙는 IPC 클라
│   │   ├── seam/            #   접합면
│   │   │   ├── adapters/    #     toolaccess ↔ httpapi/workspace 브리지
│   │   │   ├── toolaccess/  #     도구·워크스페이스·커맨드 인터페이스
│   │   │   └── clientpid/   #     remoteAddr → client PID
│   │   └── domain/          #   도메인
│   │       ├── git/         #     core(Service·Exec·ExecWrite·guard) / query(조회)
│   │       │                #     write(변경) / store(TTL+single-flight) / jobs(잡 큐)
│   │       ├── run/         #     Run 오케스트레이션 실행 기록
│   │       ├── worktree/    #     worktree 격리 관리
│   │       └── sysstat/     #     상태바 지표 샘플러
│   ├── ctl/                 # ④ 제어 CLI 프로세스
│   │   ├── cli/             #   start/stop/health/migrate 디스패치
│   │   └── migrate/         #   v1 → v2 엔티티 스키마 마이그레이션
│   └── shared/              # 둘 이상의 프로세스가 실행
│       ├── workspace/       #   ①②③ — workspace.json Manager (atomic + async writer)
│       ├── uuid/            #   ②③④ — 엔티티 uuid 생성·검증
│       ├── toolhub/         #   ②③  — ToolManager·PTY·브라우저 WS·주의 탐지
│       ├── toolipc/         #   ②③  — paned 와이어 포맷
│       ├── outbuf/          #   ②③  — PTY 출력 바운디드 스트림
│       ├── runtime/         #   ②③  — bin/ 설치 + 임베드 shellhooks·agentplugin
│       │   ├── shellhooks/  #     bash-hook.sh, zdotdir/.zshrc (cwd 훅 + claude/codex 래퍼)
│       │   └── agentplugin/ #     세션 스코프 주입 플러그인 (skills/team, skills/workflow)
│       └── agentadapter/    #   ①③  — 에이전트 hook JSON 해석
├── web/                     # 프론트엔드 (HTML/CSS/JS, go:embed)
│   └── js/
│       ├── core/            #   App 클래스(app.js + 주제별 app-*.js 13) + constants·helpers·main
│       ├── ui/              #   themes·renderer·term-pane·input-binding·file-editor
│       └── git/             #   git 패널 11파일
├── e2e/                     # Playwright 스펙 + git 픽스처
├── scripts/                 # build.sh — 빌드 / verify-isolated.sh — 격리 실동작 검증
├── docs/
│   ├── external/            # 사용자 가이드
│   └── internal/            # 개발자 문서 (RFC, TODO, 아키텍처)
├── go.mod
└── README.md
```

프론트엔드는 번들러가 없다. `index.html` 이 `<script>` 로 원본을 순서대로 로드하므로
**로드 순서가 곧 의존성**이다. `app-*.js` 는 `Object.assign(App.prototype, …)` 로
클래스를 확장하므로 `app.js` 뒤에 와야 한다.

## 기술 스택

- **백엔드**: Go 1.24+, `creack/pty`, `gorilla/websocket`, `go:embed`
- **프론트엔드**: xterm.js v5 (fit, search, web-links, unicode11 addons)
- **선택 의존성**: `claude` CLI (에이전트 오케스트레이션 시)

## TODO

- focused browser 자동 동기화 — **범위가 줄었다.** 창 포커스 소유권이 서버 권위로 옮겨져(FR-XDF-*) 기기 간에도 동기화되고, 이제 *마지막으로 포커스한* 브라우저의 창 크기가 적용된다 (예전엔 마지막으로 *새로고침한* 브라우저였다). 남은 결손: 소유자가 OS 포커스를 잃은 채 소유권을 유지하면 아무도 리사이즈를 보내지 않아 크기가 그 시점에 고정된다
- 주의 알림: 서버 호스트(브라우저 없는 원격 머신)용 OS 알림/웹훅·모바일 푸시 — 현재는 접속한 브라우저에만 표시됨
- 데스크톱 래핑 (tauri, electron 등)
- mobile mode: Ctrl+C/D/Z 단발 버튼, 키 커스터마이즈, modifier sticky/lock 시각 강화 (RFC §8)