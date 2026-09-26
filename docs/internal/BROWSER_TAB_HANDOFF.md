# 인수인계 — 브라우저 탭 구현 (0단계 → 4단계)

> 근거 SRS: `REQUEST_GATE_ORIGIN_PORT_SRS.md`(0단계) · `BROWSER_TAB_SRS.md`(1~4단계).
> 조사·결정: `BROWSER_TAB_INVESTIGATION.md`. 브랜치 `main`.

## 착수 블록 — 이번 세션의 지시 전부

1. **사용자에게 묻지 않고 끝까지 진행한다** (사용자 지시). 결정이 필요하면 SRS 와 조사 문서의
   결정(D1~D17, D-BRT-1~19)에서 답을 찾고, 거기 없으면 **더 단순한 쪽**을 골라 그 SRS 의 변경
   기록에 "구현 중 결정" 으로 적는다. 스펙과 코드가 충돌하면 스펙을 먼저 개정하고 진행한다.
2. 순서는 고정: **0단계 → 1단계 → 2단계 → 3단계 → 4단계.** 단계마다 Spec → Test(RED) → Code(GREEN).
3. **모든 구현이 끝나면 사용자에게 알린다** — 최종 보고(단계별 결과·남은 위험·커밋 목록)를 화면에
   남기고 `dmctl notify "브라우저 탭 구현 완료"` 로 주의 알림을 세운다.
4. 먼저 `REQUEST_GATE_ORIGIN_PORT_SRS.md` §3·§4 부터 시작한다.

## 0. 한 줄 상태

**문서만 끝났다. 코드는 한 줄도 바뀌지 않았다.** 조사·인터뷰(결정 17건)·macOS PoC 8건·SRS 두 벌이
저장소에 있다.

## 1. 어디까지 왔나

| 산출물 | 상태 |
|---|---|
| `BROWSER_TAB_INVESTIGATION.md` | 조사·결정 기록 (갱신하지 않는다 — 기록이다) |
| `REQUEST_GATE_ORIGIN_PORT_SRS.md` | 승인·구현중 (구현 0건) |
| `BROWSER_TAB_SRS.md` | 승인·구현중 (구현 0건) |
| `REQUEST_GATE_SRS.md` | FR-RQG-3·7·TC-RQG-30 개정 표시 반영됨 |
| `README.md`(내부) · `decisions.md` | 색인 등록 · 재생성(`go run ./scripts/gen-decisions`) |

근거 커밋: 이 문서와 함께 들어간 `docs(browser): …` 커밋 (엔벨로프에 해시).

## 2. 남은 일과 순서

| # | 할 일 | 끝나는 조건 |
|---|---|---|
| 0 | 요청 게이트 authority 판정 (FR-ROP-1~8) — `reqgate.go` · 시험 · TC-RQG-30 수정 · `SECURITY.md` §6 · `CHANGELOG.md` | ROP §4 전부. **§1.1 의 curl 재현이 403** |
| 1a | **위험 먼저**: Windows pipe(`lpReserved2` + `CreateProcessW` + Job Object) — FR-BRT-5 · TC-BRT-6 | Windows CI 에서 초록. 이 기기(macOS)에서는 돌릴 수 없다 — CI 잡이 판정한다 |
| 1b | 엔진 탐색·기동·수명·프로필·CDP 층(pipe·다중화) — 묶음 E·P·C(FR-BRT-20·21) | §4.1~4.3(TC-BRT-24 제외) |
| 1c | `browser` 탭 — 스트림 종단·뷰어(canvas·입력·IME 기본·키 배분·확대·주소창)·`base-select` — 묶음 T·V | §4.4·4.5 |
| 1d | 훅 전환·옛 방식 제거·링크 라우팅·scheme·`dmctl browser` 1단계 명령 — 묶음 H·L·S·A(1단계) | §4.6 |
| 2 | 관찰·조작·대기·진단·CDP 프록시·외부 도구 페이지·오버레이 | §4.7·4.8, TC-BRT-24 |
| 3 | 충실도 묶음 F·Q | §4.9 |
| 4 | 오디오 PoC → 성공 시 FR-BRT-91, 실패 시 비목표로 옮기고 SRS 개정 | §4.10 |
| 끝 | 두 SRS 의 상태를 `승인·구현완료` 로, `VIEWER_URL_OPEN_SRS` 를 `대체` 로. 문서 검사 전부 | 아래 §5 |

## 3. 먼저 읽을 것

1. `BROWSER_TAB_INVESTIGATION.md` 전체 — 특히 §5(제약 근거)·§7(결정)
2. `REQUEST_GATE_ORIGIN_PORT_SRS.md` 전체
3. `BROWSER_TAB_SRS.md` §2.2(PoC 결과)·§2.3(제약)·§3·§4·§6
4. `REQUEST_GATE_SRS.md` §3.1·§3.2 — 게이트의 기존 계약
5. `docs/internal/architecture.md` — 프로세스 역할 넷(데몬/웹서버/direct mode)
6. 코드 자리는 `BROWSER_TAB_SRS.md` §1.4 에 줄 번호까지 있다

## 4. 이 세션이 값을 치르고 배운 것

- **`gateExempt`(`reqgate.go:157`) 는 `/api/` 로 시작하지 않고 `/ws` 도 아닌 경로를 정적 자산으로 보고
  게이트를 건너뛴다.** 새 종단(`/ws/browser` 같은)을 그 밖에 두면 게이트 없는 셸이 된다 → 전부 `/api/` 아래.
- **Origin 판정의 포트 무시**는 실측으로 확인했다: `Origin: http://localhost:3000` 의 `/ws` 핸드셰이크가
  101. 재현은 가짜 tool id 로 하라(`/ws?tool=nonexistent-…`) — `tool` 을 빼면 셸이 실제로 생긴다.
- `tailscale serve` 는 `Host` 를 원본 보존한다(포트 없음). authority 비교는 **스킴을 보지 않고, 기본 포트를
  추론하지 않는다** — 이유는 ROP FR-ROP-2.
- **PoC 코드**: `/tmp/brres/poc/main.go` (표준 라이브러리만, pipe 로 Chrome 조종). `/tmp` 라 사라질 수 있다 —
  핵심은 SRS §2.2 에 옮겨 두었다. 레퍼런스 클론: `/tmp/brres/{terminal-browser,orca,page-agent}`.
- **`base-select` 함정 둘**: ① `select, ::picker(select){…}` 를 한 선택자 목록으로 묶으면 규칙 전체가 무효 —
  규칙 둘로 ② 문서 시작 시점에 `<style>` 을 붙이면 `head` 가 없어 실패 — 격리 world 의
  `document.adoptedStyleSheets` 로 붙인다(`runImmediately:true`, `worldName`). 이렇게 하면 문서 시작부터 적용되고
  페이지 DOM 에 흔적이 없다.
- 한글 IME: `Input.imeSetComposition`(ㅎ→하→한→한ㄱ→한그→한글) 뒤 `Input.insertText("한글")` 가 정확한 composition
  이벤트 열을 낸다.
- `Target.openDevTools` 는 headless 에서 동작한다 — `devtools://devtools/bundled/devtools_app.html…` 페이지 target.
- `Extensions.loadUnpacked` 는 pipe + `--enable-unsafe-extension-debugging` 에서 동작한다.
- `Target.getTargets` 에는 `browser_ui`·`service_worker`·`background_page`(Chrome 내장 확장)가 섞여 나온다 —
  **`type=="page"` 만 탭**이고, DevTools 페이지(`devtools://`)는 FR-BRT-84 경로로만.
- Playwright `connectOverCDP`: `ws…` 는 그대로, `http…` 는 경로 접두사를 보존하고 `json/version/` 을 붙인다
  (`node_modules/playwright-core/lib/server/chromium/chromium.js:343-350`).
- macOS 에 `timeout` 명령이 없다 — 시간 제한은 Go 코드나 도구 인자로.
- **이 작업 트리에서 다른 세션이 동시에 `main` 에 커밋하고 있다.** 커밋할 때 **자기 파일만 경로로 골라
  `git add`** 하라(`git add -A` 금지). 커밋 전 `git status` 로 남의 변경이 섞였는지 본다.

## 5. 변하지 않는 규약

- `~/.claude/CLAUDE.md` — SDD(스펙 먼저, IEEE 29148) · TDD(단위·경계·실패 시험, 구현 전에 RED) · 최소 구현 ·
  국소 변경 · 심볼 탐색은 LSP → Serena → grep · 동작 변경은 이전/새/이유 기록.
- **커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다** (사내 규정). 형식은 저장소 관례
  (`feat(scope): 한국어 요약 (FR-…)`). 사용자가 "묻지 말고 끝까지" 를 지시했으므로 **단계(또는 묶음)마다
  커밋한다** — 넘긴 뒤 커밋할 사람이 없다.
- 새 런타임 의존 금지 (`go.mod` 의 넷만). CDP 클라이언트는 직접 짓는다. `platform` 밖에 OS 분기 금지
  (`scripts/check-seams.sh`).
- 검사: `make all`(gates·lint·typecheck·unit·test) · `npm run e2e` · 문서 검사
  `scripts/check-{srs-status,srs-progress,decisions,settings-docs,shortcuts-docs,env-docs,commands-docs,api-docs}.sh` ·
  `go run ./scripts/gen-decisions -check`. SRS 상태 줄은 enum, `승인·구현중` 이면 `남은 것` 줄 필수.
- 구현을 끝낸 커밋이 그 SRS 의 상태를 함께 고친다 (`check-srs-status.sh` 규약 ②).

## 6. 아직 유효한 사용자 결정

`BROWSER_TAB_INVESTIGATION.md` §7 의 D1~D17 전부, `BROWSER_TAB_SRS.md` §6 의 D-BRT-1~19. 요지:

- Chrome 만(없으면 설치 요구) · pipe + CDP 프록시, 포트 없음 · 프로필 여럿 동시·설정에서 추가/제거 ·
  여는 위치 토글(분할 기본 = 오른쪽 칸 있으면 새 탭, 없으면 분할 / 새 탭), 재사용 없음, 브라우저 안에서 연 탭은
  그 칸 · 링크 클릭은 설정(기본 내장)·수정키 반대, 프로그램 URL 은 언제나 내장 · 소리 기본 끔 · 다운로드는
  서버에만 · 업로드는 서버 파일만 · 클립보드는 터미널과 같이 뷰어 연동 · `dongminal window` 는 건드리지 않는다.
