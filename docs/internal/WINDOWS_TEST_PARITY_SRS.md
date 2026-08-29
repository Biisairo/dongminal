# SRS: Windows 테스트 패리티 — 실패 356줄의 해소와 그 아래 묻힌 제품 결함 4건 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

CI 의 `test (windows-latest)` 잡은 **도입 이래 한 번도 통과한 적이 없다.**
`e8d6636` 로 워크플로우가 들어온 뒤 실행 8회가 전부 failure 또는 cancelled 다.

한 번도 초록이었던 적이 없으므로 아무도 읽지 않았고, 그 사이에 **Windows 에서
실제로 깨지는 제품 결함 4건이 그 안에 묻혀 있었다.** 테스트가 그것을 정확히
잡아내고 있었는데 노이즈 231줄에 가려 보이지 않았다.

본 SRS 는 두 가지를 한다.

1. **제품 결함 4건을 고친다** — 이것이 우선이다. 테스트를 고치는 일이 아니다
2. **테스트의 OS 이식성을 세워** 그 잡을 초록으로 만든다 — 초록이어야 다음 결함이
   보인다

원칙은 하나다 — **테스트를 통과시키려고 프로덕션 판정을 무르게 하지 않는다.**
실패의 대부분은 프로덕션 가드가 **정확했기 때문에** 났다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| P | 제품 결함 4건 (D1~D4) — 마이그레이션 데몬 판정, 설치 자산 삭제, worktree 경로, 이음매 검사의 구멍 |
| T | 테스트 픽스처의 절대경로 리터럴 (실패 205+줄) |
| J | 테스트 픽스처의 JSON 이스케이프 (실패 22줄) |
| S | POSIX 전용 테스트의 build tag 분리 |
| L | 리눅스 어댑터의 `/proc` 경로 조립 |

**제외:** §5 참조.

### 1.3 정의 (Definitions)

| 용어 | 뜻 |
|---|---|
| OS 형태 경로 | `filepath` 가 만드는 형태. Windows 는 `C:\a\b`, POSIX 는 `/a/b` |
| git 형태 경로 | Windows 의 git 이 내는 형태. `C:/a/b` — 드라이브 문자에 슬래시 |
| fs 형태 경로 | `io/fs`·`embed.FS` 의 형태. **언제나** 슬래시, OS 무관 |
| POSIX 전용 테스트 | 검증 대상이 POSIX 에만 있는 개념인 테스트 (실행 권한 비트, 전경 프로세스 그룹, bash/zsh 훅) |

### 1.4 참고 (References)

- `CROSS_PLATFORM_SRS.md` — 특히 FR-XBD-4(Windows 보증 범위), §4.2(테스트 배치
  원칙), §10.4 R-4(이 SRS 를 낳은 항목)
- `RUN_ORCHESTRATION_SRS.md` — worktree 소유 판정(D3 의 영향 범위)
- CI 실측: run 33257794325 잡 `test (windows-latest)` (job 99114432005)

### 1.5 개요 (Overview)

§2 가 실측이고 §3 이 요구사항이다. §2 를 먼저 읽어야 §3 이 왜 그 모양인지 알 수
있다 — 이 트랙은 설계에서 출발하지 않고 **로그 356줄의 전수 분류**에서 출발했다.

---

## 2. 현황 (Identified Issue)

### 2.1 실측 — 실패 356줄의 전수 분류

job 99114432005 의 로그를 기계로 분류했다. 패키지 15개가 실패한다.

    ctl/migrate            daemon/ipc              shared/platform
    shared/runtime         shared/toolhub          git/core
    git/jobs               git/query               git/store      (600초 타임아웃)
    git/write              domain/worktree         domain/wsentry
    gitapi (600초 타임아웃) httpapi                 webserver/toolclient

원인은 다섯이다.

| 원인 | 실패줄 | 성격 |
|---|---|---|
| ① POSIX 절대경로 리터럴 | 205+ | 테스트 픽스처 |
| ② JSON 에 Windows 경로 문자열 삽입 | 22 | 테스트 픽스처 |
| ③ git 형태 ↔ OS 형태 경로 | — | **제품 결함 (D3)** |
| ④ POSIX 전용 개념 | ~20 | 테스트 배치 |
| ⑤ `/proc` 경로를 `filepath.Join` 으로 조립 | 6 | 어댑터 이식성 |

그리고 원인 분류에 들어가지 않는 **단독 제품 결함 3건**(D1·D2·D4)이 §2.3 이다.

### 2.2 원인 ①이 잡 시간의 대부분을 먹는다

`filepath.IsAbs` 는 OS 의존이다.

    darwin/linux   IsAbs("/repo") = true    IsAbs(`C:\repo`) = false
    windows        IsAbs("/repo") = false   IsAbs(`C:\repo`) = true

프로덕션 가드는 **정확하다** — Windows 에서 `/repo` 는 실제로 절대경로가 아니다.

    internal/webserver/domain/git/core/exec.go:93
    internal/webserver/domain/git/core/write.go:76
    internal/webserver/domain/git/jobs/job.go:226
    internal/webserver/domain/worktree/worktree.go:191

테스트 46개 파일이 `"/work/repo"`(228회)·`"/tmp/repo"`(61회)·`"/r"`(33회)·
`"/repo"`(30회)·`"/home/u"`(29회) 같은 리터럴을 쓴다. Windows 에서 이것들이
절대경로가 아니게 되어 가드에 걸린다.

**파생 피해가 본체보다 크다.** 앞 단계가 에러로 끝나므로:

- `git/jobs` — `job_test.go:296` 에서 nil 역참조 패닉. **패키지 전체가 중단**된다
- `git/store` — `TestStore_StatusSingleFlight` 가 오지 않는 채널을 기다려 **600초**
- `gitapi` — `TestGitStatus_ConcurrentSingleFlight` 가 같은 이유로 **600초**

잡 실행시간 약 20분 중 20분이 이 둘이다.

### 2.3 제품 결함 4건 — 이 SRS 의 존재 이유

#### D1 · 마이그레이션이 Windows 에서 데몬을 못 본다 — **이음매 누출**

`internal/ctl/migrate/apply.go:182-200`

```go
p, err := os.FindProcess(pid)
if err != nil { return 0, false }
if err := p.Signal(syscall.Signal(0)); err != nil { return 0, false }
```

`os.Process.Signal` 은 **Windows 에서 구현돼 있지 않다** — Kill 외에는 오류를
낸다. 따라서 `daemonAlive` 는 Windows 에서 **언제나 `(0,false)`** 다.

결과: **데몬이 도는 중에 마이그레이션이 진행된다.** 살아 있는 데몬이 쥔
workspace 상태를 덮어쓴다. 테스트(`TestApply_RefusesWhileDaemonAlive`)는 자기
자신의 pid 를 넣어 이것을 정확히 잡았다.

`platform.Process.Alive` 가 이미 있고 Windows 구현도 올바르다
(`process_windows.go:34`, `OpenProcess`+`GetExitCodeProcess`). **이 호출부만
그것을 안 쓰고 있었다.**

#### D2 · 설치가 매번 생성된 hooks.json 을 지운다

`internal/shared/runtime/install.go:100`

```go
var generatedPluginPaths = []string{"hooks", "hooks/hooks.json"}
```

이 목록은 `pruneToEmbedded` 의 `keep` 다. 그런데 그 함수는 정리 대상을
`filepath.Rel(dst, p)` 로 만든다 — Windows 에서 `hooks\hooks.json` 이다.
`"hooks/hooks.json"` 과 다르므로 keep 에 걸리지 않는다.

결과: **설치할 때마다 방금 만든 `hooks/hooks.json` 을 지운다.** Windows 에서
에이전트 훅(activity·notify 연동)이 동작하지 않는다.

`"hooks"` 는 한 조각이라 살아남아 디렉터리만 남는다 — 그래서 "디렉터리는 있는데
비었다" 로 나타난다.

#### D3 · worktree 경로가 git 형태 그대로다

`internal/webserver/domain/worktree/worktree.go:513 parseWorktreeList`

`git worktree list --porcelain` 의 출력을 **정규화 없이** `Entry.Path` 에 담는다.
Windows 의 git 은 `C:/Users/...` 를 준다. 소비처는 OS 형태를 기대한다.

    worktree.go:451              if e.Path == path        (gone() — 완전 일치)
    handlers_git_worktree.go:99  gitWorktreeOwner(e.Path, userRoot, runRoot)  (접두사)

`userRoot`·`runRoot`·`path` 는 모두 Go 가 `filepath` 로 만든 `C:\...` 다.

결과: Windows 에서 **worktree 소유 판정이 전부 `outside` 로 떨어지고**, `gone()`
이 살아 있는 worktree 를 사라졌다고 본다. Run 격리 기능이 오동작한다.

#### D4 · 이음매 검사에 구멍이 있다

`scripts/check-seams.sh` 의 금지 패턴은 `syscall.Kill(`·`syscall.SIG[A-Z]` 를
본다. 그런데 D1 이 쓴 것은 `os.FindProcess` 와 `syscall.Signal(` 이다 — **둘 다
목록에 없다.**

이 검사는 CROSS_PLATFORM_SRS FR-XBD-3 이 세운 불변식("OS 의존 호출은 platform
안에만")의 유일한 집행 수단이다. 구멍이 있으면 불변식이 아니라 권고다.

#### D5 · git 출력 경로가 정규화 없이 나가는 자리가 두 곳 더 있다

D3 을 고친 뒤 §6 단계 6(잔여 재판정)에서 나왔다. 같은 결함이 두 곳 더 있다.

    internal/webserver/domain/git/core/repo.go   RepoRoot
    internal/webserver/domain/worktree/worktree.go   Manager.Resolve

둘 다 `rev-parse --show-toplevel` 의 출력을 그대로 돌려준다. 그 값의 행선지가
D3 보다 넓다 — 저장소 상태 캐시의 키(`store.go:208`), 핀 경로와의 대칭 판정
(`wsentry.isRepoRoot`), 그리고 API 응답이다.

`wsentry.isRepoRoot` 는 `NormalizePath` 가 `filepath.Clean` 을 하므로 우연히
살아 있었다. 나머지는 아니다.

#### D6 · 훅이 가리키는 헬퍼 경로에 확장자가 없다

`internal/shared/runtime/install.go`

설치는 헬퍼를 `name + paths.ExeSuffix()` 로 깐다(`install.go:59`) — Windows 에서
`dmctl.exe` 다. 그런데 훅 파일에 적는 명령은 `filepath.Join(binDir, "dmctl")`
이었다(`:170`, `:192`). 실재하지 않는 경로를 가리킨다.

`cmd` 의 PATHEXT 해석이 이것을 가려 줄 수는 있다 — 확장자 없는 절대경로에
`.exe` 를 붙여 찾아 준다. 그러나 그것은 **훅을 무엇이 실행하느냐에 달린 우연**
이고, 같은 이름을 두 곳에서 다르게 만드는 것 자체가 결함이다. 한 규칙
(`dmctlPath`)으로 모은다.

#### D7 · 파일 전송이 Windows 에서 통째로 막혀 있다

`internal/webserver/httpapi/handlers_files.go`

전송 종단 넷(`/api/upload`·`/api/download`·`/api/file/read`·`/api/file/write`)이
모두 `safeResolve("/", …)` 로 경로를 푼다. 그 `"/"` 는 **"어디든"** 을 적은
것이지 "POSIX 루트 아래" 가 아니다 (`handlers_fs.go:21` 이 그 대비를 설명한다).

그런데 `safeResolve` 는 `filepath.Rel(baseDir, cleaned)` 로 봉쇄를 판정한다.
Windows 에서 `filepath.Rel("/", "C:\Users\x")` 는 **볼륨이 달라 오류**이고,
그 오류가 그대로 `403 forbidden` 이 된다.

**업로드도 다운로드도 한 건도 되지 않는다.** `feat(transfer)` 로 들어온 기능
전체가 Windows 에서 죽어 있었다. 테스트 여덟이 이것을 403 으로 정확히 잡고
있었다.

### 2.5 코드 전수 감사 — "경로가 OS 마다 다르다" 를 기준으로

D3·D5·D6·D7 이 전부 같은 뿌리에서 나왔으므로, 프로덕션 코드
(`internal/`·`cmd/`)를 그 기준으로 훑었다. 계열과 결과는 다음과 같다.

| # | 계열 | 발견 | 판정 |
|---|---|---|---|
| 1 | 슬래시로 직접 조립·분해 | 13곳 | **전부 정당** — URL(`static.go`), git ref(`remote+"/"+branch`), map 키 |
| 2 | `HasPrefix(p,"/")` 로 절대경로 판정 | 3곳 | 2곳 정당(.gitignore 줄·ref 이름), **1곳은 가드였다 → D8** |
| 3 | 경로 접두사 봉쇄 판정 | 3곳 | `filepath.Separator` 를 쓴다 — 정당 |
| 4 | `filepath.Rel` | 7곳 | 6곳 정당(같은 트리·오류를 거부로 처리), **1곳이 D7** |
| 5 | `path` 와 `filepath` 혼용 | 임포트 4곳 | 전부 정당 — `/proc`·embed·URL·git pathspec |
| 6 | `PATH` 목록 구분자 | 1곳 | `os.PathListSeparator` — 정당 |
| 7 | 하드코딩된 POSIX 경로 | 1곳 | `platform/shell.go` 의 POSIX 폴백 — 어댑터 안이므로 정당 |
| 8 | 파일 이름 안전 문자 | `slug` | 허용 목록 방식이라 Windows 금지문자가 자동 배제된다 — 정당 |
| 9 | `~` 확장 | 1곳 | `~/` 만 본다. Windows 에 `~` 관용구가 없어 실질 영향 없음 |
| 10 | 실행 파일 확장자 | — | **D6** |
| 11 | git 출력 경로 | — | **D3 · D5** |

**감사에서 확인한 것은 "슬래시를 박았는가" 만이 아니다.** 슬래시를 박은 13곳은
대부분 정당했다 — URL·git ref·map 키는 OS 경로가 아니기 때문이다. 진짜 결함은
**OS 경로를 다루면서 한쪽 OS 의 의미만 가정한 자리**에 있었다.

#### D8 · 경로 가드가 슬래시만 구분자로 본다

`internal/webserver/domain/git/core/guard.go` 의 `RelPath`

    for _, seg := range strings.Split(p, "/") { if seg == ".." { 거부 } }
    if path.Clean(p) != p { 거부 }

Windows 에서는 `\` 도 구분자다. `src\..\x` 는 슬래시로 나누면 **한 조각**이라
부모 참조 검사를 지나가고, `path.Clean` 도 슬래시만 알므로 정규형 검사에도
걸리지 않는다. 이 값은 **git 에 경로로 넘어가는 자리**다 — 그 함수의 주석이
스스로 "여기가 뚫리면 임의 파일 접근" 이라고 적어 두었다.

같은 자리에 하나 더 있다. `filepath.IsAbs` 는 Windows 의 **드라이브 상대 경로**
(`C:foo`)와 **볼륨 없는 루트 상대 경로**(`\foo`)를 절대경로로 보지 않는다.
둘 다 저장소 밖을 가리킬 수 있다.

조치: 검사용 사본을 `filepath.ToSlash` 로 만들어 조각을 나누고,
`filepath.VolumeName(p) != ""` 를 거부에 더한다. POSIX 에서 `ToSlash` 는 항등,
`VolumeName` 은 언제나 빈 문자열이므로 **그쪽 동작은 그대로다** — POSIX 의 `\`
는 파일 이름에 쓸 수 있는 평범한 글자이며, 돌려주는 값은 원본 그대로다.

### 2.6 원인 ⑤ — `/proc` 은 언제나 POSIX 경로다


`internal/shared/platform/procinfo.go:246` 이 `filepath.Join(procRoot, elem...)`
으로 `/proc` 경로를 만든다. Windows 에서 `\proc\100\...` 가 된다.

리눅스 어댑터는 Windows 에서 실행되지 않으므로 **프로덕션에는 무해하다.** 그러나
CROSS_PLATFORM_SRS §4.2 가 내세운 "리눅스 `/proc` 파싱까지 다른 OS 에서
검증된다" 는 표 기반 fake 의 키가 어긋나 Windows 에서 성립하지 않는다.

`/proc` 은 리눅스 커널의 경로이지 호스트 OS 의 경로가 아니다. `path.Join` 이 맞다.

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 P — 제품 결함

**FR-WTP-1.** `internal/ctl/migrate` 의 데몬 생존 판정은 `platform.Process.Alive`
를 쓴다. `os.FindProcess`·`syscall.Signal` 을 쓰지 않는다.
*검증:* 자기 pid 를 `paned.pid` 에 넣고 `Apply` 가 `ErrDaemonRunning` 을 내는
테스트가 5개 대상 전부에서 통과한다.

**FR-WTP-2.** `generatedPluginPaths` 의 항목은 정리 로직이 만드는 것과 **같은
형태**여야 한다. 형태가 갈리지 않도록 `keep` 비교는 한 형태로 정규화한 뒤 한다.
*검증:* 설치를 두 번 연속 수행한 뒤 `hooks/hooks.json` 이 남아 있다 —
`TestInstallAgentPlugin_PrunesStaleAssets`·`TestInstall_DoesNotPruneBinDir`.

**FR-WTP-3.** `parseWorktreeList` 는 `Entry.Path` 를 **OS 형태로 정규화**해
내놓는다. git 형태 경로가 이 함수 밖으로 나가지 않는다.
*근거:* FR-GIT-246 이 "worktree 의 git 실행·파싱은 이 패키지 안 한 곳" 이라고
정했다. 정규화도 그 자리에 둔다 — 소비처마다 정규화하면 한 곳이 빠진다.
*검증:* 실제 저장소로 `List` 를 부르고 모든 `Entry.Path` 가
`filepath.Clean(그 자신)` 과 같다.

**FR-WTP-4.** `scripts/check-seams.sh` 는 `os.FindProcess`·`syscall.Signal(`
을 금지 패턴에 넣는다.
*검증:* D1 을 되돌린 상태에서 검사가 실패한다(검출기의 자기 검증).

**FR-WTP-5.** `RepoRoot`·`Resolve` 도 `parseWorktreeList` 와 같은 규칙을 따른다
— git 출력 경로는 그 함수 밖으로 OS 형태로만 나간다 (D5).
*검증:* `TestRepoRoot` 의 "정규형이 아닌 출력" 케이스. 이 케이스는 darwin 에서도
변별한다(`/a/b/sub/..` ≠ `/a/b`).

**FR-WTP-6.** 설치가 만드는 헬퍼의 이름과, 훅 파일이 그 헬퍼를 가리키는 이름은
**한 함수에서 나온다** (D6).
*검증:* `TestInstallAgentPlugin_Hooks`·`TestInstallAgentHooks_Activity` 가 훅
원문에서 `dmctlPath(binDir)` 를 찾는다.

**NFR-WTP-5.** 회귀 테스트의 변별력은 정직하게 적는다. D1·D2·D6 의 테스트는
**Windows 에서만 변별한다** — 그 결함들이 Windows 에만 나타나기 때문이다.
darwin 에서는 고치기 전에도 통과한다. 따라서 이들의 실질적 회귀 방어는
`test (windows-latest)` 잡이 초록으로 유지되는 것이며(NFR-WTP-2), 그것이 이
트랙이 그 잡에 집착하는 이유다. D3·D5 는 darwin 에서도 변별한다.

**NFR-WTP-1.** D1~D3 의 수정은 각각 **회귀 테스트를 동반한다.** 테스트 없이 고친
결함은 다음에 같은 자리로 돌아온다.

### 3.2 묶음 T — 절대경로 리터럴

**FR-WTP-10.** 테스트가 절대경로를 필요로 할 때 리터럴을 쓰지 않고 공용 도우미로
만든다. 도우미는 `runtime.GOOS` 분기 없이 OS 형태 절대경로를 낸다.

    testpath.Abs("work", "repo")
      POSIX    /work/repo
      Windows  C:\work\repo   (현재 볼륨)

*구현 근거:* `filepath.Abs(string(filepath.Separator))` 는 POSIX 에서 `/`,
Windows 에서 현재 볼륨의 루트(`C:\`)를 준다. 분기가 필요 없다.

**FR-WTP-11.** 도우미는 `internal/shared/testpath` 에 둔다. 테스트 전용 패키지가
아니라 일반 패키지여야 한다 — `_test.go` 안의 것은 패키지를 넘어 공유되지 않는다.

**FR-WTP-12.** 기대값(argv·기록·응답 본문)도 같은 도우미로 만든다. 입력만 바꾸고
기대값을 리터럴로 두면 Windows 에서 다시 어긋난다.

**제약 C-1.** 이 치환은 **프로덕션 코드를 건드리지 않는다.** 가드를 무르게 하는
변경이 한 줄이라도 있으면 이 묶음의 위반이다.

### 3.3 묶음 J — JSON 픽스처

**FR-WTP-20.** 테스트가 경로를 담은 JSON 본문을 만들 때 문자열 결합
(`fmt.Sprintf`)을 쓰지 않고 `json.Marshal`(또는 `strconv.Quote`)로 만든다.
*근거:* `C:\Users\...` 의 `\U` 는 유효한 JSON 이스케이프가 아니다.
*검증:* 해당 테스트가 Windows 에서 `invalid character 'U' in string escape code`
를 내지 않는다.

### 3.4 묶음 S — POSIX 전용 테스트

**FR-WTP-30.** POSIX 에만 있는 개념을 검증하는 테스트는 `//go:build !windows`
아래 둔다. 대상은 최소 다음이다.

| 대상 | 개념 |
|---|---|
| `paths_test.go` `TestCopyExecutable` | 실행 권한 비트 |
| `procinfo_test.go` `TestLinux*` | 리눅스 `/proc`(⑤ 해소 후 재판정) |
| `foreground_probe_test.go`·`paned_test.go` 의 전경 이름 | 전경 프로세스 그룹 (FR-XPT-5 가 Windows 를 `(0,false)` 로 정했다) |
| `install_test.go` 의 헬퍼 심링크·bash/zsh 훅 | POSIX 심링크·POSIX 셸 |

**FR-WTP-31.** 한 파일에 POSIX 전용과 이식 가능한 테스트가 섞여 있으면 **전용
쪽만** 갈라낸다. 파일 전체에 태그를 달아 이식 가능한 테스트까지 Windows 에서
빼지 않는다. 가르는 수단은 둘이고, 고르는 기준이 있다.

| 상황 | 수단 |
|---|---|
| 파일 전체가 POSIX 전용 개념이다 | 파일에 `//go:build !windows` |
| 이식 가능한 파일 안의 테스트 하나·둘 | `_posix_test.go` 로 옮기거나, **능력 질의 + `t.Skip`** |
| 이식 가능한 테스트 **안의 단언 하나** | 능력 질의로 감싼다 |

**능력 질의를 쓸 때는 OS 가 아니라 능력의 이름으로 묻는다** —
`testpath.PermChecked()`, `testpath.ForegroundGroups()`. `runtime.GOOS` 분기는
`check-seams.sh` 가 금지하며(FR-XBD-3), 그 취지는 테스트에도 그대로 적용된다.

`t.Skip` 을 태그보다 나은 선택으로 보는 경우가 있다: **건너뛴 사실이 테스트
출력에 남는다.** 빌드 태그로 뺀 것은 조용히 사라져 FR-WTP-32 의 "기록" 을
사람의 성실성에 맡기게 된다. 옮기는 비용(임포트 재배치)이 사유를 적는 값어치를
넘으면 `t.Skip` 을 쓴다.

**FR-WTP-32.** 태그로 뺀 것은 **Windows 에 대응물이 있는지 확인한다.** 없으면
그 사실을 §7 에 기록한다 — 조용히 빠진 보증은 빠진 줄도 모른다.

### 3.5 묶음 L — `/proc` 경로

**FR-WTP-40.** `procinfo.go` 의 `/proc` 경로 조립은 `path.Join` 을 쓴다.
*검증:* `TestLinux*` 가 5개 대상 전부에서 통과한다 — 통과하면 FR-WTP-30 의
`procinfo_test.go` 항목은 불필요해진다.

### 3.6 비기능 (NFR)

**NFR-WTP-2.** `test (windows-latest)` 잡이 **초록**이어야 한다. 이것이 이 트랙의
완료 판정이다.

**NFR-WTP-3.** 잡 실행시간은 타임아웃(600초 ×2)이 사라지므로 크게 준다. 20분
→ 5분 이내를 기대한다. 넘으면 남은 대기 지점이 있다는 뜻이므로 조사한다.

**NFR-WTP-4.** POSIX 무회귀. darwin 의 기존 테스트 전량과
`scripts/verify-isolated.sh` 21항목이 그대로 통과한다.

### 3.7 제약 (Constraints)

**C-2.** 개발 호스트는 darwin 이다. **Windows 검증은 CI 뿐이다.** 로컬 검증 수단은
`GOOS=windows go vet ./...` 이며, 이것이 테스트 파일까지 타입검사한다.

**C-3.** `gh` 계정은 READ 권한뿐이라 run 취소·재실행이 불가능하다. CI 왕복은
비싸므로 **묶어서 밀어야 한다.**

---

## 4. 검증 (Verification)

### 4.1 요구사항 ↔ 검증 대응

| 요구 | 검증 수단 | 어디서 |
|---|---|---|
| FR-WTP-1 | `TestApply_RefusesWhileDaemonAlive` | 5개 대상 |
| FR-WTP-2 | `TestInstallAgentPlugin_PrunesStaleAssets`, `TestInstall_DoesNotPruneBinDir` | 5개 대상 |
| FR-WTP-3 | 신규 — `TestList_PathsAreOSNormalized` | 5개 대상 |
| FR-WTP-4 | `scripts/check-seams.sh` 자기 검증 | 로컬 |
| FR-WTP-10~12 | 각 패키지 기존 테스트 | CI windows |
| FR-WTP-20 | 각 패키지 기존 테스트 | CI windows |
| FR-WTP-30~32 | 빌드 태그가 붙은 파일이 Windows 빌드에서 빠진다 | `GOOS=windows go vet` |
| FR-WTP-40 | `TestLinux*` | 5개 대상 |
| NFR-WTP-2 | `test (windows-latest)` 잡 | CI |

### 4.2 회귀 게이트

```bash
scripts/check-cross.sh          # 5개 대상 build + vet
scripts/check-seams.sh          # 이음매 (FR-WTP-4 로 강화된 것)
GOOS=windows go vet ./...       # 테스트 파일까지 타입검사 — Windows 유일의 로컬 수단
go test ./internal/... ./cmd/...
scripts/verify-isolated.sh
```

---

## 5. 비목표 (Non-Goals)

- **Windows 에서 POSIX 개념을 흉내내지 않는다.** 전경 프로세스 그룹도 실행 권한
  비트도 Windows 에 없다. 대응물을 발명하지 않는다
- **테스트를 통과시키려는 프로덕션 완화는 없다** (C-1)
- `git/store`·`gitapi` 의 single-flight 테스트를 **다시 설계하지 않는다.** 그것들이
  600초를 먹은 것은 원인 ①의 파생일 뿐이며, ①이 사라지면 함께 사라진다. 사라지지
  않으면 그때 별건으로 다룬다
- 이 트랙과 무관한 간헐 실패 2건(`TestAssetVersionBumpedWithAssets`,
  `TempDir` 경합)은 다루지 않는다

---

## 6. 구현 계획 (Implementation Plan)

순서에 이유가 있다 — **결함부터 고치고, 그 다음에 노이즈를 걷는다.** 노이즈를
먼저 걷으면 결함 수정이 그 안에 섞여 이력에서 분간되지 않는다.

| 단계 | 내용 | CI |
|---|---|---|
| 1 | 묶음 P — D1·D2·D3·D4 와 회귀 테스트 | 밀지 않는다 |
| 2 | 묶음 L — `path.Join` | 밀지 않는다 |
| 3 | 묶음 S — build tag 분리 | 1~3 을 묶어 1회 |
| 4 | 묶음 T — `testpath` 도우미 신설 + 치환 | |
| 5 | 묶음 J — JSON 픽스처 | 4~5 를 묶어 1회 |
| 6 | 잔여 재판정 — 1~5 이후에도 남는 실패를 전수 재분류 | 필요한 만큼 |

**6단계가 이 계획의 핵심이다.** §2.1 의 분류는 노이즈에 가려진 상태에서 한 것
이므로, 231줄이 걷힌 뒤의 잔여는 **다시 판정해야 한다.** 그 안에 제5의 제품
결함이 있을 수 있다 — D1~D3 가 그렇게 나왔다.

---

## 7. 동작 변경 기록 (Behavior Changes)

| # | 이전 | 이후 | 이유 |
|---|---|---|---|
| 1 | Windows 에서 `daemonAlive` 가 언제나 false | 실제 생존을 본다 | D1 |
| 2 | Windows 에서 설치가 `hooks/hooks.json` 을 지웠다 | 보존한다 | D2 |
| 3 | `Entry.Path` 가 git 형태(`C:/a/b`) | OS 형태(`C:\a\b`) | D3 |

**변경 3은 API 응답에 보인다.** `/api/git/worktrees` 의 `path` 필드가 Windows 에서
백슬래시가 된다. 이 저장소의 다른 모든 경로가 OS 형태이고(`Result{Path: s.Path}`
는 Go 가 만든 값이다), 한 API 안에서 두 형태가 섞이는 것보다 낫다는 판단이다.
POSIX 에서는 아무 변화가 없다.

---

## 8. 리스크 (Risks)

**R-1 · CI 왕복이 비싸다.** Windows 실행이 유일한 검증이고 취소가 안 된다(C-3).
완화: `GOOS=windows go vet ./...` 로 타입 오류를 먼저 전부 걷고, 단계를 묶어 민다.

**R-2 · 묶음 T 가 46개 파일에 걸친다.** 기계적이지만 넓다. 기대값(FR-WTP-12)을
빠뜨리면 절반만 고쳐진다. 완화: 파일 단위로 끝내고, 남은 리터럴을 grep 으로 센다.

**R-3 · 잔여 재판정에서 결함이 더 나올 수 있다.** 이것은 리스크이자 이 트랙의
목적이다. 나오면 §2.3 에 D5 로 추가하고 계획을 늘린다.

**R-4 · D3 의 영향 범위를 다 보지 못했을 수 있다.** `Entry.Path` 소비처는 확인한
두 곳 외에 더 있을 수 있다. 완화: 정규화를 파싱 경계에 두어(FR-WTP-3) 소비처 조사
결과와 무관하게 안전하게 만든다.

---

## 9. 열린 결정 (Open Decisions)

**D-1 · 묶음 S 에서 뺀 보증을 Windows 에 어떻게 채우나.** 예컨대 헬퍼 심링크는
Windows 에서 복사로 대신하는데(`TestCopyExecutable` 이 그 경로다), 설치 전체가
Windows 에서 옳은지는 이 트랙이 답하지 않는다. FR-WTP-32 는 **기록만** 요구한다.

**D-2 · `test` 매트릭스에 windows 를 계속 둘 것인가.** 이 SRS 는 "둔다" 를 전제한다
(NFR-WTP-2). 빼는 선택지는 CROSS_PLATFORM_SRS §10.4 R-4 의 대안 ②였고, 제품 결함
4건이 이 잡에서만 나왔다는 사실이 "둔다" 의 근거다.
