# 인계: Git·Editor 통합 (REPO_TAB_UNIFY) — 2026-09-04 (3차 세션)

스펙은 [`./REPO_TAB_UNIFY_SRS.md`](./REPO_TAB_UNIFY_SRS.md) 이고, 여기에는 그 스펙이
말하지 않는 것 — **어디까지 섰고, 무엇이 왜 그렇게 됐는지** — 만 적는다.

## 1. 지금 상태

| 대상 | 결과 |
|---|---|
| `go test ./...` | **전부 통과** |
| `npx playwright test` (chromium + mobile-touch) | **1091 통과 · 3 skip · 1 실패** (20.6분). 그 하나(`git-polling` P4)는 단독 재실행에서 통과한다 — §9 의 flake 표를 볼 것 |
| 마일스톤 | **M1~M7 + 묶음 B + 묶음 N 전부 구현·검증** |
| 미검증으로 남긴 것 | **없다** (수동인 V-RTU-93·98 제외). 3차에서 V-RTU-92·NFR-RTU-2 를 채웠다 |

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

## 5. 좁은 사이드가 만든 손짓의 문제 — 3차에서 규칙으로 세웠다

2차가 남긴 관찰이었고, 3차가 사용자에게 물어 고쳤다 — **D-RTU-33·34 / 묶음 N**.

**드러난 것.** `.git-job-bar` 는 `kind · argv · state · spacer · cancel · copy ·
close` 이고 argv 만 `min-width:0` 이다. 사이드 폭은 사용자가 정하며 **기본 220px ·
하한 100px** 인데(`EDITOR_EXPLORER_W_DEFAULT`·`_MIN`, 2차가 260px 으로 적은 것은
e2e 가 쓰는 값이다), 220px 에서 이미 argv 가 **0 으로 눌린다** — 바에 버튼 아닌
자리가 남지 않아 로그를 펴려는 클릭이 `copy`·`close` 에 떨어졌다.

**고친 것 둘.**

| | 무엇 |
|---|---|
| FR-RTU-100 | 바 맨 앞에 **전용 접기 토글**(`.git-job-fold`, 30px 고정). 바 클릭 계기는 그대로 남는다 — 넓을 때의 손짓을 잃지 않는다 |
| FR-RTU-101 / NFR-RTU-6 | 글자 자리(`.git-job-argv`·`.git-file-path`)는 **60px 아래로 눌리지 않고**, 그것을 지키느라 버튼을 감추지 않는다. 한 줄에 안 들어가면 **줄을 늘린다** |

**행 구조까지 함께 본 이유**(사용자 선택). C4b 가 실측한 "선택하려는 클릭이 `stage`
를 실행" 은 인라인 미리보기를 걷어 220px 에서 증상만 사라졌고 **구조는 그대로였다**
— 사용자가 손잡이를 하한까지 끄는 순간 되살아난다. 두 번 같은 자리에 온 것을
자리마다 고치면 세 번째가 온다.

**구현에서 걸린 것 하나.** `.git-file-acts` 는 `flex-shrink:0` 이라 자기 줄로
내려가도 **자기 폭(162px)을 고집해** 100px 사이드를 넘었다. `flex-shrink:1` +
`min-width:0` + `flex-wrap:wrap` 으로 바꿔, 버튼끼리도 줄을 나눈다 (`conflicts` 행이
그렇다). 감추는 쪽을 택하지 않은 근거는 기존 판단 그대로다 — 행 인라인 동작은
"항상 보인다, hover 로만 드러나면 있는 줄 모르고 터치에는 hover 가 없다".

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

**3차가 더한 다섯.**

| 시험 | 덮는 것 |
|---|---|
| `repo-tab` N1·N2 | V-RTU-95·96 — 220px·100px 에서 이름이 60px 이상이고 버튼이 전부 닿는다 (`conflicts` 행 넷 포함) |
| `git-remote` R20b | V-RTU-94 — 접기 토글이 두 폭 모두에서 그 자리에 있고, 그 자리에 다른 버튼이 서지 않는다 |
| `git-repaint` P12 | V-RTU-92 / NFR-RTU-5 — 사이드 탭 전환이 목록 DOM 을 파괴하지 않는다 |
| `git-repaint` P13 | V-RTU-97 / NFR-RTU-2 — 창을 오가도 그 저장소의 패널을 다시 만들지 않는다 (D-RTU-35: 시간 대신 근거를 잰다) |

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

## 9. 3차 세션이 한 것과 남은 것

**한 것.**

1. 인계 §5 의 관찰을 규칙으로 세웠다 — **묶음 N**(FR-RTU-100·101 / NFR-RTU-6,
   D-RTU-33·34). GIT_UI_REVISION_SRS 머리 개정표에 FR-GIT-221 한 줄을 적었다.
2. 미검증 둘을 채웠다 — V-RTU-92(P12) · NFR-RTU-2(P13, D-RTU-35 로 **시간 대신
   구조를 재는 것**으로 개정).
3. `GIT_MANUAL_CHECKLIST` §G1·G2 를 다시 썼다. **옛 결과 칸은 함께 버렸다** —
   문면이 뒤집힌 항목의 `☑` 는 거짓이 된다. 새 문면은 전부 `☐` 다.

**남은 것.**

- **전체 실행에서만 나오는 flake — 회차마다 자리가 다르다.** 전체 회귀를 세 번
  돌렸고 매번 1~3건이 붉었는데 **겹치는 자리가 거의 없고 전부 단독 재실행에서
  통과한다.**

  | 회차 | 붉었던 자리 |
  |---|---|
  | 1 | `explorer-transfer-ignore` ET3 · `sidebar-tabs` T14 · `slot-view-state` TC-SVS-51 |
  | 2 | `editor-ops` O2 · ET3 · `git-history` H26 |
  | 3 | `git-polling` P4 |

  `dm-git-fx-*` 픽스처 접두사는 **전부 유일해 경로 충돌이 아니다**(확인했다). 남는
  후보는 스펙 간 워크스페이스 상태 누수와 시간 기반 단언이며, **고치지 않았다** —
  이 판의 범위가 아니고 원인을 좁히려면 실패한 회차를 재현할 장치가 먼저 필요하다.
  다음 판이 볼 자리다.
- **GIT_ACTIONS_SRS §6.1 의 인접 셋** — 285 의 `clone`(경로를 누가 정하는가) ·
  283 merge editor(범위) · 284 인터랙티브 rebase(`GIT_SEQUENCE_EDITOR` 표면을
  열지). 셋 다 §6.2 가 "먼저 정할 것" 을 적어 두었고 **사용자와 정해야 한다.**
