# M9 P7 참조 — 바깥의 에이전트 GUI 들과 그것이 답해 주는 것

> P7(M9-B14~17)의 **스펙을 세우기 전에** 읽는다. 여기 있는 것은 결론이 아니라
> **조사 결과**이며, 사용자 지시(2026-09-14)로 모았다: *"다양한 gui 들을 확인해.
> 이미 다양한 gui 툴들이 이용되고 있는 걸로 알아."*
>
> 조사일 2026-09-14. 링크는 §5.

---

## 1. 우리가 이미 가진 것 (실측 — 여기부터 읽어라)

**조사보다 이것이 먼저다.** P7 의 요구 넷 중 둘은 "없는 것을 만드는 일" 이 아니라
**있는 것을 잇거나 보이는 일**이다.

| 있는 것 | 자리 | 뜻 |
|---|---|---|
| `EvUsage` 이벤트 | `agentadapter/proto.go` | 어댑터가 **이미 사용량을 나른다** |
| `ProtoUsage{Tokens, OutputTokens, ContextWindow, CostUSD, Model}` | 같은 파일 | 컨텍스트 창과 비용이 **이미 온다** |
| 컨텍스트 % 와 비용 표시 | `agent-pane.js` 의 `_setUsage` | **이미 그린다** (`agent.ctx`·`agent.cost`) |
| TUI 출구 (GUI → CLI) | `FR-AGT-10` · `agentOpenTerminal` | **있다.** 다만 새 탭을 하나 더 만든다 |
| `TUIResume` argv | `agentadapter/proto.go` · `agentsess/session.go` | 같은 세션을 터미널에서 여는 한 줄 |

**그래서 M9-B16("정보가 너무 없다")의 실제 물음은 "무엇을 더 보일 수 있는가" 다** —
아무것도 없는 자리에 처음 그리는 일이 아니다. 그 경계는 §3 이다.

## 2. 바깥 GUI 들이 무엇을 하고 있나

### 2.0 우리의 자리부터 — **우리는 다른 에이전트가 아니다** (사용자 확인 2026-09-14)

> *"내가 하고 싶은 건 opencode 같은 다른 에이전트가 아닌 claude code 의 신호를 가지고
> gui 로 사용하는 거다. opencode 와는 다르다."*

**이 구분이 P7 의 뿌리다.** 아래 표의 도구 중 다수는 **자기 에이전트를 만든다**
(OpenCode 는 자기 런타임과 75+ 모델 제공자를 갖는다). 우리는 그 반대편이다 —
**진짜 Claude Code 를 그대로 돌리고, 그것이 내는 신호를 화면으로 그린다.**
`AGENT_PROTOCOL_SURFACE_SRS` 가 *"에이전트를 터미널 화면이 아니라 프로토콜로 붙인다"*
라고 쓴 그 자리이며, `agentadapter` 등록부가 그 계약이다.

그래서 **아래 표에서 가져올 것은 "무엇을 보이는가" 와 "어떻게 오가는가" 뿐이다.**
아키텍처를 가져오면 우리가 답하려던 물음 자체가 사라진다.

그리고 이 자리 때문에 **CLI ↔ GUI 왕래가 우리에게는 자연스럽고 그들에게는 아니다** —
같은 세션을 두 표면이 번갈아 보는 것이고, 세션의 주인은 어느 쪽도 아닌 Claude Code 다.
M9-B14·15 가 설 수 있는 근거가 그것이다.

### 2.1 표

에이전트를 GUI 로 감싸는 도구가 2026 년 현재 여럿이다. **우리가 베낄 목록이 아니라,
"이 물음에 남들은 무엇으로 답했는가" 의 목록이다.**

| 도구 | 성격 | P7 에 닿는 점 |
|---|---|---|
| **Nimbalyst** | MIT, 데스크톱(macOS·Windows·Linux) + iOS·Android. Claude Code·Codex 를 1급으로, OpenCode·Copilot 은 alpha | **세션을 여럿 나란히** 돌리고(6+), 세션마다 **worktree 격리를 한 번 클릭**으로. 칸반으로 세션을 관리하고 **파일 변경을 한 자리에서** 검토한다 |
| **OpenCode** | MIT, 터미널 우선 + 데스크톱 앱. **자기 에이전트다** — 75+ 모델 제공자 | 터미널과 GUI 를 같은 세션으로 오간다는 **발상**만 같다. 자리는 다르다 (§2.0) |
| **Synara** | 데스크톱. 이미 결제한 구독을 그대로 쓴다 | **여러 CLI(Claude·Codex·Gemini·OpenCode·Cursor·Grok)를 한 창에서** — 우리 `agentadapter` 등록부와 같은 방향 |
| **Cline** | 편집기 안 (VS Code) | 편집기가 곧 표면. 우리와 층이 다르다 |
| **aider** | git 우선, 브라우저 UI 옵션 | 커밋 단위로 보여 주는 쪽 |
| **OpenHands** | 자동화 우선 | 사람이 덜 개입하는 쪽 — 우리의 반대편 |

**공통으로 보이는 것 셋** (M9-B16 의 후보를 여기서 고른다):

1. **세션 목록과 상태** — 지금 무엇이 돌고 무엇이 멈췄나
2. **변경 검토** — 그 세션이 건드린 파일을 한 자리에
3. **격리** — 세션마다 worktree (우리는 `dmctl run --isolation` 으로 이미 갖고 있다)

**우리에게 없고 그들에게 있는 가장 큰 것은 "세션이 여럿일 때의 조감"** 이다. 다만
그것은 M9-B16 의 요구("정보를 전부 표시")와 **다른 요구**이므로, 스펙을 쓸 때 섞지 마라.

### 2.2 **같은 transport 를 쓰는 구현들** (사용자 조사 2026-09-14)

사용자가 모아 준 것이며, **출처의 성격이 둘로 갈린다** — 그 구분을 지운 채 인용하지 마라.

> **공식 아키텍처 문서가 아니다.** Claude Desktop 에 대한 아래 관찰은 **공개 이슈에
> 올라온 프로세스 인자 캡처**에 기반한다. 공식 문서가 말하는 것은 "Code 탭이 Claude Code 를
> GUI 로 쓴다"(병렬 세션·파일 편집기·터미널·diff 검토)까지이고, **argv 는 관찰이다.**
> 버전에 따라 달라질 수 있으므로 **계약으로 삼지 마라.**

| 구현 | 방식 | 우리와의 거리 |
|---|---|---|
| **Claude Desktop — Code 탭** (공식) | Claude Code CLI + JSON stream (**argv 는 관찰**) | ★★★★★ |
| **sugyan/claude-code-webui** | `claude -p --output-format stream-json` + Web UI | ★★★★☆ — **유지보수 중단 명시.** 제품이 아니라 **읽을 것** |
| **TeamADAPT/claude-code-ui** | Claude CLI + WebSocket + Web UI | ★★★★☆ — 완성된 Web UI 구조 (세션·탐색기·Git·터미널) |
| **markes76/claude-code-gui** | Claude CLI + Electron + structured stream | ★★★★☆ — `CLAUDE.md`·memory·MCP·skills·agents·hooks·permissions 를 **전부 GUI 화** |
| **Coide** | Claude CLI + Electron + **node-pty (진짜 TTY)** | ★★★☆☆ — **접근이 다르다**(아래) |
| **Claude Console** | CLI 를 PTY 로 돌리고 **터미널 출력 파싱** | ★★☆☆☆ |

#### 우리는 이미 그 자리에 있다 (실측)

`agentadapter/claude_proto.go:65` 의 기동 argv 는 **한 글자도 다르지 않다**:

```
claude -p --output-format stream-json --input-format stream-json \
       --include-partial-messages --verbose --permission-prompt-tool stdio
```

즉 관찰된 Claude Desktop 과 **같은 transport** 다. **그래서 P7 에서 transport 는 물음이
아니다** — 정해져 있다. P7 이 답할 것은 **표면**(무엇을 보이는가)과 **왕래**(CLI ↔ GUI)다.

#### JSONL 과 PTY 파싱의 갈림 — 이미 지난 결정

`Coide`·`Claude Console` 계열은 `node-pty` 로 **진짜 TTY** 를 띄우고 그 출력을 판다.
그쪽은 ANSI escape · 터미널 repaint · spinner · `(y/n)` · 커서 이동 · 색 코드까지 해석해야
하고, 그 위에서 **GUI 상태와 에이전트 상태를 맞추는 일이 훨씬 어렵다.**

우리는 JSONL 쪽이고 그 선택은 `AGENT_PROTOCOL_SURFACE_SRS` 가 이미 내렸다 —
*"에이전트를 터미널 화면이 아니라 프로토콜로 붙인다"*. **이 문서는 그 결정을 다시 열지
않는다.** 다만 한 가지가 새로 보인다: **우리는 둘 다 갖고 있다.** 터미널 도구는 PTY 이고
에이전트 도구는 JSONL 이며, `FR-AGT-10` 의 왕래는 **그 둘 사이를 오가는 일**이다 —
바깥 구현 중 그 둘을 한 워크스페이스에 나란히 둔 것은 보이지 않는다.

#### 층 나누기 — 우리 것과 대조

사용자가 권한 층 나누기는 이렇다:

```
GUI → ClaudeSession ─┬ MessageStream (assistant · delta · result)
                     ├ ToolStream    (tool_use · tool_result)
                     └ ControlStream (permission request/response)
        → ClaudeProcessTransport (stdin/stdout JSONL)
```

**우리 것이 그 모양이다** — 다만 스트림을 셋으로 가르지 않고 `ProtoEvent` **한 줄기**로
낸다 (`EvTextDelta`·`EvToolStart/End`·`EvApprovalOpen/Closed`·`EvUsage`·`EvStatus`…).
`agentadapter` 가 `ClaudeProcessTransport` 이고, 어댑터 등록부가 **와이어가 바뀌어도 GUI 를
건드리지 않는** 그 격리다.

**`--permission-prompt-tool stdio` 를 공개 계약처럼 다루지 마라.** 헬프에 없고, 버전별로
permission·control 프로토콜 회귀가 있었다. 우리 코드의 주석이 이미 그것을 적고 있다
(`claude_proto.go:62`) — **그 사실을 지우지 마라.**

#### 읽는 순서 (사용자 권고)

① 공식 Agent SDK 의 subprocess transport — 프로토콜을 이해하는 데 가장 좋다
② `sugyan/claude-code-webui` — **가장 단순한** GUI 연결 구조
③ `TeamADAPT/claude-code-ui` — 완성된 Web UI 구조
④ `Coide` — 고급 IDE UX (접근은 다르지만 **화면**은 참고 가치가 높다)

## 3. 사용량의 경계 — 프로토콜이 주는 것과 주지 않는 것

M9-B16 이 말한 셋(*"context window 사용량, 주간, 5시간 사용량"*)은 **출처가 다르다.**
이것을 가르지 않으면 줄 수 없는 것을 약속하게 된다.

| 값 | 출처 | 우리가 지금 받는가 |
|---|---|---|
| **컨텍스트 창 사용량** | 프로토콜 프레임 (`usage`) | **받는다.** `ProtoUsage.Tokens / ContextWindow` — 이미 그린다 |
| **이번 요청의 입·출력 토큰·비용** | 같은 프레임 | **받는다.** `OutputTokens` · `CostUSD` |
| **5시간 롤링 한도** | 플랜 사용량. CLI 의 `/usage`·`/status`, 웹의 Settings ▸ Usage | **안 받는다** |
| **주간 한도** | 같음 | **안 받는다** |

### 3.1 사용자가 든 항목별 실측 (2026-09-14)

접수한 말: *"다양한 편의기능(context window, usage, path, branch, upstream, cache hit,
agent version, permission mode, model, effort level 등)"*. **각각 지금 오는지를 코드에서
직접 쟀다** — 추측으로 적으면 없는 것을 약속하게 된다.

| 항목 | 지금 오는가 | 자리 / 사유 |
|---|---|---|
| **context window** | ✅ **오고 그린다** | `ProtoUsage.ContextWindow` · `agent-pane.js` 의 `agent.ctx` |
| **usage (토큰·비용)** | ✅ **온다** | `ProtoUsage.Tokens/OutputTokens/CostUSD`. 비용은 이미 그린다 |
| **model** | ✅ 온다 | `init` 프레임의 `model` → `ProtoStatus.Model` · `ProtoUsage.Model` |
| **permission mode** | ✅ 온다 | `init` 프레임의 `permissionMode` → `ProtoStatus.PermissionMode` |
| **cache hit** | ⚠️ **파싱은 하는데 버린다** | `claudeUsage.CacheWrite/CacheRead` 를 읽지만 `context()` 가 `Input+CacheWrite+CacheRead` 로 **합쳐** `Tokens` 하나로 낸다. `ProtoUsage` 에 필드 둘을 더하면 끝 — **가장 값싼 항목** |
| **path (cwd)** | ✅ 있다 (다른 길) | `GET /api/cwd?tool=` — 프로토콜이 아니라 도구의 것이다 |
| **branch · upstream** | ✅ 있다 (다른 길) | git 관측의 것 — `gitPanel.statusOf()`. **에이전트가 아니라 그 도구의 cwd 가 속한 저장소**에서 온다. 그 둘을 잇는 자리가 지금은 없다 |
| **agent version** | ❌ **안 온다** | `claudeFrame` 에 version 필드가 없다. `init` 이 싣는 것은 `session_id`·`model`·`permissionMode` 뿐이다. 받으려면 **프레임 밖**(기동 시 `claude --version` 등)이고 그것은 새 요구다 |
| **effort level** | ❌ **상태로는 안 온다** | 제어(`set_max_thinking_tokens`)로 **보낼 수는 있다**. 지금 값을 **되읽는** 길이 없다 — 보낸 값을 우리가 기억하는 것과 에이전트의 실제 값은 다르다 |
| **5시간 · 주간 한도** | ❌ 안 온다 | §3 본문 — CLI 의 `/usage`·웹 Settings 의 것이다 |

**세 갈래로 갈린다.** ① **이미 온다** — 그리는 일만 남았다 ② **오는데 버린다**(cache) —
어댑터 한 줄 ③ **다른 길에서 온다**(cwd·branch·upstream) — 에이전트의 것이 아니라 **그
도구의 것**이고, 에이전트 화면에 얹으려면 그 둘을 잇는 자리를 새로 정해야 한다
④ **안 온다**(version·effort·플랜 한도) — 받으려면 프로토콜 밖이며 **새 요구**다.

**스펙을 쓸 때 이 넷을 섞지 마라.** 한 줄짜리와 새 요구가 같은 FR 에 들어가면 그 FR 은
끝나지 않는다.

세 가지 사실을 못박아 둔다.

1. **컨텍스트 채움과 플랜 사용량은 다른 것이다.** 상태줄이 보여 주는 것은 앞의 것이고,
   사용자가 "얼마나 남았나" 로 묻는 것은 뒤의 것이다. 한 화면에 나란히 두면 **둘을
   같은 것으로 읽는다** — 이름과 단위를 다르게 두어야 한다.
2. **사용량은 Claude Code·claude.ai·Cowork 가 함께 쓴다.** 그래서 우리 화면의 값이
   "이 도구가 쓴 양" 이 아니다. 그 사실을 적지 않으면 사용자가 우리 수치를 의심한다.
3. **프레임의 사용량은 두 자리에서 나오고 서로 바꿔 쓸 수 없다** — 과금되는 것은
   `result` 이벤트 쪽이다. 합산 로직을 쓸 거면 어느 쪽을 더하는지 먼저 정하라.

**추정으로 채우지 마라.** `AGENT_PROTOCOL_SURFACE_SRS` 의 목적이 정확히 추정 장치를
걷어내는 것이었다 (§1.1). 플랜 사용량을 프로토콜 밖에서 긁어오려면 그것은 **새 요구**이고
별도 결정이 필요하다.

## 4. 세션 신원 — CLI ↔ GUI 왕래의 열쇠 (M9-B14·15)

`FR-AGT-10` 이 *"반대 방향도 같은 `Resume` 으로 가능해야 한다"* 로 남겨 둔 자리다.
바깥의 사실은 이렇다.

- 세션은 **id 로 다시 열린다** — `claude --resume <session-id>`. 스크립트는
  `--session-id` 로 **미리 정해** 줄 수도 있다
- 최근 것 하나는 `--continue`, 그 밖은 `--resume`

**그래서 열쇠는 "그 셸에서 도는 에이전트의 session id 를 어떻게 아는가" 하나다.**
길이 둘로 보인다 — 어느 쪽인지는 **P7 이 실측으로 정한다.**

| 길 | 뜻 | 확인할 것 |
|---|---|---|
| **미리 정한다** | 우리가 탭을 띄울 때 `--session-id` 로 id 를 **주고** 시작한다 | 세 어댑터가 그 플래그를 갖는가. 사용자가 손으로 `claude` 를 친 탭은 이 길 밖이다 |
| **나중에 묻는다** | 이미 도는 세션에서 id 를 **꺼낸다** | 프로토콜·훅·파일 어디에 그 값이 있는가. `agentsess` 가 무엇을 붙들고 있는지부터 |

**두 길의 차이가 곧 범위의 차이다.** 앞쪽만 되면 "우리가 띄운 CLI 만 GUI 로 올릴 수
있다" 이고, 뒤쪽까지 되면 "아무 CLI 나" 다. **접수한 말은 뒤쪽에 가깝다** — 그러니
안 되면 안 되는 대로 적어라 (`FR-AGT-10` 이 스파이크를 남겨 둔 이유가 그것이다).

## 5. 출처

- [Claude Code — Manage sessions](https://code.claude.com/docs/en/sessions)
- [Claude Agent SDK — Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK — Streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Claude Code 사용 한도 — 5시간·주간](https://bestagent.dev/claude-code-usage-limits/)
- [Claude Code usage limits (2026)](https://www.morphllm.com/claude-code-usage-limits)
- [Nimbalyst — GitHub](https://github.com/Nimbalyst/nimbalyst) · [Claude Code GUI](https://nimbalyst.com/claude-code-gui/)
- [Best Claude Code GUI in 2026 — 4 tools compared](https://nimbalyst.com/blog/best-claude-code-gui-tools-2026/)
- [10+ Best Open Source Claude Code Alternatives](https://openalternative.co/alternatives/claude-code)

## 6. 이 문서를 쓸 때의 경계

**이것은 스펙이 아니다.** 여기 있는 표는 "남들이 이렇게 한다" 이고, 우리가 무엇을
할지는 사용자 결정과 실측이 정한다. 특히:

- §2 의 도구 표를 **요구로 옮기지 마라.** 칸반·목업 같은 것은 접수한 말에 없다
- **§2.2 의 Claude Desktop argv 는 관찰이지 문서가 아니다.** 우리 argv 와 같다는 것은
  "같은 방향" 의 근거이지 "공식 계약" 의 근거가 아니다. 버전이 바꾸면 우리만 따라간다
- **아키텍처는 더더욱 옮기지 마라** (§2.0). 우리는 Claude Code 를 **그대로 돌리고 그리는**
  쪽이고, 자기 에이전트를 만드는 도구들과 자리가 다르다. 그 도구들이 쉬워 보이는 일 중
  일부는 자기 런타임을 가졌기 때문에 쉬운 것이며, 우리에게는 **프로토콜이 주는 만큼**이
  경계다 (§3)
- §3 의 경계는 **지금 사실**이다. 어댑터가 새 필드를 나르기 시작하면 그날 다시 잰다
- §4 의 두 길은 **가설**이다. 어느 쪽인지 코드로 확인하기 전에는 스펙에 적지 마라
