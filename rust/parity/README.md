# dm-parity — 차분 실행기

`dm-parity` 는 같은 시나리오를 Go 참조 바이너리와 Rust 바이너리에 각각 격리 실행으로 돌리고, 사용자가 보는 결과를 비교한다. 근거는 `docs/internal/RUST_PORT_SRS.md` 의 V-RSP-2 이고, 요구사항은 [SPEC.md](SPEC.md) 에 있다.

비교하는 표면은 다음과 같다.

- CLI 의 stdout·stderr·종료 코드
- HTTP 응답의 상태 줄, 의미 있는 헤더, 본문
- 실행이 끝난 뒤 DONGMINAL_HOME 아래 파일의 내용과 경로 목록

## 실행

```sh
rust/parity/run.sh                       # 등록된 시나리오 전부를 Go 대 Rust 로 비교
rust/parity/run.sh --only cli-help       # 시나리오 하나만
rust/parity/run.sh --list                # 시나리오 이름과 담당 이슈 목록
rust/parity/run.sh --keep --only X       # 쪽 뿌리를 지우지 않고 경로를 찍는다
rust/parity/run.sh --self-test           # Go 대 Go 로 실행기 자체를 검증 (cargo test)
```

`run.sh` 는 다음 순서로 동작한다.

1. Go 참조 바이너리를 `rust/target/go-ref/dongminal` 에 빌드한다. 저장소 루트에는 만들지 않는다 (C-RSP-1).
2. `cargo build -p dongminal -p dm-parity` 를 실행한다.
3. `rust/scripts/hermetic.sh` 아래에서 `dm-parity --go … --rust … --issues <이슈 폴더>` 를 실행한다. 이슈 폴더는 `DM_PARITY_ISSUES` 가 있으면 그것을 쓰고, 없으면 `<저장소>/rust-port/issues` 를 쓴다. 이슈 worktree 의 사본은 낡을 수 있으므로, 최신 상태로 판정하려면 `DM_PARITY_ISSUES=/Users/dykim/personal/dongminal-rust/int/rust-port/issues` 처럼 통합 worktree 의 폴더를 준다.

시나리오마다 결과를 하나 찍는다.

| 결과 | 뜻 |
|---|---|
| `ok` | 두 쪽이 같다 |
| `DIFF` | 다르다. 또는 시나리오 오류가 있다. 모든 차이를 찍는다 |
| `PEND` | 다르지만 담당 이슈가 아직 `done` 이 아니다. 실패로 세지 않는다. 첫 차이만 찍는다 |

마지막 줄은 `<N>개 중 같음 a, 다름 b, 보류 c` 다. 종료 코드는 다름이 없으면 `0`, 있으면 `1`, 사용법이나 설정이 잘못되었으면 `2` 다. 담당 이슈가 있는 시나리오를 돌리는데 이슈 폴더가 없으면 `2` 다.

보류 중인 시나리오의 차이를 전부 보려면, 그 담당 이슈를 `status: done` 으로 적은 임시 이슈 폴더를 `--issues` 로 준다.

차이는 다음 형식으로 보고한다.

```
DIFF  cli-unknown-action
  단계 0 [run dongminal bogus] exit: 1번째 줄이 다르다 (go 1B, rust 1B)
    go:   "2"
    rust: "0"
```

## 시나리오 쓰기

시나리오는 Rust 코드로 쓰고 `src/scenarios/` 의 표면별 파일(`cli.rs` `helper.rs` `http.rs` `home.rs`)에 더한다. 새 파일을 만들면 `src/scenarios/mod.rs` 의 `all()` 에 이어 붙인다. YAML 해석기는 의존성 허용 목록에 없으므로 쓰지 않는다.

모든 시나리오는 `.owner("<이슈 ID>")` 로 담당 이슈를 단다. 담당 이슈는 그 표면을 Rust 로 만드는 이슈다(`SURFACE.md` 의 "담당" 열). `tests/catalog.rs` 가 담당 이슈가 없거나 이슈 폴더에 없는 ID 를 단 시나리오를 실패로 만든다. 새 시나리오를 더하면 `run.sh --self-test` 로 Go 대 Go 가 같은지(결정론적인지) 확인하고, `SURFACE.md` 9절에 행을 더한다.

```rust
use crate::{Cli, Http, Rule, Scenario, Serve};

Scenario::new("dmctl-list")                                  // 이름은 --only 로 고를 때 쓴다
    .owner("6.3")                                              // 담당 이슈
    .write_home("settings.json", r#"{"theme":"dark"}"#)        // 준비: 홈에 파일을 둔다
    .serve(Serve::new(["start", "--foreground", "--port", "{port}"], "/api/ping"))
    .http(Http::get("/api/settings").header("Origin", "http://localhost:{port}"))
    .run_cli(Cli::new(["list-workspace"]).argv0("dmctl"))      // dmctl 은 serve 뒤에만 (C-PAR-7)
    .home_file("workspace.json")                               // 끝난 뒤 이 파일 내용을 비교
    .home_tree(["logs/"])                                      // 끝난 뒤 경로 목록을 비교 (logs/ 는 뺀다)
    .normalize(Rule::rfc3339())                                // 시각을 <TIME> 으로
```

### 단계

| 단계 | 하는 일 | 남기는 관측값 |
|---|---|---|
| `run(args)` / `run_cli(Cli)` | CLI 를 한 번 실행한다. `Cli` 로 `env`, `stdin`, `argv0`(multi-call 헬퍼 이름), `timeout`(기본 30초)을 정한다 | `stdout`, `stderr`, `exit` |
| `write_home(path, contents)` | 홈 아래에 파일을 만든다. 내용의 자리표시도 바뀐다 | 없음 (실패하면 `error`) |
| `serve(Serve)` | 서버를 백그라운드로 띄우고, 준비 경로가 HTTP 응답을 줄 때까지 기다린다(기본 90초). 시나리오마다 하나만 둔다 | `ready` (`ok` 또는 실패 이유) |
| `http(Http)` | 띄운 서버에 HTTP/1.1 요청을 보낸다. `header`, `body`, `compare_header`, `timeout` 을 정한다 | `status`, `header:<이름>`, `body` |

모든 단계가 끝나고 정리까지 마친 뒤 `home_file` 로 지정한 파일은 `file:<경로>` 로 남는다. 파일이 없으면 값은 `<absent>` 다. `home_tree` 를 켜면 경로 목록이 `home-tree` 로 남는다.

실행 중 오류는 관측값 `error` 로 남는다. 바이너리를 실행하지 못한 경우, 제한 시간을 넘긴 경우, 연결이 거절된 경우가 여기에 해당한다. 두 쪽이 같은 이유로 실패하면 차이가 아니다. 그래서 "두 쪽이 똑같이 실패해서 같다"는 결과가 나올 수 있다. 서버 시나리오를 새로 쓰면 Go 쪽이 실제로 떴는지 확인한다(`tests/go_self.rs` 의 `go_server_scenarios_really_serve` 가 모든 서버 시나리오에서 이를 확인한다).

### 자리표시

인자, 환경변수 값, 준비 경로, HTTP 경로·헤더 값, `write_home` 내용에서 다음 자리표시를 쪽마다의 실제 값으로 바꾼다.

| 자리표시 | 값 |
|---|---|
| `{home}` | 쪽의 DONGMINAL_HOME |
| `{root}` | 쪽 뿌리 (HOME 은 `{root}/home`) |
| `{port}` | 쪽에 배정된 포트 (60147 이상) |

### 격리

각 쪽은 새 쪽 뿌리에서 돈다. 자식 프로세스의 환경은 다음과 같이 정한다.

- `DONGMINAL_*` 와 `DM_E2E_*` 를 모두 지운다.
- `HOME` 은 `{root}/home`, `DONGMINAL_HOME` 은 `{root}/dmhome` 으로 둔다.
- `DONGMINAL_NO_UPDATE_CHECK=1` 을 둔다.
- 작업 디렉터리는 `{root}` 다.

포트는 `DM_PARITY_PORT_BASE`(기본 60400)부터 고른다. 누가 쥐고 있는 포트와 이 프로세스가 이미 내준 포트는 건너뛴다. Go `start` 는 포트를 쥔 프로세스를 종료하므로 이 검사가 필요하다. 시나리오 인자에 60147 미만의 `--port` 가 있으면 시나리오를 실행하지 않는다. `dm-parity` 를 여러 개 동시에 돌리면 `DM_PARITY_PORT_BASE` 를 서로 다르게 준다.

정리할 때 끄는 프로세스는 두 가지뿐이다. 하나는 `serve` 로 띄운 자식이다. 다른 하나는 쪽 홈의 `paned.pid` 가 가리키는 프로세스 중 실행 파일이 그 쪽 바이너리인 것이다. TERM 을 보내고 5초를 기다린 뒤에도 살아 있으면 KILL 을 보낸다. 운영 바이너리나 `.dongminal` 아래의 바이너리를 쪽 바이너리로 주면 실행을 거절한다.

쪽 뿌리는 `DM_HERMETIC_ROOT` 아래(없으면 임시 디렉터리)에 `pg1a2b3c` 처럼 짧은 이름으로 만든다. `{home}/paned.sock` 경로가 103바이트를 넘으면 데몬이 소켓을 바인드하지 못하므로, 이때는 실행 전에 오류를 낸다.

### 정규화

비교하기 전에 두 쪽의 관측값을 정규화한다.

기본 정규화는 언제나 적용된다. 쪽마다 바뀌는 값을 다음 토큰으로 바꾼다. 경로는 정규 경로(macOS `/private/var/…`)도 함께 바꾼다.

| 값 | 토큰 |
|---|---|
| 쪽 바이너리 경로 | `<BIN>` |
| DONGMINAL_HOME | `<HOME>` |
| HOME | `<USERHOME>` |
| 쪽 뿌리 | `<ROOT>` |
| 쪽 포트 (앞뒤가 숫자가 아닐 때) | `<PORT>` |

시나리오 규칙은 `normalize(Rule)` 로 더한다. 선언한 순서대로 적용된다.

| 규칙 | 바꾸는 것 |
|---|---|
| `Rule::rfc3339()` | RFC 3339 시각(나노초·시간대 포함) → `<TIME>` |
| `Rule::uuid()` | UUID → `<UUID>` |
| `Rule::pid_after("pid=")` | 접두어 바로 뒤의 10진수 → `<PID>` (접두어는 남는다) |
| `Rule::regex(pattern, rep)` | 정규식 치환 (`${1}` 같은 치환 문법) |
| `Rule::literal(from, to)` | 문자열 치환 |

`.only(["stderr", "file:server.json"])` 를 붙이면 그 이름의 관측값에만 규칙을 적용한다.

정규화는 필요한 만큼만 쓴다. 정규화가 넓으면 진짜 차이를 가린다. 시각, PID, 무작위 ID 처럼 실행할 때마다 바뀌는 값만 바꾼다. 같은 입력에서 같아야 하는 값(문구, 정렬, JSON 필드 순서)은 그대로 둔다.

### HTTP 비교 규칙

- 요청은 `127.0.0.1:{port}` 로 보내고 `Host: 127.0.0.1:<포트>` 와 `Connection: close` 를 붙인다. 본문이 있거나 메서드가 POST·PUT·PATCH 면 `Content-Length` 를 붙인다.
- `status` 는 상태 줄에서 HTTP 판을 뺀 나머지다(예: `200 OK`).
- 비교하는 헤더는 `Content-Type`, `Cache-Control`, `Location`, `Set-Cookie`, `Vary`, `WWW-Authenticate`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, `Access-Control-*`, `Cross-Origin-*` 와 `compare_header` 로 더한 이름이다. 이름은 대소문자를 가리지 않는다. 같은 이름이 여럿이면 받은 순서대로 줄바꿈으로 이어 비교한다.
- `Date` 는 있는지만 비교한다(`<present>`).
- `Content-Length` 와 `Transfer-Encoding` 은 비교하지 않는다. 본문은 chunked 를 푼 뒤에 비교한다.

### 시나리오에 넣으면 안 되는 것

- `start`·`stop`·`service`·`uninstall`·`update --check`·`rollback`·`restore`·`migrate` 의 실제 실행 경로. 도움말과 파서가 실행 전에 거절하는 인자 오류만 넣는다. `stop` 은 포트를 쥔 프로세스를 끄고, `service`·`uninstall` 은 OS 서비스에 닿는다.
- `otp status`·`install`·`uninstall`·`run`. 특권 도우미에 닿는다.
- argv0 `claude`·`dongminald`. 실행기가 거절한다.
- 격리 서버(`serve`) 없이 `dmctl`·`edit`·`detach`·`open-url` 를 부르는 단계. 실행기가 거절한다.
- 60147 미만의 숫자 `--port`. 실행기가 거절한다. 포트는 `{port}` 로 쓴다.

자세한 근거는 `SURFACE.md` 9.2절에 있다.

## 지원하지 않는 것

- WebSocket, SSE, IPC 소켓 비교. 그 표면을 포팅하는 이슈가 단계 종류를 더한다(`scenario.rs` 의 `Step` 과 `runner.rs` 의 `SideCtx`).
- 서버 로그 비교. `serve` 자식의 stdout·stderr 는 쪽 뿌리의 `.parity-<n>.stdout|stderr` 에 남는다. `--keep` 으로 실행하면 볼 수 있다.
- Windows 에서 서버 정리. 데몬 pid 의 실행 파일을 확인하지 못하므로 데몬을 끄지 않는다. CLI 시나리오는 돈다.

## e2e 에서 Rust 바이너리 쓰기 (FR-RSP-31)

`e2e/global-setup.ts` 는 `DM_E2E_PREBUILT_BIN` 이 있으면 `go build` 대신 그 파일을 `E2E_BIN` 으로 복사하고 0755 권한을 준다. e2e 는 이슈 8.1 만 실행한다.

```sh
DM_E2E_PREBUILT_BIN=$PWD/rust/target/release/dongminal E2E_PORT_BASE=60147 npx playwright test
```
