---
name: workflow
description: 재사용 가능한 멀티 CC 워크플로우 정의서의 작성·실행·관리 스킬. "워크플로우 만들어/저장해/실행해/목록 보여줘", "저장된 팀 구성으로 돌려줘", "지난번 그 팀 구성 다시", "/dongminal:workflow" 류의 재사용 의도면 이 스킬을 써라. 1회성 팀 구성("팀 만들어서 X 해줘")은 /dongminal:team 스킬이 담당 — 저장·재사용 의도가 보일 때만 이 스킬.
---

# workflow

팀 구성(역할·모델·수) + 메시지 토폴로지 + 역할별 지시 + 보고 규약을 **정의서 파일**로 저장해두고, 이름만으로 반복 실행하는 스킬. 실행 메커니즘은 `/dongminal:team` 의 검증된 규칙을 그대로 따른다.

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
- **`session: dedicated` 를 명시한다.** 렌더러의 하위호환 기본값은 `inline` 이지만, 새로 만드는 정의서는 전용 창을 쓴다 — 사용자 화면을 침범하지 않고, 같은 워크플로우를 여러 개 병렬로 돌릴 수 있다.
- **uuid 를 정의서에 절대 하드코딩하지 않는다** — team id 는 논리 이름, 실행 시 uuid 로 매핑.
- 저장 전 전문을 사용자에게 보여 확인. 동명 파일 존재 시 덮어쓰기 확인.
- 저장 후 `python3 scripts/render_workflow.py <파일> --list-params` 로 검증 통과 확인.

## run — 정의서 실행

### 0. 로드·검증·치환

```bash
python3 scripts/render_workflow.py ~/.dongminal/workflows/<name>.md --json --param topic=...
```

- rc=1 + "필수 파라미터 누락" → **팀 생성 시작 전에** 사용자에게 누락 param 질문.
- 출력 JSON: `team[]` (count 전개 + 인스턴스별 `role_prompt`), `kickoff`, `report`, `teardown`, `process`, `session`.

### 정의서 → Run 파라미터 사상

| 정의서 | Run |
|---|---|
| `session: dedicated` | `dmctl run start --window <전용 창 uuid>` (기본 projection) |
| `session: inline` | 조정자 창을 분할. `--window` 없이 `--projection inline` |
| `description` (또는 목적 한 줄) | `dmctl run start --objective` |
| `team[].id` | `dmctl run member --role` + `dmctl rename-tab` |
| `team[].model` | `dmctl run launch --model` |
| `team[].role` + `role_prompt` + `process` | `dmctl run member --brief -` 의 stdin 본문 |
| `kickoff.to` / `kickoff.message` | Barrier 통과 후 `dmctl msg --to <그 인스턴스 탭>` |
| `report.from` / `report.task_id` | `dmctl run status --run <uuid>` 에서 그 멤버의 보고를 읽는다 |
| `teardown: confirm\|auto` | `dmctl run close --run <uuid>` 시점 정책 |

**격리는 정의서의 항목이 아니다.** 정의서가 아니라 실행 시점의 선택이며, 기본은
`none` 이다. 팀원들이 같은 파일을 동시에 고치는 구성일 때만 `dmctl run start` 에
`--isolation per-member` 를 더하고, 그 뒤 절차(기동 전 `cd`, 해체 시 잔여물 보고)는
`/dongminal:team` 의 §3.5 를 그대로 따른다.

**team id ↔ uuid 매핑표를 대화 기록에 보관하지 않는다.** 진실은 `dmctl run status --run <uuid>` 이며, `role` 이 곧 team id 다. 컨텍스트가 압축돼도 Run id 하나로 전원을 되찾는다.

### 1. 공간 확보

**`dedicated`** (권장):

```bash
dmctl new-window --name "<워크플로우 이름>" -n
```

응답의 `newWindows[0]` = 창 uuid, `newTabs[0].uuid` = 시드 탭. 그 안에서 팀원 수만큼 분할한다:

```bash
dmctl split-h "$N" --at "$SEED" -n
```

전용 창이라 사용자 화면 비율과 무관하다 — 단순 균등 분할로 충분하고 `plan_layout.py` 가 필요 없다.

**`inline`**: 조정자 창을 분할한다 — `/dongminal:team` 의 `references/layout.md` 절차(`plan_layout.py`)를 따른다.

### 2~7. 실행 — `/dongminal:team` 워크플로우 그대로

이하 모든 단계는 **`/dongminal:team` 의 절대 원칙 3개**를 따른다 (상세는 `../team/SKILL.md` — 본 스킬에서 재정의하지 않는다):

1. 항상 새 팀, 전용 창에서
2. Kickoff 는 `dmctl wait --for ready` 뒤에만
3. 매핑표는 기록(`dmctl run status`)에 있다

정의서가 채우는 값만 다르다:

```bash
RUN=$(dmctl run start --objective "<description>" --window "$WIN" | sed -n 's/^run=\([^ ]*\).*/\1/p')

# team[] 각 인스턴스마다
dmctl rename-tab --at "$TAB" "<team id>"
dmctl run member --run "$RUN" --role "<team id>" --agent claude --at "$TAB" --brief - <<'B'
<role 한 줄> + <role_prompt> + <process 요약>
B

# 병렬 기동 (한 Bash 호출에서 & + wait)
dmctl run launch --member "$M" --model "<team[].model>" | dmctl send-input --at "$TAB" --execute - &
```

Barrier(`dmctl wait --for ready`) → `kickoff.to` 에게 `kickoff.message` 송신 → `dmctl status` 로 `working` 확인까지 **같은 턴 안에서** 끝낸다.

### 8. 해체

`report.from` 의 보고가 기록에 들어오면 (`dmctl run status --run "$RUN"` 에서 그 멤버가 `done`/`failed`) 사용자에게 결과를 보고한다.

- `teardown: confirm` (기본) — 사용자 확인 후 정리
- `teardown: auto` — 보고 직후 자동 정리. 단 **탭 제거는 항상 사용자 확인**

```bash
dmctl run close --run "$RUN"          # 미보고 멤버가 있으면 거부 + 목록
dmctl send-input --at "$TAB" --execute "/exit"
dmctl close-tab --at "$TAB"
```

마지막 탭이 닫히면 전용 창은 스스로 사라진다 — `close-window` 를 쓰지 않는다.

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
2. [ ] `session` 분기 — `dedicated` 면 `dmctl new-window --name <이름> -n` → `split-h "$N" --at <시드> -n`, `inline` 이면 `../team/references/layout.md` 절차
3. [ ] `dmctl run start --objective <description> --window <창 uuid>` → RUN
4. [ ] team 인스턴스마다 `rename-tab` + `dmctl run member ... --brief -` (role + role_prompt + process)
5. [ ] **한 `Bash` 호출에서 `&` + `wait`** 로 `dmctl run launch --member <m> --model <model> | dmctl send-input --at <탭> --execute -`
6. [ ] **같은 턴 안에서** 인스턴스마다 `dmctl wait --at <탭> --for ready` → `kickoff.to` 에게 `kickoff.message` → `dmctl status` 로 `working` 확인
7. [ ] `dmctl run status --run "$RUN"` 로 `report.from` 의 보고 확인 → 사용자 보고
8. [ ] `teardown` 정책대로 `dmctl run close` → `/exit` → `close-tab`

## 더 깊이 읽을 때

- `references/definition-format.md` — 정의서 스키마 전체 명세 + 예시
- `templates/poem-critique.md` — 예시 정의서 (복사해서 시작점으로)
- `../team/SKILL.md` — 실행 엔진 (워크플로우·Barrier·해체)
- `../team/references/troubleshooting.md` — 실패 모드 진단
- `evals/test-scenarios.md` — 검증 시나리오
