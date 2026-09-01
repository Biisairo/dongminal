# SRS: 통짜 파일 넷의 분할 — IEEE 29148

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

이 저장소는 이미 두 번의 구조 리팩터를 통과했다. `PACKAGE_RESTRUCTURE_SRS` 가
`internal/` 을 프로세스 축으로 세웠고, `DEEPENING_REFACTOR_SRS` 가 얕은 모듈
여섯을 깊이화했다. 남은 것은 **깊이의 문제가 아니라 자리의 문제**다.

근본 문제는 파일이 크다는 것이 아니라 — **이 저장소가 이미 확립한 분할 관행을
네 파일만 따르지 않고, 그래서 그 파일들에서는 "어디를 고쳐야 하는가" 가 파일
이름으로 답해지지 않는다는 것**이다.

관행은 세 곳에 이미 서 있다:

```
web/js/core/   app.js + app-*.js 17개   — Object.assign(App.prototype, …) 증강 분할
internal/shared/toolhub/   attention.go · foreground.go · bracketpaste.go · hub.go
internal/webserver/domain/git/   core · query · write · store · jobs
```

관행을 따르지 않는 넷은 아래와 같고, 그중 셋은 **자기 안에 이미 경계선을 그려
두고 있다** — 자를 자리를 찾을 필요조차 없다:

```go
// internal/shared/toolhub/tool.go — 섹션 주석이 곧 파일 경계다
52:   // ── SafeConn ─────────────────────────────────────────
104:  // ── Tool ────────────────────────────────────────────
749:  // ── ToolManager ─────────────────────────────────────
1139: // ── persistence ──────────────────────────────────────
1240: // ── ToolManager: expanded ToolHub methods (DAEMON_SPLIT_SRS Phase 1) ──
```

```js
// web/js/git/panel.js — 한 파일에 최상위 정의가 셋이고 서로를 부르지 않는다
26:   class GitObserver      (52줄)   앱에 하나 — 관측
78:   class GitPanel         (2,690줄) 칸마다 하나 — 217 메서드
2843: class GitDiffView      (142줄)  뷰가 소유 — Monaco diff
```

### 1.2 범위 (Scope)

| 묶음 | 대상 | 현재 | 리스크 |
|---|---|---|---|
| **A** | `internal/shared/toolhub/tool.go` | 1,390줄 · 타입 3 | LOW |
| **B** | `web/js/git/panel.js` | 2,984줄 · `GitPanel` 217 메서드 | **MEDIUM** |
| **C** | `web/js/ui/file-tree.js` | 1,279줄 · `FileTree` 57 메서드 | LOW |
| **D** | `web/style.css` | 2,673줄 | LOW |

**미포함:** §5 비목표 참조.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **구간 이동** | 원본의 라인 구간을 **한 글자도 고치지 않고** 다른 파일로 옮기는 것. 무동작변경이 검토가 아니라 diff 로 증명된다 |
| **프로토타입 증강** | `Object.assign(C.prototype, { … })` 로 클래스 본문 밖에서 메서드를 얹는 것. 번들러 없는 이 프론트엔드에서 클래스를 파일로 가르는 유일한 무동작변경 경로 |
| **접근자 제약** | `Object.assign` 은 getter/setter 를 **호출해 그 반환값을 복사**한다. 따라서 접근자는 증강으로 옮길 수 없고 클래스 본문에 남아야 한다 (`app.js` 가 이미 이 제약으로 접근자 11개를 남겼다) |
| **캐스케이드 보존** | CSS 를 파일로 가를 때 원본의 선언 **순서**가 유지되는 것. 같은 특정도의 규칙은 뒤가 이긴다 |
| **자산 잠금** | `web/assets.lock` — 브라우저로 나가는 자산이 바뀌면 `index.html` 의 `?v=` 도 올라야 한다는 계약을 테스트로 강제한 것 (`web/version_test.go`) |
| **탐색성** | "이 동작을 고치려면 어느 파일을 여는가" 에 파일 이름이 답하는 정도 |

### 1.4 참고 (References)

- `docs/internal/architecture.md` — 패키지 레이아웃, 프론트엔드 로드 순서 규약
- `docs/internal/PACKAGE_RESTRUCTURE_SRS.md` — 묶음 J (`app.js` 증강 분할)의 원본
- `docs/internal/DEEPENING_REFACTOR_SRS.md` — §7.5 · 비목표 N6 (본 SRS 가 뒤집는 판단)
- `docs/internal/archive/DAEMON_SPLIT_SRS.md` — `tool.go` 의 섹션 주석을 남긴 근거
- `docs/internal/SLOT_VIEW_STATE_SRS.md` — `GitObserver`/`GitPanel` 분리의 원본 (FR-SVS-30~45)

**요구 번호 접두어는 `FR-MSP`(Monolith SPlit) 다.** `FR-SPL` 은
`PACKAGE_RESTRUCTURE_SRS` 가 소유하며 `internal/shared/toolhub/doc.go:8` 이 그
번호를 인용하고 있다 — 같은 접두어를 다시 쓰면 그 인용이 어느 문서를 가리키는지
읽는 사람이 판정할 수 없다.

---

## 2. 전체 기술 (Overall Description)

### 2.1 현황 측정

| 항목 | 값 |
|---|---|
| Go 프로덕션 / 테스트 | 39,302 / 49,174 줄 |
| 프론트엔드 JS | 20,566 줄 (번들러 없음 — 로드 순서가 곧 의존성) |
| `web/style.css` | 2,673 줄 (단일 파일) |
| e2e 케이스 | 927 (87 스펙, 그중 git 32 스펙) |
| Go 테스트 패키지 | 33 (기준선 전량 통과) |
| Go 최장 함수 | 178줄 (`dmctlListWorkspace`) |

Go 함수 길이 분포는 건전하고, 실측한 중복 상위는 전부 **의도된 초크포인트 호출**
(`s.gitRepoParam` 20회 · `t.apply` 20회)과 import 라인이다. 회수할 중복이 없다.

### 2.2 비목표 N6 을 뒤집는 근거

`DEEPENING_REFACTOR_SRS` §7.5 는 `panel.js`·`file-tree.js` 를 남기며 이렇게
적었다:

> 크지만 **얕음의 증거를 못 찾았다.**

그 판단은 옳고, 본 SRS 는 그것을 뒤집지 않는다 — **판정 기준이 다르다.**

| | 깊이화 리팩터 | 본 SRS |
|---|---|---|
| 묻는 것 | 인터페이스가 구현만큼 복잡한가 | 고칠 자리를 파일 이름이 말하는가 |
| 고치는 것 | 계약 (호출부 시그니처가 바뀐다) | 자리 (한 글자도 안 바뀐다) |
| 값 | 복잡도 감소 | 탐색성 · 편집 충돌 감소 |

`GitPanel` 217 메서드는 **얕지 않다** — 각 메서드가 자기 몫의 일을 한다. 그러나
Changes 목록 렌더를 고치러 온 사람과 hunk 스테이징을 고치러 온 사람이 같은
2,984줄 파일을 열고, 두 변경이 같은 파일에서 충돌한다. 그것이 본 SRS 가 고치는
문제다.

### 2.3 제약 (Constraints)

| # | 제약 | 출처 |
|---|---|---|
| C-1 | `//go:embed js/*/*.js` 는 **정확히 2레벨**이다. 새 하위 폴더를 만들면 패턴을 함께 고쳐야 한다 | `web/embed.go:9` |
| C-2 | 자산을 고치면 `index.html` 의 `?v=` 와 `web/assets.lock` 을 함께 올려야 한다 | `web/version_test.go` |
| C-3 | 프론트엔드에 번들러가 없다. `index.html` 의 `<script>` 순서가 곧 의존성이며, 증강 파일은 클래스 정의 뒤·사용처 앞이어야 한다 | `architecture.md` |
| C-4 | `Object.assign` 은 접근자를 값으로 복사한다. getter/setter 는 클래스 본문에 남는다 | 접근자 제약 (§1.3) |
| C-5 | CSS 분할은 캐스케이드를 보존해야 한다 — `<link>` 순서가 원본 선언 순서와 같아야 한다 | 캐스케이드 보존 (§1.3) |
| C-6 | Go 는 타입 `T` 의 메서드를 `T` 를 선언한 **패키지**에만 둘 수 있다. 파일은 자유다 | Go 언어 규약 |
| C-7 | 외부 관측 동작(UI·HTTP/WS 계약·CLI 출력·바이트)은 불변이다 | 사용자 지시 |

### 2.4 가정 (Assumptions)

- 기준선이 통과한다. 실측으로 확인했다: `go build ./...` · `go vet ./...` ·
  `go test ./...` 33패키지 전량 통과 (exit 0).
- `diag_snapshot_test.go` 의 데이터 경쟁은 **이 리팩터와 무관한 기존 결함**이다
  (`DEEPENING_REFACTOR_SRS` §7.5). `-race` 없이는 통과하므로 기준선을 가리지
  않는다.

---

## 3. 상세 요구사항 (Specific Requirements)

### 3.1 묶음 A — `toolhub/tool.go` 분할

**FR-MSP-1** `tool.go` 1,390줄을 아래 다섯 파일로 가른다. 경계는 **파일이 이미
가진 섹션 주석**이며, 각 파일은 그 구간의 **구간 이동**이다.

| 새 파일 | 원본 구간 | 내용 |
|---|---|---|
| `conn.go` | 30–103 | 상수 · `Upgrader` · `SafeConn` |
| `tool.go` | 1–29, 104–748 | `toolRelay` · `Tool` (PTY · 주의 · 활동 · 클라이언트 · 쓰기 · 종료) |
| `manager.go` | 749–1138 | `ToolManager` 코어 |
| `persist.go` | 1139–1239 | 영속화 |
| `manager_hub.go` | 1240–1390 | `ToolHub` 확장 메서드 (DAEMON_SPLIT_SRS Phase 1) |

**FR-MSP-2** import 블록은 각 파일이 **실제로 쓰는 것만** 갖는다. Go 는 미사용
import 를 컴파일 오류로 막으므로 이것은 검토가 아니라 컴파일러가 강제한다.

**FR-MSP-3** 심볼의 export 여부·이름·시그니처는 **하나도 바뀌지 않는다.**
`tool.go` 는 같은 패키지이므로 참조처가 갱신될 일이 없다.

**FR-MSP-4** 원본의 섹션 구분선 주석(`// ── SafeConn ──` 등)은 제거한다. 그것이
있던 이유는 한 파일 안에서 경계를 눈으로 찾아야 했기 때문이고, 이제 **파일 이름이
그 일을 한다.** 남겨 두면 같은 사실이 두 곳에 적혀 한쪽만 낡는다. 이것이
FR-MSP-1 의 구간 이동에서 벗어나는 **유일한 편집**이며, 지우는 것이 주석뿐이므로
`go build` 와 §4.1 의 포함 검증이 함께 이를 확인한다.

### 3.2 묶음 B — `git/panel.js` 분할

**FR-MSP-10** 최상위 정의 셋을 파일로 가른다. 셋은 서로를 **정의 시점에**
부르지 않으므로 로드 순서만 지키면 된다.

| 새 파일 | 원본 구간 | 내용 |
|---|---|---|
| `git/observer.js` | 1–77 | 파일 헤더 · `GitObserver` |
| `git/panel.js` | `GitPanel` 클래스 본문 (축소) | `constructor` · 접근자 24쌍 · `repo` getter |
| `git/diff-view.js` | 2779–2984 | 헬퍼 5 · `GitDiffView` |

**FR-MSP-11** `GitPanel` 의 메서드 217개를 **주제별 증강 파일 일곱**으로 옮긴다.
각 파일은 `Object.assign(GitPanel.prototype, { … })` 하나를 갖는다.

| 새 파일 | 주제 | 원본 구간 |
|---|---|---|
| `panel-life.js` | 리포 전환 · 뷰 루트 · 파괴 · 소실 복구 | 155–439 |
| `panel-changes.js` | Changes 탭 — 목록 · 트리 · 그룹 · 머리 | 440–988 |
| `panel-views.js` | 뷰 지연 생성 · 상태 접근 · 브랜치/태그 파사드 | 989–1211 |
| `panel-write.js` | 쓰기 한 번의 전과 후 — 후처리 훅 · 결과 해석 · HTTP · 오퍼레이션 | 1212–1322 **＋** 1601–1748 |
| `panel-files.js` | 파일 작업 · 선택 · 스테이징 · discard | 1323–1600 |
| `panel-diff.js` | 선택 → diff · blame · hunk · 미리보기 | 1749–2292 |
| `panel-poll.js` | 레이아웃 선호 · 유틸 · 폴링 · 상태 적용 | 2293–2767 |

`panel-write.js` 만 구간이 둘인 이유는 **쓰기의 전과 후가 원본에서 떨어져
있었기** 때문이다. `after*Write` 훅(1212–1322)과 그 결과를 해석하는
`applyWriteFail`·`writeReason`(1601–1748)은 같은 한 번의 쓰기를 말하는데 그
사이에 파일 작업이 끼어 있었다. 구간을 잇는 것은 순서 변경이 아니다 — 메서드
정의 순서는 동작에 영향이 없다.

**FR-MSP-12** **접근자는 옮기지 않는다** (C-4). `GitPanel` 의 getter/setter 24쌍과
`repo` getter 는 클래스 본문에 남는다.

**FR-MSP-13** 메서드 본문은 **구간 이동**이다. `class` 본문의 메서드 문법
(`foo(){…}`)과 객체 리터럴 문법(`foo(){…},`)의 차이는 **끝의 쉼표뿐**이므로,
쉼표를 더하는 것 외의 편집을 하지 않는다.

**FR-MSP-14** `index.html` 의 로드 순서는 아래를 만족한다 (C-3):

```
git/api.js → git/observer.js → git/panel.js → panel-*.js 7개 → git/diff-view.js
  → 나머지 git/*.js (confirm · dialog · commit · lanes · menu · history · …)
```

`diff-view.js` 가 `panel-*.js` 뒤인 이유는 `GitDiffView` 를 **부르는** 것이
`panel-diff.js` 인데 그 호출이 **실행 시점**에 일어나기 때문이다 — 정의 순서는
자유지만, 읽는 사람에게 "패널이 쓰는 것" 임을 순서로 말한다.

### 3.3 묶음 C — `ui/file-tree.js` 분할

**FR-MSP-20** `FileTreeStore`(26–60)를 `ui/file-tree-store.js` 로 옮긴다.

**FR-MSP-21** `FileTree` 의 메서드를 증강 파일 셋으로 가른다.

| 새 파일 | 원본 구간 | 주제 |
|---|---|---|
| `file-tree.js` | 1–11, 61–223, 1277–1279 | 클래스 본문 · `constructor` · 접근자 9 · 마운트 · 파괴 |
| `file-tree-store.js` | 12–60 | `FileTreeStore` — 루트마다 하나인 관측 |
| `file-tree-paint.js` | 224–667 | 조회 · git 색 · 무시 · 항목 계산 · 그리기 |
| `file-tree-edit.js` | 668–865 | 생성 · 이름 변경 · 삭제 · 낙관적 갱신 |
| `file-tree-xfer.js` | 866–1274 | 다운로드 · 업로드 · 우클릭 · 드래그드롭 (`static` 4 포함) |

### 3.4 묶음 D — `style.css` 분할

**FR-MSP-30** `style.css` 2,673줄을 구간 그대로 넷으로 가른다. `<link>` 순서가
원본 순서와 같으므로 캐스케이드가 보존된다 (C-5).

| 새 파일 | 원본 구간 | 내용 |
|---|---|---|
| `style.css` | 1–825 | 토큰 · 사이드바 · 탑바 · 분할/슬롯 · pane · 터미널 · 모달 · 테마 · 상태바 · 모바일 |
| `style-git.css` | 826–1383 | Git 창 골격 · Changes · 다이얼로그 골격 · 커밋 영역 |
| `style-git-views.css` | 1384–2444 | diff · History · Console · Branches · Stash · Worktrees · 폼 · hunk · 원격 |
| `style-editor.css` | 2445–2673 | Editor 창 · 탐색기 트리 · 파일 조작 · 찾기 · 전송 |

Monaco 자체의 규칙(원본 787–799)은 `style.css` 에 남는다. 그것을
`style-editor.css` 로 옮기면 선언 순서가 바뀌고, **순서가 바뀌면 그것은 더 이상
구간 이동이 아니다** — 캐스케이드 동일성을 diff 로 증명할 수 없게 된다.

**FR-MSP-31** `web/embed.go` 의 `//go:embed *.css` 는 루트의 `.css` 를 전부
잡으므로 **패턴 변경이 필요 없다.** 새 파일을 루트에 두는 이유가 이것이다 (C-1).

### 3.5 비기능 요구 (Non-Functional)

**FR-MSP-40** 외부 관측 동작 불변 (C-7). UI 픽셀 · HTTP/WS 본문 · CLI 바이트가
같다.

**FR-MSP-41** 파일당 상한을 두지 않는다. 목표는 줄 수가 아니라 **주제 하나 =
파일 하나**다.

**FR-MSP-42** 모든 새 파일은 자기 첫머리에 **무엇이 여기 사는지와 왜 갈렸는지**를
적는다. 이름만으로 답하지 못하는 경계가 남으면 분할이 값을 못 번다.

**FR-MSP-43** `style.css` 분할 후 네 파일을 원본 순서로 이어 붙이면 원본과
**바이트가 같다.**

---

## 4. 검증 (Verification)

### 4.1 무동작변경의 증명 — 구간 이동은 diff 로 증명된다

구간 이동이므로 검증이 검토가 아니다. 각 묶음마다:

```bash
# 옮긴 구간이 원본과 같은가 (묶음 A·D)
diff <(git show HEAD:<원본> | sed -n '<구간>p') <(sed -n '<구간>p' <새파일>)
```

묶음 B·C 는 객체 리터럴 쉼표가 더해지므로 바이트 동일이 성립하지 않는다. 대신
**메서드 이름 집합의 동일성**을 검사한다:

```bash
# 분할 전후로 GitPanel.prototype 의 메서드 집합이 같은가
```

### 4.2 묶음별 회귀

| 묶음 | 검증 |
|---|---|
| A | `go build ./...` · `go vet ./...` · `go test ./...` |
| B | 위 + `npx playwright test e2e/git-*.spec.ts` (32 스펙) |
| C | 위 + `e2e/editor-explorer.spec.ts` · `explorer-transfer-ignore.spec.ts` · `file-transfer.spec.ts` |
| D | 위 + 전량 e2e (927 케이스) |

### 4.3 자산 잠금

묶음 B·C·D 는 브라우저 자산을 바꾸므로 `index.html` 의 `?v=` 를 올리고
`web/assets.lock` 을 새 해시로 갱신한다 (C-2). `web/version_test.go` 가 이것을
강제하므로 빠뜨리면 테스트가 실패한다.

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| N1 | 계약·시그니처 변경 | 이 SRS 는 자리만 옮긴다. 계약은 `DEEPENING_REFACTOR_SRS` 의 몫이고 그것은 끝났다 |
| N2 | `constants-git.js`(1,245줄) 분할 | 578개 상수가 **이미 주제별 섹션으로 정렬**돼 있고, 상수는 이름으로 grep 된다. "GIT\_ 상수는 여기 하나" 라는 단순함이 분할 이득보다 크다 |
| N3 | 700–1,100줄대 파일(`history.js`·`remote.js`·`branches.js`·`dmctl_run.go`·`run/store.go`·`handlers_fs.go`) 분할 | 각자 주제가 하나다. 이름이 이미 답한다 |
| N4 | 프론트엔드에 번들러·모듈 시스템 도입 | 파괴적 변경이고, 이 저장소는 "받아서 실행하면 끝" 을 값으로 삼는다 |
| N5 | `diag_snapshot_test.go` 의 데이터 경쟁 수정 | 무관한 기존 결함 (§2.4). 별도 결정이 필요하다 |
| N6 | 테스트 파일 분할 | 테스트는 대상 파일을 따라가지 않는다 — 주제를 따라간다. 지금 그렇게 돼 있다 |

---

## 6. 실행 순서와 리스크

| 순 | 묶음 | 리스크 | 근거 |
|---|---|---|---|
| 1 | A (`tool.go`) | LOW | 같은 패키지 내 구간 이동. 컴파일러가 전수 검사한다 |
| 2 | D (`style.css`) | LOW | 구간 이동 + `<link>` 순서. 바이트 동일이 증명된다 |
| 3 | C (`file-tree.js`) | LOW | 증강 분할. 대상 e2e 가 좁고 명확하다 |
| 4 | B (`panel.js`) | **MEDIUM** | 217 메서드. 접근자 제약(C-4)과 로드 순서(C-3)가 동시에 걸린다 |

A 를 먼저 하는 이유는 **Go 가 가장 강한 안전망**이기 때문이다 — 컴파일러가
누락·중복을 전부 잡으므로, 분할 절차 자체가 옳은지를 가장 싸게 확인한다.

B 를 마지막에 두는 이유는 리스크가 가장 크고, 앞의 셋이 절차를 검증해 주기
때문이다.

---

## 7. 실행 결과 (Outcome)

### 7.1 측정

| 대상 | 전 | 후 | 파일 |
|---|---|---|---|
| `toolhub/tool.go` | 1,390 | 674 (최대) | 5 — conn 88 · tool 674 · manager 408 · persist 112 · manager_hub 163 |
| `git/panel.js` | 2,984 | 567 (최대) | 10 — observer 66 · panel 89 · life 295 · changes 567 · views 227 · write 279 · files 289 · diff 563 · poll 487 · diff-view 216 |
| `ui/file-tree.js` | 1,279 | 455 (최대) | 5 — file-tree 178 · store 49 · paint 455 · edit 210 · xfer 424 |
| `style.css` | 2,673 | 1,070 (최대) | 4 — style 833 · git 566 · git-views 1,070 · editor 239 |

저장소 최대 파일은 **2,984줄 → 1,245줄**(`constants-git.js`, 비목표 N2)이 되었다.
분할 대상 넷 중 어느 것도 더 이상 저장소 최대가 아니다.

### 7.2 무동작변경의 증명

| 묶음 | 증명 |
|---|---|
| A | 원본 5구간이 새 파일에 **바이트 그대로 포함**됨을 확인. 미포함 비공백 행은 `package`·`import` 28행뿐 |
| D | 네 파일을 `<link>` 순서로 이어 붙이면 원본과 **바이트 동일** (130,529 B) |
| B·C | 클래스 멤버 이름 집합이 분할 전후 동일 — `GitPanel` 인스턴스 187 · static 1 · 접근자 23, `FileTree` 인스턴스 64 · static 4 · 접근자 9 |

B·C 가 바이트 동일이 아닌 이유는 **메서드 끝의 쉼표 하나**뿐이다 (FR-MSP-13).
분할 도구가 중괄호를 세지 않고 "다음 메서드 직전의 마지막 `}` 행" 으로 끝을
판정하므로, 문자열·정규식 안의 중괄호를 오판할 여지가 없다.

### 7.3 구현 중 드러난 것 — 선행 주석은 경계에서 떨어진다

구간 경계를 **메서드 시작 행**으로 잡으면 그 메서드를 설명하는 주석이 앞 구간에
남는다. 실제로 `file-tree.js` 의 `load`(주석 224–227)와 `download`(866–873),
`panel.js` 의 여섯 자리에서 그 일이 났다.

주석이 자기 대상과 떨어지면 분할이 값을 잃는다 — 옮긴 이유가 "함께 봐야 할 것을
함께 두는 것" 인데, 그 첫 문장이 다른 파일에 남는다. 그래서 경계를 선행 주석의
시작까지 **끌어올린다**(`snap_up`). 빈 줄에서 멈추므로 남의 주석까지 끌어오지
않는다.

### 7.4 검증 결과

| 검증 | 결과 |
|---|---|
| `go build ./...` · `go vet ./...` | 통과 |
| `go test ./...` | 33 패키지 전량 통과 |
| `scripts/check-seams.sh` | OS 이음매 누출 0 |
| e2e 전량 (`npx playwright test`) | **927 passed** (13.7분, exit 0) |
| 자산 잠금 (`web/version_test.go`) | `?v=213 → 214`, `assets.lock` 갱신 |

e2e 를 **전량** 돌린 이유는 묶음 D 가 캐스케이드를 건드리기 때문이다. CSS 는
`<link>` 순서 하나가 어긋나면 특정 화면에서만 조용히 틀어지므로, git 스펙만으로는
그것을 볼 수 없다.

### 7.5 남은 것

- **`constants-git.js`(1,245줄)** — 비목표 N2. 저장소 최대 파일이 되었으나, 578개
  상수가 주제별 섹션으로 이미 정렬돼 있고 상수는 이름으로 grep 된다. 분할이 값을
  버는지 **아직 증거가 없다.**
- **`diag_snapshot_test.go` 의 데이터 경쟁** — 비목표 N5. 무관한 기존 결함이며
  `-race` 없이는 통과한다.
- **`panel.js` 의 헬퍼 주석 두 개가 뒤바뀐 것** — `diff-view.js` 원본 2769~2778 에서
  `gitShQuote` 의 주석이 `gitHunkSpan` 앞에 있다. **기존 결함이며 구간 이동은 그것을
  고치지 않는다** — 고치는 것은 이 SRS 의 범위 밖이다.
