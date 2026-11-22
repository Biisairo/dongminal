# 조사 노트: orca / paseo 실제 구현 (트랙 4 · 1단계)

`RUN_ORCHESTRATION_SRS` 의 입력이다. **README 가 아니라 소스를 읽은 결과**이며, 각
항목에 파일 경로를 붙였다. 결론만 필요하면 §7 을 보라.

조사 시점 2026-08-25. 대상 리비전: orca `stablyai/orca` v1.4.178-rc.2 (shallow),
paseo `getpaseo/paseo` v0.5.2 (shallow). 클론 위치는 세션 스크래치패드이며 저장소에
포함하지 않는다.

## 0. 라이선스 — 문서의 전제가 절반만 맞았다

| 대상 | 라이선스 | 이번 트랙에서 허용되는 것 |
|---|---|---|
| orca | **MIT** (`LICENSE`, Copyright 2026 Lovecast Inc.) | 구현 패턴 참고·차용 가능 |
| paseo | **AGPL-3.0-or-later** (`package.json`, `LICENSE`) | **코드 차용 금지.** 인터페이스·상태기계 관찰만 |

`ENTITY_MODEL_HANDOFF.md` §4.3 과 `ENTITY_MODEL_RESTRUCTURE_SRS` §7 은 "MIT 라이선스
공개 소스"라고 적었는데, 그 서술은 **orca 에만** 해당한다. paseo 에서 가져오는 것은
"이런 계약이 존재한다"는 사실뿐이며, 코드·주석·구조를 옮기지 않는다.

dongminal 저장소에는 `LICENSE` 파일이 없다. orca 코드를 실제로 차용한다면 MIT 고지
의무가 생기므로, 차용 대신 **설계 아이디어만** 가져오고 코드는 새로 쓴다.

---

## 1. orca — worktree 팬아웃

### 1.1 생성 (`src/main/git/worktree.ts` `addWorktree`, 릴레이 대응 `src/relay/git-handler-worktree-ops.ts`)

```
git worktree add --no-track -b <branch> <path> [<base>]
```

- **`--no-track` 이 핵심이다.** base 의 upstream 을 물려받으면 push 전에 `git status`
  가 "behind by N" 을 오보한다. 대신 생성 직후 `push.autoSetupRemote=true` 를 걸어
  첫 `git push` 가 upstream 을 만들게 한다. 이 설정은 `--local` 이라도 공용
  common-dir 에 쓰이며(worktree 공유), 실패해도 롤백하지 않는 best-effort 다
- 생성 base 를 `branch.<name>.base` 로 **repo config 에 영속**한다. 나중에 "이 브랜치는
  무엇에서 갈라져 나왔나"를 물을 유일한 근거다
- 브랜치명·base 가 `-` 로 시작하면 거부한다 (git 플래그로 오인되는 인자 주입)
- 타임아웃 기본 180초, 상한 30분 (`WORKTREE_ADD_TIMEOUT_MS`) — 큰 저장소의 체크아웃이
  분 단위라는 전제

### 1.2 이름 (`src/shared/worktree-name-suggestion.ts`)

해양생물 이름을 무작위로 고르고, **은퇴한 이름을 절대 재사용하지 않는다.** 주석이 밝힌
이유가 dongminal 에 그대로 유효하다:

> A name whose workspace was deleted still owns its old directory path in any agent CLI
> that keys conversation state by cwd, so reissuing it hands the next occupant someone
> else's history.

Claude Code 가 **cwd 로 세션 이력을 키잉**하므로, 경로를 재사용하면 새 팀원이 남의
대화 이력을 물려받는다. 이름 풀이 소진되면 `name-2`, `name-3` 으로 티어를 내린다.

### 1.3 제거와 실패 잔여물 (`worktree.ts` `removeWorktree`, `src/main/worktree-removal-safety.ts`)

- **지연 삭제**: 먼저 형제 trash 디렉터리로 `rename` 하고 git 등록만 해제한 뒤, 수 GB
  재귀 삭제는 반환 후에 스케줄한다. rename 후 등록 해제가 실패하면 **되돌려 놓고**
  인플레이스 삭제 경로로 폴백한다
- 등록 해제가 안 되면 `git worktree prune` → `listWorktreesStrict` 로 **정말 사라졌는지
  재확인**한다. 조회 실패를 "사라졌다"의 증거로 쓰지 않는다
- 브랜치 삭제는 `-d`(머지된 것만). **실패한 생성의 롤백일 때만** `forceBranchDelete`
  로 `-D` 를 쓴다 — 사용자 작업이 없다는 것이 확실한 경우로 한정
- 위험 경로 가드: 저장소 자신·파일시스템 루트·경로 이탈(`..`)을 거부
- worktree 메타에 **`orcaCreationSource`(desktop|runtime|cli|ssh)·`orcaCreatedAt`**
  provenance 를 남긴다 → 정리 대상은 "내가 만든 것"으로 한정된다

### 1.4 잠금

`git-worktree-operation-lock.ts` 로 동시 worktree 조작을 직렬화한다. worktree add/remove
는 공용 common-dir 를 건드리므로 병렬 팬아웃에서 반드시 필요하다.

---

## 2. orca — fan-out → 비교 → 병합

**자동 비교·병합은 존재하지 않는다.** 이것이 이번 조사에서 가장 중요한 정정이다.

- 메시지 타입에 `merge_ready` 가 있지만 코디네이터의 `processMessages`
  (`src/main/runtime/orchestration/coordinator.ts:192`)에서 `case 'merge_ready': break`
  — **아무 동작도 하지 않는다.** 순수 알림 타입이다
- 저장소 전체에 N개 결과를 diff/테스트로 비교하는 기능이 없다. 병합은 git·GitHub PR
  경로이고 **판단은 사람이** 한다
- 조정자(coordinator)는 런타임 스케줄러가 아니라 **에이전트**다. `coordinator-start` ·
  `run` 은 "retired scheduler commands" 로 **무동작**이 되었고, 조정은 조정자 에이전트가
  CLI 를 호출해 수행한다 (`skill-guides/orchestration.md`). `coordinator.ts` 는 그
  은퇴한 구현이 남아 있는 것이다

> **함의**: dongminal 이 "fan-out→비교→병합"을 자동화 대상으로 잡으면 참조 대상보다
> 앞서가는 것이다. 넣더라도 SRS 범위 밖의 별건이며, 이번 트랙은 **팬아웃과 격리, 실행
> 기록**까지가 모방 범위다.

---

## 3. orca — diff 인라인 주석 리뷰의 왕복 형태

`src/shared/diff-comments-format.ts` 전문이 계약이다.

```
File: <path>
Line: <n>            (또는 "Lines: a-b" / "Scope: file")
User comment: "<이스케이프된 본문>"
```

- **구조화 페이로드가 아니라 결정적 평문**이다. 주석에 이렇게 적혀 있다 —
  *"the pasted format is the contract between review notes and whichever agent consumes
  them. Keep it deterministic and quote-safe across clients."*
- 백슬래시·큰따옴표·CR·LF 를 이스케이프해 한 줄로 만든다 (셸·TUI 안전)
- 전달 경로는 **실행 중인 에이전트 터미널에 bracketed paste**
  (`src/renderer/src/lib/active-agent-note-send.ts` → `BRACKETED_PASTE_BEGIN/END` +
  `POST_PASTE_SUBMIT_DELAY_MS`). dongminal 의 `SendPaste`(bracketed paste + 120ms submit
  지연)와 **같은 메커니즘**이다
- 여러 주석은 빈 줄 하나로 이어 붙인다

> **함의**: dongminal 은 `dmctl send-input` / `dmctl msg` 로 이미 같은 일을 할 수 있다.
> 필요한 것은 전송 수단이 아니라 **포맷 계약**뿐이다.

---

## 4. orca — 에이전트 레지스트리

### 4.1 선언 (`src/shared/tui-agent-config.ts`, 36종 `src/shared/tui-agent.ts`)

`TuiAgentConfig` 필드 전부:

| 필드 | 뜻 |
|---|---|
| `detectCmd` / `detectCmdAliases` / `detectRequiredCommands` | PATH 탐지. `claude-agent-teams` 는 `orca` 를 탐지하되 `claude` 도 있어야 성립 |
| `detectUnsupportedRuntimes` | `win32`·`wsl` 등에서는 이 런치 모드를 감춘다 |
| `launchCmd` / `launchCmdByPlatform` | 기동 커맨드 |
| `expectedProcess` | 실제로 떠야 하는 프로세스명 (탐지·검증) |
| `promptInjectionMode` | **6종**: `argv` · `flag-prompt` · `flag-prompt-interactive` · `flag-interactive` · `hermes-query` · `stdin-after-start` |
| `argvPromptSeparator: '--'` | 프롬프트가 `help`·`-…` 로 시작할 때 서브커맨드로 오인되는 것 차단 |
| `draftPromptFlag` | 제출 없이 입력만 채우는 네이티브 플래그 (Claude `--prefill`) |
| `draftPromptEnvVar` | 그런 플래그가 없는 에이전트용 (pi → `ORCA_PI_PREFILL`) |
| `preflightTrust: cursor\|copilot\|codex` | 첫 실행 "이 폴더를 신뢰?" 메뉴가 **붙여넣기를 삼키는** 문제를 막으려 신뢰 아티팩트를 미리 써둔다 |
| `draftPasteReadySignal` | 컴포저 준비 신호 4종 (`codex-composer-prompt`, `render-cursor-after-bracketed-paste` 등) |
| `draftPasteReadyTimeoutMs` | 위 신호의 하드 데드라인 |
| `windowsShiftEnterEncoding` / `windowsInputRecordPasteNewline` / `ctrlEnterEncoding` | 키 인코딩 차이 |

**교훈**: 붙여넣기 경합이 이 레지스트리 필드의 절반을 차지한다 — 기동 직후 붙여넣기는
컴포저가 뜨기 전이면 유실되고, 신뢰 메뉴가 떠 있으면 메뉴가 먹는다. dongminal 의
"Barrier 전 Kickoff 금지"(team 스킬 절대 원칙 3)는 같은 문제의 다른 해법이다.

### 4.2 정책(훅) 주입은 데이터가 아니라 코드다

`src/main/agent-hooks/managed-agent-hook-registry.ts` 는 14개 에이전트를
`['claude', () => claudeHookService.install()]` 식 **서비스 테이블**로 묶는다. 각
벤더의 설정 형식이 달라 순수 선언으로 표현하지 못하고, `install`/`remove`/`getStatus`/
`refreshManagedScripts` 4개 연산의 균일한 인터페이스만 공유한다.

또한 orca 는 훅을 사용자의 **영구 설정**(`~/.claude/settings.json`)에 쓴다. 그 대가로
설치 잠금(`managed-hook-install-lock.ts`)·소유자 신원(`managed-hook-owner-identity.ts`)·
드리프트 검출 같은 기계가 필요하다. **dongminal 의 세션 스코프 주입(`--plugin-dir`,
`--settings`)은 이 기계 전체를 회피한다** — SKILL_INJECTION_SRS §1.1 의 판단이 이번
조사로 뒷받침됐다.

### 4.3 활동·상태의 원천은 화면이 아니라 훅이다

`src/shared/agent-hook-listener.ts`(4864행)가 에이전트 훅이 POST 하는 이벤트를 받아
벤더별로 정규화한다. dongminal 의 `dmctl activity` + `/api/tools/activity/set` 와 같은
구조다 (`internal/runtimebin/dmctl_activity.go`).

---

## 5. orca — 준비완료(`tui-idle`) 판정 사다리

`src/main/runtime/orca-runtime.ts` `waitForTerminal`. 위에서부터 강한 근거다.

1. **훅/OSC 타이틀이 보고한 에이전트 상태** `lastAgentStatus === 'idle'`
2. 타이틀의 명시적 idle — `/(^|\s)(ready|idle|done)(\s|$|[.!?])/i` + 에이전트별 idle
   접두 문자 (Claude `✳`, Gemini `◇`, Pi `π - `)
3. **알려진 준비 프롬프트 화면 스크래핑** — Codex 는 `openai codex` 헤더 + `model:` +
   `directory:`, Cursor 는 `cursor agent` + `→` 이고 **브라이유 스피너가 없을 때만**
4. **전경 프로세스 폴백** — 전경 프로세스가 셸이 아니고(`isShellProcess`) 출력이
   `TUI_IDLE_QUIESCENCE_MS=3000` 동안 조용하면 idle 로 본다. 폴링 간격 2초
5. 전체 상한 `TUI_IDLE_DEFAULT_TIMEOUT_MS = 5분`

그리고 **blocked 는 idle 이 아니다.** `findTerminalWaitBlockedSignal` 이 "업데이트
있음 / 작업 디렉터리 선택 / 훅 검토 / 신뢰 확인" 같은 시작 모달을 탐지해 `blocked`
사유와 함께 반환한다. 준비 프롬프트와 blocked 신호가 **둘 다** 보이면 **나중에 나온
쪽이 이긴다**(문자열 인덱스 비교) — 모달이 이미 닫혔음을 증명하는 방식이다.

> **dongminal 대비**: 현재 team 스킬의 Barrier 는 위 사다리에서 **3단계만** 쓴다
> (`╭─` + `Thinking...` 부재 + `[대기]`). 그런데 dongminal 은 이미 1단계 재료를 갖고
> 있다 — `dmctl activity` 가 보고하는 `working/waiting/done/idle/ended` 가 서버의
> `AttnTracker` 에 있다. 다만 **`dmctl` 에 그것을 읽는 서브커맨드가 없다**
> (`GET /api/tools/activity` 는 서버에 있고 브라우저만 소비한다). 이 결손이 스킬을
> 화면 스크래핑으로 내몬다.
>
> 또한 Claude Code 훅의 `Notification` → `waiting` 이 orca 의 blocked 에 해당한다 —
> 권한 확인 대기를 준비완료로 오인하지 않을 재료도 이미 있다.

---

## 6. orca — Run / Task / Dispatch 런타임

### 6.1 스킬 계약 (`skill-guides/orchestration.md`, 408행)

- **Run** = 이름공간 + 조정자 인박스. **스케줄하지 않는다**
- **Task** = 작업 항목. 상태 `pending|ready|dispatched|completed|failed|blocked`, DAG(`--deps`)
- **Dispatch** = Task 한 번의 시도를 한 터미널에 배정. **생명주기 권한은 Dispatch 에** 있고
  터미널 핸들은 라우팅 메타데이터일 뿐이다
- 메시지 타입: `status` `dispatch` `worker_done` `merge_ready` `escalation` `handoff`
  `question` `decision_gate` `heartbeat`
- 조정자 루프는 폴링이 아니라 **`check --wait --types worker_done,escalation,question
  --timeout-ms <n>`** 의 롤링 대기. 타임아웃은 실패가 아니라 체크포인트다 (코딩 작업은
  15~60분이 일상)
- 완료 후 정리 3택: 같은 터미널을 다음 Dispatch 로 **이양** / `worker-retain`(사용자가
  살려두라 요청) / `worker-release`(정리). 애매하면 남긴다
- **"핸드오프"와 "감독"을 문법으로 가른다** — "hand off/handover/다른 에이전트에게"는
  기본이 **소유권 이전**이고, 감독은 사용자가 "supervise/monitor/wait" 를 명시할 때만.
  핸드오프에는 task-create·inject·wait 를 **금지**한다

### 6.2 영속 (`src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts`)

SQLite. 배울 지점만:

- `deliveries` — run 당 **outstanding 을 1개로 강제하는 부분 유니크 인덱스**. 조정자는
  같은 배치를 `--ack` 전까지 반복 수신한다 (at-least-once + 멱등 처리)
- `mutation_receipts(caller_fingerprint, request_id)` — 변경 연산의 멱등 영수증
- `worker_dispatches.state` — `starting|ready|start_unknown|failed|succeeded|stopping|
  stop_unknown|stopped|abandoned`. **`*_unknown` 이 1급 상태**다. "모르겠다"를 실패로
  접지 않는다
- `residual_resources` — 정리하지 못하고 남긴 자원을 **기록**한다
- `worker_terminal_resources.ownership_state` — `owned|transferred|user_owned|external|
  released`. 사용자가 가져간 터미널은 회수하지 않는다
- `runtime_epoch` — 런타임 재기동 경계. 이전 세대의 행을 펜싱한다

### 6.3 권한 (`lifecycle-reconciliation.ts`)

`worker_done` 을 받아들이는 근거는 **발신자가 그 Dispatch 의 assignee pane 인지**다.
주석이 못박는다 — *"payload knowledge alone is not authority."* 거절 사유가 타입으로
열거된다: `sender_not_assignee` · `stale_dispatch` · `task_dispatch_mismatch` ·
`inactive_dispatch` 등.

### 6.4 워커 프리앰블 (`src/main/runtime/orchestration/preamble.ts`)

**평문 프롬프트**다. 구조화 페이로드가 아니라, CLI 예제에 taskId/dispatchId 를 박아
넣은 텍스트를 터미널에 붙여넣는다. 규칙이 산문 블록이 아니라 **각 예제 바로 위 주석**에
있는데, 그 이유를 주석이 밝힌다 — *"LLM readers anchor on examples and skim trailing
prose, so rules must land at the point of use."*

담긴 규칙:

- `worker_done` **정확히 한 번**, `--outcome succeeded|failed` 명시. 실패를 산문에만
  담지 말 것. body 는 3문장 요약 (조정자가 먼저 읽는 것)
- taskId 와 dispatchId **둘 다** 실을 것 — 실패한 이전 시도의 늦은 완료가 현재 시도를
  완료시키지 못하게
- **`AskUserQuestion` 금지** — 조정자가 볼 수 없는 로컬 TUI 프롬프트를 열어 세션이
  영원히 멈춘다. 질문은 `ask` 로
- 5분마다 heartbeat (조정자의 정체 판정 임계 10분). `check --wait`·`ask` 안에 있는
  동안은 그 자체가 생존 신호이므로 생략
- `worker_done` 이후: **turn 을 끝내고 유휴 프롬프트로 돌아가라. 폴링 루프 금지,
  터미널을 스스로 닫지 말라.** 단 **사용자의 직접 지시는 언제나 우선**하며, 그때는
  정착된 lifecycle id 를 재사용하지 않는다
- base drift 섹션 — worktree HEAD 가 base 보다 N 커밋 뒤처졌을 때만 최근 5개 제목과
  함께 경고한다. *"폴루션하면 워커가 무시하도록 학습된다"* 는 이유로 평시엔 넣지 않는다

---

## 7. paseo — 태스크/세션 모델과 provider 레지스트리 (계약 관찰만)

- 1급 엔터티는 **agent** 다. `run`(생성+시작) · `attach`(출력 스트림 부착) · `send` ·
  `wait` · `stop` · `logs` · `mode` · `archive`(소프트 삭제) · `import`
- `agent wait` 의 결과 상태는 **`idle | timeout | permission | error`** 4종
  (`packages/cli/src/commands/agent/wait.ts`). orca 와 동일하게 **permission ≠ idle**
- 턴 단위 상태는 `running | completed | failed | canceled`
  (`packages/protocol/src/agent-types.ts`). 화면이 아니라 provider 어댑터가 만드는
  타임라인 아이템에서 나온다 — paseo 는 에이전트 프로세스를 구조화 프로토콜로 소유하므로
  **PTY 를 긁을 필요가 없다.** dongminal 은 사람이 보는 실 TUI 를 몰기 때문에 이 경로를
  택할 수 없다. 따라서 dongminal 의 완료 신호는 orca 쪽(훅 + 명시 보고)이어야 한다
- 격리는 **실행 단위 옵션**이다 — `agent run --new-workspace <local|worktree>`,
  worktree 모드는 `branch-off | checkout-branch | checkout-pr` 셋
  (`packages/cli/src/commands/worktree/create-input.ts`). **기본은 현재 cwd**
- provider 레지스트리(`packages/protocol/src/provider-config.ts`)는 **사용자 설정으로
  덮어쓰는 zod 스키마 맵**이다. 빌트인 6종(`claude` `codex` `copilot` `opencode` `pi`
  `omp`) + 커스텀은 `extends` 필수. 필드: `command`(argv 를 `default|append|replace`
  3모드로 조작) · `env` · `params` · `models[]`(각 모델에 `thinkingOptions[]`) ·
  `disallowedTools` · `enabled` · `order`
- `claude/opus-4.6` 문법은 **`<providerId>/<modelId>`** 이며 provider 어댑터가 `/` 로
  쪼개 자기 모델 id 로 넘긴다 (`providers/*/agent.ts`). 즉 dongminal 이 흉내낼 것은
  파서가 아니라 **"에이전트 종류와 모델을 한 토큰으로 지목한다"는 계약**뿐이다

---

## 8. dongminal 로의 전이 — 무엇이 이미 있고 무엇이 없나

| 필요한 것 | dongminal 현황 |
|---|---|
| 에이전트 상태 원천 | **있다.** `dmctl activity` → `/api/tools/activity/set` → `AttnTracker`. 상태 `working/waiting/done/idle/ended` |
| 그 상태를 에이전트가 읽을 경로 | **없다.** `GET /api/tools/activity` 는 브라우저 전용. `dmctl` 에 대응 서브커맨드가 없어 스킬이 화면 스크래핑으로 내몰린다 |
| 대기 프리미티브 | **없다.** orca `terminal wait --for tui-idle` 대응물이 없어 스킬이 `sleep 8` + 최대 10회 재확인을 손으로 돌린다 |
| 프롬프트/메시지 전달 | **있다.** `send-input`(bracketed paste + 120ms) · `msg`(엔벨로프) |
| 실행 기록 | **없다.** `~/.dongminal/runs.json` 은 소비자 없는 프로토타입 (`{id, short, objective, projection, isolation, state, createdAt, closedAt}`) |
| Run 접합 필드 | **있다.** `Tool.runId` · `Window.ownerRunId` · `run.Projection` (미소비) |
| worktree | **없다.** 저장소에 개념이 0건 |
| 에이전트 어댑터 | **하드코딩.** `parseClaudeHook`/`parseCodexHook` 가 `dmctl_activity.go` 안에 있고, codex 는 `agent-turn-complete`(=done) 하나뿐이라 활동 해상도가 다르다 |
| 격리 없는 협업 | **있고, 이것이 차별점이다.** 신뢰 엔벨로프 채널 — orca 에는 없다 |

---

## 9. 이 조사가 뒤집은 문서 서술

| 기존 서술 | 실측 |
|---|---|
| "Orca 의 MIT 공개 소스" (paseo 포함하는 뉘앙스) | paseo 는 **AGPL-3.0-or-later**. 코드 차용 불가 |
| orca = "fan-out → **비교** → 병합" | 비교·병합 자동화는 **없다**. `merge_ready` 는 무동작 알림 타입이고 병합 판단은 사람이 한다 |
| orca 의 조정은 런타임 스케줄러 | **은퇴했다.** `coordinator-start`·`run` 은 무동작. 조정자는 CLI 를 호출하는 **에이전트**다 |
| 리뷰 주석을 "구조화 페이로드? 프롬프트?" | **결정적 평문** + bracketed paste. dongminal 의 `SendPaste` 와 같은 경로 |
| 에이전트 레지스트리 = 선언 | 기동·탐지·프롬프트 주입은 **선언**, 훅(정책) 설치는 **벤더별 코드** + 균일 인터페이스 |
