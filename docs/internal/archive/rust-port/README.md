# Rust 포팅 이슈 관리

- 요구사항: [`docs/internal/RUST_PORT_SRS.md`](../docs/internal/RUST_PORT_SRS.md)
- 에이전트 공통 규칙: [`AGENT_RULES.md`](AGENT_RULES.md)
- 이슈: `issues/` 의 파일 하나가 이슈 하나다. ID 는 점으로 이은 트리 경로이고, 부모는 마지막 조각을 뗀 ID 다. 형식은 SRS 2.6 절에 있다.
- 트리 보기: `rust-port/tree.sh` (상태로 거르기: `rust-port/tree.sh in-progress review`)

상태의 흐름은 `todo` → `ready`(선행 이슈가 모두 done) → `in-progress` → `review` → `done` 이다. 옆길로 `blocked`(막힘), `split`(하위 이슈로 나눔)이 있다.
상태 원본은 통합 worktree(`/Users/dykim/personal/dongminal-rust/int`)의 이 폴더 하나다. 이슈 브랜치의 사본은 고치지 않는다.
