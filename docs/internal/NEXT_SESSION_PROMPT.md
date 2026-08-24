# 다음 세션 프롬프트

아래 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 상태 |
|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| ~~2. MCP 폐지 → 세션 스코프 스킬 주입~~ | **완료** — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| ~~3. 상태바 지표 재설계~~ | **완료** — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| **4. AI 오케스트레이터 — 연구·설계** | **진행 중.** 0단계(알려진 결함 2건) **완료** — `0ec8e02` ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md), FR-BGR-7). 다음은 **1단계(심화 조사)** 부터. 아래 프롬프트 |

---

## 트랙 4 — AI 오케스트레이터 연구·설계

```
이 프롬프트는 `docs/internal/NEXT_SESSION_PROMPT.md` 의 코드블록이다. 파일을 직접
읽었다면 같은 파일 끝의 "별건 — 아직 남은 것" 표도 함께 보라 (이번 트랙 범위는 아니지만
건드리면 안 되는 것들이 있다).

dongminal 을 다중 에이전트 오케스트레이터로 만드는 작업의 **심화 연구와 설계**를
진행한다.

**0단계(알려진 결함 2건)는 이전 세션에서 닫혔다.** 결론은 아래 "0단계 — 완료" 절에
있고, 그 결론이 이번 세션의 전제다. 다시 조사하지 마라.

산출물은 하나다.

- **`RUN_ORCHESTRATION_SRS`** (IEEE 29148). 구현은 그 다음이다 — 스펙 없이 구현에
  들어가지 마라

**먼저 이 순서로 읽어라.** (개발자 문서 색인은 `docs/internal/README.md`. 완료된 과거
SRS·RFC 는 `docs/internal/archive/` 에 있고 갱신하지 않는다.)

1. `docs/internal/SKILL_INJECTION_SRS.md` — **가장 최근에 바뀐 접합면.** §2.4 에
   orca/paseo 대비표와 dongminal 이 취한 위치가 있다. §5 비목표 3개가 이번 트랙의
   입력이다
2. `docs/internal/ENTITY_MODEL_HANDOFF.md` — 확정된 엔티티 모델, 함정 7개, 검증 방법
3. `docs/internal/ENTITY_MODEL_RESTRUCTURE_SRS.md` — §7 에 요구 3 의 선행 조사 결론과
   Orca 대비표
4. `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` §4 — 함정 15개. 특히 13(브라우저
   기본값은 바뀐다)·14(레이아웃 가설은 측정으로 확인)·12(Serena 가 `web/js/` 를
   편집할 수 없다)는 묶음에 무관하게 유효하다
5. `docs/internal/WORKSPACE_IDENTITY_SRS.md` — 0단계 0-B 의 산출. **§3.3 FR-SXE-8 이
   오케스트레이터가 전제할 식별자 계약이다** (D-B 의 답). §2.6 에 문서와 어긋났던
   사실 3건이 있다

**현재 상태 (2026-08-24)**

- `go build`·`go vet`·`go test ./...`·`gofmt -l` 전부 깨끗
- Playwright **172 통과 / 0 실패** (2회 연속 재현)
- 에이전트 접합면은 더 이상 MCP 가 아니다. **액션 = `dmctl` 서브커맨드, 정책 = 세션
  스코프로 주입되는 스킬**이다. `internal/mcptool`·`/mcp/*` 는 삭제됐다
- 스킬은 `internal/runtime/agentplugin/skills/{team,workflow}` 에 있고 `go:embed` 로
  바이너리에 들어간다. 호출명은 `/dongminal:team`·`/dongminal:workflow`
- 엔터티 id 는 이제 `crypto.randomUUID()` 다. 생성 명령(`newTab`/`newWindow`/`splitH`/
  `splitV`/`openEditorTab`/`restoreTool`)은 서버가 지명한 **단일 실행자**만 수행한다
  (`execClientId`). 자세한 것은 `WORKSPACE_IDENTITY_SRS.md`
- 사용자 인스턴스(`~/.dongminal`)는 **이미 v2 이고 바이너리도 HEAD 로 재빌드돼 있다**
  (문서의 "v1 미실행" 서술은 낡은 것이었다 — `WORKSPACE_IDENTITY_SRS` §2.6).
  그래도 **직접 마이그레이션하거나 재기동하지 마라**

**이번 세션의 작업 — 순서대로**

### 0단계 — 완료 (이전 세션). 결론만 전제로 삼아라

두 결함 모두 **추정이 아니라 계측으로** 원인을 확정했고, 기존 진단 두 개가 틀렸음이
드러났다. 아래가 사실이다.

#### 0-A. `_restoreTool` — 증상 둘의 원인은 서로 달랐다

| 증상 | 확정된 원인 | 처리 |
|---|---|---|
| ① 조용한 무효 | **제품 결함.** `delWindow` 가 마지막 창을 지운 뒤 `_mkWindow`(PTY 생성 POST)를 `await` 하는 동안 `ws.windows` 가 비어 `_aw()` 가 null 이 된다. 그 순간 `location` 미지정 경로가 `return` 했다. 그 창을 명중시켜 재현 — `백그라운드잔존=true, 트리에존재=false` 인데 응답은 `ok=true` | **FR-BGR-7** — 미지정 경로에 폴백(포커스 → 활성 창 첫 Pane → 아무 창 첫 Pane → 대기 후 재시도). 명시 대상은 폴백하지 않는다(TC-BGR-6b 보존). `TC-BGR-8`·`TC-BGR-9` |
| ② `TC-BGU-9b` | **테스트 결함.** "탭이 엉뚱한 Pane 으로 간다"는 서술은 **틀렸다** — 탭은 항상 포커스 Pane 에 정확히 들어간다. 테스트가 서버 관측(`/api/tools/background`)을 클라이언트 단정의 배리어로 썼고, `_restoreTool` 은 서버 해제를 먼저 `await` 한 뒤 탭을 넣으므로 그 사이 3ms 를 본다. 폴 GET 이 브라우저 POST 에 파이프라인돼 그 창을 **결정적으로** 명중시킨다 | 배리어를 클라이언트 상태로 교체 |

같은 계열의 플레이키를 하나 더 잡았다 — `skill-contract.spec.ts` 의 `restoreTool` 왕복은
**기준선에서 4회 중 3회 실패**했다. `firstTab` 이 창 재생성 전의 `/api/state` 를 읽어 곧
사라질 탭 uuid 를 집었다. 분리한 도구가 트리에서 사라진 스냅샷에서 고르도록 고쳤다.

> **교훈**: 서버 관측은 클라이언트 상태 단정의 배리어가 될 수 없다. 이 계열이 이번에만
> 3건 나왔다. 클라이언트 트리를 단정할 거면 클라이언트를 폴링하라.

`skill-contract.spec.ts` 의 `restoreTool` 은 `location` 명시를 **유지**했다 — 미지정
경로는 `TC-BGR-8/9` 가 직접 덮고, 여기서 검증할 계약은 오케스트레이터가 쓰는 방식이다.

#### 0-B. 식별자 — 재현됐고, 원인은 3층이었다

`WORKSPACE_IDENTITY_SRS.md` 가 단일 진실 공급원이다. 요약:

- 두 클라이언트가 붙은 채 `newTab` **1회** → 둘 다 실행(`delivered=2`), **같은 탭 id
  `t2`**, 도구 1→**3개**(1개 즉시 고아), 응답 `toolId:"2"` 가 수렴값 `3` 과 불일치
- 원인 (i) 카운터가 클라이언트별 상태 (ii) 생성 명령을 **모든 구독 클라이언트가 각자
  실행** (iii) `_save` 409 처리가 머지 없이 재PUT
- **(i)(ii) 는 구현 완료.** id 는 `crypto.randomUUID()`, 생성 명령 6개는 서버가
  `execClientId` 로 지명한 하나만 수행
- **(iii) 는 미해소** — 사람 둘이 각자 브라우저에서 동시에 편집할 때만 남는다.
  오케스트레이터 경로는 (ii)가 덮는다. `WORKSPACE_IDENTITY_SRS` §2.4·§5

부수로 확인된 것: `internal/uuid`(Go v7)는 **저장소 전체 import 0건**인 죽은 패키지다
(제거는 별건). id 는 전 계층에서 opaque 라 마이그레이션이 필요 없었다.

### 1단계. 심화 조사 (연구)

트랙 2 에서 orca·paseo 를 README 수준으로 비교했다. 이번엔 **실제 구현**을 읽는다.
사용자 기존 결정: "Orca 의 장점을 최대한 모방. 동작뿐 아니라 실제 구현(MIT 공개
소스)도 참고."

읽을 대상과 답을 낼 질문:

| 대상 | 답을 낼 질문 |
|---|---|
| orca — worktree 팬아웃 | worktree 생성·정리 시점, 브랜치 네이밍, 부모 저장소와의 관계, 실패 시 잔여물 처리 |
| orca — fan-out→비교→병합 | N개 결과를 무엇으로 비교하게 하는가 (diff? 테스트? 사람?). 병합은 누가 하는가 |
| orca — diff 인라인 주석 리뷰 | 주석을 에이전트에게 어떤 형태로 되돌리는가 (프롬프트 텍스트? 구조화 페이로드?) |
| orca — 에이전트 레지스트리 | 40+ 에이전트를 어떤 메타데이터로 선언하는가 (기동 커맨드·상태 감지·프롬프트 주입) |
| paseo — 태스크/세션 모델 | `run`/`attach`/`send` 의 상태 기계, 완료 판정, 스트리밍 계약 |
| paseo — provider 레지스트리 | `claude/opus-4.6` 문법이 무엇으로 해석되는가 |

**조사에는 실제 소스를 읽어라.** README 요약으로 설계를 세우지 마라 — 트랙 2 에서
paseo 스킬이 내부적으로 MCP 툴을 부른다는 사실이 README 에는 없었고, 그것이 설계
판단을 바꿨다.

### 2단계. dongminal 에 맞는 오케스트레이터 설계

`SKILL_INJECTION_SRS.md` §2.4 가 정리한 dongminal 의 고유 축을 유지해야 한다 —
**에이전트가 사람이 보는 터미널에 상주하고, 접합면이 셸 명령이라 에이전트에 무관하다.**
orca·paseo 를 베끼면서 이 축을 잃으면 안 된다.

메꿔야 할 3가지 (SKILL_INJECTION_SRS §5 의 비목표에서 넘어온 것):

1. **에이전트 어댑터 레지스트리** — 지금은 `parseClaudeHook`/`parseCodexHook` 가
   `internal/runtimebin/dmctl_activity.go` 에 하드코딩돼 있다. 선언화 대상: 기동
   커맨드, 알림 훅 주입 방식, 활동 파서, 정책 주입 방식(Claude 는 `--plugin-dir`,
   codex 는 `-c`/AGENTS.md), 준비완료 감지 패턴(현재 스킬은 `╭─` + `Thinking...`
   부재 + `[대기]` 를 화면에서 찾는다)
2. **worktree 격리** — orca 의 병렬 격리
3. **태스크/Run 레코드** — 지금은 화면 스크래핑이 유일한 상태원이다. 실행 기록·재개가
   불가능하다

**접합면은 이미 있다** — `Tool.runId` / `Window.ownerRunId` / `run.Projection`
(`internal/run/run.go`, ENTITY_MODEL FR-EM-17/18). 이 필드들은 비어 있어도 정상
동작하므로 점진적으로 채울 수 있다.

**스킬 재작성도 이 SRS 범위다.** `skills/team` 은 팀을 별도 공간에 만들지 않고 팀장의
Pane 을 쪼갠다. 그래서 사용자 작업 공간을 침범하고, 그 방어 규칙(`--no-focus` 강제,
`dmctl focus` 전면 금지)이 스킬 문서의 상당 부분을 차지한다. 토폴로지를 재설계하면
그 방어 규칙 자체가 불필요해진다. `workflow` 스킬의 `dedicated` 창 모드가 그 방향의
선행 사례다.

### 3단계. 착수 전 결정 해소

**최소한 아래는 스펙 작성 중 사용자와 해소해야 한다.** 결정 전에 구현하지 마라.

| ID | 결정 | 왜 지금 |
|---|---|---|
| D-A | **worktree 격리 범위** — Run 단위 선택 vs 항상 격리 | 격리는 팀원 간 파일 공유를 차단한다. Run 단위 선택이면 두 실행 모드를 유지해야 하고, 항상 격리면 기존 `team` 스킬의 일부 토폴로지가 성립하지 않는다 |
| ~~D-B~~ | ~~**식별자 계약**~~ | **해소.** `WORKSPACE_IDENTITY_SRS` FR-SXE-8 — 엔터티 id 는 uuid 이고 구 id 도 유효하다. `location` 없는 생성 명령은 **서버가 지명한 실행자의 포커스 Pane** 에 착지하므로 호출자가 통제할 수 없다 → **오케스트레이터는 항상 `location` 을 명시한다.** 이 규약을 `RUN_ORCHESTRATION_SRS` 에 싣는 것만 남았다 |
| D-C | **Run 레코드의 영속 범위** — 메모리만 / `runs.json` / 재개 가능 | 재개 가능이면 에이전트 재기동과 컨텍스트 복원까지 설계해야 한다 |
| D-D | **에이전트 범위** — Claude Code 만인지, codex 까지인지 | 어댑터 레지스트리의 검증 대상 수가 달라진다. 트랙 2 는 Claude Code 만으로 좁혔다 |

**알려진 결함**

0단계에서 닫혔다. 결론은 "0단계 — 완료" 절에 있다.

> `1013f8c` 커밋 메시지는 `TC-BGU-9b` 를 "`restoreTool` 이 `location` 없이 조용히
> 무효가 되는 계열" 로 적었다. **그 진단은 부정확하다** — `TC-BGU-9b` 에서는 백그라운드
> 항목이 정상 해제되고 탭이 엉뚱한 Pane 으로 간다. 같은 함수(`_restoreTool`)에 수렴하지만
> 증상이 다르다. §0-A 의 표가 정확한 서술이다.

**작업 규약**

- 중·대 규모는 스펙 → 테스트 → 코드 순서를 지킨다. 신규 동작은 RED 를 먼저 확인한다
- **Go 테스트만으로 끝내지 마라.** 트랙 2 에서 `go test` 는 전량 통과했는데
  `e2e/skill-contract.spec.ts` 가 전량 깨져 있었다. 접합면·스킬·프론트엔드를 만졌으면
  `npx playwright test` 를 돌려라
- 일괄 정규식 치환 전에 `USER_CHECKLIST_FIXES_HANDOFF.md` §4 의 함정 1~4 를 다시
  읽어라. 스키마 값·와이어 키·마이그레이션 코드·TS 타입 주석이 매번 침범당했다
- **서버 관측을 클라이언트 상태 단정의 배리어로 쓰지 마라.** 0단계에서만 이 계열이
  3건 나왔다(`TC-BGU-9b`, `skill-contract` 왕복, `firstTab`). 브라우저 트리를 단정할
  거면 브라우저를 폴링하라
- **플레이키 판정에 단일 실행은 근거가 안 된다.** `skill-contract` 왕복은 기준선에서
  4회 중 3회 실패했는데 첫 1회가 통과해 "내 회귀" 로 오판할 뻔했다. 기준선도 반복 실행하라
- 심볼 작업은 LSP → Serena → CLI 순. `gopls` 가 PATH 에 없으면
  `ln -sf ~/go/bin/gopls ~/.local/bin/gopls`
- 커밋은 사용자 확인 후에만. 커밋 메시지에 AI 서명 금지
- e2e 결과가 이상하면 코드를 의심하기 전에 PTY 를 확인하라:
  `ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l` (상한 511)
- 부하 실험을 한다면 PID 를 **파일이나 부모 프로세스로 명시 추적**하라. 비대화형
  `zsh -c` 에서 `jobs -p` 는 서브셸 PID 를 돌려주지 않아 고아 busy-loop 를 만든다
  (`SYSTEM_STATS_SRS` §9 의 실제 사고)

**참고 — 이번 트랙에서 새로 쓸 수 있게 된 것**

트랙 2 가 만든 접합면이다. 오케스트레이터가 그대로 쓴다.

  dmctl read-screen / read-output --at <uuid> [--bytes N]
  dmctl send-input --at <uuid> [--execute] (본문은 stdin 가능)
  dmctl msg --to <uuid>            # --from 은 자동. 신뢰 엔벨로프
  dmctl open-editor --at <uuid> <파일>
  dmctl agent-context              # 세션 상시 주입 컨텍스트 (SessionStart 훅)

생성 명령(`split-*`/`new-tab`/`new-window`)의 응답에는 `newTabs`/`newPanes`/
`newWindows` 로 새 엔터티 id 가 들어 있다 — 목록 재조회가 필요 없다.
```

---

## 별건 — 아직 남은 것

| 항목 | 상태 |
|---|---|
| ~~사용자 인스턴스 v1 → v2 마이그레이션~~ | **완료** (2026-08-24 12:24). `.v1.bak` 3개 + `panes.json`→`tools.json` 확인 |
| 워크스페이스 PUT 의 last-write-wins | 미해소. `WORKSPACE_IDENTITY_SRS` §2.4·§5 |
| `~/.dongminal/runs.json` | 커밋된 코드에 소비자가 없는 Run 레코드 프로토타입. D-C 의 입력으로 볼 것 |
| `internal/uuid` (Go v7) | 저장소 전체 import 0건인 죽은 패키지. 제거 여부 미정 |
| ~~`TC-BGU-9b` 기존 실패~~ | **해소** — 제품 결함이 아니라 테스트의 배리어 오용이었다 (0-A ②) |
| iOS 실기기 확인 (트랙 1 묶음 F) | 사용자 수동 확인 대기 (`test-checklist.md` C11.8~C11.10) |
| `SYSTEM_STATS_SRS` V-5·V-9 | 수동 확인 대기 (Activity Monitor 대조 / 브라우저 네트워크 탭) |
| `CLIENT_ATTACH_SRS` | 미착수 (ENTITY_MODEL SRS §7 후속) |
