# 개발자 문서

Dongminal 컨트리뷰터·유지보수자 대상 문서.

디렉터리 규칙은 하나다 — **이 폴더는 지금 읽어야 하는 문서, `archive/` 는 완료된
작업의 기록**이다. 보관 문서는 당시 어휘와 당시 코드 위치를 그대로 담고 있으므로
**갱신하지 않는다.** 지금의 사실은 `architecture.md` 와 코드가 답한다.

## 현행

| 문서 | 내용 |
|------|------|
| [architecture.md](./architecture.md) | 패키지 레이아웃, **에이전트 접합면과 Run**, **에이전트 어댑터 레지스트리**, **멤버 프리앰블**, 어댑터 패턴, 커맨드 브로드캐스트, 핫패스 성능, 종료 경로 |
| [test-checklist.md](./test-checklist.md) | 백엔드·프론트엔드 동작 체크리스트 + 테스트 커버리지 현황 |
| [ENTITY_MODEL_RESTRUCTURE_SRS.md](./ENTITY_MODEL_RESTRUCTURE_SRS.md) | 엔티티 모델(Window ─ Pane ─ Tab ─ Tool)과 백그라운드 도구의 단일 진실 공급원. 요구 1·2 완료. §7 의 Run 접합면(FR-EM-17/18)은 후속 작업의 근거다 |
| [ENTITY_MODEL_HANDOFF.md](./ENTITY_MODEL_HANDOFF.md) | 위 작업의 인계 문서 — 확정된 모델과 근거, P1~P8 완료 내역, **반복하면 안 되는 함정 7개**, 검증 방법 |
| [USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md) | 트랙 1(사용자 확인 피드백)의 인계 문서. 스펙·계획은 `archive/` 로 보관됐고 이 문서만 현행이다 — §4 의 **반복하면 안 되는 함정 15개**가 계속 유효한 필독 자료이기 때문 |
| [SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md) | 상태바 지표 수집 재설계 (IEEE 29148). `/api/stats` 요청당 프로세스 6개·1.5초를 커널 직접 호출로 제거 + 메모리 계산식 정정. **구현 완료** (§4.1 실측) |
| [WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md) | 식별자와 단일 실행자의 단일 진실 공급원 (IEEE 29148). 묶음 I(엔터티 id → uuid)·X(생성 명령 단일 실행자)·**U(모든 발급 지점을 uuid 로 통일 + 형태 판별 제거)**. **구현 완료** |
| [SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md) | MCP 폐지와 세션 스코프 스킬 주입의 단일 진실 공급원 (IEEE 29148). 에이전트 접합면 = `dmctl` (액션) + `--plugin-dir`/`--settings` 주입 스킬·훅 (정책). **구현 완료** |
| [RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md) | AI 오케스트레이터의 단일 진실 공급원 (IEEE 29148). Run 레코드·상태/대기 계약·에이전트 어댑터 레지스트리·worktree 격리·프리앰블/보고 계약·스킬 재작성. 착수 전 결정 5건 확정. **묶음 S·R·P·A·K 구현 완료, W 남음** |
| [ORCHESTRATOR_RESEARCH_NOTES.md](./ORCHESTRATOR_RESEARCH_NOTES.md) | 위 SRS 의 입력 — orca(MIT)·paseo(AGPL) **실제 소스** 조사 노트. 파일 경로 근거 포함. §9 는 기존 문서 서술을 뒤집은 5건 |
| [GIT_SRS.md](./GIT_SRS.md) | **Git 창의 단일 진실 공급원** (IEEE 29148). FR-GIT-1~178, 검증 V1~V69, 21단계 구현 계획. §7 은 확정 결정 O1~O14, §7.1 은 요구사항 해석 I1~I8 |
| [GIT_REMAINING.md](./GIT_REMAINING.md) | **Git 트랙에서 아직 끝나지 않은 것 전부.** §1 사용자 검토 10건 — **오류 3건은 완료**(§1.3·§1.4 에 전수 조사 결과·E4·Git Graph 재구현), **개선 7건은 미착수이며 §1.2 에 착수점과 물어야 할 결정이 있다** · §2 수동 실사 잔여 · §3 문서 흡수 · §4 P1/P2 로 미뤄둔 기능(**2026-08-27 지시로 범위 안**, §4.1 의 자격증명·한글 안내문만 예외) · §5 알려진 간헐 실패 · §6 트랙 밖 별건. **목표는 여기 남은 전부를 끝내는 것이고, 이것이 다음 세션의 출발점이다** |
| [GIT_REVIEW4_SRS.md](./GIT_REVIEW4_SRS.md) | **4차 사용자 검토의 오류 3건 명세** (IEEE 29148). `GIT_SRS`·`GIT_UI_REVISION_SRS` 를 개정한다. **FR-RPT-1~8** 은 Git 밖까지 걸리는 교차 규약이다 — 바깥 계기(폴링·SSE)의 다시 그리기가 요소 상태(hover·더블클릭·드래그·선택·툴팁)를 깨뜨리지 않게 하는 규칙이고, 공통 수단은 `web/js/ui/repaint.js` 다. **§2.3.1 은 VSCode Git Graph 의 배치 규칙 R1~R4 를 근거 코드와 함께 고정한다.** FR-GIT-227~235, V104~V131. §3.6 은 개선 7건이 착수될 때 채워진다 |
| [GIT_SURFACE_MAP.md](./GIT_SURFACE_MAP.md) | 위 SRS 의 입력 — VSCode·gitMaster·Git Graph 의 기능 126개를 6개 표면(S1~S6)에 배치하고 P0/P1/P2 로 나눈 지도. **MVP = P0 38개** |
| [GIT_INTEGRATION_ANALYSIS.md](./GIT_INTEGRATION_ANALYSIS.md) | 같은 SRS 의 설계 근거 (Informative). §3.5 확정 설계(창 싱글턴·고정 탭·Monaco DiffEditor), §4.5 변경 감지 실측(fsnotify·watcher·fsmonitor 기각 근거) |
| [design/](./design/) | **21단계 구현 계약** (`GIT_M*_STEP*_CONTRACT.md`). 각 단계 착수 시 SRS 를 다시 해석하지 않고 이 문서를 단일 진실 공급원으로 삼는다. `design/README.md` 가 색인·픽스처 규약·검증 게이트 |
| [PACKAGE_RESTRUCTURE_SRS.md](./PACKAGE_RESTRUCTURE_SRS.md) | **프로세스 축 패키지 재구성의 단일 진실 공급원** (IEEE 29148). `internal/` 을 helper·daemon·webserver·ctl + `shared/` 로 재배치하고, 대형 패키지 3개(`server` 19,653줄 · `git` 10,936줄 · `app.js` 2,999줄)를 역할별로 갈랐다. §2.1 의 프로세스×패키지 실행 행렬과 §2.3 의 Go 메서드-패키지 제약 실측이 구조를 결정한 근거다. **16단계 전량 구현 완료** (§8.10·§8.11·§8.12) — 프로세스 축 밖 패키지 0개, `handlers_api.go` 701→262줄. §8 은 스펙 이탈 D-1~D-7 과 15·16단계 기록 — 특히 D-1·D-5 는 측정 방법의 결함(경계를 넘는 비공개 멤버 접근을 놓쳤다)을, §8.12 는 §5 비목표 #4 를 철회한 근거를 담는다 |
| [CLI_CONSOLIDATION_SRS.md](./CLI_CONSOLIDATION_SRS.md) | 운영 스크립트 8개를 바이너리 액션 4개(`start`/`stop`/`migrate`/`health`)로 통합하고 `scripts/` 에 `build.sh` 하나만 남긴 근거 (IEEE 29148). **구현 완료** |
| [GIT_MANUAL_CHECKLIST.md](./GIT_MANUAL_CHECKLIST.md) | Git 창 수동 검증 체크리스트 (V14·V60). 자동 테스트가 잡지 못하는 것만 — 배치·색·읽힘, 모바일 실기기, 성능·보안 기준. 픽스처(`e2e/git_fixture.sh`) 기준 |
| [NEXT_SESSION_PROMPT.md](./NEXT_SESSION_PROMPT.md) | 다음 세션 첫 메시지로 붙여넣을 프롬프트(파일 전체가 그대로 첫 메시지다). **열려 있는 것은 Git 창 하나** — 재구성 트랙은 16단계로 닫혔다. `GIT_REMAINING.md` 가 출발점이고, 착수 전에 물어야 할 것(단축키 배정 · "원래 있던 윈도우"의 정의 · 자격증명 배제 유지 여부)과 반복하면 안 되는 함정(`stop` 의 포트 기반 대상 선정, BSD `sed` 의 `\b`, 보호 테스트 약화)을 담는다 |

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
`internal/ctl/migrate` 안의 `panes.json`·`region`·`paneId` 는 **구 어휘가 입력**이라
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
| [MCP_BIND_HELPER_SRS.md](./archive/MCP_BIND_HELPER_SRS.md) — MCP typed bind helper. **전체 폐지** (SKILL_INJECTION_SRS §6) | 2026-05 |
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

### 사용자 확인 피드백 (트랙 1)

| 문서 | 시점 |
|------|------|
| [USER_CHECKLIST_FIXES_SRS.md](./archive/USER_CHECKLIST_FIXES_SRS.md) — 8개 항목의 명세 (묶음 A~F) | 2026-08 |
| [USER_CHECKLIST_FIXES_PLAN.md](./archive/USER_CHECKLIST_FIXES_PLAN.md) — 묶음·순서 + 착수 전 결정 10건 | 2026-08 |

인계 문서(함정 15개)는 현행으로 남아 있다 — 위 표 참조.

### 식별자 · 원격 제어 · 에이전트 접합면

| 문서 | 시점 |
|------|------|
| [UUID_IDENTITY_SRS.md](./archive/UUID_IDENTITY_SRS.md) — UUID 기반 엔티티 정체성 | 2026-05 |
| [DMCTL_UUID_FINALIZE_SRS.md](./archive/DMCTL_UUID_FINALIZE_SRS.md) — dmctl UUID 전환 마무리 (location uuid-only 정책) | 2026-05 |
| [DMCTL_WHO_AM_I_SRS.md](./archive/DMCTL_WHO_AM_I_SRS.md) — `who-am-i` 추가 + 출력 라인 통일 (`internal/helper/toolline`) | 2026-06 |
| [LIST_PANES_NAME_FILTER_SRS.md](./archive/LIST_PANES_NAME_FILTER_SRS.md) — 이름 필터 (현 `list_workspace`) | 2026-06 |
| [REMOTE_SESSION_TAB_CREATE_SRS.md](./archive/REMOTE_SESSION_TAB_CREATE_SRS.md) — `newWindow`/`newTab` 의 keepFocus·name | 2026-06 |
| [RENAME_TAB_SESSION_SRS.md](./archive/RENAME_TAB_SESSION_SRS.md) — `renameTab`/`renameWindow` | 2026-06 |
| [REMOTE_COMMAND_RESULT_SRS.md](./archive/REMOTE_COMMAND_RESULT_SRS.md) — 생성 명령의 새 uuid 반환 (long-poll correlation) | 2026-06 |
| [DONGMINAL_WORKFLOW_SKILL_SRS.md](./archive/DONGMINAL_WORKFLOW_SKILL_SRS.md) — `dongminal-workflow` 스킬. 호출명·설치 경로는 SKILL_INJECTION_SRS 가 개정 | 2026-06 |

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
| 요구 3 — AI 오케스트레이터 (`RUN_ORCHESTRATION_SRS`) | **완료.** 묶음 **S**(상태·대기 계약)·**R**(Run 레코드)·**P**(멤버 프리앰블)·**A**(어댑터 레지스트리)·**K**(스킬 재작성)·**W**(worktree 격리) 전부. FR-STA-4 준비완료 사다리 2단계(화면 패턴)는 스펙에 남기고 구현을 보류했다. **남은 별건**: 실제 격리 팀으로 한 바퀴 — 첫 격리 Run 은 새 worktree 경로가 신뢰 목록에 없어 폴더 신뢰 모달에 걸릴 수 있다 |
| 요구 4 — Git 창 (`GIT_SRS`) | **P0 전량 구현 완료.** 그 뒤 사용자 검토 4회를 반영했다 — 1~3차는 [GIT_UI_REVISION_SRS.md](./GIT_UI_REVISION_SRS.md)(FR-GIT-179~226), 4차 오류 3건은 [GIT_REVIEW4_SRS.md](./GIT_REVIEW4_SRS.md)(FR-RPT-1~8, FR-GIT-227~235). `go test ./...` 통과, Playwright 431. **남은 것은 4차 검토의 개선 7건·수동 실사·P1/P2 기능**이며 전부 [GIT_REMAINING.md](./GIT_REMAINING.md) 에 있다 |
| ~~`TC-BGU-9b` 기존 실패~~ | **해소** (트랙 4 0-A). 제품 결함이 아니라 테스트가 서버 관측을 클라이언트 단정의 배리어로 쓴 것이었다. 별개로 `location` 미지정 복귀의 조용한 무효는 실재했고 FR-BGR-7 로 닫았다 |
| ~~프론트엔드 id 가 UUID 가 아니다~~ | **해소** — 엔터티 id 는 `crypto.randomUUID()` 로 만든다. 생성 명령의 다중 실행도 함께 닫았다 ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| 워크스페이스 PUT 의 last-write-wins | 미해소. 사람 둘이 각자 브라우저에서 동시에 편집하면 한쪽이 유실된다. 오케스트레이터 경로는 FR-SXE-\* 가 덮는다 (WORKSPACE_IDENTITY_SRS §2.4·§5) |
| ~~사용자 인스턴스 v1 → v2 마이그레이션~~ | **완료** (2026-08-24 12:24). `~/.dongminal` 에 `.v1.bak` 3개, `panes.json`→`tools.json` 전환 확인 |
| `~/.dongminal/runs.json` | 커밋된 코드에 소비자가 없는 산출물. 실행 중 바이너리에 문자열조차 없다 — 출처 불명의 Run 레코드 프로토타입 |
| ~~`internal/shared/uuid`(Go v7) 가 죽은 패키지~~ | **해소** — 묶음 U 가 `toolId`·`reqId` 의 단일 생성기로 삼았다 (FR-UNI-6) |
| ~~`toolId` 가 서버 카운터~~ | **해소** — uuid. 카운터가 영속되지 않아 모든 도구가 닫힌 상태로 재기동하면 `"1"` 부터 재사용됐다 (WORKSPACE_IDENTITY_SRS §2.7) |
| ~~LAN 노출 시 엔터티 생성 실패~~ | **해소** — `crypto.randomUUID` 는 보안 컨텍스트 전용이라 `--expose` 접속에서 undefined 였고 폴백이 없었다. `newUUID()` 가 `getRandomValues` 로 폴백한다 (FR-UNI-3) |
| `~/.dongminal/panels.json` | v1 시절 도구 기록. 소비자 없음. 삭제 여부 미정 |
| `CLIENT_ATTACH_SRS` — Client↔Window attach 서버 등록, visibility 파생 | 미착수 (ENTITY_MODEL SRS §7 후속) |
| 사용자 대상 기능 TODO | 저장소 루트 [README.md](../../README.md) |
