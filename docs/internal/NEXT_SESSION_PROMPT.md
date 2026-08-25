# 다음 세션 프롬프트

아래 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 상태 |
|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| ~~2. MCP 폐지 → 세션 스코프 스킬 주입~~ | **완료** — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| ~~3. 상태바 지표 재설계~~ | **완료** — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| ~~4-a. 오케스트레이터 — 결함·식별자 통일~~ | **완료** — `0ec8e02`, `835a662`, `f7580a7` ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| ~~4-b. 오케스트레이터 — 조사·설계~~ | **완료** — `901bd7c` ([RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md), [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md)) |
| **4-c. 오케스트레이터 — 구현** | **진행 중.** 묶음 **S**(`228c464`)·**R**(`a958797`) 완료. 다음은 **P+A**, 이어서 W → K. 아래 프롬프트 |

---

## 트랙 4-c — 묶음 P(프리앰블) + A(어댑터 레지스트리)

```
이 프롬프트는 `docs/internal/NEXT_SESSION_PROMPT.md` 의 코드블록이다. 파일을 직접
읽었다면 같은 파일 끝의 "별건 — 아직 남은 것" 표도 함께 보라.

`RUN_ORCHESTRATION_SRS` 의 **묶음 P 와 A 를 함께** 구현한다. 스펙은 이미 있다 —
다시 설계하지 마라. 조사도 끝났다. 스펙 → 테스트 → 코드다.

**두 묶음을 함께 가는 이유**: 프리앰블(P)에 들어갈 기동·종료 명령과 준비완료 판정의
출처가 어댑터 레지스트리(A)다. A 없이 P 를 쓰면 에이전트별 지식이 다시 스킬 산문으로
샌다.

**먼저 이 순서로 읽어라.**

1. `docs/internal/RUN_ORCHESTRATION_SRS.md` — 단일 진실 공급원. **§3.3(FR-ADP-*)**
   과 **§3.5(FR-PRE-*)** 가 이번 범위다. §1.2 표에 묶음별 구현 상태가 있다
2. `docs/internal/ORCHESTRATOR_RESEARCH_NOTES.md` **§4·§6.4** — orca 의 어댑터
   선언 필드 전수와 워커 프리앰블 전문 분석. 프리앰블에 무엇을 왜 넣는지가 여기 있다.
   소스를 다시 클론할 필요는 없다
3. `docs/internal/architecture.md` §"에이전트 접합면과 Run" — 지금의 사실
4. `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` §4 — 반복 금지 함정 15개

**현재 상태 (2026-08-25)**

- HEAD 는 묶음 R 커밋. `go build`·`go vet`·`go test ./...`·`gofmt -l` 전부 깨끗
- Playwright **182 통과 / 0 실패** (2회 연속 재현) — 이것이 이번 기준선이다
- 이미 쓸 수 있는 것:
  - `dmctl status` / `dmctl wait --for ready|done` (묶음 S). 준비완료는 훅 상태가
    1차 근거, `waiting` 은 즉시 `blocked`(rc=5), 타임아웃은 rc=4 이며 실패가 아니다
  - `dmctl run start|member|report|status|close|list` (묶음 R). `runs.json` 영속,
    epoch 펜싱, 도구 1:1 결속, 보고 권한, close 가드
- 식별자는 전부 uuid 다. 사용자 인스턴스도 마이그레이션됐다

**이번 범위**

### 묶음 A — 어댑터 레지스트리 (FR-ADP-1~6)

에이전트별 지식을 선언 테이블 하나로 모은다. 지금은 `parseClaudeHook`/`parseCodexHook`
가 `internal/runtimebin/dmctl_activity.go` 의 `switch agent` 에 박혀 있고, 기동 커맨드·
정책 주입 방식·준비완료 판정은 **코드에 없고 스킬 산문에만** 있다.

- 최소 필드는 FR-ADP-1 의 표를 따른다 (id / detectCmd / launch / promptInjection /
  policyInjection / hookParse / readiness / exitCommand)
- **훅 파서 이동은 무동작 리팩터다.** 기존 `dmctl_activity_test.go` 가 회귀 검출기이니
  그 테스트를 고치지 말고 통과시켜라
- **검증 대상은 Claude Code 다** (D-D). codex 는 선언만 유지하고 해상도가 낮다는
  사실을 주석·스킬에 남긴다
- FR-ADP-5: 정책 주입은 **세션 스코프**를 유지한다. 사용자의 `~/.claude` 를 건드리는
  구현으로 바꾸지 마라 — 참조 구현이 그 대가로 설치 잠금·소유자 신원·드리프트 검출을
  떠안고 있다
- 이 레지스트리가 채워지면 **묶음 S 의 준비완료 사다리 2단계**(어댑터가 선언한 화면
  패턴)를 연결할 수 있다. 자리는 `evaluateWait`(`internal/server/handlers_status.go`)에
  주석과 함께 비어 있다

### 묶음 P — 프리앰블 (FR-PRE-1~4, FR-PRE-8)

**FR-PRE-5/6/7(보고 권한·열거된 거부 사유·1회 보고)은 묶음 R 에서 이미 닫혔다.**
남은 것은 프리앰블 본문과 그 전달이다.

- 프리앰블은 **평문**이다. 실제로 실행할 `dmctl` 예제에 Run·Member uuid 를 박아 넣고
  `send-input` 으로 붙여넣는다 (FR-PRE-1)
- 행동 규칙은 **각 예제 바로 위**에 둔다. 산문 블록으로 몰지 마라 (FR-PRE-2) —
  LLM 독자는 예제에 정박하고 뒤 산문은 훑는다
- 담아야 하는 것은 FR-PRE-3 의 목록이다. 특히:
  - 보고는 정확히 한 번, `--outcome` 명시, 요약 3문장
  - 질문은 `dmctl msg --to <조정자>`. **AskUserQuestion 류 금지** — 조정자가 볼 수
    없어 세션이 영구히 멈춘다
  - 보고 후에는 유휴로 돌아가 대기한다. 폴링 루프 금지, 스스로 탭·셸을 닫지 않는다
  - **사용자의 직접 지시는 언제나 우선**한다
  - 엔벨로프 신뢰 규약은 `dmctl agent-context` 가 이미 상시 주입한다 — 중복 서술 금지
- FR-PRE-4(worktree 경로·base)는 묶음 W 가 채운다. 자리만 두고 지금은 비운다
- FR-PRE-8: Kickoff 는 `dmctl wait --for ready` 이후에만. 화면 fingerprint 로
  대체하지 마라

**설계 질문 하나는 열려 있다** — 프리앰블 조립의 주체가 서버(`dmctl run member` 응답에
실어 보냄)인지 CLI 인지. 스펙은 정하지 않았다. 서버 조립이 Run·Member id 를 이미 알고
있어 자연스럽지만, 스킬이 역할·프로토콜을 얹어야 하므로 **템플릿 + 역할 본문 합성**이
필요하다. 착수 전에 판단하고 근거를 남겨라.

**작업 규약**

- 신규 동작은 **RED 를 먼저 확인**한다. 스펙 §4.1 의 TC-ADP-1~3, TC-PRE-1~4 가 출발점
- **Go 테스트만으로 끝내지 마라.** 접합면·스킬을 만졌으면 `npx playwright test`
- **플레이키 판정에 단일 실행은 근거가 안 된다.** 기준선도 반복 실행하라
- 서버 관측을 클라이언트 상태 단정의 배리어로 쓰지 마라
- 일괄 정규식 치환 전에 함정 1~4 를 다시 읽어라
- 심볼 작업은 LSP → Serena → CLI 순. `web/js/` 는 Serena 불가 (함정 12)
- 커밋은 사용자 확인 후에만. 커밋 메시지에 AI 서명 금지
- **paseo 코드를 옮기지 마라** (AGPL). orca(MIT)도 설계만 가져오고 코드는 새로 쓴다

**이 두 묶음에서 특히 놓치기 쉬운 것**

- 어댑터 이동은 **동작을 바꾸지 않는 것**이 요구다. 훅 이벤트 매핑을 "개선"하지 마라
- 알 수 없는 에이전트 id 는 **명확한 오류**다. 기본 에이전트로 조용히 폴백하지 마라
  (FR-ADP-3)
- 레지스트리에 **정책을 담지 마라** (FR-ADP-6). 무엇을 왜 어떤 순서로는 스킬의 몫이다
- 프리앰블이 길어지면 규칙이 묻힌다. 참조 구현의 프리앰블도 CLI 예제 5개 + 규칙
  주석이 전부다

**그다음 (이번 범위 아님)**

- **W** — worktree 격리. 리스크 최대(파일시스템 파괴 경로). FR-WKT-8/9/10 을 먼저
  테스트로 못박아라. dirty worktree 는 지우지 않는다
- **K** — 스킬 재작성. `team` 을 전용 창 토폴로지로 옮기고 화면 fingerprint 를
  제거한다. e2e 필수
```

---

## 별건 — 아직 남은 것

| 항목 | 상태 |
|---|---|
| ~~사용자 인스턴스 v1 → v2 마이그레이션 / 구 식별자 재작성~~ | **완료** (`f7580a7`). `*.preuuid.bak` 백업. 사용자 홈은 전부 uuid v7 |
| ~~`~/.dongminal/runs.json` 에 소비자가 없음~~ | **해소** — 묶음 R 이 이 파일을 쓴다. 기존 프로토타입 필드는 보존했다 |
| `runs.json` 보존 한도 없음 | 무한 증가. 하루 몇 건 수준이라 당장 문제는 아니지만 후속 후보 |
| 워크스페이스 PUT 의 last-write-wins | 미해소. `Tab.runId` 표식이 동시 편집에 지워질 수 있는 근본 원인이다 (`WORKSPACE_IDENTITY_SRS` §2.4·§5). 소유권의 진실은 `runs.json` 이라 기능 영향은 없다 |
| 도구 표시명이 전부 `Shell` | FR-UNI-8 의 의도된 결과. 불편하면 rename UX 보강이 후속 후보 |
| `~/.dongminal/panels.json` | v1 시절 도구 기록. 소비자 없음. 삭제 여부 미정 |
| iOS 실기기 확인 (트랙 1 묶음 F) | 사용자 수동 확인 대기 (`test-checklist.md` C11.8~C11.10) |
| `SYSTEM_STATS_SRS` V-5·V-9 | 수동 확인 대기 (Activity Monitor 대조 / 브라우저 네트워크 탭) |
| `CLIENT_ATTACH_SRS` | 미착수 (ENTITY_MODEL SRS §7 후속) |
| fan-out 결과 자동 비교·병합 / diff 인라인 주석 리뷰 | **별건으로 확정.** 참조 구현에도 없다 — `RUN_ORCHESTRATION_SRS` §5 |
| 저장소에 `LICENSE` 없음 | orca(MIT) 코드를 실제로 차용한다면 고지 의무가 생긴다. 현재는 차용하지 않는 것으로 정리 (DC-RUN-5) |
