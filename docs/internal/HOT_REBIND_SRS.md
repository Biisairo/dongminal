# SRS: 포트·expose 의 실행 중 변경 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 묶음 D·R·U (묶음 S 는 구현·시험 완료)
> **입력**: 2026-11-18 사용자 요청 "포트 동적 변경 및 expose 동적 변경도 가능한지" 와 인터뷰. 결정은 §5 에 있다.
> **선행**: `CONFIG_MANAGEMENT_SRS`(설정 계층), `REQUEST_GATE_SRS`·`REQUEST_GATE_ORIGIN_PORT_SRS`(Host·Origin 판정), `DAEMON_SESSION_KEEP_SRS`(세션은 데몬이 쥔다)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

서버를 끄지 않고 포트와 expose(바인드 주소)를 바꾼다. 바꾼 값은 `server.json` 에 남아 서버·데몬을 다시 올려도 유지된다. 이미 열린 셸의 `dmctl` 과 열린 브라우저 화면도 새 주소를 따라간다.

### 1.2 범위 (Scope)

| 묶음 | 이름 | 요구 |
|---|---|---|
| **묶음 S** | 기준 하나 (Source) — 포트·호스트는 `server.json` 만 정한다 | `FR-HRB-1..8` |
| **묶음 D** | 주소 찾기 (Discovery) — 도구 셸·샌드박스가 지금 주소를 파일로 안다 | `FR-HRB-10..15` |
| **묶음 R** | 리바인드 (Rebind) — 실행 중인 서버가 리스너를 갈아 끼운다 | `FR-HRB-20..31` |
| **묶음 U** | 바꾸는 길 (UI·CLI) | `FR-HRB-40..45` |

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 말 | 뜻 |
|---|---|
| **바인드** | 서버가 리슨하는 `호스트:포트` |
| **expose** | 호스트가 `0.0.0.0` 인 상태. 아니면 `127.0.0.1` 이다 |
| **리바인드** | 서버 프로세스를 끄지 않고 바인드를 바꾸는 일 |
| **주소 파일** | `$DONGMINAL_HOME/server.addr`. 지금 리슨하는 바인드 한 줄 |
| **이사** | 포트가 바뀔 때 열린 화면이 새 주소로 옮겨 가는 일 |

### 1.4 참조 (References)

- `CONFIG_MANAGEMENT_SRS` FR-CFG-13~15, §6-3 — 이 문서가 바꾼다(§3.1, D-HRB-1·5)
- `ACCESS_ALLOWLIST_SRS` — expose 때의 접근 허용 목록
- `internal/shared/serverconf/conf.go` `Resolve`, `internal/ctl/cli/start.go`, `internal/ctl/cli/service.go`, `cmd/dongminal/app.go`, `internal/webserver/httpapi/server.go` `Run`, `internal/helper/runtimebin/http.go` `baseURL`, `internal/shared/sandboxplace/wire.go`

## 2. 현재 상태 (조사로 확정한 사실, 2026-11-18)

1. 바인드는 기동값이다. `Server.Run` 이 `ListenAndServe` 를 한 번 부르고, 실행 중에 바꾸는 길이 없다.
2. 기동값은 플래그 > 환경 변수(`PORT`·`DONGMINAL_PORT`·`DONGMINAL_HOST`) > `server.json` > 기본값 순서다(`serverconf.Resolve`).
3. 서버는 자기 포트·호스트를 환경 변수에 넣는다(`app.go:55`). 데몬은 그 서버의 자식이라 물려받고, 모든 셸은 데몬에게서 다시 물려받는다. `dmctl` 은 이 환경 변수로 서버를 찾는다(`runtimebin/http.go:22`). 그래서 **서버만 다른 포트로 다시 띄우면 기존 셸과 이후 새 셸의 `dmctl` 이 모두 옛 포트로 보낸다.** 데몬을 새로 띄워야 바로잡힌다.
4. launchd plist·systemd 유닛은 포트·호스트를 환경 변수로 박는다(`service.go:160·193`). 서비스로 뜨면 파일의 값이 진다.
5. 샌드박스 컨테이너의 `dmctl` 은 데몬이 기동 때 읽은 포트로 `host.docker.internal` 에 붙는다(`sandboxplace/wire.go:41`).
6. e2e 는 워커마다 `PORT` 환경 변수로 서버를 띄운다(`e2e/fixtures.ts:267`).
7. 화면 설정 일부는 브라우저 `localStorage` 에 있고, 이것은 출처(포트 포함)마다 따로다.

## 3. 요구사항 (Requirements)

### 3.1 묶음 S — 기준 하나

**FR-HRB-1** 포트와 호스트는 `server.json` 의 `port`·`host` 만 정한다. 환경 변수 `PORT`·`DONGMINAL_PORT`·`DONGMINAL_HOST` 는 바인드를 정하지 않는다(D-HRB-1).

**FR-HRB-2** 기본값(`127.0.0.1`, 기본 포트)은 `server.json` 이 없거나, 읽지 못하거나, 그 키가 없거나 틀렸을 때만 쓴다. 파일이 깨져도 기동을 막지 않는다(FR-CFG-15 승계).

**FR-HRB-3** `dongminal start --port N`·`--expose` 는 그 값을 `server.json` 에 쓴 뒤 그 값으로 뜬다(D-HRB-2). `--expose` 를 주지 않은 `start` 는 파일의 호스트를 그대로 쓴다 — expose 를 끄는 길은 FR-HRB-41·42 다.

**FR-HRB-4** `--isolated` 는 임시 홈의 `server.json` 에 고른 포트를 쓴다. 사용자 홈의 파일은 건드리지 않는다.

**FR-HRB-5** `start` 가 백그라운드 서버를 띄울 때 바인드를 환경 변수로 넘기지 않는다. 자식은 `server.json` 을 읽는다.

**FR-HRB-6** `dongminal service install` 이 만드는 plist·systemd 유닛은 바인드 환경 변수를 넣지 않는다. 이미 설치된 서비스는 다음 `service install` 때 고쳐진다. `start`·`health` 는 설치된 서비스 파일에 바인드 환경 변수가 남아 있으면 경고 한 줄을 낸다.

**FR-HRB-7** `stop`·`health`·`window` 의 대상 해석도 같은 규칙을 쓴다 — 플래그, 없으면 주소 파일, 없으면 `server.json`, 없으면 기본값.

**FR-HRB-8** 환경 변수 `DONGMINAL_HOST`·`DONGMINAL_PORT`·`PORT` 가 설정돼 있으면 `start` 는 "바인드를 정하지 않는다, `server.json` 이나 플래그를 쓴다" 는 경고를 한 번 낸다.

### 3.2 묶음 D — 주소 찾기

**FR-HRB-10** 서버는 리슨에 성공할 때마다(기동·리바인드) 주소 파일 `$DONGMINAL_HOME/server.addr` 에 `host:port` 한 줄을 원자적으로 쓴다. 권한은 `0600` 이다. 정상 종료 때 지운다.

**FR-HRB-11** 서버는 자기 바인드를 환경 변수에 넣지 않는다(`app.go:55·56` 삭제). 데몬과 셸이 옛 값을 물려받지 않게 한다.

**FR-HRB-12** `dmctl` 등 도우미는 서버 주소를 이렇게 찾는다: 주소 파일 → `server.json` → 기본값. 주소 파일의 호스트가 `0.0.0.0` 이면 `127.0.0.1` 로 붙는다. 요청마다 다시 읽는다(파일 하나, 수십 바이트).

**FR-HRB-13** 샌드박스 컨테이너에는 주소 파일을 읽기 전용으로 바인드 마운트한다(고정 경로). 컨테이너의 `dmctl` 은 그 파일의 포트와 호스트 게이트웨이(`host.docker.internal`)로 붙는다. 마운트할 파일이 없으면 지금처럼 기동 때의 포트를 쓴다.

**FR-HRB-14** 옛 셸(이 변경 전 데몬이 띄운 셸)에 남은 `DONGMINAL_PORT` 는 읽지 않는다. 주소 파일이 이긴다.

**FR-HRB-15** 주소 파일은 경계가 아니다. 접근 통제는 지금처럼 Host·Origin 게이트와 허용 목록이 한다.

### 3.3 묶음 R — 리바인드

**FR-HRB-20** 서버는 새 로컬 API `POST /api/server/bind` 를 둔다. 본문은 `{port?: number, expose?: boolean}` 이고 빠진 값은 지금 값을 쓴다.

**FR-HRB-21** 이 API 는 **루프백 출발지**의 요청만 받는다(expose 상태에서도). 아니면 `403 bind_local_only` 다. Host·Origin 게이트(FR-RQG)는 그대로 지난다.

**FR-HRB-22** 바뀌는 것이 없으면 `200` 과 지금 바인드로 답하고 아무것도 하지 않는다.

**FR-HRB-23** **포트가 바뀌면** 다음 순서로 한다. 어느 단계든 실패하면 그 앞의 일을 되돌리고 오류로 답한다. 옛 바인드는 그대로다.

1. 포트 범위(1024~65535)를 본다. 아니면 `400 bind_port_invalid`.
2. 새 바인드로 리슨한다. 이미 쓰이면 `409 bind_port_in_use`.
3. Host·Origin 허용 집합에 새 포트를 더한다. 옛 포트는 유예가 끝날 때까지 남긴다.
4. `server.json` 과 주소 파일을 새 값으로 쓴다.
5. 새 리스너에서 같은 핸들러로 서빙을 시작한다.
6. 열린 화면에 SSE `server_moving {url, token}` 을 보낸다(FR-HRB-26).
7. `200 {url}` 으로 답한다.
8. **유예**(30초) 동안 옛 리스너도 서빙한다. 유예 동안 옛 주소의 문서 요청(`GET /`)은 새 주소로 `307` 이다. 유예가 끝나면 옛 리스너를 닫고 허용 집합에서 옛 포트를 뺀다.

**FR-HRB-24** **포트는 그대로이고 expose 만 바뀌면**, 같은 포트를 다시 묶어야 하므로 옛 리스너를 닫고 곧바로 새 호스트로 리슨한다. 새 리슨이 실패하면 옛 호스트로 다시 리슨하고 `409 bind_rebind_failed` 로 답한다. 출처가 바뀌지 않으므로 이사하지 않는다 — 열린 화면은 끊긴 연결을 다시 붙는다.

**FR-HRB-25** 포트와 expose 가 함께 바뀌면 FR-HRB-23 을 새 호스트·새 포트로 한다.

**FR-HRB-26** **이사**: `server_moving` 을 받은 화면은
1. 자기 `localStorage` 를 `POST /api/server/carry` 로 서버에 맡긴다(같은 출처, 본문 상한 1 MiB). 서버는 일회용 토큰을 답한다.
2. `{url}/?carry=<토큰>` 으로 이동한다.
3. 새 주소의 화면은 기동 때 `carry` 가 있으면 `GET /api/server/carry/<토큰>` 으로 받아 `localStorage` 에 넣고, 주소에서 `carry` 를 지운다.

토큰은 한 번 쓰면 사라지고, 60초 뒤에도 사라진다. 서버 메모리에만 있다.

**FR-HRB-27** 리바인드는 한 번에 하나다. 진행 중이면 `409 bind_busy` 다.

**FR-HRB-28** 리바인드는 데몬·도구·간선 노드 포트를 건드리지 않는다. 터미널 세션은 끊기지 않는다(WebSocket 은 이사 뒤 새 주소에서 다시 붙는다).

**FR-HRB-29** expose 를 켜는 리바인드는 응답과 로그에 "인증이 없다 — 허용 목록을 켜라" 경고를 싣는다(`--expose` 의 기존 경고와 같은 문구).

**FR-HRB-30** 리바인드 결과(이전 바인드, 새 바인드, 사유)를 로그에 남긴다.

**FR-HRB-31** 직접 모드(데몬 없음)에서도 같다 — 리바인드는 서버 프로세스 안의 일이다.

### 3.4 묶음 U — 바꾸는 길

**FR-HRB-40** Settings 에 **Server** 구역을 둔다: 포트 입력, expose 켜기/끄기, "적용" 버튼. 지금 바인드와 출처(파일·기본값)를 보인다. 적용하면 확인 대화상자를 거쳐 FR-HRB-20 을 부른다.

**FR-HRB-41** CLI `dongminal config set port <N>`·`dongminal config set expose on|off` 를 둔다. 서버가 돌고 있으면 FR-HRB-20 을 부르고, 돌고 있지 않으면 `server.json` 만 고친다.

**FR-HRB-42** CLI `dongminal config get` 은 지금 바인드(주소 파일)와 `server.json` 의 값을 함께 보인다.

**FR-HRB-43** 화면과 CLI 는 FR-HRB-23·24 의 오류 코드를 사람 말로 보인다.

**FR-HRB-44** 리바인드가 끝나면 Settings 의 Server 구역은 새 값을 보인다(이사한 새 화면).

**FR-HRB-45** 오류 코드(`bind_*`)는 `apierr` 카탈로그에 등록하고 `errors.md` 를 다시 만든다.

### 3.5 비기능 (Non-functional)

**NFR-HRB-1** 포트 변경 요청부터 새 주소가 요청을 받기까지 1초를 넘지 않는다.

**NFR-HRB-2** expose 만 바꿀 때 리슨하지 않는 틈은 100ms 를 넘지 않는다.

**NFR-HRB-3** `dmctl` 의 주소 찾기는 요청마다 파일 하나를 읽는 것 이상을 하지 않는다.

## 4. 검증 (Verification)

사용 중인 서버·데몬은 건드리지 않는다. 모든 시험은 임시 홈과 빈 포트에서 돈다. e2e 는 이번에도 돌리지 않는다(사용자가 정할 때까지).

| 시험 | 요구 | 내용 |
|---|---|---|
| TC-HRB-1 | FR-HRB-1·2·8 | 유닛 — `Resolve` 가 바인드 환경 변수를 무시하고 경고한다. 파일 없음·깨짐·키 없음은 기본값 |
| TC-HRB-2 | FR-HRB-3·4 | 유닛 — `start --port`·`--expose` 가 `server.json` 에 쓰고, `--isolated` 는 임시 홈에만 쓴다 |
| TC-HRB-3 | FR-HRB-6 | 유닛 — 서비스 파일에 바인드 환경 변수가 없다. 남은 서비스 파일을 경고한다 |
| TC-HRB-4 | FR-HRB-10·11 | 유닛 — 리슨·리바인드마다 주소 파일이 바뀐다(`0600`). 종료 때 지운다. 서버가 바인드 환경 변수를 넣지 않는다 |
| TC-HRB-5 | FR-HRB-12·14 | 유닛 — `dmctl` 주소 찾기 순서. 옛 `DONGMINAL_PORT` 를 무시한다. `0.0.0.0` → `127.0.0.1` |
| TC-HRB-6 | FR-HRB-13 | 유닛 — 샌드박스 실행 명세에 주소 파일의 읽기 전용 마운트가 있다 |
| TC-HRB-7 | FR-HRB-20~23·27 | 유닛(실제 리스너) — 포트 변경: 새 포트가 받고, 옛 포트는 유예 동안 `GET /` 를 `307` 로 보내고, 유예 뒤 닫힌다. 쓰이는 포트·범위 밖·진행 중은 각 코드로 거절되고 옛 바인드가 그대로다 |
| TC-HRB-8 | FR-HRB-24 | 유닛 — expose 만 바꾸면 같은 포트로 다시 리슨한다. 실패를 주입하면 옛 호스트로 돌아간다 |
| TC-HRB-9 | FR-HRB-21 | 유닛 — 루프백이 아닌 출발지는 `403 bind_local_only` |
| TC-HRB-10 | FR-HRB-26 | 유닛 — carry 토큰은 한 번만, 60초 안에만 쓰인다. 1 MiB 상한 |
| TC-HRB-11 | FR-HRB-26·40·44 | JS 단위 — `server_moving` 을 받으면 맡기고 이동한다. `carry` 로 되넣고 주소에서 지운다 |
| TC-HRB-12 | FR-HRB-41·42 | 유닛 — `config set` 이 서버가 있으면 API 를, 없으면 파일을 고친다 |

## 5. 설계 결정 (Design Decisions)

**D-HRB-1 바인드의 기준은 `server.json` 하나다.** 환경 변수는 바인드를 정하지 않는다. 화면·CLI 로 바꾼 값이 다음 기동에서 환경 변수·서비스 파일에 지는 일을 없앤다. (사용자 결정, 2026-11-18)

**D-HRB-2 기동 플래그는 `server.json` 에 저장한다.** 플래그·화면·CLI 가 같은 길로 같은 파일을 고친다. (사용자 결정)

**D-HRB-3 바꾸는 길은 Settings UI 와 CLI 둘이다.** 둘 다 같은 로컬 API 를 부른다. (사용자 결정)

**D-HRB-4 포트가 바뀌면 열린 화면은 화면 설정을 들고 새 주소로 이사한다.** 옛 포트는 30초 유예 뒤 닫는다. (사용자 결정)

**D-HRB-5 재시작 없는 리바인드다.** 서버 재시작으로도 세션은 남지만(데몬이 PTY 를 쥔다), 사용자가 프로세스 안의 리바인드를 골랐다. (사용자 결정)

**D-HRB-6 셸은 주소를 파일로 찾는다.** 셸의 환경 변수는 바꿀 수 없다 — 이미 뜬 프로세스의 환경은 밖에서 고칠 수 없다. 파일은 바꿀 수 있다.

**D-HRB-7 리바인드 API 는 루프백만 받는다.** expose 상태에서 같은 망의 누군가가 바인드를 바꾸면(예: expose 를 켜 둔 채 포트를 옮겨 허용 목록 밖으로 빠지는 일) 사용자가 잠긴다.

**D-HRB-8 expose 만 바꿀 때는 닫고 다시 연다.** 같은 포트를 두 호스트로 동시에 묶을 수 없다(`127.0.0.1:P` 와 `0.0.0.0:P` 는 충돌한다). 틈은 짧고(NFR-HRB-2), 실패하면 되돌린다.

## 6. 비목표 (Non-goals)

- 로그 수준·로그 파일의 환경 변수 계층(`DONGMINAL_LOG_LEVEL`·`DONGMINAL_LOG`). 바인드만 바꾼다.
- 간선 노드 포트의 실행 중 변경.
- TLS·인증. 영구 제외다(로드맵 결정 9).
- 여러 바인드에 동시에 리슨하기(유예 중의 옛 포트를 빼고).

## 7. 위험 (Risks)

| | 위험 | 등급 | 대응 |
|---|---|---|---|
| R-1 | 환경 변수를 쓰던 사용 방식(스크립트·e2e·서비스)이 깨진다 | MEDIUM | FR-HRB-8 경고, FR-HRB-6 서비스 갱신, e2e·스크립트를 `--port` 로 바꾼다 |
| R-2 | 이사 도중 화면이 닫히면 `localStorage` 가 새 주소로 오지 않는다 | LOW | 옛 주소의 `localStorage` 는 남는다. 다시 옛 포트로 오면 그대로 있다 |
| R-3 | expose 를 켠 채 포트를 옮기면 같은 망에 새 포트가 열린다 | MEDIUM | FR-HRB-29 경고, 허용 목록(ACCESS_ALLOWLIST)은 그대로 적용된다 |
| R-4 | 유예 동안 두 포트가 열려 있다 | LOW | 30초로 짧고 같은 게이트를 지난다 |
| R-5 | 이 변경 전 데몬이 띄운 셸에는 `DONGMINAL_PORT` 가 남는다 | LOW | 주소 파일이 이긴다(FR-HRB-14) |
