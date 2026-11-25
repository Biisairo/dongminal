# 최적화 진행 상태 (2026-11-24)

## 지금 상태 (2026-11-25 낮, 조정 세션 → 다음 조정 세션)

- **조정자 탭 uuid**: 다음 세션이 `otterctl who-am-i` 로 새로 얻는다(이전 673c9b37).
- **main**: `7a2c81d0` 그대로(perf-m1 1차 병합 + 1.20 cherry-pick, push 안 함). 운영 바이너리는 다시 빌드하지 않는다.
- **M1**: 1.1~1.21 모두 done.
- **M2: 닫힘.** 2.2~2.10 모두 done. 2.10 은 사용자 지시로 **문서 정합만** 했다(`perf/M2_DOC_SYNC.md` 61건 전부 코드 기준, 커밋 cee4b45c·c7824299·9bd9ed65). Rust workspace 전체 시험·e2e 전량·재측정·SRS §7 M2 표는 하지 않았다 — 마일스톤 전체 시험은 다음에 M3 와 함께 정한다.
  - 이번 세션 병합: 2.8.1 read-screen(`screentext` IPC), 2.8.3 검색 기준점, 2.8.4 검색 목록 게이트, 2.6 흐름 제어 스냅숏, 2.5.1 스냅숏 행 수 = termScrollback.
- **M3**: 남은 것 **3.4.11**(M3 재측정·문서 정합) · **3.4.12**(부팅 코드 범위 재설계, todo — 설계는 사용자 확인 뒤). 나머지 모두 done.
  - 이번 세션 병합: 3.5.4 탭 숨김(e2e 는 visibilitychange 흉내 — 사용자 수용), 3.6.2 부팅 GPU 지연(A안, **부팅 때만** — 사용자 결정), 3.4.6 git·3.4.7 editor·3.4.8 docrender·3.4.9.1 run·chat·3.4.9.2 settings 묶음(D-41), 3.4.10 주석·줄 끝 공백 걷기(A안, D-42, NFR-PRF-12 → 1.55 MB, 부팅 JS 2,505,579 → 1,543,764 B — 그 이상은 3.4.12).
  - 구현 선택(조정자): 공용 CodeMirror 층·style-editor*.css·constants-editor.js 는 boot(3.4.7), markdown-it·DOMPurify 는 boot(3.4.8), D-31 유지(git 첫 열기 remote 0.35초).
- **M4**: todo.
- 통합 브랜치 perf-m1: 프론트 단위 1801/1801, tsc, eslint web/js 0건, scripts/check-* 전부 통과(check-api-docs 포함), Rust 바꾼 crate lib·fmt·clippy 통과.
- 문서 정합 대기: M3 몫만 남음(각 3.* 이슈 진행 기록의 "코드와 어긋난 문서" — M3_DESIGN §3.4 묶음 표·크기, §3.6 `gpu:<id>`·기준선, D-M3-4·D-M3-7, bundles.txt 머리말, FE_MODULE_BOUNDARY §7.1 CSS 기준선 등, M2_DOC_SYNC §4 의 M3 겹침). 3.4.11 에서 사용자 확인 뒤.
- 아직 묻지 않은 것: vendor 스크립트·CSS gzip 전송(3.4.2 발견), 2.4 의 작은 차이 5건 수용 여부, 마일스톤 전체 시험(Rust workspace·e2e 전량)을 언제 돌릴지.

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
