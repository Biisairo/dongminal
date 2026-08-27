# Git 창 — 동작 표면 완성 (SRS)

<!--
  IEEE 29148. 이 문서 하나가 "VSCode Git · Git Graph 의 GUI 기능을 다 갖춘다"는
  사용자 결정의 단일 진실 공급원이다.

  선행 문서와의 관계:
  - GIT_SURFACE_MAP.md   무엇이 있어야 하는가 (126항목). **범위의 출처다.**
  - GIT_SRS.md           이미 구현한 것의 요구사항 (FR-GIT-1~226)
  - GIT_REVIEW4_SRS.md   4·5차 사용자 검토 (FR-GIT-227~249)
  - GIT_REMAINING.md §4  "P1/P2 로 미뤄둔 기능 — 이제 범위 안이다"
-->

## 1. 서론 (Introduction)

### 1.1 목적 (Purpose)

접수한 말(2026-08-27):

> "branch 삭제, 이름변경 등 기본적인 기능들이 없다. 이는 branch 뿐만 아니라
> 다른기능들도 확인하여 기본적인 기능이 없는경우 추가해야한다."
> "지금보면 tag 도 보이긴하는데 tag 추가, 제거 푸시 수정같은건 없잖아"
> "그냥 vsc git, gitgraph 에 있는 모든 gui 기능은 다 넣는다고 생각하는게 편할거같아.
> 그정도는 되어야지 기본적인 git 사용이 되겠더라고"

**진단은 "빠뜨렸다"가 아니다.** 지금까지의 판은 *보는 것*(목록·그래프·diff·상태)과
*안전 장치*(확인·recovery hint·단일 실행 지점)를 세웠고, **ref 를 바꾸는 동작은
checkout 계열만** 올렸다. 그래서 화면에는 브랜치·태그가 보이는데 그것으로 할 수 있는
일이 없다 — 사용자의 말 그대로 "보이긴 하는데 없다".

이 문서는 `GIT_SURFACE_MAP.md` 의 126항목을 **전수 대조**해 남은 것을 요구사항으로
확정한다.

### 1.2 범위 (Scope)

- **범위 안**: 표면 지도 S1~S6 의 미구현 항목 전부. 그 항목이 필요로 하는 서버
  표면(`domain/git/write` 함수 · 엔드포인트)과 다이얼로그를 포함한다.
- **범위 밖(이미 그렇게 적힌 것)**: 표면 지도 §4 가 **미배치**로 명시한 6건 —
  G1 멀티 리포 일괄, G8 `git log -L`, GG4 Code Review 추적, 에디터 gutter
  decoration, autofetch, timeline 뷰. 누락이 아니라 배치하지 않기로 한 것이다.
- **범위 밖(2026-08-27 사용자가 뺀 것)**: 커밋 **mute**(GG2) · **FR-GIT-283**
  merge editor · **FR-GIT-284** 인터랙티브 rebase · **FR-GIT-285** clone/init.
  mute 는 요구사항에서 **철회**한다 (D7). 283~285 는 요구사항으로 남되 이 판이
  **착수하지 않는다** (D9) — §6.2 의 착수점은 다음 판을 위해 그대로 둔다.
- **미결(사용자 결정 대기)**: 자격증명 저장·중계. FR-GIT-104 의 **의도적 배제**이며
  `TestNoCredentialFields` 가 필드 이름만으로 막고 있다 (GIT_REMAINING §4.1).
  되살리려면 그 보호 테스트를 여는 결정이 먼저다. **이 문서는 그것을 열지 않는다.**

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| **4겹 계약** | 새 쓰기 동작 하나가 갖춰야 하는 것: ① `write` 의 순수 `…Args` + 실행 함수 ② 엔드포인트 ③ 메뉴/버튼 항목 ④ 확인 규약. 하나라도 빠지면 그 동작은 없는 것과 같거나 안전망 밖이다 |
| **진행 중 작업** | merge·rebase·cherry-pick·revert 가 충돌로 멈춰 저장소에 중간 상태가 남은 것 (`MERGE_HEAD`·`rebase-merge/`·`CHERRY_PICK_HEAD`·`REVERT_HEAD`) |
| **파괴적** | `core.DestructiveActions` 에 든 동작. 2단계 확인과 recovery hint 를 **프레임워크가** 강제한다 (FR-GIT-89·92) |

### 1.4 참조 (References)

`GIT_SURFACE_MAP.md`(범위의 출처) · `GIT_SRS.md`(FR-GIT-1~226) ·
`GIT_REVIEW4_SRS.md`(FR-GIT-227~249) · `GIT_REMAINING.md` §4 ·
`internal/webserver/domain/git/core/write.go`(단일 실행 지점) ·
`internal/webserver/domain/git/core/destructive.go`(파괴적 목록)

---

## 2. 전반 기술 (Overall Description)

### 2.1 근거 — 왜 지금 한 판에 하는가

미룬 근거는 항목마다 "터미널로 충분하다" 였다. 그 근거는 **동작 하나가 없을 때**는
성립하지만 **동작 전부가 없을 때**는 성립하지 않는다 — 사용자가 브랜치를 지우려고
매번 터미널로 나가야 한다면 Git 창은 읽기 전용 뷰어이지 GUI 가 아니다. 접수한 말의
"그 정도는 되어야 기본적인 git 사용이 되겠더라"가 그 판단이다.

### 2.2 전수 조사 (Survey) — 표면 지도 126항목의 현황

**출처는 소스다.** 각 행은 코드에서 확인했다(끝의 근거 열).

#### S1 — Changes 탭 (22)

| 항목 | 우선 | 상태 | 근거 |
|---|:--:|:--:|---|
| 헤더 리포명·브랜치·ahead/behind·detached 배지 | P0 | ✅ | `panel.js _paintHead` |
| Fetch / Pull / Push 버튼 | P0 | ✅ | `remote.js`, `GIT_REMOTE_LABEL` |
| Sync (pull+push 한 번에) | P1 | ❌ | 버튼 3종뿐 |
| Publish Branch (upstream 없을 때) | P1 | ✅ | `remote.js` publish 경로 (FR-GIT-100) |
| 새로고침 | P1 | ✅ | FR-GIT-238 |
| 리포 전환 드롭다운 | P1 | ❌ | 좌측 GIT 섹션이 대신하고 있다 |
| 메시지 입력(multiline·auto-grow·draft) | P0 | ✅ | `commit.js` |
| Commit 버튼 · amend | P0 | ✅ | `commit.js` |
| `Commit ▾` sign-off / no-verify / commit all | P1 | ✅ | `GIT_COMMIT_OPTS` |
| commit template prefill | P1 | ✅ | preflight `template` |
| GPG 서명 상태 표시 | P2 | ✅ | `.git-commit-gpg` |
| author override | P2 | ❌ | 옵션에 없다 |
| 3그룹 · 파일/그룹 stage·unstage·discard | P0 | ✅ | FR-GIT-64~68 |
| tracked/untracked 구분 일괄 | P1 | ✅ | `GIT_GROUP_BULK` |
| partial staged 표시 | P1 | ✅ | FR-GIT-36 |
| 트리/플랫 전환 | P1 | ✅ | `_paintMode` |
| 충돌 표시 + 해결 진입점 | P0 | ✅ | FR-GIT-224 |
| 선택 파일 diff 미리보기 | P0 | ✅ | `_paintPreview` |
| undo last commit | P1 | ✅ | `/api/git/undo-last` |

#### S2 — Diff / History / Console (27)

| 항목 | 우선 | 상태 | 근거 |
|---|:--:|:--:|---|
| side-by-side↔unified · word-level · 공백 무시 · `‹ ›` · binary/LFS · truncate · 축 5종 | P0/P1 | ✅ | `panel.js` diff 계열 |
| **hunk 단위 stage / unstage** | P1 | ❌ | `panel.js` 의 `hunk` 는 전부 `ignoreWhitespace` 오탐 |
| **line range stage / unstage / revert** | P2 | ❌ | — |
| 커밋 목록·가상 스크롤·DAG·refs·상세·파일목록·검색·필터·jump·uncommitted 행 | P0/P1 | ✅ | `history.js` |
| commit range 비교 (`A..B`, `A...B`) | P2 | ❌ | — |
| ~~커밋 mute (비-조상·머지)~~ | P2 | ⊘ | **철회** — 2026-08-27 사용자 결정 (D7) |
| reflog 언급 커밋 포함 | P2 | ❌ | — |
| 다중 커밋 선택 비교 | P2 | ❌ | — |
| Console argv·exitCode·duration·stdout/stderr·복사 | P1 | ✅ | `console.js` |
| Console level 토글 · 텍스트 검색 | P2 | ❌ | 필터가 "쓰기·실패만"으로 고정 |
| Console **replay** | P2 | ❌ | — |

#### S3 — Branches / Stash (10)

| 항목 | 우선 | 상태 | 근거 |
|---|:--:|:--:|---|
| local/remote/즐겨찾기 트리 · 이름 검색 · `/` prefix 그룹핑 · 즐겨찾기 고정 | P0/P1 | ✅ | `branches.js` |
| upstream **표시** | P1 | ✅ | `branches.js:256` |
| upstream **set / unset** | P1 | ❌ | 표시만 한다 |
| 다중 선택 일괄 삭제 (`-d`) | P2 | ❌ | 삭제 자체가 없다 |
| remote 목록 · add / remove | P2 | ❌ | — |
| stash 목록 · 미리보기 | P0/P1 | ✅ | `stash.js` |
| stash 메시지/branch 필터 | P2 | ❌ | — |

#### S4 — 컨텍스트 메뉴 (46)

| 대상 | 있음 | **없음** |
|---|---|---|
| 커밋 | Checkout(detached) · 여기서 브랜치 생성 · Copy hash/subject | **Create Tag · Cherry-pick · Revert · Reset(soft/mixed/hard) · Merge into current · Rebase onto · Drop · Compare with** |
| 브랜치 | Checkout · Checkout(로컬 생성+추적) · Copy name | **Rename · Delete(-d/-D) · Merge into current · Rebase onto · Push/Publish · Set/Unset upstream · Create Branch from** |
| 원격 브랜치 | Checkout(추적 생성) · Copy name | **Pull/Merge · Delete remote branch · Fetch into local** |
| 태그 | Checkout(detached) · Copy name | **Create · Delete(local/remote) · Push to remote** |
| stash | Apply(±index) · Pop · Drop | **Branch from stash · Copy name/hash** |
| 파일 | Open Changes · Open File · Copy path | **Add to .gitignore · File history · Blame · Open file (HEAD)** |
| 미커밋 행 | Changes 탭 열기 | **Stash · Reset · Clean** |

#### S5 — 다이얼로그 (16)

| 항목 | 우선 | 상태 |
|---|:--:|:--:|
| 브랜치 생성 · Stash 생성 · Discard 확인 · Preflight 차단 · dirty 체크아웃 · Pull 옵션 · Fetch 옵션 | P0/P1 | ✅ |
| **Push preview** (outgoing 목록 + force-with-lease) | P1 | ❌ |
| **Merge 옵션** (ff-only/no-ff/squash + 영향 범위 G11) | P1 | ❌ |
| **Reset 모드** (soft/mixed/hard + 영향 커밋 수) | P1 | ❌ |
| **브랜치 삭제 확인** (`-D` 미머지 경고 + recovery hint) | P1 | ❌ |
| **태그 생성** (lightweight/annotated/signed) | P1 | ❌ |
| Rebase 옵션 (`--onto`·interactive 진입) | P2 | ❌ |
| 충돌 3-way merge editor | P2 | ❌ |
| 인터랙티브 rebase | P2 | ❌ |
| clone / init | P2 | ❌ |

#### S6 — 상태바 (5)

| 항목 | 우선 | 상태 |
|---|:--:|:--:|
| 브랜치 · dirty · ahead/behind · conflict chip | P0/P1 | ✅ |
| 진행 중 job chip + 취소 | P2 | ✅ (FR-GIT-112) |

**집계**: 126항목 중 **미구현 33항목**(S4 의 27개 메뉴 항목을 대상별로 셈하면 더
많다). P0 는 남지 않았고 남은 것은 P1·P2 다 — 그래서 "보이는데 못 한다"가 된다.

### 2.3 제약 (Constraints)

1. **git 실행은 두 진입점뿐이다** (FR-GIT-95). 새 동작은 전부 `ExecWrite` 를 지나야
   하고, `readCommands` 와 `writeCommands` 의 교집합은 계속 비어 있어야 한다.
   다행히 `writeCommands` 는 `branch·tag·merge·rebase·cherry-pick·revert·reset·clean`
   을 **이미 허용**한다 — 가드를 넓힐 일이 없다.
2. **파괴적 판정은 호출자가 선언한다** (`WriteSpec.Destructive`). 하위 명령만으로
   갈리지 않는다 — `reset --soft` 는 안전하고 `--hard` 는 아니다.
3. **파괴적 목록은 서버가 권위다** (`/api/git/policy`). 이미 이름이 서 있는 것:
   `branch_delete` · `tag_delete` · `reset_hard` · `force_push` ·
   `remote_ref_delete` — **쓰일 자리를 기다리고 있었다.**
4. **자격증명을 담는 필드를 만들지 않는다** (FR-GIT-104). 새 옵션 구조체에도 같다.
5. 새 목록·행은 FR-RPT-1~8 을 따른다.
6. 확인은 항목이 따로 구현하지 않는다 — `warn`/`destructive` 선언만 하면
   `GitMenu._pick` 이 `GitDialog`/`GitConfirm` 을 거친다 (FR-GIT-146·172).

---

## 3. 요구사항 (Requirements)

### 3.0 교차 규약 — 새 쓰기 동작 하나의 모양

- **FR-GIT-250** 새 쓰기 동작은 **4겹을 모두** 갖춘다. 하나라도 빠뜨리지 않는다.
  1. `domain/git/write` 에 **순수 `…Args`** 와 실행 함수를 둔다. `…Args` 는 git 을
     돌리지 않고 argv 만 만든다 — 서버가 잘못된 요청을 **실행 전에** 400 으로 답할 수
     있어야 하고, 테스트가 "무엇을 실행하지 않았는가"를 볼 수 있어야 한다
     (`CheckoutArgs` 의 선례).
  2. 실행은 `s.ExecWrite(... WriteSpec{Argv, Destructive})` 하나만 지난다. 파괴적
     여부는 **옵션에서 파생해 선언한다** (`reset --hard` 만 참).
  3. 엔드포인트는 기존 쓰기 규약을 그대로 쓴다 — `gitResolveRepo` 로 루트 재확인,
     `gitStatusBefore` → `gitApply` → `gitWriteOK`, 본문에 `ok:true`.
  4. 화면 항목은 `GIT_MENUS` 선언 하나다. 확인 코드를 항목이 쓰지 않는다.
- **FR-GIT-250.1** 파괴적 동작은 `core.DestructiveActions` 에 이름이 있어야 하고,
  서버는 `confirm:true` 없이 실행하지 않는다. 새로 필요한 이름은
  `clean_untracked` · `commit_drop` · `rebase` 다 — 나머지는 이미 서 있다.
- **FR-GIT-250.2** recovery hint 는 **되살릴 수 있는 명령**이다 (FR-GIT-92). 안내문만
  남기지 않는다. ref 를 옮기거나 지우는 동작은 **옮기기 전 oid** 를 hint 에 싣는다
  (`git branch <name> <oid>` · `git tag <name> <oid>` · `git reset --hard <oid>`).
- **FR-GIT-250.3** 이름·ref 인자는 실행 **전에** 검증한다 (`core.CheckRefArg`,
  `query.ValidBranchName`). 클라이언트만 막으면 API 직접 호출이 우회한다.

### 3.1 묶음 A — 진행 중 작업 (다른 묶음의 전제)

merge·rebase·cherry-pick·revert 를 열면 **충돌로 멈춘 중간 상태**가 생긴다. 지금
`status` 는 충돌 *파일*은 알지만 **무엇을 하다 멈췄는지**는 모른다. 출구를 함께
만들지 않으면 사용자가 GUI 안에 갇힌다 — 그래서 이 묶음이 먼저다.

- **FR-GIT-251** `status` 는 **진행 중 작업**을 싣는다: `none | merge | rebase |
  cherry-pick | revert`. 판정 근거는 `.git` 의 표식이다 (`MERGE_HEAD` ·
  `rebase-merge/`·`rebase-apply/` · `CHERRY_PICK_HEAD` · `REVERT_HEAD`).
  rebase 는 **진행 위치**(`msgnum`/`end`)도 함께 준다 — "몇 번째 중"이 보이지 않으면
  사용자는 끝났는지 알 수 없다.
  - `git status --porcelain=v2` 를 이미 쓰므로 조회를 새로 만들지 않는다. 표식 파일은
    `--git-dir` 아래를 **읽기만** 한다.
- **FR-GIT-252** 진행 중이면 Changes 탭 머리에 **그 사실과 출구**를 보인다:
  `계속(continue)` · `건너뛰기(skip, rebase·cherry-pick 만)` · `중단(abort)`.
  - `중단`은 **파괴적이다** — 그 작업 중의 해결 내용이 사라진다. 2단계 확인을 거친다.
  - `계속`은 충돌이 남아 있으면 git 이 거부한다. 그 사유를 그대로 보인다 — 우리가
    미리 판정해 버튼을 막지 않는다 (판정이 두 벌이 된다).
  - 진행 중에는 **새 merge·rebase·cherry-pick·revert 를 시작할 수 없다.** 메뉴 항목이
    비활성이 되고 사유를 보인다 (preflight 의 G3 와 같은 뜻).

### 3.2 묶음 B — 브랜치 (접수한 말의 본체)

- **FR-GIT-253** **Rename.** 대상 브랜치의 새 이름을 받아 `git branch -m <old> <new>`.
  - 이름 검증은 생성과 **같은 자리**를 쓴다 (`ValidBranchName` + 중복 확인).
  - `-M`(강제 덮어쓰기)는 **만들지 않는다** — 기존 ref 를 덮는 것은 이름 변경이 아니다
    (FR-GIT-97 의 "기본은 안전한 쪽").
  - 현재 브랜치도 대상이다. 이름이 바뀌면 `status.branch` 가 따라 바뀐다.
- **FR-GIT-254** **Delete.** `-d`(머지된 것만)가 기본이고 `-D`는 사용자가 명시할 때만.
  - 파괴적이다 (`branch_delete`). 2단계 확인 + recovery hint 는 **지워질 브랜치의
    oid** 로 만든다: `git branch <name> <oid>`.
  - `-d` 가 "머지되지 않았다"로 거부하면 **그것을 실패로 끝내지 않는다** — 사유를
    보이고 `-D` 로 올릴 선택지를 준다 (브랜치 이름 충돌의 3선택과 같은 규약).
  - 현재 브랜치는 지울 수 없다. 사유를 비활성 title 로 보인다.
  - **다중 선택 일괄 삭제는 `-d` 로만** 한다 (표면 지도 P2) — 한 번의 확인으로 여러
    개를 강제 삭제하는 자리를 만들지 않는다. 부분 실패는 무엇이 지워졌는지 보인다
    (`partial`·`changed` 규약).
- **FR-GIT-255** **Merge into current.** 대상 ref 를 현재 브랜치에 합친다.
  - 옵션은 `ff-only` · `no-ff` · `squash` 이며 기본은 git 기본이다(플래그 없음).
  - 다이얼로그는 **영향 범위를 먼저 보인다** (G11): ff 로 끝나는지, 들어올 커밋 수.
    근거는 `rev-list --count` 와 `merge-base --is-ancestor` 다.
  - 충돌로 멈추면 실패가 아니라 **진행 중 상태**다 (FR-GIT-251) — Changes 탭으로
    보내고 충돌 그룹을 펼친다 (FR-GIT-111 이 pull 에 쓰는 경로 그대로).
- **FR-GIT-256** **Rebase onto.** 대상 ref 위로 현재 브랜치를 다시 얹는다.
  - **파괴적이다** (`rebase`) — 커밋 해시가 바뀌고 되돌리려면 reflog 가 필요하다.
    2단계 확인 + hint 는 `git reset --hard <원래 HEAD oid>` 다.
  - `--onto` 지정은 옵션이다. interactive 는 이 요구사항이 아니다 (FR-GIT-279).
- **FR-GIT-257** **Set / Unset upstream.** `git branch --set-upstream-to=<remote/branch>` ·
  `--unset-upstream`. 대상 목록은 원격 ref 목록에서 온다 (새 조회를 만들지 않는다).
  - unset 은 파괴적이 아니다 — 되돌리는 것이 set 하나다.
- **FR-GIT-258** **브랜치 Push.** 대상 브랜치를 원격에 민다. upstream 이 없으면
  publish 이며 그 사실을 실행 전에 알린다 (FR-GIT-100 의 규약을 **현재 브랜치가 아닌
  대상에도** 넓힌다). force 는 기존 `force_push` 규약을 그대로 탄다.
- **FR-GIT-259** **Create Branch from.** 시작점을 그 ref 로 고정해 생성 다이얼로그를
  연다 — 커밋 메뉴의 `branch-from`(FR-GIT-141)과 **같은 함수**를 부른다.

### 3.3 묶음 C — 태그

- **FR-GIT-260** **생성.** 이름 + 대상(기본 HEAD 또는 지목한 커밋) + 종류를 받는다:
  lightweight(`git tag <n> <oid>`) · annotated(`-a -m`) · signed(`-s -m`).
  - 메시지는 annotated·signed 에서만 뜻이 있다. **stdin 으로 넘기지 않는다** —
    `-m` 은 인자이고, 커밋 메시지의 stdin 규약(FR-GIT-77)은 커밋의 것이다.
  - 이름 검증은 `check-ref-format --normalize` 를 쓴다. 같은 이름이 있으면 거부한다.
  - signed 는 서명 키가 없으면 git 이 거부한다 — 사유를 그대로 보인다.
- **FR-GIT-261** **삭제.** 로컬은 `git tag -d`, 원격은 `git push <remote> --delete
  <tag>` 다. 둘은 **다른 항목**이다 — 하나가 다른 하나를 자동으로 하지 않는다.
  - 로컬은 `tag_delete`, 원격은 `remote_ref_delete` 로 **둘 다 파괴적**이다.
    hint 는 `git tag <name> <oid>` (로컬) · `git push <remote> <oid>:refs/tags/<name>`
    (원격)다.
- **FR-GIT-262** **Push to remote.** 태그 하나 또는 전체(`--tags`)를 민다. 원격
  작업이므로 기존 job 경로(FR-GIT-101~104)를 그대로 탄다 — 진행·취소·인증 안내가
  공짜로 따라온다.

### 3.4 묶음 D — 커밋

- **FR-GIT-263** **Cherry-pick.** 지목한 커밋을 현재 브랜치에 얹는다.
  머지 커밋이면 `-m <부모번호>` 를 받는다 — 묻지 않고 고르면 틀린 부모를 집는다.
  충돌은 진행 중 상태다 (FR-GIT-251).
- **FR-GIT-264** **Revert.** 지목한 커밋을 되돌리는 커밋을 만든다. 머지 커밋은
  cherry-pick 과 같은 부모 선택을 받는다. `--no-commit` 은 옵션이다.
- **FR-GIT-265** **Reset to here.** `--soft` · `--mixed`(기본) · `--hard`.
  - 다이얼로그는 **영향 커밋 수**를 보인다 (G11): `rev-list --count <oid>..HEAD`.
  - `--hard` 만 파괴적이다 (`reset_hard`). hint 는 `git reset --hard <원래 HEAD oid>`.
- **FR-GIT-266** **Drop.** 지목한 커밋 하나를 히스토리에서 뺀다
  (`git rebase --onto <oid>^ <oid>`). 파괴적이다 (`commit_drop`) — hint 는 원래 HEAD 로의
  `reset --hard` 다. 진행 중 상태가 될 수 있다.
- **FR-GIT-267** **Compare with.** 두 리비전을 고르면 Diff 탭이 `rev↔rev` 축으로 연다
  — 그 축은 **이미 있다** (FR-GIT-138 의 축 목록). History 에서 커밋 둘을 고르는 길과
  `A..B`/`A...B` 입력 둘 다 이 자리로 들어온다.

### 3.5 묶음 E — 원격

- **FR-GIT-268** **원격 브랜치 메뉴.** `Pull/Merge`(그 원격 ref 를 현재 브랜치로) ·
  `Fetch into local`(같은 이름 로컬 ref 갱신) · `Delete remote branch`.
  - 삭제는 `remote_ref_delete` 로 파괴적이며 hint 는 되살리는 push 다.
- **FR-GIT-269** **remote 목록 · add / remove.** Branches 탭에 원격 목록을 두고
  `git remote add|remove` 를 붙인다. remove 는 파괴적이 아니다(설정만 지운다) —
  다만 되살릴 `git remote add <name> <url>` 을 hint 로 남긴다.
- **FR-GIT-270** **Sync.** pull 후 push 를 한 번의 진입점으로 묶는다. 두 job 을
  **순서대로** 돌리고 앞이 실패하면 뒤를 돌리지 않는다.
- **FR-GIT-271** **Push preview.** 밀기 전에 outgoing 커밋 목록을 보이고, 대상
  remote/branch 를 고치게 하며, force-with-lease 를 그 자리에서 켠다.
  목록은 `log <upstream>..<branch>` 이며 **새 조회를 만들지 않는다**.

### 3.6 묶음 F — stash · 파일 · 미커밋 행

- **FR-GIT-272** **Branch from stash** (`git stash branch <name> <stash>`) ·
  **Copy name / hash** · stash 목록의 **메시지/branch 필터**.
- **FR-GIT-273** **Add to .gitignore.** 파일 경로를 `.gitignore` 에 덧붙인다.
  - **git 실행이 아니라 파일 쓰기다.** 그러므로 `ExecWrite` 를 지나지 않으며, 대신
    저장소 루트 안의 `.gitignore` 하나만 대상으로 하고 경로를 그 안으로 가둔다.
  - 이미 있는 줄은 더하지 않는다. 파일 끝의 개행을 보정한다.
- **FR-GIT-274** **Open File (HEAD).** 워킹 트리가 아니라 `HEAD:<path>` 의 내용을 연다
  — 조회는 `cat-file` 로 이미 있다 (diff 의 original 쪽).
- **FR-GIT-275** **File history.** 그 경로의 커밋만 History 탭에 보인다 — path 필터가
  **이미 있으므로**(FR-GIT-129) 그 필터를 채워 탭을 여는 것이 전부다.
- **FR-GIT-276** **Blame.** 파일 한 줄마다 마지막으로 고친 커밋을 보인다
  (`git blame --porcelain`). 줄을 고르면 그 커밋의 상세로 간다 (G9 의 연쇄).
  - 큰 파일 상한과 잘림 표식은 diff 의 규약을 그대로 쓴다.
- **FR-GIT-277** **미커밋 행 메뉴.** `Stash`(생성 다이얼로그 재사용) ·
  `Reset`(mixed) · `Clean`(untracked 제거).
  - Clean 은 파괴적이다 (`clean_untracked`) — 되살릴 수 없으므로 hint 는
    `git stash push -u` 다 (discard 의 선례).

### 3.7 묶음 G — 부분 스테이징

- **FR-GIT-278** **hunk 단위 stage / unstage.** diff 뷰의 hunk 머리에 동작을 붙이고
  `git apply --cached [-R] -` 로 그 hunk 만 적용한다.
  - 패치는 **서버가 만든다** — 클라이언트가 만든 패치 문자열을 그대로 받으면 임의
    쓰기 표면이 된다. 클라이언트는 `(파일, 축, hunk 번호)` 만 보낸다.
  - 관측이 그 사이 바뀌었으면 거부한다 — 낡은 hunk 번호로 다른 곳을 고치지 않는다.
- **FR-GIT-279** **line range stage / unstage / revert.** 같은 경로에 줄 범위를 얹는다.
  revert 는 파괴적이다 (`discard` 와 같은 뜻이므로 그 이름을 쓴다).

### 3.8 묶음 H — 읽기 보강

- **FR-GIT-280** 커밋 목록에 **reflog 언급 커밋 포함** 토글. 목록 질의의 인자이고
  화면 상태다 — `log --reflog` 한 인자라 읽기 가드를 넓히지 않는다.
  (커밋 **mute** 는 2026-08-27 철회했다 — D7.)
- **FR-GIT-281** Console 의 **level 토글 · 텍스트 검색 · replay**.
  replay 는 **같은 argv 를 다시 실행**하는 것이므로 쓰기였다면 2단계 확인을 거친다.
- **FR-GIT-282** 커밋의 **author override** · Changes 헤더의 **리포 전환 드롭다운**.

### 3.9 묶음 I — 난이도 최상위 (마지막)

- **FR-GIT-283** 충돌 **3-way merge editor** — Monaco 위의 별도 모드. ours/theirs/base
  3열과 줄 단위 채택.
- **FR-GIT-284** **인터랙티브 rebase** — pick/reword/squash/fixup/drop + 순서 변경.
  `GIT_SEQUENCE_EDITOR` 를 dongminal 이 대신하는 구조가 필요하다.
- **FR-GIT-285** **clone / init** — URL + 대상 폴더 / `--initial-branch`.
  - clone 은 **인증에 걸린다.** 자격증명을 담지 않는다는 FR-GIT-104 를 유지하므로,
    실패하면 터미널에서 실행할 명령을 보이는 것까지가 이 요구사항이다.

---

## 4. 검증 (Verification)

| # | 요구사항 | 방법 | 판정 |
|---|---|---|---|
| **V171** | GIT-250 | 단위 | 새 `…Args` 는 git 을 돌리지 않고 argv 만 만든다 — 잘못된 인자는 **실행 전에** 오류다 |
| **V172** | GIT-250·250.1 | 단위 | 새 쓰기 전부가 `ExecWrite` 를 지난다. `Destructive` 선언이 옵션에서 파생한다 (`reset --soft` false / `--hard` true) |
| **V173** | GIT-250.1 | 단위·API | 파괴적 이름이 `/api/git/policy` 목록에 있고, `confirm` 없는 요청은 실행되지 않는다 |
| **V174** | GIT-250.2 | 단위 | ref 를 옮기거나 지우는 동작의 hint 가 **옮기기 전 oid** 를 담는다. 안내문만인 hint 가 없다 |
| **V175** | GIT-251 | 단위 | 표식 파일별로 진행 중 작업이 정확히 판정된다. rebase 는 위치(`n/N`)를 준다 |
| **V176** | GIT-251·252 | e2e | 충돌로 멈춘 merge 에서 머리에 상태와 세 출구가 보인다. 중단은 2단계 확인을 거친다 |
| **V177** | GIT-252 | e2e | 진행 중에는 새 merge·rebase·cherry-pick·revert 항목이 **비활성이고 사유가 보인다** |
| **V178** | GIT-253 | e2e | 브랜치 rename 이 목록·상태바·`status.branch` 에 반영된다. 중복 이름은 실행 전에 거부된다 |
| **V179** | GIT-254 | e2e | `-d` 삭제가 2단계 확인을 거치고, hint 의 명령으로 **실제로 되살아난다** |
| **V180** | GIT-254 | e2e | 미머지 브랜치의 `-d` 는 실패가 아니라 **선택지**(`-D` 로 올리기)로 이어진다 |
| **V181** | GIT-254 | e2e | 현재 브랜치는 삭제 항목이 비활성이고 사유가 보인다. 다중 삭제는 `-D` 를 제공하지 않는다 |
| **V182** | GIT-255 | e2e | merge 다이얼로그가 **영향 범위**(ff 여부·들어올 커밋 수)를 실행 전에 보인다 |
| **V183** | GIT-255 | e2e | 충돌 merge 는 실패가 아니라 진행 중 상태로 끝나고 Changes 의 충돌 그룹이 펼쳐진다 |
| **V184** | GIT-256 | e2e | rebase 는 2단계 확인을 거치고 hint 의 `reset --hard <원래 oid>` 로 되돌아간다 |
| **V185** | GIT-257 | e2e | upstream set/unset 이 Branches 목록의 표시와 ahead/behind 에 반영된다 |
| **V186** | GIT-258 | e2e | upstream 없는 브랜치의 push 는 publish 임을 실행 전에 알린다 (대상이 현재 브랜치가 아니어도) |
| **V187** | GIT-260 | e2e | lightweight·annotated·signed 각각의 argv 가 다르고, 메시지는 annotated·signed 에만 붙는다 |
| **V188** | GIT-260 | 단위 | 태그 이름 검증이 `check-ref-format` 을 지난다. 중복은 실행 전에 거부된다 |
| **V189** | GIT-261 | e2e | 로컬 삭제와 원격 삭제가 **다른 항목**이고 각각 2단계 확인을 거친다. 하나가 다른 하나를 하지 않는다 |
| **V190** | GIT-262 | e2e | 태그 push 가 job 경로를 타서 진행·취소가 보인다 |
| **V191** | GIT-263·264 | e2e | 머지 커밋의 cherry-pick·revert 는 **부모를 묻는다.** 묻지 않고 실행하지 않는다 |
| **V192** | GIT-265 | e2e | reset 다이얼로그가 영향 커밋 수를 보인다. `--hard` 만 2단계 확인이다 |
| **V193** | GIT-266 | e2e | drop 이 그 커밋만 빼고, hint 로 되돌아간다 |
| **V194** | GIT-267 | e2e | 커밋 둘을 골라 비교하면 Diff 탭이 `rev↔rev` 축으로 열린다. `A..B` 입력도 같은 자리로 온다 |
| **V195** | GIT-268 | e2e | 원격 브랜치의 세 항목이 각각 동작한다. 삭제는 2단계 확인 + 되살릴 hint 를 준다 |
| **V196** | GIT-269 | e2e | remote add/remove 가 목록에 반영되고, remove 는 되살릴 명령을 남긴다 |
| **V197** | GIT-270 | e2e | Sync 는 pull → push 순서이고, pull 이 실패하면 push 를 **돌리지 않는다** |
| **V198** | GIT-271 | e2e | push preview 가 outgoing 목록을 보이고 force-with-lease 를 그 자리에서 켠다 |
| **V199** | GIT-272 | e2e | stash 에서 브랜치를 만들면 그 stash 가 적용된 채 새 브랜치로 옮겨간다 |
| **V200** | GIT-273 | 단위·e2e | `.gitignore` 추가가 저장소 루트 밖을 대상으로 삼지 않는다. 중복 줄을 더하지 않는다 |
| **V201** | GIT-274·275 | e2e | Open File (HEAD) 가 워킹 트리가 아닌 HEAD 내용을 연다. File history 가 path 필터를 채워 연다 |
| **V202** | GIT-276 | e2e | blame 이 줄마다 커밋을 보이고, 줄을 고르면 그 커밋 상세로 간다. 큰 파일은 잘림 표식이 선다 |
| **V203** | GIT-277 | e2e | 미커밋 행의 세 항목이 동작하고 Clean 은 2단계 확인 + `stash push -u` hint 를 준다 |
| **V204** | GIT-278 | 단위 | hunk 패치를 **서버가** 만든다. 클라이언트가 보낸 패치 문자열을 실행하는 경로가 없다 |
| **V205** | GIT-278 | e2e | hunk 하나만 스테이지되고 나머지는 남는다. 관측이 바뀌었으면 거부된다 |
| **V206** | GIT-279 | e2e | 줄 범위 stage/unstage/revert 가 그 범위에만 적용된다. revert 는 2단계 확인이다 |
| **V207** | GIT-280·281·282 | e2e | reflog 토글 · Console level/검색/replay · author override · 리포 드롭다운 각각 동작한다. replay 의 쓰기는 2단계 확인이다 |
| **V208** | GIT-283 | e2e | merge editor 가 ours/theirs/base 를 보이고 줄 단위 채택이 결과 파일에 반영된다 |
| **V209** | GIT-284 | e2e | 인터랙티브 rebase 의 순서·동작 편집이 실제 결과에 반영되고, 중단이 원래 상태로 되돌린다 |
| **V210** | GIT-285 | e2e | clone/init 이 동작하고, clone 이 인증으로 실패하면 **터미널에서 실행할 명령**을 보인다 (자격증명을 받지 않는다) |
| **V211** | FR-GIT-104 | 회귀 | `TestNoCredentialFields` 가 계속 통과한다 — 새 옵션 구조체에도 자격증명 필드가 없다 |
| **V212** | FR-GIT-95 | 회귀 | `readCommands` 와 `writeCommands` 의 교집합이 비어 있다. 새 동작이 읽기 경로로 새지 않는다 |
| **V213** | 전부 | 회귀 | 기존 e2e 전량이 통과한다 |

### 4.1 이 판이 바꾸는 기존 검증 항목

동작이 늘면 "그 자리에 무엇이 있는가" 를 세던 기대값은 함께 바뀐다. 바뀐 것만 적는다 —
**뜻이 바뀐 것은 없다.**

| 기존 | 처리 |
|---|---|
| `git-changes` C7 (V24): 파일 우클릭 메뉴가 **정확히 3항목** | 항목 목록을 새 집합으로 갱신했다. 이 시험의 본체는 "저장소를 바꾸는 항목이 하나도 없다"(FR-GIT-41)이고 그 단정은 그대로다 — 개수는 그 사실의 대리 지표였을 뿐이다 |
| `git-improve` V133 · `git-ui-revision` V74: 메뉴 항목을 **`Open File` 글자로** 고른다 | `Open File (HEAD)`(FR-GIT-274)가 같은 글자를 품으므로 `data-id` 로 고르도록 바꿨다 |


---

## 5. 결정 (Decisions)

| # | 결정 | 근거 |
|---|---|---|
| **D1** | 범위는 표면 지도 126항목의 **미구현 전부**다 | 접수한 말이 "vsc git, gitgraph 의 모든 gui 기능". 지도 자체가 그 둘에서 뽑은 것이라 지도가 곧 범위다 |
| **D2** | 진행 중 작업(묶음 A)을 **먼저** 한다 | merge·rebase·cherry-pick 을 열면서 출구를 안 만들면 사용자가 GUI 안에 갇힌다. 다른 묶음의 전제다 |
| **D3** | 순서는 A → B(브랜치) → C(태그) → D(커밋) → E(원격) → F(stash·파일·미커밋) → G(부분 스테이징) → H(읽기) → I(최상위) | 접수한 말의 본체가 브랜치·태그다. I 는 나머지가 다 선 뒤에 붙어야 하는 것이다 |
| **D4** | `-D`·`--hard`·`rebase`·`drop`·`clean` 은 **파괴적**으로 선언한다 | 되돌리려면 reflog 가 필요한 것은 전부 파괴적이다. 판정을 하위 명령이 아니라 옵션에서 파생한다 |
| **D5** | 자격증명은 **열지 않는다** | FR-GIT-104 의 의도적 배제. 여는 것은 별도 결정이며 `TestNoCredentialFields` 를 약화하는 일이다 |
| **D6** | hunk 패치는 **서버가 만든다** | 클라이언트가 만든 패치를 받으면 `git apply` 가 임의 쓰기 표면이 된다 |
| **D7** | 커밋 **mute** 를 요구사항에서 **철회**한다 | 2026-08-27 사용자 결정. 흐리게 그리는 것 하나를 위해 "HEAD 의 조상인가"를 커밋마다 판정해야 하고, 그 판정을 어디서 하든 값이 늘거나 조회가 는다. 얻는 것이 표시 하나뿐이다 |
| **D8** | Blame(FR-GIT-276)은 **Diff 탭의 모드**로 그린다 | 2026-08-27 사용자 결정. 고정 탭을 8개로 늘리지 않는다 — Diff 탭이 Monaco·파일 선택·큰 파일 잘림 규약을 이미 들고 있어 물려받을 것이 가장 많다 |
| **D9** | 283·284·285 는 이 판이 **착수하지 않는다** | 2026-08-27 사용자 결정. 셋 다 새 표면(Monaco 별도 모드 · `GIT_SEQUENCE_EDITOR` 대체 · 인증)을 여는 것이라 남은 읽기 보강과 성격이 다르다. 요구사항과 착수점은 그대로 남긴다 |

## 6. 추적성 (Traceability)

| 접수한 말 | 요구사항 | 검증 |
|---|---|---|
| "branch 삭제, 이름변경 등 기본적인 기능들이 없다" | 253~259 | V178~V186 |
| "tag 추가, 제거 푸시 수정같은건 없잖아" | 260~262 | V187~V190 |
| "다른기능들도 확인하여 기본적인 기능이 없는경우 추가" | 263~282 | V191~V207 |
| "vsc git, gitgraph 에 있는 모든 gui 기능은 다 넣는다" | 250~285 (지도 전수) | V171~V213 |
| (파생) 충돌로 멈춘 뒤 나갈 길이 없다 | 251·252 | V175~V177 |

## 6.1 진행 상황 (2026-08-27)

| 묶음 | 요구사항 | 상태 |
|---|---|:--:|
| A 진행 중 작업 | 251·252 | ✅ |
| B 브랜치 | 253~259 · 268 | ✅ |
| C 태그 | 260~262 | ✅ |
| D 커밋 | 263~267 | ✅ |
| E 원격 | 269~271 | ✅ |
| F stash·파일·미커밋 | 272~275 · 277 | ✅ |
| G 부분 스테이징 | 278·279 | ✅ |
| H 읽기 보강 | **281 Console** | ✅ |
| H 읽기 보강 | **276 Blame · 280 reflog · 282 author override·리포 드롭다운** | ⬜ 이 판 |
| I 최상위 난이도 | 283 merge editor · 284 인터랙티브 rebase · 285 clone/init | ⬜ 다음 판 (D9) |
| — | ~~커밋 mute~~ | ⊘ 철회 (D7) |

**남은 것은 5개 요구사항이며 전부 P2 이거나 화면이 큰 것들이다.** 접수한 말의 본체
(브랜치·태그·커밋의 기본 동작)는 전부 섰다.

**이 판의 범위는 묶음 H 셋이다** (2026-08-27 사용자 결정): `280 → 282 → 276`.
셋 다 **읽기와 화면**이고 새 쓰기 동작은 282 의 author override 하나뿐이다.

## 6.2 남은 5건의 착수점과 먼저 정할 것

**조사한 사실만 적는다.** 아래 "가드" 는 `core/guard.go` 의 `readCommands` /
`core/write.go` 의 `writeCommands` 를 말하며, 지금 어디에도 없는 하위 명령은 그것을
넓히는 결정이 먼저다 (§2.3-1: 그 목록은 한 곳이고 교집합은 비어야 한다).

| # | 요구사항 | 착수점 (2026-08-27 확인) | 먼저 정할 것 |
|---|---|---|---|
| **276** | Blame | 조회가 없다 — `query/blame.go` 를 새로 만든다. `blame` 은 **읽기 목록에 없다**(가드 확장 필요). 대상 진입점은 이미 있다: `GIT_MENUS.file` 의 항목 하나. 큰 파일 상한·잘림은 `query/diff.go` 의 규약을 물려받으면 된다 | **해소됨 (D8): Diff 탭의 모드.** 고정 탭은 7개로 두고 Diff 탭이 blame 모드를 갖는다. 남은 것 하나 — G9(이전 리비전 연쇄)를 이번에 넣을지는 구현하며 정한다 |
| **280** | reflog 포함 | 목록 질의는 `query/log.go`, 화면 상태와 필터 바는 `history.js`(`_filters`·`_paintBar`). `reflog` 는 가드에 없다 — `log --reflog` 로 가면 넓히지 않아도 된다 | **해소됨.** mute 를 철회했으므로(D7) 남은 결정이 없다 — 질의 인자 하나와 필터 바 항목 하나다 |
| **282** | author override · 리포 전환 드롭다운 | 커밋 옵션은 `write.CommitOpts`(지금 Message·Amend·SignOff·NoVerify·All 뿐) + `GIT_COMMIT_OPTS`. 드롭다운의 정보원은 `app._gitRepos` 이고 헤더는 `panel.js` `_paintHead` | **author 를 어디까지 받는가.** `--author="이름 <메일>"` 한 줄인가, 이름·메일 두 필드인가. 형식이 틀리면 git 이 거부하므로 실행 전 검증 자리가 필요하다 |
| **283** | 3-way merge editor | 충돌 파일은 `status.conflicts`, ours/theirs 는 `write/resolve.go` 가 이미 안다. Monaco 는 `panel.js` 의 diff 뷰(`GitDiffView`)가 들고 있다 | **범위.** 줄 단위 채택까지인가, 표시와 한쪽 채택(이미 있는 `resolve`)까지인가. 전자는 Monaco 위의 별도 모드가 필요하다 |
| **284** | 인터랙티브 rebase | **주의: `core.Env` 가 `GIT_SEQUENCE_EDITOR=true` 를 박는다** (FR-GIT-252 가 `--continue` 의 매달림을 막으려고 넣었다). todo 를 우리가 편집하려면 **그 실행에서만** 다른 값을 줘야 하고, 그 자리는 `ExecWrite` 하나뿐이다 | **todo 를 누가 쓰는가.** dongminal 이 편집기 자리에 서려면 자기 자신을 `GIT_SEQUENCE_EDITOR` 로 세우는 작은 실행 파일이 필요하다 — 그 표면을 열지 여부 |
| **285** | clone / init | `clone`·`init` 둘 다 가드에 없다. init 은 대상 디렉터리만 있으면 끝난다 | **경로를 누가 정하는가.** worktree 는 서버가 정했다(FR-WKT-13) — clone 대상도 같은 규약으로 갈지, 사용자가 절대경로를 주게 할지. **clone 은 인증에 걸린다**: FR-GIT-104 를 유지하므로 실패하면 터미널에서 실행할 명령을 보이는 것까지가 이 요구사항이다 (§1.2 의 미결과 이어진다) |

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-08-27 (2) | 범위 조정. 커밋 **mute 를 철회**하고(D7) 283·284·285 를 다음 판으로 미뤘다(D9). Blame 을 **Diff 탭의 모드**로 확정했다(D8). 이 판의 범위는 `280 → 282 → 276` 이다 |
| 2026-08-27 | 문서 신설. 표면 지도 126항목을 소스와 전수 대조해 **미구현 33항목**을 확정하고 FR-GIT-250~285 로 요구사항화했다. P0 는 남아 있지 않다 — 남은 것은 전부 P1·P2 이며, 그래서 증상이 "보이는데 못 한다"였다. 진행 중 작업(묶음 A)을 다른 묶음의 전제로 앞세운 것이 이 판의 유일한 순서 결정이다 |
