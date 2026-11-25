# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-26 08:00, 조정 세션)

- **perf-m1** 이 커밋(작업 트리 깨끗, 이슈 worktree 없음). **main** `d389123a` = origin/main(4.15.3~4.16 반영). 그 뒤 perf-m1 에 3.4.13 이 더 들어갔다(main 미반영).
- **M1~M4 모두 done.** 4.15(전체 시험 남은 e2e 실패) .1~.6 done — 모두 낡은 시험이거나 작은 틈(4.15.3 새로고침 뒤 잡 목록 넘기기는 제품 수정). 4.16 코드와 어긋난 문서 24항목 정합(고치지 않은 지난 기록·보관 문서는 4.16 진행 기록).
- 빌드 캐시는 2026-11-26 에 전부 지웠다(공용 릴리스 `otterminal-pfbase` 만 perf 루트에 있다, 329911d8 기준).
- **사용자 결정(2026-11-26)**: 2.4 작은 차이 5건 수용(2.4 진행 기록). vendor 스크립트·CSS gzip 전송 — 예, 3.4.13 done(부팅 직접 자산 791,625 → 239,285 B). 보류: Linux·Windows 실행 확인, CPU 1구간 0.116%.
- 후속 권장(미착수): repo-tab X6 가 시험 저장소에 스테이지된 x6.txt 를 남긴다 — X6 끝에서 되돌리기. 다른 패널 단위 토픽에도 "패널보다 먼저 온 full" 틈이 있는지 점검(4.15.3).
- 교훈: 같은 `OTTER_E2E_RUN` 폴더를 다시 쓰면 워커 홈 설정이 남는다 — 빈 폴더. e2e 전량은 마일스톤마다. 하위 에이전트 `git add/commit` 은 자동 모드 분류기에 막힌다 — 조정자가 커밋. 병렬 worktree 가 `rust/target` 을 키워 디스크가 찬다 — cross-target clippy 는 조정자가 한 번. 웹 자산은 릴리스 바이너리에 실린다 — 웹 제품 코드를 고친 e2e 는 새로 빌드한 바이너리로.

## 사용자 지시 (2026-11-24)

- 이슈는 이 폴더의 문서로 관리하며 진행한다(Rust 포팅과 같은 방식).
- 전체 시험(Rust workspace·e2e 전량)은 마일스톤 끝에서 한 번만 돌린다. 이슈 중에는 바꾼 부분만.
- 빠를수록 좋다. 병렬로 할 수 있는 이슈는 병렬로 맡긴다.
- perf 브랜치 커밋은 허락됐다. main 병합과 push 는 사용자 확인 뒤.

## 사용자 결정 (SRS §1.4 에 원본)

- D-9 상태용 주기 GET 전부 제거 · D-10 토픽별 변화량/전체 값 · D-11 표준 압축, WebSocket 구현 하나 · D-12 모든 연결 압축, sockudo-ws · D-13 alacritty_terminal · D-14 줄 저장소.
- agentsPollInterval·gitConsoleInterval·gitStatusInterval·gitReposInterval 설정 삭제, Git Console·편집기 틱은 토픽으로.
- e2e 워커 포트는 `E2E_PORT_BASE`(기본 60147)부터 워커마다 1씩. edges-settings 가 그 위 +3300 을 쓰므로 `포트 + 3300 ≤ 65535` 를 지킨다(이전 "62200 이하" 문구는 틀렸다 — M4 전체 시험 확인).

## 운영 메모

- 조정자 탭 uuid: `027320fb-3c82-4f5b-8ffa-7d3656903fee`.
- worktree 마다 `rust/target` 을 APFS 복제(`cp -cR`)로 시작하면 처음부터 빌드하지 않는다. 병합한 이슈의 worktree 와 target 은 지운다(디스크 여유 35 GB 안팎).
- `node_modules` 는 main 체크아웃의 것을 링크한다(공용 `info/exclude` 에 `/node_modules`·`/otterminal-*`).
- 병렬 e2e 는 `OTTER_E2E_RUN` 을 나누고 `OTTER_E2E_KEEP_PEERS=1` 을 붙인다.
