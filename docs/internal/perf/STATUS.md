# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-25 오후, 일시 정지 — 사용자 지시 "지금 하고있는것들만 완료하고 일시정지")

- **perf-m1**: 작업 트리 깨끗, 이슈 worktree 없음. **main** `7a2c81d0` 그대로(push 안 함). 운영 바이너리는 다시 빌드하지 않는다.
- **M1·M2**: 닫힘.
- **M3**: 3.4.11 done(문서 정합 `perf/M3_DOC_SYNC.md` 34건·Q1~Q7 권장안, 재측정 → SRS §7.2). **3.4.12 split** — 설계 원본 `perf/M3_BOOT_SCOPE.md`(사용자 승인), 결정 SRS D-43~D-48.
  - done: 3.4.12.1 needs 로더 · .2 mdlib · .3 diag · .4 search · .5 remote · .6 themes · .7 cm(+LSP) · .8 mobile(+별도 keybar) · .10 uiact·chat·터치 WebGL.
  - 단계별 단독 jsBytes: .2 −143,519 · .3 −13,833 · .4 −15,084 · .5 −9,835 · .6 −36,319 · .7 −91,577 · .8 −22,501 · .10 −20,308. **합친 실측은 아직 없다**(추정 약 1.19 MB, 시작 1,543,787 B).
  - **남은 것**: 3.4.12.9 언어 조각(deps 모두 done, 위험 MED–HIGH) → 3.4.12.11 정합·합친 재측정(`scenario.mjs --only boot`, 회마다 새 인스턴스)·NFR-PRF-12 를 마지막 실측 기준으로 확정(사용자 결정)·회귀 상한 시험. 각 이슈 진행 기록의 "설계와 다르게 한 것"·"코드와 어긋난 문서" 를 .11 에서 모은다(예: settings-code 도 cm 진입점, keybar 별도 묶음, 부팅 잔류 3파일, diag 인라인 자리, search 감소량).
  - 그 뒤 **마일스톤 전체 시험**(Rust workspace + e2e 전량, 사용자 결정: M3 끝에 한 번). 알려진 기존 실패: `event-timer-hub-contract` T-5·6·7·7b(스펙이 index.html 의 개별 constants-git 태그를 전제), V-LAY-1·1b(2.8.2 의 `.search-bar{position:relative}` 가 기준선과 어긋남).
  - 그 뒤 main 일반 병합 → push 는 사용자 확인 뒤.
- **M4**: todo.
- 사용자에게 아직 묻지 않은 것: 데몬 RSS 105~116 MB(M1 28 MB, 재측정 관찰, NFR-PRF-10 판정 밖)를 이슈로 볼지, vendor 스크립트·CSS gzip 전송(3.4.2), 2.4 작은 차이 5건 수용 여부.
- 사용량 규칙: 5시간 70% 에서 멈춘다(이번 세션 사용자 결정). 시작할 때 사용자에게 다시 확인.
- 이번 세션 교훈: 병렬 단계는 거의 모두 `web/bundles.txt`·`settings-controller.js`·`harness.mjs` 에서 충돌했다 — 하나 병합할 때마다 다음 에이전트에게 "네 worktree 에서 git merge perf-m1" 을 순서대로 시켰다(한꺼번에 시키면 같은 충돌을 두 번 푼다). `check-cross.sh` 는 cargo 가 여럿 돌면 20분을 넘긴다 — 조정자 병합 확인에서 돌린다.

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
