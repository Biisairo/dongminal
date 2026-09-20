# AUDIT — Go 공용/데몬/CLI 계층

대상: `internal/shared/` · `internal/daemon/` · `internal/ctl/` · `internal/helper/` · `cmd/dongminal/`
범위: 비검사 Go 소스 약 29.5k LOC (`*_test.go` 제외)
브랜치: `refactor` · 감사일 2026-09-20 · **읽기 전용 (소스 무수정)**

---

## 0. 총평

이 계층은 이미 여러 차례 통합을 거친 흔적이 뚜렷하다. `dmenv`·`platform`·`serverconf`·
`homeLayout`·`actionsOf`·`daemonStateLine` 처럼 **"두 벌로 두면 한쪽만 고쳐진다"** 를
명시적으로 막아 둔 자리가 많고, 대부분의 주석이 결정의 근거와 실측을 함께 적고 있다.
흔한 감사 항목(과대 함수·깊은 중첩·죽은 코드)은 거의 나오지 않았다 — 70줄 넘는 함수 26개
중 실제로 책임이 둘인 것은 `buildCommonDeps` 하나뿐이다.

그래서 이 보고서의 무게는 **"통합의 원칙은 세웠는데 그 원칙이 닿지 않은 자리"** 에 있다.
발견의 다수가 같은 모양이다: 단일 출처 상수를 만들어 두고 일부 호출부만 옮겼거나,
헬퍼(`dmenv.DialHost`·`WriteFileAtomic`·`serverconf.Resolve`)를 만들어 두고
같은 물음을 묻는 다른 호출부는 옛 방식에 남아 있다.

### 요약 표

| # | 등급 | 제목 | 주 위치 | 위험 | 공수 |
|---|---|---|---|---|---|
| 1 | HIGH | `DONGMINAL_HOST=::1` 로는 서버가 뜨지 않는다 (JoinHostPort 부재) | `cmd/dongminal/app.go:229` | MED | S |
| 2 | HIGH | 서버를 겨누는 방법이 명령마다 다르다 (4계층 설정을 `start` 만 지킨다) | `internal/ctl/cli/health.go:30` | MED | M |
| 3 | HIGH | 기본 로그 경로에 답이 셋 — `config show`·`doctor`·`help`·`service` 가 틀린 값을 낸다 | `internal/ctl/cli/start.go:316` | LOW | S |
| 4 | HIGH | `homeLayout()` 이 "전수 목록" 이 아니다 — `git-worktrees/`·`ext/`·`worktrees/` 누락 | `internal/ctl/cli/homelayout.go:34` | MED | S |
| 5 | HIGH | 문서-구현 괴리 4건 (로그 기본값·bash 훅·노출 게이트·`DONGMINAL_SHELL`) | `docs/external/getting-started.md` | LOW | S |
| 6 | MED | 홈 하위 경로 조립이 흩어져 있다 (`"bin"` 8곳, `"workspace.json"` 7곳, `"paned.pid"` 3곳) | 다수 | LOW | M |
| 7 | MED | `unpackEmbedded` 가 살아 있는 셸이 읽는 파일을 비원자적으로 쓴다 | `internal/shared/runtime/install.go:481` | MED | S |
| 8 | MED | `runtime.Install` 이 부팅마다 두 번 돈다 (서버 + 데몬) | `cmd/dongminal/app.go:56` · `internal/daemon/boot/boot.go:59` | LOW | S |
| 9 | MED | `cli.Actions` 가 낡은 중복 — 액션 15개 중 6개만 검사가 돈다 | `internal/ctl/cli/options.go:54` | LOW | S |
| 10 | MED | `envOr` 가 두 패키지에 똑같이 두 벌 | `internal/helper/runtimebin/http.go:16` · `internal/shared/sandboxplace/wire.go:47` | LOW | S |
| 11 | MED | `dmctl` 이 `dmenv.DialHost` 를 지나지 않는다 | `internal/helper/runtimebin/http.go:24` | LOW | S |
| 12 | MED | `service install` 이 launchd/systemd 로그를 세계 읽기 가능한 자리에 박는다 | `internal/ctl/cli/service.go:164` | MED | S |
| 13 | MED | `DONGMINAL_SHELL` 이 Windows 에서만 듣는다 | `internal/shared/platform/shell.go:271` | LOW | S |
| 14 | LOW | `EnvLog`·`daemonPIDFile`·`"PORT"` 가 상수를 두고도 리터럴로 재선언 | `internal/ctl/cli/options.go:29` 외 | LOW | S |
| 15 | LOW | `paned.build` 지문이 정상 종료에서 치워지지 않는다 | `internal/daemon/ipc/paned_server.go:222` | LOW | S |
| 16 | LOW | 고아 주석 — 없는 필드를 설명한다 | `internal/shared/toolhub/manager.go:128` | LOW | S |
| 17 | LOW | `usageBackup`·`usageUninstall` 이 `homeLayout` 을 손으로 베낀다 | `internal/ctl/cli/help.go:179` | LOW | S |
| 18 | LOW | `buildCommonDeps` 113줄 — 도메인 조립이 한 함수에 | `cmd/dongminal/main.go:298` | LOW | M |

성능·문서 항목은 각각 §2·§3 에 따로 모았다.

---

## 1. 항목 (우선순위 순)

### [HIGH] 1. `DONGMINAL_HOST=::1` 로는 서버가 뜨지 않는다 — 주소 조립에 `net.JoinHostPort` 가 없다

- **위치**
  - `cmd/dongminal/app.go:229` — `return a.srv.Run(ctx, a.host+":"+a.port)`
  - `internal/ctl/cli/start.go:359` — `fmt.Sprintf("http://%s:%s", pingHost(host), port)`
  - `internal/helper/runtimebin/http.go:24-29` — `fmt.Sprintf("http://%s:%s", …)`
  - `internal/ctl/cli/health.go:37` — `fmt.Sprintf("http://%s:%s/", dmenv.DefaultHost, port)`
  - `internal/shared/dmenv/host.go:21-25` — `normalizeHost` 가 대괄호를 **뗀다**
- **현상**: 저장소 전체에 `net.JoinHostPort` 사용이 0건이고, host:port 를 전부 문자열 접합으로 만든다.
- **비용**: 실측 (darwin/arm64, Go 표준 net):
  ```
  net.Listen("tcp", "::1:9911")   -> listen tcp: address ::1:9911: too many colons in address
  net.Listen("tcp", "[::1]:9912") -> ok
  ```
  `DONGMINAL_HOST=::1` 은 **문서가 명시적으로 지원한다고 적은 값**이다
  (`docs/external/getting-started.md:309` — "loopback(`127.0.0.1`·`::1`·`localhost`)").
  그 값으로 띄우면 `serverconf.Resolve` 를 통과하고(`checkPort` 는 포트만 본다),
  `prepareServerCmd` 가 자식을 띄우고, 자식이 `net.Listen` 에서 죽는다. 부모는
  `waitReady` 로 5초 폴링한 뒤 "❌ 기동 실패" 만 낸다 — **어느 값이 문제인지가 없다.**
  `dmenv.normalizeHost` 가 `[::1]` 의 대괄호를 떼므로 사용자가 올바른 형태로 적어도
  같은 곳에 떨어진다. 판정(`IsExposedHost`)에는 대괄호를 떼는 것이 맞고,
  조립에는 붙이는 것이 맞는데 둘이 한 함수의 출력을 공유한다.
- **제안**:
  - `dmenv` 에 조립 전용 함수를 하나 더 둔다 — 판정용 `DialHost` 와 갈라 둔다:
    ```go
    // ListenAddr 는 net.Listen 에 그대로 넘길 주소다. IPv6 는 대괄호가 필요하다.
    func ListenAddr(host, port string) string { return net.JoinHostPort(host, port) }
    // BaseURL 은 그 서버를 두드릴 http URL 이다. DialHost 를 지난 뒤 대괄호를 되붙인다.
    func BaseURL(host, port string) string {
        return "http://" + net.JoinHostPort(DialHost(host), port)
    }
    ```
  - `app.go:229` → `a.srv.Run(ctx, dmenv.ListenAddr(a.host, a.port))`
  - `cli.ServerURL`·`runtimebin.baseURL` → `dmenv.BaseURL(host, port)`
  - 더불어 `serverconf.checkPort` 옆에 `checkHost` 를 둔다 — `netip.ParseAddr` 로
    해석되지도 않고 DNS 이름도 아닌 값은 **`net.Listen` 전에** 출처와 함께 거부한다.
    `checkPort` 의 머리말(`conf.go:229`)이 적은 근거가 그대로 호스트에도 적용된다.
- **위험도**: MED (주소 형태가 바뀌므로 기동 경로 전량이 영향)
- **공수**: S

---

### [HIGH] 2. 서버를 겨누는 방법이 명령마다 다르다 — 4계층 설정을 `start` 만 지킨다

가장 값이 큰 발견이다. **같은 물음("어느 서버를 겨누는가")에 답이 다섯 벌 있고,
그중 하나만 선언된 계약을 지킨다.**

- **위치**

  | 명령 | host 해석 | port 해석 | 파일 계층(`server.json`) |
  |---|---|---|---|
  | `start` | `serverconf.Resolve` → `DialHost` (`start.go:47,378`) | `serverconf.Resolve` (`start.go:47`) | ✅ |
  | `config show` | `serverconf.Resolve` (`config.go:87`) | `serverconf.Resolve` | ✅ |
  | `service install` | `serverconf.Resolve` (`service.go:94`) | `serverconf.Resolve` | ✅ |
  | `window` | `DefaultHost` + `os.Getenv(EnvHost)` (`window.go:26-29`) | `o.ResolvePort()` (`window.go:30`) | ❌ |
  | `health` | **`dmenv.DefaultHost` 고정** (`health.go:37`) | `o.ResolvePort()` (`health.go:30`) | ❌ |
  | `stop` | — | `o.ResolvePort()` (`stop.go:15`) | ❌ |
  | `migrate` | — | `o.ResolvePort()` (`migrate.go:39`) | ❌ |
  | `dmctl`(헬퍼) | `envOr(EnvHost, DefaultHost)` (`runtimebin/http.go:25`) | 동 | ❌ |

- **현상**: `CONFIG_MANAGEMENT_SRS` FR-CFG-13 이 **플래그 > 환경변수 > 파일 > 기본값**
  을 계약으로 선언하는데, 그 계층을 지나는 명령은 셋뿐이다. 나머지는
  `Common.ResolvePort()`(`options.go:97`) 의 3계층에 머문다.

- **비용**: `server.json` 에 `{"port":"9000"}` 한 줄을 적으면 그 순간 갈라진다.

  | 명령 | 겨누는 포트 | 결과 |
  |---|---|---|
  | `start` | 9000 | 정상 |
  | `health` | 58146 | "❌ dongminal HTTP :58146 — 응답 없음" (서버는 멀쩡하다) |
  | `window` | 58146 | "서버가 떠 있지 않습니다" |
  | `stop` | 58146 | **그 포트의 다른 프로세스를 죽인다** (`killPort` 는 대상을 가리지 않는다) |
  | `migrate` | 58146 | 서버가 도는데도 "정지됨" 으로 보고 변환을 강행한다 |

  `stop` 과 `migrate` 가 특히 나쁘다 — 앞의 것은 `killPort` 가 TERM→KILL 을 보내고,
  뒤의 것은 `proc.go` 의 포트 점유 검사가 "서버가 응답하면 변환을 거부한다" 는
  안전장치인데 엉뚱한 포트를 보므로 **무력화된다.**

  `health` 는 host 도 고정이다. `health.go:33-36` 의 주석이 그 근거를 적는데,
  그것은 "`localhost` 가 `::1` 로 먼저 풀려 실패했다" 는 과거 결함의 수정이고
  **과교정이다** — 옆의 `start` 는 같은 물음을 `serverconf` + `DialHost` 로 풀어
  `192.168.1.5` 바인드도 올바르게 두드린다. 그 인스턴스에 `health` 를 걸면
  언제나 실패한다.

  `window.go:25-27` 의 주석이 직접 이렇게 적는다:
  > FR-WIN-2: 대상 주소를 `start` 와 같은 규칙으로 정한다. 두 곳이 다르면
  > 띄운 자리와 여는 자리가 어긋난다.

  **주석이 말하는 불변식을 코드가 지키지 않는다.** 파일 계층이 빠져 있다.

- **어느 쪽이 맞는가**: `start` 다. 근거는 셋이다 — ① FR-CFG-13 이 4계층을 계약으로
  적었고 ② `serverconf.Resolve` 가 그 계약의 **유일한 구현**으로 만들어졌으며
  ③ `start` 만이 `conf.Err()` 로 잘못된 포트를 `net.Listen` 전에 잡는다.
  나머지 넷은 그 함수가 생기기 전의 코드가 남은 것이다.

- **제안**: `Common` 에 겨냥 해석 하나를 두고 겨누는 명령 전부가 그것을 쓴다.
  ```go
  // internal/ctl/cli/options.go
  // Target 은 이 명령이 겨누는 서버다. 계층은 start 와 같다 (FR-CFG-13) —
  // 겨누는 명령이 start 와 다른 서버를 보면 죽이는 대상도, 여는 창도 어긋난다.
  type Target struct {
      Home string
      Host string // DialHost 를 지난 값 — 그대로 두드릴 수 있다
      Port string
      URL  string // dmenv.BaseURL(Host, Port)
  }

  func (c Common) ResolveTarget() (Target, []string /*warnings*/, error)
  ```
  호출부 치환: `health.go:19-37` · `window.go:26-30` · `stop.go:10-15` · `migrate.go:34-39`.
  `RunStart` 은 이미 같은 일을 하므로 그쪽으로 몸통을 옮기고 `startFlagHost` 만 덧댄다.
  검사는 `server.json` 에 포트를 적고 다섯 명령이 같은 포트를 보는지 한 표로 돈다.

- **위험도**: MED (`stop` 의 대상이 바뀐다 — 의도된 변경이지만 동작 변경이다)
- **공수**: M

---

### [HIGH] 3. 기본 로그 경로에 답이 셋 — 진단 명령 넷이 틀린 값을 낸다

- **위치**
  - `internal/ctl/cli/start.go:308-320` — **실제로 쓰이는 값**: `$DONGMINAL_LOG` → `<home>/server.log` → `defaultLogFile()`
  - `internal/shared/platform/paths.go:65` — `posixPaths.DefaultLogFile()` = `/tmp/dongminal.log`
  - `internal/ctl/cli/options.go:50` — `defaultLogFile()` 가 그것을 그대로 낸다
  - 그 값을 그대로 내는 곳: `config.go:90,150`(`config show` 의 `logFile` 행) ·
    `doctor.go:132`("로그 기본 경로 = …") · `help.go:63`("기본: …") ·
    `service.go:94,164-165`(launchd `StandardOutPath`) · `logcap.go:106-108`(`WatchLogSize`)
- **현상**: 04-secops P1-6 이 기본 로그를 `/tmp/dongminal.log` 에서 `<home>/server.log`
  로 옮겼는데(`start.go:310-315` 가 그 근거를 적는다), **그 이동이 `prepareServerCmd`
  안에만 있다.** `serverconf.Inputs.DefaultLogFile` 로 흘러드는 값은 여전히 옛 것이다.
- **비용**:
  - `dongminal config show` 가 `logFile = /tmp/dongminal.log · source=default` 를 낸다.
    이 명령의 존재 이유가 FR-CFG-7 "값이 아니라 **출처**를 말한다" 인데, 출처는 맞고
    **값이 틀렸다.** 안 듣는 설정을 쫓는 사람이 정확히 그 화면에서 잘못된 경로로 간다.
  - `dongminal doctor`·`dongminal start --help` 도 같은 경로를 안내한다.
  - `service install` 이 만드는 launchd plist 의 `StandardOutPath` 가 `/tmp/dongminal.log`
    다 — 항목 12 참조. 이쪽은 표시가 아니라 **실제 동작**이고 보안 결정을 되돌린다.
  - `WatchLogSize` 는 우연히 구제된다: `capHomeLogs` 가 `homeLogs` 로 `server.log` 를
    따로 덮기 때문이다. 즉 `capLog(path,…)` 의 `path` 는 존재하지 않는 파일을 매 분 stat 한다.
- **제안**: 기본 로그 경로를 **한 함수**로 만들고 `prepareServerCmd` 도 그것을 쓴다.
  ```go
  // internal/ctl/cli/options.go
  // defaultLogFile 은 배경 모드 기동이 출력을 남길 자리다 (04-secops P1-6).
  // 홈이 있으면 그 아래이며(0700), 없을 때만 platform 의 자리로 물러선다.
  func defaultLogFile(home string) string {
      if home != "" {
          return filepath.Join(home, logFileName) // logFileName = "server.log"
      }
      return platform.Current().Paths.DefaultLogFile()
  }
  ```
  호출부 6곳에 `home` 을 넘긴다. `usageStart()` 는 홈을 모르므로 문구를
  "`$DONGMINAL_HOME/server.log`" 로 적는다 (그 편이 실제로도 정확하다).
  `platform.Paths.DefaultLogFile()` 의 머리말(`paths.go:63`, "종전 `cli.DefaultLog` 와
  같은 값이다")도 함께 고친다 — 그 문장이 지금은 거짓이다.
- **위험도**: LOW (표시 정정 + `service install` 산출물 변경)
- **공수**: S

---

### [HIGH] 4. `homeLayout()` 이 "홈의 전수 목록" 이 아니다 — 세 디렉터리가 빠져 있다

- **위치**
  - `internal/ctl/cli/homelayout.go:30-59` — "homeLayout 은 홈의 전수 목록이다"
  - 목록에 없는데 홈 아래에 만들어지는 것:
    - `cmd/dongminal/main.go:342` — `worktrees/` (Run 격리 worktree)
    - `cmd/dongminal/main.go:348` — `git-worktrees/` (**사용자 worktree**, FR-WKT-13)
    - `cmd/dongminal/main.go:365` — `ext/` (LSP 플러그인·언어 서버 설치 자리)
    - `internal/shared/toolipc/files.go:10` — `paned.build` (데몬 지문)
    - `internal/ctl/cli/doctor.go:288,392` — `doctor/`·`doctor-tools/`, `doctor_probe.go:204` — `doctor-probe.txt`
- **현상**: `homeLayout()` 은 `backup`(`backup.go:82`)·`uninstall`(`uninstall.go:125,140`)
  두 명령의 단일 출처인데, 실제 홈의 절반 정도만 안다.
- **비용**: 이 표의 머리말이 스스로 적은 위험이 그대로 실현된다 —
  > 두 벌로 적으면 한쪽만 고쳐지고, 그때 백업은 담지 않은 것을 제거는 지운다 —
  > **되돌릴 수 없는 손실이다.**

  실제 결과는 그 반대 방향이다:
  - **`git-worktrees/` 는 사용자 콘텐츠다.** `backup` 이 담지 않고 `uninstall --purge`
    도 지우지 않는다. 백업→복원을 한 사용자는 Git 창의 worktree 를 조용히 잃는다.
  - **`ext/` 는 가장 클 수 있는 디렉터리다** — 언어 서버(node_modules 포함)가 여기 산다.
    `uninstall --purge` 가 "전부 지웠습니다" 라고 말하고 수백 MB 를 남긴다.
  - `doctor-*` 잔여물은 `doctor` 가 죽으면 홈에 남고 아무도 거두지 않는다.
  - `paned.build` 는 항목 15 참조.
- **검사가 왜 못 잡았나**: `homelayout_test.go:32-40` 은 `rollbackTargets` 와 `homeLogs`
  가 표에 포함되는지만 본다 — 두 목록 모두 이미 표에 있는 것들이다. **표 밖에서 홈에
  쓰는 코드가 있는지**는 묻지 않는다.
- **제안**:
  1. 누락 항목을 표에 추가한다:
     ```go
     {Name: "worktrees",     IsDir: true, What: "Run 격리 worktree (정리는 Run 레코드가 정한다)", Ephemeral: true},
     {Name: "git-worktrees", IsDir: true, What: "Git 창에서 만든 사용자 worktree", Backup: true},
     {Name: "ext",           IsDir: true, What: "편집기 플러그인·언어 서버 (다시 받을 수 있다)", Ephemeral: true},
     {Name: toolipc.DaemonBuildFile, What: "도는 데몬의 코드 지문", Ephemeral: true},
     ```
     `git-worktrees` 의 `Backup: true` 는 판단이 필요하다 — worktree 는 실체가 git
     저장소 밖이므로 zip 에 담는 것이 맞는지 사용자 결정 대상이다. 최소한 **목록에는
     있어야** `uninstall` 이 그것을 지운다고 말할 수 있다.
  2. 표를 강제하는 검사를 추가한다. `scripts/` 에 이미 같은 형태의 게이트가 여럿 있다
     (`check-env-docs.sh` 가 본보기). 제안:
     ```
     scripts/check-home-layout.sh
       코드 쪽: filepath.Join(<home|cfg.DataDir>, "…") 의 첫 조각을 모은다
       문서 쪽: homeLayout() 의 Name 과 getting-started.md 의 "데이터가 어디 있나요" 표
       세 집합이 같아야 한다
     ```
- **위험도**: MED (`uninstall --purge` 가 더 많이 지우게 된다 — 의도된 것이나 동작 변경)
- **공수**: S (목록) / M (게이트 포함)

---

### [HIGH] 5. 문서-구현 괴리 4건 — §3 참조

별도 섹션으로 모았다. 요지: `scripts/check-env-docs.sh` 가 환경변수 **이름**만
양방향 대조하므로, **기본값과 의미**가 바뀐 자리는 게이트를 그냥 지나간다.

---

### [MED] 6. 홈 하위 경로 조립이 흩어져 있다

- **위치** (`filepath.Join(home, "…")` 리터럴)

  | 이름 | 자리 수 | 위치 |
  |---|---|---|
  | `"bin"` | 8 | `boot.go:59` · `app.go:56` · `doctor.go:82,119` · `health.go:66` · `doctor_probe.go:247` · `agenthooks.go:18` · `toolhub/tool.go:222` |
  | `"workspace.json"` | 7 | `main.go:300` · `boot.go:78` · `rollback.go:42,44` · `migrate/apply.go:20` · `httpapi/handlers_workspace_revert.go:29` · `homelayout.go:37` |
  | `"daemon.log"` | 4 | `main.go:135` · `verify_run.go:126` · `logcap.go:85` · `homelayout.go:55` |
  | `"paned.pid"` | 3 | `boot.go:94` · `cli/proc.go:20` · `migrate/apply.go:21` |
  | `"server.log"` | 4 | `start.go:316` · `verify_run.go:45` · `logcap.go:85` · `homelayout.go:54` |

- **현상**: 같은 저장소에 **이미 옳은 형태가 있다.** `dmenv.AgentHooksDirIn(binDir)`
  (`dmenv/helpers.go:31`) 의 머리말이 그 원칙을 정확히 적는다:
  > **이 이름을 아는 자리는 여기 하나다.** … 두 벌로 적으면 한쪽만 고쳐진다 —
  > 그 결함은 이 저장소가 이미 겪었다.

  `platform.SocketFileName`·`platform.LastExitFile`·`toolipc.DaemonBuildFile`·
  `serverconf.FileName`·`runfile.FileName`·`sandbox.ProfilesFileName` 여섯은 그 원칙을
  따랐다. 나머지는 따르지 않았다. **기준이 무엇인지 알 수 없는 것이 문제다** —
  새 파일을 더하는 사람이 어느 쪽 관례를 따를지 정할 근거가 없다.

- **비용**: `"bin"` 이 특히 나쁘다. `toolhub/tool.go:210-222` 와
  `platform/shell.go:99-103` 두 주석이 **같은 사고**(빈 `EnvHome` → 상대경로 `bin` →
  사용자 저장소의 `bin/bash-hook.sh` 가 훅으로 실행 = 임의 코드 실행)를 각각 적고 있다.
  방어는 두 곳에 따로 들어갔다(`toolBinDir()` 의 빈 값 반환 + `posixAbs`/`windowsAbs`).
  나머지 6곳은 그 방어가 없다 — 지금은 그 6곳이 `home` 을 이미 해석한 뒤라 안전하지만,
  그 안전이 **구조가 아니라 호출 순서**에 달려 있다.

- **제안**: `dmenv` 가 자리다 (의존 0, `DefaultHomeDir` 과 `AgentHooksDirIn` 이 이미 산다).
  ```go
  // internal/shared/dmenv/home.go — 홈 아래 이름의 단일 출처.
  // 세 프로세스(서버·데몬·제어 CLI)가 같은 자리를 가리켜야 한다.
  const (
      BinDirName       = "bin"
      WorkspaceFile    = "workspace.json"
      ToolsFile        = "tools.json"
      SettingsFile     = "settings.json"
      AccessFile       = "access.json"
      ServerLogFile    = "server.log"
      DaemonLogFile    = "daemon.log"
      DaemonPIDFile    = "paned.pid"
      ToolHistoryDir   = "tool-history"
      WorktreesDir     = "worktrees"
      UserWorktreesDir = "git-worktrees"
      ExtDir           = "ext"
      NotesDir         = "notes"
  )

  // BinDirIn 은 이 인스턴스의 bin 이다. home 이 비면 **빈 값**이다 —
  // 상대경로 `bin` 은 셸이 도구의 cwd 기준으로 풀어 임의 코드 실행이 된다
  // (toolhub/tool.go:210, platform/shell.go:99 가 같은 사고를 적는다).
  func BinDirIn(home string) string {
      if home == "" { return "" }
      return filepath.Join(home, BinDirName)
  }
  ```
  `BinDirIn` 이 빈 홈을 구조적으로 막으므로 8곳의 방어가 한 곳으로 모인다.
  `cli.homeLayout()` 의 `Name` 도 이 상수들을 참조하게 바꾸면 항목 4의 게이트가 쉬워진다.
- **위험도**: LOW (기계적 치환)
- **공수**: M (호출부 25곳 내외)

---

### [MED] 7. `unpackEmbedded` 가 살아 있는 셸이 읽는 파일을 비원자적으로 쓴다

- **위치**
  - `internal/shared/runtime/install.go:481` — `return os.WriteFile(target, data, mode)`
  - 대비: `internal/shared/platform/paths.go:296` — `WriteFileAtomic`
  - 대비: `internal/shared/platform/paths.go:88,236` — `LinkOrCopy`/`copyExecutable` 는 **원자적이다**
- **현상**: 헬퍼 링크(`dmctl`·`edit`·…)는 "옆에 만들고 rename 으로 덮는" 규약을 지키는데,
  그 헬퍼가 딛는 셸 훅(`bash-hook.sh`·`zdotdir/.zshrc`·`powershell-hook.ps1`)과
  에이전트 플러그인 18개 파일은 `os.WriteFile`(= `O_TRUNC` 후 쓰기)로 간다.
- **비용**: `paths.go:236` 의 `copyExecutable` 머리말이 이 위험을 이미 적었다:
  > 제자리를 `O_TRUNC` 로 열면 그 순간부터 복사가 끝날 때까지 dst 는 빈 파일이고,
  > 그 창에 exec 한 훅은 죽는다 (V-ATI-5 가 이것을 실측으로 잡는다).

  `FR-ATI-1` 의 근거는 **실측 5,037회**(RECONNECT_STORM_SRS §2.3)다. 같은 논증이
  셸 훅에 더 강하게 적용된다 — bash 훅은 `--rcfile` 로 **모든 새 도구 셸이 읽고**,
  zsh 훅은 `ZDOTDIR/.zshrc` 로 마찬가지다. 그 창에 뜬 탭은 훅 없는 셸이 되고,
  그러면 cwd 추적·`claude` 래퍼·`open` 가로채기가 통째로 죽는다 —
  그리고 **그 실패는 조용하다** (셸 자체는 정상이므로).

  창이 열리는 조건: ① `dongminal start` 중 다른 탭이 새 도구를 만들 때
  ② 항목 8의 이중 설치가 겹칠 때 ③ 데몬이 감시자에 의해 재기동할 때
  (`main.go:66` 의 `spawn` 클로저는 서버가 도는 내내 살아 있다).
- **제안**: 같은 패키지의 원자적 쓰기를 쓴다. `platform` 은 이미 `runtime` 의 의존이다.
  ```go
  // install.go:481
  - return os.WriteFile(target, data, mode)
  + // 살아 있는 셸이 이 파일을 읽는다 — O_TRUNC 의 창에 뜬 도구는 훅 없는
  + // 셸이 되고 그 실패는 조용하다 (FR-ATI-1 과 같은 근거).
  + return platform.WriteFileAtomic(target, data, mode)
  ```
  `pruneToEmbedded` 의 `os.RemoveAll` 도 같은 계열이지만 그쪽은 "임베드에 없는 것"
  만 지우므로 창이 생기지 않는다.
- **위험도**: MED (설치 경로 전량이 지나는 함수)
- **공수**: S

---

### [MED] 8. `runtime.Install` 이 부팅마다 두 번 돈다

- **위치**
  - `cmd/dongminal/app.go:56` — `runtime.Install(filepath.Join(home, "bin"))` (웹서버)
  - `internal/daemon/boot/boot.go:59` — 같은 호출 (데몬)
- **현상**: 두 프로세스가 **같은 디렉터리에** 같은 자산을 각자 설치한다. 순서는
  `buildApp` → (`dialOrStartDaemon` 이 데몬을 띄우면) `boot.Run` 이다.
- **비용**: 실측 (darwin/arm64 M4, APFS, 페이지 캐시 warm):
  ```
  BenchmarkInstall      4,178 µs/op   (cold — 임시 디렉터리에 신규 설치)
  BenchmarkInstallWarm  2,041 µs/op   (warm — 이미 설치된 자리에 재설치)
  ```
  **시간은 문제가 아니다** — 두 번째 호출이 2ms다. 값은 두 군데 다른 곳에 있다:
  1. **정확성**: 두 설치가 겹칠 수 있고, 그 창이 항목 7의 truncation 창이다.
     감시자에 의한 데몬 재기동은 서버가 도는 내내 일어날 수 있다.
  2. **이식성**: 이 숫자는 M4 + APFS 다. Windows 에서는 18개 파일 각각에
     Defender 스캔이 붙고, 네트워크 홈(NFS/SMB)에서는 `Sync()` 없이도 왕복이 붙는다.
     `LinkOrCopy` 5회 + `fs.WalkDir` 3회(unpack·prune 2패스)가 그 배수를 탄다.
  - 재고: **설치의 주체가 둘일 이유가 없다.** `bin/` 은 인스턴스 자산이고,
    데몬은 그것을 **소비**할 뿐이다(`toolhub.toolBinDir()` 이 도구 셸의 PATH 에 얹는다).
    데몬이 설치하는 이유는 "데몬이 먼저 떠 있을 수 있다" 일 텐데, 실제 기동 순서는
    `startDaemon` 이 서버의 자식이므로(`main.go:120`) **서버가 언제나 먼저 설치한다.**
    데몬이 단독으로 뜨는 경로는 `dongminald` 를 사람이 직접 부르는 경우뿐이다.
- **제안**: 둘 중 하나.
  - (A) 데몬 쪽을 **점검으로 낮춘다** — `runtime.InspectHelpers(binDir)` 가 이미 있고
    "설치된 적 없음"과 "깨짐"을 가른다. 없거나 깨졌을 때만 `Install` 한다.
    ```go
    // boot.go:59
    binDir := dmenv.BinDirIn(home)
    if st := runtime.InspectHelpers(binDir); !st.Installed || len(st.Problems) > 0 {
        // 데몬을 직접 띄운 경우다 — 정상 경로에서는 서버가 이미 깔았다.
        if err := runtime.Install(binDir); err != nil { … }
    }
    ```
  - (B) 설치를 멱등 **캐시**로 만든다 — `bin/.helpers` 매니페스트가 이미 있으므로
    거기에 바이너리 mtime/판을 함께 적고, 같으면 건너뛴다.

  (A) 를 권한다. 더 단순하고, `InspectHelpers` 의 계약("고치지 않는다, 진단만 한다")
  과도 맞물린다 — 여기서는 고치는 쪽이 맞지만 판정은 그 함수가 이미 한다.
- **위험도**: LOW
- **공수**: S

---

### [MED] 9. `cli.Actions` 가 낡은 중복 — 액션 15개 중 6개만 검사가 돈다

- **위치**
  - `internal/ctl/cli/options.go:52-54` — `var Actions = []string{"start","stop","migrate","health","doctor","verify"}`
  - `internal/ctl/cli/actions.go:39-` — `actionsOf()` 가 **15개**를 낸다
    (start · stop · migrate · rollback · window · backup · restore · uninstall ·
     service · update · config · health · doctor · verify · version)
- **현상**: `Actions` 의 주석은 "help 에 나열되는 액션 이름이다" 인데,
  `Help()`(`help.go:20`)는 `actionsOf()` 에서 나온다. **제품 코드에서 `Actions` 를
  읽는 곳은 하나도 없다** — `dispatch_test.go:64,77` · `options_test.go:175,189` ·
  `verify_test.go:123` 네 검사 파일뿐이다.
- **비용**: `actions.go:8-21` 의 머리말이 "액션 하나가 네 곳에 흩어져 있었다" 를
  고치며 만든 것이 그 표인데, **다섯 번째 자리가 남아 있고 그것이 검사의 입력이다.**
  결과: `options_test.go` 가 도는 "모든 액션이 `--help` 를 지원한다" 류 불변식이
  **9개 액션에 적용되지 않는다** — `rollback`·`window`·`backup`·`restore`·
  `uninstall`·`service`·`update`·`config`·`version`. 액션을 더한 사람은 표에만
  적으면 되고 그 액션은 검사를 지나지 않는다. **낡은 중복이 커버리지 공백을 가린다.**
- **제안**:
  ```go
  // options.go — Actions 를 지우고 actions.go 에 둔다.
  // ActionNames 는 표에서 나온다. 손으로 적은 목록은 조용히 낡고,
  // 그 목록을 입력으로 삼는 검사는 낡은 만큼 덜 돈다.
  func ActionNames() []string {
      as := actionsOf()
      out := make([]string, 0, len(as))
      for _, a := range as { out = append(out, a.name) }
      return out
  }
  ```
  검사 4곳을 `ActionNames()` 로 바꾸면 9개가 새로 검사를 받는다 —
  **먼저 그 9개가 통과하는지 확인해야 한다** (이 감사는 읽기 전용이라 돌리지 않았다).
- **위험도**: LOW (검사만 바뀐다 — 다만 새로 실패가 드러날 수 있다)
- **공수**: S

---

### [MED] 10. `envOr` 가 두 패키지에 똑같이 두 벌

- **위치**
  - `internal/helper/runtimebin/http.go:16-21`
  - `internal/shared/sandboxplace/wire.go:47-52`
- **현상**: 한 글자도 다르지 않은 같은 함수:
  ```go
  func envOr(key, fallback string) string {
      if v := os.Getenv(key); v != "" { return v }
      return fallback
  }
  ```
- **비용**: 지금은 해가 없다. 값은 **자리**에 있다 — `dmenv/tuning.go` 가
  "종전에는 셋이 `toolhub`·`hub` 에 흩어져 각자 파싱했다 — 규칙이 세 벌이면
  한 벌만 고쳐진다" 를 근거로 `MillisEnv`·`FlagEnv` 를 만들었는데, **같은 계열의
  세 번째 읽기 규칙이 그 패키지 밖에 두 벌 남아 있다.**
- **제안**: `dmenv/tuning.go` 에 넣는다 — 이웃 둘과 같은 자리다.
  ```go
  // StringEnv 는 문자열 변수를 읽는다. 비면 def — 빈 문자열은 "정하지 않음"이며
  // serverconf.pick 의 계층 규칙과 같은 뜻이다 (FR-CFG-13).
  func StringEnv(name, def string) string {
      if v := os.Getenv(name); v != "" { return v }
      return def
  }
  ```
  두 `envOr` 를 지우고 `dmenv.StringEnv` 로 바꾼다 (호출 6곳).
- **위험도**: LOW
- **공수**: S

---

### [MED] 11. `dmctl` 이 `dmenv.DialHost` 를 지나지 않는다

- **위치**
  - `internal/helper/runtimebin/http.go:24-29` — `baseURL()`
  - 대비: `internal/ctl/cli/start.go:376-378` — `pingHost` 는 `dmenv.DialHost` 를 쓴다
  - 소비자 24곳 (`dmctl.go:485,538` · `detach.go:158,191,210` · `edit.go:39` · `openurl.go:51` 외)
- **현상**: `dmenv/host.go:58-66` 이 `DialHost` 를 만든 근거를 적는다 —
  "host 에 뜬 서버를 실제로 두드릴 주소다 … 미지정 주소만 바꿔 준다".
  `cli` 는 그것을 쓰고 헬퍼는 쓰지 않는다. `--expose` 로 띄우면
  `app.go:47` 이 `DONGMINAL_HOST=0.0.0.0` 을 심고, 그 값이 `os.Environ()` 을 타고
  도구 셸까지 흘러(`toolhub/tool.go:311`) `baseURL()` 이 `http://0.0.0.0:<port>` 를 만든다.
- **비용**: 실측으로 darwin/Go 에서는 **동작한다** (`0.0.0.0` 으로 connect 하면
  커널이 loopback 으로 해석한다 — 200 응답 확인). 그래서 아무도 눈치채지 못했다.
  깨지는 곳은 둘이다:
  - **Windows**: `connect()` to `0.0.0.0` 은 `WSAEADDRNOTAVAIL` 이다.
    `--expose` 로 띄운 Windows 인스턴스에서 `dmctl`·`edit`·`detach`·`open-url`·
    에이전트 훅(`dmctl activity`·`dmctl notify`)이 **전부 죽는다.**
    그 실패는 조용하다 — `dmctl_activity.go:86,147,249` 는 반환을 버린다.
  - **컨테이너**: `sandboxplace` 가 `ExecEnv{Port: p.port}` 만 넘기므로 샌드박스 안
    dmctl 의 호스트는 컨테이너의 `DONGMINAL_HOST` 다. 같은 경로를 탄다.
- **제안**: 한 줄이다.
  ```go
  // http.go:24 — 서버가 `0.0.0.0`/`::` 에 바인드했을 때 그 주소로는 두드릴 수
  // 없는 호스트가 있다. 판정은 dmenv 한 벌이다 (TLS-2).
  func baseURL() string {
      return dmenv.BaseURL(envOr(dmenv.EnvHost, dmenv.DefaultHost),
                           envOr(dmenv.EnvPort, dmenv.DefaultPort))
  }
  ```
  (`dmenv.BaseURL` 은 항목 1의 제안과 같은 함수다 — 두 항목이 한 변경으로 닫힌다.)
- **위험도**: LOW
- **공수**: S

---

### [MED] 12. `service install` 이 감독자 로그를 세계 읽기 가능한 자리에 박는다

- **위치**
  - `internal/ctl/cli/service.go:164-165` — `<key>StandardOutPath</key><string>` + `conf.LogFile.Value`
  - `internal/ctl/cli/service.go:94` — `DefaultLogFile: defaultLogFile()` → `/tmp/dongminal.log`
- **현상**: 항목 3의 표시 문제가 여기서는 **실제 동작**이 된다. `server.json` 에
  `logFile` 을 적지 않은 사용자가 `dongminal service install` 을 하면 launchd/systemd 가
  로그를 `/tmp/dongminal.log` 로 리다이렉트한다.
- **비용**: 04-secops P1-6 이 로그를 홈으로 옮긴 근거(`start.go:310-315`):
  > 공유 디렉터리의 예측 가능한 이름이고, 그 로그에는 `RemoteAddr`·도구 cwd·
  > 헤드리스 명령이 남는다. 홈은 0700 이므로 같은 호스트의 다른 UID 가 읽지 못한다.

  감독자 설치는 **상시 운영을 전제하는 경로**라 그 로그가 가장 오래 쌓이는 자리다.
  게다가 `prepareServerCmd` 의 `0600`(`start.go:325`)도 적용되지 않는다 —
  파일을 만드는 것은 launchd 이고 그 모드는 umask 가 정한다.
  또한 `homeLogs`(`logcap.go:85`) 밖이라 **상한도 걸리지 않는다** —
  `WatchLogSize` 는 `$DONGMINAL_LOG` 만 따로 보는데 그 변수는 비어 있다.
- **제안**: 항목 3의 `defaultLogFile(home)` 을 고치면 자동으로 닫힌다.
  추가로 plist/unit 에 `DONGMINAL_LOG` 를 명시로 심어 두면 `WatchLogSize` 의
  상한이 걸린다 (지금은 `EnvHome`·`EnvHost`·`PORT`·`EnvLogLevel` 넷만 심는다).
- **위험도**: MED (이미 설치한 사용자의 plist 는 자동으로 고쳐지지 않는다 —
  `service.go:143` 의 "이 파일은 다시 생성되지 않습니다" 가 그것을 말한다.
  릴리스 노트에 재설치 안내가 필요하다)
- **공수**: S

---

### [MED] 13. `DONGMINAL_SHELL` 이 Windows 에서만 듣는다

- **위치**
  - `internal/shared/platform/shell.go:269-272` — `windowsShell.pick()` 만 읽는다
  - `internal/shared/platform/shell.go:203-212` — `posixShell.pick()` 은 `$SHELL` 만 본다
  - `docs/external/getting-started.md:326` — "도구 셸로 띄울 프로그램을 강제합니다"
- **현상**: 문서는 플랫폼을 가리지 않고 적었고, `scripts/check-env-docs.sh` 는
  **이름만** 대조하므로 이 비대칭을 잡지 못한다. (그 스크립트의 머리말이
  `DONGMINAL_SHELL` 을 "문서 밖에 있던 다섯" 중 하나로 적는다 — 이름은 들어왔지만
  의미는 절반만 참이다.)
- **비용**: macOS/Linux 사용자가 이 변수로 도구 셸을 바꿀 수 없다. 대안은 `$SHELL`
  뿐인데 그것은 **사용자 로그인 셸 전체**를 바꾸는 것이라 범위가 다르다.
  또 하나: 리터럴이 `dmenv` 밖에 있어 심는 쪽/읽는 쪽 대조가 불가능하다.
- **제안**:
  ```go
  // dmenv/dmenv.go — 도구 셸 관련 변수들 옆.
  // EnvShell 은 도구 셸로 띄울 프로그램을 강제한다. 비면 플랫폼이 고른다.
  EnvShell = "DONGMINAL_SHELL"
  ```
  `posixShell.pick()` 에 같은 갈래를 더한다 — **`$SHELL` 보다 먼저** 본다
  (Windows 쪽이 후보 목록보다 먼저 보므로 우선순위를 맞춘다):
  ```go
  func (s posixShell) pick() string {
      if v := s.env(dmenv.EnvShell); v != "" && s.stat(v) == nil { return v }
      if v := s.env("SHELL"); v != "" && s.stat(v) == nil { return v }
      …
  }
  ```
  주의: `platform` 은 "`internal/` 안의 다른 패키지를 import 하지 않는다"
  (`platform.go:17`, FR-XPL-6). 그러므로 `dmenv` 를 import 할 수 없다 —
  이름은 `platform` 안의 상수로 두고 `dmenv` 가 그것을 재노출하거나,
  이름만 `platform` 에 두고 문서 게이트가 그것을 세게 한다.
  **후자를 권한다** (지금 `check-env-docs.sh` 가 이미 `internal/` 전체를 훑는다).
  둘 중 어느 쪽이든 `IsExecutable` 로 검사하는 편이 낫다 — `s.stat` 은 존재만 본다.
- **위험도**: LOW
- **공수**: S

---

### [LOW] 14. 상수를 두고도 리터럴로 재선언한 셋

- **위치**
  - `internal/ctl/cli/options.go:29` — `EnvLog = "DONGMINAL_LOG"`
    vs `internal/shared/serverconf/conf.go:140` — `EnvLogFile = "DONGMINAL_LOG"`
  - `internal/ctl/cli/options.go:26` — `EnvPort = "PORT"`
    vs `internal/shared/serverconf/conf.go:122` — `{"PORT", getenv("PORT")}` (리터럴)
    vs `internal/ctl/cli/service.go:161,183` — `<key>PORT</key>` / `Environment=PORT=` (리터럴)
  - `internal/ctl/cli/proc.go:20` — `daemonPIDFile = "paned.pid"`
    vs `internal/ctl/migrate/apply.go:21` — `daemonPIDFile = "paned.pid"`
    vs `internal/daemon/boot/boot.go:94` — `filepath.Join(home, "paned.pid")` (리터럴)
  - `cmd/dongminal/main.go:135` — `"DONGMINAL_HOME="+home` (리터럴, `dmenv.EnvHome` 이 있다)
- **현상**: 같은 파일(`options.go:26-40`)에서 `EnvHome`·`EnvHost`·`EnvToolID` 는
  올바르게 `dmenv.*` 를 별칭하는데 `EnvLog`·`EnvPort` 만 리터럴이다.
  `daemonSockFile = platform.SocketFileName` 은 올바른데 `daemonPIDFile` 은 리터럴이다.
  **한 줄 옆에서 규칙이 갈린다.**
- **비용**: 지금은 값이 같아서 해가 없다. 값은 일관성에 있다 — 옆줄과 규칙이 다르면
  다음 사람이 어느 쪽을 따를지 모른다. `main.go:135` 는 특히 눈에 띈다 (같은 파일
  `main.go:441` 이 `dmenv.EnvHome` 을 쓴다).
- **제안**:
  - `cli.EnvLog` → `serverconf.EnvLogFile` 별칭. (`start.go:308`·`logcap.go:106` 호출)
  - `PORT` → `serverconf.EnvPortLegacy = "PORT"` 를 새로 두고 네 자리가 참조.
    이름이 계약이므로(`check-env-docs.sh` 가 특수 취급한다) 상수화가 특히 값이 있다.
  - `daemonPIDFile` → 항목 6의 `dmenv.DaemonPIDFile`. `platform.SocketFileName` 과
    짝이 맞는 자리에 두는 편이 더 자연스럽다면 `platform.PIDFileName` 도 가능하다 —
    그 둘은 같이 만들어지고 같이 치워진다(`proc.go:156-157`, `paned_server.go:222`).
  - `main.go:135` → `dmenv.EnvHome+"="+home`
- **위험도**: LOW
- **공수**: S

---

### [LOW] 15. `paned.build` 지문이 정상 종료에서 치워지지 않는다

- **위치**
  - `internal/daemon/ipc/paned_server.go:215-227` — `Close()` 가 `sockPath`·`pidPath` 만 지운다
  - `internal/daemon/ipc/paned_server.go:141-159` — `recordDaemonBuild()`
  - `internal/ctl/cli/staleness.go:59-68` — `inspectDaemon` / `recordedDaemonBuild`
- **현상**: `recordDaemonBuild` 의 머리말이 FR-DFP-5 를 적는다 —
  "지문을 모르면 앞선 데몬이 남긴 것을 **지운다** … 침묵보다 나쁜 것은 틀린 말이다".
  그 원칙이 **기동 경로에만** 있고 종료 경로에는 없다.
- **비용**: 지금은 `classifyDaemon`(`staleness.go:44-56`)이 `alive` 를 먼저 보므로
  데몬이 죽었으면 `DaemonNotRunning` 이 되어 지문을 읽지 않는다 — **결함이 아니다.**
  값은 두 가지다:
  1. `paned.pid` 가 남고 그 pid 가 재사용되면 `daemonPID` 가 `alive=true` 를 내고,
     그때 낡은 지문이 "일치" 로 읽힌다. `daemonOurs`(`proc.go:150-163`)는 소켓까지
     물어 이 경우를 막는데, `inspectDaemon` 은 `daemonPID` 만 쓴다
     (NFR-DFP-2 가 "소켓에 붙지 않는 것이 계약" 이라 의도된 것이다).
     즉 **판정의 두 입력이 서로 다른 강도의 생존 판정을 쓴다.**
  2. 항목 4 — `homeLayout` 에 없어서 `uninstall` 이 이 파일을 남긴다.
- **제안**: `Close()` 에 한 줄.
  ```go
  // paned_server.go:222 부근
  // 지문은 **도는 데몬**의 것이다. 내려가면서 남기면 다음 판정이 그것을
  // 지금 것으로 읽는다 (FR-DFP-5 의 종료 쪽 짝).
  if ps.buildPath != "" { _ = os.Remove(ps.buildPath) }
  ```
  그리고 항목 4의 목록에 `toolipc.DaemonBuildFile` 을 넣는다.
- **위험도**: LOW
- **공수**: S

---

### [LOW] 16. 고아 주석 — 없는 필드를 설명한다

- **위치**: `internal/shared/toolhub/manager.go:121-130`
  ```go
  type BackgroundEntry struct {
      ToolID string `json:"toolId"`
      Name   string `json:"name"`
      Cwd    string `json:"cwd"`
      Since  int64  `json:"since"`
      // Kind 는 도구의 종류다 (M8_UNIFIED_SRS FR-ABG-1) — 되살릴 때 어느 뷰의 탭으로
      // 돌아가는가. 비어 있으면 터미널.
  }
  ```
- **현상**: `Kind` 필드가 없다. 같은 이름의 필드는 `toolhub/hub.go:19` 에 실재한다.
- **비용**: FR-ABG-1 을 찾는 사람이 이 자리를 보고 "구현됐다" 고 읽는다.
  `manager.go:131-136` 의 `Placement` 주석도 같은 모양이다 — 타입은
  `manager_create.go:19` 에 있고 여기 주석만 남았다.
- **제안**: 두 주석을 실제 선언 옆으로 옮긴다 (`hub.go:19` 에는 이미 같은 내용이
  있으므로 `manager.go` 쪽은 삭제로 족하다).
- **위험도**: LOW
- **공수**: S

---

### [LOW] 17. `usageBackup`·`usageUninstall` 이 `homeLayout` 을 손으로 베낀다

- **위치**
  - `internal/ctl/cli/help.go:179-181` — `담는 것: workspace.json · settings.json · … · notes/`
  - `internal/ctl/cli/help.go:182-183` — `담지 않는 것: 로그 · 소켓 · pid · bin/ · tool-history/`
  - `internal/ctl/cli/help.go:200-201` — `기본은 다시 만들어지는 것만 지운다 — 로그·소켓·pid·bin/·tool-history/`
  - 출처: `internal/ctl/cli/homelayout.go:62-70` — `backupNames()`
- **현상**: `actions.go:8-21` 과 `homelayout.go:5-13` 두 머리말이 모두
  "손으로 적은 목록은 조용히 낡는다" 를 근거로 표를 만들었는데, 그 표의 내용을
  설명하는 도움말이 다시 손으로 적혀 있다.
- **비용**: 항목 4로 표에 `git-waorktrees` 를 더하면 이 세 문구가 낡는다.
  실제로 이미 한 번 낡았다 — `sandbox.json` 은 표(`homelayout.go:43`)에 있고
  `usageBackup` 에도 있지만, 표에 `runs.json` 을 더한 시점과 도움말을 고친 시점이
  같았다는 보장이 없다 (지금은 우연히 맞다).
- **제안**: `usage` 가 함수인 이유가 이미 "본문이 `commonFlags`·`defaultLogFile()` 을
  엮기 때문"(`actions.go:29`)이다. 같은 논리로 목록도 엮는다.
  ```go
  func usageBackup() string {
      return `… 담는 것:   ` + strings.Join(backupNames(), " · ") + `
    담지 않는 것: ` + strings.Join(ephemeralNames(), " · ") + ` …`
  }
  ```
  `ephemeralNames()` 는 `backupNames()` 와 같은 모양으로 `homelayout.go` 에 더한다.
- **위험도**: LOW
- **공수**: S

---

### [LOW] 18. `buildCommonDeps` 113줄 — 도메인 조립이 한 함수에

- **위치**: `cmd/dongminal/main.go:298-411`
- **현상**: workspace · adapters · runStore · git core · worktree ×2 · sysstat ·
  git store · ext · lsp(+ 진단 콜백) 아홉 묶음을 한 함수가 만든다.
  **70줄 넘는 함수 26개 중 책임이 둘 이상인 것은 이것 하나다** — 나머지는
  표(`actionsOf`·`verifyChecks`)이거나 프로토콜 디코더(`codexDecode*`)다.
- **비용**: 낮다. composition root 이므로 여기 모이는 것이 옳고, 각 묶음에 근거
  주석이 붙어 있어 읽기도 어렵지 않다. 값은 하나 — `lspSvc.OnDiagnostics` 콜백
  (`main.go:373-387`)이 **`cmdHub` 하나만 쓰면서 함수 전체 스코프를 잡는다.**
  그 클로저는 서버 수명 내내 산다.
- **제안**: 억지로 쪼개지 않는다. 다만 콜백 하나는 밖으로 뺀다 — 스코프를 좁히고
  이름이 무엇을 방송하는지 말하게 한다:
  ```go
  // wireLSPDiagnostics 는 진단을 이미 있는 push 길로 밀어낸다 (FR-LSP-32, D-2).
  // cmdHub 하나만 쥔다 — 조립 함수 전체를 붙들 이유가 없다.
  func wireLSPDiagnostics(svc *lsp.Service, cmdHub *hub.CommandHub) { … }
  ```
  나눈다면 경계는 `builtDeps` 의 필드 묶음을 따른다 — `wireWorkspace` /
  `wireRuns` / `wireGit` / `wireEditor`. 지금 이득이 크지 않아 **보류를 권한다.**
- **위험도**: LOW
- **공수**: M

---

## 2. 성능 개선 기회

부팅 경로와 핫패스만 본다. 각 항목에 **실측 또는 측정 방법**을 붙였다.

### P1. [MED] `runtime.Install` 이중 실행 — 항목 8

- **실측**: `BenchmarkInstallWarm` = **2,041 µs/op** (darwin/arm64 M4, APFS, warm cache).
  cold 는 4,178 µs/op.
- **예상 효과**: darwin 에서 부팅당 **~2ms**. 무시할 만하다.
  **Windows·네트워크 홈에서 의미가 있다** — 18개 파일 쓰기 + `LinkOrCopy` 5회 +
  `fs.WalkDir` 3패스가 파일당 Defender 스캔 / SMB 왕복을 탄다. 미측정.
- **측정 방법**:
  ```
  # 세 OS 에서
  go test ./internal/shared/runtime -bench InstallWarm -benchtime 50x
  # 실환경 부팅
  dmlog 에 boot.Run / buildApp 의 Install 전후 타임스탬프를 넣고 비교
  ```
- **우선순위**: 시간보다 **항목 7의 정확성**이 이 변경의 주된 근거다.
  성능만으로는 하지 않아도 된다.

### P2. [MED] `ToolManager.SaveAll` 이 도구마다 `lsof` 를 fork 한다 (darwin)

- **위치**
  - `internal/shared/toolhub/persist.go:80` — `cwdOrServer(p)` (도구마다 1회)
  - `internal/shared/toolhub/tool_cwd.go:16-18` — `platform.Current().Info.CWD(pid)`
  - `internal/shared/platform/procinfo.go:99-107` — `darwinProcInfo.CWD` = `lsof -a -p … -d cwd -Fn`
- **현상**: `SaveAll` 은 도구 생성·삭제마다 `saveAsync` 로 떨어진다
  (`manager.go:288`). 도구 N개면 **N번의 `lsof` fork+exec** 다.
  `persist.go:25-28` 의 주석이 그 비용을 이미 안다 —
  "Cwd() can take tens to hundreds of ms on macOS (lsof)" — 그래서 잠금 **밖**으로
  뺐지만 **횟수는 줄이지 않았다.**
- **예상 효과**: 도구 20개 기준 `SaveAll` 한 번이 20회 fork. `lsof` 한 번이
  10~50ms 라면 0.2~1.0초가 저장 고루틴에서 돈다. 요청 경로는 막지 않지만
  ① 종료 경로의 `StopSaving()` 이 그만큼 기다리고 ② 탭을 빠르게 여닫으면
  `saveFile` 뮤텍스에 저장이 줄을 선다.
- **제안**: `ProcInfo` 에 **일괄 조회**를 더한다. `Names(pids []int)` 가 이미 같은
  이유로 일괄이다 (`procinfo.go:29-31`: "도구마다 외부 프로세스를 띄우면 도구
  100개에서 갱신 주기를 넘긴다 (NFR-XP-4)"). **같은 논증이 `CWD` 에 그대로 있다.**
  ```go
  // ProcInfo 에 추가
  // CWDs 는 pid 들의 cwd 를 한 번에 읽는다. Names 와 같은 이유다 (NFR-XP-4).
  CWDs(pids []int) map[int]string
  // darwin: lsof -a -p 1,2,3 -d cwd -Fpn  (p 와 n 필드를 짝지어 읽는다)
  // linux:  pid 마다 readlink — 이미 프로세스를 띄우지 않으므로 루프로 족하다
  ```
  `SaveAll` 은 스냅샷 뒤 `CWDs(pids)` 한 번으로 표를 받는다.
- **측정 방법**:
  ```go
  // 도구 N개를 NewDetachedTool 이 아니라 실제 PTY 로 띄운 뒤
  b.Run("SaveAll/N=20", …)  // 현행 vs 일괄
  // 또는 실환경에서: dtruss -n lsof 로 SaveAll 한 번의 exec 수를 센다
  ```
- **위험도**: MED (`ProcInfo` 인터페이스 확장 — 어댑터 3개 구현 필요)
- **공수**: M

### P3. [LOW] `HeadlessToolIDs` 가 `SaveAll` 마다 `runs.json` 을 읽고 파싱한다

- **위치**
  - `internal/shared/toolhub/persist.go:56` — `owned := m.ownedTools()`
  - `cmd/dongminal/main.go:243` · `internal/daemon/boot/boot.go:76` — 그 provider 가
    `runfile.HeadlessToolIDs(home)` / `run.HeadlessToolIDs(cfg.DataDir)` 를 부른다
  - `internal/shared/runfile/runfile.go:56-76` — `os.ReadFile` + `json.Unmarshal`
- **현상**: `persist.go:54-55` 의 주석이 "도구마다 부르면 SaveAll 한 번이 파일을
  n번 읽는다" 를 근거로 루프 밖으로 뺐다. **한 번은 남아 있다.**
- **예상 효과**: 저장 한 번당 파일 읽기 1회 + JSON 파싱 1회. `runs.json` 이 작으면
  수십 µs 다 — **작다.** 적는 이유는 P2 와 같은 경로에 있어서 함께 보면
  한 번에 닫히기 때문이다.
- **제안**: 지금은 **하지 않기를 권한다.** 캐시를 두면 무효화 규칙이 생기고,
  그 규칙이 틀리면 헤드리스 도구를 잃는다(FR-HLM-3). 비용이 작으므로 복잡도를
  더할 근거가 없다. P2 를 할 때 같은 함수 안이니 측정만 함께 뜬다.
- **측정 방법**: `SaveAll` 에 `time.Since` 두 구간(owned / cwd)을 debug 로그로.

### P4. [LOW] `dmctl` 의 공용 HTTP 클라이언트가 10초를 잡는다

- **위치**: `internal/helper/runtimebin/http.go:47` — `httpClient = &http.Client{Timeout: 10s}`
- **현상**: 서버가 죽은 상태에서 에이전트 훅(`dmctl activity`·`dmctl notify`)이
  돌면 훅 하나가 최대 10초를 쓴다. 그 훅은 **에이전트의 매 턴마다** 돈다.
- **예상 효과**: 정상 경로에서는 영향 없다 (로컬 왕복은 ms 단위). 서버가 내려간
  동안 에이전트 세션이 턴마다 10초씩 멎는다.
- **제안**: `clientWithin` 이 이미 있다(`http.go:53-55`). 훅 계열 호출
  (`dmctl_activity.go:86,147,249` · `dmctl_notify.go:39` · `dmctl_agentcontext.go:97`)
  은 **반환을 버리는 fire-and-forget** 이므로 짧은 예산이 맞다:
  ```go
  // hookBudget 은 훅이 서버를 부를 때의 상한이다. 훅은 에이전트의 매 턴에
  // 돌고 결과를 쓰지 않으므로, 서버가 없을 때 턴을 멈춰 세울 이유가 없다.
  const hookBudget = 2 * time.Second
  ```
- **측정 방법**: 서버를 내린 뒤 `time dmctl activity …` 를 잰다.
- **위험도**: LOW
- **공수**: S

### P5. [정보] 부팅 경로의 블로킹 구간 — 현재 구조는 건전하다

읽은 범위에서 부팅 경로의 블로킹 작업은 다음이고, **문제로 볼 것이 없다**:
- `app.buildApp`: `serverconf.Resolve`(파일 1회) → `runtime.Install`(P1) →
  `dialOrStartDaemon`(최대 `daemonBusyWait` 3초 + `daemonReadyTries×Poll` 2초) →
  `buildDeps*`
- `dialOrStartDaemon`(`main.go:60-117`)은 이미 타임아웃과 폴링 상한을 갖고
  `pollwait.Until` 로 "세는 것은 횟수가 아니라 시간" 규약(M8 D-A-15)을 지킨다.
- `sampler`·`sweeper`·`gitWatch`·`accessRefresh`·`updates` 는 전부
  `a.run` 에서 `ctx.Done()` 에 묶여 **비동기로** 시작한다 (`app.go:149-229`).
- `ext.Deploy()`(`main.go:366`)는 임베드 선언만 편다 — 서버도 런타임도 받지 않는다.

이 구조는 잘 짜여 있다. 손대지 않기를 권한다.

---

## 3. 문서-구현 괴리

`scripts/check-env-docs.sh` 가 환경변수 **이름**을 양방향 대조한다 — 잘 만들어진
게이트이고 실제로 다섯 개를 잡아냈다. 아래 넷은 전부 **이름은 맞고 의미/기본값이
틀린** 것이라 그 게이트를 통과한다. 그것이 이 절의 공통 원인이다.

### D1. [HIGH] `DONGMINAL_LOG` 기본값 — P1-6 이전 값이 남아 있다

- **문서**
  - `docs/external/getting-started.md:311` — `` `DONGMINAL_LOG` | `/tmp/dongminal.log` ``
  - `docs/external/getting-started.md:425` — `` `$DONGMINAL_LOG` (기본 `/tmp/dongminal.log`) | 배경 모드 기동 로그 — **홈 밖입니다** | ❌ ``
  - `docs/external/getting-started.md:407` — "전부 `$DONGMINAL_HOME` 아래에 있습니다.
    **이 폴더 밖에 상태를 두지 않습니다** — 로그 하나만 예외입니다."
- **구현**: `internal/ctl/cli/start.go:308-320` — 기본은 `<home>/server.log` 다.
  `/tmp` 로 가는 갈래는 `home == ""` 일 때뿐이고, `RunStart` 는 그 위에서
  `MkdirAll(home)` 을 하므로 **도달하지 않는다.**
- **괴리**: 문서가 적은 "예외" 가 없어졌다. 04-secops P1-6 이 그것을 없애려고
  만든 변경인데, 문서는 그 예외를 여전히 설계의 특징으로 설명한다.
- **관련 FR**: 04-secops P1-6 (`start.go:310` 이 인용) · CONFIG_MANAGEMENT_SRS FR-CFG-7
- **고칠 곳**: 문서 두 줄 + 항목 3의 코드. **코드를 먼저 고쳐야 문서가 정확해진다**
  — 지금 `config show` 가 내는 값이 문서와 같고 둘 다 틀리다.

### D2. [HIGH] bash 훅 주입 방식 — `BASH_ENV` 는 더 이상 쓰이지 않는다

- **문서**: `docs/external/getting-started.md:395` — "bash → `BASH_ENV=$DONGMINAL_HOME/bin/bash-hook.sh`"
- **구현**: `internal/shared/platform/shell.go:87-94`
  ```go
  // bash 는 `BASH_ENV` 로 걸 수 없다 — 그것은 **비대화형** 셸만 읽고 도구
  // 셸은 대화형이다. 그래서 훅이 아예 로드되지 않았고, Linux 기본 환경에서
  // `claude` 래퍼·cwd 보고·`open` 가로채기가 전부 죽어 있었다 (§2.3).
  {"bash", func(b string, s *ShellSpec) {
      s.Args = []string{"--rcfile", filepath.Join(b, BashHookFile)}
  }},
  ```
- **괴리**: 문서가 **실패하는 것으로 확인된 방식**을 현행으로 적는다.
  HOST_PARITY_SRS FR-HPR-7 이 그것을 `--rcfile` 로 바꿨다.
- **비용**: 외부 터미널에서 훅을 흉내 내려는 사용자가 `BASH_ENV` 를 export 하고
  아무 일도 일어나지 않는 것을 본다 — 문서가 말한 그대로 했는데.
  같은 줄의 zsh(`ZDOTDIR`)는 맞다.
- **관련 FR**: HOST_PARITY_SRS FR-HPR-7 · CROSS_PLATFORM_SRS FR-XSH-4
- **고칠 곳**: `getting-started.md:395` →
  `` bash → `--rcfile $DONGMINAL_HOME/bin/bash-hook.sh` (인자로 건다 — `BASH_ENV` 는 대화형 셸이 읽지 않는다) ``
  같은 목록의 `bin/bash-hook.sh` 설명(`:389`)도 함께 본다.

### D3. [HIGH] 노출 시 허용 목록 강제 — M9 가 없앤 게이트를 문서가 유지한다

- **문서**: `docs/external/getting-started.md:309` — `DONGMINAL_HOST` 행 말미
  > "`192.168.x` 같은 주소도 노출이고, **그때는 Settings ▸ Access 의 허용 목록을
  > 켜야 서버가 뜹니다**"
- **구현**: `internal/ctl/cli/start.go:80-92`
  ```
  // M9_SRS FR-M9-1 / D-M9-1: **노출 게이트는 없다.**
  //   이전 동작: 셋 중 하나면 기동하지 않았다. 되돌리는 길은 `--insecure-no-acl` 하나
  //   새  동작: `--expose` 는 허용 목록의 상태와 무관하게 뜬다
  //   이유:     사용자 결정 (2026-09-14)
  ```
- **괴리**: 문서가 **존재하지 않는 안전장치**를 약속한다. 노출 판정만 맞다.
- **비용**: 이 문장은 보안 안내다. 읽은 사람이 "허용 목록을 안 켜면 안 뜨니까
  실수할 수 없다" 고 믿고 `--expose` 를 친다. 실제로는 뜨고, 인증이 없으므로
  같은 망의 누구나 셸을 얻는다 — D-M9-1 이 그 대가를 명시로 적었다.
  같은 문서의 `:228` ("`--expose` 만으로는 아무 보호가 없습니다")는 맞다 —
  **한 문서 안에서 두 문장이 서로를 반박한다.**
- **관련 FR**: M9_SRS FR-M9-1 / D-M9-1 · REQUEST_GATE_SRS FR-RQG-20 (철회됨)
- **고칠 곳**: `getting-started.md:309` 의 해당 절을 지우고
  `:228` 의 경고로 연결한다. `docs/internal/M9_SRS.md` 가 "이전 동작/새 동작/이유"
  형식을 이미 갖고 있으므로 그 문구를 옮기면 된다.

### D4. [MED] `DONGMINAL_SHELL` 이 Windows 전용이라는 사실이 없다 — 항목 13

- **문서**: `docs/external/getting-started.md:326` — "도구 셸로 띄울 프로그램을 강제합니다.
  비면 플랫폼 계층이 고릅니다"
- **구현**: `internal/shared/platform/shell.go:271` (windows) — posix 갈래에 없다
- **고칠 곳**: 코드를 고쳐 세 OS 에서 듣게 하는 편(항목 13)을 권한다.
  문서만 고칠 경우 "**Windows 에서만 적용됩니다**" 를 명시해야 한다.

### D5. [LOW] 홈 구성 표에 세 디렉터리가 없다 — 항목 4와 같은 뿌리

- **문서**: `docs/external/getting-started.md:407-425` — "데이터가 어디 있나요" 표
- **구현**: `cmd/dongminal/main.go:342,348,365` 가 `worktrees/` · `git-worktrees/` · `ext/` 를 만든다
- **괴리**: 문서와 `cli.homeLayout()` 이 **서로 일치하면서 둘 다 실제와 다르다.**
  이것이 항목 4의 게이트 제안이 셋(코드·표·문서)을 함께 세는 이유다.
- **관련 FR**: M5 `G10-3`(문서 절의 제목) · RUN_ORCHESTRATION_SRS 묶음 W(FR-WKT-9/10/13) ·
  LSP_PLUGIN_SRS / EDITOR_LSP_SRS(FR-EXT-22)

### D6. [정보] 검사 게이트가 덮는 것과 덮지 못하는 것

`scripts/` 의 문서 게이트 8종(`check-env-docs`·`check-commands-docs`·`check-api-docs`·
`check-error-docs`·`check-shortcuts-docs`·`check-decisions`·`check-srs-status`·
`check-cross`)은 전부 **이름·코드의 집합 대조**다. 값·의미·플랫폼 범위는 대조하지 않는다.

D1~D4 가 전부 그 틈에 있다. 제안:
```
scripts/check-env-defaults.sh  (새로)
  getting-started.md 의 "기본" 칸에서 백틱 리터럴을 뽑아
  dmenv/serverconf 의 Default* 상수와 대조한다.
  값이 코드 상수가 아닌 행(예: "(주입)"·"(내부)")은 건너뛴다.
```
이것으로 D1 은 구조적으로 닫힌다. D2~D4 는 자연어라 게이트가 어렵다 —
그쪽은 "동작을 바꾼 SRS 는 `docs/external/` 의 어느 줄을 고쳤는지 적는다" 는
규약이 더 싸다 (`M9_SRS` 의 "이전 동작/새 동작/이유" 블록에 한 줄 추가).

---

## 4. 패키지 경계 — `internal/shared` 는 잡동사니 서랍인가

**아니다.** 결론부터: 지금 구조는 의도적이고 대체로 옳다. 다만 한 자리에 응집도 문제가 있다.

### 4.1 `shared` 가 존재하는 근거는 명확하다

`dmenv/dmenv.go:5-9` 가 그 규칙을 적는다:
> 쓰는 쪽이 서로를 import 할 수 없기 때문이다. `internal/ctl/cli` 가
> `internal/helper/runtimebin` 과 `internal/shared/toolhub` 를 import 하므로,
> 그 둘은 `ctl/cli` 를 되받아 import 할 수 없다.

즉 `shared` 는 "네 축(① 헬퍼 ② 데몬 ③ 서버 ④ 제어 CLI)이 **함께 딛는** 것"
이라는 단일 기준을 갖는다. `scripts/check-pkg-axis.sh` 가 그 축을 집행한다.
`runfile` 패키지(`runfile.go:3-11`)가 그 기준의 교과서적 적용례다 —
`domain/run` 의 스키마를 데몬이 읽어야 해서 읽기 전용 프로젝션만 떼어 냈다.

### 4.2 하위 패키지는 응집적이다

24개 하위 패키지를 훑은 결과, **이름과 내용이 어긋나는 것은 없었다**:
`platform`(OS 차이) · `toolhub`(PTY 수명) · `agentadapter`(에이전트 프로토콜) ·
`sandbox`+`sandboxplace`(컨테이너, 배선 분리도 옳다) · `workspace` ·
`serverconf` · `dmenv` · `dmlog` · `outbuf` · `pollwait` · `runwait` ·
`updatecheck` · `settingsschema` · `toolipc` · `mimeprobe` · `diagtail` ·
`listorder` · `uuid` · `release` · `runfile` · `testpath` · `gittest`.

`testpath`·`gittest`·`agentadapter/fakeagent` 은 검사 전용이 `shared` 에 있는
형태인데, 이것도 근거가 있다 — 여러 축의 검사가 함께 쓴다.

### 4.3 문제가 있는 한 자리 — `platform` 의 크기와 혼재

`internal/shared/platform` 은 24개 파일 · ~3.0k LOC 로 `shared` 에서 가장 크고,
**두 종류가 섞여 있다**:

| 무엇 | 파일 | 성격 |
|---|---|---|
| OS 능력 추상 | `platform.go` · `process*.go` · `procinfo*.go` · `pty*.go` · `shell.go` · `ipc.go` · `browser.go` · `opener.go` · `oskind.go` · `paths.go`(인터페이스 부분) | 인터페이스 + OS 어댑터 |
| **파일 쓰기 규약** | `paths.go:296-424`(`WriteFileAtomic`·`replaceFile`·`tempSibling`·`copyExecutable`) · `statefile.go`(세대 회전) · `lastexit.go`(크래시 마커) | OS 무관한 **정책** |

뒤의 것들은 OS 차이가 아니다. `WriteFileAtomic`·`WriteStateFile`·`ReadLastExit`·
`MarkRunning` 은 **어느 OS 에서나 같은 알고리즘**이고, `replaceFile` 의 재시도만이
Windows 사정을 안다. 지금 `paths.go` 는 422줄 안에 `Paths` 인터페이스 정의,
posix/windows 어댑터, 그리고 원자적 쓰기 정책 셋이 함께 산다.

- **증상**: `platform.WriteStateFile` 을 쓰려는 사람이 "OS 추상 패키지" 를 import 한다.
  `sandboxplace/place.go:97` 이 그 예다 — 샌드박스 설정 저장이 `platform` 에 의존한다.
  의존 방향이 틀린 것은 아니지만, **이름이 하는 일을 말하지 않는다.**
- **제안**: `internal/shared/statefile` 로 뗀다 (이름은 이미 `statefile.go` 다).
  ```
  internal/shared/statefile/
    atomic.go    WriteFileAtomic · tempSibling · CopyExecutable
    replace.go   replaceFile (Windows 재시도 — 유일한 OS 지식)
    generation.go WriteStateFile · rotateGenerations · StateFileGenerations
    lastexit.go  ReadLastExit · MarkRunning · MarkCleanExit · LastExitFile
  ```
  `platform` 은 `statefile` 을 import 한다(`LinkOrCopy` 가 `replaceFile` 을 쓴다).
  역방향은 없으므로 순환하지 않는다. `platform.go:17` 의 규칙
  ("이 패키지는 `internal/` 안의 다른 패키지를 import 하지 않는다")에
  예외 하나를 명시로 적어야 한다 — 또는 `replaceFile` 만 `platform` 에 남기고
  `statefile` 이 그것을 주입받는다 (`func New(replace func(tmp,dst string) error)`).
  **후자를 권한다** — FR-XPL-6 을 깨지 않고, 이 저장소가 이미 쓰는 주입 관례
  (`linuxProcInfo.read`·`windowsShell.env`)와 같은 모양이다.

- **효과**: `platform` 이 순수 OS 추상으로 좁혀지고(~2.3k LOC),
  "상태 파일을 어떻게 쓰는가" 의 정책이 한 패키지에 모인다.
  그 정책은 지금 셋(원자성·세대·격리본 보존)이 세 파일에 흩어져 있고,
  `RetainQuarantined`(`statefile.go:38`) 같은 결정 상수가 OS 패키지에 있을 이유가 없다.
- **위험도**: LOW (기계적 이동 — 호출부는 import 경로만 바뀐다)
- **공수**: M

### 4.4 `ctl/cli` 의 크기 — 지금은 괜찮다

`internal/ctl/cli` 는 33파일 · ~4.5k LOC 로 크지만, `actionsOf()` 표가
액션 하나 = 파일 하나 구조를 유지하고 있어 탐색이 쉽다.
`homelayout.go`·`staleness.go`·`proc.go` 처럼 여러 액션이 함께 쓰는 것만
따로 서 있고, 그 분리 기준도 일관적이다. **쪼갤 근거를 찾지 못했다.**

---

## 5. 플랫폼 분기 — 일관되게 처리되는가

**매우 일관적이다.** 이 계층에서 가장 잘 된 부분이다.

`platform.go:1-19` 의 규약이 명확하고 실제로 지켜진다:
- 인터페이스와 **모든** 어댑터가 build tag 없이 컴파일된다 → windows 갈래도
  darwin 에서 검사된다 (§4.2). `winExecutableName`·`windowsLogFile`·`windowsAbs`·
  `linuxProcInfo`(주입된 `read`/`readLink`/`glob`) 전부 그 규약을 따른다.
- build tag 가 붙는 것은 번들 조립(`platform_darwin.go`·`platform_linux.go`·
  `platform_windows.go`)과 실제 syscall 어댑터뿐이다.
- `OSKind` 는 "표시·기록용이고 분기 근거가 아니다"(`oskind.go:7-11`) 를 명시하고,
  실제로 호출부에서 `OSKind` 로 갈라지는 코드는 `service.go:89-102` 한 곳뿐이다 —
  거기는 launchd/systemd 정의를 **문자열로 만드는** 자리라 OS 이름이 나오는 것이 맞다.

발견한 비일관은 셋이고 전부 위에 적었다:
- 항목 13 — `DONGMINAL_SHELL` 이 windows 갈래에만 있다 (**진짜 비대칭**)
- 항목 1 — IPv6 주소 조립이 OS 무관하게 틀렸다
- `posixShell.pick()`(`shell.go:204`)이 `s.stat` 으로 존재만 보는데
  `Paths.IsExecutable` 이 같은 패키지에 있다. `windowsShell.pick()` 은
  `s.look`(=`exec.LookPath`)을 써서 실행 가능성까지 본다.
  **같은 물음에 강도가 다른 두 답** — posix 쪽이 약하다.
  `/bin/bash` 가 존재하지만 실행 불가인 경우는 드물어 등급은 LOW 지만,
  `IsExecutable` 이 바로 옆에 있으므로 고칠 값이 있다:
  ```go
  // shell.go:204 — 존재가 아니라 실행 가능성을 본다. 실행할 수 없는 동명
  // 파일을 고르면 기동이 permission denied 로 죽고, 그 실패는 "없다" 가
  // 아니라 "우리 버그" 로 보인다 (Paths.IsExecutable 머리말과 같은 근거).
  ```
  주의: `posixShell` 은 `stat statFn` 만 주입받으므로 `IsExecutable` 을 쓰려면
  주입점을 하나 더 열어야 한다 (검사가 darwin 에서 돌아야 하므로 직접 호출 불가).

---

## 6. 불필요한 복잡도 · 죽은 코드

체계적으로 찾았고, **수확이 적다** — 이 계층은 이미 정리되어 있다.

- 죽은 export: `cli.Actions` (항목 9) — 유일하게 찾은 것.
- 고아 주석: `manager.go:128`(`Kind`) · `manager.go:131`(`Placement`) (항목 16)
- 파생 가능한 중복 상태: 없음. `ToolManager` 의 `mutated`/`background`/`fgCache` 는
  전부 근거 주석이 붙어 있고 파생 불가다.
  (`manager.go:100-110` 이 `dirty` → `mutated` 개명 이유까지 적는다.)
- 깊은 중첩: 없음. 가장 깊은 곳이 `pruneToEmbedded`(`install.go:404-450`)의
  `WalkDir` 안 3단이고 그것은 알고리즘상 필요하다.
- 도달 불가 갈래: `start.go:318` 의 `defaultLogFile()` 폴백 (항목 3에서 다룸).
  `RunStart` 는 그 위에서 홈을 만들므로 `home == ""` 로 오지 않는다.
  `verify_run.go:45` 는 경로를 명시로 넘기고, 그 외 호출자가 없다.

---

## 7. 권장 순서

같은 변경으로 여러 항목이 닫히는 순서로 묶었다.

**1차 (S, 저위험 — 먼저 고친다)**
1. 항목 1 + 11 — `dmenv.ListenAddr`/`BaseURL` 도입. `::1` 기동 실패와
   `dmctl` 의 `DialHost` 누락이 한 변경으로 닫힌다.
2. 항목 3 + 12 — `defaultLogFile(home)`. `config show`·`doctor`·`help` 의 표시와
   `service install` 의 보안 결정이 함께 닫힌다. D1 문서 수정도 여기서.
3. 항목 7 — `unpackEmbedded` → `WriteFileAtomic`. 한 줄.
4. 항목 16 — 고아 주석 정리. 항목 10 — `envOr` 통합.

**2차 (S~M — 동작 변경 포함, 검사 필요)**
5. 항목 4 — `homeLayout` 보강 + 게이트. 항목 15 를 함께.
6. 항목 2 — `Common.ResolveTarget()`. **가장 값이 크고 가장 조심해야 한다**
   (`stop` 의 대상이 바뀐다). 항목 4 이후가 좋다 — 그때는 홈 아래 자리가 확정된다.
7. 항목 9 — `ActionNames()`. 새로 드러나는 검사 실패를 먼저 확인한다.
8. 항목 13 + D4 — `DONGMINAL_SHELL` 의 posix 갈래.

**3차 (M — 구조)**
9. 항목 6 — 홈 경로 상수화. 항목 4 의 게이트가 이것을 쉽게 만든다.
10. §4.3 — `statefile` 패키지 분리.
11. 항목 8 — `runtime.Install` 이중 실행 제거 (항목 7 이후에).
12. P2 — `ProcInfo.CWDs` 일괄 조회.

**보류 권장**
- 항목 18(`buildCommonDeps` 분할) — 지금 이득이 크지 않다.
- P3(`HeadlessToolIDs` 캐시) — 복잡도를 더할 근거가 없다.

---

## 부록 — 감사 방법과 한계

- **읽은 것**: `internal/shared/`(24 패키지) · `internal/daemon/`(boot · ipc) ·
  `internal/ctl/`(cli 33파일 · migrate · decidx · errdoc) · `internal/helper/` ·
  `cmd/dongminal/` 의 비검사 소스. 함수 길이는 `go/ast` 로 기계 측정했다.
- **실측한 것**: `runtime.Install` 벤치(P1) · `net.Listen`/`http.Get` 의 IPv6·
  미지정 주소 동작(항목 1·11). 벤치 파일은 측정 후 삭제했다 — 작업 트리는 깨끗하다.
- **한계**
  - **Windows·Linux 에서 돌려 보지 못했다.** 항목 11 의 Windows 실패,
    P1 의 Defender 비용은 코드와 플랫폼 문서에 근거한 **예측**이며 미측정이다.
  - 검사 파일은 커버리지 판단에만 참고했고 내용 감사는 하지 않았다.
  - `internal/webserver/` 는 담당 밖이라 보지 않았다 — 다만 항목 4·6 의 근거가
    `cmd/dongminal/main.go` 를 통해 그쪽 도메인(`worktree`·`ext`·`lsp`)에 닿으므로,
    그 부분은 호출 지점만 확인했다.
  - 항목 9 의 "9개 액션이 새 검사를 통과하는가" 는 확인하지 않았다 (읽기 전용).

---

## 부록 — 재현되지 않은 관찰 1건 (확정 결함 아님)

> 감사 중 실기로 한 번 관찰했으나 **재현에 실패했다.** 결함으로 올리지 않고
> 조건과 가설만 남긴다. 확인 전에는 고치지 않는다.

### [관찰] `stop --all` 이 이미 죽은 데몬에 "정지 실패" 를 냈다

- 관찰: 격리 인스턴스를 `stop --all` 로 내릴 때
  ```
  강제 종료...
  dongminald pid=36341 가 아직 살아 있습니다
  ❌ dongminald 정지 실패
  ```
  그러나 **직후 `ps -p 36341` 은 프로세스가 없다고 답했다.** 즉 실제로는
  정지에 성공했는데 실패로 보고했다.
- 조건: 그 인스턴스는 약 20분간 떠 있었고, 브라우저가 붙어 있었으며, 저장소
  하나와 터미널 여러 개가 살아 있었다.
- **재현 실패**: 같은 바이너리로 `start --isolated` → 1초 대기 → `stop --all`
  을 3회 돌렸고 **3회 모두 `✅ dongminald 정지`** 였다. 잔여 프로세스도
  `paned.pid`·`paned.sock` 잔여물도 없었다.
- 관련 코드: `internal/ctl/cli/proc.go:155 stopDaemon`.
  `stopGrace = 1초` (`:64`) 가 SIGTERM 대기와 SIGKILL 대기에 **각각** 쓰이고,
  그 뒤 `proc.Alive(pid)` 를 한 번 더 본다.
- 가설 둘 (**어느 쪽도 확인되지 않았다**):
  1. **좀비 판정.** POSIX 의 `Alive` 가 `kill(pid,0)` 계열이면 **아직 수거되지
     않은 좀비에 대해 살아 있다고 답한다.** `stop --all` 은 서버(데몬의 부모)와
     데몬을 같은 회차에 내리므로, 부모가 먼저 죽고 init 이 데몬을 입양·수거하기
     전 짧은 창이 열릴 수 있다. 한산한 인스턴스에서는 그 창이 너무 짧아 안
     잡혔을 수 있다.
  2. **1초가 모자랐다.** 도구 프로세스를 여럿 들고 있던 데몬이 SIGKILL 뒤
     정리에 1초 넘게 걸렸을 수 있다.
- 만약 확인되면 따라오는 2차 피해: 실패 경로는 `return false` 로 빠지면서
  **`paned.pid`·`paned.sock` 을 지우지 않는다** (`:188-190` 은 그 뒤에 있다).
  주석이 *"살아 있는 데몬의 pidfile 을 지우면 고아가 된다"* 고 적은 그 보호가,
  **죽은 데몬에 대해서는 정확히 반대로 잔여물을 남긴다.**
- 확인 방법: 도구를 여럿 띄운 인스턴스를 20분 이상 유지한 뒤 `stop --all` 을
  반복하고, 실패가 뜨는 순간 `ps -o pid,stat` 로 `Z`(좀비) 여부를 본다.
  가설 1이면 `Alive` 가 좀비를 걸러야 하고(`waitid`/`WNOHANG` 또는
  `/proc/<pid>/stat` 의 상태 문자), 가설 2면 `stopGrace` 를 늘리는 대신
  **마지막 확인을 폴링으로** 바꾼다.
- 공수: 확인 S · 수정 S
