# 조정자 인계 (2026-11-23 12:2x, 1번째 조정자 → 2번째 조정자)

당신은 dongminal Go→Rust 포팅의 **조정자**다. 이슈 에이전트들을 띄우고, 질문에 결정을 내리고, review 가 오면 확인해 통합 브랜치 `rust-port` 에 병합한다. 직접 포팅하는 일은 작은 수정(공용 규칙 충돌, 불안정 시험, 문서 생성물)만 한다.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/RUST_PORT_SRS.md` — 요구사항. 특히 2.4 C-RSP-1(운영 무중단), 3.1 FR-RSP-1~7(동등성·보안 강화·결함 수정), 3.4 FR-RSP-30~36, 3.7 차이 표(DIFF-1~15)
2. `rust-port/AGENT_RULES.md` — 에이전트 공통 규칙(에이전트에게 주는 것)
3. `rust-port/STATUS.md` — 2차 정지 때의 상태(그 뒤 진행은 아래 "지금 상태"가 최신)
4. `rust-port/tree.sh` 로 이슈 트리 확인

## 경로·도구

- 통합 worktree: `/Users/dykim/personal/dongminal-rust/int` (브랜치 `rust-port`). 이슈 상태 원본은 여기 `rust-port/issues/`
- 이슈 worktree: `/Users/dykim/personal/dongminal-rust/<ID>` (브랜치 `rp/<ID>`)
- 조정 스크립트(`rust-port/coord/`):
  - `rp-merge.sh <ref> <이슈ID> "<메시지>"` — rust-port 에 병합, Cargo.lock 충돌은 rust-port 쪽 기준으로 자동 해소, 그 이슈 crates 의 fmt·clippy·격리 test, prod-pids 출력. 다른 파일 충돌이면 멈추고 알린다(대개 `gocompat/src/lib.rs` 의 `pub mod` 줄 — 양쪽 줄을 다 남겨 푼다)
  - `rp-launch.sh <이슈ID> "<추가 지시>"` — worktree·브랜치 생성, rust-port 창에 탭, claude 실행, 첫 지시(`rp-brief.sh`) 전송. 탭 생성 기준 탭(`--at`)이 닫히면 스크립트의 그 uuid 를 살아 있는 rp 탭으로 바꿔야 한다
  - `rp-rate-watch.sh five_hour 70` — 세션 사용률이 70% 이상이면 끝나는 감시. **백그라운드로 다시 띄워야 한다**(1번째 조정자의 감시는 탭과 함께 사라진다)
  - `rp-tabs.txt` — `이슈ID 탭uuid` 기록. 에이전트가 migration 하면 탭 uuid 가 바뀌니 갱신한다
- 운영 PID 확인: `rust/scripts/prod-pids.sh` — 처음부터 `38173 start --foreground` / `58470 d --handover-fd`. 바뀌면 즉시 전원 멈추고 사용자에게 알린다

## 사용자 결정 (유효)

- 병렬은 dmctl 탭 + worktree. 커밋은 이슈 브랜치·rust-port 까지 자동. **main 병합·push 금지**
- 동등성 = 사용자가 차이를 모르는 최종 동작(내부·테스트 모양은 달라도 됨)
- 기준선: 127ff7d9 를 go1.27.2(JSONv2 기본)로 빌드한 것
- 보안 약점·결함은 묻지 말고 강화·수정하고 SRS 3.7 에 `DIFF-n` 으로 적는다(`D-n` 은 결정 색인 decisions.md 가 결정으로 모으므로 쓰지 않는다)
- **지금 지시: 세션(five_hour) 사용률 70% 까지 진행 → 닿으면 전원에게 "하던 일까지만 하고 멈춤"(멈춤 공지 형식은 아래) → review 된 것만 병합 → 사용자에게 보고.** 주간 사용률(시작 때 77%, 12:10 에 80%)은 보지 않고 진행하라고 사용자가 정했다
- 묻지 말고 알아서 진행하라고 했다. 정말 사용자 몫인 결정만 묻는다

## 지금 상태 (12:2x)

진척: Go 프로덕션 102,842 줄 중 약 60% 병합. rust-port 전체 시험 약 1,800 통과.

끝남: 0.x, 1.x, 2.x 전부, 4.1~4.4, 4.5.1~4.5.3, 4.6, 4.7, 5.1, 5.2, 5.3, 6.2, 6.1.1, 6.3.1, 6.3.2, 7.1

일하는 에이전트(rp-tabs.txt):

| 이슈 | 탭 uuid | 하는 일 |
|---|---|---|
| 3.1 | 0cddb8cc-b93a-4a49-8f17-f4a0ed871624 | ① edgemesh MeshError 가 CallError 를 들게(port(2.4.1)) ② 채팅 chat·chatsock |
| 3.2 | 30b02b20-0c8d-4db0-a930-e693f2753805 | 데몬 IPC·swap. FR-RSP-22(Go 데몬→Rust 데몬 handover) 격리 검증이 핵심. platform 추가(6fe0e27d)는 병합됨 |
| 4.5 | 6604e13e-40bf-45f9-b0c5-cfcb2bfa466e | 4.5.4 Auto·알림 (마지막 하위) |
| 5.4 | 3080be17-35c9-4e8d-9aec-d51e2362fd3e | gitapi 5.4.1 → 5.4.2 → 5.4.3. neturl(5a24a04f)은 병합됨 |
| 6.1 | 87c64315-57ea-4469-be25-d1f253ecadc6 | 6.1.2 수명주기·진단 → 6.1.3. 미포팅 액션의 임시 '아직 없습니다' 안내는 6.1.2·6.1.3 에서 반드시 걷게 할 것 |
| 6.3 | 5171532b-6869-465c-80e1-940591acbe58 | 6.3.3 edge·account·훅·chat-mcp·claude 셈 |

다음에 열리는 것: 3.1·3.2 → 3.3(데몬 부팅) / 4.5 → 5.5 선행 일부 / 5.4·5.5 / 6.1·6.3 → 7(진입점·빌드) → 8(통합 검증). 5.5 httpapi(18,297줄)는 deps 가 모두 done 이 되면 시작하자마자 하위 이슈로 크게 나누게 한다(서버 골격·라우팅·접근 제어가 첫 하위).

## 운영 방식 (값을 치르고 배운 것)

- **review 메시지가 오면**: `rp-merge.sh <해시> <ID> "merge …"` → 이슈 파일 `status: done` + 진행 기록 한 줄 → 열리는 이슈 `ready` 로 → `git add rust-port && git commit`. 이슈 브랜치의 wip 은 병합하지 않는다
- 에이전트가 다른 이슈 crate(gocompat·platform 등)를 고쳐야 하면, 소유 에이전트가 끝났으면 허락하되 **새 파일 + lib.rs 선언 한 줄**로, **따로 커밋**(port(<원래 이슈>): …)하게 하고 그 커밋을 먼저 병합한다
- 같은 줄을 두 에이전트가 고치려 하면(예: platform lib.rs 의 pub use) 조정자가 직접 rust-port 에 넣는다
- 탭을 닫은 뒤에는 반드시 `dmctl list-workspace | grep 'tab="rp '` 로 실제로 닫혔는지 확인한다(1번째 조정자가 zsh 단어 분할 실수로 엉뚱한 탭을 닫은 적이 있다 — 반복문에 `set -- $p` 를 쓰지 말 것)
- `git worktree move` 는 **절대경로**를 준다(상대경로면 int 안으로 들어간다)
- 맥락 50% 넘은 에이전트에게 큰 이슈를 새로 주지 않는다. 일이 끝나면 닫고 새 에이전트를 띄운다. 에이전트는 60% 넘으면 스스로 migration 한다
- 에이전트에게 일을 줄 때 "바로 시작해서 끝까지, 확인을 기다리지 않는다"를 꼭 넣는다(안 넣으면 기다린다)
- 전체 시험은 가끔 `rust/scripts/hermetic.sh cargo test -q --workspace --no-fail-fast` 로 돈다. **SRS 를 고치면 `rust/scripts/hermetic.sh go run ./scripts/gen-decisions` 로 decisions.md 를 다시 만든다**(dm-ctl-decidx 시험과 Go 게이트가 그것을 본다)
- 부하에서 흔들리는 시험은 실제 시간·특정 errno 에 기대지 않게 고친다(stream_errors_match_go, toolclient timing 사례)
- `ring` 을 끌어오는 crate 는 교차 clippy 를 8.3 으로 미룬다(이 Mac 에 대상별 C 툴체인 없음)

## 멈춤 공지 형식

```
조정자 공지(사용자 지시, 세션 사용률 70% 도달): 지금 하고 있는 일까지만 끝내고 멈춘다. 새 일은 시작하지 마라. 끝까지 못 가면 안전한 지점에서 멈춘다. 멈출 때: ① 브랜치에 커밋(미완이면 'wip(<ID>): …') ② 이슈 파일 진행 기록에 어디까지 했는지·다음 할 일·남은 위험을 적고, 끝냈으면 status: review, 아니면 in-progress ③ prod-pids.sh 출력 기록 ④ dmctl msg --to <조정자 toolId> '<ID> 멈춤: <review|wip> <해시>'. 그 뒤 추가 작업 없이 대기한다.
```

멈춘 뒤 `rust-port/STATUS.md` 를 새 상태로 다시 쓰고 커밋한다.

## 작업 끝에 사용자에게 보고할 것 (모아 둔 것)

- Go 저장소 `scripts/check-home-layout.sh` 가 소켓 4개 누락을 못 잡는다(0.3 발견, 포팅 범위 밖)
- SRS 3.7 의 보안 강화·결함 수정(DIFF-1,2,7,8,9,10,11,13,14,15)을 Go 쪽에도 고칠지 사용자가 정한다
- 릴리즈·CI 는 go 1.26.11 이고 기준선은 1.27.2 다(JSON 가장자리 차이). Go go.mod 를 올릴지 사용자 몫
- `version` 셋째 칸 go1.27.2 표기(이슈 7 에서 재검토)
- Windows 실기 검증 수단(8.3)

## 첫 할 일

1. `dmctl who-am-i` 로 자기 uuid·toolId 를 적는다
2. `rust-port/coord/rp-rate-watch.sh five_hour 70` 를 Bash 백그라운드로 띄운다(끝나면 멈춤 공지)
3. `rust/scripts/prod-pids.sh` 확인
4. 일하는 에이전트 6명에게 "조정자가 바뀌었다. 앞으로 알림은 `dmctl msg --to <새 조정자 toolId>`" 를 보낸다(1번째 조정자가 이미 보냈으면 생략 — 인계 엔벨로프에 적혀 있다)
5. 그다음은 메시지를 기다리며 위 운영 방식대로 진행한다
