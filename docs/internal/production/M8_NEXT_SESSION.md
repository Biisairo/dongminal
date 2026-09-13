# M8 통합 — 다음 세션 착수 프롬프트 (P4 축 C-b, codex · omp 어댑터)

아래 블록을 새 세션에 그대로 붙여넣으면 된다.

**P3 는 끝났다** (2026-09-13, 두 세션 — 커밋 `13918d6`). Go·브라우저·e2e·문서·게이트 전부
초록이고 전량 e2e 는 `M8_PROGRESS.md` §1-6. **P4 는 착수 전**이다.

---

```
프로젝트: /Users/dykim/personal/dongminal

M8 통합의 **P4 = 축 C-b, codex · omp 어댑터** 를 한다 (`docs/internal/M8_UNIFIED_SRS.md` §4 표 P4 ·
§2.3.3 · §3.4.1 묶음 P · FR-U-2 · §9.1 U-1·U-2·U-4·U-5·U-7 · §9.3 ①·③ · F-3·F-4 · R-1·R-5). P3 가
claude 한 벌로 세운 자리(`Adapter.Proto` · 해석층 `agentsess` · `/api/agent/*` · `AgentPane` · 가짜
에이전트)에 **두 어댑터를 더 꽂는다** — 소비자 쪽(해석층·HTTP·뷰)은 한 줄도 바뀌지 않아야
한다 (FR-U-2 "소비자 쪽은 달라지지 않는다"). 작업 트리는 깨끗하다 — `git status` 로 확인하라.

## 먼저 읽을 것 (순서대로)

1. `docs/internal/M8_UNIFIED_SRS.md` — §10 의 "P3 완료" 행 · **D-C-1~10** (D-C-10: 종류는 청크에 실려
   온다) · §2.3.3(세 프로토콜 표면) · §9.1 표의 U-1(omp rpc-ui 프레임)·U-2(codex 다중 thread)·
   U-4(재개)·U-5(omp 사용량)·U-7(종료 = stdin EOF) · §9.3 ①(기능 대조표)·③(`Proto` 시안과 P3 실제
   모양) · **F-3**(AS-1 정정: 한 프로세스를 한 도구로, 다중화 안 씀) · **F-4**(omp 는 기본 yolo —
   `Proto.Launch` 가 `--mode rpc-ui --approval-mode <정책>` 을 반드시 싣고, 정책 값은 설정 키
   `SETTINGS_SCHEMA`·`SETTINGS_ACCESS` 둘 다) · R-1(codex app-server experimental)·R-5(omp 미실측)
2. `docs/internal/production/M8_PROGRESS.md` §1-5(P3 판정표)·§1-6(전량)·§2-19~2-26(P3 가 배운 것 —
   특히 §2-25 readLoop 자기 RPC, §2-26 뷰의 재생 경합)
3. 코드 — claude 구현이 본보기다:
   - `internal/shared/agentadapter/proto.go`(Proto·Event·ApprovalRequest·Decision·ProtoState·ProtoStatus —
     **공통 어휘, 여기가 바뀌면 소비자가 바뀐다**) · `claude_proto.go`(Launch·Decode·Approve·Control·
     Interrupt·TUIResume·PermissionModes) · `claude_proto_test.go`(실측 프레임 형태) · `proto_test.go`
     (R-8 표 — 세 어댑터를 같은 표로 잰다) · `codex.go`·`omp.go`(터미널 표면 — 여기에 `Proto:` 한 줄)
   - `fakeagent/`(D-C-9: 프롬프트 본문으로 시나리오 APPROVE·QUESTION·SLOW·DIE·`/clear`) — 가짜가
     **세 프로토콜을 말해야** e2e 가 셋을 잰다(§9.2 R-a). 지금은 claude 판만 있다
   - `internal/webserver/domain/agentsess/session.go`(해석층 — 바뀌면 안 된다) · `httpapi/handlers_agent.go`
     (`resolveAgentBin`: `DONGMINAL_AGENT_BIN_DIR/<DetectCmd>` → PATH · `GET /api/agents` 가 `proto`·
     `available` 을 낸다)
   - `web/js/ui/agent-pane.js`(뷰 — 에이전트 이름을 모른다) · `e2e/agent-tool.spec.ts`(`AGENT='claude'`
     상수 하나 — 셋을 재려면 매개변수화)
   - `docs/external/api.md` "에이전트 도구 (프로토콜 표면)" 표 · `docs/external/getting-started.md`
     환경변수 표(`DONGMINAL_AGENT_BIN_DIR`)

## 남은 일 (순서)

1. **실측이 먼저다** (R-5 · §9.1 규약 "추측해 채우지 않는다"). codex `app-server`·omp `--mode rpc-ui`
   를 P0 의 드라이버(`/tmp/m8-spike/drive.py` 가 남아 있으면 그것, 없으면 같은 것을 다시)로 띄워
   §2.3.4 와 같은 표를 §2.3.3 아래에 만든다. 자격증명이 없으면(P0 때 codex 토큰 만료·omp 키 401)
   **무모델 프레임**(init·승인 요청·종료)까지만 실측하고 턴 의존 칸은 "미확인 — 자격증명 없음" 으로
   남긴다 — 사용자에게 자격증명을 묻지 말고 그렇게 적어라(P0 의 사용자 결정 그대로)
2. **FR-U-2 첫 판정** — 둘 다 `Proto` 한 구조체에 들어가는가. codex 는 JSON-RPC(id 응답·서버→클라
   request)라 `Decode` 가 상태(`ProtoState`)를 더 들어야 할 수 있고, omp 의 `extension_ui_request` 는
   승인 외의 위젯(selector·dialog)도 온다 — `ApprovalRequest.Kind` 로 받을 수 있는지가 판정. 안
   들어가면 **같은 등록부에 GUI 용 어댑터를 따로**(사용자 결정) — 소비자는 그대로
3. **구현** — `codex_proto.go`·`omp_proto.go` + 테스트(`proto_test.go` R-8 표에 행 추가). F-4 의
   설정 키(omp 승인 정책) · F-3(codex 는 thread 하나만 쓴다). `fakeagent` 에 두 프로토콜 판을 더해
   `agent_api_test.go`·e2e 가 셋을 돈다
4. **codex 대조 잡의 주기 결정** (§4 P4 · D-U-5 "대조 잡의 주기는 P4 에서") — 로컬·야간 잡(§9.2 R-a)
   의 모양과 주기를 스펙 §8/§9.2 에 적는다. CI 에는 넣지 않는다
5. **V 전량**: `go test -race ./...` · `make gates` · `make unit` · `make test` · V-11(훅 표면 diff 0 ·
   `claude.go`·`codex.go`·`omp.go` 는 `Proto:` 한 줄씩) · `make e2e` → `unexpected 0` → `make e2e-rebalance`
6. **문서** — `M8_PROGRESS.md` §1 표(P4 완료)·§1-7 판정표·§1-8 전량 · 스펙 §10 "P4 완료" 행 ·
   `architecture.md` "프로토콜 표면" 절에 두 어댑터 · 이 파일을 **P5 착수 프롬프트**로 다시 쓴다
7. **커밋** — 단계 종료 커밋 하나 (`feat(m8): P4 — 축 C-b …`). 사용자 확인 뒤
8. **인수인계** P5 (아래 절차)

## P3 가 확정한 것 (바꾸지 않는다)

  D-C-1  에이전트 탭 = `type:'agent'` + `toolId`. 종류를 묻는 자리는 셋(해석층·뷰·전송 호출)
  D-C-2  해석층은 서버(`agentsess`). 직접 모드 `ToolHooks.OnOutput`, 데몬 모드 `SetOnOutput` 사슬.
         에이전트 도구 바이트는 `AttnTracker.FeedOutput` 을 지나지 않는다. 활동 보고는 `reportActivity` 한 자리
  D-C-3  이벤트 로그는 메모리 링 4096 · `GET /api/agent/events?tool&since` · SSE `agent_event{toolId,seq,at,ev}`
  D-C-4  비소유자 승인 응답을 서버가 거절하지 않는다
  D-C-5  에이전트 도구는 tools.json 에 없다 (P5 휴면·재개가 되살림)
  D-C-6  stderr → dmlog
  D-C-7  실행 파일: `DONGMINAL_AGENT_BIN_DIR/<DetectCmd>` → PATH
  D-C-8  데몬 push 는 에이전트 도구에서 non-droppable
  D-C-9  가짜 에이전트는 프롬프트 본문으로 시나리오
  D-C-10 **종류는 청크에 실려 온다** — `OnOutput(id, kind, data, end)`. 해석층 입구가 목록에 되묻지
         않는다 (데몬 readLoop 안의 RPC 는 자기 응답을 기다린다 — §2-25)

  탭 메뉴(FR-CMU-8)는 셋 그대로 + 에이전트 탭이면 `터미널로 열기`. 에이전트 탭 **만들기**는 `+`
  우클릭(FR-CMU-8a)에만 — TC-CMU-3 이 그것을 잰다.

## 사용자 결정·지시 (P3 것 — P4 에도 적용)

- FR-AGT-4 질문 답변 · FR-AGT-4a(Esc·↑↓·`/`·Shift+Tab — *"최대한 tui agent 의 모든 공통 기능을 이용하게"*)
  → codex·omp 에서도 `Proto` 가 지원하는 만큼 같은 뷰가 같은 기능을 낸다. 없는 것은 부재(FR-APS-4)
- `-p --input-format stream-json` 은 1회성이 아니다 (실측 §2-19)
- 출력에 이모티콘을 쓰지 않는다

## 변하지 않는 규약

- **로컬 전량은 `make e2e`** (8샤드 병렬, ~4.5분). 판정은 `unexpected 0`. 전량은 **단계마다 1회**
- **출력을 자르지 마라.** `LC_ALL=C grep -a` 로 읽어라
- **전량이 도는 동안 `web/js`·CSS·`scripts/`·`e2e/` 를 고치지 마라** · 겹쳐 돌리지 마라 · 재시동 없음 · `--isolated`
- `make e2e-rebalance` 는 전량 직후·표적 전에
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고쳐라** (이전/새/이유)
- **새 문구는 `t('ns.key')` 다** — ko·en 둘 다. `check-i18n.mjs` 가 한글 리터럴·키 집합·`t` 가려짐을 잡는다
  (renderer 의 탭 메뉴 자리는 지역 `t` 가 전역을 가린다 — 상수로 우회했다: `AGENT_OPEN_TERMINAL`)
- **하네스를 복사하지 마라** — 새 단정은 그 설정이 이미 있는 자리에
- `decisions.md`·`errors.md` 는 생성물이다
- 에이전트 이름을 등록부 밖에 적지 마라 (`check-agent-names` — e2e·`_test.go` 는 밖이다)
- P1·P2·P3 가 남긴 것(GO-44 `Git *store.Store`·GO-42·`time.Sleep` 잔여·`fail()` 한국어 본문·§5-5 flaky 군집)은 P7 — 줍지 마라
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

## 지금 저장소의 상태 (2026-09-13, P3 종료 시점)

| 항목 | 값 |
|---|---|
| 마일스톤 | M0~M3·M5·M6·M7 완료 · M4 미수행 · **M8 P0·P1·P2·P3 완료** · P4~P7 착수 전 |
| Go | `go test -race -shuffle=on ./...` 초록 (agentadapter 8 · fakeagent 5 · platform pipe 2 · toolhub agentkind 5 · agentsess 9 · httpapi AgentAPI 7) |
| 게이트 | `make gates` 초록 (36 게이트 · check-i18n 967키 · decisions 475건 · api-docs 159) |
| e2e | `agent-tool.spec.ts` 7/7 (3회 반복 21/21) · 전량 `M8_PROGRESS.md` §1-6 |
| 카탈로그 | `agent.*` 46키 + `err.*` 6키 (ko·en) |
| 커밋 | P3 단계 종료 커밋 `13918d6` |
