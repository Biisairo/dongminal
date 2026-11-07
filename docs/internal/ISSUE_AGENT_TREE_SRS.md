# SRS: 이슈 에이전트 트리 — 명령 · statusLine 프록시 · window 그룹 · 순서 명령 — IEEE 29148

> **문서 상태**: 승인·구현중
> **개정**: FR-IAT-51~54·60·63·73, FR-ITD-2·6, D-IAT-19 는 `ISSUE_TREE_OPS_SRS.md` 가 대신한다(2026-11-07)
> **남은 것**: TC-SLP-6(Windows 셸 실측) · FR-WGR-25 키보드 조작의 e2e · TC-IAT-3 시범(rust-wasm 세션이 #62 를 커밋한 뒤). 묶음 O·G·S·T·X·D·U 는 구현·시험 완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 요구는 다음과 같다(사용자, 2026-11-05).

> 이슈마다 에이전트 하나를 둔다. 이슈 에이전트가 그 이슈를 계획하고 단계를 나누면 하위 이슈를 만들고, 하위 이슈마다 또 에이전트가 된다. 나눌 필요가 없으면 직접 일한다. 모든 이슈의 에이전트를 띄우지 않고 **진행 중인 이슈만** 연다. 병렬로 진행할 수 있는 이슈는 에이전트를 여럿 만든다. 서브에이전트가 아니라 **dmctl 로 실제 터미널 위에** 트리를 만든다.

본 SRS 는 이 방식을 dongminal 플러그인의 **명령** 하나로 만든다. 그 명령이 돌려면 dongminal 에 없는 것이 셋 있다. 셋을 같은 문서의 묶음으로 함께 정한다.

1. 에이전트가 자기·남의 **맥락 사용률**을 읽을 길 (묶음 S)
2. 트리 하나를 한 덩어리로 보는 **window 그룹** (묶음 G)
3. 그룹 안의 window 순서와 window 안의 탭 순서를 바꾸는 **순서 명령** (묶음 O)

### 1.2 범위 (Scope)

**포함** — 네 묶음. 묶음 간 의존은 §2.5.

| 묶음 | 이름 | 접두어 | 산출물 |
|---|---|---|---|
| **T** | 이슈 트리 명령 | `FR-IAT-` | `agentplugin/commands/issue-tree.md` (절차 문서) |
| **S** | statusLine 프록시 | `FR-SLP-` | `dmctl statusline` · 서버 관측 저장 · `dmctl status` 노출 |
| **G** | window 그룹 | `FR-WGR-` | 워크스페이스 모델 · 사이드바 UI · dmctl 그룹 명령 |
| **O** | 순서 명령 | `FR-ORD-` | `dmctl move-tab` · `move-window` · `move-group` · 생성 시 위치 지정 |
| **X** | 쓰지 않는 스킬 정리 | `FR-SKX-` | `team` · `workflow` 스킬 삭제와 그 안내 |
| **D** | 트리 대시보드 | `FR-ITD-` | Run 대시보드의 「이슈 트리」 영역 · `GET /api/runs/tree` · `dmctl run tree` |
| **U** | 트리 중복 방지 | `FR-ITU-` | `run start --tree` · 같은 트리·같은 이슈의 거절 · 멈춘 트리 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

`Window`·`Pane`(칸)·`Tab`·`Tool` 은 `ENTITY_MODEL_RESTRUCTURE_SRS` §1.3, `Run`·`Member` 는 `RUN_ORCHESTRATION_SRS` §1.3 을 따른다. 본 SRS 고유 용어만 적는다.

| 용어 | 정의 |
|---|---|
| **노드** | 이슈 하나와 그 이슈를 맡은 에이전트 하나. 에이전트가 떠 있는 노드만 노드로 센다 |
| **루트 노드** | 이슈 트리의 최상위 이슈(부모 이슈가 없는 이슈)의 노드 |
| **입력 이슈** | 사용자가 명령에 넘긴 이슈. 루트일 수도, 중간일 수도, 잎일 수도 있다 |
| **잎 노드** | 지금 직접 작업하는 노드. 하위 노드를 띄우지 않았다 |
| **중간 노드** | 하위 노드를 띄우고 그 보고를 기다리는 노드 |
| **사슬** | 루트 노드에서 어떤 노드까지의 경로 |
| **가지** | 병렬로 갈라진 하위 경로 하나. 가지 하나 = Run 하나 = window 하나 = worktree 하나 (D-IAT-6) |
| **Run 격리 단위** | window. Run 하나는 window 하나를 갖고, 두 Run 이 한 window 를 나눠 쓰지 않는다 (D-IAT-15) |
| **트리 격리 단위** | window 그룹. 이슈 트리 하나는 그룹 하나이고, 트리의 window 는 모두 그 그룹 안에 있다. 다른 트리·사용자 window 와 섞이지 않는다 (D-IAT-15) |
| **사슬 이름** | `<별칭>#<번호>›<번호>›…` 꼴의 문자열. 탭·window·그룹 이름의 머리다 (FR-IAT-40) |
| **별칭** | 저장소 이름에서 만든 짧은 이름. 예: `common-chart-renderer-ts` → `ccr` |
| **안전 지점** | 중간 노드가 하위 노드 하나의 완료 보고를 받고, 다음 하위 노드를 띄우기 전의 시점 |
| **하위 statusLine 명령** | dongminal 이 없을 때 Claude Code 가 실행했을 statusLine 명령. 예: claude-dashboard, claude-hud |
| **담는 곳** | 순서가 있는 목록 하나. 칸 안의 탭들, 그룹 안의 window 들, 최상위 목록(그룹과 그룹 없는 window) |

### 1.4 참고 (References)

- `RUN_ORCHESTRATION_SRS.md` — Run 레코드 · 격리(FR-WKT-*) · 보고 계약
- `ORCHESTRATION_V2_SRS.md` — 식별자 uuid 전용(FR-IDU-*) · 헤드리스 멤버 · attach/detach
- `M10_SRS.md` — `migration` 이 스킬이 아니라 명령인 이유(D-M10-8)
- `ALERT_MOBILE_CONTEXT_SRS.md` · `archive/UX_BATCH6_SRS.md` FR-CTX-1~6 — 지금의 맥락 관측(transcript 기반)
- `PANEL_SURFACE_SRS.md` FR-AGG-* — 에이전트 패널의 창 그룹(접기 머리)
- `ORCHESTRATOR_RESEARCH_NOTES.md` — orca · paseo 조사
- 외부: T3 Code(스레드마다 현재 폴더 또는 worktree), orca(작업마다 worktree, `worktree.sharedDirectories`)
- 결정 경위: `/Users/dykim/p6w-backup/issue-agent-skill-handoff.md` 「정한 것」

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 트리를 돌릴 절차가 없다

`/dongminal:team` 은 조정자 하나와 평면 멤버 N 을 세운다. `/dongminal:migration` 은 한 세션을 다음 한 세션에 넘긴다. 이슈의 부모·자식 관계를 따라 에이전트를 세우고 접는 절차는 없다.

### 2.2 에이전트는 맥락 사용률을 모른다

- 모델은 자기 맥락 사용률을 숫자로 받지 못한다.
- Claude Code 는 statusLine 명령을 실행할 때 stdin JSON 으로 `context_window.used_percentage`·`context_window_size`·`current_usage` 를 넘긴다. claude-dashboard 는 이 값을 표시만 하고 저장하지 않는다(`claude-dashboard/1.29.0/dist/index.js:1201-1217`).
- dongminal 서버는 transcript 의 실측 토큰과, 모델 이름으로 **추측한** 창 크기로 사용률을 계산한다(FR-CTX-1~6, `internal/webserver/domain/run/context_window.go`). 사용자는 이 값이 정확하지 않다고 보고했다.
- `dmctl status --json` 에는 맥락 값이 없다.

### 2.3 window 는 평면 목록이다

- window 순서는 `ws.windows` 배열의 순서다. 그룹·접기 개념이 없다(`web/js/ui/sidebar-list.js`).
- 새 window 는 항상 목록 끝에 붙는다(`web/js/core/app-layout.js:159`).
- 에이전트 패널의 "창 그룹"은 카드를 소속 window 별로 묶는 **파생** 표시일 뿐이다(`web/js/core/app-agents.js:185-230`). 접기 상태 저장과 머리 요소는 재사용할 수 있다.
- 워크스페이스 저장은 객체 전체를 `PUT /api/workspace` 로 보낸다. 새 필드를 더해도 스키마 버전을 올리지 않은 선례가 있다(`internal/shared/workspace/manager_parse.go:43-46`).

### 2.4 순서를 바꾸는 dmctl 명령이 없다

- UI 에는 탭 이동(같은 칸·다른 칸·다른 window, `web/js/core/app-dnd.js:39` `moveTabToPane`·`moveTabToWindow`)과 window 끌어 놓기(`web/js/ui/sidebar-tabs.js:89-98`)가 있다.
- dmctl 에는 순서를 바꾸는 명령이 하나도 없다. 명령의 허용 목록은 `internal/webserver/hub/commands.go:77-115`, 브라우저 처리 표는 `web/js/core/app-cmd.js:39-46` 이다.

### 2.5 묶음 간 의존

```
S (맥락 사용률) ─┐
G (그룹) ───────┼──▶ T (트리 명령)
O (순서) ───────┘
G ──▶ O (move-window 의 그룹 이동은 G 의 모델 위에 선다)
```

T 는 S·G·O 가 모두 선 뒤에 시범 적용한다. S·G·O 는 T 없이도 독립 기능으로 쓸모가 있다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 T — 이슈 트리 명령 (FR-IAT-\*)

#### 3.1.1 형태와 진입

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-1 | 이슈 트리는 **명령** `/dongminal:issue-tree` 다. 모델이 스스로 발동하는 스킬로 두지 않는다 (D-IAT-1) | 필수 |
| FR-IAT-2 | 인자는 이슈 하나다. `owner/repo#N`, 이슈 URL, `#N`(현재 저장소) 세 꼴을 받는다. 뒤따르는 선택 인자는 FR-IAT-60 의 표를 따른다 | 필수 |
| FR-IAT-3 | dongminal 이 띄운 도구 안이 아니면(`dmctl who-am-i` 실패) 시작하지 않고 그 사실을 사용자에게 말한다 | 필수 |
| FR-IAT-4 | 각 노드의 에이전트는 이 명령 문서를 절차로 읽는다. 하위 노드를 띄울 때는 신뢰 엔벨로프로 "이 문서를 읽고 노드 X 로 일하라"를 보낸다 | 필수 |

#### 3.1.2 트리 펼치기

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-10 | **위쪽**: 입력 이슈에서 부모 이슈를 따라 루트까지 올라간다. 루트 → 입력 이슈 경로의 조상에만 노드를 세운다 | 필수 |
| FR-IAT-11 | **아래쪽**: 입력 이슈의 노드부터 재귀로 내려간다. 각 노드는 끝나지 않은 하위 이슈 중 **지금 해야 할 것만** 연다(FR-IAT-20) | 필수 |
| FR-IAT-12 | 노드는 **바로 아래 자식만** 띄운다. 명령을 실행한 세션이 여러 단계를 한꺼번에 띄우지 않는다 (D-IAT-3) | 필수 |
| FR-IAT-13 | 일하지 않을 노드로 가는 길에는 에이전트를 띄우지 않는다. 병렬이 없으면 잎 노드는 정확히 하나다. 병렬이 있으면 병렬 수만큼 늘어난다. 쉬는 잎 노드는 없다 | 필수 |
| FR-IAT-14 | 잎 노드는 직접 작업하거나, 나눌 필요가 있으면 하위 이슈를 만들어 스스로 중간 노드가 된다 | 필수 |
| FR-IAT-15 | 끝난 하위 이슈(닫힌 이슈)는 다시 열지 않는다 | 필수 |
| FR-IAT-16 | 이슈의 부모·자식 관계는 GitHub 하위 이슈(sub-issues) 관계를 근거로 한다 | 필수 |

#### 3.1.3 순서와 병렬

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-20 | 하위 이슈는 기본적으로 **서브이슈 순서대로** 하나씩 진행한다. 각 하위 이슈는 바로 앞 형제에 의존한다고 본다 | 필수 |
| FR-IAT-21 | 의존하지 않는 하위 이슈는 부모가 **하위 이슈를 만들 때** 그 본문에 적는다. 적는 꼴은 본문의 한 줄 `의존: 없음` 또는 `의존: #61, #63` 이다. 이 줄이 없으면 FR-IAT-20 이 적용된다 | 필수 |
| FR-IAT-22 | 작업이 시스템 성능에 예민하면 부모는 그 이슈를 병렬로 만들지 않는다. 이 판단은 부모가 한다. 별도의 잠금 장치를 두지 않는다 | 필수 |
| FR-IAT-23 | 동시에 일하는 잎 노드 수에 상한을 두지 않는다 (D-IAT-9) | 필수 |
| FR-IAT-24 | 노드는 하위 이슈를 열기 전에 의존 대상이 모두 닫혔는지 확인한다 | 필수 |

#### 3.1.4 작업 트리와 병합

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-30 | 루트 노드는 `dmctl run start --isolation per-run` 으로 Run 을 열어 사용자 작업 트리와 분리된 worktree 하나를 만든다. 사용자 작업 트리는 트리가 도는 동안 고치지 않는다 | 필수 |
| FR-IAT-31 | 사슬(병렬 아님)의 자식 노드는 부모와 **같은 Run·같은 worktree** 에서 일한다. 부모는 자식이 도는 동안 파일을 고치지 않는다 | 필수 |
| FR-IAT-32 | 병렬 자식 중 **첫째**는 부모의 Run·worktree 를 이어 쓴다. **둘째부터**는 각자 새 Run(`--isolation per-run --base <부모 브랜치 HEAD>`)을 연다 (D-IAT-6) | 필수 |
| FR-IAT-33 | 병렬 가지의 브랜치는 그 가지가 끝나면 부모가 자기 브랜치에 병합한다. 충돌은 부모가 푼다 | 필수 |
| FR-IAT-34 | 루트 브랜치를 사용자의 원래 브랜치에 병합하는 일과 push 는 **사용자에게 확인을 받은 뒤**에만 한다 (FR-IAT-71) | 필수 |

#### 3.1.5 화면 배치와 이름

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-40 | **사슬 이름**은 `<별칭>#<루트 번호>›<번호>›…›<이 노드 번호>` 다. 하위 이슈가 다른 저장소에 있으면 그 칸에 별칭을 다시 붙인다(`ccr#32›dmn#120`) | 필수 |
| FR-IAT-41 | **별칭**은 저장소 이름에서 자동으로 만든다. `-`·`_`·`.` 로 나눈 낱말의 첫 글자를 소문자로 잇는다. 낱말이 하나면 앞 세 글자다. 설정 파일을 두지 않는다 (D-IAT-8) | 필수 |
| FR-IAT-42 | 모든 노드의 **탭 이름**은 사슬 이름으로 시작하고, 공백 뒤에 이슈 제목의 짧은 형태가 따른다. 예: `ccr#32›33›35›62 피킹` | 필수 |
| FR-IAT-43 | 모든 **window 이름**은 그 window 에서 처음 선 노드의 사슬 이름으로 시작한다 | 필수 |
| FR-IAT-44 | 사슬의 자식은 부모 탭과 **같은 칸**에 탭으로 쌓는다. 칸을 나누지 않는다 (D-IAT-5) | 필수 |
| FR-IAT-45 | 병렬 자식 중 첫째는 부모 window 의 같은 칸에 탭으로 붙는다. 둘째부터는 각자 **새 window** 에 선다. 새 window 는 포커스를 빼앗지 않는다(`new-window -n`) | 필수 |
| FR-IAT-46 | 새 탭은 부모 탭 **바로 뒤**에, 새 window 는 트리 그룹의 **끝**에 놓는다 (FR-ORD-*, FR-WGR-*) | 필수 |
| FR-IAT-47 | 트리 하나는 window 그룹 하나다(트리 격리 단위). 루트 노드가 시작할 때 그룹을 만들고 그룹에 트리 표지(`tree: {repo, root}`, FR-WGR-8)를 단다. 같은 표지의 그룹이 이미 있으면 그것을 쓴다. 이름으로 찾지 않는다. 그룹의 기본 이름은 `<별칭>#<루트 번호> <루트 제목>` 이다 | 필수 |
| FR-IAT-48 | 트리의 window 는 모두 그 트리 그룹 안에 만든다(`new-window --group`). 트리 노드는 자기 트리 그룹 밖의 window·탭을 만들거나 옮기거나 닫지 않는다 | 필수 |
| FR-IAT-49 | Run 하나는 window 하나다(Run 격리 단위). 가지의 Run 은 그 가지의 window 를 `run start --window` 로 갖는다. 병렬 첫째 자식은 부모의 Run 을 이어 쓰므로 새 window·새 Run 을 만들지 않는다 | 필수 |

#### 3.1.6 메시지·질문·문서

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-50 | 노드 사이의 통신은 `dmctl msg`(신뢰 엔벨로프)로만 한다. 종류는 `보고` · `질문` · `답` · `완료` · `실패` 다. 본문 첫 줄에 종류와 사슬 이름을 적는다 | 필수 |
| FR-IAT-51 | 잎 노드는 질문을 먼저 부모에게 보낸다 | 필수 |
| FR-IAT-52 | 부모는 **코드·문서로 사실에 근거해 확실히 답할 수 있을 때만** 답한다. 판단이나 방향 결정이 필요한 질문에는 답하지 않고 "사용자에게 물어라"로 돌려준다 | 필수 |
| FR-IAT-53 | 부모가 돌려준 질문은 질문한 노드가 **자기 탭에서** 사용자에게 직접 묻는다 | 필수 |
| FR-IAT-54 | 공유 문서(결정·설계)는 그 하위 트리를 가진 부모만 고친다. 잎 노드는 코드·시험만 고치고, 문서에 남길 것은 보고 본문에 담는다 | 필수 |
| FR-IAT-55 | 이슈 규약(프로젝트 보드·담당자·필드·커밋 메시지의 이슈 번호·닫는 방식)은 **그 프로젝트의 지시 문서**(CLAUDE.md·README 등)를 따른다. 이 명령은 규약을 정의하거나 저장하지 않는다. 규약이 없으면 GitHub 기본 동작(하위 이슈 생성·닫기)만 한다 (D-IAT-7) | 필수 |

#### 3.1.7 쉬기·migration

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-60 | 선택 인자: `--ctx <퍼센트>`(migration 기준, 기본 60) | 필수 |
| FR-IAT-61 | 중간 노드는 하위 노드를 띄운 뒤 턴을 끝내고 쉰다. `dmctl msg` 가 와야 깨어난다. 상태를 폴링하지 않는다 | 필수 |
| FR-IAT-62 | 중간 노드는 **안전 지점**에서만 자기 맥락 사용률을 `dmctl status` 로 읽는다(FR-SLP-20). 기준 이상이면 `/dongminal:migration` 으로 새 세션에 넘긴다 | 필수 |
| FR-IAT-63 | migration 으로 선 새 세션의 탭 이름은 넘긴 세션과 같다(사슬 이름 유지). 하위 노드에게 새 toolId 를 알린다 | 필수 |
| FR-IAT-64 | 맥락 사용률을 읽지 못하면(값 없음) migration 하지 않고 계속한다. 읽지 못한 사실은 보고에 적는다 | 필수 |

#### 3.1.8 완료·승인·정리

| ID | 요구 | 우선 |
|---|---|---|
| FR-IAT-70 | 명령 실행은 **트리 범위 안의 커밋과 이슈 닫기에 대한 승인**이다. 잎 노드는 작업을 끝내면 스스로 커밋하고, 프로젝트 규약대로 이슈를 닫는다 (D-IAT-4) | 필수 |
| FR-IAT-71 | push 와 사용자 브랜치로의 병합만 루트 노드가 사용자에게 확인을 받는다 | 필수 |
| FR-IAT-72 | 사용자가 커밋하지 말라고 명시한 경우에만 커밋하지 않는다. 그 지시는 하위 노드에게 엔벨로프로 전한다 | 필수 |
| FR-IAT-73 | 노드는 완료를 부모에게 보고한 뒤 자기 탭을 닫는다. 가지의 마지막 노드가 닫히면 그 window 도 닫는다 | 필수 |
| FR-IAT-74 | 트리가 끝나면 루트 노드는 Run 을 닫고(`dmctl run close`), 자기가 만든 그룹을 지운다. 사용자가 만든 그룹은 지우지 않는다 | 필수 |
| FR-IAT-75 | 노드가 실패로 끝나면 커밋하지 않은 변경을 지우지 않는다. 실패를 부모에게 보고하고, 부모는 그 일을 사용자에게 알린다 | 필수 |

### 3.2 묶음 S — statusLine 프록시 (FR-SLP-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-SLP-1 | dongminal 이 `claude()` 래퍼로 넘기는 설정 파일(`$DONGMINAL_HOME/bin/agent-hooks/claude.json`)에 `statusLine` 을 넣는다. 명령은 `dmctl statusline` 이다 | 필수 |
| FR-SLP-2 | `dmctl statusline` 은 stdin JSON 을 끝까지 읽고, **허용 목록**의 값을 꺼내 서버에 보고한다(D-IAT-16). 보고 대상 도구는 실행 환경의 `DONGMINAL_TOOL_ID` 다. 허용 목록: `session_id` · `version` · `model.id`·`model.display_name` · `effort.level` · `thinking.enabled` · `fast_mode` · `output_style.name` · `exceeds_200k_tokens` · `cost.*`(총 비용·총 시간·API 시간·추가/삭제 줄 수) · `context_window.*`(입출력 누적 토큰·창 크기·`current_usage` 넷·사용률·남은 비율) · `rate_limits.*`(창마다 사용률·재설정 시각). 값이 `null` 이거나 없는 필드는 싣지 않는다(첫 응답 전에는 사용률이 `null` 이다) | 필수 |
| FR-SLP-2a | 경로와 본문은 보내지 않는다: `transcript_path` · `cwd` · `workspace.*` 는 허용 목록 밖이다(FR-CTX-3 과 같은 규칙). 허용 목록에 없는 새 필드는 Claude Code 판이 바뀌어 생겨도 보내지 않는다 | 필수 |
| FR-SLP-3 | 보고는 표시를 막지 않는다. 보고에 실패하거나 제한 시간(NFR-SLP-1)을 넘기면 버리고 다음 단계로 간다 | 필수 |
| FR-SLP-4 | `dmctl statusline` 은 **하위 statusLine 명령**을 찾는다. dongminal 의 설정을 뺀 나머지 Claude Code 설정을 우선순위대로 읽는다: 프로젝트 `.claude/settings.local.json` → 프로젝트 `.claude/settings.json` → 사용자 설정(`$CLAUDE_CONFIG_DIR/settings.json`, 없으면 `~/.claude/settings.json`). 프로젝트 폴더는 stdin JSON 의 `workspace.project_dir` 이고, 없으면 이 프로세스의 작업 폴더다(세션의 `cwd` 필드로는 찾지 않는다). 어느 설정이든 `disableAllHooks` 가 참이면 하위 명령을 실행하지 않는다 — Claude Code 가 실행하지 않았을 명령이다 | 필수 |
| FR-SLP-5 | 하위 명령이 있으면 **받은 stdin 바이트를 그대로** 넘겨 실행한다. 그 stdout 을 그대로 내보내고 종료 코드를 그대로 돌려준다 | 필수 |
| FR-SLP-6 | 하위 명령이 없으면 아무것도 출력하지 않는다 | 필수 |
| FR-SLP-7 | 하위 명령과 그 설정 파일을 **고치지 않는다.** 하위 명령이 무엇이든(claude-dashboard·claude-hud·사용자 스크립트) 같은 방식으로 동작한다 | 필수 |
| FR-SLP-8 | 하위 명령을 실행하는 셸은 Claude Code 가 그 플랫폼에서 statusLine 을 실행하는 방식과 같다. Windows 에서도 동작한다(PowerShell 래퍼도 같은 설정 파일을 쓴다) | 필수 |
| FR-SLP-10 | 서버는 도구마다 statusLine 관측값(사용률·창 크기·토큰·시각)을 저장한다. Run 멤버인지와 상관없이 저장한다 | 필수 |
| FR-SLP-11 | 같은 도구에 statusLine 관측값과 transcript 관측값이 함께 있으면 **statusLine 값이 이긴다.** statusLine 값이 없을 때만 기존 계산(FR-CTX-1~6)을 쓴다 | 필수 |
| FR-SLP-20 | `dmctl status --json` 은 `context` 객체를 싣는다: `usedPct` · `windowTokens` · `tokens` · `source`(`statusline` \| `transcript`) · `observedAt`. 그리고 statusLine 관측이 있으면 `usage` 객체에 FR-SLP-2 의 값 전부를 싣는다(`model` · `version` · `sessionId` · `effort` · `thinking` · `fastMode` · `outputStyle` · `cost` · `contextWindow` · `rateLimits` · `exceeds200k` · `observedAt`). 값이 없으면 그 객체를 싣지 않는다. 대상은 `--at <탭 uuid\|toolId>`·`--member <uuid>` 로 지목하며, 생략하면 자기 세션이다 | 필수 |
| FR-SLP-21 | `dmctl status` 의 글자 출력에도 사용률과 출처를 한 줄로 적는다 | 필수 |
| FR-SLP-22 | 기존 맥락 표시(멤버 카드·그래프 노드, FR-RCX-*)도 FR-SLP-11 의 우선순위를 따른다 | 필수 |

### 3.3 묶음 G — window 그룹 (FR-WGR-\*)

#### 3.3.1 모델

| ID | 요구 | 우선 |
|---|---|---|
| FR-WGR-1 | 그룹은 **일반 기능**이다. 사용자도 이슈 트리도 같은 기능을 쓴다 (D-IAT-10) | 필수 |
| FR-WGR-2 | 워크스페이스에 `windowGroups: [{id, name, tree?}]` 를 두고, window 에 선택 필드 `groupId` 를 둔다. 스키마 버전은 올리지 않는다 | 필수 |
| FR-WGR-3 | 그룹은 **한 층**이다. 그룹 안에 그룹을 두지 않는다 | 필수 |
| FR-WGR-4 | window 순서의 출처는 지금처럼 `ws.windows` 하나다. 같은 그룹의 window 는 `ws.windows` 에서 **항상 붙어 있다**(불변식). 그룹의 위치는 그 첫 window 의 위치다 (D-IAT-11) | 필수 |
| FR-WGR-5 | window 가 하나도 없는 그룹(빈 그룹)은 최상위 목록의 **맨 끝**에 놓인다. 빈 그룹에 window 가 들어오면 그 window 의 자리가 그룹의 자리가 된다 | 필수 |
| FR-WGR-6 | 불변식(FR-WGR-4)이 깨진 워크스페이스를 읽으면, 각 그룹의 window 를 그 그룹 첫 window 자리 뒤로 모아 고친다. 없는 그룹을 가리키는 `groupId` 는 지운다 | 필수 |
| FR-WGR-7 | git·editor 타입 window 는 그룹에 넣지 않는다. 사이드바 window 목록(`plainWindows`)에 나오는 window 만 대상이다 | 필수 |
| FR-WGR-8 | 그룹은 선택 필드 `tree: {repo, root}` 를 가질 수 있다. 이 표지가 있는 그룹은 이슈 트리의 격리 단위다. `dmctl new-group --tree <owner/repo#N>` 으로 단다. 같은 표지의 그룹은 둘 이상 만들 수 없다 | 필수 |
| FR-WGR-9 | 트리 표지가 있는 그룹에 사용자가 window 를 끌어 넣거나 빼는 것은 막지 않는다. 사이드바 머리에 트리 그룹임을 표시한다 | 필수 |

#### 3.3.2 수명과 이름

| ID | 요구 | 우선 |
|---|---|---|
| FR-WGR-10 | 그룹에는 이름이 있다. 사용자는 이름을 적고 고칠 수 있다. 빈 이름은 받지 않는다 | 필수 |
| FR-WGR-11 | 빈 그룹은 자동으로 지우지 않는다 | 필수 |
| FR-WGR-12 | 그룹을 지우면 안의 window 는 닫지 않는다. 그룹 밖으로 풀어 그 자리에 그대로 둔다 | 필수 |
| FR-WGR-13 | 그룹 안의 window 를 닫는 일은 지금의 window 닫기(되돌리기 포함, `WINDOW_CLOSE_UNDO_SRS`)를 그대로 따른다. 되돌리면 원래 그룹·원래 자리로 돌아간다 | 필수 |

#### 3.3.3 사이드바 UI

| ID | 요구 | 우선 |
|---|---|---|
| FR-WGR-20 | 사이드바 window 목록은 그룹마다 **머리**를 그린다: 접기 화살표 · 이름 · window 수 · 주의 배지. 에이전트 패널 창 그룹의 머리 요소를 재사용한다 | 필수 |
| FR-WGR-21 | 그룹을 접고 펼 수 있다. 접기 상태는 클라이언트마다 따로 저장한다(`PrefStore.local`) | 필수 |
| FR-WGR-22 | 접힌 그룹 안의 window 가 활성 window 가 되면 그 그룹을 펼친다 | 필수 |
| FR-WGR-23 | 사용자는 사이드바에서 그룹 만들기 · 이름 바꾸기 · 지우기를 할 수 있다 | 필수 |
| FR-WGR-24 | window 를 끌어서 그룹에 넣고 뺄 수 있다. 그룹 머리를 끌면 그룹이 통째로 움직인다. 끌어 놓기 결과는 FR-WGR-4 를 지킨다 | 필수 |
| FR-WGR-25 | 키보드로도 같은 조작을 할 수 있다(접근성 기준 `ACCESSIBILITY_BASELINE_SRS`) | 필수 |

#### 3.3.4 dmctl 그룹 명령

| ID | 요구 | 우선 |
|---|---|---|
| FR-WGR-30 | `dmctl new-group --name <이름> [--tree <owner/repo#N>] [-n]` — 빈 그룹을 만들고 그룹 uuid 를 돌려준다. `--tree` 는 FR-WGR-8 의 표지다 | 필수 |
| FR-WGR-31 | `dmctl rename-group --at <그룹> <이름>` | 필수 |
| FR-WGR-32 | `dmctl delete-group --at <그룹>` — FR-WGR-12 를 따른다 | 필수 |
| FR-WGR-33 | `dmctl new-window --group <그룹>` — 새 window 를 그 그룹의 끝에 만든다 | 필수 |
| FR-WGR-34 | `dmctl list-workspace` 의 행마다 그룹 uuid·그룹 이름을 싣는다(글자 출력은 `group="…"`). 빈 그룹까지 포함한 그룹 목록은 `dmctl list-groups [--json]` 이 낸다: 그룹 uuid · 이름 · 트리 표지 · 최상위 목록 안 자리 · window 수 | 필수 |
| FR-WGR-35 | 그룹 uuid 는 uuid 만 받는다. 좌표 라벨이나 이름으로 지목하지 않는다(FR-IDU-*) | 필수 |
| FR-WGR-36 | 새 명령은 모두 `cmdActions` 허용 목록에 등록하고, 구독 중인 브라우저가 없으면 지금의 레이아웃 명령처럼 실패한다(exit 1) | 필수 |

### 3.4 묶음 O — 순서 명령 (FR-ORD-\*)

#### 3.4.1 공통 위치 지정

| ID | 요구 | 우선 |
|---|---|---|
| FR-ORD-1 | 이동 명령은 대상 하나(`--at <uuid>`)와 위치 지정 **정확히 하나**를 받는다: `--index N` · `--prev` · `--next` · `--before <uuid>` · `--after <uuid>` | 필수 |
| FR-ORD-2 | `--index N` 은 담는 곳 안의 **1부터 세는** 자리다. 범위를 벗어나면 오류로 끝낸다. 끝으로 붙이지 않는다 | 필수 |
| FR-ORD-3 | `--prev`·`--next` 는 한 칸 옮긴다. 이미 끝이면 오류로 끝낸다. 반대쪽으로 돌아가지 않는다 | 필수 |
| FR-ORD-4 | `--before`·`--after` 는 기준 uuid 의 바로 앞·뒤다. 기준이 다른 담는 곳에 있으면 그 담는 곳으로 옮긴다(FR-ORD-10·20) | 필수 |
| FR-ORD-5 | `--to <uuid>` 는 담는 곳을 바꾼다. `--index`·`--prev`·`--next` 와 함께 쓰면 새 담는 곳 안의 자리다. 위치 지정 없이 쓰면 그 담는 곳의 끝이다 | 필수 |
| FR-ORD-6 | 번호와 기준은 명령이 브라우저에 **적용되는 순간**의 순서로 해석한다. 결과로 최종 위치 `{container, index, count}` 를 돌려준다 | 필수 |
| FR-ORD-7 | 이동 결과는 UI 끌어 놓기와 **같은 코드 경로**를 지난다. 같은 제약(창 타입 규칙 FR-RTU-17 등)을 따른다 | 필수 |
| FR-ORD-8 | 위치를 바꾸지 않는 이동(이미 그 자리)은 성공으로 끝내고 아무것도 바꾸지 않는다 | 필수 |

#### 3.4.2 탭

| ID | 요구 | 우선 |
|---|---|---|
| FR-ORD-10 | `dmctl move-tab --at <탭> <위치> [--to <칸\|window>]` — 담는 곳은 칸이다. `--to` 가 window 면 그 window 의 포커스 칸이다. 칸·window 를 넘는 이동은 UI 의 `moveTabToPane`·`moveTabToWindow` 와 같다 | 필수 |
| FR-ORD-11 | `dmctl new-tab` 에 `--after <탭>`·`--index N` 을 더한다. 없으면 지금처럼 칸의 끝이다 | 필수 |

#### 3.4.3 window·그룹

| ID | 요구 | 우선 |
|---|---|---|
| FR-ORD-20 | `dmctl move-window --at <window> <위치> [--to <그룹> \| --ungroup]` — 담는 곳은 그 window 의 그룹, 그룹이 없으면 최상위 목록이다 | 필수 |
| FR-ORD-21 | `move-window` 의 기준이 그룹 안의 window 면 그 그룹에 들어간다. 기준이 그룹 없는 window 나 그룹이면 최상위 목록에 놓인다 | 필수 |
| FR-ORD-22 | `dmctl move-group --at <그룹> <위치>` — 담는 곳은 최상위 목록(그룹과 그룹 없는 window 가 섞인 목록)이다. 그룹의 window 는 함께 움직인다 | 필수 |
| FR-ORD-23 | 빈 그룹은 `move-group` 으로 옮길 수 없다(FR-WGR-5). 오류로 끝내고 그 이유를 말한다 | 필수 |
| FR-ORD-24 | 어떤 이동도 FR-WGR-4(같은 그룹의 window 는 붙어 있다)를 깨지 않는다. 그룹 사이로 끼워 넣는 위치는 그룹 경계 바깥으로 맞춘다 | 필수 |

#### 3.4.4 조회

| ID | 요구 | 우선 |
|---|---|---|
| FR-ORD-30 | `dmctl list-workspace --json` 은 지금의 **행 배열** 꼴을 유지하고, 행마다 순서 필드를 더한다: `windowContainer`(그룹 uuid 또는 `top`) · `windowIndex` · `windowCount` · `tabIndex` · `tabCount`(그 칸 안). 기존 필드는 바꾸지 않는다 — 소비자(스킬·스크립트)가 배열을 읽는다 | 필수 |
| FR-ORD-31 | 글자 출력에는 각 행에 `win_pos=<자리>/<개수>` · `tab_pos=<자리>/<개수>` 를 적는다(기존 `tab="이름"` 열과 겹치지 않게) | 필수 |

### 3.5 묶음 X — 쓰지 않는 스킬 정리 (FR-SKX-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-SKX-1 | 플러그인의 `skills/team` 과 `skills/workflow` 를 지운다. 사용자가 한 번도 쓰지 않았다(사용자, 2026-11-05) | 필수 |
| FR-SKX-2 | `dmctl run` 계열(Run 기록 · worktree · 멤버 · 대시보드)은 지우지 않는다. 이슈 트리가 쓴다 | 필수 |
| FR-SKX-3 | 두 스킬을 가리키는 안내를 고친다: 세션 주입 문구(`dmctl agent-context`) · dmctl 도움말 · `migration.md` · Runs 빈 화면 안내 · 플러그인 설명. 빈 화면 안내와 세션 주입 문구는 `/dongminal:issue-tree` 를 가리킨다 | 필수 |
| FR-SKX-4 | 두 스킬에만 걸리던 계약 시험과 e2e 단정은 지우거나 `issue-tree` 로 옮긴다. 옛 SRS(`RUN_ORCHESTRATION_SRS` FR-SKL-* 등)의 본문은 기록으로 남기고 고치지 않는다 | 필수 |

### 3.6 묶음 D — 트리 대시보드 (FR-ITD-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITD-1 | 트리 표지가 있는 Run(FR-ITU-1)의 대시보드에 「이슈 트리」 영역을 둔다. 그 트리의 **열린 Run 전부**의 멤버를 노드로 그린다 | 필수 |
| FR-ITD-2 | 노드의 부모·자식은 멤버 역할 이름(사슬 이름, FR-IAT-40)에서 얻는다. 부모는 그 사슬의 가장 긴 앞부분을 가진 노드다. 부모 노드가 없으면(이미 끝났거나 migration 중) 그 위의 가장 가까운 노드에 붙인다 | 필수 |
| FR-ITD-3 | 노드마다 이슈(사슬 끝 번호 · 제목) · 에이전트 상태 · 맥락 사용률을 보인다. 자식 노드가 없는 노드(지금 일하는 잎)를 구분해 표시한다 | 필수 |
| FR-ITD-4 | 노드를 누르면 그 에이전트의 탭으로 간다. 기존 멤버 카드의 이동(`_runJumpToMember`)과 같은 경로다 | 필수 |
| FR-ITD-5 | 서버는 `GET /api/runs/tree?ref=<owner/repo#N>` 로 그 트리의 열린 Run 과 노드를 낸다. `dmctl run tree --ref <owner/repo#N> [--json]` 이 같은 값을 낸다(NFR-RVZ-4: 화면에만 있는 정보는 없다) | 필수 |
| FR-ITD-6 | 이슈 트리는 Run 기록만으로 그린다. 서버는 GitHub 에 접근하지 않는다. 끝난 이슈와 아직 열지 않은 이슈는 그리지 않는다 (D-IAT-18) | 필수 |
| FR-ITD-7 | 트리 표지가 있는 Run 의 `run_changed` 는 payload 에 `tree`(그 표지)를 싣는다. 트리 영역이 있는 대시보드는 바뀐 Run 이 **자기 Run 이거나 `tree` 가 자기 트리와 같을 때만** 다시 받는다. 다른 트리·트리 아닌 Run 의 변경으로는 요청하지 않는다 | 필수 |

### 3.7 묶음 U — 트리 중복 방지 (FR-ITU-\*)

| ID | 요구 | 우선 |
|---|---|---|
| FR-ITU-1 | `dmctl run start --tree <owner/repo#N> [--branch]` 는 Run 에 트리 표지를 기록한다. `--branch` 가 없으면 루트 Run, 있으면 병렬 가지의 Run 이다 | 필수 |
| FR-ITU-2 | 같은 트리 표지의 **열린** Run 이 있으면 루트 Run 을 새로 열지 않는다. 오류 코드 `tree_open` 과 그 Run 의 id 를 낸다 | 필수 |
| FR-ITU-3 | 가지 Run(`--branch`)은 같은 트리의 열린 루트 Run 이 있을 때만 연다. 없으면 `tree_not_open` 이다 | 필수 |
| FR-ITU-4 | 트리 표지가 있는 Run 에 멤버를 등록할 때, 같은 트리의 열린 Run 들 안에 **같은 역할 이름**(사슬 이름 = 같은 이슈)의 멤버가 있으면 거절한다. 오류 코드 `node_taken` | 필수 |
| FR-ITU-5 | `tree_open` 응답에는 그 트리가 **멈췄는지**(`stale`)를 싣는다. 열린 Run 의 멤버 도구가 하나도 살아 있지 않으면 멈춘 트리다. 멈춘 트리는 `dmctl run close --run <id> --force` 로 정리한 뒤 다시 열 수 있다 | 필수 |
| FR-ITU-6 | 발사대는 `tree_open` 을 받으면 멈춘다. `stale` 이면 사용자에게 정리할지 묻는다. 노드는 `node_taken` 을 받으면 그 하위를 띄우지 않고 부모에게 보고한다 | 필수 |

### 3.8 비기능 요구사항 (Non-functional)

| ID | 요구 |
|---|---|
| NFR-SLP-1 | `dmctl statusline` 의 서버 보고는 100ms 안에 끝나거나 버린다. 프록시가 하위 명령 실행 시간에 더하는 지연은 보고 시간 외에 10ms 이하다 |
| NFR-SLP-2 | 프록시가 하위 명령에 넘기는 stdin 은 받은 것과 바이트 단위로 같다 |
| NFR-WGR-1 | 그룹 기능을 쓰지 않는 워크스페이스는 지금과 똑같이 보이고 저장된다(필드 추가 없음) |
| NFR-WGR-2 | window 200개, 그룹 20개에서 사이드바 다시 그리기가 지금보다 눈에 띄게 느려지지 않는다(`reconcileList` 경로 유지) |
| NFR-ORD-1 | 새 dmctl 명령은 모두 `dmctl --help` 와 명령 문서(`check-commands-docs.sh`)에 실린다. 어떤 레이아웃 명령도 `--help` 를 받으면 **실행하지 않고** 도움말만 낸다 (§7 R-5) |
| NFR-IAT-1 | 명령 문서는 스킬 계약 시험(`skills_contract_test.go`)을 통과한다: 화면 fingerprint 금지 · sleep 폴링 금지 · `--at` 에 탭 uuid · `--to` 에 toolId |

## 4. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| D-IAT-1 | 스킬이 아니라 **명령**이다 | GitHub 이슈 생성·닫기(외부 공개), window·worktree 생성을 한다. 사용자가 시키지 않으면 일어나면 안 된다. `migration` 과 같은 판단(D-M10-8) |
| D-IAT-2 | 입력은 **아무 이슈**다 | 사용자가 트리의 어느 지점에서든 이어서 시작할 수 있어야 한다 |
| D-IAT-3 | 노드는 바로 아래 자식만 띄운다(재귀) | 트리를 키우는 규칙이 하나가 된다. 각 조상이 자기 이슈 맥락을 직접 읽는다 |
| D-IAT-4 | 커밋·이슈 닫기는 자동, push·사용자 브랜치 병합만 확인 | 사람이 붙어 있지 않아도 트리가 진행된다. 되돌리기 어려운 지점에서만 멈춘다. 사용자 결정 2026-11-05 |
| D-IAT-5 | 깊이는 탭, 병렬은 새 window | pane 은 한 번 나누면 다시 합칠 수 없다. 깊이마다 나누면 잎의 화면이 1/2ⁿ 로 준다 |
| D-IAT-6 | 가지 = Run = window = worktree. 병렬 첫째는 부모 것을 이어 쓴다 | Run 격리는 Run 하나에 값 하나다(FR-WKT-1). 가지마다 Run 을 두면 "사슬은 공유, 병렬은 따로"가 기존 값(`per-run`)만으로 표현된다. 첫째가 부모 것을 이어 쓰면 일하는 에이전트가 없는 window 가 생기지 않는다(window 수 = 잎 수) |
| D-IAT-7 | 이슈 규약은 프로젝트의 것이다 | 규약은 이 명령이 아니라 프로젝트에 묶인다. dongminal 이 복사하면 두 진실이 생긴다 |
| D-IAT-8 | 별칭은 자동 생성, 설정 파일 없음 | 별칭은 규약이 아니다. 저장소에 dongminal 전용 파일을 늘리지 않는다 |
| D-IAT-9 | 병렬 상한 없음 | 병렬 여부는 부모의 판단이다(FR-IAT-21·22). 사용자 결정 |
| D-IAT-10 | 그룹은 일반 기능 | 트리 밖의 window 도 정리할 수 있다. 모델이 Run 과 분리되어 단순하다 |
| D-IAT-11 | window 순서의 출처는 `ws.windows` 하나, 그룹은 붙어 있는 불변식 | `PANEL_SURFACE_SRS` D-9 가 경고한 "두 진실"을 피한다. 별도 최상위 순서 목록을 두면 `ws.windows` 와 어긋날 수 있다. 대가는 빈 그룹의 자리를 정할 수 없다는 것이고, FR-WGR-5 가 끝에 둔다 |
| D-IAT-12 | 맥락 사용률은 statusLine 입력에서 가져온다 | Claude Code 가 statusLine 에 주는 `used_percentage` 가 공식 값이다. transcript 계산은 창 크기를 추측한다. statusLine 명령은 하나만 등록되므로 dongminal 이 앞에 서서 하위 명령에 그대로 넘긴다 |
| D-IAT-13 | 순서 지정은 번호 · 한 칸 · 기준 uuid 셋 다 | 번호는 개수를 아는 에이전트에게, 한 칸은 사람에게, 기준 uuid 는 "이 탭 바로 뒤" 같은 트리 배치에 맞다. 사용자 결정 |
| D-IAT-14 | 묶음 넷을 SRS 하나에 둔다 | 사용자 결정. S·G·O 는 T 를 위해 생겼다 |
| D-IAT-16 | statusLine 입력에서 가져올 수 있는 값은 허용 목록으로 넓게 저장한다. 경로·본문은 뺀다 | 사용자 결정("어떤 것이 더 필요할지 모르니 가져올 수 있는 데이터는 많이"). 허용 목록으로 두는 이유: FR-CTX-3(숫자만, 경로 없음)을 지키고, Claude Code 가 새 필드를 더해도 모르는 값이 조용히 새지 않게 한다 |
| D-IAT-17 | team · workflow 스킬을 지운다. `dmctl run` 은 남긴다 | 사용자 결정. 이슈 트리가 Run 기록·worktree·대시보드를 쓴다 |
| D-IAT-18 | 트리 대시보드는 Run 기록만으로 진행 중인 경로를 그린다. 이슈 데이터 경로(`dmctl issue` 등)는 만들지 않는다 | 사용자 결정. dongminal 이 GitHub 이슈 모델을 알게 되면 범위가 넓어지고(이슈 규약은 프로젝트의 것, D-IAT-7), 에이전트는 이미 gh 로 정확히 읽는다. 끝난·안 연 이슈는 GitHub 화면이 더 잘 보인다. 시범 뒤 필요하면 다시 정한다 |
| D-IAT-19 | 부모 Run 필드를 두지 않는다 — 노드 관계는 사슬 이름에서 얻는다 | 역할 이름이 이미 트리 경로다. 같은 사실을 두 필드에 두면 어긋날 수 있다 |
| D-IAT-20 | 중복은 서버가 막는다 | 사용자 결정. 에이전트가 절차를 건너뛰어도 막혀야 한다 |
| D-IAT-15 | Run 의 격리 단위는 window, 이슈 트리의 격리 단위는 window 그룹이다 | 사용자 결정. 트리는 이름이 아니라 그룹의 트리 표지로 알아본다 — 이름은 사용자가 고칠 수 있으므로 식별자가 될 수 없다 |

## 5. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-SLP-1 | FR-SLP-4·5·7 | 단위: 임시 설정 트리(프로젝트 local·프로젝트·사용자)에서 하위 명령 선택 순서. 하위 명령이 받은 stdin 이 원본과 바이트로 같다. 설정 파일이 바뀌지 않았다 |
| TC-SLP-2 | FR-SLP-3·NFR-SLP-1 | 단위: 서버가 응답하지 않아도 하위 명령 출력이 나온다. 보고 단계가 100ms 를 넘지 않는다 |
| TC-SLP-3 | FR-SLP-6 | 단위: 하위 명령이 없으면 출력이 비어 있고 종료 코드는 0 |
| TC-SLP-4 | FR-SLP-10·11·20 | Go: statusLine 관측이 transcript 관측을 이긴다. `dmctl status --json` 의 `context.source`·`usage` |
| TC-SLP-7 | FR-SLP-2·2a | 단위: 실측 입력 표본에서 허용 목록 값만 나간다. `transcript_path`·`cwd`·`workspace`·모르는 새 필드는 나가지 않는다. `null` 은 싣지 않는다 |
| TC-SLP-5 | FR-SLP-1 전제 | 실측: `--settings` 로 넘긴 `statusLine` 이 사용자 설정의 `statusLine` 보다 우선한다. Claude Code 가 statusLine 을 실행하는 셸·작업 폴더(macOS·Windows) |
| TC-SLP-6 | FR-SLP-8 | Windows e2e 또는 수동: PowerShell 래퍼에서 하위 명령이 그려진다 |
| TC-WGR-1 | FR-WGR-2·4·5·6 | 단위: 불변식 복구, 빈 그룹의 자리, 없는 그룹 정리 |
| TC-WGR-2 | FR-WGR-12·13 | e2e: 그룹을 지워도 window 가 남는다. 그룹 안 window 를 닫고 되돌리면 원래 자리로 온다 |
| TC-WGR-3 | FR-WGR-20~24 | e2e: 머리·접기·끌어 넣기·그룹 통째 이동 |
| TC-WGR-4 | FR-WGR-30~36 | e2e: dmctl 그룹 명령 전부. uuid 아닌 지목 거부 |
| TC-WGR-5 | NFR-WGR-1 | 단위: 그룹을 안 쓰면 저장 결과가 변경 전과 같다 |
| TC-ORD-1 | FR-ORD-1~8 | 단위: 위치 해석(번호 범위·끝에서 한 칸·기준이 다른 담는 곳·제자리) |
| TC-ORD-2 | FR-ORD-10·11 | e2e: `move-tab` 같은 칸·다른 칸·다른 window, `new-tab --after` |
| TC-ORD-3 | FR-ORD-20~24 | e2e: `move-window`·`move-group` 이 불변식을 지킨다 |
| TC-ORD-4 | FR-ORD-30·31 | e2e: `list-workspace` 의 순서·개수 |
| TC-ORD-5 | NFR-ORD-1 | 단위: 모든 dmctl 레이아웃 명령에 `--help` 를 주면 서버에 아무것도 보내지 않는다 |
| TC-IAT-1 | NFR-IAT-1 | Go: `skills_contract_test.go` 에 `issue-tree.md` 가 들어간다 |
| TC-IAT-2 | FR-IAT-40·41 | 단위(문서 예시 대조): 별칭 규칙과 사슬 이름 예시가 규칙과 맞다 |
| TC-SKX-1 | FR-SKX-1~4 | Go: 임베드 트리에 `skills/team`·`skills/workflow` 가 없다. 플러그인 문서·주입 문구에 `/dongminal:team`·`/dongminal:workflow` 가 없다 |
| TC-ITD-1 | FR-ITD-2 | 단위: 사슬 이름에서 부모를 찾는 규칙(빠진 중간 노드 포함) |
| TC-ITD-2 | FR-ITD-5 | Go: `GET /api/runs/tree` 가 같은 트리의 열린 Run 만 모으고 노드에 상태를 싣는다 |
| TC-ITD-3 | FR-ITD-1·3·4 | e2e: 트리 Run 의 대시보드에 이슈 트리가 서고, 잎이 구분되며, 노드를 누르면 그 탭으로 간다 |
| TC-ITD-4 | FR-ITD-7 | Go: 트리 Run 의 `run_changed` 가 `tree` 를 싣고, 트리 아닌 Run 은 싣지 않는다. 단위(JS): 트리 뷰가 같은 트리의 다른 Run 변경에는 다시 받고, 다른 트리·트리 아닌 Run 의 변경에는 받지 않는다 |
| TC-ITU-1 | FR-ITU-1~5 | Go: `tree_open`(stale 포함) · `tree_not_open` · `node_taken` · 정리 뒤 다시 열기 |
| TC-IAT-3 | 묶음 T 전체 | 시범: rust-wasm 저장소의 #35 트리. 그 저장소 세션이 #62 를 커밋한 **뒤에** 한다. 확인 항목: 위쪽·아래쪽 펼치기, 이름, 그룹, 질문 경로, 커밋·닫기, push 확인, 정리 |

## 6. 비목표 (Non-goals)

- 병렬 가지 결과의 자동 비교·자동 병합(orca 에도 없다)
- 그룹 안의 그룹
- 이슈 규약의 정의·저장
- Claude 가 아닌 에이전트(codex·omp)의 statusLine 프록시. 그 에이전트는 지금의 transcript 계산을 쓴다
- 동시 병렬 상한
- 측정 중 빌드 잠금 같은 자원 잠금 장치
- 칸 나누기를 이용한 트리 표시

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | `--settings` 의 `statusLine` 이 사용자 설정보다 우선하지 않으면 프록시가 서지 않는다 | **해소** | TC-SLP-5 실측(2026-11-05, Claude Code 2.1.318, macOS): `--settings` 의 statusLine 이 사용자 설정의 statusLine 대신 실행됐다. 작업 폴더는 프로젝트 폴더, 환경에 `DONGMINAL_TOOL_ID` 가 있다. stdin 에 `workspace.project_dir` 가 있다. 첫 응답 전에는 `used_percentage`·`current_usage` 가 `null` 이다. Windows 는 TC-SLP-6 에서 확인한다 |
| R-2 | 하위 statusLine 명령이 `padding` 같은 설정을 쓰면, dongminal 의 `statusLine` 객체가 그 값을 덮는다 | LOW | 프록시가 하위 설정의 `padding` 을 읽어 쓸 수 없으면 그 차이를 문서에 적는다 |
| R-3 | 번호 지정은 다른 에이전트의 동시 조작과 경합한다 | MEDIUM | FR-ORD-6: 적용 순간에 해석하고 최종 위치를 돌려준다. 트리 명령은 기준 uuid(`--after`)를 쓴다 |
| R-4 | 빈 그룹이 늘 맨 끝에 있어 사용자가 기대한 자리와 다를 수 있다 | LOW | D-IAT-11 의 대가로 받아들인다. window 를 넣으면 자리를 얻는다 |
| R-5 | 지금 dmctl 레이아웃 명령은 `--help` 를 받으면 실제로 실행한다(2026-11-05 실측: `close-tab --help` 가 포커스 탭을 닫았고 `split-h --help` 가 칸을 나눴다). 새 명령이 같은 결함을 물려받으면 에이전트가 도움말을 보려다 트리를 망가뜨린다 | HIGH | NFR-ORD-1 · TC-ORD-5 로 기존 명령까지 고친다 |
| R-6 | 중간 노드의 맥락이 migration 기준 전에 자동 압축되면 판단 맥락을 잃는다 | MEDIUM | 기준 60%(FR-IAT-60), 안전 지점에서만 확인(FR-IAT-62) |
| R-7 | 병렬 가지 병합에서 충돌이 나면 부모가 풀지 못할 수 있다 | MEDIUM | 부모는 질문 경로(FR-IAT-53)로 사용자에게 묻는다. 병렬은 의존이 없을 때만 연다(FR-IAT-21) |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-07 | `ISSUE_TREE_OPS_SRS` 가 개정한다: 질문 경로(FR-IAT-51~54 → FR-ITA-30~34), `--ctx` 기본(FR-IAT-60 → FR-ITM-3·5), migration(FR-IAT-63 → FR-ITB-5), 탭 닫기(FR-IAT-73 → FR-ITA-41), 트리 부모(FR-ITD-2 → FR-ITC-1), 끝난 노드(FR-ITD-6 → FR-ITC-3), D-IAT-19 → D-ITO-10. 이 문서의 본문은 기록으로 남긴다 |
| 2026-11-05 | FR-ITD-7 추가: 트리 뷰가 모든 `run_changed` 에 트리를 다시 받던 것을 같은 트리의 변경으로 좁혔다. 이전 동작: 트리 영역이 있는 뷰는 어느 Run 이 바뀌어도 `/graph`·`/tree` 를 다시 받았다. 새 동작: 자기 Run 이거나 같은 트리일 때만. 이유: 무관한 Run 의 변경마다 요청 두 개가 나갔다 (REFACTOR_PROD2 후보 7) |
| 2026-11-05 | 묶음 X·D·U 구현. 트리 노드는 graph 와 같은 명시 선택(brief 없음). `run-dashboard.js` 가 500줄을 넘지 않게 `run-tree.js` 로 갈랐다 |
| 2026-11-05 | 묶음 X(team·workflow 정리) · D(트리 대시보드) · U(트리 중복 방지) 추가 (D-IAT-17~20) |
| 2026-11-05 | 묶음 T: `commands/issue-tree.md` 와 계약 시험(TC-IAT-1). FR-SLP-4 에 `disableAllHooks`·`project_dir` 기준을 더했다(보안 검토 반영) |
| 2026-11-05 | 묶음 O·G·S 구현. R-5(`--help` 가 레이아웃 명령을 실행하던 결함) 수정 |
| 2026-11-05 | FR-WGR-34·FR-ORD-30·31: `list-workspace --json` 은 행 배열을 유지하고 순서 필드를 더한다. 빈 그룹은 `list-groups` 가 낸다 |
| 2026-11-05 | FR-SLP-2·2a·20 확장: 사용률뿐 아니라 statusLine 입력의 비용·한도·모델 등을 허용 목록으로 저장하고 `dmctl status` 의 `usage` 로 낸다(D-IAT-16) |
| 2026-11-05 | 승인(사용자). TC-SLP-5 실측으로 R-1 해소, FR-SLP-2 에 `null` 처리 추가 |
| 2026-11-05 | 초안. 결정 경위는 `/Users/dykim/p6w-backup/issue-agent-skill-handoff.md` 「정한 것」 |
