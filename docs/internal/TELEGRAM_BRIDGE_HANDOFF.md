# 인계: Telegram 브리지 — 서버 배선·API·설정 화면·실측

## 착수 블록 (이번 세션의 지시 전부)

1. `docs/internal/TELEGRAM_BRIDGE_SRS.md` 를 처음부터 끝까지 읽는다. 특히 §2(실측), §3.1·3.2·3.9·3.10, §4(결정), §7 R-1, §8.
2. 브랜치 `feat/telegram-bridge` 에서 일한다. `git log --oneline -4` 로 아래 세 커밋을 확인한다. **main 에 병합하지 않고 push 하지 않는다.**
3. 남은 일을 아래 순서로 한다. 단계마다 테스트(RED) → 구현(GREEN) → `make gates`·관련 `go test`·(화면이면) `npm run -s unit`·`typecheck`·`make lint` → 이 브랜치에 커밋(AI 서명 없음).
4. 끝나면 SRS 의 상태 줄과 "남은 것" 을 고치고, 아래 "사용자에게 보고할 것" 과 함께 보고한다.

## 어디까지 왔나

| 커밋 | 내용 |
|---|---|
| `78983eef` | hook 보고 확장: `parseClaudeHook` 이 hook·tool_use_id·source·입력 원문(16KB, 넘으면 `InputOver`)을 싣고, `dmctl activity` 가 보고 본문에 싣는다. `agentrec.ActivityReport` 에 필드 추가 |
| `b97e0f5d` | 도메인 `internal/webserver/domain/telegram`: `Store`(telegram.json 권한 600, `View` 는 token 없음), `Client`(오류에 token 안 실음), `Pairing`, `Bridge`(대화=session_id 별 DM 토픽, 입력·버튼·알림·알람 해제·이름 이모지) |
| `0ac77d1f` | transcript 출력(허용 목록·이어 읽기·`LastReply`·Markdown→HTML·나누기), 활동 보고에 `transcript` 경로, 보안 리뷰 반영(FR-TGB-10a 짝맞춤 5회 실패 폐기, FR-TGB-40a 잘린 권한 요청에 허용 버튼 없음), architecture.md 패키지 표 |
| `1b37e953` | ⑤-1 `ToolReader.Write` — 원시 키 쓰기(직접 `ToolManager.Write`, 데몬 `ToolHub.Write`) |
| `61d888dd` | ⑤-2 브라우저 WS 입력 시각(`Server.LastBrowserInput`) |
| `a0ec7992` | ⑤-3 `telegramHost`·`telegramWire`(telegram_wire.go), `applyActivityReport` → 브리지, 알람은 `CommandHub.SetAttentionObserver`, `StartTelegram`(app.go), `telegram.json` 홈 표 등재 |
| `c2fc974e` | ⑤-4 `/api/telegram`(GET·PUT token/enabled/silence·POST/DELETE pair), 오류 코드 `telegram_*` 6종, api.md·errors.md |
| `decd188a` | 보안 리뷰: token 을 저장하면 살아 있는 등록 코드를 버린다 |
| `dd646a44` | ⑤-5 설정창 Telegram 패널(app-settings-telegram.js), 단위·e2e 시험, features.md |

⑤ 는 끝났다. 남은 것은 ⑥ 실측뿐이다.

## 남은 일 (순서)

### ⑤-1 원시 키 쓰기
- `internal/webserver/seam/toolaccess/deps.go` 의 `ToolReader` 에 `Write(toolID string, data []byte) error` 를 더한다.
- 구현 `internal/webserver/seam/adapters/tool.go`: 직접 모드는 `a.PM.Write(id, data)`(`toolhub.ToolManager.Write`, manager_hub.go:27), 데몬 모드는 `a.Hub` 를 `interface{ Write(string, []byte) error }` 로 단언해 `ToolClient.Write`(toolclient/client_toolhub.go:246). `SendPasteIfForeground` 의 단언 방식과 같다.
- `ToolReader` 를 구현하는 가짜(시험용)들도 고친다 — `go build ./... && go vet ./...` 가 찾아 준다.

### ⑤-2 브라우저 입력 시각 (FR-TGB-53)
- `internal/webserver/httpapi/handlers_ws.go` 의 `wsReadLoop` 를 부르는 두 곳(직접 `readWS`·데몬 `handleWSDaemon`)에서 input 클로저 안에 시각을 기록한다. 서버에 도구별 `map[string]time.Time`(뮤텍스) 하나.
- 브라우저의 터미널 질의 답(DA·CPR·포커스 보고)도 OpInput 으로 온다. 그래도 사람이 그 창 앞에 있다는 뜻이라 그대로 센다.

### ⑤-3 Host 구현과 배선
`telegram.Host` (bridge.go) 를 httpapi 쪽에 구현한다.
- `Paste` = `s.deliverToTool(id, text, true)` (handlers_toolio.go)
- `Keys` = ⑤-1 의 `s.ToolIO.Write`
- `Attend` = `s.attention().Attend(id, typed)` (attention_service.go)
- `LastBrowserInput` = ⑤-2
- `ToolName` = 워크스페이스의 탭 이름(없으면 전경 이름). `toolaccess.WorkspaceEntry.TabName` 을 쓰는 기존 경로를 찾아 쓴다
- `Screen` = `apiToolOutput` 의 strip 경로(`s.ToolIO.Snapshot` + `stripANSI`), 끝 16KB
- `Agents` = 활동 보고가 있는 도구 중 에이전트가 붙은 것(`s.activityEntries()` 와 같은 원천). SessionID 는 활동 보고의 `sessionId` 를 도구별로 기억해 채운다(지금 서버는 저장하지 않는다 — 브리지 이벤트를 넘길 때 함께 기억)
- `applyActivityReport`(handlers_attention.go:144) 에서 `agentrec.ActivityReport` → `telegram.Event` 로 옮겨 `bridge.OnActivity`. 서브에이전트 보고(`AgentID != ""`)는 넘기지 않되, 서브에이전트의 PermissionRequest 는 main 보고로도 오므로 그대로 된다
- 알람: `internal/webserver/hub/attention.go` 의 `attnBroadcastsOf` 콜백 묶음이 직접·데몬 모드 공용이다. 여기에 브리지 통보를 더하는 자리를 만든다(합성 루트 `cmd/dongminal/attention.go`·`app.go` 확인). reason 은 `done`/`waiting`/기타
- `Bridge.Run(ctx)` 을 서버 수명에 맞춰 기동. 파일은 `~/.dongminal/telegram.json`(peers.json 을 여는 자리를 찾아 같은 방식으로 경로를 만든다)
- 꺼져 있으면(NFR-TGB-1) Telegram 요청 0건 — `Bridge.enqueue` 와 `pollLoop` 이 이미 지킨다. 배선 시험으로 확인한다

### ⑤-4 HTTP API
`/api/telegram` (handlers_api.go 의 `httproute` 표, `/api/peers` 옆)
- `GET` → `Store.View()` + 진행 중 짝맞춤 코드가 있으면 남은 시간
- `PUT /token` {token} → `Client.GetMe` 로 확인. 실패면 거절, `has_topics_enabled` 거짓이면 거절하고 SRS §2.1 의 BotFather 경로를 안내(FR-TGB-4). 성공이면 `Store.SetToken(token, username)`. **응답·로그에 token 없음**
- `PUT /enabled` {enabled}, `PUT /silence` {minutes}
- `POST /pair` → `Bridge.Pairing().Issue()` 의 코드와 만료. `DELETE /pair` → `SetUser(0)`
- 오류 응답은 저장소 규약(`httpErr` + `apierr` 코드, 한국어 본문)을 따른다 — `make gates` 의 http-error·error-docs·api-docs 검사가 잡는다. `docs/external` 의 API 문서 갱신이 필요할 수 있다(check-api-docs)
- 본문 읽기는 `readBodyHTTP`/`decodeJSONBody`(body-limit 게이트)

### ⑤-5 설정 화면
- Peers 탭이 전용 API 를 쓰는 설정 화면의 선례다(`web/js` 에서 `/api/peers` 를 부르는 곳을 찾는다). 같은 방식으로 Telegram 항목: 켜기·끄기, token 입력(비밀번호 칸, 저장 후 "설정됨 · @봇이름"), 등록 코드 발급·남은 시간·해제, 무음 시간(분, 기본 5)
- 문구는 i18n(ko/en) — `check-i18n*` 게이트. UI 규칙 게이트(버튼 키트·글꼴·색 등)가 많다. `make gates` 를 자주 돌린다
- e2e 는 가짜 Telegram 이 필요하므로 최소로: 설정 화면이 서고 token 칸이 값을 되돌려 보이지 않는지 정도

### ⑥ 실측 (남음 — 사용자의 재빌드·재시작이 필요하다)

원시 키 쓰기는 이 브랜치의 빌드에만 있다. 사용자의 dongminal 은 재시작하지 않는다는 규약이 있으므로, 사용자가 직접 재빌드·재시작할 때 아래 순서로 함께 잰다. 이번 변경은 서버·dmctl 쪽뿐이고, 데몬은 보고 본문을 원문 그대로 넘기므로(`ipc/report.go` `acceptReport`) **데몬 재시작은 필요 없다.**

1. 이 브랜치로 빌드하고 서버만 다시 띄운다.
2. 설정 ▸ Telegram: 테스트 봇 token 을 넣고 저장 → "설정됨 · @dongminal_office_bot". 켜기. **등록 코드 만들기** → 휴대폰에서 봇에 `/pair <코드>` → "등록됨".
3. **TC-TGB-31**: 테스트 탭을 브라우저로 한 번 연 뒤 `claude --permission-mode default` 를 띄운다. 의미 없는 요청으로 Bash 권한 요청을 만든다. Telegram 의 `[1 허용]` 을 눌러 PC 대화상자가 그 선택으로 닫히는지 본다. `[3 거절]`·상태 메시지의 `[Esc]` 도 같은 방법으로 본다. AskUserQuestion(선택지 2개 이상)을 만들고 `2` 번 버튼으로 본다. 틀리면 `render.go` 의 `choiceKeys` 한 곳만 고친다
4. **TC-TGB-90**: 같은 탭에서 알림 → 버튼 답 → PC 대화상자 닫힘, 토픽에 글 입력, `[화면]`, 실시간 출력(블록 단위), `/clear` 뒤 새 토픽, `/close`·`/cleanup`, `[✓ 읽음]` 뒤 PC 알람 꺼짐, PC 입력 5분 안의 알림이 무음인지 본다
5. 끝나면 SRS 의 상태를 `승인·구현완료` 로 바꾸고 "남은 것" 줄을 지운다

## 이 세션이 값을 치르고 배운 것

- **`dmctl send-input` 은 붙여넣기(`ESC[200~…ESC[201~`)로 감싼다.** 선택지 화면에 `2` 를 넣으면 선택이 아니라 자유 입력칸에 글자로 들어간다. Enter 도 줄바꿈이 된다. 키는 반드시 원시 쓰기로
- **숨은 탭(브라우저가 한 번도 연 적 없는 탭)에서 claude 를 새로 띄우면 시작 화면에서 멈춘다.** 터미널 질의(`ESC[c` 등)에 답할 xterm 이 없다(지연 연결). 실측용 claude 를 띄우려면 사용자에게 그 탭을 한 번 열어 달라고 해야 한다. 기본 권한 모드가 auto 라 권한 요청을 보려면 `--permission-mode default`
- **`PermissionRequest` 훅에는 `tool_use_id` 가 없다.** 바로 앞 `PreToolUse` 의 것을 쓴다(FR-TGB-81a, `conv.lastToolUse`)
- **AskUserQuestion 은 `PreToolUse` 와 `PermissionRequest` 둘 다 온다.** 브리지는 PreToolUse 에서 보내고 PermissionRequest 는 겹치면 건너뛴다
- **transcript 에는 시스템 프롬프트·이메일이 든 `api-request-blob` 줄이 있다.** 허용 목록(assistant 의 text·tool_use, sidechain 아님)만 통과
- **transcript 는 블록이 끝나야 한 줄을 쓴다.** 글자 단위 스트리밍은 불가(D-TGB-14)
- **DM 토픽은 `closeForumTopic` 이 안 된다**(supergroup 전용). 닫기 = 삭제
- **`sendMessageDraft` 의 `can_stop` 정지 버튼은 보이지 않았다.** Esc 는 상태 메시지 버튼
- **콜백에 `answerCallbackQuery` 를 안 하면 사용자가 버튼을 여러 번 누른다**
- **`!` 로 실행한 명령은 입력이 대화 기록에 남는다.** token 을 그렇게 받으면 안 된다(실제로 한 번 노출돼 폐기·재발급했다)
- 게이트: 테스트에서도 `runtime.GOOS` 를 쓰면 안 된다(빌드 태그 파일로), 새 Go 패키지는 `architecture.md` 패키지 표에 올린다, SRS 상태가 `승인·구현중` 이면 "남은 것" 줄이 필요하다, `decisions.md` 는 `go run ./scripts/gen-decisions` 로 다시 만든다

## 변하지 않는 규약

- 커밋은 이 브랜치에만, AI 서명 없음. push·main 병합 금지. **사용자 dongminal 재시작 금지**(데몬 포함)
- 사내 규정(SRS R-1): 실제 업무 세션에 쓰기 전에 정보보호팀 승인이 필요하다. 시험은 테스트 봇과 의미 없는 대화로만
- 테스트 봇: `@dongminal_office_bot`. token 은 `~/.tgspike/token`(권한 600) — **화면·로그·대화에 출력하지 않는다**(`T=$(cat ~/.tgspike/token)` 로만). chat_id(=허용 계정 후보) `~/.tgspike/chat`
- 심볼 탐색은 LSP → Serena → grep 순(사용자 CLAUDE.md)

## 유효한 사용자 결정 (SRS §4)

D-TGB-1~14 전부. 요약: DM 토픽 · 토픽 단위 session_id · `/agents` 로 열고 입력 필요 알림은 자동으로 · 토픽은 사용자가 지울 때만(`/close`·`/cleanup`) · 답은 원시 키(막는 hook 금지) · 처리 여부는 tool_use_id · 출력은 응답 글+도구 한 줄 · 짝맞춤 코드 · 무음 시간 설정(기본 5분) · `[✓ 읽음]` · Esc 는 상태 메시지 버튼 · 전용 설정 파일 · PC 입력 섞임은 막지 않음 · 출력은 블록 단위.

## 정리 대기 (끝날 때 정리하고 보고)

- `/tmp/tgspike` (실측 임시 파일·로그)
- TG-SPIKE 탭 (uuid `5ebbfb67-66f4-4de5-a904-05e143de51e8`) — `dmctl close-tab --at … --force`
- 테스트 봇 DM 의 실측 토픽(thread 253·260·263) — `deleteForumTopic`
- `~/.tgspike` 는 개발 중 계속 쓴다. 기능이 끝나면 지울지 사용자에게 묻는다

## 사용자에게 보고할 것

1. **D-TGB-14**: 실시간 출력이 글자 단위가 아니라 블록(문단·도구 호출) 단위다. 사용자는 실시간 출력을 원했다. 글자 단위는 다른 원천(MessageDisplay hook 등, 미검증)이 필요하다 — 후속으로 볼지 묻는다
2. 보안 리뷰 반영 두 건: FR-TGB-10a(짝맞춤 5회 실패 시 코드 폐기), FR-TGB-40a(잘린·원문 없는 권한 요청엔 허용 버튼 없이 `[거절] [화면]`)
3. AskUserQuestion 의 복수 선택·여러 질문은 버튼을 지원하지 않는다(글로 답하거나 `[화면]`)
4. 브리지 단위 시험 중 일부는 구현과 함께 쓴 뒤 컴파일 실패로만 RED 를 확인했다(동작별 RED 는 아님)
