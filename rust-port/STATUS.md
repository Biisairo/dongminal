# 포팅 진행 상태 (2026-11-23 일시 정지)

사용자 지시로 토큰 소모를 줄이려고 잠시 멈췄다. 재개할 때는 이 문서와 `rust-port/tree.sh` 부터 본다.

## 끝난 것 (rust-port 에 병합)

0.1·0.2·0.3, 1.1·1.2·1.3·1.4(1.4.1~1.4.6)·1.5, 4.1.1, 7.1

## 멈춘 자리 (브랜치에 wip 커밋, 이슈 진행 기록에 다음 할 일)

| 이슈 | 브랜치@커밋 | worktree | 남은 것 |
|---|---|---|---|
| 1.6 Go 형식 HTTP 클라이언트 오류 | rp/1.6 | dongminal-rust/1.3 | 처음부터 (담당 탭 유실) |
| 2.1 에이전트 어댑터·레코드·런타임 | rp/2.1@5b7f0eff | dongminal-rust/2.1 | 코드 미착수, 설계 메모만. statusline 타입에 Deserialize 없음 |
| 2.2.1 와이어·순수 판정 | rp/2.2@f7235a80 | dongminal-rust/2.2 | chatwire 완료, toolhub 와이어 타입·toolipc 남음. 이어서 2.2.2·2.2.3 |
| 2.3 간선 기초 | rp/2.3@57e043b4 | dongminal-rust/2.3 | 인계 문서 `rust/crates/shared/edge/HANDOFF-2.3.md`. 닿지 못함 문구는 1.6 뒤에 |
| 4.1.2·4.1.3 git query·store | rp/4.1 | dongminal-rust/4.1 | 4.1.2 ready |
| 4.6.1 ext | rp/4.6@05e9f6df | dongminal-rust/4.6 | fetch·install·locate·builtin 시험. ring 때문에 교차 check 막힘(8.3) |
| 4.7 telegram·fswatch | rp/4.7@cb28b7c2 | dongminal-rust/4.7 | telegram 완료(69개), fswatch 미착수 |
| 6.2 migrate·privhelper | rp/6.2@a31ae0ff | dongminal-rust/6.2 | crate 미착수, Go 결함 2건 발견(migrate null 패닉, privhelper 동시 연결 상한 없음 → FR-RSP-6·7 로 고칠 것) |

## 다음에 열리는 것

- 2.6 업데이트 확인(ready, 작음)
- 2.2 가 끝나면 2.5·3.x·5.3, 2.1 이 끝나면 4.4·6.3, 4.1 이 끝나면 4.2·4.3·5.2

## 재개 절차

1. `rust/scripts/prod-pids.sh` 로 운영 PID 를 확인한다(정지 시점: 38173 start / 58470 d).
2. 각 worktree 에서 `git merge rust-port` 로 최신을 받는다.
3. 에이전트는 맥락이 빈 새 세션으로 띄운다. 첫 지시에 이 문서의 해당 행과 이슈 파일을 준다.
4. 동시 에이전트는 8명 이하로 둔다.
