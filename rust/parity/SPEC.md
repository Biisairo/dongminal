# dm-parity 요구사항 명세

- 문서 형식: ISO/IEC/IEEE 29148:2018 SRS (축약판)
- 상위 문서: `docs/internal/RUST_PORT_SRS.md` V-RSP-2, FR-RSP-3, FR-RSP-31, C-RSP-1
- 이슈: `rust-port/issues/0.2-차분-실행기와-e2e-바이너리-경로.md`
- 요구사항 접두어: `FR-PAR-n`, `C-PAR-n`, `V-PAR-n`

## 1. 소개

### 1.1 목적

이 문서는 차분 실행기 `dm-parity` 와 e2e 바이너리 경로 수정의 요구사항을 정한다. `dm-parity` 는 같은 시나리오를 Go 참조 바이너리와 Rust 바이너리에 각각 격리 실행으로 돌리고, 관측 표면을 비교한다.

### 1.2 범위

포함한다.

- Rust 코드로 쓰는 시나리오 API 와 시나리오 등록부
- CLI 출력·종료 코드, HTTP 응답, 홈 파일의 수집과 비교
- 시나리오별 정규화 규칙
- 실행 진입점 `dm-parity` 바이너리와 `rust/parity/run.sh`
- e2e `globalSetup` 의 `DM_E2E_PREBUILT_BIN` (FR-RSP-31)

포함하지 않는다.

- WebSocket·SSE·IPC 소켓 비교. 이 표면은 해당 기능을 포팅하는 이슈가 필요할 때 단계 종류를 더한다.
- 서버 로그(stderr) 비교. 로그는 FR-RSP-3 의 비교 대상이 아니다.

### 1.3 정의

| 용어 | 뜻 |
|---|---|
| 쪽(side) | 한 시나리오를 돌리는 바이너리 하나. `go` 와 `rust` 두 쪽이 있다 |
| 쪽 뿌리 | 한 쪽 실행마다 새로 만드는 임시 디렉터리. 그 아래에 `home`(HOME), `dmhome`(DONGMINAL_HOME), `bin` 을 둔다 |
| 관측값 | 단계 하나가 남긴 이름 붙은 바이트열. 예: `stdout`, `exit`, `status`, `header:content-type`, `body`, `file:<경로>` |
| 정규화 | 비교 전에 관측값에서 실행마다 바뀌는 값을 고정 토큰으로 바꾸는 것 |

## 2. 요구사항

### 2.1 시나리오

- **FR-PAR-1** 시나리오는 Rust 코드로 정의한다. 시나리오는 이름, 담당 이슈 ID, 단계 목록, 비교할 홈 파일 목록, 정규화 규칙 목록을 갖는다. YAML 해석기는 허용 목록(`DEPENDENCIES.md`)에 없으므로 쓰지 않는다.
- **FR-PAR-2** 단계 종류는 다음과 같다.
  1. `run` — CLI 를 한 번 실행한다. 인자, 추가 환경변수, stdin, argv[0] 이름(multi-call 헬퍼용), 제한 시간을 줄 수 있다. 관측값: `stdout`, `stderr`, `exit`.
  2. `write_home` — 쪽의 DONGMINAL_HOME 아래에 파일을 만든다(시나리오 준비용). 관측값이 없다.
  3. `serve` — 서버를 백그라운드로 띄우고, 준비 경로가 HTTP 응답을 줄 때까지 기다린다. 관측값: 준비 성공 여부(`ready`).
  4. `http` — 띄운 서버에 HTTP/1.1 요청을 보낸다. 관측값: `status`, 비교 대상 헤더, `body`.
- **FR-PAR-3** 인자·환경변수 값·HTTP 경로·홈 파일 내용에서 `{home}`, `{root}`, `{port}` 자리표시를 쪽마다의 실제 값으로 바꾼다.
- **FR-PAR-4** 모든 단계와 정리(C-PAR-4)가 끝나면 시나리오가 지정한 홈 파일의 내용(`file:<경로>`, 없으면 `<absent>`)을 관측값으로 더한다. 시나리오가 홈 트리 비교를 켜면 DONGMINAL_HOME 아래 파일 경로 목록(`home-tree`)도 더한다. 트리 비교는 시나리오가 준 제외 접두어를 뺀다.

### 2.2 격리 (C-RSP-1)

- **C-PAR-1** 쪽마다 새 쪽 뿌리를 만든다. 자식 프로세스의 환경에서 `DONGMINAL_*` 와 `DM_E2E_*` 를 모두 지우고 `HOME`, `DONGMINAL_HOME` 을 쪽 뿌리 아래로, `DONGMINAL_NO_UPDATE_CHECK=1` 로 둔다.
- **C-PAR-2** `{port}` 는 60147 이상에서 고른다. 시작 값은 `DM_PARITY_PORT_BASE`(기본 60400)이며, 60147 미만이면 실행을 거절한다. 고를 때 그 포트에 연결이 되거나(누가 쥐고 있으면) 같은 프로세스가 이미 내준 포트면 다음 번호로 넘어간다. Go `start` 는 포트를 쥔 프로세스를 종료하므로 이 검사가 필요하다.
- **C-PAR-3** 시나리오 인자에 `--port N`(또는 `--port=N`)이 있고 N 이 60147 미만이면 시나리오를 실행하지 않고 오류로 보고한다.
- **C-PAR-4** 정리할 때 끄는 프로세스는 두 가지뿐이다. ① 실행기가 `serve` 로 띄운 자식 PID ② 쪽 DONGMINAL_HOME 의 `paned.pid` 가 가리키는 PID 중, 그 프로세스의 실행 파일 경로가 이 쪽 바이너리와 같은 것. 이름으로 프로세스를 찾지 않는다.
- **C-PAR-6** 쪽 뿌리는 짧은 이름으로 만든다. `{home}/paned.sock` 경로가 103바이트를 넘으면(macOS `sun_path` 한도) 실행 전에 오류를 낸다.
- **C-PAR-7** argv0 가 서버에 요청할 수 있는 헬퍼(`dmctl` `edit` `detach` `open-url`)인 `run` 단계는 같은 시나리오의 앞에 `serve` 단계가 있어야 한다. 헬퍼는 격리 홈에 주소 파일이 없으면 기본 포트로 붙기 때문이다. argv0 `claude`(진짜 claude 를 실행하는 셈)와 `dongminald` 는 시나리오에 넣지 못한다. 어기면 시나리오를 실행하지 않고 오류로 보고한다.
- **C-PAR-5** 운영 바이너리(`/Users/dykim/personal/dongminal/dongminal`)나 `~/.dongminal` 아래 경로를 쪽 바이너리로 받으면 실행을 거절한다.

### 2.3 정규화

- **FR-PAR-10** 기본 정규화는 언제나 적용한다. 쪽의 DONGMINAL_HOME → `<HOME>`, HOME → `<USERHOME>`, 쪽 뿌리 → `<ROOT>`, 쪽 바이너리 경로 → `<BIN>`, 쪽 포트 → `<PORT>`. 경로는 그대로의 값과 정규 경로(macOS `/private/var` 등) 둘 다 바꾼다. 포트는 앞뒤가 숫자가 아닐 때만 바꾼다.
- **FR-PAR-11** 시나리오는 규칙을 더할 수 있다. 정규식 치환(`regex`), 문자열 치환(`literal`), 기성 규칙(`rfc3339` 시각, `uuid`, `pid_after` — 주어진 접두어 뒤의 10진수). 규칙은 선언한 순서대로 모든 관측값에 적용한다. 규칙은 특정 관측값 이름에만 적용하도록 좁힐 수 있다.

### 2.4 HTTP

- **FR-PAR-20** HTTP 요청은 `127.0.0.1:{port}` 로 보내며 `Connection: close` 를 붙인다. 응답 본문은 `Transfer-Encoding: chunked` 면 풀고, 아니면 `Content-Length` 만큼 또는 연결이 닫힐 때까지 읽는다.
- **FR-PAR-21** 비교하는 헤더는 `Content-Type`, `Cache-Control`, `Location`, `Set-Cookie`, `Access-Control-*`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, `Cross-Origin-*`, `WWW-Authenticate`, `Vary` 와 시나리오가 더한 이름이다. 헤더 이름은 대소문자를 가리지 않고, 값은 바이트로 비교한다. 같은 이름이 여럿이면 받은 순서대로 모두 비교한다. `Date` 는 있는지만 비교한다. `Content-Length`·`Transfer-Encoding` 은 전송 방식이므로 비교하지 않는다.

### 2.5 비교와 보고

- **FR-PAR-30** 두 쪽의 관측값 목록을 (단계 번호, 관측값 이름) 순서로 맞대어, 정규화한 바이트가 다른 것마다 차이 하나를 보고한다. 한쪽에만 있는 관측값도 차이다.
- **FR-PAR-31** 차이 보고에는 시나리오 이름, 단계 번호와 설명, 관측값 이름, 처음 다른 줄 번호, 그 줄의 두 쪽 값(이스케이프), 두 쪽 길이를 넣는다.
- **FR-PAR-32** 실행 오류(바이너리 실행 실패, 제한 시간 초과, 서버 준비 실패)는 관측값(`error`)으로 남겨 비교한다. 두 쪽이 같은 이유로 실패하면 차이가 아니다.

### 2.6 진입점

- **FR-PAR-40** `dm-parity --go <경로> --rust <경로> [--issues <이슈 폴더>] [--only <이름>]... [--list] [--keep]` 은 등록된 시나리오를 돌린다. 시나리오마다 `ok`·`DIFF`·`PEND` 중 하나를 찍고, 끝에 `<N>개 중 같음 a, 다름 b, 보류 c` 를 찍는다. 다름이 없으면 종료 코드 0, 있으면 1, 사용법·설정 오류면 2 다. `--list` 는 이름과 담당 이슈를 탭으로 나눠 찍는다. `--keep` 은 쪽 뿌리를 지우지 않고 경로를 찍는다. `--issues` 가 없으면 환경변수 `DM_PARITY_ISSUES` 를 쓴다.
- **FR-PAR-42** 담당 이슈의 상태는 이슈 폴더의 `*.md` 머리말(`id`, `status`)에서 읽는다. 차이가 있고 담당 이슈의 상태가 `done` 이 아니면 그 시나리오는 보류(`PEND`)이고 다름으로 세지 않는다. 시나리오 오류, 담당 이슈가 없는 시나리오의 차이, 담당 이슈를 폴더에서 찾지 못한 시나리오의 차이는 다름이다. 선택한 시나리오에 담당 이슈가 있는데 이슈 폴더가 주어지지 않으면 종료 코드 2 다.
- **FR-PAR-41** `rust/parity/run.sh` 는 Go 참조 바이너리를 `rust/target/go-ref/dongminal` 에 만들고(저장소 루트에 만들지 않는다), Rust 바이너리를 `cargo build -p dongminal` 으로 만든 뒤, `rust/scripts/hermetic.sh` 아래에서 `dm-parity` 를 돌린다. 이슈 폴더는 `DM_PARITY_ISSUES` 가 있으면 그것, 없으면 `<저장소>/rust-port/issues` 다. 인자는 `dm-parity` 에 넘긴다.

### 2.7 e2e 바이너리 경로 (FR-RSP-31)

- **FR-PAR-50** `e2e/global-setup.ts` 는 `DM_E2E_PREBUILT_BIN` 이 비어 있지 않으면 `go build` 대신 그 경로의 파일을 `E2E_BIN` 으로 복사하고 실행 권한(0755)을 준다. 비어 있거나 없으면 지금과 똑같이 `go build` 한다. 경로의 파일이 없으면 복사 오류로 실패한다.

## 3. 검증

- **V-PAR-1** 단위 테스트: 정규화(기본·기성·사용자 규칙, 범위 좁히기), HTTP 응답 해석(chunked, Content-Length, 닫힘까지), 헤더 선택, 차이 보고 형식, 포트 거절.
- **V-PAR-2** 통합 테스트(unix): 가짜 바이너리(셸 스크립트) 두 개로 같음·다름(stdout, 종료 코드, 홈 파일)을 판정하고, 자식 환경의 격리(C-PAR-1)를 확인한다.
- **V-PAR-3** 자기 검증: `DM_PARITY_GO_BIN` 이 있으면 등록 시나리오 전부를 Go 대 Go 로 돌려 차이가 없고 정리 뒤 데몬이 남지 않아야 한다. 또 Go 쪽 관측값이 시나리오의 의도와 맞아야 한다: `error` 관측값이 없고 서버 준비가 `ok`, `cli-*-args` 의 종료 코드는 모두 2, `cli-*-help` 는 모두 0 이고 stdout 이 비어 있지 않음, `helper-*` 의 종료 코드는 0 또는 2.
- **V-PAR-4** 목록 검사: 등록 시나리오는 모두 검증(`validate`)을 통과하고, 이름이 겹치지 않으며, 담당 이슈가 `rust-port/issues` 에 있다.
- **V-PAR-5** 표면 목록: `rust/parity/SURFACE.md` 의 모든 항목에 담당 이슈가 있다.
