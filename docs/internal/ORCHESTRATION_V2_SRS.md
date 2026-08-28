# SRS: 오케스트레이션 2세대 — 식별자 정규화·헤드리스 멤버·컨텍스트 예산·패턴·Run 시각화 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`RUN_ORCHESTRATION_SRS` 가 Run 의 **실체**(레코드·상태 계약·어댑터·격리)를 놓았다.
본 SRS 는 그 위에서 드러난 **운용상의 결손 넷**을 닫는다.

| # | 접수한 말 | 결손의 실체 |
|---|---|---|
| 1 | "한 에이전트에게 여러 일을 시키면 컨텍스트가 오염되고 많이 찬다" | 멤버의 컨텍스트 소모를 **아무도 관측하지 못한다.** 고갈은 압축이나 응답 붕괴로만 사후에 드러나고, 그때는 이미 팀 산출물이 오염돼 있다 |
| 2 | "모든 동작을 uuid 로. w.p.t 기반이면 화면을 자유롭게 못 쓴다. 백그라운드에서 세션을 돌릴 수도 있다" | 에이전트 IO 경로가 **좌표 라벨을 받는다.** 그리고 멤버는 **탭을 반드시 점유해야** 존재할 수 있다 — 팀 규모가 곧 화면 분할 수다 |
| 3 | "오케스트레이션 패턴이 너무 단순하다. 2개 만들고 계속 일만 시킨다" | 스킬이 **토폴로지 하나**(조정자→평면 멤버 N)만 안다. 작업 성격과 무관하게 같은 모양이 나온다 |
| 4 | "Run 을 시각화해서 볼 수 있으면 좋겠다" | Run 상태를 보는 유일한 창이 `dmctl run status` 의 **텍스트**다. 누가 누구와 말하는지는 어디에도 남지 않는다 |

### 1.2 범위 (Scope)

**포함** — 다섯 묶음. 묶음 간 의존은 §2.4.

| 묶음 | 이름 | 접두어 | 접수 항목 |
|---|---|---|---|
| **I** | 식별자 uuid 전용화 | `FR-IDU-` | 2 |
| **H** | 헤드리스 멤버 | `FR-HLM-` | 2 |
| **C** | 컨텍스트 예산과 승계 | `FR-CBG-` | 1 |
| **P** | 패턴 카탈로그 (문서) | `FR-PAT-` | 3 |
| **V** | Run 시각화 | `FR-RVZ-` | 4 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

`Client`/`Window`/`Pane`/`Tab`/`Tool` 은 `ENTITY_MODEL_RESTRUCTURE_SRS` §1.3,
`Run`/`Member`/`조정자` 는 `RUN_ORCHESTRATION_SRS` §1.3 을 따른다. 본 SRS 고유 용어만.

| 용어 | 정의 |
|------|------|
| **좌표 라벨 (label)** | `W{n}.P{n}.T{n}`. 창·분할 칸·탭의 **1-based 위치**로 매 인덱스 재구축 때 다시 계산된다. 창 하나가 닫히면 남은 전부가 밀린다 (reflow) |
| **헤드리스 멤버 (headless member)** | 어떤 탭도 참조하지 않는 Tool 에 결속한 Member. 화면에 자리를 차지하지 않으며 uuid 로만 도달한다 |
| **부착 (attach)** | 헤드리스 멤버의 Tool 을 탭에 연결해 사람이 보게 만드는 것. 역은 **분리(detach)** |
| **컨텍스트 예산 (context budget)** | 멤버 에이전트가 쓸 수 있는 대화 컨텍스트의 총량. 서버는 이를 **직접 알 수 없고 추정**한다 |
| **승계 (succession)** | 컨텍스트가 고갈된 멤버를 같은 역할·같은 brief·같은 작업 트리의 **새 멤버**로 교체하고, 인수인계 요약을 물려주는 절차 |
| **패턴 (pattern)** | 멤버 구성·통신 토폴로지·종료 조건의 정형화된 조합 (supervisor-worker, debate 등) |
| **메시지 로그** | `dmctl msg` 로 오간 신뢰 채널 통신의 발신·수신·시각 기록. 본문은 담지 않는다 |

### 1.4 참조 (References)

- [`./RUN_ORCHESTRATION_SRS.md`](./RUN_ORCHESTRATION_SRS.md) — Run 레코드·상태 계약·어댑터·격리
- [`./WORKSPACE_IDENTITY_SRS.md`](./WORKSPACE_IDENTITY_SRS.md) — uuid 식별자 계약 (FR-UNI-*, FR-DMC-9)
- [`./SKILL_INJECTION_SRS.md`](./SKILL_INJECTION_SRS.md) — 세션 스코프 스킬·훅 주입
- [`./ENTITY_MODEL_RESTRUCTURE_SRS.md`](./ENTITY_MODEL_RESTRUCTURE_SRS.md) — 엔티티 모델
- [`./archive/AGENT_ACTIVITY_PANEL_SRS.md`](./archive/AGENT_ACTIVITY_PANEL_SRS.md) — activity 레이어 (FR-AAP-*)
- [`./archive/PANE_ATTENTION_NOTIFY_SRS.md`](./archive/PANE_ATTENTION_NOTIFY_SRS.md) — attention 레이어
- [`./PARALLEL_DELIVERY_PLAN.md`](./PARALLEL_DELIVERY_PLAN.md) — 본 SRS 를 포함한 3축 병렬 실행 계획

---

## 2. 전체 설명 (Overall Description)

### 2.1 현재 상태 — 조사로 확정한 사실

착수 전에 코드로 확인했다. 추정이 아니다.

**(a) 식별자 — 두 경로가 정반대다.**

| 경로 | 소비자 | 라벨 수용 | 근거 |
|---|---|---|---|
| `/api/commands` (레이아웃) | `split-h/v`, `new-tab`, `new-window`, `close-tab`, `focus`, `rename-tab`, `open-editor` | **거부한다 (400)** | `httpapi/commands.go:34` `translateLocationUUID` → `IsKnownTabID(loc)` 아니면 에러. FR-DMC-9 |
| `/api/tools/*` (IO·에이전트) | `read-screen`, `read-output`, `send-input`, `msg`, `status`, `wait`, `activity` | **받는다** | `httpapi/handlers_toolio.go:37` `resolveToolID` → `workspace/manager.go:249` `Resolve` 3단계 (toolId → uuid → **라벨**) |

`dmctl` 도움말(`runtimebin/dmctl.go:54`)은 "좌표·라벨·toolId 는 거부(400)" 라고 **이미
선언하고 있다.** 즉 (b) 는 문서가 앞서 있고 구현이 따라오지 않은 자리다.

> **따라서 본 SRS 는 레이아웃 명령에 라벨을 새로 열지 않는다.** 접수한 요구
> ("레이아웃 변경을 제외한 모든 동작을 uuid 로")의 실질은 **IO·오케스트레이션 경로를
> 좁히는 것** 하나다. 레이아웃 경로는 이미 목표 상태에 있으므로 손대지 않는다.

**(b) 멤버는 탭을 점유해야만 존재한다.** `dmctl run member` 는 `--at <탭 uuid>` 를
요구하고, `Member.TabID`·`Member.ToolID` 가 함께 채워진다. 탭 없는 Tool 을 만드는
능력은 **이미 있다** — `toolhub.ToolManager.Create(cwd, cols, rows)` 는 워크스페이스
트리와 무관하고, 백그라운드 도구 레지스트리(`tool.go:690` `background map[string]int64`,
`GET /api/tools/background`, `POST /api/tools/background/set`)가 "탭에 붙지 않은 살아있는
도구" 를 이미 다룬다. 헤드리스 멤버는 **새 개념이 아니라 이 둘의 결합**이다.

**(c) 컨텍스트 소모를 보는 눈이 없다.** `agentadapter/claude.go:39` 가 파싱하는 훅
필드는 `hook_event_name`·`tool_name`·`tool_input`·`prompt`·`source` 뿐이다.
Claude Code 훅 페이로드에 실려 오는 `transcript_path`·`session_id` 와 `PreCompact`
이벤트는 **현재 버려지고 있다.**

**(d) 메시지는 흔적을 남기지 않는다.** `dmctl msg` 는 `handlers_toolio.go:151` 에서
엔벨로프를 조립해 대상 PTY 에 쓰고 끝난다. 누가 누구에게 말했는지는 **어디에도 남지
않는다** — 관계 그래프를 그릴 원천이 없다.

**(e) 탭 타입은 이미 다형이다.** `app-layout.js:138` `addTab(rid, type, opts)` 가
`'terminal'`·`'editor'`·`TAB_TYPE_GIT` 를 가르고, `renderer.js:380` 이 타입별로 렌더를
분기한다. Run 대시보드 탭은 **네 번째 타입**으로 들어간다.

### 2.2 제품 조망

```
                    ┌──────────────── 관측 (서버가 본다) ────────────────┐
  attention ────────┤  "지금 사람을 불러야 하나"                          │
  activity  ────────┤  "지금 무엇을 하고 있나"                            │
  context   ────────┤  "얼마나 더 할 수 있나"   ← 묶음 C 가 새로 넣는 층  │
                    └────────────────────────────────────────────────────┘
                                        │
                            Run 레코드 (runs.json)
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │                               │                               │
   멤버 (탭 부착)                 멤버 (헤드리스)              메시지 로그
   화면에 보인다                  uuid 로만 도달              누가 누구에게
        │  묶음 H 가 둘을 대칭으로 만든다  │                    묶음 V 의 원천
        └───────────────┬───────────────┘                               │
                        │                                               │
                 uuid 단일 식별자 (묶음 I)                              │
                        │                                               │
                        └──────────────► Run 대시보드 탭 (묶음 V) ◄─────┘
```

### 2.3 사용자 특성

조정자는 **에이전트**다. 사람이 아니다. 따라서:

- 오류 메시지는 **다음 행동을 지시**해야 한다. "잘못된 id" 로는 에이전트가 복구하지
  못한다 — 무엇을 대신 쓸지 말해야 한다.
- 관측 결과는 **텍스트로도 완전**해야 한다. 시각화는 사람을 위한 것이고, 에이전트는
  `dmctl` 출력만 본다. 시각화에만 있는 정보는 없다 (NFR-ORC-3).

### 2.4 묶음 간 의존

```
  I (식별자) ──────┐
                   ├──► H (헤드리스) ──┐
  (기존 Run 레코드)┘                   ├──► V (시각화)
                                       │
  C (컨텍스트) ────────────────────────┘

  P (패턴 문서) — 코드 의존 없음. 단, H 의 존재를 전제로 서술한다
```

- **I → H**: 헤드리스 멤버는 탭이 없어 라벨이 애초에 존재하지 않는다. I 가 먼저
  닫히지 않으면 H 는 "라벨로는 못 부르는 멤버" 라는 예외를 만든다.
- **H·C → V**: 시각화가 그릴 대상(헤드리스 노드·컨텍스트 게이지)이 먼저 있어야 한다.
- **P** 는 독립이지만 H 를 전제로 쓴다 (패턴 중 다수가 헤드리스 멤버를 권한다).

### 2.5 제약 (Constraints)

- **C-1** 서버는 조정자를 대신해 판단하지 않는다. 컨텍스트 임계 도달 시 서버가 하는
  일은 **알리는 것**까지다. 멤버를 죽이거나 교체하는 것은 조정자의 호출이다.
- **C-2** 프론트엔드에 번들러가 없다. 새 JS 는 `index.html` 에 `<script>` 로 등록하며
  **로드 순서가 곧 의존성**이다.
- **C-3** 외부 그래프 라이브러리를 도입하지 않는다. 관계도는 SVG 로 직접 그린다
  (바이너리 단일 배포 원칙 · `go:embed`).
- **C-4** 컨텍스트 소모는 **추정치**다. 서버는 토큰 수를 알 수 없다. 모든 표시는
  추정임이 드러나야 한다 (§3.3 NFR).

---

## 3. 요구사항 (Specific Requirements)

### 3.1 묶음 I — 식별자 uuid 전용화 (FR-IDU-*)

#### 3.1.1 해석 모드의 분리

**FR-IDU-1** `workspace.Manager` 는 식별자 해석 함수를 **둘**로 가른다.

| 함수 | 허용 | 용도 |
|---|---|---|
| `Resolve(id)` (기존) | 살아있는 toolId → 엔티티 uuid → **좌표 라벨** | 레이아웃·내부 호환 경로 전용 |
| `ResolveStrict(id)` (신설) | 살아있는 toolId → 엔티티 uuid | **에이전트 IO·오케스트레이션 전용** |

`ResolveStrict` 는 기존 `Resolve` 를 감싸지 않고 **3단계를 실행하지 않는다** — 라벨
인덱스 조회 자체를 하지 않아, 라벨과 우연히 같은 문자열의 uuid 가 있어도 해석이
갈리지 않는다.

**FR-IDU-2** `ResolveStrict` 가 라벨 형태(`^W\d+\.P\d+\.T\d+$`, 대소문자 무시)의
입력을 받으면 **다른 실패와 구분되는 오류**를 낸다. 형태 판정은 **오류 메시지를 고르는
데에만** 쓰며 해석에는 쓰지 않는다 (FR-UNI-10 보존: 해석은 조회 결과가 정한다).

```
좌표 라벨(W1.P2.T1)은 이 명령에서 쓸 수 없다 — uuid 를 쓴다.
라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다.
uuid 는 `dmctl list-workspace` 의 uuid= 컬럼, 또는 생성 명령(new-tab/split-*)의 응답에 있다.
```

**FR-IDU-3** 라벨 형태가 아닌 미지의 식별자는 기존 메시지를 유지한다 (행위 보존).

#### 3.1.2 적용 지점

**FR-IDU-4** 아래 표면은 `ResolveStrict` 를 쓴다. HTTP 응답 코드는 **400**
(`Bad Request`) 이며, 지금의 404(없는 도구)와 구분된다 — 에이전트가 "잘못 불렀다" 와
"없다" 를 가를 수 있어야 한다.

| dmctl | HTTP | 핸들러 |
|---|---|---|
| `read-screen` | `GET /api/tools/screen` | `apiToolScreen` |
| `read-output` | `GET /api/tools/output` | `apiToolOutput` |
| `send-input` | `POST /api/tools/input` | `apiToolInput` |
| `msg` (`--to`, `--from`) | `POST /api/tools/message` | `apiToolMessage` |
| `status` | `GET /api/tools/status` | `apiToolStatus` |
| `wait` | `GET /api/tools/wait` | `apiToolWait` |
| `run member --at` | `POST /api/runs/members` | `apiRunMemberAdd` |
| `run launch --member` | `GET /api/runs/preamble` | `apiRunPreamble` |

**FR-IDU-5** 레이아웃 경로(`/api/commands`)의 현재 동작은 **바꾸지 않는다.** 이미
uuid 전용이며(FR-DMC-9), 본 SRS 는 라벨을 되살리지 않는다.

**FR-IDU-6** `list-workspace` 는 `label=` 컬럼을 **계속 출력한다.** 라벨은 사람이
화면을 읽을 때의 좌표이지 입력 식별자가 아니다. 다만 `--json` 출력의 `label` 필드에는
설명 주석을 달지 않고, 도움말에서 "표시 전용" 임을 명시한다.

**FR-IDU-7** `dmctl` 도움말(`dmctl.go`)의 "위치 식별자 — uuid 만 허용" 절을 실제
적용 범위에 맞게 개정한다. 지금은 전 명령에 해당하는 것처럼 읽히지만, 사실은
`--at`/`--to`/`--from`/`location` 전부에 해당한다는 것을 **명시**한다.

**FR-IDU-8** `team`·`workflow` 스킬 문서에서 "라벨도 받지만" 류의 서술을 제거하고,
uuid 만이 유효한 입력임을 단정한다.

**FR-IDU-9 (추가, 2026-08-28)** 신뢰 채널 엔벨로프 헤더는 발신자·수신자를
**`<라벨> (<uuid>)`** 형태로 싣는다.

라벨만 싣던 기존 동작은 **회신을 막는 구조**였다. 수신 에이전트가 답장하려면 uuid 가
필요한데 헤더에는 라벨뿐이라, `dmctl list-workspace` 를 되짚어 매칭해야 했다. 실제로
`dmctl_agentcontext.go` 의 SessionStart 안내문이 그 우회를 **명시적으로 지시**하고
있었다 — "발신자 uuid 는 엔벨로프 헤더의 라벨이 아니라 `dmctl list-workspace` 로
확인한 uuid 를 쓴다".

묶음 I 가 접합면을 uuid 전용으로 좁히면 이 마찰이 **필수 절차**가 된다. 헤더에 uuid 를
함께 실으면 우회 자체가 사라지므로, 좁히기와 짝을 이루어야 한다.

- 라우팅에는 여전히 uuid 만 쓴다. 라벨은 **사람이 읽는 부분**이다 (FR-IDU-6 와 일관)
- 발신자 표기 경로는 `Resolve` 를 유지한다 — 표시 목적이며 해석 실패가 전달을 막지
  않는다
- SessionStart 안내문(`dmctl_agentcontext.go`)과 `dmctl msg` 도움말의 관련 서술을
  함께 고친다

#### 3.1.3 검증 (묶음 I)

| ID | 시나리오 | 기대 |
|---|---|---|
| V-IDU-1 | 살아있는 탭의 라벨로 `dmctl msg --to W1.P1.T1` | rc≠0, stderr 에 FR-IDU-2 문안, 대상 PTY 에 **아무것도 쓰이지 않음** |
| V-IDU-2 | 같은 탭의 uuid 로 같은 호출 | rc=0, 엔벨로프 전달 |
| V-IDU-3 | 라벨로 `dmctl send-input`/`read-screen`/`status`/`wait` 각각 | 전부 400 + 동일 문안 |
| V-IDU-4 | 라벨로 `dmctl split-h --at` | 기존과 동일하게 거부 (회귀 없음) |
| V-IDU-5 | uuid 로 `dmctl split-h --at` | 기존과 동일하게 성공 (회귀 없음) |
| V-IDU-6 | 존재하지 않는 uuid 로 `dmctl msg` | 404 + 기존 문안 (400 아님) |
| V-IDU-7 | `Resolve` 단위 테스트 — 라벨 3단계가 살아 있음 | 통과 (레이아웃 경로 보존) |

---

### 3.2 묶음 H — 헤드리스 멤버 (FR-HLM-*)

#### 3.2.1 생성과 수명

**FR-HLM-1** `dmctl run member` 는 `--at <탭 uuid>` 대신 **`--headless`** 를 받는다.
둘은 배타이며 **정확히 하나**가 있어야 한다. 없으면 오류로 무엇을 줘야 하는지 안내한다.

**FR-HLM-2** `--headless` 멤버는 서버가 Tool 을 새로 만든다
(`POST /api/tools/headless`). 만들어진 Tool 은:

- 어떤 Tab 도 참조하지 않는다 (`Member.TabID` 는 빈 문자열)
- 백그라운드 레지스트리에 등록된다 — 기존 `⏻` 배지·모달에 **함께 보인다**
- `cwd` 는 격리 Run 이면 멤버의 worktree, 아니면 조정자의 cwd
- `cols`/`rows` 는 고정 기본값(`120x40`). 화면이 없으므로 리사이즈 대상이 아니다

**FR-HLM-3** 헤드리스 Tool 은 `tools.json` 에 **기록한다.** 현재 백그라운드 도구는
기록되지 않아 데몬 재시작을 넘기지 못하지만, Run 이 참조하는 도구는 Run 레코드가
살아남는 이상 **함께 살아남아야** 한다. 기록되지 않으면 데몬 재시작 후 Run 은 존재하나
멤버는 `lost` 가 되어 정리도 승계도 불가능한 상태가 남는다.

> ⚠️ **이 조항은 FR-BG-9 와 같은 함수에 상반된 단정문을 건다** (2026-08-28,
> WS-4 발견). 착수 전에 반드시 읽어라.
>
> `toolhub.SaveAll` 이 백그라운드 도구를 건너뛰는 것은 **누락이 아니라 명시적
> 규칙**이며, 근거가 주석으로 붙어 있다 — *"FR-EM-12/FR-BG-9: 백그라운드 도구는
> 기재하지 않는다. 기재하면 재시작 시 빈 셸로 되살아나 고아가 된다 — 백그라운드로
> 보낸 이유가 '돌고 있던 작업' 이므로 빈 셸에는 의미가 없다."*
>
> **그 스킵을 그냥 지우면 FR-BG-9 회귀다.** 사용자가 손으로 백그라운드에 보낸
> 도구까지 빈 셸로 되살아난다.
>
> 필요한 구분은 "백그라운드 도구" 가 아니라 **"열린 Run 의 헤드리스 멤버"** 다.
> 둘은 같은 레지스트리에 살지만 같은 것이 아니다. 즉 이 조항은 **한 줄 삭제가
> 아니라 판별자 도입**이다:
>
> - **규칙이 사라지는 것이 아니라 예외가 하나 생긴다** — "background 이지만 열린
>   Run 이 참조하는 도구는 기록한다"
> - **`toolhub` 가 `run` 을 import 해서는 안 된다.** 의존 방향이 뒤집힌다 (FR-PAT-6
>   에서 `msg` 의 member uuid 해석을 반려한 것과 같은 이유). 술어를 **상위에서
>   주입**하라 — 같은 파일의 `SetForegroundNotifier` 가 선례다
> - `referenced` 집합에 `runs.json` 을 합칠 때 **닫힌 Run 은 제외**한다. 아니면
>   FR-HLM-5 의 고아가 영원히 부활한다
> - **`TestSaveAll_ExcludesBackgroundTools` 를 고치지 말고 옆에 짝을 세워라** —
>   "Run 이 참조하지 않는 백그라운드 도구는 여전히 기록되지 않는다" 가 FR-BG-9 를
>   안 깨뜨렸다는 유일한 증거다. 한쪽만 있으면 다음 사람이 규칙을 통째로 지워도
>   테스트가 울지 않는다
>
> 그 테스트를 **고쳐야만 통과하는 구조**가 나오면 그것은 예외가 아니라 정책
> 교체라는 신호다. 멈추고 재판정을 받아라.

**FR-HLM-4** `dmctl run close` 는 헤드리스 멤버의 Tool 을 **종료한다.** 탭 부착
멤버는 지금처럼 조정자가 `/exit` → `close-tab` 으로 정리하지만, 헤드리스는 닫을 탭이
없으므로 Run 이 소유권을 갖는다. `--keep-tools` 로 남길 수 있다.

**FR-HLM-5** Run 이 `closed`/`aborted` 가 된 뒤에도 남은 헤드리스 Tool 은 **고아**다.
`dmctl run close` 응답과 `dmctl run status` 에 고아 목록을 낸다 (worktree 잔여물과 같은 규약).

#### 3.2.2 부착과 분리

**FR-HLM-6** `dmctl run attach --member <uuid> [--at <탭 uuid>]` 는 헤드리스 멤버의
Tool 을 탭에 연결한다. `--at` 이 없으면 **현재 포커스 분할 칸에 새 탭**을 만든다.
연결 후 `Member.TabID` 가 채워지고 백그라운드 레지스트리에서 빠진다.

**FR-HLM-7** `dmctl run detach --member <uuid>` 는 역이다. 탭을 닫고 Tool 을
백그라운드로 되돌린다. **에이전트 프로세스는 죽지 않는다** — 이것이 detach 의 정의다.

**FR-HLM-8** 부착·분리는 멤버의 `state`·`outcome`·컨텍스트 관측을 **바꾸지 않는다.**
관찰 행위가 관찰 대상을 바꾸지 않는다.

**FR-HLM-9** 기존 백그라운드 도구 모달(`⏻`)의 행 클릭은 지금처럼 "현재 분할 칸의 새
탭으로 복귀" 다. Run 멤버인 헤드리스 도구는 **행에 Run·역할 배지**를 달아 구분하며,
클릭 시 FR-HLM-6 과 같은 결과에 도달한다 (경로가 둘이어도 결과는 하나).

#### 3.2.3 스킬 계약

**FR-HLM-10** `team` 스킬은 헤드리스를 **기본값으로 쓰지 않는다.** 사람이 팀 활동을
지켜보는 것이 이 제품의 이점이므로, 기본은 전용 창 + 탭 부착이다. 헤드리스는 아래
경우에 **권한다**:

- 멤버 수가 4를 넘어 분할이 읽을 수 없게 될 때
- 팬아웃 멤버처럼 개별 화면을 볼 이유가 없을 때
- 승계로 잠깐 살아있는 인수인계 전용 멤버

**FR-HLM-11** 헤드리스 멤버에 대한 **Barrier 는 동일하다** — `dmctl wait --at <탭>`
대신 `dmctl wait --member <멤버 uuid>` 를 받는다. 화면 스크래핑에 의존하지 않으므로
헤드리스에서도 그대로 성립한다.

**FR-HLM-12** `dmctl read-screen --at <헤드리스 Tool uuid>` 는 **동작한다.** 출력
버퍼는 화면 부착 여부와 무관하다. 헤드리스 멤버가 막혔을 때 진단할 유일한 길이므로
막지 않는다.

#### 3.2.4 검증 (묶음 H)

| ID | 시나리오 | 기대 |
|---|---|---|
| V-HLM-1 | `run member --headless` 로 2명 등록 후 `list-workspace` | 워크스페이스 탭 수 불변, 두 도구가 `⏻` 배지에 나타남 |
| V-HLM-2 | 헤드리스 멤버 기동 → `wait --member --for ready` | rc=0 |
| V-HLM-3 | 헤드리스 멤버에 `msg` → `status` | `working` 전이 |
| V-HLM-4 | 데몬 재시작 후 `run status` | 멤버 `state` 가 `lost` 가 아님 (FR-HLM-3) |
| V-HLM-5 | `run attach` → 탭 생김, `run detach` → 탭 사라짐, 그 사이 `status` 불변 | FR-HLM-8 |
| V-HLM-6 | `run close` | 헤드리스 Tool 종료, `⏻` 개수 0 |
| V-HLM-7 | `run close --keep-tools` 후 `run status` | 고아 목록에 남음 |
| V-HLM-8 | `--at` 과 `--headless` 동시 지정 | 오류 + 안내 |

---

### 3.3 묶음 C — 컨텍스트 예산과 승계 (FR-CBG-*)

> **설계 원칙**: 서버는 **감지**하고, 에이전트는 **판단**한다 (C-1).

#### 3.3.1 관측 — 서버는 무엇을 볼 수 있나

**FR-CBG-1** `agentadapter` 의 claude 파서는 훅 페이로드에서 아래를 **추가로** 읽는다.
현재 버려지고 있는 필드들이다.

| 필드 | 쓰임 |
|---|---|
| `session_id` | 멤버 ↔ 에이전트 세션 결속. 승계 시 이전 세션 식별 |
| `transcript_path` | 컨텍스트 소모 **추정**의 원천 |
| `hook_event_name == "PreCompact"` | 컨텍스트 압축 임박 — **확정 신호** |

**FR-CBG-2** 소모 추정은 **transcript 파일의 바이트 크기**로 한다. 서버는 훅이 올 때마다
`stat` 한 번을 수행하며 파일을 읽지 않는다 (NFR-CBG-1). 추정 공식과 임계는
**설정 가능한 상수**로 두고 하드코딩하지 않는다.

```
estimatedTokens ≈ transcriptBytes / bytesPerToken     (기본 bytesPerToken = 3.6)
usageRatio      = estimatedTokens / modelContextLimit  (모델별 표, 미상이면 기본값)
```

**FR-CBG-3** 관측 결과는 `Member` 에 아래 필드로 쌓인다.

```go
ContextBytes   int64  `json:"contextBytes,omitempty"`   // transcript 크기
ContextRatio   float64 `json:"contextRatio,omitempty"`  // 0.0~1.0+ 추정 사용률
ContextLevel   string `json:"contextLevel,omitempty"`   // ok | warn | critical
ContextAt      int64  `json:"contextAt,omitempty"`      // 마지막 관측 시각
CompactCount   int    `json:"compactCount,omitempty"`   // PreCompact 도달 횟수
SessionID      string `json:"sessionId,omitempty"`
SucceededBy    string `json:"succeededBy,omitempty"`    // 승계한 새 멤버 uuid
SucceededFrom  string `json:"succeededFrom,omitempty"`  // 이 멤버가 승계한 이전 멤버 uuid
HandoffSummary string `json:"handoffSummary,omitempty"` // 이 멤버가 후임에게 남긴 요약
```

> `HandoffSummary` 는 **구현 중에 드러난 필요**다 (2026-08-28, WS-3). FR-CBG-9 의
> 3단계는 "새 멤버의 프리앰블에 인수인계 절을 넣는다" 인데, **프리앰블 조립은 승계
> 호출보다 뒤에 일어난다** — 받아 둘 자리가 없으면 요약을 실을 수 없다.

**FR-CBG-4** `ContextLevel` 판정.

| level | 조건 | 뜻 |
|---|---|---|
| `ok` | `ratio < 0.70` | 여유 |
| `warn` | `0.70 ≤ ratio < 0.85` | 새 큰 작업을 주지 않는다 |
| `critical` | `ratio ≥ 0.85` **또는** `CompactCount ≥ 1` | 승계를 검토한다 |

압축이 **한 번이라도** 일어났으면 크기와 무관하게 `critical` 이다 — 압축은 정보가
이미 유실됐다는 뜻이고, 그 시점부터 그 멤버의 산출물은 신뢰도가 떨어진다.

**FR-CBG-5** 추정이 불가능한 경우(`transcript_path` 부재, 파일 접근 실패, 어댑터가
claude 가 아님)에는 **`ContextLevel` 을 비운다.** 0 이나 `ok` 로 채우지 않는다 —
"모른다" 와 "괜찮다" 는 다르다.

#### 3.3.2 통지

**FR-CBG-6** 멤버가 `ok`→`warn` 또는 `→critical` 로 **전이할 때 1회**, 서버는 그 Run 의
조정자 Tool 에 신뢰 채널 엔벨로프를 보낸다. 발신자는 `dongminal-server` 다.

```
[DONGMINAL-AGENT-MSG from=dongminal-server to=<조정자 uuid> ts=<시각>]
[CONTEXT-ALERT run=<short> member=<uuid> role=<역할> level=critical]
추정 사용률 87% (압축 1회). 이 멤버에게 새 작업을 주지 마라.
승계: dmctl run succeed --member <uuid> --at <새 탭 uuid> | --headless
[/DONGMINAL-AGENT-MSG]
```

**FR-CBG-7** 같은 멤버·같은 level 에 대한 통지는 **한 번뿐**이다. 되돌아갔다가
(압축으로 ratio 가 떨어진다) 다시 올라와도 재통지하지 않는다 — 조정자의 컨텍스트를
서버가 오염시키면 본말전도다.

#### `ContextLevel` 은 단조가 아니다 — **닫힘. 코드와 함께가 아니면 고치지 않는다**

**등급은 현재 상태의 표시이고 내려간다.** 단조인 것은 **통지**뿐이다.

- **저장소**(`run`)는 전이를 **감지**만 한다. `entered` = "직전보다 올라갔고
  warn/critical". 하락은 전이가 아니고, **되오름은 전이로 감지한다**
- **통지 계층**(`httpapi`)의 `contextNotices` 가 (멤버, 등급)당 한 번만 내보낸다.
  뮤텍스로 지키고 쓰기 경로를 하나로 모은다
- 통지 기억을 **영속하지 않는다** — epoch 펜싱이 열린 Run 을 재기동 때 전부
  `aborted` 로 만들므로(FR-RUN-5) 기억의 수명이 Run 의 수명과 같다

---

> 🛑 **이 절은 구현 중 아홉 번 뒤집혔다. 그럴 가치가 없는 항목이었다.**
>
> **두 설계의 동작 차이가 거의 없다** (2026-08-28 확인, WS-3):
>
> | 상황 | 단조 | 비단조 |
> |---|---|---|
> | 압축 발생 | `critical` 고정 | `critical` 고정 — **FR-CBG-4 가 담당** |
> | 압축 없이 transcript 축소 | `critical` 유지 | 등급 하락 |
>
> 갈리는 것은 둘째 줄 하나뿐인데, **압축 없이 transcript 가 작아지는 경로는 세션
> 교체(`/clear`)뿐**이고 그것은 이 절이 아래에서 **"알려진 사각지대(미해결)"** 로
> 이미 표시한 자리다. 즉 아홉 번의 논쟁 대상은 **실무에서 거의 발생하지 않고,
> 발생하더라도 스펙이 미해결로 남겨 둔 경우에서만** 갈린다.
>
> **뒤집힌 원인은 논거가 아니라 절차였다.** 담당자는 *문서를 보고 코드를 고치는*
> 규칙(§4.2.3)을, 조정자는 *코드를 보고 문서를 고치는* 규칙을 따랐다. **대칭적
> 추종은 수렴하지 않는다** — 각자가 상대의 몇 분 전 상태를 보고 자기 쪽을 고치기
> 때문이다. 정본이 3~5분마다 움직이면 어떤 규칙도 수렴하지 않는다.
>
> **끝난 방법**: 담당자가 코드를 동결하고, 조정자가 문서를 거기 맞췄다.
>
> **규칙 — 이 절은 문서만 단독으로 바꿀 수 없다.** 반대 방향으로 가야 한다고
> 판단되면 **문서를 고치지 말고 담당자에게 한 줄로 알려라.** 담당자가 코드와 문서를
> **같은 변경에서 함께** 바꾼다. 그것이 이 규칙의 유일한 실행 형태다.

**참고 — 양쪽 논거 (어느 쪽도 결정적이지 않았다):**

| 비단조 (채택) | 단조 (기각) |
|---|---|
| FR-CBG-7 이 "되돌아갔다가 다시 올라와도" 를 규정하므로 되돌아감을 전제한다 | 그 문장의 괄호는 `ratio` 를 가리킨다 — 등급의 왕복이 아니다 |
| "등급 = 현재 상태" 가 단순한 의미론이다 | 컨텍스트는 누적 소모이고 최고 수위가 곧 신뢰도다 |
| 회복 불가능성은 FR-CBG-4 가 이미 담당하므로 등급 단조는 중복이다 | 통지 1회 보장에 별도 상태가 필요 없어진다 |

> **테스트 주석 규약**: 압축 후 등급이 안 내려가는 것은 **FR-CBG-4 때문**이고 그것은
> **압축이 일어난 뒤에만** 참이다. 등급 추적 테스트는 압축을 한 번도 일으키지 말고
> `CompactCount == 0` 을 **단언**하라 — 주석만으로는 다음 사람이 압축을 끼워 넣어도
> 통과해 버린다.

**알려진 사각지대 (미해결, WS-3 발견).** 에이전트가 세션을 새로 시작하면(`/clear`
등) `transcript_path` 가 바뀌고 파일이 작아진다. 비단조이므로 등급은 따라 내려가지만
`CompactCount` 는 이전 세션 값을 그대로 들고 있어, **압축을 겪은 멤버는 새 세션에서도
`critical` 로 남는다.**

`Member.SessionID` 로 "session_id 가 바뀌면 관측을 리셋한다" 를 넣으면 닫힌다.
**지금 열지 않는 이유**는 세션 교체가 정말 회복인지가 판단 사항이기 때문이다 —
컨텍스트는 비지만 **맥락도 함께 사라진다.** FR-CBG-4 의 "유실은 회복되지 않는다" 와
정면으로 만나는 질문이라 별도 FR 로 열어야 한다. "critical 에 박혀 안 내려온다" 는
보고가 오면 원인이 여기다.

**FR-CBG-8** 조정자 Tool 이 죽었거나 없으면 통지를 **건너뛴다.** Run 레코드에는 남는다.

#### 3.3.3 승계

**FR-CBG-9** `dmctl run succeed --member <uuid> (--at <탭 uuid> | --headless) [--model <m>]`
는 아래를 **한 번의 호출로** 수행한다.

1. 이전 멤버에게 인수인계 요약을 요청하는 엔벨로프를 보낸다 — 요청 문안은 서버가
   조립하며, 응답은 `dmctl run handoff --summary -` 로 받는다
2. 응답이 오면(또는 `--timeout-ms` 초과 시 요약 없이) 새 Member 를 만든다.
   `Role`·`Brief`·`Worktree`·`RunID` 를 **그대로 물려받는다**
3. 새 멤버의 프리앰블에 **인수인계 절**을 넣는다 — 이전 멤버의 요약 + "이것은 승계다"
4. 이전 멤버를 `succeeded` 상태로 옮긴다. `Outcome` 은 건드리지 않는다
5. 양쪽에 `SucceededBy`/`SucceededFrom` 을 기록한다

**FR-CBG-10** `succeeded` 는 새 `MemberState` 다. `done` 도 `failed` 도 아니다 —
일을 마친 것이 아니라 **넘긴 것**이다. `run close` 의 미보고 검사에서 `succeeded` 는
**보고한 것으로 친다** (그 일은 승계자가 마친다).

**FR-CBG-11** 승계는 **격리 Run 에서도 성립한다.** 새 멤버는 이전 멤버의 worktree 를
**그대로** 쓴다. 새로 만들지 않는다 — 작업 중인 파일이 거기 있다.

**FR-CBG-12** 이전 멤버의 Tool 은 승계 후 자동 종료하지 **않는다.** 조정자가
`/exit` → `close-tab`(또는 헤드리스면 `run close`) 로 정리한다. 인수인계가 불완전할 때
되돌아가 읽을 수 있어야 한다.

#### 3.3.4 표시

**FR-CBG-13** `dmctl run status` 의 멤버 행에 컨텍스트를 낸다. 추정임이 드러나야 한다.

```
member=<uuid> role=작가 state=working ctx=~72% (warn) compact=0
member=<uuid> role=비평가 state=working ctx=— (unknown)
```

**FR-CBG-14** `ContextLevel` 이 `warn` 이상인 멤버가 있으면 `run status` **머리줄**에
요약을 낸다. 조정자가 멤버 목록을 끝까지 읽지 않아도 보이게.

#### 3.3.5 비기능 (묶음 C)

- **NFR-CBG-1** 훅 1회당 파일시스템 접근은 `stat` **1회**를 넘지 않는다. transcript 를
  읽거나 파싱하지 않는다. 훅은 에이전트의 핫패스다.
- **NFR-CBG-2** 추정 실패는 훅 처리를 실패시키지 않는다. 관측 층의 오류가 activity·
  attention 보고를 막으면 안 된다.
- **NFR-CBG-3** 모든 표시에 `~` 또는 `추정` 표기를 붙인다 (C-4).

#### 3.3.6 검증 (묶음 C)

| ID | 시나리오 | 기대 |
|---|---|---|
| V-CBG-1 | 가짜 transcript 파일 크기를 단계적으로 키우며 훅 주입 | `ContextLevel` 이 ok→warn→critical 로 전이 |
| V-CBG-2 | `PreCompact` 훅 1회 주입 (크기는 작게) | 즉시 `critical`, `CompactCount=1` |
| V-CBG-3 | `transcript_path` 없는 훅 | `ContextLevel` 빈 값 (`ok` 아님) |
| V-CBG-4 | warn 전이 → critical 전이 → warn 재전이 | 통지 2회 (warn 1, critical 1). 재전이 통지 없음 |
| V-CBG-5 | 조정자 Tool 죽은 상태에서 전이 | 통지 생략, 레코드는 갱신, 오류 없음 |
| V-CBG-6 | `run succeed` (격리 Run) | 새 멤버가 **같은 worktree 경로**, 이전 멤버 `succeeded` |
| V-CBG-7 | 이전 멤버 무응답 상태에서 `run succeed --timeout-ms 1000` | 요약 없이 승계 성공, 프리앰블에 "요약 없음" 명시 |
| V-CBG-8 | `succeeded` 멤버만 남은 Run 에 `run close` | `--force` 없이 성공 (FR-CBG-10) |
| V-CBG-9 | 훅 처리 중 transcript stat 실패 주입 | activity 보고는 정상 (NFR-CBG-2) |

---

### 3.4 묶음 P — 패턴 카탈로그 (FR-PAT-*)

> 대부분 문서다 — `agentplugin/skills/team/` 이 바뀐다. **예외는 §3.4.1 의 P2P
> 봉인 해제 둘**이다: `dmctl run peers` (신설)와 프리앰블의 통신 규약 절. 이 둘은
> 코드이며, 없으면 카탈로그의 8패턴 중 5개가 **문서상으로만 존재**한다.

**FR-PAT-1** `references/patterns.md` 를 신설한다. 각 패턴은 **같은 6절 형식**을 지킨다.

1. **언제 쓰나** — 작업의 성격 (한 문장)
2. **언제 쓰지 않나** — 오용 사례
3. **멤버 구성** — 역할과 최소 인원
4. **토폴로지** — 누가 누구에게 말하는가 (ASCII 다이어그램)
5. **종료 조건** — 무엇으로 끝났다고 판정하는가
6. **dmctl 시퀀스** — 그대로 실행 가능한 스니펫

**FR-PAT-2** 카탈로그에 담을 패턴은 아래 8종이다. **통신** 열은 §3.4.1 의 멤버 간
직접 통신(P2P)이 그 패턴의 **본질인지 아닌지**를 가른다 — 이 구분이 패턴 선택의
절반이다.

| 패턴 | 언제 | 최소 구성 | 통신 |
|---|---|---|---|
| **supervisor-worker** | 독립적인 동종 서브태스크 N개 | 조정자 + worker N | 성형 (P2P 없음) |
| **pipeline** | 단계가 순서를 갖고, 앞 단계 산출물이 뒤의 입력 | 단계당 1명, 직렬 | **P2P 필수** — 인접 단계끼리 |
| **debate (GAN)** | 품질이 대립에서 오는 일 — 글·설계·리뷰 | 생성자 + 비평가 (+ 심판) | **P2P 필수** — 왕복이 곧 패턴 |
| **reflection** | 혼자서도 되지만 스스로 검토가 필요한 일 | 생성자 + 검토자 2인 루프 | **P2P 필수** |
| **map-reduce fan-out** | 넓은 탐색 후 종합 — 리서치·코드베이스 조사 | 팬아웃 N (헤드리스 권장) + 종합자 1 | 성형 + 종합자에게 1방향 |
| **blackboard** | 공유 산출물을 여럿이 점진적으로 쌓는 일 | 멤버 N + 공유 파일 규약 | **P2P 권장** — 쓰기 알림 |
| **hierarchical** | 서브태스크가 다시 팀을 필요로 할 만큼 큰 일 | 조정자 + 중간 조정자 + 말단 | 계층 내 P2P |
| **red-team** | 만든 것을 깨뜨려 봐야 하는 일 — 보안·견고성 | 구현자 + 공격자 + 심판 | **P2P 필수** — 3자 |

**FR-PAT-3** `SKILL.md` 에 **선택 결정표**를 넣는다. 작업 성격에서 패턴으로 가는
단일 진입점이며, 조정자가 여기서 한 번에 고를 수 있어야 한다.

| 작업이 이렇게 생겼으면 | 패턴 |
|---|---|
| 같은 종류의 일이 N개, 서로 안 봐도 된다 | supervisor-worker (헤드리스) |
| 순서가 있다. B는 A의 결과가 있어야 시작한다 | pipeline |
| 정답이 없고 **더 나은 것**을 찾는다 | debate |
| 넓게 찾아서 하나로 모은다 | map-reduce fan-out |
| 만든 것의 결함을 찾아야 한다 | red-team |
| 서브태스크 하나가 혼자 팀만큼 크다 | hierarchical |

**FR-PAT-4** `SKILL.md` 에 **1멤버 1역할 1관심사** 규칙을 명문화한다 (접수 항목 1).

- 한 멤버의 `--brief` 는 **한 종류의 일**만 담는다. "구현하고 테스트도 짜고 문서도
  써라" 는 셋으로 쪼갠다
- 서로 다른 관심사를 한 멤버에 몰면 그 멤버의 컨텍스트가 셋 몫으로 차고, 산출물의
  품질은 셋 다 떨어진다
- 멤버는 **재사용하지 않는다.** 일이 끝난 멤버에게 다음 일을 주지 말고, 새 멤버를 만든다
- 이 규칙의 위반은 묶음 C 의 `contextLevel` 로 **관측된다** — 규칙과 계측이 짝이다

#### 3.4.1 멤버 간 직접 통신 (P2P) — 문서가 막고 있던 1급 기능

**조사로 확정한 사실.** `dmctl msg --to <uuid>` 에는 발신자·수신자가 조정자여야 한다는
제약이 **없다.** 멤버끼리 서로에게 직접 말할 수 있고, 서버는 이미 그것을 실어 나른다.
그런데 실제 팀은 거의 성형(star)으로만 돈다. 이유가 둘이다.

1. **멤버가 동료의 uuid 를 모른다.** 프리앰블은 `dmctl run member` 시점에 조립되므로,
   **그 시점에 아직 등록되지 않은 동료**는 담길 수 없다. 첫 멤버의 프리앰블에는 동료가
   0명이고, 마지막 멤버만 전원을 안다. 상대를 지목할 수 없으니 말을 걸 수 없다.
2. **스킬이 금지로 읽힌다.** `SKILL.md` §3 은 "brief 에 다른 팀원에게 말을 거는
   지시를 넣지 마라 — 상대가 아직 없을 때 송신해 데드락이 된다" 고 적는다. 이는
   **기동 시점의 순서 문제**를 말한 것인데, 조정자는 이를 *팀원 간 통신 자체의 금지*
   로 읽는다.

이 둘이 겹쳐 P2P 가 사실상 봉인돼 있다. §3.4 의 8패턴 중 **6개가 P2P 를 본질로
한다** — 봉인을 풀지 않으면 카탈로그를 써도 패턴이 늘지 않는다.

**FR-PAT-5** 멤버는 동료 명부를 **스스로 조회**할 수 있다 — `dmctl run peers`
(신설, 인자 없음). 발신자 정체(`$DONGMINAL_TOOL_ID`)로 자기가 속한 Run 을 찾아,
**자기를 제외한** 동료의 `role`·`member uuid`·`state`·`headless` 를 낸다.

```
role=비평가     member=<uuid>  state=working  headless=false
role=검수       member=<uuid>  state=idle     headless=true
```

프리앰블에 명부를 **박아 넣지 않는다.** 명부는 시간에 따라 변하고(승계·이탈), 박아
넣으면 낡는다. 대신 프리앰블에는 `dmctl run peers` 를 부르라는 **한 줄**이 들어간다
(FR-PAT-6).

**FR-PAT-6** 멤버 프리앰블에 **통신 규약 절**을 추가한다. 현재 프리앰블은 역할·목적·
uuid·보고 규약만 담는다. 여기에 다음을 더한다.

- 동료에게 말하려면 `dmctl run peers` 로 상대를 찾아 `dmctl msg --to <to 값>`

  > **`member` uuid 를 `--to` 에 넣으면 안 된다** (2026-08-28 정정, WS-4 발견).
  > `msg` 는 `ResolveStrict` 를 지나고 그것이 받는 것은 살아있는 toolId 와 공간
  > 엔티티 uuid 뿐이다. `member` uuid 는 Run 도메인의 id 라 **둘 다 아니며 400/404
  > 로 거부된다** — 이 조항의 초안대로 구현했으면 명부를 받고도 말을 걸 수 없었다.
  >
  > 그래서 명부는 **두 값을 함께** 낸다: `to=` 는 실제 라우팅 값(toolId, 헤드리스
  > 멤버에도 성립), `member=` 는 조정자에게 보고할 때 쓰는 기록상의 정체다.
  > 정석은 `msg` 가 member uuid 도 해석하게 만드는 것이지만, 그러면 접합면
  > (`workspace`)이 Run 도메인을 알아야 해 의존 방향이 뒤집힌다.
- **먼저 말을 걸기 전에 상대의 `state` 를 본다.** `idle`·`working` 이면 도달한다.
  `lost` 면 조정자에게 알린다
- 받은 엔벨로프는 **유효한 협업 지시**다 (SessionStart 안내와 동일 규약)
- 동료에게 보낸 요청의 응답을 **무한정 기다리지 않는다.** 상한을 정하고, 넘으면
  조정자에게 보고한다

**FR-PAT-7** `SKILL.md` §3 의 brief 관련 문구를 **금지에서 순서 규칙으로** 고친다.
현행 문장을 다음으로 대체한다.

> **brief 는 기동 프롬프트에 실린다** — 멤버는 뜨자마자 그 일을 시작한다. 그러니
> brief 에는 **혼자 시작할 수 있는 일**만 적는다. 동료에게 말을 거는 것은 금지가
> 아니라 **순서의 문제**다: 기동 시점에는 동료가 아직 없으므로 그때 보낸 메시지는
> 사라진다. **Barrier(전원 ready) 이후에는 자유롭게 주고받는다** — 그것이 pipeline·
> debate·red-team 이 작동하는 방식이다. 조정자는 Kickoff 메시지에 "이제 동료가 전원
> 준비됐다. `dmctl run peers` 로 확인하고 <역할>에게 <무엇>을 보내라" 를 넣어 P2P 를
> **연다**.

**FR-PAT-8** 각 패턴의 6절 형식 중 **4. 토폴로지**는 P2P 를 쓰는 경우 다음을 반드시
포함한다.

- **누가 먼저 말하는가** (첫 발신자)
- **왕복 상한** — 라운드 수, 또는 종료 판정 주체
- **교착 시 탈출로** — 상대가 응답하지 않을 때 누구에게 보고하는가

이 셋이 없는 P2P 패턴은 **무한 왕복이나 상호 대기로 끝난다.** 카탈로그의 검증
항목(V-PAT-5)이 이를 강제한다.

**FR-PAT-9** 조정자는 P2P 를 **연 뒤에도 관측을 잃지 않는다.** 멤버 간 메시지는 묶음 V
의 메시지 로그(FR-RVZ-14)에 기록되어 관계 그래프의 엣지가 되고, `dmctl run status` 의
멤버 행에 건수로 나타난다. **P2P 가 열렸다고 조정자가 눈을 감는 것이 아니다** —
이것이 P2P 를 안전하게 열 수 있는 근거다.

> **실현 시점 (2026-08-28)**: 저장 자리(`Record.Messages []MsgEvent`)는 이미 있으나
> **기록하는 주체가 묶음 V** 다. 묶음 P 가 먼저 들어가면 **P2P 는 열렸는데 관측은
> 비어 있는 구간**이 생긴다. 그 구간에서 P2P 검증(V-PAT-6, 시나리오 4~6 의 멤버간
> 간선 확인)은 기계로 할 수 없고 사람이 화면으로 봐야 한다.
>
> 건수는 `Record.Messages` 집계로 낸다 — `Member` 에 카운터를 두지 않는다. 상한
> (500건)을 넘겨 잘린 뒤의 집계가 실제보다 작아질 수 있으나, 그 규모의 Run 에서
> 정확한 누계보다 **최근 흐름**이 조정자에게 유용하다.

**FR-PAT-10** `references/models_and_patterns.md` 의 기존 "패턴 카탈로그" 절은
`patterns.md` 로 옮기고 **모델 선택 가이드만 남긴다.** 같은 내용이 두 곳에 있으면
갈라진다. 남은 것이 모델 가이드뿐이므로 그 파일은 **`references/models.md`** 로
개명한다 — 이름이 내용과 어긋나면 다음 사람이 패턴을 거기서 찾는다.

> **개명 기록 (2026-08-28, 조정자).** WS-4 가 개명을 제안하고 파일명을 못 박은
> 이 문장과 V-PAT-2 가 조정자 소유라 미뤄 뒀던 항목이다. 개명과 이 두 줄은
> **같은 변경에 담는다** — 문서만 먼저 고치면 검증이 없는 파일을 가리키고,
> 파일만 먼저 고치면 검증이 없어진 파일을 가리킨다.

**FR-PAT-11** `evals/test-scenarios.md` 에 패턴별 시나리오를 **최소 3종**(debate,
map-reduce, pipeline) 추가한다. debate 시나리오는 **P2P 왕복이 실제로 일어났는지**를
메시지 로그로 검증한다 — 성형으로 퇴화하면 실패다.

#### 검증 (묶음 P)

| ID | 시나리오 | 기대 |
|---|---|---|
| V-PAT-1 | `patterns.md` 의 모든 dmctl 스니펫을 셸 문법 검사 | 전부 통과 (`bash -n`) |
| V-PAT-2 | `models.md`(구 `models_and_patterns.md`) 에 패턴 카탈로그 잔재 검색 | 0건 (FR-PAT-10) |
| V-PAT-3 | `SKILL.md` 결정표의 모든 패턴이 `patterns.md` 에 존재 | 8/8 |
| V-PAT-4 | 실제 debate Run 을 스킬대로 수행 | 종료 조건까지 도달 |
| V-PAT-5 | `patterns.md` 의 P2P 패턴 5종이 §FR-PAT-8 의 세 항목(첫 발신자·왕복 상한·탈출로)을 전부 갖는지 | 5/5 |
| V-PAT-6 | 멤버가 `dmctl run peers` 로 동료 uuid 를 얻어 직접 msg 를 보낸다 | 도달 + 메시지 로그에 멤버→멤버 엣지 기록 |
| V-PAT-7 | `run peers` 를 Run 에 속하지 않은 도구에서 호출 | 거부 |
| V-PAT-8 | 승계된 멤버가 `run peers` 결과에서 사라지고 후임이 나타난다 | 명부가 낡지 않음 (FR-PAT-5 근거) |

---

### 3.5 묶음 V — Run 시각화 (FR-RVZ-*)

#### 3.5.1 진입 — 상단바 버튼과 모달

**FR-RVZ-1** 상단바 버튼 구성을 아래 순서로 한다. `Runs` 가 신설이다.

```
[Split H] [Split V] [Runs] [Agents]        (desktop-only, 기존 attn-badge·git-close 유지)
```

**FR-RVZ-2** `Runs` 클릭 시 **중앙 모달**이 열린다. 백그라운드 도구 모달(`bg-modal`)과
같은 상호작용 규약을 쓴다 — 배경 클릭·`Esc` 로 닫히고, 오버레이 자신이 대상일 때만 닫힌다.

**FR-RVZ-3** 모달은 Run 목록을 **최근순**으로 낸다. 행마다:

| 항목 | 비고 |
|---|---|
| `short` + 목적(objective) | 목적은 한 줄로 자름 |
| 상태 배지 | `open`/`closed`/`aborted` |
| 멤버 수 | `n명` (헤드리스 수를 괄호로: `4명(2 헤드리스)`) |
| 격리 | `none` 이면 표시하지 않음 |
| 컨텍스트 경고 | `warn`/`critical` 멤버가 있으면 배지 |
| 경과 | 생성 시각 상대 표기 |

**FR-RVZ-4** 빈 목록이면 "진행 중인 Run 이 없다" 와 `/dongminal:team` 안내를 낸다.

**FR-RVZ-5** 행 클릭 시 모달이 닫히고, **현재 포커스 분할 칸에 새 탭**이 생기며 그
탭에 대시보드가 렌더된다.

#### 3.5.2 탭 — 네 번째 탭 타입

**FR-RVZ-6** 탭 타입 `'run'` 을 추가한다. `TAB_TYPE_GIT`·`'editor'` 와 같은 층위이며,
`addTab(rid, 'run', {runId})` 로 생성한다.

**FR-RVZ-7** 같은 Run 의 탭이 **이미 열려 있으면 새로 만들지 않고 그 탭으로 포커스를
옮긴다.** `app-layout.js:122` 의 editor 중복 방지와 같은 규약이다.

**FR-RVZ-8** 탭 이름은 `Run <short>` 이다. 사용자가 rename 하면 그것이 이긴다
(`CONVENIENCE_SRS` FR-TAN-4 와 같은 규약).

**FR-RVZ-9** Run 탭은 **워크스페이스에 영속된다.** 새로고침 후에도 남으며, 참조하는
Run 이 사라졌으면 "이 Run 은 더 이상 없다" 를 렌더한다 (탭을 자동으로 닫지 않는다 —
사용자가 만든 것은 사용자가 닫는다).

#### 3.5.3 대시보드 내용

**FR-RVZ-10** 대시보드는 **네 영역**으로 구성한다.

```
┌─ 요약 ────────────────────────────────────────────────┐
│ Run <short>  목적: …   state=open  isolation=per-member│
│ 패턴: debate   경과 12분   멤버 4 (헤드리스 2)          │
├─ 관계 그래프 ─────────────────────────────────────────┤
│         ┌──────────┐                                   │
│         │ 조정자    │                                   │
│         └────┬─────┘                                   │
│      ┌───────┼───────┐                                 │
│   ┌──▼──┐ ┌──▼──┐ ┌──▼──┐   ← 노드=멤버               │
│   │작가 │↔│비평가│ │심판 │   ← 실선=메시지 흐름         │
│   └─────┘ └─────┘ └─────┘   ← 점선=헤드리스           │
├─ 멤버 카드 ───────────────────────────────────────────┤
│ [작가] claude · working · ctx ~72% ⚠ · wt: …/a1b2      │
│ [비평가] claude · waiting · ctx ~31% · (헤드리스)      │
├─ 타임라인 ────────────────────────────────────────────┤
│ 12:03 run start   12:04 member×4   12:05 launch …     │
└───────────────────────────────────────────────────────┘
```

> **정정 (2026-08-28, 조정자 판정 — 최종 확정, 뒤집기 0회).** 위 도해의 `패턴: debate`
> 행은 **그리지 않는다.** Run 레코드에 패턴을 담는 필드가 없고(`run.Record` 확인),
> `run start` 에도 패턴을 받는 경로가 없다. 패턴은 스킬 문서가 조정자에게 주는
> 선택지일 뿐 서버가 관측하는 사실이 아니다.
>
> 필드를 신설하지 않는 이유는 범위가 아니라 **NFR-RVZ-4** 다 — "시각화에만 있는
> 정보는 없다. 모든 항목이 `dmctl run status` 로도 읽힌다." `run status` 에 패턴이
> 없으므로 대시보드에 패턴을 그리면 그 규칙을 어기는 쪽이 된다.
>
> 도해의 나머지 요약 항목(`short`·목적·`state`·`isolation`·경과·멤버 수·헤드리스 수)은
> 전부 레코드에서 나오므로 그대로 그린다. **FR-RVZ-10 이 요구하는 것은 네 영역이지
> 도해의 문자열이 아니다.**

**FR-RVZ-11** 관계 그래프는 **SVG 로 직접 그린다** (C-3). 레이아웃은 계층형 고정
배치로 한다 — 조정자를 최상단에, 멤버를 그 아래 한 줄에 균등 배치하고, 멤버 간 엣지는
호(arc)로 그린다. 물리 시뮬레이션·힘 기반 배치를 쓰지 않는다 (결정론적이어야 하고,
같은 Run 은 볼 때마다 같은 모양이어야 한다).

**FR-RVZ-12** 노드 시각 규약.

| 요소 | 표현 |
|---|---|
| 상태 | 테두리 색 — `working`(강조) `waiting`(주의) `done`(성공) `failed`(오류) `lost`(흐림) `succeeded`(점선 + 승계 화살표) |
| 헤드리스 | 점선 테두리 |
| 컨텍스트 | 노드 하단 게이지 바. `warn`=주의색, `critical`=오류색 |
| 승계 관계 | 이전 멤버 → 새 멤버로 **굵은 화살표** |
| 메시지 흐름 | 엣지 굵기 = 건수(로그 스케일), 방향 화살표, 최근 30초 내 통신은 강조 |

**색은 하드코딩하지 않는다** — 테마 변수를 쓴다.

**FR-RVZ-13** 카드 클릭 시 그 멤버의 도구로 **포커스 점프**한다. 헤드리스 멤버면
`run attach` 와 같은 결과(현재 분할 칸의 새 탭)에 도달한다.

#### 3.5.4 데이터 — 메시지 로그

**FR-RVZ-14** Run 레코드에 **메시지 로그**를 추가한다. `dmctl msg` 가 성공적으로
전달될 때마다 한 건씩 쌓는다.

```go
type MsgEvent struct {
    From string `json:"from"`           // 발신 멤버 uuid (조정자는 "coordinator")
    To   string `json:"to"`             // 수신 멤버 uuid
    At   int64  `json:"at"`
    Kind string `json:"kind,omitempty"` // agent | server-alert
    Size int    `json:"size"`           // 본문 바이트 수
}
```

- **본문은 담지 않는다.** 팀 통신은 산출물이 아니라 과정이고, 영속시킬 이유가 없다.
  또한 본문에는 코드·비밀이 실릴 수 있다 (NFR-RVZ-3)
- Run 당 **최근 500건**만 보관한다. 초과분은 앞에서 버린다
- 발신·수신 중 어느 쪽도 그 Run 의 멤버가 아니면 **기록하지 않는다** — 팀 밖 통신은
  Run 의 관심사가 아니다

**FR-RVZ-15** `GET /api/runs/<id>/graph` 를 추가한다. 대시보드가 쓰는 단일 종단이며
멤버·엣지·타임라인을 한 번에 낸다. 대시보드는 이 응답만으로 완전히 렌더한다.

**FR-RVZ-16** 갱신은 **SSE** 로 한다 — 새 이벤트 타입 `run_changed`(payload: runId).
받으면 열려 있는 Run 탭이 `/graph` 를 다시 부른다. 폴링하지 않는다. 열린 Run 탭이
없으면 아무 요청도 나가지 않는다.

#### 3.5.5 비기능 (묶음 V)

- **NFR-RVZ-1** 대시보드 렌더는 멤버 20명·엣지 500건에서 16ms 안에 끝난다.
- **NFR-RVZ-2** 그래프 다시 그리기는 `repaint.js` 의 보존 규약을 따른다 — 갱신이
  hover·선택·툴팁을 깨뜨리지 않는다 (`GIT_REVIEW4_SRS` 가 세운 공통 수단).
- **NFR-RVZ-3** 메시지 본문·brief 전문·transcript 경로는 **API 응답에 싣지 않는다.**
- **NFR-RVZ-4** 시각화에만 있는 정보는 없다 — 모든 항목이 `dmctl run status` 로도
  읽힌다 (§2.3).

#### 3.5.6 검증 (묶음 V)

| ID | 시나리오 | 기대 |
|---|---|---|
| V-RVZ-1 | Run 0개 상태에서 `Runs` 클릭 | 빈 안내 모달 |
| V-RVZ-2 | Run 2개 상태에서 행 클릭 | 모달 닫힘 + 현재 분할 칸에 새 탭 + 대시보드 |
| V-RVZ-3 | 같은 Run 행을 다시 클릭 | 새 탭이 생기지 않고 기존 탭으로 포커스 (FR-RVZ-7) |
| V-RVZ-4 | 대시보드 열린 채 `dmctl msg` 송신 | SSE 로 엣지가 갱신됨. 폴링 요청 0건 |
| V-RVZ-5 | 멤버 4명(헤드리스 2) Run | 점선 노드 2개, 실선 2개 |
| V-RVZ-6 | `critical` 멤버 존재 | 노드 게이지 오류색 + 모달 행 배지 |
| V-RVZ-7 | `run succeed` 후 | 승계 화살표가 그려짐 |
| V-RVZ-8 | Run 탭 연 채 새로고침 | 탭 유지 + 대시보드 복원 (FR-RVZ-9) |
| V-RVZ-9 | Run 삭제 후 그 탭 | "더 이상 없다" 렌더, 탭 유지 |
| V-RVZ-10 | `/api/runs/<id>/graph` 응답 | brief 전문·메시지 본문·transcript 경로 없음 (NFR-RVZ-3) |
| V-RVZ-11 | 501건 송신 후 graph | 엣지 이벤트 500건 (FR-RVZ-14) |
| V-RVZ-12 | 그래프 hover 중 SSE 갱신 | hover 유지 (NFR-RVZ-2) |

---

## 4. 인터페이스 요구사항

### 4.1 dmctl 신설·개정

```
dmctl run member --run <uuid> --role <이름> --agent <id>
                 (--at <탭 uuid> | --headless) [--brief -]   # --headless 신설
dmctl run attach --member <uuid> [--at <탭 uuid>]            # 신설
dmctl run detach --member <uuid>                             # 신설
dmctl run succeed --member <uuid> (--at <uuid> | --headless)
                  [--model <m>] [--timeout-ms N]             # 신설
dmctl run handoff --summary -                                # 신설 (승계 대상이 호출)
dmctl run peers                                              # 신설 (멤버가 호출 — 동료 명부)
dmctl wait (--at <uuid> | --member <uuid>) --for ready|done  # --member 신설
```

### 4.2 HTTP 종단

| 메서드 | 경로 | 신설/개정 |
|---|---|---|
| `POST` | `/api/tools/headless` | 신설 — 탭 없는 Tool 생성 |
| `POST` | `/api/runs/attach` | 신설 |
| `POST` | `/api/runs/detach` | 신설 |
| `POST` | `/api/runs/succeed` | 신설 |
| `POST` | `/api/runs/handoff` | 신설 |
| `GET` | `/api/runs/peers` | 신설 — 호출자 정체로 Run 을 찾아 동료 명부 (FR-PAT-5) |
| `GET` | `/api/runs/{id}/graph` | 신설 — 대시보드 단일 종단 |
| `GET/POST` | `/api/tools/{screen,output,input,message,status,wait}` | 개정 — `ResolveStrict` (FR-IDU-4) |
| `POST` | `/api/runs/members` | 개정 — `headless` 필드 |

### 4.3 SSE 이벤트

| 이벤트 | payload | 계기 |
|---|---|---|
| `run_changed` | `{runId}` | Run·멤버 상태 전이, 메시지 기록, 컨텍스트 level 전이 |

---

## 5. 비기능 요구사항 (전역)

- **NFR-ORC-1** 묶음 I 는 **행위를 좁히는 변경**이다. 좁혀지는 것은 라벨 입력뿐이며
  uuid 입력의 동작은 한 건도 바뀌지 않는다.
- **NFR-ORC-2** 헤드리스 멤버는 화면 부착 멤버와 **관측·제어에서 동등**하다. 두 종류
  사이에 능력 차이를 만들지 않는다 (FR-HLM-12 가 그 최소선).
- **NFR-ORC-3** 시각화에만 있는 정보는 없다 (§2.3, FR-RVZ NFR-RVZ-4).
- **NFR-ORC-4** 새 상태·필드는 전부 `omitempty` 다. 기존 `runs.json` 을 읽을 때
  마이그레이션 없이 열려야 하고, 새 필드는 빈 값이 "모른다" 를 뜻한다.

---

## 6. 비목표 (Non-goals)

1. **서버가 멤버를 자동 교체하지 않는다.** 컨텍스트 고갈 시 서버는 알리고 멈춘다 (C-1).
2. **패턴을 서버가 강제하지 않는다.** 묶음 P 는 문서다. `--pattern` 플래그로 토폴로지를
   검증하는 안은 채택하지 않았다 — 결정 근거는 §7.
3. **메시지 본문을 영속하지 않는다** (FR-RVZ-14).
4. **외부 그래프 라이브러리를 쓰지 않는다** (C-3).
5. **`--expose` 인증과 cross-platform 지원은 본 SRS 밖이다.** 각각 독립 SRS 로 다룬다
   (`PARALLEL_DELIVERY_PLAN` §6).
6. **라벨을 레이아웃 명령에 되살리지 않는다** (FR-IDU-5).
7. **Run 히스토리 분석·리플레이는 하지 않는다.** 타임라인은 현재 Run 의 것만이다.

---

## 7. 결정 기록 (Decision Log)

| # | 결정 | 대안 | 근거 |
|---|---|---|---|
| D-1 | 라벨 차단은 **IO·오케스트레이션 경로만** | 라벨 전면 제거 / 단계적 경고 | 레이아웃 경로는 이미 uuid 전용이었다. 전면 제거는 `list-workspace` 의 표시 가치까지 없앤다 |
| D-2 | 컨텍스트는 **서버 추적 + 경고 + 승계** | 스킬 지침만 / 자동 교체 | 지침은 계측이 없어 위반을 알 수 없다. 자동 교체는 "조정자는 에이전트다" 라는 기존 설계와 충돌하고 오동작 피해가 크다 |
| D-3 | 패턴은 **문서만** | 서버 `--pattern` 선언·검증 | 패턴은 아직 안정되지 않았다. 서버가 검증부터 하면 새 패턴을 쓸 때마다 서버를 고쳐야 한다. 카탈로그가 실사용으로 굳은 뒤에 선언화한다 |
| D-4 | 헤드리스 멤버를 **이번에 포함** | uuid 전환만 하고 후속 | 둘은 같은 문제의 두 얼굴이다 — 라벨을 끊는 이유가 "화면 배치에서 자유로워지려고" 이고, 헤드리스가 그 자유의 실체다. 나누면 전환의 목적이 절반만 달성된다 |
| D-5 | 시각화 진입은 **상단바 → 모달 → 탭** | 사이드바 탭 / 독립 창 | 사용자 지정. 부수 효과로 Git 사이드바 개편(`GIT_SIDEBAR_TABS_SRS`)과 **파일 충돌이 없다** — 한쪽은 상단바, 한쪽은 사이드바다 |
| D-6 | 그래프는 **결정론적 고정 배치** | 힘 기반 레이아웃 | 같은 Run 이 볼 때마다 다른 모양이면 읽는 사람이 매번 다시 해석해야 한다. 그리고 e2e 로 검증할 수 없다 |

---

## 8. 미해결 (Open Issues)

| # | 질문 | 잠정 |
|---|---|---|
| O-1 | `bytesPerToken` 기본값 3.6 의 근거 | 한국어·코드 혼재 transcript 로 실측해 조정한다. 상수이므로 나중에 바꿔도 계약이 안 깨진다 |
| O-2 | codex 등 claude 외 어댑터의 컨텍스트 관측 | 현재 신호 없음 → `ContextLevel` 빈 값 (FR-CBG-5). 어댑터가 신호를 갖게 되면 그때 연다 |
| O-3 | 헤드리스 Tool 의 `cols/rows` 고정값 120x40 | TUI 출력 폭에 영향. 실사용에서 잘림이 보이면 조정 |
