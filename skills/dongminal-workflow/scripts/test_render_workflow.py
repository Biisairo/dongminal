"""render_workflow.py 단위 테스트 — DONGMINAL_WORKFLOW_SKILL_SRS TC-WFR-1~8.

실행: python3 -m unittest skills/dongminal-workflow/scripts/test_render_workflow.py
또는 스크립트 디렉토리에서: python3 -m unittest test_render_workflow
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "render_workflow.py")

VALID_DEF = """---
name: poem-critique
description: 시 비평 2라운드 파이프라인
params:
  - name: topic
    required: true
    description: 시의 주제
  - name: rounds
    required: false
    default: "2"
    description: 비평 라운드 수
team:
  - id: writer
    role: 작가
    model: opus
  - id: lead
    role: 수석비평가
    model: opus
  - id: critic
    role: 비평가
    model: sonnet
    count: 2
kickoff:
  to: writer
  message: "{{topic}} 주제로 초안을 작성하라"
report:
  from: lead
  task_id: T-FINAL
teardown: confirm
---

## 프로세스

주제 {{topic}} 에 대해 {{rounds}} 라운드 비평.

## 역할: writer

{{topic}} 주제의 시를 쓴다.

## 역할: lead

통합 비평 담당.

## 역할: critic

비평가 {{index}} 번 — 독립 비평.
"""


def run_script(args, definition=None):
    """definition 텍스트를 임시 파일로 저장 후 스크립트 실행. (rc, stdout, stderr) 반환."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "wf.md")
        if definition is not None:
            with open(path, "w", encoding="utf-8") as f:
                f.write(definition)
        proc = subprocess.run(
            [sys.executable, SCRIPT, path] + args,
            capture_output=True,
            text=True,
        )
        return proc.returncode, proc.stdout, proc.stderr


class TestRender(unittest.TestCase):
    # TC-WFR-1: 유효 정의서 + 모든 param → 치환된 전문, {{ 잔존 없음, rc=0
    def test_full_render(self):
        rc, out, err = run_script(["--param", "topic=공포"], VALID_DEF)
        self.assertEqual(rc, 0, err)
        self.assertIn("공포 주제의 시를", out)
        self.assertIn("2 라운드", out)  # default 적용
        self.assertNotIn("{{topic}}", out)
        self.assertNotIn("{{rounds}}", out)

    # TC-WFR-2: --json 구조 출력
    def test_json_output(self):
        rc, out, err = run_script(["--json", "--param", "topic=공포"], VALID_DEF)
        self.assertEqual(rc, 0, err)
        data = json.loads(out)
        self.assertEqual(data["name"], "poem-critique")
        self.assertEqual(data["report"], {"from": "lead", "task_id": "T-FINAL"})
        self.assertEqual(data["kickoff"]["to"], "writer")
        self.assertIn("공포", data["kickoff"]["message"])
        ids = [m["id"] for m in data["team"]]
        self.assertIn("writer", ids)

    # TC-WFR-3: 필수 param 누락 → rc=1 + 이름 명시
    def test_missing_required_param(self):
        rc, out, err = run_script([], VALID_DEF)
        self.assertEqual(rc, 1)
        self.assertIn("topic", err)

    # TC-WFR-4: frontmatter 필수 키 누락 → rc=1 + 키 명시
    def test_missing_required_key(self):
        bad = VALID_DEF.replace("name: poem-critique\n", "")
        rc, out, err = run_script(["--param", "topic=x"], bad)
        self.assertEqual(rc, 1)
        self.assertIn("name", err)

    # TC-WFR-5: team[].id 중복 → rc=1 + id 명시
    def test_duplicate_team_id(self):
        bad = VALID_DEF.replace("- id: lead", "- id: writer", 1)
        rc, out, err = run_script(["--param", "topic=x"], bad)
        self.assertEqual(rc, 1)
        self.assertIn("writer", err)

    # TC-WFR-6: default 있는 param 미제공 → default 치환
    def test_default_param(self):
        rc, out, err = run_script(["--param", "topic=x", "--param", "rounds=3"], VALID_DEF)
        self.assertEqual(rc, 0, err)
        self.assertIn("3 라운드", out)

    # TC-WFR-7: --list-params
    def test_list_params(self):
        rc, out, err = run_script(["--list-params"], VALID_DEF)
        self.assertEqual(rc, 0, err)
        self.assertIn("topic", out)
        self.assertIn("required", out)
        self.assertIn("rounds", out)

    # TC-WFR-8: count>=2 역할 — --json 의 expanded 팀에서 {{index}} 치환
    def test_count_expansion_index(self):
        rc, out, err = run_script(["--json", "--param", "topic=x"], VALID_DEF)
        self.assertEqual(rc, 0, err)
        data = json.loads(out)
        critics = [m for m in data["team"] if m["id"].startswith("critic")]
        self.assertEqual(len(critics), 2)
        self.assertEqual(critics[0]["id"], "critic_1")
        self.assertEqual(critics[1]["id"], "critic_2")
        self.assertIn("비평가 1 번", critics[0]["role_prompt"])
        self.assertIn("비평가 2 번", critics[1]["role_prompt"])

    # TC-WFR-9: session 키 — dedicated 패스스루, 미선언 시 inline.
    def test_session_dedicated(self):
        d = VALID_DEF.replace("teardown: confirm\n", "teardown: confirm\nsession: dedicated\n")
        rc, out, err = run_script(["--json", "--param", "topic=x"], d)
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["session"], "dedicated")

    def test_session_default_inline(self):
        rc, out, err = run_script(["--json", "--param", "topic=x"], VALID_DEF)
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["session"], "inline")

    # TC-WFR-10: session 잘못된 값 → rc=1.
    def test_session_invalid(self):
        d = VALID_DEF.replace("teardown: confirm\n", "session: floating\n")
        rc, out, err = run_script(["--json", "--param", "topic=x"], d)
        self.assertEqual(rc, 1)
        self.assertIn("session", err)

    # 파일 없음 → rc=1
    def test_missing_file(self):
        proc = subprocess.run(
            [sys.executable, SCRIPT, "/nonexistent/wf.md"],
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
