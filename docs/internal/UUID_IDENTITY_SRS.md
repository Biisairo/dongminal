# SRS: UUID 기반 엔티티 정체성 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
dongminal 의 session/region/tab/pane 식별 체계를 **위치 좌표 (positional coordinate)** 와 **불변 정체성 (immutable identity)** 으로 분리한다. 현재 외부 노출 식별자인 `S{si+1}.P{pi+1}.T{ti+1}` 라벨은 workspace.json 의 배열 위치로부터 매번 계산되는 derived view 이므로, 사용자/스킬/에이전트가 세션·영역·탭을 닫거나 재배치하는 순간 동일 라벨이 다른 엔티티를 가리킨다. 본 변경은 모든 엔티티에 생성 시점에 UUID v7 을 부여하고, MCP API·엔벨로프·스킬·로그 전 채널에서 UUID 를 primary key 로 사용하도록 정정한다.

### 1.2 범위 (Scope)
- **데이터 모델**: `internal/workspace/manager.go` 의 `wsSession`/`wsLayout`/`wsTab` 스키마와 인덱스 빌더 (`buildIndex`).
- **MCP tool API**: `internal/mcptool/` 7개 tool (`who_am_i`, `list_panes`, `workspace_command`, `send_input`, `send_agent_message`, `read_pane_screen`, `read_pane_output`) 의 입출력 스키마.
- **엔벨로프 프로토콜**: `[DONGMINAL-AGENT-MSG ...]` 의 라우팅 키.
- **브라우저 UI**: SSE 메시지, 내부 상태 키, focus/drag/close 처리.
- **dongminal-team 스킬**: `~/.claude/skills/dongminal-team/SKILL.md`, `references/*.md`, `scripts/plan_layout.py`, `scripts/build_prompt.py`, `evals/test-scenarios.md`.
- **로그**: `/tmp/dongminal.log` 포맷.

### 1.3 정의 (Definitions)
- **Identity (UUID)** — 엔티티 생성 시 부여되는 불변 식별자. 엔티티 destroy 시까지 유지되며 재사용되지 않는다.
- **Coordinate (label)** — `S{n}.P{n}.T{n}` 형식의 현재 레이아웃에 대한 derived view. 위치 변경 시 매핑이 변한다.
- **Alias** — 라벨처럼 사람이 자연어로 가리키기 위해 일시적으로 사용하는 표현.
- **Short-code** — UUID 의 prefix 8자 hex. 로그·디버그 가독성 보조.
- **paneId** — 현재 코드의 `wsTab.PaneID` (PTY 프로세스 식별자). 본 SRS 에서 제거 대상.
- **UUID v7** — RFC 9562 정의. 상위 48비트가 Unix millisecond 시간, 나머지는 무작위. 시간순 정렬 가능.

### 1.4 참고 (References)
- IEEE 29148:2018 — Systems and software engineering — Life cycle processes — Requirements engineering.
- RFC 9562 — Universally Unique IDentifiers (UUIDs), UUID v7 정의.
- `WORKSPACE_SNAPSHOT_SRS.md` — workspace.Manager 의 (raw, rev) 일관성 정책 (호환 대상).

### 1.5 개요 (Overview)
2장에서 현황 문제를, 3장에서 기능·비기능 요구사항을, 4장에서 검증 기준을, 5장에서 비목표 및 마이그레이션 단계를 정의한다.

---

## 2. 현황 (Identified Issue)

### 2.1 위치 좌표의 정체성 오용
- **위치**: `internal/workspace/manager.go:316` (`fmt.Sprintf("S%d.P%d.T%d", si+1, pi+1, ti+1)`).
- **현상**: 라벨은 sessions/regions/tabs 배열의 1-base 인덱스로부터 매 빌드 시 재계산된다. 세션 하나가 닫히면 후속 세션 라벨이 한 칸씩 당겨진다 (S3→S2). MCP 클라이언트·스킬·에이전트가 라벨을 보관해 두고 나중에 호출하면 stale reference 가 된다.
- **영향**:
  - 계층형 팀 (sub-leader 가 자기 팀을 별도 세션에 보유) 구조에서 sub-leader 가 보관한 워커 라벨이 동기화 없이 invalidate.
  - 두 sub-leader 가 동시에 새 세션을 생성할 때 누가 S2/S3 가 될지 race 발생.
  - 정리 단계에서 closeTab 호출 직전 `list_panes` 재확인을 강제하는 우회 (스킬 SKILL.md §8) — 본질적 해결책 아님.

### 2.2 내부 ID 의 외부 미노출
- **위치**: `wsSession.ID`, `wsLayout.ID`, `wsTab.ID`, `wsTab.PaneID` 모두 workspace.json 에 이미 존재하지만 MCP API 의 입출력 스키마에는 라벨/paneId 만 surface 됨.
- **현상**: 데이터 모델에는 정체성이 있지만 외부 API 는 좌표만 본다. 형식 또한 통일되지 않은 임의 문자열 (예: 16-byte random hex on MCPSession, 다른 곳은 자동 생성된 짧은 string).
- **영향**: agent/skill 이 정체성에 접근할 수 없어 라벨에 의존할 수밖에 없다.

### 2.3 엔벨로프의 라우팅 키 취약성
- **위치**: `mcp__dongminal__send_agent_message` 의 `to`/`from`, 엔벨로프 헤더 `[DONGMINAL-AGENT-MSG from=<라벨> to=<라벨> ts=...]`.
- **현상**: 신뢰 통신 채널의 라우팅 키 자체가 좌표(라벨). 송신 중 형제 pane 이 닫히면 수신자 라벨이 다른 pane 으로 옮겨갈 수 있다.
- **영향**: prompt injection 면제 채널의 신뢰 가정이 약화된다.

---

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선순위 |
|----|----------|---------|
| FR-UID-1 | 모든 session/region/tab 엔티티는 생성 시점에 UUID v7 (RFC 9562) 을 발급받아 `id` 필드에 저장한다. workspace.json 안에 inline 으로 영속된다. | 필수 |
| FR-UID-2 | UUID 는 엔티티 destroy 시까지 불변이며, destroy 후 동일 UUID 는 재사용되지 않는다. 서버 재시작 후에도 보존된다. | 필수 |
| FR-UID-3 | 기존 `wsTab.PaneID` (string) 는 alias 로 영구 유지된다 (NFR-UID-0). 출력 필드와 입력 수용 모두 변함 없음. 신규 코드는 tab UUID 를 primary 로 사용하지만 PaneID 기반 호출도 영구 호환. | 필수 |
| FR-UID-4 | 라벨 `S{n}.P{n}.T{n}` 은 derived view 로 유지된다. workspace.json 에는 저장되지 않고 인덱스 빌드 시 계산된다. | 필수 |
| FR-UID-5 | MCP tool 7개의 입출력 스키마는 다음과 같이 확장된다:<br>• 출력: 기존 필드 (label, paneId 등) **영구 유지** + `uuid`/`short_code` 신규 필드 **추가**.<br>• 입력: **기존 필드 (`to`/`from`/`id`/`location` 등) 가 uuid 도 수용**한다. 신규 uuid 전용 필드 추가 없음 (단일 필드 polymorphism). 식별자 형식 (uuid/paneId/label) 은 값의 모양으로 자동 판별. | 필수 |
| FR-UID-6 | `who_am_i()` 는 호출자 pane 의 `{ uuid, label, short_code, session_uuid, region_uuid, tab_uuid, paneId, size }` 를 반환한다. 기존 필드는 그대로, 신규 필드 추가. | 필수 |
| FR-UID-7 | `list_panes()` 는 각 pane 에 대해 `{ uuid, label, short_code, session_uuid, region_uuid, tab_uuid, paneId, shell_pid, focused }` 를 반환한다. 기존 필드는 그대로, 신규 필드 추가. | 필수 |
| FR-UID-8 | 엔벨로프 헤더의 기존 `from`/`to` 필드가 uuid 도 수용한다. **신규 uuid 전용 필드 추가 없음** (단일 필드 polymorphism). 값의 형식 (uuid/paneId/label) 은 모양으로 자동 판별 후 Resolve 거쳐 paneId 로 정규화. label/paneId 만 사용한 기존 엔벨로프도 변경 전과 동일하게 라우팅. | 필수 |
| FR-UID-9 | 사용자 자연어 해석 경로 (예: "오른쪽 위 pane 닫아줘") 는 LLM 측에서 label/위치 표현으로 매칭 후 uuid 로 변환하는 패턴을 **권장**한다 (스킬 문서·프롬프트 기본값). 서버는 label 입력을 영구히 수용하므로 본 권장이 어겨져도 동작은 동일하다. | 필수 |
| FR-UID-10 | dongminal-team 스킬의 `scripts/build_prompt.py` 와 `scripts/plan_layout.py` 는 기존 인자 (`--my-label`, `--boss`, `--teammate <id>:<role>`) 가 uuid 값도 그대로 수용한다. 신규 uuid 전용 인자 추가 없음. 스크립트는 식별자 형식을 검사하지 않고 그대로 통과시키며, 서버 측 Resolve 가 형식을 판별한다. | 필수 |
| FR-UID-11 | `/tmp/dongminal.log` 의 `[cmd]` 라인에 `uuid=<uuid>` 필드를 **추가**한다. 기존 라인 형식은 유지 (필드 추가는 라인 끝). 양방향 lookup 가능. | 필수 |
| FR-UID-12 | 브라우저 SSE 메시지는 엔티티 참조 시 uuid 필드를 **추가**한다. 기존 메시지 필드는 유지. UI 내부 상태 키는 uuid 기준으로 전환하되, label 기반 외부 호출 (URL, deep link 등) 도 영구 동작. focus/drag/close 액션의 결과는 변경 전과 동일. | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
| ID | 요구사항 |
|----|----------|
| **NFR-UID-0** | **행위 보존 불변조건 (Behavior Preservation Invariant) — 최상위 우선.** 본 변경은 모든 Phase 에서 순수 additive 여야 한다. 변경 전 정상 동작하던 모든 입력·출력·플로우 (MCP tool 호출, 엔벨로프 송수신, workspace.json 로드, 브라우저 UI 동작, 로그 파싱) 는 변경 후에도 동일하게 동작해야 한다. 기존 식별자 (label, paneId, 기존 엔벨로프 필드명) 의 입력 수용과 출력 필드는 **영구 유지**한다. 본 NFR 와 충돌하는 임의 FR/Phase 는 본 NFR 가 우선한다. |
| NFR-UID-1 | UUID v7 생성기는 millisecond 단위 monotonic 보장 (동일 ms 내 다중 생성 시 sequence counter 증가). |
| NFR-UID-2 | UUID 영속화는 workspace.json 의 기존 atomic save 경로 (`workspace.Manager.Save`) 를 그대로 사용. 별도 저장소 추가 금지 (NFR-S5 정책 유지). |
| NFR-UID-3 | 라벨 ↔ UUID 양방향 lookup 은 O(1) (`index.labels` / `index.labelToID` 와 동일 패턴). |
| NFR-UID-4 | UUID short-code 충돌 (서로 다른 두 uuid 의 prefix 8자 hex 가 동일) 발생 가능성을 인지하고, 로그에서는 short-code 만 노출하더라도 정확 매칭이 필요한 곳은 full uuid 사용. |
| NFR-UID-5 | 마이그레이션 중 기존 workspace.json (UUID 없는 버전) 을 자동 업그레이드: 빠진 ID 에 한해 UUID v7 부여 후 즉시 영속. 한 번만 수행. |
| NFR-UID-6 | UUID 도입 후에도 `workspace.Manager` 의 lock-free 읽기 성능이 유지된다 (NFR-S5-1 호환). |

### 3.3 설계 제약 (Design Constraints)
| ID | 제약 |
|----|------|
| DC-UID-1 | UUID 라이브러리는 표준 라이브러리 (`crypto/rand`) 위에 자체 구현. 외부 의존 추가 금지 (현재 `go.mod` 가 minimal). |
| DC-UID-2 | 본 SRS 는 식별자 체계만 다룬다. 계층형 팀 (sub-leader 위임) 의 구체 동작은 별도 SRS 에서. |
| DC-UID-3 | UI 의 label 표시 형식은 변경하지 않는다 (사용자 학습 곡선 보존). |

---

## 4. 검증 (Verification)

### 4.1 테스트 케이스
- **TC-UID-1** (영속성): UUID 부여된 workspace.json 을 저장 후 프로세스 재시작 → 동일 UUID 로 로드.
- **TC-UID-2** (라벨 reflow 내성): 3개 세션 (각 uuid 보관) → S2 종료 → S3 의 라벨이 S2 로 변경되지만 uuid 는 불변. 사전에 보관한 uuid 로 close/read 호출 정상 동작.
- **TC-UID-3** (label 입력 영구 호환): MCP tool 에 label 만 전달해도 변경 전과 동일하게 정상 동작. uuid 만 전달, label+uuid 동시 전달 (일치) 모두 동일 결과 (NFR-UID-0).
- **TC-UID-4** (자동 마이그레이션): UUID 없는 레거시 workspace.json 로드 시 누락 ID 에 UUID v7 부여 후 디스크 갱신. 두 번째 로드는 ID 변화 없음. **마이그레이션 전후 모든 label 기반 호출 결과 동일**.
- **TC-UID-5** (엔벨로프 라우팅): pane A 의 uuid 로 send_agent_message → 라벨이 다른 pane 으로 바뀌어도 정확히 A 에게 도달. label 만 있는 기존 엔벨로프도 변경 전과 동일하게 처리.
- **TC-UID-6** (UUID v7 monotonic): 동일 ms 에 100개 생성 → bit-wise 단조 증가 보장.
- **TC-UID-7** (race): `go test -race ./internal/workspace/` 통과.
- **TC-UID-8** (스킬 회귀): 기존 시나리오 1 (4명 팀 비평 파이프라인) 이 uuid 기반으로 그대로 동작.
- **TC-UID-9** (행위 보존 회귀): 변경 전 e2e 테스트 스위트 전체가 **테스트 코드 변경 없이** 통과. label 만 사용, paneId 만 사용, 양쪽 혼합 모든 경로 정상 결과 (NFR-UID-0).
- **TC-UID-10** (엔벨로프 호환): 기존 `[DONGMINAL-AGENT-MSG from=<label> to=<label> ts=...]` 포맷 엔벨로프 (uuid 필드 없음) 가 변경 후에도 정상 라우팅. 양쪽 uuid/label 동시 존재 + 일치 시 동일 결과, 불일치 시 uuid 우선 + 경고 로그.
- **TC-UID-11** (단일 필드 polymorphism): 동일 입력 필드 (`to`/`from`/`id`/`location`) 에 label, paneId, full uuid 를 각각 넣어도 모두 정상 resolve 되어 동일 paneId 반환.

### 4.2 완료 조건 (DoD)
- [ ] **행위 보존 (NFR-UID-0) — 기존 e2e 테스트 스위트가 테스트 코드 무수정 통과 (TC-UID-9).**
- [ ] workspace.json 스키마 확장 (필드 추가, 기존 필드 유지) + 자동 마이그레이션 코드 + 단위 테스트.
- [ ] UUID v7 생성기 구현 + `go test -race` 통과.
- [ ] MCP tool 7개 입출력 스키마 확장 (신규 필드 추가, 기존 필드/입력 영구 유지) + 한국어 description 갱신.
- [ ] 엔벨로프 포맷 확장 (uuid 필드 추가, 기존 label 필드 유지) + 양쪽 모두 라우팅 검증.
- [ ] 브라우저 SSE/UI 갱신 (uuid 필드 추가, 기존 동작 보존).
- [ ] 스킬 파일군 (SKILL.md, references/, scripts/, evals/) 갱신 — uuid 사용을 권장하되 label 사용 예제도 호환.
- [ ] `/tmp/dongminal.log` 포맷 확장 + 디버그 가이드 (`troubleshooting.md`) 업데이트.
- [ ] e2e 회귀: 기존 시나리오 1·2 무수정 통과, 신규 시나리오 (라벨 reflow 내성, 계층 팀 식별자 안정성) 추가.
- [ ] `go test ./...` green.

---

## 5. 비목표 (Non-goals)
- 계층형 팀 (sub-leader 위임) 의 워크플로우 정의 — 별도 SRS (`HIERARCHICAL_TEAM_SRS.md`, 후속).
- label 형식 변경 (현 `S{n}.P{n}.T{n}` 유지).
- UI 의 label 표시 위치/스타일 변경.
- **기존 입력 형식 (label, paneId) 의 제거 또는 거부** — NFR-UID-0 (행위 보존) 위반.
- **기존 출력 필드의 제거 또는 이름 변경** — NFR-UID-0 위반.
- 기존 엔벨로프 포맷 (`from=<label> to=<label>`) 의 거부 — NFR-UID-0 위반.
- 기존 e2e 테스트 / 사용자 스크립트의 수정 강제 — NFR-UID-0 위반.
- 다른 식별 체계 (CRDT-style positional, persistent label namespace 등) 검토.

---

## 6. 마이그레이션 단계 (Migration Phases)

모든 Phase 는 순수 additive 다 (NFR-UID-0). 어느 Phase 도 기존 입력/출력/엔벨로프 형식을 거부하거나 제거하지 않는다.

| Phase | 범위 | 완료 기준 |
|-------|------|-----------|
| **Phase 0** | UUID v7 생성기 + 단위 테스트 | NFR-UID-1, TC-UID-6 통과 |
| **Phase 1 (data layer)** | workspace.json 스키마 확장 + 자동 마이그레이션 + MCP 출력에 uuid/short_code 필드 추가 (label/paneId 출력·입력 변동 없음) | TC-UID-1, TC-UID-4, TC-UID-9 (label-only 기존 호출 무회귀) 통과 |
| **Phase 2 (resolver & routing)** | `workspace.Manager.Resolve` 가 uuid 입력도 paneId 로 정규화. 모든 tool (`send_agent_message`, `workspace_command`, `send_input`, `read_pane_screen`, `read_pane_output`) 이 기존 `to`/`from`/`id`/`location` 필드에 uuid 를 받아도 정상 동작 | TC-UID-5, TC-UID-10, TC-UID-11 통과 |
| **Phase 3 (skill & docs)** | 스킬·문서가 uuid 사용을 기본 권장으로 갱신. 단, label 기반 예제·호출 동작 보존 | TC-UID-8 통과. 스킬 README 갱신 완료 |

**Phase 3 완료 시점에도 label/paneId 입력·출력은 영구 유지** (NFR-UID-0). "enforce" Phase 없음.

각 Phase 마다 `git tag` 와 `docs/internal/UUID_IDENTITY_PROGRESS.md` (후속 작성) 에 진행 기록.

---

## 7. 의존 SRS / 후속 SRS
- 의존: `WORKSPACE_SNAPSHOT_SRS.md` (workspace.Manager 의 atomic 정책 유지).
- 후속: `HIERARCHICAL_TEAM_SRS.md` (sub-leader 위임, 세션-팀 매핑, `[TEAM-DELEGATE]` 메시지 정의). 본 SRS Phase 2 이상 완료 후 착수.
