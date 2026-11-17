# SRS: dongminal 탭의 claude 에 CLAUDE.md 주입 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

dongminal 탭에서 실행한 claude 에 dongminal 이 정한 CLAUDE.md 를 하나 더 읽힌다.
이 CLAUDE.md 는 claude 가 쓸 수 있는 `dmctl` 명령을 설명하고, 그 명령을 적극적으로
쓰도록 이끈다.

지금의 주입 경로(SessionStart 훅의 `additionalContext`, SKILL_INJECTION_SRS 묶음 D)는
**수신측에 필요한 최소**(FR-CTX-3)만 담는다. 명령 활용 지침은 그 범위를 넘는다. 그래서
이 지침은 CLAUDE.md(메모리) 경로로 따로 넣는다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| A | 임베드 트리 `agentmemory/` 에 `CLAUDE.md` 를 두고 `bin/agent-memory/` 로 설치한다. 설치·거울 유지는 플러그인 자산 관리와 같은 방식이다 |
| B | claude shim 이 그 파일을 추가 폴더 메모리로 읽게 한다 (`--add-dir=` + 환경 변수) |
| C | CLAUDE.md 본문: claude 가 쓸 수 있는 `dmctl` 명령과 활용 지침 |

**미포함:** §5 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **agent-plugin** | `$DONGMINAL_HOME/bin/agent-plugin/`. SKILL_INJECTION_SRS §1.3 과 같다 |
| **agent-memory** | `$DONGMINAL_HOME/bin/agent-memory/`. 주입 메모리 하나만 든 폴더 |
| **주입 메모리** | `agent-memory/CLAUDE.md`. dongminal 탭의 claude 가 사용자 CLAUDE.md 에 더해 읽는 메모리 파일 |
| **추가 폴더 메모리** | Claude Code 가 `--add-dir` 로 받은 폴더의 CLAUDE.md 를 메모리로 읽는 동작. 환경 변수 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 일 때만 켜진다 |
| **훅 전용 명령** | Claude Code 나 셸 훅이 부르는 `dmctl` 명령. `notify`·`activity`·`agent-context`·`ctx-hook`·`statusline`·`subagent-statusline` |

### 1.4 참고 (References)

- `docs/internal/SKILL_INJECTION_SRS.md` — `--plugin-dir` 주입, FR-CTX-3
- `docs/internal/CLAUDE_ACCOUNTS_SRS.md` — claude shim (FR-CAC-83)
- `docs/external/commands.md` — `dmctl` 명령 레퍼런스

## 2. 실측 (2026-11-17, Claude Code CLI)

| # | 실험 | 결과 |
|---|---|---|
| 2.1 | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 claude -p --add-dir=<d> "<질문>"` (`<d>/CLAUDE.md` 에 암호 단어) | 암호 단어를 답한다. 메모리로 읽힌다 |
| 2.2 | 2.1 에서 환경 변수만 뺀다 | `NONE`. 읽히지 않는다 |
| 2.3 | `claude -p --add-dir <d> "<질문>"` (공백 구분) | 질문이 `--add-dir` 의 값으로 먹힌다. `--add-dir` 는 값을 여러 개 받는다 |
| 2.4 | `--add-dir=<d>` (한 토큰) 뒤에 질문 | 질문이 질문으로 읽힌다 |

2.3 때문에 shim 은 반드시 한 토큰 형식(`--add-dir=<경로>`)을 쓴다. shim 인자는 사용자
인자 **앞**에 붙으므로, 공백 구분을 쓰면 사용자의 질문이나 인자를 먹는다.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항

| ID | 요구사항 |
|---|---|
| FR-AMI-1 | 임베드 트리 `internal/shared/runtime/agentmemory/` 는 `CLAUDE.md` 를 담는다. `runtime.Install` 은 이것을 `agent-memory/CLAUDE.md` 로 전개한다. 설치 트리는 임베드 트리의 거울이다 |
| FR-AMI-2 | claude shim 은 `agent-memory/CLAUDE.md` 가 일반 파일이면 `--add-dir=<agent-memory 경로>` 를 **한 토큰으로** 붙인다. 자리는 다른 shim 인자 뒤, 사용자 인자 앞이다 |
| FR-AMI-3 | FR-AMI-2 의 인자를 붙일 때, shim 은 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 가 없거나 빈 값이면 `1` 로 둔다. 사용자가 비지 않은 값을 두었으면 그 값을 그대로 둔다 |
| FR-AMI-4 | `agent-memory/CLAUDE.md` 가 없으면 shim 은 `--add-dir=` 도, 환경 변수도 더하지 않는다 |
| FR-AMI-5 | 사용자의 `~/.claude/CLAUDE.md` 와 그 밖의 사용자 설정 파일을 고치지 않는다. 주입은 shim 이 띄운 실행 한 번에만 적용된다 |
| FR-AMI-6 | 주입 메모리 본문에 적힌 `dmctl <명령>` 은 모두 `dmctl --help` 에 있는 명령이어야 한다. 훅 전용 명령은 적지 않는다 |
| FR-AMI-7 | 주입 메모리 본문은 아래를 담는다. (a) 명령별 쓰임과 쓸 상황 (b) 사용자에게 묻거나 출력을 붙여 달라고 하기 전에 `dmctl` 로 직접 할 수 있는지 먼저 따지라는 지침 (c) 안전 규칙: 사용자가 쓰는 탭에 `send-input` 하거나 닫지 않는다, 에이전트에게는 `send-input` 이 아니라 `msg` 를 쓴다 |
| FR-AMI-9 | `--add-dir=` 로 여는 폴더에는 주입 메모리 외의 파일을 두지 않는다. 특히 플러그인 폴더(훅·명령이 있는 곳)를 열지 않는다. 열린 폴더는 claude 의 작업 폴더가 되어 편집 권한 규칙이 그대로 적용되므로, 다음 세션에서 실행될 훅을 고칠 길이 생긴다 (2026-11-17 보안 검토) |
| FR-AMI-8 | 주입 메모리 본문은 엔벨로프 신뢰 규약을 다시 적지 않는다. 그것은 SessionStart 훅의 몫이다(FR-CTX-3) |

### 3.2 비기능 요구사항

| ID | 요구사항 |
|---|---|
| NFR-AMI-1 | 주입 메모리는 모든 dongminal claude 세션의 맥락에 들어간다. 본문은 8KB 이하로 유지한다 |

## 4. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-AMI-1 | FR-AMI-1·9 | `Install` 뒤 `agent-memory/` 에 `CLAUDE.md` 하나만 있고, 플러그인 폴더에는 없다 (`TestInstallAgentMemory_OnlyClaudeMD`) |
| TC-AMI-2 | FR-AMI-2·3 | shim 의 argv 가 `[real, --add-dir=<agent-memory>, 사용자 인자]` 이고, 환경 변수가 `1` 이다 |
| TC-AMI-3 | FR-AMI-3 | 사용자가 환경 변수를 `0` 으로 두면 shim 이 바꾸지 않는다 |
| TC-AMI-4 | FR-AMI-4 | CLAUDE.md 가 없으면 `--add-dir=` 와 환경 변수가 없다 |
| TC-AMI-5 | FR-AMI-6·8, NFR-AMI-1 | 본문의 `dmctl <명령>` 이 모두 도움말에 있고, 훅 전용 명령과 엔벨로프 머리표가 없으며, 8KB 이하다 |
| TC-AMI-6 | FR-AMI-2·3 실동작 | 수동: dongminal 탭에서 `claude` 를 띄우고 `/memory` 에 주입 메모리가 보이는지 확인한다 |

## 5. 비목표 (Non-goals)

- omp 등 claude 가 아닌 에이전트에 주입하지 않는다.
- 사용자가 주입 메모리 내용을 고치는 기능은 두지 않는다. 설치 때마다 임베드 내용으로 되돌아간다.
- SessionStart 훅의 본문(`agentContextText`)은 바꾸지 않는다.

## 6. 알려진 부작용

- `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 은 사용자가 같은 실행에 직접 준 `--add-dir` 폴더에도 적용된다. 그 폴더에 CLAUDE.md 가 있으면 함께 읽힌다.
- `--add-dir` 는 그 폴더의 파일 접근 권한도 준다. 대상은 CLAUDE.md 하나만 든 `agent-memory` 폴더뿐이다(FR-AMI-9). claude 가 이 파일을 고쳐도 다음 설치 때 임베드 내용으로 되돌아간다.
