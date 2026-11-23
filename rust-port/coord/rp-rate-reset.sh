#!/usr/bin/env bash
# five_hour 사용률이 문턱(기본 30) 아래로 내려가면(새 5시간 창) 끝난다.
limit=${1:-30}
while true; do
  r=$(dmctl status --at cf1f5fa3-26e2-4950-acd9-6d8b3d9f9181 2>/dev/null | grep -o 'five_hour:[0-9]*' | cut -d: -f2)
  if [[ -n "$r" ]] && (( r < limit )); then echo "five_hour=$r 초기화 감지 $(date '+%H:%M')"; exit 0; fi
  sleep 120
done
