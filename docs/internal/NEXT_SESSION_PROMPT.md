<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 이어서 작업한다. 브랜치 `fix`, 작업 트리 clean.
**푸시는 지시 없이 하지 마라** — 내가 직접 한다.

## 먼저 알아야 할 것 — 지난 판이 무엇을 끝냈나

사용자 지시는 **"vsc git, gitgraph 에 있는 모든 gui 기능은 다 넣는다"** 였다.
`docs/internal/GIT_SURFACE_MAP.md` 자체가 그 둘에서 뽑은 지도이므로 지도가 곧
범위다. 126항목을 소스와 전수 대조해 **미구현 33항목**을 `GIT_ACTIONS_SRS.md`
(FR-GIT-250~285 · V171~V213)로 확정하고, 묶음 A~G 와 Console 을 구현했다.

| 묶음 | 내용 | 상태 |
|---|---|:--:|
| A | 진행 중 작업(merge·rebase·cherry-pick·revert)의 상태와 출구 | ✅ |
| B | 브랜치 rename·delete·merge·rebase·upstream·push · 원격 브랜치 메뉴 | ✅ |
| C | 태그 생성·삭제(로컬/원격)·푸시 | ✅ |
| D | 커밋 cherry-pick·revert·reset·drop·compare | ✅ |
| E | remote 목록·add/remove · Sync · Push preview | ✅ |
| F | stash branch·필터 · .gitignore · Open File (HEAD) · File history · 미커밋 행 | ✅ |
| G | hunk·줄 범위 부분 스테이징 | ✅ |
| H | Console 의 검색·replay (FR-GIT-281) | ✅ |

전량 e2e **511 통과 · 실패 0**, `go test ./internal/...` 전량 통과.

## 이번에 할 일 — 남은 6건

출발점은 **`docs/internal/GIT_ACTIONS_SRS.md` §6.1(상태)과 §6.2(착수점·먼저 정할
것)** 다. 항목마다 "어느 파일 어느 심볼을 열면 되는지" 와 "무엇을 먼저 정해야
하는지" 를 조사해 적어 뒀다 — **조사부터 다시 하지 마라.**

| # | 요구사항 | 규모 |
|---|---|---|
| **FR-GIT-276** | Blame | 중간. 조회(`query/blame.go`)를 새로 만들고 `blame` 을 읽기 가드에 더해야 한다. **어디에 그릴지가 결정이다** — 고정 탭은 7개다 |
| **FR-GIT-280** | 커밋 mute · reflog 포함 | 작다. 목록 질의의 인자와 화면 상태다 |
| **FR-GIT-282** | author override · 리포 전환 드롭다운 | 작다. `CommitOpts` 에 필드가 없고, 드롭다운의 정보원은 이미 있다 |
| **FR-GIT-283** | 3-way merge editor | **가장 크다.** Monaco 위의 별도 모드 |
| **FR-GIT-284** | 인터랙티브 rebase | **가장 크다.** `GIT_SEQUENCE_EDITOR` 를 우리가 대신해야 한다 — §6.2 의 주의를 반드시 읽어라 |
| **FR-GIT-285** | clone / init | 작다. 다만 clone 은 자격증명에 걸린다 |

**권고 순서: 280 → 282 → 285 → 276 → 283 → 284.** 앞의 셋은 작고 서로 독립이라
하나씩 끊어 커밋할 수 있다. 그래도 이건 **권고지 결정이 아니다** — 어디부터 갈지,
그리고 283·284 를 이번 판에 넣을지부터 나에게 물어라.

## 먼저 나에게 물어라

§6.2 의 "먼저 정할 것" 열이 그대로 질문 목록이다. 특히 이 셋은 답 없이는 구현이
갈린다.

- **276**: Blame 을 8번째 고정 탭으로 둘지, Diff 탭의 모드로 둘지.
- **284**: 인터랙티브 rebase 를 하려면 dongminal 이 `GIT_SEQUENCE_EDITOR` 자리에
  서는 작은 실행 파일이 필요하다. **그 표면을 열지.**
- **285**: clone 의 대상 경로를 서버가 정할지(worktree 의 FR-WKT-13 규약), 사용자가
  절대경로를 줄지.

그리고 §1.2 의 **미결 하나**가 아직 열려 있다: **자격증명 저장·중계**는 FR-GIT-104
의 의도적 배제이고 `TestNoCredentialFields` 가 필드 이름만으로 막고 있다. 되살리려면
그 보호 테스트를 여는 결정이 먼저다 — **묻지 않고 열지 마라.**

## 반드시 지킬 규약

### 1. 새 쓰기 동작은 4겹을 다 갖춘다 (FR-GIT-250)

지난 판이 이 계약으로 30개 넘는 동작을 올렸다. 형식을 배우려면
`write/operation.go` + `gitapi/handlers_git_operation.go` 를 읽어라 — 가장 최근에
같은 계약으로 쓴 코드다.

1. `domain/git/write` 에 **순수 `…Args()`** 와 실행 함수. `…Args` 는 git 을 돌리지
   않고 argv 만 만든다 — 서버가 잘못된 요청을 **실행 전에** 400 으로 답해야 하고,
   테스트가 "무엇을 실행하지 않았는가" 를 볼 수 있어야 한다.
2. 실행은 `s.ExecWrite(... WriteSpec{Argv, Destructive})` 하나만 지난다.
   **파괴 여부는 옵션에서 파생해 선언한다** (`reset --soft` 는 안전, `--hard` 는 아님).
3. 엔드포인트는 `gitResolveRepo` → `gitStatusBefore` → `gitApply` → `gitWriteOK`,
   본문에 `ok:true`.
4. 화면은 `GIT_MENUS` 선언 하나. **확인 코드를 항목이 쓰지 않는다** — `warn:true` 는
   1단계, `destructive:true` 는 2단계를 프레임워크가 자동으로 거친다.

파괴적 동작은 `core.DestructiveActions` 에 이름이 있어야 하고, recovery hint 는
**되살릴 수 있는 명령**이다 (FR-GIT-92) — 안내문만 남기지 마라. ref 를 옮기거나
지우는 동작은 **옮기기 전 oid** 를 hint 에 싣는다.

### 2. 거부 사유는 **누른 자리**에 보인다

지난 판에서 두 번 물렸다. `applyWriteFail` 의 안내 줄(`.git-partial-note`)은
**Changes 탭 골격에만** 있다 — Diff·History·Worktrees 에서 낸 실패는 화면에 아무
자국도 남기지 않는다. 새 동작을 다른 탭에 붙이거든 그 탭의 안내 자리를 함께 만들어라
(부분 스테이징이 `.git-hunk-note.fail` 로 그렇게 했다).

### 3. FR-RPT — 바깥 계기의 다시 그리기

폴링·SSE 로 다시 그리는 목록은 요소를 새로 만들지 않는다. 수단은
`web/js/ui/repaint.js`(`paintIfChanged`·`reconcileList`), 계약은
`e2e/repaint.spec.ts`. **판정 근거(`sig`)에는 그 렌더러가 읽는 값 전부**를 넣어라 —
빠뜨리면 그 값이 화면에서 조용히 갱신되지 않는다. 그리고 **판정을 그리기에 업지
마라** (FR-RPT-8): 값이 도착하는 자리에서 해라.

### 4. 자격증명을 담는 필드를 만들지 않는다 (FR-GIT-104)

새 옵션 구조체에도 같다. `TestNoCredentialFields` 가 **필드 이름만으로** 막는다.

## 테스트

- **Go 단위·핸들러 테스트를 먼저 쓴다.** RED 를 확인하고 GREEN 으로 간다.
- **e2e 는 순차로만 돌아간다** — playwright 가 포트 58147 하나를 고정으로 쓴다
  (`playwright.config.ts`). 병렬 작업자를 띄우거든 e2e 는 **작성만** 시키고 실행은
  통합하는 쪽에서 한 번에 해라. 지난 판이 그렇게 했고, 작업자들이 못 돌린 e2e 에서
  실제 결함이 여섯 개 나왔다.
- 전체 실행은 `npx playwright test --retries=1` 로. 간헐 실패의 성질은
  `GIT_REMAINING.md` §5 에 있다.
- e2e 를 쓸 때 지난 판이 헛짚은 것 셋: ① **확인 창은 실행보다 먼저 닫힌다**
  (`GitMenu._pick` 이 확인 뒤에 `run`) — 창이 사라진 것은 시작 신호이지 완료 신호가
  아니다. ② 다이얼로그의 promise 는 **닫힐 때** resolve 한다 — `await` 하면 여는
  쪽에서 멈춘다. ③ 표식 문자열이 서로의 부분 문자열이면 안 된다(`TWENTYFIVE` 가
  `FIVE` 를 품는다).

## 병렬로 돌릴 생각이라면

지난 판은 6개를 각자 worktree 에 띄워 병합했다. 그때 실제로 물린 것:

- **worktree 는 HEAD 에서 갈라진다.** 커밋하지 않은 전제는 작업자에게 보이지 않는다 —
  전제를 먼저 커밋하고 띄워라.
- 충돌은 다섯 파일에서만 났다: `constants.js` · `menu.js` · `panel.js` ·
  `routes.go` · `core/guard.go`. **파일 소유를 미리 갈라 배분하면 병합이 기계적이다.**
- `constants.js` 에 **같은 이름의 `const` 가 두 번** 들어가면 고전 스크립트가 그
  파일 전체를 죽인다 — 화면이 아예 뜨지 않는다. 병합 뒤
  `grep -o "^const [A-Z_0-9]*" web/js/core/constants.js | sort | uniq -d` 를 반드시 돌려라.
- 소스를 훑는 가드 테스트가 `.claude/worktrees/` 의 사본까지 세지 않도록 이미
  제외해 뒀다.

## 마지막으로 — 서버 재시작

**지금 돌고 있는 dongminal 서버는 오늘 09:20 빌드라 위 작업이 하나도 들어 있지
않다.** 재시작해야 화면에서 볼 수 있고, 재시작하면 이 세션이 든 터미널 탭도 함께
끊긴다. 사용자에게 그 사실을 알리고 **사용자가 직접 하게** 해라.
