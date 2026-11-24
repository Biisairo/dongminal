# SRS: otterminal 탭의 claude 에 CLAUDE.md 주입 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

otterminal 탭에서 실행한 claude 에 otterminal 이 정한 CLAUDE.md 를 하나 더 읽힌다.
이 CLAUDE.md 는 claude 가 쓸 수 있는 `otterctl` 명령을 설명하고, 그 명령을 적극적으로
쓰도록 이끈다.

지금의 주입 경로(SessionStart 훅의 `additionalContext`, SKILL_INJECTION_SRS 묶음 D)는
**수신측에 필요한 최소**(FR-CTX-3)만 담는다. 명령 활용 지침은 그 범위를 넘는다. 그래서
이 지침은 CLAUDE.md(메모리) 경로로 따로 넣는다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 |
|---|---|
| A | 임베드 트리 `agentmemory/` 에 `CLAUDE.md` 를 두고 `bin/agent-memory/` 로 설치한다. 설치·거울 유지는 플러그인 자산 관리와 같은 방식이다 |
| B | claude shim 이 그 파일의 내용을 시스템 프롬프트 끝에 붙인다 (`--append-system-prompt=`) |
| C | CLAUDE.md 본문: claude 가 쓸 수 있는 `otterctl` 명령과 활용 지침 |

**미포함:** §5 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **agent-plugin** | `$OTTERMINAL_HOME/bin/agent-plugin/`. SKILL_INJECTION_SRS §1.3 과 같다 |
| **agent-memory** | `$OTTERMINAL_HOME/bin/agent-memory/`. 주입 메모리 하나만 든 폴더 |
| **주입 메모리** | `agent-memory/CLAUDE.md`. otterminal 탭의 claude 가 사용자 CLAUDE.md 에 더해 읽는 메모리 파일 |
| **추가 폴더 메모리** | Claude Code 가 `--add-dir` 로 받은 폴더의 CLAUDE.md 를 메모리로 읽는 동작. 환경 변수 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 일 때만 켜진다. D-AMI-1 로 쓰지 않는다 |
| **훅 전용 명령** | Claude Code 나 셸 훅이 부르는 `otterctl` 명령. `notify`·`activity`·`agent-context`·`ctx-hook`·`statusline`·`subagent-statusline` |

### 1.4 참고 (References)

- `docs/internal/SKILL_INJECTION_SRS.md` — `--plugin-dir` 주입, FR-CTX-3
- `docs/internal/CLAUDE_ACCOUNTS_SRS.md` — claude shim (FR-CAC-83)
- `docs/external/commands.md` — `otterctl` 명령 레퍼런스

## 2. 실측 (2026-11-17, Claude Code CLI)

| # | 실험 | 결과 |
|---|---|---|
| 2.1 | `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 claude -p --add-dir=<d> "<질문>"` (`<d>/CLAUDE.md` 에 암호 단어) | 암호 단어를 답한다. 메모리로 읽힌다 |
| 2.2 | 2.1 에서 환경 변수만 뺀다 | `NONE`. 읽히지 않는다 |
| 2.3 | `claude -p --add-dir <d> "<질문>"` (공백 구분) | 질문이 `--add-dir` 의 값으로 먹힌다. `--add-dir` 는 값을 여러 개 받는다 |
| 2.4 | `--add-dir=<d>` (한 토큰) 뒤에 질문 | 질문이 질문으로 읽힌다 |

| 2.5 | `claude -p --append-system-prompt=<암호 단어를 답하라는 지시> "<질문>"` (2026-11-17, 2.1.326) | 암호 단어를 답한다. 뒤의 질문은 질문으로 읽힌다 |
| 2.6 | otterminal 탭에서 `--add-dir=<agent-memory>` 로 띄운 대화형 claude | "Adding a new directory … Is this a directory you created or one you trust?" 확인창이 뜬다 (사용자 보고) |

2.3 때문에 shim 은 반드시 한 토큰 형식을 쓴다. shim 인자는 사용자
인자 **앞**에 붙으므로, 공백 구분을 쓰면 사용자의 질문이나 인자를 먹는다.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항

| ID | 요구사항 |
|---|---|
| FR-AMI-1 | 임베드 트리 `internal/shared/runtime/agentmemory/` 는 `CLAUDE.md` 를 담는다. `runtime.Install` 은 이것을 `agent-memory/CLAUDE.md` 로 전개한다. 설치 트리는 임베드 트리의 거울이다 |
| FR-AMI-2 | claude shim 은 `agent-memory/CLAUDE.md` 가 일반 파일이면 그 내용을 읽어 `--append-system-prompt=<내용>` 을 **한 토큰으로** 붙인다. 자리는 다른 shim 인자 뒤, 사용자 인자 앞이다. `--add-dir` 는 붙이지 않는다 (D-AMI-1) |
| FR-AMI-3 | shim 은 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 를 더하거나 바꾸지 않는다 |
| FR-AMI-4 | `agent-memory/CLAUDE.md` 가 없거나, 읽지 못하거나, 비어 있으면 shim 은 `--append-system-prompt=` 를 더하지 않고 claude 를 그대로 띄운다 |
| FR-AMI-5 | 사용자의 `~/.claude/CLAUDE.md` 와 그 밖의 사용자 설정 파일을 고치지 않는다. 주입은 shim 이 띄운 실행 한 번에만 적용된다 |
| FR-AMI-6 | 주입 메모리 본문에 적힌 `otterctl <명령>` 은 모두 `otterctl --help` 에 있는 명령이어야 한다. 훅 전용 명령은 적지 않는다 |
| FR-AMI-7 | 주입 메모리 본문은 아래를 담는다. (a) 명령별 쓰임과 쓸 상황 (b) 사용자에게 묻거나 출력을 붙여 달라고 하기 전에 `otterctl` 로 직접 할 수 있는지 먼저 따지라는 지침 (c) 안전 규칙: 사용자가 쓰는 탭에 `send-input` 하거나 닫지 않는다, 에이전트에게는 `send-input` 이 아니라 `msg` 를 쓴다 |
| FR-AMI-9 | shim 은 주입 메모리 때문에 claude 에게 폴더 접근 권한을 주지 않는다. `agent-memory/` 에는 주입 메모리 외의 파일을 두지 않는다 (2026-11-17 보안 검토) |
| FR-AMI-8 | 주입 메모리 본문은 엔벨로프 신뢰 규약을 다시 적지 않는다. 그것은 SessionStart 훅의 몫이다(FR-CTX-3) |

### 3.2 비기능 요구사항

| ID | 요구사항 |
|---|---|
| NFR-AMI-1 | 주입 메모리는 모든 otterminal claude 세션의 맥락에 들어간다. 본문은 8KB 이하로 유지한다 |

## 4. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-AMI-1 | FR-AMI-1·9 | `Install` 뒤 `agent-memory/` 에 `CLAUDE.md` 하나만 있고, 플러그인 폴더에는 없다 (`TestInstallAgentMemory_OnlyClaudeMD`) |
| TC-AMI-2 | FR-AMI-2·3·9 | shim 의 argv 가 `[real, --append-system-prompt=<CLAUDE.md 내용>, 사용자 인자]` 이고, `--add-dir` 가 없고, 환경 변수를 더하지 않는다 |
| TC-AMI-3 | FR-AMI-3 | 사용자가 환경 변수를 `0` 으로 두면 shim 이 바꾸지 않는다 |
| TC-AMI-4 | FR-AMI-4 | CLAUDE.md 가 없거나 비어 있으면 `--append-system-prompt=` 가 없다 |
| TC-AMI-5 | FR-AMI-6·8, NFR-AMI-1 | 본문의 `otterctl <명령>` 이 모두 도움말에 있고, 훅 전용 명령과 엔벨로프 머리표가 없으며, 8KB 이하다 |
| TC-AMI-6 | FR-AMI-2 실동작 | 수동: otterminal 탭에서 `claude` 를 띄워 신뢰 확인창이 뜨지 않는지, "otterctl 로 무엇을 할 수 있느냐"는 질문에 주입 메모리 내용으로 답하는지 확인한다 (`/memory` 에는 보이지 않는다) |

## 5. 비목표 (Non-goals)

- omp 등 claude 가 아닌 에이전트에 주입하지 않는다.
- 사용자가 주입 메모리 내용을 고치는 기능은 두지 않는다. 설치 때마다 임베드 내용으로 되돌아간다.
- SessionStart 훅의 본문(`agentContextText`)은 바꾸지 않는다.

## 6. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-AMI-1 | 추가 폴더 메모리(`--add-dir=` + 환경 변수) 대신 `--append-system-prompt=` 로 넣는다 | 사용자 결정 (2026-11-17). `--add-dir` 는 처음 보는 폴더마다 신뢰 확인창을 띄우고(2.6), 폴더 접근 권한까지 준다. 시스템 프롬프트는 확인창이 없고 권한을 늘리지 않는다 |

### 6.1 동작 변경

| 항목 | 이전 | 새 동작 | 이유 |
|---|---|---|---|
| 주입 경로 | `--add-dir=<agent-memory>` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | `--append-system-prompt=<CLAUDE.md 내용>` | D-AMI-1 |
| 신뢰 확인창 | 대화형 claude 를 띄울 때마다 뜬다 | 뜨지 않는다 | D-AMI-1 |
| `/memory` 목록 | 주입 메모리가 보인다 | 보이지 않는다 | 메모리가 아니라 시스템 프롬프트로 들어간다 |
| 폴더 접근 권한 | `agent-memory/` 를 읽고 쓸 수 있다 | 주지 않는다 | D-AMI-1 |
| 본문 (2026-11-19) | `msg` 는 보내는 법과 답장 규칙만 적었다 | `msg` 를 보내기 전(상태별 판단)·본문 쓰는 법·보낸 뒤(`wait` 종료 코드별 대응)·받았을 때·새 에이전트에게 맡기는 순서로 적는다. `status` 상태값의 뜻, `context=` 줄, `close-tab --background`, `rename-tab --auto`, `--at` 생략 시 포커스 칸에 열린다는 점을 더한다 | 에이전트가 메시지를 주고받다 막히는 자리(상대 상태 판단, 시간 초과를 실패로 읽음)를 본문이 답하게 한다. FR-AMI-6·8, NFR-AMI-1(8KB) 안이다 |

## 7. 알려진 부작용

- Claude Code 는 대화의 첫 요청에서 시스템 프롬프트를 기록하고, 이어 하기(`--resume`·`--continue`)에서는 그 기록을 그대로 보낸다. 주입 메모리를 고친 판으로 올려도 이어 하는 옛 대화에는 옛 내용이 남는다.
- 본문이 프로세스 인자로 넘어가므로 같은 사용자의 `ps` 에 보인다. 본문은 공개 문서(명령 안내)이고 비밀을 담지 않는다.
