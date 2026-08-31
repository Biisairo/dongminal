# SRS: 얕은 모듈 깊이화 리팩터 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

프로세스 축 패키지 레이아웃(`PACKAGE_RESTRUCTURE_SRS`)과 `domain/git` 의 두
초크포인트는 이미 서 있다. 그 구조 **안에서** 얕은 모듈이 뭉쳐 있는 자리 여섯을
깊이화한다.

근본 문제는 파일이 크다는 것이 아니라 — **계약이 한 곳에서 선언되지 않아 호출자
수만큼 복제되고, 복제본이 이미 서로 갈라졌다는 것**이다.

측정된 증거 둘:

```go
// domain/git/write/ignore.go:34 — sentinel 이 자기 와이어 코드를 들고 있다
var ErrIgnorePath = errors.New("unsafe_ignore_path")
// gitapi/handlers_git_ignore.go:28 — 같은 문자열을 다시 선언한다
gitErrIgnorePath = "unsafe_ignore_path"
```

```go
// core.ErrRefName 하나가 두 코드로 갈렸다 — 복제가 드리프트한 증거
gitBranchError / gitTagError → 400 "ref_name_invalid"
gitCommitOpError            → 400 "bad_request"     // handlers_git_commit_ops.go:317
```

`domain` 의 sentinel 78개 중 **11개는 HTTP 매핑이 없어 조용히 500 이 된다**
(`ErrReplayTarget`·`ErrUncommittedNoHead`·`ErrBlameParse`·`ErrJobKind`·
`ErrOperation`·`ErrUnsupported` 등). 매핑이 없다는 사실을 아무것도 알려주지 않는
것이 이 문제의 본질이다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **A** | `apierr` 신설 — sentinel → (status, code) 등록부 하나. 번역기 17개 흡수, 와이어 코드 단일 소유 | **MEDIUM** |
| **B** | git 쓰기 핸들러의 6단 `ok bool` 사다리를 파이프라인 모듈로 깊이화 | **MEDIUM** |
| **C** | 프론트엔드 `gitFetch` 신설 — stale/echo 가드를 22개 호출자에서 회수 | **MEDIUM** |
| **D** | `constants.js` 1,586줄을 주제별로 분할 (GIT_ 572 · EDITOR_ 76 · 공용 64) | LOW |
| **E** | `Deps` → `Server` 14필드 기계적 복사 제거 (임베딩) | LOW |
| **F** | `ctl/cli` 디스패치 8 case → 액션 테이블 | LOW |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **깊이 (depth)** | 작은 인터페이스 뒤에 놓인 행위의 양. 인터페이스가 구현만큼 복잡하면 **얕다** |
| **이음매 (seam)** | 인터페이스가 사는 자리. 제자리를 고치지 않고 행위를 갈아 끼울 수 있는 곳 |
| **삭제 테스트** | 모듈을 지웠다고 상상한다. 복잡도가 **집중**되면 값을 벌던 모듈, **이동**만 하면 통과 모듈 |
| **sentinel** | `errors.New` 로 선언된 비교 대상 오류값. `errors.Is` 로 판정한다 |
| **와이어 코드** | HTTP 응답 본문의 오류 식별 문자열. 클라이언트가 분기하는 근거 |
| **방언 (dialect)** | 한 서버 안에서 서로 다른 오류 본문 모양. 이 코드베이스에는 넷이 있다 (§2.2) |
| **번역기 (translator)** | `switch errors.Is → (status, code)` 를 수행하는 함수. `gitapi` 에 17개 |
| **사다리 (ladder)** | `x, ok := step(w, r); if !ok { return }` 의 연쇄. 순서 불변식이 타입이 아니라 주석에만 있는 형태 |
| **echo 검증** | 서버가 되싣는 `requested` 를 클라이언트가 자기 요청과 대조하는 것. 늦게 온 남의 응답을 자기 것으로 읽지 않는 유일한 수단 |
| **특성화 테스트** | 리팩터 전에 **현재 행위를 그대로 고정**하는 테스트. 행위 불변을 증명하는 안전망 |

### 1.4 참고 (References)

- `docs/internal/architecture.md` — 프로세스 축 레이아웃, `domain/git` 초크포인트
- `docs/internal/PACKAGE_RESTRUCTURE_SRS.md` — 현재 패키지 경계의 근거
- `docs/internal/GIT_SRS.md`, `GIT_ACTIONS_SRS.md` — git 표면의 FR 번호 원본
- `docs/internal/EDITOR_TAB_SRS.md` — `/api/fs/*` · `/api/editors/*` 계약

---

## 2. 전체 기술 (Overall Description)

### 2.1 현황 측정

| 항목 | 값 |
|---|---|
| Go 프로덕션 / 테스트 | 39,115 / 47,825 줄 |
| 프론트엔드 | 21,483 줄 (번들러 없음 — 로드 순서가 곧 의존성) |
| `gitapi` 핸들러 | 74개 · 커버리지 79.0% |
| `httpapi` 핸들러 | 63개 · 커버리지 80.0% |
| `domain` sentinel | 78개 (매핑됨 67 · **매핑 없음 11**) |
| 오류 번역기 | `gitapi` 17개 + `writeRunError` 19-case + `fsStatus` 6-case |

`gitapi` 사다리 반복: `if s.Git == nil` 64 · `gitDecodeBody` 39 ·
`gitResolveRepo` 42 · `gitStatusBefore` 30 · `gitApply` 23 · `gitWriteOK` 27 ·
confirm 검사 18.

### 2.2 방언 넷 — 본문 모양은 공개 계약이다

| 방언 | 본문 | 코드 필드 |
|---|---|---|
| `gitapi` | `{"error": <코드>, "message": <tail>}` | `error` |
| `fs` | `{"code": <코드>, "message": <msg>}` | `code` |
| `runs` | `{"error": <sentinel 문자열>, "detail": <err>}` | `error` |
| `toolio`/`whoami` | `{"error": <msg>}` | — |

**본문 모양을 통일하지 않는다.** 브라우저가 이미 이 넷을 각각 소비한다 —
통일은 리팩터가 아니라 파괴적 변경이다. 깊이화 대상은 **매핑 기계**뿐이며, 각
표면은 자기 렌더러를 유지한다. 렌더러가 둘 이상이므로 이음매가 가설이 아니라
실재한다 (어댑터 하나 = 가설, 둘 = 실재).

### 2.3 제약 (Constraints)

- **C1** — `domain/*` 는 `net/http` 를 import 하지 않는다. 상태 코드 지식은 HTTP
  레이어에 남는다. 등록부가 `domain` 쪽에 놓이면 계층이 역전된다.
- **C2** — `web/version_test.go` 가 `assets.lock` + `index.html` 의 `?v=` 를 잠근다.
  프론트엔드 자산을 고치면 두 곳을 함께 올려야 한다.
- **C3** — 프론트엔드에 번들러가 없다. 새 JS 파일은 `index.html` 의 `<script>`
  순서에 **의존성 순으로** 삽입해야 한다. `git/*.js` 는 `core/app.js` 보다 앞이다.
- **C4** — Go 는 메서드에 타입 파라미터를 허용하지 않는다. 제네릭 파이프라인은
  자유 함수여야 한다.
- **C5** — `internal/` 캡슐화를 유지한다. 새 패키지도 `internal/` 안이다.

### 2.4 가정 (Assumptions)

- **A1** — `gitapi` 79% · `httpapi` 80% 커버리지가 행위 불변 검증의 근거로 충분하다.
  부족한 자리는 특성화 테스트로 먼저 메운다 (§4).
- **A2** — sentinel 이 두 표면에서 서로 다른 (status, code) 로 매핑되는 충돌은
  §3.1.4 의 하나(`core.ErrRefName`)뿐이다. 전수 조사로 확인했다.
- **A3** — 문맥 의존 매핑(오류값만으로 결정되지 않는 것)은 등록부로 옮기지 않는다.
  `write.ErrMergeParent`(부모 목록을 함께 실어야 함)와
  `gitStashErrorCode`(`extra["stashKept"]` 로 갈림)가 그에 해당한다.

---

## 3. 상세 요구사항 (Specific Requirements)

### 3.1 묶음 A — 오류 등록부 (`internal/webserver/apierr`)

#### 3.1.1 위치와 소유

- **FR-DPN-1** — 새 패키지 `internal/webserver/apierr` 가 **와이어 코드 상수**와
  **sentinel → (status, code) 등록부**를 소유한다. `domain/*` 를 import 하고,
  `gitapi`·`httpapi` 가 이것을 import 한다. 역방향 import 는 없다.
- **FR-DPN-2** — 등록부는 선언적 테이블이다:
  ```go
  type Rule struct { Err error; Status int; Code string }
  ```
  `Lookup(err error) (status int, code string, ok bool)` 가 테이블을 순서대로 걸어
  첫 `errors.Is` 일치를 돌려준다. 일치가 없으면 `ok == false` — 호출자가 자기
  기본값을 정한다. **등록부가 500 을 대신 정하지 않는다**: 표면마다 미분류 실패의
  코드가 다르다(`git_failed` · `io_failed` · sentinel 문자열).
- **FR-DPN-3** — 와이어 코드는 `apierr` 의 exported 상수가 단일 소유자다.
  `gitapi` 의 `gitErr*` 40개와 `httpapi` 의 `fsErr*` 7개 중 **등록부가 쓰는 것**은
  `apierr.Code*` 로 대체한다. sentinel 없이 핸들러가 직접 내는 정책 거부
  (`confirmation_required`·`preflight_blocked` 등)도 같은 상수를 쓴다 — 문자열이
  두 벌이 될 자리를 남기지 않는다.

#### 3.1.2 흡수 대상

- **FR-DPN-4** — 아래 번역기의 **순수 sentinel 분기**를 등록부로 옮기고 함수를
  지운다: `gitErrorCode` · `gitWriteErrorCode` · `gitPatchErrorCode` ·
  `gitRemoteListError` · `gitBlameError` · `gitDiffError` · `gitBranchError` ·
  `gitTagError` · `gitRemoteError` · `gitStashError` · `gitCommitOpError` ·
  `gitWorktreeError` · `gitHistoryError`.
- **FR-DPN-5** — 문맥 의존 분기는 **제자리에 남긴다** (A3). 남은 함수는 자기 문맥
  분기만 하고 나머지를 `apierr.Lookup` 에 넘긴다 — 즉 `switch` 가 사라지는 것이
  아니라 **문맥이 있는 case 만 남는다**.
- **FR-DPN-6** — `httpapi.writeRunError` 의 19 case 와 `fsStatus`/`fsEntriesErr` 의
  분기도 등록부를 거친다. 본문 렌더링(`{"error","detail"}` · `{"code","message"}`)은
  **바뀌지 않는다** (§2.2).

#### 3.1.3 전수성 강제

- **FR-DPN-7** — `apierr` 에 **sentinel 인벤토리**를 둔다: HTTP 표면에 도달할 수
  있는 `domain` sentinel 전부를 열거한 목록. 테스트가 인벤토리와 등록부를 대조해
  누락을 실패로 만든다.
- **FR-DPN-8** — 매핑이 의도적으로 없는 sentinel 은 **사유와 함께** 인벤토리에
  기록한다 (`unmapped` 목록). 빈칸을 침묵으로 두지 않는다. 새 sentinel 을 더하고
  매핑도 사유도 적지 않으면 테스트가 실패한다 — **조용히 500 이 되는 경로가
  구조적으로 없어진다.**
- **FR-DPN-9** — §1.1 의 11개는 이 묶음에서 **매핑하지 않는다**. `unmapped` 에
  사유를 적어 가시화하는 것까지가 범위다. 코드를 부여하는 것은 와이어 계약의
  확장이므로 별도 결정이다 (§5 비목표 N2).

#### 3.1.4 충돌 해소 — `core.ErrRefName`

- **FR-DPN-10** — `core.ErrRefName` 을 **`400 ref_name_invalid` 하나로 통일**한다.

  | | |
  |---|---|
  | **이전 동작** | `branch`·`tag`·`worktree` → `400 ref_name_invalid` / `commit_ops`(cherry-pick·revert·reset·drop 의 oid 검사) → `400 bad_request` |
  | **새 동작** | 전부 `400 ref_name_invalid` |
  | **이유** | 같은 sentinel 이 두 코드로 갈린 것은 설계가 아니라 복제의 드리프트다. 상태 코드는 400 그대로이고 코드만 더 구체적이 된다. `commit_ops` 의 `bad_request` 를 고정한 테스트가 없고, 프론트엔드가 그 코드로 분기하는 자리도 없다 — 전수 확인했다 |

- **FR-DPN-11** — `worktree.ErrUnsafeArgument → 400 ref_name_invalid` 는 **현재
  동작을 유지한다**. `handlers_git_worktree_test.go:167` 이 그 계약을 고정하고 있다
  — sentinel 이 다르므로 FR-DPN-10 의 충돌이 아니다.

#### 3.1.5 구현 중 확정된 것

- **FR-DPN-12** — **테이블이 표면마다 하나다.** 구현 중 두 번째 충돌을 찾았고,
  그것은 드리프트가 아니라 **정당한 표면별 차이**였다:

  | | `/api/git/worktrees` | `/api/runs` |
  |---|---|---|
  | `worktree.ErrNotRepo` | **404** `not_a_git_repo` | **400** `not_a_git_repo` |
  | 근거 | 지목한 것이 거기 없다 | 호출자가 인자로 준 것이 틀렸다 |

  둘 다 옳으므로 전역 테이블 하나로는 담을 수 없다. **기계(`Table.Lookup`)는
  공유하고 정책(테이블)은 표면이 갖는다.** 어댑터가 셋(`Git`·`Runs`·`FS`)이므로
  이 이음매는 가설이 아니라 실재한다.

- **FR-DPN-13** — 테이블이 하나가 되면서 **sentinel 은 어느 핸들러에서 나오든 같은
  코드를 얻는다.** 이전에는 번역기가 모르는 sentinel 을 500 으로 흘려보냈다.
  그 폴백이 사라지는 방향은 **500 을 옳은 4xx 로 좁히는 쪽뿐**이며, 이미 있던
  4xx 를 다른 값으로 바꾸지 않는다 — git 테이블이 내부적으로 일관됨을 전수
  확인했고(§4.1 V2 의 표가 그 증거다), 유일한 예외가 FR-DPN-10 이다.

- **FR-DPN-14** — 와이어 코드 상수는 `apierr` 가 소유하되, `gitapi`·`httpapi` 는
  **자기 짧은 이름을 유지한다** (`gitErrNotRepo = apierr.CodeNotRepo`).
  호출 지점 351곳을 `apierr.Code*` 로 바꾸는 대안보다 이쪽을 택한 이유는 둘이다:
  ① 문자열이 한 곳에만 있으므로 단일 소유는 이미 달성된다 ② 각 지역 상수에 붙은
  주석(그 거부가 왜 그 코드인지)이 그 자리에 남는다. 이름이 둘인 대가는 인정한다.

### 3.2 묶음 B — git 쓰기 파이프라인

- **FR-DPN-20** — `gitapi` 에 쓰기 한 번을 소유하는 자유 함수를 둔다 (C4):
  ```go
  func runWrite[Req any](s *GitServer, w http.ResponseWriter, r *http.Request, op writeOp[Req])
  ```
  `writeOp` 가 선언하는 것: 요청 타입 · confirm 요구 · 실행 전 인자 검증 ·
  repo 필드 추출 · 쓰기 클로저 · 성공 응답의 `extra` · 오류 렌더러.
- **FR-DPN-21** — 파이프라인이 소유하는 순서는 **하나이며 타입이 그것을 강제한다**:
  `Git nil 검사 → 본문 디코드 → confirm → 인자 검증 → repo 해석 → 실행 전 status
  → 실행 → 실행 후 status → 응답`. 핸들러가 순서를 다시 쓸 자리가 없다.
- **FR-DPN-22** — 표준형에 맞지 않는 핸들러(실행 전 추가 조회가 필요한 것,
  job 경로를 타는 것, SSE 를 내는 것)는 **훅으로 끼운다**. 훅으로도 맞지 않는 것은
  제자리에 남기고, 남긴 것의 목록과 사유를 이 문서에 적는다. **억지로 밀어 넣지
  않는다** — 맞지 않는 것을 파이프라인에 넣으면 파이프라인이 얕아진다.
- **FR-DPN-23** — 파이프라인 도입으로 응답 본문·상태 코드가 달라지는 핸들러는
  없다. 기존 테스트가 그것을 증명한다.

#### 3.2.1 구현 중 확정된 것

- **FR-DPN-25** — 파이프라인은 **끈적한 실패**(sticky error)로 구현한다. 선언적
  `writeOp` 구조체(훅 필드 6~8개)를 검토했으나 버렸다 — 선언의 문법 비용이
  제거하는 사다리와 거의 같아서 **깊어지지 않고 모양만 달라진다**. 대신
  `gitWrite` 가 진행 상태를 들고, 한 번 응답한 뒤의 모든 단계가 무동작이 된다
  (`bufio.Writer`·`sql.Rows` 와 같은 방식). 핸들러에서 `if !ok { return }` 이
  **사라진다**.
- **FR-DPN-26** — 실행 전 status 는 `snapshot()` 이며 **멱등**이다. 핸들러가
  부르지 않으면 `apply` 가 부른다 — "실행 전 status 를 빼먹는" 경로가 없어야
  부분 적용 판정(FR-GIT-73)이 성립한다.
- **FR-DPN-27** — `before` 와 `after` 를 **두 필드로 가른다.** 하나에 담으면
  `apply` 뒤에 그 이름이 거짓이 되고, 부분 적용 판정이 무엇을 무엇과 비교하는지
  읽을 수 없다.

#### 3.2.2 잠재 결함 하나가 드러났다 — nil Git 역참조

- **FR-DPN-24** — `s.Git == nil` 검사를 **역참조가 실제로 일어나는 자리**
  (`gitResolveRepo`)로 내린다.

  | | |
  |---|---|
  | **이전 동작** | `panic: invalid memory address or nil pointer dereference` |
  | **새 동작** | `503 git_unavailable` |
  | **이유** | 검사가 호출자 22곳에 복제돼 있었고 **세 곳이 빠져 있었다** — `apiGitWorktrees` · `apiGitWorktreeCreate` · `apiGitWorktreeRemove` 는 `UserWorktrees` 만 보고 `s.Git` 은 보지 않았다. `httpapi.New` 가 GitServer 를 **무조건** 만들므로(server.go:143) Git 없이 worktree 관리자만 있는 배선이 실재하고, 그때 이 세 종단이 죽었다 |

  **이것이 묶음 B 가 벌어들인 것이다.** 복제를 걷어내려고 검사를 세는 순간
  빠진 것이 드러났다 — 22곳에 흩어져 있는 동안에는 아무것도 그것을 알려주지
  않았다. 검사를 역참조 지점에 두면 빠질 자리 자체가 없다.

  `gitwrite_test.go:TestNilGitNeverPanics` 가 git 종단 23개 전부를 `Git == nil`
  로 찔러 그것을 못 박는다. `httpapi/server.go` 의 `git` 필드 주석도 함께
  고쳤다 — "Git 이 nil 이면 이 자리도 nil" 이라는 서술이 사실이 아니었다.

### 3.3 묶음 C — 프론트엔드 `gitFetch`

- **FR-DPN-30** — `web/js/git/api.js` 를 신설한다. `index.html` 에서 `git/panel.js`
  **앞**에 로드한다 (C3).
- **FR-DPN-31** — `gitFetch` 가 소유하는 것 넷:
  ① 쿼리 조립(`encodeURIComponent` 누락 불가) ② 망 실패·비 2xx·JSON 파싱 실패를
  `null` 하나로 접기 ③ staleness 판정 ④ `requested` echo 검증.
  호출자는 데이터 또는 `null` 만 받는다.
- **FR-DPN-32** — 현재 가드가 빠진 자리를 파이프라인이 구조적으로 메운다:

  | 파일 | fetch | isStale | echo 검증 |
  |---|---|---|---|
  | `core/app-git.js` | 6 | 0 | 0 |
  | `git/commit-ops.js` | 2 | 0 | 0 |
  | `git/confirm.js` | 1 | 0 | 0 |
  | `git/tag.js` | 1 | 0 | 1 |

  **이것은 정리가 아니라 버그 부류 하나의 제거다** — "늦게 온 다른 리포의 응답을
  자기 것으로 읽는" 경로.
- **FR-DPN-33** — echo 검증·staleness 는 **옵트인**이다. 그 개념이 없는 호출
  (전역 조회 `/api/git/repos` 등)에 토큰을 요구하면 호출자가 의미 없는 값을
  만들어 넣는다. 옵션을 주지 않은 호출은 ①②만 받는다.
- **FR-DPN-34** — `?v=` 와 `assets.lock` 을 함께 올린다 (C2).

### 3.4 묶음 D — `constants.js` 분할

- **FR-DPN-40** — `web/js/core/constants.js`(712 상수 / 1,586줄)를 셋으로 가른다:
  `constants.js`(공용) · `constants-git.js`(`GIT_*` 572) ·
  `constants-editor.js`(`EDITOR_*`·`ED_*`·`FS_*` 84).
- **FR-DPN-41** — 전역 스코프는 그대로다. `const` 선언을 **파일만 옮기고 내용은
  고치지 않는다** — 로드 순서를 지키면 동작이 바뀌지 않는다.
- **FR-DPN-42** — `index.html` 의 로드 순서: `constants.js` → `constants-git.js` →
  `constants-editor.js` → `helpers.js` → 나머지. 상수 사이에 상수를 참조하는
  선언이 있으면 그 참조가 앞 파일에 있어야 한다 — 옮기기 전에 확인한다.
- **FR-DPN-43** — `web/embed.go` 의 `js/*/*.js` 패턴이 새 파일을 자동으로 덮는다.
  변경 불필요. `?v=` 와 `assets.lock` 은 올린다 (C2).

### 3.5 묶음 E — `Deps` → `Server` 복사 제거

- **FR-DPN-50** — `Server` 가 `Deps` 를 임베딩한다. 14필드 재선언과 `New` 의
  한 줄씩 복사가 사라진다. 필드 추가가 **세 자리에서 한 자리로** 줄고, 빠뜨려서
  nil 이 되는 경로가 없어진다.
- **FR-DPN-51** — 기본값 주입(`Commands` nil → 새 허브, `Settings` nil →
  `newSettingsStore`)은 `New` 에 남는다. 그것이 `Deps` 가 통과 모듈이 아닌 이유다.
- **FR-DPN-52** — 테스트의 `&Server{Tools: m}` 15곳이
  `&Server{Deps: Deps{Tools: m}}` 로 바뀐다. **테스트 리터럴이 한 겹 길어지는 것이
  이 묶음의 대가다.** 필드 추가 지점이 셋에서 하나로 줄는 것과 교환한다.

### 3.6 묶음 F — `ctl/cli` 액션 테이블

- **FR-DPN-60** — `Dispatch` 의 8개 동형 case (`Parse* → settle → Run*`) 를 액션
  테이블로 옮긴다. 시그니처가 다른 둘(`RunStart` 은 `serve`, `RunWindow` 은
  `openFrameless` 를 받는다)은 클로저가 흡수한다.
- **FR-DPN-61** — 액션 이름·도움말·파서·실행기가 **한 줄에 함께** 있게 한다.
  지금은 `Dispatch`·`Help()`·`Usage()`·`UnknownAction()` 넷에 흩어져 있어 액션
  하나를 더할 때 네 자리를 고친다.
- **FR-DPN-62** — `Help()` 의 액션 목록을 **표에서 생성한다.** 손으로 적으면
  액션을 더하고 목록을 빼먹었을 때 그 액션은 존재를 알릴 방법이 없어지고,
  컴파일러가 그것을 잡아 주지 않는다. `Usage(name)` 도 표를 조회한다 — 표에
  없는 이름은 전체 도움말로 떨어진다(기존 동작 유지).
- **FR-DPN-63** — 출력은 **바이트 단위로 같아야 한다.** `Help()`·`Usage()`×9·
  `UnknownAction()` 을 리팩터 전후로 덤프해 diff 로 확인한다 (§7.3).

### 3.7 비기능 요구 (Non-Functional)

- **NFR-DPN-1** — 관측 가능한 행위 변경은 FR-DPN-10 **하나뿐**이다. 그 외 모든
  묶음은 응답 본문·상태 코드·화면 동작이 동일하다.
- **NFR-DPN-2** — `apierr.Lookup` 은 요청당 최대 1회 호출되는 실패 경로에만 있다.
  선형 탐색(≈50 항목)이 충분하다 — 맵으로 만들면 `errors.Is` 의 wrapping 판정을
  잃는다.
- **NFR-DPN-3** — 커버리지가 묶음 전후로 떨어지지 않는다.
- **NFR-DPN-4** — `go build ./...` · `go vet ./...` · `go test ./...` 가 각 묶음
  종료 시점에 통과한다. 묶음 사이에 깨진 상태를 남기지 않는다.

---

## 4. 검증 (Verification)

### 4.1 특성화 테스트 우선

- **V1** — 묶음 A 착수 **전에** `gitapi` 에 특성화 테스트를 넣는다: 현재 매핑된
  sentinel 전부에 대해 기존 번역기가 내는 (status, code) 를 표로 고정한다. 이
  테스트는 즉시 통과해야 한다 — 통과하지 않으면 §2.1 의 조사가 틀린 것이다.
- **V2** — 등록부로 갈아탄 뒤 **같은 표**가 그대로 통과한다. 표에서 유일하게 바뀌는
  줄이 FR-DPN-10 의 `core.ErrRefName` 이며, 그 줄은 이전 값을 주석으로 남긴다.
- **V3** — `writeRunError` · `fsStatus` 도 같은 방식으로 먼저 고정한다.

### 4.2 전수성 테스트

- **V4** — 인벤토리 ∖ (등록부 ∪ unmapped) = ∅ 을 검사한다. 새 sentinel 이 생기면
  실패한다.
- **V5** — 등록부 ∖ 인벤토리 = ∅ 을 검사한다. 지워진 sentinel 의 규칙이 남지 않는다.
- **V6** — 와이어 코드 상수에 중복 값이 없음을 검사한다. 같은 문자열이 두 이름으로
  선언되면 실패한다.

### 4.3 묶음별 회귀

- **V7** — 묶음 B: `gitapi` 기존 테스트 전부(커버리지 79%) 통과. 파이프라인에
  들어간 핸들러 수와 남긴 핸들러 수를 이 문서에 기록한다.
- **V8** — 묶음 C: e2e git 스펙 통과. 그리고 §3.3 표의 빈칸 넷이 채워졌음을
  `gitFetch` 미사용 `fetch('/api/git` 잔존 수 0 으로 확인한다.
- **V9** — 묶음 D: `web/version_test.go` 통과(`?v=`·`assets.lock` 갱신 확인).
  분할 전후 `grep -c '^const '` 합이 712 로 동일함을 확인한다.
- **V10** — 묶음 E·F: `go test ./internal/webserver/httpapi/ ./internal/ctl/cli/`
  통과.
- **V11** — 전체: `go build ./...` · `go vet ./...` · `go test ./...` ·
  `scripts/check-seams.sh` · `scripts/check-cross.sh` 통과.

---

## 5. 비목표 (Non-Goals)

- **N1** — **오류 본문 모양의 통일.** 방언 넷은 각각 브라우저가 소비하는 공개
  계약이다 (§2.2). 통일은 리팩터가 아니라 파괴적 변경이며 프론트엔드 동시 개정을
  요구한다.
- **N2** — **매핑 없는 sentinel 11개에 코드 부여.** 와이어 계약의 확장이므로 별도
  결정이다. 이 SRS 는 그 빈칸을 **가시화**하는 것까지만 한다 (FR-DPN-9).
- **N3** — **프로세스 축 레이아웃 변경.** `PACKAGE_RESTRUCTURE_SRS` 의 결정이며
  재론하지 않는다. `apierr` 는 그 축 안의 웹 서버 패키지다.
- **N4** — **프론트엔드 번들러 도입.** 로드 순서가 곧 의존성이라는 제약을 유지한다
  (C3). 묶음 C·D 는 그 제약 안에서 이뤄진다.
- **N5** — **`Object.assign(App.prototype, …)` 확장 방식 변경.** 모듈 시스템 없이
  클래스를 파일로 가르는 유일한 무동작변경 경로다.
- **N6** — **`git/panel.js`(2,837줄)·`ui/file-tree.js`(1,169줄) 분할.** 큰 파일이지만
  얕음의 증거를 찾지 못했다. 크기만으로 가르면 이해가 파일 사이를 튀는 비용만
  늘어난다.
- **N7** — **domain 패키지의 sentinel 이름·문자열 변경.** 등록부가 코드를 소유하되
  sentinel 자체는 건드리지 않는다.

---

## 6. 실행 순서와 리스크

| 순서 | 묶음 | 리스크 | 선행 이유 |
|---|---|---|---|
| 1 | A (등록부) | MEDIUM | B 의 오류 경로를 먼저 정리한다 |
| 2 | B (쓰기 파이프라인) | MEDIUM | A 가 끝나야 파이프라인의 오류 렌더러가 확정된다 |
| 3 | C (프론트 `gitFetch`) | MEDIUM | B 가 끝나야 서버 쪽 echo 계약이 확정된다 |
| 4 | D (constants 분할) | LOW | 독립 |
| 5 | E (Deps 임베딩) | LOW | 독립 |
| 6 | F (cli 테이블) | LOW | 독립 |

**MEDIUM 셋의 공통 완화책**: 특성화 테스트 우선(§4.1) — 리팩터 전에 현재 행위를
표로 고정하고, 표가 그대로 통과하는 것으로 무동작변경을 증명한다.

E·F 는 이득이 비용을 크게 넘지 않는다고 분석에서 판단했으나(테스트 리터럴이
길어지고, 시그니처가 다른 두 액션이 테이블 이득을 절반으로 깎는다) 사용자 결정으로
범위에 포함한다.

---

## 7. 실행 결과 (Outcome)

### 7.1 측정

| | 이전 | 이후 |
|---|---|---|
| `gitapi` 프로덕션 | 5,063줄 | 4,618줄 (**−445**) |
| `gitapi` 커버리지 | 79.0% | **85.3%** |
| `httpapi` 커버리지 | 80.0% | 80.0% |
| `apierr` 커버리지 | — | **100%** |
| 오류 번역기 | 17개 | **4개** (전부 문맥 의존) |
| `constants.js` | 1,586줄 / 712 상수 | 172 + 1,236 + 202줄 |
| 프론트 원시 `fetch('/api/git` | 22곳 | **1곳** (status 폴링) |

`gitapi` 사다리 반복:

| 패턴 | 이전 | 이후 |
|---|---|---|
| `if s.Git == nil` | 64 | 11 |
| `gitDecodeBody(w, r,` | 39 | 3 |
| `s.gitResolveRepo(w, r,` | 42 | 8 |
| `s.gitStatusBefore(w, r,` | 30 | 6 |
| `s.gitApply(w, r,` | 23 | 3 |
| `gitWriteOK(w,` | 27 | 3 |

### 7.2 파이프라인에 들어간 것과 남긴 것 (V7)

**들어간 것 (19 + 전문 14).** 표준형 쓰기 19개가 `beginWrite → … → ok` 로
전환됐고, job·stash 경로 14개는 **전문만** 공유한다 (nil 검사 + 디코드 + confirm
+ repo 해석). 뒤는 각자의 종단(`gitStartJob`·`gitStashApply`)으로 간다.

**남긴 것과 사유** (FR-DPN-22 — 억지로 밀어 넣지 않는다):

| 자리 | 사유 |
|---|---|
| `apiGitStatus` 등 읽기 20개 | 쓰기가 아니다. `gitRepoParam` 이 이미 그 전문을 소유한다 |
| `panel.js` status 폴링 (프론트) | `_applyStatus(tok, r, d)` 가 **원시 응답 객체**를 요구한다 — 상태 코드로 갈리는 분기가 본문 밖에 있다 |
| `gitCommitOpError` | 부모 목록이 응답에 실려야 한다 (오류값 밖의 데이터) |
| `gitStashErrorCode` | stash 잔존 여부를 `extra` 가 안다 (오류값 밖의 데이터) |
| `gitPushError` | Publish 계획이 응답에 실려야 한다 |
| `apiGitCommitCreate` 의 preflight | 검사 결과 전문이 응답에 실려야 한다 |
| `apiGitOperation` 의 불일치 판정 | `status` 를 함께 실어야 하고 코드가 둘로 갈린다 |

### 7.3 무동작변경의 증명

| 묶음 | 증명 |
|---|---|
| A | `apierr/git_table_test.go` — 리팩터 **전** 번역기 17개가 내던 (status, code) 를 전수 표로 고정. 통과. 유일하게 바뀐 줄이 FR-DPN-10 이며 그 줄에 이전 값을 주석으로 남겼다 |
| B | `gitapi` 기존 테스트 전부 통과 (커버리지 79.0 → 85.3%). 응답 본문·상태 코드가 달라진 핸들러 없음 |
| C·D | e2e git·editor 263개 통과 |
| D | **상수 715개의 값을 node 로 실행해 전수 비교** — 원본과 분할본이 동일 |
| F | `Help()`·`Usage()`×9·`UnknownAction()` 출력을 **바이트 단위로 비교** — 동일 |

### 7.4 의도한 행위 변경 셋

이 리팩터가 바꾼 관측 가능한 행위는 셋뿐이다.

| | 이전 | 새 | 이유 |
|---|---|---|---|
| **FR-DPN-10** `core.ErrRefName` | `branch`·`tag` 는 `ref_name_invalid`, `commit_ops` 는 `bad_request` (둘 다 400) | 전부 `ref_name_invalid` | 같은 sentinel 이 두 코드로 갈린 것은 복제의 드리프트. 상태는 그대로이고 코드만 구체적이 된다 |
| **FR-DPN-13** 미분류 sentinel | 번역기가 모르는 sentinel → 500 | 테이블에 있으면 그 코드 | 500 을 옳은 4xx 로 **좁히는 방향뿐**. 이미 있던 4xx 는 바뀌지 않는다 (§7.3 A 의 표가 증거) |
| **FR-DPN-24** nil Git | `panic: nil pointer dereference` (worktree 종단 3개) | `503 git_unavailable` | 검사가 22곳에 복제돼 세 곳이 빠져 있었다 |

### 7.5 남은 것 — 별도 결정이 필요하다

- **매핑 없는 sentinel 11개** (비목표 N2). `apierr/inventory.go` 의 `Unmapped` 에
  **사유와 함께** 기록해 가시화했다. 사유가 둘로 갈린다:
  ① 문맥 의존이라 제자리에 남긴 것 1개 (`write.ErrMergeParent`)
  ② HTTP 까지 도달하지 못하거나, 도달하면 서버 결함이라 500 이 옳은 것 10개
  전수성 테스트가 새 sentinel 을 막으므로 **이제 조용히 500 이 되는 경로가 없다.**
- **`git/panel.js`(2,837줄)·`ui/file-tree.js`(1,169줄)** (비목표 N6). 크지만 얕음의
  증거를 못 찾았다.

- **`diag_snapshot_test.go` 의 데이터 경쟁** — 이 리팩터와 **무관한 기존 결함**이다.
  검증 중 `go test -race` 로 드러났고, `git archive HEAD` 로 뜬 기준선에서도
  같은 실패가 재현된다.

  ```
  TestDiagSnapshotLoopWritesPeriodically
    goroutine A: bytes.Buffer.String()   (diag_snapshot_test.go:143)
    goroutine B: log.Printf → Buffer.Write (diag_snapshot.go:54)
  ```

  테스트가 로그 버퍼를 잠금 없이 읽는다. 프로덕션 코드의 문제가 아니라 테스트
  하네스의 문제이며, `-race` 없이는 통과한다. 고치는 것은 이 SRS 의 범위 밖이라
  손대지 않았다 — 별도 결정이 필요하다.

  나머지 전부는 `-race` 로 통과한다 (`apierr`·`gitapi`·`ctl/cli`·`httpapi`,
  위 테스트 제외).
