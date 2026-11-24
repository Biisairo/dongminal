# 성능 최적화 이슈 관리

- 요구사항: [`../PERF_OPTIMIZATION_SRS.md`](../PERF_OPTIMIZATION_SRS.md)
- 에이전트 공통 규칙: [`AGENT_RULES.md`](AGENT_RULES.md)
- 진행 상태: [`STATUS.md`](STATUS.md)
- 이슈: `issues/` 의 파일 하나가 이슈 하나다. ID 는 점으로 이은 트리 경로이고, 부모는 마지막 조각을 뗀 ID 다(예: `2.3` 의 부모는 `2`).
- 트리 보기: `docs/internal/perf/tree.sh` (상태로 거르기: `docs/internal/perf/tree.sh ready in-progress review`)

## 이슈 파일 형식

경로는 `issues/<ID>-<짧은 이름>.md` 다. 머리말(YAML):

```yaml
id: "2.1"
title: 에뮬레이터 crate 비교
status: todo | ready | in-progress | review | done | blocked | split
deps: ["1"]          # 먼저 done 이어야 하는 이슈
owner: ""            # 맡은 탭 uuid
branch: pf/2.1
```

본문은 목표, 완료 조건, 진행 기록이다.

## 상태 흐름

`todo` → `ready`(deps 가 모두 done) → `in-progress` → `review` → `done`. 옆길로 `blocked`(막힘, 이유를 적는다)와 `split`(하위 이슈로 나눔)이 있다.

상태 원본은 통합 worktree(`/Users/dykim/personal/dongminal-perf`, 브랜치 `perf-m1`)의 이 폴더 하나다. 이슈 브랜치의 사본은 고치지 않는다.
