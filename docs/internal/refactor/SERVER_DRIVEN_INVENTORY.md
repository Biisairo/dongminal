# 서버와 화면이 같은 판단을 따로 하는 자리 — 전수 목록

> 2026-11-05 · `main` · 기준 커밋 `7c252679`
> 출발점: [`PROD2.md`](PROD2.md) #9·#10. 사용자 결정: **서버가 동작별 가능 여부와 이유를 보내고, 화면은 그대로 그린다**(server-driven). 화면은 방금 누른 버튼만 "진행 중" 으로 막는다.
> 조사: 읽기 전용 조사 둘(git 화면 / 그 밖)이 file:line 근거와 함께 모았다. 표의 ✔ 는 이 문서를 쓴 세션이 코드에서 직접 다시 확인한 줄이다. 나머지는 조사 결과 그대로이며 SRS 에서 다시 확인한다.

## 0. 앞선 설명의 정정

`PROD2.md` #9 와 그 뒤의 설명에서 "`branch/delete-remote`·`tag-push`·`tag-delete-remote` 는 서버에서 작업이 아니다" 라고 적었다. **틀렸다.** 셋 다 `push` 작업으로 돈다(✔ `handlers_git_branch.go:505` · `handlers_git_tag.go:187`). `gitlock.go` 의 `lockNone` 은 "저장소 단위 잠금을 걸지 않는다" 이지 "작업이 아니다" 가 아니다. 그래서 화면의 칸 판정은 이 셋에 대해 맞다. 실제 어긋남은 아래 G-A1·G-A2 다.

## 1. 분류

| 부류 | 뜻 | 처리 방향 |
|---|---|---|
| **D** 중복 | 서버가 막고, 화면도 같은(또는 비슷한) 규칙으로 미리 막는다 | server-driven 으로 옮긴다 |
| **S** 서버만 | 서버는 막는데 화면은 모른다 — 누른 뒤에야 오류를 본다 | server-driven 으로 옮기면 함께 풀린다 |
| **C** 화면만 | 서버가 막지 않는 것을 화면만 막는다 | **정책 결정이 먼저다** — 서버도 막을지, 화면의 편의로 둘지 |
| **O** 화면 소관 | 화면이 주인인 상태(레이아웃 등)의 규칙 | 옮기지 않는다 |
| **K** 상수 | 같은 값이 두 언어에 있다 | server-driven 과 다른 트랙 — 서버가 값을 보내거나 게이트로 대조 |

## 2. git 화면

### 2.1 동작 가능 여부

| # | 부류 | 화면 | 서버 | 차이 | 쓰는 곳 |
|---|---|---|---|---|---|
| G-A1 | D | 요청 키 → 칸 `gitJobSlotsOf`(`constants-git-remote.js:25-30`, `jobs.js:76-79`, `menu.js:431-440`, `remote.js:170-180`) | `jobs.SlotsOf`(`exclusion.go:33-43`) | 원격 키는 같다. Go 의 `submodule`·`worktree`(common)에 해당하는 화면 키가 없다 | Fetch/Pull/Push 와 ▾, `busy:` 를 가진 메뉴 항목 |
| G-A2 | D | index 칸이 바쁘면 동기 쓰기를 막음 `blocks`(✔ `jobs.js:82-85`), 예외 `GIT_JOB_INDEX_EXEMPT` | `indexBusy`(`gitwrite.go:237-243`), `writeLocks` | 부분. ① 화면은 `init` 도 막는다(서버는 잠금 없음) ② lock 지우기: 서버는 index·common 을 다 본다(✔ `handlers_git_lock.go:49-56`), 화면은 index 만 ③ worktree 만들기·서브모듈 update: common 이 바쁘면 서버 409, 화면은 미리 안 막는다 ④ worktree 지우기: 서버는 대상 worktree 의 칸을 본다, 화면은 예외 | 모든 `panel.post` 쓰기 |
| G-A3 | D·S | 커밋 `_why`(`commit.js:251-260`) | `handlers_git_write.go:199`·`:238-241` | 부분. 메시지가 같은 amend 거절과 preflight 막힘(`:208-219`)은 서버만 안다 | 커밋 버튼과 이유 줄 |
| G-A4 | D | stash 만들기 `_why`(✔ `stash-dialogs.js:42-48`) | `StashableCount`·`StashEmptyReason`(✔ `stash.go:189-205`) | 수는 같다. 이유 문구는 다르다 — Go 주석은 "클라이언트가 그대로 보인다" 고 적었지만 화면은 자기 i18n 문구를 쓴다 | stash 만들기 대화상자 |
| G-A5 | D | stash 탭 "새로" `_why`(`stash.js:135-141`) | `StashableCount(st,true)` 와 같은 효과 | 같다 | stash 탭 |
| G-A6 | D | 커밋 안 된 변경 → Stash, `dirtyCount()==0` 이면 끔(✔ `menu.js:326`) | `stash.go:149` | 겹침(그룹 구성은 미확인) | 커밋 안 된 행 메뉴 |
| G-A7 | D | Clean, untracked 가 없으면 끔(`menu.js:333-335`) | `gitCleanBlocked`(`handlers_git_uncommitted.go:~74-78`) | 같다 | 커밋 안 된 행 메뉴 |
| G-A8 | S | Reset — 화면에 판정 없음(✔ `menu.js:330`) | `gitResetBlocked`(✔ `handlers_git_uncommitted.go:63-65`, 커밋이 없으면 `no_head`) | 서버만 | 커밋 안 된 행 메뉴 |
| G-A9 | C | 진행 중인 작업(merge 등)이면 cherry-pick·revert·reset·drop·merge·rebase 를 막음 `gitOpBusy`(✔ `menu.js:44-50`) | 없음 — git 이 실패하게 둔다 | 화면만 | 커밋·브랜치 메뉴 |
| G-A10 | C | 대상이 HEAD 면 cherry-pick·reset 끔 `whyHead`(`commit-ops.js:213-216`) | 없음 | 화면만 | History 메뉴 |
| G-A11 | D | Drop: 부모 0개(root)·2개 이상(merge) 막음 `whyDrop`(`commit-ops.js:222-227`) | `handlers_git_commit_ops.go:141-148` | 조건은 같다. 서버 문구는 하나다 | History → Drop |
| G-A12 | D·C | 브랜치 메뉴: 현재 브랜치 checkout, 로컬 전용 동작, upstream 해제, 현재 브랜치 삭제(`menu.js:143-184`·`:205-210`) | 현재 브랜치 삭제만 서버가 본다(`handlers_git_branch.go:317-325`), 나머지는 없음·미확인 | 부분 | 브랜치 메뉴 |
| G-A13 | C | 양쪽 지우기: 추적 로컬이 정확히 하나여야(`branches-ops.js:395-408`, `menu.js:232-237`) | 없음 | 화면만 | 브랜치 → 양쪽 삭제 |
| G-A14 | D | upstream 없으면 publish 확인 먼저(`branches-ops.js:337-339`) | `ErrPublishRequired`(`write/remote.go:225`, 409 로 되돌아옴) | 겹침, 서버가 최종 | 브랜치 메뉴 Push |

### 2.2 입력 검증

| # | 부류 | 화면 | 서버 | 차이 |
|---|---|---|---|---|
| G-B1 | D | annotated·signed 태그는 메시지 필수(`tag.js:182-187`) | `write/tag.go:116-118` | 같다 |
| G-B2 | C | upstream 이 비지 않고 **알려진 원격 ref** 여야(`branches-dialogs.js:192-196`) | `CheckRefArg` 만(`write/branch.go:379-391`) | "모르는 원격" 은 화면만 |
| G-B3 | D | worktree 이름·ref 비지 않음(`worktrees.js:251-255`) | `worktree.CheckName` + ref(`handlers_git_worktree.go:147-151`) | 서버가 더 엄격 |
| G-B4 | D | 원격 이름·url 비지 않음(`remote.js:915-919`) | 이름 글자·url 검사(`write/remote.go:276-301`) | 서버가 더 엄격(화면 주석이 의도라 적음) |
| G-B5 | D | stash → 브랜치 이름 비지 않음(`stash-dialogs.js:~96`) | git 에 맡김(미확인) | 부분 |
| G-B6 | D | 비교할 rev·경로 비지 않음(`commit-ops.js:155-157`) | rev 검사(`handlers_git_commit_ops.go:~179`) | 부분 |
| G-B7 | ? | 저장소 추가 경로 비지 않음(`app-git.js:707`) | 미확인 | — |
| G-B8 | C | `origin/x` 를 첫 `/` 에서 갈라 로컬 이름·원격+브랜치를 만듦(`branches-ops.js:60-65`·`:150-155`) | 없음 — 서버는 받은 대로 | 화면만 |
| G-B9 | D | 같은 이름으로 rename 막음(`branches-dialogs.js:84`·`:126`) | `write/branch.go:311` | 겹침 |

### 2.3 이미 server-driven 인 자리 (선례)

- 파괴적 동작 목록·진행 중 작업의 출구: `/api/git/policy`(`handlers_git_policy.go:39-57`) → `confirm.js:72-127`
- 브랜치·태그 이름 규칙과 존재 여부: `/api/git/branch/validate`·`/api/git/tag/validate` → `branches-dialogs.js:72-85`·`tag.js:190-201`
- 도는 작업의 칸: 서버의 `job.slots` → `remote.js:146` `holds()`
- publish 필요: 서버 409 `publish_required` + plan
- push 거절 후속 선택지·병합 안 된 브랜치 삭제 선택지·preflight 막힘·worktree `main` 표시

## 3. git 이외 화면

### 3.1 동작 가능 여부

| # | 부류 | 화면 | 서버 | 차이 | 쓰는 곳 |
|---|---|---|---|---|---|
| F-A1 | D | 폴더를 자기 하위로 옮기기 막음 `pathUnder`(✔ `file-tree-edit.js:208`, 일괄 이동 `:409`) | `fsCopyGuardSelf`(✔ `handlers_fs_mutate.go:68-74`) | 부분 — 화면은 경로 글자, 서버는 심볼릭 링크를 푼 뒤 비교. **화면 주석이 낡았다**(✔ "서버의 rename 은 이것을 성공시킨다") | 트리 이동 |
| F-A2 | D·S | 루트는 지우기·이름 바꾸기 대상에서 뺌(`file-tree-edit.js:258`·`:29`) | `fsDeletable`(`handlers_fs_mutate.go:198`) — 루트·홈·파일 시스템 루트 거절 | 부분 — 홈 폴더 거절은 서버만 | 삭제 메뉴·확인창 |
| F-A3 | D | 삭제 확인창이 항목을 **2000** 까지 셈(✔ `constants-editor.js:549`) | **10000** 넘으면 거절(✔ `handlers_fs_mutate.go:181-188`) | **다르다** — "2000개 이상" 을 확인했는데 서버가 거절할 수 있다. 주석의 "서버에 세는 종단이 없다" 도 지금은 반만 맞다 | 삭제 확인창 |
| F-A4 | D | Run 닫기 버튼은 `open` 일 때만(`runs-panel.js:188`·`:226`) | `run_closed`(`handlers_runs_close.go:132-135`) — 화면은 늘 `force:true` 를 보낸다 | 부분 | Run 행 |
| F-A5 | D | 떼기 버튼은 `m.tabId` 가 있을 때만(`run-dashboard.js:377`) | `member_not_attached`(`handlers_runs_headless.go:206`) | 같다 | 멤버 카드 |
| F-A6 | D·C | 샌드박스 런타임 시작: `!missing && startTryable`(`app-tool.js:142`) | `StartTryable`(`runtime.go:53`·`:88`), 시작 처리기는 missing 을 안 봄 | 부분 | 런타임 Start |
| F-A7 | O | `work=none` 이면 작업 모드·폴더를 버림(`app-tool.js:300-302`) | `place.go:139`·`sandbox.go:281` 도 버림 | 같다 | 프로파일 고르기 |
| F-A8 | C | 터미널 드롭 업로드는 `source==='tool'` 이고 cwd 를 알 때만(`term-pane.js:709`) | `/api/upload` 는 아무 `dir` 이나 받음(`handlers_files.go:183`) | 화면만 | 드롭 업로드 |
| F-A9 | D | 접근 제어 저장 전 "내가 잠기는가" — IPv4 CIDR·호스트 판정을 화면이 다시 구현(✔ `app-settings-access.js:76-122`) | `allowed`·`isSelf`·`validateAccessValue`(`access.go:223`·`:378`·`:400`) | **다르다** — 화면은 IPv4 만, 판단 못 하면 "잠긴다" 로 봄. 서버는 netip·자기·별칭 | 저장 전 경고 |
| F-A10 | C | "UTF-8 로 변환" 끄기(`app-statusbar-enc.js:60-62`, `app-editor-doc.js:153`) | 없음(미확인) | 화면만 | 인코딩 메뉴 |
| F-A11 | O | 분할·칸·탭 끌기 규칙(`renderer-chrome.js:132-159`, `app-dnd.js:84-132`) | 없음 — 레이아웃은 브라우저가 쓴다 | 화면 소관 | 레이아웃 조작 |

### 3.2 입력 검증

| # | 부류 | 화면 | 서버 | 차이 |
|---|---|---|---|---|
| F-B1 | C | 만들기·이름 바꾸기 이름에 `/` 금지, `\` 는 안 봄(`file-tree-edit.js:48`) | 이름 규칙 없음 — 루트·경로 가드만(`handlers_fs.go:384`) | **서버가 `a/b` 를 받는다**(폴더 `a` 가 있으면) |
| F-B2 | C | 이름 길이 64 `ENTITY_NAME_MAX`(`constants.js:484`) | 없음 | 화면만 |
| F-B3 | D | 루트 추가 경로 비지 않음(`app-editor-section.js:43`) | `wsentry.go:48-50` | 서버가 더 엄격 |
| F-B4 | D | 문서 링크가 루트 안인지 `docInsideRoot`(`doc-render.js:156`) | `fsRoot` 가드 | 목적이 같다 |

### 3.3 이미 server-driven 인 자리 (선례)

편집기 열기 상한(probe 의 `maxBytes`) · 업데이트 판정(`newer`) · Run 맥락 수준 · 런타임 `startTryable`(부분) · 도구 닫기 확인(`/api/tools/busy`) · 주의 claim · 포커스 소유. 파일 트리의 `disabled: string`(이유) 장치(`ui-kit.js:570`)는 서버가 보낸 이유를 그릴 준비가 돼 있다.

## 4. 상수 (부류 K — 별도 트랙)

| # | 화면 | 서버 | 같은가 | 지금 맞추는 장치 |
|---|---|---|---|---|
| K1 | 칸 이름(`constants-git-remote.js:23-24`) | `exclusion.go:20-24` | 같다 | 주석 |
| K2 | `GIT_REMOTE_LABEL` 키 | `jobKinds`(`kinds.go:20-32`) | submodule·worktree 이름 없음 | 주석 |
| K3 | `GIT_JOB_LINE_CAP`=2000 | `job.go:25` | 같다 | 주석 |
| K4 | push 거절 후속 이름 | `job.go:44-46` | 같다(목록은 서버가 줌) | 주석 |
| K5 | History 300/100/2000 | `query/log.go:32-34` | 같다 | 주석 |
| K6 | `_digest` FNV-1a(`history-load.js:171-179`) | `gitOidDigest` | 알고리즘 두 벌 | 주석 |
| K7 | 태그 종류(`constants-git-actions.js:108-116`) | `TagKinds`(validate 응답에 이미 실림) | 같다 | 화면이 응답 대신 상수를 씀 |
| K8 | reset 모드 | `ResetModes`(주석은 "API 로 노출" 이나 처리기가 안 씀) | 같다 | 주석 |
| K9 | `GIT_OP_BY_BLOCK` | `query/preflight.go:17-23` | 키가 같다 | 주석 |
| K10 | `GIT_OP_*` | `operationVerbs` | 같다 | 주석 |
| K11 | `FS_STAMP_MAX`·`FILE_STAMPS_MAX`·`FS_WATCH_DIRS_MAX` | `handlers_fs_stamp.go:30` 등 | 같다 | 주석 |
| K12 | LSP close 코드 4001-4003 | `handlers_lsp_ws.go:25-27` | 같다 | 주석 |
| K13 | `WS_SCHEMA_VERSION`=2 | `workspace/manager.go:44` | 같다 | 주석 |
| K14 | `RUN_SHORT_ID_LEN`·`runShortId` | `store_query.go:131` — 서버가 `short` 를 이미 보냄 | 같다 | 주석 |
| K15 | `SBX_RT_*`·`SANDBOX_*` | `sandbox/runtime.go`·`config.go`·`copy.go` | 같다 | 주석 |
| K16 | `TERM_REPORT_RE` | `snapshotQueryPattern` | 짝 | 주석 |
| K17 | `SSE_SILENCE_MS`(인사 주기의 3배) | `sseHelloEvery` | 파생 | 주석 |
| K18 | 인코딩 선택지·이름 | `textenc.go:27-32` | 같다 | 없음 |
| K19 | `claudeFullscreen` 기본값 | `agent_render_env.go:102` 가 스키마를 안 읽고 `true` 를 박음 | 같다 | 주석 |
| K20 | 편집기 루트 순서 | `wsentry.go:165` | 같다 | 주석 |

## 5. 낡은 주석

- `file-tree-edit.js:206` — 서버가 이제 자기 하위 이동을 막는다(F-A1)
- `constants-editor.js:546` — "서버에 세는 종단이 없다"(F-A3)
- `cm-lsp.js:70` — 없어진 Go `languageFor` 를 가리킨다. `:82` 의 `serverRequestResult` 도 찾지 못했다(미확인)
- `stash.go:198` — "클라이언트가 그대로 보인다" 이나 화면은 쓰지 않는다(G-A4)
- `app-statusbar.js:265` — `PROD2.md` §9
