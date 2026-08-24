# SRS: 엔티티 모델 재정비 — 계층 개명·도구 1급화·백그라운드 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

dongminal 의 공간 계층 어휘를 사용자 통념과 일치시키고, 탭 안에 탑재되는 **도구(Tool)** 를 1급 엔티티로 분리한다. 그 위에 "탭을 닫아도 도구는 백그라운드에서 계속 돈다"를 명시적 사용자 동작으로 제공한다.

### 1.2 범위 (Scope)

**포함:**

- 계층 개명 — `session`→`Window`, `region`→`Pane`, `paneId`(PTY)→`toolId`, 좌표계 `S`→`W`
- 도구 1급화 — 별도 컬렉션 + 탭의 참조. `tab.paneId` 필드 흡수 해소
- 백그라운드 — `detach` 명령, busy 확인창 버튼, 상태바 배지, 복귀 경로
- 참조 무결성 — 부팅 시 고아 도구 폐기
- 외부 계약 개명 — MCP 툴 3개, dmctl 서브커맨드, HTTP 경로, SSE 이벤트명 (구 이름 alias 미제공)
- Run 접합 필드 정의 (필드·enum 만. 런타임 없음)
- 1회성 데이터 마이그레이션 스크립트

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 | 구 용어 |
|------|------|---------|
| **Client** | 브라우저 창 하나. 휘발성 뷰포트. Window 하나에 attach 한다 | (무명) |
| **Window** | Pane 들을 담는 작업공간. 서버에 영속. tmux 의 session 에 대응 | `session` |
| **Pane** | Window 안에서 나뉜 공간 하나. 탭 목록의 보유자 | `region` |
| **Tab** | 도구를 담는 공간. 그 자체는 도구가 아니다 | `tab` (동일) |
| **Tool** | 탭에 탑재되는 실체. `terminal` \| `editor` \| `markdown` | `pane`(PTY) / `paneId` |
| **Run** | 오케스트레이션 실행 인스턴스. 공간 계층과 **직교**한 축 | (없음) |
| **백그라운드 도구** | 어떤 탭에도 매이지 않은 채, 사용자가 명시적으로 보내서 살아 있는 Tool | (없음) |
| **고아 도구** | 어떤 탭에도 매이지 않았고, 명시적으로 보내진 것도 아닌 Tool | (구분 불가) |

**계층은 `Client ▶ Window ─ Pane ─ Tab ─ Tool` 4단이다.** `Split`(방향·비율·자식을 갖는 노드)은 계층 레벨이 **아니다** — Window 안에서 Pane 들이 어떻게 배치되는지를 표현하는 레이아웃 트리의 내부 노드일 뿐이며, 사용자가 인식하는 공간 단위가 아니다. 좌표계에 Split 성분이 없는 것(FR-EM-3)이 이와 일치한다.

`session` 이라는 단어는 이 문서 이후 **도메인 어휘에서 폐기**한다. 업계에 두 관례(iTerm2 = 프로세스 부착 하나 / tmux = detach 가능한 작업공간)가 있어 단어 하나가 두 층을 동시에 가리키는 것이 §2.2 의 원인이다. 두 개념은 각각 `Tool` 과 `Window` 가 담는다.

### 1.4 참고 (References)

- `docs/internal/archive/UUID_IDENTITY_SRS.md` — 좌표계·UUID 정체성 (본 SRS 는 좌표계를 변경하지 않는다)
- `docs/internal/archive/MULTI_TAB_TYPE_SPEC.md` — `tab.type` 도입 (도구 타입의 전신)
- `docs/internal/archive/DAEMON_SPLIT_SRS.md` — 데몬이 PTY 를 소유하는 구조
- `docs/internal/archive/PANE_ATTENTION_NOTIFY_SRS.md`, `AGENT_ACTIVITY_PANEL_SRS.md` — 도구 단위 알림·활동 레이어

### 1.5 개요 (Overview)

§2 는 실측된 현황 결손, §3 은 요구사항, §4 는 검증, §5 는 비목표, §6 은 마이그레이션 단계.

---

## 2. 현황 (Identified Issue)

### 2.1 `pane` 어휘가 두 실체를 지칭한다

통념(tmux)과 `README.md`("분할 Pane")에서 pane 은 *분할 칸*이지만, 코드의 `paneId` 는 *PTY 프로세스*이고 분할 칸은 `region` 이다. 레이어별 사용 빈도도 어긋난다 — Go `pane` 350회 / `region` 1회, `web/js` `pane` 51회 / `region` 55회.

좌표계의 `P` 는 **이미 통념 편에 서 있다.** `internal/workspace/manager.go:403` 이 `fmt.Sprintf("S%d.P%d.T%d", si+1, pi+1, ti+1)` 를 만들 때 `pi` 는 region 인덱스다. 즉 외부 계약(`dmctl focus S1.P2.T1`, MCP `location`)은 이미 P 를 분할된 공간에 쓰고 있다. 어긋난 것은 `paneId`(PTY)와 좌표계 접두사 `S`(session) 두 개다.

### 2.2 `session` 어휘가 관례와 충돌한다

구 `session` 의 실질은 "창"이다(`web/index.html:18` 의 탭바 목록, Client 별 `activeSession` — `app.js:141`). iTerm2 계열 관례의 `session`(= 터미널 하나)과 정반대라, 문서·대화·스킬에서 매번 번역이 필요하다.

### 2.3 도구가 탭 스키마에 흡수되어 있다

`tab.paneId` / `tab.filePath` 로 도구가 탭 필드에 녹아 있어(`web/js/helpers.js:106`) 도구가 1급 엔티티가 아니다. 결과로 아래가 원리적으로 불가능하다.

- 도구만 백그라운드로 분리
- 도구를 다른 탭·Pane·Window 로 이동
- 탭 없는 도구, 도구 없는 빈 탭

### 2.4 도구 참조 무결성이 없다 — 고아율 50%

`~/.dongminal/panes.json` 이 실은 도구의 별도 컬렉션(`[{id,name,cwd}]`)인데, `workspace.json` 참조와 대조하는 코드가 없다. 실측:

```
workspace.json 이 참조하는 도구 : 10
panes.json 에 영속된 도구       : 20
탭에 매이지 않은 고아           : 10  ['5','32','33','34','35','57','60','62','274','305']
agentsOrder: ["350"]            → panes.json 에도 없는 유령 참조
```

그리고 `internal/server/pane.go:907 LoadAll()` 은 panes.json 의 **모든** 항목을 무조건 `Restore` 한다. 데몬이 뜰 때마다 셸 20개가 생성되고 그중 10개는 어떤 UI 에서도 도달 불가하다.

정상 경로에서는 고아가 생기지 않는다 — `closeTab` 이 `_killBg(paneId)` 로 도구를 종료한다(`app.js:1208`). 고아 10개는 크래시·비정상 종료 경로의 산물이다.

### 2.5 백그라운드 의도를 기록할 곳이 없다

PTY 와 출력 버퍼는 이미 `dongminald` 데몬이 소유하므로(`main.go:126`, `pane.go:257`) "백그라운드에서 돈다"는 이미 100% 참이다. 부족한 것은 실행이 아니라 **의도의 표현과 제어**다. 그 결과 "탭 없는 도구"가 의도된 백그라운드인지 누수인지 구분할 데이터가 없어, 어떤 회수 정책도 세울 수 없다.

### 2.6 오케스트레이션이 공간 계층을 침범한다

`skills/dongminal-team` 은 팀을 별도 공간에 만들지 않고 팀장의 Pane 을 쪼개 팀 영역을 확보한다(`references/layout.md`). 그 결과 침범 방어가 스킬의 4대 절대원칙 중 2개("사용자 포커스 금지", 모든 호출에 `keepFocus=true`)와 `layout.md` 의 절반을 차지한다. 근본 원인은 오케스트레이션을 담을 축이 없어 공간 계층에 밀어넣고 있는 것이다.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

#### 3.1.1 계층 개명

**FR-EM-1** 공간 계층은 `Client ▶ Window ─ Pane ─ Tab ─ Tool` 로 확정한다. `Split` 은 계층 레벨이 아니라 Window 안의 Pane 배치를 표현하는 레이아웃 트리 내부 노드다. 최상위 컨테이너(구 tmux session 에 대응하는 Window 묶음)를 추가하지 않는다.

**FR-EM-2** `workspace.json` 스키마를 개명한다. 구 키는 인식하지 않는다.

| 구 | 신 |
|----|-----|
| `sessions[]` | `windows[]` |
| `layout.type: "region"` | `layout.type: "pane"` |
| `tab.paneId` | `tab.toolId` |
| `activeTab`, `type:"split"`, `direction`, `sizes`, `children` | 변경 없음 |
| `agentsOrder` | 변경 없음 (에이전트 활동 패널 순서. 값은 `toolId` 목록) |
| (없음) | `schemaVersion: 2` 추가 |

`activeSession` / `focusedRegion` 은 per-window 상태로 영속 대상이 아니다(`app.js:1461` 에서 strip). Go 파서가 읽는 대응 필드는 각각 `activeWindow` / `focusedPane` 로 개명한다.

**FR-EM-2a** `schemaVersion` 필드를 도입한다. 없거나 `2` 미만이면 로드를 **오류로 중단**하고 마이그레이션 안내를 출력한다. 이 필드 없이는 "구 스키마 파일"과 "빈 workspace"를 구분할 수 없어 NFR-EM-1(조용한 성공 금지)을 만족시킬 수 없다.

**FR-EM-3** 좌표계를 `S{n}.P{n}.T{n}` → `W{n}.P{n}.T{n}` 으로 개명한다. `W`→Window, `P`→Pane, `T`→Tab. 성분 수는 3개를 유지하며 **Split 성분을 추가하지 않는다** — Split 은 계층 레벨이 아니므로 좌표에 자리가 없다(FR-EM-1). `P` 의 의미와 산출 규칙(`Split` 트리 in-order 순회 위치)은 변경하지 않는다. 구 접두사 `S` 는 인식하지 않는다(NFR-EM-1).

개명 대상: `internal/workspace/manager.go:403`(라벨 생성), `CoordinateOf`, `labelToID`/`labels` 인덱스, 브라우저 command pipeline 의 좌표 파서, `dmctl`/MCP 의 `location` 인자 문서, `paneline.Render` 출력.

**FR-EM-4** MCP 툴을 개명한다. 도구를 지칭하는 명사를 툴명에서 제거하여 MCP 프로토콜의 `tools/list` 와의 어휘 추돌을 회피한다 — 대상은 `id` 파라미터로 지정된다.

| 구 | 신 |
|----|-----|
| `list_panes` | `list_workspace` |
| `read_pane_output` | `read_output` |
| `read_pane_screen` | `read_screen` |
| `send_input`, `send_agent_message`, `who_am_i`, `workspace_command` | 변경 없음 |

**FR-EM-5** dmctl 서브커맨드를 개명한다.

| 구 | 신 |
|----|-----|
| `list-panes` | `list-workspace` |
| `new-session` | `new-window` |
| `close-session` | `close-window` |
| `session-next` / `session-prev` | `window-next` / `window-prev` |
| `rename-session` | `rename-window` |
| `split-h`, `split-v`, `new-tab`, `close-tab`, `tab-next`, `tab-prev`, `focus`, `rename-tab`, `who-am-i`, `send`, `notify`, `activity` | 변경 없음 |

**FR-EM-6** `workspace_command` 액션명을 개명한다.

| 구 | 신 |
|----|-----|
| `newSession` / `newSessions` | `newWindow` / `newWindows` |
| `closeSession` | `closeWindow` |
| `sessionNext` / `sessionPrev` | `windowNext` / `windowPrev` |
| `newRegions` | `newPanes` |
| `newTab`, `newTabs`, `closeTab`, `splitH`, `splitV`, `focus`, `renameTab`, `tabNext`, `tabPrev` | 변경 없음 |

**FR-EM-6a** 브라우저 단축키 action id 는 위 액션명과 같은 어휘이며 사용자 커스텀 바인딩과 함께 `settings.json` 의 `shortcuts` 에 **영속된다**. 따라서 개명은 액션명과 같은 단계에서 수행하고, `settings.json` 마이그레이션을 동반해야 한다 — 그러지 않으면 사용자 키바인딩이 조용히 기본값으로 되돌아간다. `paneUp`/`paneDown`/`paneLeft`/`paneRight` 는 분할 칸 이동이므로 새 어휘에서 이미 정확하여 변경하지 않는다.

**FR-EM-7** HTTP 경로와 SSE 이벤트명을 개명한다.

| 구 | 신 |
|----|-----|
| `/api/panes`, `/api/panes/` | `/api/tools`, `/api/tools/` |
| `/api/panes/{id}/busy` | `/api/tools/{id}/busy` |
| `/api/panes/activity`, `/api/panes/activity/set` | `/api/tools/activity`, `/api/tools/activity/set` |
| `/api/panes/attention`, `.../set`, `.../clear`, `.../clear-all` | `/api/tools/attention`, `.../set`, `.../clear`, `.../clear-all` |
| SSE `pane_attention`, `pane_activity` | `tool_attention`, `tool_activity` |
| SSE `workspace_changed` | 변경 없음 |

**FR-EM-8** 한국어 UI 문자열에서 "세션"을 "창"으로 교체한다(`helpers.js:73,77,78`, `app.js:1052,2049`, `index.html:17`). Pane 은 UI 에 명사로 노출되지 않으므로 신규 한국어 어휘를 도입하지 않는다.

**FR-EM-9** 내부 식별자 `_killBg` 를 개명한다. `Bg` 는 fire-and-forget 을 뜻하므로 `background` 가 도메인 어휘가 되는 순간 혼란원이 된다.

#### 3.1.2 도구 1급화

**FR-EM-10** 도구는 탭에 임베드되지 않고 **별도 컬렉션에 존재하며 탭이 참조**한다. `panes.json` → `tools.json`.

**FR-EM-11** 탭은 도구를 0개 또는 1개 참조한다. 참조 없는 탭(빈 탭)과 탭에 참조되지 않는 도구(백그라운드 도구)가 모두 유효한 상태다.

**FR-EM-12** `tools.json` 에는 **탭이 참조하는 도구만** 기록한다. 백그라운드 도구는 기록하지 않는다(FR-BG-9 의 근거).

**FR-EM-13** 도구 타입은 `terminal` \| `editor` \| `markdown` 이며, 타입별로 `backgroundCapable` 을 갖는다. 현 시점 `terminal` 만 `true` 다.

#### 3.1.3 참조 무결성

**FR-EM-14** 데몬 부팅 시 `tools.json` 과 `workspace.json` 의 참조를 교차 검증한다. 어떤 탭에도 참조되지 않는 항목은 **복원하지 않고 폐기**한다. `LoadAll` 의 무조건 복원(§2.4)을 대체한다.

**FR-EM-15** 탭·Pane·Window 제거 시 참조된 도구를 종료한다. 유일한 예외는 백그라운드로 전환된 도구다(FR-BG-2/3/4).

**FR-EM-16** `agentsOrder` 에서 존재하지 않는 도구 id 를 부팅 시 제거한다.

#### 3.1.4 백그라운드

**FR-BG-1** 탭 닫기의 **기본 동작은 도구 종료**다. 추가 확인이나 선택을 요구하지 않는다.

**FR-BG-2** 탭 안에서 `detach` 명령을 실행하면 그 탭의 도구가 백그라운드로 전환되고 **탭은 닫힌다.** 명령 이름으로 `bg` 를 쓰지 않는다 — zsh/bash 작업 제어 빌트인과 충돌한다.

**FR-BG-3** busy 인 탭을 닫을 때 이미 표시되는 확인창(`app.js:1181`)에 `백그라운드로` 버튼을 추가한다. 버튼 3개는 `닫기` / `백그라운드로` / `취소` 다. 기존 `_confirmClose(msg, opts)` 의 옵션 버튼 패턴(`opts.saveBtn`, `app.js:492`)을 재사용하며 신규 UI 컴포넌트를 만들지 않는다.

> FR-BG-2 와 FR-BG-3 은 상호 보완이다. 프로세스가 도는 탭에서는 셸 프롬프트가 없어 `detach` 를 입력할 수 없고, 바로 그 탭이 확인창을 띄우는 탭이다.

**FR-BG-4** Window 제거 시 도구 처리를 다음으로 정의한다. Window 제거는 안의 모든 탭을 닫는 동작이므로 탭과 동일한 선택지를 제공한다.

| 경로 | 동작 |
|------|------|
| Window 닫기 — busy 도구 없음 | 확인 없이 제거. 전원 종료 (FR-BG-1 대칭) |
| Window 닫기 — busy 도구 있음 | 확인창(`app.js:1052`, `delSession`) 3버튼: `닫기` / `실행 중인 것만 백그라운드로` / `취소` |
| 마지막 탭 닫힘에 의한 Window 소멸 (`app.js:1192`) | 탭 단위 결정(FR-BG-1/2/3)이 이미 적용된 상태. 추가 확인·전환을 하지 않는다 |
| 원격 `closeWindow` (`dmctl close-window`, `workspace_command`) | 현행 유지 — UI 와 동일 경로(`closeSessionActive`→`delSession`)를 거치므로 확인창이 표시된다. 무인 전환 인자는 도입하지 않는다(§5) |

**FR-BG-4a** 일괄 전환 대상은 **busy 인 `backgroundCapable` 도구만**이다. 한가한 도구는 종료한다. 근거: 확인창이 뜨는 사유가 "실행 중인 프로세스"이고, 한가하면 그냥 종료한다는 FR-BG-1 의 기본과 일관되어야 한다. 명시적 지목(FR-BG-2 `detach`)과 일괄 처리는 판단 기준이 달라야 하며, 한가한 셸까지 일괄 보존하면 백그라운드가 쓰레기로 채워진다.

**FR-BG-4b** `backgroundCapable=false` 도구는 전환 대상이 아니며 종료된다. editor 의 미저장 변경 확인은 현행 `delSession` 이 수행하지 않으며, 본 SRS 는 이 동작을 변경하지 않는다(NFR-EM-3).

**FR-BG-4c** 마지막 Window 제거로 새 Window 가 자동 생성될 때(`_mkSession`, `app.js:1057`) 백그라운드로 전환된 도구를 자동 복귀시키지 않는다. 백그라운드 목록에 남으며 FR-BG-7/8 로만 복귀한다.

**FR-BG-5** Window 자체에는 detach 동작을 제공하지 않는다. Window 는 서버에 영속되어 있고 어떤 Client 도 보지 않는 동안에도 안의 도구가 계속 실행되므로, tmux 의 detach 에 해당하는 상태가 이미 기본값이다. 백그라운드 전환이 도구 단위인 이유는 도구만이 탭 생명주기에 묶여 있기 때문이다.

**FR-BG-6** `detach --list` 는 백그라운드 도구 목록을 반환한다. 각 항목은 도구 id, 이름, cwd, 백그라운드 전환 시각을 포함한다.

**FR-BG-7** `detach --restore <id> [--at <uuid>]` 는 백그라운드 도구를 **지정 Pane**(`--at` 미지정 시 현재 Pane)의 새 탭으로 복귀시킨다. 복귀한 도구는 백그라운드 상태에서 벗어난다. `--at` 의 값은 탭 uuid 이며 복귀는 Pane 단위이므로 탭 성분은 무시된다. 대상 Pane 이 없으면 백그라운드 상태를 해제하지 않는다. (`USER_CHECKLIST_FIXES_SRS` FR-BGR-1..6)

**FR-BG-8** 백그라운드 도구가 1개 이상일 때 상태바 **우측 끝**에 개수 버튼을 표시한다. 버튼 클릭 시 목록을 **중앙 모달**로 표시하고, 항목 클릭 시 FR-BG-7 와 동일하게 복귀시킨다. 0개일 때 버튼은 표시하지 않는다. (UI 표면은 `USER_CHECKLIST_FIXES_SRS.md` FR-BGU-2..8 이 규정한다 — 동작 계약은 불변)

**FR-BG-9** 백그라운드 도구는 **데몬 재시작을 넘겨 복원하지 않는다.** 근거: 현 `LoadAll` 은 프로세스를 복원하는 것이 아니라 같은 cwd 로 새 빈 셸을 만드는 것이며(`pane.go:921`), 백그라운드로 보낸 이유가 "돌고 있던 작업"이므로 빈 셸로 되살릴 의미가 없다. 이 규칙이 고아 누적을 원리적으로 차단하므로 **TTL·개수 한도·회수 스케줄러를 도입하지 않는다.**

**FR-BG-10** 백그라운드 전환 상태는 데몬 런타임에만 보관한다. 웹서버는 데몬에 조회한다. FR-EM-12 와 FR-BG-9 의 직접 결과다.

**FR-BG-11** `backgroundCapable=false` 인 도구 타입에는 FR-BG-2/3/4 의 경로를 제공하지 않는다. FR-BG-4 에서 그 Window 의 비대상 도구는 종료된다.

#### 3.1.5 Run 접합 (필드만)

**FR-EM-17** 다음 접합면만 정의한다. 런타임·API·스킬 재작성은 본 SRS 범위 밖이다(§5).

- `Tool.runId?: string` — 이 도구를 소유한 Run
- `Window.ownerRunId?: string` — 이 Window 를 Run 이 전용으로 만들었음
- `RunProjection` enum — `dedicated-window` \| `background` \| `inline`

**FR-EM-18** 위 필드는 없거나 비어 있어도 모든 동작이 정상이어야 한다. 본 SRS 단계에서 이 필드를 읽는 동작을 추가하지 않는다.

### 3.2 비기능 요구사항 (Non-functional)

**NFR-EM-1** 개명은 구 이름 alias 를 제공하지 않는다. 구 이름 요청은 명확한 오류로 실패해야 하며, 조용히 성공해서는 안 된다.

**NFR-EM-2** 마이그레이션은 1회성 스크립트로 수행하며, 원본 `workspace.json` / `panes.json` 을 백업한 뒤 변환한다.

**NFR-EM-3** 개명은 동작을 변경하지 않는다. FR-BG-* 를 제외한 모든 관측 가능한 행위는 개명 전후로 동일해야 한다.

**NFR-EM-4** 도구 조회·전환 경로는 핫패스가 아니다. 다만 상태바 배지 갱신이 기존 SSE 채널을 재사용해야 하며 새 폴링을 도입하지 않는다.

### 3.3 설계 제약 (Design Constraints)

**DC-EM-1** 좌표계는 3성분(`W.P.T`)을 유지한다. Split 성분을 추가하지 않는다.
**DC-EM-2** Client↔Window attach 를 서버에 등록하지 않는다(§5).
**DC-EM-3** 최상위 Session 컨테이너를 도입하지 않는다. 어휘는 예약 상태로 비워둔다.
**DC-EM-4** 도구 식별자 값 형식(숫자 문자열)을 변경하지 않는다. 키 이름만 `paneId`→`toolId` 로 바뀐다.
**DC-EM-5** 신규 UI 컴포넌트를 만들지 않는다. 확인창은 `_confirmClose` 확장, 목록은 상태바 배지 팝오버.

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| ID | 대상 | 시나리오 | 기대 |
|----|------|----------|------|
| TC-EM-1 | FR-EM-2 | 구 스키마 `workspace.json` 로드 | 오류. 조용한 성공 금지 |
| TC-EM-2 | FR-EM-3 | `focus W1.P2.T1` | 개명 전 `S1.P2.T1` 과 동일한 대상 |
| TC-EM-2b | FR-EM-3, NFR-EM-1 | `focus S1.P2.T1` | 해석 실패 오류 |
| TC-EM-2c | FR-EM-3, DC-EM-1 | Split 중첩 3단 Window 의 라벨 생성 | 3성분 유지. Split 성분 없음. `P` 는 in-order 위치 |
| TC-EM-3 | FR-EM-4, NFR-EM-1 | `list_panes` 호출 | 미존재 툴 오류 |
| TC-EM-4 | FR-EM-5, NFR-EM-1 | `dmctl new-session` | `unknown command` + exit 2 |
| TC-EM-5 | FR-EM-7 | `/api/panes/1/busy` | 404 |
| TC-EM-6 | FR-EM-11 | 도구 참조 없는 탭 생성 | 유효 상태로 영속·렌더 |
| TC-EM-7 | FR-EM-14 | `tools.json` 에 미참조 항목 3개 + 부팅 | 3개 미복원. 셸 미생성 |
| TC-EM-8 | FR-EM-15 | 도구 참조하는 Window 삭제 | 도구 종료 |
| TC-EM-9 | FR-EM-16 | `agentsOrder` 에 유령 id | 부팅 후 제거 |
| TC-BG-1 | FR-BG-1 | 한가한 탭 닫기 | 확인 없이 닫힘. 도구 종료 |
| TC-BG-2 | FR-BG-2 | 탭에서 `detach` | 탭 닫힘. 도구 생존. 목록에 출현 |
| TC-BG-3 | FR-BG-2 | 셸에서 `bg` 입력 | 셸 빌트인으로 동작. dongminal 미개입 |
| TC-BG-4 | FR-BG-3 | busy 탭 닫기 → `백그라운드로` | 탭 닫힘. 프로세스 계속 실행 |
| TC-BG-5 | FR-BG-3 | busy 탭 닫기 → `닫기` | 도구 종료 |
| TC-BG-6 | FR-BG-3 | busy 탭 닫기 → `취소` | 탭 유지 |
| TC-BG-6b | FR-BG-4, 4a | busy 2개 + 한가함 1개인 Window 닫기 → `실행 중인 것만 백그라운드로` | Window 닫힘. busy 2개 생존·목록 출현. 한가한 1개 종료 |
| TC-BG-6c | FR-BG-4 | 같은 상황 → `닫기` | 도구 3개 전부 종료 |
| TC-BG-6e | FR-BG-4 | busy 도구 없는 Window 닫기 | 확인창 없음. 전원 종료 |
| TC-BG-6f | FR-BG-4 | 마지막 탭을 `detach` 로 닫아 Window 소멸 | 도구 백그라운드 유지. Window 확인창 미표시 |
| TC-BG-6g | FR-BG-4b | busy terminal + editor 가 있는 Window 닫기 → `실행 중인 것만 백그라운드로` | terminal 생존. editor 종료 |
| TC-BG-6h | FR-BG-4c | 유일한 Window 를 `실행 중인 것만 백그라운드로` 로 닫기 | 새 빈 Window 생성. 도구는 백그라운드 유지 (자동 복귀 없음) |
| TC-BG-6d | FR-BG-5 | 모든 Client 가 다른 Window 로 이동 / 브라우저 전부 종료 | 도구 계속 실행. 별도 detach 동작 없음 |
| TC-BG-7 | FR-BG-7 | 백그라운드 도구 복귀 | 현재 Pane 새 탭에 부착. 스크롤백 보존. 목록에서 제거. 대상 지정(`--at`) 케이스는 TC-BGR-1..6b |
| TC-BG-8 | FR-BG-8 | 백그라운드 0개 | 배지 미표시 |
| TC-BG-9 | FR-BG-9 | 백그라운드 도구 있는 상태로 데몬 재시작 | 미복원. `tools.json` 미기재 |
| TC-BG-10 | FR-BG-11 | editor 탭에서 `detach` | 미지원 오류 |
| TC-EM-10 | FR-EM-18 | `runId`/`ownerRunId` 없는 데이터 | 전 기능 정상 |
| TC-EM-11 | NFR-EM-2 | 실 데이터 마이그레이션 | 백업 생성. Window 8개·도구 10개 보존. 고아 10개 폐기 |

### 4.2 완료 조건 (DoD)

- `grep -rn '\bregion\b' internal/ web/js/` 가 개명 잔재 0
- `grep -rn 'paneId' internal/ web/js/` 가 0 (좌표계 `P` 는 대상 아님)
- 좌표계 라벨 생성·파싱이 `W{n}.P{n}.T{n}` 만 산출·수용
- `grep -rn '세션' web/js/ web/index.html` 이 0
- 기존 Go·Playwright 테스트 전부 통과 (NFR-EM-3)
- 실 데이터 마이그레이션 후 부팅 시 생성 셸 수 = 탭 참조 도구 수
- `docs/external/*`, `docs/internal/architecture.md`, `README.md`, `skills/dongminal-team`, `skills/dongminal-workflow` 의 어휘 갱신
- 새 코드에 TODO 없음. 미사용 import 없음

---

## 5. 비목표 (Non-goals)

| 항목 | 이유 |
|------|------|
| Run 런타임·API·스킬 재작성 | 요구 3번. 접합면만 정의(FR-EM-17) |
| Client↔Window attach 서버 등록, visibility 서버 파생 | 1번 완료에 불필요. `dmctl` 이 "누가 보고 있나"를 답하려면 필요하지만 별도 SRS |
| 최상위 Session 컨테이너 | DC-EM-3. 백그라운드 정책이 두 레벨로 갈려 요구 2번을 복잡화 |
| "새 터미널"의 기본 동작 정의 (새 Window/Tab/분할 중 무엇) | 구조·네이밍 재정비 범위 밖. 현 동작(각각 별도 명령·단축키) 유지 |
| 비터미널 도구의 백그라운드 | FR-BG-11. `backgroundCapable=false` |
| 백그라운드 도구의 데몬 재시작 생존 | FR-BG-9. 빈 셸 복원은 의미 없음 |
| 도구를 다른 탭·Pane·Window 로 이동 | 1급화가 가능하게 만들지만 본 SRS 는 기능을 추가하지 않음 |
| 백그라운드 도구 회수 정책(TTL·한도) | FR-BG-9 이 누적을 원리적으로 차단 |
| 원격 `closeWindow` 의 무인 백그라운드 전환 인자 | FR-BG-4. Run 이 Window 를 정리하는 시나리오는 후속 SRS |
| `delSession` 의 editor 미저장 변경 확인 | FR-BG-4b. 현행 결손이나 개명 범위 밖 |
| 다중 창 포커스 소유권 부채 정리 | 별도. Client 등록이 선행. **부분 해소됨** — 전파 경로는 `USER_CHECKLIST_FIXES_SRS` §3.5(FR-XDF-*, 묶음 E)에서 `BroadcastChannel` → 서버 권위(`FocusRegistry`)로 옮겼고 SSE 구독에 `clientId` 가 결선됐다. 남은 것은 Client 를 1급 엔티티로 등록하는 것(`CLIENT_ATTACH_SRS`)이다 |

---

## 6. 마이그레이션 단계 (Migration Phases)

| Phase | 내용 | 검증 |
|-------|------|------|
| **P1** | 마이그레이션 도구 — 순수 변환 함수 + `dongminal migrate` (NFR-EM-2) | TC-EM-11 |
| **P2** | 스키마 전환 (원자적) — `workspace.json` 스키마, Go 파서, 브라우저, 좌표계 `S`→`W` (FR-EM-2/2a/3) | TC-EM-1, TC-EM-2/2b/2c |
| **P3** | 공간 계층 어휘 심볼 (`workspace`·`paneline`·JS) + 한국어 UI + `_killBg` (FR-EM-8/9) | 기존 테스트 |
| **P4** | 외부 계약 개명 — MCP·dmctl·`workspace_command`·HTTP·SSE + 단축키 id·`settings.json` 마이그레이션 (FR-EM-4~7, 6a) | TC-EM-3/4/5 |
| **P5** | 도구 1급화 + 참조 무결성 + PTY 계층 심볼 개명 (FR-EM-10~16) | TC-EM-6~9 |
| **P6** | 백그라운드 (FR-BG-1~11) | TC-BG-1~10 및 6b~6h |
| **P7** | Run 접합 필드 (FR-EM-17/18) | TC-EM-10 |
| **P8** | 문서·스킬 어휘 갱신 | DoD |

**P1 과 P2 를 분리한 이유:** 데이터 스키마와 이를 읽는 코드(Go 파서 + 브라우저)는 함께 바뀌어야 하므로 P2 는 원자적 단계다. P1 은 아무것도 깨뜨리지 않는 독립 도구여서 먼저 완성·검증할 수 있다.

P1 의 마이그레이션은 `workspace.json` 과 `panes.json`→`tools.json` 을 **한 번에** 처리한다(사용자가 두 번 마이그레이션하지 않도록). 파일 개명은 P1, 참조 무결성의 런타임 강제(FR-EM-14)는 P5.

`internal/server` 의 PTY 계층 심볼(`PaneManager`·`PaneHub`·`PaneClient`·`StartPane`, 200여 곳)은 P3 이 아니라 **P5** 에서 개명한다. 이 레이어는 `terminal` 도구만 다루므로 올바른 이름(`ToolManager` vs `TerminalManager`)이 P5 의 도구 모델(FR-EM-13)에 달려 있다 — P3 에서 정하면 P5 에서 다시 바꾸게 된다.

P4 는 재기동을 요구한다(alias 미제공). P5 는 P2 에 의존한다. P6 은 P5 에 의존한다.

---

## 7. 의존 SRS / 후속 SRS

**의존:** `UUID_IDENTITY_SRS`(좌표계 보존), `DAEMON_SPLIT_SRS`(데몬 도구 소유), `MULTI_TAB_TYPE_SPEC`(도구 타입)

**후속:**

- `RUN_ORCHESTRATION_SRS` (요구 3번) — Run 런타임, 투영 정책 구현, `dongminal-team`/`dongminal-workflow` 재작성, 활동 패널의 Run별 그룹화. 참조 대상인 Orca(ADE)와의 대비는 아래 표. 본 SRS 의 `Tool.runId` / `Window.ownerRunId` / `RunProjection`(FR-EM-17)이 그 접합면이다.

| 축 | Orca | dongminal 현재 |
|----|------|----------------|
| 격리 | agent 당 git worktree — 파일시스템 수준 | Pane 분할 — UI 수준만. **같은 워킹트리 공유** (repo 에 worktree 개념 0건) |
| 에이전트 간 통신 | 없음. fan-out → 비교 → 병합 | `send_agent_message` 신뢰 채널 + 토폴로지 협업 — **Orca 에 없는 차별점** |
| 실행 관측 | 워크트리별 터미널·에디터·브라우저 | 활동 패널 (도구 단위 평면 목록) |
| 리뷰 | diff 인라인 주석 → 에이전트로 되돌림 | 없음 |
| 착수 | GitHub/Linear 태스크에서 worktree 개설 | 없음 |
| 실행 상태 | 워크트리가 실체 | **없음** — `workflows/*.md` 정의서만 있고 런타임 실체 부재 |

후속 SRS 는 **Orca 의 장점을 최대한 도입한다.** 동작 명세뿐 아니라 **Orca 의 실제 구현(MIT 라이선스 공개 소스)을 읽어 구현 패턴을 참고한다** — worktree 생성·정리, 에이전트 프로세스 감독, diff 주석의 에이전트 왕복, 다중 에이전트 상태 표현. 도입 대상 — worktree 격리, fan-out→비교→병합, diff 인라인 주석 리뷰, 태스크 연동, Run 의 실행 실체. dongminal 의 신뢰 채널 기반 협업 토폴로지는 Orca 에 없는 축이므로 제거하지 않고 병존시킨다.

도입 시 해소해야 할 결정: worktree 격리는 팀원 간 파일 공유를 차단하므로, **격리 여부를 Run 단위로 선택**하게 할지(공유 협업과 격리 fan-out 이 모두 가능) 아니면 **항상 격리하고 통신 채널만으로 협업**하게 할지. 전자는 두 실행 모드를 유지해야 하고, 후자는 기존 `dongminal-team` 의 일부 토폴로지가 성립하지 않게 된다.
- `CLIENT_ATTACH_SRS` — Client↔Window attach 서버 등록, visibility 파생, 다중 창 포커스 소유권 정리
