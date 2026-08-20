# SRS: newSession/newTab 의 keepFocus·name 지원 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
uuid 식별 + keepFocus(split) 완성으로 "원격 pane 컨트롤" 이 가능해졌고, 다음 단계는 **전용 세션을 잡 컨테이너로 쓰는 워크플로우 실행** (dongminal-workflow `session: dedicated`) 이다. 그 선행 조건 두 가지가 빠져 있다:

- **G1 (keepFocus)**: `newSession` 이 무조건 사용자 포커스를 새 세션으로 강탈. `newTab` 도 location 미지정 시 활성 탭을 새 탭으로 전환.
- **G2 (name)**: `newSession` 의 세션 이름이 `'Session'`, `newTab` 의 탭 이름이 `'Shell'` 로 고정 — 원격 생성자가 "poem-critique" 같은 잡 이름을 붙일 수 없음.

본 SRS 는 `newSession` / `newTab` 액션에 `keepFocus` 와 `name` 인자를 추가한다.

### 1.2 범위 (Scope)
- `web/app.js` — `_execRemote` 의 newSession/newTab 처리, `_mkSession(name)`, `addTab(rid, type, opts)` 의 name 지원.
- `internal/mcptool/tools/workspacecmd.go` — `name` 인자 스키마 추가 (keepFocus 는 기존).
- `internal/runtimebin/dmctl.go` — `--name <이름>` 플래그.
- 테스트: e2e (`e2e/layout.spec.ts` 또는 신규), `dmctl_test.go`, `tools_test.go`.
- 문서: `docs/external/commands.md`, dmctl --help, workspace_command description.

### 1.3 정의 (Definitions)
- **원격 생성**: `/api/commands` 또는 MCP `workspace_command` 경유의 newSession/newTab (브라우저 단축키/버튼이 아닌).
- **사용자 포커스**: `ws.activeSession` + `focused` region 쌍 (SPLIT_KEEPFOCUS_FIX_SRS 정의 계승).

### 1.4 참고 (References)
- `SPLIT_KEEPFOCUS_FIX_SRS.md` — keepFocus 시맨틱 = "현재 위치 유지". 본 SRS 는 동일 시맨틱을 newSession/newTab 에 확장.
- `DONGMINAL_WORKFLOW_SKILL_SRS.md` — 본 SRS 의 직접 수요처 (Phase 2 에서 `session: dedicated`).
- `web/app.js:1714` `_mkSession`, `web/app.js:1799` `addTab`, `web/app.js:1560-1588` `_execRemote` 복원 블록.

---

## 2. 현황 (Identified Issues)

### 2.1 RST-1 — newSession 의 포커스 강탈
- **위치**: `web/app.js:1714-1728` `_mkSession` — `this.ws.activeSession=s.id` + `this._setFocus(r, s)` 무조건 실행.
- **경로**: `_execRemote` → `executeAction('newSession')` → `addSession()` → `_mkSession()`. location 없는 액션이라 `_execRemote` 의 saved/복원 블록(`args.location && keepFocus` 조건) 미적용.
- **영향**: 원격 워크플로우가 전용 세션을 만들면 사용자가 강제로 그 세션으로 끌려감.

### 2.2 RST-2 — newTab 의 keepFocus 불완전
- **위치**: `web/app.js:2008` `addTabFocused` — 현재 포커스 region 에 탭 추가 + `rg.activeTab` 전환.
- **현상**: `location` + `keepFocus` 조합은 `_execRemote` 복원 블록이 session/region 포커스는 복원하지만, **대상 region 의 activeTab 이 새 탭으로 바뀐 것은 복원 대상이 아님** (region 안에서 보던 탭이 바뀜). location 미지정 시 복원 자체가 없음.
- **영향**: 사용자가 보던 탭이 백그라운드 작업으로 전환되는 사고.

### 2.3 RST-3 — 이름 지정 불가
- **위치**: `_mkSession` 의 `name:'Session'`, `addTab` terminal 분기의 `name:'Shell'` 하드코딩.
- **영향**: 세션/탭이 잡 이름을 가질 수 없어 사이드바가 잡 대시보드 역할을 못 함. 사람이 N 개의 "Session" 을 구분 불가.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-RST-1** | `newSession` 액션이 `args.name` (string, 선택) 을 받는다. 지정 시 새 세션 이름으로 사용, 미지정·빈 문자열이면 기존 `'Session'`. | 필수 |
| **FR-RST-2** | `newSession` 액션이 `args.keepFocus` (bool, 선택) 를 받는다. true 면 세션 생성 후 `activeSession` / `focused` 가 호출 전 값 그대로 — 새 세션은 사이드바에만 추가. false/미지정이면 기존 동작(새 세션으로 전환). | 필수 |
| **FR-RST-3** | `newTab` 액션이 `args.name` (string, 선택) 을 받는다. 지정 시 새 탭 이름, 미지정이면 `'Shell'`. | 필수 |
| **FR-RST-4** | `newTab` 액션이 `args.keepFocus` (bool, 선택) 를 받는다. true 면: ① location 지정 시 — 대상 region 에 탭만 추가, **그 region 의 activeTab 도 원래 탭 유지**, 사용자 포커스(session/region) 복원. ② location 미지정 시 — 현재 포커스 region 에 탭 추가하되 activeTab 유지. false/미지정이면 기존 동작(새 탭 활성). | 필수 |
| **FR-RST-5** | `web/app.js` 반영: `_execRemote` 에서 newSession/newTab 을 splitH/V 처럼 명시 분기로 처리 — `_mkSession(name, keepFocus)` / `addTab(rid, 'terminal', {name, keepFocus})` 에 인자 전달. keepFocus 시맨틱은 각 함수 내부에서 보장 (SPLIT_KEEPFOCUS_FIX_SRS DC-SKF-1 과 동일 원칙: 의미는 한 곳에). | 필수 |
| **FR-RST-6** | MCP `workspace_command` 스키마/검증: `name` 인자 추가 — newSession/newTab 에서만 의미, 그 외 action 에 지정 시 명시적 에러 (기존 keepFocus 검증 패턴과 동일). `keepFocus` 의 허용 action 목록에 newSession/newTab 추가. | 필수 |
| **FR-RST-7** | dmctl: `dmctl new-session [--name <이름>] [-n]`, `dmctl new-tab [--name <이름>] [-n] [--at <uuid>]`. `--name` 플래그가 `args.name` 으로 전달. 기존 `-n`(keepFocus) 플래그 재사용. | 필수 |
| **FR-RST-8** | 브라우저 단축키/버튼(`addSession()`, `addTabFocused()`) 경로는 인자 없이 호출 — 기존 동작 완전 보존. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-RST-0 | **행위 보존** — name/keepFocus 미지정 호출(기존 모든 경로)의 동작·산출물 무변경. 기존 e2e 무수정 통과. |
| NFR-RST-1 | 세션/탭 이름은 렌더 시 textContent 로 — 기존 렌더 경로 재사용으로 injection 없음 (검증으로 확인). |
| NFR-RST-2 | name 길이 제한 64자 — 초과 시 web 측에서 절단 (사이드바 표시 보호). |

### 3.3 설계 제약 (Design Constraints)

| ID | 제약 |
|----|------|
| DC-RST-1 | keepFocus 의미는 `_mkSession` / `addTab` 내부에서 보장 — `_execRemote` 는 인자 전달만. |
| DC-RST-2 | 새 세션/탭의 uuid 를 응답으로 돌려주는 것은 본 SRS 비범위 — 호출자는 기존 `list_panes` diff 패턴 사용. |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-RST-1** (e2e) | `_execRemote({action:'newSession', args:{name:'wf-test', keepFocus:true}})` — 사용자 포커스 region A 에서 | 사이드바에 'wf-test' 세션 추가, `activeSession`/`.rg.focused` 무변화 |
| **TC-RST-2** (e2e) | `newSession` + name 만 (keepFocus 없음) | 'wf-test' 세션으로 전환 (기존 전환 동작 + 이름만 반영) |
| **TC-RST-3** (e2e) | `newSession` 인자 없음 | 기존과 동일 — 'Session' 이름, 전환 |
| **TC-RST-4** (e2e) | `newTab` + `location=<다른 region uuid>` + `keepFocus=true` + `name='worker'` | 대상 region 에 'worker' 탭 추가, 대상 region 의 activeTab 원래 탭 유지, 사용자 포커스 무변화 |
| **TC-RST-5** (e2e) | `newTab` location 미지정 + `keepFocus=true` | 현재 region 에 탭 추가, activeTab 유지 |
| **TC-RST-6** (e2e) | `newTab` 인자 없음 | 기존과 동일 — 'Shell', 새 탭 활성 |
| **TC-RST-7** (Go) | MCP `workspace_command(action=focus, name='x')` | 에러 — "name 은 newSession/newTab 에서만" |
| **TC-RST-8** (Go) | dmctl `new-session --name wf -n` → POST body | `{action:'newSession', args:{name:'wf', keepFocus:true}}` |
| **TC-RST-9** (Go) | dmctl `new-tab --name worker --at <uuid> -n` | args 에 name/location/keepFocus 모두 |
| **TC-RST-10** (e2e) | name 65자 이상 | 64자 절단 |

### 4.2 완료 조건 (DoD)

- [ ] web/app.js 수정 (FR-RST-1~5, NFR-RST-2).
- [ ] workspacecmd.go 스키마·검증 + dmctl 플래그.
- [ ] TC-RST-1~10 구현·통과. 기존 e2e 97 + Go 테스트 무수정 통과.
- [ ] `docs/external/commands.md` + dmctl --help + workspace_command description 갱신.
- [ ] 라이브: 운영 데몬에서 `dmctl new-session --name demo -n` → ▶ 무이동 + 사이드바 'demo' 확인.

---

## 5. 비목표 (Non-goals)

- 세션/탭 rename 액션 (생성 후 이름 변경) — 후속.
- 새 세션/탭 uuid 의 동기 응답 반환 — list_panes diff 로 충분 (DC-RST-2).
- dongminal-workflow 의 `session: dedicated` 구현 — Phase 2 별도.
- 세션 정렬/그룹핑 UI.

---

## 6. 의존 / 후속

- 의존: `SPLIT_KEEPFOCUS_FIX_SRS` (keepFocus 시맨틱 정의).
- 후속: dongminal-workflow `session: dedicated` (Phase 2), `HIERARCHICAL_TEAM_SRS`.
