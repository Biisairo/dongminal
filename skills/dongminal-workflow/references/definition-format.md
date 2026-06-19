# 워크플로우 정의서 형식

`${DONGMINAL_HOME:-~/.dongminal}/workflows/<name>.md` — Markdown + YAML frontmatter. 한 파일 = 한 워크플로우. 파일명(확장자 제외)과 frontmatter `name` 은 일치해야 한다.

## frontmatter 스키마

```yaml
---
name: poem-critique          # 필수. [a-z0-9-]+ . 파일명과 일치
description: 한 줄 설명       # 필수
params:                      # 선택. 런타임 파라미터 선언
  - name: topic              #   [A-Za-z_][A-Za-z0-9_]*
    required: true           #   true 면 미제공 시 실행 거부
    description: 시의 주제
  - name: rounds
    required: false
    default: "2"             #   미제공 시 기본값
    description: 라운드 수
team:                        # 필수. 1개 이상
  - id: writer               #   필수. [a-z0-9_]+ . 정의서 내 유일. 논리 이름 — uuid 하드코딩 금지
    role: 작가                #   필수. 한 줄 요약
    model: opus              #   필수. opus|sonnet|haiku 또는 full model ID
  - id: critic
    role: 비평가
    model: sonnet
    count: 2                 #   선택. ≥2 면 fan-out — critic_1, critic_2 로 전개
kickoff:                     # 선택 (권장). 첫 지시
  to: writer                 #   team id (count 역할이면 전개 후 첫 인스턴스)
  message: "{{topic}} 주제로 초안을 작성하라"
report:                      # 선택 (권장). 최종 보고 규약
  from: lead                 #   team id — 이 사람만 팀장에게 TEAM-REPLY
  task_id: T-FINAL
teardown: confirm            # 선택. confirm(기본) | auto
session: dedicated           # 선택. inline(기본 — 보스 옆 분할) | dedicated(전용 세션)
---
```

### session 모드

- `inline` (기본): 보스 CC 의 region 옆을 분할해 팀 배치. 빠르지만 사용자 화면이 좁아진다.
- `dedicated`: 워크플로우 이름의 **전용 세션**을 백그라운드로 생성해 그 안에 팀 배치. 사용자 화면 완전 무손상, 사이드바에서 잡 진행을 관전 가능, 같은 워크플로우 여러 개 병렬 실행 가능. 해체 시 팀원 탭이 모두 닫히면 세션도 자동 제거.

frontmatter YAML 은 **부분집합만 지원** (render_workflow.py 의 자체 파서): 스칼라 `key: value`, 리스트of맵(`- key: value` + 후속 `key: value`), 1단 중첩 맵. 다단 중첩·플로우 스타일(`[a, b]`)·멀티라인 스칼라 금지.

## 본문 구조

```markdown
## 프로세스

메시지 흐름·라운드·종료 조건을 산문/목록으로. 실행자(팀장 CC)가 읽고 따른다.
예: 작가 → A/B/C 송신 → B,C → A → A 통합 → 작가 → 개정 → 2라운드 → A 만 보고.

## 역할: writer

writer 팀원의 초기 프롬프트에 들어갈 역할 상세. {{topic}} 치환 가능.

## 역할: critic

count 역할에서는 {{index}} (1-base 인스턴스 번호) 사용 가능.
예: "비평가 {{index}}번 — {{index}}번은 형식, 2번은 내용 중심" 식 분기는
프로세스 섹션에 조건으로 기술.
```

- `## 역할: <id>` 의 id 는 frontmatter team id 와 일치해야 한다 (전개 전 원본 id).
- 역할 섹션이 없는 team id 는 `role_prompt` 가 빈 문자열 — role 한 줄만으로 충분한 단순 역할일 때.
- 모든 본문·kickoff.message 에서 `{{param}}` 치환. 선언 안 된 `{{...}}` 는 그대로 보존된다 (오타 주의 — run 출력에서 `{{` 잔존 확인).

## 치환·전개 규칙 (render_workflow.py)

| 입력 | 결과 |
|---|---|
| `--param topic=공포` | 본문·kickoff 의 `{{topic}}` → `공포` |
| param 미제공 + default 있음 | default 로 치환 |
| param 미제공 + required | rc=1, 실행 거부 |
| `count: 2` 인 `critic` | `--json` 의 team 에 `critic_1`, `critic_2` 두 원소. 각 `role_prompt` 의 `{{index}}` → 1, 2 |

## 작성 원칙

1. **uuid 금지** — 정의서는 레이아웃·세션과 무관해야 재사용 가능. team id 는 논리 이름.
2. **자기완결** — 정의서만 읽어도 의도가 파악되게 (DC-WFS-3). 프로세스 섹션에 충분한 산문.
3. **보고 단일화** — `report.from` 한 명만 팀장에게 보고하게 설계 (허브 패턴). 전원 보고는 팀장 컨텍스트 낭비.
4. **파라미터는 최소** — 실행마다 진짜 바뀌는 것만. 나머지는 본문에 고정.
