# Git 창 설계 계약 (`GIT_M*_STEP*_CONTRACT.md`)

`../GIT_SRS.md` §6 의 21단계를 구현 계약으로 전개한 문서들이다. **각 단계 착수 시
해당 계약 문서를 단일 진실 공급원으로 삼는다** — SRS 를 다시 해석하지 않는다.
계약과 다르게 가야 할 근거가 생기면 계약 문서를 먼저 고친다.

| 문서 | 단계 | 묶음 | FR |
|---|:--:|---|---|
| `GIT_M1_STEP1_CONTRACT.md` | 1 | A | 1~8 |
| `GIT_M1_STEP2_CONTRACT.md` | 2 | B·C 서버 | 9~24, 60~63 |
| `GIT_M1_STEP3_CONTRACT.md` | 3 | D | 25~31 |
| `GIT_M1_STEP4_CONTRACT.md` | 4 | B 클라 | 13~17 |
| `GIT_M1_STEP56_CONTRACT.md` | 5·6 | E, C 클라 | 18~24, 32~42 |
| `GIT_M1_STEP7_CONTRACT.md` | 7 | F | 43~56 |
| `GIT_M1_STEP8_CONTRACT.md` | 8 | G | 57~59 |
| `GIT_M2_STEP9_CONTRACT.md` | 9 | J | 86~97 |
| `GIT_M2_STEP1011_CONTRACT.md` | 10·11 | H·I | 64~85 |
| `GIT_M3_STEP1213_CONTRACT.md` | 12·13 | K | 98~112 |
| `GIT_M4_STEP1417_CONTRACT.md` | 14~17 | L·M | 113~146 |
| `GIT_M5_STEP1821_CONTRACT.md` | 18~21 | N·O·P | 147~178 |

## 테스트 저장소는 픽스처 스크립트를 쓴다

손으로 만들기 번거로운 저장소 상태는 **`scripts/git_fixture.sh` 가 이미 만든다.**
테스트 안에서 `git init` + 여러 단계를 되풀이하지 말고 이것을 부른다 (2.3초).

```bash
scripts/git_fixture.sh /tmp/dm-git-fixtures        # 만든다
scripts/git_fixture.sh --clean /tmp/dm-git-fixtures # 지운다
```

| 디렉터리 | 상태 | 쓸 곳 |
|---|---|---|
| `empty-no-commit` | 커밋 0개 + staged 1개 (HEAD 없음) | V31 (초기 커밋 전 unstage) |
| `basic` | 3그룹 + rename + 유니코드·공백 경로 + indeterminate | V9, V23, V32 |
| `detached` | detached HEAD | V22, FR-GIT-87 |
| `conflict` | unmerged 1개 + `MERGE_HEAD` (머지 진행 중) | V23, V36 |
| `no-identity` | `user.name`/`user.email` 미설정 | V36 (preflight 차단) |
| `blobs` | 바이너리 + LFS 포인터 + 1MB 초과 텍스트 | V10 |
| `many-files` | 변경 파일 2000개 | V25 (렌더 성능) |
| `many-commits` | 10,000 커밋 + 머지 50개 + 태그 2개 | V46, V48 |
| `with-remote` | bare `origin` + ahead 1 + upstream 없는 브랜치 | V40, V41 |
| `stashes` | stash 2개 + 현재 변경 1개 | V56, V58 |
| `remote.git` | 위 `with-remote` 의 bare 원격 | V40 |

각 저장소는 `user.name`/`user.email`/`commit.gpgsign` 을 자기 안에 박아 두므로
**사용자의 전역 설정에 흔들리지 않는다** (`no-identity` 는 의도적으로 지웠다).

e2e 에서 쓸 때는 `test.beforeAll` 에서 한 번 만들고 `test.afterAll` 에서 지운다.
`e2e/fixtures.ts` 의 `resetWorkspace` 가 매 테스트마다 `git.pinned` 를 지우므로
**핀은 각 테스트가 스스로 만든다.**

## 구현 상태

1~20단계는 구현이 끝났고, 이 계약 문서들은 **살아 있는 코드의 설계 근거**이므로
`archive/` 로 옮기지 않았다. 트랙이 닫히면(21단계 완료 + 미구현 2건 해소) 그때
옮긴다.

아직 끝나지 않은 것은 [`../GIT_REMAINING.md`](../GIT_REMAINING.md) 에 있다 —
미구현 P0 2건(FR-GIT-141·144), 21단계 수동 검증, 알려진 간헐 실패.

## 확정된 결정

열린 결정 O1~O14 와 요구사항 해석 I1~I6 은 `../GIT_SRS.md` §7·§7.1 에 있다.
각 계약 문서의 §0 이 그 마일스톤 해당분을 다시 적는다.

## 검증 게이트

```bash
go build ./... && go vet ./... && go test ./... -race -count=1 && gofmt -l . | grep -v node_modules
npm run e2e          # Playwright. 포트 58147 을 쓰므로 **동시에 두 번 돌릴 수 없다**
```

- `go test ./... -race` 는 `00f0aee` 부터 전부 통과한다. 그 전에는 테스트 더블의
  데이터 레이스 2건(`sysstat/fakeReader`, `server/fakeToolIO`)이 항상 실패했다 —
  기준선이 깨져 있던 것이고 지금은 아니다.
- Playwright 기준선: **187** (Git 작업 착수 시점) → 커밋마다 늘어난다. 각 단계의
  커밋 메시지에 그때의 총 통과 수를 적는다.
- `playwright.config.ts` 는 고정 포트 58147 + `reuseExistingServer: false` 다.
  **여러 에이전트가 동시에 e2e 를 돌리면 서버 기동이 충돌한다.** 병렬로 일할 때는
  e2e 실행 권한을 한 번에 하나에게만 준다.

### 전체 실행의 부하 민감성 (알려진 간헐 실패)

**전체 348개 실행에서 0~1건이 간헐적으로 실패한다.** 관측된 것:

| 테스트 | 성질 |
|---|---|
| `background-restore-at` TC-BGR-9 | **기존 테스트.** "창이 비는 과도 상태를 명중" 시키려는 것이므로 본질적으로 타이밍 의존이다 (오류 문구가 그것을 말한다) |
| `git-stash` S2·S3 | 우클릭 → 메뉴 항목 클릭 → git 상태 확인. 부하가 걸리면 기본 5초 단정이 흔들린다 |

확인한 것:
- 단독 반복 10/10 통과, `e2e/git-*.spec.ts` 161개 전체 통과 — **제품 결함이 아니다**
- 실패하는 테스트가 실행마다 다르다 (특정 테스트의 논리 문제가 아니라 부하)
- `e2e/fixtures.ts` 머리말이 이 성질을 이미 설명한다 — 고아 도구가 쌓이면 WS open 이
  늦어지고 대기가 타임아웃한다

**Stash 뷰의 폴링은 목록을 다시 그리지 않는다**(`paintStatus` 는 바만 갱신) — 열린
컨텍스트 메뉴가 폴링으로 닫히는 경합은 없음을 코드로 확인했다.

권고: 전체 실행은 `npx playwright test --retries=1` 로 돌린다. 진짜 실패는 두 번
모두 실패하므로 게이트의 뜻이 약해지지 않는다. (`playwright.config.ts` 의 로컬
`retries` 를 1로 올리는 것은 게이트의 뜻을 바꾸는 결정이므로 사용자 판단에 맡긴다.)

## e2e import 규약

`e2e/*.spec.ts` 는 Node 모듈을 **bare 이름**으로 import 한다 (`from 'fs'`,
`'path'`, `'os'`, `'child_process'`). 이 저장소에 `@types/node` 가 없어
`node:` 접두 형태는 TS 진단 오류를 낸다. 선례: `e2e/skill-contract.spec.ts`.
