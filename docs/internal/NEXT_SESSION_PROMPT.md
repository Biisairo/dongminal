# 다음 세션 프롬프트

**현재 트랙: Git 창 도입 — 구현 단계 (M1 착수)**

분석·스펙이 끝났다. 다음 세션은 **구현**이다. 아래 §1 지시 블록을 새 세션 첫
메시지로 붙여넣는다.

---

## 1. 새 세션에 붙여넣을 지시 블록

```
dongminal 에 Git 창을 구현한다. 분석과 스펙은 끝나 있다.

읽을 것 (순서대로):
  docs/internal/GIT_SRS.md                 ← 스펙. FR-GIT-1~178, 검증 V1~V69
  docs/internal/GIT_SURFACE_MAP.md         ← 기능 → 표면 매핑
  docs/internal/GIT_INTEGRATION_ANALYSIS.md ← 설계 근거 (§3.5 확정 설계, §4.5 감지 전략)

구현 순서는 GIT_SRS.md §6 구현 계획의 21단계를 따른다. 이번 세션은 M1(1~8단계)을
목표로 하되, 컨텍스트가 남으면 M2(9~11단계)까지 이어간다.

작업 방식:
- SDD+TDD. 스펙이 이미 있으므로 각 단계는 테스트 → 구현 순서다.
- 서브에이전트를 적극적으로 쓴다. 독립적인 작업은 병렬로 띄운다 (§2 병렬화 지도 참고).
- 컨텍스트가 꽉 차거나 토큰이 부족해질 때까지 멈추지 말고 진행한다.
- 각 단계가 끝나면 검증(go build/vet/test, gofmt)하고 커밋한다.
- 커밋 메시지에 AI 서명(Co-Authored-By 등)을 넣지 않는다.

열린 결정은 GIT_SRS.md §7 에 있다. M1 해당분(O1~O5)은 아래 값으로 확정하고 진행한다:
  O1 핀 목록 저장 → workspace.json 최상위 git.pinned[]
  O2 diff 크기 상한 → 1MB
  O3 status TTL 캐시 → 200ms
  O4 비활성 리포 배지 → 마지막 관측값을 흐리게 + "최신 아님" 툴팁
  O5 Git 창 이름 → 고정 "Git"
O6 이후는 해당 마일스톤 착수 시 같은 방식으로 정한다 (권장안이 §7 에 적혀 있다).

먼저 GIT_SRS.md 를 읽고, M1 1단계(internal/git)부터 시작해라.
```

---

## 2. 병렬화 지도 (서브에이전트 배치)

의존이 강한 구간과 병렬 가능한 구간이 갈린다. **순차 의존을 병렬로 밀면 재작업이
생기므로** 아래 경계를 지킨다.

### 2.1 병렬 가능

| 묶음 | 내용 | 담당 제안 |
|---|---|---|
| **A** `internal/git` | Go. 다른 무엇에도 의존하지 않는다 | `code-implementer` — 가장 먼저, 단독 |
| **D** 창 타입 `git` | 프론트+워크스페이스 스키마. A 와 무관 | `code-implementer` — A 와 **동시 착수 가능** |
| 테스트 선작성 | 묶음 A·B 의 단위 테스트 (V1~V5) | `test-implementer` — 구현과 병렬 |

A 와 D 는 접점이 없다(하나는 Go 백엔드, 하나는 워크스페이스·프론트 골격). 동시에
띄운다.

### 2.2 순차 (앞이 끝나야 뒤가 선다)

```
A(internal/git) ──▶ B서버(리포 해석 API) ──▶ C서버(signature/status) ──▶ F서버(diff-content)
                                                     │
D(창 타입) ──▶ 내부 고정 탭 골격 ──▶ B클라(GIT 섹션) ─┴─▶ E(Changes 읽기) ──▶ C클라(폴링 배선) ──▶ F클라(Monaco) ──▶ G(상태바)
```

- API 가 없으면 프론트가 붙을 데가 없다. **서버측을 앞세운다.**
- `C클라(폴링)` 는 `E(파일 목록)` 뒤다 — 갱신할 대상이 있어야 폴링이 의미가 있다.

### 2.3 반드시 지킬 것

- **stale 가드(FR-GIT-16/54)는 2단계(B서버)부터 넣는다.** 나중에 덧붙이면 모든 비동기
  경로를 다시 훑어야 한다.
- **M2 는 묶음 J(안전 정책) → H(스테이징) → I(커밋) 순이다.** 파괴적 경로가 열리기
  전에 방어가 서야 한다. 순서를 바꾸지 않는다.
- **M4 는 레인 알고리즘(15단계)을 UI(16단계)보다 먼저 단위 테스트로 고정한다.**
  그래프 버그를 화면으로 디버깅하는 상황을 만들지 않는다.

### 2.4 참조 구현 (그대로 베끼지 말고 근거로 쓸 것)

| 필요할 때 | 볼 것 |
|---|---|
| git 실행 래퍼 (Runner·타임아웃·안전 가드) | `internal/worktree/worktree.go:83` `execGit` |
| 폴링 가시성 게이팅 | `web/js/app.js:2311-2316`, `SYSTEM_STATS_SRS.md` FR-STAT-17 |
| 비터미널 탭 선례 (Monaco) | `web/js/file-editor.js` |
| 탭 타입 확장 선례 | `docs/internal/archive/MULTI_TAB_TYPE_SPEC.md` |
| API 라우트 등록 | `internal/server/handlers_api.go:151` `apiRoutes` |
| 상태바 항목 | `web/js/helpers.js:85` `STATUS_ITEMS`, `app.js:2336` |
| DAG 레인 알고리즘 (M4) | `~/personal/gitmaster-app-electron-pnpm/apps/desktop/src/renderer/features/log/laneLayout.ts` (130줄, TS→JS 거의 그대로) |

### 2.5 검증

```bash
go build ./... && go vet ./... && go test ./... && gofmt -l .
npm run e2e                 # Playwright. 기준선 187 통과
```

기준선을 먼저 재고 시작한다. 신규 테스트는 기준선 위에 얹는다.

---

## 3. 이번 트랙의 확정 사항 (요약 — 상세는 GIT_SRS.md)

| 항목 | 결정 |
|---|---|
| 형태 | Git = **창(window)**, 워크스페이스에 1개 (싱글턴) |
| 진입 | 좌측 사이드바 GIT 섹션 — `⟳` cwd 자동 + `📌` 고정 + `+ Add` |
| 창 내부 | **고정 탭** `Changes / Diff / History / Branches / Stash / Console` |
| Changes | 상단 고정 커밋 영역(스크롤 무관) + 좌 파일목록 + 우 diff 미리보기 + 헤더 Fetch/Pull/Push |
| Diff | 창 전체 폭 + `‹ ›` 파일 네비게이션 |
| History | refs 사이드바 + 커밋 리스트 + DAG(행별 SVG) + **인라인 펼침** 상세 |
| 이동 | 단일클릭=미리보기, 더블클릭=Diff 탭 |
| 변경 감지 | **`git status` 폴링** (신호 4종 + signature 500ms + status 1s). 라이브러리 미도입 |
| diff 엔진 | **Monaco DiffEditor** (이미 로드 중인 자산) |
| 모바일 | 전 기능 + 파괴적 조작에 강화된 확인 |
| MVP | M1~M5 = P0 38개 전부 |

**기각된 것과 사유** (다시 논의하지 말 것):

- 우측 사이드 패널 — 260px 로 6개 표면을 못 담고 Agents 패널과 자리를 다툰다.
  dongminal 은 분할 칸이 있어 "사이드바로 에디터 영역을 지킨다" 는 VSCode 전제가
  성립하지 않는다
- 일반 탭 — 창·칸마다 중복 생성되어 "Git 이 어디 열려 있는지" 를 잃는다
- fsnotify / radovskyb·watcher / git hooks — 실측과 라이브러리 실상으로 기각
  (ANALYSIS §4.5.3). watcher 는 그 자체가 폴링이고 2019년 유지보수 중단,
  fsnotify 는 darwin 에서 kqueue 라 파일당 FD 를 쓰고 **에디터의 atomic save 에서
  watch 가 유실**된다
- 칸 최대화(zoom) — Diff 탭이 그 역할을 한다

---

## 4. 완료된 이전 트랙 (기록)

| 트랙 | 상태 |
|---|---|
| 1. 사용자 확인 피드백 | 완료 — iOS 실기기 수동 확인만 남음 ([USER_CHECKLIST_FIXES_HANDOFF.md](./USER_CHECKLIST_FIXES_HANDOFF.md)) |
| 2. MCP 폐지 → 세션 스코프 스킬 주입 | 완료 — `6681a14`, `1013f8c` ([SKILL_INJECTION_SRS.md](./SKILL_INJECTION_SRS.md)) |
| 3. 상태바 지표 재설계 | 완료 — `286ebd8` ([SYSTEM_STATS_SRS.md](./SYSTEM_STATS_SRS.md)) |
| 4-a. 오케스트레이터 — 결함·식별자 통일 | 완료 ([WORKSPACE_IDENTITY_SRS.md](./WORKSPACE_IDENTITY_SRS.md)) |
| 4-b. 오케스트레이터 — 조사·설계 | 완료 ([RUN_ORCHESTRATION_SRS.md](./RUN_ORCHESTRATION_SRS.md)) |
| 4-c. 오케스트레이터 — 구현 | 완료 — 묶음 S·R·P+A·K·W |
| 5. 브랜드 아이콘·파비콘 | 완료 — `7d56fbb` |

**남은 별건**: 실제 격리 팀으로 한 바퀴 (첫 격리 Run 은 새 worktree 경로가 신뢰
목록에 없어 폴더 신뢰 모달에 걸릴 수 있다), iOS 실기기 확인.
