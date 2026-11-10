# 인계: PEER_NETWORK 리뷰 결함 수정

## 1. 착수 블록 (이번 세션의 지시 전부)

- **사용자 지시**: "모든 문제를 리뷰하고 해결해서 완벽하게 완성되면 그때 알려 줘." 실제 PC 시험은 사용자가 따로 한다.
- **할 일**: §3 의 결함을 모두 고친다. 고친 뒤 독립 리뷰를 한 번 더 돌려(리뷰어에게 결론 말고 코드만 준다) 새 결함이 없을 때까지 반복한다. 끝나면 사용자에게 보고한다.
- **방식**: SDD + TDD. 결함마다 실패하는 테스트를 먼저 쓰고(RED) 고친다(GREEN). 결정은 `docs/internal/PEER_NETWORK_SRS.md` §9 에 `I-30` 부터 적고 `go run ./scripts/gen-decisions` 로 색인을 다시 만든다.
- **질문**: 설계 결정이 필요한 것만 묻는다(§3 의 H-1 은 물어야 한다). 한 번에 하나, 권장안과 함께.
- **커밋**: 사용자가 "커밋 및 진행 알아서" 를 허락했다. 묶음마다 검증을 통과하면 스스로 커밋한다. AI 서명 금지. push 금지. 사용자의 dongminal 은 재시작하지 않는다.
- **완료 조건(묶음마다)**: `make gates` · `make lint` · `go test ./...` · `npm run -s unit` · `npm run -s typecheck`. 화면을 바꾸면 `npx playwright test e2e/peers-settings.spec.ts`.

## 2. 어디까지 왔나

- SRS 단계 1~6 구현 완료, 상태 `승인·구현완료`. 마지막 커밋 `be356a08`.
- 커밋 순서: `461b70ee`(1) · `be7ef5ce`·`c5b3f486`(보안·backup) · `38f0039b`(2) · `d5258977`(3) · `e8986277`(제어 문자) · `12e2ec81`(4) · `eddc8c4e`(5) · `be356a08`(6).
- 원래 있던 실패(이번 일과 무관, 고치지 않는다): `e2e/event-timer-hub-contract` T-1·T-1b(변경 전에도 실패 확인), `web/js/test/cm-sticky.test.mjs` 가끔 흔들림, `git-sidebar.spec.ts` S7.

## 3. 고칠 결함 (독립 리뷰 3건의 결과, 아직 내가 하나씩 재확인하지 않았다 — 고치기 전에 코드로 확인한다)

### HIGH

- **H-1 agent.spawn 프롬프트로 셸 명령 주입** — `httpapi/peer_spawn.go:85-95`, `agentadapter/adapter.go:316-357`, `platform/shell.go:120-215`. 원격 프롬프트가 `sh.Quote` 로 인용돼 **셸에 붙여넣어진다**. 인용 방식은 실제 `$SHELL` 을 보지 않는다. fish(`\'` 를 홑따옴표 안에서 이스케이프로 읽음), PowerShell(U+2018~201B 를 홑따옴표로 읽음), cmd.exe(홑따옴표가 인용이 아님)에서 원격 짝이 임의 명령을 실행할 수 있다. 셸이 준비되기 전 붙여넣기(canonical 모드 1024바이트 잘림)도 인용을 깰 수 있다(PLAUSIBLE).
  - **사용자에게 물을 결정.** 권장안: **프롬프트를 셸 문자열에 넣지 않는다.** 기동줄은 프롬프트 없이 넣고, 에이전트가 준비된 뒤(어댑터의 `Readiness` 신호) 원격 엔벨로프를 `message.send` 와 같은 방식으로 에이전트 입력에 붙여넣는다. 대안: 셸이 sh/bash/zsh·pwsh 일 때만 허용하고 `\`·`'`·U+2018~201B 를 거부.
  - 기동줄 자체(등록부 고정 문자열 + `hooksDir`)와 `cwd`(newWindow 인자·Create 인자)는 셸 문자열로 들어가지 않는지도 함께 확인한다.

### MEDIUM

- **M-1 원격 오류 본문이 거르지 않고 터미널에 찍힘** — `domain/peer/client.go:92`(`Message: string(raw)`, 1 MiB), `httpapi/peer_api.go:173-174`(Code 없는 RemoteError → default 분기 `err.Error()`), `peer_api.go:288`(approve `reason = err.Error()`), `helper/runtimebin/dmctl_peer.go:308,351,354`(clean 없이 출력). OSC 52 로 클립보드 덮어쓰기 가능. 수정: client 에서 `Message` 를 정제·절단(또는 버림), 서버 default 분기·reason 에 `cleanRemoteText`, dmctl 출력에 `clean()`. dmctl 의 `Expires`(266)·`v.Name`(284·306)도 clean.
- **M-2 짝 하나가 spawn 을 무제한으로 쌓음** — `peer_spawn.go`. 분당 60회뿐이라 한 시간에 3600개 도구. 수정: 짝마다 살아 있는 spawn 수 상한(예: 4, 상수), 넘으면 429 새 코드. 살아 있는지는 `toolLive`.
- **M-3 spawn 실패 경로에서 도구가 남음** — `peer_spawn.go:79-97`. 도구를 만든 뒤 `LaunchLine`·`Record`·`deliverToTool` 이 실패하면 도구를 지우지 않고, deliver 실패면 기록까지 남는다. 수정: 실패 시 `Tools.Delete`(창이면 closeTab) + `Forget`.
- **M-4 agent.close 가 실제로 닫히지 않았는데 기록을 지움** — `peer_spawn.go:195-201`. closeTab 방송을 받은 클라이언트가 있으면 닫힌 것으로 본다. 수정: 방송 뒤 `toolLive` 가 거짓이 될 때까지 짧게 기다리고, 아니면 `Tools.Delete`. `Forget` 은 실제로 닫힌 뒤에만.
- **M-5 초대가 없을 때 `peer_no_invite` 가 아니라 `peer_rejected`** — `peer_node.go:60-61`(TLS 판정이 초대 없으면 거절), `client.go:133-135`. `errors.md` 안내와 다르다. 수정: `apiPeersAdd` 에서 `ErrRejected` → `peer_no_invite`(또는 문서를 고친다). 테스트 없음.
- **M-6 NFR-PNW-1 위반: 꺼져 있어도 부팅 때 인증서·키 파일이 생기고 스냅샷 `peers` 가 200** — `peer_node.go:43`, `handlers_snapshot.go:22`. FR-PNW-1("처음 시작할 때")과 충돌. 권장: 신원을 처음 켤 때(`SetNode` 로 enabled=true) 만든다. 이 변경은 `TestNewCreatesNodeIdentity` 와 단계 1 결정을 바꾸므로 SRS 를 고친다. 사용자에게 물어도 된다.
- **M-7 Peers 탭: 주소 수정 줄이 열려 있으면 짝 목록 전체가 다시 그려지지 않음** — `web/js/core/app-settings-peers.js:69,163-170`. 취소 버튼 없음, 탭을 다시 열어도 같은 가드. 수정: 그 줄만 보존하거나 취소 버튼, 탭 열기는 가드 없이 그린다.
- **M-8 `dmctl peer spawn ... -` 가 stdin 을 읽지 않고 "-" 를 보냄** — `dmctl_peer.go:170-201`. `msg` 는 지원. 수정: `readBody` 사용.

### LOW

- **L-1** `apiPeersAdd` 의 `AddPeer` 실패를 모두 500 `save_failed` 로 — `peer_api.go:226-228`. `peerStoreFail` 처럼 가른다.
- **L-2** 이미 맺은 짝을 다시 등록하면 그 짝이 pending-out 으로 내려감 — `config.go:347-359`. 이미 짝인 지문이면 상태 유지.
- **L-3** 나가는 방향 감사 로그에 대상 uuid·길이가 없고 결과 코드가 200/502 고정 — `peer_commands.go:236,245` (FR-PNW-94).
- **L-4** 종료 순서: `StartPeer` 의 done 채널을 아무도 기다리지 않고, `Close` 뒤 `PUT /api/peers/node` 의 `Apply` 가 리스너를 다시 연다 — `cmd/dongminal/app.go:200`, `peer_node.go`, `domain/peer/listener.go`. Listener 에 closed 상태를 두고 app 은 done 을 기다린다.
- **L-5** `peer-spawns.json` 이 정리되지 않음 — `spawnlog.go`. 부팅 때·close 경로 밖에서 죽은 도구 id 를 지운다.
- **L-6** confirm 저장 실패도 403 `peer_rejected` — `peer_node.go:175`.
- **L-7** `TakePending`/`PutBack` 사이에 같은 지문의 대기가 들어오면 둘이 됨 — `pairing.go:176-180`.
- **L-8** Windows 에서 `0o600` 은 ACL 에 반영되지 않음 — `peers.md` 에 적는다.
- **L-9** 초대 DoS: 공격자가 틀린 토큰 5번으로 초대를 폐기 — `pairing.go:115-119`, `/pair` 에 상한 없음. 실패를 지문(또는 IP)별로 세거나 화면에 알린다.
- **L-10** 초대 코드 탈취자가 이름을 사칭 — 승인 화면·`dmctl peer approve` 에 지문 앞부분 대조를 눈에 띄게(가능하면 필수로) 둔다.
- **L-11** window 배치가 시간 초과면 브라우저 창 + 헤드리스 셸 둘이 생길 수 있음 — `peer_spawn.go:118-123` (PLAUSIBLE).
- **L-12** DirAllowed 와 도구 생성 사이 TOCTOU — 셸이 뜬 뒤 실제 cwd 를 다시 확인 (PLAUSIBLE).
- **L-13** Peers 탭: 409 로 열린 이름 칸을 방송이 덮음(`app-settings-peers.js:67,85-87`), 늦은 GET 이 새 초대 코드를 지울 수 있음(78-79, PLAUSIBLE), 모르는 `state` 가 "Paired" 로 보임(151), 주소 칸 `title` 이 영어 하드코딩(index.html, Access 패널과 같은 관행).
- **L-14** dmctl `parsePeerArgs`: `--name=x` 형식·`--` 종료자 미지원, `--name --json` 이 값으로 먹힘 — `dmctl_peer.go:182-192`.
- **L-15** 문서: `peer info` 도움말(`dmctl_peer.go:27`)과 `commands.md` 에 `allowedDirs` 가 없다.
- **L-16** e2e 약점: `e2e/peers-settings.spec.ts:91-92` 의 `not.toBeEmpty()` 는 "없음" 표시로도 통과, 넷째 테스트가 셋째의 상태에 기댐.

### 테스트 공백 (함께 메운다)

초대 만료·소비 뒤 add 실패(M-5), spawn 이 도구를 만든 뒤 실패(M-3), close 의 방송 실패(M-4), window 배치 시간 초과, confirm 유실 뒤 회복을 짝맞춤 전체 흐름과 이어서, 종료 중 Apply 경쟁, `--tab` 배치, close 에서 Busy 일 때 종료 명령.

## 4. 이미 반증된 우려 (다시 보지 않아도 된다)

경로 정규화 우회(`/peer/v1/pair/../x` 등 — 요청 단계가 정확 일치만 예외), TLS 세션 재개(`VerifyConnection`), 해제 뒤 keep-alive(요청마다 재판정), 엔벨로프 위조(제어 문자 제거 → 표지 인용 순서, `from` 정규식), pending·rate limiter 맵 크기, 토큰·키 누출, 화면 XSS(`textContent`), Store 슬라이스 공유, LastSeen·limiter 가 지문 키라 이름 변경에 안전, `DirAllowed` 의 Windows 대소문자.

## 5. 먼저 읽을 것

- `docs/internal/PEER_NETWORK_SRS.md` 전체, 특히 §9 I-1~I-29
- `docs/internal/archive/PEER_NETWORK_HANDOFF.md` §5(게이트·함정 목록)
- 코드: `internal/webserver/domain/peer/`, `internal/webserver/httpapi/peer_*.go`, `internal/helper/runtimebin/dmctl_peer.go`, `web/js/core/app-peers.js`·`app-settings-peers.js`

## 6. 배운 것

- 게이트가 많다. 오류 코드를 더하면 `apierr/codes_peer.go` 와 `codes_doc.go`(표 리터럴 안에 넣는다, `init()` 금지) 를 함께 고치고 `go run ./scripts/gen-errors`.
- macOS `sed` 는 `\b` 를 모른다 — `perl -pi -e` 를 쓴다. Serena `rename_symbol` 은 세션 설정이 필요해 이 세션에서는 쓰지 못했다.
- Go 테스트에서 `"\x9b"` 는 올바른 UTF-8 이 아니라 JSON 에서 U+FFFD 가 된다. C1 은 `"\u009b"` 로 쓴다.
- `peerCommands()` 는 함수다(변수면 `node.info` 와 초기화 순환).
- 백그라운드 보안 검토 훅이 커밋마다 돈다. 지적이 오면 유효성을 확인하고 고친다.
