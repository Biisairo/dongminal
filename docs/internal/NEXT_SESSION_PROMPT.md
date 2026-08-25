# 다음 세션 프롬프트

**현재 트랙: Git 창 — 코드 완료 (1~20단계). 남은 것은 21단계 수동 검증뿐.**

---

## 1. 새 세션에 붙여넣을 지시 블록

```
dongminal Git 창의 MVP 코드가 완료됐다 (GIT_SRS 1~20단계). 남은 것은 21단계
수동 검증이다.

읽을 것:
  docs/internal/GIT_MANUAL_CHECKLIST.md   ← 이번 세션의 작업 목록
  docs/internal/GIT_SRS.md §4             ← 성능·보안 기준
  docs/internal/design/README.md          ← 검증 게이트와 알려진 간헐 실패

할 일:
1. scripts/git_fixture.sh 로 저장소 10종을 만들고 dongminal 을 띄운다.
2. GIT_MANUAL_CHECKLIST.md 의 G1~G7 을 순서대로 확인한다. 각 항목을
   ☑(정상) / ✗(결함, 사유) 로 표시해 문서에 기록한다.
3. ✗ 가 나오면 그 자리에서 고치지 말고 먼저 전부 훑는다 — 결함 목록을 모은 뒤
   우선순위를 정한다. 화면 배치·색·읽힘은 스펙이 정하지 않은 것이 많으므로
   "결함"과 "취향"을 구분해 기록한다.
4. 보안 기준(S.1~S.4)은 반드시 확인한다 — 로그·저장 파일·요청 본문에 자격증명이
   없어야 한다.
5. iOS/Android 실기기 확인(G7)은 사용자만 할 수 있다. 그 항목은 사용자에게
   넘긴다.

검증:
  go build ./... && go vet ./... && go test ./... -race && gofmt -l .
  npx playwright test --retries=1     # 348 통과 (부하 민감성 때문에 retries 를 준다)

커밋 메시지에 AI 서명(Co-Authored-By 등)을 넣지 않는다.
```

---

## 1.5 진행 상황

**MVP 코드 완료.** 기준선 — `go test ./... -race` 전부 통과 · gofmt clean ·
Playwright **187 → 348** (0~1건 간헐, `design/README.md` 참고).

| 단계 | 내용 | 상태 | 커밋 |
|:--:|---|---|---|
| — | 21단계 설계 계약 `./design/` + 색인 | ✅ | `67bc325` `b8a288a` |
| — | SRS §7 결정 확정 (O1~O14) + §7.1 해석 (I1~I8) | ✅ | `6157476` |
| — | 검증용 저장소 픽스처 10종 (`scripts/git_fixture.sh`) | ✅ | `ddb4307` |
| — | 수동 검증 체크리스트 (V14·V60·V61) | ✅ | `cece980` |
| — | 테스트 더블 데이터 레이스 2건 — `-race` 게이트 복구 | ✅ | `a2c3abe` |
| **M1 읽기** | 1 A · 2 B·C서버 · 3 D · 4 B클라 · 5·6 E·C클라 · 7 F · 8 G | ✅ | `f455137` `cc62d09` `8ed0396` `72bbe00` `747db3a` `a9f244e` `f078fdf` `1493a8a` |
| **M2 커밋** | 9 J(안전 정책) · 10 H(스테이징) · 11 I(커밋) | ✅ | `71ed098` `579a070` `54d869c` `5d25d65` |
| **M3 원격** | 12 job 인프라 · 13 K(fetch/pull/push) | ✅ | `ef45143` `677b059` |
| **M4 히스토리** | 14 조회 · 15 레인 · 16·17 History+메뉴 프레임워크 · diff 축 | ✅ | `a036af5` `6a01d4d` `a25abd0` `90d93a4` |
| **M5 참조** | 18 N(Branches) · 19 O(Stash) · 20 P(다이얼로그 규약) | ✅ | `c9f8134` `7dd4130` `525ca24` |
| 21 | **MVP 수동 검증** — `../GIT_MANUAL_CHECKLIST.md` | **남음** | |

FR-GIT-1~178 전부가 코드·테스트에서 참조되고, 검증 V1~V69 전부가 자동 테스트
또는 수동 체크리스트에 대응한다 (기계적으로 확인).

### 병렬 운영에서 배운 것

- **Go 레인 1개 + JS 레인 1개**로 운영한다. 같은 레인에 둘을 띄우면
  `internal/server/handlers_api.go` 의 라우트 표와 `web/js/*.js` 에서 충돌한다.
- **Playwright 는 동시에 두 번 돌 수 없다** — 고정 포트 58147 +
  `reuseExistingServer:false`. e2e 실행 권한을 한 번에 하나에게만 준다.
- `git add <디렉터리>` 로 커밋하면 **다른 에이전트의 미완성 변경을 삼킨다.** 파일을
  명시해 add 한다 (실제로 한 번 삼켜서 히스토리를 되돌렸다).
- **실측을 계약 문서에 먼저 반영하면 뒤 단계가 같은 함정을 밟지 않는다.** 이번에
  그렇게 막은 것: `git log` 의 `-z` 누락(레코드 사이 개행), `config --get` 의
  exit 1(미설정), 없는 blob 의 exit 128.
- 에이전트 산출물은 **독립 검증**한다. 이번 세션에서 그렇게 찾은 실제 결함:
  detached 경고의 preflight 경합, `git-panel.js` 의 리터럴 NUL, `commit-parent`
  축의 빈 oid, `check-ref-format --branch '@{-1}'` 의 이름 확장.

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
