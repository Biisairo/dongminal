# SRS: 훅과 알람이 세 대상에서 같게 동작한다 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료

| 항목 | 값 |
|---|---|
| 문서 | HOST_PARITY_SRS |
| 선행 | CROSS_PLATFORM_SRS · WINDOWS_TEST_PARITY_SRS · WINDOWS_TOOL_CWD_SRS · ATTENTION_FIRING_SRS · TOOL_HISTORY_ISOLATION_SRS · SKILL_INJECTION_SRS |
| 상태 | 구현 완료 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자 접수: **Windows 에서 알람이 모든 명령마다 뜨고, claude 훅이 걸리지 않는다.**

두 증상을 파 내려가 결함 9건을 꺼냈다. 그중 하나는 Windows 가 아니라 **Linux 의
것**이고 — bash 도구 셸에서 훅이 아예 로드되지 않는다 — macOS 가 zsh 기본이라
여태 드러나지 않았다.

이 문서는 그 9건을 닫는다. 관통하는 명제는 하나다: **훅과 알람의 동작은 대상
OS 에 따라 달라지지 않는다.**

### 1.2 범위 (Scope)

**포함** — §2 의 결함 9건과 그 검증.

**비포함** — §6.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **L1 신호** | PTY 출력에서 읽는 알림 이스케이프 시퀀스 (OSC 9 / 99 / 777;notify) |
| **에이전트 훅** | Claude Code 가 `--settings` 로 읽는 `claude.json` 의 hook 명령 |
| **셸 훅** | 도구 셸이 기동 시 읽는 dongminal 의 rc 스크립트 |
| **ConEmu 확장** | `OSC 9 ; <숫자> ; …` 형태의 비알림 제어 명령군 |

### 1.4 참조 (References)

- `internal/shared/toolhub/attention.go` — L1 판정
- `internal/shared/runtime/install.go` — 에이전트 훅 생성
- `internal/shared/platform/shell.go` — 셸 선택과 훅 주입
- [microsoft/terminal#8330](https://github.com/microsoft/terminal/pull/8330) — OSC 9;9 로 CWD 를 알리는 규약
- [anthropics/claude-code#59225](https://github.com/anthropics/claude-code/issues/59225) — Windows 에서 훅이 bash 로 실행된다

## 2. 현황 (Current State)

### 2.1 묶음 A — OSC 9 의 ConEmu 확장을 알림으로 읽는다 (접수 증상 1)

`attention.go` 의 `isAttentionOSC` 는 OSC 9 중 **`9;4`(progress) 하나만** 알림에서
제외한다.

```go
case "9":
    if bytes.Equal(rest, []byte("4")) || bytes.HasPrefix(rest, []byte("4;")) {
        return false
    }
    return true          // ← 9;9, 9;1, 9;5, 9;12 … 전부 알림
```

ConEmu 규약에서 OSC 9 뒤 첫 필드가 **숫자면 확장 명령**이고, 알림은 iTerm2
형식 `OSC 9;<문장>` 뿐이다. 그중 `9;9;<경로>` 는 Windows 에서 CWD 보고의 사실상
표준이라 Windows Terminal 공식 안내·oh-my-posh·starship·clink 가 **매 프롬프트마다**
내보낸다.

프롬프트가 그려질 때마다 = 명령 하나가 끝날 때마다 알람이다. 접수된 증상 그대로다.

L2(유휴)는 원인이 아니다. `maybeIdle` 은 `agentSeen` 을 요구하므로 `ls`·`dir`
만으로는 발화하지 않는다. 남는 경로는 L1 하나다.

### 2.2 묶음 B — 에이전트 훅 명령이 인용되지 않는다 (접수 증상 2)

`install.go` 가 훅 명령을 문자열 이어붙이기로 만든다.

```go
"command": dmctl + " notify " + label
// → C:\Users\foo\.dongminal\bin\dmctl.exe notify done
```

Claude Code 는 Windows 에서 훅을 **Git Bash 가 PATH 에 있으면 `bash -c`, 없으면
`cmd.exe`** 로 실행한다. 선택은 암묵적이고 오버라이드가 없다.

- bash: 무인용 백슬래시가 escape 로 소비되어 `C:Usersfoo.dongminalbindmctl.exe`
  가 된다 — command not found
- cmd: 백슬래시는 살지만 경로에 **공백**이 있으면 첫 토큰에서 잘린다

`installAgentHooks` 의 9개 이벤트와 `installAgentPluginHooks` 의 SessionStart 가
**전량 무성 실패**한다. `dmctl activity` 가 죽으므로 활동 카드·턴 판정·유휴 억제가
함께 선다.

POSIX 도 같은 결함을 갖는다 — 홈 경로에 공백이 있으면 그대로 깨진다.

### 2.3 묶음 C — bash 도구 셸에서 셸 훅이 로드되지 않는다 (Linux)

`shell.go` 는 bash 에 `BASH_ENV=<binDir>/bash-hook.sh` 를 심는다. 그런데
`BASH_ENV` 는 **비대화형 셸만** 읽고 도구 셸은 `-l` 대화형이다.

```
$ BASH_ENV=/tmp/bh.sh /bin/bash -lic 'echo MARK=$MARK'   → (없음)
$ BASH_ENV=/tmp/bh.sh /bin/bash   -c 'echo MARK=$MARK'   → MARK=hooked
```

`TOOL_HISTORY_ISOLATION_SRS` §2.7 이 이 사실을 실측으로 기록하고 범위 밖으로
미뤄 두었다. 미뤄 둔 대가는 **Linux 기본 환경(bash)에서 다음이 전부 죽는 것**이다.

- `claude` 래퍼 — `--settings`·`--plugin-dir` 주입 (접수 증상 2 의 Linux 판)
- `codex` 래퍼 — `notify` 배선
- cwd 보고 `OSC 777;Cwd`
- `open`·`xdg-open` 가로채기 (VIEWER_URL_OPEN_SRS FR-VUO-14)

macOS 는 zsh + `ZDOTDIR` 이라 정상이었고, 그래서 이 결함은 여태 보이지 않았다.

### 2.4 묶음 D — Windows 설치·조회 비용

**D-1 매 기동 80MB 복사.** `windowsPaths.LinkOrCopy` 는 symlink 를 시도하지 않고
곧바로 복사한다. 근거(개발자 모드가 아닌 계정에서 symlink 는 권한을 요구한다)는
옳다. 그러나 **하드링크는 권한을 요구하지 않는다** — 같은 볼륨이면
`CreateHardLink` 는 보통 사용자로 성공한다. 헬퍼 5개 × 16MB 를 매 `start` 마다
쓰고 있다.

**D-2 호출마다 전체 프로세스 열거.** `windowsProcInfo.HasChildren` 은 부를 때마다
`processSnapshot()` 을 뜬다. L2 sweeper 가 1초마다 도구 수만큼 부르므로 도구
20개면 초당 20회 전수 열거다. 같은 파일의 `Names` 는 **일괄 조회로** 설계되어
있는데(NFR-XP-4) 이 경로만 그 규약 밖에 있다.

### 2.5 묶음 E — Windows 에서 도구별 히스토리 격리가 무효다

`toolHistEnv` 는 `HISTFILE` 과 `DONGMINAL_HISTFILE` 을 심는다. PowerShell 은
`HISTFILE` 을 읽지 않는다 — PSReadLine 은 자기 경로
(`ConsoleHost_history.txt`)를 쓰고, 그것을 바꾸는 길은
`Set-PSReadLineOption -HistorySavePath` 뿐이다. `powershell-hook.ps1` 에 그
배선이 없다.

커밋 `498e673`(「도구마다 자기 명령 기록을 갖는다」)이 고친 증상 — 재기동 한 번에
모든 터미널의 히스토리가 합쳐지는 것 — 이 Windows 에는 그대로 남아 있다.

### 2.6 묶음 F — 데몬 모드가 BEL 설정을 무시한다

`hub.attnPaneState.allowBell` 을 설정하는 코드가 없다. zero value 로 고정이므로
`DONGMINAL_ATTENTION_BELL=1` 이 데몬 모드에서 **무성 무시**된다. 직접 모드는
`ToolManager.allowBell = attentionAllowBell()` 로 읽는다.

`attn_tracker.go` 의 머리말이 스스로 약속한 동형성(FR-ATF-12·NFR-4 — "두 모드의
판정이 갈라지지 않게 하려면 상태부터 갈라지지 않아야 한다")이 이 필드에서 깨져
있다.

### 2.7 묶음 G — 닫힌 의사 콘솔을 Resize 가 만진다

`windowsTerminal.Resize` 는 `hpc` 를 검사 없이 넘긴다. `Close`(또는 `reap`)가
`ClosePseudoConsole` 을 지난 뒤에도 브라우저의 리사이즈가 도착할 수 있다.
`CROSS_PLATFORM_HANDOFF` §7.3 이 미해결로 남겨 둔 항목이다.

### 2.8 설계 결정

- **D-1 OSC 9 는 첫 필드의 모양으로 가른다.** 확장 명령의 목록을 적어 두는 대신
  "숫자면 확장" 이라는 규약 자체를 판정에 쓴다. 목록은 늘어나고 우리는 그때마다
  뒤처진다 — `9;4` 하나만 적어 둔 것이 이번 결함이다.
- **D-2 훅 명령은 실행 파일만 인용한다.** 명령 전체를 인용하면 셸이 그것을 한
  덩어리 파일명으로 읽는다. `"<경로>" notify done` 이 bash 와 cmd 양쪽에서 같은
  뜻이 되는 유일한 모양이다.
- **D-3 bash 는 zsh 와 같은 모양으로 간다.** `--rcfile` 은 `ZDOTDIR` 의 bash
  대응물이고, 훅이 사용자 rc 를 스스로 source 하는 것도 `zdotdir/.zshrc` 가 이미
  쓰는 패턴이다. 셸마다 다른 개념을 도입하지 않는다.
- **D-4 로그인 셸을 잃는 값은 훅이 되갚는다.** `--rcfile` 은 로그인 셸과 함께
  쓸 수 없다(bash 는 로그인 셸에서 `--rcfile` 을 읽지 않는다). 그래서 훅이
  `/etc/profile` 과 사용자 profile 을 **먼저** source 한다 — 순서는 로그인 셸의
  것과 같다.

  `~/.bashrc` 를 무조건 읽지 **않는** 것도 같은 이유다. 배포판의 `.bash_profile`
  은 대개 그것을 스스로 부르므로 여기서 한 번 더 부르면 PATH 누적 같은 것이 두
  번 일어난다. 부를지는 사용자의 profile 이 정하며, profile 이 아예 없을 때만
  훅이 대신 읽는다 — 그 경우는 로그인 셸도 아무 대화형 설정을 얻지 못했다.
- **D-5 하드링크는 시도하고 물러선다.** 볼륨이 다르거나 파일시스템이 지원하지
  않으면 실패하며, 그때는 종전의 복사다. 실패가 기동을 막지 않는다.
- **D-6 스냅샷 캐시의 수명은 전경 조회와 같다.** `fgRefreshInterval`(2초)과 다른
  값을 두면 두 조회가 서로 다른 시점의 세상을 본다.
- **D-7 PSReadLine 히스토리는 훅이 되살린다.** 값은 서버가 정하고
  (`DONGMINAL_HISTFILE`) 훅은 그것을 대입만 한다 — `zdotdir/.zshrc` 의
  FR-THI-23 과 같은 규약이다. 경로 규칙이 셸 스크립트로 복제되지 않는다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — L1 판정

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-HPR-1 | `OSC 9` 의 첫 필드가 **숫자로만** 이루어져 있으면 알림이 아니다. `9;9;<경로>`·`9;4;…`·`9;1`·`9;12` 가 모두 여기 든다 | 필수 |
| FR-HPR-2 | 첫 필드가 숫자가 아니면 알림이다 — iTerm2 형식 `OSC 9;<문장>` 이 그것이다. 본문 없는 `OSC 9` 단독도 알림이다 | 필수 |
| FR-HPR-3 | `OSC 99`(kitty)·`OSC 777;notify` 의 판정은 바뀌지 않는다 | 필수 |

### 3.2 묶음 B — 에이전트 훅 명령

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-HPR-4 | 훅 명령의 실행 파일 경로는 큰따옴표로 감싼다. 인자는 감싸지 않는다 (`"<dmctl>" notify done`) | 필수 |
| FR-HPR-5 | 이 규칙은 `installAgentHooks`(9개 이벤트)와 `installAgentPluginHooks`(SessionStart)에 **같이** 적용된다 — 훅 명령을 만드는 자리는 하나여야 한다 | 필수 |
| FR-HPR-6 | 경로에 공백이 있어도, 백슬래시가 있어도 명령의 뜻이 바뀌지 않는다 | 필수 |

### 3.3 묶음 C — bash 셸 훅

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-HPR-7 | bash 도구 셸은 `--rcfile <binDir>/bash-hook.sh` 로 뜬다. `-l` 과 `BASH_ENV` 는 쓰지 않는다 | 필수 |
| FR-HPR-8 | `bash-hook.sh` 는 자기 훅을 걸기 **전에** `/etc/profile` 을, 이어서 `~/.bash_profile` \| `~/.bash_login` \| `~/.profile` 중 먼저 있는 하나를 source 한다 — 로그인 셸과 같은 순서다. `~/.bashrc` 는 **그 셋 중 아무것도 없을 때만** 읽는다 | 필수 |
| FR-HPR-9 | zsh·그 밖의 셸의 인자와 훅 주입은 바뀌지 않는다 — zsh 는 `-l` 과 `ZDOTDIR` 그대로다 | 필수 |
| FR-HPR-10 | 사용자 rc 를 읽다 실패해도 셸은 뜬다. source 실패가 훅 정의를 막지 않는다 | 필수 |

### 3.4 묶음 D — Windows 설치·조회

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-HPR-11 | `windowsPaths.LinkOrCopy` 는 하드링크를 먼저 시도하고, 실패하면 복사한다. 이미 같은 파일을 가리키는 링크면 아무것도 하지 않는다 | 필수 |
| FR-HPR-12 | `windowsProcInfo` 의 프로세스 조회는 `fgRefreshInterval` 과 같은 수명의 캐시를 지난다. 캐시가 유효한 동안 스냅샷을 다시 뜨지 않는다 | 필수 |
| FR-HPR-13 | 캐시는 동시 호출에 대해 스냅샷을 겹쳐 뜨지 않는다 (single-flight) | 필수 |

### 3.5 묶음 E — Windows 히스토리

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-HPR-14 | `powershell-hook.ps1` 은 `DONGMINAL_HISTFILE` 이 있으면 `Set-PSReadLineOption -HistorySavePath` 로 그 값을 건다 | 필수 |
| FR-HPR-15 | PSReadLine 이 없는 처지에서도 셸은 뜬다 — 실패는 조용히 지나간다 | 필수 |
| FR-HPR-16 | 히스토리 시드의 원본은 그 셸의 실제 히스토리 자리다. PowerShell 은 PSReadLine 의 기본 경로이며, 그 규칙은 Go 한 곳에 있다 (FR-THI-20) | 필수 |

### 3.6 묶음 F·G — 동형성과 수명

| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-HPR-17 | `AttnTracker` 는 직접 모드와 **같은 근거**로 BEL 허용을 정한다 (`attentionAllowBell()`) | 필수 |
| FR-HPR-18 | `windowsTerminal.Resize` 는 의사 콘솔이 닫힌 뒤에는 호출하지 않고 오류를 낸다 | 필수 |

## 4. 검증 (Verification)

| ID | 검증 | 요구 |
|---|---|---|
| V-HPR-1 | `9;9;C:\x`·`9;4;1;50`·`9;1`·`9;12` 가 알림이 아니고, `9;빌드 끝`·`9`·`99`·`777;notify` 가 알림이다 (단위) | FR-HPR-1·2·3 |
| V-HPR-2 | 공백과 백슬래시가 든 홈에서 만든 훅 명령이 실행 파일 경로를 한 덩어리로 유지한다 (단위). 그리고 공백이 든 홈의 명령이 `sh`·`bash`·`zsh` 셋 모두에서 인자까지 온전히 실행된다 (POSIX 통합) | FR-HPR-4·6 |
| V-HPR-3 | 플러그인 SessionStart 훅도 같은 인용을 지난다 (단위) | FR-HPR-5 |
| V-HPR-4 | bash 는 `--rcfile <bin>/bash-hook.sh` 로 뜨고 `BASH_ENV` 를 심지 않는다. zsh 는 `-l`·`ZDOTDIR` 그대로다 (단위) | FR-HPR-7·9 |
| V-HPR-5 | `bash-hook.sh` 가 `/etc/profile` → profile 후보 → `.bashrc` 폴백 순으로 적혀 있고, 그 뒤에 `claude`·`_rt_cwd_hook`·`open` 을 정의한다 (골든) | FR-HPR-8 |
| V-HPR-6 | 실기 bash 로 `--rcfile` 을 지나면 `claude` 함수가 정의되어 있다 (POSIX 통합) | FR-HPR-7·8 |
| V-HPR-7 | 하드링크가 되는 처지에서 복사가 일어나지 않는다 (단위, Windows) | FR-HPR-11 |
| V-HPR-8 | 캐시 수명 안의 두 번째 조회가 스냅샷을 다시 뜨지 않는다 (단위) | FR-HPR-12·13 |
| V-HPR-9 | 훅 스크립트에 `HistorySavePath` 배선이 있고 `DONGMINAL_HISTFILE` 을 딛는다 (골든) | FR-HPR-14 |
| V-HPR-10 | `NewAttnTracker` 가 만든 상태의 BEL 허용이 `AttentionAllowBell()` 과 같다 (단위) | FR-HPR-17 |
| V-HPR-13 | 시드 원본이 PowerShell 에서는 PSReadLine 의 자리이고, zsh·bash 에서는 종전의 점파일이다. `APPDATA` 가 없으면 빈 값이다 (단위) | FR-HPR-16 |
| V-HPR-11 | 닫힌 터미널의 `Resize` 가 오류를 내고 API 를 부르지 않는다 (단위, Windows) | FR-HPR-18 |
| V-HPR-12 | `go test ./internal/... ./cmd/...` 가 세 대상에서 초록이다 | 전부 |

## 5. 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-HPR-1 | L1 판정에 새 할당이 생기지 않는다 — 첫 필드 검사는 이미 잘라 둔 슬라이스를 본다 |
| NFR-HPR-2 | 셸 훅의 profile source 는 기동에 한 번이다. 도구 기동 시간이 사용자 rc 를 읽는 비용을 넘어 늘지 않는다 |
| NFR-HPR-3 | 어떤 변경도 셸 기동을 실패시키지 않는다. 모든 실패는 종전 동작으로 열화한다 |
| NFR-HPR-4 | Windows 전용 코드는 `platform` 안에 남는다 — `check-seams.sh` 가 그대로 통과한다 |

## 6. 비목표 (Non-goals)

- **Claude Code 의 훅 셸 선택을 바꾸는 것.** 우리가 정할 수 있는 것은 명령의
  모양뿐이다.
- **cmd.exe 폴백에 훅을 다는 것.** cmd 에는 프롬프트마다 도는 자리가 없다
  (CROSS_PLATFORM_SRS FR-XSH-3). 성능 저하이지 오류가 아니다.
- **Windows 에서 프로세스 cwd 직접 조회.** WINDOWS_TOOL_CWD_SRS 의 판단 그대로다.
- **fish 등 세 번째 셸의 훅.** 지금 없고 이 문서로 생기지 않는다.
- **PSReadLine 히스토리의 시드 형식 변환.** zsh·bash 와 형식이 다르지만 각자의
  파일을 각자가 읽으므로 변환할 일이 없다.

## 7. 위험 (Risks)

| # | 위험 | 판단 |
|---|---|---|
| R-1 | `--rcfile` 로 바꾸면 로그인 셸이 아니게 되어 PATH 가 달라질 수 있다 | FR-HPR-8 이 profile 을 로그인 셸과 같은 순서로 읽어 되갚는다. 사용자가 profile 안에서 `$0` 의 `-` 접두나 `shopt -q login_shell` 을 보는 경우는 갈릴 수 있으나, 그것을 지키는 값보다 훅이 아예 안 걸리는 값이 크다 |
| R-2 | 첫 필드가 숫자인 iTerm2 알림(`OSC 9;42`)이 이제 무시된다 | 그런 알림은 규약상 ConEmu 확장과 구별할 방법이 없다. 숫자만으로 된 알림 문구는 실재하지 않는다 |
| R-3 | 훅 명령의 인용이 제3의 셸(예: PowerShell 로 훅을 도는 미래 판본)에서 다르게 읽힐 수 있다 | 큰따옴표는 bash·cmd·PowerShell 세 곳에서 모두 경로를 한 덩어리로 만든다 |
| R-4 | 하드링크는 원본이 갱신되면 링크도 함께 바뀐다 — symlink 와 같은 성질이며 의도한 것이다 | `dongminal` 실행 파일이 교체되면 헬퍼도 새것을 가리켜야 옳다. 교체가 rename 으로 일어나면 하드링크는 옛 실체를 가리키므로, 그때는 재설치가 다시 건다 (매 기동 설치) |
| R-5 | 프로세스 스냅샷 캐시가 2초 뒤처진 답을 준다 | `IsBusy` 는 이미 1초 tick 의 판정 재료이고 전경 조회는 같은 수명으로 산다. 2초 안의 정확도를 요구하는 호출자는 없다 |
