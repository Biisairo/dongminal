---
id: "11"
title: Go 제거와 Rust 빌드 전환
status: in-progress
deps: ["10"]
go: []
crates: []
owner: ""
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
