# M2 진행 상황 — 브라우저 매개 공격 봉합 + 서버 하드닝

- 문서 상태: **진행 중** (2026-09-10, 3차 세션 종료 시점).
- 상위 문서: [`MILESTONE_KICKOFF.md`](./MILESTONE_KICKOFF.md) §M2
- 스펙: [`REQUEST_GATE_SRS.md`](../REQUEST_GATE_SRS.md) ·
  [`FILE_API_BOUNDARY_SRS.md`](../FILE_API_BOUNDARY_SRS.md) ·
  [`MONACO_VENDORING_SRS.md`](../MONACO_VENDORING_SRS.md) ·
  [`CLIENT_API_SRS.md`](../CLIENT_API_SRS.md)
- 다음 세션 착수 프롬프트: §5

---

## 1. 한 줄 요약

**P0 5건과 P1 11건을 닫았다 — P1 이 전부 끝났다.** 남은 것은 P2 18건과 DoD 6항목,
그리고 **사용자가 직접 보고한 6건**이다(§3.4).

`SEC-3`(무인증 LAN 노출)은 M4 까지 열려 있다 — 이 마일스톤의 노출 게이트가 그
절반을 강제한다.

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
| `UX-1` | `_confirmClose` 를 `GitConfirm` 규약으로 수렴 — 초기 포커스 취소 · `Enter`≠실행 · `textContent`. DOM 조립으로 재작성 |
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

---

## 3. 남은 것

### 3.1 P1 — **전부 닫혔다**

이월 하나만 남는다.

| 발견 | 내용 |
|---|---|
| `SEC-7` 잔여 | `/api/upload`·`/api/download` 의 경계 — `FILE_API_BOUNDARY_SRS` §5 비목표 2 가 **M8 로 넘겼다**. 그때까지 게이트가 호출을 덮는다 |

### 3.2 P2·기능축 (미착수)

`SEC-10`·`SEC-12`~`SEC-16`·`SEC-18`~`SEC-20` · `GO-23`·`GO-38`·`GO-39`(B5) ·
`FE-15`~`FE-17` · `FBE-08`(submodule `core.Env()`+`ctx`) · `FUI-06`(편집기 크기 상한) ·
`09` 비목표 3(샌드박스 cpu·memory·pids 상한).

### 3.3 DoD 중 아직 못 채운 항목

- `wait` 동시 수 상한 · diag 스냅샷의 임계 경고.
- 헤드리스 명령 로그를 전문 대신 길이·해시로.
- `worktree.execGit`·`submodule` 실행기의 `core.Env()` 공유 (B5).
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
| U-3 | **`claude code`·`omp` 에서 스크롤이 위로 붙는 문제가 아직 남아 있다** | 종전 조치가 있었으나 미해결 — 재현 조건부터 다시 잡는다 |
| U-4 | **탐색기의 빈 공간을 클릭하면 커서가 root 로 간다** | 최상위에 파일·폴더를 만들 수 있어야 한다 — 현재는 그 자리가 없다 |
| U-5 | **탐색기에 다중 선택을 더한다** (`Cmd`+클릭 · `Shift`+클릭) | 선택 모델이 단일이라면 그것을 집합으로 넓히는 일이고, 삭제·이동·복사 등 **선택을 소비하는 자리 전부**가 함께 바뀐다 |
| U-6 | **History 머리의 Fetch·Pull·Push 버튼을 뺀다** — Changes 와 History 를 이제 함께 보므로 같은 버튼이 두 벌이다 | `panel-changes.js:809 headHTML()` 가 두 뷰의 머리를 **한 자리에서** 만든다(FR-GHM-4). History 만 `.git-head-remote` 를 빼는 갈래가 필요하다 |

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

U-1·U-3 은 **결함**이고 U-2·U-4·U-5·U-6 은 **동작 변경**이다. 뒤의 넷은 손대기 전에
현재 동작이 의도된 것인지(스펙·주석) 먼저 확인한다.

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

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵 M2 를 이어서 진행한다. **P0 5건과 P1 11건이 전부 끝났다.**
남은 것은 DoD 6항목·P2 18건·사용자 보고 6건, 그리고 기존 흔들림이다.

먼저 이것부터 읽어라 — 이게 진실이고 나머지는 배경이다:
- docs/internal/production/M2_PROGRESS.md   ← 무엇이 끝났고 무엇이 남았는지
스펙 넷은 전부 구현돼 있다. 그 범위 안이면 새로 쓰지 마라:
- docs/internal/REQUEST_GATE_SRS.md          게이트 계약
- docs/internal/FILE_API_BOUNDARY_SRS.md     파일 경계 계약
- docs/internal/MONACO_VENDORING_SRS.md      벤더링·사전압축·CSP
- docs/internal/CLIENT_API_SRS.md            브라우저 API 호출의 전송 한 겹

## 첫 번째 일 — FE-8 의 전체 e2e

**지난 세션이 FE-8(fetch 81곳을 core/api.js 로 통합)을 끝냈지만 전체 e2e 를
끝까지 보지 못했다.** 중단 시점이 711/1451 이고 그때까지 실패 2건이 나왔는데,
둘 다 원인을 찾아 고쳤다(합성 페이지 스펙이 core/api.js 를 안 실었다 ·
주입 fetch 가 응답 없이 resolve 하는 경우). 고친 뒤 닿는 스펙 셋을 단독으로
돌려 23건 통과를 확인했다.

**남은 것은 전량 확인 하나다.** 아래 순서의 맨 앞에서 한 번 돌려라.

    npx playwright test --reporter=line

이 작업의 성공 판정은 **아무것도 달라지지 않는 것**이다 (CLIENT_API_SRS
NFR-CAPI-3). 실패가 나오면 대개 "그 자리가 봉투의 어느 칸을 읽어야 하는가" 다 —
`ok` 는 HTTP 성공만 보고, 본문은 `data`(JSON) 와 `text`(원문) 둘로 온다.

## 그다음 — 순서는 이것이다

1) **DoD 6항목** (§3.3)
   · wait 동시 수 상한 · diag 스냅샷 임계 경고
   · 헤드리스 명령 로그를 전문 대신 길이·해시로
     (handlers_runs_headless.go:90 이 cmd=%q 로 전문을 남긴다)
   · worktree.execGit·submodule 실행기의 core.Env() 공유 (B5 · FBE-08)
   · 편집기 probe.size 상한 (FUI-06) — 서버 SEC-19 상한과 같은 값
   · 샌드박스 컨테이너 cpu·memory·pids 상한
   · dongminal verify 에 게이트 항목 추가

2) **P2 18건** (§3.2). 착수 전에 킥오프 M2 의 "건드리지 말 것" 을 다시 읽어라 —
   git 실행 초크포인트·/api/fs/* 가드·업로드 상한·ACL 설계·파괴적 확인창
   설계는 전부 양호 판정이며 보존 대상이다.

3) **사용자 보고 6건** (§3.4). U-1~U-6.
   U-1(LSP 파일 연결)·U-3(스크롤 위로 붙음)은 결함이라 재현부터.
   U-2·U-4·U-5·U-6 은 동작 변경이라 현재 동작이 의도된 것인지 먼저 확인한다.
   · U-5(탐색기 다중 선택)는 선택 모델을 바꾸는 일이라 규모가 다르다 —
     착수 전에 스펙 필요 여부를 판정하라.
   · U-6(History 의 Fetch/Pull/Push 제거)은 **스펙 개정을 동반한다** —
     GIT_HEAD_MOBILE_SRS FR-GHM-3 과 V3 이 정확히 그 반대를 요구하고 있고,
     그것은 두 뷰를 따로 보던 시절의 전제다. 코드만 지우지 마라.

4) **기존 흔들림** (§6.3). 배경 폴링이 사용자의 명령보다 먼저 기록되는 경합이다.
   HEAD 에서도 같은 비율로 흔들리는 것을 확인해 두었다.

## e2e 를 돌리는 시점 (사용자 지시)

- FE-8 확인으로 **처음에 한 번**
- **P2 를 끝낸 뒤 한 번**
- **사용자 보고를 처리한 뒤 한 번**
- 흔들림을 다루는 동안은 **여러 번**

그 사이에는 make gates · npm run typecheck · npm run lint · npm run unit ·
go test -race -shuffle=on ./... 로 간다.

## 규약

- **e2e 는 단독으로 돌려라.** 같은 기계의 다른 세션이 테스트를 돌리면 PTY 가
  소진되고(kern.tty.ptmx_max 기본 511) 실패 목록이 오염된다. 지난 두 세션이
  그것 때문에 두 번 무너졌다.
- **이 저장소의 바이너리에 start/stop 을 부르지 마라.** 도구 셸의 환경에
  DONGMINAL_PORT 가 있어 사용자의 실제 인스턴스를 가리킨다(실제로 한 번 내렸다).
- 게이트를 느슨하게 만들어 통과시키지 마라. 415·403 이 보이면 스펙으로 먼저
  판정하고, 게이트가 옳으면 호출부를 고친다.
- 중·대 규모는 스펙 → 테스트(RED) → 구현(GREEN).
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
