#!/usr/bin/env bash
# 운영 인스턴스(저장소 루트 바이너리로 뜬 서버·데몬)의 PID 를 찍는다 (RUST_PORT_SRS V-RSP-5).
# 작업 전후 출력이 같아야 한다.
ps -axo pid=,command= | awk '($2=="/Users/dykim/personal/dongminal/dongminal" || $2=="/Users/dykim/personal/dongminal/otterminal") {print $1, $3, $4}' | sort -n
