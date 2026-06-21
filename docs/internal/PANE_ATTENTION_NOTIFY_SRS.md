# SRS: 터미널 출력 감시 기반 Pane 주의 알림 (Pane Attention Notify) — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
pane 안에서 실행 중인 **임의의 에이전트/CLI**(Claude Code, Codex, Gemini, Aider, 일반 빌드 스크립트 등)가 **작업을 끝냈거나 사용자 입력을 기다리는 상태**가 되면, 사용자가 그 pane 을 보고 있지 않아도 알아챌 수 있게 한다.

dongminal 은 이미 PTY 허브·출력 버퍼(`outbuf.Stream`)·SSE 명령 채널(`CommandHub`)·브라우저 pane/tab UI 를 갖추고 있다. 본 SRS 는 여기에 **에이전트 종류와 무관하게(zero-config)** 동작하는 알림을 더한다.

핵심 설계 원칙은 **터미널 출력 감시(terminal monitoring)** 다 — 에이전트의 협조(hook 설정)에 의존하지 않고, PTY 출력 바이트 스트림에서 (L1) 표준 알림 이스케이프 시퀀스와 (L2) 출력 정적(idle) 을 관찰해 "이 pane 이 주의가 필요하다"를 추론한다. 이 방식은 cmux 가 OSC 9/99/777 감시로 에이전트 무관 알림을 구현하는 것과 동일한 토대다.

### 1.2 범위 (Scope)
- `internal/server/pane.go` — `Pane` 에 출력 활동 타임스탬프(`lastOutputAt`)·주의 상태(`attention`) 보관, `readPTY` 핫패스에 **관찰 전용** 알림 시퀀스 감지 + 출력시각 갱신, `onAttention` 콜백. 입력 수신 시 주의 해제.
- `internal/server/attention.go` (신규) — 알림 시퀀스 감지기(`detectAttentionSignal`)와 경계분할 carry 처리, 순수 함수로 분리(테스트 용이).
- `internal/server/pane.go`(PaneManager) — idle 감지 sweeper goroutine(주기 tick, working→idle 에지에서 1회 발화), 주입 가능한 clock/임계값.
- `internal/server/commands.go` / `server.go` / `deps.go` / `handlers_api.go` — `pane_attention`·`pane_attention_clear` SSE 이벤트 발행 경로, 현재 주의 상태 조회용 `GET /api/panes/attention`, 포커스 해제용 `POST /api/panes/attention/clear`.
- `web/app.js` — SSE 핸들러에 두 이벤트 분기, pane→tab 매핑(`tab.paneId`)으로 tab/region 에 알림 강조, 포커스 시 해제(로컬+엔드포인트), **주의 pane 모아보기(notification center) 팝오버 + 클릭 점프**, 데스크톱 알림(Web Notification)·탭 제목/파비콘 배지·사운드(선택), 설정 토글.
- `web/style.css` — 포커스(`.focused`/`.active`)와 **구분되는** 알림 강조 클래스(`.rt.attn`, `.rg.attn`)와 `--attn` 색 토큰.
- 테스트(Go unit + playwright e2e)·문서(`docs/external/features.md`).

### 1.3 정의 (Definitions)
- **주의(attention)**: "이 pane 이 사용자의 시선을 필요로 한다"는 **단일 의미** 상태. 터미널 감시만으로는 *작업 완료* 와 *입력 대기* 를 신뢰성 있게 구분할 수 없으므로(둘 다 "출력이 멎음/벨"로 나타남) 본 SRS 는 둘을 합친 단일 상태로 다룬다. 세분 분류는 비목표(§5, L3 hook)다.
- **L1 신호 (signaled)**: PTY 출력에 나타난 표준 알림 이스케이프 시퀀스. 대상:
  - `OSC 9` — `ESC ] 9 ; <text> (BEL|ST)` (iTerm2/데스크톱 알림 관례)
  - `OSC 777;notify` — `ESC ] 777 ; notify ; <title> ; <body> (BEL|ST)`
  - `OSC 99` — `ESC ] 99 ; <meta> ; <payload> (BEL|ST)` (kitty 데스크톱 알림)
  - `BEL` — 단독 터미널 벨(0x07, OSC/DCS 종료자가 아닌 것). 노이즈(탭 자동완성 등) 때문에 **기본 비활성**, 설정으로 활성.
  - `ST` = `ESC \` (0x1b 0x5c).
- **L2 신호 (idle)**: pane 이 **활동(working)** 후 `idleThreshold` 동안 출력이 멎은 working→idle 에지. 활동 이력이 없는(처음부터 조용한) pane 은 발화하지 않는다.
- **armed**: 출력이 들어와 idle 발화 후보가 된 상태. 출력 수신 시 set, idle 1회 발화 시 clear, 새 출력 수신 시 re-arm. 연속 출력은 계속 re-arm 되어 발화하지 않는다.
- **carry**: OSC 시퀀스가 8192바이트 read 경계에 걸쳐 분할될 때, 다음 read 와 이어 붙여 감지하기 위해 보관하는 미완결 OSC 조각(상한 있는 소량 바이트).
- **해제(clear)**: 주의 상태를 끄는 전이. 트리거 — (a) 백엔드: 해당 pane 에 사용자 입력이 들어옴(WS 입력 write 경로, 에이전트 무관·관찰 가능), (b) 프론트: 사용자가 해당 tab 을 포커스/활성화(시각 즉시 해제).

### 1.4 참고 (References)
- `internal/outbuf/stream.go` — `Stream.Feed`(46), 비블로킹 단일 drop 경로. 본 SRS 는 Stream 을 변경하지 않고 `readPTY`(pane.go:219)에서 관찰한다.
- `internal/server/pane.go` — `Pane`(100), `readPTY`(219), `broadcast`(252), `PaneManager`(~371), `onExit`/`invalidator` 콜백 주입 패턴(본 SRS 의 `onAttention` 도 동일 패턴).
- `internal/server/codeserver.go` — `stripOSC777`(42)/`osc777Pattern`(37): 기존 OSC 처리(replay 시 777 제거)와 충돌하지 않음(§3.3 DC-PAN-4).
- `internal/server/commands.go` — `CommandHub.Broadcast`(155), `handleCommandSSE`(233), `allowedCmdActions`(170). 본 SRS 는 SSE 발행 경로를 재사용한다.
- `web/app.js` — `_subscribeCommands`/`es.onmessage`(~1448), `Renderer._buildRg`(~1183), `applyThemeObj`(~327), tab 모델(`tab.paneId`).
- `web/style.css` — `.rg.focused`(89), `.rt.active`(105), 테마 CSS 변수(`:root` 3–13).
- `REMOTE_COMMAND_RESULT_SRS.md` — 단일 활성 클라이언트 가정(NFR-RCR-3)과 동일 가정 채택.

### 1.5 개요
2장 현황, 3장 요구사항(기능/비기능/제약), 4장 검증, 5장 비목표, 6장 의존·후속.

---

## 2. 현황 (Identified Issues)

### 2.1 PAN-1 — 백그라운드 pane 의 에이전트 상태를 알 수 없음
- **원인**: pane 출력은 WS 로 xterm 에 흐를 뿐, 서버·UI 어디에도 "이 pane 이 주의가 필요한가"라는 상태 개념이 없다. `Pane` 구조체에 상태 필드 자체가 없고(`exited`/`restored` bool 뿐), 프론트에도 알림 코드가 전무하다(`Notification`/`document.title`/사운드/파비콘 미사용).
- **현상**: 분할/탭 다중 운용 중 비활성 tab 에서 에이전트가 작업을 끝내거나 질문을 던져도, 사용자가 그 tab 을 직접 열어보기 전엔 모른다.
- **영향**: 멀티 에이전트 운용 시 유휴 대기·놓친 질문으로 처리 지연.

### 2.2 PAN-2 — 에이전트마다 알림 방식이 제각각
- Claude Code 는 `Stop`/`Notification` hook, Codex 는 `notify`/`[tui].notifications`, 그 외는 벨 정도로 알림 메커니즘이 상이하다. hook 어댑터를 에이전트별로 따라가면 미지원 에이전트엔 알림이 없다.
- **결론**: 에이전트 협조에 의존하지 않는 **출력 감시(터미널 레벨)** 가 범용 토대로 적합하다(L1+L2). 정확도를 끌어올리는 에이전트별 hook 브리지(L3)는 후속(§5).

### 2.3 PAN-3 — Claude Code 는 기본적으로 L1/L2 로 감지되지 않음 (검증 결과)
- **사실(조사 확인)**: Claude Code `preferredNotifChannel` 기본값(`auto`)은 **일반 xterm(iTerm2/kitty/ghostty 아님)에서 PTY 로 아무 알림 바이트도 내보내지 않는다.** 또한 응답 대기 중에도 TUI(상태줄/스피너)를 다시 그려 출력이 멎지 않을 수 있어 **L2 idle 로도 안 잡힌다.**
- **cmux 의 실제 방식(검증)**: cmux 는 Claude Code 를 **패시브 감시로 잡지 않는다.** `claude` 를 래퍼로 감싸 **Claude Code hook(`Stop`/`Notification`/`UserPromptSubmit` 등)을 주입**해 유닉스 소켓으로 신호받고, 오히려 `preferredNotifChannel: notifications_disabled` 로 Claude 의 터미널 알림을 끈다. 즉 Claude Code 감지는 **hook 브리지(L3) 전용**이다. 패시브 OSC 9/777 감시는 *그 시퀀스를 실제로 내보내는 다른 프로그램*용 보조다.
- **귀결**: 본 SRS 의 L1+L2 만으로는 Claude Code 의 "인사 후 완료/대기"를 감지할 수 없다.
- **채택(사용자 결정)**: **L3 — 투명 래퍼**(cmux 와 동일 원리). 사용자가 에이전트 설정 파일을 직접 건드리지 않고, dongminal 이 pane 셸에서 에이전트를 **per-invocation 으로 감싸** 알림 hook 을 주입한다. 주입된 hook 은 `dmctl notify` 를 호출하고, `dmctl notify` 는 pane 의 `/dev/tty` 로 OSC 777;notify 를 emit → **기존 L1 감지(§FR-PAN-2)가 그대로 잡는다**(서버 왕복·pane 해석 불필요, OSC 가 해당 pane PTY 로 자연 라우팅). 해제는 기존 입력/포커스 경로(FR-PAN-6/11)가 처리. 범위: claude(검증)·codex. gemini 는 hook 이 영속 설정(`gemini hooks add`)이라 per-invocation 투명 주입이 불가 → 제외(패시브 L2 로 커버). → FR-PAN-18/19.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-PAN-1** | `Pane` 은 마지막 PTY 출력 시각(`lastOutputAt`)과 현재 주의 상태(`attention bool`)를 보관한다. `readPTY` 의 매 read 에서 `lastOutputAt` 을 갱신한다(원자적, 핫패스 최소 비용). | 필수 |
| **FR-PAN-2** | `readPTY` 는 매 read 의 바이트(직전 carry 와 이어 붙임)에서 L1 신호(`OSC 9`/`OSC 777;notify`/`OSC 99`, 설정 시 `BEL`)를 **관찰 전용**으로 감지한다. 감지되면 주의 상태를 set 하고 `onAttention(paneID, "signaled")` 를 호출한다. 라이브 출력 바이트는 절대 변형/소비하지 않는다(xterm 으로 가는 스트림 무변경). | 필수 |
| **FR-PAN-3** | L1 감지는 read 경계에 걸친 분할 시퀀스를 위해 상한 있는 `carry` 를 유지한다. 미완결 OSC 조각만 보관하고(상한 초과 시 폐기), 다음 read 와 이어 감지한다. 감지 로직은 순수 함수(`detectAttentionSignal`)로 분리해 단위 테스트한다. | 필수 |
| **FR-PAN-4** | `PaneManager` 는 주기 tick sweeper goroutine 으로 L2(idle) 를 감지한다. 각 pane 이 **armed** 이고 `now - lastOutputAt >= idleThreshold` 이며 **포그라운드 프로세스(자식 프로세스)가 떠 있을 때만**(`IsBusy`) 주의 상태 set + `onAttention(paneID, "idle")` 를 **1회** 발화하고 disarm 한다. 출력 수신 시 re-arm 한다. 처음부터 조용한(활동 이력 없는) pane, **빈 셸 프롬프트(에이전트 미실행)** 는 발화하지 않는다 — 데몬 재시작 시 복원된 셸들의 일괄 오탐 방지. `idleThreshold == 0` 이면 L2 비활성. `IsBusy` 는 발화 후보 시점에만 1회 호출(틱마다 전수 호출 아님). | 필수 |
| **FR-PAN-5** | 이미 주의 상태인 pane 에 동일 신호가 반복돼도 `onAttention` 은 **에지에서 한 번만**(none→attention 전이 시) 발행한다. 중복 SSE 폭주 방지. | 필수 |
| **FR-PAN-6** | 주의 해제는 **사용자가 그 pane 에 포커스/접근했을 때**(프론트 FR-PAN-11 → clear 엔드포인트 FR-PAN-15)만 일어난다. 백엔드는 `attend()` — idle armed 해제(disarm) + 주의 clear — 를 수행하고 상태가 켜져 있었던 경우에만 `onAttentionClear(paneID)` 를 발행한다. **raw WS 입력(OpInput)으로는 해제하지 않는다** — 에이전트 TUI 의 터미널 쿼리(커서위치/장치속성 보고 등)에 대한 xterm 의 자동 응답이 OpInput 으로 되돌아와, 방금 올라온 알람을 오인 해제하기 때문이다(실측 버그). | 필수 |
| **FR-PAN-7** | 서버는 `onAttention`/`onAttentionClear` 를 `CommandHub.Broadcast` 로 중계한다. 페이로드: 발생 `{ "action":"pane_attention", "args":{ "paneId":"…", "reason":"signaled"\|"idle" } }`, 해제 `{ "action":"pane_attention_clear", "args":{ "paneId":"…" } }`. 두 action 을 `allowedCmdActions` 가 아닌 **서버 발행 전용**으로 처리한다(원격 명령 입력으로 수용하지 않음; `md_scroll_changed` 와 동일 취급). | 필수 |
| **FR-PAN-8** | `GET /api/panes/attention` 은 현재 주의 상태인 pane id 집합 `{ "paneIds":[…] }` 을 반환한다(SSE 가 broadcast-only 라 늦게 합류한 클라이언트가 초기 상태를 복원하기 위함). | 필수 |
| **FR-PAN-9** | 프론트는 SSE `pane_attention` 수신 시 `args.paneId == tab.paneId` 인 tab 을 찾아 **알림 강조**한다. 그 tab 이 비활성이면 tab 에, 그 tab 이 속한 region 의 활성 tab 이 주의 상태면 region 에도 강조를 적용한다. **단, 그 pane 이 현재 포커스된 region 의 활성 tab 이면**(사용자가 이미 보고 있음) 시각 강조를 적용하지 않는다. | 필수 |
| **FR-PAN-10** | 알림 강조는 포커스 강조와 **시각적으로 구분**되어야 한다. `--attn` 은 **팔레트(테마 terminal 색) 중 `accent`(포커스)와 RGB 거리가 최대인 색**(yellow/magenta/cyan/green 후보, danger=red 제외)을 `applyThemeObj` 에서 자동 선택한다 — accent 가 노랑/주황인 테마(Cobalt²·Gruvbox 등)에서도 포커스색과 겹치지 않게. **색을 하드코딩하지 않는다**(`:root` 폴백 1회만). 가시성을 위해 **굵은 실선 테두리 + 글로우**로 강조. CSS 클래스 `.rt.attn`/`.rg.attn`. | 필수 |
| **FR-PAN-11** | 프론트는 사용자가 알림 강조된 tab 을 포커스/활성화하면 (a) 그 tab 의 강조·알림 목록 항목을 **즉시(로컬) 제거**하고, (b) `POST /api/panes/attention/clear {paneId}` 로 백엔드 상태도 해제한다(타이핑 없이 포커스만 해도 해제, 다른 브라우저에도 전파). 백엔드 입력 경로 해제(FR-PAN-6)와 독립. | 필수 |
| **FR-PAN-15** | 신규 `POST /api/panes/attention/clear` (`apiPaneAttentionClear`): body `{paneId}` 의 pane 주의를 해제하고(에지면 `pane_attention_clear` 발행), 미지/비-attention pane 은 200 no-op. `paneId` 누락은 400. | 필수 |
| **FR-PAN-16** | 프론트는 현재 주의 상태인 pane 들을 **한 곳에 모아 보여주는 알림 목록(notification center)** 을 제공한다(상단 🔔 배지 클릭으로 열리는 팝오버). 각 항목은 pane/tab 이름과 사유(signaled/idle)를 보이고, **클릭하면 그 pane(다른 세션이면 세션 전환 포함)으로 포커스 이동** → FR-PAN-11 경로로 해당 항목·강조가 자동 제거된다. 또한 **사이드바 세션 항목에 알람 표시**(`.si.attn`)를 더해 어느 세션에 알람이 있는지 비활성 세션에서도 구분되게 한다. 주의 pane 이 없으면 목록·배지·세션표시가 사라진다. | 필수 |
| **FR-PAN-17** | notification center 에 **모두 제거(일괄 해제)** 버튼을 둔다. `POST /api/panes/attention/clear-all` → 모든 주의 pane 을 `attend()`(disarm+clear)하고 해제 개수를 반환. 프론트는 로컬 집합도 비우고 갱신. | 필수 |
| **FR-PAN-18** | `dmctl notify [label]` (runtimebin) — 호출한 pane 을 `DONGMINAL_PANE_ID` 환경변수로 식별해 서버 `POST /api/panes/attention/set {paneId, reason=label}` 로 알린다. **제어 터미널이 없는 detached 환경(에이전트 hook)에서도 동작**한다(`/dev/tty` 직접 쓰기는 hook 에서 ENXIO 로 실패하므로 사용하지 않는다). `DONGMINAL_PANE_ID` 는 `StartPane` 이 pane 셸 env 에 주입(자식 프로세스 상속). label 은 제어문자 제거 후 길이 제한. 서버 set 핸들러는 `pane.setAttention(reason)`(에지 발행) — 미지 pane 200 no-op, paneId 누락 400. | 필수 |
| **FR-PAN-19** | dongminal 이 주입하는 셸 훅(zsh `zdotdir/.zshrc`, bash `bash-hook.sh`)에 **에이전트 투명 래퍼** 셸 함수를 둔다. `claude` → `command claude --settings "$DONGMINAL_HOME/bin/agent-hooks/claude.json" "$@"`(파일 없으면 그대로 실행). `codex` → `command codex -c "notify=[\"$DONGMINAL_HOME/bin/dmctl\",...]" "$@"`. **에이전트 설정 파일을 영구 수정하지 않으며 dongminal pane 안에서만 적용**(per-invocation). `command` 로 실제 바이너리를 호출해 재귀 방지. **dmctl 호출은 절대경로**(`$DONGMINAL_HOME/bin/dmctl`)로 — PATH 앞쪽의 stale dmctl(구버전, `notify` 미지원)을 회피한다. `claude.json` 은 `runtime.Install` 이 dmctl 절대경로 hook(`Stop`→`… notify done`, `Notification`→`… notify waiting`)으로 **생성**한다(유효 JSON). | 필수 |
| **FR-PAN-12** | 프론트는 합류 시(또는 SSE 재연결 시) `GET /api/panes/attention` 으로 현재 주의 집합을 받아 강조를 복원한다. | 필수 |
| **FR-PAN-13** | 프론트는 페이지가 백그라운드/다른 앱일 때를 대비해 **추가 알림 채널**을 제공한다: (a) **데스크톱 알림(Web Notification API)** — **기본 ON**, 권한이 `default` 면 사용자의 **첫 상호작용(pointerdown/keydown)에서 1회 권한 요청**(브라우저 제스처 정책 충족), 사유(done/waiting/idle)별 본문. (b) 브라우저 탭 제목에 주의 pane 개수 배지. (c) 사운드 큐(기본 off). 시각 강조=항상. | 필수 |
| **FR-PAN-14** | 설정 모달에 알림 섹션을 추가한다: 데스크톱 알림 토글(+권한 요청), 사운드 토글. 설정은 기존 settings 영속화 방식에 따른다. idle 임계값은 프론트 설정이 아니라 백엔드 env/상수(§NFR-PAN-4)로 둔다(프론트→백엔드 추가 배관 회피). | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-PAN-1 | **핫패스 보존** — `readPTY` 의 추가 처리는 O(n) 저비용이어야 한다. 신호 부재가 흔한 경우를 위해 `bytes.IndexByte`(ESC/BEL 선검사) 후 부재 시 즉시 반환한다. `Stream.Feed`·`broadcast` 의 기존 동작·성능 특성(비블로킹, 단일 drop 경로)을 변경하지 않는다. |
| NFR-PAN-2 | **관찰 전용** — 라이브 PTY→xterm 출력 바이트를 한 바이트도 변형/제거하지 않는다. L1 감지는 사본/스캔만 한다. 터미널 표시 동작 무변경(xterm 은 미지 OSC 9/99/777 을 무시). |
| NFR-PAN-3 | **에지 발행** — `onAttention` 은 none→attention 전이에서만, `onAttentionClear` 는 attention→none 전이에서만 발행(중복 SSE 억제). SSE 부하는 상태 변화 횟수에 비례. |
| NFR-PAN-4 | **idle 오탐 억제** — L2 는 working→idle 에지에서만, armed 인 pane 에만 발화. 단독 `BEL` 은 노이즈가 커 기본 비활성. idle 임계값은 named 상수 기본값 + 환경변수(`DONGMINAL_ATTENTION_IDLE_MS`) + 설정으로 조정(하드코딩 금지). 기본값은 에이전트 사고 일시정지를 오탐하지 않는 보수적 값(수 초~십수 초). |
| NFR-PAN-5 | **색 분리·테마 연동** — `--attn` 은 `--accent`(포커스)·`--danger`(닫기)와 명확히 구분. 테마 토큰 미정의 시 폴백 상수 사용. 21종 테마와 충돌 없이 가독. |
| NFR-PAN-6 | **결정성·테스트성** — 감지 함수는 순수 함수, sweeper 는 주입 가능한 clock/임계값/probe(기존 `paneBusyProbe` 와 동일한 패키지 변수 주입 패턴)로 시간 의존 없이 테스트한다. `go test -race ./...` 그린. |
| NFR-PAN-7 | **단일 활성 클라이언트 가정** — 다중 브라우저 동시 접속 시 강조/해제 일관성은 `REMOTE_COMMAND_RESULT_SRS` NFR-RCR-3 와 동일 가정(첫 클라이언트 기준, 나머지는 SSE 로 수렴)으로 처리. 완전 동기화는 비목표. |
| NFR-PAN-8 | **누수 없음** — sweeper goroutine 은 서버 수명과 함께 종료, pane 종료(`kill`) 시 상태 정리. goroutine/타이머 누수 없음. |
| NFR-PAN-9 | **알림 UI 갱신은 전체 render() 를 호출하지 않는다** — `pane_attention`/`clear` 수신 시 `.attn` 클래스를 **타깃 토글**(탭은 `data-pid`, 리전은 `data-rid`)하고 배지/제목/센터/세션표시만 갱신한다. 전체 render() 는 xterm 요소를 DOM 에서 이동시켜 **blur→refocus 플리커**(포커스가 그 터미널로 튀었다 돌아오는 현상)를 유발하므로 알림 경로에서 금지. 포커스/레이아웃이 실제로 바뀌는 경로(`_jumpToPane`, switchTab 등)만 render() 한다. |
| NFR-PAN-10 | **억제는 "실제로 보고 있을 때"만** — 포커스+활성 pane 이라도 **브라우저 창이 OS 포커스를 잃은 경우(`document.hasFocus()===false`, 즉 사용자가 다른 프로그램을 보는 중)** 알람을 살린다(데스크톱 알림 가치). 브라우저가 포커스를 가졌고 그 pane 에 포커스가 있을 때만 즉시 해제. 브라우저로 복귀(`window` focus) 시 지금 보고 있는 pane 의 알람은 해제. (`document.hidden` 은 탭 전환/최소화만 잡고 "다른 앱이 위에 있음"은 못 잡으므로 `hasFocus()` 사용.) |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-PAN-1 | 알림 이벤트 전송은 신규 transport 를 추가하지 않고 기존 `CommandHub.Broadcast`(SSE) 를 재사용한다. 터미널 I/O 용 binary WS 는 사용하지 않는다. |
| DC-PAN-2 | 백엔드→상위 통지는 기존 콜백 주입 패턴(`onExit`/`invalidator`)과 동일하게 `Pane.onAttention`/`onAttentionClear` 콜백으로 구성한다(서버가 주입). |
| DC-PAN-3 | L1 감지(`readPTY` 내)와 L2 sweeper(`PaneManager`)는 분리한다. 감지 코어는 `attention.go` 순수 함수. JSON 키는 lowerCamelCase. |
| DC-PAN-4 | 기존 `stripOSC777`(replay 시 777 제거)과 충돌하지 않는다 — 본 SRS 는 라이브 read 에서만 관찰하고 어떤 OSC 도 새로 제거하지 않으며, snapshot replay 경로(WS)는 감지기를 거치지 않아 재접속 시 알림이 재발화하지 않는다. |
| DC-PAN-5 | TypeScript/JS·Go 양쪽 모두 기존 코드 스타일을 따르고, 상수 하드코딩 금지(임계값·색 폴백·tick 주기 등 named). 요청 전 주석 추가 금지. |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-PAN-1** (Go) | `detectAttentionSignal` 에 `ESC]9;done\a` 단일 청크 | signaled=true |
| **TC-PAN-2** (Go) | `ESC]777;notify;Title;Body\a` | signaled=true |
| **TC-PAN-3** (Go) | `ESC]99;;msg\x1b\\`(ST 종료) | signaled=true |
| **TC-PAN-4** (Go) | 일반 텍스트/ANSI 색(`ESC[31m` 등), 신호 없음 | signaled=false |
| **TC-PAN-5** (Go) | OSC 9 가 두 청크로 분할(`ESC]9;par`+`tial\a`) — carry 사용 | 두 번째 청크에서 signaled=true |
| **TC-PAN-6** (Go) | 단독 `BEL`(0x07): 설정 off | signaled=false / 설정 on → true. OSC 종료자 BEL 은 단독 벨로 오인하지 않음 |
| **TC-PAN-7** (Go) | carry 상한 초과(종료자 없이 과대 OSC) | carry 폐기, 패닉/무한증가 없음 |
| **TC-PAN-8** (Go) | sweeper: armed pane, clock 을 임계값+1 진행 | `onAttention(_, "idle")` 정확히 1회, 이후 추가 발화 없음(disarm) |
| **TC-PAN-9** (Go) | sweeper: idle 발화 후 출력 수신(re-arm) → 다시 임계값 경과 | 재발화 1회 |
| **TC-PAN-10** (Go) | sweeper: 활동 이력 없는(armed=false) pane | 발화 없음 |
| **TC-PAN-11** (Go) | 동일 pane 에 신호 반복(이미 attention) | `onAttention` 에지 1회만(중복 없음) |
| **TC-PAN-12** (Go) | attention 상태에서 입력 write | clear + `onAttentionClear` 1회, 비-attention 상태 입력은 no-op |
| **TC-PAN-13** (Go) | `GET /api/panes/attention` | 현재 주의 pane id 집합 정확 반환 |
| **TC-PAN-13b** (Go) | `POST /api/panes/attention/clear` — known/unknown/missing | known→해제+clear 발행, unknown→200 no-op, paneId 누락→400 |
| **TC-PAN-14** (Go) | pane `kill` 시 상태/sweeper 정리 | 누수 없음, `-race` 그린 |
| **TC-PAN-15** (e2e) | 비활성 tab pane 에 OSC 9 주입 → SSE `pane_attention` | 해당 tab 에 `.attn` 강조, 색이 `.active`/`.focused` 와 다름 |
| **TC-PAN-16** (e2e) | 강조된 tab 을 클릭 포커스 | `.attn` 즉시 해제 |
| **TC-PAN-17** (e2e) | 현재 포커스+활성 tab pane 에 신호 | 시각 강조 미적용(이미 보는 중) |
| **TC-PAN-18** (e2e) | 주의 pane 2개 | 탭 제목 배지가 개수 반영, 해제 시 감소/복원 |
| **TC-PAN-19** (e2e) | 데스크톱 알림 설정 on + 권한 granted(목) | `Notification` 생성 호출됨(같은 paneId tag 로 중복 억제) |
| **TC-PAN-20** (e2e) | SSE 재연결 후 `GET /api/panes/attention` 복원 | 기존 주의 강조 재현 |
| **TC-PAN-21** (e2e) | 주의 pane 2개 → notification center 열기 | 두 항목(이름+사유) 표시, 배지 개수 일치 |
| **TC-PAN-22** (e2e) | center 항목 클릭 | 해당 pane 으로 포커스 이동 + 항목·강조 제거 + `POST .../attention/clear` 호출 |

### 4.2 완료 조건 (DoD)
- [ ] `attention.go` 순수 감지기(`detectAttentionSignal` + carry) + TC-PAN-1~7.
- [ ] `Pane` 상태 필드(`lastOutputAt`/`attention`) + `readPTY` 관찰 감지 + 입력 해제 + 콜백.
- [ ] `PaneManager` idle sweeper(주입 clock/임계값) + TC-PAN-8~11,14.
- [ ] SSE 발행(`pane_attention`/`pane_attention_clear`) + `GET /api/panes/attention` + `POST /api/panes/attention/clear` + TC-PAN-12,13,13b.
- [ ] web: SSE 분기, pane→tab 매핑 강조(포커스 구분), 포커스 해제(로컬+엔드포인트), 상태 복원, notification center(모아보기+점프), 데스크톱 알림/제목 배지/사운드, 설정 섹션 + TC-PAN-15~22.
- [ ] `--attn` 색 토큰·`.attn` CSS, 포커스/위험과 시각 구분 확인.
- [ ] `go test -race ./...` 그린, playwright 그린.
- [ ] `docs/external/features.md` 에 알림 기능·설정·동작(터미널 감시 기반, 에이전트 무관) 문서화.
- [ ] 신규 코드에 TODO 없음, 미사용 import 없음, 스펙 외 동작 없음.

---

## 5. 비목표 (Non-goals)
- **에이전트 설정 파일의 영구 수정** — 사용자의 `~/.claude/settings.json`·`~/.codex/config.toml`·`gemini hooks add` 등을 영구 변경하지 않는다. L3 래퍼는 **per-invocation 주입**만 한다(FR-PAN-19).
- **gemini 투명 래핑** — gemini hook 은 영속 설정(`gemini hooks add`)이라 per-invocation 투명 주입 불가 → 제외. gemini 는 패시브 L2(busy-idle)로만 커버.
- **완료/입력대기 의미의 정밀 분류** — L3 hook 은 `done`/`waiting` 라벨을 보내지만 OSC 경로에서 단일 "주의(signaled)" 로 수렴한다. 라벨별 분리 표시는 후속.
- **다중 브라우저 완전 동기화** — NFR-PAN-7 가정으로 회피.
- **알림 히스토리(해제된 과거 알림 보관/타임라인), "다음 주의 pane 으로 점프" 단축키** — 본 SRS 의 notification center(FR-PAN-16)는 *현재* 주의 pane 만 모아 보이고 클릭 점프를 제공한다. 과거 이력 보관·키보드 점프는 후속(§6).
- **OS 데스크톱 알림을 서버(osascript/notify-send)에서 발행** — 본 SRS 는 브라우저 채널 중심(원격 접속 사용자에게도 동작). 서버측 OS 알림·웹훅(Slack/Discord)은 후속.
- `outbuf.Stream` 구조/정책 변경.

---

## 6. 의존 / 후속
- 의존: `CommandHub`(SSE broadcast), `Pane`/`PaneManager` 콜백 주입 패턴, web SSE 구독·테마 토큰·tab 모델(`tab.paneId`).
- 후속:
  - **L3 hook 브리지 SRS** — pane 내 에이전트가 `dmctl notify --state=done|waiting` 로 명시 신호를 보내 정확 분류. 본 SRS 의 SSE/상태 모델을 그대로 재사용(`reason` 확장).
  - 서버측 OS 알림/웹훅(자리 비움 대비 모바일 푸시).
  - 알림 센터·점프 단축키.
