# 로컬 게이트 원커맨드 (CI_GATES_SRS §4 · 07-production-gap G8-3).
#
# CI 가 도는 것을 커밋 전에 여기서 돌린다. 두 목록이 갈리면 CI 가 잡는 것이
# 로컬에서 안 잡히고, 그때 사람은 밀어 보고 나서야 안다.
#
# **기존 게이트 4종을 다시 쓰지 않는다** — 감사가 양호로 판정한 항목이다.
# 여기서는 부르기만 한다.

.DEFAULT_GOAL := help
.PHONY: help gates test lint unit typecheck hooks all e2e e2e-all e2e-rebalance e2e-plan

help:  ## 이 도움말
	@echo "dongminal 로컬 게이트"
	@echo
	@# 문자 클래스에 숫자가 없어 `e2e*` 넷이 통째로 안 보이고 있었다.
	@grep -E '^[a-z0-9-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
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
	@echo "── 숨김의 어휘 (.vis 와 [hidden] 둘인가)"
	@scripts/check-visibility.sh
	@echo "── 스크롤 소유권 (뷰별 재정의가 없는가)"
	@scripts/check-scroll.sh
	@echo "── 골격 배치 (inset:0 이 position 과 같은 규칙에 있는가)"
	@scripts/check-skeleton.sh
	@echo "── 에이전트 이름 (등록부 밖에 리터럴이 없는가)"
	@scripts/check-agent-names.sh
	@echo "── 환경변수 문서 (코드와 표가 양방향으로 같은가)"
	@scripts/check-env-docs.sh
	@echo "── 로그의 단일 경로 (표준 log 를 직접 부르지 않는가)"
	@scripts/check-logging.sh
	@echo "── 오류 응답의 단일 경로 (http.Error 를 직접 부르지 않는가)"
	@scripts/check-http-error.sh
	@echo "── 오류 카탈로그 (생성물이 코드와 맞는가)"
	@scripts/check-error-docs.sh
	@echo "── SRS 상태 필드 (enum 안에 있는가)"
	@scripts/check-srs-status.sh
	@echo "── 결정 색인 (생성물이 SRS 와 맞는가)"
	@scripts/check-decisions.sh
	@echo "── 명령 문서 (commands.md 와 dmctl 이 양방향으로 같은가)"
	@scripts/check-commands-docs.sh
	@echo "── API 문서 (api.md 와 라우트가 양방향으로 같은가)"
	@scripts/check-api-docs.sh
	@echo "── 단축키 문서 (기본값·라벨·설정 화면·문서가 한 벌인가)"
	@scripts/check-shortcuts-docs.sh
	@echo "── e2e 의 내부 접근 (app.testing 계약만 쓰는가)"
	@scripts/check-e2e-private.sh
	@echo "── 로드 순서 (스크립트가 아직 서지 않은 이름을 읽지 않는가)"
	@node scripts/check-load-order.mjs
	@echo "── e2e 의 고정 대기 (근거가 있는 예외만인가)"
	@node scripts/check-e2e-waits.mjs
	@echo "── 프론트 계층 경계 (ui/·git/ 이 App 의 내부를 파고들지 않는가)"
	@scripts/check-layer.sh
	@echo "── 프로세스 축 경계 · 패키지 표 (축을 넘는 import 가 없는가 · 표가 go list 와 같은가)"
	@scripts/check-pkg-axis.sh
	@echo "── 글자 대비 (테마 전종에서 파생이 바닥에 닿는가)"
	@node scripts/check-contrast.mjs
	@echo "── CSS 토큰 (읽는 이름이 실제로 세워지는가)"
	@node scripts/check-css-vars.mjs
	@echo "── 포커스 표시 (outline 을 지운 자리마다 되살린 자리가 있는가)"
	@node scripts/check-focus.mjs
	@echo "── 글자 크기 (font-size 가 토큰에서 오는가)"
	@node scripts/check-font-size.mjs
	@echo "── z-index 층 (값이 층에서 오고 산술이 없는가)"
	@node scripts/check-z-index.mjs
	@echo "── 하드코딩 색 (:root 밖에 색 리터럴이 없는가)"
	@node scripts/check-hardcoded-color.mjs
	@echo "── 문구 카탈로그 (한글 리터럴이 카탈로그 밖에 없는가 · ko·en 이 한 벌인가)"
	@node scripts/check-i18n.mjs
	@echo "gates ok"

# ── 전량 e2e 의 용량 (M10_SRS FR-M10-5 · D-M10-6) ───────────────────────────
#
# **동시 워커 수는 여기 한 자리에서 정해진다.**
#
# 종전에는 두 값이 다른 파일에 있었다 — 이 파일의 `E2E_JOBS`(4)와
# `playwright.config.ts` 의 `E2E_WORKERS`(2). 어느 한쪽을 고쳐도 **곱은 아무도 보지
# 않았고**, 그래서 동시 워커가 8 인 채로 남았다. `E2E_PARALLEL_SRS D-6` 은 이 기계
# (10코어)에서 5워커를 *"6~8 실패 — 전부 부하성 타임아웃"* 으로 기각했는데 그보다 위다.
#
# 실측(2026-09-15, 같은 커밋에서 세 회차):
#
#   동시 8 → flaky 5 (전부 부하성 타임아웃, 전부 git 계층)
#   동시 4 → flaky 1 (논리 경합만)
#   동시 3 → flaky 1 (논리 경합만) · 벽시계 19.1분 — 8샤드를 3개씩 **3배치**로 돈다
#
# 그래서 상한은 `올림(코어/3)` 이다. 이 기계에서 4 이고, 부하성이 0 이면서 2배치로
# 끝나는 점이다. `V-EPL-1` 이 정한 순서를 그대로 따른다 — **초록이 아니면 워커를
# 줄이는 것이 먼저다.** 대기 상한을 늘리는 길은 이미 20→30→45초를 지나 60초에서
# 걸렸다 (D-M10-6).
E2E_CORES := $(shell sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
E2E_CAP   := $(shell expr \( $(shell sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4) + 2 \) / 3)
# 한 번에 도는 샤드 수. 곱이 상한을 넘지 않는 선에서 올린다.
#
# **기본을 상한에서 떼어 2 로 내린다** (2026-09-16). 위 표가 *"동시 4 → flaky 1
# (논리 경합만)"* 으로 적은 자리가, 항목이 늘어난 지금은 **하드 실패**가 된다.
#
#   동시 4 → 샤드 4 가 9.6분 · `openGit` 60초 관측 상한에서 **하드 실패** (3회 연속)
#   동시 2 → 같은 샤드 4.8분 · 8샤드 전부 초록 · flaky 1
#   단독   → 4.7분 — 동시 2 와 사실상 같다
#
# 동시 4 에서 샤드가 **2배 느려지고** 그 지연이 60초를 넘겼다. 동시 2 면 샤드당
# 시간이 절반이 되므로 배치가 2배여도 **총 벽시계는 거의 같다** — 값을 치르지 않고
# 초록을 산다.
#
# 위 주석이 정한 순서 그대로다: **초록이 아니면 워커를 줄이는 것이 먼저다.**
# 대기 상한을 늘리는 길은 20→30→45초를 지나 60초에서 이미 걸렸다 (D-M10-6).
#
# **상한(`E2E_CAP`)은 건드리지 않는다.** 그것은 *"이 이상은 위험"* 이고(M10_SRS
# FR-M10-5) 이것은 *"권장 동작점"* 이다. 빠른 기계에서 올리려면 `E2E_JOBS=4`.
E2E_JOBS ?= 2
# 샤드 하나가 띄우는 워커 수(= 인스턴스 수). 샤드 실행에 `PW_WORKERS` 로 간다.
E2E_WORKERS ?= 1

e2e:  ## e2e 전량 — **CI 와 같은 분할**(8샤드)을 **병렬**로 돈다
	@# 로컬이 한 프로세스로 1500항목을 도는 동안 CI 는 8조각을 각자 새 러너에서
	@# 돈다 — 그 차이가 **상태 누적의 범위**를 바꾸고, 그래서 전량에서만 깨지는
	@# 검사가 생겼다 (ui-layout-defaults · git-worktrees V151).
	@#
	@# 같은 분할로 돌면 같은 답이 나온다. 그것이 e2e 의 조건이다
	@# (E2E_PARALLEL_SRS V-EPL-2 · FR-EPL-13·14).
	@#
	@# **샤드마다 포트 뿌리와 산출물 자리를 옮긴다** (FR-EPL-14).
	@#
	@# 홈은 `pid` 로 이미 갈리지만 둘은 갈리지 않았다:
	@#   포트    같은 기계에서 동시에 돌면 서로의 서버를 잡는다
	@#   산출물  `test-results/.playwright-artifacts-*` 를 함께 쓰며 **서로의
	@#           trace 를 지운다** (실측: ENOENT 662건)
	@#   청소    setup/teardown 이 `dongminal-e2e-*` 를 통째로 훑어 **아직 도는
	@#           샤드의 바이너리를 지운다** (실측: spawn ENOENT 950건)
	@#           → `DM_E2E_KEEP_PEERS=1` 이 자기 뿌리만 다루게 한다
	@# `pipefail` 이 없으면 샤드의 실패가 `sed` 에 먹혀 초록으로 보인다.
	@#
	@# **개수가 아니라 시간으로 가른다** (M6 잔여). Playwright 의 `--shard` 는
	@# 개수로 가르는데 파일당 시간이 스무 배까지 벌어져, `git-*` 가 몰린 샤드가
	@# 6분인 동안 다른 샤드는 2.4분이었다. 벽시계는 가장 느린 쪽에 묶이고 **그
	@# 느린 샤드 안에서 흔들림이 난다** — 관측 상한이 부하에 밀린다.
	@#
	@# `scripts/e2e-shard.mjs` 가 `e2e/` 에서 목록을 파생해 무게로 나눈다.
	@# 시간표가 없거나 낡아도 동작한다 (모르는 파일은 가장 무겁게 친다).
	@#
	@# JSON 리포트를 함께 남긴다 — `make e2e-rebalance` 가 그것으로 시간표를
	@# 새로 만든다. 시간표를 손으로 적으면 조용히 낡는다.
	@# 본문은 `scripts/e2e-shard-run.sh` 에 있다 — macOS 의 `xargs -I` 가 치환 뒤
	@# 줄 길이를 255바이트로 묶어서, 인라인으로 두면 조금만 길어져도 멎는다.
	@# FR-M10-5: **곱을 먼저 본다.** 넘으면 시작하지 않는다 — 부하성 타임아웃으로
	@# 흔들린 회차는 그 자체로 한 시간이고, 그 뒤에 "워커를 줄여라" 를 알게 된다.
	@tot=$$(expr $(E2E_JOBS) \* $(E2E_WORKERS)); \
	 if [ "$$tot" -gt "$(E2E_CAP)" ]; then \
	   echo "동시 워커 $$tot = 샤드 $(E2E_JOBS) × 워커 $(E2E_WORKERS) — 상한 $(E2E_CAP) 을 넘습니다 (코어 $(E2E_CORES), M10_SRS FR-M10-5)"; \
	   echo "  부하성 flaky 가 납니다. E2E_JOBS 나 E2E_WORKERS 를 줄이세요 (E2E_PARALLEL_SRS D-6 · V-EPL-1)."; \
	   exit 1; \
	 fi
	@PW_WORKERS=$(E2E_WORKERS) sh -c 'seq 1 8 | xargs -P $(E2E_JOBS) -I{} scripts/e2e-shard-run.sh {} 8'
	@echo "e2e ok — 8샤드 전부 (동시 워커 $(E2E_JOBS)×$(E2E_WORKERS), 상한 $(E2E_CAP))"
	@# 흔들린 항목을 **격리해서 세 번 더** 돈다 (E2E_FLAKY_ISOLATION_SRS FR-EFI-10).
	@#
	@# **전 샤드가 끝난 뒤다.** 샤드 안에서 돌면 나머지 일곱의 부하를 그대로 받아
	@# 그것은 독립이 아니다 — 부하를 없애려고 도는 검사가 부하 속에서 돌면 답이
	@# 뒤집힌다 (§2.3). CI 는 샤드마다 러너가 달라 그 자리에서 바로 돈다.
	@#
	@# 글로브가 아무것도 맞히지 못하면 셸이 패턴을 그대로 넘기는데, 스크립트가
	@# 없는 파일을 flaky 0 으로 읽는다 (FR-EFI-3).
	@node scripts/e2e-isolate-flaky.mjs test-results/s*/parity-flaky.json

e2e-rebalance:  ## 마지막 전량 실행의 시간으로 샤드 분할을 다시 맞춘다
	@node scripts/e2e-timings.mjs
	@node scripts/e2e-shard.mjs --plan

e2e-plan:  ## 지금 시간표로 샤드가 어떻게 갈리는지 본다
	@node scripts/e2e-shard.mjs --plan

e2e-all:  ## e2e 전량을 **한 프로세스**로 (누적 상태까지 겪는 무거운 쪽)
	npx playwright test

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
