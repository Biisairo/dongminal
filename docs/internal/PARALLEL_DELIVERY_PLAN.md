# 병렬 실행 계획 — 오케스트레이션 · Git 사이드바 · 편의 기능

> 세 SRS 를 하나의 실행으로 묶는 문서. **무엇을 만드는가**는 각 SRS 에 있고, 이
> 문서는 **어떻게 동시에, 안전하게, 최단으로 만드는가**를 정한다.
>
> 갱신: 2026-08-28 (착수 전)

---

## 1. 지도

| 축 | SRS | 묶음 | 성격 |
|---|---|---|---|
| **오케스트레이션** | [`ORCHESTRATION_V2_SRS.md`](./ORCHESTRATION_V2_SRS.md) | I·H·C·P·V | Go 중심 + 프론트 신규 |
| **Git** | [`GIT_SIDEBAR_TABS_SRS.md`](./GIT_SIDEBAR_TABS_SRS.md) | FR-SBT-1~33 | 프론트 전용 |
| **편의** | [`CONVENIENCE_SRS.md`](./CONVENIENCE_SRS.md) | N·X | Go(데몬) + 프론트 |

접수한 항목과 SRS 의 대응은 다음과 같다. **누락 없음**을 여기서 고정한다.

| 접수한 말 | 처리 |
|---|---|
| 오케스트레이션 1 — 한 에이전트에 여러 일 → 컨텍스트 오염 | ORCH 묶음 **C** (관측·승계) + 묶음 **P** FR-PAT-4 (규칙) |
| 오케스트레이션 2 — 모든 동작을 uuid 로, 백그라운드 세션 | ORCH 묶음 **I** + 묶음 **H** |
| 오케스트레이션 3 — 패턴 고도화 | ORCH 묶음 **P** (+ P2P 봉인 해제 §3.4.1) |
| 오케스트레이션 4 — Run 시각화 | ORCH 묶음 **V** |
| 편의 1 — 프로세스 이름 → 탭 이름 | CNV 묶음 **N** |
| 편의 2 — 백그라운드 창 종료 버튼 | CNV 묶음 **X** |
| 편의 3 — expose 사용자 제한 | **후속 트랙 A** (§8) |
| 편의 4 — cross platform | **후속 트랙 B** (§8) |
| git 1 — window/git 을 좌측 상단 탭으로 | SBT 전량 |

---

## 2. 확정된 결정 (2026-08-28)

착수 전 인터뷰로 닫았다. **이 표가 스펙보다 앞선다** — 스펙이 이와 어긋나면 스펙이 틀렸다.

| # | 결정 | 반영처 |
|---|---|---|
| 1 | 라벨은 **레이아웃 명령에만** 허용. 접합면은 uuid 전용 | ORCH FR-IDU-* |
| 2 | 헤드리스 멤버를 **이번 범위에 넣는다** | ORCH 묶음 H |
| 3 | 컨텍스트는 **서버 추적 + 경고 + 승계**. 자동 교체는 안 한다 | ORCH 묶음 C |
| 4 | 패턴은 **스킬 문서만** 확장. 서버는 패턴을 모른다 | ORCH 묶음 P |
| 5 | Run 시각화는 **상단바 버튼 → 모달 → 현재 포커스에 새 탭** | ORCH 묶음 V |
| 6 | Git 은 **탭 선택이 Git 창까지 전환** | SBT FR-SBT-22~25 (+ FR-SBT-15 개정) |
| 7 | 사이드바 탭은 **마지막 선택을 기억** | SBT FR-SBT-6/7 |
| 8 | Git 탭 배지는 **변경 있는 리포 개수** | SBT FR-SBT-12 (기존 결정 추인) |
| 9 | 단축키: **탭마다 직행 키 신설**(토글 아님), 순회는 창 순회와 **같은 키**를 활성 탭 기준으로 재해석. **탭 인터페이스화** | SBT FR-SBT-26~33 |
| 10 | 탭 이름은 **수동이 자동을 이긴다** | CNV FR-TAN-15 |
| 11 | expose 인증 · cross-platform 은 **독립 후속** | §8 |
| 12 | 자식 에이전트끼리 **직접 대화한다.** 필요한 패턴에서 알려줘야 한다 | ORCH §3.4.1 (P2P 봉인 해제) |
| 13 | **`Close Git` 버튼을 없앤다** (함수는 존치) | SBT FR-SBT-34~36 · D-13 |

---

## 3. 충돌 지도

병렬의 유일한 실질 위험은 **같은 파일을 두 트랙이 동시에 고치는 것**이다. 전수
조사했다.

### 3.1 Go — 다중 트랙이 만지는 파일

| 파일 | 트랙 | 성격 | 판정 |
|---|---|---|---|
| `domain/run/store.go` | **H · C · V** | 전부 **필드·메서드 추가** | Step 0 에서 필드를 **한 번에** 넣으면 이후 충돌 없음 |
| `httpapi/handlers_runs*.go` | **H · C · V** | 각자 새 핸들러 | 파일을 나눈다 — `handlers_runs_headless.go` · `_context.go` · `_graph.go` |
| `httpapi/handlers_api.go` (라우트 표) | **H · C · V · X** | 표에 행 추가 | Step 0 에서 라우트 행을 **전부 선등록**(핸들러는 501 스텁) |
| `shared/toolhub/tool.go` | **H · N** | H=Create 재사용, N=전경 조회 | H 는 **읽기만** 한다. N 만 수정. 충돌 아님 |
| `runtimebin/dmctl_run.go` | **H · C · P** | 서브커맨드 추가 | 파일을 나눈다 — `dmctl_run_headless.go` · `_context.go` · `_peers.go` |
| `seam/adapters/tool.go` | **H · N** | 둘 다 새 메서드 | Step 0 에서 인터페이스 확장 선반영 |

### 3.2 프론트 — 다중 트랙이 만지는 파일

| 파일 | 트랙 | 성격 | 판정 |
|---|---|---|---|
| `web/index.html` | **V(상단바) · SBT(사이드바) · V/SBT(script 태그)** | 서로 다른 블록 | **Step 0 에서 전부 선반영.** 이후 아무도 안 만짐 |
| `web/js/ui/renderer.js` | **V(run 탭) · SBT(사이드바) · N(탭 이름)** | 세 곳 | Step 0 에서 **훅 포인트 3개 추출**. 이후 각자 자기 함수만 |
| `web/js/core/app-layout.js` | **V(addTab) · SBT(순회) · N(nameSource)** | 세 곳 | 위와 동일 |
| `web/js/core/helpers.js` | **SBT(단축키)** | 단독 | 충돌 없음 |
| `web/style.css` | **V · SBT · X** | 각자 새 클래스 | 파일 끝에 **트랙별 섹션 주석**으로 append. 기존 규칙 미수정 |
| `web/js/core/app-statusbar.js` | **X** | 단독 | 충돌 없음 |
| `web/js/core/app-git.js` | **SBT** | 단독 | 충돌 없음 |

### 3.3 결론

핫스팟은 **여섯 개**다: `index.html` · `renderer.js` · `app-layout.js` ·
`handlers_api.go` · `domain/run/store.go` · `style.css`.

전부 **Step 0 하나로 해소된다.** Step 0 이후 각 워크스트림은 **자기 소유 파일**에서만
일한다.

---

## 4. Step 0 — 골격 선행 커밋 (단독·순차·필수)

> **누구도 Step 0 이전에 병렬로 시작하지 않는다.** 이 커밋 하나가 병렬의 전제다.

Step 0 은 **동작을 바꾸지 않는다.** 자리를 만들고 훅을 뽑는 리팩터다. 끝나면 기존
테스트 전량이 무수정 통과해야 한다 — 그것이 Step 0 이 옳게 끝났다는 증거다.

### 4.1 프론트

| # | 작업 | 근거 |
|---|---|---|
| 0-1 | `index.html` 상단바에 `Runs` 버튼 추가 (핸들러 없음, `display:none`) | ORCH FR-RVZ-1 |
| 0-3 | `index.html` 에 `js/ui/sidebar-tabs.js` · `js/core/app-runs.js` 를 빈 파일로 만들고 `<script>` 등록 (로드 순서 확정) | SBT §3.9.1 · ORCH 묶음 V |
| 0-4 | `renderer.js` 탭 타입 분기에서 **타입별 렌더를 함수로 추출** (`_renderTerminalTab`·`_renderEditorTab`·`_renderGitTab`), `run` 케이스 자리 확보 | 충돌 지도 §3.2 |
| 0-6 | `renderer.js` 탭 이름 표시를 **한 함수로 추출** (`_tabDisplayName(tab)`) | CNV FR-TAN-17 |
| 0-7 | `app-layout.js` `addTab` 의 타입 분기에 `run` 케이스 자리 | ORCH FR-RVZ-8 |
| 0-8 | `app-layout.js` 순회를 **디스패치로 감싼다** (`_cycleActive(dir)` → 현재는 항상 `_cycleWindow`) | SBT FR-SBT-33 |
| 0-9 | `style.css` 끝에 트랙별 섹션 주석 3개 (`/* --- track: runs --- */` 등) | 충돌 지도 §3.2 |

### 4.2 Go

| # | 작업 | 근거 |
|---|---|---|
| 0-10 | `domain/run/store.go` 의 `Member`·`Record` 에 **세 묶음의 신규 필드를 한 번에** 추가 (전부 `omitempty`, 아직 아무도 안 씀) | 충돌 지도 §3.1 |
| 0-11 | `httpapi/handlers_api.go` 라우트 표에 **신규 종단 전부 선등록**, 핸들러는 `501 Not Implemented` 스텁 | 충돌 지도 §3.1 |
| 0-12 | `workspace/manager.go` 에 `ResolveStrict` **스텁** 추가 (현재는 `Resolve` 위임 — 동작 불변) | ORCH FR-IDU-1 |
| 0-13 | `seam/adapters` · `toolaccess/deps.go` 인터페이스에 신규 메서드 시그니처 선반영 | 충돌 지도 §3.1 |
| 0-14 | 신규 파일 생성 (스텁): `handlers_runs_{headless,context,peers,graph}.go` · `handlers_tools_kill.go` · `dmctl_run_{headless,context,peers}.go` | 충돌 지도 §3.1 |
| 0-15 | `dmctl_run.go` 의 **디스패치 switch 와 `runFlags`·플래그 맵**에 선등록 (`attach`·`detach`·`succeed`·`handoff`·`peers` / `--headless`·`--timeout-ms`) | 아래 주석 |

> **0-15 는 조사 중에 드러난 핫스팟이다.** 충돌 지도 초안은 `dmctl_run.go` 를
> "서브커맨드 추가 → 파일을 나눈다" 로만 봤는데, 실제로는 **플래그 파싱이
> 서브커맨드와 무관한 단일 맵**(`parseRunFlags`)이라 새 플래그도 이 파일에 들어간다.
> 세 워크스트림이 디스패치와 플래그 맵 양쪽에서 만난다. 둘 다 Step 0 에서 열었다.

> **실행 중 계획을 고친 것 (2026-08-28).** 초안의 0-2(사이드바 DOM 재구성)와
> 0-5(사이드바 렌더의 서술자화)를 **Step 0 에서 빼고 WS-6 소유로 옮겼다.**
>
> 근거는 둘이다. ① **동작 불변이 깨진다** — `#windows{flex:1 1 auto}`(style.css:27)와
> `#git-repos{flex:0 1 auto;max-height:40%}`(style.css:1492)는 `#sidebar` 의 **직접
> 자식**으로서 flex item 이다. 패널 래퍼를 끼우면 이들이 flex item 이 아니게 되어
> 레이아웃이 바뀐다. Step 0 의 유일한 성공 기준을 그 자리에서 위반한다.
> ② **충돌이 애초에 없다** — `index.html` 의 사이드바 블록은 WS-6 만, 상단바 블록은
> WS-5 만 만진다. 두 블록은 겹치지 않으므로 Step 0 이 선점할 이유가 없었다.
>
> Step 0 이 index.html 에 실제로 한 것은 **상단바 버튼 하나(숨김)와 `<script>` 두
> 줄**뿐이며, 둘 다 동작을 바꾸지 않는다.

### 4.2.1 Step 0 산출물 (2026-08-28 실행 완료)

| 구분 | 파일 | 성격 |
|---|---|---|
| 신규 | `httpapi/handlers_runs_{headless,context,peers,graph}.go` | 501 스텁. 워크스트림별 배타 소유 |
| 신규 | `httpapi/handlers_tools_kill.go` | 〃 (WS-8) |
| 신규 | `runtimebin/dmctl_run_{headless,context,peers}.go` | rc 2 스텁 |
| 신규 | `web/js/ui/sidebar-tabs.js` · `web/js/core/app-runs.js` | 로드 순서만 확정한 빈 파일 |
| 수정 | `run/store.go` | `Member` 12필드 · `Record.Messages` · `MessageEdge` 타입 |
| 수정 | `httpapi/handlers_api.go` | 라우트 8개 선등록 + `notImplemented` 헬퍼 |
| 수정 | `workspace/manager.go` | `ResolveStrict` (현재 `Resolve` 위임) |
| 수정 | `toolaccess/deps.go` · `adapters/workspace.go` · `handlers_toolio_test.go` | 인터페이스 확장 + 구현 2곳 |
| 수정 | `runtimebin/dmctl_run.go` | 디스패치 5 case · 플래그 2개 |
| 수정 | `web/js/ui/renderer.js` | `_tabDisplayName` · `_mountTabBody` 추출 |
| 수정 | `web/js/core/app-layout.js` | `_cycleActive` 디스패치 · `addTab` run 케이스 주석 |
| 수정 | `web/index.html` | `#runs-btn`(숨김) · `<script>` 2줄 |
| 수정 | `web/style.css` | 트랙별 섹션 경계 3개 |

**동작을 바꾼 것은 없다.** 새 라우트·새 서브커맨드는 이전에 404/rc2 였고 지금은
501/rc2 다 — 아무도 부르지 않던 경로다.

#### 사후 정정 (2026-08-28, WS-3 이 발견)

**0-10 이 넣은 `Member` 필드가 SRS §3.3 과 어긋나 있었다.** 조정자가 SRS 를 다시
읽지 않고 **덮어써진 초안**을 기준으로 필드를 넣었기 때문이다. 같은 착오가 WS-3
브리핑에도 그대로 실려, 담당자가 "문서와 코드가 다른 설계를 말한다" 로 막혔다.

| 항목 | 잘못 들어간 것 | SRS 기준으로 정정 |
|---|---|---|
| 임계 | 절대 바이트 (`contextWarnBytes`) | **ratio** — `bytes/3.6/모델한계` (FR-CBG-2) |
| 필드 | `ContextTurns`·`ContextSeenAt`·`CompactedAt`·`InstructionCount`·`MsgSent`·`MsgRecv` | 제거. `ContextRatio`·`ContextAt`·`SessionID`·`SucceededBy` 추가 |
| 미상 등급 | `"unknown"` 문자열 | **빈 값** (FR-CBG-5) |
| 등급 단조성 | 단조 | 아니다. 단조인 것은 **통지**뿐 (FR-CBG-7) |
| 관측 방법 | 바이트 + 줄 수 | **바이트만** — 줄 수는 파일 전량 스캔이라 NFR-CBG-1(`stat` 1회) 위반 |
| 메시지 타입 | `MessageEdge{…,Bytes}` | `MsgEvent{From,To,At,Kind,Size}` (FR-RVZ-14) |

함께 넣은 것: `Succeeded` MemberState 상수, `Member.settled()`, `Close` 의 미보고
검사 교체(FR-CBG-10), `POST /api/runs/context` 라우트 + 스텁, SRS 에 `HandoffSummary`
반영.

**교훈 — 이후 워크스트림 브리핑에 적용한다.**

1. **브리핑은 기억이 아니라 디스크에서 인용한다.** FR 번호와 필드 목록은 특히 그렇다
2. **Step 0 처럼 여러 워크스트림이 딛는 공통 구조를 넣을 때는 SRS 를 옆에 놓고 대조한다.** 그것이 틀리면 여러 담당자가 동시에 막힌다
3. **담당자의 "문서와 코드가 다르다" 보고를 판정 요청으로 대우한다.** WS-3 은 지시대로 멈추고 물었고, 그래서 잘못된 설계가 다섯 파일로 번지기 전에 잡혔다

#### 같은 원인의 두 번째 사고 (WS-1 이 발견)

브리핑의 **FR 번호가 SRS 와 어긋났고**(내가 말한 FR-IDU-8·11·12 는 SRS 의 4·7·8),
더 나쁘게는 **"레이아웃 명령은 라벨 허용" 이 사실과 반대**였다. SRS FR-IDU-5 는
"레이아웃 경로의 현재 동작은 바꾸지 않는다 — 이미 거부한다" 이고, **§2.1(a) 에 그
조사 결과를 내가 직접 적어 놨는데도** 브리핑에는 옛 이해를 실었다.

담당자가 SRS·코드를 근거로 바로잡아 구현했다. 결과물은 옳다.

부수 소득: 담당자가 구현한 엔벨로프 헤더 uuid 병기가 SRS 에 근거 없는 항목이었는데,
검토해 보니 **묶음 I 의 필수 짝**이었다 — 접합면을 uuid 전용으로 좁히면 "헤더에는
라벨뿐이라 회신하려면 list-workspace 를 되짚어야 한다" 는 마찰이 필수 절차가 된다.
**FR-IDU-9** 로 정식 추가했다.

#### 세 번째 사고 (WS-2 가 발견) — 그리고 절차로 굳힌다

같은 원인이 세 번 반복됐다. WS-2 브리핑의 FR-HLM 번호가 SRS §3.2(1~12)와 어긋났고,
**오번호가 Step 0 스텁 주석에까지 들어가 있었다.**

가장 위험했던 것은 번호가 아니라 **방향이 반대인 지시**였다.

| 브리핑 | SRS |
|---|---|
| "재시작 후 도구 없으면 `lost`" | **V-HLM-4 기대값 = "`lost` 가 아님"**. FR-HLM-3 의 요지가 "기록해서 살아남게 한다" |
| cwd = "Run 의 저장소 루트" | FR-HLM-2 = "격리면 worktree, 아니면 **조정자의 cwd**" |
| — (누락) | **FR-HLM-4 `--keep-tools`** — V-HLM-7 이 직접 검증 |
| — (누락) | **FR-HLM-5 고아 목록** |
| — (누락) | **FR-HLM-11 `wait --member`** — V-HLM-2 가 직접 검증 |
| — (누락) | **FR-HLM-12 `read-screen --at <헤드리스 uuid>`** |

담당자의 관찰이 정확했다: **"근거 없는 항목보다 누락이 더 위험하다"** — 근거 없는
것은 안 만들면 그만이지만, 누락은 **검증 표를 통과하지 못하는 코드**를 낳는다.

부수 소득: 브리핑이 지시한 "`ResolveStrict` 에 멤버 uuid 해석 추가" 는 **불필요**했다.
SRS 는 FR-HLM-12 에서 **toolId** 로 부르게 하고, 멤버 uuid 는 FR-HLM-11 의
`wait --member` **전용 플래그**로 받는다. 그대로 갔으면 `workspace` 패키지가 `run` 을
알게 되어 의존 방향이 뒤집힐 뻔했다.

### 4.2.2 브리핑 절차 (세 사고의 결론)

같은 실수가 세 번 났으므로 조심이 아니라 **절차**로 막는다. 워크스트림을 띄우기 전에
아래를 **순서대로** 수행한다.

1. **해당 묶음 절을 `sed` 로 통째로 출력한다.** 기억으로 쓰지 않는다
2. **FR 번호 범위를 세어 브리핑에 그대로 적는다.** "FR-XXX-1~12" 처럼 상한을 명시하면
   담당자가 범위 밖 지시를 즉시 알아본다
3. **검증 표의 각 항목이 브리핑의 어느 지시와 짝인지 확인한다.** 짝이 없는 검증
   항목이 곧 누락이다 — 세 번째 사고의 4건이 전부 이 검사로 잡혔을 것이다
4. **브리핑에 "이 브리핑이 SRS 와 어긋나 보이면 구현하지 말고 보고하라"를 넣는다**
   (WS-2 부터 적용). 이것이 실제로 작동한 최후 방어선이다

### 4.2.3 판정이 걸린 항목은 문서로 전달한다 (WS-3 제안, 채택)

§4.2.2 가 조정자 쪽 절반이라면 이것이 **담당자 쪽 절반**이다. 둘이 짝이 되어야
완성된다.

**규칙**: 판정이 걸린 항목은 **메시지가 아니라 SRS 원문을 근거로 구현한다.**

1. 조정자가 **문서를 고친다**
2. 담당자에게는 `"§X.Y 를 갱신했다"` 만 보낸다 — 결론을 메시지 본문에 쓰지 않는다
3. 담당자는 **읽기 전에 그 절이 안정됐는지 확인한다** — mtime 이 **3분 이상 변하지
   않았을 때** 비로소 읽는다
4. 그 절을 읽고 구현한 뒤, 자기가 읽은 문장을 인용해 보고한다

> **3번이 이 규칙의 핵심이다** (2026-08-28, WS-3 실측). 이것이 빠진 채로 열 번을
> 돌았다 — **읽은 값이 반영을 끝내기 전에 낡는다.** 담당자가 문서를 읽고 코드를
> 고치는 동안 조정자가 문서를 또 고치면, 정렬이 끝난 순간 이미 어긋나 있다.
>
> 열 번의 실패와 열한 번째 성공의 차이는 논거도 소유권도 성실성도 아니었다.
> **"읽는 즉시 맞추기" 를 "안정을 확인한 뒤 맞추기" 로 바꾼 것 하나**였다.

**왜 필요했나.** `ContextLevel` 단조성 하나가 **여섯 번** 뒤집혔다. 논거가 부족해서가
아니라, 조정자가 판단할 때마다 메시지를 보냈고 담당자는 도착한 지시를 성실히
반영했기 때문이다. 왕복 지연 동안 양쪽이 서로 다른 시점의 결론을 들고 있었다.

**메시지끼리는 엇갈리지만 문서는 하나뿐이다.** 그것이 이 규칙의 전부다.

> 조정자가 지켜야 할 것이 하나 더 있다: **문서를 고치는 것을 멈추는 시점을 정한다.**
> 문서가 계속 바뀌면 담당자가 읽는 시점마다 다른 것을 본다 — 규칙이 무력해진다.
> 결론을 내렸으면 그 절에 "최종 확정" 과 뒤집힌 횟수를 박고 손을 뗀다.

> **누적된 교훈**: 브리핑에 FR 번호·필드·동작 방향을 적을 때는 **그 문단을 디스크
> 문서에서 복사한다.** 세 사고 모두 원인이 같았고, **셋 다 담당자가 멈추고 물어서**
> 잡혔다. 조정자의 검토가 아니라 담당자의 대조가 방어선이었다는 사실 자체가
> 절차 4를 정당화한다.

### 4.3 Step 0 완료 판정

```bash
go test ./...                       # 전량 통과
npx playwright test                 # 전량 통과 (무수정)
scripts/verify-isolated.sh          # 21항목 통과
```

**하나라도 깨지면 Step 0 이 아직 끝나지 않은 것이다.** 병렬을 시작하지 않는다.

#### 실행 결과 (2026-08-28) — **통과**

| 게이트 | 결과 |
|---|---|
| `go build ./...` · `go vet ./...` · `go test ./...` | **전량 통과** |
| `npx playwright test` (1차) | 574 passed / 1 failed (`git-repo-missing` M5) |
| `npx playwright test --retries=1` (2차) | 573 passed / 1 flaky (`git-stash` S3) / 1 failed (`git-branch-actions` BR12) |
| 단독 재실행 | M5 → 11/11 통과 · BR12 → 15/15 통과 |
| `scripts/verify-isolated.sh` | **21/21 통과** (항목 20 이 `index.html` script **46개** 전량 200 — 신규 2개 포함) |

**두 실행에서 실패한 테스트가 서로 다르고 각각 단독 통과했다.** `GIT_REMAINING.md`
§5 가 기록한 간헐 성질이며, Step 0 의 변경(아무도 부르지 않는 Go 스텁 · 동작이
같은 JS 함수 추출 · 숨긴 버튼)과 git 브랜치·리포 감지 사이에 인과 경로가 없다.

추가 실동작 확인 (격리 인스턴스, 운영 58146 무영향):

- 선등록 라우트 8개 전부 **501 + 담당 묶음 표시**
- `/api/runs/preamble` 은 `{"error":"unknown_member"}`(핸들러 응답) — 미매칭의
  평문 `not found` 와 구분된다. **graph 의 prefix 매칭이 기존 exactPath 를 가로채지
  않는다**는 증거다
- `dmctl run {attach,detach,succeed,handoff,peers}` 전부 담당 묶음을 안내하고 rc 2

---

## 5. 워크스트림

Step 0 이후 **8개**로 나눈다. 각 워크스트림에 **배타적 파일 소유권**을 준다.

| WS | 이름 | SRS 묶음 | 소유 파일 | 의존 |
|---|---|---|---|---|
| **WS-1** | 식별자 uuid 전용화 | ORCH I | `workspace/manager.go`, `handlers_toolio.go`, `runtimebin/dmctl.go`(help) | — |
| **WS-2** | 헤드리스 멤버 | ORCH H | `handlers_runs_headless.go`, `dmctl_run_headless.go`, `toolhub`(읽기), `handlers_attention.go` | **WS-1** |
| **WS-3** | 컨텍스트 예산·승계 | ORCH C | `agentadapter/*`, `handlers_runs_context.go`, `dmctl_run_context.go`, `dmctl_activity.go`, `runtime/install.go` | — |
| **WS-4** | 패턴 카탈로그 + P2P | ORCH P | `agentplugin/skills/team/**`, `handlers_runs_peers`, `dmctl_run_peers.go`, `domain/run/preamble.go` | — |
| **WS-5** | Run 시각화 | ORCH V | `handlers_runs_graph.go`, `web/js/core/app-runs.js`, `style.css`(runs 섹션) | WS-2·WS-3 (데이터) |
| **WS-6** | 사이드바 탭 | SBT 전량 (FR-SBT-1~36) | `web/js/ui/sidebar-tabs.js`, `app-git.js`, `helpers.js`, `input-binding.js`, `style.css`(sidebar 섹션), **`index.html` 사이드바·`#git-close` 블록**, `renderer.js` 사이드바 렌더 | — |
| **WS-7** | 전경 프로세스 탭 이름 | CNV N | `toolhub/tool.go`, `toolhub/fg_unix.go`(신규), `daemon/ipc`, `seam/adapters/tool.go` | — |
| **WS-8** | 백그라운드 즉시 종료 | CNV X | `app-statusbar.js`, `handlers_tools_kill.go`(신규), `style.css`(bg 섹션) | — |

### 5.1 의존 그래프

```
Step 0 ──┬─► WS-1 ──► WS-2 ──┐
         │                    ├─► WS-5 ──► 통합
         ├─► WS-3 ────────────┘
         ├─► WS-4 ─────────────────────────► 통합
         ├─► WS-6 ─────────────────────────► 통합
         ├─► WS-7 ─────────────────────────► 통합
         └─► WS-8 ─────────────────────────► 통합
```

**임계 경로는 WS-1 → WS-2 → WS-5** 다. 이 셋이 전체 기간을 정한다. 나머지 다섯은
그 그늘 안에서 끝난다.

### 5.2 웨이브 배치

| 웨이브 | 동시 실행 | 비고 |
|---|---|---|
| **0** | Step 0 (단독) | 병렬 없음 |
| **1** | WS-1 · WS-3 · WS-4 · WS-6 · WS-7 · WS-8 | **6 병렬.** 상호 의존 0 |
| **2** | WS-2 (WS-1 완료 후) · 웨이브 1 잔여 | |
| **3** | WS-5 (WS-2·WS-3 완료 후) | 시각화는 그릴 데이터가 있어야 한다 |
| **4** | 통합 검증 | §7 |

> WS-5 의 **골격**(버튼 활성화·모달·탭 타입 렌더)은 웨이브 1 에서 시작할 수 있다 —
> 데이터가 없어도 빈 상태를 그릴 수 있다. 임계 경로를 줄이려면 WS-5 를 **골격**과
> **데이터 결선** 둘로 쪼개 골격을 웨이브 1 에 넣는다. **권장한다.**

---

## 6. 실행 방식

### 6.1 병렬의 주체

두 가지 중 하나다.

**(a) dongminal 팀 오케스트레이션 — `/dongminal:team`**

이 저장소가 만드는 바로 그 기능으로 자기 자신을 만든다. 가능하고, 실제로 잘 맞는다:
워크스트림이 **파일 단위로 배타**라 격리 없이 병렬이 되고, 서로의 산출물을 읽어야 하는
구간(WS-2 가 WS-1 의 `ResolveStrict` 를 쓴다)이 있어 **공유 트리가 오히려 옳다**.

- **격리: `none`** — WS 간 파일이 겹치지 않으므로 worktree 를 나눌 이유가 없고,
  나누면 WS-2 가 WS-1 의 결과를 못 본다
- **패턴: supervisor-worker** — 웨이브 1 의 6개는 서로 독립
- **배치: 헤드리스 권장** — 6명은 화면 분할로 감당하기 나쁘다 (묶음 H 가 없으면 전용 창)

> **부트스트랩 주의.** 이 계획이 만드는 기능(헤드리스·승계·패턴)은 **아직 없다.**
> 팀을 돌린다면 **현재 스킬로** 돌아간다. 새 기능을 쓰려고 기다리지 않는다.

**(b) 단일 에이전트 순차**

워크스트림 순서대로 혼자 진행한다. 느리지만 통합 비용이 0 이다. 임계 경로가 아닌
WS 들이 많으므로 **(a) 의 이득이 크다.**

### 6.2 워크스트림 계약

각 워크스트림 담당은 다음을 지킨다.

1. **소유 파일 밖을 고치지 않는다.** 필요하면 멈추고 조정자에게 보고한다 — 그것이
   충돌 지도가 놓친 자리라는 뜻이므로, 계획을 고쳐야 한다
2. **SRS 의 FR 번호로 커밋 메시지를 쓴다.** 기존 관례를 따른다
   (`feat(git): … (FR-GIT-19·227)`)
3. **자기 묶음의 검증 표를 전부 통과시킨다.** 표의 ID 를 커밋에 남긴다
4. **Step 0 이 만든 스텁을 지우지 않는다.** 다른 WS 가 그것을 딛고 있다
5. **완료 보고에 다음을 담는다** — 통과시킨 검증 ID, 건드린 파일, 남긴 것

### 6.3 한 워크스트림 = 한 관심사

WS 하나에 두 묶음을 몰지 않는다. `ORCHESTRATION_V2_SRS` FR-PAT-4 가 말하는 것과
같은 이유이며, **이 계획 자체가 그 규칙의 첫 적용 사례다.**

---

## 7. 통합과 검증 게이트

### 7.1 워크스트림 게이트 (각자)

```bash
go test ./...                              # 전량
npx playwright test e2e/<관련>.spec.ts     # 자기 스펙
```

### 7.2 웨이브 게이트

각 웨이브가 끝날 때마다:

```bash
go test -count=1 ./...                     # 반복 (아래 판정 규칙)
go test -race ./...                        # 레이스
npx playwright test --retries=1            # 전량 (약 10분)
scripts/verify-isolated.sh                 # 격리 실동작 21항목
```

#### 전제 — 모든 워크스트림이 손을 뗀 뒤에 돌린다

**작업 중인 워크스트림이 하나라도 있으면 `go test ./...` 결과는 누구의 상태도
대표하지 않는다** (WS-3 관찰). 실측된 것들:

- `store_headless.go` 미사용 import → 패키지 5개가 `[build failed]`
- `toolhub/tool.go` 편집 중 → 무관한 WebSocket 테스트가 실패
- 회차마다 **다른** 워크스트림의 테스트가 깨진다

게이트를 그 상태에서 돌리면 남의 중간 상태를 자기 회귀로 오진하거나, 반대로
진짜 회귀를 "또 편집 중이겠지" 로 넘긴다. **완료 보고를 받은 뒤에 돌린다.**

#### 판정 규칙 — 1회로 판정하지 않는다 (WS-3 권고, 채택)

**플레이크가 하나라도 알려져 있으면 1회 통과는 통과의 증거가 아니고, 1회 실패도
회귀의 증거가 아니다.** 이 저장소는 양쪽 사례를 다 겪었다.

| 신호 | 판정 |
|---|---|
| 전량 3회 연속 통과 | 통과 |
| 전량에서 실패 + **단독 재실행 통과** | 플레이크 후보 — 원인을 특정하기 전에는 통과로 치지 않는다 |
| `-race` 경고 | **실패로 친다.** 레이스는 비결정적이라 "경고" 로 끝나지 않는다 — 부하가 걸리면 실제 실패가 된다 |

**원인 특정 없이 넘어가지 않는다.** 실측된 사례 둘:

- `TestToolManager_DeleteDetachedToolDoesNotPanic` — 전량 3회 중 1회 실패.
  원인은 제품이 아니라 **테스트가 `go m.SaveAll()` 의 비동기 쓰기를 안 기다린
  것**이었다 (`TempDir RemoveAll cleanup: directory not empty`). 쓰기 결과물의
  등장으로 동기화해 닫았다
- `httpapi` 전량 1회 실패 — `fakeWorkIndex` 데이터 레이스. **`-race` 경고에 머물지
  않고 실제 실패를 냈다.** 단일 테스트 8회 반복으로는 재현되지 않고 전량 병렬
  부하에서만 나온다

두 사례 모두 **"다시 돌려 보자" 로 넘어갔으면 게이트가 무력화됐을 것**이다.

### 7.3 최종 게이트

위 전량에 더해 **수동 실사**. 자동 테스트가 잡지 못하는 것이 있다는 것은
`GIT_REMAINING.md` §1 이 이미 증명했다 — 배치·색·읽힘·상호작용은 쓰는 사람만 본다.

| # | 실사 항목 | 근거 |
|---|---|---|
| M-1 | 사이드바 탭 전환 → Git 창 전환 → Windows 탭 → **직전 창** 복귀 | SBT V-SBT-9 |
| M-2 | `Ctrl+Shift+1/2` · Git 탭에서 `Ctrl+Shift+]` 리포 순회 | SBT V-SBT-26~34 |
| M-3 | 실제 팀 Run 을 띄우고 대시보드에서 관계 그래프 확인 | ORCH V-RVZ-* |
| M-4 | 헤드리스 멤버 3명으로 Run → attach → detach | ORCH V-HLM-* |
| M-5 | 컨텍스트를 실제로 채워 `warn`→`critical` 전이·통지·승계 | ORCH V-CBG-* |
| M-6 | debate Run 에서 **멤버끼리 직접 대화**가 실제로 일어나는지 | ORCH V-PAT-6 |
| M-7 | `vim`·`claude` 실행 시 탭 이름 · 수동 이름 보존 | CNV V-TAN-* |
| M-8 | 백그라운드 도구 종료 · 인라인 확인 · 오조작 내성 | CNV V-BGK-* |
| M-9 | 라벨을 접합면 명령에 넣어 **오류 메시지가 대안을 주는지** | ORCH V-IDU-* |
| M-10 | 모바일 드로어에서 탭·배지·종료 버튼 | SBT V-SBT-17 · CNV V-BGK-12 |

### 7.4 회귀 불변

다음은 **어떤 워크스트림도 깨뜨려서는 안 된다.**

| 불변 | 고정 수단 |
|---|---|
| Git 창의 126항목 동작 표면 | `e2e/git-*.spec.ts` 무수정 통과 |
| 창·탭·분할 칸의 기존 동작 | 워크스페이스 e2e |
| 폴링 재렌더가 hover·드래그·선택을 깨지 않음 | `GIT_REMAINING.md` §1.3 의 여섯 자리 |
| 기존 `workspace.json`·`runs.json` 호환 | 마이그레이션 없이 읽힘 |
| 데몬/direct 두 모드 동일 동작 | `verify-isolated.sh` |
| 대화 내용·transcript 가 서버에 저장되지 않음 | ORCH NFR-3/4 전용 테스트 |

---

## 8. 후속 트랙 (이번 범위 밖)

사용자 결정으로 분리했다. **버린 것이 아니라 따로 하는 것이다.** 착수할 때 읽을
것을 남긴다.

### 8.1 후속 트랙 A — `--expose` 접근 제어

**왜 분리했나.** 인증은 한 기능이 아니라 **전 종단에 걸리는 횡단 관심사**다. HTTP·
WebSocket·SSE 세 전송을 모두 게이팅해야 하고, `dmctl` 이 쓰는 로컬 경로는 게이팅에서
빼야 하며(자기 자신을 막으면 안 된다), 세션 만료·재접속·다중 기기를 정해야 한다.
위 여덟 워크스트림 어디에도 얹을 수 없다.

**착수 시 읽을 것.**
- `internal/ctl/cli/options.go:160` — `--expose` 플래그 파싱
- `internal/ctl/cli/help.go:37` — 현재 문구 ("0.0.0.0 에 바인드")
- `cmd/dongminal/main.go:382` — `exposure = "exposed to LAN"`
- `internal/webserver/httpapi/handlers_api.go` — 라우트 표. **게이팅의 단일 자리**
- `internal/webserver/seam/clientpid/` — remoteAddr → client PID. 로컬 판별의 기존 수단

**먼저 정할 것.** 인증 방식(공유 토큰 / 계정), 세션 수명, 로컬 예외의 판정 기준,
WS·SSE 의 게이팅 시점(핸드셰이크 vs 프레임), 실패 시 UX.

### 8.2 후속 트랙 B — cross-platform (linux · WSL · Windows native)

사용자 결정: **"2번의 전부로 하되 당장 하지 말고 독립으로."** 즉 최종 목표는 Windows
native 포함이다.

**왜 분리했나.** POSIX 전제가 네 곳에 깊이 박혀 있다.

| 전제 | 자리 | Windows native 대체 |
|---|---|---|
| PTY | `creack/pty`, `toolhub/tool.go` | ConPTY |
| Unix socket IPC | `toolclient/client.go:95` `net.Dial("unix", …)` | named pipe |
| symlink multi-call CLI | `shared/runtime/install.go` | `.cmd`/`.exe` shim |
| 셸 훅 (zsh/bash) | `runtime/shellhooks/` | PowerShell profile |
| `syscall.Kill`·프로세스 그룹 | `ctl/cli/proc.go`, `git/jobs/job.go:569` | `taskkill`/Job Object |

**이번 SRS 가 미리 해 둔 것.** `CONVENIENCE_SRS` FR-TAN-23/24 가 전경 프로세스 조회를
**단일 함수 + build tag** 로 격리한다. `sysstat` 이 이미 쓰는 패턴
(`reader_darwin.go`/`reader_other.go`)과 같다. 후속 트랙은 이 관례를 확장한다.

**단계 권고.**
1. **Linux** — POSIX 계열이라 대부분 이미 동작. `sysstat/reader_linux.go` 추가,
   `/bin/bash` 탐색 유연화, 실기기 검증
2. **WSL** — Linux 위. 브라우저 열기(`wslview`)·경로 변환·네트워크 노출 확인
3. **Windows native** — 위 다섯 전제를 전부 교체. **규모가 앞의 둘을 합친 것보다 크다**

---

## 9. 리스크

| # | 리스크 | 등급 | 완화 |
|---|---|---|---|
| R1 | Step 0 이 불완전해 병렬 중 충돌이 터진다 | **HIGH** | §4.3 게이트를 엄격히. 충돌이 나면 **그 자리를 Step 0 으로 되돌려** 처리하고 계획을 고친다 |
| R2 | WS-1→WS-2→WS-5 임계 경로가 전체를 늦춘다 | **MEDIUM** | WS-5 를 골격/데이터로 쪼개 골격을 웨이브 1 로 (§5.2 권고) |
| R3 | 전경 프로세스 조회가 데몬 모드에서 안 된다 | **HIGH** | CNV R1 에서 이미 확정 — 설계에 못 박음. **구현 첫 커밋에서 두 모드를 함께 검증** |
| R4 | `claude` 래퍼가 전경 이름을 왜곡 | MEDIUM | 구현 전 실측 (CNV V-TAN-20) |
| R5 | 라벨 거부가 미지의 호출자를 깨뜨린다 | MEDIUM | 호출자 전수 열거됨. `Resolve` 는 남으므로 되돌리기가 한 줄 |
| R6 | 컨텍스트 추정이 실제와 동떨어진다 | MEDIUM | 임계를 설정 가능하게 + `PreCompact` 확정 신호 병행 |
| R7 | 병렬 팀 자체가 이 계획이 고치려는 결함(컨텍스트 오염)에 빠진다 | **MEDIUM** | §6.3 — WS 하나에 한 관심사. 이 계획이 그 규칙의 첫 적용 사례다 |
| R8 | 수동 실사에서 스펙에 없던 UX 결함이 나온다 | **HIGH** | `GIT_REMAINING.md` §1 의 전례. §7.3 을 **일정에 포함**하고, 나온 것은 별도 SRS 로 접수한다 |

---

## 10. 착수 체크리스트

```
[ ] 세 SRS 를 읽고 §2 결정표와 어긋나는 곳이 없는지 확인
[ ] Step 0 실행 (단독)
[ ] Step 0 게이트 3종 통과 확인          ← 여기서 멈출 수 있다
[ ] 웨이브 1 착수: WS-1·3·4·6·7·8 (+WS-5 골격)
[ ] 웨이브 1 게이트
[ ] 웨이브 2: WS-2
[ ] 웨이브 3: WS-5 데이터 결선
[ ] 최종 게이트 §7.2 + 수동 실사 §7.3
[ ] 문서 갱신: README · docs/external/agent-orchestration.md · architecture.md
[ ] GIT_REMAINING.md 의 I5·I6 을 '완료'로 이관
[ ] 후속 트랙 A·B 를 별도 문서로 열기
```
