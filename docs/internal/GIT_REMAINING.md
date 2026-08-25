# Git 창 — 남은 작업과 알려진 결함

> MVP 코드는 1~20단계가 끝났다 (`525ca24`). 이 문서는 **아직 끝나지 않은 것만**
> 담는다. 완료된 설계 근거는 `./design/`, 요구사항은 `./GIT_SRS.md` 다.
>
> 작성: 2026-08-26

---

## 1. 미구현 요구사항 2건 (P0 — MVP 범위 안이다)

둘 다 `web/js/git-menu.js` 의 **커밋 우클릭 메뉴**에 있고, "M5 에서 제공됩니다"로
막아 둔 채 남았다. 막을 당시(16·17단계)에는 M5 가 없었지만 **지금은 있다** —
`c9f8134`(서버)·`7dd4130`(클라)·`525ca24`(다이얼로그 규약)로 필요한 것이 전부 섰다.

### G-1. FR-GIT-141 — 커밋에서 "여기서 브랜치 생성"

| | |
|---|---|
| 위치 | `web/js/git-menu.js:28` — `{id:'branch-from', … disabled:()=>GIT_MENU_M5}` |
| 표면 지도 | S4 P0 (`GIT_SURFACE_MAP.md` §3 S4 / `GIT_SRS.md` §9 A.2) |
| 막힌 이유 | 16·17단계 시점에 `POST /api/git/branch` 와 생성 다이얼로그가 없었다 |
| 지금 있는 것 | `POST /api/git/branch`, `GET /api/git/branch/validate`(`ok`·`reason`·`exists`), `GitBranches` 의 생성 다이얼로그(FR-GIT-158), `GitDialog` 골격 |
| 할 일 | `disabled` 를 없애고 `run` 을 붙인다. **시작점을 그 커밋으로 고정**해 다이얼로그를 연다 (`startRef = target.oid`). 이름 검증은 입력 단계에서 `validate` 로 한다 (FR-GIT-159) |
| 주의 | `ok:true, exists:true` 는 규칙 위반이 아니라 "이미 있다" 다 — 다른 문구를 보여야 한다 |
| 고쳐야 할 e2e | `e2e/git-menu.spec.ts` **N7** — 지금은 "막혀 있고 사유를 보인다"를 고정한다. 실제 생성까지 확인하는 테스트로 바꾼다 |

### G-2. FR-GIT-144 — dirty 상태의 `Checkout (Detached)`

| | |
|---|---|
| 위치 | `web/js/git-menu.js:38` — `disabled:()=>panel.isDirty()? … +GIT_MENU_M5 : ''` |
| 요구 문면 | "detached 상태가 됨을 사전 경고하고, **dirty 상태면 묶음 P 의 처리를 따른다**" |
| 막힌 이유 | 묶음 N(dirty 3선택)과 묶음 P(다이얼로그 규약)가 아직 없었다 |
| 지금 있는 것 | `GitBranches` 의 dirty checkout 3선택(`취소` / `stash 후 진행` / `강제`), `GitConfirm` 2단계, `GitDialog` |
| 할 일 | dirty 일 때 차단 대신 **같은 3선택을 거치게** 한다. `GitBranches` 의 흐름을 재사용한다 — 같은 판정을 두 벌로 만들지 않는다 |
| 주의 | **기본은 취소다** (FR-GIT-97·157, O14). 강제는 파괴적이므로 `GitConfirm` 2단계 |
| 고쳐야 할 e2e | `e2e/git-menu.spec.ts` **N8** — 지금은 "막히고 사유를 보인다"를 고정한다. 3선택이 뜨고 기본이 취소임을 확인하는 테스트로 바꾼다. **N9(clean 경로)는 그대로 유효하다** |

### 왜 자동 감사가 이것을 놓쳤나 (다음에도 같은 함정이 있다)

FR 번호가 코드에 **언급되는지**만 기계로 확인하면 "막아 두고 사유를 보이는 것"도
통과한다. 실제로 이번에 `FR-GIT-1~178 전부 참조됨`이라는 감사가 초록이었는데
141·144 는 미구현이었다.

**감사할 때는 언급이 아니라 `disabled`·`pending`·"제공됩니다" 같은 차단 표식을
함께 훑어야 한다:**

```bash
grep -rn "disabled:()=>\|disabled: (" web/js/git-*.js
grep -rn "제공됩니다\|준비 중\|pending:true" web/js/constants.js
```

---

## 2. 의도적으로 남긴 것 (고치지 마라)

| 항목 | 근거 |
|---|---|
| **Console 탭이 "준비 중"** | `GIT_SRS.md` §5 비목표 — "Console 탭 **표시**는 P1. 자리(FR-GIT-28)와 기록(FR-GIT-5)은 MVP 에 포함, 화면만 이후". `internal/git` 의 `Recorder` 가 이미 실행을 기록하고 있으므로 화면만 붙이면 된다 |
| hunk/line 단위 스테이징 | 비목표 P1/P2 |
| 3-way merge editor · 인터랙티브 rebase | 비목표 P2 |
| 브랜치 삭제 · 태그 생성/삭제 · cherry-pick/revert/reset · merge/rebase 실행 | 비목표 P1. **메뉴 프레임워크(FR-GIT-146)가 자리를 열어 두었으므로 항목 선언만 더하면 된다** |
| 자격증명 저장·중계 | **의도적 배제** (FR-GIT-104). 되살리지 마라 |
| clone / init | 비목표 P2. 터미널로 충분 |

---

## 3. 21단계 — MVP 수동 검증 (V14 · V60 · V61)

자동 테스트가 덮지 못하는 것만 남았다. 절차와 항목은
[`GIT_MANUAL_CHECKLIST.md`](./GIT_MANUAL_CHECKLIST.md) 에 있다 (G1~G7 + 보안 S.1~S.4).

```bash
scripts/git_fixture.sh /tmp/dm-git-fixtures   # 저장소 10종, 2.3초
scripts/start.sh
```

- **G7(모바일 실기기)은 사용자만 할 수 있다.** iOS/Android 실기기 확인은 넘긴다.
- V61(GPG 서명)은 서명 키가 있는 환경에서만 실사할 수 있다.
- 결함이 나오면 **그 자리에서 고치지 말고 먼저 전부 훑는다.** 화면 배치·색·읽힘은
  스펙이 정하지 않은 것이 많으므로 **"결함"과 "취향"을 구분해** 기록한다.

---

## 4. 알려진 간헐 실패 (제품 결함 아님)

전체 e2e 348개 실행에서 **0~1건이 간헐적으로 실패한다.**

| 테스트 | 성질 |
|---|---|
| `background-restore-at` TC-BGR-9 | **Git 이전부터 있던 테스트.** "창이 비는 과도 상태를 명중" 시키려는 것이라 본질적으로 타이밍 의존이다 (실패 문구가 그렇게 말한다) |
| `git-stash` S2 · S3 | 우클릭 → 메뉴 항목 → git 상태 확인. 부하가 걸리면 기본 5초 단정이 흔들린다 |

확인한 근거:

- 단독 반복 **10/10 통과**, `e2e/git-*.spec.ts` **161개 전체 통과**
- 실패하는 테스트가 실행마다 다르다 — 특정 테스트의 논리 문제가 아니라 부하다
- `e2e/fixtures.ts` 머리말이 이 성질을 이미 설명한다: 고아 도구가 쌓이면 WS open 이
  늦어져 대기가 타임아웃한다
- **Stash 뷰의 폴링은 목록을 다시 그리지 않는다** (`paintStatus` 는 바만 갱신) —
  열린 컨텍스트 메뉴가 폴링에 닫히는 경합은 코드로 확인해 배제했다

**권고**: 전체 실행은 `npx playwright test --retries=1` 로 돌린다. 진짜 실패는 두 번
모두 실패하므로 게이트의 뜻이 약해지지 않는다.
`playwright.config.ts` 의 로컬 `retries` 를 1로 올리는 것은 게이트의 뜻을 바꾸는
결정이므로 **사용자 판단에 맡긴다** (CI 는 이미 `retries: 2` 다).

---

## 5. 이 트랙 밖의 남은 별건

`README.md` §남은 작업 과 중복이지만 여기 모아 둔다.

| 항목 | 상태 |
|---|---|
| 실제 격리 팀으로 한 바퀴 | 첫 격리 Run 은 새 worktree 경로가 신뢰 목록에 없어 폴더 신뢰 모달에 걸릴 수 있다 |
| iOS 실기기 확인 (모바일 키보드) | `test-checklist.md` C11.8~C11.10 |
| 워크스페이스 PUT 의 last-write-wins | 사람 둘이 각자 브라우저에서 동시에 편집하면 한쪽이 유실된다 (`WORKSPACE_IDENTITY_SRS` §2.4·§5) |
