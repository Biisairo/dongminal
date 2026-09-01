# SRS: History 의 브랜치 생성 버튼 — IEEE 29148

## 1. 개요

### 1.1 목적

접수한 요구는 한 줄이다.

> **git history 에 branch 생성 버튼 추가**

브랜치 생성 **기능**은 이미 있다 (`GitBranches.create`, GIT_ACTIONS_SRS). 지금 그것에
닿는 길은 **우클릭뿐**이다 — History 의 커밋 우클릭(`menu.js:65`)과 refs 우클릭
(`menu.js:152`)이 `createBranchFrom(oid)` 를 부른다. 없는 것은 **보이는 진입점**이다.

### 1.2 범위

**포함:** History 뷰에 버튼 하나와 그 배선.

**미포함:** 브랜치 생성의 동작·검증·다이얼로그. 그것은 GIT_ACTIONS_SRS 의 것이고 이
SRS 는 **그 자리로 가는 길 하나를 더할 뿐**이다.

---

## 2. 현행 분석

### 2.1 History 에는 자기 바가 이미 있다

```
GitPanel.headHTML()          ← Changes 와 공용 (FR-GHM-3·4)
.git-hist-bar                ← History 전용: 검색·정렬·필터·Apply·reflog·jump
.git-hist-main > .git-refs | .git-hist-list
.git-hist-foot
```

`.git-hist-bar` 안에는 `.git-hist-spacer`(`flex:1 1 auto`)가 있어 그 앞뒤로 왼쪽 무리와
오른쪽 무리가 갈린다 (`style.css:1459`).

### 2.2 공용 머리에는 버튼을 더할 수 없다

`.git-head` 는 Changes 와 History 가 **공유**하며 만드는 자리가 하나다 (FR-GHM-4).
그 자리의 주석이 같은 경고를 두 번 적어 두었다.

> FR-GIT-238: 새로고침. **`.git-head-remote` 밖**에 둔다 — 안에 넣으면 원격 버튼을
> 세는 기존 단정이 깨진다.
>
> FR-GIT-282: 리포명 자체가 전환 자리다. 헤더에 새 버튼을 더하면 원격 버튼을 세는
> 기존 단정이 흔들린다.

버튼을 공용 머리에 두면 Changes 탭에도 생기고, 그 단정을 딛는 기존 e2e 가 흔들린다.
**History 전용 바가 이 버튼의 자리다.**

### 2.3 우클릭 메뉴와 역할이 갈린다

| 진입점 | 시작 지점 |
|---|---|
| 커밋 우클릭 → `createBranchFrom(oid)` | **그 커밋** |
| refs 우클릭 → `createBranchFrom(short)` | **그 ref** |
| **이 버튼** | **HEAD** (startRef 를 비워 서버가 정한다) |

셋은 겹치지 않는다. 버튼이 "지금 보는 ref" 를 채우면 우클릭 메뉴와 뜻이 겹쳐,
사용자는 두 길 중 무엇이 무엇인지 매번 판정해야 한다.

---

## 3. 요구사항

**FR-HBB-1** History 뷰의 `.git-hist-bar` 에 브랜치 생성 버튼(`.git-hist-branch`)을
둔다. **`.git-head` 는 한 줄도 바뀌지 않는다** (§2.2).

**FR-HBB-2** 자리는 `.git-hist-spacer` **뒤**, `jump` 입력 **앞**이다. 왼쪽 무리는
목록을 거르는 것들(검색·정렬·필터·reflog)이고 이 버튼은 거기 속하지 않는다.

**FR-HBB-3** 라벨은 상수다 (`GIT_HIST_BRANCH`). `constants-git.js` 의 `GIT_HIST_APPLY`
옆에 둔다 — 같은 바의 라벨은 같은 자리에 모인다.

**FR-HBB-4** 누르면 `GitBranches.create(panel,{})` 를 연다. **`startRef` 를 채우지
않는다** — 빈 값이면 서버가 HEAD 를 쓴다 (§2.3).

**FR-HBB-5** 생김새는 같은 바의 다른 버튼과 같다 — `.git-hist-apply` 규칙 묶음에
선택자를 더한다. 새 규칙을 만들지 않는다.

**FR-HBB-6** 우클릭 메뉴의 두 경로는 **바뀌지 않는다** (§2.3).

**FR-HBB-7** 리포가 없으면 History 뷰 자체가 서지 않는다. 버튼에 별도의 비활성 상태를
만들지 않는다 — `GitBranches.create` 가 `panel.repo` 를 이미 확인한다
(`branches.js:511`).

---

## 4. 설계 결정

**D-1. 공용 머리를 피한다.** → §2.2. 두 탭에서 눌리는 편의보다 공용 머리의 단정을
지키는 쪽이 싸다. 접수한 요구도 "git history 에" 였다.

**D-2. 시작 지점을 비운다.** → §2.3. 진입점 셋의 뜻이 서로 겹치지 않아야 각 길이
무엇을 하는지 설명 없이 읽힌다.

---

## 5. 검증

| ID | 요구 | 검증 |
|---|---|---|
| TC-HBB-1 | FR-HBB-1·2 | History 뷰의 `.git-hist-bar` 안에 `.git-hist-branch` 가 하나 있다 |
| TC-HBB-2 | FR-HBB-4 | 누르면 `#git-br-create` 가 열리고 `.gbc-start` 의 값이 비어 있다 |
| TC-HBB-3 | FR-HBB-4 | 이름을 넣고 Create 하면 그 브랜치가 실제로 생긴다 |
| TC-HBB-4 | FR-HBB-1 | Changes 뷰에는 `.git-hist-branch` 가 없다 |
| TC-HBB-5 | FR-HBB-1 | `.git-head` 의 `button` 개수가 종전과 같다 (공용 머리 불변) |

---

## 6. 비목표

1. 브랜치 생성의 동작·검증·다이얼로그를 바꾸지 않는다.
2. 우클릭 메뉴를 바꾸지 않는다.
3. Changes 탭에 진입점을 만들지 않는다.
