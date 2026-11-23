#!/usr/bin/env bash
# 사용: rp-brief.sh <이슈ID> <탭uuid>
i=$1; u=$2
f=$(ls /Users/dykim/personal/dongminal-rust/int/rust-port/issues/$i-*.md)
cat <<MSG
당신은 dongminal Go→Rust 포팅의 이슈 $i 담당 에이전트다. 조정자 탭 uuid 는 cf1f5fa3-26e2-4950-acd9-6d8b3d9f9181 이다.

먼저 아래 세 문서를 읽고 그대로 따른다.
1. 공통 규칙: /Users/dykim/personal/dongminal-rust/int/rust-port/AGENT_RULES.md
2. 요구사항: /Users/dykim/personal/dongminal-rust/int/docs/internal/RUST_PORT_SRS.md
3. 내 이슈(상태는 이 원본 파일에만 적는다): $f

내 worktree 는 /Users/dykim/personal/dongminal-rust/$i, 브랜치는 rp/$i 다(이미 만들어져 체크아웃되어 있다).

가장 중요한 제약: 이 기계에서 운영 중인 dongminal 서버·데몬(저장소 루트 바이너리, ~/.dongminal 홈)을 절대 내리거나 건드리면 안 된다. 바이너리·테스트 실행은 모두 rust/scripts/hermetic.sh 를 거친다. 시작과 끝에 rust/scripts/prod-pids.sh 출력을 기록한다.

동등성 기준: 사용자·브라우저·다른 프로세스가 보는 최종 동작(출력 바이트, 와이어, 파일 형식, 타이밍 상수)이 같으면 된다. 내부 구조와 단위 테스트 모양까지 같을 필요는 없다.

바로 시작해서 끝까지 진행한다. 조정자의 확인을 기다리지 않는다. 커밋은 rp/$i 에 직접 한다(사용자가 허락했다). main 병합과 push 는 금지다. 기준선은 go1.27.2(JSONv2 기본)이고, JSON·시간·인용·OS 오류 문구는 dm-gocompat(json, strconv, time, oserr)을 쓴다.

작업 규모가 크면 규칙 3-3 에 따라 하위 이슈로 나누고 조정자에게 알린다. 막히면 추측하지 말고 blocked 로 바꾼 뒤 조정자에게 알린다. 끝나면 이슈를 review 로 바꾸고 dmctl msg --to cf1f5fa3-26e2-4950-acd9-6d8b3d9f9181 "$i review: <요약>" 으로 알린다.
MSG
