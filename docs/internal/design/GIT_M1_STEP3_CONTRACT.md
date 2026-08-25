# 설계 계약 — M1 3단계 Git 창 (묶음 D, FR-GIT-25~31)

GIT_SRS.md §3.4 를 코드 계약으로 확정한 문서다. 검증은 V8·V19·V20·V21.
**이 단계는 프론트엔드 전용이다.** Go 를 건드리지 않는다(임베드는 glob 이라 자동).

## 0. 파일 배치

| 파일 | 변경 |
|---|---|
| `web/js/constants.js` | Git 창·탭 상수 추가 |
| `web/js/git-panel.js` | **신규** — `GitPanel` 골격 + stale 가드 |
| `web/js/app.js` | `openGitWindow`·`_gitWindow`·`_mkGitWindow`, 탭 삭제·이름변경 방어 |
| `web/js/renderer.js` | `_buildPane` 의 git 탭 분기, 사이드바의 Git 창 표식 |
| `web/index.html` | `git-panel.js` 스크립트 태그 + 캐시 버전 bump |
| `web/style.css` | `git-` 접두 클래스 |
| `e2e/git-window.spec.ts` | **신규** — V8·V19·V20 |

## 1. 데이터 모델 (FR-GIT-25)

### 1.1 창 타입

```js
// 창의 type 은 없을 수 있다. 없으면 'terminal' 이다 — 기존 workspace.json 이
// 그대로 로드돼야 한다 (FR-GIT-25 하위호환).
const WINDOW_TYPE_TERMINAL='terminal';
const WINDOW_TYPE_GIT='git';
```

`constants.js` 에 추가할 것:

```js
// Git 창은 워크스페이스 전체에 1개다 (FR-GIT-26). 이름은 고정 — 활성 리포를
// 이름에 반영하면 창 목록에서 같은 창이 계속 이름을 바꿔 식별성이 떨어진다 (O5).
const GIT_WINDOW_NAME='Git';

// Git 창 내부의 고정 탭. 생성·삭제되지 않는다 (FR-GIT-28).
// pending 인 탭은 M1 에서 자리만 있고 "준비 중" 을 표시한다.
const GIT_VIEWS=[
  {key:'changes',  name:'Changes'},
  {key:'diff',     name:'Diff'},
  {key:'history',  name:'History',  pending:true},
  {key:'branches', name:'Branches', pending:true},
  {key:'stash',    name:'Stash',    pending:true},
  {key:'console',  name:'Console',  pending:true},
];
```

### 1.2 Git 창의 형태

```js
{
  id:'<uuid>', name:'Git', type:'git',
  // 활성 리포는 창에 붙는다 — 창이 곧 Git 표면이므로 (FR-GIT-29).
  git:{repo:null},
  layout:{type:'pane', id:'<uuid>', activeTab:'<changes 탭 id>', tabs:[
    {id:'<uuid>', name:'Changes',  type:'git', gitView:'changes'},
    {id:'<uuid>', name:'Diff',     type:'git', gitView:'diff'},
    {id:'<uuid>', name:'History',  type:'git', gitView:'history'},
    {id:'<uuid>', name:'Branches', type:'git', gitView:'branches'},
    {id:'<uuid>', name:'Stash',    type:'git', gitView:'stash'},
    {id:'<uuid>', name:'Console',  type:'git', gitView:'console'},
  ]}
}
```

- **활성 내부 탭은 `layout.activeTab` 이 이미 영속한다** (FR-GIT-29 절반).
  새 저장 경로를 만들지 않는다.
- **활성 리포는 `window.git.repo`** 다 (FR-GIT-29 나머지 절반).
- 창은 `ws.windows[]` 의 평범한 원소다 — 창 목록·창 전환 단축키·브로드캐스트가
  공짜로 따라온다 (FR-GIT-30·31).
- `_save()` 는 `this.ws` 를 통째로 직렬화하므로 `type`·`git`·`gitView` 는
  추가 배선 없이 영속한다. **`_save()` 를 고치지 않는다.**

### 1.3 하위호환 (FR-GIT-25, 검증 V8)

- `type` 이 없는 기존 창은 그대로 동작한다. 어디서도 `s.type==='terminal'` 로
  비교하지 않는다 — 판정은 항상 `s.type===WINDOW_TYPE_GIT` 의 **부정**이다.
- `init()`·`_applyRemote` 의 layout 정리(`clean`/`normalizeLayout`)가 git 탭을
  버리지 않아야 한다. `clean` 은 `toolId` 가 살아 있는 탭만 남길 가능성이 있으므로
  **반드시 확인하고**, git 탭이 떨어진다면 `helpers.js` 의 해당 함수에 git 탭
  예외를 넣는다. (editor 탭이 이미 같은 문제를 어떻게 넘기는지 먼저 보라.)

## 2. App 메서드 (FR-GIT-26)

```js
// _gitWindow 는 워크스페이스의 Git 창이다. 없으면 null.
_gitWindow(){ return this.ws.windows.find(s=>s&&s.type===WINDOW_TYPE_GIT)||null }

// openGitWindow 는 Git 창을 활성화한다. 없으면 만든다 — **두 번 불러도 창은
// 하나다** (FR-GIT-26). repo 를 주면 활성 리포까지 전환한다 (FR-GIT-15).
// 창 id 를 반환한다.
async openGitWindow(repo){ … }

// _mkGitWindow 는 고정 탭 6개를 갖춘 Git 창을 만든다. 터미널을 만들지 않는다 —
// Git 창의 초기 상태에는 PTY 가 필요 없다.
_mkGitWindow(repo){ … }
```

`openGitWindow(repo)` 의 순서:

1. `_gitWindow()` 가 있으면 그 창을, 없으면 `_mkGitWindow(repo)` 로 만든다.
2. `repo` 가 주어졌고 `win.git.repo` 와 다르면 `win.git.repo=repo` 로 바꾸고
   `this.gitPanel.setRepo(repo)` 를 호출한다 (stale 세대 증가).
3. `switchWindow(win.id)` 로 전환한다. (`switchWindow` 가 이미 `_save`·`render` 를
   한다면 중복 호출하지 않는다 — 기존 구현을 먼저 보라.)
4. 창 id 를 반환한다.

`_mkGitWindow` 는 `_mkWindow` 와 달리 `_newTool()` 을 부르지 않는다.
`newEntityId()` 로 창·pane·탭 6개의 식별자를 만든다.

### 2.1 고정 탭 방어 (FR-GIT-28)

- `closeTab(paneId, tabId)` 는 대상이 git 탭이면 **아무것도 하지 않고 반환**한다.
- `_rename(obj, el)` 경로: git 탭은 dblclick 리스너를 아예 달지 않는다 (§3).
- 탭 드래그(재배치·다른 pane 으로 이동)는 git 탭에서 막는다 — `draggable=false`.
  고정 탭의 자리가 항상 같아야 근육 기억이 선다.
- pane 의 `+`(새 탭) 버튼은 **그대로 둔다.** Git 창 안에 터미널을 배치할 수 있어야
  하기 때문이다 (FR-GIT-27).
- `delWindow` 는 막지 않는다. Git 창을 닫을 수 있고, 다시 열면 새로 만들어진다.

## 3. Renderer (FR-GIT-27·28)

### 3.1 `_buildPane` 의 git 탭 분기

탭 렌더에서 `tab.type==='git'` 이면:
- `×`(`.pn-tab-x`) 를 만들지 않는다.
- `dblclick` 이름변경 리스너를 달지 않는다.
- `t.draggable=false`.
- 탭 요소에 `data-git-view="<key>"` 를 둔다 (e2e 가 잡을 자리).
- 클래스에 `git` 을 더한다.

본문(`.pn-body`) 렌더에서 활성 탭이 git 이면:
```js
const el=this.app.gitPanel.elFor(at.gitView);
body.appendChild(el); el.classList.add('vis');
```
`fileEditors` 와 달리 **탭마다 인스턴스를 만들지 않는다** — `GitPanel` 은
Git 창이 싱글턴이므로 앱에 하나다. view 별 루트 DOM 만 캐시한다.

`_rLayout` 의 정리 루프(`fileEditors` 를 훑어 고아를 destroy 하는 부분)와 나란히,
Git 창이 사라졌으면 `this.app.gitPanel.detach()` 를 호출해 DOM 을 area 로
되돌린다 (인스턴스는 유지 — 다시 열릴 수 있다).

### 3.2 사이드바 (WINDOWS 섹션)

Git 창도 WINDOWS 목록에 나온다 (FR-GIT-30). 구분만 준다:
- `.si` 클래스에 `git` 을 더한다.
- `data-window-type="git"`.
- 이름 dblclick 변경은 막는다 (이름이 고정이므로, O5).

**GIT 섹션(FR-GIT-13)은 이 단계가 아니다** — 4단계다. 여기서 만들지 않는다.

## 4. `GitPanel` 골격 (`web/js/git-panel.js`)

```js
/**
 * Git 창의 표면 전체를 쥔 단일 객체.
 *
 * Git 창은 워크스페이스에 하나이므로(FR-GIT-26) 이 객체도 앱에 하나다. 고정 탭
 * 6개는 각자 루트 DOM 을 갖고, 활성 탭의 루트만 pane 본문에 붙는다.
 *
 * **활성 리포가 바뀌면 진행 중인 응답은 전부 버린다** (FR-GIT-16). 세대 카운터
 * 하나로 판정한다 — 나중에 비동기 경로를 하나씩 훑어 가드를 덧붙이는 상황을
 * 만들지 않으려고 처음부터 둔다.
 */
class GitPanel {
  constructor(app)

  // 활성 리포. Git 창의 win.git.repo 가 진실이고 이것은 그 읽기다.
  get repo()

  // setRepo 는 활성 리포를 바꾸고 세대를 올린다. 같은 값이면 아무 일도 없다.
  setRepo(path)

  // elFor 는 view 의 루트 DOM 을 준다 (없으면 만든다).
  elFor(view)

  // detach 는 모든 루트를 pane 본문에서 떼어낸다. 인스턴스는 살아 있다.
  detach()

  // ── stale 가드 (FR-GIT-16) ──
  // token() 은 지금의 (세대, 리포) 를 뜬다. 비동기 작업 시작 시 부른다.
  token()
  // isStale(tok) 은 그 사이 리포·세대가 바뀌었는지 본다. 응답을 화면에 쓰기
  // **직전마다** 부른다. 참이면 응답을 버린다.
  isStale(tok)
}
```

3단계에서 각 view 의 내용:

| view | 내용 |
|---|---|
| `changes` | 빈 골격 (`<div class="git-view git-changes">`). 5단계가 채운다 |
| `diff` | 빈 골격. 7단계가 채운다 |
| 나머지 4개 | **"준비 중"** 안내 — `<div class="git-pending">` 에 view 이름과 "이후 마일스톤에서 제공됩니다" (FR-GIT-28, 검증 V20) |

리포가 없을 때(`repo` 가 null) `changes`·`diff` 는 "리포를 선택하세요" 를 보인다.

fetch 는 이 단계에서 하지 않는다. `token()`/`isStale()` 만 자리를 잡는다.

## 5. index.html · CSS

- `<script src="js/git-panel.js?v=126"></script>` 를 `renderer.js` **앞**에 둔다
  (`renderer.js`·`app.js` 가 `GitPanel` 을 참조한다).
- 모든 JS 태그의 `?v=125` → `?v=126`, `style.css?v=103` → `?v=104`.
- CSS 는 `style.css` 끝에 `/* ── Git 창 ── */` 구획을 만들어 넣는다.
  클래스 접두는 `git-`. 색은 **테마 CSS 변수만** 쓴다 (하드코딩 금지 — 기존
  구획들이 쓰는 변수명을 먼저 확인해라).

## 6. e2e (`e2e/git-window.spec.ts`)

`e2e/fixtures.ts` 의 `test` 를 쓴다. Git 창을 여는 UI 진입점은 4단계에 생기므로
이 단계는 `page.evaluate(()=>window.app.openGitWindow())` 로 연다.

| # | 검증 | 내용 |
|---|---|---|
| E1 | V8 | `openGitWindow()` 를 두 번 불러도 `type==='git'` 창은 1개다 |
| E2 | V8 | `type` 없는 창을 담은 workspace 를 PUT 하고 새로고침해도 정상 로드된다 |
| E3 | V20 | Git 창의 탭 6개가 순서대로 있다 (`[data-git-view]` 6개, 텍스트 확인) |
| E4 | V20 | `history`·`branches`·`stash`·`console` 탭은 `.git-pending` 을 보인다 |
| E5 | V20 | git 탭에 `×` 가 없다 |
| E6 | V19 | Git 창에서 Split H 로 분할하면 터미널 pane 이 생기고 Git 탭은 남아 있다 |
| E7 | V19 | 창 전환 단축키(`windowNext`)로 Git 창을 지나갈 수 있다 |
| E8 | V21 | Git 창을 만든 뒤 새로고침하면 창·탭·활성 탭이 보존된다 |

기존 스펙의 대기 헬퍼(`waitForInit` 류)를 재사용한다. 새 헬퍼를 만들기 전에
`e2e/fixtures.ts` 와 인접 스펙을 먼저 읽어라.

## 7. 하지 않는 것

- 좌측 GIT 섹션 — 4단계.
- Changes 탭 내용·헤더·파일 목록 — 5단계.
- 폴링·API 호출 — 6단계.
- Diff·Monaco — 7단계.
- 상태바 chip — 8단계.
- Go 코드 어느 것도.
