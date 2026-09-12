# 07 — 프로덕션 성숙도 갭 분석

- 대상: `/Users/dykim/personal/dongminal` (HEAD `5f57cc7`)
- 성격: read-only. **"버그가 있다"가 아니라 "프로덕션 제품이라면 있어야 하는데 존재 자체가 없는 역량"** 을 식별한다.
- 전제(사용자 결정): 원격 노출(`--expose` / `DONGMINAL_HOST`)을 **유지**하고, 노출 시 **인증을 필수**로 만든다. 따라서 "로컬 전용이니 괜찮다" 논리는 어디에도 쓰지 않았다.
- 참조 규약: 이미 6축 리포트에 있는 결함은 다시 적지 않고 다음 표기로만 가리킨다 — `GO-P0/P1/P2`(01), `FE-P0-1/P0-2/P1`(02), `UX-P1/P2`(03), `SEC-P0-1/P0-2/P1-n/P2-§4.x`(04), `TEST-P0/P1/P2-§3.x`(05), `DOC-P1/P2`(06).
- 등급: **[필수]** = 이것 없이 프로덕션 배포가 무책임함 · **[권장]** = 초기 운영 중 곧 필요해짐 · **[선택]** = 성숙도 향상. 규모 S/M/L/XL.
- 6축 리포트가 "미확인"으로 남긴 것 중 이번에 코드로 확정한 것 셋: `daemon.log` 무상한(§2), 데몬↔서버 판 불일치 미감지(§3), `workspace.SchemaVersion > 2` 동작(§3·§4 — `<` 만 본다, 상위 판은 조용히 읽는다).

---

## 0. 요약

| 영역 | 필수 | 권장 | 선택 | 한 줄 판정 |
|---|---|---|---|---|
| 1 인증·인가 | 5 | 2 | 1 | 인증(누구인가)도 인가(무엇을 할 수 있는가)도 **없다.** ACL 은 "어느 기기" 만 판정한다 |
| 2 관측성 | 3 | 3 | 1 | 로그 상한이 세 파일 중 하나에만 있고, 헬스는 liveness 문자열 하나, 진단 번들이 없다 |
| 3 릴리스·업그레이드 | 2 | 4 | 2 | 배포 채널·게이트는 갖춰졌으나 **업그레이드 절차 자체가 정의돼 있지 않다** (데몬 판 불일치 미감지) |
| 4 데이터 안전·복구 | 2 | 4 | 0 | 원자 쓰기는 양호. 백업 세대·손상 격리·복구 경로가 없다 |
| 5 설정 관리 | 0 | 3 | 1 | 스키마·검증·문서가 표면마다 다르고 서버 설정 파일이 없다 |
| 6 에러 규약 | 0 | 3 | 1 | `apierr` 는 잘 설계됐으나 `http.Error` 63곳이 그 밖에 있고 사용자용 카탈로그가 없다 |
| 7 접근성·i18n | 0 | 2 | 2 | 목표 기준도 언어 정책도 선언된 적이 없다 |
| 8 개발자 경험 | 0 | 3 | 2 | SRS 113개는 ADR 이 아니다 — 결정은 있으나 색인이 없다 |
| 9 성능·용량 | 0 | 2 | 1 | 코드에 상한 상수 40여 개가 있지만 어느 문서도 그것을 말하지 않는다 |
| 10 제품 경계 | 1 | 4 | 1 | 플랫폼은 문서화됐으나 보안 경계·브라우저·데이터 위치·지원 정책이 없다 |
| **합계** | **13** | **30** | **12** | |

---

## 1. 인증·인가 체계

### 현재 상태 (코드 근거)

**접근 통제는 출발지 IP 허용 목록(ACL) 하나다.**
- 판정 전부: `internal/webserver/httpapi/access.go:262-310` `allowed()`. loopback·자기 인터페이스 주소는 목록·토글과 무관하게 통과(`:269-278`), 토글이 꺼져 있으면 전부 통과(`:280-282`), 켜져 있으면 IP/CIDR/정방향 해석된 호스트명 대조.
- 게이트 위치: `server.go:216` `loggingMiddlewareFor(s, accessGate(s.Access, recoverMiddleware(mux)))` — mux 바깥 한 겹. 여기가 **인증 게이트를 얹을 자리**이기도 하다.
- 저장: `$DONGMINAL_HOME/access.json` `{enabled, entries[{id,value,label,enabled}]}` (`access.go:33-45`), 스키마 버전 없음, 0644.
- 설계 문서가 스스로 선언한 비목표: `docs/internal/ACCESS_ALLOWLIST_SRS.md:235-246` §5 — **①인증(토큰·비밀번호·사용자 개념) ②TLS ③Host 헤더 검증 ④PTR ⑤속도 제한·차단 이력·잠금 ⑥`--expose` 기본 동작 변경**. 여섯 모두 "하지 않는다".

**인증(누구인가): 없음.**
- 저장소 전체에서 `crypto/tls`·`Authorization`·`Set-Cookie`·`bearer`·`session`·`password`·`credential` 어느 것도 서버 코드에 없다(grep 0건, git 자격증명 마스킹 제외). 서버가 읽는 요청 헤더는 `If-Match` 하나(SEC-P0-2 실측과 일치).
- 클라이언트 쪽에도 자격증명을 실을 자리가 없다: `internal/helper/runtimebin/http.go:40-70` `httpPostJSON`/`httpGet` 은 `Content-Type` 만 붙인다. 브라우저 `fetch` 80곳/29파일·`gitFetch/gitPost` 25곳·`new WebSocket` 2곳(`web/js/ui/term-pane.js:504,587`, URL 조립 `:463`)·`new EventSource` 2곳(`web/js/core/event-bus.js:171,273`) 전부 무헤더.
- 데몬 IPC(`paned.sock`)도 인증이 없다 — `internal/daemon/ipc/paned.go:170-181` `hello` 는 프로토콜 판 `1` 과 도구 id 목록을 그냥 돌려준다.

**인가(무엇을 할 수 있는가): 없음.**
- 들어온 클라이언트는 전부 동등하다. 특권 작업의 구분이 없다 — `PUT /api/access`(ACL 자체를 바꾸는 종단, `access.go:412-445`)·`PUT /api/settings`·`PUT /api/sandbox/config`·`POST /api/file/write`(임의 절대경로) 가 터미널 입력과 같은 등급이다. 즉 **ACL 이 허용한 기기 하나가 ACL 을 꺼서 나머지 전부에게 문을 열 수 있다.**

**노출 경로:** `internal/ctl/cli/start.go:36-42` — `DONGMINAL_HOST` 가 있으면 그대로, `--expose` 면 `0.0.0.0`. 인증 유무를 묻는 게이트가 없다(SEC-P1-1 이 "ACL 꺼짐이면 거부" 를 제안 — 본 리포트는 그 위에 "인증 미설정이면 거부" 를 얹는다).

**README 의 약속:** `README.md:77-79` "인증이 없으므로 신뢰하는 망에서만" — 제품 방향이 바뀌면 이 문장이 거짓이 되므로 함께 갱신 대상이다(§10).

### 프로덕션 기준선 (노출 유지 + 인증 필수)

1. **자격증명 발급·저장·회전** — 첫 기동 또는 `dongminal auth init` 이 비밀을 만들어 `$DONGMINAL_HOME/auth.json`(0600) 에 저장, 한 번만 화면에 출력(또는 QR). `dongminal auth rotate` 로 회전 → 모든 세션 무효. `dongminal auth show`(loopback 전용).
2. **브라우저 세션** — 로그인 페이지(정적 자산은 인증 없이, `/api/*`·`/ws` 는 인증 뒤) → `HttpOnly; SameSite=Strict`(노출+TLS 면 `Secure`) 쿠키. WebSocket·EventSource 는 쿠키를 자동으로 싣으므로 URL 토큰이 필요 없다. 세션 수명(절대·유휴), 로그아웃, 활성 세션 목록·개별 폐기(다중 클라이언트는 이미 상태 없이 지원되므로 세션 목록만 더하면 된다).
3. **비브라우저 클라이언트** — `dmctl`·`edit`·`detach`·`open-url` 은 서버가 도구 셸 환경에 심는 `DONGMINAL_TOKEN`(또는 토큰 파일 경로)을 `Authorization: Bearer` 로 보낸다. 제어 CLI(`health`·`migrate`·`window`·`start` 의 `waitReady`·`verify`)는 홈의 토큰 파일을 읽는다. 사용자 오케스트레이션 스크립트도 같은 규약.
4. **무차별 대입 방어** — 로그인 종단에 출발지별 지수 백오프·잠금, 상수 시간 비교, 실패 로그(FR-ACL-13 형식 재사용).
5. **노출 모드의 전송 보호** — `--tls`(자체 서명 + 지문 출력) 와 `--tls-cert/--tls-key`, 또는 "Tailscale·리버스 프록시 뒤에서만 노출" 을 **강제**(평문 `0.0.0.0` 은 `--insecure-plaintext` 명시 없이는 거부). 쿠키는 평문 LAN 에서 도청되므로 인증과 TLS 는 한 묶음이다.
6. **인가 최소선** — 단일 소유자 제품이므로 역할 체계는 필요 없다. 다만 **특권 작업**(ACL 편집·토큰 회전·설정 전체 교체·샌드박스 마운트 정의)은 loopback 세션 또는 재인증을 요구한다.
7. **노출 게이트** — `--expose`/`DONGMINAL_HOST` 이면서 인증이 설정되지 않았으면 기동 거부.

### 갭

| ID | 등급 | 갭 | 규모 |
|---|---|---|---|
| G1-1 | **필수** | 인증 자체가 없다 — "누구" 를 판정하는 코드가 0줄이다 | L |
| G1-2 | **필수** | 자격증명 발급·저장·회전 CLI(`auth init/rotate/show`)와 그 저장 파일 규약(0600, 스키마) | M |
| G1-3 | **필수** | 세션 수명·로그아웃·활성 세션 목록/폐기 | M |
| G1-4 | **필수** | 무차별 대입 방어(백오프·잠금·상수 시간 비교) — ACL SRS §5-5 가 명시적 비목표로 둔 것 | S |
| G1-5 | **필수** | 노출 모드 TLS(`--tls`) 또는 안전 전송 강제 + `Secure` 쿠키 — 저장소에 TLS 코드 0줄 | M |
| G1-6 | 권장 | 특권 작업(ACL·토큰·설정 교체·샌드박스 마운트) 분리 — 현재 모든 클라이언트가 동등 | M |
| G1-7 | 권장 | 데몬 IPC 인증(멀티유저 호스트) — SEC-P1-6 의 소켓 권한 조치와 연계, 권한만으로 부족하면 hello 에 비밀 요구 | S |
| G1-8 | 선택 | 다중 사용자·역할 — 단일 소유자 제품에는 불필요, 팀 배포로 갈 때만 | XL |

연계만: ACL fail-open 을 노출 시 fail-closed 로(SEC-P2 §4.1), Origin/CSRF/Host 게이트(SEC-P0-1·P0-2·P1-7) — 인증 게이트와 **같은 미들웨어 자리**에 서므로 한 작업으로 묶는 것이 맞다.

### 도입 시 영향 범위 (수정 대상 계층 — "인증 체계 도입" 상세)

기존 ACL 과의 관계: **ACL 은 "어느 기기" 를, 인증은 "누구" 를 판정한다. 둘은 대체가 아니라 직렬이다.** `accessGate` 가 이미 mux 바깥 한 겹으로 서 있으므로(`server.go:216`), 인증 게이트는 그 **안쪽·recover 바깥쪽**에 한 겹 더 선다: `logging → accessGate(기기) → authGate(세션/토큰) → recover → mux`. ACL 이 켜져 있으면 그대로 1차 필터로 살아 있고, 로그인 종단·정적 자산·`/api/ping` 만 authGate 의 예외 목록에 둔다. loopback 무조건 통과(FR-ACL-5)는 **인증에는 적용하지 않는다** — SEC-P0 의 브라우저 매개 공격이 정확히 loopback 출발지이기 때문이다. 단, "서버가 도는 기기의 CLI(`health`·`migrate`)" 는 토큰 파일을 읽으면 되므로 예외가 필요 없다.

| 계층 | 파일 | 무엇을 고치나 |
|---|---|---|
| 게이트 | `httpapi/server.go:196-216` `Handler()` | `authGate` 한 겹 추가, 예외 경로 목록(`/`, 정적, `/login`, `/api/ping`) |
| 저장소 | 신규 `httpapi/auth.go` (+ `auth_test.go`) | `access.go` 의 `accessStore` 와 같은 모양: 파일 로드·원자 저장·검증·`view()`. 세션 표(메모리, 옵션 영속), 잠금 카운터 |
| 종단 | `httpapi/handlers_api.go:69-201` 라우팅 표 | `POST /api/auth/login`·`/logout`, `GET/DELETE /api/auth/sessions`, `POST /api/auth/rotate`(특권) |
| CLI | `ctl/cli/actions.go` 표, 신규 `auth.go`, `options.go` | `auth init/rotate/show`, `start --tls*`, 노출 게이트(`start.go:36-42`) |
| TLS | `httpapi/server.go:219-241` `Run` | `ListenAndServeTLS` 분기, 자체 서명 생성기(신규 `platform` 또는 `httpapi/tls.go`), 지문 출력 |
| 환경 계약 | `shared/dmenv/dmenv.go` | `EnvToken = "DONGMINAL_TOKEN"` (심는 쪽 toolhub·읽는 쪽 runtimebin 이 여기서 만난다 — 이 패키지의 존재 이유 그대로) |
| 도구 셸 환경 | `shared/toolhub/tool.go` `StartTool`(환경 조립 자리) | `DONGMINAL_TOKEN` 주입. **주의**: 도구 셸에 토큰을 심으면 그 셸의 자식(에이전트)도 토큰을 가진다 — 이것은 의도된 설계(dmctl 이 에이전트의 접합면)이지만, 토큰 범위를 "도구 API 만" 으로 좁힌 **2등급 토큰**을 둘지 결정해야 한다(G1-6 과 연동) |
| 헬퍼 클라이언트 | `helper/runtimebin/http.go:40-70` + `dmctl_status.go:298` | 두 클라이언트에 `Authorization` 헤더. 호출부 17곳/9파일은 헬퍼를 지나므로 **자동** |
| 제어 CLI 클라이언트 | `ctl/cli/proc.go:139` `ping`, `start.go:236` `waitReady`, `health.go:32`, `migrate.go:41`, `window.go:33`, `verify.go:254,264,283,323` | 토큰 파일 읽기 헬퍼 하나 + 헤더. `/api/ping` 을 예외로 두면 `ping`·`waitReady`·`health`·`migrate`·`window` 는 그대로, `verify` 4곳만 헤더 |
| 데몬 | `daemon/boot/boot.go`, `daemon/ipc/paned.go:170` | (G1-7 시) hello 에 비밀 검증. 데몬은 서버 환경을 물려받으므로 토큰 전달 경로는 이미 있다 |
| 프론트 부팅 | `web/index.html`, `web/js/core/main.js:4-33`, `BootScreen` | 401 → 로그인 화면 분기. 정적 HTML 은 인증 없이 나가되 `/api/settings`·`/api/state` 401 을 부팅 화면이 받아야 한다(현재 `main.js:14-21` 은 설정 실패를 `catch{}` 로 삼킨다 — FE-P1 과 같은 자리) |
| 프론트 요청 | `web/js/git/api.js`(25곳 흡수) + `fetch` 80곳/29파일 + `term-pane.js:463` + `event-bus.js:171,273` | **쿠키 방식이면 코드 수정 0** (브라우저가 자동으로 싣는다). 401 공통 처리(재로그인 유도)만 필요 — FE-P1 의 `core/api.js` 통합이 선행되면 한 자리, 아니면 29파일. **이것이 쿠키를 권장하는 실질 근거다** |
| e2e | `e2e/fixtures.ts`, 직접 HTTP 303곳/63파일, `playwright.config.ts` | 테스트 서버를 "인증 끔" 으로 띄우거나(`--auth=off` 를 `--isolated` 에서만 허용), fixture 가 로그인 쿠키를 `storageState` 로 주입. 후자면 303곳은 `page.request` 가 쿠키를 공유하므로 대부분 그대로 |
| verify 항목 | `ctl/cli/verify.go` 22항목 | "무인증 요청이 401" 항목 추가 |
| 문서 | `README.md:77-79`, `docs/external/getting-started.md` §노출, `api.md`(인증 절 신설), `ACCESS_ALLOWLIST_SRS §5` | "인증이 없으므로" 문장 제거, 발급·회전 절차, 위협 모델(§10 G10-1) |
| 릴리스 노트·마이그레이션 | `CHANGELOG.md`, `ctl/migrate` | 기존 `--expose` 사용자는 다음 기동이 거부된다 — **파괴적 변경**이므로 major 또는 명시적 이행 안내 |

규모 합: L (게이트·저장소·세션·CLI·TLS·문서·e2e 조정). SEC-P0/P1-7 게이트를 같은 PR 에서 처리하면 미들웨어 자리를 두 번 열지 않는다.

---

## 2. 관측성

### 현재 상태

- **로그**: stdlib `log`, `main.go:403` `SetFlags(Ldate|Ltime|Lmicroseconds)`. 레벨·구조화·요청 ID 없음(GO-P2·SEC-P2 §4.5 가 이미 지적 — 반복하지 않는다). 접근 로그는 `server.go:283-326` 미들웨어, `/api/ping`·`/api/stats` 는 핫패스 필터로 제외(`:319`). 진단 스냅샷 60초 1줄(`diag_snapshot.go`) — 좋은 설계이며 유지.
- **로그 파일 셋, 상한은 하나**:
  - 서버 로그 `$DONGMINAL_LOG`(기본 `/tmp/dongminal.log`, `options.go:29,52`) — `cli.WatchLogSize`(`logcap.go:82-96`) 가 64MB→8MB `.1` 로 자른다. 호출부는 `main.go:553` 하나.
  - `daemon.log` — `main.go:131-132` `O_APPEND` 로 열고 **상한 없음** (`capLog` 호출부 grep: `WatchLogSize` 안 한 곳뿐 → SEC-P2 §4.5 셋째 항목 "미확인" 을 **확정**). 실제 홈에서 684KB 관측.
  - `restart.log` — `ctl/cli/handoff.go:15,39` `O_APPEND`, 상한 없음. 실제 홈 18KB.
- **헬스**: `GET /api/ping` → 본문 `"ok"` 2줄(`handlers_api.go:354-356`). 데몬 연결 여부·워크스페이스 로드 여부·영속 실패·버전 어느 것도 싣지 않는다. `start` 의 `waitReady`(`start.go:236-244`)·`window`·`migrate` 가 이것을 준비 판정으로 쓴다 → **데몬에 못 붙은 서버도 "준비됨"** 이다. `dongminal health`(`health.go:19-75`) 는 HTTP ping + 데몬 pid/소켓 + 헬퍼 실행 가능 여부 — CLI 에서만, 버전 없음.
- **메트릭**: `/api/stats` 는 상태바용 CPU/메모리(`sysstat`)이지 서버 메트릭이 아니다. 요청 수·지연·오류율·영속 실패 카운터 없음(SEC-P2 §4.5 연계).
- **크래시**: HTTP 패닉은 `recoverMiddleware`(`server.go:262-280`) 가 로그+500, PTY 리더는 `recover` 로 로그만(GO-P1). 크래시 마커 파일·"마지막 비정상 종료" 표시·옵트인 리포트 없음. 프론트: `window.onerror`/`unhandledrejection` 훅 0건(grep — `ws.onerror` 류뿐), `console.error` 만. `?diag=1` 오버레이(`web/js/ui/diag.js`) 는 모바일 실기기 진단용 수동 도구로 `/api/upload` 에 로그 파일을 올린다.
- **진단 번들**: `dongminal doctor`(`ctl/cli/doctor.go`) 는 **자가 진단(self-test)** 이다 — 환경·헬퍼·셸·PTY 왕복·도구 계층·콘솔 없는 프로세스·IPC·프로세스 제어를 실제로 돌려 보고 통과/실패를 찍는다. 로그·설정·버전·워크스페이스 통계·진단 스냅샷을 **수집해 첨부하는 기능은 아니다.** `checkReport`(`report.go`) 는 출력 형식일 뿐. 버전조차 doctor 헤더에 없다(`doctor.go:71` `platform=` 만).
- **상관관계 ID**: 없음. WS·SSE·HTTP·데몬 RPC 를 잇는 식별자가 없어 "이 요청이 데몬의 어느 RPC 였는가" 를 로그로 추적할 수 없다.

### 프로덕션 기준선

레벨 있는 구조화 로그(`log/slog`, `DONGMINAL_LOG_LEVEL`, JSON 옵션) · 요청 ID 미들웨어 + 로그 필드 전파 · 로그 파일 전부에 로테이션 · `/api/health` JSON(`{version, uptime, daemon:{connected,pid}, workspace:{rev, lastPersistErr}, tools, ws}`) 과 readiness 의미론(`start` 는 데몬 연결까지 기다린다) · `/api/diag` 카운터(로컬·인증 뒤) · 크래시 마커 · 프론트 전역 오류 훅 → 서버 로그 또는 diag 오버레이 · `dongminal doctor --bundle <zip>`(버전·OS·홈 파일 목록·로그 tail 3종·설정/ACL 마스킹본·진단 스냅샷·헬퍼 상태).

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G2-1 | **필수** | `daemon.log`·`restart.log` 무상한 — 데몬은 서버보다 오래 살고 재기동 없이 수개월 도는 프로세스라 가장 먼저 찬다 | `main.go:131`(capLog 를 데몬 로그에도), `boot.go`, `handoff.go:39` | S |
| G2-2 | **필수** | 헬스 의미론 부재 — liveness 문자열 하나. 데몬 미연결·영속 실패·판 불일치를 알릴 자리가 없다 (GO-P1 "영속 실패가 성공으로 보인다" 의 노출 지점이기도 하다) | `handlers_api.go:354`, `start.go:236` `waitReady`, `health.go`, `verify.go` | S |
| G2-3 | **필수** | 진단 번들 명령 없음 — 사용자가 문제를 신고할 때 붙일 것이 "로그 경로를 찾아서 직접" 뿐. README `알려진 문제` 가 "다음 발생 때 진단 줄이 가른다" 고 하면서 그 줄을 모으는 도구가 없다 | 신규 `ctl/cli/bundle.go`, `doctor.go` 옵션, 마스킹 규칙(`core/remote.go` 자격증명 마스킹 재사용) | M |
| G2-4 | 권장 | 상관관계 ID(요청→로그→데몬 RPC) | `server.go` 미들웨어, `toolclient/client.go` `call`, `paned.go` | S |
| G2-5 | 권장 | 메트릭 종단(`/api/diag` JSON 또는 Prometheus 텍스트) — SEC-P2 §4.5 연계, 추가로 영속 실패·401/403 수·재연결 수 | `diag_snapshot.go` 값을 구조체로 | S |
| G2-6 | 권장 | 크래시 마커 + 프론트 전역 오류 훅 | `main.go` 기동 시 `.lastexit`, `web/js/core/main.js` | S |
| G2-7 | 선택 | 옵트인 원격 텔레메트리/오류 리포트 | 정책 결정이 먼저 | M |

연계만: slog 전환(GO-P2 로깅·SEC-P2 §4.5), 서버 프로세스 감독(launchd/systemd, SEC-P2 §4.5 첫째).

---

## 3. 릴리스·배포·업그레이드

### 현재 상태

**있는 것 (정확히 적는다):**
- 버전: `-ldflags -X …cli.Version`(`scripts/build.sh:14-16`), 기본 `dev`(`version.go:20`), `dongminal version` 이 판·대상·go 런타임 출력. CHANGELOG 는 Keep a Changelog + SemVer 선언(`CHANGELOG.md:1-4`), 13개 태그와 날짜까지 일치(DOC 확인).
- 배포 채널: GitHub Releases 단일. 5 대상 바이너리 + `SHA256SUMS`(`release.yml:149`). 게이트: 3 OS 에서 build·vet·`test -race`·doctor·verify(`release.yml:34-57`). 릴리스 노트는 CHANGELOG 절을 자동 추출(`release.yml:158-170`).
- 프론트 자산 판: 내용 해시 → `index.html` 치환 + SSE `server_hello`(`commands.go:257-263`) → `version-watch.js` 가 판이 다르면 즉시 새로고침. **같은 배포 안에서 옛 JS 가 남는 문제**의 해법이지 릴리스 업데이트 알림이 아니다.
- 마이그레이션: `internal/ctl/migrate` 는 **v1→v2 1회성 변환기**다 — `workspace.json` 스키마 2, `panes.json→tools.json`, 단축키 id 개명(`settings.go:13-18`), 구 식별자→uuid(`identity.go`). 백업 `.v1.bak`·`.preuuid.bak`(`apply.go:25-29`), `--dry-run`, 서버 실행 중 거부(`cli/migrate.go:41`). 서버는 `schemaVersion < 2` 를 3단계 안내와 함께 거부(`main.go:496-503`).
- 헬퍼 `bin/` 은 매 기동 재설치(`main.go:457`, `boot.go:56`) — 바이너리 교체 후 심볼릭 링크가 새 판을 가리키므로 헬퍼 판 문제는 없다.

**없는 것:**
- **업그레이드 절차** — README·getting-started 어디에도 "새 판으로 올리는 법" 절이 없다. 실제 절차는 "바이너리 덮어쓰기 → `dongminal start`" 인데, `start` 는 데몬이 살아 있으면 그대로 두고(`start.go:66-70` "dongminald 실행 중 (세션 보존)"), 서버만 새 판으로 뜬다. **데몬↔서버 판 대조가 없다**: `paned.go:179` hello 의 `"version": 1` 은 프로토콜 상수이고 `cli.Version` 이 아니다; `toolclient/client.go:137` 은 그 값을 검사하지 않는다; `boot.Run(home, cli.Version)` 의 판은 샌드박스 헬퍼용(`boot.go:47-50`)이다. → SEC 미확인 #4 **확정: 감지 없음.** 결과: 새 서버 + 옛 데몬(옛 `toolhub`·옛 IPC 핸들러)이 조용히 공존한다. 사용자는 `--restart-daemon`(세션 손실) 을 언제 써야 하는지 알 길이 없다.
- **롤백** — 다운그레이드 시 상위 스키마 파일을 조용히 읽는다(`workspace/manager.go:541` `<` 만 검사 — SEC 미확인 #6 확정). `.bak` 은 v1→v2 때만 남는다. "이전 판으로 돌아가려면" 문서 없음.
- **업데이트 알림·확인** — `update`·`self-update`·`latest release` grep 0건. 사용자는 GitHub 를 직접 봐야 한다.
- **설치 제거** — `uninstall` 액션 없음, 문서 없음. 지워야 할 것: 바이너리, `~/.dongminal`(실측 15항목 — §4 표), `/tmp/dongminal.log`(+`.1`), 샌드박스 컨테이너(`docker`), `ext/` 의 언어 서버 런타임, `git-worktrees/`. `RemoveAll(home)` 은 `verify_run.go:151` 격리 홈에서만.
- **패키지 매니저** — `RELEASE_SRS §5-3` 이 "별도 트랙" 으로 명시 연기. Homebrew/winget/apt 없음.
- **릴리스 게이트와 e2e** — `release.yml` 의 `publish` 는 `build-*` 만 기다린다(`:118`). `e2e.yml` 은 태그에서도 돌지만(`e2e.yml:20`) 발행이 그 결과를 기다리지 않는다 → **e2e 가 빨간 채로 릴리스가 나갈 수 있다.**
- **사전 릴리스 채널** — 없음(태그 `v*` 전부 정식).
- **마이그레이션 프레임워크** — 스키마 2→3 이 필요해지면 `migrate` 패키지의 v1→v2 하드코딩 위에 새로 짜야 한다. 다른 파일들(`settings.json`·`access.json`·`sandbox.json`)은 버전 필드 자체가 없다(SEC-P2 §4.6 연계).

### 프로덕션 기준선

문서화된 업그레이드 절차(바이너리 교체 → `start` 가 판 불일치를 감지해 "데몬 재시작 필요(세션 손실)" 를 알리거나, 데몬을 무중단 교체하는 설계) · 롤백 절차(하위 판이 상위 스키마를 만나면 거부 + 자동 백업에서 복원 안내) · 업데이트 확인(`dongminal update --check`, 옵트인) · `dongminal uninstall --dry-run` · 릴리스 발행이 e2e 를 기다림 · 최소 Homebrew tap · 스키마 사다리(N→N+1 함수 목록 + 파일별 버전 필드).

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G3-1 | **필수** | 업그레이드 절차 미정의 + 데몬↔서버 판 불일치 미감지 | `paned.go:170` hello 에 `cli.Version` 실기(데몬은 `boot.Run` 인자로 이미 받는다), `toolclient/client.go:137` 대조, `start.go:66-70` 안내 분기, `health.go`·G2-2 헬스에 노출, getting-started 에 "업그레이드" 절 | M |
| G3-2 | **필수** | 롤백 경로 없음 — 상위 스키마 조용히 읽음, 백업 없음 | `workspace/manager.go:541` `>` 거부 + 안내, G4-1 백업 세대와 연동, 문서 | M |
| G3-3 | 권장 | 업데이트 확인·알림(옵트인, GitHub Releases API, 상태바 배지 또는 `start` 출력 한 줄) | 신규 `ctl/cli/update.go`, `handlers_api.go` `/api/version`, 프론트 상태바 | M |
| G3-4 | 권장 | 설치 제거 명령·문서(무엇이 어디에 남는지 목록 포함) | 신규 `ctl/cli/uninstall.go`, `docs/external/getting-started.md` | S |
| G3-5 | 권장 | 릴리스 발행이 e2e 게이트를 기다리지 않음 | `release.yml` `publish.needs` 에 e2e 워크플로 결과(`workflow_run` 또는 잡 통합) | S |
| G3-6 | 권장 | 패키지 매니저 채널(최소 Homebrew tap; Windows `winget`) — `xattr` 안내가 필요한 현재 설치 경험의 근본 해법 | 신규 tap 저장소, `release.yml` formula 갱신 스텝 | M |
| G3-7 | 선택 | 마이그레이션 프레임워크 일반화(파일별 버전 필드 + 사다리) | `ctl/migrate` 구조 변경, `settings/access/sandbox` 에 `schemaVersion` | M |
| G3-8 | 선택 | 사전 릴리스 채널(`v*-rc*` → prerelease 플래그) | `release.yml` | S |

연계만: 서명·공증·provenance·`-trimpath`·액션 SHA 고정(SEC-P2 §4.7), LICENSE(DOC-P1), `web/vendor` 버전 기록(SEC-P2 §4.7).

---

## 4. 데이터 안전·복구

### 현재 상태

**저장 위치·형식 (코드 + 실제 홈 `~/.dongminal` 실측 15항목):**

| 파일/디렉터리 | 형식·스키마 | 쓰기 방식 | 문서화(`features.md` 파일 영속성 표) |
|---|---|---|---|
| `workspace.json` | JSON, `schemaVersion: 2` | 원자(`workspace/fs.go:22`), 비동기 latest-wins(`manager.go:131-172`) | ○ |
| `tools.json` | JSON, 버전 없음 | 원자(`toolhub/persist.go:87`) | ○ |
| `settings.json` | 서버가 해석하지 않는 blob, 버전 없음 | 원자(`handlers_settings.go:57`), **내용 미검증** | ○ |
| `access.json` | JSON, 버전 없음 | 원자(`access.go:135`) | × |
| `runs.json` | JSON, `schemaVersion: 1` | 원자(`run/store.go:149`) | × |
| `sandbox.json` | JSON, 버전 없음 | 원자(`sandboxplace/place.go:89`) | × |
| `notes/` | 사용자 파일 | 원자(`handlers_files.go:383`) | README 만 |
| `tool-history/` | 셸 히스토리, 0700(`toolhub/history.go:50`) | 셸이 씀 | × |
| `ext/` | 플러그인 매니페스트·런타임 | `os.WriteFile`(`ext/builtin.go:95,135`) — 매 기동 재생성 | × |
| `worktrees/`·`git-worktrees/` | git worktree | git | × |
| `bin/` | 심볼릭 링크·훅·`hooks.json`·`claude.json` | `os.WriteFile`(`runtime/install.go:173,400,438`) — 매 기동 재설치 | ○ |
| `paned.pid`·`paned.sock` | pid·소켓 | `os.WriteFile`(`paned.go:446`, GO-P2) | × |
| `daemon.log`·`restart.log` | 텍스트 | append, 무상한(§2) | × |
| `*.v1.bak`·`*.preuuid.bak` | 마이그레이션 백업 | 1회성 | `migrate` 출력만 |
| `panels.json`·`paneld.*` (실측) | **코드에 없는 이름** — 개명 전 잔재로 추정 | — | × |

원자 쓰기 적용 범위: 상태 파일 7곳 전부 `WriteFileAtomic`(fsync+rename) — **양호**. 비원자 `os.WriteFile` 16곳은 재생성 가능한 파일·1회성 마이그레이션·pidfile 뿐이라 데이터 손실 경로가 아니다.

**손상 감지·복구:**
- `workspace.json` 파싱 실패 → `emptyIndex()` 로 **계속 기동**(`manager.go:113-122`, NFR-EM-3 "기존 동작 유지"), 로그 한 줄. 원본 blob 은 스냅샷에 그대로 남고 `GET /api/state` 는 `json.Unmarshal` 오류를 무시한 채 `ws: null` 을 보낸다(`handlers_api.go:223-226`). 프론트는 `_fetchStateKnown` 실패 → `_mkWindow` → If-Match 없는 PUT(FE-P0-2) → **손상 파일이 빈 워크스페이스로 덮인다.** 격리 사본(`.corrupt-<ts>`)도, 마지막 정상본도 없다.
- `settings.json` 은 JSON 인지도 보지 않는다(SEC-P2 §4.4). `access.json` 손상은 fail-open(SEC-P2 §4.1).
- 체크섬·무결성 표식 없음.

**백업:** Settings ▸ Backup(`web/js/core/app-backup.js`) 은 **설정 blob + localStorage 3키 + sessionStorage 2키** 를 JSON 으로 내보내고 전체 교체로 되돌린다. 봉투 `{kind:'dongminal-settings', version:1}`. **workspace·tools·runs·access·notes 는 담지 않는다.** 서버측 백업·주기 스냅샷·`dongminal backup/restore` 없음.

**되돌리기(Undo):** git 커밋 undo 토큰(`gitapi/handlers_git_write.go:196-`, 만료 409) — 모범. 그 외: 창 삭제(UX-P1), 파일 삭제(UX-P2), 설정 가져오기("되돌릴 수 없습니다" `index.html:447`, 가져오기 전 스냅샷 없음), 워크스페이스 변경(rev 는 있으나 히스토리 없음) 전부 없음.

**편집기 쓰기 충돌:** `/api/file/write`(`handlers_files.go:362-388`) 는 mtime·ETag 대조 없이 무조건 덮는다 — 두 브라우저 또는 터미널 편집과의 last-writer-wins. (TEST-P0 는 이 종단의 테스트 부재를, SEC-P1-5 는 경로 가드 부재를 다룬다; **충돌 감지 부재**는 새 항목이다.)

**보존:** `.bak` 5개가 홈에 영구 잔류(실측), `tool-history/` 무제한, 로그 무상한(§2). `runs.json` 은 리퍼가 거둔다(`StartRunReaper`).

### 프로덕션 기준선

상태 파일 백업 세대(저장 시 회전 N개 + 스키마 변경 전 강제 스냅샷) · 손상 시 격리 사본 + 마지막 정상본 복원 + UI/헬스에 알림 · `dongminal backup --out`/`restore <zip>`(홈 전체, 소켓·pid·로그 제외) · 설정 가져오기 전 자동 스냅샷 · 워크스페이스 최근 N rev 되돌리기 · 편집기 mtime 대조(412) · 보존 정책(로그·bak·history 상한).

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G4-1 | **필수** | 상태 파일 백업 세대 없음 — 손상·오조작·다운그레이드 어느 경우에도 돌아갈 곳이 없다 | `platform.WriteFileAtomic` 호출부 7곳을 감싸는 `WriteFileAtomicKeep(path, n)` 또는 `workspace/fs.go` `FilePersister` 에 회전, `migrate` 백업 규약 통합 | M |
| G4-2 | **필수** | 손상 감지→격리→복구 경로 없음 — `workspace.json` 손상이 빈 인덱스 기동 → FE-P0-2 덮어쓰기로 이어진다 | `manager.go:113-122`(격리 사본 + 최근 백업 시도 + `persistErr` 노출), `handlers_api.go:223`(파싱 실패를 클라이언트에 알림), G2-2 헬스 | M |
| G4-3 | 권장 | 홈 전체 내보내기·가져오기(`backup/restore` CLI) — 새 기계 이전·재설치의 유일한 길 | 신규 `ctl/cli/backup.go`, 제외 목록 규약 | M |
| G4-4 | 권장 | 설정 가져오기 전 자동 스냅샷(되돌리기 1회) | `app-backup.js:_bkApply` + 서버 `settings.json` 회전(G4-1) | S |
| G4-5 | 권장 | 편집기 저장 충돌 감지(mtime/ETag → 412) | `handlers_files.go:362`, `web/js/core/app-editor.js` 저장 경로, `file-editor.js` | S |
| G4-6 | 권장 | 보존 정책 — `.bak` 영구 잔류, `tool-history` 무제한, 개명 전 잔재(`panels.json`·`paneld.*`) 정리 없음 | `migrate` 완료 후 안내, `history.go`, `start` 의 잔재 정리 | S |
| G4-7 | 권장 | 워크스페이스 되돌리기(최근 N rev 메모리 보관 + `POST /api/workspace/revert`) | `workspace/manager.go` `Save`, UI 진입점(UX-P1 창 삭제 Undo 와 같은 자리) | M |

연계만: 영속 실패 가시화(GO-P1), settings 검증(SEC-P2 §4.4), 창 삭제·파일 삭제 Undo(UX-P1·P2), `/api/file/write` 가드·테스트(SEC-P1-5·TEST-P0).

---

## 5. 설정 관리

### 현재 상태

- **소스가 다섯 층**: ① CLI 플래그(`ctl/cli/options.go`: `--port/--home/--expose/--restart-daemon/--isolated/--foreground`, 포트 범위 검증 `:88-92`, `~` 확장) ② 환경변수 — 이름 상수 9개(`dmenv.go`, `options.go:28-42`: `DONGMINAL_HOME/HOST/PORT/LOG/TOOL_ID/TOOL_HOME/HISTFILE/RESTART_RUNNER`, `PORT`) + 상수 없이 흩어진 4개(`DONGMINAL_ATTENTION_IDLE_MS`, `DONGMINAL_ATTENTION_BELL`, `DONGMINAL_CMD_RESULT_TIMEOUT_MS`, `DONGMINAL_URL_OPEN`; GO-P2 "dmenv 한 곳으로" 연계) ③ 서버 파일(`access.json`·`sandbox.json`) ④ 브라우저 blob(`settings.json` — 서버 불해석) ⑤ 브라우저 저장소(`localStorage`/`sessionStorage`, FE-P2 C-2 키 리터럴).
- **스키마·검증**: `settings.json` 서버측 0(SEC-P2 §4.4). 프론트 `_settingsApply`(`app-settings.js:321-436`) 가 키별 `if(saved.x!==undefined)` 로 얹고 일부만 범위 검증(폴링 주기 `pollValue`, `focusEdgeLevel`, `attnEdgeLevel`, `tabWidthPx`). 미지 키 무시, 타입 오류는 `!!`·`Number()` 강제. `access.json` 은 PUT 때만 `validateAccessValue`. 설정 키의 단일 목록은 `saveSettings` 의 24키 나열(`app-settings.js:15`) — 즉 **저장 함수가 스키마다.**
- **기본값**: `dmenv` 상수(호스트·포트·홈), 프론트 `constants.js` 전역 `var`(FE-P1). 서버측 설정 기본값 표 없음.
- **문서**: `getting-started.md` 가 `DONGMINAL_HOME/HOST/PORT/LOG/TOOL_ID`·`PORT` 를, `features.md` 가 `DONGMINAL_ATTENTION_*` 를 문서화. **미문서**: `DONGMINAL_TOOL_HOME`, `DONGMINAL_CMD_RESULT_TIMEOUT_MS`, `DONGMINAL_URL_OPEN`, `DONGMINAL_HISTFILE`(내부). `settings.json` 키 참조 문서 없음(`features.md` 는 UI 설명).
- **잘못된 설정 시 동작**: `settings.json` 비JSON → 서버는 그대로 서빙 → `main.js:14-21` `catch{}` → 기본값으로 조용히(FE-P1). `access.json` 손상 → fail-open(SEC). `workspace.json` 손상 → 빈 인덱스(§4). `PORT` 환경변수는 검증 없이 `net.Listen` 까지 간다(`ResolvePort`) → `start` 가 "기동 실패. 로그:" 로 끝난다(`start.go:124-129`) — 사유는 로그 tail 에만.
- **서버 설정 파일**: 없다. 서버 동작(호스트·포트·로그)은 플래그/환경변수뿐. §1 의 인증·TLS·§2 의 로그 레벨이 들어오면 옵션이 10개를 넘고, 그때 `systemd`/`launchd` 유닛에 환경변수를 줄줄이 적는 형태가 된다.

### 프로덕션 기준선

설정 키·타입·범위·기본값의 **단일 원천**(Go 구조체 + JSON 스키마 생성 또는 프론트 서술자 표 확장) · 서버측 `json.Valid` + 크기 + 알려진 키 타입 검증(미지 키는 보존) · `dongminal config show/validate` · 환경변수 전수 문서 + 잘못된 값의 동작 정의 · 서버 설정 파일(`$DONGMINAL_HOME/server.json`, 플래그 > 환경 > 파일 > 기본값).

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G5-1 | 권장 | 설정 스키마 단일 원천 + `config validate` — 지금은 `saveSettings` 의 24키 나열이 스키마 | `app-settings.js` 서술자 표(FE-P2 D-1 과 같은 작업), 서버 `handlers_settings.go` 최소 검증(SEC-P2 §4.4), 신규 CLI | M |
| G5-2 | 권장 | 환경변수 4개 미문서 + 잘못된 값의 동작 미정의(`PORT` 비숫자 → 로그 tail 에만) | `getting-started.md`, `options.go` `ResolvePort` 검증 | S |
| G5-3 | 권장 | 서버 설정 파일 부재 — 인증·TLS·로그 레벨 도입 시 필요 | 신규 `ctl/cli/config.go`, `options.go` 우선순위, `dmenv` | M |
| G5-4 | 선택 | 설정 변경 감사 로그(누가·언제·무엇을 — 인증 도입 뒤 의미가 생긴다) | `handlers_settings.go`, `access.go` PUT | S |

연계만: 환경변수 파싱 분산(GO-P2), 설정 저장 실패 침묵(FE-P1), 상위 스키마 미감지(SEC-P2 §4.6).

---

## 6. 에러 처리 규약

### 현재 상태

- **서버 등록부는 있고 잘 설계됐다**: `internal/webserver/apierr` — sentinel 78개 → `(status, code)` 테이블 3벌(`Git/Runs/FS`, `tables.go`), 와이어 코드 단일 소유(`codes.go` 40여 개), 전수성 테스트(`inventory.go` — 미매핑 sentinel 이 조용히 500 이 되는 경로가 구조적으로 없다). `architecture.md:141-176` 이 **오류 본문 방언 4종**(git `{error,message}` · fs `{code,message}` · runs `{error,detail}` · 단문 `{error}`)을 공개 계약으로 문서화하고 "통일하지 않는다(파괴적 변경)" 를 결정으로 적었다.
- **등록부 밖**: `apierr.` 사용은 `gitapi` 13파일 + `httpapi` 3파일(59곳). `http.Error(w, …)` **63곳**은 `text/plain` 본문으로 나간다 — `handlers_files.go` 14, `handlers_api.go` 12, `commands.go` 9, `handlers_file_probe.go` 8, `access.go` 6, `handlers_attention.go` 5, `handlers_tools_kill.go` 3 등. 이 표면(파일·업로드·ACL·커맨드·주의·kill·whoami)은 **코드가 없고 문구가 계약**이다. 렌더러도 5종(`writeToolIOError`·`fsFail`·`writeRunError`·`gitFail`·`http.Error`, GO-P2 연계).
- **프론트 소비**: 코드→한국어 표 2벌 `GIT_WRITE_ERR`(`constants-git-actions.js:15`)·`EDITOR_FS_ERR_MSG`(`constants-editor.js:435`), 소비 지점 6곳(`panel-write.js:171`, `remote.js:590`, `app-editor.js:873`, `file-tree-xfer.js:98`, `file-editor-diff.js:383`, `sidebar-tabs.js:173`) — 모르는 코드는 서버 `message` 원문 폴백. git 은 stderr tail + 복사 버튼(UX 가 모범으로 꼽음). **비-git 표면**은 `r.ok` 검사 41곳에 `Toast.show` 사용 1곳 — 실패가 어디에 보이는지 자리마다 다르다(UX-P1 알림 채널 4종 연계).
- **사용자용 문서**: `api.md:103` 이 fs 코드 7개만 문서화. git 코드 30여 개·runs sentinel 문자열은 문서 없음(DOC-P1 api.md 누락과 겹치나 **에러 카탈로그 자체의 부재**는 별개).
- **복구 안내**: git 확인창의 recovery hint 만. 파일·설정·ACL·업그레이드 오류에는 "다음에 무엇을 하라" 가 없다. CLI 는 `migrate.go` 처럼 한국어 자유 문장 + 명령 힌트, 종료 코드 0/1/2.
- **오류 식별자**: 없다. 500 본문에 내부 문구(GO-P1)이고 로그와 잇는 ID 가 없어 사용자가 "이 오류" 를 신고할 방법이 문구 복사뿐.
- **WS**: 프레임 `0x01` 에 UTF-8 메시지(`api.md:147`) — 코드 없음.

### 프로덕션 기준선

새 표면부터 단일 봉투 `{code, message, hint?, id?}` + 기존 4방언 유지(이행 계획 문서) · `http.Error` 표면에 코드 부여 · 에러 카탈로그 문서(코드→의미→복구) · 오류 ID = 요청 ID(G2-4) 를 본문과 로그에 · 프론트 비-git 표면 공통 실패 표시.

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G6-1 | 권장 | `http.Error` 63곳(파일·업로드·ACL·커맨드·주의·kill)이 `apierr` 밖 — 코드 없는 `text/plain` 계약 | 표면별 코드 상수 추가(`codes.go`), 렌더러 통합(GO-P2 연계), 프론트 폴백은 이미 `message` 원문이라 호환 | M |
| G6-2 | 권장 | 에러 카탈로그 문서 없음(코드 40여 개 중 문서화 7개) | `docs/external/api.md` 또는 신규 `errors.md`, `codes.go` 에서 생성 가능 | S |
| G6-3 | 권장 | 오류 ID·로그 상관 없음 — 신고 시 문구 복사뿐 | G2-4 선행, 렌더러 5종에 `id` 필드 | S |
| G6-4 | 선택 | 방언 4종 → 단일 봉투 이행 — `architecture.md` 가 의도적으로 보류한 파괴적 변경. 인증 도입(401/403 새 표면)이 자연스러운 시작점 | 새 표면만 새 봉투, 기존은 deprecation 표기 | L |

연계만: 500 본문 내부 문구(GO-P1), 렌더러 5종 통합(GO-P2), 알림 채널 분산(UX-P1), 설정 저장 실패 침묵(FE-P1), fetch 관용구 통합(FE-P1).

---

## 7. 접근성·국제화 기준

### 현재 상태

- **목표 기준 선언: 없음.** `docs/`·`README` 에서 `WCAG`·`a11y`·`접근성` grep 결과는 `UX_REVISION_SRS.md:290` FR-BLP-21 의 "접근성 하한(30px)" 한 줄과 보관 SRS 의 `aria-label` 언급뿐. 자동 검사(axe·`@axe-core/playwright`) 없음(`package.json` devDependency 는 Playwright 하나), 키보드 순회 e2e 없음(`e2e/` 에 a11y·keyboard 스펙 0). UX-P1/P2 의 개별 결함(포커스·역할·대비·라이브 리전·`lang`)은 그쪽 소관 — 여기서는 **"무엇을 목표로 삼는가" 가 정해진 적이 없다** 는 사실만 적는다.
- **i18n 체계: 없음.** 문자열은 `web/js/core/constants*.js` 5파일 2,737줄에 **부분** 집중(FR-DRC-13 의 의도). 그 밖에 한국어 리터럴이 **JS 77파일 241줄**, `index.html` 178줄, Go 서버 `http.Error` 한국어 6곳 + CLI 출력 전부 한국어. 메시지 카탈로그·키·복수형·로케일 감지(`navigator.language`·`Intl` 사용 0, `toLocaleString` 산발) 없음. `<html lang="en">`(UX-P2). 툴팁은 영어(FR-TIP-2 규약), 라벨은 혼용(UX-P2) — **"툴팁 영어" 는 규약이지만 "제품 언어가 무엇인가" 는 어디에도 없다.** 릴리스 노트·README·CLI 도움말 전부 한국어라 사실상 한국어 단일 제품이나 그렇게 선언돼 있지 않다.

### 프로덕션 기준선

접근성 목표 선언(WCAG 2.1 AA 를 권장; 터미널 캔버스는 xterm 의 접근성 모드 범위로 한정 명시) + 핵심 화면(설정 모달·사이드바·git 확인창) axe 스모크 + 키보드 순회 e2e · 언어 정책 선언(한국어 단일이면 그 사실과 영어 지원 계획 유무를 README 에; 다국어면 카탈로그 도입) · 서버 오류 문구는 코드로, 문장은 프론트가.

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G7-1 | 권장 | 접근성 목표 기준 미선언 + 자동 검사 0 — UX-P1 조치의 "완료 조건" 이 없다 | `docs/internal/` 정책 1쪽(S), `@axe-core/playwright` + 스모크 3~5스펙(M), `verify.yml` 게이트 | S+M |
| G7-2 | 권장 | 제품 언어 정책 미선언(한국어 단일 vs 다국어) — 결정 없이는 G7-3·UX-P2 혼용 조치가 방향을 못 잡는다 | README·`docs/internal/README.md` 결정 기록 | S |
| G7-3 | 선택 | 문자열 외부화·i18n 체계(JS 241줄/77파일 + HTML 178줄 + Go) — G7-2 가 "다국어" 일 때만 | 카탈로그 모듈, `constants*.js` 키화, `index.html` 정적 문구 렌더 이관 | L |
| G7-4 | 선택 | 서버 한국어 문구 6곳 → 코드화(G6-1 과 함께) | `http.Error` 호출부 | S |

연계만: `lang="ko"`(UX-P2), 라벨 언어 혼용(UX-P2), 대비·역할·포커스·라이브 리전(UX-P1).

---

## 8. 개발자 경험·기여 워크플로

### 현재 상태

- **도구 게이트**: 린터·포맷터 설정 없음(`.golangci.yml`·eslint·prettier·`.editorconfig` 부재 — DOC-P2·TEST-P2 §3.1 이 지적, 반복하지 않음). pre-commit/훅 없음(`core.hooksPath` 미설정, `.git/hooks` 샘플뿐, husky/lefthook 없음). 대신 **프로젝트 고유 게이트 4종**(`scripts/check-seams.sh`·`check-timers.sh`·`check-gitwrite.sh`·`check-cross.sh`)이 CI `verify.yml` `gates` 잡에 걸려 있다 — 이것은 잘 되어 있다.
- **로컬 셋업 문서**: `docs/internal/building.md` — 빌드·검사·배포·테스트·격리 실행·기술 스택. 원커맨드(Makefile/Taskfile) 없음, Node 버전 미고정(`package.json` `engines` 없음, `.nvmrc` 없음), Go 는 `go.mod` 로 고정. devcontainer 없음.
- **기여 절차**: CONTRIBUTING/PR 템플릿/CODEOWNERS 없음(DOC). 브랜치 전략·리뷰 규칙·**릴리스 절차(누가 언제 태그를 미는가, CHANGELOG 를 언제 닫는가)** 문서 없음 — `release.yml` 주석이 "태그를 밀면" 이라고만 한다.
- **ADR 판정 — SRS 113개는 ADR 이 아니다.** 근거:
  - SRS 는 IEEE 29148 구조(목적·범위·현황·요구사항 FR/NFR·검증·비목표·변경 기록)의 **요구사항 명세**다(`ACCESS_ALLOWLIST_SRS.md` 헤더 구조 실측). 결정은 본문 안에 `D-n` 표기로 **묻혀** 있고(58개 SRS 에서 `D-[0-9]+` 마커 실측), 결정 단위의 색인·상태(제안/채택/폐기/대체)·"이 결정을 대체한 결정" 링크가 없다.
  - 결정을 찾으려면 `docs/internal/README.md`(63KB 산문 색인)에서 SRS 를 고른 뒤 본문을 읽어야 한다. 예: "오류 방언 4종을 통일하지 않는다" 는 `architecture.md:141-176` 산문에, "다크/라이트 테마 CSS 소비" 는 SRS 어딘가에.
  - 상태 필드가 94% 부재(DOC-P2)라 "구현된 결정" 과 "초안 결정" 이 문서 집합으로 갈리지 않는다.
  - `docs/internal/design/` 13개 CONTRACT 문서는 git 모듈 계약이지 결정 기록이 아니다.
  - 따라서 **결정의 내용은 풍부하나 "결정 로그" 로서의 발견 가능성·수명 관리가 없다.** ADR 을 새로 쓰라는 뜻이 아니라, 기존 `D-n` 을 뽑아 색인(제목·SRS 링크·상태·대체 관계)만 세우면 ADR 의 역할을 한다.

### 프로덕션 기준선

린터·포맷터·pre-commit(또는 CI 게이트 동등물) · 원커맨드 로컬 셋업 + 버전 고정 · CONTRIBUTING(브랜치·리뷰·커밋 규약·릴리스 절차) · 결정 색인(ADR-lite).

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G8-1 | 권장 | 결정 색인 없음 — SRS 58개에 흩어진 `D-n` 을 모은 `docs/internal/decisions.md`(제목·근거 1줄·SRS 링크·상태·대체) | 문서 작업 + 새 SRS 템플릿에 "결정 요약" 절 | M |
| G8-2 | 권장 | 릴리스 절차·기여 워크플로 문서(태그 시점·CHANGELOG 닫기·핫픽스 브랜치·리뷰) | `CONTRIBUTING.md`, `building.md` 배포 절 확장 | S |
| G8-3 | 권장 | 로컬 게이트 실행 원커맨드 + pre-commit(4종 스크립트 + gofmt + vet 를 커밋 전에) | `Makefile`/`Taskfile`, `.githooks/` + `core.hooksPath` 안내 | S |
| G8-4 | 선택 | Node 버전 고정(`engines`·`.nvmrc`)·devcontainer | `package.json`, 신규 파일 | S |
| G8-5 | 선택 | SRS 템플릿에 상태·결정 요약 필드 강제(린트) — DOC-P2 연계 | 스크립트 1개 | S |

연계만: 린터·포맷터·`.editorconfig`(DOC-P2·TEST-P2 §3.1), 이슈/PR 템플릿·LICENSE·SECURITY.md(DOC).

---

## 9. 성능·용량 기준

### 현재 상태

- **성능 예산·SLO 선언: 없음.** `docs/external`·README 에 `SLO`·`성능 예산`·`p95` 0건. `architecture.md:913-932` "성능: 핫패스 비차단" 절에 측정치 하나(`Save` 101.7ms→18µs)와 설계 원칙. SRS 의 `NFR-*` 149개(55 파일)는 기능 국소(예: `NFR-SPK-2` 진행 배너)이지 제품 수준 목표가 아니다. 벤치마크 `func Benchmark` 1파일. 성능 회귀 테스트 없음. e2e 는 기능 검증(TEST).
- **상한은 코드에만 있다** — 40여 개 상수 실측: `fsListMax/fsDeleteMax/fsCopyMax 10000`, `zipMaxEntries 50000`, `CopyMaxFiles 50000`, `lsp.MaxSessions 6`, `LogMaxLimit 2000`, `MissHoldLimit 64`·`MissHoldMax 10m`, `bufMax 1MiB`, `DiffMaxBytes 1MiB`, `fsGrepMaxBytes 2MiB`, `waitMaxTimeoutMS 30m`, `MaxMessages 500`, `gitObserveMax 4`, 프론트 `scrollback 50000`(FE-P2 E-3), 슬롯 4(README). **어느 사용자 문서도 이 값을 말하지 않는다.** 없는 상한: 도구 수·창/탭 수·동시 WS/SSE 클라이언트·메모리(SEC-P1-4 가 프로세스·구독 상한 부재를 다룸 — 여기서는 **"실질 상한이 얼마이며 넘으면 무엇이 일어나는가" 가 문서에 없다** 는 점).
- **용량 실측**: `diag` 스냅샷이 `tools/ws/goroutines/allocMB` 를 남기지만 "도구 N개에서 메모리 M" 같은 기준표가 없다. README 의 "아이패드에서도" 는 모바일 성능 기준 없이 쓰였다.

### 프로덕션 기준선

제품 수준 성능 예산(첫 페인트·키 입력→화면 왕복 p95·재연결 복구 시간·도구당 메모리) + 측정 하네스(e2e 타이밍 또는 `go test -bench` 스모크) · 용량 기준 문서(지원 상한·초과 시 동작·실측 근거) · 상한 초과의 사용자 대면 동작(429/413 + 문구).

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G9-1 | 권장 | 용량 기준 문서 — 도구/창/탭/클라이언트/스크롤백/파일 상한과 초과 시 동작 | `docs/external/features.md` "제약" 절, 상수 40여 개를 표로 | S |
| G9-2 | 권장 | 성능 예산·SLO 선언 + 측정 하네스 | `docs/internal/` 정책, e2e 타이밍 리포터(`parity-reporter.ts` 확장) 또는 벤치 스모크 | M |
| G9-3 | 선택 | 성능 회귀 CI(벤치 비교 또는 e2e 시간 예산) | `verify.yml` | M |

연계만: 프로세스·구독 상한(SEC-P1-4), 요청 본문·파일 크기 상한(GO-P1·SEC-P2 §4.4), 폴링·스크롤백 메모리(FE-P2 E).

---

## 10. 제품 경계

### 현재 상태

- **플랫폼**: 문서화됨 — macOS·Linux·WSL·Windows 10 1809+(`README.md`, `getting-started.md:8-16`, `building.md:11-21`), 대상 5종, Windows 최소 버전의 근거(ConPTY). `linux/arm64` 는 빌드만 하고 실동작 미검증(`RELEASE_SRS §5-4`, `§8.3`) — **사용자 문서에는 이 사실이 없다.**
- **브라우저·기기**: 지원 브라우저·최소 버전 선언 **없음**(`docs/external`·README 에 Safari/Firefox/Chrome grep 0 — `--app` 언급 제외). README 는 "아이패드에서도" 라 쓰고 모바일 모드가 있으나 iOS 버전·모바일 브라우저 범위 미기재.
- **최소 요구사항**: OS 외 없음. 선택 의존을 문서가 부분적으로만: `docker`(샌드박스, `features.md:19`), `git`(`ErrGitMissing` 코드 존재, 문서 없음), `rg`(있으면 쓰고 없으면 Go 폴백 `handlers_fs_search.go:198-220` — 문서 없음), 셸(zsh/bash/pwsh "자동으로 고릅니다"), `claude` CLI(선택). 메모리·디스크·CPU 기준 없음.
- **보안 경계 문서**: `README.md:77-79` 한 문장("인증이 없으므로 신뢰하는 망에서만")과 `ACCESS_ALLOWLIST_SRS §1·§5`. 위협 모델·지원 배포 형태(loopback / Tailscale / LAN / 리버스 프록시 / 멀티유저 호스트)·각 형태의 보증 수준·**멀티유저 호스트 미지원 선언**(SEC-P1-6 의 전제) 없음. SECURITY.md 없음(DOC). 인증이 들어오면 이 절은 **필수 갱신** 대상.
- **데이터 위치**: `features.md` "파일 영속성" 표 4항목 vs 실제 홈 15항목(§4 표). `/tmp/dongminal.log` 는 `getting-started` 에 있으나 표에는 없음. `features.md:364` "PTY 프로세스 자체는 서버 메모리에만 존재 → 서버 재시작 시 초기화" 는 **데몬 모드와 모순**(데몬이 PTY 를 들고 서버 재시작을 넘긴다 — `architecture.md` 첫 절) — 문서 표류(DOC 축이 잡지 않은 항목).
- **알려진 제약**: README "알려진 문제" 1건(원격 끊김). `features.md` 곳곳에 개별 제약(컨테이너 잔류 등)이 있으나 모아 둔 절이 없다. 지원 정책(몇 판까지 지원·스키마 호환 약속·폐기 예고) 없음.

### 프로덕션 기준선

지원 매트릭스(OS·아키텍처·검증 수준 / 브라우저·최소 버전 / 모바일) · 요구사항(필수·선택 의존과 없을 때의 동작) · 보안 경계 문서(위협 모델·지원 배포 형태·보증·미지원 선언) · 데이터 위치 전수표(무엇이 어디에, 지우면 무엇을 잃는가) · 지원·폐기 정책.

### 갭

| ID | 등급 | 갭 | 영향 범위 | 규모 |
|---|---|---|---|---|
| G10-1 | **필수** | 보안 경계 문서 — 위협 모델, 지원 배포 형태별 보증(loopback·Tailscale·LAN+인증+TLS), 멀티유저 호스트 미지원 선언. 인증 필수화와 함께 README:77-79 를 대체 | `README.md`, `docs/external/getting-started.md` §노출, 신규 `SECURITY.md`(DOC 연계) | S |
| G10-2 | 권장 | 브라우저·기기 지원 매트릭스 + 최소 요구사항(git·docker·rg 선택 의존과 부재 시 동작) | `getting-started.md` 요구사항 표 확장 | S |
| G10-3 | 권장 | 데이터 위치 전수표(15항목) + `features.md:364` 표류 정정 | `features.md` 파일 영속성 절 | S |
| G10-4 | 권장 | 지원·폐기 정책(지원 판 범위, 스키마 호환 약속, `--expose` 무인증 폐기 예고) | 신규 절, CHANGELOG 규약 | S |
| G10-5 | 권장 | `linux/arm64` 미검증 사실의 사용자 문서 명시 | README·getting-started 한 줄 | S |
| G10-6 | 선택 | `linux/arm64` 실검증(러너 또는 QEMU) | `verify.yml` | M |

---

## 11. 미확인 (코드로 확정하지 못한 것)

1. Windows 의 AF_UNIX 소켓 접근 제어와 인증 게이트 상호작용 — POSIX 만 읽었다(SEC 미확인 #8 과 동일).
2. `settings.json` 24키 중 프론트가 검증하지 않는 키(`layoutPresets`·`customTheme`·`shortcuts` 객체 형태)에 손상된 값이 들어왔을 때의 정확한 동작 — `Object.assign` 으로 얹히므로 부분 손상은 통과할 것으로 보이나 실행하지 않았다.
3. `ext/` 언어 서버 런타임의 크기·정리 정책(§3 제거 목록에 넣었으나 실제 용량 미측정).
4. e2e 303곳의 직접 HTTP 호출 중 `page.request`(쿠키 공유) 와 `fetch` 안 `evaluate`(문서 컨텍스트) 의 비율 — 인증 도입 시 수정 범위가 이 비율에 좌우된다. 표본만 봤다.
5. `tool-history/` 의 실제 증가 속도 — 실측 13KB 라 지금은 문제 아니나 상한 로직은 없다.

---

## 12. 착수 순서 제안 (필수 13건)

1. **인증 묶음** G1-1·G1-2·G1-3·G1-4·G1-5 + G10-1 — SEC-P0-1·P0-2·P1-1·P1-7 게이트와 같은 미들웨어 자리에서 한 번에. 이것이 "노출 유지" 결정의 전제 조건이다.
2. **업그레이드·롤백** G3-1·G3-2 + **백업·손상 복구** G4-1·G4-2 — 인증 도입은 파괴적 변경(기존 `--expose` 사용자 기동 거부)이므로 그 릴리스가 나가기 **전에** 판 불일치 감지와 롤백 경로가 있어야 한다.
3. **관측성 최소선** G2-1·G2-2·G2-3 — 1·2 를 배포한 뒤 문제가 들어올 때 받을 그릇. `daemon.log` 상한은 한 시간짜리이므로 먼저 해도 된다.

권장 30건 중 초기 운영에서 먼저 닿을 것: G3-3(업데이트 확인)·G3-4(제거)·G3-5(e2e 게이트)·G4-5(편집기 충돌)·G6-1(코드 없는 오류 표면)·G7-2(언어 정책)·G8-1(결정 색인)·G9-1(용량 문서)·G10-2·G10-3.
