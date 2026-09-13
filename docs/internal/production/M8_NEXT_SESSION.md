# M8 통합 — 다음 세션 착수 프롬프트 (P7 축 A ⑥·⑦ — 분리·중복·죽은 코드 · 테스트 결정성)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P6 는 끝났다** (2026-09-14, 한 세션 — 커밋 `P6_COMMIT`). Go·브라우저·e2e·문서·게이트 전부
초록이고 전량 e2e 는 `M8_PROGRESS.md` §1-12. **P7 은 착수 전**이다 — M8 의 마지막 단계다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 **P7 = 축 A ⑥·⑦, 분리·중복·죽은 코드 · 테스트 결정성 나머지** 를 한다
(`docs/internal/M8_UNIFIED_SRS.md` §4 표 P7 · §3.2 표 ⑥ = `GO-14~21` · `GO-22·24~28` · `09 FR-GCC-3·4` ·
`09 D-WBR-8` · `FBE-08`(작업 경로분) — **`FBE-09~11` 은 P6 가 닫았다** · ⑦ = `TEST-23·25·26` · `TEST-24`(기록) ·
§3.2 DoD 의 "500줄 초과 Go 파일" · "`main.go serve` → `Build(cfg)`/`App.Run`/`App.Shutdown`" · "`doctor.go` 표" ·
"중복 6건" · "`worktree.go:600` `..` 오탐" · "Go 테스트 `gittest` 픽스처 7벌 → 1벌 · `DONGMINAL_SHELL` `t.Setenv`" ·
"`write.SyncNext`·`StepOutcome` 제거 · `app-layout.js:732-736` 죽은 분기" · TEST-24 커버리지 주석 · 양호 판정 유지
확인). 진입 조건은 P1 이었다 — 언제든. 이것이 M8 의 마지막 단계이므로 **P1~P6 가 남긴 것**(아래 절)도
여기서 거둔다. 작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` §2.1 표(`GO-14~28` · `TEST-23~26` · `09` 두 행 · `FBE-08`) · §3.2 표 ⑥·⑦ 과
   DoD 의 해당 항목 · §10 "P6 완료" 행 · D-A-1~9 (P6 가 확정한 것 — 바꾸지 않는다)
2. 로드맵 `docs/internal/production/PRODUCTION_ROADMAP.md` §M8 의 원문 표 — 항목마다 파일·줄 번호가 있다
   (낡았을 수 있다 — P1 §2-10). `01-go-arch.md` 의 GO-14~28 · `05-test.md` 의 TEST-23~26 · `09-srs-implementation-gap.md`
   의 FR-GCC-3·4 · D-WBR-8 · `10-func-backend.md` §140 FBE-08
3. `docs/internal/production/M8_PROGRESS.md` §1-11(P6 판정표)·§1-12(전량)·§2-32~2-34(P6 가 배운 것) · §1-1 의
   GO-42·GO-44·TEST-8 행(P1 이 ⑦ 로 미룬 것) · 아래 "P1~P6 가 P7 에 남긴 것"
4. 코드: `cmd/dongminal/main.go`(serve·buildDeps) · `internal/ctl/cli/doctor.go` · `internal/webserver/httpapi/handlers_fs.go`·
   `handlers_runs.go` · `internal/shared/toolhub/tool.go` · `internal/webserver/domain/worktree/worktree.go` ·
   `domain/git/write/*`(SyncNext·StepOutcome) · `domain/submodule/submodule.go`(FBE-08) · `web/js/core/app-layout.js:732-736` ·
   Go 테스트의 git 픽스처들(`gittest` 후보)

## 남은 일 (순서)

1. **착수 실측** — `go test -tags agentdrift -run TestDrift -v ./internal/shared/agentadapter/`
   (PATH 에 codex 가 없으면 `~/.bun/install/cache/@openai/codex@0.154.0-*/vendor/aarch64-apple-darwin/bin`
   을 앞에 둔다). 셋 초록이어야 착수. P7 은 어댑터를 고치지 않는다
2. **재감사** — 항목마다 지금 코드에서 사실인지 다시 잰다(P1 §2-10 · P6 §2-32). 500줄 초과 파일 목록은
   `wc -l` 로 다시 뽑는다. 닫힌 것은 판정표에 "이미 해소" 로, 남은 것만 스펙 §5 에 D-A-10… 으로
3. **구현** — Spec → Test → Code. 죽은 코드는 지우기 전에 참조를 도구로 확인(LSP/Serena). 지울 수 없는
   보류는 M5 의 모범대로 **가드 테스트로 봉인**. 분리(파일 쪼개기)는 동작 변경이 아니어야 한다 — 같은
   테스트가 그대로 초록. `main.go` 의 종료 순서 주석이 코드가 되면 그 순서를 테스트가 잰다
4. **V 전량**: `go test -race ./...` · `make gates` · `make unit` · `make test` · V-11(훅 표면 diff 0 ·
   `claude.go`·`codex.go`·`omp.go` **프로토콜 필드** 그대로) · `make e2e` → `unexpected 0` → `make e2e-rebalance`
5. **문서** — `M8_PROGRESS.md` §1 표(P7 완료 — **M8 완료**)·§1-13 판정표·§1-14 전량 · 스펙 §10 "P7 완료" 행 ·
   `architecture.md` 패키지 표(파일을 쪼개면 게이트가 잡는다) · `PRODUCTION_ROADMAP.md` §M8 상태 · 이 파일은
   M8 이 끝나므로 **M8 종료 기록**으로 다시 쓴다(다음 마일스톤이 있으면 그 착수 프롬프트로)
6. **커밋** — 단계 종료 커밋 하나 (`feat(m8): P7 — 축 A ⑥·⑦ …`). 사용자 확인 뒤
7. **인수인계** — M8 이 끝나면 인계 대상이 없다. 사용자에게 M8 종료를 보고하고 다음 지시를 기다린다
   (아래 절차의 3·4 는 사용자가 다음 마일스톤을 열 때만)

## P6 가 확정한 것 (바꾸지 않는다)

  D-A-1  `dmctl` 의 대기 예산은 `shared/runwait` 의 상수 + 여유. `runPostWithin/runGetWithin` · `clientWithin(budget)`
  D-A-2  `/api/commands` 를 지나는 명령은 `delivered`(생성은 `timedOut` 도)를 판정해 exit 1. 필드가 있을 때만
  D-A-3  `closedTabs[].closed` 는 방송 결과, `delivered` 동반. `closedTabIDs` 는 `closed==true` 만
  D-A-4  codex 터미널 표면 = `PromptArgv` · `--model`(0.154.0 실측). `launchNotes` 가 argv 아님·모델 플래그 없음을 stderr 로
  D-A-5  `status --member` = `wait --member` 와 같은 해석(`memberToolID`)
  D-A-6  `run delete`(`DELETE /api/runs/{id}`) · `run graph`(`GET /api/runs/{id}/graph`)
  D-A-7  명시 `cwd` 가 디렉터리가 아니면 `/api/tools` 400 `tool_cwd_missing`. 샌드박스·`cwdTool`·`Restore` 는 종전 폴백
  D-A-8  `wrapPaste` 가 본문의 `ESC[201~` 제거 · `quoteEnvelope` 가 `[DONGMINAL-AGENT-MSG`→`[\DONGMINAL-AGENT-MSG`
  D-A-9  격리 기동 안내 `announceIsolated` 하나, 도구 홈 `ensureIsolatedToolHome` 하나 — 전경도 같다

## P3·P4·P5 가 확정한 것 (바꾸지 않는다)

  D-C-1  에이전트 탭 = `type:'agent'` + `toolId`. 종류를 묻는 자리는 셋(해석층·뷰·전송 호출)
  D-C-2  해석층은 서버(`agentsess`). 직접 모드 `ToolHooks.OnOutput`, 데몬 모드 `SetOnOutput` 사슬
  D-C-3  이벤트 로그: 메모리 링 4096 + **디스크 JSONL**(P5) · `GET /api/agent/events?tool&since` · SSE `agent_event`
  D-C-4  비소유자 승인 응답을 서버가 거절하지 않는다
  D-C-5  에이전트 도구는 tools.json 에 없다 — 되살림은 **`agents.json` 레코드**(P5 D-C-14)
  D-C-6  stderr → dmlog (+ P5: 마지막 8줄이 `ExitInfo.Stderr` 로 오류 상태의 사유)
  D-C-7  실행 파일: `DONGMINAL_AGENT_BIN_DIR/<DetectCmd>` → PATH
  D-C-8  데몬 push 는 에이전트 도구에서 non-droppable
  D-C-9  가짜 에이전트는 프롬프트 본문으로 시나리오 (세 판 같다). claude 판의 `system:init` 은 **첫 프롬프트 뒤**(P5)
  D-C-10 종류는 청크에 실려 온다 — `OnOutput(id, kind, data, end)`
  D-C-11 세션은 프로세스보다 오래 산다 — `Dormant`(hibernated·error). 재개는 **같은 toolId**(`Placement.ReuseID`,
         데몬 `create.reuseId`). 지우는 것은 닫기(`Forget`)만
  D-C-12 디스크 = `agents/<toolId>.jsonl`(SSE 와 같은 줄, `{snap}`+링으로 압축) · `agents.json`(레코드)
  D-C-13 요약 스냅샷 = 버려진 이벤트의 접힘. 재생 `{state, events, truncated, snapshot?}`
  D-C-14 부팅 `AgentRestore`: 살아 있으면 `Resume` 채택(codex rejoin) · 없으면 `error/server_restart` · 신원 없거나
         참조 없으면 버림
  D-C-15 `EvExit{Text: hibernated|closed|died, Detail: "exit N: stderr…", IsError}` — 새 이벤트 종류 없음
  D-C-16 신원 없는 도구는 휴면 불가(409 `agent_no_identity`). `idle` 은 핸드셰이크 응답에서 (claude `initialize` →
         `EvSession{SessionID:""}`)
  D-C-17 휴면·오류 세션은 `/api/state.tools` 에 `dormant` 표식으로 합쳐진다 (브라우저 `clean()` 의 근거)
  FR-U-2 세 어댑터가 `Proto` 한 구조체에 든다. 계약: `Handshake(opts, st)` · `LaunchOpts.Approval` · `Question.FreeText`
  D-U-5  대조 잡 = `drift_test.go`(`-tags agentdrift`), 주기는 사건. CI 밖
  F-3    한 프로세스를 한 도구로 — codex 는 thread 하나만 쓴다
  F-4    omp 는 `--approval-mode` 를 반드시 싣는다 (비면 `always-ask`)
  틈 되메움(`SnapshotTool`)은 **비동기**다 (§2-30) — readLoop 안에서 RPC 를 걸지 않는다 (D-C-10 의 확장)

  탭 메뉴(FR-CMU-8)는 셋 그대로 + 에이전트 탭이면 `터미널로 열기`. 에이전트 탭 **만들기**는 `+`
  우클릭(FR-CMU-8a)에만. 휴면·재개는 에이전트 뷰의 메뉴에만 (FR-ABG-11).

## 사용자 결정·지시 (P3~P6 것 — P7 에도 적용)

- FR-AGT-4 질문 답변 · FR-AGT-4a(Esc·↑↓·`/`·Shift+Tab — *"최대한 tui agent 의 모든 공통 기능을 이용하게"*)
- 자격증명이 없으면 무모델 프레임까지만 실측하고 "미확인 — 자격증명 없음" 으로 적는다 — 사용자에게
  자격증명을 묻지 마라 (P0 의 사용자 결정)
- `-p --input-format stream-json` 은 1회성이 아니다 (실측 §2-19)
- (P6) codex 의 터미널 표면은 "선언 정정 + 안내 코드" — 실측으로 선언을 고치되 어댑터 계약의 분기 안내는 남긴다
- 출력에 이모티콘을 쓰지 않는다

## P1~P6 가 P7 에 남긴 것 (P7 의 범위다 — 전부 거둔다)

- (P1) GO-44 의 `Git *store.Store` — gitapi 가 `Service()`(구체)를 83곳에서 쓴다. ⑥(GO-39 git 실행기 통합)
  뒤의 일로 미뤘다. 좁힐 수 있으면 좁히고, 없으면 사유를 스펙에 적는다
- (P1) GO-42 — 전역 테스트 훅 5개(`toolBusyProbe`·`attnBusyProbe`·`fgProbe`·`attnNow`·`procCtl`) 잔존. DoD 조건
  ("`t.Parallel()` 도입 패키지") 미충족이라 P1 이 확인만 했다. ⑦ 에서 `ToolManager.startTool` 필드 주입을 본으로
  교체할지 결정
- (P1) `time.Sleep` 잔여 — 테스트 96곳(밀리초 폴링). ⑦ 의 `pollUntil`/`waitFor` 로 줄인다
- (P2) `fail()` 한국어 본문 — `check-http-error.sh` 의 동결 9곳. 카탈로그로 옮길지 결정
- (P3~P5) §5-5 flaky 군집(`git-observe-revive` · `slot-view-state` · `git-worktrees` V169 …) — 전량마다 1~8건.
  "3회 연속 flaky 0" 은 미충족 상태 그대로
- (P5) 백그라운드(탭 없는) 에이전트 도구가 죽으면 오류 세션이 탭 없이 남는다 — 부팅 때 "참조 없음" 으로
  버려진다. 런타임에 거두는 자리는 없다
- (P5) 데몬 모드에서 레코드 없이 살아 있는 에이전트 도구(P5 이전 판이 남긴 것)는 빈 옵션으로 채택된다 —
  codex 는 그때 새 thread 가 선다 (한 번뿐인 이행 경로)
- (P5) `agents.json` 은 `backup`·`uninstall` 의 홈 구성표에 들었다 (`homelayout.go`). `dongminal migrate` 는 모른다
- (P5) `app-agent-tool.js` 의 `_newAgentTool(…, opts.resume)` 은 아무도 싣지 않는다 — 재개는 `/api/agent/resume`.
  죽은 코드 후보
- (P6) `runtimebin` 의 `clientWithin` 은 패키지 변수(테스트 주입) — GO-42 와 같은 결. 구조체가 생기면 거기로
- (P6) `wait` 의 `waitClientDefaultBudgetMS`(300_000)는 서버 기본의 사본이다 — `/api/tools/activity/wait` 의
  기본 상한을 `runwait` 로 올려 같은 수로 만들 것 (D-A-1 의 연장)
- (P6) 데몬 모드에서 `ErrToolCap` 이 429 로 옮겨지지 않는다 — `toolclient.Create` 가 RPC 오류를 일반 오류로
  돌려주므로 `errors.Is(err, toolhub.ErrToolCap)` 이 거짓. 재감사 때 발견, P6 범위 밖
- (P6) 전량에서 `agent-tool` TC-AGT-4(슬래시 자동완성 목록)가 처음 flaky 로 잡혔다 — 필터 전 3항목이 보였다.
  단독 2회 반복은 초록. §5-5 군집 밖의 새 후보
- (P6) `dmctl new-window --cwd /없는/경로` 에서 브라우저의 `_mkWindow` 가 400 을 받으면 `_newTool` 이 throw —
  창은 생기고 레이아웃이 반쯤(FUI-25 와 같은 결). e2e 는 잡지 않았다. 프론트의 실패 피드백 자리

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~6분). 판정은 `unexpected 0`. 전량은 **단계마다 1회**
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- **전량이 도는 동안 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라** · **겹쳐 돌리지 마라**(백그라운드는
  `run_in_background` 하나로, 시작 전에 `pgrep -fl e2e-shard-run` 이 0 인지 보라) · 전량 중 다른 무거운
  것(드리프트 잡·`go test`)을 돌리지 마라 · 재시동 없음 · `--isolated`
- `make e2e-rebalance` 는 전량 직후·표적 전에
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고쳐라** (이전/새/이유)
- **새 문구는 `t('ns.key')` 다** — ko·en 둘 다. `check-i18n.mjs` 가 한글 리터럴·키 집합·`t` 가려짐을 잡는다
- 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다 + `helpers.js` 전역 + `index.html` 행 + ko·en —
  TC-CFG-4 의 개수(지금 25)를 올려라
- 오류 코드는 `apierr/codes_core.go`(+`coreCodes`)·`codes_doc.go` 둘 다 → `go run ./scripts/gen-errors`
  (`errors.md` 는 생성물) · 프론트 문장은 `err.<code>` 키
- 스펙에 D-… 를 더하면 `go run ./scripts/gen-decisions` (`decisions.md` 는 생성물)
- **하네스를 복사하지 마라** — 새 단정은 그 설정이 이미 있는 자리에
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names` — e2e·`_test.go` 는 밖이다)
- P1~P6 가 남긴 것(위 절)은 **전부 P7 의 범위**다 — 마지막 단계이므로 미룰 곳이 없다. 거둘 수 없는 것은
  사유와 함께 스펙 §7 비목표 또는 로드맵에 적는다
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만

## 단계 종료 절차 (사용자 지시 2026-09-13 — **모든 단계에 같다**)

단계의 DoD 가 서고 전량 e2e 가 `unexpected 0` 이면, 같은 세션 안에서 순서대로:

  1. 문서 갱신 — `M8_PROGRESS.md`(§1 상태·§1-n 판정표·§2 배운 것) · 스펙 §10 변경 기록 ·
     **이 파일을 다음 단계의 착수 프롬프트로 다시 쓴다** (이 절을 그대로 옮긴다)
  2. `make gates` 초록 확인 뒤 **커밋** (단계 종료 커밋 하나 — 이 지시가 그 확인이다)
  3. 인수인계 — dongminal 접합면으로 **현재 위치에 새 탭**을 열고 claude 를 띄운다:
       `dmctl new-tab -n` (`--at` 없이, 포커스 위치. `new-tab`/`close-tab` 은 `--help` 를
       받지 않고 그대로 실행되니 `--help` 를 치지 마라) → `newTabs[0]` 의 uuid·toolId
       `dmctl rename-tab --at <탭> "M8-P<n+1>"`
       `dmctl send-input --at <탭> --execute "cd '$PWD' && claude"` → `dmctl wait --at <탭> --for ready --timeout-ms 180000`
       (rc=5 면 `dmctl read-screen --at <탭>` 으로 무엇을 묻는지 보고 처리)
       `dmctl msg --to <toolId> -` 로 `[HANDOFF M8 P<n> → P<n+1>]` 엔벨로프 — 이 파일을
       읽고 "먼저 읽을 것" 순서대로 진행하라는 한 문단 + 커밋 해시
       `dmctl status --at <탭>` 로 `working` 확인 (idle 이면 `send-input --execute ""`)
  4. **자기 탭을 닫는다** — `dmctl close-tab --at <자기 탭 uuid>` (`dmctl who-am-i` 의 `uuid=`).
     이것이 세션의 마지막 명령이다
```

---

## 지금 저장소의 상태 (2026-09-14, P6 종료 시점)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행 · **M8 P0~P6 완료** · P7 착수 전 |
| Go | `go test -race -shuffle=on ./...` 초록 (runtimebin 에 P6 테스트 20여 건 · httpapi 3건 · toolhub 1건 · cli 2건 · agentadapter 1건) |
| 드리프트 | `go test -tags agentdrift` — claude·codex·omp 실제 바이너리 셋 초록 (2026-09-14, P6 착수) |
| 게이트 | `make gates` 초록 (36 게이트 · check-i18n 985키) |
| e2e | `agent-tool.spec.ts` 32/32(2회 반복) · 전량 `M8_PROGRESS.md` §1-12 (unexpected 0 · flaky 6) |
| 오류 코드 | `tool_cwd_missing` 추가 (`err.tool_cwd_missing` ko·en) |
| 새 패키지 | `internal/shared/runwait` (① ③ 이 함께 읽는 대기 상한) |
| 커밋 | P6 단계 종료 커밋 `P6_COMMIT` |
