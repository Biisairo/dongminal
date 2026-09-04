# 인계: Git·Editor 통합 (REPO_TAB_UNIFY) — 2026-09-04 (2차 세션)

스펙은 [`./REPO_TAB_UNIFY_SRS.md`](./REPO_TAB_UNIFY_SRS.md) 이고, 여기에는 그 스펙이
말하지 않는 것 — **어디까지 섰고, 무엇이 왜 그렇게 됐는지** — 만 적는다.

## 1. 지금 상태

| 대상 | 결과 |
|---|---|
| `go build ./...` · `go test ./...` | **전부 통과** |
| `npx playwright test` (chromium + mobile-touch) | **1079 통과 · 3 skip · 0 실패** (20분) |
| 마일스톤 | **M1~M7 + 묶음 B 전부 구현** |
| 미검증으로 남긴 것 | NFR-RTU-2(전환 250ms) · V-RTU-92(사이드 탭 전환이 목록 DOM 을 파괴하지 않는다) |

앞 세션의 §3.1(미리보기 미해결)·§3.2(모바일 미착수)·§3.3(검증 안 된 요구 다섯)은
모두 닫혔다. 앞 세션이 "실패 6건" 으로 기록한 것은 실제로 **107건**이었고(전체
회귀가 615/1032 에서 중단돼 있었다) 그 정리가 이 세션의 대부분이다.

## 2. §3.1 의 미해결은 결함이 아니었다

앞 세션의 기록은 이랬다 — "untracked 행을 더블클릭해 연 탭에 `preview` 가 붙지
않는다. 만든 뒤 누군가 `_pinPreviewTab` 으로 지우는 쪽이 유력하다."

**아니었다.** 그 경로는 `panel-changes.js` 의 **dblclick 핸들러**였고, FR-RTU-42 ④
가 "변경 목록 행의 더블클릭도 고정 계기" 라고 못박고 있었다 — 즉 그 탭은 고정되는
것이 **옳았다.** 스펙과 시험이 서로를 반박하고 있었고, 구현은 스펙 쪽이었다.

사용자에게 물어 확정한 것이 D-RTU-22·23 이다.

> "스펙 문구대로 vsc 처럼 탭으로 에디터창에."
> "한번클릭을 diff, 두번클릭은 제거. 이것도 vsc 와 동치."

그래서 **한 번 클릭이 본문을 열고**(tracked→Diff 탭, untracked→편집기 미리보기 탭)
**변경 목록의 더블클릭 계기는 사라졌다.** D5 의 주석 처리된 단언은 그대로 복원됐다.

## 3. 걷어낸 것 — Changes 사이드의 인라인 diff 미리보기

같은 결정(D-RTU-22)이 그 칸을 걷었다. 근거는 실측이다.

```
사이드 260px  ─┬─ 목록 ~90px   ← .git-file-path 가 0 으로 눌린다
               └─ 인라인 diff
```

호버 시 파일 **이름이 사라지고** 동작 버튼이 행 가운데를 덮어, 선택하려는 클릭이
`stage` 를 실행했다 (C4b 가 그것으로 실패했다). §1.1 의 그림과 FR-RTU-20 의 네 줄에
애초에 그 칸이 없었다 — **초판 스펙이 옳고 구현이 옛 자리를 들고 있었다.**

그 삭제로 **EDITOR_GIT_UX_SRS 묶음 D(FR-CSZ-1~8)가 폐기**됐다 (그 문서 §3.1 에
기록). 미리보기가 들고 있던 축 라벨(`worktree ↔ index`)은 Diff 탭의 바로 옮겼다 —
정보를 잃지 않는다.

## 4. e2e 정리에서 드러난 구현 결함 열하나

**이것이 이 문서의 핵심이다.** 스펙 §7 의 D-RTU-24~32 와 같은 내용이며, 여기서는
어떻게 드러났는지를 적는다. 전부 통합이 남긴 것이고, e2e 를 고치다 발견했다.

| 결함 | 증상 | 자리 |
|---|---|---|
| `_gitObserveOk` 가 옛 탭 id `'git'` 비교 | **Repo 행의 변경 개수 배지가 영영 서지 않았다** (FR-RTU-6 위반) | `app-git.js` |
| `Repo` 행이 소실 사유·`norepo` 를 잃음 | 폴더가 사라진 저장소의 행이 아무 말도 하지 않았다 (FR-RMS-11·17) | `sidebar-tabs.js` · `_gitPinEntry` |
| 헤더 리포 드롭다운이 `setRepo` 호출 | Repo 창 패널은 `this.root` 로 조기 반환 → **아무 일도 하지 않았다** | `panel-changes._openRepoPicker` |
| Worktrees 행의 `open` 도 같은 결함 | 같은 이유로 no-op | `worktrees.js._act` |
| 폴링이 "창이 보이는가" 만 봄 | **저장소가 아닌 루트에도** status 가 3초마다 (V-EDT-47: 1회 기대에 4회) | `_pollOk` + `_gitSurfaceOn` |
| 탐색기 트리도 같은 결함 | 사이드가 Changes 인데도 묻는다 — **폴링을 끈 설정에서도 status 가 왔다** (V18·V5) | `_edVisibleTrees` · `_edActiveTree` |
| `_gitRescheduleAll` 이 패널을 만든다 | 만드는 것이 곧 폴링이었다 | `app-git.js` |
| `closeTab` 이 `TAB_TYPE_GIT` 조기 반환 | **FR-RTU-33·34 가 미구현이었다** — M2 는 ✅ 로 적혀 있었다 | `app-layout` · `app-dnd` · `renderer` |
| `_edKeepActive` 가 sessionStorage 를 안 옮김 | 새로고침 뒤 Changes 사이드가 사라졌다 (V33·FR-GIT-76) | `app-editor.js` |
| 활성 Repo 창을 **id 로만** 되살림 | 재조정이 새 id 로 만들면 못 찾아 `Windows` 로 떨어졌다 (V-SBT-4) | `app.js` + `ACTIVE_EDITOR_ROOT_KEY` |
| `.ed-side-tab`·`.ed-side-act` 가 24px·23px | 통합이 넣은 컨트롤이 FR-GIT-195~198(하한 30px)을 지나쳤다 (V80) | `style-editor.css` |

**공통 교훈 하나.** 통합은 "창이 보인다" 와 "그 표면이 보인다" 를 갈랐는데, 구현의
게이트 넷 중 셋이 그 구분을 놓치고 있었다 (git 패널·탐색기 폴링·탐색기 즉시 신호).
FR-RTU-62 의 문구는 처음부터 "그 표면" 이었다.

## 5. 좁은 사이드가 만든 손짓의 문제 — 남은 관찰

**고치지 않았고, 다음 세션이 판단할 자리다.**

`.git-job-bar` (원격 작업의 바)는 `kind · argv · state · spacer · cancel · copy ·
close` 로 되어 있다. 260px 사이드에서 argv 가 눌리면 **바의 가운데가 버튼**이
되고, 바를 눌러 로그를 펼치려는 클릭이 `copy`·`close` 에 떨어진다 (핸들러가
`closest('button')` 으로 조기 반환한다). e2e 는 바의 **글자**(`.git-job-argv`)를
누르는 것으로 바꿨고 그 이유를 주석에 적었다 — 사용자는 보이는 글자를 누르므로
실제 사용에서는 덜 걸리지만, 손짓의 대상이 폭에 따라 달라지는 것은 그대로다.

같은 종류의 문제를 C4b 에서 한 번 실측했고(그쪽은 인라인 미리보기를 걷어 해소됐다)
`.git-file-acts` 도 여전히 `flex-shrink:0` 이다. 접힘 토글을 따로 두거나 좁은 폭에서
동작 버튼을 감추는 것이 후보다.

## 6. e2e 가 크게 바뀐 자리 (2차)

앞 세션이 `.git-view.git-changes` 만 치환했고 나머지가 남아 있었다.

| 바뀐 것 | 어떻게 | 규모 |
|---|---|---|
| `#area .pn-body .git-{file,group,dir,commit,files,preview,op-,job,partial,stale-note}` | → `.ed-side` | 45곳 |
| 사이드바 행 | `.git-repo`·`.git-repo-{name,x,dot}`·`.git-repos-none` → `.ed-entry`·`.ed-entry-{name,x,dot}`·`.ed-entries-none` | 9개 파일 |
| 사이드바 id | `#git-repos`·`#git-add-repo` → `#repo-entries`·`#repo-add` | — |
| Add 다이얼로그 | `#git-add-repo-dlg`·`.gar-path` → `#editor-add-dlg`·`.eda-path` (종단이 하나다) | — |
| 탭 id·라벨 | `'git'` → `'repo'` · `Git` → `Repo` (창 타입은 `editor`) | — |
| `gitPanel.setRepo(x)` | → `openGitWindow(x)` (리포 전환은 창 전환이다) | 7곳 |
| `app._gitWindow()` | → `_edWindowFor(root)` (창의 신원은 루트다) | 6곳 |
| `_gitPanel(slot)` | → `_gitPanel(root, slot)` | `slot-view-state` |
| `pn-tab[data-git-view="changes"]` 클릭 | 지웠다 — Changes 는 사이드에 늘 있다 | 8곳 |

**폐기한 시험** — 이유를 각 자리에 주석으로 남겼다.

- `editor-git-ux` 묶음 D (V-CSZ-1~8) — 나눌 두 칸이 사라졌다
- `git-window` E3·E4·E5·E5b — 고정 탭 일곱과 그 불변성이 사라졌다 (E5·E5b 는 뒤집혔다)
- `git-sidebar` S2·S3·S3b — `+ Add` 가 하나이고 저장소 아닌 경로도 정당한 행이다
- `git-head-mobile` V9 · `slot-title-boundary` TC-STB-3 · `git-window-name` 둘 — "리포 없는 Git 창" 이라는 상태가 없다
- `git-ui-revision` V75 는 **뒤집었다** — 옛 Git 창의 탭은 옮겨지지 않고 **버려진다** (D-RTU-14)

## 7. 신규 검증 여덟 (`repo-tab.spec.ts`)

| 시험 | 덮는 것 |
|---|---|
| X1·X2·X3 | V-RTU-31 — 닫기·드래그·다시 열기·창 경계 (FR-RTU-17·33·34) |
| X4 | V-RTU-91 / NFR-RTU-3 — Diff 탭을 닫으면 Monaco 인스턴스도 놓는다 |
| X5 | V-RTU-45 — 고정 탭이 있는 대상은 미리보기를 만들지 않는다 |
| X6 | V-RTU-90 / NFR-RTU-1 — 보이지 않는 저장소는 폴링되지 않는다 |
| M1·M2 | V-RTU-80·82 — 모바일 순회의 첫 자리가 사이드이고 계수가 그것을 포함한다 |

## 8. 다음 세션이 먼저 볼 파일

| 파일 | 왜 |
|---|---|
| `web/js/core/app-git.js` | `_gitSurfaceOn`(관측 게이트) · `_gitPinEntry` · `_gitDropView` · `openGitWindow` |
| `web/js/core/app-mobile.js` | `_mobileSideSlots`·`_mobileOnSide` — 순회의 사이드 자리 |
| `web/js/core/app-focus.js` | `_setFocus` 의 모바일 계기 (사이드를 떠나는 판정) |
| `web/js/core/app.js` · `app-layout.js` | `ACTIVE_EDITOR_ROOT_KEY` — 활성 Repo 창을 루트로 되살린다 |
| `web/js/ui/renderer.js` | `_rEditorWin`(모바일 한 자리) · `_rWindowInto`(사이드 오프셋) · 탭의 `×`·draggable |
| `web/js/git/panel-life.js` | `dropView` — 탭이 닫힐 때 뷰 하나만 놓는다 |
| `web/js/git/panel-changes.js` | 행의 한 번 클릭이 여는 자리 · `_openRepoPicker` |
| `web/js/git/panel-poll.js` | `_pollOk` 의 표면 게이트 (FR-CSZ 자리가 비어 있다) |
