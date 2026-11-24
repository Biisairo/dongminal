# 인계: 4.1.1 git core 구현 (rp/4.1)

## 착수 블록 — 이번 세션의 지시 전부

너는 dongminal Go→Rust 포팅의 이슈 4.1 담당 에이전트다. 4.1 은 split 이고 너는 하위 이슈 **4.1.1 → 4.1.2 → 4.1.3** 을 차례로 맡는다. 지금은 **4.1.1(git core)** 구현 단계다.

- 조정자: 탭 uuid `37787b76-bd93-43c8-871c-f8c89c66afec`, 메시지 toolId `01a202e1-f073-7000-9f81-b2d3dcf5010d` (`dmctl msg --to 01a202e1-…`)
- worktree `/Users/dykim/personal/dongminal-rust/4.1`, 브랜치 `rp/4.1` 하나를 세 하위 이슈가 함께 쓴다. **커밋은 하위 이슈별로 나눈다.** 이슈 브랜치 커밋은 사용자가 허락했다. **main 병합·push 는 금지**
- 하위 이슈마다 끝나면 이슈 파일을 `status: review` 로 바꾸고 `dmctl msg --to 01a202e1-f073-7000-9f81-b2d3dcf5010d "4.1.1 review: <요약>"` 으로 알린다. 조정자가 그때마다 rust-port 에 병합한다
- 상태는 **통합 worktree 의 원본**에만 적는다: `/Users/dykim/personal/dongminal-rust/int/rust-port/issues/4.1.1-git-core.md` (지금 `in-progress`, owner `a3038c18…` — 너의 새 탭 uuid 로 바꿔라). 내 worktree 의 `rust-port/issues/` 사본은 고치지 않는다

## 먼저 읽을 것

1. `/Users/dykim/personal/dongminal-rust/int/rust-port/AGENT_RULES.md` 전부 (특히 2 운영 보호, 3 절차, 4 코드 규칙)
2. `/Users/dykim/personal/dongminal-rust/int/docs/internal/RUST_PORT_SRS.md` — 특히 FR-RSP-3(바이트 동등), FR-RSP-36(tokio + CancellationToken), C-RSP-4(unsafe)
3. 이슈 파일 `int/rust-port/issues/4.1.1-git-core.md`, `4.1.2-git-query.md`, `4.1.3-git-store.md`
4. Go 원본 `internal/webserver/domain/git/core/*.go` (프로덕션 약 2040줄, 시험 3128줄). 이 문서 아래 「Go core 요약」 이 길잡이다

## 어디까지 왔나

- `762cb797` — **dm-gocompat 에 `filepath.rs`·`path.rs` 추가**(조정자 승인 B안. 4.1.1 review 와 별도로 먼저 rust-port 에 병합된다). API: `dm_gocompat::filepath::{SEPARATOR, LIST_SEPARATOR, clean, join(&[S]), is_abs, volume_name, to_slash, from_slash, dir, base, ext, split, split_list, rel -> Result<String,String>, abs, eval_symlinks -> io::Result<String>, is_path_separator}`, 순수 규칙 `filepath::unix::*`·`filepath::windows::*`, `dm_gocompat::path::{clean, join, split, ext, base, dir, is_abs}`. go1.27.2 실측·Go 자체 windows 시험 표와 일치. **gocompat 의 다른 파일은 고치지 않는다**
- `132049b1` — rust-port 병합. **platform 의 Process/Group 실구현이 들어왔다**(3454a0e5). `dm_shared_platform::current().process.new_group(&mut std::process::Command) -> Box<dyn Group>`, `Group::{bind(&std::process::Child), terminate, kill, close}`, `Process::alive(pid)`. POSIX 는 setsid 새 세션, Windows 는 Job Object(자식이 중단 상태로 뜨고 bind 가 재개한다). 그래서 **시험 전용 임시 프로세스 그룹은 만들지 않는다** — 실제 platform 으로 실제 git·sh 시험을 돌린다
- core crate(`rust/crates/webserver/domain/git/core`)는 아직 **골격 그대로**다(Cargo.toml 에 dm-shared-platform 의존만). 코드 작성은 시작하지 않았다
- 시작 prod-pids: `38173 start --foreground` / `58470 d --handover-fd` (끝날 때 다시 찍어 같은지 본다)

## 남은 일 (순서)

1. 4.1.1 이슈 파일 owner 를 새 탭 uuid 로 바꾼다
2. core crate 구현 (아래 설계안). Cargo 의존: `dm-gocompat`, `dm-shared-platform`, `tokio`, `tokio-util`, `serde`(derive), `regex`, `rand`(epoch), `futures-util`(필요 시). 모두 `{ workspace = true }` 또는 path. dev: `tempfile`
3. Go 시험 옮기기 — 관측 동작 시험 전부. 실제 git 이 필요한 시험은 그대로 실제 git 으로(`rust/scripts/hermetic.sh cargo test` — hermetic 이 HOME 을 바꾸므로 git 의 전역 설정 영향은 작다. Go 시험처럼 `GIT_CONFIG_GLOBAL=/dev/null` 이 필요한 곳은 그렇게 한다)
4. 게이트: `cargo fmt --all --check`, `cargo clippy -p dm-webserver-domain-git-core --all-targets -- -D warnings`, `rust/scripts/hermetic.sh cargo test -p dm-webserver-domain-git-core`, windows·linux `cargo check`
5. 커밋 `port(4.1.1): …`, 이슈 진행 기록(공개 API·옮긴 시험 수·내부 결정·남은 위험·prod-pids 전후), review 알림
6. 이어서 4.1.2(query) → 4.1.3(store). 각자 owner·status 를 바꾸고 같은 절차

## 시험 보조

- `gittest`·`testpath` 는 1.5 소관(진행 중). 쓸 시점에 rust-port 에 없으면 **core 의 시험 안에 같은 동작의 보조를 임시로** 둔다(조정자 승인). gittest Go 원본: `internal/shared/gittest/gittest.go`(143줄: Path·Run·Init·Repo(커밋 하나)·Count). testpath.Abs 는 Windows 에서도 절대경로가 되는 경로 생성기
- 들어오면 그것으로 바꾼다

## 설계안 (이 세션이 정한 것 — 그대로 따르거나, 바꾸면 이유를 진행 기록에)

**Ctx** (Go context 대응, core 에 둔다. 4.2 jobs 도 쓴다)
```rust
#[derive(Clone, Default)] pub struct Ctx { token: CancellationToken, deadline: Option<std::time::Instant> }
// background(), from_token(t), token(), deadline(), with_timeout(d) -> 자식 토큰 + min(deadline, now+d),
// with_cancel(), cancel(), err() -> Option<CtxError>, async done()
pub enum CtxError { Canceled, DeadlineExceeded }  // Display "context canceled" / "context deadline exceeded"
```
err(): 마감이 지났으면 DeadlineExceeded, 아니면 토큰 취소면 Canceled (둘 다면 Go 는 먼저 일어난 쪽 — 드문 경우라 진행 기록에 적는다). Go `deadline(ctx, d)` 는 `ctx.with_timeout(d)` 와 같다.

**오류**
```rust
pub enum Kind { GitMissing, NotRepo, RepoMissing, Timeout, Canceled, UnsafeArgument, WriteCommand, IndexLocked, ServerShutdown, RefName }
// as_str: "git_missing" "not_a_git_repo" "repo_missing" "git_timeout" "git_canceled" "unsafe_argument"
//         "write_command_not_allowed" "index_locked" "server_shutdown" "ref_name_invalid"
pub struct Error { kind: Option<Kind>, msg: String, exec: Option<Box<ExecError>>, out: Option<Box<Output>> }
// new(kind, detail) -> msg "kind: detail"; wrap(prefix) -> "prefix: msg" (kind·exec 보존); is(k); kind(); exec_error(); output()
pub struct ExecError { argv, cwd, exit_code, stderr, kind: Option<Kind> }
// Display: "{kind}: git {argv 공백결합} (exit {n}): {stderr.trim() 또는 "(stderr 없음)"}" (kind 없으면 앞부분 없음)
```
- 실행 함수는 `Result<Output, Error>`. **실패해도 Output 을 잃지 않는다** — Error.out 에 싣는다. worktree·submodule 이 실패 시 stdout+stderr 텍스트를 진단으로 쓰고, 기록(Record)도 실패 출력을 쓴다
- `plain_exit(&Error) -> Option<&ExecError>` = exec 있고 exec.kind 없음. `is_terminal(&Error)` = NotRepo|RepoMissing|GitMissing. `ctx_err(&Ctx, what) -> Option<Error>` 문구 `"{kind}: {what}: {ctxerr}"`
- Go 오류 문구의 `%q`(문자열)는 `dm_gocompat::strconv::quote`, `%q` 의 `[]string` 은 `"[" + 각 quote 를 공백으로 이음 + "]"`, `%v` 의 `[]string` 은 `"[a b]"`. 이 조합은 core 안 작은 함수로 둔다(gocompat 의 quote 를 조합할 뿐)

**Runner** (시험 주입, FR-GIT-4)
```rust
pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type Runner = Arc<dyn Fn(Ctx, String, Vec<String>) -> BoxFut<Result<Output, Error>> + Send + Sync>;
pub type WriteRunner = Arc<dyn Fn(Ctx, String, Vec<String>, String) -> BoxFut<Result<Output, Error>> + Send + Sync>;
```
Go 시험의 가짜 runner 가 `ctx.Deadline()` 을 읽으므로 Ctx 를 넘긴다. Service 는 빌더(`Service::builder().runner(..).write_runner(..).timeout(..).max_output(..).recorder(..).build()`)와 `Service::new()`.

**Spawn** (REPO_FIX 01 P-1·P-3, `spawn.go`)
- platform `Group::bind` 가 `&std::process::Child` 를 받으므로 **std::process** 로 띄운다(tokio::process 아님). stdout·stderr 는 piped, 소비자는 std 스레드에서 돌리고 끝나면 tokio oneshot 으로 알린다. 리더 대기는 `spawn_blocking(child.wait())`. stdin 이 있으면 piped 로 열고 스레드에서 써 넣는다(빈 stdin 은 파이프를 만들지 않는다)
- 신호 시퀀스: A(ctx 끝) group.terminate → 리더 종료를 ≤G 기다림 → 안 끝나면 group.kill → 리더 대기 결과 → group.kill → 읽기 끝 ≤G, 넘으면 읽기 스레드를 버린다(Go 는 읽기단을 닫는다. 소비자는 잠금으로 보호되므로 관측 차이 없음 — 진행 기록에 적는다). B(리더 먼저) 읽기 끝 ≤G → 안 오면 group.kill → ≤G → 버린다. 끝에 group.close()
- `KILL_GRACE = 3s`, `JOB_CEILING = 10min`. 시험이 줄이는 값은 `#[cfg(test)]` 훅(AtomicU64 등)으로
- 종료 코드: 신호로 죽으면 -1 (Go `ProcessState.ExitCode()`)
- `drain(d) -> bool`(떠 있는 spawn 수가 0 이 될 때까지), `spawned` 카운터

**execGit 오류 분류** (exec.go 순서 그대로): 마감 → `"git_timeout: git {args} 가 {ms}ms 에서 마감을 넘겼다"`, 취소 → `"git_canceled: git {args} 를 호출자가 취소했다"`, 기동 실패 중 캐시된 bin 이 사라졌으면 캐시 버리고 GitMissing, 작업 디렉터리가 실제로 없으면 `"repo_missing: chdir {dir}: {err}"`, 그 밖 `"git {args}: {err}"`. io 오류 문구는 `dm_gocompat::oserr::go_error_string`. lookGit: PATH 값이 키인 캐시(`which` 대신 platform 의 lookpath 가 있으면 그것 — `rust/crates/shared/platform/src/shell/lookpath.rs` 가 막 들어왔다. 확인하고 쓸 것). launchArgs `-c log.showSignature=false` 앞에 붙임. Env 는 os 환경 + 11개(GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=, SSH_ASKPASS=, SSH_ASKPASS_REQUIRE=never, GIT_OPTIONAL_LOCKS=0, GIT_PAGER=cat, PAGER=cat, GIT_EDITOR=true, GIT_SEQUENCE_EDITOR=true, LC_ALL=C) — 순서·값 그대로

**기록 JSON** (Console 이 읽는 와이어): `Record` 필드 순서 `seq, atUnixMs, argv, cwd, exitCode, durationMs, stderr, stdoutBytes, stdoutTruncated, stderrTruncated, destructive, write, stdinBytes, err(omitempty), unguarded(omitempty), reason(omitempty)`. serde derive + `#[serde(rename…)]` + `skip_serializing_if = "dm_gocompat::json::is_empty"`. **argv 는 `Option<Vec<String>>`** — newRecord 는 빈 argv 면 nil(JSON `null`), `Redacted()` 는 항상 non-nil(빈 것은 `[]`). `Hint` 의 targets·values 도 Go 에서 nil 이면 `null` 이므로 `Option<Vec<String>>`. `LockInfo.mtimeUnixMs` 는 `Option<i64>` + skip. 직렬화는 `dm_gocompat::json::marshal`. Recorder epoch 는 Go `crypto/rand.Text()` 모양(26자, RFC 4648 base32 대문자 알파벳 `A-Z2-7`) — `rand` 로 만든다

**nil Service 안전** (FR-GXU-4): Go 는 `(*Service)(nil).ExecUnguarded/CommonDirKey/UnguardedTextRunner` 가 동작한다. Rust 는 `Option<&Service>` 를 받는 연관 함수로 두고 메서드는 위임한다

**UnguardedText**: Go 는 실패 시 (텍스트, 오류)를 함께 준다. Rust 는 `Result<String, TextFailure>` (`TextFailure { text: String, err: Error }`). Go 의 `missing func(error) error` 인자는 빼고, git 부재(Kind::GitMissing)면 `text=""` 로 돌려 호출자가 자기 sentinel 로 바꾸게 한다. 실패 문구 접두 `"git {argv}: "` 는 Error::wrap 으로

## Go core 요약 (파일별로 옮길 것)

- `guard.go`: readCommands 16개(rev-parse status diff diff-tree diff-index show log for-each-ref cat-file ls-files config check-ref-format rev-list merge-base blame ls-tree), unsafePrefixes(--upload-pack --receive-pack --exec-path --output -o), guardCommon(빈 args→Unsafe, `-` 시작→Unsafe, 목록 밖→WriteCommand, NUL→Unsafe, `--` 까지 위험 접두 검사, commit·tag 의 값 플래그 -m --message -F --file 뒤 인자·붙은 값은 건너뜀), config 읽기 플래그(--get --get-all --list --type --default --null, `=` 형태 허용, 키 하나), check-ref-format(--branch|--normalize + 이름 하나), `RelPath(p, kind)`(빈·절대·`/` 시작·볼륨·NUL·`..` 조각(ToSlash 후)·path.Clean≠p 거절. kind 는 호출자 오류 — Rust 는 제네릭 또는 호출자가 접두를 붙이는 상세 문자열), `ErrRefName`, `CheckRefArg`
- `write.go`: writeCommands 24개, readOnlySubcommands·bareIsRead → `IsWriteCommand`, `WriteSpec{argv, destructive, stdin}`, `ExecWrite`, `GuardWriteArgs`(remote add 2/remove 1, init 인자 없음, am --continue|--skip|--abort, bisect reset), `RecordWrite`, `Output::stderr_tail(n)`(기본 200)
- `exec.go`: 상수 DefaultTimeout 30s·DefaultMaxOutput 1MiB·DefaultRecordCap 500, Service·Sized·Records·RecordsSince·MaxOutput·Exec·checkCwd·finishExec·reject(exit -1, 기록)·cappedBuffer(넘친 분량도 썼다고 답함, truncated)
- `unguarded.go`: UnguardedSpec{argv, stdin, timeout, reason}, 사유 빈칸→Unsafe, 빈 argv→Unsafe, cwd 검사, spec.timeout 우선(0 이면 서비스 기본), 기록에 unguarded·reason·stdinBytes
- `record.go`·`recovery.go`(HintLog, 기본 200, 제로값 사용 가능, 시각 채움)·`redact.go`·`remote.go`(정규식 `([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\s]+@` → `${1}***@`. **Go `\s` 는 ASCII 공백 다섯(\t\n\f\r 스페이스)** 이므로 Rust 에서는 `[^/@\t\n\f\r ]` 로 풀어 쓴다 — 1.2 decidx 에서 같은 함정)·`destructive.go`(13개)·`oid.go`·`time.go`·`repo.go`(RepoRoot, filepath.Clean)·`dirs.go`(GitDirs)·`exclusion.go`(LockWait 5s, PrePhase 10s, PostPhase 15s, ManagerWrite 180s, ExclusionKey(EvalSymlinks 로 존재하는 가장 가까운 조상까지), CommonDirKey, IndexLockPath, LockInfo, IndexLockInfo, IndexLockedStderr)·`errors.go`

## 시험 옮기기 메모

- 정적 게이트(`static_test.go`·`exec_gate_test.go`·`credentials_static_test.go`·`write_test.go` 의 W3)는 Go 소스를 훑는다. Rust 판은 `rust/crates/**/*.rs` 를 훑는 시험으로 옮긴다: git 직접 실행(`Command::new("git")` 등)이 `crates/webserver/domain/git/` 와 시험 전용 gittest 밖에 없음, `exec_unguarded`·`exec_unguarded_text`·`unguarded_text_runner` 호출이 worktree·submodule·httpapi 의 fs-ignored 파일 밖에 없음, `exec_write` 호출이 git 도메인·gitapi 밖에 없음, git 표면 crate 에 자격증명 낱말(password passwd passphrase credential, 원격 파일엔 token secret 도) 없음, 허용 목록 크기 16·24. **아직 없는 crate 를 가리키는 "죽은 예외 없음"(V13)·"훑은 파일 수 하한" 은 지금 맞출 수 없다** — 하한은 Rust 기준으로 낮추고 V13 은 진행 기록에 남은 위험으로 적는다
- 실제 git 시험: exec_test(MaxOutput·NoShell·Environment·RepoMissing·GitMissing·Sized), launch_test(Command 인자·env, lookGit 캐시, 사라진 bin), spawn_test(파이프 쥔 자식·마감 시 그룹 kill·stdin·Drain — POSIX 만), exclusion_test(IndexLockPath·CommonDirKey, worktree add), repo_test RealGit, write_test 의 stdin 이 실제 git 에 닿는 시험, unguarded nil 서비스
- `t.Setenv("PATH", …)` 시험은 프로세스 전역 환경을 바꾼다 — Rust 는 병렬 시험이라 그런 시험을 한 시험 안에 몰거나 전역 잠금으로 직렬화한다. 환경 변경은 `unsafe { std::env::set_var }`(edition 2024) 이고 **unsafe 는 core 에서 금지(C-RSP-4)** 다 → PATH 를 바꾸는 시험은 `lookGit` 에 PATH 를 인자로 받는 내부 함수(`look_git_in(path_env)`)를 두어 시험하거나, 자식 프로세스 환경만 바꾸는 방식으로 우회한다

## 이 세션이 값을 치르고 배운 것

- Go 와 Rust 라이브러리가 "같은 표준" 을 따른다고 해도 갈린다(1.2 textenc 에서 Shift_JIS 377자). **Go 실측과 대조**해서 확인한다. Go 실측은 go1.27.2 로(조정자가 기준선으로 확정). 임시 Go 생성기를 `internal/zzdiffgen/` 에 두면 internal 패키지를 import 할 수 있다 — 쓰고 바로 지운다. 실행은 `rust/scripts/hermetic.sh go run ./internal/zzdiffgen`
- zsh 에서 변수 단어 분리가 안 된다: `P=(${=VAR})` 로 배열화
- `cargo fmt --all` 은 다른 crate 까지 고칠 수 있다 → 실행 뒤 `git status` 로 내 crate 밖 변경이 없는지 본다
- 병합할 때 Cargo.lock 이 충돌하면 rust-port 쪽을 받고(`git checkout --theirs rust/Cargo.lock`) cargo 로 다시 만든다
- 시험 문자열에 bidi 글자(U+202E 등)를 그대로 넣으면 rustc 가 오류를 낸다 → `\u{202e}` 이스케이프로
- clippy 가 잡는 흔한 것: `% n != 0` → `is_multiple_of`, 중첩 `if let` → let-chain, 같은 몸통 `if` 가지 합치기, 복잡한 튜플 표 타입 → 시험 모듈에 `#![allow(clippy::type_complexity)]` 또는 type 별칭

## 변하지 않는 규약

- 운영 보호: `~/.dongminal` 접근 금지, 60147 미만 포트 금지, pkill 금지, 저장소 루트 바이너리 실행·덮어쓰기 금지, 바이너리·시험 실행은 `rust/scripts/hermetic.sh` 경유, 시작·끝 `rust/scripts/prod-pids.sh`
- 외부 crate 는 `rust/DEPENDENCIES.md` 허용 목록만, `{ workspace = true }`
- Go 출력 규칙은 dm-gocompat. 없는 것은 조정자에게 묻는다(이번 filepath 처럼)
- 커밋 메시지에 AI 서명 금지
