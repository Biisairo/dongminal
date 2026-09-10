# M2 진행 상황 — 브라우저 매개 공격 봉합 + 서버 하드닝

- 문서 상태: **진행 중** (2026-09-10, **4차 세션** 종료 시점).
- 상위 문서: [`MILESTONE_KICKOFF.md`](./MILESTONE_KICKOFF.md) §M2
- 스펙: [`REQUEST_GATE_SRS.md`](../REQUEST_GATE_SRS.md) ·
  [`FILE_API_BOUNDARY_SRS.md`](../FILE_API_BOUNDARY_SRS.md) ·
  [`MONACO_VENDORING_SRS.md`](../MONACO_VENDORING_SRS.md) ·
  [`CLIENT_API_SRS.md`](../CLIENT_API_SRS.md)
- 다음 세션 착수 프롬프트: §5

---

## 1. 한 줄 요약

**P0 5건과 P1 11건을 닫았다 — P1 이 전부 끝났다.** 4차 세션이 **git 실행 층
통일**(`GO-39`·`FBE-08`·DoD 4번, §2.8)과 **`U-10`**(데이터 손실, §2.9)을 닫았고,
5차 세션이 **탐색기 묶음 여섯**(`U-4`·`U-11`·`U-12`·`U-13`·`U-14`·`U-16`, §2.10)을
`EXPLORER_ROOT_KEYS_SRS` 로 닫았다.

남은 것은 **DoD 5항목 · P2 · 사용자 보고 8건**(§3.4), 그리고 기존 흔들림이다.

`SEC-3`(무인증 LAN 노출)은 M4 까지 열려 있다 — 이 마일스톤의 노출 게이트가 그
절반을 강제한다.

**판정으로 닫힌 것 둘** — 조치 없이 종결이며, 다시 열려면 근거 문서를 먼저 개정한다.

| 항목 | 판정 |
|---|---|
| `SEC-14` | **조치 불요.** 초크포인트를 지나지 않는 것이 `FR-GIT-246`·`D-9` 가 확정한 설계다. 감사가 그 결정을 모른 채 쓴 항목이다 (§3.2) |
| `GO-23` | **착수 근거 없음.** `M3_REFACTOR_NEXT_SESSION` §2 의 (a)~(d) 어디에도 없고, 오류 본문 방언 4종은 공개 계약이라 통일이 금지돼 있다 |

**e2e 규약이 개정됐다** (사용자 지시) — 전체 e2e 는 **남은 구현이 전부 끝난 뒤 한
번**이고, 그때까지는 **닿는 스펙만 단독으로** 돌린다. §5 의 "e2e 를 돌리는 시점".

---

## 2. 완료 — 무엇이 어떻게 닫혔는가

### 2.1 P0 (5/5)

| 발견 | 무엇이었나 | 어떻게 닫았나 |
|---|---|---|
| `SEC-1` `GO-1` | `/ws` 의 `CheckOrigin` 이 **항상 true** — 임의 웹페이지가 셸을 얻었다 (CSWSH → RCE) | `requestGate` 가 mux **바깥**에서 판정하므로 업그레이드 전에 403. `CheckOrigin` 은 그 사실을 신뢰하는 자리로 남고 주석이 그 계약을 적는다 |
| `SEC-2` | 상태 변경 API 전체가 CSRF 무방비. `Content-Type: text/plain` 이면 프리플라이트가 없고, 응답을 못 읽어도 부작용은 일어난다 | `requestGate` 의 Content-Type·Sec-Fetch-Site·Origin 판정. **본문 없는 요청에도 JSON 을 요구한다** — `POST /api/tools?cwd=…` 처럼 쿼리만으로 셸을 만드는 종단이 있다 |
| `SEC-9` | Host 미검증 → DNS 리바인딩으로 위 방어를 우회 | Host 를 **GET 에서도** 대조, 불일치 421. 허용 집합은 `accessStore.self` 를 읽어 자동 유도 — 새 수집 코드 없음 |
| `TEST-1` | `/api/file/write` 단위 테스트 0 · 경로 경계 없음 (`~/.ssh/authorized_keys` 를 요청 하나로 덮을 수 있었다) | `fileGuard` 가 허용 루트와 대조. `/api/fs/*` 의 `fsResolveExisting`/`fsResolveTarget` 을 **재사용**한다. 검사 10건 |
| `FE-1` | 터미널 출력이 상태바 `innerHTML` 로 들어가 스크립트가 됐다 | 싱크에서 전량 이스케이프 + `scripts/check-html.sh` 게이트 + e2e 회귀 2건 |

**게이트 체인이 이렇게 됐다** (`server.go:Handler()`):

```
logging → accessGate(어느 기기) → requestGate(어느 출처) → authGate(누구 — M4) → recover → mux
```

`authGate` 는 **자리만 잡았다** — 지금은 통과시키고, 계약은 `REQUEST_GATE_SRS` §3.6 에 있다.

### 2.2 P1 (11건 — 전부)

| 발견 | 조치 |
|---|---|
| `GO-2` `SEC-4` | `ReadHeaderTimeout: 10s` · `IdleTimeout: 120s`. **`ReadTimeout`·`WriteTimeout` 은 두지 않는다** — SSE·WS·30분 대기 종단이 있다. 종료는 `Shutdown(2s)` → `Close()` |
| `GO-3` `SEC-5` | `internal/webserver/httpreq` 신설. `io.ReadAll(r.Body)` **10곳 → 0곳**, 스트림 디코더 2개도 경유. 기본 1MiB·워크스페이스 8MiB. 업로드 512MiB·LSP·WS 의 기존 상한은 **우회하지 않는다** |
| `SEC-21` | `PUT /api/settings` 가 `json.Valid` 를 통과해야 쓴다 — 종전에는 받은 바이트를 그대로 파일에 썼다 |
| `SEC-6` | `ToolCap = 256`(429) · `SubCap = 64`. 도구 상한은 **잠금 안에서·기동 전에** 센다 |
| `SEC-8` | 홈 0700 · 소켓 0600(`Chmod`) · 소켓 디렉터리 0700 · pid 0600 · 로그 0600. 기본 로그가 `/tmp/dongminal.log` → `$DONGMINAL_HOME/server.log` |
| `SEC-3` 완화 | `--expose` + ACL 꺼짐이면 **기동 거부**. 되돌리는 길은 `--insecure-no-acl` 하나. 사유가 셋으로 갈린다(없다/꺼졌다/항목이 없다) |
| `UX-1` | `_confirmClose` 를 `GitConfirm` 규약으로 **수렴** · `textContent` · DOM 조립으로 재작성. **⚠️ 판정 일부 개정 (2026-09-10, §2.11)** — 그 수렴이 도착한 값("초기 포커스 취소 · `Enter`≠실행")은 `U-15` 로 **되돌아갔다.** 두 벌을 한 벌로 모은 것과 `textContent` 는 그대로 결함 판정이다 |
| `SEC-11` 일부 | 정적 응답에 CSP · `X-Frame-Options` · `X-Content-Type-Options` · `Referrer-Policy` |
| **`FE-6` + `B7`** | **Monaco 벤더링 — 사전압축으로.** `MONACO_CDN` 소멸, `web/vendor/monaco/vs` 로 들어갔다. **CSP 의 외부 호스트가 0** 이 됐다. 상세는 §4 |
| **`GO-11` `SEC-17`** | **오류 분류·문구 노출.** 응답 본문이 오류 전문을 흘리던 **9곳이 0곳**. 문자열로 오류를 가르던 **3곳이 0곳**. 상세는 §2.6 |
| **`FE-8`** | **`web/js/core/api.js` 통합.** 손수 `fetch` **81곳 / 28파일**이 전송 한 겹을 지난다. M4 인증의 선행. 상세는 §2.7 |

### 2.3 새로 선 게이트

| 게이트 | 무엇을 막나 |
|---|---|
| `scripts/check-html.sh` | HTML 템플릿의 `${…}` 가 `escHtml(`/`e(` 로 시작하지 않으면 실패. **예외 없음** — 마크업을 넣어야 하는 자리는 DOM 으로 세운다 |
| `scripts/check-vendor.sh` (확장) | 종전에는 flat 파일만 봤다. **디렉터리 자산**(monaco)을 **집계 해시와 파일 수**로 본다 — 파일 하나가 바뀌어도, 사라져도, 이름만 바뀌어도 값이 달라진다 |
| `scripts/check-fetch.sh` | 브라우저의 API 호출이 `core/api.js` 를 지나지 않는 자리를 잡는다. 허용 목록은 둘(`api.js` 자신·`timer-hub.js` 의 주입 fetch)이고, 거기 이름을 더하는 것은 **결정**이며 `CLIENT_API_SRS` 를 함께 고쳐야 한다 |

`make gates` 와 `verify.yml` 의 `gates` 잡에 함께 걸렸다.

### 2.4 부수적으로 드러난 것

- **프론트의 상태 변경 `fetch` 6곳이 Content-Type 을 안 밝히고 있었다.** 게이트를 켜자
  앱이 부팅되지 않아서 드러났다. 그중 `POST /api/tools?cols=…`(셸 생성)·
  `DELETE /api/tools/{id}` 가 있었다 — 정확히 게이트가 막아야 할 모양이다.
- `internal/webserver/httpapi` 의 테스트 105건이 `httptest.NewRequest` 의 기본 Host
  (`example.com`)로 요청을 만들고 있었다. `apiTestRequest` 헬퍼로 일괄 정리했다.

### 2.5 이번 세션이 찾아 고친 것 — **M2 자신이 만든 회귀 넷**

전체 e2e 를 처음으로 끝까지 본 결과, 실패의 대부분이 이 마일스톤의 조치가 남긴
것이었다. 넷 다 **게이트를 느슨하게 하지 않고** 닫았다.

#### (1) e2e 픽스처가 개발자의 인스턴스 정체를 물려받았다

**증상.** e2e 1,449건이 **전부** 픽스처 단계에서 무너졌다 —
`Fixture "dmServer" timeout of 60000ms exceeded during setup.`

이 저장소를 **dongminal 안에서** 개발하면 도구 셸의 환경에 그 인스턴스의 정체가
들어 있다. `DONGMINAL_HOST`·`DONGMINAL_PORT`·`DONGMINAL_TOOL_ID`·
`DONGMINAL_HISTFILE` 는 서버가 자기 자식에게 심어 주는 값이고 `npx playwright` 는
그 자식 중 하나인데, `fixtures.ts` 가 `...process.env` 로 통째로 물려주고 있었다.

그래서 워커의 서버가 `DONGMINAL_HOST=0.0.0.0` 을 보고 **노출 모드로** 떴고, 이
마일스톤의 노출 게이트(`FR-RQG-20`)가 ACL 이 없다며 기동을 거부했다.

```
노출(0.0.0.0) 상태인데 허용 목록이 아직 없습니다.
```

**게이트는 옳았다 — 물려준 쪽이 틀렸다.** `hermeticEnv()` 가 그 넷을 지운다. 워커
마다 자기 인스턴스를 갖는다는 `FR-EPL-1` 의 전제가 그 자리에서 깨지고 있었으므로,
노출 게이트가 없었어도 잠재 결함이다.

#### (2) CSP 가 **첫 페인트를 막고 있었다** (`SEC-11` 회귀)

`index.html` 의 head 에는 선주입 스크립트가 둘 있다 — 테마 변수와 사이드바 너비를
첫 페인트 **이전에** 세운다 (`BOOT_SCREEN_SRS` FR-BTS-3). 둘 다 **인라인**이다.

1차 세션이 `script-src 'self'` 를 세우면서 그 둘이 조용히 막혔다. 저장한 테마가
첫 페인트에 반영되지 않고, 사이드바가 접힌 상태로 저장돼 있어도 펼쳐진 채 그려진다.
`boot-screen.spec.ts` 의 V-1·V-3 이 그것을 잡고 있었다.

**세 길 중 해시를 골랐다** (`MONACO_VENDORING_SRS` FR-MVN-13a).

| 길 | 왜 아닌가 / 왜 |
|---|---|
| `'unsafe-inline'` | `FE-1`(상태바 XSS)의 2차 방어가 통째로 사라진다 |
| 외부 파일로 이동 | `BOOT_SCREEN_SRS` NFR-1 이 "네트워크에 닿지 않는다" 를 요구한다. 첫 페인트 앞에 왕복이 생긴다 |
| **`'sha256-…'` 해시** | **그 둘만** 허용한다. 해시는 기동 시 **서빙되는 바이트에서** 계산하므로 두 벌이 될 수 없다 |

#### (3) 종료 오버레이가 `ReferenceError` 로 터졌다

`term-pane.js:617` 이 `innerHTML` 에 `escHtml(...)` 을 끼워 넣고 있었다 —
`check-html.sh` 를 통과시키려던 1차 세션의 조치다. 그런데 `escHtml` 은
`helpers.js` 의 전역이고, 그 파일을 싣지 않는 자리에서는 없다.

`_confirmClose` 를 옮긴 것과 **같은 규약**으로 다시 썼다 — `textContent` 와 DOM
조립. 이스케이프를 부를 필요가 없어지고, 부를 함수가 스코프에 있는지도 묻지 않는다.

#### (4) e2e 호출부 넷이 게이트에 걸려 있었다

**본문 없는 상태 변경**이다. `data` 를 객체로 주는 호출은 Playwright 가 알아서
Content-Type 을 밝히므로 139곳 중 넷만 남았고, 그 넷이 정확히 게이트가 겨냥한
모양이었다.

```
fixtures.ts:48   DELETE /api/tools/{id}              ← 고아 도구 회수
fixtures.ts:125  POST   /api/tools/attention/clear-all
git-window       POST   /api/tools?cols=120&rows=40
workspace-identity  같음
focus-invariant  POST   /api/tools?cols=99999&rows=24
```

앞의 둘은 **모든 테스트 앞에서 도는 정리 함수**다. 415 로 조용히 실패하는 동안
고아 도구가 쌓였고, 그것이 뒤 스펙의 개수 단정을 무너뜨렸다 — `bg-kill` 의
"1이어야 하는데 6" 이 그 자국이다. 1차 세션이 "자원 경합" 으로 읽은 것의 정체다.

**게이트는 옳다.** `POST /api/tools?cwd=…` 는 쿼리스트링만으로 셸을 만든다 —
본문 유무로 예외를 두면 그 경로가 그대로 열린다 (`FR-RQG-5`).

### 2.6 오류 분류 — 어떻게 갈랐나 (`GO-11`·`SEC-17`)

`internal/webserver/httpapi/fail.go` 하나로 모았다.

**가르는 기준은 상태 코드가 아니라 누가 그 말을 썼는가다.** 400 이라고 안전하지
않다 — 파일을 여는 400 은 경로를 담는다. 반대로 500 이어도 우리가 쓴 문구면 보여도
된다. 그래서 판정을 호출자에게 두고, 호출자가 감출 것을 정한다.

| | 하는 일 |
|---|---|
| `fail(w, code, msg, err)` | `msg` 가 본문이 되고 `err` 는 **로그로만** 간다 |
| `failRead(w, err)` | `httpreq.Read` 의 실패. 상한 초과는 사유가 보이고(413), 그 밖의 읽기 실패는 감춘다(400) |

**사유가 그대로 나가는 자리를 남겼다** — 사용자가 방금 보낸 것에 대한 말이기
때문이다: ACL 항목 검증(`app-settings.js` 의 `_aclSave` 가 그 본문을 띄운다) ·
워크스페이스 파싱 · `openUrl` 인자 · `location` uuid · 샌드박스 **정의**.

**감춘 자리**: 도구 생성 실패(PTY·경로) · 샌드박스 정의 읽기/쓰기 실패(절대경로) ·
본문 읽기 실패(연결 사정) · ACL **저장** 실패.

정의와 저장을 가르려고 표식 둘을 세웠다 — `sandbox.ErrSaveFailed` ·
`httpapi.errAccessSaveFailed`.

문자열로 오류를 가르던 셋도 없앴다.

```
toolhub/tool.go     "input/output error"     → errors.Is(err, syscall.EIO)
handlers_ws.go      "use of closed …"        → errors.Is(err, net.ErrClosed)
handlers_files.go   "request body too large" → errors.As 만 남기고 폴백 삭제
```

`syscall.EIO` 는 다섯 대상에서 전부 컴파일되고(`check-cross.sh` 통과),
`check-seams.sh` 의 금지 목록(`syscall.Kill`·`SIG*`·`Signal`)에 닿지 않는다.

`query/blame.go:82` 은 **git 의 stderr 문자열**을 본다 — Go 오류 분류가 아니므로
이 항목이 아니다. 그대로 두었다.

### 2.7 `FE-8` — 서버를 부르는 자리를 한 겹으로

스펙: [`CLIENT_API_SRS.md`](../CLIENT_API_SRS.md).

**손수 `fetch` 81곳 / 28파일이 `web/js/core/api.js` 를 지난다.** 남은 둘은
전송 겹 자신과 `TimerHub` 의 주입 fetch(`ctx.fetch`)뿐이며, 그 사실을
`scripts/check-fetch.sh` 가 `make gates`·`verify.yml` 에서 지킨다.

봉투 하나로 통일했다 — `{ok, status, data, text, headers}`.

| 설계 | 왜 |
|---|---|
| **본문을 한 번 읽고 `data`·`text` 를 함께 준다** | `Response` 의 본문은 한 번뿐이라 종전에는 자리마다 하나만 골라 읽었고, 그래서 **실패 경로에서 서버가 준 사유를 버리는 자리**가 있었다 |
| **상태 변경은 본문이 없어도 JSON 을 밝힌다** | 게이트를 켰을 때 앱이 부팅되지 않은 그 결함(§2.4)이 **구조적으로 불가능**해진다 |
| **`headers` 를 싣는다** | 워크스페이스의 낙관적 잠금이 `ETag`/`If-Match` 위에 선다. 못 주면 세 자리가 이 겹을 못 지나고, 하나라도 못 지나면 M4 의 401 이 다시 흩어진다 |
| **`ok` 는 HTTP 성공만 본다** | 코어에는 204 를 내는 종단이 있다. `git/api.js` 의 `ok` 는 여기에 `data!==null` 과 echo 를 더한 것이며 그 차이는 의도된 것이다 |
| **던지지 않는다** | 호출부에 `try/catch` 가 생기지 않는 것이 이 겹의 값이다. 응답 없이 resolve 하는 주입 fetch 도 전송 실패로 읽는다 |
| **시한은 옵트인** | `/api/status` 가 최대 30분을 기다린다. 전역 기본 시한을 두면 그 종단이 조용히 끊긴다 |

`git/api.js` 는 **계약을 그대로 두고 전송만 내렸다** — echo·stale 은 git 화면의
것이며 일반화 대상이 아니다. `gitFetch` 를 지나지 않던 git 의 **10곳**도 함께
옮겼다. 그것을 남기면 401 자리가 다시 둘이 된다.

`apiSend` 안에 **M4 의 401 자리**를 주석으로 예약했다 (`authGate` 와 같은 규약 —
빈 함수를 두지 않는다).

**옮기면서 드러난 것 하나.** 합성 페이지로 스크립트 몇 개만 싣는 e2e 스펙 셋
(`event-timer-hub-contract`·`sse-resilience`·`reconnect-storm`)은 `index.html` 의
로드 순서를 물려받지 않아 `core/api.js` 를 함께 실어야 한다. `term-pane.js` 의
`escHtml` 이 같은 부류였다(§2.5-3) — **합성 페이지는 전역 의존이 드러나는 자리다.**

### 2.8 `GO-39`·`FBE-08` — git 실행 층을 하나로 (`GIT_EXEC_UNIFY_SRS`)

git 프로세스를 띄우는 자리가 **다섯**인데 그중 **둘만** `core.Env()` 를 썼다.
나머지 셋은 프롬프트·askpass·페이저·편집기를 막지 않은 채 git 을 띄웠고,
출력 상한·오류 분류·**실행 기록**도 없었다 — Console 과 Replay 가 그 셋을 보지
못했다.

| 자리 | 종전 | 지금 |
|---|---|---|
| `git/core/exec.go` · `git/jobs/job.go` | `Env()` ✅ | 그대로 |
| `worktree/worktree.go:160` | 직접 실행, 규약 전무 | `core.ExecUnguarded` |
| `submodule/submodule.go:269` | 직접 실행, 규약 전무 | `core.ExecUnguarded` |
| `httpapi/handlers_fs_ignored.go:92` | 직접 실행, 규약 전무 | `core.ExecUnguarded` |

**층을 갈랐다.** `core.Service` 가 한 덩어리로 갖던 두 가지를 나눴다 —
`Exec`/`ExecWrite`(인가: 명령 화이트리스트)와 `ExecUnguarded`(실행: 환경·마감·
상한·취소·분류·기록). 세 도메인은 자기 인가(`checkRepo`·`checkPath`·`--` 규약·
루트 가드)를 이미 갖고 있으므로 **실행 방법만** 공유한다.

**화이트리스트는 한 항목도 늘지 않았다.** `FR-GIT-246`(worktree)과 `D-9`(submodule)이
"어느 목록에 넣어도 `argv[0]` 키잉과 교집합-금지 불변식이 뜻을 잃는다"를 두 번에
걸쳐 확정했고, 그 판단은 지금도 옳다. 착수 초기에 그 결정을 모르고 화이트리스트
확장을 설계했다가 되돌렸다 — **기각된 것은 인가 층의 확장이지 실행 층의 공유가
아니었다.**

**왜 셋이 빠져 있었나 — 게이트 사각.** `FR-GIT-1` 의 정적 검사는
`exec.Command("git", …)` 라는 **리터럴**을 찾는데, 다섯 자리가 **전부**
`LookPath("git")` → `exec.Command(bin, …)` 형태여서 **하나도 걸리지 않았다.**
정규식을 변수까지 넓히는 것은 답이 아니다(`bin` 은 `rg`·`docker` 이기도 하다).
**기준을 바꿨다** — git 을 띄우려면 반드시 지나는 `LookPath("git")` 을 센다.

게이트 셋을 세웠고(`core/exec_gate_test.go`), 임시 탐침으로 **실제 검출을
확인**했다 — 정적 검사는 위반이 없을 때도 통과하므로 "초록"은 동작의 증거가
아니다. 이 저장소가 정확히 그 함정에 있었다.

| 게이트 | 지키는 것 |
|---|---|
| `TestGitBinaryLookupIsConfinedToDomain` | git 바이너리를 얻는 자리가 `domain/git` 밖에 **0** |
| `TestExecUnguardedCallersAreConfined` | 인가를 건너뛰는 진입점의 **호출처 고정** — 이 설계의 안전 장치 |
| `TestGitExecSitesPassEnvContract` | git 을 띄우는 파일은 `Env()` 를 지난다 |
| `TestExecAllowlistsHaveNoDeadEntries` | 예외 목록에 **죽은 항목**이 없다 |
| `TestCommandAllowlistsDidNotGrow` | `readCommands` 15 · `writeCommands` 22 — 늘지 않았다 |

`execAllowed` 에서 `domain/worktree` 를 뺐다. 그 예외는 애초에 **검사되지도
않으면서** "여기서는 규약을 어겨도 된다"는 신호로 남아 있었고, 실제로 그 아래에서
`Env()` 없는 실행이 자랐다.

**`SEC-14` 는 조치 불요로 판정했다** (§3.2). `Replay` 는 인가를 지나지 않은 기록을
거부한다 — 종전에는 화이트리스트가 *우연히* 막고 있었을 뿐이다.

**검증.** `make gates` · `go test -race -shuffle=on ./...` 전량 · `npm run typecheck` ·
`npm run lint` · `npm run unit` 64건 · **e2e 전량**.

```
1445 passed · 3 flaky · 3 skipped · 0 failed  (15.4분)
flaky: git-history H8 · git-history H17 · git-ui-revision V71
```

**회귀가 아니다** — §6.3 의 기준선과 대조한 판정이다.

| | passed | flaky | failed |
|---|---|---|---|
| 기준선 1회차 | 1444 | 3 | 1 |
| 기준선 2회차 | 1443 | 4 | 1 |
| 기준선 3회차 | 1443 | 5 | 0 |
| **이번** | **1445** | **3** | **0** |

셋 다 재시도에서 통과했고(`0 failed`), passed 수가 기준선보다 높다. `git-history` 는
§6.3 이 이미 관측·판정한 자리이며(`H7` 이 그 예다) 사유가 "배경 폴링이 사용자의
명령보다 먼저 기록되는 경합" 으로 밝혀져 있다. `git-ui-revision` V71 은 탭 드래그라
이 변경(Go 의 git 실행 층)과 인과가 없다.

§6.3 이 세운 판정 규칙 — **"흔들리는 자리가 회차마다 전부 다르다는 것이 특정 변경의
회귀가 아니라는 근거"** — 와도 일치한다.

### 2.9 `U-10` — diff 의 편집이 확인 없이 사라졌다 (`FR-RTU-103` 신설)

**데이터 손실이었다.** git diff 탭에서 고친 내용이 탭·창을 닫을 때 아무 확인 없이
사라졌다. 사용자가 보고한 대로 "수정되어 있다는 표시가 있어도 물어보지 않았다."

**원인은 코드가 아니라 요구사항 둘의 모순이었다.**

| 요구 | 내용 |
|---|---|
| `FR-RTU-33` | git 뷰 탭은 "**확인 없이**" 닫힌다 — 근거: **"잃는 편집이 없다"** |
| `FR-RTU-53` | 저장되지 않은 diff 편집은 **탭 이름에 `●`** 를 세운다 |

`FR-RTU-33` 이 쓰인 시점에는 diff 가 읽기 전용이었고 그 근거가 참이었다. 그 뒤
같은 SRS 의 `FR-RTU-50`~`53` 이 **편집을 들이면서 전제가 깨졌다** — `●` 를 세우라는
요구 자체가 잃을 것이 있다는 증거인데, 닫는 경로는 여전히 "잃을 것이 없다" 를 믿고
있었다. **그 사이를 아무 검증도 보지 않았다.**

**표시와 확인이 서로 다른 값을 보고 있었다.**

```
panel-diff.js  _setDiffDirty()  →  found.tab.dirty = !!v      ← 사용자가 보는 ●
app-layout.js  closeTab()       →  if(editor && editor._dirty) ← tab.dirty 를 모른다
                                    ↑ tab.type==='editor' 게이트 뒤라 git 탭은 여기 오지도 않는다
```

**두 번째 층도 있었다.** `closeTab` 은 확인보다 **먼저** `_gitDropView` 를 불렀고,
그것이 `GitDiffView.destroy()` 를 한다 — 확인창을 붙이기만 했다면 **취소를 눌러도
편집이 돌아오지 않았을 것이다.**

#### 조치

`FR-RTU-103`·`103a`·`103b`·`103c` 를 신설해 `FR-RTU-33` 을 정정했다. 코드는:

| 자리 | 변경 |
|---|---|
| `panel-life.js` | `viewDirty(view)`·`viewSave(view)` — 뷰에게 직접 묻는다 |
| `app-git.js` | `_gitViewDirty`·`_gitViewSave` — 루트의 패널 전부를 돈다 (`_gitDropView` 와 같은 골격) |
| `app-layout.js closeTab` | 확인을 **`_gitDropView` 앞으로.** 저장 실패면 닫지 않는다 |
| `app-editor.js` | `_edWinDirty`·`_edWinSaveDirty` 가 git 탭도 센다 — 편집기가 없는 창도 diff 가 dirty 일 수 있다 |

**`tab.dirty` 를 판정 근거로 쓰지 않았다.** 그것은 표시를 위한 사본이고, 사본을
믿으면 동기화가 어긋난 순간 확인이 조용히 빠진다 (`FR-RTU-103b`).

**`FR-RTU-33` 의 나머지는 유지된다** — git 뷰 탭은 여전히 닫히고, 뷰 상태는 패널에
남아 다시 열면 그대로다. 편집이 없는 탭은 종전처럼 확인 없이 닫힌다.

#### 검증 — RED 를 먼저 보았다

`e2e/repo-diff-edit.spec.ts` 묶음 E 3건(`V-RTU-103a~c`). **수정을 되돌려 실제로
실패하는 것을 확인했다:**

| | 수정 전 | 수정 후 |
|---|---|---|
| E1 확인이 뜨고 취소 시 편집 유지 | **실패** | 통과 |
| E2 저장 후 닫기 | **실패** | 통과 |
| E3 편집 없으면 확인 없이 (`FR-RTU-33`) | 통과 | 통과 |

E3 가 양쪽에서 통과하는 것이 요점이다 — 이 수정이 기존 규약을 넓히지 않았다는 근거다.

### 2.10 탐색기 묶음 — 사용자 보고 여섯을 한 스펙으로 (`EXPLORER_ROOT_KEYS_SRS`)

5차 세션이 `U-4`·`U-11`·`U-12`·`U-13`·`U-14`·`U-16` 을 닫았다. **여섯이 한 흐름인
근거**는 얽힘이다 — 루트를 선택 가능하게 만들면(`U-4`) 키보드 삭제가 루트를
겨누고(`U-14`), 빈 여백 더블클릭이 부르는 `startCreate` 를 `U-16` 이 막고,
그것이 만든 파일을 `U-13` 이 연다. 따로 하면 "빈 여백은 무엇인가" 가 여러 벌로 갈린다.

| 요구 | 무엇을 했나 |
|---|---|
| `U-4` | 빈 여백·**머리** 클릭이 루트를 고른다. 판정은 드롭의 것을 그대로 쓴다 (`_dropDirAt` / `FR-FTR-20`). 루트에는 행이 없으므로 표시는 **머리**가 든다 (`.ed-head.sel`) |
| `U-12` | 빈 여백 더블클릭 → 루트에 새 **파일**. `startCreate(isDir,at)` 의 `at` 을 쓴다 |
| `U-13` | `doCreate` 가 **성공을 확인한 뒤** 파일이면 연다. 미리보기가 아니라 고정이다 |
| `U-14` | `.ed-explorer` 에 `tabindex` 와 `keydown` 하나. 조작 4종(`Delete`/`Backspace`·`Mod+C`·`Mod+V`·`F2`) + 방향키 탐색 + `Enter`. **조작은 하나도 새로 만들지 않았다** |
| `U-16` | `startCreate` **한 자리**에서 막고, 툴바 버튼·메뉴 항목은 감춘다. 서버 `apiFSCreate` 도 거부한다 (`dir:true` && root==notes → 400) |
| `U-11` | `.pn-tabs` 여백 더블클릭 → **그 여백이 속한 pane** 에 새 탭 |

**착수 전 제약 하나가 실측으로 지워졌다.** §3.4 는 `U-14` 의 전역 키 충돌 규약이
`PANEL_SHORTCUTS_SRS` 영역이라고 적었으나 **틀렸다** — 그 문서는 `Background`·`Runs`
버튼의 단축키만 다룬다. 실제 규약은 `EDITOR_GIT_UX_SRS` `FR-EKB-1`·`4` 이고,
그 전역 `keydown` 과 겹치는 키가 **하나도 없다**(`SHORTCUT_DEFAULTS`·
`BUILTIN_HOTKEYS`·`_blockBrowserDefault` 세 자리 전부 확인). 그래서 그 규약을
**개정하지 않았다**.

**놓쳤다가 스펙에 되넣은 것 하나.** `U-11` 은 Editor·Git 창에서 **돌지 않아야**
한다 — 그 창에는 `+` 자리 자체가 없다(`renderer.js:884` / `FR-GIT-180`·`FR-EDT-54`,
"눌리지만 아무 일도 하지 않는 버튼은 고장으로 읽힌다"). 구현은 판정을 새로 적지
않았다: `addTab` 이 이미 스스로 거절한다. **판정이 한 벌 그대로다.**

#### 실제로 걸린 것 — `tabindex` 는 포커스의 절반이다

`U-14` 의 본체는 키 사상이 아니었다. `tabindex="0"` 을 넣고 돌린 e2e 에서 **묶음 F
여섯이 전부 실패**했고 원인은 하나였다.

```
renderer.js `_rLayout` 이 매 render 마다 `.ed-win` 을 떼었다 붙인다
  → 요소가 떨어지는 순간 포커스가 사라진다 (activeElement === body)
  → 행을 한 번 클릭하면 미리보기가 열리고, 그 render 가 포커스를 없앤다
```

처음에는 렌더 후 재포커스가 **빼앗는다**고 보고 그쪽에 가드를 넣었다(`FR-EXR-58`).
**그것으로도 실패했다** — 빼앗기는 것이 아니라 **잃는** 것이었다.

**이 함정은 이미 기록돼 있었다.** `FR-EDT-66` 과 `_restoreEditFocus` 가 인라인
입력에 대해 똑같은 일을 한다("SSE 한 번이면 충분하다"). 컨테이너에도 같은 것이
필요했다 — 소유를 플래그로 들고(`_focusOwn`) `mount()` 에서 되돌린다. `focusout`
으로 소유를 지우는 판정도 그 주석이 미리 답해 두었다: 떨어져 나가며 잃은 blur 는
**요소가 다시 붙은 뒤에** 도착하므로 `relatedTarget` 이 바깥일 때만 지운다.

  → **교훈: 렌더가 요소를 떼는 앱에서 `tabindex` 는 절반이다.** 나머지 절반은
    "누가 쥐고 있었나" 를 기억하는 자리이고, 이 저장소에는 그 선례가 이미 둘
    있었다 (`_restoreEditFocus` · `_restoreScrollOf`). **새 결함을 만나면 같은
    함정의 선례를 먼저 찾아라** — `U-10` 이 요구사항에서, 이것이 구현에서 같은
    교훈을 냈다.

한 번 클릭(미리보기)과 더블클릭(고정)을 갈라야 했던 것도 여기서 나왔다 —
훑어보는 손짓은 탐색기가 포커스를 지키고(그래서 방향키가 이어진다), 여는 손짓은
편집기에 넘긴다(`FR-EXR-59`). 판정은 렌더 후 재포커스 **한 자리**가 소유한다
(`_edFocusWanted`) — 여는 자리마다 `focus()` 를 부르면 그것이 `FR-EFP-5` 가 겪은
형태가 된다.

#### 검증

```
explorer-root-keys.spec.ts            30건 통과 (V-EXR-1~59b)
handlers_fs_notes_dir_test.go          3건 통과 (V-EXR-60~62)
회귀 넷 9스펙                        165건 통과
  editor-explorer(X14 포함) · editor-ops · explorer-copy · notes-live-explorer ·
  file-transfer · repo-tab · editor-tab · doc-render · focus-invariant
포커스·슬롯·탭 계열 13스펙           273건 통과 (흔들림 3 — §6.3 의 부하 의존
                                      부류. 단독 재실행 92건 전량 통과)
make gates · go test -race -shuffle=on ./... · typecheck · lint · unit 64건
```

**RED 를 먼저 봤다.** 서버 쪽은 `V-EXR-60` 이 `code=200` 으로 실패했고(나머지 둘은
"종전대로" 를 지키는 회귀 가드라 처음부터 통과), 클라이언트 쪽은 묶음 A·E 를
먼저 돌려 7건 실패를 확인했다.

### 2.11 `U-15` — 팝업의 기본 포커스를 목적의 버튼으로 (`POPUP_DEFAULT_ACTION_SRS`)

**이 저장소가 요구사항으로 못박고 있던 것을 뒤집는 변경이다.** 기능 추가가 아니라
**결정 변경**이며, 그래서 코드보다 개정이 많다.

사용자가 절충안(비파괴적만 목적 버튼, 파괴적은 취소 유지)을 기각한 근거:

> **UX 는 사용자가 하고자 했던 걸 유지하는 방향이지, 안전한 방향이 아니다.**

#### 전수 조사 — 여덟 자리에 규약이 여섯 종이었다

| 기제 | 초기 포커스(전) | `Enter`(전) |
|---|---|---|
| `GitConfirm` | 취소 | 취소 (capture·preventDefault) |
| `GitDialog` | `_defBtn`→필드→취소 | 기본 동작 (**무조건** 가로챔) |
| `_confirmClose` | 취소 | 취소 (capture·preventDefault) |
| `_edConfirm` | 취소 | 핸들러 없음 |
| `_notify` | 확인 | 닫기 |
| 샌드박스 선택 | 입력→첫 옵션 | 핸들러 없음 |
| `UIKit.modal`—open-url | **열기** | 없음 |
| `UIKit.modal`—ACL | **없음** | 없음 |

**여덟 중 하나는 이미 새 규칙대로 서 있었다**(open-url). 같은 손짓의 뜻이
자리마다 다르고 그중 하나가 반대편에 있다 — 이것이 "모든 팝업에 통일" 이 기능
요구가 아니라 **규약 수렴**인 근거다.

#### 구현이 작아진 이유 — `Enter` 를 가로채는 대신 **가로채기를 없앴다**

요구를 그대로 읽으면 "`Enter` 가 목적 동작을 실행한다" 이고, 가장 직접적인 구현은
capture 핸들러에서 목적 동작을 부르는 것이다. **그러면 포커스가 취소에 있어도
`Enter` 가 실행한다** — 보이는 것과 일어나는 일이 달라진다. 이 요구가 고치려는
문제를 다른 자리에 새로 만드는 것이다.

브라우저 기본 동작(포커스된 버튼의 click 합성)에 맡기면 규약이 **한 줄**로 준다:

> **기본 포커스를 어디에 두는가.** `Enter` 는 언제나 "보이는 것을 누른다".

그래서 바꾼 것은 `_focus()` 다섯 자리와, `Enter` 가로채기를 지운 두 자리다.
새 헬퍼를 만들지 않았다. `GitDialog` 는 필드에서 온 `Enter` 만 목적 버튼으로
보내도록 좁혔다 — 그 자리에는 브라우저 기본 동작이 없기 때문이다.

  → **`GitDialog` 에 있던 결함이 이 과정에서 드러났다.** 그것은 `Enter` 를 **구분
    없이** 가로채고 있어서, 취소에 포커스를 두고 눌러도 **실행됐다.** 그것을
    단정하는 검증이 하나도 없었다.

#### 층을 구분한 자리 하나

dirty checkout 의 선택지(`취소`·`stash`·`강제`)는 기본이 `cancel` 이고 그 검증이
포커스를 재고 있어서 이 변경에 걸리는 것처럼 보인다. **걸리지 않는다** —
**무엇이 미리 골라져 있는가**는 `FR-GIT-157`·`O14` 가 정하고, 이 스펙은 **골라진
것에 포커스가 가는가**를 정한다. 층이 다르므로 선택지의 기본은 취소인 채로 두고,
그 뒤 강제를 골라 뜬 `GitConfirm` 의 기본 포커스만 목적 버튼이 됐다.

#### 함께 개정한 것 (코드만 고치면 게이트가 되돌린다)

```
GIT_SRS            FR-GIT-94(포커스 문장 삭제) · 97(개정) · 176(뒷문장 철회) · V38
CONFIRM_ONE_STAGE  FR-COS-6(두 항목 철회) · FR-COS-7(철회) · D-4(논거 교체) ·
                   TC-COS-7·8 · 비목표 2
e2e                git-confirm J5·J6·J6c · git-dialog D3·D6 · git-stash ·
                   git-branches B9 · git-branch-actions · statusbar-xss UX1·UX2
코드 주석          confirm.js 머리 · dialog.js 머리 · app-tool.js `_confirmClose`
판정               `UX-1`(§2.2) — 넷 중 둘이 되돌아가고 둘은 남는다
```

`statusbar-xss` 의 `묶음 UX1` 이 그 판정의 검증 자리였다 — **이름부터
"확인창의 Enter 는 실행이 아니다" 였다.** 지우지 않고 뜻을 뒤집어 다시 썼다
(`FR-COS-5` 와 같은 근거: 지우면 그 자리가 무엇을 보고 있었는지 함께 사라진다).

#### 검증

```
popup-default-action.spec.ts     18건 통과 (V-PDA-1~41)
회귀 넷 20스펙                  실패 0 (git-confirm·git-dialog·git-stash·
                                 git-branches·git-branch-actions·git-tag·
                                 git-worktrees·git-submodules·git-discard-all·
                                 git-folder-stage·git-staging·git-changes·
                                 git-commit·editor-ops·explorer-root-keys·
                                 repo-diff-edit·ux-batch8·background-ui·
                                 sandbox-runtime·statusbar-xss·attention)
make gates · go test ./... · typecheck · lint · unit
```

**RED 를 먼저 봤다** — 12 실패 / 6 통과. 통과한 여섯은 이미 새 규칙과 같던
자리들이다(`open-url` 의 포커스, `Esc` 의 동작, 선택형의 기본 선택).

  → **가로채기를 검증한 자리가 `V-PDA-3`·`13`·`32` 다.** "취소로 포커스를 옮긴 뒤
    `Enter` 가 취소인가" 를 묻는다. 이것이 없으면 가로채기 구현도 통과한다.

### 2.12 `U-7`·`U-8` — UI 레이아웃 기본값과 게이트 셋 (`UI_LAYOUT_DEFAULTS_SRS`)

**성공 판정이 "아무것도 달라지지 않는 것" 인 구조 변경이다.** 그런데 실측이 그
전제를 두 번 고쳤다 — 문서가 **가능성**으로 적은 것이 실제로는 **살아 있는 결함
넷**이었고, C1 의 설계 전제 셋은 틀렸다.

#### 닫은 결함 넷

| 결함 | 실측 | 원인 |
|---|---|---|
| `worktrees`·`submodules` 목록이 **870px 이상 잘려 닿을 수 없다** | 뷰 `scrollH/clientH` = 1504/634 · 1509/634 (행 60개 주입) | 그 둘만 `.git-view.git-<뷰>` 가 아니라 **`.git-<뷰>`**(0-1-0)로 적어 `.git-view.vis`(0-2-0)에 **졌다** → `display:block` 계산 → `flex:1 1 auto`·`min-height:0` 이 전부 무력화 |
| `blame` 의 스크롤이 다른 뷰와 다르다 (`U-7`) | 바깥이 `overflow:auto` | 안내줄이 행과 함께 밀려 올라갔다. 다른 일곱 뷰는 "안쪽 목록만 구른다" 다 |
| **모바일 `m-add-tab` 이 `hidden=true` 인데 `display=flex`** | 탐침 실측 | `body.mobile .mtbtn.mobile-only{display:flex!important}`(0-3-0)가 숨김(0-1-0 !important)을 이긴다. `FR-EDT-54`("아무 일도 하지 않는 버튼은 고장으로 읽힌다")가 모바일에서 안 지켜졌다 |
| `style.css` 끝의 **닫히지 않은 `/*`** | `/*`=166 · `*/`=165 | `*/` 를 잃은 중복 붙여넣기(설명은 `:1375` 에 이미 있었다). 파일 끝이라 잃는 것이 없어 아무도 몰랐지만 **그 뒤에 규칙을 하나만 붙여도 브라우저가 삼킨다** |

**셋째는 이 작업이 만든 것이 아니라 드러낸 것이다** — 옛 `.git-hidden`
(0-1-0 !important)도 똑같이 졌다. 넷 다 **항목이 적은 픽스처에서는 드러나지
않아 e2e 가 통과하고 있었다.**

#### C1 은 착수 실측이 전제 셋을 뒤집어 사용자 결정으로 좁혔다

최초 스펙은 "어휘 여섯 종을 `[hidden]` 하나로 수렴" 이었다.

  · `.vis` 는 켜기/끄기만 하지 않는다 — **전이**(`opacity`)와 **결합자**
    (`.fe-find.vis ~ .fe-note`)에도 쓰이고, `[hidden]` 으로 **표현할 수 없다**
  · 어휘가 여섯이 아니라 **일곱**이었다 (`.visible` 을 못 셌다)
  · **죽은 규칙이 둘** — `.doc-render.vis`(기본이 이미 flex, 숨기는 CSS 가 없다) ·
    `.status-bar.hidden`(그 클래스를 붙이는 자리가 하나도 없다)

그리고 이관 부분은 **결함 증거가 0** 이었다 — C2 의 870px 잘림과 대조된다.
`M3_REFACTOR_NEXT_SESSION` §2 가 "근거가 (a)~(d) 어디에도 없으면 하지 마라" 인
그 자리다. 그래서 **증거 있는 부분 + 어휘 게이트**로 확정했다(사용자 결정).

  · `[hidden]{display:none!important}` 한 자리 + 재정의 **네 자리 삭제**
  · "있으면 숨김" 어휘 넷(`.hidden`·`.off`·`.gone`·`.git-hidden`)을 `[hidden]` 으로
  · `.vis` 51자리는 **그대로** — 이관의 근거가 없다
  · 극성이 둘로 굳었다: **있으면 보임 `.vis` · 있으면 숨김 `[hidden]`**

**C3 는 선언을 하나도 바꾸지 않았다.** 탐침으로 전 화면을 훑어 `inset:0` 인
요소의 담는 블록이 어긋난 자리가 **하나도 없었다**. CSS 의 두 주석은 그 함정을
*겪고 고친* 기록이다. 근거 없이 22곳을 흔들지 않았다 — 산출물은 게이트다.

#### 검증 수단을 스스로 검증해야 했다

시각 회귀 기준선이 없으므로 **계산값 스냅샷**을 만들었다(전 화면의
`display`·`overflow`·`position`·`inset`·`flex-direction`·`min-height`).

**첫 판이 4회 중 2회 흔들렸다** — 커밋 제목·카운트 배지·검색 입력의 폭이 내용과
폴링 시점에 매인다. 두 번 좁혔다: 상자 기하(픽셀)를 **잘림/스크롤 여부**(불리언)로
바꾸고, 조건부로 뜨는 요소의 유무를 대조에서 뺐다(요소의 **존재**는 다른 스펙
300여 건이 이미 단정한다). 그 뒤 4회 연속 결정론적이다.

  → **흔들리는 것은 검증 수단이 아니다.** 기준선을 뜨기 전에 그것을 확인해야
    한다 — 흔들리는 기준선은 회귀를 가리는 데 쓰인다.

**C1 단계에서 기준선을 한 번 다시 떴다.** 식별자가 클래스(`.gone`·`.git-hidden`)
에서 **속성**으로 옮겨 가면서 클래스로 만든 키 27개가 합쳐졌기 때문이다.
**재기준화는 "달라진 것이 없다" 의 증명이 아니므로** 그 사실을 SRS §5.1 에 적고,
C1 의 증명을 직접 검증(`V-LAY-20~22`)과 회귀 넷으로 옮겼다.

#### 게이트 셋 — 요구의 절반

`U-8` 의 뒷문장("또 이렇게 맞지 않는 ui 가 나오면 안 되잖아")이 요구의 절반이다.

```
check-visibility.sh   [hidden] 정본 1자리 · 숨김 어휘가 display 를 다루지 않는가 ·
                      **이름 없이** 잡는 구조 규칙(주체에 클래스 2+ 인데 display:none)
check-scroll.sh       .git-view.git-* 재정의 0 · 명시도 낮은 골격 규칙 0.
                      뷰 이름은 GIT_VIEWS **한 자리**에서 읽는다
check-skeleton.sh     inset:0 이 position 과 같은 규칙에 · **주석이 닫혔는가**
```

`make gates`(9종)·`verify.yml` 에 넣었고 **일곱 형태의 위반을 탐침으로 하나씩
확인하고 지웠다** (`FR-LAY-40`).

  → **그 과정에서 게이트가 검출에 실패하는 것을 잡았다.** `check-skeleton.sh` 의
    `awk` 판이 탐침을 통과시켰다 — macOS `awk` 는 `split(s,a,"")` 로 문자 분할을
    하지 못한다(gawk 확장). perl 로 되돌렸다. **초록은 그 검사가 동작한다는
    증거가 아니다** (§0-B 와 같은 교훈이 다시 나왔다).

`FR-LAY-34` 도 정정했다 — "`dongminal verify` 에 게이트 항목 추가" 를 그 명령으로
읽었는데 **틀렸다.** 그것은 서버를 띄워 HTTP 표면을 두드리는 **런타임 종단간**
검사이며(`verify.go` 머리 주석), 정적 CSS 검사의 자리가 아니다. 기존 여섯도
`make gates`·`verify.yml` 에 있다.

#### 검증

```
ui-layout-defaults.spec.ts    7건 (기준선 2,022자리 대조 + 결함 넷 + [hidden] 네 종)
회귀 넷 24스펙              378건 · 실패 0
  git 여덟 뷰 · git-commit·operation·hunk·dialog·confirm ·
  sidebar-tabs·sidebar-collapse·boot-screen · editor-find-panel·dirty-diff ·
  repo-tab·repo-diff-edit·doc-render·runs·layout·settings
make gates(9종) · go test ./... · typecheck · lint · unit 64건
```

---

## 3. 남은 것

### 3.1 P1 — **전부 닫혔다**

이월 하나만 남는다.

| 발견 | 내용 |
|---|---|
| `SEC-7` 잔여 | `/api/upload`·`/api/download` 의 경계 — `FILE_API_BOUNDARY_SRS` §5 비목표 2 가 **M8 로 넘겼다**. 그때까지 게이트가 호출을 덮는다 |

### 3.2 P2·기능축

**닫힘**: `GO-39`·`FBE-08` — git 실행 층을 하나로 모았다 (§2.8). `SEC-14` 는
**조치 불요로 판정**했다 — 초크포인트를 지나지 않는 것이 `FR-GIT-246`·`D-9` 가
확정한 설계이며, 감사가 그 결정을 모른 채 쓴 항목이다. 다만 그 판정이 실행
방법까지 갈라 두라는 뜻은 아니었으므로 그쪽은 공유하게 했다.

**남음**: `SEC-10`·`SEC-12`·`SEC-13`·`SEC-15`·`SEC-16`·`SEC-18`~`SEC-20` ·
`GO-23`·`GO-38` · `FE-15`~`FE-17` · `FUI-06`(편집기 크기 상한) ·
`09` 비목표 3(샌드박스 cpu·memory·pids 상한).

`GO-23`(JSON 응답조립 5종 중복)은 **착수 근거가 없다**고 판정했다 —
`M3_REFACTOR_NEXT_SESSION` §2 의 (a)~(d) 어디에도 해당하지 않고, 오류 본문 방언
4종은 공개 계약이라 통일이 금지돼 있다 (`architecture.md:141-176`).

### 3.3 DoD 중 아직 못 채운 항목

- `wait` 동시 수 상한 · diag 스냅샷의 임계 경고.
- 헤드리스 명령 로그를 전문 대신 길이·해시로.
- ~~`worktree.execGit`·`submodule` 실행기의 `core.Env()` 공유 (B5).~~ **닫힘** (§2.8)
- 편집기의 `probe.size` 상한(`FUI-06`) — 서버 `SEC-19` 상한과 같은 값.
- 샌드박스 컨테이너의 cpu·memory·pids 상한.
- `dongminal verify` 에 게이트 항목 추가.

**CSP 의 외부 호스트는 더는 잔여가 아니다** — §4 가 그것을 닫았다.

### 3.4 사용자 보고 — 분석·수정 대상

감사 목록이 아니라 **사용자가 직접 쓰면서 보고한 것**이다. 원인 조사가 먼저이며,
조사 결과에 따라 규모(소/중)와 SRS 필요 여부가 갈린다.

| # | 증상 | 첫 조사 지점 |
|---|---|---|
| U-1 | **LSP 로 파일이 연결되지 않는다** | `handlers_lsp.go` · `web/js/ui/file-editor.js` 의 LSP 결선 · 서버 기동 조건 |
| U-2 | **미리보기를 좌하단으로 옮기고, 색을 바꿔 잘 보이게 한다** | 미리보기 오버레이의 배치·대비 (`web/js/ui/`) |
| U-3 | **`claude code`·`omp` 에서 스크롤이 위로 붙는 문제가 아직 남아 있다** — **2026-09-10 재확인**: "스크롤이 **최상단으로** 가 있을 때가 있다" | 종전 조치가 있었으나 미해결. 재확인된 문구가 증상을 좁힌다 — 붙는 자리가 **최상단**이다. 터미널 스크롤백(xterm)의 자리이며 `U-17`(가끔 스크롤이 안 됨)과 **같은 뿌리일 수 있다** — 둘 다 "높이·위치를 잘못된 순간에 잰다" 로 설명된다. 재현 조건부터 다시 잡고, 둘을 함께 본다 |
| U-4 | **탐색기의 빈 공간을 클릭하면 커서가 root 로 간다** | ✅ **닫혔다** (`FR-EXR-1`~`6`). 머리 클릭도 함께 들어갔다 — 판정은 드롭의 `_dropDirAt`(`FR-FTR-20`) 그대로다. §2.10 |
| U-5 | **탐색기에 다중 선택을 더한다** (`Cmd`+클릭 · `Shift`+클릭) | 선택 모델이 단일이라면 그것을 집합으로 넓히는 일이고, 삭제·이동·복사 등 **선택을 소비하는 자리 전부**가 함께 바뀐다 |
| U-6 | **History 머리의 Fetch·Pull·Push 버튼을 뺀다** — Changes 와 History 를 이제 함께 보므로 같은 버튼이 두 벌이다 | `panel-changes.js:809 headHTML()` 가 두 뷰의 머리를 **한 자리에서** 만든다(FR-GHM-4). History 만 `.git-head-remote` 를 빼는 갈래가 필요하다 |
| U-7 | **blame 의 스크롤이 다른 뷰와 다르다** | ✅ **닫혔다** (`FR-LAY-24`). 바깥은 `hidden`, 행 목록만 구른다 — 다른 일곱 뷰와 같은 형태다. §2.12 |
| U-8 | **UI 전체의 기본을 루트에서 미리 정해 두고, 어긋난 UI 가 다시 나오지 않게 한다** | ✅ **닫혔다** (`UI_LAYOUT_DEFAULTS_SRS`, `FR-LAY-1`~`51`). **살아 있는 결함 넷**을 찾아 닫고(870px 잘림 둘 · 모바일 `m-add-tab` · 닫히지 않은 주석) 게이트 셋을 세웠다. C3 는 어긋난 자리가 없어 선언을 바꾸지 않았다. §2.12 |
| U-9 | **`Stage hunk`·`Revert hunk` 툴바를 hover 가 아니라 해당 줄을 클릭해 커서가 있을 때 뜨게 하고, 뜨는 위치를 조정한다** | `panel-diff.js:442-443` 이 `onMouseMove`·`onMouseLeave` 로 띄우고, `:501` 이 위치를 `hunk.newStart`(조각 첫 줄)에 고정한다. **스펙 개정을 동반한다** — 아래 |
| U-10 | **편집기·diff 창을 닫을 때 수정 표시가 있어도 묻지 않는다** — 저장 안 한 내용이 사라진다 | ✅ **닫혔다** (`FR-RTU-103` 신설). 원인은 `FR-RTU-33`("확인은 없다 — 잃는 편집이 없다")과 `FR-RTU-53`(dirty 를 탭에 `●`)의 **모순**이었다. §2.9 |
| U-11 | **기능 추가** — 탭 바의 **빈 공간을 더블클릭**하면 새 탭이 열린다 | ✅ **닫혔다** (`FR-EXR-40`~`44`). 자리는 **그 여백이 속한 pane** 이고, Editor·Git 창에서는 `addTab` 이 스스로 거절한다. §2.10 |
| U-12 | **기능 추가** — 탐색기의 **빈 공간을 더블클릭**하면 새 파일을 만든다 (U-4 와 맞물려 **루트**에 만든다) | ✅ **닫혔다** (`FR-EXR-10`~`12`). §2.10 |
| U-13 | **기능 추가** — 파일이 만들어지면 **그 파일을 즉시 연다** | ✅ **닫혔다** (`FR-EXR-20`~`24`). **성공을 확인한 뒤** 열고, 미리보기가 아니라 고정이다. §2.10 |
| U-14 | **기능 추가** — 탐색기를 클릭하면 편집기로부터 **키보드 주도권을 가져오고**, 탐색기에서 **키보드로 삭제·복사·붙여넣기**를 한다 | ✅ **닫혔다** (`FR-EXR-50`~`59`). 조작 4종 + 방향키 + `Enter`(사용자 결정). **본체는 키 사상이 아니라 포커스였다** — `tabindex` 만으로는 한 프레임도 안 버틴다. §2.10 |
| U-15 | **팝업의 기본 포커스를 그 팝업의 목적에 맞는 버튼에 두어 `Enter` 로 바로 실행**한다. 예: 삭제 확인창이면 삭제 버튼. `Esc` 는 동작하지 않고 창닫기. **모든 팝업에 통일** | ✅ **닫혔다** (`POPUP_DEFAULT_ACTION_SRS`, `FR-PDA-1`~`26`). 여덟 자리·규약 여섯 종을 하나로 모았다. `Enter` 를 **가로채지 않는** 쪽으로 구현해 "포커스와 결과가 어긋나는" 새 문제를 만들지 않았다. §2.11 |
| U-16 | **메모장(Notes)에서는 폴더를 만들 수 없고 파일만 만들어지게** 한다 | ✅ **닫혔다** (`FR-EXR-30`~`35`). `startCreate` 한 자리에서 막고 서버도 거부한다(사용자 결정). §2.10 |
| U-17 | **가끔 스크롤이 안 될 때가 있다. 새로고침하면 풀린다** (2026-09-10 접수) | **`U-8` 의 정적 결함과 성질이 다르다** — 명시도 문제는 새로고침으로 풀리지 않는다. "새로고침하면 풀린다" 는 **런타임 상태가 굳는다**는 뜻이다. 첫 조사 지점은 flex 자손이 줄어들지 못하는 자리(`min-height:0` 누락)와 **높이가 0 인 순간에 잰 것이 남는** 경로다 — `elFor`(`panel-life.js:81`)의 주석이 이미 그 부류를 적고 있다("루트가 아직 pane 본문에 붙기 전이라 목록의 높이가 0 이다"). `_scrollY` 복원(`file-tree.js mount`)·`_restoreScrollOf`(`FR-PDR-10`)도 같은 자리다. 재현 조건부터 잡는다 |
| U-18 | **MagicDNS 이름으로는 접속이 안 된다** — tailnet 의 다른 기기에서 IP 로는 되고 `macmini-office` 로는 `/ws`·`/api/*` 가 전부 **421** 이다 (2026-09-10 접수, 조사 완료) | **원인 확정.** `accessGate` 는 통과하고 `requestGate` 의 Host 판정이 막는다 (`reqgate.go:181`·`hostAllow.ok()` `:88`). 서버는 자기 이름을 `os.Hostname()` 으로만 알고 (`DongyoonKimui-Macmini.local`) tailnet 별명 `macmini-office` 를 **자기 것으로 인식하지 못한다**. 축이 둘인데 UI 는 하나만 표현한다 — ①누가 들어오나(출발지 IP, access 칸이 담당) · ②**뭐라고 불리며 들어오나**(Host, **입력할 자리가 없다**). `--allowed-host` 가 축②의 설계였으나 **CLI 배선이 없다**(`main.go:464`). 아래 상세 참조 |
| U-19 | **하단 status bar 의 "Git 원격 작업 진행" 이 안 보인다. 뭔지도 모르겠다** (2026-09-10 접수) | **불만이 둘이다.** ① 안 보인다 — `_gitJobChip`(`app-git.js:852`)이 `if(!jobs.length) return null` 이라 **진행 중인 원격 작업이 실제로 있을 때만** 뜬다. fetch/pull/push 가 도는 몇 초뿐이므로 사실상 늘 없다(설정 기본값은 `def:true` 로 켜져 있다 — `helpers.js:353`). ② 뭔지도 모르겠다 — **설정의 이름이 그 사실을 말하지 않는다.** `'Git 원격 작업 진행'`(`STATUS_ITEMS.git`)은 상주 지표처럼 읽히는데 실제로는 순간 표시다. `FR-GIT-112` 는 "Git 창을 보지 않아도 알 수 있어야 한다" 이므로 **요구 자체는 그 동작이 맞다** — 고칠 것은 이름과, 그것이 무엇인지 알 방법이다. 먼저 판정할 것: 사용자가 원하는 것이 (가)이름을 알아볼 수 있게 하는 것인가 (나)작업이 없을 때도 무언가 보이는 것인가 — 후자면 `FR-GIT-112`·`FR-FLW-12`(브랜치 chip 을 **일부러 없앤** 결정) 개정을 동반한다 |

**U-6 은 스펙 개정을 동반한다.** `GIT_HEAD_MOBILE_SRS` 가 정확히 그 반대를 요구한다 —
`FR-GHM-3` 이 "History 탭 최상단에 Changes 와 **같은 머리**를 싣는다", 검증 `V3` 가
"History 머리의 `.git-head-remote button` 이 여섯이다" 이다. 그것은 **두 뷰를 따로
보던 시절의 전제**이고, 지금 그 전제가 깨졌다는 것이 이 요구의 내용이다.

닿는 자리를 실측해 두었다.

```
스펙   GIT_HEAD_MOBILE_SRS  FR-GHM-3 · FR-GHM-6 · FR-GHM-7 · V2 · V3
코드   panel-changes.js:809 headHTML()      ← 갈래를 여기 하나에만 만든다
       history.js:113        그 머리를 싣는 자리
       remote.js             `.git-remote-btn` 을 찾아 동작을 붙인다 — 없을 때를 견뎌야 한다
e2e    git-head-mobile.spec.ts:108,185      History 의 버튼 여섯을 단정한다
       git-changes.spec.ts:51-55           Changes 쪽은 **그대로 여섯이어야 한다**
```

머리 전체를 빼는 것이 아니다 — `repo`·`branch`·배지·ahead/behind 는 남고
`.git-head-remote` 만 빠진다.

**U-9 도 스펙 개정을 동반한다.** `DIFF_HUNK_BAR_SRS` 가 정확히 지금 동작을 요구한다 —
`FR-DHB-11·13·14` 와 검증 `V-DHB-10`("툴바는 hunk 위에서만 뜨고, **마우스가 에디터를
떠나면 사라진다**")이다. hover 를 커서로 바꾸면 그 요구와 검증이 함께 바뀌고,
`V-DHB-2`("조각 위에 **마우스를 올려**")·`V-DHB-11`(blame·커밋 축에서 서지 않는다)도
문장을 고쳐야 한다. **코드만 바꾸지 마라.**

닿는 자리를 실측해 두었다.

```
스펙   DIFF_HUNK_BAR_SRS  FR-DHB-11·13·14 · V-DHB-2 · V-DHB-10
코드   panel-diff.js:442-443  onMouseMove·onMouseLeave 로 띄우고 지운다
       panel-diff.js:436      getPosition:()=>this._hunkBarPos||null
       panel-diff.js:501      position:{lineNumber:Math.max(1,hunk.newStart),column:1}
                              ← 위치가 **조각 첫 줄**에 고정이다. "이상한 위치" 의 근거
       panel-diff.js:566·598  _hunkBarCoords()
       panel-diff.js:468-469  툴바 자신의 mouseenter/mouseleave (사라짐 유예)
```

커서 기반으로 바꾸면 계기가 커서 이동이 되고, 사라지는 조건(지금은 `mouseleave`)을
**새로 정의해야 한다** — 커서는 에디터를 떠나지 않는다.

**사라지는 조건은 사용자가 정했다** (2026-09-10):

1. **커서가 diff 영역에 있지 않을 때** — `gitHunkAt(list, cursorLine)` 이 `null` 이면
   숨긴다. `_hunkBarMove` 가 이미 같은 판정을 하고 있으므로 **판정 함수는 그대로**
   쓰고 좌표의 출처만 마우스 → 커서로 바꾼다.
2. **해당 에디터에 포커스가 없을 때** — `onDidBlurEditorText` 가 계기다.

배선은 생각보다 가깝다.

| 지금 | 바꾼 뒤 |
|---|---|
| `ed.onMouseMove(ev=>this._hunkBarMove(ev))` | `ed.onDidChangeCursorPosition(...)` |
| `ed.onMouseLeave(()=>this._hunkBarLeave())` | `ed.onDidBlurEditorText(...)` |
| `ed.onDidChangeCursorSelection(()=>this._hunkBarPaint())` | **이미 있다** — 라벨 갱신용이며 위치 계산까지 넓히면 된다 |

**숨김은 이미 위치를 놓는 일이다** — `getPosition:()=>this._hunkBarPos||null` 이고
`null` 이면 Monaco 가 그리지 않는다. 위젯을 붙였다 뗐다 하지 않으므로(`FR-DHB-21`)
계기만 바꾸면 된다.

**위치도 같은 수정으로 풀린다.** `:501` 이 자리를 `hunk.newStart`(조각 첫 줄)로
잡는 것이 "이상한 위치" 의 정체다 — 조각이 길면 사용자가 보는 줄과 툴바가 멀어지고,
스크롤 밖으로 나가기도 한다. **커서 줄**에 두면 보고 있는 자리에 뜬다.

없어지는 것 둘도 함께 본다 — `_hunkBarT`(숨김 유예 타이머)와 툴바 DOM 의
`mouseenter`/`mouseleave`(`:468-469`)는 **hover 를 위해서만 있었다.** 커서 기반에서는
버튼으로 마우스를 옮기는 사이에 사라질 일이 없으므로 유예가 필요 없다.

`GIT_HUNK_BAR_HIDE_MS` 상수도 쓰이지 않게 된다.

### U-4·U-11·U-12·U-13 — 빈 여백의 뜻과 생성 직후 — **닫혔다** (§2.10)

아래는 착수 전 조사 기록이다. 실측은 전부 맞았고 `EXPLORER_ROOT_KEYS_SRS` §2 로
옮겼다. 결론은 §2.10 에 있다.

넷은 **한 흐름으로 본다.** U-4 가 "빈 여백을 클릭하면 루트가 선택된다" 이고,
U-12 가 그 자리에서 "더블클릭하면 루트에 파일을 만든다" 이며, U-13 이 "만들면
연다" 다. U-11 은 같은 착상을 탭 바에 적용한 것이다.

**빈 여백 = 루트 규약은 이미 있다.** 새로 만드는 것이 아니라 **넓히는** 것이다.

```
file-tree-xfer.js:299  _dropDirAt()
  "폴더 행이면 그 폴더, 파일·링크 행이면 그 부모, 헤더와 빈 여백이면 루트다 (FR-FTR-20)"
```

드롭은 이미 그렇게 판정한다. 클릭·더블클릭만 그 규약 밖에 있다 — U-4 가 결함으로
느껴지는 이유가 그것이다. **`_dropDirAt` 과 같은 판정을 쓰면 두 벌이 되지 않는다.**

배선도 이미 절반 있다.

| 요구 | 있는 것 | 더할 것 |
|---|---|---|
| U-12 | `file-tree.js:71` 이 **리스트 전체**에 `dblclick` 을 건다 — 여백 더블클릭도 `_onDbl`(`file-tree-paint.js:160`)에 **이미 온다** | 행이 없을 때의 갈래. `startCreate(isDir, at)` 는 `at` 인자를 이미 받는다 → `at=this.root` |
| U-13 | `doCreate`(`file-tree-edit.js:139`)가 `this._sel=path` 로 **선택까지** 한다 | 파일이면(`isDir` 아니면) 여는 호출 하나. 폴더는 열지 않는다 |
| U-11 | `renderer.js:914` 에 **탭 자신의** `dblclick`(이름 변경)이 있다 | `.pn-tabs`(`:995`) 여백의 갈래 → `addTabFocused()`(`app-layout.js:795`) |

**주의 둘.**

1. **U-11 은 기존 더블클릭과 충돌하지 않아야 한다.** `renderer.js:914`·`:922` 가
   탭과 라벨에 이미 `dblclick` 을 걸고 있으므로, 여백 갈래는 `e.target` 이 탭이
   **아닐 때만** 돈다. 탭에서 올라온 이벤트를 여백으로 읽으면 이름을 고치려다
   새 탭이 열린다.
2. **U-13 은 낙관적 갱신과 순서가 얽힌다.** `doCreate` 는 서버 응답 **전에** 먼저
   그리고(`_optimAdd`), 실패하면 되돌린다(`_restore`). **열기는 성공을 확인한
   뒤여야 한다** — 실패한 생성의 탭이 남으면 없는 파일을 연 탭이 된다.

### U-15 — 요구된 동작이 `UX-1` 이 고친 그 상태다 — **닫혔다** (§2.11)

아래는 착수 전 조사·결정 기록이다. 실측은 전부 맞았고 `POPUP_DEFAULT_ACTION_SRS`
§2 로 옮겼다. 결론은 §2.11 에 있다.

**요구**: 팝업의 기본 포커스를 목적에 맞는 버튼에 두고 `Enter` 로 실행. 예로 든 것이
**삭제**이며, "모든 팝업에 통일" 이다.

**충돌**: 이 저장소는 그 반대를 **요구사항으로 못박고 있고, 그것을 어긴 상태를 결함
으로 판정해 이번 마일스톤에서 고쳤다.**

| 근거 | 내용 |
|---|---|
| `FR-GIT-97` | 파괴적 동작의 기본 선택지는 항상 **안전한 쪽** (force 아님, 삭제 아님, **취소가 기본 포커스**) |
| `FR-GIT-176` | **`Enter` 는 실행이 아니다** |
| `FR-GIT-94` | 모바일에서는 **더 엄격히** — 터치 오조작 방지 |
| `FR-COS-6` | "다음은 **바뀌지 않는다**: 초기 포커스는 취소, `Enter` 는 실행이 아님" |
| `V38`·`TC-COS-7` | 그것을 검증하는 e2e |
| **`UX-1`** (§2.2) | **이번 마일스톤이 P1 으로 닫은 항목** — `_confirmClose` 를 `GitConfirm` 규약으로 수렴: 초기 포커스 취소 · `Enter`≠실행 |

`app-tool.js:366-370` 의 주석이 종전 상태를 그대로 적고 있다:

> 초기 포커스가 취소이고, `Enter` 는 실행이 아니며, 문구는 `textContent` 다.
> **종전에는 이 셋이 전부 반대였다** — 포커스가 실행 버튼에 갔고, `Enter` 가 실행이었다.
> 파괴적 확인창이 앱에 두 벌 있었고 그 둘의 `Enter` 규약이 달랐다.

`CONFIRM_ONE_STAGE_SRS` §의 판정도 같다 — 확인을 한 단계로 줄이면서도 안전을 지킨
근거가 "걸음 수가 아니라 **기본 선택지가 취소이고 `Enter` 가 실행이 아닌 것**" 이었다.

**그러므로 요구를 그대로 적용하면 `UX-1` 이 되돌아가고 e2e `V38`·`TC-COS-7` 이
깨진다.** 코드만 고칠 수 없다 — `GIT_SRS` `FR-GIT-94`·`97`·`176` 과
`CONFIRM_ONE_STAGE_SRS` `FR-COS-6` 을 함께 개정해야 한다.

#### 결정 — **원안대로 간다** (사용자, 2026-09-10)

절충안(비파괴적만 주 동작, 파괴적은 취소 유지)을 제시했고 **사용자가 기각했다.**
근거는 이것이다:

> **UX 는 사용자가 하고자 했던 걸 유지하는 방향이지, 안전한 방향이 아니다.**

즉 확인창의 기본 선택지는 "무엇이 덜 위험한가" 가 아니라 **"사용자가 방금 무엇을
하려고 이 창을 열었는가"** 로 정한다. 삭제를 누른 사람에게 기본값이 취소인 것은
그 사람이 하려던 일을 되묻는 것이고, 그 되물음의 비용을 매번 지불하게 한다.

**확정된 규칙**

| | |
|---|---|
| 기본 포커스 | **그 팝업이 열린 목적의 버튼** — 삭제 확인창이면 삭제 |
| `Enter` | **그 동작을 실행한다** |
| `Esc` | **동작하지 않고 창을 닫는다** — 탈출구가 이것이다 |
| 범위 | **모든 팝업에 통일** |

`Esc` 는 **이미 그렇게 동작한다** (`confirm.js:205-209` 가 `Enter`·`Escape` 를 함께
`_cancel()` 로 보낸다). 그러므로 실제로 바뀌는 것은 **`Enter` 하나**이고, `Esc` 는
그 자리에 그대로 남아 안전장치가 된다.

#### 함께 개정해야 하는 것 — 코드만 바꾸면 게이트가 되돌린다

이 변경은 **요구사항 개정을 동반한다.** 아래를 같은 변경에 포함하지 않으면 e2e 가
실패하고, 다음 사람이 "결함" 으로 읽어 되돌린다.

| 대상 | 지금 | 개정 후 |
|---|---|---|
| `GIT_SRS` `FR-GIT-97` | "파괴적 동작의 기본 선택지는 항상 안전한 쪽 (취소가 기본 포커스)" | 기본 포커스는 **그 창이 열린 목적의 동작**. 안전은 `Esc` 와 확인창의 존재 자체가 진다 |
| `GIT_SRS` `FR-GIT-176` | "`Enter` 는 실행이 아니다" | `Enter` 는 **기본 동작을 실행한다** |
| `GIT_SRS` `FR-GIT-94` | 모바일은 더 엄격 (기본 포커스 취소) | 모바일에서 무엇을 지킬지 **다시 정해야 한다** — 터치에는 `Esc` 가 없다 (아래) |
| `CONFIRM_ONE_STAGE_SRS` `FR-COS-6` | "바뀌지 않는다: 초기 포커스는 취소, `Enter` 는 실행이 아님" | 이 조항이 **철회된다.** §의 "걸음 수가 아니라 기본 선택지가 방어" 라는 논거도 함께 고쳐야 한다 |
| e2e `V38` | "기본 포커스가 취소. `Enter` 가 실행하지 않음" | 반대를 단정하도록 갱신 |
| e2e `TC-COS-7` | "초기 포커스는 취소, `Enter` 는 취소" | 같음 |
| `app-tool.js:366-370` 주석 | "종전에는 이 셋이 전부 반대였다" 를 결함으로 적고 있다 | 그 서술이 더는 맞지 않는다 — 사유를 새 결정으로 갱신 |

**`UX-1`(§2.2)의 판정도 바뀐다.** 그 항목은 "포커스가 실행 버튼에 갔고 `Enter` 가
실행이었다" 를 P1 결함으로 닫은 것인데, 그중 **`Enter`·포커스 부분은 되돌아간다.**
`UX-1` 이 함께 고친 나머지 둘(파괴적 확인창이 **두 벌**이던 것을 하나로 수렴 ·
문구를 `textContent` 로)은 **그대로 유지한다** — 그 둘은 이 결정과 무관하다.

#### 착수 전에 답할 것 둘

1. **모바일에 `Esc` 가 없다.** `FR-GIT-94` 가 "터치 오조작 방지" 로 모바일을 더
   엄격히 두는 근거가 그것이다. 데스크톱은 `Esc` 가 탈출구지만 터치에는 그 키가
   없고, 잘못 뜬 확인창에서 `Enter` 에 해당하는 것도 없다(탭해야 한다). **모바일은
   지금대로 둘지, 같은 규칙을 적용할지 정해야 한다.**
2. **팝업이 몇 종이고 어디에 있는가.** "모든 팝업에 통일" 이므로 전수를 먼저
   센다 — `GitConfirm`(`git/confirm.js`) · `GitDialog`(`git/dialog.js`) ·
   `_confirmClose`(`core/app-tool.js`) · `UIKit.modal`(`ui/ui-kit.js`) 넷이 뼈대이고,
   각각의 "목적 버튼" 이 무엇인지는 호출부가 안다. `GitDialog` 는 이미
   `_defBtn` 기제를 갖고 있어(`dialog.js:336`) 그 자리를 채우는 일이 된다.

### U-16 — 진입점 둘만 막으면 된다 — **닫혔다** (§2.10)

Notes 루트에서 폴더 생성을 막는다. 진입점은 **둘뿐**이고 둘 다 `startCreate(true, …)`
를 부른다.

```
file-tree.js:129        툴바의 새 폴더 버튼   → this.startCreate(true)
file-tree-xfer.js:186   메뉴 newDir          → this.startCreate(true, dir)
```

Notes 판정도 이미 있다 — `app-editor.js:50` 이 `root===this._edNotes()` 로 이름을
가른다. **새 판정을 만들지 말고 그것을 쓴다.**

두 자리에서 각자 막으면 한쪽만 고쳐지는 부류가 된다(이 저장소가 여러 번 겪은
형태다). **`startCreate` 안에서 한 번 막는 쪽**이 낫고, 그러면 앞으로 생길 세 번째
진입점도 자동으로 덮인다. 툴바 버튼은 그와 별개로 **감추거나 비활성**해야 한다 —
눌러도 아무 일이 없는 버튼은 고장으로 읽힌다.

서버도 함께 볼 것: 클라이언트만 막으면 API 직접 호출로는 만들어진다. Notes 루트에
폴더 생성을 막는 규칙이 서버에 필요한지 판정해야 한다 (`/api/fs/create` 의
`dir:true`).

### U-14 실측 — 조작은 다 있다. 없는 것은 포커스와 키 경로다 — **닫혔다** (§2.10)

**아래 "주의 셋" 의 첫 줄은 틀렸다.** `PANEL_SHORTCUTS_SRS` 는 `Background`·`Runs`
버튼의 단축키만 다루며 이 규약을 갖고 있지 않다. 실제 규약은 `EDITOR_GIT_UX_SRS`
`FR-EKB-1`·`4` 이고, 그 전역 `keydown` 과 겹치는 키가 **하나도 없어** 개정이
필요하지 않았다 (§2.10 · `EXPLORER_ROOT_KEYS_SRS` §2.5).

**그리고 실측이 놓친 것이 하나 있었다** — 없는 것은 "포커스와 키 경로 둘" 이
아니라 **포커스를 render 넘어 지키는 자리**까지 셋이었다. §2.10 의 마지막 절.

컨텍스트 메뉴(`file-tree-xfer.js:198-210`)가 이미 전부 갖고 있다.

| 조작 | 이미 있는 것 |
|---|---|
| 복사 | `app._edClipSet(this.root, p)` — 클립보드 상태는 `app-editor.js:850-851` |
| 붙여넣기 | `doPasteInto(dir)` — 빈 클립보드면 `EDITOR_PASTE_NONE` 로 막혀 있다 |
| 복제 | `doDuplicate(p)` |
| 삭제 | `doDelete(p)` — **확인창까지 자기가 든다**(재귀 여부·항목 수·dirty 탭을 밝혀야 해서 일반 확인으로는 `FR-EDT-83·84` 를 못 만족한다) |
| 이름 변경 | `startRename(p)` |

**그러므로 이 요구는 조작을 만드는 일이 아니라 그 조작에 키보드 길을 내는 일이다.**
붙여넣는 자리 규칙("폴더면 그 안, 아니면 그 형제")도 이미 정해져 있다 (`FR-WBR-70`).

없는 것은 둘이다.

1. **탐색기가 포커스를 받지 못한다.** 트리에 `tabindex` 가 없고, `file-tree.js:186`
   의 `el.focus()` 는 **인라인 편집 입력** 전용이다(`_focusInput`). 지금 탐색기의
   `keydown` 은 `file-tree-paint.js:628` 하나뿐이고 그것도 그 입력의 것이다.
   → 사용자가 말한 "editor 로부터 주도권을 뺏어온다" 가 이 부분이다.
2. **키 → 조작의 사상이 없다.** `Delete`·`Cmd/Ctrl+C`·`Cmd/Ctrl+V`·`F2` 등.

**주의 셋.**

- **전역 `keydown` 과 충돌한다.** `input-binding.js:115` 가 `window` 에 `keydown` 을
  건다. 탐색기가 포커스를 가진 동안 그 전역이 같은 키를 먹으면 두 동작이 함께
  돈다 — 어느 쪽이 이기는지를 정해야 하고, 그 규약은 `PANEL_SHORTCUTS_SRS` 가
  이미 다루는 영역이다. **새 규약을 만들기 전에 그 문서를 읽어라.**
- **터미널이 키를 삼키는 자리와 다르다.** 편집기·터미널은 자기 키 처리를 갖고
  있으므로, "주도권을 가져온다" 는 **포커스를 옮기는 일**이지 전역 핸들러를
  바꾸는 일이 아니다.
- **삭제는 확인을 건너뛰면 안 된다.** `Delete` 키가 `doDelete` 를 그대로 부르면
  확인창은 유지된다 — 그것이 `FR-EDT-83·84` 다. 키보드라는 이유로 확인을 빼는
  갈래를 만들지 마라. **U-10 이 정확히 그 부류의 결함이다.**

### U-10 — **닫혔다.** 원인은 두 요구사항의 모순이었다 (§2.9 참조)

아래는 조사 기록이다. 결론은 §2.9 에 있다.

#### U-10 실측 — 확인 로직은 있는데 그 앞의 게이트를 못 지난다

**데이터 손실이므로 이 목록에서 가장 급하다.** 저장 안 한 편집이 확인 없이 사라진다.

확인 로직 자체는 **두 자리에 있고 둘 다 살아 있다.**

```
app-layout.js:189   창 닫기 — if(this._edWinDirty&&this._edWinDirty(s))
                              → _confirmClose(CLOSE_DIRTY_MSG,{saveBtn:true})
app-layout.js:541   탭 닫기 — const isEditor = tab.type==='editor';
app-layout.js:546              if(editor && editor._dirty && !opts.force) → 같은 확인
```

**가장 유력한 원인은 `:541` 의 게이트다.** 확인은 `tab.type==='editor'` 안쪽에
있는데, git 의 diff 탭은 `TAB_TYPE_GIT`(`:538` 이 `tab.type===TAB_TYPE_GIT` 로
가른다)이다 — **그 탭은 dirty 확인 경로를 통째로 지나지 않는다.** 사용자가 "editor,
diff" 를 함께 말한 것과 맞는다.

확인할 갈래 넷 (재현 먼저, 순서대로):

| # | 가설 | 확인법 |
|---|---|---|
| 1 | diff 탭이 `isEditor` 가 아니라 확인을 건너뛴다 | git diff 탭에서 편집 → 탭 닫기 |
| 2 | `editor._dirty` 가 `false` 로 읽힌다 | `_doc` 이 끊기면 `set _dirty` 가 **죽은 필드**(`__dirty`)에 쓴다 — `file-editor.js:566-568` 이 그 함정을 이미 적고 있다 |
| 3 | `opts.force` 로 닫는 경로를 탄다 | `app-editor.js:956 _edCloseTabsUnder` 가 `{force:true}` 다. 이것은 **삭제 경로 전용**이며(`FR-EDT-91`) 다른 경로가 그것을 재사용하고 있으면 결함 |
| 4 | 떠남 확인 토글이 꺼져 있다 | `LEAVE_CONFIRM_TOGGLE_SRS` — 설정으로 끌 수 있다면 기본값·적용 범위를 본다 |

닿는 스펙: `EDITOR_TAB_SRS` `FR-EDT-91`·`FR-EDT-84` · `LEAVE_CONFIRM_TOGGLE_SRS` ·
`EDITOR_DIRTY_DIFF_SRS` · `WORKSPACE_SAVE_CONFLICT_SRS`.

**이것은 동작 변경이 아니라 결함이다** — 확인창은 이미 요구사항이고 코드도 있다.
스펙 개정 없이 고칠 수 있을 가능성이 높다. 다만 고친 뒤 **e2e 회귀를 남긴다** —
확인이 뜨지 않는 것을 아무 테스트도 잡지 못했다는 사실 자체가 결함의 일부다.

### U-18 — access 설정에 "이 컴퓨터의 별명" 목록을 더한다 (조사 완료 · 결정 확정)

**증상**: tailnet 의 다른 기기(`macmini`)에서 이 컴퓨터(`macmini-office`)의 dongminal
웹에 접속할 때 **IP 로는 되고 MagicDNS 이름으로는 안 된다.** 정적 자산은 뜨지만
`/ws`·`/api/*` 가 전부 421(Misdirected Request)로 끊긴다.

#### 원인 — 게이트 두 겹 중 **뒤쪽**이다

```
server.go:239   logging → accessGate(출발지 IP) → requestGate(Host·Origin·…) → authGate → recover → mux
```

`~/.dongminal/server.log` 의 거절 로그:

```
request denied why=host addr=100.117.248.111:60672 host="macmini-office:58146"
                origin="http://macmini-office:58146" GET /ws
```

`accessGate` 는 **통과했다** — `access.json` 의 `macmini` 항목이 제 일을 했다.
막은 것은 `requestGate` 의 Host 판정(`reqgate.go:181`)이다.

`hostAllow.ok()`(`reqgate.go:88`)의 허용 집합과 현재 값:

| 허용 항목 | 현재 값 | `macmini-office` 통과 |
|---|---|---|
| loopback/localhost 리터럴 | — | ✗ |
| `os.Hostname()` + `.local` | `DongyoonKimui-Macmini.local` | ✗ ← **근본 원인** |
| 숫자 IP 중 `accessStore.isSelf` | `100.89.214.106` 포함 | IP 접속만 ✓ |
| `--allowed-host` extra 패턴 | 빈 값 | ✗ |
| ACL 목록의 호스트명(`hasHostname`) | `macmini`·`phone`·`macbook` | ✗ |

**핵심**: macOS 컴퓨터 이름과 Tailscale 노드 이름이 다르다. 서버는 자신의 tailnet
별명을 자기 것으로 인식하지 못한다.

#### 축이 둘인데 UI 는 하나만 표현한다

| 축 | 무엇을 묻는가 | 담당 |
|---|---|---|
| ① | **누가** 들어오나 (출발지 IP) | access 칸. 정상 작동 |
| ② | **뭐라고 불리며** 들어오나 (Host 이름) | **입력할 자리가 아예 없다** |

`--allowed-host` 가 축②를 위한 설계였다(`REQUEST_GATE_SRS:159` ·
`13-tls-tailscale.md:357`)**만 CLI 배선이 없다** — `main.go:464` 가
`httpapi.Config{Port,DataDir,StaticFS}` 만 채우고 `AllowedHosts` 를 비워 둔다.
**지금 사용자가 축②를 채울 방법이 전무하다.**

#### 환경 사실 (조사로 확정)

```
os.Hostname()              DongyoonKimui-Macmini.local
scutil --get LocalHostName DongyoonKimui-Macmini
tailscale Self.DNSName     macmini-office.tail5da9ae.ts.net.
tailscale Self.HostName    DongyoonKim의 Mac mini
TailscaleIPs               100.89.214.106 · fd7a:115c:a1e0::7301:d6bb
접속 형태                  http://macmini-office:58146  → Host 값에 **점이 없다**
서버 실행                  dongminal start --foreground (플래그 없음)
tailscale 호출              코드에 없다 (reqgate.go:40 의 주석 한 줄이 전부)
access.json                enabled:true, entries = macmini·phone·macbook (전부 **타 기기**)
```

**짧은 이름으로 접속하므로 `*.ts.net` 접미사 패턴으로는 절대 걸리지 않는다** —
`matchHostPattern`(`reqgate.go:120`)이 `*.` 접미사에 점 하나를 강제한다.

#### 결정 사항 — **사용자가 확정했다. 재논의 불필요**

1. **access 설정을 두 목록으로 나눈다.** ① 허용할 기기(출발지 IP, 기존 `entries`
   그대로) · ② **이 컴퓨터의 별명**(Host 판정용, 신규).
2. **기존 편의 규칙 `hasHostname` 을 걷어낸다.** 지금은 ①에 적힌 이름을 Host 로도
   인정하는데(`reqgate.go:113` · `access.go` 의 `hasHostname`) 그것이 두 축을 섞는
   원인이다. **동작 변경이므로 "이전 동작 / 새 동작 / 이유" 를 기록한다.**
   근거: 현재 ① 항목은 전부 타 기기 이름이라 이 서버를 그 이름으로 부를 일이
   없다 → 실제로 끊길 접속이 없다.
3. **UI(access 탭)에서 관리하고 저장 즉시 반영한다.** 서버 재시작을 요구하지 않는다
   (현재 `setConfig` → `refresh` → broadcast 규약을 따른다).
4. `--allowed-host` CLI 배선은 **이번 범위 밖**이다. `Config.AllowedHosts` →
   `hostAllow.extra` 경로는 그대로 둔다.
5. tailscale 을 실행해 이름을 자동 유도하는 방식은 **채택하지 않았다** — 새 실행
   의존성을 만들지 않는다.

#### 절차 요구 (사용자 지정)

- **보안 경계를 넓히는 변경이다.** 축②는 DNS 리바인딩 방어의 화이트리스트이므로
  아무 도메인이나 통과시키는 값(`*` · 빈 패턴 · 과도한 와일드카드)을 막는 검증이
  스펙에 **반드시** 들어간다. 방어가 약해지는 설계는 채택하지 않는다.
- **스펙 먼저(IEEE 29148).** 기존 문서에 연결한다 — `ACCESS_ALLOWLIST_SRS`(FR-ACL-*) ·
  `REQUEST_GATE_SRS`(FR-RQG-*). 코드 주석이 FR 번호를 인용하는 관례를 따른다.
- **TDD** — unit / edge / failure case 전부.
- 심볼 탐색·수정은 LSP → Serena 우선.
- **스펙 초안으로 사용자 승인을 먼저 받는다. 구현은 승인 후.**

#### 스펙에서 답할 열린 질문

- ② 항목의 검증 규칙: 와일드카드(`*.ts.net`)를 허용하나, **정확 일치만** 받나?
- ② 항목도 ①처럼 `enabled` 토글·`label` 을 갖나? (스키마 일관성 vs 최소 구현)
- ② 가 비었을 때 동작은 **현재와 동일**해야 한다 (`os.Hostname` + self IP + loopback).
- loopback·self IP 무조건 통과(`FR-ACL-5`)와 `isSelf`(`FR-RQG-6`)는 **유지**한다.
- ②는 DNS 해석이 필요 없다(이름 문자열 비교) — `refresh` 의 `lookupHost` 대상에
  넣지 않는 것이 맞는지 확인.
- API 응답 모양 변경이 기존 클라이언트를 깨는지 (`accessView.You`/`Self` 소비처).

#### 건드릴 것으로 보이는 지점

```
internal/webserver/httpapi/access.go    accessConfig·accessView 스키마 · setConfig 검증 ·
                                        hasHostname 제거 · apiAccessGet·apiAccessPut
internal/webserver/httpapi/reqgate.go   hostAllow.ok() 가 새 목록을 읽도록 ·
                                        matchHostPattern 재사용 여부 판단
web/js/core/app-settings.js             access UI 에 ② 섹션 (_aclSave 가 검증 실패 본문을
                                        그대로 띄우는 규약 유지)
테스트                                  access_test.go · reqgate_test.go
하위 호환                               ~/.dongminal/access.json — 새 필드 없는 기존 파일 = ② 빈 목록
```

#### 작업 중의 임시 조치와 그 만료

지금 당장 접속이 필요하면 access 칸(①)에 `macmini-office` 를 임시로 추가하면
`hasHostname` 편의 규칙이 그것을 Host 로도 인정해 통한다. **그러나 그 규칙이 이
작업에서 제거되므로(결정 2) 완료 시점에 그 임시 항목은 무효가 된다** — 새 ② 칸으로
옮겨야 한다.

---

### U-7·U-8 실측 — 기본값이 실사용과 반대다 — **닫혔다** (§2.12)

아래는 착수 전 조사 기록이다. 실측은 거의 맞았고 `UI_LAYOUT_DEFAULTS_SRS` §2 로
옮겼다 — 다만 **"빠뜨린 뷰" 가 가능성이 아니라 실제였고**(둘), `overflow` 개수
148 은 **139** 로 정정됐다. 결론은 §2.12 에 있다.

`style-git.css:12` 가 모든 git 뷰의 기본을 정한다.

```css
.git-view{position:absolute;inset:0;display:none;overflow:auto;background:var(--bg)}
.git-view.vis{display:block}
```

그런데 **실제 뷰 여섯이 전부 그 둘을 뒤집는다** — 같은 두 줄이 여섯 벌이다.

```css
.git-view.git-diff{overflow:hidden}      .git-view.git-diff.vis{display:flex;flex-direction:column}
.git-view.git-history{overflow:hidden}   .git-view.git-history.vis{display:flex;flex-direction:column}
.git-view.git-console{overflow:hidden}   .git-view.git-console.vis{display:flex;flex-direction:column}
.git-view.git-branches{overflow:hidden}  .git-view.git-branches.vis{display:flex;flex-direction:column}
.git-view.git-stash{overflow:hidden}     .git-view.git-stash.vis{display:flex;flex-direction:column}
.git-view.git-changes{overflow:hidden}   .git-view.git-changes.vis{display:flex;flex-direction:column}
```

뷰 이름은 `panel-life.js:84` 에서 `'git-view git-'+view` 로 조립된다 — **재정의를
빠뜨린 뷰는 조용히 기본값(바깥 스크롤 + block)으로 떨어진다.** 그것이 U-8 이
말하는 "엇나감" 이고, 고칠 자리는 개별 뷰가 아니라 **기본값**이다.

바깥이 `overflow:auto` 인 채로 안쪽 목록도 `overflow-y:auto` 면 스크롤러가 둘이
되어 머리가 함께 밀린다 — `style-git-views.css:88` 의 주석이 그 사실을 이미 적고
있다("목록만 스크롤한다. 바·refs·푸터는 고정이다").

**U-8 은 git 에 국한되지 않는다.** 사용자가 범위를 확인했다 — *"git view 뿐만이
아닌 전체 ui 의 기본을 미리 설정해두고 가는 게 안전할 것 같다. 또 이렇게 맞지 않는
ui 가 나오면 안 되잖아."* 저장소 전체를 실측하면 같은 형태가 셋 있다.

| # | 형태 | 실측 | 어긋나는 방식 |
|---|---|---|---|
| C1 | **켜기/끄기 규약** | `display:none` **89** · `.vis` 재정의 **61** — 켤 때의 값이 `block` 26 · `flex` 23 · `inline-block` 4 · `inline` 3 **네 종** | `.vis` 를 붙여도 자리마다 다른 display 가 필요하다. 빠뜨리면 켜지지 않거나 레이아웃이 무너진다 |
| C2 | **스크롤 소유권** | `overflow` 선언 **148** — `overflow:hidden` 86 · `overflow-y:auto` 29 · `overflow:auto` 13 · `overflow-x:auto` 7 · 그 밖 4 | 바깥과 안쪽이 **둘 다** 스크롤러가 되면 머리가 함께 밀린다. 축(x/y/both)도 규약이 없다 — U-7 이 그 사례다 |
| C3 | **골격 배치** | `position:absolute;inset:0` **37** — 계열마다 되풀이 | 어떤 컨테이너가 "칸을 채우는 골격" 인지가 이름이 아니라 선언으로만 드러난다 |

계열별 규칙 수는 `.ed-` 68 · `.ui-` 64 · `.dr-` 48 · `.pn-` 27 · `.sbl-` 26 이며,
`.git-*` 만의 문제가 아니다.

**재발 방지가 요구의 절반이다.** 이 저장소는 규약을 게이트로 지키는 문화가 있고
(`check-seams.sh`·`check-timers.sh`·`check-gitwrite.sh`·`check-html.sh`·
`check-fetch.sh`), 그 파일들의 주석이 이유를 이미 적고 있다 — **"규약은 선언으로
지켜지지 않는다."** U-8 의 산출물은 루트 기본값과 **그것을 지키는 검사** 둘이다.

착수 시 유의: 이것은 **구조 변경**이라 화면 전체에 닿는다. 성공 판정은 리팩터와
같다 — **아무것도 달라지지 않는 것**. e2e 스냅샷·시각 회귀가 판정 수단이며,
`.git-view` 처럼 "기본값을 뒤집으면 여섯 재정의가 사라지는" 자리부터 손대면
diff 가 줄어드는 방향으로 간다.

---

U-1·U-3·U-7 은 **결함**이고 U-2·U-4·U-5·U-6·U-9 는 **동작 변경**, U-8 은 **구조
변경**이다. 동작 변경은 손대기 전에 현재 동작이 의도된 것인지(스펙·주석) 먼저
확인한다 — U-6·U-9 는 확인 결과 **의도된 것이었고 스펙 개정이 필요하다**.

**U-5 는 규모가 다르다.** 선택 모델을 바꾸면 그 선택을 읽는 모든 명령이 영향을
받으므로, 착수 전에 스펙이 필요한지부터 판정한다 (CLAUDE.md 작업 규모 게이트).

---

## 4. Monaco 벤더링 — 결정과 실측

**결정: 사전압축 벤더링** (사용자 결정, 2026-09-10). 스펙은
[`MONACO_VENDORING_SRS.md`](../MONACO_VENDORING_SRS.md).

### 4.1 1차 세션의 숫자가 틀렸다

이 문서의 종전 판은 "min/vs 약 5MB → 바이너리 약 21MB" 라고 적었다. **5.4MB 는 그것을
gzip 한 크기**이고 raw 는 23.3MB 다. `go:embed` 는 압축하지 않고 `release.yml` 은
tar/zip 없이 raw 바이너리를 그대로 올리므로, 그대로 담으면 사용자가 받는 파일이
16MB → 약 **39MB**, 5대상 합계 **+117MB** 였다.

| | 실측 |
|---|---|
| `min/vs` 파일 수 | 151 (`.js` 137 · `.d.ts` 13 · `.css` 1) |
| raw 합계 | 23.3 MB |
| 파일마다 gzip 한 합계 | 5.4 MB |

내역이 한쪽으로 쏠려 있다 — `assets/ts.worker` 6.7MB + `language/typescript` 6.4MB 로
**TypeScript 만 13.1MB(56%)** 다.

### 4.2 고른 길

**담긴 채로 내보낸다.** 자산을 `<이름>.gz` 로 담고 정적 핸들러가
`Content-Encoding: gzip` 으로 그대로 흘린다. `Accept-Encoding` 에 gzip 이 없으면
서버가 풀어서 준다 — 그 폴백이 없으면 브라우저 아닌 클라이언트가 깨진 바이트를
받고 그 사실을 모른다.

| | 값 |
|---|---|
| 바이너리 | 15.64 MB → **21.15 MB** (+5.51) |
| 기능 손실 | **없다.** `nls`·TypeScript 언어 서비스를 크기를 이유로 빼지 않았다 |
| 담긴 파일 | 139 (`.d.ts` 13 은 제외 — 런타임에 요청되지 않는다) |
| CSP | `script-src 'self'` · **외부 호스트 0** |
| 규칙의 범위 | monaco 전용이 아니다. `.gz` 가 있으면 어느 자산이든 같은 규칙을 지난다 |

### 4.3 이것으로 닫힌 DoD

- `web/vendor/monaco/` 존재 · `MONACO_CDN` 상수 소멸 · `jsdelivr` 저장소 0건.
- CSP `script-src` 에 외부 호스트 없음. `TestStatic_CSPExternalHostsAreKnown` 이
  "하나이고 그것을 안다" 에서 **"하나도 없다"** 로 바뀌었다.
- 네트워크를 끊은 상태에서 편집기·Diff 뷰가 뜨는 e2e — `e2e/monaco-offline.spec.ts`
  2건(TC-MVN-15·16). 밖으로 나간 요청이 하나도 없음을 함께 단정한다(TC-MVN-17).

### 4.4 함께 딸려 온 것 — CSP 해시

`script-src` 를 `'self'` 로 조이자 `index.html` 의 head 선주입 스크립트 둘이
막혔다. §2.5(2) 가 그 이야기이고, 결론은 **해시로 그 둘만 허용**한다는 것이다.
해시는 `cspFor()` 가 **서빙되는 바이트에서** 계산하므로 문서와 정책이 두 벌이 될
수 없다.

```
default-src 'self'; script-src 'self' 'sha256-Y0hr/…' 'sha256-cbCW…'; style-src …
```

`TestStatic_CSPHashesEveryInlineScript` 와 `TestStatic_CSPCoversRealIndex` 가
"인라인 스크립트 수 == 해시 수" 를 지킨다. 새 인라인 스크립트를 넣으면 그 검사가
먼저 실패하고, 속성이 붙은 인라인 스크립트는 해시 대상이 아니라 **막힌다** —
조용히 허용되는 것보다 낫다.

---

## 5. 다음 세션 착수 프롬프트

[`M2_NEXT_SESSION.md`](./M2_NEXT_SESSION.md) 에 같은 것이 있다 — 그쪽은 사본이고
**이 절이 원본**이다.

리팩터를 함께 하려는 세션은 [`M3_REFACTOR_NEXT_SESSION.md`](./M3_REFACTOR_NEXT_SESSION.md)
를 쓴다. 그쪽은 **이 저장소에서 리팩터가 어떻게 빗나가는지**를 먼저 적는다 —
이미 끝난 리팩터 트랙 아홉 단계, 중복처럼 보이지만 의도된 것 일곱, 그리고
"착수 근거는 취향이 아니라 실측" 이라는 규칙이다.

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵 M2 를 이어서 진행한다. **P0 5건·P1 11건이 전부 끝났고**, 4차
세션이 git 실행 층 통일(GO-39·FBE-08)과 U-10 을, 5차 세션이 **탐색기 묶음 여섯**
(U-4·U-11·U-12·U-13·U-14·U-16) · **U-15**(팝업의 기본 포커스) · **U-7·U-8**
(UI 레이아웃 기본값과 게이트 셋)을 닫았다.
남은 것은 **DoD 5항목 · P2 · 사용자 보고 8건**, 그리고 기존 흔들림이다.

**첫 일은 U-18 이다** — MagicDNS 이름으로 접속이 안 된다(421). 지금 사용자가 자기
서버에 이름으로 붙지 못하고, **조사·결정이 이미 확정돼 있다.**

먼저 이것부터 읽어라 — 이게 진실이고 나머지는 배경이다:

- docs/internal/production/M2_PROGRESS.md   ← 무엇이 끝났고 무엇이 남았는지
  · §2.8 git 실행 층 통일 · §2.9 U-10 · §2.10 탐색기 묶음 · §2.11 U-15 ·
    §2.12 U-7·U-8
  · §3.4 사용자 보고(근거·함정·충돌) — 닫힌 열은 ✅ 로 표시돼 있다.
    **U-18 상세를 그대로 딛는다 — 다시 조사하지 마라**
- docs/internal/production/M3_REFACTOR_NEXT_SESSION.md
  ← **리팩터를 하려면 반드시 먼저 읽어라.** 이 저장소에서 리팩터가 어떻게
    빗나가는지가 거기 있다. 지난 세션은 그 §0·§1 이 없었으면 **이미 기각된 안을
    다시 구현할 뻔했다.**

스펙은 전부 구현돼 있다. 그 범위 안이면 새로 쓰지 마라:
- docs/internal/REQUEST_GATE_SRS.md          게이트 계약  ← **U-18 이 여기 닿는다**
- docs/internal/ACCESS_ALLOWLIST_SRS.md      출발지 IP 허용목록  ← **U-18**
- docs/internal/FILE_API_BOUNDARY_SRS.md     파일 경계 계약
- docs/internal/MONACO_VENDORING_SRS.md      벤더링·사전압축·CSP
- docs/internal/CLIENT_API_SRS.md            브라우저 API 호출의 전송 한 겹
- docs/internal/EXPLORER_ROOT_KEYS_SRS.md    탐색기의 루트·생성·키보드 (5차)
- docs/internal/POPUP_DEFAULT_ACTION_SRS.md  팝업의 기본 포커스 (5차)
- docs/internal/UI_LAYOUT_DEFAULTS_SRS.md    UI 레이아웃 기본값·게이트 셋 (5차)

## 착수 순서 — 이대로 간다

**0) 닫힌 것 — 다시 열지 마라**

  · 탐색기 묶음 (U-4·U-11·U-12·U-13·U-14·U-16) — §2.10 `EXPLORER_ROOT_KEYS_SRS`.
    그 스펙 §7.1 이 이 저장소에서 포커스가 왜 안 남는지를 적고 있다 — 다음에
    포커스를 만지면 그것부터 읽어라
  · U-15 팝업의 기본 포커스 — §2.11 `POPUP_DEFAULT_ACTION_SRS`. **FR-GIT-97·176 ·
    FR-COS-6·7 이 개정됐다.** 그 조항들의 옛 문장("기본 포커스는 취소")을 근거로
    무언가를 되돌리려 하면 그것은 이미 뒤집힌 결정이다. `Enter` 를 가로채는
    자리를 **다시 만들지 마라** (그 안은 D-1 이 기각했다)
  · U-7·U-8 UI 레이아웃 기본값 — §2.12 `UI_LAYOUT_DEFAULTS_SRS`. **게이트 셋이
    섰다**(check-visibility·check-scroll·check-skeleton). CSS 를 만지면 그것들이
    먼저 말을 건다. 숨김의 어휘는 둘이다 — **있으면 보임 `.vis` · 있으면 숨김
    `[hidden]`**. 새 어휘를 만들지 마라

**1) U-18 — MagicDNS 이름으로 접속이 안 된다 ← 여기서 시작**

**지금 사용자를 막고 있다** — tailnet 의 다른 기기에서 IP 로는 되고
`macmini-office` 로는 `/ws`·`/api/*` 가 전부 421 이다.

**조사와 결정이 이미 확정돼 있다.** §3.4 의 U-18 상세를 그대로 딛는다 — 원인 표
(게이트 두 겹 중 **뒤쪽**인 `requestGate` 의 Host 판정), 환경 사실, 결정 5,
절차 요구, 열린 질문 6, 건드릴 지점, 임시 조치의 만료까지 적혀 있다.
**다시 조사하지 마라.**

요체: 축이 둘인데 UI 는 하나만 표현한다 — ①누가 들어오나(출발지 IP, access 칸이
담당·정상) · ②**뭐라고 불리며 들어오나**(Host, **입력할 자리가 없다**).
`--allowed-host` 가 축②의 설계였으나 CLI 배선이 없다(`main.go:464`).

**절차 요구 (사용자 지정)**
  · **보안 경계를 넓히는 변경이다.** 축②는 DNS 리바인딩 방어의 화이트리스트이므로
    아무 도메인이나 통과시키는 값(`*`·빈 패턴·과도한 와일드카드)을 막는 검증이
    스펙에 **반드시** 들어간다. 방어가 약해지는 설계는 채택하지 않는다
  · **스펙 먼저(IEEE 29148).** `ACCESS_ALLOWLIST_SRS`(FR-ACL-*) ·
    `REQUEST_GATE_SRS`(FR-RQG-*) 에 연결한다
  · **TDD** — unit / edge / failure case 전부
  · **스펙 초안으로 사용자 승인을 먼저 받는다. 구현은 승인 후**

**2) U-9 — hunk 툴바를 hover 에서 커서로 (스펙 개정 동반)**

사라지는 조건은 사용자가 정했다 — 커서가 hunk 밖 · 에디터에 포커스 없음.
배선은 절반 있다(onDidChangeCursorSelection 이 이미 구독돼 있고, 숨김이 곧 위치를
놓는 일이라 위젯 탈부착이 없다). 위치를 조각 첫 줄(panel-diff.js:501)에서 커서
줄로 옮기면 "이상한 위치" 도 같은 수정으로 풀린다.
DIFF_HUNK_BAR_SRS FR-DHB-11·13·14 와 V-DHB-10 을 함께 고친다.

**3) 남은 결함 U-1·U-3·U-17·U-19, 그리고 DoD 5항목·P2**

  U-1  LSP 로 파일이 연결되지 않는다 — 재현부터
  U-3  claude code·omp 에서 스크롤이 **최상단으로** 붙는다 — 재현 조건부터 다시
  U-17 가끔 스크롤이 안 된다. 새로고침하면 풀린다 — **U-8 의 정적 결함과 성질이
       다르다**(명시도 문제는 새로고침으로 안 풀린다). U-3 과 같은 뿌리일 수 있다
  U-19 상태바의 "Git 원격 작업 진행" 이 안 보이고 뭔지도 모르겠다 — 조사 완료.
       진행 중 작업이 있을 때만 뜨는 것이 FR-GIT-112 의 요구다. 고칠 것은 이름과
       알 방법이며, "없을 때도 보이게" 면 FR-GIT-112·FR-FLW-12 개정 동반
  U-5  탐색기 다중 선택 — 선택 모델을 바꾸는 일이라 규모가 다르다. 스펙 필요 여부 판정
  U-6  History 의 Fetch/Pull/Push 제거 — GIT_HEAD_MOBILE_SRS FR-GHM-3·V3 개정 동반
  U-2  미리보기 위치·대비

  DoD 5: wait 동시 수 상한 · diag 임계 경고 · 헤드리스 로그를 길이/해시로 ·
         편집기 probe.size 상한(FUI-06) · 샌드박스 cpu·memory·pids 상한 ·
         dongminal verify 게이트 항목
  P2:    SEC-10·12·13·15·16·18~20 · GO-38 · FE-15~17 · FUI-06

**GO-23(JSON 응답조립 중복)은 하지 마라** — 착수 근거가 없다고 판정했다
(M3_REFACTOR_NEXT_SESSION §2 의 (a)~(d) 어디에도 없고, 오류 본문 방언 4종은
공개 계약이라 통일이 금지돼 있다).

**SEC-14 는 조치 불요다** — 초크포인트를 지나지 않는 것이 FR-GIT-246·D-9 가
확정한 설계다. 감사가 그 결정을 모른 채 쓴 항목이다.

## 지난 세션이 배운 것 — 같은 실수를 반복하지 마라

**감사 항목(SEC-*·GO-*)이 결함이라고 단정하지 마라.** 그 문서들은 설계 결정을
모른 채 쓰였다. SEC-14 가 그랬고, 지난 세션은 그것을 근거로 **이미 두 번 기각된
화이트리스트 확장을 설계했다가** FR-GIT-246·D-9 를 발견해 되돌렸다.
착수 전에 그 자리의 SRS 를 먼저 찾아라.

**"층" 을 구분하라.** 기각된 것이 무엇인지 정확히 읽어라 — FR-GIT-246 이 기각한
것은 **인가 층의 확장**이었고 **실행 층의 공유**는 아니었다. 그 구분을 놓쳐서
막다른 길을 한 번 갔다.

**정적 검사는 위반이 없을 때도 통과한다.** "초록" 은 그 검사가 동작한다는 증거가
아니다 — 이 저장소의 기존 게이트는 git 실행 다섯 자리를 **하나도 보지 못하면서**
계속 초록이었다. 새 게이트를 세우면 **임시 탐침으로 실제 검출을 확인하고 지워라.**

**요구사항 둘이 모순일 수 있다.** U-10 이 그것이었다 — FR-RTU-33("잃는 편집이
없다")과 FR-RTU-53(dirty 를 탭에 ●)이 서로를 부정한 채 남아 있었고 그 사이를
아무 검증도 보지 않았다. 결함을 만나면 **코드보다 요구사항을 먼저 대조하라.**

**감사·조사 기록이 근거 문서를 잘못 가리킬 수 있다.** §3.4 는 U-14 의 전역 키
규약이 PANEL_SHORTCUTS_SRS 영역이라고 적었는데 **그 문서에는 그런 규약이 없다**
(Background·Runs 버튼의 단축키만 다룬다). 실제 근거는 EDITOR_GIT_UX_SRS
FR-EKB-1·4 였고, 확인해 보니 겹치는 키가 **하나도 없어** 개정이 필요 없었다.
  → **"그 문서가 규약을 갖고 있다" 를 받아들이기 전에 그 문서를 열어라.**
    §0-A 의 "기각된 것이 정확히 무엇인지 읽어라" 와 같은 부류다.

**흔들리는 것은 검증 수단이 아니다.** U-8 의 판정은 "아무것도 달라지지 않는 것"
이어서 계산값 스냅샷을 만들었는데, 첫 판이 4회 중 2회 흔들렸다 — 커밋 제목·카운트
배지·검색 입력의 폭이 내용과 폴링 시점에 매인다. 픽셀을 버리고 **잘림/스크롤
여부**(불리언)로 바꾸고 조건부 요소의 유무를 대조에서 뺀 뒤 4회 연속 결정론적이
됐다.
  → **기준선을 뜨기 전에 그것이 결정론적인지 확인하라.** 흔들리는 기준선은 회귀를
    잡는 데 쓰이지 않고 **가리는 데** 쓰인다. 그리고 **재기준화는 "달라진 것이
    없다" 의 증명이 아니다** — C1 에서 한 번 다시 떠야 했고, 그 사실과 대신
    무엇이 증명하는지를 SRS §5.1 에 적었다.

**게이트가 검출에 실패하는 것을 또 잡았다.** §0-B 의 교훈이 다시 나왔다 —
`check-skeleton.sh` 의 `awk` 판이 탐침을 **통과시켰다**(macOS awk 는
`split(s,a,"")` 로 문자 분할을 못 한다). perl 로 되돌렸다.
  → **새 게이트를 세우면 반드시 탐침으로 검출을 확인하고 지워라.** 이번에는 일곱
    형태를 하나씩 넣어 봤고 그중 하나가 그렇게 걸렸다.

**요구를 그대로 구현하는 것이 가장 곧은 길이 아닐 수 있다.** U-15 는 "Enter 로
바로 실행" 이었고 가장 직접적인 구현은 Enter 를 가로채 목적 동작을 부르는 것이다.
**그러면 포커스가 취소에 있어도 실행된다** — 요구가 고치려는 문제(하려던 일과
일어나는 일의 불일치)를 다른 자리에 새로 만든다. 브라우저 기본 동작에 맡기니
규약이 "기본 포커스를 어디에 두는가" 한 줄로 줄었고 구현도 작아졌다.
  → **구현안을 고를 때 "이 안이 요구의 취지를 다른 자리에서 어기지 않는가" 를
    물어라.** 그리고 그 물음을 검증으로 남겨라 — V-PDA-3·13·32 가 그것이며,
    없으면 가로채기 구현도 초록으로 통과한다.

**같은 함정의 선례를 먼저 찾아라.** U-14 의 본체는 키 사상이 아니라 포커스였다 —
render 가 `.ed-win` 을 떼면 포커스는 빼앗기는 것이 아니라 **잃는다**. 처음에는
"빼앗는 자리" 를 고쳤고 그것으로는 실패했다. **이 함정은 이미 기록돼 있었다**
(FR-EDT-66 · `_restoreEditFocus` · `_restoreScrollOf` 셋이 같은 일을 한다).
  → 새 결함을 만나면 **이 저장소가 같은 함정을 이미 어디서 겪었는지** 찾아라.
    U-10 은 요구사항에서, 이것은 구현에서 같은 교훈을 냈다.

## e2e 를 돌리는 시점 (사용자 지시 — 2026-09-10 개정)

**전체 e2e 는 남은 구현이 전부 끝난 뒤 한 번이다.** 그때까지는 돌리지 않는다.
15분이 걸리고, 구현이 남은 동안 반복하면 그 시간이 작업 시간을 먹는다.

그 전까지는 **자체 테스트**만 한다 — 작업마다 아래를 지난다.

    make gates
    go test ./...                       (Go 를 만졌으면 -race -shuffle=on 까지)
    npm run typecheck · lint · unit
    npx playwright test <닿는 스펙들>    ← 그 변경이 닿는 스펙만, 단독으로

마지막 줄이 요점이다. **전량이 아니라 닿는 스펙만** 고른다. U-10 이 그 예다 —
repo-diff-edit · repo-tab · editor-ops · ux-batch8 · git-diff 다섯을 골라 79건을
1분 안에 돌렸고, 그중 repo-tab 의 X1~X4 가 "기존 규약이 깨지지 않았다" 를 답했다.

**닿는 스펙을 고르는 법**: 고친 파일의 요구사항 번호(FR-*)로 e2e/*.ts 를 grep
한다. 그 번호를 단정하는 스펙이 곧 그 변경의 회귀 넷이다.

**RED 를 먼저 본다.** 새 검증은 구현 전에 실패해야 한다. 이미 구현했다면
git stash 로 코드만 되돌려 확인한다 — U-10 이 그렇게 했고, 그 과정에서 "확인창을
붙이기만 하면 취소해도 편집이 돌아오지 않는다" 는 두 번째 층이 드러났다.

## 규약

- **e2e 는 단독으로 돌려라.** 같은 기계의 다른 세션이 테스트를 돌리면 PTY 가
  소진되고(kern.tty.ptmx_max 기본 511) 실패 목록이 오염된다. 지난 두 세션이
  그것 때문에 두 번 무너졌다.
- **이 저장소의 바이너리에 start/stop 을 부르지 마라.** 도구 셸의 환경에
  DONGMINAL_PORT 가 있어 사용자의 실제 인스턴스를 가리킨다(실제로 한 번 내렸다).
- 게이트를 느슨하게 만들어 통과시키지 마라. 415·403 이 보이면 스펙으로 먼저
  판정하고, 게이트가 옳으면 호출부를 고친다.
- 중·대 규모는 스펙 → 테스트(RED) → 구현(GREEN).
- **동작을 바꾸면 그 근거 문서를 같은 변경에서 고쳐라.** 코드만 바꾸면 게이트가
  되돌린다.
- 커밋 메시지에 AI 서명 금지. 커밋은 사용자 확인 후에만.
```

---

## 6. e2e — 검증 현황

### 6.1 1차 세션의 실패 목록은 **폐기했다**

종전 §6.2 에 20건이 적혀 있었고 "자원 경합" 으로 추정했다. 실제 원인은 §2.5 의 넷이며
그중 셋은 코드 결함이었다. **추정이 틀렸으므로 그 목록을 근거로 쓰지 않는다.**

이번 세션도 중간에 두 번 오염됐다 — 같은 기계의 다른 세션이 playwright 를 돌려
PTY 가 266개까지 올라갔고 실행이 죽었다(exit 144). **e2e 는 단독으로 돌려야 한다.**

### 6.2 분류 결과

| 실패 | 판정 | 조치 |
|---|---|---|
| 전량 (픽스처 단계) | **코드 아님 — 하네스** | `hermeticEnv()` (§2.5-1) |
| `boot-screen` V-1·V-3 | **코드 — M2 회귀** | CSP 해시 (§2.5-2) |
| `reconnect-storm` 4건 | **코드 — M2 회귀** | 오버레이 DOM 조립 (§2.5-3) |
| `focus-invariant` L4 · `git-window` E2 · `bg-kill` TC-BGK-7 | **게이트가 옳다 — 호출부** | 본문 없는 상태 변경에 JSON 헤더 (§2.5-4) |
| `editor-ops` W1 · `git-tag` · `git-repo-missing` · `git-ui-revision` · `history-branch-button` · `git-submodules` · `layout` · `settings` · `sidebar-collapse` | **오염** | 단독 실행에서 전부 통과 |
| `git-diff` D7 | **벤더링이 전제를 지웠다** | 그 검사는 `cdn.jsdelivr.net` 을 끊어 편집기 로드 실패를 만들었는데, 이제 그 요청이 없다. **자기 자산 경로**(`/vendor/monaco/**`)를 끊도록 옮겼다 — 요구(`FR-GIT-55`)는 그대로다. 실패 문구도 고쳤다: 네트워크가 끼어들 자리가 없어졌으므로 "네트워크를 확인하세요" 가 사용자를 없는 원인으로 보낸다 |

### 6.3 남은 흔들림 — **기존 것이며 이 세션과 무관하다**

전체를 **세 번** 돌렸다.

| 회차 | 결과 | 실패 |
|---|---|---|
| 1 | `1444 passed · 3 flaky · 1 failed` (15.5분) | `git-diff` D7 — 고쳤다 |
| 2 | `1443 passed · 4 flaky · 1 failed` (14.6분) | `editor-dirty-diff` V-EDD-6 |
| 3 | `1443 passed · 5 flaky · **0 failed**` (15.0분) | — |

**흔들리는 자리가 회차마다 전부 다르다.** 1회차는 `git-history`·`slot-view-state`,
3회차는 `branch-menu-unify`·`git-branches`·`git-repo-missing` 이다. 겹치는 것이
없다는 것이 "특정 변경의 회귀" 가 아니라는 근거다.

2회차의 `editor-dirty-diff` V-EDD-6 은 Monaco 가 30초 안에 뜨지 않은 것이라 벤더링과
닿을 수 있어 따로 봤다 — **단독 3회(54건) 전부 통과**했고 3회차 전체 실행에서도
통과했다. 부하에서만 나오는 대기 시간 문제다.

앞서 `git-console` K2 · `git-commit-actions` D1 · `git-history` H7 로는 **HEAD 와
직접 견줬다** — 워킹트리 3회 중 1회, HEAD 4회 중 1회로 같은 비율이다. 셋 다 **배경
폴링이 사용자의 명령보다 먼저 기록되는** 경합이며(K2 의 실패 문구에 맨 위가
`git stash list` 로 찍힌다), 고치려면 스펙의 "맨 위" 단정을 바꾸거나 폴링을 멎게
해야 한다 — **별도 작업이고 이 마일스톤의 범위가 아니다.**


### 6.4 이번 세션에 통과한 게이트

`make gates`(이음매·타이머·git쓰기·크로스 5대상·vendor·html) ·
`go test -race -shuffle=on ./...` 전량 · `npm run typecheck` · `npm run lint` ·
`npm run unit` 46건.

**전체 e2e**: 단독 실행 3회. 마지막 회차가 `1443 passed · 5 flaky · **0 failed** ·
3 skipped` (15.0분)이다. 회차별 표와 흔들림 판정은 §6.3.

---

### 6.5 `FE-8` 은 **전량 확인이 남아 있다**

이것이 다음 세션의 첫 일이다 (§5).

`FE-8` 을 끝내고 전체 e2e 를 돌리다 **711/1451 에서 중단**했다. 그때까지 실패
2건이 나왔고 **둘 다 원인을 찾아 고쳤다.**

| 실패 | 원인 | 조치 |
|---|---|---|
| `event-timer-hub-contract` T-7 | `apiGet is not defined` — 합성 페이지 스펙이 `core/api.js` 를 안 실었다 | 스펙 셋에 `API_JS` 를 앞에 싣는다. `CLIENT_API_SRS` FR-CAPI-12a 가 그 규약을 적는다 |
| `event-timer-hub-contract` T-7b | 검사 스텁의 `fetch` 가 **응답 없이 resolve** 한다. 종전 호출부의 `if(r)` 이 그 경우를 다루고 있었다 | 겹이 그것도 전송 실패로 읽는다 (FR-CAPI-8). 단위 검사 TC-CAPI-18 |

고친 뒤 닿는 스펙 셋(`event-timer-hub-contract`·`sse-resilience`·`reconnect-storm`)을
단독으로 돌려 **23건 전부 통과**했다. 그 밖의 검사는 전부 초록이다 —
`make gates`(12항목) · `typecheck` · `lint` · `unit` **64건**.

**남은 것은 전량 한 번이다.** 그 확인 전에는 `NFR-CAPI-3`("아무것도 달라지지
않는다")이 충족됐다고 말할 수 없다.

---

## 7. 변경 기록

| 날짜 | 내용 |
|---|---|
| 2026-09-10 (1차) | 초안. P0 5건·P1 8건 완료 시점에서 세션 중단. e2e 미검증. |
| 2026-09-10 (2차) | e2e 를 끝까지 봤다. **M2 자신이 만든 회귀 셋과 하네스 결함 하나**를 찾아 닫았다(§2.5). `FE-6`+`B7`(Monaco 벤더링 — 사전압축)·`GO-11`+`SEC-17`(오류 분류) 완료. 사용자 보고 5건 접수(§3.4). §4 의 크기 추정이 틀렸던 것을 실측으로 바로잡았다. |
| 2026-09-10 (3차) | `FE-8` 완료 — 손수 `fetch` 81곳/28파일이 `core/api.js` 를 지난다. **P1 이 전부 닫혔다.** 게이트 `check-fetch.sh` 신설. 사용자 보고 U-6 접수. **`FE-8` 의 전량 e2e 는 남았다**(§6.5). |
| 2026-09-10 (4차) | **`FE-8` 전량 e2e 확인** — 1445 passed / 3 flaky / **0 failed**, 기준선보다 낫다(§2.8). **git 실행 층 통일**(`GO-39`·`FBE-08`·DoD 4번, §2.8) — git 을 띄우는 자리가 `domain/git` 밖에서 3→0, 화이트리스트는 15/22 불변. 게이트 5종 신설(탐침으로 실제 검출 확인). **`U-10` 닫힘**(§2.9) — 두 요구사항의 모순이었고 `FR-RTU-103` 을 신설해 정정. 사용자 보고 **U-7~U-16 접수**(§3.4), U-15 는 방향 확정. `SEC-14` 조치 불요·`GO-23` 착수 근거 없음 **판정**. **e2e 규약 개정** — 전량은 구현 완료 후 한 번, 그전엔 닿는 스펙만(§5). |
