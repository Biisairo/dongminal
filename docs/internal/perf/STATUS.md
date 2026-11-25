# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-25 저녁, 조정 세션 → 다음 조정 세션)

- **perf-m1** HEAD `6ad9dfeb` 근처(작업 트리 깨끗, 이슈 worktree 없음). **main** `7a2c81d0` 그대로(push 안 함). 운영 바이너리는 다시 빌드하지 않는다.
- **M1·M2**: 닫힘. **M3**: 3.4.11·3.4.12(.1~.11) 모두 done — 부팅 JS 1,543,787 → 1,142,951 B, 요청 45 → 42, NFR-PRF-12 = 1,150,000 B(D-48), 회귀 게이트 `scripts/check-boot-bytes.mjs`(로컬만 — 사용자 결정, CI 에 넣지 않음).
- **M4**:
  - done: 4.1(데몬 메모리, NFR-PRF-10 충족 — footprint 기준, D-49~D-57, `perf/M4_MEMORY_DESIGN.md`), 4.2(생성 명령은 새 탭 색인 등록 뒤 답함), 4.3(슬롯 [1]+ 포커스 원격 명령 유실 — 라우터가 칸 신원 집합으로 판정, 시간 초과 응답에 `execClientId`).
  - **설계 승인, 구현 전**: 이슈 4 → 하위 4.4~4.14(`perf/M4_DESIGN.md`, D-58~D-63, Q1~Q12 권장안 전부). 착수 순서: 독립인 **4.4(측정 도구·기준선)·4.5(cadence 등록부)·4.7(libproc)·4.12(한 번 인코딩)·4.13(sse 이름)** 을 병렬로 → 4.5 병합 뒤 4.6·4.8·4.9·4.10·4.11 → 4.14 재측정·정합.
  - 공통 지시 파일 `/private/tmp/pfm4-brief.md`(M4 용, `<ID>` 를 이슈 번호로). /private/tmp 는 재부팅에 지워질 수 있으니 없으면 `/private/tmp/pf41-brief.md` 형식을 본떠 다시 쓴다.
- **사용자 결정(이번 세션)**: malloc 반납 지연은 그냥 둠. 전체 시험(Rust workspace + e2e 전량)은 **M4 까지 전체 끝난 뒤** 한 번. 알려진 기존 e2e 실패: `event-timer-hub-contract` T-5·6·7·7b(스펙이 index.html 개별 constants-git 태그 전제), V-LAY-1·1b(2.8.2 `.search-bar{position:relative}` 기준선 어긋남).
- 사용량 규칙: 5시간 70% 에서 멈춤(감시 루프를 건다). 시작할 때 사용자에게 다시 확인.
- 아직 묻지 않은 것: vendor 스크립트·CSS gzip 전송(3.4.2), 2.4 작은 차이 5건 수용 여부.
- 교훈: 병렬 단계는 `web/bundles.txt`·`settings-controller.js`·`harness.mjs`·`commands.rs` 에서 자주 충돌 — 하나 병합할 때마다 다음 에이전트에게 "네 worktree 에서 git merge perf-m1" 을 순서대로. 병합 뒤 `check-code-refs` 가 시험 문자열 안의 파일 이름(`boot.js` 등)을 잡은 일이 두 번 — 확인 세트에서 꼭 돌린다. `scenario.mjs` 는 이제 새 탭 등록을 기다린다(`waitKnownTab`).

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
