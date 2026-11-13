# 인계: Claude 다중 계정 (CLAUDE_ACCOUNTS_SRS)

이 문서는 다음 세션이 이어서 구현할 수 있도록 지금 상태를 적는다. 진실은 SRS(`CLAUDE_ACCOUNTS_SRS.md`)다. 이 문서와 SRS 가 다르면 SRS 를 따른다.

## 1. 작업 위치와 규칙

- 워크트리: `/Users/dykim/personal/dongminal/.claude/worktrees/claude-accounts`
- 브랜치: `feat/claude-accounts` (로컬 main `710d0ec9` 에서 갈라졌다. origin/main 보다 커밋 하나 앞선 main 이다)
- 1·2단계는 `0356fb6e`, `dmctl account usage`·argv 제거는 `eeffd3ce`, 3단계는 `f14b0425` 로 커밋했다. 그 뒤의 커밋도 사용자가 확인한 뒤에만 한다. 커밋 메시지에 AI 서명을 넣지 않는다.
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
5. **5단계** 계정별 실행 (묶음 H)과 화면 표시(탭 틴트, Repo 칩, Explorer 칩). 셸 래퍼는 `internal/shared/runtime/shellhooks/{posix/zdotdir/.zshrc, posix/bash-hook.sh, windows/powershell-hook.ps1}` 의 `claude()`, GUI 기동은 `agentadapter/claude_proto.go` `claudeProtoLaunch`.
6. **6단계** 설정 "Claude 계정" 구역, 기존 결정 개정(FR-CAC-130: D-ACU-3·D-ASV-2 철회 표시, `ACTIVITY_CARD_USAGE_SRS` 비목표 줄), e2e. `ACTIVITY_STATE_SUBAGENT_SRS` FR-ASV-41(statusLine 창 블록)이 FR-CAC-93 의 한 줄로 바뀐 것도 그 문서에 개정으로 적는다.

## 5. 끝에 사용자에게 보고할 것

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
