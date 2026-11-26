# 채팅 고도화·이슈트리 채팅 진행 문서 — 착수 블록 포함

- 작성: 2026-11-26, 기능 추가 첫 세션(인터뷰·SRS·묶음 A 1단계)이 다음 세션에게 넘긴다.
- 요구·결정의 원본은 `docs/internal/ISSUE_TREE_CHAT_SRS.md` 다. 이 문서는 진행 상태와 이 세션이 배운 것만 담는다. 문서와 코드가 다르면 코드가 기준이다.

## 착수 블록 — 다음 세션의 지시 전부

1. 이 문서를 끝까지 읽는다.
2. 먼저 읽는다: `docs/internal/FEATURE_DEV_RULES.md`(규칙 전부, 특히 §3 설계 규칙·§4 시험·§5 운영 보호), `docs/internal/ISSUE_TREE_CHAT_SRS.md`(§3.1 묶음 A, §4 결정, §10 가정 — 모두 사용자 승인됨).
3. 저장소 상태 확인: 브랜치 `feature`, 직전 코드 커밋 `9cdafa44`. `git status` 가 깨끗해야 한다. main 은 origin/main 보다 2 커밋 앞(push 전), feature 는 main 보다 6 커밋 앞(착수 문서 · SRS · A1 · 진행 문서 · A1 와이어·소켓 · 진행 문서 갱신).
4. §2 의 순서로 묶음 A 의 2단계(MCP)부터 이어 간다. 단계마다 시험 먼저(RED 확인) → 구현(GREEN) → fmt·clippy·관련 게이트.
5. 커밋은 단계마다 사용자에게 확인을 받은 뒤 한다(AI 서명 금지). main 병합·push 는 사용자의 분명한 지시가 있을 때만.
6. 운영 바이너리 재빌드 여부는 아직 사용자에게 묻지 않았다. 묶음 A 가 끝나면 묻는다. 묻기 전에 빌드하지 않는다.

## 1. 끝난 것

| 커밋 | 내용 |
|---|---|
| `1ec9d6eb` | SRS `ISSUE_TREE_CHAT_SRS.md`(상태 승인·구현중) · `decisions.md` 재생성 |
| `b388a73f` | 묶음 A 1단계 — `rust/crates/daemon/chat`: `CALL_USER`, `Service::send_call`(방 밖 상대는 bad_request), `MsgBody.call`(비면 원문에 키 없음), `Message.called`, `is_called`·`room_has_member_locked`(service.rs). 시험 `tests_call.rs` 5개. 기존 `send` 는 빈 call 로 `send_call` 을 부른다 |
| `9cdafa44` | 묶음 A 1단계(와이어·소켓) — chatwire `Message.called`·`SendArgs.call`·`Room.notify`·`OP_NOTIFY`·`NOTIFY_*`·깨움 대기 프레임 `wait`/`wake?`/`wake`/`wake-drop`. chat `set_notify`(기본 called, 나가면 지움). chatsock 도구 id → 참가자 id, notify 연산, 깨움 대기 중계. rise·paste·ChatTools 제거(MCP 의 rise 보내기도 여기서 지웠다. MCP 시험은 개수 질의 `settle()` 로 맞춘다) |

## 2. 남은 일과 순서

구현 순서(사용자 결정 D-ITH-2): 묶음 A → U → T → L → C.

### 묶음 A (알림) 남은 단계

1. ~~**와이어·소켓**~~ — 끝남(`9cdafa44`). (`shared/chatwire`, `daemon/chatsock`, `daemon/boot/src/edge.rs`)
   - chatwire `Message` 에 `called`, `SendArgs` 에 `call`. chat-wait 용 프레임 종류(예: `wait` 첫 프레임 — `unread` 처럼 한 번 묻고 답을 기다리는 연결)와 MCP 쪽 중계 프레임.
   - chatsock dispatch(OP_SEND, lib.rs:737 근처): `call` 의 도구 id 를 같은 노드 연결(Conn.tool)의 참가자 id 로 바꾼 뒤 `svc.send_call`. 도구 id 는 노드 로컬이라 보내는 노드에서 바꾼다.
   - `chat_notify` op: 참가자·방별 알림 단계(all/called/off)를 데몬 메모리에 둔다. 사람 참가자의 단계도 데몬 메모리(아래 결정 I-1). `state`(사람 화면)와 `rooms` 결과에 단계를 싣는다.
   - `rise` 프레임·`Tools::paste`·`resting` 경로와 그 시험(`rise_pastes_only_when_resting`)을 지운다(FR-CAL-13). edge.rs:235-248 의 paste 배선도.
2. **MCP** (`helper/runtimebin/src/otterctl/chatmcp.rs`)
   - `chat_send` 에 `call`(배열 — 지금 `schema()` 는 문자열 속성만 만든다, 배열 속성 지원 필요), 새 도구 `chat_notify`(도구 9개). `chat_read` 글마다 `called`. `chat_rooms` 에 내 단계.
   - 글함에 글마다 알림 표식. 깨울 글 = 내 단계에 걸린 글(`all` 이면 모두, `called` 면 called, `off` 면 없음). 단계는 MCP 가 자기 `chat_notify` 호출로 알고 있다.
   - `CHAT_INSTRUCTIONS`(chatmcp.rs:34-39) 의 "새 글 알림" 문구를 깨움 훅에 맞게 고친다. FR-ITR-9(무관한 글이면 턴을 끝낸다)도 넣는다.
   - rise 보내기 제거는 1단계에서 끝냈다.
   - 깨움 대기 MCP 쪽: `wake?`(n)를 받으면 표식 없는 깨울 글이 생길 때 표식을 붙이고 `wake{n,total,called}` 로 답한다. `wake-drop`(n)을 받으면 그 물음을 버린다.
3. **깨움 훅** — 새 명령 `otterctl chat-wait`(otterctl/mod.rs 명령 표, helptext.rs 도움말). stdin 의 `session_id` 로 chat.sock 에 묻는다. 연결 없음 → 0, 표식 없는 깨울 글 있음 → 표식 붙이고 출력 뒤 2, 없으면 기다림(주기 없음), MCP 연결 끊김 → 0. 출력은 개수만(FR-CAL-10).
   - `shared/agentadapter/src/claude.rs` `write_activity_hooks`(:378-398) 의 `Stop` 목록에 `{"type":"command","command":"<otterctl> chat-wait","asyncRewake":true}` 를 별도 객체로 더한다(공유 hook 값 재사용 금지). 시험: agentadapter tests/adapter.rs:875 근처.
4. **웹 사용자 알람** (FR-CAL-15·16) — `chat-controller.js` `_onChatMessage`(:75-81)에서 사람 참가자의 깨울 글이고 방 탭이 안 보이면 알람. 재사용: `attn-controller.js` `_attnBeep`, `attn-claim.js` `_attnCanBanner`·`_attnCanSound`. `_attnDesktopNotify` 는 도구 위치에 묶여 채팅용 변형이 필요. 중복 방지는 서버 claim(attention.rs:188·438)에 채팅 글 id 를 키로 하는 종류를 더한다(결정 I-3).
5. 묶음 A 끝: TC-ITH-7 실측(진짜 claude 로 깨움 훅 — §4.1 의 방법), 관련 e2e 를 좁혀 돌린다. 사용자에게 운영 바이너리 재빌드 여부를 묻는다.

### 그 뒤

- 묶음 U(채팅 화면): 목업 사진은 `.playwright-mcp/before.png`·`after.png`·`after2.png`(gitignore 됨). 목업 CSS·DOM 은 §4.3 에 원리를 적었다.
- 묶음 T(텔레그램 토픽): 코드는 `rust/crates/webserver/domain/telegram`(bridge.rs·client.rs·render.rs·testsrv.rs). TC-ITH-14 는 사용자 봇으로 실측해야 한다.
- 묶음 L·C: SRS §3.4·§3.5. 명령 문서는 `rust/crates/shared/runtime/assets/agentplugin/commands/issue-tree.md`.

## 3. 이 세션이 정한 구현 결정 (SRS 범위 안, 사용자에게 보고함)

| # | 결정 | 이유 |
|---|---|---|
| I-1 | 사람 참가자의 방별 알림 단계는 데몬 메모리에 둔다. 웹·텔레그램은 `state` 로 읽는다 | 채팅 상태는 원래 메모리만(NFR-PCH-1). 데몬 재시작이면 방 참여도 사라지므로 어긋나지 않는다 |
| I-2 | `call` 의 도구 id 는 보내는 노드의 데몬이 참가자 id 로 바꾼 뒤 전파한다. `called` 는 받는 노드가 참가자마다 판정한다(1단계에서 구현) | 도구 id 는 노드 로컬이다 |
| I-3 | 웹 채팅 알람의 중복 방지는 서버 claim 에 글 id 키 종류를 더한다 | 여러 기기에서 동시에 울리지 않게 한다 |
| I-4 | 알림 단계는 채팅 핵심의 참가자 기록(`Part.notify`)에 둔다. 나가는 모든 경로에서 함께 지워지고 다시 들면 called 다 | 강퇴 등 어느 경로로 나가도 낡은 값이 남지 않는다 |
| I-5 | 깨움 대기는 `wait`(훅↔데몬)·`wake?`/`wake`/`wake-drop`(데몬↔MCP) 네 프레임이다. 시한 없다. 훅이 먼저 끊기면 데몬이 `wake-drop` 을 보낸다 | 받는 이 없는 답에 표식을 붙이지 않는다 |
| I-6 | `call` 의 도구 id 는 그 노드의 MCP 연결 가운데 도구 id 가 같은 것의 참가자 id 로 바꾼다. 그 밖의 항목은 그대로다 | 결정 I-2 의 구현 |

## 4. 이 세션이 값을 치르고 배운 것

### 4.1 진짜 claude 와 shim

- **PATH 의 첫 `claude` 는 otterminal shim(`~/.otterminal/bin/agent-shims/claude`)이고, 이것은 운영 바이너리 `/Users/dykim/personal/dongminal/otterminal` 을 가리킨다.** `claude --version` 만 쳐도 운영 바이너리를 실행한다(이 세션이 한 번 어겼고 사용자에게 보고했다). 실측에는 진짜 claude 를 절대경로로 쓴다: `/Users/dykim/.local/share/claude/versions/2.1.332`(`~/.local/bin/claude` 가 가리키는 것).
- 실측용 claude 는 자기 칸의 새 탭에서 띄운다. **신뢰되지 않은 폴더(예: /private/tmp)에서 띄우면 폴더 신뢰 창이 뜨고, `otterctl send-input` 은 붙여넣기 방식이라 화살표·ESC 키를 보낼 수 없다.** 이미 신뢰된 저장소 폴더(`/Users/dykim/personal/dongminal`)에서 띄운다. 기본 선택이 맞는 창은 `send-input --execute ''`(엔터)로 넘긴다.
- 깨움 훅 실측 재료가 `/private/tmp/` 의 `*-chtest/` 폴더에 남아 있다(`ls -d /private/tmp/*-chtest` 로 찾는다. 폴더 이름의 앞머리가 옛 약칭이라 문서에 그대로 적지 않는다): `waiter.mjs`(신호 파일 `trigger` 가 바뀌면 출력하고 exit 2), `rewake-settings.json`(Stop 훅 asyncRewake), `run-rw.sh`. 채널 실측 재료(`server.mjs`·`mkt/`)도 있다. `~/.claude` 백업은 그 폴더의 `backup/`(이미 원상 복구 확인).
- 입력창 보존 확인법: 입력창에 글을 쳐 두고(엔터 없이) 신호를 준 뒤, 엔터를 쳐 그 글이 따로 제출되는지 본다.

### 4.2 격리 인스턴스로 화면 보기

- 빌드: `BINARY=otterminal-<이름> rust/scripts/hermetic.sh scripts/build.sh`(저장소 루트에서, 약 2분). 실행: `./otterminal-<이름> start --isolated` → 포트·홈·정지 명령을 출력한다. 정지는 출력된 `stop --all --port … --home …` 그대로.
- 가짜 에이전트: `<격리 홈>/bin/otterctl chat-mcp` 를 env `OTTERMINAL_HOME`·`CLAUDE_CODE_SESSION_ID`(아무 uuid)·`OTTERMINAL_TOOL_ID` 로 띄워 MCP JSON-RPC 를 stdin 으로 보낸다. 이 세션의 드라이버: `/private/tmp/` 의 `*-chatui/driver.mjs`(방 만들기 → `go` 파일을 기다렸다가 `msgs.json` 을 올린다).
- **사람 쪽 대화는 브라우저 메모리에만 있다.** 페이지가 다시 그려지면 사라진다. `otterctl open-url` 로 사용자 브라우저에 같은 인스턴스를 열면 작업 공간이 공유되어 Playwright 화면이 바뀌므로, 목업을 다시 그려야 했다.
- Playwright 스크린숏은 `/Users/dykim/personal/dongminal/.playwright-mcp/` 아래만 쓸 수 있다(gitignore 됨). 페이지의 `window.markdownit` 은 지연 묶음이라 새로고침 뒤 없을 수 있다 — `/vendor/markdown-it.js` 를 직접 싣고 `new` 로 만든다.

### 4.3 목업(묶음 U) 원리

보낸 이 묶음(32px 동그라미 + 머리글자, 이름 13px 600 보낸 이 색, `에이전트`/`사람` 표시, 시각), 이어진 글은 머리 없이, 묶음 위 여백 10px, 본문 13.5px·줄 높이 1.6·폭 760px, 내 글 옅은 파란 바탕, 날짜 구분선, 부른 글 왼쪽 노란 띠 + `@나 · 확인 요청`, 코드 블록 어두운 바탕·고정폭·언어 표시·가로 스크롤, 인라인 코드 바탕. 참가자 목록 행 = 동그라미 + 이름 + `종류 · 상태 · 알림: 단계`. 방 머리 세 줄. 값은 디자인 토큰으로 옮긴다(하드코딩 금지).

### 4.4 저장소 규칙에서 걸린 것

- SRS 상태 줄은 enum(`초안 승인대기 승인·구현중 승인·구현완료 폐기 대체`)만 받는다(`check-srs-status.sh`).
- 결정 표를 바꾸면 `cargo run -q --locked --manifest-path rust/Cargo.toml -p otter-scripts-gen-decisions` 로 `decisions.md` 를 다시 만든다.
- Rust 시험은 `rust/` 안에서 `scripts/hermetic.sh cargo test -p <crate> --lib` 로 돈다(저장소 루트에서 `rust/scripts/hermetic.sh cargo …` 는 Cargo.toml 을 못 찾는다).
- clippy 는 시험 코드의 `&[x.clone()]`(→ `std::slice::from_ref`)와 Default 뒤 필드 대입을 잡는다.

### 4.5 사실 확인 결과 (다시 조사하지 않는다)

- 채널(`claude/channel`)은 보류: 개발용 인자는 동작하지만 시작 경고 창이 매번 뜨고 끄는 설정이 없다. `--settings`·`--managed-settings`·`CLAUDE_CODE_MANAGED_SETTINGS_PATH` 로 넣은 `allowedChannelPlugins` 는 모두 거절됐다(SRS §2.2).
- `asyncRewake` 는 Claude Code 2.1.332 설정 스키마의 공개 항목이다("hook runs in background and wakes the model on exit code 2"). 실측 통과.
- 구조 분석(파일:줄 지도)은 SRS 착수 때 분석 에이전트가 만든 것이다. 요점: 채팅 핵심 `daemon/chat/src/service.rs`(send :~606, local_deliveries_locked), 와이어 `shared/chatwire/src/lib.rs`(프레임 종류 :19-27, op :29-38), 소켓 `daemon/chatsock/src/lib.rs`(serve_tracked :569-614 — 첫 프레임 unread 는 :580, 그 밖은 hello 필수; dispatch :699-744; deliver :453; start_user :492; rise :749; answer_unread :769), 웹↔사람 참가자 통로 `httpapi/src/chat_api.rs`(:89 send, :174 chat_pushed), MCP `otterctl/chatmcp.rs`(Inbox :143, 도구 :263-317, read_loop :580-599, CHAT_INSTRUCTIONS :34), ctx-hook `otterctl/hooks.rs`(:362, 안 읽은 수 :409·:423), 훅 생성 `agentadapter/src/claude.rs`(:350-398). 걸리는 시험: chatwire tests.rs, chat tests.rs·tests_human.rs, chatsock tests.rs·tests_human.rs, runtimebin tests/chatmcp.rs·hooks.rs·shim.rs, agentadapter tests/adapter.rs, 웹 peer-chat-*.test.mjs·chat-window.test.mjs·attn-*.test.mjs·state-registry.test.mjs, e2e chat-window·screens-run-chat·rail-chat-usage.

## 5. 변하지 않는 규약

- `FEATURE_DEV_RULES.md` §2~§6 전부. 특히 운영 보호(§5): 운영 바이너리·`~/.otterminal` 실행·접근 금지, 시험 빌드는 이름을 나눈다, `pkill`·`killall` 금지(내가 띄운 PID 만).
- 유휴 규칙: 새 작업은 사건 기반, 시간 값은 `cadence` 또는 crate 상수(NFR-ITH-1). 부팅 JS 1,150,000 B 이하(NFR-ITH-2).
- 커밋은 사용자 확인 뒤, AI 서명 금지. 설명은 한국어로 쉽게.
- 텔레그램으로 채팅 본문이 나가는 것은 사내 규정상 회사 자료면 정보보호팀 승인 대상이다(SRS R-5). 기능은 기본 꺼짐.

## 6. 유효한 사용자 결정

SRS §4 의 D-ITH-1~23 과 §10 의 가정 A-1~8 이 모두 유효하다(2026-11-26 승인). 요점만:
알림은 asyncRewake 깨움 훅(붙여넣기 제거) · 깨울 때 개수만 · 같은 글로 두 번 깨우지 않음 · 부른 글은 `call` 필드 · 사람 글은 지정 없으면 방의 모든 에이전트를 부름 · 알림 단계(사용자는 방마다 고름, 기본 called / 에이전트는 각자, 기본 called) · 웹 알람은 에이전트 알람과 같은 방식 · 채팅 화면은 목업대로 · 색은 참가자 id / 사용자는 배경 대비 최대 색 · 텔레그램은 1:1 대화방 토픽, 모든 방의 거울, 토픽 안 들어가기·나가기, 사용자 글 전달, 사용자는 토픽 삭제 불가 · 로컬 이슈트리는 보관×실행 네 조합, `otterctl issue`, 조정자가 일꾼 수 판단, 일꾼 커밋·조정자 병합, 규칙은 otterminal 이 주입 · 트리 방은 자동 입장, 상대 지정 통신, 화면에도 옮김, 먼저 온 답, 첫 지시는 실행 인자 · 대화 기록 보관 안 함 · 일반 세션 채팅 작업은 다음 SRS.
