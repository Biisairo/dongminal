# SRS: 크로스플랫폼 — OS 이음매의 인터페이스화 · Linux/WSL/Windows-native 지원 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

dongminal 은 사실상 darwin 전용이다. 그것이 설계상의 결정이어서가 아니라, OS 에
의존하는 호출이 **호출하는 자리에 그대로 박혀 있기 때문**이다. `syscall.Kill`,
`Setsid`, `/proc/<pid>/cwd`, `lsof`, `pgrep`, `/bin/bash`, `net.Listen("unix")` 가
각각의 사용처에 흩어져 있고, 그것을 감싸는 경계가 없다.

본 SRS 는 두 가지를 한다.

1. OS 마다 달라지는 능력을 **인터페이스로 묶어** 단일 패키지(`internal/shared/platform`)
   뒤로 보낸다. 호출자는 `runtime.GOOS` 를 보지 않는다.
2. 그 인터페이스의 구현을 **Linux · WSL · Windows-native** 에 대해 채운다.

핵심 원칙은 하나다 — **분기(`if goos == ...`)가 아니라 다형성으로 가른다.** 호출부에
OS 이름이 나타나면 그것은 이 SRS 의 위반이다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| A | `platform` 패키지 골격 — `Platform` 번들, `OSKind`, WSL 감지, `Paths`, `Browser` |
| B | `Process` — 종료·생존확인·프로세스 그룹·데몬 분리. 호출부 3곳 이관 |
| C | `ProcInfo` — busy 판정·cwd·프로세스명·포트 점유자. 외부 CLI(`lsof`/`pgrep`/`ps`) 의존 제거 |
| D | `PTY`/`Terminal` — PTY 마스터와 그에 붙은 프로세스의 소유권 이관. `toolhub` 개조 |
| E | `ShellProvider` — 셸 선택과 셸 훅 자산의 OS 별 분기. PowerShell 훅 신설 |
| F | `IPC` — dongminal ↔ dongminald 로컬 전송 종단 추상화 (유닉스 소켓 / named pipe) |
| G | Windows 어댑터 실구현 — ConPTY · Job Object · Named Pipe · WinAPI 프로세스 조회 |
| H | `sysstat` 확장 — Linux(`/proc`) · Windows(WinAPI) Reader 신설 |
| I | 빌드·검증 — 크로스 빌드 게이트, 플랫폼별 테스트 분리 |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **이음매 (seam)** | OS 마다 구현이 갈리는 지점. §2.2 에 16개를 열거한다 |
| **어댑터** | 이음매 하나에 대한 특정 OS 의 구현. build tag 로 선택된다 |
| **Terminal** | 의사 터미널의 마스터측 **과 그에 붙은 자식 프로세스**를 함께 소유하는 핸들. POSIX 는 `ptmx` + `exec.Cmd`, Windows 는 파이프 2개 + `HPCON` + 프로세스 핸들 |
| **ConPTY** | Windows 10 1809+ 의 의사 콘솔 API (`CreatePseudoConsole`). Windows 에서 PTY 의미론을 얻는 유일한 공식 경로 |
| **Job Object** | Windows 의 프로세스 묶음. POSIX 프로세스 그룹의 대응물이며, 자손까지 통째로 종료하는 유일한 신뢰 가능한 수단 |
| **WSL** | Windows Subsystem for Linux. 커널 ABI 는 Linux 이며 `GOOS=linux` 로 빌드된다. 호스트 Windows 와의 접점(브라우저·경로)에서만 Linux 와 다르다 |
| **Win-native** | WSL 을 거치지 않고 Windows 커널 위에서 직접 도는 빌드 (`GOOS=windows`) |
| **전경 프로세스** | PTY 의 전경 프로세스 그룹(`tcgetpgrp`) 리더. 탭 이름 파생에 쓴다 (CONVENIENCE_SRS FR-TAN) |

### 1.4 참고 (References)

- `docs/internal/architecture.md` — 4개 프로세스 역할 (`dongminal` / `dongminald` / 웹서버 / helper)
- `docs/internal/SYSTEM_STATS_SRS.md` §5 — 현재의 darwin 전용 선언. 본 SRS 가 이를 대체한다
- `docs/internal/CONVENIENCE_SRS.md` FR-TAN-23/24 — `fg_posix.go`/`fg_other.go` 분리. 본 SRS 가 흡수한다
- `internal/webserver/domain/sysstat/sysstat.go:56` — `Reader` 인터페이스. **본 SRS 가 따르는 선례**
- Microsoft — [Windows Pseudo Console (ConPTY)](https://learn.microsoft.com/windows/console/creating-a-pseudoconsole-session)
- Microsoft — `AssignProcessToJobObject`, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`

본 문서의 파일:라인 인용은 **2026-08-29 작업 트리(`a55f2af`) 기준**이다.

### 1.5 개요 (Overview)

§2 실측된 현황, §3 요구사항, §4 검증, §5 비목표, §6 구현 계획, §7 동작 변경 기록,
§8 리스크, §9 열린 결정.

---

## 2. 현황 (Identified Issue)

### 2.1 빌드 실측

작업 트리에서 크로스 컴파일을 실행한 결과다.

| 대상 | 결과 |
|---|---|
| `GOOS=darwin` | 통과 (현행) |
| `GOOS=linux` | **통과** |
| `GOOS=windows` | **실패 — 8건** |

Windows 컴파일 실패 8건:

```
internal/ctl/cli/handoff.go:53:41           unknown field Setsid
internal/ctl/cli/start.go:131:41            unknown field Setsid
internal/ctl/cli/proc.go:57,89,104,106      undefined: syscall.Kill
internal/webserver/domain/git/jobs/job.go:520:41  unknown field Setpgid
internal/webserver/domain/git/jobs/job.go:573:17  undefined: syscall.Kill
```

**이 8건은 문제의 크기를 나타내지 않는다.** `GOOS=linux` 가 통과하는 것도 마찬가지다 —
컴파일 통과는 동작을 뜻하지 않는다. 실제 크기는 §2.2 다.

### 2.2 이음매 목록 (실측 16종)

| # | 이음매 | 현재 구현 | 위치 | Linux | WSL | Win |
|---|---|---|---|---|---|---|
| 1 | PTY 기동 | `creack/pty` | `toolhub/tool.go:287` | ✅ | ✅ | ❌ Windows 는 무동작 스텁 |
| 2 | PTY 크기 | `pty.Setsize/Getsize` | `tool.go:547,988` | ✅ | ✅ | ❌ |
| 3 | 셸 선택 | `$SHELL` → `/bin/bash` → `/bin/sh`, `-l` | `tool.go:242-246` | ✅ | ✅ | ❌ |
| 4 | 셸 훅 | `bash-hook.sh`, `zdotdir/.zshrc` | `runtime/shellhooks/` | ✅ | ✅ | ❌ 등가물 없음 |
| 5 | PATH 조립 | `+ ":" + binDir` 하드코딩 | `tool.go:255` | ✅ | ✅ | ❌ 구분자 `;` |
| 6 | IPC 종단 | `net.Listen("unix")`, `os.ModeSocket` 검사 | `daemon/ipc/paned.go:395-403`, `cli/proc.go:118` | ✅ | ✅ | ⚠️ AF_UNIX 는 되나 `ModeSocket` 검사가 깨짐 |
| 7 | 프로세스 종료 | `syscall.Kill(SIGTERM/SIGKILL)` | `cli/proc.go:57,89,104,106`, `handlers_tools_kill.go:69`, `tool.go:650` | ✅ | ✅ | ❌ |
| 8 | 생존 확인 | `syscall.Kill(pid, 0)` | `cli/proc.go:89` | ✅ | ✅ | ❌ |
| 9 | 프로세스 그룹 | `Setpgid` + `Kill(-pgid)` | `git/jobs/job.go:520,573` | ✅ | ✅ | ❌ Job Object |
| 10 | 데몬 분리 | `SysProcAttr{Setsid:true}` | `cli/start.go:138`, `cli/handoff.go:53`, `cmd/dongminal/main.go:122` | ✅ | ✅ | ❌ `DETACHED_PROCESS` |
| 11 | 포트 점유자 | `lsof -ti :P -sTCP:LISTEN` | `cli/proc.go:42` | ⚠️ lsof 미설치 가능 | ⚠️ | ❌ |
| 12 | busy 판정 | `pgrep -P <pid>` | `tool.go:167` | ⚠️ 동일 | ⚠️ | ❌ |
| 13 | 전경 프로세스 | `TIOCGPGRP` + `/proc/comm` → `ps` | `fg_posix.go` | ✅ | ✅ | ❌ 스텁(무동작) |
| 14 | 도구 cwd | `/proc/<pid>/cwd` → `lsof -d cwd` | `tool.go:184,192` | ✅ | ✅ | ❌ |
| 15 | 시스템 지표 | darwin 전용, 그 외 전량 `ErrUnsupported` | `sysstat/reader_*.go` | ❌ **미구현** | ❌ | ❌ |
| 16 | 브라우저 열기 | darwin/linux 만, 그 외 오류 | `cli/open.go:17-29` | ✅ | ⚠️ 호스트 브라우저를 띄워야 함 | ❌ |

부수 항목: 헬퍼 설치가 symlink 우선(`runtime/install.go:208`, Windows 는 권한 필요 +
`.exe` 미고려), 기본 로그 경로가 `/tmp/dongminal.log` 하드코딩(`cli/options.go:37`).

### 2.3 현행 구조의 진단

`runtime.GOOS` 분기는 코드베이스 전체에서 **`cli/open.go:33` 단 한 곳**이다. 즉
"분기가 흩어져 있다" 가 문제가 아니라 **분기할 자리조차 없다** 가 문제다. OS 의존
호출이 곧바로 업무 로직 안에 있다.

다만 두 개의 올바른 선례가 이미 있다.

- `sysstat.Reader` (`sysstat.go:56`) — 인터페이스를 두고 `reader_darwin.go` /
  `reader_other.go` 가 build tag 로 갈린다. 순수 로직(`sampler.go`)은 태그가 없다.
- `foreground.go` / `fg_posix.go` / `fg_other.go` — 이식 가능한 규칙(캐시·이름 다듬기)과
  플랫폼 조회를 파일로 갈라 두었다.

**본 SRS 는 새 패턴을 발명하지 않는다. 위 두 선례를 16개 이음매 전체로 넓힌다.**

### 2.4 Windows PTY 의 구조적 제약 (설계를 좌우함)

Windows 에서 ConPTY 세션을 만들려면 `STARTUPINFOEX` 의
`PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 속성에 `HPCON` 을 실어 `CreateProcess` 를
불러야 한다. **`os/exec` 도 `syscall.SysProcAttr`(windows) 도 프로세스/스레드 속성
목록을 노출하지 않는다.** 따라서 Windows 어댑터는 `exec.Cmd.Start()` 를 쓸 수 없고,
`windows.CreateProcess` 를 직접 불러 프로세스 핸들을 스스로 소유해야 한다.

이 사실이 인터페이스 경계를 결정한다 — **PTY 추상화는 `*exec.Cmd` 를 받아서는 안
되고, 자식 프로세스의 수명까지 함께 소유해야 한다** (FR-XPT-1). 현재 `toolhub.Tool`
이 `ptmx *os.File` 과 `cmd *exec.Cmd` 를 따로 들고 있는 구조는 그대로 둘 수 없다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 추상화 레이어 골격

**FR-XPL-1** `internal/shared/platform` 패키지를 신설한다. 이 패키지는 OS 마다 갈리는
능력의 **인터페이스**와, 이 빌드에 해당하는 **구현 번들**을 제공한다.

**FR-XPL-2** 능력은 하나의 거대 인터페이스가 아니라 역할별 인터페이스로 나눈다.
호출자는 자기가 쓰는 인터페이스만 의존한다 (ISP).

```go
// Platform 은 이 빌드가 제공하는 OS 능력의 묶음이다. 필드는 모두 인터페이스이며,
// 소비자는 번들이 아니라 필요한 필드 하나만 받는다.
type Platform struct {
	OS      OSKind
	PTY     PTY
	Process Process
	Shell   ShellProvider
	Paths   Paths
	IPC     IPC
	Info    ProcInfo
	Browser Browser
}

// Current 는 이 빌드의 구현을 낸다. 값은 불변이며 프로세스 수명 동안 같다.
func Current() Platform
```

**FR-XPL-3** 구현 선택은 build tag 로만 한다. `platform_darwin.go`·`platform_linux.go`·
`platform_windows.go` 가 각각 `newPlatform() Platform` 을 정의해 번들을 조립한다.
**`Current()` 안에 `switch runtime.GOOS` 를 두지 않으며, 조립 이후 어디에도 `OSKind`
로 갈라지는 분기를 두지 않는다** — `OSKind` 는 표시·기록용 값이지 분기의 근거가 아니다.

darwin·linux 가 공유하는 어댑터(`Process`·`Paths`·`IPC`·`PTY`)의 구현은
`*_posix.go`(`//go:build !windows`)에 한 벌만 두고 세 조립 파일이 함께 참조한다.
갈리는 것(`Browser`·`ProcInfo`)만 GOOS 별 파일을 갖는다.

**FR-XPL-3a** `Platform` 구조체의 필드는 해당 능력이 구현된 단계에서 추가한다.
모든 단계 경계에서 패키지가 컴파일되고 테스트가 통과해야 한다 (§6).

**FR-XPL-4** `OSKind` 는 다음 값을 갖는다: `darwin`, `linux`, `wsl`, `windows`.
`wsl` 은 빌드 태그가 아니라 런타임 감지로 정해진다 (FR-XWS-1).

**FR-XPL-5** 호출부에 `runtime.GOOS` · `syscall.SIG*` · `SysProcAttr` · `/proc` 경로 ·
`net.Listen("unix")` 가 남아 있으면 안 된다. 예외는 `platform` 패키지 내부와
`sysstat` 패키지(자체 Reader 를 이미 가짐)뿐이다. 이 조항은 FR-XBD-3 의 자동 검사로
강제한다.

**FR-XPL-6** `platform` 패키지는 `internal/` 안의 다른 패키지를 import 하지 않는다.
의존 방향은 항상 `상위 패키지 → platform` 단방향이다 (순환 금지).

---

### 3.2 묶음 B — Process (프로세스 제어)

**FR-XPR-1** 다음 인터페이스를 정의한다.

```go
// Process 는 pid 로 지목한 프로세스의 생명주기 제어다.
type Process interface {
	// Alive 는 pid 가 살아 있는지다. 권한이 없어 확인할 수 없으면 살아 있는
	// 것으로 본다 — 없는 것으로 오판하면 낡은 pidfile 을 지워 데몬을 잃는다.
	Alive(pid int) bool

	// Terminate 는 정중한 종료를 요청한다. 대상이 정리 기회를 갖는다.
	// POSIX: SIGTERM. Windows: 콘솔 프로세스는 CTRL_BREAK, 그 외는 종료 요청.
	Terminate(pid int) error

	// Kill 은 즉시 종료다. 대상에 정리 기회가 없다.
	Kill(pid int) error

	// Detach 는 부모와 수명·제어 터미널을 분리해 띄우도록 cmd 를 준비한다.
	// cmd.Start() 전에 부른다.
	// POSIX: Setsid. Windows: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP.
	Detach(cmd *exec.Cmd)

	// NewGroup 은 cmd 와 그 **자손 전체**를 하나로 묶어 통째로 종료할 수 있게
	// cmd 를 준비하고 그 묶음의 핸들을 낸다. cmd.Start() 전에 부른다.
	NewGroup(cmd *exec.Cmd) Group
}

// Group 은 프로세스 묶음이다. POSIX 프로세스 그룹 / Windows Job Object.
type Group interface {
	// Bind 는 cmd.Start() 직후에 불러야 한다. POSIX 는 할 일이 없고(SysProcAttr
	// 로 이미 끝났다), Windows 는 여기서 Job 에 배정하고 중단된 스레드를 재개한다.
	// Bind 를 부르지 않으면 Windows 에서 자식이 영영 시작되지 않는다.
	Bind() error
	Terminate() error
	Kill() error
}
```

**FR-XPR-2** POSIX 어댑터는 현행 동작과 **완전히 같아야** 한다. `Terminate`=`SIGTERM`,
`Kill`=`SIGKILL`, `Alive`=`Kill(pid,0)==nil`, `Detach`=`Setsid:true`,
`NewGroup`=`Setpgid:true` + `Bind()` 는 no-op, `Group.Terminate/Kill`=`Kill(-pgid, sig)`.

**FR-XPR-3** Windows 어댑터:
- `Alive` — `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` 후
  `GetExitCodeProcess` 가 `STILL_ACTIVE` 인지로 판정한다.
- `Terminate` — 대상이 같은 콘솔 그룹이면 `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)`,
  실패하거나 대상이 아니면 `Kill` 로 물러선다.
- `Kill` — `TerminateProcess(handle, 1)`.
- `Detach` — `SysProcAttr{CreationFlags: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP}`.
- `NewGroup` — `CreateJobObject` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,
  `SysProcAttr{CreationFlags: CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP}`,
  `Bind()` 에서 `AssignProcessToJobObject` 후 `ResumeThread`.
  `CREATE_SUSPENDED` 를 쓰는 이유는 배정 전에 자식이 손자를 낳는 경합을 없애기 위함이다.
- `Group.Kill` — `TerminateJobObject`.

**FR-XPR-4** 다음 호출부를 `Process` 로 이관한다. 동작은 바뀌지 않는다.

| 호출부 | 현재 | 이후 |
|---|---|---|
| `cli/proc.go:57` `signalPIDs` | `syscall.Kill(p, sig)` | `Process.Terminate/Kill` |
| `cli/proc.go:89` `daemonPID` | `syscall.Kill(pid,0)` | `Process.Alive` |
| `cli/proc.go:104-106` `stopDaemon` | `Kill(TERM)`→`Kill(KILL)` | `Terminate`→`Kill` |
| `cli/start.go:138` | `SysProcAttr{Setsid}` | `Process.Detach(cmd)` |
| `cli/handoff.go:53` | `SysProcAttr{Setsid}` | `Process.Detach(cmd)` |
| `cmd/dongminal/main.go:122` | `SysProcAttr{Setsid}` (dongminald 기동) | `Process.Detach(cmd)` |
| `git/jobs/job.go:520,547,573` | `Setpgid`/`Kill(-pgid)` | `Process.NewGroup` + `Group` |
| `httpapi/handlers_tools_kill.go:69` | `syscall.Kill(pid, SIGTERM)` | `Process.Terminate` |
| `toolhub/tool.go:650-652` | `Signal(SIGTERM)`→`Kill()` | `Terminal.Terminate`→`Terminal.Kill` (FR-XPT-3) |

**FR-XPR-5** `git/jobs/job.go` 의 `Bind()` 누락은 Windows 에서 즉시 교착을 낳는다
(자식이 `CREATE_SUSPENDED` 인 채로 남는다). `runGit` 은 `cmd.Start()` 성공 직후,
파이프 쓰기단을 닫기 **전에** `Bind()` 를 부르며, 실패 시 `Group.Kill()` 후 오류를 낸다.

---

### 3.3 묶음 C — ProcInfo (프로세스 조회)

**FR-XPI-1** 다음 인터페이스를 정의한다.

```go
// ProcInfo 는 프로세스·포트에 대한 읽기 전용 조회다. 조회는 모두 실패할 수 있고,
// 실패는 오류가 아니라 "모름" 이다 — 호출자는 추측하지 않고 기능을 비운다.
type ProcInfo interface {
	// HasChildren 은 pid 에 직계 자식이 있는지다. 도구 busy 판정의 근거다.
	HasChildren(pid int) bool

	// CWD 는 프로세스의 현재 작업 디렉터리다.
	CWD(pid int) (string, bool)

	// Names 는 pid 들의 프로세스 이름을 **한 번에** 읽는다. 도구 100개에서
	// pid 마다 외부 프로세스를 띄우면 갱신 주기를 넘긴다 (NFR-CNV-1 승계).
	Names(pids []int) map[int]string

	// ListenerPIDs 는 TCP 포트를 LISTEN 상태로 점유한 pid 들이다. 접속만 한
	// 클라이언트는 포함하지 않는다 — 포함하면 서버를 내리는 자리에서 사용자의
	// 브라우저 탭을 함께 죽인다 (cli/proc.go 의 기존 주석).
	ListenerPIDs(port string) []int
}
```

**FR-XPI-2** Linux 어댑터는 **외부 프로세스를 띄우지 않는다.** 전량 `/proc` 으로 읽는다.
- `HasChildren` — `/proc/<pid>/task/*/children`
- `CWD` — `/proc/<pid>/cwd` readlink
- `Names` — `/proc/<pid>/comm`
- `ListenerPIDs` — `/proc/net/tcp`·`tcp6` 의 `st=0A`(LISTEN) 항목에서 inode 를 모으고,
  `/proc/*/fd/*` 의 `socket:[inode]` 로 역인덱싱

**FR-XPI-3** darwin 어댑터는 현행 동작을 유지한다 (`pgrep -P`, `ps -o pid=,comm= -p`,
`lsof`). darwin 에는 `/proc` 이 없고 대체 경로는 `libproc` cgo 이므로, cgo 를 늘리지
않는다는 기존 결정(SYSTEM_STATS_SRS D-5)을 따른다.

**FR-XPI-4** Windows 어댑터는 외부 프로세스를 띄우지 않는다.
- `HasChildren` / `Names` — `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` 1회 순회.
  `Names` 는 스냅샷 1회로 모든 pid 를 채운다 (FR-XPI-1 의 일괄 요구).
- `CWD` — 조회하지 않는다. `(", false)` 를 낸다 (FR-XPI-6 참조).
- `ListenerPIDs` — `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)`.

**FR-XPI-5** 호출부 이관:

| 호출부 | 현재 | 이후 |
|---|---|---|
| `toolhub/tool.go:167` `toolBusyProbe` | `pgrep -P` | `ProcInfo.HasChildren` |
| `toolhub/tool.go:184-192` cwd | `/proc` → `lsof` | `ProcInfo.CWD` |
| `toolhub/fg_posix.go:82` `procNames` | `/proc/comm` → `ps` | `ProcInfo.Names` |
| `cli/proc.go:42` `pidsOnPort` | `lsof -ti` | `ProcInfo.ListenerPIDs` |

`toolBusyProbe` 가 이미 패키지 변수(테스트 대체용)인 성질은 유지한다.

**FR-XPI-6** `ProcInfo.CWD` 가 `false` 를 내면 도구의 cwd 추적은 **셸 훅의 OSC 777
경로만** 남는다. 그 경로는 이미 존재하며(`shellhooks/bash-hook.sh:1`) Windows 에서도
PowerShell 훅이 같은 시퀀스를 낸다 (FR-XSH-5). 즉 Windows 에서 cwd 는 폴백이 없을 뿐
정상 경로로는 동작한다.

---

### 3.4 묶음 D — PTY / Terminal

**FR-XPT-1** PTY 추상화는 `*exec.Cmd` 를 받지 않는다. §2.4 의 제약 때문이다. 명세를
받아 프로세스를 **직접 띄우고 소유한다.**

```go
// ProcSpec 은 터미널에 붙일 프로세스의 명세다. exec.Cmd 를 쓰지 않는 이유는
// Windows ConPTY 가 STARTUPINFOEX 를 요구하는데 os/exec 가 그것을 노출하지
// 않기 때문이다 (SRS §2.4).
type ProcSpec struct {
	Path string   // 실행 파일의 절대 경로
	Args []string // Args[0] 포함
	Env  []string // "K=V" 목록. 완전한 환경이며 상속하지 않는다
	Dir  string   // 작업 디렉터리
}

type PTY interface {
	// Start 는 새 의사 터미널을 만들고 spec 을 그 안에 띄운다.
	Start(spec ProcSpec, cols, rows uint16) (Terminal, error)
}

// Terminal 은 의사 터미널의 마스터측과 거기 붙은 프로세스를 함께 소유한다.
// Read/Write 는 터미널 입출력이고, PID/Wait/Terminate/Kill 은 프로세스다.
// 둘을 한 인터페이스로 묶는 이유는 Windows 에서 그 둘이 분리되지 않기 때문이다.
type Terminal interface {
	io.ReadWriteCloser

	Resize(cols, rows uint16) error
	Size() (cols, rows uint16, err error)

	// ForegroundPGID 는 전경 프로세스 그룹 id 다. 그 개념이 없는 플랫폼은
	// ok=false 다 — 오류가 아니다.
	ForegroundPGID() (pgid int, ok bool)

	PID() int
	Wait() error
	Terminate() error
	Kill() error
}
```

**FR-XPT-2** POSIX 어댑터는 `creack/pty` 와 `os/exec` 로 현행 동작을 그대로 낸다.
`ForegroundPGID` 는 현행 `fg_posix.go:65` 의 `TIOCGPGRP` 구현을 옮긴 것이며,
`os.File.Fd()` 대신 `SyscallConn().Control` 을 쓰는 성질(비블로킹 fd 보존)을 유지한다.

**FR-XPT-3** `toolhub.Tool` 을 개조한다.
- `ptmx *os.File` + `cmd *exec.Cmd` → `term platform.Terminal` 하나로 합친다.
- `readPTY` 는 `p.term.Read` 를 읽는다.
- `Resize`/`Size` 는 `p.term.Resize`/`Size` 를 부른다.
- `kill()` 은 `p.term.Terminate()` → 50ms → `p.term.Kill()` → `p.term.Wait()` 순으로,
  현행 `tool.go:650-654` 와 같은 순서·유예를 유지한다.
- `CmdProcessPID()` 는 `p.term.PID()` 를 낸다. **이름과 시그니처는 유지한다** —
  호출부(`foreground.go:107`, `seam/adapters/tool.go`)를 흔들지 않는다.
- `PTMX() *os.File` 은 **제거한다.** 유일한 외부 사용처
  `seam/adapters/tool.go:122` 는 `Tool.Size()` 로 바꾼다 (§7 기록).
- `NewDetachedTool` 이 만드는 PTY 없는 합성 Tool 은 `term == nil` 로 남으며, 기존의
  nil 방어를 그대로 유지한다.

**FR-XPT-4** `fgRequest.PTMX *os.File` 은 `Term platform.Terminal` 로 바뀐다.
`foregroundNames` 는 build tag 없는 **이식 가능한 코드**가 되며, `Terminal.ForegroundPGID`
와 `ProcInfo.Names` 만 쓴다. 이로써 `fg_posix.go` / `fg_other.go` 의 build tag 분리는
**사라진다** — 분리의 사유였던 `TIOCGPGRP` 과 `/proc` 이 모두 `platform` 뒤로 갔다.
`foreground.go` 의 캐시·주기·이름 다듬기 규칙(FR-TAN-8/9/10/11/13)은 그대로다.

**FR-XPT-5** Windows 어댑터 (ConPTY). 신규 의존 없이 `golang.org/x/sys/windows` 와
`kernel32` lazy DLL 로만 구현한다.
1. `CreatePipe` × 2 (입력용·출력용)
2. `CreatePseudoConsole(COORD{cols,rows}, inRead, outWrite, 0, &hpc)` — kernel32 lazy proc
3. `windows.NewProcThreadAttributeList(1)` +
   `Update(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE=0x00020016, hpc)`
4. `windows.CreateProcess` with `STARTUPINFOEX`, `EXTENDED_STARTUPINFO_PRESENT`
5. 부모측이 잡고 있는 자식쪽 파이프 끝(`inRead`, `outWrite`)을 닫는다 — 닫지 않으면
   자식이 끝나도 읽기가 EOF 를 보지 못한다 (`git/jobs/job.go:531` 과 같은 사정)
6. `Read`/`Write` 는 부모측 파이프, `Resize` 는 `ResizePseudoConsole`,
   `Close` 는 `ClosePseudoConsole` + 핸들 정리
7. `ForegroundPGID` 는 `(0, false)` — Windows 에 대응 개념이 없다

**FR-XPT-6** Windows 어댑터는 콘솔 입출력을 UTF-8 로 고정한다. ConPTY 세션 생성 시
`SetConsoleOutputCP(CP_UTF8)`/`SetConsoleCP(CP_UTF8)` 를 적용한다. 이것이 없으면
한국어 출력이 깨지고, 이 프로젝트의 UI·문서·로그가 전부 한국어다.

---

### 3.5 묶음 E — Shell · 훅

**FR-XSH-1** 다음 인터페이스를 정의한다.

```go
// ShellSpec 은 도구 하나를 띄울 셸의 명세다.
type ShellSpec struct {
	Path string   // 실행 파일 절대 경로
	Args []string // 대화형/로그인 인자 (Args[0] 제외)
	Env  []string // 이 셸에만 필요한 추가 "K=V" (훅 주입 포함)
}

type ShellProvider interface {
	// Shell 은 이 호스트의 대화형 셸 명세를 낸다. binDir 은 헬퍼와 훅이
	// 설치된 곳이며, 훅 주입 환경변수가 이 경로를 참조한다.
	Shell(binDir string) ShellSpec

	// HookRoot 는 binDir 에 풀어야 할 훅 자산의 임베드 서브트리 이름이다.
	HookRoot() string
}
```

**FR-XSH-2** POSIX 어댑터는 현행 `tool.go:242-278` 의 규칙을 그대로 옮긴다:
`$SHELL` → 없거나 존재하지 않으면 `/bin/bash` → 그것도 없으면 `/bin/sh`, 인자는 `-l`,
zsh 이면 `ZDOTDIR=<binDir>/zdotdir`, bash 이면 `BASH_ENV=<binDir>/bash-hook.sh`.
`HookRoot()` 는 `"shellhooks/posix"`.

**FR-XSH-3** Windows 어댑터의 셸 선택 순서: `%DONGMINAL_SHELL%` → `pwsh.exe`(PATH) →
`powershell.exe` → `cmd.exe`. PowerShell 계열의 인자는
`-NoLogo -NoExit -ExecutionPolicy Bypass -File <binDir>\powershell-hook.ps1`.
`cmd.exe` 로 떨어지면 훅이 없으므로 인자는 비고, 훅 의존 기능(cwd 추적·에이전트 래퍼)은
동작하지 않는다 — 이는 정상적 성능 저하이지 오류가 아니다.
`HookRoot()` 는 `"shellhooks/windows"`.

**FR-XSH-4** 임베드 자산을 재배치한다.
`shellhooks/bash-hook.sh`, `shellhooks/zdotdir/.zshrc` → `shellhooks/posix/` 아래로
옮긴다(`git mv`). `shellhooks/windows/powershell-hook.ps1` 을 신설한다.
`installShellHooks` 는 `HookRoot()` 서브트리만 푼다 — **모든 OS 의 훅을 다 풀지 않는다.**

**FR-XSH-5** `powershell-hook.ps1` 은 POSIX 훅과 동등한 세 가지를 한다.
1. cwd 통지 — `prompt` 함수를 감싸 매 프롬프트마다
   `` `e]777;Cwd;$PWD`a `` 를 내보낸다 (POSIX 의 `_rt_cwd_hook` 와 **동일한 시퀀스**)
2. `claude` 래퍼 — `$env:DONGMINAL_HOME\bin\agent-hooks\claude.json` 이 있으면
   `--settings`, `...\bin\agent-plugin` 이 있으면 `--plugin-dir` 을 붙여 위임
3. `codex` 래퍼 — `-c notify=[...dmctl.exe,notify,codex]` 를 붙여 위임

**FR-XSH-6** `toolhub.StartTool` 은 셸을 스스로 고르지 않는다. `ShellProvider.Shell()`
이 낸 `ShellSpec` 을 `platform.ProcSpec` 으로 조립해 `PTY.Start` 에 넘긴다.
환경 조립에서 PATH 구분자는 `os.PathListSeparator` 를 쓴다 (`tool.go:255` 의 `":"` 제거).
POSIX 전용 값(`SHELL_SESSIONS_DISABLE`, `LANG`/`LC_*`)은 `ShellSpec.Env` 로 내려가
어댑터가 소유한다 — Windows 에는 이 값들이 실리지 않는다.

---

### 3.6 묶음 F — IPC

**FR-XIP-1** 다음 인터페이스를 정의한다.

```go
// IPC 는 dongminal(웹서버) ↔ dongminald(데몬) 사이의 로컬 전송이다.
// 로컬 전용이며 네트워크에 노출되지 않는다.
type IPC interface {
	// Endpoint 는 home 에 대응하는 종단 주소다. POSIX 는 유닉스 소켓 경로,
	// Windows 는 named pipe 이름이다.
	Endpoint(home string) string

	Listen(endpoint string) (net.Listener, error)
	Dial(endpoint string, timeout time.Duration) (net.Conn, error)

	// Exists 는 종단이 놓여 있는지다. 살아 있는지가 아니다 — 살아 있는지는
	// 호출자가 Dial 로 확인한다 (paned.go:395 의 기존 판정).
	Exists(endpoint string) bool

	// Remove 는 잔여 종단을 치운다. named pipe 는 마지막 핸들이 닫히면
	// 커널이 회수하므로 no-op 다.
	Remove(endpoint string) error
}
```

**FR-XIP-2** POSIX 어댑터: `Endpoint` = `filepath.Join(home, "paned.sock")`,
`Listen`/`Dial` 은 `net` 의 `unix` 망, `Exists` 는 `os.Stat` + `ModeSocket` 검사,
`Remove` 는 `os.Remove`. 현행 동작과 동일하다.

**FR-XIP-3** Windows 어댑터: named pipe 를 쓴다. AF_UNIX 를 쓰지 않는 이유는 두 가지다 —
Windows 의 AF_UNIX 는 파일 시스템에 재분석 지점으로 나타나 `ModeSocket` 판정이
성립하지 않고, 낡은 소켓 파일의 회수 규약이 POSIX 와 다르다.
`Endpoint` 는 home 경로의 해시를 섞은 `\\.\pipe\dongminal-<hash>` 다 —
격리 인스턴스(`--isolated`)가 같은 이름을 다투지 않아야 한다.

**FR-XIP-4** 호출부 이관: `daemon/ipc/paned.go` 의 `Listen`(395-410),
`webserver/toolclient/client.go:119` 의 `Dial`, `cli/proc.go:118` 의 `socketExists`.
`PanedServer.Listen` 의 판정 논리 — **살아 있는 종단이면 중단, 죽은 종단이면 치우고
점유** — 는 그대로 유지한다. 이것은 동시 콜드 스타트에서 남의 도구를 훔치지 않기 위한
것이며 OS 와 무관한 규약이다.

---

### 3.7 묶음 A' — Paths · Browser · WSL

**FR-XPA-1** `Paths` 인터페이스:

```go
type Paths interface {
	// DefaultLogFile 은 --foreground 가 아닌 기동의 로그 경로다.
	DefaultLogFile() string

	// ExeSuffix 는 실행 파일의 확장자다. POSIX 는 "", Windows 는 ".exe".
	ExeSuffix() string

	// LinkOrCopy 는 dst 가 src 의 실행 가능한 사본 또는 링크가 되게 한다.
	LinkOrCopy(src, dst string) error
}
```

**FR-XPA-2** `DefaultLogFile` — POSIX 는 `/tmp/dongminal.log`(현행 유지),
Windows 는 `%LOCALAPPDATA%\dongminal\dongminal.log`. `cli/options.go:37` 의
`DefaultLog` 상수는 제거하고 이 메서드로 대체한다.

**FR-XPA-3** `runtime.Install` 의 헬퍼 설치는 이름에 `ExeSuffix()` 를 붙이고
`LinkOrCopy` 를 쓴다. Windows 어댑터의 `LinkOrCopy` 는 symlink 를 **시도하지 않고
곧바로 복사한다** — 개발자 모드가 아닌 Windows 에서 symlink 는 관리자 권한을 요구하며,
실패 후 복사로 물러서는 현행 흐름(`install.go:215-218`)은 매 기동마다 권한 오류를
남긴다. `helperNames()` 자체는 확장자 없이 유지하고, 설치 시점에만 붙인다.

**FR-XBR-1** `Browser` 인터페이스:

```go
type Browser interface {
	// FramelessCommand 는 url 을 app 창(프레임 없는 창)으로 여는 명령이다.
	FramelessCommand(url string) (name string, args []string, err error)
}
```

**FR-XBR-2** 어댑터별 구현:
- darwin — `open -na "Google Chrome" --args --app=<url>` (현행 유지)
- linux — `google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser`
  순으로 `LookPath`, `--app=<url>` (현행 유지)
- **WSL** — 위 Linux 탐색이 모두 실패하면 호스트 Windows 로 넘어간다:
  `wslview` → 없으면 `powershell.exe -NoProfile -Command Start-Process <url>`
- windows — `cmd /c start "" <chrome> --app=<url>` 로 열되, Chrome/Edge 를 `LookPath`
  와 표준 설치 경로에서 찾고, 못 찾으면 `rundll32 url.dll,FileProtocolHandler <url>`
  로 기본 브라우저에 위임한다 (프레임 없는 창은 포기하고 여는 것은 성공시킨다)

**FR-XBR-3** `cli/open.go` 의 `BrowserCommand(goos, url, look)` 은 제거하고 `Browser`
로 대체한다. 이것이 코드베이스에 남은 유일한 `runtime.GOOS` 분기다 (§2.3).

**FR-XWS-1** WSL 감지: `/proc/sys/kernel/osrelease` 또는 `/proc/version` 의 내용에
`microsoft`(대소문자 무시)가 포함되면 `OSKind` 는 `wsl` 이다. `GOOS != linux` 이면
검사하지 않는다. 감지는 `Current()` 최초 호출 시 1회이며 결과를 재사용한다.

**FR-XWS-2** WSL 은 **별도 어댑터를 만들지 않는다.** Linux 어댑터를 그대로 쓰되,
`Browser` 만 FR-XBR-2 의 WSL 분기를 갖는다. WSL 이 Linux 와 다른 이음매는 현재 그
하나뿐이며, 실측되지 않은 차이를 위해 어댑터를 미리 나누지 않는다.

---

### 3.8 묶음 H — sysstat

**FR-XSY-1** `sysstat` 은 이미 `Reader` 인터페이스를 갖고 있다. 인터페이스는 바꾸지
않고 어댑터만 늘린다. `reader_other.go` 의 build tag 를
`//go:build !darwin && !linux && !windows` 로 좁힌다.

**FR-XSY-2** `reader_linux.go` 신설:
- `CPUTicks` — `/proc/stat` 첫 줄 (`user nice system idle`)
- `Mem` — `/proc/meminfo` 의 `MemTotal` 과 `MemTotal - MemAvailable`.
  `MemAvailable` 이 없는 낡은 커널이면 `MemFree + Buffers + Cached` 로 근사한다
- `BootTime` — `/proc/stat` 의 `btime`
- `DiskPercent` — `syscall.Statfs` (darwin 구현과 같은 방식)

**FR-XSY-3** `reader_windows.go` 신설 (`golang.org/x/sys/windows`):
- `CPUTicks` — `GetSystemTimes(idle, kernel, user)`. `system = kernel - idle`,
  `nice = 0`
- `Mem` — `GlobalMemoryStatusEx`. `Used = TotalPhys - AvailPhys`
- `BootTime` — `time.Now() - GetTickCount64()`
- `DiskPercent` — `GetDiskFreeSpaceEx`

**FR-XSY-4** `MemInfo.Used` 의 정의(SYSTEM_STATS_SRS FR-STAT-15, "wired+active+compressed")
는 darwin 고유다. Linux/Windows 는 각 OS 가 "사용 중" 으로 보고하는 값을 그대로 쓴다.
`sysstat.go:44` 의 `MemInfo` 주석에 이 사실을 기록한다.

---

### 3.9 묶음 I — 빌드 · 검증

**FR-XBD-1** `scripts/build.sh` 에 `--all` 옵션을 더한다. `darwin/arm64`,
`darwin/amd64`, `linux/amd64`, `linux/arm64`, `windows/amd64` 5종을 `dist/` 에 낸다.
Windows 산출물은 `.exe` 확장자를 갖는다. 옵션 없는 기본 동작은 현행과 같다.

**FR-XBD-2** `scripts/check-cross.sh` 신설. 위 5종에 대해 `go build ./...` 과
`go vet ./...` 를 돌린다. 하나라도 실패하면 비영 종료한다.

**FR-XBD-3** `scripts/check-seams.sh` 신설. FR-XPL-5 를 강제한다 — `internal/`·`cmd/`
에서 `platform` 패키지와 `sysstat` 패키지를 제외한 파일에 다음이 나타나면 실패한다:
`runtime.GOOS`, `syscall.Kill`, `syscall.SIG`, `SysProcAttr`, `net.Listen("unix")`,
`net.Dial("unix")`, `"/proc/`, `exec.Command("lsof"`, `exec.Command("pgrep"`,
`exec.Command("ps"`, `creack/pty`.

**FR-XBD-4** `go test ./...` 는 darwin·linux 에서 전량 통과해야 한다. Windows 는
`GOOS=windows go vet ./...` 통과와, 플랫폼 독립 테스트(§4.2)의 통과까지를 이 트랙의
보증 범위로 한다 (§8 리스크 R-1).

---

### 3.10 비기능 요구 (NFR)

| ID | 요구 |
|---|---|
| **NFR-XP-1** | POSIX(darwin·linux)에서 관찰 가능한 동작은 §7 에 기록된 것 외에 바뀌지 않는다 |
| **NFR-XP-2** | 신규 모듈 의존은 `golang.org/x/sys` 하나뿐이다. 서드파티 PTY·프로세스 래퍼를 도입하지 않는다 (사용자 결정, §9 D-2) |
| **NFR-XP-3** | `platform` 패키지는 cgo 를 쓰지 않는다. cgo 는 `sysstat` 의 darwin mach 호출에만 남는다 (SYSTEM_STATS_SRS D-5 승계) |
| **NFR-XP-4** | `ProcInfo.Names` 는 pid 수와 무관하게 조회 1회다. 도구 100개에서 갱신 주기(2초)를 넘기지 않는다 (NFR-CNV-1 승계) |
| **NFR-XP-5** | PTY 읽기 경로(`readPTY`)에 인터페이스 호출이 추가되더라도 도구당 처리량은 현행 대비 유의미하게 떨어지지 않는다. `Read` 는 호출당 최대 1회의 간접 호출만 더한다 |
| **NFR-XP-6** | 모든 인터페이스의 "조회 실패" 는 오류가 아니라 "모름" 으로 표현된다. 호출자가 추측으로 채우지 않는다 |

### 3.11 제약 (Constraints)

| ID | 제약 |
|---|---|
| **C-1** | Windows 최소 지원 버전은 **Windows 10 1809 (10.0.17763)** — ConPTY 의 도입 버전이다. 그 미만은 지원하지 않으며, `CreatePseudoConsole` 조회 실패 시 명확한 오류를 낸다 |
| **C-2** | 개발 호스트가 darwin 이므로 Windows 실기 검증을 이 트랙 안에서 수행할 수 없다 (§8 R-1) |
| **C-3** | `dongminal` 은 단일 바이너리로 유지한다. 플랫폼별 보조 실행 파일을 만들지 않는다 |
| **C-4** | e2e(Playwright)는 서버를 `go run` 으로 띄운다. Windows 에서의 e2e 는 이 트랙의 범위가 아니다 |

---

## 4. 검증 (Verification)

### 4.1 요구사항 ↔ 검증 대응

| 요구 | 검증 방법 |
|---|---|
| FR-XPL-1~4 | `platform` 패키지 단위테스트 — `Current()` 가 모든 필드를 채우는지, 두 번 불러도 같은 값인지 |
| FR-XPL-5 | `scripts/check-seams.sh` (FR-XBD-3) |
| FR-XPR-1~5 | POSIX: 실제 프로세스를 띄워 `Terminate`/`Kill`/`Alive`/`Group` 검증. `NewGroup` 은 손자 프로세스가 함께 죽는지까지 확인 |
| FR-XPI-1~6 | Linux: `/proc` 파싱을 **고정된 픽스처 문자열**로 검증(파서 순수 함수 분리). 통합: 자기 자신의 pid 로 `CWD`·`Names` 확인, 임시 리스너를 띄워 `ListenerPIDs` 확인 |
| FR-XPT-1~4 | POSIX: `PTY.Start("/bin/sh")` → 명령 왕복 → `Resize` 반영 → `Kill` → `Wait`. `toolhub` 기존 테스트 전량이 회귀 게이트다 |
| FR-XPT-5,6 | Windows 실기 필요 (§8 R-1). 이 트랙은 컴파일·`vet` 까지 |
| FR-XSH-1~6 | `ShellSpec` 조립을 순수 함수로 분리해 픽스처 검증. POSIX 어댑터가 현행과 같은 Path/Args/Env 를 내는지 골든 비교 |
| FR-XIP-1~4 | POSIX: 실제 종단으로 Listen→Dial→왕복→Remove. `Exists` 의 낡은 종단 판정 |
| FR-XBR-1~3 | `look` 주입 방식(현행 `BrowserCommand` 의 성질)을 유지해 순수 함수로 검증. WSL 분기 포함 |
| FR-XWS-1 | `/proc/version` 내용을 픽스처로 준 감지 함수의 단위테스트 |
| FR-XSY-1~4 | `/proc/stat`·`/proc/meminfo` 픽스처 파싱 테스트. 기존 `sampler.go` 테스트가 회귀 게이트 |
| FR-XBD-1~4 | 스크립트 자체 실행 |

### 4.2 테스트 배치 원칙

`sysstat` 의 기존 배치(`sysstat.go`·`sampler.go` 는 태그 없음, `reader_*.go` 만 태그)를
따른다.

- **파싱·조립·판정 로직은 build tag 없는 순수 함수로 분리한다.** `/proc/stat` 파서,
  `/proc/net/tcp` 파서, `ShellSpec` 조립, WSL 감지, 브라우저 명령 조립이 여기 속한다.
  이 테스트들은 **모든 플랫폼에서 돈다.**
- **시스템 호출을 실제로 하는 테스트만** 해당 플랫폼 build tag 를 단다.

이 배치 덕분에 Windows 어댑터의 로직 부분은 darwin 호스트에서도 검증된다. 검증되지
않는 것은 WinAPI 호출 자체뿐이다.

### 4.3 회귀 게이트

이관(묶음 B~F)은 **동작 무변경**이 요구사항이다. 다음이 전량 통과해야 각 묶음이 끝난다.

```bash
go test ./...                 # darwin
GOOS=linux go build ./... && GOOS=linux go vet ./...
GOOS=windows go build ./... && GOOS=windows go vet ./...
scripts/check-seams.sh
scripts/verify-isolated.sh    # 격리 인스턴스 21항목
```

---

## 5. 비목표 (Non-Goals)

1. **Windows e2e(Playwright) 자동화** — C-4.
2. **Windows 서비스 등록 / launchd·systemd 유닛** — 기동은 현행대로 사용자가 한다.
3. **경로 변환(`/mnt/c` ↔ `C:\`)** — WSL 에서 Windows 경로를 다루는 기능은 요구된 바
   없다. 필요해지면 별도 트랙.
4. **Windows 에서의 전경 프로세스 이름 표시** — 대응 개념이 없다. 탭 이름은 기본값으로
   남는다 (현행 `fg_other.go` 와 같은 결과).
5. **`cmd.exe` 용 훅** — PowerShell 이 없는 Windows 는 실질적으로 존재하지 않는다.
   `cmd.exe` 는 최후 폴백이며 훅 없이 동작한다 (FR-XSH-3).
6. **ARM64 Windows** — 빌드 대상에 넣지 않는다 (FR-XBD-1).
7. **darwin 의 `/proc` 대체(libproc cgo)** — FR-XPI-3, cgo 를 늘리지 않는다.

---

## 6. 구현 계획 (Implementation Plan)

순서에는 의존이 있다. 앞 묶음이 뒤 묶음의 인터페이스를 정의한다.

**계획 정정 (착수 후 실측으로 확정).** 최초 계획은 Windows 어댑터 전량을 단계 9~12 로
미뤘다. 그러나 인터페이스를 세우면 `platform_windows.go` 가 그 구현을 **컴파일 시점에
요구**한다. 미루면 버릴 스텁을 쓰게 되고 그동안 `GOOS=windows` 빌드가 깨진 채로 남는다.
그래서 **이음매마다 POSIX 어댑터와 Windows 어댑터를 함께 쓴다.**

이것이 단계 7(POSIX 회귀 확인)의 안전성을 낮추지 않는다 — Windows 어댑터는 POSIX
빌드에서 컴파일조차 되지 않으므로 POSIX 동작에 닿을 수 없다. 얻는 것은 **매 단계
경계에서 3-OS 빌드가 초록으로 유지된다**는 것이다.

| 단계 | 묶음 | 내용 | 회귀 위험 | 상태 |
|---|---|---|---|---|
| 1 | A | `platform` 골격 · `OSKind` · WSL 감지 · `Paths` · `Browser`. 호출부 4곳 | LOW | **완료** |
| 2 | B | `Process`/`Group` + POSIX·Windows 어댑터. 호출부 9곳 | MEDIUM | **완료** |
| 3 | C | `ProcInfo` + darwin·linux·windows 어댑터. 호출부 6곳, `clientpid` 흡수 | MEDIUM | **완료** |
| 4 | D | `PTY`/`Terminal` + POSIX 어댑터. `toolhub` 개조, `fg_*.go` 통합 | **HIGH** | **완료** |
| 5 | G2 | Windows `PTY` (ConPTY) | **HIGH** | **완료 (미검증 — R-1)** |
| 6 | E | `ShellProvider` + 훅 자산 분리 + `powershell-hook.ps1` | MEDIUM | **완료** |
| 7 | F | `IPC` + 유닉스 도메인 소켓 어댑터 (양 플랫폼) | MEDIUM | **완료** |
| 8 | — | POSIX 회귀 확인 지점 — §4.3 전량 + 격리 인스턴스 21항목 | — | **완료** |
| 9 | H | `sysstat` linux·windows Reader | LOW | **완료** |
| 10 | I | 빌드·검사 스크립트, 문서 갱신 | LOW | **완료** |

각 단계 경계에서 §4.3 이 통과해야 다음으로 넘어간다. 단계 4·5 가 실패하더라도 1~3 은
그 자체로 가치가 있고 되돌릴 필요가 없다.

---

## 7. 동작 변경 기록 (Behavior Changes)

의도된 변경만 적는다. 그 외는 무변경이 요구사항이다 (NFR-XP-1).

| # | 이전 | 이후 | 이유 |
|---|---|---|---|
| 1 | `toolhub.Tool.PTMX() *os.File` 공개 | 제거. `Tool.Size()` 로 대체 | Windows ConPTY 는 `*os.File` 하나로 표현되지 않는다 (§2.4). 외부 사용처는 `seam/adapters/tool.go:122` 하나 |
| 2 | `cli.DefaultLog = "/tmp/dongminal.log"` 상수 | `Paths.DefaultLogFile()` | Windows 에 `/tmp` 가 없다. POSIX 값은 동일 |
| 3 | `cli.BrowserCommand(goos, url, look)` | `Browser.FramelessCommand(url)` | FR-XPL-5. darwin/linux 결과는 동일 |
| 4 | 헬퍼 설치가 symlink 시도 후 복사 폴백 | Windows 는 복사만 | 권한 없는 Windows 에서 매 기동 오류. POSIX 는 무변경 |
| 5 | `shellhooks/{bash-hook.sh,zdotdir}` | `shellhooks/posix/{...}` | 훅 자산의 OS 분리. 설치 결과 경로(`<binDir>/bash-hook.sh`)는 **무변경** — 기존 세션의 `BASH_ENV` 가 깨지지 않는다 |
| 6 | `fg_posix.go` / `fg_other.go` build tag 분리 | 삭제. `foreground.go` 로 통합 | 분리 사유(`TIOCGPGRP`·`/proc`)가 `platform` 뒤로 이동. 관찰 동작 무변경 |
| 7 | Linux 에서 `sysstat` 전량 `ErrUnsupported` (상태바 지표 공란) | 실제 값 표시 | FR-XSY-2. **Linux 사용자에게는 기능 추가다** |
| 8 | Linux 에서 busy·cwd·포트 조회가 `pgrep`/`lsof` 외부 프로세스 | `/proc` 직접 읽기 | FR-XPI-2. 관찰 결과는 같고, 외부 CLI 미설치 환경에서 동작이 **개선**된다 |
| 9 | `git/jobs`: `execStream` 종료 후 그룹에 남은 자손이 있으면 그대로 남았다 | Windows 만 `Group.Close()` 시점에 함께 끝난다. **POSIX 는 무변경** | Job Object 핸들을 놓으면서 살려 두면 고아가 된다. 핸들 누수와 고아 중 고아를 막는 쪽을 택했다 (`Group.Close` 주석) |

### 7.1 의존성 변경

`golang.org/x/sys v0.36.0` 을 추가했다 (NFR-XP-2). **v0.36.0 으로 고정한 이유**는
go 지시자다 — 최신 v0.47.0 은 `go 1.25.0` 을 요구해 이 모듈의 `go 1.24` 를 끌어올린다.
v0.36.0 은 `go 1.24.0` 이므로 툴체인 요구사항이 오르지 않는다. 이 트랙이 쓰는 API
(`OpenProcess`·`CreateJobObject`·ConPTY·`GetSystemTimes`)는 전부 그 이전부터 있다.

---

## 8. 리스크 (Risks)

| ID | 리스크 | 수준 | 완화 |
|---|---|---|---|
| **R-1** | **Windows 실기 검증 불가.** 개발 호스트가 darwin 이다 (C-2). ConPTY·Job Object·named pipe 는 컴파일이 통과해도 동작을 보증할 수 없다 | **HIGH** | §4.2 의 배치로 로직 부분은 darwin 에서 검증한다. WinAPI 호출 자체는 **검증되지 않은 채로 인도된다** — 이 사실을 인도 시 명시한다. §9 D-1 |
| **R-2** | ConPTY 를 `x/sys/windows` 저수준으로 직접 구현 (NFR-XP-2). `os/exec` 를 못 쓰므로 프로세스 수명 관리(핸들 누수·좀비·`Wait` 경합)를 새로 쓴다 | **HIGH** | 단계 10 을 마지막에 둔다. `Terminal` 인터페이스가 경계이므로 실패해도 다른 단계에 번지지 않는다 |
| **R-3** | `toolhub` 개조(단계 4)가 hot path(`readPTY`)와 `kill()` 의 `sync.Once` 경합 규약을 건드린다. 이 부분은 주석이 명시하듯 race-free 가 설계로 보장된 자리다 | **HIGH** | `Terminal` 이 `ptmx`+`cmd` 를 1:1 로 대체하도록 설계했다(FR-XPT-3). `kill()` 의 3단계 구조와 nil 방어를 그대로 옮긴다. `toolhub` 기존 테스트 전량이 게이트 |
| **R-4** | PowerShell 훅의 `prompt` 감싸기가 사용자 프로필(oh-my-posh 등)과 충돌 | MEDIUM | 기존 `prompt` 를 보존해 위임한다. 충돌 시 cwd 추적만 잃고 셸은 정상 동작 |
| **R-5** | Windows `Terminate` 의미론이 POSIX SIGTERM 과 완전히 대응하지 않는다 (`CTRL_BREAK` 는 같은 콘솔 그룹에만 닿는다) | MEDIUM | 실패 시 `Kill` 로 물러선다 (FR-XPR-3). 유예 시간은 현행과 동일 |
| **R-6** | 단계 4·5 가 셸 훅 설치 경로를 건드린다. 잘못하면 **기존 사용자의 살아 있는 도구**가 사라진 훅 경로를 참조한다 | MEDIUM | 설치 **결과 경로를 바꾸지 않는다** (§7 #5). 바뀌는 것은 임베드 트리의 소스 위치뿐 |
| **R-7** | 인터페이스 16종을 한 트랙에 세우면서 과설계로 흐를 위험 | LOW | 인터페이스는 §2.2 의 **실측된 이음매에만** 대응한다. 실측되지 않은 차이를 위한 어댑터는 만들지 않는다 (FR-XWS-2 가 그 사례) |

---

## 9. 열린 결정 (Open Decisions)

| ID | 결정 | 상태 |
|---|---|---|
| **D-1** | **Windows 실기 검증을 누가·어떻게 하는가.** R-1 의 잔여 위험을 없애는 유일한 방법이다. 선택지: (a) 사용자가 Windows 실기에서 수동 확인, (b) Windows runner CI 도입, (c) 검증 없이 인도하고 이슈로 대응 | **미해결 — 착수 전 확인 필요** |
| **D-2** | 신규 의존은 `golang.org/x/sys` 까지 | 해결 (사용자 결정) |
| **D-3** | 범위는 Windows-native 실동작까지 | 해결 (사용자 결정) |
| **D-4** | WSL 은 Linux 어댑터 + 런타임 감지 | 해결 (사용자 결정, FR-XWS-2) |
| **D-5** | darwin 은 계속 1급 지원 대상이다 — 개발 호스트이자 현재 유일한 사용 환경 | 해결 (NFR-XP-1) |

---

## 10. 구현 결과 (Implementation Outcome)

### 10.1 최종 상태

| 항목 | 결과 |
|---|---|
| `GOOS=darwin` (arm64·amd64) | build·vet·`go test ./...` 통과 |
| `GOOS=linux` (amd64·arm64) | build·vet 통과 |
| `GOOS=windows` (amd64) | build·vet 통과 — 착수 시 8건 → **0건** |
| `scripts/check-seams.sh` | 통과 — OS 의존 호출이 `platform` 밖에 없음 |
| `scripts/verify-isolated.sh` | 21/21 통과 (PTY 도구 생성·데몬 IPC·git 표면 포함) |

`internal/shared/platform` 이 제공하는 인터페이스 8종:
`Process`·`Group` / `ProcInfo` / `PTY`·`Terminal` / `ShellProvider` / `IPC` /
`Paths` / `Browser`, 그리고 표시용 값 `OSKind`.

### 10.2 스펙 대비 정정 3건

착수 후 실측으로 바꾼 것들이다. 이유를 함께 남긴다.

**① Windows 어댑터를 단계 9~12 로 미루지 않고 이음매마다 함께 썼다** (§6).
인터페이스를 세우면 `platform_windows.go` 가 그 구현을 컴파일 시점에 요구한다.
미루면 버릴 스텁을 쓰게 되고 그동안 `GOOS=windows` 빌드가 깨진 채로 남는다.
POSIX 안전성은 낮아지지 않는다 — Windows 어댑터는 POSIX 빌드에서 컴파일조차
되지 않으므로 POSIX 동작에 닿을 수 없다.

**② IPC 는 named pipe 대신 유닉스 도메인 소켓을 양 플랫폼에서 쓴다** (FR-XIP-3 정정).
AF_UNIX 는 Windows 10 1803+ 에서 지원되고, 이 트랙의 Windows 최소 버전은 ConPTY
때문에 1809 다 (C-1). 즉 **모든 지원 대상에서 쓸 수 있다.** 오버랩드 I/O 로 named
pipe 리스너를 직접 구현하는 것은 실기 검증 없이 인도하기에 위험이 크고, 표준
`net` 패키지가 이미 검증한 경로를 쓰는 편이 R-1 을 줄인다. OS 차이는
`Exists` 판정 하나로 좁혀졌다 — POSIX 는 소켓 비트를 보고, Windows 의 AF_UNIX
종단은 재분석 지점으로 나타나므로 존재만 본다.

**③ ConPTY 의 UTF-8 은 부모가 아니라 셸 훅이 맞춘다** (FR-XPT-6 정정).
`SetConsoleOutputCP` 는 **호출한 프로세스의 콘솔**에 적용되며, 부모가 자식
의사 콘솔의 코드페이지를 정해 줄 API 는 없다. 그래서 `powershell-hook.ps1` 이
`[Console]::OutputEncoding` 과 `chcp 65001` 로 스스로 맞춘다 (FR-XSH-5).

### 10.3 스펙에 없었던 발견

- **이음매는 16종이 아니라 18종이었다.** `seam/clientpid` 의 `Parent`(`ps -o ppid=`)
  와 `FromRemoteAddr`(`lsof -i tcp@…`)가 §2.2 에 빠져 있었다. `dmctl who-am-i` 의
  클라이언트 역추적 경로다. `ProcInfo.ParentPID`·`ConnectionOwnerPID` 로 흡수하고
  `clientpid` 패키지는 제거했다 (FR-XPI-7).
- **종료 신호 집합도 이음매다.** `signal.NotifyContext(…, SIGTERM, SIGHUP)` 두 곳.
  Windows 에서 그 상수들은 존재하지만 **전달되지 않으므로**, 나열하는 것 자체가
  지키지 못할 약속이다. `Process.ShutdownSignals()` 로 옮겼다.
- **`cmd/dongminal/main.go:122` 의 `Setsid`** 가 §2.2 표에서 빠져 있었다. 첫
  크로스 컴파일이 의존 패키지에서 먼저 멈춰 그 파일까지 닿지 않았기 때문이다.

### 10.4 남은 위험

**R-1 은 해소되지 않았다.** 개발 호스트가 darwin 이므로 Windows 실기 검증이
없다. 이 트랙이 보증하는 것은 다음까지다.

- 5개 대상의 build·vet 통과
- **판단 로직 전량의 단위 테스트** — 어댑터를 build tag 없이 두고 주입점을
  열어 둔 덕분에, Windows 의 TCP 표 해석·브라우저 탐색·경로 규칙·리눅스 `/proc`
  파싱까지 darwin 에서 검증된다 (§4.2)
- POSIX 무회귀 (기존 테스트 전량 + 격리 인스턴스 21항목)

**검증되지 않은 채 인도되는 것**은 WinAPI 호출 자체다: ConPTY 생성/크기변경/종료,
Job Object 배정과 스레드 재개, toolhelp 스냅샷, `GetExtendedTcpTable`,
`GetSystemTimes`/`GlobalMemoryStatusEx`, 그리고 `powershell-hook.ps1` 의 실행.
D-1 이 정해지기 전까지 이 목록은 그대로 열려 있다.

---

## 11. 실기 1차 피드백 (Windows)

R-1 이 현실화됐다. Windows 에서 **UI 는 뜨는데 터미널 탭이 빈다**는 보고를 받았다.

### 11.1 정적 재검증에서 확인한 것

원인을 추측으로 고치지 않기 위해 검증 가능한 것부터 지웠다.

| 의심 | 결과 |
|---|---|
| Go 가 Windows AF_UNIX 를 지원하지 않는다 | **아니다.** `net/unixsock_posix.go` 빌드 태그에 `windows` 가 있고 전용 테스트도 있다 |
| Windows 훅이 임베드되지 않았다 | **아니다.** 두 훅 트리의 전개를 테스트로 고정했다 (`install_shellhooks_test.go`) |
| WinAPI 시그니처·상수가 틀렸다 | **아니다.** x/sys v0.36.0 원본과 대조했고 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE=0x00020016` 은 `ProcThreadAttributeValue(22,F,T,F)` 로 검산했다 |
| ConPTY 파이프를 `os.NewFile` 로 감싼 것이 막힌다 | **아니다.** `newFileFromNewFile` 이 `IsNonblock` 으로 동기 파이프를 판정해 블로킹 모드로 연다 |
| 도구 생성이 크기 0 을 넘긴다 | **아니다.** `ParseSize` 가 120×40 을 기본으로 주고 0 을 거부한다 |

### 11.2 그 과정에서 찾은 실제 결함 4건

**① 환경 중복이 정리되지 않는다 (Windows 한정).**
호출자는 `append(os.Environ(), 덧붙일것...)` 로 환경을 만든다. `os/exec` 는
`Start()` 안에서 `dedupEnv` 로 **뒤엣것이 이기게** 정리해 준다. POSIX 어댑터는
`exec.Cmd` 를 쓰니 그대로 적용되는데, **ConPTY 경로는 `os/exec` 를 우회하므로
그 정리가 사라졌다.** 결과적으로 Windows 터미널의 `PATH` 는 `binDir` 이 빠진
원본이 이겨 `dmctl`·`edit`·`download`·`detach` 가 잡히지 않는다.
→ `platform.dedupEnv` 를 두 어댑터가 공유한다. Windows 는 이름을 접어 비교한다.

**② 크기 0 의 하한이 없다.**
POSIX 는 0×0 을 받아도 커널이 기본값을 주지만 **ConPTY 는 `E_INVALIDARG` 로
실패한다.** 지금 경로에서는 0 이 오지 않지만, 오는 순간 POSIX 에서는 아무
증상도 없이 Windows 에서만 깨진다. → `clampSize` 로 두 어댑터가 함께 막는다.

**③ PowerShell 훅에 UTF-8 BOM 이 없다.**
PowerShell 5.1 은 BOM 없는 `.ps1` 을 **현재 ANSI 코드페이지**로 읽는다. 이 훅에는
한국어 주석과 문자열이 있어, CP949 오독 중 한 바이트가 따옴표로 보이면 그 자리에서
구문 오류가 난다. → BOM 을 붙이고 테스트로 고정했다.

**④ 도구 생성 실패가 화면에 닿지 않는다.**
프론트엔드는 `OP.ERROR` 를 빨간 글씨로 정상 처리하는데, 서버가 보내던 것은
`"create failed"` 라는 고정 문구뿐이었다. 실제 오류는 서버 로그에만 남아,
사용자에게는 **빈 터미널과 구별되지 않았다.** → 실제 오류 문구를 실어 보낸다.

### 11.3 `-File` → 닷소싱 (FR-XSH-3 정정)

`powershell.exe -NoExit -File hook.ps1` 은 스크립트 실행 후 대화형으로 남는지가
판본에 따라 불확실하다. 남지 않으면 셸이 훅만 실행하고 즉시 죽는다 — 도구가
뜨자마자 사라진다. `-NoExit -Command ". '<경로>'"` 에는 그 모호함이 없고,
닷소싱이라 훅이 정의한 함수가 세션에 그대로 남는다. 경로의 작은따옴표는 겹쳐
escape 한다(사용자 이름의 아포스트로피).

### 11.4 `dongminal doctor` (신설)

계층이 겹겹이라 "터미널이 안 뜬다" 는 증상만으로는 셸 탐색·헬퍼 설치·의사 터미널
기동·IPC 중 어디가 깨졌는지 가를 수 없다. 서버가 쓰는 **바로 그 platform 코드**를
같은 순서로 실제 실행하는 진단을 넣는다.

의사 터미널은 **두 번** 시험한다 — 훅 없는 맨 셸과 훅을 얹은 셸. 맨 셸이 되고
훅 셸이 안 되면 범인은 훅이고, 둘 다 안 되면 의사 터미널이다. 이 구분이 이
진단의 핵심이다.

`doctor` 는 이 트랙의 Windows 인수 시험이기도 하다 — 실기에서 전부 통과해야
플랫폼 계층이 그 호스트에서 동작한다고 말할 수 있다.
