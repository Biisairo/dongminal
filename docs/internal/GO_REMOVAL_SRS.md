# GO_REMOVAL_SRS — Go 제거와 Rust 빌드 전환
> **문서 상태**: 승인·구현중
> **남은 것**: R1~R10 구현, Q-GRM-13(CI 시험 수단)·Q-GRM-14(Windows 실기)는 사용자 결정 대기

- 문서 형식: ISO/IEC/IEEE 29148:2018 소프트웨어 요구사항 명세(SRS)
- 요구사항 접두어: `FR-GRM-n`(기능), `NFR-GRM-n`(비기능), `C-GRM-n`(제약), `V-GRM-n`(검증), 자리 목록은 `G-n`, 결정 후보는 `Q-GRM-n`
- 상위 문서: `docs/internal/RUST_PORT_SRS.md`(이하 RSP). 이 문서는 RSP 이슈 11 의 11.0(조사·스펙) 산출물이다
- 조사 기준: 브랜치 `rp/11`(분기점 `193864cb`), Go 기준선 커밋 `127ff7d9`

## 1. 소개

### 1.1 목적

`rust-port` 브랜치에서 Go 코드를 지우고, 빌드·시험·CI·릴리즈를 Rust 만으로 돌게 한다. 이때 사람과 다른 프로그램이 보는 것은 바뀌지 않아야 한다. 이 문서는 저장소에서 Go 에 기대는 자리를 빠짐없이 적고, 자리마다 Rust 대체와 "차이 없음" 수락 시험을 정한다.

### 1.2 범위

범위 안:

- 빌드 진입점(`scripts/build.sh`)과 그 산출물(이름·위치·각인·출력·종료 코드)
- `Makefile` 의 모든 목표와 `.githooks/pre-commit`
- `scripts/` 의 게이트·생성기·보조 스크립트 중 Go 소스·Go 도구·Go 바이너리에 기대는 것
- `.github/workflows/` 네 개(`verify`·`release`·`e2e`·`layout-baseline`)와 `.github/` 의 설정 파일
- e2e 가 바이너리를 얻는 방식(`e2e/global-setup.ts`)
- 저장소 설정 파일(`.golangci.yml`·`.editorconfig`·`.gitignore`·`dependabot.yml`)
- 사용자·기여자 문서의 빌드·설치·시험 안내
- `rust/` 안에서 Go 소스·Go 도구·Go 바이너리에 기대는 시험과 스크립트

범위 밖:

- 제품 동작 자체의 동등성. RSP 3.1 과 V-RSP-1~4 가 다룬다
- `docs/internal/*_SRS.md` 와 `docs/internal/archive/` 에 남은 Go 언급 중, 지난 결정의 기록인 것. 지금 따라야 할 안내가 아니면 고치지 않는다
- 운영 인스턴스를 Rust 판으로 바꾸는 일과 `main` 병합. 사용자가 정한다(RSP 문서 상태 "남은 것")

### 1.3 정의

| 용어 | 뜻 |
|---|---|
| Go 판 | 기준선 커밋 `127ff7d9` 의 저장소. `main` 브랜치에 남는다 |
| Rust 판 | 이 문서의 요구를 다 채운 뒤의 `rust-port` 브랜치 |
| 자리 | Go 에 기대는 파일 하나, 또는 파일 안의 한 덩어리(목표·단계·시험) |
| 관측 표면 | 명령 이름, 인자, stdout·stderr 바이트, 산출물 이름·위치·내용 형식, 종료 코드 |
| Go 참조 | `main` 에서 빌드한 Go 바이너리나 Go 소스. 대조 시험이 쓴다 |
| 격리 실행 | `rust/scripts/hermetic.sh` 를 앞에 붙인 실행(RSP C-RSP-1) |

### 1.4 참고 문서

- `docs/internal/RUST_PORT_SRS.md` — FR-RSP-10·11·12·31, DIFF-12·29·30·31, C-RSP-1
- `docs/internal/CI_GATES_SRS.md` — 게이트 목록과 원커맨드(`make gates`)
- `docs/internal/RELEASE_SRS.md` — 판 각인(FR-RVN-2/4), 산출물·서명
- `docs/internal/DAEMON_STALENESS_SRS.md` — 데몬 지문(FR-DFP-1·3·7·11)
- `docs/internal/building.md` — 빌드 안내
- `rust-port/AGENT_RULES.md` — 운영 보호, 커밋 규칙

## 2. 전체 설명

### 2.1 제품 관점

Go 판에서 빌드 과정은 이렇게 돈다.

1. `scripts/build.sh` 가 `go build` 로 `./dongminal`(호스트) 또는 `dist/dongminal-<goos>-<goarch>[.exe]`(배포 대상)를 만든다.
2. `make gates` 가 `gofmt`·`go vet`·`go build` 와 `scripts/check-*` 를 돌린다. 게이트 중 15개는 Go 소스를 훑고, 4개는 Go 프로그램(`go run ./scripts/...`)이다.
3. CI 의 `verify.yml` 이 같은 게이트에 `golangci-lint`·`govulncheck`·커버리지를 더하고, `release.yml` 이 다섯 대상을 빌드해 `SHA256SUMS` 에 서명한다.
4. e2e 의 `globalSetup` 이 `go build` 로 시험용 바이너리를 만든다.

Rust 판에서는 Rust 워크스페이스(`rust/`)가 이 모든 자리를 대신한다. 사람은 같은 명령을 치고 같은 결과를 받는다.

### 2.2 이미 된 것

- 제품 전체가 `rust/crates/` 에 포팅되어 있다. 바이너리 crate 는 `dongminal`(`rust/crates/cmd/dongminal`)이다.
- 웹 자산은 `dm-web-assets` 가 `rust_embed` 로 `web/` 를 싣는다. `web/embed.go` 를 읽지 않는다.
- 판·데몬 지문은 `DONGMINAL_BUILD_VERSION`·`DONGMINAL_BUILD_DAEMON` 을 `option_env!` 로 읽는다(FR-RSP-11). 기본값은 `dev`·빈 값으로 Go 와 같다.
- Go 프로그램 게이트 넷(`check-action-reasons`·`check-shared-constants`·`gen-decisions`·`gen-errors`)은 `rust/crates/scripts/` 에 Rust 판이 있다(DIFF-30).
- `rust/scripts/build.sh` 와 `rust/scripts/daemon-fingerprint.sh` 가 있다. 단 인자·산출물 이름·위치가 Go 판과 다르다(G-5·G-6).
- e2e 는 `DM_E2E_PREBUILT_BIN` 으로 미리 만든 바이너리를 쓸 수 있다(FR-RSP-31).

### 2.3 사용자 특성

| 사용자 | 보는 것 |
|---|---|
| 최종 사용자 | 릴리즈 산출물 이름, `SHA256SUMS`·서명, README 의 설치 명령, `dongminal version` 출력 |
| 기여자 | `scripts/build.sh`, `make` 목표, pre-commit 훅, 게이트 출력, CONTRIBUTING·building.md |
| CI | 워크플로 단계, 아티팩트 이름, 종료 코드 |
| 다른 프로그램 | 샌드박스 헬퍼가 내려받는 산출물 이름(`dongminal-linux-<arch>`), e2e 가 쓰는 환경변수 |

### 2.4 제약

- **C-GRM-1 (운영 보호)** RSP C-RSP-1 을 그대로 따른다. 수락 시험은 모두 격리 실행으로 돌린다. 호스트 빌드 시험은 `BINARY` 를 임시 경로로 바꾸거나 이슈 worktree 안에서만 돌린다. `/Users/dykim/personal/dongminal` 에서는 빌드하지 않는다.
- **C-GRM-2 (Go 참조 보존)** Go 코드는 `main` 에 남는다. Rust 판의 기본 빌드·시험·게이트는 Go 툴체인과 Go 소스 없이 돌아야 한다. Go 참조가 필요한 대조 시험은 선택 실행으로만 남긴다(Q-GRM-4).
- **C-GRM-3 (순서)** Go 소스는 맨 마지막 묶음(R10)에서 지운다. 그 전의 묶음은 Go 가 있는 상태에서도, 없는 상태에서도 통과해야 한다.
- **C-GRM-4 (외부 도구)** 새 cargo 도구(`cargo-llvm-cov`·`cargo-zigbuild`·`cargo-xwin` 등)를 CI 나 빌드에 들이는 것은 사용자 결정이다(Q-GRM-1·2·6). 회사 규정상 외부로 데이터를 내보내는 새 도구는 정보보호팀 승인이 필요하다.

### 2.5 가정

- **A-1 (중요)** Cargo 워크스페이스는 `rust/` 에 그대로 둔다(Q-GRM-5). 루트 스크립트가 `rust/` 로 들어가 cargo 를 부른다.
- **A-2** `scripts/` 의 셸·node 게이트는 같은 파일 이름·같은 출력 문구로 남는다. 안에서 훑는 대상만 바뀐다.
- **A-3 (중요)** 게이트 출력 문구 중 "Go" 를 말하는 부분(예: `activity-vocab ok (N개 — Go 와 JS 가 같다)`)은 사실이 아니게 되므로 바꾼다. 이 변경은 허용한 차이로 적는다(3.9).

## 3. 구체 요구사항

### 3.1 자리 목록

표의 "Go 판 관측" 은 사람이나 CI 가 보는 것이다. "Rust 대체" 는 고칠 방향이다. "수락" 은 3.8 의 시험 ID 다. 묶음은 3.10 의 ID 다.

#### 3.1.1 저장소 뿌리와 Go 소스

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-1 | `go.mod`·`go.sum` | 툴체인 판(`go 1.26.11`), 의존 5개(`creack/pty`·`gorilla/websocket`·`x/sys`·`x/text`·`fsnotify`) | 지운다. 툴체인 판의 자리는 `rust/rust-toolchain.toml`(Q-GRM-10), 의존 고정은 `rust/Cargo.lock` | V-GRM-20 | R10 |
| G-2 | `internal/**`(`.go` 1,473개 중 대부분, 제품 코드 약 10만 줄) | 없음(소스) | `git rm`. 안에 있는 시험 벡터 둘은 먼저 `rust/` 로 옮긴다(G-58·G-59) | V-GRM-20 | R10 |
| G-3 | `cmd/dongminal/` | 빌드 진입점 `./cmd/dongminal` | `rust/crates/cmd/dongminal`. `git rm` | V-GRM-20 | R10 |
| G-4 | `web/embed.go`·`web/embed_test.go`·`web/version_test.go` | 임베드 패턴, 아이콘·vendor·기반 클래스 임베드 시험, `index.html` 의 `?v=__ASSETV__` 시험 | 임베드와 앞의 세 시험은 `dm-web-assets` 에 있다. `?v=` 시험(TC-AVS-9)이 `dm-webserver-httpapi` 에 있는지 확인하고, 없으면 옮긴 뒤 `git rm` | V-GRM-21 | R2 |

#### 3.1.2 빌드 진입점

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-5 | `scripts/build.sh` | 인자 `--all`·`--os <darwin\|linux\|windows>`·`--arch <amd64\|arm64>`(기본 amd64)·`-h`. 환경 `BINARY`(기본 `dongminal`)·`DIST`(기본 `dist`)·`VERSION`. 호스트 빌드 → `./$BINARY`, 이어서 `"$bin" health --daemon`. `--os` → `$DIST/dongminal-<os>-<arch>[.exe]`. `--all` → `$DIST` 를 지우고 다섯 대상. 줄마다 `  ✓ <out>`, 끝에 `빌드 완료: <BINARY>`·`배포 빌드 완료: <DIST>/`. darwin 을 cgo 없이 빌드하면 `  ⚠ …` 두 줄. 잘못된 옵션은 stderr 에 사유와 도움말, 종료 1. `-trimpath -buildvcs=false` 재현 빌드 | 같은 인자·환경·출력·산출물 이름·위치로 다시 쓴다. 안에서 `rust/` 의 `cargo build --release --locked -p dongminal --target <triple>` 를 부르고 결과를 Go 판 이름으로 복사한다. 대상 매핑은 FR-GRM-2. 재현 빌드는 지금 `rust/scripts/build.sh` 의 `--remap-path-prefix`·`--cfg dongminal_trimpath`·`-Wl,-S` 를 옮긴다 | V-GRM-1~5 | R1 |
| G-6 | `rust/scripts/build.sh` | (Rust 판 임시 진입점) 출력 `rust/dist/dongminal-<triple>`, `--target` 만 받는다 | G-5 에 합치고 지운다. 이것을 가리키는 문서(`rust/parity/README.md`, 이슈 파일)는 `scripts/build.sh` 로 바꾼다 | V-GRM-1 | R1 |
| G-7 | `scripts/daemon-fingerprint.sh`(Go 판) | `go list -deps dongminal/internal/daemon/boot` 의 GoFiles·EmbedFiles 를 `sum` 으로 묶은 12자. `--os`·`--arch`·`--files`. 빈 목록이면 종료 1 | `rust/scripts/daemon-fingerprint.sh` 의 규칙(cargo metadata 로 `dm-daemon-boot` 의 도달 crate, sha256, 12자)을 `scripts/daemon-fingerprint.sh` 자리로 옮기고 `--os`·`--arch` 를 받게 한다(내부에서 triple 로 바꾼다). 지문 값의 모양이 다른 것은 DIFF-29 로 이미 허용했다 | V-GRM-6 | R1 |
| G-8 | `scripts/test/daemon-fingerprint.test.mjs` | `--files` 에 `internal/daemon/boot/boot.go` 등이 있고 `internal/webserver/`·`web/`·`cmd/` 가 없는지, darwin≠windows | 같은 뜻으로 Rust 경로를 단다: `crates/daemon/boot/`·`crates/daemon/ipc/`·`crates/shared/toolhub/` 가 있고 `crates/webserver/`·`crates/ctl/`·`crates/cmd/` 가 없는지 | V-GRM-6 | R1 |

#### 3.1.3 Makefile 과 훅

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-9 | `make gates` 머리 세 단계 | `── gofmt`(`gofmt -l .`, 위반이면 목록과 `gofmt -w 로 고치세요`, 종료 1) · `── go vet` · `── go build` | `── cargo fmt`(`cargo fmt --all --check`, 위반이면 `cargo fmt --all 로 고치세요`) · `── cargo clippy`(`--workspace --all-targets -- -D warnings`) · `── cargo build`(`--workspace`). 제목 줄의 낱말만 바뀌고 순서·종료 코드는 같다 | V-GRM-7 | R6 |
| G-10 | `make gates` 의 `scripts/check-*` 와 `node scripts/check-*` 58단계 | 단계마다 `── <제목>` 과 스크립트 출력, 끝에 `gates ok` | 단계 목록·순서·제목은 그대로다. Go 를 훑던 단계의 안쪽은 G-14~G-32 를 따른다. 제목 문구에 "Go" 가 든 단계(`활동 상태 어휘 (Go 와 JS 의 두 벌이 …)`, `패키지 표 (… go list 와 같은가)`)는 Rust 로 바꾼다 | V-GRM-7 | R6 |
| G-11 | `make test` | `go test -race -shuffle=on ./internal/... ./cmd/... ./web/...`, 도움말 `Go 단위 테스트 (…)` | `cargo test --workspace`(`rust/` 에서). 도움말은 `단위 테스트 (cargo test --workspace)`. 순서 섞기는 Rust 표준 하니스에 없다 — `-Z shuffle-tests` 는 nightly 다. 허용한 차이로 적는다 | V-GRM-8 | R6 |
| G-12 | `make lint` | `golangci-lint` 가 있으면 돌리고 없으면 `!! golangci-lint 가 없어 건너뜁니다 — CI 는 이것을 돌립니다.` + 설치 안내. 이어서 eslint | Go 쪽 자리는 `cargo clippy` 가 이미 `gates` 에 있으므로, `lint` 의 Go 칸은 `cargo deny check`·`cargo audit`(없으면 같은 형식으로 건너뛰고 알린다)로 바꾼다. eslint 부분은 그대로 | V-GRM-8 | R6 |
| G-13 | `make all`·`help`·`hooks`·`e2e`·`e2e-all`·`e2e-rebalance`·`e2e-plan`·`unit`·`typecheck` | 목표 이름과 도움말 | 이름·의존 순서(`all: gates lint typecheck unit test`) 그대로. Go 를 직접 부르지 않으므로 바뀌는 것은 도움말 문구(G-11)뿐이다. `e2e*` 는 G-51 로 바이너리가 바뀐다 | V-GRM-8 | R6 |
| G-14 | `.githooks/pre-commit` | `exec make gates` | 바꾸지 않는다. `make gates` 가 Rust 로 돌면 된다 | V-GRM-7 | R6 |

#### 3.1.4 Go 소스를 훑는 게이트

규칙: 뜻이 같은 규칙은 Rust 소스(`rust/crates/**/*.rs`)에 그대로 건다. 통과 줄·실패 머리 줄·종료 코드는 같게 두고, 규칙이 가리키는 이름만 Rust 이름으로 바꾼다. 읽은 항목이 0개면 실패하는 "빈 통과 막기" 를 모든 게이트에 둔다(Go 소스가 사라지면 조용히 통과하는 것을 막는다).

| ID | 게이트 | Go 판 규칙과 관측 | Rust 판 규칙 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-15 | `check-pkg-axis.sh` | 축 패키지(helper·daemon·webserver·ctl)는 자기 축과 shared 만 import. 예외 2개. `architecture.md` 패키지 표와 `go list ./...` 양방향 일치. `go list -m`·`-deps` 사용. 통과 `pkg-axis ok (축 위반 0 · 예외 N · 표 N개 일치)` | `cargo metadata` 의 경로 의존으로 같은 규칙: `rust/crates/<축>/` crate 는 같은 축과 `shared`·`gocompat` 만 의존. 예외는 Rust 이름으로 다시 적는다(`dm-ctl-cli → dm-webserver-domain-git-core`, `dm-ctl-errdoc → dm-webserver-apierr`). `scripts`·`web`·`cmd` 축의 규칙은 Q-GRM-8 에서 정한다. 표는 `architecture.md` 를 crate 표로 바꾸고(G-56) 워크스페이스 crate 와 양방향 비교 | V-GRM-9 | R3 |
| G-16 | `check-seams.sh` | OS 의존 호출(`runtime.GOOS`, `syscall.Kill`, `os.FindProcess`, `SysProcAttr`, unix 소켓, `/proc/`, `lsof·pgrep·ps`, `creack/pty`, `/bin/sh`)은 `internal/shared/platform` 에만. 예외 sysstat·testpath | 같은 뜻을 Rust 관용구로: `cfg!(target_os`·`#[cfg(unix\|windows\|target_os`, `libc::kill`, `std::os::unix`, `UnixListener`·`UnixStream`, `"/proc/`, `Command::new("lsof"\|"ps"\|"pgrep")`, `"paned.sock"`, `"/bin/sh"`. 지금 platform 밖에서 걸리는 자리(`webserver/fswatch`, `ctl/privhelper`, `webserver/domain/ext/install.rs`, `shared/edge*/tests/go_interop.rs`)를 예외로 올릴지 고칠지는 Q-GRM-8 | V-GRM-9 | R3 |
| G-17 | `check-cross.sh` | 다섯 GOOS/GOARCH 에서 `go build ./...`·`go vet ./...`, 대상마다 `%-16s ✅` 또는 `❌ build`·`❌ vet` | 같은 다섯 대상, 같은 표시 형식(대상 이름은 Go 이름 `darwin/arm64` 그대로 보인다)으로 `cargo clippy --workspace --all-targets --target <triple> -- -D warnings`. 이미 있는 `rust/scripts/cross-check.sh` 를 감싼다. ring 을 끄는 crate 의 교차 검사는 C 툴체인이 필요하다(AGENT_RULES 6) — Q-GRM-2 와 함께 정한다 | V-GRM-9 | R3 |
| G-18 | `check-logging.sh` | 표준 `log.Print*`·`Fatal*`·`Panic*` 은 dmlog 에만. 통과 `logging ok — 제품 코드에 표준 log 직접 호출 0곳` | `log::`·`tracing::` 매크로와 `eprintln!` 직접 호출은 `dm-shared-dmlog` 에만. CLI 의 사용자 출력(`println!`·`writeln!(stdout`)은 대상이 아니다. 예외 목록은 실측 뒤 적는다 | V-GRM-9 | R3 |
| G-19 | `check-http-error.sh` | `http.Error(` 는 `httpresp/fail.go` 에만, 한국어 본문 금지, `httpErr(` 한국어 본문 동결 9개, gitapi·httpapi 의 2xx 밖 `gitJSON`·`fsJSON` 금지 | `http_error(` 는 `dm-shared-httpresp` 에만, `http_err(` 한국어 본문 동결 수 유지(실측값이 9 가 아니면 플래그), `gitJSON`·`fsJSON` 의 Rust 대응 함수 이름으로 같은 검사 | V-GRM-9 | R3 |
| G-20 | `check-body-limit.sh` | `r.Body`·`req.Body` 는 httpreq 나 등록 예외 3곳에서만 | 본문 추출(`to_bytes(`·`into_body()`·`Bytes` 추출기·`Json<`)은 `dm-shared-httpreq` 와 같은 뜻의 예외 3곳(파일 업로드, LSP)에서만 | V-GRM-9 | R3 |
| G-21 | `check-gitwrite.sh` | `.gitResolveRepo(`·`.gitStatusBefore(`·`.gitApply(` 는 `gitwrite.go`(+읽기 한 곳)에만. `routes.go` 의 POST 핸들러는 `beginWrite`·`beginServiceWrite` 에 닿아야 한다(위임 한 단계, 예외 3개) | `git_resolve_repo(`·`git_status_before(`·`git_apply(` 는 `gitapi/src/write.rs` 에만. Rust `routes.rs` 의 POST 핸들러가 `begin_write`·`begin_service_write` 에 닿는지 같은 방식으로 본다. 예외 핸들러 이름은 Rust 이름으로 | V-GRM-9 | R4 |
| G-22 | `check-agent-names.sh` | 에이전트 id 리터럴은 `shared/agentadapter` 에만(주석·시험 제외). id 를 agentadapter 의 `ID: "x"` 에서 읽는다 | id 를 `rust/crates/shared/agentadapter/src/*.rs` 의 `id:` 필드에서 읽고, 나머지 `.rs` 의 실행 코드(시험·`#[cfg(test)]`·`tests/` 제외)를 훑는다 | V-GRM-9 | R4 |
| G-23 | `check-server-target.sh` | 주소 조립은 `dmenv/host.go` 에만. `ctl/cli/{health,window,stop,migrate}.go` 는 `ResolveTarget` 을 지난다 | `format!("http://{…}:{…}")`·`format!("{host}:{port}")` 꼴은 `dmenv/src/host.rs` 에만. `ctl/cli/src/{health,window,stop,migrate}.rs` 는 `resolve_target` 을 지난다. 파일이 없으면 실패 | V-GRM-9 | R4 |
| G-24 | `check-home-layout.sh` | 홈에 쓰는 첫 경로 조각 = `homelayout.go` 의 `homeLayout()` = `getting-started.md` 표. 15개 미만이면 실패 | 원천을 `ctl/cli/src/homelayout.rs` 로, 코드 쪽은 홈·data_dir 에 `.join(` 하는 첫 조각(상수 `const X: &str` 풀이 포함)으로 바꾼다. 문서 비교는 그대로 | V-GRM-9 | R4 |
| G-25 | `check-env-docs.sh` | 코드의 `"DONGMINAL_*"` 리터럴(+`PORT`, `BINARY`) = `getting-started.md` 표 첫 칸 | `.rs`(시험 제외)의 `"DONGMINAL_*"` 리터럴, `PORT` 는 Rust 상수 꼴로 찾는다. `BINARY` 는 `scripts/build.sh` 에서 그대로. 빌드 각인 변수 `DONGMINAL_BUILD_VERSION`·`DONGMINAL_BUILD_DAEMON` 은 런타임 변수가 아니므로 표에 넣을지 예외로 둘지 Q-GRM-11 | V-GRM-9 | R4 |
| G-26 | `check-activity-vocab.sh` | `internal/shared/activity/activity.go` 의 `const` 와 JS `ACTIVITY_STATE` 집합 비교. 통과 `activity-vocab ok (N개 — Go 와 JS 가 같다)` | 원천을 `rust/crates/shared/activity/src/lib.rs` 의 `pub const X: &str = "v";` 로. 출력의 "Go" 는 "Rust" 로(3.9 DIFF-GRM-2) | V-GRM-9 | R4 |
| G-27 | `check-commands-docs.sh` | `runtimebin/dmctl.go` 의 `dmctlCommands` 키 = `commands.md` 표 | 원천을 `rust/crates/helper/runtimebin/src/dmctl/mod.rs` 의 명령 표로. `"a" \| "b"` 꼴 분기를 풀어 읽는다. 읽은 명령이 0개면 실패 | V-GRM-9 | R4 |
| G-28 | `check-api-docs.sh` | `internal/webserver` 의 `httproute.Get(…)`·`UnderWith`·`Under`·`mux.HandleFunc` 경로 = `api.md` 표 | `rust/crates/webserver/{httpapi,gitapi,httproute}/src` 의 경로 등록(`get(`·`post(`·`put(`·`delete(`·`any(`·`under`·`under_with`)로. 꼴은 실측 뒤 정한다 | V-GRM-9 | R4 |
| G-29 | `check-code-refs.mjs` | `web/js`·`e2e`·`scripts`·`internal`·`cmd` 주석의 파일 참조가 `git ls-files` 에 있고 줄이 범위 안인가. `.go` 확장자 포함 | 훑는 자리에서 `internal`·`cmd` 를 빼고 `rust` 와 `rs` 를 더할지는 Q-GRM-9. 어느 쪽이든 Go 를 지우면 `.go` 를 가리키는 주석이 "없는 파일" 이 된다: `web/js`·`e2e`·`scripts` 의 68개 파일, `rust/` 의 `.rs` 274개 파일(훑게 하면). 고치는 방법도 Q-GRM-9 | V-GRM-10 | R10 |

#### 3.1.5 Go 프로그램 게이트와 생성기

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-30 | `check-action-reasons.sh` → `go run ./scripts/check-action-reasons` | `action-reasons ok (N actions)`, 실패는 stderr 머리 줄 + `  <loc>: why.<code>`, 종료 1 | `cargo run -q --locked -p dm-scripts-check-action-reasons`(`rust/` 에서). 문구는 이미 같다. `scripts/check-action-reasons/main.go` 는 R10 에서 지운다 | V-GRM-11 | R5 |
| G-31 | `check-shared-constants.sh` → `go run ./scripts/check-shared-constants`(go/ast 로 Go 상수를 읽음) | `shared-constants ok (K9·K10·K12·K13·K17·K-h)`, 실패 머리 줄 + `  <ID>: <사유>` | `cargo run -q --locked -p dm-scripts-check-shared-constants`. Rust 소스를 읽는다. 사유 문구가 Rust 이름인 것은 DIFF-30 으로 허용했다 | V-GRM-11 | R5 |
| G-32 | `check-decisions.sh` → `go run ./scripts/gen-decisions -check`. 생성물 `docs/internal/decisions.md` | `decisions ok (N건)`, 어긋나면 머리 줄 + 재생성 안내 두 줄, 종료 1 | `cargo run -q --locked -p dm-scripts-gen-decisions -- -check`. 생성물 머리의 `생성: \`go run ./scripts/gen-decisions\`` 는 `dm-ctl-decidx` 의 HEADER 를 실제 명령으로 바꾸고 `decisions.md` 를 다시 만든다. 머리 줄이 바뀌는 것은 DIFF-GRM-3 | V-GRM-11 | R5 |
| G-33 | `check-error-docs.sh` → `go run ./scripts/gen-errors -check`. 생성물 `docs/external/errors.md` | `error-docs ok (docs/external/errors.md)`, 어긋나면 `<out> 가 codes_doc.go 와 어긋납니다.` + 안내 | `cargo run -q --locked -p dm-scripts-gen-errors -- -check`. `dm-ctl-errdoc` HEADER 의 `원천: internal/webserver/apierr/codes_doc.go`·`생성: go run …` 을 Rust 원천·명령으로 바꾸고 `errors.md` 와 `rust/crates/ctl/errdoc/testdata/errors.md` 를 다시 만든다 | V-GRM-11 | R5 |

#### 3.1.6 바이너리를 만드는 보조 스크립트

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-34 | `scripts/verify-isolated.sh:22` | `go build -o $BIN ./cmd/dongminal` 뒤 `exec $BIN verify "$@"` | `BINARY=$BIN scripts/build.sh` 로 만든다(또는 `rust/` 에서 `cargo build` 뒤 복사). 나머지 그대로 | V-GRM-12 | R8 |
| G-35 | `scripts/perf-probe.sh:56` | `go build -o dongminal ./cmd/dongminal` 후 계측. diag 의 `goroutines`·`allocMB` 를 찍는다 | 빌드 줄을 `scripts/build.sh` 로. `goroutines`(tokio task 수)·`allocMB`(늘 0)는 DIFF-27 이 이미 다룬다. 예산 표에서 `allocMB` 줄을 빼거나 "측정 안 됨" 으로 찍는다 | V-GRM-12 | R8 |
| G-36 | `scripts/shots/shoot.sh` | `./dongminal`(build.sh 산출물)을 쓴다 | G-5 가 `./dongminal` 을 만들면 바꿀 것이 없다. 포트 58199 는 이 기계의 운영 범위 규칙(60147 이상)에 걸리므로 이 이슈에서 실행하지 않는다 | V-GRM-1 | R8 |
| G-37 | `scripts/build-codemirror.mjs:9` 주석 | "`go build` 에 Node 가 필요 없는 성질" | 주석만 `cargo build` 로 | — | R9 |

#### 3.1.7 저장소 설정

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-38 | `.golangci.yml` | golangci-lint 설정 | 지운다. 같은 뜻(결함 탐지만 켬)은 `cargo clippy -D warnings` 와 워크스페이스 `[lints]` 가 맡는다 | V-GRM-20 | R10 |
| G-39 | `.editorconfig` `[*.go]` | 탭 들여쓰기 | `[*.go]` 절을 지운다 | — | R10 |
| G-40 | `.gitignore` | `/dongminal`, `*.test`·`*.out`·`coverage.txt`(Go 시험), `/dist/` | `/dongminal`·`/dist/` 는 남긴다. Go 시험 줄은 지운다. `rust/target`·`rust/dist` 는 `rust/.gitignore` 에 이미 있다 | — | R1 |
| G-41 | `.github/dependabot.yml` `gomod` | Go 모듈 갱신 PR | `cargo`(`directory: /rust`)로 바꾼다 | — | R7 |
| G-42 | `.github/PULL_REQUEST_TEMPLATE.md:11,18` | `go test ./...`, "`go.mod` · `package.json` 그대로" | `make test`(또는 `cargo test --workspace`), "`rust/Cargo.toml`·`Cargo.lock` · `package.json` 그대로" | — | R9 |

#### 3.1.8 CI 워크플로

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-43 | `verify.yml` job `test`(windows·ubuntu) | `setup-go`(go.mod), `go build ./...`, `go vet ./...`, `go test -race -shuffle=on ./...` | Rust 툴체인 설치(판은 `rust-toolchain.toml`), `cargo build --workspace`, `cargo clippy …`, `cargo test --workspace`. 러너·job 이름·matrix 는 그대로 | V-GRM-13 | R7 |
| G-44 | `verify.yml` job `gates` 의 Go 단계 | `setup-go`, `scripts/check-*`(G-15~G-33), `gofmt -l .`, `golangci-lint v2.13.2`, `govulncheck@v1.1.4 ./...`, `go test -coverprofile` + 아티팩트 `coverage`(14일) | Rust 툴체인, 같은 `scripts/check-*` 단계, `cargo fmt --all --check`, `cargo clippy`, `cargo deny check` + `cargo audit`(govulncheck 자리), 커버리지는 Q-GRM-6. 단계 이름 중 `gofmt`·`golangci-lint`·`govulncheck` 는 Rust 도구 이름으로 바꾼다. `check-old-editor-name.sh` 는 Go 와 무관하다 | V-GRM-13 | R7 |
| G-45 | `verify.yml` job `windows-runtime`·`linux-runtime` | `go build -o dongminal[.exe] ./cmd/dongminal`, 이어서 `doctor`·`verify` | `scripts/build.sh`(windows 러너는 bash 로)로 같은 이름을 만든다. 뒤 단계 그대로 | V-GRM-13 | R7 |
| G-46 | `release.yml` job `gate`(macOS·ubuntu·windows) | `go build`·`go vet`·`go test -race -shuffle=on ./...`, `go run ./cmd/dongminal doctor`, `go run ./cmd/dongminal verify` | `cargo build`·`cargo clippy`·`cargo test --workspace`, 빌드한 바이너리로 `doctor`·`verify`. `[skip tests]` 규칙 그대로 | V-GRM-14 | R7 |
| G-47 | `release.yml` job `build-darwin`(macOS) | `scripts/build.sh --os darwin --arch arm64`·`--arch amd64`, `build.log` 에 `⚠` 가 있으면 실패, 아티팩트 `dist-darwin` | 같은 명령. Rust 판에서는 darwin 지표가 빠지는 빌드가 없으므로 `⚠` 검사는 남겨 두되 걸릴 일이 없다. Rust 대상 둘을 설치해야 한다 | V-GRM-14 | R7 |
| G-48 | `release.yml` job `build-others`(ubuntu) | 한 러너에서 `--os linux --arch amd64`·`--os linux --arch arm64`·`--os windows --arch amd64`, 아티팩트 `dist-others` | Go 는 한 러너에서 셋을 교차 빌드한다. Rust 는 linux arm64 에 교차 링커, windows-msvc 에 MSVC 링커(또는 cargo-xwin)가 필요하다. 러너 배치와 도구는 Q-GRM-1·2. 아티팩트 이름 `dist-others` 와 파일 이름은 그대로 | V-GRM-14 | R7 |
| G-49 | `release.yml` job `publish` | 다섯 파일 `dongminal-darwin-arm64`·`dongminal-darwin-amd64`·`dongminal-linux-amd64`·`dongminal-linux-arm64`·`dongminal-windows-amd64.exe` 를 요구, `SHA256SUMS`, cosign keyless(`SHA256SUMS.sig`·`.pem`), `attest-build-provenance`, `gh release create … dist/*`(애셋 8개) | 바꾸지 않는다. 앞 job 이 같은 이름을 내면 된다 | V-GRM-14 | R7 |
| G-50 | `release.yml` 릴리스 노트·주석 | 노트 "Go 도 다른 의존도 필요 없습니다"(:267), 주석 "go:embed"(:5) | 노트는 "런타임 의존이 필요 없습니다" 로. 단 Linux 산출물이 glibc 동적 링크가 되면 이 문장이 거짓이 된다(Q-GRM-1) | V-GRM-14 | R7 |
| G-51 | `e2e.yml`(지금 `if: false`) | `setup-go`, `go install golang.org/x/tools/gopls@v0.20.0`(LSP e2e 용), 캐시 데우기 `go build ./cmd/dongminal`, 샤드 실행 | gopls 설치를 위한 `setup-go` 는 남긴다(제품의 LSP 기능 시험이 실제 gopls 를 쓴다 — 빌드 의존이 아니다). 캐시 데우기는 `scripts/build.sh` 로 만든 바이너리를 `DM_E2E_PREBUILT_BIN` 으로 넘기는 단계로 바꾼다 | V-GRM-15 | R7 |
| G-52 | `layout-baseline.yml` | `setup-go`, globalSetup 이 Go 빌드 | Rust 툴체인. globalSetup 이 G-53 으로 바뀌면 나머지 그대로 | V-GRM-15 | R7 |

#### 3.1.9 e2e

| ID | 자리 | Go 판 관측 | Rust 대체 | 수락 | 묶음 |
|---|---|---|---|---|---|
| G-53 | `e2e/global-setup.ts:67-77` `buildServer()` | `DM_E2E_PREBUILT_BIN` 이 있으면 복사, 없으면 `go build -o <E2E_BIN> ./cmd/dongminal` | 없을 때의 기본을 Rust 빌드로 바꾼다: `rust/` 에서 `cargo build --release --locked -p dongminal` 뒤 `rust/target/release/dongminal[.exe]` 를 `E2E_BIN` 으로 복사. 샤드 8개가 동시에 부르므로 cargo 의 빌드 잠금이 직렬화하는지, 또는 `make e2e` 가 한 번 빌드해 `DM_E2E_PREBUILT_BIN` 으로 넘길지 정한다(FR-GRM-8). `E2E_BIN` 이름(`dongminal-e2e[.exe]`)·환경변수는 그대로 | V-GRM-15 | R8 |

#### 3.1.10 문서

| ID | 자리 | Go 판 안내 | Rust 대체 | 묶음 |
|---|---|---|---|---|
| G-54 | `README.md:369-370, 387` | `make gates`·`make hooks`, Go 의존 라이선스(`gorilla/websocket`·`x/sys`) | 명령은 그대로. 라이선스 절은 Rust 의존의 라이선스 요약(`rust/deny.toml` 허용 목록)으로 바꾼다. 설치 URL(:21·36·46·51-52)은 그대로 | R9 |
| G-55 | `CONTRIBUTING.md:12, 96-97, 106, 154, 157-158` | `go build ./...`, `go run ./scripts/gen-errors`·`gen-decisions`, `go test ./...`, 태그 전 `make gates && go test ./... && make e2e` | `scripts/build.sh`, `cargo run -p dm-scripts-gen-errors --`·`gen-decisions`, `make test`, `make gates && make test && make e2e`. 릴리즈 점검표(다섯 대상·서명)는 그대로 | R9 |
| G-56 | `docs/internal/architecture.md:87, 96, 98, 159` 와 패키지 표 | `sysstat (cgo 격리)`, `go run ./scripts/gen-*`, Go 패키지 표(pkg-axis 가 읽음) | crate 표로 바꾼다(G-15 와 같은 묶음에서 형식을 정한다). 생성기 명령을 cargo 로 | R3·R9 |
| G-57 | `docs/internal/building.md:28-117` | Go 판(`go.mod`), 교차 컴파일·cgo, `scripts/build.sh` 예, make 목표의 Go 도구, `go build` 하나로 끝난다 | Rust 툴체인 판(`rust-toolchain.toml`), 대상별 툴체인 요구(Q-GRM-2), `scripts/build.sh` 예(이름·위치는 같다), make 목표의 cargo 도구 | R9 |
| G-72 | `docs/external/getting-started.md:11, 125-136, 179, 371` | "Go 툴체인 … Go 1.24+", `./scripts/build.sh` → `./dongminal`, "`go build` 를 손으로 부르지 마세요", `BINARY` | Rust 툴체인 요구로 바꾼다. 명령·산출물은 그대로. 환경변수 표는 G-25 와 함께 | R9 |
| G-73 | `docs/external/errors.md:2-3`, `docs/internal/decisions.md:3` 머리 | `원천: …codes_doc.go`, `생성: go run …` | G-32·G-33 의 재생성으로 바뀐다 | R5 |

#### 3.1.11 rust/ 안의 Go 의존

| ID | 자리 | 지금 동작 | Go 를 지운 뒤 | Rust 대체 | 묶음 |
|---|---|---|---|---|---|
| G-58 | `crates/shared/platform/src/paths/tests.rs:140` `include_str!("…/internal/shared/platform/testdata/file_uri_vectors.json")` | 통과 | **컴파일 실패** — crate 시험 전체가 멈춘다 | 파일을 `crates/shared/platform/testdata/` 로 옮기고 경로를 바꾼다 | R2 |
| G-59 | `crates/webserver/gitapi/src/tests/misc.rs:139-143` `fs::read(…/internal/webserver/gitapi/testdata/oid_digest_vectors.json)` | 통과 | 실행 중 패닉 | 같은 방식으로 `crates/webserver/gitapi/testdata/` 로 | R2 |
| G-60 | `crates/shared/apipath/src/lib.rs:165-181` `matches_go_baseline_constants` | Go `apipath.go` 를 읽어 비교 | `expect` 패닉 | 지운다. Rust `ALL` 이 원천이다. 기준선 대조는 이미 끝났다 | R2 |
| G-61 | 같은 파일 `:185-202` `paths_match_server_routes` | `internal/webserver/{httpapi,gitapi}/*.go` 의 `"/api/` 리터럴과 비교 | 패닉 | Rust 라우트 소스(`crates/webserver/{httpapi,gitapi}/src/**/*.rs`)를 훑게 바꾼다. 뜻이 같다 | R2 |
| G-62 | `crates/shared/runtime/src/tests.rs:64-87` | `internal/shared/runtime` 이 있으면 자산을 바이트 비교 | 조용히 건너뜀 | Go 갈래를 지운다 | R2 |
| G-63 | `crates/shared/runtime/tests/go_parity.rs`, `crates/webserver/domain/run/tests/go_parity.rs` | PATH 에 `go` 가 있으면 `testdata/goref` 를 빌드해 대조 | `go` 가 있으면 **실패**(`go build 실패`), 없으면 건너뜀 | Q-GRM-4 의 선택 실행 모드로 바꾼다: `DM_GO_REF_SRC`(main 의 worktree 경로)가 있을 때만 그 트리에서 빌드한다 | R2 |
| G-64 | `crates/shared/{edge,edgenode,edgerelay,edgemesh}/tests/go_interop.rs`, `crates/daemon/boot/tests/daemon.rs`, `crates/daemon/ipc/src/tests.rs:480-485`(`#[ignore]`), `parity/tests/go_self.rs` | `DM_PARITY_GO_BIN`·`DM_PARITY_GO_RELAY_BIN`·`DM_PARITY_GO_MESHPEER`·`DM_GO_DONGMINAL`·`DM_GO_TOOLCLIENT` 가 있을 때만 돈다 | 기본 실행은 그대로 초록. 주석의 `go build ./rust/crates/.../testdata/...` 는 더 이상 돌지 않는다 | 선택 실행으로 남긴다. `testdata/go*/main.go` 다섯 벌은 Q-GRM-4 에 따라 남기거나 지운다. 주석의 빌드법을 "main worktree 에서 빌드" 로 고친다 | R2 |
| G-65 | `rust/parity/run.sh:18` | 늘 `go build -o target/go-ref/dongminal ./cmd/dongminal` 후 비교 | 실패 | `--go-bin <경로>` 또는 `DM_GO_REF_SRC` 를 받는다. 없으면 "Go 참조가 없다" 와 종료 2. `parity/README.md`·`SPEC.md`(FR-PAR-41·50, V-PAR-3) 갱신 | R2 |
| G-66 | `rust/interop/run.sh`, `interop/README.md:17` | 미리 만든 `--go` 바이너리를 받는다 | 동작은 그대로 | README 의 빌드법만 main worktree 기준으로 | R2 |
| G-67 | `rust/scripts/gates.sh --go` | `make -C .. gates` | `make gates` 가 Rust 판이 되면 이름이 틀린다 | `--go` 를 지우고 `make gates` 를 기본 단계로 넣을지 Q-GRM-12 | R6 |
| G-68 | `rust/scripts/hermetic.sh:36-44` | `go` 가 있으면 GOPATH·GOMODCACHE·GOCACHE 를 실제 HOME 기준으로 내보낸다 | 해가 없다 | 지운다(선택 실행의 Go 참조 빌드가 필요하면 남긴다 — Q-GRM-4 와 같이 정한다) | R2 |
| G-69 | `crates/ctl/errdoc/src/lib.rs:9-11`, `crates/ctl/decidx/src/lib.rs:198-201`, `crates/ctl/decidx/src/tests.rs:120` 시험 이름 `render_matches_go_generated_index` | 생성물 머리에 Go 명령 | — | G-32·G-33 과 함께 | R5 |
| G-70 | `crates/ctl/cli/src/version.rs:16` `GO_RUNTIME = "go1.27.2"` | `dongminal version` 셋째 칸이 Go 판과 같다 | 그대로 돈다 | Q-GRM-3 | R10 |
| G-71 | 골든 파일(`crates/gocompat/testdata/go_*`, `crates/ctl/cli/testdata/go_cli_golden*.json`, `crates/webserver/httpapi/src/tests/go_golden*`, `crates/shared/edge/testdata/go-fingerprint.txt`, `crates/helper/runtimebin/testdata/*.golden`) | 커밋된 고정 파일. 시험 때 Go 가 필요 없다 | 그대로 | 남긴다. 다시 만드는 법은 Go 참조가 필요하므로 Q-GRM-4 의 선택 실행 문서에 적는다 | — |

### 3.2 빌드 진입점

- **FR-GRM-1** `scripts/build.sh` 의 인자·환경변수·도움말 구조·출력 줄·산출물 경로·종료 코드는 Go 판과 같아야 한다(G-5). 도움말의 "참고" 절에서 Go 툴체인을 설명하는 줄은 Rust 의 사실로 바꾼다(DIFF-GRM-1).
- **FR-GRM-2** 대상 이름은 Go 이름을 쓴다. 내부 매핑은 이렇다. Linux 의 `-gnu`·`-musl` 는 Q-GRM-1 로 정한다.

  | Go 대상(인자·파일 이름) | Rust triple |
  |---|---|
  | darwin/arm64 | aarch64-apple-darwin |
  | darwin/amd64 | x86_64-apple-darwin |
  | linux/amd64 | x86_64-unknown-linux-{musl 또는 gnu} |
  | linux/arm64 | aarch64-unknown-linux-{musl 또는 gnu} |
  | windows/amd64 | x86_64-pc-windows-msvc |

- **FR-GRM-3** 호스트 빌드는 `./$BINARY`(기본 `./dongminal`)를 만들고, 이어서 그 바이너리로 `health --daemon` 을 부른다. 실패해도 스크립트는 0 으로 끝난다(Go 판 `|| true`).
- **FR-GRM-4** `VERSION` 이 있으면 `DONGMINAL_BUILD_VERSION` 으로, 데몬 지문이 있으면 `DONGMINAL_BUILD_DAEMON` 으로 새긴다. 바깥 환경에 같은 이름의 변수가 있어도 쓰지 않는다. 지문을 계산하지 못하면 비워 둔다(FR-DFP-3).
- **FR-GRM-5** 재현 빌드: 같은 소스·같은 툴체인·다른 체크아웃 경로에서 같은 바이트의 산출물이 나와야 한다(Go 판 `-trimpath -buildvcs=false` 의 뜻, SEC-30).
- **FR-GRM-6** `--os` 에 지원하지 않는 대상을 주면 바이너리를 만들기 전에 `지원하지 않는 대상입니다: <os>/<arch>` 와 도움말을 stderr 에 내고 종료 1 이다.
- **FR-GRM-7** 대상 툴체인(`rustup target`, 교차 링커)이 없으면 cargo 의 오류를 그대로 내고 종료 코드는 0 이 아니어야 한다. Go 판에는 이 실패가 없었다(Go 는 툴체인 없이 교차 빌드한다). 허용한 차이로 적는다(DIFF-GRM-4).

### 3.3 시험과 게이트

- **FR-GRM-8** e2e `globalSetup` 은 `DM_E2E_PREBUILT_BIN` 이 없을 때 Rust 바이너리를 만든다. 동시 샤드가 같은 cargo 대상 디렉터리를 쓰면 cargo 의 잠금으로 직렬화된다. 이 직렬화가 샤드 시작을 늦추면 `make e2e` 가 한 번 빌드해 `DM_E2E_PREBUILT_BIN` 으로 넘긴다.
- **FR-GRM-9** 3.1.4 의 게이트는 읽은 원천 항목이 0개면 실패한다.
- **FR-GRM-10** `make gates`·`make test`·`make lint`·`make all` 은 Go 툴체인이 PATH 에 없어도 통과해야 한다.
- **FR-GRM-11** `cargo test --workspace` 는 저장소에 `internal/`·`cmd/`·`go.mod` 가 없고 PATH 에 `go` 가 있어도, 없어도 통과해야 한다.
- **FR-GRM-12** Go 참조 대조 시험(G-63·G-64·G-65)은 Go 참조 경로를 주지 않으면 건너뛰고, 건너뛴 사실을 한 줄로 찍는다.

### 3.4 CI 와 릴리즈

- **FR-GRM-13** `release.yml` 의 산출물은 지금과 같은 다섯 파일 이름, `SHA256SUMS`, `SHA256SUMS.sig`, `SHA256SUMS.pem` 여덟 개다. 서명·출처 증명 방식은 바꾸지 않는다.
- **FR-GRM-14** 샌드박스 헬퍼가 내려받는 `…/releases/download/<판>/dongminal-linux-<amd64|arm64>` 이름은 바뀌지 않는다(`rust/crates/shared/sandbox/src/helper.rs:79-81`).
- **FR-GRM-15** 워크플로의 job 이름·matrix·아티팩트 이름(`dist-darwin`·`dist-others`·`coverage`·`playwright-report-*`·`ui-layout-baseline-*`)은 바꾸지 않는다. 단계 이름 중 Go 도구 이름은 Rust 도구 이름으로 바꾼다.
- **FR-GRM-16** CI 의 Rust 툴체인 판은 저장소 한 자리(`rust/rust-toolchain.toml` 또는 `Cargo.toml` 의 `rust-version`)에서 온다. Go 판의 `go-version-file: go.mod` 와 같은 구조다.

### 3.5 Go 제거

- **FR-GRM-17** R10 에서 `git rm` 하는 대상: `go.mod`, `go.sum`, `internal/`, `cmd/`, `web/*.go`, `scripts/check-action-reasons/`, `scripts/check-shared-constants/`, `scripts/gen-decisions/`, `scripts/gen-errors/`, `.golangci.yml`. `rust/crates/**/testdata/go*/main.go` 는 Q-GRM-4 에 따른다.
- **FR-GRM-18** 지운 뒤 저장소 전체에 `go build`·`go run`·`go test`·`go vet`·`go list`·`gofmt`·`setup-go` 가 남는 자리는 G-51(gopls 설치)과 선택 실행 Go 참조 안내뿐이어야 한다.

### 3.6 비기능 요구

- **NFR-GRM-1 (빌드 시간)** 호스트 릴리스 빌드는 cargo 증분 캐시가 있을 때 1분 안에 끝나는 것을 목표로 한다. Go 판보다 느린 것은 허용하되 실측값을 `building.md` 에 적는다.
- **NFR-GRM-2 (재현성)** FR-GRM-5 를 CI 의 두 러너 경로에서 확인한다.
- **NFR-GRM-3 (운영 보호)** 모든 묶음은 작업 전후 `rust/scripts/prod-pids.sh` 출력이 같아야 끝난다.

### 3.7 인터페이스

- 사용자 인터페이스: `scripts/build.sh`, `make <목표>`, `scripts/check-*`.
- 소프트웨어 인터페이스: cargo, rustup, Rust 툴체인. Linux 정적 링크를 고르면 musl 대상과 교차 링커(Q-GRM-1·2).
- 통신 인터페이스: 없음(릴리즈 업로드는 기존 `gh` 그대로).

### 3.8 수락 시험

모든 시험은 격리 실행으로 돌린다. "Go 기준" 은 `main` 의 worktree 에서 같은 명령을 돌린 결과다(Go 툴체인이 있는 기계에서 한 번 떠 둔 기록이어도 된다).

| ID | 대상 | 방법 | 통과 조건 |
|---|---|---|---|
| V-GRM-1 | 호스트 빌드 | 임시 디렉터리 체크아웃에서 `scripts/build.sh` | `./dongminal` 이 생기고, 출력이 `  ✓ dongminal` · `빌드 완료: dongminal` · `health --daemon` 한 줄 순서이며 종료 0. `BINARY=dm` 이면 `./dm` |
| V-GRM-2 | 대상 하나 | `scripts/build.sh --os linux --arch arm64`, `--os windows`, `--os darwin --arch amd64` | 파일 `dist/dongminal-linux-arm64`, `dist/dongminal-windows-amd64.exe`, `dist/dongminal-darwin-amd64` 가 생기고 `file` 의 형식·아키텍처가 맞다. `--arch` 생략 시 amd64 |
| V-GRM-3 | 전부 | `scripts/build.sh --all`(툴체인이 갖춰진 러너) | `dist/` 가 비워진 뒤 다섯 파일만 남고, 마지막 줄이 `배포 빌드 완료: dist/`. `DIST=out` 이면 `out/` |
| V-GRM-4 | 오류 경로 | `--os`(값 없음), `--os freebsd`, `--bogus`, `-h` | Go 기준과 stderr·stdout 바이트, 종료 코드(1·1·1·0)가 같다. `-h` 의 "참고" 절만 DIFF-GRM-1 로 다르다 |
| V-GRM-5 | 판 각인·재현 | `VERSION=v9.9.9` 로 두 경로에서 빌드 | 두 산출물의 sha256 이 같고, `./dongminal version` 첫 칸이 `v9.9.9`. 각인 없이 빌드하면 `dev` |
| V-GRM-6 | 데몬 지문 | `scripts/daemon-fingerprint.sh`, `--files`, `--os windows`; `npm run unit` 의 daemon-fingerprint 시험 | 12자 16진수, 목록에 daemon 축만 있고 webserver·ctl·cmd 가 없음, darwin≠windows. 빌드한 바이너리의 `health --daemon` 이 그 지문을 말한다 |
| V-GRM-7 | `make gates` | PATH 에서 `go` 를 뺀 격리 실행 | 단계 제목 목록이 Go 기준과 같은 순서(G-9·G-10 의 이름 바꿈만 다름)이고 `gates ok`, 종료 0. 각 Rust 게이트에 위반 한 건을 심으면 그 게이트가 실패하고 종료 1 |
| V-GRM-8 | `make test`·`lint`·`all`·`help` | 같은 조건 | `test` 가 `cargo test --workspace` 를 돌려 통과, `lint` 가 도구가 없을 때 `!! … 건너뜁니다` 형식으로 알림, `help` 목록의 목표 이름 집합이 Go 기준과 같다 |
| V-GRM-9 | Go 소스 게이트 12개(G-15~G-28) | 게이트마다 ① 그대로 실행 ② 위반 한 건을 심음 ③ 원천을 비움 | ① 통과 줄 형식이 Go 기준과 같다(숫자는 다를 수 있다) ② 실패 머리 줄이 같고 종료 1 ③ 빈 통과가 아니라 종료 1 |
| V-GRM-10 | 주석의 파일 참조 | `node scripts/check-code-refs.mjs` 를 Go 삭제 뒤에 | `code-refs ok`. `.go` 를 가리키는 주석이 0곳이거나 Q-GRM-9 의 규칙으로 걸러진다 |
| V-GRM-11 | Go 프로그램 게이트 넷 | 그대로 실행, 생성물 한 줄을 바꾼 뒤 실행 | 통과 줄·실패 머리 줄·종료 코드가 Go 기준과 같다(안내 문구는 DIFF-30). 생성물 재생성 뒤 `git diff` 가 머리 줄 말고는 없다 |
| V-GRM-12 | `verify-isolated.sh`·`perf-probe.sh` | 격리 실행, `perf-probe --port 6xxxx` | Rust 바이너리로 `verify` 가 돌고 종료 코드가 그대로 전달된다. perf-probe 는 끝까지 돈다 |
| V-GRM-13 | `verify.yml` | 브랜치 push 대신 `act` 나 사용자가 고른 방법(push 금지 — Q-GRM-13) | job 넷(`test`·`gates`·`frontend`·`*-runtime`)이 초록, 아티팩트 이름이 같다 |
| V-GRM-14 | `release.yml` | 시험 태그를 쓸 수 없으면 `workflow_dispatch` 를 포크에서(Q-GRM-13) | 애셋 여덟 개의 이름이 Go 판 릴리즈 `v1.3.7` 의 애셋 목록과 같고, `sha256sum -c SHA256SUMS` 와 `cosign verify-blob` 이 통과한다. Linux 산출물이 Q-GRM-1 의 링크 방식을 따른다(`file`·`ldd`) |
| V-GRM-15 | e2e | `DM_E2E_PREBUILT_BIN` 없이 `E2E_PORT_BASE=6xxxx npx playwright test <한 파일>`(실제 전량은 RSP 규칙대로 이슈 8.1 담당이 돈다) | globalSetup 이 Rust 바이너리를 만들어 시험이 돈다 |
| V-GRM-20 | Go 제거 | R10 뒤 `git ls-files '*.go' go.mod go.sum` 와 FR-GRM-18 의 grep | `rust/crates/**/testdata/go*/main.go`(Q-GRM-4 에서 남기기로 했을 때) 밖에 없다 |
| V-GRM-21 | 웹 자산 시험 | `cargo test -p dm-web-assets -p dm-webserver-httpapi` | 아이콘·vendor·기반 클래스·`?v=__ASSETV__` 시험이 모두 Rust 에 있고 통과 |

### 3.9 허용한 차이

| ID | 자리 | Go 판 | Rust 판 | 이유 |
|---|---|---|---|---|
| DIFF-GRM-1 | `scripts/build.sh -h` 의 "참고" 절 | Go 교차 컴파일·cgo 설명 | Rust 툴체인·대상 설치 설명 | 거짓 안내를 남기지 않는다 |
| DIFF-GRM-2 | 게이트 출력·단계 제목의 "Go"·"go list"·"gofmt" | Go 를 말한다 | Rust·cargo 를 말한다 | 같은 이유 |
| DIFF-GRM-3 | `errors.md`·`decisions.md` 머리 줄 | `go run …`, `codes_doc.go` | `cargo run …`, Rust 원천 | DIFF-30 의 연장 |
| DIFF-GRM-4 | 교차 빌드 | 툴체인 없이 어디서나 다섯 대상 | 대상 툴체인·링커가 필요하다 | Rust 의 구조. Q-GRM-2 가 사람의 부담을 정한다 |
| DIFF-GRM-5 | `make test` | `-race -shuffle=on` | 순서 섞기·경합 탐지기 없음 | 안정 Rust 하니스에 없다. 데이터 경합은 타입 체계가 막는다 |
| DIFF-29(기존) | 데몬 지문 값 | `sum` 기반 | sha256 기반 | RSP 에서 이미 허용 |

### 3.10 하위 이슈 묶음 제안

`∥` 는 같은 단계 안에서 병렬로 돌 수 있다는 뜻이다. 묶음은 서로 다른 파일을 고치도록 나눴다.

| 단계 | 묶음 | 내용(자리 ID) | 병렬 | 선행 |
|---|---|---|---|---|
| 1 | R1 빌드 진입점 | G-5·G-6·G-7·G-8·G-40, FR-GRM-1~7 | ∥ R2·R3·R4·R5 | Q-GRM-1·2 |
| 1 | R2 rust 시험의 Go 독립 | G-4·G-58~G-66·G-68 | ∥ | Q-GRM-4 |
| 1 | R3 Go 소스 게이트 ① 구조 | G-15·G-16·G-17·G-18·G-19·G-20, G-56 의 표 형식 | ∥ | Q-GRM-8 |
| 1 | R4 Go 소스 게이트 ② 문서 대조 | G-21~G-28 | ∥ | Q-GRM-11 |
| 1 | R5 Go 프로그램 게이트 | G-30~G-33·G-73·G-69 | ∥ | — |
| 2 | R6 Makefile·훅·rust gates | G-9~G-14·G-67 | ∥ R8 | R1·R3·R4·R5 |
| 2 | R8 e2e·보조 스크립트 | G-34~G-36·G-53 | ∥ R6 | R1 |
| 3 | R7 CI 워크플로·dependabot | G-41·G-43~G-52, FR-GRM-13~16 | — | R1·R6·R8, Q-GRM-6·13 |
| 4 | R9 문서 | G-37·G-42·G-54~G-57·G-72 | — | R1~R8 |
| 5 | R10 Go 제거와 전량 확인 | G-1~G-3·G-29·G-38·G-39·G-70, FR-GRM-17·18, V-GRM-7·10·20, 이슈 8.1 담당의 e2e 전량 | — | 전부 |

R3·R4 는 게이트가 12개라 한 묶음이 크다. 사람이 부족하면 R3·R4 를 하나로 합쳐도 된다(파일이 겹치지 않는다).

## 4. 미해결 질문(결정 후보)

> 조정자 추가(2026-11-24): **G-74** 프런트 단위 시험(`npm run unit`, web/js/test)이 internal/ 의 시험 벡터 4개와 `internal/webserver/hub/commands.go` 의 cmdActions 표를 직접 읽는다(shared-vectors·cm-lsp·window-order·remote-actions). Rust 쪽 사본·Rust hub 소스를 읽게 바꾼다 — 11.2(R2) 가 맡는다. 출력·통과 수는 같아야 한다.

> 조정자 결정(2026-11-24): Q-GRM-1~12 는 모두 권장안대로 한다(musl 정적, 대상 OS 러너 원생 빌드, version 셋째 칸 유지, Go 참조 대조는 `DM_GO_REF_SRC` 선택 실행, `rust/` 유지, cargo-llvm-cov, clippy+deny+audit, 축 예외 표, "Go 기준선" 표기 인정, rust-toolchain.toml 고정, 빌드 각인 변수는 env-docs 예외, gates.sh `--go` 제거). Q-GRM-13·14 는 사용자 결정 대기 — 그동안 CI 는 로컬에서 같은 단계를 스크립트로 재현해 확인한다.

각 질문에 권장안을 적는다. 사용자나 조정자가 정한다.

| ID | 질문 | 권장안 | 이유 |
|---|---|---|---|
| Q-GRM-1 | Linux 산출물을 정적 링크(musl)로 할까, glibc 동적 링크(gnu)로 할까 | **musl 정적** | Go 판은 `CGO_ENABLED=0` 정적 바이너리다. gnu 로 바꾸면 오래된 glibc 나 Alpine 에서 돌지 않고, 릴리스 노트의 "의존이 필요 없습니다" 가 거짓이 된다. 샌드박스 헬퍼가 컨테이너 안에 넣는 바이너리도 같은 파일이다. 대가: musl 의 메모리 할당기가 느릴 수 있어 NFR-RSP-3 를 다시 재야 한다 |
| Q-GRM-2 | 교차 빌드 도구와 CI 러너 배치 | **CI 는 대상 OS 러너에서 원생 빌드**(darwin=macOS, linux 둘=ubuntu + musl 교차 링커 또는 `cargo-zigbuild`, windows=windows 러너). 로컬 `--os` 는 툴체인이 없으면 FR-GRM-7 로 실패 | 새 도구를 가장 적게 들인다. `build-others` job 은 둘로 나뉘지만 아티팩트 이름 `dist-others` 는 한 job 이 모아 올리면 유지된다 |
| Q-GRM-3 | `dongminal version` 셋째 칸 `go1.27.2` 를 남길까 | **남긴다**(지금 그대로) | 이 이슈의 기준이 "출력 같음" 이다. 바꾸려면 RELEASE_SRS 의 출력 형식 결정이 먼저다 |
| Q-GRM-4 | Go 참조 대조 시험(go_parity 둘, go_interop 다섯, parity/run.sh)을 어떻게 남길까 | **선택 실행으로 남긴다**: `DM_GO_REF_SRC=<main 의 worktree>` 가 있을 때만 그 트리에서 `go build` 한다. `testdata/go*/main.go` 다섯 벌은 남기되 import 경로가 main 트리에서 풀리게 한다 | 운영 전환 전까지 상호 운용(FR-RSP-20~23) 대조가 필요하다. 기본 시험은 Go 없이 초록이다 |
| Q-GRM-5 | Cargo 워크스페이스를 `rust/` 에 둘까 뿌리로 옮길까 | **`rust/` 유지** | 옮기면 수백 개 경로·문서·이슈가 바뀐다. 관측 표면(명령·산출물)에는 차이가 없다 |
| Q-GRM-6 | 커버리지 아티팩트 `coverage` 를 어떻게 할까 | **`cargo-llvm-cov` 로 같은 이름의 아티팩트**(lcov). 도구 도입이 안 되면 단계를 지우고 사유를 적는다 | Go 판도 실패시키지 않는 정보용 단계다 |
| Q-GRM-7 | `golangci-lint` 와 `govulncheck` 자리 | **`cargo clippy -D warnings` + `cargo deny check` + `cargo audit`** | 이미 NFR-RSP-1·4 가 요구하는 도구다 |
| Q-GRM-8 | pkg-axis·seams 의 Rust 축 규칙과 예외 | `gocompat`·`scripts`·`web`·`cmd` 의 위치를 정하고, platform 밖 OS 호출 자리(fswatch·privhelper·ext install·edge 시험)를 예외 표로 올린다. **예외 표 + 사유**를 권장 | 지금 Rust 코드를 고치면 R3 범위가 제품 코드로 번진다 |
| Q-GRM-9 | 주석이 가리키는 `.go` 파일(웹·e2e·스크립트 68개 파일, `.rs` 274개 파일) | **check-code-refs 에 "Go 기준선" 표기(예: `Go \`x.go\``)를 HISTORIC 낱말로 인정**하고, `rust/` 는 이번에 훑지 않는다 | 274개 파일을 고치는 것은 동작과 무관한 큰 변경이다. 기준선 참조는 `main` 에서 여전히 뜻이 있다 |
| Q-GRM-10 | Rust 툴체인 판을 고정할까 | **`rust/rust-toolchain.toml` 로 고정**한다(지금은 `rust-version = "1.95"` 하한만 있다) | Go 판의 `go.mod` 고정과 같은 재현성(FR-GRM-5, NFR-GRM-2) |
| Q-GRM-11 | `DONGMINAL_BUILD_VERSION`·`DONGMINAL_BUILD_DAEMON` 을 환경변수 문서 표에 넣을까 | **넣지 않고 env-docs 게이트의 예외로 둔다** | 런타임에 읽지 않는 빌드 각인용 변수다. Go 판의 `-ldflags -X` 와 같은 자리다 |
| Q-GRM-12 | `rust/scripts/gates.sh` 를 어떻게 할까 | **`--go` 를 지우고**, `make gates` 가 cargo 단계를 품으므로 `gates.sh` 는 `cargo deny`·`audit`·교차 clippy 전용으로 남긴다 | 두 원커맨드가 같은 일을 하면 한쪽만 고쳐진다 |
| Q-GRM-13 | CI 워크플로를 어디서 시험할까 | push 가 금지이므로 **사용자가 포크·임시 원격을 허락하거나, 병합 뒤 첫 실행을 시험으로 삼는다** | 이 기계에서 GitHub Actions 를 그대로 돌릴 수 없다(`act` 는 macOS 러너를 흉내 내지 못한다) |
| Q-GRM-14 | Windows 실기 | RSP 의 남은 것과 같은 결정이다. windows-msvc 산출물의 실행 확인 수단을 정해야 V-GRM-2·14 가 끝난다 | — |

## 5. 자리 수 요약

- 자리: G-1~G-73, **73곳**
- 그중 바꾸지 않는 자리: G-14(pre-commit), G-36(shots), G-49(publish), G-71(골든) — 4곳
- Go 를 쓰지 않는 게이트(timers·html·fetch·vendor·old-editor-name·srs-status·srs-progress·file-size·repaint 와 나머지 node 게이트)는 자리에 넣지 않았다
