# 설계 계약 — M1 4단계 좌측 GIT 섹션 (묶음 B 클라이언트, FR-GIT-13~17)

GIT_SRS.md §3.2 의 클라이언트 절반이다. 검증은 V17(신규)·V3·V7·V16.
전제: 2단계(`/api/git/repos`·`/pin`·`/unpin`)와 3단계(Git 창·`GitPanel`)가 끝나 있다.

계약 문서: `./GIT_M1_STEP2_CONTRACT.md` §5.2~5.5, `./GIT_M1_STEP3_CONTRACT.md`.

## 0. 파일 배치

| 파일 | 변경 |
|---|---|
| `web/index.html` | 사이드바에 GIT 섹션 마크업 + 캐시 버전 bump |
| `web/style.css` | `/* ── Git 사이드바 ── */` 구획 (섹션 스크롤·배지·항목) |
| `web/js/constants.js` | 리포 목록 갱신 주기 상수 |
| `web/js/app.js` | `_gitReposRefresh`·`_gitPin`·`_gitUnpin`·`_gitFocusToolId` |
| `web/js/renderer.js` | `_rGitSection` |
| `e2e/git-sidebar.spec.ts` | **신규** — V17·V16 |

**`web/js/git-panel.js` 를 건드리지 않는다** — 5·6단계가 그 파일을 쥔다.

## 1. 마크업 (FR-GIT-13·17)

`web/index.html` 의 `#sidebar` 를 두 섹션 구조로 만든다.

```html
<div id="sidebar">
  <div class="sb-title">Windows</div>
  <button id="add-window">+ New</button>
  <button id="add-preset" …>★ Preset</button>
  <div id="windows"></div>

  <div class="sb-title git-sec-title">Git</div>
  <div id="git-repos"></div>
  <button id="git-add-repo" title="리포 추가">+ Add</button>

  <button id="settings-btn" title="Settings">⚙</button>
</div>
```

**FR-GIT-17 — 두 섹션이 서로를 굶기지 않아야 한다:**

- `#windows` — `flex:1 1 auto; min-height:0; overflow-y:auto`
- `#git-repos` — `flex:0 1 auto; min-height:0; max-height:40%; overflow-y:auto`
- `#sidebar` 는 이미 flex column 이어야 한다. 아니라면 그렇게 만든다.
- `min-height:0` 이 없으면 flex 자식이 줄어들지 않아 한쪽이 화면 밖으로 밀린다.
  **이것이 FR-GIT-17 의 실체다.**

## 2. 항목 렌더 (`renderer.js` 의 `_rGitSection`)

`render()` 에서 `_rSidebar()` 다음에 `_rGitSection()` 을 부른다.

데이터는 `this.app._gitRepos` 다 (§3). 없으면 섹션 본문을 비운다.

### 2.1 follow 항목 (FR-GIT-9·10)

```
⟳ dongminal   ③
```

- `.git-repo.follow` 클래스. `data-git-repo="<path>"`.
- `isRepo:false` 면 `⟳ 저장소 아님` 을 `.git-repo.follow.norepo` 로 흐리게 보이고
  **클릭 불가**(`pointer-events` 가 아니라 리스너를 달지 않는다). `title` 에
  `reason` 과 `cwd` 를 보인다. **마지막 유효 리포를 남기지 않는다** (FR-GIT-10).

### 2.2 핀 항목 (FR-GIT-11)

```
📌 gitmaster  ①  ×
```

- `.git-repo.pinned`. `data-git-repo="<path>"`.
- `×`(`.git-repo-x`) 클릭 → `app._gitUnpin(path)`. 클릭 전파를 막는다.
- `isRepo:false` 면 `.norepo` 로 흐리게 보이되 **목록에서 지우지 않는다.**
  `×` 는 그대로 동작해야 한다 (사라진 리포를 사용자가 지울 수 있어야 한다).

### 2.3 배지 (FR-GIT-14·24, O4)

- `badge` 가 null 이면 배지를 그리지 않는다.
- `badge.total===0` 이면 배지를 그리지 않는다 (0 을 보일 이유가 없다).
- `.git-badge` 에 `total` 을 넣는다.
- **활성 리포가 아니면** `.git-badge.stale` 을 더해 흐리게 하고
  `title="최신 아님 (마지막 관측: <시각>)"` 을 붙인다 (O4).
  활성 리포 판정은 `this.app.gitPanel.repo === path`.
- 시각은 `new Date(badge.observedAtUnixMs).toLocaleTimeString()`.

### 2.4 활성 표시와 클릭 (FR-GIT-15)

- 활성 리포 항목에 `.active` 를 더한다.
- 클릭 → `app.openGitWindow(path)`. **Git 창을 활성화하고 활성 리포를 그것으로
  전환한다** (3단계의 `openGitWindow` 가 이미 둘 다 한다).

## 3. App 배선

```js
// constants.js
// GIT 섹션 목록 갱신 주기(ms). 배지는 서버의 마지막 관측값이라 자주 부를 이유가
// 없다 — 이 호출은 git 을 실행하지 않는다 (FR-GIT-24).
const GIT_REPOS_POLL_MS=3000;
```

```js
// app.js
// _gitFocusToolId 는 follow 가 딛는 도구다 — 포커스된 터미널 칸의 도구.
// 없으면 빈 문자열이고 서버는 자기 cwd 를 쓴다.
_gitFocusToolId(){ … }

// _gitReposRefresh 는 GIT 섹션의 목록을 갱신한다. 실패는 조용히 넘기지 않고
// 이전 목록을 유지한다 — 네트워크 한 번 튀었다고 섹션이 비면 안 된다.
async _gitReposRefresh(){ … }

// _gitPin 은 경로를 검증해 핀한다. 저장소가 아니면 사유를 보인다 (FR-GIT-12).
async _gitPin(path){ … }
async _gitUnpin(path){ … }
```

- `_gitReposRefresh` 는 `GET /api/git/repos?tool=<toolId>` 를 부르고 결과를
  `this._gitRepos` 에 넣은 뒤 `_rGitSection()` 만 다시 그린다 (전체 `render()` 를
  부르지 않는다 — 터미널 재부착 비용이 크다).
- 503/`git_unavailable` 이면 섹션 전체를 숨긴다 (`#git-repos`·제목·`+ Add`).
  git 이 없는 환경에서 빈 섹션이 자리를 차지하지 않게 한다.
- 갱신 시점:
  1. `init()` 끝에서 1회
  2. `GIT_REPOS_POLL_MS` 주기 — **`document.hidden` 이면 건너뛴다**
     (`_startStatsPoll` 의 선례를 그대로 따른다, FR-STAT-17)
  3. `visibilitychange` 로 다시 보이면 즉시 1회
  4. `setFocus`(칸 포커스 변경) 뒤 — follow 대상이 바뀔 수 있다
  5. `_gitPin`·`_gitUnpin` 성공 뒤
  6. `gitPanel` 이 상태를 새로 관측한 뒤 (6단계가 이 훅을 부른다. 지금은
     `app._gitReposRefresh` 가 존재하기만 하면 된다)

### 3.1 `+ Add` (FR-GIT-12)

`#git-add-repo` 클릭 → 경로 입력을 받는다.

- 기존 코드에 모달·프롬프트 유틸이 있는지 **먼저 확인**하고 있으면 그것을 쓴다.
  없으면 `window.prompt` 를 쓴다 (M1 범위에서 새 모달 프레임워크를 만들지 않는다 —
  다이얼로그 공통 규약은 M5 묶음 P 다).
- 기본값은 현재 `_cwd` 다.
- `POST /api/git/repos/pin` → 실패 응답의 `error`·`message` 를 사용자에게 보인다.
  **조용히 실패하지 않는다.** 기존 알림 수단(토스트가 있으면 그것, 없으면 `alert`)을
  쓴다. 있는지 먼저 확인해라.

## 4. e2e (`e2e/git-sidebar.spec.ts`)

리포 픽스처는 테스트가 직접 만든다: `request.post('/api/git/repos/pin', {data:{path:<repo>}})`.
저장소 하나는 프로젝트 자신(`process.cwd()`)을 쓸 수 있다. 저장소가 아닌 경로는
`/tmp` 같은 것을 쓴다 — **단 `/tmp` 가 상위에 git 저장소를 갖지 않는지 확인**하고,
확실하지 않으면 테스트가 `os.tmpdir()` 아래에 빈 디렉터리를 만들어 쓴다.

`e2e/fixtures.ts` 의 `resetWorkspace` 가 `{"schemaVersion":2,"windows":[]}` 를 PUT 해서
`git.pinned` 를 지운다. **각 테스트가 필요한 핀을 스스로 만든다.**

| # | 검증 | 내용 |
|---|---|---|
| S1 | V17 | GIT 섹션 제목·`+ Add`·`#git-repos` 가 있다 |
| S2 | V3·V17 | follow 항목이 프로젝트 저장소를 가리킨다 |
| S3 | V16 | 저장소가 아닌 경로 pin 이 거부되고 목록이 안 바뀐다 |
| S4 | V16 | pin 한 리포가 `📌` 항목으로 나오고, `×` 로 사라진다 |
| S5 | V17 | 항목 클릭이 Git 창을 활성화하고 그 리포를 활성으로 만든다 |
| S6 | V7·V17 | 핀이 여러 개일 때 활성이 아닌 항목의 배지에 `.stale` 이 붙는다 |
| S7 | V17 | 창을 많이 만들어 WINDOWS 목록이 길어져도 GIT 섹션이 보인다 (`#git-repos` 가 화면 안) |

## 5. 하지 않는 것

- `web/js/git-panel.js` — 5·6단계의 파일이다.
- 폴링(signature·status)·상태 표시 — 5·6단계.
- 상태바 chip — 8단계.
- 다이얼로그 공통 프레임워크 — M5 묶음 P.
