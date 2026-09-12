# SRS: 드리프트 회수 리팩터 — IEEE 29148

> **문서 상태**: 승인·구현완료

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

`DEEPENING_REFACTOR_SRS` 가 세운 여섯 초크포인트는 지금도 서 있다. 그 뒤로 들어온
기능 개발이 **그 옆으로 자랐다.** 이 문서는 그렇게 갈라져 나온 자리를 원래 초크포인트로
회수하고, **다시 갈라지지 못하게 게이트를 세운다.**

근본 문제는 복제가 생겼다는 것이 아니라 — **초크포인트에 게이트가 없어서 복제가
검사를 그냥 통과했다는 것**이다. 이 코드베이스는 이미 그 결론에 도달해 있다:

```
# scripts/check-timers.sh:8
`check-seams.sh` 와 같은 형태다. 그 파일의 주석이 남긴 이력이 이 검사가
필요한 이유이기도 하다 — "D1 이 이 검사를 그냥 통과해 들어온 뒤에 추가됐다".
...
멈춘 이유가 게이트의 부재다 — 규약은 선언으로 지켜지지 않는다.
```

`gitWrite` 파이프라인과 Git 탭 골격에는 그 게이트가 없다. 그래서 Submodules 탭과
Worktrees 탭이 규약을 **복제로** 구현했다.

### 1.2 범위 (Scope)

| 묶음 | 내용 | 리스크 |
|---|---|---|
| **A** | 추상화 회수 — `gitWrite` 를 우회한 핸들러 4개 이관, Git 탭 골격 통합, 재발 게이트 | **MEDIUM** |
| **B** | 중복 헬퍼·중복 블록·하드코딩 정리 | LOW |
| **C** | 큰 파일 분할 | LOW |

**미포함:** §5 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **드리프트 (drift)** | 초크포인트가 있는데도 그 옆에 같은 일을 하는 코드가 자란 것 |
| **게이트 (gate)** | 드리프트를 CI 에서 실패로 만드는 검사 스크립트. `check-seams.sh` 계열 |
| **특성화 테스트** | 리팩터 전에 **현재 행위를 그대로 고정**하는 테스트 |
| **사다리 (ladder)** | `x, ok := step(w, r); if !ok { return }` 의 연쇄 |
| **끈적한 실패 (sticky)** | 한 번 응답한 뒤 모든 단계가 무동작이 되는 것. `gitWrite.done` 이 그것 |

### 1.4 참고 (References)

- `docs/internal/DEEPENING_REFACTOR_SRS.md` — `gitWrite` · `apierr` 의 근거
- `internal/webserver/gitapi/gitwrite.go` — 회수 대상 초크포인트
- `scripts/check-seams.sh`, `scripts/check-timers.sh` — 게이트의 기존 형태

---

## 2. 전체 기술 (Overall Description)

### 2.1 현황 측정 (2026-09-08)

| 항목 | 값 |
|---|---|
| Go 프로덕션 / 테스트 | 47,836 / 59,448 줄 |
| 프론트엔드 JS | 33,963 줄 |
| e2e | 41,427 줄 |
| 기존 게이트 (seams·timers·cross) | 전부 통과 |
| `go build ./...` · `go vet ./...` | 청정 |

### 2.2 측정된 드리프트

**(1) `gitWrite` 를 우회한 쓰기 핸들러 4개**

| 파일 | 쓰기 핸들러 | `beginWrite` | 상태 |
|---|---|---|---|
| `handlers_git_submodule.go` | 2 | 0 | **전량 수동 사다리** |
| `handlers_git_worktree.go` | 2 | 0 | **전량 수동 사다리** |

`handlers_git_submodule.go:104-119` 와 `:140-155` 는 **16줄 완전 중복**이다 —
가용성 검사 → 본문 디코드 → confirm → repo 해석의 사다리 넷이 통째로 두 벌이다.

복제는 이미 갈라졌다:

```go
// apiGitSubmoduleUpdate:113 — confirm 없음을 bad_request 로 답한다
gitFail(w, http.StatusBadRequest, gitErrBadRequest, "confirm 이 없다")
// apiGitWorktreeRemove:216 — 같은 상황을 confirmation_required 로 답한다
gitFail(w, http.StatusBadRequest, gitErrConfirmRequired, "...")
```

한 서버가 같은 뜻에 두 코드를 쓴다. 화면은 그 둘을 각각 "잘못된 요청입니다" 와
"확인이 필요합니다" 로 옮긴다 (`constants-git.js:474-475`) — 사용자가 보는 말이
갈렸다.

**(2) `handlers_git_submodule.go` 에 Go 단위 테스트가 0개다**

`handlers_git_worktree_test.go` 는 10개다. 같은 성질의 두 표면 중 하나만
안전망이 있다.

**(3) Git 탭 골격 복제 — `submodules.js` ≡ `worktrees.js`**

16줄 연속 동일 블록. `submodules.js` 헤더 주석이 스스로 인정한다:

```
 * **골격은 워크트리 탭과 같다** (FR-SUB-7). 머리에 일괄, 그 아래 안내 줄, 그
 * 아래 `reconcileList` 로 그리는 목록 — 같은 모양의 목록이 둘이면 규칙도 하나여야
 * 한다.
```

규칙이 하나여야 한다고 적고 두 벌로 구현했다. 게이트가 없었기 때문이다.

**(4) 중복 헬퍼**

```go
// sandbox/runtime.go:206 · submodule/submodule.go:285 — 동일 로직, 상한만 다르다
func tail(out string, err error) string { ... const max = 400 / 2000 }
// gitapi/handlers_git.go:83 — 세 번째 변형 (2048 + ToValidUTF8)
func gitTail(msg string) string
```

`exactPath` 와 route 구조체가 `httpapi/handlers_api.go:68` 과
`gitapi/routes.go:16` 에 복제돼 있다.

**(5) 12줄 이상 중복 블록 9건**

`handlers_fs.go:294≡:438` · `handlers_fs_search.go:120≡:293` ·
`handlers_ws.go:196≡:233` · `handlers_toolio.go:45≡:181` ·
`handlers_runs_headless.go:116≡:182` · `handlers_git.go:369≡wsentry/link.go:94` ·
`handlers_git.go:266≡handlers_git_init.go:26` ·
`write/branch.go:494≡write/remote.go:156` · `dmctl.go:403≡:435`

뒤의 셋은 앞의 여섯을 걷어낸 뒤 같은 측정이 드러냈다 — 큰 복제가 작은 복제를
가리고 있었다.

**(6) 하드코딩 불일치**

```go
// ctl/cli/health.go:23 — 호스트를 박아 쓴다
ping(fmt.Sprintf("http://localhost:%s/", port), 3*time.Second)
// ctl/cli/migrate.go:41 — 바로 옆은 상수를 쓴다
ping(fmt.Sprintf("http://%s:%s/api/ping", dmenv.DefaultHost, port), 2*time.Second)
```

`dmenv.DefaultHost` 는 `"127.0.0.1"` 이다. `localhost` 가 `::1` 로 먼저 풀리는
환경에서 **health 만 실패한다.** 같은 데몬을 두 이름으로 부르면 한쪽이 다른
인스턴스를 본다는 것이 `dmenv.go:40` 주석이 이미 말한 것이다.

**(7) 큰 파일**

| 파일 | 줄 |
|---|---|
| `web/js/core/constants-git.js` | 1,690 |
| `web/js/git/history.js` | 1,236 |
| `web/js/core/app-editor.js` | 1,152 |
| `web/js/ui/file-editor.js` | 1,027 |
| `internal/helper/runtimebin/dmctl_run.go` | 880 |
| `internal/webserver/domain/run/store.go` | 837 |

---

## 3. 요구사항 (Requirements)

### 3.1 묶음 A — 추상화 회수

**FR-DRC-1** `gitWrite` 는 `s.Git` 이 아닌 관리자(`Submodules`·`UserWorktrees`)가
실행하는 쓰기도 열 수 있어야 한다. 가용성 검사가 파이프라인의 **매개변수**여야
한다 — 지금은 `s.Git == nil` 이 `beginWrite` 안에 박혀 있어 다른 표면이 파이프라인
자체를 못 쓴다.

**FR-DRC-2** `gitWrite` 는 status 스냅숏 **없이** 답하는 성공 종단을 제공해야
한다. Submodules·Worktrees 는 부분 적용 판정을 하지 않으므로 `apply` 의 status
왕복이 값을 벌지 않는다.

**FR-DRC-3** `gitWrite` 는 관리자 조작의 실행과 오류 번역을 한 단계로 받아야 한다.
오류 번역기는 표면이 정한다 — `gitSubmoduleError` 와 `gitError` 는 서로 다른 판정을
한다.

**FR-DRC-4** `apiGitSubmoduleUpdate`·`apiGitSubmoduleSync`·`apiGitWorktreeCreate`·
`apiGitWorktreeRemove` 는 `gitWrite` 를 지나야 한다. 사다리(`if !ok { return }`)가
남지 않아야 한다.

**FR-DRC-5** confirm 없음의 와이어 코드는 **하나여야 한다.** `confirmation_required`
로 통일한다 — 그것이 뜻이고, 화면의 표도 이미 그 코드를 안다.

**FR-DRC-6** 이관 **전에** `handlers_git_submodule.go` 의 현재 행위를 고정하는
특성화 테스트가 있어야 한다. 없는 안전망 위에서 옮기지 않는다.

**FR-DRC-7** Submodules 탭과 Worktrees 탭의 공통 골격(머리·안내 줄·목록·빈 상태)은
한 곳에서 선언되어야 한다.

**FR-DRC-8** 게이트 스크립트가 있어야 한다. `gitapi` 의 쓰기 핸들러가 `gitWrite` 를
지나지 않으면 CI 가 실패해야 한다. `check-seams.sh` 와 같은 형태다.

### 3.2 묶음 B — 중복·하드코딩 정리

**FR-DRC-9** 진단 문자열 자르기는 한 곳에서 선언되어야 한다. 상한은 호출자가 준다.

**FR-DRC-10** `exactPath` 와 route 구조체는 한 곳에서 선언되어야 한다.

**FR-DRC-11** §2.2(5) 의 중복 블록 9건은 각 파일 안에서 회수되어야 한다.

**FR-DRC-12** `ctl/cli/health.go` 는 `dmenv.DefaultHost` 를 써야 한다.

### 3.3 묶음 D — 간헐 실패의 원인 제거

**FR-DRC-14** 화면이 스스로 회복해야 한다. 어떤 상태의 복구도 **바깥의 다음
호출 하나**에 걸려 있으면 안 된다 — 그 호출이 조건보다 먼저 닿으면 복구가 영영
일어나지 않고, 그것이 간헐 실패의 모양이다.

**FR-DRC-15** 화면에 보이는 요소는 **보이는 순간부터** 그 조작을 받아야 한다.
리스너를 뒤로 미루면 보이는데 반응하지 않는 창이 생긴다.

**FR-DRC-16** 값이 도착하는 자리는 **그 값을 읽는 모든 화면**에 알려야 한다.
활성인 하나에만 알리면 나머지는 낡은 값을 그린 채 남는다.

**FR-DRC-17** e2e 의 재시도 상한은 **1 이고, 로컬과 CI 가 같다.** 조건이 갈리면
로컬의 초록과 CI 의 초록이 다른 것을 뜻하게 되고, 어느 쪽이 사실인지 말할 수 없다.

**상한선은 흔들림을 지우지 않는다 — 한 번까지만 봐준다는 뜻이다.** 그래서 첫 시도가
깨진 순간의 트레이스를 남긴다(`retain-on-first-failure`). 예전 설정이 위험했던 이유는
재시도 자체가 아니라 **증거를 남기지 않은 것**이었다: `on-first-retry` 는 재시도 회차만
찍었고 아무도 flaky 개수를 세지 않았다. 그 사이 §7.5 의 제품 결함 셋이 초록 뒤에 있었다.

**수용 기준:** 전량 e2e 를 **연속 3회** 돌려 **실패 0.** flaky 는 상한선 안이지만
**0 이 아니면 부채로 기록한다** — 개수와 자리를 남기고, 다음 세션이 그 트레이스로
원인까지 간다.

### 3.4 묶음 C — 큰 파일 분할

**FR-DRC-13** §2.2(7) 의 파일들은 주제 경계로 갈라야 한다. **로드 순서가 곧
의존성**인 프론트엔드에서는 분할이 그 순서를 깨지 않아야 한다.

---

## 4. 검증 (Verification)

| ID | 방법 |
|---|---|
| V-1 | `go build ./...` · `go vet ./...` 청정 |
| V-2 | `go test ./...` 전량 통과 |
| V-3 | `scripts/check-seams.sh` · `check-timers.sh` · `check-cross.sh` 통과 |
| V-4 | 신설 게이트가 현재 트리에서 통과하고, 사다리를 되돌리면 실패한다 |
| V-5 | 특성화 테스트가 이관 전후로 같은 결과 |
| V-6 | e2e `git-submodules` · `git-worktrees` · `git-worktree-repo` 통과 |

## 5. 비목표 (Non-goals)

- 표면의 **기능** 추가·삭제. 회수만 한다.
- `domain/git` 화이트리스트 경계 변경. Submodules·Worktrees 가 `s.Git` 을 실행에
  쓰지 않는 이유(FR-GIT-95 교집합-금지)는 그대로다.
- 번들러 도입. 프론트엔드는 로드 순서가 의존성이라는 전제를 유지한다.
- 테스트 커버리지 목표 상향. 특성화 테스트는 회수의 안전망으로만 넣는다.

## 6. 동작 변경 기록

| 항목 | 이전 | 새 | 이유 |
|---|---|---|---|
| submodule confirm 누락 | `400 bad_request` / "잘못된 요청입니다" | `400 confirmation_required` / "확인이 필요합니다" | FR-DRC-5. 같은 뜻에 코드가 둘이면 사용자가 보는 말이 갈린다. worktree 가 이미 쓰는 코드로 맞춘다 |
| submodule 쓰기 성공 본문 | `{ok, repo}` | `{ok, repo, requested}` | 쓰기 응답 모양의 통일. `requested` 는 화면의 stale 판정 근거이며(`panel-write.js:185`) 없으면 그 판정을 못 한다. 추가만 하므로 기존 소비자는 영향 없다 |
| `health` 의 대상 호스트 | `localhost` | `dmenv.DefaultHost` (`127.0.0.1`) | FR-DRC-12. `localhost` 가 `::1` 로 먼저 풀리는 환경에서 health 만 실패했다 |
| 데몬 배선 WS 읽기 오류 로그 | `readWS error: <err>` | `readWS error addr=<addr>: <err>` | 직접 배선과 같은 사건인데 한쪽에만 주소가 있었다. 통합하면서 정보가 많은 쪽으로 맞췄다 |
| `sandbox`·`submodule` 진단 자르기 | 바이트 경계로 자름 | `ToValidUTF8` 을 지남 | FR-DRC-9. 한글이 실린 stderr 를 바이트로 자르면 마지막 글자가 깨져 나갔다. `gitTail` 만 옳던 규칙을 셋이 함께 쓴다 |

**동작이 바뀌지 않은 것:** 나머지 회수는 전부 같은 응답·같은 순서다. gitapi 쓰기
핸들러 이관, `httproute` 추출, `listorder`·`fsWalkFiles`·`wsReadLoop`·
`decodeJSONBody`·`runMember`·`fsRootTarget`·`pushForceArgs`·`dmctlHTTPResult`,
그리고 묶음 C 의 파일 분할은 전부 순수 이동이다.

`listorder` 는 **정책 차이를 보존한다** — `gitapi` 는 `ToEnd`, `wsentry` 는 `Keep`
이다. 그 갈림은 실수가 아니라 서로 반대되는 판단이었고 양쪽이 근거를 적어 두었다.
합치지 않고 인자로 드러냈다.

---

## 7. 결과 (2026-09-08)

### 7.1 검증

| ID | 결과 |
|---|---|
| V-1 | `go build ./...` · `go vet ./...` 청정 |
| V-2 | `go test ./...` 34개 패키지 전량 통과 |
| V-3 | `check-seams` · `check-timers` · `check-cross` 통과 |
| V-4 | `check-gitwrite` 신설 — 통과하고, 사다리를 되돌리면 실패한다 (실측) |
| V-5 | 특성화 테스트 9개 — 이관 전후로 같은 결과 |
| V-6 | e2e `git-submodules` · `git-worktrees` · `git-worktree-repo` · `git-submodule-notice` 41건, `editor-find-panel` · `editor-dirty-diff` 36건 통과 |

### 7.2 측정

| 항목 | 전 | 후 |
|---|---|---|
| 12줄 이상 Go 중복 블록 | 9건 | **0건** |
| 10줄 이상 JS 중복 블록 | 1건 (16줄) | **0건** |
| `gitWrite` 를 우회한 쓰기 핸들러 | 4 + 부분 우회 4 | **0** |
| `gitResolveRepo` 직접 호출자 | 7 | **2** (파이프라인·읽기 경로) |
| `handlers_git_submodule.go` 단위 테스트 | 0 | 9 |
| 게이트 스크립트 | 3 | 4 |

### 7.3 새로 선 자리

| 자리 | 흡수한 것 |
|---|---|
| `internal/webserver/httproute` | route 구조체 2벌 · `exactPath` 2벌 · 디스패치 루프 2벌 · 인라인 매처 4개 |
| `internal/shared/diagtail` | `tail` 2벌 + `gitTail` |
| `internal/shared/listorder` | `reorder` 2벌 (정책 차이는 인자로 보존) |
| `gitWrite.beginServiceWrite`·`exec`·`invalidate`·`okPlain`·`rejectBody` | 쓰기 사다리 8개 |
| `web/js/git/list-tab.js` (`GitListTab`) | Worktrees·Submodules 탭 골격 8메서드 |
| `scripts/check-gitwrite.sh` | 재발 방지 게이트 (CI 배선) |

### 7.4 갈라 나온 파일

| 원본 | 후 | 새 파일 |
|---|---|---|
| `web/js/ui/file-editor.js` 1,027 | 747 | `file-editor-find.js` 288 |
| `web/js/core/constants-git.js` 1,690 | 1,261 | `constants-git-actions.js` 447 |
| `internal/webserver/domain/run/store.go` 837 | 622 | `vocabulary.go` 225 |
| `internal/helper/runtimebin/dmctl_run.go` 880 | 687 | `dmctl_run_print.go` 203 |

### 7.5 간헐 실패를 파고들어 잡은 제품 결함 둘

e2e 전량이 회차마다 몇 건씩 흔들렸다. 이 저장소의 관행은 **재시도로 덮지 않는
것**이므로(`946b439`) 원인까지 갔고, 둘이 제품 결함이었다.

#### (1) 메뉴의 `Esc` 죽은 창 (FR-DRC-15)

전량 e2e 가 두 건을 실패시켰고(`git-history` H14 · `git-file-actions` F9), 그것을
"산발 흔들림" 으로 넘기지 않고 원인까지 갔더니 **제품 결함**이었다.

```js
// ui-kit.js — 고치기 전
document.body.appendChild(m);          // 메뉴가 화면에 보인다
TIMERS.defer(() => {                   // …리스너는 다음 태스크에 붙는다
  document.addEventListener('mousedown', UIKit._menuOff, true);
  document.addEventListener('keydown',  UIKit._menuOff, true);
});
```

메뉴가 **보이는데 `Esc` 가 죽어 있는 창**이 한 태스크만큼 있다. 그 창에 들어온
`Esc` 는 아무 일도 하지 않고, 키는 다시 오지 않으므로 메뉴가 열린 채 남는다.
빠르게 누르는 사용자가 그대로 맞는 결함이며, e2e 는 그것을 재현한 것뿐이다.

미루는 사유는 **`mousedown` 에만** 있었다 — 메뉴를 연 그 클릭이 자기를 닫는 것.
키에는 그 사유가 없다(`Esc` 로 메뉴를 여는 길이 없다). 그래서 `keydown` 은 즉시
걸고 `mousedown` 만 미룬다.

같은 파일의 형인 `GitMenu` 는 **처음부터 동기로 걸고 있었고 주석에 그 근거까지
적어 두었다** (`menu.js:376`) — `UIKit.menu` 만 규약에서 벗어나 있었다.

#### (2) History 목록이 스스로 레이아웃을 되찾지 못했다 (FR-DRC-14)

> **근거의 강도를 밝혀 둔다.** 이 건은 **구조적 강화**이며, 관측된 실패
> (`git-history` H22)의 원인으로 **증명되지 않았다.** H22 의 트레이스에서
> API 응답은 전부 정상이었고(최대 188ms) 실패는 "특정 커밋 행 없음" 이었는데,
> 그것이 아래의 레이아웃 유실 때문인지 다른 이유인지 가르지 못했다. 아래
> 약점 자체는 코드에 실재하므로 고쳐 두되, "H22 를 고쳤다" 고 말하지 않는다.

```js
// history.js — 고치기 전
// …다시 칠할 때까지 손대지 않는다 (elFor 가 루트를 붙인 뒤 한 번 더 부른다).
if(!list.clientHeight){this._noLayout=true;return}
```

탭이 비활성인 사이 목록에는 높이가 없다. 그때 행 창을 잡으면 **펼친 상세와
스크롤 위치를 잃으므로** 손대지 않는 것이 맞다. 틀린 것은 **되찾는 길**이었다 —
복구가 바깥의 두 번째 호출 하나에 걸려 있었고, 그 호출이 레이아웃보다 먼저 닿으면
여기서 다시 돌아간다. **세 번째를 부를 사람은 없다.**

그러면 탭을 떠났다 돌아온 사용자가 목록 맨 위에 서고 펼쳐 둔 상세가 닫힌다.
e2e `git-history` H22 가 그 자리를 간헐로 잡아 왔다.

이제 높이가 설 때까지 **프레임마다 스스로 다시 본다**. 계기가 rAF 인 것이
요점이다 — 높이는 레이아웃 뒤에 생기고, 탭이 숨으면 rAF 가 멎어 대기가 저절로
멈춘다. 상한(`GIT_HIST_LAYOUT_FRAMES`)은 높이가 영영 오지 않는 화면(접혀서 0px 인
칸)에서 사슬을 끝내기 위한 것이다.

#### (3) 핀 통지가 활성 패널 하나에만 갔다 (FR-DRC-16)

```js
// app-git.js `gitReposRefresh` — 고치기 전
if(this.gitPanel&&this.gitPanel.notifyPins) this.gitPanel.notifyPins();
```

`gitPanel` 은 **활성 창의 루트와 포커스 칸**의 패널을 주는 getter 다
(`_gitRootOfActive`). 핀을 찍은 화면이 그 자리가 아니면 — 다른 창에 서 있거나
다른 칸이 포커스면 — 그 화면은 통지를 받지 못한다. 그러면 방금 핀한 worktree 행의
버튼이 `Pin` 인 채로 남고, 다시 누르면 서버의 멱등 응답이 성공으로 와서 "핀했습니다"
만 뜬다 (`_actsOf` 의 주석이 막으려던 바로 그 상태다).

**바로 위 `_gitRescheduleAll` 이 같은 이유로 이미 고쳐진 자리다:** "종전에는 활성
칸의 패널 하나만 `_reschedule()` 했다 — 패널이 하나뿐이었기 때문이다." 폴링은
그때 옮겨졌고 **이 통지만 옛 모양으로 남아 있었다.**

트레이스가 그것을 갈랐다 — 서버의 `pinned` 목록에는 그 경로가 들어 있었고
(3초마다 다시 받았다), 핀 목록의 경로와 worktree 행의 경로가 문자열까지 같았다.
데이터는 맞고 **다시 그리라고 말해 주는 쪽**이 빠져 있었다. e2e `git-worktrees`
V168·V169 가 그 자리를 간헐로 잡아 왔다.

### 7.6 남은 flaky 다섯 — 부채로 기록한다

재시도 상한 1 · `retain-on-first-failure` 로 전량 1회를 돌린 결과: **실패 0 ·
flaky 6 · 1,375 통과.** 그중 원인이 확정된 하나(`git-console` K10)만 고쳤고 —
playwright 가 기전을 직접 적어 주었다(`element was detached from the DOM`), 그
체크박스는 `mount()` 만 만들므로 뷰 remount 가 유일한 설명이다 — 나머지 다섯은
**원인을 확정하지 못해 손대지 않았다.**

**여섯 모두에 대해 확정된 사실 하나:** 트레이스의 API 응답 중 **1.5초를 넘은 것이
하나도 없다** (전부 200). 즉 "병렬 부하로 `git` 이 느려졌다" 는 설명은 이 여섯에
대해 **반증됐다.** `fixtures.ts` 의 30초 상한이 그 가정 위에 서 있으므로, 다음에
이 자리를 볼 때 그 주석부터 의심해야 한다.

| 스펙 | 확정된 것 | 확정하지 못한 것 |
|---|---|---|
| `git-branch-actions` BR11 | `.git-view.vis` 가 없다 (element not found), 15초 | 왜 뷰가 하나도 안 보이는가 |
| `git-branches` B6 | 개수가 0 (≥2 기대), 20초 | 목록이 왜 안 차는가 |
| `git-history` H15 | `.git-hist-loaded` 없음, 20초 | 뷰가 안 선 것인지 값이 안 온 것인지 |
| `git-polling` P4 | `openGit` 의 첫 관측 대기 30초 초과 | **가설:** 이 검사는 `gitStatusInterval: 0` 이다 — 주기가 0 이면 재시도할 타이머가 없어(`_applyCadence` 의 `if(st>0)`) 첫 수집을 놓치면 영영 오지 않는다. `_pollOk()` 가 그때 거짓이었는지는 **관측하지 못했다** |
| `repo-tab` X4 | `.git-file[data-path="src/a.ts"]` 없음, 20초 | 사이드가 Changes 로 안 바뀐 것인지 목록이 안 온 것인지 |

**다음에 이것을 볼 사람에게:** 트레이스는 이제 남는다(`retain-on-first-failure`).
DOM 스냅숏을 손으로 파싱하려 했으나 형식이 달라 신뢰할 수 없었다 — `npx playwright
show-trace <trace.zip>` 로 여는 편이 빠르다.

### 7.6 남은 것

`web/js/git/history.js`(1,236) · `web/js/core/app-editor.js`(1,152) ·
`web/js/git/branches.js`(990) 는 손대지 않았다. 셋 다 주제가 하나이고 내부에
`// ──` 구획이 없어, 가르는 선을 정하는 것이 기계적 이동이 아니라 설계 결정이다.
