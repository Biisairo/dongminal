# 13 — 전송 보호(TLS)와 secure context 확보 경로

- 범위: read-only 사실 조사. 코드 무수정.
- 겹침 회피: `04 §1 P1-1`(무인증 노출), `04 §5`(ACL 설계 양호), `07 §1`(인증·TLS 묶음, `G1-5`), `08 결정 8`(노출 시 평문 허용) 은 재보고하지 않고 ID 로만 참조한다.

## 개정 이력

| 판 | 전제 | 결과 |
|---|---|---|
| 1판 | 원격 접속 = Tailscale, 단일 사용자 | S4(`tailscale serve`) 기본 + S2(`tailscale cert`) 권장 |
| **2판(현행)** | **Tailscale 을 설계 전제로 삼지 않는다**(사용자: *"tailscale 을 사용하지만 … 없다고 생각하는게 맞음"*). **`--expose` 가 기본 경로**(사용자: *"--expose 가 여전히 기본 경로"*) | **앱 내장 로컬 CA(`P1`) 기본 + 사용자 제공 인증서(`P4`) 병행.** Tailscale 경로는 "지원되는 배치 중 하나" 로 강등 |

1판의 철회 항목은 §8 에 사유와 함께 남긴다.

---

## 0. 직답 (2판)

**질문이 바뀌었다.** 1판의 질문("TLS 가 Tailscale 을 깨는가")은 **아니오**로 답이 났고 그 결론은 유지된다(§3). 2판의 실질 질문은 이것이다:

> **공인 도메인 없이, `--expose` 로 사설/LAN IP 에 직접 바인딩하면서, 어떻게 secure context 를 확보하는가.**

**답: 앱이 로컬 CA 를 직접 발급하고, 사용자가 접속할 기기마다 CA 인증서를 1회 설치한다.** Go 표준 라이브러리(`crypto/x509`·`crypto/tls`)만으로 구현되며 신규 런타임 의존이 없다. 이것이 유일하게 **(a) 공인 도메인 불요 (b) 인터넷 도달성 불요 (c) 브라우저 동작이 명세로 보장됨 (d) 외부 서비스 의존 0** 을 동시에 만족하는 경로다.

핵심 근거 — **W3C Secure Contexts 명세는 인증서 유효성을 보지 않는다. 스킴만 본다:**

> "If origin's scheme is either `https` or `wss`, return **Potentially Trustworthy**."

그리고 이 조사에서 확인한 결정적 구분:

| | 인증서 오류 | secure context |
|---|---|---|
| **자체 서명 + 예외 승인**(`P3`) | **남는다** — 브라우저가 "주의 요함" 유지, Chrome 은 인증서 오류 페이지에 **별도 차단**을 거는 전례가 있다(ServiceWorker 등록 실패, Chromium 40423989) | 명세상 true. **실측 필요**(§9) |
| **로컬 CA 설치 후**(`P1`·`P2`) | **없다** — 정상 HTTPS 와 구별되지 않는다 | **보장된 true.** 불확실성 없음 |

→ 자체 서명을 "예외 승인해서 쓰는" 것과 "CA 를 신뢰 저장소에 넣는" 것의 차이가 이 판정 전체를 가른다. **비용 차이는 작고(설치 1회 vs 승인 1회) 보장 차이는 크다.**

---

## 1. **[TLS-1 / P1] 현행 평문 배치에 이미 존재하는 결손 — 데스크톱 알림이 원격에서 조용히 죽어 있다**

> 2판에서 **더 중요해졌다.** `--expose` 가 기본 경로로 확정됐으므로 이 결손은 "일부 사용자의 문제" 가 아니라 **기본 경로의 문제**다.

### 사실

`http://<사설IP>:58146` 은 secure context 가 **아니다**. W3C 명세의 potentially trustworthy origin 은 `https`·`wss` 스킴, `127.0.0.0/8`·`::1/128`, `localhost`/`*.localhost`, `file:` 뿐이다. `192.168.x`·`10.x`·`100.64.0.0/10` 어디에도 해당하지 않는다.

### 코드 전수 조사 (`web/` 전체, vendor 포함)

| API | 사용처 | secure context 밖 | 폴백 |
|---|---|---|---|
| `navigator.clipboard.writeText` | `web/js/ui/term-clipboard.js:76-77` (OSC 52) | 객체 없음 | **있음** — `_execCopy`(`:114-130`) → 복사창(`:138-195`). FR-ETR-40 3단 설계 |
| `navigator.clipboard.writeText` | `web/js/git/panel-poll.js:81-82` | 없음 | **있음** — `_copyFallback`(`:92`) |
| `navigator.clipboard.writeText` | `web/js/core/app-tool.js:110-111` | 없음 → `catch{}` 조용히 실패 | **없음.** 명령 문자열이 `<code>` 로 화면에 남아 수동 선택 가능(`:106-108`) |
| **`Notification`** | `web/js/core/app-attn.js:363, 371, 419-420, 433-436` | **API 자체가 노출되지 않음** (MDN: *"available only in secure contexts (HTTPS)"*) | **없음** |
| `document.execCommand('copy')` | `git/confirm.js:312`, `git/dialog.js:378`, `term-clipboard.js:126,169`, `panel-poll.js:92` | 동작 | — |
| `AudioContext` (알림음) | `app-attn.js:385` | **동작**(secure context 불요) | — |
| `crypto.subtle`·ServiceWorker·`getUserMedia`/`mediaDevices`·`navigator.storage`·Geolocation·`share`·`credentials`·`bluetooth`·`usb`·`serial`·`hid`·PushManager·`wakeLock`·File System Access·IdleDetector | **사용처 0** | — | — |
| xterm.js 붙여넣기 | `web/vendor/xterm.js` — `clipboardData`(네이티브 paste)만, `navigator.clipboard` 미사용 | 동작 | — |

### 판정 — 조용한 실패가 본질이다

- **클립보드는 이미 방어돼 있다.** `term-clipboard.js:12-13` 주석이 상황을 정확히 적는다: *"`navigator.clipboard.writeText` — secure context 에서만 존재한다. **원격 접속은 `http://100.x` 라 여기서 이미 없다.**"* TLS 가 들어오면 3단이 1단으로 회귀해 UX 가 개선되지만, 없다고 기능이 죽지는 않는다.
- **데스크톱 알림은 방어돼 있지 않고, 기본값이 켜짐이다.** `app.js:314` — `get attnDesktop(){ ... localStorage.getItem('attnDesktop')!=='0' ... }` → **미설정이면 `true`**. 즉:
  1. 원격 사용자는 **아무 설정도 하지 않은 상태에서 이미 "데스크톱 알림 켜짐"** 이다.
  2. `app-attn.js:363` 의 `typeof Notification==='undefined'` 가드에서 즉시 `return` → 알림이 뜨지 않는다.
  3. `:419` 의 권한 요청도 `typeof Notification!=='undefined'` 가 false 라 실행되지 않고, `:433` 의 첫 상호작용 훅도 서지 않는다.
  4. 그런데 `:421` 의 `this.attnDesktop=dt.checked` 는 조건 **밖**이라 토글은 켜진 채 남고, `app-backup.js:19` 가 그 값을 백업·복원까지 한다.
  5. **어디에도 "이 환경에서는 동작하지 않는다"는 표시가 없다.**
- 화면 안 알림(배지·attn 센터 `_attnRefresh`, 사운드)은 정상 동작한다. 죽는 것은 **"브라우저 밖에 있을 때 알려 준다"** 는 부분이며, 그것이 원격 작업에서 값이 가장 큰 부분이다.
- **로컬(`localhost`)에서는 secure context 라 정상 동작한다 → 개발 중에는 절대 드러나지 않는다.**

### 부수 확인 — `wss://` 전환 비용 0

`web/js/ui/term-pane.js:460` `const p=location.protocol==='https:'?'wss:':'ws:';` / `:463` `` `${p}//${location.host}/ws?...` ``. 스킴·호스트를 `location` 에서 파생한다. 저장소 전체의 유일한 ws 리터럴이고 SSE·fetch 는 전부 상대 경로다.
→ **프론트엔드 TLS 전환 수정 = 0줄.**

---

## 2. 코드 측 사실

### 2-1. TLS 코드 0줄
`internal/webserver/httpapi/server.go:220` `srv := &http.Server{Addr: addr, Handler: s.Handler()}` / `:230` `srv.ListenAndServe()`. 저장소 전체 `crypto/tls`·`TLSConfig`·`ListenAndServeTLS` 매치 0.

### 2-2. 바인딩
`internal/ctl/cli/start.go:36-42`:
```go
host := DefaultHost                       // dmenv.go:56 = "127.0.0.1"
if v := os.Getenv(EnvHost); v != "" {     // dmenv.go:46 = "DONGMINAL_HOST"
    host = v
}
if o.Expose {
    host = ExposeHost                     // options.go:44 = "0.0.0.0"
}
```
- `DONGMINAL_HOST` 는 **검증 없이 바인드 주소가 된다** → 특정 인터페이스 한정 바인딩이 이미 가능하다.
- **노출 판정 결함**: `start.go:133`·`:248` 이 `host == ExposeHost || host == "::"` 만 노출로 본다. `DONGMINAL_HOST=192.168.1.5` 는 **`local-only` 로 잘못 표시된다.** → `TLS-2`(§6-3).

### 2-3. **[2판 갱신] ACL 은 `--expose` 기본 배치에서 실제로 유효하다**

프록시가 없으므로 `access.go:336` `remoteIP` 가 파싱하는 `r.RemoteAddr` 이 **진짜 출발지**다. 목록 대조(`:279-310`)가 실제로 돈다.

**방어 기여도 판정:**

| 관점 | 판정 |
|---|---|
| 기본값 | **기본 꺼짐**(FR-ACL-7 `if !s.cfg.Enabled { return true }`, `access.go:288`). 켜지 않으면 기여 0 — `04 P1-1` 이 지적한 그대로다 |
| 켰을 때 | **의미 있는 심층 방어.** LAN 의 임의 기기가 로그인 화면에도 도달하지 못한다 → 무차별 대입(`G1-4`)의 표면 자체가 줄어든다 |
| 한계 | IP 기반이라 **DHCP 로 클라이언트 IP 가 바뀌면 스스로 잠긴다.** 원격 기기가 여럿·이동식이면 운용이 어렵다 |
| 한계 | IP 위조·같은 기기의 다른 프로세스는 막지 못한다. **인증의 대체가 아니다** |

→ **ACL 은 인증의 앞단 필터로 유효하나, 기본 꺼짐이고 IP 기반이라 단독 방어선이 될 수 없다.** M4 DoD 의 `accessGate → authGate` 직렬 배치가 옳다.

### 2-4. Origin/Host 검증 없음
`internal/shared/toolhub/conn.go:34-38`:
```go
var Upgrader = websocket.Upgrader{
    ReadBufferSize:  8192,
    WriteBufferSize: 8192,
    CheckOrigin:     func(r *http.Request) bool { return true },
}
```
**모든 Origin 허용.** M2 B1 게이트가 채울 자리 → §7.

### 2-5. **로컬 CA 구현에 재사용 가능한 자산**
`access.go:73` `self []netip.Addr // 이 머신의 인터페이스 주소 (FR-ACL-5)`, 수집은 `:197`·`:235`.
→ **인증서 SAN 에 넣을 IP 목록을 이미 서버가 갖고 있다.** 새 수집 코드가 필요 없다(§6-2).

---

## 3. Tailscale 관련 사실 — **유지하되 "지원 배치 중 하나" 로 강등**

1판의 조사 결과는 사실로서 유효하며, 기본 설계 전제에서만 빠진다.

- **WireGuard 는 앱 TLS 를 대체하지 못한다.** 브라우저의 secure context 판정은 **URL 스킴만** 본다. 아래 계층이 암호화돼도 `http://` 면 `Notification` 은 없다. `Secure` 쿠키도 붙지 않는다. → **"내 망이 안전하니 TLS 불요" 는 어느 VPN 에서도 성립하지 않는다.** 이 문장은 2판에서 오히려 더 중요하다 — WireGuard·Tailscale·WireGuard 직접 구성·SSH 터널 어느 것에도 같이 적용된다.
- `tailscale cert`: Let's Encrypt, 공개 신뢰, **90일**, DNS-01. 표준 PEM 쌍 → Go `ListenAndServeTLS` 에 그대로. **갱신은 사용자 책임**(tailscaled 가 갱신본 위치를 모른다). 전제: MagicDNS + HTTPS Certificates 활성화, **머신 이름이 공개 CT 원장에 실린다**.
- `tailscale serve`: tailscaled 가 TLS 종단, 백엔드는 `http://127.0.0.1` 만 지원, **인증서 자동 발급·자동 갱신**. 백엔드 도착값(`ipn/ipnlocal/serve.go` 확인): `RemoteAddr`=`127.0.0.1`, `Host`=**원본 보존**(`r.Out.Host = r.In.Host`), `X-Forwarded-Host`/`-Proto: https`/`-For`=피어 tailnet IP, `Tailscale-User-*` 신원 헤더(인바운드 사본은 `Del`).
- `tailscale funnel`: 공개 인터넷. **웹 PTY 공개 노출은 위협 모델상 배제.**
- **WebSocket 리스크**: tailscale/tailscale#18827 — `serve` 리버스 프록시에서 WS 가 10~40초마다 `close 1001` 반복(2026-02-27 개설, 1.94.2 확인, **open**, 환경 의존적). 2판에서는 `serve` 가 기본이 아니므로 **리버스 프록시 지원 여부에만 걸린다** → §5-C.

---

## 4. secure context 확보 경로 전수 판정

`--expose` 로 사설/LAN IP 에 직접 바인딩하는 것이 기본이라는 전제하에.

### 4-1. 판정표

| # | 경로 | secure context 확보 | 인증서 오류 | 설정 부담(초기) | 설정 부담(운영) | 다중 기기 | 모바일(iOS/Android) | 외부 의존 |
|---|---|---|---|---|---|---|---|---|
| **P1** | **앱 내장 로컬 CA** (`dongminal tls init` → CA 발급 + SAN 자동 leaf) | **보장** | **없음**(설치 후) | 중 — 기기마다 CA 설치 1회 | **낮음** — CA 10년, leaf 는 앱이 기동 시 자동 재발급 | 기기마다 CA 1회. **CA 는 재설치 불필요** | iOS: 프로파일 설치 + *인증서 신뢰 설정*에서 전체 신뢰 **2단계**. Android: 사용자 CA 설치(브라우저는 신뢰 — §9 실측) | **없음** — `crypto/x509` 표준 라이브러리 |
| **P2** | `mkcert` 외부 도구 | 보장 | 없음(설치 후) | 중 — 도구 설치 + CA 설치 | 낮음 | P1 과 동일 | P1 과 동일 | **있음** — 사용자가 `mkcert` 설치. 앱 의존은 아님 |
| **P3** | 자체 서명 + 브라우저 예외 승인 | 명세상 true. **실측 필요**(§9) | **남는다** — 주소창 "주의 요함" 상시 | 낮음 — 앱이 생성, 사용자는 승인 클릭 | 중 — 예외가 만료·초기화되면 재승인 | **기기·브라우저마다 승인.** 승인이 유지되는 기간이 브라우저별로 다름 | iOS Safari 승인 가능하나 마찰 큼. **Chrome 은 인증서 오류 페이지에 별도 차단을 건 전례 있음** | 없음 |
| **P4** | **사용자 제공 인증서** `--tls-cert/--tls-key` | 인증서 출처에 따름 | 출처에 따름 | 사용자가 인증서를 마련 | 사용자 책임 | 인증서에 따름 | 인증서에 따름 | **없음**(앱은 PEM 을 읽을 뿐) |
| **P5** | 공인 도메인 + DNS-01(certbot·lego·Caddy) | 보장 | 없음 | **높음** — 도메인 보유·구입, DNS API 토큰, ACME 클라이언트 | 자동 갱신 설정 필요 | **없음 — 전 기기 즉시 동작** | **완전 동작** | 도메인 + ACME 클라이언트 |
| **P6** | Let's Encrypt **IP 인증서** | — | — | — | — | — | — | **부적합.** 공인 IP 만, 챌린지가 `http-01`/`tls-alpn-01`(DNS-01 불가) → **인터넷에서 도달 가능해야 한다.** 유효기간 **약 6일**(`shortlived` 프로파일 강제) → 사설 IP·LAN 배치에 쓸 수 없다 |
| **P7** | **SSH 로컬 포트포워딩** `ssh -L 58146:127.0.0.1:58146` → `http://localhost:58146` | **보장**(loopback 예외, TLS 불요) | 없음 | 낮음(SSH 가 이미 있으면) | 낮음 | 기기마다 SSH 클라이언트·키 | **iOS/Android 사실상 불가** | 없음 |
| **P8** | 브라우저 origin 허용목록 | 확보(브라우저가 강제로 secure 취급) | 해당 없음(평문 유지) | 낮음 | 낮음 | **기기·브라우저마다 설정** | **iOS Safari 불가. Android Chrome 은 루팅/개발자 모드 필요** | 없음 |
| **P9** | Tailscale (`cert` 또는 `serve`) | 보장 | 없음 | 중(cert) / **낮음**(serve) | 90일 수동(cert) / **자동**(serve) | **없음 — tailnet 붙은 기기 전부 즉시** | **완전 동작** | Tailscale 계정·클라이언트 |
| **P10** | 평문 유지(현행) | **불가** | — | 없음 | 없음 | — | — | 없음 |

### 4-2. 경로별 상세

**P1 — 앱 내장 로컬 CA (신규 권장안)**

- 구현: `crypto/x509` 로 CA(자기서명, 10년) + 서버 leaf(CA 서명, 짧게) 발급. `crypto/tls`·`net/http` 로 서빙. **전부 Go 표준 라이브러리** → `08 §제약`("새 런타임 의존 추가 금지", go.mod 직접 2 + 간접 1) 위반 없음.
- SAN 자동 구성: `access.go:73` 의 `s.self`(인터페이스 주소)를 재사용해 **모든 로컬 IP + 호스트명 + `localhost` + `127.0.0.1` + `::1`** 를 넣는다. 기동 때마다 현재 주소로 leaf 를 재발급하면 **DHCP 로 IP 가 바뀌어도 CA 재설치 없이 따라간다** — 이것이 CA 계층을 두는 이유다(자체 서명 단층은 IP 가 바뀌면 전 기기 재승인).
- 사용자 절차: `dongminal tls init` → 출력된 `ca.crt` 를 접속할 기기마다 1회 설치.
- **P3 대비 이점**: 인증서 오류가 **아예 없다** → §0 표의 불확실성이 전부 소멸. 주소창 경고 없음. 승인 만료 없음. IP 변경에 강함.
- **비용**: 기기마다 CA 설치 1회. iOS 2단계.
- 위험: CA 개인키가 새면 그 CA 를 신뢰하는 기기에 대해 임의 사이트를 위조할 수 있다 → `ca.key` 0600, `$DONGMINAL_HOME/tls/`, `auth.json`(`G1-2`)과 같은 저장 규약. mkcert 문서도 같은 경고를 한다(*"rootCA-key.pem 을 내보내거나 공유하지 말 것"*).

**P3 — 자체 서명 + 예외 승인 (1판의 "미확인" 해소 시도)**

확인된 것:
- **W3C 명세는 인증서 유효성을 보지 않는다** — `Is origin potentially trustworthy?` 는 `https`/`wss` 스킴이면 즉시 `Potentially Trustworthy`. 인증서·TLS 오류에 대한 언급이 명세 어디에도 없다.
- **Chromium 구현도 스킴 기반이다** — `network::IsOriginPotentiallyTrustworthy` / `SecurityOrigin::IsPotentiallyTrustworthy` 가 스킴·localhost·`--unsafely-treat-insecure-origin-as-secure` 허용목록으로 판정한다(blink-dev "Status of the notions of secure context in Chromium").
- → **`window.isSecureContext` 는 `true` 일 것이 강하게 예상된다.**

확인되지 않은 것 (**정직하게 미확인**):
- Chrome 은 인증서 오류 상태를 **별도 경로로** 추적해 일부 기능을 차단하는 전례가 있다 — **ServiceWorker 등록은 SSL 오류 시 실패한다**(Chromium 40423989; 같은 상황에서 Firefox 는 통과 → **브라우저별 편차 확인**). 이 프로젝트는 ServiceWorker 를 쓰지 않으므로 직접 영향은 없으나, **`Notification`·`navigator.clipboard` 에도 유사한 별도 차단이 걸리는지는 문서로 확정하지 못했다.**
- Chrome 의 인증서 예외가 얼마나 오래 유지되는지(세션/영구)도 버전 의존.
- → **§9 에 실측 절차를 둔다. 다만 P1 이 이 불확실성을 통째로 우회하므로, 권장안은 실측 결과를 기다리지 않는다.**

**P5 — 공인 도메인 + DNS-01**
도메인만 있으면 **가장 깨끗하다** — 전 기기·전 브라우저 즉시 동작, 모바일 무마찰, 설치 절차 0. 사설 IP 를 A 레코드로 가리키는 것도 가능하다(DNS-01 은 서버 도달성을 요구하지 않으므로 **LAN 전용 배치에서도 공인 인증서를 얻을 수 있다** — 이것이 P6 와 결정적으로 다른 점이다).
기본이 될 수 없는 이유는 **도메인 보유 전제**뿐이다. → **옵션으로 성립하며, `P4`(`--tls-cert/--tls-key`)가 그대로 이 경로의 수용구가 된다.** 앱이 ACME 를 구현할 필요는 없다.

**P7 — SSH 포트포워딩**
`http://localhost` 는 loopback 예외로 **TLS 없이 secure context** 다. 암호화도 SSH 가 한다. 데스크톱에서는 매우 저렴하고, 이미 SSH 접근이 있는 사용자에게는 **설정 부담이 사실상 0**이다. 모바일에서 불가능한 것이 유일한 결격 — 그러나 **문서에 적을 값은 충분하다**(`G10-1`).

**P8 — 브라우저 origin 허용목록**
- Chrome/Edge: `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 에 `http://192.168.0.10:58146` 형태로 입력 후 재시작. Android/ChromeOS 는 root 또는 개발자 모드 필요.
- Firefox: `about:config` 의 `dom.securecontext.allowlist`(쉼표 구분 호스트 목록). **포트를 지정할 수 없다**(Mozilla Connect 개선 요청 계류 중).
- iOS Safari: **해당 기능 없음.**
→ **개발·임시 확인용. 제품 안내 경로로 삼을 수 없다.**

---

## 5. 재판정 결론

### A. 권장 경로 — **P1(앱 내장 로컬 CA) 기본 + P4(사용자 제공 인증서) 병행**

**P1 을 기본으로 두는 근거**
1. **전제를 하나도 요구하지 않는다.** 도메인·인터넷 도달성·외부 계정·외부 도구가 전부 불요. `--expose` 로 LAN IP 에 직접 바인딩하는 기본 경로에 정확히 맞는다.
2. **§1 의 결손을 확실히 해소한다.** P3 와 달리 인증서 오류가 없으므로 secure context 가 명세로 보장된다 — 실측 결과에 제품을 걸지 않는다.
3. **신규 런타임 의존 0.** `crypto/x509`·`crypto/tls` 는 표준 라이브러리. `08 §제약`과 충돌하지 않는다.
4. **IP 변경에 강하다.** CA 계층 덕에 leaf 재발급으로 흡수된다. `s.self`(`access.go:73`) 재사용으로 SAN 구성 코드가 거의 공짜다.
5. `Secure` 쿠키가 붙는다 → **결정 5(세션 쿠키)의 전송 보호 근거가 성립한다**(`07 §1-5` 의 "인증과 TLS 는 한 묶음").

**P4 를 함께 두는 근거**
- P5(공인 도메인)·P9(Tailscale `cert`)·기업 내부 CA 사용자가 **같은 두 플래그로 수용된다.** 앱이 ACME 도 Tailscale 연동도 구현할 필요가 없다.
- 구현이 작다(플래그 2개 + `ListenAndServeTLS` 분기).

**P3(자체 서명 단독)은 P1 의 하위 모드로만 둔다.** CA 설치를 건너뛰고 싶은 사용자를 위해 "CA 를 설치하지 않으면 브라우저 경고를 매번 승인해야 하고 일부 기능이 동작하지 않을 수 있다" 는 안내와 함께 남긴다. **별도 코드 경로가 아니다** — P1 의 인증서를 그대로 쓰되 CA 를 설치하지 않은 상태일 뿐이다.

**문서에 적을 보조 경로**: P7(SSH 포트포워딩, 데스크톱), P9(Tailscale, 이미 쓰는 사용자), P5(도메인 보유자), P8(개발·임시).

### B. secure context 를 확보하지 못하는 경우의 차선책

**현실 판정: 상당수 사용자가 P10(평문)에 남는다.** CA 설치는 무시할 수 없는 마찰이고, "일단 `--expose` 로 띄워서 써 본다" 가 자연스러운 첫 경로다. 따라서 **평문 경로에서의 조용한 실패 제거는 선택이 아니라 최소 요구선이다.**

`TLS-1`(알림 토글 비활성화 + 사유 표시)만으로는 **부족하다.** 근거:

| 알림 경로 | 평문 원격에서 | 기본값 | 브라우저 밖에 알리는가 |
|---|---|---|---|
| 데스크톱 알림 `Notification` | **죽음** | **켜짐**(`app.js:314`) | ✔ (죽어서 못 함) |
| 알림음 `AudioContext`(`app-attn.js:385`) | **동작** | **꺼짐**(`app.js:316`) | ✔ |
| attn 배지·센터(`_attnRefresh`) | 동작 | — | ✘ — 탭을 보고 있어야 보인다 |
| 탭 제목(`document.title`) | — | — | **미구현** (`web/js/` 전체에서 `document.title` 대입 0곳) |

→ **평문 원격에서 "브라우저 밖에 있을 때 알리는" 수단은 알림음뿐이고, 그것은 기본 꺼짐이다.** 토글만 비활성화하면 사용자는 "알림 기능이 없는 제품" 을 얻는다.

**차선책 권장 (`TLS-1` 확장):**
1. **[필수] 조용한 실패 제거** — `window.isSecureContext===false` 면 데스크톱 알림 토글을 **비활성화 + 사유 표시**("HTTPS 로 접속해야 사용할 수 있습니다"). 해결 경로(`dongminal tls init`)를 함께 안내.
2. **[필수] 대체 경로로 자동 승격** — 같은 조건에서 **알림음을 기본 켜짐으로** 전환한다. 기본값이 환경에 따라 갈리는 것은 바람직하지 않으나, "기본 켜짐인 알림이 조용히 죽는" 현행보다 낫다. 사용자가 끄면 그 선택이 우선한다.
3. **[권장] 탭 제목 알림 추가** — `document.title` 앞에 미확인 attn 수를 붙인다(`(2) dongminal`). secure context 불요, 구현 수 줄, **브라우저 밖(다른 탭)에서 유일하게 보이는 시각 신호**다. 파비콘 배지까지는 불필요.
4. **[권장] `G10-1` 배포 형태표에 명시** — "평문 배치: 데스크톱 알림 미동작, `Secure` 쿠키 불가" 를 **열등 등급으로 문서화**한다.

### C. `--expose` 기본 전제에서의 보안 요구 재정리

**C-1. 인증과 TLS 는 분리 불가한 한 묶음인가 — 부분적으로 그렇다. 다만 순서는 인증이 먼저다.**

| 항목 | 판정 |
|---|---|
| **인증(`G1-1~G1-4`)이 먼저** | `04 §1.2` 의 P0 는 기본 `127.0.0.1` 에서도 성립하는 RCE 다. 인증은 TLS 유무와 무관하게 필요하고, **TLS 없이도 인증은 의미가 있다**(수동 도청자에게는 노출되나, 우연히 같은 망에 있는 기기의 접근은 막는다). |
| **TLS 가 없으면 무너지는 것** | ① 세션 쿠키가 평문 전송 → 도청자가 세션 탈취 ② `Secure` 속성 불가 ③ §1 의 기능 결손. **결정 5(쿠키 방식)의 근거가 TLS 에 걸려 있다**(`07 §1-5`). |
| **결론** | **한 마일스톤(M4) 안에서 함께 나가되, 릴리스 게이트는 인증이 잡는다.** TLS 는 "인증을 켠 뒤 노출 모드에서 강제되는 조건" 이지, 인증과 독립된 별개 기능이 아니다. `08` 의 M4 묶음 배치가 옳다. |

**C-2. ACL 의 기여** — §2-3 판정: 켜면 유효한 심층 방어, **기본 꺼짐이고 IP 기반이라 단독 방어선 불가.** `accessGate → authGate` 직렬 유지. `--expose` 기본 전제에서는 프록시가 없으므로 **`RemoteAddr` 이 진짜 출발지이며 ACL 이 정상 작동한다** — 1판의 "S4 에서 ACL 무력화" 우려는 기본 경로에서 발생하지 않는다.

**C-3. "인증 없이 `--expose` 기동 거부" 의 첫 경험**

거부만 하면 사용자는 막힌다. 다음 흐름을 권장한다:

```
$ dongminal start --expose
❌ 노출 모드는 인증이 필요합니다.

  1) 자격증명을 만드세요:      dongminal auth init
  2) (권장) HTTPS 를 켜세요:   dongminal tls init

  둘 다 건너뛰려면(권장하지 않음): --insecure-plaintext --no-auth
```
- **`auth init` 은 대화형 1회로 끝나야 한다** — 비밀번호 입력(또는 자동 생성 후 1회 출력) → `$DONGMINAL_HOME/auth.json` 0600. `G1-2` DoD 그대로.
- **`tls init` 도 1회로 끝나야 한다** — CA + leaf 생성, `ca.crt` 경로와 기기별 설치 안내(OS별 한 줄씩) 출력.
- **거부는 `--expose` 뿐 아니라 비 loopback 바인드 전체**에 걸린다(`TLS-2`).
- **`--isolated` 는 예외로 둔다** — e2e·개발 격리 실행이 매번 인증을 요구하면 테스트가 무너진다. M4 DoD 가 이미 `--isolated` 에서만 `--auth=off` 를 허용하는 방향으로 적혀 있다.

**C-4. 리버스 프록시 뒤 배치 — 지원 대상에서 뺄 것을 권장한다 (`--expose` 기본 전제에서)**

| 남길 때 비용 | 뺄 때 이득 |
|---|---|
| `X-Forwarded-*` 신뢰 옵트인 설계(`--trusted-proxy`) + 그 신뢰 조건 판정 규칙 | 설계 항목 1건 삭제 |
| `TLS-3`(ACL 무력화 감지·경고) 필요 | `TLS-3`(S) 삭제 |
| `Secure` 쿠키를 `X-Forwarded-Proto` 로 판정하는 분기 | 쿠키 판정이 "자체 TLS 여부" 한 가지로 단순화 |
| 프록시 뒤에서 WS 가 끊기는 문제(tailscale#18827 부류)가 **지원 약속의 범위**로 들어온다 | WS 안정성 책임이 앱 경계 안으로 한정된다 |
| `G10-1` 에 배포 형태 1건 추가·검증 | 문서·검증 범위 축소 |

**권장: M4 에서는 "미지원(동작할 수 있으나 보증하지 않음)" 으로 선언하고, `X-Forwarded-*` 신뢰 코드를 넣지 않는다.**
근거: ① `--expose` 직접 바인딩이 기본으로 확정됐으므로 프록시는 소수 경로다 ② 프록시 뒤에서는 ACL 이 조용히 무력화되는데(§2-3 1판 조사), 그 사실을 감지·경고하는 코드(`TLS-3`)까지 지어야 "지원" 이라 말할 수 있다 ③ `X-Forwarded-For` 신뢰는 FR-ACL-6 이 명시적으로 거부한 설계이며, 옵트인이라도 잘못 켜면 ACL 이 헤더 한 줄로 뚫린다 ④ **빼도 사용자가 못 하는 일이 없다** — 프록시를 쓰려는 사용자는 앱을 `127.0.0.1` 에 두고 프록시를 붙이면 되고, 그때 ACL 을 끄면 된다. 문서에 그 한 줄만 적으면 된다.
단, `07 §12`·`G10-1` 이 "지원 배포 형태" 로 리버스 프록시를 나열해 왔으므로 **이 축소는 명시적 결정으로 기록**해야 한다(`08 결정 8` 의 (c) 반대 근거가 "리버스 프록시 배포가 불가능해진다" 였는데, 여기서는 **불가능해지는 것이 아니라 보증하지 않는 것**이라는 차이를 문서가 말해야 한다).

---

## 6. `G1-5` 재산정

### 6-1. 규모 — **M → M/L 로 상향** (1판의 축소 결론은 철회)

1판은 "자체 서명 생성기 제외" 를 근거로 M → S/M 축소를 제안했다. **2판에서 뒤집힌다** — Tailscale 이 인증서를 주지 않으므로 **앱이 인증서를 만들어야 한다.**

| 구성 요소 | 내용 | 규모 |
|---|---|---|
| TLS 서빙 | `httpapi/server.go:220-230` 에 `ListenAndServeTLS` 분기, `--tls-cert/--tls-key` 플래그(`ctl/cli/options.go`) | **S** |
| **로컬 CA 발급기** | `crypto/x509` — CA 생성(자기서명·10년·`IsCA`·`KeyUsageCertSign`), leaf 발급(CA 서명·SAN 구성·`ExtKeyUsageServerAuth`), PEM 저장(`ca.key` 0600) | **M** |
| SAN 자동 구성 | `access.go:73` `s.self` 재사용 + 호스트명 + loopback. 기동 시 현재 주소와 대조해 leaf 재발급 | **S** |
| `dongminal tls init` / `tls show` | CLI 액션, `ca.crt` 경로·지문 출력, **OS별 CA 설치 안내문**(macOS·Windows·Linux·iOS·Android) | **S/M** |
| 노출 판정 확장(`TLS-2`) | `start.go:133,248` 를 비 loopback 전체로. `pingHost` 연동 주의 | **S** |
| 기동 거부 + 안내(C-3) | `--insecure-plaintext` 게이트, 3단 안내 출력 | **S** |
| `Secure` 쿠키 연동 | 자체 TLS 일 때만 부착(프록시 미지원 결정으로 분기 1개) | **S** |
| 문서(`G10-1` 연계) | 배포 형태별 보증표, CA 설치 안내, 평문 열등 등급 명시 | (G10-1 흡수) |

**합: S×5 + S/M×1 + M×1 → M/L.** M4 전체 규모(L)는 유지되나 `G1-5` 가 M4 안에서 차지하는 비중이 커진다.

### 6-2. 신규 런타임 의존 — **추가되지 않는다**

- `crypto/x509`·`crypto/tls`·`crypto/rand`·`encoding/pem`·`net/http` **전부 표준 라이브러리.** `08 §제약`("go.mod 직접 2 + 간접 1") 위반 없음.
- **인증서 획득이 외부 의존을 부르는가 — 아니다.** P1 은 앱이 직접 만든다. P4 는 사용자가 파일을 준다. **ACME 클라이언트를 앱에 넣지 않는다** — P5 사용자는 자기 도구(certbot·lego·Caddy)로 얻은 PEM 을 P4 로 넣는다.
- `filosottile/mkcert` 를 **임포트하지 않는다**(P2 는 사용자가 별도로 쓰는 선택지일 뿐). `tailscale.com`/`tsnet` 도 임포트하지 않는다.

### 6-3. M4 신규 항목

| ID(제안) | 내용 | 규모 |
|---|---|---|
| **TLS-1** | **조용한 실패 제거 + 대체 경로 승격** — `isSecureContext===false` 면 ① 데스크톱 알림 토글 비활성화 + 사유·해결 안내 ② 알림음 기본 켜짐으로 전환 ③ 탭 제목 미확인 수 표시. §5-B | **S/M** |
| **TLS-2** | 노출 판정을 `0.0.0.0`/`::` → **비 loopback 바인드 전체**로 확장(`start.go:133,248`). 현재 `DONGMINAL_HOST=192.168.x` 가 `local-only` 로 **오표시**된다 | **S** |
| ~~TLS-3~~ | ~~프록시 뒤 ACL 무력화 감지·경고~~ → **C-4 로 삭제**(리버스 프록시 미지원 선언 시 불요). 지원하기로 뒤집히면 부활 | ~~S~~ |
| **TLS-4** | `dongminal verify` 에 "TLS 켜짐이면 인증서 SAN 이 현재 바인드 주소를 덮는가 / 만료 임박 아닌가" 항목 추가 | **S** |
| **G10-1 보강** | 배포 형태별 보증표에 **P1·P4·P5·P7·P9·P10 을 그대로** 싣는다. P10(평문) = **명시적 열등 등급**. 리버스 프록시·funnel·멀티유저 = 미지원 선언. CA 개인키 보관 주의 | (G10-1 내) |
| **DoD 근거** | "loopback 도 인증 면제하지 않는다" 유지 — `04 §1.2` P0 가 loopback 출발지 공격이라는 근거로 충분하다(1판의 `tailscale serve` 근거는 부차) | (문서) |

### 6-4. `G1-5` DoD 제안

- `dongminal tls init` 이 `$DONGMINAL_HOME/tls/{ca.crt,ca.key,server.crt,server.key}` 를 만든다. `ca.key`·`server.key` 는 **0600**, 스키마/버전 포함. `ca.crt` 지문과 **OS별 설치 명령**을 출력.
- 기동 시 leaf 의 SAN 이 현재 바인드 주소를 덮지 않으면 **자동 재발급**하고 로그에 남긴다. CA 는 건드리지 않는다.
- `--tls-cert`/`--tls-key` 를 주면 그쪽이 우선하고, 한쪽만 주면 **기동 거부**.
- 비 loopback 바인드 + TLS 없음 + `--insecure-plaintext` 없음 → **기동 거부**, C-3 의 3단 안내 출력.
- `Secure` 쿠키가 자체 TLS 에서 붙고 평문에서 안 붙는다.
- **수동 검증 절차 문서화**(CI 에서 CA 를 기기 신뢰 저장소에 넣을 수 없으므로): CA 설치 후 접속해 `window.isSecureContext===true`, 주소창 경고 없음, **데스크톱 알림 권한 프롬프트가 뜬다**, `wss://` 가 101 로 붙는다.
- e2e: 자체 CA 를 Playwright `ignoreHTTPSErrors` 또는 `--isolated` 평문으로 우회. **`--isolated` 는 인증·TLS 강제에서 제외.**

---

## 7. M2 Origin/Host 게이트 허용목록 요구사항 (전체)

`internal/shared/toolhub/conn.go:37` 의 `CheckOrigin: return true` 와 M2 가 신설할 Host 검증이 **같은 판정 함수**를 써야 한다(`08 제약 4`: `authGate` 와 B1 은 같은 자리).

### 7-1. 배치별 도착 값

| 배치 | `Host` | `Origin`(브라우저) |
|---|---|---|
| 로컬 | `localhost:58146` / `127.0.0.1:58146` | `http://localhost:58146` 등 |
| **`--expose` + 평문 (기본)** | `192.168.1.5:58146` (사용자가 친 주소 그대로) | `http://192.168.1.5:58146` |
| **`--expose` + P1 로컬 CA** | `192.168.1.5:58146` 또는 `<hostname>:58146` | `https://…:58146` |
| P4 + 공인 도메인 | `dm.example.com:58146` | `https://dm.example.com:58146` |
| P7 SSH 터널 | `localhost:58146` | `http://localhost:58146` |
| P9 `tailscale cert` | `<host>.<tailnet>.ts.net:58146` | `https://…:58146` |
| P9 `tailscale serve` | `<host>.<tailnet>.ts.net` (**443 → 포트 없음**) | `https://…` (포트 없음) |

### 7-2. 요구사항 (전체 10항)

1. **스킴을 하드코딩하지 말 것.** `http`·`https` 둘 다 유효한 배치가 있다(평문 기본 + TLS 옵션). Origin 비교에서 스킴을 고정하면 TLS 전환마다 깨진다.
2. **포트 유무를 정규화할 것.** 대부분은 `:58146` 이 붙지만 `tailscale serve`(443)는 붙지 않는다. `net.SplitHostPort` 실패를 "포트 없음" 으로 정상 처리.
3. **[2판 1급 규칙] 기본 허용목록은 "서버 자신이 도달 가능한 주소" 에서 자동 유도한다.**
   `localhost` ∪ `127.0.0.1`/`::1` ∪ **실제 바인드 주소** ∪ **`access.go:73` 의 `s.self`(인터페이스 주소 전부)** ∪ 시스템 호스트명.
   → **`s.self` 재사용으로 새 수집 코드가 필요 없고, `--expose 0.0.0.0` 기본 경로에서 사용자가 어느 로컬 IP 로 접속하든 자동으로 통과한다.** 이것이 2판의 1급 규칙이다(1판의 `*.ts.net` 을 대체).
4. **`*.ts.net` 접미사 규칙은 기본이 아니라 옵션으로 내린다.** 전제가 바뀌었으므로 기본 허용목록에 넣지 않는다. `--allowed-host '*.ts.net'` 로 사용자가 켠다. (와일드카드 접미사 문법은 지원해야 한다 — tailnet 이름이 임의라 하드코딩 불가.)
5. **`--allowed-host` 로 명시 확장.** 공인 도메인(P5)·CNAME·리버스 프록시 사용자가 쓰는 유일한 입구. 반복 지정 또는 쉼표 구분.
6. **`Origin` 부재는 거부가 아니다.** 비브라우저 클라이언트(`dmctl`·`curl`·e2e `page.request`)는 `Origin` 을 보내지 않는다. **부재 = 통과, 존재하면 대조.** 어기면 M4 의 `dmctl` Bearer 경로(`runtimebin/http.go:40-70` 경유 17곳/9파일)가 전부 막힌다.
7. **`Host` 는 존재하면 항상 대조한다**(HTTP/1.1 필수 헤더이므로 부재 예외가 불필요). DNS 리바인딩 방어의 본체가 여기다.
8. **`X-Forwarded-Host`·`X-Forwarded-Proto`·`X-Forwarded-For` 를 읽지 않는다.** `04 §5`/FR-ACL-6 의 근거를 그대로 승계한다. **C-4 의 리버스 프록시 미지원 결정으로, 신뢰 옵트인 설계 자체가 M4 범위에서 빠진다** — 판정 함수가 단순해진다.
9. **거부는 로그에 남고 본문에 허용목록을 노출하지 않는다** — `FR-ACL-13` 형식, 403 본문 규약을 그대로 따른다. "목록을 켰는데 접속이 안 된다" 를 풀 근거가 로그여야 한다(`accessGate` 가 `loggingMiddlewareFor` 안쪽에 서는 이유와 같다).
10. **`/ws` 와 HTTP 종단이 한 판정 함수를 쓸 것.** `Upgrader` 는 `internal/shared/toolhub`(공유 패키지)의 **패키지 변수**이고 게이트는 `internal/webserver/httpapi` 에 있다. 둘 중 하나:
    - (a) `Upgrader` 를 주입 가능한 형태로 바꾸고 `CheckOrigin` 에 게이트의 판정 함수를 넘긴다, 또는
    - (b) 업그레이드 **이전에** 미들웨어에서 판정이 끝나 있게 한다 — `accessGate` 가 이미 `server.go:215` 에서 `/ws` 를 포함해 한 겹으로 덮는 구조(FR-ACL-11)와 같은 자리.
    **(b) 를 권장한다** — 새 종단이 생겨도 자동으로 덮이고, `authGate` 와 같은 자리라 예외 경로 목록이 한 벌로 유지된다(`08 제약 4`).

---

## 8. 철회 항목 (1판 → 2판)

| 1판 결론 | 상태 | 사유 |
|---|---|---|
| **S4(`tailscale serve`)를 기본 권장 배포 형태로** | **철회** | Tailscale 을 설계 전제로 삼을 수 없다는 사용자 결정. 제품이 Tailscale 없이 성립해야 한다 |
| **S2(`tailscale cert`)를 2순위 권장으로** | **철회 → 강등** | 동일. `P4`(`--tls-cert/--tls-key`)의 **한 사용 사례**로만 남는다 — Tailscale 사용자는 `tailscale cert` 결과를 P4 에 넣으면 된다. 앱 설계에 Tailscale 이 등장하지 않는다 |
| **`--expose` 가 `tailscale serve` 로 대체된다** | **철회** | `--expose` 가 기본 경로로 확정 |
| **`--tls`(자체 서명 생성기) 제외 권장 → `G1-5` 규모 M → S/M 축소** | **철회. 역전됨** | Tailscale 이 인증서를 주지 않으므로 **앱이 인증서를 만들어야 한다.** 자체 서명 단층이 아니라 **로컬 CA 계층**으로 확대되어 `G1-5` 는 **M → M/L 상향**(§6-1) |
| **`TLS-3`(프록시 뒤 ACL 무력화 감지)** | **철회(조건부)** | C-4 에서 리버스 프록시를 미지원으로 선언하면 불요. 지원하기로 뒤집히면 부활 |
| **M2 허용목록의 `*.ts.net` 1급 규칙** | **강등** | 옵션(`--allowed-host`)으로 내린다. 1급 규칙은 **`s.self` 기반 자동 유도**(§7-2-3) |
| **"`tailscale serve` 배치에서 ACL 무력화" 를 loopback-무면제의 근거로** | **부차로 강등** | 기본 경로에 프록시가 없으므로 ACL 은 정상 작동한다. loopback-무면제의 주 근거는 `04 §1.2`(P0 가 loopback 출발지 공격) |
| **tailscale#18827(WS 끊김)이 채택 전 실측 필수** | **강등** | `serve` 가 기본에서 빠졌으므로 **리버스 프록시 지원 여부에만 걸린다.** C-4 가 미지원을 권장하므로 실측 불요. 지원으로 뒤집히면 부활 |
| §1 결손(데스크톱 알림) · §2 코드 사실 · §3 Tailscale 사실관계 · `wss` 전환 0줄 · W3C 명세 해석 | **전부 유지** | 전제와 무관한 사실 |

---

## 9. 미확인 · 실측 절차

### 9-1. [중] 자체 서명(P3) 예외 승인 후 실제 API 동작

명세·Chromium 구현상 `isSecureContext===true` 가 예상되나 Chrome 이 인증서 오류에 별도 차단을 건 전례(ServiceWorker)가 있어 확정 불가.
**권장안(P1)이 이 항목을 우회하므로 차단 요인은 아니다.** 확인하고 싶으면:

```
1. 자체 서명 인증서로 서버를 띄운다(CA 를 신뢰 저장소에 넣지 않은 상태).
2. 원격 기기 브라우저에서 https://<IP>:58146 접속 → 경고 → 고급 → 계속.
3. DevTools 콘솔에서:
     window.isSecureContext                       // true 기대
     typeof Notification                          // "function" 기대
     Notification.requestPermission()             // 권한 프롬프트가 뜨는가
     typeof navigator.clipboard                   // "object" 기대
     await navigator.clipboard.writeText('x')     // 예외 없이 통과하는가
4. 터미널 pane 을 열어 Network 탭에서 /ws 가 101 로 붙는지 확인.
5. 브라우저를 완전히 종료·재시작한 뒤 예외가 유지되는지 확인.
6. Chrome / Safari / Firefox × 데스크톱 / iOS / Android 로 반복.
```
3 이 전부 기대대로면 P3 도 실용 경로다. 하나라도 어긋나면 P1(CA 설치)이 유일한 답이다.

### 9-2. [중] Android Chrome 의 사용자 설치 CA 신뢰 — **상충하는 보고**

- **신뢰한다는 쪽**: *"커스텀 자체 서명 Root CA 는 Android Chrome 브라우저 및 WebView 기반 앱에서 사용된다 … Android 에 설치된 어느 브라우저에서도 동작한다."* 또한 httptoolkit 분석은 **Chrome 이 `system` 저장소 CA 에만 Certificate Transparency 를 요구하고 `user` 저장소 CA 는 면제**한다고 적는다 — 이는 Chrome 이 user 저장소 CA 를 **신뢰함**을 전제로 한 서술이다.
- **신뢰하지 않는다는 쪽**: Android 7+ 에서 앱은 network-security-config opt-in 없이 user CA 를 쓰지 않으며, 일부 문서가 이를 Chrome 에까지 확대해 적는다.
- **판단**: 앞의 근거(특히 CT 면제 서술)가 더 구체적이므로 **Android Chrome 은 user CA 를 신뢰할 가능성이 높다.** 다만 **실측 항목으로 남긴다** — Android 기기에서 P1 의 `ca.crt` 를 설치하고 경고 없이 접속되는지 확인. 실패하면 Android 에서는 P5(공인 도메인)·P7·P9 중 하나가 필요하다.

### 9-3. [소] 기타

- iOS 의 *설정 ▸ 일반 ▸ 정보 ▸ 인증서 신뢰 설정* 2단계가 최신 iOS 에서 동일한지 — 설치 안내문 작성 시 확인.
- Chrome 인증서 예외의 유지 기간(세션/영구) — P3 를 문서에 남길 경우에만 필요.
- 로컬 CA 의 leaf 유효기간 선택 — 짧게 두면 재발급이 잦고, 길면 키 유출 노출이 길다. 기동 시 자동 재발급이 있으므로 짧게(예: 90일) 두어도 운용 부담이 없다. M4 SRS ② 에서 확정.
- `--isolated`/e2e 에서 TLS·인증 강제를 어떻게 우회할지의 정확한 규칙 — M4 fixture 설계 시 확정.
