# 인수인계 — 크로스플랫폼 (완료 · CI 전량 초록)

> 근거 SRS 는 `CROSS_PLATFORM_SRS.md`. 실기 기록은 그 문서 §11 이다.
> 브랜치 `crossplatform`. 워킹 트리는 깨끗하고 모두 푸시돼 있다.

## 0. 한 줄 상태

**CI 잡 넷이 전부 초록이다** (run 33263400171). 남은 것은 `main` 병합뿐이다.

두 트랙이 끝났다.

1. **ConPTY** — 원인은 `STARTF_USESTDHANDLES` 하나였다(SRS §11.8). 라이브러리
   교체는 **하지 않았다**; §11.7 의 그 결정은 실행 전에 뒤집혔다. 새 의존도
   `go` 지시자 변경도 없다
2. **Windows 단위테스트** — 도입 이래 한 번도 통과한 적이 없던 잡이다. 실패
   356줄을 전수로 파 내려가 **제품 결함 11건**을 꺼냈다. 근거는
   `WINDOWS_TEST_PARITY_SRS.md` 이며 결과는 그 §10 이다

---

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

## 3. 남은 일 — `main` 병합뿐

CI 넷이 초록이므로 막는 것은 없다.

이 트랙이 두 번째로 한 일(Windows 단위테스트)은 별도 스펙에 있다 —
`WINDOWS_TEST_PARITY_SRS.md`. 요약은 그 §10 이고, **제품 결함 11건**이 거기서
나왔다. 사용자가 실제로 겪을 것은 셋이다.

- **D7** — 파일 전송(업로드·다운로드)이 Windows 에서 전부 403 이었다
- **D11** — `exit` 를 친 탭이 닫히지 않고 영원히 남았다
- **D1** — 데몬이 도는 중에 마이그레이션이 진행돼 상태를 덮어썼다

열어 둔 위험은 그 스펙 §10.4 의 R-5(Windows 의 경로 동일성은 문자열 동일성이
아니다 — 대소문자·8.3 짧은 이름)와 R-6(예약 파일명)이다. **증거가 나올 때까지
손대지 않는다.**

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

두 트랙이다. 아래가 **Windows 단위테스트** 트랙(WINDOWS_TEST_PARITY_SRS),

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
