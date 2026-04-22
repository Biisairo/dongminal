#!/usr/bin/env python3
"""
팀 레이아웃 분할 계획 계산기.

who_am_i 의 size (COLSxROWS) 와 팀원 수 N 을 입력받아,
workspace_command 호출 순서를 JSON 으로 돌려준다.

셀 비율 보정: 터미널 셀 높이는 너비의 약 2.2 배 (폰트마다 2.0~2.5).
그래서 시각적 긴 축 판정은 숫자 비교가 아니라 COLS vs ROWS*2.2.

사용:
  python plan_layout.py --cols 200 --rows 50 --n 3 --boss S4.P3.T1
출력 (stdout, JSON):
  {
    "primary_split":   {"action": "splitH", "location": "S4.P3.T1", "keepFocus": true},
    "orthogonal_split": {"action": "splitV", "location_from_seed": true, "count": 3, "keepFocus": true},
    "reason": "...",
    "n": 3
  }

location_from_seed=true 는 "1차 분할 후 list_panes 로 확인한 SEED 라벨을 location 으로 쓴다" 는 의미.
N=1 이면 orthogonal_split 은 null.
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
        primary = "splitH"
        orthogonal = "splitV"
        reason = f"COLS={cols} >= ROWS*{CELL_RATIO}={rows*CELL_RATIO:.1f} → 가로가 시각적으로 더 긺. 1차 splitH 로 팀 영역을 오른쪽에 확보."
    else:
        primary = "splitV"
        orthogonal = "splitH"
        reason = f"COLS={cols} < ROWS*{CELL_RATIO}={rows*CELL_RATIO:.1f} → 세로가 시각적으로 더 긺. 1차 splitV 로 팀 영역을 아래에 확보."

    result = {
        "n": n,
        "reason": reason,
        "primary_split": {
            "action": primary,
            "location": boss,
            "keepFocus": True,
            "note": "팀장 pane 을 쪼개 SEED pane 1개 생성. 실행 후 list_panes 로 SEED 라벨 확인.",
        },
        "orthogonal_split": None,
    }

    if n >= 2:
        result["orthogonal_split"] = {
            "action": orthogonal,
            "location_from_seed": True,
            "count": n,
            "keepFocus": True,
            "note": f"SEED 라벨을 location 으로 지정해 직교 축으로 {n} 등분. 단일 호출.",
        }

    return result


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cols", type=int, required=True, help="터미널 셀 너비")
    p.add_argument("--rows", type=int, required=True, help="터미널 셀 높이")
    p.add_argument("--n", type=int, required=True, help="팀원 수")
    p.add_argument("--boss", type=str, required=True, help="팀장 pane 라벨 (예: S4.P3.T1)")
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
