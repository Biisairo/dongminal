# 다음 세션 프롬프트

**열려 있는 트랙 둘.**

- **A. 패키지 재구성 마무리** — 14단계 전량 완료. 남은 것은 **판단이 필요한 3건**뿐이고
  코드에 알려진 결함은 없다. 아래 §1 이 이 트랙이다.
- **B. Git 창 실사** — 코드 결함은 없고 **수동 검증 잔여 + 문서 흡수**가 남았다.
  출발점은 [`GIT_REMAINING.md`](./GIT_REMAINING.md) §1~§2.

**어느 트랙으로 갈지 사용자에게 먼저 묻는다.** 성질이 다르고, 스스로 순서를 정하면
사용자가 원하지 않은 것에 시간을 쓴다.

갱신: 2026-08-27 (패키지 재구성 14단계 완료)

---

## 1. 새 세션에 붙여넣을 지시 블록 (트랙 A)

```
dongminal 패키지 재구성 트랙을 닫는다. **14단계 전량 구현이 끝났고 코드에 알려진
결함은 없다** — 남은 것은 판단이 필요한 3건이다.

읽을 것 (순서대로):
  docs/internal/PACKAGE_RESTRUCTURE_SRS.md   ← 단일 진실 공급원. §5 비목표와 §8 실행 기록을 반드시 읽어라
  docs/internal/architecture.md              ← §패키지 레이아웃 · §git 실행 계층
  README.md                                  ← §아키텍처 개요(프로세스 축) · §테스트

**먼저 사용자에게 어느 것을 할지 묻는다.** 셋은 규모와 성질이 다르다.

① internal/server → internal/webserver/httpapi  (LOW, 30분)
   패키지 29개 중 유일하게 프로세스 축 밖에 남아 있다. 13파일 2,885줄이고 실질은
   webserver/httpapi 다. 디렉터리 이동 + package 개명 + import 경로 갱신뿐이다.
   `package http` 로 하면 표준 net/http 와 충돌해 전 파일에 alias 가 필요하므로
   `package httpapi` 다 (SRS FR-DIR-3 의 대안 검토).
   이걸 하면 프로세스 축이 예외 없이 완성된다.

② handlers_api.go 701줄 · *Server 메서드 25개의 분할  (MEDIUM)
   SRS §5 비목표 #4 로 명시적으로 뺀 것이다. 프로세스·역할 경계는 이미 표현됐고
   단일 파일 크기는 별개 문제라는 판단이었다. **정말 필요한지부터 사용자와 확인하라** —
   ①과 달리 이건 "안 해도 되는 일"일 수 있다.

③ 격리 검증 스크립트를 저장소로  (LOW, 15분)
   지금 저장소 밖(스크래치)에 있다. 21항목 검사이며 `stop` 을 쓰지 않는다 —
   `start --isolated`(임시 홈 + 빈 포트, internal/ctl/cli/start.go:45 가 격리
   모드에서 killPort 를 건너뛴다) 로 띄우고 PID 로만 정리한다. 운영 인스턴스를
   대상으로 잡으면 중단하는 가드가 들어 있다.
   `scripts/` 는 build.sh 전용이라는 관례가 있어 넣지 않았다. 넣으려면
   scripts/verify-isolated.sh 가 자연스럽고, README §테스트에서 참조하면 된다.

**착수 전에 반드시 할 것 — 기준선 확보.** 이 트랙의 모든 작업은 무동작변경이므로
기준선과의 차이가 곧 결함이다.
  go test ./... 2>&1 | tee /tmp/base-go.txt
  npx playwright test --reporter=list 2>&1 | tail -30 | tee /tmp/base-e2e.txt
현재 기준선: Go 전량 통과 · e2e 398 통과 / 0 실패.

**절대 하지 말 것 — `dongminal stop`.**
stop 은 홈이 아니라 **포트**로 대상을 찾는다 (internal/ctl/cli/proc.go:58 killPort,
options.go:80 ResolvePort). --port 를 안 주면 기본 포트 58146 = 사용자가 지금
이 세션을 돌리고 있는 인스턴스를 SIGKILL 한다. 이전 세션에서 실제로 사고가 났다.
실동작 확인은 `./dongminal start --isolated` 로만 하고, 정리는 start 가 출력한
PID 와 격리 홈의 paned.pid 를 직접 kill 한다.

**심볼 이름 변경은 Serena rename_symbol 을 쓴다.** 수동 치환하지 마라 — 이전
세션에서 정규식 치환이 구조체 필드명(`Tool`, `AttnTracker`)과 다른 타입의
동명 멤버(`attnPaneState.lastOutputAt`, `expandedToolHubFake.restored`)를
잡아먹은 사고가 반복됐다. 다만 대상 패키지가 컴파일되지 않는 상태에서는 gopls 가
크로스패키지 참조를 못 잡는다 — 그때는 정의만 승격하고 호출부는 컴파일러 오류를
따라가라.

**아키텍처 보호 테스트 3개가 이 저장소의 안전망이다.** 경로가 하드코딩돼 있어
파일이 옮겨지면 실패한다 — 그게 의도다. 경로만 정확히 갱신하고 **약화시키지 마라**:
임계값(scanned < 40)을 낮추거나 스캔 범위를 좁히지 마라.
  TestNoDirectGitExecOutsidePackage    (FR-GIT-1)   git/static_test.go
  TestExecWriteCallers_Restricted...   (FR-GIT-95)  git/write_test.go
  TestNoCredentialFields                            git/credentials_static_test.go

커밋 메시지에 AI 서명(Co-Authored-By 등)을 넣지 않는다 — 저장소 규칙이다.
기존 커밋 9개(d88006e..4d5ddb2)의 스타일을 git log 로 보고 맞춰라: 무엇을
바꿨는지가 아니라 **왜 그렇게 했는지**를 적는다.
```

---

## 2. 확인이 필요한 미해결 사실 — 원격 푸시

`origin/refactoring` 이 `3d8511a`(app.js 분할)를 가리킨다. reflog 에 `update by push`
3건(`c043b34` · `70c6c25` · `3d8511a`).

**조정자가 푸시한 적이 없고, 팀원 브리프에도 푸시 지시가 없었다.** 브리프는 "네
worktree 브랜치에 커밋해라"까지였다. 경위를 확정하지 못했으므로 사실만 남긴다:

- 원격은 `bii:Biisairo/dongminal.git` — 사용자 저장소다. 외부 유출이 아니다.
- 로컬 `refactoring` 은 원격보다 5커밋 앞서 있다 (git 5분할 2개 + 병합 + 문서 2개).
- worktree 브랜치(`dmn/…`)는 원격에 남아 있지 않다.

**새 세션은 이걸 먼저 사용자에게 확인하라.** 사용자가 직접 푸시한 것이면 그대로
두고, 아니면 원인을 봐야 한다. **지시 없이 나머지 5커밋을 푸시하지 마라.**

---

## 3. 지금까지의 결과 (트랙 A)

커밋 9개 `d88006e`..`4d5ddb2`. `git log --follow` 로 이동 파일 이력이 이어진다.

| | 착수 전 | 현재 |
|---|---:|---:|
| Go 패키지 | 17 | 29 |
| `internal/server` 소스 | 28파일 19,653줄 | 13파일 2,885줄 |
| `web/js` | 20파일 평면 | 33파일 (core/ui/git) |
| `app.js` | 2,999줄 단일 클래스 | 본체 274줄 + 13파일 |
| 전체 diff | — | 313파일, +8,377 / −6,410 |

검증: `go build`·`vet`·`test`·`gofmt` 전량 통과 · e2e **398 통과 / 0 실패** ·
격리 실동작 21항목 통과.

### 구조를 결정한 사실 두 개

**1. 프로세스 축의 판정 기준은 "실행"이다.** 단일 바이너리라 링크 클로저는 네
프로세스가 모두 같다 — 그것으로는 아무것도 갈리지 않는다. `shared/` 는 둘 이상이
**실제로 실행**하는 것만이다. `workspace` 만 셋(helper·데몬·웹서버)이 쓴다.
행렬은 SRS §2.1.

**2. Go 의 메서드-패키지 제약이 분할 형태를 강제했다.** 타입의 메서드는 그 타입을
선언한 패키지에만 둘 수 있다. 그래서 git 핸들러 48개는 `*Server`→`*GitServer`
리시버 교체가, `git` 조회·변경 47개 중 34개는 자유 함수 전환이 필요했다 —
파일 이동으로는 불가능했다. 실측은 SRS §2.3.

### 반복해서 틀린 것 — 측정 방법

**export 승격 규모를 두 번 과소 추정했다** (SRS §8.2 D-1, §8.6 D-5). 원인이 같다:
`go build` 의 **패키지 수준 `undefined`** 만 수집하고, **경계를 넘는 비공개 멤버
(메서드·필드) 접근**을 세지 않았다. 그 오류는 참조를 새 패키지 접두어로 전환한
*뒤에야* 나타난다. 13개로 추정했는데 실제 30개였다.

다음에 패키지를 가를 때는 스크래치 사본에서 **참조 전환까지 끝낸 뒤** 측정하라.

---

## 4. 트랙 B — Git 창 실사 (그대로 열려 있음)

이 트랙은 이번 재구성과 무관하게 남아 있다. 출발점과 순서는
[`GIT_REMAINING.md`](./GIT_REMAINING.md) §1~§2 가 답한다. 읽을 것:

```
docs/internal/GIT_REMAINING.md          ← 출발점
docs/internal/GIT_UI_REVISION_SRS.md    ← 개정 SRS (FR-GIT-179~226). GIT_SRS 보다 앞선다
docs/internal/GIT_SRS.md                ← 원 명세 (FR-GIT-1~178) + §7.1 해석 I1~I9
docs/internal/GIT_MANUAL_CHECKLIST.md   ← 실사 기록 1·2회차 + 예정 G8·G9
```

**주의**: 재구성으로 git 코드 경로가 바뀌었다. 위 문서들의 `internal/git`·
`internal/server/handlers_git*` 표기는 **당시의 사실**이며 고치지 않았다 (SRS §8.8) —
현재 위치는 `internal/webserver/domain/git/{core,query,write,store,jobs}` 와
`internal/webserver/gitapi` 다.
