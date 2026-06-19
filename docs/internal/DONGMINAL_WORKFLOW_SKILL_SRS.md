# SRS: dongminal-workflow 스킬 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`dongminal-team` 스킬은 매 호출마다 팀장 CC 가 패턴(파이프라인/fan-out/GAN/허브앤스포크)을 **즉흥으로 조립**한다. 같은 팀 구성을 반복 사용하려면 사용자가 매번 전체 요구를 다시 설명해야 하고, 실행마다 구성이 미묘하게 달라진다.

본 SRS 는 **재사용 가능한 워크플로우 정의서** 개념을 도입하는 새 스킬 `dongminal-workflow` 를 정의한다:
- 정의서 = 팀 구성(역할·모델·수) + 메시지 토폴로지 + 역할별 지시 + 보고 규약을 담은 Markdown(+YAML frontmatter) 파일.
- 스킬 = 정의서의 **작성(대화 인터뷰) / 실행(run) / 관리(list·show·edit·delete)** 전체 라이프사이클 담당.
- 실행의 메커니즘(분할·부팅·Barrier·Kickoff·해체)은 `dongminal-team` 의 검증된 규칙·스크립트를 참조해 재사용 — 중복 정의 금지.

직접 동기: `dmctl who-am-i` + `keepFocus` 수정으로 "사용자 포커스를 건드리지 않는 멀티 pane 자동 구성"이 완성됨 — 이 위에 반복 가능한 워크플로우를 얹는 것이 본 스킬.

### 1.2 범위 (Scope)
- **신규**: `skills/dongminal-workflow/SKILL.md` — 트리거 조건, 서브커맨드, 실행 절차.
- **신규**: `skills/dongminal-workflow/references/definition-format.md` — 정의서 스키마 명세 + 작성 가이드.
- **신규**: `skills/dongminal-workflow/scripts/render_workflow.py` — 정의서 파싱·검증·파라미터 치환 헬퍼 (stdlib only).
- **신규**: `skills/dongminal-workflow/templates/poem-critique.md` — 예시 정의서 (dongminal-team evals 시나리오 1 을 정의서화).
- **신규**: `skills/dongminal-workflow/evals/test-scenarios.md` — 검증 시나리오.
- **비범위**: `dongminal-team` 스킬 본문 수정, dongminal 서버/MCP 코드 수정.

### 1.3 정의 (Definitions)
- **정의서 (workflow definition)**: `~/.dongminal/workflows/<name>.md` 에 저장되는 Markdown + YAML frontmatter 파일. 한 파일 = 한 워크플로우.
- **워크플로우 홈**: `${DONGMINAL_HOME:-~/.dongminal}/workflows/`. 디렉토리 부재 시 첫 저장에서 생성.
- **파라미터**: frontmatter `params` 에 선언되고 본문에서 `{{name}}` 으로 치환되는 런타임 인자.
- **실행 엔진 규칙**: `skills/dongminal-team/SKILL.md` 의 절대 원칙 4개 + references (layout/prompt/troubleshooting) + scripts (plan_layout.py, build_prompt.py).

### 1.4 참고 (References)
- `skills/dongminal-team/SKILL.md` — 절대 원칙(항상 새 팀 / 포커스 금지 / Barrier 전 Kickoff 금지 / uuid 식별), 8단계 워크플로우.
- `skills/dongminal-team/references/models_and_patterns.md` — 패턴 카탈로그 (정의서가 정형화할 대상).
- `DMCTL_WHO_AM_I_SRS.md`, `SPLIT_KEEPFOCUS_FIX_SRS.md` — 본 스킬이 의존하는 직전 작업.

### 1.5 개요 (Overview)
2장 현황, 3장 요구사항(스킬 동작 + 정의서 스키마), 4장 검증, 5장 비목표.

---

## 2. 현황 (Identified Issues)

### 2.1 WFS-1 — 팀 구성의 재사용 불가
- **현상**: dongminal-team 은 1회성. 같은 "시 비평 4인 파이프라인"을 다시 돌리려면 사용자가 역할·모델·토폴로지·보고 규약을 전부 재설명.
- **영향**: 구성 누락·변형으로 실행마다 품질 편차. 반복 작업 비용.

### 2.2 WFS-2 — 패턴이 문서로만 존재
- **현상**: `models_and_patterns.md` 의 패턴 6종은 산문 카탈로그일 뿐, 실행 가능한 형태가 아니다.
- **영향**: 팀장 CC 가 패턴을 매번 재해석. 정형화된 검증 불가.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 — 스킬 동작 (Functional / Skill)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-WFS-1** | 스킬 이름 `dongminal-workflow`. 트리거: "워크플로우 만들어/저장해/실행해/목록", "저장된 팀 구성으로", "/dongminal-workflow" 류 의도. 1회성 팀 의도("팀 만들어서 X 해줘")는 dongminal-team 에 양보 — 본 스킬은 **재사용 의도**가 보일 때만. | 필수 |
| **FR-WFS-2** | **create**: 사용자와 인터뷰(목적 → 역할 수·모델 → 토폴로지 → 보고 규약 → 파라미터화할 부분)로 정의서를 생성, `~/.dongminal/workflows/<name>.md` 에 저장. 저장 전 전문을 사용자에게 보여 확인받는다. 동명 파일 존재 시 덮어쓰기 전 확인. | 필수 |
| **FR-WFS-3** | **run `<name>` [param=value ...]**: 정의서 로드 → `scripts/render_workflow.py` 로 검증·치환 → dongminal-team 실행 규칙에 따라 팀 구성·부팅·Barrier·Kickoff → 답장 수집 → 정의서의 보고 규약대로 사용자에 보고. 필수 파라미터 누락 시 실행 전에 사용자에게 질문. | 필수 |
| **FR-WFS-4** | **list**: 워크플로우 홈의 정의서 목록 (name + description + params 요약). 디렉토리 없거나 비면 "(없음)" + create 안내. | 필수 |
| **FR-WFS-5** | **show `<name>`**: 정의서 전문 표시. **edit `<name>`**: 대화로 수정 후 동일 경로 저장(수정 전후 diff 요약 제시). **delete `<name>`**: 사용자 확인 후 삭제. | 필수 |
| **FR-WFS-6** | run 의 실행 메커니즘은 dongminal-team 의 절대 원칙 4개를 그대로 따른다: ① 항상 새 팀(기존 pane 재사용 금지) ② 모든 workspace_command 는 `location=<uuid>` + `keepFocus=true`, `focus` 액션 금지 ③ Barrier 전 Kickoff 금지(대기 프롬프트 + 같은 턴 내 Barrier→Kickoff) ④ 식별자는 항상 uuid. SKILL.md 는 이 원칙들을 **참조**로 명시하고 세부 절차는 `skills/dongminal-team/` 의 references/scripts 경로를 가리킨다 — 본문 복제 금지. | 필수 |
| **FR-WFS-7** | run 종료 후 해체는 dongminal-team 8단계와 동일: 사용자 확인 후 `/exit` → (요청 시) `closeTab(location=<uuid>)`. 정의서에 `teardown: auto` 가 선언된 경우에만 보고 직후 자동 `/exit` (closeTab 은 항상 사용자 확인). | 필수 |
| **FR-WFS-8** | 정의서의 `team[].count` (동일 역할 복수) 지원 — fan-out 패턴. 치환 시 `{{index}}` (1-base) 를 역할 지시 안에서 사용 가능. | 필수 |

### 3.2 기능 요구사항 — 정의서 스키마 (Functional / Definition)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-WFD-1** | frontmatter 필수 키: `name` (파일명과 일치, `[a-z0-9-]+`), `description` (한 줄), `team` (1개 이상). | 필수 |
| **FR-WFD-2** | `team[]` 원소: `id` (정의서 내 유일, `[a-z0-9_]+`), `role` (한 줄 요약), `model` (opus/sonnet/haiku 또는 full model ID), 선택 `count` (기본 1, ≥2 면 fan-out). | 필수 |
| **FR-WFD-3** | 선택 키: `params[]` (`name`, `required` bool, `description`, 선택 `default`), `kickoff` (`to`: team id — 첫 지시 수신자, `message`: kickoff 본문 템플릿), `report` (`from`: team id, `task_id`: 문자열), `teardown` (`confirm`(기본)/`auto`), `session` (`inline`(기본)/`dedicated`). | 필수 |
| **FR-WFD-6** | `session: dedicated` 실행 모드 (REMOTE_SESSION_TAB_CREATE_SRS 기반): ① `workspace_command(newSession, name=<workflow name>, keepFocus=true)` 로 **백그라운드 전용 세션** 생성 — 사용자 포커스·화면 무변화. ② `list_panes` 의 `session="<name>"` 컬럼으로 새 세션의 시드 pane uuid 식별 (diff 불필요). ③ 시드에 `splitH/V(location=<seed uuid>, count=N, keepFocus=true)` 로 팀원 N pane 확보 — 전용 세션이라 보스 화면 비율 무관, 레이아웃 자유. ④ 부팅·Barrier·Kickoff 는 inline 모드와 동일. ⑤ 해체: 팀원 pane 전부 `/exit` 후 `closeTab(location=<uuid>)` 연쇄 — 마지막 탭 닫힐 때 세션 자동 제거 (closeSession 불필요·미사용). | 필수 |
| **FR-WFD-7** | `session: inline` (기본) 은 기존 dongminal-team 방식 — 보스 region 분할. `session` 키 검증: `inline`/`dedicated` 외 값은 render 단계 rc=1. | 필수 |
| **FR-WFD-4** | 본문(Markdown): `## 프로세스` 섹션 (메시지 흐름·라운드·종료 조건을 산문/목록으로) + `## 역할: <id>` 섹션 (해당 팀원 초기 프롬프트에 들어갈 역할 상세). 모든 본문에서 `{{param}}` 치환 허용. team id 는 실행 시 실제 uuid 로 매핑됨을 정의서 작성 가이드에 명시 — 정의서에는 uuid 를 절대 하드코딩하지 않는다. | 필수 |
| **FR-WFD-5** | `render_workflow.py` 는 다음을 수행: frontmatter 파싱(외부 의존 없이 stdlib), FR-WFD-1~3 검증(실패 시 메시지 + rc=1), `--param name=value` 받아 `{{...}}` 치환(필수 param 누락 시 rc=1 + 누락 목록), 결과를 `--json`(구조) 또는 기본(치환된 전문) 으로 stdout. `--list-params` 로 파라미터 명세만 출력. | 필수 |

### 3.3 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-WFS-0 | dongminal-team 스킬·references·scripts 무수정 (행위 보존). 본 스킬 추가가 기존 스킬 트리거에 영향 주지 않도록 description 에서 재사용 의도를 명확히 구분. |
| NFR-WFS-1 | `render_workflow.py` 는 Python 3 stdlib only (PyYAML 금지 — frontmatter 의 사용 부분집합만 자체 파싱). dongminal-team scripts 와 동일 정책. |
| NFR-WFS-2 | 정의서 검증은 결정적 — 같은 입력 같은 결과. 검증 실패 메시지는 키·행 단위로 구체적. |
| NFR-WFS-3 | 워크플로우 홈은 `DONGMINAL_HOME` 환경변수 우선, 미설정 시 `~/.dongminal`. |

### 3.4 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-WFS-1 | SKILL.md 는 dongminal-team 의 단계 본문을 복제하지 않는다 — 원칙 4개의 한 줄 요약 + 참조 경로만. 단일 진실 원천은 dongminal-team. |
| DC-WFS-2 | frontmatter 의 YAML 은 단순 부분집합(스칼라·리스트·1단 중첩 맵)만 사용 — render 스크립트의 자체 파서가 감당 가능한 범위로 스키마를 설계. |
| DC-WFS-3 | 정의서는 자기완결 — 실행자가 dongminal-workflow 스킬 없이 정의서만 읽어도 의도 파악 가능해야 한다 (사람 가독성). |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스 — render_workflow.py (자동)

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-WFR-1** | 유효 정의서 + 모든 param 제공 → 기본 출력 | 치환된 전문, `{{` 잔존 없음, rc=0 |
| **TC-WFR-2** | `--json` | name/description/team/params/kickoff/report 구조 JSON, rc=0 |
| **TC-WFR-3** | 필수 param 누락 | rc=1 + 누락 param 이름 명시 |
| **TC-WFR-4** | frontmatter 필수 키(name/team) 누락 | rc=1 + 누락 키 명시 |
| **TC-WFR-5** | team[].id 중복 | rc=1 + 중복 id 명시 |
| **TC-WFR-6** | default 있는 param 미제공 | default 로 치환, rc=0 |
| **TC-WFR-7** | `--list-params` | param 명세만 출력, rc=0 |
| **TC-WFR-8** | count≥2 역할의 `{{index}}` | 역할 인스턴스별 1-base 치환 (--json 의 expanded team 에서 확인) |
| **TC-WFR-9** | `session: dedicated` 선언 | `--json` 출력에 `"session":"dedicated"`. 미선언 시 `"inline"` |
| **TC-WFR-10** | `session: invalid-value` | rc=1 + 허용 값 안내 |

자동 테스트는 `skills/dongminal-workflow/scripts/test_render_workflow.py` (stdlib unittest) 로 작성, `python3 -m unittest` 로 실행.

### 4.2 시나리오 검증 — 스킬 동작 (evals, 수동/반자동)

- **TC-WFS-A (create→list→show)**: 대화로 2인 GAN 워크플로우 생성 → `~/.dongminal/workflows/` 에 파일 생성 확인 → list 에 노출 → show 가 전문 표시.
- **TC-WFS-B (run 해피패스)**: 템플릿 `poem-critique` 를 `topic` param 으로 실행 → 팀 부팅·Barrier·Kickoff·보고가 dongminal-team 규칙대로 (uuid 식별, keepFocus, 사용자 ▶ 미이동) 진행.
- **TC-WFS-C (param 누락)**: 필수 param 없이 run → 실행 전 사용자에게 질문 (팀 생성 시작 전).
- **TC-WFS-D (delete)**: 삭제 요청 → 확인 후 파일 제거, list 에서 사라짐.

### 4.3 완료 조건 (DoD)

- [ ] `SKILL.md` + `references/definition-format.md` + `templates/poem-critique.md` + `evals/test-scenarios.md` 작성.
- [ ] `scripts/render_workflow.py` + `scripts/test_render_workflow.py` 작성, TC-WFR-1~8 green.
- [ ] 정의서 템플릿이 render 스크립트 검증 통과.
- [ ] dongminal-team 디렉토리 무변경 (`git status` 확인).
- [ ] (선택, 사용자 참여) TC-WFS-B 라이브 1회.

---

## 5. 비목표 (Non-goals)

- 멀티 페이즈 장기 워크플로우(세션 넘어 이어가는 상태 추적) — 후속 검토.
- 정의서의 조건 분기/루프 같은 프로그래밍 구조 — 본문은 산문 프로세스 기술. LLM 실행자가 해석.
- Claude Code 내장 `Workflow` tool 과의 통합 — 별개 메커니즘 (내장 Workflow 는 subagent, 본 스킬은 dongminal pane 의 독립 CC).
- 정의서 버전 관리·마이그레이션 — v1 스키마 고정, 변경 시 추가 SRS.
- dongminal-team 의 패턴 카탈로그 문서를 정의서로 일괄 변환 — 템플릿 1개(poem-critique)만 제공, 나머지는 사용자가 create 로.
- 서버/MCP/dmctl 코드 변경 — 전혀 없음.

---

## 6. 의존 / 후속

- 의존: `dongminal-team` 스킬 (실행 엔진 규칙), `DMCTL_WHO_AM_I_SRS` + `SPLIT_KEEPFOCUS_FIX_SRS` (포커스 안전 기반), `REMOTE_SESSION_TAB_CREATE_SRS` (`session: dedicated` 의 newSession name/keepFocus).
- 후속 후보: `HIERARCHICAL_TEAM_SRS` — 워크플로우 정의서에 계층(팀장 위임) 구조 도입 시.
