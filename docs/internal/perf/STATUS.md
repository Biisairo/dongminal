# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-25 아침, 조정 세션 → 다음 조정 세션)

- **조정자 탭 uuid**: 다음 세션이 `otterctl who-am-i` 로 새로 얻는다(이전 358d08c3).
- **main**: `7a2c81d0` = perf-m1 1차 병합(abbcedd6, origin push 됨) + 1.20 fd 상한 cherry-pick(push 안 함). 운영 바이너리는 다시 빌드하지 않았다(사용자가 직접).
- **M1**: 1.1~1.21 모두 done. 1.17 명령 펌프 결함 수정, 1.18 SSE 잔재 삭제, 1.19 보안 확인(우회 없음), 1.20 RLIMIT_NOFILE(Go 처럼 시작 때 올리고 자식에 원래 값), 1.21 게이트 실패 0.
- **M2**: 2.2~2.9(하위 포함) 모두 done. **2.10** 진행 중 — 문서 정합(`perf/M2_DOC_SYNC.md`, 2026-11-25 사용자 결정으로 61건 전부 코드 기준으로 고침)을 끝냈다. Rust workspace 전체 시험·e2e 전량·재측정은 아직이다.
- **M3**: 3.1~3.3·3.4.1~3.4.5·3.5.1~3.5.3·3.6.1·3.6.3·3.6.4·3.7·3.8 done. 남은 것: **3.6.2**(A안 확정, 착수 블록 /private/tmp/pf3.6.2/HANDOFF-A.md·이슈 진행 기록), **3.4.6~3.4.9** 화면 묶음(병렬, check-lazy-boundary 가 경계를 잡는다 — git 이동 시 17건 예상), **3.5.4** 브라우저 탭 숨김 규칙, 그 뒤 3.4.10(조건부)·3.4.11.
- **M4**: todo. otter-webserver-sse crate 이름 정리(사용자 결정)가 이슈 4 진행 기록에 있다.
- 통합 브랜치 perf-m1 상태: 프론트 단위 1763/1763, tsc, load-order 291, Rust 바꾼 crate lib·fmt·clippy 통과. check-css-vars 1건(2.8.3).
- 전체 시험(Rust workspace·e2e 전량)은 마일스톤 끝에서 한 번만.
- 문서 정합 대기 목록: 각 이슈 진행 기록의 "코드와 어긋난 문서"(CHANNEL_PROTOCOL §4.1·§4.2·§6·§10.2, M2_DESIGN §1~§2.9, M3_DESIGN 3.4.1·§3.6 67~74 ms, SPA_PROFILE §1·§2, EMULATOR §6·§8, TERMINAL_RESUME·TERMINAL_MODE_RESTORE, ACCESS_ALLOWLIST FR-ACL-11·12·REQUEST_GATE FR-RQG-11~13 의 /ws, EDITOR_LIVE_RELOAD FR-ELR-65, EDITOR_DIRTY_DIFF FR-EDD-50·51, CODEMIRROR_MIGRATION FR-CMR-53, EVENT_TIMER_HUB FR-SCH-15, GIT_WATCH_LEASE TC-GWL-11 등). 2.10·3.4.11 에서 사용자 확인 뒤 고친다. — **M1·M2 몫은 2.10 에서 고쳤다(`perf/M2_DOC_SYNC.md`). 남은 것은 M3 몫(3.4.11).**

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
