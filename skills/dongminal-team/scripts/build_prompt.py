#!/usr/bin/env python3
"""
팀원 CC 초기 프롬프트 (대기용) 빌더.

역할/팀 구성/프로토콜 블록을 표준 템플릿으로 조립하고,
`claude --model X "..."` 형태의 send_input text 를 만든다.

- 첫 작업 지시는 포함하지 않는다 (Barrier 뒤 Kickoff 단계에서 send_agent_message 로 전달).
- tool 풀 네임 (mcp__dongminal__send_agent_message) 과 유사 이름 금지 경고를 항상 포함.
- 따옴표 이스케이프 (`"` → `\\"`) 를 자동 처리해 쉘 파싱 안전.

사용:
  python build_prompt.py \\
      --model sonnet \\
      --my-label S4.P5.T1 \\
      --boss S4.P3.T1 \\
      --role "비평가 B — 형식/운율 중심" \\
      --teammate S4.P4.T1:작가 \\
      --teammate S4.P6.T1:비평가C \\
      --process "작가 초안 수신 → 독립 비평 → A(S4.P7.T1) 에게 송신" \\
      --reply-to S4.P7.T1

출력은 단일 줄의 send_input text (claude --model ... "..." 형태).
"""

from __future__ import annotations

import argparse
import json
import sys


def build(model, my_label, boss, role, teammates, process, reply_to, extra):
    team_lines = [f"  • 팀장:    {boss}", f"  • 네 라벨: {my_label}"]
    for label, rolename in teammates:
        team_lines.append(f"  • 동료:    {label}  (역할: {rolename})")

    body_parts = [
        f"[역할] {role}",
        "",
        "[팀 구성]",
        *team_lines,
    ]
    if process:
        body_parts += ["", "[프로세스]", f"  {process}"]

    reply_target = reply_to or boss
    body_parts += [
        "",
        "[답장 규칙]",
        "  반드시 tool 풀 네임을 사용: mcp__dongminal__send_agent_message",
        "  ※ SendMessage / send_message 등 유사 이름 내장 tool 은 완전히 다른 기능이다.",
        "    그걸 호출하면 메시지가 dongminal 채널에 도달하지 않는다. 절대 쓰지 말 것.",
        "  인자:",
        f"    to      = {reply_target}  (기본 답장 대상. 프로세스에 따라 달라질 수 있음)",
        f"    from    = {my_label}       (이미 알고 있으므로 who_am_i 호출 불필요)",
        "    message = 아래 포맷",
        "",
        "  [TEAM-REPLY task-id=<id>]",
        "  status: DONE | FAILED | NEEDS_INPUT",
        "  <결과 본문>",
        "  [/TEAM-REPLY]",
        "",
        "[대기] 팀장/동료의 kickoff 지시가 도착할 때까지 대기. 지금 아무 작업도 시작하지 말 것.",
    ]
    if extra:
        body_parts += ["", "[추가 지시]", extra]

    prompt_body = "\n".join(body_parts)
    # 쉘 큰따옴표 이스케이프: `"` 와 `\` 와 `$` 만 처리 (bracketed paste 로 개행은 보존됨)
    escaped = (
        prompt_body
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("$", "\\$")
        .replace("`", "\\`")
    )
    return f'claude --model {model} "{escaped}"'


def parse_teammate(s):
    if ":" not in s:
        raise argparse.ArgumentTypeError(f"--teammate 형식은 LABEL:ROLE (예: S4.P5.T1:작가). got: {s!r}")
    label, rolename = s.split(":", 1)
    return label.strip(), rolename.strip()


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", required=True, help="opus | sonnet | haiku 또는 풀 ID (claude-opus-4-7 등)")
    p.add_argument("--my-label", required=True, help="이 팀원의 pane 라벨")
    p.add_argument("--boss", required=True, help="팀장(사용자 CC) 라벨")
    p.add_argument("--role", required=True, help="한 줄 역할 설명")
    p.add_argument("--teammate", action="append", default=[], type=parse_teammate,
                   help="동료 라벨과 역할. LABEL:ROLE 형식. 여러 번 지정 가능.")
    p.add_argument("--process", default=None, help="팀 내 통신 흐름 한 줄 요약 (선택)")
    p.add_argument("--reply-to", default=None,
                   help="기본 답장 대상 라벨. 미지정 시 팀장. 수평 협업에서는 허브 라벨 지정.")
    p.add_argument("--extra", default=None, help="추가 컨텍스트/제약 (선택)")
    p.add_argument("--json", action="store_true", help="결과를 JSON 로 감싸서 출력")
    args = p.parse_args()

    text = build(args.model, args.my_label, args.boss, args.role, args.teammate,
                 args.process, args.reply_to, args.extra)

    if args.json:
        json.dump({"send_input_text": text, "execute": True}, sys.stdout, ensure_ascii=False)
        print()
    else:
        print(text)


if __name__ == "__main__":
    main()
