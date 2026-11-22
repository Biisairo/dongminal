# SRS: 「정독하지 않은 곳」 감사의 결함 고침 (IEEE 29148 준수)

> **문서 상태**: 승인·구현완료
>
> 근거: 묶음 넷의 Go 단위 시험(`go test -race -shuffle=on ./...` 통과)·`web/js/test/statusbar-poll.test.mjs` TC-ATF-44·`make gates`. 구현이 SRS 와 다르게 간 자리는 §5 다

## 1. 개요 (Introduction)

### 1.1 목적 (Purpose)
`docs/internal/refactor/PROD3_ATTIC.md` 의 분류 「고침」 52건을 고친다. 결함이 사라지는 것 외에는 동작을 바꾸지 않는다.

### 1.2 범위 (Scope)
- 포함: PROD3_ATTIC §5 의 묶음 ATT-1(git)·ATT-2(확장 팩·LSP)·ATT-3(telegram·sysstat)·ATT-4(망·채팅·설정·설치)
- 비포함: 분류 「물음」 12건(사용자 결정 대기), 「문서」 10건(사용자 선택에 따라 문서 정정), 「둠」 7건, 화면(FE) 변경

### 1.3 정의 (Definitions)
- **칸**: git 잡의 배타 단위(index·common). `internal/webserver/domain/git/jobs/exclusion.go`
- **격리 칸**: 확장 팩의 설치 루트 `<root>`(FR-EXT-20)

### 1.4 설계 결정

| # | 결정 | 이유 |
|---|---|---|
| D-ATF-1 | 브랜치 checkout 의 argv 끝에 `--` 를 붙인다. 판정 단계는 바꾸지 않는다 | git 이 이름을 ref 로만 읽고, 없는 ref 는 git 이 오류로 끝낸다. 판정에 `rev-parse` 를 더하는 것보다 한 자리에서 막는다 |
| D-ATF-2 | undo 토큰에 발급 시점의 HEAD oid 를 싣고, 소비 때 HEAD 가 다르면 토큰을 소모하지 않고 기존 코드 `stale_observation`(그 코드의 기존 HTTP 상태)으로 거절한다 | 다른 경로의 커밋을 되돌리지 않는다. 「관측한 HEAD 가 낡았다」 는 그 코드의 뜻 그대로다 — 새 코드를 만들지 않는다 |
| D-ATF-3 | `finish` 에 든 잡의 `Cancel` 은 false 를 돌려준다(이미 끝나는 중) | 취소 응답과 결과가 어긋나지 않는다. 결과를 다시 분류하는 쪽은 완료 훅이 이미 돈 뒤라 되돌릴 수 없다 |
| D-ATF-4 | 잡 실행기·완료 훅의 panic 은 그 잡의 실패(`Err`)로 바꾸고 칸을 비운다. 스택은 `dmlog` 로 | 서버 전체가 죽지 않는다 |
| D-ATF-5 | 깨진 `edges.json` 은 `edges.json.bad-<UTC시각>` 으로 옮기고 경고 로그를 남긴 뒤 빈 설정으로 연다 | 원본을 잃지 않는다. 빈 설정으로 여는 지금 동작은 유지한다 |
| D-ATF-6 | Telegram 길이 상한은 UTF-16 코드 단위로 센다 | Bot API 의 4096 은 UTF-16 단위다(공식 문서 「1-4096 characters after entities parsing」, 엔티티 오프셋이 UTF-16) |
| D-ATF-7 | doctor 의 임시 bin 실패는 오류로 끝낸다 | FR-HLI-5·8 — doctor 는 운영 bin 을 건드리지 않는다 |

## 2. 요구사항 (Specific Requirements)

### 2.1 ATT-1 git

- **FR-ATF-1** (AT-GAPI-1) — `CheckoutArgs` 의 argv 는 언제나 `--` 로 끝난다. 워킹 트리의 파일 이름과 같은 ref 이름으로 checkout 해도 파일이 바뀌지 않는다.
- **FR-ATF-2** (AT-GAPI-2·3) — undo 토큰은 HEAD oid 를 갖는다. 소비 때 HEAD 가 다르면 토큰을 남기고 `stale_observation` 으로 거절한다. 커밋 메시지 읽기는 토큰 소비 전에 한다.
- **FR-ATF-3** (AT-GAPI-6) — 브랜치 생성·이름 변경의 이름 검증과 존재 확인은 한 번만 돈다(write 쪽 sentinel → 기존 409 사상).
- **FR-ATF-4** (AT-GAPI-8) — 브랜치 삭제 인자의 중복 이름은 하나로 접는다.
- **FR-ATF-5** (AT-GAPI-11) — Discard 의 복구 안내는 실행이 성공한 뒤에 등록한다.
- **FR-ATF-6** (AT-GJB-1) — D-ATF-3.
- **FR-ATF-7** (AT-GJB-2) — 출력 보존 상한을 넘을 때 매 줄 복사하지 않는다(상한의 두 배에 닿으면 한 번에 자른다). 보이는 줄 수 상한은 그대로다.
- **FR-ATF-8** (AT-GJB-4) — D-ATF-4.
- **FR-ATF-9** (AT-GJB-6·7) — 철회된 FR-GIT-112 근거 주석을 고친다. ctx 오류 분류(DeadlineExceeded→ErrTimeout, Canceled→ErrCanceled)는 `core` 의 함수 하나다.
- **FR-ATF-10** (AT-GJB-8) — 4096바이트 줄 끊기는 UTF-8 룬 경계에서 한다.
- **FR-ATF-11** (AT-GST-1·2·3) — `gitDirs` 캐시 미스는 경로별 single-flight 다. `ForgetRoot` 는 그 경로 아래의 `dirs` 도 지운다. 루트 경로(`/`, `C:\`)도 하위 항목을 지운다.

### 2.2 ATT-2 확장 팩·LSP

- **FR-ATF-20** (AT-EXT-1·8) — 아카이브의 심볼릭 링크는 상대 경로이고 해석 결과가 칸 안일 때만 만든다. 파일을 쓰기 전 부모 디렉터리의 실경로가 칸 안인지 본다. tar 하드링크는 strip 을 적용한 칸 안 대상을 복사한다.
- **FR-ATF-21** (AT-EXT-2) — 같은 런타임 id 의 조달은 직렬이다.
- **FR-ATF-22** (AT-EXT-3) — 팩 id 는 `.new` 로 끝날 수 없다.
- **FR-ATF-23** (AT-EXT-4) — 새 설치를 옮겨 넣기 전에 옛 설치를 비켜 두고, 성공한 뒤에만 지운다. 실패하면 옛 설치를 되돌린다.
- **FR-ATF-24** (AT-EXT-5) — 다운로드 임시 파일은 `<root>/cache` 아래에 만든다.
- **FR-ATF-25** (AT-EXT-7) — 해제 총량은 `MaxArchiveBytes` 의 정해진 배수(상수)를 넘지 못한다. 넘으면 조달이 실패한다.
- **FR-ATF-26** (AT-EXT-9) — 설치 명령은 `WaitDelay` 를 갖는다.
- **FR-ATF-27** (AT-EXT-11·12) — `deployed.json` 은 원자 쓰기다. 기록이 실패하면 이번 기동에 쓴 `plugin.json` 을 되돌린다.
- **FR-ATF-28** (AT-EXT-14·16) — 쓰지 않는 `FetchTimeout` 을 지운다. 진단 꼬리는 `diagtail` 을 쓴다.
- **FR-ATF-29** (AT-LSP-1) — LSP 헤더 한 줄과 헤더 총량에 상한이 있다. 넘으면 그 연결을 닫는다.
- **FR-ATF-30** (AT-LSP-2) — 경로표 저장과 메모리 갱신은 한 직렬 구간이다.
- **FR-ATF-31** (AT-LSP-3) — LSP 서버 정지는 프로세스 그룹 전체를 끝낸다(Unix `Setpgid`; Windows 는 지금처럼 `Kill`).
- **FR-ATF-32** (AT-LSP-5) — 없는 동작을 적은 주석을 고친다.

### 2.3 ATT-3 telegram·sysstat

- **FR-ATF-40** (AT-TG-1·2) — 알림 본문의 모든 사용자·에이전트 유래 글(질문·선택지·위치 이름 포함)은 HTML 변환 전에 잘리고, 최종 본문은 UTF-16 4096 단위를 넘지 않는다(D-ATF-6).
- **FR-ATF-41** (AT-TG-4) — 버튼 걷기가 실패한 메시지 id 는 추적 목록에 남는다.
- **FR-ATF-42** (AT-TG-5) — 짝맞춤 코드를 쓴 뒤 사용자 저장이 실패하면 실패를 알리는 답을 보낸다.
- **FR-ATF-43** (AT-TG-6) — 알림 분류(transcript 읽기)는 `b.mu` 밖에서 한다.
- **FR-ATF-44** (AT-SYS-1) — 메모리 읽기의 부분 성공(총량만)도 `memTotal` 로 낸다.
- **FR-ATF-45** (AT-SYS-4) — mach host 포트는 한 번 얻어 둔다.

### 2.4 ATT-4 망·채팅·설정·설치

- **FR-ATF-50** (AT-MESH-2) — `Notify` 의 발신은 자동 재연결과 같은 `dialState` 를 거친다.
- **FR-ATF-51** (AT-MESH-4) — 초대 기억이 가득 차고 만료 전 항목뿐이면 새 초대를 거절한다.
- **FR-ATF-52** (AT-CHAT-1) — 상대 노드 상태에서 사라진 방은 `left` 에서도 지운다.
- **FR-ATF-53** (AT-CHAT-2) — 같은 노드로 가는 전달은 보낸 순서를 지킨다(노드별 직렬 전달).
- **FR-ATF-54** (AT-CHAT-3) — `Close` 뒤 들어온 프레임은 전달하지 않는다.
- **FR-ATF-55** (AT-CHAT-4·5) — `Rooms` 는 명단 맵을 한 번 만든다. 상태 반응 반복은 도달 가능 집합을 반복 밖에서 한 번 얻는다.
- **FR-ATF-56** (AT-CHAT-6) — 로컬 상대의 1:1 방도 방 수 상한을 본다.
- **FR-ATF-57** (AT-ECFG-1) — D-ATF-5.
- **FR-ATF-58** (AT-ECFG-4) — 원자 쓰기는 POSIX 에서 rename 뒤 디렉터리를 fsync 한다.
- **FR-ATF-59** (AT-INST-1) — D-ATF-7.
- **FR-ATF-60** (AT-INST-3·4) — 설치 manifest 는 자기 복사본·shim 도 적는다. manifest 의 줄은 알려진 헬퍼 이름이고 경로 구분자·`..` 가 없을 때만 지운다.
- **FR-ATF-61** (AT-INST-6) — 비밀 파일 쓰기는 `platform.WriteFileAtomic` 이다.

## 3. 검증 (Verification)

| TC | 대상 | 방법 |
|---|---|---|
| TC-ATF-1 | FR-ATF-1 | Go: 임시 저장소에 `f.txt` 를 수정한 뒤 ref `f.txt` 로 checkout 하면 실패하고 파일 내용이 그대로다. argv 끝이 `--` |
| TC-ATF-2 | FR-ATF-2 | Go: 토큰 발급 뒤 다른 커밋을 만들면 undo 가 `stale_observation` 이고 토큰이 남는다 |
| TC-ATF-3~11 | FR-ATF-3~11 | Go 단위: 각 요구마다 실패 시험을 먼저 쓴다(`-race`) |
| TC-ATF-20~32 | FR-ATF-20~32 | Go 단위: 두 홉 링크 아카이브 거절, 동시 조달, `.new` id 거절, Rename 실패 시 복구, 해제 상한, 헤더 상한, 동시 PUT |
| TC-ATF-40~45 | FR-ATF-40~45 | Go 단위: 긴 질문·이모지 본문이 4096 UTF-16 이하, 걷기 실패 재추적, nocgo 가짜 reader 의 `memTotal` |
| TC-ATF-50~61 | FR-ATF-50~61 | Go 단위: 깨진 `edges.json` 보존, Close 뒤 프레임, 순서, manifest `..` 줄 무시, doctor 대체 경로 없음 |
| TC-ATF-90 | 전체 | `make gates` · `go test -race -shuffle=on ./...` · 단위 · typecheck · lint. e2e 는 묶음 끝에 전량 |

## 4. 이전 동작 / 새 동작 / 이유
각 FR 의 「현상」 이 이전 동작이고 FR 본문이 새 동작이다. 이유는 PROD3_ATTIC 의 해당 행이다. 사용자에게 보이는 변화는 결함이 사라지는 것뿐이다 — 다만 FR-ATF-1(파일 이름 ref 의 checkout 이 실패한다)·FR-ATF-2(다른 커밋이 끼면 undo 가 거절된다)·FR-ATF-40(긴 알림이 잘려서 온다)·FR-ATF-57(깨진 설정 파일이 옆에 남는다)은 화면이나 응답에서 보인다.

## 5. 구현이 정한 것 · SRS 와 다르게 간 자리 (2026-11-22)

| # | 자리 | 내용 | 이유 |
|---|---|---|---|
| D-ATF-8 | FR-ATF-1 | `checkout -b <name> <start>`(`BranchCreateArgs`)에는 `--` 를 붙이지 않는다. 잡 울타리(`jobs/kinds.go` `checkoutShape`)는 끝의 `--` 를 받고, `-b` 없는 ref 는 `--` 가 없으면 거절한다 | `-b` 의 시작점은 git 이 커밋으로만 읽는다(실측: `'f.txt' is not a commit`) |
| D-ATF-9 | FR-ATF-2 | undo 티켓의 HEAD 는 `query.HeadCommit`(`log -1` 한 번으로 oid·메시지)이 읽는다. 재조회도 HEAD 읽기도 실패하면 토큰을 내지 않는다. 판정과 `reset --soft HEAD@{1}` 사이의 아주 짧은 창은 남는다 | 판정은 서버가, 되돌리기는 git 이 한다 |
| D-ATF-10 | FR-ATF-3 | 동기 생성·이름 변경의 이름 충돌은 write 의 `BranchExistsError` 가 낸다. 409 본문은 기존 필드(`branch`·`track`·`options`)에 `partial:false`·`status` 가 더해진 상위 집합이고, `message` 는 `branch_exists: …` 꼴이다. 잡 경로(checkout, `checkout:true` 생성)는 처리기 검사를 그대로 둔다 | write 가 검사하지 않는 경로가 있다 |
| D-ATF-11 | FR-ATF-5 | 일부만 적용되고 실패한 Discard 도 복구 안내를 남기지 않는다(응답의 `partial`·`changed` 가 알린다). FR-GIT-92 를 근거로 「실행 전 등록」 을 요구하던 시험을 뒤집었다 | SRS 문구 그대로 |
| D-ATF-12 | FR-ATF-9 | 잠금 대기 오류 문구가 `git_timeout: 잠금을 기다리는 중: context deadline exceeded` 꼴이 된다. `errors.Is` 분류는 같다 | ctx 오류도 함께 감싼다 |
| D-ATF-13 | FR-ATF-31 | 언어 서버는 `platform.Current().Process.NewGroup` 으로 띄운다 — POSIX 새 세션, Windows Job Object. Windows 도 자손까지 끝난다. 언어 서버는 터미널의 Ctrl-C 를 직접 받지 않는다(stdin 이 닫히면 스스로 끝난다) | 이음매 게이트(OS 호출은 `platform` 안). git 잡과 같은 묶음 규칙 |
| D-ATF-14 | FR-ATF-40 | 4096 은 태그를 걷고 이스케이프를 푼 글의 UTF-16 길이로 잰다. 표 변환으로 늘어 넘치면 예산을 반으로 줄여 다시 만든다. 처음 넘친 자리에 `…(PC 에서 보기)` 를 한 번 붙인다 | 공식 문서의 「after entities parsing」 |
| D-ATF-15 | FR-ATF-44 | `Snapshot.MemTotalValid` 를 더했다. 상태바는 사용량이 숫자일 때만 메모리를 그린다(총량만 오면 그리지 않는다 — 지금과 같다) | 총량만 그리면 `NaNGB/16.0GB` 가 된다 |
| D-ATF-16 | FR-ATF-51 | 초대는 지금 아는 노드의 키로 서명이 확인될 때만 받고 기억한다. 노드 하나의 몫 16(`maxSeenPerSender`), 전체 `maxNodes × 16`. 노드를 잊는 같은 잠금 구간에서 그 몫도 지운다. 이 노드가 보낸 초대는 따로 1024 까지 — 가득 차면 `ErrInviteFull` → `edge_rate_limited`(429, `edgenode/mesh.go`). 만료 전 항목은 밀어내지 않는다. 받아들인 위험: 잊힌 노드가 다시 알려지면 만료 전(최대 10분)의 옛 초대를 한 번 더 받을 수 있다 | 보안 검토 세 번(전역 표 고갈 · 지문 위조 · 노드 교체) |
| D-ATF-17 | FR-ATF-53 | 로컬 참가자로의 전달도 노드별 줄을 지나 비동기가 된다 | 한 길로 순서를 지킨다 |
| D-ATF-18 | FR-ATF-58 | rename 뒤의 디렉터리 fsync 실패는 오류가 아니라 경고 로그다 | 파일은 이미 바뀌었다 — 「실패하면 옛 내용 그대로」(FR-CAF-10)와 맞춘다 |
| D-ATF-19 | FR-ATF-60 | 「알려진 헬퍼 이름」 은 이름의 꼴(빈 값·`.`·`/`·`\`·`:`·`..` 없음)로 판정한다. shim 기록은 `agent-shims/.helpers` 에 새로 둔다 | 지금 목록에 있는 이름만 지우면 폐지된 이름을 거둘 수 없다 |
| D-ATF-20 | FR-ATF-45·55 | 실패 시험을 먼저 쓰지 못했다 — 45 는 cgo 가 시험 파일에서 안 되고, 55 는 성능만 바뀐다. 기존 시험이 회귀를 막는다 | — |
