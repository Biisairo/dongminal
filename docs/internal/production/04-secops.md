# 04 — 보안 · 운영 준비도 감사 (dongminal)

- 대상: `/Users/dykim/personal/dongminal` (Go 웹서버 + 데몬, 원격 명령 실행 능력 보유)
- 성격: 본인 소유 도구에 대한 방어적 read-only 감사. 코드 수정 없음, 익스플로잇 코드 없음.
- 방법: `README.md` · `docs/internal/architecture.md` · `docs/internal/ACCESS_ALLOWLIST_SRS.md` 로 의도된 모델을 확인한 뒤, `internal/webserver/httpapi`, `gitapi`, `domain/git/core`, `shared/toolhub`, `shared/platform`, `ctl/cli`, `cmd/dongminal`, `.github/workflows`, `scripts` 를 직접 읽었다. 모든 발견에 `파일:라인` 을 단다. 확인하지 못한 항목은 §6 "미확인" 에 분리했다.

---

## 0. 요약

| 등급 | 건수 | 핵심 |
|---|---|---|
| **P0** | 2 | 브라우저를 매개로 한 원격 코드 실행 — WebSocket Origin 미검증(CSWSH) + 상태 변경 HTTP API 의 CSRF 무방비. **"로컬 전용" 전제가 이 두 건의 위험을 낮추지 못한다** (§1.2). |
| **P1** | 7 | `--expose` 무인증 평문, `http.Server` 타임아웃 전무, 요청 본문 무제한, 프로세스·구독 생성 무제한, 루트 가드 없는 파일 API, 로컬 권한 경계(소켓·홈 디렉터리·로그 0644/0755), Host 헤더 미검증(DNS rebinding). |
| **P2** | 22 | 관측성(비구조화 로그·메트릭 없음·서버 자체 감독 없음), 설정 fail-open, 빌드 공급망(액션 SHA 미고정·취약점 스캐너 없음·`-trimpath` 없음·체크섬 미서명), 보안 헤더, 정보 노출 등. |

**리포지토리 위생 (확인 완료):** `./dongminal`(16MB) · `dist/` · `playwright-report/` · `test-results/` · `.playwright-mcp/` 는 **모두 git 에 추적되지 않는다.** `git ls-files` 에 한 건도 없고(`.gitignore` 1·31·32·41·44 행이 덮는다), `git log --all --diff-filter=A -- dongminal dist` 도 비어 있어 과거에 커밋된 적도 없다. 작업 트리에만 존재한다.

---

## 1. 의도된 보안 모델 (문서 기준)

### 1.1 문서가 말하는 것

- 기본 바인드 `127.0.0.1:58146` (`internal/shared/dmenv/dmenv.go:45-46`), `--expose` 또는 `DONGMINAL_HOST=0.0.0.0` 이면 LAN 노출 (`internal/ctl/cli/start.go:36-42`).
- **인증 없음. TLS 없음. Host 헤더 검증 없음** — `ACCESS_ALLOWLIST_SRS.md §5` 가 셋 모두를 명시적 비목표로 선언한다. README 는 "인증이 없으므로 신뢰하는 망에서만 쓰세요" 라고 안내한다 (`README.md:77-79`).
- 유일한 접근 제어는 **출발지 IP 허용 목록(ACL)** — 기본 꺼짐, 자기 주소는 항상 통과 (`internal/webserver/httpapi/access.go:269-312`).
- 파일 API 두 계층: `/api/fs/*` 는 Editor 루트 가드가 있고, `/api/file/*` · `/api/upload` · `/api/download` 는 **의도적으로 가드가 없다** ("사용자가 경로를 이미 알고 지목한 읽기·쓰기", `internal/webserver/httpapi/handlers_fs.go:22-25`).
- git 실행은 두 초크포인트(`Exec`/`ExecWrite`) + 하위 명령 화이트리스트 + 인자 가드를 지난다 (`internal/webserver/domain/git/core/guard.go`).

### 1.2 그 전제가 코드로 강제되는가

| 전제 | 강제 여부 | 근거 |
|---|---|---|
| 기본은 loopback 만 듣는다 | **예** | `dmenv.go:45` 기본값, `start.go:36` |
| 그러나 환경변수 하나로 조용히 뒤집힌다 | 예(위험) | `start.go:37-39` — `DONGMINAL_HOST` 가 있으면 그대로 바인드. 로그에 "LAN 노출" 은 남는다(`start.go:132-136`) |
| loopback 이면 다른 주체가 접근 못 한다 | **아니오** | 브라우저가 매개다. 사용자 브라우저에 로드된 **임의 웹페이지**는 `http://127.0.0.1:58146` 에 요청과 WebSocket 을 보낼 수 있고, 서버는 Origin 을 보지 않는다(§2 P0-1·P0-2). 포트가 고정값(58146)이라 추측할 필요도 없다. |
| ACL 이 켜지면 기기만 들어온다 | 부분적 | `RemoteAddr` 만 본다(`access.go:336-349`, 프록시 헤더 무시 — 옳다). 그러나 ACL 은 "허용된 기기의 브라우저가 로드한 악성 페이지" 를 가르지 못한다 — 출발지가 같다. |

결론: **"로컬 전용" 은 네트워크 경계일 뿐이며, 이 서버의 실제 공격면은 브라우저 동일 출처 정책의 틈이다.** 아래 P0 두 건은 기본 설정(127.0.0.1)에서도 성립한다.

---

## 2. P0 — 즉시 조치

### [P0-1] WebSocket Origin 미검증 → 임의 웹페이지가 터미널에 입력을 쓸 수 있다 (CSWSH → RCE)

- **위치**
  - `internal/shared/toolhub/conn.go:34-37` — `Upgrader = websocket.Upgrader{ …, CheckOrigin: func(r *http.Request) bool { return true } }`
  - `internal/webserver/httpapi/handlers_ws.go:32` — `toolhub.Upgrader.Upgrade(w, r, nil)` (그 외 검사 없음)
  - `handlers_ws.go:45, 54-55` — `?tool=<id>` 로 기존 도구에 붙고, `handlers_ws.go:81-92` — `tool` 이 비면 **새 셸을 만든다**.
  - `handlers_ws.go:243-247` — 프레임 첫 바이트 `OpInput` 이면 그대로 PTY 에 쓴다.
- **현상**: gorilla 의 기본 `CheckOrigin`(nil)은 `Origin` 호스트가 `Host` 와 같아야 통과시키지만, 여기서는 **명시적으로 항상 true** 로 덮어 썼다. 브라우저의 WebSocket 은 CORS 프리플라이트가 없고 응답도 읽을 수 있다.
- **위험 시나리오 (전제 포함)**: 전제는 "사용자가 dongminal 을 띄운 상태로 임의의 웹페이지를 연다" 하나다. 그 페이지의 스크립트가 `ws://127.0.0.1:58146/ws` 를 열면(`tool` 생략) 서버가 사용자 권한의 로그인 셸을 하나 만들고, 이후 프레임으로 임의 명령을 타이핑·실행할 수 있다. 출력도 읽힌다. 결과는 **사용자 권한의 원격 코드 실행**이며 ACL 은 이를 막지 못한다(출발지가 사용자 자신의 기기).
- **제안 방어**
  1. `CheckOrigin` 을 복원: `Origin` 이 없으면(비브라우저 클라이언트: dmctl) 허용, 있으면 `Origin` 호스트가 `r.Host` 와 같거나 **자기 주소·ACL 항목** 집합에 속할 때만 허용. 판정 함수는 `accessStore` 옆에 두어 한 곳에서 관리.
  2. 근본 방어로 **세션 토큰**: 서버 기동 시 난수 토큰을 만들어 `index.html` 에 심고(이미 `__ASSETV__` 자리표시자 치환 경로가 있다 — `static.go:44-46`), `/ws` 와 상태 변경 API 는 토큰(헤더 또는 쿼리)을 요구. `dmctl` 은 `$DONGMINAL_HOME` 의 토큰 파일을 읽는다.
  3. `/ws` 에서 `tool` 생략 시 새 도구를 만드는 경로(`handlers_ws.go:81-92`)는 별도 종단으로 분리하거나 토큰 없이는 거부.
- **규모**: S(Origin 검증만) / M(토큰까지)

### [P0-2] 상태 변경 HTTP API 전체가 CSRF 에 무방비 — JSON 본문을 Content-Type·Origin 검사 없이 받는다

- **위치 (검사 부재)**
  - `internal/webserver/httpapi/server.go:196-216` — `Handler()` 미들웨어 체인은 logging → accessGate → recover → mux. **Origin / Sec-Fetch-Site / Content-Type / 커스텀 헤더 검사가 어디에도 없다.** 전수 grep: 요청 헤더를 읽는 곳은 `handlers_api.go:327`(`If-Match`) 하나뿐이다. `Access-Control-*` 를 설정하는 곳도 없다(= CORS 로 응답을 *읽는* 것은 막히지만, *쓰기 부작용*은 막히지 않는다).
  - `handlers_toolio.go:175-181` — `decodeJSONBody` 는 `json.NewDecoder(r.Body).Decode` 만 한다. `handlers_fs.go:92-103` `fsDecode`, `handlers_files.go:363-372`, `access.go:424-433`, `handlers_api.go:326` 도 같다.
- **CSRF 로 닿는 위험 종단 (모두 `POST`, JSON 본문 또는 쿼리스트링만 요구)**
  - `POST /api/file/write` — `handlers_files.go:362-387`. **절대경로면 어디든** `WriteFileAtomic` 한다(루트 가드 없음, 설계상). `~/.zshrc`·`~/.ssh/authorized_keys`·`~/.gitconfig` 등을 덮어 쓸 수 있다 → 다음 셸 기동 시 RCE.
  - `POST /api/tools/headless` — `handlers_runs_headless.go:47-70` → `createHeadlessTool` → `ToolManager.Create(…Placement{Command})` (`manager.go:357`) → `platform.Current().Shell.RunCommand` = **`[sh, -c, cmdline]`** (`manager.go:416-419`, `shared/platform/shell.go:113-115`). 즉 **JSON 한 줄이 곧 셸 명령**이다. 응답을 읽을 필요조차 없다.
  - `POST /api/tools/input` — `handlers_toolio.go:90-113`. 살아 있는 도구 id 를 알면 텍스트를 붙여 넣고 `execute:true` 로 엔터를 친다. id 는 `GET /api/state` 로 얻어야 하지만(CORS 로 읽기는 막힘) P0-1 의 WS 로 읽을 수 있고, 어차피 headless 경로가 더 짧다.
  - `POST /api/tools?cwd=…` — `handlers_api.go:255-281`, 쿼리스트링만으로 셸 생성(본문 불필요).
  - `PUT /api/access`, `PUT /api/settings`, `PUT /api/sandbox/config`(도커 마운트 정의 — `shared/sandbox/config.go:14,45-55`), `POST /api/fs/delete`(Editor 루트 아래 최대 1만 항목 영구 삭제, `handlers_fs.go:451-482`), `POST /api/commands`(`openUrl` 액션이 구독 중인 모든 브라우저에 URL 열기를 방송 — `commands.go:141-147`, 피싱 벡터).
- **왜 프리플라이트가 없나**: 브라우저는 `Content-Type: text/plain` 또는 `application/x-www-form-urlencoded` 인 POST 를 "단순 요청" 으로 취급해 프리플라이트 없이 보낸다. 서버는 Content-Type 을 보지 않고 본문을 JSON 으로 파싱하므로 그대로 통과한다. 응답을 못 읽어도 **부작용은 이미 일어난다.**
- **전제**: P0-1 과 동일 — 사용자가 서버를 띄운 채 악성 페이지를 연다. 기본 127.0.0.1 바인딩에서 성립한다.
- **제안 방어** (P0-1 과 한 묶음으로)
  1. `Handler()` 체인에 **CSRF 게이트** 한 겹: 상태 변경 메서드(POST/PUT/DELETE)에 대해 (a) `Sec-Fetch-Site` 가 `same-origin`/`none` 이거나 헤더가 없고(비브라우저), (b) `Origin` 이 있으면 자기 주소·Host 와 일치, (c) `Content-Type` 이 `application/json` 또는 `multipart/form-data`(업로드) — 셋을 함께 요구. 게이트를 mux 바깥 한 자리에 두는 것은 ACL SRS §2.1 의 논리와 같다("핸들러마다 뿌리면 새 종단에서 빠진다").
  2. 커스텀 헤더(`X-Dongminal: 1`) 필수화도 단순하고 효과적이다(프리플라이트를 강제한다). `web/js` 의 fetch 래퍼와 `internal/helper/runtimebin` 의 `httpPostJSON` 두 곳만 고치면 된다.
  3. 세션 토큰(P0-1 항목 2)이 들어오면 위 둘을 대체한다.
  4. 공통 디코더로 통합: `decodeJSONBody`/`fsDecode`/각 `io.ReadAll` 을 하나의 `readJSON(w, r, limit, into)` 로 모으고 거기서 Content-Type 과 크기(P1-3)를 함께 검사.
- **규모**: M

---

## 3. P1 — 실질 위험

### [P1-1] `--expose` / `DONGMINAL_HOST` 는 무인증 · 평문 · ACL 기본 꺼짐으로 PTY 를 LAN 에 연다

- **위치**: `internal/ctl/cli/start.go:36-42`(호스트 결정), `options.go:44`(`ExposeHost = "0.0.0.0"`), `access.go:80-104`(ACL 기본 `enabled=false`), `access.go:285-287`(꺼져 있으면 전부 통과).
- **현상**: 문서가 이미 인정하는 상태다(`ACCESS_ALLOWLIST_SRS.md §1.1`: "인증 없는 원격 코드 실행 종단을 네트워크에 여는 것과 같다"). ACL 은 옵트인이고, 켜도 IP 위조는 못 하지만 **같은 허용 기기의 다른 사용자/프로세스**나 **평문 도청**은 막지 못한다.
- **시나리오**: 사용자가 `--expose` 로 띄우고 ACL 을 켜지 않으면(기본), 같은 Wi-Fi 의 누구나 `http://<ip>:58146` 에서 셸을 얻는다. Tailscale 안이라도 `DONGMINAL_HOST` 를 셸 프로필에 넣어 둔 것을 잊고 공용망에 붙으면 같다.
- **제안**: `--expose` 시 ACL 이 꺼져 있으면 **기동을 거부하거나 명시 플래그(`--expose --no-acl`)를 요구**; 또는 `--expose` 가 세션 토큰(P0-1)을 자동 생성해 URL 에 담아 출력. 장기적으로 `--tls` 옵션(자체 서명 + 지문 출력).
- **규모**: S(게이트) / M(토큰·TLS)

### [P1-2] `http.Server` 에 타임아웃이 하나도 없다

- **위치**: `internal/webserver/httpapi/server.go:220` — `srv := &http.Server{Addr: addr, Handler: s.Handler()}`. 전수 grep 결과 `ReadTimeout/WriteTimeout/IdleTimeout/ReadHeaderTimeout` 은 저장소 어디에도 없다.
- **현상**: 헤더를 천천히 보내는 연결(slowloris)이 fd·goroutine 을 무기한 점유한다. keep-alive 유휴 연결도 회수되지 않는다.
- **전제**: 네트워크 도달 가능(`--expose`) 또는 로컬의 다른 프로세스.
- **제안**: `ReadHeaderTimeout: 10s`, `IdleTimeout: 120s` 를 설정. `WriteTimeout`/`ReadTimeout` 은 SSE(`commands.go`)·WebSocket·대기 종단(`handlers_status.go:31` 최대 30분)이 있으므로 전역으로 두지 않고, 필요하면 `http.ResponseController.SetWriteDeadline` 으로 핸들러별 처리.
- **규모**: S

### [P1-3] 요청 본문 크기 상한이 대부분의 종단에 없다

- **위치**: `io.ReadAll(r.Body)` 10곳 — `handlers_fs.go:93`, `handlers_files.go:363`, `handlers_settings.go:91`, `commands.go:116`, `gitapi/handlers_git.go:247, 353`, `gitapi/handlers_git_write.go:339`, `access.go:424`, `handlers_api.go:326, 452`. `decodeJSONBody`(`handlers_toolio.go:176`)도 무제한 스트림 디코드. 상한이 있는 곳은 업로드(`handlers_files.go:100,111` 512MiB `MaxBytesReader`)·LSP(`handlers_lsp.go:57,82,121`)·WS 프레임(`handlers_ws.go:25` 1MiB)뿐이다.
- **현상**: 특히 `apiSettingsPut`(`handlers_settings.go:90-102`)은 **받은 바이트를 검증 없이 그대로** 메모리에 들고 `settings.json` 에 쓴다 — JSON 인지도 보지 않는다. `apiWorkspacePut` 도 `buildIndex` 파싱 전까지 전체를 메모리에 올린다.
- **제안**: 공통 디코더(P0-2 항목 4)에 `http.MaxBytesReader(w, r.Body, 1<<20)` 기본값, 종단별 오버라이드(workspace 는 더 크게). settings 는 최소 `json.Valid` 검사.
- **규모**: S

### [P1-4] 프로세스·구독 생성에 상한이 없다

- **위치**
  - `internal/shared/toolhub/manager.go:357-397` — `Create` 는 `len(m.tools)` 를 로그로만 남기고(:395) 제한하지 않는다. 진입점: `POST /api/tools`(`handlers_api.go:255`), `GET /ws`(tool 생략, `handlers_ws.go:82`), `POST /api/tools/headless`(`handlers_runs_headless.go:47`).
  - `internal/webserver/hub/commands.go:177-183` — `CommandHub.Add()` 구독자 수 무제한. SSE 연결마다 goroutine(`commands.go` `handleCommandSSE`).
  - `handlers_status.go:31,205-219` — `wait` 종단 요청당 최대 30분 goroutine.
- **현상**: 각 도구는 PTY + 로그인 셸 프로세스다. 수천 개 요청이면 프로세스 테이블·메모리를 소진한다. 상한이 있는 것은 미스 홀드(`ws_miss.go:167` `MissHoldLimit`)·zip 2GiB·fs 목록 1만 건 등 일부다.
- **제안**: `ToolManager.Create` 에 상한(예 256) → 초과 시 명확한 오류(429). `CommandHub.Add` 에 구독자 상한(예 64), `wait` 동시 수 상한. `diag` 스냅샷(`diag_snapshot.go:56-62`)에 이미 `tools=`·`ws=` 가 실리므로 임계 경고만 더하면 된다.
- **규모**: S

### [P1-5] `/api/file/{read,write,raw,probe}` · `/api/upload` · `/api/download` 는 파일시스템 전체를 연다

- **위치**: `handlers_files.go:325-355`(read: 절대경로면 어디든 `os.Open`), `:362-387`(write), `:290-305`(download), `:176-198`(upload — `safeResolve("/", dir)` 는 주석대로 "어디든" `:181-183`), `handlers_file_probe.go`(raw/probe). 이 계층에 루트 가드가 없는 것은 **명시된 설계**다(`handlers_fs.go:22-25`).
- **현상**: 허용된 클라이언트(또는 P0-2 의 CSRF)가 `~/.ssh/id_ed25519`, `~/.aws/credentials`, 브라우저 쿠키 DB 등을 읽고 임의 파일을 덮어 쓴다. "PTY 가 이미 전권이므로 같다" 는 논리(`ACCESS_ALLOWLIST_SRS FR-ACL-21`)는 **대화형 사용자**에게는 맞지만, **브라우저 매개 공격자**에게는 PTY 보다 훨씬 쉬운 경로다(응답을 읽을 필요가 없는 write 한 번).
- **제안**: 최소한 P0-2 의 CSRF 게이트로 덮는다. 추가로 write 는 Editor 루트(`/api/editors` 목록) 또는 도구 cwd 아래로 제한하고, 그 밖은 설정에서 명시적으로 켠 경우만 허용. read 는 크기 상한(P2-DoS 참조).
- **규모**: M

### [P1-6] 로컬 권한 경계 — 데몬 소켓·홈 디렉터리·로그가 같은 호스트의 다른 사용자에게 열려 있다

- **위치**
  - `internal/shared/platform/ipc.go:49-51` — `net.Listen("unix", endpoint)`; `internal/daemon/ipc/paned.go:437-446` — 소켓 디렉터리 `MkdirAll(…, 0o755)`, pid 파일 `0o644`. **소켓에 `Chmod(0600)` 도, 디렉터리 `0700` 도 없다.** (umask 가 0022 면 소켓은 0755.)
  - `internal/ctl/cli/start.go:44`, `cmd/dongminal/main.go:433` — `$DONGMINAL_HOME` 을 `0o755` 로 만든다. 그 안의 `settings.json`·`access.json`·`workspace.json`·`tools.json`·`daemon.log` 는 `0644`(`handlers_settings.go:57`, `access.go:135`, `main.go:132`).
  - `internal/shared/platform/paths.go:65` — 기본 서버 로그 `/tmp/dongminal.log`, `start.go:199` 에서 `0o644` 로 연다. **공유 `/tmp` 에 예측 가능한 이름**이다.
- **현상**: 같은 호스트의 다른 UID 가 `paned.sock` 에 붙으면 데몬 프로토콜로 **사용자의 PTY 전부에 입력·출력 접근**이 가능하다(데몬 IPC 에는 인증이 없다). 로그에는 `RemoteAddr`·도구 cwd·헤드리스 명령 전문(`handlers_runs_headless.go` `log.Printf("[run] headless tool=%s cwd=%s cmd=%q …")`)이 남는다.
- **전제**: 다중 사용자 호스트(공용 Linux 서버, 회사 개발 서버). 단일 사용자 macOS 에서는 낮다.
- **제안**: 홈 디렉터리 `0700`, 소켓 생성 직후 `os.Chmod(sock, 0600)`, 로그 파일 `0600` 및 기본 위치를 `$DONGMINAL_HOME/server.log` 로(`/tmp` 탈피 — Windows 는 이미 `%LOCALAPPDATA%` 아래다 `paths.go:113`). 헤드리스 명령 로그는 길이·해시만.
- **규모**: S

### [P1-7] Host 헤더 미검증 — DNS rebinding 으로 P0 방어를 우회할 수 있다

- **위치**: 요청 헤더를 읽는 곳이 `If-Match` 하나뿐(§P0-2). `r.Host` 를 보는 코드는 없다. `ACCESS_ALLOWLIST_SRS.md §5-3` 이 명시적 비목표.
- **현상**: 공격자 도메인 `evil.example` 의 A 레코드를 짧은 TTL 로 공격자 서버 → `127.0.0.1` 로 바꾸면, 브라우저는 같은 출처(`http://evil.example:58146`)라고 믿으며 페이지 스크립트가 **응답까지 읽는** 요청을 보낸다(CORS 무관). 이때 `Origin`·`Host` 가 모두 `evil.example` 이라, "Origin == Host" 식의 P0 방어만으로는 통과한다.
- **제안**: `Host` 허용 목록 검사 — `localhost`, `127.0.0.1`, `[::1]`, 자기 인터페이스 주소(`accessStore.self`, 이미 수집 중 `access.go:197-202`), ACL 의 호스트명 항목. 불일치는 400/421. P0 게이트와 같은 자리에 둔다.
- **규모**: S

---

## 4. P2 — 강화 권장 (카테고리별)

### 4.1 인증·네트워크 (3)

- **[P2] `DONGMINAL_HOST` 로 조용한 노출** — `start.go:37-39`. 환경변수만으로 `0.0.0.0` 이 된다. 기동 출력에 "LAN 노출" 이 붙지만(`start.go:132-136`) 확인은 없다. → `--expose` 와 같은 확인 게이트를 적용. S
- **[P2] ACL fail-open** — `access.go:88-99`: `access.json` 이 깨지면 **끈 채로** 선다(FR-ACL-2 의 의도). `--expose` 상태에서는 깨진 파일 하나로 방어가 사라지므로 노출 모드에서는 fail-closed(loopback 만) 가 맞다. S
- **[P2] 정적 UI 에 보안 헤더 없음** — `static.go:51-68`: `X-Frame-Options`/`Content-Security-Policy`/`X-Content-Type-Options` 가 index·JS 에 없다(파일 raw SVG 에만 `nosniff`+`CSP: sandbox`, `handlers_file_probe.go:168-184`). 클릭재킹·인라인 스크립트 주입면. → `frame-ancestors 'self'`, `nosniff`, 최소 CSP. S

### 4.2 명령 주입 — 확인 결과와 잔여 (4)

확인된 안전 항목: git 은 `exec.CommandContext(bin, args...)` 배열 전달(`core/exec.go:152`), 하위 명령 화이트리스트(`guard.go:19-31, 98-119`), 전역 옵션 거부(`guard.go:102`), `--upload-pack`·`--exec-path`·`-o` 등 차단(`guard.go:35`), `RelPath` 의 `..`·절대경로·NUL 검사(`guard.go:157-191`), 원격 URL `-` 접두 거부(`write/remote.go:344`), 자격증명 마스킹 단일 규칙(`core/remote.go:22-30`), rg 는 `--fixed-strings` + `--` 구분(`handlers_fs_search.go:232-241`), `openUrl` 은 http/https 만(`openurl.go:51`). 셸 경유(`sh -c`)는 저장소 전체에서 **헤드리스 명령 하나**뿐이다(`shell.go:113-115`).

- **[P2] 헤드리스 `command` 는 설계상 셸 문자열** — `manager.go:416-419`. 인증이 서면 문제가 아니지만, 이 종단이 P0-2 의 가장 짧은 경로임을 기록한다. → P0 게이트 뒤로. (P0-2 에 포함)
- **[P2] `submodule.ExecGit`·`worktree.execGit` 은 화이트리스트 초크포인트를 지나지 않는다** — `server.go:392-402` 주석이 인정, `submodule.go:268-283`, `worktree.go:160-175`. worktree 는 `validRef`(`worktree.go:676-695`)가 이름을 걸러 준다. submodule 의 인자 조립은 이번 범위에서 전부 읽지 못했다(§6). → 두 실행기도 `guardCommon` 을 재사용. S
- **[P2] git `repo` 파라미터는 임의 절대경로** — `gitapi/handlers_git_write.go:354-384`: 핀 목록 대조 없이 `rev-parse --show-toplevel` 을 그 디렉터리에서 돈다. 디스크에 이미 심어진 저장소의 `core.fsmonitor`·`core.sshCommand` 같은 설정은 `git status`/`fetch` 로 실행될 수 있다(공격자가 파일을 쓸 수 있어야 하므로 전제가 강하다). → 핀된 루트 또는 Editor 루트 아래만 허용. S
- **[P2] 플러그인 설치 실행** — `ext/install.go:72-80` 셸 없이 실행, 매니페스트는 `https://` + `sha256` 필수(`ext/manifest.go:211-215`) — 좋다. 다만 매니페스트가 `$DONGMINAL_HOME/ext/plugins/` 의 **사용자 편집 가능 파일**이고 그 디렉터리가 Editor 에 노출된다(`server.go:163-168`). 실행할 `name/args` 가 매니페스트에서 오는지는 §6 미확인. S

### 4.3 시크릿·정보 노출 (3)

- **[P2] 오류 문자열을 그대로 응답에 싣는 곳** — `handlers_api.go:276` `http.Error(w, err.Error(), 500)`, `handlers_files.go:346, 385`, `handlers_api.go:335` 등. 내부 절대경로·시스템 오류가 새어 나간다. 로컬 도구라 낮지만 `--expose` 에서는 정찰 정보. → 코드화된 메시지 + 로그. S
- **[P2] 로그에 명령 전문** — `handlers_runs_headless.go`(`cmd=%q`), `[cmd] action=…`(`commands.go:183,199`). 에이전트 기동 명령에 토큰이 인자로 오면 로그에 남는다. `apiToolInput` 은 `textLen` 만 남긴다(`handlers_toolio.go:110-111`) — 그 규약을 따르면 된다. S
- **[P2] git 자격증명 취급은 양호** — `core/exec.go:200-224`: `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=`, `SSH_ASKPASS_REQUIRE=never`, URL userinfo 마스킹(`core/remote.go`). 리포지토리에 추적된 시크릿 없음(`git ls-files` 에 `.env`·키 파일 없음; `credentials_static_test.go` 는 테스트 코드). 기록만 한다.

### 4.4 입력 검증·DoS 잔여 (4)

- **[P2] `apiFileRead` 파일 크기 무제한** — `handlers_files.go:353-354` `io.Copy(w, f)`. 수 GB 파일을 지목하면 그대로 흘린다. diff 는 1MiB(`query/diff.go:37`), grep 2MiB(`handlers_fs_search.go:32`)로 상한이 있는데 이 종단만 없다. → 상한 + 413. S
- **[P2] zip 다운로드 2GiB × 동시 요청 무제한** — `handlers_fs_zip.go:33,104`. 하나는 상한이 있지만 동시성 상한이 없다. → 동시 zip 수 상한(세마포어). S
- **[P2] `settings.json` 본문 미검증** — `handlers_settings.go:90-95`: JSON 이 아니어도 저장한다. 다음 기동에서 프론트가 깨진다. → `json.Valid`. S
- **[P2] `apiUpload` 의 `dir` 상대경로 기본 `.`** — `handlers_files.go:177-188`: 서버 프로세스의 cwd 에 떨어진다(`safeResolve("/", ".")`). 기능이지 결함은 아니지만, cwd 가 어디인지 사용자가 모른다. `apiCwd` 가 `source:"server"` 를 알려 주는 것(`:307-323`)으로 부분 보완됨. 기록.

### 4.5 관측성 (4)

- **[P2] 웹서버 프로세스 자체를 감독하는 것이 없다** — `start.go:105-145` 는 자식으로 끊어 띄우고 `waitReady` 후 돌아온다. 데몬(`dongminald`)은 `toolclient/client.go:176-177` 이 재기동하지만, **웹서버가 죽으면 아무도 되살리지 않는다**(`recoverMiddleware` `server.go:262-280` 가 핸들러 패닉은 잡는다). launchd/systemd 유닛도 없다. → `dongminal service install`(launchd plist / systemd user unit 생성) 또는 데몬이 서버를 감독. M
- **[P2] 로그는 stdlib `log` 비구조화·단일 레벨** — `main.go:403` `log.SetFlags`. 레벨·필드·요청 ID 없음. 접근 로그 필터(`server.go:314-326`)와 진단 스냅샷(`diag_snapshot.go:56-62`, 60초마다 `reqAge/wsAge/ws/tools/goroutines/allocMB`)은 좋다. 로그 상한 64MB→8MB `.1` 보존(`logcap.go:15-21`) 있음. → `log/slog` 로 전환(표준 라이브러리, 의존 추가 없음), `DONGMINAL_LOG_LEVEL`. M
- **[P2] `daemon.log` 상한** — `main.go:131-137` 가 `$DONGMINAL_HOME/daemon.log` 에 append 하지만, `cli.WatchLogSize`(`main.go:553`) 가 자르는 대상은 서버 로그 경로 하나다(`logcap.go:92` 호출부). 데몬 로그는 무제한으로 보인다(§6 미확인 표기). S
- **[P2] 헬스·메트릭** — `/api/ping`(`handlers_api.go:354`)과 `dongminal health`(`health.go:19-49`: HTTP + 데몬 pid/소켓)는 있다. 메트릭 종단(도구 수·WS 수·goroutine·오류율)은 없고 diag 로그 한 줄에만 있다. → `/api/diag` JSON 으로 같은 값을 노출(로컬 전용). S

### 4.6 설정 관리 (2)

- **[P2] 설정 파일 스키마·버전 없음** — `access.json`(`access.go:41-45`), `settings.json`(서버가 해석 안 함, `handlers_settings.go:14`), `runs.json` 은 `schemaVersion:1`(`run/store.go:29`), `workspace.json` 은 2(`workspace/manager.go:35`). `workspace` 는 `SchemaVersion < 2` 만 거부한다(`manager.go:541`) — **더 새로운 판**(다운그레이드 시)은 조용히 읽는다. → 상위 버전 거부 또는 경고. S
- **[P2] 기본값은 안전** — 바인드 127.0.0.1, ACL 꺼짐(단 노출 시 위험, P1-1), 포트 범위 검증(`options.go:88-92`), `~` 확장(`options.go:126-133`), 홈 없이 진행 불가(`options.go:110-122`). `--isolated` 가 운영 인스턴스를 죽이지 않게 구조로 막은 것(`start.go:56-64`, `verify` 는 `--port/--home` 거부 `options.go:280-284`)은 좋다. 기록.

### 4.7 빌드·배포 공급망 (5)

확인: Go `1.24.0`(`go.mod:3`), 직접 의존 3개(`creack/pty`, `gorilla/websocket`, `x/sys`; `go.sum` 6줄), 버전은 `-ldflags -X dongminal/internal/ctl/cli.Version=$VERSION`(`scripts/build.sh:14-16`, 기본 `dev` `cli/version.go:20`), 릴리스 게이트가 3 OS 에서 `build/vet/test -race/doctor/verify`(`release.yml:34-57`), `SHA256SUMS` 생성(`release.yml:149`), 산출물 5종 누락 검사(`release.yml:142-147`), 워크플로 `permissions: contents: write`(`release.yml:25-26`).

- **[P2] 취약점 스캐너 없음** — `.github`·`scripts`·`package.json` 에 `govulncheck`/`gosec`/`staticcheck`/dependabot 없음(grep 0건). → `verify.yml` 에 `govulncheck ./...` 한 스텝 + dependabot(gomod, github-actions, npm). S
- **[P2] GitHub Actions 를 태그로 참조** — `actions/checkout@v5`, `setup-go@v6`, `upload-artifact@v6`, `download-artifact@v7`(`release.yml:42-43,88,130`, `e2e.yml:64-68`). 태그는 이동 가능하다. → 커밋 SHA 고정 + dependabot 갱신. S
- **[P2] 재현 가능 빌드 미설정** — `build.sh:88-89` 에 `-trimpath` 없음(빌드 경로가 바이너리에 들어가 러너마다 해시가 다르다), `-buildvcs` 기본. → `-trimpath -buildvcs=false` 또는 `=true` 고정. S
- **[P2] 체크섬 미서명** — `SHA256SUMS` 는 있으나 서명(cosign/GPG/SLSA provenance)이 없어 릴리스 계정 탈취 시 구별 불가. macOS 서명·공증 부재는 문서화됨(`README.md:24-26`). → `actions/attest-build-provenance` 또는 cosign keyless. M
- **[P2] `web/vendor` 제3자 JS 버전 추적 없음** — `xterm.js`·`highlight.js`·`markdown-it.js`·`purify.js` 등이 파일로 복사돼 있고(`web/vendor/`), 어느 버전인지 기록한 매니페스트가 저장소에 보이지 않는다(§6). → `web/vendor/VERSIONS.md` 또는 `package.json` 에 원본 버전·해시 기록. S

### 4.8 업그레이드·마이그레이션 (1) — 대체로 양호

- `workspace.json` v1→v2 는 `dongminal migrate`(`ctl/migrate/migrate.go`, 미지 필드 보존, `--dry-run`)로 옮기고, 서버는 구 스키마를 만나면 3단계 안내를 낸다(`main.go:496-503`). 자산 판은 JS/CSS 내용 해시 12자(`asset_version.go:36-70`)로 `index.html` 자리표시자와 SSE 인사 두 곳에 실려 프론트(`version-watch.js`)가 재로드를 판정한다 — 단일 진실 공급원 설계가 맞다. 데몬(`boot.Run(home, cli.Version)` `main.go:415`)과 서버의 판 불일치 감지는 §6 미확인.
- **[P2] 상위 스키마 다운그레이드 미감지** — 4.6 첫 항목과 동일. S

---

## 5. 양호한 점 (근거)

- 미들웨어 체인이 한 자리(`server.go:196-216`)라 게이트 추가가 쉽다 — P0 수정의 진입점.
- ACL 이 `RemoteAddr` 만 신뢰하고 프록시 헤더를 무시(`access.go:332-349`), 목록 내용을 403 본문에 싣지 않음(`access.go:375-376`), DNS 해석을 요청 경로 밖에서만(`access.go:188-239`).
- `/api/fs/*` 경로 가드는 심볼릭 링크를 실제로 푼다 — 실재 경로 `EvalSymlinks`(`handlers_fs.go:143`), 마지막 조각만 남기는 `fsResolveTarget`(`:155-165`), 업로드의 "실재하는 가장 깊은 조상" 검사(`:587-605`), 경계 판정을 접두가 아니라 조각으로(`:181-187`), 루트·홈·다른 루트 삭제 거부(`:609-632`), 이름 충돌 `O_EXCL`·`os.Link` 로 경합 제거(`:412-443`).
- git: 읽기·쓰기 초크포인트, 화이트리스트, 30초 마감·1MiB 출력 상한(`core/exec.go:17-21`), 기록 링버퍼, 자격증명 마스킹, `GIT_TERMINAL_PROMPT=0` 등 매달림 방지 환경(`core/exec.go:200-224`), 원격 작업은 프로세스 그룹으로 취소(`jobs/job.go:520-524`).
- 업로드 `MaxBytesReader` 가 `ParseMultipartForm` 앞에 서고 임시 파일을 거둔다(`handlers_files.go:109-130`).
- 패닉 그물이 SSE/WS 의 "이미 시작된 응답" 을 구분한다(`server.go:262-280, 328-353`).
- 재연결 폭주·미스 홀드 상한·로그 크기 상한 등 실제 사고에서 배운 방어가 코드에 남아 있다(`ws_miss.go`, `logcap.go`).
- 릴리스 산출물이 3 OS 게이트를 지나고 `verify` 가 격리 인스턴스만 겨눈다(`options.go:170-178, 280-284`).

---

## 6. 미확인 (이번 감사에서 코드로 확정하지 못한 것)

1. `submodule.Manager` 가 `ExecGit` 에 넘기는 인자 조립 전체 — 사용자 입력(경로·URL·브랜치)이 `-` 접두/옵션으로 해석될 여지가 있는지 (`domain/submodule/submodule.go` 앞부분 미열람).
2. `ext.Installer` 가 실행하는 `name/args` 가 매니페스트(사용자 편집 가능 파일)에서 오는지, 아니면 동봉 선언(`builtin.go:35`)에서만 오는지.
3. `daemon.log` 에 크기 상한이 적용되는지 — `WatchLogSize` 호출부(`main.go:553`)가 넘기는 경로가 서버 로그 하나로 보이나 `logcap.go` 나머지를 다 읽지 않았다.
4. `dongminald` ↔ 서버의 **버전 불일치 감지**(hello 교환에 판이 실리는지) — `toolclient/client.go`·`daemon/ipc/paned.go` 의 handshake 미열람.
5. `web/vendor` 라이브러리들의 정확한 버전과 알려진 취약점 여부.
6. `workspace.SchemaVersion > 2` 파일을 만났을 때의 동작(`manager.go:541` 은 `<` 만 본다 — 상위 판 처리 분기가 다른 곳에 있을 수 있음).
7. 샌드박스 `mounts` 정의(`sandbox/config.go`)가 `/`·`~/.ssh` 같은 민감 호스트 경로 마운트를 거부하는지.
8. Windows 의 AF_UNIX 소켓 ACL — POSIX 만 확인했다.

---

## 7. 권장 조치 순서

1. **P0-1 + P0-2 + P1-7 을 한 게이트로** — `Handler()` 에 Origin/Host/Sec-Fetch-Site/Content-Type 검사 미들웨어 + `CheckOrigin` 복원. 서버 측 반나절, 프론트 fetch 래퍼·`dmctl` 헤더 추가 반나절. 이 하나로 브라우저 매개 RCE 가 닫힌다.
2. **세션 토큰** — 기동 시 난수, `index.html` 치환 경로 재사용, `$DONGMINAL_HOME/token`(0600) 을 `dmctl` 이 읽음. P1-1 의 `--expose` 안전장치를 겸한다.
3. **P1-2·P1-3·P1-4** — 타임아웃 3줄, 공통 `readJSON(limit)`, `Create`/`Add` 상한. 하루.
4. **P1-6** — 홈 `0700`, 소켓 `0600`, 로그 위치·권한. 한 시간.
5. **P2 빌드 공급망** — `govulncheck` 스텝, 액션 SHA 고정, `-trimpath`, provenance. 한두 시간.
6. **P2 관측성** — `slog` 전환과 서비스 유닛 설치는 별도 SRS 로.
