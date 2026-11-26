# 기능 추가 착수 문서 — 지켜야 할 것

- 작성: 2026-11-26, 성능 최적화(PERF M1~M4) 조정 세션이 마지막으로 정리했다.
- 읽는 사람: 이 저장소에 기능을 더하는 다음 세션.
- 이 문서는 착수 지시이자 규칙 목록이다. 규칙의 근거는 각 항목에 적힌 문서와 코드다. 문서와 코드가 다르면 코드가 기준이다.

## 착수 블록 — 이번 세션의 지시 전부

1. 이 문서를 끝까지 읽는다.
2. 저장소 상태를 확인한다.
   - 작업 위치: `/Users/dykim/personal/dongminal`(main 체크아웃). 브랜치 `feature`(main 과 같은 커밋에서 만들었다).
   - `git status`, `git branch -vv`, `git log --oneline -3` 으로 본다.
   - main 은 origin/main 보다 커밋 2개 앞서 있다(perf 문서 커밋과 그 병합). push 는 사용자 확인 뒤에 한다.
3. 사용자에게 **추가할 기능이 무엇인지** 묻는다. 아직 정해진 기능은 없다.
4. 기능이 정해지면 §2 의 절차(인터뷰 → 스펙 → 시험 → 구현)로 진행한다.
5. 운영 바이너리를 다시 빌드할지 사용자에게 묻는다(§5.1). 묻기 전에 빌드하지 않는다.

## 1. 지금 상태

| 항목 | 상태 | 근거 |
|---|---|---|
| 성능 최적화 M1~M4 | 모두 끝남. SRS 목표 지표 전부 충족 | `docs/internal/PERF_OPTIMIZATION_SRS.md` §7, `docs/internal/perf/STATUS.md` |
| main | `bd8cbb91`(로컬). origin/main 은 `de87fae7` | `git log` |
| perf 브랜치·worktree | `perf-m1` 브랜치와 `dongminal-perf` worktree 는 지웠다. 모든 커밋은 main 에 들어 있다 | `git worktree list` |
| 빌드 캐시 | 모두 지웠다. 첫 Rust 빌드는 처음부터 한다(수 분) | — |
| 운영 바이너리 | `/Users/dykim/personal/dongminal/otterminal` 은 2026-11-24 빌드다. 최적화가 반영되지 않았다 | 파일 시각 |

## 2. 작업 절차

### 2.1 사용자 규칙(CLAUDE.md)과 회사 규칙

- 규모를 먼저 판단한다. 신규 기능·구조 변경·여러 모듈에 영향이 있으면 **인터뷰 → 스펙(IEEE 29148) → 시험 → 구현** 순서다. 규모가 애매하면 한 단계 위 절차를 쓴다.
- 결정이 갈리면 구현하지 않는다. 질문은 한 번에 하나씩 하고, 권장안을 함께 준다(AskUserQuestion).
- 시험을 먼저 쓰고 실패(RED)를 확인한 뒤 구현한다(GREEN). 단위·경계·실패 경우를 모두 넣는다.
- 동작이 바뀌면 **이전 / 새 / 이유** 를 진행 기록과 커밋 메시지에 적는다.
- 심볼 탐색은 LSP → Serena → grep 순서다. 코드 수정은 Serena 를 먼저 쓴다.
- 커밋은 사용자 확인 뒤에 한다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다.
- main 병합과 push 는 사용자 확인 뒤에 한다. 병합은 일반 병합(`--no-ff`)이다.
- 설명은 한국어로, 쉽고 자세하게 한다.

### 2.2 스펙과 문서

- 스펙은 `docs/internal/<이름>_SRS.md` 에 둔다(기존 SRS 들과 같은 자리·형식).
- 결정은 SRS 의 결정 표에 더한다. 결정 표를 바꾸면 `docs/internal/decisions.md` 를 다시 만든다(`check-decisions.sh` 가 본다).
- 설정 키를 지우면 `RETIRED_KEYS` 에 넣고, 설정 문서·골든·e2e 를 함께 고친다(`check-settings-docs.sh`).
- 새 crate 를 만들면 `docs/internal/architecture.md` 의 패키지 표에 더한다(`check-pkg-axis.sh`).
- 새 외부 crate 를 들일 때는 `rust/DEPENDENCIES.md` 의 규칙을 먼저 본다.

## 3. 최적화가 남긴 설계 규칙 — 새 기능도 지킨다

이 규칙을 어기면 게이트가 막거나, 최적화한 효과가 다시 사라진다.

### 3.1 서버와 브라우저 사이 — 채널과 토픽

- 상태는 **주기적인 GET 으로 묻지 않는다.** WebSocket 채널의 토픽으로 받는다. 토픽은 값이 바뀔 때만 밀어 준다(D-9·D-10).
- 설계 원본: `docs/internal/perf/CHANNEL_PROTOCOL.md`.
- 직렬화와 프레임 조립은 발행 하나에 한 번이다(4.12, CHANNEL_PROTOCOL §11.1). 연결마다 다시 직렬화하지 않는다.
- **주의(4.15.3)**: 토픽은 바뀔 때만 오므로, 화면 부품이 토픽보다 늦게 만들어지면 첫 값을 놓친다. 부품을 만들 때 앱이 마지막으로 받은 값을 넘겨받게 한다.

### 3.2 서버·데몬의 주기 작업

- 유휴 상태에서 서버와 데몬은 **외부 프로세스를 띄우지 않고, 헛도는 주기 작업을 돌리지 않는다**(FR-SRV-3, NFR-PRF-5). M4 결과: 유휴 외부 프로세스 0, 깨어남 서버 3~9회/초·데몬 0.5~6회/초.
- 새 작업은 **사건 기반**으로 만든다. 패턴: `Notify` + 가장 이른 마감까지 `sleep_until`, 대상이 없으면 무기한 `notified()`. 시험용 깨어남 카운터를 두고, tokio 시험은 `start_paused = true` 로 쓴다.
- 꼭 남겨야 하는 주기와 사건 기반 작업의 시간 값은 **`rust/crates/shared/cadence`** 한곳에 이름 있는 상수로 둔다. 상수마다 이유를 문서 주석으로 쓴다. 모듈 문서 표와 상수 목록이 같은지 시험이 본다 — 상수를 더하거나 지우면 표도 고친다.
- 한 모듈만 쓰는 값(예: debounce 창)은 그 crate 의 상수 자리에 둔다.
- 값을 하드코딩하지 않는다(사용자 요구).
- macOS 프로세스 정보는 libproc FFI 로 읽는다(4.7). `ps`·`lsof` 를 새로 부르지 않는다. 외부 프로그램은 `otter_shared_platform::command_path` 로 찾는다.
- Git 상태는 파일 감시 사건으로 당긴다(4.9·4.14). 주기 `git status` 를 더하지 않는다.
- 유휴 측정 도구: `scripts/perf/scenario.mjs --bin <바이너리>`, `scripts/perf/proc-metrics.mjs`. 기준값은 `docs/internal/perf/M4_RESULT_2026-11-25.md`.

### 3.3 웹 프론트 — 부팅 크기와 지연 묶음

- 부팅 JS 는 **1,150,000 B 이하**다(NFR-PRF-12). 게이트 `scripts/check-boot-bytes.mjs` 가 막는다. 지표는 압축 전 바이트다.
- 첫 화면에 필요 없는 코드는 `web/bundles.txt` 의 **지연 묶음** 에 넣는다. 처음 쓸 때 싣는다. 설계: `docs/internal/perf/M3_DESIGN.md`, `M3_BOOT_SCOPE.md`.
- 지연 묶음 안의 함수·전역은 부팅 직후에 없다. 쓰기 전에 `Screens.load('<묶음>')` 같은 로더를 거친다. 묶음을 처음 싣는 동작은 비동기다. 그 결과를 기다린 뒤 값을 잰다(4.15 `moveTabTo` 회귀가 이 실수였다).
- 경계 게이트: `check-lazy-boundary.mjs`, `check-load-order.mjs`, `check-layer.sh`.
- `.js`·`.css` 는 브라우저가 받으면 gzip 으로 나간다(3.4.13). 새 파일도 자동으로 그렇다.
- 가려진 화면은 **2초 뒤 잠든다**(`SCREEN_SLEEP_MS`, M3 3.5). 잠든 칸은 그리기를 미룬다(예: 편집기 진단은 버퍼에만 둔다). 새 화면 부품도 이 생명주기를 따른다.
- 타이머는 `TimerHub` 를 쓴다(`check-timers.sh`). `localStorage` 는 `PrefStore` 를 거친다(`check-storage.mjs`).
- 웹 자산은 **릴리스 바이너리 안에 들어간다.** 웹 제품 코드를 고치면 e2e 전에 바이너리를 다시 빌드한다.

### 3.4 터미널

- 다시 그리기는 데몬의 화면 스냅숏이다(M2 2.4·2.5). 원본 바이트를 처음부터 다시 틀지 않는다.
- 사용자가 받아들인 작은 차이 5건이 있다(2.4 진행 기록, 2026-11-26 결정). 이것을 버그로 다시 고치지 않는다.

## 4. 시험과 게이트

### 4.1 기능 하나를 하는 동안

- 바꾼 crate: `rust/scripts/hermetic.sh cargo test -p <crate> --lib`, `cargo fmt --all --check`, `cargo clippy -p <crate> --all-targets -- -D warnings`(모두 hermetic 을 앞에 붙인다).
- 프론트: `node --test web/js/test/*.test.mjs`, `npm run -s typecheck`, `npx eslint web/js`.
- 스크립트: `node --test scripts/test/*.test.mjs`.
- 게이트: `for g in scripts/check-*.mjs; do node $g || echo FAIL $g; done`, `for s in scripts/check-*.sh; do bash $s >/dev/null || echo FAIL $s; done`(68개).
- **`check-code-refs` 는 시험 문자열 안의 파일 이름(예: `boot.js`)도 주석 참조로 잡는다.** 변수로 빼면 된다.
- e2e 는 바꾼 동작을 재는 스펙만 `--grep` 으로 좁혀서 돌린다.

### 4.2 마일스톤 끝에서 한 번

- Rust workspace 전체(`cargo test --workspace`), `scripts/check-cross.sh`(다섯 대상), **e2e 전량**.
- e2e 전량은 마일스톤마다 꼭 돌린다. M2·M3 끝에서 건너뛰었다가 낡은 시험이 약 30건 쌓였다.

### 4.3 e2e 실행 방법

- 환경 변수: `OTTER_E2E_RUN=/private/tmp/<이름>`, `OTTER_E2E_KEEP_PEERS=1`, `PLAYWRIGHT_BROWSERS_PATH=/Users/dykim/Library/Caches/ms-playwright`, `E2E_PORT_BASE=<포트>`, 미리 빌드한 바이너리는 `OTTER_E2E_PREBUILT_BIN`.
- **실패를 가를 때는 매번 빈 `OTTER_E2E_RUN` 폴더를 쓴다.** 같은 폴더를 다시 쓰면 워커 홈의 설정이 남아 다음 실행을 오염시킨다.
- 포트: 워커 i 는 `E2E_PORT_BASE + i` 를 쓴다(기본 60147). edges-settings 가 그 위 +3300 을 쓰므로 `포트 + 3300 ≤ 65535` 를 지킨다.
- 병렬로 여러 e2e 를 돌릴 때는 실행 폴더와 포트 범위를 겹치지 않게 나눈다.

### 4.4 시험을 쓸 때 조심할 것(이번에 실제로 겪은 것)

- 화면이 2초 뒤 잠들어 시험이 0건을 읽었다(4.15.5). 읽기 전에 칸이 깨어 있고 보이는지 확인한다.
- 앞 시험이 공용 시험 저장소에 파일을 남겨 뒤 시험이 다른 행을 눌렀다(4.15.6). "첫 행" 대신 의도한 대상을 이름으로 고른다.
- 부하가 걸리면 짧은 시간 제한이 흔들린다(4.15.6). 시간 측정이 아닌 상한은 넉넉하게 둔다.

## 5. 운영 보호 — 어기면 즉시 멈춘다

1. 운영 인스턴스(`/Users/dykim/personal/dongminal/otterminal` 바이너리, 홈 `~/.otterminal`)를 실행·덮어쓰기·접근(읽기 포함)하지 않는다.
2. main 체크아웃에서 운영 이름으로 빌드하지 않는다. 시험 빌드는 이름을 나눈다: `BINARY=otterminal-<이름> rust/scripts/hermetic.sh scripts/build.sh`. 바이너리는 커밋하지 않는다.
3. `pkill`·`killall` 을 쓰지 않는다. 자기가 띄운 PID 만 끈다.
4. 다른 사람이 쓰는 worktree 에서 `git stash`·`git checkout`·`git reset` 을 하지 않는다. stash 는 꼭 필요할 때만 태그를 붙여 쓴다.

### 5.1 운영 바이너리

- 지금 운영 바이너리는 최적화 전 판이다. 다시 빌드할지, 언제 할지는 사용자가 정한다. 묻기 전에 빌드하지 않는다.

## 6. 여러 에이전트로 일할 때 배운 것

- **하위 에이전트의 `git add`·`git commit` 은 자동 모드 분류기에 막힌다.** 하위 에이전트에게는 변경을 남기고 커밋 메시지를 파일(`/private/tmp/<이름>-commit.txt`)로 쓰게 한다. 커밋은 조정자가 한다. 병합 충돌도 하위 에이전트가 `git merge --no-commit` 으로 풀어 스테이징하게 하고, 조정자가 커밋한다.
- **main 병합과 push 는 사용자가 분명히 지시해야 통과한다.** "좋아" 같은 짧은 답은 분류기가 승인으로 보지 않았다. "main 병합하고 push 해" 처럼 분명한 지시를 받는다.
- **병렬 worktree 는 디스크를 빨리 채운다.** worktree 마다 `rust/target` 이 커진다. 이번에 다섯 개를 동시에 돌려 디스크가 가득 찼다(ENOSPC). 동시 빌드 수를 줄이고, cross-target clippy(`check-cross.sh`)는 조정자가 마일스톤 끝에 한 번만 돌린다. 이슈가 끝나면 `rust/target/debug/incremental` 을 지운다.
- worktree 에서 시작할 때 `rust/target` 을 APFS 복제(`cp -cR`)로 가져오면 처음부터 빌드하지 않는다. `node_modules` 는 main 체크아웃의 것을 링크한다.
- 병렬 이슈는 같은 파일에서 자주 충돌한다(`web/bundles.txt`, `settings-controller.js`, `harness.mjs`, `commands.rs`, `cadence/src/lib.rs`). 하나 병합할 때마다 `git merge-tree --write-tree --name-only <통합> <이슈>` 로 보고, 충돌하면 그 에이전트에게 하나씩 차례로 풀게 한다.
- 하위 에이전트와 조정자가 같은 탭에 있으면 프롬프트에 "otterctl msg 를 쓰지 말고 최종 답으로 보고" 를 넣는다.

## 7. 보류된 것과 후속 후보

- **보류(사용자 결정)**: Linux·Windows 실제 실행 확인(컴파일은 `check-cross` 로 확인), 유휴 CPU 18구간 중 1구간 0.116%(목표 0.1%, 평균은 충족).
- **후속 후보(손대지 않음)**:
  - repo-tab e2e 의 X6 가 시험 저장소에 스테이지된 `x6.txt` 를 남긴다. X6 끝에서 되돌리게 한다.
  - 다른 패널 단위 토픽에도 "패널보다 먼저 온 첫 값을 놓치는" 틈(4.15.3)이 있는지 점검한다.

## 8. 먼저 읽을 것

| 문서 | 왜 |
|---|---|
| `docs/internal/architecture.md` | 패키지 구조와 경계 |
| `docs/internal/building.md` | 빌드·검사·배포 방법 |
| `docs/internal/perf/CHANNEL_PROTOCOL.md` §10.5·§11.1 | 남는 주기 목록, 한 번 인코딩 |
| `rust/crates/shared/cadence/src/lib.rs` 모듈 문서 | 주기·시간 상수 등록부 |
| `web/bundles.txt`, `docs/internal/perf/M3_DESIGN.md` | 부팅 묶음과 지연 묶음 |
| `docs/internal/perf/AGENT_RULES.md` | 하위 에이전트 공통 규칙(운영 보호·시험 범위). 기능 작업에서도 그대로 쓸 수 있다 |
| `rust/DEPENDENCIES.md` | 외부 crate 규칙 |
