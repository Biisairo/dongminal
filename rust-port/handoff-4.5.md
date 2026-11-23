# 인계: 4.5 Claude 계정 전환 포팅 착수

이 문서는 이전 세션(탭 "rp 2.1")이 2.1·4.4 를 끝내고 4.5 를 새 세션에 넘기며 쓴 착수 문서다. 이 문서의 「착수 블록」 이 지시 전부다.

## 착수 블록

- 이슈: 4.5 Claude 계정 전환. Go 패키지는 `internal/webserver/domain/claudeacct`(프로덕션 약 5200줄)이다.
- 이슈 파일(상태는 **여기서만** 고친다): `/Users/dykim/personal/dongminal-rust/int/rust-port/issues/4.5-Claude-계정-전환.md`
- worktree: `/Users/dykim/personal/dongminal-rust/2.1`. 브랜치 `rp/4.5` 는 `rp/4.4@f81bb5e6` 위에 있고, 이미 체크아웃되어 있다.
- 조정자 탭: `37787b76-bd93-43c8-871c-f8c89c66afec`. 알림은 `dmctl msg --to 37787b76-bd93-43c8-871c-f8c89c66afec "…"` 로 보낸다.
- 먼저 읽을 것: `/Users/dykim/personal/dongminal-rust/int/rust-port/AGENT_RULES.md`(전체), `/Users/dykim/personal/dongminal-rust/int/docs/internal/RUST_PORT_SRS.md`(필요한 절)
- 조정자 지시(2026-11-23 11:20):
  1. 시작하자마자 3000줄 기준(규칙 3-3)으로 하위 이슈(`4.5.1-…md` 등)로 나누고, 첫 하위 이슈부터 한다. 나눈 사실을 조정자에게 알린다.
  2. 실제 계정·네트워크에 접근하지 않는다. 자격증명 값을 로그·문서·대화에 남기지 않는다.
  3. 커밋은 `rp/4.5` 에 직접 한다(`port(4.5.x): …`, AI 서명 금지). main 병합과 push 는 금지다.
  4. 끝나면 이슈를 review 로 바꾸고 조정자에게 알린다.
  5. 맥락이 60% 를 넘으면 `/dongminal:migration` 으로 새 세션에 넘긴다.
- 첫 일: 이슈를 `status: in-progress`, `owner: <새 탭 uuid>` 로 바꾸고, `rust/scripts/prod-pids.sh` 출력을 진행 기록에 적는다. 그다음 Go 패키지 파일별 줄 수를 보고 나눈다.

## 끝난 것 (근거 커밋)

- 2.1(agentadapter·agentrec·handover·runtime): rp/2.1 의 74bbc347·64321dfb·960b6fe7·fc7bd6e9. done 이다.
- 2.1 후속: 79d170a5 port(1.3)는 statusline 에 Deserialize 를 더했고, 058d0fce port(1.4.2)는 copy_executable 의 `.old` 처리를 고쳤다.
- 4.4(dm-webserver-domain-run): rp/4.4 의 51e1bec3 이고 done 이다. 후속 f81bb5e6 은 저장 중 잠금을 풀고 세대로 맞춘다(NFR-RSP-3). 4.4 후속 해시는 조정자에게 알렸다.

## 운영 보호 (어기면 즉시 멈춘다)

- 시작과 끝에 `rust/scripts/prod-pids.sh` 를 실행한다. 지금 값은 `38173 start --foreground` / `58470 d --handover-fd` 이다. 둘이 다르면 멈추고 조정자에게 알린다.
- 바이너리·`go`·`cargo test` 실행은 모두 `rust/scripts/hermetic.sh` 를 앞에 붙인다. `~/.dongminal` 에 접근하지 않는다(읽기 포함). 운영 바이너리를 실행하지 않는다.
- `dmctl` 은 조정자와 메시지를 주고받을 때만 쓴다.

## 이전 세션이 값을 치르고 배운 것

- **Go 참조 프로그램으로 바이트 비교하는 방식이 가장 싸고 강하다.** 하나씩 옮기는 테스트보다 토큰이 적게 들고, 덮는 범위도 넓다.
  - 예: `rust/crates/webserver/domain/run/testdata/goref/main.go`, `rust/crates/shared/runtime/testdata/goref/main.go`. testdata 아래라 Go `./...` 에 들지 않는다.
  - Rust 시험(`tests/go_parity.rs`)이 `go build -o <tmp> ./rust/crates/<…>/testdata/goref` 로 빌드해 돌리고, 같은 시나리오의 Rust 출력과 줄 단위로 비교한다. `go` 가 없으면 건너뛴다.
  - 시계·id 생성기를 고정해 결정론적으로 만든다. 시계 호출 횟수에 기대는 출력은 피한다(고정 시각을 쓴다).
- gocompat JSON 규칙
  - 출력은 `json::marshal`·`marshal_indent`·`Encoder` 로만 쓴다. 맵과 `serde_json::Value` 객체는 키 정렬된다.
  - `#[serde(flatten)]` 은 키 정렬 때문에 Go 임베드 순서를 깬다. 임베드는 같은 순서의 중간 구조체로 직접 Serialize/Deserialize 를 짠다(4.4 의 `Member`·`MemberWire`, 2.1 의 agentrec `Usage`).
  - `skip_serializing_if = "is_empty"` 는 참조 필드(`&T`)에서 쓸 수 없다. 소유 필드로 복사한다.
  - 구조체에는 `#[serde(default, rename = "pkg.Type")]` 를 단다. 타입 오류 문구가 Go 와 같아진다(예: `json: cannot unmarshal string into Go struct field Usage.thinking of type bool`).
- Go `os.MkdirAll(0o755)` 는 std `create_dir_all`(0o777&umask)과 권한이 다르다. 2.1 의 `mkdir_all` 처럼 DirBuilder 0o755 로 직접 짠다. `os.Remove` 는 파일 → 빈 디렉터리 순으로 지운다.
- Go 오류 문구는 `dm_gocompat::oserr::{go_error_string, path_error}`, `%q` 는 `strconv::quote`, `%v` float 는 `fmt::v_float` 로 맞춘다.
- `gen` 은 Rust 2024 예약어다. 변수 이름으로 쓰지 않는다.
- zsh 에서 `${t:+--target $t}` 는 낱말로 쪼개지지 않는다. cross clippy 는 대상마다 명시해 돌린다.
- python heredoc(`'''…'''`) 안의 `\a` 같은 역슬래시는 파이썬이 해석해 버린다. Rust 원문을 python 으로 고칠 때 주의한다(2.1 에서 한 번 밟았다).
- `dm-shared-platform` 의 `ipc::tests::stream_errors_match_go` 는 전체 실행에서 가끔 실패하고 단독으로는 통과한다. 내 변경과 무관하며 조정자에게 보고했다.

## 게이트 (규칙 3-6)

- `cargo fmt --all --check`
- `cargo clippy -p <crate> --all-targets -- -D warnings` 를 호스트와 `--target x86_64-pc-windows-msvc`·`aarch64-unknown-linux-gnu`·`x86_64-unknown-linux-gnu` 에서 각각 돌린다.
- `rust/scripts/hermetic.sh cargo test -p <crate>`

## 진행 기록에 남길 것 (규칙 3-8)

- 만든 crate 와 공개 API 요약
- 옮긴 테스트 수
- Go 와 다르게 한 내부 결정
- 남은 위험
- 작업 전후 prod-pids 출력
