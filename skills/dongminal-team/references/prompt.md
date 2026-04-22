# 팀원 초기 프롬프트 구조

## 자동 생성 — `scripts/build_prompt.py`

프롬프트 직접 작성 대신 빌더 사용:

```bash
python scripts/build_prompt.py \
  --model sonnet \
  --my-label S4.P5.T1 \
  --boss S4.P3.T1 \
  --role "비평가 B — 형식/운율 중심" \
  --teammate S4.P4.T1:작가 \
  --teammate S4.P7.T1:수석비평가A \
  --process "작가 초안 수신 → 독립 비평 → A 에게 송신" \
  --reply-to S4.P7.T1
```

출력은 `claude --model X "..."` 형태의 단일 문자열 — `send_input(text=<출력>, execute=true)` 에 그대로 투입. 따옴표·`$`·백틱 이스케이프 자동 처리.

빌더는 다음을 항상 포함시킨다:
- 역할 + 팀 구성 (모든 팀원 라벨 + 역할)
- 프로세스 (선택)
- 답장 규칙 (tool 풀 네임 + 유사 이름 금지 경고 + 포맷)
- **`[대기]` 지시** — 첫 작업 지시는 포함하지 않음 (Kickoff 단계에서 `send_agent_message` 로 별도 전달)

## 왜 `[대기]` 가 필요한가 — 데드락 방지

과거 `claude --model X "... 바로 작업 시작 + 동료에게 결과 전송"` 구조에서:
- CC 부팅 시간은 팀원마다 다름 (opus vs sonnet, 네트워크, terminal resize)
- 먼저 부팅된 팀원이 inline 지시를 받자마자 작업 → `send_agent_message` 로 결과 송신
- **수신자가 아직 쉘 상태** → 엔벨로프가 쉘에 텍스트로 찍혀 증발 → 수신자는 영원히 대기

근본 원인: "pane 동시 존재" ≠ "CC 입력 준비 완료". 초기 프롬프트는 역할·프로토콜 세팅만, 첫 작업은 Barrier 뒤 Kickoff 에서.

## 툴 이름 오용 — 매우 중요

팀원 CC 환경에는 유사 이름 tool 이 공존:
- `mcp__dongminal__send_agent_message` ← 이게 우리가 쓰는 것
- `SendMessage` (Claude Code 내장, 서브에이전트 인-프로세스 메시징)
- `send_message`, `SendChat` 등 다른 MCP/플러그인

LLM 이 이름 혼동으로 엉뚱한 tool 을 호출하면 메시지가 dongminal 채널에 도달하지 않는다. 자기 화면에는 "전송 완료" 로 보여 디버깅이 어렵다.

빌더는 풀 네임을 명시하고 "유사 이름 내장 tool 절대 금지" 경고를 포함시킨다. 직접 프롬프트를 쓴다면 동일 블록을 반드시 넣을 것.

## 따옴표 이스케이프

`claude --model X "..."` 의 큰따옴표 내부 규칙:
- `"` → `\"`
- `$` → `\$` (변수 전개 방지)
- `` ` `` → `` \` ``
- `\` → `\\`
- 개행은 bracketed paste 가 보존하므로 literal 개행 OK

빌더가 전부 처리하므로 일반적으로는 신경 쓰지 않아도 됨.

## `send_agent_message` 의 역할

- **초기 세팅**: `claude --model X "..."` (1회, `send_input` 으로 전달)
- **Kickoff + 후속 턴**: `send_agent_message` (N회, 필요한 만큼)

엔벨로프 `[DONGMINAL-AGENT-MSG from=... to=... ts=...]...[/DONGMINAL-AGENT-MSG]` 는 수신 CC 의 입력창에 신뢰 가능한 사용자 턴으로 자동 제출된다. 폴링 불필요.

드물게 여러 줄 메시지 submit 안 됨 → `send_input(id=<수신>, text="", execute=true)` 로 엔터 보강.
