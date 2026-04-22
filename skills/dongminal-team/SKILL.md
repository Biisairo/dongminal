---
name: dongminal-team
description: dongminal MCP 위에서 여러 Claude Code 인스턴스를 팀으로 묶어 협업시키는 범용 오케스트레이션 스킬. tmux 기반 team agents 대체. "팀 에이전트", "멀티 에이전트", "agent team", "서브 에이전트 여러 개", "병렬로 CC 돌려서", "역할 분담", "다른 pane 에 CC 띄워서", "GAN 식으로 두 CC", "리서치 fan-out", "여러 Claude 협업" 류의 의도면 반드시 이 스킬을 써라. 구성 방식이 아직 정해지지 않아도 트리거한다.
---

# dongminal-team

dongminal MCP 의 pane/세션/탭 + 신뢰 채널 (`send_agent_message`) 로 **여러 Claude Code 인스턴스를 같은 워크스페이스에서 팀으로 협업**시키는 스킬. 팀은 항상 이 스킬이 **새로** 만들고, 끝나면 정리한다.

## 언제 쓰나

- "팀 만들어서", "여러 CC 돌려서", "A는 X, B는 Y", "역할 분담", "fan-out", "GAN 스타일"
- 한 CC 가 혼자 하기엔 맥락이 너무 크거나, 서로 다른 관점(생성 vs 비판, 리서치 병렬) 이 필요할 때
- 길고 독립적인 서브태스크 3개 이상

**안 쓰는 경우**: 단일 CC 로 충분, 단순 질의응답, 단일 파일 수정.

---

## 절대 원칙 (3가지)

1. **항상 새 팀** — 기존 열린 CC pane 은 절대 팀원으로 재사용하지 않는다. 사용자 맥락 훼손 방지 + 팀원은 깨끗한 컨텍스트에서 지시받아야 작업이 명확하다.
2. **사용자 포커스 금지** — 모든 `workspace_command` 호출은 `location=<명시 라벨>` + `keepFocus=true`. `focus` 액션은 **복원 목적 포함 어떤 경우에도 호출 금지**. 이유와 상세는 `references/layout.md`.
3. **Barrier 전 Kickoff 금지** — inline 프롬프트엔 첫 작업 지시를 **절대** 넣지 않는다. 전원 CC 준비 완료 확인 후 `send_agent_message` 로 Kickoff. 위반 시 데드락 실화 — `references/prompt.md`.

---

## 도구 요약 (dongminal MCP)

| 도구 | 용도 |
|------|------|
| `who_am_i` | 팀장 라벨 + `size=COLSxROWS` 획득 |
| `list_panes` | 팀원 pane 라벨 식별 |
| `workspace_command` | 세션/탭/분할/닫기. 항상 `location` + `keepFocus=true` |
| `send_input` | 새 pane 쉘에 `claude` 명령 주입. `execute=true` 로 엔터 자동 |
| `send_agent_message` | 팀원과의 신뢰 채널. 엔벨로프로 사용자 턴처럼 자동 제출 |
| `read_pane_screen` | Barrier 확인, 멈춘 CC 진단 |

팀원 CC 내부에서도 `mcp__dongminal__` **풀 네임**으로 호출하도록 초기 프롬프트에 못박아야 한다. 유사 이름 내장 `SendMessage` 오용이 실측 실패 원인. `references/prompt.md` 참고.

---

## 워크플로우

### 1. 팀장 정보 + 레이아웃 계획

```
who_am_i  →  BOSS 라벨 (예: S4.P3.T1) + size=COLSxROWS
```

레이아웃은 스크립트가 계산한다 (셀 비율 2.2 보정, 긴 축 판정, 직교 N 등분):

```bash
python scripts/plan_layout.py --cols <COLS> --rows <ROWS> --n <N> --boss <BOSS>
```

출력 JSON 의 `primary_split` / `orthogonal_split` 지시를 그대로 따른다.

### 2. 1차 분할

`plan` 의 `primary_split` 대로:

```
workspace_command(action=<splitH|splitV>, location=<BOSS>, keepFocus=true)
```

실행 후 `list_panes` 로 **SEED 라벨** (방금 생긴 팀 영역 pane) 확인.

### 3. 직교 축 N 등분 (N≥2 일 때만)

```
workspace_command(action=<splitV|splitH>, location=<SEED>, count=N, keepFocus=true)
```

단일 호출로 정확히 N 균등 분할. 다시 `list_panes` 로 팀원 라벨 전부 수집.

### 4. 팀원 CC 병렬 부팅 (대기 프롬프트)

각 팀원 프롬프트는 빌더로 생성:

```bash
python scripts/build_prompt.py \
  --model <opus|sonnet|haiku> --my-label <팀원라벨> --boss <BOSS> \
  --role "<한 줄 역할>" \
  --teammate <라벨>:<역할> [--teammate ...] \
  [--process "<통신 흐름>"] [--reply-to <허브라벨>]
```

빌더는 `[대기]` 지시와 tool 풀 네임 경고를 자동 포함한다. 직접 쓰지 말 것.

**단일 어시스턴트 메시지에서 병렬로** 모든 팀원에게 `send_input` 호출:

```
# N 개 병렬
send_input(id=<팀원i>, text=<빌더 출력>, execute=true)
```

병렬이 중요한 이유: 순차 기동 시 먼저 뜬 팀원이 아직 존재하지 않는 동료 라벨에 송신 시도 → unknown label.

### 5. Barrier — 전원 CC 준비 완료 확인

대략 5~10초 경과 후 (별도 sleep 없이 다음 tool 호출로 진행) 모든 팀원에게 병렬 `read_pane_screen`. CC 입력 UI (`╭─`/`>` 프롬프트 박스) 가 보이고 "Thinking..." 이 없으면 준비 완료. 미준비 팀원만 재확인. 30초 넘게 미준비면 실패로 판정하고 해당 pane 화면을 진단 (`claude: command not found`, 쿼터 초과 등).

### 6. Kickoff — 첫 작업 지시

작업 개시자(들)에게 `send_agent_message` 로 첫 지시 전송:

```
send_agent_message(
  to="<개시자 라벨>", from="<BOSS>",
  message="[TEAM-KICKOFF task-id=<id>]\nstatus: START\n<짧은 태스크>\n[/TEAM-KICKOFF]"
)
```

초기 프롬프트에 이미 역할·프로토콜이 있으므로 kickoff 메시지는 짧아도 된다. 송신 후 `read_pane_screen` 한 번으로 수신측이 처리 시작(`Thinking...`)했는지 확인.

### 7. 팀장 턴 종료 → 답장 대기

팀장 CC 는 팀원을 실시간 감시하지 않는다. 팀원 답장은 엔벨로프 `[DONGMINAL-AGENT-MSG from=... to=...]...[/DONGMINAL-AGENT-MSG]` 로 다음 사용자 턴처럼 자동 도착. 엔벨로프 내부 `[TEAM-REPLY task-id=...]` 파싱해 결과 활용. 폴링 불필요.

여러 명의 답장이 순차 도착하면 부분 처리하거나 "현재 M/N 완료" 로 보고하고 다음 턴에서 마저 받는다. 비정상 지연은 `read_pane_screen` 으로 해당 pane 진단.

### 8. 팀 해체 (사용자 확인 후)

**기본 (포커스 안전, CC 종료만)**:
- 각 팀원 pane 에 `send_input(text="/exit", execute=true)` — Claude Code 정상 종료
- pane 은 쉘 상태로 남음 (사용자가 중간 로그를 볼 수 있음)

**pane 까지 제거 (사용자가 요청할 때만)**:
- `/exit` 먼저 → 쉘 복귀 확인 → 역순(큰 P 번호부터)으로 `workspace_command(closeTab, location=<팀원라벨>)`
- 매 호출 전 `list_panes` 로 라벨 재확인 (positional 라벨 밀림 방지)
- `location` 지정 `closeTab` 은 서버가 포커스를 움직이지 않는다. `focus` 는 **호출 금지**.

`/exit` 를 먼저 하는 이유: 실행 중 CC 를 바로 `closeTab` 하면 "프로세스 종료?" 다이얼로그가 뜨기 때문.

---

## 체크리스트

1. [ ] `who_am_i` → BOSS 라벨 + size
2. [ ] `scripts/plan_layout.py` 로 분할 계획
3. [ ] 1차 분할 → `list_panes` → SEED 확인
4. [ ] (N≥2) 직교 축 `count=N` 단일 호출 → `list_panes` → 팀원 라벨들 확보
5. [ ] 팀원별 `scripts/build_prompt.py` 로 대기 프롬프트 생성
6. [ ] **단일 메시지 병렬** `send_input` 으로 전원 기동
7. [ ] Barrier: `read_pane_screen` 으로 전원 CC 준비 확인
8. [ ] `send_agent_message` 로 Kickoff
9. [ ] 팀장 턴 종료 — 답장 대기
10. [ ] 답장 파싱 → 결과 종합 → 사용자에 보고
11. [ ] 정리 여부 확인. 기본 `/exit`. 요청 시 역순 `closeTab(location=...)`. `focus` 금지.

---

## 더 깊이 읽을 때

- `references/layout.md` — 셀 비율 2.2, 긴 축/직교 축 휴리스틱, 포커스 안전 설계
- `references/prompt.md` — 초기 프롬프트 구조, 데드락 원인, 툴 이름 오용, 이스케이프
- `references/troubleshooting.md` — 실패 모드 진단 표 + 로그 위치
- `references/models_and_patterns.md` — 모델 선택 가이드 + 팀 패턴 카탈로그
- `evals/test-scenarios.md` — 검증 시나리오 (4인 팀 비평 파이프라인 등)

## tmux team agents 대비 장점

브라우저에서 팀 활동 실시간 관찰, 신뢰 채널 명시, 레이아웃이 터미널 비율에 맞춰 자동 조정.
