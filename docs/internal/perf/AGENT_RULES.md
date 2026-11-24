# 성능 최적화 에이전트 공통 규칙

이슈를 맡은 모든 에이전트가 따른다. 요구사항의 근거는 `docs/internal/PERF_OPTIMIZATION_SRS.md` 이고, 채널의 하위 설계는 `CHANNEL_PROTOCOL.md` 다. 이 문서와 SRS 가 충돌하면 SRS 를 따르고 조정자에게 알린다.

## 1. 경로

| 이름 | 경로 |
|---|---|
| 통합 worktree (브랜치 `perf-m1`) | `/Users/dykim/personal/dongminal-perf` |
| 이슈 폴더 (상태는 **여기서만** 고친다) | `/Users/dykim/personal/dongminal-perf/docs/internal/perf/issues/` |
| 내 worktree | `/Users/dykim/personal/dongminal-pf/<이슈 ID>` |
| 내 브랜치 | `pf/<이슈 ID>` |

내 worktree 에도 `issues/` 사본이 있다. 사본은 고치지 않는다. 상태는 통합 worktree 의 원본 파일을 절대경로로 고친다.

## 2. 운영 보호 — 어기면 즉시 멈춘다

1. 운영 인스턴스는 저장소 루트의 `/Users/dykim/personal/dongminal/otterminal` 이고 홈은 `~/.otterminal` 이다. 실행·덮어쓰기·접근(읽기 포함)하지 않는다. main 체크아웃(`/Users/dykim/personal/dongminal`)에서 빌드하지 않는다.
2. 바이너리와 시험은 `rust/scripts/hermetic.sh` 를 앞에 붙여 돌린다. 빌드는 `BINARY=otterminal-pf<ID> rust/scripts/hermetic.sh scripts/build.sh` 처럼 이름을 나눈다. 바이너리를 커밋하지 않는다.
3. 포트는 조정자가 맡길 때 준 범위만 쓴다(60147 이상). e2e 는 `OTTER_E2E_RUN=/private/tmp/pf<ID>e2e OTTER_E2E_KEEP_PEERS=1` 을 붙인다 — 붙이지 않으면 병렬 실행끼리 서로의 폴더를 지운다.
4. `pkill`·`killall` 을 쓰지 않는다. 내가 띄운 PID 만 끈다.
5. `git stash`·`git checkout`·`git reset` 을 다른 사람이 쓰는 worktree 에서 하지 않는다.

## 3. 작업 절차

1. 내 이슈 파일의 머리말을 `status: in-progress`, `owner: <내 탭 uuid>` 로 바꾼다(`otterctl who-am-i`).
2. 이슈가 크거나 독립된 덩어리로 나뉘면 하위 이슈 파일(`<내 ID>.1-…md`)을 만들고 내 이슈를 `status: split` 으로 바꾼 뒤 조정자에게 알린다. 하위를 누가 언제 할지는 조정자가 정한다.
3. 중·대 규모 설계 결정은 사용자 확인을 받는다. 결정이 여럿 갈리면 하나씩 권장안과 함께 묻는다. 정해진 결정은 SRS 의 결정 표에 더하고 `cargo run --manifest-path rust/Cargo.toml -p otter-scripts-gen-decisions` 로 `decisions.md` 를 다시 만든다.
4. **시험을 먼저 쓰고 RED 를 확인한 뒤** 구현한다. RED 를 확인하지 못했으면 진행 기록에 그 사실을 적는다.
5. **시험 범위(사용자 지시)**: 바꾼 crate 의 `cargo test -p <crate> --lib`, 관련 `node --test` 파일, 바꾼 동작을 재는 e2e 스펙 한두 개(`--grep` 으로 좁힌다), `cargo fmt --all --check`, `cargo clippy -p <crate> --all-targets -- -D warnings`, 관련 게이트만 돌린다. **Rust 전체 시험과 e2e 전량은 마일스톤 끝에서 조정자가 한 번만 돌린다.** 릴리스 빌드는 이슈 끝에 한 번만 한다.
6. 내 브랜치에 커밋한다(사용자가 이슈 브랜치 커밋을 허락했다, 2026-11-24). 메시지는 한국어, 형식 `perf(<이슈 ID>): <무엇을>`. AI 서명(`Co-Authored-By` 등)은 넣지 않는다. 통합 브랜치·main 에 직접 커밋하거나 병합하지 않는다. push 하지 않는다.
7. 이슈 파일을 `status: review` 로 바꾸고 진행 기록에 적는다: 바꾼 것, 지운 것, 동작 변경(이전 / 새 / 이유), 시험 결과, 남은 위험, 코드와 어긋난 문서(고치지 않고 목록만).
8. 조정자에게 `otterctl msg --to <조정자 uuid> "<이슈 ID> review: <한 줄 요약>"` 으로 알린다. 조정자는 확인한 뒤 통합 브랜치로 병합하고 `done` 으로 바꾼다.

## 4. 코드 규칙

- 사용자 CLAUDE.md 의 규칙(심볼 탐색은 LSP → Serena → grep, 최소 구현, 국소 변경, TypeScript·Rust 스타일)을 따른다.
- 같은 일을 하는 구현을 두 벌 두지 않는다(D-11). 옛 경로는 대체 시험이 같은 성질을 재는 것을 확인한 뒤 지운다(FR-CON-10).
- 제품 코드에 `eprintln!` 금지, 외부 프로그램은 `otter_shared_platform::command_path`, `localStorage` 는 `PrefStore` 경유 — 게이트가 잡는다.
- 문서와 코드가 다르면 코드가 기준이다. 문서는 고치지 않고 진행 기록에 목록으로 남긴다(사용자 확인 뒤 수정).

## 5. 막혔을 때

다른 이슈의 결과가 필요한데 아직 끝나지 않았거나, 판단할 근거가 없으면 추측해서 구현하지 않는다. `status: blocked` 로 바꾸고 이유를 적은 뒤 조정자에게 알린다.
