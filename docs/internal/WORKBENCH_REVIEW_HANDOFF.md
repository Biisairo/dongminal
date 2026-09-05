# 인계: 작업대 사용자 검토 (WORKBENCH_REVIEW) — 2026-09-05 (2차 세션)

스펙은 [`./WORKBENCH_REVIEW_SRS.md`](./WORKBENCH_REVIEW_SRS.md) 이고, 여기에는 그
스펙이 말하지 않는 것 — **어디까지 섰고, 무엇이 왜 그렇게 됐는지** — 만 적는다.

## 1. 지금 상태

| 대상 | 결과 |
|---|---|
| `go build ./...` · `go test ./...` | **전부 통과** |
| `npx playwright test` (chromium + mobile-touch) | **1117 통과 · 3 skip · 0 실패** (22.3분) |
| CI 가 도는 것 | `go vet` · `go test -race` · `check-seams.sh` · `check-cross.sh`(5종) · **Windows 잡** |

> **CI 에서 두 번 붉었고 둘 다 로컬에서 피할 수 있었다.** 적어 둔다.
>
> | 무엇 | 왜 |
> |---|---|
> | Windows 의 `TestFSCopyPreservesMode` | Windows 에는 실행 비트가 없다 — `os.Chmod` 가 읽기전용 비트만 만지고 `Perm()` 은 `0666` 이다. "0755 인가" 가 아니라 **"원본과 같은가"** 로 재야 플랫폼을 타지 않는다 |
> | `check-seams.sh` 의 `runtime.GOOS` | 그 값은 `internal/shared/platform` 안에서만 만진다(FR-XPL-5). `platform.BuildTarget()` 은 주석이 **"분기의 근거가 아니다"** 라고 못박으므로 우회로가 아니다 |
>
> **게이트는 코드를 고친 *뒤에* 다시 돌려야 한다.** 두 번째 실패는 내가 게이트를
> 돌린 다음에 `runtime.GOOS` 를 넣어서 났다. 푸시 전 순서는
> `go vet ./...` → `check-seams.sh` → `check-cross.sh` → `go test -race` 다.
| 커밋 | `770a37e`(3차 스펙) · `4489218`(묶음 D·P·F) · 이 커밋(묶음 R) |

접수한 아홉 건 중 **여덟이 닫혔고**, 하나는 사용자가 넘기기로 했다. 남은 것은
**메모리 하나**이며 재현을 기다린다. 메모 저장은 절반만 닫혔다 (§3).

| # | 건 | 상태 |
|---|---|---|
| 7 | "자기 하위로는 옮길 수 없습니다" 가 안 지워짐 | ✅ 묶음 X |
| 8 | 한줄보기 / 줄바꿔보기 옵션 | ✅ 묶음 W |
| 5 | 새 창이 홈이 아닌 현재 위치에서 열림 | ✅ 묶음 C |
| 4 | 메모장이 안 보이는 경우가 있음 | ✅ 묶음 N |
| 3 | 메모가 제대로 저장되지 않음 | 🔸 **절반.** 묶음 S·R 이 길 **둘**을 닫았으나 **증상을 재현하지 못했다** (§3) |
| — | 외부 접속에서 알림이 안 울림 | ⊘ 넘김 — 결론은 SRS §6 비목표 6 |
| 6 | 메모리 30GB | ⬜ 재현 대기 — **후보는 좁혔다** (§4: LSP 자식 여섯) |
| 1 | 탐색기 복사·복제 | ✅ 묶음 P — 서버 종단 신설(`/api/fs/copy`) |
| 2 | 폴더 단위 스테이징 | ✅ 묶음 F — 트리 보기의 폴더 행에 동작 |
| 9 | `Changes`·`Untracked` 의 Discard All | ✅ 묶음 D — 딸린 `-u` 결함(§5.1)도 함께 닫았다 |

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

**1차가 "아직 보지 않은 자리" 로 남긴 둘은 이제 닫혔다** (묶음 R).

- **`save()` 의 `_doc.saving`** — 진짜였고, **결함이 하나가 아니라 둘**이었다.
  `finally` 가 `saving` 을 못 내리는 것에 더해, `set _dirty` 가 `_doc` 이 끊기면
  **죽은 필드**(`__dirty`)에 쓰기 때문에 **쓰기가 성공해도 문서가 dirty 로 남았다**
  — 남은 칸의 탭에 저장 안 됨 표시가 남고 재조정이 그 창을 붙든다(FR-WBR-40·41).
  고쳤다(FR-WBR-90~92). 시험은 `slot-view-state` **TC-SVS-53** 이며, 쓰기를 페이지
  안에서 붙잡아 둔 채 그 칸을 없애 **저장이 날아가 있는 동안의 파괴**를 만든다.
  > **이것이 §3 의 재현되지 않은 증상과 모양이 같다.** 사용자가 "저장이 안 되는
  > 경우가 있다" 고 한 것이 이 자리일 수 있다 — 그러나 **증명하지 못했다.**
  > 사용자의 증상은 메모장·단일 칸이었고 이 결함은 **두 칸**을 요구한다.
- **`app-reload.js` 의 죽은 트리 갱신** — 진짜였다. 고쳤다(FR-WBR-95). 시험은
  `soft-reload` **SR8** 이며, 폴링을 세운 뒤 디스크에 파일을 만들고 내부
  새로고침이 그것을 데려오는지 본다.

## 4. 메모리 30GB — 재현은 없지만 후보는 좁혔다

사용자 관측은 **"메모리 모니터를 봤을 때 dongminal 이었던 것 같다"** 뿐이다. 재현
조건이 없으므로 요구사항으로 적지 않았다 (D-WBR-6). **대신 재현 없이 할 수 있는
일 — 후보 좁히기 — 은 했다.** 표는 SRS §2.14 이고 요지는 둘이다.

**① 서버(Go) 자신의 큰 경로는 전부 상한이 있다.** PTY 버퍼·git 출력(1MiB)·job 의
보존 줄·목록/삭제/복사(10000)·검색(2MiB)을 코드로 확인했고, 폴더 zip 과 파일 읽기는
**스트리밍**이라 메모리에 담지도 않는다. 상한이 없는 것은 요청 본문뿐이며 그것은
정상 사용이 아니라 `--expose` 의 공격면이다.

**② 가장 유력한 것은 서버가 아니라 그 자식이다.** LSP 세션은 **동시에 6개**까지
살고(`lsp/manager.go:18`) 유휴 회수는 **20분** 뒤다(`:15`). `gopls` 는 큰 모듈에서
수 GB 를 쓰는 것이 흔하고 `typescript-language-server` 도 그렇다 — **여섯이면
자릿수가 맞는다.** 이들은 dongminal 이 띄운 자식이므로 활성 상태 보기의 프로세스
트리가 그것을 부모 아래로 굴려 보인다. dongminal 은 자식에 메모리 상한을 걸지 않는다.

**다음에 그 일이 나면 먼저 이것을 본다:**

```
ps -Ao rss,command | sort -rn | head -20
```

`gopls`·`*-language-server` 가 위에 있으면 원인이 좁혀진다(그때의 선택지는 세션
상한을 낮추거나 유휴 시간을 줄이는 것이다). dongminal 자신이 위에 있으면 §2.14 의
상한 중 하나가 새는 것이므로 `pprof` 의 heap·goroutine 으로 간다.

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

### 5.1a 실측이 결정을 뒤집었다 — 그룹 일괄은 **아이콘**이다

인터뷰에서 "라벨을 가른다"(`Discard All`/`Delete All`)와 "줄을 늘린다" 를 골랐다.
**구현이 둘 다 뒤집었다** (D-WBR-18).

기본 폭 220px 에서 머리 안쪽은 203px 이고, caret·이름·개수가 쓰고 **남는 자리는
80px** 이다. 필요한 것은:

| 조합 | 필요 | |
|---|---:|---|
| `Stage All`(61) + `Discard All`(70) + 간격 | **136** | ✗ |
| `Stage`(≈49) + `Discard`(≈61) + 간격 | **115** | ✗ |
| 이름을 하한 60px 까지 눌러 얻는 자리 | (99) | ✗ 여전히 모자람 |
| 아이콘 `+`(30) + `↺`(30) + 간격 | **65** | ✓ 여유 15 |

**글자 라벨 둘은 어떤 조합으로도 220px 에 들어가지 않는다.** 줄을 늘리자 머리가
36→71px 이 되어 FR-GIT-220 을 깨고, 밀린 목록의 행이 뷰포트 밖(y=696, 높이 720)으로
나가 우클릭 메뉴를 누를 수 없게 됐다.

**그것을 잡은 것은 기존 시험 둘이다** — `git-ui-revision` V97(머리 높이 균일)과
`git-file-actions` F5. **F5 는 3/3 결정적 실패였고**, `git stash push -- web/` 로
CSS 만 되돌리자 통과해 원인이 확정됐다. 회귀표(§6)의 flake 와 성질이 다르다.

지금은 행 동작과 **같은 어휘**(`GIT_ACT_LABEL` 의 `+`·`−`·`↺`)를 쓰고, 갈리는
뜻은 **툴팁**이 말한다(FR-WBR-52a). 확인창은 여전히 갈린다(FR-WBR-55).

### 5.2 요구를 뒤집었으므로 그 이름으로 훑은 자리

`FR-EDT-86`·`FR-FTR-16`·`FR-EDT-87/112` 와 `stash push` 를 코드·시험 전체에서
훑었다. **바뀌는 시험은 하나다** — `git-staging` **E8**(`:157`)이
`git stash push -- tracked.txt` 를 단언한다.

나머지는 영향이 없다: `git-confirm`·`git-dialog` 는 hint 를 **시험이 직접 만들어**
확인창에 넘기고, `git-hunk`·`write/patch_test.go` 는 hunk revert(tracked 파일
하나)이며, `git-file-actions` F12 는 이미 `-u` 를 본다. `editor-ops` **O6**
(FR-EDT-86)은 이동·생성을 시험하므로 그대로 산다 — 복사는 **다른 조작**이고
덮어쓰기 금지는 어디에도 그대로다.

`Stage All`·`GIT_BULK_LABEL`·`.git-group-bulk` 도 같은 방식으로 훑었다 — 글자를
단언하던 자리는 내가 이번에 쓴 `git-discard-all` D1 뿐이었고, `git-staging` E1b 는
처음부터 `data-act` 로 골라 그대로 산다.

개정 줄을 적은 문서 여섯: `EDITOR_TAB_SRS`(머리 표에 3줄) · `FILE_TRANSFER_SRS`
(머리 표 신설) · `EXPLORER_TRANSFER_IGNORE_SRS`(머리 표 신설) · `GIT_ACTIONS_SRS`
(FR-GIT-277 의 "discard 의 선례" 가 사실이 아니었다는 정정) · `GIT_UI_REVISION_SRS`
(`.git-group-bulk` 가 라벨 버튼이 아니게 됐다) · `GIT_MANUAL_CHECKLIST`(G2.13·14).

### 5.3 구현 순서

1. ~~**묶음 D**~~ ✅ — 표면만 바뀌었고 `-u` 결함을 함께 닫았다.
2. ~~**묶음 P**~~ ✅ — 서버 종단을 신설했고 Go 시험 9 + e2e 6 이 선다.
3. ~~**묶음 F**~~ ✅ — 폴더 행이 파일 행과 **같은 클래스**(`.git-file-act`)를 쓴다.
4. ~~**묶음 R**~~ ✅ — 1차가 남긴 "아직 보지 않은 자리" 둘과 D-WBR-8 을 닫았다.
5. **메모리** — 재현이 먼저다 (§4). **남은 것은 이것 하나다.**

## 6. 회귀의 flake — 회차마다 자리가 바뀐다

전체 회귀를 일곱 번 돌렸다. 다섯 회차에서 1~4건이 붉었는데 **겹치는 자리가 거의 없고
전부 단독 재실행에서 통과했다.** 4·7회차는 0 실패였다.

| 회차 | 붉었던 자리 |
|---|---|
| 1 | `explorer-transfer-ignore` ET3 · `sidebar-tabs` T14 · `slot-view-state` TC-SVS-51 |
| 2 | `editor-ops` O2 · ET3 · `git-history` H26 · `ux-revision` V-CWD-1(**진짜 결함**, 고침) |
| 3 | `git-polling` P4 |
| 4 | 없음 |
| 5 | ET3 · `git-history` H18 · H12 · `git-remote-actions` E10 |
| 6 | `slot-view-state` TC-SVS-50 |
| 7 | **없음** |

**`ET3` 이 일곱 회차 중 셋(1·2·5)에서 붉었다** — 겹치는 유일한 자리다. 나머지는
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
