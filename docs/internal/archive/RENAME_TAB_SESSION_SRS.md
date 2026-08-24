# SRS: renameTab / renameSession 원격 액션 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`REMOTE_SESSION_TAB_CREATE_SRS` 비목표로 미뤘던 rename 을 구현한다. dongminal-workflow 라이브 검증(TC-WFS-B)에서 실수요 확인: split 으로 생성된 팀원 pane 은 이름 지정이 불가능해 전부 "Shell" — 역할명(writer/lead/critic)을 붙일 수 없어 관전성이 떨어진다.

원격 rename 두 가지를 추가한다:
- **renameTab**: 지정 pane(tab) 의 표시 이름 변경.
- **renameSession**: 지정 pane 이 **속한 세션**의 이름 변경.

### 1.2 범위 (Scope)
- `web/app.js` — `_execRemote` 에 renameTab/renameSession 분기.
- `internal/server/commands.go` — `allowedCmdActions` 에 두 액션 추가.
- `internal/mcptool/tools/workspacecmd.go` — enum·검증·설명.
- `internal/runtimebin/dmctl.go` — `rename-tab` / `rename-session` 명령.
- 테스트: e2e, `tools_test.go`, `dmctl_test.go`. 문서: commands.md, --help.

### 1.3 정의 (Definitions)
- **대상 식별**: `location` = tab uuid (기존 uuid-only 게이트 그대로). renameSession 은 "그 탭이 속한 세션"이 대상 — 별도 세션 식별자 도입하지 않음.

### 1.4 참고 (References)
- `REMOTE_SESSION_TAB_CREATE_SRS.md` — name 64자 절단(NFR-RST-2), location uuid-only.
- `web/app.js` `_rename` (UI 더블클릭 rename — 동일 데이터 변경의 기존 선례).
- `DONGMINAL_WORKFLOW_SKILL_SRS.md` — 수요처 (부팅 직후 역할명 부여).

---

## 2. 현황 (Identified Issues)

- **RNS-1**: rename 은 브라우저 더블클릭 UI 만 존재. 원격(workspace_command/dmctl) 불가.
- **RNS-2**: splitH/V 로 생성된 pane 은 생성 시점 이름 지정도 불가 (name 인자는 newTab/newSession 만). 사후 rename 이 유일한 해법.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-RNS-1** | `renameTab` 액션: `location` (tab uuid, 필수) + `name` (필수, 64자 절단). 대상 탭의 표시 이름을 변경한다. 포커스·activeTab·activeSession 무영향 (순수 데이터 변경 + render). | 필수 |
| **FR-RNS-2** | `renameSession` 액션: `location` (tab uuid, 필수) + `name` (필수, 64자 절단). 해당 탭이 속한 **세션**의 이름을 변경한다. 포커스 무영향. | 필수 |
| **FR-RNS-3** | 검증 (MCP + 서버): 두 액션 모두 `location` 누락 시 에러, `name` 누락(빈 문자열) 시 에러. location 은 기존 uuid-only 게이트 (IsKnownTabID) 적용. | 필수 |
| **FR-RNS-4** | `web/app.js` `_execRemote` 분기: `_resolveLocation(location)` 으로 tab/session 을 찾아 이름 변경 후 `_save()` + `render()`. 대상 미발견 시 console.warn + 무동작. 비활성 세션 대상도 지원 (`_resolveLocation` 은 전 세션 탐색). | 필수 |
| **FR-RNS-5** | dmctl: `dmctl rename-tab --at <uuid> <name>` / `dmctl rename-session --at <uuid> <name>`. positional 이 name (공백 포함 시 따옴표). `--name` 플래그도 동등 지원. name 과 location 둘 다 필수 — 누락 시 usage + rc=2. | 필수 |
| **FR-RNS-6** | keepFocus 인자는 두 액션에서 무의미 — 지정 시 에러 (rename 은 본질적으로 포커스 무영향). | 필수 |

### 3.2 비기능 요구사항 (Non-functional)

| ID | 요구사항 |
|----|----------|
| NFR-RNS-0 | **행위 보존** — 기존 액션·UI rename 경로 무변경. |
| NFR-RNS-1 | name 64자 절단은 web 측에서 (NFR-RST-2 와 동일 위치·정책). |

---

## 4. 검증 (Verification)

| TC | 시나리오 | 기대 |
|----|----------|------|
| **TC-RNS-1** (e2e) | 비포커스 region 의 탭을 `_execRemote('renameTab', {location:<좌표>, name:'writer'})` | 해당 탭 이름 'writer', 포커스/activeTab/activeSession 무변화 |
| **TC-RNS-2** (e2e) | 비활성 세션의 탭으로 `renameSession` | 그 세션 이름 변경, activeSession 무변화 |
| **TC-RNS-3** (e2e) | name 65자 | 64자 절단 |
| **TC-RNS-4** (Go) | MCP `renameTab` location 누락 / name 누락 | 각각 에러 |
| **TC-RNS-5** (Go) | MCP `renameTab` + keepFocus | 에러 |
| **TC-RNS-6** (Go) | dmctl `rename-tab --at <uuid> writer` | POST body `{action:renameTab, args:{location, name:'writer'}}` |
| **TC-RNS-7** (Go) | dmctl `rename-session --at <uuid> --name "poem run 2"` | name 플래그 경로 동등 |
| **TC-RNS-8** (Go) | dmctl rename-tab 인자 누락 (name 또는 --at) | usage + rc=2 |
| **TC-RNS-9** (라이브) | 운영 데몬에서 rename-tab 후 list_panes 의 tab=, 사이드바 표시 확인 + ▶ 무이동 | 통과 |

### DoD
- [ ] 서버 whitelist + MCP enum·검증 + dmctl 명령 + web 분기.
- [ ] TC-RNS-1~8 통과, 기존 전체 회귀 (go test -race, playwright) 그린.
- [ ] commands.md / dmctl --help / workspace_command description 갱신.
- [ ] dongminal-workflow SKILL.md 부팅 단계에 "renameTab 으로 역할명 부여" 추가.

---

## 5. 비목표 (Non-goals)

- region 이름 (region 은 표시 이름 자체가 없음).
- 이름 중복 검사 — 자유 텍스트.
- rename 의 undo.

## 6. 의존 / 후속
- 의존: `REMOTE_SESSION_TAB_CREATE_SRS` (name 정책), `DMCTL_UUID_FINALIZE_SRS` (location 게이트).
- 후속: dongminal-workflow 스킬 본문 반영 (본 SRS DoD 에 포함).
