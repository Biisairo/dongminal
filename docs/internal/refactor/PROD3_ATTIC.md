# 프로덕션 리팩토링 3차 — 「정독하지 않은 곳」 읽기 감사

> 2026-11-22 · `main` · 기준 커밋 `6f7260e7`
> 착수 문서: `docs/internal/REFACTOR_PROD3_HANDOFF_5.md` §3. 대상은 [`PROD3.md`](PROD3.md) §8 이 「정독하지 않은 곳」 으로 남긴 Go 영역이다.
> 이 문서는 **조사 결과**다. 고친 것은 각 행의 「처리」 에 커밋을 적는다.

## 0. 범위와 방법

- **범위:** `internal/webserver/domain/{ext,lsp,sysstat,git/store,git/jobs,telegram}` · `internal/webserver/gitapi` 의 branch·write 처리기 · `internal/shared/edgemesh/mesh.go` · `internal/daemon/chat/service.go` · `internal/shared/edge/config.go` · `internal/shared/runtime/install.go`(같은 패키지의 형제 파일 포함). PROD3 §8 의 FE 셋(`app-git.js`·`app-slots.js`·`app-ws-sync.js`)은 그 뒤 컨트롤러로 갈라져 파일이 없다 — 대상에서 뺐다.
- **방법:** 영역 넷을 읽기 전용 분석으로 나누어 비시험 파일을 모두 읽었다. 네 영역 모두 `go vet` 깨끗, `go test -race -count=1` 통과.
- **확인 열:** `✔메인` 은 이 문서를 쓴 세션이 다시 확인(재현 포함)한 것, `✔` 는 조사가 코드 경로를 끝까지 따라 확인한 것, `?` 는 추정이거나 재현하지 않은 것.
- **분류 열:** `고침` 사용자 결정 없이 고친다(결함이 사라지는 것 외에 동작이 바뀌지 않는다) · `물음` 동작이 바뀌어 사용자에게 묻는다 · `문서` 문서와 코드가 어긋난다 — 코드를 우선하고, 문서 정정은 사용자 선택을 따른다 · `둠` 고치지 않는다(이유를 적는다).
- **ID 앞머리:** `AT-EXT` 확장 팩 · `AT-LSP` · `AT-SYS` sysstat · `AT-GST` git store · `AT-GJB` git jobs · `AT-TG` telegram · `AT-GAPI` gitapi · `AT-MESH` edgemesh · `AT-CHAT` 노드 망 채팅 · `AT-ECFG` edge 설정 · `AT-INST` 런타임 설치.

## 1. 확장 팩·LSP (`domain/ext`·`domain/lsp`)

| ID | 종류 | 자리 | 현상 | 제안 | 규모 | 확인 | 분류 |
|---|---|---|---|---|---|---|---|
| AT-EXT-1 | 경로 탈출 | `ext/fetch.go:232-244,323-346` | 아카이브 링크 검사가 링크 문자열만 본다. 두 홉 링크(`b→c/..`, `a→b/..`) 뒤의 파일 `a/evil` 이 격리 칸의 부모에 쓰인다. 시험은 한 홉만 덮는다 | 아카이브의 심볼릭 링크는 상대·칸 안만 받고, 쓰기 전에 실경로가 칸 안인지 본다 | S | ✔ | 고침 |
| AT-EXT-2 | 레이스 | `ext/install.go:123-128` · `service.go:144-152` · `fetch.go:113-133` | 잠금이 팩 단위다. node 가 필요한 팩 둘을 함께 조달하면 고정 staging `dest+".new"` 를 서로 지운다 | 런타임 id 단위 잠금 | M | ✔(경로) | 고침 |
| AT-EXT-3 | 이름 충돌 | `ext/fetch.go:113-114` · `manifest.go:265` | 팩 id `X.new` 가 있으면 `X` 조달이 그 팩을 지운다 | id 에서 `.new` 꼬리를 거절 | S | ✔ | 고침 |
| AT-EXT-4 | 데이터 손실 | `ext/fetch.go:132-136` | `RemoveAll(dest)` 뒤 `Rename` 이 실패하면 옛 설치가 사라진다 | 옛 것을 비켜 두고 성공한 뒤에만 지운다 | S | ✔ | 고침 |
| AT-EXT-5 | 격리 위반 | `ext/fetch.go:88-93` | 다운로드(최대 1 GiB)를 OS 임시 디렉터리에 쓴다. FR-EXT-20·22 「칸 밖에 쓰지 않는다」 와 어긋난다 | `<root>/cache` 아래에 쓴다 | S | ✔ | 고침 |
| AT-EXT-6 | 전송 계약 | `ext/fetch.go:63` | `http.DefaultClient` 가 https→http 리다이렉트를 따른다(FR-EXT-40 은 https 만). sha256 이 무결성은 지킨다 | 리다이렉트도 https 만 | S | ✔ | 물음 |
| AT-EXT-7 | 자원 상한 | `ext/fetch.go:193-286` | 해제 총량 상한이 없다(다운로드 크기만 잰다) | 해제 누적 상한 | S | ✔ | 고침 |
| AT-EXT-8 | 잘못된 해제 | `ext/fetch.go:232-244` | tar 하드링크를 심볼릭 링크로 만들고 strip 을 적용하지 않는다 → 깨진 링크 | 하드링크는 strip 뒤 경로로 복사 | S | ✔ | 고침 |
| AT-EXT-9 | 시간 상한 무효 | `ext/install.go:74-80` | `CommandContext`+`CombinedOutput` 에 `WaitDelay` 가 없다. 자식이 파이프를 쥐면 취소해도 끝나지 않는다 | `cmd.WaitDelay` | S | ? | 고침 |
| AT-EXT-10 | 주석·정책 | `ext/install.go:299-303` · `env.go:9-10` | 주석은 「모듈 캐시는 따로 지울 수 있어야」, 코드는 빌드 캐시와 함께 GOMODCACHE 도 지운다(V-EXT-10 은 둘 다) | 정책 결정 | S | ✔ | 물음 |
| AT-EXT-11 | 기록 손상 | `ext/builtin.go:127-136` | `deployed.json` 을 원자 쓰기 없이 쓴다. 깨지면 매 기동 아무 팩도 펴지 않는다 | `platform.WriteFileAtomic` | S | ✔ | 고침 |
| AT-EXT-12 | 편집 덮어쓰기 | `ext/builtin.go:95-103` | `plugin.json` 을 쓴 뒤 기록이 실패하면 다음 기동이 사용자 편집을 덮고 지운 팩을 되살린다(FR-EXT-36) | 기록 실패 시 이번에 쓴 파일을 되돌린다 | S | ✔ | 고침 |
| AT-EXT-13 | 검증 누락 | `lsp/service.go:102-103` · `ext/locate.go:252` | `LoadPaths` 가 `SetPaths` 의 절대경로 검증을 하지 않는다. 상대경로는 검사와 실행이 다른 파일을 가리킨다 | 같은 검증(상대경로 무시) | S | ✔ | 물음 |
| AT-EXT-14 | 죽은 상수 | `ext/fetch.go:27` | `FetchTimeout` 을 아무도 쓰지 않는다(FR-EXT-18 은 `InstallTimeout` 이 맡는다) | 삭제 | S | ✔ | 고침 |
| AT-EXT-15 | 주석·검증 | `ext/manifest.go:89,173-183` | 주석은 「판이 박혀야 한다(FR-EXT-37)」, 검증은 미고정 npm 명세를 받는다 | 검증을 조이거나 주석 정정 | S | ✔ | 물음 |
| AT-EXT-16 | 중복 | `ext/install.go:308-313` ↔ `shared/diagtail` · `..` 검사 4벌 | `tailOf` 가 바이트로 잘라 한글 끝에서 U+FFFD | `diagtail.Of` 재사용 | S | ✔ | 고침 |
| AT-LSP-1 | 메모리 무제한 | `lsp/codec.go:46-52` | 헤더 한 줄을 상한 없이 읽는다 | 헤더 줄·총량 상한 | S | ✔ | 고침 |
| AT-LSP-2 | 레이스 | `lsp/service.go:142-166` | 경로표 파일 저장이 잠금 밖이다. 동시 PUT 이면 디스크와 메모리가 갈린다 | 저장·갱신을 한 구간으로 | S | ✔ | 고침 |
| AT-LSP-3 | 자식 누수 | `lsp/process.go:17,30-38` | 정지가 `Process.Kill` 뿐 — 서버가 띄운 자식이 고아로 남는다 | 프로세스 그룹 종료 | M | ? | 고침 |
| AT-LSP-4 | 레이스 가능 | `lsp/watch.go:141-155` | 시한 없는 ctx · 동시 호출이 `last` 를 덮어 중복 알림 | 저장소별 직렬화·시한 | M | ? | 둠 — 재현 없음, 영향이 중복 알림뿐 |
| AT-LSP-5 | 주석 | `lsp/service.go:31` · `httpapi/handlers_lsp.go:120-121` | 없는 「백오프·TTL 검사」 를 적는다 | 주석 정정 | S | ✔ | 고침 |
| AT-LSP-6 | 문서 | `CODEMIRROR_MIGRATION_SRS.md:911` ↔ `handlers_files_rw.go:203` | SRS 는 `go s.LSP.NotifyFiles`, 코드는 동기 호출(비차단이라 동작은 같다) | SRS 정정 | S | ✔ | 문서 |
| AT-LSP-7 | 계약 함정 | `lsp/service.go:129-132` | 팩을 지운 뒤 옛 표를 통째로 PUT 하면 400 | 모르는 키를 버린다 | S | ? | 물음 |

## 2. sysstat · git store · git jobs

| ID | 종류 | 자리 | 현상 | 제안 | 규모 | 확인 | 분류 |
|---|---|---|---|---|---|---|---|
| AT-SYS-1 | 기능 결함 | `sysstat/sampler.go:119` · `reader_darwin.go:30-34` | mach 실패 시 `Mem()` 이 Total 과 오류를 함께 주는데 샘플러가 통째로 버린다 → `CGO_ENABLED=0` darwin 빌드에서 `memTotal` 이 없다 | 부분 성공을 살린다 | S | ✔ | 고침 |
| AT-SYS-2 | 문서 | `sysstat.go:37-40` · `docs/external/api.md:22` | FR-XSY-4 의 주석 한 줄이 없다. api.md 는 `/api/stats` 키가 늘 있는 것처럼 적는다(실제는 무효 키를 뺀다, FR-STAT-7) | 문서 정정 | S | ✔ | 문서 |
| AT-SYS-3 | 문서 | `procparse.go:17,34-36` ↔ `CROSS_PLATFORM_SRS` FR-XSY-2 | 코드는 iowait 을 idle 에 더한다. SRS 에 없다 | SRS 정정 | S | ✔ | 문서 |
| AT-SYS-4 | 자원 | `mach_darwin_cgo.go:25,52,72` | 호출마다 `mach_host_self()` 포트를 얻고 놓지 않는다 | 한 번 얻어 둔다 | S | ? | 고침 |
| AT-SYS-5 | 플랫폼 | `cmd/dongminal/main.go:297` · `reader_windows.go:104-111` | Windows 에 디스크 경로 `"/"` 를 넘긴다 | `SystemDrive` | S | ? | 둠 — 이 기계에서 확인할 수 없다 |
| AT-GST-1 | 성능 | `git/store/store.go:362-379` | `gitDirs` 캐시 미스가 single-flight 가 아니다(`RepoRoot` 는 `rootFlight`) | 같은 모양으로 묶는다 | S | ✔ | 고침 |
| AT-GST-2 | 캐시 무효화 | `store.go:341-358` | `ForgetRoot` 가 `dirs` 를 지우지 않아 저장소를 다시 만들면 30초 동안 옛 경로를 읽는다 | 함께 지운다 | S | ? | 고침 |
| AT-GST-3 | 경계 | `store.go:347` | 루트(`/`)면 접두어가 `//` 가 되어 하위 항목을 못 지운다 | `filepath.Clean` 후 처리 | S | ? | 고침 |
| AT-GJB-1 | 수명 결함 | `git/jobs/job.go:388-400` · `job_run.go:79-119` | `finish` 가 판정·완료 훅(최대 15초)을 도는 동안 `Cancel` 이 true 를 돌려주지만 결과에 반영되지 않는다 — 취소 응답을 받은 잡이 성공/실패로 남는다 | `finish` 에 든 뒤의 `Cancel` 은 false | S~M | ✔ | 고침 |
| AT-GJB-2 | 성능 | `job_run.go:54-61` | 보존 상한을 넘으면 줄마다 2000개를 복사한다(잠금 안) | 여유를 두고 한 번에 자른다 | S | ✔ | 고침 |
| AT-GJB-3 | 메모리 | `job.go:449` | 구독 채널 버퍼가 보존 상한(2000줄)과 같다 — `AUDIT-go-domain.md` 미해결 항목 | 재생은 슬라이스, 버퍼는 작게 | M | ✔ | 둠 — 느린 구독자의 줄 드롭 빈도가 바뀐다. 실측 후 |
| AT-GJB-4 | 결함 | `job_run.go:20-32,94-108` | 잡 고루틴에 `recover` 가 없어 실행기 panic 이 서버를 죽인다. 복구해도 칸이 잡힌 채 남는다 | recover + 칸 비우기 `defer` | M | ? | 고침 |
| AT-GJB-5 | 문서 | `archive/GIT_SRS.md:459` FR-GIT-101 | 문서는 리포 단위 직렬, 코드는 칸(index·common) 단위(REPO_FIX 01 §5.4 의 의도된 변경) | 문서 정정 | S | ✔ | 문서 |
| AT-GJB-6 | 주석 | `job.go:415` | 철회된 FR-GIT-112(상태바)를 근거로 적는다 | 주석 정정 | S | ✔ | 고침 |
| AT-GJB-7 | 중복 | `jobs/exclusion.go:225-233` ↔ `worktree/worktree.go:154-162` · `store.go:200,298` | ctx 오류 분류가 네 벌 | `core` 에 하나 | S | ✔ | 고침 |
| AT-GJB-8 | 사소 | `jobs/exec.go:89-96` | 4096바이트에서 줄을 끊어 UTF-8 문자가 깨진다 | 룬 경계로 | S | ✔ | 고침 |

## 3. telegram · gitapi branch/write

| ID | 종류 | 자리 | 현상 | 제안 | 규모 | 확인 | 분류 |
|---|---|---|---|---|---|---|---|
| **AT-GAPI-1** | 데이터 손실 | `gitapi/handlers_git_branch.go:83-88` · `domain/git/write/branch_args.go:20-50` | 브랜치 checkout 의 이름이 ref 목록에 없으면 판정이 통과시키고, argv 에 `--` 가 없어 git 이 그 이름을 **경로**로 읽는다 → 그 파일의 커밋 안 한 변경이 확인 없이 지워진다 | argv 끝에 `--` 를 붙여 ref 로만 읽게 한다(없는 ref 는 git 이 오류) | S | ✔메인 (임시 저장소에서 `git checkout f.txt` 가 변경을 지우고 exit 0) | 고침 |
| AT-GAPI-2 | 엉뚱한 undo | `handlers_git_write.go:293-319,592-601` · `write/commit.go:61-69` | undo 토큰에 커밋 oid 가 없다. 5초 안에 터미널에서 커밋하면 그 커밋을 되돌린다 | 토큰에 HEAD oid 를 싣고 다르면 거절 | M | ✔ | 고침 |
| AT-GAPI-3 | 토큰 소모 후 실패 | `handlers_git_write.go:302-311` | 토큰을 지운 뒤 메시지 읽기가 실패하면 재시도할 수 없다 | 읽기를 먼저 | S | ✔ | 고침 |
| AT-GAPI-4 | 응답 | `handlers_git_write.go:362-370` | 쓰기 성공 뒤 재조회가 실패하면 오류 응답(주석은 의도라 적는다) | 응답 형태 결정 | S | ✔ | 물음 |
| AT-GAPI-5 | 반쪽 응답 | `handlers_git_actions_branch.go:354-359` | delete-both 에서 원격 잡 등록이 job_busy 면 로컬 삭제 결과가 응답에서 빠진다 | 응답에 함께 싣는다 | S | ? | 물음 |
| AT-GAPI-6 | 중복 | `handlers_git_branch.go:185-211` ↔ `write/branch.go:99-111` | 이름 검증·존재 확인이 처리기와 write 에서 두 번 돈다 | 한쪽만 | S | ✔ | 고침 |
| AT-GAPI-7 | 성능 | `handlers_git_branch.go:347-386` · `write/branch.go:247-268` | 삭제 대상마다 잠금 안에서 git 을 3번 이상 | for-each-ref 한 번 | M | ✔ | 둠 — 대상 수가 작다. 실측 후 |
| AT-GAPI-8 | 부분 적용 | `write/branch_args.go:104-117` | 같은 이름이 두 번 오면 첫 삭제만 적용되고 실패 | 중복 제거 | S | ? | 고침 |
| AT-GAPI-9 | 문서 | `errors.md:157` ↔ `core/guard.go:254-268` | `ref_name_invalid` 안내가 `-` 시작·`..` 를 말하지 않는다 | `codes_doc.go` 정정 후 재생성 | S | ✔ | 문서 |
| AT-GAPI-10 | 문서 | `archive/GIT_SRS.md:597` FR-GIT-157 | 「dirty 면 stash 후 진행」 선택지가 코드에 없다 | 문서 정정 | S | ✔ | 문서 |
| AT-GAPI-11 | 순서 | `write/stage.go:86,100` | Discard 의 복구 안내를 실행 전에 등록한다 | 성공 뒤 등록 | S | ? | 고침 |
| AT-TG-1 | 길이 | `telegram/render.go:30-37,124-148` · `bridge_events.go:105-134` | 질문·선택지·위치 이름에 3500자 절단이 없다 → 4096 초과면 알림이 로그 한 줄만 남기고 사라진다(FR-TGB-54) | 같은 절단 적용 | S | ✔ | 고침 |
| AT-TG-2 | 상한 단위 | `render.go:40-45` | 상한을 rune 으로 센다(Telegram 은 UTF-16) | UTF-16 단위 | S | ? | 고침 |
| AT-TG-3 | 오류 삼킴 | `bridge_events.go:120-123` | 알림 전송 실패를 버린다. 429 재시도·평문 재전송이 없다 | 1회 재시도 | M | ✔ | 물음 |
| AT-TG-4 | 오류 삼킴 | `bridge_events.go:144-169` | 버튼 걷기 실패가 추적에서도 빠져 다시 걷지 않는다(FR-TGB-58b) | 실패한 id 를 되돌린다 | S | ✔ | 고침 |
| AT-TG-5 | 응답 누락 | `bridge_updates.go:33-41` · `pair.go` Redeem | 코드를 소모한 뒤 `SetUser` 가 실패하면 첫 짝맞춤에 아무 답도 없다 | 실패 응답을 준다 | S | ✔ | 고침 |
| AT-TG-6 | 잠금 안 I/O | `bridge_events.go:106-108` | `classify`(transcript 최대 512KB 읽기)를 `b.mu` 안에서 한다(FR-RD3-40 의 취지) | 잠금 밖으로 | S | ✔ | 고침 |

## 4. 노드 망 · 채팅 · edge 설정 · 런타임 설치

| ID | 종류 | 자리 | 현상 | 제안 | 규모 | 확인 | 분류 |
|---|---|---|---|---|---|---|---|
| AT-MESH-1 | 백오프 | `edgemesh/mesh.go:567-587,304-315` | TCP·TLS 성공만으로 백오프를 1초로 되돌린다 — 붙자마자 끊기는 상대에 1초 간격으로 계속 건다 | 일정 시간 유지된 뒤에 되돌린다 | S | ✔ | 물음 |
| AT-MESH-2 | 중복 발신 | `mesh.go:686` ↔ `555-559` | `Notify` 가 `dialState` 를 거치지 않아 자동 재연결과 겹친다 | `dialState` 를 거친다 | S | ? | 고침 |
| AT-MESH-3 | 잠금 안 계산 | `edgemesh/net.go:104-227` | 망 정보마다 캐시를 지우고, 다음 조회가 `m.mu` 안에서 최악 O(N³) | 간선 집합 BFS | M | ? | 둠 — N≤256, 실측 후 |
| AT-MESH-4 | 재전달 | `edgemesh/invite.go:87-140` | 초대 기억(1024)이 가득 차면 만료 전 항목도 밀어내 옛 초대가 다시 뜬다 | 만료 전이면 새 초대를 거절 | S | ✔ | 고침 |
| AT-MESH-5 | 문서 | `docs/external/edges.md:10` ↔ `mesh.go:23,269-277` | 문서는 `/pair`·`/unpair`·`/chat`, 코드는 `/edge/v1/link`(FR-EGM-2) | 문서 정정 | S | ✔ | 문서 |
| AT-CHAT-1 | 무한 증가 | `daemon/chat/service.go:130,304-332,466-473` | 1:1 방을 만들고 나가기를 되풀이하면 `left` 가 줄지 않는다 | 상대 노드에서 방이 사라지면 지운다 | S | ✔ | 고침 |
| AT-CHAT-2 | 메시지 순서 | `service.go:406-408` · `upper.go:70-72` | 잠금 밖 전달이라 같은 참가자의 글 두 건이 뒤바뀔 수 있다(FR-PCH-32) | 노드별 직렬 전달 큐 | M | ✔(경로) | 고침 |
| AT-CHAT-3 | 생명주기 | `service.go:242-251,375` · `upper.go:15,42-73` | `Close` 뒤에도 들어온 프레임을 전달한다(주석은 받지 않는다고 적는다) | 입구에서 closed 확인 | S | ✔ | 고침 |
| AT-CHAT-4 | 성능 | `chat/view.go:47-104` | `Rooms` 가 방마다 명단 맵을 다시 만든다(O(R²), 잠금 안) | 한 번 만들어 넘긴다 | S | ✔ | 고침 |
| AT-CHAT-5 | 성능 | `service.go:497-626` | 상태 변화마다 반복 안에서 mesh 잠금 | 반복 밖에서 한 번 | S | ? | 고침 |
| AT-CHAT-6 | 상한 불일치 | `service.go:327-329` ↔ `:565` | 로컬 상대의 1:1 방은 방 수 상한(64)을 보지 않는다 | 같은 검사 | S | ✔ | 고침 |
| AT-CHAT-7 | 설계·문서 | `service.go:573,594-595` ↔ `PEER_CHAT_SRS.md:105` FR-PCH-16 | 문서는 연결 끊김을 떠남으로, 코드는 유지로 본다 | 결정 | S | ✔ | 물음 |
| AT-CHAT-8 | 중복 | `edgemesh/net.go` ↔ `chat/upper.go` · randomHex 3벌 · validID 2벌 · 키별 횟수 제한 2벌 | 같은 규칙 2~3벌 | 공유 | M | ✔ | 둠 — 별도 리팩토링 묶음 |
| AT-CHAT-9 | 신뢰 경계 | `chat/human.go:81-100` · `humancmd.go:167-181` | 신뢰하지 않은 사람 명령도 전파 목록에 넣고 퍼뜨린다(속도 제한 없음) | 설계 확인 | M | ? | 물음 |
| AT-CHAT-10 | 문서 | `PEER_CHAT_SRS.md:84` ↔ `:253` | 같은 문서에 중복 거름 기준이 둘(코드는 순서 창) | 문서 정정 | S | ✔ | 문서 |
| AT-ECFG-1 | 설정 손실 | `shared/edge/config.go:211-235,287-302` | `edges.json` 이 깨지면 빈 값으로 열고, 다음 저장이 원본을 덮는다 — 간선·도우미 키가 사라진다 | 깨진 원본을 `.bad-<시각>` 으로 비켜 두고 경고 | S~M | ✔ | 고침 |
| AT-ECFG-2 | 문서 | `config.go:99-102` ↔ `EDGE_PAIRING_SRS.md:55,98` | FR-EPR-8 은 이름에 `.` 를 허용, 코드·FR-PFN-2 는 아니다. FR-EPR-80 필드 목록에 `pending` 이 없다 | 문서 정정 | S | ✔ | 문서 |
| AT-ECFG-3 | 상한 없음 | `config.go:165-186` · `mesh.go:528-565` | 간선 수 상한이 없다 | 상한 값 결정 | S | ? | 물음 |
| AT-ECFG-4 | 내구성 | `platform/paths.go:298-331` | 원자 쓰기가 rename 뒤 디렉터리 fsync 를 하지 않는다 | POSIX 디렉터리 fsync | S | ? | 고침 |
| AT-INST-1 | 설치 정책 | `ctl/cli/doctor.go:83-87,197` ↔ `HELPER_INSTALL_SRS.md:106-116` FR-HLI-5·8 | 임시 bin 을 못 만들면 doctor 가 운영 bin 을 덮는다 | 대체 경로를 지우고 실패로 끝낸다 | S | ✔ | 고침 |
| AT-INST-2 | 상태 판정 | `runtime/install.go:64-143` | 점검이 헬퍼만 본다 — 중간 실패가 데몬 단독 기동에서 복구되지 않는다(서버는 매 기동 설치) | 점검 대상 넓히기 | S | ? | 둠 — 정상 경로 영향 작음 |
| AT-INST-3 | 잔재 | `install.go:146-149,184-185,212-228,309-320` | `dongminal-self` 복사본과 폐지된 shim 이 manifest 밖이라 남는다 | manifest 에 포함 | S | ✔ | 고침 |
| AT-INST-4 | 경로 검증 | `install.go:218-244` | manifest 줄에 `..` 이 있으면 bin 밖 파일을 지운다 | 헬퍼 이름·구분자 검사 | S | ✔ | 고침 |
| AT-INST-5 | 문서 | `HELPER_INSTALL_SRS.md:113` ↔ `install.go:274` | `CheckHelpers` ↔ `InspectHelpers` | 문서 정정 | S | ✔ | 문서 |
| AT-INST-6 | 중복 | `ctl/privhelper/secret.go:95-101` ↔ `platform.WriteFileAtomic` | 고정 tmp 이름·fsync 없음의 두 번째 원자 쓰기 | `WriteFileAtomic` | S | ✔ | 고침 |

## 5. 처리 묶음

| 묶음 | 대상(분류 「고침」) | SRS |
|---|---|---|
| ATT-1 git | AT-GAPI-1·2·3·6·8·11 · AT-GJB-1·2·4·6·7·8 · AT-GST-1·2·3 | `ATTIC_FIX_SRS` |
| ATT-2 확장 팩·LSP | AT-EXT-1·2·3·4·5·7·8·9·11·12·14·16 · AT-LSP-1·2·3·5 | 같은 문서 |
| ATT-3 telegram·sysstat | AT-TG-1·2·4·5·6 · AT-SYS-1·4 | 같은 문서 |
| ATT-4 망·채팅·설정·설치 | AT-MESH-2·4 · AT-CHAT-1·2·3·4·5·6 · AT-ECFG-1·4 · AT-INST-1·3·4·6 | 같은 문서 |

「물음」 12건과 「문서」 10건은 끝에 사용자에게 묶어서 보고한다.
