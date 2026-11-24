# 최적화 진행 상태 (2026-11-24)

## 지금 상태

- M0 끝(`1de4bb0f`). M1 은 코드 작업(1.1~1.8)이 끝났고 통합 브랜치 `perf-m1` 에 있다(로컬, push 안 함).
- 1.10 M1 전체 시험 1회가 돌고 있다. 끝나면 1.9(gitConsoleInterval 삭제) → 1.11(재측정) 순서다.
- 1.12 문서 정합은 사용자 확인 대기.
- M2·M3·M4 는 todo. 각각 시작할 때 하위 이슈로 나눈다.

## 사용자 지시 (2026-11-24)

- 이슈는 이 폴더의 문서로 관리하며 진행한다(Rust 포팅과 같은 방식).
- 전체 시험(Rust workspace·e2e 전량)은 마일스톤 끝에서 한 번만 돌린다. 이슈 중에는 바꾼 부분만.
- 빠를수록 좋다. 병렬로 할 수 있는 이슈는 병렬로 맡긴다.
- perf 브랜치 커밋은 허락됐다. main 병합과 push 는 사용자 확인 뒤.

## 사용자 결정 (SRS §1.4 에 원본)

- D-9 상태용 주기 GET 전부 제거 · D-10 토픽별 변화량/전체 값 · D-11 표준 압축, WebSocket 구현 하나 · D-12 모든 연결 압축, sockudo-ws.
- agentsPollInterval·gitConsoleInterval 설정 삭제, Git Console 은 토픽으로.

## 운영 메모

- 조정자 탭 uuid: `027320fb-3c82-4f5b-8ffa-7d3656903fee`.
- worktree 마다 `rust/target` 을 APFS 복제(`cp -cR`)로 시작하면 처음부터 빌드하지 않는다. 병합한 이슈의 worktree 와 target 은 지운다(디스크 여유 35 GB 안팎).
- `node_modules` 는 main 체크아웃의 것을 링크한다(공용 `info/exclude` 에 `/node_modules`·`/otterminal-*`).
- 병렬 e2e 는 `OTTER_E2E_RUN` 을 나누고 `OTTER_E2E_KEEP_PEERS=1` 을 붙인다.
