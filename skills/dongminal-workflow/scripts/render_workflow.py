#!/usr/bin/env python3
"""워크플로우 정의서 파싱·검증·파라미터 치환 — DONGMINAL_WORKFLOW_SKILL_SRS FR-WFD-5.

사용:
  render_workflow.py <정의서.md> [--param name=value ...]   # 치환된 본문 출력
  render_workflow.py <정의서.md> --json [--param ...]       # 구조 JSON (team 은 count 전개)
  render_workflow.py <정의서.md> --list-params              # 파라미터 명세만

frontmatter 는 본 스킬 스키마의 부분집합만 지원 (DC-WFS-2):
스칼라, 리스트of맵(2칸 들여쓰기 + '- key: value'), 1단 중첩 맵. PyYAML 미사용.
"""

import json
import re
import sys


def fail(msg):
    sys.stderr.write(f"render_workflow: {msg}\n")
    sys.exit(1)


def split_frontmatter(text):
    m = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not m:
        fail("frontmatter 없음 — 파일이 '---' 로 시작해야 합니다")
    return m.group(1), m.group(2)


def parse_frontmatter(src):
    """지원 부분집합: 'key: value' 스칼라, 'key:' + 리스트of맵, 'key:' + 1단 맵."""
    root = {}
    lines = src.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            i += 1
            continue
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
        if not m:
            fail(f"frontmatter 파싱 실패 (행: {line!r})")
        key, val = m.group(1), m.group(2).strip()
        if val:
            root[key] = unquote(val)
            i += 1
            continue
        # 블록: 리스트of맵 또는 1단 맵
        items, mapping, i = parse_block(lines, i + 1)
        root[key] = items if items is not None else mapping
    return root


def parse_block(lines, i):
    """들여쓰기 블록 파싱. (리스트of맵 | None, 맵 | None, 다음 인덱스) 반환."""
    items = None
    mapping = None
    cur = None
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if not line.startswith("  "):
            break
        s = line.strip()
        lm = re.match(r"^-\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", s)
        km = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", s)
        if lm:
            if items is None:
                items = []
            cur = {lm.group(1): unquote(lm.group(2).strip())}
            items.append(cur)
        elif km and items is not None and cur is not None:
            cur[km.group(1)] = unquote(km.group(2).strip())
        elif km:
            if mapping is None:
                mapping = {}
            mapping[km.group(1)] = unquote(km.group(2).strip())
        else:
            fail(f"frontmatter 블록 파싱 실패 (행: {line!r})")
        i += 1
    return items, mapping, i


def unquote(v):
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def validate(meta):
    for key in ("name", "description", "team"):
        if key not in meta:
            fail(f"필수 키 누락: {key}")
    if not re.fullmatch(r"[a-z0-9-]+", meta["name"]):
        fail(f"name 형식 오류 ([a-z0-9-]+ 만 허용): {meta['name']!r}")
    team = meta["team"]
    if not isinstance(team, list) or not team:
        fail("team 은 1개 이상의 리스트여야 합니다")
    seen = set()
    for m in team:
        for key in ("id", "role", "model"):
            if key not in m:
                fail(f"team 원소에 필수 키 누락: {key} ({m!r})")
        if not re.fullmatch(r"[a-z0-9_]+", m["id"]):
            fail(f"team id 형식 오류 ([a-z0-9_]+ 만 허용): {m['id']!r}")
        if m["id"] in seen:
            fail(f"team id 중복: {m['id']}")
        seen.add(m["id"])
        if "count" in m:
            try:
                c = int(m["count"])
            except ValueError:
                fail(f"count 는 정수여야 합니다: {m['count']!r} (id={m['id']})")
            if c < 1:
                fail(f"count 는 1 이상이어야 합니다: {c} (id={m['id']})")
    for key in ("kickoff", "report"):
        ref = meta.get(key)
        if ref and ref.get("to" if key == "kickoff" else "from") not in seen:
            fail(f"{key} 가 참조하는 team id 가 존재하지 않습니다: {ref!r}")
    session = meta.get("session", "inline")
    if session not in ("inline", "dedicated"):
        fail(f"session 은 inline 또는 dedicated 만 허용: {session!r}")


def resolve_params(meta, given):
    declared = meta.get("params") or []
    values = {}
    missing = []
    for p in declared:
        name = p.get("name")
        if not name:
            fail(f"params 원소에 name 누락: {p!r}")
        if name in given:
            values[name] = given[name]
        elif "default" in p:
            values[name] = p["default"]
        elif str(p.get("required", "")).lower() == "true":
            missing.append(name)
    if missing:
        fail("필수 파라미터 누락: " + ", ".join(missing))
    # 선언 안 된 param 이 주어지면 경고 없이 치환에 사용 (관용).
    for k, v in given.items():
        values.setdefault(k, v)
    return values


def substitute(text, values):
    def repl(m):
        key = m.group(1)
        if key in values:
            return str(values[key])
        return m.group(0)  # {{index}} 등 후속 단계 치환 대상은 보존
    return re.sub(r"\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}", repl, text)


def extract_role_sections(body):
    """본문에서 '## 역할: <id>' 섹션별 텍스트 추출."""
    sections = {}
    matches = list(re.finditer(r"^## 역할:\s*([a-z0-9_]+)\s*$", body, re.MULTILINE))
    for idx, m in enumerate(matches):
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
        sections[m.group(1)] = body[start:end].strip()
    return sections


def expand_team(meta, roles):
    """count>=2 역할을 인스턴스로 전개. {{index}} 는 인스턴스별 1-base 치환."""
    out = []
    for m in meta["team"]:
        count = int(m.get("count", 1))
        prompt = roles.get(m["id"], "")
        if count == 1:
            out.append({"id": m["id"], "role": m["role"], "model": m["model"],
                        "role_prompt": substitute(prompt, {"index": 1})})
        else:
            for n in range(1, count + 1):
                out.append({"id": f"{m['id']}_{n}", "role": f"{m['role']} #{n}",
                            "model": m["model"],
                            "role_prompt": substitute(prompt, {"index": n})})
    return out


def main(argv):
    if not argv:
        fail("정의서 경로가 필요합니다")
    path = argv[0]
    as_json = "--json" in argv
    list_params = "--list-params" in argv
    given = {}
    i = 1
    while i < len(argv):
        if argv[i] == "--param":
            if i + 1 >= len(argv) or "=" not in argv[i + 1]:
                fail("--param 은 name=value 형식이 필요합니다")
            k, _, v = argv[i + 1].partition("=")
            given[k] = v
            i += 2
        else:
            i += 1

    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError as e:
        fail(f"정의서를 열 수 없습니다: {e}")

    fm, body = split_frontmatter(text)
    meta = parse_frontmatter(fm)
    validate(meta)

    if list_params:
        for p in meta.get("params") or []:
            req = "required" if str(p.get("required", "")).lower() == "true" else "optional"
            default = f"  default={p['default']!r}" if "default" in p else ""
            print(f"{p['name']}  ({req}){default}  — {p.get('description', '')}")
        return

    values = resolve_params(meta, given)
    body = substitute(body, values)

    if as_json:
        roles = extract_role_sections(body)
        kickoff = meta.get("kickoff")
        if kickoff and "message" in kickoff:
            kickoff = dict(kickoff, message=substitute(kickoff["message"], values))
        print(json.dumps({
            "name": meta["name"],
            "description": meta["description"],
            "params": values,
            "team": expand_team(meta, roles),
            "kickoff": kickoff,
            "report": meta.get("report"),
            "teardown": meta.get("teardown", "confirm"),
            "session": meta.get("session", "inline"),
            "process": extract_process(body),
        }, ensure_ascii=False, indent=2))
        return

    print(body)


def extract_process(body):
    m = re.search(r"^## 프로세스\s*$(.*?)(?=^## |\Z)", body, re.MULTILINE | re.DOTALL)
    return m.group(1).strip() if m else ""


if __name__ == "__main__":
    main(sys.argv[1:])
