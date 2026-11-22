# 인계: 직접 모드 제거의 후속 — 팬아웃 제거 · 시험 리뷰 · SetClock · V-LAY-1 · 부하 실패

> 작성 2026-11-18. 앞 세션(CLEANUP 탭)이 맥락 53% 에서 넘긴다.
> 직전 커밋 `27f8d780` (main, 푸시하지 않음). **그 뒤의 작업은 커밋되지 않은 채 작업 트리에 있다** — 아래 「먼저 할 일」.

## 착수 블록 — 이번 세션의 지시 전부

사용자 지시(2026-11-18): *"남은것의 2 4 5 6 진행"*. 남은 것 목록은 앞 세션이 보고한 여섯 가운데 넷이다.

### 먼저 할 일 — 앞 세션 작업의 커밋

`git status` 로 작업 트리를 본다(약 120 파일 — e2e 정리 + 직접 모드 제거 + 문서). 앞 세션은 커밋을 시도했으나
**Claude Code 자동 모드의 권한 검사가 `git add -A && git commit` 을 막았다.** 우회하지 마라. 이 세션도 막히면
사용자에게 직접 커밋하거나(`! git add -A && git commit`) 권한을 허용해 달라고 말한다. 사용자는 이번 일의 커밋을
지시했고, 푸시는 지시하지 않았다. 커밋 메시지에 AI 서명 금지. 앞 세션이 준비한 메시지:

```
refactor(server): 직접 모드를 지우고 서버는 늘 데몬에 붙는다 · e2e 기존 실패 정리 (DIRECT_MODE_REMOVAL_SRS)

- 직접 모드 제거: 데몬을 띄우지도 붙지도 못하면 원인과 daemon.log 위치를 남기고 종료 코드 1.
  buildDeps·hub.Wire*·서버 안 간선 노드(initEdge)·WS 직접 처리기·directAttention·run.WithAbortOpenOnLoad·
  chat_daemon_only 를 지운다. toolhub.ToolHub 가 DaemonHub 를 품고 Daemon() 을 없앤다 — ToolManager 는 ToolHub 가 아니다.
- 서버 시험을 데몬 배선(daemonPairAt·edgeDaemonNode)과 추적기(trackedTool·statusPane)로 옮긴다.
  노드 처리기 404 시험은 edgenode 로 옮긴다. hub.AttnTracker.SetClock 을 더한다.
- e2e: Activity 탭 툴팁을 영어로(TIP_ACT_*), 탭 배지를 정원으로. 낡은 시험 넷(줄 이동 패널·분리 대상·모바일 드로어 탭·
  터치 종료)과 edges-settings 의 간선 정리를 고친다.
- 문서: PEER_NETWORK_SRS 묶음 R 폐기 표시, V-LAY-1 linux·win32 보류 기록, 직접 모드 서술 SRS 넷에 제거 표시,
  CHANGELOG·외부 문서·오류 문서·결정 색인.
```

이 커밋이 아래 일의 기준점이다. 아래 일은 그 뒤 **별도 커밋**으로 나눈다.

### 할 일 (순서대로)

1. **(5) `hub.AttnTracker.SetClock` 정리** — 작다. 먼저 끝낸다.
   - 앞 세션이 시험용으로 더한 공개 메서드다(`internal/webserver/hub/attn_tracker.go`). 프로덕션 호출처 0.
     쓰는 곳은 `internal/webserver/httpapi/handlers_status_test.go` 의 `outputClock.Store` 하나.
   - 권장: 공개 API 를 없애고 시험이 다른 길로 시각을 정하게 한다. 후보: 생성자 옵션(`NewAttnTracker` 에
     시계를 받는 변형이 이미 있는지 먼저 본다), 또는 `export_test.go` 는 패키지가 달라 못 쓴다는 점에 유의.
     길이 없으면 SetClock 을 남기되 그 사실과 이유를 `DIRECT_MODE_REMOVAL_SRS` §6 에 적는다. 결정이 둘 이상이면
     사용자에게 권장안과 함께 묻는다(사용자 CLAUDE.md §3).
2. **(4) 옮기거나 지운 서버 시험의 독립 리뷰** — 앞 세션의 판단에 묶이지 않은 리뷰가 목적이다.
   - 대상: 직전 커밋 대비 `*_test.go` 변경 전부(약 50 파일). 특히 **지운 시험**이 지키던 동작을 데몬 쪽 다른 시험이
     지키는지. 지운 것 목록은 `DIRECT_MODE_REMOVAL_SRS.md` §6 에 있다(`directReplay` 여섯 · 직접 모드 텔레그램 콜백 ·
     헬스 "데몬 없음" · 상태 직접·데몬 동치 · 직접 모드 Run 펜싱 · 백그라운드 죽음 훅 · 직접 노드 시험 여럿).
   - 방법: `/code-review` 를 쓰거나, 리뷰 에이전트에게 **결론이 아니라 코드와 diff 만** 준다(사용자 지침).
   - 리뷰가 낸 결함은 확인한 뒤 고친다. 빈자리가 실제면 데몬 배선 위에 시험을 다시 세운다.
3. **(2) `toolhub.Tool` 의 프로세스 안 클라이언트 팬아웃 제거** — 가장 크다. **중·대 규모**다 —
   사용자 CLAUDE.md 절차(스펙 → 시험 → 구현). 스펙은 `DIRECT_MODE_REMOVAL_SRS.md` §7 을 이어 쓰거나 새 절로 둔다.
   - 대상(프로덕션 호출처 0 — 유일한 호출처였던 `handleWSDirect` 를 앞 세션이 지웠다):
     `internal/shared/toolhub/tool_clients.go` 의 `AddClient`·`AddClientAt`·`RemoveClient`·`broadcast`·`enqueueAll`·
     `removeClients`, `Tool.cls`, `tool.go` `feedAndDeliver` 의 `live` 갈래, `tool_control.go:59`(kill 의 OpExit)·`:169`(크기
     통보 broadcast), `conn.go` 의 `SafeConn` 송신 큐·`StartSender`·`Enqueue`(서버 WS 는 `Send` 만 쓰는지 확인).
   - 얽힌 시험: `readpty_hotpath_test.go`·`concurrency_invariants_test.go`·`tool_readpty_panic_test.go` 등. 그 시험이 지키는
     **불변식**(PTY 읽기 루프가 느린 소비자에 막히지 않는다 등)이 데몬의 `OnOutput`·relay 경로에도 걸려 있는지 따로 본다 —
     팬아웃과 함께 불변식 시험까지 지우면 데몬 경로의 보호가 사라질 수 있다.
   - `toolhub` 안에 남은 "직접 모드" 주석(약 12곳, `grep -rn "직접 모드\|direct 모드\|두 모드" internal/shared/toolhub internal/daemon`)을
     이때 함께 고친다.
   - 검증: `go test ./...`, 그리고 터미널 출력 회귀를 e2e 로(`term-resume`·`term-held-input`·`reply-seat` 류 → 마지막에 전량).
4. **(6) V-LAY-1 linux·win32 기준선과 `TestSessionKeep_RealReload` 부하 실패**
   - V-LAY-1: 앞 세션에서 사용자가 "보류"를 골랐으나 이번에 진행을 지시했다. 뜰 길은 CI 뿐이다 —
     `.github/workflows/e2e.yml` 의 잡이 `if: false`(2026-11-04 사용자 결정)이고 이 맥은 docker 데몬이 꺼져 있다.
     방법은 `UI_LAYOUT_DEFAULTS_SRS.md` 끝 기록 절 2026-11-18 둘째 항목. **푸시·CI 실행·워크플로 수정은 바깥으로
     나가는 일이라 사용자 확인 뒤에만 한다.** 권장안을 들고 묻는다: 일회성 `workflow_dispatch` 잡(ui-layout-defaults 만
     `LAYOUT_BASELINE=write`, 산출물 업로드) vs e2e 잡 되살리기 vs docker 를 켜고 linux 만.
   - `TestSessionKeep_RealReload`(`cmd/dongminal/session_keep_posix_test.go`): `make test` 전량 부하 속에서
     `dial paned: hello: paned connection lost` 로 한 번 실패, 단독 3회 통과. 원인을 찾아 고친다(시한·재시도·핸드오버 대기).
     부하를 재현하려면 `go test -count=1 -p 8 ./...` 를 몇 번 돈다. 같은 부류로 `internal/daemon/chat` 의
     `TestPinAfterRelayedState`(3초 시한)도 부하에서 한 번 실패했다 — 같은 원인이면 함께 본다.
5. **마무리**: `make test`·`make gates`·`make lint`·`make unit`·`npm run -s typecheck`·e2e 전량 → 일마다 커밋(사용자 확인 규칙은
   위 「먼저 할 일」 과 같다). 푸시 금지(지시 없음).

## 먼저 읽을 것

1. 이 문서
2. `docs/internal/DIRECT_MODE_REMOVAL_SRS.md` 전체(짧다) — 특히 §6 진행 기록과 §7 남긴 것
3. `docs/internal/CLEANUP_AFTER_EDGE_MESH_HANDOFF.md` 의 「값을 치르고 배운 것」·「결과」
4. 팬아웃(할 일 3)에 들어가기 전: `internal/shared/toolhub/tool.go` 의 `readPTY`·`feedAndDeliver`, `tool_clients.go`, `conn.go`,
   `internal/daemon/ipc/paned_server.go:100~115`(데몬이 출력을 IPC push 로 잇는 자리)

## 값을 치르고 배운 것

- **e2e 가 도는 중에 Go 소스를 고치지 않는다.** 샤드마다 시작할 때 `go build` 를 따로 한다. 앞 세션은 그 틈에 고쳐 샤드
  4~8 을 무효로 만들었다. 문서(docs/)는 바이너리에 안 들어가므로 괜찮다.
- 한 샤드만 다시 돌릴 때는 `scripts/e2e-shard-run.sh <n> 8` 을 쓴다. `npx playwright test e2e/x.spec.ts …` 처럼 `e2e/` 를
  붙이면 "No tests found" 다.
- 서버 시험의 도구 배선: `daemonPairAt(t, dataDir)`(`internal/webserver/httpapi/term_size_daemon_test.go`) — 실제
  `ipc.NewPanedServer` + `toolclient`. 소켓은 `shortHome(t)` 로 짧은 경로에 둔다(유닉스 소켓 경로 상한).
- 간선 시험: `edgeDaemonNode`·`newEdgeNode`(데몬 노드 + 붙은 서버 + `StartEdge` 통로). 노드 포트는 통로가 **비동기로**
  열고 데몬에 알리므로 `waitListening` 으로 기다려야 한다(안 기다리면 `edge_port_closed`).
- 주의·활동 상태는 이제 서버의 `AttnTracker` 에 있다. 추적기 없는 서버는 `noAttention`(무동작). 시험은 `trackedServer`·
  `trackedTool`(`tool_fixtures_test.go`), 상태 시험은 `statusPane`(`handlers_status_test.go`).
- vm 단위 시험(JS)은 `constants.js` 를 싣지 않는다 — 모듈 최상단에서 상수를 읽으면 터진다. 함수로 늦게 읽거나 시험 loader 의
  globals 에 스텁을 더한다.
- `gopls imports -w <파일>` 이 import 정리에 쓸 만하다(`~/go/bin/gopls`). goimports 는 없다.
- `go test -c -o /dev/null -gcflags=-e <pkg>` 가 시험 컴파일 오류를 전부 보여 준다(vet 은 첫 오류에서 멈춘다).
- 에이전트가 받는 dmctl 지침의 원본은 `internal/shared/runtime/agentmemory/CLAUDE.md` 이고, 서버가 뜰 때마다
  `~/.dongminal/bin/agent-memory/CLAUDE.md` 로 설치한다. 앞 세션이 낡은 설치본을 원본으로 바꿨다. 이 세션이 받은 지침에
  `dmctl peer` 가 보이면 그것은 옛 설치본 탓이다 — 그 명령은 없다.

## 변하지 않는 규약

- 커밋 전: `make gates` · `make lint` · `make unit` · `npm run -s typecheck` · 관련 `go test`. 전량은 `make test`(3~4분).
- 커밋 메시지에 AI 서명 금지. 푸시는 지시 없음.
- 스펙 상태 줄은 enum 이고 구현중이면 `> **남은 것**:` 줄이 필요하다. 결정을 바꾸면 `go run ./scripts/gen-decisions`.
- 동작이 바뀌면 이전/새/이유를 스펙과 CHANGELOG 미출시 절에 적는다.
- 문서와 코드가 어긋나면 코드가 진실이다 — 고친다(사용자 2026-11-18: *"문서코드 어긋나면 고쳐야지"*).

## 유효한 사용자 결정

- 직접 모드는 지원 대상이 아니었다 — 전면 제거(완료, 커밋 대기).
- 데몬 실패 시 서버는 오류로 종료한다.
- PEER_NETWORK_SRS FR-PNW-50~ 은 폐기 표시(완료).
- V-LAY-1 linux·win32: 이번에 진행 지시. 단 푸시·CI 는 확인 뒤.
