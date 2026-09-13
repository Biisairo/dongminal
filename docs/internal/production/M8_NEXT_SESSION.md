# M8 통합 — 종료 기록 (P7 완료, M8 완료)

**M8 은 끝났다** (2026-09-14, 아홉 세션 — P0 스파이크 → P1 ①~④ → P2 국제화 → P3·P4·P5 프로토콜 표면 →
P6 CLI 계약 → P7 분리·중복·죽은 코드·테스트 결정성). 인계 대상이 없다 — 이 파일은 다음 단계의 착수
프롬프트가 아니라 **M8 의 종료 기록**이다. 다음 마일스톤이 열리면 `MILESTONE_KICKOFF.md` 의 절차로
새 착수 프롬프트를 쓴다.

---

## 어디서 읽을 것

| 무엇 | 어디 |
|---|---|
| 요구·결정·검증 | `docs/internal/M8_UNIFIED_SRS.md` — §3 요구(축 U·A·B·C), §5 결정(D-U · D-A-1~27 · D-B · D-C), §6 검증, §10 변경 기록 |
| 단계별 판정표·전량 e2e·배운 것 | `docs/internal/production/M8_PROGRESS.md` — §1-1(P1)~§1-14(P7), §2-1~2-38, §4 커밋 |
| 로드맵의 자리 | `docs/internal/production/PRODUCTION_ROADMAP.md` §M8 — 완료 표식과 "사유와 함께 남긴 것" 메모 |
| 결정 색인 | `docs/internal/decisions.md` (생성물, `go run ./scripts/gen-decisions`) |

## 저장소의 상태 (P7 종료 시점)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7·**M8** 완료 · M4 ⊘ — 로드맵의 마일스톤이 전부 닫혔다 |
| Go | `go test -race -shuffle=on -count=1 ./...` 초록 · `go vet` 무경고 · linux/windows 교차 빌드 초록 |
| 드리프트 | `go test -tags agentdrift -run TestDrift ./internal/shared/agentadapter/` — claude·codex(무모델)·omp 셋 초록 (P7 착수) |
| 게이트 | `make gates` 초록 (36 게이트 · check-i18n 990키) |
| e2e | 전량 `M8_PROGRESS.md` §1-14 (unexpected 0 · flaky 2, 두 스펙 단독 초록) · `agent-tool.spec.ts` 16/16 (TC-AGT-4 단독 12/12) |
| 500줄 초과 Go 파일 | 26 → 20 (지목 다섯 `tool.go`·`handlers_fs.go`·`handlers_runs.go`·`worktree.go`·`doctor.go` + `main.go` 전부 500 아래) |
| 새 패키지 | `internal/shared/pollwait` · `internal/shared/gittest`(테스트 전용) |
| 동작 변경 (P7) | D-A-14 `..` 조각 판정 · D-A-15 stop 대기 · D-A-16 데몬 RPC 오류가 오류로 · D-A-23 오류 세션 회수 · D-A-27 `submodule update` 작업 — 각 결정에 이전/새/이유 |
| 커밋 | P7 단계 종료 커밋 `__HASH__` |

## M8 이 사유와 함께 남긴 것 (다음 마일스톤의 후보)

- **GO-44 `Git *store.Store`** — gitapi 가 `Service()`(구체)를 72곳에서 쓴다. 인터페이스로 좁혀도 git 없이
  돌지 못하므로 좁히지 않았다. `GO-39`(git 실행기 통합)의 후속이다 (D-A-26 ①)
- **M7 §5-5 flaky 군집** — `git-*` 의 관측 주기 대기 · `slot-*` 의 그리기 대기, 두 헬퍼를 보는 별도의
  일. 전량마다 1~8건이 흔들리고 단독 실행은 초록. "3회 연속 flaky 0" 은 미충족 (D-A-26 ③)
- GO-42 전역 테스트 훅 — `t.Parallel()` 을 들이는 패키지가 생기면 그 패키지부터 필드 주입으로 (D-A-22)
- `sandboxplace/e2e_test.go` 의 700~900ms 고정 대기 — 컨테이너 런타임이 있는 호스트에서 폴링으로 (D-A-26 ⑥)
- `time.Sleep` 98곳 — 폴링 간격·부정 단정의 관측 창이 대부분 (§2-37). 줄일 것은 "조건을 기다리는 고정
  대기" 뿐이고 그것은 이번에 넷을 옮겼다

## 변하지 않는 규약 (M8 이 쓰던 것 — 다음 마일스톤도 같다)

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~7분). 판정은 `unexpected 0`. 겹쳐 돌리지 않는다 (`pgrep -fl e2e-shard-run` 0 확인 뒤 `run_in_background` 하나) · 전량 중 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 않는다 · 직후 `make e2e-rebalance`
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽는다
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고친다** (이전/새/이유)
- 새 문구는 `t('ns.key')` (ko·en) · 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS`+`helpers.js`+`index.html`+ko·en · 오류 코드는 `apierr/codes_core.go`+`codes_doc.go` → `go run ./scripts/gen-errors` · 결정은 SRS 에 D-… → `go run ./scripts/gen-decisions`
- 하네스를 복사하지 않는다 · 에이전트 이름은 등록부 밖에 적지 않는다 · 커밋 메시지에 AI 서명 금지 · 커밋은 사용자 확인 뒤 · 출력에 이모티콘 없음
- 드리프트 잡(`-tags agentdrift`)은 사건 주기 — 어댑터를 만질 때 먼저 돌린다. codex 는 `~/.bun/install/cache/@openai/codex@0.154.0-*/vendor/aarch64-apple-darwin/bin` 을 PATH 앞에. 자격증명이 없으면 무모델까지만 — 사용자에게 묻지 않는다

## 단계 종료 절차 (사용자 지시 2026-09-13 — 다음 마일스톤에도 같다)

  1. 문서 갱신 — `<M>_PROGRESS.md`(§1 상태·판정표·§2 배운 것) · 스펙 §10 변경 기록 · `<M>_NEXT_SESSION.md` 를 다음 단계의 착수 프롬프트로
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 사용자 확인 뒤)
  3. 인수인계 — dongminal 접합면으로 현재 위치에 새 탭(`dmctl new-tab -n`, `--help` 없이)을 열고 claude 를 띄운다 → `dmctl msg --to <toolId> -` 로 `[HANDOFF …]` 엔벨로프 → `dmctl status --at <탭>` 로 `working` 확인
  4. 자기 탭을 닫는다 — `dmctl close-tab --at <자기 탭 uuid>`. 이것이 세션의 마지막 명령이다
