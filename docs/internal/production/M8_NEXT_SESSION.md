# M8 통합 — 다음 세션 착수 프롬프트 (P6 축 A ⑤ — CLI 계약)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P5 는 끝났다** (2026-09-14, 한 세션 — 커밋 `__P5_COMMIT__`). Go·브라우저·e2e·문서·게이트 전부
초록이고 전량 e2e 는 `M8_PROGRESS.md` §1-10. **P6 는 착수 전**이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 **P6 = 축 A ⑤, CLI 계약** 을 한다 (`docs/internal/M8_UNIFIED_SRS.md` §4 표 P6 · §3.2 표 ⑤ =
`FBE-02`·`04`·`06`·`13~16`·`18` · `FUI-23`(기록) · §3.2 DoD 의 "dmctl 계약" 이하 항목들 · D-U-10). 진입
조건은 P3 였다 — Run 멤버의 기동 경로가 둘(TUI 터미널 도구 · 에이전트 도구)이 된 뒤 한 번에 본다.
**`FBE-06`(codex 프리앰블)은 TUI 멤버에 남는다** — 에이전트 도구 경로는 프롬프트를 프레임으로 넣으므로
그 문제가 없다. 작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/production/10-func-backend.md` — `FBE-02`(§77) · `FBE-04`(§100) · `FBE-06`(§120) ·
   `FBE-13~16`(§176~) · `FBE-18`(§193, 보안 축 04-Sec 와 조율) · §285 미측정 항목 · §297 표. 이것이 요구의
   원문이다. `FUI-23` 은 `12-func-ui.md` §106 에 있다 — 기록만(조치 제안 없음)
2. `docs/internal/M8_UNIFIED_SRS.md` — §3.2 표 ⑤ 와 DoD 중 CLI 계약 항목(`runPost`/`runGet` 예산 ·
   `dmctlHTTPResult.delivered` · `/api/runs/close` 의 `closed` · `run launch` 의 codex 안내 · `--isolated`
   안내 · `termReset` 두 모드 · `status --member` · `run delete`·`run graph` · 없는 `--cwd` 400 · `wrapPaste`
   의 `ESC[201~`) · §10 "P5 완료" 행 · D-U-10
3. `docs/internal/production/M8_PROGRESS.md` §1-9(P5 판정표)·§1-10(전량)·§2-29~2-31(P5 가 배운 것) ·
   §1-1(P1 판정표 — ④ 에서 이미 닫힌 것: `FBE-05/12` 데몬 kill 유예 3초 · `GO-46` ToolHub)
4. 코드:
   - `internal/ctl/cli/dmctl*.go`(`runPost`·`runGet`·`dmctlHTTPResult` · `dmctl_status.go` 의 `wait` 가 예산을
     받는 모범) · `internal/webserver/httpapi/handlers_runs*.go`(`/api/runs/close`·`launch`·헤드리스) ·
     `handlers_commands*.go`(방송 결과 `delivered`·`newTabs`)
   - `internal/shared/agentadapter/*.go` 의 터미널 표면(`Launch`·`PromptInjection`·`PromptArgv`) — FBE-06
     은 codex 의 `PromptInjection != PromptArgv` 안내다. 프로토콜 표면(`*_proto.go`)은 건드리지 않는다
   - `web/js/core/app-runs*.js`(Run 의 UI 쪽 — `run delete`·`run graph` 의 격차 FUI-04 와 짝)
   - `e2e/dmctl*.spec.ts` · `e2e/run*.spec.ts` · `internal/ctl/cli/*_test.go`

## 남은 일 (순서)

1. **착수 실측** — `go test -tags agentdrift -run TestDrift -v ./internal/shared/agentadapter/`
   (PATH 에 codex 가 없으면 `~/.bun/install/cache/@openai/codex@0.154.0-*/vendor/aarch64-apple-darwin/bin`
   을 앞에 둔다). 셋 초록이어야 착수. P6 는 어댑터의 프로토콜 표면을 고치지 않으므로 이것으로 끝
2. **재감사** — 10-func-backend 의 항목마다 지금 코드에서 사실인지 다시 잰다(P1 §2-10 의 교훈: 감사의 줄
   번호는 낡고 몇은 이미 닫혀 있다). 닫힌 것은 판정표에 "이미 해소" 로, 남은 것만 스펙 §5 에 D-A-… 로
   결정을 적는다 — 특히 `FBE-02` 의 **exit 1 전환은 동작 변경**이라(로드맵 §1113) 이전/새/이유를 적는다
3. **구현** — Spec → Test → Code. CLI 는 `internal/ctl/cli` 테스트가, HTTP 는 httpapi 테스트가, 브라우저 없는
   `dmctl` 은 통합 테스트가 잰다 ("전임자가 60초 뒤 답해도 `succeed` 가 성공" 은 통합 테스트로)
4. **V 전량**: `go test -race ./...` · `make gates` · `make unit` · `make test` · V-11(훅 표면 diff 0 ·
   `claude.go`·`codex.go`·`omp.go` 의 **프로토콜 필드**는 그대로) · `make e2e` → `unexpected 0` →
   `make e2e-rebalance`
5. **문서** — `M8_PROGRESS.md` §1 표(P6 완료)·§1-11 판정표·§1-12 전량 · 스펙 §10 "P6 완료" 행 ·
   `docs/external/commands.md`(dmctl 헬프가 바뀌면 `check-commands-docs`) · `api.md` · 이 파일을
   **P7 착수 프롬프트**로 다시 쓴다
6. **커밋** — 단계 종료 커밋 하나 (`feat(m8): P6 — 축 A ⑤ CLI 계약 …`). 사용자 확인 뒤
7. **인수인계** P7 (아래 절차)

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

## 사용자 결정·지시 (P3~P5 것 — P6 에도 적용)

- FR-AGT-4 질문 답변 · FR-AGT-4a(Esc·↑↓·`/`·Shift+Tab — *"최대한 tui agent 의 모든 공통 기능을 이용하게"*)
- 자격증명이 없으면 무모델 프레임까지만 실측하고 "미확인 — 자격증명 없음" 으로 적는다 — 사용자에게
  자격증명을 묻지 마라 (P0 의 사용자 결정)
- `-p --input-format stream-json` 은 1회성이 아니다 (실측 §2-19)
- 출력에 이모티콘을 쓰지 않는다

## P5 가 P6·P7 에 남긴 것

- 백그라운드(탭 없는) 에이전트 도구가 죽으면 오류 세션이 탭 없이 남는다 — 부팅 때 "참조 없음" 으로 버려진다.
  런타임에 거두는 자리는 없다 (P7 의 죽은 코드·분리 축에서 볼 것)
- 데몬 모드에서 레코드 없이 살아 있는 에이전트 도구(P5 이전 판이 남긴 것)는 빈 옵션으로 채택된다 — codex 는
  그때 새 thread 가 선다 (한 번뿐인 이행 경로)
- `agents.json` 은 `backup`·`uninstall` 의 홈 구성표에 들었다 (`homelayout.go`). `dongminal migrate` 는 모른다
- `app-agent-tool.js` 의 `_newAgentTool(…, opts.resume)` 은 여전히 아무도 싣지 않는다 — 재개는
  `/api/agent/resume` 이다. P7 의 죽은 코드 후보

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
- P1~P5 가 남긴 것(GO-44 `Git *store.Store`·GO-42·`time.Sleep` 잔여·`fail()` 한국어 본문·§5-5 flaky 군집·위
  "P5 가 남긴 것")은 P6 의 범위에 든 것만 줍고 나머지는 P7 — 줍지 마라
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

## 지금 저장소의 상태 (2026-09-14, P5 종료 시점)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행 · **M8 P0~P5 완료** · P6·P7 착수 전 |
| Go | `go test -race -shuffle=on ./...` 초록 (agentadapter 23 · fakeagent 6 · agentsess 22 · httpapi AgentAPI 13 · settingsschema TC-CFG-4 = 25키) |
| 드리프트 | `go test -tags agentdrift` — claude·codex·omp 실제 바이너리 셋 초록 (2026-09-14, 어댑터 수정 뒤 재실행) |
| 게이트 | `make gates` 초록 (36 게이트 · check-i18n 984키) |
| e2e | `agent-tool.spec.ts` 16/16 (2회 반복 32/32) · 전량 `M8_PROGRESS.md` §1-10 |
| 카탈로그 | `agent.*` 58키 + `html.agent_approval*` 2키 + `err.agent_*` 7키 (ko·en) |
| 커밋 | P5 단계 종료 커밋 `__P5_COMMIT__` |
