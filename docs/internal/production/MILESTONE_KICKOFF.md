# 마일스톤 착수 자료 — 새 세션용 킥오프

- 문서 상태: **초안** · 사용자 결정 **5건** 반영(1·3·5·7·8) · **미결정 3건**(2·4·6) · 감사 리포트 `00`~`13` **전량 반영 완료** (2026-09-10)
- 용도: 구현을 이 대화가 아니라 **마일스톤마다 새 세션에서** 진행하기 위한 자립 자료. 각 섹션은 감사 173건과 로드맵 수립 대화를 모르는 세션이 그 섹션만 읽고 착수할 수 있게 썼다.
- 상위 문서: [`PRODUCTION_ROADMAP.md`](./PRODUCTION_ROADMAP.md) — 마일스톤 전체 배치·순서 제약 12건·범위 제외·P2 전략·요약표
- 프로젝트 루트: `/Users/dykim/personal/dongminal`

---

## 0. 사용 방법

1. 아래 §1 표에서 다음에 착수할 마일스톤을 고른다.
2. 그 마일스톤 섹션의 **선행 완료 확인**을 실행해 선행이 실제로 끝났는지 검증한다. 통과하지 못하면 착수하지 않는다.
3. **선행 결정**에 미결정 항목이 있으면 사용자에게 확정을 받는다. 받기 전에 착수하지 않는다.
4. **착수 프롬프트**를 새 세션에 붙여넣는다.

### 0-1. 확정된 사용자 결정 (전 마일스톤 전제)

| # | 결정 | 내용 |
|---|---|---|
| 1 | git 히스토리 | **재작성하지 않는다.** `git filter-repo` 류를 쓰지 않고 `.gitignore` 보강 + `git count-objects` 기준선 기록으로 대체한다 |
| 3 | 제품 언어 | **i18n 체계를 도입한다.** 한국어 단일 선언이 아니다 — 문자열을 카탈로그로 외부화한다(M9) |
| 5 | 인증 방식 | **브라우저는 세션 쿠키(`HttpOnly; SameSite=Strict`), 비브라우저는 `Authorization: Bearer`.** URL 토큰 방식이 아니다 |
| 8 | TLS 범위 | **축소안.** 인증은 필수(변경 없음). TLS 는 **`--tls-cert/--tls-key` 두 플래그만** — 앱이 인증서를 만들지 않는다(로컬 CA 보류). **기본은 평문 + 경고이고 TLS 미설정은 기동 거부 사유가 아니다.** 리버스 프록시 미지원 선언 |
| 7 | 멀티유저 호스트 | **미지원 선언.** 사용자 원문 "멀티유저는 필요없음, 나 혼자 사용함". 다중 사용자·역할 체계(`G1-8`)는 영구 제외. **단 로컬 권한 경계(홈 0700·소켓 0600·로그 0600, `SEC-8`)와 데몬 IPC 인증(`G1-7`)은 유지** — 미지원 선언은 심층 방어를 포기한다는 뜻이 아니다 |

### 0-1-1. 전제: 원격 접속이 이 제품의 핵심 목적이다

사용자 원문: **"`--expose` 는 필수인게 원격 작업을 위한 프로젝트임."**

`--expose`/`DONGMINAL_HOST` 는 부수 기능이 아니라 **제품이 존재하는 이유이고 기본 사용 형태**다. 모든 마일스톤에서 다음을 전제로 삼는다.

- 기본 바인드가 `127.0.0.1`(`dmenv.go:45-46`)인 것은 유지한다 — 개발·초기 기동의 안전장치로 여전히 옳고 감사도 양호로 판정했다. **그러나 "기본이 안전하니 노출 경로의 결함은 낮은 등급" 이라는 추론을 하지 마라.**
- "로컬 전용이니 괜찮다", "노출은 예외적 사용" 같은 서술을 쓰지 마라.
- 이 전제로 재판정한 것: **`SEC-3`(무인증·평문 LAN 노출)을 원본 P1 → 로드맵 P0 로 본다.** 근거는 `04 §1.2` 가 P0 등급을 매긴 기준이 "전제의 성립성" 이었고, 전제 1 로 그 전제가 항상 성립하기 때문이다. 상세는 `PRODUCTION_ROADMAP.md` §1.6.
- ~~**M4 가 끝나기 전까지 제품의 기본 사용 형태가 무인증 상태다.**~~ → **개정(결정 9, 2026-09-11)**: 인증을 도입하지 않으므로 그것이 **제품의 확정된 경계**다. 시한이 아니라 선언이다. 접근 통제는 **오버레이 망(Tailscale) + 출발지 허용 목록**이 맡고, 그 보증 범위를 `G10-1`(M5) 이 적는다.

### 0-2. 전 마일스톤 공통 제약

- **새 런타임 의존 추가 금지.** `go.mod` 는 직접 2개(`creack/pty`·`gorilla/websocket`) + 간접 1개(`x/sys`)이고 `go.sum` 6줄이다. 이 경량성은 감사가 양호로 판정한 항목이다. TLS(`crypto/tls`)·구조화 로깅(`log/slog`)·프론트 단위 테스트(`node:test`)는 전부 표준 라이브러리로 한다. 프론트는 빌드 도구가 없다(`package.json` devDependency 는 `@playwright/test` 하나) — 번들러·프레임워크를 도입하지 않는다.
- **커밋 메시지에 AI 서명(`Co-Authored-By` 등) 금지.** 커밋은 사용자 확인 후에만.
- **중·대 규모는 스펙 없이 구현하지 않는다.** 각 섹션의 "SRS 필요 여부" 를 따른다(IEEE 29148, 기존 `docs/internal/*_SRS.md` 규칙).
- **기간·날짜 추정 금지.** 규모(S/M/L/XL)와 순서로만 말한다.
- **범위를 넘지 않는다.** 각 섹션의 "건드리지 말 것" 은 여러 감사 축이 "양호" 로 판정해 보존 대상으로 선언한 계약이다. 개선 대상이 아니다.

### 0-3. 발견 ID·갭 ID 를 찾는 곳

- `GO-n`·`FE-n`·`UX-n`·`SEC-n`·`TEST-n`·`DOC-n` → [`00-INDEX.md`](./00-INDEX.md) §1 통합 발견 목록(ID·제목·근거 위치·규모). 상세 근거는 축별 원본 `01-go-arch.md`~`06-docs-hygiene.md`.
- `G1-1`~`G10-6` → [`07-production-gap.md`](./07-production-gap.md) 각 절의 갭 표(ID·등급·영향 범위·규모).
- `B1`~`B9` 묶음 → [`00-INDEX.md`](./00-INDEX.md) §3 "단일 수정으로 다수 해소되는 묶음".
- **`TLS-n`**(전송 보호·알림) → [`13-tls-tailscale.md`](./13-tls-tailscale.md) — **§8 철회 이력 포함**(1판의 Tailscale 기본 권장은 철회됐다).
- **`FBE-n`**(백엔드·CLI) → [`10-func-backend.md`](./10-func-backend.md) · **`GP-n`**(git 갱신) → [`11-git-polling.md`](./11-git-polling.md) · **`FUI-n`**(UI 흐름) → [`12-func-ui.md`](./12-func-ui.md) · SRS 대조 항목 → [`09-srs-implementation-gap.md`](./09-srs-implementation-gap.md). **이 넷은 `00-INDEX.md` 에 없다** — 각 원본에만 있다.

---

## 1. 착수 순서와 차단 상황

| 순서 | 마일스톤 | 선행 | 착수를 막는 미결정 | 규모 |
|---|---|---|---|---|
| 1 | **M0** 비가역 결정·저장소 메타데이터 | — | **없음** | S |
| 2 | **M1** CI 게이트·정적분석·공급망 + **P0 즉시 완화(`GP-1`)** | M0 | **없음** | M |
| 3 | **M2** 브라우저 매개 공격 봉합 + 서버 하드닝 | M1 | **없음** | L · **진행 중** (`M2_PROGRESS.md`) |
| 4 | **M3** 데이터 안전·업그레이드·롤백·복원 검증 + **미저장 편집 손실** | M2 | 없음(**결정 6 은 완료 전** 필요) | L |
| ~~5~~ | ~~**M4** 인증·인가·전송 보호 + 제품 경계~~ **⊘ 수행하지 않음**(결정 9) | — | — | ⊘ |
| 6a | **M5** 관측성·에러 규약·설정·문서·릴리스 (**M4 이월 5건 포함**) | **M3**(M4 미수행) | 없음(결정 4 는 진행 중 확정 가능) | L |
| 6b | **M6** git 갱신 계층 재설계 + 렌더 파이프라인 + e2e | **M1**(M4 미수행) | **없음** | XL |
| 6c | **M8** Go 아키텍처 부채 + 백엔드·CLI 기능 완성도 | M1·M3 | **없음** | XL |
| 7 | **M7** 접근성·디자인 시스템·UX 안전 | M6 | **결정 2**(접근성 기준) | XL |
| 8 | **M9** 국제화(i18n) | M7·M6·M5 | 결정 2(일부 DoD) | L |

6a·6b·6c 는 상호 의존이 없어 순서를 바꿀 수 있고 병행도 가능하다. M7 은 M6 뒤, M9 는 M7·M6·M5 뒤에만 착수한다.

> **M6·M7·M9 의 범위가 확정됐다.** 기능 완성도 4축(`09` SRS 대조 / `10` 백엔드·CLI / `11` git 갱신 / `12` UI 흐름)이 반영됐다. **git 폴링 조사가 실제로 M6 의 성격을 바꿨다** — "flaky 수정" 이 아니라 **"git 갱신 계층 재설계"** 다. M6 섹션의 §4(flaky 9건 확정 매핑)와 §5(내부 8단계)를 반드시 읽어라.

> **미결정 3건**: 2(접근성 기준, M7 착수 전) · 4(배포 채널, 차단 없음) · 6(버전 정책, M3 완료 전). 확정 5건은 §0-1.

> **기능 완성도 4축(`09`~`12`) 반영 완료.** 발견이 173 → **248건**이 됐고 새 P0 하나(`GP-1`)가 M1 로 들어왔다. M6 은 조사 결과로 성격이 바뀌었다 — "flaky 수정" 이 아니라 **"git 갱신 계층 재설계"** 다(`11` 이 flaky 9건의 근본 원인을 재판정했다).

---

## M0 — 비가역 결정과 저장소 메타데이터

**목표(한 문장)**: git 히스토리 재작성을 영구히 의제에서 내려놓고, 그 대신 재발 방지와 관찰 기준선을 남기며, 라이선스·템플릿 등 순수 신규 파일을 얹는다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`06-docs-hygiene.md`](./06-docs-hygiene.md) | §4 "저장소 위생" 전체(git 크기 실측·blob 28개·`.gitignore` 대조), §5 "프로젝트 메타데이터 — 누락 목록", §7 CHANGELOG 검증 결과 |
| [`PRODUCTION_ROADMAP.md`](./PRODUCTION_ROADMAP.md) | §2 M0, §4-3-C(재작성 제외 근거), §3-A 제약 1 |

프로젝트 파일: `README.md`(라이선스 절 부재 확인), `.gitignore`, `CHANGELOG.md`(형식 확인만).

### 2. 선행 완료 확인

선행 없음. 저장소 현재 상태만 확인한다.

```bash
cd /Users/dykim/personal/dongminal
git status --porcelain          # 착수 전 워킹트리가 깨끗한지
git count-objects -vH           # 기준선으로 기록할 값
ls LICENSE .editorconfig 2>&1   # 둘 다 없어야 정상(이 마일스톤이 만든다)
ls .github/                     # workflows/ 만 있어야 정상
```

### 3. 범위

**포함 발견**: `DOC-5`(P1, LICENSE·README 라이선스 절 전무) · `DOC-6`(P2, git 히스토리 blob 28개·pack 79.67MiB) · `DOC-7` 일부(`.editorconfig` 부재) · `DOC-8`(P3, 이슈/PR 템플릿) · `DOC-9`(P3, `v1` 태그 SemVer 미준수).

**포함 갭**: 없음.

**확정 사실(감사가 실측한 것)**: 1MB 초과 blob 28개 — `remote-terminal` 27개(최대 9,105,986 bytes) + `bin/dongminal` 1개(9,086,770 bytes), 합계 249,218,200 bytes. `git check-ignore -v remote-terminal` 은 현재 **매칭 규칙이 없다**(`.gitignore` 는 `/dongminal` 만 안다). `bin/dongminal` 은 `.gitignore:5:/bin` 에 걸린다.

**건드리지 말 것**
- **git 히스토리 재작성 금지**(확정 결정 1). `git filter-repo`·`filter-branch`·강제 push 를 쓰지 않는다. 13개 릴리스 태그의 해시를 바꾸면 `CHANGELOG` 13개 헤더가 태그와 날짜까지 일치하는 상태(감사 양호 판정)를 재수립해야 하고 기존 clone·fork 가 무효화된다.
- **CHANGELOG 형식 변경 금지** — Keep a Changelog + SemVer 선언과 13개 버전 헤더의 태그·날짜 일치는 양호 판정 항목이다. `v1` 태그도 삭제·개명하지 않는다(기록용으로 남긴다).
- **워킹트리 위생 손대지 말 것** — `dongminal`·`dist/`·`playwright-report/`·`test-results/`·`.playwright-mcp/` 는 이미 미추적이고 `.gitignore` 가 덮는다. 이 규칙을 재정리하지 않는다. 추가하는 것은 `remote-terminal` 한 줄이다.

### 4. Definition of Done

- `LICENSE` 가 저장소 루트에 존재하고 `README.md` 에 라이선스 절이 있다(현재 README 전문 검색 0건).
- `.editorconfig` 존재.
- `.github/ISSUE_TEMPLATE/` 와 `.github/PULL_REQUEST_TEMPLATE.md` 존재.
- `git check-ignore -v remote-terminal` 이 `.gitignore` 의 새 규칙을 출력한다.
- `git count-objects -vH` 출력을 문서에 기록해 관찰 기준선으로 남긴다(현재 `count 4775 · size 26.40 MiB · in-pack 11258 · packs 31 · size-pack 79.67 MiB`).
- `git log --oneline` 의 HEAD 커밋 해시가 착수 전과 동일하다(= 히스토리를 건드리지 않았다는 증거).
- `v1` 태그는 조치하지 않았다.

### 5. 선행 결정

**없음.** 결정 1(재작성 안 함)이 이미 확정되어 이 마일스톤의 유일한 분기가 닫혔다.

### 6. SRS 필요 여부

**불필요**(사소 규모 — 신규 파일 추가와 `.gitignore` 한 줄). 변경 요약만 보고한다.

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M0(비가역 결정·저장소 메타데이터)을 실행한다.
먼저 docs/internal/production/MILESTONE_KICKOFF.md 의 "M0" 섹션과
docs/internal/production/06-docs-hygiene.md 의 §4·§5 를 읽어라.

작업:
1. LICENSE 파일 추가 + README.md 에 라이선스 절 추가 (라이선스 종류는 사용자에게 확인)
2. .editorconfig 추가
3. .github/ISSUE_TEMPLATE/ 와 .github/PULL_REQUEST_TEMPLATE.md 추가
4. .gitignore 에 remote-terminal 규칙 추가
5. git count-objects -vH 출력을 docs/internal/production/ 안의 문서에 관찰 기준선으로 기록

절대 하지 말 것:
- git 히스토리 재작성 (filter-repo/filter-branch/강제 push) — 사용자가 "하지 않음"으로
  확정했다. HEAD 커밋 해시가 작업 전후 동일해야 한다.
- CHANGELOG.md 형식 변경, v1 태그 삭제·개명
- .gitignore 의 기존 규칙 재정리 (remote-terminal 한 줄만 추가)
- 커밋 메시지에 AI 서명(Co-Authored-By 등) 삽입

규모는 S 다. 스펙 문서는 필요 없다. 커밋은 사용자 확인 후에만 하라.
완료 후 MILESTONE_KICKOFF.md 의 M0 Definition of Done 항목을 하나씩 검증해 보고하라.
```

---

## M1 — CI 게이트·정적분석·공급망 + P0 즉시 완화

**목표(한 문장)**: 이후 모든 수정의 회귀를 CI 가 잡게 만들고, 의존이 없는 P0 하나를 즉시 막는다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`05-test.md`](./05-test.md) | §3.1 "CI 게이트 누락(7건)", §3.4 "프론트엔드 단위 테스트 부재"(순수 모듈 우선순위 표), §0.1 Go 커버리지 실측 |
| [`02-fe-arch.md`](./02-fe-arch.md) | P1 "린트·타입 안전망 전무" |
| [`04-secops.md`](./04-secops.md) | §4.7 "빌드·배포 공급망(5건)" |
| [`07-production-gap.md`](./07-production-gap.md) | §3 갭 표의 `G3-5`, §8 갭 표의 `G8-3`·`G8-4` |
| [`00-INDEX.md`](./00-INDEX.md) | §3 묶음 **B9**, §2 교차확인 (f)·(j) |

프로젝트 파일: `.github/workflows/verify.yml`·`release.yml`·`e2e.yml`, `scripts/build.sh`, `scripts/check-*.sh`(4종, 기존 게이트의 형태 참고), `package.json`, `playwright.config.ts`.

### 2. 선행 완료 확인 — M0

```bash
cd /Users/dykim/personal/dongminal
test -f LICENSE && echo "LICENSE ok"
test -f .editorconfig && echo "editorconfig ok"
test -f .github/PULL_REQUEST_TEMPLATE.md && test -d .github/ISSUE_TEMPLATE && echo "templates ok"
git check-ignore -v remote-terminal && echo "gitignore ok"
```
네 줄 모두 ok 를 내면 M0 완료.

### 3. 범위

**포함 발견**: `TEST-4`(P1, CI 가 `./web/...` 를 건너뜀) · `FE-5`(P1, 린트·타입 안전망 전무) · `TEST-9`(golangci-lint) · `TEST-10`(gofmt, 현재 `internal/webserver/domain/lsp/session.go` 1건 위반) · `TEST-11`(e2e TS 타입검사, `: any` 595회) · `TEST-12`(커버리지 측정) · `TEST-13`(darwin 단위테스트가 릴리스 때만) · `TEST-14`(`-shuffle` 없음, `t.Parallel()` 0건/314파일) · `TEST-15`(`e2e.yml` 주석이 설정과 어긋남) · `TEST-27`(프론트 단위테스트 부재) · `TEST-29`(e2e 샤드 수 재검토) · `FE-29`(e2e 만이 유일한 검증) · `SEC-28`(취약점 스캐너) · `SEC-29`(액션 SHA 미고정) · `SEC-30`(`-trimpath` 없음) · `SEC-32`(`web/vendor` 버전 추적) · `DOC-7`(린터 설정 부재).

**포함 갭**: `G3-5`(릴리스 발행이 e2e 게이트를 기다리지 않음) · `G8-3`(로컬 게이트 원커맨드 + pre-commit) · `G8-4`(Node 버전 고정).

**추가 포함 — 성격이 다르니 따로 본다**
- **[P0] `GP-1` 즉시 완화** (`11-git-polling.md §1`): `gitStatusInterval` 을 `끔(0)`·`2분` 으로 두면 **서버 푸시까지 함께 죽는다.** 서버 감시 등록(`Note()`)의 유일한 호출처가 `GET /api/git/status`(`gitapi/handlers_git.go:417`)인데 TTL 이 90초다(`hub/gitwatch.go:50`). 주기가 0 이면 타이머 자체가 없고 120초면 TTL 보다 길어서, 어느 쪽이든 `evictLocked` 가 감시를 걷고 `git_changed` 방송이 그 저장소에 대해 영구히 멎는다. **사용자가 "요청을 줄이려고" 고른 설정이 자동 갱신을 통째로 끈다.** 여기서는 **증상만 막는다** — 선택지에서 `2분`·`끔` 을 제거하거나 서버 TTL 을 그 최댓값보다 크게 잡는다(규모 S). 근본 조치(관심 표명을 SSE 구독에 붙여 폴링 주기와 푸시 수명을 분리)는 갱신 계층 전체와 함께 M6 에서 한다.

  > **개정 (2026-09-10, 사용자 결정): 여기서 근본 조치까지 했다.** 사용자 원문 —
  > "오래 안 본다고 지우는 건 안 될 거 같아. 띄워놓고 보고만 있을 수도 있으니까 작업하면서."
  > 증상 완화(선택지 제거)로는 그 요구를 만족할 수 없다. 폴링이 멈추는 경로가 설정 말고도
  > 있기 때문이다 — `_pollOk()` 가 거짓이면 `_applyCadence` 가 계층을 완전히 멈추므로
  > (`panel-poll.js:300-330`), 창을 옮기거나 git 표면이 화면 밖으로 나가도 같은 결함이 난다.
  > 조사 결과 근본 조치의 재료가 이미 전부 있었다 — `clientId`·구독 결선·끊김 즉시 해제·
  > 재연결 epoch 가 `FocusRegistry`(FR-XDF-8~10)에 검증된 채로 있고, `GitWatcher` 만 그것을
  > 쓰지 않고 있었다. 새로 설계할 것이 없어 M6 까지 미룰 이유가 사라졌다.
  > 스펙: `docs/internal/GIT_WATCH_LEASE_SRS.md`. **M6 의 `GP-1`(근본) 항목은 해소됐다.**
- **`09` 비목표 5**: git 쓰기 계열(`fetch`·`pull`·`push`)이 CI 에서 한 번도 돌지 않는다. `E2E_UNIFICATION_SRS §6-4` 가 "네트워크와 자격증명이 필요하다" 로 별도 트랙에 뒀는데, **로컬 bare 저장소를 원격으로 세우면 둘 다 필요 없다**(규모 S/M).

**중심 작업**: 묶음 **B9** = `FE-5` + `TEST-11` + `TEST-27` 을 한 인프라 투자로 — `jsconfig.json`+`@ts-check`, eslint 최소 규칙(`no-undef`·`no-unused-vars`·`no-empty`), `node:test` 하네스로 `web/js/core/hunk-coords.js`·`core/timer-hub.js`·`git/lanes.js` 검사.

**건드리지 말 것**
- **프로젝트 고유 게이트 4종**(`scripts/check-seams.sh`·`check-timers.sh`·`check-gitwrite.sh`·`check-cross.sh`)은 감사가 "잘 되어 있다" 고 판정했다. 재작성하지 않고 원커맨드에 **묶기만** 한다.
- **`go.mod` 경량성** — 린터·스캐너는 CI 도구로 설치하고 모듈 의존으로 넣지 않는다. 프론트 테스트는 `node:test`(표준)로, 러너·번들러를 추가하지 않는다.
- **고득점 커버리지 패키지**(`toolline`·`outbuf`·`apierr`·`web` 100%, `workspace` 89.9%, `git/write` 89.7%)는 커버리지 문턱의 **기준선으로만** 쓴다. 이 마일스톤에서 테스트를 새로 쓰는 대상은 프론트 순수 모듈 3종뿐이다.
- **`GP-1` 확인 (개정)**: 임차인이 있는 저장소는 **유휴로 만료되지 않는다** — TTL 과 폴링 최댓값의 대소는 더는 판정 기준이 아니다. 재현으로 검증한다 — 설정을 최대값으로 두고 Repo 창을 연 채 TTL 을 넘겨 기다린 뒤(탭 전환·포커스 이동 금지, 그것이 `signal()` 을 깨워 TTL 을 갱신한다) 터미널에서 파일을 만들면 화면이 갱신되고, 서버 로그에 `[gitwatch] 관심 표명 만료 — 감시를 걷는다`(`gitwatch.go:172`)가 **남지 않는다.**
- **git 쓰기 CI**: 로컬 bare 저장소를 원격으로 세워 `fetch`·`pull`·`push` 경로가 CI 에서 최소 1회 통과한다.
- **`flaky > 0` 을 CI 실패로 승격하지 마라.** 제품 쪽 계통 결함이 남아 있어 승격하면 이후 모든 마일스톤의 CI 가 빨갛다. 여기서는 `e2e/parity-reporter.ts` 가 flaky 수를 잡 요약에 **노출**하고 기준선(현재 4)을 기록하는 데까지만 한다. 승격은 M6 의 완료 조건이다.
- **e2e 스펙 내용 변경 금지** — 이 마일스톤은 타입 검사와 게이트만 추가한다. 스펙 재조직은 M6.

### 4. Definition of Done

- `golangci-lint run` 이 `verify.yml` 잡으로 존재하고 위반 0.
- `gofmt -l .` 출력 0줄.
- `verify.yml`·`release.yml` 의 테스트 경로가 `./...` 이고 CI 로그에 `web/embed_test.go`·`web/version_test.go` 실행 흔적이 있다.
- `npx tsc --noEmit -p e2e` 가 CI 잡으로 통과.
- `node --test` 로 `hunk-coords.js`·`timer-hub.js`·`lanes.js` 테스트가 CI 에서 돌고, 의도적으로 깨뜨린 커밋에서 잡이 실패함을 1회 확인.
- `govulncheck ./...` 잡 존재 + dependabot 설정(gomod·github-actions·npm).
- `.github/workflows/*.yml` 의 모든 `uses:` 가 40자 커밋 SHA — `grep -nE 'uses: .+@[0-9a-f]{40}'` 로 전수 확인, 태그 참조 0건.
- `scripts/build.sh` 에 `-trimpath` 가 있고 두 러너에서 만든 바이너리의 SHA256 이 동일.
- `release.yml` 의 `publish.needs` 에 e2e 결과가 포함되어, e2e 가 실패한 태그에서 발행이 진행되지 않음을 1회 확인.
- `web/vendor/VERSIONS.md`(또는 동등물)에 4개 이상 벤더 라이브러리(xterm.js·highlight.js·markdown-it.js·purify.js)의 버전·해시 기록.
- `make gates`(또는 Taskfile 동등물) 한 명령이 `check-seams.sh`·`check-timers.sh`·`check-gitwrite.sh`·`check-cross.sh` + `gofmt` + `vet` 를 모두 돌린다. pre-commit 훅 설치 안내(`core.hooksPath`)가 문서에 있다.
- `.nvmrc` 또는 `package.json` 의 `engines` 로 Node 버전이 고정된다.
- `go test -race -shuffle=on ./internal/... ./cmd/... ./web/...` 통과. 순서 의존이 드러나면 목록을 M8 인계 항목으로 기록한다.
- `e2e.yml` 의 주석이 실제 설정과 일치한다(현재 `:37` "workers: 1 · fullyParallel: false", `:57` "retries: 2" 가 `playwright.config.ts:41-46` 의 `workerCount()` 2~4 와 `retries: 1` 과 어긋남). 샤드 8 의 근거를 재검토한 결과를 근거와 함께 반영.

### 5. 선행 결정

**없음.**

### 6. SRS 필요 여부

**최소 스펙 1쪽.** 신규 동작이 없고 CI 설정 추가이므로 IEEE 29148 전체 구조는 과하다. 다음만 적는다: 게이트 목록 · 각 게이트의 실패 조건 · 예외 경로(있으면 근거) · 원커맨드가 묶는 대상. 저장 위치는 `docs/internal/CI_GATES_SRS.md`(기존 명명 규칙 `docs/internal/*_SRS.md`).

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M1(CI 게이트·정적분석·공급망)을 실행한다.
먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M1" 섹션
- docs/internal/production/05-test.md §3.1, §3.4
- docs/internal/production/02-fe-arch.md 의 P1 "린트·타입 안전망 전무"
- docs/internal/production/04-secops.md §4.7
- docs/internal/production/11-git-polling.md §1 (P0 GP-1 — 즉시 완화 대상)
- .github/workflows/ 3개 파일, scripts/check-*.sh 4개(기존 게이트 형태 참고), package.json

먼저 선행(M0) 완료를 킥오프 문서의 확인 명령으로 검증하라. 실패하면 착수하지 말고 보고하라.

성격: CI 설정 추가가 중심이고 신규 동작이 없다. 최소 스펙 1쪽을
docs/internal/CI_GATES_SRS.md 에 먼저 쓰고 진행하라(게이트 목록·실패 조건·예외·원커맨드 대상).

핵심 작업 0 — P0 즉시 완화 (CI 작업과 성격이 다르다. 먼저 하라):
- GP-1: gitStatusInterval 을 "끔(0)"·"2분" 으로 두면 서버 푸시까지 함께 죽는다.
  Note() 의 유일한 호출처가 GET /api/git/status 이고 TTL 이 90초라서, 그 두 설정에서
  감시가 걷히고 git_changed 방송이 영구히 멎는다. 근거는
  docs/internal/production/11-git-polling.md §1 전체.
  여기서는 증상만 막아라 — 선택지에서 2분·끔 제거 또는 서버 GitWatchTTL 을 최댓값보다 크게.
  근본 조치(관심 표명을 SSE 구독에 붙이기)는 이후 M6 이 한다. 여기서 하지 마라.
- git 쓰기 계열(fetch/pull/push) CI 검증: 로컬 bare 저장소를 원격으로 세우면
  네트워크·자격증명 없이 된다.

핵심 작업(묶음 B9 를 중심으로):
- golangci-lint · gofmt · govulncheck · 커버리지 아티팩트 잡 추가
- verify.yml/release.yml 테스트 경로를 ./... 로 (현재 ./web/... 을 건너뛴다)
- e2e TypeScript 타입 검사(tsc --noEmit -p e2e) 잡 추가
- jsconfig.json + @ts-check + eslint 최소 규칙(no-undef/no-unused-vars/no-empty)
- node:test 하네스로 web/js/core/hunk-coords.js, core/timer-hub.js, git/lanes.js 단위 테스트
- 액션 uses: 를 40자 SHA 로 고정, scripts/build.sh 에 -trimpath
- release.yml publish 가 e2e 결과를 기다리게
- web/vendor 라이브러리 버전·해시 기록
- make gates 원커맨드 + pre-commit 안내, Node 버전 고정
- e2e.yml 주석을 실제 설정과 맞추고 샤드 수 근거 재검토

절대 하지 말 것:
- flaky > 0 을 CI 실패로 승격 (제품 쪽 계통 결함이 남아 있어 이후 모든 작업의 CI 가
  빨개진다. 여기서는 flaky 수를 잡 요약에 노출하고 기준선 4 를 기록하는 데까지만.
  승격은 이후 M6 의 완료 조건이다)
- scripts/check-*.sh 4종 재작성 (양호 판정 항목 — 원커맨드에 묶기만)
- go.mod / package.json 에 런타임 의존 추가 (린터·스캐너는 CI 도구로, 프론트 테스트는
  node:test 표준 라이브러리로. 번들러·테스트 러너 도입 금지)
- e2e 스펙 내용 변경 (재조직은 이후 마일스톤)
- 커밋 메시지에 AI 서명 삽입

완료 후 킥오프 문서 M1 의 Definition of Done 을 하나씩 검증해 보고하라.
```

---

## M2 — 브라우저 매개 공격 봉합 + 서버 하드닝

> **⚠ 진행 중 (2026-09-10, 3차).** **P0 5건과 P1 11건이 전부 닫혔다.**
> 남은 것은 DoD 6항목·P2 18건·사용자 보고 6건, 그리고 기존 흔들림이다.
> [`M2_PROGRESS.md`](./M2_PROGRESS.md) 에 있다 — **이 섹션보다 그쪽을 먼저 읽어라.**
> 스펙은 넷이다:
> [`REQUEST_GATE_SRS.md`](../REQUEST_GATE_SRS.md) ·
> [`FILE_API_BOUNDARY_SRS.md`](../FILE_API_BOUNDARY_SRS.md) ·
> [`MONACO_VENDORING_SRS.md`](../MONACO_VENDORING_SRS.md) ·
> [`CLIENT_API_SRS.md`](../CLIENT_API_SRS.md).

**목표(한 문장)**: 기본 설정(127.0.0.1)에서도 성립하는 브라우저 매개 원격 코드 실행 경로 전부를 닫고, 인증 게이트가 설 미들웨어 자리의 계약을 확정한다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`04-secops.md`](./04-secops.md) | §1 "의도된 보안 모델"(특히 §1.2 결론), §2 P0 두 건 전체, §3 P1-2~P1-7, §4.1·4.2·4.3·4.4, §5 양호한 점, §7 권장 조치 순서 |
| [`01-go-arch.md`](./01-go-arch.md) | P0 전체, P1 "타임아웃 부재"·"본문 크기 상한"·"에러 분류" |
| [`02-fe-arch.md`](./02-fe-arch.md) | P0-1(상태바 XSS), P1 "Monaco CDN"·"fetch 관용구 중복", P2 B 항목 3건 |
| [`05-test.md`](./05-test.md) | §1 P0 "`/api/file/write` 테스트 0" |
| [`03-uiux.md`](./03-uiux.md) | P1 "확인창 두 벌의 Enter 규약", §4 양호 1번(파괴적 git 확인창 설계 — 수렴 목표) |
| [`00-INDEX.md`](./00-INDEX.md) | §3 묶음 **B1·B2·B3·B4·B5·B6·B7·B8**, §2 교차확인 (a)~(i) |
| [`07-production-gap.md`](./07-production-gap.md) | §1 "도입 시 영향 범위" 표 — **게이트 체인 순서와 예약할 자리** |

프로젝트 파일: `internal/webserver/httpapi/server.go`(미들웨어 체인 `:196-216`), `internal/shared/toolhub/conn.go`, `internal/webserver/httpapi/handlers_files.go`, `handlers_ws.go`, `web/js/core/app-statusbar.js`, `web/js/ui/term-pane.js`, `web/js/git/api.js`(fetch 래퍼 원형).

### 2. 선행 완료 확인 — M1

```bash
cd /Users/dykim/personal/dongminal
grep -q 'golangci-lint' .github/workflows/verify.yml && echo "lint ok"
[ "$(gofmt -l . | wc -l | tr -d ' ')" = "0" ] && echo "gofmt ok"
grep -qE 'go test .*\./\.\.\.' .github/workflows/verify.yml && echo "test path ok"
grep -q 'tsc --noEmit' .github/workflows/verify.yml && echo "tsc ok"
grep -q 'govulncheck' .github/workflows/verify.yml && echo "vuln ok"
grep -q 'node --test' package.json .github/workflows/verify.yml && echo "node test ok"
[ "$(grep -hoE 'uses: [^ ]+' .github/workflows/*.yml | grep -vcE '@[0-9a-f]{40}')" = "0" ] && echo "action sha ok"
grep -q 'trimpath' scripts/build.sh && echo "trimpath ok"
```
여덟 줄 모두 ok 를 내면 M1 완료.

### 3. 범위

**포함 발견 (P0 5건)**: `GO-1`(교차출처 CSWSH/CSRF 로 임의 명령 실행) · `SEC-1`(WebSocket Origin 미검증) · `SEC-2`(상태변경 HTTP API 전체 CSRF 무방비) · `FE-1`(터미널 출력 → 상태바 innerHTML XSS) · `TEST-1`(`/api/file/write` 단위테스트 0·경로 경계 없음).

**포함 발견 (P1 12건)**: `SEC-9`(Host 헤더 미검증) · `GO-2`/`SEC-4`(타임아웃 부재) · `GO-3`/`SEC-5`(본문 크기 상한) · `SEC-6`(프로세스·구독 상한) · `SEC-7`(파일 API 가 FS 전체를 염) · `SEC-8`(로컬 권한 경계) · `GO-11`/`SEC-17`(에러 분류·내부 문구 노출) · `UX-1`(확인창 Enter 규약) · `FE-6`(Monaco CDN) · `FE-8`(fetch 관용구 중복).

**포함 발견 (P2 18건)**: `SEC-10`~`SEC-21`(조용한 노출·ACL fail-open·보안 헤더·헤드리스 셸[SEC-2 흡수]·git 실행기 초크포인트·`repo` 절대경로·플러그인 매니페스트·오류 문자열·로그 명령 전문·`apiFileRead` 무제한·zip 동시성·`settings.json` 미검증) · `GO-23`(에러 렌더러 5종) · `GO-38`(`io.Copy` 반환 무시) · `GO-39`(git 실행기 4벌) · `FE-15`·`FE-16`·`FE-17`.

**추가 포함 — 기능 축에서 온 3건**: **`FBE-08`**(P1, `git submodule update` 가 네트워크 작업인데 `core.Env()`(`GIT_TERMINAL_PROMPT=0`)도 `ctx` 도 없다 — 인증 필요한 서브모듈에서 180초를 다 채우고 죽는다. **조치의 최소분이 `B5` 와 같은 코드 지점**이다. 작업 경로(jobs) 편입은 M8) · **`FUI-06`**(P2, 큰 텍스트 파일에 클라이언트 게이트 없음 — `probe.size` 를 받고도 전체를 Monaco 에 올린다, `SEC-19` 의 클라이언트 짝) · **`09` 비목표 3**(샌드박스 컨테이너 자원 제한 cpu·memory·pids 없음 — `SANDBOX_WINDOW_SRS §6` 이 "후속 과제" 로 뒀으나 **AI 에이전트가 도는 컨테이너라 폭주가 가설이 아니다**).

**게이트 허용목록 요구사항** (`13 §7` — 이 판정 함수를 M4 가 그대로 쓴다): ① **스킴 하드코딩 금지**(평문·TLS 둘 다 유효한 배치가 있다) ② **포트 유무 정규화**(`net.SplitHostPort` 실패를 “포트 없음” 으로) ③ **기본 허용목록을 서버 자신이 도달 가능한 주소에서 자동 유도** — `localhost` ∪ `127.0.0.1`/`::1` ∪ 실제 바인드 주소 ∪ **`access.go:73` 의 `s.self`** ∪ 호스트명. **새 수집 코드가 필요 없고 `--expose 0.0.0.0` 에서 어느 로컬 IP 로 접속하든 자동 통과한다** ④ `*.ts.net` 은 기본이 아니라 옵션(`--allowed-host`, 와일드카드 접미사 문법 지원) ⑤ `--allowed-host` 로 명시 확장 ⑥ **`Origin` 부재는 거부가 아니다** — 어기면 M4 의 `dmctl` Bearer 경로 17곳/9파일이 전부 막힌다 ⑦ **`Host` 는 존재하면 항상 대조**(DNS 리바인딩 방어의 본체) ⑧ **`X-Forwarded-*` 를 읽지 않는다**(`FR-ACL-6` 승계, 리버스 프록시 미지원 결정으로 신뢰 옵트인 설계 자체가 범위 밖) ⑨ 거부는 로그에 남고 본문에 목록을 노출하지 않는다 ⑩ **`/ws` 와 HTTP 종단이 한 판정 함수를 쓸 것** — 업그레이드 **이전에** 미들웨어에서 판정이 끝나 있게 하는 쪽을 권장(`accessGate` 가 이미 `/ws` 를 덮는 자리).

**포함 갭**: 없음. 대신 **`authGate` 가 설 자리를 예약한다** — 체인을 `logging → accessGate(기기) → authGate(빈 자리) → recover → mux` 로 만들고, 예외 경로 목록(`/`, 정적 자산, `/login`, `/api/ping`)과 판정 함수 위치(`accessStore` 옆 한 곳)를 SRS 에 적는다. M4 가 이 자리를 채운다.

**순서 제약 (이 마일스톤에 걸리는 것)**
- **M1 이 선행이다.** 이 마일스톤은 미들웨어·JSON 디코더·정적 응답을 한 번에 갈아엎고 프론트 fetch 51곳을 옮긴다. 린트·타입 검사·프론트 단위 테스트 없이 하면 회귀를 사람이 잡아야 한다.
- **`FE-6`(Monaco 벤더링)과 `B7`(CSP)은 한 항목이다.** 벤더링하지 않으면 CSP `script-src` 에 `https://cdn.jsdelivr.net` 을 영구 개방해야 하고 서드파티 CDN 이 스크립트 공급망으로 남는다.
- **`B2`(`/api/file/write` 루트가드 + 테스트)는 `B1` 게이트와 별개 수정이다.** CSRF 게이트는 공통 미들웨어로 닫히지만 루트 경계 검사와 회귀 테스트는 이 엔드포인트 전용 추가 작업이다.
- **`FE-8`(`core/api.js` 통합)은 M4 인증의 선행 권장이다.** 확정 결정 5(쿠키)에서는 필수가 아니지만, 401 공통 처리를 한 자리에서 하려면 여기서 통합해 두는 것이 싸다(통합 안 하면 29파일).

**건드리지 말 것**
- **git 실행 초크포인트**(`internal/webserver/domain/git/core`) — 화이트리스트(`guard.go:19-31,98-119`)·전역 옵션 거부(`:102`)·`RelPath` 검사(`:157-191`)·30초 마감·1MiB 출력 상한·자격증명 마스킹은 양호 판정이다. **재설계하지 않는다.** `B5`(`GO-39`+`SEC-14`)는 `worktree`·`submodule` 실행기가 이 초크포인트의 `core.Env()` 를 **재사용**하게 만드는 작업이다.
- **`/api/fs/*` 경로 가드** — `EvalSymlinks`(`handlers_fs.go:143`)·조각 단위 경계 판정·`O_EXCL`·`os.Link` 경합 제거는 양호 판정이다. `SEC-7`/`B2` 는 가드가 **없는** `/api/file/*` 계층에만 적용한다.
- **업로드 `MaxBytesReader`·패닉 그물(SSE/WS 구분)·재연결 폭주·미스홀드 상한** — 실제 사고에서 배운 방어다. 공통 `readJSON` 도입이 업로드 경로의 기존 상한을 우회하지 않게 한다.
- **ACL 설계** — `RemoteAddr` 만 신뢰하고 프록시 헤더를 무시하는 것(`access.go:332-349`), 403 본문에 목록을 싣지 않는 것, DNS 해석을 요청 경로 밖에서만 하는 것은 옳다. 인증은 대체가 아니라 직렬 추가다.
- **기본값 안전성** — 바인드 127.0.0.1, 포트 범위 검증, `--isolated` 구조적 보호. 노출 게이트는 기본값을 바꾸지 않고 노출 시 조건만 더한다. **단 §0-1-1 주의**: 기본값 127.0.0.1 은 개발·초기 기동의 안전장치이고 실사용 형태는 노출이다.
- **파괴적 git 확인창 설계**(`web/js/git/confirm.js`) — 정책 서버 소유·취소 기본·Enter≠실행·영향 목록+복구 힌트+stderr 복사는 **모범 사례**다. `B8` 은 `_confirmClose` 를 이 규약으로 **수렴**시키는 작업이며, 반대 방향으로 바꾸지 않는다.
- **오류 본문 방언 4종 통일 금지** — `docs/internal/architecture.md:141-176` 이 git `{error,message}` · fs `{code,message}` · runs `{error,detail}` · 단문 `{error}` 를 공개 계약으로 문서화하고 "통일하지 않는다(파괴적 변경)" 를 결정으로 적었다. `B6` 은 문구를 코드화하는 것이고 봉투를 바꾸지 않는다.

### 4. Definition of Done

- `Origin: https://evil.example` 로 `ws://127.0.0.1:58146/ws` 를 열면 403이고, `Origin` 헤더 없는 업그레이드(dmctl)는 200 — 두 경우가 `internal/webserver/httpapi/handlers_ws_test.go` 에 고정.
- `POST /api/tools/headless` 를 `Content-Type: text/plain` 으로 보내면 4xx, `application/json` + same-origin 이면 200. `Sec-Fetch-Site: cross-site` 는 거부. `Host: evil.example` 요청이 400 또는 421.
- `handlers_files_test.go` 에 5종 테스트: 정상 쓰기+`ok`/ETag · 상대경로 400 · 빈 path 400 · 쓰기 실패 500 · **워크스페이스/에디터 루트 밖 절대경로 403**. `/api/file/write` 함수 커버리지가 0.0% 에서 상승.
- e2e 회귀 스펙: 터미널에 `printf '\e]777;Cwd;<img src=x onerror=…>\a'` 를 쏘고 상태바가 문자열을 그대로 표시하며 스크립트가 실행되지 않음을 단정.
- `scripts/check-html.sh`(innerHTML 에 `${` 또는 `+변수` 가 들어간 줄 검출)가 CI 게이트로 존재하고 위반 0 — `web/js/git/`·`core/`·`ui/` 동일 규약.
- 정적 응답에 `Content-Security-Policy`·`X-Frame-Options`·`X-Content-Type-Options` 가 붙고 **CSP `script-src` 에 외부 호스트가 없다**. `web/vendor/monaco/` 존재 + `MONACO_CDN` 상수 소멸 + 네트워크를 끊은 상태에서 편집기·Diff 뷰가 뜨는 e2e 1건.
- `server.go` 의 `http.Server` 에 `ReadHeaderTimeout`·`IdleTimeout` 이 있고 종료 경로가 `Shutdown(ctx)` → `Close()`.
- `grep -rn 'io.ReadAll(r.Body)' internal/` 이 0건(현재 10곳). 전부 공통 `readJSON(w,r,limit,into)` 경유이고 그 안에서 Content-Type·`MaxBytesReader` 를 함께 검사. `settings.json` 은 `json.Valid` 실패 시 400.
- `ToolManager.Create` 상한 초과 시 429, `CommandHub.Add` 구독자 상한, `wait` 동시 수 상한. 진단 스냅샷의 `tools=`·`ws=` 에 임계 경고.
- `$DONGMINAL_HOME` 0700, `paned.sock` 0600, 로그 파일 0600, 기본 서버 로그 위치가 `/tmp/dongminal.log` → `$DONGMINAL_HOME/server.log`.
- `grep -rn 'http.Error(w, err.Error()' internal/` 이 0건. 500 본문에 절대경로·명령 문자열이 없음을 테스트로 단정. 에러 분류가 `errors.Is`(`net.ErrClosed`·`syscall.EIO`·`*http.MaxBytesError`)만 쓰고 `strings.Contains(err.Error(), …)` 0곳.
- 헤드리스 명령 로그가 전문 대신 길이·해시를 남긴다(`handlers_toolio.go:110-111` 의 `textLen` 규약을 따름).
- `worktree.execGit`·`submodule` 실행기가 `core.Env()` 를 공유(`GIT_TERMINAL_PROMPT=0`·`GIT_ASKPASS=` 부착 테스트).
- `--expose`/`DONGMINAL_HOST` 이면서 ACL 이 꺼져 있으면 기동 거부 또는 명시 플래그 요구. 노출 모드에서 `access.json` 손상은 fail-closed(loopback 만).
- `_confirmClose` 가 `GitConfirm`/`UIKit.modal` 규약(초기 포커스 취소·Enter≠실행·`textContent`)으로 재작성되고 e2e 가 "Enter 로는 실행 중 프로세스가 죽지 않는다" 를 단정.
- `web/js/core/api.js`(`apiGet`/`apiPost`: 타임아웃·JSON·`{ok,data,status}`)가 존재하고 core/ui 의 손수 `fetch` 51곳이 경유.
- `submodule.ExecGit` 이 `core.Env()` 를 쓰고 `r.Context()` 를 받는다 — 인증이 필요한 서브모듈에서 180초를 다 채우지 않고 즉시 실패하며 요청을 끊으면 git 프로세스가 종료된다.
- 편집기가 `probe.size` 상한을 넘는 텍스트 파일을 Monaco 에 올리지 않는다(서버 `SEC-19` 상한과 같은 값).
- 샌드박스 컨테이너가 cpu·memory·pids 상한을 받고 뜬다.
- `dongminal verify` 에 위 게이트 항목이 추가되어 3 OS CI 에서 통과.
- **M2~M4 구간 운영 안내가 문서에 있다.** 이 마일스톤은 브라우저 매개 공격을 닫지만 **`SEC-3`(무인증 LAN 노출)은 M4 까지 열려 있다.** 원격 접속이 기본 사용 형태이므로(§0-1-1) 이 구간의 안내를 `README.md` 또는 `getting-started.md` 에 임시 절로 둔다: (a) `--expose` 사용 시 ACL 을 반드시 켠다(이 마일스톤의 노출 게이트가 강제), (b) 가능하면 Tailscale 등 오버레이 망 뒤에서만 노출, (c) 공용 Wi-Fi 에서 `--expose` 금지. M4 완료 시 `G10-1` 정식 문서로 대체된다.
- **보존 확인**: `go vet ./...` 무경고, `scripts/check-gitwrite.sh` 통과, git 파괴적 확인창 관련 e2e 통과, 업로드·SSE/WS 패닉 그물 관련 테스트 통과.

### 5. 선행 결정

**없음.** 인증 방식(결정 5)은 확정됐고, 이 마일스톤에서는 `authGate` 자리만 예약하므로 미결정에 걸리지 않는다.

### 6. SRS 필요 여부

**필요(중·대). 2건.**
1. `docs/internal/REQUEST_GATE_SRS.md` — 요청 게이트 체인: Origin/Host/Sec-Fetch-Site/Content-Type 판정 규칙, 예외 경로 목록과 근거, 비브라우저 클라이언트 규약(Origin 없음 = 허용), `authGate` 자리 예약과 그 계약, 판정 함수의 단일 위치.
2. `docs/internal/FILE_API_BOUNDARY_SRS.md` — `/api/file/*` 의 루트 대조 정책, 그 밖을 켜는 방법, `/api/fs/*` 와의 관계(후자의 가드는 건드리지 않는다는 비목표 명시).

기존 SRS 형식을 따른다: 제목 `# SRS: <제목> — IEEE 29148`, 머리말에 `- 문서 상태: …`, `## 1. 개요` → `1.1 목적` / `1.2 범위`(포함·미포함), 요구사항 FR/NFR, 검증, **§5 비목표**, 변경 기록. 참고 표본: `docs/internal/ACCESS_ALLOWLIST_SRS.md`(같은 게이트 계층을 다룬 문서 — §5 비목표에서 인증·TLS·Host 검증을 "하지 않는다" 고 선언한 부분을 이번에 개정 대상으로 표기해야 한다).

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M2(브라우저 매개 공격 봉합 + 서버 하드닝)를 실행한다.
이 마일스톤은 P0 5건을 포함한다 — 기본 설정(127.0.0.1)에서도 성립하는 브라우저 매개
원격 코드 실행 경로다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M2" 섹션
- docs/internal/production/04-secops.md §1(특히 1.2), §2 P0 전체, §3 P1-2~P1-7, §4.1~4.4, §5, §7
- docs/internal/production/01-go-arch.md 의 P0 와 P1 3건
- docs/internal/production/02-fe-arch.md 의 P0-1, P1(Monaco/fetch), P2 B 항목
- docs/internal/production/05-test.md §1 의 /api/file/write 항목
- docs/internal/production/00-INDEX.md §3 묶음 B1~B8, §2 교차확인 (a)~(i)
- docs/internal/production/07-production-gap.md §1 의 "도입 시 영향 범위" 표
  (게이트 체인 순서 — authGate 자리를 여기서 예약한다)
- docs/internal/ACCESS_ALLOWLIST_SRS.md (기존 게이트 계층의 설계와 §5 비목표)
- docs/internal/production/10-func-backend.md 의 FBE-08 · 12-func-ui.md 의 FUI-06 ·
  09-srs-implementation-gap.md §3 비목표 3(샌드박스 자원 제한)

먼저 선행(M1) 완료를 킥오프 문서의 확인 명령 8줄로 검증하라. 실패하면 착수하지 말고 보고하라.

성격: 중·대 규모다. SDD 를 따른다 — 다음 두 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤
테스트(RED) → 구현(GREEN) 순으로 진행하라:
- docs/internal/REQUEST_GATE_SRS.md
- docs/internal/FILE_API_BOUNDARY_SRS.md
기존 SRS 형식(IEEE 29148, 문서 상태 머리말, §5 비목표, 변경 기록)을 따르라.

게이트 체인은 다음 순서로 만들고 authGate 는 빈 자리로 예약하라(다음 마일스톤이 채운다):
  logging → accessGate(기기) → authGate(예약) → recover → mux

전제: 원격 접속(--expose)이 이 제품의 핵심 목적이고 기본 사용 형태다. 기본 바인드
127.0.0.1 은 유지하되 "기본이 안전하니 노출 경로는 낮은 등급"이라는 추론을 하지 마라.
이 마일스톤은 브라우저 매개 공격을 닫지만 무인증 LAN 노출은 다음 마일스톤까지 열려 있으므로,
그 구간의 운영 안내(ACL 필수·오버레이 망 권장·공용 Wi-Fi 금지)를 README 또는
getting-started.md 에 임시 절로 넣어라.

절대 하지 말 것:
- internal/webserver/domain/git/core 의 초크포인트 재설계 (화이트리스트·인자 가드·마감·
  출력 상한·자격증명 마스킹은 양호 판정. worktree/submodule 이 core.Env() 를 재사용하게
  만드는 것이 이번 작업이다)
- /api/fs/* 의 경로 가드 변경 (EvalSymlinks·조각 단위 경계·O_EXCL 은 양호 판정.
  이번 대상은 가드가 없는 /api/file/* 계층이다)
- 오류 본문 방언 4종 통일 (architecture.md:141-176 이 공개 계약으로 "통일하지 않는다"를
  결정으로 적었다. 문구를 코드화하되 봉투는 그대로)
- ACL 의 RemoteAddr 신뢰·프록시 헤더 무시 설계 변경 (인증은 대체가 아니라 직렬 추가)
- 기본 바인드 127.0.0.1 등 기본값 변경 (노출 시 조건만 더한다)
- git 파괴적 확인창(web/js/git/confirm.js)의 규약 변경 — 모범 사례다.
  _confirmClose 를 이 규약으로 수렴시키는 방향만 허용
- go.mod 에 의존 추가
- 커밋 메시지에 AI 서명 삽입

완료 후 킥오프 문서 M2 의 Definition of Done 을 하나씩 검증해 보고하라.
특히 grep 기반 조건(io.ReadAll(r.Body) 0건, http.Error(w, err.Error()) 0건,
MONACO_CDN 0건, CSP 에 외부 호스트 없음)은 실제 명령 출력을 붙여라.
```

---

## M3 — 데이터 안전·업그레이드·롤백·복원 검증

**목표(한 문장)**: 파괴적 변경(다음 마일스톤의 인증 도입)을 내보낼 수 있는 상태를 만든다 — 판 불일치를 감지하고, 손상·다운그레이드에서 돌아갈 곳이 있고, 재기동 복원 경로가 검증되며, **미저장 편집이 어떤 경로로도 조용히 사라지지 않는다.**

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`07-production-gap.md`](./07-production-gap.md) | §2 관측성 전체(`G2-1`·`G2-2`·`G2-3`), §3 릴리스·업그레이드 전체(`G3-1`·`G3-2`), §4 데이터 안전 전체(홈 15항목 표·손상 감지·백업·`G4-1`~`G4-6`), §12 착수 순서 제안 |
| [`02-fe-arch.md`](./02-fe-arch.md) | P0-2 "부팅 실패 시 워크스페이스를 빈 판으로 덮어씀", P1 "조용히 삼켜지는 실패" |
| [`05-test.md`](./05-test.md) | §1 P0 2건(데몬 재기동 복원 · `stop`/포트킬), §5 "테스트 없이 배포되면 위험한 경로" 표 |
| [`01-go-arch.md`](./01-go-arch.md) | P1 "영속 실패가 성공으로 보인다", P1 "IPC 경계에서 실패를 성공으로 응답" |
| [`04-secops.md`](./04-secops.md) | §4.5 관측성, §4.6 설정 관리, §4.8 업그레이드·마이그레이션 |

프로젝트 파일: `internal/shared/workspace/manager.go`(`:113-122` 손상 처리, `:541` 스키마 검사), `web/js/core/app.js`(`:210-213`), `internal/daemon/ipc/paned.go`(`:170` hello), `internal/webserver/toolclient/client.go`(`:137`), `internal/ctl/cli/start.go`(`:66-70`, `:236-244`), `internal/ctl/cli/proc.go`, `internal/webserver/httpapi/handlers_api.go`(`:354` ping), `internal/ctl/migrate/`(백업 규약 참고), `scripts/verify-isolated.sh`(`:11-13` 사고 기록).

### 2. 선행 완료 확인 — M2

```bash
cd /Users/dykim/personal/dongminal
grep -q 'CheckOrigin' internal/shared/toolhub/conn.go && ! grep -A2 'CheckOrigin' internal/shared/toolhub/conn.go | grep -q 'return true' && echo "origin ok"
[ "$(grep -rn 'io.ReadAll(r.Body)' internal/ | wc -l | tr -d ' ')" = "0" ] && echo "readJSON ok"
[ "$(grep -rn 'http.Error(w, err.Error()' internal/ | wc -l | tr -d ' ')" = "0" ] && echo "errcode ok"
grep -qE 'ReadHeaderTimeout|IdleTimeout' internal/webserver/httpapi/server.go && echo "timeout ok"
[ "$(grep -rn 'MONACO_CDN' web/js/ | wc -l | tr -d ' ')" = "0" ] && test -d web/vendor/monaco && echo "monaco ok"
grep -q 'Content-Security-Policy' internal/webserver/httpapi/static.go && echo "csp ok"
test -f scripts/check-html.sh && bash scripts/check-html.sh && echo "checkhtml ok"
go test ./internal/webserver/httpapi/ -run 'FileWrite|Origin|CSRF|Host' 2>&1 | tail -3
```
일곱 줄 ok + 마지막 테스트 통과면 M2 완료.

### 3. 범위

**포함 발견 (P0 3건)**: `FE-2`(부팅 실패 시 워크스페이스를 빈 판으로 덮어씀 — 데이터 손실) · `TEST-2`(데몬 재기동 복원 경로가 어느 층에서도 검증 안 됨) · `TEST-3`(`stop`·포트킬 경로 테스트 0 — 운영 인스턴스 오살 재발방지 장치 없음).

**포함 발견 (P1 3건)**: `GO-10`(영속 실패가 사용자에게 성공으로 보임) · `GO-8`(IPC 경계에서 실패를 성공으로 응답) · `FE-7`(조용히 삼켜지는 실패 — 설정저장·부팅설정·초기화).

**포함 발견 (P2 4건)**: `SEC-25`(`daemon.log` 무상한) · `SEC-26`(헬스·메트릭 부족) · `SEC-27`(설정파일 스키마·버전 없음, 상위판 다운그레이드 미감지) · `GO-36`(pidfile 반환값 폐기).

**추가 포함 — 기능 축(`10`·`12`)에서 온 7건**

| ID | 내용 | 근거 | 규모 |
|---|---|---|---|
| **FUI-01** (원본 P1 → **P0 재판정**) | 이미 열린 파일을 **다시 열면** 미저장 편집이 디스크 내용으로 조용히 덮인다. `refresh()` 가 `_loading` 만 보고 `_dirty` 를 보지 않는다 | `app-layout.js:469-480`; `file-editor.js:585-611` | S |
| **FUI-02** (P1) | 저장이 외부 변경을 대조하지 않는다 — 마지막 쓰기가 이긴다. **워크스페이스 저장은 이미 ETag/409 를 갖는데 파일 저장에만 없다** | `file-editor.js:561-565`; `handlers_files.go:362-390` | M |
| **FUI-03** (P1) | 새 판 자동 새로고침이 미저장 편집을 묻지 않고 버린다(`edAnyDirty()` 를 이 경로가 읽지 않는다) | `version-watch.js:59-72`; `main.js:151-155` | S |
| **FBE-03** (P1) | 웹서버만 재시작해도 헤드리스 Run 멤버가 15초 안에 강제 종료된다. epoch 가 **웹서버 기동마다 새 uuid** 라 데몬이 살아 있어도 펜싱되고, reaper 가 부팅 직후 즉시 그 Run 의 도구를 죽인다 — `FR-HLM-3` 복원 기계장치가 무력화된다 | `run/store.go:110-132`; `main.go:317`; `handlers_runs_delete.go:120` | M |
| **FBE-07** (P1) | `paned.pid` 를 PID 재사용 검증 없이 신뢰 — 재부팅 후 `stop --all` 이 무관한 프로세스를 SIGTERM→SIGKILL 할 수 있다. **같은 파일의 `Listen` 은 소켓에 대해 정확히 이 문제를 방어한다** | `ctl/cli/proc.go:83-96`; `paned.go:431-436` | S |
| **FBE-17** (P2) | `run.Store` 변경 10곳이 메모리 선반영 후 저장, 실패 시 롤백 없음 → 메모리와 `runs.json` 이 갈라진다 | `run/store.go:203,271,328,361,402` 등 | S/M |
| **FUI-05** (P2) | 저장 실패 피드백이 500ms 붉은 테두리뿐 — 서버가 본문에 실은 사유를 읽지 않는다 | `file-editor.js:575-579`; `handlers_files.go:387` | S |

**미저장 편집 3건이 왜 여기인가** (프론트 마일스톤이 아니라): ① `FUI-02` 는 이미 이 마일스톤에 있는 `G4-5`(편집기 저장 충돌 감지 → 412)의 **클라이언트 짝**이다. 나누면 `handlers_files.go:362-390` 을 두 번 연다. ② 워크스페이스 저장은 ETag/If-Match/409 규약을 갖는데 파일 저장에만 없다 — 이 마일스톤이 이미 그 비대칭의 반대편(`FE-2`)을 다룬다. ③ M6/M7 은 M4 뒤라 거기 두면 데이터 손실이 인증 릴리스를 지나 계속 열린다.

**포함 갭 (10건)**: `G4-1`(**필수** 백업 세대) · `G4-2`(**필수** 손상 감지→격리→복구) · `G3-1`(**필수** 업그레이드 절차 + 데몬↔서버 판 불일치 감지) · `G3-2`(**필수** 롤백 경로) · `G2-1`(**필수** 로그 무상한) · `G2-2`(**필수** 헬스 의미론) · `G2-3`(**필수** 진단 번들) · `G4-4`(설정 가져오기 전 자동 스냅샷) · `G4-5`(편집기 저장 충돌 감지 412) · `G4-6`(보존 정책).

**내부 순서** (원격이 기본 사용 형태이므로 인증 전제 항목을 앞에 둔다): ① `G3-1` 판 불일치 감지 + `G2-2` 헬스 → ② `G4-1` 백업 세대 + `G4-2` 손상 감지 + `FE-2` — **다음 마일스톤의 인증 401 이 프론트 부팅 실패의 새 트리거가 되어 이 덮어쓰기 경로를 유발한다** → ③ `TEST-2`·`TEST-3` 복원·프로세스 제어 검증 → ④ `G2-1`·`G2-3`·`G4-4`~`G4-6` 및 나머지.

**순서 제약 (이 마일스톤에 걸리는 것)**
- **`G4-2`(손상 감지)와 `FE-2`(빈 판 덮어쓰기)는 한 항목이다.** 사슬은 이렇다: `workspace.json` 파싱 실패 → 서버가 `emptyIndex()` 로 계속 기동(`manager.go:113-122`) → `GET /api/state` 가 `ws: null` → 프론트 `_fetchStateKnown` 실패 → `_mkWindow` → **If-Match 없는 PUT** → 서버가 헤더가 비면 stale 검사를 건너뛰고 저장(`manager.go:212`) → 손상 파일이 빈 워크스페이스로 덮인다. 서버만 고치면 다음 부팅 실패에서 같은 일이 나고, 클라이언트만 고치면 손상 파일이 격리되지 않는다.
- **`G2-2`(헬스)가 `G3-1`·`G4-2`·`GO-10` 의 공통 노출 지점이다.** 감지 로직을 만들어도 사용자·CLI·CI 가 볼 자리가 없으면 `waitReady` 가 계속 거짓 준비를 보고한다("데몬에 못 붙은 서버도 준비됨").
- **이 마일스톤이 다음(M4 인증)의 전제다.** 인증 도입은 기존 `--expose` 사용자의 다음 기동을 거부하는 파괴적 변경이므로, 그 릴리스 전에 판 불일치 감지와 롤백 경로가 있어야 한다. 판 불일치를 못 잡으면 새 서버(인증 요구) + 옛 데몬이 조용히 공존하고, 롤백 경로가 없으면 하위 판이 상위 스키마를 조용히 읽는다(`manager.go:541` 은 `<` 만 본다).

**건드리지 말 것**
- **원자 쓰기**(`platform.WriteFileAtomic`, fsync+rename, 상태 파일 7곳 전부) — 양호 판정이다. `G4-1` 은 그 위에 **세대 회전만** 얹고, 회전 후에도 fsync+rename 원자성이 유지되어야 한다.
- **git 자격증명 마스킹**(`domain/git/core/remote.go:22-30`, URL userinfo 마스킹) — `G2-3` 진단 번들은 이 규칙을 **재사용**한다. 새로 만들지 않는다.
- **`--isolated` 구조적 보호**(`start.go:56-64`, `verify` 가 `--port/--home` 을 거부 `options.go:280-284`) — `scripts/verify-isolated.sh:11-13` 이 "그 가드가 없어서 운영 인스턴스를 SIGTERM → SIGKILL 하고 터미널 세션을 잃은 사고가 실제로 있었다" 고 적었다. `TEST-3` 은 이 가드를 **테스트로 고정**하는 작업이며 가드 자체를 재설계하지 않는다.
- **`v1→v2` 마이그레이션 동작**(`internal/ctl/migrate`, `.v1.bak`·`.preuuid.bak`, `--dry-run`, 서버 실행 중 거부) — 양호 판정이다. `G4-1` 의 백업 규약과 통합할 때 기존 동작을 깨지 않는다. 마이그레이션 프레임워크 일반화(`G3-7`)는 **범위 밖**이다.
- **자산 판 단일 진실 공급원**(내용 해시 → `index.html` 치환 + SSE `server_hello` → `version-watch.js` 재로드) — 양호 판정이다. `G3-1` 의 데몬↔서버 판 대조는 별개 계층이다.

### 4. Definition of Done

- `workspace.json` 을 손상시킨 뒤 서버를 띄우면 네 가지가 모두 일어난다: (a) `.corrupt-<ts>` 격리 사본 생성, (b) 최근 백업 세대에서 복원 시도, (c) `GET /api/health` 에 파싱 실패가 실림, (d) 프론트가 빈 판을 PUT 하지 않음(`If-Match` 없는 PUT 을 서버가 거부하고 클라이언트는 재조회부터). 통합 테스트 1개 + e2e 1개로 고정.
- 상태 파일 7곳 저장 시 N세대 회전 파일이 생김을 파일 목록으로 확인. 회전 후에도 fsync+rename 원자성 유지.
- `schemaVersion: 3` 인 `workspace.json` 을 두면 서버가 **거부**하고 백업 복원 안내를 낸다(현재 `manager.go:541` 은 `<` 만 본다).
- 데몬 판 ≠ 서버 판을 인위로 만들면 `start` 가 "데몬 재시작 필요(세션 손실)" 를 안내하고 `/api/health` 에 mismatch 가 실린다. `paned.go:179` 의 `"version": 1`(프로토콜 상수)과 `cli.Version` 이 분리되어 둘 다 hello 에 실림.
- `dongminal verify` 에 "서버 재기동 뒤 `/api/state` 에 같은 도구 id 가 남고 입출력이 왕복한다" 항목이 추가되어 3 OS CI 통과. `internal/shared/toolhub/persist_test.go` 가 `LoadAll` 의 미참조 도구 거르기와 `Restore` 호출을 가짜 PTY 로 검증(현재 둘 다 커버리지 0%).
- `proc.go` 의 `pidsOnPort`/`signalPIDs` 가 인터페이스로 분리되고 표 기반 테스트 4종(포트 매칭 · 기본 포트 거부 · 격리 홈 아님 거부 · SIGTERM→SIGKILL 승격 순서). `go test ./internal/ctl/cli/ -cover` 가 31.5% 를 넘고 `stop.go`·`killPort` 가 0% 를 벗어남.
- `daemon.log`·`restart.log` 가 상한 초과 시 회전됨을 파일 크기로 확인(`WatchLogSize` 호출부가 1곳 → 3곳).
- `GET /api/health` 가 `{version, uptime, daemon:{connected,pid}, workspace:{rev,lastPersistErr}, tools, ws}` 를 반환하고 `start` 의 `waitReady` 가 **데몬 연결까지** 기다린다.
- 디스크 쓰기를 실패시키면 `PUT /api/settings`·`PUT /api/access`·workspace PUT 이 500 을 반환하고 `Close()` 가 flush 오류를 반환해 `serve` 가 비0 종료.
- `dongminal doctor --bundle out.zip` 이 버전·OS·홈 파일 목록·로그 tail 3종·마스킹된 설정/ACL·진단 스냅샷을 담고, `grep` 으로 자격증명·URL userinfo 가 검출되지 않는다.
- 편집기 저장이 mtime/ETag 불일치에 412 를 반환하고 UI 가 충돌을 표시.
- `web/js/core/app-settings.js` 의 `saveSettings` 가 `res.ok` 를 검사하고 실패를 사용자에게 보이며, `core/main.js:14-21` 의 설정 로드 실패가 부팅 화면 문구로 노출.
- 데몬 `write`/`resize` 가 실패를 `PanedError{-32000}` 로 돌려주고 `ToolManager.Write` 가 없는 도구에 `ErrToolNotFound` 를 반환. `ToolHub.Delete` 가 `error` 를 반환.
- **미저장 편집 불변식**이 e2e 로 고정된다: ① dirty 상태에서 같은 파일을 다시 열면 내용이 보존되고 `●` 가 유지된다 ② 두 브라우저에서 같은 파일을 저장하면 뒤쪽이 409/412 를 받고 "덮어쓰기 / 다시 읽기 / 비교" 를 묻는다 ③ dirty 상태에서 자산 판이 바뀌면 자동 새로고침이 배너로 물러난다.
- `POST /api/file/write` 가 `ifMtime`(또는 ETag)을 받고 불일치 시 412. `GET /api/file/read` 응답에 그 값이 실린다. **`FR-EDT-101` 을 "dirty 가 아닐 때만 새로 읽는다" 로 개정**한다(`12 FUI-01` 이 "스펙 결함을 겸한다" 고 지적).
- 저장 실패 시 서버가 본문에 실은 사유가 편집기 `note()` 에 표시된다.
- **`FBE-03`**: `run start` → `run member --headless` → `dongminal stop && dongminal start`(데몬 보존) 후 15초 이상 기다려도 `dmctl run status` 가 Run 을 찾고 `detach --list` 에 도구가 남는다. 펜싱 기준이 "웹서버 기동" 이 아니라 **"멤버의 도구가 실제로 살아 있는가"**(`HeadlessToolIDs` 대조)임을 테스트로 고정.
- **`FBE-07`**: 소켓 dial 성공 시에만 pid 를 신뢰하거나 pidfile 이 기동 시각·소켓 경로를 함께 담고 대조한다. `TEST-3`(`proc.go` 표 테스트)와 한 묶음으로 처리.
- `run.Store` 저장 실패가 메모리와 `runs.json` 을 갈라 놓지 않는다(`runs.json` 디렉터리를 읽기 전용으로 만들고 확인).
- **[결정 6 종속 — 완료 전]** 버전 정책이 major 로 확정되고 폐기 예고를 내기로 하면 이 마일스톤의 릴리스에 `--expose` 무인증 **폐기 예고**를 실어 발행한다. **결정 7(단일 사용자 전용) 확정으로 차단 시점이 "착수 전" → "완료 전" 으로 완화됐다** — 예고를 받을 집단이 인스턴스마다 한 명이라 예고 릴리스의 실익이 낮아졌다. 착수해서 다른 항목을 진행하는 동안 확정하면 된다.
- **보존 확인**: `v1→v2` 마이그레이션 테스트 통과(`internal/ctl/migrate` 커버리지 88.9% 유지), 자산 판 재로드 e2e 통과.

### 5. 선행 결정

**결정 6(버전 정책) 확정이 필요하다. 확정 없이 착수하지 마라.**

- 선택지: (a) `2.0.0` major · (b) `1.1.0` minor + 폐기 예고 유예 후 강제 · (c) `1.x` 패치.
- 권장: **(a) major + 이 마일스톤 릴리스에서 폐기 예고 선행.**
- 이 마일스톤이 바뀌는 지점: (a) 면 Definition of Done 에 "`--expose` 무인증 폐기 예고 릴리스 발행" 이 추가된다. (b) 면 이 마일스톤과 M4 사이에 유예 릴리스가 하나 더 들어가고 M4 의 인증이 "경고만"/"거부" 두 단계로 쪼개진다. (c) 면 예고가 없다.
- **왜 지금 필요한가**: 이 마일스톤을 완성한 뒤에 정하면 예고를 이 릴리스에 실을 기회를 놓치고, 다음 마일스톤의 파괴적 변경이 예고 없이 나간다.

결정 8(평문 허용)·결정 7(멀티유저)·결정 2(접근성)·결정 4(배포 채널)는 이 마일스톤에 영향이 없다.

### 6. SRS 필요 여부

**필요(중·대). 3건.**
0. `docs/internal/EDIT_DURABILITY_SRS.md` — 미저장 편집 불변식, mtime/ETag 규약, 충돌 3지선다, `FR-EDT-101` 개정. **`09` 비목표 7(열린 편집기 탭의 파일 감시)의 처리도 여기서 정한다** — 이 마일스톤은 "저장 시 대조(412)" 까지만 하고 상시 감시는 백로그로 둔다는 결정과 근거를 §5 비목표에 적는다.
1. `docs/internal/STATE_DURABILITY_SRS.md` — 상태 파일 내구성: 백업 세대 정책(대상 7파일·세대 수·회전 시점), 손상 판정 기준, 격리 사본 규약, 복원 순서, 보존 정책(`.bak`·`tool-history`·로그), 진단 번들의 수집 대상과 마스킹 규칙.
2. `docs/internal/UPGRADE_ROLLBACK_SRS.md` — 판 대조 규약(hello 확장), `start` 의 분기와 안내 문구, 스키마 상하위 판정과 거부 동작, 헬스 의미론(readiness 정의 포함), 폐기 예고 절차. §5 비목표에 "마이그레이션 프레임워크 일반화는 하지 않는다" 를 명시.

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M3(데이터 안전·업그레이드·롤백·복원 검증)을 실행한다.
이 마일스톤은 P0 3건(워크스페이스 빈 판 덮어쓰기 · 데몬 재기동 복원 미검증 ·
stop/포트킬 테스트 0)과 필수 갭 7건을 포함한다. 다음 마일스톤(인증 도입)이 파괴적
변경이라서 그 전에 판 불일치 감지와 롤백 경로가 있어야 한다 — 그것이 이 마일스톤의 존재 이유다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M3" 섹션
- docs/internal/production/07-production-gap.md §2, §3, §4 전체와 §12
- docs/internal/production/02-fe-arch.md 의 P0-2, P1 "조용히 삼켜지는 실패"
- docs/internal/production/05-test.md §1 의 P0 2건과 §5 표
- docs/internal/production/01-go-arch.md 의 P1 "영속 실패"·"IPC 경계"
- docs/internal/production/12-func-ui.md 의 P1 FUI-01·02·03 (미저장 편집 손실 3건)
- docs/internal/production/10-func-backend.md 의 FBE-03·FBE-07·FBE-17
- scripts/verify-isolated.sh (11-13 행의 사고 기록 — 이 가드를 테스트로 고정하는 것이 범위)

먼저 선행(M2) 완료를 킥오프 문서의 확인 명령으로 검증하라. 실패하면 착수하지 말고 보고하라.

이 마일스톤을 닫기 전에 사용자에게 확인할 것 (착수는 막지 않는다):
  버전 정책 — 인증 도입을 major(2.0.0)로 낼지. 권장은 major.
  근거가 "사용자 보호"에서 "선언한 규약 준수"로 옮겨갔다 — CHANGELOG 가 SemVer 를
  선언했고 13개 태그가 규약과 일치하는 것이 감사 양호 판정인데, 기동을 거부하는 변경을
  minor 로 내면 그 판정이 무너진다. 단일 사용자 전용 제품으로 확정돼 폐기 예고 릴리스의
  실익은 낮아졌으므로 착수 전 차단은 아니다.

내부 순서를 지켜라: G3-1 판 불일치 + G2-2 헬스 → G4-1 백업 + G4-2 손상 감지 + FE-2 →
TEST-2/TEST-3 → 나머지. 다음 마일스톤의 인증 401 이 프론트 부팅 실패의 새 트리거가 되어
FE-2(빈 판 덮어쓰기)를 유발하므로 그 경로를 먼저 닫아야 한다.

성격: 중·대 규모다. SDD 를 따른다 — 다음 세 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤
테스트(RED) → 구현(GREEN) 순으로 진행하라:
- docs/internal/STATE_DURABILITY_SRS.md
- docs/internal/UPGRADE_ROLLBACK_SRS.md
- docs/internal/EDIT_DURABILITY_SRS.md (미저장 편집 불변식·mtime/ETag 규약·3지선다 UI·FR-EDT-101 개정)

추가 범위 (기능 축 조사에서 왔다):
- 미저장 편집 손실 3건 — 파일을 다시 열면 dirty 버퍼가 덮이고(FUI-01, P0 로 재판정),
  저장이 외부 변경을 대조하지 않으며(FUI-02), 새 판 자동 새로고침이 dirty 를 버린다(FUI-03).
  워크스페이스 저장은 이미 ETag/409 를 갖는데 파일 저장에만 없다는 비대칭이 근거다.
  FUI-02 는 이 마일스톤의 G4-5(편집기 저장 충돌 412)와 같은 작업이니 함께 하라.
- FBE-03: 웹서버만 재시작해도 헤드리스 Run 멤버가 15초 안에 죽는다. 펜싱 epoch 가
  웹서버 기동마다 새 uuid 라서 데몬이 살아 있어도 펜싱된다.
- FBE-07: paned.pid 를 PID 재사용 검증 없이 신뢰한다. 같은 파일의 Listen 이
  소켓에 대해 이미 옳게 방어하고 있으니 그 판정을 재사용하라.

주의: 손상 감지(서버)와 빈 판 덮어쓰기 방지(프론트)는 한 사슬이다. 한쪽만 고치면
결함이 남는다. 사슬 전체는 07-production-gap.md §4 의 "손상 감지·복구" 문단에 있다.

절대 하지 말 것:
- platform.WriteFileAtomic 의 원자 쓰기 재설계 (양호 판정. 세대 회전만 얹고 fsync+rename
  원자성을 유지하라)
- --isolated 구조적 보호 재설계 (실제 사고에서 나온 가드다. 테스트로 고정만 하라)
- v1→v2 마이그레이션 동작 변경 (양호 판정. 백업 규약 통합 시 기존 동작 유지)
- 마이그레이션 프레임워크 일반화 (범위 밖 — SRS §5 비목표에 명시하라)
- 자산 판 재로드 설계 변경 (양호 판정. 데몬↔서버 판 대조는 별개 계층)
- git 자격증명 마스킹 규칙 새로 만들기 (진단 번들은 기존 규칙을 재사용)
- go.mod 에 의존 추가
- 커밋 메시지에 AI 서명 삽입

완료 후 킥오프 문서 M3 의 Definition of Done 을 하나씩 검증해 보고하라.
손상 시나리오는 실제로 파일을 깨뜨려 4가지 동작을 확인하고 출력을 붙여라.
```

---

## M4 — 인증·인가·전송 보호 + 제품 경계 — ⊘ **수행하지 않는다**

> **⊘ 사용자 결정 9 (2026-09-11)**: *"인증은 하지 않는다. 지금의 tailscale + ip
> 인증방식으로 갈무리한다."* TLS 만 넣는 축소안도 함께 기각됐다.
> **이 절의 착수 지시를 따르지 마라** — `PRODUCTION_ROADMAP.md` §2 M4 머리말이
> 폐기 목록·M5 이월 5건·잔여 위험 4건을 적고 있다. 다음 마일스톤은 **M5** 이고
> 착수 프롬프트는 [`M5_NEXT_SESSION.md`](./M5_NEXT_SESSION.md) 다.
> 아래는 근거 기록이다.

**목표(한 문장)**: **제품의 핵심 사용 형태(원격 접속)를 성립시킨다** — 노출 시 인증이 필수이고, 인증이 없으면 노출 모드로 뜨지 않는다.

**성격**: 이것은 "노출을 쓰는 사람을 위한 옵션" 이 아니다(§0-1-1). 원격 접속이 제품의 존재 이유이므로 **이 마일스톤이 끝나기 전까지 제품의 기본 사용 형태가 무인증 상태다.** `SEC-3`(무인증·평문 LAN 노출)을 로드맵이 P1 → **P0** 로 재판정한 이유가 이것이다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`07-production-gap.md`](./07-production-gap.md) | **§1 인증·인가 전체**(현재 상태·프로덕션 기준선 7항목·갭 표·**"도입 시 영향 범위" 계층 표**), §10 제품 경계(`G10-1`), §5 설정 관리(`G5-3`) |
| [`04-secops.md`](./04-secops.md) | §1 의도된 보안 모델, §3 P1-1(`--expose` 무인증), §5 양호한 점(ACL 설계) |
| [`00-INDEX.md`](./00-INDEX.md) | §1 P1 `SEC-3` |

프로젝트 파일: `internal/webserver/httpapi/server.go`(`:196-216` 체인 — M2 가 `authGate` 자리를 예약해 둠), `access.go`(`accessStore` 형태 — `auth.go` 를 같은 모양으로), `internal/webserver/httpapi/handlers_api.go`(`:69-201` 라우팅 표), `internal/ctl/cli/actions.go`·`options.go`·`start.go`(`:36-42` 노출 결정), `internal/shared/dmenv/dmenv.go`(환경 계약), `internal/shared/toolhub/tool.go`(`StartTool` 환경 조립), `internal/helper/runtimebin/http.go`(`:40-70`), `e2e/fixtures.ts`, `docs/internal/ACCESS_ALLOWLIST_SRS.md`(§5 비목표 — 개정 대상).

### 2. 선행 완료 확인 — M3 · M2

```bash
cd /Users/dykim/personal/dongminal
# M3
grep -qE 'SchemaVersion >|schemaVersion >' internal/shared/workspace/manager.go && echo "schema guard ok"
grep -rq 'corrupt' internal/shared/workspace/ && echo "quarantine ok"
grep -rq 'lastPersistErr\|persistErr' internal/ && echo "persist err ok"
grep -rq 'bundle' internal/ctl/cli/ && echo "diag bundle ok"
grep -q '재기동\|restart' internal/ctl/cli/verify.go && echo "verify restart item ok"
go test ./internal/ctl/cli/ -cover 2>&1 | grep -oE 'coverage: [0-9.]+%'   # 31.5% 초과 확인
go test ./internal/shared/toolhub/ -run 'LoadAll|Restore' 2>&1 | tail -2
# M2 (게이트 자리 예약 확인)
grep -q 'authGate' internal/webserver/httpapi/server.go && echo "authGate slot reserved"
```
전부 통과하고 `ctl/cli` 커버리지가 31.5% 를 넘으면 선행 완료.

### 3. 범위

**확정 전제(결정 5)**: 브라우저는 비밀번호 로그인 + `HttpOnly; SameSite=Strict` 세션 쿠키, 비브라우저(`dmctl`·제어 CLI)는 `Authorization: Bearer`. **URL 토큰 방식이 아니다.** 근거: 쿠키면 프론트 `fetch` 80곳/29파일·`gitFetch/gitPost` 25곳·`new WebSocket` 2곳·`new EventSource` 2곳이 **수정 0**(브라우저가 자동 전송), e2e 직접 HTTP 303곳도 `page.request` 쿠키 공유로 대부분 그대로.

**포함 발견**: `SEC-3`(감사 원본 **P1** → 로드맵 재판정 **P0** — `--expose`/`DONGMINAL_HOST` 가 무인증·평문·ACL 기본꺼짐으로 PTY 를 LAN 에 염). 재판정 근거: `04 §1.2` 가 P0 등급을 매긴 기준이 "전제의 성립성" 이었고(기본 127.0.0.1 에서도 성립), `SEC-3` 이 P1 에 머문 유일한 이유는 전제가 "사용자가 `--expose` 를 쓴다" 였는데 그 전제가 항상 성립한다. 영향은 무인증 사용자 권한 RCE 로 `SEC-1`·`SEC-2` 와 동급이다.

**포함 갭 (9건)**: `G1-1`(**필수** 인증 자체가 없다 — "누구" 를 판정하는 코드 0줄) · `G1-2`(**필수** 자격증명 발급·저장·회전 CLI + 0600 규약) · `G1-3`(**필수** 세션 수명·로그아웃·활성 세션 목록/폐기) · `G1-4`(**필수** 무차별 대입 방어) · `G1-5`(**축소** 노출 모드 TLS — `--tls-cert/--tls-key` 두 플래그, 규모 S) · `G1-6`(특권 작업 분리) · `G1-7`(데몬 IPC 인증) · `G5-3`(서버 설정 파일) · `G10-1`(**필수** 보안 경계 문서).

**추가 포함 — `13` 에서 온 P1 2건**

| ID | 내용 | 근거 | 규모 |
|---|---|---|---|
| **TLS-1** | 평문 원격에서 **데스크톱 알림이 조용히 죽어 있다.** `app.js:314` 에서 `attnDesktop` 기본값이 `true` 인데 `http://<사설IP>` 는 secure context 가 아니라 `Notification` **API 자체가 없다**(`app-attn.js:363` 가드에서 즉시 `return`). 토글은 켜진 채 남고(`:421` 이 조건 밖) `app-backup.js:19` 가 백업·복원까지 한다. **어디에도 "이 환경에서는 동작하지 않는다" 는 표시가 없다.** 로컬(`localhost`)에서는 secure context 라 정상 동작해 **개발 중에는 절대 드러나지 않는다** | `13 §1` | S/M |
| **TLS-2** | 노출 판정이 `0.0.0.0`/`::` 만 봐서 `DONGMINAL_HOST=192.168.1.5` 가 **`local-only` 로 오표시된다.** 인증 강제 조건이 이 판정에 걸리므로 고치지 않으면 "노출인데 인증을 요구하지 않는" 구멍이 남는다 — **이 마일스톤의 전제** | `13 §2-2`; `start.go:133,248` | S |

**`TLS-1`(알림 묶음)이 왜 여기인가** — UX 마일스톤(M7)까지 미루지 않는다: ① **UX 개선이 아니라 조용한 실패**다(로드맵이 같은 유형 `FE-7` 을 M3 에 두었다) ② **이 마일스톤이 "원격 접속을 정식 지원한다" 고 선언하는 릴리스**이고 그 선언과 "원격 기본 경로에서 알림이 죽는다" 는 양립할 수 없다 ③ 이 제품의 attention 체계는 **에이전트 감시**를 위해 있다 — 브라우저 밖에 있을 때 알리는 수단이 전부 죽으면 핵심 가치가 기본 경로에서 무의미해진다 ④ M7 은 M6 뒤이고 M6 은 이 마일스톤 뒤라 미루면 인증 릴리스와 M5·M6 을 지나서도 계속 못 받는다 ⑤ 셋(토글 비활성화 / 알림음 기본 켜짐 / 탭 제목)은 한 시나리오를 함께 성립시켜 나누면 각각이 불완전하다.
> 단 **③ 탭 제목은 secure context 가 필요 없고 지금 아예 없는 기능이며 수 줄**이다(`web/js/` 전체에서 `document.title` 대입 0곳). TLS 와 독립적으로 이득이 있으므로 **이 마일스톤을 기다리지 않고 M3 에서 앞당겨도 된다.**

**순서 제약 (이 마일스톤에 걸리는 것)**
- **M3 이 선행이다(필수).** 인증 도입은 기존 `--expose` 사용자의 다음 기동을 거부하는 **파괴적 변경**이다. 판 불일치 감지(`G3-1`)와 롤백 경로(`G3-2`·`G4-1`)가 먼저 있어야 한다.
- **M2 가 예약한 자리를 채운다.** 체인은 `logging → accessGate(기기) → authGate(여기) → recover → mux`. **ACL 은 인증의 대체가 아니라 직렬 선행 필터다** — ACL 이 "어느 기기" 를, 인증이 "누구" 를 판정한다.
- **loopback 무조건 통과(FR-ACL-5)를 인증에 적용하지 마라.** 브라우저 매개 공격이 정확히 loopback 출발지다. 서버가 도는 기기의 CLI(`health`·`migrate`)는 토큰 파일을 읽으면 되므로 예외가 필요 없다.
- **`FE-8`(`core/api.js`)이 M2 에서 끝났으면 401 공통 처리가 한 자리다.** 안 끝났으면 29파일이 된다 — 착수 전 확인하라.

**건드리지 말 것**
- **ACL 설계 전체** — `RemoteAddr` 만 신뢰하고 프록시 헤더를 무시하는 것, 목록 내용을 403 본문에 싣지 않는 것, DNS 해석을 요청 경로 밖에서만 하는 것은 양호 판정이다. ACL 을 인증으로 **대체하지 않는다.**
- **`--isolated` 구조적 보호와 기본 바인드 127.0.0.1** — 기본값은 안전하다는 판정을 유지한다.
- **M2 의 게이트 체인 순서** — `authGate` 를 다른 자리에 넣지 않는다.
- **git 자격증명 취급**(`GIT_TERMINAL_PROMPT=0`·`GIT_ASKPASS=`·URL userinfo 마스킹) — 인증 토큰 로깅에도 같은 마스킹 원칙을 적용하되 기존 규칙을 바꾸지 않는다.
- **`go.mod` 경량성** — TLS 는 표준 `crypto/tls`, 자체 서명 인증서 생성도 `crypto/x509` 로. JWT·세션 라이브러리·bcrypt 패키지를 추가하지 않는다(해시는 표준 `crypto` 계열로).
- **다중 사용자·역할 체계 금지**(`G1-8`, XL) — 범위 밖이다. 단일 소유자 제품이므로 역할 대신 "특권 작업은 loopback 세션 또는 재인증" 으로 처리한다.
- **오류 방언 통일 금지** — 401/403 은 새 표면이므로 새 봉투를 쓸 수 있지만 기존 4방언을 통일하지 않는다.

### 4. Definition of Done

- 인증 미설정 상태에서 `--expose`/`DONGMINAL_HOST` 로 기동하면 **거부**되고 사유와 해결 명령이 출력된다.
- `dongminal auth init` 이 `$DONGMINAL_HOME/auth.json`(0600, 스키마 버전 포함)을 만들고 비밀을 한 번만 출력. `auth rotate` 후 기존 세션 전부 401. `auth show` 는 loopback 전용.
- 무인증 `GET /api/settings`·`PUT /api/access`·`GET /ws` 가 401 — **loopback 출발지에서도**. 예외 경로만 통과: `/`, 정적 자산, `/login`, `/api/ping`. `dongminal verify` 에 "무인증 요청이 401" 항목이 추가되어 3 OS CI 통과.
- 로그인 성공 시 `HttpOnly; SameSite=Strict` 쿠키가 내려오고 노출+TLS 에서는 `Secure` 가 붙는다. **프론트 fetch/WS/SSE 호출부 수정 0** 을 diff 로 확인.
- 세션 절대·유휴 수명 만료 시 401. `GET /api/auth/sessions` 나열, `DELETE` 로 개별 폐기.
- 로그인 실패가 출발지별 지수 백오프·잠금을 받고, 비밀 비교가 `crypto/subtle` 상수시간이며, 실패가 기존 ACL 실패 로그 형식(`FR-ACL-13`)을 재사용한다.
- `dmctl`·`edit`·`detach`·`open-url` 이 도구 셸 환경의 `DONGMINAL_TOKEN`(`shared/dmenv` 상수 + `toolhub/tool.go` `StartTool` 주입)으로 통과하고 토큰을 지우면 401. `runtimebin/http.go:40-70` 두 클라이언트만 고쳐 호출부 17곳/9파일이 자동 통과함을 확인.
- `internal/ctl/cli/verify.go:254,264,283,323` 4곳이 토큰 파일을 읽어 헤더를 붙인다.
- 특권 종단(`PUT /api/access`, `POST /api/auth/rotate`, 설정 전체 교체, `PUT /api/sandbox/config`)이 loopback 세션 또는 재인증을 요구하고 원격 세션에서 403.
- 프론트가 `/api/settings`·`/api/state` 401 을 받아 로그인 화면으로 분기. 세션 만료 재로그인 유도가 한 자리에서 처리.
- e2e 가 fixture 의 로그인 쿠키 `storageState` 로 통과하고 직접 HTTP 303곳/63파일이 대부분 무변경.
- `server.json`(또는 동등물)이 존재하고 우선순위가 **플래그 > 환경변수 > 파일 > 기본값** 임을 테스트로 확인.
- 문서: `README.md:77-79` 의 "인증이 없으므로 신뢰하는 망에서만" 제거. `SECURITY.md` 에 위협 모델·지원 배포 형태(loopback / Tailscale / LAN+인증+TLS / 리버스 프록시)별 보증. `getting-started.md` 노출 절과 `api.md` 인증 절 갱신. `ACCESS_ALLOWLIST_SRS.md §5` 의 비목표 6개 중 해소된 항목 개정.
- **TLS(축소안)**: `--tls-cert`/`--tls-key` 를 주면 `ListenAndServeTLS` 로 뜨고 **한쪽만 주면 기동 거부**. 주지 않으면 평문으로 뜨고 기동 로그에 경고 한 줄(거부하지 않는다). `Secure` 쿠키가 자체 TLS 에서 붙고 평문에서 안 붙는다. `dongminal verify` 에 "TLS 켜짐이면 인증서 SAN 이 현재 바인드 주소를 덮는가 / 만료 임박 아닌가"(`13` TLS-4) 추가.
- **`TLS-2` 노출 판정 확장**: `start.go:133`·`:248` 이 **비 loopback 바인드 전체**를 노출로 본다. `DONGMINAL_HOST=192.168.1.5` 로 띄우면 노출로 표시되고 **인증 강제가 걸린다**(현재는 오표시로 빠져나간다). `pingHost` 연동 주의. 표 테스트: `127.0.0.1`·`::1`·`localhost` = 로컬 / `0.0.0.0`·`::`·`192.168.x`·`10.x`·`100.64.x` = 노출.
- **`TLS-1` 알림 결손 해소 — 셋 다**: ① `window.isSecureContext===false` 면 데스크톱 알림 토글이 **비활성화되고 사유·해결 경로가 표시된다** ② 같은 조건에서 **알림음이 기본 켜짐**으로 전환된다(기본값이 환경에 따라 갈리는 이유를 주석에 근거와 함께 남긴다. 사용자가 끄면 그 선택 우선) ③ **탭 제목에 미확인 attn 수**가 붙는다(`(2) dongminal`). 검증: `http://<사설IP>` 로 접속해 토글이 비활성이고 사유가 보이며, attn 발생 시 소리가 나고 탭 제목이 바뀐다.
- **리버스 프록시 미지원 선언**이 `G10-1` 에 있고 **"불가능해지는 것이 아니라 보증하지 않는 것"** 이라는 차이가 명시된다 — 앱을 `127.0.0.1` 에 두고 프록시를 붙이는 것은 지금도 동작하며 그때는 ACL 을 끄면 된다.
- **첫 경험**: 기동 거부 메시지에 **`dongminal auth init` 을 함께 출력**한다. `--isolated` 는 **강제에서 제외**(e2e 보호).
- **`G10-1` 이 다음을 모두 담는다(전제 재정의)**: ① 위협 모델 — 주 시나리오가 "로컬 도구가 실수로 노출되는 경우" 가 아니라 **"인터넷 또는 사설망에 상시 노출된 원격 작업 도구"** 다. 공격면은 도달 가능한 PTY·파일 읽기/쓰기·git 쓰기·명령 실행 종단 전부. ② 지원 배포 형태를 **권장 순서**로: Tailscale·WireGuard 등 오버레이 망 뒤(권장) → 리버스 프록시 + TLS → LAN + 인증 + TLS → loopback 전용(개발용). 각 형태의 보증 수준을 적는다. ③ **명시 선언: 단일 사용자 전용 · 멀티유저 호스트 미지원**(확정 결정 7). ④ 상시 노출 전제의 운영 권고 — 자격증명 회전 주기, 인증 실패 로그·잠금 확인 방법, **노출 상태 가시화**(상태바 또는 `/api/health` 에 "노출 중"). ⑤ `README.md:77-79` 대체와 M2 임시 안내 절 회수.
- **[결정 6 종속]** `CHANGELOG.md` 의 파괴적 변경 명시와 버전 번호.
- **보존 확인**: ACL 관련 테스트(`access_test.go` 352줄)와 `access-allowlist.spec` e2e 통과 — 인증 추가가 ACL 동작을 바꾸지 않았다는 증거.

### 5. 선행 결정

**없음. 결정 8 이 확정됐다(TLS 축소안 — §범위의 확정 전제 표).**

확정 내용 요약: 인증 필수(변경 없음) · TLS 는 `--tls-cert/--tls-key` 두 플래그만 · **앱이 인증서를 만들지 않는다**(로컬 CA 보류) · 기본은 평문 + 경고이고 **TLS 미설정은 기동 거부 사유가 아니다** · 리버스 프록시 미지원 선언 · `G1-5` 규모 M/L → S.

**보류 배경으로 알아 둘 사실**: W3C Secure Contexts 명세는 **인증서 유효성을 보지 않고 스킴만 본다**. 그러나 Chrome 이 인증서 오류 페이지에 별도 차단을 건 전례가 있어(ServiceWorker 등록 실패, Chromium 40423989) **자체 서명 + 예외 승인으로 기능이 복구되는지는 보장되지 않는다.** 로컬 CA 설치는 그 불확실성이 없는 유일한 경로였고 그것이 리포트의 권장 근거였다 — 보류를 되돌릴 때 이 사실이 다시 근거가 된다. **지금은 그 경로를 구현하지 마라.**

**결정 7(멀티유저)·결정 5(쿠키)는 확정.** 결정 6(버전 정책)은 M3 을 닫기 전에 확정돼 있어야 한다.

**착수 전 조사 항목 1건**: Windows 의 AF_UNIX 소켓 접근 제어와 인증 게이트 상호작용 — 감사가 POSIX 만 확인했다(`07 §11-1`). M2 의 소켓 0600 조치가 Windows 에서 등가인지 확인하라.

### 6. SRS 필요 여부

**필요(대). 2건.**
1. `docs/internal/AUTH_SESSION_SRS.md` — 자격증명 수명주기(발급·저장·회전·표시), 세션 규약(수명·쿠키 속성·목록·폐기), 예외 경로 목록과 근거, 무차별 대입 방어, 비브라우저 클라이언트 계약(`DONGMINAL_TOKEN` 전달 경로와 범위), 특권 작업 정의, loopback 예외를 인증에 적용하지 않는다는 결정과 근거.
2. `docs/internal/TRANSPORT_SECURITY_SRS.md` — **범위가 축소됐다**: `--tls-cert/--tls-key` 계약, 한쪽만 준 경우의 거부, `Secure` 쿠키 판정, 평문 기본의 경고 문구, **로컬 CA 를 보류한 결정과 근거**, 리버스 프록시 미지원 선언. `13 §6-4` 의 DoD 제안 중 **로컬 CA 관련 항목은 제외**한다. §5 비목표에 “앱이 인증서를 발급하지 않는다” 를 명시.

또한 **`docs/internal/ACCESS_ALLOWLIST_SRS.md §5`(비목표)를 개정**한다 — 그 문서가 "인증(토큰·비밀번호·사용자 개념)·TLS·Host 헤더 검증을 하지 않는다" 를 명시적 비목표로 선언했고, 이 마일스톤과 M2 가 그 셋을 모두 도입한다. 개정은 삭제가 아니라 "이 비목표는 `AUTH_SESSION_SRS`/`REQUEST_GATE_SRS` 로 대체됨" 표기로 한다.

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M4(인증·인가·전송 보호 + 제품 경계)를 실행한다.
원격 접속이 이 프로젝트의 핵심 목적이고 기본 사용 형태다 (사용자 원문: "--expose 는
필수인게 원격 작업을 위한 프로젝트임"). 따라서 인증은 "노출을 쓸 때만 필요한 옵션"이
아니라 제품 성립 요건이고, 이 마일스톤이 끝나기 전까지 제품의 기본 사용 형태가 무인증
상태다. 인증을 판정하는 코드가 현재 0줄이다.
SEC-3(무인증·평문 LAN 노출)은 감사 원본 P1 이지만 이 전제에서 로드맵은 P0 로 본다.

확정된 사용자 결정 (바꾸지 마라):
- 브라우저는 비밀번호 로그인 + HttpOnly; SameSite=Strict 세션 쿠키
- 비브라우저(dmctl·제어 CLI)는 Authorization: Bearer + DONGMINAL_TOKEN
- URL 토큰 방식이 아니다 (쿠키면 프론트 fetch 80곳/WS 2곳/SSE 2곳 수정이 0 이다)

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M4" 섹션
- docs/internal/production/07-production-gap.md §1 전체 (특히 "도입 시 영향 범위" 계층 표 —
  어느 파일에서 무엇을 고치는지 전부 나열되어 있다), §10 G10-1, §5 G5-3
- docs/internal/production/04-secops.md §1, §3 P1-1, §5
- docs/internal/ACCESS_ALLOWLIST_SRS.md (§5 비목표 — 이번에 개정 대상)
- internal/webserver/httpapi/server.go (M2 가 authGate 자리를 예약해 뒀다)
- internal/webserver/httpapi/access.go (accessStore 형태 — auth.go 를 같은 모양으로)
- docs/internal/production/13-tls-tailscale.md §1(TLS-1 알림 결손) · §2-2(TLS-2 노출 판정) ·
  §2-3(ACL 기여도 판정) · §5-C(인증 vs TLS 관계, 첫 경험, 리버스 프록시) · §8(철회 이력).
  **§5-A 의 로컬 CA 권장안은 채택하지 않았다** — 결정 8 이 우선한다

먼저 선행(M3·M2) 완료를 킥오프 문서의 확인 명령으로 검증하라. 실패하면 착수하지 말고 보고하라.

확정된 것 (바꾸지 마라):
  TLS 축소안(결정 8) — 인증은 필수이고 변경 없다. TLS 는 --tls-cert/--tls-key 두 플래그만
  구현한다. 앱이 인증서를 만들지 마라(로컬 CA·ACME·Tailscale 연동 전부 보류·제외).
  기본은 평문 + 경고이고 TLS 미설정은 기동 거부 사유가 아니다.
  --insecure-plaintext 게이트를 두지 마라. 리버스 프록시는 미지원 선언(문서 한 줄)이고
  X-Forwarded-* 를 읽는 코드를 넣지 마라.
  근거: 리포트 13 은 로컬 CA 를 권장했으나 사용자가 비용 대비 가치를 따져 축소를 확정했다.
  실질 위험이 쿠키 도청 하나로 좁혀졌고 그것은 네트워크에 달려 있다는 판단이다.
  멀티유저 호스트 미지원 — SECURITY.md 에 "단일 사용자 전용 · 멀티유저 호스트 미지원"을
  명시 선언으로 넣는다. 단 G1-7(데몬 IPC 인증)과 홈 0700·소켓 0600·로그 0600 은 유지한다
  (미지원 선언은 심층 방어 포기가 아니다). 다중 사용자·역할 체계는 영구 제외.

성격: 대 규모다. SDD 를 따른다 — 다음 두 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤
테스트(RED) → 구현(GREEN) 순으로 진행하라:
- docs/internal/AUTH_SESSION_SRS.md
- docs/internal/TRANSPORT_SECURITY_SRS.md
그리고 docs/internal/ACCESS_ALLOWLIST_SRS.md §5 의 비목표를 "대체됨" 으로 개정하라.

추가 범위 (전송 보호 축 13 에서 왔다):
- TLS-2: 노출 판정을 비 loopback 바인드 전체로 확장하라. 지금은 0.0.0.0/:: 만 봐서
  DONGMINAL_HOST=192.168.x 가 local-only 로 오표시된다. 인증 강제 조건이 이 판정에
  걸리므로 이것을 먼저 고쳐야 인증 강제가 제대로 걸린다.
- TLS-1: 평문 원격에서 데스크톱 알림이 조용히 죽어 있다. attnDesktop 기본값이 true 인데
  Notification API 자체가 없어 즉시 return 하고, 토글은 켜진 채 남으며 아무 표시도 없다.
  셋을 함께 하라 — ① isSecureContext===false 면 토글 비활성화 + 사유·해결 안내
  ② 같은 조건에서 알림음 기본 켜짐 전환 ③ 탭 제목에 미확인 attn 수 표시.
  ③ 은 secure context 가 필요 없고 지금 아예 없는 기능이다(document.title 대입 0곳).
  이것은 UX 개선이 아니라 조용한 실패 제거다 — 이 마일스톤이 "원격을 정식 지원한다"고
  선언하는 릴리스인데 원격 기본 경로에서 알림이 죽어 있으면 그 선언이 거짓이 된다.

게이트 자리와 순서 (바꾸지 마라):
  logging → accessGate(어느 기기) → authGate(누구) → recover → mux
ACL 은 인증의 대체가 아니라 직렬 선행 필터다. 그리고 loopback 무조건 통과(FR-ACL-5)를
인증에는 적용하지 마라 — 브라우저 매개 공격이 정확히 loopback 출발지다.

절대 하지 말 것:
- ACL 설계 변경 (RemoteAddr 만 신뢰·프록시 헤더 무시·403 본문에 목록 미노출은 양호 판정)
- 기본 바인드 127.0.0.1 등 기본값 변경
- 다중 사용자·역할 체계 도입 (사용자가 미지원을 확정했다. 특권 작업은 loopback 세션
  또는 재인증으로 처리하라. 단 홈 0700·소켓 0600·로그 0600 과 G1-7 은 유지한다)
- go.mod 에 의존 추가 — TLS 는 crypto/tls, 인증서는 crypto/x509, 비교는 crypto/subtle.
  JWT·세션·bcrypt 라이브러리 금지
- 오류 본문 방언 4종 통일 (401/403 은 새 표면이라 새 봉투 가능, 기존은 그대로)
- 커밋 메시지에 AI 서명 삽입

착수 전 조사 1건: Windows 의 AF_UNIX 소켓 접근 제어가 인증 게이트와 어떻게 맞물리는지
(감사는 POSIX 만 확인했다).

완료 후 킥오프 문서 M4 의 Definition of Done 을 하나씩 검증해 보고하라.
"프론트 fetch/WS/SSE 호출부 수정 0" 은 diff 로 증명하라.
```

---

## M5 — 관측성·에러 규약·설정 관리·문서·릴리스 운영

**목표(한 문장)**: 배포된 제품에서 들어오는 문제를 받고 진단하고 되돌릴 수 있는 운영 표면을 만든다.

> **선행이 풀렸다 (결정 9, 2026-09-11)**: 이 절이 적은 선행 `M4` 는 **수행하지 않는다.**
> 401/403 오류 표면이 생기지 않으므로 `G6-1` 을 기다릴 이유가 사라졌고, `G5-3` 은
> M5 자신의 항목이 됐다. **M4 이월 5건**(`G10-1`·README 대체·`TLS-2`·`G5-3`·`TLS-1`)이
> 이 마일스톤에 추가됐다 — 범위는 `PRODUCTION_ROADMAP.md` §2 M5 가 진실이다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`07-production-gap.md`](./07-production-gap.md) | §2 관측성(`G2-4`·`G2-5`·`G2-6`), §3(`G3-3`·`G3-4`·`G3-6`), §4(`G4-3`·`G4-7`), §5 설정 관리(`G5-1`·`G5-2`), §6 에러 처리 규약 전체, §8 개발자 경험(`G8-1`·`G8-2`·`G8-5`), §9 성능·용량(`G9-1`·`G9-2`), §10 제품 경계(`G10-2`~`G10-5`) |
| [`06-docs-hygiene.md`](./06-docs-hygiene.md) | §1 인벤토리와 "상태 표기 체계 — 없음"(상태 필드가 있는 7개 SRS 의 형식), §2-1·2-2·2-3 문서↔코드 대조 결과 |
| [`04-secops.md`](./04-secops.md) | §4.5 관측성, §4.7 공급망(`SEC-31`) |
| [`01-go-arch.md`](./01-go-arch.md) | P2 "로깅 `log.Printf` 146곳" |

프로젝트 파일: `internal/webserver/apierr/`(`tables.go`·`codes.go`·`inventory.go` — 잘 설계된 등록부, 확장 대상), `docs/internal/architecture.md:141-176`(오류 방언 4종 공개 계약), `docs/external/api.md`·`commands.md`·`shortcuts.md`·`features.md`, `internal/helper/runtimebin/dmctl.go:36-57`, `internal/webserver/gitapi/routes.go:16-88`.

### 2. 선행 완료 확인 — M4

```bash
cd /Users/dykim/personal/dongminal
grep -rq 'HttpOnly\|SameSite' internal/webserver/httpapi/ && echo "cookie ok"
grep -rq 'DONGMINAL_TOKEN' internal/shared/dmenv/ && echo "token env ok"
grep -rq 'authGate' internal/webserver/httpapi/server.go && echo "gate ok"
test -f SECURITY.md && echo "security doc ok"
[ "$(grep -c '인증이 없으므로' README.md)" = "0" ] && echo "readme updated ok"
grep -rq 'auth' internal/ctl/cli/actions.go && echo "auth cli ok"
grep -q '401' internal/ctl/cli/verify.go && echo "verify 401 item ok"
```
일곱 줄 모두 ok 면 M4 완료.

### 3. 범위

**포함 발견 (6건)**: `DOC-2`(P1, `commands.md` 가 `dmctl` 서브커맨드 절반 가까이 미문서화) · `DOC-4`(P1, `api.md` 가 HTTP 표면 절반 이상 누락 — Git 60+·Run 13) · `DOC-1`(P2, SRS 113개 중 106개에 구현상태 필드 없음) · `DOC-3`(P2, `shortcuts.md` 누락 2건) · `GO-43`/`SEC-24`(P2, 비구조화 로깅) · `SEC-23`(P2, 웹서버 프로세스 감독 부재) · `SEC-31`(P2, 체크섬 미서명).

**포함 갭 (22건)**: `G2-4`·`G2-5`·`G2-6` · `G6-1`·`G6-2`·`G6-3` · `G5-1`·`G5-2` · `G3-3`·`G3-4`·`G3-6` · `G4-3`·`G4-7` · `G8-1`·`G8-2`·`G8-5` · `G9-1`·`G9-2` · `G10-2`·`G10-3`·`G10-4`·`G10-5`.

**순서 제약 (이 마일스톤에 걸리는 것)**
- **M4 가 선행이다.** `G6-1`(오류 코드화)의 새 표면이 401/403 이고 `G5-3`(서버 설정 파일)이 인증·TLS 옵션으로 확정된 뒤여야 두 번 쓰지 않는다.
- **`G6-1` 이 M9(i18n)의 전제다.** 서버가 한국어 문장을 내보내면 프론트가 로케일을 정할 수 없다. 여기서 코드화하면 M9 는 잔여 한국어 제거만 남는다.

**건드리지 말 것**
- **오류 본문 방언 4종 통일 금지.** `architecture.md:141-176` 이 git `{error,message}` · fs `{code,message}` · runs `{error,detail}` · 단문 `{error}` 를 공개 계약으로 문서화하고 "통일하지 않는다(파괴적 변경)" 를 결정으로 적었다. `G6-1` 은 코드 없는 `text/plain` 표면에 **코드를 부여**하는 것이고 봉투를 바꾸지 않는다. 단일 봉투 이행(`G6-4`)은 범위 밖이다.
- **`apierr` 등록부 재설계 금지** — sentinel 78개 → `(status, code)` 테이블 3벌, 와이어 코드 단일 소유, 전수성 테스트(`inventory.go`)는 잘 설계된 것으로 판정됐다. **확장**만 한다.
- **문서의 역방향 정합성** — `commands.md`·`api.md`·`shortcuts.md` 에 적힌 내용은 전부 코드에 실재한다(역방향 불일치 0건). 기존 문장을 재검증하지 말고 **누락 방향만** 보강한다.
- **CHANGELOG 규약** — Keep a Changelog + SemVer 와 13개 헤더의 태그·날짜 일치는 양호 판정이다. 형식을 바꾸지 않는다.
- **진단 스냅샷**(`diag_snapshot.go`, 60초 1줄) — "좋은 설계이며 유지" 로 판정됐다. `G2-5` 는 같은 값을 구조체로 노출하는 작업이다.
- **접근 로그 핫패스 필터**(`/api/ping`·`/api/stats` 제외) 유지.
- **성능 회귀 CI 금지**(`G9-3`) — 성능은 여러 축이 양호로 판정했고 지킬 회귀가 관측되지 않았다. `G9-2` 는 예산 **선언**과 측정 하네스까지다.
- **go.mod 경량성** — `log/slog` 는 표준. Prometheus 클라이언트 라이브러리를 추가하지 말고 필요하면 텍스트 포맷을 직접 쓴다.

### 4. Definition of Done

- `log/slog` 전환 + `DONGMINAL_LOG_LEVEL`. `log.Printf` 146곳 감소, 새 코드의 `log.Printf` 를 막는 grep 게이트가 CI 에 있다.
- 요청 ID 미들웨어 — 한 요청의 접근 로그·핸들러 로그·데몬 RPC 로그가 같은 ID(로그 3줄 매칭 테스트).
- `GET /api/diag`(인증 뒤)가 `tools/ws/goroutines/allocMB` + 영속 실패·401/403 수·재연결 수를 JSON 으로 반환.
- 기동 시 `.lastexit` 마커로 마지막 비정상 종료를 판정해 로그·헬스에 남긴다. 프론트에 `window.onerror`·`unhandledrejection` 훅이 있다(현재 0건).
- `grep -rn 'http.Error(w' internal/` 0건(현재 63곳). 모든 오류 응답이 코드를 갖고 `codes.go` 에 등록되며 `inventory.go` 전수성 테스트가 새 코드까지 덮는다.
- `docs/external/errors.md`(또는 `api.md` 절)가 `codes.go` 에서 생성되고 코드 40여 개 전부에 의미·복구 안내가 있다(현재 문서화 7개). 생성물과 코드 목록의 불일치를 CI 가 잡는다.
- 오류 응답 본문에 요청 ID 가 실려 사용자가 그 ID 로 로그를 찾을 수 있다.
- 설정 키·타입·범위·기본값의 단일 원천 + `dongminal config show/validate`. `saveSettings` 의 24키 나열이 서술자 표에서 파생됨을 확인.
- 환경변수 13개 전부 문서화(상수 9 + 흩어진 4: `DONGMINAL_ATTENTION_IDLE_MS`·`_BELL`·`DONGMINAL_CMD_RESULT_TIMEOUT_MS`·`DONGMINAL_URL_OPEN`). `PORT` 비숫자 값이 `net.Listen` 전에 명확한 오류로 거부.
- `dongminal update --check`(옵트인) · `uninstall --dry-run`(홈 15항목 목록 출력) · `backup --out`/`restore <zip>`(소켓·pid·로그 제외 확인).
- `POST /api/workspace/revert` 로 최근 N rev 되돌리기 + UI 진입점.
- 세 대조 스크립트가 CI 에서 **0 불일치**(양방향): `commands.md` ↔ `dmctl.go:36-57`, `api.md` ↔ `gitapi/routes.go:16-88`·`handlers_api.go:91-178`, `shortcuts.md` ↔ `helpers.js` 키 표.
- `docs/internal/decisions.md` 가 SRS 58개의 `D-n` 마커를 제목·근거 1줄·SRS 링크·상태(제안/채택/폐기/대체)로 색인. SRS 템플릿에 상태·결정 요약 절이 강제되고(스크립트 1개) 상태 필드 부재율 94% 가 하락. 상태 값 형식은 기존 7개 SRS 의 표기(`문서 상태: 승인 · **구현 완료** (날짜)` 등)를 enum 으로 수렴시킨다.
- `CONTRIBUTING.md` 에 브랜치·리뷰·커밋 규약·**릴리스 절차**(누가 언제 태그를 미는가, CHANGELOG 를 언제 닫는가).
- `features.md` 에 용량 기준 표(상한 상수 40여 개)와 초과 시 동작(429/413 + 문구). `features.md:364` 의 "PTY 는 서버 메모리에만 존재" 표류를 데몬 모드 사실로 정정.
- `getting-started.md` 에 브라우저·최소 버전·모바일 범위, 선택 의존(`git`·`docker`·`rg`)과 부재 시 동작, `linux/arm64` 미검증 사실.
- 지원·폐기 정책 절.
- 성능 예산·SLO 선언 + 측정 하네스. **성능 회귀 CI 는 만들지 않는다.**
- 릴리스 산출물에 provenance 또는 cosign 서명 + 검증 명령 문서화.
- 프로세스 감독(launchd plist / systemd user unit 생성 명령) — 서버를 강제 종료하면 되살아남 확인.
- **[결정 4 종속]** `G3-6` — 채택 시 Homebrew tap 저장소 + `release.yml` formula 갱신 스텝, `brew install` 동작.

### 5. 선행 결정

**착수를 막는 것 없음.** 결정 4(배포 채널)는 `G3-6` 하나에만 걸리고 그 항목은 tap 저장소 신설 + `release.yml` 스텝으로 독립적이라 **진행 중 확정해도 된다.** 나머지 22개 갭은 결정과 무관하게 착수 가능.

### 6. SRS 필요 여부

**필요(중). 3건.**
1. `docs/internal/OBSERVABILITY_SRS.md` — 로그 레벨·필드·요청 ID·헬스 확장·메트릭 종단·크래시 마커.
2. `docs/internal/ERROR_CONTRACT_SRS.md` — 코드 부여 범위, **4방언 유지 결정의 재확인과 근거**, 오류 ID, 카탈로그 생성 규칙. §5 비목표에 "단일 봉투 이행은 하지 않는다" 명시.
3. `docs/internal/CONFIG_MANAGEMENT_SRS.md` — 설정 키 단일 원천, 우선순위, 검증, `config` CLI.

문서 항목(`DOC-*`·`G8`~`G10`)은 SRS 불필요 — 문서 자체가 산출물이다.

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M5(관측성·에러 규약·설정 관리·문서·릴리스 운영)를 실행한다.
갭 22건 + 발견 8건. 배포된 제품의 문제를 받고 진단하고 되돌리는 운영 표면을 만드는 작업이다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M5" 섹션
- docs/internal/production/07-production-gap.md §2, §3, §4(G4-3·G4-7), §5, §6 전체, §8, §9, §10
- docs/internal/production/06-docs-hygiene.md §1(상태 표기 체계와 기존 7개 SRS 의 형식), §2
- docs/internal/production/04-secops.md §4.5, §4.7
- internal/webserver/apierr/ (잘 설계된 등록부 — 확장 대상. 재설계하지 마라)
- docs/internal/architecture.md:141-176 (오류 방언 4종 공개 계약 — 유지 대상)

먼저 선행(M4) 완료를 킥오프 문서의 확인 명령 7줄로 검증하라. 실패하면 착수하지 말고 보고하라.

성격: 중 규모 다발. SDD 를 따른다 — 다음 세 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤 진행하라:
- docs/internal/OBSERVABILITY_SRS.md
- docs/internal/ERROR_CONTRACT_SRS.md (§5 비목표에 "단일 봉투 이행 안 함" 명시)
- docs/internal/CONFIG_MANAGEMENT_SRS.md
문서 항목(api.md/commands.md/shortcuts.md 누락 보강, CONTRIBUTING, SECURITY 확장,
decisions.md 색인, features.md 용량 표)은 SRS 없이 바로 진행하라.

절대 하지 말 것:
- 오류 본문 방언 4종 통일 (architecture.md:141-176 이 공개 계약으로 "통일하지 않는다"를
  결정으로 적었다. 코드 없는 text/plain 표면에 코드를 부여하는 것이 범위다)
- apierr 등록부 재설계 (sentinel 78개·테이블 3벌·전수성 테스트는 양호 판정. 확장만)
- 기존 문서 문장 재검증 (역방향 불일치는 0건이다. 누락 방향만 보강)
- CHANGELOG 형식 변경
- 진단 스냅샷(diag_snapshot.go) 재설계 — 양호 판정. 같은 값을 구조체로 노출만
- 성능 회귀 CI 만들기 (성능은 양호 판정이고 지킬 회귀가 없다. 예산 선언과 측정 하네스까지)
- go.mod 에 의존 추가 — log/slog 는 표준. Prometheus 클라이언트 라이브러리 금지
- 커밋 메시지에 AI 서명 삽입

진행 중 사용자에게 확인할 것 (착수는 막지 않는다):
  배포 채널 — Homebrew tap 을 추가할지. 권장은 추가(현재 xattr 안내가 필요한 설치 경험의
  근본 해법). 이 결정은 G3-6 하나에만 걸린다.

완료 후 킥오프 문서 M5 의 Definition of Done 을 하나씩 검증해 보고하라.
문서↔코드 대조 스크립트 3종은 실제 실행 출력(0 불일치)을 붙여라.
```

---

## M6 — git 갱신 계층 재설계 + 렌더 파이프라인 + e2e 계통 결함

**목표(한 문장)**: 워크스페이스 재채택이 로컬 레이아웃 변경을 덮는 것을 막고, git 관측·수명 계층의 국소 결함을 고쳐 flaky 8건의 **제품 측 원인**을 제거한 뒤, 서버 감시 비용을 signature 2단 게이트로 되돌리고 마지막에 프론트 거대 모듈을 분리한다.

> **이 마일스톤의 성격이 조사로 바뀌었다.** 1차 감사(`TEST-5`)는 "flaky 아홉 건이 모두 관측 → 전체 재렌더 → DOM 교체라는 동일 기전" 이라 판정했다. `11-git-polling.md §5` 가 9건을 코드로 매핑해 **그 판정이 절반만 맞다**는 것을 확인했다 — 기전이 셋으로 갈리고 다섯은 **관측과 무관**하다. 따라서 이 마일스톤은 "렌더 파이프라인 수정" 이 아니라 **"git 갱신 계층 재설계 + 레이아웃 재채택 보호"** 다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`11-git-polling.md`](./11-git-polling.md) | **전체 필독**(658줄). 특히 §0 관측 구조 지도 · §1 P0 · §2 P1 9건 · §3 상태 보존 표 20행 · §4 감지 정확성 · **§5 flaky 9건 근본 원인 매핑** · §7 아키텍처 대안 평가(D-1~D-4) |
| [`05-test.md`](./05-test.md) | §2 P1 "flaky"(**정정 대상 — `11 §5` 가 우선한다**), §2 P1 "e2e 가 프론트 내부 상태에 결합", §2 P1 "스펙이 납품 묶음 단위", §3.2 e2e 코드 품질, §0.2 실측 |
| [`02-fe-arch.md`](./02-fe-arch.md) | §0 부팅 흐름, P1 "전역 스크립트 93개", P1 "계층 역전", P2 A 거대 모듈 6건, P2 C·D·E |
| [`12-func-ui.md`](./12-func-ui.md) | P1 FUI-04(Run 을 UI 에서 중단할 길 없음), §2 의 FUI-07·09·10·11·14·15·16·18·19·20·21 |
| [`PRODUCTION_ROADMAP.md`](./PRODUCTION_ROADMAP.md) | **§3-A-3 fsnotify 판정** · §1.6 재판정 표 · §5-2 거대 파일 분할 착수 조건 |

프로젝트 파일: `web/js/git/panel-poll.js`(관측 스케줄러), `web/js/core/app-git.js`(observer·SSE), `internal/webserver/hub/gitwatch.go`(서버 감시), `web/js/ui/renderer.js`(`_rSide:609-662`·`render():134-160`), `web/js/core/app-cmd.js:306-330`+`app.js:531-556`(`_onWorkspaceChanged` — 낙관적 레이아웃 보호의 자리), `e2e/fixtures.ts`(`:224-233` 의 근거 없는 주석·`:270-273` 의 우회), `e2e/pane-dom-reconcile.spec.ts`·`git-repaint.spec.ts`, `docs/internal/GIT_PUSH_OBSERVE_SRS.md`(§1.2 개정 대상).

### 2. 선행 완료 확인 — M1 · M4

```bash
cd /Users/dykim/personal/dongminal
grep -q 'golangci-lint' .github/workflows/verify.yml && grep -q 'tsc --noEmit' .github/workflows/verify.yml && echo "M1 gates ok"
grep -q 'node --test' package.json .github/workflows/verify.yml && echo "M1 front unit ok"
grep -rq 'flaky' e2e/parity-reporter.ts && echo "M1 flaky reporting ok"
grep -rqE 'GitWatchTTL' internal/webserver/hub/gitwatch.go && echo "M1 GP-1 완화 확인 대상"   # 값이 폴링 최댓값보다 큰지 눈으로 확인
grep -rq 'HttpOnly' internal/webserver/httpapi/ && echo "M4 auth ok"
grep -rqE 'storageState|auth' e2e/fixtures.ts && echo "M4 e2e fixture adjusted ok"
```

### 3. 범위

**(가) git 갱신 계층 — `11` 전량 18건**

| 구분 | ID | 한 줄 | 규모 |
|---|---|---|---|
| ~~P0(근본)~~ | ~~GP-1~~ | **M1 에서 해소됐다** (2026-09-10). 임대가 SSE 구독으로 옮겨졌다 — `GIT_WATCH_LEASE_SRS` FR-GWL-1~13. 여기서 할 일 없음 | — |
| P1 | GP-2 | 주기 `0` 에서 워치독이 물러나 첫 관측을 놓치면 영구 정지 — flaky **P4** 의 확정 원인 | S |
| P1 | GP-3 | `_gitMissing=false` 가 생성자 한 줄뿐 — git 복구 후에도 자동 갱신이 안 돌아온다 | S |
| P1 | GP-4 | "갱신 실패(낡음)" 표시가 Changes 뷰 골격 안에만 있다 | S/M |
| P1 | GP-5 | `gitFetch` 에 시한이 없어 History `_loading` 잠금이 영구히 남을 수 있다 | S |
| P1 | GP-6 | `_rSide` 가 매 render 마다 사이드를 재생성해 Changes 뷰 DOM 을 이동 — 포커스·선택·진행 중 클릭 소실 | M |
| P1 | GP-7 | 서버 감시가 `signature` 가 아니라 **`git status` 를 1초마다** 돌린다 | M+S |
| P1 | GP-8 | `Tick` 이 순차 관측 — 느린 저장소 하나가 전체 감지를 막는다(`ctx` 도 `Background()`) | S |
| P1 | GP-9 | Branches·Stash 가 `innerHTML=''` 전면 교체 — flaky **B6** 의 자리 | M |
| P1 | GP-10 | `stash list` 가 쓰기로 분류돼 Console 맨 위를 차지 — flaky **K2** 의 확정 원인 | S/M |
| P2 | GP-11(a~g) | 감지되지 않는 변경 7종 | 각 S |
| P2 | GP-12~18 | 숨은 탭이 방송에 반응 · 백오프 무효 · 취소 없음 · status 상한 없음 · 퇴출이 조용함 · 빈 저장소 오표시 · `git am` 을 rebase 로 표시 | S 다수 + M×1 |

**(나) 렌더·레이아웃·테스트·UI**: `TEST-5`·`TEST-6`·`TEST-7`·`FE-3`·`FE-4`(P1) · `FUI-04`(P1) · `FE-9`~`14`·`FE-18`~`28`·`TEST-16`~`21`(P2) · `FUI-07·09·10·11·14·15·16·18·19·20·21`(P2).

**포함 갭**: 없음.

### 4. flaky 9건의 확정 매핑 (`11 §5` — 이 표가 이 마일스톤의 지도다)

| 스펙 | 기전 | 조치 |
|---|---|---|
| `git-console` K2 | **제품 — GP-10.** `stash list` 가 쓰기로 기록되고 `_reloadViews` 가 관측마다 실행 | GP-10 |
| `git-polling` P4 | **제품 — GP-2.** `gitStatusInterval:0` 에서 타이머도 워치독도 없다 | GP-2 |
| `git-history` H14 | **뷰 remount / 요소 제거.** `.git-hist-opts` 는 `mount()` 전용이라 목록 재칠하기로는 detach 되지 않는다 | 낙관적 레이아웃 보호 |
| `git-commit-actions` D1 | **뷰/탭 유실.** `_onWorkspaceChanged` 가 서버 레이아웃을 채택하면 방금 연 git 뷰 탭이 사라진다 | 낙관적 레이아웃 보호 |
| `git-branch-actions` BR11 | 위와 동일 | 〃 |
| `repo-tab` X4 | 위와 동일 + GP-6(`_rSide` 재생성) | 〃 + GP-6 |
| `git-head-mobile` V10-13 | 위와 동일. **`waitForTimeout(800)` 부족은 증상이지 원인이 아니다** | 〃 |
| `git-branches` B6 | **제품.** `_adopt`→`reset()` 이 `_refs=[]` 로 비우고 `if(!this._repo) return` 이면 다시 받지 않는다. 이후 `_obsSig` 가드로 `paintAll` 도 안 온다 | GP-9 + `_adopt` 재조회 |
| `git-history` H15 | **미확정.** 뷰 유실 가족이거나 GP-5(무응답 fetch 잠금). 트레이스의 `/api/git/log` 요청 유무로 갈린다 | 트레이스 확인 후 귀속 |

**핵심**: 9건 중 **8건이 제품 결함**이다. `fixtures.ts:224-233` 의 "재렌더는 앱의 정상 동작이므로 견디는 쪽은 테스트다" 는 **근거가 없다** — git 관측은 `render()` 를 부르지 않는다(`app-git.js:610`). **`TEST-5` 의 조치 (2)("`reconcileList`/탭 바가 노드를 교체하지 않게")는 아홉 중 최대 1건에만 닿는다.**

### 5. 내부 순서 (지켜라)

1. **낙관적 레이아웃 보호** — `_onWorkspaceChanged` 가 아직 저장되지 않은 로컬 레이아웃 변경을 덮지 않게(탭 추가는 로컬 우선, 서버 스냅샷과 병합). `app.js:531-556` 이 rev 비교로 절반을 하고 있다. **flaky 5~6건이 여기서 닫힌다.**
2. **관측 국소 수정** — GP-2 · GP-9+`_adopt` 재조회 · GP-10. 남은 flaky 2건.
3. **`flaky > 0` 을 CI 실패로 승격.** 1·2 보다 먼저 하면 CI 가 계속 빨갛다.
4. **갱신 수명·표시** — GP-1(근본) · GP-3 · GP-4 · GP-5 · GP-6.
5. **서버 감지 2단화** — GP-7(`ReadSignature` 1초 게이트 + status 저빈도) · GP-8(병렬화 + 회차 시한). **1~4 이후에만** — `11 D-4` 가 "순서가 요점" 이라 못박았다.
6. **감지 구멍·나머지 P2** — GP-11a~g · GP-12~18.
7. **테스트 계약·재조직** — TEST-6(`app.testing`) · TEST-7 · TEST-16~21.
8. **모듈 분리** — FE-3·FE-4·FE-9~13. 로드맵 §5-2 착수 조건 충족 후.

### 6. 건드리지 말 것

- **fsnotify 를 도입하지 마라.** 로드맵 §3-A-3 이 근거 다섯으로 기각했다 — ① 감지를 고쳐도 18건 중 12건이 남는다 ② fsnotify 가 여는 구멍은 stat 3~4회로 메울 수 있다 ③ 이 저장소는 "Windows 러너에서 `git branch` 뒤 45초 동안 `refs/heads` mtime 이 그대로였다" 는 실측을 갖고 있다(FR-CEM-32) ④ 작업 트리까지 감시하면 `.gitignore` 를 재구현해야 한다 ⑤ `go.mod` 직접 의존 2개 제약. **필요한 것은 파일 감시가 아니라 서버가 원래 쓰기로 했던 `signature` 를 1차 게이트로 되세우는 것이다.**
- **낙관적 업데이트를 도입하지 마라.** `11 §6` 이 "없다. 그리고 그것이 옳다" 로 판정했다 — 모든 쓰기가 `panel-write.js:155-167` 의 `post()` 한 곳을 지나 응답에 실린 실행 후 status 를 `adopt(d)` 로 채택한다. 되돌림 로직이 필요 없는 구조다.
- **장시간 작업(jobs) 설계 변경 금지** — 잡 id·SSE·`Cancel`·`WithCeiling`·프로세스 그룹 종료가 양호 판정(`11 §6`).
- **e2e 스펙 재작성 금지** — 전량 `unexpected 0`. 재조직·계약 이관·대기 제거만 하고 단정은 유지.
- **fixtures 층 재설계 금지** — 응집도 양호. 단 `fixtures.ts:224-233` 의 **근거 없는 주석은 정정하고** `:270-273` 의 우회는 1단계가 닫으면 제거한다.
- **TimerHub 폴링 구조·`check-timers.sh` 게이트 유지.**
- **성능 최적화 금지** — History 윈도잉·Diff·Console 제한·탐색기 폴더 단위 로드는 양호. `render()` 합치기는 flaky 원인 제거이지 성능 작업이 아니다.
- **모듈 분리는 기계적 이동만** — 동작 변경 0, 이동 전후 대응표.
- **상태 보존 표(`11 §3`)의 "보존" 20행 중 13행을 깨지 마라** — 스크롤·선택·펼침·검색어·`_shown`·Diff dirty 는 패널 필드에 살아 이미 보존된다. 소실되는 것(포커스·글자 선택·hover·메뉴 앵커·탭 자체)만 대상이다.

### 7. Definition of Done

- `parity-reporter.ts` 가 `flaky > 0` 을 잡 실패로 승격한 상태에서 전량 **3회 연속 flaky 0 · unexpected 0**.
- **§4 표의 8건이 각각 닫혔음**을 그 스펙의 반복 실행으로 확인. H15 는 `playwright-report/data/*.zip` 을 `npx playwright show-trace` 로 열어 `/api/git/log` 요청 유무를 보고 귀속시킨다.
- **낙관적 레이아웃 보호**: 브라우저 A 에서 git 뷰 탭을 연 직후 B 가 워크스페이스를 바꿔도 A 의 탭이 사라지지 않는다(e2e). `fixtures.ts:270-273` 의 우회 주석 제거.
- ~~**GP-1 근본**~~ — M1 에서 완료. `GIT_WATCH_LEASE_SRS` §4 의 TC-GWL-1~13 이 이 확인을 대신한다.
- `gitStatusInterval:0` 에서 저장소를 열면 1회 수집이 일어난다(`_lastObsAt===null` 이면 주기 무관 수집).
- git 을 없앴다 복구하고 새로고침으로 성공하면 자동 갱신이 돌아온다.
- 낡음 배너가 **모든 git 탭**에서 보인다(History 탭을 연 채 서버를 죽이면 30초 안에).
- `gitFetch`/`gitPost` 에 `AbortSignal.timeout` 기본 부착 — 무응답 연결에서 History `_loading` 잠금이 풀린다.
- `_rSide` 가 `_keep` 으로 재사용된다 — 커밋 메시지 입력 중 다른 창에서 워크스페이스를 바꿔도 **커서가 유지된다**.
- Branches·Stash 가 `reconcileList` 를 쓰고 `git-repaint.spec.ts` 에 P14·P15 가 추가된다.
- `IsWriteCommand` 가 (동사, 하위명령) 쌍 판정 — 파일 하나를 stage 한 뒤 Console 맨 위가 `git add` 다.
- **서버 감시 비용**: 변화 없는 저장소를 연 채 1분간 `git status` 프로세스 수를 센다 — 60회에서 저빈도 회차분으로 감소. `GIT_PUSH_OBSERVE_SRS §1.2` 비용표 개정.
- `Tick` 이 세마포어로 병렬화되고 회차당 `context.WithTimeout` 을 갖는다(**`GO-33` 이 같은 줄** — M8 에서는 확인만).
- signature 가 `.git/config` 를 본다(터미널 `git remote add` 후 원격 목록 갱신). `obsMark` 에 `Operation.Kind` 가 실린다.
- 빈 저장소에서 History 가 "커밋이 아직 없습니다" 를 보인다. `git am` 중에 `am` 출구 버튼이 나온다.
- 스펙의 `app._xxx` grep 0건 + 위반 검출 게이트. 배치/리비전 스펙 8파일 소멸(단정 총수 유지). `waitForTimeout` 224회 → 예외 목록만.
- Runs 행에 `종료`(`POST /api/runs/close`)와 대시보드 `분리`(detach)가 있다 — 진행 중 Run 을 기록을 잃지 않고 멈출 수 있다(`FUI-04`).
- 로드 순서 검사기 또는 eslint `no-undef` 게이트 위반 0. 500줄 초과 프론트 파일 축소.
- **보존 확인**: `check-timers.sh` 통과, `11 §6` 양호 판정(낙관적 업데이트 부재·jobs 설계) 불변.

### 8. 선행 결정

**없음.**

### 9. SRS 필요 여부

**필요(대). 4건.**
1. `docs/internal/GIT_OBSERVE_LIFECYCLE_SRS.md` — 관심 표명의 계기, **폴링 주기와 푸시 수명의 분리**, 워치독·백오프·첫 관측 규칙, 낡음 표시의 자리. `GIT_PUSH_OBSERVE_SRS` FR-GPO-11 과 `POLL_INTERVAL_SETTINGS_SRS` FR-PIS-9 의 **충돌을 해소**하는 것이 이 문서의 목적이다(`11 §1` 제안 (c)).
2. `docs/internal/GIT_DETECTION_SRS.md` — 2단 게이트 설계, signature 가 보는 것과 보지 않는 것의 목록, `obsMark` 구성. **`GIT_PUSH_OBSERVE_SRS §1.2` 개정**(비용 논거가 무효임을 기록하고 fsnotify 기각 근거를 갱신).
3. `docs/internal/RENDER_RECONCILE_SRS.md` — reconcile 대상·노드 교체 금지 범위·합치기·**낙관적 레이아웃 보호**.
4. `docs/internal/TEST_PUBLIC_CONTRACT_SRS.md` — `app.testing` 표면과 안정성 약속.

### 10. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M6(git 갱신 계층 재설계 + 렌더 파이프라인 + e2e 계통 결함)을 실행한다.

핵심 사실 (1차 감사 판정이 정정됐다):
e2e flaky 9건이 "모두 관측 → 전체 재렌더 → DOM 교체라는 동일 기전" 이라던 1차 판정은
절반만 맞다. 코드로 매핑한 결과 기전이 셋으로 갈리고 다섯은 관측과 무관하다:
  ① 뷰/탭 유실 (5건) — _onWorkspaceChanged 가 서버 레이아웃을 채택하면 방금 연 탭이 사라진다
  ② 관측 파생 상태 초기화 (1건) — branches _adopt/reset 이 비우고 재조회 없이 나간다
  ③ 관측이 만드는 부수 요청(1건) · 관측 자체가 서지 않음(1건)
9건 중 8건이 제품 결함이고 H15 만 미확정이다. fixtures.ts:224-233 의
"견디는 쪽은 테스트다" 는 근거가 없다 — git 관측은 render() 를 부르지 않는다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M6" 섹션
- docs/internal/production/11-git-polling.md **전체**(658줄) — 특히 §5 flaky 매핑, §7 D-1~D-4
- docs/internal/production/PRODUCTION_ROADMAP.md §3-A-3(fsnotify 판정), §1.6
- docs/internal/production/05-test.md §2(flaky 부분은 11 §5 가 우선한다)
- docs/internal/production/02-fe-arch.md, 12-func-ui.md 의 FUI-04 와 §2
- docs/internal/GIT_PUSH_OBSERVE_SRS.md §1.2 (비용 논거가 무효 — 개정 대상)

먼저 선행(M1·M4) 완료를 킥오프 문서의 확인 명령으로 검증하라.

성격: 대 규모. SDD 를 따른다 — 네 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤 진행하라
(GIT_OBSERVE_LIFECYCLE / GIT_DETECTION / RENDER_RECONCILE / TEST_PUBLIC_CONTRACT).

내부 순서를 반드시 지켜라 (11 D-4 가 "순서가 요점" 이라 못박았다):
1) 낙관적 레이아웃 보호 — flaky 5~6건이 여기서 닫힌다
2) 관측 국소 수정 (GP-2 · GP-9+_adopt 재조회 · GP-10) — 남은 flaky 2건
3) flaky > 0 을 CI 실패로 승격 (1·2 보다 먼저 하면 CI 가 계속 빨갛다)
4) 갱신 수명·표시 (GP-1 근본 · GP-3 · GP-4 · GP-5 · GP-6)
5) 서버 감지 2단화 (GP-7 ReadSignature 1초 게이트 + status 저빈도 · GP-8 병렬화)
6) 감지 구멍·나머지 P2 (GP-11a~g · GP-12~18)
7) 테스트 계약·재조직 8) 모듈 분리

절대 하지 말 것:
- fsnotify 도입 (기각 근거 다섯은 로드맵 §3-A-3. 필요한 것은 파일 감시가 아니라
  서버가 원래 쓰기로 했던 signature 를 1차 게이트로 되세우는 것이다)
- 낙관적 업데이트 도입 (현재 "없다. 그리고 그것이 옳다" 로 판정됐다 — 모든 쓰기가
  post() 한 곳을 지나 실행 후 status 를 채택한다)
- jobs(장시간 작업) 취소·진행 설계 변경 — 양호 판정
- e2e 스펙 재작성 (전량 unexpected 0. 재조직·계약 이관·대기 제거만)
- fixtures 층 재설계 (단 :224-233 의 근거 없는 주석은 정정하라)
- TimerHub 구조 변경, check-timers.sh 우회
- 성능 최적화 (render() 합치기는 flaky 원인 제거이지 성능 작업이 아니다)
- 상태 보존 표(11 §3)에서 이미 "보존" 인 13행을 깨뜨리는 변경
- go.mod / package.json 에 의존 추가
- 커밋 메시지에 AI 서명 삽입

완료 후 킥오프 M6 의 Definition of Done 을 검증해 보고하라.
flaky 0 은 승격 상태에서 전량 3회 연속 실행 결과로, 서버 감시 비용은
"변화 없는 저장소 1분간 git status 프로세스 수" 실측으로 증명하라.
```

---

## M7 — 접근성·디자인 시스템·UX 안전

**목표(한 문장)**: 선언된 접근성 기준을 만족시키고, 테마·토큰·모달 골격의 분기를 하나로 수렴하며, 되돌릴 수 없는 UX 경로에 안전장치를 둔다.

**분할 사실**: 확정 결정 3(i18n 도입)에 따라 문구·언어 항목(`UX-9`·`UX-11`·`UX-20`·`UX-21` + `G7-2`·`G7-3`·`G7-4`)은 이 마일스톤이 아니라 **M9(국제화)** 로 갔다. 이 마일스톤은 문자열이 아니라 **컨테이너·토큰·상호작용**을 다룬다 — 그리고 M9 가 문구를 놓을 자리를 확정하는 것이 이 마일스톤의 부수 목표다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`03-uiux.md`](./03-uiux.md) | §1 P1 8건 전체, §2.1 접근성 P2, §2.2 디자인 시스템 P2, §2.4 인터랙션 P2, §3 항목별 점검(3.1 접근성·3.2 디자인 시스템·3.3 반응형), **§4 잘 되어 있는 것 7건(보존 대상)**, §5 권장 착수 순서 |
| [`07-production-gap.md`](./07-production-gap.md) | §7 접근성·i18n 의 `G7-1` |

프로젝트 파일: `web/js/core/helpers.js:198-217`(`applyThemeObj` — 파생 토큰을 넣을 자리), `web/style-kit.css`(토큰 원본과 D-5 과도기 선언), `web/style.css:11-40`(`:root`), `web/js/ui/sidebar-list.js:97`·`ui/renderer.js:894`·`ui/file-tree-paint.js:597`(세 팩토리), `web/js/ui/ui-kit.js`(`:72,82` 이름 강제 · `:139-189` modal · `:199-255` menu), `web/js/git/confirm.js`(모범 규약), `web/index.html:212-235`(설정 모달), `web/js/ui/themes.js`(44개 테마, `mode:'dark'|'light'`).

### 2. 선행 완료 확인 — M6

```bash
cd /Users/dykim/personal/dongminal
grep -rq 'testing' e2e/fixtures.ts && [ "$(grep -rn 'app\._' e2e/ | wc -l | tr -d ' ')" = "0" ] && echo "public contract ok"
grep -rq 'flaky' e2e/parity-reporter.ts && grep -rqE 'flaky.*(fail|exit)' e2e/parity-reporter.ts && echo "flaky gate promoted ok"
ls e2e/ux-batch*.spec.ts 2>/dev/null | wc -l    # 0 이어야 함(스펙 재조직 완료)
grep -rq 'requestRender\|coalesce' web/js/ui/renderer.js && echo "render coalesce ok"
grep -rqE 'data-testid' web/js/ && echo "testid ok"
```
공개 계약 0건 · flaky 게이트 승격 · 배치 스펙 0개 · render 합치기 · `data-testid` 도입이면 M6 완료.

### 3. 범위

**포함 발견 (P1 7건)**: `UX-5`(미정의 토큰 `--bg-alt` 를 4곳이 참조) · `UX-7`(모바일 터치 타겟 44px 미달) · `UX-3`(설정 모달에 다이얼로그 시맨틱·포커스 관리 없음) · `UX-6`(보조 텍스트 대비 미달, `--text-dim` 1.91:1) · `UX-8`(라이브 리전 0개·알림 채널 4종 분산) · `UX-2`(창 `×` 가 확인 없이 세션 kill) · `UX-4`(목록·탭·카드가 전부 `div` — Tab 순회·스크린리더 불가).

**포함 발견 (P2 14건)**: `UX-10`(검색 입력 라벨) · `UX-12`(`prefers-reduced-motion` 일부만) · `UX-13`(포커스 표시) · `UX-14`(위험색·상태색 하드코딩) · `UX-15`(라이트 테마 구분선) · `UX-22`(단축키 발견 가능성) · `UX-23`(드래그 어포던스) · `UX-24`(탭 줄 오버플로) · `UX-17`(버튼 외형 6벌) · `UX-18`(글자 크기 12종) · `UX-19`(시스템 다크/라이트 추종) · `UX-25`(파일 삭제 영구) · `UX-26`(컨텍스트 메뉴 두 벌) · `UX-16`(모달 골격 7벌·z-index 28종).

**추가 포함 — `12` 에서 온 P2 8건**: `FUI-08`(탭 컨텍스트 메뉴 없음) · `FUI-12`(탐색기 빈 여백 우클릭 무반응) · `FUI-17`(터미널 본문 컨텍스트 메뉴 없음 — 원격 http 에서 `navigator.clipboard` 가 없으면 복사·붙여넣기의 유일한 마우스 경로다) · `FUI-26`(`UIKit.menu` 가 비활성 사유를 안 보임, `GitMenu` 는 `title=why` — `UX-26` 통합과 같은 작업) · `FUI-13`(탐색기 키보드 조작 없음, 본체는 `UX-4`) · `FUI-22`(알림 센터 개별 해제 없음) · `FUI-25`(프리셋 삭제 확인 없음 + 로드 실패가 unhandled rejection) · `FUI-27`(모바일에서 Runs·Agents 에 닿는 길 없음 — 둘 다 `desktop-only` 이고 대체 진입점이 단축키뿐인데 모바일에는 물리 키가 없다).

**포함 갭**: `G7-1`(접근성 목표 미선언 + 자동 검사 0).

**순서 제약 (이 마일스톤에 걸리는 것)**
- **M6 이 선행이다.** DOM 노드를 교체하는 렌더 파이프라인 위에서는 `tabindex`·`role`·포커스 상태가 갱신마다 소실되어 키보드 순회 e2e 가 통과할 수 없다. `UX-4` 의 조치가 "세 팩토리에 한 번씩만 넣는다" 를 전제하는데 그 전제는 M6 의 reconcile 규약이 성립한 뒤에 유효하다.
- **이 마일스톤이 M9(i18n)의 선행이다.** `G7-3` 은 `index.html` 정적 문구를 렌더 경로로 이관하는데, 문구가 놓이는 컨테이너의 시맨틱(`UX-3` 모달 `aria-labelledby`·`UX-8` 라이브 리전)과 골격(`UX-16` 모달 7벌 수렴)이 여기서 확정되지 않으면 이관한 문구를 다시 옮겨야 한다.

**건드리지 말 것 — `03 §4` 양호 판정 7건**
1. **파괴적 git 확인창 설계**(`web/js/git/confirm.js` 전체) — 정책 서버 소유, 취소 기본, `Enter`≠실행, 영향 목록+복구 힌트+stderr 복사. **모범 사례**다.
2. **`UIKit.button` 이 이름 없는 아이콘 버튼을 만들지 못하게 throw 하는 것**(`ui-kit.js:72`) — 이 강제를 풀지 않는다.
3. **아이콘 스프라이트 `currentColor` 로 44개 테마 자동 대응**(`index.html:37-82`, `style-kit.css:40-44`).
4. **부팅 화면의 FOUC 제거와 reduced-motion 대체**(`index.html:24-34`, `style.css:1289-1295`).
5. **닫기 전 dirty·busy 이중 가드와 "실행 중인 것만 백그라운드로" 선택지**(`app-layout.js:188-206`).
6. **모바일 소프트 키보드 보정**(`index.html:5-8`, `app-mobile.js:342-424`) — 실측 기반 주석이 붙어 있다.
7. **힛 영역 하한을 두 목록에 같게 맞춘 결정**(`style.css:77-80`).

그 밖에:
- **성능 체감 관련 구조 변경 금지** — History 윈도잉·Diff·Console 제한·탐색기 폴더 단위 로드는 양호 판정(`03 §3.7`: 성능 관련 P1/P2 발견 없음).
- **e2e 가 짚는 CSS 클래스명 유지** — 버튼 외형을 `.ui-btn` 상속으로 비울 때 클래스명은 남긴다(`.tbtn{}` 빈 규칙).
- **문구·언어 변경 금지** — 한국어/영어 혼용 해소, `lang` 속성, CSS `content` 문구, 툴팁 문구는 **M9 범위**다. 이 마일스톤에서 문자열 값을 바꾸지 마라(단 `UX-10` 검색 입력 `aria-label` 처럼 접근성 속성에 필요한 새 문자열은 넣는다 — M9 가 키화한다).
- **테마 팔레트 값 변경 금지** — `UX-6` 조치는 팔레트를 건드리지 않고 **용도별 파생 토큰**(`--text-hint` 등)을 `applyThemeObj` 에서 계산하는 것이다.

### 4. Definition of Done

> 앞 두 항목의 판정 기준(규칙셋·범위)은 **결정 2 확정 전에는 정의되지 않는다.** 나머지는 결정과 무관하게 검증 가능하다.

- 접근성 목표가 문서로 선언되고 `@axe-core/playwright` 스모크 3~5스펙이 설정 모달·사이드바·git 확인창에서 위반 0. **xterm 캔버스는 명시적 범위 밖.**
- 키보드 순회 e2e: Tab 만으로 창 목록·분할 칸 탭·탐색기 행에 도달하고 Enter/Space 활성화·화살표 이동. 단축키 없이 파일을 열 수 있다.
- `tabindex`/`role` 이 세 팩토리(`sidebar-list.js:97`·`renderer.js:894`·`file-tree-paint.js:597`)에서 부여되고, 아이콘 `×` 가 `span` → `UIKit.button({icon,title})`.
- 44개 테마 전부에 대해 `--text-hint`·`--text-muted`·버튼 기본 글자 대비를 계산하는 스크립트가 CI 게이트로 존재하고 전부 ≥ 4.5:1. `--text` 8.10:1·`--accent` 6.79:1·`--attn` 8.55:1 양호 판정 유지.
- CSS 의 미정의 커스텀 프로퍼티 참조가 grep 게이트로 0(`--bg-alt` 해소).
- 위험색·상태색·구분선 토큰화 → Dracula·Gruvbox·라이트 11종에서 위험 버튼 틴트와 글자색 계열 일치 확인.
- `role="dialog" aria-modal="true" aria-labelledby` 가 설정 모달·`UIKit.modal` 에 있고, 열 때 포커스가 모달 안으로 들어가고 닫을 때 원래 자리로 복귀, Tab 트랩. `.mtab` 에 `role="tablist"/"tab"`. 중첩 모달의 `Escape` 닫힘 순서를 테스트로 고정.
- `aria-live` 리전 존재 + `Toast` 가 `.git-undo-toast`·`.sbx-progress` 를 흡수. 업로드 성공/실패·재연결·Undo 기회가 스크린리더로 읽힘.
- 모바일에서 `.pn-tab-x`·`.sbl-x`·`.mkb-btn`·`.mtbtn`·`.ed-row`·`.git-repo-xslot` 히트 박스 44px 이상.
- 전역 `prefers-reduced-motion` 규칙 1줄 + 덮이지 않던 6곳 해소.
- 창 삭제에 Undo 토스트(5초, kill 지연) 또는 상시 확인 — e2e 가 "× 클릭 후 5초 안에 되돌리면 세션이 산다" 를 단정. 파일 삭제에 복구 힌트.
- z-index 가 토큰 4~5개로 수렴. 모달 골격 7벌이 `.ui-modal` 위로 수렴, 백드롭이 `--backdrop` 토큰.
- 버튼 외형 6벌이 `.ui-btn` 상속으로 비워지고 클래스명은 유지. 글자 크기가 `--fs-xs..--fs-xl` 다섯으로 수렴, 본문 10px → 11px.
- `GitMenu` 가 `UIKit.menu` 의 얇은 어댑터가 되어 두 메뉴의 키 이동 동작 동일.
- 시스템 다크/라이트 추종 옵션 + 두 테마 맵 캐시로 첫 페인트 깜빡임 0.
- 탭·탐색기 빈 여백·터미널 본문에 컨텍스트 메뉴가 있고, `UIKit.menu` 가 `GitMenu` 와 같은 키 이동·비활성 사유 표시를 갖는다(`UX-26` 통합의 결과).
- 알림 센터 항목에 개별 해제(`×`)가 있다. 프리셋 삭제가 인라인 확인을 지나고 로드 실패가 `_notify` 로 보인다.
- 모바일 드로어에 Runs·Agents 진입점이 있다.
- **보존 확인**: `03 §4` 양호 7건 관련 e2e 통과, 전량 e2e `unexpected 0`·`flaky 0` 유지(M6 의 승격 상태에서), `12 §5` 양호 판정(탐색기 낙관적 반영·업로드 4지선다·편집기 문서 공유 모델·이진 probe 분기) 불변.

### 5. 선행 결정

**결정 2(접근성 목표 기준) 확정이 필요하다. 확정 없이 착수하지 마라.**
- 선택지: (a) WCAG 2.1 AA 를 목표로 선언, xterm 캔버스는 명시적 범위 밖 · (b) AA 를 핵심 화면에만 · (c) 기준 선언 없이 개별 결함만.
- 권장: **(a).** `G7-1` 이 지적하는 실질 문제는 결함 목록이 아니라 **완료 조건의 부재**다 — 기준이 없으면 `UX-4`(L)·`UX-6`(M) 을 "어디까지 하면 끝인가" 로 판정할 수 없다.
- 이 마일스톤이 바뀌는 지점: (c) 면 `G7-1` 이 빠지고 axe 스모크·대비 계산 스크립트가 DoD 에서 사라져 **마일스톤 완료 판정이 불가능**해진다.

### 6. SRS 필요 여부

**필요(중·대). 2건.**
1. `docs/internal/ACCESSIBILITY_SRS.md` — 목표 기준, 범위와 제외(xterm 캔버스), 검사 방법(axe 스모크·키보드 순회 e2e), **완료 조건**. `G7-1` 이 지적한 "UX-P1 조치의 완료 조건이 없다" 를 해소하는 것이 이 문서의 목적이다.
2. `docs/internal/DESIGN_TOKENS_SRS.md` — 색·크기·z-index·글자 토큰 목록, 파생 규칙(`applyThemeObj` 계산), 하드코딩 금지 게이트, **과도기 클래스의 종료 조건**(`style-kit.css` 머리말의 D-5 가 "기존 클래스를 지우지 않는다" 를 종료 조건 없이 열어 뒀다).

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M7(접근성·디자인 시스템·UX 안전)을 실행한다.
P1 7건 + P2 14건 + 갭 1건. 마우스·단축키 사용자에게는 잘 다듬어져 있지만 키보드 Tab
순회와 스크린리더 기준으로는 대부분의 목록·탭·카드가 div 이고 포커스 불가하며 라이브
리전이 0개다.

이 마일스톤은 문자열이 아니라 컨테이너·토큰·상호작용을 다룬다. 한국어/영어 혼용,
lang 속성, CSS content 문구, 툴팁 문구는 다음 마일스톤(M9 국제화)의 범위다 —
사용자가 i18n 도입을 확정했고, 문구 외부화 패스에서 값을 확정하는 것이 싸기 때문이다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M7" 섹션
- docs/internal/production/03-uiux.md §1 전체, §2.1·2.2·2.4, §3.1~3.3, §4(보존 대상 7건), §5
- docs/internal/production/07-production-gap.md §7 의 G7-1
- docs/internal/production/12-func-ui.md 의 FUI-08·12·13·17·22·25·26·27
- web/js/core/helpers.js:198-217 (applyThemeObj — 파생 토큰을 넣을 자리)
- web/style-kit.css (토큰 원본과 D-5 과도기 선언)

먼저 선행(M6) 완료를 킥오프 문서의 확인 명령으로 검증하라. 실패하면 착수하지 말고 보고하라.
(렌더 파이프라인이 DOM 노드를 교체하는 동안에는 role/tabindex/포커스가 갱신마다 소실된다)

착수 전 사용자에게 확인할 것 (확정 없이 진행하지 마라):
  접근성 목표 기준 — WCAG 2.1 AA 를 목표로 선언할지(xterm 캔버스는 범위 밖).
  권장은 AA 선언. 기준이 없으면 이 마일스톤의 완료 조건 자체가 정의되지 않는다.

성격: 중·대 규모. SDD 를 따른다 — 다음 두 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤 진행하라:
- docs/internal/ACCESSIBILITY_SRS.md (목표·범위·검사 방법·완료 조건)
- docs/internal/DESIGN_TOKENS_SRS.md (토큰 목록·파생 규칙·하드코딩 금지 게이트·
  과도기 클래스의 종료 조건)

내부 순서는 03-uiux.md §5 권장 착수 순서를 따르라
(S 묶음 → 모달 시맨틱 → 파생 토큰 → 창 삭제 Undo → 팩토리 role/tabindex → 모바일·오버플로).

절대 하지 말 것 (03-uiux.md §4 가 양호로 판정한 7건):
- web/js/git/confirm.js 의 파괴적 확인창 설계 변경 (모범 사례)
- UIKit.button 의 이름 없는 아이콘 버튼 throw 해제 (ui-kit.js:72)
- 아이콘 스프라이트 currentColor 방식 변경
- 부팅 화면 FOUC 제거·reduced-motion 대체 변경
- 닫기 전 dirty·busy 이중 가드 변경
- 모바일 소프트 키보드 보정 변경 (실측 기반이다)
- 힛 영역 하한 결정 변경
그리고:
- 테마 팔레트 값 변경 금지 (UX-6 은 팔레트를 건드리지 않고 용도별 파생 토큰을
  applyThemeObj 에서 계산하는 작업이다)
- 문구·언어 변경 금지 (M9 범위. 단 접근성 속성에 필요한 새 문자열은 넣어라)
- e2e 가 짚는 CSS 클래스명 삭제 금지 (선언만 .ui-btn 상속으로 비우고 클래스는 남긴다)
- 성능 관련 구조 변경 (양호 판정)
- 커밋 메시지에 AI 서명 삽입

완료 후 킥오프 문서 M7 의 Definition of Done 을 하나씩 검증해 보고하라.
44개 테마 대비 계산은 스크립트 실행 출력을 붙여라.
```

---

## M9 — 국제화(i18n)

**목표(한 문장)**: 확정 결정 3(i18n 체계 도입)을 이행한다 — 문자열을 카탈로그로 외부화하고, 그 위에서 언어 정책과 문구를 확정한다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`07-production-gap.md`](./07-production-gap.md) | §7 접근성·i18n 전체(현재 상태의 문자열 분포 실측 · 프로덕션 기준선 · `G7-2`·`G7-3`·`G7-4`) |
| [`03-uiux.md`](./03-uiux.md) | §2.1 의 `UX-9`(`lang="en"`)·`UX-11`(CSS `content` 문구), §2.3 의 `UX-20`(한국어·영어 혼용, 자리 목록 포함)·`UX-21`(툴팁 단축키 정적) |
| [`PRODUCTION_ROADMAP.md`](./PRODUCTION_ROADMAP.md) | **§3-A-1 "왜 외부화를 문구 확정보다 뒤에 두는가"** — 이 마일스톤의 설계 근거 |
| [`06-docs-hygiene.md`](./06-docs-hygiene.md) | (참고) 문서 언어 현황 |

프로젝트 파일: `web/js/core/constants.js`·`constants-git.js`(1282줄)·`constants-git-actions.js`·`constants-editor.js`·`constants-docrender.js`(5파일 2,737줄 — 키화 대상), `web/index.html`(정적 문구 178줄), `web/js/ui/themes.js`, `internal/webserver/httpapi/`(한국어 `http.Error` 6곳 — M5 가 코드화한 뒤 잔여).

### 2. 선행 완료 확인 — M7 · M6 · M5

```bash
cd /Users/dykim/personal/dongminal
# M7
test -f docs/internal/ACCESSIBILITY_SRS.md && test -f docs/internal/DESIGN_TOKENS_SRS.md && echo "M7 srs ok"
grep -rq 'aria-live' web/ && echo "M7 live region ok"
grep -rq 'role="dialog"' web/ && echo "M7 dialog semantics ok"
# M6
[ "$(grep -rn 'app\._' e2e/ | wc -l | tr -d ' ')" = "0" ] && echo "M6 contract ok"
grep -rq 'no-undef' .eslintrc* eslint.config.* 2>/dev/null && echo "M6 load order gate ok"
# M5
[ "$(grep -rn 'http.Error(w' internal/ | wc -l | tr -d ' ')" = "0" ] && echo "M5 error codes ok"
```
여섯 줄 모두 ok 면 선행 완료.

### 3. 범위

**확정 전제(결정 3)**: 제품 언어 정책은 **i18n 체계 도입**이다. 한국어 단일 선언이 아니다. 감사 리포트의 권장안은 "한국어 단일 + 고유명사만 영어" 였으나 사용자가 다르게 결정했다 — 따라서 `G7-3`(문자열 외부화, L)이 범위에 포함된다.

**포함 갭 (3건)**: `G7-3`(문자열 외부화·i18n 체계 — JS 241줄/77파일 + `index.html` 178줄 + Go) · `G7-2`(제품 언어 정책 선언) · `G7-4`(서버 한국어 문구 6곳 코드화).

**포함 발견 (P2 4건)**: `UX-20`(한국어·영어 혼용) · `UX-9`(`<html lang="en">`) · `UX-11`(CSS `content` 문구 — **i18n 불가**) · `UX-21`(툴팁 단축키 정적).

**순서 제약 (이 마일스톤에 걸리는 것)**
- **M7 이 선행이다.** `G7-3` 은 `index.html` 정적 문구를 렌더 경로로 이관하는데, 문구가 놓이는 컨테이너의 시맨틱(`UX-3` 모달 `aria-labelledby`·`UX-8` 라이브 리전)과 골격(`UX-16` 모달 7벌 → `.ui-modal`)이 M7 에서 확정되지 않으면 이관한 문구를 다시 옮겨야 한다.
- **M6 이 선행이다.** `index.html` 의 클래식 `<script>` 93개는 로드 순서가 곧 의존 순서이고 검사기가 없으면 파일을 옮길 때 `ReferenceError` 가 런타임에만·해당 경로가 실행될 때만 나타난다. M6 의 로드 순서 검사기가 이 작업의 안전망이다.
- **M5 가 선행이다.** `G7-4`(서버 한국어 6곳)는 M5 의 `G6-1`(`http.Error` 63곳 코드화)과 **같은 호출부**다. M5 없이 하면 두 번 연다(코드 부여 → 한국어 제거). 프로덕션 기준선은 "서버 오류 문구는 코드로, 문장은 프론트가" 다.
- **외부화가 문구 확정보다 앞이다(마일스톤 내부 순서).** `UX-20` 을 별도로 먼저 하면 `constants*.js` 5파일 2,737줄 + `index.html` 178줄 + JS 77파일 241줄을 **두 번 훑는다** — 한 번은 값을 한국어로 고치려고, 한 번은 키로 바꾸려고. 외부화 패스가 모든 리터럴을 훑으므로 그 자리에서 ko 값을 확정한다.
- **`UX-11` 이 외부화의 전제다.** CSS `content` 로만 전달되는 문구는 i18n 이 불가능하다. DOM 텍스트로 먼저 옮긴다.

**건드리지 말 것**
- **문서·릴리스 노트·CHANGELOG 의 언어** — 전부 한국어이고 이 마일스톤의 범위가 아니다. UI 문자열만 다룬다.
- **CLI 출력의 번역 범위는 정책으로 정한다.** `migrate.go` 등 CLI 출력 전부가 한국어 자유 문장이다. 번역하든 범위 밖으로 선언하든 **정책 문서에 근거와 함께 기록**한다 — 조용히 어느 쪽으로도 가지 마라.
- **`package.json` 에 i18n 라이브러리 추가 금지** — 프론트에 빌드 도구가 없다. 카탈로그는 자체 모듈(순수 JS 객체 + 조회 함수)로 만든다.
- **툴팁 영어 규약(`FR-TIP-2`)의 무단 폐기 금지** — 주석이 "툴팁은 영어" 를 의도로 적었다. 언어 정책 선언에서 이 규약을 유지할지 폐기할지 **명시적으로 결정하고 기록**한다.
- **M7 이 확정한 시맨틱·토큰 변경 금지** — 문구만 옮긴다.
- **전량 e2e `unexpected 0`·`flaky 0` 유지** — 문구가 바뀌면 텍스트 셀렉터 85곳이 영향을 받는다. M6 이 도입한 `data-testid` 를 쓰고, 텍스트 단정은 카탈로그 키를 참조하게 바꾼다.

### 4. Definition of Done

- 언어 정책이 `README.md` 와 `docs/internal/README.md` 에 결정으로 기록된다 — 지원 로케일 목록, 기본 로케일, 로케일 감지 규칙(`navigator.language` 사용 여부), 미번역 항목의 폴백, **툴팁 영어 규약(`FR-TIP-2`)의 유지/폐기 판단**, CLI 출력의 번역 범위. 현재 `Intl`·`navigator.language` 사용이 0건이므로 이 선언이 곧 신규 계약이다.
- 카탈로그 모듈이 존재하고 키→문장 사상이 로케일별 파일로 갈린다. `constants*.js` 5파일의 문구가 키로 바뀌고 `index.html` 정적 문구 178줄이 렌더 경로로 이관된다.
- **하드코딩 문자열 검출 grep 게이트가 CI 에 존재하고 위반 0** — JS 77파일 241줄의 한국어 리터럴과 `index.html` 정적 문구가 카탈로그 밖에 남지 않음을 기계적으로 보장한다. 이 게이트가 없으면 외부화는 즉시 역행한다.
- 로케일을 전환하면 UI 문자열 전부가 바뀌고, 미번역 키가 폴백 로케일로 표시되며 콘솔에 경고가 남는다(e2e 1스펙).
- `<html lang>` 이 정적 `"en"` 이 아니라 활성 로케일로 세팅된다. 다른 언어가 섞인 요소에는 해당 `lang` 속성이 붙는다.
- CSS `content` 로만 전달되던 문구 3곳(`style.css:376,772,818`)이 DOM 텍스트로 이관된다.
- 툴팁 단축키 표기가 `displayKey(shortcuts.*)` 보간으로 생성되고 재바인딩 후 툴팁이 갱신됨을 e2e 가 단정. 보간 파라미터가 카탈로그 규약(치환 자리표시자)을 지난다.
- 서버의 한국어 `http.Error` 문구 6곳이 코드로 바뀌고 문장은 프론트 카탈로그가 소유한다.
- 혼용 해소 확인: 한 패널 안에서 언어가 갈리는 자리(`index.html:268,274` 한국어 vs `:286,294` 영어)가 **카탈로그 데이터 교정으로 해소되고 코드 변경이 0** 임을 확인 — 외부화가 제대로 됐다는 증거다.
- **보존 확인**: 전량 e2e `unexpected 0`·`flaky 0` 유지, M7 의 axe 스모크·키보드 순회 통과.

### 5. 선행 결정

**착수를 막는 것 없음.** 결정 3(i18n 도입)이 확정되어 이 마일스톤의 존재 근거가 확정됐다. 다만 **결정 2(접근성 기준)가 `UX-11` 의 검증 방법에 걸린다** — CSS `content` → DOM 텍스트 이관이 "스크린리더에서 읽힌다" 를 어떻게 판정할지가 접근성 기준에 달렸다. M7 이 선행이므로 그 시점에 이미 확정돼 있어야 한다.

### 6. SRS 필요 여부

**필요(중). 1건.**
`docs/internal/I18N_SRS.md` — 카탈로그 형식, 키 규약(네임스페이스·명명), 보간·복수형, 로케일 감지·전환·폴백, **번역 범위 경계**(UI / 서버 오류 / CLI 출력 / 문서 각각의 포함 여부와 근거), 재발 방지 게이트, 툴팁 영어 규약의 처리. §5 비목표에 문서·CHANGELOG 번역을 하지 않는다는 것을 명시.

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M9(국제화)를 실행한다.
사용자가 제품 언어 정책으로 "i18n 체계 도입"을 확정했다 (감사 리포트의 권장안은
"한국어 단일"이었으나 다르게 결정했다). 현재 i18n 체계는 존재하지 않는다 —
Intl·navigator.language 사용 0건, <html lang="en">인데 UI 대부분이 한국어,
문자열이 constants*.js 5파일에 부분 집중되고 JS 77파일 241줄 + index.html 178줄에 산재한다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M9" 섹션
- docs/internal/production/07-production-gap.md §7 전체
- docs/internal/production/03-uiux.md 의 UX-9·UX-11·UX-20·UX-21
- docs/internal/production/PRODUCTION_ROADMAP.md §3-A-1
  (외부화를 문구 확정보다 뒤에 두는 근거 — 이 마일스톤 설계의 핵심)

먼저 선행(M7·M6·M5) 완료를 킥오프 문서의 확인 명령 6줄로 검증하라.
실패하면 착수하지 말고 보고하라.

성격: 중 규모. SDD 를 따른다 — docs/internal/I18N_SRS.md 를 먼저 쓰고 사용자 확인을
받은 뒤 진행하라. SRS 에 반드시 담을 것:
- 카탈로그 형식·키 규약·보간·복수형·로케일 감지·폴백
- 번역 범위 경계: UI / 서버 오류 문구 / CLI 출력 / 문서 각각의 포함 여부와 근거
- 툴팁 영어 규약(FR-TIP-2)을 유지할지 폐기할지 명시적 결정
- 재발 방지 게이트(하드코딩 문자열 검출)
- §5 비목표: 문서·CHANGELOG 번역은 하지 않는다

내부 순서:
1) CSS content 문구 3곳(style.css:376,772,818)을 DOM 텍스트로 이관 (i18n 불가라 전제다)
2) 카탈로그 모듈 + 키 규약 확정
3) constants*.js 5파일과 index.html 정적 문구를 키로 외부화 — 이 패스에서 ko 값을 확정한다
   (한국어/영어 혼용 해소를 별도로 먼저 하면 같은 파일을 두 번 훑는다)
4) lang 동적 세팅, 툴팁 단축키 보간
5) 하드코딩 문자열 검출 게이트를 CI 에 추가
6) 서버 한국어 http.Error 문구 6곳 제거 (M5 가 이미 코드화했으므로 잔여만)

절대 하지 말 것:
- package.json 에 i18n 라이브러리 추가 (프론트에 빌드 도구가 없다. 카탈로그는 자체 모듈로)
- 문서·릴리스 노트·CHANGELOG 번역 (범위 밖)
- CLI 출력을 조용히 번역하거나 조용히 빼기 (정책 문서에 근거와 함께 기록하라)
- 툴팁 영어 규약을 무단 폐기 (명시적으로 결정하고 기록하라)
- M7 이 확정한 시맨틱·토큰 변경 (문구만 옮긴다)
- 커밋 메시지에 AI 서명 삽입

주의: 문구가 바뀌면 e2e 의 텍스트 셀렉터 85곳이 영향을 받는다. M6 이 도입한 data-testid 를
쓰고 텍스트 단정은 카탈로그 키를 참조하게 바꿔라. 전량 e2e 는 unexpected 0 · flaky 0 을
유지해야 한다.

완료 후 킥오프 문서 M9 의 Definition of Done 을 하나씩 검증해 보고하라.
"혼용 해소가 카탈로그 데이터 교정만으로 되고 코드 변경 0" 을 diff 로 증명하라.
```

---

## M8 — Go 아키텍처 부채

**목표(한 문장)**: 축 의존 규칙을 도구로 강제하고, 남은 레이스·락·타입 없는 경계를 정리하며, 거대 파일·중복을 분리한다.

**병행 가능**: M5·M6 과 상호 의존이 없다. M1·M3 이 끝났으면 언제든 착수할 수 있다.

### 1. 읽어야 할 문서

| 파일 | 볼 곳 |
|---|---|
| [`01-go-arch.md`](./01-go-arch.md) | **전체** — P0(M2 에서 이미 처리됨, 맥락용), P1 8건, P2 전체(거대 파일 8건·중복 7건·동시성 7건·리소스 3건·외부 명령 2건·설정 4건·인터페이스 4건·문서 1건), 부록 검증 결과 |
| [`05-test.md`](./05-test.md) | §2 P1 "Go 프로세스·PTY 테스트가 고정 `time.Sleep` 위에 있다", §3.3 Go 테스트 품질 5건, §0.1 커버리지 실측 |
| [`PRODUCTION_ROADMAP.md`](./PRODUCTION_ROADMAP.md) | §5-2 거대 파일 분할 착수 조건(Go 항목) |

프로젝트 파일: `docs/internal/architecture.md:49-116`(패키지 표 — 11개 누락)·`:113`("프로세스 축에 예외는 없다" — 현재 거짓)·`:959-962`(동시성 절), `internal/shared/toolhub/hub.go:6`(`List()` 시그니처), `internal/webserver/httpapi/deps.go`, `internal/webserver/toolclient/client.go`, `internal/daemon/ipc/paned.go:184-364`.

### 2. 선행 완료 확인 — M1 · M3

```bash
cd /Users/dykim/personal/dongminal
# M1
grep -q 'golangci-lint' .github/workflows/verify.yml && [ "$(gofmt -l . | wc -l | tr -d ' ')" = "0" ] && echo "M1 lint ok"
go test -race -shuffle=on -count=1 ./internal/shared/... 2>&1 | tail -3   # 통과해야 함
# M3
grep -rq 'ErrToolNotFound' internal/ && echo "M3 ipc error ok"
grep -rq 'persistErr\|lastPersistErr' internal/ && echo "M3 persist err ok"
go test ./internal/ctl/cli/ -cover 2>&1 | grep -oE 'coverage: [0-9.]+%'   # 31.5% 초과
```

### 3. 범위

**포함 발견 (P1 8건)**: `GO-4`(축 의존 규칙 위반 4곳) · `GO-5`(`OnOutput/OnExit` 레이스) · `GO-7`(`readPTY` 패닉) · `GO-9`(전역 가변상태 + 전역뮤텍스가 네트워크 I/O 를 감쌈) · `GO-6`(데몬모드 `Get/IsLive/Has` 가 매번 전체 `list` RPC) · `GO-12`(요청 고루틴 안의 `time.Sleep` 폴링) · `GO-13`(`ToolHub.List()` 가 `[]map[string]interface{}`) · `TEST-8`(Go 테스트가 고정 `time.Sleep` 위, 94회/25파일).

**포함 발견 (P2 34건)**: `GO-14`~`GO-22`(거대 파일·함수) · `GO-24`~`GO-35`·`GO-37`(중복·동시성·리소스) · `GO-39` 는 M2 에서 처리 · `GO-40`~`GO-42`(설정·상수·전역) · `GO-44`~`GO-48`(인터페이스·문서) · `TEST-23`·`25`·`26`.

> **`TEST-24` 는 정정됐다 — 기능 결손이 아니다.** `10 §4.4` 가 직접 확인했다: `Merge`(`write/branch.go:444-450`)는 3줄 래퍼이고 인자 조립·검증은 `MergeArgs` 에 있으며 `write/branch_test.go:352-375` 가 모드 4종·잘못된 모드·빈 ref 까지 시험한다. HTTP 종단은 `TestAPIGitBranchMerge`. `Replay` 는 argv 를 서버 기록에서 꺼내고 `ErrReplayTarget` 거부까지 5건의 테스트가 있다. **함수 단위 테스트를 새로 쓰지 마라** — "함수 커버리지 0%" 는 지표의 산물이다. 커버리지 리포트에 "래퍼 함수의 0% 는 결손이 아니다" 를 주석으로 남기고, `OperationActions`·`Unwrap` 만 개별 판단한다.

**추가 포함 — 기능 축(`10`·`12`·`09`)에서 온 17건**

| 구분 | ID | 한 줄 | 규모 |
|---|---|---|---|
| P1 | **FBE-01** | `dmctl` 의 10초 고정 타임아웃이 서버의 장기 보류(최대 180초)를 끊는다 — **실패로 보고된 승계가 실제로는 성공해 있고 재시도가 멤버·도구를 이중으로 만든다.** 같은 파일의 `dmctl wait` 는 이미 옳게 한다(`dmctl_status.go:305-310`) | S(클라)+M(서버 ctx=`GO-12`) |
| P1 | **FBE-02** | `dmctl` 레이아웃 명령 전부가 브라우저 미구독을 성공으로 보고(exit 0). **같은 종단을 쓰는 `detach` 는 `delivered==0` 을 확인해 exit 1 을 낸다** — 한쪽만 고쳐진 자리 | S |
| P1 | **FBE-04** | `POST /api/runs/close` 가 브라우저 없이도 "탭을 닫았다" 고 보고 → 존재하지 않는 Run 의 `runId` 표식이 탭에 영구히 남는다. `attach`/`detach` 는 같은 전제를 검사해 503 을 낸다 | S |
| P1 | **FBE-05·12** | 데몬 모드에서 `POST /api/tools/kill` 의 3초 유예가 적용되지 않는다(실측 50ms) — FR-BGK-7 위반이고 **데몬 모드가 기본 경로**다(`main.go:461`) | S/M |
| P1 | **FBE-06** | codex 멤버는 `dmctl run launch` 경로에서 프리앰블을 통째로 잃는다 — "호출자가 별도로 붙여넣어야 한다" 는 주석은 있으나 **알리는 코드도 문서도 없다** | S |
| P2 | **FBE-09~11·13~16·18** | `--isolated` 홈 상실 미고지 · 격리 홈 경로 미출력 · 터미널 리셋이 데몬 모드에서만 매 접속(vim 마우스가 꺼진다) · `dmctl status --member` 없음 · `--model` 무시 무경고 · CLI 에 `run delete`/`graph` 없음 · 없는 `--cwd` 가 조용히 홈으로 폴백 · 붙여넣기 종료 마커 미이스케이프 | S×8 |
| P2 | **FUI-23** | Run 시작이 UI 에 없다 — `FBE-15` 와 **반대 방향의 같은 격차**. 기록만 | S |
| P2 | **`09` FR-GCC-3·4** | `write.SyncNext`·`StepOutcome` 죽은 코드 — exported 라 자기 테스트로 초록을 유지해 커버리지·정적분석이 잡지 못한다 | S |
| P2 | **`09` D-WBR-8** | "다음 판에서 확인하고 지운다" 한 죽은 분기가 그대로(`app-layout.js:732-736`) | S |
| P1(부분) | **FBE-08**(작업 경로분) | `submodule update` 를 `jobs.Jobs` 경로에 태워 취소·진행 SSE 를 준다(환경·ctx 최소분은 M2) | M |

**`10` 의 P1 8건을 별도 마일스톤으로 만들지 않은 이유**: 성격이 셋으로 갈리고 각각 이미 있는 마일스톤의 코드 지점과 겹친다. **M3 으로** `FBE-03`(재기동 복원 — `TEST-2`·`G3-1` 과 같은 영역)·`FBE-07`(pidfile — `GO-36`·`TEST-3` 과 같은 자리), **M2 로** `FBE-08` 의 환경·ctx 최소분(`B5` 와 같은 코드), **나머지 5건은 여기** — `FBE-01` 서버측은 `GO-12` 와 **같은 코드**, `FBE-05/12` 는 `GO-46`(데몬 모드 판별이 타입 단언으로 샘)과 같은 계층, `FBE-02`·`04`·`06` 은 CLI↔서버 계약 표면으로 한 벌이다.

**포함 갭**: 없음.

**순서 제약 (이 마일스톤에 걸리는 것)**
- **M1 이 선행이다.** 린트·`-shuffle`·커버리지 기준선 없이 이 규모의 구조 변경은 회귀를 사람이 잡는다.
- **M3 이 선행이다.** `GO-8`(IPC 실패를 성공으로)·`GO-10`(영속 실패)·`GO-36`(pidfile)이 M3 에서 IPC·영속 경계를 이미 손댔으므로 그 위에서 진행한다.
- **거대 파일 분할은 커버리지 기준선 기록 후에만.** 분할 후 커버리지 하락 0 이 조건이다.

**건드리지 말 것**
- **git 실행 초크포인트**(`domain/git/core`)와 `scripts/check-gitwrite.sh` 게이트 — 양호 판정.
- **`apierr` 등록부** — sentinel 78개·테이블 3벌·전수성 테스트는 양호 판정. 오류 렌더러 통합(`GO-23`)은 M2 에서 이미 처리됐다.
- **오류 본문 방언 4종 통일 금지** — `architecture.md:141-176` 공개 계약.
- **고득점 커버리지 패키지**(`toolline`·`outbuf`·`apierr`·`web` 100%, `workspace` 89.9%, `git/write` 89.7%, `httpapi` 81.7%) — 분할·리팩터 후 하락 0.
- **`go.mod` 경량성** — 제네릭·`atomic`·`log/slog` 는 표준. 동시성·DI 라이브러리 금지.
- **`--isolated` 구조적 보호와 프로세스 제어 가드** — M3 이 테스트로 고정한 동작을 바꾸지 않는다.
- **`platform.WriteFileAtomic` 원자성**과 M3 의 백업 세대 동작.
- **분할 PR 은 동작 변경 0.** 이동 전후 대응표를 남기고 같은 PR 에 기능 변경을 섞지 않는다.

### 4. Definition of Done

- `go list -deps` 를 읽는 경계 테스트가 `internal/{ctl,daemon,helper}` → `internal/webserver` import 를 실패시킨다. 현재 위반 4곳(`shared/runtime→helper/runtimebin`, `daemon/boot→webserver/domain/run`, `ctl/cli→webserver/domain/git/core`, `shared/sandboxplace→shared/toolhub`)이 해소되거나 명시적 예외 목록으로 등록되고 `architecture.md:113` 이 사실과 맞게 개정된다.
- `architecture.md:49-116` 패키지 표가 `go list ./...` 과 일치(생성 또는 대조 스크립트가 CI 에서 0 불일치). 누락 11개 해소. `:959-962` 에 `toolclient`·`AttnTracker`·`Jobs` 기재.
- `go test -race -shuffle=on -count=1 ./...` 통과. `t.Parallel()` 도입 패키지에서 전역 테스트 훅(`toolBusyProbe`·`attnBusyProbe`·`fgProbe`·`attnNow`·`procCtl`)이 구조체 필드 주입 또는 restore 반환형으로 교체.
- `SetOnOutput/SetOnExit`(mu 또는 `atomic.Pointer`) 도입 + 필드 비공개화. `cmd/dongminal/main.go:468,472` 맨 대입 소멸. 배선을 포함한 레이스 테스트 존재.
- `readPTY` 의 `recover` 뒤에 `p.kill()` + `relay.onExit` 이 EOF 경로와 같은 순서로 호출되고, 패닉 주입 테스트가 도구 정리와 `OpExit` 전달을 확인.
- `time.Sleep` 이 요청 경로에서 0곳 — `handlers_runs.go:364-379`·`handlers_runs_headless.go:232-244`·`handlers_runs_cleanup.go:104-123`·`bracketpaste.go:123`·`tool.go:746`·`worktree.go:424-436` 이 `select { case <-ctx.Done(): … }` 로 교체. 클라이언트 연결을 끊으면 대기가 즉시 종료됨을 테스트로 확인. `repoLock` 을 쥔 채 최대 18분 대기하는 경로 소멸.
- 테스트의 1초 이상 `time.Sleep` 0. `StartAttentionSweeper(stop, tick <-chan time.Time)` 로 틱 주입, `history_shell_test` 의 500ms×4 가 폴링 헬퍼로 교체.
- `ToolHub.List()` 가 `[]ToolInfo` 를 반환하고 `m["id"].(string)` 형 단언 0. `map[string]interface{}` 79곳 감소, 필드 추가가 컴파일 오류로 잡힘을 1회 확인.
- 데몬 모드 `Get/IsLive/Has` 가 전체 `list` RPC 를 매번 부르지 않는다(`has {id}` RPC 또는 TTL 캐시 + `exit` push 무효화). `GET /api/runs` 한 번의 RPC 왕복 수 감소 계측.
- `httpapi` 전역 가변상태가 `Server` 필드로 이동 → `server.go:1-4` 의 "두 서버 공존" 계약이 성립함을 두 서버 동시 기동 테스트로 확인. `fsOpMu` 가 실제 파일 조작 구간만 감싼다.
- 동시성 9건 해소: `Create` 가 락 밖에서 `StartTool`, onExit 클로저가 `invalidator` 를 락으로 읽음, `tool.Restored` 가 `atomic.Bool`, `ClearAllAttention` 이 락을 놓고 `Broadcast`, `StartGitWatch` 가 `ctx` 를 받음, `OnIndexUpdate` 가 락 밖 호출 + rev 순서 보장, `time.After` → `NewTimer`+`Stop`, PTY 청크 복사 1회.
- `deps.go` 구체 포인터 5개 → 좁은 인터페이스로 `/api/runs*`·`/api/git/*` 핸들러 테스트가 파일시스템·git 없이 돈다. `SettingsStore` 가 패키지 밖에서 구현 가능. 데몬 모드 판별 타입 단언 4곳이 인터페이스 메서드로.
- 500줄 초과 Go 파일 목록 축소. `main.go serve` 158줄 + `buildDeps` 3벌 → `Build(cfg)`/`App.Run(ctx)`/`App.Shutdown()`, 종료 순서 주석이 코드가 된다. `doctor.go` 진단 11개가 `[]check{name, fn}` 표.
- 중복 6건 해소: `decodeParams[T]` 제네릭 + JSON-RPC 코드 상수, `dataPath` 1벌, `HeadlessToolIDs` 부팅 중 1회 읽기, 스냅샷 프레이밍 1벌, `pollUntil(ctx, every, fn)` 1벌, 기본 터미널 크기 상수 1곳.
- `worktree.go:600` 의 `strings.Contains(p, "..")` 오탐(`a..b` 정상 이름 거부) 해소 + 테스트.
- Go 테스트: `gittest` 헬퍼로 픽스처 7벌 → 1벌, `DONGMINAL_SHELL` 을 `t.Setenv` 로 고정. **`Merge`·`Replay` 에 함수 테스트를 새로 쓰지 않는다**(범위의 `TEST-24` 정정) — 커버리지 리포트에 "래퍼 함수의 0% 는 결손이 아니다" 를 주석으로 남기고 `OperationActions`·`Unwrap` 만 개별 판단.
- **`dmctl` 계약**: `runPost`/`runGet` 이 서브커맨드별 예산을 받는다(`dmctl_status.go:305-310` `wait` 의 형태). 서버측 `time.Sleep` 루프가 `select { case <-ctx.Done() }` 로 바뀐다(=`GO-12`). 전임자가 60초 뒤 답해도 `run succeed` 가 성공으로 끝남을 통합 테스트로 확인.
- `dmctlHTTPResult` 가 `delivered`(생성 명령은 `timedOut`·`newTabs` 도)를 판정 — 브라우저 없이 `dmctl new-tab` 이 **exit 1** 과 `detach` 와 같은 문구를 낸다.
- `POST /api/runs/close` 가 방송 결과를 그대로 `closed` 에 싣는다 — 브라우저 0 이면 `closedTabIDs` 에서 빠져 표식 해제가 정상 동작한다.
- 데몬 모드 `POST /api/tools/kill` 의 유예가 **3초**다(현재 50ms). 백그라운드 claude 세션이 SIGTERM 후 이력을 남기고 종료함을 확인.
- `dmctl run launch` 가 codex 처럼 `PromptInjection != PromptArgv` 인 에이전트에서 stderr 안내를 낸다. 헬프 3단계 절차에 그 분기가 명시된다.
- `--isolated` 가 도구 홈 상실을 알리고 `--foreground` 에서도 격리 홈 경로가 출력된다.
- `termReset` 이 두 모드에서 같은 조건·순서로 나간다 — 데몬 모드에서 vim 이 도는 탭을 새로고침해도 마우스·bracketed paste 가 꺼지지 않는다.
- `dmctl status --member <uuid>` 가 동작하고 `run delete`·`run graph` 가 추가된다. 없는 `--cwd` 가 400 을 낸다.
- `wrapPaste` 가 본문의 `ESC[201~` 를 제거하고 `apiToolMessage` 가 엔벨로프 구분자를 치환한다.
- `write.SyncNext`·`StepOutcome` 과 그 자기 테스트, `app-layout.js:732-736` 의 죽은 분기가 제거된다. **제거할 수 없는 보류는 가드 테스트로 봉인**한다(`agentadapter/adapter_test.go:66-72` 형식).
- **보존 확인**: `go vet ./...` 무경고, `go build ./...` 성공, `scripts/check-gitwrite.sh`·`check-seams.sh`·`check-timers.sh`·`check-cross.sh` 통과, 고득점 패키지 커버리지 하락 0.

### 5. 선행 결정

**없음.**

### 6. SRS 필요 여부

**필요(중). 2건.**
1. `docs/internal/PACKAGE_AXIS_SRS.md` — 패키지 축 규칙: 축 정의, 허용 의존, 예외 등록 절차, 강제 방법(`go list -deps` 테스트). `architecture.md:113` 의 "예외는 없다" 서술을 사실과 맞게 개정하는 근거를 담는다.
2. `docs/internal/CONCURRENCY_CONTRACT_SRS.md` — 락 순서, 콜백을 락 밖에서 부르는 규칙, 컨텍스트 전파, 테스트 훅 주입 방식.

거대 파일 분리는 SRS 대신 이동 전후 대응표로 충분하다.

### 7. 착수 프롬프트

```
프로젝트: /Users/dykim/personal/dongminal

프로덕션화 로드맵의 M8(Go 아키텍처 부채 + 백엔드·CLI 기능 완성도)을 실행한다.
P1 13건 + P2 46건. 이 코드베이스의 기능 결손은 주석이 아니라 모드 간 배선 차이와
CLI↔서버 계약 불일치로 나타난다(미완성 마커는 0건이다). 축 의존 규칙이 문서와 실제 import 그래프에서 어긋나 있고(4곳),
문서화된 채 방치된 데이터 레이스가 있고, 요청 고루틴이 컨텍스트 취소를 전파하지 않는다.
M5·M6 과 상호 의존이 없어 병행 가능하다.

먼저 다음을 읽어라:
- docs/internal/production/MILESTONE_KICKOFF.md 의 "M8" 섹션
- docs/internal/production/01-go-arch.md 전체
- docs/internal/production/05-test.md §2 의 time.Sleep 항목, §3.3, §0.1
- docs/internal/production/PRODUCTION_ROADMAP.md §5-2 (거대 파일 분할 착수 조건)
- docs/internal/architecture.md:49-116, :113, :959-962
- docs/internal/production/10-func-backend.md 전체 (FBE-01·02·04·05·06·09~18)
- docs/internal/production/09-srs-implementation-gap.md §1 의 FR-GCC-3·4 와 D-WBR-8

먼저 선행(M1·M3) 완료를 킥오프 문서의 확인 명령으로 검증하라. 실패하면 착수하지 말고 보고하라.

성격: 대 규모. SDD 를 따른다 — 다음 두 SRS 를 먼저 쓰고 사용자 확인을 받은 뒤 진행하라:
- docs/internal/PACKAGE_AXIS_SRS.md
- docs/internal/CONCURRENCY_CONTRACT_SRS.md

내부 순서:
1) 경계 테스트·문서 일치 (GO-4·GO-48) — 이후 모든 변경의 가드
2) 레이스·리소스 (GO-5·GO-7·GO-29~37)
3) 컨텍스트·전역상태 (GO-9·GO-12) — FBE-01 서버측이 여기 붙는다(같은 코드)
4) 타입·인터페이스 (GO-13·GO-44~47) — FBE-05/12 모드 배선이 여기(GO-46 과 같은 계층)
5) CLI 계약 (FBE-02·04·06·13~16·18)
6) 분리·중복·죽은 코드 제거 (GCC-3/4·D-WBR-8 포함)
7) 테스트 결정성 (TEST-8·23·25·26)

절대 하지 말 것:
- Merge/Replay 에 함수 단위 테스트 추가 (기능 결손이 아님이 확인됐다 — 10 §4.4)
- GP-8(gitwatch 병렬화)을 여기서 하기 — M6 이 GO-33 과 같은 줄을 건드린다. 확인만 하라
- domain/git/core 초크포인트와 check-gitwrite.sh 게이트 변경 (양호 판정)
- apierr 등록부 재설계 (양호 판정)
- 오류 본문 방언 4종 통일 (architecture.md:141-176 공개 계약)
- 고득점 커버리지 패키지의 커버리지 하락 (toolline/outbuf/apierr/web 100%,
  workspace 89.9%, git/write 89.7%, httpapi 81.7% — 분할 후 유지해야 한다)
- go.mod 에 의존 추가 (제네릭·atomic·log/slog 는 표준. 동시성·DI 라이브러리 금지)
- --isolated 구조적 보호와 프로세스 제어 가드 변경 (이전 마일스톤이 테스트로 고정했다)
- WriteFileAtomic 원자성과 백업 세대 동작 변경
- 분할 PR 에 기능 변경 섞기 (동작 변경 0. 이동 전후 대응표를 남겨라)
- 커밋 메시지에 AI 서명 삽입

완료 후 킥오프 문서 M8 의 Definition of Done 을 하나씩 검증해 보고하라.
경계 테스트는 위반을 일부러 만들어 실패하는 것을 1회 확인하고 출력을 붙여라.
```

---

## 변경 기록

| 날짜 | 변경 |
|---|---|
| 2026-09-09 | 초판. M0~M9 10개 마일스톤의 읽을 문서·선행 완료 확인 명령·범위(보존 계약 포함)·DoD·선행 결정·SRS 계획·착수 프롬프트 |
| 2026-09-10 | **결정 8 확정(TLS 축소안) + `13` 반영** — **M4 착수 가능 상태로 전환**(선행 결정 없음). M4 에 확정 전제 표(TLS 범위)·`TLS-1`(알림 조용한 실패)·`TLS-2`(노출 판정 오표시) 추가, `G1-5` 규모 M→S, SRS 2 범위 축소. **알림 묶음을 M7 이 아니라 M4 로 판정**하고 근거 5항 기록. M2 에 게이트 허용목록 10항. 미결정 4→**3건** |
| 2026-09-09 | **기능 완성도 4축(`09`~`12`) 반영** — M6/M7/M9 의 ⚠️ 배너 해제. **M6 전면 재작성**(git 갱신 계층 재설계로 성격 변경, flaky 9건 확정 매핑 표 신설, 내부 8단계, SRS 2→4건). M1 에 P0 `GP-1` 즉시 완화 추가. M3 에 미저장 편집 3건(`FUI-01` P0 재판정)·`FBE-03`·`FBE-07`·`FBE-17`·`FUI-05` 추가 + SRS 3건. M2 에 `FBE-08`·`FUI-06`·샌드박스 자원 제한. M7 에 FUI 8건. M8 을 "+ 백엔드·CLI 기능 완성도" 로 확장(FBE 14건·죽은 코드 2건, `TEST-24` 정정) |
| 2026-09-09 | 결정 7(멀티유저 미지원) 확정 + 전제 재프레이밍(원격이 핵심 목적·기본 사용 형태) 반영 — §0-1 결정 표에 7 추가, §0-1-1 전제 절 신설, §1 착수 순서표 갱신(미결정 4건·M6/M7/M9 범위 미확정 경고), M2 에 M2~M4 운영 안내 DoD 추가, M3 내부 순서와 결정 6 완화, M4 성격·`SEC-3` 재판정·`G10-1` 범위 재정의·결정 8 조사 중 표기, M6/M7/M9 에 잠정 배너 |
