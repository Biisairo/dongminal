# SRS: 에이전트 활동 모아보기 패널 (Agent Activity Panel) — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
dongminal 위에서 동시에 돌아가는 여러 에이전트(Claude Code, Codex, 그 외 CLI)가 **지금 무엇을 하고 있는지**를 — 실제 터미널(xterm) 화면을 일일이 열어보지 않고 — **한 곳에 모아 보는** 우측 패널을 제공한다. 각 에이전트는 "현재 이 순간" 상태(작업 중/완료/대기)와 무슨 일을 하는지(툴·명령어·파일)를 카드 한 장으로 요약하며, 카드를 클릭하면 그 에이전트가 도는 pane 으로 포커스를 이동한다.

본 SRS 는 `PANE_ATTENTION_NOTIFY_SRS`(이하 ATTENTION SRS)가 구축한 알림 인프라 — `dmctl notify`/`DONGMINAL_PANE_ID` 식별, `CommandHub.Broadcast`(SSE) 발행, 에이전트 투명 래퍼(per-invocation hook 주입), 프론트 `_jumpToPane`/`_findPaneLocation` — 위에 **"주의(attention)"와 직교하는 새 레이어인 "활동(activity)"** 을 더한다. attention 이 "사용자 시선이 필요한가"라는 이벤트라면, activity 는 "지금 무슨 작업을 하는가"라는 **상태**다.

### 1.2 범위 (Scope)
- `internal/server/pane.go` — `Pane` 에 현재 활동 상태(`activity`: state/tool/detail/updatedAt) 보관 + 갱신/조회 메서드, `onActivity` 콜백. attention 상태/핫패스(`readPTY`)는 변경하지 않는다.
- `internal/server/pane.go`(PaneManager) — `onActivity` 콜백 주입(`SetActivityNotifier`, 기존 `SetAttentionNotifier` 와 동일 패턴), 전체 활동 스냅샷 조회(`ActivitySnapshot`), pane 종료 시 정리.
- `internal/server/handlers_api.go` — `POST /api/panes/activity/set`(에이전트 신호 수신), `GET /api/panes/activity`(현재 활동 스냅샷 복원).
- `internal/server/commands.go` / `server.go` / `deps.go` — `pane_activity` SSE 이벤트 발행 경로(서버 발행 전용, `allowedCmdActions` 아님).
- `internal/runtimebin/dmctl_activity.go`(신규) — `dmctl activity <agent>` 서브커맨드. **stdin 으로 들어온 에이전트 hook JSON 을 파싱**해 state/tool/detail 을 뽑아 `POST /api/panes/activity/set` 한다. `dmctl notify`(attention)와 분리.
- `internal/runtime/install.go` — `claude.json` 에 `PreToolUse`/`Stop`/`Notification` activity hook 추가(기존 attention `notify` hook 은 유지). codex 래퍼는 기존 `-c notify` 를 activity 로도 라우팅.
- `web/index.html` / `web/app.js` / `web/style.css` — 우측 접이식 활동 패널(`#agents-panel` + `#agents-handle`), topbar 토글 버튼(Split V 옆), 카드 렌더, SSE `pane_activity` 핸들러, 합류/재연결 시 스냅샷 복원, 카드 클릭 → `_jumpToPane`, **카드에 attention 알람 합성 표시(`.attn` 재사용)**, 패널 열림/너비 영속.
- 테스트(Go unit + playwright e2e)·문서(`docs/external/features.md`).

### 1.3 정의 (Definitions)
- **활동(activity)**: 한 pane 에서 도는 에이전트의 **현재 상태 스냅샷**. attention(주의)과 독립이며 자동 해제 개념이 없다 — 다음 상태가 이전 상태를 **덮어쓴다**(pane 당 최신 1개만 보관, 히스토리 없음).
- **state**: `working`(작업/툴 실행 중) | `done`(턴 완료) | `waiting`(입력·권한 대기) | `idle`(출력이 멎음, 명시 신호 없는 에이전트의 추정) 중 하나.
- **tool**: 실행 중인 작업의 종류 라벨(예: `Bash`, `Edit`, `Read`). 명시 신호가 있는 에이전트(claude)에서만 채워지며, 그 외는 비어 있을 수 있다.
- **detail**: 작업의 핵심 인자 **원문**(예: Bash 명령어 `npm test`, 편집 파일 경로). 마스킹하지 않는다(§5). 제어문자 제거 + 길이 상한만 적용.
- **명시 신호 에이전트**: hook/notify 로 활동을 능동 보고하는 에이전트. claude(PreToolUse/Stop/Notification), codex(turn-complete).
- **추정 활동 에이전트**: 투명 주입이 불가한 에이전트(gemini, pi 등). 명시 신호가 없어 출력 활동(ATTENTION SRS 의 `lastOutputAt`/armed/idle)으로 `working`/`idle` 만 best-effort 추정.

### 1.4 참고 (References)
- `PANE_ATTENTION_NOTIFY_SRS.md` — 본 SRS 가 재사용하는 토대. 특히 FR-PAN-7(SSE 발행, 서버 발행 전용 취급), FR-PAN-18(`dmctl notify`/`DONGMINAL_PANE_ID`/set 핸들러), FR-PAN-19(에이전트 투명 래퍼), FR-PAN-16(notification center·카드 클릭 점프), NFR-PAN-9(전체 render 회피·타깃 토글).
- `internal/server/pane.go` — `Pane`(101), `signalAttention`(345)/`attend`(369)(activity 도 동일한 atomic/콜백 패턴), `SetAttentionNotifier`(537)/`attnHooks`(545), `AttentionIDs`(588)/`ClearAllAttention`(603).
- `internal/server/handlers_api.go` — `apiPanesAttention`(271)/`apiPaneAttentionSet`(287)(activity set/snapshot 핸들러의 본).
- `internal/server/commands.go` — `allowedCmdActions`(170), `CommandHub.Broadcast`(중계). `pane_activity` 는 `md_scroll_changed`/`pane_attention` 과 동일하게 **서버 발행 전용**.
- `internal/runtimebin/dmctl_notify.go` — `runDmctlNotify`(21)/`sanitizeNotifyLabel`(56). `dmctl activity` 는 이 구조를 따르되 stdin JSON 파싱을 더한다.
- `internal/runtime/install.go` — `installAgentHooks`(63): `claude.json` 생성. 본 SRS 가 hook 이벤트를 추가한다.
- `internal/runtime/shellhooks/zdotdir/.zshrc`(14)·`bash-hook.sh`(6) — `claude`/`codex` 투명 래퍼.
- `web/app.js` — `es.onmessage` SSE 분기(1480~), `_jumpToPane`(1922)/`_findPaneLocation`, `_attnRefresh`(1932)(타깃 토글 갱신 패턴), `Renderer`(split-h/v 핸들러 989~).
- `web/index.html` — `#sidebar`/`#settings-btn`(좌측), `#topbar`(`#split-h`/`#split-v`), `#sb-handle`(리사이즈 핸들 패턴), `#attn-center`.
- `web/style.css` — `#app`(flex row, 15), `#sidebar`(18)/`#sb-handle`(54), `.si`(28)/`.si.attn`(141), `#attn-center`(73), CSS 변수(`:root`).

### 1.5 개요
2장 현황, 3장 요구사항(기능/비기능/제약), 4장 검증, 5장 비목표, 6장 의존·후속.

---

## 2. 현황 (Identified Issues)

### 2.1 AAP-1 — 다중 에이전트의 "현재 무엇을 하는가"를 한눈에 볼 수 없음
- **원인**: 서버·UI 에 pane 의 "현재 작업 상태(activity)" 개념이 없다. ATTENTION SRS 가 더한 것은 "주의가 필요한가(attention bool)" 라는 단일 이벤트 상태뿐이고, notification center 는 **주의 상태인 pane 만** 모은다. "지금 작업 중인" pane 이 어떤 명령을 도는지는 표현 수단이 없다.
- **현상**: 여러 세션·분할에 에이전트를 띄워두면, 각 pane 을 직접 포커스해 xterm 을 봐야만 진행 상황을 안다.
- **영향**: 멀티 에이전트 운용 시 상황 파악을 위해 끊임없이 pane 을 오간다.

### 2.2 AAP-2 — 에이전트별 활동 정보 제공 능력이 다름 (조사 결과)
- **claude**: hook 이 모든 라이프사이클 지점을 제공하고 stdin 으로 컨텍스트 JSON(`tool_name`/`tool_input` 등)을 준다. `--settings` 로 **per-invocation 주입**이 가능 → `PreToolUse` 로 "지금 무슨 툴/명령"을 실시간 전달할 수 있다(풍부).
- **codex**: per-invocation 주입 가능한 표준 `notify` 는 **`agent-turn-complete` 이벤트 하나만** 발생시킨다(턴 완료 + 마지막 메시지). 툴 단위 정보를 주는 codex `hooks`(PreToolUse 등)는 **영속 `hooks.json` 파일 + trust** 가 필요해 per-invocation 투명 주입이 불가 → 본 SRS 범위에서 codex 는 `done` 위주(빈약).
- **gemini / pi**: 투명 주입 불가(영속 설정). 명시 신호 없음 → 출력 활동 기반 `working`/`idle` 추정만.
- **결론**: 활동 카드의 충실도는 에이전트별로 다르며(claude 풍부 / codex 보통 / 그 외 최소), 본 SRS 는 이 차이를 **있는 그대로 표현**한다. codex 의 툴 단위 풍부화(`CODEX_HOME` 격리)는 비목표·후속(§5/§6).

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-AAP-1** | `Pane` 은 현재 활동 상태 `activity{ state, tool, detail, updatedAt }` 를 보관한다. attention 상태와 **독립**이며, 새 신호가 들어오면 이전 값을 덮어쓴다(pane 당 최신 1개, 히스토리 없음). 동시 접근은 기존 attention 필드와 동일한 동시성 규율(atomic/mutex)을 따른다. | 필수 |
| **FR-AAP-2** | `Pane.setActivity(state, tool, detail)` 는 활동 상태를 갱신하고 `onActivity(paneID, state, tool, detail)` 콜백을 호출한다. attention 의 `signalAttention`(345)과 동일하게 **매번 발행**(에지 게이트 없음) — 각 작업 전이를 패널에 반영해야 하므로. `detail`/`tool` 은 서버에서 제어문자 제거 + 길이 상한(`sanitizeNotifyLabel`(56)과 동일 규율, detail 은 더 큰 상한)을 적용한다. | 필수 |
| **FR-AAP-3** | `POST /api/panes/activity/set` (`apiPaneActivitySet`): body `{ paneId, state, tool?, detail? }` 의 pane 활동을 갱신한다(`apiPaneAttentionSet`(287)와 같은 형태). `paneId` 로 식별, 미지 pane 은 200 no-op, `paneId` 누락은 400, 허용되지 않은 `state` 값은 400. | 필수 |
| **FR-AAP-4** | `GET /api/panes/activity` (`apiPanesActivity`): 현재 활동 중인 pane 들의 스냅샷 `{ activities: [ { paneId, state, tool, detail, updatedAt } ] }` 을 반환한다(SSE 가 broadcast-only 라 늦게 합류한 클라이언트가 초기 상태를 복원하기 위함; FR-PAN-8 과 동일 동기). | 필수 |
| **FR-AAP-5** | 서버는 `onActivity` 를 `CommandHub.Broadcast` 로 중계한다. 페이로드: `{ "action":"pane_activity", "args":{ "paneId":"…", "state":"…", "tool":"…", "detail":"…" } }`. 이 action 은 `allowedCmdActions`(170)에 넣지 **않고** 서버 발행 전용으로 처리한다(원격 명령 입력으로 수용하지 않음; `pane_attention`/`md_scroll_changed` 와 동일 취급). | 필수 |
| **FR-AAP-6** | `dmctl activity <agent>` (신규 서브커맨드, runtimebin): 호출 pane 을 `DONGMINAL_PANE_ID` 로 식별하고, **stdin 으로 들어온 에이전트 hook JSON 을 파싱**해 state/tool/detail 을 뽑아 `POST /api/panes/activity/set` 한다. `<agent>` 인자(`claude`/`codex`)로 JSON 스키마를 분기한다. `DONGMINAL_PANE_ID` 미설정·서버 오류 시 `dmctl notify` 와 동일하게 비치명적 종료(에이전트 동작 방해 금지). detached 환경(hook)에서 동작(서버 POST, `/dev/tty` 미사용). | 필수 |
| **FR-AAP-7** | claude activity 매핑(**9개 라이프사이클 hook 전체** 커버 — 상태를 촘촘히 갱신): `PreToolUse`/`PostToolUse` → `state=working`, `tool=tool_name`, `detail=` tool_input 의 핵심 인자(`Bash`→`command`, `Edit`/`Write`/`Read`→`file_path`, `Grep`/`Glob`→`pattern`, 그 외→비움). `UserPromptSubmit` → `state=working`, `detail=prompt`. `SubagentStop`/`PreCompact` → `state=working`. `Notification` → `state=waiting`. `Stop` → `state=done`. `SessionEnd` → `state=ended`(**카드 제거** — 종료 신호). `SessionStart` → `state=idle`, `detail=source`. 알 수 없는 이벤트는 무시. 매핑은 순수 함수로 분리해 단위 테스트한다(`dmctl_activity` 의 파서). | 필수 |
| **FR-AAP-8** | `installAgentHooks`(63)는 `claude.json` 에 9개 hook 전체를 건다: `SessionStart`/`SessionEnd`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/`PreCompact`/`SubagentStop`→`dmctl activity claude`, `Stop`/`Notification`→기존 attention `notify`(done/waiting) **와 함께** activity 도 호출(이벤트당 hook 배열에 command 2개). 기존 attention hook 동작·유효 JSON 은 보존한다. dmctl 호출은 절대경로(`$DONGMINAL_HOME/bin/dmctl`). | 필수 |
| **FR-AAP-9** | codex activity 매핑: 기존 `-c notify` 가 호출하는 `dmctl` 을 activity 로도 라우팅해, `agent-turn-complete` 수신 시 `state=done`(detail 은 비우거나 `last-assistant-message` 의 짧은 머리말). codex 는 `PreToolUse` 가 없으므로 `working`/`tool`/명령어 detail 은 **채우지 않는다**(빈약 — AAP-2). 셸 래퍼(`.zshrc`/`bash-hook.sh`)는 설정 파일을 영구 수정하지 않는 per-invocation 주입을 유지한다. | 필수 |
| **FR-AAP-10** | 추정 활동 에이전트(gemini/pi 등, 명시 신호 없음): 서버는 ATTENTION SRS 의 출력 활동 신호를 재사용해 **best-effort** activity 를 채운다 — 출력 수신(armed)이면 `working`, L2 idle 발화면 `idle`. `tool`/`detail` 은 비운다. 이 추정은 명시 신호가 한 번이라도 온 pane 에는 적용하지 않는다(명시 신호 우선). | 권장 |
| **FR-AAP-11** | 프론트는 `#app` 우측 끝에 좌측 `#sidebar` 와 대칭되는 **접이식 활동 패널 `#agents-panel`** 과 리사이즈 핸들 `#agents-handle`(`#sb-handle`(54) 패턴)을 둔다. 패널은 활동 중인 pane 들의 카드를 나열한다. | 필수 |
| **FR-AAP-12** | 패널 토글 버튼을 **topbar 의 Split V(`#split-v`) 옆**에 둔다(`tbtn desktop-only` 패턴). 클릭 시 `#agents-panel` 을 펼치고/접는다. 좌측 하단(`#settings-btn` 옆)에는 두지 않는다. | 필수 |
| **FR-AAP-13** | 카드는 (a) pane 위치(세션·탭 이름; `_findPaneLocation`(참조)로 해석), (b) 에이전트 식별 가능 시 종류, (c) `state` 아이콘(working/done/waiting/idle 구분), (d) `tool`, (e) `detail` **원문**(길이 초과 시 말줄임)을 보인다. detail 이 없으면 state 만 보인다. **카드는 최근 업데이트(또는 새로 추가)된 항목이 맨 위로 오도록 정렬한다** — 갱신 시 재삽입으로 최신을 끝에 두고 역순 렌더, 서버 복원 시 `updatedAt` 기준. | 필수 |
| **FR-AAP-14** | 카드 클릭 시 (a) `_jumpToPane(paneId)`(1922)로 그 pane 으로 포커스 이동(다른 세션이면 세션 전환 포함), (b) 그 pane 에 주의(attention)가 있으면 기존 포커스 해제 경로(`POST /api/panes/attention/clear`, FR-PAN-11)로 알람도 해제한다. 활동 상태 자체는 클릭으로 지우지 않는다(상태는 다음 신호가 덮어씀). | 필수 |
| **FR-AAP-15** | 프론트는 SSE `pane_activity` 수신 시 해당 pane 카드를 **타깃 갱신**(추가/수정)한다. 합류 시 또는 SSE 재연결 시 `GET /api/panes/activity` 로 전체 스냅샷을 받아 패널을 복원한다(FR-PAN-12 와 동일 동기). | 필수 |
| **FR-AAP-16** | pane 이 종료되거나 에이전트가 종료되면 카드를 제거한다. (a) claude `SessionEnd` → `state=ended` 신호 → 서버가 활동을 nil 로 비우고 `pane_activity{state:ended}` 발행 → 프론트는 카드 삭제. (b) pane 자체 종료(`kill()`, 셸 exit/Ctrl+C 등 — SessionEnd hook 없이도) 시 서버가 동일하게 활동을 비우고 `ended` 를 발행. (c) 프론트는 존재하지 않는 pane(`_findPaneLocation` 실패)의 카드를 표시하지 않는다. `state=ended` 는 표시 상태가 아니라 제거 신호다(스냅샷·카드에서 즉시 빠짐). | 필수 |
| **FR-AAP-17** | 패널의 열림/접힘 상태와 너비를 per-device 로 영속화한다(localStorage, 사이드바 너비 `sidebarWidth`(index.html 인라인 부트스트랩) 패턴과 동일). 기존 settings 스키마(`/api/settings`)는 변경하지 않는다. | 권장 |
| **FR-AAP-19** | 패널이 열려 있는 동안 named 주기(`AGENTS_POLL_MS`, 하드코딩 금지)마다 `GET /api/panes/activity` 로 스냅샷을 **자동 재동기화**한다 — 비정상 종료(SIGKILL 등)·hook 누락으로 SSE 가 오지 않아도 stale 카드를 교정하고, 종료된(없어진) pane 카드를 제거한다. 패널을 닫으면 폴링을 중지한다(타이머 누수 없음). 수동 새로고침 버튼(헤더 `↻`)도 같은 `_activityRestore` 경로를 쓴다. | 필수 |
| **FR-AAP-20** | `ActivitySnapshot` 은 `state=working` 인데 해당 pane 에 **살아있는 에이전트 프로세스가 없으면**(`IsBusy`=false) 그 항목을 제외한다 — 비정상 종료로 `Stop`/`SessionEnd` hook 이 발화하지 못해 남은 stale `working` 을 자동 정리. 종료/대기 상태(`done`/`waiting`/`idle`)는 busy 와 무관하게 유지한다. busy 판정(`pgrep`)은 락을 잡지 않은 채 수행한다(락 홀드 중 외부 명령 금지). | 필수 |
| **FR-AAP-18** | 활동 카드는 그 pane 에 **주의(attention)가 있으면 카드에도 알람 표시**를 한다 — 프론트가 이미 보유한 attention 집합(`_attn`)을 카드 렌더 시 참조해(`_attnHas(paneId)`) 기존 `--attn` 색 토큰/`.attn` 강조(포커스·위험과 시각 구분, FR-PAN-10)를 재사용한다. attention 상태가 바뀌면(SSE `pane_attention`/`pane_attention_clear`) 활동 카드 표시도 **타깃 갱신**한다(기존 `_attnRefresh`(1932)에 활동 카드 갱신을 더하거나 카드 렌더가 attention 을 참조; 전체 render() 금지). 알람 표시된 카드 클릭 시 바로가기 + 알람 해제는 FR-AAP-14 경로. **서버 변경 없음**(attention/activity 두 상태를 프론트에서 합성). | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-AAP-1 | **attention 인프라 무변경** — 본 SRS 는 `readPTY` 핫패스·`detectAttentionSignal`·attention 상태/SSE/엔드포인트를 변경하지 않는다. activity 는 직교 레이어로 더해지며, 출력 활동 신호(`lastOutputAt`/armed)는 **읽기만** 재사용한다(FR-AAP-10). |
| NFR-AAP-2 | **빈번 신호 억제** — `PreToolUse` 는 자주 발생하므로 동일 pane 의 activity 는 항상 최신값만 보관(덮어쓰기)하고, 프론트는 전체 render() 가 아니라 해당 카드만 타깃 갱신한다(NFR-PAN-9: xterm blur/refocus 플리커 금지). SSE 부하는 활동 전이 횟수에 비례. |
| NFR-AAP-3 | **detail 안전성** — 원문을 그대로 보이되, 서버에서 제어문자(`<0x20`, `0x7f`)를 제거하고 길이 상한을 적용한다(터미널/DOM 깨짐 방지). 마스킹은 하지 않는다(로컬·본인용; §5). |
| NFR-AAP-4 | **결정성·테스트성** — hook JSON → state/tool/detail 매핑은 순수 함수로 분리(claude/codex 스키마별), 시간/네트워크 의존 없이 단위 테스트한다. `go test -race ./...` 그린. |
| NFR-AAP-5 | **비치명성** — `dmctl activity` 실패(서버 다운·env 미설정·JSON 파싱 실패)는 호출한 에이전트의 동작을 절대 방해하지 않는다(비0 종료여도 hook 가 에이전트를 막지 않도록, `dmctl notify` 와 동일). |
| NFR-AAP-6 | **설정 영구 수정 금지** — claude `--settings`, codex `-c notify` 모두 per-invocation 주입을 유지한다(ATTENTION §5 원칙 계승). 사용자 `~/.claude`·`~/.codex` 를 변경하지 않는다. |
| NFR-AAP-7 | **단일 활성 클라이언트 가정** — 다중 브라우저 동기화는 ATTENTION NFR-PAN-7 과 동일 가정(SSE 로 수렴, 완전 동기화는 비목표). |
| NFR-AAP-8 | **누수 없음** — activity 상태는 pane 수명과 함께 정리, 추가 goroutine/타이머를 도입하지 않는다(L2 추정은 기존 sweeper 재사용). |
| NFR-AAP-9 | **레이아웃 일관성·테마 연동** — `#agents-panel` 은 좌측 `#sidebar` 와 시각적으로 대칭, 카드 색/아이콘은 기존 테마 토큰(`:root` CSS 변수)을 사용하고 색을 하드코딩하지 않는다(폴백 1회만). 21종 테마와 충돌 없이 가독. |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-AAP-1 | 활동 이벤트 전송은 신규 transport 를 추가하지 않고 기존 `CommandHub.Broadcast`(SSE)를 재사용한다. attention 과 동일 채널. |
| DC-AAP-2 | 백엔드→상위 통지는 기존 콜백 주입 패턴(`SetAttentionNotifier`(537))과 동일하게 `Pane.onActivity`/`PaneManager.SetActivityNotifier` 로 구성한다. |
| DC-AAP-3 | `pane_activity` 는 서버 발행 전용. `allowedCmdActions` 에 추가하지 않는다. JSON 키는 lowerCamelCase. |
| DC-AAP-4 | 카드 클릭 점프는 기존 `_jumpToPane`/`_findPaneLocation` 을 재사용하고 새 점프 로직을 만들지 않는다. |
| DC-AAP-5 | `dmctl activity` 는 attention 의 `dmctl notify` 와 별도 서브커맨드로 분리하되, `DONGMINAL_PANE_ID` 식별·`baseURL()`·`httpPostJSON`·`sanitize` 등 공통 유틸을 공유한다. |
| DC-AAP-6 | TypeScript/JS·Go 양쪽 기존 코드 스타일을 따르고, 상수 하드코딩 금지(state 라벨·길이 상한·기본 패널 너비 등 named). 요청 전 주석 추가 금지. |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-AAP-1** (Go) | claude `PreToolUse` JSON(`tool_name=Bash`, `tool_input.command="npm test"`) 파싱 | `state=working, tool=Bash, detail="npm test"` |
| **TC-AAP-2** (Go) | claude `PreToolUse` JSON(`tool_name=Edit`, `tool_input.file_path=…/app.js`) | `state=working, tool=Edit, detail` 에 파일 경로 |
| **TC-AAP-3** (Go) | claude `Stop` / `Notification` JSON | `state=done` / `state=waiting`(tool/detail 비움) |
| **TC-AAP-4** (Go) | codex `agent-turn-complete` JSON | `state=done`, tool/명령어 detail 없음 |
| **TC-AAP-5** (Go) | detail 에 제어문자·과대 길이 포함 | 제어문자 제거 + 상한 절단 |
| **TC-AAP-6** (Go) | `POST /api/panes/activity/set` — known/unknown/missing/bad-state | known→갱신+`pane_activity` 발행, unknown→200 no-op, paneId 누락→400, 허용 외 state→400 |
| **TC-AAP-7** (Go) | `GET /api/panes/activity` | 현재 활동 pane 스냅샷 정확 반환 |
| **TC-AAP-8** (Go) | 동일 pane 에 working→done 연속 신호 | 최신값으로 덮어쓰기, 각 전이마다 `pane_activity` 발행 |
| **TC-AAP-9** (Go) | pane `kill` 후 스냅샷/SSE | 해당 pane 활동 미포함, 누수 없음, `-race` 그린 |
| **TC-AAP-10** (Go) | `dmctl activity` — `DONGMINAL_PANE_ID` 미설정 / 잘못된 stdin JSON | 비치명적 종료, 에이전트 방해 없음(서버 POST 안 함) |
| **TC-AAP-11** (e2e) | 두 pane 에 활동 신호 주입 → SSE `pane_activity` | 패널에 카드 2장(세션/탭 이름·state·tool·detail) 표시 |
| **TC-AAP-12** (e2e) | topbar 토글 버튼(Split V 옆) 클릭 | `#agents-panel` 펼침/접힘, 핸들로 너비 조절, 상태 영속 |
| **TC-AAP-13** (e2e) | 카드 클릭 | `_jumpToPane` 로 해당 pane 포커스(필요 시 세션 전환), 주의 있으면 알람 해제 호출 |
| **TC-AAP-14** (e2e) | working 카드에 done 신호 도착 | 같은 카드가 타깃 갱신(전체 render 없음, xterm 포커스 플리커 없음) |
| **TC-AAP-15** (e2e) | SSE 재연결 후 `GET /api/panes/activity` 복원 | 기존 카드 재현 |
| **TC-AAP-16** (e2e) | 활동 카드 색/아이콘 | 테마 토큰 사용, 21종 테마에서 가독 |
| **TC-AAP-17** (e2e) | 활동 카드가 있는 pane 에 `pane_attention` 도착 → 이후 `pane_attention_clear` | 카드에 `.attn` 알람 강조(포커스/위험과 구분) 추가, 해제 시 강조 제거. 모두 타깃 갱신(전체 render 없음). 알람 카드 클릭 → 바로가기 + 알람 해제 |
| **TC-AAP-18** (Go) | `ActivitySnapshot`: `working`+busy / `working`+not-busy / `done`+not-busy | working+busy 포함, working+not-busy 제외(stale 정리), done 은 busy 무관 포함 |

### 4.2 완료 조건 (DoD)
- [ ] `Pane.activity` 상태 + `setActivity` + `onActivity` 콜백 + pane 종료 시 정리.
- [ ] `PaneManager.SetActivityNotifier`/`ActivitySnapshot`.
- [ ] `POST /api/panes/activity/set` + `GET /api/panes/activity` + `pane_activity` SSE(서버 발행 전용) + TC-AAP-6,7,8.
- [ ] `dmctl activity <agent>` + claude/codex hook JSON 파서(순수 함수) + TC-AAP-1~5,10.
- [ ] `claude.json` 에 PreToolUse/Stop/Notification activity hook 추가(기존 attention hook·유효 JSON 보존) + codex `-c notify` activity 라우팅.
- [ ] (권장) gemini/pi best-effort 출력활동 추정(FR-AAP-10).
- [ ] web: `#agents-panel`+`#agents-handle`, topbar 토글 버튼, 카드 렌더(타깃 갱신), `_jumpToPane` 클릭, 스냅샷 복원, 패널 영속, 카드 attention 알람 합성 표시(`.attn` 재사용) + TC-AAP-11~17.
- [ ] `go test -race ./...` 그린, playwright 그린.
- [ ] `docs/external/features.md` 에 활동 패널 문서화(에이전트별 충실도 차이 명시).
- [ ] 신규 코드에 TODO 없음, 미사용 import 없음, 스펙 외 동작 없음, attention 인프라 무변경 확인.

---

## 5. 비목표 (Non-goals)
- **활동 히스토리/타임라인** — pane 당 최신 1개 상태만 보관한다. 시간순 로그·펼침 피드는 비목표(후속 §6).
- **detail 마스킹/리댁션** — 로컬·본인용 화면이므로 명령어 원문을 그대로 보인다(제어문자 제거·길이 상한만). 토큰/비밀번호 마스킹은 비목표.
- **codex 의 툴 단위 풍부화** — codex 는 표준 notify(turn-complete)만으로 `done` 위주. `CODEX_HOME` 격리(+auth 승계·trust)로 PreToolUse 급 정보를 얻는 것은 비목표·후속.
- **gemini/pi 의 명시 신호** — 투명 주입 불가. best-effort 출력활동 추정만(FR-AAP-10).
- **활동 패널을 별도 브라우저 창으로 분리** — 같은 SPA 안의 접이식 우측 패널만 제공한다(별도 창/라우트는 비목표).
- **다중 브라우저 완전 동기화** — NFR-AAP-7 가정으로 회피.
- **모바일 전용 활동 패널 레이아웃** — 데스크톱(`desktop-only` 토글) 우선. 모바일 대응은 후속.

## 6. 의존 / 후속
- 의존: `PANE_ATTENTION_NOTIFY_SRS`(SSE 발행·`dmctl`/`DONGMINAL_PANE_ID`·투명 래퍼·`_jumpToPane`/`_findPaneLocation`·타깃 토글 갱신), `CommandHub`(SSE), `Pane`/`PaneManager` 콜백 주입 패턴.
- 후속:
  - **codex 활동 풍부화** — `CODEX_HOME` 격리 디렉토리에 dongminal hooks.json 주입(+사용자 auth/config 승계, trust 처리)으로 codex `PreToolUse` 활동을 claude 급으로.
  - **활동 타임라인** — pane 당 최근 N개 활동 ring buffer + 카드 펼침 피드(본 SRS 의 상태 모델/SSE 재사용).
  - **gemini/pi 명시 신호** — 영속 hook 설정을 사용자 동의 하에 옵트인 설치.
  - 모바일 레이아웃, 활동 기반 필터/정렬(세션별·state별).
```
