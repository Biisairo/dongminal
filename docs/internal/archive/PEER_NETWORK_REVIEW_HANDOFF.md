# 인계: PEER_NETWORK 리뷰 결함 수정 (2차 재리뷰 잔여)

## 1. 착수 블록 (이번 세션의 지시 전부)

- **사용자 지시**: "모든 문제를 리뷰하고 해결해서 완벽하게 완성되면 그때 알려 줘." 실제 PC 시험은 사용자가 따로 한다.
- **할 일**:
  1. §3 의 남은 결함을 모두 고친다.
  2. 고친 뒤 독립 리뷰를 다시 돌린다. 보안 1명과 정확성 1명, `deep-harness:reviewer`, 백그라운드로 돌리고, 리뷰어에게는 결론이 아니라 코드와 범위만 준다.
  3. 새 결함이 없을 때까지 반복하고, 끝나면 사용자에게 보고한다.
- **방식**: SDD + TDD.
  - 결함마다 실패하는 테스트를 먼저 쓴다(RED). 그다음 고친다(GREEN).
  - 결정은 `docs/internal/PEER_NETWORK_SRS.md` §9.5 의 표에 **I-62 부터** 적는다.
  - `go run ./scripts/gen-decisions` 는 `D-` 결정만 색인한다. `I-` 항목은 색인에 바뀌는 것이 없다.
- **질문**: 설계 결정이 필요한 것만 묻는다. 한 번에 하나씩, 권장안과 함께 묻는다. 사용자는 쉽고 자세한 설명을 원한다. 모르면 "이해 못했어"라고 되묻는다.
- **커밋**: 사용자가 "커밋 및 진행 알아서"를 허락했다.
  - 묶음마다 검증을 통과하면 스스로 커밋한다.
  - AI 서명은 넣지 않는다. push 하지 않는다. 사용자의 dongminal 을 재시작하지 않는다.
- **완료 조건(묶음마다)**:
  - `make gates`, `make lint`, `go test ./...`, `npm run -s unit`, `npm run -s typecheck`, `GOOS=windows go build ./...`
  - 화면을 바꿨으면 `npx playwright test e2e/peers-settings.spec.ts` 도 돌린다.

## 2. 어디까지 왔나

- 이 작업의 커밋(순서대로): `c7613db0`(1차) · `42edad7f`(2차) · `a9cb1a06`(테스트 공백) · `dfd6d88c`(1차 재리뷰 수정) · `3997e022`(2차 재리뷰 일부, 마지막)
- 원래 인계 문서의 H-1, M-1~M-8, L-1~L-16 은 모두 고쳤다. 결정은 SRS §9.5 의 I-30~I-61 에 있다.
- 2차 재리뷰(보안 1, 정확성 1)의 결과 중 일부를 `3997e022` 에서 고쳤다. 남은 것이 §3 이다.
- 원래 있던 실패(이번 일과 무관, 고치지 않는다): `e2e/event-timer-hub-contract` 의 T-1·T-1b, `web/js/test/cm-sticky.test.mjs`(가끔 흔들림), `git-sidebar.spec.ts` 의 S7.

## 3. 남은 결함 (2차 재리뷰, 아직 고치지 않음 — 고치기 전에 코드로 다시 확인한다)

### 정확성 리뷰 잔여

- **C2 [LOW]** `/api/peers/call` 이 성공해 pending-out 을 짝으로 바꿔도 방송하지 않는다.
  - 위치: `httpapi/peer_commands.go` `apiPeersCall` 의 `s.peers.Promote` 자리
  - 수정: `if s.peers.Promote(fp) { s.peersChanged("") }`. api.md 의 방송 조건과 맞춘다.
- **C3 [LOW]** `Store.Promote` 는 확인(`IsPendingOut`)과 갱신(`update`) 사이에 락을 놓는다(TOCTOU).
  - 위치: `domain/peer/config.go` `Promote`
  - 경합 1: 그 사이 만료·해제되면 true 를 돌려준다.
  - 경합 2: confirm 과 call 회복이 동시에 오면 둘째가 false 를 받는다. 그러면 `peerPairConfirm` 이 500 `save_failed` 로 잘못 답한다.
  - 수정: 락 안에서 확인하고 바꾼다. "이미 짝"·"없음"·"저장 실패"를 구분해 돌려준다.
- **C4 [LOW]** `placement=tab` 은 `name` 을 버린다. `at` 을 해석하지 못해도 위치 없이 `restoreTool` 해 성공으로 답한다.
  - 위치: `peer_spawn.go` `peerSpawnShell`
  - 수정: `at` 이 없거나 못 찾으면 404 `peer_target_not_found` 로 거절한다. tab 경로에도 이름을 넘긴다.
- **C5 [LOW]** `dmctl peer spawn` 은 위치 인자가 정확히 2개여야 한다.
  - 위치: `dmctl_peer.go` 의 `peerSubs["spawn"]` positional
  - 결과: `... 테스트 돌려` 처럼 여러 낱말을 주면 오류다.
  - 수정: 최소 2개로 바꾼다. 나머지는 `readBody(pa.pos[1:])` 가 잇는다(`dmctl msg` 와 같게). `runDmctlPeerStdin` 의 개수 검사를 "최소"로 바꿀 자리가 필요하다.
- **C6 [LOW, PLAUSIBLE]** 탭 열기와 방송이 겹치면 노드 설정 칸이 비어 남는다. 저장하면 400 이다.
  - 위치: `app-settings-peers.js` `_loadPeersPanel`, `app-peers.js` `_peersRestore`
  - 수정: `_loadPeersPanel` 이 받은 `r.data` 로 `this._peers` 를 직접 채운 뒤 `_pnNodePaint` 를 부른다.
  - 덧붙임: 승인 대기가 시간으로 만료되면 방송이 없다. 그래서 알림이 다음 읽기까지 남는다(I-25). 고칠지 판단한다.
- **C7 [LOW]** UI 서버 `Run` 이 종료 신호 없이 실패하면(포트 사용 중) 노드 포트를 닫지 않는다.
  - 위치: `cmd/dongminal/app.go`
  - 수정: Run 이 실패하면 `peerLn.Close()` 한다. 예: `StartPeer` 가 돌려준 done 대신 close 함수를 노출한다.
- **C8 [문서]** 고칠 곳은 아래와 같다.
  - `docs/external/api.md` ~236: add 응답의 `state` 는 이미 짝이면 `""` 다(I-53).
  - api.md ~233: 방송 조건(C2 와 함께 맞춘다).
  - api.md ~229: JSON 이 아닌 403 은 `peer_rejected` 다(`peer_unreachable` 아님).
  - `docs/external/errors.md` 의 `peer_config_invalid`: I-51(허용 폴더 절대 경로·알릴 주소)과 I-52(등록 요청 주소)를 더한다. 원천은 `internal/webserver/apierr/codes_doc.go` 이고, 고친 뒤 `go run ./scripts/gen-errors` 를 돌린다.
  - `docs/external/peers.md`: 문제 해결 표에 `peer_target_not_found` 를 더한다.
  - peers.md §2 의 "둘 다 노드 포트가 켜져 있어야" 는 FR-PNW-33 과 어긋난다(A 는 꺼져 있어도 등록은 된다).
  - SRS §5 검증 표의 "토큰 5회 오류"는 I-39 와 충돌한다. 고친다.
- **C9 [테스트]** 보강할 테스트는 아래와 같다.
  - `listener_test.go` `TestListenerRevokedPeerOnResumedSession`: `PeersOnly` 의 요청 단계 판정 때문에 `VerifyConnection` 을 되돌려도 통과한다. `DidResume` 을 확인하고, 요청 단계를 통과시키는 Admission 으로 TLS 단계만 시험한다.
  - `internal/daemon/ipc/paned_handlers.go` paste 의 `Foreground` 분기와 `ErrForegroundChanged → CodeForegroundChanged` 매핑을 데몬 쪽 테스트로 시험한다.
  - `adapters_test.go` 의 "기능 없는 허브는 조건 없이 넣는다"가 실제로 `SendPaste` 를 불렀는지 확인한다(fakeHub 가 기록하게).
  - `peer_spawn.go`: Record 실패 뒤 `peerCloseTool` 의 결과를 버린다. 닫지 못하면 기록 없는 도구가 남으므로, 결과를 반영하거나 로그를 남긴다.

### 보안 리뷰 잔여

- **S6 [LOW]** 원격 paste 하나가 데몬 연결 전체의 입력을 멈춘다.
  - 위치: `internal/daemon/ipc/paned.go` 의 dispatch 안에서 paste 를 처리한다.
  - 원인: 120ms 를 자고 전경 조회를 두 번 한다. `paned_handlers.go` 주석에 list 의 조회를 dispatch 밖으로 뺀 선례(`goSlow` 류)가 있다.
  - 수정: `Foreground` 가 있는 paste 는 도구별로 직렬화하되 dispatch 밖에서 돌린다.
- **S9 [LOW]** `/peer/v1/pair` 에는 요청 상한이 없다(`peerCmd` 의 limiter 를 지나지 않는다). 실패마다 감사 로그가 쌓인다.
  - 위치: `peer_node.go` `peerPair`
  - 수정: `s.peerLimiter.Allow(fp)` 를 적용한다(fp = `ClientFingerprint(r)`). 초과하면 429 `peer_rate_limited` 다.
- **S11a [LOW]** 허용 폴더 자체가 심볼릭 링크면 판정 때마다 다시 푼다. 그 부모에 쓸 수 있으면 대상을 바꿔 범위를 넓힐 수 있다.
  - 권장: peers.md §4 에 "허용 폴더를 심볼릭 링크로 두지 마세요"를 적는다(저장 때 실제 경로로 고정하면 화면 값이 바뀌어 혼란).
  - 사용자에게 물을지 판단한다.
- **S11b [LOW]** 동작이 두 모드에서 다르다.
  - 직접 모드 `SendPasteIfForeground(want="")` 는 거절한다.
  - 데몬 `paste` 는 `Foreground==""` 이면 가드 없이 넣는다.
  - 지금은 쓰이지 않는 갈래다. 맞추거나 주석으로 못 박는다.
- **S11c [LOW]** Windows 에서 `Tools.Cwd` 가 비면 L-12(I-44) 재확인을 건너뛴다. peers.md 에 잔여 위험으로 적는다.

### 사용자가 받아들인 잔여 위험 (다시 고치지 않는다, 리뷰어에게도 알려 준다)

- **I-48 (사용자 결정)**: `message.send` 는 에이전트의 활동 상태(working·waiting·unknown)와 **관계없이** 넣는다.
  - 이유: 활동 보고를 믿을 수 없다. claude 의 유휴 알림도 waiting 으로 잡히고, codex·omp 는 승인 대기를 알리지 않는다.
  - 결과: 승인 창이나 시작 확인 창에 Enter 가 들어갈 수 있다. peers.md §4 에 적었다.
- **codex 첫 프롬프트**: 출력 3초 정적 판정(사용자 결정).
- **옛 데몬**: `fgguard` 가 없으면 캐시 판정을 쓴다(I-47).
- **창 배치 시간 초과(I-33)**: 늦게 뜬 빈 셸 창이 남는다.
- **실패한 승인**: 방송하지 않는다(I-24·I-55).
- **bracketed paste 가 꺼진 에이전트**: 원격 글을 거절하지 않는다(omp 가 켜는지 근거가 없어, 사용자 결정 "어떤 상황이든 넣는다"와 맞춤). 셸 유출은 I-47(전경 재조회)과 I-59(닫는 중 차단)로만 막는다.

## 4. 먼저 읽을 것

- `docs/internal/PEER_NETWORK_SRS.md` 의 §3.3(FR-PNW-50~64)과 §9.5(I-30~I-61). 이번 일의 결정이 모두 여기 있다.
- `docs/external/peers.md` §4 위험 표
- 코드:
  - `internal/webserver/httpapi/peer_{spawn,commands,api,node,envelope}.go`
  - `internal/webserver/domain/peer/`
  - `internal/helper/runtimebin/dmctl_peer.go`
  - `internal/shared/toolhub/bracketpaste.go`(SendPasteIfForeground)
  - `internal/daemon/ipc/paned_handlers.go`(paste)
  - `internal/webserver/toolclient/client_toolhub.go`
  - `web/js/core/app-settings-peers.js`

## 5. 배운 것

- **오류 코드 추가**: `apierr/codes_peer.go` 와 `codes_doc.go`(표 리터럴)를 함께 고친다. 그다음 `go run ./scripts/gen-errors` 를 돌린다. 내부 오류 코드 이름은 `internal_error` 다(`internal` 이 아니다).
- **원격 상태 코드 변환**: 원격 5xx 는 호출 쪽 `remoteStatus` 가 502 로 바꾼다. 테스트에서 원격 500/503 을 기대하면 틀린다. `errCode` 로 본다.
- **테스트 가짜**:
  - `peerFakeTools` 는 `setFresh` 로 "붙여넣기 직전 새 조회"를 흉내 낸다.
  - `headlessHub` 에는 `cwds`, `busy`, `deleteErr`, `listUnknown` 자리가 있다.
  - `fakeToolIO.SendPaste` 는 이제 잠근다(race).
- **A 의 로컬 API 상한**: 본문 상한이 같아서 B 의 읽기 실패를 API 로 만들 수 없다. 핸들러를 직접 부른다(`b.srv.peerMessageSend(rec, req, peerCaller{...})`).
- **zsh heredoc**: `‮` 같은 이스케이프를 실제 바이트로 바꾼다. Go 테스트 문자열은 python 으로 쓴다.
- **macOS sed**: `\b` 를 모른다. `perl -pi -e` 를 쓴다.
- **Claude 활동 매핑 고정**: `agentadapter/claude.go` 의 매핑은 일부러 고정돼 있다("매핑을 개선하지 않는다"). Notification 은 종류와 관계없이 waiting 이다.
- **Markdown 표의 파이프**: 표 안의 `|` 는 백틱 안이어도 `\|` 로 쓴다.
- **보안 검토 훅**: 백그라운드 보안 검토 훅이 커밋마다 돈다. 지적이 오면 유효성을 확인한다.

## 6. 변하지 않는 규약

- 사용자의 dongminal 을 재시작하지 않는다. push 하지 않는다. 커밋에 AI 서명을 넣지 않는다.
- 문서와 코드가 충돌하면 코드를 우선한다. 충돌은 끝에 보고하고, 사용자 선택에 따라 문서를 고친다.
- 문서는 ASD-STE100 을 80% 정도로 적용하고, 한국어는 자연스럽게 쓴다.
