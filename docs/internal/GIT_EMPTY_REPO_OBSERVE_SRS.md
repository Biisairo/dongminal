# SRS: 빈 저장소는 관측이 오기 전에도 빈 저장소다 — History 의 `initial` — IEEE 29148

> **문서 상태**: 승인·구현완료

> **이 SRS 는 앞선 결정을 개정하지 않는다.** `GIT_DETECT_TIER_SRS` FR-GDT-21(빈 저장소는
> 실패가 아니다 — `Status.Initial` 이 그 사실의 유일한 근거다)의 **구현의 빈틈**을 메운다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

CI(2026-09-23, run 35905641854, **Windows 샤드 4**)에서 e2e V-GDT-12 가 졌다 — 빈
저장소의 History 가 *"커밋이 아직 없습니다"* 여야 하는데 *"검색과 일치하는 커밋이
없습니다"* 였다. 최근 CI 실패 이력에 없던 실패이고, 다른 판(ubuntu·macOS)과 로컬은
초록이었다.

### 1.2 범위 (Scope)

- 포함: `internal/webserver/gitapi/handlers_git_history.go` 의 `initial` 판정 · 그 시험.
- 비포함: 클라이언트의 문구 선택(`history-rows.js`) · 상태 캐시의 수명(`store.Store`) ·
  다른 git 종단.

### 1.3 정의 (Definitions)

- **관측(observation)**: `store.Store` 가 캐시한 저장소의 status. `Observed` 는 캐시만
  보고 git 을 실행하지 않는다. `Status` 는 캐시가 없거나 만료면 새로 관측한다.
- **거부된 요청**: 인자 검증에서 400 으로 끝나는 요청 (H-L2).

## 2. 현황 (Current State) — 실측

### 2.1 서버가 `initial` 을 말하지 않았다

CI 실패 잡의 트레이스에서 그 회차의 `/api/git/log` 응답(200, 211 ms)을 꺼냈다:

```json
{"requested":{…},"repo":"D:\\a\\_temp\\…\\copy-gdt-empty","limit":300,
 "commits":[],"signature":"ref: refs/heads/main|0|0|…"}
```

`commits` 는 비었는데 **`initial` 이 없다.** 클라이언트는 받은 대로 그렸다 — 처음엔 제가
클라이언트의 경합(낡은 응답을 버린 뒤 다시 받지 않는 것)으로 추정했으나, 트레이스가
그것을 반증했다. 그 회차의 History 로드는 **한 번**이었고 응답은 버려지지 않았다.

### 2.2 판정이 캐시에만 기댄다

`handlers_git_history.go` 는 `initial` 을 `s.Git.Observed(root)` 에서만 읽는다. 주석이
그 전제를 적어 두었다 — *"History 는 Repo 창 안에서 열리고 그 창은 이미 status 를 한 번
받았으므로 값은 **거의 언제나** 있다."*

그 "거의" 가 뚫렸다. Repo 창을 열면 status 와 History 의 `git log` 가 거의 함께 나가고,
느린 러너에서 `git log` 가 먼저 끝나면 **관측이 아직 캐시에 없다.** 그러면 `initial` 은
거짓이다. 그리고 status 가 뒤늦게 도착해도 두 응답의 signature 가 같아 클라이언트는
다시 묻지 않는다 — 틀린 문구가 굳는다.

같은 빈틈이 **오류 갈래**에도 있다. 빈 저장소에서 `git log` 가 exit 128 로 실패하는
형태(HEAD 를 요구하는 인자)면, 관측이 없을 때 FR-GDT-21 이 없애려던 *"불러오지
못했습니다"* 로 떨어진다.

### 2.3 캐시를 쓴 이유는 지켜야 한다

캐시만 읽은 까닭은 H-L2 다 — 인자 검증으로 **거부된 요청도 이 자리를 지나므로**, 여기서
새로 관측하면 *"거부했는데 실행했다"* 가 된다 (`TestAPIGitLog_RejectsBadParams`).

## 3. 요구사항 (Requirements)

| ID | 요구사항 | 우선순위 |
|---|---|---|
| FR-GEO-1 | 관측이 캐시에 있으면 그것으로 판정한다 — 종전 그대로이며 git 을 실행하지 않는다. | 필수 |
| FR-GEO-2 | 관측이 **없고**, 요청이 **거부되지 않았으면**(`git log` 가 실제로 실행됐으면) 그 자리에서 관측한다. 그 관측은 캐시에도 남는다 (`Store.Status`). | 필수 |
| FR-GEO-3 | **거부된 요청에서는 관측하지 않는다** (H-L2 그대로). 거부의 판정은 오류 응답의 판정과 같은 자리(`gitErrorCode` 의 400)를 딛는다. | 필수 |
| FR-GEO-4 | 판정이 필요할 때만 관측한다 — 성공 갈래에서는 목록이 **비었을 때만**, 오류 갈래에서는 실패를 빈 저장소로 바꿀지 정할 때만. | 필수 |
| FR-GEO-5 | 관측이 실패하면 종전대로 `initial` 은 거짓이다 — 모르는 것을 참으로 말하지 않는다. | 필수 |

## 4. 검증 (Verification)

| ID | 대상 | 방법 |
|---|---|---|
| V-GEO-1 | FR-GEO-2 | Go: 관측 없는 새 저장소, `git log` 가 빈 목록으로 성공 → 응답에 `initial: true` (고치기 전: 없음 — CI 트레이스의 응답 그대로) |
| V-GEO-2 | FR-GEO-2 | Go: 관측 없음, `git log` 가 exit 128 → **200** + `initial: true` (고치기 전: 오류) |
| V-GEO-3 | FR-GEO-3 | Go: 거부된 요청은 git 을 하나도 실행하지 않는다 — 기존 H-L2 (`TestAPIGitLog_RejectsBadParams`) 가 그대로 초록 |
| V-GEO-4 | FR-GEO-5 | Go: 커밋이 있는 저장소에서 필터가 아무것도 못 찾으면 `initial` 은 거짓이다 (관측이 그렇게 말한다) |
| V-GEO-5 | 회귀 | e2e V-GDT-12 가 CI Windows 에서 초록 |

## 5. 결정 (Decisions)

- **D-GEO-1 서버에서 고친다.** 클라이언트가 status 를 따로 보고 문구를 고르게 할 수도
  있으나, FR-GDT-21 이 *"서버가 그 둘을 가른다"* 로 정했다. 사실의 자리를 둘로 두면
  한쪽만 고쳐진다.
- **D-GEO-2 캐시를 버리지 않는다.** 대부분의 회차에서 관측은 이미 있고, 그때는 종전처럼
  git 을 실행하지 않는다. 새로 관측하는 것은 빈틈 하나 — 관측이 아직 오지 않은 첫 회차뿐이다.

## 6. 리스크

| 위험 | 정도 | 대응 |
|---|---|---|
| 필터가 아무것도 못 찾는 요청마다 관측이 한 번 더 돈다 | LOW | 관측이 없을 때만이고, 그 관측은 캐시에 남아 다음 회차는 git 을 실행하지 않는다 |

## 7. 비목표 (Non-goals)

- 클라이언트가 status 도착 뒤 History 를 다시 받게 하지 않는다 — 서버가 첫 응답에서
  맞게 말하면 필요 없다.
