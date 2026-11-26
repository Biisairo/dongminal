# 채팅 고도화·이슈트리 채팅 진행 문서 — 착수 블록 포함

- 작성: 2026-11-26, 기능 추가 첫 세션(인터뷰·SRS·묶음 A 1단계)이 다음 세션에게 넘긴다.
- 요구·결정의 원본은 `docs/internal/ISSUE_TREE_CHAT_SRS.md` 다. 이 문서는 진행 상태와 이 세션이 배운 것만 담는다. 문서와 코드가 다르면 코드가 기준이다.

## 착수 블록 — 다음 세션의 지시 전부

1. 이 문서를 끝까지 읽는다.
2. 먼저 읽는다: `docs/internal/FEATURE_DEV_RULES.md`(규칙 전부, 특히 §3 설계 규칙·§4 시험·§5 운영 보호), `docs/internal/ISSUE_TREE_CHAT_SRS.md`(§3.1 묶음 A, §4 결정, §10 가정 — 모두 사용자 승인됨).
3. 저장소 상태 확인: 브랜치 `feature`, 직전 코드 커밋 `9cdafa44`. `git status` 가 깨끗해야 한다. main 은 origin/main 보다 2 커밋 앞(push 전), feature 는 main 보다 6 커밋 앞(착수 문서 · SRS · A1 · 진행 문서 · A1 와이어·소켓 · 진행 문서 갱신).
4. §2 의 묶음 T 표에서 "남음" 인 첫 단계(T-6)부터 이어 간다. 묶음 A·U 와 T-1~T-5 는 끝났다. 거울 맞추기·글 올리기·받기의 구조는 결정 I-20~I-22 와 `telegram/src/bridge/mirror.rs`·`post.rs`·`inbox.rs` 에 있다. 단계마다 시험 먼저(RED 확인) → 구현(GREEN) → fmt·clippy·관련 게이트.
5. 커밋은 단계마다 스스로 한다(사용자 지시 2026-11-26, AI 서명 금지). main 병합·push 는 사용자의 분명한 지시가 있을 때만.
6. 운영 바이너리 재빌드는 하지 않았다(운영 보호 §5). 사용자에게 보고했다. 사용자가 정할 때까지 빌드하지 않는다.

## 1. 끝난 것

| 커밋 | 내용 |
|---|---|
| `1ec9d6eb` | SRS `ISSUE_TREE_CHAT_SRS.md`(상태 승인·구현중) · `decisions.md` 재생성 |
| `b388a73f` | 묶음 A 1단계 — `rust/crates/daemon/chat`: `CALL_USER`, `Service::send_call`(방 밖 상대는 bad_request), `MsgBody.call`(비면 원문에 키 없음), `Message.called`, `is_called`·`room_has_member_locked`(service.rs). 시험 `tests_call.rs` 5개. 기존 `send` 는 빈 call 로 `send_call` 을 부른다 |
| `9cdafa44` | 묶음 A 1단계(와이어·소켓) — chatwire `Message.called`·`SendArgs.call`·`Room.notify`·`OP_NOTIFY`·`NOTIFY_*`·깨움 대기 프레임 `wait`/`wake?`/`wake`/`wake-drop`. chat `set_notify`(기본 called, 나가면 지움). chatsock 도구 id → 참가자 id, notify 연산, 깨움 대기 중계. rise·paste·ChatTools 제거(MCP 의 rise 보내기도 여기서 지웠다. MCP 시험은 개수 질의 `settle()` 로 맞춘다) |

## 2. 남은 일과 순서

구현 순서(사용자 결정 D-ITH-2): 묶음 A → U → T → L → C.

### 묶음 A (알림) — 끝남

| 단계 | 커밋 |
|---|---|
| 1 와이어·소켓 | `9cdafa44` |
| 2 MCP(`chat_send` call · `chat_notify` · 글마다 called · 깨움 대기 응답) | `ec655dd4` |
| 3 깨움 훅(`otterctl chat-wait`, Stop `asyncRewake`, timeout 7일 `CHAT_WAIT_TIMEOUT_SECS`) | `f5b549d1` |
| 4 웹 사용자 알람(방 행·방 탭·메인 패널 채팅 탭, 청구 `chat` 키) | `f8384b14` |
| 5 TC-ITH-7 실측 · e2e(chat-window · rail-chat-usage · screens-run-chat · attention-dedupe) | 통과 (2026-11-26) |

TC-ITH-7 실측 결과: 부르지 않은 글로는 깨지 않았다. 부른 글로 "읽지 않은 글 2건(나를 부른 글 1건)" 깨움이 왔다. 입력창에 쳐 둔 글은 남아 엔터로 따로 제출됐다. 깨어난 claude 의 `chat_read` 는 claude 쪽 auto mode 분류기가 "허가되지 않은 통신" 으로 막았다 — otterminal 밖의 일이다(아래 후속 후보).

### 묶음 U (채팅 화면) — 끝남

| 단계 | 상태 |
|---|---|
| U-1 서버 바탕: `POST /api/chat/notify`, `state` 의 방 참가자 `notify`·`tool` | 끝남 (`cc416342`) |
| U-2 지연 묶음에 마크다운: `markdown-it`(원시 HTML 끔) · `purify.js` · `highlight.js` 를 `web/bundles.txt` 의 `chat` 묶음에(FR-CUX-8·15). 부팅 JS 는 늘지 않는다 | 끝남 (결정 I-11·I-12) |
| U-3 대화 그리기(`chat-views.js`): 보낸 이 묶음·이어진 글(5분, 상수)·날짜 구분선·내 글 바탕·부른 글 띠 `@나`·`@<이름>`·폭 상한(FR-CUX-1~8) | 끝남 (결정 I-13·I-14) |
| U-4 이름 규칙(FR-CUX-9·14)과 색(FR-CUX-10: 에이전트는 참가자 id 로 테마 색 목록, 사람은 배경 대비 최대 색이며 그 색은 에이전트 목록에서 뺀다. 테마 바뀌면 다시 계산) | 끝남 (결정 I-15·I-16) |
| U-5 방 머리 세 줄과 내 단계 고르기(FR-CUX-11 → `/api/chat/notify`), 참가자 목록(FR-CUX-12: 사람 먼저·노드별·`<종류> · <상태> · 알림: <단계>`. 상태는 `people[].tool` 로 `app._activity` 를 읽는다. 다른 노드 참가자의 단계는 비어 있으면 적지 않는다) | 끝남 (결정 I-17) |
| U-6 입력칸 `@` 자동완성과 글의 `답장` → `/api/chat/send` 의 `call`(FR-CUX-13) | 끝남 (결정 I-18) · e2e `chat-ux.spec.ts` 4건(TC-ITH-8·9) |
| U-7 잠듦(FR-CUX-16) 확인, 좁힌 e2e(chat-window · screens-run-chat), 목업 사진과 격리 인스턴스 화면 비교 | 끝남 — e2e `chat-ux.spec.ts` 5건(잠듦 포함) · 좁힌 e2e 26건 통과. 목업과 비교해 동그라미(보낸 이 색으로 꽉 참)·종류 배지·부른 글 띠(본문 영역 + 옅은 바탕)를 맞췄다. 사진은 `.playwright-mcp/u5-chat.png` |

결정 I-10: 다른 노드 참가자의 알림 단계는 망 상태 프레임에 싣지 않는다(서명 프레임 변경을 피한다). 화면은 모르는 단계를 적지 않는다.

### 묶음 T (텔레그램 토픽) — 진행 중

| 단계 | 상태 |
|---|---|
| T-1 설정: `Config.topics`·View·`Store.set_topics`, 설정 API 와 화면 토글(켜기·token·허용 계정이 전제), getMe 의 `has_topics_enabled` 안내, BotFather 안내, 밖으로 나가는 데이터 목록(FR-TGT-1·2·13) | 끝남 (결정 I-19) |
| T-2 짝 파일: 방 id ↔ 토픽 thread id · 고정 글 id. 설정 파일 옆, 권한 600, 다시 시작해도 이어 쓴다(FR-TGT-4) | 끝남 — `telegram/src/topics.rs`(`TopicMap`·`Topic{threadId,pinId,name,pinText}`·`topics_path`, 파일 `telegram-topics.json`). 시험 5. 모듈의 `allow(dead_code)` 는 T-3 에서 지웠다. 아직 쓰지 않는 `by_thread` 하나에만 남았다 — T-5 에서 쓰면 지운다 |
| T-3 거울 맞추기: Host 가 채팅 상태(방·사람 참가자)를 준다. 방 생김/사라짐 → createForumTopic/deleteForumTopic, 고정 안내 글(목적·참가자 수·들어감·단추) 만들기·고치기, 짝만 있고 방 없음 → 지움(FR-TGT-3·5) | 끝남 (결정 I-20) — `telegram/src/bridge/mirror.rs`(`ChatRoom`·`display_name`·`Bridge::on_chat_changed`·`sync_topics`), `Host::chat_rooms`, 서버 `TelegramHost::chat_rooms`·`telegram_chat_changed`. 시험: mirror 14 · httpapi 4. T-2 시험의 unix 전용 import 를 `cfg(unix)` 로 묶었다(check-cross windows 실패) |
| T-4 글 올리기: 사람 참가자에게 온 글과 내가 보낸 글 → 토픽. 머리(굵은 표시 이름·시각·@부름), 마크다운 → Telegram HTML, 4,096자 나누기, 깨울 글만 소리(FR-TGT-7·8) | 끝남 (결정 I-21) — `telegram/src/bridge/post.rs`(`ChatPost`·`on_chat_post`·`post_chat`·`split_chunks`), `render::chat_md_html`, `Host::chat_view`(T-3 의 `chat_rooms` 를 바꿈), 시험 공용 틀 `bridge/chatrig.rs`. 서버 `chat_pushed`(msg)·`chat_do`(send 성공) → `telegram_chat_post`. 시험: post 9 · httpapi 2 |
| T-5 받기: 허용 계정의 토픽 글 → 방에 사람 글(답장·@ → call), 들어가지 않음 → 안내, 단추 → join/leave, 남의 업데이트 무시(FR-TGT-6·9·10) | 끝남 (결정 I-22) — `telegram/src/bridge/inbox.rs`(`room_button`·`topic_message`·`calls_in`·`Senders`), `Host::chat_join`·`chat_send`, client `Message.message_thread_id`·`reply_to_message`, 서버 `TelegramHost::chat_op`. `by_thread` 의 allow 도 지웠다. 시험: inbox 9 · httpapi 2 |
| T-6 토픽 없음 오류 → 다시 만들고 짝 고친 뒤 다시 보냄(FR-TGT-11). 끄면 토픽 요청 0(NFR-ITH-4, TC-ITH-13). 기존 알림은 토픽 밖 그대로(FR-TGT-12) | 남음 |
| T-7 실측 TC-ITH-14 — 사용자 봇이 필요하다. 사용자에게 요청한다 | 남음 |

#### T-3 설계 메모 (전 세션이 조사한 것, 코드가 기준)

- 브리지: `telegram/src/bridge.rs`. 사건은 `Item` 큐 → `process`(작업자 하나). `active()` 는 켜기·token·허용 계정만 본다 — 토픽 일은 `Config::topics_active()` 로 따로 거른다(NFR-ITH-4). Bot API 호출은 `self.call(&c, method, &json)`(결과 버림) 또는 `self.client(&c).call::<T>(…)`(결과 받음). 1:1 대화방 chat_id 는 `c.user_id`.
- `Host` 트레이트(bridge.rs:48)에 채팅 몫을 기본 구현과 함께 더한다: 방 목록(사람 참가자가 보는 `state` 의 방 — id·kind·제목·목적·참가자 수·joined), join/leave, 사람 글 보내기(text·call). 서버 구현은 `httpapi/src/telegram_api.rs` 의 `TelegramHost`(Weak<Server>)다. 채팅 데몬 경로는 `httpapi/src/chat_api.rs` 의 `chat_do`(op 를 데몬에 넘김)와 `chat_pushed`(:174, 사람에게 온 글)다.
- 거울 맞추기 사건: 채팅 상태가 바뀔 때(서버가 `chat` 토픽을 새로 낼 때) `Item::ChatSync` 를 넣는다. 처리: 방마다 짝이 없으면 `createForumTopic{chat_id,name}` → `message_thread_id`, 고정 안내 글 `sendMessage{message_thread_id, reply_markup:[[들어가기|나가기]]}` → `pinChatMessage`, 짝 저장. 이름이 바뀌면 `editForumTopic`, 안내 글이 바뀌면 `editMessageText`(+reply_markup). 짝만 있고 방이 없으면 `deleteForumTopic` 뒤 짝을 지운다.
- 단추 callback_data 는 64바이트 상한이다 — 방 id 길이를 확인하고 접두(예: `cj:`/`cl:`)를 짧게 둔다. 기존 `[읽음]` 단추의 접두는 `render::READ_PREFIX` 다.
- 시험 틀: `bridge/tests.rs` 의 `FakeTg`(호출 기록 + 메서드별 응답)·`FakeHost`·`testsrv`. createForumTopic 응답은 `{"ok":true,"result":{"message_thread_id":N,"name":"…"}}` 로 늘린다.

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
| I-7 | 같은 세션의 새 깨움 대기는 앞선 대기를 0건으로 끝낸다(`waits` 세션당 하나) | 쉴 때마다 Stop 훅이 하나씩 떠 쌓이지 않게 한다 |
| I-8 | 깨움 훅의 timeout 은 7일이다(agentadapter `CHAT_WAIT_TIMEOUT_SECS`) | claude 명령 훅은 시한이 지나면 끊기고, 그 뒤 온 글로는 다음 Stop 까지 깨우지 못한다. JS 타이머 상한(약 24.8일) 안 |
| I-11 | highlight.js 를 `[docrender]` 에서 새 라이브러리 묶음 `[hljs]` 로 옮기고, `chat`·`docrender` 가 needs `['mdlib','hljs']` 로 싣는다. 채팅 마크다운은 `js/core/chat-md.js`(`chatMdHtml`·`chatMdFragment`, `[chat]` 묶음)다. 문서 렌더의 인스턴스와 나눈다(그쪽은 원시 HTML 을 살린다). 부팅 JS 는 등록 한 줄과 needs 로 61 B 늘었다(라이브러리 자체는 지연) | 한 파일은 한 묶음에만 둔다(bundles.txt). mdlib 에 넣으면 터미널 첫 hover 가 129 KB 를 더 받는다. `settings` 가 `chat` 을 needs 로 싣으므로 설정을 처음 열 때도 mdlib·hljs 가 실린다 |
| I-12 | 채팅 마크다운은 `breaks: true`(한 줄 바꿈도 줄 바꿈)이고, 코드 블록은 `<pre class="chat-code" data-lang=…>` 로 언어를 싣는다. 언어 표시의 그리기는 U-3 의 CSS 다 | 채팅 글은 한 줄 바꿈을 뜻대로 쓴다 |
| I-13 | 글(`chat::Message`·`chatwire::Message`)이 부른 상대 `call`(참가자 id 또는 user)을 싣는다. 비면 키가 없다(옛 형식 그대로). 화면은 `called` 면 `@나`, 그 밖의 항목은 방 참가자 표시 이름으로 `@<이름>` 을 적는다 | 받는 이 기준 `called` 만으로는 다른 상대를 부른 글을 알 수 없다(FR-CUX-7) |
| I-14 | 채팅 탭의 CSS 를 `style-activity.css` 에서 `[chat]` 묶음의 `style-chat.css` 로 옮겼다(`css: true`). 채팅 목록 행 CSS 는 부팅에 남는다. 묶음 간격 상수는 `constants-chat.js`(`[chat]` 맨 앞) | CSS 최대 파일 기준선(415줄)·타이밍 상수 규칙. e2e 둘을 고쳤다: TC-LZ9-2 는 `chat.css` 도 받고, TC-UXF-44 는 부팅 CSS 의 `chat-row-sub` 로 잰다. 글 머리의 짧은 id 는 이름의 `title` 로 옮겼다 |
| I-15 | 색은 테마 파생(`themeVarsOf` → `deriveChatColors`, contrast.js)이 `--chat-me`(구문 색 여섯 가운데 배경 대비 최대)와 `--chat-a0`~`--chat-a4`(나머지)로 세운다. 글은 `--chat-c` 에 `chatColorVar(id)`(FNV 해시 % 5) 를 단다. 나만 사람 색이고, 다른 노드의 사람은 id 로 고른다 | 테마를 바꾸면 applyThemeObj 가 변수만 다시 세우므로 그린 글을 다시 그리지 않는다 |
| I-16 | 이름 규칙 `chatName`·`#` 겹침 제거는 부팅 패널도 쓰므로 `chat-store.js`(부팅)에 둔다. 노드 구분은 id 의 지문(마지막 `-` 앞)이다. `›` 는 카탈로그 `chat.name_remote` 이고 문자 아이콘 시험의 허용 목록에 이유와 함께 넣었다. 부팅 JS 는 U-2~U-4 합계 945 B 늘었다(1,143,889 → 1,144,834, 상한 1,150,000) | NFR-ITH-2 의 "늘지 않는다" 를 글자 그대로는 지키지 못했다 — 패널 이름 규칙(FR-CUX-14)과 테마 파생 색(FR-CUX-10)이 부팅 코드에 산다. 사용자에게 보고할 것 |
| I-17 | 참가자 목록은 노드별 묶음(내 노드 먼저, 나머지는 노드 이름 차례)이고 묶음 안에서 사람이 먼저다. 노드 머리는 묶음이 둘 이상일 때만 선다. 내 알림 단계는 셋째 줄의 단추 → 메뉴(`cur` 표시) → `POST /api/chat/notify` 뒤 state 를 다시 읽는다. 들어가지 않은 방에서는 단추가 꺼진다. 활동 상태가 바뀌면(`_onToolActivity`) 채팅 뷰를 다시 그린다(참가자 행 서명이 같으면 건너뜀) | FR-CUX-11·12. 상태 이름은 활동 패널의 `AGENT_STATE_LABEL` 을 그대로 쓴다(작업 중·대기·완료·멈춤) |
| I-18 | 부른 상대는 따로 든 상태 없이 **본문의 `@<표시 이름>`** 에서 뽑는다(`chatCallsIn`, 긴 이름 먼저·낱말 처음의 `@` 만·나는 뺌). `@` 목록은 고르면 `@이름 ` 을 넣고, 답장 단추(글에 올리면 보임)는 입력칸 앞에 `@보낸 이 ` 를 붙인다. 보낸 글의 즉시 표시에도 `call` 을 싣는다 | 사용자가 지운 이름은 부르지 않는다 — 화면에 보이는 것과 보내는 것이 같다 |
| I-19 | 채팅 토픽 설정은 `telegram.json` 의 `chatTopics`(꺼지면 키 없음 — 1판의 `topics` 객체와 이름을 나눔)다. `Config::topics_active()` = 켜기·token·허용 계정·chatTopics 모두. `PUT /api/telegram/topics {topics}` — 전제 없음 409 `telegram_topics_need_bridge`, 켤 때 getMe 의 `has_topics_enabled` 가 거짓이면 409 `telegram_topics_mode_off`(저장 안 함). 응답·GET 은 켜져 있을 때만 `chatTopics: true`(Go 골든 그대로). 설정 화면의 블록은 지연 묶음 `settings-telegram.js` 가 만든다(부팅 카탈로그를 늘리지 않음). 밖으로 나가는 데이터는 설정 화면과 TELEGRAM_BRIDGE_SRS §8 에 적었다 | FR-TGT-1·2·13, R-5 |
| I-20 | 거울 맞추기(FR-TGT-3·5): 서버가 방을 바꾸는 채팅 연산 성공 · 데몬의 `changed` · 데몬 재연결 · 채팅 토픽 켜기 · 브리지 시작 때 `on_chat_changed` 를 부른다. 브리지는 `topics_active` 일 때만 `Item::ChatSync` 를 넣고, 처리 전의 맞추기는 하나로 합친다. 방 목록은 데몬 `state` 를 블로킹 스레드에서 읽고, 읽지 못하면(None) 아무것도 지우지 않는다. 토픽 이름은 단체채팅 = `#` 없는 방 이름, 개인채팅 = 상대 표시 이름(없으면 `개인채팅`), 128자에서 자름. 고정 글은 HTML(굵은 이름 · 목적 · `참가자 N명 · 들어가 있음/있지 않음`)이고 단추는 상태에 맞는 **하나**(`[들어가기]` 또는 `[나가기]`)다. 단추 데이터는 `cj:`/`cl:` + **토픽 thread id** 다. 토픽 지우기를 Telegram 이 거절하면(이미 없음) 짝을 지우고, 닿지 못하면 남겨 다음에 다시 지운다. 만들기·고정 글이 실패하면 다음 맞추기에서 다시 한다 | 방 id 는 64자 hex 라 `cj:` 를 붙이면 callback_data 상한 64바이트를 넘는다. 고정 글은 들어감이 바뀔 때마다 고치므로 단추 하나로 충분하다 |
| I-21 | 글 올리기(FR-TGT-7·8): 서버가 데몬이 사람에게 민 글(`chat_pushed` msg)과 웹에서 보낸 내 글(`/api/chat/send` 성공, 시각은 서버 지금)을 `ChatPost` 로 넘긴다. 브리지는 마지막 맞추기의 보기(`ChatView`: 나 · 방별 알림 단계 · 참가자 표시 이름)로 머리 줄(`<b>이름</b> HH:MM · @이름…`, `user`·나는 `@나`, 모르는 id 는 id 그대로)과 소리를 정한다. 소리는 내 글이 아니고 단계 all · (called·빈 값이면 called 글)일 때 첫 조각만. 짝이 없는 방의 글은 먼저 맞춘다. 4,096자는 원문을 줄 단위로 `MESSAGE_MAX-256` 단위 조각으로 나누고, 열린 코드 블록은 다음 조각 앞에 여는 줄을 다시 붙인다. 보내기는 알림과 같은 `send_alarm`(429·HTML 오류 재시도)이다. 코드 블록은 `<pre>`(언어가 있으면 `<code class="language-…">`) | 데몬은 보낸 이에게 글을 되밀지 않는다(`local_deliveries_locked` 가 보낸 이를 뺀다). 옮긴 HTML 의 보이는 글은 원문보다 길지 않다 |
| I-22 | 받기(FR-TGT-6·9·10): 허용 계정 판정 뒤에 `cj:`/`cl:<thread>` 단추를 `Host::chat_join` 으로 처리하고(`들어갔습니다`/`나갔습니다`/`처리하지 못했습니다`, 모르는 토픽·꺼짐은 `지원하지 않는 버튼입니다.`) 맞추기를 넣는다. 거울 토픽의 글은 그때 `chat_view` 를 새로 읽어 들어가 있으면 `Host::chat_send`(부름 = 답장한 글의 보낸 이 + 본문의 `@표시이름`, 긴 이름 먼저·낱말 처음만·나 뺌, 없으면 데몬 규칙 D-ITH-12), 아니면 토픽에 안내를 단다. 빈 글은 버린다. 거울 토픽이 아닌 글과 꺼져 있을 때는 예전 안내 그대로다. 답장 대상은 토픽에 올린 남의 글 id → 보낸 이를 최근 1,024개(`SENDERS_MAX`) 기억해 찾는다. 서버 Host 의 채팅 연산은 웹 `chat_do` 처럼 성공하면 `chat` 토픽과 거울을 다시 맞춘다. 토픽에서 쓴 글은 토픽에 되올리지 않는다 | 토픽 안의 답장 아닌 글은 Telegram 이 토픽 첫 글을 reply_to 로 달 수 있다 — 기억에 없는 id 라 부름이 생기지 않는다 |
| I-9 | 웹 알람의 단계는 `state` 의 방 `notify` 로 판정하고, 알람은 `ChatStore` 에 방마다 둔다. 방 탭이 보이면 안 읽은 수와 함께 꺼진다 | FR-CAL-15·16 |

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

## 4.6 후속 후보 (손대지 않음)

- 텔레그램 토픽에서 쓴 글은 방(에이전트)에는 가지만 PC 채팅 창에는 보이지 않는다. 사람 쪽 대화는 브라우저 메모리에만 있고, 데몬은 보낸 이에게 글을 되밀지 않기 때문이다(SRS 범위 밖). 웹에 `chat_message` 로 알리려면 알림 단계 all 일 때 내 글로 알람이 울리지 않게 웹 쪽도 고쳐야 한다.
- claude 2.1.332 는 시작할 때 "subagentStatusLine is deprecated in favor of mods" 경고를 띄운다. shim 이 주입하는 `subagentStatusLine`(FR-SAU-5) 이 대상이다.
- 깨어난 에이전트의 `chat_read` 를 claude auto mode 분류기가 막을 수 있다. 실사용에서는 사용자가 `/permissions` 로 otterminal MCP 도구를 허용해야 할 수 있다. 안내 문서나 shim 의 허용 설정 주입을 검토한다.

## 5. 변하지 않는 규약

- **e2e 전량은 모든 묶음(A·U·T·L·C)의 구현이 끝난 뒤 한 번만 돌린다(2026-11-26 사용자 지시).** FEATURE_DEV_RULES §4.2 의 "마일스톤마다" 를 이 작업에서는 대신한다. 묶음 중간에는 바꾼 동작을 재는 스펙만 `--grep`·파일로 좁혀 돌린다. 워크스페이스 전체 시험·cross 는 묶음 끝마다 돌려도 된다.
- 사용자는 모든 단계를 묻지 않고 진행하라고 했다(2026-11-26). 단계마다 커밋은 스스로 한다(AI 서명 금지). main 병합·push·운영 바이너리 재빌드는 여전히 사용자 지시가 있어야 한다.

- `FEATURE_DEV_RULES.md` §2~§6 전부. 특히 운영 보호(§5): 운영 바이너리·`~/.otterminal` 실행·접근 금지, 시험 빌드는 이름을 나눈다, `pkill`·`killall` 금지(내가 띄운 PID 만).
- 유휴 규칙: 새 작업은 사건 기반, 시간 값은 `cadence` 또는 crate 상수(NFR-ITH-1). 부팅 JS 1,150,000 B 이하(NFR-ITH-2).
- 커밋은 사용자 확인 뒤, AI 서명 금지. 설명은 한국어로 쉽게.
- 텔레그램으로 채팅 본문이 나가는 것은 사내 규정상 회사 자료면 정보보호팀 승인 대상이다(SRS R-5). 기능은 기본 꺼짐.

## 6. 유효한 사용자 결정

SRS §4 의 D-ITH-1~23 과 §10 의 가정 A-1~8 이 모두 유효하다(2026-11-26 승인). 요점만:
알림은 asyncRewake 깨움 훅(붙여넣기 제거) · 깨울 때 개수만 · 같은 글로 두 번 깨우지 않음 · 부른 글은 `call` 필드 · 사람 글은 지정 없으면 방의 모든 에이전트를 부름 · 알림 단계(사용자는 방마다 고름, 기본 called / 에이전트는 각자, 기본 called) · 웹 알람은 에이전트 알람과 같은 방식 · 채팅 화면은 목업대로 · 색은 참가자 id / 사용자는 배경 대비 최대 색 · 텔레그램은 1:1 대화방 토픽, 모든 방의 거울, 토픽 안 들어가기·나가기, 사용자 글 전달, 사용자는 토픽 삭제 불가 · 로컬 이슈트리는 보관×실행 네 조합, `otterctl issue`, 조정자가 일꾼 수 판단, 일꾼 커밋·조정자 병합, 규칙은 otterminal 이 주입 · 트리 방은 자동 입장, 상대 지정 통신, 화면에도 옮김, 먼저 온 답, 첫 지시는 실행 인자 · 대화 기록 보관 안 함 · 일반 세션 채팅 작업은 다음 SRS.
