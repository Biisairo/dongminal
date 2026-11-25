# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-26 05:50, 조정 세션)

- **perf-m1** HEAD 이 커밋(작업 트리 깨끗, 이슈 worktree 없음). **main** `7a2c81d0` = origin/main. main 병합 충돌 없음(`git merge-tree` 확인).
- **M1~M4 done.** M4 결과 `perf/M4_RESULT_2026-11-25.md`. 마일스톤 전체 시험 통과(Rust 4,147·단위 1,979·check-cross 다섯 대상·게이트), e2e 전량 마지막 회차 실패 5 중 4.15.1(git-not-repo again 경합)·4.15.2(term-reclaim 스냅숏 기준)를 고쳐 병합.
- **사용자 결정(2026-11-26)**: 권장안대로 — 4.15.1·.2 고침, 4.15.3~.5 는 다음에 조사(todo), 그 뒤 main 일반 병합 → push.
- **남은 일**: main 병합·push 가 자동 모드 분류기에 막혔다 — 사용자가 직접 실행한다: `git -C /Users/dykim/personal/dongminal merge --no-ff perf-m1 -m "Merge branch 'perf-m1'" && git -C /Users/dykim/personal/dongminal push origin main`. 운영 바이너리는 다시 빌드하지 않는다.
- 다음 이슈: 4.15.3 git-job-indicator 새로고침 뒤 kind 빔, 4.15.4 git-hunk TC-UIP-14, 4.15.5 editor-lsp-nav 브랜치 전환 진단(모두 M4 이전부터 실패).
- 교훈: 같은 `OTTER_E2E_RUN` 폴더를 다시 쓰면 워커 홈 설정이 남아 다음 실행을 오염시킨다 — 실패를 가를 때는 빈 폴더. e2e 전량은 마일스톤마다 돌린다(M2·M3 에서 안 돌려 낡은 시험 약 30건이 쌓였다). edges-settings 오프셋은 실제 3300(상한 65535). 하위 에이전트 `git add/commit` 은 자동 모드 분류기에 막힌다 — 조정자가 커밋. 병렬 worktree 다섯이 `rust/target` 을 키워 디스크가 가득 찼다 — cross-target clippy 는 조정자가 한 번.
- 아직 묻지 않은 것: vendor 스크립트·CSS gzip 전송(3.4.2), 2.4 작은 차이 5건 수용 여부, "코드와 어긋난 문서"(4.14 진행 기록 23행 + 4.15.2 목록).

## 사용자 지시 (2026-11-24)

- 이슈는 이 폴더의 문서로 관리하며 진행한다(Rust 포팅과 같은 방식).
- 전체 시험(Rust workspace·e2e 전량)은 마일스톤 끝에서 한 번만 돌린다. 이슈 중에는 바꾼 부분만.
- 빠를수록 좋다. 병렬로 할 수 있는 이슈는 병렬로 맡긴다.
- perf 브랜치 커밋은 허락됐다. main 병합과 push 는 사용자 확인 뒤.

## 사용자 결정 (SRS §1.4 에 원본)

- D-9 상태용 주기 GET 전부 제거 · D-10 토픽별 변화량/전체 값 · D-11 표준 압축, WebSocket 구현 하나 · D-12 모든 연결 압축, sockudo-ws · D-13 alacritty_terminal · D-14 줄 저장소.
- agentsPollInterval·gitConsoleInterval·gitStatusInterval·gitReposInterval 설정 삭제, Git Console·편집기 틱은 토픽으로.
- 전체 시험의 e2e 포트 기준은 62200 이하(edges-settings 의 CLOSED_OFFSET).

## 운영 메모

- 조정자 탭 uuid: `027320fb-3c82-4f5b-8ffa-7d3656903fee`.
- worktree 마다 `rust/target` 을 APFS 복제(`cp -cR`)로 시작하면 처음부터 빌드하지 않는다. 병합한 이슈의 worktree 와 target 은 지운다(디스크 여유 35 GB 안팎).
- `node_modules` 는 main 체크아웃의 것을 링크한다(공용 `info/exclude` 에 `/node_modules`·`/otterminal-*`).
- 병렬 e2e 는 `OTTER_E2E_RUN` 을 나누고 `OTTER_E2E_KEEP_PEERS=1` 을 붙인다.
