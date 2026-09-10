# 로컬 게이트 원커맨드 (CI_GATES_SRS §4 · 07-production-gap G8-3).
#
# CI 가 도는 것을 커밋 전에 여기서 돌린다. 두 목록이 갈리면 CI 가 잡는 것이
# 로컬에서 안 잡히고, 그때 사람은 밀어 보고 나서야 안다.
#
# **기존 게이트 4종을 다시 쓰지 않는다** — 감사가 양호로 판정한 항목이다.
# 여기서는 부르기만 한다.

.DEFAULT_GOAL := help
.PHONY: help gates test lint unit typecheck hooks all

help:  ## 이 도움말
	@echo "dongminal 로컬 게이트"
	@echo
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "커밋 전 훅으로 걸려면:  make hooks"

gates:  ## 커밋 전에 도는 것 — 포맷·정적분석·이음매 4종
	@echo "── gofmt"
	@out=$$(gofmt -l .); \
	 if [ -n "$$out" ]; then echo "$$out"; echo "gofmt -w 로 고치세요"; exit 1; fi
	@echo "── go vet"
	@go vet ./...
	@echo "── go build"
	@go build ./...
	@echo "── 이음매 (OS 의존 호출이 platform 밖에 없는가)"
	@scripts/check-seams.sh
	@echo "── 시간과 전파 (타이머·채널이 TimerHub·EventBus 안에만 있는가)"
	@scripts/check-timers.sh
	@echo "── git 쓰기 파이프라인"
	@scripts/check-gitwrite.sh
	@echo "── 크로스 컴파일"
	@scripts/check-cross.sh
	@echo "── 제3자 자산 판 기록"
	@scripts/check-vendor.sh
	@echo "── 마크업 보간 (터미널 출력이 스크립트가 되지 않는가)"
	@scripts/check-html.sh
	@echo "── API 호출의 단일 경로 (core/api.js 를 지나는가)"
	@scripts/check-fetch.sh
	@echo "gates ok"

test:  ## Go 단위 테스트 (-race -shuffle=on, ./web/... 포함)
	go test -race -shuffle=on ./internal/... ./cmd/... ./web/...

unit:  ## 프론트 순수 모듈 단위 테스트 (node:test)
	npm run unit --silent

typecheck:  ## e2e 타입 검사 + `// @ts-check` 를 단 프론트 파일
	npm run typecheck --silent

# 도구가 없으면 **건너뛰되 말한다.** 조용히 통과하면 없는 것과 같다.
lint:  ## golangci-lint + eslint (없으면 건너뛰고 알린다)
	@if command -v golangci-lint >/dev/null 2>&1; then \
	  echo "── golangci-lint"; golangci-lint run; \
	else \
	  echo "!! golangci-lint 가 없어 건너뜁니다 — CI 는 이것을 돌립니다."; \
	  echo "   설치: https://golangci-lint.run/welcome/install/"; \
	fi
	@if [ -d node_modules/eslint ]; then \
	  echo "── eslint"; npx eslint .; \
	else \
	  echo "!! node_modules 가 없어 eslint 를 건너뜁니다 — npm ci"; \
	fi

all: gates lint typecheck unit test  ## 위 전부

hooks:  ## pre-commit 훅을 켠다 (git config core.hooksPath)
	git config core.hooksPath .githooks
	@echo "켰습니다. 끄려면: git config --unset core.hooksPath"
	@echo "한 번만 건너뛰려면: git commit --no-verify"
