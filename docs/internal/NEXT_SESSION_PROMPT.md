<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 이어서 작업한다. 브랜치 `refactoring`, 작업 트리 clean.
**푸시는 지시 없이 하지 마라** — 내가 직접 한다.

## 지금 열려 있는 것 — Git 창 하나

**패키지 재구성 트랙은 닫혔다** (16단계, `PACKAGE_RESTRUCTURE_SRS.md` §8.1~§8.12).
프로세스 축 밖에 남은 패키지가 없고, `staticcheck -checks=U1000` 이 0건이며, 격리
검증은 `scripts/verify-isolated.sh` 로 굳혔다. 되살릴 것이 없다.

열려 있는 것은 Git 창이고, 출발점은 **`docs/internal/GIT_REMAINING.md`** 다.
**목표는 그 문서에 남은 전부를 끝내는 것이다** — 일부가 아니다.

- **§1 — 사용자 검토 10건 (미착수).** 오류 3건(E1~E3) + 개선 7건(I1~I7). 실사용에서
  나온 것이라 자동 테스트도 1·2회차 실사도 잡지 못했다. **여기부터가 가장 시급하다.**
- **§2 — 수동 실사 잔여.** G1.10·G4.6·G4.8·G5.12·G5.13, G6 상태바 chip 전부,
  S 보안 4건, M2~M5 묶음, V61(GPG). G7 모바일 실기기는 내 몫이다.
- **§3 — 문서 흡수.** `GIT_UI_REVISION_SRS`(FR-GIT-179~226)를 `GIT_SRS` 본문에 넣고
  폐기된 FR-GIT-27·30 을 지우는 일. 트랙을 닫을 때 한다.
- **§4 — P1/P2 로 미뤄둔 기능. 이제 범위 안이다.** 브랜치 삭제·태그·cherry-pick·
  revert·reset·merge/rebase 실행(메뉴 프레임워크가 자리를 열어 둬서 **가장 작다**),
  hunk/line 스테이징, clone/init, 3-way merge editor·인터랙티브 rebase(**가장 크다**).
  **§4.1 의 둘(자격증명·한글 안내문)은 예외이며 확인을 받아야 한다.**
- **§6 — 트랙 밖 별건.** 실제 격리 팀 한 바퀴, iOS 실기기, 워크스페이스 PUT 의
  last-write-wins.

## 먼저 나에게 물어라

**어디부터 갈지 묻고, 답을 받은 뒤에 움직여라.** 스스로 순서를 정하면 내가 원하지
않은 것에 시간을 쓴다.

권고 순서는 **§1 오류 3건 → §1 국소 UI(I1~I4) → §1 결정 필요(I5·I6) → §1 I7 →
§4 의 작은 것(메뉴 항목 선언) → §2 실사 → §4 의 큰 것 → §3 문서 흡수**다.
오류를 먼저 두는 것은 UI 를 손대면 E1(hover 깜빡임) 같은 증상의 원인이 가려질 수
있기 때문이다. 그래도 이건 **권고지 결정이 아니다.**

두 가지는 코드를 봐도 답이 안 나오니 반드시 물어라.

- **I5** 단축키 키 배정 (git 바로가기 · pin/live 리스트 순회)
- **I6** "원래 있던 윈도우"의 정의 — 마지막으로 포커스가 있던 창인가, git 창을 열기
  직전의 창인가

**I7(워크트리 탭)은 규모가 다르다.** 나머지가 국소 변경인 데 비해 신규 기능이고,
`internal/webserver/domain/worktree` 가 이미 Run 격리용으로 worktree 를 만들고 지운다
(안전 가드 포함). 사용자가 만든 worktree 를 Run 정리가 지우면 안 된다 — 그 경계를
스펙에서 먼저 정해라.

## 스펙을 먼저 쓴다

§1·§4 는 **동작 변경**이다. 재구성 트랙처럼 "기준선과의 차이가 곧 결함"인 작업이
아니므로, 무엇이 바뀌어야 하는지를 먼저 적어야 회귀와 구분된다. IEEE 29148 로
쓰고, `GIT_SRS.md`·`GIT_UI_REVISION_SRS.md` 와 충돌하는 곳은 **플래그를 올리고
멈춰라** — 조용히 한쪽을 택하지 마라.

## 읽을 것

```
docs/internal/GIT_REMAINING.md          출발점. §1 이 지금 할 일이다
docs/internal/GIT_UI_REVISION_SRS.md    개정 SRS (FR-GIT-179~226). GIT_SRS 보다 앞선다
docs/internal/GIT_SRS.md                원 명세 (FR-GIT-1~178) + §7.1 해석 I1~I9
docs/internal/GIT_MANUAL_CHECKLIST.md   실사 기록 1·2회차 + 예정 G8·G9
docs/internal/GIT_SURFACE_MAP.md        기능 126개의 P0/P1/P2 배치 — I7 이 어디 있는지 여기서 봐라
```

**주의**: 재구성으로 git 코드 경로가 바뀌었다. 위 문서들의 `internal/git`·
`internal/server/handlers_git*` 표기는 **당시의 사실**이며 고치지 않았다
(`PACKAGE_RESTRUCTURE_SRS` §8.8). 현재 위치는 이렇다.

```
internal/webserver/domain/git/{core,query,write,store,jobs}   git 실행 계층
internal/webserver/gitapi/                                    /api/git/* 핸들러 48개
web/js/git/    panel.js 1590 · history.js 857 · remote.js 578 · branches.js 569
               commit.js 452 · dialog.js 382 · stash.js 358 · confirm.js 268
               menu.js 246 · console.js 183 · lanes.js 125
```

## 검증

```bash
go build ./... && go vet ./... && go test ./... && gofmt -l internal/ cmd/ web/
scripts/verify-isolated.sh          # 격리 인스턴스 실동작 21항목. stop 을 쓰지 않는다
npx playwright test --reporter=list # 전량 5.6분
```

**기준선: Go 전량 통과 · e2e 397~398 통과(간헐 실패 0~1) · 격리 검증 21/21.**

e2e 간헐 실패 목록은 `GIT_REMAINING.md` §5 가 갖고 있다 — `git-stash` S2·S3,
`git-commit` E11, `background-restore-at` TC-BGR-9. 실패하면 **단독 실행으로 먼저
확인하라.** 단독에서 통과하면 flaky 다. **전량 재실행은 지시 없이 하지 마라** —
5.6분이 걸리고, 단독 통과 + Go 전량 통과 + 격리 검증이면 근거는 충분하다.

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

한 가지 더: `$$` 를 여러 Bash 호출에 걸쳐 쓰지 마라. 호출마다 셸이 달라 값이 바뀌고,
그래서 격리했다고 믿은 홈 경로가 실제로는 존재하지 않는 경로가 된다. 검증 명령의
출력을 `/dev/null` 로 버리지도 마라 — 위 사고를 그 자리에서 못 봤던 이유다.

### 정규식으로 심볼 이름 바꾸기

이름 변경은 **Serena `rename_symbol`** 을 쓴다(참조처 자동 갱신). 정규식 치환이
반복적으로 엉뚱한 것을 잡았다:

- 구조체 **필드명**이 타입명과 함께 치환되어 구문 오류
- 다른 타입의 **동명 멤버**가 함께 승격됨
- **import 경로** — 지역 변수 `hub` 를 바꾸면서 `webserver/hub` 까지 치환됨
- BSD `sed` 는 `\b`(단어 경계)를 지원하지 않는다. **조용히 아무것도 안 바꾼다.**
  15단계에서 또 걸렸다 — 단어 경계를 쓰지 말고, 치환한 뒤 `grep` 으로 잔여를 세라.

### 아키텍처 보호 테스트 약화

셋이 이 저장소의 안전망이다. 경로가 하드코딩돼 있어 파일이 옮겨지면 실패한다 —
**그게 의도다.** 재구성에서 두 번 정확히 잡아냈다.

```
TestNoDirectGitExecOutsidePackage    (FR-GIT-1)   domain/git/core/static_test.go
TestExecWriteCallers_Restricted...   (FR-GIT-95)  domain/git/core/write_test.go
TestNoCredentialFields                            domain/git/core/credentials_static_test.go
```

경로만 정확히 갱신하고, **임계값(`scanned < 40`)을 낮추거나 스캔 범위를 좁히지 마라.**
`credScanDirs` 에서 `internal/webserver/httpapi` 를 빼지 마라 — git 코드가 다시
흘러들어오면 검사 없이 통과하는 구멍이 된다.

### 자격증명을 담을 자리 — 묻지 않고 만들지 마라

FR-GIT-104 는 **의도적 배제**이고, `TestNoCredentialFields` 가 `domain/git/*`·
`gitapi`·`httpapi` 를 훑어 **필드 이름만으로** 막는다. §4 가 범위에 들어오면서
clone 처럼 원격 인증에 걸리는 항목이 생겼지만, 그렇다고 자동으로 배제가 풀리는 것은
아니다 — 되살리려면 이 저장소의 안전망 셋 중 하나를 여는 일이므로 **먼저 물어라**
(`GIT_REMAINING` §4.1). 대안은 시스템 credential helper 에 위임하는 것이다. dongminal
이 값을 보지 않으면 담을 자리도 필요 없다.

I7(워크트리)이나 remote 작업에서 무심코 필드를 만들지 않도록 특히 조심할 것.

## 커밋

- 커밋 전에 나에게 확인받는다.
- 커밋 메시지에 **AI 서명(`Co-Authored-By` 등)을 넣지 않는다** — 저장소 규칙이다.
- 최근 커밋들 스타일을 `git log` 로 보고 맞춰라: 무엇을 바꿨는지가 아니라 **왜
  그렇게 했는지**를 적는다.
- 단계별로 끊어 커밋한다. 각 커밋 전에 위 "검증" 의 Go 4종이 전부 통과해야 한다.

## 배경 — 재구성으로 무엇이 바뀌었나 (참고)

| | 착수 전 | 현재 |
|---|---:|---:|
| Go 패키지 | 17 | 29 (프로세스 축 밖 **0**) |
| 웹 HTTP 잔여 | `internal/server` 28파일 19,653줄 | `webserver/httpapi` 13파일 2,885줄 |
| `handlers_api.go` | 701줄 | **262줄** (16단계 4분할) |
| `web/js` | 20파일 평면 | 33파일 (core/ui/git) |
| `app.js` | 2,999줄 단일 클래스 | 본체 274줄 + 13파일 |

```
internal/
├── helper/      ① dmctl/edit/download/detach
├── daemon/      ② dongminald — PTY 소유
├── webserver/   ③ 웹 서버 — httpapi, gitapi, hub, toolclient, seam/, domain/
├── ctl/         ④ start/stop/health/migrate
└── shared/      2개 이상이 실행 — workspace, toolhub, toolipc, outbuf, runtime, uuid, agentadapter
```

**프로세스 축의 판정 기준은 "실행"이다.** 단일 바이너리라 링크 클로저는 네 프로세스가
모두 같다 — 그것으로는 아무것도 갈리지 않는다. `shared/` 는 둘 이상이 **실제로 실행**
하는 것만이다.

**Go 의 메서드-패키지 제약**이 분할 형태를 강제했다. 타입의 메서드는 그 타입을 선언한
패키지에만 둘 수 있다. `httpapi` 안에서 파일을 더 가르는 것은 자유지만, `*Server`
메서드를 다른 패키지로 옮기려면 리시버부터 바꿔야 한다.

`httpapi` 의 핸들러는 **무엇을 손볼 때 함께 봐야 하는가**로 갈라 뒀다.
`handlers_files.go` 가 경로를 사용자 입력에서 받는 유일한 면이고(`safeResolve`·
`uniquePath` 가 여기 있다), `handlers_attention.go` 는 같은 `AttnTracker` 를 읽는 종단
8개, `handlers_settings.go` 는 서버가 해석하지 않는 JSON blob 이다.
