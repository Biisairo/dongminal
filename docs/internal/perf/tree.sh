#!/usr/bin/env bash
# 최적화 이슈 트리와 상태를 찍는다. 사용: docs/internal/perf/tree.sh [상태...]   예: docs/internal/perf/tree.sh ready todo
cd "$(dirname "$0")/issues"
for f in *.md; do
  id=$(sed -n 's/^id: "\(.*\)"/\1/p' "$f" | head -1)
  st=$(sed -n 's/^status: //p' "$f" | head -1)
  title=$(sed -n 's/^title: //p' "$f" | head -1)
  deps=$(sed -n 's/^deps: \[\(.*\)\]/\1/p' "$f" | head -1 | tr -d '"')
  owner=$(sed -n 's/^owner: "\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$f" | head -1)
  depth=$(awk -F. '{print NF-1}' <<<"$id")
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$depth" "$st" "$title" "$deps" "${owner:0:8}"
done | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | while IFS=$'\t' read -r id depth st title deps owner; do
  if [[ $# -gt 0 ]] && [[ ! " $* " == *" $st "* ]]; then continue; fi
  printf '%*s%-7s [%-11s] %s' $((depth*2)) '' "$id" "$st" "$title"
  [[ -n "$deps" ]] && printf '  ← %s' "$deps"
  [[ -n "$owner" ]] && printf '  @%s' "$owner"
  echo
done
