# 설계 계약 — M4 14~17단계 히스토리 (묶음 L·M, FR-GIT-113~146)

GIT_SRS.md §3C 다. 검증은 V45~V52·V64·V65·V66.
전제: M1~M3 이 끝나 있다.

**15단계(레인 알고리즘)를 16단계(UI)보다 먼저 단위 테스트로 고정한다.**
그래프 버그를 화면으로 디버깅하는 상황을 만들지 않는다 (SRS §6).

## 0. 열린 결정 확정 (M4 해당분)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| O11 | 레인 수 상한 | 데스크톱 **20**, 모바일 **10** | 20 은 실제 저장소에서 압축이 거의 걸리지 않는 값이고, 모바일은 그래프 열이 메시지를 밀어내지 않는 선이다 |
| O12 | 날짜 표시 형식 | **상대시간 기본**, `title` 에 절대시간, 설정 `gitDateFormat: relative\|absolute` 1개 | 5종 설정은 값어치보다 표면이 크다. 절대시간은 hover 로 항상 닿는다 |

## 1. 14단계 — 로그·커밋·refs 조회 (FR-GIT-113, 검증 V45)

```go
// internal/git/log.go

// Commit 은 목록 한 줄이다. 부모 목록이 그래프의 유일한 입력이다 (FR-GIT-117).
type Commit struct {
    Oid        string   `json:"oid"`
    Abbrev     string   `json:"abbrev"`
    Parents    []string `json:"parents"`
    AuthorName string   `json:"authorName"`
    AuthorMail string   `json:"authorMail"`
    AuthorAt   int64    `json:"authorAtUnixMs"`
    CommitAt   int64    `json:"commitAtUnixMs"`
    Subject    string   `json:"subject"`
    Refs       []string `json:"refs"` // %D 의 ref 이름들
}

type LogQuery struct {
    Repo   string
    Ref    string // "" 이면 --all
    Skip   int
    Limit  int
    Order  string // date | author-date | topo
    Author string
    Since  string
    Until  string
    Path   string
    Grep   string
}

func (s *Service) Log(ctx context.Context, q LogQuery) ([]Commit, error)
```

- 포맷은 **NUL 구분**이다 (FR-GIT-113). 메시지에 개행이 있으므로 줄 기반 파싱은
  틀린다.
  `--pretty=format:%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%D%x00%s%x00%x00`
  — 필드 9개 뒤에 빈 필드 하나로 레코드를 끊는다.
- 정렬: `date` → 기본, `author-date` → `--author-date-order`,
  `topo` → `--topo-order` (FR-GIT-128).
- 필터는 가능한 것을 git 옵션으로 내려보낸다 (FR-GIT-130):
  `--author=`, `--since=`, `--until=`, `--grep=`, `-- <path>`.
- `Ref` 가 비면 `--all`. 있으면 그 ref 하나 (FR-GIT-123).
- 페이징은 `--skip=<n> -n <limit>` (FR-GIT-114: 초기 300, 이후 100).
- `%D` 는 `HEAD -> main, origin/main, tag: v1` 형태다. 쉼표로 쪼개고
  `HEAD -> ` 접두를 뗀 뒤 HEAD 표식을 따로 담는다 (FR-GIT-126).

```go
// internal/git/commitdetail.go

type CommitFile struct {
    Status   string `json:"status"`   // M A D R C T
    Path     string `json:"path"`
    OrigPath string `json:"origPath,omitempty"`
    Score    int    `json:"score,omitempty"`
}

type CommitDetail struct {
    Commit
    CommitterName string       `json:"committerName"`
    CommitterMail string       `json:"committerMail"`
    Body          string       `json:"body"`   // 메시지 전문 (FR-GIT-136)
    Files         []CommitFile `json:"files"`  // FR-GIT-137
    ParentIndex   int          `json:"parentIndex"` // 어느 부모와 비교했는지
}

// CommitDetail 은 커밋 하나의 상세다. 머지 커밋은 비교 부모를 골라야 하므로
// parentIndex 를 받는다 (FR-GIT-139).
func (s *Service) CommitDetail(ctx context.Context, repo, oid string, parentIndex int) (CommitDetail, error)
```

- 파일 목록: `diff-tree --no-commit-id --name-status -r -z -m <oid>^<n+1> <oid>`
  — 머지 커밋에서 부모를 지정하려면 `<oid>^<n+1>..<oid>` 를 쓴다. 부모가 없으면
  (루트 커밋) `diff-tree --root` 로 간다.
- `-z` 이므로 rename 은 `R100\0old\0new` 세 조각이다.

```go
// internal/git/refs.go

type Ref struct {
    Name      string `json:"name"`      // refs/heads/main
    Short     string `json:"short"`     // main
    Kind      string `json:"kind"`      // local | remote | tag
    Oid       string `json:"oid"`
    Upstream  string `json:"upstream,omitempty"`
    Ahead     int    `json:"ahead"`
    Behind    int    `json:"behind"`
    IsHead    bool   `json:"isHead"`
    Subject   string `json:"subject,omitempty"`
    AtUnixMs  int64  `json:"atUnixMs"`
}

func (s *Service) Refs(ctx context.Context, repo string) ([]Ref, error)
```

`for-each-ref --format=…%00…` 로 한 번에 얻는다:
`%(refname)`, `%(objectname)`, `%(upstream:short)`, `%(upstream:track)`,
`%(HEAD)`, `%(contents:subject)`, `%(committerdate:unix)`.
`%(upstream:track)` 은 `[ahead 2, behind 1]` 형태 — 정규식으로 뽑는다.

### 1.1 라우트

| 메서드 | 경로 |
|---|---|
| GET | `/api/git/log?repo=&ref=&skip=&limit=&order=&author=&since=&until=&path=&grep=` |
| GET | `/api/git/commit?repo=&oid=&parent=<n>` |
| GET | `/api/git/refs?repo=` |

전부 `requested` 를 에코한다 (stale 가드, FR-GIT-133·145).

## 2. 15단계 — 레인 알고리즘 (FR-GIT-117~121, 검증 V46)

`~/personal/gitmaster-app-electron-pnpm/apps/desktop/src/renderer/features/log/laneLayout.ts`
(128줄)를 `web/js/git-lanes.js` 로 이식한다. TS → JS 는 타입 주석 제거뿐이다.

```js
/**
 * 위→아래로 그리는 DAG 의 레인 배치. 입력 순서 그대로 **단일 전방 패스**다
 * (FR-GIT-117).
 *
 * activeLanes[i] 는 레인 i 가 예약된 부모 해시(또는 null)다.
 *   - 커밋의 레인 = 자기 해시로 예약된 레인, 없으면 첫 빈 레인
 *   - 첫 부모가 커밋의 레인을 물려받고, 나머지 부모는 새 빈 레인을 잡는다
 *   - 이미 다른 곳에 예약된 부모는 머지 진입선만 만든다
 *   - 통과 레인 = 이 행 처리 전후로 모두 살아 있던 레인
 *
 * isNewHead 는 어느 자식도 이 커밋의 레인을 예약하지 않았다는 뜻이다 — 위쪽
 * 진입선을 그리지 않는다 (FR-GIT-121).
 */
function buildLaneGraph(commits){ … }   // {rows:[{hash,lane,passThrough,parentLanes,isNewHead,laneCount}], maxLanes}

// 상한을 넘는 레인은 압축한다 (FR-GIT-120). 상한 이상의 인덱스를 상한-1 로
// 접고 그 행에 압축 표식을 세운다.
function clampLanes(graph, max){ … }    // rows[i].compressed = true
```

**UI 없이 단위 테스트로 먼저 고정한다.** 테스트는 `web/js/__tests__` 가 아니라
Playwright 없이 돌 수 있는 자리에 둔다 — 이 저장소에 JS 단위 테스트 러너가
없으므로 **`e2e/git-lanes.spec.ts` 에서 `page.addScriptTag` 로 파일을 넣고
`page.evaluate` 로 순수 함수를 시험한다.** DOM 을 만들지 않으므로 사실상 단위
테스트다. (새 테스트 러너를 도입하지 않는다.)

고정 그래프 형태 (FR-GIT-117·121, 검증 V46) — 각각 기대 레인을 표로 못박는다:

| # | 형태 | 확인 |
|---|---|---|
| L1 | 선형 (A→B→C) | 전부 lane 0, passThrough 없음, A 만 isNewHead |
| L2 | 분기 (A,B 가 같은 부모 C) | A lane 0, B lane 1, C lane 0, B 의 parentLanes=[0] |
| L3 | 머지 (M 의 부모 2개) | M lane 0, parentLanes=[0,1] |
| L4 | 옥토퍼스 (부모 4개) | parentLanes 길이 4, 서로 다른 레인 |
| L5 | 교차 (레인이 비었다 재사용됨) | 빈 레인이 재사용되고 passThrough 가 정확하다 |
| L6 | 상한 초과 | `clampLanes(g, 3)` 이 lane>=3 을 접고 `compressed` 를 세운다 |
| L7 | 루트 커밋 (부모 0개) | parentLanes 비었고 레인이 해제된다 |
| L8 | 브랜치 머리 | isNewHead 가 참인 행만 위쪽 진입선을 갖지 않는다 |

## 3. 16단계 — History 탭 (FR-GIT-114~134)

```
.git-view.git-history
├ .git-hist-bar     검색 · 정렬 · author/date/path 필터 · jump
├ .git-hist-main
│   ├ .git-refs     ← refs 사이드바 (FR-GIT-122·123)
│   └ .git-hist-list  ← 가상 스크롤 (FR-GIT-116)
```

### 3.1 가상 스크롤 (FR-GIT-116, 검증 V48)

- 고정 행 높이(`GIT_HIST_ROW_H`, 기본 26px)로 계산한다. 가변 높이를 쓰지 않는다 —
  10,000행에서 측정 비용이 스크롤을 먹는다.
- 스페이서 두 개(위·아래) + 보이는 구간만 DOM 에 둔다.
  **DOM 노드 수는 로드된 커밋 수가 아니라 화면 행 수에 비례해야 한다.**
- 인라인 상세(FR-GIT-135)가 펼쳐지면 그 행만 높이가 다르다. 펼친 행 하나의
  높이를 예외로 들고 오프셋 계산에 더한다 (**펼침은 한 번에 하나만** 허용한다 —
  여러 개를 허용하면 가변 높이 문제가 되돌아온다).
- 끝에 닿으면 100개 추가 로드 (FR-GIT-115). 로딩 중 표시를 둔다.

### 3.2 행별 인라인 SVG (FR-GIT-118·119, 검증 V47)

- 각 행의 그래프 칸에 `<svg width=laneW*maxLanes height=rowH>` 를 넣는다.
  **캔버스를 쓰지 않는다** — 가상 스크롤에서 캔버스는 좌표 재계산이 필요하고
  테마 연동이 안 된다.
- 그리는 것: 통과 레인의 수직선, 커밋 점, 부모로 가는 선(같은 레인이면 수직,
  다른 레인이면 베지어), `isNewHead` 가 아니면 위쪽 진입선.
- **색은 테마 팔레트에서 파생한다** (FR-GIT-119). 하드코딩 금지.
  `getComputedStyle(document.documentElement)` 에서 기존 변수
  (`--accent`, `--text`, `--green`, … 실제 이름은 `style.css` 를 확인)를 읽어
  레인 색 배열을 만들고, `lane % colors.length` 로 고른다.
  테마 전환 시 다시 계산한다 — 테마 적용 함수(`applyThemeObj`)에 훅을 건다.
- 정적 검증: `git-history.js`·`git-lanes.js` 에 `#rrggbb`·`rgb(` 리터럴이 없음을
  e2e 또는 스크립트로 확인한다 (V47).

### 3.3 컬럼과 반응형 (FR-GIT-124·125)

컬럼: 그래프 · 메시지(+ref 배지) · Author · Date · Commit(해시).
폭이 줄면 **Commit → Date → Author** 순으로 숨긴다. 그래프와 메시지는 항상 남는다.
`ResizeObserver` 로 `.git-hist-list` 폭을 보고 클래스를 토글한다
(`.hide-hash`, `.hide-date`, `.hide-author`). 미디어 쿼리는 창 폭이라 쓸 수 없다 —
Git 창은 분할 안에 있을 수 있다.

### 3.4 refs 사이드바 (FR-GIT-122·123)

로컬 / 원격 / 태그 3그룹 트리. 선택 → `LogQuery.Ref` 로 필터. 해제 → `--all`.
선택 상태는 리포별로 `localStorage`.

### 3.5 미커밋 변경 행 (FR-GIT-127)

변경이 있으면 목록 최상단에 `.git-hist-row.uncommitted` 를 둔다.
클릭 → Changes 탭으로 전환 (표면 지도 S4 의 "미커밋 변경 — Changes 탭 열기").

### 3.6 검색 (FR-GIT-129, 검증 V49)

두 모드를 **화면에 구분해 보인다:**
- `로드된 범위` — 이미 받은 커밋만 클라이언트에서 필터. 즉시.
- `저장소 전체` — `grep` 을 git 에 내려보낸다. 느리다.

전환 토글과 현재 모드 라벨을 검색 입력 옆에 둔다. **두 결과가 다를 수 있음이
드러나야 한다** — 로드 범위 모드에서 결과가 0이면 "로드된 300개 중에는 없습니다.
저장소 전체를 검색하시겠습니까?" 를 보인다.

### 3.7 jump (FR-GIT-131)

해시·브랜치·태그 입력 → `rev-parse` 로 해석 → 목록에서 찾는다. 없으면
그 커밋이 나올 때까지 추가 로드한 뒤 스크롤한다. 상한(`GIT_JUMP_MAX_PAGES`,
기본 20페이지)을 두고 초과하면 "찾지 못했습니다" 를 보인다.

### 3.8 실패와 전환 (FR-GIT-132·133)

- 로드 실패: 사유를 보이고 **이미 로드된 목록을 지우지 않는다.**
- 리포 전환: 목록·필터·선택을 초기화하고 이전 리포 응답을 폐기한다
  (`GitPanel.token()`/`isStale`).

## 4. 17단계 — 커밋 상세 + 컨텍스트 메뉴 프레임워크 (FR-GIT-135~146)

### 4.1 인라인 펼침 (FR-GIT-135~139, 검증 V51)

- 커밋 행 클릭 → **그 행 아래에** `.git-hist-detail` 을 삽입한다.
  별도 고정 영역을 두지 않는다.
- 내용: 전체 해시, 부모 해시(들), author/committer, 날짜, 메시지 전문, 변경 파일.
- 머지 커밋은 부모 선택 드롭다운을 둔다 (FR-GIT-139). 기본은 첫 부모.
- 파일 클릭 → Diff 탭, 축 `commit-parent` (7단계에 축을 추가한다).

**7단계에 추가할 축:**

| axis | original | modified |
|---|---|---|
| `commit-parent` | `git show <parentOid>:<origPath>` | `git show <oid>:<path>` |

요청 파라미터에 `oid`·`parentOid` 를 더한다. `requested` 에 함께 실어 stale
가드의 식별자(리포, 축, 경로, 리비전)를 완성한다 (FR-GIT-54·145).

### 4.2 컨텍스트 메뉴 프레임워크 (FR-GIT-146, 검증 V52)

**표면 지도 S4 의 46개 항목이 이 위에 선형으로 얹힌다.** 대상 종류별로 항목
집합을 **선언**하면 렌더·키보드 조작·닫기가 공통 경로를 탄다.

```js
// web/js/git-menu.js

/**
 * 대상 종류(커밋·브랜치·태그·스태시·파일·미커밋)별 항목 집합을 선언하면
 * 렌더·키보드 조작·닫기가 공통 경로를 탄다 (FR-GIT-146).
 *
 * 5단계가 만든 파일 우클릭 메뉴(.git-ctxmenu)를 이것으로 흡수한다 — 같은 것을
 * 두 번 만들지 않는다.
 */
const GIT_MENUS={
  commit:[
    {id:'branch-from', label:'여기서 브랜치 생성…', run:…},   // FR-GIT-141
    {id:'copy-hash',   label:'커밋 해시 복사',      run:…},   // FR-GIT-142
    {id:'copy-subject',label:'커밋 제목 복사',      run:…},   // FR-GIT-143
    {sep:true},
    {id:'checkout-detached', label:'Checkout (detached)', warn:true, run:…}, // FR-GIT-144
  ],
  file:[…], branch:[…], tag:[…], stash:[…], uncommitted:[…],
};

// GitMenu.open(kind, target, ev) — 항목 집합을 렌더하고 키보드 조작을 붙인다.
class GitMenu {
  static open(kind, target, ev)
  static close()
}
```

공통 규약:
- `↑`/`↓` 이동, `Enter` 실행, `Esc`·바깥 클릭·스크롤·리사이즈로 닫힘.
- 화면 경계에서 위치를 뒤집는다.
- `disabled(target)` 을 선언할 수 있고, disabled 항목은 사유를 `title` 에 보인다.
- `warn:true` 항목은 실행 전 1단계 확인을, `destructive:true` 항목은 9단계의
  `GitConfirm` 2단계 확인을 자동으로 거친다. **각 항목이 확인 코드를 따로 쓰지
  않는다.**
- `Checkout (Detached)` (FR-GIT-144): detached 가 됨을 사전 경고하고, dirty 면
  M5 묶음 N 의 처리(FR-GIT-157)를 따른다. M4 시점에는 dirty 면 차단하고
  "M5 에서 제공됩니다" 를 보인다 — **강제를 기본으로 만들지 않는다.**

V52: 항목 집합만 선언한 가짜 kind 로 렌더·키보드·닫기가 동작함을 e2e 로 확인한다.

## 5. 성능 (검증 V48)

- 10,000 커밋 목록에서 스크롤 중 프레임 저하가 없어야 한다.
- `document.querySelectorAll('.git-hist-row').length` 가 화면 행 수 + 여유분
  이하임을 e2e 로 확인한다. 로드된 커밋 수에 비례하면 실패다.
- 테스트 저장소는 `git commit --allow-empty` 를 10,000회 돌리는 대신
  `git fast-import` 로 만든다 (수십 초 → 1초 미만).

## 6. 하지 않는 것

- cherry-pick / revert / reset 실행 — 메뉴 자리만 프레임워크가 열어 둔다.
- merge / rebase 실행 — 같음.
- blame / file history — 이후.
- commit range 비교 — 이후.
