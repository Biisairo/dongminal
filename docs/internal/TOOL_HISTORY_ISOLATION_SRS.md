# SRS: 도구별 셸 히스토리 — 재기동이 히스토리를 섞지 않는다 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

서버를 내렸다 올리면 모든 터미널의 셸 명령 히스토리(↑ 로 부르는 것)가 하나로
합쳐지는 결함을 없앤다. 원인은 모든 도구 셸이 **한 개의 히스토리 파일**을
공유한다는 것이며, 해결은 도구마다 자기 파일을 갖게 하는 것이다.

도구 ID 는 재기동을 넘어 유지되므로(`tools.json`), 도구별 파일은 부수적으로
**"이 터미널이 지난번에 무엇을 했는가"** 를 되살린다 — 지금은 재기동 후 모든
터미널이 남의 명령을 섞어 보여 준다.

### 1.2 범위 (Scope)

- `internal/shared/toolhub/tool.go` — `StartTool` 의 환경 구성.
- `internal/shared/dmenv/dmenv.go` — 새 환경변수 이름 상수.
- `internal/shared/runtime/shellhooks/posix/zdotdir/.zshrc` — HISTFILE 되살리기.
- 신규 단위 테스트, `dongminal verify` 항목.

비포함:
- Windows(PowerShell·PSReadLine) 히스토리.
- `bash-hook.sh` 가 대화형 로그인 셸에서 로드되지 않는 별개 결함(§2.7). 사실만
  기록하고 고치지 않는다.
- 히스토리 파일의 회수·만료 정책(§6).
- 샌드박스 컨테이너 안의 셸(§6).

### 1.3 정의 (Definitions)

- **히스토리**: 셸의 명령 이력. zsh 는 `HISTFILE`, bash 는 `HISTFILE` 이 가리키는
  파일에 저장한다. 터미널 화면의 스크롤백과는 다른 것이다.
- **시드(seed)**: 도구가 처음 생길 때 사용자 히스토리를 그 도구의 파일로 한 번
  복사하는 것. 이후 두 파일은 갈라진다.
- **도구 홈**: 도구 셸이 `HOME` 으로 여기는 자리. 보통 사용자 홈이고, 격리
  기동에서는 인스턴스 홈 아래의 `tool-home` 이다 (`dmenv.EnvToolHome`).

### 1.4 참조 (References)

- `docs/internal/architecture.md` — 훅 설치와 `ZDOTDIR`/`BASH_ENV` 배선.
- `docs/internal/CROSS_PLATFORM_SRS.md` §FR-XSH-6 — 셸 분기의 자리.
- `internal/shared/dmenv/dmenv.go` — `EnvToolID`·`EnvHome`·`EnvToolHome` 의 계약과
  `EnvToolHome` 이 이미 "검사 명령이 사용자 히스토리에 남는다"를 고친 전례.

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 모든 도구 셸이 한 파일을 쓴다

`shellhooks/posix/zdotdir/.zshrc:1`

```sh
export HISTFILE="$HOME/.zsh_history"
```

### 2.2 이 한 줄이 없으면 더 나쁘다 — 그러나 자리가 틀렸다

macOS `/etc/zshrc:16` 은 `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` 다. 도구 셸에는
`ZDOTDIR=<binDir>/zdotdir` 가 심기므로(`platform/shell.go:70`), 위 한 줄이 없으면
모든 도구가 `<binDir>/zdotdir/.zsh_history` 를 공유한다. 즉 이 줄은 그것을 사용자
홈으로 되돌리는 교정이다.

다만 자리가 **사용자 `.zshrc` 를 source 하기 전**이다(같은 파일 4행). 사용자가
자기 rc 에서 `HISTFILE` 을 설정하면 그쪽이 이긴다.

### 2.3 도구 셸은 로그인 셸이고, 종료할 때 히스토리를 쓴다

`platform/shell.go:100` — `Args: []string{"-l"}`, 주석: *"로그인 셸로 띄운다 —
사용자의 PATH·rc 가 종전대로 적용된다."*
`toolhub/tool.go:736-741` — 종료는 `Terminate()`(SIGTERM) → 50ms → `Kill()`.
셸이 히스토리를 쓸 시간이 있다.

### 2.4 zsh 는 종료 시 append 하고 시작 시 전체를 읽는다 (실측)

macOS `/etc/zshrc` 가 `HISTSIZE=2000`·`SAVEHIST=1000` 을 주고, zsh 의
`APPEND_HISTORY` 는 기본 on 이다. 격리 HOME 으로 두 세션을 따로 돌린 실측:

```
$ zsh -i -c 'print -s "cmd_from_A"'
$ zsh -i -c 'print -s "cmd_from_B"'
$ cat $HOME/.zsh_history
cmd_from_A
cmd_from_B
```

두 세션이 같은 파일에 각자 붙였다. 그러므로 서버를 내리면 모든 셸이 자기 명령을
그 파일에 붙이고, 올리면 복원된 모든 셸이 그 통합 파일을 통째로 읽는다.
`share_history`/`inc_append_history` 가 아니라 **종료 시 append + 시작 시 전체
로드**가 원인이므로, 평상시에는 섞이지 않고 재기동 때만 섞인다 — 사용자의 관찰과
일치한다.

### 2.5 재기동은 같은 ID 로 도구를 되살린다

`toolhub/persist.go` `SaveAll`/`LoadAll` 이 `ToolState{ID,Name,Cwd}` 를 저장하고,
`manager.go:436 Restore(s.ID, ...)` 가 **같은 ID** 로 셸을 다시 띄운다. 도구별
히스토리 파일을 ID 로 이름 지으면 재기동을 넘어 자기 것으로 돌아온다.

### 2.6 도구 ID 는 이미 셸 환경에 있다

`toolhub/tool.go:271` — `dmenv.EnvToolID + "=" + id` (`DONGMINAL_TOOL_ID`).

### 2.7 bash 훅은 도구 셸에서 로드되지 않는다 (실측 — **해소됨**)

> 이 결함은 `HOST_PARITY_SRS` 묶음 C 가 닫았다. bash 는 이제 `--rcfile` 로 뜨고,
> 훅이 로그인 셸이 읽던 profile 을 스스로 읽는다 (FR-HPR-7·8). 아래는 당시의
> 기록이다.


`platform/shell.go:71` 은 bash 에 `BASH_ENV=<binDir>/bash-hook.sh` 를 심는다.
그런데 `BASH_ENV` 는 **비대화형** 셸만 읽는다. 도구 셸은 `-l` 대화형이다.

```
$ BASH_ENV=/tmp/bh_test.sh /bin/bash -lic 'echo MARK=$MARK'   → (없음)
$ BASH_ENV=/tmp/bh_test.sh /bin/bash  -c 'echo MARK=$MARK'   → MARK=hooked
   GNU bash, version 3.2.57(1)-release (arm64-apple-darwin25)
```

따라서 **bash 도구에서는 히스토리를 rc 파일로 고칠 수 없다.** cwd 훅·`claude`
함수·`open` 훅이 bash 에서 걸리지 않는다는 뜻이기도 하나, 그것은 이 문서의
범위가 아니다(§6).

### 2.8 macOS 세션별 히스토리는 의도적으로 꺼져 있다

`platform/shell.go:110` — `SHELL_SESSIONS_DISABLE=1`. 주석의 근거: 상속된
`TERM_SESSION_ID` 를 모든 도구가 물려받아 같은 `.session` 파일을 지우려 들면서
`rm` 오류가 났다. 판단 자체는 옳다. 다만 그 기능이 하던 **세션별 히스토리 분리**도
함께 사라졌고, 그 자리를 메우는 것이 이 문서다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 도구별 히스토리 파일

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-THI-1 | 도구 셸의 `HISTFILE` 은 도구마다 달라야 한다. 두 도구가 같은 파일을 쓰지 않는다 | 필수 |
| FR-THI-2 | 경로는 `$DONGMINAL_HOME/tool-history/<toolID>.<shell>` 이다. `<shell>` 은 `zsh`·`bash` 등 셸 이름이며, 히스토리 형식이 셸마다 다르므로 이름에 담는다 | 필수 |
| FR-THI-3 | 같은 ID 로 복원된 도구는 같은 파일을 다시 쓴다. 재기동 후 그 터미널은 **자기** 히스토리만 본다 | 필수 |
| FR-THI-4 | 디렉터리는 `0700`, 파일은 `0600` 으로 만든다 | 필수 |
| FR-THI-5 | 도구 ID 가 비어 있거나 `$DONGMINAL_HOME` 을 알 수 없으면 아무것도 주입하지 않는다(종전 동작으로 열화) | 필수 |

### 3.2 묶음 B — 시드

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-THI-10 | 도구의 히스토리 파일이 **없을 때만** 사용자 히스토리를 복사한다. 이미 있으면 어떤 경우에도 덮지 않는다 | 필수 |
| FR-THI-11 | 시드 원본은 도구 홈 기준이다 — zsh 는 `<toolHome>/.zsh_history`, bash 는 `<toolHome>/.bash_history`. 격리 기동에서는 그 자리에 파일이 없으므로 복사가 저절로 일어나지 않는다 | 필수 |
| FR-THI-12 | 원본이 없거나 읽지 못하면 빈 히스토리로 시작하고 셸은 정상 기동한다. 오류를 사용자 화면에 내지 않으며 로그만 남긴다 | 필수 |
| FR-THI-13 | 복사는 새 도구가 생길 때 한 번뿐이다. 이후 사용자 히스토리와 도구 히스토리는 갈라지며, 어느 쪽도 상대를 다시 따라가지 않는다 | 필수 |

### 3.3 묶음 C — 셸에 전달하기

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-THI-20 | 경로 결정과 시드는 **Go 한 곳**(`StartTool`)에서 한다. 셸 스크립트는 값을 만들지 않는다 | 필수 |
| FR-THI-21 | `StartTool` 은 `HISTFILE=<경로>` 와 `DONGMINAL_HISTFILE=<경로>` 를 함께 심는다. 앞의 것은 셸이 직접 쓰는 값이고, 뒤의 것은 rc 가 덮인 뒤 되살릴 때 쓰는 원본이다 | 필수 |
| FR-THI-22 | 새 환경변수 이름은 `dmenv` 상수로 둔다 (`EnvHistFile`). 이름을 두 벌로 적지 않는다 | 필수 |
| FR-THI-23 | `zdotdir/.zshrc` 는 사용자 `.zshrc` 를 source 한 **뒤에** `export HISTFILE="${DONGMINAL_HISTFILE:-$HISTFILE}"` 로 되살린다. `/etc/zshrc` 와 사용자 rc 가 모두 지나간 자리여야 한다 | 필수 |
| FR-THI-24 | bash 는 프로세스 환경 상속에만 의존한다. `bash-hook.sh` 는 이 목적으로 수정하지 않는다 — §2.7 에 따라 로드되지 않기 때문이다 | 필수 |
| FR-THI-25 | `HISTSIZE`·`SAVEHIST`·`APPEND_HISTORY` 등 다른 히스토리 설정은 건드리지 않는다. 사용자의 설정이 그대로 적용된다 | 필수 |

### 3.4 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-THI-1 | 히스토리 파일에는 사용자의 명령이 담긴다. 권한은 사용자 전용이어야 한다(FR-THI-4) |
| NFR-THI-2 | 도구 생성 경로에 추가되는 I/O 는 `stat` 1회 + (첫 생성에 한해) 복사 1회를 넘지 않는다 |
| NFR-THI-3 | 이 변경으로 도구 셸의 기동이 실패하는 경우가 있어서는 안 된다. 모든 실패는 종전 동작으로 열화한다 |

## 4. 설계 결정 (Design Decisions)

- **D-1. 경로 결정과 시드를 Go 에 둔다.** 셸 rc 에서 하면 셸마다 두 벌이 되고,
  bash 는 rc 가 아예 로드되지 않아(§2.7) 한쪽이 조용히 빠진다. Go 한 곳이면 셸이
  늘어도 파일명 규칙만 는다.
- **D-2. 그래도 zsh 는 rc 에서 되살려야 한다.** `/etc/zshrc` 가 `HISTFILE` 을
  무조건 덮으므로(§2.2) 환경 주입만으로는 zsh 에서 무효다. 그래서 값은 Go 가
  정하고 rc 는 **되살리기만** 한다 — 값이 두 곳에 적히지 않는다.
- **D-3. 되살리는 자리는 사용자 rc 이후다.** 지금처럼 앞에 두면 사용자 rc 가
  이길 수 있다. 뒤에 두면 도구 히스토리 격리가 사용자 설정보다 우선하는데, 이는
  의도한 것이다 — 격리가 깨지면 이 작업 전체가 무의미해진다.
- **D-4. 파일 자리는 `$DONGMINAL_HOME/tool-history/` 다.** `tools.json` 과 같은
  인스턴스 자산이고, 격리 기동은 `$DONGMINAL_HOME` 자체가 격리 홈이라 별도 분기
  없이 함께 격리된다. 사용자 홈에 새 디렉터리를 만들지 않는다.
- **D-5. 시드 원본을 도구 홈 기준으로 잡는다.** `EnvToolHome` 이 설정된 격리
  기동에서는 그 자리에 히스토리가 없으므로 복사가 자연히 일어나지 않는다. "격리면
  시드하지 않는다"는 조건문을 따로 두지 않아도 되고, 규칙이 하나로 남는다.
- **D-6. 이미 있는 파일은 덮지 않는다.** 시드는 "첫 도구 생성"의 일이고, 덮기는
  사용자가 그 터미널에서 쌓은 것을 지우는 일이다. 두 번째 기회는 없어야 한다.
- **D-7. `SHELL_SESSIONS_DISABLE` 은 유지한다.** 그것을 되돌리는 대안(§2.8)은
  macOS 전용이고 Apple 스크립트의 동작에 의존한다. 이식 가능한 우리 규칙으로
  같은 효과를 얻는 편이 낫다.
- **D-8. bash 훅 미로드는 이 작업에서 고치지 않는다.** 고치려면 셸 기동 방식을
  `--rcfile` 로 바꾸고 hook 이 사용자 프로필을 source 해야 한다(zsh 의 zdotdir 와
  대칭). 그것은 bash 도구의 cwd 훅·함수 주입까지 되살리는 **별개의 동작 변경**
  이며, 히스토리와 함께 묶으면 회귀 범위가 뒤섞인다.

## 5. 검증 (Verification)

### 5.1 단위 (Go)

| TC | 내용 |
|----|------|
| TC-THI-1 | 도구 둘의 `HISTFILE` 이 서로 다르고 규칙(`<home>/tool-history/<id>.<shell>`)에 맞는다 |
| TC-THI-2 | 같은 ID 로 다시 시작하면 같은 경로가 나온다 |
| TC-THI-3 | 원본이 있고 대상이 없으면 내용이 복사된다 |
| TC-THI-4 | 대상이 이미 있으면 내용이 그대로다(덮지 않는다) |
| TC-THI-5 | 원본이 없으면 대상이 없거나 비어 있고, 오류 없이 진행한다 |
| TC-THI-6 | `EnvToolHome` 이 설정된 격리 기동에서 사용자 홈의 히스토리가 복사되지 않는다 |
| TC-THI-7 | 도구 ID 가 비면 `HISTFILE` 을 주입하지 않는다 |
| TC-THI-8 | 디렉터리를 만들 수 없으면 주입하지 않고 셸은 정상 기동한다 |
| TC-THI-9 | 파일 권한 0600, 디렉터리 0700 |
| TC-THI-10 | `HISTSIZE`·`SAVEHIST` 를 주입하지 않는다 |

### 5.2 통합 — 실제 셸로

| TC | 내용 |
|----|------|
| TC-THI-20 | 도구 두 개를 만들어 각각 다른 명령을 주입하고 종료시킨 뒤, 두 히스토리 파일이 서로의 명령을 담지 않는다 |
| TC-THI-21 | 서버 재기동 후 각 도구의 셸에서 `fc -l` 이 자기 명령만 보인다 |
| TC-THI-22 | 사용자 홈의 `.zsh_history` 가 도구 사용으로 변하지 않는다 |
| TC-THI-23 | zsh 에서 사용자 `.zshrc` 가 `HISTFILE` 을 설정해도 도구 히스토리가 이긴다 (FR-THI-23) |

### 5.3 수동

새 탭을 열고 ↑ 를 누른다 — 시드 덕분에 기존 명령이 보인다. 그 탭에서 명령을
하나 실행하고 서버를 `--all` 로 내렸다 올린 뒤 같은 탭에서 ↑ 를 누른다 — 그
명령이 보이고, 다른 탭에서 실행한 명령은 보이지 않는다.

## 6. 비목표 (Non-goals)

- **회수·만료.** 삭제된 도구의 히스토리 파일은 남는다. `SAVEHIST=1000` 기준
  파일 하나가 수십 KB 이므로 즉각적인 문제가 아니다. 필요해지면 "기동 시
  `tools.json` 미참조 + mtime 30일 초과분 정리"를 별도 작업으로 한다.
- **Windows**(PSReadLine 히스토리)와 **샌드박스 컨테이너 안의 셸**. 후자는 환경이
  컨테이너 명세로 전달되는지가 먼저 확인되어야 한다(`toolhub/tool.go` 의 `place`
  경로는 env 를 docker 명령 자신이 쓰는 값으로 다룬다).
- **bash 훅 미로드(§2.7)의 수리.** 사실만 기록한다.
- 사용자 히스토리와 도구 히스토리의 양방향 동기화.
- `fish` 등 그 밖의 셸.

## 7. 리스크 (Risks)

| ID | 리스크 | 등급 | 완화 |
|----|--------|------|------|
| R-THI-1 | 사용자 rc 가 `HISTFILE` 을 설정하는 bash 환경에서는 격리가 무효다 (bash 는 rc 이후에 되살릴 자리가 없다) | MEDIUM | 알려진 한계로 문서화. 근본 해결은 D-8 의 별도 작업 |
| R-THI-2 | 시드 복사가 큰 히스토리(수 MB)를 도구마다 복제해 디스크를 먹는다 | LOW | `SAVEHIST` 가 파일을 제한한다. 필요하면 복사 상한(예: 뒤에서 N줄)을 두는 것을 후속으로 |
| R-THI-3 | 기존 사용자에게는 **첫 실행에서 모든 도구가 같은 시드를 받는다** — 그 시점의 통합 히스토리가 각 도구의 출발점이 된다 | LOW | 의도된 동작이다. 그 이후로는 갈라진다. 릴리스 노트에 적는다 |
| R-THI-4 | `$DONGMINAL_HOME` 이 네트워크 볼륨이면 히스토리 쓰기가 느려질 수 있다 | LOW | 종전에도 `tools.json` 이 같은 자리에 있었다 |
| R-THI-5 | zdotdir 의 되살리기 줄이 사용자 rc 의 `setopt` 뒤에 놓이면서 순서 의존이 생긴다 | LOW | 되살리기는 변수 대입뿐이며 옵션을 건드리지 않는다(FR-THI-25) |
