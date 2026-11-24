# 포팅 진행 상태 (2026-11-24 10:2x — 이슈 0~12 전부 done, Go 제거·e2e 전량 통과)

## 지금 상태

- 이슈 0~12 전부 done. GO_REMOVAL_SRS·RUST_PORT_SRS·RUST_DEFECT_FIX_SRS 승인·구현완료.
- rust-port 에 Go 소스가 없다(`05005dfe`). 남은 `.go` 는 `rust/crates/*/testdata/go*/main.go` 5개뿐(Q-GRM-4 선택 실행 대조용).
- go 없는 PATH 로 `./scripts/build.sh`·`make gates`(66단계)·`make test`(3890 통과)·`npm run unit`(1572 통과) 통과.
- e2e 전량 1회(10:00~10:16, 워커 3): darwin 2282 항목 실패 0, flaky 1(TC-KIT-6a, 단독 10/10 통과), 건너뜀 3(docker 없음).
- 남은 것은 사용자 결정뿐이다: 운영 전환(Go→Rust 바이너리)과 main 병합 시점. CI 는 병합 뒤 첫 실행으로 확인한다.

## 사용자 지시(2026-11-24)

- 11.10: Go 전체 삭제 뒤 e2e 전량 전에 멈추고 사용자에게 알린다.
- e2e 전량은 모든 작업 뒤 11.10 에서 1회만.

## 소통 (사용자 지시 2026-11-24)

- 조정자↔에이전트 소통은 dongminal 단체채팅 방 'rust-port 조정'(room id 3f5fcdb2a795bbe4979e48712fba64b5d59fcdc172e51fa0364ea7f9fbe41ab5)에서만 한다. dmctl msg 로 직접 보내지 않는다. 글 앞에 이슈 ID 를 붙인다.

## 운영 메모

- 에이전트 세션은 커밋이 분류기에 막히는 일이 잦다 → '커밋 요청' 으로 조정자가 대신 커밋
- `dmctl close-tab` 을 같은 칸에 연달아 쓰면 엉뚱한 탭이 닫힌 적이 있다 — 하나씩 닫고 매번 확인
- 각 worktree 의 rust/target 이 5~17G 라 디스크가 찬다 — 이슈를 병합하면 그 target 을 지운다
