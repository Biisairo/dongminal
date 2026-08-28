#!/usr/bin/env python3
"""
팀 레이아웃 분할 계획 계산기.

dmctl who-am-i 의 size (COLSxROWS) 와 팀원 수 N 을 입력받아,
dmctl 분할 명령 순서를 JSON 으로 돌려준다.

셀 비율 보정: 터미널 셀 높이는 너비의 약 2.2 배 (폰트마다 2.0~2.5).
그래서 시각적 긴 축 판정은 숫자 비교가 아니라 COLS vs ROWS*2.2.

식별자 — UUID 사용:
  `--boss` 는 dmctl who-am-i 의 라인 끝 `uuid=<36자>` 필드를 그대로 넣는다.
  출력의 `cmd` 필드가 그대로 실행 가능한 dmctl 명령이다.
  좌표 라벨(W1.P1.T1)은 넣지 마라 — 창·분할 칸이 닫히면 다시 계산돼
  다른 탭을 가리킨다. 서버 /api/commands 핸들러가 broadcast 직전에
  uuid → 좌표로 자동 번역한다.

사용:
  python plan_layout.py --cols 200 --rows 50 --n 3 \\
      --boss 550e8400-e29b-41d4-a716-446655440003
출력 (stdout, JSON):
  {
    "primary_split":   {"action": "splitH", "location": "<BOSS_UUID>", "keepFocus": true},
    "orthogonal_split": {"action": "splitV", "location_from_seed": true, "count": 3, "keepFocus": true},
    "reason": "...",
    "n": 3
  }

location_from_seed=true 는 "1차 분할 응답의 newTabs[0].uuid 로 확인한 SEED 도구의 uuid 를
location 으로 쓴다" 는 의미. N=1 이면 orthogonal_split 은 null.
"""

import argparse
import json
import sys

CELL_RATIO = 2.2  # 셀 높이/너비. 폰트마다 2.0~2.5, 환경에 맞춰 튜닝 가능


def plan(cols: int, rows: int, n: int, boss: str) -> dict:
    if n < 1:
        raise ValueError("n must be >= 1")

    horizontal_is_longer = cols >= rows * CELL_RATIO
    if horizontal_is_longer:
        primary = "split-h"
        orthogonal = "split-v"
        reason = f"COLS={cols} >= ROWS*{CELL_RATIO}={rows*CELL_RATIO:.1f} → 가로가 시각적으로 더 긺. 1차 split-h 로 팀 분할 칸을 오른쪽에 확보."
    else:
        primary = "split-v"
        orthogonal = "split-h"
        reason = f"COLS={cols} < ROWS*{CELL_RATIO}={rows*CELL_RATIO:.1f} → 세로가 시각적으로 더 긺. 1차 split-v 로 팀 분할 칸을 아래에 확보."

    result = {
        "n": n,
        "reason": reason,
        "primary_split": {
            "command": primary,
            "cmd": f'dmctl {primary} --at "{boss}" -n',
            "at": boss,
            "note": "팀장 분할 칸을 쪼개 SEED 도구 1개 생성. 응답 JSON 의 newTabs[0].uuid 가 SEED.",
        },
        "orthogonal_split": None,
    }

    if n >= 2:
        result["orthogonal_split"] = {
            "command": orthogonal,
            "cmd": f'dmctl {orthogonal} {n} --at "$SEED_UUID" -n',
            "at_from_seed": True,
            "count": n,
            "note": f"SEED uuid 를 --at 로 지정해 직교 축으로 {n} 등분. 단일 호출.",
        }

    return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cols", type=int, required=True, help="터미널 셀 너비")
    p.add_argument("--rows", type=int, required=True, help="터미널 셀 높이")
    p.add_argument("--n", type=int, required=True, help="팀원 수")
    p.add_argument("--boss", type=str, required=True, help="팀장 탭 uuid (좌표 라벨은 쓰지 않는다)")
    args = p.parse_args()

    try:
        out = plan(args.cols, args.rows, args.n, args.boss)
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        sys.exit(2)
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
