# 인계: 작업대 사용자 검토 (WORKBENCH_REVIEW) — 2026-09-05 (2차 세션)

스펙은 [`./WORKBENCH_REVIEW_SRS.md`](./WORKBENCH_REVIEW_SRS.md) 이고, 여기에는 그
스펙이 말하지 않는 것 — **어디까지 섰고, 무엇이 왜 그렇게 됐는지** — 만 적는다.

## 1. 지금 상태

| 대상 | 결과 |
|---|---|
| `go build ./...` · `go test ./...` | **전부 통과** |
| `npx playwright test` (chromium + mobile-touch) | **1090 통과 · 3 skip · 4 실패 → 넷 다 단독 재실행에서 통과** (§6 의 flake) |
| 커밋 | `f421113`(묶음 S) · `acf30f6`(Discard All 접수) |

접수한 아홉 건 중 **다섯이 닫혔고**, 하나는 사용자가 넘기기로 했다. 남은 셋은
**스펙이 섰고 구현이 남았으며**(묶음 D·P·F), 메모리 하나만이 재현을 기다린다.

| # | 건 | 상태 |
|---|---|---|
| 7 | "자기 하위로는 옮길 수 없습니다" 가 안 지워짐 | ✅ 묶음 X |
| 8 | 한줄보기 / 줄바꿔보기 옵션 | ✅ 묶음 W |
| 5 | 새 창이 홈이 아닌 현재 위치에서 열림 | ✅ 묶음 C |
| 4 | 메모장이 안 보이는 경우가 있음 | ✅ 묶음 N |
| 3 | 메모가 제대로 저장되지 않음 | 🔸 **절반.** 묶음 S 가 "조용히 사라지는 길" 하나를 닫았으나 **증상을 재현하지 못했다** (§3) |
| — | 외부 접속에서 알림이 안 울림 | ⊘ 넘김 — 결론은 SRS §6 비목표 6 |
| 6 | 메모리 30GB | ⬜ 재현 대기 (§4) |
| 1 | 탐색기 복사·복제 | 🔷 **스펙 완료** — 묶음 P (FR-WBR-60~74). 구현 대기 |
| 2 | 폴더 단위 스테이징 | 🔷 **스펙 완료** — 묶음 F (FR-WBR-80~84). 구현 대기 |
| 9 | `Changes`·`Untracked` 의 Discard All | 🔷 **스펙 완료** — 묶음 D (FR-WBR-50~56). 구현 대기 |

## 2. 조사에서 두 번 헛짚었다 — 그 기록이 다음 사람을 아낀다

메모 저장 건을 파면서 **가설 둘이 틀렸다.** 같은 자리를 다시 파지 않도록 적는다.

| 가설 | 왜 틀렸나 |
|---|---|
| `refresh()` 가 디스크 내용으로 버퍼를 덮는다 | 덮는 것은 **사실이다** (`file-editor.js` 가 dirty 를 묻지 않고 `setValue`). 그러나 그 길은 `_edOpenFile` 의 `existing` 가지에서만 불린다 — **탭 줄에서 탭을 클릭하는 경로에는 없다.** 사용자는 탭을 눌렀다고 답했다 |
| 쓰기 종단이 메모 루트를 거부한다 | `apiFileWrite` 에는 **루트 검사가 아예 없다** (`handlers_files.go`). 절대경로면 쓴다 |

또 하나. **`_dirty` 는 뷰가 아니라 문서의 것이다** — `file-editor.js` 의 접근자가
`_doc.dirty` 로 위임한다. "칸마다 dirty 가 따로라서 저장이 건너뛰어진다" 는 방향은
막다른 길이다.

## 3. 메모 저장 — 닫은 것과 남은 것

**닫은 것 (묶음 S).** 재조정이 창을 지울 때 저장하지 않은 편집을 지킨다.

```
루트가 _edRoots() 에서 빠진다
  → _edReconcile 이 창 레코드를 통째로 splice        (app-editor.js)
  → 그 창의 탭 id 가 사라진다
  → 렌더러의 회수기가 편집기를 파괴한다              (renderer.js:235)
  → _edDocDrop 이 모델까지 dispose 한다
  → 저장하지 않은 편집이 묻지도 알리지도 않고 사라진다
```

**탭을 닫을 때는 이미 묻고 있었다** (`app-layout.js` 의 dirty 가드 — 저장·버림·취소).
같은 손실을 다른 길에서 조용히 냈다. 이제 dirty 편집기가 있으면 그 창을 남기고
(FR-WBR-40) 창 이름과 함께 한 번 알린다 (FR-WBR-41).

**메모장이 유독 약한 이유.** `_edRoots()` 는 `[home, notes?, ...list]` 인데 `home`
은 없으면 `_edApplyServer` 가 반영 자체를 포기하는 반면 **`notes` 는 선택적이라
응답 한 번에 빈 문자열이 된다** (FR-NOT-11). 그 순간 메모장 창이 통째로 지워졌다.
FR-WBR-30 이 고친 자리(워크스페이스 충돌 재시도가 `notes` 를 빠뜨리던 것)가 그
방아쇠 하나였다.

**남은 것.** 사용자가 말한 두 증상을 **재현하지 못했다.**

> "저장하고 다른 탭을 눌렀다가 오면 내용이 사라져 있다"
> "에디터에서 저장을 하면 저장이 안 되는 경우가 있다 — 컨트롤 에스를 눌러 저장했다"

확인된 사실 셋은 이렇다 — 사용자는 **탭 줄의 탭을 눌러** 돌아왔고, **메모장에서만**
봤으며, 위 두 가설은 배제됐다. 다음에 같은 일이 나면 **그 직전에 무엇을 했는지**를
받아야 한다: 창을 전환했는가 · 새로고침했는가 · 다른 브라우저/기기에서 동시에 열어
두었는가. 특히 마지막이 중요하다 — 워크스페이스 충돌 경로가 그때만 열린다.

아직 보지 않은 자리 둘을 적어 둔다.

- **`save()` 의 `_doc.saving` 이 참인 채 남을 수 있다.** `destroy()` 는
  `this._doc = null` 로 끊는데, 저장이 날아가 있는 동안 그 뷰가 파괴되면 `finally`
  의 `if (this._doc)` 이 거짓이라 공유 문서의 `saving` 을 못 내린다. 다른 칸이 그
  문서를 붙들고 있으면 기록이 살아남고 **그 뒤 그 파일의 모든 저장이 조용히
  건너뛰어진다.** 미리보기 탭은 탐색기에서 다른 파일을 누를 때마다 편집기를
  파괴하므로 닿기 어려운 경로가 아니다. **코드로만 확인했고 재현하지 않았다.**
- **`app-reload.js` 의 트리 갱신이 죽어 있다.** `w.editor.refresh()` 를 부르는데
  `w.editor` 는 창 레코드의 `{root, side, explorerWidth}` 라 `refresh` 가 없다 —
  `typeof` 가드 때문에 조용히 아무 일도 하지 않는다. 이 작업과 무관하지만 같은
  파일을 볼 때 함께 보면 된다.

## 4. 메모리 30GB — 착수점

사용자 관측은 **"메모리 모니터를 봤을 때 dongminal 이었던 것 같다"** 이다 —
서버(Go) 쪽이 유력하나 확정이 아니다. 재현 조건이 없으면 고칠 수 없으므로 순서는
**① 재현 ② 측정 ③ 원인**이다.

서버라면 첫 자리는 `pprof` 의 heap·goroutine 이고, 후보는 PTY 출력 버퍼 · hub
구독자 · git job 의 보존 줄(`_lines`) · 파일 감시다. 브라우저라면 Monaco 모델
(`monaco.editor.getModels().length`)·xterm 스크롤백·detached DOM 이다.

## 5. 신규 셋 — 정할 것이 **전부 정해졌다** (2026-09-05 인터뷰)

스펙은 SRS §3.6~3.8(묶음 D·P·F), 근거는 §2.6~2.10, 결정은 §7 의 D-WBR-10~17 이다.
여기에는 **인터뷰와 조사가 인계 §5 의 전제를 뒤집은 것**만 적는다.

| 1차 인계가 적었던 것 | 조사가 밝힌 것 |
|---|---|
| "폴더 하위에 staged·untracked 가 섞였을 때 무엇을 스테이지하는가" | **없는 문제였다.** `_emitTree(items,group,…)` 가 트리를 **그룹마다 따로** 세운다(`panel-changes.js:437`) — `changes` 폴더 행 아래에는 `changes` 파일만 있다 |
| "두 그룹의 discard 는 같은 명령이 아니라 자료구조부터 바뀐다" | 자료구조는 맞다(`GIT_GROUP_BULK` 는 그룹당 하나). 그러나 **명령 분기는 이미 서 있었다** — `_bulk`→`_run`→`_discard` 가 `group!=='untracked'` 로 가르고 서버도 둘을 따로 받는다. 새로 세울 것은 **표면뿐**이다 |
| "복사는 충돌을 거부할지 개명할지" | 개명으로 정했다. 그런데 **묻지 않았던 것이 둘 더 있었다** — 루트 교차(`fsResolveTarget` 이 한 root 로만 검사한다)와 클립보드의 수명이다 |

**사용자가 물은 것과 그 답.** "복사가 다른 PC 에서도 되는가" — **된다.** 원본도
대상도 서버에 있고 경로만 오간다. 반대로 **OS 클립보드는 쓸 수 없다**(SRS §2.10) —
웹은 파일을 클립보드에 올릴 수 없고 `navigator.clipboard` 는 secure context 밖에서
아예 없다. 이 저장소가 터미널 복사에서 이미 실측한 벽이다(`term-clipboard.js:12`).

### 5.1 조사 중에 찾은 **기존 결함** — 묶음 D 에 딸린다

discard 확인창이 권하는 `git stash push -- <경로들>` 은 **untracked 가 섞이기만
해도 실패하고 하나도 stash 되지 않는다.** 실측표는 SRS §2.7 이다. `-u` 를 언제나
붙이면 셋 다 옳고, tracked 만일 때 붙여도 대상이 넓어지지 않는다.

**행의 `↺` 도 같은 자리를 지난다** — 그룹 일괄만의 문제가 아니다.

### 5.2 요구를 뒤집었으므로 그 이름으로 훑은 자리

`FR-EDT-86`·`FR-FTR-16`·`FR-EDT-87/112` 와 `stash push` 를 코드·시험 전체에서
훑었다. **바뀌는 시험은 하나다** — `git-staging` **E8**(`:157`)이
`git stash push -- tracked.txt` 를 단언한다.

나머지는 영향이 없다: `git-confirm`·`git-dialog` 는 hint 를 **시험이 직접 만들어**
확인창에 넘기고, `git-hunk`·`write/patch_test.go` 는 hunk revert(tracked 파일
하나)이며, `git-file-actions` F12 는 이미 `-u` 를 본다. `editor-ops` **O6**
(FR-EDT-86)은 이동·생성을 시험하므로 그대로 산다 — 복사는 **다른 조작**이고
덮어쓰기 금지는 어디에도 그대로다.

개정 줄을 적은 문서 넷: `EDITOR_TAB_SRS`(머리 표에 3줄) · `FILE_TRANSFER_SRS`
(머리 표 신설) · `EXPLORER_TRANSFER_IGNORE_SRS`(머리 표 신설) · `GIT_ACTIONS_SRS`
(FR-GIT-277 의 "discard 의 선례" 가 사실이 아니었다는 정정).

### 5.3 구현 순서

1. **묶음 D** — 표면만 바뀐다. `-u` 결함이 여기 딸린다.
2. **묶음 P** — 서버 종단이 새로 생기므로 Go 시험이 먼저다.
3. **묶음 F** — D 가 만든 "그룹 머리의 여러 동작" 규약을 폴더 행이 물려받는다.
4. **메모리** — 재현이 먼저다 (§4).

## 6. 회귀의 flake — 회차마다 자리가 바뀐다

전체 회귀를 다섯 번 돌렸다. 넷에서 매번 1~4건이 붉었는데 **겹치는 자리가 거의 없고
전부 단독 재실행에서 통과했다.** 4회차만 0 실패였다.

| 회차 | 붉었던 자리 |
|---|---|
| 1 | `explorer-transfer-ignore` ET3 · `sidebar-tabs` T14 · `slot-view-state` TC-SVS-51 |
| 2 | `editor-ops` O2 · ET3 · `git-history` H26 · `ux-revision` V-CWD-1(**진짜 결함**, 고침) |
| 3 | `git-polling` P4 |
| 4 | 없음 |
| 5 | ET3 · `git-history` H18 · H12 · `git-remote-actions` E10 |

**`ET3` 이 다섯 회차 중 셋(1·2·5)에서 붉었다** — 겹치는 유일한 자리다. 나머지는
매번 다르다. 좁힐 여유가 생기면 그 하나부터다.

`dm-git-fx-*` 픽스처 접두사는 **전부 유일해 경로 충돌이 아니다**(확인했다). 남는
후보는 스펙 간 워크스페이스 상태 누수와 시간 기반 단언이다. **고치지 않았다** —
원인을 좁히려면 실패한 회차를 재현할 장치가 먼저 필요하다.

> **2회차의 `ux-revision` V-CWD-1 은 flake 가 아니라 내 누락이었다.** FR-CWD-1 을
> 폐기하면서 `editor-cwd-inherit.spec.ts` 만 고치고 그 파일을 놓쳤다. **요구를
> 뒤집을 때는 그 FR 이름으로 e2e 전체를 훑어야 한다** — 파일 하나를 고치고 끝내지
> 않는다.

## 7. 다음 세션이 먼저 볼 파일

| 파일 | 왜 |
|---|---|
| `web/js/core/app-editor.js` | `_edReconcile` 의 dirty 가드(`_edWinDirty`) · `_edApplyServer` 의 계약 · `_edDocDrop` |
| `web/js/ui/file-editor.js` | `save()` 의 `_doc.saving` · `refresh()` 의 `setValue` · `_dirty` 접근자 |
| `web/js/ui/file-tree-paint.js` | `_fail`·`_clearErr` — 실패 메시지의 수명 |
| `web/js/core/app-layout.js` | `_mkWindow`(승계 없음) · 탭 닫기의 dirty 가드 |
| `internal/helper/runtimebin/dmctl.go` | `--cwd` 와 `cwdTool` 을 싣지 않는 판단 |
| `web/js/core/app-settings.js` | `_saveSettings` 의 블롭 리터럴 — 값을 더할 때 함께 고쳐야 하는 자리 |
| `web/js/core/constants-git.js` | `GIT_GROUP_BULK`(그룹당 하나) · `GIT_BULK_LABEL` · `GIT_DISCARD_NOTE` — 묶음 D 가 바꾸는 자리 |
| `web/js/git/panel-changes.js` | 그룹 머리 조립(`:248`) · `_emitTree`/`_emitFlat`(`:429·437`) · `_dirEl` — 묶음 D·F |
| `web/js/git/panel-files.js` | `_bulk`·`_run`·`_discard`(`:182·188·258`) — 명령 분기가 이미 사는 자리 |
| `internal/webserver/httpapi/handlers_fs.go` | `fsRoot`·`fsResolveTarget`·`fsRenameNoReplace`·`fsDeleteMax` — 묶음 P 의 복사 종단이 딛는 자리 |
| `web/js/ui/file-tree-xfer.js` | `_onCtx` 의 메뉴 조립(`:184`) — 묶음 P 가 셋을 더하는 자리 |
