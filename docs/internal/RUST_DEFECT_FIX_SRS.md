# RUST_DEFECT_FIX_SRS — Rust 포팅에 남은 결함 수정
> **문서 상태**: 승인·구현완료

| 항목 | 값 |
|---|---|
| 이슈 | 10 (조사 10.0) |
| 기준 커밋 | `rust-port` `93e60f51` (rp/10 분기점) |
| 상위 문서 | `docs/internal/RUST_PORT_SRS.md` |
| 형식 | IEEE 29148 SRS |

## 1. 소개

### 1.1 목적

포팅 이슈 0~9 는 결함을 찾으면 진행 기록의 "남은 위험"·"보안 검토 지적"에 적고 넘어갔다. 이 문서는 그 기록을 모두 훑어, Rust 판에 **지금도 남아 있는** 결함만 골라 수정 요구사항으로 정한다. 하위 이슈 10.1… 은 이 문서를 단일 근거로 삼는다.

### 1.2 범위

- 넣는다: 잘못된 동작, 보안·가용성 약점, Go 와 사용자에게 보이게 다른 동작, 흔들리는 시험, 실패하는 시험, 공급망 경고(chrono RUSTSEC-2026-0543).
- 뺀다: `RUST_PORT_SRS.md` 3.7 의 "알려진 차이"·"구현 차이", 실기 환경이 없어 못 한 검증(Windows·linux/amd64), 기능 설계 결정, 이미 고친 것. 뺀 것은 6절에 사유와 함께 적는다.
- Go 는 고치지 않는다(C-RSP-2). 운영 전환 뒤에는 Go 를 쓰지 않는다.
- 조사 방법: `int/rust-port/issues/*.md` 의 진행 기록에서 "남은 위험"·"보안 검토"·"조정자 판단"·"흔들"·"미검증"·"미이식"이 들어간 절과 문단을 모두 뽑았다(약 1,200줄). 항목마다 rp/10 의 코드와 git 기록에서 아직 남아 있는지 확인했다.

### 1.3 정의

| 용어 | 뜻 |
|---|---|
| marks | chat·edgemesh 가 잊은 노드의 마지막 번호를 기억하는 표. 옛 상태·글의 재전송을 막는다 |
| reached | 이 노드에서 망을 따라 닿은 적이 있다는 표시 |
| 블로킹 | 스레드를 멈추고 기다리는 호출(`thread::sleep`, 파일 락 대기 등) |
| 흔들리는 시험 | 코드가 같아도 실행마다 통과·실패가 갈리는 시험 |
| Go 와 같게 | Go 기준선(go1.27.2, `127ff7d9`)과 관측 동작을 바이트 단위로 맞춘다 |
| 더 안전하게 | Go 와 다르게, 결함이 없는 쪽으로 고친다. SRS 3.7 에 DIFF 로 올린다 |

### 1.4 참고 문서

- `docs/internal/RUST_PORT_SRS.md` (3.7 DIFF-1~32)
- `int/rust-port/AGENT_RULES.md`
- `int/rust-port/STATUS.md`
- 이슈 진행 기록 `int/rust-port/issues/*.md`

## 2. 전체 설명

- 결함은 12건이다. HIGH 0, MEDIUM 3, LOW 9.
- 뺀 항목은 52건이다(6절). 그중 17건은 뒤 이슈에서 이미 고쳤음을 코드로 확인했다.
- 운영 보호(C-RSP-1)와 게이트(AGENT_RULES 3-6)는 하위 이슈에도 그대로 적용한다.
- e2e 시험(FR-RDF-6·7)은 AGENT_RULES 2-4 에 따라 이슈 8.1 만 돌린다. 하위 이슈가 e2e 를 돌리려면 조정자 허락이 필요하다.

## 3. 구체 요구사항

심각도 기준: HIGH = 데이터 손상·원격 악용, MEDIUM = 가용성·보안 약점이나 상시 실패하는 시험, LOW = 드문 조건의 동작·문구 차이나 흔들리는 시험.

### FR-RDF-1 재전송 막기 marks 가 reached 번호로 가득 차 새 노드를 받지 못한다 — MEDIUM

- **결함**: DIFF-19·21 수정으로, marks 가 가득 차면 reached 가 아닌 번호만 밀어낸다. 밀어낼 것이 없으면 아는 노드를 잊지 않고 새 노드도 받지 않는다. 간선 상대 하나가 서로 이어진 가짜 지문을 대량으로 알리면 그 가짜도 reached 가 된다. 그러면 marks(4096)가 reached 로 차고, 이 노드는 그 뒤로 새 노드를 끝없이 받지 못한다. chat 과 edgemesh 가 같다.
- **근거**: 이슈 3.1 진행 기록 "남은 위험(조정자 판단 필요)", SRS DIFF-21 "8 통합 검증에서 TTL 또는 간선 상대별 몫으로 다시 본다". 코드: `rust/crates/daemon/chat/src/upper.rs:226`·`:297`(`junk_mark` 는 `!reached` 만 고른다), `rust/crates/daemon/chat/src/service.rs:44`, `rust/crates/shared/edgemesh/src/net.rs:14`·`:215`.
- **요구 동작(더 안전하게)**:
  1. marks 가 reached 번호로 가득 차도, 새 노드를 받지 못하는 상태가 끝없이 이어지지 않아야 한다.
  2. 일부러 밀어내기로 reached 노드의 재전송 막기를 우회하는 공격(DIFF-19 가 막은 것)이 다시 열리지 않아야 한다.
  3. 권장안: reached 번호에 수명을 둔다. 수명이 지난 reached 번호는 밀어낼 수 있다. 대안은 간선 상대마다 몫을 두는 것이다(한 상대가 알린 노드의 번호가 차지할 수 있는 칸을 제한). 어느 쪽인지, 수명·몫의 값은 하위 이슈가 정하고 SRS 3.7 DIFF-19·21 의 Rust 판 칸을 고친다.
  4. chat 과 edgemesh 가 같은 규칙을 쓴다.
- **수락 시험**:
  - 가짜 지문 MAX_MARKS 개를 reached 로 채운 뒤, 정한 수명이 지나거나(시계 주입) 몫을 넘기면 새 노드를 받는다.
  - reached 번호가 수명 안에 있으면, 그 노드의 옛 epoch·seq 상태와 글을 다시 받지 않는다(기존 DIFF-19·21 시험 유지).
  - 두 crate 에 같은 시험이 있다. 시험은 실제 시간에 기대지 않는다.
- **예상 crate**: `dm-daemon-chat`, `dm-shared-edgemesh`

### FR-RDF-2 Claude 계정 전환 경로가 tokio 작업 스레드를 최대 9초 막는다 — MEDIUM

- **결함**: 디렉터리 락(`acquire_dir_lock`)은 `thread::sleep` 으로 돌며 최대 9초 기다린다. 이 락과 파일 락·키체인 호출을 `async fn` 안에서 그대로 부른다. HTTP 처리기 `api_claude_accounts_switch` 는 이 `async fn` 을 tokio 작업 스레드에서 바로 `await` 한다. 엔진·자동 전환 루프(`eng.run`·`auto.run`)도 `tokio::spawn` 한 task 안에서 같은 호출을 한다. 락 경합이 있으면 작업 스레드가 몇 초씩 멈추고, 같은 스레드에 있는 다른 요청(SSE·WS·API)이 함께 늦어진다. 작업 스레드 수만큼 겹치면 서버 전체가 멈춘다. Go 는 goroutine 이라 이런 일이 없다(NFR-RSP-3 위반).
- **근거**: 이슈 4.5.1·4.5.3·4.5.4 "남은 위험 — async 안의 블로킹(MEDIUM), 5.5 httpapi 가 이 전제를 지켜야 한다". 코드: `rust/crates/webserver/httpapi/src/claude_accounts.rs:602-612`(처리기가 바로 await), `:515-516`(spawn 한 루프), `rust/crates/webserver/domain/claudeacct/src/service.rs:304`, `engine.rs:749`·`:780`·`:807`, `dirlock.rs:84`·`:91`(`thread::sleep`).
- **요구 동작(Go 와 같게 — 다른 요청을 막지 않는다)**:
  1. 블로킹 호출(디렉터리 락·파일 락·키체인·live 재시도 sleep)은 tokio 작업 스레드에서 돌지 않아야 한다. `spawn_blocking` 이나 그에 맞는 방법으로 옮긴다.
  2. 응답 바이트·오류 문구·락 순서·시한 값(9초)은 바뀌지 않는다.
- **수락 시험**:
  - 디렉터리 락을 다른 쪽이 쥔 상태에서 `/api/claude-accounts/switch` 를 부르는 동안, 작업 스레드 1개짜리 런타임에서 다른 요청(예: `/api/health`)이 락 대기 시간보다 훨씬 짧게 답한다.
  - 기존 claudeacct·httpapi 시험이 모두 통과한다.
- **예상 crate**: `dm-webserver-domain-claudeacct`, `dm-webserver-httpapi`

### FR-RDF-3 데몬의 간선 요청에 전체 시한 30초가 없다 — LOW

- **결함**: Go 데몬은 간선 op 하나에 `context.WithTimeout(30s)` 를 건다. Rust `edge_op` 는 `Node::do_op` 를 시한 없이 기다린다. 호출 하나는 edge Client 의 시한(연결 5초·요청 15초)에 걸리지만, 호출을 여러 번 하는 op 는 30초를 넘을 수 있다. 데몬의 간선 요청 자리는 둘(edge 슬롯 2)뿐이라, 오래 걸리는 op 가 다른 간선 요청을 막는다.
- **근거**: 이슈 3.2 "남은 위험 — edge 호출에 Go 는 ctx 30초 시한을 주지만 Rust 는 시한이 없다". 코드: `rust/crates/daemon/ipc/src/handlers.rs:445-468`, Go `internal/daemon/ipc/paned_edge.go:18`·`:86`.
- **요구 동작(Go 와 같게)**: op 하나가 30초를 넘으면 기다리기를 그만두고 Go 가 그때 내는 것과 같은 `EdgeResult`(상태·코드·문구)를 답한다. 상수 이름은 `EDGE_CALL_TIMEOUT` 이다. 시한 초과 때의 Go 응답 모양은 하위 이슈가 Go 코드(`edgenode.Do` 의 ctx 오류 갈래)에서 확인한다.
- **수락 시험**: 응답하지 않는 가짜 상대에게 op 를 보내고 시한을 낮춰(시험 전용 주입) 정한 응답이 오는지 본다. 시험은 실제 30초를 기다리지 않는다.
- **예상 crate**: `dm-daemon-ipc` (필요하면 `dm-shared-edgenode`)

### FR-RDF-4 git 작업 이벤트 SSE 가 클라이언트 끊김을 바로 알지 못한다 — LOW

- **결함**: Go `apiGitJobEvents` 는 `r.Context().Done()` 을 함께 기다려, 클라이언트가 끊으면 곧바로 구독을 놓는다. Rust `job_event_loop` 는 끊김을 기다리지 않는다. 새 줄이나 15초 keep-alive 를 쓰다 실패할 때에야 끝나므로, 끊긴 구독이 최대 15초 남는다. 이슈 8.1 이 commands SSE 에서 같은 결함을 `st.closed()` 로 고쳤고, 이 자리는 살펴보지 않았다고 적었다.
- **근거**: 이슈 8.1 "남은 위험 — gitapi `remote.rs` 의 진행 스트림은 끊김 감지를 살펴보지 않았다". 코드: `rust/crates/webserver/gitapi/src/remote.rs:285-313`, Go `internal/webserver/gitapi/handlers_git_remote.go:360-361`, 고친 예 `4688c7f7`(commands.rs).
- **요구 동작(Go 와 같게)**: 클라이언트가 끊으면 다음 쓰기를 기다리지 않고 루프를 끝내고 구독을 놓는다.
- **수락 시험**: 작업을 구독한 SSE 를 닫은 뒤 1초 안에 구독 수가 0 이 된다(8.1 의 `sse_close_releases_ownership_without_waiting_for_hello` 와 같은 꼴).
- **예상 crate**: `dm-webserver-gitapi`

### FR-RDF-5 유지보수가 끝난 chrono 를 직접 쓴다 — LOW

- **결함**: chrono 는 RUSTSEC-2026-0543(유지보수 중단) 대상이다. `deny.toml` 이 사유를 달아 무시하고 있다. 직접 쓰는 곳은 셋이다.
- **근거**: 이슈 8.3 "결정 후보 — chrono 대체", 이슈 10 알려진 출발 목록 ②. 코드: `rust/crates/gocompat/src/time/zone.rs:607`(unix 밖의 로컬 시간대, `chrono::Local`), `rust/crates/shared/workspace/src/recover.rs:75`(`Utc::now().format`), `rust/crates/webserver/domain/claudeacct/src/alerts.rs:49-51`(유닉스 시각 → 로컬 시각), `rust/Cargo.toml:115`, `rust/deny.toml:13`.
- **요구 동작(Go 와 같게)**:
  1. 세 자리에서 chrono 를 걷어 내고, 워크스페이스 의존과 `deny.toml` 의 ignore 를 지운다.
  2. 격리 파일 이름·알림 날짜의 바이트는 바뀌지 않는다.
  3. 로컬 시각은 `dm_gocompat::time` 으로 얻는다. unix 는 이미 zoneinfo 를 읽는다(`zone.rs:584`). Windows 로컬 시간대를 unsafe 없이 얻을 수단이 없으면, 하위 이슈가 AGENT_RULES 4절(unsafe 허용 자리) 확장을 조정자에게 묻는다. gocompat 은 platform 에 의존할 수 없다(platform 이 gocompat 에 의존한다).
- **수락 시험**: `cargo deny check`·`cargo audit` 가 ignore 없이 통과한다. 세 자리의 기존 바이트 시험(격리 파일 이름, 알림 문구)이 통과한다. 다섯 대상 clippy 가 통과한다.
- **예상 crate**: `dm-gocompat`, `dm-shared-workspace`, `dm-webserver-domain-claudeacct`

### FR-RDF-6 e2e V-LAY-1 이 기준선과 달라 늘 실패한다 — MEDIUM

- **결함**: `ui-layout-defaults.spec.ts` 의 V-LAY-1 은 계산값 스냅샷을 기준선 파일과 비교한다. `span.ag-tab-n.ui-tab-badge` 10곳이 기준선보다 늘어 Go·Rust 모두 실패한다. 바이너리와 무관한 프런트·기준선 문제다. 늘 실패하는 시험은 진짜 회귀를 가린다.
- **근거**: 이슈 8.1 진행 기록, STATUS.md "실패 1 = V-LAY-1, Go 기준선과 같음". 파일: `e2e/ui-layout-defaults.spec.ts:186`, `e2e/baseline/ui-layout.darwin.json`(linux·win32 판도 있다).
- **요구 동작**:
  1. 늘어난 10곳이 의도한 프런트 변경의 결과인지 `web/` 의 git 기록으로 가른다.
  2. 의도한 변경이면 spec 파일이 정한 절차(`LAYOUT_BASELINE=write npx playwright test ui-layout-defaults`, spec 24행)로 기준선을 다시 만든다. linux·win32 기준선은 그 OS 에서 만들어야 하므로 진행 기록에 남은 일로 적는다. 의도하지 않은 변경이면 프런트를 고친다.
  3. 어느 쪽인지와 근거 커밋을 진행 기록에 적는다.
- **수락 시험**: V-LAY-1 이 해당 spec 반복 실행에서 흔들림 없이 통과하고, 마지막 e2e 전량 1회(이슈 11.10)에서 통과한다(사용자 결정 2026-11-24: 전량은 모든 작업 뒤 1회만).
- **예상 대상**: `e2e/baseline/*`, 필요하면 `web/` (crate 아님)

### FR-RDF-7 e2e git-feedback F-9.4 가 전량 실행 때 흔들린다 — LOW

- **결함**: 전량 실행 중 편집기 사이드 표시 대기(10초)에서 가끔 시한에 걸린다. 단독 실행(`--repeat-each=5 --retries=0`)은 Go·Rust 모두 15/15 통과한다. 부하에 기대는 시험이다.
- **근거**: 이슈 8.1 진행 기록, STATUS.md "흔들림 1 = git-feedback F-9.4". 파일: `e2e/git-feedback.spec.ts:94`(`toHaveText('결과 알 수 없음', { timeout: 5000 })` 등).
- **요구 동작**: 시험이 시간 예산 대신 관측 가능한 조건(요소 상태·이벤트)을 기다린다. 앞 시험이 남긴 상태에 기대지 않는다. 제품 동작은 바꾸지 않는다(원인이 제품에 있으면 그 사실을 적고 조정자에게 알린다).
- **수락 시험**: F-9.4 가 해당 spec 반복 실행에서 흔들림 없이 통과하고, 마지막 e2e 전량 1회(이슈 11.10)에서 통과한다.
- **예상 대상**: `e2e/git-feedback.spec.ts` (crate 아님)

### FR-RDF-8 chat 시험 `reachability_follows_links` 가 부하에서 흔들린다 — LOW

- **결함**: 이 시험은 실제 시간 3초(`EVENTUALLY`) 안에 망 변화가 퍼지기를 기다린다. 세 crate 를 함께 돌린 부하에서 한 번 시한을 넘겼다.
- **근거**: 이슈 3.1 "시험 `reachability_follows_links`(chat) 가 세 crate 를 함께 돌린 부하에서 한 번 3초 안에 끝나지 않았다". 코드: `rust/crates/daemon/chat/src/tests.rs:797`, 도우미 `:55`.
- **요구 동작**: 시험이 벽시계 시한 대신 결정론적 진행(시계 주입, tokio 시간 정지, 또는 사건 통지)을 쓴다. 제품 코드의 시간 상수는 바꾸지 않는다.
- **수락 시험**: CPU 부하(예: `yes` ×3) 아래에서 `cargo test -p dm-daemon-chat` 20회 연속 통과(5.3 이 쓴 방법과 같다).
- **예상 crate**: `dm-daemon-chat`

### FR-RDF-9 디렉터리 생성 실패 문구가 Go `os.MkdirAll` 과 다르다 — LOW

- **결함**: 여러 crate 가 `DirBuilder::recursive` 로 `MkdirAll` 을 흉내 낸다. 조상이 파일이면 Go 는 그 조상 경로와 `not a directory` 를 내지만, Rust 는 요청 경로 전체와 `file exists` 등을 낸다. 이 문구는 HTTP 응답 detail 과 CLI stderr 에 나간다. `dm-ctl-cli` 의 `start::mkdir_all` 만 Go 알고리즘으로 고쳤다(6.1.2).
- **근거**: 이슈 1.5 "mkdir 오류 문구의 경로가 Go 와 다를 수 있다", 이슈 4.3 "LOW: worktree create 의 디렉터리 생성 실패 문구", 이슈 6.1.2 "`mkdir_all` 오류 문구". 코드: `rust/crates/shared/serverconf/src/fsx.rs:23-35`, `rust/crates/webserver/domain/worktree/src/manager.rs:266`, `rust/crates/webserver/gitapi/src/worktree.rs:135`, `rust/crates/webserver/gitapi/src/ignore.rs:91`, `rust/crates/webserver/httpapi/src/fs_transfer.rs:112`. Go 알고리즘 판: `rust/crates/ctl/cli/src/start.rs:257-259`.
- **요구 동작(Go 와 같게)**:
  1. Go `os.MkdirAll` 의 알고리즘과 오류 문구를 `dm_gocompat::oserr`(또는 조정자가 정한 gocompat 모듈)에 하나로 둔다.
  2. 위 다섯 자리와 `start::mkdir_all` 이 그것을 쓴다.
  3. 같은 흉내를 쓰는 나머지 자리(`dm-shared-runtime`, `dm-shared-agentadapter`, `dm-shared-toolhub`, `crates/cmd/dongminal`, `dm-ctl-cli` doctor)도 문구가 밖으로 나가면 같이 바꾼다.
- **수락 시험**: 조상이 파일인 경로, 끝 경로가 파일인 경로, 권한 없는 조상에서 go1.27.2 실측 문구와 바이트가 같다(시험 기대값은 실측으로 고정). 고친 자리마다 오류 문구 시험이 하나 있다.
- **예상 crate**: `dm-gocompat`, `dm-shared-serverconf`, `dm-webserver-domain-worktree`, `dm-webserver-gitapi`, `dm-webserver-httpapi`, `dm-ctl-cli`

### FR-RDF-10 gen-decisions 의 파일 읽기 오류에 경로가 빠진다 — LOW

- **결함**: `decidx::collect` 가 `std::fs::read(&path)?` 의 `io::Error` 를 그대로 돌려준다. 그래서 stderr 에 `permission denied` 만 나간다. Go 는 `open <경로>: permission denied` 다.
- **근거**: 이슈 1.2 "남은 위험 — decidx 의 collect 는 파일 읽기 오류를 std::io::Error 로 돌려준다". 코드: `rust/crates/ctl/decidx/src/lib.rs:73`, 출력 `rust/crates/scripts/gen-decisions/src/main.rs:28-32`.
- **요구 동작(Go 와 같게)**: 읽기 오류를 `dm_gocompat::oserr::path_error("open", 경로, e)` 로 감싼다.
- **수락 시험**: 읽을 수 없는 결정 파일을 둔 디렉터리에서 `collect` 오류 문구가 `open <경로>: permission denied` 다.
- **예상 crate**: `dm-ctl-decidx`

### FR-RDF-11 현재 디렉터리에서만 찾은 실행 파일의 문구가 Go 와 다르다 — LOW

- **결함**: 공용 `look_path` 는 Go `exec.ErrDot`(현재 디렉터리·상대 PATH 항목에서만 찾음)를 "없음(None)"으로 합친다. 그래서 Go 의 `exec: "x": cannot run executable found relative to current directory` 대신 `executable file not found in $PATH` 문구가 나간다.
- **근거**: 이슈 1.4.6 "남은 위험 3". 코드: `rust/crates/shared/platform/src/shell/lookpath.rs:4`·`:100`.
- **요구 동작(Go 와 같게)**: `look_path` 가 "없음"과 "ErrDot"을 가려 돌려주고, 문구를 만드는 호출자가 Go 와 같은 문구를 낸다. ErrDot 인 실행 파일을 실행하지 않는 동작은 그대로다.
- **수락 시험**: PATH 에 `.` 만 있고 그 자리에 실행 파일이 있을 때, 오류 문구가 go1.27.2 실측과 같다(unix·Windows 갈래 각각).
- **예상 crate**: `dm-shared-platform` (문구를 만드는 호출자 crate)

### FR-RDF-12 진단 번들 가림이 비밀 이름 뒤의 JSON 비문자열 값을 놓친다 — LOW

- **결함**: DIFF-22 의 가림은 비밀 이름 뒤의 JSON **문자열** 값만 가린다. `"password": 12345`, `"pin": 123456` 같은 숫자 값은 그대로 번들에 실린다.
- **근거**: 이슈 6.1.3 "남은 위험 — 비밀 이름 뒤의 JSON 비문자열 값은 전과 같이 가리지 않는다". 코드: `rust/crates/ctl/cli/src/redact.rs:53`(`JSON_KEY` 가 `"` 로 시작하는 값만 맞춘다)·`:134`·`:198`.
- **요구 동작(더 안전하게)**: 비밀 이름 뒤의 JSON 숫자 값도 `***` 로 가린다(JSON 형식이 깨지지 않게 `"***"` 로 바꾼다). `true`·`false`·`null` 은 비밀이 아니므로 그대로 둔다. 비밀이 없는 입력의 번들은 지금처럼 Go 와 바이트가 같다. SRS 3.7 DIFF-22 의 Rust 판 칸을 고친다.
- **수락 시험**: 숫자 비밀 카나리가 번들에 남지 않는다. 기존 `no_secret_is_unchanged` 와 가림 시험이 통과한다.
- **예상 crate**: `dm-ctl-cli`

## 4. 검증

- 모든 수정은 시험 RED → GREEN 순서다(AGENT_RULES 3-4).
- 게이트: `cargo fmt --all --check`, 고친 crate 의 `clippy --all-targets -D warnings`, `rust/scripts/cross-check.sh`(다섯 대상), `rust/scripts/hermetic.sh cargo test -p <crate>`. FR-RDF-5 는 `cargo deny check`·`cargo audit` 도 돈다.
- 관측 문구 기대값은 go1.27.2 격리 실측으로 고정한다(hermetic).
- 시작·끝 `rust/scripts/prod-pids.sh` 출력을 진행 기록에 적는다.

## 5. 미해결 질문 (하위 이슈가 조정자에게 묻는다)

> 조정자 결정(2026-11-24): ① FR-RDF-1 은 **수명 방식**이다 — reached 번호도 일정 시간 다시 닿지 않으면 밀어낼 수 있게 된다. 값은 잊은 시각(Mark.at)부터 3 × REDIAL_MAX = 180초다(Go·Rust 모두 주기 재알림이 없어 재알림 주기를 쓸 수 없다 — 10.1 보고). 거절된 재전송으로는 at 을 갱신하지 않는다. 밀어내기는 칸이 찼을 때만 일어나며, 수명 안의 reached 는 밀려나지 않음을 시험으로 고정한다. 간선별 몫은 정상 중계 망을 깎을 수 있어 쓰지 않는다. ② FR-RDF-5 Windows 로컬 시간대는 Go zoneinfo_windows.go 와 같게 GetTimeZoneInformation 으로 얻고(go1.27.2 가 부르는 것), unsafe 는 dm-gocompat 의 Windows 전용 시간대 모듈 하나로 허용한다(RUST_PORT_SRS C-RSP-4 에 FormatMessageW 와 같은 예외로 덧붙인다). ③ e2e 는 10.7 이 hermetic 규칙(운영 홈 금지·60147 이상 포트·전후 prod-pids)대로 돌려도 된다.

1. FR-RDF-1: reached 번호의 수명 방식과 간선 상대별 몫 방식 가운데 무엇을 쓰고, 값은 얼마로 할지.
2. FR-RDF-5: Windows 로컬 시간대를 얻으려고 gocompat 에 Windows 시간대 API(unsafe)를 허용할지.
3. FR-RDF-6·7: e2e 를 이슈 8.1 밖에서 돌려도 되는지(AGENT_RULES 2-4).

## 6. 뺀 것

### 6.1 이미 고친 것 (코드로 확인)

| # | 항목 (이슈) | 확인 근거 |
|---|---|---|
| X-1 | gocompat json null 재시도 DoS(5.3 보안 검토 HIGH) | `d0f3a536` — 재시도를 구조체 필드 수로 묶음 |
| X-2 | gocompat 구조체 필드 null(4.7 silenceMin, 5.3 RawMessage) | `8b2feb7b`·`2413b5db` |
| X-3 | edgerelay `relay_end_to_end_rejects_non_edge` 흔들림(2.4.2) | `f2119cbb` — 거절 경보 경합 수정 |
| X-4 | edgenode `add_rejected_when_full`·`pair_in_one_step` 흔들림(2.4.3) | `52f4f55f` |
| X-5 | platform `ipc::tests::stream_errors_match_go` 흔들림(4.4·5.3) | `5654f53b`·`3cef11c2` |
| X-6 | edge Listener 의 상대 주소 누락, MeshError 원인 분류(2.4.1·2.4.3) | `edge/src/listener.rs:69` `client_addr`, `db12262d` |
| X-7 | Run 저장 중 잠금(4.4, NFR-RSP-3) | `f81bb5e6` |
| X-8 | settingsschema `Problem` Display·타입 이름 ignore 시험(1.3 ④⑤) | `settingsschema/src/lib.rs:61`, 워크스페이스에 해당 `#[ignore]` 없음 |
| X-9 | release 전송 오류 문구(1.3 ⑥) | 1.6 의 `neturl_err::UrlError` 사용 |
| X-10 | statusline 에 Deserialize 없음(2.1) | `statusline/src/lib.rs:46` |
| X-11 | humancmd Client 미구현(1.5) | `a31ae0ff` |
| X-12 | doctor 홈 주입·tool_home·dmlog init(6.1.2) | `ctl/cli/src/doctor.rs:465` `set_env_overlay`, `cmd/dongminal/src/daemon.rs:68`, `main.rs:27` |
| X-13 | git core 정적 게이트 시험 2건 실패(5.5.7.2) | STATUS: 워크스페이스 3,825 통과·실패 0 |
| X-14 | verify 종단간 미실행(6.1.3) | STATUS: verify 26/26 |
| X-15 | 릴리스 바이너리의 `CARGO_MANIFEST_DIR` 경로(7.4) | `sandbox/src/helper.rs:245` `cfg(dongminal_trimpath)`, 재현 빌드 통과 |
| X-16 | build.sh `DIST` 절대 경로 오류(8.2) | `rust/scripts/build.sh:103-106` |
| X-17 | HTTP 서버 연결 시한(1.3 ③, slowloris) | `httpapi/src/rebind_conns.rs:125`·`:158`(헤더 10초·유휴 120초) |

### 6.2 SRS 3.7 에 이미 올라 있는 것

| # | 항목 | 사유 |
|---|---|---|
| X-18 | DIFF-3·4·5·6(gocompat 깊이·부분 채움·EvalSymlinks·연도 범위) | 알려진 차이 |
| X-19 | DIFF-24·25·27·28(zip deflate, LSP WS UTF-8, diag, Windows mime) | 알려진 차이 |
| X-20 | DIFF-12·30(dev 헬퍼 cargo 안내, 보조 도구 안내 문구) | 구현 차이 |
| X-21 | 보안 강화·결함 수정 DIFF-1,2,7~11,13~23,26,29,31,32 | 이미 Rust 에서 고쳤다. Go 반영은 사용자 결정 |
| X-22 | 6.1.1 리바인드 응답·6.3.3 입력 JSON 타입 오류 때 0 값 | DIFF-4 와 같은 한계 |

### 6.3 실기 환경이 없어 못 한 검증

| # | 항목 | 사유 |
|---|---|---|
| X-23 | Windows 실행 전부(1.4.3~1.4.6 ConPTY·AF_UNIX·Job Object, 1.1 errno·시간대, 1.2 sysstat, 3.2·3.3 신호·swap, 4.5.2 정션, 4.6.2 Job kill EOF, 5.5.7.1 same_file·링크 복사, 6.1.1 `%PATH%` 문구, 6.3.3 셈) | 실기 없음. 목록은 이슈 8.3 |
| X-24 | linux/amd64 실기, Linux inotify 실제 백엔드(4.7) | 에뮬레이션 비용·실기 없음. linux/arm64 는 3,820 통과 |
| X-25 | 1.4.5 Windows `SO_RCVTIMEO` 뒤 소켓 상태 | Windows 실기 필요 |
| X-26 | 2.5 헬퍼 HTTP 오류 문구 미실측, 4.1.1·4.1.2 오류 문구 일부 미대조 | 결함이 확인되지 않은 미검증 |
| X-27 | 5.2 Go 시험 일부 미이식(gitwatch 느린 저장소 등) | 결함이 확인되지 않은 미검증 |

### 6.4 기능 설계 결정

| # | 항목 | 사유 |
|---|---|---|
| X-28 | claude 셈 `--allowedTools=mcp__dongminal` 사전 허용 | 이슈 10 범위 규칙이 뺀다 |
| X-29 | omp 멤버 오버레이 `match: "dmctl *"` 가 복합 명령을 허용할 수 있음(2.1 보안 검토) | X-28 과 같은 종류(에이전트 사전 허용 설계). 원 SRS(OMP_AGENT_SUPPORT_SRS)에서 다룬다 |
| X-30 | `version` 셋째 칸 go1.27.2, 릴리즈 go 판 | 사용자 결정 대기(STATUS) |
| X-31 | Go 쪽 결함(check-home-layout.sh 소켓 4개, daemon-fingerprint `xargs sum`) | Go 는 고치지 않는다(C-RSP-2) |

### 6.5 라이브러리·런타임 한계로 남는 차이 (SRS 3.7 등재 제안)

아래는 Go 와 다르지만, 고치려면 의존 라이브러리를 바꾸거나 런타임 구조를 바꿔야 한다. 결함 수정 범위에서 빼고 조정자에게 3.7 등재를 제안한다.

| # | 항목 (이슈) | 사유 |
|---|---|---|
| X-32 | HTTP 클라이언트 오류 문구 근사 ①~⑥: 잘못된 응답줄 인용, https→잡음 서버, 이름 해석 원인, 그 밖의 TLS 문구, reset 의 로컬 주소, 청크 오류(1.6) | hyper·rustls 가 원문을 주지 않는다 |
| X-33 | 응답 JSON 타입 오류의 Go 익명 구조체 이름(1.3 ⑦, 6.3.1 ③) | 서버가 틀린 모양을 줄 때만. gocompat 타입 이름 한계 |
| X-34 | UTF-8 이 아닌 바이트를 손실 변환(2.2.1 cwd 보고, 4.1.2 git 경로, 4.4 short, 5.5.6 multipart 이름, 6.1.3 번들 로그, 6.3.3 메모리 파일, 1.4.2 경로) | Rust `String` 구조. macOS APFS 는 UTF-8 이 아닌 이름을 받지 않는다 |
| X-35 | 글자 단위 소문자화(Go `strings.ToLower` 와 İ 등)(5.5.1, 5.5.6, 5.5.7.1, 6.3.1 ④, 6.2) | 특수 글자에서만. 정상 이름은 ASCII |
| X-36 | 호스트명 해석 실패 문구(5.5.1), IPv6 zone 이름(2.4.1·2.3) | OS 해석기·std 주소 타입 한계 |
| X-37 | hyper 101 응답의 Date 머리, 세션 재개 끔 등 간선 구현 결정(2.3) | 관측 결과는 같다고 확인 |
| X-38 | 서버 자식 프로세스의 `DONGMINAL_HOME` 상속(7.3) | `start --foreground --home X` 를 환경 변수 없이 부를 때만. 읽는 관측 자리 없음 |
| X-39 | CLI·헬퍼 HTTP 가 `HTTP_PROXY` 를 따르지 않음(6.1.1·6.3.1 ①) | 로컬 제어 요청(토큰 포함)을 프록시로 보내지 않는 쪽이 더 안전하다. 보안 강화 DIFF 로 올리기를 제안 |
| X-40 | open-url 로컬 실행 실패 문구 근사(6.3.1 ②) | 드문 실패 갈래. OS 오류 원문 한계 |

### 6.6 관측되지 않거나 로그에만 나오는 것

| # | 항목 (이슈) | 사유 |
|---|---|---|
| X-41 | `wait` 오류 로그의 신호 이름(2.2.2), `load_all` 타입 오류 로그(2.2.3), telegram·claudeacct 의 reqwest 꼬리 문구(4.7·4.5.1), sysstat 오류(1.2), privhelper base32·`unlinkat` 문구(6.2) | 로그 전용 |
| X-42 | `Profiles()` nil → `null`(5.5.2) | Go 구현은 늘 non-nil 을 준다(`internal/shared/sandboxplace/place.go:200`) |
| X-43 | 대기 요청이 끊기면 503(5.5.3·5.5.4), ToolUsage `null` 기록 버림(5.5.3) | 받을 상대가 없다·데몬이 쓰지 않는 모양 |
| X-44 | `init`·`repos/pin` 의 repo_guard(5.4.1), wsentry `Error::Io` 분류(5.5.6), quoted-printable 부분(5.5.6) | 운영에서 guard 를 주입하지 않음·관측 자리 없음·브라우저가 보내지 않음 |
| X-45 | `State.accounts` null↔[](4.5.1), ignore_add 빈 경로 결과(4.2.1), succeed `member.preamble` 타입(6.3.2) | Service·핸들러·서버 경로에서 드러나지 않음을 확인 |
| X-46 | 한 줄에 JSON 값 둘 이상(5.3), 셈 환경의 중복 키(6.3.3) | 데몬·셸이 그런 입력을 만들지 않는다 |
| X-47 | `auto status --json` 의 null 본문(6.3.3), migrate null workspace(6.2) | Go 는 패닉, Rust 가 더 낫다 |

### 6.7 Go 와 같거나 의도한 것

| # | 항목 (이슈) | 사유 |
|---|---|---|
| X-48 | 긴 대기(프리앰블 90초 등)가 블로킹 스레드를 잡음(5.5.4), `caller_tool_id` 동기 호출(5.5.8), telegram 브리지의 데몬 RPC(5.5.9) | Go 와 같은 흐름. 대기는 `run_sync`·`off_thread` 안에서 돈다 |
| X-49 | 연결당 스레드 2(2.4.2), edge 리스너 닫기가 비동기(3.3) | 간선 최대 64. 데몬 종료에서 관측 차이 없음 |
| X-50 | END 만 남은 PEM 이 앞 로그를 모두 가림(6.1.3) | 의도한 과잉 가림(보안 쪽) |
| X-51 | `millis_env` Duration 오버플로, `new_req_id` 난수 실패(1.4.1), close 오류(1.4.2), 시계 역행(4.1.3) | Go 쪽이 오버플로 결함이거나 실제로 일어나지 않는다 |
| X-52 | 시간에 기대는 시험(3.2 ipc·swap, 4.6.2 NFR-5)과 git 이 없으면 건너뛰는 시험(5.4.x) | 실패가 관측되지 않았다. 흔들리면 그때 FR 로 올린다 |

## 7. 하위 이슈 묶음 제안

| 하위 이슈 | 요구사항 | crate·대상 | 결함 종류 | 병렬 |
|---|---|---|---|---|
| 10.1 | FR-RDF-1, FR-RDF-8 | dm-daemon-chat, dm-shared-edgemesh | 재전송 막기·흔들리는 시험 | 가능 (미해결 질문 1 먼저) |
| 10.2 | FR-RDF-2 | dm-webserver-domain-claudeacct, dm-webserver-httpapi | async 블로킹 | 가능 |
| 10.3 | FR-RDF-5 | dm-gocompat(time), dm-shared-workspace, dm-webserver-domain-claudeacct(alerts.rs) | 공급망 | 가능. 10.2 와 claudeacct 를 함께 고치지만 파일이 다르다(병합 순서만 맞춘다). 미해결 질문 2 먼저 |
| 10.4 | FR-RDF-3, FR-RDF-4 | dm-daemon-ipc, dm-webserver-gitapi | 시한·끊김 감지 | 가능 |
| 10.5 | FR-RDF-9, FR-RDF-10, FR-RDF-11 | dm-gocompat(oserr), serverconf, worktree, gitapi, httpapi, ctl-cli, decidx, platform | Go 오류 문구 | 10.3 과 gocompat 을 함께 고치지만 모듈이 다르다(oserr·time). 10.4 와 gitapi 파일이 다르다(worktree.rs·ignore.rs 와 remote.rs). 병합 순서만 맞추면 가능 |
| 10.6 | FR-RDF-12 | dm-ctl-cli(redact.rs) | 보안 가림 | 가능. 10.5 와 ctl-cli 를 함께 고치지만 파일이 다르다 |
| 10.7 | FR-RDF-6, FR-RDF-7 | e2e, web | e2e 실패·흔들림 | 가능. 미해결 질문 3(e2e 실행 허락) 먼저 |

- 크기: 10.1·10.2·10.5 가 중간, 나머지는 작다. 10.4 와 10.6 은 한 에이전트가 이어서 맡아도 된다.
- 모든 묶음이 끝나면 SRS 3.7 을 고친다: DIFF-19·21(FR-RDF-1), DIFF-22(FR-RDF-12), 6.5 절의 등재 제안.
