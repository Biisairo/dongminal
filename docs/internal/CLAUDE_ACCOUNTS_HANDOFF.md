# 인계: Claude 다중 계정 (CLAUDE_ACCOUNTS_SRS)

이 문서는 다음 세션이 이어서 구현할 수 있도록 지금 상태를 적는다. 진실은 SRS(`CLAUDE_ACCOUNTS_SRS.md`)다. 이 문서와 SRS 가 다르면 SRS 를 따른다.

## 1. 작업 위치와 규칙

- 워크트리: `/Users/dykim/personal/dongminal/.claude/worktrees/claude-accounts`
- 브랜치: `feat/claude-accounts` (로컬 main `710d0ec9` 에서 갈라졌다. origin/main 보다 커밋 하나 앞선 main 이다)
- 1·2단계는 `0356fb6e`, `dmctl account usage`·argv 제거는 `eeffd3ce`, 3단계는 `f14b0425`, 4단계(+statusLine 합치기)는 `73207c0f` 로 커밋했다. 그 뒤의 커밋도 사용자가 확인한 뒤에만 한다. 커밋 메시지에 AI 서명을 넣지 않는다.
- 순서는 단계마다 고정이다: 시험 작성 → RED 확인 → 구현 → GREEN → `make gates`·`golangci-lint`.
- 시험은 실제 키체인과 실제 Anthropic 엔드포인트를 부르지 않는다. 서버 시험은 `Config.ClaudeSecrets` 에 가짜를, `Config.ClaudeAPI` 에 `httptest` 주소를 넣는다.
- 워크트리 세션에서는 `cd ... && cat > 파일 <<EOF` 같은 복합 셸 명령이 거절된다. 파일은 Write/Edit 도구로 쓰고, 셸 명령은 단순하게 나눈다. `tmp/` 대신 `/tmp/` 를 쓴다.

## 2. 사용자 결정 (요약)

SRS §4 에 모두 있다. 자주 볼 것만 적는다.

- 정보보호팀 사전 승인 범위: 토큰 저장, 내부 API 자동 호출, 전환, 자동 전환 (D-CAC-1).
- 등록은 "현재 로그인한 계정 추가" 하나뿐이다 (D-CAC-3).
- 제한 초기화는 수동 + 확인 대화상자만. 자동 전환은 쓰지 않는다 (D-CAC-4).
- statusLine 한도는 계정과 별개로 남기고 **한 줄**로 보인다 (D-CAC-6).
- 탭 지정이 폴더 매핑보다 우선한다. 탭 표시는 배경 틴트(탭 지정 0.28, 폴더 매핑 0.14) (D-CAC-7·9).
- 폴더 매핑 전체 목록은 설정에서만 보인다. 사이드바 Repo·Explorer·탭에는 그 자리에 적용되는 계정만 보인다 (D-CAC-8).
- "웹에서 열기"는 하지 않는다 (D-CAC-13).

## 3. 끝난 것

### 1단계 (묶음 A·B·C, `next` 전환, dmctl list/add/switch)

| 파일 | 내용 |
|---|---|
| `internal/shared/platform/secrets.go` | `Secrets` 인터페이스, macOS 키체인 어댑터(`/usr/bin/security`, `-i` 표준 입력, rc 44 = 없음), 다른 OS 는 `noSecrets` |
| `internal/shared/platform/filelock*.go` | `LockFile(path, timeout)` — POSIX flock, Windows LockFileEx |
| `internal/webserver/domain/claudeacct/creds.go` | `Credential` (모르는 필드 보존, 지문, 공유 필드 병합) |
| `.../paths.go` | `ClaudePaths` (기본 프로필, 프로필 키체인 이름 = `Claude Code-credentials-<sha256(NFC(dir))[:8]>`) |
| `.../live.go`, `backup.go`, `claudecfg.go` | 활성 저장소, 계정 백업(키체인 `dongminal-claude-accounts`), `oauthAccount` 바꿔 끼우기 |
| `.../dirlock.go` | Claude Code 호환 디렉터리 락(`lockClaude`) |
| `.../store.go` | `accounts.json` 과 `Patch` 검증, 색 팔레트 키 `acct-1`~`acct-8` |
| `.../service.go` | 추가, 수정, 순서, 삭제, 전환(분류·보관·되돌림), `SwitchNext` |
| `internal/webserver/httpapi/claude_accounts_*.go` | API 와 배선, SSE `claude_accounts_changed` |
| `internal/helper/runtimebin/dmctl_account.go` | `dmctl account list/add/switch` |
| 문서 | `api.md`, `commands.md`, `errors.md`(생성물), `architecture.md`, `getting-started.md`, `homelayout.go` |

### 2단계 서버 (묶음 D·E)

| 파일 | 내용 |
|---|---|
| `.../oauth.go` | `Client.Refresh`, `ErrReloginRequired`, `Credential.WithTokens` |
| `.../usage.go` | `ParseUsage`, `Usage.Headroom`, `Client.UsageRaw(token, query)` — query 는 3단계의 `at_wall=1&skip_spend=1` 등에 쓴다 |
| `.../pace.go`, `policy.go` | 예측 공식, 조회 주기, 물러나기 |
| `.../engine.go` | 조회 엔진. 활성 계정은 `~/.claude.json` 계정이 일치할 때만 활성 저장소 토큰을 쓴다. 갱신은 활성이면 Claude 락 아래에서 활성+백업에, 아니면 `.consume-<id>.lock` 아래에서 백업에 쓴다 |
| `.../view.go` | `BuildViews` — GET 응답의 `usage` |
| `httpapi` | 엔진 배선, `POST /api/claude-accounts/refresh`, `StartClaudeAccounts`(`cmd/dongminal/app.go` 에서 기동) |

검증: `go test -race` (platform, claudeacct, httpapi, runtimebin, ctl/cli, cmd), `golangci-lint` 0건, `make gates` 통과.

### 2단계 화면 (FR-CAC-90~93)

| 파일 | 내용 |
|---|---|
| `.../claudeacct/view.go` | `UsageLevel`(70/90), `WindowsView` — 창마다 `resetsInSec`·`level` 을 서버가 셈한다 (D-CAC-15). `httpapi.limitLevel` 은 이것을 부른다 |
| `web/js/core/app-claude-accounts.js` | 계정 묶음의 값(`claudeAcctView`)·그리기(`_claudeAcctEl`)·복원·전환·다음 계정·새로 고침·펼침 기억 |
| `web/js/core/app-activity.js` | `limitFootView` → `statusLineView`(한 줄), `limitBarView`(막대 값, 계정 묶음과 함께 씀), 바닥 조립 `{accounts, next, sl}` |
| `state-registry.js` | `claude.accounts` (SSE `claude_accounts_changed`, 패널이 열리면 30초) |
| `contrast.js`·`theme-vars.js`·`style.css` | `--acct-1`~`--acct-8`, 다크·라이트 두 벌 (D-CAC-14). `check-contrast.mjs` 가 54종을 잰다 |
| i18n | `usage.sl.*`, `cacct.*`. 동적 접두 `usage.sl.`·`cacct.st.`·`cacct.wd.` 를 `check-i18n.mjs` 에 등록 |
| 시험 | `web/js/test/claude-accounts-foot.test.mjs` (TC-CAC-21, 15건), `view_test.go` 2건 |

검증: JS 단위 시험 전체, `go test -race` (claudeacct, httpapi, web), `make gates`, `make lint`(golangci-lint), eslint, typecheck, e2e `activity.spec.ts` 15건 통과. TC-ASV-15 의 Usage 바닥 검사를 statusLine 한 줄 모양으로 고쳤다. 계정 묶음의 e2e(TC-CAC-27)는 6단계다.

미룬 것: FR-CAC-92 의 자동 전환 표식과 `next-available`·`best` 는 4단계. 펼친 묶음의 예측은 주간(`sevenDay`)만 그린다 — `scoped` 예측은 서버가 주지만 화면에 그리지 않는다. "초기화 사용…" 은 3단계.

### 4단계 (묶음 G·J·L + statusLine 합치기)

| 파일 | 내용 |
|---|---|
| `.../claudeacct/history.go` | `history.jsonl` 쓰기·자르기(1000줄)·읽기 (FR-CAC-110) |
| `.../claudeacct/smart.go` | `Engine.Switch`(by·전략 셋), `refreshStale`(낡은 계정 먼저 조회), `pickBest`(reason), `decisionUsage`·`mergeWindow`(OAuth+statusLine, FR-CAC-78) |
| `.../claudeacct/lines.go` | 라인 헤드룸·묶는 창 (cswap `lines.py`) |
| `.../claudeacct/autoswitch.go` | `Auto` — 설정 PUT·검증, 판단(트리거·쿨다운·순위 네 전략·되돌아가기 금지·격리·소진 휴식), cswap auto 감지 |
| `.../claudeacct/alerts.go` | 알림 판정 여섯 가지·억제 키(8일)·Telegram 글 |
| `internal/shared/platform/cmdlines_*.go` | `CommandLines()` (`ps -axo args=`, Windows 는 없음) |
| `telegram/bridge.go` | `OnNotice` — 탭과 무관한 글 |
| `httpapi` | `GET /history`, `GET·PUT /autoswitch`, 목록의 `autoswitch`·`statusLine`·`otherStatusLines`, SSE `claude_account_alert`, 계정별 statusLine 저장(`claude_accounts_statusline.go`) |
| `dmctl` | `switch --strategy next\|next-available\|best`(by dmctl), `auto on\|off\|status`, `history`, statusLine 프록시가 계정을 실음 |
| 화면 | foot 머리 줄 표식·"전환 ▾" 메뉴·"기록" 팝업, 알림 토스트, 계정별 statusLine 줄 |

검증: `go test -race`(shared·webserver·helper·daemon·ctl·cmd), `make gates`, `make lint`(golangci-lint 0건), JS 단위 970건, eslint·typecheck(메인 체크아웃의 node_modules). `git/core` 의 `TestNoCredentialFields` 는 HEAD(`428c0432`)에서도 실패한다 — 1단계의 `ErrNoCredentials` 를 잡는다(아래 §5).

## 4. 남은 것 (순서대로)

1. ~~2단계 화면~~ — 끝났다 (§3).
2. ~~`dmctl account usage [<계정>] [--refresh] [--json]`~~ — 끝났다. `internal/helper/runtimebin/dmctl_account.go` `accountUsageCmd`, 시험 `dmctl_account_test.go` (TC-CAC-24 usage 6건). 남은 시간·등급은 서버 값만 쓴다(D-CAC-15). 열 맞춤은 하지 않는다 — 한글 폭을 셀 도우미가 없다.
3. ~~3단계 제한 초기화~~ — 끝났다. `claudeacct/resets.go`(해석·결과 대응·`Client.ClaimReset`), `engine.go`(`fetchResets`·`FetchResetsNow`·`Claim`, 사용량 조회 3번에 1번 상태 조회), `POST /api/claude-accounts/reset`·`refresh {resets:true}`, `dmctl account reset`, 펼친 묶음의 "제한 초기화" 칸과 확인 대화상자. 원본 형식은 Claude Code 2.1.323 바이너리에서 뽑았다(SRS FR-CAC-60a).
4. ~~4단계~~ — 끝났다 (§3).
5. **5단계** 계정별 실행 (묶음 H)과 화면 표시. SRS 빈칸은 **모두 정했다** (2026-11-13, D-CAC-24~28, SRS 머리 개정 (6)). 다시 묻지 말 것. 둘로 나눠 각각 사용자 확인 뒤 커밋한다.
   - **5a — 서버 + shim + dmctl** (먼저):
     - 서버(`claudeacct`): `mappings.json` 저장소(FR-CAC-80, 경로 정규화·Windows 대소문자), 해석(FR-CAC-81), 탭 지정 수명(FR-CAC-81a — 도구 종료 시 지움, 도구 목록을 처음 알 때 정리, 목록 모름이면 안 지움. 착수 때 "재기동 뒤 같은 toolId 로 되살아나는가" 를 코드로 확인), 프로필 준비(FR-CAC-82 — 자격증명은 SRS 대로 프로필 키체인/파일에 쓴다, `.claude.json` 은 D-CAC-26 규칙으로 기본 설정에서 계정 항목만 빼고 가져온다, 공유 항목 링크·대안), 토큰 회수(FR-CAC-86, `Engine.fetch` 앞), 고정 실행 판정(FR-CAC-87, `profiles/<id>/sessions/<pid>.json` 의 `pid` + 생존) → `Auto.candidates` 에서 빼고 FR-CAC-77 을 지운다, 고정 실행 중 갱신(FR-CAC-43 셋째 갈래), 전환 응답 `pinnedRunning`(FR-CAC-36, D-CAC-28), 삭제가 매핑·프로필을 지움(FR-CAC-12).
     - API: `GET·PUT /mappings`, `GET /resolve`(준비 안 함), `POST /launch`(FR-CAC-88, 준비함). SSE `claude_accounts_changed`. `docs/external/api.md`.
     - shim(FR-CAC-83, D-CAC-24·25): `runtimebin/dispatch.go` 의 `commands` 에 `claude` 를 더하고, 설치(`internal/shared/runtime/install.go`)가 `<home>/bin/agent-shims/claude[.exe]` 를 깐다(`homelayout.go` 표도). 세 셸 훅에서 `claude()` 함수를 지우고 사용자 rc 뒤에 PATH 맨 앞 넣기 + 프롬프트마다 맨 앞으로 다시 옮기기. 진짜 claude 는 PATH 에서 `agent-shims` 를 뺀 나머지에서 찾는다. 서버 호출은 `httpJSONWithin`(3초). 연결 거부는 기본 계정으로 실행, 오류·시간 초과는 실행하지 않음(종료 1). POSIX 는 `syscall.Exec`. 기존 래퍼 대조 시험(runtime 패키지의 `PolicyInjection` 대조)이 함수 대신 shim 을 보게 고친다.
     - dmctl: `pin [--tab <toolId>] <계정>|--clear`, `map <계정> [경로]`, `unmap [경로]`, `maps`. `env` 는 두지 않는다.
   - **5b — 화면**: 탭 틴트(FR-CAC-95), Repo 칩(FR-CAC-96), Explorer 칩과 폴더 메뉴(FR-CAC-97), 탭 우클릭 "Claude 계정"(FR-CAC-85), 전환 토스트의 `pinnedRunning` 안내. JS 단위 TC-CAC-22.
   - **이어지는 곳**: statusLine 프록시(`dmctl_statusline.go` `statuslineAccount`)는 이미 `CLAUDE_CONFIG_DIR/.claude.json` 의 계정을 읽는다 — 프로필 `oauthAccount` 를 맞추면 고정 세션의 statusLine 값이 그 계정으로 귀속된다. 프로필 키체인 이름은 `ProfileClaudePaths`(paths.go)에 있다.
   - **참고**: cswap 원본은 `~/.local/share/uv/tools/claude-swap/lib/python3.12/site-packages/claude_swap/`(`session.py` 가 프로필·공유 항목·MCP 미러). cswap 은 프로필 자격증명을 평문 `.credentials.json` 으로 넣고 Claude 가 키체인으로 옮기게 둔다. 우리 SRS 는 키체인에 직접 쓴다(FR-CAC-82) — SRS 를 따른다.

6. **6단계** 설정 "Claude 계정" 구역, 기존 결정 개정(FR-CAC-130: D-ACU-3·D-ASV-2 철회 표시, `ACTIVITY_CARD_USAGE_SRS` 비목표 줄), e2e. `ACTIVITY_STATE_SUBAGENT_SRS` FR-ASV-41(statusLine 창 블록)이 FR-CAC-93 의 한 줄로 바뀐 것도 그 문서에 개정으로 적는다.

## 4a. 이 세션들이 값을 치르고 배운 것

- i18n 키에는 `-` 를 쓸 수 없다(`check-i18n.mjs`). 서버 값(`next-available` 등)으로 키를 만들 때는 `claudeAcctKey` 처럼 `-` 를 `_` 로 바꾼다. 동적 접두는 `check-i18n.mjs` 의 표에 등록한다.
- 새 스크롤 표면(목록 팝업 등)에는 킷 클래스 `ui-scroll-sm` 을 만드는 자리에서 단다. 안 달면 `make gates` 의 스크롤바 검사가 멈춘다.
- SRS 의 결정(D-…)을 고치면 `go run ./scripts/gen-decisions`, apierr 문구를 고치면 `go run ./scripts/gen-errors` 를 돌린다(둘 다 생성물, gates 가 대조).
- 워크트리에 `node_modules` 가 없다. eslint·typecheck 는 메인 체크아웃의 것을 잠시 심링크해 돌린다: `ln -s /Users/dykim/personal/dongminal/node_modules node_modules` → `…/.bin/eslint <파일>`·`…/.bin/tsc --noEmit -p jsconfig.json` → `rm node_modules`(커밋에 넣지 않는다).
- SSE 사건(상태가 아닌 것)은 `state-registry.js` 가 아니라 `app-ws-sync.js` 의 `bus.subscribe` 로 받는다.
- 외부 명령(`ps` 등)은 `internal/shared/platform` 안에만 둔다(`check-seams.sh`). `ProcInfo` 인터페이스를 넓히면 모든 어댑터·가짜를 고쳐야 하므로 독립 함수(예: `CommandLines`)를 쓴다.
- `git/core` `TestNoCredentialFields` 는 1단계부터 실패한다(아래 §5) — 새 실패로 오인하지 말 것.
- 에이전트 GUI 는 완전 폐기다(사용자 지시 2026-11-13). 어댑터의 프로토콜 표면·`fakeagent` 까지 `b196e9f8` 에서 지웠다. 남은 GUI 잔재를 보면 함께 지운다.
- 사용자는 설명 없이 쓴 용어(예: shim)를 싫어한다. 질문 창에는 앞의 설명이 보이지 않을 수 있으니, 질문 안에 필요한 설명을 넣는다.
- `~/.claude.json` 등 사용자 파일은 키 이름만 본다(값은 보지 않는다).

## 5. 끝에 사용자에게 보고할 것

- 5단계 결정: D-CAC-24~28. D-CAC-28(전환 경고는 막지 않는 안내)과 FR-CAC-88(launch API 모양)은 구현자 판단이다.
- GUI 잔재 제거(`b196e9f8`): `M8_UNIFIED_SRS`·`M8_PROGRESS` 는 언어 정책 원문 등을 담고 있어 archive 로 옮기지 않고 개정 표시만 달았다.
- 4단계 결정: D-CAC-17~23 (SRS §4). 스마트 전환은 값을 모르는 계정을 두 전략 모두 건너뛴다. 문턱값은 50~100. 판단은 OAuth·statusLine 중 큰 값.
- `TestNoCredentialFields`(git/core)가 1단계부터 실패한다. `claude_accounts_api.go` 의 `ErrNoCredentials` 줄을 자격증명 자리로 잘못 잡는다. 이름을 바꿀지, 검사의 예외로 둘지 사용자 결정이 필요하다.
- 인계 문서가 가리키던 "FR-CAC-37(헤드룸 정의 표)" 는 SRS 에 없다. 헤드룸 정의는 §1.3 에 있다.

- SRS 의 D-CAC-10 을 ULID 에서 UUIDv7 로 고쳤다(기존 `internal/shared/uuid` 를 쓰기 위해).
- FR-CAC-98 을 모드별 두 벌로 고쳤다(사용자 결정, D-CAC-14). 계정 창 등급·남은 시간을 서버가 셈하도록 GET 응답의 창에 `resetsInSec`·`level` 을 더했다(D-CAC-15).
- 보안 검토 지적으로 키체인 쓰기의 argv 대안을 없앴다(사용자 결정, D-CAC-16). 줄이 4032 바이트를 넘으면 `platform.ErrSecretTooLong` 으로 실패하고, 호출하는 쪽이 권한 600 파일로 내려간다.
- 동작 변경: Usage foot 의 statusLine 값은 창마다 막대 블록이던 것이 한 줄이 됐다(FR-CAC-93). 이전 시험 2건(TC-ASV-14 의 창 블록·바닥 원소)은 TC-CAC-21 로 옮겼다.
- 워크트리에 `node_modules` 가 없어 `make lint` 가 eslint 를 건너뛴다. 메인 체크아웃의 `node_modules` 로 eslint·typecheck 를 따로 돌렸다.
- `scripts/check-home-layout.sh` 는 `dmenv` 상수를 새로 만들어도 `homelayout.go` 표에 없으면 바로 잡지 못했다. 표에 넣은 뒤에야 문서 누락을 잡았다.
- 홈 표 규약상 "보존"과 "백업"을 같은 답으로 맞춰야 해서 `claude-accounts/` 를 백업에도 담는다. macOS 가 아닌 OS 에서는 백업 zip 에 자격증명 파일이 들어간다(`getting-started.md` 에 경고를 적었다).
