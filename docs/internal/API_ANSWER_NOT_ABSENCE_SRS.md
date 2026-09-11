# SRS: 답을 부재로 적지 않는다 — 가짜 404 를 가른다 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

사용자 보고 `U-22`(2026-09-11 접수)를 없앤다. 접수한 말은 이렇다.

> *"404 는 주기적으로 올라오며 파일 저장 시에도 발생한다. (…) 404 로 내보내지 말고
> 정상 처리이므로 예외 처리를 한다. **실제 404 와 가짜 404 를 구분해야 한다.**"*

콘솔에 쌓이던 것이 이것이다.

```
/api/git/status?repo=%2FUsers%2Fdykim%2F.dongminal%2Fnotes  404 (Not Found)
/api/fs/ignored                                             404 (Not Found)
```

두 응답 모두 **서버가 답을 아는 상태**다. 경로는 있고, 읽혔고, 판정도 끝났다 —
그 판정이 *"이 경로는 git 저장소가 아니다"* 일 뿐이다. 그것을 `404 Not Found` 로
적으면 **"네가 지목한 것이 거기 없다"** 는 뜻이 되어, 정상 동작이 브라우저의
오류 콘솔에 영구히 쌓인다.

이 문서가 정하는 것은 그 **한 가지 구분**이다. 오류 처리를 느슨하게 만들지 않는다 —
실제 404 는 실제 404 로 남는다.

### 1.2 범위 (Scope)

- `internal/webserver/gitapi/handlers_git.go` — `apiGitStatus`.
- `internal/webserver/gitapi/handlers_git_write.go` — `gitResolveRepo` 의 분리.
- `internal/webserver/httpapi/handlers_fs_ignored.go` — `apiFSIgnored`.
- `web/js/git/panel-poll.js` — `_applyStatus` 의 판정 갈래.
- `web/js/ui/file-tree-paint.js` — `loadIgnored` 의 판정 갈래.
- 그 넷을 고정한 Go 테스트.

비포함:

- **`internal/webserver/apierr/tables.go` 의 매핑표.** 고치면 `/api/git/worktrees`
  등 다른 종단의 계약이 함께 바뀐다 (§4 D-1).
- `repo_missing`(있던 저장소가 사라졌다) · `git_missing`(git 이 없다) ·
  경계 위반(403) · 잘못된 인자(400). **전부 실제다** (§2.3).
- 재시도를 멈추는 성질. 그것은 지금도 옳고 그대로 남는다 (§3 `FR-ANA-4`).
- 요청 자체를 줄이는 일. `signal()` 이 포커스마다 한 번 묻는 것은 의도된 복구
  경로다 (§2.4) — 이 문서는 **답의 형식**만 고친다.

### 1.3 정의 (Definitions)

- **실제 404**: 지목한 자원이 **없다.** 서버가 답을 만들 재료를 얻지 못한 경우다.
- **가짜 404**: 지목한 자원은 **있고** 서버가 답을 **알고 있는데**, 그 답이
  "아니다" 라는 이유로 부재로 적힌 경우.
- **판정을 굳힌다**: 클라이언트가 그 답을 확정으로 받아 같은 질문을 되풀이하지
  않는 일. 지금은 4xx 가 그 신호다 (`FR-ETR-4`).

### 1.4 참조 (References)

- `docs/internal/EXPLORER_TRANSFER_IGNORE_SRS.md` `FR-ETR-3·4` — `check-ignore` 의
  exit 1 을 **답**으로 받는 조항과, 4xx 를 판정으로 굳히는 규약.
- `docs/internal/UX_BATCH6_SRS.md` `FR-DSP-1a` — 확정된 "저장소가 아니다" 가 폴링을
  멈춘다. 되살아나는 길 셋.
- `docs/internal/GIT_REPO_MISSING_SRS.md` `FR-RMS-4` — 소실과 "저장소 아님" 이
  **사유로 갈린다**는 것. 이 문서는 그 위에 **상태 코드로도** 갈린다를 얹는다.
- `docs/internal/GIT_WATCH_LEASE_SRS.md` `FR-GWL-9` — `clientId` 가 실리는 요청.

## 2. 현재 상태 (조사로 확정한 사실)

### 2.1 같은 성격의 답이 상태 코드에서 갈려 있다

`apiFSIgnored` 가 그 비대칭을 한 함수 안에 담고 있다 (`handlers_fs_ignored.go`).

| `git check-ignore` 의 결과 | 뜻 | 지금의 응답 |
|---|---|---|
| exit 0 | 무시된 것이 있다 | `200 {"ignored":[…]}` |
| exit 1 | **무시된 것이 없다** | `200 {"ignored":[]}` |
| exit 128 | **저장소가 아니다** | **`404 fs_not_repo`** |
| git 바이너리 없음 | 색을 칠할 수 없다 | **`404 fs_not_repo`** |

앞의 둘과 뒤의 둘은 **같은 성질**이다 — 넷 모두 "물었고 답을 얻었다" 이며, 어느
것도 자원의 부재가 아니다. 그런데 셋째부터 부재로 적힌다. 코드의 주석이 exit 1 에
대해 *"실패가 아니라 **답**"* 이라고 적어 둔 그 기준이 exit 128 에는 적용되지
않았다.

### 2.2 `/api/git/status` 의 404 는 `gitResolveRepo` 에서 난다

`apiGitStatus` → `gitRepoParam` → `gitResolveRepo` → `s.Git.RepoRoot()` 가
`core.ErrNotRepo` 를 내면 `gitError` 가 매핑표를 보고 `404 not_a_git_repo` 를 쓴다.

`gitResolveRepo` 는 **22곳이 쓰는 공용 함수**이고 그 안에 경계 검사
(`FR-FAB-14`/`SEC-15`)와 git 가용성 검사(`FR-DPN-24`)가 들어 있다. 그 둘은 호출자로
복제하면 반드시 하나가 빠지므로(주석이 실제로 빠졌던 셋을 적고 있다) **우회도
복제도 금지**다.

### 2.3 실제인 것들 — 함께 고치지 않는다

| 응답 | 왜 실제인가 |
|---|---|
| `repo_missing` (404) | **있던** 저장소가 사라졌다. 부재가 사실이다 |
| `git_missing` (503) | 서버가 답할 수단이 없다. 일시적 불능이다 |
| `repo` 누락·상대경로 (400) | 요청이 틀렸다 |
| 허용 루트 밖 (403) | 경계 위반. 답을 주는 것 자체가 결함이다 |

`FR-RMS-4` 가 *"소실과 저장소 아님은 둘 다 404 인데 사유로 갈린다"* 고 적어 두었다.
이 문서는 그 문장의 전제를 좁힌다 — **둘은 성질이 다르므로 상태 코드로도 갈려야
한다.** 사유로만 가르면 콘솔이 둘을 구분하지 못한다.

### 2.4 폴링은 이미 멈춘다 — 반복의 출처는 복구 경로다

`panel-poll._applyError('not_a_git_repo')` 는 `_stop()` 으로 주기를 멈춘다
(`FR-DSP-1a`). 그런데도 사용자의 콘솔에 같은 요청이 쌓인 것은, 그 조항이 남겨 둔
되살아나는 길 때문이다 — **창·탭에 포커스가 올 때마다 `signal()` 이 한 번 묻는다.**

로그에 `clientId` 가 붙은 요청과 붙지 않은 요청이 섞여 있는 것이 그 증거다
(폴링 경로는 `clientId` 를 싣는다 — `FR-GWL-9`).

그 경로는 **옳다.** `git init` 직후 되살아나는 길이 그것이다. 그러므로 요청을
없애는 것이 아니라 **답의 형식**을 고친다.

### 2.5 클라이언트는 이미 "답" 으로 다루고 있다

두 호출부 모두 4xx 를 오류가 아니라 **판정**으로 쓴다.

```js
// file-tree-paint.js — 4xx 를 굳힌다
if(r.status>=400&&r.status<500){this._ignOff=true; …}
// panel-poll.js — 404 의 사유로 화면을 정한다 (git init 버튼이 선다)
if(code==='not_a_git_repo'){ this._notRepo=true; this._stop(); … }
```

즉 **의미는 이미 "답" 이고 전송 계층의 표기만 "부재"** 다. 이 작업은 그 어긋남을
없애는 것이지 동작을 새로 만드는 것이 아니다.

## 3. 요구사항 (Requirements)

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-ANA-1 | `GET /api/git/status` 는 요청한 경로가 git 저장소가 **아닐 때** `200` 으로 답하고, 본문의 `isRepo:false` 로 그것을 밝힌다. `requested` 를 함께 실어 클라이언트의 세대 검사(`d.requested!==tok.repo`)를 지난다 | 필수 |
| FR-ANA-2 | `POST /api/fs/ignored` 는 무시 여부를 **판정할 수 없을 때** `200 {"ignored":[],"isRepo":false}` 로 답한다. 저장소가 아닌 경우와 git 이 없는 경우가 같다 — 둘 다 "색을 칠하지 않는다" 는 같은 답이다 | 필수 |
| FR-ANA-3 | 그 둘 **말고는 아무것도 바뀌지 않는다.** `repo_missing`·`git_missing`·400·403 은 지금의 상태 코드와 사유를 그대로 쓴다 (§2.3) | 필수 |
| FR-ANA-4 | **재시도를 멈추는 성질은 유지된다.** 지금 4xx 가 하던 신호를 `isRepo:false` 가 대신한다 — 탐색기는 `_ignOff` 를 굳히고, git 패널은 `_notRepo` 와 `_stop()` 에 이른다. 되살아나는 길 셋(포커스·새로고침·`git init`)도 그대로다 | 필수 |
| FR-ANA-5 | 경계 검사와 git 가용성 검사는 **한 자리에 남는다.** `gitResolveRepo` 를 복제하지 않고 **나눈다** — 새 변형이 "저장소 아님" 을 값으로 돌려주고, 기존 함수는 그 변형을 감싸 종전대로 404 를 쓴다. 나머지 21개 호출부는 한 글자도 바뀌지 않는다 | 필수 |
| FR-ANA-6 | 저장소가 아닌 경로는 **감시 대상에 넣지 않는다.** `Watch.NoteFor` 는 지금도 오류 갈래 뒤에 있어 자연히 건너뛰어졌다 — 200 갈래가 생겨도 그 성질이 유지되어야 한다 (*"답할 수 있는 저장소만 감시한다"*) | 필수 |

### 3.1 비기능 (Non-functional)

| ID | 요구사항 |
|----|---------|
| NFR-ANA-1 | 브라우저 콘솔에 이 두 경로로 인한 오류 줄이 **한 줄도 남지 않는다.** 그것이 이 작업의 관측 가능한 결과다 |
| NFR-ANA-2 | 요청 수는 늘지도 줄지도 않는다. 형식만 바뀐다 (§1.2 비포함) |

## 4. 설계 결정 (Design Decisions)

- **D-1. 매핑표를 고치지 않는다.** `apierr.Git` 의 `{core.ErrNotRepo → 404}` 는
  `/api/git/worktrees` 를 비롯한 여러 종단이 함께 쓴다. 거기서 고치면 이 보고와
  무관한 계약이 조용히 바뀌고, 그 변화를 아무도 재지 않는다. **종단에서 가른다** —
  답으로 받고 싶은 종단이 스스로 그렇게 말한다.
- **D-2. 함수를 나누되 복제하지 않는다.** `gitResolveRepo` 안의 두 검사는 이미 한 번
  "호출자로 복제했다가 셋이 빠졌던" 이력이 있다(그 주석이 남아 있다). 그래서
  새 종단을 위해 검사를 다시 쓰지 않고, 기존 함수를 **한 겹 아래로 내린다.**
- **D-3. 값의 이름은 `isRepo` 다.** `/api/git/repos` 가 핀 목록의 각 항목에 이미
  `isRepo` 를 싣고 있다(`handlers_git_test.go:329`). 같은 뜻에 같은 이름을 쓴다 —
  새 어휘를 만들면 두 표면이 같은 것을 다르게 부른다.
- **D-4. `fs/ignored` 는 사유를 나누지 않는다.** "저장소가 아니다" 와 "git 이 없다"
  는 원인이 다르지만 **탐색기가 할 일은 같다**(색을 칠하지 않는다). 지금 코드도
  그 둘을 한 코드로 뭉쳐 두었고 그 판단은 옳았다 — 바뀌는 것은 상태 코드뿐이다.
- **D-5. 404 를 없애는 것이 아니라 옮기는 것이다.** 이 변경 뒤에도 `/api/git/status`
  는 404 를 낸다 — `repo_missing` 일 때다. 그때는 콘솔에 뜨는 것이 **옳다.**

## 5. 검증 (Verification)

| ID | 시나리오 | 기대 |
|----|---------|------|
| V-ANA-1 | `/api/git/status?repo=<git 아닌 절대경로>` | `200`, `isRepo:false`, `requested` 가 보낸 값 그대로 (`FR-ANA-1`) |
| V-ANA-2 | 같은 요청에서 감시 등록 | `Watch.NoteFor` 가 불리지 않는다 (`FR-ANA-6`) |
| V-ANA-3 | `/api/git/status` 가 `repo_missing` 을 만난다 | **`404`** `repo_missing` — 무변경 (`FR-ANA-3`) |
| V-ANA-4 | `/api/git/status` 의 400·503·504 갈래 | 무변경 (`TestGitStatus_ErrorMapping` 의 나머지 행) |
| V-ANA-5 | `/api/fs/ignored` 가 exit 128 을 만난다 | `200 {"ignored":[],"isRepo":false}` (`FR-ANA-2`) |
| V-ANA-6 | `/api/fs/ignored` 가 `ErrGitMissing` 을 만난다 | 같다 (`D-4`) |
| V-ANA-7 | `/api/fs/ignored` 의 400·403 갈래 | 무변경 |
| V-ANA-8 | 다른 git 종단(`worktrees` 등)이 저장소 아님을 만난다 | **`404` 무변경** — 매핑표를 고치지 않았음을 잰다 (`D-1`) |
| V-ANA-9 | 탐색기가 `isRepo:false` 를 받는다 | `_ignOff` 가 굳고 그 겹을 다시 묻지 않는다 (`FR-ANA-4`) |
| V-ANA-10 | git 패널이 `isRepo:false` 를 받는다 | `_notRepo` 가 서고 폴링이 멈춘다. `git init` 버튼이 그려진다 (`FR-ANA-4`) |

## 6. 비목표 (Non-goals)

- 요청 빈도·복구 경로의 변경.
- `repo_missing`·`git_missing` 의 상태 코드.
- 매핑표(`apierr`) 정리.
- 다른 종단의 4xx 재검토. 같은 결함이 더 있을 수 있으나, 이 문서는 **보고된 둘**만
  받는다 — 전수 조사는 근거가 생겼을 때 별개로 한다.

## 7. 리스크 (Risks)

| ID | 리스크 | 등급 | 완화 |
|----|--------|------|------|
| R-ANA-1 | 200 으로 바꾸면서 재시도 억제가 풀려 3초마다 영영 묻는다 | **HIGH** | `FR-ANA-4` 가 그 성질을 명시하고 `V-ANA-9·10` 이 직접 잰다. 이것이 `FR-ETR-4` 가 처음부터 막으려던 것이다 |
| R-ANA-2 | `gitResolveRepo` 를 나누다 경계 검사가 한쪽에만 남는다 | **HIGH** | 복제하지 않고 **감싼다** (`FR-ANA-5`, D-2). 기존 21개 호출부의 경로가 바뀌지 않는다 |
| R-ANA-3 | 클라이언트가 `isRepo` 를 못 보고 빈 status 를 정상으로 읽어 화면을 비운다 | MEDIUM | 판정을 `_applyStatus` 의 **첫 갈래**에 둔다. `V-ANA-10` 이 `git init` 버튼까지 확인한다 |
| R-ANA-4 | 매핑표를 건드리지 않았는데 다른 종단이 함께 바뀐다 | LOW | `V-ANA-8` 이 다른 종단의 404 를 고정한다 |
