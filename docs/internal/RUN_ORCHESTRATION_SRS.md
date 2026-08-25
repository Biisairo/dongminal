# SRS: Run 오케스트레이션 — 실행 기록·상태 계약·에이전트 어댑터·worktree 격리 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

dongminal 을 **다중 에이전트 오케스트레이터**로 만든다. 접합면(`dmctl` 액션 + 세션
스코프 스킬)은 `SKILL_INJECTION_SRS` 가 이미 놓았고, 식별자 계약은
`WORKSPACE_IDENTITY_SRS` 가 닫았다. 남은 것은 **실행 축(Run)의 실체**다.

지금 dongminal 에는 실행 상태를 담을 곳이 없다. 팀원 uuid 매핑표는 팀장 CC 의 **대화
기록에만** 있고(팀 스킬 §4 "매핑표는 부팅 직후 작성해 보관한다"), 준비완료 판정은
**화면 스크래핑**이며(`╭─` + `Thinking...` 부재 + `[대기]`), 격리는 **없다**(같은
워킹트리 공유). 그 결과:

- 컨텍스트 압축이나 턴 유실이 일어나면 팀을 **정리할 수 없다** — 누가 팀원인지 아는
  주체가 사라진다
- 에이전트가 권한 확인을 기다리는 중(`waiting`)과 준비완료(`idle`)를 화면으로
  구분해야 한다
- 병렬 팀원이 같은 파일을 동시에 고쳐도 막을 수단이 없다

본 SRS 는 이 셋을 닫는다 — **Run 레코드(영속)**, **상태·대기 계약**, **worktree 격리**.
여기에 `SKILL_INJECTION_SRS` §5 가 넘긴 **에이전트 어댑터 레지스트리**와, 위 셋을
전제로 한 **스킬 재작성**을 더한다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 내용 | 상태 |
|---|---|---|
| S | 상태·대기 계약 — `dmctl status` / `dmctl wait`, 준비완료 판정 사다리, `waiting ≠ ready` | **완료** (`228c464`). 사다리 2단계만 A 대기 |
| R | Run 레코드 — 스키마·영속(`runs.json`)·상태기계·epoch 펜싱·접합 필드 소비 | **완료** (`a958797`) |
| P | 멤버 프리앰블과 보고 계약 — 평문 프리앰블, 1회 보고, 발신자 정체 기반 권한 | **완료** — 보고 권한(FR-PRE-5/6/7)은 R 과 함께, 프리앰블 본문(FR-PRE-1~4/8)은 A 와 함께 |
| A | 에이전트 어댑터 레지스트리 — 기동·탐지·프롬프트 주입·정책 주입·훅 파서의 선언화 | **완료** (`internal/agentadapter`). FR-STA-4 2단계 소비자만 미구현 |
| W | worktree 격리 — Run 단위 선택, 생성·명명·정리·실패 잔여물·안전 가드 | **완료** (`internal/worktree`). FR-WKT-3 의 명명 규칙만 개정 — 아래 주석 |
| K | 스킬 재작성 — `team`·`workflow` 를 Run 기반 전용 창 토폴로지로 | **완료** (`b3dc910`). `build_prompt.py`·`references/prompt.md` 삭제, fingerprint 0건 |

구현 순서는 의존과 리스크를 따른다 — S → R → **P+A** → W → K.

**미포함:** §5 비목표.

### 1.3 정의 (Definitions)

`Client` / `Window` / `Pane` / `Tab` / `Tool` 은 `ENTITY_MODEL_RESTRUCTURE_SRS` §1.3 을
따른다. 본 SRS 고유 용어만 정의한다.

| 용어 | 정의 |
|------|------|
| **Run** | 오케스트레이션 실행 인스턴스. 공간 계층의 레벨이 아니라 **직교 축**이다 (`internal/run`) |
| **Member** | Run 에 속한 참여자 하나. **Tool 과 1:1** 로 결속한다 |
| **조정자 (coordinator)** | Run 을 만들고 멤버를 몰아가는 에이전트. **서버의 스케줄러가 아니라 에이전트다** (§2.5) |
| **투영 (projection)** | Run 이 공간을 차지하는 방식 — `dedicated-window` \| `background` \| `inline` (`run.Projection`) |
| **격리 (isolation)** | Run 멤버가 파일시스템을 나누는 방식 — `none` \| `per-run` \| `per-member` |
| **epoch** | 서버 프로세스 1회 기동의 식별자. 재기동 경계에서 이전 세대 Run 을 펜싱한다 |
| **준비완료 (ready)** | 멤버 에이전트가 **지시를 받을 수 있는** 상태. `waiting`(권한 확인 대기)은 준비완료가 아니다 |
| **보고 (report)** | 멤버가 작업 종료를 Run 에 알리는 명시적 행위. 훅 상태와 달리 **권위 있는** 신호다 |
| **프리앰블 (preamble)** | 멤버 기동 시 주입하는 역할·프로토콜 지시문. 평문이다 |

### 1.4 참고 (References)

- `ENTITY_MODEL_RESTRUCTURE_SRS.md` — 엔티티 모델, FR-EM-17/18(Run 접합 필드), FR-BG-9
- `SKILL_INJECTION_SRS.md` — 에이전트 접합면(`dmctl` + 세션 스코프 스킬), §5 비목표
- `WORKSPACE_IDENTITY_SRS.md` — FR-UNI-1(uuid 형식), FR-UNI-15(Run·Member id),
  FR-SXE-8(오케스트레이터는 `location` 을 명시한다)
- `ORCHESTRATOR_RESEARCH_NOTES.md` — **orca / paseo 실제 구현 조사**. 본 SRS 의 §2 는
  이 노트를 근거로 한다
- `USER_CHECKLIST_FIXES_HANDOFF.md` §4 — 반복 금지 함정 15개
- `internal/run/run.go`, `internal/runtimebin/dmctl_activity.go`, `internal/server/activity.go`

### 1.5 개요 (Overview)

§2 는 실측된 현황과 참조 구현의 근거, §3 은 묶음별 요구사항, §4 는 검증, §5 는 비목표,
§6 은 기존 요구 개정, §7 은 착수 전 결정과 변경 기록이다.

---

## 2. 현황 (Identified Issue)

### 2.1 실행 상태의 유일한 저장소가 대화 기록이다

`team` 스킬은 팀원 uuid 를 **어시스턴트 턴 안에서만** 들고 있다 (SKILL.md §3~§8:
"보관해둔 팀원 uuid 들에 대해"). 컨텍스트가 압축되거나 세션이 바뀌면 그 매핑이
사라지고, 남은 것은 **누가 팀원인지 알 수 없는 도구 N개**다. 워크스페이스 트리에는
"이 탭은 어느 Run 소유"라는 표식이 없다 — `Tool.runId` · `Window.ownerRunId` 필드는
있지만 **아무도 쓰지 않는다** (FR-EM-18: "이 필드를 읽는 동작을 추가하지 않는다").

`~/.dongminal/runs.json` 에 Run 레코드 프로토타입이 실재하나 **커밋된 코드에 소비자가
0건**이다 (`WORKSPACE_IDENTITY_SRS` §2.6). 형태는 다음과 같다:

```json
{"schemaVersion":1,"runs":[{"id":"01a031f4-…","short":"38c0a644","objective":"…",
  "projection":"inline","isolation":"none","state":"closed",
  "createdAt":1787544488,"closedAt":1787544603}]}
```

즉 **필드 설계는 이미 이 방향을 가리키고 있었고**, 본 SRS 가 그 소비자를 만든다.

### 2.2 준비완료 판정이 화면 스크래핑이다 — 재료는 이미 있는데도

`team` 스킬의 Barrier(§5)는 세 조건을 화면에서 찾는다: `╭─` 프롬프트 박스, `Thinking...`
부재, 초기 프롬프트의 `[대기]` 텍스트. 그리고 `sleep 8` → 최대 10회 재확인을 **모델이
손으로** 돌린다.

그런데 dongminal 은 이미 **훅 기반 에이전트 상태**를 갖고 있다:

| 계층 | 현황 |
|---|---|
| 수집 | `dmctl activity claude` 가 훅 stdin JSON 을 파싱 (`dmctl_activity.go`) |
| 상태 | `working` · `waiting` · `done` · `idle` · `ended` (`internal/server/activity.go`) |
| 저장 | `AttnTracker` / `ToolManager` 의 도구별 `activitySnap{toolId,state,tool,detail,updatedAt}` |
| 조회 | `GET /api/tools/activity` — **브라우저 전용.** SSE `tool_activity` 로도 나간다 |
| 에이전트의 조회 경로 | **없다.** `dmctl` 에 대응 서브커맨드가 없다 |

**결손은 하나뿐이다** — 에이전트가 그 상태를 읽을 CLI 가 없어서 스킬이 화면으로 내몰린다.
게다가 Claude Code 훅의 `Notification` → `waiting` 은 **권한 확인 대기**를 뜻하므로,
"화면에 `Thinking...` 이 없다"만 보는 현재 판정은 **권한 대기를 준비완료로 오인**한다.

### 2.3 격리가 없다

저장소에 worktree 개념이 0건이다. `team` 스킬은 팀원을 **팀장의 Pane 을 쪼개** 만들고,
전원이 같은 워킹트리를 공유한다. 그래서 스킬 문서의 상당 부분이 **사용자 공간 침범
방어**(`--no-focus` 강제, `dmctl focus` 전면 금지)에 쓰인다. `workflow` 스킬의
`dedicated` 창 모드가 그 방어를 구조로 푸는 선행 사례다.

### 2.4 에이전트 어댑터가 하드코딩이다

`parseClaudeHook` / `parseCodexHook` 가 `dmctl_activity.go` 의 `switch agent` 안에 있다.
에이전트를 하나 더 붙이려면 이 파일을 고쳐야 하고, **기동 커맨드·정책 주입 방식·준비완료
판정**은 아예 코드에 없고 스킬 본문의 산문으로만 존재한다. 두 에이전트의 활동 해상도도
근본적으로 다르다 — Claude 는 전 생명주기 훅을 주지만, codex 의 표준 notify 는
`agent-turn-complete`(= `done`) **하나뿐**이다.

### 2.5 참조 구현이 정정한 전제 (`ORCHESTRATOR_RESEARCH_NOTES.md`)

실제 소스를 읽어 확인한 사실 중 **기존 문서 서술을 뒤집은 것**:

| 기존 서술 | 실측 |
|---|---|
| "Orca 의 장점 = fan-out → **비교** → 병합" | **자동 비교·병합은 없다.** `merge_ready` 는 코디네이터가 `break` 로 넘기는 무동작 알림 타입이고, 병합 판단은 사람이 한다 |
| orca 의 조정 = 런타임 스케줄러 | **은퇴했다.** `coordinator-start`·`run` 은 무동작이고, 조정은 CLI 를 호출하는 **에이전트**가 한다 |
| "MIT 공개 소스" (orca·paseo 양쪽 뉘앙스) | orca 는 MIT, **paseo 는 AGPL-3.0-or-later**. paseo 코드는 차용 금지 — 계약 관찰만 |
| 리뷰 주석의 왕복 형태가 미상 | **결정적 평문**(`File:` / `Line:` / `User comment: "…"`) + bracketed paste. dongminal 의 `SendPaste` 와 같은 경로 |
| 에이전트 레지스트리 = 순수 선언 | 기동·탐지·프롬프트 주입은 선언, **훅(정책) 설치는 벤더별 코드** + 균일 인터페이스 |

그리고 **채택할 계약**:

- 준비완료 판정 사다리 — 훅/타이틀 상태 → 명시적 idle 표식 → 알려진 준비 프롬프트 →
  전경 프로세스가 셸이 아니고 출력이 3초 조용 → 5분 상한. 그리고 **`blocked` 는 idle 이
  아니다**
- `worker_done` 정확히 1회 + 명시적 `--outcome` + 3문장 요약. **실패를 산문에만 담지 말 것**
- 완료 보고의 권한은 **발신자가 그 배정의 주체인지**로 판정한다 —
  *"payload knowledge alone is not authority"*
- 완료 후 규약 — 유휴로 돌아가고 폴링 루프 금지, 스스로 터미널을 닫지 말 것.
  **단 사용자의 직접 지시는 언제나 우선**한다
- 워커에게 `AskUserQuestion` 류의 로컬 TUI 프롬프트를 금지한다. 조정자가 볼 수 없어
  세션이 영구히 멈춘다
- 격리는 **명시적 선택**이다. "독립 태스크·병렬 실행·편의"는 격리 사유가 아니다
- worktree 경로·이름을 **재사용하지 않는다** — 에이전트 CLI 가 cwd 로 대화 이력을
  키잉하므로 재사용은 남의 이력을 물려주는 것이다
- 타임아웃은 실패가 아니라 **체크포인트**다 (코딩 작업은 15~60분이 일상)

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 R — Run 레코드 (FR-RUN-\*)

**FR-RUN-1** Run 레코드의 필드는 다음이다. 기존 `runs.json` 프로토타입(§2.1)의 필드명을
보존하고 확장한다.

| 필드 | 뜻 |
|---|---|
| `id` | uuid (v7). FR-UNI-15 |
| `short` | `id` 앞 8자. 로그·경로 가독성용 파생값 |
| `objective` | 한 줄 목적 |
| `projection` | `dedicated-window` \| `background` \| `inline` (`run.Projection`) |
| `isolation` | `none` \| `per-run` \| `per-member` |
| `state` | `open` \| `closed` \| `aborted` |
| `epoch` | 이 Run 을 연 서버 기동의 epoch (FR-RUN-5) |
| `coordinatorToolId` | 조정자 도구 |
| `windowId` | `dedicated-window` 일 때 Run 전용 Window 의 uuid |
| `members[]` | FR-RUN-2 |
| `createdAt` / `closedAt` | epoch 초 |
| `abortReason` | `state=aborted` 일 때만 |

**FR-RUN-2** Member 레코드의 필드는 다음이다.

| 필드 | 뜻 |
|---|---|
| `id` | uuid (v7). FR-UNI-15 |
| `role` | 역할명. 탭 이름과 같다 |
| `agent` | 어댑터 id (묶음 A) |
| `toolId` | 결속된 Tool. **1:1** |
| `tabId` | 그 도구를 담은 탭 uuid — `location` 지정에 쓴다 (FR-RUN-9) |
| `worktree` | 격리 시 경로·브랜치 (묶음 W). `isolation=none` 이면 없음 |
| `state` | `starting` \| `ready` \| `working` \| `waiting` \| `done` \| `failed` \| `lost` \| `released` |
| `outcome` / `summary` / `filesModified[]` | 보고 결과 (묶음 P) |
| `reportedAt` / `lastSeenAt` | 명시 보고 시각 / 마지막 상태 관측 시각 |

**FR-RUN-3** Run 레코드는 `$DONGMINAL_HOME/runs.json` 에 영속한다. `schemaVersion` 은
**1을 유지**한다 — 프로토타입이 이미 1로 쓰여 있고 구조는 확장뿐이라 판별에 버전이
필요 없다 (FR-MGU-9 와 같은 논리).

**FR-RUN-4** 쓰기는 **원자적**이어야 한다 — 임시 파일에 쓰고 `rename` 한다.
`tools.json` 의 `SaveAll` 과 달리 조용한 손실을 허용하지 않는다. 파일이 없거나 파싱에
실패하면 **빈 Run 목록으로 시작**하고 한 줄 경고를 남긴다 (NFR-RUN-2).

**FR-RUN-5** 서버는 기동 시 **epoch** 를 하나 발급한다(uuid v7, `internal/uuid`). 로드
시 `state=open` 이고 `epoch` 가 현재와 다른 Run 은 **`aborted`(`abortReason=
"daemon-restart"`)로 확정**한다. 되살리지 않는다 — 백그라운드 도구가 재기동을 넘지
못하므로(FR-BG-9) 멤버의 실체가 이미 없다.

**FR-RUN-6** Run 이 참조하는 `toolId` 가 더 이상 live 가 아니면(`ToolManager.IsLive`)
해당 멤버는 `lost` 다. 이 판정은 조회 시점에 파생하며, Run 레코드가 도구 존재의 근거가
되어서는 안 된다.

**FR-RUN-7** Run 생성·해체 시 `Tool.runId` 와(`dedicated-window` 이면) `Window.ownerRunId`
를 채운다. FR-EM-18 은 유지된다 — **비어 있어도 모든 동작이 정상**이어야 하며, 이 필드를
읽지 못해 실패하는 경로를 만들지 않는다.

**FR-RUN-8** `dmctl` 서브커맨드를 추가한다. 액션 계층은 셸 명령이라는 규약을 따른다
(SKILL_INJECTION_SRS §1.1).

```
dmctl run start   --objective <텍스트> [--projection <p>] [--isolation <i>] [--base <ref>] [--json]
dmctl run member  --run <uuid> --role <이름> --agent <id> [--json]
dmctl run report  --outcome succeeded|failed --summary <텍스트> [--files a,b] [--run <uuid>] [--member <uuid>]
dmctl run status  [--run <uuid>] [--json]
dmctl run close   --run <uuid> [--keep-worktrees] [--force]
dmctl run list    [--json]
```

`run member` 는 **멤버 등록·공간 확보·(격리 시) worktree 생성·에이전트 기동·프리앰블
주입**을 한 번에 수행하고, 확보한 `tabId`·`toolId`·worktree 경로를 반환한다. 저수준
경로(`split-*` → `send-input`)도 계속 유효하며, 그 경우 조정자가 `run member` 대신
멤버를 손으로 등록한다. `run report` 의 `--run`/`--member` 는 **대조용**이며 생략이
정상이다 (FR-PRE-5).

**FR-RUN-9** 오케스트레이터는 도구를 다룰 때 **항상 `location` 을 명시한다** —
FR-SXE-8 의 승계다. `location` 없는 생성 명령은 서버가 지명한 실행자의 포커스 Pane 에
착지하므로 호출자가 통제할 수 없다. Run 이 만드는 모든 생성 명령은 `--at <tab uuid>` 를
동반해야 하며, 이를 어긴 경로는 **테스트로 막는다**(TC-RUN-9).

**FR-RUN-10** Run 은 **자기가 만든 것만** 정리한다. 사용자가 만든 창·탭·도구·worktree 를
Run 해체가 건드려서는 안 된다. 판정 근거는 Run 레코드의 `members[]`·`windowId` 이며,
목록에 없는 자원은 발견되더라도 보존하고 보고한다.

**FR-RUN-11** `run close` 는 `done`/`failed` 로 보고하지 않은 멤버가 있으면
**기본적으로 거부**하고 목록을 보고한다. `--force` 로만 넘어간다. 근거: 참조 구현이
"타임아웃·유휴·heartbeat 를 이유로 워커를 release 하지 말라"고 못박은 지점과 같다.

**FR-RUN-11a** `run close` 는 **도구를 종료하지 않는다.** 기록을 닫고 표식을 해제한 뒤
**정리 대상(멤버별 `toolId`·`tabId`·생존 여부)을 반환**하며, 실제 종료는 조정자가
에이전트의 종료 명령(묶음 A) → `dmctl close-tab --at <탭 uuid>` 순으로 수행한다.

> **개정 근거 (2026-08-25, 구현 중 발견).** 초판은 "`run close` 는 멤버 도구를
> 종료하되"로 적었으나, 실행 중인 도구의 탭을 닫으면 브라우저가 **확인창을 띄운다**
> (FR-BG-3 — 실행 중 프로세스가 있는 탭 닫기). 보고를 마친 멤버도 에이전트 TUI 자체는
> 살아 있으므로 이 조건에 걸린다. 서버가 무인으로 닫으면 그 자리에서 사람의 클릭을
> 기다리게 되어 자동 정리가 막힌다. 참조 구현의 `worker-release` 도 "정착된 Dispatch 가
> 소유한 바로 그 터미널만" 닫으며 사용자가 가져간 것은 남긴다 — 종료 판단은 조정자
> 쪽에 있는 것이 맞다.

### 3.2 묶음 S — 상태·대기 계약 (FR-STA-\*)

**FR-STA-1** `dmctl status [--at <uuid>] [--json]` 을 추가한다. 대상 도구의 활동 상태
(`state`·`tool`·`detail`·`updatedAt`)와 live 여부를 낸다. `--at` 생략 시
`$DONGMINAL_TOOL_ID`. 보고된 활동이 없으면 `state=unknown` 이며 오류가 아니다.

**FR-STA-2** `dmctl wait --at <uuid> --for ready|done [--timeout-ms N]` 을 추가한다.
조건 충족까지 블로킹한다. 기본 타임아웃 **300000ms(5분)**, 상한 **1800000ms(30분)**.

**FR-STA-3** 대기는 **서버 long-poll** 로 구현한다(`GET /api/tools/activity/wait`).
클라이언트 폴링 루프를 만들지 않는다 — 지금 스킬이 `sleep 3` × 10회로 하고 있는 일이
바로 그것이고, 상태 전이는 이미 서버가 알고 있다.

**FR-STA-4** **준비완료 판정 사다리.** 위에서부터 강한 근거이며, 첫 번째로 성립하는
근거를 채택한다.

1. 훅이 보고한 상태가 `idle` 또는 `done`
2. 어댑터가 선언한 준비완료 화면 패턴이 관측됨 (묶음 A. 훅이 없는 에이전트용)
3. 도구가 live 이고 마지막 출력 이후 **3000ms** 동안 출력이 없음 (정적 폴백)

> **구현 현황 (묶음 A 이후)**: 1·3 단계만 구현돼 있고 **2 단계는 여전히 비어 있다.**
> 어댑터 레지스트리에 선언 자리(`Readiness.ScreenPatterns`)는 생겼으나 **소비자를
> 만들지 않았다** — 의도적인 보류다.
>
> 근거: 화면 패턴은 사용자가 하단 스테이터스라인 하나만 붙여도 깨진다. 그것은
> FR-SKL-2 가 team 스킬의 `╭─`·`Thinking...`·`[대기]` fingerprint 를 **삭제
> 대상**으로 삼는 이유와 정확히 같은 취약성이며, 선언으로 옮긴다고 사라지지 않는다.
> 검증 대상인 Claude 는 훅으로 1 단계에서 끝나므로 2 단계를 타지 않고(FR-ADP-4),
> 2 단계가 실제로 필요한 codex 의 화면 패턴은 이 환경에서 실측하지 못했다 —
> 추측한 패턴을 넣으면 아무도 검증하지 않은 판정 근거가 코드에 남는다.
>
> 훅을 주지 않는 에이전트는 3 단계(출력 3초 정적)로 판정된다. 자리는
> `evaluateWait`(`internal/server/handlers_status.go`)에 그대로 있다.

**FR-STA-4a** 정적 폴백은 **훅 상태가 아예 없을 때만** 적용한다. 훅이 `working` 을
보고했다면 그것이 이긴다 — 출력이 멎었다는 것은 사고 중이라는 뜻이지 준비완료가 아니다.
또한 정적 폴백은 **`ready` 전용**이다. 침묵은 완료(`done`)의 근거가 될 수 없다.

**FR-STA-4b** (2026-08-25 신설, 실측 근거) 정적 폴백은 **어댑터가 훅으로 준비완료를
말하지 않는 에이전트에만** 적용한다(`Readiness.Hooks=false`). 훅을 주는 에이전트는
훅을 기다리다 타임아웃(체크포인트)으로 돌아간다.

> **근거 — 실제로 밟았다.** Claude Code 를 멤버로 띄우자 **폴더 신뢰 확인 모달**이
> 떴는데, 그 상태에서 화면은 조용하고(`quietMs=21023`) 훅은 아무것도 보고하지
> 않아(`state=unknown`) 정적 폴백이 그것을 준비완료로 판정했다 —
> `dmctl wait --for ready` 가 `reason=quiescence`, `waitedMs=0` 으로 rc=0 을 냈다.
> 거기서 Kickoff 를 보내면 모달이 삼킨다. 이는 FR-PRE-8 이 막으려던 데드락과
> 같은 결말이다.
>
> 시작 모달은 시간이 지난다고 풀리지 않으므로, 침묵을 근거로 삼는 대신 훅을
> 기다리다 체크포인트로 돌려주는 것이 정직하다. 어떤 에이전트가 도는지는 Run 멤버
> 기록이 안다. 멤버가 아닌 도구는 알 수 없으므로 기존 동작을 유지한다(NFR-RUN-1).
>
> 이것이 `Readiness` 필드의 첫 실질 소비자다. 사다리 2단계(화면 패턴)는 여전히
> 구현하지 않는다 — 화면 패턴이었다면 스테이터스라인 하나로 다시 깨졌을 것이다.

**FR-STA-5** **`waiting` 은 준비완료가 아니다.** 훅 상태가 `waiting` 이면 `wait` 은
대기를 계속하지 않고 **즉시 `blocked` 로 반환**한다(rc=5). 권한 확인 대기는 시간이
지난다고 해소되지 않으며, 사람이나 조정자의 개입이 필요하다.

**FR-STA-6** **타임아웃은 실패가 아니다.** `wait` 의 타임아웃 종료(rc=4)는 마지막 관측
상태와 마지막 출력 시각을 함께 보고해야 한다. 문서·스킬은 타임아웃을 "체크포인트"로
서술하며, 타임아웃만을 근거로 멤버를 종료·재기동하지 않는다.

**FR-STA-7** 종료 코드: 조건 충족 0, 사용법 오류 2, 서버·전송 오류 1, **타임아웃 4**,
**blocked 5**. FR-DMA-10 의 확장이며 기존 코드값의 의미는 바뀌지 않는다.

**FR-STA-8** `dmctl status` · `dmctl wait` 는 direct 모드와 daemon 모드에서 동일하게
동작해야 한다. 기존 접합면과 같이 `internal/adapters` 를 경유해 보장한다 (FR-API-6).

### 3.3 묶음 A — 에이전트 어댑터 레지스트리 (FR-ADP-\*)

**FR-ADP-1** 에이전트별 지식을 **하나의 선언 테이블**로 옮긴다. 최소 필드:

| 필드 | 뜻 |
|---|---|
| `id` | `claude` · `codex` … |
| `detectCmd` | PATH 탐지에 쓰는 실행 파일명 |
| `launch` | 기동 커맨드와 인자 |
| `promptInjection` | 프롬프트 전달 방식 — `argv` \| `stdin-after-start` |
| `policyInjection` | 정책 주입 방식 — Claude 는 `--plugin-dir`/`--settings`, codex 는 `-c`/AGENTS.md |
| `hookParse` | 훅 stdin JSON → `activityReport` 변환 (함수 값) |
| `readiness` | 훅 기반인지, 화면 패턴 폴백이 필요한지 (FR-STA-4 의 2단계, FR-STA-4b) |
| `exitCommand` | 정중한 종료 지시 (Claude `/exit`) |
| `argvSeparator` | 위치 인자 프롬프트 **바로 앞**의 구분자 (Claude `--`) |
| `memberArgs` | Run 멤버로 띄울 때 덧붙는 인자 (Claude `--allowedTools "Bash(dmctl:*)"`) |

> **뒤 두 필드는 2026-08-25 실측으로 추가됐다.**
>
> - `memberArgs` — 멤버가 보고·질문을 하려면 `dmctl` 을 실행해야 하는데, 기본
>   기동에서는 그 **첫 명령이 승인 프롬프트에 걸린다.** 실제로 haiku 멤버가
>   프리앰블대로 `run report` 를 만들었으나 승인 대기에서 멈췄고, 서버 로그에
>   `/api/runs/report` 가 0건이었다. 조정자가 팀원 수만큼 승인해 줘야 하므로
>   무인 팀이 성립하지 않는다. 사전 허용은 **`dmctl` 로만 한정**한다 — 전면
>   우회는 멤버에게 사용자가 주지 않은 권한을 주는 것이라 선택지가 아니다.
> - `argvSeparator` — `--allowedTools` 는 가변 인자(`<tools...>`)라 뒤따르는 위치
>   인자 프롬프트까지 삼킨다. 실제로 프리앰블이 도구 이름으로 먹혀 **빈 프롬프트로
>   기동**됐고, 화면을 보기 전에는 알 수 없었다. orca 의 `argvPromptSeparator`
>   가 존재하는 이유와 같다 (`ORCHESTRATOR_RESEARCH_NOTES` §4.1).
>
> 둘을 적용한 뒤 전 사슬을 다시 실측했다 — 기동에서 보고 기록까지 **10초**,
> 승인 프롬프트 0건, `run status` 가 `state=done outcome=succeeded` 로 반영.

**FR-ADP-2** `dmctl_activity.go` 의 `switch agent { case "claude": … case "codex": … }`
를 제거하고 레지스트리 조회로 대체한다. 훅 파서 자체(`parseClaudeHook` 등)는 각
어댑터의 필드로 이동하며, **동작은 바뀌지 않는다**.

**FR-ADP-3** 알 수 없는 에이전트 id 는 **명확한 오류**로 실패해야 한다. 조용히 성공하거나
기본 에이전트로 폴백해서는 안 된다 (NFR-EM-1 의 정신).

> **구현 시 확정**: 종료 코드에는 예외가 하나 있다. `dmctl activity <agent>` 는
> 에이전트 훅으로 실행되므로 비0 종료가 사용자의 도구 호출을 막는다(NFR-AAP-5).
> 이 경로만 **stderr 로 명확히 말하되 rc=0** 을 지킨다. 오케스트레이션 경로
> (`dmctl run member`·`run launch`·`POST /api/runs/members`)는 rc=2 / 400 으로
> 거부하므로, 잘못된 id 가 기록에 들어가는 통로는 없다.

**FR-ADP-4** **검증 대상은 Claude Code 다** (D-D). codex 는 선언을 유지하되 best-effort
이며, 활동 해상도가 낮다는 사실(§2.4)을 레지스트리 주석과 스킬 문서에 명시한다. codex
멤버의 준비완료는 FR-STA-4 의 2·3단계로 판정된다.

**FR-ADP-5** 정책 주입은 **세션 스코프를 유지한다** — 사용자의 영구 설정
(`~/.claude/settings.json` 등)을 수정하지 않는다. 참조 구현은 영구 설정에 쓰는 대가로
설치 잠금·소유자 신원·드리프트 검출 기계를 유지하고 있으며, 우리는 그 비용을 지지
않기로 이미 결정했다 (SKILL_INJECTION_SRS §1.1).

**FR-ADP-6** 레지스트리는 **정책 계층을 담지 않는다.** 무엇을 왜 어떤 순서로 하는지는
스킬 본문이고, 레지스트리는 "이 에이전트를 어떻게 띄우고 어떻게 상태를 읽는가"만
답한다. 두 계층의 경계는 SKILL_INJECTION_SRS §2.3 을 따른다.

### 3.4 묶음 W — worktree 격리 (FR-WKT-\*)

**FR-WKT-1** 격리는 **Run 단위 선택**이며 기본은 `none` 이다 (D-A). 세 값의 뜻:

| 값 | 뜻 |
|---|---|
| `none` | 전원이 조정자의 cwd 를 공유한다. **기본값** |
| `per-run` | Run 전체가 worktree 하나를 공유한다. 사용자의 작업 트리와는 분리 |
| `per-member` | 멤버마다 worktree 하나. 팬아웃용 |

근거: 참조 구현 둘 다 격리를 **명시적 선택**으로 두고 기본은 현재 작업 공간이다.
"독립 태스크·병렬 실행·편의"는 격리 사유가 아니며, dongminal 의 차별점인 신뢰 채널
협업 토폴로지 중 일부는 **파일 공유를 전제**한다.

**FR-WKT-2** worktree 생성은 다음 형태다.

```
git worktree add --no-track -b <branch> <path> [<base>]
```

`--no-track` 은 필수다 — base 의 upstream 을 물려받으면 push 전에 `git status` 가
"behind by N" 을 오보한다. 생성 직후 `push.autoSetupRemote=true` 를 best-effort 로
설정하고(실패해도 롤백하지 않음), 생성 base 를 `branch.<name>.base` 에 기록한다.

**FR-WKT-3** 경로와 브랜치 이름은 **Run·Member 의 uuid 에서 파생**한다.

```
경로:    $DONGMINAL_HOME/worktrees/<run.slug>/<member.slug>
브랜치:  dmn/<run.slug>/<role>
```

`slug` 는 `<uuid 앞 8자>-<uuid 뒤 8자>` 다 (`run.PathSlug`). **착수 시 이 자리는
`short`(앞 8자)였고, 구현 중 그것이 유일하지 않다는 것이 드러나 개정했다** — uuid v7
의 앞 48비트는 밀리초 타임스탬프이고 그 상위 32비트(=앞 8자)는 49일에 한 번 바뀐다.
즉 같은 기간에 열린 Run·Member 는 **전부 같은 short 를 갖는다.** 실측으로 확인했다:
연속으로 만든 Run 두 개가 `01a0370c` 로 같았고, short 로 만든 경로가 그대로 겹쳐
두 번째 멤버의 worktree 생성이 실패했다(TC-WKT-2 계열 테스트가 잡았다). 뒤 8자는
난수 구간이라 여기에 붙여 유일성을 회복한다. `role` 은 ASCII 슬러그로 환원하며,
환원 결과가 비면(한글 역할명 등) member slug 로 떨어진다. 같은 이름의 브랜치가 이미
있으면 `-<member.slug>` 를 덧붙인다 — 남의 브랜치를 재사용하지 않는다.

**FR-WKT-4** **경로를 재사용하지 않는다.** uuid 파생이 이를 자동으로 보장한다. 근거:
에이전트 CLI 는 대화 이력을 **cwd 로 키잉**하므로, 지워진 worktree 의 경로를 다시 쓰면
새 멤버가 남의 이력을 물려받는다.

**FR-WKT-5** `base` 는 명시하지 않으면 **Run 을 연 시점의 조정자 cwd 의 HEAD** 다.
명시할 수 있어야 한다. 현재 브랜치 위에 쌓는 것이 기본이라는 사실을 프리앰블에 적는다.

**FR-WKT-6** 브랜치·경로 인자가 `-` 로 시작하면 거부한다 (git 플래그 오인).

**FR-WKT-7** worktree 생성·제거는 **직렬화**한다. 공용 common-dir 을 건드리므로 병렬
팬아웃에서 경합한다.

**FR-WKT-8** `run close` 의 정리 규칙:

- 작업 트리가 **clean** 이면 worktree 를 제거하고 브랜치는 `-d`(머지된 것만) 로 지운다
- **dirty** 면 제거하지 않고 **보존 + 보고**한다. 사용자 작업의 조용한 삭제는 금지다
- **생성 실패의 롤백일 때만** `-D` 를 쓴다 — 사용자 작업이 없다는 것이 확실한 경우
- `--keep-worktrees` 면 전부 보존한다

> **알려진 구멍 (묶음 W 구현에서 확인, 미해소)**: 이 규칙의 진입점은 `run close`
> 하나이고 close 는 `open` 인 Run 만 받는다. 따라서 epoch 펜싱으로 `aborted` 된 Run
> (FR-RUN-5)의 worktree 는 기록에 남을 뿐 정리 경로가 없다. dirty 였다면 보존이
> 정답이므로 실제 누수는 clean 인 경우뿐이고, 빈도가 낮아 이번 범위에 넣지 않았다.
> 후속에서 `close --force` 를 종료된 Run 의 정리에도 열어 주는 형태가 후보다.

**FR-WKT-9** 정리 대상은 **Run 이 만든 worktree 만**이다 (FR-RUN-10). 판정 근거는 Run
레코드의 `members[].worktree` 다. 등록되지 않은 worktree 는 발견되더라도 건드리지 않는다.

**FR-WKT-10** 위험 경로를 거부한다 — 저장소 자신, 파일시스템 루트, 경로 이탈(`..`),
빈 경로. 제거 전에 경로가 실제로 `$DONGMINAL_HOME/worktrees/` 아래인지 확인한다.

**FR-WKT-11** 조정자의 cwd 가 git 저장소가 아니거나 `git` 이 없으면, 격리를 요청한 Run
시작은 **명확한 오류로 실패**한다. 조용히 `none` 으로 낮추지 않는다.

**FR-WKT-12** 정리하지 못한 자원은 **잔여물로 보고**한다(`run status` 와 `run close` 의
출력). 조용히 남기지 않는다. 사유는 열거한다 — `dirty` · `kept` · `unsafe-path` ·
`remove-failed` · `branch-retained`. 결과는 Run 레코드에 영속되므로 close 를 지켜보지
못한 다음 세션도 `run status` 로 같은 사실을 읽는다.

### 3.5 묶음 P — 프리앰블과 보고 계약 (FR-PRE-\*)

**FR-PRE-1** 멤버 프리앰블은 **평문**이다. 구조화 페이로드가 아니라, 실제 실행할
`dmctl` 예제에 Run·Member uuid 를 박아 넣은 텍스트를 도구에 붙여넣는다. 전달은 기존
`send-input`(bracketed paste + 120ms submit 지연) 경로를 쓴다.

> **조립 주체 = 서버** (착수 전 열려 있던 설계 질문, 구현 시 확정). 근거 셋:
> ① 서버는 멤버 생성 시점에 Run·Member uuid·조정자·격리·worktree 를 이미 전부
> 알고 있어 왕복이 없고, **조정자가 uuid 를 옮겨 적는 결함 계열**이 원천 차단된다.
> ② 프리앰블에 적힌 규칙은 서버가 실제로 강제하는 계약(1회 보고·outcome 필수·
> 발신자 정체 권한)의 문장화라, 강제 코드와 같은 패키지(`internal/run`)에 두어야
> 둘이 갈라지지 않는다. ③ 역할 본문만 정책이므로 스킬이 `--brief` 로 넣고 서버가
> 합성한다 — 계층 경계는 SKILL_INJECTION_SRS §2.3 그대로다.
>
> CLI 가 하는 일은 그 평문을 **어댑터가 선언한 기동 방식으로 감싸는 것**뿐이다
> (`dmctl run launch`). 프롬프트는 홑따옴표로 감싼다 — 기존 빌더의 큰따옴표 +
> 역슬래시 이스케이프는 `"`·`$`·백틱·`\` 를 각각 처리해야 하고 하나만 빠져도 셸이
> 본문을 전개한다.
>
> `--brief` 는 Member 레코드에 영속한다(FR-RUN-2 확장). 프리앰블이 **재조회
> 가능**해야 하기 때문이다 — 붙여넣기가 실패했거나 조정자가 컨텍스트를 잃어도
> `GET /api/runs/preamble?member=` 가 같은 텍스트를 다시 만든다.

**FR-PRE-2** 프리앰블에 담기는 행동 규칙은 **각 예제 바로 위**에 둔다. 산문 블록으로
몰지 않는다 — LLM 독자는 예제에 정박하고 뒤따르는 산문은 훑는다.

**FR-PRE-3** 담아야 하는 규칙:

- 보고는 **정확히 한 번**, `--outcome succeeded|failed` 를 **명시**한다. 실패를 산문에만
  담지 않는다. `--summary` 는 3문장 (무엇을 했는가 / 무엇을 발견했는가 / 무엇이 남았는가)
- 질문은 `dmctl msg --to <조정자 uuid>` 로 한다. **`AskUserQuestion` 류의 로컬 TUI
  프롬프트를 열지 않는다** — 조정자가 볼 수 없어 세션이 영구히 멈춘다
- 보고 후에는 **유휴 프롬프트로 돌아가 대기**한다. 폴링 루프를 돌리지 않고, 스스로
  탭·셸을 닫지 않는다
- **사용자의 직접 지시는 언제나 우선**한다. 그때는 사용자 작업으로 처리하며, 정착된
  Run·Member id 로 다시 보고하지 않는다
- 엔벨로프 신뢰 규약은 기존대로 `dmctl agent-context` 가 상시 주입한다 (FR-CTX-\*).
  프리앰블이 이를 중복 서술하지 않는다

**FR-PRE-4** 격리된 Run 의 프리앰블에는 **worktree 경로와 base 브랜치**를 적는다.
멤버가 자기가 어디서 일하는지 화면에서 추론하지 않아도 되게 한다.

> **구현 현황**: 묶음 W 가 `Member.Worktree` 를 채우면서 **실사용에서 켜졌다.**
> 단위 테스트(TC-PRE-4)에 더해 라이브 e2e 가 격리 Run 의 프리앰블에 경로가 실리는
> 것을 확인한다.

**FR-PRE-5** **보고의 권한은 발신자의 정체로 판정한다.** 서버는 보고를 받은 도구
(`DONGMINAL_TOOL_ID`, 없으면 `/api/whoami` 와 같은 remoteAddr→PID 폴백)로 멤버를
결정한다. 본문에 실린 `runId`/`memberId` 는 **대조용**이며, 불일치하면 거부한다.
페이로드를 아는 것은 권한이 아니다.

**FR-PRE-6** 보고 거부 사유는 **타입으로 열거**한다 — `sender_not_member`,
`run_closed`, `member_already_reported`, `run_member_mismatch`, `unknown_run`.
조용한 성공이나 뭉뚱그린 오류를 내지 않는다.

> **구현 시 추가**: 프리앰블 **조회** 실패에는 `unknown_member`(404)를 쓴다. 위
> 목록은 전부 보고(report)의 사유이며, 그중 `sender_not_member` 를 조회에
> 재사용하면 조정자가 **권한 문제로 오진**한다 — 조회 실패와 권한 실패는 대응이
> 다르다.

**FR-PRE-7** 이미 보고한 멤버의 재보고는 거부한다(`member_already_reported`). 정확히
한 번 규약의 서버측 강제다.

**FR-PRE-8** Kickoff(첫 작업 지시)는 **준비완료 확인 이후**에만 보낸다. 확인은
`dmctl wait --for ready` 이며(FR-STA-2), 화면 fingerprint 로 대체하지 않는다.

### 3.6 묶음 K — 스킬 재작성 (FR-SKL-\*)

**FR-SKL-1** `team` 스킬의 **기본 토폴로지를 `dedicated-window` 로 바꾼다.** 팀은 Run
전용 창에서 만들어지며 사용자의 작업 창을 쪼개지 않는다. 그 결과 현재 스킬의 방어
규칙 — `--no-focus` 강제, `dmctl focus` 전면 금지, 셀 비율 기반 레이아웃 계산 — 이
**불필요해지거나 축소된다**. `inline` 은 관찰 목적의 선택지로 남는다.

**FR-SKL-2** Barrier 를 `dmctl wait --for ready` 로 대체한다. 화면 fingerprint
(`╭─` · `Thinking...` · `[대기]`)를 스킬 본문에서 **제거**한다. 그 지식이 필요하다면
어댑터 선언으로 간다 (FR-ADP-1 `readiness`).

**FR-SKL-3** 팀원 uuid 매핑표를 **Run 레코드로 옮긴다.** 스킬은 매핑을 대화 기록에
보관하지 않고 `dmctl run status` 로 조회한다. 해체는 `dmctl run close` 다.

**FR-SKL-4** `workflow` 스킬의 정의서 필드를 Run 파라미터로 사상한다 — `session:
dedicated` → `projection`, 팀 배열 → 멤버 등록, `teardown` → `run close` 정책. 정의서
형식 자체는 바꾸지 않는다.

> **구현 시 확정**: 렌더러의 `session` 기본값(`inline`)도 **바꾸지 않았다.** 그것은
> 형식의 일부이고 기존 정의서의 동작을 조용히 바꾸게 되며, 그 기본값을 검증하는
> 테스트가 이미 있다. 대신 `create` 가 새 정의서에 `session: dedicated` 를
> **명시하도록** 스킬 정책을 바꿨다 — 형식은 그대로 두고 관행만 옮긴다.

**FR-SKL-5** 스킬은 **정책만** 담고 액션은 전부 `dmctl` 이다 (SKILL_INJECTION_SRS
FR-SK-\*). 본 SRS 가 추가하는 명령들도 같은 규약을 따른다.

**FR-SKL-6** "4단계~6단계를 한 턴 안에서" 규칙은 **유지**하되 범위가 줄어든다 —
`sleep` + 재확인 루프가 `dmctl wait` 한 번으로 접히므로, 턴 안에 남는 것은 부팅 → wait
→ kickoff 세 호출이다.

### 3.7 비기능 요구사항 (Non-functional)

**NFR-RUN-1** Run 을 쓰지 않는 일상 사용에 **관측 가능한 영향이 없어야 한다.**
`runs.json` 이 없거나 비어 있는 상태가 정상이다.

**NFR-RUN-2** `runs.json` 손상·부재는 기능 저하 없이 빈 상태로 시작한다. 부팅을
막지 않는다.

**NFR-RUN-3** `Tool.runId` · `Window.ownerRunId` 가 비어 있어도 모든 동작이 정상이어야
한다 (FR-EM-18 보존).

**NFR-RUN-4** 상태 조회는 기존 활동 스냅샷을 재사용한다 — 새 프로세스를 띄우거나 PTY 를
긁지 않는다. 대기는 long-poll 이므로 폴링 부하를 만들지 않는다 (SYSTEM_STATS_SRS 가
제거한 것을 되돌리지 않는다).

**NFR-RUN-5** 실패·잔여물은 **조용히 넘어가지 않는다.** 정리 실패, 보고 거부, 대기
타임아웃은 전부 사유와 함께 표면화된다.

### 3.8 설계 제약 (Design Constraints)

**DC-RUN-1** 서버는 **스케줄러가 되지 않는다.** Run 은 이름공간·기록·상태 조회의
주체이고, 무엇을 언제 시킬지는 조정자 에이전트가 정한다. 참조 구현이 런타임 스케줄러를
은퇴시킨 지점과 같은 선택이다.

**DC-RUN-2** 새 식별자는 전부 canonical uuid 다 (FR-UNI-1·FR-UNI-15). 구 id 와의 혼재는
정상이다.

**DC-RUN-3** 생성 명령은 항상 `location` 을 명시한다 (FR-SXE-8·FR-RUN-9).

**DC-RUN-4** `/api/commands` 의 `location` 정책은 바뀌지 않는다 — **탭 uuid 만** 받는다
(FR-DMC-9).

**DC-RUN-5** paseo 의 코드·주석·구조를 옮기지 않는다 (AGPL-3.0). orca(MIT)에서도 코드를
복사하지 않고 설계 아이디어만 가져오며, 저장소에 `LICENSE` 가 없는 현 상태를 바꾸지
않는다.

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | FR | 절차 | 기대 |
|---|---|---|---|
| TC-RUN-1 | FR-RUN-1/3 | `run start` 후 `runs.json` 판독 | uuid v7 id·short·objection 필드 보존, `schemaVersion` 1 |
| TC-RUN-2 | FR-RUN-4 | 쓰기 도중 프로세스 종료 모사 | 이전 내용이 온전. 부분 기록 없음 |
| TC-RUN-3 | FR-RUN-4 | 손상된 `runs.json` 으로 부팅 | 빈 목록으로 시작, 경고 1줄, 부팅 성공 |
| TC-RUN-4 | FR-RUN-5 | `state=open` + 다른 epoch 로 로드 | `aborted`, `abortReason=daemon-restart` |
| TC-RUN-5 | FR-RUN-6 | 멤버 도구를 죽인 뒤 `run status` | 그 멤버가 `lost` |
| TC-RUN-6 | FR-RUN-7 | Run 생성 후 워크스페이스 판독 | 멤버 도구에 `runId`, 전용 창에 `ownerRunId` |
| TC-RUN-7 | FR-RUN-7/NFR-RUN-3 | `runId` 없는 기존 데이터 | 전 기능 정상 (TC-EM-10 회귀) |
| TC-RUN-8 | FR-RUN-10 | 사용자 창·탭이 있는 상태에서 `run close` | 사용자 자원 무변경 |
| TC-RUN-9 | FR-RUN-9 | Run 경로의 생성 명령 전수 | `location` 없는 호출 0건 |
| TC-RUN-10 | FR-RUN-11 | 미보고 멤버가 있는 Run 을 `close` | 거부 + 목록. `--force` 로만 진행 |
| TC-STA-1 | FR-STA-1 | 훅 보고 후 `dmctl status --at <uuid>` | 그 상태·tool·detail |
| TC-STA-2 | FR-STA-1 | 활동 보고 없는 도구 | `state=unknown`, rc=0 |
| TC-STA-3 | FR-STA-2/4 | `working` → `idle` 전이 중 `wait --for ready` | 전이 시점에 rc=0 |
| TC-STA-4 | FR-STA-5 | 훅 상태 `waiting` 에서 `wait --for ready` | 즉시 rc=5(blocked), 대기하지 않음 |
| TC-STA-5 | FR-STA-6/7 | 상태 불변인 채 타임아웃 | rc=4 + 마지막 상태·마지막 출력 시각 |
| TC-STA-6 | FR-STA-4 | 훅 없는 에이전트, 출력 3초 정적 | ready 판정 |
| TC-STA-7 | FR-STA-3 | 대기 중 서버 요청 수 계측 | 폴링 루프 없음 (요청 1건) |
| TC-STA-8 | FR-STA-8 | direct·daemon 두 모드 | 동일 결과 |
| TC-ADP-1 | FR-ADP-2 | 기존 훅 이벤트 전수 | `parseClaudeHook`/`parseCodexHook` 회귀 0 (기존 테스트 보존) |
| TC-ADP-2 | FR-ADP-3 | 알 수 없는 에이전트 id | 명확한 오류, rc≠0 (훅 경로만 rc=0 + stderr — FR-ADP-3 주석) |
| TC-ADP-3 | FR-ADP-5 | Claude 멤버 기동 후 `~/.claude` 비교 | 사용자 영구 설정 무변경 |
| TC-ADP-4 | FR-ADP-1 | 레지스트리의 `policyInjection` ↔ 설치된 셸 래퍼 대조 | 선언과 실제 주입기가 일치. 어긋나면 실패 |
| TC-ADP-5 | FR-ADP-1 | 멤버 기동줄 생성 | `dmctl` 만 사전 허용. 전면 우회 플래그 0건 |
| TC-ADP-6 | FR-ADP-1 | 가변 인자 플래그 + 위치 인자 프롬프트 | 프롬프트 바로 앞에 구분자. 프롬프트가 먹히지 않음 |
| TC-STA-9 | FR-STA-4b | 훅 기반 멤버가 `state=unknown` + 3초 정적 | ready 로 판정하지 **않는다**. 훅 없는 에이전트는 종전대로 ready |
| TC-WKT-1 | FR-WKT-2 | `isolation=per-member` 로 Run 시작 | worktree N개. `git config branch.<b>.base` 기록. upstream 없음 |
| TC-WKT-2 | FR-WKT-3/4 | 같은 role 로 두 번째 Run | 경로가 다르다 (uuid 파생) |
| TC-WKT-3 | FR-WKT-6 | 브랜치명 `-x` | 거부 |
| TC-WKT-4 | FR-WKT-8 | clean 상태로 `run close` | worktree 제거, 브랜치 `-d` |
| TC-WKT-5 | FR-WKT-8 | **dirty** 상태로 `run close` | 제거하지 않음 + 보고. 파일 보존 |
| TC-WKT-6 | FR-WKT-9 | 등록되지 않은 worktree 존재 | 건드리지 않음 |
| TC-WKT-7 | FR-WKT-10 | 저장소 자신·루트·`..` 경로 | 전부 거부 |
| TC-WKT-8 | FR-WKT-11 | 비git 디렉터리에서 격리 Run | 명확한 실패. `none` 으로 낮추지 않음 |
| TC-WKT-9 | FR-WKT-7 | 동시 멤버 생성 | worktree 조작이 직렬화됨 |
| TC-WKT-10 | FR-WKT-4 | 연속 생성한 식별자 16개의 경로 조각 | 전부 다르다 (short 로는 겹친다 — FR-WKT-3 주석) |
| TC-WKT-11 | FR-WKT-11 | 격리 Run 시작 시 `cwd` 미제공 | 거부. 서버 cwd 로 추측하지 않는다 |
| TC-WKT-12 | FR-WKT-2/8/12 | 라이브 서버에서 격리 Run 한 바퀴 | 트리 생성 → 프리앰블 → close 정리. dirty 는 보존 + 잔여물 |
| TC-PRE-1 | FR-PRE-5 | 다른 도구가 남의 memberId 로 보고 | `sender_not_member` 거부 |
| TC-PRE-2 | FR-PRE-7 | 같은 멤버가 두 번 보고 | 두 번째 `member_already_reported` |
| TC-PRE-3 | FR-PRE-3 | 보고 시 `--outcome` 누락 | 사용법 오류(rc=2) |
| TC-PRE-4 | FR-PRE-1/4 | 격리 Run 의 프리앰블 | worktree 경로·base 포함 |
| TC-PRE-5 | FR-PRE-1 | 같은 멤버의 프리앰블 재조회 | 생성 시점과 **같은 텍스트**. brief 영속이 근거 |
| TC-PRE-6 | FR-PRE-2 | 프리앰블의 모든 `dmctl` 예제 | 각 예제 **바로 윗줄**이 규칙 주석 |
| TC-PRE-7 | FR-PRE-1 | 셸 메타문자를 담은 brief 로 기동줄 생성 | 셸이 프롬프트를 인자 1개로 파싱. 전개·실행 0건 |
| TC-SKL-1 | FR-SKL-1 | `team` 실행 중 사용자 창 관찰 | 포커스·레이아웃 무변경. **브라우저에서** 활성 창을 읽어 단정한다 — 포커스는 클라이언트 상태라 워크스페이스 JSON 으로는 관측되지 않는다 |
| TC-SKL-2 | FR-SKL-2 | 스킬 본문 검색 | `╭─`·`Thinking...`·`[대기]` fingerprint 0건. 수동 grep 이 아니라 `internal/runtime` 의 테스트가 임베드 트리를 검사한다 |
| TC-SKL-3 | FR-SKL-3 | 팀 구성 후 새 세션에서 `run status` | 멤버 전원 조회 가능 |
| TC-SKL-4 | FR-SKL-5 | 스킬 본문의 에이전트 기동줄 | 손으로 조립한 `claude ...` 0건 — 어댑터 선언(권한 사전 허용·인자 구분자)을 우회하면 조용히 깨진다 |

### 4.2 완료 조건 (DoD)

- `go build ./...` · `go vet ./...` · `go test ./... -count=1` 전부 통과, `gofmt -l` 0건
- `npx playwright test` 가 **기준선 대비** 회귀 0. 기준선도 반복 실행해 대조한다
  (단일 실행은 플레이키 판정의 근거가 되지 않는다)
- 신규 동작은 **RED 를 먼저 확인**한 뒤 구현한다
- `grep -rn "Thinking\.\.\." internal/runtime/agentplugin/skills/` 가 0건 (FR-SKL-2)
- Run 을 쓰지 않는 경로의 동작이 전후로 동일 (NFR-RUN-1)

### 4.3 검증 시 지킬 규약

- **서버 관측을 클라이언트 상태 단정의 배리어로 쓰지 않는다.** 브라우저 트리를 단정할
  거면 브라우저를 폴링한다 (트랙 4 0단계에서 이 계열이 3건 나왔다)
- worktree 테스트는 **격리된 임시 저장소**에서 한다. 운영 저장소·사용자 홈을 대상으로
  하지 않는다 (`USER_CHECKLIST_FIXES_HANDOFF` §4 함정 1~3)
- e2e 이상 시 코드보다 PTY 를 먼저 본다:
  `ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l` (상한 511)
- `web/js/` 는 Serena 로 편집할 수 없다 (함정 12). 정밀 텍스트 편집으로 간다

---

## 5. 비목표 (Non-goals)

| 항목 | 근거 |
|---|---|
| fan-out 결과의 **자동 비교·병합** | 참조 구현에도 없다. `merge_ready` 는 무동작 알림이고 병합 판단은 사람이 한다 (§2.5). 넣으면 참조 대상보다 앞서가는 것이며 별건이다 |
| diff 인라인 주석 리뷰 왕복 | 위와 같은 이유로 이번 범위 밖. 채택한다면 포맷 계약은 이미 조사돼 있다 (`ORCHESTRATOR_RESEARCH_NOTES` §3) — 전송 수단은 `send-input` 으로 이미 충분하다 |
| Run **재개**(resume) | D-C. 에이전트 재기동과 대화 이력 복원까지 설계해야 하고, 백그라운드 도구는 재기동을 넘지 못한다(FR-BG-9). 참조 구현 둘 다 이 수준을 하지 않는다 |
| Task DAG · 의존성 · 결정 게이트 | 조정은 에이전트가 한다(DC-RUN-1). 서버에 DAG 를 넣으면 은퇴한 스케줄러를 되살리는 것이다 |
| 원격·다중 호스트 페더레이션 | 단일 호스트 범위. 참조 구현의 `--on <env>` 대응물은 만들지 않는다 |
| Claude 외 에이전트의 **검증** | D-D. 선언은 확장 가능하되 품질 보증은 Claude Code 로 한정 |
| GitHub·Linear 태스크 연동 | 착수 경로는 별건 |
| 워크스페이스 PUT 의 last-write-wins | 여전히 미해소. 오케스트레이터 경로는 FR-SXE-\* 가 덮는다 (WORKSPACE_IDENTITY_SRS §5) |
| 사용자 영구 설정에 훅 설치 | FR-ADP-5. 세션 스코프 주입을 유지한다 |
| 활동 패널의 Run별 그룹화 | UI 작업. 접합 필드가 채워지면 후속으로 가능해진다 |

---

## 6. 기존 요구사항 개정 (Amendments)

`반영` 열은 **해당 문서에 실제로 문장이 들어갔는지**다. 지시만 있고 적용되지 않은
개정을 남기지 않기 위해 상태를 함께 적는다.

| 문서 | 개정 | 반영 |
|---|---|---|
| `SKILL_INJECTION_SRS.md` §5 | 비목표 3건(에이전트 어댑터 레지스트리 · worktree 격리 · 태스크/Run 레코드)이 본 SRS 로 이관된다 | ✅ 셋 다 **해소** (worktree 는 묶음 W) |
| `SKILL_INJECTION_SRS.md` FR-SK-3 · §2.7 | `build_prompt.py` 가 묶음 K 에서 삭제됐다 (`dmctl run launch` 가 대체) | ✅ |
| `ENTITY_MODEL_RESTRUCTURE_SRS.md` FR-EM-18 | "이 필드를 읽는 동작을 추가하지 않는다"는 **해제**된다. 단 "없거나 비어 있어도 정상"은 NFR-RUN-3 으로 **유지** | ✅ |
| `ENTITY_MODEL_RESTRUCTURE_SRS.md` §7 | Orca 대비표의 "fan-out → **비교** → 병합"과 "MIT 공개 소스"는 부정확하다. §2.5 가 정정한다 | ✅ |
| `ENTITY_MODEL_HANDOFF.md` §4.3 | 같은 정정 (paseo 는 AGPL) | ✅ |
| `WORKSPACE_IDENTITY_SRS.md` FR-UNI-15 · §5 | Run·Member id 의 **생성 주체·수명·영속 범위**를 본 SRS 가 확정한다 (FR-RUN-1/2/3). `runs.json` 소비자 0 서술도 해소된다 | ✅ |
| `archive/DONGMINAL_WORKFLOW_SKILL_SRS.md` | `session: dedicated` 창 모드가 Run `projection` 으로 흡수된다 (FR-SKL-4). 절대 원칙이 3개로 줄고 실행 엔진 스크립트가 삭제됐다 | ✅ |
| `archive/UUID_IDENTITY_SRS.md` | 스킬 경로가 세션 스코프 플러그인으로 이동하고 `build_prompt.py` 가 삭제됐다 | ✅ |
| `archive/AGENT_ACTIVITY_PANEL_SRS.md` | 활동 상태에 **에이전트 소비자**가 생긴다. 수집·저장 요구는 불변이고 조회 경로만 추가된다 (FR-STA-1) | ✅ |
| `archive/PANE_ATTENTION_NOTIFY_SRS.md` | 알림 훅의 선언이 `internal/agentadapter` 의 `policyInjection` 으로 이동한다 (FR-ADP-1). 설치 방식·경로는 불변 | ✅ |
| `docs/internal/architecture.md` | Run 런타임·`runs.json`·어댑터 레지스트리·멤버 프리앰블·스킬 절 신설 | ✅ |

---

## 7. 착수 전 결정과 변경 기록

### 7.1 결정 (2026-08-25, 사용자 확정)

| ID | 결정 | 확정 | 근거 |
|---|---|---|---|
| D-A | worktree 격리 범위 | **Run 단위 선택, 기본 `none`** | 참조 구현 둘 다 격리를 명시적 선택으로 두고 기본은 현재 작업 공간이다. "병렬·편의"는 격리 사유가 아니며, 신뢰 채널 협업 토폴로지 일부는 파일 공유를 전제한다 (FR-WKT-1) |
| ~~D-B~~ | 식별자 계약 | **이전 세션에서 해소** | FR-UNI-1·FR-UNI-15·FR-SXE-8. 본 SRS 는 FR-RUN-9·DC-RUN-2/3 으로 승계만 한다 |
| D-C | Run 레코드 영속 범위 | **`runs.json` 영속 + 재기동 시 펜싱. 재개는 비목표** | 기록이 없으면 컨텍스트 압축·턴 유실 후 팀 정리가 불가능하다. 되살릴 실체는 없다(FR-BG-9) → epoch 로 펜싱한다 (FR-RUN-3/5) |
| D-D | 에이전트 범위 | **Claude Code 만 검증, 레지스트리는 확장 가능** | codex 의 notify 는 `agent-turn-complete` 하나뿐이라 활동 해상도가 근본적으로 다르다. 참조 구현도 기동·탐지는 선언, 훅 설치는 벤더별 코드다 (FR-ADP-1/4) |
| D-E | 준비완료·완료 판정 | **훅 상태 = 생존, 명시 보고 = 권위** | 화면 스크래핑은 `waiting`(권한 대기)을 준비완료로 오인한다. 재료(훅 상태)는 이미 있고 조회 경로만 없었다. 보고 권한은 발신자 정체로 판정한다 — 페이로드를 아는 것은 권한이 아니다 (FR-STA-4/5, FR-PRE-5) |

### 7.2 변경 기록 (Change log)

| 일자 | 내용 |
|---|---|
| 2026-08-25 | 최초 작성. 1단계 심화 조사(orca MIT / paseo AGPL 실소스) 결과를 §2.5 에 반영, 착수 전 결정 D-A·D-C·D-D 확정 및 D-E 신설. 구현 미착수 |
| 2026-08-25 | **묶음 R 구현 완료** — `internal/run` 저장소(`runs.json` 원자적 쓰기·epoch 펜싱·1:1 도구 결속·보고 권한·close 가드) + `/api/runs*` 5개 + `dmctl run start\|member\|report\|status\|close\|list`. FR-PRE-5/6/7(발신자 정체 기반 보고 권한·열거된 거부 사유·1회 보고)은 저장소와 분리할 수 없어 **묶음 P 보다 먼저** 여기서 닫혔다. FR-RUN-11a 로 close 의 도구 종료 책임을 조정자에게 옮겼다(위 개정 근거). FR-RUN-7 의 워크스페이스 표식은 **best-effort** 다 — 그 파일의 쓰기 주체는 브라우저이고 409 처리가 머지 없이 재PUT 이라(§2.4) 동시 편집에 지워질 수 있다. 소유권의 진실은 `runs.json` 이다(FR-RUN-10). Go 전량 통과, Playwright 182 통과 |
| 2026-08-25 | **묶음 K 구현 완료** (`b3dc910`) — `team`·`workflow` 스킬을 Run 기반 전용 창 토폴로지로 재작성. `scripts/build_prompt.py` 와 `references/prompt.md` 삭제(`dmctl run launch` 가 대체), 화면 fingerprint·`sleep` 재확인 루프 전량 제거, 매핑표를 `dmctl run status` 로 이관. 절대 원칙이 4개에서 3개로 줄었다 — 전용 창이 기본이 되면서 포커스 방어 규칙 대부분이 **구조로 풀렸기** 때문이다. 정의서 형식과 렌더러 기본값은 건드리지 않았다(FR-SKL-4 주석). 검증은 세 층이다: `internal/runtime` 의 스킬 계약 테스트(fingerprint·삭제 자산 참조·손조립 기동줄·필수 절차 존재)와 e2e(TC-SKL-1/3), 그리고 실제 팀 1회. **검출기가 실제로 무는지 반증으로 확인했다** — fingerprint 주입 시 실패, `keepFocus` 제거 시 실패. e2e 를 쓰다 밟은 것: `/api/commands` 는 `{action, args:{…}}` 를 받는데 평평하게 보내면 `keepFocus` 가 조용히 유실돼 전용 창이 사용자 화면을 차지한다. Go 전량 통과, Playwright 184 통과 2회 |
| 2026-08-25 | **§6 개정 전량 반영.** 지시만 있고 적용되지 않은 개정이 남지 않도록 대상 문서에 실제로 문장을 넣고, §6 표에 `반영` 열을 두어 상태를 명시했다 — `SKILL_INJECTION_SRS`(비목표 3건의 현재 상태 + `build_prompt.py` 삭제), `ENTITY_MODEL_RESTRUCTURE_SRS` FR-EM-18(읽기 금지 해제, NFR-RUN-3 유지), `WORKSPACE_IDENTITY_SRS` §5(`runs.json` 소비자 0 해소), archive 4건(`DONGMINAL_WORKFLOW_SKILL_SRS`·`UUID_IDENTITY_SRS`·`AGENT_ACTIVITY_PANEL_SRS`·`PANE_ATTENTION_NOTIFY_SRS`). 삭제된 자산(`build_prompt.py`·`references/prompt.md`)을 가리키는 문서는 전부 바로 옆에 후속 표식을 갖는다 |
| 2026-08-25 | **묶음 P+A 구현 완료** — `internal/agentadapter` 신설(claude·codex 선언 + 훅 파서 + `LaunchLine`), `internal/run/preamble.go`(서버 조립), `GET /api/runs/preamble`, `dmctl run launch` / `run member --brief`. 착수 전 열려 있던 **프리앰블 조립 주체는 서버로 확정**했다(FR-PRE-1 주석에 근거 3개). 훅 파서 이동은 무동작 리팩터이며, 회귀 검출기인 `dmctl_activity_test.go` 를 **한 줄도 고치지 않고** 통과시키기 위해 옛 이름을 `_test.go` 스코프에서만 별칭으로 유지했다 — 프로덕션에 죽은 코드가 남지 않는다. `--brief` 를 Member 에 영속시켜 프리앰블을 **재조회 가능**하게 만들었다. 프롬프트 이스케이프를 큰따옴표+역슬래시에서 **홑따옴표 감싸기**로 바꿨고, 악성 brief(`$(...)`·백틱·`;`)로 실측해 셸이 인자 1개로 파싱하고 전개가 0건임을 확인했다. **FR-STA-4 2단계는 스펙에 남기고 구현만 보류**했다(사용자 확정) — 화면 패턴은 스테이터스라인 하나로 깨지며 FR-SKL-2 가 삭제하려는 fingerprint 와 같은 취약성이고, codex 패턴을 실측할 수 없어 추측을 코드에 넣지 않았다. Go 전량 통과, Playwright 183 통과 |
| 2026-08-25 | **묶음 W 구현 완료** — `internal/worktree`(생성·제거·안전 가드·직렬화) + 서버 접합(`provisionRun`/`provisionMember`/`cleanupWorktrees`) + `dmctl run start --isolation\|--base` · `run close --keep-worktrees` + 스킬 §3.5. TC-WKT-1~9 를 RED 로 세운 뒤 구현했고, 파괴적 동작의 검출기 셋(dirty 보존·직렬화·격리 규칙)은 **반증으로 물리는지 확인했다** — `--force` 로 바꾸면 실패, 잠금을 빼면 실패, 스킬의 "격리 사유가 아니다"를 뒤집으면 실패. 구현 중 드러난 것: (1) **`short` 는 유일하지 않다** — uuid v7 의 앞 8자는 타임스탬프 상위 비트라 같은 기간의 Run 이 전부 겹친다. FR-WKT-3 을 `PathSlug`(앞 8 + 뒤 8)로 개정했고 회귀 테스트를 붙였다. (2) 격리 준비는 **레코드보다 먼저**여야 한다 — 경로가 uuid 파생이므로 id 를 먼저 정하고(`StartOptions.ID`/`MemberSpec.ID`), 생성이 실패하면 레코드가 아예 없어야 고아가 남지 않는다. (3) 정리 결과를 레코드에 영속해 `run status` 가 잔여물을 계속 말하게 했다. Go 전량 통과, Playwright 187 통과 2회 |
| 2026-08-25 | **묶음 S 구현 완료** — `GET /api/tools/activity/{get,wait}` + `dmctl status` / `dmctl wait`. TC-STA-1~8 을 RED 로 세운 뒤 구현했고, e2e `skill-contract.spec.ts` 에 라이브 왕복 3건을 추가했다 (Go 전량 통과, Playwright 180 통과 2회 연속). FR-STA-4 2단계는 묶음 A 대기. 구현 중 발견해 고친 것: daemon 모드에서 liveness 확인이 데몬 RPC 라 매 tick 확인하면 30분 대기가 RPC 수만 건이 된다 → 상태 재평가 100ms / liveness 1초로 분리 (NFR-RUN-4) |
