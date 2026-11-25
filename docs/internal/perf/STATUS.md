# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-25 23:15, 조정 세션)

- **perf-m1** HEAD `323916eb` 근처(작업 트리 깨끗, 이슈 worktree 없음). **main** `7a2c81d0` 그대로(push 안 함). 운영 바이너리는 다시 빌드하지 않는다.
- **M1~M4 구현 모두 done.** M4 결과(`perf/M4_RESULT_2026-11-25.md`): 유휴 외부 프로세스 0(세 단계), 유휴 CPU 평균 0.1% 이하(18구간 중 1구간 0.116%), 깨어남(CSW) 서버 13~16 → 3~9/초, 데몬 9~13 → 0.5~6/초.
- **마일스톤 전체 시험**(m4test, 병합됨): Rust workspace 4,147 통과·0 실패, fmt·clippy·check-cross 다섯 대상 통과, 단위 1,979 통과, 게이트 통과. e2e 전량 2,330건 → 마지막 회차 실패 5(아래), flaky 1(repo-tab M3). 낡은 시험 약 30건(M3 지연 묶음 이후 숨어 있던 것)과 `moveTabTo` 응답 회귀(3.4.12.10)를 고쳤다.
- **남은 e2e 실패 — 사용자 결정 대기**:
  1. `term-reclaim` TC-M10-2: 2.5(데몬 스냅숏 재생) 뒤로 전제가 깨짐(M4 이전 판에서도 실패). 권장: 시험을 스냅숏 기준으로 다시 쓰거나 거둠 — FR-M10-2 유지 여부 결정.
  2. `git-job-indicator` 새로고침 뒤 다시 붙기: kind 글자가 빈다(M4 이전부터, 채널 `git.jobs` 재부착 경로 의심). 조사 필요.
  3. `git-hunk` TC-UIP-14: `paintedSpan(8)` null(M4 이전부터). 조사 필요.
  4. `editor-lsp-nav` 브랜치 바꾸면 진단 따라옴: 60초 안에 진단 없음(M4 이전부터). 조사 필요.
  5. `git-not-repo` F-6.2: git-menu 뒤에 돌면 재현되는 경합 — `GitPoll.collect` 의 `_again` 이 not_repo 뒤에도 status 를 한 번 더 보냄. 권장: not_repo 이면 again 을 버리고 다음 `git:<root>` 신호에 맡김.
- 그다음: main 일반 병합 → push(**사용자 확인 뒤**).
- 교훈: 같은 `OTTER_E2E_RUN` 폴더를 다시 쓰면 워커 홈 설정이 남아 다음 실행을 오염시킨다 — 실패를 가를 때는 빈 폴더. e2e 전량을 M2·M3 끝에서 안 돌려 낡은 시험이 쌓였다 — 마일스톤마다 돌린다. edges-settings 오프셋은 실제 3300(상한은 65535, "62200 이하" 문구는 틀림). 하위 에이전트 `git add/commit` 은 자동 모드 분류기에 막힌다 — 조정자가 커밋.
- 아직 묻지 않은 것: vendor 스크립트·CSS gzip 전송(3.4.2), 2.4 작은 차이 5건 수용 여부, 각 이슈 진행 기록의 "코드와 어긋난 문서"(4.14 진행 기록에 23행 표).

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
