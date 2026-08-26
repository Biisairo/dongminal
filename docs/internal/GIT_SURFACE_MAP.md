# Git 기능 표면 지도 (Informative)

> 모(母) 문서: `./GIT_INTEGRATION_ANALYSIS.md` §3.5 확정 설계, §5.3 표면 구조
> 성격: 정보성. 정상 요구사항을 정의하지 않으며, SRS 의 FR 도출 근거로 기능한다.
> 작성일: 2026-08-25

---

## 1. 목적

레퍼런스 3종의 전 기능을 dongminal Git 창의 **6개 표면 중 정확히 하나**에 배치한다.
"이 기능이 어디 들어가지?" 를 매번 재논의하지 않기 위한 단일 참조표다.

## 2. 방법과 정규화 원칙

### 2.1 근거 데이터 (실측 추출)

| 레퍼런스 | 추출 대상 | 결과 |
|---|---|---|
| VSCode Git | `contributes.commands` | 183개 |
| VSCode Git | `contributes.menus` 15개 지점 | 배치 전수 |
| Git Graph | `contextMenuActionsVisibility` | 6종 컨텍스트 메뉴 |
| gitMaster | `docs/requirements/features/*.md` | 13개 도메인 FR |

### 2.2 정규화 원칙

**183개를 그대로 옮기지 않는다.** VSCode 명령 상당수는 명령 팔레트를 위한
조합 폭발이며, GUI 에서는 옵션 UI 로 접힌다.

| 원칙 | 예 | 결과 |
|---|---|---|
| 조합 폭발을 옵션으로 접는다 | `commit` 계열 20개 = `{staged\|all} × amend × signed × noVerify` | **1 동작 + 4 옵션** |
| 플랫폼 분기를 하나로 | `revealFileInOS.{linux,mac,windows}` | 1 |
| 같은 동작의 다른 진입점을 통합 | `checkout` / `graph.checkout` / `repositories.checkout` | 1 |
| 확장 API 는 제외 | `api.getRepositories` 등 3개 | 0 |
| IDE 종속 기능은 제외 | `revealInExplorer`, `openRepositoriesInParentFolders` | 0 |

정규화 후 **약 95개 의미 단위**가 남는다.

### 2.3 우선순위 표기

| 표기 | 기준 |
|---|---|
| **P0** | 이것이 없으면 GUI 로 git 을 쓸 수 없다 |
| **P1** | 자주 쓰지만 없으면 터미널로 대체 가능 |
| **P2** | 고급·저빈도. 터미널 대체가 자연스럽다 |

### 2.4 표면 정의

| # | 표면 | 성격 |
|---|---|---|
| **S1** | Changes 탭 | 상시 보는 작업면. 변경·스테이징·커밋 |
| **S2** | Diff / History / Console 탭 | 넓은 화면이 필요한 읽기면 |
| **S3** | Branches / Stash 탭 | 참조(ref) 목록과 조작 |
| **S4** | 컨텍스트 메뉴 | 대상을 지목했을 때만 나타나는 액션 |
| **S5** | 다이얼로그 | 옵션 선택·확인이 필요한 작업 |
| **S6** | 상태바 chip | 창 밖에서도 보여야 하는 상태 |

---

## 3. 표면별 배치 (구현 참조용)

### S1 — Changes 탭

상단 고정 커밋 영역 + 좌 파일 목록 + 우 diff 미리보기.

| 요소 | 기능 | 우선 | 레퍼런스 근거 |
|---|---|:--:|---|
| 헤더 | 리포명 · 브랜치 · ahead/behind · detached/no-upstream 배지 | P0 | gitMaster `SB-FR-001/002`, `BR-FR-030` |
| 헤더 | **Fetch / Pull / Push 버튼** | P0 | VSCode `scm/title` (툴바에 상시 노출) |
| 헤더 | Sync (pull+push 한 번에) | P1 | VSCode `sync`, `syncRebase` |
| 헤더 | Publish Branch (upstream 없을 때) | P1 | VSCode `publish`, `scm/history/title` |
| 헤더 | 새로고침 | P1 | VSCode `refresh` |
| 헤더 | 리포 전환 드롭다운 (좌측 GIT 섹션과 동일 정보원) | P1 | §3.5.2 |
| 커밋 영역 | 메시지 입력 (multiline, auto-grow, draft 영속) | P0 | `COM-FR-020/021` |
| 커밋 영역 | Commit 버튼 | P0 | VSCode `commit` |
| 커밋 영역 | `amend` 체크박스 | P0 | `commitAmend` 계열 |
| 커밋 영역 | `Commit ▾` → sign-off / no-verify / commit staged / commit all | P1 | `git.commit` 서브메뉴 20개를 옵션으로 접음 |
| 커밋 영역 | commit template prefill | P1 | `COM-FR-022` |
| 커밋 영역 | GPG 서명 상태 표시 | P2 | `COM-FR-024` |
| 커밋 영역 | author override | P2 | `COM-FR-023` |
| 파일 목록 | staged / changes / untracked 3그룹 | P0 | `COM-FR-001`, VSCode resourceGroup |
| 파일 목록 | 파일 단위 stage / unstage | P0 | `stage` / `unstage` |
| 파일 목록 | 그룹 일괄 stage / unstage / discard | P0 | `scm/resourceGroup/context` 11개 |
| 파일 목록 | tracked/untracked 구분 일괄 처리 | P1 | `stageAllTracked`, `cleanAllUntracked` 등 |
| 파일 목록 | partial staged indeterminate 표시 | P1 | `COM-FR-003` (gitMaster 고유) |
| 파일 목록 | 트리/플랫 보기 전환 | P1 | Git Graph `fileView.type` |
| 파일 목록 | 충돌 파일 표시 + 해결 진입점 | P0 | `COM-UI-005` |
| 미리보기 | 선택 파일 diff (Monaco, 자동 inline) | P0 | §3.5.5 |
| 하단 | undo last commit 5초 토스트 | P1 | `COM-FR-040~042`, `undoCommit` |

> **헤더 툴바는 VSCode `scm/title` 에 대응한다.** 옵션이 필요한 변형(force push,
> pull --rebase, fetch --prune 등)은 버튼이 아니라 S5 다이얼로그로 간다 — 버튼은
> 기본 동작만, 변형은 다이얼로그가 담당한다는 규칙이다.

### S2 — Diff / History / Console 탭

#### Diff 탭

| 기능 | 우선 | 근거 |
|---|:--:|---|
| side-by-side ↔ unified 토글 | P0 | `DIFF-FR-001` |
| word-level 하이라이트 | P0 | Monaco 내장 |
| 공백 무시 토글 | P1 | `ignoreTrimWhitespace` |
| `‹ ›` 파일 네비게이션 | P0 | 고정 탭 구조상 필수 (§3.5.4) |
| **hunk 단위 stage / unstage** | P1 | `diff.stageHunk`, `COM-FR-010/011` |
| **line range stage / unstage / revert** | P2 | `stageSelectedRanges` 등 |
| binary / LFS pointer 폴백 | P1 | `DIFF-FR-030/031` |
| 큰 diff truncate + show all | P1 | `DIFF-FR-032` |
| diff 축: working↔staged, staged↔HEAD, working↔HEAD, rev↔rev, commit↔parent | P0/P1 | `DIFF-FR-005~009` |

#### History 탭

| 기능 | 우선 | 근거 |
|---|:--:|---|
| 커밋 리스트 + 가상 스크롤 + 페이징 | P0 | `LOG-FR-001/002` |
| **DAG 그래프 (레인 레이아웃)** | P0 | `LOG-FR-010~012` |
| refs 사이드바 (local/remote/tags) | P0 | `LOG-FR-030/031` |
| 커밋 상세 (메시지 전문·부모·ref) | P0 | gitMaster `F.2.2.4` |
| 커밋의 변경 파일 목록 | P0 | `F.2.2.5` |
| 텍스트 검색 (loaded / query 모드 구분) | P1 | `LOG-FR-020` |
| author / date / path 필터 | P1 | `LOG-FR-021/022` |
| hash / branch / tag 즉시 jump | P1 | `LOG-FR-023` |
| commit range 비교 (`A..B`, `A...B`) | P2 | `LOG-FR-024` |
| 커밋 mute (비-조상 / 머지 커밋) | P2 | Git Graph 고유 |
| reflog 언급 커밋 포함 | P2 | Git Graph 고유 |
| uncommitted changes 행 표시 | P1 | Git Graph `showUncommittedChanges` |
| 다중 커밋 선택 비교 | P2 | `LOG-FR` / `timeline.compareWithSelected` |

#### Console 탭

| 기능 | 우선 | 근거 |
|---|:--:|---|
| 실행된 git argv · cwd · exitCode · duration 수집 | P1 | `CON-FR-001/002` (gitMaster 고유 G2) |
| stdout/stderr 보존 + truncate 표식 | P1 | `CON-FR-003` |
| level 토글 · 텍스트 검색 필터 | P2 | `CON-FR-011/013` |
| argv 복사 / stderr tail 복사 | P1 | `CON-FR-020/021` |
| **replay (동일 argv 재실행)** | P2 | `CON-FR-022/023` — destructive 는 2단계 확인 |

> Console 은 §4.2 "git 실행 단일 지점" 이 서면 **거의 공짜로 따라온다.**

### S3 — Branches / Stash 탭

#### Branches 탭

| 기능 | 우선 | 근거 |
|---|:--:|---|
| local / remote / 즐겨찾기 트리 | P0 | `BR-FR-001` |
| 이름 검색·필터 | P0 | `BR-FR-003` |
| **`/` prefix 그룹핑** | P1 | gitMaster 고유 G10 |
| **즐겨찾기 고정** | P1 | `BR-FR-002` |
| upstream 표시 · set / unset | P1 | `BR-FR-030~034` |
| 다중 선택 일괄 삭제 (`-d` only) | P2 | `BR-FR-040/041` |
| remote 목록 · add / remove | P2 | `addRemote`, `removeRemote` |

#### Stash 탭

| 기능 | 우선 | 근거 |
|---|:--:|---|
| stash 목록 (index·메시지·branch·시각) | P0 | `ST-FR-001` |
| 미리보기 (index/working 분리) | P1 | `ST-FR-003` |
| 메시지/branch 필터 | P2 | `ST-FR-002` |

> Tags 는 별도 탭을 두지 않고 **Branches 탭의 refs 트리**에 포함한다 (VSCode `scm/artifact` 와 동일 취급).

### S4 — 컨텍스트 메뉴

**규모의 핵심.** Git Graph 의 6종 어휘를 채택하고 VSCode `scm/*/context` 로 보강한다.

#### 커밋 우클릭 (History 탭)

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Checkout (detached) | P1 | Git Graph `commit.checkout`, `graph.checkoutDetached` |
| Create Branch from here | P0 | `commit.createBranch`, `branch` |
| Create Tag | P1 | `commit.addTag`, `createTag` |
| Cherry-pick | P1 | `commit.cherrypick`, `graph.cherryPick` |
| Revert | P1 | `commit.revert` |
| **Reset to here** (`--soft`/`--mixed`/`--hard`) | P1 | `commit.reset` → S5 다이얼로그 |
| Merge into current | P1 | `commit.merge` |
| Rebase onto | P2 | `commit.rebase` |
| Drop | P2 | `commit.drop` |
| Compare with (선택/remote/merge-base) | P2 | `graph.compareRef`, `compareWithRemote`, `compareWithMergeBase` |
| Copy hash / subject | P0 | `copyCommitId`, `copyCommitMessage` |

#### 브랜치 우클릭

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Checkout | P0 | `branch.checkout` |
| Create Branch from | P1 | `branchFrom` |
| Rename | P1 | `branch.rename`, `renameBranch` |
| Delete (`-d` / `-D`) | P1 | `branch.delete` → `-D` 는 S5 2단계 확인 |
| Merge into current | P1 | `branch.merge` |
| Rebase onto | P2 | `branch.rebase` |
| Push / Publish | P1 | `branch.push`, `publish` |
| Set / Unset upstream | P1 | `BR-FR-031/032` |
| Copy name | P1 | `branch.copyName` |

#### 원격 브랜치 우클릭

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Checkout (로컬 생성 + 추적) | P0 | `remoteBranch.checkout` |
| Fetch into local | P2 | `remoteBranch.fetch` |
| Pull / Merge | P1 | `remoteBranch.pull`, `merge` |
| Delete remote branch | P2 | `deleteRemoteBranch` → S5 2단계 확인 |
| Copy name | P1 | `remoteBranch.copyName` |

#### 스태시 우클릭

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Apply (`--index` 옵션) | P0 | `stash.apply`, `ST-FR-020/022` |
| Pop | P0 | `stash.pop` |
| Drop | P1 | `stash.drop` → S5 2단계 확인 |
| Branch from stash | P2 | `stash.createBranch`, `ST-FR-040` |
| Copy name / hash | P2 | `stash.copyName/copyHash` |

#### 태그 우클릭

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Checkout (detached 경고) | P1 | `TAG-FR-030/031` |
| Push to remote | P1 | `tag.push`, `TAG-FR-040` |
| Delete (local / remote) | P1 | `tag.delete`, `deleteRemoteTag` → S5 |
| Copy name | P2 | `tag.copyName` |

#### 파일 우클릭 (S1 목록 / History 파일 목록)

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Stage / Unstage | P0 | `scm/resourceState/context` |
| Discard changes | P0 | `clean` → S5 2단계 확인 + recovery hint |
| Open file / Open file (HEAD) | P1 | `openFile`, `openHEADFile` — dongminal 내장 편집기로 |
| Open changes | P0 | `openChange` → Diff 탭 |
| Add to .gitignore | P1 | `ignore` |
| **File history** | P1 | `COM-FR-061` → History 탭 필터 |
| **Blame** | P1 | `COM-FR-060`, `blame.toggleEditorDecoration` |
| Copy path | P2 | — |

#### 미커밋 변경 우클릭 (History 탭의 uncommitted 행)

| 액션 | 우선 | 근거 |
|---|:--:|---|
| Stash | P1 | Git Graph `uncommittedChanges.stash` |
| Reset | P2 | `uncommittedChanges.reset` |
| Clean (untracked 제거) | P2 | `uncommittedChanges.clean` |
| Open Changes 탭 | P0 | `uncommittedChanges.openSourceControlView` |

### S5 — 다이얼로그

**gitMaster 안전 정책(G3/G4/G11)이 사는 자리.** 옵션 선택 또는 되돌리기 어려운
작업은 전부 여기를 통과한다.

| 다이얼로그 | 내용 | 우선 | 근거 |
|---|---|:--:|---|
| **Push preview** | outgoing 커밋 목록 + 각 커밋 diff + target remote/branch 수정 + force-with-lease | P1 | gitMaster 고유 **G5**, `SYNC-FR-020~022` |
| Pull 옵션 | rebase / ff-only / no-ff / squash | P1 | `SYNC-FR-010` |
| Fetch 옵션 | `--prune`, `--tags`/`--no-tags` | P2 | `SYNC-FR-002/003` |
| Merge 옵션 | ff-only / no-ff / squash + **영향 범위(ff 가능·충돌 예상)** | P1 | `BR-FR-021/024` (**G11**) |
| Rebase 옵션 | `--onto` 지정, interactive 진입 | P2 | `F.2.4.2` |
| Reset 모드 | `--soft` / `--mixed` / `--hard` + 영향 커밋 수 | P1 | `commit.reset`, `F.2.10.2` |
| 브랜치 생성 | 이름 + start point + checkout 여부 | P0 | `branch`, `branchFrom` |
| 브랜치 삭제 확인 | `-D` 시 미머지 경고 + recovery hint (ref 값 기록) | P1 | `BR-FR-014` (**G4**) |
| 태그 생성 | lightweight / annotated / signed + 메시지 | P1 | `TAG-FR-010~012` |
| Stash 생성 | 메시지 + `--include-untracked` + `--keep-index` | P0 | `ST-FR-010~013` |
| **Discard 확인** | 영향 파일 + recovery hint (snapshot/stash 제안) | P0 | `COM-FR-053/054` (**G4**) |
| **Preflight 차단** | user.identity 미설정 / detached HEAD / 머지·리베이스 진행 중 | P0 | `COM-FR-030` (**G3**) |
| 충돌 해결 | 3-way merge editor | P2 | `GT-FR-015` — 난이도 최상위 |
| 인터랙티브 rebase | pick/reword/squash/fixup/drop + 드래그 순서 | P2 | `GT-FR-028` — 난이도 최상위 |
| dirty 체크아웃 | stash / abort / force 선택 | P1 | `BR-FR-011` |
| clone / init | URL + 대상 폴더 / initial-branch | P2 | `REPO-FR-002/003` |

### S6 — 상태바 chip

Git 창 **밖**(터미널 창)에서도 보여야 하는 것. `#status-bar` 인프라 재사용.

| chip | 내용 | 우선 | 근거 |
|---|---|:--:|---|
| 브랜치 | `⎇ main` + detached/no-upstream 배지 | P0 | `SB-FR-001/002` |
| dirty | 변경 파일 수 `●3` | P0 | `SB-FR-021` |
| ahead/behind | `↑2 ↓0` | P1 | `SB-FR-022` |
| conflict | 경고 chip → 클릭 시 Changes 탭 | P1 | `SB-FR-020/023` |
| 진행 중 job | fetch/push 진행 표시 + 취소 | P2 | `SB-FR-010~014` |

클릭하면 Git 창으로 점프한다. 좌측 GIT 섹션 항목의 배지와 동일 정보원.

---

## 4. 교차 검증 — 레퍼런스 기능의 배치 확인

§2.3(gitMaster 고유 12개)이 모두 배치됐는지 확인한다.

| # | gitMaster 고유 기능 | 배치 | 우선 |
|---|---|---|:--:|
| G1 | 멀티 리포 일괄 조작 | **미배치 — 범위 밖** (§3.5.1 단일 리포 확정) | — |
| G2 | 통합 Console | S2 Console 탭 | P1 |
| G3 | preflight 검증 | S5 Preflight 차단 | P0 |
| G4 | recovery hint | S5 Discard/삭제 확인 | P0 |
| G5 | push preview | S5 Push preview | P1 |
| G6 | 인터랙티브 rebase GUI | S5 | P2 |
| G7 | 취소 가능한 job | S6 진행 chip + S5 | P2 |
| G8 | History for Selection (`git log -L`) | **미배치** — 에디터 선택 영역이 필요. dongminal 내장 편집기 연동 시 재검토 | P2 |
| G9 | annotate 이전 리비전 연쇄 | S4 파일 우클릭 → Blame | P2 |
| G10 | 브랜치 즐겨찾기·prefix 그룹핑 | S3 Branches 탭 | P1 |
| G11 | 영향 범위 사전 표시 | S5 Merge/Reset 옵션 | P1 |
| G12 | stale 응답 가드 | **표면 아님 — 구현 규약** (§4 설계 원칙으로 이관) | P0 |

Git Graph 고유(§2.4):

| # | 기능 | 배치 | 우선 |
|---|---|---|:--:|
| GG1 | 컨텍스트 메뉴 6종 어휘 | S4 전체 | P0~P2 |
| GG2 | 커밋 mute | S2 History 탭 | P2 |
| GG3 | 그래프 색 커스터마이즈 | **테마 토큰에서 파생** (하드코딩 금지, DC-007 정신) | P1 |
| GG4 | Code Review 추적 | **미배치 — 후속 검토**. dongminal 에이전트 diff 검토(D4)와 접점 | P2 |
| GG5 | 키보드 단축키 | 기존 `SHORTCUT_DEFAULTS` 체계에 편입 | P1 |

VSCode 고유:

| 기능 | 배치 |
|---|---|
| 에디터 gutter change decoration | **미배치** — 내장 편집기(Monaco) 연동 시 재검토 |
| autofetch | **미배치 — 후속 검토**. 백그라운드 네트워크 동작이라 별도 판단 필요 |
| timeline 뷰 | History 탭 파일 필터로 대체 |

---

## 5. 집계

| 표면 | P0 | P1 | P2 | 계 |
|---|---:|---:|---:|---:|
| S1 Changes | 10 | 10 | 2 | 22 |
| S2 Diff/History/Console | 9 | 11 | 7 | 27 |
| S3 Branches/Stash | 3 | 4 | 3 | 10 |
| S4 컨텍스트 메뉴 | 10 | 24 | 12 | 46 |
| S5 다이얼로그 | 4 | 7 | 5 | 16 |
| S6 상태바 | 2 | 2 | 1 | 5 |
| **계** | **38** | **58** | **30** | **126** |

- **P0 38개가 "GUI 로 git 을 쓸 수 있는" 최소 집합**이다.
- S4(컨텍스트 메뉴)가 46개로 가장 크지만, 대부분 **기존 동작의 진입점**이라
  백엔드 신규 작업은 적다. 메뉴 프레임워크 하나를 만들면 항목 추가는 선형이다.
- 미배치 6건(G1, G8, GG4, gutter decoration, autofetch, timeline)은 범위 밖이거나
  후속 검토 대상으로 명시했다 — 누락이 아니다.

---

## 6. 후속

이 지도는 SRS 의 FR 도출 입력이다. 다음 순서:

1. **N1** — History 탭 내부 세부 (그래프 레인 알고리즘, 필터 UI, 컬럼 구성)
2. **Q3** — MVP 범위 확정. 본 문서의 P0/P1/P2 가 그 근거
3. **Q4 / Q7** — 에이전트 접합, 고난도 3종 시점
