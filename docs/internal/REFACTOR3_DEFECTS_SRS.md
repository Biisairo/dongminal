# SRS: 리팩토링 3차 P1 — 확인된 결함 아홉 — IEEE 29148

> **문서 상태**: 승인·구현완료

- 접수: 2026-11-21 (프로덕션 리팩토링 3차 · `docs/internal/refactor/PROD3.md` §1 · 묶음 P1)
- 선행: `PROD3.md` §1 「결함 — 먼저 고칠 것」. 사용자 결정(2026-11-21): 목록 전부를 진행한다. 묶음 사이에는 간단한 시험만 돌리고, 전체 시험은 마지막에 한 번 돌린다.

## 1. 개요

### 1.1 목적

3차 조사에서 찾은 결함 가운데 코드에서 확인된 것을 고친다. 결함은 정확성·보안·계약 위반이다. 리팩토링(구조 변경)은 이 묶음의 일이 아니다.

### 1.2 범위

| 묶음 | PROD3 ID | 자리 | 축 |
|---|---|---|---|
| **A** 테마 값 검증 | FC-F1 | `web/js/core/theme-vars.js` · `app-settings.js` · `app-settings-theme.js` | 프론트 |
| **B** Run 복사 | GD-F1 | `internal/webserver/domain/run/store_write.go` `ReapTargets` | 서버 |
| **C** 저장 경합 | GH-F4 | `internal/webserver/httpapi/handlers_files.go` `apiFileWrite` | 서버 |
| **D** 상한 초과 코드 | GH-F1 · GH-F2 | `httpapi` toolio·lsp·fs 디코더 · `gitapi` 디코더 셋 | 서버 |
| **E** 텔레그램 잠금 | GD-F2 | `internal/webserver/domain/telegram/bridge*.go` | 서버 |
| **F** 새로고침 간격 | GD-F3 | `internal/webserver/domain/claudeacct/engine.go` `FetchNow` | 서버 |
| **G** `dmctl edit` 종료 코드 | DM-F1 | `internal/helper/runtimebin/edit.go` | CLI |
| **H** 채팅 이름 정화 | DM-F2 | `internal/daemon/chatsock/chatsock.go` `clean` | 데몬 |
| **I** 서랍 아이콘 | FC-F2 · FC-01 | `web/js/core/app-mobile.js` `_toggleDrawer` 와 호출처 | 프론트 |

### 1.3 범위 밖 (이 묶음에서 고치지 않는 것)

| PROD3 ID | 이유 |
|---|---|
| GH-F3 (디코드 오류 문구를 본문에 싣는다) | git 디코더의 주석이 이것을 **의도**로 적었다(*"사유를 그대로 준다 — 클라이언트가 자기 요청의 어디가 틀렸는지 알아야 한다"*). 결함이 아니라 설계의 선택이다. P2 의 오류 렌더러 통합에서 방언 규칙과 함께 다시 본다 |
| GH-F5 (도구 RPC 시한 초과가 연결을 끊는다) | 설계 검토가 필요하다. 빈도를 재지 않았다. P5 에서 다시 본다 |
| DM-F3 · DM-F4 · DM-F5 | 서버가 `delivered` 를 늘 싣고(`commands.go:279·290·310`), `toolId` 는 UUID 이며, 계정 응답은 객체다. 실제로 일어나지 않는다. 중복 정리(P2 DM-1)에서 함께 고친다 |
| 서버의 `customTheme` 검증 | §4 D-RD3-1 |

### 1.4 용어

| 용어 | 뜻 |
|---|---|
| 스탬프 | 편집기가 파일을 읽을 때 받은 디스크 상태의 표식(`stampOfPath`). 저장 요청에 실어 보낸다 |
| Cf | 유니코드 서식 문자 범주. bidi 재정렬 문자(U+202E 등)와 zero-width 문자(U+200B 등)가 속한다 |
| 방언 | 오류 본문의 모양. 공개 계약이다(`architecture.md`). 이 묶음은 방언을 바꾸지 않는다 |

## 2. 배경 — 무엇이 틀렸나

| 묶음 | 지금 동작 | 맞는 동작 |
|---|---|---|
| A | 저장된 `customTheme` 의 값을 검증하지 않는다. 테마 미리보기가 그 값을 `innerHTML` 의 `style="…"` 안에 넣으므로, 따옴표가 든 값은 속성을 벗어나 마크업이 된다. 설정은 다른 기기로 방송된다 | 색이 아닌 값은 화면에 닿기 전에 버린다 |
| B | `ReapTargets` 가 Record 를 얕게 복사한다. 돌려준 값의 `Members` 와 `Worktree` 포인터를 저장소와 공유하므로, 잠금 밖에서 읽는 동안 `MarkWorktrees` 가 같은 자리를 쓴다 | 같은 패키지의 다른 조회처럼 `cloneRun` 으로 복사한다 |
| C | 스탬프 검사와 원자 쓰기 사이에 잠금이 없다. 두 저장이 같은 스탬프를 보면 둘 다 통과해서 뒤의 쓰기가 앞을 덮는다(FR-EXC-5 가 막으려던 경우) | 같은 경로의 검사~쓰기~새 스탬프는 한 번에 하나만 돈다 |
| D | 1 MiB 를 넘는 본문에 toolio·lsp 방언은 `413 too_large`, fs 방언은 `400 bad_request`, git 방언은 `413 bad_request` 를 낸다 | 공개 계약(`features.md` 용량 표 「JSON 본문 → `413` · `body_too_large`」)대로 `413` + `body_too_large` |
| E | 작업자가 `b.mu` 를 쥔 채 Telegram HTTP 를 부른다(호출당 상한 15초). polling 의 `handleUpdate` 도 같은 잠금을 기다리므로, 알림 한 건이나 버튼 N개를 걷는 동안 업데이트 수신이 멈춘다. 탭마다 `[읽음]` 버튼 목록이 상한 없이 늘어난다 | 잠금은 상태(`tabs`·`buttons`)만 지킨다. HTTP 는 잠금 밖에서 부른다. 버튼 목록에 상한이 있다 |
| F | `FetchNow` 가 최소 간격 검사를 `e.busy` 잠금 밖에서 하고, 잠금을 얻은 뒤 다시 보지 않는다. 새로고침이 겹치면 둘 다 통과해서 같은 계정을 두 번 조회한다 | 잠금을 얻은 뒤에 저장소를 읽고 간격을 검사한다 |
| G | `dmctl edit` 이 응답 상태를 버린다. 서버가 400·500 을 줘도 본문을 찍고 exit 0 이다 | 같은 패키지의 `dmctlHTTPResult` 규칙대로 4xx·5xx 는 exit 1 |
| H | 채팅 소켓의 `clean` 이 제어 문자만 지우고 Cf 는 남긴다. 같은 규칙의 다른 일곱 자리는 Cf 도 지운다. 결과는 이름과 붙여넣기로 터미널에 찍힌다 | Cf 도 지운다 |
| I | 모바일 서랍을 닫는 경로 가운데 둘(같은 창을 다시 고른 경우 · 채팅방을 연 경우)이 상단바를 다시 그리지 않아 ☰/✕ 아이콘이 낡는다. 나머지 다섯 경로는 `_toggleDrawer(false); renderer._rTopbar()` 를 복사해 쓴다 | 서랍 상태를 바꾸는 함수가 상단바도 다시 그린다 |

## 3. 요구사항

### 3.1 A — 테마 값 검증

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-1 | `sanitizeCustomTheme(t)` 는 `t` 가 객체가 아니면 `null` 을 돌려준다. 객체이면 `{mode, ui, terminal}` 을 새로 만든다. `mode` 는 `'dark'`·`'light'` 가 아니면 `'dark'` 다. `ui`·`terminal` 은 원래 객체의 키 가운데 값이 `#rrggbb` 또는 `#rrggbbaa`(16진수, 대소문자 무관)인 것만 싣는다. 그 밖의 키와 값은 싣지 않는다 | 필수 |
| FR-RD3-2 | 빠진 색 키는 기본 테마(`THEMES['Tokyo Night']`)의 같은 칸 값으로 채운다. 그래서 돌려준 객체는 화면이 읽는 키를 모두 가진다 | 필수 |
| FR-RD3-3 | 저장된 설정을 적용하는 자리(`app-settings.js` 의 `saved.customTheme`)는 `sanitizeCustomTheme` 를 거친 값만 `customTheme` 에 넣는다. 결과가 `null` 이면 사용자 정의 테마가 없는 것으로 본다 | 필수 |
| FR-RD3-4 | 내장 테마 54종은 모두 FR-RD3-1 을 그대로 통과한다(값이 바뀌지 않는다) | 필수 |

### 3.2 B — Run 복사

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-10 | `ReapTargets` 가 돌려준 Record 의 `Members` 배열과 `Worktree` 포인터는 저장소 내부와 공유되지 않는다 | 필수 |

### 3.3 C — 저장 경합

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-20 | `apiFileWrite` 는 같은 대상 경로(심링크를 따라간 뒤)에 대해 스탬프 검사부터 새 스탬프 계산까지를 한 번에 하나씩 처리한다 | 필수 |
| FR-RD3-21 | 같은 스탬프를 든 저장 둘이 동시에 오면, 하나는 `200`, 다른 하나는 `409 file_changed` 다 | 필수 |
| FR-RD3-22 | 다른 경로의 저장은 서로 기다리지 않는다. 잠금 표는 쓰는 동안만 항목을 두고, 다 쓰면 지운다(경로 수만큼 쌓이지 않는다) | 필수 |

### 3.4 D — 상한 초과 코드

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-30 | 본문 읽기 실패의 코드는 `apierr.BodyReadCode(err)` 한 곳에서 정한다. 상한 초과는 `body_too_large`, 나머지는 `bad_request` 다. `httpapi` 의 `bodyReadCode` 는 없앤다 | 필수 |
| FR-RD3-31 | toolio 방언(`decodeJSONBody`)과 lsp(`lspReadBody`)의 상한 초과는 `413` + `X-Error-Code: body_too_large` 다. 본문 모양(`{"error": 문구}`)은 바뀌지 않는다 | 필수 |
| FR-RD3-32 | fs 방언(`fsDecode`)의 상한 초과는 `413` + 본문·헤더 `code: body_too_large` 다 | 필수 |
| FR-RD3-33 | git 방언(`gitDecodeBody`·`gitDecodeRawPath`·`handlers_git.go` 의 둘째 디코더)의 상한 초과는 `413` + `body_too_large` 다 | 필수 |
| FR-RD3-34 | 상한 안의 정상 요청과, 상한 안의 깨진 JSON 은 종전과 같은 상태·코드다 | 필수 |

### 3.5 E — 텔레그램 잠금

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-40 | `Bridge.mu` 는 `tabs`·`buttons` 를 읽고 쓰는 동안만 쥔다. Telegram HTTP 호출(`call`·`dropButton`·`answer`·`reply`)은 `mu` 를 쥐지 않은 채 부른다 | 필수 |
| FR-RD3-41 | 작업자가 HTTP 응답을 기다리는 동안에도 `handleUpdate` 는 `mu` 를 기다리지 않는다 | 필수 |
| FR-RD3-42 | 탭 하나의 `[읽음]` 버튼 목록은 최대 `maxButtonsPerTab`(32)개다. 넘으면 가장 오래된 것을 목록에서 뺀다(그 메시지의 버튼은 남지만 눌러도 FR-TGB-58a 대로 답한다) | 필수 |
| FR-RD3-43 | 알림·`[읽음]`·짝맞춤의 동작과 문구는 바뀌지 않는다. 기존 `bridge_test.go` 가 그대로 통과한다 | 필수 |

### 3.6 F — 새로고침 간격

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-50 | `FetchNow` 는 `e.busy` 를 얻은 **뒤에** 저장소를 읽고 최소 간격(`fetchNowMinGapS`)과 `BackoffUntil` 을 검사한다 | 필수 |
| FR-RD3-51 | 같은 계정에 `FetchNow` 둘이 겹치면 조회는 한 번이고, 뒤의 호출은 `ErrTooSoon` 이다 | 필수 |

### 3.7 G — `dmctl edit`

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-60 | `dmctl edit` 은 응답 상태가 4xx·5xx 면 오류를 stderr 에 쓰고 exit 1 이다. 2xx 의 출력은 종전과 같다 | 필수 |

### 3.8 H — 채팅 이름 정화

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-70 | `chatsock.clean` 은 제어 문자와 U+FFFD 에 더해 Cf 범주의 문자를 지운다 | 필수 |

### 3.9 I — 서랍 아이콘

| ID | 요구 | 우선 |
|---|---|---|
| FR-RD3-80 | `_toggleDrawer` 는 서랍 상태를 바꾼 뒤 상단바를 다시 그린다(`renderer._rTopbar`). 렌더러가 아직 없으면 건너뛴다 | 필수 |
| FR-RD3-81 | `_toggleDrawer(…)` 바로 뒤에 `renderer._rTopbar()` 를 따로 부르던 다섯 자리는 그 호출을 지운다 | 필수 |

## 4. 결정

| ID | 결정 | 이유 |
|---|---|---|
| D-RD3-1 | **A 는 클라이언트에서만 막는다.** 서버의 `PUT /api/settings` 는 지금 설정 블롭의 JSON 여부만 보고, 키별 스키마 검증을 하지 않는다(스키마 검증은 `dongminal config` 만 한다). 서버에 키별 검증을 새로 세우면 새 오류 코드와 문서가 필요하고, 옛 판이 저장한 값 때문에 **설정 저장 전체가 거절**될 수 있다 | 실행 경로(화면에 닿는 자리)를 막으면 주입은 일어나지 않는다. 서버 검증은 P2 의 설정 스키마 정리에서 다시 본다 |
| D-RD3-2 | A 의 미리보기 코드(`innerHTML` 템플릿)는 이 묶음에서 바꾸지 않는다 | 들어오는 값을 FR-RD3-1 이 이미 막는다. 미리보기를 DOM API 로 바꾸는 일은 FC-12(P4)다 |
| D-RD3-3 | C 의 잠금은 경로별 참조 계수 잠금이다. 서버 전역 `fsOps` 를 쓰지 않는다 | `fsOps` 는 큰 복사·삭제 전 구간을 잡는다(PROD3 GH-17). 저장이 그 뒤에 줄 서면 편집기 저장이 멎는다 |
| D-RD3-4 | E 의 버튼 상한은 32 다 | 탭 하나에 읽지 않은 알림이 32개를 넘는 것은 사용자가 그 탭을 보지 않는다는 뜻이다. 오래된 것의 버튼을 걷지 못해도 눌렀을 때의 답은 같다 |

## 5. 동작 변경 기록

| 묶음 | 이전 | 새 | 이유 |
|---|---|---|---|
| A | 색이 아닌 테마 값도 그대로 적용됐다 | 그 키는 기본 테마 값이 된다 | 주입 차단 |
| D | toolio·lsp `413 too_large` · fs `400 bad_request` · git `413 bad_request` | 모두 `413 body_too_large` | 공개 계약 |
| E | 탭의 버튼 목록이 끝없이 늘었다 | 32개까지 | 메모리·걷기 시간 상한 |
| F | 겹친 새로고침이 두 번 조회했다 | 한 번 조회하고 뒤의 것은 `ErrTooSoon` | 최소 간격 규칙 |
| G | 4xx·5xx 에도 exit 0 | exit 1 | CLI 규약(`dmctlHTTPResult`) |
| H | bidi·zero-width 문자가 남았다 | 지운다 | 다른 일곱 자리와 같은 규칙 |

## 6. 검증

| ID | 시험 | 묶음 |
|---|---|---|
| TC-RD3-1 | 단위(JS): `sanitizeCustomTheme` — 따옴표가 든 값·`url(...)`·숫자·중첩 객체는 기본값으로, 정상 hex 는 그대로, 객체가 아니면 `null`, `mode` 가 이상하면 `'dark'` | A |
| TC-RD3-2 | 단위(JS): 내장 테마 54종이 그대로 통과한다 | A |
| TC-RD3-10 | 단위(Go): `ReapTargets` 결과의 `Members[0]`·`Worktree` 를 고쳐도 `Get` 의 결과가 바뀌지 않는다 | B |
| TC-RD3-20 | 단위(Go): 같은 경로·같은 스탬프의 저장 둘을 동시에 보내면 하나는 200, 하나는 409 다(첫 쓰기 안에서 둘째가 끼어들도록 쓰기 훅으로 순서를 고정한다) | C |
| TC-RD3-21 | 단위(Go): 저장이 끝나면 잠금 표가 비어 있다 | C |
| TC-RD3-30 | 단위(Go): toolio·fs·git 종단에 상한을 넘는 본문을 보내면 `413` + `X-Error-Code: body_too_large` 다. fs 는 본문 `code` 도 같다 | D |
| TC-RD3-40 | 단위(Go): 작업자의 HTTP 가 막혀 있는 동안 `handleUpdate` 가 돌아온다 | E |
| TC-RD3-41 | 단위(Go): 같은 탭에 알림 40개를 보내면 버튼 목록은 32개다 | E |
| TC-RD3-50 | 단위(Go): `FetchNow` 둘을 동시에 부르면 조회 함수가 한 번 불리고, 하나는 `ErrTooSoon` 이다 | F |
| TC-RD3-60 | 단위(Go): 서버가 400 을 주면 `dmctl edit` 이 1 을 돌려준다 | G |
| TC-RD3-70 | 단위(Go): `clean("a‮b​c")` 가 `"abc"` 다 | H |
| TC-RD3-80 | 단위(JS): `_toggleDrawer(false)` 가 `renderer._rTopbar` 를 부른다 | I |

모든 시험은 고치기 전 코드에서 실패하는 것을 먼저 본다(RED). 그 밖에 `make gates` · `npm run -s unit` · `npm run -s typecheck` · `go test` (바뀐 패키지)를 돌린다. e2e 전량은 사용자 결정에 따라 모든 묶음이 끝난 뒤에 돌린다.

## 7. 구현 기록 (2026-11-21)

- 묶음 A~I 를 모두 구현했다. 시험 열두 개(TC-RD3-1·2·10·20·21·30·40·41·50·60·70·80)는 고치기 전 코드에서 실패하는 것을 먼저 보았다. TC-RD3-20 은 옛 코드에서 같은 표식의 저장 8건 가운데 6건이 이겼다.
- 기존 시험 하나를 바꿨다: `lsp_body_limit_test.go` 가 `too_large` 를 단언하고 있었다. FR-RD3-31 대로 `body_too_large` 로 바꾸고 이전/새/이유를 적었다.
- 함께 한 정리: `apiGitReorder` 가 디코드를 손으로 하던 것을 `gitDecodeBody` 로 바꿨다(같은 실패 규칙을 얻는다). `_toggleDrawer` 뒤에 `_rTopbar()` 를 따로 부르던 다섯 자리를 지웠다(PROD3 FC-01 의 절반).
- 공개 문서: `CHANGELOG.md [Unreleased] 고침` 여덟 줄, `docs/external/api.md` 의 fs 오류 코드 목록에 `body_too_large`.
- 검증: `make gates` · `npm run -s unit`(1157 통과) · `npm run -s typecheck` · `go vet ./...` · 바뀐 패키지의 `go test`(`run`·`telegram`·`claudeacct` 은 `-race`). e2e 는 사용자 결정에 따라 마지막에 한 번 돌린다.
