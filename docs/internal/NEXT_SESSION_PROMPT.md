# 다음 세션 프롬프트

**현재 트랙: Git 창 — MVP 코드 · UI 개정 · 실사 결함 2건 완료. 남은 것은 로그 위생
1건 + 수동 검증 잔여 + 문서 흡수. 코드에 알려진 결함은 없다.**

아래 §1 지시 블록을 새 세션 첫 메시지로 붙여넣는다.

---

## 1. 새 세션에 붙여넣을 지시 블록

```
dongminal Git 창 트랙을 이어간다. **코드에 알려진 결함은 없다** — 남은 것은
수동 검증 잔여와 트랙을 닫는 문서 작업뿐이다.

읽을 것 (순서대로):
  docs/internal/GIT_REMAINING.md          ← 출발점. §1~§2 가 남은 일이다
  docs/internal/GIT_UI_REVISION_SRS.md    ← 개정 SRS (FR-GIT-179~226). GIT_SRS 보다 앞선다
  docs/internal/GIT_SRS.md                ← 원 명세 (FR-GIT-1~178) + §7.1 해석 I1~I9
  docs/internal/GIT_MANUAL_CHECKLIST.md   ← 실사 기록 1·2회차 + 예정 G8·G9

**먼저 사용자에게 어느 쪽으로 갈지 묻는다.** 둘은 성질이 다르고, 순서를 자기가
정하면 사용자가 원하지 않은 것에 시간을 쓴다.

  ① 검증 잔여 (GIT_REMAINING §1) — 실사다. 격리 인스턴스가 필요하다
      G8(2차 검토 후) · G9(3차 검토 후) · G6 상태바 chip 5건 · 보안 S.1~S.4 ·
      G1.10 · G4.6 · G4.8 · G5.12 · G5.13 · M2~M5 묶음의 수동 항목.
      **결함이 나와도 그 자리에서 고치지 말고 먼저 전부 훑는다** — 목록을 모은
      뒤 우선순위를 정한다.
      자동이 답하지 못하는 자리를 먼저 봐라: **G9.10**(rebase 충돌의 ours/theirs
      툴팁 — 뜻이 뒤집히는 곳) 과 **G8.6**(untracked 가 많은 리포에서 `-uall` 의
      체감 비용 — 이번 변경에서 유일하게 되돌릴 수도 있는 자리).
      S.1~S.4 는 자동화가 가능한 성질이다(로그·요청 본문·경로 거부). 실사로 한 번
      보고, 재발을 막을 값어치가 있으면 e2e/Go 로 굳힌다.

  ② 문서 흡수 (GIT_REMAINING §2) — 트랙을 닫는 일이다
      GIT_UI_REVISION_SRS 의 **FR-GIT-179~226** 을 GIT_SRS 본문에 흡수하고,
      폐기된 FR-GIT-27·30 을 본문에서 지운다. 개정된 13·28·35·41·69·195~197 은
      본문 쪽을 개정 문면으로 바꾼다. design/ 을 archive/ 로 옮기고
      GIT_SURFACE_MAP 의 P0 대응표에 개정을 반영한다.

작업 방식:
- 스펙이 이미 있으므로 각 항목은 **테스트 → 구현** 순서다.
- "고쳤다"의 근거가 코드가 아니라 테스트여야 한다.
- 각 항목이 끝나면 검증하고 커밋한다. 커밋 메시지에 AI 서명(Co-Authored-By 등)을
  넣지 않는다.

검증 (기준선: Go 전부 통과 / Playwright 397 + 알려진 flaky 1):
  go build ./... && go vet ./... && go test ./... -race && gofmt -l .
  npx playwright test --retries=1

  ※ --retries=1 의 근거는 GIT_REMAINING.md §4 에 있다. 전체 실행은 부하에 민감해
    0~1건이 간헐 실패하며 제품 결함이 아님을 확인했다. 진짜 실패는 두 번 모두
    실패하므로 게이트의 뜻은 그대로다.

화면을 봐야 하면 **격리 인스턴스**를 쓴다 (사용자가 쓰는 58146 을 건드리지 않는다):
  scripts/git_fixture.sh /tmp/dm-git-fixtures
  go build -o /tmp/dm-manual-bin ./cmd/dongminal
  PORT=58200 DONGMINAL_HOME=/tmp/dm-manual-home /tmp/dm-manual-bin
  → web/ 자산은 embed 라 고칠 때마다 다시 빌드해야 화면에 반영된다.

하지 말 것 (GIT_REMAINING.md §3):
- 비목표(hunk 스테이징·merge editor·인터랙티브 rebase·브랜치 삭제·clone/init 등)를
  구현하지 마라.
- 자격증명 저장·중계 경로를 만들지 마라. 의도적 배제다 (FR-GIT-104).
- 안내문·툴팁을 영어로 바꾸지 마라. 버튼만 영어다 (FR-GIT-202).
```

---

## 2. 감사할 때 조심할 것

### 2.1 "언급"과 "구현"은 다르다

FR 번호가 코드에 **언급되는지**만 기계로 확인하면 **"막아 두고 사유를 보이는 것"도
통과한다.** 실제로 `FR-GIT-1~178 전부 참조됨`이라는 감사가 초록이었는데 141·144 는
미구현이었다.

```bash
grep -rn "disabled:()=>\|disabled: (" web/js/git-*.js
grep -rn "제공됩니다\|준비 중\|pending:true" web/js/constants.js
```

### 2.2 "서버가 준다"와 "화면에 보인다"도 다르다

21단계 실사에서 나온 결함 2건이 **둘 다 그 모양이었다** — 서버는 옳은 값을 싣고
클라이언트가 그리지 않는다. API 응답만 보고 충족을 판단하지 마라. (둘 다 고쳤다.
아래 grep 은 다음 필드에 같은 감사를 걸 때의 본이다.)

```bash
# 서버가 주는 필드가 화면 코드에서 쓰이는지
grep -rn "lfsOid\|lfsSize" web/js/   # → 0건이면 안 그리고 있는 것이다
```

### 2.3 문자열 상수는 `window` 프로퍼티가 아니다

`constants.js` 의 `const` 는 `window.X` 로 읽히지 않는다 (e2e 에서 조용히
`undefined`). `function` 선언과 `window.X=X` 로 명시한 것만 붙는다. e2e 에서는
문자열 평가(`page.evaluate("THEMES['…']")`)로 전역 스코프를 읽는다.

### 2.4 `:checked` 는 즉시 다시 계산되지 않는다

`el.checked = true` 직후의 `getComputedStyle` 은 **이전 값**을 준다. e2e 에서
상태를 세우고 렌더 결과를 볼 때는 `expect.poll` 로 감싼다. 또 1초 폴링이 다시
칠하는 화면(Changes 의 amend)에서는 직접 세운 상태가 되돌아간다 — 다이얼로그처럼
다시 칠하지 않는 자리를 고른다.

---

## 3. 완료된 것 (기록)

### 3.1 Git 창 — 1~20단계 (이전 세션들)

기준선: `go test ./... -race` 전부 통과 · gofmt clean · Playwright **187 → 348**.

| 마일스톤 | 단계 | 커밋 |
|---|---|---|
| **M1 읽기** | 1 A · 2 B·C서버 · 3 D · 4 B클라 · 5·6 E·C클라 · 7 F · 8 G | `f455137` `cc62d09` `8ed0396` `72bbe00` `747db3a` `a9f244e` `f078fdf` `1493a8a` |
| **M2 커밋** | 9 J(안전 정책) · 10 H(스테이징) · 11 I(커밋) | `71ed098` `579a070` `54d869c` `5d25d65` |
| **M3 원격** | 12 job 인프라 · 13 K(fetch/pull/push) | `ef45143` `677b059` |
| **M4 히스토리** | 14 조회 · 15 레인 · 16·17 History+메뉴 프레임워크 · diff 축 | `a036af5` `6a01d4d` `a25abd0` `90d93a4` `5b649df` |
| **M5 참조** | 18 N(Branches) · 19 O(Stash) · 20 P(다이얼로그 규약) | `c9f8134` `7dd4130` `525ca24` |
| 기반 | 설계 계약 21단계 · 결정 O1~O14 · 해석 I1~I8 · 픽스처 10종 · 수동 체크리스트 · `-race` 게이트 복구 | `67bc325` `6157476` `ddb4307` `cece980` `a2c3abe` `b8a288a` |

### 3.2 21단계 이후 (2026-08-26)

| 커밋 | 내용 |
|---|---|
| `967c097` | **미구현 P0 2건** — FR-GIT-141 "여기서 브랜치 생성" · FR-GIT-144 dirty 의 Checkout (detached). 둘 다 기존 M5 자산을 재사용했다. 함께 `GitBranches.reload` 부재를 고쳤다 |
| `f6b0ef1` | **사용자 검토 UI 개정** — FR-GIT-179~210. Git 창을 닫힌 창으로(27·30 폐기), 파일 선택을 행 클릭+보조키로, GIT 섹션 이모지 제거, VSCode 치수 하한, 버튼 라벨 영문화, 폼 컨트롤 테마화 |
| `0ad7ba6` | **FR-GIT-211~213** — 트리 깊이 세로선 · 그룹 구분선 · 커밋 영역 정렬 |
| `12ed17d` | **D-1 / FR-GIT-119** — `defineTheme` 이 `diffEditor.*` 를 매핑하지 않아 diff 색만 Monaco 기본값에 고정됐다. 테마의 `terminal.green`·`red` 를 배경과 섞어 파생한다 (e2e D11) |
| `756b1b8` | **D-2 / FR-GIT-47** — 서버가 싣는 LFS 메타를 클라이언트가 그리지 않았다. 해석 I9 로 확정하고 FR-GIT-46·48 의 크기까지 함께 보인다 (e2e D12·D13) |
| `4c7151a` | **2차 사용자 검토 4건** — FR-GIT-215 untracked 디렉터리 붕괴(P0) · FR-GIT-216 섹션 경계 · FR-GIT-214 GIT 섹션 간격 · FR-GIT-217 취소 요청 499 |
| `04146a6` | **FR-GIT-218 Console 탭** — Recorder 의 실행 기록을 읽는 화면. `GET /api/git/records` + `GitConsole`. 폴링은 기본에서 감추고 토글로 연다 |
| `62cf54e` | **3차 사용자 검토 7건** — FR-GIT-219~224. 사이드바 배분 · 그룹 머리글 높이 · 끝난 작업 로그 접기 · 브랜치 더블클릭(두 자리) · 핀 드래그 정렬 · 충돌의 ours/theirs |
| `6bd2d69` | **정정·결함 4건** — FR-GIT-219 재해석(행 높이) · FR-GIT-226 치수 하한 30px · History 체크아웃이 되다 말던 원인 · 드래그 영역 밖 release · 더블클릭 글자 선택 |
| `fd78ae4` | **FR-GIT-226 보강** — 빈 refs 그룹의 머리글이 줄어들지 않는다 |

**함께 잡은 결함 5건** (전부 실사에서 나왔다):

| 결함 | 무엇이 잘못이었나 |
|---|---|
| `GitBranches.reload` 부재 | `afterRefWrite` 가 부르는데 없었다 → 두 뷰가 살아 있을 때 ref 쓰기가 TypeError. 성공한 조작이 다이얼로그에 사유를 안고 남았다 |
| follow 가 서버 cwd 로 넘어감 | 포커스가 터미널이 아니면 빈 `tool` 이 가고 서버가 자기 cwd 로 답했다 → 가 본 적 없는 리포가 follow 에 떴다. 마지막 터미널을 유지하도록 고쳤다 (FR-GIT-210) |
| 라디오가 타원 | 입력 높이 하한 `input:not([type=checkbox])` 이 라디오까지 잡아 14px 상자를 26px 로 늘렸다 |
| 커밋 옵션 메뉴가 잘림 | Commit 이 왼쪽으로 가면서 `right:0` 메뉴가 왼쪽으로 자라 `.git-view` 의 overflow 에 잘려 누를 수 없었다 |
| 드래그 높이가 도로 접힘 | 세로 flex 에서 textarea 가 `flex:1 1 auto` 라 줄어들었다. 높이는 `_grow()`·`_drag()` 가 정하므로 `flex:0 0 auto` |

### 3.3 구현 중 실측으로 잡은 함정 (다시 밟지 마라)

| 함정 | 결과 |
|---|---|
| `git log` 에 `-z` 를 주지 않으면 git 이 **레코드 사이에 개행을 끼운다** | 다음 레코드의 첫 필드가 오염돼 조용히 틀린 목록이 된다 |
| `git config --get` 은 **미설정 시 exit 1** | 오류로 올리면 identity 없는 저장소에서 preflight 자체가 막혀 차단 사유를 못 보인다 |
| 없는 blob 은 **exit 128** + `does not exist in 'HEAD'` | 오류로 올리면 새 파일·삭제 파일의 diff 가 전부 500 이 된다 |
| `git check-ref-format --branch '@{-1}'` 이 **exit 0 으로 다른 이름을 출력** | 종료 코드만 믿으면 사용자가 입력한 것과 다른 브랜치가 조작된다 (§7.1 I8) |
| `commit-parent` 축의 빈 `oid` 는 `:<path>` = **index** | 커밋 축이 조용히 다른 축이 된다 |
| `constants.js` 의 `const` 는 **`window` 프로퍼티가 아니다** | e2e 가 `window.X` 로 읽으면 조용히 undefined |
| 소스에 **리터럴 NUL 바이트** | grep·diff 가 파일을 바이너리로 취급해 조사 도구가 무력화된다 |
| CSS `background` 축약이 `background-image` 를 지운다 | 행 hover·선택이 트리 깊이 세로선을 함께 지웠다 (`background-color` 로 바꿔야 한다) |
| `web/` 자산은 `go:embed` 다 | 고친 뒤 **다시 빌드하지 않으면** 화면에 반영되지 않는다 |
| `git status` 의 `-u` 기본값(`normal`)이 **추적되지 않는 디렉터리를 접는다** | `newdir/` 한 줄만 오고 안의 파일이 하나도 열거되지 않는다. 항목이 파일이라고 전제한 화면에서 이름이 빈 행이 되고 클릭이 죽는다 (FR-GIT-215) |
| `getComputedStyle().getPropertyValue()` 는 **kebab-case 만 받는다** | `getPropertyValue('borderTopWidth')` 는 오류가 아니라 조용히 `''` 다 |
| 1초 폴링이 목록을 다시 그린다 | e2e 에서 밖에서 잡은 요소가 계산 시점에 떨어져 나가고, **떨어진 요소의 `getComputedStyle` 은 빈 값**을 준다. 조회와 계산을 한 번의 `evaluate` 안에서 한다 |
| 자격증명 정적 검사(V43)는 **이름만 본다** | 자격증명을 *지우는* 함수도 이름에 그 낱말이 있으면 잡힌다. 검사를 느슨하게 하지 말고 **이름을 바꾼다** (`RedactSecrets`) |
| 요소를 다시 만들면 **`dblclick` 이 죽는다** | 단일 클릭이 목록을 재렌더하면 두 번째 클릭이 새 노드에 떨어져 브라우저가 `dblclick` 을 만들지 않는다. 되다 말다 해서 e2e 가 타이밍으로 통과한다 — 뼈대가 같으면 요소를 다시 만들지 마라 (FR-GIT-222) |
| 문서 전역 DnD 수락 목록에 **새 타입을 빼면** | 항목 영역을 벗어난 release 가 조용히 아무 일도 하지 않는다. `input-binding.js` 의 `dragover`·`drop` 두 곳 모두에 넣어야 한다 (FR-GIT-223) |
| `git checkout --ours -- <p>` 는 **워킹 트리만 바꾼다** | index 의 unmerged stage 가 남아 파일이 충돌 목록에서 빠지지 않는다. `add` 가 뒤따라야 해결이다 (실측, FR-GIT-224) |
| 파괴적 목록의 정적 가드는 **개수를 못박는다** | 새 파괴적 동작을 더하면 `TestDestructiveActions_CoversFR89` 가 실패한다 — 가드가 의도대로 도는 것이다. 목록을 늘렸으면 테스트도 함께 늘린다 |
| 사용자가 말한 "높이"가 **무엇의 높이인지** | "리스트 높이"를 컨테이너로 읽고 영역을 키웠다가 되돌렸다. 실제로는 **행 높이**였다 — 치수 요청은 대상을 확인하고 시작한다 |
| 터미널 팔레트는 **CSS 변수가 아니다** | `--bg`·`--text` 는 `:root` 에 실리지만 `terminal.green`·`red` 는 `getCurrentTheme()` 에만 있다. Monaco 테마를 CSS 변수만으로 세우면 diff 색을 파생할 수 없다 |
| `applyThemeObj(THEMES[n])` 은 `currentThemeName` 을 **바꾸지 않는다** | 그래서 `getCurrentTheme()` 이 여전히 이전 테마를 답한다. e2e 에서 테마를 갈 때 `customTheme=null` 만으로는 모자라고 `currentThemeName` 도 세워야 한다 |
| Monaco 의 `diffEditor.*` 기본값은 `inherit:true` 로도 **덮이지 않는다** | base 테마(vs/vs-dark)의 초록·빨강이 그대로 남는다. 키를 하나하나 매핑해야 한다 |

### 3.4 병렬 운영에서 배운 것

- **Go 레인 1개 + JS 레인 1개.** 같은 레인에 둘을 띄우면
  `internal/server/handlers_api.go` 의 라우트 표와 `web/js/*.js` 에서 충돌한다.
- **Playwright 는 동시에 두 번 돌 수 없다** — 고정 포트 58147 +
  `reuseExistingServer:false`.
- `git add <디렉터리>` 는 **다른 에이전트의 미완성 변경을 삼킨다.** 파일을 명시해
  add 한다.
- **에이전트 산출물은 독립 검증한다.**

### 3.5 이전 트랙

| 트랙 | 상태 |
|---|---|
| 1. 사용자 확인 피드백 | 완료 — iOS 실기기 수동 확인만 남음 |
| 2. MCP 폐지 → 세션 스코프 스킬 주입 | 완료 |
| 3. 상태바 지표 재설계 | 완료 |
| 4. AI 오케스트레이터 | 완료 (묶음 S·R·P·A·K·W) |
| 5. 브랜드 아이콘·파비콘 | 완료 |

---

## 4. 확정 사항 (다시 논의하지 말 것)

### 4.1 원 설계

| 항목 | 결정 |
|---|---|
| 형태 | Git = **창(window)**, 워크스페이스에 1개 (싱글턴) |
| 진입 | 좌측 사이드바 GIT 섹션 — follow(cwd 자동) + 핀 + `+ Add` |
| 창 내부 | **고정 탭** `Changes / Diff / History / Branches / Stash / Console` |
| 변경 감지 | **`git status` 폴링** (즉시 신호 4종 + signature 500ms + status 1s) |
| diff 엔진 | **Monaco DiffEditor** |
| 안전 | 파괴적 동작은 `ExecWrite` 단일 경로 + 서버측 `confirm` 강제 + 2단계 확인 |
| 자격증명 | **저장·중계하지 않는다.** git credential helper 에 위임 |

기각된 것: 우측 사이드 패널 · 일반 탭 · fsnotify/watcher/git hooks · 칸 최대화(zoom).
사유는 `GIT_INTEGRATION_ANALYSIS.md` §4.5.3 과 `GIT_SRS.md` §5 에 있다.

### 4.2 UI 개정 (`GIT_UI_REVISION_SRS.md`)

| 항목 | 결정 |
|---|---|
| Git 창 | **닫힌 창** — 분할 불가, 탭 추가 불가, 드롭 불가 (FR-GIT-27 폐기) |
| 진입점 | GIT 섹션의 리포 항목 **하나뿐**. WINDOWS 목록·창 전환 순환에서 제외 (FR-GIT-30 폐기) |
| Git 창 닫기 | Git 창 자신의 상단 바 |
| `Open File` | Git 창이 아니라 **직전 활성 일반 창**에 연다 |
| 파일 선택 | 체크박스 없음. 클릭=선택 교체+미리보기 · Cmd/Ctrl=토글 · Shift=범위 |
| 동작 진입점 | **행 인라인 버튼 하나.** 누른 행이 선택 안이면 선택 전체가 대상 |
| GIT 섹션 표식 | 이모지 없음. WINDOWS 의 점과 같은 어휘 + follow 아래 구분선 |
| 치수 | 아이콘 버튼 22×22 · 라벨 버튼 26 · 목록 행 22 · 글꼴 11(목록 12) |
| 버튼 라벨 | **영어.** 안내문·툴팁·placeholder 는 한글 |
| 체크박스·라디오 | 테마 토큰. 켜짐은 accent 로 꽉 찬 상자, **체크 표식(✓)은 그리지 않는다** |
| 커밋 영역 | 입력창이 폭을 다 쓰고, amend·Commit 은 그 아래 한 줄에 **왼쪽으로 모여** |
