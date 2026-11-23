# Rust 포팅 에이전트 공통 규칙

이 문서는 Rust 포팅 이슈를 맡은 모든 에이전트가 따른다. 요구사항의 근거는 `docs/internal/RUST_PORT_SRS.md` 다. 이 문서와 SRS 가 충돌하면 SRS 를 따르고, 충돌을 조정자에게 알린다.

## 1. 경로

| 이름 | 경로 |
|---|---|
| 통합 worktree (`rust-port` 브랜치) | `/Users/dykim/personal/dongminal-rust/int` |
| 이슈 폴더 (상태는 **여기서만** 고친다) | `/Users/dykim/personal/dongminal-rust/int/rust-port/issues/` |
| 내 worktree | `/Users/dykim/personal/dongminal-rust/<이슈 ID>` |
| 내 브랜치 | `rp/<이슈 ID>` |
| Go 기준선 (읽기 전용 참조) | 내 worktree 의 `internal/`, `cmd/` (커밋 `127ff7d9`) |
| Rust 워크스페이스 | 내 worktree 의 `rust/` |

내 worktree 에도 `rust-port/issues/` 사본이 있다. 사본은 고치지 않는다. 상태는 통합 worktree 의 원본 파일을 절대경로로 고친다.

## 2. 운영 보호 (C-RSP-1) — 어기면 즉시 멈춘다

1. 작업을 시작할 때와 끝낼 때 `rust/scripts/prod-pids.sh` 를 실행하고, 출력을 이슈의 진행 기록에 적는다. 두 출력이 다르면 작업을 멈추고 조정자에게 알린다.
2. Go·Rust 바이너리를 실행하는 명령은 **모두** `rust/scripts/hermetic.sh` 를 앞에 붙여 실행한다. `go test` 와 `cargo test` 도 마찬가지다. 예: `rust/scripts/hermetic.sh cargo test -p dm-shared-edge`.
3. 금지 목록:
   - `/Users/dykim/personal/dongminal/dongminal` 을 덮어쓰거나, 실행하거나, 메인 작업트리(`/Users/dykim/personal/dongminal`)에서 빌드하기
   - `~/.dongminal` 의 파일·소켓에 접근하기(읽기 포함)
   - 60147 미만의 포트 쓰기
   - `pkill`, `killall`, 이름으로 프로세스 찾아 죽이기. 내가 띄운 PID 만 끈다
   - 특권 헬퍼, launchd·systemd 서비스 설치·제거·호출. 예외: 격리 데몬이 스스로 보내는 읽기 전용 `info`(공개키 조회)는 허용한다. `sign`·`kill`·`kick` 은 금지다 (SRS C-RSP-1)
   - 이 탭에 원래 있던 `dmctl`(PATH 의 `~/.dongminal/bin/dmctl`)로 포팅 결과를 시험하기. `dmctl` 은 조정자와 메시지를 주고받을 때만 쓴다
4. e2e 는 이슈 8.1 만 돌린다. 다른 이슈에서 `npx playwright test` 를 돌리지 않는다.

## 3. 작업 절차

1. 내 이슈 파일을 읽고, 머리말을 `status: in-progress`, `owner: <내 탭 uuid>` 로 바꾼다. 내 uuid 는 `dmctl who-am-i` 로 얻는다.
2. 대상 Go 패키지를 읽는다. 심볼 탐색은 LSP → Serena → grep 순서로 한다. Go 테스트는 관측 동작의 명세로 읽는다.
3. 이슈가 크거나(대략 Go 프로덕션 코드 3000줄 초과) 독립된 덩어리로 나뉘면, 하위 이슈 파일(`<내 ID>.1-…md`)을 만들고 내 이슈를 `status: split` 으로 바꾼 뒤 조정자에게 알린다. 하위 이슈를 직접 진행할지는 조정자가 정한다.
4. 테스트를 먼저 쓴다. 관측 동작(공개 API 의 입출력, 와이어 바이트, 파일 내용, 오류 문구)을 검증하는 Go 테스트는 같은 입력·기대값으로 옮긴다. 내부 구현만 보는 Go 테스트는 옮기지 않아도 된다 (FR-RSP-2).
5. 구현한다. 관측 동작은 Go 와 바이트 단위로 같아야 한다 (FR-RSP-3). 내부 구조는 Rust 답게 써도 된다.
6. 게이트를 통과시킨다.
   - `cargo fmt --all --check`
   - `cargo clippy -p <내 crate들> --all-targets -- -D warnings`
   - `rust/scripts/hermetic.sh cargo test -p <내 crate들>`
   - OS 의존 코드가 있으면 `cargo clippy -p <crate> --target <t> -- -D warnings` 를 x86_64-pc-windows-msvc·x86_64-unknown-linux-gnu·aarch64-unknown-linux-gnu(c_char 가 u8 이다) 에서 돌린다. 단 ring(rustls·rcgen·reqwest)을 끌어오는 crate 는 이 Mac 에 대상별 C 툴체인이 없어 교차 검사를 할 수 없으므로 건너뛰고 진행 기록에 적는다(8.3 에서 한꺼번에 푼다) (대상이 설치되어 있지 않으면 `rustup target add` 로 설치한다)
7. 내 브랜치에 직접 커밋한다. 사용자가 이슈 브랜치(`rp/<ID>`) 커밋을 명시적으로 허락했다(2026-11-23). 허락하지 않은 것은 `main` 병합과 push 둘이다. 메시지 형식: `port(<이슈 ID>): <무엇을>`. AI 서명(`Co-Authored-By` 등)은 넣지 않는다. `main` 이나 `rust-port` 에는 직접 커밋·병합하지 않는다. push 하지 않는다.
8. 이슈 파일을 `status: review` 로 바꾸고, 진행 기록에 다음을 적는다: 만든 crate 와 공개 API 요약, 옮긴 테스트 수, Go 와 다르게 한 내부 결정, 남은 위험, 작업 전후 `prod-pids.sh` 출력.
9. 조정자에게 `dmctl msg --to <조정자 uuid> "<이슈 ID> review: <한 줄 요약>"` 으로 알린다.

## 4. 코드 규칙

- crate 이름·경로는 이미 만들어진 골격(`rust/crates/...`)을 쓴다. 다른 이슈의 crate 는 고치지 않는다. 고쳐야 하면 조정자에게 알린다.
- 내 crate 의 공개 API 는 다른 crate 가 쓰기 좋게 정한다. 진행 기록에 공개 API 를 요약해 다음 이슈가 참고하게 한다.
- 의존 crate 는 `rust/DEPENDENCIES.md` 의 허용 목록에서만 고른다. `{ workspace = true }` 로 참조한다.
- Go 의 JSON·시간·flag·`strconv.Quote`·`%v` 같은 출력 규칙은 `dm-gocompat` 을 쓴다. 기준선은 go1.27.2(JSONv2 기본)이므로 Go 소스·v1 문서를 보고 JSON 출력이나 JSON 오류 문구를 짐작하지 않는다. 필요한 기능이 아직 없으면 조정자에게 알린다. 내 crate 에 따로 구현하지 않는다.
- JSON 의 `time.Time` 필드는 `dm_gocompat::time::GoTime` 이나 `#[serde(with = "dm_gocompat::time::json_time")]`(포인터면 `Option` + `json_time_opt`)로 둔다. Go 는 `omitempty` 로 `time.Time` 을 빼지 않으므로 `skip_serializing_if` 를 달지 않는다. 시각 파싱은 `dm_gocompat::time::parse_rfc3339`(`_nano`)를 쓴다.
- JSON 은 `dm_gocompat::json` 으로만 다룬다. 출력은 `marshal`·`marshal_indent`·`Encoder`(serde_json::to_* 금지), 입력은 `unmarshal`·`Decoder`. 구조체에는 `#[serde(default)]` 를 단다(Go 는 없는 필드를 0 값으로 둔다). nil 이 될 수 있는 slice·map·포인터는 `Option` 으로 둔다. 타입 오류 문구를 Go 와 맞추려면 구조체에 `#[serde(rename = "pkg.Type")]` 를 단다. 알려진 차이(slice·map 원소 타입 이름, 타입 오류 때 부분 채움)가 관측 표면에 드러나는 자리를 만나면 조정자에게 알린다.
- `unsafe` 는 `dm-shared-platform`, PTY·fd 전달 코드, `dm-webserver-domain-sysstat` 의 OS 모듈, `dm-gocompat` 의 Windows `FormatMessageW` 호출에서만 쓰고, `// SAFETY:` 주석을 단다.
- 상수(타임아웃, 재시도 간격, 파일 이름, 경로)는 Go 의 값과 같게 하고, 상수로 이름을 붙인다.
- 패닉으로 흐름을 제어하지 않는다. `unwrap()`·`expect()` 는 테스트와, 불변 조건이 증명되는 곳에만 쓴다.
- 주석은 최소로 단다. Go 주석의 SRS 참조(FR-…)는 동작의 근거가 되므로, 관측 동작에 관한 것만 옮긴다.

## 5. 막혔을 때

다른 이슈의 API 가 필요한데 그 이슈가 아직 끝나지 않았거나, Go 동작이 모호하거나, 이 규칙으로 판단할 수 없으면 추측해서 구현하지 않는다. 이슈 상태를 `blocked` 로 바꾸고 이유를 적은 뒤 조정자에게 알린다.
