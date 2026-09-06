# SRS: 브라우저 종단간은 개발 호스트가 아닌 OS 에서 돈다 (IEEE 29148 준수)

| 항목 | 값 |
|---|---|
| 문서 | CI_E2E_MATRIX_SRS |
| 선행 | CROSS_PLATFORM_SRS · E2E_UNIFICATION_SRS · E2E_QUIESCENCE_SRS |
| 상태 | 구현 중 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말은 한 줄이다.

> **"ci 는 모든 os 에 대해 e2e 를 해야한다"**

그리고 그 뒤에 한 줄이 더 왔다.

> **"ci e2e 에 서 맥은 제외하자, 로컬에서도 하니까"**

지금 브라우저 종단간(Playwright)은 **ubuntu 하나**에서, 그것도 **사람이 부를 때와
태그를 밀 때만** 돈다 (`e2e.yml`). 그 워크플로우의 머리글이 스스로 그 한계를 적어
두었다 — "이 스위트는 지금까지 개발 호스트(macOS·zsh)에서만 돌았고 리눅스에서의
통과율을 아직 모른다".

이 문서는 그 자리를 **매 푸시**로 옮기고, 도는 OS 를 **개발 호스트가 아닌 것**으로
정한다 — ubuntu 와 windows 다 (D-7).

### 1.2 범위 (Scope)

**포함**

- `e2e.yml` 의 러너 매트릭스와 방아쇠, 산출물 이름
- 스펙·픽스처의 OS 이식성: 임시 디렉터리, 픽스처 스크립트 호출, 셸에 타이핑하는 명령
- 세 러너 공통의 전제(git 기본값·브라우저·빌드 예열)

**비포함** — §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **브라우저 종단간** | `playwright test` — 실제 브라우저가 실제 서버를 조작한다 (`e2e/*.spec.ts`, 1,257항목) |
| **종단간(verify)** | `dongminal verify` — 브라우저 없이 서버·데몬·PTY 를 훑는 Go 한 벌 (`verify.yml`) |
| **러너** | GitHub Actions 의 `runs-on` 호스트. `ubuntu-latest` · `windows-latest` |
| **개발 호스트** | 이 저장소를 사람이 손으로 돌리는 자리. macOS 다 (CROSS_PLATFORM_SRS R-1) |
| **샤드** | `--shard=n/8`. 러너를 나눠 스위트를 여덟으로 가른다 |

### 1.4 참조 (References)

- [`./CROSS_PLATFORM_SRS.md`](./CROSS_PLATFORM_SRS.md) — R-1(개발 호스트가 darwin 이라 Windows 를 손으로 볼 수 없다)
- [`./E2E_UNIFICATION_SRS.md`](./E2E_UNIFICATION_SRS.md) — FR-E2I-1(종단간을 두 벌로 적지 않는다)
- [`./E2E_QUIESCENCE_SRS.md`](./E2E_QUIESCENCE_SRS.md) — `workers: 1` · `fullyParallel: false` 의 근거

## 2. 현황 (Current State)

| 자리 | 지금 |
|---|---|
| `e2e.yml` 방아쇠 | `workflow_dispatch` + `push: tags: ['v*']` |
| `e2e.yml` 러너 | `ubuntu-latest` 하나 × 샤드 4 |
| `verify.yml` 러너 | `windows-latest` · `ubuntu-latest` (macOS 없음) — build·vet·단위·doctor·verify |
| `release.yml` gate | 세 OS. 단 build·vet·단위·doctor·verify 이며 **브라우저 종단간은 없다** |
| 스펙의 임시 디렉터리 | `'/tmp/dm-git-fx-…' + process.pid` 리터럴 (스펙 30여 자리) · `readdirSync('/tmp')` (global-setup·teardown) |
| 픽스처 저장소 | `execFileSync('bash', ['e2e/git_fixture.sh', FIXTURES])` |
| 셸에 타이핑하는 명령 | `echo …` · `cd /tmp` · `sleep 2 && …` — POSIX 셸 전제 |

문제는 둘이다. **첫째, 돌지 않는 검사기는 없는 것과 같다** — `retries: process.env.CI ? 2 : 0`
을 들고 있는 스위트가 매 푸시에 돌지 않았다. **둘째, 한 OS 의 초록은 다른 OS 를 말하지
않는다** — 이 앱의 결함이 실제로 나온 자리가 플랫폼 계층이었고(CROSS_PLATFORM_SRS §11),
브라우저 종단간은 그 계층을 **가장 많이** 지나는 표면이다.

### 2.1 설계 결정

- **D-1 매 푸시에 돈다.** 종전 판단("커밋 대부분은 Go 층이거나 문서이며 그쪽은 `verify`
  가 지킨다")은 **비용**에 대한 것이었고, 접수한 지시는 **덮개**에 대한 것이다. 지시가
  이긴다 — 확인하려면 돌아야 한다.
- **D-2 세 OS 를 한 워크플로우의 매트릭스로 둔다.** OS 마다 job 을 따로 적으면 스텝이
  세 벌이 되고, 세 벌이면 한쪽만 고쳐진다 (FR-E2I-1 의 선례).
- **D-3 `fail-fast: false` 를 지킨다.** 한 OS 의 실패로 나머지를 끊으면, 고칠 때마다
  한 OS 씩만 보이게 된다 — 세 OS 의 실패 목록을 한 번에 받아야 한다.
- **D-4 이식성은 스펙이 아니라 한 자리에서 정한다.** 임시 디렉터리와 셸 명령을 스펙마다
  분기하면 1,257항목에 분기가 흩어진다. `e2e/osenv.ts` 한 자리가 그것을 정하고 스펙은
  이름만 부른다.
- **D-5 스펙을 지우거나 건너뛰지 않는다.** OS 에서 통과하지 못하는 항목은 **그 OS 의
  결함이거나 스펙의 POSIX 전제**이며, 둘 다 고칠 대상이다. `skip` 은 그 사실을 감춘다.
  단, 외부 런타임이 없어 애초에 성립하지 않는 자리(도커 없는 러너의 샌드박스 스펙)는
  **이미** 스펙 자신이 건너뛰고 있으며 그 규약은 그대로다.
- **D-6 산출물 이름에 OS 를 넣는다.** 지금 이름은 샤드 번호뿐이라 두 OS 가 같은 이름을
  올리며, `upload-artifact@v4` 는 같은 이름을 두 번 받지 않는다.
- **D-7 darwin 은 러너에서 돌지 않는다.** "모든 OS" 를 요구한 이유는 **덮개**였고,
  darwin 의 덮개는 이미 있다 — 개발 호스트가 macOS 이고 전량을 밀기 전에 그 자리에서
  돌린다 (V-CEM-1 이 그것을 기준선으로 세워 두었다). 같은 것을 러너에서 한 번 더 돌리는
  값이 없다. 러너가 맡는 것은 **사람이 손으로 볼 수 없는 두 OS** 다.
- **D-8 샤드는 여덟이다.** Windows 의 실측이다 — 4샤드 시절 한 샤드가 23분에 74항목만
  지났다(그 OS 는 pwsh 기동이 느려 항목당 시간이 macOS 의 몇 배다). 나누는 값은 러너
  수뿐이므로 ubuntu 도 같은 수로 둔다: OS 마다 다른 수를 쓰면 `--shard=n/N` 의 N 이
  두 벌이 되고, 그것이 D-2 가 막으려던 바로 그 모양이다.

## 3. 요구사항 (Requirements)

### 3.1 워크플로우 (Workflow)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-CEM-1 | `e2e.yml` 은 `ubuntu-latest` · `windows-latest` 에서 **같은 스위트**를 돌린다 (D-2·D-7). darwin 은 개발 호스트가 맡는다. | 필수 |
| FR-CEM-2 | 방아쇠에 `push: branches: [main]` 과 `pull_request` 를 더한다. `workflow_dispatch` · 태그는 그대로다 (D-1). | 필수 |
| FR-CEM-3 | 매트릭스는 `os × shard(1..8)` = 16 job 이며 `fail-fast: false` 다 (D-3·D-8). `workers: 1` · `fullyParallel: false` 는 건드리지 않는다. | 필수 |
| FR-CEM-4 | 실패 시 올리는 리포트 이름은 `playwright-report-<os>-<shard>` 다 (D-6). | 필수 |
| FR-CEM-5 | git 기본값(`init.defaultBranch=main`, `user.name`, `user.email`)은 두 러너 모두에서 선다 — 픽스처가 `reset --hard main` 을 쓰고, 러너의 기본 브랜치는 `master` 다. | 필수 |
| FR-CEM-6 | `timeout-minutes` 는 러너의 속도 차를 견딘다. 로컬(macOS) 실측이 전체 25분이므로 샤드 하나는 그 1/8 이지만, 러너는 그보다 느리고 `retries: 2` 가 실패 항목마다 두 번을 더 돈다 — 60분으로 둔다. | 필수 |

### 3.2 스펙의 이식성 (Portability)

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-CEM-7 | 스펙·설정·global-setup/teardown 은 임시 디렉터리를 **`os.tmpdir()`** 로 얻는다. `/tmp` 리터럴을 두지 않는다 (D-4). | 필수 |
| FR-CEM-8 | 그 경로는 **슬래시로 정규화된 형태**로 넘어간다. `bash`(git bash)와 `git` 은 `C:/…` 를 받지만 `C:\…` 는 이스케이프로 읽는다. | 필수 |
| FR-CEM-9 | 셸에 타이핑하는 명령은 `e2e/osenv.ts` 가 OS 에 맞게 만든다. 스펙은 그 이름을 부른다 — POSIX 리터럴을 스펙에 두지 않는다 (D-4). | 필수 |
| FR-CEM-10 | 픽스처 스크립트는 두 OS 모두 `bash` 로 부른다. Windows 러너에는 git bash 가 PATH 에 있다. | 필수 |
| FR-CEM-11 | 경로를 값으로 견주는 단정은 서버가 정규화한 모양과 같은 규약으로 만든다 — 서버는 `git rev-parse --show-toplevel` 의 출력을 쓴다. | 필수 |
| FR-CEM-12 | 검사가 만들어 **서버에 넘기는 경로**는 예외 없이 `osenv.realPath` 를 지난다. 순수 JS 의 `realpathSync` 는 Windows 의 짧은 이름(`RUNNER~1`)을 풀지 않고, 서버(Go 의 `EvalSymlinks`)는 긴 이름으로 답한다 — 그 둘이 갈리면 방금 더한 창을 화면이 찾지 못한다. | 필수 |
| FR-CEM-13 | 터미널에 타이핑하는 스펙은 **셸이 입력을 받을 수 있을 때까지** 기다린 뒤에 친다 (`fixtures.waitShellReady`). xterm 이 선 것은 셸이 뜬 것이 아니다 — Windows 의 ConPTY 에는 입력을 들고 있을 tty 큐가 없어 그 사이의 타이핑이 사라진다. | 필수 |
| FR-CEM-14 | 픽스처를 만드는 자리(셸을 지나지 않는 자리)는 **Node 로만** 파일을 만들고 복사한다 — `cp` · `sh` · `mkdir` 은 git bash 의 `usr/bin` 에 있고 그 자리는 Windows 러너의 PATH 에 없다. 디렉터리 복사는 `fixtures.copyDir` 한 자리다. | 필수 |
| FR-CEM-15 | 임시 디렉터리의 뒷정리는 **재시도하고, 실패해도 검사를 죽이지 않는다** (`fixtures.rmTree`). Windows 는 열린 핸들이 있는 디렉터리를 지우지 못해 `EBUSY` 를 낸다 — 서버가 그 저장소를 관측하고 있으면 늘 그렇다. 검사 중간의 삭제(소실을 **만드는** 자리)는 그 대상이 아니며, 재시도만 얹는다. | 필수 |
| FR-CEM-16 | 경로를 CSS 속성 선택자에 넣는 자리는 `osenv.cssPath` 를 지난다 — CSS 에서 역슬래시는 이스케이프 문자다. | 필수 |

## 4. 검증 (Verification)

| ID | 검증 |
|---|---|
| V-CEM-1 | 개발 호스트(macOS)에서 전체 스위트가 초록이다 — 이것이 darwin 의 덮개이자(D-7), 다른 두 OS 의 실패를 **OS 의 것**으로 읽을 수 있게 하는 기준선이다 |
| V-CEM-2 | `push` 한 번에 16 job 이 뜬다 (2 OS × 8 샤드) |
| V-CEM-3 | 두 OS 모두 초록이다 |
| V-CEM-4 | 한 OS 가 빨개도 나머지 OS 의 job 이 끝까지 돈다 (`fail-fast: false`) |
| V-CEM-6 | `grep -rn "execFileSync('\(cp\|sh\|mkdir\)'" e2e` 가 비어 있다 (FR-CEM-14 의 회귀 검출) |
| V-CEM-5 | `grep -rn "'/tmp" e2e playwright.config.ts` 에 남는 것이 **파일시스템에 닿지 않는 문자열뿐**이다 — 모의 응답의 값(`{cwd:'/tmp'}`), 검사가 해석하지 않는 원격 URL, 모의 워크스페이스의 파일 경로. 실제로 만들거나 지우거나 여는 경로는 하나도 리터럴이 아니다 (FR-CEM-7 의 회귀 검출) |

## 5. 비기능 (Non-functional)

| ID | 요구사항 |
|---|---|
| NFR-CEM-1 | 스펙이 **무엇을 검증하는가**는 이 문서로 한 항목도 바뀌지 않는다. 바뀌는 것은 그것을 **어디서 어떻게 부르는가** 뿐이다 |
| NFR-CEM-2 | 이식성 계층은 한 자리(`e2e/osenv.ts`)에 산다. OS 분기가 스펙으로 새어 나가면 그것이 다음 결함의 자리다 |

## 6. 비목표 (Non-goals)

- **`verify.yml` · `release.yml` 의 개편** — 이 문서는 브라우저 종단간의 자리만 옮긴다.
- **`workers: 1` 의 완화** — 스위트 전부가 서버 인스턴스 하나를 공유하고 fixtures 가 매
  테스트 앞에서 워크스페이스를 비운다 (E2E_QUIESCENCE_SRS). 병렬은 이 문서의 물음이 아니다.
- **릴리스 게이트 승격** — 두 OS 의 통과율을 몇 번 재고 난 뒤에 정한다.
- **스펙의 취사선택** — D-5.

## 7. 위험 (Risks)

| # | 위험 | 판단 |
|---|---|---|
| R-1 | Windows 의 도구 셸은 `pwsh`/`powershell` 이다. POSIX 셸을 전제한 스펙(파이프·`&&`·환경변수 참조)이 그대로 돌지 않는다 | FR-CEM-9 의 한 자리가 그 차이를 흡수한다. 흡수할 수 없는 자리는 **그 스펙이 무엇을 검증하는지**를 다시 적어 같은 사실을 그 OS 의 말로 확인한다 |
| R-2 | Windows 의 경로는 드라이브 문자와 역슬래시다. 경로를 값으로 견주는 단정이 무너질 수 있다 | FR-CEM-8·11. 서버가 내는 모양(`git rev-parse`)이 기준이다 |
| R-3 | 16 job × 60분은 CI 시간을 크게 쓴다 | 받아들인다 — 접수한 지시가 덮개를 요구한다 (D-1). darwin 을 뺀 것이 그 비용의 1/3 을 이미 덜었고(D-7), 그것은 덮개를 잃지 않는 유일한 감축이었다 |
| R-5 | darwin 의 회귀는 사람이 로컬 전량을 돌려야만 보인다 — 그것을 건너뛰면 아무도 못 본다 | 받아들인다 (D-7). 미는 절차가 "로컬 전량 초록 → 푸시" 이고, 그 순서가 V-CEM-1 이다 |
| R-4 | 러너의 부하로 인한 산발적 실패(플레이키) | `retries: 2` 가 이미 CI 에 걸려 있다. 그것으로 덮이지 않는 실패는 실패로 남는다 |
