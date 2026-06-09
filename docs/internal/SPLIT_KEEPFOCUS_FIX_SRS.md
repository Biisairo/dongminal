# SRS: splitH/V 의 keepFocus 시맨틱 정정 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`workspace_command` / `dmctl --no-focus` 로 보낸 `splitH` / `splitV` + `keepFocus=true` + `location=<uuid>` 조합이 **사용자 포커스를 split 대상 region 으로 강제 이동**시키는 버그를 수정한다.

`dongminal-team` 스킬과 `dmctl who-am-i` 라이브 검증 중 발견된 사례:

```
사용자 포커스: region A (이전 작업 중)
명령: dmctl split-h --at <uuid-of-region-B> -n
기대: 사용자 포커스 A 유지 (keepFocus 의미)
실제: 사용자 포커스 B 로 이동
```

`closeTab` / `focus` 외 액션의 `keepFocus` 는 `_execRemote` 의 `savedSession`/`savedFocused` 복원으로 의도대로 동작한다. **splitH/V 만 별도 분기로 빠져 그 복원을 거치지 않는** 게 원인.

### 1.2 범위 (Scope)
- 수정: `web/app.js` 의 `_splitInner(dir, opts)` — `keepFocus=true` 일 때 사용자 원래 `activeSession` + `focused` 복원.
- 신규 테스트: `e2e/layout.spec.ts` — "다른 region 에 포커스 중인 사용자에게 keepFocus 가 진짜 무영향" 시나리오.
- 비범위: `_execRemote` 의 일반 액션 keepFocus 경로 (이미 정상). `split()` 의 keepFocus 미설정 호출자(키보드/버튼) 경로.

### 1.3 정의 (Definitions)
- **사용자 포커스**: 호출 직전 `app.ws.activeSession` + `app.focused` 두 값의 쌍.
- **split 대상 region**: `opts.targetRegion` 또는 (없으면) `app.focused`.
- **새 region**: `_splitInner` 가 `doSplit` 으로 layout 에 추가하는 `count-1` 개의 region (예: count=2 → 1개 신규).

### 1.4 참고 (References)
- `MD_VIEWER_REGRESSION_FIX_SRS.md` — `this.focused` 와 `s.focusedRegion` 동기화 보장(FR-4).
- `docs/test-checklist.md:C13.6` — keepFocus split 의 기존 동작 명세.
- `skills/dongminal-team/references/layout.md` — `location + keepFocus=true` 조합은 사용자 포커스를 건드리지 않는다는 명시적 보장.

---

## 2. 현황 (Identified Issues)

### 2.1 SKF-1 — splitH/V 가 keepFocus 의미를 절반만 구현
- **위치**: `web/app.js:1547-1559` (`_execRemote` 의 splitH/V 분기) + `web/app.js:1890-1930` (`_splitInner`).
- **현상**: `_execRemote` 가 splitH/V 일 때는 `savedSession`/`savedFocused` 복원 블록(line 1570-1588)을 거치지 않고 곧장 `this.split(dir, opts)` 호출. `_splitInner` 안의 `keepFocus` 처리는:
  ```js
  if(this.ws.activeSession!==tgtSessionId){
    const cur=this._as(); if(cur) cur.focusedRegion=this.focused;
    this.ws.activeSession=tgtSessionId;            // ← keepFocus 무관하게 세션 강제 전환
  }
  const next=(!keepFocus && lastR) ? lastR : tgtRegionId;
  this._setFocus(next, s);                          // ← keepFocus=true 라도 tgtRegionId 로 포커스 이동
  ```
  즉 `keepFocus=true` 의 효과는 "새 region 으로 가지 않음" 까지만. **target region 자체로는 강제 이동**.
- **영향**: 사용자가 region A 에서 작업 중일 때 dmctl/MCP 가 region B 를 split 하면 포커스가 B 로 점프. `dongminal-team` 스킬이 명시한 "사용자 포커스 무영향" 보장 위반. dmctl 의 `--no-focus` 가 약속하는 동작과 불일치.

### 2.2 SKF-2 — 기존 e2e 가 시나리오 미커버
- **위치**: `e2e/layout.spec.ts:167` (`keepFocus split preserves original region focus`).
- **현상**: 테스트가 `app.split('horizontal', { keepFocus: true })` 만 호출 — `targetRegion` 미지정이라 `tgtRegionId === this.focused`. 현재 버그는 **사용자 region ≠ targetRegion** 일 때만 드러나는데 그 경로가 검증되지 않음.
- **영향**: 회귀가 e2e 에 잡히지 않는다.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-SKF-1** | `_splitInner(dir, opts)` 가 `opts.keepFocus === true` 일 때, 호출 직전의 `this.ws.activeSession` 과 `this.focused` 를 저장하고, `doSplit` 후 두 값을 그대로 복원해야 한다. 새 region 은 layout 에 추가되지만 사용자 포커스는 호출 전 상태와 byte-level 동일. | 필수 |
| **FR-SKF-2** | `opts.keepFocus === false` (또는 미지정) 일 때의 동작은 **무변경** — 마지막 새 region (`lastR`) 으로 포커스 이동, target session 으로 활성 세션 전환, FR-4 (this.focused === s.focusedRegion) 보장. | 필수 |
| **FR-SKF-3** | 복원 시 저장된 `savedFocused` 가 사후 layout 에서 더 이상 존재하지 않으면(외부 SSE 가 그 사이 region 을 닫은 경우), 무동작으로 graceful fallback — 강제 이동 금지, 콘솔 경고 1회. | 필수 |
| **FR-SKF-4** | `_execRemote` 의 splitH/V 분기는 변경하지 않는다 — keepFocus 의미는 `_splitInner` 한 곳에서 보장. opts.location 만 `_resolveLocation` 으로 target 으로 전달. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-SKF-0 | **행위 보존** — 키보드 단축키 / UI 버튼 / `app.split(dir)` (opts 미전달) 경로는 무변경. `keepFocus` opt 가 명시되지 않은 모든 호출자에 영향 없음. |
| NFR-SKF-1 | 복원은 동기 — `doSplit` 직후 즉시 처리. 추가 await/setTimeout 없음. |
| NFR-SKF-2 | render() / `_save()` 호출 횟수 유지 — `_splitInner` 끝에서 각 1회. |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-SKF-1 | 의미 정의는 `_splitInner` 한 곳에만 둔다 — wrapper 와 호출자가 keepFocus 의미를 따로 해석하지 않게. |
| DC-SKF-2 | `findRg` 헬퍼 사용 — 이미 동일 파일에 존재. 새 헬퍼 도입 금지. |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-SKF-1** (신규 e2e) | 사용자가 region A 에 포커스 중일 때 `app.split('horizontal', {keepFocus:true, targetSession:S, targetRegion:B})` 로 region B 분할 (A ≠ B) | 새 region 추가됨, 그러나 `.rg.focused` 가 여전히 region A. `app.ws.activeSession` 도 호출 전 값. |
| **TC-SKF-2** (기존 e2e 통과) | `keepFocus split preserves original region focus` (`e2e/layout.spec.ts:167`) | 그대로 통과 (target == focused 인 케이스). |
| **TC-SKF-3** (기존 e2e 통과) | `e2e/regression-md.spec.ts:178` 의 `FR-5: split with keepFocus keeps s.focusedRegion` | 그대로 통과 (MD_VIEWER FR-4 무회귀). |
| **TC-SKF-4** (기존 e2e 통과) | 비-keepFocus split 회귀 — 다른 e2e 가 검증하는 "split 후 새 region 으로 포커스 이동" | 그대로 통과. |
| **TC-SKF-5** (라이브) | `dmctl split-h --at <uuid-of-other-region> -n` → 사용자 ▶ 마커 미이동 | 라이브 확인. |

### 4.2 완료 조건 (DoD)

- [ ] `_splitInner` 수정 — FR-SKF-1~3.
- [ ] `e2e/layout.spec.ts` 에 TC-SKF-1 추가.
- [ ] `npx playwright test e2e/layout.spec.ts` green (TC-SKF-1 + 기존 모두).
- [ ] `npx playwright test` 전체 green (96 + 1 = 97).
- [ ] `go test -race -count=1 ./...` green (Go 측은 영향 없음 — 회귀 확인용).
- [ ] 라이브 검증: 운영 데몬에서 `dmctl split-h --at <other-uuid> -n` 후 ▶ 미이동 확인.

---

## 5. 비목표 (Non-goals)

- `_execRemote` 의 일반 액션 keepFocus 경로 (이미 정상).
- 새 keepFocus opt 변형 (strictKeepFocus 등) — 현 시맨틱이 "현재 위치 유지" 단일 의미로 충분.
- 키보드 / 버튼 split 의 keepFocus 옵션 노출 — 사용자가 직접 split 할 때는 새 region 으로 이동이 자연스러움.
- `MD_VIEWER_REGRESSION_FIX_SRS` 의 FR-4 (`this.focused === s.focusedRegion`) 와 본 SRS 의 상호작용 — 본 SRS 는 keepFocus=true 경로에서 두 값 모두 호출 전 값으로 복원하므로 FR-4 자동 만족.

---

## 6. 의존 / 후속

- 의존: `MD_VIEWER_REGRESSION_FIX_SRS` (focused 동기화 보장 전제).
- 후속: 없음 (현 시맨틱 명확화로 종결).
