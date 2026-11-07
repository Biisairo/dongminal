# SRS: 서버가 답하는 동작 가능 여부 — server-driven actions — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 묶음 K(§3.8a)·N. 묶음 X(§3.7a)·F(§3.5a)·R(§3.6a)는 구현했다. 묶음 M(§3.1a)·GR(§3.2a)·GT(§3.3a)·GV(§3.4a)는 구현했다. 인계 문서 `docs/internal/SERVER_DRIVEN_HANDOFF.md`

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

#### 3.1a 묶음 M 설계 세부

장치를 검증하려고 동작 `git.stash.create` 하나를 화면부터 서버까지 끝까지 꿴다. stash 의 나머지 동작(탭의 "새로" 버튼(G-A5), 커밋 안 된 행의 Stash(G-A6))은 묶음 GR 에서 한다.

| ID | 설계 |
|---|---|
| M-1 사유 코드 | `why` 는 `apierr` 의 와이어 코드다. 실행 거절의 `error` 와 같은 값이어야 하므로 와이어 코드의 단일 소유자(`apierr/codes.go`)에 둔다. 새 코드도 그곳에 더하고, 오류 카탈로그 안내(`CodeDoc`)를 함께 적는다. 묶음 M 의 새 코드는 `untracked_only`(409) 하나다 |
| M-2 답 타입 | 새 패키지 `internal/webserver/action`. `Answer{OK, Why, Args}` 를 JSON `{"ok","why","args"}` 로 낸다. `ok` 가 참이면 `why`·`args` 를 싣지 않는다. 거절 상태(409·400)는 `Answer` 안에 두되 직렬화하지 않는다. 생성자는 `Allow()`·`Deny(status, why, args)` 둘이다 |
| M-3 동작 목록 | `action.Catalog`: 동작 ID → 그 판정이 낼 수 있는 사유 코드 목록. 판정 함수의 표 시험이 "낸 사유가 목록 안에 있다" 를 확인한다. 묶음 M 의 줄은 `git.stash.create → nothing_to_stash, untracked_only` 하나다 |
| M-4 판정과 거절 | 판정 함수는 HTTP 계층(`gitapi`)에 두고 도메인의 사실(`write.StashableCount`)만 읽는다. 답 종단과 실행 종단이 같은 함수를 부른다. 실행 종단은 답이 거짓이면 `X-Error-Code: <why>` 와 본문 `{"error": why, "args": …}`(+ 종단이 원래 싣던 맥락, stash 는 `status`)로 거절한다. 서버 문구(`message`)는 싣지 않는다(D-SDA-5) |
| M-5 2층 종단(git) | `GET /api/git/actions?repo=&action=<id>[&<입력>]` → `{"requested":{…}, "repo": <root>, "actions": {"<id>": 답}}`. 모르는 `action` 은 400 `bad_request`. 묶음 M 에서 받는 것은 `action=git.stash.create&includeUntracked=0\|1` 이다. 묶음 GT 는 같은 종단에 `kind=` 형태를 더한다 |
| M-6 문구 | 화면 카탈로그 키는 `why.<코드>` 다. `args` 는 `t()` 의 보간 값으로 그대로 넘긴다(`untracked_only` 는 `{count}`). 첫 응답 전의 사유 `why.loading` 도 같은 묶음이다. 키를 조립하므로 `check-i18n` 의 동적 접두 등록부에 `why.` 를 더한다 |
| M-7 게이트(FR-SDA-8) | `scripts/check-action-reasons.sh` → `go run ./scripts/check-action-reasons`. `action.Catalog` 의 모든 코드와 `loading` 에 대해 `web/js/i18n/ko.js`·`en.js` 에 `why.<코드>` 키가 있는지 본다. 판정 논리(`action.MissingPhrases`)는 Go 단위 시험으로 탐침한다. `make gates` 에 건다 |
| M-8 화면 장치 | `web/js/core/action-answer.js` 의 `actionState(answer, pending)` → `{enabled, why}`. 진행 중이면 `{false, ''}`, 답이 없으면 `{false, t('why.loading')}`, 거짓이면 `{false, t('why.'+why, args)}`, 참이면 `{true, ''}`. 컨트롤을 켜고 끄는 규칙은 이 함수 밖에 두지 않는다 |
| M-9 stash 만들기 대화상자 | 열 때와 `includeUntracked` 를 바꿀 때 M-5 로 묻는다. 묻는 동안의 사유는 `loading` 이다. 늦게 온 앞선 답은 세대로 버린다(브랜치 이름 검증과 같은 방식). 화면의 `_why` 계산과 `GIT_STASH_UNTRACKED_ONLY` 를 없앤다 |
| M-10 실행 거절 문구 | git 패널의 `writeReason` 은 `GIT_WRITE_ERR` 에 없는 코드를 `why.<코드>` 문구(있으면)로 보인다. 그래서 답을 거치지 않은 거절도 같은 문구로 읽힌다 |
| M-11 `dmctl`(FR-SDA-9) | 거절 본문의 `error` 가 사유 코드이므로 `dmctl run` 의 기존 오류 출력(`dmctl_run_http.go`)이 그대로 보인다. git 에는 `dmctl` 명령이 없다. TC-SDA-4 는 판정이 생기는 묶음 R 에서 잰다 |

### 3.2 묶음 GR — git 저장소 단위 동작 (1층)

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-20 | `GET /api/git/status` 응답에 `actions` 를 싣는다. 대상 동작: `git.fetch`·`git.pull`·`git.push`(▾ 변형 포함)·`git.commit`·`git.stash.create`·`git.stash.new`·`git.uncommitted.stash`·`git.uncommitted.clean`·`git.uncommitted.reset`·`git.lock.remove`·`git.worktree.create`·`git.submodule.update` 와, 칸을 쓰는 브랜치·태그 원격 동작. `git.worktree.remove` 는 worktree 목록의 행마다 싣는다(GR-1h). `git.init` 은 서버 판정이 없어 싣지 않는다(GR-1i) | G-A1~A8 | 필수 |
| FR-SDA-21 | 칸 판정은 `jobs.SlotsOf` 와 실제 칸 상태 하나에서 나온다. 화면의 `gitJobSlotsOf`·`GIT_JOB_COMMON_KEYS`·`GIT_JOB_INDEX_EXEMPT`·`blocks` 는 없앤다 | G-A1·A2 | 필수 |
| FR-SDA-22 | 작업이 시작·끝나면(`git_jobs_changed`) 화면은 그 저장소의 `actions` 를 다시 받는다 | G-A1 | 필수 |
| FR-SDA-23 | 커밋 동작의 답은 빈 메시지·스테이지 없음·amend 메시지 불변·preflight 막힘을 모두 포함한다. 메시지는 입력 중에 바뀌므로 커밋 답은 `GET /api/git/actions?repo=&action=git.commit&message=&amend=&all=` 로 묻는다(입력 멈춤 뒤, 2층과 같은 종단) | G-A3 | 필수 |
| FR-SDA-24 | stash 만들기 답은 `includeUntracked` 를 받아 판정한다. 사유는 `nothing_to_stash`·`untracked_only` 코드다 | G-A4~A6 | 필수 |
| FR-SDA-25 | Reset 은 커밋이 없는 저장소에서 `no_head` 로 꺼진다 | G-A8 | 필수 |

#### 3.2a 묶음 GR 설계 세부

GR 은 판정의 재료가 셋으로 갈린다. 단계마다 커밋한다: **GR-1** 작업 칸 · **GR-2** 상태 사실(FR-SDA-24·25, G-A5~A8) · **GR-3** 커밋(FR-SDA-23).

| ID | 설계 |
|---|---|
| GR-1a 칸 판정 | `gitapi` 의 `slotsAnswer(x, keys, slots…)` 하나가 판정한다. 칸 중 하나라도 잡이 쥐면 409 `job_busy`. 거절도 이 함수를 부른다: 동기 쓰기의 `indexBusy`, 잡 시작(`launchJob`, 등록 직전 — 원자적 차지는 `Exclusion.claim` 이 그대로 진다), lock 지우기, worktree 만들기 |
| GR-1b 1층 동작 | `git.fetch`·`git.pull`·`git.push`·`git.branch.push`·`git.branch.fetch`·`git.branch.delete_remote`·`git.tag.push`·`git.tag.delete_remote` 는 `jobs.SlotsOf(<kind>)` 의 칸. `git.write`(index 칸을 쓰는 동기 쓰기·index 잡 시작 전반 — checkout·merge·stage·stash apply 등 메뉴 항목이 이것을 본다)·`git.commit` 은 index. `git.lock.remove` 는 index+common. `git.worktree.create`·`git.submodule.update` 는 common |
| GR-1c 싣는 자리 | `GET /api/git/status` 의 정상·`unchanged` 응답 둘 다 `actions` 를 싣는다. 잡 상태는 관측 식별자(`mark`) 밖이므로 `unchanged` 에서도 빠지면 안 된다. 칸 상태는 요청마다 읽는다(관측 캐시와 무관) |
| GR-1d 다시 받기(FR-SDA-22) | 화면은 잡을 붙이거나(`_attach`) 끝내거나(`_finish`) 잡 목록을 받을 때(`adoptJobs`) 그 저장소의 status 를 다시 받는다. `actions` 가 바뀌면 `mark` 가 같아도 머리 버튼·커밋 버튼·열린 탭을 다시 그린다 |
| GR-1e 화면에서 없애는 것 | `gitJobSlotsOf`·`GIT_JOB_COMMON_KEYS`·`GIT_JOB_INDEX_EXEMPT`·`GitJobs.blocks`(→ `panel.post` 는 미리 막지 않고 서버의 409 를 보인다)·`GitRemote.holds` 의 `_busyKey` 경로·`GitJobs.run` 의 사전 거절. 메뉴 항목의 `busy:` 는 동작 ID 를 받고 `GitMenu._why` 는 그 답을 읽는다. NFR-SDA-3 게이트가 없앤 이름을 지킨다 |
| GR-1f 진행 중(FR-SDA-7) | 시작 요청이 오가는 동안 꺼지는 것은 누른 그 버튼뿐이다. 다른 버튼은 서버의 다음 답을 따른다 |
| GR-1g 툴팁 | 원격 버튼의 툴팁은 영어다(FR-TIP-2). 1층 답이 낼 수 있는 사유는 `loading`·`job_busy` 둘이므로 각각 기존 영어 문구(`GIT_REMOTE_WHY_NO_STATUS`·`GIT_REMOTE_WHY_BUSY`)로 보인다 |
| GR-1h worktree 지우기 | 사용자 결정(2026-11-05): 대상마다 답이 다르므로 1층에 싣지 않고 `GET /api/git/worktrees` 의 **행마다** `actions.remove` 로 싣는다(FR-SDA-60 의 Run 과 같은 모양). 판정은 "worktree 잡이 common 칸을 쥠" 과 "대상 worktree 의 index 칸" 이고, 실행 거절도 같은 함수다. Worktrees 탭은 `git_jobs_changed` 에 목록을 다시 받는다 |
| GR-1i init | 서버에 판정이 없다(잠금 없음 · 저장소가 아닌 자리에서만 보인다). 그래서 답을 싣지 않고, 화면의 미리 막기(`blocks`)를 없애는 것으로 끝난다 |
| GR-1j 문구 | `why.job_busy` 를 더한다 |
| GR-2a 겹친 판정 | 상태 사실을 보는 동작은 index 칸(GR-1a)을 먼저 보고, 비었으면 상태 사실을 본다. 실행 종단의 순서(잠금 획득 → 실행 전 상태 판정)와 같다. `git.stash.create`(M)도 같은 순서로 바꾸고, 낼 수 있는 사유에 `job_busy` 를 더한다 |
| GR-2b `git.stash.new` | stash 탭의 "새로" 와 커밋 안 된 행의 Stash 는 같은 생성 대화상자를 연다(FR-GIT-277). 그래서 동작 ID 하나 `git.stash.new` 로 둔다(FR-SDA-20 의 `git.uncommitted.stash` 는 이것과 같다). 판정은 `stashCreateAnswer(status, includeUntracked=true)` — 옵션을 켜면 담길 것이 있는가이다. untracked 만 있어도 열리고, 그다음은 대화상자가 M-9 로 묻는다 |
| GR-2c reset·clean | `git.uncommitted.reset` 은 커밋이 없으면 409 `no_head`(FR-SDA-25), `git.uncommitted.clean` 은 untracked 가 없으면 409 `nothing_to_clean`. 판정 함수는 지금의 `gitResetBlocked`·`gitCleanBlocked` 를 답을 내는 함수로 바꾼 것이고, 실행 종단도 그 답으로 거절한다(`message` 없음) |
| GR-2d 싣는 자리 | 셋 다 1층(status 응답의 `actions`)이다. 같은 응답의 `status` 에서 판정하므로 따로 묻지 않는다 |
| GR-2e 화면에서 없애는 것 | `stash.js` 의 `_why` 계산, 메뉴 항목의 `dirtyCount()`·`untrackedPaths().length` 판정. 메뉴 항목은 `busy:` 에 이 동작 ID 를 둔다. Clean 의 확인 목록(`targets`)은 화면이 그대로 만든다 — 판정이 아니라 보여 줄 목록이다 |
| GR-2f 문구 | `why.no_head`·`why.nothing_to_clean` 을 더한다 |
| GR-3a 종단 | 커밋 답은 1층에서 빼고 `GET /api/git/actions?repo=&action=git.commit&message=&amend=0\|1&all=0\|1&signoff=0\|1` 로만 묻는다(FR-SDA-23). 입력이 답을 바꾸기 때문이다 |
| GR-3b 판정 순서 | 실행 종단과 같다: ① 메시지가 비면 400 `empty_message` ② index 칸(GR-1a) ③ preflight 가 막으면 409 `preflight_blocked`(`args.blocks` 에 막은 항목) ④ staged 가 없고 `all` 도 아니며, amend 가 아니거나 amend 인데 메시지가 직전과 같으면 400 `nothing_staged`. ①·③·④ 는 `commitMessageAnswer`·`commitStateAnswer` 두 함수이고, 실행 종단도 이 둘로 거절한다(`message` 없음). preflight 거절은 지금처럼 본문에 `preflight` 를 함께 싣는다 |
| GR-3c 묻는 때 | 커밋 칸은 입력이 멈춘 뒤(디바운스), 옵션·amend 를 바꿀 때, status 가 새로 그려질 때 묻는다. 늦게 온 앞선 답은 세대로 버린다 |
| GR-3d 다시 묻는 동안 | 첫 답 전에는 FR-SDA-6 대로 `loading` 이다. 그 뒤 다시 묻는 동안에는 버튼만 끄고, 사유 줄은 앞선 답의 것을 그대로 둔다 — 글자를 칠 때마다 사유 줄이 "확인하는 중" 으로 깜박이지 않게 한다 |
| GR-3e preflight 표시 | 답이 `preflight_blocked` 면 `args.blocks` 로 막은 항목을 누르기 **전에** 보인다(G-A3 의 "서버만 아는 것" 해소). 템플릿·서명·detached 경고를 얻는 기존 `/api/git/preflight` 조회는 그대로다 |
| GR-3f 화면에서 없애는 것 | `GitCommit._why` 의 메시지·staged 판정, `GIT_COMMIT_WHY_TEXT`. 툴팁(영어, FR-TIP-2)은 서버 사유 코드를 키로 하는 표로 고른다. 저장소가 없을 때(`no-repo`)는 물을 대상이 없으므로 화면이 그대로 둔다 |
| GR-3g 문구 | `why.empty_message`·`why.nothing_staged`·`why.preflight_blocked` 를 더한다 |

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

#### 3.3a 묶음 GT 설계 세부

두 단계로 커밋한다: **GT-1** 커밋 행 메뉴 · **GT-2** 브랜치 행 메뉴와 양쪽 삭제.

| ID | 설계 |
|---|---|
| GT-a 종단 | 같은 `GET /api/git/actions` 에 `kind=` 형태를 더한다(M-5). `kind=commit&oid=<oid>` 는 `git.commit.cherry_pick`·`git.commit.revert`·`git.commit.reset`·`git.commit.drop` 의 답을, `kind=branch&ref=<refs/heads/…\|refs/remotes/…>` 는 브랜치 메뉴 동작 전부의 답을 낸다. 모르는 `kind` 는 400 `bad_request`, 없는 ref 는 404 `not_found` |
| GT-b 새 사유 코드 | `operation_in_progress`(409, `args.kind`) · `target_is_head`(409) · `root_commit`(400) · `merge_commit`(400) · `not_local_branch`(400) · `not_remote_branch`(400) · `no_upstream`(409) · `no_tracking_branch`(409) · `many_tracking_branches`(409). 이미 있는 `branch_is_current`·`job_busy` 는 그대로 쓴다 |
| GT-c 커밋 판정(GT-1) | 넷 다 진행 중 작업 → index 칸 순으로 먼저 본다(`opAnswer`·`slotsAnswer`). cherry-pick·reset 은 대상이 HEAD 면 `target_is_head`. drop 은 부모가 0개면 `root_commit`, 2개 이상이면 `merge_commit`(지금의 `bad_request` 를 바꾼다). 실행 종단 넷이 같은 함수로 거절한다 |
| GT-d 브랜치 판정(GT-2) | 서버는 요청의 이름을 `query.Refs` 로 실제 ref 에 대 본다. checkout: 원격 ref 를 `detach` 없이 보내면 `not_local_branch`, 현재 브랜치면 `branch_is_current`(단 `force` 는 변경을 버리는 동작이라 막지 않는다). checkout-local(`track`): 원격 ref 가 아니면 `not_remote_branch`. rename·upstream·push: 로컬이 아니면 `not_local_branch`, upstream 해제는 upstream 이 없으면 `no_upstream`. merge·rebase: 진행 중 작업, 대상이 현재 브랜치면 `target_is_head`(단 rebase 에 `onto` 가 있으면 ref 는 "어디부터" 이므로 막지 않는다). delete(로컬): 현재 브랜치면 `branch_is_current`. fetch-into: 원격이 아니면 `not_remote_branch`. 칸: push·fetch-into·원격 삭제는 common, 나머지는 index |
| GT-e 양쪽 삭제(GT-2) | 사용자 결정(2026-11-06): 새 종단 `POST /api/git/branch/delete-both {repo, ref, confirm}`. 서버가 짝을 판정한다 — 로컬 ref 면 그 upstream(없으면 `no_upstream`), 원격 ref 면 그것을 추적하는 로컬(없으면 `no_tracking_branch`, 둘 이상이면 `many_tracking_branches`). 로컬이 현재 브랜치면 `branch_is_current`. 칸은 index+common. 로컬을 지운 뒤 원격 삭제 잡을 시작한다 — 로컬이 실패하면 원격을 건드리지 않는다(FR-BMU-14). 응답은 원격 삭제 잡이다. 파괴적 확인(`confirm:true`)을 요구한다. 로컬 삭제의 판정은 `branch/delete` 와 같은 함수다 — 미머지면 같은 409 `branch_not_merged`(선택지 `options`)로 답하고, 화면은 `-D` 를 고르면 `force:true` 로 다시 보낸다. 원격 이름(`origin/x`)은 서버가 원격 목록(`query.Remotes`)에 맞춰 가른다(가장 긴 원격 이름이 이긴다). 잠금 분류는 `lockTop` 이다 |
| GT-f 화면 | 커밋·브랜치 메뉴는 열 때 2층 답을 받은 **뒤에** 그린다(FR-SDA-5). 항목은 `act:` 에 동작 ID 를 두고 `GitMenu._why` 가 그 답을 읽는다. 항목의 `disabled` 판정(`gitOpBusy`·`whyHead`·`whyDrop`·ref 종류·`pairOf` 의 사유)은 없앤다. 답이 50ms 안에 오지 않으면 항목을 `loading` 으로 먼저 그리고 답이 오면 고친다(NFR-SDA-1) |
| GT-g 문구 | 새 사유 코드마다 `why.<code>` 를 더한다. `operation_in_progress` 는 `{kind}`(git 의 작업 이름: merge·rebase·cherry-pick·revert 등)를 그대로 보간한다 |

### 3.4 묶음 GV — git 입력 검증

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-40 | 대화상자의 입력 검증은 서버의 validate 종단으로 한다. 기존 `branch/validate`·`tag/validate` 와 같은 모양으로, upstream·worktree·원격 추가·stash 브랜치·비교·저장소 추가의 입력을 판정한다 | G-B1~B7·B9 | 필수 |
| FR-SDA-41 | upstream 은 알려진 원격 ref 여야 한다. 서버가 판정하고 거절한다 | G-B2 | 필수 |
| FR-SDA-42 | `origin/x` 를 로컬 이름·원격+브랜치로 가르는 일은 서버가 한다. 화면은 원격 ref 를 그대로 보낸다 | G-B8 | 필수 |
| FR-SDA-43 | 태그 종류·reset 모드처럼 이미 서버 응답에 있는 목록은 응답의 것을 쓴다(K7·K8) | K7·K8 | 필수 |

#### 3.4a 묶음 GV 설계 세부

네 단계로 커밋한다: **GV-1** 장치와 브랜치·태그 입력(G-B1·B2·B5) · **GV-2** worktree·원격 추가·비교·저장소 추가(G-B3·B4·B6·B7) · **GV-3** 원격 ref 가르기(G-B8) · **GV-4** 목록 상수(K7·K8). G-B9(같은 이름으로 rename)는 이미 서버가 판정한다 — 대화상자가 `branch/validate` 의 `exists` 로 막고, 실행은 `write/branch.go` 의 `checkNewBranchName` 이 거절한다. 바꾸지 않는다.

| ID | 설계 |
|---|---|
| GV-a 모양 | 입력 답은 M-5 의 `GET /api/git/actions?repo=&action=<id>&<입력>` 로 묻는다. FR-SDA-40 의 "validate 와 같은 모양" 은 **판정을 200 본문에 담아 요청 실패와 가른다** 로 읽는다. 답 종단은 그것을 지키면서 사유를 코드로 주고(D-SDA-5), 실행 거절과 같은 함수를 부르며(D-SDA-6), 화면은 `actionState` 하나로 그린다(M-8). `branch/validate`·`tag/validate` 는 이름 규칙과 `exists` 의 자리로 그대로 둔다 — 이름 규칙의 사유는 git 의 문장이다 |
| GV-b 판정 | 입력 판정은 도메인의 검사 함수 하나다. 답은 그 오류를 `apierr.Git` 표로 코드로 바꾼 것(`errAnswer`)이다. 실행 종단은 같은 함수의 답으로 거절한다(`rejectAnswer`, `message` 없음). 빈 값은 앞뒤 공백을 지운 뒤 판정한다 |
| GV-c 동작 표 | 아래 표. 사유는 적은 순서로 본다. 400 은 입력, 409 는 상태 때문이다 |
| GV-d 화면 장치 | `web/js/git/input-answer.js` 의 `GitInputAnswer`. 대화상자의 `validate` 가 부른다. 입력이 바뀌면 멈춘 뒤(`GIT_BR_VALIDATE_DEBOUNCE_MS`) 묻고, 늦게 온 앞선 답은 세대로 버린다. 첫 답 전에는 `loading`, 다시 묻는 동안에는 실행만 막고 앞선 사유를 그대로 둔다(GR-3d). 대화상자의 빈 값 판정·`GitBranchUpstream._check`·`_remotes` 는 없앤다 |
| GV-e 태그 대화상자 | 이름 사유(`tag/validate`)가 먼저이고, 없으면 `git.tag.create` 의 답이다. 메시지 판정(종류·메시지)은 `write.CheckTagMessage` 하나이며 `TagCreateArgs` 도 그것을 부른다 |
| GV-f upstream | `git.branch.upstream.set` 의 입력 답은 브랜치 판정(GT-d, `branchAnswer`) 뒤에 upstream 을 본다: 비면 `empty_ref`, 원격 ref 목록(`branchFacts` 의 `query.Refs`)에 없으면 `upstream_unknown`. 화면이 목록을 몰라 검사를 건너뛰던 자리(History 의 refs 사이드바)도 이제 판정된다 |
| GV-g 원격 ref 가르기(GV-3) | `branch/fetch`·`branch/delete-remote` 는 `ref`(원격 ref 의 전체 이름 `refs/remotes/<원격>/<브랜치>`)를 받고, 서버가 `query.Remotes` 에 맞춰 가른다(`splitRemoteRef`, 가장 긴 원격 이름이 이긴다). 가를 수 없으면 400 `not_remote_branch`. `remote`+`branch` 도 계속 받는다 — `ref` 가 있으면 `ref` 가 이긴다(R-3). checkout 에 `track` 만 있고 `create` 가 비면 서버가 가른 브랜치 이름으로 만든다. `GET /api/git/refs` 의 원격 ref 는 `remote`(원격 이름)를 싣는다 — 복구 명령은 그것으로 만든다. 화면의 `GitBranches._split` 과 `checkoutRemote` 의 가르기는 없앤다. 브랜치 트리의 접두 묶음(`branches-tree.js`)·태그 확인 문구의 원격 이름(`GitTag.remoteOf`)은 보여 주기이며 요청에 싣지 않으므로 그대로 둔다 |
| GV-h 목록 상수(GV-4) | `GET /api/git/policy` 에 `tagKinds`(`write.TagKinds`)·`resetModes`(`write.ResetModes`)를 싣는다. 태그·reset 대화상자는 그 목록으로 선택지를 만든다(라벨은 값으로 i18n 에서 고르고, 모르는 값은 값 그대로 보인다). `GIT_TAG_KIND_OPTS`·`GIT_CO_RESET_MODES` 를 없앤다. policy 는 이미 한 번 받아 둔다(`GitConfirm.policy`) |
| GV-i 문구 | 새 사유 코드마다 `why.<code>` 를 ko·en 에 더한다(게이트 M-7) |
| GV-j 게이트 | 없앤 화면 이름을 단계마다 `check-server-driven.sh` 목록에 더한다: GV-1 `GIT_TAG_WHY_NEED_MSG`·`GIT_BR_UPSTREAM_WHY_UNKNOWN`·`GIT_STASH_BRANCH_NEED_NAME`, GV-3 `_split`, GV-4 `GIT_TAG_KIND_OPTS`·`GIT_CO_RESET_MODES` |

GV-c 동작 표:

| 동작 ID | 입력 | 사유(순서) | 실행 종단 |
|---|---|---|---|
| `git.tag.create` | `tagKind`·`message` (`kind` 는 GT-a 의 대상 종류라 피한다) | `tag_kind_invalid`(400) → `tag_message_required`(400) | `POST /api/git/tag` |
| `git.branch.upstream.set` | `branch`·`upstream` | GT-d 의 브랜치 판정 → `empty_ref`(400) → `upstream_unknown`(400) | `POST /api/git/branch/upstream` |
| `git.stash.branch` | `name` | `empty_name`(400) → `ref_name_invalid`(400) → `branch_exists`(409, `args.branch`) | `POST /api/git/stash/branch` |
| `git.worktree.create` | `name`·`ref`·`newBranch=0\|1` | `empty_name` → `ref_name_invalid` → `empty_ref`(400) → `job_busy`(409, common 칸) → `worktree_exists`(409, `args.path`) → 새 브랜치면 `branch_exists`(409, `args.branch`) | `POST /api/git/worktrees/create` |
| `git.remote.add` | `name`·`url` | `empty_name` → `remote_name_invalid`(400) → `empty_url`(400) → `remote_url_invalid`(400) → `remote_exists`(409) | `POST /api/git/remote/add` |
| `git.compare` | `rev`·`path` | `empty_rev`(400) → `empty_path`(400) | 없음 — 실행은 화면이 diff 를 여는 것이다. `commit-range` 의 `from`·`to` 검사는 그대로 |
| `git.repo.add` | `path` (`repo` 를 받지 않는다) | `empty_path` → `path_must_be_absolute`(400, 기존 코드) → `not_a_git_repo`·`repo_missing` | `POST /api/git/repos/pin` |

새 사유 코드: `tag_kind_invalid`·`tag_message_required`·`upstream_unknown`·`empty_name`·`empty_ref`·`empty_url`·`empty_path`·`empty_rev`·`remote_name_invalid`·`remote_url_invalid`. 이 가운데 넷(`tag_kind_invalid`·`tag_message_required`·`remote_name_invalid`·`remote_url_invalid`)은 지금 `bad_request` 로 나가는 sentinel(`write.ErrTagKind`·`ErrTagMessage`·`ErrRemoteName`·`ErrRemoteURL`)의 코드를 가르는 것이다 — 동작 변경으로 적는다.

### 3.5 묶음 F — 파일 트리

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-50 | `POST /api/fs/actions {paths:[…]}` 는 선택한 항목들의 메뉴 답(이름 바꾸기·삭제·복사·옮기기)을 낸다. 삭제 답에는 항목 수를 싣는다. 수는 서버 상한까지 세고, 넘으면 `ok:false`·`too_many_entries`(args: 상한) | F-A2·A3 | 필수 |
| FR-SDA-51 | 루트·홈·파일 시스템 루트의 삭제·이름 바꾸기는 `fsDeletable` 하나로 판정한다(답과 거절이 같다) | F-A2 | 필수 |
| FR-SDA-52 | 자기 하위로 옮기기는 서버가 판정한다(심볼릭 링크를 푼 뒤). 끌어 놓을 때 화면은 판정하지 않고, 놓으면 서버의 답이 오류 줄로 보인다 | F-A1 | 필수 |
| FR-SDA-53 | 만들기·이름 바꾸기의 이름은 서버가 검증한다: 경로 구분자(`/`, Windows 의 `\`) 금지, 빈 이름·`.`·`..` 금지. 대화상자는 입력 중에 `POST /api/fs/validate-name` 으로 묻고, 실행 요청도 같은 함수로 거절된다 | F-B1 | 필수 |
| FR-SDA-54 | 창·탭·그룹 이름의 길이 상한(64)은 서버가 정하고 거절한다. 화면의 `clampEntityName` 은 서버 상한을 받아 쓴다 | F-B2 | 필수 |
| FR-SDA-55 | 편집기 루트 추가 경로는 서버가 판정한다(`wsentry` 의 오류 코드) | F-B3 | 필수 |

#### 3.5a 묶음 F 설계 세부

네 단계로 커밋한다: **F-1** 메뉴 답과 삭제 상한(F-A2·A3) · **F-2** 이름 검증과 자기 하위 이동(F-B1·F-A1) · **F-3** 편집기 루트 추가(F-B3) · **F-4** 창·탭·그룹 이름 길이(F-B2).

| ID | 설계 |
|---|---|
| F-a 종단(F-1) | `POST /api/fs/actions {root, paths:[…]}` → `{"actions": {"fs.rename","fs.move","fs.copy","fs.delete": 답}, "count": n}`. `paths[0]` 은 메뉴를 연 행이다. 이름 바꾸기·옮기기(잘라내기)·복사(복제 포함)는 그 행 하나를, 삭제는 `paths` 전부를 판정한다 — 지금 메뉴가 그렇게 동작한다. `paths` 가 비면 400 `bad_request`. 경로마다 루트 가드(`fsRootTarget`)를 지나며, 가드 실패는 답이 아니라 요청 실패다 |
| F-b 항목 수(FR-SDA-50) | FR-SDA-1 은 참인 답에 `args` 를 싣지 않는다. 그래서 수는 답 밖의 `count` 로 싣는다. `count` 는 대상 폴더들 **안의** 항목 수의 합이다(대상 자신은 세지 않는다 — 확인창의 "그 안의 N개 항목" 과 같은 뜻). 대상마다 서버 상한(`limits.fsDelete`)+1 에서 세기를 멈춘다. 그래서 큰 폴더에서도 비용에 끝이 있다 |
| F-c 판정 함수(F-1) | `httpapi` 에 둔다. `fsProtectAnswer(root, target)`(지금의 `fsDeletable` 을 답으로 바꾼 것) · `fsMoveAnswer` = 보호 → 있는지(`not_found`) · `fsCopyAnswer` = 있는지 · `fsDeleteAnswer(root, targets, max)` = 대상마다 보호 → 수(넘으면 `too_many_entries`). 실행 종단이 같은 함수로 거절한다: 삭제는 잠근 뒤 `fsDeleteAnswer`, 이름 바꾸기·이동은 `fsMoveAnswer`(출발지) |
| F-d 사유 코드 | 새 코드: `editor_root_protected`(400, 이 루트 자신이나 다른 Editor 루트) · `home_protected`(400) · `filesystem_root_protected`(400) · `too_many_entries`(400, `args.max`) · `into_self`(400, F-2) · `name_has_separator`(400, F-2) · `name_reserved`(400, F-2). 기존 `not_found`·`empty_name` 은 그대로 쓴다. 지금은 넷 다 `bad_request` 에 한국어 `message` 로 나간다 — 동작 변경으로 적는다 |
| F-e 거절의 모양 | 파일 표면의 오류 방언(`{code, message}`)을 지킨다. 답으로 거절할 때는 `{code: why, args}` 이고 `message` 는 싣지 않는다(D-SDA-5). 헤더 `X-Error-Code` 도 같다. 복사의 항목 수 초과도 같은 코드(`too_many_entries`)로 바꾼다 — 같은 사유다 |
| F-f 화면 메뉴(F-1) | 행 메뉴는 열 때 F-a 로 묻고 답을 받은 **뒤에** 그린다(FR-SDA-5). 대상은 `[메뉴를 연 행, …선택의 나머지]` 다. 항목은 `act:` 에 동작 ID 를 둔다: 이름 바꾸기 `fs.rename` · 잘라내기 `fs.move` · 복사·복제 `fs.copy` · 삭제 `fs.delete`. 늦으면 `loading` 으로 먼저 그리는 장치는 `GitMenu._openAsked` 에서 묻는 함수를 받는 `GitMenu.openAsked(items, kind, target, ev, ask)` 로 꺼내 git·파일 메뉴가 함께 쓴다. 붙여넣기의 "클립보드가 비었다" 는 화면의 상태라 그대로 둔다. 키보드(F2·Delete·복사)는 메뉴를 거치지 않으며, 막히면 서버의 거절이 오류 줄로 보인다 |
| F-g 삭제 확인창(F-1) | `doDelete` 는 확인창을 열기 전에 F-a 로 묻는다. 수는 `count` 를 쓴다. 답이 거짓이면 확인창은 사유 줄을 보이고 삭제 버튼을 끈다(TC-SDA-8). 묻기가 실패하면 확인창을 열지 않고 오류 줄을 보인다. 화면의 `edCountTree`·`EDITOR_DEL_COUNT_MAX`·"N개 이상"(`editor.del_count_more`)을 없앤다 — 서버는 상한까지 정확히 센다 |
| F-h 실행 거절 문구 | `edFs` 는 `EDITOR_FS_ERR_MSG` 에 없는 코드를 `why.<코드>` 문구(있으면)로 보인다(M-10 과 같다) |
| F-i 이름 판정(F-2) | `fsNameAnswer(name)`: 앞뒤 공백을 지운 뒤 비면 `empty_name`, `/` 나 이 OS 의 경로 구분자(Windows 의 `\`)가 있으면 `name_has_separator`, `.`·`..` 이면 `name_reserved`. 종단 `POST /api/fs/validate-name {name}` → `{"actions": {"fs.name": 답}}` |
| F-j 이름을 받는 실행(F-2) | 경로만 받으면 서버는 `a/b` 가 이름인지 경로인지 가를 수 없다. 그래서 만들기는 `{root, parent, name, dir}` 를, 이름 바꾸기는 `{root, from, name}` 을 받고 `fsNameAnswer` 로 거절한다. 기존 `path`·`to` 도 계속 받는다(경로를 뜻하는 호출, R-3). 화면의 인라인 입력은 새 모양으로 보낸다 |
| F-k 인라인 입력(F-2) | 입력이 멈추면(디바운스) F-i 로 묻고, 거짓이면 입력 아래 오류 줄에 사유를 보인다. Enter 는 마지막 답이 거짓이면 보내지 않는다. 답을 기다리는 중이면 보내고 서버가 판정한다. 인라인 입력은 `GitDialog` 가 아니어서 `GitInputAnswer` 를 쓰지 않는다 — 세대로 늦은 답을 버리는 작은 장치를 트리에 둔다. 화면의 `/` 판정과 `EDITOR_NAME_INVALID` 를 없앤다 |
| F-l 자기 하위 이동(F-2) | 화면의 `pathUnder` 거절과 `EDITOR_MOVE_INTO_SELF` 를 없앤다. 서버의 `fsCopyGuardSelf` 가 `into_self` 로 거절하고, 놓은 뒤 그 사유가 오류 줄에 보인다(D-SDA-7). 끄는 동안 화면은 판정하지 않는다. 대상이 출발지 아래면 낙관 반영만 하지 않는다 — 허용 판정이 아니라 되돌리기 어려운 그림을 미리 그리지 않는 것이다 |
| F-m 편집기 루트 추가(F-3) | 판정은 `wsentry.CheckEditorPath` 하나(`EditorAdd` 의 앞부분을 꺼낸 것)이고, 답과 `POST /api/editors/add` 의 거절이 그것을 부른다. 사유(순서): `empty_path` → `path_must_be_absolute` → `not_found` → `not_a_directory`(새, 400) → `filesystem_root_protected`. 앞뒤 공백을 지운 뒤 본다. 파일시스템 루트는 지금 `ErrNotDir` 로 함께 나가므로 `ErrFilesystemRoot` 로 가른다. 종단 `POST /api/editors/validate {path}` → `{"actions": {"editor.add": 답}}`. 대화상자는 `GitInputAnswer` 로 묻는다 — 묻는 함수 `ask(params, stale)` 를 주입받도록 넓힌다(없으면 지금의 git 종단). 화면의 빈 경로 판정(`EDITOR_ADD_NEED_PATH`)을 없앤다 |
| F-p 이름 길이(F-4) | 사용자 결정(2026-11-07): 서버는 **dmctl 길(`POST /api/commands`)에서만** 거절한다. 이름을 싣는 명령(`newWindow`·`newTab`·`openEditorTab`·`renameTab`·`renameWindow`·`newGroup`·`renameGroup`)의 `args.name` 이 상한을 넘으면 400 `name_too_long`(`args.max`) — 평문 방언이므로 코드는 헤더에, 본문은 영어 코드 서술이다. workspace 저장(`PUT /api/workspace`)은 막지 않는다 — 옛 데이터나 화면 결함의 긴 이름 하나가 저장 전체를 막으면 변경이 조용히 사라진다. 상한(64)은 서버 상수이고 단위는 UTF-16 코드 단위다(화면의 `slice` 와 같다). 화면은 새 `GET /api/meta` 의 `entityNameMax` 를 부팅 때 받아 `clampEntityName` 으로 자르고, 받기 전에는 자르지 않는다. `/api/meta` 는 묶음 K(FR-SDA-80)가 넓힌다 |
| F-n 게이트 | 없앤 화면 이름을 단계마다 `check-server-driven.sh` 목록에 더한다: F-1 `edCountTree`·`EDITOR_DEL_COUNT_MAX` · F-2 `EDITOR_NAME_INVALID`·`EDITOR_MOVE_INTO_SELF` · F-3 `EDITOR_ADD_NEED_PATH` |
| F-o 문구 | 새 사유 코드마다 `why.<code>` 를 ko·en 에 더한다(게이트 M-7) |

### 3.6 묶음 R — Run

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-60 | Run 목록·그래프 응답의 Run 마다 `actions`(닫기·지우기)를, 멤버마다 `actions`(떼기)를 싣는다 | F-A4·A5 | 필수 |
| FR-SDA-61 | 닫기(종료) 버튼은 답이 참일 때만 선다. 종료 버튼의 뜻은 "지금 멈춘다"(`force`)이고, 서버의 답이 그 뜻으로 판정한다 — 화면은 Run 의 상태로 스스로 판정하지 않는다(D-SDA-9) | F-A4 | 필수 |

#### 3.6a 묶음 R 설계 세부

한 단계로 커밋한다.

| ID | 설계 |
|---|---|
| R-a 동작 | Run 마다 `run.close`(종료)·`run.delete`(지우기), 멤버마다 `run.member.detach`(떼기) |
| R-b 싣는 자리 | `GET /api/runs`(목록·`?id=`)의 Run 과 멤버, `GET /api/runs/{id}/graph` 의 Run 과 멤버에 `actions` 를 싣는다(1층과 같은 모양). 멤버 생성 응답 등 다른 자리에는 싣지 않는다 |
| R-c 종료 판정 | 사용자 결정 D-SDA-9: 종료 버튼은 `force` 를 보낸다. 그래서 `run.close` 는 force 의 판정이다 — 열린 Run 이면 참, 아니면 `run_closed`. 판정은 도메인 `run.CheckClose(rec, force)` 하나이고 `Store.Close` 도 그것을 부른다. 이미 끝난 Run 에 force 를 보내는 정리 재진입(FR-WKT-8a, dmctl 의 `run close --force`)은 종료가 아니라 따로 받는다 — 답의 대상이 아니다 |
| R-d 미보고 수 | 확인 문구가 "보고하지 않은 멤버 N명" 을 말하도록 목록의 Run 에 `unreported`(수)를 싣는다. 참인 답은 `args` 를 싣지 않으므로(FR-SDA-1) 답 밖에 둔다(F-b 와 같다) |
| R-e 지우기 | 서버는 있는 Run 을 언제나 지운다. 그래서 `run.delete` 는 늘 참이고, 사유 목록은 비어 있다 |
| R-f 떼기 | `run.member.detach` 는 탭에 붙어 있지 않으면 `member_not_attached`. 실행 종단(`POST /api/runs/detach`)이 같은 함수로 거절한다 |
| R-g 화면 | Run 목록의 종료·삭제 버튼과 대시보드의 떼기 버튼은 답이 참일 때만 선다. `rv.state==='open'`·`m.tabId` 로 고르던 조건을 없앤다 |
| R-h dmctl(TC-SDA-4) | 거절 본문의 `error` 가 사유 코드이므로 `dmctl run` 의 기존 오류 출력이 그대로 보인다. 대표 둘: 종료 거절(`unreported_members`)·떼기 거절(`member_not_attached`) |

### 3.7 묶음 X — 그 밖

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-70 | 샌드박스 런타임 상태 응답에 `actions.start` 를 싣는다. missing 을 포함해 서버가 판정하고, 시작 요청도 같은 판정으로 거절한다 | F-A6 | 필수 |
| FR-SDA-71 | 터미널 드롭 업로드는 도구 상태의 `actions.upload` 로 판정한다(도구 출처·cwd). `/api/upload` 도 같은 판정으로 거절한다 | F-A8 | 필수 |
| FR-SDA-72 | 접근 제어 저장 전 잠김 경고는 `POST /api/access/check {value}` 의 답으로 한다. 판정은 서버의 `allowed`·`isSelf` 와 같은 함수다. 화면의 `_aclV4`·`_aclCidrHas`·`_aclCoversYou` 는 없앤다 | F-A9 | 필수 |
| FR-SDA-73 | "UTF-8 로 변환" 은 문서 응답의 `actions.convertUtf8` 로 판정한다. 저장 요청도 같은 판정으로 거절한다 | F-A10 | 필수 |

#### 3.7a 묶음 X 설계 세부

넷은 서로 독립이다. 단계마다 커밋한다: **X-1** 샌드박스 시작(F-A6) · **X-2** 터미널 드롭 업로드(F-A8) · **X-3** 접근 제어 잠김 경고(F-A9) · **X-4** UTF-8 변환(F-A10).

| ID | 설계 |
|---|---|
| X-a 새 사유 코드 | `runtime_missing`(409) · `runtime_start_manual`(409) · `upload_no_tool_cwd`(409) · `locks_you_out`(409, `args.you`) · `already_utf8`(409). 기존 `encoding_undecodable`(422)은 그대로 쓴다. 네 표면 모두 평문 방언이다 — 코드는 `X-Error-Code` 헤더에, 본문은 코드 그대로다(F-p 와 같다) |
| X-b 샌드박스 시작(X-1) | 동작 `sandbox.runtime.start`. `GET /api/sandbox/runtime` 응답에 `actions` 를 싣는다(1층). 판정 `sandboxStartAnswer(st)`: 바이너리가 없으면 `runtime_missing`, 서버가 시도할 수 없는 OS(linux·모르는 OS)면 `runtime_start_manual`, 그 밖은 참(지금 화면의 `!missing && startTryable` 과 같다). `POST /api/sandbox/runtime/start` 는 상태를 조회(`Probe`, 상한 3초)한 뒤 같은 함수로 거절한다. 응답의 `startTryable` 은 공개 계약이라 남기고, 화면은 읽지 않는다 — 시작 버튼·안내 문장·명령 보이기는 답이 정한다 |
| X-c 드롭 업로드(X-2) | 동작 `term.upload`. `GET /api/cwd?tool=` 응답에 `actions` 를 싣는다. 판정 `termUploadAnswer(cwd, source)`: cwd 가 도구의 것이 아니거나(`source≠tool`) 비면 `upload_no_tool_cwd`. 실행은 새 모양 `POST /api/upload?tool=<id>` — 서버가 그 순간의 도구 cwd 로 받고, 답이 거짓이면 거절한다. `tool` 이 있으면 `dir` 은 보지 않는다(R-3 의 "새 모양이 이긴다"). `dir` 모양은 그대로다 — 도구가 없는 호출(진단 오버레이의 `/tmp`·스크립트)이 쓰며, 판정할 도구가 없으므로 답의 대상이 아니다. 화면은 드롭 때 묻고, 거짓이면 사유를 토스트로 보이고, 참이면 `tool` 로 보낸다. 화면은 cwd 를 들지 않는다 |
| X-d 잠김 경고(X-3) | 동작 `access.save`. 종단 `POST /api/access/check` 의 본문은 `PUT /api/access` 와 같다 — FR-SDA-72 의 `{value}` 는 "저장하려는 값" 으로 읽는다. 경고는 목록 전체의 결과이기 때문이다. 응답 `{"actions":{"access.save": 답}, "you": <출발지>}`. 판정: `setConfig` 와 같은 정규화·검증(실패면 PUT 과 같은 400) → 같은 함수(`buildMatcher`)로 후보 판정기를 만든다 → `allowed(you)`(자기 주소·토글 꺼짐 포함). 거짓이면, 켜진 호스트명 중 해석 기록이 없는 것이 있을 때 참이다 — "모르면 경고하지 않는다" 는 지금 화면의 규칙을 지킨다. 그 밖은 `locks_you_out`(`args.you`). **이 답은 거절이 아니라 확인을 부르는 경고다**(FR-ACL-24) — 사용자는 "그래도 저장" 할 수 있어야 하므로 PUT 은 이 답으로 막지 않는다. 화면은 저장 전에 묻고, 거짓이면 확인창(`you` 는 응답의 것)을 연다. 묻기가 실패하면 저장으로 간다 — PUT 이 같은 400 을 보인다. `_aclV4`·`_aclCidrHas`·`_aclCoversYou` 를 없앤다 |
| X-e UTF-8 변환(X-4) | 사용자 결정 D-SDA-10. 동작 `file.convert_utf8`. 판정 `convertUTF8Answer(raw, from)`: 디스크 바이트를 `from` 으로 엄격 디코드(`textenc.DecodeAs`)하지 못하면 422 `encoding_undecodable`, 결과가 BOM 없는 UTF-8 이면 409 `already_utf8`. 답을 싣는 자리: 읽기(`GET /api/file?decode=1`) 응답 헤더 `X-File-Actions`(JSON `{"file.convert_utf8": 답}`, `from` 은 읽기가 고른 인코딩)와 저장(`POST /api/file/write`) 200 응답의 `actions`(방금 쓴 바이트와 요청의 인코딩) — 변환 뒤 메뉴가 낡지 않게 한다. 실행: 저장 요청의 새 필드 `convertFrom`(문서를 연 인코딩)이 있으면 표식 검사 뒤 디스크 바이트로 같은 함수를 불러 거절한다. 파일이 없거나 읽지 못하면 판정하지 않는다(일반 저장과 같다). `convertFrom` 이 없으면 일반 저장이며 바뀌지 않는다. 화면의 인코딩 메뉴와 `edDocConvertUtf8` 은 답을 읽고 `convertFrom` 을 싣는다. `ENC_CONVERT_NO_DECODE`·`ENC_CONVERT_ALREADY` 를 없앤다 |
| X-f 게이트 | 없앤 화면 이름을 단계마다 `check-server-driven.sh` 목록에 더한다: X-1 `startTryable` · X-3 `_aclV4`·`_aclCidrHas`·`_aclCoversYou` · X-4 `ENC_CONVERT_NO_DECODE`·`ENC_CONVERT_ALREADY` |
| X-g 문구 | 새 사유 코드마다 `why.<code>` 를 ko·en 에 더한다(게이트 M-7) |

### 3.8 묶음 K — 공유 상수

| ID | 요구 | 출처 | 우선 |
|---|---|---|---|
| FR-SDA-80 | 보낼 수 있는 상수(상한·이름·목록)는 서버가 보낸다. git 쪽은 `/api/git/policy` 에, 그 밖은 새 `GET /api/meta` 에 싣는다. 화면은 부팅 때 한 번 받아 쓴다 | K3·K5·K7·K8·K11·K18·K20 | 필수 |
| FR-SDA-81 | 보낼 수 없는 상수(정규식·해시 알고리즘·연결이 끊긴 순간에 쓰는 코드·부팅 전에 필요한 값)는 두 벌로 두고 **게이트가 대조한다**: K6·K9·K10·K12·K13·K16·K17 | 같은 줄 | 필수 |
| FR-SDA-82 | `claudeFullscreen` 의 기본값은 서버도 설정 스키마에서 읽는다(박아 둔 `true` 를 없앤다) | K19 | 필수 |
| FR-SDA-83 | 서버가 이미 보내는 값(`short` 등)이 있으면 화면은 그것을 쓰고, 자기 계산을 없앤다 | K14 | 필수 |
| FR-SDA-84 | 화면이 값마다 다른 코드로 갈라지는 식별자(K1·K2·K4·K15)는 서버가 **그 값의 뜻**(할 일·사실)을 함께 보낸다. 화면은 식별자 글자와 견주지 않고 받은 뜻대로 그린다. 문구는 식별자를 i18n 키로 골라 쓰고, 문구가 없으면 식별자를 그대로 보인다 | K1·K2·K4·K15 | 필수 |

#### 3.8a 묶음 K 설계 세부

네 단계로 커밋한다: **K-1** 숫자·목록 보내기(K3·K5·K11·K18·K20) · **K-2** 식별자의 뜻 보내기(K1·K2·K4·K15, FR-SDA-84) · **K-3** 보낼 수 없는 것의 대조 게이트(K6·K9·K10·K12·K13·K16·K17) · **K-4** K19·K14. K7·K8 은 GV-4 에서 끝났다.

| ID | 설계 |
|---|---|
| K-a 잡 줄 상한(K3) | `/api/git/policy` 에 `jobLineCap`(`jobs.JobLineCap`). 화면의 `GIT_JOB_LINE_CAP` 을 없앤다. 받기 전에는 줄을 자르지 않는다 — 서버가 상한 넘게 보내지 않는다 |
| K-b History 페이지(K5) | `/api/git/policy` 에 `logLimits:{initial,page,max}`(`query.Log*Limit`). 목록을 받기 전에 정책을 기다린다(`GitConfirm.policy()` 는 한 번만 받는다). 정책을 받지 못하면 `limit` 을 싣지 않는다 — 서버가 `initial` 로 접는다. `GIT_LOG_INITIAL`·`GIT_LOG_PAGE`·`GIT_LOG_MAX` 를 없앤다 |
| K-c 파일 상한(K11) | `GET /api/meta` 에 `fsStampMax`·`fileStampsMax`·`fsWatchDirsMax`. 화면은 `applyServerMeta` 로 받는다. 받기 전에는 자르지 않는다(F-p 와 같다) — 넘으면 서버의 400 이 보인다. `FS_STAMP_MAX`·`FILE_STAMPS_MAX`·`FS_WATCH_DIRS_MAX` 를 없앤다 |
| K-d 다시 열기 인코딩(K18) | 서버 `textenc.ReopenChoices`(지금 화면과 같은 넷)를 `GET /api/meta` 의 `encodings` 로 싣는다. 받기 전에는 메뉴에 다시 열기 항목이 없다. `ENC_REOPEN_CHOICES` 를 없앤다. `ENC_LABEL` 은 표기이므로 남기고, 모르는 id 는 id 그대로 보인다 |
| K-e 편집기 루트 순서(K20) | 고정 루트의 순서를 서버 함수 하나(`wsentry` 의 고정 루트 목록)가 정하고 `Roots()` 와 `GET /api/editors` 의 새 `fixed`(순서 있는 배열)가 그것을 쓴다. 화면의 `edRoots` 는 `[...fixed, ...list]` 다. `fixed` 가 없으면(옛 서버) 지금의 계산이 아니라 `[home]` 만 쓴다 |
| K-f 후속 선택지(K4) | 잡 JSON 에 `fixes:[{id, kind, body, confirm}]` 를 더한다 — `kind`·`body` 는 시작할 잡, `confirm` 은 거쳐야 할 파괴적 확인(`/api/git/policy` 의 키, 강제 push 만 `force_push`). `options` 는 공개 계약이라 남긴다. 화면은 `confirm` 이 있으면 그 확인 흐름으로, 없으면 `kind`·`body` 로 잡을 시작한다. 라벨은 `git.job_fix_label.<id>`. `GIT_JOB_FIX_REBASE`·`_MERGE`·`_LEASE` 를 없앤다 |
| K-g 잡 칸(K1) | `/api/git/policy` 에 `jobSlots:[{slot, remote}]`(칸의 순서와, 원격 동작을 쥐는 칸인가). 화면은 정책을 받은 뒤 그 순서로 표시 상자를 만들고, `remote` 칸에 머리 버튼을 붙이며, 취소 문구는 잡의 칸 중 `remote` 칸이 있는가로 고른다. 잡의 칸이 없으면 첫 칸이다. `GIT_JOB_SLOT_INDEX`·`GIT_JOB_SLOT_COMMON` 을 없앤다 |
| K-h 잡 종류(K2) | 잡 JSON 에 `indicator`(bool, 잡 표시기에 서는 잡인가 — `jobKinds` 의 종류면 참, submodule·worktree 는 그쪽 탭이 맡으므로 거짓, D-A-27). 화면의 `_isMine` 은 이것을 본다. 라벨은 `git.job_kind.<kind>`, 없으면 kind 그대로다. `GIT_REMOTE_LABEL` 을 없앤다. 버튼의 종류 확인은 화면의 버튼 목록(`GIT_REMOTE_KINDS`)으로 한다 |
| K-i 샌드박스(K15) | `GET /api/sandbox/runtime` 에 `ready`(bool, 데몬에 닿았다). 안내 문구·제목은 `state` 를 키로 고른다(`core.sbx_rt_msg.<state>`·`core.sbx_rt_title.<state>`). `/api/sandbox/profiles` 의 프로파일마다 `workPicks`(고를 수 있는 작업 방식, 없으면 빈 배열 — 폴더 입력을 받지 않는다)를, 목록에 `onlyDefault`(기본 프로파일 하나뿐인가)를 싣는다. 작업 방식의 라벨은 이미 `core.sandbox_work_label.<kind>` 다. `SBX_RT_OK`·`SBX_RT_STOPPED`·`SBX_RT_MISSING`·`SANDBOX_WORK_*`·`SANDBOX_PROFILE_SCRATCH` 를 없앤다. 모양의 세부(`app-layout` 의 작업 방식 거르기 등)는 K-2 에서 코드에 대 보고 이 표에 덧붙인다 |
| K-j 대조 게이트(K-3) | `scripts/check-shared-constants` (Go 프로그램, `make gates`). 대조 쌍: K9 `GIT_OP_BY_BLOCK` 의 키 = `query.Block*InProgress` · K10 `GIT_OP_*` = `query.Op*` · K12 `LSP_WS_CLOSE_*` = `lspWSClose*` · K13 `WS_SCHEMA_VERSION` = `workspace.SchemaVersion` · K17 `SSE_SILENCE_MS` = 3 × `sseHelloEvery`. 화면 값은 JS 소스의 상수 줄에서 읽는다. 판정 논리는 Go 단위 시험으로 탐침한다(한쪽을 바꾸면 실패). K6(해시)·K16(정규식)은 값이 아니라 계산이므로 **공유 표본**(`testdata` 의 입력·기대값 JSON)을 Go 시험과 JS 단위 시험이 함께 읽는다 |
| K-k `claudeFullscreen`(K19) | `agentRenderEnv` 의 기본 `true` 를 `scrollSpeedSpec` 처럼 `settingsschema` 의 `def` 에서 읽는다. 표를 읽지 못하면 켬(FR-ARE-3) |
| K-l Run 짧은 id(K14) | `/api/tools/background` 의 멤버에 `runShort` 를 더한다(`run.Short`). 화면의 `runShortId`·`RUN_SHORT_ID_LEN` 을 없애고 서버의 `short`·`runShort` 를 쓴다. 이름 짓기(`Run <short>`)에 short 가 없으면 `Run` 만 쓴다 — 확인할 자리는 K-4 에서 코드에 대 본다 |
| K-m 게이트(NFR-SDA-3) | 없앤 화면 이름을 단계마다 `check-server-driven.sh` 목록에 더한다 |

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
| D-SDA-9 | Run 패널의 종료 버튼은 "지금 멈춘다"(`force`) 뜻을 유지하고, 서버가 그 뜻으로 판정한 답을 따른다(R-c) | 사용자 결정 2026-11-07. force 를 빼면 일하는 중인 Run 을 기록을 남기고 멈출 길이 화면에서 사라진다(FUI-04) |
| D-SDA-8 | 창·탭·그룹 이름의 길이 상한은 dmctl 길(`/api/commands`)에서만 거절하고, workspace 저장은 막지 않는다(F-p) | 사용자 결정 2026-11-07. 저장 전체를 거절하면 긴 이름 하나로 그 뒤의 모든 변경이 저장되지 않는다 |
| D-SDA-11 | 화면이 값마다 갈라지는 식별자(K1·K2·K4·K15)는 두 벌을 게이트로 묶지 않고, 서버가 그 값의 뜻을 함께 보낸다(FR-SDA-84) | 사용자 결정 2026-11-07. 이름만 보내면 화면에 "이 이름이면 이것을 한다" 는 두 벌이 남는다. 뜻을 보내면 화면은 글자를 견주지 않는다 |
| D-SDA-10 | UTF-8 변환은 저장 요청의 `convertFrom`(문서를 연 인코딩)으로 일반 저장과 가르고, 서버가 디스크 바이트를 그 인코딩으로 판정해 거절한다(X-e) | 사용자 결정 2026-11-07. 변환과 일반 저장의 요청이 같으면 서버는 그것이 변환인지도, 문서가 어느 인코딩으로 열렸는지도 모른다 — FR-SDA-73 의 "같은 판정으로 거절" 을 지킬 재료가 없다 |

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
| 2026-11-07 | K-1 구현. 동작 변경 넷. ① **이전**: 화면이 잡 줄 상한(2000)·History 페이지(300/100/2000)·파일 요청 상한(512/512/1024)·다시 열기 인코딩 넷을 따로 들고 있었다 / **새**: `/api/git/policy` 의 `jobLineCap`·`logLimits`, `/api/meta` 의 `fsStampMax`·`fileStampsMax`·`fsWatchDirsMax`·`encodings` 를 쓴다. 받기 전에는 자르지 않고, History 는 `limit` 을 싣지 않으며(서버가 첫 장으로 접는다), 다시 열기 항목이 없다 / **이유**: FR-SDA-80. ② **이전**: History 의 첫 요청은 정책을 기다리지 않았다 / **새**: 정책(세션에 한 번)을 받은 뒤 보낸다 / **이유**: 페이지 크기가 정책에 있다. ③ **이전**: 편집기 루트 순서 `[home, notes, plugins, ...list]` 를 화면이 따로 지었다 / **새**: `GET /api/editors` 의 `fixed`(서버 `wsentry.FixedRoots`, `Roots()` 와 같은 함수) 뒤에 list 를 잇는다. 드는지는 화면이 지금 아는 home·notes·plugins 가 정한다(메모 루트를 잃으면 그 자리만 빠진다, FR-NOT-11) / **이유**: K-e. ④ **이전**: `_edApplyServer` 가 서버의 `plugins` 를 버려 탐색기의 플러그인 행(FR-EXT-9b)이 한 번도 서지 않았다 / **새**: 저장하고, 행과 창이 선다 / **이유**: K-e 를 하다 찾은 결함(사용자 결정 2026-11-07: 함께 고친다). e2e `notes-live-explorer` 의 고정 행 수를 셋으로 고쳤다 |
| 2026-11-07 | 묶음 K 설계 세부(§3.8a). 사용자 결정 D-SDA-11 — FR-SDA-84 를 더하고 FR-SDA-80 에서 K1·K2·K4·K15 를 뺐다(이전: 서버가 값을 보낸다). 조사 정정: K2 의 "submodule·worktree 라벨 없음" 은 어긋남이 아니라 일부러 뺀 것이다(D-A-27, 그 잡은 그쪽 탭이 맡는다) |
| 2026-11-07 | X-4 구현 — 묶음 X 끝. 사용자 결정 D-SDA-10. 동작 변경 셋. ① **이전**: "UTF-8 로 변환" 은 화면이 `decodable`·`encoding`·`bom` 으로 판정했고, 저장 요청은 일반 저장과 같아 서버가 판정할 수 없었다 / **새**: 읽기 헤더 `X-File-Actions`·저장 응답 `actions` 의 `file.convert_utf8` 답이 메뉴를 정하고, 저장의 `convertFrom` 이 있으면 서버가 디스크 바이트로 같은 함수(`convertUTF8Answer`)를 불러 422 `encoding_undecodable`·409 `already_utf8` 로 거절한다 / **이유**: FR-SDA-73·D-SDA-10. ② **이전**: 화면의 저장은 모든 409 를 디스크 경합으로 읽어 덮어쓰기 확인창을 열었다 / **새**: `X-Error-Code: file_changed_on_disk` 일 때만 경합이다 / **이유**: 새 409 `already_utf8` 은 경합이 아니다. ③ 문구 `editor.enc_convert_already`·`editor.enc_convert_no_decode` 를 `why.already_utf8`·`why.encoding_undecodable` 로 옮겼다(뒤의 것은 코드 단위 문구라 일반 문장으로 바꿨다) |
| 2026-11-07 | X-3 구현. 동작 변경 둘. ① **이전**: 저장 전 잠김 경고를 화면이 IPv4 만으로 판정했다(`_aclCoversYou`). IPv6 대역은 "모른다" 로 통과시켰고, 자기 주소(loopback·이 기계의 인터페이스)를 몰라 이 기계에서 접속해도 경고했다 / **새**: `POST /api/access/check` 의 답(`access.save`)으로 경고한다. 판정은 게이트와 같은 판정기(`buildMatcher`·`allowed`)이고, 검증은 저장과 같은 함수(`normalizeAccessConfig`)다 / **이유**: §2.1·FR-SDA-72·TC-SDA-9. ② **이전**: 확인창의 주소는 패널을 열 때 받은 값이었다 / **새**: 묻기 응답의 `you` / **이유**: 판정과 같은 요청의 출발지다. 설계 중 정한 것: 해석 기록이 없는 새 호스트명은 경고하지 않는다(종전 규칙 유지). 해석에 실패한 이름은 품지 않는다. e2e 는 loopback 으로 붙으므로 확인창 시험은 답을 위조하고, 실제 서버로는 "loopback 은 확인 없이 저장된다" 를 잰다 |
| 2026-11-07 | X-2 구현. 동작 변경 둘. ① **이전**: 터미널 드롭은 화면이 `/api/cwd` 의 `source==='tool'` 로 판정하고 받은 cwd 를 `dir` 로 보냈다. `/api/upload` 는 아무 `dir` 이나 받았다 / **새**: `/api/cwd` 가 `actions["term.upload"]` 를 싣고, 화면은 그 답이 참이면 `/api/upload?tool=<id>` 로 보낸다. 서버는 그 순간의 도구 cwd 로 받고, 모르면 409 `upload_no_tool_cwd` 로 거절한다(`termUploadAnswer` 하나). `dir` 모양은 그대로다 / **이유**: FR-SDA-71·D-SDA-6. ② **이전**: cwd 조회와 업로드 사이에 셸이 폴더를 옮기면 옛 폴더에 놓였다 / **새**: 서버가 업로드하는 순간의 cwd 를 쓴다 / **이유**: 화면이 cwd 를 들지 않는다(X-c). 설계 중 정한 것: 거절 토스트는 기존 문구(`core.term_upload_no_cwd`)를 쓴다 — 사유가 하나이고 뜻이 같다. e2e 는 셸의 cwd 를 정할 수 없어, 업로드가 `tool` 모양인지 확인한 뒤 `dir` 로 바꿔 보낸다 |
| 2026-11-07 | X-1 구현(설계 §3.7a). 사용자 결정 D-SDA-10(X-4 의 모양)을 함께 적었다. 동작 변경 둘. ① **이전**: `POST /api/sandbox/runtime/start` 는 상태를 보지 않았다 — linux 에서는 200 `{started:false, command}`, 미설치에서는 명령을 실행해 보고 실패를 200 으로 답했다 / **새**: 상태를 조회한 뒤 `sandboxStartAnswer` 로 판정해 409 `runtime_missing`·`runtime_start_manual` 로 거절하고, 아무것도 실행하지 않는다 / **이유**: FR-SDA-70·D-SDA-6. ② **이전**: 화면이 `!missing && startTryable` 로 시작 버튼을 골랐다 / **새**: `GET /api/sandbox/runtime` 의 `actions["sandbox.runtime.start"]` 가 버튼·안내 문장·명령 보이기를 정한다. 응답의 `startTryable` 은 공개 계약이라 남긴다 / **이유**: D-SDA-1 |
| 2026-11-07 | 묶음 R 구현(설계 §3.6a). 사용자 결정 D-SDA-9 — FR-SDA-61 의 문구를 "종료 버튼은 force 뜻을 유지하고 서버가 그 뜻으로 판정한 답을 따른다" 로 고쳤다(이전 문구: "화면이 늘 force:true 를 보내던 것을 멈춘다"). 동작 변경 둘. ① **이전**: Run 패널은 `state==='open'` 으로 종료 버튼을, 대시보드는 `tabId` 로 분리 버튼을 스스로 골랐다 / **새**: 목록·그래프의 `actions` 답이 참일 때만 버튼이 선다. 종료 판정은 도메인 `run.CheckClose` 하나이고 `Store.Close` 도 부른다. 분리 거절도 같은 함수(`memberDetachAnswer`)다 / **이유**: FR-SDA-60·D-SDA-6. ② **이전**: 종료 확인 문구는 미보고 멤버를 말하지 않았다 / **새**: 목록의 `unreported` 로 그 수를 밝힌다 / **이유**: 종료가 그들을 기다리지 않는다는 사실을 누르기 전에 알린다(R-d). 설계 중 정한 것: Run 표면의 사유 코드는 sentinel 문자열의 참조(`apierr.CodeRunClosed` 등)로 두고, 카탈로그 시험은 `apierr.Runs` 표의 코드도 와이어 코드로 본다. TC-SDA-4 의 대표 둘(종료 거절·분리 거절)은 기존 출력 경로를 고정하는 시험이라 RED 가 없다 |
| 2026-11-07 | F-4 구현 — 묶음 F 끝. 사용자 결정 D-SDA-8. 동작 변경 둘. ① **이전**: dmctl 명령의 이름은 서버가 보지 않았고, 받은 브라우저가 64자로 잘랐다 / **새**: `/api/commands` 의 이름을 싣는 명령은 상한을 넘으면 400 `name_too_long`(헤더 코드, 본문 `name_too_long: max 64`) / **이유**: FR-SDA-54·D-SDA-3. ② **이전**: 화면이 상한 64 를 상수로 들고 있었다 / **새**: `GET /api/meta` 의 `entityNameMax` 로 자르고, 받기 전에는 자르지 않는다 / **이유**: FR-SDA-54·D-SDA-4 |
| 2026-11-07 | F-3 구현. 동작 변경 둘. ① **이전**: 편집기 루트 추가(`/api/editors/add`)의 상대 경로·파일·파일시스템 루트는 모두 400 `bad_request`(한국어 `message`) / **새**: `empty_path`·`path_must_be_absolute`·`not_a_directory`·`filesystem_root_protected`, `message` 없음. 없는 경로는 404 `not_found` 그대로. 판정은 `wsentry.CheckEditorPath` 하나이고 앞뒤 공백을 지운 뒤 본다 / **이유**: FR-SDA-55·FR-SDA-2·D-SDA-5. ② **이전**: `+ Add` 대화상자는 빈 경로만 스스로 막았다 / **새**: `POST /api/editors/validate` 로 입력 중에 묻고 실행 전에 막는다. `GitInputAnswer` 는 묻는 함수 `ask` 를 주입받는다 / **이유**: D-SDA-1. 설계 중 정한 것: `why.not_found` 문구를 탐색기 전용("이미 옮겨졌거나 지워졌습니다")에서 일반 문구("찾을 수 없습니다")로 바꿨다 — 입력한 경로에도 쓰이기 때문이다 |
| 2026-11-07 | F-2 구현. 동작 변경 셋. ① **이전**: 만들기·이름 바꾸기는 경로만 받아, 화면을 거치지 않은 `a/b` 를 폴더 `a` 안의 파일로 만들었다. 화면은 `/` 만 막았다 / **새**: `parent`+`name`(만들기)·`from`+`name`(이름 바꾸기)을 받고 `fsNameAnswer` 로 거절한다(`empty_name`·`name_has_separator`·`name_reserved`). 경로 모양(`path`·`to`)도 받는다 / **이유**: FR-SDA-53·D-SDA-3. ② **이전**: 자기 하위로 옮기기·복사의 거절은 400 `bad_request`(한국어 `message`) / **새**: 400 `into_self`, `message` 없음. 판정 함수는 `fsIntoSelfAnswer` 하나다 / **이유**: FR-SDA-2·D-SDA-5. ③ **이전**: 화면이 끌어 놓기·일괄 이동의 자기 하위를 `pathUnder` 로 먼저 막았다 / **새**: 요청을 보내고 서버의 사유를 오류 줄에 보인다. 대상이 출발지 아래면 낙관 반영만 하지 않는다 / **이유**: FR-SDA-52·D-SDA-7. 설계 중 정한 것: `empty_name` 의 fs 표면 상태는 400 이다(`apierr.FSStatus`) |
| 2026-11-07 | F-1 구현(설계 §3.5a). 동작 변경 넷. ① **이전**: 이름 바꾸기·이동(`/api/fs/rename`)은 루트 보호를 보지 않았다 — 다른 Editor 루트나 홈을 옮길 수 있었다 / **새**: 삭제와 같은 보호로 거절한다(`fsMoveAnswer`) / **이유**: FR-SDA-51. ② **이전**: 루트·홈·파일시스템 루트 삭제 거절과 항목 수 초과는 400 `bad_request` 에 한국어 `message` / **새**: `editor_root_protected`·`home_protected`·`filesystem_root_protected`·`too_many_entries`(`args.max`), `message` 없음. 복사의 항목 수 초과도 같다 / **이유**: FR-SDA-2·D-SDA-5. ③ **이전**: 삭제 확인창의 수는 화면이 `list` 를 걸어 2000 까지 셌고("N개 이상"), 서버의 상한(10000)과 어긋났다 / **새**: `POST /api/fs/actions` 의 `count`(서버가 상한까지 정확히 센다). 답이 거짓이면 확인창이 사유를 보이고 삭제 버튼을 끈다 / **이유**: §2.1·FR-SDA-50. ④ **이전**: 탐색기 행 메뉴는 묻지 않고 그렸다 / **새**: 열 때 서버에 묻고, 이름 바꾸기·잘라내기·복사·복제·삭제가 답을 따른다. 묻는 장치는 `GitMenu.openAsked` 로 꺼내 git 메뉴와 함께 쓴다 / **이유**: FR-SDA-5. 설계 중 정한 것: 참인 답은 `args` 를 싣지 않으므로(FR-SDA-1) 항목 수는 답 밖의 `count` 에 싣는다. 새 코드의 상태는 `apierr.FSStatus` 표가 정한다(답과 거절이 한 표). 읽기 실패(`not_found`·`permission_denied`·`io_failed`)도 답의 사유다 |
| 2026-11-06 | GV-4 구현 — 묶음 GV 끝. **이전**: 태그 종류·reset 모드의 목록을 화면이 상수(`GIT_TAG_KIND_OPTS`·`GIT_CO_RESET_MODES`)로 들고 있었다. 서버의 `write.TagKinds`·`ResetModes` 는 "API 로 노출한다" 고 적혀 있었으나 `TagKinds` 는 `tag/validate` 응답에만, `ResetModes` 는 어디에도 실리지 않았다 / **새**: `/api/git/policy` 가 `tagKinds`·`resetModes` 를 싣고, 두 대화상자는 열 때 그 목록으로 선택지를 만든다(라벨은 값으로 고른다). 정책을 받지 못하면 선택지 없이 열린다 — 서버의 기본값이 쓰인다 / **이유**: FR-SDA-43. 남긴 화면 상수: `GIT_TAG_KIND_LIGHT`(메시지를 싣지 않는 값)·`GIT_CO_RESET_MODE_HARD`(파괴적 확인을 거치는 값) — 목록이 아니라 화면 흐름의 분기다 |
| 2026-11-06 | GV-3 구현. 동작 변경 셋. ① **이전**: 화면이 `origin/x` 를 첫 `/` 에서 갈라 `branch/fetch`·`branch/delete-remote` 에 `remote`·`branch` 로 보냈다 — 원격 이름에 `/` 가 있으면 틀린 원격으로 갔다 / **새**: 화면은 `ref`(전체 이름)를 보내고 서버가 원격 목록에 맞춰 가른다(`remoteBranchOf` → `splitRemoteRef`). 가를 수 없으면 400 `not_remote_branch`. `remote`+`branch` 도 받는다 / **이유**: FR-SDA-42. ② **이전**: checkout 에 `track` 만 보내면 400 `bad_request` / **새**: 서버가 가른 브랜치 이름으로 로컬을 만든다. 화면의 "로컬로 checkout" 은 `track` 만 보낸다 / **이유**: 같다. ③ **이전**: 원격 ref 를 되살리는 안내 명령의 원격 이름을 화면이 갈랐다 / **새**: `/api/git/refs` 의 원격 ref 가 `remote` 를 싣고, 화면은 그것을 쓴다(대상에 없으면 패널이 아는 목록에서 찾는다) / **이유**: 같다. `query.RemoteRefPrefix` 를 공개했다. 게이트 목록에 `_split` 을 더했다(탐침: 넣으면 실패, 빼면 통과) |
| 2026-11-06 | GV-2 구현. 동작 변경 넷. ① **이전**: worktree 만들기의 빈 이름은 400 `ref_name_invalid`(문구), 빈 대상은 400 `bad_request`, 자리·새 브랜치 충돌은 409 에 한국어 `message` 를 실었다 / **새**: `empty_name`·`ref_name_invalid`·`empty_ref`·`worktree_exists`(`args.path`)·`branch_exists`(`args.branch`), `message` 없음 / **이유**: FR-SDA-2·D-SDA-5. ② **이전**: `write.ErrRemoteName`·`ErrRemoteURL` 은 400 `bad_request` / **새**: `remote_name_invalid`·`remote_url_invalid` — 원격 이름을 받는 모든 종단에서 같다. 원격 추가는 빈 값을 `empty_name`·`empty_url` 로 가르고 `message` 를 싣지 않는다 / **이유**: 같다. ③ **이전**: 핀(`repos/pin`)의 빈·상대 경로는 400 `bad_request` / **새**: `empty_path`·`path_must_be_absolute`(기존 코드). 저장소 판정은 답 함수(`repoAddAnswer`) 하나다 / **이유**: D-SDA-6. ④ **이전**: 대화상자 넷(worktree·원격 추가·비교·저장소 추가)이 빈 값을 스스로 판정했고, 원격 이름 위반은 실행을 누른 뒤에야 보였다 / **새**: 입력 중에 서버에 묻고 실행 전에 막는다 / **이유**: D-SDA-1. 설계 중 정한 것: 저장소 추가의 상대 경로는 새 코드 대신 기존 `path_must_be_absolute` 를 쓴다. worktree 답은 `newBranch` 도 받아 `branch_exists` 를 낸다 — 실행 종단이 이미 그것으로 거절했다 |
| 2026-11-06 | GV-1 구현(설계 §3.4a). 동작 변경 넷. ① **이전**: upstream 이 알려진 원격 ref 인지는 화면만 봤고, 목록이 없는 자리(History 의 refs 사이드바)에서는 보지 않았다. 서버는 막지 않았다 / **새**: 서버가 400 `upstream_unknown`·`empty_ref` 로 답하고 거절한다 / **이유**: FR-SDA-41·D-SDA-3. ② **이전**: 태그의 모르는 종류·빈 메시지는 400 `bad_request`(한국어 `message`)였고, 공백뿐인 메시지는 git 에 넘겼다 / **새**: `tag_kind_invalid`·`tag_message_required`, 공백뿐인 메시지도 빈 것으로 본다. `message` 없음 / **이유**: 사유를 코드로 가른다(FR-SDA-2·D-SDA-5). ③ **이전**: stash 브랜치의 이름 거절은 400 `bad_request`, 이미 있는 이름은 409 `branch_exists` 에 한국어 `message` 를 실었다 / **새**: `empty_name`·`ref_name_invalid`·`branch_exists`(`args.branch`), `message` 없음 / **이유**: 같다. ④ **이전**: 대화상자 셋이 빈 값·메시지 필요·원격 목록 대조를 스스로 판정했다 / **새**: `GitInputAnswer`(GV-d)로 서버에 묻는다 / **이유**: D-SDA-1. 설계 중 정한 것: 태그 종류의 입력 이름은 `tagKind` 다 — `kind` 는 GT-a 의 대상 종류 자리다 |
| 2026-11-06 | GT-2 구현. 동작 변경 넷. ① **이전**: 양쪽 삭제는 화면이 로컬 삭제·원격 삭제를 차례로 보냈다 / **새**: `POST /api/git/branch/delete-both` 하나가 짝을 판정하고 로컬을 지운 뒤 원격 삭제 잡을 띄운다 / **이유**: FR-SDA-35·사용자 결정. ② **이전**: 원격 ref 의 rename·upstream·push, 로컬 ref 의 fetch-into, 현재 브랜치 checkout, 자기 자신 merge·rebase, upstream 없는 해제, 진행 중 merge·rebase 를 화면만 막았다 / **새**: 서버가 `not_local_branch`·`not_remote_branch`·`branch_is_current`·`target_is_head`·`no_upstream`·`operation_in_progress` 로 거절한다 / **이유**: D-SDA-3. ③ **이전**: 현재 브랜치 삭제 거절에 한국어 `message` 를 실었다 / **새**: 코드와 `branch` 만 / **이유**: D-SDA-5. ④ 1층의 `git.branch.push`·`git.branch.fetch`·`git.branch.delete_remote` 는 2층(브랜치 메뉴 답)으로 옮겼다. 화면: 브랜치 메뉴와 그 더블클릭은 열 때 서버에 묻는다. `gitOpBusy`·`pairOf` 의 사유와 판정 문구 아홉을 없앴다 |
| 2026-11-06 | GT-1 구현. 사용자 결정: 양쪽 삭제는 새 종단 `POST /api/git/branch/delete-both`(GT-e). 동작 변경 셋. ① **이전**: merge 등이 진행 중일 때 cherry-pick·revert·reset·drop 을 서버가 막지 않았다(git 이 exit 128 로 실패) / **새**: 409 `operation_in_progress`(`args.kind`) / **이유**: D-SDA-3. ② **이전**: HEAD 를 대상으로 한 cherry-pick·reset 을 화면만 막았다 / **새**: 서버도 409 `target_is_head` 로 거절한다 / **이유**: D-SDA-3. ③ **이전**: 루트·머지 커밋 drop 은 400 `bad_request`(한국어 `message`) / **새**: 400 `root_commit`·`merge_commit` / **이유**: 사유를 코드로 가른다(FR-SDA-34). 화면: `menu.js` 의 항목 표를 `menu-items.js` 로 옮겼다(모듈 크기 기준선, 내용 같음) |
| 2026-11-05 | GR-3 구현. 동작 변경 셋. ① **이전**: 커밋 버튼은 화면이 메시지·staged 로 판정했고, preflight 막힘·amend 메시지 불변은 누른 뒤에야 알았다 / **새**: 서버의 답(`git.commit`)이 버튼을 켜고 끄며, preflight 가 막으면 누르기 전에 해소법이 보인다 / **이유**: FR-SDA-23·G-A3. ② **이전**: 커밋 거절(`empty_message`·`nothing_staged`·`preflight_blocked`)에 한국어 `message` 를 실었다 / **새**: 코드와 `args` 만 싣는다(preflight 거절은 `preflight` 도) / **이유**: D-SDA-5. ③ **이전**: preflight 막힘을 staged 판정보다 먼저, 실행 전 상태를 찍기 전에 봤다 / **새**: 상태를 찍은 뒤 preflight → staged 순으로 본다 — 결과 코드의 우선순위는 같다 / **이유**: 답과 거절이 한 함수(`commitStateAnswer`)를 부르게 하려고. 1층의 `git.commit` 은 뺐다(GR-3a). e2e `git-branch-actions` 의 git 헬퍼는 `GIT_OPTIONAL_LOCKS=0` 으로 돈다 — 시험의 `git status` 폴링이 index.lock 을 잡아 서버의 merge 와 다퉜다(BR8, 변경 전 0/9 · 변경 후 2/6 · 고친 뒤 0/8) |
| 2026-11-05 | GR-2 구현. 동작 변경 둘. ① **이전**: 커밋 안 된 행의 Reset·Clean 을 실행 전에 거절하면(`no_head`·`nothing_to_clean`) 한국어 `message` 를 실었다 / **새**: 코드만 싣는다 / **이유**: D-SDA-5. ② **이전**: stash 만들기 대화상자의 답(`git.stash.create`)이 작업 칸을 보지 않았다 / **새**: index 칸이 차 있으면 `job_busy` 로 꺼진다 / **이유**: 실행 종단은 잠금을 먼저 쥔다 — 답이 같은 순서로 판정해야 한다(GR-2a) |
| 2026-11-05 | GR-1 구현. 동작 변경 셋. ① **이전**: 화면이 index 칸이 돌면 동기 쓰기를 보내지 않고 스스로 `job_busy` 를 만들었다 / **새**: 요청을 보내고 서버의 409 `job_busy` 를 보인다 / **이유**: 판정의 주인은 서버다(D-SDA-1). ② **이전**: 칸 때문에 거절할 때 한국어 `message` 를 실었다 / **새**: `error: job_busy` 와 `args.job`(칸을 쥔 잡 id)만 싣는다 / **이유**: D-SDA-5. ③ **이전**: 원격 작업의 시작 요청이 오가는 동안 같은 칸을 쓰는 버튼이 모두 꺼졌다 / **새**: 누른 버튼만 꺼지고 나머지는 서버의 다음 답을 따른다 / **이유**: FR-SDA-7 |
| 2026-11-05 | 묶음 GR 설계 세부(§3.2a). 사용자 결정: `git.worktree.remove` 의 답은 1층이 아니라 worktree 목록의 행마다 싣는다(D-SDA-2 와 FR-SDA-20 의 어긋남 해소). FR-SDA-20 에서 `git.worktree.remove`·`git.init` 을 뺐다 |
| 2026-11-05 | 묶음 M 설계 세부(§3.1a)를 적었다. 동작 변경 — **이전**: untracked 파일만 있는 저장소에서 `--include-untracked` 없이 stash 를 만들면 409 `nothing_to_stash` 에 한국어 `message` 가 실렸다. **새**: 409 `untracked_only`, `args.count` 는 untracked 파일 수이고 `message` 는 없다. **이유**: 사유가 다르면 사용자가 할 일(옵션 켜기)이 다르다. 그리고 문구는 화면이 고른다(D-SDA-5) |
| 2026-11-05 | 승인(사용자). 설계로 정한 D-SDA-5~7 · FR-SDA-23 · FR-SDA-61 · R-3 도 함께 승인됐다 |
| 2026-11-05 | 초안. 전수 목록과 사용자 결정 4건(D-SDA-1~4)에서 썼다 |
