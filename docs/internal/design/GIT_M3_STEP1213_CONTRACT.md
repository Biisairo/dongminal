# 설계 계약 — M3 12·13단계 원격 작업 (묶음 K, FR-GIT-98~112)

GIT_SRS.md §3B 다. 검증은 V40·V41·V42·V43·V44·V62·V63.
전제: M2 (9~11단계) 가 끝나 있다 — 원격 작업은 M2 의 안전 정책 위에 얹힌다.

## 0. 열린 결정 확정 (M3 해당분)

| # | 결정 | 값 | 근거 |
|---|---|---|---|
| O9 | 원격 작업 타임아웃 | **취소 가능 + 상한 10분** (`RemoteOpCeiling`) | "없음" 은 사용자가 브라우저를 닫으면 고아 프로세스가 영구히 남게 한다. 상한은 정상 작업을 방해하지 않을 만큼 넉넉히 두고, 실질 종료 수단은 취소다 |
| O10 | 인증 필요 감지 | **`GIT_TERMINAL_PROMPT=0` 강제** (1단계 `gitEnv` 에 이미 있다) + stderr 패턴 보조 | 프롬프트를 원리적으로 막는 쪽이 확정적이다. 매달리지 않고 즉시 실패하므로 감지가 실패 처리와 같아진다 |

`GIT_ASKPASS` 와 `SSH_ASKPASS` 도 빈 값으로 강제한다 — `GIT_TERMINAL_PROMPT=0`
만으로는 askpass 헬퍼가 GUI 프롬프트를 띄울 수 있다. `SSH_ASKPASS_REQUIRE=never`
를 함께 둔다.

## 1. 12단계 — 작업(job) 인프라 (FR-GIT-101~103, 검증 V42)

원격 작업은 다른 git 실행과 성질이 다르다: 초 단위가 아니라 분 단위이고, 출력이
진행 상황이며, 취소할 수 있어야 한다. 그래서 `Exec`/`ExecWrite` 와 별도 경로다.

```go
// internal/git/job.go

// Job 은 진행 중인 장기 실행 git 이다. **원격 작업만 이 경로를 탄다** — 짧은
// 명령을 여기에 태우면 취소·스트리밍 기계장치가 값어치 없이 붙는다.
type Job struct {
    ID       string `json:"id"`
    Repo     string `json:"repo"`
    Kind     string `json:"kind"`     // fetch | pull | push
    Argv     []string `json:"argv"`
    Started  int64  `json:"startedUnixMs"`
    Done     bool   `json:"done"`
    ExitCode int    `json:"exitCode"`
    Err      string `json:"err,omitempty"`
    Canceled bool   `json:"canceled"`
}

// Line 은 작업 출력 한 줄이다. git 은 진행 상황을 stderr 로 낸다 — 그것이 오류가
// 아니라 진행이므로 스트림에서 구분해 보낸다.
type Line struct {
    Seq    uint64 `json:"seq"`
    Stream string `json:"stream"` // stdout | stderr
    Text   string `json:"text"`
}

// Jobs 는 리포별로 **동시에 하나만** 허용한다 (FR-GIT-101).
type Jobs struct { /* 비공개 */ }

func NewJobs(svc *Service, opts ...JobsOption) *Jobs
func WithCeiling(d time.Duration) JobsOption

// Start 는 작업을 띄운다. 같은 리포에 진행 중인 작업이 있으면 ErrJobBusy 다.
func (j *Jobs) Start(repo string, kind string, spec WriteSpec) (*Job, error)
// Cancel 은 프로세스를 끝낸다. 부분 적용 가능성은 호출자가 사용자에게 알린다.
func (j *Jobs) Cancel(id string) bool
func (j *Jobs) Get(id string) (*Job, bool)
// Subscribe 는 seq 이후의 줄을 받는 채널을 준다. 작업이 끝나면 닫힌다.
func (j *Jobs) Subscribe(id string, afterSeq uint64) (<-chan Line, func(), bool)
// Active 는 진행 중인 작업 전부다. 상태바가 읽는다 (FR-GIT-112).
func (j *Jobs) Active() []*Job
```

```go
const (
    RemoteOpCeiling = 10 * time.Minute // O9
    JobLineCap      = 2000             // 보존 줄 수 상한. 초과분은 앞에서 버린다
    JobRetention    = 5 * time.Minute  // 끝난 작업을 이만큼 들고 있는다
)
```

- 출력은 줄 단위로 읽는다 (`bufio.Scanner` 로는 `\r` 진행 갱신을 놓친다 —
  git 의 진행 표시는 `\r` 로 같은 줄을 덮는다. **`\r` 과 `\n` 모두를 구분자로
  다루는 스플리터를 쓴다.**)
- 취소는 `cmd.Cancel` 또는 `Process.Signal(SIGTERM)` → 유예 후 `SIGKILL`.
  프로세스 그룹으로 죽여야 `git` 이 띄운 `ssh`·`git-remote-https` 도 같이 끝난다:
  `SysProcAttr{Setpgid:true}` 로 띄우고 `syscall.Kill(-pgid, …)`.
- 끝난 작업은 `JobRetention` 동안 조회 가능하다. 그 뒤 지운다.
- **자격증명은 어디에도 남지 않는다 (FR-GIT-104, 검증 V43).** 작업의 argv·출력
  줄에 URL 이 담길 수 있고 URL 에는 토큰이 박힐 수 있다. `sanitizeRemote` 로
  `scheme://user:pass@host` 의 `user:pass` 를 `***` 로 바꿔 **저장 전에** 지운다.
  기록(`Record`)·응답·SSE 전부에 적용한다.

### 1.1 라우트

| 메서드 | 경로 | 용도 |
|---|---|---|
| POST | `/api/git/job/cancel` | `{"id":"…"}` → `{"ok":true,"canceled":true}` |
| GET | `/api/git/job/events?id=…&after=<seq>` | SSE. `line` 이벤트와 `done` 이벤트 |
| GET | `/api/git/jobs` | 진행 중 작업 목록 (상태바용, FR-GIT-112) |

SSE 는 기존 `/api/commands/sse` 의 구현 패턴을 따른다. **새 브로커를 만들기 전에
`internal/server/commands.go` 의 `CommandHub` 를 먼저 보라.**

## 2. 13단계 — Fetch / Pull / Push (FR-GIT-98~112)

### 2.1 명령

| 동작 | argv | 파괴적 |
|---|---|---|
| Fetch (기본) | `fetch --progress` | ✗ |
| Fetch (옵션) | `fetch --progress [--prune] [--tags\|--no-tags]` | ✗ |
| Pull (기본) | `pull --progress` | ✗ |
| Pull (옵션) | `pull --progress [--rebase\|--ff-only\|--no-ff]` | ✗ |
| Push (기본) | `push --progress` | ✗ |
| Publish (upstream 없음) | `push --progress -u <remote> <branch>` | ✗ |
| Push (force-with-lease) | `push --progress --force-with-lease` | **○** |
| Push (force) | `push --progress --force` | **○** |

- **FR-GIT-99**: 버튼은 기본 동작만 한다. 변형은 다이얼로그에서만 온다.
- **FR-GIT-100**: upstream 이 없으면 Push 는 Publish 다. `-u` 로 upstream 을
  설정하고 **그 사실을 사용자에게 알린다** (실행 전 1단계 확인).
  remote 는 `git remote` 가 하나면 그것, 여럿이면 `origin`, 없으면 오류.
- **FR-GIT-106**: force 는 `--force-with-lease` 가 기본이다. `--force` 는 별도의
  2단계 확인을 거친다 (9단계의 `GitConfirm`, `DestructiveActions` 에 `force_push`).
- **FR-GIT-105**: push 가 non-fast-forward 로 거부되면(`stderr` 에
  `non-fast-forward` / `rejected`) 사유와 **fetch 후 rebase/merge** 를 제시한다.
  **force 를 기본 제안하지 않는다.** 선택지 목록에서 force 는 마지막이고 강조하지
  않는다.

### 2.2 라우트

| 메서드 | 경로 | 본문 |
|---|---|---|
| POST | `/api/git/fetch` | `{"repo":"…","prune":false,"tags":null}` |
| POST | `/api/git/pull` | `{"repo":"…","mode":""}` — `""`\|`rebase`\|`ff-only`\|`no-ff` |
| POST | `/api/git/push` | `{"repo":"…","publish":false,"force":""}` — `""`\|`lease`\|`force`, `force:"force"` 는 `confirm:true` 필수 |

응답: `{"requested":"…","repo":"…","job":{…}}` — 작업 식별자를 즉시 준다 (FR-GIT-102).
`ErrJobBusy` → 409 `job_busy` (FR-GIT-101).

작업 완료 후 서버가 status 캐시를 무효화한다 — ahead/behind 가 즉시 갱신돼야 한다
(FR-GIT-107).

### 2.3 인증 (FR-GIT-104, 검증 V43)

- **자격증명을 받는 필드가 API 에 없다.** 요청 본문에 사용자명·비밀번호·토큰을
  담을 자리를 만들지 않는다.
- `GIT_TERMINAL_PROMPT=0` 이므로 인증이 필요하면 git 이 즉시 실패한다.
  stderr 에 `could not read Username`·`Authentication failed`·
  `Permission denied (publickey)`·`terminal prompts disabled` 가 있으면
  `authRequired: true` 를 응답에 담고, **터미널에서 수행하라**고 안내한다
  (`git push` 를 터미널 탭에서 실행하도록 — 복사 가능한 명령을 준다).
- 정적 검증: `internal/git`·`internal/server` 에 `password`·`token`·`passphrase`
  를 담는 필드·파라미터가 없음을 테스트로 고정한다.

### 2.3.1 서버가 확정한 계약 2건 (구현 중 추가 — 클라이언트는 이것을 따른다)

**① Publish 는 실행 전에 서버가 한 번 되묻는다** (FR-GIT-100 의 "그 사실을
사용자에게 알린다"를 서버측에서 강제한다).

upstream 이 없는 브랜치에 `POST /api/git/push {"repo":…}` 를 보내면 실행하지 않고
**409 `publish_required`** 와 계획을 준다:

```json
{"error":"publish_required",
 "plan":{"publish":true,"remote":"origin","branch":"no-upstream"}}
```

실행하려면 `{"repo":…,"publish":true}` 로 다시 보낸다. 클라이언트만 알리게 두면
`dmctl git push` 가 upstream 을 조용히 만든다. `confirm` 은 `--force` 전용이며
별개 필드다.

**② 실패 정보는 즉시 응답이 아니라 `done` 이벤트의 job 에 있다.**
작업이 아직 끝나지 않았으므로 즉시 응답의 job 에는 있을 수 없다.

| 필드 | 뜻 | FR |
|---|---|---|
| `authRequired` | 인증이 필요해 실패했다 — 터미널에서 수행하도록 안내한다 | 104 |
| `rejected` + `options` | push 가 거부됐다. `["fetch_rebase","fetch_merge","force_with_lease"]` — **순서가 우선순위이고 force 가 마지막이다** | 105 |
| `stderrTail` | 실패 사유의 마지막 N줄 | 108 |

`options` 를 화면에 그릴 때 **순서를 바꾸거나 force 를 강조하지 마라** —
FR-GIT-105 가 "force 를 기본 제안하지 않는다" 로 요구하는 것이 이 순서다.

SSE 형식:

```
event: line
data: {"seq":1,"stream":"stderr","text":"Enumerating objects: 5, done."}
...
event: done
data: {job}
```

재연결은 `GET /api/git/job/events?id=<id>&after=<seq>` 다.

### 2.4 클라이언트

- Changes 탭 헤더의 Fetch/Pull/Push 버튼을 살린다 (5단계가 자리를 만들어 뒀다).
- 각 버튼 옆 `▾` 로 다이얼로그를 연다 (FR-GIT-109·110).
- 진행 중: 버튼이 스피너로 바뀌고 같은 리포의 다른 원격 버튼도 disable 된다
  (FR-GIT-101). `취소` 버튼이 나타난다.
- 출력은 `.git-job-log` 에 줄 단위로 붙인다 (FR-GIT-103). SSE 로 받는다.
- 실패: stderr tail 과 복사 버튼 (FR-GIT-108·96). non-fast-forward 면 선택지를
  보인다 (FR-GIT-105).
- **상태바 (FR-GIT-112)**: 진행 중 작업이 있으면 chip 옆에 `⇅ push…` 를 보인다.
  `/api/git/jobs` 를 상태바 폴링에 얹는다.
- Pull 충돌 (FR-GIT-111): 작업이 충돌로 끝나면 Changes 탭으로 전환하고 충돌 그룹을
  펼친다. **해결 UI 는 제공하지 않는다.**
- 취소는 부분 적용 가능성을 알린다 (FR-GIT-102) — 확인 문구에 명시.

## 3. 테스트

`internal/git`:

| # | 검증 | 내용 |
|---|---|---|
| R1 | V42 | 취소가 프로세스를 실제로 끝낸다 (긴 스크립트를 Runner 로 대체) |
| R2 | V42 | `\r` 로 갱신되는 진행 줄이 개별 `Line` 으로 도착한다 |
| R3 | V40 | 같은 리포의 두 번째 `Start` 가 `ErrJobBusy` |
| R4 | — | 다른 리포의 작업은 서로를 막지 않는다 |
| R5 | V43 | `sanitizeRemote` 가 `https://u:p@host` 의 자격증명을 지운다 (argv·줄·기록 전부) |
| R6 | V41 | upstream 없는 브랜치의 push 가 `-u <remote> <branch>` 를 만든다 |
| R7 | V44 | force 기본이 `--force-with-lease` 다. `--force` 는 명시할 때만 |
| R8 | O9 | 상한을 넘긴 작업이 종료되고 `Err` 에 사유가 남는다 |
| R9 | — | `JobLineCap` 초과 시 앞에서 버리고 `Seq` 는 단조 증가 |
| R10 | V43 | 정적: 자격증명 필드 부재 |

`internal/server`: 라우트 형태·409 `job_busy`·SSE 재연결(`after=<seq>`)·
`confirm` 없는 `force:"force"` 거부.

e2e (로컬 bare remote 를 테스트가 `git init --bare` 로 만든다):

| # | 검증 | 내용 |
|---|---|---|
| R11 | V40 | fetch/pull/push 기본 동작이 성공하고 ahead/behind 가 갱신된다 |
| R12 | V40 | 진행 중 같은 리포의 다른 원격 버튼이 disable 된다 |
| R13 | V42 | 출력이 줄 단위로 화면에 도착한다 |
| R14 | V41 | upstream 없는 브랜치에서 Publish 임을 알리고 실행 후 upstream 이 설정된다 |
| R15 | V44 | non-fast-forward 거부 시 force 가 기본 제안이 아니다 |
| R16 | V63 | 진행 중 작업이 상태바에 보인다 |
| R17 | V62 | fetch/pull 다이얼로그 옵션이 argv 에 반영된다 |

## 4. 하지 않는 것

- 자격증명 저장·중계 — **의도적 배제.**
- 충돌 해결 UI — 범위 밖.
- remote 추가·삭제 — 범위 밖.
