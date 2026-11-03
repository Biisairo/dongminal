# Git 기능 통합 분석 (Informative)

> 성격: 정보성 분석 문서. 정상 요구사항(normative)을 정의하지 않는다.
> 후속: 이 문서의 §5 결정 사항이 해소되면 IEEE 29148 기반 SRS 를 별도 작성한다.
> 작성일: 2026-08-25

---

## 1. 목적과 방법

dongminal 에 Git 기능을 추가하기 위해 레퍼런스 3종의 기능·UI 를 전수 조사하고,
dongminal 의 실제 접합면(코드 근거)에 매핑해 **무엇을 가져오고 무엇을 버릴지**의
판단 근거를 만든다.

### 1.1 레퍼런스와 조사 방법

| 레퍼런스 | 실체 | 조사 방법 |
|---|---|---|
| VSCode 내장 Git | `/Applications/Visual Studio Code.app/.../extensions/git` | `package.json` 의 `contributes.commands`(183개)·`menus`(29개 지점) 직접 파싱 |
| Git Graph | `~/.vscode/extensions/mhutchie.git-graph-1.30.0` | `contributes.commands`·`configuration`(110 설정)·`contextMenuActionsVisibility` 스키마 직접 파싱 |
| gitMaster | `~/personal/gitmaster-app-electron-pnpm` | IEEE 29148 SRS 문서군(`docs/requirements/**`, 8,885줄) + 구현 코드(TS/React 34k 줄) |

> 사용자가 말한 `~/personal/git-master` 는 실제로 `~/personal/gitmaster-app-electron-pnpm` 이다.

### 1.2 dongminal 접합면 조사 근거

| 항목 | 근거 파일 |
|---|---|
| 탭 타입 다형성 | `web/js/app.js:1242` `addTab(rid, type, opts)`, `docs/internal/archive/MULTI_TAB_TYPE_SPEC.md` |
| API 라우트 테이블 | `internal/server/handlers_api.go:151` `apiRoutes` |
| 커맨드 브로드캐스트 | `internal/server/server.go:104-106` (`/api/commands`, SSE) |
| 기존 git 실행 래퍼 | `internal/worktree/worktree.go:83` `execGit` (Runner 주입·타임아웃·안전 가드) |
| 헬퍼 CLI | `internal/runtimebin/` (`dmctl`/`edit`/`download`/`detach` multi-call) |
| 비터미널 탭 선례 | `web/js/file-editor.js` (Monaco 편집기 탭, 375줄) |

---

## 2. 레퍼런스 기능 카탈로그 (통합)

### 2.1 세 레퍼런스의 성격 차이

```
VSCode Git    : SCM 뷰 = "지금 변경된 것"을 다루는 도구. 그래프는 최근 추가된 곁가지.
Git Graph     : DAG 뷰 = "히스토리"를 읽는 도구. 커밋 우클릭이 조작의 전부.
gitMaster     : IntelliJ 계보 = "리포 전체 상태"를 다루는 도구. 멀티 리포가 정체성.
```

### 2.2 기능 매트릭스

범례: ● 완전 지원 / ◐ 부분·제한적 / ○ 없음

| 기능 영역 | VSCode | Git Graph | gitMaster |
|---|:--:|:--:|:--:|
| **변경 조회·스테이징** | | | |
| status 3그룹(staged/unstaged/untracked) | ● | ◐ (uncommitted 1행) | ● |
| 파일 단위 stage/unstage/discard | ● | ○ | ● |
| hunk 단위 partial staging | ● (`diff.stageHunk`) | ○ | ● |
| line range staging | ● (`stageSelectedRanges`) | ○ | ◐ (P1) |
| partial staged indeterminate 표시 | ○ | ○ | ● |
| **커밋** | | | |
| 비모달 커밋 입력 | ● | ○ | ● |
| amend / signoff / no-verify / empty | ● (조합 20종 명령) | ○ | ● |
| GPG 서명 상태 표시 | ◐ | ● (설정) | ● |
| 커밋 메시지 draft 영속 | ● | ○ | ● (repo별 store) |
| commit template prefill | ● | ○ | ● |
| author override | ○ | ○ | ● |
| **preflight 검증** (identity/detached/진행중 작업) | ○ | ○ | ● |
| undo last commit (5초 토스트) | ◐ (명령만) | ○ | ● |
| **로그·그래프** | | | |
| DAG 그래프 | ◐ (최근 내장) | ● (핵심) | ● |
| 가상 스크롤·페이징 | ● | ● | ● |
| branch/user/date/path/text 필터 | ◐ | ◐ | ● |
| loaded 검색 vs query 검색 구분 | ○ | ○ | ● |
| hash/branch/tag 즉시 jump | ◐ | ● | ● |
| commit range 비교(`A..B`,`A...B`) | ◐ | ◐ | ● |
| 다중 로그 탭(독립 커서) | ○ | ○ | ● |
| **멀티 리포 색상 스트라이프** | ○ | ○ | ● |
| 그래프 스타일·색 커스터마이즈 | ○ | ● (110 설정) | ◐ |
| 커밋 mute(비-조상/머지 커밋) | ○ | ● | ○ |
| reflog 언급 커밋 포함 | ○ | ● | ○ |
| **브랜치** | | | |
| checkout/create/rename/delete | ● | ● | ● |
| 원격 브랜치 → 로컬 체크아웃 | ● | ● | ● |
| 즐겨찾기 · `/` prefix 그룹핑 · 검색 | ○ | ◐ (glob 패턴) | ● |
| 브랜치 비교(커밋+diff) | ● (`graph.compareRef`) | ◐ | ● |
| upstream set/unset · ahead/behind | ◐ | ● | ● |
| dirty 시 stash/abort/force 선택 | ○ | ○ | ● |
| 다중 브랜치 일괄 삭제 | ○ | ○ | ● |
| **동기화** | | | |
| fetch/pull/push (+prune/tags/rebase) | ● | ● | ● |
| **push preview (outgoing 커밋+diff 검증)** | ○ | ○ | ● |
| force-with-lease 기본화 | ◐ (`pushForce` 설정) | ◐ | ● |
| push 대상 remote/branch 다이얼로그 수정 | ● (`pushTo`) | ● | ● |
| rejected 후 fetch+rebase/merge 리커버리 | ○ | ○ | ● |
| **취소 가능한 job(jobId + SIGTERM)** | ○ | ○ | ● |
| 진행률 line stream | ◐ (output 채널) | ○ | ● (7단계 stepper) |
| **머지·리베이스·충돌** | | | |
| merge 옵션(ff-only/no-ff/squash) | ◐ | ● | ● |
| rebase / abort / continue | ● | ● | ● |
| 3-way merge editor | ● (내장 merge editor) | ○ | ● |
| **인터랙티브 리베이스 GUI** | ○ | ◐ (터미널 위임) | ● (드래그 순서변경) |
| 머지 전 영향 범위(ff 가능·충돌 예상) | ○ | ○ | ● |
| **stash** | | | |
| push/apply/pop/drop/list | ● | ● | ● |
| stash 미리보기(index/working 분리) | ◐ (stash editor) | ◐ | ● |
| `--keep-index` / `--include-untracked` | ● | ● | ● |
| partial stash(hunk 선택) | ● (`stashStaged`) | ○ | ● |
| stash → branch | ○ | ● | ● |
| pop 충돌 시 잔류 명시 | ○ | ○ | ● |
| **태그** | | | |
| create(lightweight/annotated/signed) | ◐ | ● | ● |
| delete(local/remote) | ● | ● | ● |
| push(single/all/mode) | ● | ● | ● |
| force re-tag(`--force-with-lease` 우선) | ○ | ○ | ● |
| **diff 뷰어** | | | |
| side-by-side + unified 토글 | ● | ◐ | ● |
| word/char 단위 하이라이트 | ● | ● | ● |
| whitespace 무시 | ● | ○ | ● |
| binary / LFS pointer 폴백 | ● | ◐ | ● |
| hunk 임계 초과 truncate + show all | ◐ | ○ | ● |
| **히스토리** | | | |
| file history (`--follow`) | ● (timeline) | ● | ● |
| blame / annotate | ● (`blame.*` 데코레이션) | ○ | ● |
| annotate previous revision 연쇄 | ○ | ○ | ● |
| **History for Selection (`git log -L`)** | ○ | ○ | ● |
| **저장소 관리** | | | |
| clone / init / open / discover | ● | ◐ (add/remove) | ● |
| 멀티 리포 워크스페이스·그룹 | ◐ (multi-root) | ◐ (드롭다운) | ● |
| **멀티 리포 일괄 조작(concurrency 4 + 결과 표)** | ○ | ○ | ● |
| submodule 상태·update/sync | ◐ | ○ | ● |
| worktree 생성/열기/삭제 | ● | ○ | ◐ (P2) |
| **관측·안전** | | | |
| **통합 Console(argv·exit·stderr·replay)** | ◐ (읽기전용 output) | ○ | ● |
| destructive 2단계 확인 + 영향 범위 | ○ | ◐ | ● |
| **recovery hint(폐기 직전 복구 안내)** | ○ | ○ | ● |
| stale 응답 가드(repo 전환 시) | — | — | ● |
| 상태바(브랜치·dirty·conflict·ahead/behind chip) | ● | ● | ● |
| **기타 고유** | | | |
| Code Review 추적(파일 읽음 표시) | ○ | ● **고유** | ○ |
| 에디터 gutter change decoration | ● **고유** | ○ | ○ |
| autofetch | ● **고유** | ◐ | ○ |
| timeline 뷰 | ● **고유** | ○ | ○ |

### 2.3 gitMaster 가 VSCode 계열에 없이 가진 것 (사용자 지적 사항의 실체)

조사 결과 **12개**로 좁혀진다. 이것이 "git-master 에만 있는 기능"의 정체다.

| # | 기능 | 왜 중요한가 |
|---|---|---|
| G1 | **멀티 리포 일괄 조작** — 체크아웃/커밋/푸시/태그/스태시를 여러 리포에 동시 실행, concurrency 4, repo별 성공/실패/skip 결과 표 | gitMaster 존재 이유. VSCode 는 리포별 개별 실행뿐 |
| G2 | **통합 Console** — 실행된 모든 git argv·cwd·exitCode·duration·stderr 를 한 패널에 수집, 필터·복사·**replay** | 회귀 추적·디버깅. VSCode output 은 읽기 전용 단일 스트림 |
| G3 | **preflight 검증** — 커밋 전 user.identity·detached HEAD·머지/리베이스 진행 상태를 사전 차단 | 실패를 사후 에러가 아닌 사전 차단으로 전환 |
| G4 | **recovery hint** — discard/drop/delete 직전에 복구 수단(snapshot/stash/reflog ref 값)을 기록·안내 | 파괴적 작업의 되돌림 경로 확보 |
| G5 | **push preview** — 푸시 전 outgoing 커밋 목록과 각 커밋 diff 를 그 자리에서 검증 | "무엇을 밀고 있는지" 확인 후 실행 |
| G6 | **인터랙티브 리베이스 GUI** — pick/reword/squash/fixup/drop + 드래그 순서 변경 | VSCode·Git Graph 모두 터미널로 위임 |
| G7 | **취소 가능한 job** — jobId 발급 → line stream → SIGTERM 취소, repo별 독립 | 긴 fetch/push 를 중단 가능 |
| G8 | **History for Selection** (`git log -L`) — 선택한 코드 범위만의 히스토리 | IntelliJ 시그니처. 양쪽 다 없음 |
| G9 | **annotate previous revision 연쇄** — blame → 라인 → 그 이전 시점 blame 재귀 | 코드 고고학 |
| G10 | **브랜치 즐겨찾기 + prefix 그룹핑 + 검색** | 수백 브랜치 환경에서 탐색 가능성 |
| G11 | **영향 범위 사전 표시** — 머지 전 ff 가능 여부·충돌 예상, 리베이스 전 영향 커밋 수 | 실행 전 예측 |
| G12 | **stale 응답 가드** — repo 전환 후 이전 요청 응답이 새 화면을 덮지 않음 | 멀티 리포의 필연적 요구 |

### 2.4 Git Graph 가 가진 것 중 가져올 만한 것

| # | 기능 | 비고 |
|---|---|---|
| GG1 | 커밋 우클릭 컨텍스트 메뉴 6종 — `branch`/`commit`/`remoteBranch`/`stash`/`tag`/`uncommittedChanges` 각각의 액션 집합이 명확히 분리 | 그래프 조작의 표준 어휘. 그대로 채택 가치 있음 |
| GG2 | 커밋 mute — 비-조상 커밋·머지 커밋을 흐리게 | 그래프 가독성 |
| GG3 | 그래프 색·스타일 커스터마이즈 | dongminal 은 테마 44종 보유 → 궁합 좋음 |
| GG4 | Code Review 추적 — 리뷰 세션 중 읽은 파일 표시 | dongminal 의 에이전트 리뷰 워크플로우와 접점 |
| GG5 | 키보드 단축키(find/refresh/scrollToHead/scrollToStash) | dongminal 은 이미 단축키 설정 체계 보유 |

### 2.5 Git Graph 컨텍스트 메뉴 액션 (원문 그대로)

```
branch            : checkout, rename, delete, merge, rebase, push, createPullRequest,
                    createArchive, selectInBranchesDropdown, unselectInBranchesDropdown, copyName
commit            : addTag, createBranch, checkout, cherrypick, revert, drop, merge,
                    rebase, reset, copyHash, copySubject
remoteBranch      : checkout, delete, fetch, merge, pull, createPullRequest,
                    createArchive, selectInBranchesDropdown, unselectInBranchesDropdown, copyName
stash             : apply, createBranch, pop, drop, copyName, copyHash
tag               : viewDetails, delete, push, createArchive, copyName
uncommittedChanges: stash, reset, clean, openSourceControlView
```

---

## 3. dongminal 접합면 분석

### 3.1 dongminal 은 무엇인가 — 제약의 출발점

dongminal 은 **브라우저 기반 터미널 멀티플렉서**다. IDE 도 Git GUI 도 아니다.
이 정체성이 이식 가능한 것과 불가능한 것을 가른다.

| dongminal 사실 | Git 기능에 미치는 영향 |
|---|---|
| 프론트가 **vanilla JS** (React 없음, 5,002줄) | gitMaster 의 React 34k 줄은 **재사용 불가**. 로직·argv·파서 설계만 참조 |
| 백엔드가 **Go** | gitMaster `git-core`(TS)는 **참조 자료**. Go 로 재구현 |
| **모바일 UI 지원** (`mobile-only` 클래스, keybar, pane nav) | 3분할 로그 패널·모달 diff 는 모바일 대응 설계 필수 |
| **다중 창·분할 칸·탭** + `workspace.json` 영속 + SSE 브로드캐스트 | Git 패널도 창 간 동기화 대상. 탭 상태를 어디까지 영속할지 결정 필요 |
| **테마 44종** (CSS 변수 `--bg`/`--accent`/…) | 그래프 레인 색을 테마 토큰에서 파생해야 함 (하드코딩 금지) |
| **에이전트 오케스트레이션이 정체성** (`dmctl`, Run, activity, attention) | **여기가 dongminal 고유 차별화 지점** — §3.3 |
| **이미 git worktree 를 씀** (`internal/worktree`, Run 격리) | 멀티 워크트리 상태 표시는 자연스러운 확장 |

### 3.2 붙일 수 있는 자리 (코드 근거 있음)

```
① 새 탭 타입 'git'                     ← web/js/app.js:1242 addTab(rid, type, opts)
   선례: 'terminal' | 'editor'(Monaco) | 'markdown'
   분할 칸 안에 Git 패널이 들어감. 터미널과 나란히 배치 가능.

② 서버 API 라우트                       ← internal/server/handlers_api.go:151 apiRoutes
   {http.MethodGet, exactPath("/api/git/status"), (*Server).apiGitStatus} 형태로 추가

③ git 실행 래퍼                         ← internal/worktree/worktree.go:83 execGit
   Runner 주입·타임아웃·안전 가드 패턴이 이미 확립. 이를 일반화해 internal/git 신설

④ 커맨드 브로드캐스트                    ← internal/server/server.go:104 /api/commands
   선례: edit → openEditorTab. 동일하게 openGitTab 액션 추가

⑤ 헬퍼 CLI                             ← internal/runtimebin/ multi-call
   터미널에서 `git-panel` 또는 `dmctl git` 로 탭 열기

⑥ 상태바 항목                           ← web/index.html:49 #status-bar, #sb-items
   현재 브랜치·dirty·ahead/behind chip

⑦ SSE 이벤트                            ← 선례: tool_attention, tool_activity
   git_status_changed / git_job_event (진행률 line stream)
```

### 3.3 dongminal 고유 기회 — 레퍼런스 어디에도 없는 것

dongminal 에는 세 레퍼런스가 갖지 못한 맥락이 있다. **이것이 단순 이식 대신
dongminal 판 Git 을 만들 이유다.**

| # | 기회 | 근거 |
|---|---|---|
| D1 | **에이전트가 조작하는 Git** — `dmctl git status/diff/commit` 로 에이전트가 구조화된 git 상태를 얻고, 사람은 같은 상태를 GUI 로 본다 | 기존 `dmctl` 접합면 패턴 (`read-screen`/`send-input`/`activity`) |
| D2 | **Run × Git 교차 뷰** — 여러 에이전트가 worktree 에서 병렬 작업할 때, 어느 Run 이 어느 브랜치/워크트리에서 무엇을 바꿨는지 한 화면 | `internal/run`, `internal/worktree`, `runs.json` |
| D3 | **터미널과 나란한 Git 패널** — 분할 칸 왼쪽 터미널, 오른쪽 Git. Electron 앱도 IDE 도 못 주는 배치 자유도 | dongminal 분할 칸 구조 |
| D4 | **에이전트 작업의 사후 검토** — 에이전트가 만든 diff 를 사람이 hunk 단위로 승인/폐기 | Git Graph 의 Code Review(GG4) + partial staging 결합 |
| D5 | **모바일에서 git 상태 확인** — 외출 중 에이전트 진행 상황을 폰으로 확인 | dongminal 모바일 모드 |

### 3.4 이식 난이도 평가

| 기능군 | 난이도 | 근거 |
|---|:--:|---|
| status / stage / unstage / commit | 낮음 | `status --porcelain=v2 -z` 파싱 + `add`/`reset`. Go 표준 라이브러리로 충분 |
| 로그 리스트 + 페이징 | 낮음 | `log --pretty=format:... -z --parents --skip --max-count` |
| **DAG 레인 레이아웃** | **중간** | 부모 관계 → 레인 배치 알고리즘 자체 구현. gitMaster `features/log`(3,067줄) 참조 |
| diff 파싱 + word-level 하이라이트 | 중간 | unified diff 파서 + 공통 prefix/suffix 트리밍. gitMaster `diff-engine` 설계 참조 |
| **hunk 단위 partial staging** | **중간~높음** | `apply --cached --unidiff-zero -` + 실패 시 index/worktree 원본 보존 |
| branch / tag / stash 조작 | 낮음 | 대부분 단순 argv |
| fetch/pull/push + **취소 가능한 job** | 중간 | 프로세스 관리 + SSE line stream. dongminal PTY 관리 경험 재사용 가능 |
| **3-way merge editor** | **높음** | 에디터 3분할 + 충돌 마커 편집. Monaco 재사용 가능하나 상당한 작업 |
| **인터랙티브 리베이스 GUI** | **높음** | `GIT_SEQUENCE_EDITOR` 를 dongminal 로 후킹하는 설계 필요 |
| 멀티 리포 일괄 조작 | 중간 | concurrency 제한 + 결과 표. Go 동시성으로 자연스러움 |
| 통합 Console | 낮음 | git 실행 래퍼가 단일 지점이면 자동으로 수집됨 (§4.2) |
| blame / file history | 낮음~중간 | `blame -p` 파싱 + Monaco gutter 데코레이션 |

---

### 3.5 확정 설계 (2026-08-25 인터뷰 결과)

§5 의 결정 중 UI·감지 관련 항목이 해소됐다. 아래는 확정 사항이며, SRS 의 입력이 된다.

### 3.5.1 Git 은 탭이 아니라 **창(window)** 이다

| 결정 | 내용 |
|---|---|
| 형태 | dongminal **창** 타입. `ws.windows[]` 에 `type:'git'` |
| 개수 | **워크스페이스 전체에 1개** (싱글턴) |
| 진입 | 좌측 사이드바의 GIT 섹션 |

검토 경로와 기각 사유:

- **우측 사이드 패널** — 260px 고정이라 6개 표면을 수용하지 못하고, 기존 Agents 패널과
  자리를 다툰다. 무엇보다 dongminal 은 분할 칸이 있어 "에디터 영역을 잃지 않으려고
  사이드바를 두는" VSCode 의 전제가 성립하지 않는다.
- **일반 탭** — 창마다·칸마다 중복 생성돼 "지금 Git 이 어디 열려 있는지" 를 잃는다.
  폴링도 중복된다. 싱글턴 제약을 걸 거라면 그것은 탭이 아니라 창의 성질이다.
- **창** — 채택. 터미널 창의 공간을 전혀 뺏지 않고, 창 전체 폭을 쓰므로 side-by-side
  diff 와 DAG 그래프가 여유롭다. 창 전환 단축키(`Ctrl+Shift+[`/`]`)가 이미 있다.

동시 관찰(터미널 + Git)은 **강제하지 않되 막지도 않는다** — Git 창을 특수 창이 아닌
일반 창으로 두면 그 안에서 분할해 터미널을 배치할 수 있다.

### 3.5.2 좌측 사이드바 — 진입점 겸 리포 전환

```
┌──────────────┐
│ WINDOWS      │
│ ○ Win 1      │
│ ○ Win 2      │
│ + New   ★    │
├──────────────┤
│ GIT        ● │
│ ⟳ dongminal ³│  ← 포커스 칸 cwd 로 자동 결정 (follow)
│ 📌 gitmaster │  ← 사용자가 고정한 리포 (workspace.json 영속)
│ 📌 gbus-trkr │
│ + Add        │  ← 수동 추가
├──────────────┤
│ ⚙            │
└──────────────┘
```

- **클릭** → Git 창으로 전환 + 그 리포 표시
- 리포 목록의 `⟳` 항목은 **터미널 cwd 추적으로 공짜로 얻는다** (`s.Tools.Cwd(toolID)`).
  gitMaster 가 수동 등록 + 디스크 스캔(`REPO-FR-004/005`: `node_modules` skip 등)으로
  푸는 문제를 dongminal 은 스캔 없이 해결한다.
- 이 구조가 §5 Q2(리포 스코프)의 "cwd follow vs 핀" 을 함께 해소한다 — follow 는 `⟳`,
  고정은 `📌` 이며 창 헤더에 별도 핀 토글이 필요 없다.
- 사이드바는 현재 `.sb-title` + 목록(`#windows{flex:1}`) 구조이므로 섹션 추가는 공간
  배분 조정 수준이다. 항목이 많아지면 섹션 접기 또는 `max-height` + 스크롤.

### 3.5.3 Git 창 내부 — 고정 탭

```
[Changes⁴] [Diff] [History] [Branches] [Stash] [Console]
```

**모두 고정 탭이다. 생성·삭제되지 않는다.** 자리가 항상 같아 근육 기억이 서고,
탭 관리 부담이 없다 (IntelliJ Git tool window 구조). 뒤 셋은 후속 단계로 미루되
자리는 처음부터 이 구조로 잡는다.

#### Changes — 일상 작업

```
├──────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────┐                   │
│ │ feat: git 창 추가                       │   ☐ amend         │ ← 고정 영역
│ │                                        │   [ Commit  ▾ ]   │   스크롤 무관
│ └────────────────────────────────────────┘                   │
├──────────────────┬───────────────────────────────────────────┤
│ ▾ Staged (1)     │                                           │
│   M internal/git │   diff 미리보기                            │
│ ▾ Changes (2)    │   (좁으면 Monaco 가 자동 inline 전환)      │
│   M app.js  ←    │                                           │
│ ▾ Untracked (0)  │                                           │
│   ⋮ (스크롤)      │                                           │
└──────────────────┴───────────────────────────────────────────┘
```

- **커밋 영역은 상단 고정** — 파일이 많아 스크롤할 때 커밋 버튼을 찾아 내려가지 않는다.
  창 전체 폭(커밋은 리포 전체에 대한 행위). 메시지는 기본 2줄, auto-grow, 리사이즈 가능.
- `amend` 만 체크박스로 노출, `signoff`·`no-verify` 는 `Commit ▾` 드롭다운.

#### Diff — 창 전체 폭

```
│ ‹ ›  app.js  (2/3)   [side-by-side ▾] [☐ 공백무시]           │
├───────────────────────────────┬──────────────────────────────┤
│  132  const a                 │  132  const a                │
│ -133  old()                   │ +133  new()                  │
```

상단 `‹ ›` 파일 네비게이션이 고정 탭의 유일한 약점(목록과 diff 를 오가는 번거로움)을
없앤다 — 다음 파일을 보려고 Changes 로 돌아가지 않는다.

#### History — 그래프에 세로를 넉넉히

```
┌────────┬─────────────────────────────────────────────────────┐
│ Refs   │ ● abc123  feat: git 창 추가            dy    2h     │
│ ▾local │ │● def456  fix: 폴링 주기               dy    3h     │
│  main  │ ├● 789abc  chore: 문서                 dy    5h     │
│ ▾remote├─────────────────────────────────────────────────────┤
│  origin│ abc123  feat: git 창 추가                           │
│ ▾tags  │ ▾ 3 files    M app.js ←   A git.js   M srv.go       │
└────────┴─────────────────────────────────────────────────────┘
```

diff 가 별도 탭이므로 그래프·커밋 상세에 세로를 넉넉히 배분한다.
(내부 세부 — 그래프 렌더링·필터·컨텍스트 메뉴 — 는 미확정)

### 3.5.4 이동 규칙

```
Changes 파일 단일 클릭   → 우측 미리보기 (가볍게 훑기)
Changes 파일 더블클릭    → Diff 탭 (크게 보기)
History 파일 클릭        → Diff 탭
Diff 탭의 ‹ ›            → 같은 목록의 이전/다음 파일
```

VSCode 의 미리보기/고정과 같은 감각이되 **탭이 생성되지 않는다.**
"넓게 보고 싶다" 에 대한 답은 Diff 탭이다 — 그래서 칸 최대화(zoom)를 도입하지 않는다.

### 3.5.5 diff 렌더링 — 이미 가진 자산

`web/js/file-editor.js:5` 가 **Monaco Editor 0.56.0 전체 번들**을 로드한다
(`vs/editor/editor.main`). `monaco.editor.createDiffEditor` 가 포함돼 있고,
**VSCode 의 diff 뷰어가 바로 이것**이다. 새로 만들지 않고 있는 것을 쓴다.

| 옵션 | 값 | 근거 |
|---|---|---|
| `renderSideBySide` | `true` | 기본 좌우 비교 |
| `useInlineViewWhenSpaceIsLimited` | `true` | 폭이 좁으면 **자동 inline 전환** (monaco.d.ts 명시) |
| `renderSideBySideInlineBreakpoint` | `900` | 전환 기준 폭 |
| `hideUnchangedRegions` | `{enabled:true}` | 변경 없는 구간 접기 |
| `ignoreTrimWhitespace` | `false` (Monaco 기본 `true`) | git 의미와 맞춤. "공백 무시" 는 토글로 노출 |

부수 효과: **gitMaster 의 `@gitmaster/diff-engine`(word-level 하이라이트 자체 구현)이
불필요해진다.** §3.4 에서 "중간 난이도" 로 잡았던 diff 뷰어가 배선 작업으로 내려간다.
테마도 이미 연동돼 있다 (`monaco.editor.defineTheme('dongminal', …)`).

제약은 CDN 의존이나, 내장 편집기가 이미 그 위에 있으므로 **새로 생기는 제약은 아니다.**

### 3.5.6 모바일 — 전 기능

데스크톱과 동일한 기능 범위. 단 파괴적 조작(force push, discard, 브랜치 삭제)은
**데스크톱보다 강한 확인 단계**를 적용한다 — 좁은 화면과 터치 오조작 위험 때문이다.
gitMaster 의 2단계 확인 + recovery hint(G3/G4) 정책을 모바일에서 더 엄격히 건다.

---

### 3.5.7 History 탭 세부 (N1)

#### 그래프 렌더링 — 행별 인라인 SVG

두 레퍼런스가 같은 기법으로 수렴한다. Git Graph 는 `createElementNS` 12회 · `svg` 111회 ·
`path` 55회로 SVG 를 쓰고(Canvas 는 사실상 미사용), gitMaster 도 "small SVG at each row
position" 이다.

**SVG 를 채택한다.** 근거:

- 레인 색을 CSS 변수(`--gm-*` 대신 dongminal 테마 토큰)로 직접 물릴 수 있다
- **행별 SVG 라 가상 스크롤과 궁합이 맞다** — 보이는 행만 DOM 에 있으면 된다
- Canvas 는 가상 스크롤 시 재그리기 범위 관리가 추가 복잡도다

#### 레인 레이아웃 알고리즘 — gitMaster `laneLayout.ts` 이식

`apps/desktop/src/renderer/features/log/laneLayout.ts` (130줄)가 완결된 구현이며
**TypeScript 라 dongminal 의 vanilla JS 로 거의 그대로 옮겨진다** (타입 주석 제거 수준).
§4.1 "React 34k 줄은 재사용 불가" 의 예외다.

단일 forward pass 로 동작한다:

```
activeLanes[i] = 그 레인이 예약된 부모 해시 (없으면 null)

각 커밋에 대해:
  1. 자기 레인 찾기 — 이미 예약된 레인, 없으면 첫 빈 슬롯 (없으면 새 레인)
  2. 그 슬롯을 비우고 부모들에게 재할당
     - 첫 부모: 커밋의 레인을 상속
     - 나머지 부모: 새 빈 슬롯 (이미 예약돼 있으면 머지 엣지만 기록)
  3. passThrough = 처리 전후 모두 활성이면서 자기 레인이 아닌 레인
     → 이 행을 세로선으로 통과
  4. 꼬리의 빈 레인 trim
```

행별 산출물 `LaneRow{ hash, lane, passThrough[], parentLanes[], isNewHead, laneCount }`
가 SVG 한 조각을 그리기에 충분하다.

`isNewHead` 는 브랜치 머리에서 위쪽 진입선을 생략해 그래프를 깔끔하게 만든다 —
직접 구현했다면 놓쳤을 세부다.

#### 레인 색 — 테마에서 파생 (하드코딩 금지)

Git Graph 는 9색을 하드코딩한다(`graph.colours`). **dongminal 은 테마가 44종이므로
그 방식을 쓸 수 없다.** 현재 테마의 terminal 팔레트에서 순환 배열을 구성한다:

```
blue → magenta → green → yellow → cyan → red → brightBlue → brightMagenta → brightGreen
```

`web/js/helpers.js` 의 `pickAttnColor(t)` 가 이미 "팔레트에서 조건에 맞는 색을 고르는"
선례다. 레인 색도 같은 자리에 둔다.

레인 상한 초과 시 압축 표식을 표시한다 (`LOG-FR-012`).

#### 커밋 상세 — 인라인 펼침

Git Graph 의 `commitDetailsView.location` **기본값이 `Inline`** 이다
(`Docked to Bottom` 은 선택지). 우리 구조에도 인라인이 맞다 — 하단 고정 영역을 두지
않으므로 **그래프가 세로를 온전히 쓴다.**

```
│ ● abc123  feat: git 창 추가                     dy    2h │
│ ▼ ┌────────────────────────────────────────────────────┐ │  ← 클릭한 행 아래 펼침
│   │ abc123f  parent def456                             │ │
│   │ feat: git 창 추가                                   │ │
│   │ ▾ 3 files   M app.js ←   A git.js   M srv.go       │ │
│   └────────────────────────────────────────────────────┘ │
│ │● def456  fix: 폴링 주기                        dy    3h │
```

파일 클릭 → Diff 탭 (§3.5.4 이동 규칙).

#### 컬럼 구성과 반응형

Git Graph `defaultColumnVisibility` = `{Date:true, Author:true, Commit:true}` 를 따른다.

| 컬럼 | 좁아질 때 |
|---|---|
| 그래프 | 항상 표시 |
| 메시지 + ref 배지 | 항상 표시 (flex) |
| Author | 3순위로 숨김 |
| Date | 2순위로 숨김 |
| Commit(해시) | **1순위로 숨김** |

모바일에서는 그래프 + 메시지만 남는다. 레인 수도 상한을 낮춘다.

#### 페이징 — Git Graph 검증값 채택

| 항목 | 값 | 출처 |
|---|---|---|
| 초기 로드 | **300** | `repository.commits.initialLoad` |
| 추가 로드 | **100** | `repository.commits.loadMore` |
| 자동 로드 | **true** (스크롤 하단 도달 시) | `loadMoreAutomatically` |
| 커밋 순서 | `date` (선택: `author-date`, `topo`) | `repository.commits.order` |

가상 스크롤은 행 높이 고정으로 인덱스 계산한다 (`LOG-FR-002`).

#### 기본 표시 항목

Git Graph 기본값을 따른다 — remote 브랜치 ○, 태그 ○, uncommitted changes 행 ○,
stash ○, 비-조상 커밋 mute ✗.

uncommitted changes 행은 S4 컨텍스트 메뉴(stash/reset/clean/Changes 탭 열기)를 갖는다.

#### 필터 (상단 바)

```
[ref ▾]  [🔍 검색            ]  [author ▾] [date ▾] [path ▾]   ⟳
```

- 텍스트 검색은 **loaded 모드와 query 모드를 명시적으로 구분**한다 (`LOG-FR-020`) —
  로드된 300개 안에서 찾는 것과 `git log --grep` 으로 다시 묻는 것은 결과가 다르므로,
  어느 쪽인지 사용자에게 보여야 한다. gitMaster 가 짚은 함정이다.
- author/date 는 가능하면 git log 옵션으로 내려보낸다 (`LOG-FR-022`)
- path 필터는 `git log -- <path>` (`LOG-FR-021`)

---

## 4. 설계 관점 권고

### 4.1 재사용 가능한 것 / 아닌 것

```
gitMaster 에서 가져올 것:
  ✔ git argv 설계 (docs/requirements/features/*.md §3.1.3 표)
  ✔ 파서 로직 (status v2, log, blame, branchList, nameStatus, submoduleStatus)
  ✔ 안전 정책 (preflight, recovery hint, 2단계 확인, stale guard)
  ✔ 요구사항 식별자 체계 (IEEE 29148 SRS 구조)
  ✘ React 컴포넌트 (34k 줄) — vanilla JS 재구현
  ✘ Electron IPC / Zod 계약 — HTTP + SSE 로 치환
  ✘ IndexedDB 저장 — workspace.json / settings.json 으로 치환
```

### 4.2 git 실행을 단일 지점으로 (Console 이 공짜로 따라온다)

`internal/worktree/execGit` 의 Runner 패턴을 `internal/git` 로 일반화하고,
**모든 git 실행이 이 한 지점을 통과**하게 하면:

- 통합 Console(G2)은 이 지점에서 argv·cwd·exitCode·duration·stderr 를 기록하기만 하면 된다
- destructive 판정(2단계 확인)도 같은 지점에서 argv 패턴으로 가능
- 취소 가능한 job(G7)도 여기서 `CommandContext` + SIGTERM
- 테스트가 Runner 주입으로 결정론적이 된다 (기존 `worktree_test.go` 선례)

**단일 실행 지점이 G2·G7·안전 정책 3개를 동시에 해결한다.** 설계 우선순위 1순위.

### 4.3 안전 원칙 — dongminal 은 이미 이 원칙을 갖고 있다

`internal/worktree/worktree.go` 주석:

> **저장소에서 파일시스템을 파괴할 수 있는 유일한 경로다.** 그래서 이 패키지의
> 규칙은 대부분 "무엇을 하지 않는가"로 되어 있다 — dirty 트리를 지우지 않고,
> 등록 범위 밖을 건드리지 않으며, 지우지 못한 것을 조용히 넘기지 않는다.

gitMaster 의 preflight(G3)·recovery hint(G4)·2단계 확인은 **같은 철학**이다.
dongminal 의 기존 원칙을 Git 영역으로 확장하는 것이지, 새 원칙 도입이 아니다.

### 4.4 단계 제안 (초안 — §5 결정 후 확정)

| 단계 | 내용 | 산출 가치 |
|---|---|---|
| 0 | `internal/git` 단일 실행 지점 + status/log/diff 읽기 API + `git` 탭 타입 골격 | 읽기 전용 Git 뷰. 안전 |
| 1 | 변경 파일 트리 + 파일 단위 stage/unstage/discard + 커밋(비모달) + preflight + undo 토스트 | 일상 작업의 8할 |
| 2 | diff 뷰어(side-by-side/unified, word-level) + hunk partial staging | 커밋 품질 |
| 3 | 로그 + DAG 그래프 + 커밋 컨텍스트 메뉴(Git Graph 어휘) + 필터 | 히스토리 읽기 |
| 4 | branch/tag/stash 패널 + 즐겨찾기·그룹핑 | 참조 관리 |
| 5 | fetch/pull/push + push preview + 취소 가능 job + 상태바 chip | 원격 동기화 |
| 6 | 통합 Console + blame + file history | 관측·고고학 |
| 7 | (선택) 멀티 리포 · 3-way merge · 인터랙티브 리베이스 · Run×Git 교차 뷰 | 고급·차별화 |

각 단계는 독립적으로 유용하며, 앞 단계 없이 뒤 단계가 서지 않는다.

---

### 4.5 변경 감지 전략 (실측으로 확정)

**결론: `git status` 폴링. fsnotify·fsmonitor·git hooks 모두 채택하지 않는다.**

#### 4.5.1 레퍼런스 구현 실사

| | 워킹 트리 감시 | `.git` 감시 | 폴링 | 전제 |
|---|:--:|:--:|:--:|---|
| VSCode | ● 재귀 `**` | ● | 없음 | **IDE 코어 watcher 를 공유** — 확장이 자기 watcher 를 만들지 않는다 |
| gitMaster | **✗ 포기** | ● chokidar 12 경로 | 30초 signature | 독립 앱. watcher 비용을 자기가 진다 |
| dongminal | 폴링 1s | signature 500ms | ○ | 독립 앱 **+ 터미널·에이전트·포커스 신호 보유** |

VSCode 근거 (`dist/main.js`):

```js
let m = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(repo.root), "**"));
let p = We(fi(m.onDidChange, m.onDidCreate, m.onDidDelete),
           y => !/\.git($|\\|\/)/.test(hl(repo.root, y.fsPath)));   // .git 제외 = 워킹 트리
```

gitMaster 근거 (`apps/desktop/src/main/watchers/repoWatcher.ts`):

```js
function getGitWatchRoots(gitDir) {
  return [ HEAD, index, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, ORIG_HEAD,
           FETCH_HEAD, packed-refs, refs, logs, rebase-merge, rebase-apply ];  // 전부 .git/ 내부
}
const DEFAULT_POLL_INTERVAL_MS = 30000;
```

**gitMaster 는 외부 에디터의 워킹 트리 수정을 감지하지 않는다.** 레퍼런스 어느 쪽도
dongminal 상황(IDE 아님 + watcher 인프라 없음)의 답을 주지 않는다.

#### 4.5.2 비용 실측 (2026-08-25, darwin/arm64, git 2.50.1)

| 리포 | 추적 파일 | 워킹 트리 | `git status --porcelain=v2 -z` | signature (2 syscall) |
|---|---:|---:|---:|---:|
| dongminal | 286 | 914 | 9.5 ms | 0.020 ms |
| gitmaster | 284 | 284 | 11.5 ms | 0.022 ms |
| gbus-tracker | 85 | 63,423 | 8.9 ms | 0.026 ms |
| 합성 | 20,000 | 20,000 | 30.2 ms | — |
| 합성 + `core.fsmonitor=true` | 20,000 | 20,000 | **30.0 ms** | — |

관측 사실:

- **`git status` 는 10 ms 내외다.** 1초 폴링 = CPU 1% 미만. 20,000 파일에서도 3%.
- **gitignore 된 파일은 비용이 아니다.** gbus-tracker 는 워킹 트리 63,423 파일이지만
  git 이 `node_modules` 를 통째로 건너뛰어 8.9 ms 다. 범용 watcher 가 감당해야 할 그
  63,000 파일이 git 에게는 존재하지 않는다.
- **fsmonitor 는 이 규모에서 이득이 없다 (1.0배).** index 로드가 지배적이라 감시
  데몬이 줄일 것이 없다. 값어치는 추적 파일 수십만 개 규모부터다.
- **signature 는 status 보다 500배 싸다.** `.git` 상태 변화는 사실상 공짜로 감지된다.

#### 4.5.3 라이브러리 검토 결과 (모두 기각)

Go 표준 라이브러리와 `golang.org/x/` 에는 파일 감시 API 가 **없다** (GOROOT/src 확인).
후보 2종 모두 서드파티다.

| 라이브러리 | 방식 | 유지보수 | macOS | gitignore | 외부 에디터 atomic save |
|---|---|---|---|---|---|
| `radovskyb/watcher` | **폴링 100ms** (OS 이벤트 미사용이 설계 의도) | **2019-08 중단** (v1.0.7) | 트리 전체 stat | ✗ | ○ |
| `fsnotify/fsnotify` | kqueue(darwin)/inotify(linux) | 활발 | **파일당 FD** | ✗ | **✗ watch 유실** |
| `git status` 폴링 | 폴링 1s | git 본체 | 10 ms | **○** | ○ |

기각 사유:

- `radovskyb/watcher` 는 **그 자체가 폴링**이다. `.gitignore` 를 모르므로 `git status`
  폴링보다 비싸다. 게다가 7년째 유지보수가 없다.
- `fsnotify` 는 darwin 에서 kqueue 이므로 **감시 파일 수만큼 FD 를 소모**하고,
  **재귀 감시를 지원하지 않으며**(하위 디렉터리를 직접 등록해야 한다),
  **atomic save(temp write → rename)에서 watch 가 유실**된다. VSCode·vim·IntelliJ 가
  정확히 그 방식으로 저장하므로, 하필 우리가 잡으려는 케이스에서 가장 취약하다.
- `git status` 가 이기는 이유는 **git 이 이미 최적화된 파일시스템 스캐너**이기
  때문이다. `.gitignore`·index·untracked cache 를 아는 코드다.

git hooks(`reference-transaction`, `post-checkout` 등)도 기각한다 — 워킹 트리 수정을
원리적으로 잡지 못하고, 리포마다 `.git/hooks/` 에 파일을 심어야 해서 사용자 기존 훅과
충돌하며, dongminal 의 "설정 무오염" 원칙에 반한다. 폴링이 어차피 같은 케이스를 잡는다.

#### 4.5.4 확정 구조

```
① 즉시 신호 (지연 0, 비용 0) — dongminal 만 가진 것
     precmd 셸 훅 · 에이전트 hook · POST /api/file/write · 브라우저 포커스/가시성
        ↓ 150ms 디바운스 + single-flight
② signature 폴링 500ms — read(HEAD) + stat(index) + stat(ref), 0.02ms
     브랜치 전환 · 커밋 · 스테이징 · 머지/리베이스 진행 상태
        ↓ 변했을 때만
③ status 폴링 1s — git status --porcelain=v2 -z, 10ms
     워킹 트리 수정. 패널이 보일 때만. 창 백그라운드 / 패널 닫힘 → 완전 정지
```

브라우저 포커스 신호(`visibilitychange`/`focus`/패널 열기/`mouseenter`)가 핵심이다.
**사용자가 보고 있지 않을 때는 최신일 필요가 없다.** 외부 에디터에서 고치고 dongminal
로 돌아오는 순간 갱신되므로 체감 지연이 0 이고, 폴링은 "보면서 동시에 다른 창에서
편집하는" 경우만 담당한다.

#### 4.5.5 열어 둔 문

지연 0 이 실제로 필요해지면 갈 길은 fsnotify 가 아니라 **macOS FSEvents 직접 호출**이다.
FD 하나로 재귀 감시가 되고, `internal/sysstat` 의 cgo 격리 패턴
(`//go:build darwin && cgo` + nocgo 폴백)이 이미 확립돼 있어 외부 의존성이 0 이다.
CFRunLoop 수명 관리 비용이 있으므로 지금 착수하지 않는다. ①②③ 구조를 바꾸지 않고
"신호원 하나 추가"로 끼워 넣을 수 있는 자리다.

---

## 5. 결정 사항 현황

### 5.1 해소됨 (2026-08-25 인터뷰)

| # | 결정 | 결과 | 근거 |
|---|---|---|---|
| Q1 | UI 형태 | **Git 창(window), 워크스페이스 1개** | §3.5.1 — 패널·탭 모두 검토 후 기각 |
| Q2 | 리포 스코프 | **단일 리포. 좌측 GIT 섹션에서 `⟳` follow + `📌` 고정** | §3.5.2 — cwd 추적으로 스캔 불필요 |
| Q5 | 터미널 git 과의 관계 | **GUI 가 완전한 조작 표면** | 모바일 전 기능 결정과 일관 |
| Q6 | 모바일 지원 수준 | **전 기능 + 강화된 파괴적 조작 확인** | §3.5.5 |
| — | 변경 감지 | **`git status` 폴링. 라이브러리 미도입** | §4.5 — 실측 근거 |
| — | diff 렌더링 | **Monaco DiffEditor (기존 자산)** | §3.5.5 |
| — | 칸 최대화(zoom) | **도입하지 않음** | Diff 탭이 그 역할을 대신 |

### 5.2 해소됨 (2차)

| # | 결정 | 결과 |
|---|---|---|
| Q3 | **MVP 범위** | **M1~M5 = P0 38개 전부.** "GUI 로 git 을 쓸 수 있다" 가 한 번에 성립 |
| Q4 | 에이전트 접합 (`dmctl git`) | **MVP 밖. 단 설계 제약으로 반영** — 모든 기능이 `/api/git/*` 를 통과하면 `dmctl git` 은 그 위의 얇은 CLI 가 된다 (기존 `read-screen`/`activity` 와 동일 패턴). CLI 자체는 이후 |
| Q7 | 고난도 3종 | 3-way merge · 인터랙티브 rebase 는 **MVP 후 재평가**. 멀티 리포는 §3.5.1 단일 리포 확정으로 **범위 밖** |
| N1 | History 탭 세부 | §3.5.7 |
| N2 | 표면 지도 전수 매핑 | `./GIT_SURFACE_MAP.md` |

### 5.2.1 MVP 마일스톤 (P0 38개 분할)

의존 순서다. 앞선 것 없이 뒤가 서지 않는다.

| 마일스톤 | 내용 | P0 |
|---|---|---:|
| **M1 읽기** | `internal/git` 단일 실행 지점 + 감지 3계층(§4.5), Git 창 골격, 좌측 GIT 섹션, Changes 파일 목록 3그룹, Diff 미리보기·Diff 탭(Monaco), 상태바 chip | ~12 |
| **M2 커밋** | stage/unstage(파일·그룹), discard + recovery hint + 2단계 확인, 커밋 메시지·amend·Commit, preflight 차단, 충돌 파일 표시 | ~9 |
| **M3 원격** | Fetch / Pull / Push (헤더 툴바, 기본 동작) | ~3 |
| **M4 히스토리** | History 탭 — 커밋 리스트 + DAG 그래프 + refs 사이드바 + 커밋 상세 인라인 + 커밋 우클릭 | ~8 |
| **M5 참조** | Branches / Stash 탭, 브랜치 checkout, stash apply/pop, 브랜치·stash 생성 다이얼로그 | ~7 |

**M1 은 파괴적 동작이 하나도 없다** — 안전하게 착수할 수 있는 지점이다.

### 5.3 표면 구조 (§3.5 확정에 따른 갱신)

VSCode Git 명령 183개, gitMaster MVP 약 50개는 **하나의 표면에 담기지 않는다.**
6개 표면으로 분배하며, 이 분배는 세 레퍼런스가 수렴한 형태다.

| # | 표면 | 담는 것 |
|---|---|---|
| S1 | **Changes 탭** | 리포·브랜치 헤더, ahead/behind, 변경 파일 트리, stage/unstage/discard, 커밋 메시지·옵션 |
| S2 | **Diff / History / Console 탭** | diff(전체 폭), 로그+DAG 그래프, git 실행 로그 |
| S3 | **Branches / Stash 탭** | 브랜치·태그·스태시 목록과 조작 |
| S4 | **컨텍스트 메뉴** | 커밋/브랜치/원격브랜치/스태시/태그/미커밋변경 각각의 액션 (§2.5 Git Graph 어휘) |
| S5 | **다이얼로그** | push preview, merge 옵션, reset 모드, 태그 생성, 파괴적 작업 2단계 확인 |
| S6 | **상태바 chip** | 브랜치, dirty 수, conflict 경고, 진행 중 job |

**S4 가 규모의 핵심이다.** 커밋 하나에 걸리는 액션이 11개(`addTag`, `createBranch`,
`checkout`, `cherrypick`, `revert`, `drop`, `merge`, `rebase`, `reset`, `copyHash`,
`copySubject`)인데 상시 표시할 자리가 없다. Git Graph 가 기능 대부분을 컨텍스트
메뉴에 넣은 이유다.

---

## 6. 참고 자료

- gitMaster SRS: `~/personal/gitmaster-app-electron-pnpm/docs/requirements/gittool-roadmap-srs.md`
- gitMaster IntelliJ 기능 카탈로그: 같은 저장소 `docs/requirements/intellij-git-features.md` (810줄)
- gitMaster 기능별 SRS: 같은 저장소 `docs/requirements/features/*.md` (13개)
- VSCode Git: `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/package.json`
- Git Graph: `~/.vscode/extensions/mhutchie.git-graph-1.30.0/package.json`
- dongminal 아키텍처: `docs/internal/architecture.md`
- dongminal 탭 타입 선례: `docs/internal/archive/MULTI_TAB_TYPE_SPEC.md`
