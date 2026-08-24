# 다음 세션 프롬프트

아래 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 상태 |
|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| ~~2. MCP 폐지 → 세션 스코프 스킬 주입~~ | **완료** — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| ~~3. 상태바 지표 재설계~~ | **완료** — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| **4. AI 오케스트레이터 — 연구·설계** | **진행 대상.** 아래 프롬프트 |

---

## 트랙 4 — AI 오케스트레이터 연구·설계

```
dongminal 을 다중 에이전트 오케스트레이터로 만드는 작업의 **심화 연구와 설계**를
진행한다. 이번 세션의 산출물은 `RUN_ORCHESTRATION_SRS` (IEEE 29148) 이고, 구현은
그 다음이다. 스펙 없이 구현에 들어가지 마라.

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

**현재 상태 (2026-08-24)**

- `go build`·`go vet`·`go test ./...`·`gofmt -l` 전부 깨끗
- Playwright **164 통과 / 1 실패**. 실패는 `background-ui.spec.ts` 의 `TC-BGU-9b`
  이고 **`d531345`(트랙 2·3 착수 이전)에서도 실패하는 기존 결함**이다 — 아래 "알려진
  결함" 2번과 같은 계열이다
- 에이전트 접합면은 더 이상 MCP 가 아니다. **액션 = `dmctl` 서브커맨드, 정책 = 세션
  스코프로 주입되는 스킬**이다. `internal/mcptool`·`/mcp/*` 는 삭제됐다
- 스킬은 `internal/runtime/agentplugin/skills/{team,workflow}` 에 있고 `go:embed` 로
  바이너리에 들어간다. 호출명은 `/dongminal:team`·`/dongminal:workflow`
- 사용자 인스턴스(`~/.dongminal`)는 여전히 **v1 스키마이고 구 바이너리가 돌고 있다**.
  업그레이드 순서는 `ENTITY_MODEL_HANDOFF.md` §4.2 (`./scripts/migrate.sh` 가 진입점).
  **직접 마이그레이션하거나 재기동하지 마라**

**이번 세션의 작업 — 순서대로**

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
| D-B | **식별자 체계** — 아래 "알려진 결함" 1번을 고칠지, 고친다면 이번 범위인지 | Run→Member→Tool 결속이 안정 고유 식별자를 전제한다 |
| D-C | **Run 레코드의 영속 범위** — 메모리만 / `runs.json` / 재개 가능 | 재개 가능이면 에이전트 재기동과 컨텍스트 복원까지 설계해야 한다 |
| D-D | **에이전트 범위** — Claude Code 만인지, codex 까지인지 | 어댑터 레지스트리의 검증 대상 수가 달라진다. 트랙 2 는 Claude Code 만으로 좁혔다 |

**알려진 결함 — 설계 전에 반드시 알아야 하는 2개**

두 건 모두 트랙 2 의 e2e 이관(`1013f8c`) 중 발견됐고, 커밋 메시지에도 기록돼 있다.

1. **"uuid" 는 UUID 가 아니다.** 프론트엔드가 id 를 `s{n}`/`r{n}`/`t{n}` 으로 만들고
   (`web/js/app.js:1127,2517`) 카운터를 로드된 워크스페이스의 최대 숫자에서 seeding
   한다(`126,267,502`). **`internal/uuid` 의 v7 생성기는 비테스트 소비자가 0개다** —
   `archive/UUID_IDENTITY_SRS.md` 는 컬럼명(`uuid=`)과 필드명(`TabUUID`)만 남기고 실제
   id 체계에는 적용되지 않았다. 계약의 실체는 "좌표 라벨이 아니다" 까지이며, 카운터가
   클라이언트별 상태이므로 **두 브라우저가 동시에 탭을 만들면 같은 id 를 낼 수 있다.**
   Run→Member→Tool 결속을 설계할 때 이 전제를 확인하라 (D-B)
2. **`restoreTool` 을 `location` 없이 부르면 조용히 무효가 될 수 있다.** 브라우저의
   포커스된 분할 칸으로 복귀하는데, detach 로 그 분할 칸이 사라졌으면 복귀 대상이
   없다. `TC-BGU-9b` 기존 실패가 이 계열이다. `USER_CHECKLIST_FIXES` 묶음 D 가
   `detach --restore <toolId> --at <uuid>` 를 추가한 이유가 이것이므로, 오케스트레이터가
   Run 멤버의 도구를 다룰 때는 **항상 `location` 을 명시**해야 한다

**작업 규약**

- 중·대 규모는 스펙 → 테스트 → 코드 순서를 지킨다. 신규 동작은 RED 를 먼저 확인한다
- **Go 테스트만으로 끝내지 마라.** 트랙 2 에서 `go test` 는 전량 통과했는데
  `e2e/skill-contract.spec.ts` 가 전량 깨져 있었다. 접합면·스킬·프론트엔드를 만졌으면
  `npx playwright test` 를 돌려라
- 일괄 정규식 치환 전에 `USER_CHECKLIST_FIXES_HANDOFF.md` §4 의 함정 1~4 를 다시
  읽어라. 스키마 값·와이어 키·마이그레이션 코드·TS 타입 주석이 매번 침범당했다
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
| 사용자 인스턴스 v1 → v2 마이그레이션 | 미실행. 순서는 [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) §4.2 |
| `TC-BGU-9b` 기존 실패 | 미해결. 위 "알려진 결함" 2번과 같은 계열 |
| iOS 실기기 확인 (트랙 1 묶음 F) | 사용자 수동 확인 대기 (`test-checklist.md` C11.8~C11.10) |
| `SYSTEM_STATS_SRS` V-5·V-9 | 수동 확인 대기 (Activity Monitor 대조 / 브라우저 네트워크 탭) |
| `CLIENT_ATTACH_SRS` | 미착수 (ENTITY_MODEL SRS §7 후속) |
