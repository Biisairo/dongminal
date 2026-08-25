# 설계 계약 — M1 8단계 상태바 chip (묶음 G, FR-GIT-57~59)

GIT_SRS.md §3.7 이다. 검증은 V27(신규)·V14.
전제: 5·6단계(활성 리포의 상태 관측)가 끝나 있다.

## 0. 파일 배치

| 파일 | 변경 |
|---|---|
| `web/js/helpers.js` | `STATUS_ITEMS` 에 `git` 항목 추가 |
| `web/js/app.js` | `_updateStatusBar` 에 chip 렌더 |
| `web/style.css` | `.sb-git` 스타일 |
| `e2e/git-statusbar.spec.ts` | **신규** — V27 |

## 1. 요구사항

- **FR-GIT-57** 활성 리포의 브랜치와 변경 파일 수를 chip 으로 보인다.
  기존 `STATUS_ITEMS` 체계에 편입해 사용자가 끌 수 있어야 한다.
- **FR-GIT-58** chip 클릭은 Git 창을 활성화한다.
- **FR-GIT-59** 리포가 없거나 저장소가 아니면 chip 을 보이지 않는다.

## 2. 구현

```js
// helpers.js — STATUS_ITEMS
git:{label:'Git (브랜치·변경 수)',def:true},
```

`_updateStatusBar()` 에서, `statusBar.git` 이 참이고 `this.gitPanel` 의 마지막
관측이 있을 때만 항목을 넣는다.

표기는 `GIT_SURFACE_MAP.md` S6 를 따른다:

```
⎇ git  ●3       ← 브랜치 git, 변경 3
⎇ a1b2c3d       ← detached (해시 앞 7자)
```

`⎇`(U+2387) 는 브랜치, `●` 는 dirty 표식이다. 기존 상태바 항목들이 쓰는
이모지(`📁`·`💻`)와 달리 글자 기호를 쓰는 이유는 폭이 일정해 chip 이 흔들리지
않기 때문이다.

- 변경 수가 0 이면 숫자를 붙이지 않는다.
- detached 면 `.sb-git-detached` 로 구분한다.
- **리포가 없거나 마지막 관측이 없으면 항목을 넣지 않는다** (FR-GIT-59).
  빈 chip 이나 `-` 를 보이지 않는다.
- 클릭 리스너는 `_initStatusBar` 에서 **한 번만** 붙인다 — `_updateStatusBar` 는
  `innerHTML` 을 갈아치우므로 그 안에서 붙이면 누적된다.
  기존 `sb-bg-btn` 이 같은 이유로 정적 요소인 것과 같은 규약이다 (FR-BGU-4).
  chip 은 동적으로 생기므로 `#sb-items` 에 위임(delegation)으로 붙인다.
- 클릭 → `app.openGitWindow()` (리포 인자 없음 — 현재 활성 리포를 유지한다).

`GitPanel` 은 상태를 새로 관측할 때마다 `app._updateStatusBar()` 를 부른다.
활성 리포가 없어지면 마지막 관측을 버려 chip 이 사라지게 한다.

## 3. e2e (`e2e/git-statusbar.spec.ts`)

| # | 내용 |
|---|---|
| B1 | 기본 설정에서 chip 이 브랜치를 보인다 |
| B2 | 설정에서 `git` 을 끄면 chip 이 사라진다 |
| B3 | chip 클릭이 Git 창을 활성화한다 |
| B4 | 저장소가 아닌 곳(활성 리포 없음)에서는 chip 이 없다 |
| B5 | chip 을 여러 번 갱신해도 클릭 리스너가 중복되지 않는다 (한 번 클릭에 창 전환 1회) |

## 4. 하지 않는 것

- 원격 작업 진행 표시 — M3 (FR-GIT-112).
- chip 에서의 조작 — 클릭은 창 활성화뿐이다.
