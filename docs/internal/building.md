# 고치는 사람을 위한 안내 — 빌드·검사·배포

받아서 쓰는 사람에게는 필요 없다. 자기 OS 바이너리 하나면 끝이고, 그 길은
[README](../../README.md) 와 [getting-started](../external/getting-started.md) 에 있다.

이 문서는 **README 가 사용자 문서가 되면서 옮겨 온 것**이다
(README_REWRITE_SRS FR-RDM-9). 2026-11-24 에 Rust 판(`rust/Cargo.toml`·`rust/rust-toolchain.toml`·`Makefile`·`playwright.config.ts`)에 맞췄다 (GO_REMOVAL_SRS G-57).

---

## 지원 플랫폼

macOS · Linux · **WSL** · **Windows 10 1809+** (native).

OS 마다 달라지는 것은 전부 `rust/crates/shared/platform`(`dm-shared-platform`) 뒤에 있다 — PTY,
프로세스 제어·그룹, 프로세스 조회, 셸 선택과 훅, 로컬 IPC 종단, 경로 규약,
브라우저 실행. **그 패키지 밖에는 OS 분기가 한 줄도 없다.** 그 규칙을 강제하는
것이 `scripts/check-seams.sh` 다.

Windows 최소 버전이 1809 인 이유는 ConPTY(`CreatePseudoConsole`)다 — Windows 에서
PTY 의미론을 얻는 유일한 공식 경로이며 그 버전에서 도입됐다.

### 소스에서 빌드

받아서 쓰는 사람에게는 필요 없다 — [README](../../README.md) 의 설치면 끝이다. 이 절은 고치는
사람을 위한 것이다. [rustup](https://rustup.rs) 이 있으면 된다. 툴체인 판은
`rust/rust-toolchain.toml` 한 자리가 정하고(지금 1.95.0), `rust/` 안에서 cargo 를 부르면
rustup 이 그 판을 알아서 받는다. `scripts/build.sh` 는 그 안에서 cargo 를 부른다.

```bash
scripts/build.sh                        # 호스트용 하나 → ./dongminal
scripts/build.sh --os windows           # 윈도우용 → dist/dongminal-windows-amd64.exe
scripts/build.sh --os linux --arch arm64
scripts/build.sh --all                  # 배포 대상 5종 → dist/
VERSION=v1.0.3 scripts/build.sh --all   # 판을 새겨서 (릴리스가 쓰는 형태)
```

`VERSION` 을 주지 않으면 `dongminal version` 이 `dev` 를 낸다. 소스 빌드와 릴리스
산출물을 구별하기 위해서다. 산출물의 이름과 위치는 Go 판과 같다.

대상은 darwin/arm64 · darwin/amd64 · linux/amd64 · linux/arm64 · windows/amd64 다.
WSL 은 별도 대상이 아니다 — `linux/amd64` 를 그대로 쓴다.

**대상마다 툴체인이 필요하다.** Go 판은 툴체인 없이 어디서나 다섯 대상을 만들었지만,
Rust 는 대상마다 `rustup target add <triple>` 과 그 대상의 링커가 있어야 한다
(GO_REMOVAL_SRS DIFF-GRM-4). 없으면 `build.sh` 가 cargo 의 오류를 그대로 내고 실패한다.

| 대상 | triple | 필요한 것 |
|---|---|---|
| darwin/arm64 · darwin/amd64 | `aarch64-apple-darwin` · `x86_64-apple-darwin` | macOS 와 Xcode 명령줄 도구 |
| linux/amd64 · linux/arm64 | `x86_64-unknown-linux-musl` · `aarch64-unknown-linux-musl` | musl 교차 링커(`musl-gcc` 또는 `CC_<triple>`) |
| windows/amd64 | `x86_64-pc-windows-msvc` | Windows 와 MSVC 빌드 도구 |

linux 산출물은 musl 정적 바이너리다 — Go 판의 `CGO_ENABLED=0` 처럼 런타임 의존이 없다.
CI 는 대상 OS 의 러너에서 그 OS 의 산출물을 만든다 (Q-GRM-2).

macOS 의 CPU·메모리 지표는 `sysstat` 의 OS 모듈이 mach 호출로 읽는다. 대상이 macOS 면
늘 들어가므로, Go 판의 cgo 처럼 교차 빌드에서 지표가 빠지는 일은 없다.

### 검사

커밋 전에는 `make` 대상을 쓴다. `make help` 가 목록을 보인다.

```bash
make gates      # 커밋 전 게이트 — cargo fmt · cargo clippy · cargo build · 이음매 · 타이머 · git 쓰기 · 크로스 컴파일 · vendor 판 · CSS·JS 규약 게이트들
make lint       # cargo deny + cargo audit + eslint (도구가 없으면 건너뛰고 알린다 — CI 는 돌린다)
make typecheck  # e2e 타입 검사 + `// @ts-check` 를 단 프론트 파일
make unit       # 프론트 순수 모듈 단위 시험 (node:test, web/js/test·scripts/test)
make test       # Rust 단위 시험 (격리 실행으로 cargo test --workspace)
make all        # 위 전부
make hooks      # pre-commit 훅을 켠다
```

아래는 게이트가 부르는 스크립트 중 따로 쓸 일이 많은 것이다.

```bash
scripts/check-cross.sh     # 5개 대상 cargo check + clippy (테스트 코드까지 타입 검사)
scripts/check-seams.sh     # OS 의존 호출이 platform 밖에 없는지
scripts/verify-isolated.sh # 격리 인스턴스를 띄워 종단간 검사 (dongminal verify)
```

종단간 검사의 정의는 **한 벌**이다 (`rust/crates/ctl/cli/src/verify.rs`). 세 OS 가 같은
목록을 돌고, CI 의 Linux·Windows 도 같은 것을 부른다 — 검사를 셸 스크립트로 두 벌
적던 것을 접었다. 설계는
[docs/internal/E2E_UNIFICATION_SRS.md](./E2E_UNIFICATION_SRS.md).

### 배포

태그 `v*` 를 밀면 `.github/workflows/release.yml` 이 세 OS 에서 게이트(단위 테스트 ·
`doctor` · `verify`)를 돌리고, 다섯 대상을 빌드해 GitHub Releases 에 첨부한다.
바이너리는 저장소에 커밋하지 않는다 — 이유와 설계는
[docs/internal/RELEASE_SRS.md](./RELEASE_SRS.md).

설계와 이음매 목록은 [docs/internal/CROSS_PLATFORM_SRS.md](./CROSS_PLATFORM_SRS.md).

세 OS 모두 **실기에서 검증된다.** CI(`.github/workflows/verify.yml`)가 매 푸시마다
Linux·Windows 에서 단위 테스트 · `doctor` · `verify` 를 돌리고, macOS 는 개발자가
로컬에서 같은 것을 돈다. WinAPI 호출(ConPTY·Job Object·toolhelp)도 실제 Windows
러너에서 실행된다.

## 테스트

Rust 시험은 툴체인 말고 의존이 없다:

```bash
make test                # = cd rust && scripts/hermetic.sh cargo test --workspace
scripts/check-cross.sh   # 5개 대상 cargo check + clippy — 테스트 코드까지 타입 검사된다
```

`make test` 는 격리 실행(`rust/scripts/hermetic.sh`)으로 돈다 — 도구 셸에서 물려받은
`DONGMINAL_*` 가 운영 인스턴스를 겨누지 않게 한다. Go 판의 `-race -shuffle=on` 에
해당하는 것은 없다(GO_REMOVAL_SRS DIFF-GRM-5).

e2e(Playwright)는 npm 이 필요하다. **빌드에는 필요 없다** — 프론트엔드는 번들러가
없고 `web/vendor/xterm.js` 가 저장소에 있어 `scripts/build.sh`(cargo build) 하나로 끝난다:

```bash
npm ci                    # Playwright 설치 (e2e 전용)
npx playwright install     # 브라우저 바이너리
make e2e                   # 전량 — CI 와 같은 8샤드를 병렬로 (기본으로 이것을 쓴다, CONTRIBUTING §4)
make e2e-all               # 전량을 한 프로세스로 — 누적 상태까지 겪는 무거운 쪽
npx playwright test        # 위와 같은 한 프로세스 전량 (2026-11-22 기준 2313건, 이 기계에서 약 28분)
npx playwright test e2e/git-panel.spec.ts   # 스펙 하나
```

e2e 는 `globalSetup`(`e2e/global-setup.ts`)이 서버 바이너리를 한 번 빌드하고(`build.sh` 와 같은
cargo 산출물을 나눠 쓴다. `DM_E2E_PREBUILT_BIN` 이 있으면 그 파일을 쓴다), 워커마다
임시 홈과 포트(60147 부터, 워커 i 는 `60147+i`)로 서버를 띄운다 (`playwright.config.ts`,
`E2E_PARALLEL_SRS`). 포트 기준은 `E2E_PORT_BASE` 로 바꾼다. 운영 인스턴스의 UI 포트(58146)와 노드 포트
기본값(58147)을 피한다. 워커의 `start` 는 그 포트를 쥔 프로세스를 종료하므로, 운영 포트와
겹치면 운영 서버가 내려간다.

수동으로 실동작을 확인할 때도 **운영 인스턴스를 건드리지 않는 경로**를 쓴다:

```bash
./dongminal start --isolated    # 임시 홈 + 빈 포트. 기존 서버를 죽이지 않는다
```

`dongminal stop` 은 홈이 아니라 **포트**로 대상을 찾는다. `--port` 없이 부르면
기본 포트(58146)의 인스턴스를 정지시키므로, 격리 인스턴스를 접을 때는 `start` 가
출력한 정지 명령(`--port`·`--home` 이 채워진 형태)을 그대로 쓴다.

종단간은 `dongminal verify` 다. 격리 인스턴스를 **스스로** 띄워 검사 목록 전량
(`rust/crates/ctl/cli/src/verify.rs` 의 `run_verify_checks`)을 훑고 치운다:

```bash
./dongminal verify           # 또는 scripts/verify-isolated.sh (빌드까지 함께)
```

검사 범위는 데몬 기동·`paned.sock`·`/api/ping`, 도구 생성(PTY+IPC 왕복)·조회·busy
RPC·출력 조회·**입력→출력 왕복**, 워크스페이스·설정·상태 조회, git 읽기 표면 8종과
없는 git 경로의 404, `index.html` 이 실제로 로드하는 `<script>` 전량 200, 구 평면
경로(`/js/app.js`) 404, 경계(상대경로 400 · 읽기 상한 초과 413 · 정적 응답의 보안 헤더)다.

`verify` 는 `--port`·`--home` 을 **받지 않는다.** 언제나 임시 홈과 빈 포트에서 돌고,
`stop` 대신 자기가 띄운 PID 와 격리 홈의 `paned.pid` 만 직접 끝낸다 — 운영
인스턴스를 건드릴 방법이 없다. 홈이 격리 홈이 아니거나 포트가 58146 이면 아무것도
띄우지 않고 중단한다.

git 검사 대상은 **실제 리포**여야 한다 — 비-git 디렉터리는 `ErrNotRepo` 로 정당하게
404 라서 라우팅 누락과 구별되지 않는다. 저장소가 아니면 그 항목들은 이유와 함께
건너뛴다.

## 기술 스택

- **백엔드**: Rust(`rust/rust-toolchain.toml` 의 판), tokio, hyper·axum, tokio-tungstenite, rust-embed. 허용 의존은 `rust/DEPENDENCIES.md`
- **프론트엔드**: 번들러 없음. xterm.js 5.5 (fit, search, web-links, unicode11, webgl addons), 편집기 CodeMirror 6 — 판과 해시는 [VENDOR_VERSIONS.md](./VENDOR_VERSIONS.md)
- **선택 의존성**: `claude` CLI (에이전트 오케스트레이션 시)

## TODO

- focused browser 자동 동기화 — **범위가 줄었다.** 창 포커스 소유권이 서버 권위로 옮겨져(FR-XDF-*) 기기 간에도 동기화되고, 이제 *마지막으로 포커스한* 브라우저의 창 크기가 적용된다 (예전엔 마지막으로 *새로고침한* 브라우저였다). 남은 결손: 소유자가 OS 포커스를 잃은 채 소유권을 유지하면 아무도 리사이즈를 보내지 않아 크기가 그 시점에 고정된다
- 주의 알림: 서버 호스트(브라우저 없는 원격 머신)용 OS 알림·웹훅 — 지금은 접속한 브라우저와 Telegram 브리지(`TELEGRAM_BRIDGE_SRS`, 휴대폰 알림)로만 전한다
- 데스크톱 래핑 (tauri, electron 등)
