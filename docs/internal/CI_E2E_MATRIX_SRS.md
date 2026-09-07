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
| FR-CEM-6 | `timeout-minutes` 는 러너의 속도 차를 견딘다. 샤드 하나는 전량의 1/8 이고 러너 안에서 다시 워커가 나누지만(E2E_PARALLEL_SRS), 러너는 개발 호스트보다 느리고 실패 항목은 재시도로 한 번을 더 돈다(FR-CEM-17) — 60분으로 둔다. | 필수 |

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
| FR-CEM-17 | CI 의 `retries` 는 **1** 이다. 재시도의 값은 두 번째 시도에서 거의 다 나오고 세 번째는 값이 아니라 비용이다 — 실패 하나가 세 번 도는 동안 나머지가 밀렸다(4샤드 회차: 한 샤드가 23분에 74항목, 247항목을 남기고 잘림). | 필수 |
| FR-CEM-20 | `use.actionTimeout` 은 20초다. 기본값(없음)에서는 `click` 하나가 테스트 예산 전부를 먹어, 나타나지 않을 요소를 기다리는 검사가 Windows 에서 120초를 쓰고 재시도가 그것을 한 번 더 돌렸다 — 실패 하나에 4분이다. 조작이 20초 안에 되지 않으면 느린 것이 아니라 되지 않는 것이다. 단정의 상한은 그대로다. | 필수 |
| FR-CEM-28 | **중첩된 Editor 루트**를 재는 검사가 있다 (`editor-nested-root.spec.ts`). 바깥 루트와 그 안쪽 루트를 함께 등록하고, 안쪽 파일을 여는 길이 안쪽 창으로 가는지 본다 — 어느 OS 에서나 같은 조건이다. 이것이 없으면 임시 뿌리를 OS 마다 달리 두는 선택(FR-CEM-22)이 **재지 않은 조건을 감추게** 된다. | 필수 |
| FR-CEM-27 | 실행의 끝에 **동등성 한 줄**을 남긴다 (`e2e/parity-reporter.ts`): 돈 항목 수, 건너뛴 항목 수, 건너뛴 **사유별 개수**. 항목을 OS 로 빼는 자리는 없지만 조건부 건너뜀(도커 없음·LSP 팩 다 있음·Editor 루트 없음)은 있고, 그것이 있는 한 "초록" 은 "다 돌았다" 를 뜻하지 않는다 — 두 OS 의 그 줄을 견주면 동등성이 눈에 보인다. 판정하지 않고 세어서 말한다. | 필수 |
| FR-CEM-26 | 컨테이너를 쓰는 검사의 건너뜀 판정은 **리눅스 컨테이너를 돌릴 수 있는가**를 묻는다 (`docker info --format "{{.OSType}}"` 이 `linux`). `docker info` 의 성공만 보면 Windows 러너에서 참이 되지만 그 데몬은 Windows 컨테이너 모드이고, 그러면 검사는 건너뛰지도 통과하지도 못한 채 실패한다. | 필수 |
| FR-CEM-24 | 러너의 git 은 `core.autocrlf=false` · `core.eol=lf` 다. Git for Windows 의 기본값은 체크아웃에서 `\n` 을 `\r\n` 으로 바꾸며, 그러면 픽스처가 쓴 내용과 검사가 읽은 내용이 그 한 글자만큼 갈린다 — 실패 메시지가 "A 를 기대했는데 A 가 왔다" 로 보여 원인을 감춘다. | 필수 |
| FR-CEM-23 | Editor 창으로 옮기는 검사는 **그 창이 실제로 활성이 될 때까지** 기다린다 (`fixtures.switchToEditorRoot`). `switchWindow` 뒤에 `.ed-tree .ed-row` 가 보이기만 기다리면 **아무 창의 트리라도** 그 조건을 만족한다 — 앱은 홈을 뿌리로 하는 편집기를 늘 하나 세우므로(FR-EDT-13) 그 트리에는 언제나 행이 있고, 전환이 뒤늦은 워크스페이스 적용에 덮여도 검사는 모른 채 남의 트리를 본다(러너 실측). | 필수 |
| FR-CEM-22 | 검사의 임시 뿌리는 **사용자 홈 밖**에 있어야 한다. Windows 의 `os.tmpdir()` 은 `C:\Users\<사용자>\AppData\Local\Temp` — 홈 **안**이고, 앱은 홈을 뿌리로 하는 편집기를 늘 하나 세우므로(FR-EDT-13) 검사가 만든 모든 뿌리가 그 창에 중첩된다. POSIX 의 `/tmp` 에서는 없던 겹침이라 여러 스펙이 "내 뿌리를 품는 창은 내 것뿐" 을 조용히 전제한다. 러너에서는 `RUNNER_TEMP` 를 쓴다. 스펙은 `os.tmpdir()` 을 직접 부르지 않고 `osenv.TMP` 를 부른다. | 필수 |
| FR-CEM-21 | 워크플로우의 액션은 **Node 24 런타임**을 쓰는 판을 쓴다 (`checkout@v5` · `setup-go@v6` · `setup-node@v6` · `upload-artifact@v6` · `download-artifact@v7`). Node 20 판은 러너가 강제로 24 에서 돌리며 경고를 낸다. | 필수 |
| FR-CEM-19 | 소실을 **만드는** 삭제(검사의 전제)는 `fixtures.rmTreeHard` 를 쓴다 — 15초까지 재시도하고, 그래도 안 되면 던진다. Windows 는 서버가 그 저장소에 띄운 `git` 자식 프로세스가 사는 동안 `EBUSY` 지만 폴링 사이에 틈이 있다. 뒷정리(`rmTree`)와 뜻이 다르다: 지워지지 않으면 그 뒤의 단정이 뜻을 잃는다. | 필수 |
| FR-CEM-18 | CI 의 `maxFailures` 는 **20** 이다. 한 샤드가 그 수를 넘겨 실패하면 그것은 개별 결함이 아니라 계통의 문제이며, 남은 항목을 마저 도는 것은 같은 사유의 반복에 러너의 한 시간을 쓰는 일이다. 로컬은 상한이 없다 — 고치는 사람은 전체 목록을 봐야 한다. | 필수 |
| FR-CEM-29 | 러너마다 달라지는 **서버의 관측**에 기대는 검사는 그것을 stub 한다. `/api/lsp/status` 가 그 자리다 — 무엇이 설치돼 있는지도, 동봉 선언이 격리 칸에 펴졌는지도 기계마다 다르며, 그것에 기댄 검사는 자기가 재려는 것 대신 러너의 형편을 잰다. | 필수 |
| FR-CEM-30 | **비동기 등록을 딛는 조작은 등록을 기다린 뒤에 친다.** Monaco 의 호버 provider 는 `/api/lsp/status` 의 답을 받은 뒤에 걸리므로(`_lspHoverRegister`), 편집기가 선 그 순간에 호버를 트리거하면 Monaco 는 **아무에게도 묻지 않는다** — 증상은 "말풍선이 안 뜬다" 로만 보여 provider 의 속을 의심하게 만든다. 러너가 느릴수록 그 틈이 벌어진다 (Windows 실측). | 필수 |
| FR-CEM-31 | **폴링이 잡는가**를 재는 검사의 예산은 폴링의 **백오프 상한**을 견딘다. 관측이 한 번이라도 실패하면 주기가 기준 × 2ⁿ 으로 늘어 30초에 붙고(`GIT_FAIL_BACKOFF_MAX_MS`), 소실 판정이면 곧바로 30초다 — 그보다 짧은 예산은 "폴링이 안 돈다" 와 "러너에서 한 번 실패했다" 를 같은 실패로 만든다. 예산이 테스트의 기본 한도를 넘으면 그 검사가 `test.setTimeout` 으로 자기 한도를 넓힌다 — 넘치면 단정의 진단 대신 timeout 만 남는다. | 필수 |
| FR-CEM-32 | 변화 감지는 **디렉터리 mtime 에 기대지 않는다.** Windows 러너의 작업 디스크(`D:\a\_temp`)에서 `git branch` 가 `refs/heads/r26` 을 만든 뒤 **45초 동안** `refs/heads` 의 mtime 이 그대로였다 — 같은 시간에 `git for-each-ref` 는 그 브랜치를 돌려주었다 (V-GVR-26 의 trace: status 응답 45건의 signature 가 한 값). 서버의 signature 는 항목 **이름**을 함께 근거에 넣는다 (GIT_VIEW_REFRESH_SRS FR-GVR-21a). 유닛 검사는 그 파일시스템 없이도 이 조건을 만든다 — `Chtimes` 로 디렉터리 시각을 되돌린다 (V-GVR-22a). | 필수 |
| FR-CEM-33 | 폴링을 재는 검사의 **진단은 그 저장소의 패널을 읽는다** (`_gitPanel(repo, slot)`) — `app.gitPanel` 은 활성 창의 것이라 터미널 칸에 서 있는 배치(TC-SVS-60)에서는 `repo:null · pollOn:false` 를 말하고, 그것은 결함이 아니라 잘못 읽은 것이다. 진단에는 관측의 single-flight 잠금(`_busy`·`_again`)과 History 의 로딩 잠금(`_loading`·`_again`), 관측 근거(`_lastSig`·`_lastViewFp`)가 든다 — "폴링이 멎었다 · 잠겼다 · 돌았는데 그리지 않았다" 는 같은 증상으로 보이고 고치는 자리가 다르다. | 필수 |
| FR-CEM-34 | **첫 관측을 딛는 조작은 그 관측이 닿은 뒤에 친다.** recovery hint 의 되돌릴 HEAD 는 `statusOf().oid` 에서 오므로(`_restoreCmd`), History 의 행이 보이는 것(log 가 닿았다)만 기다리고 메뉴를 열면 status 가 아직 오는 중일 수 있다 — 그때 hint 는 빈 채로 뜬다 (Windows 러너 실측: D5 의 두 시도 모두 `<code class="gc-hint-cmd"></code>`). `fixtures.openGit` 이 이미 `statusOf()` 를 기다리는 것과 같은 근거다. | 필수 |
| FR-CEM-35 | **새로고침 뒤 설정이 만드는 화면은 poll 로 잰다.** 탭은 `GET /api/settings` 보다 먼저 그려지므로 첫 탭이 보인 순간의 폭은 설정 이전의 것이다 — 서버에 값이 있어도 그렇다 (W7 · Windows 러너 실측: 설정 응답이 탭이 선 뒤 290ms 에 왔고, 두 시도 모두 폭 넷이 제각각이었다). `expect.poll` 이 그 자리다. | 필수 |

## 4. 검증 (Verification)

| ID | 검증 |
|---|---|
| V-CEM-1 | 개발 호스트(macOS)에서 전체 스위트가 초록이다 — 이것이 darwin 의 덮개이자(D-7), 다른 두 OS 의 실패를 **OS 의 것**으로 읽을 수 있게 하는 기준선이다 |
| V-CEM-2 | `push` 한 번에 16 job 이 뜬다 (2 OS × 8 샤드) |
| V-CEM-3 | 두 OS 모두 초록이다 |
| V-CEM-4 | 한 OS 가 빨개도 나머지 OS 의 job 이 끝까지 돈다 (`fail-fast: false`) |
| V-CEM-7 | 두 OS 의 `[parity]` 줄이 **같은 수**를 말한다 — 돈 항목과 건너뛴 항목, 그리고 사유별 개수. 다르면 그 차이가 곧 동등성의 구멍이고, 그것을 설명할 수 있어야 한다 (FR-CEM-27) |
| V-CEM-8 | 호버를 재는 검사가 provider 등록을 **확인한 뒤에** 트리거한다 (`expectHoverGround` 의 `hoverLangs` 대기) — 그 확인이 없으면 "아무것도 뜨지 않는다" 를 재는 검사는 provider 가 없을 때 **재는 것 없이 초록**이다 (FR-CEM-29·30) |
| V-CEM-9 | `TestSignature_RefAddSurvivesStaleDirMtime` 이 통과한다 — 디렉터리 mtime 을 되돌려 놓아도 ref 의 추가·삭제로 signature 가 달라진다 (FR-CEM-32). `slot-live-refresh` 의 진단이 `_gitPanel(repo, slot)` 을 읽고 `busy`·`hist` 를 싣는다 (FR-CEM-33). `git-commit-actions` 의 `openHistory` 가 `statusOf().oid` 를 기다린다 (FR-CEM-34) |
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
| R-6 | **Windows 만 임시 뿌리가 다르다** (`RUNNER_TEMP`, FR-CEM-22). 그 OS 의 `os.tmpdir()` 은 사용자 홈 안이라 앱의 홈 루트 편집기가 검사의 모든 뿌리를 품는 **중첩** 상황이 되는데, POSIX 의 `/tmp` 에서는 그 상황이 한 번도 생기지 않았다 — 즉 두 OS 가 같은 조건에서 돌지 않았다 | **막았다.** 중첩은 앱이 실제로 다뤄야 하는 상황이고(`_edLinkedWindow` 의 "가장 깊은 것이 이긴다"), 그 조건을 **어느 OS 에서나 똑같이** 만드는 검사를 세웠다 (`e2e/editor-nested-root.spec.ts`, FR-CEM-28). 임시 뿌리는 `RUNNER_TEMP` 로 둔다 — 그것은 러너가 그 목적으로 주는 자리이고, 이제 그 선택이 **무엇도 감추지 않는다** |
| R-4 | 러너의 부하로 인한 산발적 실패(플레이키) | `retries: 2` 가 이미 CI 에 걸려 있다. 그것으로 덮이지 않는 실패는 실패로 남는다 |
