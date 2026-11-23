# 포팅 진행 상태 (2026-11-23 2차 정지 — 세션 사용률 80%)

재개할 때는 이 문서와 `rust-port/tree.sh` 부터 본다.

## 재개 첫 작업 (차단)

- **gocompat json DoS 수정(HIGH)**: rust-port 에 병합된 2413b5db 의 `decode.rs decode_value` 재시도 루프가 입력 경로마다 문서 전체를 다시 풀어, 스칼라 필드 null 이 N 개면 O(N×크기)다. 다시 풀 대상을 (derive 필드 목록 주소, 필드 번호)로 기억해 재시도 횟수를 코드의 필드 수로 묶는다. 시험: 원소 2만 개 `[{"n":null,"s":null},…]` 가 빠르게 풀린다. 5.3 에이전트가 원인을 안다(이슈 5.3 기록).

## 끝난 것 (rust-port 에 병합)

0.x 전부, 1.x 전부(1.1~1.6), 2.1, 2.2(2.2.1~2.2.3), 2.3, 2.4.1, 2.5, 2.6, 4.1(4.1.1~4.1.3), 4.3, 4.4, 4.6, 4.7, 5.2, 5.3, 6.2, 6.3.1, 7.1

## 멈춘 자리 (브랜치에 wip, 이슈 진행 기록에 다음 할 일)

| 이슈 | 브랜치@커밋 | worktree | 남은 것 |
|---|---|---|---|
| 2.4.2 edgerelay | rp/2.4@104f00f4 | dongminal-rust/2.3 | relay e2e 에서 TLS1.3 거절 경보 경합으로 간헐 실패(약 25회 중 2회). 부분 완화만 |
| 2.4.3 edgenode | rp/2.4 | dongminal-rust/2.3 | 미착수(2.4.1·2.4.2 뒤) |
| 4.2.1·4.2.2 git write·jobs | rp/4.2@8c7611cd | dongminal-rust/1.6 | 프로덕션 완료(시험 write 162·jobs 55 통과), Go 시험 대조·검토 남음 |
| 4.5.1~4.5.4 claudeacct | rp/4.5@82c24309 | dongminal-rust/2.1 | 4.5.1 모듈 초안 6개(lib.rs 미연결). 인계 문서 rust-port/handoff-4.5.md |
| 6.3.2 dmctl run | rp/6.3@ed0bc999 | dongminal-rust/6.3 | 구현 완료, 시험 미이식 |
| 6.3.3 edge·account·훅·chat-mcp | rp/6.3 | dongminal-rust/6.3 | 미착수 |

## 다음에 열리는 것

- 2.4 가 끝나면 3.1(채팅)·3.2(데몬 IPC) → 3.3(데몬 부팅)
- 4.2 가 끝나면 5.1(오류 판정) → 5.4(git API)
- 4.5·5.x·6.1 이 끝나면 5.5(httpapi, 가장 큼) → 7 → 8

## 재개 절차

1. `rust/scripts/prod-pids.sh` 로 운영 PID 확인(정지 시점: 38173 start / 58470 d).
2. 각 worktree 에서 `git merge rust-port`.
3. 맥락이 50% 를 넘은 에이전트는 새 세션으로 띄운다. 첫 지시에 이 문서의 해당 행과 이슈 파일을 준다.
4. 동시 에이전트는 8명 이하.
