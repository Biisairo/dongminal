#!/usr/bin/env bash
# 사용률 항목(기본 five_hour)이 문턱(기본 80) 이상이 되면 끝난다.
key=${1:-five_hour}; limit=${2:-80}
while true; do
  r=$(dmctl status --at cf1f5fa3-26e2-4950-acd9-6d8b3d9f9181 2>/dev/null | grep -o "$key:[0-9]*" | cut -d: -f2)
  if [[ -n "$r" ]] && (( r >= limit )); then echo "$key=$r 도달 $(date '+%H:%M')"; exit 0; fi
  sleep 60
done
