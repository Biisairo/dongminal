---
id: "11"
title: Go 제거와 Rust 빌드 전환
status: split
deps: ["10"]
go: []
crates: []
owner: "6f379635-59d2-4d38-b1f3-8de17e180cc5"
branch: rp/11
---

# 11 Go 제거와 Rust 빌드 전환

## 목표 (사용자 지시 2026-11-24)

- 이 브랜치(rust-port)에서 Go 코드를 지운다. 원본 Go 는 main 브랜치에 남는다.
- `scripts/build.sh` 가 Rust 를 빌드해 `./dongminal` 이 Rust 바이너리가 된다.
- 빌드하는 과정과 빌드된 바이너리를 쓰는 과정에서 Go 판과 차이가 없다 — 같은 명령·같은 인자·같은 산출물 이름·같은 위치·같은 출력·같은 종료 코드. Makefile 목표·CI 워크플로·설치·업데이트·릴리즈 산출물 모양도 같다.

## 절차

1. 11.0 조사·스펙: Go 에 기대는 모든 자리(Makefile·scripts/*·.github/workflows·e2e 설정·docs·README·CONTRIBUTING·hooks·web/*.go·rust 시험이 Go 소스·Go 바이너리·go run 에 기대는 곳·hermetic.sh·gen-decisions 호출 등)를 목록으로 만들고, 각 자리의 Rust 대체와 "차이 없음" 수락 시험을 docs/internal/GO_REMOVAL_SRS.md(IEEE 29148)로 쓴다.
2. 조정자가 확인하고 하위 이슈로 나눠 고친다.
3. 마지막에 Go 를 지우고(git rm), 빌드·e2e·게이트 전부를 Rust 만으로 돌려 통과시킨다.

## 진행 기록

### 11.0 착수 (2026-11-24, 6f379635)
- 시작 prod-pids: `38173 start --foreground` / `58470 d --handover-fd`
- 산출물: `docs/internal/GO_REMOVAL_SRS.md`(초안) — rp/11 커밋 `9f6c68c0`. 코드는 고치지 않았다
- 자리 73곳(G-1~G-73), 하위 묶음 10개(R1~R10, 1단계 R1~R5 병렬, R6∥R8, R7, R9, R10 마지막)
- 미해결 질문 14개(Q-GRM-1~14). 우선 결정 필요: Q-GRM-1 Linux musl 정적 링크, Q-GRM-2 교차 빌드 도구·CI 러너 배치, Q-GRM-4 Go 참조 대조 시험의 선택 실행 방식, Q-GRM-13 CI 시험 수단(push 금지)
- 주요 위험: rust 시험 두 곳이 internal/ 의 시험 벡터를 include_str!/fs::read 로 읽는다(G-58·G-59) — Go 를 먼저 지우면 cargo test 가 깨진다. go_parity 시험 둘은 PATH 에 go 가 있으면 실패한다(G-63)
- 검사: check-srs-status·check-srs-progress·check-decisions 통과(격리 실행)
- 종료 prod-pids: `38173 start --foreground` / `58470 d --handover-fd` (시작과 같음)
