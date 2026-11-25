# M4 서버·데몬 마무리 설계 (이슈 4)

- 상태: **사용자 승인 2026-11-25**(Q1~Q12 권장안 전부). 4.4~4.14 의 설계 원본. 요구: FR-SRV-1~3, FR-CON-8, NFR-PRF-5. 결정 SRS D-58~D-63. 기준 perf-m1 `f2be6e14`. 경로는 `rust/crates/` 기준.

## 0. 발견 [확인]

1. 데몬이 유휴에도 2초마다 `ps` 를 띄운다 — **탭의 전경이 셸이 아닐 때만**이다(4.4 기준선: 전경이 셸이면 0, `sleep` 이면 60초에 17~21번. 셸이면 이름 대신 cwd 를 묻는다). `daemon/boot/src/lib.rs:183` `spawn_foreground_refresh(2s)`(`shared/toolhub/src/manager.rs:43`, `:1170-1189`, `:1274`), `platform/src/procinfo/darwin.rs:134-142`. 셸 훅 cwd 가 없으면 `lsof -d cwd` 도(`darwin.rs:123-131`, `manager.rs:1283-1307`). FR-SRV-3·NFR-PRF-5 위반.
2. `scenario.mjs` 의 `serverChildrenSpawned`(`:239-246`)는 서버 자식만, 루프 샘플로 센다 — 데몬 자식·짧은 프로세스를 놓친다. "외부 프로세스 0" 은 잰 적이 없다.
3. 문서 어긋남: CHANNEL_PROTOCOL:261(sysstat 은 늘 2초 — `serve/mod.rs:416-422`, `webserver/domain/sysstat/src/sampler.rs:8,82-104`), §10.5(gitwatch 는 대상 0 이어도 1초 — `webserver/hub/src/gitwatch/round.rs:30-51`).
4. 헛도는 주기: 서버 전경 poll 2초(`serve/mod.rs:429-434`, `hub/src/foreground.rs:33-60`, Go 데몬용 D-8), 서버 L2 스위퍼 1초(`serve/mod.rs:414`, `hub/src/attn.rs:481-484`, 임계 0 빈 틱), 데몬 유휴 판정 1초(`toolhub/src/attention.rs:13-16`, `manager.rs:1028-1046`, `ATTN_DEFAULT_IDLE_MS=0`).
5. FR-SRV-1 빈틈: 토픽 full 재전송을 채널마다 직렬화(`channel/topics.rs:124-137,270-272`, `mod.rs:291-295`), 터미널 출력 바이트를 구독자마다 복사(`toolclient/src/push.rs:167`, `channel/term.rs:533`, `outbox.rs:165-174`, `channel/mod.rs:288,293`).

## 1. 주기 작업 처리

| # | 작업 | 처리 |
|---|---|---|
| D1 | 데몬 전경 이름 2초 | 사건 기반: PTY 입출력 뒤 정착 창(상수, 기본 2초) 지나 한 번, `tcgetpgrp` pgid 같고 캐시 있으면 이름 조회 생략(Q3) |
| D2 | 데몬 유휴 판정 1초 | 사건 기반: `last_output_at + 임계` 마감까지 잠, 임계 0 이면 작업 없음 |
| D4 | 간선 mesh 1초 재다이얼·15초 ping | 사건 기반: 간선·연결 없으면 잠, ping 은 연결 있을 때만 |
| S1 | gitwatch 1초·4회차마다 `git status` | 대상 0 이면 정지. 워크트리·`.git`(common_dir 포함)은 재귀 파일 감시(macOS FSEvents) → 기존 `kick`(debounce 1초·cooldown 5초)으로 status. 감시 실패·넘침이면 회차로 물러섬(Q4). 설정 `gitWorktreeInterval` 삭제(RETIRED_KEYS), 물러섬 간격은 상수(Q5) |
| S2 | sysstat 샘플러 2초 | `stats:*` 구독 동안만. 시작 때 짧은 간격 예열 표본 둘(상수). `GET /api/stats` 는 mem·disk·boot 를 그 자리에서 재고 CPU 는 구독 중 값이 있을 때만(Q6, FR-STAT-9·11 개정) |
| S4·S5 | 서버 L2 스위퍼 빈 틱·옛 데몬 전경 poll | 제거 |
| S7 | Run 수거 15초 | 사건 기반(도구 종료 push·Run 상태 변화) + 기동·데몬 재연결 때 한 번(Q7) |
| S9 | LSP 스위퍼 2분 | 세션 있을 때만 `min(last_use)+IDLE_AFTER` 마감 |
| 남김(Q8) | 진단 60초(S6), toolclient 심장박동 15초(S10), WS ping 30초(S15), 허용 목록 재해석 60초(S8), 로그 크기 60초(S11), humancmd 도우미 30초(D5), Claude 계정 엔진(S12), 텔레그램 long-poll(S13), 판 확인 24시간(S14), `stats:` 발행(S3, 구독 중) | 이유·주기를 등록부(§3)와 CHANNEL_PROTOCOL §10.5 에 기록 |

패턴: compactor(4.1.3) 방식 — `Notify` + 가장 이른 마감 `sleep_until`, 대상 없으면 무기한 `notified()`. 각 작업에 시험용 깨어남 카운터.

## 2. 외부 프로세스 (Q2)

darwin 의 names·cwds·children·parents·parent_pid 를 libproc FFI(`libc` 의 `proc_name`·`proc_pidinfo(PROC_PIDVNODEPATHINFO)`·`proc_listchildpids`)로 읽어 외부 프로세스 0. `connection_owner_pid`·`listener_pids` 는 `lsof` 유지(요청 계기). `resolve_client_pane`(`seam/adapters/src/lib.rs:93-120`)의 조상 오르기는 `parents()` 한 번. CROSS_PLATFORM_SRS FR-XPI-3·§미결 7 개정.

## 3. 상수 (Q1, 사용자 요구: 하드코딩 금지·한곳)

새 leaf crate `rust/crates/shared/cadence` = "남는 주기 등록부". 남는 주기와 새 사건 기반 작업의 시간 값(정착 창·예열 간격·물러섬 간격 등)을 상수로, 상수마다 이유 문서 주석. 모듈 문서 표와 상수 목록이 같은지 보는 시험. 한 모듈만 쓰는 debounce 창 같은 값은 그 crate 의 기존 상수 자리. 옛 이름은 re-export.

## 4. 한 번 인코딩 (Q9)

정의: 출력 하나·발행 하나에 대해 직렬화와 프레임 본문 조립은 서버에서 한 번. 연결마다는 5바이트 머리(op·sid), permessage-deflate(연결마다 문맥, D-12), 참조 계수 나누기만. 변경: 토픽 full 을 `(topic, seq)` 당 `Arc<Item>` 캐시, `OutChunk.data` → `bytes::Bytes`, 쓰기 `Message::Text` → `Bytes::from_owner(Arc<str>)`. 정의를 CHANNEL_PROTOCOL 에 기록.

## 5. 그 밖

- Q10: `otter-webserver-sse` → `otter-webserver-envelope`(디렉터리 `webserver/envelope`), `attach_sse_leases` 이름 정리. 의존 crate 3(hub·wsentry·httpapi), 호출 8곳.
- Q11: D-17 출력 링 1 MiB 유지, §7.4 로 갈음해 닫음.
- Q12: 잠든 도구의 데몬→서버 출력 push 줄이기는 범위 밖(기록만).

## 6. 측정 (4.4·4.14)

- 외부 프로세스: 격리 인스턴스 PATH 앞에 감싸개(`ps`·`lsof`·`pgrep`·`git`·`rg`, 호출 시 `시각 PPID 이름 인자` 기록 후 진짜 exec). 단계 구간 안 PPID 가 서버·데몬인 줄 수. 목표 `idle`·`idle-closed`(페이지 닫고 60초)·`idle-git`(Git 패널·편집기 보이고 60초) 모두 0.
- 유휴 CPU `ps -o time=` 차분(0.1% 이하), 깨어남 `top -l 2 -s 30 -stats pid,cpu,idlew,csw`. IDLEW·CSW 는 누적값이라 두 표본의 차분을 쓴다. IDLEW 는 코어를 유휴에서 깨운 횟수만 세어 기계가 바쁘면 0 에 가깝다 — 비교 주 지표는 CSW(문맥 전환 수)다(4.4 에서 확인, `csw` 열 추가).

## 7. 하위 이슈

| ID | 내용 | deps |
|---|---|---|
| 4.4 | 측정 도구(외부 프로세스 감싸개·깨어남·idle-closed·idle-git)와 M4 기준선 | — |
| 4.5 | `cadence` 등록부 crate, 기존 주기 상수 옮김(동작 변경 0) | — |
| 4.6 | 데몬 전경 이름 사건 기반(D1) | 4.5 |
| 4.7 | darwin procinfo libproc, 조상 오르기 한 번(E1~E5), FR-XPI-3 개정 | — |
| 4.8 | 유휴 판정 사건 기반 + S4·S5 제거 | 4.5 |
| 4.9 | gitwatch 대상 0 정지 + 파일 감시 + 설정 삭제 | 4.5 |
| 4.10 | sysstat 구독 동안만, FR-STAT-9·11 개정 | 4.5 |
| 4.11 | S7·S9·D4 사건 기반, 남길 주기 문서화 | 4.5 |
| 4.12 | 한 번 인코딩 | — |
| 4.13 | sse crate 이름 바꾸기 | — |
| 4.14 | M4 재측정·문서 정합(SRS §7.5, D-17 닫음, CHANNEL_PROTOCOL §10.5·:261) | 4.6~4.13 |

## 8. RED 시험 (요약)

4.6 `quiet_tools_never_probe_foreground`(60초 probe 0)·`output_then_settle_probes_once`·`unchanged_pgid_skips_name_lookup`·`continuous_output_probes_at_most_once_per_window`. 4.7 주입 실행기로 `run` 호출 0, darwin 실제 대조, 조상 오르기 `parent_pid` 0·`parents` 1. 4.8 `attention_sweeper_threshold_zero_never_wakes`·`idle_deadline_fires_once`·서버 틱 생성 0. 4.9 `empty_watch_runs_no_rounds`·`first_hold_starts_rounds`·감시 사건 없으면 status 0·`worktree_event_kicks_status`·`watch_failure_falls_back_to_rounds`. 4.10 구독 없으면 Reader 0·`subscribe_starts_unsubscribe_stops`·`first_frame_has_cpu`. 4.11 `lsp_no_sessions_no_wake`·`mesh_no_edges_no_ticks`·`tool_exit_reaps_run`·`no_periodic_reap`. 4.12 `topic_full_same_seq_serialized_once`(Arc::ptr_eq)·`term_output_shared_across_subscribers`. tokio 시험은 `start_paused = true`.

## 9. 위험

D1 사건 기반(MED, 입출력 없는 전경 교체 — 탭 이름 e2e FR-TAN-7·8 재실행), libproc(MED, unsafe FFI), gitwatch 감시(MED–HIGH, 빌드 산출물 사건 폭주는 kick cooldown 이 상한, linked worktree common_dir, Linux inotify 한도 → 물러섬, 설정 삭제로 골든·e2e 변경), sysstat(LOW), 옛 데몬 경로 제거(LOW, D-8), Run 수거(MED, 끊긴 사이 놓침 → 재연결 resync), 인코딩(MED, OutChunk 공유 타입), 이름 바꾸기(LOW).
