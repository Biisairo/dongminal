# SRS: list_panes / list-panes 이름 필터 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
세션·탭에 이름을 붙일 수 있게 되면서(REMOTE_SESSION_TAB_CREATE, RENAME_TAB_SESSION) "이름으로 pane 찾기" 수요가 생겼다. 현재는 `list_panes` 전체 출력을 받아 호출자가 직접 훑어야 한다 — 운영 워크스페이스에서 60행 이상. 워크플로우 시드 식별(`session="poem-critique"` 행 찾기)도 전체 스캔.

`list_panes`(MCP) / `list-panes`(dmctl) 에 **이름 필터**를 추가한다. 찾기는 이름으로, 행동은 결과의 uuid 로 — location 인자의 uuid-only 정책(D4)은 불변.

### 1.2 범위 (Scope)
- `internal/runtimebin/dmctl_listpanes.go` — `--session <substr>` / `--tab <substr>` 플래그.
- `internal/mcptool/tools/listpanes.go` — `session` / `tab` 인자.
- 테스트·문서 갱신.

### 1.3 정의 (Definitions)
- **매칭**: 부분 일치(substring) + 대소문자 무시. 필터 둘 다 지정 시 AND.
- **0건**: dmctl 은 grep 컨벤션 — stderr "(no match)" + rc=1 (`--json` 은 stdout "[]" + rc=1). MCP 는 "(매칭 없음)" 텍스트 (도구 에러 아님).

### 1.4 참고
- `RENAME_TAB_SESSION_SRS.md`, `REMOTE_SESSION_TAB_CREATE_SRS.md` — 이름 부여 경로.
- `DMCTL_UUID_FINALIZE_SRS.md` D4 — location uuid-only 정책 (본 SRS 와 무관하게 유지).

---

## 2. 현황

- **LPF-1**: 이름 검색 수단 부재 — 전체 출력 후 호출자 스캔. MCP 호출 시 pane 이 많으면 토큰 낭비.

---

## 3. 요구사항

| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| **FR-LPF-1** | dmctl `list-panes --session <substr>`: workspace 등록 행 중 session 이름에 substr 이 (case-insensitive substring) 포함된 행만 출력. `--tab <substr>` 동일하게 tab 이름. 둘 다 지정 시 AND. | 필수 |
| **FR-LPF-2** | 필터 지정 + 매칭 0건: 텍스트 모드 stderr `(no match)` + rc=1, `--json` 모드 stdout `[]` + rc=1. 필터 미지정 빈 워크스페이스는 기존 동작 유지 (`(no panes)` rc=0). | 필수 |
| **FR-LPF-3** | 필터 지정 시 `[workspace 미등록]`/orphan 행은 출력하지 않는다 (이름 매칭 대상이 아님). dmctl 은 원래 orphan 미출력 — MCP 만 해당. | 필수 |
| **FR-LPF-4** | MCP `list_panes` 에 `session`/`tab` string 인자 (선택). 의미 동일. 0건이면 본문 `(매칭 없음: ...)` — 도구 에러 아님. | 필수 |
| **FR-LPF-5** | 필터는 표시 이름(session=/tab= 값) 대상. uuid/short/paneId 매칭은 하지 않는다 (그건 이미 정확 식별자로 존재). | 필수 |
| NFR-LPF-0 | 필터 미지정 호출의 출력·rc 완전 보존. | — |

---

## 4. 검증

| TC | 시나리오 | 기대 |
|----|----------|------|
| TC-LPF-1 (Go) | dmctl `--session poem` (행 2/3 매칭) | 매칭 행만, rc=0 |
| TC-LPF-2 (Go) | dmctl `--session POEM` | 대소문자 무시 매칭 |
| TC-LPF-3 (Go) | dmctl `--session nomatch` | stderr "(no match)", rc=1 |
| TC-LPF-4 (Go) | dmctl `--session nomatch --json` | stdout "[]", rc=1 |
| TC-LPF-5 (Go) | dmctl `--session x --tab y` AND | 둘 다 만족하는 행만 |
| TC-LPF-6 (Go) | MCP `list_panes(session="poem")` | 매칭 행만 + orphan 섹션 생략 |
| TC-LPF-7 (Go) | MCP 0건 | "(매칭 없음" 포함, 에러 아님 |
| TC-LPF-8 (Go) | 필터 미지정 | 기존 출력 그대로 (기존 테스트 무수정 통과로 갈음) |

DoD: 위 TC + `go test -race ./...` 그린 + commands.md/--help/description 갱신. (web 무변경 — playwright 회귀 불필요하나 커밋 전 일괄 실행은 유지)

## 5. 비목표
- location 인자의 이름 허용 (D4 유지).
- 정규식/글롭 매칭.
- 이름 기반 행동 명령 (`dmctl focus --session ...` 류).

## 6. 의존 / 후속
- 의존: RENAME_TAB_SESSION_SRS.
- 후속: dongminal-workflow 스킬의 시드 식별을 필터 호출로 단순화 (본 작업에 포함).
