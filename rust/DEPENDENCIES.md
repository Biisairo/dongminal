# 외부 crate 허용 목록 (RUST_PORT_SRS C-RSP-3)

기준: 널리 쓰이고, 유지보수가 계속되며, RustSec 권고에 걸리지 않는다. 맞는 crate 가 없으면 직접 구현한다.
목록에 없는 crate 를 더하려면 이 문서와 루트 `Cargo.toml` 의 `[workspace.dependencies]` 를 같은 커밋에서 고치고, 이슈의 진행 기록에 이유를 적는다.
crate 의 Cargo.toml 에서는 언제나 `foo = { workspace = true }` 로 참조한다. 버전을 crate 에 직접 적지 않는다.

| 용도 | crate | 비고 |
|---|---|---|
| 비동기 런타임 | tokio, tokio-util, futures-util, bytes | |
| HTTP 서버 | hyper, hyper-util, http, http-body-util, axum, tower | 라우팅이 Go ServeMux 와 달라지면 hyper 위에 직접 구현한다 |
| HTTP 클라이언트 | reqwest(rustls-no-provider) | TLS 공급자는 rustls 의 ring |
| WebSocket | tokio-tungstenite | gorilla/websocket 대응 |
| TLS·인증서 | rustls(ring), tokio-rustls, rcgen(ring), x509-parser | aws-lc·openssl 금지 (deny.toml) |
| 암호 | sha1, sha2, hmac, hkdf, ed25519-dalek, p256, aes-gcm, subtle, rand | Go crypto/* 대응 |
| 인코딩 | serde, serde_json(preserve_order), base64, hex, data-encoding, percent-encoding, url, encoding_rs | Go JSON 규칙은 otter-gocompat 에서만 흉내 낸다 |
| 시간 | time | Go time 형식과 로컬 시간대는 otter-gocompat(`time::local`)으로 얻는다. unix 는 Go 처럼 `TZ`·zoneinfo 를 읽고, Windows 는 Go 처럼 `GetTimeZoneInformation` 을 부른다. chrono 는 유지보수 중단(RUSTSEC-2026-0543)이라 쓰지 않는다 |
| 압축·아카이브 | flate2, zip(deflate), tar | |
| 파일 감시 | notify | fsnotify 대응 |
| OS | libc, nix(unix), windows-sys(windows), socket2 | `unsafe` 는 C-RSP-4 범위에서만. socket2 는 Go `net.Listen` 의 이중 스택 리슨(IPV6_V6ONLY 명시)에만 쓴다. tokio·hyper-util 이 이미 끌어오는 crate 다(Cargo.lock 0.6.5) |
| 정규식 | regex | |
| 터미널 에뮬레이터 | alacritty_terminal(`=0.26.0`) | 데몬 화면 상태(D-13). `otter-shared-termstate` 한 crate 에서만 쓴다. 판 올림은 비교 시험(`termstate/testdata`)을 다시 돌린 뒤에 한다 |
| 유니코드 정규화 | icu_normalizer | Go `golang.org/x/text/unicode/norm` 대응(NFC). url→idna 가 이미 끌어오는 crate 다. 정규화는 이것 하나만 쓴다(fswatch·claudeacct) |
| 자산 임베드 | rust-embed | `web/` 임베드 |
| 테스트 전용 | tempfile | dev-dependencies 에서만 |

금지: openssl-sys, native-tls, aws-lc-sys, git 소스 의존, 와일드카드 버전.
