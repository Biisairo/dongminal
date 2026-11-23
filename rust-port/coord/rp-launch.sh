#!/usr/bin/env bash
# 사용: rp-launch.sh <이슈ID> [추가 지시문]
set -e
i=$1; extra=${2:-}
cd /Users/dykim/personal/dongminal-rust/int
git worktree add -q -b rp/$i /Users/dykim/personal/dongminal-rust/$i rust-port
mkdir -p /Users/dykim/personal/dongminal-rust/$i/.claude && cp /Users/dykim/personal/dongminal-rust/int/.claude/settings.local.json /Users/dykim/personal/dongminal-rust/$i/.claude/
U=$(dmctl new-tab -n --at e13fe9c1-3a3f-48cf-8cbd-556561c399a7 --name "rp $i" | jq -r '.newTabs[0].uuid')
echo "$i $U" >> /Users/dykim/personal/dongminal-rust/int/rust-port/coord/rp-tabs.txt
dmctl send-input --at $U --execute "cd /Users/dykim/personal/dongminal-rust/$i && claude" >/dev/null
dmctl wait --at $U --for ready --timeout-ms 90000 >/dev/null
( /Users/dykim/personal/dongminal-rust/int/rust-port/coord/rp-brief.sh $i $U; [ -n "$extra" ] && printf '\n추가: %s\n' "$extra" ) | dmctl msg --to $U - >/dev/null
echo "$i $U"
