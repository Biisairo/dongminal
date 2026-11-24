#!/usr/bin/env python3
"""에이전트 출력 흉내 (PERF 기준선 측정용).

Claude Code 같은 에이전트가 내는 출력 모양을 낸다 — 색이 섞인 줄, 제자리 스피너,
가끔 몰아 나오는 긴 블록. 속도는 인자로 준다.

사용: agent-sim.py [초당 줄 수=40] [몰아치기 주기 초=5] [tui]

tui 를 주면 Claude Code 처럼 화면 아래 영역(25줄)을 초당 20번 통째로 다시 그리고,
그 위로 줄을 덧붙인다.
"""
import random
import sys
import time

rate = float(sys.argv[1]) if len(sys.argv) > 1 else 40.0
burst_every = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0
words = ("the agent reads files edits code runs tests and reports results while "
         "streaming tokens to the terminal with colours spinners and diffs").split()
colors = ["\x1b[32m", "\x1b[33m", "\x1b[36m", "\x1b[35m", "\x1b[90m", "\x1b[1m"]
spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
rnd = random.Random(7)
tui = len(sys.argv) > 3 and sys.argv[3] == "tui"
out = sys.stdout
gap = 1.0 / rate
next_burst = time.monotonic() + burst_every
i = 0
REGION = 25
if tui:
    out.write("\n" * REGION)
    frame_gap = 1.0 / 20
    last_line = time.monotonic()
    while True:
        i += 1
        now = time.monotonic()
        buf = ["\x1b[%dA" % REGION]
        if now - last_line >= 1.0 / rate * 4:
            last_line = now
            buf.append("\r\x1b[2K" + colors[i % len(colors)] + "● \x1b[0m" + " ".join(rnd.choice(words) for _ in range(14)) + "\n")
        for r in range(REGION):
            buf.append("\r\x1b[2K")
            if r == 0:
                buf.append("\x1b[90m" + "─" * 80 + "\x1b[0m")
            elif r == REGION - 2:
                buf.append(colors[i % len(colors)] + spin[i % len(spin)] + " Working… (" + str(i) + "s · esc to interrupt)\x1b[0m")
            else:
                buf.append(colors[(i + r) % len(colors)] + "│ " + " ".join(rnd.choice(words) for _ in range(rnd.randint(4, 14))) + "\x1b[0m")
            buf.append("\n")
        out.write("".join(buf))
        out.flush()
        time.sleep(frame_gap)

while True:
    i += 1
    if i % 8 == 0:
        out.write("\r\x1b[2K" + colors[i % len(colors)] + spin[i % len(spin)] + " Thinking… " + str(i) + "\x1b[0m")
    else:
        n = rnd.randint(6, 22)
        line = " ".join(rnd.choice(words) for _ in range(n))
        out.write("\r\x1b[2K" + colors[i % len(colors)] + "● " + "\x1b[0m" + line + "\n")
    if time.monotonic() >= next_burst:
        next_burst = time.monotonic() + burst_every
        for k in range(200):
            out.write("\x1b[32m+\x1b[0m    " + " ".join(rnd.choice(words) for _ in range(12)) + "\n")
    out.flush()
    time.sleep(gap)
