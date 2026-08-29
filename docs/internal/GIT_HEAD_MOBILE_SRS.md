# SRS: Git 머리의 왼쪽 정렬 · History 이식 · 모바일 폭 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

접수한 말은 셋이다.

> 1. **"깃쪽에 상단 버튼들 지금은 오른쪽으로 치우쳐져 있는데 왼쪽으로 치우쳐지도록 해줘."**
> 2. **"히스토리 탭에도 changes 상단에 있는 버튼들 넣어줘."**
> 3. **"모바일에서 깃 창이 넓다보니까 다 보이지 않아. 사이즈에 맞게 모바일 레이아웃 생각해줘."**

셋은 **같은 한 줄** 을 가리킨다 — Changes 탭 맨 위의 `.git-head` 다. 지금 그 줄은
① `.git-head-spacer` 로 버튼을 오른쪽 끝까지 밀고, ② Changes 탭에만 있고,
③ 좁은 폭에서 줄바꿈 없이 잘린다.

### 1.2 범위 (Scope)

**포함:** `.git-head` 의 배치 규약, `.git-head` 의 History 이식과 그에 따르는
칠하기·동작 배선, `.git-head` 의 좁은 폭 대응, 모바일에서의 Git 창 탭 여백.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **머리 (head)** | `.git-head` 한 줄. 리포명·브랜치·배지·↑↓ + 새로고침·Sync·Push preview·Fetch/Pull/Push(각 `▾`) |
| **정보부** | 머리 앞쪽의 `.git-head-repo`·`.git-head-branch`·`.git-head-badges`·`.git-head-ab` |
| **동작부** | 머리 뒤쪽의 버튼 전부 (`.git-head-refresh` · `.git-remote-sync` · `.git-push-preview` · `.git-head-remote`) |
| **작업 화면** | `.git-job`. 원격 작업 하나의 진행·로그·실패 사유 (FR-GIT-102~108) |
| **모바일** | `body.mobile`. `displayMode` 가 정한다 — 미디어쿼리가 아니다 |

### 1.4 참조 (References)

- [`./GIT_SRS.md`](./GIT_SRS.md) — FR-GIT-32·33·40 (머리), FR-GIT-98~112 (원격), FR-GIT-113~139 (History)
- [`./GIT_UI_REVISION_SRS.md`](./GIT_UI_REVISION_SRS.md) — FR-GIT-238 (새로고침 버튼의 자리), FR-GIT-282 (리포명이 전환 자리)
- [`./GIT_REVIEW4_SRS.md`](./GIT_REVIEW4_SRS.md) — FR-RPT-1 (관측이 같으면 그리지 않는다)
- [`./GIT_REPO_MISSING_SRS.md`](./GIT_REPO_MISSING_SRS.md) — FR-RMS-19 (소실 상태의 머리)
- [`./GIT_VIEW_REFRESH_SRS.md`](./GIT_VIEW_REFRESH_SRS.md) — FR-GVR-8 (Changes 밖의 뷰도 폴링을 딛는다)

---

## 2. 전체 설명 (Overall Description)

### 2.1 현재 구조 — 조사로 확정한 사실

```
web/js/git/panel.js:350-361   .git-head 골격을 만드는 유일한 자리 (_buildChanges 안)
web/js/git/panel.js:496-520   _paintHead(el,s) — 정보부를 칠한다
web/js/git/panel.js:433-438   새로고침·리포 전환의 배선
web/js/git/remote.js:57-86    bind(el) — 동작부 + 작업 화면의 배선이 한 덩어리
web/js/git/remote.js:93-108   _addButtons(el) — Sync·Push preview 를 머리에 끼워 넣는다
web/js/git/remote.js:151-170  _paintButtons(el) — 동작부의 막힘 상태
web/style.css:725-767         .git-head 의 생김새. .git-head-spacer{flex:1 1 auto}
web/js/git/history.js:97-131  History 골격. 머리 없이 .git-hist-bar 로 시작한다
```

현재 머리의 자식 순서:

```
[repo][branch][badges][ab] [spacer←늘어남] [⟳][Sync][Preview][Fetch▾][Pull▾][Push▾]
```

### 2.2 관측한 결함 — 390×844 (Pixel 급 폭) 실측

`e2e` 인프라로 `displayMode='mobile'`, viewport 390×844 에서 일곱 탭을 전부 열어
가로 넘침을 측정했다.

| 탭 | 뷰 clientWidth | 넘치는 요소 |
|---|---|---|
| **Changes** | 386 | `.git-head-remote` 와 그 자식 6개 — 오른쪽으로 **최대 172px** |
| History | 386 | 없음 (`.git-hist-bar` 는 이미 `flex-wrap:wrap`) |
| Branches · Stash · Worktrees · Console | 386 | 없음 |

즉 **잘리는 것은 머리 하나다.** `.git-hist-bar` 가 이미 줄바꿈으로 해결한 문제를
머리만 해결하지 않고 있다. 이것이 §1.1 의 세 번째 말의 정체다.

`.pn-tabs` 는 `overflow-x:auto` 라 잘리지는 않으나, 390px 에서 일곱 번째 탭
(`Worktrees`)이 화면 밖에 있어 가로로 밀어야 닿는다.

### 2.3 제약 (Constraints)

| # | 제약 |
|---|------|
| C-1 | `.git-head-refresh` 는 `.git-head-remote` **밖**에 있어야 한다 — 안에 넣으면 "원격 버튼 한 벌은 세 쌍" 을 세는 기존 e2e 단정이 깨진다 (FR-GIT-238) |
| C-2 | `.git-remote-sync`·`.git-push-preview` 도 같은 이유로 `.git-head-remote` 밖이다 |
| C-3 | 폴링(1초)마다 지나는 경로다. 스크롤·선택·입력 중인 값을 건드리면 안 된다 (FR-RPT-1) |
| C-4 | 자산 버전(`web/index.html` 의 `?v=`)을 올리지 않으면 고친 것이 화면에 닿지 않는다 (커밋 71bf644) |

---

## 3. 요구사항 (Specific Requirements)

### 3.1 머리의 배치 (FR-GHM-1~2)

**FR-GHM-1** — 머리의 자식 순서는 **정보부 → 동작부 → 여백** 이다. 남는 공간은
동작부의 **오른쪽**에 놓인다.

```
[repo][branch][badges][ab] [⟳][Sync][Preview][Fetch▾][Pull▾][Push▾] [spacer←늘어남]
```

**FR-GHM-2** — 동작부 내부의 순서는 바뀌지 않는다: 새로고침 → Sync → Push preview
→ Fetch/Pull/Push. C-1·C-2 의 소속 관계도 그대로다.

### 3.2 History 로의 이식 (FR-GHM-3~7)

**FR-GHM-3** — History 탭 최상단에 Changes 와 **같은 머리**를 싣는다. 자식 구성·
순서·라벨·동작이 Changes 의 것과 같다. 자리는 `.git-hist-bar` **위**다.

**FR-GHM-4** — 머리를 만드는 마크업은 **한 자리에만** 있다. 두 벌로 두면 한쪽에만
버튼이 늘어난다.

**FR-GHM-5** — 두 머리는 **하나의 관측**(`/api/git/status`)을 딛는다. 폴링이 새
status 를 받으면 두 머리의 리포명·브랜치·배지·↑↓ 가 함께 갱신된다.

**FR-GHM-6** — 원격 버튼의 막힘 사유(FR-GIT-101: 진행 중이면 같은 리포의 원격
동작 전부가 막힌다)는 **두 머리에 동시에** 적용된다. 한쪽만 막히면 사용자는
History 에서 두 번째 push 를 띄울 수 있다.

**FR-GHM-7** — History 에서 누른 원격 동작의 진행·로그·실패는 Changes 탭의 작업
화면(`.git-job`)에서 보인다. 작업 화면을 History 에 복제하지 않는다 — 하나의
작업에 화면이 둘이면 어느 쪽이 참인지 알 수 없다.

> 근거: 작업 화면은 취소·로그 보존·인증 안내를 들고 있고, 그 상태는 `GitRemote`
> 하나에 산다. 화면만 둘로 늘리면 접기/펼치기 같은 사용자의 뜻이 두 벌이 된다.

**FR-GHM-8** — 리포가 없거나 소실 상태이면 History 는 지금과 같다 — 안내만 보이고
머리는 서지 않는다 (FR-RMS-19 의 규약을 바꾸지 않는다).

### 3.3 좁은 폭 (FR-GHM-9~12)

**FR-GHM-9** — 머리는 폭이 모자라면 **잘리지 않고 줄바꿈한다**. 이 성질은 모바일
전용이 아니다 — 분할 칸에 놓인 좁은 Git 창에서도 같다.

**FR-GHM-10** — 모바일에서 머리의 여백(`.git-head-spacer`)은 자리를 차지하지
않는다. 줄바꿈된 마지막 줄의 빈 공간을 여백이 다시 먹으면 뜻이 없다.

**FR-GHM-11** — 모바일에서 머리의 간격·안여백을 줄이고, 버튼의 세로 크기를 터치
대상 크기(≥28px)로 한다. 390px 폭에서 머리는 **두 줄 이내**에 든다.

**FR-GHM-12** — 모바일에서 Git 창의 고정 탭 일곱 개가 390px 폭 안에 들어간다.

### 3.4 검증 (Verification)

스펙: [`e2e/git-head-mobile.spec.ts`](../../e2e/git-head-mobile.spec.ts)

| V | 확인 |
|---|------|
| V1 | Changes 머리에서 `.git-head-spacer` 가 `.git-head-remote` **뒤**에 온다 (FR-GHM-1) |
| V2 | `.git-head-refresh` 는 여전히 `.git-head` 안·`.git-head-remote` 밖이고, `.git-head-remote button` 은 여섯이다 (C-1, FR-GHM-2) |
| V3 | History 탭에 `.git-head` 가 하나 있고, 그 안의 `.git-head-remote button` 이 여섯이다 (FR-GHM-3) |
| V4 | History 머리의 `.git-head-repo`·`.git-head-branch` 가 Changes 의 것과 같은 값이다 (FR-GHM-5) |
| V5 | History 머리의 `.git-head-repo` 를 누르면 리포 전환 메뉴가 뜬다 (FR-GHM-3) |
| V6 | History 머리의 `⟳` 를 누르면 새로고침이 돈다 (FR-GHM-3) |
| V7 | 원격 작업이 도는 동안 **두 머리 모두** 원격 버튼이 `disabled` 다 (FR-GHM-6) |
| V8 | History 탭에 `.git-job` 이 없다 (FR-GHM-7) |
| V9 | 리포 없음 상태의 History 에 `.git-head` 가 없다 (FR-GHM-8) |
| V10 | 390px 폭·모바일에서 Changes 뷰의 `scrollWidth === clientWidth` 이고, 머리 안의 어떤 요소도 뷰의 오른쪽 경계를 넘지 않는다 (FR-GHM-9) |
| V11 | 같은 조건에서 History 뷰도 넘치지 않는다 (FR-GHM-9) |
| V12 | 390px 폭·모바일에서 머리의 높이가 두 줄분 이하다 (FR-GHM-11) |
| V13 | 390px 폭·모바일에서 `.pn-tab[data-git-view]` 일곱 개가 전부 뷰포트 안에 있다 (FR-GHM-12) |

---

## 4. 설계 (Design)

### 4.1 머리를 한 자리에서 만든다 (FR-GHM-4)

`GitPanel.headHTML()` 정적 메서드가 머리 마크업의 **유일한 출처**가 된다.
`GitPanel._wireHead(el)` 가 그 머리에 라벨·새로고침·리포 전환·원격 동작을 붙인다.

- `_buildChanges` 는 인라인 리터럴 대신 `GitPanel.headHTML()` 을 쓰고 `_wireHead(el)` 를 부른다.
- `GitHistory.mount` 는 골격 맨 앞에 `GitPanel.headHTML()` 을 놓고 `panel._wireHead(el)` 를 부른다.

### 4.2 배선의 분리 (FR-GHM-6·7)

`GitRemote.bind(el)` 이 지금 **동작부와 작업 화면을 한 덩어리로** 붙인다. 이것을
쪼갠다.

| 새 메서드 | 대상 | 하는 일 |
|---|---|---|
| `bindHead(head)` | 머리 하나 | Sync·Preview 끼워 넣기 + 원격 버튼 6개 + Sync·Preview 의 클릭 |
| `bind(el)` | Changes 뷰 | 작업 화면(`.git-job`)의 클릭만 |
| `paintHead(head)` | 머리 하나 | 동작부의 `disabled`·`title` |
| `paint(el)` | Changes 뷰 | 충돌 판정 + 작업 화면 칠하기 |

### 4.3 칠하기의 배분 (FR-GHM-5·6)

| 경로 | 하는 일 |
|---|---|
| `GitPanel._paintHeadIn(el)` | 머리 하나. `_paintHead(el,s)` + `_remote().paintHead(head)`. 머리가 없으면 무동작 |
| `GitPanel.paintHeads()` | 만들어진 뷰 전부를 돌며 `_paintHeadIn`. **목록을 따로 적지 않는다** — 머리가 있는 뷰가 곧 대상이다 |
| `GitPanel._paintChanges` | 기존 `_paintHead` 자리에서 `_paintHeadIn` 을 부른다 |
| `GitPanel._paint` (폴링) | Changes 밖의 머리를 위해 History 의 머리를 따로 칠한다 — `paintStatus` 는 근거를 좁혀 거르므로(FR-RPT-1) 거기에 업힐 수 없다 |
| `GitRemote._paint` (작업 상태 변화) | Changes 의 작업 화면 + `panel.paintHeads()` |

### 4.4 CSS

| 규칙 | 근거 |
|---|---|
| `.git-head{flex-wrap:wrap}` | FR-GHM-9 |
| `.git-head-spacer` 를 마크업 마지막으로 | FR-GHM-1 |
| `.git-view.git-history>.git-head{position:relative;z-index:1}` | Changes 와 같은 쌓임 순서 |
| `body.mobile .git-head{gap:6px;padding:6px 8px}` · `.git-head-remote{gap:2px}` | FR-GHM-11 |
| `body.mobile .git-head-spacer{display:none}` | FR-GHM-10 |
| `body.mobile` 의 머리 버튼 `min-height:28px` | FR-GHM-11 |
| `body.mobile .pn-tab[data-git-view]{padding:0 8px}` | FR-GHM-12 |

---

## 5. 이전 동작 / 새 동작

| | 이전 | 새 |
|---|---|---|
| Changes 머리의 버튼 | 오른쪽 끝 | 정보부 바로 뒤 (왼쪽) |
| History 머리 | 없음 | Changes 와 같은 머리 |
| 좁은 폭의 머리 | 잘린다 | 줄바꿈한다 |
| 모바일 Git 탭 | 일곱 번째가 화면 밖 | 일곱 개가 들어간다 |
| 작업 화면 | Changes 에만 | 그대로 (Changes 에만) |

---

## 6. 비목표 (Non-goals)

- 소실 상태(FR-RMS-19)의 머리 규약 — Changes 만 머리를 세운다. 그대로 둔다.
- 커밋 영역·작업 화면·파일 목록을 History 로 옮기는 것.
- Branches·Stash·Worktrees·Console·Diff 에 머리를 다는 것 — 접수한 말은 History 다.
- `.git-hist-bar`·`.git-refs`·`.git-stash-preview` 등 다른 바의 재배치 — §2.2 실측에서 넘치지 않는다.
- `.git-head-remote` 안쪽에서 버튼과 `▾` 사이에 4px 간격이 벌어져 한 벌로 보이지
  않는 기존 생김새 — 접수한 말 밖이다.

---

## 7. 리스크

| 리스크 | 등급 | 완화 |
|---|---|---|
| History 의 머리가 기존 e2e 의 `.git-head*` 단정을 깨뜨린다 | LOW | 기존 단정은 대부분 `.git-view.git-changes` 로 범위를 좁히고 있다. 전 스펙을 돌려 확인 |
| 원격 버튼이 여섯이 아닌 열둘로 세어져 단정이 깨진다 | MEDIUM | 세는 단정은 Changes 범위 안이다. 범위 없는 단정이 있으면 범위를 좁히는 것이 아니라 **실패로 보고** 하고 판단을 받는다 |
| 폴링마다 머리를 두 번 칠해 성능이 준다 | LOW | 머리 칠하기는 `textContent` 몇 줄이며 스크롤·선택을 건드리지 않는다 |
| 자산 버전 미상향으로 화면에 닿지 않는다 | MEDIUM | C-4. `?v=167 → 168` |
