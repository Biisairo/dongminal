# 인수인계 — 크로스플랫폼 (Windows 해결)

> 근거 SRS 는 `CROSS_PLATFORM_SRS.md`. 실기 기록은 그 문서 §11 이다.
> 브랜치 `crossplatform`. 워킹 트리는 깨끗하고 모두 푸시돼 있다.

## 0. 한 줄 상태

**네 대상 모두 종단간까지 CI 에서 통과한다.** Windows 결함의 원인은
`STARTF_USESTDHANDLES` 하나였고(§11.8), 라이브러리 교체는 **하지 않았다** —
§11.7 의 그 결정은 실행 전에 뒤집혔다. 새 의존도 `go` 지시자 변경도 없다.

남은 것은 `main` 병합과, 이 트랙과 무관하게 처음부터 깨져 있던
`test (windows-latest)` 잡이다.

---

## 1. 지금 어디까지 왔나

`internal/shared/platform` 이 OS 이음매 18종을 인터페이스 8종 뒤로 보냈다.
`scripts/check-seams.sh` 가 그 규칙(platform 밖에 OS 의존 호출 없음)을 강제한다.

| 대상 | build·vet | 단위 테스트 | doctor | 종단간(서버→데몬→PTY) |
|---|---|---|---|---|
| darwin | ✅ | ✅ | ✅ | ✅ (`verify-isolated.sh` 21/21) |
| linux | ✅ | ✅ | ✅ | ✅ (CI) |
| windows | ✅ | ❌ (§3.1 — 선재 결함) | ✅ (CI) | ✅ (CI) |

CI 는 `.github/workflows/verify.yml` 이다. 잡 넷 중 `windows-runtime`·
`linux-runtime`·`test (ubuntu-latest)` 가 통과하고 `test (windows-latest)` 만
실패한다.

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

## 3. 남은 일

### 3.1 `test (windows-latest)` — 이 트랙과 무관한 선재 결함

**e8d6636 로 CI 가 들어온 이래 한 번도 통과한 적이 없다** (실행 8회 전부
failure 또는 cancelled). 약 250개 테스트가 깨지고 두 패키지
(`git/store`·`gitapi`)는 600초 타임아웃까지 간다.

원인은 POSIX 를 전제한 테스트가 Windows 에서 도는 것이다 — 실행 권한 비트
(`TestCopyExecutable`), `/proc` 표를 쓰는 `TestLinux*`, 셸 래퍼 문자열,
`git` 동작 차이 등.

FR-XBD-4 는 "Windows 보증 범위는 build·vet 과 플랫폼 독립 테스트" 라고 적었다.
그 경계가 **코드에는 있는데 워크플로우에는 없다.** 방향은 둘이다 (SRS §10.4 R-4).

1. POSIX 전제 테스트에 `//go:build !windows` 를 달아 경계를 코드로 굳힌다
2. `test` 매트릭스에서 windows 를 빼고, Windows 는 `windows-runtime` 잡으로만
   보증한다

①이 FR-XBD-4 의 뜻에 맞지만 250건을 하나씩 판정해야 한다.

### 3.2 `main` 병합

Windows 가 통과했으므로 막는 것은 없다. §3.1 을 병합 전에 처리할지 후에 할지는
결정이 필요하다 — 지금 상태로 병합하면 `main` 의 CI 도 빨간 잡을 하나 안고 간다.

### 3.3 기존 결함 2건 (내 변경과 무관, HEAD 에서 재현 확인)

- `web` 의 `TestAssetVersionBumpedWithAssets` — `assets.lock` 한 줄 불일치
- `TestApiToolDelete_ClearsAttention` · `TestToolClientForegroundNameOverIPC` —
  `SaveAll` 이 테스트 종료 후 `TempDir` 에 쓰는 경합으로 간헐 실패. 후자가
  run 33257794325 의 `test (ubuntu-latest)` 를 떨어뜨렸다 (로컬 5회 반복 통과)

---

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

    c6ac10f  fix(xplat): ConPTY 자식이 부모 콘솔을 물려받지 않게 한다 (§11.8)  ← 해결
    aca7004  docs(xplat): 인계 문서와 다음 세션 프롬프트를 남긴다 (§11.7)
    0915188  fix(doctor): 단순 명령 프로브가 멈추지 않게 한다
    8363a75  test(doctor): 셸을 빼고 의사 터미널의 배관부터 시험한다
    1a428d6  fix(xplat): ConPTY 자식 생성을 MS 예제와 같은 형태로 맞춘다
    d4a9e67  fix(xplat): ConPTY 자식에게 std 핸들을 물려주지 않는다 — 파이프 경쟁이었다
    a36417a  fix(doctor): 셸이 준비된 뒤에 입력한다
    146c99a  fix(xplat): 자식의 표준 입출력을 의사 콘솔로 못박는다 — §11.6 정정
    e8d6636  ci(xplat): Windows·Linux 실기 검증을 CI 로 굳힌다 (R-1 해소)
    8e012e8  fix(xplat): 데몬을 DETACHED_PROCESS 가 아니라 CREATE_NO_WINDOW 로 띄운다
    5469dbb  fix(xplat): doctor 가 도구 계층과 콘솔 없는 조건까지 본다
    419c318  fix(xplat): Windows 실기 1차 — 결함 4건을 고치고 계층별 진단을 넣는다
    f3de228  feat(xplat): OS 이음매를 인터페이스로 묶고 Linux·WSL·Windows-native 를 연다

`8733cb3 feat(transfer)` 는 사용자가 중간에 넣은 별개 커밋이다.

**`146c99a` → `d4a9e67` → `c6ac10f` 는 같은 자리를 세 번 건드렸다.** 146c99a 가
플래그를 세우며 핸들에 파이프 끝을 넣었고(악화), d4a9e67 이 그것을 통째로
되돌렸으며(플래그까지 함께 사라졌다), c6ac10f 가 플래그만 세우고 핸들은 0 으로
뒀다(해결). 이력을 읽을 때 헷갈리지 않도록 적어 둔다.
