# SRS: 운영 스크립트 → 단일 바이너리 CLI 통합 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`scripts/` 에 흩어진 운영 진입점 8개를 `dongminal` 바이너리의 액션 4개로 통합하고,
`scripts/` 에는 **단순 빌드 스크립트 하나만** 남긴다.

근본 문제는 하나다 — **운영 동작의 진짜 구현이 바이너리와 셸 스크립트 두 곳에
나뉘어 있고, 스크립트가 매번 `go build` 로 그 경계를 메우고 있다.** 그래서
`migrate.sh` 는 "낡은 바이너리로 변환하지 않기 위해" 항상 빌드해야 하고
(`FR-MIG-3`), `start.sh` 는 빌드·기동·준비확인을 한 파일에 겹쳐 놓았으며,
`.env` 파싱 로직이 스크립트 4개에 그대로 복제되어 있다.

바이너리가 자기 자신의 진입점이 되면 이 경계가 사라진다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| A | 무인자·`-h`·`--help` 실행 시 help 출력 (동작 변경 — 현재는 웹 서버 부팅) |
| B | 액션 `start` / `stop` / `migrate` / `health` 신설·이관. 각 액션의 옵션은 현행 스크립트와 동등 |
| C | `start` 신규 옵션 — `--isolated`(격리 실행), `--open`(frameless window), `--foreground` |
| D | `scripts/` 정리 — 운영 스크립트 5개·셸 테스트 3개 삭제, `git_fixture.sh` 를 `e2e/` 로 이동, `scripts/build.sh` 신설 |
| E | 참조처 갱신 — e2e 스펙 13개, 문서 9개, `cmd/dongminal/main.go` 안내문, `internal/migrate` 오류 문구 |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **액션 (action)** | `dongminal <action>` 의 첫 위치 인자. `start` `stop` `migrate` `health` 4개 |
| **격리 실행 (isolated)** | 운영 인스턴스(`~/.dongminal`, 포트 58146)를 건드리지 않도록 **임시 홈 + 비어 있는 포트**로 서버를 띄우는 것. 이 저장소가 수동 검증에 써 온 관례(`GIT_REMAINING.md` §1, `NEXT_SESSION_PROMPT.md`)의 자동화 |
| **frameless window** | Chrome/Chromium 의 `--app=<url>` 로 여는 크롬리스 창. 현행 `scripts/open_frameless_window.sh` |
| **배경 모드** | `start` 기본값. 서버를 detach 로 띄우고 준비를 확인한 뒤 프롬프트를 돌려준다 |
| **포그라운드 모드** | `start --foreground`. 서버가 이 프로세스로 실행되어 터미널을 점유한다. 배경 모드가 자식을 띄울 때 쓰는 형태이기도 하다 |
| **helper multi-call** | `argv[0]` basename 이 `dmctl`/`edit`/`download`/`detach` 면 그 helper 로 동작하는 기존 경로 (`internal/runtimebin.Dispatch`) |

### 1.4 참고 (References)

- `cmd/dongminal/main.go` — `main()`, `runMigrate()`, `runDaemon()`, `startDaemon()`
- `internal/runtimebin/dispatch.go` — helper multi-call
- `internal/migrate/apply.go:16` — `ErrDaemonRunning` 문구
- `scripts/{start,stop,health,migrate,open_frameless_window}.sh` — 이관 대상 원본
- `scripts/{test_start,test_stop,test_migrate}.sh` — 삭제 대상 셸 테스트
- `playwright.config.ts:37` — `webServer.command`
- `docs/internal/archive/USER_CHECKLIST_FIXES_SRS.md` FR-MIG-1..7 — `migrate.sh` 의 원 계약
- `docs/internal/GIT_REMAINING.md` §1 / `NEXT_SESSION_PROMPT.md` — 격리 인스턴스 관례

파일:라인 인용은 **2026-08-26 작업 트리 기준**이다.

### 1.5 개요 (Overview)

§2 현황, §3 요구사항, §4 검증, §5 비목표, §6 구현 계획, §7 동작 변경 기록,
§8 열린 결정.

---

## 2. 현황 (Identified Issue)

### 2.1 진입점 분포

| 파일 | 줄 | 역할 | 실제 구현 위치 |
|---|---:|---|---|
| `scripts/start.sh` | 121 | .env 로드 · 플래그 · 기존 서버 kill · 데몬 정리 · **빌드** · 기동 · 준비대기 · 상태출력 | 셸 |
| `scripts/stop.sh` | 116 | .env 로드 · 플래그 · 포트 kill · 데몬 kill | 셸 |
| `scripts/health.sh` | 76 | .env 로드 · HTTP ping · 소켓/pid 확인 | 셸 |
| `scripts/migrate.sh` | 93 | .env 로드(+호출자 우선 보정) · 서버 실행중 거부 · **빌드** · `exec ./dongminal migrate` | 셸 → Go 위임 |
| `scripts/open_frameless_window.sh` | 55 | .env 로드 · ping · OS 판별 후 브라우저 실행 | 셸 |
| `scripts/test_start.sh` | 90 | `start.sh` 계약 검증 | 셸 |
| `scripts/test_stop.sh` | 55 | `stop.sh` 계약 검증 | 셸 |
| `scripts/test_migrate.sh` | 185 | `migrate.sh` 계약 검증 (TC-MIG-1..10) | 셸 |
| `scripts/git_fixture.sh` | 193 | git 저장소 10종 픽스처 생성 | 셸 (e2e 자산) |

### 2.2 중복

`_load_env()` 는 **4개 파일에 글자 단위로 동일하게** 복제되어 있다
(`start.sh:7-22`, `stop.sh:5-20`, `health.sh:5-20`, `migrate.sh:23-38`,
`open_frameless_window.sh:6-21` — 5개). 그리고 `.env` 의 값 4개는 전부
바이너리·스크립트 기본값과 같다:

```
PORT=58146          ← main.go 기본값과 동일
BINARY=dongminal    ← 스크립트 전용 개념
LOG=/tmp/dongminal.log  ← 스크립트 전용 개념
DONGMINAL_HOME=~/.dongminal ← main.go 기본값과 동일
```

즉 `.env` 는 **기본값을 다시 적어 놓은 파일**이며, 그것을 읽기 위해 5중 복제된
파서가 존재한다. `migrate.sh` 는 그 파서가 무조건 `export` 하는 성질 때문에
"호출자 값 먼저 붙잡기"(`_CALLER_HOME` 등) 보정 코드를 다시 얹었다.

### 2.3 빌드 경계

`start.sh:94` 와 `migrate.sh:88` 이 `go build` 를 한다. `migrate.sh` 의 주석이
이유를 명시한다 — 낡은 바이너리는 `migrate` 인자를 무시하고 **웹 서버로 부팅**해
포트 충돌과 PTY 되살림을 일으킨다. 이는 §2.1 의 구조에서 파생된 위험이다:
**바이너리가 자기 진입점이면 이 위험 자체가 성립하지 않는다** (실행 중인 그
바이너리가 곧 액션의 구현이므로).

### 2.4 무인자 실행

현재 `dongminal` 은 인자 없이 실행하면 웹 서버로 부팅한다
(`main.go` `main()` 의 마지막 경로). `-h`/`--help` 도 인식하지 않고 동일하게
부팅한다.

### 2.5 문서 표류

`docs/external/getting-started.md:32-36` 는 존재하지 않는
`scripts/internal.sh`·`scripts/external.sh`·`start.sh --local` 을 안내한다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — help 와 액션 디스패치

**FR-CLI-1** 인자가 없으면 help 를 표준출력에 쓰고 종료 코드 0 으로 끝낸다.
웹 서버를 부팅하지 않는다.

**FR-CLI-2** 첫 인자가 `-h` 또는 `--help` 면 FR-CLI-1 과 동일하게 동작한다.

**FR-CLI-3** help 는 액션 4개(`start` `stop` `migrate` `health`)와 각 한 줄
설명, 그리고 액션별 help 를 보는 방법(`dongminal <action> --help`)을 포함한다.

**FR-CLI-4** 첫 인자가 액션 4개 중 하나면 그 액션을 실행한다. 나머지 인자는
액션의 옵션 파서에 넘긴다.

**FR-CLI-5** 알 수 없는 첫 인자는 표준오류에 오류 한 줄 + help 를 쓰고 종료 코드
2 로 끝낸다.

**FR-CLI-6** 각 액션은 `-h`/`--help` 를 받으면 그 액션의 사용법을 표준출력에
쓰고 종료 코드 0 으로 끝낸다. 액션의 부수효과는 일어나지 않는다.

**FR-CLI-7** 알 수 없는 옵션은 표준오류에 오류 + 그 액션의 사용법을 쓰고 종료
코드 2 로 끝낸다. 액션의 부수효과는 일어나지 않는다.

**FR-CLI-8** 기존 내부 진입점은 그대로 유지한다 —
① helper multi-call (`runtimebin.Dispatch`, `argv[0]` basename 판별),
② 데몬 모드 (`dongminal d`, 또는 `argv[0]` basename 이 `dongminald`).
`d` 는 내부 진입점이므로 help 목록에 넣지 않는다. `startDaemon()` 이 `exe d` 로
자식을 띄우는 계약을 바꾸지 않는다.

**FR-CLI-9** 액션 공통 옵션으로 `--port <n>` 과 `--home <path>` 를 받는다.
우선순위는 **플래그 > 환경변수 > 기본값**이다. 기본값은 `58146` 과
`$HOME/.dongminal`, 환경변수는 `PORT` 와 `DONGMINAL_HOME` 이다.

### 3.2 묶음 B — 액션 이관

#### start

**FR-ACT-1** `dongminal start` 는 현행 `scripts/start.sh` 와 동등한 결과를 낸다:
① 대상 포트를 **LISTEN 으로** 점유한 프로세스를 종료(TERM → 1초 → KILL),
② `--restart-daemon` 이면 `paned.pid` 로 dongminald 를 종료하고 `paned.pid`·
`paned.sock` 을 제거, 아니면 소켓 존재 여부를 한 줄로 알린다,
③ 서버를 띄운다,
④ `/api/ping` 이 응답할 때까지 최대 5초 대기(0.5초 간격),
⑤ 결과를 `✅`/`❌` 한 줄로 알린다. 실패 시 로그 마지막 20줄을 출력하고 종료
코드 1.

**FR-ACT-2** `--expose` 는 바인드 주소를 `0.0.0.0` 으로 한다. 기본은 `127.0.0.1`
이다. 환경변수 `DONGMINAL_HOST` 가 있으면 그 값이 기본을 대신하고, `--expose`
가 그보다 우선한다.

**FR-ACT-3** `--restart-daemon` 은 FR-ACT-1 ②의 데몬 재시작 경로를 켠다.

**FR-ACT-3a** `--restart-daemon` 이 dongminal 도구 안에서 실행되면(환경변수
`DONGMINAL_TOOL_ID` 가 있으면), FR-ACT-1 의 ①~⑤ 를 새 세션(`setsid`)의 대리
프로세스에 위임하고 즉시 종료 코드 0 으로 돌아온다. 대리는 같은 인자에
`DONGMINAL_RESTART_RUNNER=1` 만 더해 자기 자신을 재실행한 것이며,
stdout/stderr 은 `<home>/restart.log` 다. 위임 사실과 로그 경로를 알린다.

근거: 도구의 셸은 dongminald 의 자식이고 제어 터미널은 그 PTY 다
(`internal/shared/toolhub/tool.go` 의 `StartTool`). 데몬을 종료하면 PTY 마스터가
닫혀 셸과 그 자식인 이 명령 자신이 SIGHUP 으로 죽고, ③ 서버 기동에 도달하지
못한다 — 데몬만 내려간 상태로 끝나 복구에 외부 터미널이 필요해진다. 대리는
제어 터미널이 없고 PTY fd 를 들지 않으므로 살아남아 ①~⑤ 를 끝낸다.
`--foreground` 여부와 무관하게 위임한다 — 도구 안에서 데몬을 내리는 실행은
어느 쪽이든 자기 종료로 끝나기 때문이다.

**FR-ACT-3b** 대리 프로세스(`DONGMINAL_RESTART_RUNNER` 가 설정된 실행)는 다시
위임하지 않는다. 도구 밖(`DONGMINAL_TOOL_ID` 없음)의 `--restart-daemon` 도
위임하지 않고 그 자리에서 수행한다 — 자기 종료가 일어나지 않으므로 진행
상황을 터미널에서 그대로 본다.

**FR-ACT-3c** 대리 기동에 실패하면 데몬을 종료하지 않고 종료 코드 1 로 알린다.
근거: 데몬을 먼저 내린 뒤 대리가 없으면 복구 수단까지 사라진다.

**FR-ACT-3d** ③ 에서 detach 되는 서버에는 `DONGMINAL_RESTART_RUNNER` 와
`DONGMINAL_TOOL_ID` 를 물려주지 않는다.

근거: 서버는 dongminald 를, dongminald 는 도구 셸을 자식으로 낳는다
(`StartTool`). 대리의 환경을 그대로 물려주면 이 두 값이 그 사슬을 타고 모든 도구
셸에 심긴다. 그러면 다음 도구 안 `--restart-daemon` 이 FR-ACT-3b 의 "대리" 조건에
걸려 위임을 건너뛰고, 그 자리에서 서버와 데몬을 내리다 자기 PTY 와 함께 죽는다 —
서버도 데몬도 돌아오지 않는다. 즉 위임 재시작 1회가 그 다음 위임 재시작을
무력화하므로, 증상은 "한 번씩 실패" 로 나타난다.

`DONGMINAL_TOOL_ID` 는 도구 셸이 자기 값으로 덮어쓰므로 도구의 자기 식별을
망가뜨리지는 않는다. 그래도 물려주지 않는다 — 서버와 dongminald 는 도구가
아니고, 그 env 를 물려받은 다른 자식(도구 셸이 아닌 경로)이 "도구 안" 으로
오인되면 FR-ACT-3a 의 판정이 틀린다.

**FR-ACT-4** `start` 는 `go build` 를 하지 않는다. 빌드는 `scripts/build.sh`
의 책임이다 (§2.3).

#### stop

**FR-ACT-5** `dongminal stop` 은 대상 포트를 점유한 프로세스를 종료한다
(TERM → 1초 → KILL). 이미 정지되어 있으면 그 사실을 알리고 종료 코드 0.

**FR-ACT-6** `--all` 이면 이어서 dongminald 를 `paned.pid` 로 종료하고
`paned.pid`·`paned.sock` 을 제거한다. stale pidfile 은 제거 후 성공으로 본다.

**FR-ACT-7** `--all` 이 없으면 dongminald 는 살려 둔다. 살아 있으면 pid 와 함께
"세션 유지" 를 알린다.

**FR-ACT-8** 종료 코드는 대상 전부가 정지 상태로 끝나면 0, 아니면 1.

#### health

**FR-ACT-9** `dongminal health` 는 ① `http://localhost:<port>/` 가 3초 안에
2xx/3xx 를 주는지, ② `paned.sock` 이 있고 `paned.pid` 의 pid 가 살아 있는지를
확인해 각각 한 줄로 출력한다.

**FR-ACT-10** 종료 코드는 HTTP 실패 또는 "소켓은 있으나 pid 가 죽음" 이면 1,
그 외 0. 소켓 부재는 실패가 아니다 (direct mode 이거나 아직 미기동).

#### migrate

**FR-ACT-11** `dongminal migrate` 는 현행 `dongminal migrate` 서브커맨드의 동작
(`runMigrate`)을 유지한다. `--dry-run`/`-n` 을 받는다.

**FR-ACT-12** dry-run 이 아니면, 변환 전에 `http://127.0.0.1:<port>/api/ping`
을 2초 안에 확인하여 서버가 살아 있으면 **변환하지 않고** 종료 코드 1 로
끝낸다 (현행 `migrate.sh` FR-MIG-6 의 이관). 안내는 `dongminal stop --all` 을
가리킨다.

**FR-ACT-13** `internal/migrate.ErrDaemonRunning` 의 문구가 가리키는 명령을
`./scripts/stop.sh --all` 에서 `dongminal stop --all` 로 고친다.

### 3.3 묶음 C — start 신규 옵션

**FR-ISO-1** `start --isolated` 는 운영 인스턴스를 건드리지 않는 인스턴스를
띄운다. 홈은 `os.MkdirTemp` 로 만든 `dongminal-iso-*` 이고, 포트는 **listen 가능한
빈 포트**를 커널에서 받아 쓴다.

**FR-ISO-2** `--isolated` 는 FR-ACT-1 ①의 "기존 서버 종료" 를 건너뛴다. 빈 포트를
고른 이상 죽일 대상이 없으며, 운영 인스턴스를 죽이는 사고를 구조로 막는다.

**FR-ISO-3** `--isolated` 와 `--port`/`--home` 을 함께 주면 명시한 값이 이긴다.
이때 그 값에 대해서는 격리가 성립하지 않으므로 그대로 쓴다 (사용자가 명시한
값을 조용히 무시하지 않는다).

**FR-ISO-4** `--isolated` 로 띄운 인스턴스는 종료 방법을 함께 출력한다 —
`dongminal stop --port <n> --home <path>`.

**FR-ISO-5** 격리 홈은 자동으로 지우지 않는다. `start` 는 서버를 띄우고 끝나는
명령이므로 정리 시점을 알 수 없다. 경로를 출력하는 것으로 갈음한다.

**FR-OPN-1** `start --open` 은 준비 확인(FR-ACT-1 ④)이 성공한 뒤 frameless
window 를 연다. 준비 확인이 실패하면 열지 않는다.

**FR-OPN-2** frameless window 는 현행 `open_frameless_window.sh` 와 동등하다 —
macOS 는 `open -na "Google Chrome" --args --app=<url>`, Linux 는
`google-chrome`/`google-chrome-stable`/`chromium`/`chromium-browser` 중 먼저
찾은 것에 `--app=<url>`. 그 외 OS 는 오류 한 줄.

**FR-OPN-3** 창 열기 실패는 서버 기동의 실패가 아니다. 경고를 출력하되 종료
코드는 기동 결과를 따른다.

**FR-FG-1** `start --foreground` 는 서버를 이 프로세스로 실행한다. 로그는
표준오류로 흐르고, `SIGINT`/`SIGTERM`/`SIGHUP` 에 기존 종료 절차를 탄다.

**FR-FG-2** `--foreground` 없이 실행하면(기본) 자기 자신을 `--foreground` 를
붙여 재실행하고 detach 한다(`Setsid`). 자식의 표준출력·표준오류는 로그 파일로
보낸다. 로그 경로는 환경변수 `DONGMINAL_LOG`, 없으면 `/tmp/dongminal.log`.

**FR-FG-3** 재실행에 쓰는 실행 파일 경로는 `os.Executable()` 이다
(`startDaemon()` 과 같은 방식).

**FR-FG-4** 배경 모드의 자식에게는 해석이 끝난 `PORT`·`DONGMINAL_HOME`·
`DONGMINAL_HOST` 를 환경변수로 넘긴다. 자식이 플래그를 다시 해석해 다른 값에
도달하는 일이 없어야 한다.

### 3.4 묶음 D — scripts/ 정리

**FR-SCR-1** `scripts/build.sh` 를 신설한다. 내용은 `go build -o "${BINARY:-dongminal}"
./cmd/dongminal` 과 그 결과 한 줄이다. `.env` 를 읽지 않는다.

**FR-SCR-2** 다음을 삭제한다: `scripts/start.sh`, `scripts/stop.sh`,
`scripts/health.sh`, `scripts/migrate.sh`, `scripts/open_frameless_window.sh`,
`scripts/test_start.sh`, `scripts/test_stop.sh`, `scripts/test_migrate.sh`.

**FR-SCR-3** `scripts/git_fixture.sh` 를 `e2e/git_fixture.sh` 로 **이동**한다
(`git mv`). 내용 중 자기 경로를 안내하는 문자열 3곳을 새 경로로 고친다.

**FR-SCR-4** 정리 후 `scripts/` 에는 `build.sh` 하나만 남는다.

**FR-SCR-5** `.env.example` 을 삭제한다. 더 이상 읽히는 곳이 없다 (§7 기록).

### 3.5 묶음 E — 참조처 갱신

**FR-REF-1** e2e 스펙 13개의 `['scripts/git_fixture.sh', ...]` 를
`['e2e/git_fixture.sh', ...]` 로 고친다. 대상: `git-branches`, `git-changes`,
`git-commit`, `git-console`, `git-dialog`, `git-diff`, `git-history`,
`git-menu`, `git-polling`, `git-remote`, `git-staging`, `git-stash`,
`git-statusbar`, `git-ui-revision`.

**FR-REF-2** `playwright.config.ts` 의 `webServer.command` 를
`go run ./cmd/dongminal start --foreground` 로 고친다. 무인자 실행이 help 가
되므로(FR-CLI-1) 그대로 두면 e2e 전량이 죽는다.

**FR-REF-3** `cmd/dongminal/main.go` 의 스키마 미달 안내문 3줄이 가리키는 명령을
새 CLI 로 고친다.

**FR-REF-4** 다음 문서의 스크립트 호출 예시를 새 CLI 로 고친다: `README.md`,
`docs/external/getting-started.md`, `docs/internal/architecture.md`,
`docs/internal/README.md`, `docs/internal/GIT_MANUAL_CHECKLIST.md`,
`docs/internal/GIT_REMAINING.md`, `docs/internal/NEXT_SESSION_PROMPT.md`,
`docs/internal/ENTITY_MODEL_HANDOFF.md`, `docs/internal/design/README.md`.

**FR-REF-5** `docs/external/getting-started.md` 의 표류(§2.5 — 존재하지 않는
`internal.sh`/`external.sh`/`--local`)를 함께 정정한다.

**FR-REF-6** `docs/internal/archive/` 와 완료 기록(`*_HANDOFF.md` 의 과거 실행
기록, `SKILL_INJECTION_SRS.md` 등)은 **고치지 않는다**. 그 시점의 사실이다.
`internal/runtime/agentplugin/skills/**` 의 `scripts/*.py` 도 무관하다 (스킬
번들 내부 경로).

---

## 4. 검증 (Verification)

### 4.1 자동 테스트

셸 테스트 3종은 삭제하고 재작성하지 않는다 (§8 결정 4). 검증은 아래로 한다.

| ID | 요구사항 | 방법 | 기대 |
|---|---|---|---|
| TC-CLI-1 | FR-CLI-1/2 | `./dongminal`, `./dongminal -h`, `./dongminal --help` | help 출력, rc=0, 포트 미점유 |
| TC-CLI-2 | FR-CLI-3 | help 출력 | `start`·`stop`·`migrate`·`health` 4개가 모두 보인다 |
| TC-CLI-3 | FR-CLI-5 | `./dongminal bogus` | rc=2, stderr 에 오류 |
| TC-CLI-4 | FR-CLI-6 | `./dongminal <action> --help` × 4 | rc=0, 부수효과 없음 |
| TC-CLI-5 | FR-CLI-7 | `./dongminal stop --bogus` | rc=2, 서버 살아 있음 |
| TC-CLI-6 | FR-CLI-8 | `go test ./internal/runtimebin/...` | 기존 전량 통과 |
| TC-CLI-7 | FR-CLI-9 | `PORT=1 ./dongminal health --port 58146` | 플래그가 이긴다 |
| TC-ACT-1 | FR-ACT-1/5 | `start` → `health` → `stop` → `health` | 0 / 0 / 0 / 1 |
| TC-ACT-2 | FR-ACT-2 | `start --expose` 후 `lsof -nP -iTCP:<port>` | `*:<port>` 바인드 |
| TC-ACT-3 | FR-ACT-6/7 | `stop` 후 `paned.pid` 생존, `stop --all` 후 소멸 | 소켓·pid 제거 확인 |
| TC-ACT-4 | FR-ACT-12 | 서버 기동 상태에서 `migrate` | rc=1, 파일 무변경 |
| TC-ACT-5 | FR-ACT-11 | 격리 홈에 v1 픽스처 → `migrate --dry-run` → `migrate` | 계획 출력 후 무변경, 이어서 v2 + `*.v1.bak` |
| TC-ACT-6 | FR-ACT-3a/3b | 위임 판정 — (도구 안/밖) × (대리/비대리) × (`--restart-daemon` 유/무) | 도구 안 · 비대리 · 플래그 있음 조합만 위임 (Go 단위) |
| TC-ACT-6a | FR-ACT-3d | 위임 재시작을 연달아 2회 — 두 번째도 도구 탭에서 실행 | 2회 모두 `restart.log` 에 `✅ dongminal running`, 도구 셸 env 에 `DONGMINAL_RESTART_RUNNER` 없음 |
| TC-ACT-7 | FR-ACT-3a | 도구 탭에서 `start --restart-daemon` | 탭은 끊긴다. 브라우저 새로고침 시 새 서버·새 데몬이 응답하고 `restart.log` 마지막 줄이 `✅ dongminal running` |
| TC-ISO-1 | FR-ISO-1/2 | 운영 서버 기동 중 `start --isolated` | 운영 서버 생존, 새 포트에 별도 인스턴스 |
| TC-ISO-2 | FR-ISO-3 | `start --isolated --port 58200` | 58200 사용 |
| TC-FG-1 | FR-FG-1 | `start --foreground` | 프롬프트 미반환, ping 응답, `^C` 로 정지 |
| TC-FG-2 | FR-FG-2 | `start` | 프롬프트 반환, 로그 파일 생성, ping 응답 |
| TC-SCR-1 | FR-SCR-4 | `ls scripts/` | `build.sh` 만 |
| TC-REF-1 | FR-REF-1/2 | `npx playwright test` | 기준선 유지 |

**Go 단위 테스트를 두는 지점** (순수 함수로 분리 가능한 것만):
플래그 파싱(FR-CLI-4..7, FR-CLI-9, FR-ACT-2/3/6), 재시작 위임 판정
(FR-ACT-3a/3b), help 텍스트가 액션 4개를
모두 포함하는지(FR-CLI-3), 빈 포트 선택(FR-ISO-1), 옵션 우선순위 해석
(FR-CLI-9, FR-ISO-3), 브라우저 명령 조립(FR-OPN-2).
프로세스 kill·detach·실 네트워크는 단위 테스트 대상이 아니다 — TC-ACT/TC-FG 의
수동·통합 절차로 본다.

### 4.2 회귀 게이트

```
go build ./... && go vet ./... && go test ./... -race && gofmt -l .
npx playwright test --retries=1
```

기준선: Go 전량 통과 / Playwright 기존 통과 수 유지.

---

## 5. 비목표 (Non-goals)

- **액션 추가.** `fixture`·`build`·`daemon` 등을 액션으로 만들지 않는다. 액션은
  `start`/`stop`/`migrate`/`health` 4개다.
- **`.env` 대체 설정 파일.** 환경변수 + 플래그로 충분하다 (§2.2).
- **`d` 서브커맨드 개명.** `dongminald`·`paned.sock`·`paned.pid` 어휘는 실행 중
  인스턴스와의 계약이다 (`ENTITY_MODEL_HANDOFF.md` 의 판단 유지).
- **셸 테스트의 Go 재작성.** §8 결정 4.
- **격리 홈 자동 정리(GC).** FR-ISO-5.
- **`build.sh` 확장.** 웹 자산 번들·크로스컴파일·버전 스탬프를 넣지 않는다.
  "단순 빌드 스크립트" 가 요구사항이다.
- **`migrate` 를 `migration` 으로 개명.** §8 결정 5.

---

## 6. 구현 계획 (Implementation Plan)

| 단계 | 내용 | 산출 |
|---|---|---|
| 1 | `internal/cli` 패키지 신설 — 플래그 파싱·옵션 해석·help 텍스트 (순수 함수) | `internal/cli/*.go` + 단위 테스트 |
| 2 | 액션 구현 — `start`/`stop`/`health`/`migrate` 의 부수효과 경로 | `internal/cli/*.go` |
| 3 | `cmd/dongminal/main.go` 를 디스패처로 재배선. 서버 부팅 경로를 `--foreground` 아래로 이동 | `main.go` |
| 4 | `scripts/` 정리 + `git mv scripts/git_fixture.sh e2e/` | 묶음 D |
| 5 | 참조처 갱신 — playwright.config.ts, e2e 13개, main.go 안내문, migrate 문구, 문서 9개 | 묶음 E |
| 6 | 회귀 게이트 (§4.2) | — |

**단계 3 의 함정**: `main()` 의 현재 서버 부팅 경로는
`runtime.Install` → `dialOrStartDaemon` → `buildDeps*` → `srv.Run` 순이며 중간에
`os.Setenv("DONGMINAL_PORT", port)` 로 helper multi-call 이 읽는 값을 심는다
(`runtimebin/http.go`). 이 순서와 부작용을 그대로 옮겨야 한다.

**단계 5 의 함정**: `playwright.config.ts` 를 먼저 고치지 않고 단계 3 을 끝내면
e2e 전량이 "서버가 안 뜬다" 로 죽는다. 원인이 제품이 아니라 config 라는 것을
알아보기 어렵다.

---

## 7. 동작 변경 기록 (Behavior Changes)

| # | 이전 | 이후 | 이유 |
|---|---|---|---|
| 1 | `dongminal` (무인자) → 웹 서버 부팅 | help 출력 후 rc=0 | FR-CLI-1. 사용자 요구 |
| 2 | `dongminal -h` → 웹 서버 부팅 | help 출력 후 rc=0 | FR-CLI-2 |
| 3 | `./scripts/start.sh` 가 매번 `go build` | `start` 는 빌드하지 않음 | §2.3. 빌드는 `scripts/build.sh` |
| 4 | `./scripts/migrate.sh` 가 매번 `go build` | 좌동 | 실행 중인 바이너리가 곧 구현이므로 낡은 바이너리 위험이 성립하지 않음 |
| 5 | `.env` 를 5개 스크립트가 읽음 | 읽는 곳 없음. 환경변수만 | §2.2 — `.env` 값 4개가 전부 기본값과 동일하므로 실질 차이 없음. `PORT`/`DONGMINAL_HOME` 을 쉘 환경변수로 주면 그대로 동작 |
| 6 | `LOG` 환경변수 | `DONGMINAL_LOG` | 다른 환경변수와 접두사를 맞춤. 기본값 `/tmp/dongminal.log` 동일 |
| 7 | `BINARY` 환경변수가 실행 경로도 결정 | `scripts/build.sh` 의 출력 이름만 결정 | 실행은 실행된 바이너리 자신 |
| 8 | `scripts/git_fixture.sh` | `e2e/git_fixture.sh` | FR-SCR-3 |
| 9 | frameless window = 별도 스크립트 | `start --open` | 사용자 요구 |
| 10 | 도구 안에서 `start --restart-daemon` → 데몬만 내려가고 서버는 뜨지 않음 | 대리 프로세스가 재시작을 끝까지 수행 | FR-ACT-3a. 데몬을 내리는 순간 명령 자신이 SIGHUP 으로 죽어 서버 기동에 도달하지 못했다. 도구 밖 실행은 종전과 동일 |

**변경 1·2 의 파급**: 무인자 실행에 의존하던 곳은 두 군데뿐이다 —
`playwright.config.ts` (FR-REF-2 로 처리) 와 문서의 수동 검증 예시
(`PORT=58200 DONGMINAL_HOME=... /tmp/dm-manual-bin`, FR-REF-4 로 처리).
`startDaemon()` 은 `exe d` 를 쓰므로 영향 없다.

---

## 8. 열린 결정 (Resolved Decisions)

| # | 결정 | 선택 | 근거 |
|---|---|---|---|
| 1 | `git_fixture.sh` 처리 | `e2e/` 로 이동 | 운영 자산이 아니라 테스트 자산이다. `scripts/` 는 빌드 스크립트 전용이 된다 |
| 2 | `--isolated` 의 의미 | 임시 홈 + 빈 포트 자동, `--port`/`--home` 으로 덮어쓰기 가능 | 이 저장소의 수동 검증 관례를 자동화. 고정 포트는 동시 2개를 못 띄운다 |
| 3 | `start` 의 실행 형태 | 기본 배경 모드, `--foreground` 로 선택 | 현행 `start.sh` 사용 습관 유지 + playwright 가 포그라운드를 필요로 함 |
| 4 | 셸 테스트 3종 | 삭제만, 재작성 없음 | 사용자 결정 |
| 5 | 액션 이름 `migrate` vs `migration` | `migrate` | 기존 서브커맨드·`internal/migrate`·문서 전량이 `migrate` 다. 사용자가 구두로 쓴 "migration" 은 동작을 가리킨 것으로 해석. `helth` 는 오타로 보아 `health` |

---

## 9. 개정 이력

| 날짜 | 내용 |
|---|---|
| 2026-08-26 | 최초 작성 |
| 2026-08-26 | **구현 완료.** 검증 결과 — Go `build`/`vet`/`test -race`/`gofmt` 전량 통과 (`internal/cli` 신규 테스트 27개 포함), Playwright 396 통과 + flaky 2 (재시도 통과, 기준선과 동일 성격). CLI 실측: TC-CLI-1..7 / TC-ACT-1·3·4·5 / TC-ISO-1·2 / TC-OPN 통과. **TC-ISO-1 은 운영 인스턴스(pid 28098, 포트 58146) 가 격리 실행 전후로 그대로 살아 있음을 확인해 반증했다.** TC-FG-1/2 는 Playwright `webServer`(`start --foreground`)와 배경 모드 실측으로 확인. §3 대비 추가 구현 1건 — `migrate` 의 실행중 거부 안내가 대상 인스턴스를 가리키도록 `--port`/`--home` 을 덧붙인다(기본값이 아닐 때만). 격리 인스턴스에 대해 `dongminal stop --all` 만 안내하면 그 명령이 운영 인스턴스를 향하기 때문이다 |
| 2026-08-28 | **FR-ACT-3d 추가, FR-ACT-1① 정정** — 위임 재시작이 "한 번씩 실패" 하던 결함 2건. ① 대리의 env 를 서버에 그대로 물려줘 `DONGMINAL_RESTART_RUNNER` 가 dongminald → 도구 셸까지 심겼고, 다음 도구 안 재시작이 자신을 대리로 오인해 위임을 건너뛰었다(실행 중 서버·데몬·도구 셸 env 에서 실측). ② `lsof -ti :port` 가 그 포트에 접속한 클라이언트까지 잡아, 서버를 내리는 자리에서 대시보드를 띄운 브라우저 렌더러를 함께 KILL 했다(실측: Chrome Helper pid 가 대상에 포함). 클라이언트의 재접속 시도가 종료 확인에 걸리면 `❌ 포트를 비우지 못했습니다` 로 오판해 데몬 종료 전에 중단한다 |
| 2026-08-27 | **FR-ACT-3a/3b/3c 추가** — 도구 안에서의 `--restart-daemon` 을 setsid 대리 프로세스에 위임한다. 데몬을 내리면 명령 자신이 함께 죽어 서버가 뜨지 않던 결함(§7 변경 10). 도구 밖 경로는 코드 경로가 바뀌지 않는다 |
