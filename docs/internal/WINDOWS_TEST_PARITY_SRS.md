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

### 2.4 원인 ⑤ — `/proc` 은 언제나 POSIX 경로다

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
쪽만** `_posix_test.go` 로 분리한다. 파일 전체에 태그를 달아 이식 가능한 테스트
까지 Windows 에서 빼지 않는다.

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
