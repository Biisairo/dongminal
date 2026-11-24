# 조정자 인계 (2026-11-24 09:4x, 2번째 조정자 → 3번째 조정자)

당신은 dongminal Go→Rust 포팅의 **조정자**다. 에이전트를 띄우고, 결정을 내리고, review 가 오면 확인해 통합 브랜치 `rust-port` 에 병합한다. 직접 고치는 일은 작은 것(문서 상태 줄, 이슈 기록)만 한다.

## 착수 블록 — 이번 세션이 할 일 전부

1. `dmctl who-am-i` 로 자기 uuid·toolId 를 적는다. `rust-port/coord/rp-rate-watch.sh` 안의 조정자 uuid(`cf1f5fa3-…`)를 새 uuid 로 바꾼다(쓰지 않더라도 남겨 두지 마라).
2. 단체채팅 방 **`rust-port 조정`**(room id `3f5fcdb2a795bbe4979e48712fba64b5d59fcdc172e51fa0364ea7f9fbe41ab5`)에 `mcp__dongminal__chat_join` 으로 들어가고 "조정자가 바뀌었다" 를 한 줄 쓴다. **에이전트와의 소통은 이 방에서만 한다 — `dmctl msg` 로 직접 보내지 않는다(사용자 지시).** 새 글 알림이 오면 `chat_read`.
3. `rust/scripts/prod-pids.sh` — 처음부터 `38173 start --foreground` / `58470 d --handover-fd`. 바뀌면 즉시 전원 멈추고 사용자에게 알린다.
4. 남은 순서:
   1. **12.3**(e2e 고정 대기 단축, 진행 중, 탭 `445e4e95`) review 를 받아 병합 → 이슈 12 done.
   2. **11.10**(R10 Go 제거와 전량 확인, `rust-port/issues/11.10-*.md`): Go 전체 삭제(`git rm` — internal/·cmd/·go.mod·go.sum·scripts·web 의 *.go 등, GO_REMOVAL_SRS 3.5·G-1~3·G-29·G-38·G-39·G-70), Rust 만으로 `./scripts/build.sh`·`make gates`·`make test`·`npm run unit` 통과. 대기 중인 에이전트(탭 `2b3eb707` 11.7 담당 또는 `7dd5093d` 11.9 담당)에게 방에서 맡긴다.
   3. **사용자 지시: Go 삭제·빌드·게이트까지 끝나면 e2e 를 시작하지 말고 멈춰 사용자에게 알린다.** 사용자가 그 사이에 할 일이 있다. 사용자가 신호를 주면 **e2e 전량을 1회만** 돈다(hermetic, `DM_E2E_KEEP_PEERS=1`, 60147 이상 포트, 전후 prod-pids). 실패하면 그 spec 만 다시 돌려 흔들림인지 결함인지 가른다.
   4. 다 끝나면 `rust-port/STATUS.md`·SRS 상태 줄 정리, 사용자에게 보고.

## 먼저 읽을 것

1. `rust-port/STATUS.md` — 지금 상태·사용자 지시·소통·운영 메모·사용자 판단 대기
2. `docs/internal/GO_REMOVAL_SRS.md` — 3.1 자리 목록(G-1~G-74), 3.5 Go 제거, 3.8 수락 시험, 3.9 허용 차이, 3.10 묶음, 4절 결정
3. `docs/internal/E2E_PRUNE_REPORT.md` — §8 이 12.3 의 근거
4. `rust-port/issues/11.10-*.md`, `12-*.md`
5. 필요하면 `docs/internal/RUST_PORT_SRS.md` 3.7(DIFF-1~32), `docs/internal/RUST_DEFECT_FIX_SRS.md`(구현완료)

## 지금 상태 (근거 커밋)

- rust-port 끝: `0de07977`(STATUS 갱신). 작업 트리 깨끗.
- 이슈 0~10 done. 이슈 11: 11.1·11.2·11.3·11.3b·11.3c·11.5·11.6·11.7·11.8·11.9·11.9b·11.9c done, 11.10 todo. 이슈 12: 12.0·12.1·12.2 done, 12.3 진행 중.
- `./scripts/build.sh` → `./dongminal` 이 Rust 바이너리(`dongminal dev darwin/arm64 go1.27.2`, Go 런타임 기호 0). int 에서 툴체인 1.95.0(`rust/rust-toolchain.toml`)으로 build·`make gates` ok(09:3x).
- Go 는 아직 이 브랜치에 있다(11.10 에서 지운다). 원본 Go 는 main 브랜치에 남는다.

## 탭(살아 있는 rp 탭)

| 탭 uuid | 맡은 것 | 상태 |
|---|---|---|
| 445e4e95-b41d-4b35-8b85-e2ba1042cc87 | 12.3 | 일하는 중(하위 에이전트 3명 함께) |
| 2b3eb707-bf41-476d-ad03-0d1f615f9fb1 | 11.1·11.7 을 한 에이전트 | 대기(11.10 후보) |
| 7dd5093d-6cb4-4ecc-a21f-35744855e4d1 | 11.5·11.8·11.9(b·c) 를 한 에이전트 | 대기(11.10 후보) |
| fd776686-5913-44b4-9336-0956c2f24760 | `rp anchor`(셸, 새 탭 기준) | `rp-launch.sh` 가 이 탭을 `--at` 으로 쓴다 — 닫지 마라 |

## 경로·도구

- 통합 worktree `/Users/dykim/personal/dongminal-rust/int`(브랜치 `rust-port`), 이슈 worktree `/Users/dykim/personal/dongminal-rust/<ID>`(브랜치 `rp/<ID>`)
- `rust-port/coord/rp-merge.sh <ref> <이슈ID> "<메시지>"` — 병합 + 그 이슈 `crates:` 의 fmt·clippy·격리 test + prod-pids. 이슈 파일의 `crates: []` 이면 시험을 돌리지 않으니, 여러 crate·스크립트를 바꾼 병합은 `git merge --no-ff` 뒤 직접 `make gates`·관련 시험을 돈다.
- `rust-port/coord/rp-launch.sh <ID> "<추가 지시>"` — worktree·탭·claude·첫 지시(`rp-brief.sh`, 채팅방 규칙 포함). 새 탭이 막 생긴 직후 입력이 먹지 않은 적이 있어 2초 대기를 넣었다 — 실행 뒤 `dmctl status` 로 `working` 을 확인한다.
- `make gates` 는 10분을 넘긴다 — 백그라운드로 돌린다.

## 사용자 결정 (유효)

- main 병합·push 금지. 커밋은 이슈 브랜치·rust-port 까지 조정자 몫.
- 동등성 = 사용자가 차이를 모르는 최종 동작. 빌드·바이너리 사용 과정도 Go 판과 같아야 한다(명령·인자·출력·산출물 이름·위치·종료 코드).
- 보안 약점·결함은 묻지 말고 고치고 SRS 3.7 DIFF 로 적는다(번호는 조정자가 붙인다).
- 세션 사용률은 신경 쓰지 말고 끝까지(사용자, 11-23 밤). 감시를 띄우지 않는다.
- e2e 전량은 모든 작업 뒤 11.10 에서 **1회만**. 앞 작업은 해당 spec 만 돈다.
- **11.10: Go 삭제 뒤 e2e 전에 멈추고 사용자에게 알린다.**
- CI 워크플로는 병합 뒤 첫 실행을 시험으로 삼는다. Windows 실기 검증은 하지 않는다.
- e2e 정리: 확실한 17개만 지웠고(12.1), 시간 단축은 제품 코드 변경 없는 기본안만(12.3).
- 에이전트 소통은 단체채팅 방에서만.

## 값을 치르고 배운 것

- **`dmctl close-tab` 을 같은 칸에 연달아 쓰면 엉뚱한 탭이 닫혔다(11-23 12:4x).** 하나씩 닫고, 닫기 전 `dmctl wait --for done`, 닫은 뒤 `dmctl list-workspace | grep 'tab="rp '` 로 확인한다.
- 에이전트 세션의 권한 분류기는 커밋을 자주 막는다 → 에이전트는 스테이징 후 "커밋 요청 <ID>: <메시지>" 를 보내고 조정자가 그 worktree 에서 `cd <worktree> && git commit -qm …` 로 대신 커밋한다. 조정자 세션은 각 worktree `.claude/settings.local.json`(git add/commit/merge·rp-merge 허용, push 금지)으로 커밋된다.
- 디스크가 자주 찬다(worktree 마다 rust/target 5~17G). 이슈를 병합하면 그 worktree 의 `rust/target` 을 지운다. 지우기 전 `pgrep -fl 'cargo|rustc'` 로 그 worktree 에 빌드가 없는지 본다.
- int 에 `node_modules` 가 없으면 `make gates`(check-load-order 의 espree)·`npm run unit`·typecheck 가 실패한다 — 지금은 `npm ci` 로 설치돼 있다. 에이전트 worktree 에서 통과한 것이 int 에서 깨지면 먼저 환경을 의심한다.
- e2e 를 여러 실행이 동시에 돌면 서로의 `/tmp/dongminal-e2e-*` 를 지운다 — `DM_E2E_KEEP_PEERS=1`.
- e2e 는 `127.0.0.1` 로 붙는다(10.7b: localhost→::1 이 다른 프로세스에 잡혀 ERR_INVALID_HTTP_RESPONSE). 실패 때 서버 로그·응답·포트 소유를 남긴다(`DM_E2E_KEEP_HOME` 이면 홈도).
- verify(verify-isolated 포함)만 커널 임시 포트를 허용한다(7.4 결정 (가)).
- 결정 색인 재생성: `cargo run -q --locked --manifest-path rust/Cargo.toml -p dm-scripts-gen-decisions`(이제 go run 이 아니다). SRS 를 고치면 돌린다. 상태 줄 검사: `bash scripts/check-srs-status.sh`, `bash scripts/check-srs-progress.sh`.
- 내 명령이 결과와 무관하게 "ok" 를 기록한 적이 있다(11.6) — 검사 결과를 읽은 뒤에 기록한다.

## 사용자 판단 대기 (마지막 보고에 넣는다)

- 운영 전환(Go→Rust 바이너리 교체)과 main 병합 시점
- claude 셈 `--allowedTools=mcp__dongminal` 사전 허용(Go 와 같아 그대로)
- Go 결함 보고: daemon-fingerprint.sh `xargs sum`(DIFF-29)·`--os` 값 없을 때 무한 루프(11.1), `DONGMINAL_NO_UPDATE_CHECK` 무시(DIFF-32), check-home-layout.sh 소켓 4개 누락
- 릴리즈·CI go 1.26.11 vs 기준선 1.27.2, `version` 셋째 칸 `go1.27.2`
- linux/amd64 실기 시험은 돌리지 않았다
- 정리할 worktree·브랜치: `/Users/dykim/personal/dongminal-rust/<ID>` 다수, `rp/10.7b-parked`(10.7c 로 흡수)
