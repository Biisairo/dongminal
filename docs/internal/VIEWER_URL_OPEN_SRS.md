# SRS: 보고 있는 기기에서 URL 열기 — IEEE 29148

| 항목 | 값 |
|---|---|
| 문서 | VIEWER_URL_OPEN_SRS |
| 상태 | 구현 (Go 유닛·e2e 통과) |
| 선행 | WORKSPACE_IDENTITY_SRS (FR-XDF-*·FR-SXE-*), TERM_XFER_NOTICE_SRS (Toast) |
| 후속 | 없음 |
| FR 접두 | FR-VUO |

## 1. 개요

### 1.1 목적

접수한 말은 이렇다.

> **"터미널에서 링크주소를 바로 띄우는 경우 있잖아. 그때 서버 열린 컴퓨터 말고
> 그 타이밍에 그 동작을 하는 탭을 포커스하고있는 컴퓨터에서 띄우는거"**
>
> 처방 확정:
> - 팝업창이 아니라 **일반 브라우저 창/탭**으로 연다.
> - **보고 있는 기기가 서버와 같은 컴퓨터면 묻지 않고** 연다.
> - **원격 기기에서 보고 있으면 "여기서 열기" 확인**을 띄우고, 확인하면 연다.
> - 이 판정은 **열 때마다** 한다.
> - URL 이 localhost 면 **지금 접속한 주소를 잡아** 재작성한다.

`claude` 로그인, `gh auth login`, dev 서버 자동 오픈처럼 CLI 가 브라우저를 직접
띄우는 자리가 대상이다. 지금은 그 브라우저가 **dongminal 서버가 도는 컴퓨터**에서
뜬다. 아이패드에서 워크스페이스를 보고 있으면 사용자는 그 창을 볼 수 없다.

### 1.2 현재 상태 (조사로 확정한 사실)

| 사실 | 근거 |
|---|---|
| 링크 **클릭**은 이미 보는 기기에서 열린다 | `web/js/ui/term-pane.js:33` — `WebLinksAddon` → `window.open(uri,'_blank')` |
| CLI 의 **자동** 오픈은 서버 머신에서 뜬다 | `open`/`xdg-open` 이 서버 쉘에서 실행됨 |
| 포커스 중인 클라이언트를 서버가 안다 | `FocusRegistry.Executor()` — `internal/webserver/hub/focus.go:89` |
| 한 클라이언트만 실행시키는 배선이 있다 | `singleExecutorActions`(`hub/commands.go:73`) → `execClientId`(`httpapi/commands.go:154`) → `event-bus.js:217` |
| 쉘 함수로 명령을 덮는 선례가 있다 | `~/.dongminal/bin/zdotdir/.zshrc` 의 `claude()`·`codex()` |
| `~/.dongminal/bin` 은 PATH 의 **뒤**에 있다 | `/usr/bin/open` 이 먼저 잡힌다 → 심볼릭 링크 shim 은 듣지 않는다 |
| 하단 알림 요소가 있다 | `web/js/ui/toast.js` |

### 1.3 정의

| 용어 | 정의 |
|---|---|
| **뷰어(viewer)** | `FocusRegistry.Executor()` 가 뽑은, 지금 워크스페이스를 보고 있는 단 하나의 클라이언트 |
| **로컬 뷰어** | 그 클라이언트의 SSE 구독 원격 주소가 loopback 인 뷰어 (= 서버와 같은 컴퓨터) |
| **원격 뷰어** | 그 외의 뷰어 |
| **열기 요청** | 쉘에서 시작된 "이 URL 을 열어라" 한 건 |
| **확인 팝업** | 원격 뷰어 화면 하단에 뜨는, 최종 URL 과 `열기`/`취소` 를 담은 요소 |

### 1.4 참조

- `internal/webserver/hub/focus.go:89`(`Executor`)·`:112`(`Attach`)
- `internal/webserver/hub/commands.go:73`(`singleExecutorActions`)·`:205`(`AllowedCmdActions`)
- `internal/webserver/httpapi/commands.go:69`(`Focus.Attach`)·`:154`(`ExecClientId`)
- `web/js/core/event-bus.js:217`(지명 게이트)·`web/js/core/app-cmd.js`(`_execRemote`)
- `internal/helper/runtimebin/edit.go:41`(`openEditorTab` — dmctl → 액션 전송의 선례)
- `internal/shared/runtime/install.go:38`(`helperNames`)·`internal/shared/platform/shell.go:70`(ZDOTDIR)

---

## 2. 요구사항

### 2.1 판정과 경로 (FR-VUO-1~6)

**FR-VUO-1** 열기 요청은 `dmctl open-url <url>` 로 서버에 접수된다. 서버는 그 시점의
뷰어를 `Executor()` 로 정하고, 로컬 뷰어면 `{"where":"local"}`, 원격 뷰어면
`{"where":"remote"}` 를 응답한다.

**FR-VUO-2** 로컬 뷰어면 서버는 아무 것도 브로드캐스트하지 않는다. `dmctl` 이 응답을
받아 **호출한 쉘의 자리에서** 원래 열기 명령(macOS `open`, Linux `xdg-open`,
Windows `rundll32 url.dll,FileProtocolHandler`)을 실행한다.

> 서버가 대신 실행하지 않는 이유: 서버는 GUI 세션 밖(데몬)일 수 있고, 그러면
> `open` 이 조용히 실패한다. 호출한 쉘은 이미 그 세션 안에 있다.

**FR-VUO-3** 원격 뷰어면 서버는 `openUrl` 액션을 브로드캐스트한다. `execClientId` 로
뷰어 하나를 지명하므로 여러 기기가 붙어 있어도 한 곳에서만 뜬다. `dmctl` 은 로컬
실행 없이 종료한다.

**FR-VUO-4** SSE 구독이 하나도 없으면(브라우저가 다 닫힘) 로컬로 취급한다 —
FR-VUO-2 와 같다. 서버에 닿지 못해도 마찬가지다. **열기 요청은 어떤 경우에도
소실되지 않는다.**

**FR-VUO-5** 판정은 **열기 요청마다** 새로 한다. 이전 확인 결과를 기억하지 않으며,
"이 URL 은 항상 허용" 류의 상태를 두지 않는다.

**FR-VUO-6** 환경변수 `DONGMINAL_URL_OPEN` 이 판정을 강제한다 — `local` 은 항상
FR-VUO-2, `viewer` 는 뷰어가 있으면 항상 FR-VUO-3, 미설정(기본)은 FR-VUO-1 의 판정.
§4 의 터널 오판을 사용자가 빠져나가는 유일한 손잡이다.

### 2.2 뷰어에서 열기 (FR-VUO-7~11)

**FR-VUO-7** 원격 뷰어는 **화면 가운데에** 확인 상자를 띄운다 (`UIKit.modal`).
상자는 **열릴 최종 URL**(FR-VUO-10 의 재작성을 마친 것)과 `열기`·`취소` 를 보이며,
스스로 사라지지 않는다. `Esc` 와 상자 밖 클릭은 취소와 같다.

> 처음에는 하단 알림(`Toast`)이었다. 사용자 지시로 중앙 상자가 됐고, 근거가 그
> 지시보다 넓다 — 이것은 **알림이 아니라 질문**이다. 답하지 않으면 열기 요청이
> 사라지는데, 구석에서 스스로 사라지는 요소는 답을 받기 위한 자리가 아니다.

**FR-VUO-8** `열기` 를 누르면 `window.open(url,'_blank')` 로 연다. 새 **탭/창**이며
`window.open` 의 세 번째 인자(창 피처)를 주지 않는다 — 피처를 주면 도구 막대 없는
팝업창이 된다.

> 이 호출이 클릭 핸들러 안에 있는 것이 설계의 핵심이다. 사용자 제스처 없이 부른
> `window.open` 은 모든 주요 브라우저가 차단한다. 로컬 경로는 애초에 브라우저를
> 거치지 않으므로(FR-VUO-2) 두 경로 모두 차단에 걸리지 않는다.

**FR-VUO-9** `취소` 또는 팝업을 닫으면 아무 것도 열지 않는다. 서버에 되돌려 알리지
않으며 `dmctl` 은 이미 종료한 상태다.

**FR-VUO-10** URL 의 host 가 `localhost`·`127.0.0.1`·`0.0.0.0`·`::1`·`[::1]` 중
하나이면 **뷰어가 지금 dongminal 에 접속한 host**(`location.hostname`)로 치환한다.
scheme·포트·경로·쿼리·프래그먼트는 보존한다. 그 외 host 는 손대지 않는다.

> 서버의 `http://localhost:3000` 을 원격 기기가 그대로 열면 자기 자신의 3000 번을
> 본다. 재작성이 그것을 서버의 3000 번으로 돌린다.

**FR-VUO-11** 재작성한 주소에 실제로 닿는지는 이 문서의 책임이 아니다 — 그 서비스가
`0.0.0.0` 으로 바인딩되어 있어야 한다. 닿지 않으면 브라우저의 연결 실패로 드러난다.

### 2.3 쉘 접합면 (FR-VUO-12~15)

**FR-VUO-12** multi-call 헬퍼에 `open-url` 을 더한다. 인자는 URL 하나이며
`dmctl open-url` 과 같은 코드 경로다. `BROWSER` 가 실행 파일을 요구하므로 쉘 함수로는
대신할 수 없다.

**FR-VUO-13** 도구 쉘에 `BROWSER=$DONGMINAL_HOME/bin/open-url` 을 넣는다.
`xdg-open`·python `webbrowser`·node `open` 등이 이 변수를 존중한다.

**FR-VUO-14** zdotdir `.zshrc` 와 `bash-hook.sh` 에 `open`·`xdg-open` 함수를 더한다.
인자가 **정확히 하나이고 `http://` 또는 `https://` 로 시작할 때만** 가로채고, 그
외에는 `command open "$@"` 로 위임한다. `$DONGMINAL_HOME/bin/open-url` 이 실행
가능하지 않으면(설치 전) 언제나 위임한다 — 훅이 명령을 삼켜서는 안 된다.

> **가로채는 scheme 을 http/https 로 좁힌 것은 구현 중의 결정이다.** 처음에는
> 임의 scheme(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)을 가로챌 생각이었으나, 그러면
> `open vscode://file/...` 과 `open mailto:...` 이 깨진다 — 서버는 어차피
> http/https 만 받으므로(FR-VUO-18) 가로챈 뒤 거절하는 것보다 애초에 넘기지 않는
> 쪽이 옳다.
>
> `open .`, `open a.pdf`, `open -a Xcode f.swift` 를 가로채면 안 된다. PATH 앞에
> `/usr/bin` 이 있으므로 심볼릭 링크 shim 은 애초에 듣지 않는다 — 함수여야 한다.

**FR-VUO-15** 서버 자신과 `dmctl` 은 이 함수의 영향을 받지 않는다. zsh 함수는 그
쉘 안에서만 살고, FR-VUO-2 의 로컬 실행은 `command`/절대 경로로 원래 바이너리를
직접 부른다. **재귀는 성립하지 않는다.**

### 2.4 프로토콜 (FR-VUO-16~18)

**FR-VUO-16** `openUrl` 을 `AllowedCmdActions` 와 `singleExecutorActions` 에 등록한다.
새 엔티티를 만들지 않으므로 `creatingActions` 에는 넣지 않는다 — reqId 에코가 없다.

**FR-VUO-17** 액션 인자는 `{"url":"<원본 URL>"}` 다. 재작성은 뷰어가 한다 —
자기가 어떤 주소로 서버에 닿았는지 아는 것은 뷰어뿐이다.

**FR-VUO-18** 서버는 URL 을 검증한다. scheme 이 `http`·`https` 가 아니면 400 으로
거절한다. `javascript:`·`file:`·`data:` 를 뷰어에 실어 보내지 않는다.

### 2.4a 진단 (FR-VUO-19)

**FR-VUO-19** `GET /api/open-url/where` 는 **판정만** 낸다 — 열지 않고
브로드캐스트도 하지 않는다. 응답은 `where`·`viewer`·`viewerAddr`·`subscribers`·
`forced`·`loopback` 이다.

> 이 종단이 없으면 사용자는 자기 환경이 R1 의 오판 상태인지 알 방법이 없다.
> 판정이 실행에 붙어 있으면 "지금 열면 어디서 열리는가" 를 물으려면 실제로 열어
> 봐야 하고, **오판일 때 그 창은 사용자가 볼 수 없는 곳에 뜬다** — 즉 물어볼
> 방법이 없는 것과 같다. `viewerAddr` 과 `forced` 를 함께 내는 이유는 결과만으로는
> "왜 그렇게 판정됐는가" 에 답할 수 없기 때문이다.

### 2.5 비목표

- 서버 로컬 포트를 원격에 노출하는 프록시·터널 (FR-VUO-11)
- 브라우저 선택 (기본 브라우저만)
- 확인 이력·화이트리스트 기억 (FR-VUO-5 가 금지)
- Windows 쉘의 자동 가로채기 — `dmctl open-url` 직접 호출만 지원 (FR-VUO-14 는 zsh·bash)

---

## 3. 검증

| # | 대상 | 방법 |
|---|---|---|
| V1 | `Executor()` 가 뽑은 뷰어의 로컬/원격 판정 | Go 유닛 — loopback·사설IP·미구독 |
| V2 | `openUrl` 이 두 화이트리스트에 있고 `creatingActions` 에는 없음 | Go 유닛 |
| V3 | `POST /api/commands` 가 `openUrl` 에 `execClientId` 를 붙임 | Go 유닛 |
| V4 | `dmctl open-url` 이 `local` 응답에 로컬 실행, `remote` 응답에 미실행 | Go 유닛 (실행자 주입) |
| V5 | 비-http scheme 400 | Go 유닛 |
| V6 | `DONGMINAL_URL_OPEN` 강제 | Go 유닛 |
| V7 | localhost 재작성 (5개 host 형태 · 포트/경로/쿼리 보존 · 외부 host 불변) | e2e |
| V8 | 확인 팝업 → `열기` 클릭이 제스처 안에서 `window.open` 호출 | e2e (`window.open` 스텁) |
| V9 | 지명받지 못한 클라이언트는 팝업을 띄우지 않음 | **V2 에 위임** (아래) |
| V10 | `open .` 등 6가지가 위임되고 `open https://x` 만 가로채짐 | 실 zsh·bash 실행 |
| V11 | `BROWSER` 가 `open-url` 헬퍼를 가리킴 | Go 유닛 |
| V12 | 실제 SSE 요청의 `r.RemoteAddr` 이 Focus 까지 흘러감 | Go 통합 (실 SSE 구독) |
| V13 | 터널 뒤 뷰어가 로컬로 판정되고 브로드캐스트가 나가지 않음 (R1 기록) | Go 통합 |
| V14 | `DONGMINAL_URL_OPEN=viewer` 가 V13 의 상황을 구제하고, scheme 방어는 유지 | Go 통합 |
| V15 | 진단 종단이 판정·뷰어·주소·구독수·강제모드를 내고 **부작용이 없음** | Go 유닛 |
| V16 | `Esc` 와 상자 밖 클릭이 취소와 같음 | e2e |

**V12 가 왜 따로 필요한가.** 다른 검증은 `AttachFrom` 을 직접 부른다. 그래서
`commands.go` 의 SSE 핸들러가 주소를 넘기지 않아도 전부 통과한다 — 실제로 그 줄을
`Attach` 로 되돌려 확인했고, V12·V13 만 실패한다. 판정의 근거가 요청에서
Focus 까지 실제로 이어지는지 재는 것은 이 둘뿐이다.

**V13 은 결함을 고정하는 테스트다.** 오판은 정보 부족의 결과이지 버그가 아니다
(R1). 이 테스트가 실패하면 누군가 판정 규칙을 바꾼 것이고, 그때 R1 과
`DONGMINAL_URL_OPEN` 의 존재 이유를 다시 봐야 한다는 뜻이다.

**V9 을 e2e 로 두지 않은 이유.** 지명 게이트는 `event-bus.js:217` 한 곳이고 모든
단일 실행자 액션이 그 길을 지난다. `openUrl` 이 그 목록에 있다는 것(V2)이 곧 이
보장이며, 이것을 다시 재려면 클라이언트 둘과 원격 판정 강제가 필요해 비용이
보장의 크기를 넘는다.

### 3.1 구현 위치

| 대상 | 파일 |
|---|---|
| 뷰어 판정 | `internal/webserver/hub/focus.go`(`AttachFrom`·`ExecutorAddr`) |
| URL 검증·판정·진단 | `internal/webserver/httpapi/openurl.go` |
| 액션 배선 | `internal/webserver/httpapi/commands.go`·`hub/commands.go` |
| CLI | `internal/helper/runtimebin/openurl.go` |
| 로컬 실행 | `internal/shared/platform/opener.go` |
| 뷰어 UI | `web/js/ui/open-url.js`(`UIKit.modal`)·`web/js/core/app-cmd.js` |
| 쉘 훅 | `internal/shared/runtime/shellhooks/posix/{bash-hook.sh,zdotdir/.zshrc}` |
| BROWSER | `internal/shared/toolhub/tool.go`(`toolBrowserEnv`) |
| 검증 | `*_test.go` 6개 (R1: `httpapi/openurl_tunnel_test.go`) · `e2e/viewer-url-open.spec.ts` |

## 4. 리스크

| # | 등급 | 내용 | 완화 |
|---|---|---|---|
| R1 | **HIGH** | `ssh -L` 포트 포워딩으로 접속하면 SSE 의 원격 주소가 loopback 이라 **원격 뷰어를 로컬로 오판**한다 → 서버 머신에서 창이 열려 사용자가 못 본다 | FR-VUO-6 의 `DONGMINAL_URL_OPEN=viewer`. 근본 해결은 불가 — 클라이언트의 `location.hostname` 도 그 경우 `localhost` 다 |
| R2 | MEDIUM | `open` 함수가 URL 아닌 인자를 가로채면 파인더·앱 실행이 깨진다 | FR-VUO-14 의 엄격한 scheme 정규식 + 인자 1개 조건, V10 |
| R3 | MEDIUM | 재작성한 host 에 서비스가 바인딩되어 있지 않아 연결 실패 | FR-VUO-11 — 사용자에게 브라우저 오류로 드러난다. 스펙 범위 밖 |
| R4 | LOW | 뷰어가 확인 팝업을 무시하면 열기 요청이 조용히 사라진다 | FR-VUO-7 의 비소멸 팝업. `dmctl` 은 이미 종료했으므로 쉘은 막히지 않는다 |
