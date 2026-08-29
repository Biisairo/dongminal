# 인수인계 — 크로스플랫폼 (CI 전량 초록 · 남은 일은 e2e 통일 하나)

> 근거 SRS 는 `CROSS_PLATFORM_SRS.md`. 실기 기록은 그 문서 §11 이다.
> 브랜치 `crossplatform`. 워킹 트리는 깨끗하고 모두 푸시돼 있다.

## 0. 한 줄 상태

**CI 잡 넷이 전부 초록이다** (run 33280678938, `8f4e706`). 세 트랙이 끝났다.

1. **ConPTY** — 원인은 `STARTF_USESTDHANDLES` 하나(SRS §11.8). 라이브러리 교체는
   하지 않았다; §11.7 의 그 결정은 실행 전에 뒤집혔다. 새 의존도 `go` 지시자
   변경도 없다
2. **Windows 단위테스트** — 도입 이래 한 번도 통과한 적이 없던 잡이다. 실패
   356줄을 전수로 파 내려가 **제품 결함 11건**을 꺼냈다.
   근거: `WINDOWS_TEST_PARITY_SRS.md`, 결과는 그 §10
3. **코드 감사** — 하드코딩·테스트 전용 프로덕션 코드·거짓 주석을 걷었다.
   서브에이전트 감사 5 + 수정 5. 아래 §7

**남은 일은 하나다 — e2e 통일(§3).** `main` 병합은 그 뒤가 낫다.

## 1. 지금 어디까지 왔나

`internal/shared/platform` 이 OS 이음매 18종을 인터페이스 8종 뒤로 보냈다.
`scripts/check-seams.sh` 가 그 규칙(platform 밖에 OS 의존 호출 없음)을 강제한다.

| 대상 | build·vet | 단위 테스트 | doctor | 종단간(서버→데몬→PTY) |
|---|---|---|---|---|
| darwin | ✅ | ✅ | ✅ | ✅ (`verify-isolated.sh` 21/21) |
| linux | ✅ | ✅ | ✅ | ✅ (CI) |
| windows | ✅ | ✅ (CI) | ✅ (CI) | ✅ (CI) |

CI 는 `.github/workflows/verify.yml` 이다. **잡 넷이 전부 통과한다.**

---

## 2. Windows 결함 — 원인과 해결

### 2.1 증상 (해결됨)

브라우저에 UI 는 뜨는데 터미널이 비고 입력도 안 먹었다. 셸 없는
`cmd /c echo <표시>` 를 띄워도 받은 것이 **정확히 16바이트** — ConPTY 의 인사말
`"\x1b[?9001h\x1b[?1004h"` 뿐이고 화면이 한 번도 그려지지 않았다.

pwsh 로는 제목 OSC(`\x1b]0;…pwsh.exe\a`)만 의사 콘솔로 오고, **셸의 배너와
프롬프트는 부모 콘솔(CI 단계 로그)로 샜다.**

### 2.2 원인

`CreateProcess` 에 `STARTF_USESTDHANDLES` 를 세우지 않았다.

플래그가 없으면 자식의 표준 입출력은 **부모에게서** 물려받는다. 부모에게
콘솔이 있으면 그 콘솔 핸들이 넘어간다. 자식은 의사 콘솔에 붙기는 하므로 —
그래서 conhost 가 이미지 이름을 알고 제목 OSC 를 의사 콘솔로 흘린다 — 정작
글자는 물려받은 부모 콘솔에 그린다. §2.1 의 설명되지 않던 조합이 이것이다.

**핸들 셋은 0 으로 둬야 한다.** 목적은 물려줄 것을 지정하는 것이 아니라
**물려받지 않게 하는 것**이고, 빈 자리는 의사 콘솔이 채운다. 같은 플래그를
세우면서 파이프 끝을 넣으면(`146c99a`) ConPTY 와 자식이 그 파이프를 두고
경쟁해 더 나빠진다 — `d4a9e67` 이 되돌린 것이 그것이다.

    siEx.StartupInfo.Flags |= windows.STARTF_USESTDHANDLES

### 2.3 어떻게 찾았나 — 방법이 답이었다

§11.7 은 MS 의 EchoCon 예제를 기준으로 대조했고 "남는 것이 없다" 로 끝났다.
**예제에 없고 검증된 구현에는 있는 것**을 보지 않은 것이 빈틈이었다.

교체하기로 한 라이브러리 두 개의 소스를 먼저 읽고 우리 코드와 항목별로 맞추자
차이가 한 줄로 드러났다.

| 항목 | 우리(종전) | UserExistsError/conpty | aymanbagabas/go-pty |
|---|---|---|---|
| `lpApplicationName` | nil | nil | argv0 |
| `siEx.Cb` | 112 | 112 | 112 |
| `UpdateProcThreadAttribute` 인자 | 같음 | 같음 | 같음 |
| `CreatePseudoConsole` 후 pty 끝 닫기 | 닫음 | **안 닫음** | 닫음 |
| `bInheritHandles` | true | false | false |
| **`STARTF_USESTDHANDLES`** | **없음** | **있음** | **있음** |

**교체를 결정했더라도 후보의 소스는 읽어야 한다.** 읽는 순간 교체가 필요 없어질
수 있다.

### 2.4 라이브러리 교체가 다시 필요해지면

조사만 남겨 둔다. `UserExistsError/conpty` v0.1.4 가 단일 파일 350줄이고 의존이
`x/sys` 뿐(이미 있음)이며 `go` 지시자를 올리지 않아도 된다. 래퍼가 메울 곳은
두 군데다.

- raw `ReadFile` 을 쓰므로 `ERROR_BROKEN_PIPE` → `io.EOF` 변환이 필요하다
  (`toolhub.readPTY` 가 `io.EOF` 를 본다)
- `Close()` 가 프로세스 핸들까지 닫으므로 `Wait()` 용 핸들을 `OpenProcess` 로
  따로 쥐어야 한다 (`toolhub.kill` 은 `Close` → `Wait` 순서다)

`aymanbagabas/go-pty` v0.2.3 은 공학적으로 더 낫지만(os.File I/O, os.Process.Wait,
`lookExtensions`, SYSTEMROOT 보정) `x/crypto`·`u-root` 를 끌고 오고 `go` 지시자를
1.25.0 으로 올리게 한다.

---

## 3. 남은 일 — e2e 를 한 벌로 통일한다 (사용자 지시, 미착수)

### 3.1 왜

**세 OS 가 서로 다른 것을 검사한다.** 사용자가 물어서 확인한 결과다.

| 대상 | 수단 | 어디서 | 무엇을 |
|---|---|---|---|
| macOS | `scripts/verify-isolated.sh` | **로컬에서 사람이 직접만** | 21항목 — ping·도구·**git 8종**·stats·settings·정적 자산 |
| Linux | `verify.yml` 인라인 bash | CI | doctor + 종단간 5단계 |
| Windows | `verify.yml` 인라인 PowerShell | CI | doctor + 종단간 5단계 |

문제가 넷이다.

1. **macOS 는 CI 에 없다.** darwin 검증은 사람이 기억해야만 일어난다
2. **darwin 의 21항목이 다른 두 OS 에서 한 번도 검사되지 않는다.** `git status`·
   `log`·`refs`·`signature`·`policy`·`stash`·`records`·`jobs`, `/api/stats`,
   `/api/settings`, 정적 자산 — Linux·Windows 에서 전무하다. 이번 감사에서 나온
   **원격 이름 검사·자격증명 마스킹** 같은 git 계열 변경이 Windows 에서 어떻게
   도는지 확인할 수단이 없다는 뜻이다
3. **CI 의 doctor 계층 검사는 darwin 에서 돌지 않는다** (`verify-isolated.sh` 는
   doctor 를 부르지 않는다)
4. **Linux 와 Windows 종단간이 스크립트 두 벌**(bash/PowerShell)이다. 이 저장소가
   반복해서 경계하는 "규칙을 두 벌로 두면 한쪽만 고쳐진다" 가 **검증 하네스
   자체**에 적용된 자리다. 실제로 Windows 쪽만 고친 적이 있다

### 3.2 정해진 설계 (사용자 확인 완료)

- **검사 정의를 Go 한 벌로 옮긴다.** bash/PowerShell 두 벌이 사라진다.
  `dongminal doctor` 가 이미 "서버가 쓰는 바로 그 platform 코드를 계층별로 실행"
  하는 형태로 세 OS 에서 도니 같은 방식을 따른다
- **CI 는 linux + windows 에서 그것을 돌린다.** 지금과 같은 비용
- **macOS 는 CI 에 넣지 않는다** — 사용자 결정. 개발자가 로컬에서 같은 것을 돈다.
  `verify-isolated.sh` 는 그 Go e2e 를 부르는 얇은 껍데기로 바꾸거나 대체
- **세 OS 가 같은 목록을 돈다.** 대상별로 빠지는 항목은 **능력 질의로 명시적으로
  건너뛰고 그 사실이 출력에 남게** 한다 — `testpath.PermChecked()`·
  `ForegroundGroups()`·`POSIXShell()` 과 같은 규칙 (FR-WTP-30~32)

### 3.3 착수 전에 읽을 것

- `scripts/verify-isolated.sh` — 21항목의 실체. **격리 가드**(포트 58146 이면 중단,
  홈이 격리 홈이 아니면 중단)를 반드시 옮겨라. 그 가드가 없어서 운영 인스턴스를
  죽인 사고가 실제로 있었다 (스크립트 머리말)
- `.github/workflows/verify.yml` 의 `windows-runtime`(69~127행)·`linux-runtime`
  두 인라인 블록 — 종단간 5단계의 실체
- `internal/ctl/cli/doctor.go` — 계층별 진단의 선례. 새 e2e 가 이것과 겹치는지
  갈라지는지 먼저 정하라
- **규모가 중·대다.** CLAUDE.md 규약대로 **스펙(IEEE 29148)을 먼저** 쓴다

### 3.4 그 다음

`main` 병합. e2e 통일 뒤가 낫다 — 통일된 검사가 병합 전에 세 OS 를 한 번 훑는다.

## 4. 검증

```bash
scripts/check-cross.sh     # 5개 대상 build + vet
scripts/check-seams.sh     # OS 의존 호출이 platform 밖에 없는지
go test ./internal/... ./cmd/...
scripts/verify-isolated.sh # darwin 실동작 21항목
```

**Windows 는 CI 로만 검증된다.** 푸시하면 `verify` 워크플로우가 돈다.

```bash
gh run list --repo Biisairo/dongminal --branch crossplatform --limit 1
JOB=$(gh run view <runId> --repo Biisairo/dongminal --json jobs \
      --jq '.jobs[]|select(.name=="windows-runtime")|.databaseId')
gh api "repos/Biisairo/dongminal/actions/jobs/$JOB/logs"
```

`gh` 계정은 이 저장소에 READ 권한뿐이라 **run 취소·재실행은 안 된다.** 로그
조회는 된다. 푸시는 SSH 키로 나가므로 문제없다.

`windows-runtime` 의 성공 기준은 두 단계다.

1. `doctor` — 「의사 터미널」의 **[단순 명령]** 이 먼저 통과해야 한다. 그것이
   배관의 최소 증명이다. 그 다음 [맨 셸]·[훅 얹은 셸]·[도구]·[콘솔 없는 프로세스]
2. `종단간` — 서버를 띄우고 `/api/tools` 로 도구를 만들어 `/api/tools/input` →
   `/api/tools/output` 왕복

---

## 5. 진단 도구 — `dongminal doctor`

이번 트랙에서 만든 것이고, Windows 를 파는 동안 유일하게 쓸 만한 눈이었다.
서버가 쓰는 **바로 그 platform 코드**를 계층별로 실제 실행한다.

    환경 → 헬퍼·셸 훅 설치 → 셸 선택 → 의사 터미널 → 도구(toolhub)
    → 콘솔 없는 프로세스 → 로컬 IPC → 프로세스 제어

「의사 터미널」이 세 단계인 것이 요점이다.

- **[단순 명령]** 셸 없이 `echo` 한 줄. 실패하면 배관 문제이고, 셸을 만져도 소용없다
- **[맨 셸]** 훅 없는 셸
- **[훅 얹은 셸]** 훅까지. 맨 셸이 되고 이게 안 되면 범인은 훅이다

셸을 방정식에서 빼는 이 한 걸음이 §2.1 의 16바이트를 드러냈고, 그것이 원인을
ConPTY 배관 하나로 좁혔다.

「콘솔 없는 프로세스」는 doctor 가 자기 자신을 서버와 똑같이 detach 해 띄워
(`--probe-pty <file>`) 결과를 파일로 돌려받는다.

보고서 끝에 실패 줄을 다시 모아 찍는다 — 길어서 앞부분이 잘린 채 전달되는 일이
실제로 있었다. toolhub 의 로그는 실패했을 때만 함께 나온다.

---

## 6. 커밋 이력 (브랜치 `crossplatform`)

세 트랙이다. 맨 위가 **코드 감사** 트랙(§7),

    8f4e706  refactor: 환경변수 계약을 주입측·읽는측이 한 상수로 딛게 한다
    09f9bab  refactor: 서브에이전트 감사 — 하드코딩·테스트 전용 코드·거짓 주석
    1d0b447  docs(xplat): 두 트랙을 닫는다 — CI 잡 넷이 전부 초록이다

그 아래가 **Windows 단위테스트** 트랙(WINDOWS_TEST_PARITY_SRS),

    e242765  fix(xplat): 셸이 스스로 끝나도 탭이 닫히지 않았다 (D11)
    ff7ad5e  fix(xplat): 셸 준비 신호를 '조용해질 때까지' 로 바꾼다
    6c104ea  fix(xplat): 마지막 여섯 — 줄 끝·푸시 순서·남은 리터럴
    49a3ed1  fix(xplat): URL 쿼리·가짜 git 출력에 남은 경로 리터럴을 걷는다
    0279751  fix(xplat): 고정 대기를 셸 준비 대기로 바꾼다
    6f012f0  fix(xplat): 저장 대기를 모든 ToolManager 에 붙이고 SRS 를 갱신한다
    e943ca8  fix(xplat): OS 마다 다른 전제를 마저 걷어낸다 (D9·D10 포함)
    a632ec2  fix(xplat): 남은 픽스처와 저장 경합을 잡는다
    b67a0ee  fix(xplat): 경로 가드가 이 OS 의 구분자를 모두 보게 한다 (D8)
    b95a8a5  fix(xplat): 파일 전송이 Windows 에서 통째로 막혀 있었다 (D7)
    3d98524  fix(xplat): 테스트 픽스처의 OS 전제를 걷어내고 결함 둘을 더 고친다
    d6dbf8f  fix(xplat): Windows 실동작 결함 4건 (D1~D4)

그 위가 **ConPTY** 트랙(CROSS_PLATFORM_SRS §11)이다.

    a0a8492  docs(xplat): Windows 가 통과했다 — §11.7 의 교체 결정을 접는다
    c6ac10f  fix(xplat): ConPTY 자식이 부모 콘솔을 물려받지 않게 한다 (§11.8)
    aca7004  docs(xplat): 인계 문서와 다음 세션 프롬프트를 남긴다 (§11.7)
    0915188  fix(doctor): 단순 명령 프로브가 멈추지 않게 한다
    8363a75  test(doctor): 셸을 빼고 의사 터미널의 배관부터 시험한다
    1a428d6  fix(xplat): ConPTY 자식 생성을 MS 예제와 같은 형태로 맞춘다
    d4a9e67  fix(xplat): ConPTY 자식에게 std 핸들을 물려주지 않는다
    a36417a  fix(doctor): 셸이 준비된 뒤에 입력한다
    146c99a  fix(xplat): 자식의 표준 입출력을 의사 콘솔로 못박는다 — §11.6 정정
    e8d6636  ci(xplat): Windows·Linux 실기 검증을 CI 로 굳힌다 (R-1 해소)
    8e012e8  fix(xplat): 데몬을 CREATE_NO_WINDOW 로 띄운다
    5469dbb  fix(xplat): doctor 가 도구 계층과 콘솔 없는 조건까지 본다
    419c318  fix(xplat): Windows 실기 1차 — 결함 4건과 계층별 진단
    f3de228  feat(xplat): OS 이음매를 인터페이스로 묶는다

`8733cb3 feat(transfer)` 는 사용자가 중간에 넣은 별개 커밋이다.

**`146c99a` → `d4a9e67` → `c6ac10f` 는 같은 자리를 세 번 건드렸다.** 146c99a 가
플래그를 세우며 핸들에 파이프 끝을 넣었고(악화), d4a9e67 이 그것을 통째로
되돌렸으며(플래그까지 함께 사라졌다), c6ac10f 가 플래그만 세우고 핸들은 0 으로
뒀다(해결). 이력을 읽을 때 헷갈리지 않도록 적어 둔다.

---

## 7. 코드 감사 트랙 (이 세션에서 끝냄)

사용자 지시로 서브에이전트 감사 5개(세션 diff·shared·domain·api·cli)를 돌리고,
보고를 **전부 직접 검증한 뒤** 수정 에이전트 5개로 나눠 고쳤다. 45개 파일.

### 7.1 무엇을 걷었나

**테스트를 통과시키려고 존재하던 프로덕션 코드**
`StopSaving`(내가 만든 것 — 주석이 약속한 종료 경로가 실제로 부르지 않아
프로덕션 문제가 그대로였다), `foregroundName`, `Server.Started()`,
`Server.Shutdown()`(호출자 0인데 주석이 "gracefully" 를 약속).

**실제 결함**
`migrate` 가 "대상 없음" 이라 말하며 `settings.json` 재작성 · `stopDaemon` 이
항상 true 라 실패 분기가 죽은 코드 · `IPC.Endpoint` 우회 ·
**`agentadapter.shellQuote` 가 POSIX 인용을 pwsh 에 타이핑**(아포스트로피 하나로
명령이 깨진다).

**규칙이 두 벌이던 것**
자격증명 마스킹 정규식 둘(결과도 달랐다) · 원격 이름 검사(엄격한 쪽이 push 에만)
· `jsonQ`/`jsonInner` 네 곳 · 셸 준비 대기 헬퍼 · 프로세스 제어 접근점 ·
ANSI 리셋 시퀀스 · `workspace.Manager` 복제 두 쌍.

**하드코딩** — `DONGMINAL_*`·기본 호스트·포트를 `internal/shared/dmenv`(의존 0)로.
`ctl/cli` 는 `runtimebin`·`toolhub` 를 import 하므로 역방향이 순환이고,
`shared/platform` 은 `check-seams.sh` 가 지키는 OS 이음매 전용 경계다.

**죽은 코드·거짓 주석** — `[conpty] sizeof` 디버그 로그 · 쓰지 않는 `done` 채널과
`cols`/`rows` 인자 · 미사용 `type slot` · D7 이후 도달 불가가 된 403 갈래 3곳 ·
`core/doc.go` 가 "파괴적 경로가 없다" 고 단언하는데 `ExecWrite` 를 밖에서 28곳이
부른다(보안 경계를 잘못 읽게 하는 문장).

### 7.2 동작이 바뀐 것 — 인수인계 필수

| 이전 | 이후 | 이유 |
|---|---|---|
| 기록에 `https://user:***@h` | `https://***@h` | `user` 자리가 토큰인 형태가 흔하고 구분 불가. FR-GIT-104/V43 에 더 부합. 사용자명 보존을 요구하는 조항은 없음을 확인 |
| `a/b` 같은 원격 이름이 fetch·tag 에서 통과 | 실행 전 400 거부 | 엄격한 검사가 push 에만 걸려 있었다 |
| `migrate` 가 대상 없어도 파일 재작성 | 바이트 단위 보존 | — |
| `stop` 이 못 죽여도 ✅ + rc=0 | ❌ + rc=1, pidfile 보존 | 살아 있는 데몬의 pidfile 을 지우면 고아가 된다 |

**주의**: 원격 이름 검사의 에러는 `ErrRemoteName` **과** `core.ErrRefName` 을
이중 `%w` 로 감싼다. 하나만 감싸면 `gitapi` 의 `errors.Is(err, core.ErrRefName)` 가
빗나가 **잘못된 요청이 400 이 아니라 500** 이 된다. 실증했다.

### 7.3 감사에서 나왔지만 **손대지 않은 것**

증거가 없거나 범위 밖이라 열어 둔다.

- `toolhub/tool.go` 의 이름 없는 중복 리터럴 — 120×40(2곳), 8192(3곳),
  50ms(FR-XPT-3 계약값), `"bin"`(5곳), `TERM=xterm-256color`(2곳)
- `kill()` 이 `Close`/`Terminate`/`Kill` 오류 셋을 근거 주석 없이 버린다
- 이관 뒤 낡은 주석 5건 (`tool.go:605,632,664,785`, `runtime/install.go:4-8`)
- `procinfo.go` 의 `newLinuxProcInfo` 미사용 경고
- `pty_windows.go` 의 `Close` 후 닫힌 HPCON 을 `Resize` 가 만질 수 있음
- `WINDOWS_TEST_PARITY_SRS §10.4` 의 R-5(Windows 의 경로 동일성은 문자열
  동일성이 아니다 — 대소문자·8.3 짧은 이름)와 R-6(예약 파일명)

### 7.4 사고 기록

수정 에이전트가 RED 를 확인하던 중, 주입점이 생기기 전이라 **개발 호스트의 실제
pid 4242 에 SIGTERM/SIGKILL 이 나갔다.** 지시에 "실제 프로세스를 건드리지 않을
방법을 먼저 확보하라" 가 빠진 것이 원인이다. 지금은 `procCtl` 이음매를 경유하므로
재발하지 않는다. **서브에이전트에 프로세스·파일시스템을 만지는 일을 시킬 때는
격리 수단을 먼저 지시하라.**
