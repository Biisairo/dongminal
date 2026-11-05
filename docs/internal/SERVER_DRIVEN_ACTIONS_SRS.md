# SRS: 서버가 답하는 동작 가능 여부 — server-driven actions — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 묶음 M·GR·GT·GV·F·R·X·K·N 전부(구현 전). 인계 문서 `docs/internal/SERVER_DRIVEN_HANDOFF.md`

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

화면과 서버가 같은 판단을 따로 한다. 버튼을 켤지, 메뉴 항목을 막을지, 입력이 맞는지를 화면이 자기 규칙으로 정하고, 서버는 같은 판단을 다시 하거나(중복) 하지 않는다(화면만). 두 규칙은 주석으로만 묶여 있어 어긋나도 아무것도 실패하지 않는다. 실제로 이미 어긋난 자리가 있다(§2).

이 SRS 는 판단의 주인을 **서버 하나**로 정한다. 서버는 동작마다 "할 수 있는가 · 못 하면 왜" 를 답하고, 화면은 그 답을 그린다. 화면을 거치지 않은 요청도 서버가 같은 규칙으로 거절한다.

### 1.2 범위 (Scope)

- 전수 목록 `docs/internal/refactor/SERVER_DRIVEN_INVENTORY.md`(기준 커밋 `7c252679`)의 부류 D·S·C 전부와 부류 K 전부.
- 부류 O(화면이 주인인 레이아웃 규칙: F-A7·F-A11)는 범위 밖이다(§6).

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| 동작(action) | 화면의 버튼·메뉴 항목 하나가 일으키는 서버 요청 하나. 이름은 `actionId`(예: `git.fetch`, `fs.delete`) |
| 답(answer) | 동작 하나에 대한 `{ok, why, args}`. `ok` 가 거짓이면 `why` 는 사유 **코드**, `args` 는 그 문구에 넣을 값 |
| 1층(상태에 싣는 답) | 늘 보이는 버튼의 답. 상태 응답에 함께 실리고 상태가 바뀌면 다시 온다 |
| 2층(열 때 묻는 답) | 우클릭 메뉴처럼 대상 하나에 대한 답. 메뉴를 열 때 서버에 묻는다 |
| 진행 중(pending) | 사용자가 방금 누른 컨트롤 하나를, 그 요청의 응답이 올 때까지 막아 두는 화면 상태. 규칙이 아니다 |
| 공유 상수 | 화면과 서버가 같은 값을 써야 하는 상수 |

### 1.4 참고 (References)

- `docs/internal/refactor/SERVER_DRIVEN_INVENTORY.md` — 항목 ID(G-·F-·K-)의 출처
- `docs/internal/refactor/PROD2.md` §7a — 결정 경위
- 선례: `/api/git/policy`(`handlers_git_policy.go`), `/api/git/branch/validate`·`/api/git/tag/validate`, 파일 트리의 `disabled: string` 사유 장치(`ui-kit.js`)
- 외부 선례: GitHub GraphQL 의 객체별 `viewerCanX`(1층과 같은 모양), Jira `GET /issue/{key}/transitions`(2층과 같은 모양)

### 1.5 개요 (Overview)

§2 현황 · §3 요구사항(묶음 M 공통 장치, GR·GT·GV git, F 파일, R Run, X 그 밖, K 상수, N 주석) · §4 결정 · §5 검증 · §6 비목표 · §7 위험 · §8 변경 기록.

## 2. 현황 (Identified Issue)

### 2.1 이미 어긋난 자리

- **파일 삭제 상한.** 확인창은 항목을 2000 까지 세고(`constants-editor.js:549`), 서버는 10000 을 넘으면 거절한다(`handlers_fs_mutate.go:181-188`). 사용자가 "2000개 이상" 을 확인해도 서버가 거절할 수 있다.
- **접근 제어 잠김 경고.** 화면이 IPv4 CIDR 판정을 다시 구현했다(`app-settings-access.js:76-122`). 서버는 netip·자기 주소·별칭을 본다(`access.go`). IPv6 에서 두 판정이 갈린다.
- **잠금 지우기.** 서버는 index·common 칸을 다 보고(`handlers_git_lock.go:49-56`), 화면은 index 만 본다(`jobs.js:82-85`).
- **stash 사유.** 서버 주석은 "클라이언트가 `StashEmptyReason` 을 그대로 보인다" 고 적었지만(`stash.go:198`) 화면은 자기 문구를 쓴다.

### 2.2 서버만 아는 것

Reset 의 `no_head`(G-A8), amend 메시지 불변·preflight 막힘(G-A3), 홈 폴더 삭제 거절(F-A2). 화면은 누른 뒤에야 오류를 본다.

### 2.3 화면만 막는 것

12건(G-A9·A10·A12 일부·A13, G-B2·B8, F-A6 일부·A8·A10, F-B1·B2). 화면을 거치지 않은 요청(`dmctl`·스크립트·다른 탭)은 통과한다. 그중 F-B1(이름의 `/`)은 서버가 받아 다른 폴더에 파일을 만든다.

### 2.4 상수 20건

K1~K20 은 주석으로만 묶여 있다. 맞추는 장치가 있는 것은 파일 URI(공유 표본) 하나다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 M — 공통 장치 (FR-SDA-1~)

| ID | 요구 | 우선 |
|---|---|---|
| FR-SDA-1 | 답의 모양은 `{"ok": bool, "why": string, "args": object}` 하나다. `ok` 가 참이면 `why`·`args` 를 싣지 않는다 | 필수 |
| FR-SDA-2 | `why` 는 사유 **코드**다(예: `job_busy`, `nothing_to_stash`). 기존 오류 코드(`apierr`·`gitErr*`)가 같은 뜻이면 그것을 쓴다. 문구는 화면의 i18n 이 코드로 고른다 — 서버는 문구를 보내지 않는다 | 필수 |
| FR-SDA-3 | 서버는 동작마다 **판정 함수 하나**를 둔다. 답(1층·2층)과 실행 요청의 거절은 **같은 함수**를 부른다. 판정이 거짓이면 실행 요청은 409(상태 때문) 또는 400(입력 때문)과 같은 `why` 코드로 거절된다 | 필수 |
| FR-SDA-4 | 1층: 늘 보이는 컨트롤의 답은 상태 응답의 `actions` 객체(`actionId → 답`)로 싣는다. 상태가 바뀌어 다시 받을 때 함께 바뀐다 | 필수 |
| FR-SDA-5 | 2층: 대상 하나에 대한 답은 `GET .../actions?<대상>` 로 묻는다. 응답은 그 대상에서 메뉴가 보일 수 있는 동작 전부의 답이다. 화면은 응답을 받은 뒤 메뉴를 그린다 | 필수 |
| FR-SDA-6 | 화면은 동작을 켜고 끄는 **규칙을 갖지 않는다.** 화면이 쓰는 것은 서버의 답과 "진행 중" 하나다. 답이 아직 없으면(첫 응답 전) 그 컨트롤은 꺼져 있고 사유는 `loading` 이다 | 필수 |
| FR-SDA-7 | 진행 중: 사용자가 누른 컨트롤은 그 요청의 응답이 올 때까지 꺼지고, 응답이 오면 서버의 다음 답을 따른다 | 필수 |
| FR-SDA-8 | 사유 코드마다 ko·en 문구가 있다. 코드에 문구가 없으면 게이트가 실패한다 | 필수 |
| FR-SDA-9 | 화면을 거치지 않은 요청(`dmctl`·스크립트)도 FR-SDA-3 의 거절을 받는다. `dmctl` 은 그 `why` 코드를 오류로 보인다 | 필수 |

### 3.2 묶음 GR — git 저장소 단위 동작 (1층)

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-20 | `GET /api/git/status` 응답에 `actions` 를 싣는다. 대상 동작: `git.fetch`·`git.pull`·`git.push`(▾ 변형 포함)·`git.commit`·`git.stash.create`·`git.stash.new`·`git.uncommitted.stash`·`git.uncommitted.clean`·`git.uncommitted.reset`·`git.lock.remove`·`git.worktree.create`·`git.worktree.remove`·`git.submodule.update`·`git.init` 와, 칸을 쓰는 브랜치·태그 원격 동작 | G-A1~A8 | 필수 |
| FR-SDA-21 | 칸 판정은 `jobs.SlotsOf` 와 실제 칸 상태 하나에서 나온다. 화면의 `gitJobSlotsOf`·`GIT_JOB_COMMON_KEYS`·`GIT_JOB_INDEX_EXEMPT`·`blocks` 는 없앤다 | G-A1·A2 | 필수 |
| FR-SDA-22 | 작업이 시작·끝나면(`git_jobs_changed`) 화면은 그 저장소의 `actions` 를 다시 받는다 | G-A1 | 필수 |
| FR-SDA-23 | 커밋 동작의 답은 빈 메시지·스테이지 없음·amend 메시지 불변·preflight 막힘을 모두 포함한다. 메시지는 입력 중에 바뀌므로 커밋 답은 `GET /api/git/actions?repo=&action=git.commit&message=&amend=&all=` 로 묻는다(입력 멈춤 뒤, 2층과 같은 종단) | G-A3 | 필수 |
| FR-SDA-24 | stash 만들기 답은 `includeUntracked` 를 받아 판정한다. 사유는 `nothing_to_stash`·`untracked_only` 코드다 | G-A4~A6 | 필수 |
| FR-SDA-25 | Reset 은 커밋이 없는 저장소에서 `no_head` 로 꺼진다 | G-A8 | 필수 |

### 3.3 묶음 GT — git 대상 메뉴 (2층)

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-30 | `GET /api/git/actions?repo=&kind=commit&oid=` 는 커밋 행 메뉴의 답을 낸다: cherry-pick·revert·reset·drop·비교 등 | G-A9~A11 | 필수 |
| FR-SDA-31 | `GET /api/git/actions?repo=&kind=branch&ref=` 는 브랜치 행 메뉴의 답을 낸다: checkout·rename·upstream 설정/해제·push·삭제·양쪽 삭제·merge·rebase | G-A9·A12~A14 | 필수 |
| FR-SDA-32 | 진행 중인 작업(merge·rebase 등)이 있으면 그것과 부딪치는 동작은 `operation_in_progress`(args: 종류)로 꺼지고, 실행 요청도 거절된다 | G-A9 | 필수 |
| FR-SDA-33 | 대상이 HEAD 면 cherry-pick·reset 은 `target_is_head` 로 꺼지고 거절된다 | G-A10 | 필수 |
| FR-SDA-34 | drop 은 부모가 정확히 하나일 때만 된다. 사유는 `root_commit`·`merge_commit` 로 가른다 | G-A11 | 필수 |
| FR-SDA-35 | 양쪽 삭제는 추적 로컬 브랜치가 정확히 하나일 때만 되고, 서버가 그 판정으로 거절한다 | G-A13 | 필수 |
| FR-SDA-36 | 로컬 전용 동작(rename·upstream·push)을 원격 ref 에 보내면 `not_local_branch` 로 거절된다. 현재 브랜치 checkout·삭제도 서버가 거절한다 | G-A12 | 필수 |

### 3.4 묶음 GV — git 입력 검증

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-40 | 대화상자의 입력 검증은 서버의 validate 종단으로 한다. 기존 `branch/validate`·`tag/validate` 와 같은 모양으로, upstream·worktree·원격 추가·stash 브랜치·비교·저장소 추가의 입력을 판정한다 | G-B1~B7·B9 | 필수 |
| FR-SDA-41 | upstream 은 알려진 원격 ref 여야 한다. 서버가 판정하고 거절한다 | G-B2 | 필수 |
| FR-SDA-42 | `origin/x` 를 로컬 이름·원격+브랜치로 가르는 일은 서버가 한다. 화면은 원격 ref 를 그대로 보낸다 | G-B8 | 필수 |
| FR-SDA-43 | 태그 종류·reset 모드처럼 이미 서버 응답에 있는 목록은 응답의 것을 쓴다(K7·K8) | K7·K8 | 필수 |

### 3.5 묶음 F — 파일 트리

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-50 | `POST /api/fs/actions {paths:[…]}` 는 선택한 항목들의 메뉴 답(이름 바꾸기·삭제·복사·옮기기)을 낸다. 삭제 답에는 항목 수를 싣는다. 수는 서버 상한까지 세고, 넘으면 `ok:false`·`too_many_entries`(args: 상한) | F-A2·A3 | 필수 |
| FR-SDA-51 | 루트·홈·파일 시스템 루트의 삭제·이름 바꾸기는 `fsDeletable` 하나로 판정한다(답과 거절이 같다) | F-A2 | 필수 |
| FR-SDA-52 | 자기 하위로 옮기기는 서버가 판정한다(심볼릭 링크를 푼 뒤). 끌어 놓을 때 화면은 판정하지 않고, 놓으면 서버의 답이 오류 줄로 보인다 | F-A1 | 필수 |
| FR-SDA-53 | 만들기·이름 바꾸기의 이름은 서버가 검증한다: 경로 구분자(`/`, Windows 의 `\`) 금지, 빈 이름·`.`·`..` 금지. 대화상자는 입력 중에 `POST /api/fs/validate-name` 으로 묻고, 실행 요청도 같은 함수로 거절된다 | F-B1 | 필수 |
| FR-SDA-54 | 창·탭·그룹 이름의 길이 상한(64)은 서버가 정하고 거절한다. 화면의 `clampEntityName` 은 서버 상한을 받아 쓴다 | F-B2 | 필수 |
| FR-SDA-55 | 편집기 루트 추가 경로는 서버가 판정한다(`wsentry` 의 오류 코드) | F-B3 | 필수 |

### 3.6 묶음 R — Run

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-60 | Run 목록·그래프 응답의 Run 마다 `actions`(닫기·지우기)를, 멤버마다 `actions`(떼기)를 싣는다 | F-A4·A5 | 필수 |
| FR-SDA-61 | 닫기 버튼은 답이 참일 때만 선다. 화면이 늘 `force:true` 를 보내던 것을 멈추고, 서버의 판정을 따른다 | F-A4 | 필수 |

### 3.7 묶음 X — 그 밖

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-70 | 샌드박스 런타임 상태 응답에 `actions.start` 를 싣는다. missing 을 포함해 서버가 판정하고, 시작 요청도 같은 판정으로 거절한다 | F-A6 | 필수 |
| FR-SDA-71 | 터미널 드롭 업로드는 도구 상태의 `actions.upload` 로 판정한다(도구 출처·cwd). `/api/upload` 도 같은 판정으로 거절한다 | F-A8 | 필수 |
| FR-SDA-72 | 접근 제어 저장 전 잠김 경고는 `POST /api/access/check {value}` 의 답으로 한다. 판정은 서버의 `allowed`·`isSelf` 와 같은 함수다. 화면의 `_aclV4`·`_aclCidrHas`·`_aclCoversYou` 는 없앤다 | F-A9 | 필수 |
| FR-SDA-73 | "UTF-8 로 변환" 은 문서 응답의 `actions.convertUtf8` 로 판정한다. 저장 요청도 같은 판정으로 거절한다 | F-A10 | 필수 |

### 3.8 묶음 K — 공유 상수

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-80 | 보낼 수 있는 상수(상한·이름·목록)는 서버가 보낸다. git 쪽은 `/api/git/policy` 에, 그 밖은 새 `GET /api/meta` 에 싣는다. 화면은 부팅 때 한 번 받아 쓴다 | K1~K5·K7·K8·K11·K14·K15·K18·K20 | 필수 |
| FR-SDA-81 | 보낼 수 없는 상수(정규식·해시 알고리즘·연결이 끊긴 순간에 쓰는 코드·부팅 전에 필요한 값)는 두 벌로 두고 **게이트가 대조한다**: K6·K9·K10·K12·K13·K16·K17 | 같은 줄 | 필수 |
| FR-SDA-82 | `claudeFullscreen` 의 기본값은 서버도 설정 스키마에서 읽는다(박아 둔 `true` 를 없앤다) | K19 | 필수 |
| FR-SDA-83 | 서버가 이미 보내는 값(`short` 등)이 있으면 화면은 그것을 쓰고, 자기 계산을 없앤다 | K14 | 필수 |

### 3.9 묶음 N — 낡은 주석

| ID | 요구 | 우선 |
|---|---|---|
| FR-SDA-90 | 전수 목록 §5 의 낡은 주석 다섯을 고친다. 이 SRS 의 변경으로 대상 코드가 없어지면 주석도 함께 없어진다 | 필수 |

### 3.10 비기능 요구사항 (Non-functional)

| ID | 요구 |
|---|---|
| NFR-SDA-1 | 2층 응답은 로컬 서버에서 p95 50ms 안에 온다(메뉴가 늦게 뜨지 않게). 넘으면 메뉴는 항목을 `loading` 으로 먼저 그리고 답이 오면 고친다 |
| NFR-SDA-2 | 1층 `actions` 는 상태 응답의 크기를 2KB 넘게 늘리지 않는다 |
| NFR-SDA-3 | 화면에 남는 판정 코드가 없음을 게이트가 확인한다: 없앤 함수 이름(`gitJobSlotsOf`·`_aclCidrHas` 등)이 `web/js` 에 다시 생기면 실패한다 |

## 4. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| D-SDA-1 | 판단의 주인은 서버 하나다(server-driven) | 사용자 결정 2026-11-05. 두 벌은 주석으로만 묶여 이미 어긋났다(§2.1) |
| D-SDA-2 | 늘 보이는 버튼은 상태에 싣고(1층), 대상 메뉴는 열 때 묻는다(2층) | 사용자 결정 2026-11-05. 커밋 300행마다 답을 실으면 응답이 커지고 작업 하나에 300행을 다시 계산한다. 서버가 같은 기계라 열 때 묻는 왕복은 수 ms 다 |
| D-SDA-3 | 화면만 막던 12건도 서버가 답하고 **거절한다** | 사용자 결정 2026-11-05 |
| D-SDA-4 | 보낼 수 있는 상수는 서버가 보내고, 보낼 수 없는 것만 게이트가 대조한다 | 사용자 결정 2026-11-05 |
| D-SDA-5 | 서버는 사유 코드만 보내고 문구는 화면 i18n 이 고른다 | 제품이 ko·en 을 화면에서 고른다. 서버 문구는 한국어 하나다 |
| D-SDA-6 | 답과 거절은 같은 판정 함수를 부른다 | 둘을 따로 쓰면 이 SRS 가 없애려는 두 벌이 서버 안에 다시 생긴다 |
| D-SDA-7 | 끌어 놓기 중에는 화면이 판정하지 않는다. 놓은 뒤 서버 답을 보인다 | D-SDA-1 을 따른 결과다. 끄는 동안 금지 커서가 사라지는 변화는 §7 R-2 |

## 5. 검증 (Verification)

| ID | 대상 | 방법 |
|---|---|---|
| TC-SDA-1 | FR-SDA-1~3 | Go: 동작마다 판정 함수의 표 시험(참·거짓·사유 코드). 같은 입력으로 답 종단과 실행 종단을 불러 **답이 거짓이면 실행이 같은 코드로 거절됨**을 확인한다 |
| TC-SDA-2 | FR-SDA-6·7 | 단위(JS): 컨트롤이 답·진행 중만으로 켜지고 꺼진다. 답이 없으면 `loading` 이다 |
| TC-SDA-3 | FR-SDA-8 | 게이트: 서버 판정 함수가 낼 수 있는 사유 코드 전부에 ko·en 문구가 있다 |
| TC-SDA-4 | FR-SDA-9 | Go: `dmctl` 이 거절 코드를 오류로 보인다(대표 2건) |
| TC-SDA-5 | 묶음 GR | e2e: push 가 도는 동안 Fetch 가 꺼지고 Commit 은 켜져 있다. 끝나면 Fetch 가 켜진다. lock 지우기는 common 칸이 바빠도 꺼진다 |
| TC-SDA-6 | 묶음 GT | e2e: HEAD 커밋의 메뉴에서 cherry-pick 이 사유와 함께 꺼진다. merge 진행 중이면 rebase 가 꺼진다 |
| TC-SDA-7 | 묶음 GV·F | e2e: 새 파일 이름 `a/b` 가 대화상자에서 거절되고, 같은 요청을 HTTP 로 바로 보내도 400 이다 |
| TC-SDA-8 | FR-SDA-50 | Go: 10001 항목 폴더의 삭제 답이 `too_many_entries` 이고 확인창이 그 사유로 꺼진다(e2e) |
| TC-SDA-9 | FR-SDA-72 | Go: IPv6·별칭·자기 주소를 포함한 표 시험. 화면의 판정 코드가 없다(NFR-SDA-3) |
| TC-SDA-10 | 묶음 R·X | Go+e2e: 각 동작의 답과 거절이 같다(대표 1건씩) |
| TC-SDA-11 | 묶음 K | 단위: 화면이 `/api/meta`·`/api/git/policy` 의 값을 쓴다. 게이트: FR-SDA-81 의 두 벌이 같다(탐침으로 한쪽을 바꾸면 실패) |
| TC-SDA-12 | NFR-SDA-1 | e2e: 2층 응답 시간을 재어 p95 를 적는다 |
| TC-SDA-13 | NFR-SDA-3 | 게이트 탐침: 없앤 함수 이름을 넣으면 실패한다 |

## 6. 비목표 (Non-goals)

- 화면이 주인인 상태의 규칙(레이아웃 분할·칸·탭 끌기, F-A11 · 샌드박스 프로파일의 work=none 처리, F-A7). 서버는 그 판단에 쓸 사실을 갖지 않는다.
- 권한·사용자 구분. 제품에 인증이 없다. 답은 "지금 할 수 있는가" 이지 "이 사람이 해도 되는가" 가 아니다.
- 서버 문구의 다국어화(D-SDA-5).

## 7. 위험 (Risks)

| ID | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 메뉴가 서버 왕복 뒤에 뜬다 | LOW | 로컬 서버. NFR-SDA-1 로 재고, 넘으면 `loading` 으로 먼저 그린다 |
| R-2 | 끌어 놓는 동안 금지 표시가 사라진다(D-SDA-7) | MEDIUM | 놓은 뒤 사유를 오류 줄로 보인다. 사용자가 불편하면 별도 결정으로 끄는 중 묻기(throttle)를 연다 |
| R-3 | 새 거절이 기존 `dmctl`·스크립트 사용을 깬다(D-SDA-3) | MEDIUM | 거절 코드와 사유를 `dmctl` 이 그대로 보인다. CHANGELOG 에 동작 변경으로 적는다 |
| R-4 | 변경 범위가 git 패널 전체·파일 트리·설정에 걸친다 | HIGH | 묶음별로 Spec → Test(RED) → Code, 묶음마다 커밋. 묶음 M 이 먼저다 |
| R-5 | 1층 답이 상태 갱신보다 늦으면 버튼이 잠깐 낡는다 | LOW | 실행 요청은 언제나 서버가 다시 판정한다(FR-SDA-3) |

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-11-05 | 승인(사용자). 설계로 정한 D-SDA-5~7 · FR-SDA-23 · FR-SDA-61 · R-3 도 함께 승인됐다 |
| 2026-11-05 | 초안. 전수 목록과 사용자 결정 4건(D-SDA-1~4)에서 썼다 |
