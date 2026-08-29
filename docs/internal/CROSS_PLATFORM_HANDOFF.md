# 인수인계 — 크로스플랫폼 (Windows ConPTY 미해결)

> 근거 SRS 는 `CROSS_PLATFORM_SRS.md`. 실기 기록은 그 문서 §11 이다.
> **모두 커밋·푸시되어 있다** (브랜치 `crossplatform`). 워킹 트리는 깨끗하다.

## 0. 한 줄 상태

Linux·WSL·darwin 은 **종단간까지 CI 에서 통과**한다. **Windows 만 남았고, 원인은
직접 구현한 ConPTY 하나로 좁혀져 있다.** 사용자 결정으로 **검증된 라이브러리로
교체**하기로 했다 — 그것이 다음 세션의 첫 작업이다.

---

## 1. 지금 어디까지 왔나

`internal/shared/platform` 이 OS 이음매 18종을 인터페이스 8종 뒤로 보냈다.
`scripts/check-seams.sh` 가 그 규칙(platform 밖에 OS 의존 호출 없음)을 강제한다.

| 대상 | build·vet | 단위 테스트 | doctor | 종단간(서버→데몬→PTY) |
|---|---|---|---|---|
| darwin | ✅ | ✅ | ✅ | ✅ (`verify-isolated.sh` 21/21) |
| linux | ✅ | ✅ | ✅ | ✅ (CI) |
| windows | ✅ | ✅ | ❌ | ❌ |

CI 는 `.github/workflows/verify.yml` 이다. `windows-runtime` 잡만 실패한다.

---

## 2. Windows 결함 — 어디까지 밝혀졌나

증상: 브라우저에 UI 는 뜨는데 **터미널이 비고 입력도 안 먹는다.**

### 2.1 배제된 것 (전부 실기 또는 원본 대조로 확인)

- Go 의 Windows AF_UNIX 지원 — 된다 (`net/unixsock_posix.go` 태그에 windows)
- Windows 훅 임베드·전개 — 정상 (`install_shellhooks_test.go` 가 고정)
- WinAPI 시그니처·상수 — x/sys v0.36.0 원본과 대조 완료.
  `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE=0x00020016` 은
  `ProcThreadAttributeValue(22,F,T,F)` 로 검산
- 구조체 크기 — CI 실측: `sizeof(StartupInfoEx)=112`, `StartupInfo=104`,
  `HPCON=8`, `attr=0x20016`, `flags=0x80400`. 전부 정상
- 도구 생성이 크기 0 을 넘김 — 아니다 (`ParseSize` 가 120×40 기본, 0 거부)
- 콘솔 유무 — **아니다.** 콘솔이 있는 CI 러너에서도 동일하게 실패한다
  (§11.6 의 진단은 틀렸다)
- 셸·프롬프트·입력 타이밍 — **아니다.** 셸이 없는 `cmd /c echo` 도 동일하게 실패

### 2.2 확정된 사실

셸 없는 단순 명령(`cmd /c echo <marker>`)을 의사 터미널에 띄웠을 때 받은 것이
**정확히 16바이트**다.

```
"\x1b[?9001h\x1b[?1004h"
```

ConPTY 의 인사말(win32 입력 모드 요청 + 포커스 이벤트 요청)뿐이고 **화면이 한
번도 그려지지 않았다.** 즉 자식의 출력이 의사 콘솔의 화면 버퍼에 닿지 않는다.

pwsh 로 띄웠을 때는 96~152바이트가 오는데, 그 내용은 초기 페인트와 **제목
OSC**(`\x1b]0;…pwsh.exe\a`)뿐이고 셸 텍스트는 0바이트다. 그런데 같은 시각
**셸의 배너와 프롬프트는 부모 콘솔(CI 단계 로그)로 샌다.**

    ✅ [맨 셸] 기동 pid=6084
    PowerShell 7.6.5
    PS D:\a\_temp\dm-doctor>   ❌ [맨 셸] 출력을 읽지 못했습니다

제목은 의사 콘솔로 오는데 텍스트는 부모 콘솔로 가는 이 조합이 설명되지 않는다.
(conhost 가 부모 콘솔을 물려받아 그쪽에 그리는 것 아니냐는 가설이 남아 있으나
검증하지 못했다.)

### 2.3 시도했고 효과 없던 것

| 시도 | 결과 |
|---|---|
| `DETACHED_PROCESS` → `CREATE_NO_WINDOW` | 무관 (되돌리지 않음 — 해로울 이유도 없다) |
| `STARTF_USESTDHANDLES` 로 자식 stdio 를 파이프 끝에 지정 | **역효과.** 그 파이프는 ConPTY 자신의 것이라 ConPTY 와 자식이 경쟁한다 — 입력은 ConPTY 가 가져가고 출력은 ConPTY 를 우회해 날것으로 샌다. 되돌렸다 |
| `bInheritHandles` false → true | 무관 |
| `lpApplicationName` 지정 → nil | 무관 |

---

## 3. 다음 세션이 할 일

### 3.1 ConPTY 를 검증된 라이브러리로 교체 (사용자 결정, D-2 번복)

**바꿀 파일은 `internal/shared/platform/pty_windows.go` 하나다.** `PTY`/`Terminal`
인터페이스가 이미 서 있어 그 밖으로는 번지지 않는다 — 추상화를 세운 값어치가
바로 여기서 나온다.

후보: `github.com/UserExistsError/conpty` (작고 ConPTY 전용), 또는
`github.com/aymanbagabas/go-pty` (POSIX·Windows 통합).

지켜야 할 계약은 `pty.go` 의 `Terminal` 인터페이스다.

    io.ReadWriteCloser
    Resize(cols, rows uint16) error
    Size() (cols, rows uint16, err error)
    ForegroundPGID() (int, bool)   // Windows 는 (0,false)
    PID() int
    Wait() error
    Terminate() error
    Kill() error

`ProcSpec`(Path·Args·Env·Dir)을 그 라이브러리의 기동 API 로 옮기면 된다. 환경은
`dedupEnv(spec.Env, envKeyFolded)` 를 반드시 통과시켜야 한다 — 그러지 않으면
`PATH` 에서 `binDir` 이 빠져 `dmctl` 이 안 잡힌다 (§11.2 ①).

**SRS 를 함께 고쳐라**: NFR-XP-2(신규 의존은 x/sys 뿐)와 §9 D-2 가 번복된다.
이유는 §11 의 실측 기록이다.

### 3.2 검증

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

`gh` 계정은 이 저장소에 READ 권한뿐이라 **run 취소는 안 된다.** 로그 조회는 된다.
푸시는 SSH 키로 나가므로 문제없다.

성공 기준은 `windows-runtime` 잡의 두 단계다.

1. `doctor` — 「의사 터미널」의 **[단순 명령]** 이 먼저 통과해야 한다. 그것이
   배관의 최소 증명이다. 그 다음 [맨 셸]·[훅 얹은 셸]·[도구]·[콘솔 없는 프로세스]
2. `종단간` — 서버를 띄우고 `/api/tools` 로 도구를 만들어 `/api/tools/input` →
   `/api/tools/output` 왕복

### 3.3 그 다음

- `main` 병합 (Windows 통과 후)
- SRS §10.4 의 "검증되지 않은 채 인도되는 것" 목록 갱신 — CI 가 덮는 만큼 줄인다
- 기존 결함 2건(내 변경과 무관, HEAD 에서 재현 확인)
  - `web` 의 `TestAssetVersionBumpedWithAssets` — `assets.lock` 한 줄 불일치
  - `TestApiToolDelete_ClearsAttention` — `SaveAll` 이 테스트 종료 후 `TempDir` 에
    쓰는 경합으로 간헐 실패

---

## 4. 진단 도구 — `dongminal doctor`

이번 트랙에서 만든 것이고, Windows 를 파는 동안 유일하게 쓸 만한 눈이었다.
서버가 쓰는 **바로 그 platform 코드**를 계층별로 실제 실행한다.

    환경 → 헬퍼·셸 훅 설치 → 셸 선택 → 의사 터미널 → 도구(toolhub)
    → 콘솔 없는 프로세스 → 로컬 IPC → 프로세스 제어

「의사 터미널」이 세 단계인 것이 요점이다.

- **[단순 명령]** 셸 없이 `echo` 한 줄. 실패하면 배관 문제이고, 셸을 만져도 소용없다
- **[맨 셸]** 훅 없는 셸
- **[훅 얹은 셸]** 훅까지. 맨 셸이 되고 이게 안 되면 범인은 훅이다

「콘솔 없는 프로세스」는 doctor 가 자기 자신을 서버와 똑같이 detach 해 띄워
(`--probe-pty <file>`) 결과를 파일로 돌려받는다.

보고서 끝에 실패 줄을 다시 모아 찍는다 — 길어서 앞부분이 잘린 채 전달되는 일이
실제로 있었다. toolhub 의 로그는 실패했을 때만 함께 나온다.

---

## 5. 커밋 이력 (브랜치 `crossplatform`)

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

**`146c99a` 와 `d4a9e67` 는 서로를 되돌린다** — 146c99a 가 std 핸들을 물려주게
했고 d4a9e67 이 그것을 취소했다. 이력을 읽을 때 헷갈리지 않도록 적어 둔다.
