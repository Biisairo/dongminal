# SRS: 알람 수명·핀 리포 전체 관측 — IEEE 29148

> **후속 문서가 이 SRS 의 일부를 개정했다.** 어긋나면 후속이 이긴다.
>
> | 개정된 것 | 어떻게 | 어디서 |
> |---|---|---|
> | FR-GOB-5·9 (관측은 **Git 탭을 보고 있는 동안**) | 그 탭은 `Repo` 다 (id `repo`). 판정이 옛 문자열 `'git'` 을 보고 있어 **배지가 영영 서지 않았다** — 실측한 결함이다 | REPO_TAB_UNIFY_SRS FR-RTU-1·6 / D-RTU-26 |
> | FR-GOB-13 (탭 헤더 배지는 없다) | 그대로다. 행마다 붙는 배지는 `Repo` 행이 `_gitBadgeFor` 로 읽는다 | REPO_TAB_UNIFY_SRS FR-RTU-6 |

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말은 두 줄이다.

> 1. 알람. 알람이 없어야하는곳에 있거나 있어야하는 곳에서 없는경우가 많다 확인한번 해줘.
> 2. git 알람. git 탭에 숫자가 떠있는데 정작 깃 탭에 들어가보면 어디서 변경이
>    있는지 확인이 안된다. 해당 깃 행을 클릭하기전에는 깃업데이트가 안된다.
>    깃 탭에 들어간 순간부터 등록된 깃 들이 모두 업데이트되도록 하자. 클릭해서
>    들어가있는 깃뿐아니라.

1 은 감사 요청이고, 2 는 확정된 지시다. 감사(§2.1)로 드러난 결함을 요구사항으로
옮긴 것이 묶음 L·J 이며, 2 를 옮긴 것이 묶음 O 다.

### 1.2 범위 (Scope)

**포함:**

| 묶음 | 이름 | 접수 항목 |
|---|---|---|
| **묶음 L** | 도구 알람의 수명 (Lifecycle) | 1 |
| **묶음 J** | 갈 곳 없는 알람의 착지 (Jump) | 1 |
| **묶음 O** | 핀 리포 전체 관측 (Observe) | 2 |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **주의(attention)** | 도구가 사용자를 부르는 상태. `Tool.attention` / `AttnTracker.attention` |
| **활동(activity)** | 에이전트가 지금 무엇을 하는지. `Tool.activity` — 주의와 직교하는 별개 레이어 |
| **유령 알람** | 대상 도구가 이미 없는데 남아 있는 주의 상태 |
| **관측(observation)** | `git status` 1회의 결과 (`store.Observation`). 배지는 마지막 관측값을 읽는다 |
| **핀 리포** | `workspace.json` 의 `git.pinned` 에 등록된 저장소. Git 탭 목록의 전부 |

### 1.4 참조 (References)

- [`./archive/PANE_ATTENTION_NOTIFY_SRS.md`](./archive/PANE_ATTENTION_NOTIFY_SRS.md) — FR-PAN-*, NFR-PAN-8/10
- [`./archive/AGENT_ACTIVITY_PANEL_SRS.md`](./archive/AGENT_ACTIVITY_PANEL_SRS.md) — FR-AAP-20 (활동 카드의 정리 규약)
- [`./archive/DAEMON_SPLIT_SRS.md`](./archive/DAEMON_SPLIT_SRS.md) — FR-15 (데몬 모드 주의 동등성)
- [`./GIT_SRS.md`](./GIT_SRS.md) — FR-GIT-14/21/22/24/63 (배지·폴링 게이팅·Store)
- [`./GIT_SIDEBAR_TABS_SRS.md`](./GIT_SIDEBAR_TABS_SRS.md) — FR-SBT-12/13/19 (탭 서술자·배지)
- [`./CONVENIENCE_SRS.md`](./CONVENIENCE_SRS.md) — FR-BG-2/3 (백그라운드 도구), FR-BGR-5 (복귀)

### 1.5 인터뷰로 확정한 결정 (2026-08-28)

| # | 물음 | 확정 |
|---|---|---|
| **D-1** | 핀 전체 관측을 언제 돌릴까 | **Git 탭이 활성일 때만.** 진입 즉시 1회 + 이후 목록 폴링마다 |
| **D-2** | 그러면 다른 탭에서 보는 Git 탭 배지는 | **배지를 없앤다.** 낡은 값으로만 채울 수 있는 숫자는 보이지 않는 편이 낫다 |
| **D-3** | 탭 없는 도구의 알람 항목을 클릭하면 | **백그라운드면 복귀, 아니면 해제** |

> D-2 가 D-1 의 필연이다. 관측을 Git 탭 안으로 가두면 그 밖에서 보이는 숫자는
> 근거를 잃는다. "숫자는 떴는데 들어가면 확인이 안 된다"가 접수한 말이므로,
> 근거 없는 숫자를 남기는 것은 고친 것이 아니다.

---

## 2. 전체 설명 (Overall Description)

### 2.1 감사로 확정한 사실 (접수 1)

| # | 사실 | 근거 |
|---|---|---|
| A1 | `Tool.kill()` 은 활동을 `ended` 로 정리하지만 **주의는 그대로 둔다** | `toolhub/tool.go:660` |
| A2 | 데몬 모드 `AttnTracker` 에는 **제거 경로가 없다.** `tools` 맵이 무한히 는다 | `hub/attn_tracker.go` 전체 |
| A3 | 데몬 모드 `OnExit` 도 활동만 정리한다 | `cmd/dongminal/main.go:369` |
| A4 | `apiToolDelete` 는 주의 상태를 건드리지 않는다 | `httpapi/handlers_api.go:225` |
| A5 | 클라이언트 `_kill`·`_killTool` 도 `_attn` 에서 지우지 않는다 | `app-tool.js:122,128` |
| A6 | `_attnRestore` 는 **병합만** 한다 — 서버에 없는 id 를 지우지 않는다 | `app-attn.js:40` |
| A7 | 바로 옆 `_fgApply` 는 "목록에 없는 도구의 이름은 지운다"고 **명시적으로** 정리한다 | `app-cmd.js:147` |
| A8 | `_attnRestore` 는 `_attnRefresh` 만 부른다 — `_attnClearFocused` 를 부르지 않는다 | `app-attn.js:40-47` |
| A9 | `_jumpToTool` 은 탭 위치를 못 찾으면 **조용히 return** 한다 | `app-attn.js:113` |
| A10 | 알림 항목 이름은 `_toolName(toolId,toolId)` — 죽은 도구는 파생 이름이 없어 **raw UUID** 로 보인다 | `app-attn.js:185`, `helpers.js:345` |
| A11 | `gitBadge` 는 `Store.Observed` 만 읽는다. 이 경로는 `git status` 를 실행하지 않는다 | `gitapi/handlers_git.go:173` |
| A12 | 관측을 만드는 유일한 폴링은 **활성 리포 하나**로 게이팅된다 | `git/panel.js:2194 _pollOk` |
| A13 | 사이드바 탭 배지는 **비활성 탭에서만** 보인다 | `sidebar-tabs.js:updateBadges` |
| A14 | `Store` 는 single-flight + TTL(200ms) 캐시를 갖는다 | `git/store/store.go:16` |

### 2.2 A1~A5 가 "없어야 할 곳의 알람" 이다

주의와 활동은 직교하는 두 레이어인데, **정리 규약이 활동에만 있다.** 도구가 죽는
네 경로(셸 exit·`kill()`·`DELETE /api/tools/{id}`·클라이언트 탭 닫기) 전부가 활동은
`ended` 로 내리고 주의는 그대로 둔다. NFR-PAN-8 은 "pane 종료 시 상태 정리" 를
요구하므로 이것은 미구현이다.

A6 이 그것을 영구화한다. 화면을 새로 고쳐도 서버가 유령 id 를 계속 답하므로
(A2·A4), 사용자가 `모두 제거` 를 누르기 전까지 배지가 내려가지 않는다. A10 이
겹쳐 그 항목은 이름조차 UUID 이고, A9 로 클릭해도 아무 일이 없다.

### 2.3 A11~A13 이 접수 2 다

배지는 마지막 관측값이고, 관측을 만드는 사람은 **활성 리포의 폴링 하나뿐**이다.
그래서 클릭해 연 적 없는 핀은 영원히 배지가 없고, 한 번 연 핀은 그때의 숫자가
그대로 굳는다. 여기에 A13 이 겹쳐 Git 탭에 들어가는 순간 배지가 사라지므로,
사용자에게는 "숫자가 있었는데 들어가니 없다" 로 보인다.

---

## 3. 요구사항 (Specific Requirements)

### 3.1 묶음 L — 도구 알람의 수명

#### 3.1.1 서버: 종료가 곧 해제

| ID | 요구사항 |
|---|---|
| **FR-ATL-1** | 도구가 종료되면 그 도구의 주의는 해제된다. 켜져 있었던 경우에만 `tool_attention_clear` 를 발행한다 (에지, NFR-PAN-3) |
| **FR-ATL-2** | 직접 모드에서 FR-ATL-1 의 자리는 `Tool.kill()` 이다 — 활동을 `ended` 로 내리는 바로 그 자리다. 셸 exit·API 삭제·워치독이 모두 이 한 자리를 지난다 |
| **FR-ATL-3** | 데몬 모드에서 FR-ATL-1 의 자리는 `ToolClient.OnExit` 이다. 활동 정리와 **같은 콜백**에서 함께 한다 |
| **FR-ATL-4** | `AttnTracker` 는 도구 하나의 상태를 통째로 버리는 `Forget(toolID)` 를 갖는다. 주의가 켜져 있었으면 해제를 발행한 뒤 맵에서 제거한다 |
| **FR-ATL-5** | `DELETE /api/tools/{id}` 는 도구를 지운 뒤 FR-ATL-4 를 부른다 — 데몬 모드에서 `OnExit` 가 오지 않는 경로(이미 죽은 도구의 삭제)를 위한 것이다 |
| **FR-ATL-6** | `AttnTracker.AttentionIDs` 는 **살아 있는 도구만** 답한다. 판정은 주입된 liveness probe 로 하며, probe 가 없으면 지금과 같이 전부 답한다 |

#### 3.1.2 클라이언트: 서버가 권위

| ID | 요구사항 |
|---|---|
| **FR-ATL-7** | `_kill`·`_killTool` 은 도구를 지우기 전에 그 도구의 알람을 로컬에서 제거한다. 서버 왕복을 기다리지 않는다 |
| **FR-ATL-8** | `_attnRestore` 는 서버 집합을 **권위**로 쓴다. 응답에 없는 id 는 로컬에서 제거하고, 그 도구의 데스크톱 알림도 닫는다 (`_fgApply` 와 같은 규약 — A7) |
| **FR-ATL-9** | FR-ATL-8 의 제거는 `POST /api/tools/attention/clear` 를 부르지 않는다 — 서버가 이미 모르는 것을 다시 지우라고 말하지 않는다 |
| **FR-ATL-10** | `_attnRestore` 는 복원 후 `_attnClearFocused()` 를 부른다 — 브라우저가 OS 포커스를 가진 경우에만 (NFR-PAN-10 과 같은 조건) |
| **FR-ATL-11** | FR-ATL-8 이 지울 후보는 **요청을 떠나기 전에** 확정된다. 응답은 요청 시점의 서버 상태이고 이 함수는 SSE 가 열리는 순간에 불리므로(`es.onopen`), 응답 도착 시점의 집합을 지우면 그 사이 SSE 로 올라온 새 알람이 태어나자마자 사라진다 |

### 3.2 묶음 J — 갈 곳 없는 알람의 착지

| ID | 요구사항 |
|---|---|
| **FR-ATJ-1** | 탭이 없는 도구의 알람 항목을 클릭하면, 그 도구가 백그라운드 목록에 있을 때 **복귀시킨다** (`_restoreTool` — FR-BGR-5 의 경로를 그대로 쓴다) |
| **FR-ATJ-2** | 백그라운드 목록에도 없으면 그 알람을 **해제**한다. 클릭이 아무 일도 하지 않는 경우는 없다 |
| **FR-ATJ-3** | FR-ATJ-1·2 의 판정은 `_jumpToTool` 한 자리에 둔다 — 알림 센터와 활동 카드가 같은 함수를 부르므로 두 벌로 만들지 않는다 |

### 3.3 묶음 O — 핀 리포 전체 관측

#### 3.3.1 서버 종단

| ID | 요구사항 |
|---|---|
| **FR-GOB-1** | `GET /api/git/repos` 는 `observe=1` 을 받는다. 주면 응답을 만들기 전에 **핀된 저장소 전부를 관측**한다 |
| **FR-GOB-2** | 관측은 `Store.Status` 를 지난다 — single-flight 와 TTL 이 그대로 적용된다 (A14). git 을 직접 실행하지 않는다 |
| **FR-GOB-3** | 관측은 병렬로 하되 동시 실행 수에 상한을 둔다. 상한은 named 상수다 |
| **FR-GOB-4** | 한 리포의 관측 실패는 다른 리포의 응답을 막지 않는다. 실패한 리포는 배지 없이(`null`) 실려 나간다 — 목록 자체가 실패하지 않는다 |
| **FR-GOB-5** | `observe` 가 없으면 지금과 **완전히 같다** — 캐시만 읽고 git 을 실행하지 않는다 (FR-GIT-24 유지) |
| **FR-GOB-6** | 요청이 취소되면(클라이언트 이탈) 남은 관측을 시작하지 않는다 — `r.Context()` 를 그대로 넘긴다 |

#### 3.3.2 클라이언트 호출 규약

| ID | 요구사항 |
|---|---|
| **FR-GOB-7** | `_gitReposRefresh` 는 관측 여부를 인자로 받지 않는다. **Git 탭이 활성인지**를 스스로 보고 정한다 — 조건이 두 자리에 흩어지면 한쪽이 낡는다 |
| **FR-GOB-8** | 관측 조건은 셋이 전부 참일 때다: ① 사이드바의 활성 탭이 `git` ② `document.hidden` 이 거짓 ③ `_gitOff` 가 거짓 |
| **FR-GOB-9** | Git 탭을 활성화하는 순간 **즉시 1회** 관측 갱신이 돈다. 다음 폴링 주기를 기다리지 않는다 |
| **FR-GOB-10** | 이후 `GIT_REPOS_POLL_MS` 주기의 목록 폴링이 관측 갱신을 겸한다 — 별도 타이머를 만들지 않는다 |
| **FR-GOB-11** | Git 탭을 떠나면 다음 폴링부터 관측이 멈춘다. 목록 폴링 자체는 지금처럼 계속 돈다 |
| **FR-GOB-12** | 관측 갱신은 활성 리포를 특별 취급하지 않는다. GitPanel 의 폴링(FR-GIT-22)은 그대로 두고, 이것은 그 위에 겹쳐 도는 별개의 갱신이다 |

#### 3.3.3 배지 (D-2)

| ID | 요구사항 |
|---|---|
| **FR-GOB-13** | Git 사이드바 탭의 **헤더 배지를 없앤다** — 서술자에서 `badge` 훅을 뺀다 (FR-SBT-19 의 선택 필드다) |
| **FR-GOB-14** | 목록 **행**의 배지는 유지한다. Git 탭 안에서는 FR-GOB-9·10 으로 최신이므로, 낡음 표시(`stale` 클래스·관측 시각 title)의 근거가 활성 리포 여부에서 **관측 시각**으로 바뀐다 |
| **FR-GOB-15** | Windows 탭의 배지(알람 있는 창 수)는 그대로다 — 그 값은 실시간 SSE 로 오므로 낡지 않는다 |

---

## 4. 검증 (Verification)

| ID | 검증 |
|---|---|
| **V-ATL-1** | `Tool.kill()` 후 `Attention()` 이 거짓이고 `onAttentionClear` 가 1회 불린다 (단위) |
| **V-ATL-2** | 주의가 없던 도구를 `kill()` 해도 `onAttentionClear` 는 불리지 않는다 (에지, 단위) |
| **V-ATL-3** | `AttnTracker.Forget` 후 `AttentionIDs` 에 그 id 가 없고 `tools` 맵에서 제거된다 (단위) |
| **V-ATL-4** | `AttnTracker.Forget` 은 주의가 켜져 있었을 때만 해제를 브로드캐스트한다 (단위) |
| **V-ATL-5** | liveness probe 가 거짓을 답하는 id 는 `AttentionIDs` 에 실리지 않는다 (단위) |
| **V-ATL-6** | `DELETE /api/tools/{id}` 뒤 `GET /api/tools/attention` 에 그 id 가 없다 (종단) |
| **V-ATL-7** | 복원 요청이 도는 동안 도착한 새 알람은 그 응답에 없어도 지워지지 않는다 (FR-ATL-11) |
| **V-ATJ-1** | 백그라운드 목록에 있는 도구의 알람 항목 클릭 → 복귀 경로가 불린다 (e2e 또는 단위) |
| **V-ATJ-2** | 어디에도 없는 도구의 알람 항목 클릭 → 알람이 사라진다 |
| **V-GOB-1** | `observe=1` 이면 핀 수만큼 관측이 일어나고, 관측된 적 없던 핀에 배지가 실린다 (종단) |
| **V-GOB-2** | `observe` 없이 부르면 관측이 **한 번도** 일어나지 않는다 (FR-GOB-5 회귀) |
| **V-GOB-3** | 한 핀이 저장소가 아니어도 나머지 핀의 배지가 실린다 (FR-GOB-4) |
| **V-GOB-4** | Git 탭 활성일 때 요청 URL 에 `observe=1` 이 붙고, Windows 탭에서는 붙지 않는다 |
| **V-GOB-5** | Git 탭 헤더에 배지 요소가 보이지 않는다 (e2e) |

---

## 5. 비기능 (Non-functional)

| ID | 요구사항 |
|---|---|
| **NFR-1** | 접수 2 의 비용은 **Git 탭을 보고 있는 동안**으로 묶인다. 다른 탭·백그라운드 문서에서는 git 실행 횟수가 지금과 같다 |
| **NFR-2** | 주의 정리는 활동 정리와 **같은 자리**에서 한다. 두 레이어의 수명 규약이 갈라진 것이 이 결함의 원인이므로, 새 정리 경로를 따로 만들지 않는다 |
| **NFR-3** | `go test -race ./...` 그린. `AttnTracker.Forget` 은 기존 잠금 규약(브로드캐스트는 잠금 밖)을 지킨다 |
| **NFR-4** | 알람 갱신은 전체 `render()` 를 부르지 않는다 (NFR-PAN-9 유지) |

---

## 6. 비목표 (Non-goals)

- **다중 브라우저 완전 동기화** — NFR-PAN-7 가정 유지
- **알람 이력** — 해제된 과거 알람의 보관·타임라인은 여전히 범위 밖
- **Git 탭 밖에서의 배지 부활** — D-2 로 없앤 것을 다른 수단(경량 시그니처 등)으로
  되살리지 않는다. 필요해지면 그때 별도 묶음이다
- **§2.1 A 목록 밖의 알람 경로** — L2 idle 임계값·OSC 감지·`dmctl notify` 의 규약은
  건드리지 않는다
