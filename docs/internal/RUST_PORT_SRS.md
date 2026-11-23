# RUST_PORT_SRS — Go 구현 전체의 Rust 포팅

- 문서 형식: ISO/IEC/IEEE 29148:2018 소프트웨어 요구사항 명세(SRS)
- 요구사항 접두어: `FR-RSP-n`(기능), `NFR-RSP-n`(비기능), `C-RSP-n`(제약), `V-RSP-n`(검증)
- 기준선: Go 구현 커밋 `127ff7d9`(v1.3.7)를 **go1.27.2 툴체인, GOEXPERIMENT 기본값**(JSONv2 위의 encoding/json v1 호환층 포함)으로 빌드한 바이너리. 운영 바이너리와 같은 판이다. 릴리즈·CI 가 쓰는 go.mod 의 go 1.26.11 은 기준이 아니다(사용자 결정, 2026-11-23). Go 참조 바이너리와 Go 테스트는 이 툴체인으로 만든다
- 작업 브랜치: `rust-port`(통합), `rp/<이슈 ID>`(이슈별)
- 이슈 관리: `rust-port/issues/`(파일 하나가 이슈 하나)

## 1. 소개

### 1.1 목적

이 문서는 dongminal 의 Go 구현 전체(`cmd/`, `internal/`)를 Rust 로 다시 구현하는 작업의 요구사항을 정한다. 이 문서는 포팅 작업의 단일 진실 공급원이다. 이슈 문서와 구현이 이 문서와 충돌하면 작업을 멈추고 충돌을 보고한다.

### 1.2 범위

포함한다.

- Go 바이너리 `dongminal` 하나가 맡는 네 가지 프로세스 역할 전부. ① 런타임 헬퍼(`dmctl`·`edit`·`download`·`detach`, multi-call), ② 데몬 `dongminald`(`dongminal d`), ③ 웹 서버(`dongminal start`), ④ 제어 CLI(`start`·`stop`·`health`·`migrate` 등).
- 위 역할이 외부에 보이는 모든 표면. CLI 인자·출력·종료 코드, HTTP·WebSocket·SSE API, 유닉스 소켓·named pipe IPC, 간선(edge) TLS 프로토콜, `DONGMINAL_HOME` 아래 파일의 형식, 환경변수, 설치되는 셸 훅·에이전트 플러그인 자산.
- 다섯 대상 플랫폼. darwin/arm64, darwin/amd64, linux/amd64, linux/arm64, windows/amd64.
- `scripts/` 의 Go 보조 도구 4종(`check-action-reasons`, `check-shared-constants`, `gen-decisions`, `gen-errors`). 이 도구들은 CI 게이트에만 쓰이므로 마지막 순서로 둔다.

포함하지 않는다.

- 웹 프론트엔드(`web/` 의 JS·CSS·HTML·자산). 이 파일들은 바꾸지 않고 Rust 바이너리에 그대로 임베드한다.
- Playwright e2e 스위트(`e2e/`). 바이너리 경로를 바꾸는 최소 수정 외에는 손대지 않고, 검증 수단으로 쓴다.
- 기준선 이후에 Go 쪽에 생긴 기능 변경. 이런 변경은 별도 이슈로 따라간다(FR-RSP-40).

### 1.3 정의

| 용어 | 뜻 |
|---|---|
| 관측 동작 | 사용자, 브라우저, 다른 프로세스(에이전트·셸·다른 PC 의 노드)가 보거나 받을 수 있는 모든 결과. 화면 출력, 응답 바이트, 파일 내용, 종료 코드, 타이밍 계약(타임아웃·재시도 간격)을 포함한다 |
| 내부 동작 | 관측 동작에 드러나지 않는 구현 세부. 함수 구조, 동시성 모델, 내부 자료구조, 단위 테스트의 모양 |
| 동등 | 같은 입력과 같은 환경에서 두 구현의 관측 동작을 사용자가 구별할 수 없는 상태 |
| 운영 인스턴스 | 이 기계에서 지금 돌고 있는 Go 서버·데몬·특권 헬퍼와, 이들이 쓰는 `~/.dongminal` 홈 |
| 격리 실행 | 임시 `DONGMINAL_HOME`, 운영과 겹치지 않는 포트, `DONGMINAL_*` 환경변수를 지운 환경에서 바이너리를 실행하는 것 |
| 이슈 | `rust-port/issues/` 아래의 파일 하나. 2.6 절의 형식을 따른다 |

### 1.4 참고 문서

- `docs/internal/architecture.md` — 프로세스 역할, 패키지 레이아웃, IPC, 동시성, 종료 경로
- `docs/internal/*_SRS.md` — 기능별 기존 요구사항. 이 SRS 의 동등 요구를 판단할 때 근거 자료로 쓴다
- `docs/external/` — 사용자 문서. 사용자가 기대하는 동작의 근거
- `scripts/check-home-layout.sh` 와 `docs/external/getting-started.md` 의 "데이터가 어디 있나요" 표 — 홈 아래 파일의 전수 목록
- `scripts/build.sh` — 릴리즈 빌드 플래그(`Version`, `DaemonBuild` 각인)

### 1.5 문서 구성

2장은 제품 관점과 제약, 3장은 요구사항, 4장은 검증 방법, 5장은 이슈 트리의 뼈대를 다룬다.

## 2. 전체 설명

### 2.1 제품 관점

Rust 구현은 Go 구현을 대체한다. 바이너리 이름(`dongminal`), 하위 명령, 홈 레이아웃, 와이어 형식이 같으므로, 사용자는 바이너리만 바꾸고 같은 홈을 계속 쓴다. 전환 시점은 이 SRS 의 범위 밖이며, 사용자가 4장의 검증 결과를 보고 결정한다.

### 2.2 제품 기능

Go 구현과 같다. 기능 목록의 근거는 `architecture.md` 의 패키지 레이아웃과 기존 SRS 문서다.

### 2.3 사용자 특성

- 최종 사용자: 브라우저로 dongminal 을 쓰는 개발자. Rust 판으로 바뀐 사실을 몰라야 한다.
- 에이전트: 터미널 탭 안에서 `dmctl` 을 부르는 claude·codex 등. 출력 형식에 의존해 파싱한다.
- 다른 PC 의 노드: 간선으로 연결된 Go 판 또는 Rust 판 dongminal.

### 2.4 제약

- **C-RSP-1 (운영 무중단)** 포팅 중에 운영 인스턴스를 내리거나, 재시작하거나, swap 하거나, 설정을 바꾸지 않는다. 구체적으로 다음을 금지한다.
  - 저장소 루트의 `./dongminal` 을 덮어쓰기. 루트에서 `go build -o dongminal` 이나 `scripts/build.sh` 를 실행하는 것도 포함한다.
  - 격리되지 않은 환경에서 Go·Rust 바이너리의 `start`·`stop`·`d`·`update`·`rollback`·`service`·`uninstall`·`migrate` 를 실행하기.
  - `~/.dongminal` 아래의 파일·소켓에 쓰거나 연결하기. 읽기도 하지 않는다.
  - 운영 서버의 포트나 1024~60146 범위의 포트를 잡기. 격리 실행은 60147 이상을 쓴다.
  - 특권 헬퍼(`/Library/PrivilegedHelperTools/com.dongminal.helper`)나 launchd·systemd 서비스를 설치하거나, 제거하거나, 호출하기. 예외: 데몬이 부팅할 때와 30초마다 헬퍼 소켓(`/var/run/com.dongminal.helper.sock`)에 보내는 읽기 전용 `info`(공개키 조회)는 허용한다. 기준선 Go 데몬과 e2e 가 이미 하는 동작이고 헬퍼 상태를 바꾸지 않는다. `sign`·`kill`·`kick` 등 다른 요청은 금지한다.
  - `pkill`·`killall` 처럼 이름으로 프로세스를 죽이기. 프로세스를 끌 때는 자기가 띄운 PID 만 끈다.
- **C-RSP-2 (기준선 고정)** 포팅의 기준은 커밋 `127ff7d9` 의 Go 코드다. 포팅 브랜치에서 Go 코드를 고치지 않는다. 다만 e2e 가 Rust 바이너리를 쓰게 하는 경로 수정(FR-RSP-31)만 예외로 한다.
- **C-RSP-3 (의존성 보안)** 외부 crate 는 다음을 모두 만족해야 한다. 널리 쓰이고, 유지보수가 계속되며, RustSec 권고에 걸리지 않는다. 맞는 crate 가 없으면 직접 구현한다. 허용 목록은 `rust/DEPENDENCIES.md` 에 두고, 목록에 없는 crate 를 더하려면 그 문서를 먼저 고친다.
- **C-RSP-4 (unsafe)** `unsafe` 는 OS 호출 이음매 crate(`dm-shared-platform`), PTY·소켓 fd 전달 코드, `dm-webserver-domain-sysstat` 의 OS 모듈 하나(Go 도 platform 을 거치지 않고 OS 를 직접 부르는 자리), `dm-gocompat` 의 Windows 전용 `FormatMessageW(LANG_ENGLISH)` 호출 하나(platform 이 gocompat 에 의존하므로 platform 에 둘 수 없는 자리)에서만 쓴다. 쓰는 곳마다 `// SAFETY:` 주석으로 불변 조건을 적는다.
- **C-RSP-5 (커밋)** 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. 이슈 브랜치와 `rust-port` 에는 자동으로 커밋해도 된다. `main` 병합과 push 는 사용자 확인을 받은 뒤에만 한다.

### 2.5 가정과 의존

- A-1 Rust 툴체인은 stable 1.95 이상이다.
- A-2 Go 툴체인은 기준선 동작을 확인하는 참조 구현으로 계속 쓴다. Go 테스트는 격리 실행으로만 돌린다.
- A-3 웹 프론트엔드는 서버 API 만 보고 동작하므로, 서버 와이어가 같으면 프론트엔드는 바꾸지 않아도 된다.

### 2.6 이슈 파일 형식

- 경로: `rust-port/issues/<ID>-<짧은 이름>.md`. ID 는 점으로 이은 트리 경로다(예: `2.3.1`). 부모는 ID 의 마지막 조각을 뗀 것이다.
- 머리말(YAML):

```yaml
id: 2.3
title: shared/edge 포팅
status: todo | ready | in-progress | review | done | blocked | split
deps: [1.2, 1.3]        # 이 이슈가 쓰는 crate 를 만드는 이슈
go: [internal/shared/edge]
crates: [dm-shared-edge]
owner: <탭 uuid 또는 비움>
branch: rp/2.3
```

- 본문: 목표, 대상 Go 코드, 관측 표면, 완료 조건, 진행 기록.
- 이슈가 너무 크면 `status: split` 으로 바꾸고 하위 이슈(`2.3.1`, `2.3.2` …)를 만든다.

## 3. 구체 요구사항

### 3.1 동등성

- **FR-RSP-1** Rust 바이너리의 관측 동작은 같은 입력에서 Go 기준선과 동등해야 한다.
- **FR-RSP-2** 내부 동작은 같지 않아도 된다. Go 의 함수·패키지 구조, goroutine 모델, 단위 테스트를 그대로 옮길 필요는 없다. Go 테스트는 관측 동작의 명세로 읽고, 관측 동작을 검증하는 테스트만 Rust 로 옮긴다.
- **FR-RSP-3** 다음 표면은 바이트 단위로 같아야 한다.
  1. CLI 의 stdout·stderr·종료 코드. 도움말, 오류 문구, 표 정렬을 포함한다.
  2. HTTP 응답의 상태 코드, 본문, 의미 있는 헤더(`Content-Type`, `Cache-Control`, `Location`, `Set-Cookie`, CORS·보안 헤더). `Date` 처럼 값이 매번 바뀌는 헤더는 존재 여부만 같으면 된다.
  3. WebSocket 메시지와 SSE 이벤트의 이름·데이터.
  4. IPC 소켓의 프레이밍과 메시지.
  5. 홈 아래 파일의 내용. JSON 은 필드 순서, 들여쓰기, Go `encoding/json` 의 HTML 이스케이프(`<`·`>`·`&` → `<` 등), 시간 형식(RFC 3339 나노초)까지 같아야 한다.
- **FR-RSP-4** 타이밍 계약(타임아웃, 재시도 횟수·간격, 디바운스, 폴링 주기)은 Go 기준선의 상수와 같아야 한다.
- **FR-RSP-5** 동시 요청에서 생기는 순서·경쟁 결과 중 관측 동작에 드러나는 것(예: workspace 저장의 latest-wins)은 같아야 한다.
- **FR-RSP-6 (보안 강화)** Go 기준선에서 보안 약점(권한 누락, 명령 주입, 경로 탈출, 자원 고갈 등)이 발견되면 Rust 판에서는 고친다. 단 정상 사용자가 차이를 알아챌 수 없는 범위에서만 고친다. 고친 내용은 3.7 의 표에 적는다. 이 요구는 FR-RSP-1·3 보다 앞선다. (사용자 결정, 2026-11-23)
- **FR-RSP-7 (결함 수정)** 포팅 중에 발견한 Go 기준선의 결함(충돌, 자원 누수, 명백한 오동작)도 FR-RSP-6 과 같은 조건으로 고치고 3.7 에 적는다. 사용자가 의존할 수 있는 동작이면 고치지 않고 3.7 에 "보류"로 적는다.

### 3.2 바이너리와 프로세스 역할

- **FR-RSP-10** 산출 바이너리 이름은 `dongminal`(Windows 는 `dongminal.exe`)이다. 같은 바이너리가 argv[0] 과 첫 인자로 네 역할을 가른다. 판정 규칙은 Go 의 `cmd/dongminal/main.go` 와 `runtimebin.Dispatch` 와 같다.
- **FR-RSP-11** 빌드할 때 `Version` 과 `DaemonBuild` 지문을 각인할 수 있어야 한다. 각인 방법은 환경변수(`DONGMINAL_BUILD_VERSION`, `DONGMINAL_BUILD_DAEMON`)를 `build.rs` 가 읽는 방식으로 한다. 각인하지 않았을 때의 기본값은 Go 와 같다.
- **FR-RSP-12** 웹 자산(`web/` 의 임베드 대상)은 Go `web/embed.go` 의 패턴과 같은 파일 집합을 바이너리에 싣는다.
- **FR-RSP-13** 런타임 헬퍼 설치(`$DONGMINAL_HOME/bin/` 의 symlink, 셸 훅, 에이전트 훅·플러그인 자산)는 Go 와 같은 경로에 같은 내용으로 만든다.

### 3.3 상호 운용

- **FR-RSP-20** Rust 판과 Go 판은 같은 홈을 번갈아 써도 서로의 파일을 읽을 수 있어야 한다.
- **FR-RSP-21** Rust `dmctl` 은 Go 서버에, Go `dmctl` 은 Rust 서버에 붙어 같은 결과를 내야 한다.
- **FR-RSP-22** Rust 판 데몬은 Go 판 데몬에게서 handover(`d --handover-fd`)를 받아 PTY 세션을 잃지 않고 이어받아야 한다. 이 요구는 운영 인스턴스를 Rust 판으로 바꿀 때 세션을 잃지 않기 위한 것이다. 검증은 격리 실행으로만 한다.
- **FR-RSP-23** Rust 노드와 Go 노드는 간선(TLS, mesh, relay)으로 서로 연결되어야 한다.

### 3.4 저장소 구조

- **FR-RSP-30** Rust 코드는 저장소의 `rust/` 아래 Cargo 워크스페이스에 둔다. crate 는 Go 패키지 경로를 따른다. 예: `internal/shared/edge` → `rust/crates/shared/edge`(crate 이름 `dm-shared-edge`), `cmd/dongminal` → `rust/crates/cmd/dongminal`. 여러 Go 패키지를 한 crate 로 묶거나 한 패키지를 여러 crate 로 나눠도 되지만, 그 사실을 이슈에 적는다.
- **FR-RSP-31** e2e 의 `globalSetup` 은 환경변수 `DM_E2E_PREBUILT_BIN` 이 있으면 Go 빌드 대신 그 경로의 바이너리를 복사해 쓴다. 없으면 지금과 똑같이 동작한다.
- **FR-RSP-32** Go 의 JSON·flag·시간·오류 문자열 규칙을 흉내 내는 공통 코드는 `dm-gocompat` crate 하나에 모은다. 다른 crate 가 같은 규칙을 따로 구현하지 않는다.
- **FR-RSP-33 (입출력 모델)** `dm-shared-platform` 은 동기(std) API 만 낸다. 근거: Go 가 블로킹 I/O 모델이고, Windows AF_UNIX 는 std·tokio 모두 지원하지 않으며, PTY 읽기도 블로킹이다. 비동기 소비자(웹 서버·데몬)는 `tokio::task::spawn_blocking` 이나 전용 스레드로 감싼다. unix 의 IPC 스트림은 `into_std()` 뒤 `tokio::net::UnixStream::from_std` 로 바꿔 써도 된다. (1.4 결정 D-1)
- **FR-RSP-35 (OS 오류 문구)** 로그·HTTP 오류 본문·CLI 출력에 드러나는 파일·OS 오류 문구는 Go 의 `*os.PathError`(`op path: 문구`)·`*os.LinkError`(`op old new: 문구`)·`*os.SyscallError` 와 같아야 한다. errno 문구는 unix 에서 Go `syscall` 의 표(소문자)를, Windows 에서 Go 와 같은 FormatMessage 결과를 쓴다. 이 규칙은 `dm-gocompat` 의 오류 타입(`GoPathError` 등, `io::Error` 로 감싸 `ErrorKind` 보존)으로만 만든다. (1.4.2 제안)
- **FR-RSP-34 (로그 요청 ID)** Go 의 `context.Context` 로 넘기던 요청 ID 는 `dm-shared-dmlog` 의 `ReqCtx<'a> = Option<&'a str>` 를 첫 인자로 넘긴다.

- **FR-RSP-36 (동시성 모델)** `dm-shared-platform` 위의 계층은 tokio 를 기본 런타임으로 쓴다. Go 의 goroutine 은 tokio task 로, `context.Context` 의 취소는 `tokio_util::sync::CancellationToken` 으로 옮긴다(`dm-shared-pollwait`·`dm-shared-fanout` 이 이 모양이다). 블로킹 I/O(platform, PTY 읽기, 파일 잠금)는 `spawn_blocking` 이나 전용 스레드에서 돈다. CLI 처럼 Go `context.Background()` 로 부르던 쪽은 취소하지 않는 토큰을 넘기고, 필요하면 current-thread 런타임을 띄운다. (1.2 결정)

### 3.5 작업 절차

- **FR-RSP-40** 기준선 이후 `main` 에 들어온 Go 변경은 `9.x` 이슈로 따라간다.
- **FR-RSP-41** 이슈 하나는 에이전트 하나가 자기 worktree(`/Users/dykim/personal/dongminal-rust/<ID>`)와 브랜치 `rp/<ID>` 에서 진행한다.
- **FR-RSP-42** 이슈는 `deps` 의 이슈가 모두 `done` 이 된 뒤에 시작한다. 시작할 때 `rust-port` 의 최신 상태에서 브랜치를 딴다.
- **FR-RSP-43** 에이전트는 진행 상태를 자기 이슈 파일의 머리말 `status` 와 본문 "진행 기록" 에만 적는다. 다른 이슈 파일은 고치지 않는다. 단 자기 이슈를 나눌 때 하위 이슈 파일을 만드는 것은 예외로 한다.
- **FR-RSP-44** 이슈가 끝나면 에이전트는 상태를 `review` 로 바꾸고 조정자에게 알린다. 조정자는 확인한 뒤 `rust-port` 로 병합하고 상태를 `done` 으로 바꾼다.

### 3.6 비기능 요구

- **NFR-RSP-1 (보안)** `cargo deny check`(advisories·bans·licenses·sources)와 `cargo audit` 를 통과해야 한다. 허용 라이선스는 MIT, Apache-2.0, BSD-2/3-Clause, ISC, Unicode-3.0, Zlib 다.
- **NFR-RSP-2 (안정성)** 패닉은 프로세스 경계에서 잡아 Go 의 recover 동작과 같은 결과(로그 + 해당 요청만 실패)를 낸다. 데몬은 한 연결의 패닉으로 죽지 않는다.
- **NFR-RSP-3 (성능)** 핫패스(PTY 출력 전달, workspace 저장, git 관측)의 지연과 메모리 사용량은 Go 기준선보다 나쁘지 않아야 한다.
- **NFR-RSP-4 (품질 게이트)** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` 를 통과해야 한다.
- **NFR-RSP-5 (크로스 빌드)** 2.2 의 다섯 대상 전부에서 `cargo check --workspace --target <t>` 가 통과해야 한다.

### 3.7 의도한 차이와 알려진 차이

FR-RSP-6·7 에 따라 고친 것과, 구현 한계로 남은 차이를 적는다. ID 는 `DIFF-n` 이다(`D-` 로 시작하면 결정 색인 `decisions.md` 가 결정으로 모은다). Go 쪽 수정 여부는 사용자가 정한다(C-RSP-2: 포팅 브랜치에서는 Go 를 고치지 않는다).

| ID | 종류 | 자리 | Go 기준선 | Rust 판 | 근거 |
|---|---|---|---|---|---|
| DIFF-1 | 보안 강화 | platform IPC (Windows) | 소켓에 chmod 0600 → Windows 에서는 읽기 전용 속성만 바뀌어 다른 사용자도 연결 가능 | 소유자 전용 DACL | 1.4.5 보안 검토 |
| DIFF-2 | 보안 강화 | platform browser (WSL 폴백) | `powershell.exe -NoProfile -Command Start-Process <url>` — url 이 스크립트로 해석되어 명령 주입 | url 을 작은따옴표 축자 문자열로 넘긴다(`'` 와 굽은 홑따옴표 U+2018~201B 는 겹쳐 쓴다). 같은 인용 함수를 쓰는 Windows 셸 인용·훅 닷소싱도 함께 강화된다. 이 문자가 없는 입력의 출력은 Go 와 같다 | 1.4.3 보안 검토 |
| DIFF-3 | 알려진 차이 | gocompat json 디코딩 | 중첩 깊이 10000 까지 성공 | 513 이상이면 `exceeded max depth` (스택 넘침 방지) | 1.1 |
| DIFF-4 | 알려진 차이 | gocompat json 디코딩 | 타입 오류 때 일부 채운 값을 남긴다 | 값을 돌려주지 않는다. 그 값을 쓰는 Go 코드가 없음을 각 이슈가 확인한다 | 1.1 |
| DIFF-5 | 알려진 차이 | gocompat filepath (Windows) | `EvalSymlinks` 가 경로 대소문자를 실제 이름으로 정규화(toNorm) | 정규화하지 않는다(gocompat 에 OS 호출을 두지 않는다). 관측 자리를 만나면 platform 으로 옮긴다 | 4.1.1 |
| DIFF-6 | 알려진 차이 | gocompat time | 연도 ±9999 밖도 담고 `year outside of range` 오류를 낸다 | time crate 가 그 범위를 담지 못해 그 오류가 생기지 않는다(파싱 단계에서 거절) | 1.1 |
| DIFF-7 | 보안 강화 | platform PTY (넘겨받은 셸·Windows) | 거둔(adopt) 셸의 PID 에 신호를 보낸다 — PID 가 재사용되면 다른 프로세스를 죽일 수 있다 | 거둔 셸에는 신호를 보내지 않는다. 경합 상황에서만 다르다 | 1.4.6 |
| DIFF-8 | 결함 수정 | ctl/migrate | workspace 가 `null` 이면 패닉 | 빈 객체로 다룬다 | 6.2 |
| DIFF-9 | 보안 강화 | ctl/privhelper | 동시 연결 수에 상한이 없어 자원 고갈 가능 | 동시 연결 상한 32 | 6.2 |
| DIFF-10 | 보안 강화 | webserver/fswatch (macOS kqueue) | 디렉터리의 모든 항목(특수 파일 포함)을 감시 대상으로 열어 fd 가 바닥날 수 있다 | 특수 파일(FIFO·소켓·장치)은 건너뛰고 디렉터리당 4096 항목까지만 감시한다 | 4.7 |
| DIFF-11 | 보안 강화 | shared/toolhub (붙여넣기 감싸기) | `wrapPaste` 가 본문의 `ESC[201~` 를 한 번만 지워, 지운 자리에서 끝 표시가 다시 생겨 bracketed paste 를 빠져나갈 수 있다 | 끝 표시가 남지 않을 때까지 지운다 | 2.2.3 |
| DIFF-12 | 구현 차이 | shared/sandbox (dev 빌드 헬퍼) | 컨테이너용 헬퍼를 `go build` 로 교차 빌드하고, 실패 안내도 `go build` 를 가리킨다 | `cargo` 로 교차 빌드하고 안내도 실제로 돈 명령을 가리킨다(틀린 명령을 안내하지 않는다). 릴리즈 빌드에는 닿지 않는 dev 경로다 | 2.5 |
| DIFF-13 | 보안 강화 | git write (push) | 사용자가 준 remote·branch 를 그대로 refspec 로 넘겨 `+`(강제)·`:`(삭제)·`-`(옵션)이 해석된다 | 그런 remote·branch 는 거절한다 | 4.2 |
| DIFF-14 | 보안 강화 | git write (경로 인자) | 경로를 pathspec 매직 없이 넘겨 `:` 로 시작하는 경로가 매직으로 해석된다(clean 만 `:(literal)`) | 사용자 경로마다 `:(literal)` 접두를 붙여 축자로 넘긴다(실행 기록 argv 에 접두가 보인다) | 4.2 |
| DIFF-15 | 보안 강화 | git write (.gitignore 쓰기) | `.gitignore` 가 심볼릭 링크면 따라가 저장소 밖 파일을 쓸 수 있다 | 링크 대상이 저장소 밖이면 거절한다 | 4.2 |
| DIFF-16 | 보안 강화 | ctl restart (`restart.log`) | 권한 0644 로 열어 다른 사용자가 재시작 기록을 읽을 수 있다 | 0600 으로 연다 | 6.1.2 |
| DIFF-17 | 보안 강화 | daemon chat (direct 방 기록 열기) | direct 방 기록의 name 을 보지 않는다 | name 이 있으면 그 기록을 버린다 | 3.1 |
| DIFF-18 | 보안 강화 | daemon chat (상태 검사) | 상태의 참가자 kind 를 보지 않는다 | kind 가 agent·user 가 아니면 그 상태를 버린다 | 3.1 |
| DIFF-19 | 보안 강화 | daemon chat (재전송 막기 marks, 상한 4096) | 가득 차면 가장 오래된 번호를 밀어내므로, 일부러 밀어내 재전송 막기를 우회할 수 있다 | 닿은 적 없는 노드의 번호만 밀어낸다. 밀어낼 것이 없으면 아는 노드를 잊지 않고 새 노드를 받지 않는다 | 3.1 |
| DIFF-20 | 결함 수정 | ctl doctor (도구 진단 임시 디렉터리) | 저장 중지와 경쟁해 홈에 `doctor-tools/` 가 남을 수 있다 | 저장을 멈춘 뒤 지워 남기지 않는다 | 6.1.2 |
| DIFF-21 | 보안 강화 | edgemesh (재전송 막기 marks, 상한 4096) | 가득 차면 가장 오래된 번호를 밀어내므로, 일부러 밀어내 재전송 막기를 우회할 수 있다 | DIFF-19 와 같다. 남은 위험(DIFF-19 공통): 간선 상대가 이어진 가짜 지문을 대량으로 알리면 번호 기억이 차서 새 노드를 받지 못할 수 있다 — 8 통합 검증에서 TTL 또는 간선 상대별 몫으로 다시 본다 | 3.1 |
| DIFF-22 | 보안 강화 | ctl doctor `--bundle` (항목 가림) | 항목은 URL userinfo 만 가린다(sanitize_remote) | 그 뒤에 PEM 본문, Authorization·Cookie·Set-Cookie·X-Api-Key 헤더 값, Bearer 토큰, 비밀 이름(token·secret·password 등으로 끝나는 키)의 JSON 값·`이름=값`·`이름: 값` 을 `***` 로 가린다. 비밀이 없는 입력의 번들은 Go 와 바이트 단위로 같다 | 6.1.3 |
| DIFF-23 | 보안 강화 | git API file-head (HEAD 사본 쓰기, `$TMPDIR/dongminal-git-head/`) | 공유 임시 디렉터리에서 경로를 따라 chmod·쓰기를 해, 다른 로컬 사용자가 미리 심은 디렉터리·심볼릭 링크로 남의 파일을 덮거나 권한을 바꿀 수 있다 | 최상위 디렉터리가 링크가 아니고 내 소유이며 group/other 쓰기가 없을 때만 쓰고, 끝 성분을 `O_NOFOLLOW` 로 열며, 읽기 전용 전환은 열린 핸들로 한다. 정상 사용자에게는 경로·권한·응답이 Go 와 같다 | 5.4.3 |
| DIFF-24 | 알려진 차이 | httpapi `/api/fs/download-dir`·`download-many` (zip 본문) | compress/flate 레벨 5 로 압축한다 | zip 컨테이너(헤더·데이터 기술자·중앙 디렉터리·extra·모드·플래그)는 Go 와 바이트까지 같고, deflate 압축 스트림 바이트만 다르다(flate2). 풀어 낸 파일·이름·mtime·권한은 같다 | 5.5.7.2 |
| DIFF-25 | 알려진 차이 | httpapi LSP WebSocket (서버→브라우저) | 언어 서버 출력을 텍스트 프레임에 바이트 그대로 싣는다(잘못된 UTF-8 이면 브라우저가 연결을 끊는다) | 잘못된 UTF-8 은 U+FFFD 로 바꿔 싣는다. 올바른 UTF-8 출력은 같다 | 5.5.9 |
| DIFF-26 | 결함 수정 | httpapi Run headless 멤버 등록(도구 허브 없음) | nil 역참조 패닉이 500 으로 끝난다 | 500 `헤드리스 도구 생성 실패: tool hub unavailable` 로 답한다. 또 workspace 표식의 2^53 넘는 정수를 잃지 않는다(Go 는 float64 로 잃는다 — workspace.json 에 그런 수는 없다) | 5.5.4 |

## 4. 검증

- **V-RSP-1 (단위·통합)** crate 마다 관측 동작을 검증하는 Rust 테스트를 둔다. Go 테스트 중 관측 동작을 검증하는 것은 같은 입력·기대값으로 옮긴다.
- **V-RSP-2 (차분 실행)** `rust/parity/` 의 차분 실행기는 같은 시나리오를 Go 바이너리와 Rust 바이너리에 각각 격리 실행으로 돌리고, FR-RSP-3 의 표면을 비교한다. 비교에서 빼는 값(시각, PID, 임시 경로, 무작위 ID)은 시나리오마다 정규화 규칙으로 명시한다.
- **V-RSP-3 (e2e)** `DM_E2E_PREBUILT_BIN=<Rust 바이너리> E2E_PORT_BASE=<60147 이상> npx playwright test` 가 Go 바이너리로 돌렸을 때와 같은 결과를 내야 한다. 이미 불안정한 것으로 알려진 검사(`parity-flaky.txt`)는 같은 기준으로 다룬다.
- **V-RSP-4 (상호 운용)** FR-RSP-20~23 을 격리 실행에서 검증한다.
- **V-RSP-5 (운영 보호)** 모든 이슈의 완료 조건에 "운영 인스턴스의 PID(서버·데몬)가 작업 전후로 같다" 를 넣는다. 조정자는 병합할 때마다 이것을 확인한다.

## 5. 이슈 트리의 뼈대

| ID | 내용 | 선행 |
|---|---|---|
| 0 | 기반: SRS, 워크스페이스 골격, 의존성 정책, 격리 실행 도구, 차분 실행기 | — |
| 1 | shared 기초: gocompat, 잎 패키지, dmenv·dmlog, platform, workspace 등 | 0 |
| 2 | shared 중간: agentadapter·runtime, toolhub·toolipc, edge 계열, sandbox | 1 |
| 3 | 데몬: chat·chatsock, ipc·swap, boot | 2 |
| 4 | webserver 도메인: git, worktree, run, claudeacct, ext·lsp, telegram 등 | 1·2 |
| 5 | webserver 표면: apierr, hub, toolclient, gitapi, httpapi | 3·4 |
| 6 | ctl·helper: cli, migrate·privhelper, runtimebin(dmctl) | 2·5 |
| 7 | 진입점과 빌드: cmd/dongminal, 웹 임베드, 빌드 스크립트 | 3·5·6 |
| 8 | 통합 검증: e2e, 상호 운용, 크로스 빌드, 보조 도구 | 7 |
| 9 | 기준선 이후 Go 변경 따라가기 | 수시 |
