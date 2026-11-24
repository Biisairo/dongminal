# 포팅 진행 상태 (2026-11-23 23:5x — 포팅 계획 이슈 전부 done)

진척: Go 프로덕션 102,842 줄 전부 Rust 로 옮겨 rust-port 에 병합. 이슈 트리 0~9 전부 done.
마지막 검증: 워크스페이스 전체 시험 3,825 통과·실패 0(darwin, hermetic), linux/arm64 실기 3,820 통과,
e2e 2,317 중 Rust 2,312 통과(실패 1 = V-LAY-1, Go 기준선과 같음 / 흔들림 1 = git-feedback F-9.4, Go 도 같음),
Go↔Rust 상호 운용 221 항목 같음, verify 종단간 26/26, 다섯 대상 교차 clippy·deny·audit·Go make gates 통과,
재현 빌드(다른 경로 재빌드 sha256 같음). SRS 3.7 DIFF-1~32.

## 남은 것 (사용자 결정)

- Windows 실기 검증 수단(Actions windows 러너·VM·SSH PC) — 8.3 이슈 파일에 미검증 목록
- 운영 전환(Go→Rust 바이너리 교체)과 main 병합·push 시점 (조정자는 하지 않는다)
- SRS 3.7 보안 강화·결함 수정(DIFF-1,2,7~11,13~23,26,29,31,32)을 Go 에도 고칠지
- Go 결함 보고: daemon-fingerprint.sh 의 `xargs sum`(DIFF-29), DONGMINAL_NO_UPDATE_CHECK 무시(DIFF-32), scripts/check-home-layout.sh 소켓 4개 누락
- claude 셈 `--allowedTools=mcp__dongminal` 사전 허용(Go 와 같아 그대로)
- chrono(unmaintained, RUSTSEC-2026-0543) 직접 사용 crate 3개 — 대체 여부
- 릴리즈·CI go 1.26.11 vs 기준선 1.27.2, `version` 셋째 칸 go1.27.2 표기
- linux/amd64 실기는 돌리지 않았다(에뮬레이션 비용)

## 사용자 지시(2026-11-24)

- 11.10: Go 전체 삭제 뒤 e2e 전량 전에 멈추고 사용자에게 알린다.
- e2e 전량은 모든 작업 뒤 11.10 에서 1회만.

## 소통 (사용자 지시 2026-11-24)

- 조정자↔에이전트 소통은 dongminal 단체채팅 방 'rust-port 조정'(room id 3f5fcdb2a795bbe4979e48712fba64b5d59fcdc172e51fa0364ea7f9fbe41ab5)에서만 한다. dmctl msg 로 직접 보내지 않는다. 글 앞에 이슈 ID 를 붙인다.

## 운영 메모

- 에이전트 세션은 커밋이 분류기에 막히는 일이 잦다 → '커밋 요청' 으로 조정자가 대신 커밋
- `dmctl close-tab` 을 같은 칸에 연달아 쓰면 엉뚱한 탭이 닫힌 적이 있다 — 하나씩 닫고 매번 확인
- 각 worktree 의 rust/target 이 5~17G 라 디스크가 찬다 — 이슈를 병합하면 그 target 을 지운다
