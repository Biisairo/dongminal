# SRS: CI 게이트 — 최소 스펙

> 상태: **초안**. 로드맵 M1 (`docs/internal/production/MILESTONE_KICKOFF.md` §M1).
> 신규 제품 동작이 없다 — 검사기를 붙이는 일이므로 IEEE 29148 전체 구조를 쓰지
> 않는다. 킥오프가 요구한 넷만 적는다: **게이트 목록 · 각 게이트의 실패 조건 ·
> 예외 경로 · 원커맨드가 묶는 대상.**

---

## 1. 왜

검사기가 있어도 **돌지 않으면 없는 것과 같다.** 이 저장소가 이미 그 값을 치렀다 —
`check-seams.sh`·`check-timers.sh` 는 진작 있었는데 아무도 CI 에 걸지 않았고, 그래서
`runtime.GOOS` 가 `platform` 밖으로 샌 채 main 이 초록이었다(`verify.yml:57-60` 의
주석이 그 사건을 적어 두었다).

이후 마일스톤이 전부 이 위에서 돈다. 회귀를 사람이 아니라 CI 가 잡아야 한다.

## 2. 게이트 목록과 실패 조건

**A. Go 정적·단위** (`verify.yml`)

| # | 게이트 | 실패 조건 | 근거 |
|---|---|---|---|
| A1 | `go build ./...` | 컴파일 실패 | 기존 |
| A2 | `go vet ./...` | 보고 1건 이상 | 기존 |
| A3 | **`gofmt -l .`** | 출력 1줄 이상 | `TEST-10`. 착수 시 1건 위반 |
| A4 | **`golangci-lint run`** | 위반 1건 이상 | `TEST-9`·`DOC-7` |
| A5 | `go test -race ./...` | 실패 1건 이상 | `TEST-4` — 종전 경로가 `./internal/... ./cmd/...` 라 `./web/...` 를 건너뛰었다 |
| A6 | **`-shuffle=on`** | 순서 의존이 드러나면 실패 | `TEST-14`. `t.Parallel()` 0건/317파일 |
| A7 | **`govulncheck ./...`** | 취약점 1건 이상 | `SEC-28` |
| A8 | 커버리지 | **실패시키지 않는다** — 아티팩트만 | `TEST-12`. 문턱은 기준선이 쌓인 뒤 |

**B. 프론트·e2e 정적** (`verify.yml`)

| # | 게이트 | 실패 조건 | 근거 |
|---|---|---|---|
| B1 | **`tsc --noEmit -p e2e`** | 타입 오류 1건 이상 | `TEST-11`. `: any` 595회, Playwright 는 트랜스파일만 한다 |
| B2 | **`tsc --noEmit -p .`** (`jsconfig.json`) | `// @ts-check` 를 단 파일의 타입 오류 | `FE-5`. 35k LOC 를 한꺼번에 켜지 않는다 — 파일 단위 옵트인 |
| B3 | **`eslint`** | `no-undef`·`no-unused-vars`·`no-empty` 위반 | `FE-5`. 전역 스크립트 구조에서 오타가 런타임까지 가는 것을 막는다 |
| B4 | **`node --test`** | 순수 모듈 단위 테스트 실패 | `TEST-27`. `hunk-coords`·`timer-hub`·`lanes` |

**C. 공급망** (`verify.yml`·`release.yml`·`e2e.yml`)

| # | 게이트 | 실패 조건 | 근거 |
|---|---|---|---|
| C1 | 액션 `uses:` 를 40자 SHA 로 고정 | (게이트가 아니라 상태) 태그 참조 0건 | `SEC-29` |
| C2 | `build.sh` 에 `-trimpath` | (상태) 러너가 달라도 해시가 같다 | `SEC-30` |
| C3 | dependabot (gomod·github-actions·npm) | (자동 PR) | `SEC-28` |
| C4 | `web/vendor/VERSIONS.md` | (상태) 4종 이상의 판·해시 기록 | `SEC-32` |
| C5 | `release.yml` 의 `publish.needs` 에 e2e | e2e 실패 시 발행이 진행되지 않는다 | `G3-5` |

**D. 프로젝트 고유 게이트** (기존 4종, `verify.yml` 의 `gates` 잡)

`check-seams.sh` · `check-timers.sh` · `check-gitwrite.sh` · `check-cross.sh`.
**재작성하지 않는다** — 감사가 양호로 판정했다. 원커맨드에 묶기만 한다 (§4).

## 3. 예외 경로 (근거 필수)

| 예외 | 왜 |
|---|---|
| **A8 커버리지에 문턱이 없다** | 지금 문턱을 걸면 그 숫자가 근거 없는 값이 된다. `internal/ctl/cli` 31.5%·`cmd/dongminal` 0% 처럼 낮은 자리가 실재하고 그것을 올리는 것은 M8 의 일이다. 여기서는 `-coverprofile` 을 아티팩트로 남겨 **기준선을 쌓기 시작**한다 |
| **B2 가 `checkJs` 를 전역으로 켜지 않는다** | 35,120 LOC 에 JSDoc 9건뿐이라 전역으로 켜면 수천 건이 나오고, 그러면 아무도 보지 않는 게이트가 된다. `// @ts-check` 를 단 파일만 검사하고 파일을 늘려 간다 |
| **B3 의 규칙이 셋뿐** | 스타일 규칙을 넣으면 35k LOC 가 한꺼번에 빨개진다. 셋은 전부 **결함 탐지**이지 취향이 아니다 |
| **`flaky > 0` 을 실패로 올리지 않는다** | 제품 쪽 계통 결함이 남아 있다(`11-git-polling.md §5` 가 flaky 9건을 근본 원인에 매핑했다). 지금 올리면 이후 모든 마일스톤의 CI 가 빨갛다. 여기서는 **수를 잡 요약에 드러내고 기준선(4)을 기록**하는 데까지. 승격은 M6 의 완료 조건 |
| **e2e 샤드 수를 바꾸지 않는다** | §5 |
| **A5 가 `-race` 를 두 OS 에서만 돈다** | darwin 은 `release.yml` 의 게이트가 세 OS 로 돈다. 매 푸시에 macOS 러너를 더하는 값은 `TEST-13` 이 제기했으나, `e2e.yml:14-17` D-7 의 판단(개발 호스트가 darwin 이라 그 자리에서 돈다)이 단위 테스트에도 그대로 유효하다 — **다만 `make gates` 가 로컬에서 그것을 강제한다**(§4) |

## 4. 원커맨드가 묶는 대상

`make gates` — 커밋 전에 로컬에서 도는 한 명령이다 (`G8-3`).

```
gofmt -l .            (A3)
go vet ./...          (A2)
go build ./...        (A1)
scripts/check-seams.sh      ┐
scripts/check-timers.sh     │ 기존 4종 (D)
scripts/check-gitwrite.sh   │ 재작성하지 않는다
scripts/check-cross.sh      ┘
```

- `make test` 는 `go test -race -shuffle=on ./...` (A5·A6).
- `make lint` 는 `golangci-lint run` + `eslint` (A4·B3) — 도구가 없으면 건너뛰되
  **건너뛴 사실을 말한다.** 조용히 통과하면 없는 것과 같다.
- pre-commit 훅은 `.githooks/pre-commit` 에 두고 `git config core.hooksPath .githooks`
  로 켠다. **강제하지 않는다** — 훅을 저장소가 켜면 `--no-verify` 를 모르는 사람이
  커밋을 못 하는 상태가 되고, 그 비용이 이 게이트의 값보다 크다. 안내는 README 의
  "고치려는 분께" 절과 `make help` 에 둔다.

## 5. e2e 샤드 수 — 재검토 결과: **8 을 유지한다**

`e2e.yml:45-49` 는 샤드 8 의 근거를 "Windows 실측, 4샤드로는 한 샤드가 상한 안에
끝나지 않았다" 로 적었고, `:37-40` 은 그 전제를 "`workers: 1` · `fullyParallel: false`
이고 그것은 바꿀 수 없다" 로 적었다. **그 전제는 이후 바뀌었다** —
`playwright.config.ts:39-44` 의 `workerCount()` 가 2~4 를 준다(`E2E_PARALLEL_SRS`).

그러므로 산술만 보면 샤드를 4 로 줄여도 샤드당 벽시계는 옛 8샤드와 비슷하고, 러너
셋업(`npm ci`·브라우저 설치·`go build`)을 16회에서 8회로 줄인다.

**그런데 바꾸지 않는다.** 샤드 8 과 상한 60분은 **러너 실측에서 나온 값**이고,
줄이는 근거는 산술뿐이다. 틀리면 Windows 샤드가 상한에 걸려 CI 가 빨개지는데,
그것은 이 마일스톤이 만들려는 것과 정반대다. 실측 없이 바꾸는 것은 게이트를
세우는 일이 아니라 거는 일이다.

**대신 이 마일스톤이 하는 것**: `e2e.yml` 의 어긋난 주석을 사실로 고친다
(`TEST-15`) — `workers: 1`·`fullyParallel: false`·`retries: 2` 세 서술이 각각
`workerCount()` 2~4 · `fullyParallel: false`(이건 맞다) · `retries: 1` 과 다르다.
샤드 수 실험은 근거와 함께 M6 으로 넘긴다.

## 6. git 쓰기 계열이 CI 에서 한 번은 돈다

`fetch`·`pull`·`push` 가 CI 에서 한 번도 돌지 않는다(`09` 비목표 5).
`E2E_UNIFICATION_SRS §6-4` 가 "네트워크와 자격증명이 필요하다" 로 별도 트랙에 뒀는데,
**로컬 bare 저장소를 원격으로 세우면 둘 다 필요 없다.**

`verify.yml` 에 잡 하나를 세운다: bare 저장소를 만들고 그것을 `origin` 으로 붙인 뒤
`push` → 다른 clone 에서 `commit`·`push` → 첫 저장소에서 `fetch`·`pull`. Go 의
`domain/git/write` 경로를 지나는 것이 목적이므로 `dongminal` 의 종단을 쓴다.

## 7. Definition of Done

킥오프 M1 §4 의 목록을 그대로 따른다. 이 문서는 그 목록의 **근거**이지 대체가 아니다.
