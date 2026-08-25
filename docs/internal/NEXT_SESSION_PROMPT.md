# 다음 세션 프롬프트

아래 블록을 새 세션 첫 메시지로 그대로 붙여넣는다.

| 트랙 | 상태 |
|---|---|
| ~~1. 사용자 확인 피드백~~ | **완료** — 8개 항목 전부. iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| ~~2. MCP 폐지 → 세션 스코프 스킬 주입~~ | **완료** — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| ~~3. 상태바 지표 재설계~~ | **완료** — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| ~~4-a. 오케스트레이터 — 결함·식별자 통일~~ | **완료** — `0ec8e02`, `835a662`, `f7580a7` ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| ~~4-b. 오케스트레이터 — 조사·설계~~ | **완료** — `901bd7c` ([RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md), [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md)) |
| **4-c. 오케스트레이터 — 구현** | **진행 중.** 묶음 **S**(`228c464`)·**R**(`a958797`)·**P+A**(`c37fa48`)·**K**(`b3dc910`) 완료. 남은 것은 **W** 하나. 아래 프롬프트 |

---

## 트랙 4-c — 묶음 W(worktree 격리)

```
이 프롬프트는 `docs/internal/NEXT_SESSION_PROMPT.md` 의 코드블록이다. 파일을 직접
읽었다면 같은 파일 끝의 "별건 — 아직 남은 것" 표도 함께 보라.

`RUN_ORCHESTRATION_SRS` 의 **묶음 W** 를 구현한다. 스펙은 이미 있다 — 다시 설계하지
마라. 조사도 끝났다. 스펙 → 테스트 → 코드다.

**이 묶음은 리스크가 최대다.** 파일시스템을 파괴할 수 있는 유일한 경로이며, 앞선
묶음들과 달리 실패가 되돌릴 수 없다. FR-WKT-8/9/10 을 **테스트로 먼저 못박아라.**

**먼저 이 순서로 읽어라.**

1. `docs/internal/RUN_ORCHESTRATION_SRS.md` — 단일 진실 공급원. **§3.4(FR-WKT-*)**
   가 이번 범위다. §1.2 표에 묶음별 구현 상태가 있다
2. `docs/internal/ORCHESTRATOR_RESEARCH_NOTES.md` **§1.1~1.4** — orca 의 worktree
   생성·명명·제거·실패 잔여물·잠금 실측. 소스를 다시 클론할 필요는 없다
3. `docs/internal/architecture.md` §"에이전트 접합면과 Run" · §"멤버 프리앰블" — 지금의 사실
4. `docs/internal/USER_CHECKLIST_FIXES_HANDOFF.md` §4 — 반복 금지 함정 15개.
   **특히 1~3** 은 파괴적 동작을 다루는 이번 묶음에 직접 걸린다

**현재 상태 (2026-08-25)**

- HEAD 는 묶음 K 커밋. `go build`·`go vet`·`go test ./...`·`gofmt -l` 전부 깨끗
- Playwright **184 통과 / 0 실패** (2회 연속 재현) — 이것이 이번 기준선이다
- 이미 쓸 수 있는 것:
  - `dmctl status` / `dmctl wait --for ready|done` (묶음 S)
  - `dmctl run start|member|launch|report|status|close|list` (묶음 R+P)
  - `internal/agentadapter` — 에이전트 선언 테이블 (묶음 A)
  - `internal/run/preamble.go` — 서버가 조립하는 평문 프리앰블 (묶음 P)
  - `team`·`workflow` 스킬이 위를 **실제로 쓴다** (묶음 K). 전용 창 토폴로지가 기본
- **실제 팀으로 한 바퀴 검증했다** — 기동 → 프리앰블 → `wait --for ready` → Kickoff
  → `run report` → `run status` → `run close`. 그 과정에서 나온 결함 2건은 고쳤다
  (`82ca4fc`: 정적 폴백이 시작 모달을 준비완료로 오인 / 멤버가 승인 프롬프트에 막혀
  보고 불가)

**이번 범위 — 묶음 W (FR-WKT-1~12)**

- 격리는 **Run 단위 선택**이고 기본은 `none` 이다 (D-A). "독립 태스크·병렬 실행·
  편의"는 격리 사유가 **아니다**
- 경로·브랜치는 **Run·Member uuid 에서 파생**하고 **재사용하지 않는다**
  (FR-WKT-3/4). 에이전트 CLI 가 cwd 로 대화 이력을 키잉하므로 경로 재사용은 남의
  이력을 물려주는 것이다
- `run close` 의 정리 규칙(FR-WKT-8)에서 **dirty worktree 는 지우지 않는다.**
  제거하지 못한 자원은 잔여물로 보고한다 (FR-WKT-12)
- 정리 대상은 **Run 이 만든 것만**이다 (FR-WKT-9 / FR-RUN-10). 사용자가 만든
  worktree 를 건드리지 마라
- 위험 경로를 거부한다 (FR-WKT-10) — 저장소 자신·파일시스템 루트·`..` 경로.
  브랜치·경로 인자가 `-` 로 시작하면 거부한다 (FR-WKT-6, git 플래그 오인)
- worktree 조작은 **직렬화**한다 (FR-WKT-7). 공용 common-dir 을 건드린다
- 비git 디렉터리에서 격리 Run 은 **명확히 실패**한다. `none` 으로 조용히 낮추지
  마라 (FR-WKT-11)

**작업 규약**

- 신규 동작은 **RED 를 먼저 확인**한다. 스펙 §4.1 의 TC-WKT-1~9 가 출발점
- worktree 테스트는 **격리된 임시 저장소**에서 한다. 운영 저장소·사용자 홈을
  대상으로 하지 마라 (§4.3, 함정 1~3)
- **Go 테스트만으로 끝내지 마라.** 접합면·스킬을 만졌으면 `npx playwright test`
- **플레이키 판정에 단일 실행은 근거가 안 된다.** 기준선도 반복 실행하라
- 서버 관측을 클라이언트 상태 단정의 배리어로 쓰지 마라
- 심볼 작업은 LSP → Serena → CLI 순. `web/js/` 는 Serena 불가 (함정 12)
- 커밋은 사용자 확인 후에만. 커밋 메시지에 AI 서명 금지
- **paseo 코드를 옮기지 마라** (AGPL). orca(MIT)도 설계만 가져오고 코드는 새로 쓴다

**묶음 W 를 마치면 트랙 4-c 가 끝난다.** 그 뒤로 남는 것은 아래 "별건" 표뿐이다.

**이미 준비된 접합점 — W 가 채우면 그대로 켜진다**

- `run.Worktree{Path,Branch,Base}` 필드와 `MemberSpec.Worktree` 는 있다. **채우는
  주체만 없다.** `dmctl run start --isolation per-run|per-member` 도 이미 기록된다
- `internal/run/preamble.go` 는 `m.Worktree != nil` 이면 경로·브랜치·base 절을
  **이미 렌더링한다** (FR-PRE-4, TC-PRE-4 가 지킨다)
- `dmctl run close` 는 이미 정리 대상 목록을 돌려준다. 여기에 잔여물을 더하면 된다
- `team`·`workflow` 스킬은 격리를 아직 언급하지 않는다 — W 가 그 절을 추가한다

**실측으로 알게 된 것 (W 에서 걸릴 수 있다)**

- 도구의 셸은 **`~` 에서 시작한다.** `POST /api/tools` 의 `cwd` 는 반영되지 않는다.
  worktree 로 멤버를 보내려면 스킬이 명시적으로 `cd` 를 보내야 한다
- 에이전트는 **신뢰하지 않는 디렉터리에서 시작 모달**을 띄운다. 새로 만든 worktree
  경로는 정의상 신뢰 목록에 없으므로, 격리 Run 의 첫 기동이 여기서 멈출 수 있다.
  이 상태에서 훅은 아무것도 보고하지 않는다(`state=unknown`) — FR-STA-4b 덕분에
  준비완료로 오인되지는 않고 타임아웃(체크포인트)으로 돌아온다
```

---

## 별건 — 아직 남은 것

| 항목 | 상태 |
|---|---|
| ~~사용자 인스턴스 v1 → v2 마이그레이션 / 구 식별자 재작성~~ | **완료** (`f7580a7`). `*.preuuid.bak` 백업. 사용자 홈은 전부 uuid v7 |
| ~~`~/.dongminal/runs.json` 에 소비자가 없음~~ | **해소** — 묶음 R 이 이 파일을 쓴다. 기존 프로토타입 필드는 보존했다 |
| FR-STA-4 **사다리 2단계** (어댑터가 선언한 화면 패턴) | **스펙에 남기고 구현 보류** (사용자 확정, 2026-08-25). `Readiness.ScreenPatterns` 자리는 있으나 소비자가 없다. 화면 패턴은 사용자가 하단 스테이터스라인 하나만 붙여도 깨지며, FR-SKL-2 가 삭제하려는 fingerprint 와 같은 취약성이다. 훅을 주지 않는 에이전트는 3단계(출력 3초 정적)로 판정된다 |
| codex 선언의 미확인 필드 | `modelFlag`·`exitCommand` 는 비어 있고 `promptInjection` 은 보수적으로 `stdin-after-start` 다. 이 머신의 codex 는 PATH 에 잡히지만 실체가 끊긴 심볼릭 링크라 실측이 불가했다. D-D 상 Claude 만 검증 대상이므로 차단 사항은 아니다 |
| `POST /api/tools` 의 `cwd` 가 무시된다 | 실측(2026-08-25). 셸이 항상 `~` 에서 뜬다. 스킬은 `dmctl send-input --execute 'cd <경로>'` 로 우회하고 있다. 묶음 W 에 직접 걸리므로 후속 후보 |
| 같은 머신에 dongminal 인스턴스가 둘이면 `PATH` 가 엉뚱한 `dmctl` 을 잡는다 | 실측(2026-08-25). 사용자 `~/.zshrc` 가 `~/.dongminal/bin` 을 앞세우면 격리 인스턴스의 도구도 그쪽 `dmctl` 을 쓴다. 일상 사용(인스턴스 1개)에는 영향이 없어 진단 표에만 적어 뒀다 |
| `runs.json` 보존 한도 없음 | 무한 증가. 하루 몇 건 수준이라 당장 문제는 아니지만 후속 후보 |
| 워크스페이스 PUT 의 last-write-wins | 미해소. `Tab.runId` 표식이 동시 편집에 지워질 수 있는 근본 원인이다 (`WORKSPACE_IDENTITY_SRS` §2.4·§5). 소유권의 진실은 `runs.json` 이라 기능 영향은 없다 |
| 도구 표시명이 전부 `Shell` | FR-UNI-8 의 의도된 결과. 불편하면 rename UX 보강이 후속 후보 |
| `~/.dongminal/panels.json` | v1 시절 도구 기록. 소비자 없음. 삭제 여부 미정 |
| iOS 실기기 확인 (트랙 1 묶음 F) | 사용자 수동 확인 대기 (`test-checklist.md` C11.8~C11.10) |
| `SYSTEM_STATS_SRS` V-5·V-9 | 수동 확인 대기 (Activity Monitor 대조 / 브라우저 네트워크 탭) |
| `CLIENT_ATTACH_SRS` | 미착수 (ENTITY_MODEL SRS §7 후속) |
| fan-out 결과 자동 비교·병합 / diff 인라인 주석 리뷰 | **별건으로 확정.** 참조 구현에도 없다 — `RUN_ORCHESTRATION_SRS` §5 |
| 저장소에 `LICENSE` 없음 | orca(MIT) 코드를 실제로 차용한다면 고지 의무가 생긴다. 현재는 차용하지 않는 것으로 정리 (DC-RUN-5) |
