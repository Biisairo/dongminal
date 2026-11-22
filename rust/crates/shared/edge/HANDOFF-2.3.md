# 인계: 이슈 2.3 (간선 기초 edge) — 착수 블록

이 문서는 맥락이 차서 다음 세션으로 넘기는 인계다. **review 전에 이 파일을 지우고 커밋한다.**

## 너는 누구이고 무엇을 하나

- 이슈 2.3 담당 에이전트. 이슈 원본: `/Users/dykim/personal/dongminal-rust/int/rust-port/issues/2.3-간선-기초.md` (상태는 **이 원본에만** 적는다. 지금 `status: in-progress`, owner 는 이전 탭 uuid `8290d275-…` — 네 탭 uuid 로 바꿔라)
- worktree `/Users/dykim/personal/dongminal-rust/2.3`, 브랜치 `rp/2.3`. 커밋은 직접 한다(사용자 허락). main 병합·push 금지
- 조정자 탭 uuid `37787b76-bd93-43c8-871c-f8c89c66afec`. 끝나면 이슈를 review 로 바꾸고 `dmctl msg --to 37787b76-bd93-43c8-871c-f8c89c66afec "2.3 review: <요약>"`
- 먼저 읽을 것: `int/rust-port/AGENT_RULES.md` 전부, `int/docs/internal/RUST_PORT_SRS.md` 의 C-RSP-1(특권 도우미 info 조회만 예외 허용), FR-RSP-3·6·7, 3.7 표(D-1~D-5 형식)
- 운영 보호: 시작·끝에 `rust/scripts/prod-pids.sh`(지금 `38173 start --foreground` / `58470 d --handover-fd`, 2.3 시작 때 이슈에 기록함). 바이너리·테스트는 `rust/scripts/hermetic.sh` 를 거친다(이제 툴체인 경로를 보존한다)

## 조정자 지시 (2.3 배정 메시지 요지)

TLS 는 rustls(ring)+rcgen, 인증서는 ECDSA P-256 PEM. 지문·edges.json 형식·접근 판정 문구가 Go 와 같아야 한다. **Go 노드와 TLS 로 실제 연결되는지(FR-RSP-23)를 격리 실행에서 시험하라.** 나누지 않는다(Go 약 1700줄). 보안 약점은 FR-RSP-6 에 따라 고치고 진행 기록과 조정자에게 알린다.

## 어디까지 왔나 (커밋 `0222b011`, WIP)

`rust/crates/shared/edge/` 에 Cargo.toml(의존성 추가 완료: base64 bytes dm-gocompat dmenv dmlog httpresp platform termtext hex http http-body-util hyper hyper-util p256 rand rcgen rustls serde sha2 subtle time tokio tokio-rustls x509-parser, dev: tempfile)과 다음 모듈 초안이 있다. **`lib.rs` 에 아직 연결하지 않았고 한 번도 컴파일하지 않았다.**

| 파일 | 내용 | 상태 |
|---|---|---|
| `addr.rs` | `parse_addr`(Go netip 흉내: IPv6 zone 허용, IPv4 zone 거절), `valid_addr`, `valid_port(i64)`, `valid_fingerprint`, `addr_rate_key`, 테스트(Go TestValidAddr·TestPairRateKey) | 초안 |
| `codes.rs` | `CODE_*` 18개, `CODES` | 초안 |
| `profile.rs` | `tag`, `handle`, 테스트(TestTag·TestHandle) | 초안 |
| `limit.rs` | `RateLimiter`(시계 `Clock = Box<dyn Fn()->OffsetDateTime+Send+Sync>`), 테스트 4개, `pub(crate) mod tests::FakeClock`(다른 모듈 테스트가 씀) | 초안 |
| `pairing.rs` | `Pairing`(new_invite·new_bound_invite·revoke·has_invite·invite_expires·redeem), `InviteCode{addr,port,fp,token}`, `encode_invite`/`decode_invite`(Go RawURLEncoding 흉내: `\r\n` 건너뜀·남는 비트 허용), 테스트(pairing_test·pairing_simple 의 Redeem 계열·mesh_store TestBoundInvite) | 초안 |
| `error.rs` | `Error` enum, Display = Go 문구 | 초안 |
| `config.rs` | `Edge`·`Config`(필드 순서 Go 와 같음, port 는 i64), `Store`(open·config·save·pin_helper·set_node·set_name·is_edge·resolve·can_add·add_edge·remove·set_address·apply_hello·set_pending_all·set_pending·path), `valid_name`·`default_name`·`display_name`·`valid_display_name`·`migrate_legacy_files`, `go_lower`·`equal_fold`, 깨진 파일 비켜 두기(`.bad-20060102T150405.000000000Z`). 끝에 `#[path = "config_tests.rs"] mod tests;` — **config_tests.rs 는 아직 없다** | 초안 |

## 남은 일 (이 순서로)

1. `lib.rs` 를 쓴다(모듈 선언·재수출). 컴파일·clippy 를 통과시킨다. rand 0.10 의 `rand::fill` 존재, `rcgen`·`p256` API 는 실제 소스(`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`)로 확인한다.
2. `config_tests.rs`: Go `config_test.go`·`profile_test.go`(OpenStore 이하)·`pairing_simple_test.go`(TestLoadDropsLegacyPending·TestAddEdgeNamesMayRepeat·TestResolveByPrefix)·`mesh_store_test.go`(TestApplyHello·TestPendingPersists)·`migrate_test.go`·`edge_limit_test.go` 를 같은 입력·기대값으로 옮긴다. TestStoreSaveAndReload 는 Go json.Marshal 비교 → gocompat marshal 로 비교. 저장 파일이 Go `json.MarshalIndent(c,"","  ")` 바이트와 같은지 직접 확인하는 시험도 둔다(helperKey·pending omitempty).
3. `identity.rs`: Go `identity.go` 포팅.
   - 생성: ECDSA P-256 키, 자기 서명, serial 128비트 난수(양수), Subject/Issuer CN=`dongminal node` 만, NotBefore=now-1h, NotAfter=NotBefore+87600h, KeyUsage DigitalSignature(critical), ExtKeyUsage serverAuth+clientAuth, BasicConstraints CA:FALSE. rcgen 은 기본 DN(`rcgen self signed cert`)을 비워야 한다.
   - 키 파일은 **`EC PRIVATE KEY`(SEC1)** PEM, 0o600. 인증서 `CERTIFICATE` PEM, 0o644. 키를 먼저 쓰고, 인증서 쓰기가 실패하면 키를 지운다. 쓰기 함수는 시험이 바꿀 수 있게 한다(Go `writeIdentityFile`).
   - 둘 다 있으면 읽기, 하나만 있으면 오류 `노드 인증서와 키 중 하나만 있습니다 (%s, %s) — 둘 다 지우면 새 신원을 만듭니다`. 망가진 파일은 덮어쓰지 않는다. 읽기 오류 문구 `노드 인증서를 읽지 못했습니다: <tls 문구>`(Go: `tls: failed to find any PEM data in certificate input` 등, `tls: private key does not match public key`).
   - 지문 = SHA-256(SPKI 원시 바이트) 소문자 hex (x509-parser `subject_pki.raw`).
   - PEM 해석은 직접(허용 목록에 rustls-pemfile 없음). Go `tls.X509KeyPair` 처럼 키는 `PRIVATE KEY`(PKCS8)와 `EC PRIVATE KEY`(SEC1)를 받는다. rustls ring 은 `PrivateKeyDer::Sec1` 을 읽는다(확인함).
   - 키·인증서 일치 검사: p256 SecretKey 의 공개키와 인증서 SPKI 비교.
4. `tls.rs`: rustls 설정.
   - 서버: TLS 1.3 전용, 클라이언트 인증서 필수(`ClientCertVerifier`: 체인 검증 없이 서명만 `rustls::crypto::verify_tls13_signature` 로 검증하고 지문을 `Admission.tls` 로 판정, 거절이면 오류 → alert). **세션 재개를 끈다**(session_storage=NoServerSessionStorage, send_tls13_tickets=0). Go 는 재개 때도 VerifyConnection 으로 다시 거르는데, rustls 는 재개 때 verifier 를 부르지 않으므로 재개 자체를 막는 것이 같은 결과다(Go TestListenerRevokedEdgeOnResumedSession).
   - 클라이언트: TLS 1.3, 자기 인증서 내밈, `ServerCertVerifier` 가 지문 고정(불일치는 식별 가능한 오류 → `FingerprintMismatch`), 서명은 검증.
5. `listener.rs`: Go `listener.go`.
   - `Admission { tls: Fn(&str)->bool, request: Fn(fp,path)->bool }`, `edges_only(is_edge)`.
   - 핸들러 형태는 이 crate 가 정한다(다른 crate 에 정해진 것 없음): `Arc<dyn Fn(http::Request<hyper::body::Incoming>) -> BoxFuture<httpresp::Response>>` 꼴. 클라이언트 지문은 요청 extensions 에 실어 `client_fingerprint(&req)` 로 꺼낸다.
   - 요청마다 다시 거른다: 거절은 403, `Connection: close`, 본문 Go `json.Marshal(map{"code":"edge_not_edge","message":"간선이 아닌 노드입니다"})` 를 `httpresp::fail_raw`.
   - `apply(&Config)`: (enabled,bind,port) 키가 같고 상태가 맞으면 아무것도 안 함. 열기 실패는 `Status.err` 에 사유. `Status{listening, addr, err, generation}`(JSON `listening`, `addr,omitempty`, `error,omitempty`, generation 은 직렬화 안 함). `use_listen`(데몬이 노드 소켓을 듣게 하는 훅 — 2.4 가 쓴다). `close()` 뒤 apply 는 열지 않는다.
   - 시한: TLS 핸드셰이크 10s(Go 는 ReadHeaderTimeout 등의 최소값), hyper http1 `header_read_timeout(10s)`+`timer(TokioTimer)`, `max_buf_size` 로 헤더 16KiB(+4096 여유), 핸들러 `WriteTimeout`=RequestTimeout+5s=20s, `title_case_headers(true)`. hyper 의 header_read_timeout 은 keep-alive 대기에도 걸린다(소스 확인) → Go IdleTimeout 120s 보다 엄격하지만 Go 간선 클라이언트는 keep-alive 를 끄므로 관측 차이 없음. 진행 기록의 "Go 와 다르게 한 결정"에 적는다.
   - 핸드셰이크 실패 로그 묶음(`handshakeLog`, 1분 창, `edge listener: TLS handshake failure count=1 (<줄>)` 그리고 창 끝 `count=N within 1m0s (최근: ...)`). Go 줄 형식은 `http: TLS handshake error from <addr>: <err>`. after 함수 주입 가능하게(TestHandshakeLogAggregates).
6. `client.rs`: `Target{addr,port,fingerprint}`, `Client::new(id)`, `Client::via(id, dial)`(2.4 가 dial.sock 로 쓴다), `call(target, path, &in, out)`: JSON POST(`Content-Type: application/json`), 전체 15s, dial 5s, 핸드셰이크 5s, keep-alive 없음, **리다이렉트 안 따라감**, 응답 1MiB 상한. 오류: `FingerprintMismatch`(`상대 노드의 지문이 기대와 다릅니다`), `Rejected`(`상대 노드가 이 노드를 받지 않았습니다` — rustls 에서 alert 수신 = Go "remote error"), `Unreachable(detail)`(`상대 노드에 닿지 못했습니다: <detail>`), `Remote(RemoteError{status,code,message})`(`상대 노드가 거절했습니다 (%d %s): %s`, code·message 는 termtext strip 후 512바이트 cut). 비 2xx 본문이 `{code,message}` 가 아니거나 code 가 비면 403→Rejected, 그 밖은 RemoteError(code "", message=본문 정리).
   - **detail 문구는 Go `*url.Error` 꼴(`Post "https://h:p/path": dial tcp …`)이어야 하는데, 그 도구는 이슈 1.6(진행 중, dm-gocompat)이 만든다. 직접 만들지 말고 detail 을 만드는 함수 하나로 모아 두고 진행 기록·조정자에게 "1.6 완료 후 교체" 를 알린다.**
7. `upgrade.rs`: `Client::upgrade(target, path, proto)`(TLS 위에 GET + `Connection: Upgrade` + `Upgrade: proto`, 101 이고 Upgrade 헤더가 proto 와 대소문자 무시 같으면 버퍼 남은 바이트를 잃지 않는 연결 반환, 아니면 remote_failure). `accept_upgrade(req, proto)`: GET·Connection 토큰 upgrade·Upgrade==proto 아니면 400 `{code:"bad_request",message:"upgrade required"}` + `Connection: close`(httpresp::fail_code). 성공이면 101 `Connection: Upgrade`·`Upgrade: <proto>` 와 hyper::upgrade 로 얻은 연결. hyper 는 101 에 Date 를 붙인다(Go 원시 101 에는 없음) — 알려진 차이로 진행 기록에.
8. 테스트: Go `client_test.go`·`upgrade_test.go`·`listener_test.go`·`identity_test.go` 를 옮긴다(Rust 클라이언트로). TLS1.2 거절, 인증서 없음 거절, 재개 거절(세션 캐시 있는 rustls 클라이언트로 두 번째 연결이 거절되는지).
9. **상호 운용 시험(FR-RSP-23)** — 진짜 Go 바이너리로, 격리 실행에서:
   - Go 참조: `rust/scripts/hermetic.sh go build -o rust/target/go-ref/dongminal ./cmd/dongminal` (go1.27.2 인지 `go version`).
   - 격리 홈에 `edges.json`(enabled:true, bind 127.0.0.1, port ≥60147, edges 에 Rust 쪽 지문·주소·포트)을 써 두고 `start --foreground --port <≥60147>` 로 띄운다. Go 의 지문은 홈의 `edge-cert.pem` 에서 읽는다(Rust identity 로 파싱 → Go 인증서 읽기 호환도 검증).
   - ① Rust Client → Go 노드 포트: 간선이면 403 이 아닌 응답(경로 아무거나), 간선이 아닌 Rust 신원이면 `Rejected`. ② Go → Rust Listener: Go 데몬이 간선(주소 있음)에 mesh 연결 `GET /edge/v1/link` + `Upgrade: dmlink1` 을 건다 → Rust 리스너 핸들러가 Go 지문으로 받는지 확인.
   - 정리: serve 자식 TERM, 홈의 `paned.pid` 데몬(실행 파일 확인 후). 포트는 60147 이상. `dm-parity` 의 runner(0.2·0.3 산출)를 참고하거나 `#[ignore]`/환경변수 게이트 시험으로 둔다(`DM_PARITY_GO_BIN` 처럼).
10. 게이트: `cargo fmt --all --check`, `cargo clippy -p dm-shared-edge --all-targets -- -D warnings`, `rust/scripts/hermetic.sh cargo test -p dm-shared-edge`, windows·linux 대상 `cargo check`/clippy. `cargo deny`·advisories 는 새 의존성(p256·rcgen·x509-parser)이 들어가므로 가능하면 확인.
11. 이 HANDOFF 파일 삭제, 커밋 `port(2.3): …`, 이슈 진행 기록(공개 API 요약, 옮긴 테스트 수, Go 와 다른 결정, 남은 위험, 끝 prod-pids), review, 조정자 알림.

## 값을 치르고 배운 것

- Go 문자열 함수 흉내: `strings.ToLower` 는 글자 단위(Rust `str::to_lowercase` 의 끝 시그마 규칙과 다름) → `config::go_lower`. `strings.TrimSpace` = 유니코드 White_Space = Rust `char::is_whitespace`.
- `edges.json` 읽기: 바깥 `edges` 가 임베드 Config 의 `edges` 를 가린다. `edges` 키가 없거나 null 일 때만 옛 키 `peers`. `state` 가 비지 않은 항목은 버린다. 저장은 `fillDefaults(c, Config{})`(빈 기본값!) 뒤 validate — 그래서 포트 0·bind 빈 값은 저장 오류다.
- Go `netip.ParseAddr` 는 IPv6 zone 을 받는다(bind 검증·rate key). Rust std 는 zone 을 모른다 → `addr::parse_addr`.
- base64: Go 디코더는 `\r\n` 을 건너뛰고 남는 비트를 보지 않는다.
- 로그 문구의 OS 오류는 `dm_gocompat::oserr::{path_error, link_error, go_error_string}` 로 Go 꼴을 낸다.
- `dmlog::info(None, &msg, &[])` 꼴. `httpresp::{fail_raw, fail_code, json}` 이 `httpresp::Response`(=`http::Response<BoxBody>`)를 만든다. `httproute` 는 핸들러 모양을 정하지 않는다.
- 0.2·0.3 교훈: 격리 Go 서버의 `start` 는 포트를 쥔 프로세스를 종료한다 → 쓰기 전에 포트가 비었는지 확인. 소켓 경로(`<home>/paned.sock`)는 103바이트 이하여야 하므로 격리 뿌리는 짧게. 격리 데몬은 특권 도우미에 `info` 를 묻는다(허용됨).
- 시험이 "두 쪽 다 실패해서 같다"가 되지 않게, 상호 운용 시험은 성공 경로를 직접 단언한다.
