# 요구조건: Repo 탭 git 백엔드 근본 수정 — IEEE 29148 (StRS)

> 문서 상태: 승인(사용자 인터뷰 2026-09-24) · 2차(16건) — §3B · 3차(13건) — §3C · 4차(10건) — §3D · 5차(9건) — §3E · 6차(8건) — §3F · 7차(8건) — §3G · 8차(7건) — §3H · 9차(5건) — §3I · 10차(00-requirements-attack.md, 7건) — §3J, 6~10차는 메인 세션이 직접 판정, 제자리 정정 포함 · 입력 → sdd-tdd 워크플로우
> 우선순위: **§3J > §3I > §3H > §3G > §3F > §3E > §3D > §3C > §3B > §3A > §3 본문**. 3~5차 반영 시 본문·§3A·§3B 의 모순 문장은 직접 정정했다(남은 모순 없음).
> 근거: `tmp/REPO_AUDIT_2026-09-24.md`(감사), `tmp/verify-backend.md`(반증 검증·실측). 두 문서의 file:line 과 실측을 1차 근거로 삼는다.

## 1. 목적과 범위

사용자 진술: *"사용하면서 자잘한 버그가 너무 많아 사용성이 안 좋다. 전부 수정. 구조적으로, 근본적으로 수정해서 정상동작하게 해야 한다."*

- 포함: `internal/webserver/domain/git/**`(core·query·write·jobs·store), `internal/webserver/gitapi/**`, `internal/webserver/domain/worktree`(ExecUnguarded 경로), 그리고 **이 문서의 요구가 바꾸는 계약을 따라가야 하는 최소한의 프런트 변경**(쓰기 시한 상수, 느린 쓰기의 진행·취소 표시, stash 선택 모델의 oid 전환 — §3J-4, stash/show 409 화면, stash branch 이름 충돌 오류, lock 버튼).
- 비포함: gitwatch 감시자 자체(`hub/gitwatch.go` — 02 문서), LSP(02), 에디터·탐색기(03·04), git 패널·기능 프런트의 나머지 결함(05).
- 02 가 의존하는 것: 본 문서 R-3(single-flight 수명·세대)은 02 의 gitwatch 탈락 수정의 전제다. **R-3 의 공개 계약(세대 Invalidate, 호출자별 ctx 탈출, 오류 분류 sentinel)을 스펙에 명시**하라.

## 2. 근본 원인 (구조)

1. **실행 규약이 두 갈래**: `jobs/exec.go` 는 프로세스 그룹·그룹 SIGTERM·WaitDelay·유예 뒤 그룹 kill 을 쓰는데, `core.execGit`·`ExecUnguarded` 는 `exec.CommandContext` 기본(리더 SIGKILL)만 쓴다 → 훅 고아·Wait 매달림·index.lock 잔존.
2. **수명의 주인이 틀림**: 쓰기가 요청 ctx(`r.Context()`)와 읽기용 30s 시한에 묶여 있다. single-flight 는 첫 호출자 ctx 로 돌아 그 취소가 합류자 전원의 오류가 된다.
3. **무효화에 세대가 없음**: `Invalidate` 는 TTL 시각만 지우고 진행 중 flight 는 그대로 둬, 쓰기 직후 조회가 쓰기 전 관측을 받고 그것이 다시 fresh 로 저장된다.
4. **git 출력·ref 의 모호성 방치**: 사용자 설정(log.showSignature), 짧은 ref 이름, 심링크·서브모듈 모드, 절단 경계를 가정 없이 다루지 않는다.

## 3. 요구조건

각 항목은 **이전 동작 / 새 동작**을 스펙에 기록하고, 단위 테스트(정상·엣지·실패)를 먼저 작성한다(TDD). 실측으로 확인된 재현은 테스트로 옮긴다(임시 저장소).

### R-1 git 프로세스 실행 규약 단일화 (#12, N4, #26)
- R-1.1 모든 git 실행(core.execGit, ExecUnguarded — worktree·submodule·`httpapi/handlers_fs_ignored.go` 호출처 포함, jobs)은 **하나의 기동 헬퍼**를 쓴다. 헬퍼는 core(또는 그 하위)에 두고 jobs 가 그것을 쓴다.
- R-1.2 POSIX: 자식은 **새 세션(Setsid, pgid=pid)** 으로 띄운다 — 제어 터미널에서 분리되어 SSH·gpg 프롬프트로 SIGTTIN 정지하지 않고, 그룹 kill 도 동작한다. Setpgid 와 Setsid 를 함께 세우지 않는다(darwin 에서 EPERM — 실측). `platform.Process` 에 새 메서드(또는 NewGroup 의 변형)로 추가하고, 기존 `TestPosixDetachPreservesExistingAttr` 류가 두 플래그 동시 설정을 정상으로 보는 부분을 바로잡는다. **프로세스를 실제로 Start 하는 테스트**를 인수 기준에 넣는다. Windows 는 기존 플랫폼 구현(프로세스 그룹/잡 오브젝트)을 유지한다.
- R-1.3 취소·시한 시: 그룹 SIGTERM → `WaitDelay`(grace) → 그룹 SIGKILL → 파이프 회수 대기(grace). grace 는 기존 `JobKillGrace`(3s)를 core 로 옮겨 공유한다. **TERM→KILL 사이 유예 1회 + KILL 뒤 파이프 회수 대기 1회**이며, 반환 상한은 `시한 + 2×grace`(훅 자식이 파이프를 쥐어도). 정상 종료 경로를 포함한 신호 시퀀스는 §3B-9 가 확정한다.
- R-1.4 index.lock 은 **자동 삭제하지 않는다**(사용자 결정). git 이 `Unable to create '…index.lock': File exists` 로 실패하면 409 **`index_locked`**(신규 코드 — "dongminal 쓰기 진행 중"을 뜻하는 `repo_busy`·`job_busy` 와 분리)로 분류하고 응답(잡이면 잡 결과)에 lock 경로(`git rev-parse --git-path index.lock` 기준 — 링크드 워크트리 대응)와 mtime 을 싣는다. 프런트는 **`index_locked` 일 때만** 사유와 함께 확인을 거친 **"남은 lock 지우기"** 버튼을 보인다(확인문: 터미널 등 다른 git 이 실행 중이면 지우지 말 것). 서버의 삭제 종단은 그 저장소에 dongminal 의 잡·쓰기가 진행 중이면 409 로 거절하고, 그 밖에는 서버가 다시 계산한 경로 하나만 지운다. 종단 계약은 §3B-4.

### R-2 쓰기의 수명·배타 (#12, N6, 사용자 결정: "긴 상한 + 진행·취소 UI" → "잡으로 전환")
- R-2.1 **느린 쓰기는 잡으로 전환한다**. 기준은 **"새 커밋을 만들거나 체크아웃으로 HEAD 를 옮기는 명령(과 그에 준하는 장시간 작업인 worktree add)"** 이다(§3C-1): commit, merge, rebase(drop 포함), cherry-pick, revert, checkout/switch(브랜치 생성+checkout 포함 — stash branch 는 예외로 동기, §3F-1), 진행 중 작업의 출구 전부, pull, worktree add. **훅을 도는지는 기준이 아니다** — 동기 쓰기도 훅(post-checkout·post-index-change·reference-transaction)을 돌 수 있으며 쓰기 단계 마감(30s)으로 끝난다. 기존 원격 잡 경로(즉시 응답 — 현행 코드는 **200 + `{job}`**, `handlers_git_remote.go:161-177` → 스트리밍 출력 → 취소 → 최종 결과 조회)를 그대로 쓴다. 분류 주체는 핸들러이며 **종단(+action) × {잡, 동기} 분류표는 §3B-1** 이 유일한 기준이다. 그 밖의 쓰기(stage/unstage/discard, stash push/apply/pop/drop, branch/tag 생성·삭제, reset 등)는 동기로 남는다.
- R-2.2 잡 상한은 10분(기존 `jobs.RemoteOpCeiling` 을 core 로 옮겨 모든 잡이 공유). 잡은 `Service.withTimeout` 을 거치지 않으므로(`job.go:272` 의 `j.ceiling` ctx + `execStream`) **`WriteSpec` 에 시한 필드를 두지 않는다**(필드를 쓸 호출자가 없다 — 2차 검증 m1).
- R-2.3 동기 쓰기는 요청 ctx 와 분리한다: 쓰기 실행 ctx 는 **서버 수명(루트) ctx 에서 파생한, 쓰기 단계 전체에 걸린 하나의 30s 마감**이다(git 호출 수와 무관 — 요청 ctx 의 취소를 물려받지 않는다). 쓰기 뒤 재조회(status 등)도 요청 ctx 가 아니라 루트 ctx 파생 + 사후 시한으로 한다. 브라우저 abort·새로고침이 **시작된** 쓰기를 죽이지 않는다. 아직 시작하지 않은(뮤텍스 대기 중·사전 단계 중) 쓰기는 클라이언트가 떠나면 실행하지 않는다. 단계별 시한은 §3B-3.
- R-2.4 배타 키는 동기 쓰기·index 잡이 worktree 별 toplevel(현 jobs `active` 맵의 키), 비-index 잡·worktree 관련 배타가 `--git-common-dir` 이다(§3D-1). 규칙은 §3B-2 배타 행렬이다. 요지: (a) **index 잡**(pull 과 새로 잡이 된 쓰기) 진행 중 동기 쓰기 → 409 `job_busy`, fetch·push 등 **비-index 잡** 진행 중 동기 쓰기 → 허용(현행 유지), (b) 동기 쓰기 진행 중 index 잡 시작 → 뮤텍스 대기(상한 5s), 초과 시 409 `repo_busy`, 비-index 잡 시작 → 허용(현행 유지), (c) 같은 저장소의 동기 쓰기끼리는 저장소별 뮤텍스로 **직렬화**(대기 상한 5s, 초과 시 409 `repo_busy`)한다. 잡 슬롯은 **index 칸 1 + 비-index 칸 1**(§3D-1)이라, push·fetch 중에도 commit·checkout 등 index 잡을 시작할 수 있다. 같은 칸끼리는 409 `job_busy`.
- R-2.5 서버 종료 시 루트 ctx 를 취소해 진행 중 잡·쓰기를 R-1.3 규약(그룹 SIGTERM → grace → KILL)으로 끝내고, 종료 단계는 그 끝을 **최대 7s**(= 2×grace + 1s) 기다린다. §3B-10.
- R-2.6 프런트: 기존 원격 잡 UI 상태 기계를 일반화해 전환된 동작 전부가 재사용한다. 동작별 계약(시작 자리·진행 표시·입력 잠금·결과별 화면·재부착·커밋 메시지 비우는 시점)과 05 문서와의 경계는 **§3C-3** 이 확정한다. 동기 쓰기의 fetch 시한 `GIT_WRITE_FETCH_TIMEOUT_MS` 는 **35000 → 100000** 으로 올린다(서버 동기 쓰기 최악 응답 83s(stash 5종 — common-dir 잠금 대기 포함), 일반 78s 보다 확실히 길게 — §3B-3). 잡 완료 시 status 반영·undo 토스트 등 기존 후처리는 잡 결과 페이로드(§3B-5)로 유지된다.

### R-3 상태 조회 single-flight 와 캐시 (#20 전제, #22, N3, N5)
- R-3.1 flight 는 첫 호출자 ctx 가 아니라 서버 루트 ctx 파생 + 자체 시한으로 돈다(호출자 취소를 물려받지 않는다). 모든 호출자(첫 호출자 포함)는 **자기 ctx 로만** 빠져나간다.
- R-3.2 저장소 상태에 **세대(gen)** 를 둔다. `Invalidate` 는 gen 을 올린다. gen 이 다른 flight 에는 합류하지 않고, 그 결과를 fresh 로 저장하지 않는다.
- R-3.3 쓰기 응답에 실리는 status·oid 는 **쓰기 이후** 관측임이 보장된다.
- R-3.4 오류는 분류된 sentinel 로 노출한다: 저장소 소실·비저장소(결정적) vs 취소·시한·기타(일시적). 02 가 이것으로 감시 제외를 판정한다.

### R-4 사용자 git 설정 오염 차단 (#23, N2)
- R-4.1 모든 git 실행에 `log.showSignature=false` 를 강제한다. 수단은 **실행 헬퍼(R-1.1)가 argv 앞에 붙이는 전역 인자 `-c log.showSignature=false`** 다(환경변수 `GIT_CONFIG_COUNT` 방식은 쓰지 않는다 — 사용자의 `GIT_CONFIG_*` 를 덮어쓴다). 헬퍼는 인자 가드를 지난 **뒤** 실제 기동 단계에서만 붙이므로 가드는 바뀌지 않고, 기록에는 원래 argv 를 남겨 Console·replay 에 나타나지 않는다. 서명된 커밋에서 log·commit detail·부모 판정·amend 메시지가 오염되지 않는다.
- R-4.2 같은 방식으로 파싱을 깨는 다른 설정이 있는지 스펙 단계에서 조사하고(color.*, core.quotepath 등 — 이미 방어된 것은 명시), 필요한 것만 추가한다.

### R-5 ref 모호성 제거 (N1, #11)
- R-5.1 원격 브랜치·태그 삭제는 완전 이름(`refs/heads/<b>`, `refs/tags/<t>`)으로 한다. 원격에 브랜치만 있을 때 "태그 삭제"가 브랜치를 지우는 일이 없어야 한다(실측 재현을 테스트로).
- R-5.2 브랜치 Push 는 upstream 이 있으면 `<local>:refs/heads/<upstream 브랜치>` 로 upstream 에 민다. upstream 이 없으면 기존 동작(기본 원격, 같은 이름, upstream 설정)을 유지한다.
- R-5.3 태그 원격 삭제 시 `TagOid` 실패를 무시하는 경로를 없앤다.

### R-6 stash 대상 식별 (#14)
- R-6.1 stash apply/pop/drop/branch 요청은 클라이언트가 본 **oid** 를 싣는다(필수 — index 는 받지 않는다). 서버는 잠금 안에서 그 oid 의 **현재 위치를 찾아** 실행하고, 목록에 없으면 409 `stash_moved` 로 거절한다(§3F-1·§3G-2). 프런트는 목록에서 oid 를 넘기고, 409 면 목록을 다시 받아 사유를 표시한다. 미리보기(`GET /api/git/stash/show`)도 oid 로 조회한다(§3H-5).

### R-7 충돌 해결 (#24, N8)
- R-7.1 ours/theirs 선택 시 경로별로 해당 stage 존재를 판정해, 선택한 쪽이 삭제된 경로는 `git rm`, 나머지는 checkout+add 로 처리한다.
- R-7.2 한 경로의 실패가 배치의 다른 경로를 막지 않는다. 경로별 결과를 응답에 싣는다.

### R-8 diff 의 심링크·서브모듈·대용량 (#13, #25, P2 서브모듈 500)
- R-8.1 작업 트리 쪽이 심링크면(`Lstat`) 링크 문자열을 본문으로 쓴다(git 과 같은 표현). 저장소 밖 검사는 링크 자신의 위치에만 적용한다.
- R-8.2 커밋 diff 에서 gitlink(160000)는 `Kind:"submodule"` 과 커밋 oid 를 반환한다(500 금지).
- R-8.3 작업 트리 파일을 읽는 모든 diff 경로(이미지 판별 포함)는 크기를 먼저 보고 상한을 넘으면 읽지 않는다. 이미지 판별은 헤더 바이트만 읽는다.

### R-9 status 절단 경계 (P2)
- R-9.1 출력 상한 절단 시 짝을 잃은 rename(`2 …`) 레코드를 버리고 나머지를 파싱한다(FR-SAF-19 "잘려도 실패로 끝내지 않는다").

### R-10 인자 가드 정밀화 (P2)
- R-10.1 위험 접두(`-o`, `--output` 등) 검사는 옵션 위치에만 적용한다. `--` 뒤 경로와 값을 받는 플래그의 값(예: `-m <msg>`)은 제외한다. 태그 메시지는 stdin(`-F -`)으로 넘기는 방식을 검토한다.

### R-11 amend 메시지 전용 (사용자 결정: "메시지만 amend 허용", FR-GIT-84 개정)
- R-11.1 amend 가 켜져 있으면 staged 가 없어도 커밋을 허용한다(서버 판정과 프런트 버튼 판정 모두). 메시지가 직전과 같고 staged 도 없으면 "바뀔 것이 없음"으로 거절한다.
- R-11.2 기존 스펙 문서(GIT_SRS FR-GIT-84)에 개정 사실을 기록한다.

## 3A. 확정 사항 (요구조건 공격 검증 00-requirements-attack.md 반영, 2026-09-24)

아래는 위 R-* 의 모호점을 확정한다. 충돌 시 이 절이 우선한다.

- **R-3 single-flight**: flight 자체 시한 = core 조회 기본 시한(30s). 세대 비교 규칙은 §3B-11(전역 단조 카운터). 저장소당 슬롯은 "현재 세대 flight" 하나다. 세대가 바뀌면 새 요청은 새 flight 를 만들어 슬롯을 차지한다. 옛 flight 는 끝까지 돌고(시한이 상한), 그 결과는 이미 합류한 호출자에게만 돌려주며 캐시에 fresh 로 저장하지 않는다. 호출자가 모두 떠나도 flight 는 취소하지 않는다. `evictLocked` 등 슬롯 의존 코드를 이 모델에 맞춘다.
- **R-3.4 오류 분류**: 기존 sentinel 을 재사용한다. 결정적 = `ErrNotRepo`, `ErrRepoMissing`, `ErrGitMissing`. 일시적 = `ErrTimeout`, `ErrCanceled`, 그 밖의 exit 오류. `ErrUnsafeArgument`·`ErrWriteCommand` 는 status 경로에서 발생하지 않는 프로그래밍 오류로 보고 일시적으로 취급하며 로그를 남긴다(2차 보강 — `errors.go:29` 의 `kinds` 전부를 분류). 신규 sentinel `ErrIndexLocked`(§3B-4)도 일시적이다. 판정 헬퍼(예: `core.IsTerminal(err)`)를 공개한다.
- **R-4.1 설정 중립화 수단**: 환경변수(`GIT_CONFIG_COUNT`) 대신 모든 git 호출 앞에 `-c log.showSignature=false` 전역 인자를 붙인다(사용자 `GIT_CONFIG_*` 를 덮어쓰지 않고, 오래된 git 에서도 동작). 붙이는 자리는 가드를 지난 뒤의 기동 헬퍼이므로 가드(`guard.go:108` 의 전역 옵션 거부)는 그대로 둔다(2차 정정).
- **R-4.2 산출물**: 스펙에 "파싱하는 git 명령 × 출력에 영향을 주는 설정 키" 조사표를 싣는다. 판정 기준: 파싱 결과를 바꿀 수 있는 키는 이미 방어된 것(명시)을 빼고 모두 R-4.1 방식으로 중립화한다.
- **R-5.2 Push 경우별**: upstream 이 원격 R 의 브랜치 B → `push R <local>:refs/heads/B` (R 이 기본 원격이 아니어도). upstream 원격이 `.`(로컬 브랜치) → 거절하고 사유 표시. upstream 이 gone(설정은 있으나 원격 브랜치 없음) → `push R <local>:refs/heads/B` 로 다시 만든다. upstream 이 있으면 `-u` 를 다시 설정하지 않는다. upstream 이 없으면 기존 동작 유지.
- **R-6.1 stash oid**: oid 는 필수다(프런트를 같은 변경에서 갱신 — 누락 시 400). oid 확인과 실행은 **common-dir 잠금 + toplevel 뮤텍스** 안에서 한다(§3F-1 — worktree 들이 `refs/stash` 를 공유하므로). dongminal 밖(터미널)과의 경쟁 창, 그리고 §3F-1 의 autostash 한계만 허용하고 스펙에 명시한다. apply·pop·drop·branch 모두 대상이며 프런트 경로도 포함한다.
- **R-7 충돌 해결 분기**: 선택한 쪽(S = ours|theirs, git 정의 그대로 — rebase 중 의미 반전은 기존 프런트 안내문이 담당, 서버는 git 의미를 따른다)의 stage 가 없으면 `git rm`, 양쪽 삭제(DD)는 `git rm`, 그 밖(AA 포함)은 `checkout --S` + `add`. 응답에 경로별 결과 배열(`path`, `ok`, `error`)을 싣고, 프런트는 실패 경로와 사유를 노트로 표시한다(최소 변경).
- **R-8.3 수치**: 작업 트리 파일 본문 읽기 상한은 기존 diff 본문 상한(`query.DiffMaxBytes` = 1MiB, `diff.go:37`). 이미지 판별은 앞 512바이트만 읽는다(`http.DetectContentType` 규약). 이미지 미리보기 본문 상한은 §3B-12 에서 확정한다(그림 전용 Service 의 `MaxOutput()`).
- **R-9.1 일반화**: 절단 시 마지막 불완전 레코드는 종류(1/2/u/?/!)와 무관하게 버린다.
- **R-10.1 확정**: 위험 접두 검사는 `--` 앞의 옵션 위치에만 적용하고, 값 플래그 제외는 **하위 명령별 목록**으로 한정한다(§3D-2 — commit·tag 만). 태그 메시지는 `-F -` + stdin 으로 넘긴다(그 기록의 replay 는 거절 — §3C-4).
- **R-11.1 판정**: "메시지가 직전과 같다"는 두 메시지를 cleanup=strip 과 같은 정규화 한 결과로 비교한다. 정규화는 **Go 로 구현**한다(2차 정정 — `git stripspace` 는 stdin 이 필요한데 읽기 경로 `Exec` 에는 stdin 이 없고 읽기 허용 목록에도 없다): 주석 접두로 시작하는 줄 제거(접두 결정: `core.commentString`(git ≥ 2.45)이 있으면 그 문자열 → 없으면 `core.commentChar` → 미설정이면 `#`; 값이 `auto` 면 **주석 줄 제거를 하지 않는다** — git 은 auto 일 때 메시지에 없는 문자를 골라 `#` 줄을 남기기 때문, 3차 정정) → 각 줄 끝 공백 제거 → 연속 빈 줄을 하나로 → 앞뒤 빈 줄 제거. signoff 비교 규칙은 §3B-12. amend + `-a` 로 추적 파일 변경이 있으면 허용. HEAD 가 없으면 amend 불가(기존). 프런트는 기존 직전 메시지 조회 종단을 쓴다.
- **최소 git 버전**: 새 기능이 요구하는 git 최소 버전을 스펙에 명시하고 README 의 요구사항과 대조한다(`-c` 는 전 버전 지원).
- **시간 의존 테스트**: 짧은 시한(수백 ms)과 가짜 훅 스크립트로 결정적으로 만든다. POSIX 신호 의존 테스트는 build tag 로 분리하고, Windows 는 기존 jobs 테스트 수준을 유지한다(CI Windows 샤드에서 `go test` 통과).

## 3B. 확정 사항 (2차 — 00-requirements-attack.md 2차판: 주요 5·경미 11 반영, 2026-09-24)

아래는 2차 공격 검증의 16건을 해소한다. **충돌 시 §3B 가 §3A·본문보다 우선한다.** 근거 file:line 은 2026-09-24 작업 트리 기준이다.

### §3B-0 용어
- **동기 쓰기**: 요청 안에서 git 쓰기를 실행하고 결과를 응답으로 주는 종단(현행 `gitWrite.apply`·`gitWrite.exec`·`gitStashApply` 경로).
- **잡**: `jobs.Jobs` 에 등록돼 비동기로 도는 실행. 응답은 즉시 200 `{requested, repo, job}`(현행 `gitStartJob`, `handlers_git_remote.go:161-177`).
- **index 잡**: 원 저장소의 index·작업 트리·HEAD 중 하나라도 바꿀 수 있는 잡 — kind `pull, commit, merge, rebase, cherry-pick, revert, checkout, am, bisect`.
- **비-index 잡**: 그 셋을 건드리지 않는 잡 — kind `fetch, push, submodule, worktree`.
- **사전 단계**: 핸들러가 쓰기 단계 전에 하는 검사·조회(preflight, before 스냅샷, 이름 충돌, 부모 판정, stash oid 확인 등). 부작용을 남기지 않는다 — recovery hint 기록은 잡 등록 성공 뒤로 옮긴다(§3C-4). 동기 write 함수 **안에** 섞인 조회(`Unstage` 의 `HasHead`, 태그 삭제의 `TagOid` 등)는 사전 단계가 아니라 쓰기 단계에 속한다.
- **사후 단계**: 쓰기 뒤 무효화·재조회(status, stash 목록, 원격 목록 등). 잡에서는 **완료 처리**라 부르며 Done 공개 전에 돈다.
- **저장소 뮤텍스**: worktree toplevel 별 하나(§3D-1). 획득은 ctx·시한을 존중하는 방식(대기 중 취소 가능 — 채널 세마포어 등)이어야 한다.

### §3B-1 종단(+조건) × {잡, 동기} 분류표 (M1)
`gitapi/routes.go:15-114` 의 POST 종단 전수. 분류 기준은 §3C-1(커밋 생성·체크아웃 HEAD 이동·worktree add 만 잡). GET 종단은 전부 읽기이며 뮤텍스·배타 대상이 아니다. "사전" = 사전 단계 동안만 뮤텍스를 쥐고 잡 등록 직후 놓는다(§3B-2).

| 종단 | 조건 | 분류 | 잡 kind | 저장소 뮤텍스 | 근거·비고 |
|------|------|------|---------|---------------|-----------|
| `/api/git/init` | — | 동기(배타 대상 아님) | — | 없음 | 저장소가 생기기 전 — 배타 키(루트)가 없다 |
| `/api/git/repos/pin`·`unpin`·`reorder` | — | git 쓰기 아님 | — | 없음 | 핀 파일만 |
| `/api/git/stage`·`unstage`·`discard` | — | 동기 | — | 획득 | 청크 실행(stage.go:143-162)·discard 의 `checkout -q`(post-checkout flag=0)도 쓰기 단계 마감 하나 안 |
| `/api/git/resolve` | — | 동기 | — | 획득 | 부분 실패 규칙 §3B-7 |
| `/api/git/commit` | — | **잡** | commit | 사전 | 커밋 생성 |
| `/api/git/undo-last` | — | 동기 | — | 획득 | `reset --soft HEAD@{1}` — 체크아웃 없이 브랜치 끝만 옮김(reference-transaction 훅은 돌 수 있음) |
| `/api/git/records/replay` | 쓰기 기록 | 동기(현행 유지) | — | 획득 | 아래 주 ① |
| 〃 | 읽기 기록 | 동기 읽기 | — | 없음 | |
| `/api/git/fetch` | — | 잡(현행) | fetch | 없음 | |
| `/api/git/pull` | — | 잡(현행) | pull | 사전 | merge·rebase 를 포함 — **index 잡으로 새로 분류** |
| `/api/git/push` | — | 잡(현행) | push | 없음 | |
| `/api/git/job/cancel` | — | 제어 | — | 없음 | |
| `/api/git/remote/add`·`remove` | — | 동기 | — | 획득 | `.git/config` 만 |
| `/api/git/checkout` | force 포함 전부 | **잡** | checkout | 사전 | 체크아웃 HEAD 이동 |
| `/api/git/operation` | 모든 kind × continue·skip·abort | **잡** | argv[0] = merge·rebase·cherry-pick·revert·am·bisect | 사전 | continue·skip 은 커밋을 만들거나 재적용하고, abort·`bisect reset` 은 HEAD 를 되돌린다. **한 핸들러가 action 별로 200/잡을 나누지 않는다** |
| `/api/git/branch` | `checkout:false` | 동기 | — | 획득 | `branch <name>` |
| 〃 | `checkout:true` | **잡** | checkout | 사전 | `checkout -b` (branch.go:133) |
| `/api/git/branch/rename`·`delete`·`upstream` | — | 동기 | — | 획득 | |
| `/api/git/branch/merge` | — | **잡** | merge | 사전 | |
| `/api/git/branch/rebase` | — | **잡** | rebase | 사전 | |
| `/api/git/branch/push`·`branch/delete-remote` | — | 잡(현행) | push | 없음 | |
| `/api/git/branch/fetch` | — | 잡(현행) | fetch | 없음 | `fetch R b:b` — ref 만 |
| `/api/git/stash/push`·`apply`·`pop`·`drop`·`branch` | — | 동기 | — | 획득 + common-dir 잠금(§3F-1) | oid 확인 §3B-7. branch 는 HEAD 를 옮기지만 확인~실행이 한 잠금 안에서 원자적이어야 해 동기(§3F-1) |
| `/api/git/tag`·`tag/delete` | — | 동기 | — | 획득 | |
| `/api/git/tag/push`·`tag/delete-remote` | — | 잡(현행) | push | 없음 | |
| `/api/git/ignore` | — | 동기 | — | 획득 | `.gitignore` 파일 쓰기 |
| `/api/git/uncommitted/reset`·`clean` | — | 동기 | — | 획득 | |
| `/api/git/patch` | — | 동기 | — | 획득 | `apply --cached` |
| `/api/git/cherry-pick`·`revert` | — | **잡** | cherry-pick·revert | 사전 | 커밋 생성. `noCommit` 도 같은 종단이므로 잡(분기 없음) |
| `/api/git/reset` | 모든 mode | 동기 | — | 획득 | 체크아웃 없이 브랜치 끝만 옮김(reference-transaction·post-index-change 훅은 돌 수 있고 쓰기 단계 마감으로 끝남) |
| `/api/git/drop` | — | **잡** | rebase | 사전 | `rebase --onto <oid>^ <oid>` (commit_ops.go:127-131) — 커밋 재작성 |
| `/api/git/submodules/update` | — | 잡(현행, `StartUnguarded`) | submodule | 없음 | 부모 index·HEAD 불변 |
| `/api/git/submodules/sync` | — | 동기(Manager) | — | 획득 | `.git/config` 만 |
| `/api/git/worktrees/create` | — | **잡**(`StartUnguarded`) | worktree | 없음(`repoLock` 은 §3B-5 g) | 새 작업 트리에만 쓴다 |
| `/api/git/worktrees/remove` | — | 동기(Manager) | — | **대상** toplevel 획득(§3I-4·§3J-2) | 같은 저장소에 worktree 잡이 진행 중이면 409 `job_busy`(행렬 예외 — §3C-2) |
| `/api/git/lock/remove` (신규) | — | 동기 | — | TryLock(대기 없음) | §3B-4 |

주:
1. **replay** 는 현행대로 동기다. 기록 argv 가 잡 대상 명령이어도 잡으로 올리지 않는다 — Console 재실행 전용 표면이고 응답 계약(`{ok, argv, status}`)을 바꾸지 않는다. 쓰기 단계 마감(30s)을 넘으면 504 `git_timeout`. stdin 을 썼던 기록은 거절한다(§3C-4).
2. 잡으로 옮긴 종단의 응답 — 이전: 200 `{ok, partial, status, …}` / 새: 200 `{requested, repo, job}`(원격 잡과 같은 모양) / 이유: R-2.1. **실행 전 거부**(confirmation_required, branch_exists, preflight_blocked, nothing_staged, empty_message, operation_mismatch, no_operation, merge_parent_required, stash_moved, 400 인자 오류 등)는 현행 코드·본문 그대로 **동기 응답**한다.

### §3B-2 배타 행렬 (M4 — 메인 결정 반영)

| 진행 중 ↓ \ 새 요청 → | 동기 쓰기 | index 잡 시작 | 비-index 잡 시작 |
|------|------|------|------|
| 없음 | 실행 | 실행 | 실행 |
| 동기 쓰기(같은 toplevel 뮤텍스 보유) | 대기 ≤5s → 초과 409 `repo_busy` | 대기 ≤5s → 초과 409 `repo_busy` | 실행(현행) |
| index 잡(같은 toplevel) | 409 `job_busy`(즉시 — 대기 없음) | 409 `job_busy` | **실행(동시)** — pull 은 예외(§3D-1) |
| 비-index 잡(같은 common dir) | 실행(현행) | **실행(동시)** — pull 은 예외 | 409 `job_busy`(현행 FR-GIT-101) |

판정 순서:
1. **동기 쓰기**: ① 같은 toplevel 의 index 칸 확인 — 있으면 즉시 409 `job_busy` → ② 뮤텍스 획득(≤5s; 요청 ctx 취소 시 중단·미실행) → ③ index 잡 재확인 — 대기 중 등록됐으면 반납 후 409 `job_busy` → 사전 단계(요청 ctx) → ④ **쓰기 단계 직전 요청 ctx 확인** — 이미 떠났으면 반납·미실행 → 쓰기 단계(루트 ctx, 마감 하나) → 사후 단계 → 반납 → 응답.
2. **index 잡 시작**: ① index 칸(pull 은 비-index 칸도) 확인 — 있으면 409 `job_busy` → ② 뮤텍스 획득(≤5s) → ③ 칸 재확인 → 사전 단계 → ④ 요청 ctx 확인 → 잡 등록(`active` 기록) → 반납 → 등록 성공 뒤 부작용(recovery hint 기록) → 200 `{job}`. 잡의 실행·완료 처리 동안은 뮤텍스를 쥐지 않는다 — `active` 등록이 동기 쓰기를 막는다(행렬 3행).
3. **비-index 잡 시작**: 같은 common dir 의 비-index 칸만 확인(뮤텍스 없음). 칸이 달라 index 잡의 사전 단계와 서로 막지 않는다. worktree 잡의 등록 실패 정리는 §3C-2.
4. 뮤텍스와 두 칸 판정은 한 패키지(jobs 또는 그 옆)에 둔다.
5. **행렬 예외**: worktree remove 는 판정 1①~③ 대신 §3I-4·§3J-2 순서를 따른다(요청 worktree 의 칸·뮤텍스는 보지 않는다). 같은 common dir 에 worktree 잡이 진행 중이거나 지울 대상 worktree 의 index 칸이 진행 중이면 409 `job_busy`.
6. **stash push·apply·pop·drop·branch** 는 ② 앞에 common-dir 잠금(≤5s)을 먼저 잡는다(§3F-1).

이전/새 동작:
- 이전: 동기 쓰기는 잡을 보지 않았다(`ErrJobBusy` 는 원격 핸들러만 — `handlers_git_remote.go:164-185`). pull 중 stage·commit 이 가능했고, 동기 쓰기끼리 배타가 없어 같은 저장소의 두 쓰기가 index.lock 을 두고 경합했다.
- 새: 위 표. fetch·push·submodule update·worktree add 중 동기 쓰기와 index 잡(commit·checkout·merge 등 — 현행에서 동기라 가능했던 동작)은 계속 허용된다(§3D-1). pull 중 동기 쓰기는 409 `job_busy` 가 된다.
- 이유: index 를 함께 쓰는 두 실행을 막는 것이 index.lock 경합·부분 적용의 원인 제거이고, index 와 무관한 원격 잡까지 막으면 10분짜리 push 동안 stage 가 막히는 사용성 퇴행이 된다.

### §3B-3 시간 예산 (M5 — 메인 결정 반영)

| 단계 | 마감(단계 전체에 하나) | ctx 부모 | 초과·이탈 시 |
|------|------|----------|--------------|
| 뮤텍스 대기 | **5s** | 요청 ctx | 409 `repo_busy`. 요청 ctx 취소면 미실행(응답 불요, 로그만) |
| 사전 단계(핸들러 조회 합산) | **10s** | 요청 ctx | 504 `git_timeout` — 쓰기 미실행 |
| 쓰기 단계(write 함수 전체 — 청크·다단계 실행과 함수 안 조회 포함) | **30s** (`core.DefaultTimeout`) | 서버 루트 ctx | 504 `git_timeout` + 부분 적용 판정(FR-GIT-73) |
| 사후 단계(재조회 합산) | **15s** | 서버 루트 ctx | 현행 규칙(쓰기 성공 + 재조회 실패 = 실패 응답, `handlers_git_write.go:258-263`) |

- **단계 마감 규칙**: 각 단계는 마감 ctx 하나를 만들고 그 안의 모든 git 실행이 그것을 쓴다(`Service.withTimeout` 의 "호출자 마감이 짧으면 그것" — exec.go:127-132 — 이 받쳐 준다). 마감 뒤에는 새 git 실행을 시작하지 않는다. 정리 대기(§3B-9)는 단계 마감 + 2×grace 를 넘지 않는다 → **단계 절대 상한 = 마감 + 6s, 호출 수와 무관**.
- 핸들러 최악 응답 = 5 + (10+6) + (30+6) + (15+6) = **78s**, stash 5종은 common-dir 잠금 대기 5s 가 더해져 **83s**(§3E-3). 둘 다 프런트 `GIT_WRITE_FETCH_TIMEOUT_MS`(constants-git-detect.js:55) **100000**(35000 에서 변경, 최소 여유 17s) 보다 짧다.
- 잡을 여는 종단: 뮤텍스 대기 + 사전 단계만 동기(최악 5+16 = 21s). 프런트는 현행대로 `timeout:0`(web/js/git/api.js:137-139 규약).
- **Manager 경유 동기 쓰기**(worktree remove, submodule sync): Manager 의 git 실행은 호출자 ctx 를 받는다(현행 `context.Background()` — worktree.go:205, submodule.go:324 — 대체). gitapi 는 루트 ctx 파생 + 단계 마감 **180s**(현행 `opTimeout` 을 호출당이 아니라 단계 마감으로 재해석)를 넘긴다. 위 78s 의 **예외**이며 뮤텍스 대기(5s)는 같다. 프런트는 이 두 호출에 `timeout:0` — 이전: 35s 에 끊겨 서버는 계속 실행하는데 화면은 실패로 읽음 / 새: 서버 응답까지 기다림(최악 worktree remove 207s — §3J-2, submodule sync 191s — §3D-7) / 이유: R-2.6 원칙. Run 격리 호출자와 Runner 시그니처는 §3C-2·§3D-7.
- **클라이언트 이탈**: 뮤텍스 대기·사전 단계 중 요청 ctx 가 취소되면(쓰기 단계 직전 확인 포함) 쓰기를 실행하지 않는다. 쓰기 단계가 시작된 뒤의 이탈은 무시하고 사후 단계까지 끝낸다(응답 쓰기 실패는 로그만).
- 5s·10s·15s 상수는 한 곳(core 또는 gitapi)에 이름 붙여 둔다. 이름은 스펙이 정한다.

### §3B-4 lock 실패 코드와 삭제 종단 (M3 — 메인 결정 반영)

| 코드 | HTTP | 뜻 | "남은 lock 지우기" 버튼 |
|------|------|----|------|
| `index_locked` (신규) | 409 | git 이 index.lock 을 만들지 못했다 — 다른 git(터미널 등)이 실행 중이거나 남은 lock | **보인다** |
| `repo_busy` (신규) | 409 | dongminal 의 동기 쓰기가 같은 저장소에서 진행 중이어서 대기 상한(5s)을 넘겼다 | 안 보인다 |
| `job_busy` (현행) | 409 | dongminal 의 잡이 같은 칸(§3D-1)에서 진행 중 | 안 보인다 |

판정:
- sentinel `core.ErrIndexLocked` 신설. `core.classify`(errors.go:57)가 소문자 stderr 에 `unable to create '` 와 `index.lock': file exists` 가 **함께** 있으면 이것으로 분류하고 `kinds`(errors.go:29)에 더한다. 다른 `.lock`(HEAD.lock, refs/…lock, config.lock)은 본 문서 범위 밖 — 현행대로 `git_failed` + stderr tail.
- lock 정보: `lockPath` = `git rev-parse --git-path index.lock`(상대 경로면 저장소 루트 기준 절대화), `lockMtimeUnixMs` = `Lstat` mtime(ms). 판정 시점에 파일이 없으면 `lockMtimeUnixMs` 를 싣지 않는다(프런트는 버튼 대신 "다시 시도" 안내).
- 동기 쓰기: **모든** 동기 쓰기 실패 응답에 `lockPath`·`lockMtimeUnixMs` 를 덧붙인다 — 적용 범위·방법은 §3D-6(apierr 테이블은 status·code 만 정한다).
- 잡: 완료 처리에서 같은 판정을 해 Job 에 `errorCode:"index_locked"`, `lock:{path, mtimeUnixMs}` 를 싣는다(§3B-5 e).

삭제 종단 `POST /api/git/lock/remove`:
- 본문 `{repo, confirm, mtimeUnixMs}`. **경로 필드를 받지 않는다** — 서버가 `repo` 를 정규 루트로 푼 뒤 위 규칙으로 다시 계산한다.
- 절차: `beginWrite` → `requireConfirm(true, confirm)` → `resolve` → 잡 확인(그 toplevel 의 index 칸 또는 그 common dir 의 비-index 칸에 잡이 있으면 409 `job_busy`) → 뮤텍스 **TryLock**(실패 409 `repo_busy`) → 경로 재계산 → 검사(파일명이 정확히 `index.lock`, `Lstat` 이 일반 파일 — 심링크·디렉터리면 400 `bad_request`, 경로가 `--git-dir` 또는 `--git-common-dir` 하위) → 파일이 없으면 200 `{ok:true, removed:false, lockPath}`(멱등) → 현재 mtime(ms) ≠ 요청 `mtimeUnixMs` 면 409 `stale_observation`(사용자가 본 lock 이 아니다 — 그 사이 다른 git 이 새로 잡았다) → `os.Remove` → status 캐시 무효화 → 200 `{ok:true, removed:true, lockPath}`.
- 파괴적 정책: `core.ActionIndexLockRemove = "index_lock_remove"` 를 `DestructiveActions`(destructive.go)에 더해 `/api/git/policy` 가 노출한다(FR-GIT-89). 되살릴 값이 없으므로 recovery hint 는 없다. git 실행이 아니므로 실행 기록 대신 서버 로그에 경로·mtime 을 남긴다.
- 거절 코드 요약: 400 `confirmation_required`, 400 `bad_request`, 409 `job_busy`, 409 `repo_busy`, 409 `stale_observation`.
- 프런트: 버튼은 `index_locked` 응답·잡 결과에서만. 확인 다이얼로그에 lockPath·mtime(상대 시각)과 R-1.4 확인문을 보인다. 성공 뒤 status 재수집, 원래 동작은 자동 재시도하지 않는다.

### §3B-5 잡 확장 계약 (M2 — 메인 결정 반영)

**(a) 허용 kind 와 모양.** `jobKinds`(job.go:68)를 아래로 바꾼다. `Start` 는 kind 가 표에 있고 `argv[0]==kind` 이며 모양 제약을 만족할 때만 받는다(위반은 `ErrJobKind`). argv 는 기존 `*Args`/`*Spec` 순수 함수로 만든다(판정 두 벌 금지).

| kind | 진입 | 모양 제약 | index 잡 |
|------|------|-----------|----------|
| fetch, push | Start | 현행 | 아니오 |
| pull | Start | 현행 | 예 |
| commit | Start | `commit.go:43-58` 이 만드는 형태, 메시지는 stdin | 예 |
| merge | Start | `MergeArgs` 결과 또는 `merge --continue\|--abort` | 예 |
| rebase | Start | `RebaseArgs`·`DropArgs` 결과 또는 `rebase --continue\|--skip\|--abort` | 예 |
| cherry-pick, revert | Start | `PickArgs` 결과 또는 `--continue\|--skip\|--abort` | 예 |
| checkout | Start | `CheckoutArgs` 또는 `BranchCreateArgs(Checkout:true)` 결과 | 예 |
| am | Start | `am --continue\|--skip\|--abort` (guard 가 이미 한정 — write.go:177-180) | 예 |
| bisect | Start | `bisect reset` | 예 |
| submodule | StartUnguarded | 현행 | 아니오 |
| worktree | StartUnguarded | `worktree add …` 만 | 아니오 |

`StartUnguarded` 는 kind ∈ {submodule, worktree} 만 받는다(현행은 kind 제한 없음 — job.go:248-262).

**(b) stdin.** `JobRunner`(job.go:123)가 stdin 을 받는다. `WriteSpec.Stdin` 이 비어 있지 않으면 자식 stdin 으로 넣고, 비어 있으면 파이프를 만들지 않는다(exec.go:156-159 와 같은 규약). 내용은 Job JSON·줄 스트림·기록 어디에도 싣지 않는다 — 기록은 바이트 수만(`finish` 가 이미 `Stdin` 을 `RecordWrite` 에 넘긴다, job_run.go:129-130).

**(c) 사전 단계 위치 — 잡 등록 전, 뮤텍스 안.** 잡이 되는 종단의 **현행 핸들러가 apply 전에 하던 일 전부**: commit 의 메시지 검사·preflight 재검사(FR-GIT-86, handlers_git_write.go:144-167)·before 스냅샷·nothing-staged 및 R-11 amend 판정(:168-177), checkout·branch 의 이름 충돌(`gitBranchNameTaken`), pick 의 부모 판정(`gitCommitParents`), drop 의 부모 수·headOid, operation 의 종류 일치(`operation_mismatch`/`no_operation`, handlers_git_operation.go:55-66). rebase·drop 의 recovery hint(branch.go:470, commit_ops.go:202)는 값(headOid)만 사전 단계에서 구하고 **기록은 잡 등록 성공 뒤**에 한다(등록 실패 시 남길 부작용이 없게). write 함수가 사전 조회와 실행을 한 몸으로 가진 경우(`write.Pick`·`Checkout`·`BranchCreate`·`Rebase`·`Drop`)는 사전 부분과 argv 생성을 분리해 핸들러 사전 단계가 부르고 실행만 잡이 한다. Destructive 선언은 기존 write 함수의 선언을 그대로 옮긴다.

**(d) 완료 처리.** 잡 등록 시 호출자가 완료 처리를 넘길 수 있고, 그 결과가 Job 의 `result` 로 실린다. 내부 순서·ctx(루트 취소 연동, 7s 우선)·종료 중 동작은 **§3D-4**. 완료 처리 실패는 잡의 성패(exit)를 바꾸지 않고 `result.statusError` 로만 싣는다. 잡은 완료 처리가 끝날 때까지 자기 칸에 남는다(index 칸이면 그동안 동기 쓰기는 `job_busy`).

**(e) Job JSON 확장** (추가 필드, 모두 `omitempty`; `Kind` 주석 job.go:95 는 (a) 목록으로 갱신):

| 필드 | 타입 | 채우는 때 |
|------|------|-----------|
| `slots` | []string | 항상 — 차지한 칸(`"index"`·`"common"`, pull 은 둘 다). kind 에서 서버가 파생(§3E-2). 프런트 잠금 판정의 유일한 출처 |
| `errorCode` | string | 분류된 실패만: `server_shutdown`(최우선, §3D-4), `index_locked`, `git_timeout`(상한 초과). 그 밖엔 비움 |
| `lock` | `{path, mtimeUnixMs}` | `errorCode=index_locked` |
| `result.status` | query.Status | index 잡 전부(성공·실패 모두). 쓰기 이후 관측(R-3.3) |
| `result.statusError` | string | 사후 재조회 실패 사유 |
| `result.partial`·`result.changed` | bool·[]string | 실패 시 before 대비 변화(FR-GIT-73 — `gitApply` 와 같은 판정) |
| `result.oid` | string | commit 성공 시 HEAD oid |
| `result.undoToken` | string | commit 성공 시 |
| `result.path`·`result.branch` | string | worktree 잡 성공 |

**(f) undo 5초 창.** 토큰은 commit 잡이 exit 0·비취소로 끝났을 때 **완료 처리의 마지막 단계(사후 재조회 뒤, Done 공개 바로 앞 — §3D-4 ⑦)** 에서 `gitUndo.issue` 로 발급한다. 창(`write.UndoTTL` 5s)의 기점은 그 발급 시각이다. 클라이언트 수신 지연은 창을 늘리지 않는다 — 늦게 받은 토큰의 undo 는 현행대로 409 `undo_expired`. 프런트는 `done` 이벤트의 `result.undoToken` 을 받는 즉시 토스트를 띄운다(`GIT_UNDO_MS` 5000).

**(g) worktree add.** 도메인이 `submodule.UpdateSpec` 과 같은 모양의 순수 함수(검증 `validRef`·`checkPath`, argv, 사유)를 내고 핸들러가 `StartUnguarded(kind "worktree")` 로 띄운다. 사전 단계·`repoLock` 보유 범위·등록 실패 시 정리·완료 처리(best-effort config 2건, worktree.go:353·357)·Run 격리 영향은 **§3C-2**. 상한 — 이전: git 1회 180s(opTimeout), 취소 불가 / 새: 잡 상한 10분 + 취소 가능.

**(h) 원격 전용 판정 한정.** `authPatterns`·`rejectPatterns`·`Options`(job_run.go:99-105)는 kind ∈ {fetch, pull, push} 에서만 판정한다(훅 출력의 "permission denied" 등 오판 방지). 취소 문구(job_run.go:91 "원격에 일부가 적용됐을 수 있다")는 원격 kind 에만 쓰고, 그 밖은 "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라".

**(i) 충돌로 멈춘 잡.** merge·rebase·cherry-pick·revert·operation continue 가 충돌로 exit≠0 이면 잡은 실패로 끝나되 `result.status.operation.kind` 가 채워진다. 프런트는 그것이 있으면 실패가 아니라 "진행 중(충돌)"으로 표시한다(현행 동기 응답의 FR-GIT-251 규약과 같다).

**(j) 결과 조회.** 현행 `/api/git/job/events` 의 `done` 이벤트(보존 `JobRetention` 5분)가 최종 Job 을 싣는다. 새 조회 종단은 만들지 않는다. `/api/git/jobs`(진행 중만)에는 result 가 없다.

**(k) 프런트.** kind 라벨 `GIT_REMOTE_LABEL`(web/js/core/constants-git-remote.js:15)에 새 kind 를 더한다(이름을 일반화할지는 스펙). 화면 계약 전체는 §3C-3.

### §3B-6 apierr 등록 (M3·m7)

| 코드 상수 | 값 | HTTP | sentinel | 비고 |
|-----------|----|------|----------|------|
| `CodeRepoBusy` | `repo_busy` | 409 | `jobs.ErrRepoBusy`(신규 — 뮤텍스 대기 초과·TryLock 실패) | |
| `CodeIndexLocked` | `index_locked` | 409 | `core.ErrIndexLocked`(신규) | lock 필드는 핸들러·잡이 덧붙임. tables.go 의 core 일반 규칙보다 **앞** |
| `CodeStashMoved` | `stash_moved` | 409 | `write.ErrStashMoved`(신규) | §3B-7 |
| `CodeResolvePartial` | `resolve_partial` | 409 | 없음 — 경로별 결과를 실어야 해 핸들러가 직접 | §3B-7 |

모두 codes.go 상수, **codes_core.go `gitCodes`(81-94 — `AllCodes()`·`TestAllCodesDeclared` 의 단일 목록)**, codes_doc.go 사용자 문구·조치, tables.go 규칙(sentinel 있는 것), inventory.go `Inventory`(신규 sentinel 셋), apierr_test.go 목록에 등록한다.

### §3B-7 stash oid 불일치 · 충돌 해결 부분 실패 (m7)
- stash 대상 oid 가 목록에 없음(§3G-2 — 위치 이동은 불일치가 아니다): 409 `stash_moved`. 본문에 현재 `stashes` 목록과 `status` 를 싣는다(프런트가 다시 받지 않아도 되게). oid 누락·index 필드 존재는 400 `bad_request`(§3A·§3G-2).
- 충돌 해결: 전 경로 성공 → 200 `{ok:true, results, status}`. 하나라도 실패 → 409 `resolve_partial`, 본문 `{error, message, requested, repo, results:[{path, ok, error}], status, partial}` — `partial` 은 성공한 경로가 하나라도 있으면 참. 실행 전 거부(side·paths 검사, confirm)는 현행 400. 마감 초과·`index_locked` 우선순위는 §3D-5.

### §3B-8 뮤텍스 적용 범위 (m5)
- 적용: §3B-1 에서 "획득"인 모든 동기 쓰기 — `gitWrite.apply`·`gitStashApply`·`gitWrite.exec`(worktree remove, submodule sync — `ExecUnguarded` 쓰기 포함). index 잡은 사전 단계~잡 등록까지("사전"). 잡 사전 단계와 잡 시작 사이의 창은 뮤텍스가 덮는다.
- 미적용: GET 전부, init, 핀, job/cancel, 비-index 잡 시작, gitwatch·status 폴링, `httpapi/handlers_fs_ignored.go` 의 check-ignore(읽기).
- 기존 worktree 패키지 `repoLock`(FR-WKT-7, worktree.go:118)은 병존하되 ctx 를 존중하는 획득으로 바꾼다(§3C-2). 잠금 획득 순서는 전역으로 **common-dir 잠금 → toplevel 뮤텍스 → `repoLock`** 이다(역순 금지). worktree remove 는 요청 toplevel 이 아니라 **대상** toplevel 뮤텍스 하나만 잡는다(§3I-4·§3J-2) — 둘 이상의 toplevel 을 잡는 경로는 없다.

### §3B-9 신호 시퀀스 (m2)
기동 헬퍼는 버퍼 수집·스트리밍 모두 stdout·stderr 에 `os.Pipe` 를 쓴다(`Wait` 가 파이프를 기다리지 않게 — 현행 jobs 규약, jobs/exec.go:41-43). G = grace 3s.

A. 시한·취소 경로(t0 = ctx done):
1. t0: 그룹 SIGTERM(`cmd.Cancel`).
2. 리더 종료 대기 최대 G(`WaitDelay`=G — 넘으면 Go 가 리더만 SIGKILL).
3. 리더 종료 즉시(≤ t0+G): 그룹 SIGKILL(무조건, ESRCH 무시) — 남은 훅 자식 정리.
4. 파이프 EOF 대기 최대 G. 넘으면 부모 쪽 읽기단을 닫고 읽기 고루틴을 버린다(스스로 setsid 한 데몬 등 그룹 밖 손자 대비).
5. 반환 ≤ t0 + 2G. 오류는 현행 분류(ErrTimeout/ErrCanceled).

B. 정상 종료 경로(t1 = 시한 전 리더 종료):
1. 파이프 EOF 대기 최대 G.
2. EOF 가 안 오면 그룹 SIGKILL → 다시 최대 G → 넘으면 읽기단을 닫는다.
3. 반환 ≤ min(t1 + 2G, 단계 마감 + 2G). exit 코드는 리더의 것(성공은 성공). 대기 중 단계 마감이 오면 남은 대기를 단계 마감 + 2G 에서 자른다 — 한 단계의 정리 대기 총량이 호출 수와 무관하게 상한을 갖는다(§3B-3).
4. 동작 변경 — 이전: 출력을 리다이렉트하지 않은 훅의 백그라운드 자식(예: post-checkout 의 `ctags … &`)이 파이프를 쥐면 요청이 그 자식이 끝날 때까지 매달렸다 / 새: 리더 종료 3s 뒤 그룹 SIGKILL 로 그 자식이 끝난다 / 이유: 요청이 끝나지 않는 매달림 제거. 스펙에 한계로 명시한다("출력을 리다이렉트하지 않은 백그라운드 훅 자식은 종료된다 — 오래 도는 훅 작업은 `>/dev/null 2>&1 &` 로 분리해야 한다").

- 이 시퀀스는 core 기동 헬퍼 하나가 가지며 jobs `execStream` 의 현행 "유예 뒤 Kill"(jobs/exec.go:97-103)을 대체한다.
- Windows: 그룹 = Job Object, SIGTERM = Ctrl+Break, SIGKILL = `TerminateJobObject`(현행 process_windows.go) — 단계·상한은 같다. 읽기 경로 분기는 §3C-4.

### §3B-10 서버 루트 ctx·종료 (m4)
- GitServer·jobs·store flight 는 서버 수명 ctx 를 받는다. 동기 쓰기(Manager 경유 포함 — §3B-3)·사후 단계·잡 상한 ctx(현행 `context.Background()` — job.go:272)·flight·잡 완료 처리 ctx 는 모두 그 파생이다(완료 처리는 잡 ctx 와 별개의 루트 파생 — §3D-4).
- 종료: 루트 ctx 주입 지점과 `shutdownSteps` 삽입 위치(인덱스 0, "마커" 앞, HTTP 수신 중단 뒤)는 **§3E-5**. 대기 **최대 7s**(2G+1s), 초과 시 로그만 남기고 진행한다.
- 종료로 끊긴 잡·동기 쓰기의 코드는 §3D-4(`server_shutdown`).

### §3B-11 세대 ABA (m3)
- gen 은 Store 전역의 **단조 증가 uint64 카운터**에서 받는다(0 재사용 없음). `Invalidate` 와 repoState **생성** 모두 새 값을 받는다.
- flight 는 생성 시 (repoState 포인터, gen)을 기억한다. 완료 시 `states[repo]` 가 같은 포인터이고 gen 이 같을 때만 fresh 로 저장한다 — `evictLocked`(store.go:302-315) 뒤 재생성된 state 와 gen 이 우연히 같아지는 일이 없다.

### §3B-12 그 밖의 확정 (m1·m6·m8·m9·m10·m11)
- **m1 WriteSpec 시한**: 두지 않는다(R-2.2 정정). 상수 이동만 한다 — `jobs.RemoteOpCeiling` → core `JobCeiling`(10분), `jobs.JobKillGrace` → core `KillGrace`(3s). jobs 쪽 참조는 전부 교체(별칭 없음).
- **m6 Setsid 동작 변경**: 데몬 모드는 이미 `Detach`(Setsid)로 떠 제어 터미널이 없다(cmd/dongminal/main.go:133, internal/ctl/cli/start.go:349) — 변화 없음. **포그라운드 모드만** 바뀐다. 이전: git 이 서버의 터미널을 물려받아 pinentry-tty/curses·ssh 암호 프롬프트가 그 터미널에 뜨거나 SIGTTIN 으로 정지 / 새: 터미널이 없어 그 프롬프트는 즉시 실패(서명 커밋·ssh 키 암호에는 GUI pinentry·ssh-agent 필요) / 이유: 정지·매달림 제거(R-1.2). 스펙에 이 기록을 싣는다.
- **m6 Windows 성능**: §3C-4 로 대체(두 분기 정의 + 스펙 단계 벤치 확정).
- **m8 이미지 상한**: 작업 트리 쪽 이미지 본문 읽기(`SideBytes` 의 `os.ReadFile`, diff_image.go:103)는 그림 전용 Service 의 `img.MaxOutput()` 을 상한으로 쓴다 — 배선값 `httpapi.fileReadMaxBytes` = 10MiB(httpapi/file_boundary.go:30, server.go:275). 새 상수는 만들지 않는다. `Stat` 크기가 상한을 넘으면 읽지 않고 `ErrDiffTooLarge`(413). 판별(`ImageMimeOf`)은 작업 트리 쪽을 앞 512바이트만 읽는다.
- **m9 R-8.2 적용 축**: gitlink 판정을 `diffBlobSide`(diff.go:139)에 둔다 → index(`:p`)·HEAD(`HEAD:p`)·커밋(`<oid>:p`) 쪽을 읽는 **모든 축**(worktree-index, worktree-head, index-head, commit-parent)에 적용된다. 판정은 **`cat-file -s` 가 실패하고 그 실패가 `diffAbsent` 가 아닐 때만** 1회 한다(정상 파일의 hot path 에 git 호출을 더하지 않는다 — 3차 정정). 인자: `diffBlobSide` 의 rev 를 `:<p>`(index) 또는 `<treeish>:<p>`(첫 `:` 에서 분리)로 나눈다. tree-ish 쪽은 `ls-tree <treeish> -- <p>`, index 쪽은 `ls-files -s -- <p>` 의 모드가 160000 이면 `Kind:"submodule"`, `Oid` = 그 항목 oid. `ls-tree` 를 읽기 허용 목록(guard.go:19)에 더한다(순수 읽기, 쓰기 목록과 교집합 없음). 작업 트리 쪽이 디렉터리이고 반대쪽이 submodule 이면 작업 트리 쪽도 `Kind:"submodule"`(Oid 비움). `DiffSide.Kind` 주석(diff.go:61)을 갱신한다. 한계: 상위 저장소 객체 저장소에 같은 커밋 객체가 있어 `cat-file` 이 성공하는 드문 경우는 현행 경로(스펙에 명시).
- **m10 signoff amend 비교**: 비교 대상은 **요청 메시지(트레일러 추가 전)** 와 직전 메시지, 둘 다 §3A 정규화. 예외: signoff 가 켜져 있고 직전 메시지에 `Signed-off-by:` 로 시작하는 줄이 없으면 "바뀔 것이 있음"(git 이 트레일러를 더한다)으로 보고 허용한다. 서명자 신원 일치까지는 보지 않는다(스펙에 한계 명시).
- **m11**: `ErrWriteCommand` 는 §3A R-3.4 에 추가했다(일시적 + 로그). R-4.1 본문은 `-c` 로 정정했다.

### §3B-13 추적 (2차 지적 → 해소 위치)

| 지적 | 해소 |
|------|------|
| M1 분류표 | R-2.1, §3B-1 |
| M2 잡 계약 | §3B-5 |
| M3 lock 코드·삭제 종단 | R-1.4, §3B-4, §3B-6 |
| M4 배타 행렬 | R-2.4, §3B-2 |
| M5 시간 예산 | R-2.3, R-2.6, §3B-3 |
| m1 WriteSpec 시한 | R-2.2, §3B-12 |
| m2 신호 시퀀스 | R-1.3, §3B-9 |
| m3 gen ABA | §3B-11 |
| m4 루트 ctx·종료 | R-2.5, §3B-10 |
| m5 뮤텍스 범위 | §3B-8 |
| m6 Setsid·Windows | §3B-12 |
| m7 stash·resolve 코드 | §3B-6, §3B-7 |
| m8 이미지 상수 | §3A R-8.3, §3B-12 |
| m9 R-8.2 축 | §3B-12 |
| m10 signoff | §3B-12 |
| m11 ErrWriteCommand·R-4.1 | §3A R-3.4, R-4.1 |

## 3C. 확정 사항 (3차 — 00-requirements-attack.md 3차판: 주요 4·경미 9 반영, 2026-09-24)

충돌 시 §3C 가 우선한다. 3차 지적 중 기존 절을 고치면 되는 것은 그 자리(§3B-0·2·3·5·8·9·10·12, §3A, 본문)를 직접 정정했고, 여기에는 새 결정만 둔다. 추적은 §3C-5.

### §3C-1 잡/동기 분류 기준 (M2)
- **잡** = ① 새 커밋을 만드는 명령(commit, merge, rebase·drop, cherry-pick, revert, 진행 중 작업의 continue·skip) ② 체크아웃으로 HEAD 를 다른 브랜치·커밋으로 옮기는 명령(checkout, `checkout -b`, 진행 중 작업의 abort, `bisect reset`) ③ 둘을 포함하는 pull ④ 그에 준하는 장시간 작업인 worktree add. 판정은 **종단 단위**다(같은 종단의 변형 — revert `noCommit`, merge fast-forward — 도 잡).
- **동기** = 그 밖의 쓰기. reset·undo-last 는 체크아웃 없이 브랜치 끝만 옮기므로 동기다. **예외: stash branch** 는 HEAD 를 옮기지만 동기다 — stash 위치 확인과 실행이 한 잠금 안에서 원자적이어야 하기 때문이다(§3F-1).
- 훅은 기준이 아니다: discard(`checkout -q -- <paths>`, stage.go:105)·resolve(`checkout --ours|--theirs`, resolve.go:42)는 post-checkout(flag=0)을, 모든 ref 갱신은 reference-transaction(git ≥ 2.28)을, index 기록은 post-index-change 를 돌 수 있다. 동기 쓰기의 훅은 쓰기 단계 마감 30s(+정리 6s — §3B-3)로 끝난다.

### §3C-2 worktree 잡과 `repoLock` (M3)
- `repoLock`(worktree.go:118-127, 현행 `sync.Mutex`)을 **ctx·시한을 존중하는 획득**(채널 세마포어 등)으로 바꾼다. `repoLock` 의 키는 `--git-common-dir`(현행 toplevel — worktree.go:118)로 바꾼다(§3D-1). Manager 의 git 을 부르는 연산은 호출자 ctx 를 받는다(범위 §3D-7).
- **worktree add 잡 사전 단계 순서**: 같은 common dir 의 비-index 칸 확인 → `repoLock` 획득(≤5s, 요청 ctx; 실패 409 `repo_busy`) → 이름·경로·브랜치 충돌(handlers_git_worktree.go:146-160) → 부모 디렉터리 생성(이번 요청이 만들었는지 기억) → 요청 ctx 확인 → 잡 등록.
- **등록 전 실패**(사전 거부·ctx 취소·등록 409 `job_busy`): `repoLock` 반납, 이번 요청이 만든 부모 디렉터리가 비어 있으면 삭제.
- **완료 처리**: 성공이고 루트가 살아 있으면 best-effort config 2건(worktree.go:353·357) → `repoLock` 반납(성공·실패·취소·종료 모두). 잠금 범위는 현행 `Create`(add~config)와 같다.
- **worktree remove(동기)**: 같은 common dir 에 worktree 잡이 진행 중이거나 **지울 대상 worktree 의 index 칸**이 진행 중이면 409 `job_busy`(획득 전 확인 + 획득 후 재확인 — §3B-2 행렬 예외). 잠금 순서는 §3I-4(요청 worktree 의 뮤텍스·index 칸은 보지 않는다, common-dir 잠금은 사전 단계 동안만).
- **Run 격리 경로 영향**(httpapi/handlers_runs_worktree.go:65·119 `Create`, :172 `Remove`): 자기 요청 ctx 파생 + 대기 상한 180s(`opTimeout`)로 `repoLock` 을 기다린다. 이전: 무기한 블로킹 대기(사용자 worktree add 는 동기 ≤180s 였다) / 새: 사용자 worktree add 잡(≤10분)과 겹치면 최대 180s 기다린 뒤 실패로 보고 / 이유: 10분 매달림 방지. 그 밖의 Run 격리 동작은 바뀌지 않는다.

### §3C-3 프런트 계약 (M4 — R-2.6)
**공통 — 잡 표시기 일반화.** 현 원격 패널 전용 상태 기계(web/js/git/remote.js — `run`·`_attach`·`_openStream`·`_finish`·`waitJob`·`adoptJobs`, `.git-job` 박스)를 kind 무관 "잡 표시기"로 떼어내 모든 시작 자리가 재사용한다. 진행 표시는 **공용 잡 박스 하나**(현 `.git-job` 자리)이며, 그 저장소의 진행 중 잡을 칸별로 **최대 두 줄**(index·비-index, 줄마다 kind·상태·취소) 보인다(§3D-1).

| 상황 | 화면 동작 |
|------|-----------|
| 시작 | 시작 자리에서 `gitPost(…, {timeout:0})`. 실행 전 거부(4xx)는 시작 자리에 현행대로 표시(다이얼로그 안 오류 등). 200 `{job}` 이면 잡 표시기에 붙고 다이얼로그는 닫는다 |
| 진행 중 잠금 | 판정은 Job 의 `slots` 로 한다 — **그 칸을 쓰는 컨트롤을 잠근다**(kind 목록 복제 금지, pull 은 두 칸 모두). `index` 칸 사용 중: 그 저장소의 동기 쓰기·index 잡 시작 컨트롤 비활성(**worktree remove 는 예외** — 요청 저장소의 index 칸으로 잠그지 않는다, §3I-4). `common` 칸 사용 중: 비-index 잡 시작 컨트롤(worktree 잡이면 worktree remove 도) 비활성 — 커밋·checkout 등은 그대로 쓸 수 있다. 시작 자리 컨트롤은 진행 표시(busy) |
| 성공(exit 0) | `adopt(result.status)` + 동작별 후처리(아래 표) |
| 실패 | 박스 실패 영역에 `err`·`stderrTail`(현행), `result.status` 가 있으면 adopt. 시작 자리 입력은 보존 |
| 충돌(`result.status.operation.kind` 있음) | 실패 표시 대신 "충돌 — 해결 후 계속" 안내, adopt → 기존 Changes 의 충돌·진행 중 노트가 출구 버튼을 준다 |
| 취소 | 박스 취소 버튼 → 확인(원격 kind 는 현행 문구, 그 밖은 "일부가 적용됐을 수 있다") → done 후 adopt |
| `index_locked` | 박스 실패 영역에 "남은 lock 지우기"(§3B-4) |
| 재부착 | 새로고침·다른 탭: `/api/git/jobs` → `repo` 가 현재 저장소인 잡 **전부(최대 2)** 를 kind 무관 부착(현행 `adoptJobs` 는 원격 하나만). 다른 worktree 가 띄운 비-index 잡 때문에 409 가 나면 사유만 표시 → `job/events` 의 done 에서 위 규칙 그대로(undo 토스트는 토큰이 있으면 띄우고 창은 서버가 강제, 충돌 표시·lock 버튼 동일) |

| 동작 | 시작 자리 | 진행 중 추가 잠금 | 성공 후처리 |
|------|-----------|-------------------|-------------|
| 커밋 | 커밋 패널 버튼(commit.js `_commit`) | 메시지 입력·옵션·커밋 버튼 | **성공 확정(done, exit 0) 시** 입력·draft 비움, amend·옵션 초기화, undo 토스트(현행 commit.js:414-423 이 성공 응답에서 하던 일을 옮김). 실패·취소·충돌은 메시지 보존. 재부착한 탭이 성공을 받으면 그 저장소 draft·입력을 비운다 |
| checkout | 브랜치 목록·메뉴 | — | adopt |
| 브랜치 생성+checkout | 생성 다이얼로그 | — | adopt |
| merge·rebase | 브랜치 메뉴 | — | adopt(충돌 규칙) |
| cherry-pick·revert·drop | History 메뉴 | — | adopt(충돌 규칙) |
| 진행 중 작업 continue·skip·abort | Changes 진행 중 노트 버튼 | 노트 버튼 | adopt(노트 갱신) |
| worktree add | Worktrees 탭 다이얼로그 | — | 목록 재조회, `result.path` 표시 |
| pull·fetch·push 류 | 원격 패널 등(현행) | 현행 | 현행 |

**05 와의 경계.** 01 이 이 표의 동작(일반화된 잡 표시기, 시작·잠금·결과·재부착, lock 버튼, 시한 상수, stash 선택 모델의 oid 전환·stash/show 409 화면·stash branch 이름 충돌 오류 — §3J-4)까지 만든다. 05 는 이것을 **전제**로 git 패널·기능 프런트의 나머지 결함을 다루며 잡 UI 계약을 다시 정의하지 않는다. 문구 다듬기·배치 등 표 밖 시각 요소는 05 몫이다.

### §3C-4 그 밖의 확정 (m5·m8)
- **replay 의 stdin 기록 거절(m5)**: `rec.StdinBytes > 0` 인 기록(커밋 메시지, R-10.1 뒤의 태그 메시지, `apply --cached` 패치)의 replay 는 실행 전 400 `bad_request`("stdin 으로 넘긴 내용은 기록되지 않아 다시 실행할 수 없다"). 이전: 커밋은 빈 메시지로 실패, 태그는 빈 메시지 annotated tag 가 exit 0 으로 생김(실측) / 새: 거절 / 이유: 내용이 기록되지 않으므로(I6) 재실행은 다른 결과다. Console 버튼 비활성은 05.
- **Windows 읽기 경로(m8)**: 두 분기를 정의하고 **스펙 단계에서 벤치로 하나를 확정해 스펙에 기록**한다.
  - W1(그룹): 읽기도 Job Object — §3B-9 그대로.
  - W2(비그룹 읽기): 읽기 경로(`Exec`)만 Job Object 없이 기동. 시한 시 리더 `TerminateProcess`(`WaitDelay`=G) → 파이프 EOF 대기 G → 읽기단 닫기. 반환 상한은 W1 과 같은 `마감 + 2G`. 읽기는 훅을 돌리지 않아 고아 위험이 낮다. 쓰기·잡은 항상 그룹.
  - 선택 규칙: Windows CI 샤드에서 `git status` 1회의 전후 중앙값 증가분 ≤10ms 면 W1, 초과면 W2. 인수 테스트는 확정된 분기 + 공통 상한 테스트.
- 나머지 경미 지적은 제자리에서 정정했다 — §3C-5 참조.

### §3C-5 추적 (3차 지적 → 해소 위치)

| 지적 | 해소 |
|------|------|
| M1 쓰기 단계 마감·정리 대기 | R-2.3, §3B-3(단계 마감 규칙·78s), §3B-9 B |
| M2 분류 기준 | R-2.1, §3B-1(근거 문구), §3C-1 |
| M3 worktree `repoLock` | §3B-2(5), §3B-8, §3C-2 |
| M4 프런트 계약 | R-2.6, §3C-3 |
| m1 Manager ctx·종료 중 완료 처리 | §3B-3, §3B-5(d), §3B-10 |
| m2 등록 실패·부작용 | §3B-0, §3B-2(2·3), §3B-5(c) |
| m3 함수 안 사전 조회·쓰기 직전 확인 | §3B-0, §3B-2(1④), §3B-3 |
| m4 commentChar=auto·commentString | §3A R-11.1 |
| m5 stdin 기록 replay | R-10.1(§3A), §3B-1 주①, §3C-4 |
| m6 gitlink 비용·인자 | §3B-12 m9 |
| m7 훅 백그라운드 자식 | §3B-9 B-4 |
| m8 Windows 두 분기 | §3B-12 m6, §3C-4 |
| m9 근거 경로 | §3B-3(web/js/git/api.js), §3B-5(k)(constants-git-remote.js:15) |

## 3D. 확정 사항 (4차 — 00-requirements-attack.md 4차판: 주요 1·경미 9 반영, 2026-09-24)

충돌 시 §3D 가 우선한다. 기존 절의 모순 문장은 제자리에서 정정했고(R-2.4, §3A R-10.1, §3B-0·2·3·4·5·7·10, §3C-2·3), 새 결정만 여기에 둔다.

### §3D-1 잡 슬롯 두 칸과 배타 키 (M1 — 메인 결정 (a), m1·m4)
- 잡 슬롯은 **index 칸 1 + 비-index 칸 1** 이다. 같은 저장소에서 index 잡 하나와 비-index 잡 하나가 동시에 돈다(push 중 commit 가능). 같은 칸끼리는 409 `job_busy`.
- **pull 은 두 칸을 모두 차지한다** — index 를 바꾸고(merge/rebase) 원격 ref 도 받으므로(fetch). 그래서 fetch·push 와의 배타(현행)가 유지된다.
- 배타 키:

| 대상 | 키 | 근거 |
|------|----|------|
| 동기 쓰기·저장소 뮤텍스·index 칸 | worktree toplevel(현행 `active` 키) | index·HEAD·작업 트리는 worktree 마다 따로다 |
| 비-index 칸(fetch·push·submodule·worktree) | `--git-common-dir` 절대 경로 | refs·`worktrees/`·config 는 worktree 들이 공유한다 |
| worktree remove 예외(§3B-2 5)·`repoLock` | `--git-common-dir` | 링크드 worktree 에서 연 add 와 주 저장소에서 연 remove 가 같은 `$GIT_COMMON_DIR/worktrees` 를 고친다 |
| index.lock 삭제 거절(§3B-4) | 그 toplevel 의 index 칸·뮤텍스 + 그 common dir 의 비-index 칸 | R-1.4 "잡·쓰기 진행 중이면 거절" |

- common dir 의 출처·정규화는 §3E-4(core 공개 헬퍼).
- 모델: `active` 맵(job.go:137)을 두 칸(index[toplevel], common[commonDir])으로 나누고, `finish` 는 자기 칸만 비운다(job_run.go:144-146 대응). Job JSON 에 차지한 칸 `slots` 를 싣는다(§3E-2 — `index:bool` 대신). pull 의 `finish` 는 두 칸을 모두 비운다. `repo` 는 현행대로 toplevel.
- `/api/git/jobs` 는 진행 중 잡 전부를 **id 로 중복 제거**해(pull 은 한 번) 현행 정렬(job.go:338-344)로 준다(저장소당 최대 2). `job/cancel` 은 현행대로 id 지정, `job/events` 는 현행. 프런트 박스·잠금·재부착은 §3C-3(정정됨).
- 이전: 저장소당 잡 하나(job.go:268-271). 단 commit·checkout 등은 동기라 push·fetch 중에도 실행됐다 / 새: 두 칸 — push·fetch·submodule update·worktree add 중에도 commit·checkout·merge·rebase 등을 시작할 수 있다 / 이유: 잡 전환이 "push 중 커밋 불가"라는 조용한 사용성 퇴행을 만들지 않게 한다.

### §3D-2 값 플래그 제외 — 하위 명령별 (m5)

| 하위 명령 | 분리형(다음 인자를 검사에서 뺀다) | 붙은 형태(그 인자 전체를 뺀다) |
|-----------|----------------------------------|--------------------------------|
| commit | `-m`, `--message`, `-F`, `--file` | `--message=…`, `--file=…`, `-m…`, `-F…` |
| tag | `-m`, `--message`, `-F`, `--file` | `--message=…`, `--file=…`, `-m…`, `-F…` |

- 그 밖의 하위 명령에는 제외를 적용하지 않는다(`branch -m`·`checkout -m` 은 불리언이고 `cherry-pick -m` 은 숫자다 — 뒤 인자도 검사한다). 결합 짧은 옵션(`-am`)도 제외하지 않는다(안전 쪽; 우리 argv 는 쓰지 않는다). `--` 뒤 인자는 모든 명령에서 뺀다(§3A).

### §3D-3 undo 토큰 발급 시점 (m2)
- 완료 처리의 **마지막 단계**(§3D-4 ⑦ — 사후 재조회 뒤, Done 공개 바로 앞)에서 발급한다. 창의 기점은 그 시각이다.

### §3D-4 완료 처리 순서·ctx·종료 (m3·m9)
- **완료 처리 ctx** = 루트 ctx 파생 + 15s(잡 ctx 와는 별개 — 잡 ctx 는 상한·취소로 이미 끝났을 수 있다). 루트가 취소되면 함께 취소되고, 진행 중이던 git 은 §3B-9 A 로 6s 안에 끝난다 → **7s 상한이 우선**한다.
- **순서**: ① 기록 → ② lock 판정(`rev-parse --git-path`, 완료 처리 ctx) → ③ status 캐시 무효화 → ④ 사후 재조회(status·stash 목록 등) → ⑤ worktree config(worktree 잡 성공 시) → ⑥ `repoLock` 반납(worktree 잡, 항상) → ⑦ undo 토큰 발급(commit 성공 시) → ⑧ Done 공개·칸 비움·구독자 닫기.
- 루트가 이미 취소된 상태면 ②④⑤⑦ 을 건너뛰고(git 호출 없음) ①③⑥⑧ 만 한다.
- **종료로 끊긴 잡**: `errorCode:"server_shutdown"`(index_locked 등보다 우선), `err:"서버 종료로 중단했다 — 일부가 적용됐을 수 있다"`, `canceled:false`.
- **종료로 끊긴 동기 쓰기**: 503 `server_shutdown`. 재조회를 하지 않으므로 partial·changed 는 싣지 않는다. 클라이언트가 이미 끊겼으면 응답은 버려진다.
- **루트 ctx 의 정체·주입**: §3E-5.
- **shutdownSteps 위치**: §3E-5(인덱스 0 — 마커 앞).

### §3D-5 resolve 마감 초과·코드 우선 (m6)
- 쓰기 단계 마감 뒤 남은 경로는 실행하지 않고 `{path, ok:false, skipped:true, error:"시간 초과로 실행하지 않음"}` 으로 싣는다. 마감 순간 실행 중이던 경로는 `{ok:false, error:<시간 초과 사유>}`.
- 응답 코드 우선순위(504 로 답하지 않는다 — 경로별 결과가 더 정확하다):
  1. 경로 오류 중 `index_locked` 가 있으면 409 `index_locked`. 본문에 results·status·lock 필드를 싣는다.
  2. 그 밖에 실패나 skipped 가 있으면 409 `resolve_partial`.
  3. 전부 성공하면 200.

### §3D-6 lock 필드 적용 범위 (m7)
- `ErrIndexLocked` 로 끝나는 **모든 동기 쓰기 실패 응답**에 `lockPath`·`lockMtimeUnixMs` 를 싣는다: `gitApply` 경로 전부(replay·undo 포함), `gitStashApply`, `gitWrite.exec`(worktree remove, submodule sync), resolve(§3D-5), 그 밖의 쓰기 실패 렌더링.
- 종단마다 붙이지 않고 **실패 렌더링 공통 지점 하나**가 `errors.Is` 로 판정해 덧붙인다. lock 판정 git 은 사후 단계 ctx 를 쓴다. 판정 실패·파일 없음이면 필드를 싣지 않고, 프런트는 "다시 시도"를 안내한다.
- Manager 의 오류 래핑(worktree.go runGit 의 `fmt.Errorf("… %v", err)`)은 `%w` 로 바꿔 sentinel 을 보존한다 — 그러지 않으면 `errors.Is` 가 실패한다.

### §3D-7 Manager ctx 전파 범위·최악 시간 (m8)
- **시그니처**: `worktree.Runner`(worktree.go:75)와 submodule 의 같은 모양 Runner(submodule.go:61)에 ctx 를 첫 인자로 더한다. `WithRunner`·`WithService` 가 그것을 따른다. git 을 부르는 Manager 메서드 전부(worktree 의 Resolve·Create·BranchExists·Rollback·List·Remove 와 내부 removeWithRetry·deleteBranch·isDirty·gone, submodule 의 조회·Sync)가 ctx 를 받는다.
- **영향 범위**: gitapi/handlers_git_worktree.go(5곳)·handlers_git_submodule.go, httpapi/handlers_runs_worktree.go(7곳), 두 도메인 테스트의 Runner 대역(worktree_test.go 등). 동작 변화는 ctx 전달뿐이다.
- **ctx 출처**:
  - gitapi 읽기(List·BranchExists·Resolve): 요청 ctx + 사전 단계 마감(10s).
  - gitapi 쓰기(Remove·Sync): 루트 파생 + 쓰기 단계 마감 180s.
  - Run 격리: 자기 요청 ctx(git 1회 상한 opTimeout 180s·`repoLock` 대기 180s 유지 — §3C-2).
- **worktree remove 단계 소속**: §3I-4 순서로 대체한다. 쓰기 단계(180s)는 `repoLock` 대기(≤5s, 쓰기 단계 마감 안) + `Remove`(재시도·브랜치 삭제 포함), 사후 없음(`okPlain`).
- **최악 시간**: worktree remove = **207s**(§3J-2), submodule sync = 5 + (180+6) = **191s**. 둘 다 프런트 `timeout:0`(§3B-3).

### §3D-8 apierr 추가
- `CodeServerShutdown` = `server_shutdown`, 503. sentinel 은 없다(핸들러·잡이 루트 ctx 취소로 판정). codes.go·codes_core.go `gitCodes`·codes_doc.go·apierr_test.go 에 등록한다(§3B-6 과 같은 절차).

### §3D-9 추적 (4차 지적 → 해소 위치)

| 지적 | 해소 |
|------|------|
| M1 잡 배타 모델 | R-2.4, §3B-2(행렬·순서·이전/새), §3C-3, §3D-1 |
| m1 index 판정 출처 | §3B-5(e) `slots`(5차 정정), §3C-3, §3D-1 |
| m2 undo 발급 시점 | §3B-5(f), §3D-3, §3D-4 ⑦ |
| m3 완료 처리 ctx·종료 코드 | §3B-5(d), §3B-10, §3D-4, §3D-8 |
| m4 배타 키 | §3B-0, §3C-2, §3D-1 |
| m5 값 플래그 | §3A R-10.1, §3D-2 |
| m6 resolve 마감 | §3B-7, §3D-5 |
| m7 lock 필드 범위 | §3B-4, §3D-6 |
| m8 Runner ctx·최악 시간 | §3B-3, §3C-2, §3D-7 |
| m9 종료 단계 위치 | §3B-10, §3D-4 |

## 3E. 확정 사항 (5차 — 00-requirements-attack.md 5차판: 주요 1·경미 8 반영, 2026-09-24)

충돌 시 §3E 가 우선한다. 모순 문장은 제자리에서 정정했다(§3A R-6.1, §3B-1·2·5·6·8·10, §3C-2·3, §3D-1·4·8).

### §3E-1 stash 의 common-dir 잠금 (M1 — 메인 결정 (a)) — **§3F-1 로 대체됨(아래는 이력)**
- **common-dir 잠금**: `--git-common-dir`(§3E-4 정규화) 키의 잠금 하나를 배타 패키지(§3B-2 4)에 둔다. 획득은 ctx 를 존중하고 ≤5s, 넘으면 409 `repo_busy` 다.
- **동기 stash apply·pop·drop**: common-dir 잠금 → toplevel 뮤텍스 → oid 확인 → 실행 → 사후 단계 → 역순 반납.
  - apply 는 argv 에 확인한 **oid** 를 넣는다(`stash apply <oid>`).
  - pop·drop 은 git 이 stash ref 만 받으므로 `stash@{n}` 을 쓴다. n 은 같은 잠금 안에서 oid 로 확인한 위치다.
- **stash branch 잡**:
  - 사전 단계에서 common-dir 잠금 → toplevel 뮤텍스 → oid 확인 → argv `stash branch <name> <oid>` → 잡 등록 → toplevel 뮤텍스만 반납.
  - **common-dir 잠금은 완료 처리까지 쥔다**(worktree add 의 `repoLock` 과 같은 방식, §3D-4 ⑥ 자리에서 반납).
  - git 은 stash ref 가 아닌 인자로 연 `stash branch` 에서 stash 를 지우지 않는다. 그래서 성공 시 완료 처리가 잠금 안에서 oid 의 현재 위치 k 를 다시 찾아 `stash drop stash@{k}` 한다. 찾지 못하면 드롭을 생략하고 `result.stashDropSkipped:true` 를 싣는다.
  - 등록 전 실패면 두 잠금을 모두 반납한다.
- **이전/새/이유**:
  - 이전: 확인 없이 `stash@{n}` 위치로 실행했다(stash.go:268 `StashBranchArgs(name, index int)`). 주 저장소와 링크드 worktree 의 두 탭이 같은 `refs/stash` 를 동시에 고칠 수 있었다.
  - 새: dongminal 안의 경쟁이 없다. stash branch 잡이 도는 동안 같은 common dir 의 다른 stash 동작은 5s 뒤 409 `repo_busy` 다.
  - 이유: `refs/stash` 와 그 reflog 는 `$GIT_COMMON_DIR` 에 있다.

### §3E-2 차지한 칸 표현과 `/api/git/jobs` (m1·m2)
- Job JSON 의 `slots`(§3B-5 e)가 잠금 판정의 유일한 출처다. 값은 `"index"`·`"common"` 이고 pull 은 둘 다 갖는다. 프런트는 **그 칸을 쓰는 컨트롤을 잠근다**(§3C-3).
- `/api/git/jobs` 는 id 로 중복을 제거한다. `finish` 는 그 잡이 차지한 칸을 모두 비운다. `Get` 은 `byID` 로 찾으므로(job.go:314-324) 바뀌지 않는다.

### §3E-3 잠금 획득 순서와 worktree remove (m4)
- **전역 순서**: common-dir 잠금 → toplevel 뮤텍스 → `repoLock`. 모든 경로가 이 순서만 따르므로 교착이 없다(worktree remove 는 §3I-4).
- **worktree remove**: 순서는 **§3I-4** 가 확정한다.
  - 각 대기 ≤5s, 실패 시 409 `repo_busy`. 대상 toplevel 은 사전 단계의 `List` 결과로 정한다.
  - **최악 시간**: §3J-2 의 **207s**.
- **stash 동기 쓰기 최악**: 5 + 5 + (10+6) + (30+6) + (15+6) = **83s** < 100s.

### §3E-4 common dir 공개 헬퍼와 정규화 (m3)
- core 에 공개 헬퍼 하나를 둔다. `rev-parse --git-common-dir` 결과를 절대화한 뒤 정규화한다 — 정규화 규칙은 **§3J-1**(존재하는 가장 가까운 조상까지 EvalSymlinks + Clean). 기존 `core.GitDirs`(dirs.go:17-37)의 `Join` 만 하는 결과를 그대로 키로 쓰지 않는다. Service 가 nil 이어도 동작해야 한다(FR-GXU-4 와 같다).
- toplevel **배타 키**도 같은 정규화를 거친다. 단 정규화 값은 **배타 키 전용**이다 — `Job.Repo`·store 키·API 응답의 `repo` 는 `RepoRoot` 출력 그대로다(§3F-5).
- **호출 흐름**: gitapi 핸들러가 헬퍼로 구해 `jobs.Start`(와 `StartUnguarded`)·배타 패키지에 넘긴다. worktree Manager 의 `repoLock` 키도 호출자가 넘긴 값을 쓴다. Run 격리 핸들러(httpapi/handlers_runs_worktree.go)도 같은 헬퍼를 부른다. jobs·worktree 는 store 를 모르고 알 필요도 없다.
- 인수: 심링크 경로로 연 주 저장소와 링크드 worktree 가 같은 키를 얻는다(macOS `/var` ↔ `/private/var` 표기 차이 재현 테스트).

### §3E-5 루트 ctx 주입·종료 단계 위치 (m6·m7)
- **루트 ctx 만들기**: `serve`(cmd/dongminal/app.go)가 `buildApp` **앞**에서 `gitRoot, cancelGit := context.WithCancel(context.Background())` 를 만든다.
- **주입**: `buildApp` → `buildDeps`/`buildDepsWithHub`(main.go:216·268)의 인자로 넘기고, 거기서 GitServer 로 간다. Store flight 와 지연 생성되는 Jobs(`gitJobHolder.get`, handlers_git_remote.go:62-73)가 그것을 쓴다.
- **신호 연결**: `signal.NotifyContext` 로 만든 ctx 가 생기면(app.go:320) `context.AfterFunc(sigCtx, cancelGit)` 로 잇는다. 신호가 오면 HTTP `Shutdown` 과 동시에 git 정리가 시작된다. 부팅 중 신호 처리는 현행 그대로다.
- **대기 단계**: "git 잡·쓰기 대기" 단계는 **먼저 `cancelGit()` 을 부르고** 최대 7s 기다린다. `a.srv.Run` 이 신호 없이 오류로 돌아온 경우에도 잡·쓰기가 끊긴다.
- **위치**: shutdownSteps 의 **인덱스 0 — "마커" 앞**이다(app.go:252). 마커는 "여기를 지났으면 정상 종료"라는 뜻이므로(FR-OBS-15), 잡이 끊길 수 있는 구간은 마커 전에 끝나야 한다. `a.shutdown()` 은 `a.run` 이 돌아온 뒤, 즉 HTTP 수신 중단 뒤에 돈다.
- 단계 이름 순서 테스트(cmd/dongminal/app_test.go 의 `shutdownSteps` 검증)와 표 위 순서 주석(app.go:241-251)을 갱신 대상으로 명시한다.

### §3E-6 worktree add 의 비-index 칸 제약 (m5 — 메인 결정: 수용)
- 이전: worktree add 는 동기(`Manager.Create`)라 같은 common dir 에서 push·fetch·submodule update 가 도는 중에도 실행됐다.
- 새: worktree add 는 비-index(`common`) 칸을 쓰므로 그동안 409 `job_busy` 다. 실행 전 거부이므로 **시작 자리(Worktrees 다이얼로그)** 에 사유를 보인다("원격 작업이 끝난 뒤 다시 시도" — §3C-3 '시작' 행과 같은 규칙).
- 이유: worktree add 는 보통 짧고, `common` 칸을 나누면 모델이 복잡해진다. 잠긴 이유는 `slots` 로 화면이 설명할 수 있다.

### §3E-7 apierr 등록 단계 (m8)
- 새 코드 5개(`repo_busy`·`index_locked`·`stash_moved`·`resolve_partial`·`server_shutdown`)를 **codes_core.go `gitCodes`**(81-94)에도 등록한다. `AllCodes()`·`TestAllCodesDeclared` 가 이 목록을 본다. 절차 전체는 §3B-6.

### §3E-8 추적 (5차 지적 → 해소 위치)

| 지적 | 해소 |
|------|------|
| M1 stash 배타 | §3A R-6.1, §3B-1, §3B-2(6), §3B-5(a), §3E-1 |
| m1 칸 표현 | §3B-5(e) `slots`, §3C-3, §3E-2 |
| m2 jobs 중복·finish | §3D-1, §3E-2 |
| m3 common dir 출처·정규화 | §3D-1, §3E-4 |
| m4 remove 대상 배타 | §3B-2(5), §3B-8, §3C-2, §3E-3 |
| m5 worktree add 제약 | §3E-6 |
| m6 루트 ctx 주입 | §3B-10, §3D-4, §3E-5 |
| m7 종료 단계 위치 | §3B-10, §3D-4, §3E-5 |
| m8 gitCodes 등록 | §3B-6, §3D-8, §3E-7 |

## 3F. 확정 사항 (6차 — 00-requirements-attack.md 6차판 8건, 메인 세션이 코드와 대조해 직접 판정, 2026-09-24)

판정: 8건 모두 실제 결함이다. 그중 4건(지적 1·2·3·6)은 5차에서 stash branch 를 "oid 인자로 여는 잡 + 완료 시 수동 드롭 + 잠금 10분 보유"로 만든 과잉 설계에서 나왔다. 덧붙이지 않고 **단순화로 해소**한다. 충돌 시 §3F 가 우선한다.

### §3F-1 stash 는 전부 동기, refs/stash 를 바꾸는 모든 동작은 common-dir 잠금 (지적 1·2·3·6)
- 대상: stash **push·apply·pop·drop·branch**. 모두 동기 쓰기다. 순서: common-dir 잠금(≤5s) → toplevel 뮤텍스(≤5s) → (apply·pop·drop·branch 는) 목록 조회로 요청 oid 의 현재 위치 n 확인(목록에 없으면 409 `stash_moved` — §3G-2) → 실행 → 사후 단계 → 역순 반납. 최악 83s(§3E-3 계산 그대로) < 100s.
- argv: apply 는 `stash apply <oid>`. pop·drop·branch 는 `stash@{n}`(git 이 stash ref 만 받거나 — pop·drop — ref 로 열어야 스스로 드롭하므로 — branch). n 은 같은 잠금 안에서 방금 확인한 값이다. **push 도 같은 잠금을 쥐므로** dongminal 안의 다른 stash 동작이 확인과 실행 사이에 위치를 밀 수 없다.
- stash branch 가 동기인 이유(§3C-1 예외): 확인~실행이 한 잠금 안에서 원자적이어야 하고, 잡으로 보내면 등록과 실행 사이 창이 생긴다. HEAD 이동에 따르는 post-checkout 훅은 쓰기 단계 마감 30s(+6s)로 끝난다 — 동기 쓰기 일반 규칙(§3C-1)과 같다. 5차의 "oid 인자 + 완료 시 드롭 + 잠금 완료까지 보유"와 `result.stashDropSkipped` 는 **폐기**한다.
- stash branch 충돌: `git stash branch` 는 적용이 충돌하면 브랜치를 만들고 체크아웃한 채 unmerged 항목을 남기며 stash 를 지우지 않는다(진행 중 표식 없음 — query/operation.go:58-72 로 판정되지 않음). 응답은 기존 동기 쓰기 실패 렌더링(FR-GIT-73 partial·changed + status)에 `stashKept:true` 를 싣고, 프런트는 stash pop 충돌과 같은 안내("브랜치는 만들어졌고 충돌이 남았다 — stash 는 보존됐다")를 보인다. status 의 unmerged 가 Changes 의 충돌 목록으로 이어진다.
- **한계(스펙에 명시)**: 사용자가 `rebase.autoStash`·`merge.autoStash` 를 켠 상태에서 pull·merge·rebase 잡이 도는 동안, 다른 worktree 에서 stash pop·drop·branch 를 하면 잡의 autostash push/pop 이 위치를 밀 수 있다. 막으려면 index 잡 전체 동안 stash 를 잠가야 해 득보다 실이 크다. 확인은 실행 직전에 하므로 창은 좁다.
- 이전/새/이유: 이전 — 확인 없이 `stash@{n}` 으로 실행했고 worktree 들이 같은 `refs/stash` 를 동시에 고칠 수 있었다 / 새 — dongminal 안의 stash 동작끼리는 경쟁이 없다(autostash 한계 제외) / 이유 — `refs/stash` 와 그 reflog 는 `$GIT_COMMON_DIR` 에 있다.

### §3F-4 worktree remove 잠금 순서 (지적 4) — **이력: §3I-4 로 대체됨**
- 순서: ① common-dir 잠금(≤5s) → ② 요청 toplevel 뮤텍스(≤5s) → ③ 사전 단계: worktree 잡(같은 common dir) 확인 → `List` 로 대상 toplevel 확정 → 대상 index 칸 확인(진행 중이면 409 `job_busy`) → ④ 대상 toplevel 뮤텍스(요청과 같으면 생략, ≤5s, 실패 409 `repo_busy`) → ⑤ 대상 index 칸 재확인 → ⑥ 쓰기 단계: `repoLock`(≤5s) + `Remove`.
- 교착 없음의 근거: 둘 이상의 toplevel 뮤텍스를 잡는 경로는 worktree remove 뿐이고, 그것은 항상 common-dir 잠금을 먼저 쥐므로 두 remove 가 서로의 toplevel 을 기다리는 일이 없다. 다른 경로는 toplevel 뮤텍스를 하나만 쥐고 그 뒤에 common-dir 잠금을 기다리지 않는다(common-dir 잠금은 항상 toplevel 보다 먼저). 따라서 §3E-3 의 "사전순" 규칙은 worktree remove 에 적용하지 않는다.
- 최악 시간: 5 + 5 + (10+6) + 5 + (180+6) = **217s**(§3E-3 값 유지), 프런트 `timeout:0`.

### §3F-5 정규화 키의 범위 (지적 5)
- `core.RepoRoot` 의 계약("심링크를 정규화하지 않는다 — 비교는 이 함수의 출력끼리", core/repo.go:10-16)은 바꾸지 않는다. §3E-4 의 정규화(EvalSymlinks+Clean)는 **배타 키(뮤텍스·칸·common-dir 잠금·repoLock) 전용**이다.
- `Job.Repo`, store 키, `Invalidate` 인자, API 응답의 `repo`, 프런트 재부착 비교는 `RepoRoot` 출력 그대로다. `jobs.Start` 는 `repo`(표시·무효화용)와 배타 키를 **따로** 받는다.
- 인수: 심링크 경로로 연 저장소에서 잡 완료 후 `store.Invalidate(jb.Repo)` 가 실제 캐시 항목을 무효화한다(다음 status 가 새 관측).

### §3F-7 worktree add 409 표시 위치 (지적 7)
- §3E-6 을 정정했다: 실행 전 거부이므로 시작 자리(Worktrees 다이얼로그)에 표시한다(§3C-3 '시작' 행).

### §3F-8 Run 격리 Remove 의 사용 중 검사 (지적 8)
- Run 격리 `Remove`(httpapi/handlers_runs_worktree.go:172)도 대상 worktree 의 index 칸을 확인하고 대상 toplevel 뮤텍스를 **TryLock** 한다(대기 없음 — Run 종료 경로를 막지 않는다). 칸이 진행 중이거나 TryLock 이 실패하면 제거하지 않고 기존 잔여물 보고 경로로 `Residue: ResidueRemoveFailed`, `Detail: "사용 중인 worktree — 작업이 끝난 뒤 정리"` 를 남긴다(handlers_runs_worktree.go:166-184 와 같은 모양). Create 는 바뀌지 않는다(§3C-2).
- 이전: 사용자가 그 worktree 에서 커밋 중이어도 작업 트리를 지울 수 있었다 / 새: 사용 중이면 잔여물로 남긴다 / 이유: 진행 중 쓰기의 작업 트리 삭제 방지.

### §3F-9 추적 (6차 지적 → 해소 위치)

| 지적 | 판정 | 해소 |
|------|------|------|
| M1 stash push 잠금·autostash | 실제 | §3F-1, §3B-1, §3B-2(6) |
| m 완료 처리 stash drop 단계 | 실제(과잉 설계 산물) | §3F-1 — 완료 드롭 폐기로 소멸 |
| m stash branch 충돌 표시 | 실제 | §3F-1(동기 + stashKept) |
| m worktree remove 순서 모순 | 실제 | §3F-4, §3E-3 정정 |
| m RepoRoot 정규화 범위 | 실제(문구 모호) | §3F-5, §3E-4 정정 |
| m stash branch 잠금 보유 | 실제(과잉 설계 산물) | §3F-1 — 잠금 보유 폐기로 소멸 |
| m 409 표시 위치 | 실제(문구 불일치) | §3F-7, §3E-6 정정 |
| m Run 격리 Remove | 실제 | §3F-8 |

## 3G. 확정 사항 (7차 — 8건, 메인 세션 직접 판정, 2026-09-24)

판정: 8건 모두 실제다. 2건(§5 잔존 문구, §3D-7 잔존 문장)은 6차 정정의 누락, 1건(78s→83s)은 6차 결정의 파급, 5건은 틈이다. 충돌 시 §3G 가 우선한다. 본문·§3B·§3D·§5 의 해당 문장은 제자리에서 정정했다.

### §3G-1 worktree remove 의 common-dir 잠금 보유 범위 (지적 4·5) — **이력: 순서·결과는 §3I-4 로 대체됨**
- 순서(§3F-4 정정): ⓪ 요청 toplevel 의 index 칸 확인 — 진행 중이면 409 `job_busy`(동기 쓰기 일반 규칙 §3B-2 판정 1① 과 같다) → ① common-dir 잠금(≤5s) → ② 요청 toplevel 뮤텍스(≤5s) → ③ 사전 단계(worktree 잡 확인, `List` 로 대상 확정, 대상 index 칸 확인) → ④ 대상 toplevel 뮤텍스(요청과 같으면 생략, ≤5s) → ⑤ 대상 index 칸 재확인 → **⑥ common-dir 잠금 반납** → ⑦ 쓰기 단계(`repoLock` ≤5s + `Remove`) → 반납.
- 교착 없음: common-dir 잠금은 "둘 이상의 toplevel 을 순서 없이 잡는 구간"만 감싸면 충분하다. ⑥ 뒤 remove 는 toplevel 둘과 `repoLock` 만 쥐고, 더 이상 common-dir 잠금이나 다른 toplevel 을 기다리지 않는다. stash 경로는 common-dir → toplevel 하나 순으로만 잡으므로 순환이 생기지 않는다.
- 결과: worktree remove 동안 **다른 worktree 의 stash 동작은 막히지 않는다**(common-dir 잠금은 사전 단계 동안만). **대상** worktree 의 동기 쓰기는 remove 가 끝날 때까지 뮤텍스 대기(5s) 뒤 409 `repo_busy` — 그 worktree 를 지우는 중이므로 의도된 동작이다(이전/새: 이전엔 배타가 없어 지우는 중인 worktree 에 쓰기가 가능했다 / 새: `repo_busy` / 이유: 삭제 중 쓰기 방지).

### §3G-2 stash 대상 식별 규칙 하나로 (지적 2)
- 요청: `{repo, oid, withIndex?, confirm?, name?(branch)}`. **oid 필수, index 필드는 받지 않는다**(보내도 무시하지 않고 400 — 계약을 흐리지 않게). 프런트 갱신은 같은 변경에서 한다.
- 서버: 잠금 안에서 목록을 읽어 oid 의 현재 위치 n 을 찾는다. 없으면 409 `stash_moved`(본문에 현재 목록·status). 있으면 apply 는 `stash apply <oid>`, pop·drop·branch 는 `stash@{n}`.
- 결과: 사이에 stash push 가 끼어 위치가 밀려도 **사용자가 고른 stash 가 실행된다**(409 가 아니다). `stash_moved` 는 그 stash 가 사라졌을 때만이다.
- 인수: push 로 위치가 밀린 뒤 원래 oid 로 pop → 그 oid 가 pop 된다 / 이미 drop 된 oid → 409 `stash_moved`.

### §3G-3 stash branch 충돌·실패의 잔존 판정 (지적 7)
- `StashPopChecked`(write/stash.go:212-236)와 **같은 확인 경로**를 쓴다: 실행 후 목록을 다시 읽어 요청 oid 가 남았으면 `stashKept:true`, `stashKeptOid`, `stashKeptReason` 을 싣는다(pop 과 같은 세 필드). 목록 재조회가 실패하면 "남지 않았다"로 답하지 않고 오류를 합친다(pop 과 같은 규칙).
- 안내문 분기: 실행 후 HEAD 브랜치 이름이 요청 `name` 과 같으면 "브랜치 `<name>` 은 만들어졌고 충돌이 남았다 — stash 는 보존됐다", 다르면(브랜치 생성 전 실패) "stash branch 가 실패했다 — stash 는 보존됐다" + stderr tail. HEAD 판정은 사후 단계의 status 관측(`Status.Branch`)을 쓴다.

### §3G-4 배타 상태의 소유와 Run 격리 주입 (지적 8)
- 배타 상태(저장소 뮤텍스·index/common 칸·common-dir 잠금)는 **하나의 인스턴스**로 `buildDeps` 에서 만들어 GitServer(→ jobs)와 httpapi(Run 격리)에 같은 것을 주입한다. 잡 허브의 지연 생성(handlers_git_remote.go:62-73)은 이 인스턴스를 받아 쓰므로 지연 생성이어도 칸 상태는 공유된다.
- Run 격리 Remove(§3F-8)의 대상 toplevel 뮤텍스는 TryLock 성공 시 `repoLock` 대기(≤180s)와 `Remove` 가 끝날 때까지 쥔다. 부작용: 그동안 그 worktree 의 동기 쓰기는 5s 뒤 409 `repo_busy` — 지우는 중인 worktree 이므로 의도된 동작(§3G-1 과 같은 이유). 이전/새: 이전엔 Run 격리 제거와 사용자 쓰기가 동시에 가능했다 / 새: 서로 배타 / 이유: 삭제 중 쓰기 방지.

### §3G-5 추적 (7차)

| 지적 | 판정 | 해소 |
|------|------|------|
| §5 잔존 문구 | 실제(6차 누락) | §5 정정 |
| R-6.1 ↔ §3F-1 의미 | 실제 | R-6.1 정정, §3G-2 |
| 78s ↔ 83s | 실제(파급) | R-2.6·§3B-3 정정 |
| remove 중 stash 막힘 | 실제 | §3G-1(보유 범위 축소로 해소) |
| 요청 toplevel index 칸 | 실제 | §3G-1 ⓪ |
| §3D-7 잔존 문장 | 실제(6차 누락) | §3D-7 정정 |
| stash branch 잔존 필드 | 실제 | §3G-3 |
| Run 격리 배타 상태 주입 | 실제 | §3G-4 |

## 3H. 확정 사항 (8차 — 경미 7건, 메인 세션 직접 판정, 2026-09-24)

판정: 7건 모두 실제다(주요 0). 충돌 시 §3H 가 우선한다. 잔존 문구(지적 7)는 머리글·§3B-8·§3C-2·§3E-3·§3F-4·§5 에서 제자리 정정했다.

### §3H-1 stash branch 이름 사전 검사 (지적 1)
- 사전 단계에서 기존 `gitBranchNameTaken`(브랜치 생성 종단과 같은 판정)으로 이미 있는 이름이면 실행 전 409 `branch_exists`. 따라서 실행 뒤 "HEAD 브랜치 = name" 이면 브랜치는 이번 실행이 만든 것이다(§3G-3 안내문 분기 유효).
- 사후 status 재조회가 실패하면 브랜치를 언급하지 않는 일반 문구("stash branch 뒤 상태를 확인하지 못했다 — stash 보존 여부는 위 표시를 따른다")를 쓴다.

### §3H-2 worktree remove 순서 (지적 2·3) — **이력: §3I-4 로 대체됨**
- ⓪ 요청 toplevel index 칸 확인(진행 중 409 `job_busy`) → ① common-dir 잠금(≤5s) → ② 요청 toplevel 뮤텍스(≤5s) → ③ 사전 단계: **요청 toplevel index 칸 재확인** → worktree 잡 확인 → `List` 로 대상 확정 → 대상 index 칸 확인 → ④ 대상 toplevel 뮤텍스(같으면 생략, ≤5s) → ⑤ 대상 index 칸 재확인 → ⑥ common-dir 잠금 반납, **요청 ≠ 대상이면 요청 toplevel 뮤텍스도 반납** → ⑦ 쓰기 단계(`repoLock` ≤5s + `Remove`) → 대상 뮤텍스 반납.
- 근거(지적 3): `git worktree remove` 는 요청 worktree 의 index·HEAD 를 바꾸지 않는다(대상 작업 트리와 `$GIT_COMMON_DIR/worktrees/<n>` 만 고친다). 요청 뮤텍스를 쓰기 단계까지 쥘 이유가 없다 — 주 저장소의 동기 쓰기·index 잡이 remove 동안 막히지 않는다.
- ⑥~⑦ 사이 경쟁(지적 2 후반): ⑥ 뒤 같은 common dir 에 worktree add 잡이 등록되면 그 잡이 `repoLock` 을 쥐므로 ⑦ 의 `repoLock` 대기(≤5s)가 409 `repo_busy` 로 끝난다. 행렬 예외의 `job_busy` 와 코드가 다르지만 **둘 다 "지금은 안 됨 — 다시 시도"로 같은 화면 처리**이고 삭제는 일어나지 않으므로 수용한다(스펙에 명시).
- 최악 시간: 5 + 5 + (10+6) + 5 + (180+6) = **217s**(변화 없음).

### §3H-3 stash 기록의 replay 거절 (지적 4)
- `argv[0]=="stash"` 인 **쓰기 기록**의 replay 는 실행 전 400 `bad_request`("stash 는 위치로 기록돼 지금 다시 실행하면 다른 stash 를 건드릴 수 있다"). §3C-4(stdin 기록 거절)와 같은 방식이며 Console 버튼 비활성은 05.
- 이전/새/이유: 이전 — 기록의 `stash@{n}` 을 그대로 실행 / 새 — 거절 / 이유 — R-6·§3F-1 의 목적(엉뚱한 stash 조작 방지).

### §3H-4 index 필드 판정 수단 (지적 5)
- stash 요청 구조체의 index 는 `Index *int`(포인터)로 두고 non-nil 이면 400 `bad_request`("index 는 더 이상 받지 않는다 — oid 를 보내라"). `DisallowUnknownFields` 는 전역에 도입하지 않는다(다른 종단의 호환을 바꾸지 않는다).

### §3H-5 stash 미리보기도 oid (지적 6)
- R-6 범위에 `GET /api/git/stash/show` 를 넣는다: 쿼리 `oid`(필수) → 서버가 목록에서 현재 위치를 찾아 미리보기, 없으면 409 `stash_moved`. `index` 쿼리는 400. 프런트(stash 목록의 미리보기 호출)도 같은 변경에서 oid 로 바꾼다.

### §3H-6 추적 (8차)

| 지적 | 판정 | 해소 |
|------|------|------|
| stash branch 이름 존재 | 실제 | §3H-1 |
| remove ⓪~② 재확인·⑥~⑦ 경쟁 | 실제 | §3H-2 |
| 요청 뮤텍스 장기 보유 | 실제 | §3H-2 ⑥ |
| stash 기록 replay | 실제 | §3H-3 |
| index 필드 판정 수단 | 실제 | §3H-4 |
| stash/show index 기반 | 실제 | §3H-5 |
| 잔존 문구 | 실제 | 제자리 정정 |

## 3I. 확정 사항 (9차 — 경미 5건, 메인 세션 직접 판정, 2026-09-24)

판정: 5건 모두 실제다(주요 0). 충돌 시 §3I 가 우선한다. 잔존 문구(지적 5)는 §3G-1·§3H-2(이력 표시)·§3D-7·§3B-8·§3C-2·§3E-3·§5 에서 제자리 정정했다.

### §3I-1 stash 미리보기는 oid 로 직접 (지적 1)
- `StashPreview(s, ctx, repo, oid string)` — 인자가 index 에서 oid 로 바뀐다. 실행은 `stash show <flags> -z <oid>`(git 은 stash 커밋 oid 를 그대로 받는다) — 위치를 거치지 않으므로 목록과 실행 사이 창이 없다. 목록 조회는 oid 가 `refs/stash` reflog 에 있는지 판정해 409 `stash_moved` 를 낼 때만 쓴다(없는 oid 의 내용을 "stash" 로 보이지 않게).

### §3I-2 stash/show 의 echo·409 본문·화면 (지적 2)
- 응답 `requested` 는 `{repo, oid}`(`gitStashShowRequested` 의 Index → Oid). 프런트(web/js/git/stash.js 의 선택·echo·`_filesFor` 키)는 oid 로 비교한다.
- 409 `stash_moved` 본문(GET): `{error, message, requested, repo, stashes}` — status 는 싣지 않는다(읽기 종단). 프런트는 목록을 `stashes` 로 갈아 끼우고 선택을 해제하며 미리보기 자리에 "선택한 stash 가 사라졌다" 를 보인다.

### §3I-3 stash branch 의 이름 충돌 409 (지적 3)
- stash branch 의 409 `branch_exists` 본문에는 `options` 를 싣지 않는다(브랜치 생성용 checkout·rename 선택지는 이 동작에 맞지 않는다). stash branch 다이얼로그(web/js/git/stash.js)는 다이얼로그 안에 "이미 있는 이름" 오류를 보이고 입력을 유지한다(§3C-3 '시작' 행 규칙). 이 화면은 **01 범위**다.

### §3I-4 worktree remove 순서 (지적 4 — 공격자 권장 (b) 대신 (a) 를 택한다) — **순서·최악 시간은 §3J-2 가 정정**
- 근거: `git worktree remove` 는 요청 worktree 의 index·HEAD·작업 트리를 바꾸지 않는다(대상 작업 트리와 `$GIT_COMMON_DIR/worktrees/<n>` 만). 주 worktree 는 git 이 제거를 거부하고, **요청 저장소 자신**은 `Manager.Remove` 가 거부한다(remove.go:44 — Clean 비교, `ResidueUnsafePath`; git 자체는 링크드 worktree 안에서의 자기 제거를 허용한다 — 10차 실측으로 정정). 따라서 제거가 실제로 일어날 때 요청 ≠ 대상이다. 따라서 요청 worktree 의 뮤텍스·index 칸을 볼 이유가 없고, 보면 시작 순서에 따라 허용/거절이 갈리는 비대칭(지적 4)이 생긴다.
- 순서: ① common-dir 잠금(≤5s) → ② 사전 단계: worktree 잡(같은 common dir) 확인 → `List` 로 대상 확정 → 대상 index 칸 확인(진행 중 409 `job_busy`) → ③ 대상 toplevel 뮤텍스(≤5s, 실패 409 `repo_busy`) → ④ 대상 index 칸 재확인 → ⑤ common-dir 잠금 반납 → ⑥ 쓰기 단계(`repoLock` ≤5s + `Remove`) → 대상 뮤텍스 반납.
- ⑤~⑥ 사이에 worktree add 잡이 끼면 ⑥ 의 `repoLock` 대기가 409 `repo_busy` 로 끝난다 — 삭제는 일어나지 않고 화면 처리는 `job_busy` 와 같으므로 수용(§3H-2 의 판단 유지).
- 교착 없음: toplevel 뮤텍스를 하나만 잡으므로 모든 경로가 "common-dir → toplevel 하나 → repoLock" 순서를 따른다. §3E-3 의 전역 순서에 예외가 없어진다.
- 프런트: §3C-3 의 `slots` 잠금에서 worktree remove 컨트롤은 **요청 저장소의 index 칸으로 잠그지 않는다**(`common` 칸의 worktree 잡일 때만 잠근다). 대상 worktree 의 index 잡으로 인한 409 는 시작 자리(Worktrees 목록)에 사유로 표시한다.
- 최악 시간: §3J-2 의 **207s** 로 대체.
- 이전/새/이유: 이전(§3H-2) — 요청 worktree 의 index 잡 중 remove 409 / 새 — 허용 / 이유 — remove 는 요청 worktree 를 건드리지 않는다.

### §3I-5 추적 (9차)

| 지적 | 판정 | 해소 |
|------|------|------|
| show 의 위치 경유 창 | 실제 | §3I-1 |
| show echo·409 본문 | 실제 | §3I-2 |
| stash branch 409 options·화면 | 실제 | §3I-3 |
| remove 시작 순서 비대칭 | 실제 | §3I-4((a) 채택) |
| 잔존 문구 | 실제 | 제자리 정정 |

## 3J. 확정 사항 (10차 — 7건, 메인 세션 직접 판정, 2026-09-24)

판정: 7건 모두 실제다. 지적 1(§5 모순)·5(잔존 문장)는 9차 정정 누락, 지적 3 은 제 근거의 사실 오류(git 은 자기 제거를 허용 — remove.go:44 가 막는다, 코드 확인), 지적 2 는 새 결함(코드 확인 — remove.go:57-62 의 "경로가 이미 없다 → prune 후 성공" 경로), 지적 4 는 9차 결정의 파급이다. 충돌 시 §3J 가 우선한다.

### §3J-1 배타 키 정규화 — 없는 경로도 키를 갖는다 (지적 2)
- §3E-4 의 정규화를 "**존재하는 가장 가까운 조상까지 EvalSymlinks 한 뒤 나머지를 붙이고 Clean**" 으로 바꾼다. 기존 `resolveSymlinksPrefix`(domain/worktree/worktree.go:163)를 core 공개 헬퍼로 옮겨 배타 키 산출과 worktree 패키지가 같은 것을 쓴다(두 벌 금지).
- 따라서 밖에서 디렉터리를 지운(prunable) worktree 도 키가 나오고, 칸·뮤텍스 확인이 정상적으로 돈다(그 경로에서 도는 잡·쓰기는 있을 수 없으므로 확인은 통과한다). 제거는 현행대로 prune 후 성공(`Removed:true`).
- Run 격리 Remove(§3F-8)의 TryLock 도 같은 키를 쓴다.
- 인수: 디렉터리를 밖에서 지운 worktree 의 remove 가 성공(사용자 종단·Run 격리 모두), `/var`↔`/private/var` 표기 차이에서 존재·부재 두 경우 모두 같은 키.

### §3J-2 worktree remove 순서 최종 — common-dir 잠금 없음 (지적 4, 권장 (a))
- 9차 이후 remove 는 toplevel 뮤텍스를 **하나만**(대상) 잡으므로, common-dir 잠금이 지키던 불변식("둘 이상의 toplevel 을 순서 없이 잡는 구간")이 없다. 잠금을 없앤다.
- 순서: ① 사전 단계: worktree 잡(같은 common dir) 확인 → `List` 로 대상 확정 → 대상 index 칸 확인(진행 중 409 `job_busy`) → ② 대상 toplevel 뮤텍스(≤5s, 실패 409 `repo_busy`, §3J-1 키) → ③ 대상 index 칸 재확인 → ④ 쓰기 단계(`repoLock` ≤5s + `Remove`) → 반납.
- 요청 = 대상이면 ①~③ 을 거친 뒤 ④ 의 `Manager.Remove` 가 `ResidueUnsafePath`("저장소 자신은 제거하지 않는다")로 끝난다(현행 remove.go:44). 스펙에 이 경로를 적는다.
- 결과: worktree remove 는 **어느 worktree 의 stash 도 막지 않는다**(common-dir 잠금을 쓰지 않으므로). 대상 worktree 의 동기 쓰기만 remove 동안 5s 뒤 409 `repo_busy`(§3G-1 의 대상 한정 문장 유지).
- 교착 없음: 모든 경로가 "common-dir(stash 만) → toplevel 하나 → repoLock" 순서의 부분열을 따른다.
- 최악 시간: (10+6) + 5 + (180+6) = **207s**(§3I-4 의 212s 대체), 프런트 `timeout:0`.

### §3J-3 stash branch 사후 재조회 실패 문구 (지적 7)
- §3H-1 문구를 "stash branch 뒤 상태를 확인하지 못했다 — stash 보존 여부는 위 표시를 따른다" 로 정정했다(성공 후 재조회만 실패한 경우에도 사실과 맞는다).

### §3J-4 stash 선택 모델의 oid 전환 — 01 범위 (지적 6)
- 프런트(web/js/git/stash.js)의 선택·미리보기·조작·echo 비교 키를 위치(index)에서 oid 로 바꾼다(현행 :244·:336·:353 등 위치 기반 전체).
- 목록 갱신 뒤 선택한 oid 가 새 목록에 있으면 **선택을 유지**하고(위치가 바뀌어도 같은 stash 를 가리킨다), 없으면 선택을 해제하고 미리보기 자리에 "선택한 stash 가 사라졌다"(§3I-2).
- stash/show 409 화면(§3I-2), stash branch 이름 충돌 오류(§3I-3)와 함께 01 범위다(§1·§3C-3 경계에 추가했다).

### §3J-5 추적 (10차)

| 지적 | 판정 | 해소 |
|------|------|------|
| §5 remove 409/허용 공존 | 실제(9차 누락) | §5 정정 |
| prunable worktree 키 산출 | 실제(새 결함, 코드 확인) | §3J-1 |
| 자기 제거 근거 | 실제(사실 오류, 코드 확인) | §3I-4 근거 정정, §3J-2 |
| common-dir 잠금 잔존 | 실제(9차 파급) | §3J-2((a) — 잠금 제거) |
| §3B-8·§3B-1·§3B-2·§3C-3 잔존 | 실제 | 제자리 정정 |
| stash oid 전환 범위 | 실제 | §1·§3C-3, §3J-4 |
| §3H-1 문구 | 실제 | §3J-3 |

## 4. 제약
- Go 1.25, 새 외부 의존성 추가 금지(이 문서 범위). 기존 플랫폼 추상(`internal/shared/platform`)을 확장해 쓴다.
- 레포 관례: 주석·문서 한국어, FR ID 체계, `make gates`/`make test`(-race -shuffle=on) 통과, 관련 e2e(`e2e/git-*.spec.ts`) 회귀 없음.
- 커밋 메시지·문서에 AI 서명 금지.

## 5. 인수 기준
- 위 R-* 각각에 대해 실패하던 테스트가 구현 후 통과(결정적).
- §3B 추가 인수: 배타 행렬(§3B-2) 12칸 각각의 응답 코드, 뮤텍스 대기 5s 경계(초과 409 `repo_busy`)와 대기 중 요청 취소 시 미실행, §3B-1 분류표의 잡 종단이 200 `{job}` 을 내고 실행 전 거부는 동기로 남는 것, 잡 결과 페이로드(§3B-5 e)와 undo 창 기점, `index_locked` 판정·lock 정보(동기·잡 양쪽), 삭제 종단 거절 코드 5종, 신호 시퀀스 A·B 의 반환 상한(`+2×grace`), 다회 git 쓰기 단계의 절대 상한(마감+6s, 호출 수 무관), 종료 대기 7s, gen ABA 재현 테스트. §3C 추가 인수: worktree 잡 중 worktree remove 409 `job_busy`, `repoLock` 대기 상한·등록 실패 시 반납·디렉터리 정리, stdin 기록 replay 거절, commentChar=auto/commentString 정규화, §3C-3 표의 성공·실패·충돌·취소·`index_locked`·재부착 e2e. §3D 추가 인수: 두 칸 동시 실행(push 중 commit)·pull 의 두 칸 점유·common dir 키 배타(링크드 worktree add ↔ 주 저장소 remove), Job `slots` 필드, 값 플래그 하위 명령별 제외(붙은 형태 포함, `branch -m` 뒤 인자 검사), resolve skipped·코드 우선순위, 모든 동기 쓰기의 lock 필드, 종료 시 `server_shutdown`·7s 상한, undo 발급이 완료 처리 마지막. §3J 추가 인수: 밖에서 지운 worktree 의 remove 성공(사용자·Run 격리), 존재·부재 경로의 키 동일성, remove 가 stash 를 막지 않음, 요청=대상 remove 의 unsafe_path residue, 목록 갱신 뒤 oid 선택 유지. §3I 추가 인수: stash/show 가 oid 로 직접 조회(위치 창 없음)·requested `{repo,oid}`·사라진 oid 409 본문, stash branch 409 에 options 없음·다이얼로그 오류, 요청 worktree 의 index 잡 중에도 remove 허용(대상 index 잡이면 409). §3H 추가 인수: stash branch 기존 이름 409 `branch_exists`, remove 중 주 저장소 동기 쓰기 비차단(§3I-4), stash 쓰기 기록 replay 400, `index` 필드·쿼리 400, stash/show 의 oid 조회·사라진 oid 409. §3G 추가 인수: worktree remove 중 다른 worktree 의 stash 가 막히지 않는 것(§3J-2 — common-dir 잠금 없음), 대상 worktree index 잡 중 remove 409(§3I-4), 위치가 밀린 oid 의 pop 성공·사라진 oid 409, index 필드 400, stash branch 충돌 시 pop 과 같은 세 필드와 안내문 분기, 배타 상태 단일 인스턴스(Run 격리 Remove 와 사용자 쓰기 배타). §3F 추가 인수: 두 worktree 탭에서 stash push 와 pop 이 겹쳐도 확인한 oid 가 pop 되는 것, worktree remove 의 §3I-4 순서, 심링크 경로 저장소의 잡 완료 후 캐시 무효화, Run 격리 Remove 의 사용 중 잔여물 보고. §3E 추가 인수: pull 진행 중 `/api/git/jobs` 에 한 번만 나오고 pull 종료 시 두 칸이 모두 비는 것, `slots` 기반 잠금, 두 worktree 탭의 동시 stash 동작에서 oid 불일치 없음(stash 는 전부 동기·`stash@{n}` — §3F-1), common dir 키 정규화(`/var`↔`/private/var`), worktree remove 의 대상 index 칸 409·잠금 순서(§3I-4), 종료 단계 인덱스 0·cancel 선호출(신호 없는 오류 종료 포함), `gitCodes` 등록.
- `go test -race ./internal/...` 전체 통과, `make gates lint typecheck unit` 통과.
- 영향받는 e2e(git-commit, git-branch-actions, git-hunk, git-diff, git-stash 등 해당 spec) 통과.
