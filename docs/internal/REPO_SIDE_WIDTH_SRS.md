# SRS: Repo 창 사이드의 폭은 하나다 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
Repo 창의 좌측 사이드(`Changes`·`Explorer` 탭이 갈아 끼워지는 자리)의 폭이 지금은
**창마다 따로** 기억된다. 창을 옮길 때마다 목록의 폭이 달라져, 같은 화면 안에서
같은 종류의 자리가 서로 다른 치수로 선다. 폭을 **워크스페이스 변수 하나**로 모은다.

### 1.2 범위 (Scope)
- 포함: 사이드 폭의 저장 자리(창 레코드 → 워크스페이스 최상위), 드래그 중의 동기화,
  옛 창별 값의 마이그레이션, 관련 상수·접근자의 이름.
- 비포함: 폭의 상·하한과 기본값(220 / 100 / 520 — 그대로다), 손잡이의 생김새·히트 영역,
  사이드바(`--sb-w`)의 폭, 활성 탭(`window.editor.side` — **창마다 따로가 맞다**),
  모바일 배치(사이드가 자리 전체를 쓰므로 폭이 없다, FR-RTU-80).

### 1.3 정의 (Definitions)
- **Repo 창**: `_isEditorWin(s)` 가 참인 창 레코드. 좌측 사이드 + 우측 편집기 영역.
- **사이드**: `.ed-side`. 탭 줄 + 본문(`Changes` 뷰 또는 탐색기 트리).
- **칸(slot)**: 워크스페이스 분할의 한 자리. 서로 다른 칸이 서로 다른 Repo 창을
  **동시에** 보일 수 있다 (SLOT_VIEW_STATE_SRS).

## 2. 현황 (Current State)

| 자리 | 지금 |
|---|---|
| 저장 | `window.editor.explorerWidth` — 창 레코드마다 하나 (EDITOR_TAB_SRS FR-EDT-47 / D-18) |
| 읽기 | `_edExplorerWidth(s)` (`app-editor.js:630`) — 없으면 `EDITOR_EXPLORER_W_DEFAULT`(220), 100~520 로 자른다 |
| 쓰기 | `_edSetExplorerWidth(s,w)` (`:637`) — 창 레코드에 쓰고 `_save()` |
| 그리기 | `_rEditorWin` 이 `side.style.width` 를 인라인으로 준다 (`renderer.js:394`) |
| 드래그 | `_rEdHandle(h,s,ex)` (`:495`) — 움직이는 동안 **그 사이드 하나**의 인라인 폭만 바꾸고, mouseup 에 확정 |

문제는 하나다. 폭은 "이 창을 어떻게 볼까" 가 아니라 **"목록 자리를 얼마나 줄까"** 이고,
그것은 창의 성질이 아니다. 창이 열 개면 폭도 열 개가 되어, 어느 창에서 맞춰 둔 폭이
다음 창에서는 없는 것이 된다.

### 2.1 사용자 결정 (2026-09-06)
- **D-1** 폭은 **모든 Repo 창에서 동기화**한다.
- **D-2** 애초에 **변수를 하나만** 갖는다 — 창마다 두고 맞추는 것이 아니라, 창별 값이 없다.

### 2.2 설계 결정
- **D-3 자리는 워크스페이스 최상위 `repoSideWidth` 다.** `sidebarWidth` 가 이미 그 규약이다
  (§2.10 / SIDEBAR_COLLAPSE_SRS §54) — 서버가 blob 으로 round-trip 하고,
  `workspace_changed` → `_applyRemoteWorkspace` → `render()` 로 다른 브라우저까지 따라온다.
  Go 구조체를 고칠 것이 없다.
- **D-4 이름을 `explorerWidth` 에서 바꾼다.** 그 값이 정하는 것은 탐색기가 아니라 **사이드**의
  폭이고, 사이드에는 `Changes` 도 산다 (REPO_TAB_UNIFY_SRS FR-RTU-11·12). 자리를 옮기는
  김에 이름도 사실에 맞춘다 — 상수 `REPO_SIDE_W_*`, 접근자 `_edSideWidth`·`_edSetSideWidth`
  (활성 탭의 `_edSideOf`·`_edSetSide` 와 같은 말투다).
- **D-5 드래그 중에도 동기화한다.** 화면에 보이는 사이드 전부의 인라인 폭을 같은 틱에 바꾼다.
  mouseup 에만 맞추면, 칸 둘이 나란히 보일 때 드래그하는 동안 둘이 어긋나 보인다.
  다시 그리지 않는 이유는 `_rLayout` 이 매 render 마다 `.ed-win` 을 새로 만들기 때문이다 —
  드래그마다 트리·Monaco 를 재조립할 이유가 없다 (NFR-RTU-5 와 같은 근거).
- **D-6 옛 값은 승계하고 죽은 키는 지운다.** 창 배열에서 **처음 만나는 유효한** 값 하나를
  집는다 (결정론적이다). `displayMode`·`mobileBreakpoint` 를 지우는 두 자리(`app.js` 의 첫
  로드, `app-cmd.js` 의 원격 반영)와 **같은 자리**에서 한다 — 옮긴 키를 지우는 규약이 이미
  거기 있다.
- **D-7 활성 탭(`window.editor.side`)은 창별로 남긴다.** 폭은 치수이고 활성 탭은 **시선**이다
  — 한 창에서 변경을 보면서 다른 창에서 파일을 뒤지는 일은 정상이며, 그것까지 묶으면
  창을 나눠 둔 이유가 사라진다. 사용자 지시는 폭에 대한 것이다.

## 3. 요구사항 (Requirements)

### 3.1 기능 요구사항 (Functional)
| ID | 요구사항 | 우선 |
|----|---------|------|
| FR-RSW-1 | 사이드 폭은 워크스페이스 최상위 `repoSideWidth` **한 변수**에 산다. 창 레코드는 폭을 갖지 않는다 (D-2·D-3). | 필수 |
| FR-RSW-2 | 모든 Repo 창이 그 값을 읽어 그린다 — 어느 창에서 조절해도 다른 창이 같은 폭이 된다 (D-1). | 필수 |
| FR-RSW-3 | 드래그가 도는 동안 화면에 있는 모든 사이드의 폭이 함께 움직인다. 확정은 mouseup 한 번이고 그때 `_save()` 한다 (D-5). | 필수 |
| FR-RSW-4 | 값이 없거나 숫자가 아니면 `REPO_SIDE_W_DEFAULT`(220) 다. 읽을 때도 쓸 때도 `REPO_SIDE_W_MIN`(100) ~ `REPO_SIDE_W_MAX`(520) 로 자른다 — 상·하한과 기본값은 종전과 같은 수다. | 필수 |
| FR-RSW-5 | 옛 워크스페이스의 `window.editor.explorerWidth` 는 첫 진입에서 `repoSideWidth` 로 승계되고(값이 아직 없을 때만), 창 레코드에서는 지워진다. 바뀌었으면 저장한다 (D-6). | 필수 |
| FR-RSW-6 | 다른 브라우저가 폭을 바꾸면 `workspace_changed` 반영에서 그대로 따라온다 — 최상위 키이므로 `this.ws=sv` 와 `render()` 가 그 경로다 (D-3). | 필수 |
| FR-RSW-7 | 활성 탭(`window.editor.side`)은 창마다 따로 남는다 (D-7). | 필수 |
| FR-RSW-8 | 모바일에서는 폭을 주지 않는다 — 사이드가 순회의 자리 하나를 전부 쓴다 (FR-RTU-80). | 필수 |

### 3.2 비기능 요구사항 (Non-functional)
- NFR-RSW-1 폭 조절은 **다시 그리지 않는다**. 인라인 폭만 바꾸므로 트리의 펼침·선택·스크롤과
  편집기 인스턴스가 살아 있다 (FR-EDT-66·68).
- NFR-RSW-2 서버는 손대지 않는다 — 워크스페이스는 blob round-trip 이다.
- NFR-RSW-3 손잡이의 생김새·히트 영역(`.ed-ex-handle`, ±6px)은 그대로다.

### 3.3 이전 동작 / 새 동작 / 이유
| 항목 | 이전 | 새 | 이유 |
|------|------|-----|------|
| 저장 자리 | `windows[].editor.explorerWidth` | `ws.repoSideWidth` 하나 | 폭은 창의 성질이 아니다 (D-1·D-2) |
| 창 사이 | 창마다 다른 폭 | 전부 같은 폭 | 사용자 지시 |
| 드래그 | 끄는 사이드만 움직인다 | 보이는 사이드가 함께 움직인다 | 칸이 둘일 때 어긋나 보인다 (D-5) |
| 이름 | `explorerWidth` / `_edExplorerWidth` / `EDITOR_EXPLORER_W_*` | `repoSideWidth` / `_edSideWidth` / `REPO_SIDE_W_*` | 그 폭은 사이드의 것이고 사이드에는 `Changes` 도 산다 (D-4) |
| 옛 값 | — | 첫 값을 승계하고 창 레코드에서 지운다 | 옮긴 키를 남기지 않는다 (D-6) |

## 4. 검증 (Verification)
| ID | 대상 | 검증 방법 |
|----|------|----------|
| V-RSW-1 (FR-RSW-1·2) | e2e: `_edSetSideWidth(310)` 뒤 `ws.repoSideWidth===310`, 열려 있는 **모든** `.ed-side` 의 폭이 310px, 창 레코드에 `editor.explorerWidth` 가 없다. |
| V-RSW-2 (FR-RSW-1) | e2e: 새로고침 뒤에도 310px 이고 값은 여전히 워크스페이스 최상위에 있다. |
| V-RSW-3 (FR-RSW-4) | e2e: `_edSetSideWidth(9999)` → 520, `_edSetSideWidth(1)` → 100. 값을 지우면 220. |
| V-RSW-4 (FR-RSW-5) | e2e: 창 레코드에 `explorerWidth` 를 심고 `repoSideWidth` 를 지운 뒤 다시 읽으면 승계되고 창 레코드의 키가 사라진다. |
| V-RSW-5 (FR-RSW-7) | e2e: 창 A 의 사이드를 `Changes` 로 바꿔도 창 B 는 `Explorer` 다. |
| V-RSW-6 (회귀) | `npx playwright test e2e/editor-tab.spec.ts e2e/repo-tab.spec.ts` 통과. |

## 5. 리스크
- LOW: 옛 창별 폭을 잃는 경우 — 승계는 **첫 값 하나**이므로 다른 창에서 맞춰 둔 폭은 사라진다.
  그것이 사용자가 요구한 것이다 (D-1).
- LOW: 이름 변경이 이 값을 부르던 e2e(`editor-tab.spec.ts` E22)를 깬다 — 그 시험은 함께 고친다.
- LOW: 드래그 중 `document.querySelectorAll('.ed-side')` 는 화면 전체를 훑는다. 사이드는 칸 수만큼이라
  한 자릿수이고, 손잡이는 데스크톱에만 있다 (FR-RSW-8).
