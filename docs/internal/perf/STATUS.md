# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-25 19:05, 조정 세션)

- **perf-m1** HEAD `c6275919` 근처(작업 트리 깨끗, 이슈 worktree 없음). **main** `7a2c81d0` 그대로(push 안 함). 운영 바이너리는 다시 빌드하지 않는다.
- **M1·M2·M3**: 닫힘.
- **M4**: 4.1~4.13 done(이 세션에 4.4~4.13 병합). **남은 것: 4.14**(재측정은 4.4 도구 `scripts/perf/scenario.mjs --bin`·`proc-metrics.mjs`, 기준선 `perf/M4_BASELINE_2026-11-25.md` 와 비교 · 문서 정합: SRS §7.5, D-17 닫음(Q11), CHANNEL_PROTOCOL §10.5) → **마일스톤 전체 시험**(Rust workspace + e2e 전량 + `check-cross.sh` — 이 세션은 디스크 때문에 check-cross 를 에이전트에서 뺐다, 한 번도 안 돌았다).
- 4.14 에 넘길 것:
  - 4.9: Git 화면 유휴에도 저장소마다 `git rev-parse` 가 30초에 한 번(`domain/git/store` `DEFAULT_GIT_DIRS_TTL`) — "idle-git 외부 프로세스 0" 목표에 걸린다. 사용자 결정 필요.
  - 4.9 는 새 crate 대신 CoreServices FSEvents 를 `extern "C"` 로 직접 불렀다(unsafe 약 120줄, fswatch 가 notify `macos_kqueue` 를 켜서). Linux inotify 경로는 미검증 → check-cross.
  - 4.8: 데몬이 판정하지 않는 동안(옛 데몬·끊김) 서버 혼자 하던 L2 유휴 판정은 이제 없다(동작 변경 기록됨).
  - 4.7: 이름은 `proc_name` 대신 argv[0](`KERN_PROCARGS2`) — claude 탭 이름 유지. non-macOS BSD 는 컴파일 안 됨.
  - 4.4: 설계 §0.1 "유휴에도 2초마다 ps" 는 전경이 셸이 아닐 때만 맞다. top 은 `csw` 열을 더해 잰다.
  - 각 이슈 진행 기록의 "코드와 어긋난 문서" 목록(고치지 않음).
- 알려진 기존 e2e 실패: `event-timer-hub-contract` T-5·6·7·7b(4.12 에서도 재현, `git-poll.js:47` `GIT_STATUS_RETRY_MS` 미정의), V-LAY-1·1b.
- 교훈(이번 세션): worktree 다섯이 동시에 `rust/target` 을 키워 디스크가 가득 찼다(ENOSPC) — 병렬 수를 줄이거나 cross-target clippy(`check-cross.sh`)를 에이전트에서 빼고 조정자가 한 번 돌린다. 하위 에이전트의 `git add/commit` 은 자동 모드 분류기에 막힌다 — 메시지 파일을 받아 조정자가 커밋한다(병합 충돌도 `--no-commit` 으로 풀게 하고 조정자가 커밋).
- 사용량 규칙: 5시간 70% 에서 멈춤. 아직 묻지 않은 것: vendor 스크립트·CSS gzip 전송(3.4.2), 2.4 작은 차이 5건 수용 여부.

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
