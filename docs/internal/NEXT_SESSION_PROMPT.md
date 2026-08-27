<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 이어서 작업한다. 브랜치 `git-review-2026-08-27`, 작업 트리 clean.
**푸시는 지시 없이 하지 마라** — 내가 직접 한다.

## 이번에 할 일 — 4차 검토의 개선 7건 (I1~I7)

출발점은 **`docs/internal/GIT_REMAINING.md` §1.2** 다. 접수한 말과, 내가 이미 확인해
둔 착수점(어느 파일 어느 심볼을 열면 되는지)이 항목별로 있다.

**같은 검토의 오류 3건(E1·E2·E3)은 끝났다.** 그 판의 스펙이
`docs/internal/GIT_REVIEW4_SRS.md` 이고, 개선 7건은 그 문서 **§3.6 에 덧붙인다** —
검토가 하나이므로 문서도 하나다. 지금 §3.6 은 "무엇을 먼저 정해야 하는가"만 있다.

| # | 내용 | 규모 |
|---|---|---|
| I1 | changes 행에 **open file 버튼** (현재 staging·되돌리기 둘뿐) | 국소 |
| I2 | changes 의 **경로 표시가 흐리다 → 진하게**, 파일명과 구별되게 | 국소 |
| I3 | **git 새로고침 버튼** | 국소 (범위 결정 필요) |
| I4 | GIT 리스트에서 **live 와 pin 의 개수 배지 위치가 다르다** | 국소 |
| I5 | **단축키** — git 바로가기 · pin/live 순회 | 결정 필요 |
| I6 | 창 순회로 git 을 떠날 때 **원래 있던 윈도우로** | 결정 필요 |
| I7 | git 에 **워크트리 생성·제거·관리 탭** | 신규 기능. 스펙 먼저 |

**권고 순서: I1~I4 → I5·I6 → I7.** I1~I4 는 서로 독립이라 하나씩 끊어 커밋할 수 있다.
그래도 이건 **권고지 결정이 아니다** — 어디부터 갈지 먼저 물어라.

## 먼저 나에게 물어라

`GIT_REMAINING` §1.2 의 "#### I5·I6" 와 "#### I7", 그리고 `GIT_REVIEW4_SRS` §3.6 의
"먼저 해소할 것" 표에 물을 것이 정리돼 있다. 네 가지다.

- **I3** 새로고침이 무엇까지 다시 받는가 — status 만 / 활성 탭 / 전부. 전부 다시 받으면
  History 300개를 다시 받으며 스크롤이 맨 위로 간다.
- **I5** 키 배정 — 새 키를 더할지(`Ctrl+Shift+KeyG` 등), **Git 창 안에서는 창 순회 키
  (`Ctrl+Shift+[ ]`)를 리포 순회로 재해석**할지. 후자는 키를 늘리지 않지만 모드 의존이다.
  쓰이고 있는 키는 `helpers.js` `SHORTCUT_DEFAULTS` 가 갖고 있다.
- **I6** "원래 있던 윈도우"의 정의 — 마지막으로 포커스가 있던 창인가, git 창을 열기
  직전의 창인가. 단순한 경우엔 둘이 같고 git 을 떠났다 돌아온 뒤에 갈린다. 순회는
  `app-layout.js` 의 `_cycleWindow` 하나를 지난다.
- **I7** 사용자 worktree 를 **어디에** 만드는가, 그리고 범위가 어디까지인가.

I7 의 경계는 이미 읽어 뒀다 (`GIT_REMAINING` §1.2 의 "#### I7"). 요지는
`internal/webserver/domain/worktree` 의 `Manager` 가 **`$DONGMINAL_HOME/worktrees`
아래만** 자기 영역으로 삼고(`checkPath` 가 그 밖을 `unsafe_path` 로 거부), **전체를
쓸어내는 경로가 없다**는 것이다 — 즉 **경로만 갈라 두면 구조적으로 안전하다.**
어느 쪽을 고르든 "Run 정리가 사용자 worktree 경로를 거부한다"는 **보호 테스트를
동작으로 세워라.**

## 스펙을 먼저 쓴다

I1~I7 은 **동작 변경**이다. 무엇이 바뀌어야 하는지를 먼저 적어야 회귀와 구분된다.
IEEE 29148 로 `GIT_REVIEW4_SRS.md` §3.6 에 쓰고, `GIT_SRS.md`·`GIT_UI_REVISION_SRS.md`
와 충돌하는 곳은 **플래그를 올리고 멈춰라** — 조용히 한쪽을 택하지 마라.

이미 정해져 있어 다시 묻지 않을 것은 §3.6 의 두 번째 목록에 있다 (I1 의 Open File 은
Git 창이 아닌 창에 연다 · 색은 테마 변수에서 파생한다 · 자격증명을 담을 자리를 만들지
않는다 · **새 목록·행은 FR-RPT-1~8 을 따른다**).

## 반드시 지킬 규약 하나 — FR-RPT (지난 판에서 세웠다)

**바깥 계기(폴링·SSE 푸시)로 다시 그리는 목록은 요소를 새로 만들지 않는다.** 새로
만들면 값으로 되살릴 수 없는 것이 사라진다: `:hover`, 진행 중인 transition,
더블클릭의 첫 클릭, native 드래그 세션, 글자 선택, 표시 중인 `title` 툴팁.

공통 수단이 `web/js/ui/repaint.js` 에 있다. 계약은 `e2e/repaint.spec.ts` 13항목.

```
paintIfChanged(el, sig, draw)   그릴 내용이 지금 그려진 것과 같으면 그리지 않는다
reconcileList(container, items, {key, sig, build})
                                바뀌지 않은 항목의 요소를 유지하고, 순서는 옮긴다
```

- 판정 근거(`sig`)는 **그 렌더러가 읽는 값 전부**여야 한다. 좁히면 갱신이 조용히 멈춘다.
- **판정을 그리기에 업히지 마라** (FR-RPT-8). 그리지 않으면 판정도 멈춘다. 관측이
  도착하는 자리에서 해라 — `GitPanel._applyStatus` 에 `GitConfirm.notify`·
  `GitDialog.notify`·`GitRemote.notifyStatus` 가 그 예다.
- I1 이 행에 버튼을 더하고 I4 가 행 모양을 바꾸므로 **둘 다 이 규약에 직접 닿는다.**
  행의 `sig`(`panel.js` `_itemSig`, `renderer.js` `_gitRepoSig`)에 새 값을 **반드시**
  넣어라 — 넣지 않으면 그 값이 화면에서 갱신되지 않는다.

## 읽을 것

```
docs/internal/GIT_REMAINING.md        출발점. §1.2 가 이번 할 일이다
docs/internal/GIT_REVIEW4_SRS.md      4차 검토 스펙. §3.6 에 이어 쓴다.
                                      §2.3.1 은 Git Graph 의 배치 규칙 R1~R4
docs/internal/GIT_UI_REVISION_SRS.md  1~3차 개정 (FR-GIT-179~226)
docs/internal/GIT_SRS.md              원 명세 (FR-GIT-1~178) + §7.1 해석
docs/internal/GIT_MANUAL_CHECKLIST.md 실사 기록 1·2회차 + 예정 G8·G9
docs/internal/GIT_SURFACE_MAP.md      기능 126개의 P0/P1/P2 배치 — I7 이 어디 있는지
```

**요구사항의 우선순위**: `GIT_REVIEW4_SRS` > `GIT_UI_REVISION_SRS` > `GIT_SRS`.

**주의**: 패키지 재구성으로 git 코드 경로가 바뀌었다. 위 문서들의 `internal/git`·
`internal/server/handlers_git*` 표기는 **당시의 사실**이며 고치지 않았다. 현재 위치와
이번 판에서 손댄 파일은 이렇다.

```
internal/webserver/domain/git/{core,query,write,store,jobs}   git 실행 계층
internal/webserver/domain/worktree/                           Run 격리 worktree (I7 이 만난다)
internal/webserver/gitapi/                                    /api/git/* 핸들러 48개
web/js/ui/repaint.js       FR-RPT 공통 수단 (신규)
web/js/ui/renderer.js      WINDOWS·GIT 섹션 행 (I4 가 여기)
web/js/git/panel.js 1647   Changes (I1·I2·I3 가 여기)
web/js/git/history.js 917 · lanes.js 274 · remote.js 591 · branches.js 569
web/js/git/commit.js 452 · dialog.js 382 · stash.js 358 · confirm.js 268
web/js/git/menu.js 246 · console.js 204
web/js/core/helpers.js     SHORTCUT_DEFAULTS·SHORTCUT_LABELS (I5 가 여기)
web/js/core/app.js:176     단축키 → 동작 결선
web/js/core/app-layout.js  `_cycleWindow`·`switchWindowNext/Prev` (I6 가 여기)
```

## 검증

```bash
go build ./... && go vet ./... && go test ./... && gofmt -l internal/ cmd/ web/
scripts/verify-isolated.sh          # 격리 인스턴스 실동작 21항목. stop 을 쓰지 않는다
npx playwright test --retries=1 --reporter=list   # 전량 5.5~6.6분
```

**기준선: Go 전량 통과 · e2e 431 통과 · 격리 검증 21/21.** 이 숫자는 지난 판에서
실제로 나온 값이다 (테스트 34개를 더했다).

간헐 실패는 `GIT_REMAINING.md` §5 가 갖고 있다. 부하가 걸리면 늘어난다 — 지난 판에서
`git-history` H17 이 다른 Playwright 프로세스와 겹쳐 20초 폴에 걸렸고, 단독·재실행에서
통과했다. **실패하면 단독 실행으로 먼저 확인하라.** 단독 통과 + Go 전량 통과 + 격리
검증이면 근거는 충분하다. **전량 재실행을 습관으로 하지 마라** — 6분이 걸린다.

> 자산은 `web/embed.go` 로 **바이너리에 박힌다.** `web/` 을 고쳤으면 다시 빌드해야
> 화면에 반영된다. e2e 는 `go run` 으로 매번 새로 빌드하므로 이 함정에 걸리지 않지만,
> 격리 인스턴스로 눈으로 볼 때는 걸린다.

## 절대 하지 말 것

### `dongminal stop`

stop 은 홈이 아니라 **포트**로 대상을 찾는다 (`internal/ctl/cli/proc.go` `killPort`,
`options.go` `ResolvePort`). `--port` 를 안 주면 기본 포트 **58146** — 내가 지금 이
세션을 돌리고 있는 인스턴스를 SIGTERM → SIGKILL 한다. 이전 세션에서 실제로 사고가
났고, 그 탓에 터미널 세션을 잃었다.

실동작 확인은 `scripts/verify-isolated.sh` 나 `./dongminal start --isolated` 로만.
`DONGMINAL_HOME` 만 격리하는 것은 안전장치가 아니다 — stop 이 홈을 보지 않는다.

한 가지 더: `$$` 를 여러 Bash 호출에 걸쳐 쓰지 마라. 호출마다 셸이 달라 값이 바뀐다.
검증 명령의 출력을 `/dev/null` 로 버리지도 마라 — 위 사고를 그 자리에서 못 봤던 이유다.

### 정규식으로 심볼 이름 바꾸기

이름 변경은 **Serena `rename_symbol`** 을 쓴다(참조처 자동 갱신). 정규식 치환이
반복적으로 엉뚱한 것을 잡았다: 구조체 필드명이 타입명과 함께 치환되어 구문 오류 ·
다른 타입의 동명 멤버가 함께 승격 · 지역 변수 `hub` 를 바꾸며 `webserver/hub` 까지
치환. **BSD `sed` 는 `\b`(단어 경계)를 지원하지 않고 조용히 아무것도 안 바꾼다.**

### 아키텍처 보호 테스트 약화

셋이 이 저장소의 안전망이다. 경로가 하드코딩돼 있어 파일이 옮겨지면 실패한다 —
**그게 의도다.**

```
TestNoDirectGitExecOutsidePackage    (FR-GIT-1)   domain/git/core/static_test.go
TestExecWriteCallers_Restricted...   (FR-GIT-95)  domain/git/core/write_test.go
TestNoCredentialFields                            domain/git/core/credentials_static_test.go
```

경로만 정확히 갱신하고, **임계값(`scanned < 40`)을 낮추거나 스캔 범위를 좁히지 마라.**
`credScanDirs` 에서 `internal/webserver/httpapi` 를 빼지 마라.

### 자격증명을 담을 자리 — 묻지 않고 만들지 마라

FR-GIT-104 는 **의도적 배제**이고, `TestNoCredentialFields` 가 **필드 이름만으로** 막는다.
I7(워크트리)은 원격 인증에 닿지 않으므로 그 배제를 건드릴 이유가 없다. §4 의 clone 을
할 때가 오면 **먼저 물어라** (`GIT_REMAINING` §4.1). 대안은 시스템 credential helper
위임이다 — dongminal 이 값을 보지 않으면 담을 자리도 필요 없다.

### 참조 도구의 동작을 추측으로 단정하기

지난 판에서 실제로 값을 치른 함정이다. "VSCode Git Graph 는 선을 고정한다"고 믿고
구현했다가, 소스를 읽고 **반대**임을 알았다 (`web/graph.ts` 의 `nextX`·`getNextPoint`
가 행마다 열을 왼쪽부터 나눠 주므로 통과선이 왼쪽으로 휜다). 규칙 R1~R4 와 근거
코드는 `GIT_REVIEW4_SRS` §2.3.1 에 있다. **참조 도구를 근거로 들 때는 소스를 읽어라.**

## 커밋

- 커밋 전에 나에게 확인받는다.
- 커밋 메시지에 **AI 서명(`Co-Authored-By` 등)을 넣지 않는다** — 저장소 규칙이다.
- 최근 커밋들 스타일을 `git log` 로 보고 맞춰라: 무엇을 바꿨는지가 아니라 **왜
  그렇게 했는지**를 적는다. 검증이 스펙을 고쳤으면 그 사실도 적는다.
- 단계별로 끊어 커밋한다. 각 커밋 전에 위 "검증" 의 Go 4종이 전부 통과해야 한다.
- 한 파일에 두 관심사가 섞이면 중간 상태를 만들어 나눠 담아라 — 지난 판에서
  `history.js` 의 그래프 변경과 배지 변경을 그렇게 갈랐다.

## 지난 판에서 무엇이 끝났나 (참고)

브랜치 `git-review-2026-08-27` 의 커밋 5개다. **오류 3건 + 전수 조사로 나온 5곳 +
검증 중 나온 2건**이 들어 있다.

| 커밋 | 내용 |
|---|---|
| `feat(web)` | FR-RPT 공통 수단 `repaint.js` + 계약 13항목 |
| `fix(git)` | E1(hover 깜빡임) + 같은 원인 5곳(GIT 섹션 핀 드래그 · 상태바 툴팁 · Console 글자 선택 · Agents 카드 드래그 · WINDOWS 이름변경·드래그) + FR-RPT-8 |
| `fix(git)` | E2 — 그래프를 Git Graph 의 배치 규칙으로 재구현 |
| `feat(git)` | E3(커밋 행 ref 배지) + E4(체크아웃 뒤 HEAD 표식이 낡음) |
| `docs` | `GIT_REVIEW4_SRS` 신설 + `GIT_REMAINING` 갱신 |

배운 것 셋을 남긴다.

1. **원인이 같은 결함은 자리마다 막지 마라.** 이 저장소는 같은 함정을 네 곳에서 네 번
   다르게 막았고 여섯 곳이 빠져 있었다. 공통 수단을 만드니 그 뒤로는 규약 위반이
   테스트로 잡힌다.
2. **검증이 스펙을 고친다.** 상태바는 컨테이너 단위 가드로 듣지 않아 항목 단위로
   올렸고(V109 가 그때 실패했다), 전량 e2e 가 FR-RPT-8 을 드러냈다. 스펙이 검증보다
   앞선 척하지 않고 변경 기록에 남겼다.
3. **남기는 것을 조용히 하지 마라.** `Renderer._rLayout` 은 같은 원인을 갖지만 남겼다.
   근거를 `GIT_REVIEW4_SRS` §3.2.1 에 적고 `GIT_REMAINING` §6 에 별건으로 옮겼다.

## 그 밖에 열려 있는 것 (§1.2 를 끝낸 뒤)

- **§2 수동 실사** — G1.10 · G4.6 · G4.8 · G5.12 · G5.13 · G6 상태바 chip 5건 ·
  S 보안 4건 · M2~M5 묶음 · V61(GPG). G7 모바일 실기기는 **내 몫이다.**
- **§3 문서 흡수** — `GIT_UI_REVISION_SRS`(179~226)와 이번 판(227~235 · RPT-1~8)을
  `GIT_SRS` 본문에 넣고 폐기된 FR-GIT-27·30 을 지운다. 트랙을 닫을 때 한다.
- **§4 P1/P2 기능** — 브랜치 삭제·태그·cherry-pick·revert·reset·merge/rebase 실행이
  **가장 작다**(메뉴 프레임워크가 자리를 열어 뒀다). hunk/line 스테이징 → clone/init →
  3-way merge editor·인터랙티브 rebase 가 **가장 크다**. §4.1 의 둘은 확인 필요.
- **§6 별건** — `Renderer._rLayout` · 실제 격리 팀 한 바퀴 · iOS 실기기 ·
  워크스페이스 PUT 의 last-write-wins.
