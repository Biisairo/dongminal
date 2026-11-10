# 인계: PEER_NETWORK_SRS 구현

## 1. 착수 블록 (이번 세션의 지시 전부)

- **할 일**: `docs/internal/PEER_NETWORK_SRS.md`(커밋 `20a22047`)를 §8 단계 순서대로 구현한다. **단계 1(묶음 N: 노드 인증서 · `peers.json` · 노드 전용 리스너)부터** 시작한다.
- **방식**: SDD + TDD. 스펙이 단일 진실 공급원이다. 단계마다 테스트를 먼저 쓰고 실패(RED)를 확인한 뒤 구현(GREEN)한다. 스펙과 코드가 충돌하면 멈추고 사용자에게 알린다.
- **단계 완료 조건**: `make gates` · `make lint` · `go test ./...` · `npm run -s unit`(`node --test web/js/test/*.test.mjs scripts/test/*.test.mjs`) · `npm run -s typecheck` 통과. 화면을 바꾼 단계는 관련 e2e도 돌린다.
- **커밋**: 단계마다 결과를 보고하고 **사용자 확인을 받은 뒤** 커밋한다. 커밋 메시지에 `Co-Authored-By` 등 AI 서명을 넣지 않는다.
- **질문**: 구현상 결정이 필요할 때만 사용자에게 묻는다. 한 번에 하나씩, 권장안을 함께 낸다.

## 2. 어디까지 왔나

| 커밋 | 내용 |
|---|---|
| `e8ff522f` | 패널 좌우 도킹(PANEL_DOCK_SRS) — 이번 일과 무관, 끝남 |
| `13fc6b14` | 사용자 문서의 옛 패널 이름 수정 — 끝남 |
| `20a22047` | **PEER_NETWORK_SRS 확정** (상태 `승인·구현중`, 남은 것 = §8 단계 1~6 전부). 코드는 아직 한 줄도 없다 |

## 3. 남은 일과 순서 (SRS §8)

1. **N** — 노드 인증서(ECDSA P-256 자기 서명, 키 `0600`), `peers.json`(서버 소유), 노드 전용 리스너(TLS 1.3, 클라이언트 인증서 필수, `/peer/v1/*`만). 꺼짐이 기본이며 꺼져 있으면 아무 영향이 없어야 한다(NFR-PNW-1)
2. **P** — 짝맞춤: invite → add(지문 대조) → pair(토큰) → 승인 대기 → approve → confirm. dmctl 기준으로 먼저 완성
3. **R 일부 + C** — `node.info` · `agents.list` · `message.send`, `dmctl msg --to <노드>/<uuid>`, 원격 엔벨로프, 에이전트 안내문
4. **R 나머지** — `agent.spawn` · `agent.status` · `agent.close`
5. **U** — 설정 `Peers` 탭, 승인 대기 주의 알림
6. **문서** — `docs/external/peers.md`(새로), `commands.md`, API·오류 문서

단계마다 SRS 상태 줄 아래 `> **남은 것**:`을 갱신한다. 전부 끝나면 상태를 `승인·구현완료`로 바꾸고 그 줄을 지운다.

## 4. 먼저 읽을 것

- `docs/internal/PEER_NETWORK_SRS.md` 전체. 특히 §1.3 결정표(D-1~D-10), §3, §7 위험
- 코드 근거 (SRS §1.5와 같음)
  - `internal/webserver/httpapi/server.go:183~200`(미들웨어 조립), `:396`(지금의 유일한 리스너 `ListenAndServe`)
  - `internal/webserver/httpapi/handlers_toolio.go:124-205` — `deliverToTool`, `apiToolMessage`, `agentEnvelope`, `quoteEnvelope`, `resolveSender`
  - `internal/webserver/httpapi/handlers_runs_headless.go` — 탭 없는 도구 생성
  - `internal/shared/agentadapter/adapter.go:143-330` — `Adapter`(ID·DetectCmd·LaunchLine·MemberArgs·ExitCommand), `Get`·`IDs`
  - `internal/webserver/hub/foreground.go` — 도구별 전경 프로그램 이름
  - `internal/webserver/httpapi/access.go` — 서버 소유 JSON 저장소(`access.json`)의 선례. 홈 파일 이름은 `internal/shared/dmenv/homefiles.go`
  - `internal/helper/runtimebin/dmctl_toolio.go` — `dmctl msg`의 클라이언트 쪽, `http.go`의 `baseURL`·`selfToolID`
  - 상태 조회: `/api/tools/activity/get` (`handlers_api.go:96`)

## 5. 이 세션이 값을 치르고 배운 것

- **게이트가 많다.** `make gates`가 잡는 것 중 이번 일에 걸릴 만한 것:
  - 파일 크기 상한 (`check-file-size.mjs`) — 큰 파일에 덧붙이지 말고 새 파일로 나눈다. 게이트를 느슨하게 하지 않는다
  - SRS 상태 enum: `초안 승인대기 승인·구현중 승인·구현완료 폐기 대체`. `승인·구현중`이면 바로 아래 `> **남은 것**:` 줄이 필요하다
  - SRS를 고치면 `go run ./scripts/gen-decisions`로 `docs/internal/decisions.md`를 다시 만든다(생성물, 직접 고치지 않는다)
  - 에이전트 이름 리터럴은 `agentadapter` 등록부 밖에 두지 않는다 (`check-agent-names.sh`)
  - `http.Error` 직접 호출 금지, 요청 본문은 `httpreq` 경로로만 읽는다, 오류 코드는 `apierr` 카탈로그에 등록하고 `docs/external/errors.md`를 생성한다(`check-error-docs`)
  - API 종단을 더하면 API 문서 검사(`check-api-docs.sh`)도 맞춘다
  - JS: 저장소 접근은 `PrefStore` 경유(`check-storage.mjs`), z-index는 토큰(`var(--z-*)`), CSS 변수는 정의된 것만, e2e는 `app.testing` 계약만(`check-e2e-private.sh`), 지역 변수 `t`는 i18n `t()`를 가리므로 쓰지 않는다
- **`--help`를 레이아웃 dmctl 명령에 붙이지 않는다.** `close-tab`·`split-h` 등은 `--help`를 인자로 받지 않고 그대로 실행한다(이전 세션 사고). 도움말은 `dmctl --help`로만 본다
- **e2e 서버는 `web/` 자산을 바로 쓴다.** 프론트를 바꾼 뒤 별도 빌드 없이 e2e가 새 코드를 본다
- **`git-sidebar.spec.ts` S7은 변경 전에도 실패한다**(목록 높이 182 < 200). 이번 일의 회귀로 오인하지 않는다
- **원격 전달의 위험**: 지금 `deliverToTool`은 붙여넣기 + Enter다. 받는 도구가 셸이면 글자가 명령으로 실행된다. 그래서 FR-PNW-57은 전달 **직전** 전경 재조회를 요구한다
- **서버는 호출한 도구를 강제로 판별할 수 없다.** `DONGMINAL_TOOL_ID`는 자기 신고다. SRS §7 HIGH 위험으로 적어 두었다 — 코드로 막으려 하지 말고 문서로 알린다
- **공식 대안 조사 결과**(구현 범위 밖): Claude Code에 A2A 공식 지원은 없다. 떠 있는 세션에 프로그램이 메시지를 넣는 공식 경로는 같은 기계의 세션 입력 소켓(형식 비공개)과 다른 기계의 Remote Control(사람용, 구독 전용)뿐이다. 그래서 마지막 구간은 지금의 터미널 붙여넣기를 그대로 쓴다(SRS 비목표 8)

## 6. 변하지 않는 규약

- 사용자 전역 지침: 심볼 탐색은 LSP → Serena → grep 순, 심볼 수정은 Serena 우선. 최소·국소 변경. 동작이 바뀌면 이전/새/이유를 기록. 새 코드에 TODO 금지
- 커밋은 사용자 확인 후, AI 서명 금지
- CHANGELOG `[Unreleased]`에 사용자에게 보이는 변화를 적는다
- 응답은 한국어

## 7. 아직 유효한 사용자 결정

- SRS §1.3 D-1~D-10 전부
- 회사 PC를 망에 넣는 문제(사내 승인)는 사용자가 따로 처리한다. 설계·구현에서 신경 쓰지 않는다
- 자동 탐색·스캔은 하지 않는다. 짝은 사용자가 하나씩 등록한다
- 원격으로 오가는 것은 프로토콜 명령뿐이다(셸 문자열·화면 읽기 없음)
