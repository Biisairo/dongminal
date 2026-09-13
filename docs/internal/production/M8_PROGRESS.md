# M8 진행 — 통합 일정: Go 부채 · 국제화 · 에이전트 프로토콜 표면

> 로드맵 §M8. 스펙은 [`M8_UNIFIED_SRS`](../M8_UNIFIED_SRS.md) (승인·구현중). 단계는 스펙
> §4 — P0 스파이크 → P1 Go 부채 ①~④ → P2 국제화 → P3 프로토콜(claude) → P4·P5·P6 → P7.

---

## 1. 어디까지 왔나 (2026-09-13, 첫 번째 세션 — **P0 스파이크 종료**)

| 단계 | 상태 |
|---|---|
| **P0** 스파이크 (U-1~U-10 · 산출물 ①~⑤) | **완료** — 스펙 §9.1 표가 채워졌고 §9.3 이 섰다. 제품 코드 0줄 |
| P1 A ①~④ + `TEST-8` | 착수 전 — `M8_NEXT_SESSION.md` 가 안내한다 |
| P2~P7 | 착수 전 |

**사용자 판단 대기 셋** (스펙 §9.3 ⑥ · 이 문서 §2-6):

1. **FR-APS-10 정정** — claude 승인은 MCP 서버가 아니라 stdio 제어 프레임(`--permission-prompt-tool stdio`)으로 온다. 라이브 왕복 확인.
2. **D-U-4 정정** — "새 도구 종류" 가 아니라 "전송만 다른 변형 + `Kind`" 가 `GO-46` 에 싸다.
3. FR-AGT-11·FR-AGT-12 추가 — 사용자 요구 둘(*"omp 로그인 방식 전부·모델 변경"* · *"동시 접근은 터미널처럼 한쪽만 컨트롤"*)을 FR 로 적었다. 확인만.

**바이너리**: claude 2.1.270 · codex 0.154.0(bunx 캐시) · omp 17.4.0. 라이브 모델 턴은 claude 만
— codex 는 토큰 만료(사용자: *"지금 사용 안 하고 있다"*), omp 는 등록 키 둘 다 401.
그 둘의 턴 의존 칸은 "미확인 — 자격증명 없음" 으로 남겼다.

---

## 2. 무엇이 바뀌었나

### 2-1. claude 의 승인은 MCP 가 아니었다 — 스펙의 "범위 항목" 이 사라진다

스펙 FR-APS-10 과 R-c 는 `--permission-prompt-tool` 이 **MCP 도구 서버**를 요구한다고
적었고, 그래서 dongminal 이 MCP 서버를 하나 들어야 한다는 범위 항목이 됐다. 실측:
`--permission-prompts host` 만 주면 요청 없이 **자동 거부**(`system:permission_denied`,
`result.permission_denials[]`)이고, `--permission-prompt-tool stdio`(헬프에 없는 값)를
주면 `control_request{subtype:"can_use_tool",…,permission_suggestions[]}` 가 stdout 으로
오고 `control_response{behavior:"allow"}` 한 프레임에 도구가 돈다(파일 생성 확인).
`ExitPlanMode`·`AskUserQuestion` 도 같은 통로다.

MCP 서버 하나가 통째로 빠진다. 대가는 **숨은 플래그에 기대는 것** — R-2(비공개
계약)에 얹힌다.

### 2-2. 세 재개는 전부 "이력을 주지 않는다" — 재생 원천은 우리 로그뿐

claude `--resume`·codex `thread/resume`·omp `--resume` 셋 다 같은 세션 신원으로
**새 이벤트만** 낸다. 이력은 각자의 파일/페이지 API(`thread/turns/list`, `get_messages_page`)
에 있고 FR-AGT-6 은 그것을 읽지 않는다. 그러므로 FR-ABG-4 의 재생은 **우리 이벤트
로그**로만 성립하며, 요약 스냅샷(FR-ABG-21)의 근거가 더 분명해졌다.

### 2-3. `--bg` 는 휴면의 반대였다

`claude --bg` 는 `claude daemon run` + `bg-pty-host`(200×50 PTY) 로 **TUI 를 숨은 PTY 에
살려 두는** 기계다 — dongminal 의 백그라운드 터미널 도구와 같은 자리이지 프로세스가
사라지는 휴면이 아니다. 휴면(FR-ABG-10)의 실체는 `--resume` 하나.

### 2-4. omp 는 기본이 yolo 다 — 인자 없이 띄우면 승인 요청이 한 번도 안 온다

`tools.approvalMode` 기본값이 `yolo`. 그리고 `--mode rpc`(hasUI=false)에서는 승인이
**오류**로 실패한다(`wrapper.ts:307`). 어댑터의 프로토콜 기동은 `--mode rpc-ui
--approval-mode <정책>` 을 반드시 싣는다. 승인 프레임은 `select(["Approve","Deny"])` —
소스로 확인했고 라이브 왕복은 자격증명이 없어 못 봤다.

또 하나: 로그인 `input` 대기 중에 stdin 을 닫자 omp 가 `input` 재요청을 **1,162회**
쏟았다. 호스트는 열린 요청에 `{cancelled:true}` 로 답한 뒤 닫아야 한다 — 시안 ③의
`Cancel` 이 그 자리다.

### 2-5. codex 는 한 프로세스가 여러 thread 를 든다 — 그리고 훅이 생겼다

AS-1(한 프로세스 = 한 세션)은 codex 에서 거짓이다. 두 `thread/start` 가 한 stdio 에서
병렬로 돌고 알림마다 `threadId` 가 실린다. 설계는 안 바뀐다(한 프로세스를 한 도구로).

범위 밖 발견: codex 0.154.0 의 `hooks` 기능이 **stable** 이고 claude 와 같은 훅 이벤트를
`~/.codex/hooks.json` 으로 받는다. §2.3.2 의 "codex 는 사실상 침묵한다" 는 터미널
표면의 사실이라 이 스펙이 손대지 않지만(FR-U-3), `codexAdapter` 의 훅 표면은 후속
문서감이다.

### 2-6. 세 판정 — 사용자 확인 대기

| | 판정 | 근거 |
|---|---|---|
| ③ 어댑터 필드 | **셋이 한 구조체에 든다** (`Adapter.Proto *Proto`) | 차이는 핸드셰이크·요청 id 자리·codex threadId 뿐 — 전부 함수와 `ProtoState` 안 |
| ④ 데몬 중계 | **같은 길** (`output` 푸시 + `write` RPC), 단 에이전트 도구는 **non-droppable** + stderr 스트림 | 프레임 한 개 유실 = 승인 요청 유실. `exit` 이벤트와 같은 등급 |
| ⑤ D-U-4 | **변형 + `Kind`** | 종류가 갈리는 자리는 해석층·뷰·전송 호출 셋뿐. 새 종류로 두면 `ToolHub` 인터페이스에 종류별 메서드가 생겨 FR-AGT-8 을 어긴다 |

### 2-7. 사용자 요구 하나가 P0 중에 들어왔다

*"omp 는 여러 방식으로 로그인이 가능한데 이걸 다 사용할 수 있어야 해 — 모델 변경이라거나."*
→ FR-AGT-11: 프로토콜이 주는 로그인 공급자·로그인 흐름(`open_url`·`input`)·모델 목록·
전환을 UI 로 낸다. 실측으로 omp `get_login_providers`(63 공급자)·`login` → `open_url`·
`notify`·`input` 흐름, `set_model`·`cycle_model` → `model_changed` 를 봤다. claude 는
`initialize.models` + `set_model`, 로그인은 TUI 출구.

### 2-8. 동시 접근은 창 포커스 소유가 이미 답이다

*"에이전트 화면 동시 접근에 대해서는 터미널과 같은 동작으로 한쪽만 컨트롤하도록
블로킹하기."* 터미널의 그 동작은 `app-focus.js` 의 창 포커스 소유(FR-XDF — 창마다
소유자 하나, last-focus-wins, 서버가 맵을 쥐고 SSE `window_focus` 로 뿌림)와
`.pn-dimmed` 오버레이("클릭하여 포커스")다. 에이전트 도구도 창 안의 pane 이므로 같은
코드가 그대로 닿는다 — FR-AGT-12. 서버가 비소유자의 승인 응답까지 거절할지는 P3 의
결정으로 남겼다(터미널은 클라이언트만 막는다).

### 2-9. 셋 다 TUI 와 같은 자격증명을 쓴다

사용자 질문 *"tui 가 되면 gui 도 되는 건가 별개 로그인인가"* — 별개가 아니다. claude
`~/.claude`+키체인, codex `~/.codex/auth.json`, omp `~/.omp/agent/agent.db` 를 프로토콜
모드도 그대로 읽는다(라이브: claude `/cost` 가 구독 로그인을 보고, omp
`get_login_providers` 의 `authenticated`, codex `account/read`). 이번 401 은 저장된
자격증명이 죽은 것이라 TUI 로도 같다.

---

## 3. 실측 방법 — 다음 세션이 그대로 쓸 것

- `/tmp/m8-spike/drive.py <out.jsonl> <idle-sec> -- <cmd…>` + `DRIVER=<시나리오.py>` —
  stdio JSONL 드라이버. 시나리오는 `on_start(send)`·`on_frame(frame, send)→bool`·
  `on_end(send, proc)`. 출력 파일에 보낸 것은 `>>> ` 접두어로 함께 남는다.
- `/tmp/m8-spike/ptycap.py <out.bin> <sec> <cols> <rows> "<sec>:<keys>"… -- <cmd…>` —
  PTY 캡처(알림 시퀀스). claude 는 새 cwd 에서 신뢰 프롬프트가 먼저 뜬다(↓·Enter).
- codex 는 `bunx --bun @openai/codex` 로 캐시에만 받았다 —
  `~/.bun/install/cache/@openai/codex@0.154.0-*/vendor/aarch64-apple-darwin/bin/codex`.
  `app-server generate-json-schema --out <dir>` 이 프로토콜 전체(99 요청·10 서버 요청·
  90여 알림)의 스키마를 낸다 — 라이브보다 이것이 정본이다.
- omp 의 문서는 `dist/docs-index.generated.txt`(둘째 줄 base64+gzip JSON 배열, 첫 줄이
  이름 목록)에 들어 있다. `rpc.md`·`approval-mode.md`·`session.md` 를 풀어 읽었다.
- `/tmp` 는 저장소 밖이다. 픽스처(②)를 만들 때 **형태만** 옮긴다.

---

## 4. 이 세션의 커밋

(커밋은 사용자 확인 후.)
