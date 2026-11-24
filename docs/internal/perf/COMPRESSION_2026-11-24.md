# 채널 압축 조사·측정 — 2026-11-24

> 상위: `docs/internal/PERF_OPTIMIZATION_SRS.md` FR-CON-9 · D-11 · `perf/CHANNEL_PROTOCOL.md` A-C1
> 조사용 코드는 저장소 밖(`/private/tmp/otter-zip-spike/`)에 두었고 커밋하지 않았다.

## 1. 결론

- **권장 crate: `yawc` 0.5** (`default-features = false`). 표준 permessage-deflate 를 지원하고, 연결마다 압축을 켜고 끌 수 있으며, 압축 여부와 상관없이 **스트림 타입이 하나**다. 실제 Chromium 과 붙여 압축 협상과 텍스트·바이너리 왕복을 확인했다(§3).
- **설정: context takeover 켬, 압축 단계 기본(6), 최소 압축 크기 임계값 없음.** 원격 주소일 때만 압축을 제안한다(FR-CON-9).
- **사용자 결정이 하나 필요하다: yawc 의 라이선스는 MPL-2.0 이다.** 지금 `rust/deny.toml` 허용 목록에 없다. 쓰려면 `notify`·`xxhash-rust` 처럼 그 crate 에만 예외를 연다. MPL-2.0 은 파일 단위 copyleft 라서, yawc 파일을 고치지 않고 쓰기만 하면 우리 코드에는 의무가 생기지 않는다.

## 2. 후보 비교

| crate (판, 갱신일) | 라이선스 | permessage-deflate | 연결마다 켜고 끄기 | context takeover 설정 | 메시지 상한 | 읽기·쓰기 분리 | ping/pong | 비고 |
|---|---|---|---|---|---|---|---|---|
| **yawc** 0.5.0 (2026-10-22, 95만 내려받기) | MPL-2.0 | 있다 | 있다 — `upgrade_with_options(req, Options)`, `without_compression()` | 있다 — `server_no_context_takeover()` 등 | `with_max_payload_read` | `futures::Stream`/`Sink` 구현 → `split()`, 전용 `ReadHalf`/`WriteHalf` 도 있다 | 프레임으로 올라온다 | 압축 임계값(`with_compression_threshold`)도 있다. 창 크기 조정은 `zlib` 기능을 켜야 한다 |
| sockudo-ws 3.1.1 (2026-11-04, 18만) | MIT | 있다 | 된다 — 다만 압축 없는 `WebSocketStream` 과 압축 있는 `CompressedWebSocketStream` 이 **서로 다른 타입**이다 | 있다 | 있다 | 있다(두 타입이 각자) | 있다 | 원격·로컬을 나누면 두 갈래 코드가 생긴다. "같은 일을 두 벌 두지 않는다"(D-11)에 어긋난다. 브라우저 시험은 하지 않았다 |
| tokio-tungstenite 0.30 (지금 쓰는 것) | MIT | **없다** | — | — | 있다 | 있다 | 있다 | 헤더 파싱 시험에 이름만 나온다 |
| tokio-websockets 0.13 | MIT | 없다 | — | — | — | — | — | 탈락 |
| fastwebsockets 0.10 | Apache-2.0 | 없다 | — | — | — | — | — | 탈락 |

## 3. 브라우저 확인 (yawc + Chromium)

시험 서버(hyper 1 + `WebSocket::upgrade_with_options`)에 Playwright Chromium 으로 두 번 붙었다. 한 번은 압축을 켜서, 한 번은 꺼서 붙었다.

| 연결 | 응답 `Sec-WebSocket-Extensions` | 브라우저 `ws.extensions` | 텍스트 왕복 | 바이너리 3 B 보내기 | 바이너리 100 KB 받기 |
|---|---|---|---|---|---|
| 압축 켬 | `permessage-deflate` | `permessage-deflate` | 됨 | 됨 | 됨 |
| 압축 끔 | 없음 | 빈 문자열 | 됨 | 됨 | 됨 |

→ 같은 서버 코드에서 연결마다 `Options` 하나로 원격 압축을 켜고 끌 수 있다.

## 4. 측정 — 압축률과 CPU

- 방법: `scripts/perf/agent-sim.py` 의 출력을 30초 떴다(초당 60줄, 5초마다 몰아치기). 파이프 read 한 번을 메시지 하나로 보았다.
- 실제 텍스트 표본으로는 저장소의 색 입힌 `git log -p` 2.3 MB 를 썼다.
- 압축은 Rust `flate2`(yawc 와 같은 miniz 백엔드)로 했다. RFC 7692 대로 메시지마다 sync flush 를 하고, 꼬리 4바이트를 뗐다. CPU 는 5회 중 가장 빠른 값이다(M4).
- 비율은 압축 후 크기 ÷ 원래 크기다. 작을수록 좋다.

| 표본 (메시지 평균) | 독립 L6 (no takeover) | **takeover L6** | takeover L1 | 독립 L1 |
|---|---|---|---|---|
| 줄 출력 (153 B, 30초 229 KB) | 0.60 · 77 ms/MB | **0.26 (3.8배) · 39 ms/MB** | 0.36 · 14 ms/MB | 0.64 · 51 ms/MB |
| TUI 출력 (2 KB, 30초 1.1 MB) | 0.26 · 10 ms/MB | **0.15 (6.7배) · 24 ms/MB** | 0.25 · 3 ms/MB | 0.31 · 6 ms/MB |
| 실제 diff, 4 KB 조각 | 0.31 · 11 ms/MB | **0.20 (5.0배) · 16 ms/MB** | 0.28 · 5 ms/MB | 0.34 · 5 ms/MB |
| 실제 diff, 64 KB 조각 | 0.20 · 9 ms/MB | **0.19 (5.3배) · 11 ms/MB** | 0.27 · 5 ms/MB | 0.28 · 3 ms/MB |
| JSON workspace full (3.6 KB, 창 5×탭 3) | 0.11 | **0.11 (8.8배)** | 0.14 | 0.14 |
| JSON activity delta (295 B × 200) | 0.67 | **0.07 (13.4배)** | 0.08 | 0.67 |

읽는 법:
- **메시지가 작을수록 context takeover 의 몫이 크다.** 작은 메시지는 혼자 압축하면 거의 줄지 않는다(delta 0.67, 줄 출력 0.60). 앞 메시지를 사전으로 쓰면 13배까지 준다. 채널의 메시지는 대부분 수백 B~수 KB 다.
- agent-sim 은 낱말이 적은 흉내라 실제보다 잘 줄어든다. 실제 diff 표본은 takeover L6 에서 5배다. 실제 에이전트 출력은 **4~6배**로 보면 된다.

### 4.1 원격에서 실제로 얼마나 줄어드나

| 상황 | 압축 없음 | takeover L6 | 서버 CPU (압축) |
|---|---|---|---|
| 보이는 에이전트 3개, TUI | 113 KB/초 | 약 17 KB/초 | 약 2.7 ms/초 (코어 하나의 0.3%) |
| 보이는 에이전트 3개, 줄 출력 | 23 KB/초 | 약 6 KB/초 | 약 0.9 ms/초 |

### 4.2 스냅숏 500 KB (M2 의 "화면 + 기록 5천 줄" 흉내) 전송 시간

| 내용 | 압축 후 | 2 Mbps (압축 없음 → 있음) | 10 Mbps (압축 없음 → 있음) | 압축 CPU |
|---|---|---|---|---|
| 실제 diff 텍스트 | 94 KB (5.3배) | 2.0 초 → **0.37 초** | 0.40 초 → **0.08 초** | 약 5 ms |
| TUI 흉내 | 68 KB (7.4배) | 2.0 초 → **0.27 초** | 0.40 초 → **0.05 초** | 약 11 ms |

## 5. 메모리

| 대상 | 크기 (flate2 miniz, 창 15비트) |
|---|---|
| 압축기 하나 (서버 → 브라우저, takeover 면 연결 내내 산다) | 약 262 KB |
| 해제기 하나 (브라우저 → 서버) | 약 48 KB |
| **원격 채널 하나** | **약 310 KB** |

압축은 원격 채널에만 켠다. 그리고 채널은 브라우저 탭마다 하나다. 그래서 원격 탭 10개여도 3 MB 남짓이다. 로컬 채널에는 0 이다.

## 6. 권장 설정과 근거

| 항목 | 권장 | 근거 |
|---|---|---|
| crate | yawc 0.5, `default-features = false` (TLS 기능 끔) | 표준 방식이라 브라우저 쪽 코드가 0줄이다. 타입이 하나라 원격·로컬이 같은 코드를 지난다(D-11) |
| 압축 제안 | 루프백이 아닌 주소만 | 로컬은 대역폭 한계가 없어 CPU 만 쓴다(FR-CON-9) |
| context takeover | 켬 (기본값) | 채널 메시지는 작다. 끄면 delta 가 1.5배밖에 안 준다. 켜면 13배다. 대가는 원격 채널당 약 310 KB 다 |
| 압축 단계 | 기본(6) — `with_balanced_compression()` | L1 보다 TUI 에서 1.6배 더 준다. 원격 물량에서는 CPU 가 코어 하나의 1% 미만이다 |
| 최소 압축 크기 임계값 | 두지 않음 (0) | takeover 를 켜면 작은 프레임도 잘 준다. 임계값은 takeover 를 끌 때나 의미가 있다 |
| 메시지 상한 | `with_max_payload_read(1 MB)` | 지금 `CHANNEL_READ_LIMIT` 와 같다 |

## 7. 위험과 남은 일

- **라이선스**: MPL-2.0 → `deny.toml` 예외가 필요하다(사용자 결정).
- **의존성 중복**: yawc 가 `rand 0.8` 을 끌어온다. 워크스페이스는 0.10 이라 `multiple-versions = "warn"` 경고가 하나 늘어난다. `nom 8`·`crossbeam-queue`·`pin-project`·`sha1` 이 새로 들어온다.
- **성숙도**: 0.x 이고 한 조직이 관리한다. tungstenite 보다 사용자가 훨씬 적다. API 가 바뀔 수 있으므로 판을 고정한다.
- **우리 서버에 붙이는 자리**: 우리 핸들러는 hyper `Request` 대신 자체 `Req` 를 받는다. 길은 둘이다.
  1. `Req` 에서 hyper `Request` 를 만들어 `upgrade_with_options` 를 부른다.
  2. 핸드셰이크 응답은 지금처럼 우리가 만들고 `WebSocket::from_stream_with_extensions(io, Role::Server, 합의한 확장 문자열, Options)` 를 부른다. 이 경우 확장 합의(클라이언트 제안 파싱) 몇 줄을 우리가 갖는다.

  C6 착수 때 둘 중 하나를 시험으로 고른다.
- **"두 벌" 정리 범위**: 서버에서 tungstenite 를 쓰는 곳은 채널(`channel/mod.rs`), LSP(`lsp_api.rs`), 옛 `/ws`(C6 에서 사라짐), `toolhub/conn.rs`(`SafeConn`), `hub/replyseat.rs`, 그리고 시험의 WebSocket 클라이언트다. D-11 대로 하나로 맞추려면 이 전부를 yawc 로 옮긴다. yawc 는 클라이언트도 된다.
- **압축 부채널(CRIME 류)**: 같은 압축 문맥에 비밀(터미널에 찍힌 토큰 등)과 공격자가 고를 수 있는 내용이 섞이면, 망 관찰자가 암호문 크기로 비밀을 추측할 수 있다. 원격 경로(Tailscale/WireGuard)는 암호화돼 있다. 공격하려면 출력 내용을 조종하면서 크기를 반복해서 관찰해야 하므로 현실 위험은 낮다고 본다. 기록해 둔다.
- 측정은 흉내 출력과 diff 표본으로 했다. M2 뒤 `scenario.mjs` remote 단계에서 실제 채널 바이트로 다시 잰다.
