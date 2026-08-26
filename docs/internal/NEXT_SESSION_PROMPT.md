<!-- 이 파일은 전체가 새 세션의 첫 메시지다. 열어서 전체 선택 → 붙여넣기. -->

dongminal 저장소에서 이어서 작업한다. 브랜치 `refactoring`, 작업 트리 clean, **원격보다
앞서 있다**(푸시는 지시 없이 하지 마라). **코드에 알려진 결함은 없다.**

## 먼저 나에게 물어라

열려 있는 트랙이 둘이고 성질이 다르다. **어느 쪽으로 갈지 먼저 묻고, 답을 받은 뒤에
움직여라.** 스스로 순서를 정하면 내가 원하지 않은 것에 시간을 쓴다.

- **트랙 A — 패키지 재구성 마무리.** 프로세스 축 밖에 남은 패키지가 없고 격리 검증도
  스크립트로 굳혔다. 남은 것은 **판단이 필요한 1건**뿐이고 아래에 있다.
- **트랙 B — Git 창 실사.** 코드 결함은 없고 수동 검증 잔여 + 문서 흡수가 남았다.
  출발점은 `docs/internal/GIT_REMAINING.md` §1~§2.

트랙 A 에 남은 1건은 **안 해도 되는 일일 수 있다.** 착수 전에 정말 필요한지부터
물어라.

---

## 읽을 것 (트랙 A, 순서대로)

```
docs/internal/PACKAGE_RESTRUCTURE_SRS.md   단일 진실 공급원. §5 비목표와 §8 실행 기록을 반드시 읽어라
docs/internal/architecture.md              §패키지 레이아웃 · §git 실행 계층
README.md                                  §아키텍처 개요(프로세스 축) · §테스트
```

## 트랙 A 의 남은 1건

### `handlers_api.go` 672줄 · `*Server` 메서드 25개 분할 — MEDIUM

SRS §5 비목표 #4 로 **명시적으로 뺀 것**이다. 프로세스·역할 경계는 이미 표현됐고
단일 파일 크기는 별개 문제라는 판단이었다.

**정말 필요한지부터 나에게 확인하라.** 파일은 이제
`internal/webserver/httpapi/handlers_api.go` 다 — 15단계에서 옮겨졌고, `*Server`
메서드이므로 가르더라도 **같은 패키지 안에서** 갈라야 한다.

---

## 착수 전에 반드시 — 기준선

이 트랙의 모든 작업은 **무동작변경**이다. 그래서 기준선과의 차이가 곧 결함이다.

```bash
go test ./... 2>&1 | tee /tmp/base-go.txt
npx playwright test --reporter=list 2>&1 | tail -30 | tee /tmp/base-e2e.txt
scripts/verify-isolated.sh          # 격리 인스턴스 실동작 21항목. stop 을 쓰지 않는다
```

**현재 기준선: Go 전량 통과 · e2e 398 통과 / 0 실패 · 격리 검증 21/21.**

e2e 에 flaky 가 둘 있다 — `git-ui-revision.spec.ts:1026`(V79) 과
`background-restore-at.spec.ts:264`(TC-BGR-9). 실패하면 단독 실행으로 먼저 확인하고,
단독에서 통과하면 flaky 로 판정하되 **전량 재실행으로 한 번 더 확인**하라.

---

## 절대 하지 말 것

### `dongminal stop`

stop 은 홈이 아니라 **포트**로 대상을 찾는다 (`internal/ctl/cli/proc.go:58` `killPort`,
`options.go:80` `ResolvePort`). `--port` 를 안 주면 기본 포트 **58146** — 내가 지금 이
세션을 돌리고 있는 인스턴스를 SIGTERM → SIGKILL 한다. 이전 세션에서 실제로 사고가
났고, 그 탓에 터미널 세션을 잃었다.

실동작 확인은 `./dongminal start --isolated` 로만. `DONGMINAL_HOME` 만 격리하는 것은
안전장치가 아니다 — stop 이 홈을 보지 않기 때문이다. 그 절차는 이미
`scripts/verify-isolated.sh` 에 굳혀 뒀다(가드·정리 포함). 직접 띄우기 전에 그것부터
써라.

한 가지 더: `$$` 를 여러 Bash 호출에 걸쳐 쓰지 마라. 호출마다 셸이 달라 값이 바뀌고,
그래서 격리했다고 믿은 홈 경로가 실제로는 존재하지 않는 경로가 된다. 검증 명령의
출력을 `/dev/null` 로 버리지도 마라 — 위 사고를 그 자리에서 못 봤던 이유다.

### 정규식으로 심볼 이름 바꾸기

이름 변경은 **Serena `rename_symbol`** 을 쓴다(참조처 자동 갱신). 이전 세션에서 정규식
치환이 반복적으로 엉뚱한 것을 잡았다:

- 구조체 **필드명** — `Tool` 필드가 `toolhub.Tool` 로 치환되어 구문 오류
- 다른 타입의 **동명 멤버** — `attnPaneState.lastOutputAt`,
  `expandedToolHubFake.restored` 가 `Tool` 것과 함께 승격됨
- **import 경로** — 지역 변수 `hub` 를 `cmdHub` 로 바꾸면서
  `dongminal/internal/webserver/hub` 까지 치환됨
- BSD `sed` 는 `\b`(단어 경계)를 지원하지 않는다. 조용히 아무것도 안 바꾼다.
  **15단계에서 또 걸렸다.** 단어 경계를 쓰지 말고, 치환한 뒤 `grep` 으로 잔여를 세라.

단, 대상 패키지가 컴파일되지 않는 상태에서는 gopls 가 크로스패키지 참조를 못 잡는다.
그때는 **정의만 승격하고 호출부는 컴파일러 오류를 따라가라** — 컴파일러가 안전망이다.

### 아키텍처 보호 테스트 약화

셋이 이 저장소의 안전망이다. 경로가 하드코딩돼 있어 파일이 옮겨지면 실패한다 —
**그게 의도다.** 실제로 이번 재구성에서 두 번 정확히 잡아냈다.

```
TestNoDirectGitExecOutsidePackage    (FR-GIT-1)   domain/git/core/static_test.go
TestExecWriteCallers_Restricted...   (FR-GIT-95)  domain/git/core/write_test.go
TestNoCredentialFields                            domain/git/core/credentials_static_test.go
```

경로만 정확히 갱신하고, **임계값(`scanned < 40`)을 낮추거나 스캔 범위를 좁히지 마라.**
`credScanDirs` 에서 `internal/webserver/httpapi`(구 `internal/server`)를 빼지 마라 —
git 코드가 다시 흘러들어오면 검사 없이 통과하는 구멍이 된다.

---

## 커밋

- 커밋 전에 나에게 확인받는다.
- 커밋 메시지에 **AI 서명(`Co-Authored-By` 등)을 넣지 않는다** — 저장소 규칙이다.
- 착수 커밋 `d88006e` 이후의 커밋들 스타일을 `git log` 로 보고 맞춰라:
  무엇을 바꿨는지가 아니라 **왜 그렇게 했는지**를 적는다.
- 단계별로 끊어 커밋한다. 각 커밋 전에
  `go build ./... && go vet ./... && go test ./... && gofmt -l internal/ cmd/ web/` 가
  전부 통과해야 한다.

---

## 지금까지의 결과 (참고)

착수 커밋은 `d88006e`(데몬 코어 분리)다. `git log --follow` 로 이동 파일 이력이 이어진다.

| | 착수 전 | 현재 |
|---|---:|---:|
| Go 패키지 | 17 | 29 |
| 프로세스 축 밖 패키지 | — | **0** (15단계에서 해소) |
| 웹 HTTP 잔여(구 `internal/server`) | 28파일 19,653줄 | `webserver/httpapi` 13파일 2,885줄 |
| `web/js` | 20파일 평면 | 33파일 (core/ui/git) |
| `app.js` | 2,999줄 단일 클래스 | 본체 274줄 + 13파일 |
| 전체 diff | — | 313파일, +8,377 / −6,410 |

**`staticcheck -checks=U1000` 이 0건이다.** 15단계에서 미사용 심볼 6건(247줄)을 걷어냈다.
새 코드를 넣은 뒤 이 검사가 다시 뜨면 그건 이번에 치운 것이 되돌아온 것이다.

```
internal/
├── helper/      ① dmctl/edit/download/detach
├── daemon/      ② dongminald — PTY 소유
├── webserver/   ③ 웹 서버 — httpapi, gitapi, hub, toolclient, seam/, domain/
├── ctl/         ④ start/stop/health/migrate
└── shared/      2개 이상이 실행 — workspace, toolhub, toolipc, outbuf, runtime, uuid, agentadapter
```

### 구조를 결정한 사실 두 개

**1. 프로세스 축의 판정 기준은 "실행"이다.** 단일 바이너리라 링크 클로저는 네 프로세스가
모두 같다 — 그것으로는 아무것도 갈리지 않는다. `shared/` 는 둘 이상이 **실제로 실행**
하는 것만이다. `workspace` 만 셋(helper·데몬·웹서버)이 쓴다. 행렬은 SRS §2.1.

**2. Go 의 메서드-패키지 제약이 분할 형태를 강제했다.** 타입의 메서드는 그 타입을 선언한
패키지에만 둘 수 있다. 그래서 git 핸들러 48개는 `*Server`→`*GitServer` 리시버 교체가,
`git` 조회·변경 47개 중 34개는 자유 함수 전환이 필요했다 — 파일 이동으로는 불가능했다.
실측은 SRS §2.3. **`handlers_api.go` 분할에도 이 제약이 그대로 걸린다** — `*Server`
메서드는 파일을 갈라도 같은 패키지 안에 있어야 한다.

### 반복해서 틀린 것 — 측정 방법

**export 승격 규모를 두 번 과소 추정했다** (SRS §8.2 D-1, §8.6 D-5). 원인이 같다:
`go build` 의 **패키지 수준 `undefined`** 만 수집하고 **경계를 넘는 비공개 멤버
(메서드·필드) 접근**을 세지 않았다. 그 오류는 참조를 새 패키지 접두어로 전환한
*뒤에야* 나타난다. 13개로 추정했는데 실제 30개였다.

패키지를 가를 때는 스크래치 사본에서 **참조 전환까지 끝낸 뒤** 측정하라.

---

## 트랙 B 를 고르면 읽을 것

```
docs/internal/GIT_REMAINING.md          출발점. §1~§2 가 남은 일이다
docs/internal/GIT_UI_REVISION_SRS.md    개정 SRS (FR-GIT-179~226). GIT_SRS 보다 앞선다
docs/internal/GIT_SRS.md                원 명세 (FR-GIT-1~178) + §7.1 해석 I1~I9
docs/internal/GIT_MANUAL_CHECKLIST.md   실사 기록 1·2회차 + 예정 G8·G9
```

**주의**: 재구성으로 git 코드 경로가 바뀌었다. 위 문서들의 `internal/git`·
`internal/server/handlers_git*` 표기는 **당시의 사실**이며 고치지 않았다 (SRS §8.8).
현재 위치는 `internal/webserver/domain/git/{core,query,write,store,jobs}` 와
`internal/webserver/gitapi` 다.

실사는 격리 인스턴스가 필요하다 — 위 "절대 하지 말 것" 의 `stop` 항목이 그대로 적용된다.
결함이 나와도 **그 자리에서 고치지 말고 먼저 전부 훑어라.** 목록을 모은 뒤 우선순위를
정한다.
