# SRS: git 실행 층을 하나로 — 인가는 그대로 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

git 프로세스를 띄우는 자리가 저장소에 **다섯**이고, 다섯이 각자 환경·타임아웃·
출력 상한·취소·오류 분류·기록을 갖는다. 그 결과:

- `core.Env()` 를 쓰는 자리가 **다섯 중 둘**이다. 나머지 셋은 사람을 기다리는
  프롬프트·askpass·페이저·편집기를 막지 않은 채로 git 을 띄운다.
- **Console 과 Replay 가 그 셋의 실행을 못 본다.** 기록은 `core.Service` 를 지난
  것만 남는데(`exec.go:134`·`write.go:184`), 셋은 지나지 않는다.
- 출력 상한·취소·오류 분류가 자리마다 다르거나 없다.

이 SRS 는 **실행 층을 하나로 모은다.** 인가 층(명령 화이트리스트)은 **손대지
않는다** — 그 둘은 서로 다른 것이고, 지금까지 한 덩어리로 묶여 있었던 것이
"실행을 공유하려면 인가까지 통과해야 한다"는 막다른 길을 만들었다.

### 1.2 범위 (Scope)

**층을 가른다.** `core.Service` 가 지금 한 덩어리로 갖고 있는 두 가지를 나눈다.

```
        ┌─ Exec / ExecWrite      ← 인가 층: readCommands·writeCommands. 변경 없음
core ───┤
        └─ ExecUnguarded         ← 실행 층: Env·타임아웃·상한·취소·분류·기록
                 ↑
                 └── domain/worktree · domain/submodule · httpapi/checkIgnore
                     (각자 자기 인가를 거친 뒤 이것으로 실행한다)
```

| # | 대상 | 내용 |
|---|---|---|
| R1 | `core` | `ExecUnguarded` 신설. `execGit` 의 몸통을 인가 없이 여는 진입점 |
| R2 | `core.Record` | 인가를 지나지 않은 실행임을 표식으로 남긴다 |
| R3 | `worktree/worktree.go:159 execGit` | 본문을 `ExecUnguarded` 호출로 교체. **시그니처·다듬기·오류 형식은 그대로** |
| R4 | `submodule/submodule.go:268 ExecGit` | 같음. `FR-SUB-2` 선행 공백 규약 유지 |
| R5 | `httpapi/handlers_fs_ignored.go:91 checkIgnore` | 같음 |
| R6 | `core/static_test.go` 게이트 | 판정 기준을 **바이너리 획득 자리**로 넓히고, `ExecUnguarded` 호출처를 화이트리스트로 고정한다 |
| R7 | 배선 | `core.Service` 를 세 자리에 주입 |

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **실행 층** | git 프로세스를 **어떻게** 띄우는가 — 환경·마감·출력 상한·취소·오류 분류·기록. 정책이 아니라 메커니즘이다 |
| **인가 층** | **무엇을** 실행해도 되는가 — `readCommands`/`writeCommands` 와 그 guard |
| **도메인 인가** | `domain/worktree`·`domain/submodule` 이 자체로 갖는 검사 — `checkRepo`·`checkPath`·`validRef`·`--` 규약 |
| **바이너리 획득 자리** | `exec.LookPath("git")` 호출 지점. git 을 띄우려면 반드시 지난다 |
| **게이트 사각** | 규약을 어긴 코드가 검사에 걸리지 않고 통과하는 형태 |

### 1.4 참고 (References)

- `GIT_SRS.md` `FR-GIT-1`(단일 실행 지점) · `FR-GIT-5`(실행 기록) · `FR-GIT-104`(자격증명 배제)
- `GIT_REVIEW4_SRS.md` `FR-GIT-246` / D12 — **화이트리스트를 넓히지 않는다**는 확정 결정
- `UX_BATCH5_SRS.md` §5 `D-9` — submodule 이 별도 도메인이 된 같은 근거
- `internal/webserver/domain/git/core/exec.go:143 execGit` — 실행 층의 몸통
- `internal/webserver/domain/git/core/static_test.go:20 execAllowed` — 고칠 게이트
- `production/00-INDEX.md` `GO-39`·`SEC-14` — 이 결함을 실측한 감사 항목

---

## 2. 전체 기술 (Overall Description)

### 2.1 실측 — 다섯 자리와 그 상태

| # | 자리 | `Env()` | 출력 상한 | 취소 | 오류 분류 | 기록 | 게이트 |
|---|---|---|---|---|---|---|---|
| 1 | `git/core/exec.go:145` | ✅ | ✅ | ✅ | ✅ | ✅ | 예외 `domain/git` |
| 2 | `git/jobs/job.go:485` | ✅ | 스트림 | ✅ 그룹 | ✅ | ✅ | 예외 `domain/git` |
| 3 | `worktree/worktree.go:160` | ❌ | ❌ | ❌ | ❌ | ❌ | 예외이나 **검사 자체가 안 됨** |
| 4 | `submodule/submodule.go:269` | ❌ | ❌ | ❌ | ❌ | ❌ | **예외 목록에 없는데 통과** |
| 5 | `httpapi/handlers_fs_ignored.go:92` | ❌ | ❌ | ✅ | ❌ | ❌ | **초크포인트 밖인데 통과** |

다섯 전부 `bin, _ := exec.LookPath("git")` 뒤에 `exec.CommandContext(ctx, bin, …)`
를 부른다. 게이트의 정규식은 **인자 자리의 리터럴 `"git"`** 을 찾으므로 다섯 중
하나도 잡지 못한다. 1·2 가 규약을 지키는 것은 게이트가 강제해서가 아니라 그 자리를
쓴 사람이 알아서 지킨 것이다.

### 2.2 게이트가 변수 호출을 안 잡는 것은 의도였다

`static_test.go:TestDirectExecPatternMatches` 의 `miss` 표본에

```
cmd := exec.Command(bin, args...)
cmd := exec.CommandContext(ctx, bin, args...)
```

가 **"오탐이면 안 되는 것"** 으로 박혀 있다. 옳은 판단이다 — 이 저장소의 `bin` 은
`rg`(`handlers_fs_search.go:220`)·`docker`(`sandbox.go:327`)이기도 하다.

**그래서 정규식을 넓히지 않는다. 기준을 바꾼다.** git 을 띄우려면 반드시
`LookPath("git")` 을 지나므로 그것을 세면 오탐 없이 다섯을 전부 잡는다.

### 2.3 왜 지금까지 이 길이 막혀 있었나 — 층의 혼동

`FR-GIT-246` 은 worktree 를 화이트리스트에 넣는 것을 기각했고 그 판단은 **지금도
옳다**. `git worktree` 는 한 하위 명령에 읽기(`list`)와 쓰기(`add`)를 함께 갖고,
화이트리스트는 `argv[0]` 으로 키잉되며, 두 목록의 교집합은 비어 있어야 한다
(`FR-GIT-95`). `submodule` 도 같다 (`D-9`).

**그러나 그 결정이 기각한 것은 인가 층이지 실행 층이 아니다.** D12 의 기각 사유
전문은 이렇다:

> 읽기만 `domain/git` 으로 빼면 `checkPath`·직렬화·잔여물 보고가 한쪽에만 있게 된다

즉 기각된 것은 **코드를 두 패키지로 가르는 것**이다. 이 SRS 는 코드를 옮기지
않는다 — `checkPath`·`repoLock`·잔여물 보고는 `domain/worktree` 에 한 줄도 움직이지
않고 남는다. 바뀌는 것은 그 패키지가 **프로세스를 띄우는 방법** 하나다.

`submoduleManager` 의 현재 주석이 이 혼동을 그대로 적고 있다 (`server.go:449`):

> **git 실행을 직접 든다** — domain/git 의 화이트리스트를 지나지 않는다.

"화이트리스트를 지나지 않는다"는 참이고 앞으로도 참이다. 그런데 그것이 "실행을
직접 든다"의 이유가 되지는 않는다. **둘은 다른 문장이다.**

### 2.4 왜 이것이 결함인가 — 자리마다 다른 사유

| 자리 | 빠져서 생기는 일 |
|---|---|
| `submodule` | `submodule update --init` 은 **원격에 닿는다.** private 서브모듈이면 `GIT_TERMINAL_PROMPT=0` 이 없어 자격증명 프롬프트가 뜨고, GUI askpass 면 **보이지 않는 창을 기다리며** `opTimeout`(180초)을 매단다 |
| `worktree` | 원격에 닿지 않는다 (`FR-GIT-247` 명시). 실익은 `GIT_OPTIONAL_LOCKS=0` — `status --porcelain`(`worktree.go:456`)이 `index.lock` 을 잡아 사용자의 터미널 git 과 경합한다. `LC_ALL=C` 도 없어 오류 문자열이 로케일에 흔들린다 |
| `checkIgnore` | `git check-ignore` 는 인덱스를 읽는다. 같은 경합이 성립하고, 이 경로는 **탐색기가 그리는 동안 반복 호출**된다 |
| 셋 전부 | 출력 상한이 없다. 거대한 출력이 그대로 메모리에 올라온다 |
| 셋 전부 | **Console 이 못 본다.** 사용자가 "무슨 git 이 돌았나"를 물을 때 답에 이것들이 빠져 있다 |

### 2.5 제약 (Constraints)

- **화이트리스트를 넓히지 않는다** (`FR-GIT-246`·`D-9`). `readCommands`·
  `writeCommands` 는 한 항목도 늘지 않는다
- **`FR-GIT-95` 를 개정하지 않는다.** 교집합은 지금처럼 비어 있다
- **`Env()` 의 내용을 바꾸지 않는다.** 붙이기만 한다 — 내용을 건드리면 이미
  쓰고 있는 두 자리의 동작이 바뀐다
- **세 함수의 시그니처를 바꾸지 않는다.** `worktree.execGit`·`submodule.ExecGit`·
  `checkIgnore` 는 지금 모양 그대로다. 호출부가 한 줄도 안 바뀐다
- `submodule.ExecGit` 의 **선행 공백 보존**(`FR-SUB-2`)과 `worktree.execGit` 의
  `TrimSpace` 를 각각 유지한다 — 두 규약은 다르고, 다른 채로 남는다
- 두 도메인의 `opTimeout`(각 180초)·`checkIgnoreTimeout` 을 바꾸지 않는다

---

## 3. 요구사항 (Specific Requirements)

### 3.1 실행 층

- **FR-GXU-1** `core` 는 인가를 지나지 않는 실행 진입점 `ExecUnguarded` 를 갖는다.
  `Exec`·`ExecWrite` 와 **같은 몸통**(`execGit`)을 쓰며, 다른 것은 guard 를 부르지
  않는다는 것뿐이다.

  ```go
  type UnguardedSpec struct {
      Argv    []string
      Stdin   string
      Timeout time.Duration // 0 이면 Service 기본
      Reason  string        // 왜 인가를 건너뛰는가. 기록에 남는다
  }
  func (s *Service) ExecUnguarded(ctx context.Context, dir string, spec UnguardedSpec) (Output, error)
  ```

  - `dir` 검사(절대 경로)는 **유지한다.** 그것은 인가가 아니라 실행의 전제다.
  - `Reason` 은 **비어 있을 수 없다.** 빈 값은 거부한다 — 이 진입점을 쓰는 이유를
    적지 않고 쓰는 것을 막는다.

- **FR-GXU-2** `ExecUnguarded` 는 `Exec` 과 **같은 실행 규약**을 적용한다:
  `Env()` · 출력 상한(`maxOutput`) · 마감 · 취소 · `ExecError` 로의 오류 분류 ·
  `ErrGitMissing`·`ErrRepoMissing` 판정.

- **FR-GXU-3** `spec.Timeout > 0` 이면 그것이 `Service` 의 기본 마감을 **대신한다.**
  호출자의 `ctx` 가 더 짧으면 여전히 `ctx` 가 이긴다 (`FR-GIT-3` 과 같은 규칙).
  - 세 도메인의 마감은 기본 30초보다 길다(180초·`checkIgnoreTimeout`). 이 필드가
    없으면 이관이 곧 **동작 변경**이 된다.

- **FR-GXU-4** `Service` 가 `nil` 이어도 안전하다. 기록만 생략하고 나머지 규약은
  그대로 적용한다.
  - `httpapi` 의 `s.Git` 은 nil 일 수 있는 배선이다(`deps.go:106` 주석). 그때
    `checkIgnore` 가 죽거나 규약 없이 실행되는 것은 둘 다 답이 아니다.

### 3.2 기록

- **FR-GXU-5** `Record` 는 인가를 지나지 않은 실행임을 표식으로 갖는다.

  ```go
  Unguarded bool   `json:"unguarded,omitempty"`
  Reason    string `json:"reason,omitempty"`
  ```

  - Console 이 그것을 구분해 보일 수 있어야 한다. 구분되지 않으면 "화이트리스트를
    지난 실행"과 아닌 것이 한 목록에서 섞이고, 그 목록을 근거로 삼는 판단이 틀린다.
  - **`Write` 필드는 `IsWriteCommand` 그대로다.** `worktree`·`submodule` 은
    `writeCommands` 에 없으므로 `false` 가 된다. 그 값이 뜻하는 것은 "쓰기가
    아니다"가 아니라 "**쓰기 목록에 없다**"이며, `Unguarded` 가 그 사실을 말한다.

- **FR-GXU-6** `Replay`(`write/replay.go:33`)는 `Unguarded` 기록을 **재실행하지
  않는다.** 인가를 지나지 않은 argv 를 재실행 경로로 돌리면 그 경로가 화이트리스트
  우회 수단이 된다.

### 3.3 호출 측

- **FR-GXU-7** `worktree.execGit`·`submodule.ExecGit`·`checkIgnore` 는 본문에서
  `exec.LookPath`·`exec.CommandContext` 를 걷어내고 `ExecUnguarded` 를 부른다.
  **시그니처·반환 형식·다듬기 규약·오류 문구는 그대로다.**

- **FR-GXU-8** `Output` 을 기존의 단일 문자열로 되돌릴 때 규칙은 **`Stdout` 다음
  `Stderr`** 다.
  - `CombinedOutput` 은 두 스트림을 **시간순으로 섞지만** 이 결합은 스트림별로
    모은다. 성공 경로의 파싱이 stdout 만 읽으므로 실질 차이는 실패 경로의 문구
    순서다 (§4 V8·V9 가 이것을 검사한다).
  - 다듬기는 **결합 뒤 각 도메인이** 한다 — worktree 는 `TrimSpace`, submodule 은
    `TrimRight`. 규칙이 다른 채로 남는 것이 `FR-SUB-2` 의 요구다.

- **FR-GXU-9** 각 도메인의 인가는 **자기 자리에 그대로 남는다** — `checkRepo`·
  `checkPath`·`validRef`·`--` 규약·`repoLock`. 이 SRS 는 그것들을 옮기거나 바꾸지
  않는다.

- **FR-GXU-10** 배선은 하나의 `*core.Service` 를 셋에 나눠 준다. 기록이 한 링에
  모여야 Console 이 전부를 본다.
  - `cmd/dongminal/main.go` 에서 `core.New()` 를 `worktree.New` **앞으로** 옮긴다
    (지금은 341행, worktree 는 327·333행).
  - `submoduleManager(git *store.Store)` 는 이미 `Store` 를 받으므로
    `git.Service()` 로 닿는다. **배선 변경이 한 줄이다.**

### 3.4 게이트

- **FR-GXU-11** `FR-GIT-1` 의 정적 게이트는 판정 기준에 **바이너리 획득 자리**
  (`exec.LookPath("git")`)를 더한다. 기존 리터럴 검사는 **그대로 둔다** — 둘은 서로
  다른 형태를 잡으며, 한쪽으로 다른 쪽을 대체하면 그 형태가 사각이 된다.
  - 변수 인자(`exec.Command(bin, …)`) 자체는 계속 잡지 않는다 (§2.2).

- **FR-GXU-12** `ExecUnguarded` 의 **호출처를 화이트리스트로 고정한다.**

    | 허용 | 사유 |
    |---|---|
    | `internal/webserver/domain/worktree` | `FR-GIT-246` — 읽기·쓰기가 한 하위 명령에 있어 화이트리스트에 넣을 수 없다 |
    | `internal/webserver/domain/submodule` | `UX_BATCH5_SRS` `D-9` — 같은 근거 |
    | `internal/webserver/httpapi/handlers_fs_ignored.go` | `check-ignore` 는 `readCommands` 에 없다. 넣으면 화이트리스트 확장이며 그것은 비목표다 (§5 N1) |

  - 앞의 둘은 **디렉터리**, 마지막은 **파일 하나**다. 파일로 좁히는 이유는 `httpapi`
    전체를 여는 것이 그 패키지의 다른 파일에 인가 우회를 허가하는 뜻이기 때문이다.
  - **이 게이트가 이 SRS 의 안전 장치 전부다.** `ExecUnguarded` 는 인가를 건너뛰는
    공개 메서드이므로, 누가 부를 수 있는지가 고정되지 않으면 화이트리스트가 뜻을
    잃는다.

- **FR-GXU-13** `execAllowed`(직접 실행 예외)는 **실제 예외 전부**를 담는다. 지금
  그 목록은 둘인데 통과하는 자리는 다섯이다 — 목록이 사실과 다르면 그것을 읽는
  사람이 틀린 그림을 얻는다. 이 SRS 를 마치면 `domain/git` **하나만** 남는다.

- **FR-GXU-14** 게이트는 **환경 규약을 함께 검사한다.** 바이너리 획득 자리를 가진
  파일은 `Env()` 를 지나야 한다.
  - `FR-GXU-7` 만 하면 **다음에 추가되는 여섯 번째 자리가 같은 방식으로 빠진다.**
    규약은 선언으로 지켜지지 않는다 (`check-seams.sh` 주석과 같은 근거).

- **FR-GXU-15** 게이트 실패 메시지는 **고치는 길을 말한다** — 파일·줄과, `Env()`
  를 붙일지 예외로 등록할지 중 무엇을 해야 하는지.

- **FR-GXU-16** 훑은 파일 수가 하한 미만이면 게이트는 **실패한다.** 기존 검사가
  이미 `scanned < 20` 으로 이 보호를 갖는다 — 탐색이 깨졌을 때 "위반 0건"은 통과가
  아니다.

### 3.5 비기능 (Non-functional)

- **NFR-GXU-1** 성공 판정은 **아무것도 달라지지 않는 것**이다. 의도된 동작 변경은
  둘뿐이다:
  1. 프롬프트에 매달리던 경로가 **즉시 실패한다** (지금은 180초 뒤 실패)
  2. 세 자리의 실행이 **Console 에 보인다**
- **NFR-GXU-2** 게이트는 `go test` 로 돈다 — 기존 `static_test.go` 와 같은 자리에
  두어 검사가 두 벌로 갈라지지 않게 한다.
- **NFR-GXU-3** git 바이너리를 얻는 자리가 `domain/git` **밖에 0** 이 된다
  (종전 셋: `worktree`·`submodule`·`checkIgnore`). 안쪽의 둘은 남는다 —
  `core/exec.go`(버퍼 실행)와 `jobs/job.go`(스트리밍, §5 N4). 이 사실을 게이트가
  지킨다.

---

## 4. 검증 (Verification)

| # | 대상 | 방법 | 통과 기준 |
|---|---|---|---|
| **V1** | FR-GXU-1·2 | 단위 | `ExecUnguarded` 가 `readCommands`·`writeCommands` 에 없는 `worktree list` 를 **실행한다**. 같은 argv 를 `Exec` 에 주면 `ErrWriteCommand` 로 거부된다 |
| **V2** | FR-GXU-1 | 단위 | `Reason` 이 비면 실행 없이 거부된다 |
| **V3** | FR-GXU-2 | 단위 | 세 자리가 띄운 프로세스의 환경에 `GIT_TERMINAL_PROMPT=0`·`GIT_OPTIONAL_LOCKS=0`·`LC_ALL=C` 가 있다 |
| **V4** | FR-GXU-3 | 단위 | `spec.Timeout=180s` 가 기본 30초를 대신한다. 더 짧은 `ctx` 는 여전히 이긴다 |
| **V5** | FR-GXU-4 | 단위 | `Service` 가 nil 이어도 실행되고 규약이 적용된다. 기록만 없다 |
| **V6** | FR-GXU-5 | 단위 | `worktree`·`submodule` 실행이 `Records(0)` 에 `Unguarded:true` 와 `Reason` 을 달고 나타난다 |
| **V7** | FR-GXU-6 | 단위 | `Unguarded` 기록을 `Replay` 에 주면 거부된다 |
| **V8** | FR-GXU-8 | 단위 | `TestExecGitKeepsLeadingSpace` 가 통과한다 — `submodule status` 의 **선행 공백이 살아 있다** (`FR-SUB-2`) |
| **V9** | FR-GXU-8 | 단위 | 실패 경로에서 stderr 내용이 반환 문자열에 **포함된다** — 지금 `CombinedOutput` 이 주던 진단이 사라지지 않는다 |
| **V10** | FR-GXU-9 | 단위 | 기존 `worktree`·`submodule` 테스트가 **그대로** 통과한다. `checkPath`·`repoLock`·잔여물 보고가 살아 있다 |
| **V11** | FR-GXU-11 | 단위 | 패턴이 `bin, err := exec.LookPath("git")` 를 잡는다. `LookPath("rg")`·`LookPath("docker")` 는 잡지 않는다 |
| **V12** | FR-GXU-12 | 단위 | 허용 목록 밖 파일이 `ExecUnguarded` 를 부르면 **걸린다** |
| **V13** | FR-GXU-13 | 단위 | 예외 목록의 항목이 **전부 실재하는 경로**다. 없는 경로가 남아 있으면 실패한다 (죽은 예외 방지) |
| **V14** | FR-GXU-14 | 단위 | `Env()` 를 뗀 표본이 게이트에 **걸린다.** 걸리지 않으면 게이트가 무의미하다 |
| **V15** | NFR-GXU-1 | — | **자동화하지 않았다.** 자격증명을 요구하는 원격이 필요해 결정론적이지 않고, 네트워크에 의존한다. V3 이 근거를 대신한다 — `core.Env()` 가 실제 프로세스에 걸린 것이 확인되면 `GIT_TERMINAL_PROMPT=0`·`GIT_ASKPASS=` 도 함께 걸린 것이다 (한 덩어리이므로, §5 N3) |
| **V16** | NFR-GXU-3 | 단위 | 저장소 전체에서 `LookPath("git")` 가 **`domain/git` 안에만** 있다 |
| **V17** | 회귀 | 기존 | `TestNoDirectGitExecOutsidePackage`·`TestDirectExecPatternMatches`·`W2`·`V158` 이 통과한다 |
| **V18** | 회귀 | 기존 | `readCommands`·`writeCommands` 의 **항목 수가 변하지 않았다** |

**RED 를 먼저 본다.** V1·V3·V6·V12·V14·V16 은 구현 전에 실패해야 한다. 실패하지
않는 검사는 아무것도 검사하지 않는 것이다.

### 4.1 게이트 셋의 유효성 — 실제로 잡는 것을 확인했다

정적 검사는 **위반이 없을 때도 통과한다.** 그러므로 "통과했다"는 그 검사가
동작한다는 증거가 아니다 — 이 저장소가 정확히 그 함정에 빠져 있었다 (기존 게이트가
다섯 자리를 하나도 못 보면서 계속 초록이었다).

임시 탐침 파일(`httpapi/zz_gate_probe.go`)에 세 위반을 심어 셋이 **전부 잡는 것**을
확인하고 제거했다:

| 심은 위반 | 잡은 검사 |
|---|---|
| `domain/git` 밖의 `exec.LookPath("git")` | `TestGitBinaryLookupIsConfinedToDomain` |
| 허용되지 않은 자리의 `ExecUnguarded` 호출 | `TestExecUnguardedCallersAreConfined` |
| `Env()` 없이 git 을 띄우는 파일 | `TestGitExecSitesPassEnvContract` |

세 메시지 모두 파일·줄과 **고치는 두 길**(실행 층을 쓰거나 호출처로 등록하거나)을
함께 냈다 (FR-GXU-15).

---

## 5. 비목표 (Non-goals)

- **N1. 명령 화이트리스트를 넓히지 않는다. `FR-GIT-95` 를 개정하지 않는다.**
  - `FR-GIT-246` 이 확정했고 그 판단은 지금도 옳다 (§2.3). `readCommands`·
    `writeCommands` 는 **한 항목도 늘지 않으며** V18 이 그것을 검사한다.
  - 이 SRS 가 여는 것은 실행 층이지 인가 층이 아니다. `worktree remove` 는 여전히
    `Exec` 로 나갈 수 없다.

- **N2. 코드를 옮기지 않는다.** `checkPath`·`repoLock`·잔여물 보고·`validRef` 는
  `domain/worktree` 에, 상태 파싱은 `domain/submodule` 에 그대로 있다. D12 가
  기각한 것이 바로 이 이동이다.

- **N3. `Env()` 의 내용을 손대지 않는다.** 자리마다 필요한 축을 따져 다른 집합을
  주지 않는다 — 그러면 "어느 자리가 무엇을 쓰는지"가 다시 자리마다의 판단이 되고,
  이 SRS 가 없애려는 것이 정확히 그것이다.

- **N4. `jobs/job.go:485` 를 `ExecUnguarded` 로 바꾸지 않는다.** 그 자리는
  **스트리밍**이다 — `os.Pipe`·프로세스 그룹·`WaitDelay` 로 취소를 다루며
  (`FR-GIT-102`), 버퍼에 모아 돌려주는 `execGit` 과 다른 것을 한다. 이미 `Env()`
  와 기록을 지나고 있다.

- **N5. 다른 바이너리(`rg`·`docker`)의 실행 규약을 만들지 않는다.** 이 SRS 는 git
  하나를 다룬다.

- **N6. Console 의 화면에 `Unguarded` 표시를 더하지 않는다.** 기록에 필드를 싣는
  데까지가 이 SRS 다. 화면은 별도 판단이다.

---

## 6. 리스크

| 리스크 | 수준 | 완화 |
|---|---|---|
| `ExecUnguarded` 가 화이트리스트 우회 수단이 된다 | **MEDIUM** | `FR-GXU-12` 의 호출처 게이트가 이 SRS 의 안전 장치 전부다. V12 가 그것을 검사한다. **지금보다 강해진다** — 현재 그 셋은 아무 게이트도 지나지 않는다 |
| `Stdout`+`Stderr` 결합 순서가 `CombinedOutput` 과 달라 파싱이 깨진다 | **MEDIUM** | 성공 경로는 stdout 만 읽는다. V8·V9 가 선행 공백과 실패 진단을 못박는다 |
| 출력 상한(1MiB)이 새로 걸려 큰 출력이 잘린다 | **MEDIUM** | 지금은 상한이 없어 전량이 메모리에 온다. `Output.StdoutTruncated` 가 잘림을 **말해 주므로** 조용한 손실이 아니다. 상한이 문제되는 자리가 나오면 `WithMaxOutput` 으로 그 Service 만 올린다 |
| `Env()` 가 기존 환경을 덮어쓴다 | **LOW** | `append(os.Environ(), …)` 다. 이미 두 자리가 그렇게 쓰고 있다 |
| 매달리던 경로가 즉시 실패로 바뀌어 사용자가 놀란다 | **MEDIUM** | 그것이 목적이다. "Authentication failed" 는 180초 침묵보다 나은 답이다 |
| `httpapi` → `core` import 로 순환이 생긴다 | **LOW** | `core` 는 `httpapi` 를 모른다. `go build` 가 즉시 판정한다 |
| 배선 순서 변경(`core.New()` 를 앞으로)이 다른 초기화를 깬다 | **LOW** | `core.New()` 는 인자가 없고 부작용이 없다. `go test` 와 e2e 가 판정한다 |

---

## 7. 구현 계획

1. **RED** — V1·V3·V6·V12·V14·V16 을 먼저 쓴다.
2. **GREEN(a)** — `FR-GXU-1`~`6`. `ExecUnguarded`·`UnguardedSpec`·`Record` 표식·
   `Replay` 거부.
3. **GREEN(b)** — `FR-GXU-7`~`10`. 세 자리의 본문 교체와 배선. **시그니처 무변경**을
   `git diff` 로 확인한다.
4. **GREEN(c)** — `FR-GXU-11`~`16`. 게이트를 넓히고 예외 목록을 사실에 맞춘다.
5. **회귀** — V10·V17·V18 과 `go test -race -shuffle=on ./...`.
6. **묶음 검증** — `make gates` · `npm run typecheck` · `npm run lint` ·
   `npm run unit`.
7. **e2e** — 묶음 끝에 전량 한 번. 프론트에 닿지 않으나 worktree·submodule 표면이
   e2e 에 있다.

---

## 8. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-10 | 최초 작성(`GIT_ENV_GATE_SRS`). `Env()` 공유와 게이트 봉합으로 범위를 좁혔었다 |
| 2026-09-10 | **전면 개정.** `FR-GIT-246` 이 기각한 것이 **인가 층의 확장**이지 실행 층의 공유가 아님을 확인하고(§2.3), 층을 갈라 실행만 통일하는 것으로 범위를 넓혔다. 화이트리스트는 그대로 두므로 기존 결정 셋과 충돌하지 않는다 |
| 2026-09-10 | **구현 완료.** git 바이너리를 얻는 자리가 `domain/git` 밖에서 **3 → 0**. `readCommands`·`writeCommands` 는 한 항목도 늘지 않았고 `V18` 이 그것을 지킨다. `V15` 는 자동화하지 않았다(§4 표). 게이트 셋은 탐침으로 실제 검출을 확인했다 (§4.1) |
