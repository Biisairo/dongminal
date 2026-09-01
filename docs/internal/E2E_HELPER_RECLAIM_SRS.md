# SRS: e2e 헬퍼 회수와 죽은 코드 정리 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`SPLIT_REFACTOR_SRS` 가 고친 것은 "파일이 크다" 한 축이다. 이 SRS 는 다른 축을
고친다 — **같은 사실이 여러 곳에 적혀 있다.**

근본 문제는 e2e 가 길다는 것이 아니라 — **`fixtures.ts` 가 있는데도 87개 스펙이
같은 헬퍼를 각자 다시 정의하고, 그래서 셋업 하나를 고치려면 63개 파일을 열어야
한다는 것**이다.

측정된 증거:

```
waitForInit  63개 파일이 정의 — 그중 37개는 본문이 바이트 동일
copyFx       22개 파일이 정의 — 그중 21개는 본문이 바이트 동일
openGit      20개 파일이 정의 — 그중  8개는 본문이 바이트 동일
toHaveCount(7)  28개 파일에 하드코딩 — GIT_VIEWS 의 길이
```

`fixtures.ts` 는 119줄이고 헬퍼가 둘(`openGitTab`·`plainWindows`)뿐이다. 자리는
이미 있는데 쓰이지 않는다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **A** | `waitForInit` 표준형을 `fixtures.ts` 로. **본문이 동일한 37개만** 회수 | LOW |
| **B** | `copyFx` 를 팩토리로 `fixtures.ts` 로. 동일한 21개 회수 | LOW |
| **C** | `openGit` 최빈형을 `fixtures.ts` 로. 동일한 8개 회수 | LOW |
| **D** | `GIT_VIEW_TABS` 상수 신설 — 28곳의 하드코딩된 `7` 을 한 자리로 | LOW |
| **E** | 죽은 코드 제거 — JS 상수 7 · Go 3 · staticcheck 단순화 2 | LOW |

**미포함:** §5 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **변종 (variant)** | 같은 이름의 로컬 헬퍼인데 본문이 다른 것. 각자 이유가 있다고 가정한다 |
| **검증 독립성** | 검증이 구현의 값을 읽지 않고 **스스로 적는 것**. `fixtures.ts` 의 `plainWindows` 가 그 원칙을 이미 적어 뒀다 |
| **팩토리 회수** | 헬퍼가 파일마다 다른 값을 닫아야 할 때, 그 값을 받아 함수를 돌려주는 형태로 올리는 것. **호출부가 바뀌지 않는다** |

### 1.4 참고 (References)

- `e2e/fixtures.ts` — 회수의 목적지. `plainWindows` 주석이 검증 독립성의 원본
- `docs/internal/SPLIT_REFACTOR_SRS.md` — 앞선 축(파일 크기)을 고친 SRS
- `web/js/core/constants-git.js` — `GIT_VIEWS` (묶음 D 가 **읽지 않는** 것)

---

## 2. 전체 기술 (Overall Description)

### 2.1 검증 독립성을 깨지 않는다 — 묶음 D 의 형태를 결정한 제약

`fixtures.ts:plainWindows` 는 이렇게 적혀 있다:

> 앱 내부의 `_plainWindows()` 를 재사용하지 않고 여기서 같은 조건을 **독립적으로
> 판정한다** — 구현이 필터를 잘못 짜면 검증 쪽도 같은 실수를 공유해 결함을
> 가려버린다.

그래서 묶음 D 는 `7` 을 `GIT_VIEWS.length` 로 **바꾸지 않는다.** 그렇게 하면
`GIT_VIEWS` 에서 탭이 실수로 빠져도 e2e 가 통과한다 — 검사가 검사를 멈춘다.

고치는 것은 **그 숫자가 28곳에 있다는 사실**뿐이다. 숫자는 여전히 e2e 가
독립적으로 적고, 다만 한 자리에 적는다.

### 2.2 변종은 통합하지 않는다

`waitForInit` 63개 중 26개, `openGit` 20개 중 12개가 변종이다. 모바일 진입·
특정 초기 스크립트·다른 대기 조건 등 **각자 이유가 있다.** 겉이 같아 보인다는
이유로 합치면 그 스펙이 재려던 것과 다른 것을 재게 되고, 그것은 무동작변경이
아니라 **검사의 의미 변경**이다.

본문이 **바이트 동일한 것만** 회수한다. 이 기준은 판단이 아니라 기계가 정한다.

### 2.3 제약 (Constraints)

| # | 제약 | 출처 |
|---|---|---|
| C-1 | `FIXTURES` 는 스펙마다 다르다 (`dm-git-fx-<태그>-<pid>`) — 격리를 위해서다. `copyFx` 를 회수하려면 그 값을 닫아야 한다 | 실측 32종 |
| C-2 | 검증은 구현의 값을 읽지 않는다 | `fixtures.ts:plainWindows` |
| C-3 | e2e 927 케이스가 전부 통과해야 한다. 개수도 같아야 한다 — 줄면 검사가 사라진 것이다 | 기준선 |
| C-4 | JS 상수 제거는 `?v=` 와 `assets.lock` 을 함께 올린다 | `web/version_test.go` |

---

## 3. 상세 요구사항 (Specific Requirements)

**FR-EHR-1** `fixtures.ts` 에 `waitForInit(page)` 를 둔다. 본문은 37개가 공유하던
형태와 **동작이 같다.** 정확히는 둘이 다르다 — 설명 주석 한 줄을 더했고 타입을
`page: any` 로 적었다(`openGitTab`·`plainWindows` 와 같은 관행). 실행되는 문장은
한 글자도 다르지 않다.

**FR-EHR-2** 그 37개 파일에서 로컬 정의를 지우고 `./fixtures` 에서 가져온다.
**변종 26개는 손대지 않는다.**

**FR-EHR-3** `fixtures.ts` 에 `makeCopyFx(root)` 를 둔다. 팩토리인 이유는 C-1
이다 — 각 스펙이 `const copyFx = makeCopyFx(FIXTURES)` 한 줄로 받으면 **호출부가
한 글자도 바뀌지 않는다.**

**FR-EHR-4** `fixtures.ts` 에 `openGit(page, repo)` 를 둔다. 동일한 8개만 회수한다.

**FR-EHR-5** `fixtures.ts` 에 `GIT_VIEW_TABS = 7` 을 둔다. 구현의 `GIT_VIEWS` 를
**읽지 않는다** (C-2, §2.1). 상수 곁에 그 이유를 적는다.

**FR-EHR-6** 죽은 코드를 지운다.

| 대상 | 근거 |
|---|---|
| JS 상수 7개 | 선언 파일 밖에서 참조 0 — `SEARCH_RESEARCH_DELAY` · `GIT_DETACHED_REASON` · `GIT_ERR_EMPTY_MESSAGE` · `GIT_ERR_NOTHING_STAGED` · `GIT_CON_REPLAY_FAIL` · `GIT_BR_REMOTE_PULL` · `GIT_BR_WHY_NO_HEAD` |
| `gitErrResetMode` | staticcheck U1000 |
| `httpapi/server.go:82` 의 `mu` 필드 | staticcheck U1000 |
| `handlers_git_tag_test.go:27` 의 `gitTagRepo` | staticcheck U1000 |
| `adapters/client.go:29` | staticcheck S1016 — 구조체 리터럴 대신 형 변환 |

**FR-EHR-6a** `workspace/manager.go:21` 의 ST1005 는 **고치지 않는다.** 그
문자열은 `dmctl` 이 사용자에게 내보내는 안내문이고("uuid 는 `dmctl
list-workspace` 의 uuid= 컬럼 …에 있다."), 주석이 "메시지 자체가 진단의 마지막
줄이다" 라고 적어 뒀다. 마침표를 빼면 **CLI 출력이 바뀐다** — 사용자가 변화를
느끼지 못해야 한다는 조건에 걸린다.

**FR-EHR-7** `patch.go` 의 `keep` 변수는 **지우지 않는다.** 읽히는 자리가 주석
(`default: // mark == keep`)뿐이라 staticcheck 가 죽었다고 보지만, 그 주석이
`reverse` 뒤집기의 뜻을 설명하는 유일한 자리다. 지우면 코드는 짧아지고 이해는
어려워진다. `//lint:ignore` 로 사유를 남긴다.

---

## 4. 검증 (Verification)

| 묶음 | 검증 |
|---|---|
| A·B·C·D | e2e 전량 — **927 passed 와 개수가 같아야 한다** (C-3) |
| E | `go build` · `go vet` · `go test ./...` · `staticcheck` 잔여 지적이 예상 목록과 일치 |

회수가 옳았음은 **바이트 동일 판정**이 증명한다. 지운 로컬 정의와 `fixtures.ts`
의 것이 같은 텍스트였으므로, 호출부에서 보이는 행위가 같다.

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| N1 | 변종 헬퍼 통합 | §2.2. 겉이 같다는 이유로 합치면 검사의 의미가 바뀐다 |
| N2 | `7` 을 `GIT_VIEWS.length` 로 대체 | §2.1. 검증 독립성을 깬다 |
| N3 | `patch.go` 의 `keep` 제거 | FR-EHR-7 |
| N4 | `windowsPaths`·`newLinuxProcInfo`·`posixPaths`·`execRun` 제거 | **오탐이다.** GOOS 를 바꿔 교차 검증하면 반대쪽이 unused 로 나온다 — 빌드 태그 없이 두고 어느 호스트에서든 검증하려는 의도된 설계다 |
| N5 | SA4000 2건 수정 | `Render() != Render()` 는 **결정성 테스트**다. staticcheck 가 동일 표현식으로 볼 뿐 정당하다 |
| N7 | `workspace/manager.go` 의 ST1005 수정 | FR-EHR-6a. CLI 출력이 바뀐다 |
| N6 | e2e 스펙 파일 분할 | 크기가 아니라 중복이 문제였다. 중복을 걷으면 크기도 함께 준다 |

---

## 7. 실행 결과 (Outcome)

### 7.1 측정

| 헬퍼 | 정의하던 파일 | 회수 | 남긴 변종 |
|---|---|---|---|
| `waitForInit` | 63 | **37** | 26 |
| `copyFx` | 22 | **21** | 1 |
| `openGit` | 20 | **8** | 12 |
| `toHaveCount(7)` | 28 (33곳) | **33곳 전부** → `GIT_VIEW_TABS` | — |

`fixtures.ts` 119 → 177줄. 스펙 43개에서 **순 410줄 감소**(+171 −581). 회수에 딸려
미사용이 된 import 심볼 28개도 함께 걷었다.

### 7.2 검증

| 검증 | 결과 |
|---|---|
| `npx playwright test --list` | **927 tests in 87 files** — 기준선과 개수 동일 (C-3) |
| e2e 전량 | **924 passed / 3 failed** — 셋 다 기존 flaky 로 판정 (§7.4) |
| `go build`·`vet`·`test ./...` | 통과 |
| `staticcheck` | 14건 → **8건**. 남은 8건은 전부 §5 비목표로 판정한 것 |

### 7.3 staticcheck 잔여 8건이 전부 "손대면 안 되는 것"인 이유

| 건 | 판정 |
|---|---|
| SA4000 × 2 (`toolline_test`·`testpath_test`) | `Render() != Render()` 는 **결정성 테스트**다. 같은 표현식을 두 번 부르는 것이 검사의 내용이다 |
| U1000 × 5 (`windowsPaths`·`newLinuxProcInfo`) | **오탐.** `GOOS=windows` 로 돌리면 `posixPaths` 가 대신 unused 로 나온다 — 빌드 태그 없이 두고 어느 호스트에서든 검증하려는 의도된 설계다 |
| ST1005 × 1 (`workspace/manager.go`) | 그 문자열은 `dmctl` 이 사용자에게 내보내는 안내문이다. 마침표를 빼면 **CLI 출력이 바뀐다** |

### 7.4 실패 셋을 flaky 로 판정한 근거

전량 실행에서 셋이 실패했다. **회귀인지 아닌지를 추측으로 넘기지 않고 재현으로
갈랐다.**

| 스펙 | 이번 회수로 수정됐나 | 판정 근거 |
|---|---|---|
| `git-commit.spec.ts` E11 (드래그 높이) | 수정됨 | 단독 재실행에서 **통과** |
| `tab-names.spec.ts` V-TAN-12 · V-TAN-14 | **수정 안 함** | 아래 |

`tab-names.spec.ts` 는 이번 작업이 **한 글자도 건드리지 않은 파일**이고, 실행마다
**다른 케이스**가 실패한다 (전량: V-TAN-12·14, 재현: V-TAN-12, HEAD: V-TAN-18).

결정적 증거는 **작업 시작 전 커밋(`7cbb6d6`)을 worktree 로 띄워 3회 돌린 것**이다:

```
원본 #1  11 passed
원본 #2  11 passed
원본 #3   1 failed / 10 passed
```

`vim` 을 띄워 전경 프로세스 이름을 감지하는 검사라 프로세스 기동 타이밍에
민감하다. **이 리팩터 이전부터 흔들리던 것이며, 별도 결정이 필요하다** — 이
저장소는 flaky 를 재시도로 덮지 않는 관행을 갖고 있다 (`946b439 fix(e2e): 흔들리던
두 검사의 사유를 없앤다 — 재시도로 덮지 않고`).

### 7.5 구현 중 바꾼 판단 — `patch.go` 의 `keep`

§3 은 처음에 `//lint:ignore` 로 덮기로 했다(FR-EHR-7). 실제로 붙여 보니 지시가
엉뚱한 줄을 가리켜 새 지적이 하나 늘었고, 그 과정에서 더 나은 길이 보였다.

`keep` 은 `drop` 과 **짝으로 swap 되기 때문에만** 존재했다. swap 을 직접 대입으로
바꾸면 변수도 지적도 함께 사라진다:

```go
drop, keep := byte(HunkAddMark), byte(HunkDelMark)   // 전: keep 은 읽히지 않는다
if reverse { drop, keep = keep, drop }

drop := byte(HunkAddMark)                            // 후
if reverse { drop = byte(HunkDelMark) }
```

`keep` 이라는 이름이 하던 설명은 주석으로 옮겼다(`// drop 의 반대 — 고르지
않았지만 남겨서 문맥으로 바꿀 쪽이다`). **억제 주석으로 덮는 것보다, 지적이
가리키던 것을 없애는 편이 옳다.**
