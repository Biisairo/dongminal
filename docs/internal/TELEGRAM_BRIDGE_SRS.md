# SRS: Telegram 브리지 — 휴대폰에서 실행 중인 에이전트 보기·조작 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: ② 설정·클라이언트·짝맞춤(§3.1·3.2) ③ 토픽·입력·버튼·알림·알람 해제(§3.3~3.6·3.8) ④ 출력(§3.7) ⑤ API·설정 화면 ⑥ TC-TGB-31·90 실측. ① hook 보고 확장(§3.9, TC-TGB-70)은 닫혔다 — 서버는 값을 받기만 하고 아직 쓰지 않는다
> **입력**: 2026-11-12 대화. 사용자 결정은 §4 에 적는다. 실측 결과는 §2 에 적는다.
> **실험 기능**: 사용자는 "해 보고 안 되면 지운다" 고 했다. 그래서 이 기능은 설정에서 끄면 없는 것과 같아야 한다(NFR-TGB-1). 걷어 낼 때 지울 범위도 그 경계와 같다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자는 PC 에서 에이전트에게 일을 시킨 뒤 자리를 비운다. 이 SRS 는 그때 휴대폰(Telegram)으로 그 에이전트의 진행을 보고, 입력하고, 중단하고, 권한 요청과 질문에 답하게 한다.

PC 에서 쓰는 데에는 영향이 없어야 한다. Telegram 은 **두 번째 키보드이자 두 번째 화면**이다. PC 의 Claude Code 는 이 기능이 있는지 모른다.

### 1.2 범위 (Scope)

**포함**
- 설정: 켜기·끄기, 봇 token, 허용 계정 등록(짝맞춤 코드), PC 입력 후 무음 시간
- 대화(`session_id`) 하나에 Telegram 토픽 하나를 두고, 열고 지우는 규칙
- 토픽에서 글 입력, 키 입력(Esc·선택), 권한 요청·질문에 답하기
- 응답 글의 실시간 표시와 도구 호출 한 줄 요약
- 사용자 입력이 필요한 알림(작업 끝남·권한 요청·질문·입력 대기)
- Telegram 쪽 조작으로 PC 의 점멸 알람 해제

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **브리지** | 이 기능 전체. 서버 프로세스 안에서 돈다 |
| **대화** | Claude Code 의 `session_id` 하나. `startup` 으로 생기고 `resume` 으로 이어진다(§2.4) |
| **토픽** | 봇과 사용자의 1:1 대화방(DM) 안의 Telegram 토픽. 대화 하나에 토픽 하나 |
| **현재 탭** | 그 대화의 hook 보고가 마지막으로 온 도구(탭 uuid). 입력을 넣을 곳이다 |
| **허용 계정** | 짝맞춤으로 등록한 Telegram 사용자 하나(`from.id`) |
| **상태 메시지** | 토픽 위에 고정한 메시지 하나. 상태와 `[Esc] [화면]` 버튼을 담고 고쳐 쓴다 |
| **입력 필요 알림** | 작업 끝남(`done`), 권한 요청, 질문(AskUserQuestion), 입력 대기(`waiting`) |
| **무음 시간** | PC 브라우저에서 그 탭에 입력한 뒤 알림을 소리 없이 보내는 시간 |
| **원시 키** | 붙여넣기로 감싸지 않고 PTY 에 그대로 쓰는 바이트(Enter·Esc·화살표·숫자) |

### 1.4 참고 (References)

- `ACTIVITY_STATE_SUBAGENT_SRS.md` FR-ASV-3~5 — hook 해석표(`parseClaudeHook`)
- `ATTENTION_FIRING_SRS.md` FR-ATA-9 — 알람 해제의 `typed` 뜻
- `PEER_NETWORK_SRS.md` — 전용 설정 파일(권한 600)과 짝맞춤의 선례
- `OPTIMIZE_REFACTOR_SRS.md` FR-OPT-4-11 — 숨은 터미널의 지연 연결
- Telegram Bot API: `createForumTopic`·`editForumTopic`·`deleteForumTopic`·`sendMessageDraft`·`answerCallbackQuery` (Bot API 9.3·9.4·9.5)

### 1.5 개요 (Overview)

§2 는 실측으로 확인한 사실, §3 은 요구, §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험, §8 은 밖으로 나가는 데이터 목록이다.

## 2. 현황과 실측 (Identified Facts)

2026-11-12 에 테스트 봇과 임시 claude 세션(`/tmp/tgspike`)으로 쟀다.

### 2.1 Telegram (DM 토픽, Threaded Mode 켬)

| 항목 | 결과 |
|---|---|
| `getMe.has_topics_enabled` | `true`. 설정 자리는 BotFather Mini App → My bots → 봇 → Bot Settings → Threads Settings → Threaded Mode. `/mybots` 글 메뉴에는 없다 |
| `createForumTopic`(DM) | 성공 |
| `editForumTopic`(이름·이모지) | 성공. 휴대폰에 바로 보였다 |
| `closeForumTopic`(DM) | **실패**: `the chat is not a supergroup forum`. DM 에서는 닫기가 없다 |
| `sendMessageDraft`(토픽 안) | 성공. 글이 늘어나며 보였다 |
| `sendMessageDraft` 빈 글 + `can_stop` | 점 세 개 표시만 보였다. 정지 버튼과 정지 update 는 없었다 |
| 인라인 버튼 | `callback_query.message.message_thread_id` 로 어느 토픽인지 온다 |
| `answerCallbackQuery` 를 안 하면 | 버튼이 로딩으로 남아 사용자가 6번 눌렀다 |
| 사용자가 일반 대화창에 글을 쓰면 | Telegram 이 토픽을 새로 만든다(`forum_topic_created.is_name_implicit`). 봇은 그 알림을 받는다 |
| 읽음 표시 | Bot API 에는 없다. 봇은 사용자가 읽었는지 알 수 없다 |

### 2.2 Claude Code hook (dongminal 이 이미 거는 것)

`claudeHookEvents` 는 `PreToolUse`·`PermissionRequest`·`Notification`·`Stop`·`SessionStart` 를 이미 건다. 모두 보고만 하고 끝난다.

| hook | 실린 값(실측) | 브리지에 쓰는 곳 |
|---|---|---|
| `PermissionRequest` | `tool_name`, `tool_input` 전체, `permission_suggestions` | 권한 요청 메시지와 버튼 |
| `PreToolUse`(AskUserQuestion) | `questions[].question`·`header`·`options[].label·description`·`multiSelect`, `tool_use_id` | 질문 메시지와 선택지 버튼 |
| `PostToolUse` | `tool_use_id`, `tool_response` | 그 요청이 PC 에서 처리됐다는 신호 |
| `Notification` | `message`(고정 문구), `notification_type` | 신호만. 내용이 없다 |
| `SessionStart` | `source`, `session_id` | 대화 시작·이어짐 판정 |

지금의 보고(`Report`)는 `Detail` 을 512자로 자르고 `tool_use_id`·`source` 를 서버로 넘기지 않는다. `session_id`·`transcript_path` 는 이미 넘긴다.

### 2.3 입력 경로

- `dmctl send-input` 과 `deliverToTool` 은 글을 붙여넣기(`ESC[200~ … ESC[201~`)로 감싼다. 실측에서 AskUserQuestion 화면에 `2` 를 넣었더니 선택되지 않고 자유 입력칸(3번)에 글자로 들어갔다. Enter 도 줄바꿈이 됐다.
- 서버 안에는 감싸지 않고 쓰는 경로 `ToolManager.Write` 가 있다.

### 2.4 대화 식별

`claude -p` 로 쟀다.

| 실행 | `SessionStart.source` | `session_id` |
|---|---|---|
| 새로 시작 | `startup` | `3c673a2b…` |
| `--resume 3c673a2b…` | `resume` | 같음 |
| `--continue` | `resume` | 같음 |

`/clear`·`--fork-session` 은 새 `session_id` 다(문서 기준, §5 에서 확인).

### 2.5 transcript

transcript JSONL 에는 응답 글·도구 호출·도구 결과 말고도 시스템 프롬프트와 사용자 이메일이 든 내부 줄(`api-request-blob` 등)이 섞여 있다.

### 2.6 숨은 탭

브라우저가 한 번도 열지 않은 탭은 터미널이 연결되지 않는다(지연 연결). 그 탭에서 claude 를 새로 띄우면 터미널 질의(`ESC[c` 등)에 답할 곳이 없어 시작 화면에서 멈췄다. 이미 떠 있는 세션에는 해당하지 않는다.

## 3. 요구 (Requirements)

### 3.1 설정

- **FR-TGB-1** 설정 창에 Telegram 항목을 둔다. 항목은 켜기·끄기, 봇 token, 허용 계정(등록·해제), 무음 시간(분, 기본 5, 0 이면 무음 없음)이다.
- **FR-TGB-2** 설정은 전용 파일 `~/.dongminal/telegram.json`(권한 600)에 둔다. 일반 설정(`settings.json`)에는 두지 않는다. 일반 설정은 모든 브라우저에 내려가기 때문이다.
- **FR-TGB-3** token 은 쓰기 전용이다. API 응답·SSE·로그에는 token 을 싣지 않는다. 화면은 "설정됨" 과 봇 이름(`getMe.username`)만 보인다.
- **FR-TGB-4** token 을 저장하면 서버가 `getMe` 로 확인한다. 실패하거나 `has_topics_enabled` 가 거짓이면 저장을 거절하고 이유를 보인다. 후자는 §2.1 의 설정 자리를 안내한다.
- **FR-TGB-5** token 을 바꾸면 허용 계정과 토픽 대응표를 지운다.

### 3.2 허용 계정 (짝맞춤)

- **FR-TGB-10** 설정 창의 "등록" 은 6자리 코드를 만든다. 코드는 10분 동안 한 번만 쓴다.
- **FR-TGB-11** 봇이 `/pair <코드>` 를 받으면 코드를 확인하고 보낸 사람의 `from.id` 를 허용 계정으로 저장한다. 허용 계정은 하나다. 새로 등록하면 이전 계정을 바꾼다.
- **FR-TGB-12** 허용 계정이 아닌 사람의 update 에는 답하지 않는다. 서버 로그에 `from.id` 와 종류만 한 줄 남긴다. 본문은 남기지 않는다.
- **FR-TGB-13** 판정은 `from.id` 로 한다. `chat.id` 로 하지 않는다.

### 3.3 대화와 토픽

- **FR-TGB-20** 토픽의 단위는 대화(`session_id`)다. 탭이 아니다.
- **FR-TGB-21** 서버는 `session_id` → (토픽 id, 현재 탭) 대응표를 갖는다. 현재 탭은 그 `session_id` 의 hook 보고가 올 때마다 갱신한다.
- **FR-TGB-22** 토픽이 생기는 때는 둘이다.
  - 사용자가 `/agents` 목록에서 그 대화를 고른다.
  - 그 대화에 입력 필요 알림이 생긴다(§3.6).
- **FR-TGB-23** `/agents` 는 지금 실행 중인 대화를 버튼으로 보인다. 버튼 문구는 탭 이름과 상태다. hook 이 없는 에이전트(codex 등)는 탭 uuid 를 대화로 보고 목록에 넣는다.
- **FR-TGB-24** 토픽 이름은 `<상태 이모지> <탭 이름>` 이다. 상태가 바뀌면 `editForumTopic` 으로 고친다. 같은 토픽은 10초에 한 번까지만 고친다.
  - 작업 중 🔧 · 입력 대기 ⏳ · 끝남 ✅ · 실행 중 아님 ⏹
- **FR-TGB-25** `SessionStart.source` 가 `resume` 이면 그 `session_id` 의 기존 토픽을 다시 쓴다. 토픽이 지워졌으면 새로 만든다.
- **FR-TGB-26** 대화가 어느 탭에서도 돌지 않으면 토픽 이름을 ⏹ 로 바꾼다. 그 토픽에 입력이 오면 "지금 실행 중이 아님" 으로 답하고 아무것도 넣지 않는다.
- **FR-TGB-27** 토픽은 사용자가 지울 때만 지운다. 지우는 길은 토픽 안의 `/close`, 전체의 `/cleanup`(⏹ 토픽을 모두 지움), Telegram 에서 직접 지우기다. 지우는 것은 토픽뿐이다. 에이전트·탭·대화는 그대로다.
- **FR-TGB-28** 토픽이 지워진 것을 알 길이 없으므로, 보내다 "thread not found" 류 오류를 받으면 지워진 것으로 보고 다시 만든다. 새 토픽의 첫 메시지에 최근 응답 하나를 싣는다.
- **FR-TGB-29** 대응표는 `telegram.json` 에 저장해 서버를 다시 띄워도 이어 간다.

### 3.4 토픽에서의 입력

- **FR-TGB-30** 토픽에 쓴 글은 현재 탭에 붙여넣기 + 제출로 넣는다(`deliverToTool`).
- **FR-TGB-31** 키는 원시 키로 넣는다(`ToolManager.Write`). 대상은 Esc·Enter·화살표·숫자·Space·Tab 이다.
- **FR-TGB-32** 상태 메시지는 토픽마다 하나이고 위에 고정한다. 버튼은 `[Esc] [화면]` 이다.
  - `[Esc]` 는 원시 Esc 하나를 넣는다.
  - `[화면]` 은 현재 탭의 화면 끝부분(ANSI 를 걷은 글, 최대 3500자)을 한 번 보낸다.
- **FR-TGB-33** (삭제) PC 입력과의 섞임은 막지 않는다. D-TGB-13 참고.
- **FR-TGB-34** 모든 버튼은 누르는 즉시 `answerCallbackQuery` 로 답한다.

### 3.5 권한 요청과 질문

- **FR-TGB-40** `PermissionRequest` 를 받으면 토픽에 요청 메시지를 보낸다. 내용은 도구 이름과 도구 입력의 요약(Bash 는 명령, 파일 도구는 경로)이다. 버튼은 화면의 선택지를 따른다(예: `[1 허용] [2 항상 허용] [3 거절]`).
- **FR-TGB-41** AskUserQuestion 의 `PreToolUse` 를 받으면 질문과 선택지를 보낸다. 선택지마다 버튼 하나를 두고, "직접 입력" 은 안내 문구로 둔다(토픽에 글을 쓰면 그 답이 들어간다).
- **FR-TGB-42** 버튼을 누르면 해당하는 원시 키를 넣는다. 키 순서(숫자인지 화살표+Enter 인지)는 구현 전에 실측으로 정한다(§5 TC-TGB-31).
- **FR-TGB-43** 요청마다 `tool_use_id` 를 버튼 데이터에 싣는다. 같은 `tool_use_id` 의 `PostToolUse`·`PostToolUseFailure` 가 오거나 그 대화의 다음 상태 보고가 오면 그 요청은 끝난 것이다. 끝난 요청의 버튼은 키를 넣지 않고 "이미 처리됨" 으로 답하고, 메시지 버튼을 걷는다.
- **FR-TGB-44** 이 판정은 화면을 읽지 않는다.

### 3.6 알림

- **FR-TGB-50** 입력 필요 알림은 사용자가 토픽을 열어 두지 않아도 간다. 토픽이 없으면 만든다.
- **FR-TGB-51** 알림 메시지마다 `[✓ 읽음]` 버튼을 둔다. 권한·질문 메시지에는 선택지 버튼 옆에 둔다.
- **FR-TGB-52** 작업 끝남 알림에는 그 턴의 마지막 응답 글을 싣는다(§3.7 의 규칙으로 자른다).
- **FR-TGB-53** PC 브라우저에서 그 탭에 무음 시간 안에 입력이 있었으면 알림을 `disable_notification` 으로 보낸다. 메시지는 그대로 남는다. 휴대폰 입력은 이 계산에 넣지 않는다.

### 3.7 출력

- **FR-TGB-60** 출력의 원천은 transcript 다. 서버는 열려 있는 토픽의 대화만, 파일 변경 알림을 받아 새로 붙은 줄만 읽는다. 주기적으로 읽지 않는다.
- **FR-TGB-61** 보내는 것은 셋뿐이다.
  - 응답 글(assistant text)
  - 도구 호출 한 줄: `🔧 <도구>: <요약>` (Bash 는 명령 첫 줄, Read·Edit·Write 는 경로, 그 밖에는 도구 이름)
  - 서브에이전트의 시작과 끝 한 줄
- **FR-TGB-62** 도구 결과, 시스템 줄, `api-request-*` 줄, 첨부는 보내지 않는다. 판정은 허용 목록이다(위의 셋만 통과).
- **FR-TGB-63** 응답 글은 쓰이는 동안 `sendMessageDraft` 로 보이고, 끝나면 `sendMessage` 로 남긴다. 같은 토픽의 draft 갱신은 0.5초에 한 번까지다.
- **FR-TGB-64** 글은 Telegram HTML 로 바꾸고 4096자를 넘으면 태그를 깨지 않게 나눈다. 한 응답이 16000자를 넘으면 앞부분만 보내고 "(길어서 줄임)" 을 붙인다.
- **FR-TGB-65** 대화가 작업 중이면 draft 빈 글(점 세 개 표시)을 보인다.

### 3.8 PC 알람 해제

- **FR-TGB-70** 토픽에서 글 입력·버튼(선택지·Esc)을 쓰면 그 탭의 알람을 `Attend(tool, typed=true)` 로 끈다.
- **FR-TGB-71** `[✓ 읽음]` 을 누르면 `Attend(tool, typed=false)` 로 끈다. 버튼을 걷고 메시지 끝에 `· 읽음` 을 붙인다.

### 3.9 hook 보고 확장

- **FR-TGB-80** `parseClaudeHook` 은 `tool_use_id` 와 `SessionStart.source` 를 보고에 싣는다.
- **FR-TGB-81** `PermissionRequest` 와 AskUserQuestion 의 `PreToolUse` 는 `tool_input` 원문을 보고에 싣는다. 상한은 16KB 다. 넘으면 원문을 싣지 않고 넘었다는 표시(`inputOver`)만 단다 — JSON 을 중간에서 자르면 깨진다. 그때 브리지는 `Detail`(512자)로 요약을 보인다. 보고에는 hook 이름(`hook`)도 싣는다.
- **FR-TGB-81a** `PermissionRequest` 에는 `tool_use_id` 가 없다(§2.2 실측). 브리지는 같은 대화의 바로 앞 `PreToolUse` 의 `tool_use_id` 를 그 요청의 것으로 본다.
- **FR-TGB-82** 이 확장은 브리지가 꺼져 있어도 실린다. 다만 서버는 브리지가 꺼져 있으면 이 값을 저장하지 않는다.

### 3.10 비기능

- **NFR-TGB-1** 꺼져 있으면 Telegram 으로 아무 요청도 보내지 않고, transcript 를 읽지 않고, 대응표를 갱신하지 않는다.
- **NFR-TGB-2** 브리지는 PC 의 Claude Code 를 막지 않는다. 막는 hook(대기·결정 반환)을 쓰지 않는다.
- **NFR-TGB-3** Telegram 은 long polling 으로 받는다. 들어오는 포트를 열지 않는다.
- **NFR-TGB-4** Telegram 이 닿지 않거나 429 를 주면 지수 백오프로 다시 시도한다. 그동안 dongminal 의 다른 기능은 영향받지 않는다.
- **NFR-TGB-5** 열린 토픽이 없으면 transcript 감시도 없다. 쉬는 대화의 비용은 0 이다.

## 4. 결정 (Decisions)

| ID | 결정 | 이유 |
|---|---|---|
| D-TGB-1 | 1:1 DM 토픽을 쓴다. 슈퍼그룹을 쓰지 않는다 | `sendMessageDraft` 가 DM 에서만 된다. 실시간 출력을 고른 사용자 결정 |
| D-TGB-2 | 토픽 단위는 `session_id` | 탭은 사용자가 옮기고 만들고 지운다. 대화가 이어졌는지는 `session_id` 가 말한다(사용자 결정) |
| D-TGB-3 | 평소에는 `/agents` 로 열고, 입력 필요 알림은 자동으로 연다 | 사용자 결정 |
| D-TGB-4 | 토픽은 사용자가 지울 때만 지운다. `/cleanup` 을 둔다 | 이어 하기에 기록이 남게. 사용자 결정 |
| D-TGB-5 | 답은 원시 키로 넣는다. 막는 hook 으로 답하지 않는다 | 막는 hook 은 PC 대화상자를 늦추거나 막는다(사용자 지적) |
| D-TGB-6 | 처리 여부는 `tool_use_id` 와 다음 보고로 판정한다 | 화면 버퍼는 TUI 의 부분 갱신 때문에 실제 화면과 다르다(§2.3·실측) |
| D-TGB-7 | 출력은 응답 글 + 도구 호출 한 줄. 도구 결과는 보내지 않는다 | 사용자 결정. 밖으로 나가는 코드가 줄어든다 |
| D-TGB-8 | 허용 계정은 짝맞춤 코드로 하나만 | 사용자 결정 |
| D-TGB-9 | 무음 시간은 설정값, 기본 5분 | 사용자 결정 |
| D-TGB-10 | 읽음 대신 `[✓ 읽음]` 버튼 | Bot API 에 읽음 신호가 없다(§2.1). 사용자 결정 |
| D-TGB-11 | 정지는 draft 의 정지 버튼이 아니라 상태 메시지의 `[Esc]` | 실측에서 정지 버튼이 보이지 않았다 |
| D-TGB-12 | 설정은 전용 파일 | 일반 설정은 모든 브라우저에 내려간다. Peers 와 같은 방식 |
| D-TGB-13 | PC 입력과 휴대폰 입력의 섞임을 막지 않는다 | 한 사람이 쓴다. PC 와 휴대폰을 동시에 쓰지 않는다(사용자 결정) |

## 5. 검증 (Verification)

| ID | 대상 | 방법 |
|---|---|---|
| TC-TGB-1 | FR-TGB-2·3 | Go: 저장 파일 권한 600, API 응답·로그에 token 문자열 없음 |
| TC-TGB-2 | FR-TGB-4·5 | Go: 가짜 Telegram 서버로 `getMe` 실패·토픽 꺼짐 거절, token 교체 시 초기화 |
| TC-TGB-10 | FR-TGB-10~13 | Go: 코드 10분·1회, 다른 `from.id` 무응답, 같은 채팅의 다른 사람 거절 |
| TC-TGB-20 | FR-TGB-20~26 | Go: `startup`→새 토픽, `resume`→같은 토픽, 탭을 바꿔 보고→현재 탭 갱신, 끝남→⏹ |
| TC-TGB-21 | FR-TGB-24 | Go: 이름 고치기 10초 상한 |
| TC-TGB-22 | FR-TGB-27·28 | Go: `/close`·`/cleanup` 은 토픽만 지움, thread not found → 다시 만듦 |
| TC-TGB-30 | FR-TGB-30·31 | Go: 글은 붙여넣기, 키는 원시 쓰기 |
| TC-TGB-31 | FR-TGB-42 | **실측**: 권한 요청·AskUserQuestion 화면에서 원시 키 순서(숫자 / 화살표+Enter)를 정한다 |
| TC-TGB-32 | FR-TGB-43·44 | Go: `PostToolUse` 뒤 버튼은 키를 넣지 않음 |
| TC-TGB-40 | FR-TGB-50~53 | Go: 토픽 없이 알림 → 토픽 생성, PC 입력 5분 안 → `disable_notification` |
| TC-TGB-50 | FR-TGB-60~62 | Go: 실측 transcript 표본에서 허용 목록 밖 줄(시스템·`api-request-*`·도구 결과)이 하나도 나가지 않음 |
| TC-TGB-51 | FR-TGB-63·64 | Go: draft 0.5초 상한, 4096자 분할, 16000자 줄임 |
| TC-TGB-60 | FR-TGB-70·71 | Go: 입력→`Attend(typed=true)`, 읽음→`Attend(typed=false)` |
| TC-TGB-70 | FR-TGB-80~82 | Go: `parseClaudeHook` 표 시험(실측 payload) |
| TC-TGB-80 | NFR-TGB-1·5 | Go: 꺼짐이면 Telegram 요청 0건·transcript 감시 0개 |
| TC-TGB-90 | 전체 | **실기기**: 테스트 봇으로 알림→버튼 답→PC 대화상자 닫힘, 글 입력, Esc, 실시간 출력, `/clear` 새 토픽 |

Telegram 은 시험에서 가짜 HTTP 서버로 바꾼다. API 주소를 주입할 수 있게 둔다.

## 6. 비목표 (Non-goals)

- 새 에이전트 띄우기. 사용자 결정이고, §2.6 의 숨은 탭 멈춤 문제도 있다
- 슈퍼그룹·여러 사용자·여러 봇
- 도구 결과·파일 내용 보내기, 파일 받기·보내기
- Mini App 화면
- 막는 hook 으로 결정 돌려주기
- 읽음 자동 판정(MTProto·유저봇)

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | **사내 규정**: 대화 내용(코드 조각)이 승인되지 않은 외부 서비스(Telegram)로 나간다. 봇이 조종하는 세션이 구독 로그인이면 "구독 계정을 봇에 연결 금지" 에 걸릴 수 있다 | HIGH | 실제 업무 세션에 쓰기 전에 정보보호팀 승인을 받는다. §8 목록을 승인 자료로 쓴다. 승인 전에는 테스트 봇과 의미 없는 대화로만 시험한다 |
| R-2 | token 유출 = PC 원격 입력 | HIGH | 허용 계정 하나, 쓰기 전용 token, 권한 600, 로그 가림. token 이 새면 BotFather 에서 폐기 |
| R-3 | transcript 형식이 Claude Code 버전마다 바뀐다 | MEDIUM | 파서 한 곳, 허용 목록 판정, 모르는 줄은 버린다 |
| R-4 | 키 순서가 Claude Code 버전마다 바뀐다 | MEDIUM | 키 표 한 곳. 처리 여부는 `tool_use_id` 로 판정하므로 틀린 키가 다른 화면에 들어갈 위험은 줄어든다 |
| R-5 | 사용자가 Telegram 에서 토픽을 지워도 알 수 없다 | LOW | FR-TGB-28 |
| R-6 | DM 토픽 생성이 Bot API 10.0 이후 실패한다는 외부 보고 | LOW | 2026-11-12 실측은 성공. 실패하면 설정 화면에 이유를 보인다 |
| R-7 | Telegram 전송 한도 | LOW | draft 0.5초, 이름 10초 상한, 429 백오프 |

## 8. 밖으로 나가는 데이터 (Telegram 서버로)

| 데이터 | 언제 |
|---|---|
| 탭 이름, 상태 | 토픽 이름, 상태 메시지 |
| 응답 글 | 열린 토픽, 작업 끝남 알림 |
| 도구 호출 한 줄(명령 첫 줄·파일 경로) | 열린 토픽 |
| 권한 요청의 도구 입력 요약 | 권한 요청 알림 |
| AskUserQuestion 의 질문·선택지 | 질문 알림 |
| 화면 끝부분(최대 3500자) | 사용자가 `[화면]` 을 누를 때만 |

나가지 않는 것: 도구 결과, 파일 내용, 시스템 프롬프트, transcript 의 내부 줄, token, 이메일.

## 9. 변경 기록

- 2026-11-12 초안. 실측(§2)과 사용자 결정(§4)을 반영했다.
- 2026-11-12 FR-TGB-33(PC 입력 중 거절)을 지웠다. D-TGB-13.
