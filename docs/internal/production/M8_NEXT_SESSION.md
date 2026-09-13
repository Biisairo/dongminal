# M8 통합 — 다음 세션 착수 프롬프트 (P5 축 C-c, 묶음 B — 이벤트 로그·재생·휴면·재개·오류 상태)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P4 는 끝났다** (2026-09-13, 한 세션 — 커밋 `0306db4`). Go·브라우저·e2e·문서·게이트 전부
초록이고 전량 e2e 는 `M8_PROGRESS.md` §1-8. **P5 는 착수 전**이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 **P5 = 축 C-c, 묶음 B** 를 한다 (`docs/internal/M8_UNIFIED_SRS.md` §4 표 P5 · §3.4.4
FR-ABG-1~5·10·11·20·21 · NFR-C-2 · D-C-3·D-C-5·D-C-6 · §9.1 U-4(재개)·U-6(`--bg` 는 아니다)·U-7(종료) ·
§9.3 ④ 의 "stderr" 조건 · V-3·V-8). P3 가 메모리 링(4096)과 `GET /api/agent/events?tool&since` 로
세운 재생 위에 **디스크 영속 · 요약 스냅샷(잘린 앞부분) · 휴면(프로세스 없음, 신원만) · 재개
(`--resume`/`thread/resume`/`--resume`) · 연결 끊김의 오류 상태(FR-ABG-20, stderr 사유 포함)** 를
올린다. 세 어댑터(P3 claude · P4 codex·omp)가 전부 있으므로 재개는 셋에서 잰다. 작업 트리는
깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` — §10 의 "P4 완료" 행 · **§3.4.4 묶음 B 전부** · NFR-C-2 ·
   D-C-3(메모리 링은 P3 값)·D-C-5(에이전트 도구는 tools.json 에 없다 — P5 의 휴면·재개가 되살린다)·
   D-C-6(stderr 는 dmlog — FR-ABG-20 과 함께 UI 로) · §2.3.3 **P4 재실측 표의 "재개" 행**(codex:
   살아 있는 프로세스에 핸드셰이크를 다시 보내면 새 thread 가 선다 — `AgentAdoptExisting` 이 thread 를
   잃는다 · omp: 없는 id 는 exit 1) · §9.3 ③ "P4 판정"(계약이 움직인 셋) · §9.1 U-4(셋 다 이력을
   재생하지 않는다 — 재생 원천은 우리 로그뿐)
2. `docs/internal/production/M8_PROGRESS.md` §1-7(P4 판정표)·§1-8(전량)·§2-27~2-28(P4 가 배운 것 —
   특히 **§2-28: claude 의 `system:init` 은 첫 프롬프트 뒤에 온다**; 실제 claude 는 첫 턴 전까지 세션
   신원이 없다 — 휴면·재개의 신원 설계가 이것을 안아야 한다. P3 의 가짜는 기동 즉시 낸다 — 실제에
   맞추는 것도 P5)
3. 코드:
   - `internal/webserver/domain/agentsess/session.go`(해석층 — 링·재생·`Open(toolID, ad, opts)`) ·
     `internal/webserver/httpapi/handlers_agent.go`(`AgentAdoptExisting`·`/api/agent/*`)
   - `internal/shared/agentadapter/proto.go`(공통 어휘) · `claude_proto.go`·`codex_proto.go`·
     `omp_proto.go`(재개는 `LaunchOpts.Resume` — claude·omp 는 argv, codex 는 `Handshake` 의
     `thread/resume`) · `drift_test.go`(`-tags agentdrift`, 실제 바이너리 대조 — 단계 착수 때 한 번 돌려라)
   - `fakeagent/`(세 판 — argv 모양으로 고른다. `--resume` 은 세 판 다 받는다)
   - `internal/shared/toolhub/`(`Tool.Kind=agent` 변형 · `NewDetachedTool` · 영속 `tools.json` 제외 자리)
   - `web/js/ui/agent-pane.js`(`truncated` 표시는 P3 에 이미 있다 — FR-ABG-21 의 UI 몫 절반) ·
     `web/js/core/app-agent-tool.js`(`_newAgentTool` 의 `resume` 옵션 — 아직 아무도 싣지 않는다)
   - `e2e/agent-tool.spec.ts`(13건 — 앞 7 claude, 뒤 6 은 codex·omp 행렬) · `e2e/global-setup.ts`
     (가짜를 세 이름으로 복사한다)

## 남은 일 (순서)

1. **착수 실측** — `go test -tags agentdrift -run TestDrift -v ./internal/shared/agentadapter/`
   (PATH 에 codex 가 없으면 `~/.bun/install/cache/@openai/codex@0.154.0-*/vendor/aarch64-apple-darwin/bin`
   을 앞에 둔다). 셋 초록이어야 착수. 재개 실측은 P0·P4 표로 충분하되 **omp 의 `--resume` 접두 길이**와
   **codex 의 `thread/resume` 이 실행 중 thread 를 rejoin 하는 경우**(스키마 설명 "If thread_id identifies
   a running thread, app-server rejoins")는 드라이버로 한 번 더 본다 (자격증명 없음 — 무모델)
2. **설계 결정** (스펙 §5 에 D-C-11~ 로 적는다): ① 이벤트 로그의 디스크 형식·자리(데이터 디렉터리 아래
   도구별 JSONL? 회전 규칙 = NFR-C-2) ② 요약 스냅샷의 내용(FR-ABG-21: 마지막 assistant 누적 + 열린
   요청 + 사용량 + **status**)과 재생 응답의 모양 ③ 휴면 레코드 — 어댑터 id·세션 신원·cwd·모델·
   승인 정책(`approval`)·마지막 seq 를 어디에 남기나(D-C-5 의 `tools.json` 제외를 어떻게 푸나 — 별도
   `agents.json`?) ④ 오류 상태의 표현 — `EvExit` 에 사유(exit code · stderr 마지막 줄들)를 싣는가,
   새 이벤트 종류인가 (공통 어휘가 바뀌면 소비자가 바뀐다 — 최소로) ⑤ claude 의 "첫 턴 전 신원 없음"
   을 휴면이 어떻게 다루나(신원 없는 도구는 휴면 불가? 첫 턴을 기다린다?)
3. **구현** — Spec → Test → Code. 해석층(agentsess)·HTTP(`/api/agent/hibernate`·`resume` 류)·뷰(휴면
   탭의 모양·재개 버튼·오류 상태·stderr 사유)·toolhub(휴면 도구는 PTY 도 프로세스도 없는 합성 Tool —
   `NewDetachedTool` 이 그 길) · 가짜 에이전트의 `--resume` 이 이력 없이 신원만 되돌리는 것(U-4 그대로)
4. **V 전량**: `go test -race ./...` · `make gates` · `make unit` · `make test` · V-11(훅 표면 diff 0 ·
   `claude.go`·`codex.go`·`omp.go` 는 `Proto:` 한 줄씩) · `make e2e` → `unexpected 0` → `make e2e-rebalance`
5. **문서** — `M8_PROGRESS.md` §1 표(P5 완료)·§1-9 판정표·§1-10 전량 · 스펙 §10 "P5 완료" 행 ·
   `architecture.md` "프로토콜 표면" 절 · `docs/external/api.md` · 이 파일을 **P6 착수 프롬프트**로 다시 쓴다
6. **커밋** — 단계 종료 커밋 하나 (`feat(m8): P5 — 축 C-c …`). 사용자 확인 뒤
7. **인수인계** P6 (아래 절차)

## P3·P4 가 확정한 것 (바꾸지 않는다)

  D-C-1  에이전트 탭 = `type:'agent'` + `toolId`. 종류를 묻는 자리는 셋(해석층·뷰·전송 호출)
  D-C-2  해석층은 서버(`agentsess`). 직접 모드 `ToolHooks.OnOutput`, 데몬 모드 `SetOnOutput` 사슬.
         에이전트 도구 바이트는 `AttnTracker.FeedOutput` 을 지나지 않는다. 활동 보고는 `reportActivity` 한 자리
  D-C-3  이벤트 로그는 메모리 링 4096 · `GET /api/agent/events?tool&since` · SSE `agent_event{toolId,seq,at,ev}`
         (P5 가 디스크·스냅샷을 올린다 — 재생 계약 `since`/`seq`/`truncated` 는 유지)
  D-C-4  비소유자 승인 응답을 서버가 거절하지 않는다
  D-C-5  에이전트 도구는 tools.json 에 없다 (P5 휴면·재개가 되살림)
  D-C-6  stderr → dmlog (P5 가 FR-ABG-20 의 사유로 UI 에 싣는다)
  D-C-7  실행 파일: `DONGMINAL_AGENT_BIN_DIR/<DetectCmd>` → PATH
  D-C-8  데몬 push 는 에이전트 도구에서 non-droppable
  D-C-9  가짜 에이전트는 프롬프트 본문으로 시나리오 (세 판 같다)
  D-C-10 종류는 청크에 실려 온다 — `OnOutput(id, kind, data, end)`. 해석층 입구가 목록에 되묻지 않는다
  FR-U-2 첫 판정(P4): 세 어댑터가 `Proto` 한 구조체에 든다 — GUI 용 어댑터 없음. 계약: `Handshake(opts, st)` ·
         `LaunchOpts.Approval`(설정 `agentApprovalMode`, 생성 쿼리 `approval`) · `Question.FreeText`
  D-U-5  대조 잡 = `drift_test.go`(`-tags agentdrift`), 주기는 사건(단계 착수·바이너리 판 오름·어댑터 수정). CI 밖
  F-3    한 프로세스를 한 도구로 — codex 는 thread 하나만 쓴다
  F-4    omp 는 `--approval-mode` 를 반드시 싣는다 (비면 `always-ask`)

  탭 메뉴(FR-CMU-8)는 셋 그대로 + 에이전트 탭이면 `터미널로 열기`. 에이전트 탭 **만들기**는 `+`
  우클릭(FR-CMU-8a)에만 — TC-CMU-3 이 그것을 잰다.

## 사용자 결정·지시 (P3·P4 것 — P5 에도 적용)

- FR-AGT-4 질문 답변 · FR-AGT-4a(Esc·↑↓·`/`·Shift+Tab — *"최대한 tui agent 의 모든 공통 기능을 이용하게"*)
- 자격증명이 없으면 무모델 프레임까지만 실측하고 "미확인 — 자격증명 없음" 으로 적는다 — 사용자에게
  자격증명을 묻지 마라 (P0 의 사용자 결정)
- `-p --input-format stream-json` 은 1회성이 아니다 (실측 §2-19)
- 출력에 이모티콘을 쓰지 않는다

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~6분). 판정은 `unexpected 0`. 전량은 **단계마다 1회**
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- **전량이 도는 동안 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라** · **겹쳐 돌리지 마라**(P4 가
  `&` 로 띄운 첫 실행이 살아남아 둘째와 겹쳤고, 서로의 trace·홈을 지워 실패가 폭주했다 — 백그라운드는
  `run_in_background` 하나로, 시작 전에 `pgrep -fl e2e-shard-run` 이 0 인지 보라) · 전량 중 다른
  무거운 것(드리프트 잡·`go test`)을 돌리지 마라 · 재시동 없음 · `--isolated`
- `make e2e-rebalance` 는 전량 직후·표적 전에
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고쳐라** (이전/새/이유)
- **새 문구는 `t('ns.key')` 다** — ko·en 둘 다. `check-i18n.mjs` 가 한글 리터럴·키 집합·`t` 가려짐을 잡는다
  (renderer 의 탭 메뉴 자리는 지역 `t` 가 전역을 가린다 — 상수로 우회했다: `AGENT_OPEN_TERMINAL`)
- 설정 키는 `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다 + `helpers.js` 전역 + `index.html` 행 + ko·en —
  TC-CFG-4 의 개수(지금 25)를 올려라
- **하네스를 복사하지 마라** — 새 단정은 그 설정이 이미 있는 자리에
- `decisions.md`·`errors.md` 는 생성물이다
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names` — e2e·`_test.go` 는 밖이다. 가짜는 argv
  모양으로 판을 고른다 — 이름을 넣지 마라)
- P1~P4 가 남긴 것(GO-44 `Git *store.Store`·GO-42·`time.Sleep` 잔여·`fail()` 한국어 본문·§5-5 flaky
  군집·claude 가짜의 기동 즉시 `system:init`)은 P5 의 범위에 든 것만 줍고 나머지는 P7 — 줍지 마라
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

## 지금 저장소의 상태 (2026-09-13, P4 종료 시점)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행 · **M8 P0·P1·P2·P3·P4 완료** · P5~P7 착수 전 |
| Go | `go test -race -shuffle=on ./...` 초록 (agentadapter 22 · fakeagent 6 · agentsess 9 · httpapi AgentAPI 8 · settingsschema TC-CFG-4 = 25키) |
| 드리프트 | `go test -tags agentdrift` — claude·codex·omp 실제 바이너리 셋 초록 (2026-09-13) |
| 게이트 | `make gates` 초록 (36 게이트 · check-i18n 969키) |
| e2e | `agent-tool.spec.ts` 13/13 · 전량 `M8_PROGRESS.md` §1-8 |
| 카탈로그 | `agent.*` 46키 + `html.agent_approval*` 2키 (ko·en) |
| 커밋 | P4 단계 종료 커밋 `0306db4` |
