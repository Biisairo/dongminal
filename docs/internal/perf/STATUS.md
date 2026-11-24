# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-24 저녁)

- M1 코드·측정 끝: 1.1~1.11·1.13·1.14 done. 측정 결과 SRS §7.1 (유휴 요청 81.8→0/분, 유휴 메인 스레드 0.7→0.29%).
- **1.16 ready — 다음에 할 첫 일.** 1.15 병합 뒤 프론트 단위 9건 실패(`GIT_STATUS_RETRY_MS` 를 정의한 `constants-git-detect.js` 가 i18n `t()` 를 부르는데 시험이 싣지 않음)와 e2e `editor-fs-watch` V-ELR-34(1.14 가 지운 대체 폴링). 1.15 는 review 로 되돌렸다 — 1.16 이 끝나면 함께 done.
- 1.16 뒤: 통합 브랜치에서 프론트 단위 전체·관련 e2e 확인 → **main 병합(사용자 승인됨, 2026-11-24 "테스트 문제 없으면 main 병합까지")**. main 체크아웃(`/Users/dykim/personal/dongminal`)에서 `git merge --ff-only perf-m1` 이 되는지 먼저 본다. 운영 바이너리는 다시 빌드하지 않는다. push 는 따로 확인.
- 1.12 문서 정합은 사용자 확인 대기(main 병합 때 함께 여쭙는다). 각 이슈 진행 기록의 "코드와 어긋난 문서" 목록을 모은다.
- M2: 2.1 done(D-13 alacritty_terminal, D-14 줄 저장소). 다음은 2 를 하위 이슈로 나누는 설계(데몬 화면 상태·줄 저장소·스냅숏 op·구독/해지·위로 스크롤 받기) — 설계는 사용자 확인 뒤 시험·구현.
- M3: 3.1 done(`perf/SPA_PROFILE_2026-11-24.md` §5 에 3.2~3.7 제안). 미확인: git 기록 화면(커밋 401개)을 열면 트레이스가 4분 넘게 끝나지 않음 — 메인 스레드 멈춤 가능성, 3.2 에서 먼저 재현. `openGitWindow` 에 심볼릭 링크 경로를 주면 창을 못 찾고 null(범위 밖 결함).
- 정리할 것: 남은 worktree `dongminal-pf/*` 없음. 측정 바이너리 `/private/tmp/otter-perf/`.

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
