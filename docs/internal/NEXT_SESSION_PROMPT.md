# 다음 세션 프롬프트

아래 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 상태 |
|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| ~~2. MCP 폐지 → 세션 스코프 스킬 주입~~ | **완료** — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| ~~3. 상태바 지표 재설계~~ | **완료** — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| ~~4-a. 오케스트레이터 — 알려진 결함·식별자 통일~~ | **완료** — 0단계 `0ec8e02`, 0.5단계 `835a662`, 마이그레이션 `f7580a7` ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| ~~4-b. 오케스트레이터 — 심화 조사·설계~~ | **완료** — [RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md) (IEEE 29148) + [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md). 착수 전 결정 5건 확정 |
| **4-c. 오케스트레이터 — 구현** | **미착수.** 아래 프롬프트 |

---

## 트랙 4-c — Run 오케스트레이션 구현

```
이 프롬프트는 `docs/internal/NEXT_SESSION_PROMPT.md` 의 코드블록이다. 파일을 직접
읽었다면 같은 파일 끝의 "별건 — 아직 남은 것" 표도 함께 보라 (이번 트랙 범위는 아니지만
건드리면 안 되는 것들이 있다).

`RUN_ORCHESTRATION_SRS` 를 구현한다. **스펙은 이미 있다 — 다시 설계하지 마라.**
조사도 끝났다. 이번 세션은 스펙 → 테스트 → 코드다.

**먼저 이 순서로 읽어라.** (개발자 문서 색인은 `docs/internal/README.md`. 완료된 과거
SRS·RFC 는 `docs/internal/archive/` 에 있고 갱신하지 않는다.)

1. `docs/internal/RUN_ORCHESTRATION_SRS.md` — **단일 진실 공급원.** §3 이 요구, §4 가
   검증, §5 가 비목표, §7.1 이 확정된 결정 5건이다
2. `docs/internal/ORCHESTRATOR_RESEARCH_NOTES.md` — 위 SRS 의 근거. orca(MIT)·
   paseo(AGPL) 실소스 조사. **§9 는 기존 문서 서술을 뒤집은 5건**이다. 구현 중
   "참조 구현은 어떻게 하지?" 가 나오면 여기부터 본다. 소스를 다시 클론할 필요는 없다
3. `docs/internal/SKILL_INJECTION_SRS.md` §2.3~§2.5 — 액션/정책 계층 경계와 `dmctl`
   대체 매핑. 새로 추가하는 명령도 같은 규약을 따른다
4. `docs/internal/WORKSPACE_IDENTITY_SRS.md` §3.3·§3.4 — 오케스트레이터가 전제할
   식별자 계약 (FR-SXE-8: **항상 `location` 을 명시한다**, FR-UNI-15: Run·Member id 는 uuid)
5. `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` §4 — 함정 15개. 특히 1~3(격리 홈·
   바이너리 재사용·운영 인스턴스), 12(Serena 가 `web/js/` 를 편집할 수 없다),
   14(레이아웃 가설은 측정으로)

**현재 상태 (2026-08-25)**

- HEAD `f7580a7`. `go build`·`go vet`·`go test ./...`·`gofmt -l` 전부 깨끗
- Playwright **177 통과 / 0 실패** (2회 연속 재현) — 트랙 4-a 시점 기준선
- 에이전트 접합면은 MCP 가 아니다. **액션 = `dmctl` 서브커맨드, 정책 = 세션 스코프로
  주입되는 스킬**이다. 스킬은 `internal/runtime/agentplugin/skills/{team,workflow}` 에
  있고 `go:embed` 로 바이너리에 들어간다. 호출명은 `/dongminal:team`·`/dongminal:workflow`
- 생성 명령(`newTab`/`newWindow`/`splitH`/`splitV`/`openEditorTab`/`restoreTool`)은
  서버가 지명한 **단일 실행자**만 수행한다 (`execClientId`)
- **식별자는 이제 전부 uuid 다.** 묶음 M(`f7580a7`)이 사용자 인스턴스를 재작성했고
  실측으로 확인됐다 — `~/.dongminal/{workspace,tools}.json` 전부 uuid v7,
  `dmctl who-am-i` 도 `uuid=01a0361e-…  toolId=01a0361e-…`. `*.preuuid.bak` 이 백업이다.
  **이전 프롬프트의 "구 id 혼재가 정상" 서술은 이제 낡았다.** 다만 코드의 보존 규약
  (FR-WID-2·FR-UNI-9)은 그대로 유효하다 — 구 id 를 만나면 여전히 받아들여야 한다
- 사용자 인스턴스는 v2 다. **직접 마이그레이션하거나 재기동하지 마라**

**구현 순서 (권장)**

의존과 리스크 순이다. 각 묶음은 그 자체로 커밋 가능해야 한다.

| 순서 | 묶음 | 왜 여기 |
|---|---|---|
| 1 | **S — 상태·대기** (`dmctl status`/`wait`, long-poll) | 독립적이고, 스킬의 최대 취약점(화면 스크래핑 Barrier)을 즉시 제거한다. 재료는 이미 서버에 있다 (`AttnTracker`) |
| 2 | **R — Run 레코드** (`runs.json`·epoch·`dmctl run`) | 독립적. 이후 묶음 전부의 토대 |
| 3 | **P — 프리앰블·보고** | R 의존. **발신자 정체 기반 권한**(FR-PRE-5)이 핵심이며 여기서만 닫힌다 |
| 4 | **A — 어댑터 레지스트리** | 무동작 리팩터(기존 훅 파서 테스트가 회귀 검출기다) + S 의 2단계 폴백 선언을 채운다 |
| 5 | **W — worktree 격리** | R 의존. **리스크 최대** — 파일시스템 파괴 경로다. FR-WKT-8/9/10 을 먼저 테스트로 못박아라 |
| 6 | **K — 스킬 재작성** | 전부 의존. 접합면·스킬·프론트엔드를 만지므로 `npx playwright test` 필수 |

**작업 규약**

- 신규 동작은 **RED 를 먼저 확인**한다. 스펙에 TC 표가 있으니 거기서 시작하라 (§4.1)
- **Go 테스트만으로 끝내지 마라.** 트랙 2 에서 `go test` 는 전량 통과했는데
  `e2e/skill-contract.spec.ts` 가 전량 깨져 있었다. 묶음 K 는 물론이고 접합면(S·P)을
  만졌으면 `npx playwright test` 를 돌려라
- **플레이키 판정에 단일 실행은 근거가 안 된다.** 기준선도 반복 실행해 대조하라
- **서버 관측을 클라이언트 상태 단정의 배리어로 쓰지 마라.** 브라우저 트리를 단정할
  거면 브라우저를 폴링하라 (0단계에서만 이 계열이 3건 나왔다)
- **worktree 테스트는 격리된 임시 저장소에서 한다.** 운영 저장소·사용자 홈·루트
  `./dongminal` 바이너리를 대상으로 하지 마라 (함정 1~3). `FR-WKT-10` 의 위험 경로
  거부를 구현보다 먼저 테스트로 세워라
- 일괄 정규식 치환 전에 함정 1~4 를 다시 읽어라. 스키마 값·와이어 키·마이그레이션
  코드·TS 타입 주석이 매번 침범당했다
- 심볼 작업은 LSP → Serena → CLI 순. `gopls` 가 PATH 에 없으면
  `ln -sf ~/go/bin/gopls ~/.local/bin/gopls`. `web/js/` 는 Serena 불가 (함정 12)
- 커밋은 사용자 확인 후에만. 커밋 메시지에 AI 서명 금지
- e2e 결과가 이상하면 코드를 의심하기 전에 PTY 를 확인하라:
  `ps -eo tty | awk '$1 ~ /^ttys/' | sort -u | wc -l` (상한 511)
- **paseo 코드를 옮기지 마라** — AGPL-3.0-or-later 다 (DC-RUN-5). orca 는 MIT 지만
  이번 구현은 설계 아이디어만 가져오고 코드는 새로 쓴다

**스펙에서 특히 놓치기 쉬운 것**

- `waiting`(권한 확인 대기)은 **준비완료가 아니다.** `wait` 은 즉시 `blocked`(rc=5)로
  반환하고 대기를 계속하지 않는다 (FR-STA-5)
- **타임아웃은 실패가 아니다** (FR-STA-6). 타임아웃만을 근거로 멤버를 종료·재기동하는
  코드를 쓰지 마라
- 보고 권한은 **발신자의 정체**로 판정한다. 본문의 `runId`/`memberId` 를 아는 것은
  권한이 아니다 (FR-PRE-5). 거부 사유는 타입으로 열거한다 (FR-PRE-6)
- **dirty worktree 는 지우지 않는다** (FR-WKT-8). 사용자 작업의 조용한 삭제 금지
- worktree 경로를 **재사용하지 않는다** — 에이전트 CLI 가 cwd 로 대화 이력을 키잉하므로
  재사용은 남의 이력을 물려주는 것이다 (FR-WKT-4)
- `Tool.runId`/`Window.ownerRunId` 는 **비어 있어도 전 기능 정상**이어야 한다
  (NFR-RUN-3). FR-EM-18 의 "읽지 않는다"만 해제된 것이다
- 서버를 **스케줄러로 만들지 마라** (DC-RUN-1). Run 은 기록·조회이고 조정은 에이전트가 한다

**참고 — 이미 쓸 수 있는 접합면**

  dmctl read-screen / read-output --at <uuid> [--bytes N]
  dmctl send-input --at <uuid> [--execute] (본문은 stdin 가능)
  dmctl msg --to <uuid>            # --from 은 자동. 신뢰 엔벨로프
  dmctl open-editor --at <uuid> <파일>
  dmctl agent-context              # 세션 상시 주입 컨텍스트 (SessionStart 훅)

생성 명령(`split-*`/`new-tab`/`new-window`)의 응답에는 `newTabs`/`newPanes`/
`newWindows` 로 새 엔터티 id 가 들어 있다 — 목록 재조회가 필요 없다.
서버측 활동 상태는 `GET /api/tools/activity` 와 SSE `tool_activity` 에 이미 있다.
`dmctl` 쪽 조회 경로가 없을 뿐이며 그것이 묶음 S 다.
```

---

## 별건 — 아직 남은 것

| 항목 | 상태 |
|---|---|
| ~~사용자 인스턴스 v1 → v2 마이그레이션~~ | **완료** (2026-08-24). `.v1.bak` 3개 + `panes.json`→`tools.json` |
| ~~구 식별자 재작성~~ | **완료** (2026-08-25, `f7580a7`). `*.preuuid.bak` 백업. 사용자 홈은 전부 uuid v7 |
| 워크스페이스 PUT 의 last-write-wins | 미해소. 사람 둘이 각자 브라우저에서 동시 편집할 때만 남는다. `WORKSPACE_IDENTITY_SRS` §2.4·§5 |
| ~~`~/.dongminal/runs.json`~~ | **소비자가 생겼다** — `RUN_ORCHESTRATION_SRS` 묶음 R 이 이 파일을 쓴다. 기존 프로토타입 필드는 보존한다 |
| 도구 표시명이 전부 `Shell` | FR-UNI-8 의 의도된 결과다. 구분은 좌표와 cwd 가 담당한다. 불편하면 rename UX 보강이 후속 후보 |
| `~/.dongminal/panels.json` | v1 시절 도구 기록. 소비자 없음. 삭제 여부 미정 |
| iOS 실기기 확인 (트랙 1 묶음 F) | 사용자 수동 확인 대기 (`test-checklist.md` C11.8~C11.10) |
| `SYSTEM_STATS_SRS` V-5·V-9 | 수동 확인 대기 (Activity Monitor 대조 / 브라우저 네트워크 탭) |
| `CLIENT_ATTACH_SRS` | 미착수 (ENTITY_MODEL SRS §7 후속) |
| fan-out 결과 자동 비교·병합 / diff 인라인 주석 리뷰 | **별건으로 확정.** 참조 구현에도 없다 — `RUN_ORCHESTRATION_SRS` §5 |
| 저장소에 `LICENSE` 없음 | orca(MIT) 코드를 실제로 차용한다면 고지 의무가 생긴다. 현재는 차용하지 않는 것으로 정리 (DC-RUN-5) |
