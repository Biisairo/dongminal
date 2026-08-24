# 개발자 문서

Dongminal 컨트리뷰터·유지보수자 대상 문서.

디렉터리 규칙은 하나다 — **이 폴더는 지금 읽어야 하는 문서, `archive/` 는 완료된
작업의 기록**이다. 보관 문서는 당시 어휘와 당시 코드 위치를 그대로 담고 있으므로
**갱신하지 않는다.** 지금의 사실은 `architecture.md` 와 코드가 답한다.

## 현행

| 문서 | 내용 |
|------|------|
| [architecture.md](./architecture.md) | 패키지 레이아웃, 어댑터 패턴, 커맨드 브로드캐스트, 핫패스 성능, 종료 경로 |
| [test-checklist.md](./test-checklist.md) | 백엔드·프론트엔드 동작 체크리스트 + 테스트 커버리지 현황 |
| [ENTITY_MODEL_RESTRUCTURE_SRS.md](./ENTITY_MODEL_RESTRUCTURE_SRS.md) | 엔티티 모델(Window ─ Pane ─ Tab ─ Tool)과 백그라운드 도구의 단일 진실 공급원. 요구 1·2 완료. §7 의 Run 접합면(FR-EM-17/18)은 후속 작업의 근거다 |
| [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) | 위 작업의 인계 문서 — 확정된 모델과 근거, P1~P8 완료 내역, **반복하면 안 되는 함정 7개**, 검증 방법 |
| [USER_CHECKLIST_FIXES_SRS.md](./USER_CHECKLIST_FIXES_SRS.md) | 사용자 확인 피드백 8개 항목의 단일 진실 공급원 (IEEE 29148). 묶음 A~D 완료, E·F 는 골격만 |
| [USER_CHECKLIST_FIXES_PLAN.md](./USER_CHECKLIST_FIXES_PLAN.md) | 위 작업의 묶음·순서·의존성 + **착수 전 결정 10건**(E 5 · F 5) |
| [USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md) | 위 작업의 인계 문서 — A~D 완료 내역, **반복하면 안 되는 함정 9개**, 검증 방법, 미해결 |
| [NEXT_SESSION_PROMPT.md](./NEXT_SESSION_PROMPT.md) | 다음 세션 첫 메시지로 붙여넣을 프롬프트. **진행 중 트랙 2개**(사용자 피드백 E·F / AI 오케스트레이션) |

## 용어

좌표계는 `W{n}.P{n}.T{n}` 이고 계층은 아래와 같다. 보관 문서의 `session`·`region`·
`paneId` 는 각각 아래의 Window·Pane·Tool 을 뜻한다.

```
공간 축:  Client ▶ Window ─ Pane ─ Tab ─ Tool
실행 축:  Run ─ Member ──1:1──▶ Tool        (직교. 접합 필드만 구현됨)
```

| 용어 | 뜻 |
|------|----|
| **Client** | 브라우저 창. 휘발성 뷰포트. Window 하나에 attach |
| **Window** | Pane 들을 담는 작업공간. 서버 영속. tmux 의 session |
| **Pane** | Window 안에서 나뉜 공간. 탭 목록 보유 |
| **Tab** | 도구를 담는 공간 |
| **Tool** | 탭에 탑재되는 실체 (`terminal` \| `editor`) |
| **Run** | 오케스트레이션 실행 인스턴스 (미구현) |

`paned`·`paned.sock`·`paned.pid` 는 **데몬 프로세스의 이름**이며 개명 대상이 아니다.
`internal/migrate` 안의 `panes.json`·`region`·`paneId` 는 **구 어휘가 입력**이라
그대로 둔다.

## 보관 (`archive/`) — 완료된 작업의 기록

### 아키텍처 · 리팩터

| 문서 | 시점 |
|------|------|
| [ARCHITECTURE_DEEPENING_RFC.md](./archive/ARCHITECTURE_DEEPENING_RFC.md) — C1–C5 모듈 심화 | 2026-04 |
| [FOLLOWUP_HOTFIX_RFC.md](./archive/FOLLOWUP_HOTFIX_RFC.md) — H1–H5·F1–F4. H5 는 workspace 비동기 쓰기 | 2026-04 |
| [DESIGN_REVIEW_FOLLOWUP.md](./archive/DESIGN_REVIEW_FOLLOWUP.md) — 설계 리뷰 후속 계획 | 2026-05 |
| [APP_DECOMPOSE_SRS.md](./archive/APP_DECOMPOSE_SRS.md) — App 클래스 3분할 | 2026-05 |
| [PANE_MANAGER_DECOMPOSE_SRS.md](./archive/PANE_MANAGER_DECOMPOSE_SRS.md) — PaneManager 분해 + mutex 정리 | 2026-05 |
| [HANDLERS_API_ROUTER_SRS.md](./archive/HANDLERS_API_ROUTER_SRS.md) — handlers_api 라우터 테이블화 | 2026-05 |
| [WORKSPACE_SNAPSHOT_SRS.md](./archive/WORKSPACE_SNAPSHOT_SRS.md) — Workspace Snapshot 단일 진입점 | 2026-05 |
| [MCP_BIND_HELPER_SRS.md](./archive/MCP_BIND_HELPER_SRS.md) — MCP typed bind helper | 2026-05 |
| [RUNTIME_HELPERS_GO_SRS.md](./archive/RUNTIME_HELPERS_GO_SRS.md) — 런타임 헬퍼 Go 재작성 | 2026-05 |
| [TS_MIGRATION_SRS.md](./archive/TS_MIGRATION_SRS.md) — 프론트엔드 TypeScript 마이그레이션 | 2026-05 |
| [TODO.md](./archive/TODO.md) — 2026-04~05 작업 로그 (완료 49건) | 2026-05 |
| [NEXT_SESSION_PROMPTS.md](./archive/NEXT_SESSION_PROMPTS.md) — 당시 세션 프롬프트 | 2026-05 |

### 안정성 · 동시성

| 문서 | 시점 |
|------|------|
| [SAFETY_WARMUP_SRS.md](./archive/SAFETY_WARMUP_SRS.md) — L1/L4/L8 | 2026-05 |
| [CONCURRENCY_HARDENING_SRS.md](./archive/CONCURRENCY_HARDENING_SRS.md) — L3/L5/L7 | 2026-05 |
| [OUTBUF_BACKPRESSURE_SRS.md](./archive/OUTBUF_BACKPRESSURE_SRS.md) — PTY 출력 백프레셔 | 2026-05 |
| [HOT_RELOAD_SRS.md](./archive/HOT_RELOAD_SRS.md) — 무중단 재기동 | 2026-05 |
| [MDSCROLL_LEAK_FIX_SRS.md](./archive/MDSCROLL_LEAK_FIX_SRS.md) — 스크롤 리스너 누수 | 2026-05 |

### 레이아웃 · 포커스

| 문서 | 시점 |
|------|------|
| [SPLIT_SERIALIZATION_SRS.md](./archive/SPLIT_SERIALIZATION_SRS.md) — 분할 직렬화 | 2026-05 |
| [SHORTCUT_DISPATCH_SRS.md](./archive/SHORTCUT_DISPATCH_SRS.md) — 단축키 디스패치 | 2026-05 |
| [PANE_SCROLL_PRESERVE_SRS.md](./archive/PANE_SCROLL_PRESERVE_SRS.md) — 창 전환 시 스크롤 보존 | 2026-05 |
| [SPLIT_KEEPFOCUS_FIX_SRS.md](./archive/SPLIT_KEEPFOCUS_FIX_SRS.md) — keepFocus 시맨틱 정정 | 2026-06 |
| [THEMES_EXPANSION_SRS.md](./archive/THEMES_EXPANSION_SRS.md) — 테마 라이브러리 확장 | 2026-05 |

### 편집기 · 마크다운 (현재는 내장 Monaco 편집기로 대체됨)

`8dc0a3f`("feat: editor 임베드")에서 markdown 뷰어와 code-server 통합이 제거됐다.
아래 문서들의 대상은 더 이상 존재하지 않는다.

| 문서 | 시점 |
|------|------|
| [MULTI_TAB_TYPE_SPEC.md](./archive/MULTI_TAB_TYPE_SPEC.md) — 다중 탭 타입 인프라 + Markdown 뷰어 | 2026-04 |
| [MD_FOCUS_NEW_PANE_CWD_SRS.md](./archive/MD_FOCUS_NEW_PANE_CWD_SRS.md) — 파일 탭의 cwd 상속 (`editor` 로 이관돼 살아 있다) | 2026-05 |
| [MD_SCROLL_SYNC_SRS.md](./archive/MD_SCROLL_SYNC_SRS.md) — 마크다운 스크롤 동기화 | 2026-05 |
| [MD_VIEWER_REGRESSION_FIX_SRS.md](./archive/MD_VIEWER_REGRESSION_FIX_SRS.md) — 뷰어 도입 후 회귀 (포커스 불변식은 살아 있다) | 2026-05 |
| [CODESERVER_SHUTDOWN_SRS.md](./archive/CODESERVER_SHUTDOWN_SRS.md) — code-server graceful shutdown | 2026-05 |
| [CODESERVER_STABILITY_SRS.md](./archive/CODESERVER_STABILITY_SRS.md) — code-server 안정화 | 2026-05 |

### 모바일

| 문서 | 시점 |
|------|------|
| [MOBILE_MODE_RFC.md](./archive/MOBILE_MODE_RFC.md) — 모바일 모드 전반 | 2026-05 |
| [MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md](./archive/MOBILE_KEYBAR_ALWAYS_VISIBLE_SRS.md) | 2026-05 |
| [MOBILE_KEYBAR_LAYOUT_ROBUSTNESS_SRS.md](./archive/MOBILE_KEYBAR_LAYOUT_ROBUSTNESS_SRS.md) | 2026-05 |
| [MOBILE_KEYBAR_TOOLTIPS_SRS.md](./archive/MOBILE_KEYBAR_TOOLTIPS_SRS.md) | 2026-05 |
| [MOBILE_VERIFICATION_AUTOMATION_SRS.md](./archive/MOBILE_VERIFICATION_AUTOMATION_SRS.md) — RFC §7.2 검증 자동화 | 2026-05 |

### 식별자 · 원격 제어 · MCP

| 문서 | 시점 |
|------|------|
| [UUID_IDENTITY_SRS.md](./archive/UUID_IDENTITY_SRS.md) — UUID 기반 엔티티 정체성 | 2026-05 |
| [DMCTL_UUID_FINALIZE_SRS.md](./archive/DMCTL_UUID_FINALIZE_SRS.md) — dmctl UUID 전환 마무리 (location uuid-only 정책) | 2026-05 |
| [DMCTL_WHO_AM_I_SRS.md](./archive/DMCTL_WHO_AM_I_SRS.md) — `who-am-i` 추가 + 출력 라인 통일 (`internal/toolline`) | 2026-06 |
| [LIST_PANES_NAME_FILTER_SRS.md](./archive/LIST_PANES_NAME_FILTER_SRS.md) — 이름 필터 (현 `list_workspace`) | 2026-06 |
| [REMOTE_SESSION_TAB_CREATE_SRS.md](./archive/REMOTE_SESSION_TAB_CREATE_SRS.md) — `newWindow`/`newTab` 의 keepFocus·name | 2026-06 |
| [RENAME_TAB_SESSION_SRS.md](./archive/RENAME_TAB_SESSION_SRS.md) — `renameTab`/`renameWindow` | 2026-06 |
| [REMOTE_COMMAND_RESULT_SRS.md](./archive/REMOTE_COMMAND_RESULT_SRS.md) — 생성 명령의 새 uuid 반환 (long-poll correlation) | 2026-06 |
| [DONGMINAL_WORKFLOW_SKILL_SRS.md](./archive/DONGMINAL_WORKFLOW_SKILL_SRS.md) — `dongminal-workflow` 스킬 | 2026-06 |

### 알림 · 활동

| 문서 | 시점 |
|------|------|
| [PANE_ATTENTION_NOTIFY_SRS.md](./archive/PANE_ATTENTION_NOTIFY_SRS.md) — 출력 감시 기반 주의 알림 (SSE `tool_attention`) | 2026-06 |
| [AGENT_ACTIVITY_PANEL_SRS.md](./archive/AGENT_ACTIVITY_PANEL_SRS.md) — 에이전트 활동 패널 (SSE `tool_activity`) | 2026-06 |

### 데몬 분리

| 문서 | 시점 |
|------|------|
| [DAEMON_SPLIT_SRS.md](./archive/DAEMON_SPLIT_SRS.md) — `dongminald` + `dongminal` 분리 | 2026-06 |
| [DAEMON_CWDPANE_RESOLVE_SRS.md](./archive/DAEMON_CWDPANE_RESOLVE_SRS.md) — 데몬 모드 cwd 해석 | 2026-06 |
| [DAEMON_PANE_BUSY_RESOLVE_SRS.md](./archive/DAEMON_PANE_BUSY_RESOLVE_SRS.md) — 데몬 모드 busy 해석 | 2026-06 |

## 남은 작업

| 항목 | 상태 |
|------|------|
| 요구 3 — AI 오케스트레이션 (`RUN_ORCHESTRATION_SRS`) | 미착수. 착수 전 worktree 격리 정책을 결정해야 한다 ([NEXT_SESSION_PROMPT.md](./NEXT_SESSION_PROMPT.md)) |
| 사용자 인스턴스 v1 → v2 마이그레이션 | 미실행. 순서는 [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) §4.2 |
| `CLIENT_ATTACH_SRS` — Client↔Window attach 서버 등록, visibility 파생 | 미착수 (ENTITY_MODEL SRS §7 후속) |
| 사용자 대상 기능 TODO | 저장소 루트 [README.md](../../README.md) |
