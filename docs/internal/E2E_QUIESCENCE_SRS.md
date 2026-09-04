# SRS: e2e 가 저장의 정착을 기다린다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

전체 e2e 를 돌려 22 개가 무너졌다. 그중 **열하나는 제품이 아니라 검증이 틀린
것**이었다 — 검증이 **화면의 저장이 서버에 닿기 전에** 서버를 읽거나 새로고침한다.

```
POST /api/commands newWindow  → 응답: 창 uuid
GET  /api/workspace           → 그 창이 없다        ← 여기서 실패
(1.5 초 뒤)
GET  /api/workspace           → 그 창이 있다
```

명령은 **브라우저가 만든다.** 서버는 창을 만들지 않고 브라우저에게 시킬 뿐이며,
그것이 워크스페이스에 남는 길은 브라우저의 `PUT /api/workspace` 하나뿐이다
(`app.js` `_save()`). 응답이 돌아왔다는 것은 **브라우저가 만들었다**는 뜻이지
**서버에 남았다**는 뜻이 아니다.

같은 틈이 새로고침에도 있다. 창을 만들고 곧바로 `page.reload()` 하면 저장이 나가기
전에 화면이 버려지고, 복원은 없던 창을 복원할 수 없다.

### 1.2 범위 (Scope)

**포함**

| 묶음 | 내용 |
|---|---|
| **Q** 정착 | 화면의 저장·적용이 멎을 때까지 기다리는 헬퍼를 e2e 에 둔다 |
| **W** 진입 | `waitForInit` 이 그 정착까지 기다린다 — 초기 저장이 도는 중에 검증이 시작되지 않는다 |
| **U** 사용처 | 서버를 읽기 전 · 새로고침 전 · SSE 상태를 조작하기 전에 그것을 부른다 |

**미포함:** §5 비목표. 특히 **제품 코드는 이 SRS 로 바뀌지 않는다.**

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **정착 (quiescent)** | 화면에 진행 중인 저장도, 대기 중인 저장도, 진행 중인 원격 적용도 없는 상태 |
| **비행 (inflight)** | `app._saveInflight` — PUT 이 도는 중 |
| **대기 (pending)** | `app._savePending` — 다음 바퀴에 나갈 저장이 예약돼 있음 |
| **적용 (apply)** | `app._wsApplyInflight` — `/api/state` 를 읽어 원격을 화면에 적용하는 중 |

### 1.4 참조 (References)

- [`./E2E_HELPER_RECLAIM_SRS.md`](./E2E_HELPER_RECLAIM_SRS.md) — FR-EHR-1·2·5.
  스펙마다 베껴 쓰던 헬퍼를 `e2e/fixtures.ts` 한 자리로 거두는 규약
- [`./WORKSPACE_SAVE_CONFLICT_SRS.md`](./WORKSPACE_SAVE_CONFLICT_SRS.md) — 저장이
  언제 나가고 언제 미뤄지는가
- [`./RELOAD_CONTINUITY_SRS.md`](./RELOAD_CONTINUITY_SRS.md) — FR-RLC-25. 침묵을
  재는 감시와 그 상한

### 1.5 착수 전 확정된 결정

| # | 물음 | 답 |
|---|---|---|
| **I-1** | 시간으로 기다릴 것인가 상태로 기다릴 것인가 | **상태.** `waitForTimeout` 은 빠른 기계에서 낭비이고 느린 기계에서 부족하다 |
| **I-2** | 제품이 더 빨리 저장하게 고칠 것인가 | **아니다.** 저장은 이미 곧바로 나간다. 틀린 것은 "응답 = 영속" 이라고 읽은 검증이다 |

---

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 `waitForInit` 은 터미널만 기다린다

`e2e/fixtures.ts`:

```ts
await page.goto('/');
await page.waitForSelector('#area .pn.focused .xterm-helper-textarea', {timeout:15000});
```

터미널이 섰을 때 화면은 아직 **초기 저장 두 번을 돌고 있다.** 계측:

```
waitForInit 반환 직후: {inflight:true, pending:true, etag:"1"}
+250ms                : {inflight:false, pending:false, etag:"3"}
```

`_onWorkspaceChanged` 는 비행 중이면 **적용하지 않는다** (그 자리의 가드). 그래서
`waitForInit` 바로 뒤에 그것을 부르는 검증은 아무것도 재지 못한다.

### 2.2 명령의 응답은 영속을 뜻하지 않는다

`POST /api/commands` 는 브라우저에 시키고 그 결과 uuid 를 준다. 워크스페이스에
남는 것은 뒤따르는 `PUT /api/workspace` 다. 계측:

```
LOCAL   wins  [w0, w1, w2]
SERVER  즉시  [w0, …, w1]        ← w2 없음
SERVER  1.5s  [w0, …, w1, w2]
```

### 2.3 SSE 상태 조작도 같은 틈에 걸린다

`version-autoreload` 의 `fakeSilence` 는 `app._sseSeen` 을 과거로 민다. 초기
트래픽이 아직 흐르는 동안 부르면 **곧바로 덮인다** — 어떤 수신이든 `_sseSeen` 을
현재로 되돌리기 때문이다 (FR-RLC-28: 모든 수신이 생존의 증거다). 계측:

```
fakeSilence(120000) 직후 1 초: silentMs = 811   ← 120000 이 아니다
```

### 2.4 무너진 열하나

| 스펙 | 검증 | 어느 틈인가 |
|---|---|---|
| `tool-list-unknown` | TC-TLU-11 · TC-TLU-7 · TC-TLU-11b | §2.1 |
| `workspace-identity` | TC-UNI-14 · TC-UNI-16 | §2.2 |
| `skill-contract` | 전용 창 Run | §2.2 |
| `window-slots` | TC-WSL-4 | §2.2 (새로고침) |
| `reload-continuity` | TC-RLC-6 · TC-RLC-7 | §2.2 (새로고침) |
| `slot-view-state` | TC-SVS-2 | §2.2 (새로고침) |
| `version-autoreload` | TC-RLC-25 | §2.3 |

이들은 **개발 기계의 속도에 매달려 있었다.** 저장이 먼저 닿는 기계에서는 초록이고,
검증이 먼저 읽는 기계에서는 빨강이다. 어느 쪽도 제품을 재고 있지 않다.

---

## 3. 기능 요구사항 (Functional Requirements)

### 3.1 묶음 Q — 정착 (FR-EQS-1~4)

- **FR-EQS-1** `e2e/fixtures.ts` 가 **정착을 기다리는 헬퍼 하나**를 내보낸다
  (`waitSettled`). 스펙마다 베껴 쓰지 않는다 (FR-EHR-1·2 와 같은 규약).
- **FR-EQS-2** 정착의 판정은 **화면의 상태**다 — 비행도 대기도 적용도 없을 것.
  시간으로 재지 않는다 (I-1).
- **FR-EQS-3** 한 번 조용한 것으로는 부족하다. `_save()` 는 비행이 끝난 **다음
  틱**에 다음 비행을 세울 수 있으므로(FR-WSC-9), **연속으로** 조용해야 정착이다.
- **FR-EQS-4** 상한을 둔다. 넘으면 실패로 알린다 — 조용히 계속 기다리면 그 검증은
  타임아웃의 이유를 말하지 못한다.

### 3.2 묶음 W — 진입 (FR-EQS-5)

- **FR-EQS-5** `waitForInit` 은 터미널이 선 뒤 **정착까지** 기다린다 (§2.1). 이것이
  기본값인 이유는, 정착 전에 시작해서 얻는 것이 아무것도 없기 때문이다.
- **FR-EQS-5b** 그러려면 진입이 **한 자리**여야 한다. `waitForInit` 과 **바이트
  동일한** 로컬 사본을 아직 갖고 있던 다섯(`tool-list-unknown`·`window-slots`·
  `reload-continuity`·`version-autoreload`·`skill-contract`)을 `fixtures` 로 거둔다
  (E2E_HELPER_RECLAIM_SRS FR-EHR-1·2 와 같은 판정: 실행되는 문장이 한 글자도 다르지
  않은 것만). **변종은 여전히 손대지 않는다.**

### 3.3 묶음 U — 사용처 (FR-EQS-6~8)

- **FR-EQS-6** 브라우저가 만든 것을 **서버에서 읽기 전에** 정착을 기다린다 (§2.2).
- **FR-EQS-7** 화면이 만든 것을 **새로고침으로 확인하기 전에** 정착을 기다린다.
- **FR-EQS-8** SSE 의 내부 상태를 조작하는 검증은 조작 **직전에** 정착을 기다린다
  (§2.3).

---

## 4. 검증 (Verification)

| ID | 검증 | 수단 |
|---|---|---|
| **V-EQS-1** | §2.4 의 열하나가 초록이다 | e2e |
| **V-EQS-2** | 그 열하나가 **반복 실행에도** 초록이다 — 경합이 남아 있으면 여기서 드러난다 | e2e (`--repeat-each`) |
| **V-EQS-3** | 헬퍼가 한 자리에만 있다 (FR-EQS-1) | `grep` |
| **V-EQS-4** | 나머지 1027 개가 그대로 초록이다 — 진입을 늦춘 것이 다른 검증을 흔들지 않았다 | e2e (전체) |

---

## 5. 비목표 (Non-goals)

1. **제품 코드 변경.** 이 SRS 가 다루는 열하나는 제품이 옳고 검증이 틀린 자리다.
   같은 실행에서 함께 무너진 제품 결함은 `WORKSPACE_SAVE_CONFLICT_SRS` 가 맡는다.
2. `waitForTimeout` 으로 재는 것 (I-1).
3. 저장을 동기화하는 새 API 를 서버에 두기 — 검증만을 위한 종단은 제품에 없는 길을
   만들고, 그 길이 재는 것은 사용자가 걷는 길이 아니다.
4. `waitForInit` 의 변종 26 개를 합치기 — E2E_HELPER_RECLAIM_SRS 가 그것을 옮기지
   않은 이유를 적고 있다.
