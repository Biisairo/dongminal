---
name: dongminal-workflow
description: 재사용 가능한 멀티 CC 워크플로우 정의서의 작성·실행·관리 스킬. "워크플로우 만들어/저장해/실행해/목록 보여줘", "저장된 팀 구성으로 돌려줘", "지난번 그 팀 구성 다시", "/dongminal-workflow" 류의 재사용 의도면 이 스킬을 써라. 1회성 팀 구성("팀 만들어서 X 해줘")은 dongminal-team 스킬이 담당 — 저장·재사용 의도가 보일 때만 이 스킬.
---

# dongminal-workflow

팀 구성(역할·모델·수) + 메시지 토폴로지 + 역할별 지시 + 보고 규약을 **정의서 파일**로 저장해두고, 이름만으로 반복 실행하는 스킬. 실행 메커니즘은 dongminal-team 의 검증된 규칙을 그대로 따른다.

- 정의서 위치: `${DONGMINAL_HOME:-~/.dongminal}/workflows/<name>.md`
- 정의서 형식: Markdown + YAML frontmatter — `references/definition-format.md`
- 헬퍼: `scripts/render_workflow.py` (검증·파라미터 치환·구조 추출)

## 서브커맨드

| 의도 | 동작 |
|------|------|
| create | 인터뷰로 정의서 생성·저장 |
| run `<name>` [param=value ...] | 정의서 실행 |
| list | 저장된 정의서 목록 |
| show `<name>` | 정의서 전문 표시 |
| edit `<name>` | 대화로 수정 (diff 요약 제시 후 저장) |
| delete `<name>` | 확인 후 삭제 |

---

## create — 정의서 작성

인터뷰로 다음을 확정한 뒤 정의서를 생성한다 (한 번에 한 질문, 코드/기존 정의서로 답할 수 있으면 묻지 않는다):

1. **목적** — 이 워크플로우가 반복할 작업이 무엇인가. → `name`(kebab-case)·`description`
2. **팀 구성** — 역할 몇 개, 각자 무슨 일, 모델(opus/sonnet/haiku). 같은 역할 N 명이면 `count`.
3. **토폴로지** — 누가 먼저 시작(kickoff.to), 누가 누구에게 보내는지, 라운드 수, 종료 조건. → 본문 `## 프로세스`
4. **보고** — 최종 보고자(report.from) 와 task_id. 중간 보고 여부.
5. **파라미터화** — 실행마다 바뀌는 부분({{topic}} 등)을 `params` 로 추출.

작성 규칙:
- 형식은 `references/definition-format.md` 의 스키마를 따른다.
- **uuid 를 정의서에 절대 하드코딩하지 않는다** — team id 는 논리 이름, 실행 시 uuid 로 매핑.
- 저장 전 전문을 사용자에게 보여 확인. 동명 파일 존재 시 덮어쓰기 확인.
- 저장 후 `python3 scripts/render_workflow.py <파일> --list-params` 로 검증 통과 확인.

## run — 정의서 실행

### 0. 로드·검증·치환

```bash
python3 scripts/render_workflow.py ~/.dongminal/workflows/<name>.md --json --param topic=... 
```

- rc=1 + "필수 파라미터 누락" → **팀 생성 시작 전에** 사용자에게 누락 param 질문.
- 출력 JSON: `team[]` (count 전개 + 인스턴스별 `role_prompt`), `kickoff`, `report`, `teardown`, `process`.

### 세션 모드 — JSON `session` 필드로 분기

**`dedicated` (전용 세션 — 권장)**: 워크플로우가 자기만의 세션에서 실행. 사용자 화면 완전 무손상, 사이드바가 잡 대시보드 역할.

1. `workspace_command(action=newSession, name=<워크플로우 이름>, keepFocus=true)` — 백그라운드 세션 생성. **응답의 `newTabs[0]` = 시드 pane 의 {uuid, paneId}** (재조회 불필요), `newSessions[0]` = 세션 uuid.
2. 시드에 `splitH/V(location=<시드 uuid>, count=N, keepFocus=true)` — 전용 세션이라 보스 화면 비율 무관, `plan_layout.py` 없이 단순 균등 분할로 충분. **응답의 `newTabs` 가 새 팀원 pane 의 {uuid, paneId} 배열** — 이게 팀원 식별자다. (list_panes diff/이름필터 불필요 — 생성 명령이 직접 반환)
3. 이후 부팅·Barrier·Kickoff 는 아래 inline 과 동일.
5. **해체**: 팀원 전부 `/exit` → `closeTab(location=<uuid>)` 연쇄. 마지막 탭이 닫히면 세션이 자동 제거된다 — `closeSession` 은 사용하지 않는다 (포커스 안전 보장 없음).

**`inline` (기본)**: 보스 region 옆 분할 — 기존 dongminal-team 1~3단계 그대로.

### 1~8. 팀 구성·실행 — dongminal-team 규칙 그대로

이하 모든 단계는 **dongminal-team 스킬의 절대 원칙 4개**를 따른다 (상세는 `skills/dongminal-team/SKILL.md` 와 그 references — 본 스킬에서 재정의하지 않음):

1. 항상 새 팀 — 기존 pane 재사용 금지
2. 사용자 포커스 금지 — 모든 `workspace_command` 는 `location=<uuid>` + `keepFocus=true`, `focus` 액션 금지
3. Barrier 전 Kickoff 금지 — 대기 프롬프트로 부팅, 같은 턴 안에서 Barrier → Kickoff
4. 식별자는 항상 uuid

정의서 → dongminal-team 단계 매핑:

| dongminal-team 단계 | 정의서에서 가져오는 것 |
|---|---|
| 1. 레이아웃 계획 | 팀원 수 = JSON `team` 배열 길이. inline 이면 `plan_layout.py --n <길이>`, dedicated 면 위 세션 모드 절차. **split/newSession 응답의 `newTabs` 로 팀원 uuid+paneId 즉시 확보** (list_panes diff 대체) |
| 4. 팀원 부팅 | 팀원별 `build_prompt.py --model <model> --role <role>` + **`role_prompt` 를 역할 상세로 주입**. `process` 는 `--process` 인자로 |
| 6. Kickoff | `kickoff.to` 의 인스턴스 uuid 에게 `kickoff.message` 송신 |
| 7. 답장 대기 | `report.from` 의 `[TEAM-REPLY task-id=<report.task_id>]` 가 최종 보고 |
| 8. 해체 | `teardown: confirm`(기본) → 사용자 확인 후 `/exit`. `teardown: auto` → 보고 직후 자동 `/exit` (closeTab 은 항상 사용자 확인) |

team id ↔ uuid 매핑표는 부팅 직후 작성해 보관한다 (예: `writer → 550e84..`). kickoff·진단·해체 모두 이 매핑으로.

**역할명 부여** — pane 확보 직후, 부팅 전에 각 팀원 pane 에 역할명을 붙인다 (사이드바·탭바 관전성):

```
workspace_command(action=renameTab, location=<uuid>, name=<team id>)   # 팀원마다
```

## list / show / edit / delete

```bash
ls ${DONGMINAL_HOME:-~/.dongminal}/workflows/*.md   # list (없으면 "(없음)" + create 안내)
```

- **show**: 파일 전문 + `--list-params` 출력 표시.
- **edit**: 수정 요구 인터뷰 → 수정 전후 diff 요약 제시 → 확인 후 저장 → render 검증.
- **delete**: 파일명 확인 후 `rm`. 복구 불가 고지.

---

## 체크리스트 (run)

1. [ ] `render_workflow.py --json` 검증 통과 (param 누락 시 먼저 질문)
2. [ ] 팀원 N pane 확보 — `session` 필드 분기: dedicated 면 newSession(name, keepFocus=true) → **split 응답 newTabs 로 팀원 uuid+paneId 수집** / inline 이면 dongminal-team 1~3단계
3. [ ] team id ↔ uuid 매핑표 작성 + `renameTab` 으로 각 pane 에 역할명 부여
4. [ ] 팀원별 `build_prompt.py` + `role_prompt` 로 병렬 부팅
5. [ ] 같은 턴: Barrier → `kickoff.to` 에게 `kickoff.message` 송신 → Thinking 확인
6. [ ] `report.from` 의 TEAM-REPLY 수신 → 사용자 보고
7. [ ] teardown 정책대로 해체

## 더 깊이 읽을 때

- `references/definition-format.md` — 정의서 스키마 전체 명세 + 예시
- `templates/poem-critique.md` — 예시 정의서 (복사해서 시작점으로)
- `skills/dongminal-team/references/` — 레이아웃·프롬프트·트러블슈팅 (실행 엔진)
- `evals/test-scenarios.md` — 검증 시나리오
