# SRS: 프론트 모듈 경계 — 거대 모듈 분리와 계층 역전 (IEEE 29148)

> **문서 상태**: 승인·구현완료
>
> 로드맵 §M6 ⑧(모듈 분리)의 스펙이다.
>
> 요구 번호 접두어는 **`FR-FMB`**(Frontend Module Boundary) 다. `FR-MSP` 는
> `SPLIT_REFACTOR_SRS` 가 소유하며 그 번호가 코드 주석에 인용돼 있다.

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

로드맵 §M6 의 여덟 번째이자 마지막 단계다. 앞의 일곱이 **동작**을 고쳤다면 이
단계는 **자리와 계약**을 고친다.

두 가지 서로 다른 문제를 다룬다. 섞으면 어느 쪽도 증명할 수 없으므로 묶음으로
가른다.

| | 묶는 것 | 묻는 것 | 고치는 것 |
|---|---|---|---|
| **자리** (`FE-9`~`13`) | 거대 모듈 다섯 | 고칠 자리를 파일 이름이 말하는가 | 자리. 한 글자도 안 바뀐다 |
| **계약** (`FE-4`) | 계층 역전 | 어느 것이 계약인지 말할 수 있는가 | 이름. 호출부가 바뀐다 |

**`SPLIT_REFACTOR_SRS` 가 이 저장소에서 같은 일을 한 번 했다.** 그 규약(구간
이동 · 프로토타입 증강 · 접근자 제약)을 그대로 쓴다. 이 문서가 새로 정하는 것은
**대상과 경계**이며, 방법은 인용한다.

### 1.2 범위 (Scope)

| 묶음 | 대상 | 현재 | 성격 | 리스크 |
|---|---|---|---|---|
| **A** | `core/constants-git.js` | 1,325줄 · 최상위 선언 445 | 구간 이동 | LOW |
| **B** | `core/app-settings.js` | 1,107줄 · 메서드 36 | 증강 분할 | LOW |
| **C** | `core/app-editor.js` | 1,254줄 · 메서드 55 | 증강 분할 | LOW |
| **D** | `git/branches.js` · `git/history.js` | 1,080 · 1,290줄 | 증강 분할 | MEDIUM |
| **E** | `ui/`·`git/` → `core/App` | distinct 156 · 참조 354 | **계약 변경** | **HIGH** |

**미포함:** §5 비목표 참조. 특히 `FE-23`(§4.4)은 **이미 닫혀 있었다.**

### 1.3 정의 (Definitions)

`SPLIT_REFACTOR_SRS §1.3` 의 정의를 그대로 쓴다 — **구간 이동** · **프로토타입
증강** · **접근자 제약** · **탐색성**. 아래 둘을 더한다.

| 용어 | 정의 |
|------|------|
| **정적 증강** | `Object.assign(C, { … })` — 클래스 **객체 자신**에 `static` 메서드를 얹는 것. `branches.js` 의 쓰기 동작 28개가 전부 `static` 이라 이 경로가 필요하다 |
| **승격** | `app._x` 를 `app.x` 로 바꾸어 **디렉터리를 넘는 이름을 공개로 표시**하는 것. 이름이 바뀌므로 구간 이동이 아니다 |

### 1.4 참고 (References)

- `docs/internal/SPLIT_REFACTOR_SRS.md` — **방법의 원본.** 구간 이동·증강 분할의 규약과 그 검증
- `docs/internal/APP_TESTING_CONTRACT_SRS.md` — 묶음 E 가 딛는 지도. `D-ATC-1` 이 *"한 절이 유난히 길면 그 축이 과하게 열려 있다"* 로 이 문서를 예고했다
- `docs/internal/CONFIG_MANAGEMENT_SRS.md` — `FE-23` 을 **이미 닫은** 문서 (§4.4)
- `docs/internal/architecture.md` — 프론트엔드 로드 순서 규약
- `docs/internal/production/02-fe-arch.md` — `FE-4`·`FE-9`~`13`·`FE-23` 의 원본 감사
- `docs/internal/production/PRODUCTION_ROADMAP.md` §M6 ⑧ — DoD

---

## 2. 전체 기술 (Overall Description)

### 2.1 현황 측정 (2026-09-12)

| 항목 | 값 |
|---|---|
| `web/js` 합계 | 38,586줄 |
| 500줄 초과 파일 | **27** |
| 최대 파일 | `ui/renderer.js` 1,336 |
| `app._xxx` — `ui/` | distinct **132** · 참조 **307** |
| `app._xxx` — `git/` | distinct **24** · 참조 **47** |
| `app._xxx` — `renderer.js` 하나 | distinct **55** · 참조 **106** |
| e2e 전량 | 1,591 항목 · unexpected 0 |

### 2.2 착수 조건은 갖춰졌다

`SPLIT_REFACTOR_SRS` 때와 달리 이번에는 **옮긴 것이 옳은지를 도구가 말한다.**
로드맵 §5-2 가 이 셋을 착수 조건으로 걸었고 셋 다 섰다.

| 도구 | 잡는 것 |
|---|---|
| eslint `no-undef` + `npm run typecheck` | 이름의 **존재** — 옮기다 떨어뜨린 것 |
| `scripts/check-load-order.mjs` | 이름이 서는 **시각** — 로드 순서 위반 |
| `scripts/check-e2e-private.sh` + `app.testing` | e2e 가 내부 이름에 결합되지 않음 — **묶음 E 가 e2e 를 깨뜨리지 않는 이유** |

**마지막 줄이 요점이다.** `app._x` 를 `app.x` 로 승격해도 e2e 는 한 줄도 바뀌지
않는다 — e2e 는 `app.testing.x` 만 보고, 그 이름과 내부 이름을 잇는 자리는
`app-testing.js` 한 파일이다 (FR-ATC-2).

### 2.3 제약 (Constraints)

| # | 제약 | 출처 |
|---|---|---|
| C-1 | `//go:embed js/*/*.js` 는 **정확히 2레벨**이다. 새 하위 폴더를 만들지 않는다 | `web/embed.go:10` |
| C-2 | 번들러가 없다. `index.html` 의 `<script>` 순서가 곧 의존성이며, 증강 파일은 **클래스 정의 뒤**여야 한다 | `architecture.md` · C-3 of `SPLIT_REFACTOR_SRS` |
| C-3 | `Object.assign` 은 접근자를 **값으로 복사**한다. getter/setter 는 클래스 본문에 남는다 | 접근자 제약 |
| C-4 | 자산 판은 `?v=__ASSETV__` 로 **내용에서 파생**된다. 손으로 올릴 것이 없다 | `ASSET_VERSION_SINGLE_SOURCE_SRS` |
| C-5 | 격리 하네스는 전역을 손으로 싣는다 — `reconnect-storm` 은 `term-pane.js` 를 홀로 싣는다. **상수를 옮기면 그 하네스가 죽는다** | `M6_NEXT_SESSION.md` "비싸게 배운 것" 4 |
| C-6 | e2e 단정 변경 **0** | 로드맵 §M6 DoD |
| C-7 | 외부 관측 동작(UI 픽셀 · HTTP/WS 본문)은 불변이다 | C-7 of `SPLIT_REFACTOR_SRS` |

### 2.4 가정 (Assumptions)

기준선이 통과한다. 실측으로 확인했다 (2026-09-12): `make gates` 23종 · `go test
./...` · `npm run lint` · `npm run typecheck` · `npm run unit` 90/90 전량 통과,
`make e2e` unexpected 0.

---

## 3. 상세 요구사항 (Specific Requirements)

### 3.1 묶음 A — `constants-git.js` 분할

**FR-FMB-1** `constants-git.js` 1,325줄을 아래 일곱으로 가른다. 경계는 **파일이
이미 가진 섹션 주석**(`// ── … ──` 20개)이며, 각 파일은 그 구간의 **구간 이동**이다.

| 새 파일 | 원본 구간 | 내용 |
|---|---|---|
| `constants-git.js` | 1–122 | 창 · 고정 탭 · 뷰 필드 · 진입점 · 좌측 GIT 섹션 |
| `constants-git-changes.js` | 123–485 | Changes · 소실 · 스테이징 · 서브모듈 알림 · 툴팁 |
| `constants-git-commit.js` | 486–694 | 커밋 · 파괴적 동작 확인 · 다이얼로그 골격 · 감지 2계층 |
| `constants-git-diff.js` | 695–808 | Diff · Console |
| `constants-git-history.js` | 809–977 | History · 커밋 상세 · 컨텍스트 메뉴 프레임워크 |
| `constants-git-refs.js` | 978–1099 | Branches · Stash |
| `constants-git-remote.js` | 1100–1325 | 원격 작업 · Worktrees · Submodules |

**FR-FMB-2** 섹션 구분선 주석은 **제거한다** — 파일 이름이 그 일을 한다
(`FR-MSP-4` 와 같은 근거). 이것이 구간 이동에서 벗어나는 유일한 편집이다.

**단, 구분선이 든 SRS·FR 앵커는 새 파일의 머리로 옮긴다.** 파일 이름이 대신하는
것은 *주제*이지 *근거*가 아니다 — `// ── Changes 탭 (GIT_SRS §3.3 /
FR-GIT-32~42) ──` 에서 이름이 지우는 것은 앞쪽뿐이고, 뒤쪽을 함께 버리면 "이
상수들이 무엇을 구현하는가" 로 가는 길이 끊긴다. 이 저장소에서 그 길은
양방향이다 — 게이트가 문서와 코드를 서로 잡는다.

**FR-FMB-3** `SPLIT_REFACTOR_SRS` 비목표 **N2 를 뒤집는다.** 당시 근거는 *"578개
상수가 이미 주제별 섹션으로 정렬돼 있고 상수는 이름으로 grep 된다 — 분할이 값을
버는지 **아직 증거가 없다**"* 였다. 증거가 생겼다:

  · 그 사이 파일이 **1,245 → 1,325줄**로 자랐다. 섹션이 이미 스무 개다
  · `constants-git-actions.js`(211 선언)가 **이미 갈라져 나와** 같은 이름 공간을
    `constants-git-*.js` 규약으로 쓰고 있다 — 관행이 생겼고 이 파일만 안 따른다
  · M9(i18n)가 문구를 카탈로그로 외부화할 때 **탭이 그 단위**다. 지금 가르면
    그때 여는 자리가 파일 이름으로 답해진다

**FR-FMB-4** 변수 선언(`var gitStatusInterval` 등 3개)은 그 섹션을 따라간다.
`POLL_SETTINGS` 가 `get/set` 으로만 닿으므로(`app-polling.js:30`) 선언 파일이
바뀌어도 호출부가 바뀌지 않는다.

### 3.2 묶음 B — `app-settings.js` 분할

**FR-FMB-10** `app-settings.js` 1,107줄을 여섯으로 가른다. 원본이 이미
`Object.assign(App.prototype, {…})` 둘이므로 **객체 리터럴을 자르는 것**이 전부다.

| 새 파일 | 원본 구간 | 주제 |
|---|---|---|
| `app-settings.js` | 1–93, 398–562 | `SETTINGS_ACCESS` 서술자 표 · 모달 열기·적용·복원·초기화 |
| `app-settings-init.js` | 94–397 | 개별 설정의 초기화와 즉시 반영 (제목·탭폭·이름·키·이탈확인·가장자리·줄바꿈) |
| `app-settings-theme.js` | 563–715 | 테마 패널 · 미리보기 · 사용자 정의 편집 · 색 입력 |
| `app-settings-keys.js` | 716–781 | 단축키 목록 · 녹화 |
| `app-settings-sandbox.js` | 782–882 | 샌드박스 패널 |
| `app-settings-access.js` | 883–1107 | 접속 허용 목록(ACL) 패널 |

`app-settings.js` 만 구간이 둘인 이유는 서술자 표(`SETTINGS_ACCESS`, 22–93)가
**파일 머리에 있어야** 하기 때문이다 — 그것이 이 파일의 주제이고, 모달의
적용·복원이 그것을 돈다.

### 3.3 묶음 C — `app-editor.js` 분할

**FR-FMB-20** `app-editor.js` 1,254줄을 다섯으로 가른다.

| 새 파일 | 원본 구간 | 주제 |
|---|---|---|
| `app-editor.js` | 1–131 | 창 판정 · 루트 · 경로 파생 (나머지 넷이 딛는 기반) |
| `app-editor-sync.js` | 132–429 | 서버 목록 동기 · 창 재조정 · dirty 판정 · 트리 회수 |
| `app-editor-open.js` | 430–678 | 탭 이식 · 문서 열기 · dirty diff · 스토어 · 트리 |
| `app-editor-pane.js` | 679–1133 | git 폴링 · 핀 · 사이드 · 칸 · 클립보드 · 탭 재지정 · 삭제 확인 |
| `app-editor-section.js` | 1134–1254 | 사이드바 Editor 섹션 |

### 3.4 묶음 D — `git/branches.js` · `git/history.js` 분할

**FR-FMB-30** `branches.js` 1,080줄을 넷으로 가른다. **접근자가 없으므로**(실측)
C-3 이 걸리지 않는다.

| 새 파일 | 원본 구간 | 주제 | 증강 대상 |
|---|---|---|---|
| `branches.js` | 1–205, 479–513 | 클래스 본문 · 생성자 · 선택 · mount/unmount · 원격 · paint 진입 · `_load` | — |
| `branches-tree.js` | 206–478 | 트리 그리기 — 그룹 · 접두어 · 행 · 즐겨찾기 · 접힘 | `GitBranches.prototype` |
| `branches-ops.js` | 514–889 | 쓰기 동작 28 — 체크아웃 · 생성 · 삭제 · 병합 · 리베이스 · 업스트림 · 푸시 | `GitBranches` (**정적 증강**) |
| `branches-dialogs.js` | 890–1080 | `GitBranchCreate` · `GitBranchRename` · `GitBranchUpstream` | — (구간 이동) |

**FR-FMB-31** `branches-ops.js` 의 28개는 전부 `static` 이므로 `Object.assign(
GitBranches, {…})` 로 얹는다 (정적 증강). `static async foo(){}` 와 객체 리터럴
`async foo(){},` 의 차이는 **`static` 과 끝의 쉼표뿐**이다.

**FR-FMB-32** `history.js` 1,290줄을 다섯으로 가른다.

| 새 파일 | 원본 구간 | 주제 | 증강 대상 |
|---|---|---|---|
| `history.js` | 1–405 | 클래스 본문 · 생성자 · reset · 팔레트(static 2) · mount/unmount · paint · 상태 · 옵션 바 | — |
| `history-refs.js` | 406–541 | refs 사이드바 · ref 선택·저장 · 행 높이 | `GitHistory.prototype` |
| `history-rows.js` | 542–794 | 가상 목록 · 행 · 미커밋 행 · 배지 · 레인 SVG | `GitHistory.prototype` |
| `history-detail.js` | 795–897 | 인라인 커밋 상세 · 파일 행 · 펼침 | `GitHistory.prototype` |
| `history-load.js` | 898–1290 | 요청 · 적재 · 검색 · 점프 · 스크롤 · 시간 포맷(static 2) | `GitHistory.prototype` + `GitHistory` |

**FR-FMB-33** 선행 주석은 경계에서 **끌어올린다**(`FR-MSP` §7.3 이 비싸게 배운
것). 메서드를 설명하는 주석이 앞 구간에 남으면 분할이 값을 잃는다.

### 3.5 묶음 E — 계층 역전 (`FE-4`)

**FR-FMB-40** `ui/`·`git/` 이 `core/App` 의 `_` 이름을 파고드는 것을 끊는다.
조치는 **승격**이다 — 디렉터리를 넘는 이름에서 `_` 를 떼어 공개로 표시한다.

**FR-FMB-41** **인터페이스 객체를 만들지 않는다** (`D-ATC-1` 과 같은 근거).
156개 이름을 되내보내는 객체는 결합을 이름만 바꾼 것이고, ui/ 가 내일 새 내부에
닿는 것을 아무것도 막지 못한다. 값은 **목록이 유한하고 diff 에 보이는 것**에서
나오며, 그것은 게이트가 준다 (FR-FMB-43).

**FR-FMB-42** 승격 대상은 **디렉터리를 넘는 이름만**이다. `core/` 안에서만 쓰이는
`_` 이름은 그대로 둔다 — 그것은 진짜로 내부다. 판정은 실측으로 한다:

    ui/ 와 git/ 에서 참조되는 app._xxx 의 이름 집합

**FR-FMB-43** 게이트 `scripts/check-layer.sh` 를 세운다 — **`core/` 밖에서
`app._` 를 쓰면 잡는다.** 값을 옮기는 것보다 다시 흩어지지 않게 하는 것이
본체다 (로드맵 §5-1). 게이트는 탐침으로 검출을 확인하고 지운다.

**FR-FMB-44** `app-testing.js` 는 **승격을 따라간다.** 계약의 이름(`_` 뗀 것)은
바뀌지 않고, 그 뒤의 내부 이름만 바뀐다 — 그래서 **e2e 는 한 줄도 바뀌지
않는다**(C-6). 고칠 자리는 `APP_TESTING_NAMES` 한 자리다 (FR-ATC-2).

**FR-FMB-45** 승격은 이름만 바꾼다. 시그니처·동작·호출 순서는 불변이다.

### 3.6 비기능 요구 (Non-Functional)

**FR-FMB-50** 외부 관측 동작 불변 (C-7).

**FR-FMB-51** 파일당 줄 수 상한을 두지 않는다. 목표는 줄 수가 아니라 **주제
하나 = 파일 하나**다 (`FR-MSP-41`).

**FR-FMB-52** 모든 새 파일은 첫머리에 **무엇이 여기 사는지와 왜 갈렸는지**를
적는다 (`FR-MSP-42`).

**FR-FMB-53** `index.html` 의 로드 순서는 **증강 파일이 클래스 정의 뒤**를
만족한다 (C-2). `check-load-order.mjs` 가 이것을 강제한다.

**FR-FMB-54** `architecture.md` 의 로드 순서 규약을 **같은 변경에서** 고친다.

---

## 4. 검증 (Verification)

### 4.1 무동작변경의 증명

| 묶음 | 증명 |
|---|---|
| A | 새 일곱을 원본 순서로 이어 붙이면 원본과 **바이트가 같다** (섹션 주석·파일 머리 제외) |
| B·C | `App.prototype` 의 메서드 이름 집합이 분할 전후 **동일** |
| D | `GitBranches`·`GitHistory` 의 인스턴스·정적 멤버 이름 집합이 분할 전후 **동일** |
| E | 바이트 동일이 성립하지 않는다 — 이름이 바뀐다. 대신 **참조 수의 보존**을 잰다: 승격 전 `app._x` N회 = 승격 후 `app.x` N회 |

### 4.2 묶음별 회귀

| 묶음 | 검증 |
|---|---|
| A | `make gates` · `npm run lint` · `npm run typecheck` · `npm run unit` · `npx playwright test e2e/git-*.spec.ts` |
| B | 위 + `settings-*.spec.ts` · `access-allowlist` · `sandbox-pick` · `panel-shortcuts` |
| C | 위 + `editor-*.spec.ts` · `explorer-*.spec.ts` · `file-transfer` |
| D | 위 + `git-branches` · `git-history` · `branch-menu-unify` |
| E | 위 + **전량 `make e2e`** |

**E 가 전량인 이유**: 승격은 156개 이름을 354곳에서 바꾼다. 한 자리를 놓치면
`undefined` 가 되고, `typeof` 가드가 삼키는 자리에서는 **조용히 아무 일도 일어나지
않는다** (`FR-WBR-95` 가 기록한 실패 모드). 게이트와 typecheck 가 대부분을
잡지만, 마지막 확인은 실행이다.

### 4.3 DoD 수치

분할 후 **500줄 초과 파일 수**와 **최대 파일 줄 수**를 기록한다 (로드맵 §M6 DoD).
기준선은 §2.1 이다 — 27파일 · 최대 1,336.

### 4.4a `TEST-6` 은 닫혀 있지 않았다 — **게이트가 재던 것이 실제와 달랐다**

묶음 E 가 승격을 마치자 e2e 가 무너졌다. `scripts/check-e2e-private.sh` 는
**초록이었다.**

원인은 그 게이트의 정규식 하나다:

    grep -rnE '\bapp\._[A-Za-z0-9_]' e2e/

이 꼴은 **셋 중 하나**만 잡는다.

| 꼴 | 예 | 잡혔나 |
|---|---|---|
| 직접 | `app._aw()` | ✅ |
| 옵셔널 체이닝 | `app?._editors` | ❌ — `\bapp\._` 는 `?.` 를 넘지 못한다 |
| 별칭 | `const a = window.app; a._aw()` | ❌ — 수신자 이름이 `app` 이 아니다 |

새어 나간 양은 **352곳 · 52파일 · 이름 57개**였다. `TEST-6` 이 이관했다고 적은
507곳과 **별개**이고, 로드맵 §M6 의 DoD *"스펙의 `app._xxx` 직접 접근 grep
0건"* 은 **그 좁은 grep 에 대해서만** 참이었다.

**이것이 이 마일스톤이 반복해서 만난 것의 또 한 사례다** — "통과하던 단정" 과
"재고 있던 단정" 은 다르다 (`M6_PROGRESS.md` §3-8). 게이트도 같다: **초록인
게이트와 재고 있는 게이트는 다르다.**

**FR-FMB-45a** 그 352곳을 계약으로 이관한다. 계약이 덮지 않던 이름 **23개**를
`APP_TESTING_NAMES` 에 더한다 (114 → **137**). 이름을 더하는 커밋이 "e2e 가
내부를 하나 더 보기 시작했다" 를 말한다는 규약(FR-ATC-2)은 그대로다.

**FR-FMB-45b** 게이트가 **세 꼴을 전부** 잡게 한다. 별칭은 선언을 읽어 찾되
RHS 가 정확히 `window.app`/`(window as any).app` 인 것만 별칭으로 본다 —
`const p = app.gitPanel` 의 `p` 는 App 이 아니다. 세 꼴 각각에 탐침을 넣어
검출을 확인하고 지운다.

**FR-FMB-45c** 그 과정에서 **아무것도 재지 않던 단정 하나**가 드러났다.
`mobile-keybar.spec.ts` 가 `window.App._modKbd` 를 읽는데 `window.App` 은
**존재한 적이 없다** — 늘 `null` 이라 그 아래 `if` 안으로 들어가지 못했다.
계약을 지나게 고쳐 실제로 재게 한다 (`git-console` K5 와 같은 부류, §3-8).

### 4.4 `FE-23` — **이미 닫혀 있었다** (판정)

감사(`02-fe-arch` D-1)의 근거는 *"설정이 전역 `var` 26개에 분산되고
`_settingsApply` 가 키마다 `if(saved.x!==undefined)` 분기를 손으로 쓴다 —
`POLL_SETTINGS` 표처럼 서술자 표로 통일하면 `saveSettings` 의 24개 키 나열도
파생된다"* 였다.

**그 조치는 `CONFIG_MANAGEMENT_SRS` 가 이미 했다.**

| 감사가 요구한 것 | 지금 |
|---|---|
| 서술자 표 | `SETTINGS_ACCESS` (`app-settings.js:22-93`) — FR-CFG-5 |
| 키마다 `if` 제거 | `_settingsApply` 가 `SETTINGS_SCHEMA` 를 **돈다** (`:436`) — FR-CFG-3 |
| `saveSettings` 의 나열 파생 | 같은 표에서 파생 — FR-CFG-6 |
| — | **게이트까지 있다**: `TC-CFG-1` 이 세 표(JS·Go·접근자)의 키 집합 동일성을 강제한다 |

주석이 그 이력을 스스로 적고 있다: *"종전에는 이 목록이 **세 벌**이었다 — PUT
본문의 인라인 나열 · `_settingsApply` 의 `if` 스무 갈래 · 이식 표."*

남은 것은 전역 `var` **21개**의 존재뿐인데, 그것은 감사가 든 문제(*"손으로 쓰는
분기"*)가 아니라 번들러 없는 구조의 결과다 — 표가 `get/set` 으로 그 변수에 닿는
길을 이미 쥐고 있다. **`GP-16` 과 같은 부류다: 감사가 그 시점 이전의 코드를 보았다.**

**되돌리려면 이 판정을 먼저 개정해야 한다** — 근거는 위 표다.

---

## 5. 비목표 (Non-Goals)

| # | 하지 않는 것 | 사유 |
|---|---|---|
| N1 | 계약·시그니처 변경 (묶음 A~D) | A~D 는 자리만 옮긴다. 계약은 묶음 E 의 몫이고 그것도 **이름만** 바꾼다 |
| N2 | `type="module"` 전환 (`FE-3` 중기분) | 파괴적이고, `FE-3` 의 DoD 는 **검사기**였다 (`check-load-order.mjs`). 그것은 섰다 |
| N3 | `ui/renderer.js` 분할 | 응집도가 있다 (`02-fe-arch` A-6: *"응집도는 있으나 `render()` 가 매번 전부 지난다"*). 그것은 `FE-14`·`FE-27`(합치기)의 문제이지 분할이 아니다. 묶음 E 가 이 파일을 열지만 **이름만** 바꾼다 |
| N4 | `helpers.js`(979) · `file-editor.js`(1,086) · `runs-panel.js`(936) 분할 | `FE-9`~`13` 에 없다. 각자 주제가 하나이고 이름이 이미 답한다 (`FR-MSP` N3 와 같은 근거) |
| N5 | 전역 `var` 21개의 제거 | §4.4. 서술자 표가 이미 그 변수에 닿는 길을 쥐었다. 없애려면 모듈 시스템이 필요하고 그것이 N2 다 |
| N6 | `render()` 합치기 (`FE-14`·`FE-27`) | 편승 규칙(로드맵 §5-1)이 *"M6 가 `renderer.js` 를 열면 함께"* 라 하지만, 묶음 E 는 이 파일의 **이름만** 만진다. 합치기는 동작 변경이고 그것을 같은 묶음에 넣으면 "이름만 바꿨다" 를 증명할 수 없다 |

---

## 6. 실행 순서와 리스크

| 순 | 묶음 | 리스크 | 근거 |
|---|---|---|---|
| 1 | A (`constants-git.js`) | LOW | 순수 구간 이동. 바이트 동일이 증명된다. 절차 자체를 가장 싸게 확인한다 |
| 2 | B (`app-settings.js`) | LOW | 이미 `Object.assign` 이다 — 객체 리터럴을 자르는 것이 전부다 |
| 3 | C (`app-editor.js`) | LOW | 같음. B 보다 크고 e2e 가 넓다 |
| 4 | D (`branches`·`history`) | MEDIUM | `class` 본문에서 꺼낸다. 정적 증강이 새 경로다 |
| 5 | E (`FE-4`) | **HIGH** | 156개 이름 · 354곳. 유일하게 이름이 바뀐다 |

A 를 먼저 하는 이유는 **가장 싼 안전망**이기 때문이다 — 바이트 동일이 성립하므로
분할 절차가 옳은지를 diff 하나로 확인한다.

E 를 마지막에 두는 이유는 리스크가 가장 크고, 앞의 넷이 파일 경계를 정리해
**승격할 이름이 어느 파일에 사는지**를 이미 말해 주기 때문이다.

---

## 7. 실행 결과 (Outcome)

### 7.1 측정

| 대상 | 전 | 후 (최대) | 파일 |
|---|---|---|---|
| `core/constants-git.js` | 1,325 | **359** | 8 — git 119 · changes 359 · commit 117 · detect 99 · diff 115 · history 169 · refs 123 · remote 227 |
| `core/app-settings.js` | 1,107 | **299** | 6 — settings 299 · init 283 · theme 160 · keys 67 · sandbox 102 · access 240 |
| `core/app-editor.js` | 1,254 | **328** | 6 — editor 115 · sync 328 · open 257 · pane 270 · file 232 · section 109 |
| `git/branches.js` | 1,080 | **378** | 4 — branches 226 · tree 298 · ops 378 · dialogs 216 |
| `git/history.js` | 1,290 | **405** | 5 — history 405 · refs 136 · rows 253 · detail 103 · load 393 |

**500줄 초과 파일: 27 → 22.** 저장소 최대 파일은 `ui/renderer.js` 1,336줄 그대로다
(비목표 N3 — 분할 대상이 아니다).

### 7.2 무동작변경의 증명

| 묶음 | 증명 |
|---|---|
| A | 최상위 선언 **445개 그대로**. 섹션 구분선 20개만 사라졌고 그 SRS·FR 앵커는 새 파일 머리로 옮겼다 (FR-FMB-2) |
| B | `App.prototype` 멤버 **40개 동일**. 멤버 본문의 비공백 **965행이 다중집합으로 동일** — 한 줄도 바뀌지 않았다 |
| C | 멤버 **72개 동일**. 비공백 1,147 → 1,146 — 차이는 `// ── 창 판정 ──` 구분선 하나뿐이고 그 앵커(FR-EDT-40)는 머리로 옮겼다 |
| D | `GitBranches` 61 · `GitHistory` 65 멤버 동일. 잃은 줄의 **100%가 허용된 두 편집으로 설명된다** — `static ` 제거 27, `}` → `},` 45(=옮긴 멤버 수) |
| E | 바이트 동일이 성립하지 않는다 (이름이 바뀐다). **전수성**으로 증명한다: 승격 뒤 `ui/`·`git/` 의 `app._` 가 **0곳**이고, 게이트가 그것을 세 꼴 전부에 대해 지킨다 |

**묶음 A 의 바이트 대조는 하지 못했다.** 기준선이 미커밋 상태였고 분할이 그것을
덮었다. 선언 수와 게이트로 갈음했다 — **B 부터는 분할 전 사본을 먼저 떴다.**

### 7.3 구현 중 드러난 것

**① 구분선이 든 것은 주제만이 아니다.** `FR-MSP-4` 를 따라 섹션 구분선을
지우려다, 그것이 **SRS·FR 앵커를 함께 들고 있다**는 것을 알았다. 파일 이름이
대신하는 것은 주제이지 근거가 아니다 — 앵커를 버리면 "이 상수들이 무엇을
구현하는가" 로 가는 길이 끊긴다. FR-FMB-2 를 그렇게 개정했다.

**② 객체 리터럴로 옮길 때 쉼표는 코드 행에 앉아야 한다.** 첫 분할 도구는
경계를 선행 주석의 시작까지 끌어올리되 빈 줄에서 멈췄고, 그래서
`// ── 절 ──` + 빈 줄 + `// 설명` + 멤버 꼴에서 **구분선이 앞 멤버의 끝에
남았다.** 거기 쉼표가 앉아 `// ── 접힘 ──,` 가 됐다. 경계를 뒤집어 잡았다 —
멤버의 끝은 **마지막 코드 행**이고 그 뒤의 주석은 전부 다음 멤버의 것이다.

**③ 게이트가 파일 이동을 잡았다.** `check-shortcuts-docs.mjs` 가
`_renderShortcutList` 를 `app-settings.js` 에서 찾다 실패했다 — 묶음 B 가 그것을
`app-settings-keys.js` 로 옮겼다. **사람이 읽어서는 알아채기 어려운 것**이고,
이것이 게이트가 있는 이유다 (M6 "비싸게 배운 것" 8 과 같은 형태).

**④ 승격의 안전망은 타입이 아니다.** 탐침으로 확인했다 — `app._mPaneIdx` 8곳을
일부러 남긴 채 `npm run typecheck` 가 **초록이었다**. `jsconfig.json` 이
`checkJs:false` 라 tsc 는 `web/js` 를 보지 않는다. 그래서 승격의 옳음은
"놓치지 않았다" 가 아니라 **"전수로 바꿨다"** 로 증명한다 — 전역 토큰 치환은
`grep` 으로 잔여 0 을 보일 수 있다.

**⑤ 격리 하네스가 분할에 죽었다 — 그리고 전량에서만 드러났다.**
`event-timer-hub-contract.spec.ts` 는 빈 페이지에 `constants-git.js` 와
`panel-poll.js` 만 얹어 계약을 잰다. 묶음 A 가 `GIT_FAIL_BACKOFF_MAX_MS` 를
`constants-git-detect.js` 로 옮기자 그 하네스가 `ReferenceError` 로 **결정적으로**
죽었다 — 5건.

C-5 가 이 위험을 이름까지 적어 두었는데도 놓쳤다. 이유는 **묶음 A 의 표적 검증이
`git-*.spec.ts` 였기 때문**이다. 그 하네스는 이름이 `git-` 으로 시작하지 않는다.
*"격리를 도입하는 변경은 그 격리가 드러낼 것까지가 그 변경의 범위"* (비싸게 배운
것 5)의 대칭이다 — **격리를 깨뜨리는 변경도 마찬가지이고, 둘 다 전량에서만
드러난다.**

고친 방식이 요점이다. 파일 목록을 하네스에 손으로 적지 않고 **`index.html` 의
스크립트 순서에서 파생시켰다.** 손으로 적으면 상수 하나가 다른 절로 옮겨 갈 때
같은 죽음이 되풀이된다 (비싸게 배운 것 2: *"손으로 적은 목록은 새 항목을
놓친다"*).

**⑥ 승격은 문서를 낡게 만든다.** 148개 이름이 `docs/` 537곳에서 인용되고
있었다. 코드 식별자를 가리키는 포인터이므로 함께 갱신했다. **`archive/` 15파일은
그대로 두었다** — 그것은 역사 기록이고, 그 시점의 이름이 그 시점의 진실이다.

### 7.4 검증 결과

| 검증 | 결과 |
|---|---|
| `make gates` | **24종** (계층 게이트 신설) 전부 통과 |
| `go test ./...` | 전량 통과 |
| `npm run lint` · `typecheck` | exit 0 |
| `npm run unit` | 90/90 |
| 묶음 A e2e (git 전량 + repo-tab) | **521 passed** |
| 묶음 B·C e2e (editor·explorer·settings·acl·sandbox) | **331 passed** |
| 묶음 D e2e (branches·history·stash·menu) | **76 passed** |
| 묶음 E | 전량 `make e2e` — **1,589 항목 · unexpected 0 · flaky 2**(샤드 4 부하) |

### 7.5 묶음 E 가 드러낸 것 — **승격은 기존 공개 이름과 부딪힌다**

전량에서 **광범위한 실패**가 났다. 원인은 둘이고 둘 다 같은 부류였다:

| 부딪힌 이름 | 무엇과 | 증상 |
|---|---|---|
| `_setFocus` → `setFocus` | App 의 **기존 공개 메서드** `setFocus(rid)` | 같은 객체에 정의가 둘 — 뒤가 앞을 덮고 59행이 자기를 다시 불러 **무한 재귀** |
| `_gitPanel` → `gitPanel` | App 의 **기존 접근자** `gitPanel` (`Object.defineProperty`) | getter 가 자기를 불러 `RangeError` |

**내 첫 충돌 검사가 접근자를 놓쳤다.** `^  (?:get|set)\s+` 만 보았고
`Object.defineProperty(App.prototype,'gitPanel',…)` 는 그 꼴이 아니다. 정의
형태 다섯(메서드 · 접근자 · `defineProperty` · `prototype.X=` · `this.X=`)을
전부 훑고 나서야 **둘뿐**임이 확정됐다.

고친 방식: 승격된 쪽에 **다른 이름**을 준다. 뜻이 다르기 때문이다.

    setFocus(rid)          사용자 제스처 — 창 소유권을 주장하고 장식을 걷는다
    setFocusState(rid,s)   포커스 불변식을 얹는 단일 진입점

    gitPanel               포커스 칸의 패널 (인자 없음, 접근자)
    gitPanelAt(root,slot)  (루트, 칸)으로 찾는 것

자리마다 어느 쪽이었는지는 **승격 전 스냅샷을 기준선 삼아** 행 단위로 갈랐다 —
승격 뒤에는 둘이 같은 이름이라 코드만 보고는 구분할 수 없다. 이것이 §7.3 ④
("승격의 옳음은 전수로 증명한다")의 대가다: 전수로 바꾸면 **바꾸지 말았어야 할
것까지** 바뀌고, 그것을 되돌리려면 바꾸기 전의 사본이 있어야 한다.

**교훈**: 승격은 "이름을 공개로 표시하는 것" 이 아니라 **이름 공간을 합치는
것**이다. 합치기 전에 그 공간에 같은 이름이 있는지 보아야 한다.
