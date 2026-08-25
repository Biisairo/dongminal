---
name: poem-critique
description: 시 비평 2라운드 파이프라인 — 작가 1 + 수석비평가 1 + 비평가 2 (허브 앤 스포크)
params:
  - name: topic
    required: true
    description: 시의 주제 (예: 공포, 바다)
  - name: length
    required: false
    default: "공백 포함 100자 이내"
    description: 시 분량 제한
team:
  - id: writer
    role: 작가
    model: opus
  - id: lead
    role: 수석비평가 (허브)
    model: opus
  - id: critic
    role: 비평가
    model: sonnet
    count: 2
kickoff:
  to: writer
  message: "{{topic}} 주제의 한국어 시 초안({{length}})을 작성해 lead 와 모든 critic 에게 송신하라"
report:
  from: lead
  task_id: T-FINAL
teardown: confirm
session: dedicated
---

## 프로세스

1. 작가가 {{topic}} 주제 초안을 lead + critic 전원에게 각각 송신.
2. critic 각자 독립 비평 작성 → lead 에게 `[FROM-CRITIC from=critic_N round=1]` 송신. lead 도 자체 비평 작성.
3. lead 가 자기 비평 + critic 전원 비평을 통합 → 작가에게 `[FROM-LEAD task-id=T-CRITIQUE-1]` 송신.
4. 작가가 개정판 작성 → 다시 전원에게 송신 (`[FROM-WRITER task-id=T-REVISE-1]`).
5. round=2 동일 사이클.
6. **lead 가 최종 종합을 만든다** — `draft_original`, `joint_critique_1`, `draft_revised`,
   `joint_critique_2` 4개를 조정자에게 `dmctl msg` 로 1회 송신한다 (본문이 길기 때문).
7. 멤버 전원은 자기 몫이 끝나면 `dmctl run report` 로 **정확히 한 번** 보고한다 —
   이것이 조정자가 완료를 아는 근거이며, 작가·critic 도 예외가 아니다. 다만 최종
   산출물 본문은 lead 의 메시지에만 담는다.

## 역할: writer

{{topic}} 주제의 한국어 시를 쓴다. 분량: {{length}}.
초안·개정판 모두 lead 와 critic 전원에게 각각 dmctl msg 로 송신한다.
lead 의 통합 비평을 받으면 비평을 반영한 개정판을 작성한다. 2라운드 후 종료.

## 역할: lead

수석비평가이자 비평 허브. 작가의 초안/개정판마다:
1. 자체 비평 작성 (구조·정서·완성도).
2. critic 들의 `[FROM-CRITIC]` 을 모두 수신할 때까지 대기.
3. 자기 것 + critic 전원 비평을 모순 없이 통합해 작가에게 송신.
2라운드 완료 후 조정자에게 최종 종합(4개 필드 전부)을 `dmctl msg` 로 송신하고,
그 뒤 `dmctl run report --outcome succeeded` 로 보고한다.

## 역할: critic

비평가 {{index}}번. 작가의 시를 수신하면 독립적으로 비평을 작성한다 —
1번은 형식·운율 중심, 2번은 내용·이미지 중심.
비평은 **lead 에게만** 송신한다 (작가·조정자에게 직접 송신 금지).
자기 라운드가 끝나면 `dmctl run report` 로 보고한다.
