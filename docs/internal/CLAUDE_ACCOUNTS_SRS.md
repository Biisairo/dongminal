# SRS: Claude 다중 계정 — 등록·사용량·전환·자동 전환·계정별 실행 — IEEE 29148

> **문서 상태**: 승인·구현중
> **남은 것**: 5~6단계. 1~4단계는 끝났다. 인계는 `CLAUDE_ACCOUNTS_HANDOFF.md`
> **개정 2026-11-13 (5)**: statusLine 값을 계정별로 받는다(FR-CAC-78, D-CAC-21). 자동 전환·스마트 전환·알림의 판단은 창마다 OAuth 값과 statusLine 값 중 큰 값을 쓴다. 이전: OAuth 값만(최대 5분 늦음). 이유: statusLine 은 요청마다 갱신되는 실시간 값이라 한도를 놓치지 않는다. 문턱값 범위를 50~100 으로 넓혔다(D-CAC-23). statusLine 줄을 계정별로 보인다(FR-CAC-93, D-CAC-22, D-CAC-6 개정)
> **개정 2026-11-13 (4)**: 4단계 착수. FR-CAC-31a·76·77·100a·110a, D-CAC-17~20 을 더했다. 스마트 전환은 값을 모르는 계정을 두 전략 모두 건너뛴다(D-CAC-17, cswap 은 `next-available` 에서 건너뛰지 않는다)
> **입력**: 2026-11-13 대화. 사용자 요청 "cswap 을 참고하여 같은 방식으로 사용량을 가져오고, 다중 계정 등록·갱신 기간 확인·다중 계정 사용량·계정 전환·자동 전환을 그대로 가져온다". 정보보호팀 사전 승인 범위 = ① 계정별 OAuth 토큰 저장 ② 내부 API 자동 호출 ③ 계정 전환 ④ 자동 전환 (사용자 확인, 2026-11-13). 사용자 결정은 §4 에 적는다
> **개정 2026-11-13 (3)**: 3단계 착수. FR-CAC-60a·65 를 더하고 FR-CAC-63 에 `cooldown`·`unconfirmed`·상태 대응·`request_id` 재사용을 적었다. 근거는 Claude Code 2.1.323 바이너리의 `juniper-tide`·`cedar-ember` 구현이다
> **개정 2026-11-13 (2)**: 키체인 쓰기의 argv 대안을 없앴다(FR-CAC-4, D-CAC-16). 이전: 줄이 4032 바이트를 넘으면 값을 argv 로 넘겼다. 새: 키체인 쓰기를 실패로 돌려 권한 600 파일로 내려간다. 이유: 보안 검토 지적 — argv 는 같은 컴퓨터의 다른 사용자에게 보인다
> **개정 2026-11-13**: FR-CAC-98 을 "모드별 고정 팔레트 두 벌"로 고쳤다(D-CAC-14). 이전: 고정 팔레트 한 벌. 이유: 테마 54종의 다크·라이트 표면 휘도가 겹치지 않아 한 벌로는 3:1 을 넘을 수 없다. 계정 창의 등급·남은 시간을 서버가 셈한다(FR-CAC-91, D-CAC-15)

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)

dongminal 은 지금 Claude 계정 한도를 statusLine `rate_limits` 로만 받는다. 이 값은 그 세션이 API 요청을 보낼 때만 갱신되고, 계정을 구분하지 못한다. 이 SRS 는 cswap(claude-swap v0.29.0, MIT) 의 핵심 동작을 dongminal 서버에 내장한다. 사용자는 Claude 구독 계정을 여럿 등록하고, 계정마다 사용량과 로그인 만료일을 보고, 계정을 손으로 또는 자동으로 전환하고, 탭이나 폴더마다 다른 계정으로 claude 를 실행한다.

### 1.2 범위 (Scope)

- 서버: 계정 저장소, 자격증명 백업과 교체, OAuth 갱신, 사용량 조회기, 제한 초기화 조회와 사용, 자동 전환기, 계정 해석(탭·폴더), 전환 기록, 알림, HTTP API, SSE.
- `dmctl`: `account` 하위 명령, 셸 래퍼의 계정 해석.
- 클라이언트: Activity 하단(Usage foot) 계정 줄과 statusLine 줄, 설정의 "Claude 계정" 구역, 탭 배경 틴트, 사이드바 Repo 목록 칩, Explorer 폴더 칩과 우클릭 메뉴.
- 운영체제: macOS, Linux, Windows.

**미포함:** §6 비목표.

### 1.3 정의 (Definitions)

| 용어 | 정의 |
|---|---|
| **계정** | dongminal 에 등록된 Claude 구독 로그인 하나. 정체는 `(email, organizationUuid)` 쌍이다 (FR-CAC-10) |
| **계정 ID** | dongminal 이 계정에 매기는 고정 식별자. 번호가 아니라 UUIDv7(`internal/shared/uuid`)이다. 순서와 무관하다 |
| **활성 저장소** | Claude Code 가 기본 설정 폴더(`~/.claude`)로 실행될 때 읽는 자격증명. macOS 는 키체인 `Claude Code-credentials`, 그 밖은 `~/.claude/.credentials.json` |
| **활성 계정** | 활성 저장소의 자격증명이 속한 계정 |
| **백업** | dongminal 이 계정마다 보관하는 자격증명 사본과 `oauthAccount` 사본 |
| **프로필** | 계정별 실행에 쓰는 계정 전용 설정 폴더. `CLAUDE_CONFIG_DIR` 로 넘긴다 (묶음 H) |
| **고정** | 탭 지정 또는 폴더 매핑으로 특정 계정의 프로필로 실행되는 것 |
| **창(window)** | 사용량 한도의 단위. `five_hour`, `seven_day`, 모델별 주간 한도(`scoped`) |
| **헤드룸** | `100 - max(고려 대상 창의 사용률)` |
| **라인** | 자동 전환이 계정을 떠나는 사용률. 계정별 문턱값이 있으면 그것, 없으면 전역 문턱값 |
| **제한 초기화** | 서버가 제공하는 한도 즉시 채우기. 주간 5시간 초기화(`juniper_tide`)와 초기화 티켓(`cedar_ember`) 두 프로그램이 있다 (묶음 F) |
| **statusLine 줄** | 기존 statusLine `rate_limits` 값을 한 줄로 줄여 보이는 Usage foot 의 마지막 줄 (FR-CAC-93) |

### 1.4 참고 (References)

- cswap v0.29.0 소스 (`claude_swap/` — `switcher.py`, `credentials.py`, `macos_keychain.py`, `oauth.py`, `usage_store.py`, `poll_policy.py`, `pace.py`, `autoswitch.py`, `lines.py`, `session.py`, `mappings.py`, `claude_locks.py`, `settings.py`)
- Claude Code 2.1.323 바이너리의 `/limit-reset` 구현 (`juniper_tide`, `cedar_ember`, `POST /api/organizations/{org}/reset_rate_limits`)
- `ACTIVITY_STATE_SUBAGENT_SRS.md` FR-ASV-20·21·40~43, D-ASV-2·11 — 지금의 Usage foot
- `ACTIVITY_CARD_USAGE_SRS.md` D-ACU-3 — 개정 대상
- `ISSUE_AGENT_TREE_SRS.md` FR-SLP-* — statusLine 프록시
- `UPDATE_NOTICE_SRS.md` — 서버 주기 점검기의 모양
- `TELEGRAM_BRIDGE_SRS.md` — 알림 경로

### 1.5 개요 (Overview)

§2 는 지금의 사실, §3 은 요구(묶음 A~N), §4 는 결정, §5 는 검증, §6 은 비목표, §7 은 위험이다.

## 2. 현황 (Identified Issue)

### 2.1 지금의 한도 경로

- statusLine 프록시(`internal/helper/runtimebin/dmctl_statusline.go`)가 `rate_limits` 를 `/api/tools/usage` 로 보낸다. 서버는 `rateLimitStore` 에 **agent 단위**(`claude`)로 담는다 (`httpapi/handlers_limits.go`).
- 클라이언트는 `/api/tools/activity` 를 `agentsPollMs`(기본 5초)마다 받아 `limits` 로 Usage foot 을 그린다 (`web/js/core/app-activity.js` `limitFootView`, `_actUsageFootEl`).
- 계정 개념이 없다. 키체인·OAuth 코드도 없다.

### 2.2 막혀 있던 이유와 바뀐 사실

- D-ACU-3 과 D-ASV-2 는 "구독 자격증명으로 직접 조회하는 것은 정보보호팀 승인 대상" 이라는 이유로 직접 조회를 하지 않기로 했다.
- 2026-11-13 사용자가 정보보호팀 사전 승인(§ 머리의 ①~④)을 확인했다. 이 SRS 는 그 승인을 근거로 두 결정을 개정한다 (D-CAC-1).

### 2.3 cswap 의 동작 (요약)

- 계정마다 자격증명을 키체인(`claude-swap` 서비스) 또는 0600 파일로 백업하고, `~/.claude.json` 의 `oauthAccount` 사본을 둔다.
- 전환은 활성 저장소를 대상 계정의 자격증명으로 덮어쓰고 `oauthAccount` 만 바꿔 끼운다. Claude Code 의 디렉터리 락을 지키고 실패하면 되돌린다. 실행 중인 세션은 건드리지 않는다. 키체인 캐시가 약 30초 안에 새 계정을 집는다.
- 사용량은 `GET https://api.anthropic.com/api/oauth/usage` 로 받는다. 조회 주기는 180~600초 사이에서 움직이고, 429 를 받으면 물러난다.
- 자동 전환은 라인·히스테리시스·쿨다운·되돌아가기 금지 규칙으로 흔들림을 막는다.

## 3. 요구 (Requirements)

### 3.A 저장소와 자격증명 계층

- **FR-CAC-1** 계정 데이터는 `<home>/claude-accounts/` 아래에 둔다. 폴더는 0700, 파일은 0600 이다. `<home>` 은 `$DONGMINAL_HOME`(기본 `~/.dongminal`).
  | 파일 | 내용 |
  |---|---|
  | `accounts.json` | 계정 목록·순서·활성 계정 ID·계정별 설정 (FR-CAC-11) |
  | `configs/<id>.json` | 계정의 `oauthAccount` 사본 |
  | `credentials/<id>.json` | 자격증명 백업 (macOS 가 아닌 운영체제, 또는 키체인 실패 시) |
  | `credentials/<id>.prev.json` | 바로 앞 세대 백업 |
  | `unclaimed/` | 주인을 확정하지 못한 자격증명 보관 (FR-CAC-34) |
  | `usage.json` | 계정별 사용량 캐시와 조회 상태 (FR-CAC-50) |
  | `autoswitch.json` | 자동 전환 설정과 상태 (FR-CAC-70) |
  | `mappings.json` | 폴더 매핑·탭 지정 (FR-CAC-80) |
  | `history.jsonl` | 전환 기록 (FR-CAC-110) |
  | `profiles/<id>/` | 계정별 실행 프로필 (FR-CAC-82) |
- **FR-CAC-2** 모든 파일 쓰기는 원자적이다. 같은 폴더에 임시 파일을 만들고 0600 으로 바꾸고 fsync 한 뒤 rename 한다. 기존 `platform.WriteFileAtomic` 을 쓴다.
- **FR-CAC-3** 저장소 변경(`accounts.json`·`usage.json`·`autoswitch.json`·`mappings.json`)은 파일 락으로 직렬화한다. 락은 비재진입이고, 잡지 못하면 0.1초 간격으로 다시 시도하며 10초 뒤 실패한다. 운영체제별 락 구현은 `internal/shared/platform` 경계 뒤에 둔다.
- **FR-CAC-4** 자격증명 계층은 운영체제별 구현을 `internal/shared/platform` 뒤에 둔다.
  - macOS 활성 저장소: 키체인 서비스 `Claude Code-credentials`, 계정명 `$USER`(없으면 홈 폴더 이름, 그것도 없으면 `claude-code-user`). `/usr/bin/security` 를 5초 제한으로 부른다. 읽기는 `find-generic-password -a <acct> -w -s <svc>`, 종료 코드 44 는 "없음" 이다. 쓰기는 `security -i` 의 표준 입력으로 `add-generic-password -U -a <acct> -s <svc> -X <hex>` 를 보낸다. 값이 명령줄에 드러나지 않는다. 줄이 4032 바이트를 넘으면 키체인에 쓰지 않고 실패로 돌린다. 그러면 호출하는 쪽이 권한 600 파일에 쓰고 키체인 항목을 지운다(FR-CAC-6). 값을 argv 로 넘기지 않는다 — 같은 컴퓨터의 다른 사용자가 `ps` 로 볼 수 있다 (D-CAC-16).
  - macOS 백업: 키체인 서비스 `dongminal-claude-accounts`, 계정명 `account-<id>`. 실패하면 파일 백업(FR-CAC-1)으로 내려가고 그 키체인 항목을 지운다.
  - 그 밖의 운영체제: 활성 저장소는 `<claudeConfigDir>/.credentials.json`, 백업은 파일(FR-CAC-1).
- **FR-CAC-5** 활성 저장소 읽기 순서는 ① 키체인(macOS, 0.3초 간격으로 두 번 시도) ② `.credentials.json` 이다. API 키 방식 로그인은 계정으로 다루지 않는다.
- **FR-CAC-6** 활성 저장소 쓰기는 키체인에 쓴다(macOS). 성공하면, `.credentials.json` 이 이미 있을 때만 같은 바이트로 다시 써서 mtime 을 바꾼다. 실행 중인 세션이 다시 읽게 하기 위해서다. 없는 파일은 만들지 않는다. 키체인 쓰기가 실패하면 파일에 쓰고 키체인 항목을 지운다.
- **FR-CAC-7** 자격증명 JSON 은 `{"claudeAiOauth":{accessToken, refreshToken, expiresAt(ms), refreshTokenExpiresAt?(ms), scopes[], subscriptionType?, …}, …}` 이다. 알지 못하는 필드는 지우지 않고 그대로 옮긴다.
- **FR-CAC-8** **기계 공유 필드** `mcpOAuth`, `mcpOAuthClientConfig`, `mcpXaaIdp`, `mcpXaaIdpConfig`, `pluginSecrets` 는 계정이 아니라 기계에 속한다. 전환 때 활성 저장소의 공유 필드 값을 대상 자격증명에 덮어쓰고, 활성 쪽에 없는 공유 필드는 대상에서도 지운다. 그 밖의 필드(`claudeAiOauth`, `trustedDeviceToken` 등)는 계정을 따라간다.
- **FR-CAC-9** 토큰 값은 로그·API 응답·SSE·화면·오류 메시지 어디에도 나가지 않는다. 로그와 비교에는 refresh token 의 SHA-256 앞 12자리(지문)만 쓴다.

### 3.B 계정 관리

- **FR-CAC-10** **현재 계정 추가**: 활성 저장소의 자격증명과 `~/.claude.json` 의 `oauthAccount`(`emailAddress`, `organizationUuid`, `accountUuid`, `organizationName`)를 읽어 등록한다.
  - `emailAddress` 가 없으면 "먼저 Claude Code 에서 로그인하라" 로 거절한다.
  - 자격증명이 비었거나 API 키 방식이면 거절한다.
  - 같은 `(email, organizationUuid)` 가 이미 있으면 새로 만들지 않고 그 계정의 백업을 갱신한다.
  - 등록한 계정을 활성 계정으로 기록한다.
- **FR-CAC-11** 계정 레코드는 `{id, email, accountUuid, organizationUuid, organizationName, addedAt, alias?, color, disabled, threshold?, priority}` 이다.
  - `alias`: 1~24자. 화면은 별칭이 있으면 별칭, 없으면 이메일을 보인다.
  - `color`: 등록할 때 팔레트에서 아직 쓰지 않은 색을 자동으로 고른다. 사용자가 바꿀 수 있다.
  - `threshold`: 50~100, 없으면 전역 값 (D-CAC-23).
  - `priority`: 0~1000 정수, 기본 0.
  - 범위를 벗어난 값은 거절한다(400).
- **FR-CAC-12** **삭제**: 백업(키체인 항목·파일·`.prev`)·`configs/<id>.json`·사용량 캐시 행·그 계정을 가리키는 매핑과 탭 지정·프로필 폴더를 지운다. 활성 계정은 삭제할 수 있지만 활성 저장소는 건드리지 않는다. 삭제 전에 확인 대화상자를 띄운다.
- **FR-CAC-13** **순서**: 계정 목록의 순서를 바꿀 수 있다(끌어서 놓기). 순서는 수동 순환 전환(FR-CAC-31)의 순서다.
- **FR-CAC-14** **제외**(`disabled`): 제외한 계정은 자동 전환과 스마트 전환의 대상이 아니다. 수동 지정 전환과 사용량 조회는 그대로 된다.

### 3.C 전환

- **FR-CAC-30** **지정 전환**: 계정 하나를 골라 활성 계정으로 만든다. 순서는 아래와 같다.
  1. 락 밖에서: 활성 저장소의 자격증명이 등록된 어느 계정의 백업과도 지문이 다르면 `GET /api/oauth/profile` 로 주인을 확인한다 (FR-CAC-33).
  2. 락: 저장소 락 → Claude Code 자격증명 락(`<claudeConfigDir>/.oauth_refresh.lock`, `~/.claude.lock`) → 설정 락(`~/.claude.json.lock`). Claude Code 락은 npm proper-lockfile 호환 디렉터리 락이다. 3초마다 mtime 을 갱신하고, 각 락을 최대 9초 기다린다. 자격증명 락은 60초, 설정 락은 10초가 지나면 낡은 락으로 본다.
  3. 나가는 계정 백업 (FR-CAC-32).
  4. 대상 백업 읽기. 비었으면 중단한다.
  5. 활성 저장소에 대상 자격증명을 쓴다 (FR-CAC-6, FR-CAC-8).
  6. `~/.claude.json` 의 `oauthAccount` 키만 대상의 사본으로 바꾼다. 다른 키는 그대로 둔다.
  7. `accounts.json` 의 활성 계정 ID 를 바꾼다.
  - 3~7 중 하나가 실패하면 이미 끝낸 단계를 거꾸로 되돌린다.
  - 락을 쥔 동안에는 네트워크를 호출하지 않는다.
- **FR-CAC-31** **스마트 전환** 세 가지.
  - `next`: 순서에서 활성 계정 다음 계정으로. 제외된 계정은 건너뛴다.
  - `next-available`: `next` 와 같되 헤드룸이 0 이하인 계정도 건너뛴다.
  - `best`: 헤드룸이 가장 큰 계정으로. 활성 계정보다 크지 않으면 전환하지 않는다.
- **FR-CAC-31a** **스마트 전환의 값** (`next-available`·`best`, D-CAC-17).
  - 판단에 쓰는 값은 신선한 값(FR-CAC-55)뿐이다. 헤드룸은 자동 전환 설정의 `models`(FR-CAC-70)를 따른다. `models` 가 없으면 5시간·주간 창만, `all` 이면 모든 `scoped` 창, 이름 목록이면 그 이름의 `scoped` 창을 더한다.
  - 판단 전에, 제외되지 않은 계정(활성 계정 포함) 가운데 값이 신선하지 않고 **조회할 수 있는** 계정을 먼저 조회한다. 조회할 수 있음 = 물러나기 중이 아님, 마지막 조회 시도가 60초를 넘음, 영구 실패(`relogin_required`) 표식이 없음. 계정 사이는 0.25초 간격이다(FR-CAC-51).
  - 그래도 값을 모르는 후보는 두 전략 모두 건너뛴다.
  - `next-available`: 건너뛴 뒤 남은 후보가 없으면 409 `claude_no_candidate` 다.
  - `best`: 전환하지 않을 때는 200 `{from, to:from, noop:true, reason}` 이다. `reason` 은 아래 하나다. 헤드룸이 같으면 순서가 앞선 후보가 이긴다.
    | reason | 조건 |
    |---|---|
    | `none` | 제외되지 않은 다른 계정이 없다 |
    | `current-unavailable` | 활성 계정의 값을 모른다 |
    | `no-comparison` | 값을 아는 후보가 없다 |
    | `exhausted` | 활성 계정 헤드룸이 0 이하이고 값을 아는 후보도 모두 활성 이하다 |
    | `stay` | 그 밖에 활성 계정 헤드룸이 가장 크다 |
- **FR-CAC-32** 나가는 계정의 활성 자격증명을 분류한다.
  | 분류 | 조건 | 처리 |
  |---|---|---|
  | 같은 바이트 | 백업과 같다 | 설정 사본만 백업 |
  | 같은 계열 | 지문은 다르지만 프로필 확인 결과 같은 계정이다(토큰이 돌았다) | 자격증명과 설정을 백업 |
  | 남의 것 | 다른 계정이다 | `unclaimed/` 에 보관하고 경고 (FR-CAC-34) |
  | 빈 값 | 활성 저장소가 비었다 | 백업을 덮어쓰지 않는다 |
  | 확인 불가 | 프로필 확인이 실패했다 | 백업을 덮어쓰지 않고 `unclaimed/` 에 보관 |
- **FR-CAC-33** 프로필 확인은 `GET https://api.anthropic.com/api/oauth/profile` 이다. 응답의 `account.uuid`·`account.email`·`organization.uuid` 로 계정을 정한다. 5초 제한.
- **FR-CAC-34** **보관(unclaimed)**: 주인을 확정하지 못한 자격증명은 버리지 않고 `unclaimed/<시각>-<지문>.json` 에 둔다. 설정 화면에서 목록을 보고 지울 수 있다. 내용은 보이지 않는다.
- **FR-CAC-35** 실행 중인 Claude Code 세션은 죽이거나 신호를 보내지 않는다. 전환 결과 안내에 "실행 중인 세션은 약 30초 안에, 또는 다시 시작할 때 새 계정을 씁니다" 를 보인다. 고정된 세션(묶음 H)은 영향을 받지 않는다.
- **FR-CAC-36** 활성 계정이 프로필로 고정 실행 중인 계정이면 전환 전에 경고한다. 그 프로필의 토큰이 백업보다 새것이면 먼저 백업으로 회수한다 (FR-CAC-86).

### 3.D OAuth 갱신과 로그인 만료

- **FR-CAC-40** 갱신은 `POST https://platform.claude.com/v1/oauth/token`, 본문 `{"grant_type":"refresh_token","refresh_token":…,"client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}`, 10초 제한이다. 응답의 `access_token`, `expires_in`, `refresh_token`(오면 교체), `scope` 로 자격증명을 고친다. `expiresAt = 지금 + expires_in*1000`.
- **FR-CAC-41** 400·401·403 이고 오류 코드가 `invalid_grant` 또는 `invalid_client` 이면 **영구 실패**다. 그 계정은 `relogin_required` 상태가 되고 다시 로그인해서 추가하기 전까지 갱신과 조회를 멈춘다. 그 밖의 실패는 일시 실패다.
- **FR-CAC-42** 만료 판정은 `지금 + 5분 >= expiresAt` 이다.
- **FR-CAC-43** 갱신하는 곳에 따라 쓰는 곳이 다르다. 갱신 토큰이 바뀌면 옛 토큰은 쓸 수 없게 되므로 한 곳에만 써서는 안 된다.
  - 비활성·비고정 계정: 계정별 소비 락 아래에서 갱신하고 백업에 쓴다.
  - 활성 계정: Claude Code 자격증명 락 아래에서 갱신하고 **활성 저장소와 백업 둘 다**에 쓴다.
  - 고정 실행 중인 계정: 그 프로필의 자격증명 락 아래에서 갱신하고 **프로필 저장소와 백업 둘 다**에 쓴다.
- **FR-CAC-44** 갱신은 만료됐을 때, 또는 조회가 401 을 받았을 때만 하고 한 번만 다시 시도한다.
- **FR-CAC-45** **로그인 만료일**은 `refreshTokenExpiresAt` 이다. 계정마다 날짜와 남은 기간을 보인다. 값이 없으면 "알 수 없음" 을 보인다. 7일 이내면 경고 등급이다.

### 3.E 사용량 조회

- **FR-CAC-50** 서버의 사용량 조회기는 등록된 계정이 1개 이상일 때만 돈다. 계정마다 `{lastGood, fetchedAt, lastAttemptAt, consecutiveFailures, lastError, backoffUntil, nextPollAt, pollIntervalS, last429At, authDead}` 를 `usage.json` 에 둔다.
- **FR-CAC-51** 조회는 `GET https://api.anthropic.com/api/oauth/usage`, 헤더 `Authorization: Bearer <accessToken>`, `anthropic-beta: oauth-2025-04-20`, `User-Agent: dongminal/<버전>`, 5초 제한이다. 한 번에 여러 계정을 조회할 때는 0.25초 간격을 둔다.
- **FR-CAC-52** 응답 해석.
  - `five_hour`, `seven_day`: `{utilization, resets_at}` → `{pct, resetsAt}`.
  - `limits[]` 중 `scope.model.display_name` 과 `percent` 가 있는 항목 → `scoped[]{name, pct, resetsAt}`.
  - `extra_usage` 가 켜져 있고 필드가 모두 있으면 → `spend{used, limit, pct, currency}` (`used_credits/100`, `monthly_limit/100`).
  - 해석할 수 없는 응답은 실패로 센다.
- **FR-CAC-53** 조회 주기 (cswap `poll_policy` 와 같은 값).
  | 상수 | 값 |
  |---|---|
  | 최소 간격 | 180초 |
  | 긴급 간격 | 60초 (활성 계정의 창이 1%p 이상 올라 `라인-15` 안에 들어왔을 때) |
  | 활성 계정 최대 | 300초 |
  | 후보 계정 기본·최대 | 300초·600초 |
  | 헤드룸 0 이하 | 600초 이상 |
  | 변화 기준 | 1%p |
  | 흔들기 | ±10% |
  - 변화가 있으면 `max(180, 직전/2)`, 없으면 `min(최대, max(180, 직전*1.5))`.
  - 최근 1시간 안에 429 를 받았으면 `min(1800, max(간격, max(직전*1.5, 360)))`.
  - 다음 조회는 가장 가까운 창 초기화 시각 + 60초를 넘지 않는다.
- **FR-CAC-54** 실패 뒤 물러나기.
  - `min(30 * 2^(실패수-1), 600)` 초.
  - 429 이고 `Retry-After: 0` 이면 `max(계산값, 300)`, 600 상한.
  - 429 이고 `Retry-After > 600` 이면 `Retry-After + 900`.
  - 물러나는 시간의 상한은 429 면 4500초, 그 밖은 3600초.
  - `invalid_grant` 는 FR-CAC-41 을 따른다. 그 뒤 자격증명 지문이 바뀌면(다시 추가) 표식을 지운다.
- **FR-CAC-55** **값의 신선도**: 마지막 성공이 300초 이내면 결정에 쓸 수 있는 값이다. 그보다 오래됐으면 화면에 "n분 전" 을 붙이고, 자동 전환은 그 계정을 "모름" 으로 다룬다.
- **FR-CAC-56** **계정 상태**: `ok`, `token_expired`, `relogin_required`, `keychain_unavailable`, `no_credentials`, `rate_limited`, `unavailable` 중 하나다. 화면은 상태별 문구와 다음 시도 시각을 보인다.
- **FR-CAC-57** **사용 속도 예측** (주간 창과 `scoped` 창에만, 주기 604800초).
  - `remaining = (resetsAt - fetchedAt) mod 604800`, `elapsed = remaining==0 ? 0 : 604800-remaining`.
  - `elapsed < 86400` 이면 예측을 내지 않는다.
  - `expectedPct = min(100, elapsed/604800*100)` (소수 첫째 자리).
  - `aheadOfPace = pct - expectedPct >= 15`.
  - `rate = pct/elapsed`. `projectedExhaustionAt = fetchedAt + (100-pct)/rate` (pct ≥ 100 이면 `fetchedAt`, pct 나 elapsed 가 0 이하면 내지 않음).
  - `willLastToReset = pct<=0 || pct + rate*(604800-elapsed) <= 100`.
- **FR-CAC-58** 사용자가 계정 줄의 "새로 고침" 을 누르면 그 계정을 바로 조회한다. 단, 물러나기 중이거나 마지막 조회가 60초 이내면 조회하지 않고 다음 가능 시각을 알린다.

### 3.F 제한 초기화

- **FR-CAC-60** 계정마다 두 프로그램의 상태를 조회한다. 조회는 사용량 조회와 같은 헤더·같은 물러나기를 쓰고, 주기는 사용량 조회 3번에 1번, 그리고 Activity 하단에서 계정 줄을 펼칠 때다.
  - 주간 5시간 초기화: `GET /api/oauth/usage?at_wall=1&skip_spend=1` 응답의 `juniper_tide` → `{eligible, ineligibleReason, available, nextAvailableAt}`.
  - 초기화 티켓: `GET /api/oauth/usage?cedar_ember=1&skip_spend=1` 응답의 `cedar_ember` → `{eligible, atLimit, exhausted[], cooldownUntil, weeklyResetsAt, grants[]}`. 티켓마다 `{id, label, resetsTotal, resetsLeft, startsAt, endsAt, clears[], paused, usableNow, useRequiresLimit, percentUsed, blocking[], givesBackWeekly, unavailableReason}`.
- **FR-CAC-60a** **원본 형식** (Claude Code 2.1.323 `/limit-reset` 의 스키마와 같다). 시각은 ISO 8601 문자열이고 unix 초로 바꾼다. 읽을 수 없는 시각은 0(모름)이다.
  - `juniper_tide`: `eligible`(필수), `ineligible_reason`, `available`(없으면 false), `next_available_at`.
  - `cedar_ember`: `eligible`(필수), `ineligible_reason`, `at_limit`, `exhausted[]`, `grants[]`, `weekly_resets_at`, `cooldown_until`.
  - 티켓: `id`(필수, `^[a-z0-9_-]{1,40}$`), `label`, `resets_total`, `resets_left`(필수, 0 이상 정수), `starts_at`, `ends_at`, `clears[]`, `paused`, `usable_now`, `use_requires_limit`(없으면 true), `percent_used{창:0~100}`, `blocking[]`, `gives_back_weekly`, `unavailable_reason`. 형식이 틀린 티켓은 그 티켓만 뺀다.
  - `clears`·`blocking`·`exhausted` 는 창 이름 `five_hour`, `seven_day`, `seven_day_overage_included`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork`, `seven_day_omelette`, `seven_day_oauth_apps` 만 남긴다.
- **FR-CAC-61** 필드가 없거나 형식이 맞지 않으면 그 프로그램을 "없음" 으로 다루고 화면에서 숨긴다. 오류로 알리지 않는다. 서버의 실험 기능이라 계정마다 없을 수 있다.
- **FR-CAC-62** 사용은 **수동으로만** 한다. 사용자가 버튼을 누르고 확인 대화상자에서 "사용" 을 골라야 보낸다. 대화상자는 무엇이 채워지는지(`clears`), 남은 횟수, 사용 기한, 주간 한도 차감 여부(`givesBackWeekly`, 주간 5시간 초기화는 항상 차감)를 보인다.
  - 주간 5시간 초기화: `POST https://api.anthropic.com/api/organizations/{organizationUuid}/reset_rate_limits`, 본문 `{"program":"juniper_tide"}`.
  - 초기화 티켓: 같은 경로, 본문 `{"program":"cedar_ember","grant_id":<id>,"request_id":<무작위 ID>}`. `grant_id` 는 `^[a-z0-9_-]{1,40}$`, `request_id` 는 `^[A-Za-z0-9_-]{1,64}$` 를 만족해야 한다. 응답을 받지 못해 다시 보낼 때는 같은 `request_id` 를 쓴다.
  - 25초 제한. 활성 계정이면 FR-CAC-43 의 활성 계정 규칙으로 토큰을 갱신한다.
- **FR-CAC-63** 결과를 화면에 그대로 알린다. `reset`(성공, 그 계정을 바로 다시 조회), `already_used`, `not_limited`, `cooldown`(티켓만), `ineligible`, `unavailable`, `rate_limited`, `auth_error`, `error`, `unconfirmed`. 응답을 받지 못했으면(망 오류·시간 초과) `unconfirmed` 이고 "확인하지 못함 — 잠시 뒤 사용량을 확인하세요" 를 보이고 자동으로 다시 보내지 않는다.
  - 2xx 본문의 `result` 를 쓴다. 모르는 값은 `unavailable`, 읽을 수 없는 본문은 `error` 다. 429 는 `rate_limited`, 401 은 토큰을 갱신해 한 번 다시 보내고 그래도 401 이면 `auth_error`, 403 은 `auth_error`, 그 밖의 상태는 `error` 다.
  - 함께 싣는 값: 주간 5시간 초기화는 `nextAvailableAt`, 티켓은 `reason`, `resetsLeft`, `cleared[]`, `weeklyResetsAt`, `cooldownUntil`.
  - 티켓을 `unconfirmed` 로 끝낸 뒤 사용자가 같은 계정의 같은 티켓을 다시 쓰면 직전 `request_id` 를 다시 쓴다(서버가 중복을 걸러낸다). 다른 결과가 나오면 그 `request_id` 를 버린다. 서버 프로세스 메모리에만 둔다.
- **FR-CAC-65** **경로와 표시**.
  - `GET /api/claude-accounts` 의 `usage.resets` 는 `{juniperTide?, cedarEmber?, fetchedAt}` 이다. 두 상태는 FR-CAC-60 의 필드를 camelCase 로, 시각은 unix 초로 싣는다. 조회한 적이 없으면 `resets` 가 없다.
  - `POST /api/claude-accounts/reset` `{id, program, grantId?}` → `{result, …}`(FR-CAC-63). 결과는 언제나 200 이다. `program` 이 둘 중 하나가 아니거나, `cedar_ember` 에 `grantId` 가 없거나 형식이 틀리면 400 `claude_account_invalid`.
  - `POST /api/claude-accounts/refresh` `{id, resets:true}` 는 두 상태만 바로 조회한다. 마지막 상태 조회가 60초 안이면 409 `claude_too_soon`. 화면은 계정 줄을 펼칠 때 이것을 부르고 409 는 조용히 넘긴다.
  - 펼친 묶음의 "제한 초기화" 칸: 주간 5시간 초기화는 `eligible` 일 때 보인다. `available` 이면 "초기화 사용…", 아니고 `nextAvailableAt` 이 있으면 "다음 가능 <시각>". 티켓은 `eligible` 이고 `resetsLeft > 0` 인 것을 보인다. 이름, 남은 횟수(`resetsLeft/resetsTotal`), 기한(`endsAt`), `paused` 면 "멈춤". `usableNow` 면 "초기화 사용…".
  - `dmctl account reset <계정> --program juniper_tide|cedar_ember [--grant <id>] [--yes]` 는 `--yes` 가 없으면 FR-CAC-62 의 내용을 보이고 `y` 를 받아야 보낸다. 결과가 `reset` 이 아니면 종료 코드 1 이다. `dmctl account usage` 는 쓸 수 있는 초기화가 있으면 그 줄을 보인다.
- **FR-CAC-64** 자동 전환은 제한 초기화를 쓰지 않는다. 모든 후보가 헤드룸 0 이하이고 어느 계정에 쓸 수 있는 초기화가 있으면 "초기화 가능" 알림을 보낸다 (FR-CAC-100).

### 3.G 자동 전환

- **FR-CAC-70** 설정 (`autoswitch.json`).
  | 키 | 기본 | 범위 |
  |---|---|---|
  | `enabled` | false | |
  | `threshold` | 90 | 50~100 |
  | `weeklyThreshold` | 없음(=threshold) | 50~100 |
  | `intervalSeconds` | 60 | 15~3600 |
  | `cooldownSeconds` | 300 | 0~86400 |
  | `hysteresisPct` | 10 | 0~50 |
  | `strategy` | `best` | `best`, `consume-first`, `priority-consume-first` |
  | `unhealthyTicks` | 3 | 1~100 |
  | `models` | 없음 | 모델 이름 목록 또는 `all`. 고려할 `scoped` 창 |
  - 범위를 벗어난 값은 거절한다(400).
- **FR-CAC-71** 라인: 5시간 창은 `threshold`, 주간 창과 `scoped` 창은 `weeklyThreshold`. 계정별 `threshold` 가 있으면 두 값 모두 그것을 쓴다. 라인 헤드룸은 0%→100, 라인→`100-라인`, 100%→0 의 구간 선형이다. 묶는 창(binding window)은 라인을 넘은 창, 없으면 라인 헤드룸이 가장 작은 창이다.
- **FR-CAC-72** 한 번의 판단(tick).
  1. 활성 계정을 읽는다. 등록되지 않은 계정이면 판단하지 않고 상태를 `unmanaged` 로 둔다.
  2. 조회 시각이 된 계정은 조회 엔진(FR-CAC-53)이 조회한다. 활성 계정의 어떤 창이 `라인-15` 이상이거나 값을 모르면, 판단 전에 FR-CAC-31a 의 "조회할 수 있는" 낡은 계정을 모두 조회한다.
  3. 트리거를 정한다.
     - 모든 라인 아래: `best` 는 아무것도 하지 않는다. `consume-first`·`priority-consume-first` 는 순위가 더 앞선 후보가 있을 때만 그 전략 이름의 트리거를 건다.
     - 라인 이상: `proactive`. 헤드룸이 0 이하면 `at-limit`.
     - 값을 모름: 연속 `unhealthyTicks` 번이면 `failover`.
  4. 쿨다운: `proactive`·`consume-first`·`priority-consume-first` 는 마지막 전환 뒤 `cooldownSeconds` 안이면 막는다. `at-limit`·`failover` 는 막지 않는다.
  5. 후보: 제외되지 않음, 활성 아님, `relogin_required` 아님, 고정 실행 중 아님(FR-CAC-87), 값이 신선함.
  6. 순위 (cswap `_rank_candidates` 와 같음).
     - 헤드룸 0 이하는 뺀다.
     - **되돌아가기 금지**: 트리거가 `proactive`·`consume-first` 이고 활성 계정이 마지막 전환의 도착 계정이면, 마지막 전환에서 떠난 계정을 뺀다. 단, 그 계정이 회복했고 헤드룸이 `min(2×활성, 활성+3)` 이상이면 빼지 않는다. 회복 = 헤드룸이 떠날 때(`leftHeadroom`)보다 3%p 이상 늘었거나, 묶는 창의 초기화가 떠날 때(`leftRecoveryAt`)보다 300초 이상 앞당겨졌다. 빼서 순위가 비었고 그 계정이 회복했으면 빼지 않고 다시 순위를 매긴다.
     - `proactive`: 후보는 모든 라인 아래이고 `라인헤드룸(후보) - 라인헤드룸(활성) >= hysteresisPct` 여야 한다. 라인 헤드룸이 큰 순.
     - 모든 계정이 라인 이상: 헤드룸이 `min(2*활성, 활성+3)` 이상인 후보만, 헤드룸이 큰 순, 같으면 묶는 창 초기화가 빠른 순.
     - `consume-first`: 주간 초기화가 활성보다 빠른 후보만, 초기화가 빠른 순, 같으면 라인 헤드룸이 큰 순.
     - `priority-consume-first`: 묶는 창이 라인 아래이고 헤드룸이 0 보다 큰 후보만. 우선순위가 높은 순, 같으면 주간 초기화가 빠른 순(모르면 뒤). 활성 계정이 라인 아래면 활성보다 앞서는 후보만.
     - 모든 계정이 라인 이상인지는 `proactive`·`consume-first` 에서는 활성 계정과 값을 아는 후보 모두로, `at-limit`·`failover` 에서는 값을 아는 후보만으로 본다.
     - 라인 헤드룸은 전역 `threshold` 를 자(scale)로 셈한다. 계정별 문턱값이 달라도 한 자로 비교한다.
  7. 순위대로 시도한다. 후보의 토큰이 10분 안에 만료되면 먼저 갱신한다. 갱신이 영구 실패면 그 후보를 격리하고 다음으로 간다. 전환은 FR-CAC-30 이다.
  8. 기록: `lastSwitchAt`, `lastSwitchFrom`, `lastSwitchTo`, `leftHeadroom`, `leftTrigger`.
  9. 모든 후보가 소진이면 가장 이른 회복 시각 + 60초까지 쉰다(600초 상한).
- **FR-CAC-73** 판단 주기: `intervalSeconds × [0.9, 1.1]`. 활성 계정의 다음 조회 시각이 더 가까우면 그때로 앞당기되 60초보다 짧게 하지 않는다. 막힘·유휴 상태면 300초 이상.
- **FR-CAC-74** 격리: 갱신이 영구 실패한 후보는 격리한다. 그 계정의 지문이나 이메일이 바뀌면(다시 추가) 풀린다.
- **FR-CAC-75** **cswap 과 함께 쓸 때**: 자동 전환을 켤 때 `cswap auto` 프로세스가 돌고 있으면 켜지 않고 이유를 알린다. 켜진 뒤에 발견하면 끄고 알린다. 둘이 동시에 활성 저장소를 덮어쓰지 않게 하기 위해서다.
  - 감지: 프로세스 명령줄 목록에서 실행 파일(또는 `-m` 모듈) 이름이 `cswap`·`claude-swap`·`claude_swap` 이고 그 뒤 토큰에 `auto` 가 있으며 `--dry-run` 이 없는 프로세스다. 명령줄 목록을 읽는 일은 `internal/shared/platform` 안에서 한다(macOS·Linux `ps -axo args=`, Windows 는 감지하지 않음 = 없음). 읽지 못하면 없음으로 본다.
  - 켤 때(PUT `enabled:true`) 감지되면 409 `claude_cswap_running` 이고 켜지 않는다. 켜진 뒤에는 판단마다 감지하고, 감지되면 `enabled=false` 로 저장하고 `autoswitch_stopped` 알림(FR-CAC-100a)을 보낸다.
  - cswap 메뉴 막대 앱 안에서 도는 자동 전환은 감지하지 못한다 (§7).
- **FR-CAC-76** **설정·상태 저장과 API**.
  - `autoswitch.json` 은 `{schemaVersion, settings, state}` 이다. `settings` 는 FR-CAC-70 의 키다. `state` 는 `{lastSwitch?{at, from, to, trigger, leftHeadroom, leftRecoveryAt}, quarantined{<id>:<지문>}, unhealthy, notified{<키>:<unix 초>}}` 다. 없거나 깨졌으면 기본값으로 시작한다.
  - `GET /api/claude-accounts/autoswitch` → `{settings, state:{status, lastSwitch?, quarantined[], nextTickAt?}}`. `status` 는 `off`(꺼짐), `on`(켜짐·판단 중), `unmanaged`(활성 계정이 등록되지 않음, FR-CAC-72 1), `exhausted`(모든 후보 소진으로 쉬는 중, FR-CAC-72 9) 중 하나다.
  - `PUT /api/claude-accounts/autoswitch` 는 `settings` 의 일부 키만 받아 고친다. 응답은 GET 과 같다. 범위를 벗어나거나 모르는 키는 400 `claude_account_invalid`. `weeklyThreshold`·`models` 에 `null` 을 보내면 지운다.
  - `GET /api/claude-accounts` 응답에 `autoswitch:{enabled, status}` 를 더한다(FR-CAC-92 표식).
  - 설정이나 상태가 바뀌면 SSE `claude_accounts_changed` 를 보낸다.
  - 자동 전환기는 사용량 조회 엔진과 같은 서버 프로세스에서 돈다. 꺼져 있어도 알림 판정(FR-CAC-100a)은 같은 주기로 돈다 — 그때 판단은 전환을 하지 않는다.
- **FR-CAC-78** **statusLine 값의 계정 귀속과 판단 값** (D-CAC-21).
  - `dmctl statusline` 프록시는 보고에 `account:{email, organizationUuid}` 를 싣는다. 값은 그 세션의 설정 폴더에서 읽는다 — `CLAUDE_CONFIG_DIR` 이 있으면 `<CLAUDE_CONFIG_DIR>/.claude.json`, 없으면 `~/.claude.json` 의 `oauthAccount`. 읽지 못하면 `account` 를 싣지 않는다. 토큰은 싣지 않는다.
  - 서버는 `account` 가 있는 보고를 `(email, organizationUuid)` 마다 마지막 값 하나로 둔다(서버 메모리, 5시간·주간 창). `account` 가 없는 보고만 기존 에이전트 단위 값(FR-ASV-20)으로 둔다. 데몬의 한도 기록도 같은 규칙이다.
  - **판단 값**: 계정의 결정 값(FR-CAC-55)은 창마다 OAuth 값과 statusLine 값을 합친 것이다. 쓸 수 있는 statusLine 값 = 마지막 보고가 300초 이내이고, 그 보고가 마지막 전환(dongminal 이 한 전환) 뒤 60초 이후에 왔다 — 전환 직후에는 실행 중인 세션이 옛 토큰을 쓰기 때문이다. 창 하나의 합치기:
    - 초기화 시각이 지난 값은 버린다.
    - 두 값의 초기화 시각이 모두 있고 300초 넘게 다르면 늦은 쪽(새 창)을 쓴다.
    - 그 밖에는 사용률이 큰 쪽을 쓴다. 한 창 안에서 사용률은 줄지 않으므로 큰 값이 더 새 값이다.
  - OAuth 값이 신선하지 않아도 쓸 수 있는 statusLine 값이 있으면 그 계정의 값을 "안다" 로 본다. `scoped` 창과 `spend` 는 OAuth 값만 쓴다.
  - 합친 값을 쓰는 곳: 자동 전환(FR-CAC-71·72), 스마트 전환(FR-CAC-31a), 알림 판정(FR-CAC-100a), 전환 기록의 헤드룸(FR-CAC-110a). 계정 묶음의 막대는 OAuth 값 그대로다.
  - `GET /api/claude-accounts` 의 계정마다 `statusLine?:{windows:{fiveHour?, sevenDay?}, observedAt, ageSeconds, stale}` 를 싣고(창 모양은 `usage.windows` 와 같다), 등록되지 않은 계정의 값은 최상위 `otherStatusLines:[{name, windows, observedAt, ageSeconds, stale}]` 에 싣는다(`name` 은 FR-CAC-101 의 표시 이름).
- **FR-CAC-77** 고정 실행 중 판정(FR-CAC-87)은 5단계에서 만든다. 4단계에서는 모든 계정을 "고정 실행 중 아님" 으로 본다.

### 3.H 계정별 실행 (탭 지정·폴더 매핑)

- **FR-CAC-80** `mappings.json` 은 `{folders:{"<정규화한 절대경로>":{accountId}}, tabs:{"<toolId>":{accountId}}}` 이다. 경로는 심볼릭 링크를 풀고 끝의 구분자를 뗀다. Windows 는 대소문자를 구분하지 않는다.
- **FR-CAC-81** **해석 순서**: ① 탭 지정 ② 현재 폴더(cwd)와 같거나 가장 가까운 상위의 폴더 매핑 ③ 없음(전역 활성 계정). 가리키는 계정이 삭제됐으면 그 매핑은 없는 것으로 본다.
- **FR-CAC-82** **프로필**: `profiles/<id>/` 를 계정의 `CLAUDE_CONFIG_DIR` 로 쓴다. 처음 만들 때와 실행할 때마다 아래를 맞춘다.
  - 자격증명: 프로필 저장소가 비었거나 백업보다 낡았으면 백업을 프로필 저장소에 쓴다. macOS 프로필 저장소는 키체인 서비스 `Claude Code-credentials-<sha256(NFC(CLAUDE_CONFIG_DIR 원문))의 앞 8자>` 다. 그 밖은 `profiles/<id>/.credentials.json`.
  - `.claude.json`: 없으면 `{oauthAccount, hasCompletedOnboarding:true}` 로 만든다. 있으면 `oauthAccount` 만 맞춘다.
  - 공유 항목 `settings.json`, `keybindings.json`, `CLAUDE.md`, `skills`, `commands`, `agents`, `rules`, `plugins`, `projects`, `history.jsonl` 은 `~/.claude` 의 것에 심볼릭 링크로 잇는다. 링크를 만들 수 없으면(Windows 권한) 파일은 복사하고 폴더는 디렉터리 정션을 쓴다. 정션도 실패하면 그 항목은 잇지 않고 설정 화면에 경고를 보인다.
- **FR-CAC-83** **셸 래퍼**: zsh·bash·PowerShell 의 `claude()` 래퍼는 실행 직전에 `dmctl account env` 를 부른다. 출력이 `CLAUDE_CONFIG_DIR=<경로>` 면 그 실행에만 그 값을 넣는다. 출력이 비었거나 `dmctl` 이 실패하면(500ms 제한) 지금과 같이 실행한다. 사용자가 이미 `CLAUDE_CONFIG_DIR` 을 정했으면 덮어쓰지 않는다.
- **FR-CAC-84** ~~GUI 기동~~ **해당 없음** (2026-11-13): 에이전트 GUI 와 그 기동 경로는 지워졌다(`AGENT_GUI_REMOVAL_SRS` §6, D-4). claude 는 늘 터미널 탭의 셸에서 뜨므로(원격 기동·issue-tree 포함) 셸 래퍼(FR-CAC-83)가 모든 기동을 맡는다.
- **FR-CAC-85** 탭 지정은 탭 우클릭 메뉴 "Claude 계정" 에서 고르거나 푼다. 이미 실행 중인 claude 에는 적용되지 않고 다음 실행부터 적용된다. 메뉴에 그 사실을 적는다.
- **FR-CAC-86** **프로필 토큰 회수**: 프로필에서 실행한 claude 가 토큰을 돌리면 백업이 낡는다. 조회기는 고정 실행 중인 계정을 조회하기 전에 프로필 저장소를 읽고, 같은 계정이고 백업보다 새것이면(expiresAt 이 더 늦음) 백업에 쓴다.
- **FR-CAC-87** **고정 실행 중**: 프로필 폴더 아래 `sessions/<pid>.json` 이 있고 그 pid 가 살아 있으면 그 계정은 고정 실행 중이다. 고정 실행 중인 계정은 자동 전환의 대상이 아니다. 활성 계정이 고정 실행 중이어도 자동 전환은 활성 저장소만 바꾸므로 그 세션에는 영향이 없다.

### 3.I 화면

- **FR-CAC-90** **Activity 하단(Usage foot)** 은 등록된 계정마다 한 줄 묶음을 보이고, 맨 아래에 statusLine 줄 하나를 둔다. 계정이 없으면 statusLine 줄만 보인다.
- **FR-CAC-91** 계정 묶음.
  - 머리: 계정 색 점, 표시 이름, 활성 표식, 상태(FR-CAC-56)가 `ok` 가 아니면 상태 문구, 값이 오래됐으면 "n분 전".
  - 창마다 기존 막대 모양(D-ASV-11)을 그대로 쓴다. 창의 등급(70/90)과 남은 시간은 서버가 셈해 `usage.windows` 에 싣는다 (D-CAC-15). 주간 창에는 사용 속도 예측을 한 줄로 더한다(예: "예상 22% · 이 속도면 초기화 전 소진 (수 18:00)"). 앞서가면 경고 색.
  - `spend` 가 있으면 "추가 사용량 $12.40 / $50" 줄.
  - 접힌 기본 모양에서 보이는 것: 머리 + 5시간·주간 막대. 펼치면 `scoped`, 예측, 추가 사용량, 로그인 만료일, 제한 초기화, 동작 버튼이 보인다. 펼침 상태는 계정별로 기억한다.
  - 동작: "이 계정으로 전환"(활성 아닐 때), "새로 고침", 쓸 수 있는 제한 초기화가 있으면 "초기화 사용…".
- **FR-CAC-92** foot 머리 줄에 "자동 전환 켜짐/꺼짐" 표식과 스마트 전환 메뉴(`next`, `next-available`, `best`)를 둔다. 2단계는 `next` 하나("다음 계정" 버튼, 계정이 둘 이상일 때)만 둔다. 표식과 나머지 둘은 자동 전환·사용량 판단과 함께 4단계에서 더한다.
  - 4단계 모양: 머리 줄에 표식(`autoswitch.status` 문구, 켜짐이면 강조)과 "전환 ▾" 단추(계정이 둘 이상일 때)와 "기록" 단추를 둔다. "전환 ▾" 는 세 항목 메뉴를 연다. 표식은 누를 수 없다 — 켜고 끄기는 `dmctl account auto` 와 6단계 설정 화면이 한다.
  - `best` 가 전환하지 않으면 `reason` 문구(`cacct.reason.<reason>`)를 토스트로 알린다.
- **FR-CAC-93** **statusLine 줄**: statusLine `rate_limits` 값을 계정마다 한 줄로 보인다 (D-CAC-22). 예: `statusLine · ● 업무 · 세션 34% · 주간 21% · 2시간 10분 후 초기화 · 3분 전`. 등급 색은 기존 규칙(70/90)을 쓴다. 계정 묶음의 막대(OAuth 값)와 섞지 않는다.
  - 순서: 등록된 계정(계정 순서, 계정 색 점과 표시 이름) → 등록되지 않은 계정(표시 이름만, FR-CAC-101 규칙) → 계정을 모르는 보고(기존 한 줄, 이름 없이 `statusLine`).
  - 값이 없는 계정은 줄을 그리지 않는다. 마지막 보고가 300초보다 오래됐으면 "n분 전" 을 붙인다.
- **FR-CAC-94** **설정의 "Claude 계정" 구역**.
  - 계정 목록: 끌어서 순서 바꾸기, 표시 이름·이메일·조직, 색, 별칭, 문턱값, 우선순위, 제외, 로그인 만료일, 상태, 삭제.
  - "현재 로그인한 계정 추가" 버튼과 안내("Claude Code 에서 `/login` 으로 추가할 계정에 로그인한 뒤 누르세요").
  - 자동 전환 설정(FR-CAC-70).
  - 폴더 연결 목록: 연결된 경로만 모아 상하 관계로 들여 쓴 트리. 덮어쓰는 하위 연결은 "(상위 연결을 덮어씀)" 을 붙인다. "+ 폴더 연결" 은 기존 경로 입력 보조(`path-suggest`)를 쓴다.
  - 보관된 자격증명 목록(FR-CAC-34)과 삭제.
  - 전환 기록(FR-CAC-110) 최근 50건.
- **FR-CAC-95** **탭 틴트**: 탭에 적용되는 계정(FR-CAC-81)이 있으면 탭 배경을 계정 색으로 옅게 칠한다. 탭 지정은 진하게(불투명도 0.28), 폴더 매핑은 옅게(0.14) 칠한다. 전역 활성 계정이면 칠하지 않는다. 활성 탭 표시와 주의 알림 표시는 틴트 위에 그대로 보인다. 툴팁에 "Claude 계정: <이름> (탭 지정|폴더 <경로>)" 를 더한다. 탭의 cwd 는 기존 cwd 보고값을 쓴다.
- **FR-CAC-96** **사이드바 Repo 목록**: 저장소 루트에 적용되는 계정(폴더 매핑만, FR-CAC-81 ②)이 있으면 계정 색 칩(별칭 또는 이메일 앞부분)을 붙인다.
- **FR-CAC-97** **Explorer**: 저장소 안에서 폴더 매핑이 걸린 폴더에 계정 색 칩을 붙인다. 폴더 우클릭 메뉴에 "Claude 계정 연결…" 과 "연결 해제" 를 둔다.
- **FR-CAC-98** 색은 대비 검사(WCAG AA, UI 3:1)를 통과하는 고정 팔레트 8색에서 고른다. 팔레트는 다크용·라이트용 두 벌이고 같은 번호는 같은 색상이다. 테마의 모드가 벌을 고른다 (D-CAC-14). 칩 글자색은 대비로 정한다. 하드코딩한 색 대신 테마 토큰을 쓴다.
- **FR-CAC-99** 모든 문구는 i18n 키다(ko·en).

### 3.J 알림

- **FR-CAC-100** 아래 사건을 기존 알림 경로(attention 토스트, 켜져 있으면 Telegram)로 보낸다. 같은 사건은 같은 계정·같은 창·같은 초기화 주기에 한 번만 보낸다.
  | 사건 | 조건 |
  |---|---|
  | 자동 전환 | 전환이 일어났다 (누가 → 누구, 트리거) |
  | 한도 임박 | 활성 계정의 창이 라인에 닿았는데 전환할 후보가 없다 |
  | 모두 소진 | 모든 계정의 헤드룸이 0 이하. 쓸 수 있는 제한 초기화가 있으면 함께 알린다 |
  | 재로그인 필요 | 계정이 `relogin_required` 가 됐다 |
  | 로그인 만료 임박 | `refreshTokenExpiresAt` 까지 7일 이하 (하루 한 번) |
- **FR-CAC-101** 알림 문구에 토큰이나 이메일 전체를 넣지 않는다. 표시 이름(별칭, 없으면 이메일 앞부분 `ab***@`)을 쓴다.
- **FR-CAC-100a** **알림의 형식과 경로**.
  - 서버는 SSE `claude_account_alert` 를 보낸다. 본문은 `{kind, name?, from?, to?, trigger?, window?, resetsAt?, expiresAt?, resetAvailable?}` 이다. 이름 필드에는 표시 이름(FR-CAC-101)만 싣고 계정 ID·이메일 전체·토큰은 싣지 않는다. 브라우저는 받으면 `Toast` 를 띄운다. 문구는 i18n 키 `cacct.alert.<kind>` 다.
  - Telegram 브리지가 켜져 있으면 같은 내용을 글 한 통으로 보낸다. 탭과 무관한 글이라 무음 규칙(탭 입력 기준)은 쓰지 않는다. 브리지 큐에 글 항목을 더하는 입구를 둔다.
  - `kind` 와 중복 억제 키. 억제 키는 `autoswitch.json` 의 `state.notified` 에 보낸 시각과 함께 두고, 8일이 지난 키는 지운다. 서버를 다시 띄워도 같은 사건을 다시 보내지 않는다.
    | kind | 사건 (FR-CAC-100) | 억제 키 |
    |---|---|---|
    | `autoswitch` | 자동 전환 | 없음 (전환마다) |
    | `near_limit` | 한도 임박 — 활성 계정의 묶는 창이 라인 이상이고 FR-CAC-72 6 의 후보 순위가 비었다 | `near:<계정>:<창>:<그 창 resetsAt>` |
    | `all_exhausted` | 모두 소진 — 제외되지 않은 모든 계정의 값이 신선하고 헤드룸이 0 이하다. 어느 계정에 쓸 수 있는 제한 초기화(FR-CAC-65 의 "초기화 사용…" 조건)가 있으면 `resetAvailable:true` | `exhausted:<활성 계정 묶는 창 resetsAt>` |
    | `relogin` | 재로그인 필요 — 계정이 `relogin_required` 가 됐다 | `relogin:<계정>:<지문>` |
    | `login_expiring` | 로그인 만료 임박 — `refreshTokenExpiresAt` 까지 7일 이하 | `expiring:<계정>:<로컬 날짜>` |
    | `autoswitch_stopped` | cswap 자동 전환을 감지해 자동 전환을 껐다 (FR-CAC-75) | 없음 |
  - 꺼진 자동 전환에서도 `near_limit` 의 후보 순위는 같은 규칙(트리거 `proactive`)으로 셈한다.

### 3.K `dmctl account`

- **FR-CAC-102** 하위 명령.
  | 명령 | 동작 |
  |---|---|
  | `dmctl account list [--json]` | 계정·상태·사용량·만료일 |
  | `dmctl account add` | 현재 계정 추가 (FR-CAC-10) |
  | `dmctl account remove <id\|별칭\|이메일>` | 삭제 (`--yes` 없으면 확인을 묻는다) |
  | `dmctl account switch <id\|별칭\|이메일>` | 지정 전환 |
  | `dmctl account switch --strategy next\|next-available\|best` | 스마트 전환 |
  | `dmctl account usage [<계정>] [--refresh]` | 사용량 |
  | `dmctl account reset <계정> --program juniper_tide\|cedar_ember [--grant <id>] [--yes]` | 제한 초기화 (`--yes` 없으면 확인을 묻는다) |
  | `dmctl account auto on\|off\|status [--json]` | 자동 전환 (FR-CAC-76 의 PUT·GET) |
  | `dmctl account pin [--tab <toolId>] <계정>\|--clear` | 탭 지정 (기본은 자기 탭) |
  | `dmctl account map <계정> [경로]` / `unmap [경로]` / `maps` | 폴더 매핑 |
  | `dmctl account env [--cwd <경로>]` | 셸 래퍼용 해석 (FR-CAC-83). 사람이 읽을 출력 없음 |
  | `dmctl account history [--limit N]` | 전환 기록 |
- **FR-CAC-103** `--json` 출력에는 `schemaVersion` 을 둔다. 토큰은 없다.

### 3.L 전환 기록

- **FR-CAC-110** 전환마다 `history.jsonl` 에 `{at, from, to, trigger(manual|next|next-available|best|proactive|at-limit|failover|consume-first|priority), headroomFrom, headroomTo, by(ui|dmctl|auto)}` 한 줄을 더한다. 1000줄을 넘으면 오래된 것부터 지운다.
- **FR-CAC-110a** **기록의 값과 경로**.
  - 실제로 전환된 때만 적는다(`noop` 은 적지 않는다). `from`·`to` 는 계정 ID 다. `headroomFrom`·`headroomTo` 는 전환 직전의 신선한 헤드룸(FR-CAC-31a 의 `models` 규칙)이고, 모르면 `null` 이다.
  - `trigger`: `POST /switch {id}` 는 `manual`, `{strategy}` 는 전략 이름, 자동 전환은 FR-CAC-72 의 트리거다(`priority-consume-first` 는 `priority` 로 적는다).
  - `by`: `POST /api/claude-accounts/switch` 본문에 `by` 를 받는다. 값은 `ui`·`dmctl` 이고 없으면 `ui` 다. 그 밖의 값(`auto` 포함)은 400 `claude_account_invalid` 다. `auto` 는 서버 안의 자동 전환기만 적는다 (D-CAC-18). `dmctl` 은 늘 `by:"dmctl"` 을 보낸다.
  - 기록 쓰기가 실패해도 전환은 되돌리지 않는다. 로그만 남긴다.
  - `GET /api/claude-accounts/history?limit=N` → `{entries:[…]}`, 최신 먼저. `limit` 은 1~1000, 기본 50. 범위 밖이면 400. 계정 이름은 싣지 않는다 — 화면이 계정 목록으로 이름을 찾고, 지워진 계정은 "삭제된 계정" 으로 보인다.
- **FR-CAC-111** Activity 하단 머리의 "기록" 을 누르면 최근 20건을 띄운다. 설정은 50건을 보인다.

### 3.M 서버 API 와 전달

- **FR-CAC-120** 경로 (`docs/external/api.md` 에 모두 적는다).
  | 메서드·경로 | 동작 |
  |---|---|
  | `GET /api/claude-accounts` | 계정 목록·상태·사용량·예측·초기화 상태·자동 전환 상태 |
  | `POST /api/claude-accounts/add` | 현재 계정 추가 |
  | `PUT /api/claude-accounts/item` | 별칭·색·문턱값·우선순위·제외 고치기 (`{id, …}`) |
  | `POST /api/claude-accounts/remove` | 삭제 |
  | `POST /api/claude-accounts/order` | 순서 |
  | `POST /api/claude-accounts/switch` | `{id}` 또는 `{strategy}` |
  | `POST /api/claude-accounts/refresh` | `{id}` 즉시 조회 |
  | `POST /api/claude-accounts/reset` | `{id, program, grantId?}` |
  | `GET·PUT /api/claude-accounts/autoswitch` | 자동 전환 설정 |
  | `GET·PUT /api/claude-accounts/mappings` | 폴더 매핑·탭 지정 |
  | `GET /api/claude-accounts/resolve?toolId=&cwd=` | 해석 결과 `{accountId?, source, configDir?}` |
  | `GET /api/claude-accounts/history` | 기록 |
  | `GET /api/claude-accounts/unclaimed`, `POST …/unclaimed/remove` | 보관 목록·삭제 |
- **FR-CAC-121** 오류는 `httpErr` 와 `apierr` 코드로, 본문은 기존 본문 상한 도우미로 읽는다.
- **FR-CAC-122** 계정·사용량·매핑·자동 전환 상태가 바뀌면 SSE `claude_accounts_changed`(본문 없음)를 보낸다. 클라이언트는 그것을 받으면 `GET /api/claude-accounts` 를 다시 받는다. 그 밖에는 Activity 패널·레일이 보일 때 `state-registry` 로 30초마다 받는다.
- **FR-CAC-123** 데몬 모드에서도 조회기·자동 전환기는 서버 프로세스 하나에서만 돈다. 두 서버 프로세스가 같은 `<home>` 을 쓰면 FR-CAC-3 의 락으로 조회 임대(90초)를 나눠 같은 계정을 동시에 조회하지 않는다.

### 3.N 기존 결정 개정

- **FR-CAC-130** `ACTIVITY_CARD_USAGE_SRS` D-ACU-3 과 `ACTIVITY_STATE_SUBAGENT_SRS` D-ASV-2 를 철회로 표시하고 이 SRS 의 D-CAC-1 을 대체 항목으로 적는다. `ACTIVITY_CARD_USAGE_SRS` 비목표의 "계정 한도 사용률 표시, 여러 계정 등록, 계정 전환" 줄도 같은 방식으로 고친다. `decisions.md` 를 다시 만든다.

## 4. 결정 (Decisions)

| ID | 결정 | 근거 |
|---|---|---|
| D-CAC-1 | 구독 OAuth 토큰을 저장하고 내부 API(`oauth/usage`, `oauth/profile`, `oauth/token`, `reset_rate_limits`)를 자동으로 호출한다 | 정보보호팀 사전 승인(①~④)을 사용자가 확인했다(2026-11-13). D-ACU-3·D-ASV-2 를 대체한다 |
| D-CAC-2 | 저장소는 dongminal 자체 저장소만 쓴다. cswap 저장소를 읽거나 가져오지 않는다 | 사용자 결정. cswap 내부 형식이 바뀌어도 영향이 없다 |
| D-CAC-3 | 등록은 "현재 로그인한 계정 추가" 하나만 둔다 | 사용자 결정. 격리 로그인·setup-token·자체 OAuth 로그인은 넣지 않는다(setup-token 은 추론 전용 스코프라 사용량 API 가 403 이다) |
| D-CAC-4 | 제한 초기화는 수동 사용 + 확인 대화상자로만 쓴다. 자동 전환은 쓰지 않고 알림만 한다 | 사용자 결정. 한정된 자원을 되돌릴 수 없게 소모한다 |
| D-CAC-5 | 모든 운영체제를 지원한다 | 사용자 결정. Linux·Windows 의 Claude Code 는 `.credentials.json` 파일을 쓰므로 같은 방식이 통한다 |
| D-CAC-6 | statusLine 한도 경로는 계정과 별개로 남기고 한 줄로 보인다 | 사용자 결정. 표시는 "등록 계정 N 묶음 + statusLine 1줄" 이다. **개정(D-CAC-22)**: statusLine 줄은 계정마다 한 줄이다 |
| D-CAC-7 | 계정별 실행은 탭 지정 + 폴더 매핑이고 탭 지정이 우선한다 | 사용자 결정 |
| D-CAC-8 | 폴더 매핑 전체는 설정의 "폴더 연결" 목록에서만 보이고, 화면 곳곳(사이드바 Repo·Explorer·탭)은 그 자리에 적용되는 계정만 보인다 | 사용자 결정. Repo Explorer 는 저장소마다 따로라 전체를 보일 수 없다 |
| D-CAC-9 | 탭 표시는 배경 틴트다. 탭 지정은 진하게, 폴더 매핑은 옅게 | 사용자가 배경 틴트를 골랐다. 진하기 구분은 출처를 알리기 위한 기본값이다 |
| D-CAC-10 | 계정 ID 는 UUIDv7(기존 `internal/shared/uuid`)이다. cswap 의 슬롯 번호를 쓰지 않는다 | 순서 바꾸기(FR-CAC-13)와 ID 가 엮이지 않는다. 매핑·기록이 순서 변경에 흔들리지 않는다 |
| D-CAC-11 | 셸 래퍼가 실행 때마다 `dmctl account env` 로 계정을 해석한다. 탭 셸의 환경 변수를 미리 넣지 않는다 | 탭 지정과 폴더 매핑을 바꾸면 이미 열린 셸에도 다음 실행부터 적용된다. cwd 기준 해석이 가능하다 |
| D-CAC-12 | cswap 과 자동 전환을 동시에 돌리지 않는다 (FR-CAC-75) | 두 도구가 활성 저장소를 서로 덮어쓴다 |
| D-CAC-13 | "웹에서 열기"(등록 계정으로 claude.ai 열기)는 넣지 않는다 | 사용자가 포기했다. OAuth 토큰을 웹 세션으로 바꾸는 공식 경로가 없다 |
| D-CAC-14 | 계정 색은 다크·라이트 두 벌의 고정 팔레트다. `applyThemeObj` 가 테마 모드로 벌을 골라 `--acct-1`~`--acct-8` 에 넣는다 | 사용자 결정(2026-11-13). 가장 밝은 다크 표면(휘도 0.065)에서 3:1 은 색 휘도 0.295 이상, 가장 어두운 라이트 표면(0.605)에서 3:1 은 0.168 이하라서 한 벌로는 둘 다 넘을 수 없다. `check-contrast.mjs` 가 54종 × 세 표면을 잰다 |
| D-CAC-15 | 계정 창의 등급과 남은 시간은 서버가 셈한다. 등급 경계는 statusLine 한도와 한 벌(`claudeacct.UsageLevel`)이다 | D-ASV-10 과 같다 — 판정은 서버가 한다. 경계를 두 곳에 두면 갈라진다 |
| D-CAC-17 | 스마트 전환(`next-available`·`best`)은 신선하지 않은 계정 중 조회할 수 있는 것을 먼저 조회하고, 그래도 값을 모르는 계정은 두 전략 모두 건너뛴다 (FR-CAC-31a) | 사용자 결정(2026-11-13). 값을 모르는 계정으로 옮겨 가서 바로 한도에 걸리는 일을 막는다. 물러나는 중인 계정은 요청 예산 때문에 다시 조회하지 않는다. cswap 은 `next-available` 에서 모르는 계정을 건너뛰지 않는다 |
| D-CAC-18 | 전환 기록의 `by` 는 `POST /switch` 본문으로 받는다. `auto` 는 API 로 받지 않는다 (FR-CAC-110a) | 사용자 결정(2026-11-13) |
| D-CAC-19 | 자동 전환 API 는 설정(`settings`)과 상태(`state`)를 나눠 싣고, 목록 응답에는 요약만 싣는다 (FR-CAC-76) | 사용자가 구현자 판단에 맡겼다(2026-11-13). `dmctl account auto status` 가 한 번의 호출로 설정과 상태를 본다 |
| D-CAC-20 | 알림은 SSE `claude_account_alert` 하나로 보내고, 중복 억제 키를 `autoswitch.json` 에 둔다 (FR-CAC-100a) | 사용자가 구현자 판단에 맡겼다(2026-11-13). 서버를 다시 띄워도 같은 알림이 되풀이되지 않는다 |
| D-CAC-21 | statusLine 보고에 그 세션의 계정(`email`, `organizationUuid`)을 싣고, 판단은 창마다 OAuth 값과 statusLine 값 중 큰 값을 쓴다 (FR-CAC-78) | 사용자 결정(2026-11-13). OAuth 조회는 최대 5분 늦어 그 사이 한도를 넘길 수 있다. statusLine 은 요청마다 갱신된다. 보고 때 계정을 읽어야 5단계의 탭·폴더별 계정에서도 섞이지 않는다 |
| D-CAC-22 | statusLine 줄을 계정마다 한 줄로 보인다. 계정 묶음의 막대는 OAuth 값 그대로다 (FR-CAC-93) | 사용자 결정(2026-11-13) |
| D-CAC-23 | 문턱값(전역·주간·계정별) 범위를 50~100 으로 넓힌다 | 사용자 결정(2026-11-13). statusLine 값이 실시간이면 100 이어도 한도에 닿는 순간 전환한다. statusLine 보고가 없는 동안은 OAuth 값만 쓰므로 잠깐 한도에 걸릴 수 있다 |
| D-CAC-16 | 키체인 쓰기는 `security -i` 표준 입력으로만 한다. 줄이 길면 키체인 대신 권한 600 파일을 쓴다 | 사용자 결정(2026-11-13, 보안 검토 지적). argv 의 값은 같은 컴퓨터의 다른 사용자가 `ps` 로 본다. Claude Code 는 argv 로 넘기지만 그 노출을 따라 하지 않는다 |

## 5. 검증 (Verification)

시험 ID 는 `TC-CAC-n`. 모든 외부 호출(키체인 명령, Anthropic 엔드포인트)은 주입한 가짜로 시험한다. 실제 계정·실제 엔드포인트를 부르는 자동 시험은 없다.

| TC | 대상 | 내용 |
|---|---|---|
| TC-CAC-1 | FR-CAC-2·3 | 원자 쓰기 0600, 락 경합·시간 초과 |
| TC-CAC-2 | FR-CAC-4·5·6 | macOS 키체인 명령 인자, 종료 코드 44, 4032 바이트 경계(넘으면 argv 없이 실패), 실패 시 파일로 내려감, mtime 갱신 규칙. 다른 운영체제는 파일 |
| TC-CAC-3 | FR-CAC-7·8 | 모르는 필드 보존, 공유 필드 병합과 삭제 |
| TC-CAC-4 | FR-CAC-9 | 로그·API 응답·SSE·오류에 토큰 문자열이 없다 (가짜 토큰으로 전수 검색) |
| TC-CAC-5 | FR-CAC-10~14 | 추가(신규·갱신·거절 셋), 필드 범위, 삭제가 지우는 것, 순서, 제외 |
| TC-CAC-6 | FR-CAC-30 | 전환 단계 순서, 각 단계 실패 시 되돌림, 락을 쥔 동안 네트워크 호출 없음, `oauthAccount` 만 바뀜 |
| TC-CAC-7 | FR-CAC-31·31a | 스마트 전환 셋, 먼저 조회(물러나기·60초·영구 실패는 조회 안 함), 값 모름 건너뜀, `best` 의 reason 다섯, `models` 규칙 |
| TC-CAC-8 | FR-CAC-32~34 | 나가는 자격증명 분류 다섯, 빈 값이 백업을 덮지 않음, 보관 |
| TC-CAC-9 | FR-CAC-40~45 | 갱신 요청 본문, 영구·일시 실패, 만료 판정, 쓰는 곳 셋, 로그인 만료일 |
| TC-CAC-10 | FR-CAC-51·52 | 헤더, 응답 해석(창·scoped·spend·깨진 응답) |
| TC-CAC-11 | FR-CAC-53·54 | 주기 계산 표(변화·무변화·긴급·429·소진·초기화 상한), 물러나기 표 |
| TC-CAC-12 | FR-CAC-55·56 | 신선도 경계 300초, 상태 값 |
| TC-CAC-13 | FR-CAC-57 | 예측 공식 (cswap `pace.py` 와 같은 입력으로 같은 출력) |
| TC-CAC-14 | FR-CAC-60·61 | 두 프로그램 해석, 필드 없음·형식 깨짐은 숨김 |
| TC-CAC-15 | FR-CAC-62·63 | 요청 본문, ID 검증, 같은 `request_id` 재사용, 결과 매핑, 자동 재전송 없음 |
| TC-CAC-29 | FR-CAC-78 | 프록시가 계정을 실음(CLAUDE_CONFIG_DIR·기본·읽기 실패), 서버의 계정별 저장과 무계정 보고의 분리, 합치기 규칙(초기화 지남·새 창·큰 값), 300초·전환 후 60초, statusLine 만으로 "안다", 판단에 쓰임, 목록 응답 |
| TC-CAC-16 | FR-CAC-70~74 | 설정 범위, 라인 헤드룸, 트리거, 쿨다운, 순위 네 전략, 회복 규칙, 격리, 판단 주기 |
| TC-CAC-17 | FR-CAC-75·76·77 | cswap 자동 전환 감지(명령줄 판정), 켤 때 409, 켜진 뒤 감지하면 끔, 설정·상태 저장, API 모양·부분 수정·검증 |
| TC-CAC-18 | FR-CAC-80·81 | 경로 정규화, 해석 순서, 삭제된 계정 무시 |
| TC-CAC-19 | FR-CAC-82·86·87 | 프로필 생성(자격증명·`.claude.json`·링크·링크 실패 대안), 키체인 서비스 이름 해시, 토큰 회수, 고정 실행 판정 |
| TC-CAC-20 | FR-CAC-83 | 세 셸 래퍼가 `dmctl account env` 결과를 넣음, 실패·빈 출력·사용자 값 우선 |
| TC-CAC-21 | FR-CAC-90~93 | (JS 단위) foot 뷰 모델: 계정 묶음·statusLine 줄·계정 없음·오래된 값·예측 문구 |
| TC-CAC-22 | FR-CAC-95~97 | (JS 단위) 탭 틴트 출처·진하기, Repo 칩, Explorer 칩 |
| TC-CAC-23 | FR-CAC-100·100a·101 | 알림 사건 여섯, 억제 키·재기동 뒤 억제·8일 정리, SSE 본문, Telegram 글 입구, 문구와 본문에 토큰·이메일 전체·계정 ID 없음 |
| TC-CAC-24 | FR-CAC-102·103 | dmctl 명령 인자 해석, `--json` 스키마, 확인 질문 |
| TC-CAC-25 | FR-CAC-110·110a·111 | 기록 형식, 1000줄 자르기, trigger·by 값, `by` 검증, noop 은 안 적음, history API 의 limit |
| TC-CAC-26 | FR-CAC-120~122 | 경로, 오류 코드, SSE 발송 |
| TC-CAC-27 | e2e | 가짜 Anthropic 서버와 가짜 자격증명 저장소(`app.testing` 계약)로: 계정 둘 등록 → foot 에 두 묶음 + statusLine 줄 → 전환 → 활성 표식 이동 → 초기화 확인 대화상자 → 설정에서 별칭·색 → 탭 지정 시 틴트 |
| TC-CAC-28 | 사용자 확인 | 실제 계정 둘로 macOS 에서 추가·전환·사용량·로그인 만료일 확인. 자동 시험 대상이 아니다 |

## 6. 비목표 (Non-goals)

- 격리 로그인, setup-token 등록, 자체 OAuth 로그인 (D-CAC-3)
- cswap 저장소 읽기·가져오기·내보내기, 계정 파일 내보내기/가져오기 (D-CAC-2)
- 다른 기계의 사용량 가져오기(`import-usage`)
- 제한 초기화 자동 사용 (D-CAC-4)
- 등록 계정으로 claude.ai 웹 열기 (D-CAC-13)
- API 키 계정의 관리와 전환
- 메뉴 막대 앱, TUI
- 실행 중인 Claude Code 세션을 재시작하거나 신호를 보내는 일 (FR-CAC-35)

## 7. 위험 (Risks)

| 위험 | 등급 | 대응 |
|---|---|---|
| 내부 엔드포인트(`oauth/usage`, `reset_rate_limits` 등)가 문서에 없어 예고 없이 바뀌거나 막힌다 | HIGH | 해석 실패를 오류가 아니라 "없음/모름" 으로 다룬다 (FR-CAC-52·61). 계정 상태로 드러낸다 |
| 여러 구독 계정을 자동으로 돌려 쓰는 것이 Anthropic 약관상 한도 우회로 볼 수 있고, 계정 정지 위험이 있다. 사내 승인으로 없어지지 않는다 | HIGH | 자동 전환은 기본 꺼짐(FR-CAC-70). 사용자가 켠다. 승인 요청서에 이 위험을 적기를 권했다 |
| 갱신 토큰이 돌면 다른 저장소의 옛 토큰이 무효가 된다 | HIGH | 갱신한 곳과 같은 범위의 저장소에 함께 쓴다 (FR-CAC-43). 프로필 토큰 회수 (FR-CAC-86) |
| 전환 도중 실패로 활성 저장소가 반쯤 바뀐다 | MEDIUM | 단계 기록과 되돌림 (FR-CAC-30), 빈 값으로 백업을 덮지 않음 (FR-CAC-32) |
| 전환 직후 실행 중인 세션이 약 30초 동안 옛 계정을 쓴다 | LOW | 안내 문구 (FR-CAC-35) |
| 토큰 유출 범위가 dongminal 홈까지 넓어진다 | MEDIUM | macOS 는 키체인, 그 밖은 0600 파일과 0700 폴더. 토큰은 어디로도 나가지 않는다 (FR-CAC-9) |
| Windows 에서 심볼릭 링크를 만들 수 없다 | LOW | 복사·정션 대안과 경고 (FR-CAC-82) |
| cswap 과 함께 쓰면 활성 저장소를 서로 덮어쓴다 | MEDIUM | 자동 전환 동시 실행 차단 (FR-CAC-75). 수동 전환은 막지 않는다. 다음 조회 때 활성 계정을 다시 읽는다. cswap 메뉴 막대 앱 안의 자동 전환과 Windows 의 cswap 은 감지하지 못한다 — cswap 저장소를 읽지 않기로 했기 때문이다(D-CAC-2) |
| 사용량 엔드포인트의 요청 예산(시간당 약 30회)을 넘는다 | MEDIUM | cswap 과 같은 주기·물러나기, 계정 간 0.25초 간격 (FR-CAC-51·53·54) |
