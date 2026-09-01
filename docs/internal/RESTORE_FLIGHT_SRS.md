# SRS: 복원 중에 도착한 갱신은 스냅숏보다 새롭다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`FG_RESTORE_RACE_SRS` §8 이 조사로 확정한 결함을 없앤다.

세 함수(`_attnRestore`·`_fgRestore`·`_activityRestore`)가 서버 스냅숏을 받아 로컬
상태와 정합하는데, **그 상태를 SSE 와 사용자 조작이 동시에 증분으로 갱신한다.**
요청이 떠난 뒤 응답이 오기까지의 창에서 도착한 갱신은 스냅숏에 반영돼 있지 않으므로,
응답을 그대로 적용하면 두 방향으로 잃는다:

| 방향 | 창 안에서 일어난 일 | 응답 적용 결과 |
|---|---|---|
| **A** | 새 항목이 추가됐다 | 스냅숏에 없으므로 **지워진다** |
| **B** | 항목이 제거됐다 | 스냅숏에 있으므로 **되살아난다** |

`FG_RESTORE_RACE_SRS` 묶음 A 가 **방향 A 만** 막았다. 그 수정이 도입한 `before`
규약은 "지울 후보"만 좁히고 되살리는 쪽은 손대지 않았다.

### 1.2 근본 원인은 규약이 손으로 복사된다는 것

`FG_RESTORE_RACE_SRS` §1.2 는 `_fgRestore` 가 **"`_attnRestore` 와 같은 규약"이라고
주석으로 선언만 하고 지키지 않았다**는 것을 결함의 사유로 들었다. 그 진단은 옳았으나
처방이 같은 모양이었다 — `before` 를 **`_fgRestore` 에 손으로 한 번 더 적어** 넣었다.

그래서 이번에는 규약을 **코드로 만든다.** 세 자리가 같은 함수를 부르면, 다음 복원
함수가 생겼을 때 규약을 손으로 옮겨 적다 틀릴 자리가 없다.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **비행(flight)** | 복원 요청이 떠난 시점부터 그 응답을 적용할 때까지의 구간 |
| **만진 id(touched)** | 비행 중에 SSE 또는 사용자 조작이 갱신한 id. **스냅숏보다 새롭다** |
| **비행 무효화(void)** | 비행 중 전체 초기화가 일어나 응답을 통째로 버려야 하는 상태 |
| **추월(supersede)** | 앞선 비행의 응답이 오기 전에 새 복원이 시작된 것. 앞의 응답은 버린다 |

### 1.4 참고 (References)

- `FG_RESTORE_RACE_SRS.md` §8 — 이 SRS 를 요구한 조사. 다섯 자리의 판정과 재현
- `FG_RESTORE_RACE_SRS.md` §1.2 — 규약을 선언만 하고 지키지 않은 앞선 사례

---

## 2. 전체 기술 (Overall Description)

### 2.1 대상 셋과 그 변경 지점

조사로 전수 확인한 변경 지점이다 (복원 함수 자신은 제외):

| 상태 | 복원 | 변경 지점 | 갱신 주체 |
|---|---|---|---|
| `_activity` | `_activityRestore` | `_onToolActivity`(set/delete) | SSE |
| `_fgNames` | `_fgRestore` | `_onToolForeground`(set/delete) | SSE |
| `_attn` | `_attnRestore` | `_onToolAttention`(set)·`_onToolAttentionClear`(delete)·`_attnDrop`(delete)·`_attnClear`(delete)·`_attnClearAll`(**clear**) | SSE + **사용자 조작** |

**`_attn` 만 사용자 조작으로도 바뀐다.** `_attnClear` 는 `_attnNoteInteraction`
(pointerdown/keydown)과 `_jumpToTool` 이 부른다 — 재연결 도중에 사용자가 알람을
거두면 낡은 스냅숏이 그것을 되살린다. 이것이 방향 B 가 이론이 아닌 이유다.

`_attnClearAll` 은 id 하나가 아니라 **전부**를 지우므로 만진 id 로 표현되지 않는다.
그 비행은 무효화한다 (FR-RSF-5).

### 2.2 왜 `before` 를 걷어내는가

`touched` 는 `before` 를 포함한다. 비행 중에 추가된 id 는 `touched` 에 들어가므로
"지울 후보에서 빼야 할 id" 가 자동으로 걸러진다 — `before`(요청 전 키 집합)를 따로
들 이유가 없다. **한 기전이 두 방향을 다 막는다.**

| 스냅숏에 | `touched` 에 | 처리 |
|---|---|---|
| 있다 | 없다 | 스냅숏을 적용한다 |
| 있다 | **있다** | **건너뛴다** — 로컬이 새롭다 (방향 B) |
| 없다 | 없다 | 지운다 (죽은 항목) |
| 없다 | **있다** | **건너뛴다** — 로컬이 새롭다 (방향 A) |

### 2.3 추월을 함께 막아야 하는 이유

`_activityRestore` 는 `_agentsStartPoll` 이 **`agentsPollMs`(기본 5,000ms)마다**
부른다. 앞 비행의 응답이 늦으면 새 비행이 시작되고, 그때 `touched` 를 새로 만들면
**앞 응답이 새 비행의 빈 집합을 보고 전부 적용해 버린다** — 고치려던 결함이 그대로
돌아온다.

그래서 비행을 **집합의 동일성(identity)** 으로 식별한다. 응답은 자기가 만든 집합이
아직 그 자리에 있을 때만 적용된다. 이 한 검사가 추월과 무효화를 동시에 처리한다.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항

**FR-RSF-1** `App` 에 복원 비행 규약을 **함수로** 둔다. 세 복원이 같은 함수를
부르며, 규약이 주석으로만 존재하지 않는다 (§1.2).

| 함수 | 계약 |
|---|---|
| `_restoreBegin(key)` | 비행을 연다. 새 `Set` 을 만들어 `key` 에 걸고 그것을 돌려준다. 앞선 비행은 그 순간 추월된다 |
| `_restoreLive(key,t)` | `t` 가 아직 `key` 의 비행인가. 추월·무효화됐으면 거짓 |
| `_restoreNote(key,id)` | 비행 중이면 `id` 를 만진 것으로 적는다. 비행이 없으면 아무 일도 하지 않는다 |
| `_restoreVoid(key)` | 비행을 무효화한다. 이후 그 응답은 버려진다 |
| `_restoreEnd(key,t)` | 응답을 적용한 뒤 비행을 닫는다 (FR-RSF-6). 살아 있는 비행일 때만 닫는다 |

**FR-RSF-2** 세 복원은 요청 전에 `_restoreBegin` 을 부르고, 응답을 적용하기 전에
`_restoreLive` 로 자기 비행이 살아 있는지 확인한다. 거짓이면 **아무것도 하지 않고
돌아간다.**

**FR-RSF-3** 응답 적용은 §2.2 의 표를 따른다 — `touched` 에 있는 id 는 **추가도
삭제도 하지 않는다.**

**FR-RSF-4** §2.1 이 전수 조사한 변경 지점 전부가 `_restoreNote` 를 부른다.

**FR-RSF-5** `_attnClearAll` 은 `_restoreVoid('attn')` 을 부른다. 전체 초기화는
만진 id 로 표현되지 않으므로 비행을 통째로 버린다.

**FR-RSF-6** 응답을 적용한 뒤 비행을 닫는다. 비행이 없을 때의 `_restoreNote` 는
무해해야 한다 (FR-RSF-1) — 복원이 돌지 않는 평상시에 비용이 없다.

**FR-RSF-7** `_fgApply(tools,before)` 의 둘째 인자를 `touched` 로 바꾼다.
**인자를 주지 않는 호출의 동작은 바뀌지 않는다** — `_applyRemoteWorkspace` 가
`_fgApply(serverPanes)` 로 부르며 그것은 fetch 경쟁이 아닌 동기 경로다.

**FR-RSF-8** `_activityRestore` 의 `clear()` 후 재구성을 차분으로 바꾼다.

### 3.2 제약 (Constraints)

| # | 제약 |
|---|---|
| C-1 | 서버 API 를 바꾸지 않는다. 도착 시각·seq 를 새로 요구하지 않는다 |
| C-2 | e2e 개수는 신규 6건만큼만 는다. 기존 스펙은 고치지 않는다 |
| C-3 | `_attn`·`_fgNames`·`_activity` 의 **평상시 동작이 바뀌지 않는다** — 비행이 없으면 종전과 같다 |

### 3.3 동작 변경 기록

| | 이전 | 이후 | 이유 |
|---|---|---|---|
| 비행 중 도착한 갱신 | 스냅숏이 덮는다 | **갱신이 이긴다** | 스냅숏은 요청 시점의 진실이고 갱신은 그보다 새롭다 |
| 추월된 복원의 응답 | 적용된다 | **버린다** | 더 새 요청이 곧 더 새 스냅숏을 가져온다 |
| `_activity` 의 Map 순서 | 복원마다 `updatedAt` 순으로 재구성 | 기존 id 는 자리 유지, 신규만 `updatedAt` 순 추가 | 차분이므로. **표시 순서는 `ws.agentsOrder` 가 정하고 `_agentOrderSync` 가 매 렌더마다 돌므로 화면 순서는 바뀌지 않는다** (TC-RSF-7 이 지킨다) |

---

## 4. 검증 (Verification)

| # | 검증 |
|---|---|
| TC-RSF-1 | `_activityRestore` 방향 A — 비행 중 도착한 활동이 남는다 |
| TC-RSF-2 | `_activityRestore` 방향 B — 비행 중 끝난 활동이 되살아나지 않는다 |
| TC-RSF-3 | `_fgRestore` 방향 A — 비행 중 붙은 이름이 남는다 |
| TC-RSF-4 | `_fgRestore` 방향 B — 비행 중 지운 이름이 되살아나지 않는다 |
| TC-RSF-5 | `_attnRestore` 방향 A — 비행 중 올라온 알람이 남는다 |
| TC-RSF-6 | `_attnRestore` 방향 B — 비행 중 **사용자가 거둔** 알람이 되살아나지 않는다 |
| TC-RSF-7 | 기존 `activity.spec.ts` 의 드래그 순서 검사가 복원 뒤에도 통과 (§3.3) |
| TC-RSF-8 | Go 전량 통과 · e2e 전량 통과, 개수는 927+6=933 |

**구현 전(RED) 실측: 4 실패 · 2 통과.**

| TC | RED | 사유 |
|---|---|---|
| TC-RSF-1·2 (활동 A·B) | **실패** | `clear()` 재구성이 두 방향 다 잃는다 |
| TC-RSF-3 (전경 A) | 통과 | 묶음 A 가 고친 자리. **회귀 방지선** |
| TC-RSF-4 (전경 B) | **실패** | `before` 규약이 되살리는 쪽을 막지 않는다 |
| TC-RSF-5 (알람 A) | 통과 | `_attnRestore` 가 규약을 지킨 자리. **회귀 방지선** |
| TC-RSF-6 (알람 B) | **실패** | 사용자가 거둔 알람이 되살아난다 |

§4 를 쓸 때 TC-RSF-5 도 실패할 것으로 적었으나 틀렸다 — `_attnRestore` 는 방향 A
규약의 **원본**이므로 통과하는 것이 옳다.

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| N1 | `_bgRefresh`·`_focusRestore` 에 규약 적용 | `FG_RESTORE_RACE_SRS` §8.2 가 결함 없음을 확정했다. 증분 갱신 경로가 없어 `touched` 가 항상 비고, 규약을 붙이면 죽은 코드가 된다 |
| N2 | 서버가 seq·도착 시각을 주게 하는 것 | C-1. 클라이언트만으로 풀린다 — 무엇이 더 새로운지는 "비행 중에 왔는가" 로 충분하다 |
| N3 | `_agentsStartPoll` 의 폴링 주기 조정 | 폴링은 결함의 노출을 넓혔을 뿐 원인이 아니다. 원인을 고치면 주기는 무관하다 |
| N4 | `_activity` 의 표시 순서 규칙 개선 | `ws.agentsOrder` 가 정하는 현행 규칙을 그대로 둔다. §3.3 은 그것이 바뀌지 않음을 보장할 뿐이다 |

---

## 6. 실행 결과 (Outcome)

### 6.1 무엇이 바뀌었나

| 파일 | 변경 |
|---|---|
| `app-cmd.js` | 비행 규약 다섯 함수 신설 · `_onToolForeground` 기록 · `_fgRestore`/`_fgApply` 가 `touched` 를 쓴다 |
| `app-agents.js` | `_onToolActivity` 기록 · `_activityRestore` 를 `clear()` 재구성에서 **차분**으로 |
| `app-attn.js` | 변경 지점 **넷**이 기록 · `_attnClearAll` 이 무효화 · `_attnRestore` 가 `before` 대신 `touched` |

`before` 는 전부 걷어냈다. `touched` 가 그것을 포함하기 때문이다 (§2.2).

### 6.2 검증

| # | 결과 |
|---|---|
| TC-RSF-1~6 | **6/6 통과** (RED 4실패·2통과 → GREEN 6통과) |
| TC-RSF-7 | `activity.spec.ts` 의 드래그 순서 검사 통과 — 표시 순서가 바뀌지 않았다 |
| TC-RSF-8 | Go 전량 통과 · **e2e 933 전량 통과(실패 0)**. 927+6 으로 개수도 예정대로 |

`_activity` 의 Map 순서가 §3.3 대로 바뀌었는데도 화면 순서가 그대로인 것은
`_agentOrderSync` 가 매 렌더마다 `ws.agentsOrder` 로 순서를 정하기 때문이다.
TC-RSF-7 이 그것을 지킨다.

### 6.3 규약이 이제 어디에 사는가

`_restoreBegin`·`_restoreLive`·`_restoreNote`·`_restoreVoid`·`_restoreEnd` 를
세 파일이 부른다. 다음 복원 함수가 생겼을 때 **규약을 손으로 옮겨 적을 자리가
없다** — §1.2 가 지목한 근본 원인이 사라졌다.

`_fgRestore`·`_attnRestore` 의 주석이 설명하던 `before` 규약도 함께 고쳐 썼다.
걷어낸 기전을 설명하는 주석이 남으면 그것이 다음 사람의 근거가 된다.

### 6.4 남은 것

없다. `FG_RESTORE_RACE_SRS` §8 이 연 항목이 전부 닫혔다 —
`_bgRefresh`·`_focusRestore` 는 §5 N1 대로 결함이 없어 손대지 않았다.
