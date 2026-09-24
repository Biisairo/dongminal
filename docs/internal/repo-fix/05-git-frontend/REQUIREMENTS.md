# 요구조건: git 프런트(패널·Diff·커밋·히스토리·브랜치·원격) 근본 수정 — IEEE 29148 (StRS)

> 문서 상태: 승인(사용자 인터뷰 2026-09-24) · 사전 공격 검증(`tmp/preattack-02-05.md`) 반영 — §3A · 입력 → sdd-tdd 워크플로우
> 우선순위: **§3A > §3 본문**. 본문 중 §3A 와 모순되던 문장(F-1.1·F-1.2·F-2 전부·F-4.1·F-4.2·F-6.1·F-7.2·F-7.4·F-9.1~F-9.4)은 직접 정정했다.
> 근거: `tmp/REPO_AUDIT_2026-09-24.md`(P0 #1·#2·#4·#6, P1 #33~#44, P2 git 패널·git 기능), `tmp/verify-frontend.md`(판정, 신규 N3·N4·N5), `tmp/preattack-02-05.md` §0·§4.
> 선행: 01(쓰기 수명·**잡 전환과 그 프런트 진행/취소/결과 UI**·stash oid·amend 메시지 전용 — 중복 구현 금지, 경계는 §3A-1), 03(문서 레지스트리·문서 저장·인코딩 계약·비동기 적용 장치 — 재사용), 04(status 응답 `mark` — 재사용).

## 1. 목적과 범위
- 포함: `web/js/git/**`, `web/js/core/app-git.js`, `app-polling.js`, `constants-git*.js`.
- 서버 변경: **없다.** status `mark` 는 04, diff-content `encoding` 파라미터와 파일 쓰기 인코딩은 03, 잡 전환과 잡 결과 페이로드는 01 이 이미 만든다. 05 가 서버 응답 필드가 더 필요하다고 판단하면 스펙 작성자는 플래그를 올리고 멈춘다.
- 비포함: 01~04 에서 이미 다룬 항목. 특히 01 이 담당하는 잡 UI(§3A-1 표 왼쪽 열)는 다시 만들지 않는다.

## 2. 근본 원인
1. **응답 도착 후 재확인 누락**: 쓰기 전에 출발한 status 가 쓰기 결과를 덮고(#41), Diff 저장 왕복 중 입력이 사라지며(#4), 편집 중 대상 전환이 막히고(#2), amend 조회·커밋 완료가 대상 변경을 확인하지 않는다(#35, N3).
2. **경로·루트 키 불일치**: 창 루트(요청한 경로)와 저장소 최상위(서버가 푼 루트)를 섞어 쓴다(#6, #43).
3. **선택 범위 계약 불일치**: 확인창이 보여준 대상과 실행 대상이 다른 함수로 계산된다(#1).
4. **실패·거절이 무음**: 공유 플래그(`_writing`, remote busy, 열린 확인창)에 걸린 조작을 사유 없이 버린다(#39, #40, N5).
5. **한 저장 슬롯에 두 의미**: 사용자 draft 와 amend 메시지가 같은 슬롯(#34).
6. **같은 파일에 버퍼가 둘**: Diff 뷰가 편집기 문서와 별도 모델(URI 없음)로 같은 파일을 편집한다 — dirty·저장·인코딩·경합 검사가 두 벌이다(N4, X2).

## 3. 요구조건 (각 항목 이전/새 동작 기록, TDD)

### F-1 확인한 것만 실행 (#1 ✅)
- F-1.1 모든 파괴적 메뉴 동작은 확인창에 표시할 대상과 실행 대상을 **같은 계산 결과**로 쓴다 — 메뉴 틀이 확인 전에 대상을 한 번 계산해 확인창에 보이고 그 배열을 실행에 넘긴다. "Delete both" 는 확인창·실행 모두 한 쌍이다(§3A-2).
- F-1.2 `destructive:true` 또는 `warn:true` 인 모든 메뉴 항목의 실행이 전달받은 대상 배열만 쓰는지 테스트로 고정한다.

### F-2 Diff 뷰 편집 — 편집기 문서 모델 공유 (#2 ✅, #4 ✅, N4, P2 Cmd+S 누적, 사용자 결정: VS Code 방식)
- F-2.1 편집 가능한 축(`GIT_AXIS_EDITABLE`)에서 Diff 뷰의 작업 트리 쪽은 **03 의 문서 레지스트리가 가진 그 파일의 문서 모델**이다. Diff 뷰는 그 문서의 뷰로 등록·해제된다. 같은 파일을 편집기 탭과 Diff 뷰에서 동시에 열면 한쪽에서 친 글자가 다른 쪽에 즉시 보인다.
- F-2.2 dirty·저장·인코딩·경합 검사(stamp)·저장 대기(03 E-9.3)는 문서 하나에 있다. Diff 뷰의 자체 저장(`/api/file/write` 직접 호출)은 없어지고 Cmd+S 는 문서 저장을 부른다. 저장 왕복 중 편집은 03 의 규칙(E-3.1, §3A-7)으로 보존된다.
- F-2.3 비 UTF-8 파일(CP949·Shift_JIS·Windows-1252·UTF-16 BOM 등)도 Diff 뷰에서 편집·저장할 수 있다 — 문서가 인코딩을 알고 저장이 그 인코딩으로 되돌려 쓴다. 원본 쪽은 03 의 diff-content `encoding` 파라미터로 받는다. 디코드 불가 문서(`decodable:false`)는 읽기 전용 + 사유.
- F-2.4 dirty 중 다른 파일을 선택할 때, Diff 뷰가 그 문서의 마지막 뷰면 저장/버리기/취소 확인을 받은 뒤 전환하고, 다른 뷰가 그 문서를 들고 있으면 확인 없이 전환한다(편집 내용은 문서에 남는다). 머리·본문·hunk 목록이 항상 같은 대상을 가리키고, hunk 동작은 화면에 보이는 대상에만 적용된다.
- F-2.5 git Diff 탭 라벨의 ● 는 공유 문서의 dirty 에서 파생한다(03 E-6.1 의 짝 — `tab.dirty` 필드 없음).
- F-2.6 저장 단축키는 모델 교체마다 누적되지 않고, Diff 뷰가 둘이어도 포커스된 뷰의 문서가 저장된다.

### F-3 루트와 저장소 최상위 (#6 ✅, #43)
- F-3.1 Changes·Diff·Console·Blame 등 모든 절대경로 계산은 **어휘적 저장소 최상위**(요청 루트에서 계산 — §3A-4) 기준으로 한다. 창 루트가 저장소 하위 폴더여도 Diff 저장·파일 열기가 올바른 경로를 쓴다. 이 경로는 03 문서 레지스트리의 키와 같아야 한다(같은 파일에 문서가 둘 생기지 않는다).
- F-3.2 응답의 대상 대조는 `requested`(요청한 값)로 한다(`api.js` 주석 규약). Console 탭이 하위 폴더·심링크 루트에서 기록을 보인다.
- F-3.3 머리의 저장소 이름은 상위 저장소 이름을 표시한다(FR-RTU-24).

### F-4 쓰기와 관측의 순서 (#40, #41, P2 행 discard 후 Diff)
- F-4.1 쓰기 세대를 두어, 쓰기 이전에 출발한 status 응답은 쓰기 결과를 덮지 않는다(01 의 서버 보장 R-3.3 과 짝). 01 이 잡으로 옮긴 쓰기는 **잡 시작과 잡 완료가 각각** 세대 경계다(§3A-5).
- F-4.2 동기로 남은 stage/unstage/discard(01 §3B-1) 연타는 버리지 않고 저장소 단위 큐로 직렬 전송한다. 다른 칸의 쓰기에 무음으로 막히지 않는다. 409 `job_busy`·`repo_busy`·`index_locked` 는 01 의 사유 표시를 쓴다(§3A-5).
- F-4.3 파일 단위 쓰기 뒤 열려 있는 Diff 는 즉시 다시 받는다(hunk 경로와 같게).

### F-5 hunk·blame 최신성 (#44, P2 blame)
- F-5.1 외부 변경으로 diff 가 다시 그려지면 hunk 목록·diffId 도 함께 갱신되어 툴바가 낡은 조각을 쓰지 않는다.
- F-5.2 작업 트리 파일의 Blame 은 파일 저장·새로고침·외부 변경 때 다시 받는다. 조회 실패는 재시도 가능하다.

### F-6 Changes 행 상태 (#42, P2 _notRepo·워치독·git init)
- F-6.1 status 응답의 `mark`(04 가 추가, 04 §3A-0 X5)가 직전 적용분과 같으면 Changes 전체 재조정을 건너뛴다. 행 서명(reconcile 키)은 표시에 쓰이는 모든 필드(서브모듈 상태 등)를 포함하며 표시 필드와 서명 필드를 한 정의에서 파생한다.
- F-6.2 비저장소 판정(`_notRepo`)은 관측기(공유 상태)에 두어 같은 루트의 모든 칸이 같은 화면을 본다. 비저장소 루트에서 워치독이 폴링을 되살리지 않는다.
- F-6.3 git init 실패 사유(서버 메시지)를 사용자에게 표시한다.

### F-7 커밋 입력 (#33, #34, #35, N3, P2 300ms·Reset)
- F-7.1 preflight(detached·진행 중 작업 등)는 커밋 직전·HEAD 변경 관측 시 다시 받는다. detached 경고가 현재 HEAD 를 반영한다(FR-GIT-87).
- F-7.2 사용자 draft 와 amend 메시지는 별도 슬롯이다. amend 중 편집은 draft 를 덮지 않고, amend 해제·성공 후 원 draft 가 복원된다. **amend 메시지는 일시적이다** — 저장하지 않는다(사용자 결정). 새로고침하면 amend 가 해제되고 원 draft 가 보인다.
- F-7.3 amend 메시지 조회 왕복 중 입력이 있으면 도착한 메시지로 덮지 않는다(N3).
- F-7.4 커밋은 01 에서 잡이다. 잡 진행 중 저장소를 바꿨다 돌아와도, 잡 완료 후처리는 **커밋을 시작한 저장소 키**로 한다 — 성공한 커밋의 메시지는 그 저장소 draft 에서 지워지고 재커밋 되지 않는다(§3A-6).
- F-7.5 저장소 전환 시 대기 중인 draft 저장은 취소가 아니라 즉시 반영(flush)한다.
- F-7.6 Reset soft/mixed 다이얼로그는 결과를 기다려 실패 시 닫지 않고 사유를 보인다(FR-GIT-175).

### F-8 History (#36, #37, P2 Compare·부모 해시)
- F-8.1 저장된 ref 필터가 더 이상 없으면(삭제·rename) 필터를 해제하고 사유를 표시한다. 로드 실패가 반복 고착되지 않는다.
- F-8.2 검색어가 해시·ref 로 해석되면 이전 `--grep` 조건을 비운다.
- F-8.3 Compare 기준 표시는 reload 에도 유지된다(`panel.compareMark` 와 표시가 일치).
- F-8.4 상세의 부모 해시 클릭은 로드 범위 밖이어도 찾아간다(`_jumpTo`). 펼친 상세 높이를 스크롤 계산에 반영한다.

### F-9 브랜치·원격·stash 피드백 (#38, #39, N5, P2 job 성공 오표시·이름 검증)
- F-9.1 "Stash 후 checkout" 은 동기 stash push 뒤 checkout **잡**(01)이다. stash 실패는 조작한 화면에 사유를 보이고 checkout 을 시작하지 않는다. checkout 이 실행 전 거부되거나 잡이 실패·취소·결과 미상으로 끝나면 01 의 잡 결과 표시에 더해 "변경은 stash 에 남아 있다" 안내를 조작한 화면에 보인다(§3A-7).
- F-9.2 같은 저장소에 잡이 진행 중이면, 01 §3B-2 배타 행렬상 거절될 메뉴 항목은 비활성 + 사유다(원격 잡 중의 push·tag push·fetch-into·remote delete 포함).
- F-9.3 이미 열린 확인창·다이얼로그가 있을 때 새 요청은 기존 창을 앞으로 가져와 포커스한다(새 창을 띄우지 않음). 첫 정책 조회 중 두 번 눌러도 확인창이 겹치지 않는다.
- F-9.4 잡의 `done` 결과가 보존 기간(`JobRetention` 5분, `jobs/job.go:32`)이 지나 `{id, done:true}` 만 오면 **성공으로 칠하지 않고 "결과 알 수 없음"** 으로 표시한다. 성공은 `exitCode===0` 이 명시된 경우만이다. 이 판정은 원격 잡과 01 이 전환한 모든 잡에 같다.
- F-9.5 브랜치·태그 이름 검증은 입력이 바뀔 때마다 세대를 올려, 이전 이름의 응답이 현재 입력의 실행 버튼을 열지 않는다.

## 3A. 확정 사항 (사전 공격 검증 `tmp/preattack-02-05.md` 반영, 2026-09-24)

아래는 §3 의 모호점을 확정한다. **충돌 시 이 절이 본문보다 우선한다.** 근거 file:line 은 2026-09-24 작업 트리(`ed2e4e39`) 기준이다.

### §3A-0 문서 간 계약
| # | 계약 | 짝 문서 |
|---|------|---------|
| X1 | git Diff 탭 ● = 공유 문서 dirty(F-2.5). 03 이 `tab.dirty` 를 폐기하고 `_setDiffDirty`(`panel-diff.js:925-933`)의 쓰기를 없앤 상태에서, 05 는 파생 원천을 Diff 뷰 `_dirty` → 문서 dirty 로 바꾼다 | 03 E-6.1 |
| X2·X3 | Diff 뷰는 자기 쓰기 경로를 없애고 03 의 문서 저장(인코딩·BOM·stamp 포함)을 쓴다. 원본 쪽은 03 의 diff-content `encoding` 파라미터(03 §3A-3)를 쓴다 | 03 E-1.7 |
| X5 | 관측 동일성은 status 응답의 `mark`(04 가 추가) 하나로 판정한다. 05 는 별도 동일성 판정을 만들지 않는다 | 04 T-8.1 |
| X6 | 01 이 잡으로 옮긴 쓰기(commit·checkout·merge·rebase·cherry-pick·revert·drop·branch 생성+checkout·stash branch·worktree add·진행 중 작업의 continue/skip/abort — 01 §3B-1)와 그 프런트 진행/취소/결과 UI 는 01 담당이다. 05 는 §3A-1 표의 오른쪽 열만 한다 | 01 R-2.6·§3B-5 |
| — | 03 의 비동기 적용 토큰(03 §3A-5)·문서 레지스트리 뷰 규약·문서 저장 대기(03 E-9.3)를 재사용하고 같은 목적의 장치를 새로 만들지 않는다 | 03 E-3.1 |

### §3A-1 01 과의 경계 (X6)
| 01 담당 — 05 는 재구현하지 않는다 | 05 담당 — 01 위에 얹는다 |
|---|---|
| 잡 종단 응답 `{requested, repo, job}` 처리, 진행 스트림·취소·결과 문구(`web/js/git/remote.js` 잡 UI, kind 라벨 `GIT_REMOTE_LABEL` — 01 §3B-5 k) | 관측기 쓰기 세대(`writeGen`)를 잡 시작·완료 시점에 올리기(§3A-5). 01 의 잡 UI 에 시작·완료 통지 자리가 없으면 그 자리에 통지 호출 한 줄만 더한다 |
| 충돌로 멈춘 잡의 "진행 중(충돌)" 표시(01 §3B-5 i) | 커밋 잡 완료 후처리의 저장소 키 고정(F-7.4, §3A-6) |
| undo 토스트(01 §3B-5 f), 잡 완료 시 status 반영(01 R-2.6) | "Stash 후 checkout" 의 stash 잔존 안내(F-9.1, §3A-7) |
| `index_locked` 사유·"남은 lock 지우기"(01 §3B-4), `job_busy`·`repo_busy`·`stash_moved` 사유 문구 | 결과 미상 판정(F-9.4) — 01 §3B-5 j 에 이 판정이 없다(2026-09-24 기준). 01 스펙이 같은 판정을 넣으면 05 는 그것을 쓰고 테스트만 더한다 |
| 동기 쓰기 fetch 시한 `GIT_WRITE_FETCH_TIMEOUT_MS`=100000(01 §3B-3), stash oid 전달(01 R-6.1), amend 메시지 전용 커밋 버튼 판정(01 R-11) | stage/unstage/discard 큐(F-4.2), 잡 진행 중 메뉴 비활성(F-9.2), 확인창 중복(F-9.3) |

### §3A-2 확인한 것만 실행 (F-1)
사실: 메뉴 확인창 대상은 `targets(t)`(`menu.js:235-238`), 실행은 `delBoth` → `targetsOf(panel, pair.local)`(`branches-ops.js:381-387`, `:187`) — 다중 선택 전체로 확장된다. 확인 틀은 `GitMenu._pick`(`menu.js:429-443`) 한 곳이며 `run(target)` 에 계산된 대상을 넘기지 않는다.

| 항목 | 확정 |
|------|------|
| 구조 | `GitMenu._pick` 은 확인 전에 `targets(target)` 을 한 번 계산해 확인창에 보이고, 같은 배열을 `run(target, targets)` 로 넘긴다. 파괴적 항목의 `run` 은 전달받은 배열만 실행하고 선택 상태를 다시 읽지 않는다 |
| Delete both | 확인창·실행 모두 한 쌍(`pairOf`) |
| 고정 | `destructive:true`·`warn:true` 인 모든 메뉴 항목에 대해 "선택을 바꾼 뒤 확인해도 확인창에 보인 대상만 실행" 테스트(항목 목록을 메뉴 정의에서 열거해 누락 없음) |

### §3A-3 Diff 뷰 — 문서 모델 공유 (F-2, 사용자 결정)
사실: Diff 뷰 모델은 URI 없는 `createModel`(`diff-view.js:390-391`), 이전 모델은 `_dropModels` 로 dispose(`:395`), 저장은 stamp·인코딩 없이 `/api/file/write`(`:447-458`), 성공 시 `_dirty=false` 무조건(`:454`), Cmd+S 는 `addCommand` 로 모델 교체마다 누적(`:437`). FileEditor 는 키바인딩 계층을 쓴다(`file-editor.js:535-540`, FR-EKB-5). dirty 중 선택 전환은 조용히 무시(`panel-diff.js:797`). 문서 레지스트리 `edDoc/edDocDrop`(`app-editor-open.js:78-108`).

| 항목 | 확정 |
|------|------|
| 적용 축 | `GIT_AXIS_EDITABLE` 인 축에서만 공유한다. 그 밖 축은 현행대로 양쪽 모두 Diff 뷰 자체 모델(읽기 전용) |
| 획득 | 대상 선택 시 절대경로(§3A-4)로 문서를 획득하고 Diff 뷰를 그 문서 뷰로 등록한다. 문서가 아직 로드되지 않았으면 03 의 문서 로드(`decode=1`)를 기다린다. 로드 뒤 문서 인코딩을 `encoding` 파라미터로 실어 diff-content 의 원본 쪽을 받는다. 두 비동기 단계 모두 03 토큰 규칙 적용 |
| 작업 트리 쪽 | `modified` = 문서 모델. diff-content 응답의 작업 트리 쪽 본문은 편집 가능 축에서 쓰지 않는다. 문서가 dirty 면 Diff 는 저장 전 버퍼와 원본을 비교한다(VS Code 와 같음) |
| 해제 | 대상 전환·Diff 뷰 파괴 시 `edDocDrop(path, 이 뷰)`. Diff 뷰는 공유 모델을 dispose 하지 않는다(`_dropModels` 대상은 자체 원본 모델만) |
| 전환 확인 | dirty 문서에서 다른 대상을 고를 때: 문서 뷰가 Diff 뷰 하나뿐이면 저장/버리기/취소 3지선다(취소면 선택을 원래 행으로 되돌림, 버리기는 문서 해제 — 디스크 불변), 다른 뷰가 있으면 확인 없이 전환 |
| 탭 닫기 | git Diff 탭 닫기는 Diff 뷰를 문서 뷰에서 빼는 것이다. 마지막 뷰이고 dirty 면 편집기 탭 닫기와 같은 확인을 거친다 |
| 저장 | Cmd+S·저장 버튼 = 03 문서 저장(인코딩·BOM·stamp·409 흐름·저장 대기). `diff-view.js:447-458` 의 자체 저장 제거 |
| 단축키 | `addCommand` 대신 FileEditor 와 같은 키바인딩 계층(FR-EKB-5)에 에디터 인스턴스당 1회 등록하고, 실행 시 포커스된 Diff 뷰의 문서를 저장한다 |
| dirty·라벨 | Diff 뷰 `_dirty`·`onDirty`·`_setDiffDirty` 는 문서 dirty 파생으로 대체(F-2.5) |
| 외부 변경 | 작업 트리 쪽은 03 의 문서 refresh 가 갱신한다. Diff 뷰는 `git_changed`·쓰기 뒤에 원본 쪽과 hunk 목록만 다시 받는다 |
| 경로 이동 | 03 `edDocMove` 의 모델 교체 통지를 받으면 새 문서 모델로 diff 모델을 다시 짠다 |
| 인코딩 | 문서 `decodable:false` 면 작업 트리 쪽 읽기 전용 + 사유. utf-16 문서는 hunk 툴바 비활성 + 사유(git 이 바이너리로 본다 — 03 §3A-3) |
| hunk 와 dirty | 문서가 dirty 인 동안 hunk 툴바(stage·unstage·revert hunk)는 비활성 + 사유 "저장한 뒤 사용할 수 있다" — 화면의 diff(버퍼 기준)와 서버 hunk(디스크 기준)가 다르기 때문이다 |

동작 기록 — 이전: Diff 뷰는 별도 버퍼로 편집하고 stamp·인코딩 없이 UTF-8 로 써서, 같은 파일을 연 편집기와 서로의 입력이 보이지 않았고 비 UTF-8 파일은 저장 시 손상됐다 / 새: 편집기 문서 모델을 공유 / 이유: 사용자 결정(VS Code 방식), 파일 하나에 문서 하나(FR-SVS-50 의 확장).

### §3A-4 경로 기준 (F-3)
사실: 서버는 `requested`·`repo`·`rootMatch`·`requestedResolved` 를 준다. 탐색기가 이미 이 값으로 접두를 계산한다(`file-tree-paint.js:518-558` `_prefixOf`). 서버의 `repo` 는 심링크를 푼 값이라 편집기 경로와 다를 수 있다 — 그 값으로 열면 같은 파일에 문서가 둘 생긴다(03 문서 키가 경로 문자열). Console 은 `d.repo!==repo` 로 대조(`console.js:107`).

| 항목 | 확정 |
|------|------|
| 절대경로 | 파일 절대경로 = 어휘적 저장소 최상위 + 상대경로 |
| 어휘적 최상위 | 요청 루트(`requested`)에서 `_prefixOf(repo, requestedResolved)` 만큼 올라간 경로. `rootMatch` 면 요청 루트 그대로. 서버가 푼 `repo` 는 편집기 경로로 쓰지 않는다 |
| 공용화 | `_prefixOf` 를 탐색기와 git 프런트가 함께 쓰는 헬퍼로 옮긴다(한 함수) |
| 대조 | 응답 대조는 `requested` 로만 한다(`console.js:107` 포함) |

### §3A-5 쓰기 세대·동기 쓰기 큐 (F-4)
사실: `_writing` 은 관측기 소유(`panel.js:119`, `observer.js:44`). stage 등은 `_writing` 이면 무음 반환(`panel-files.js:20,28,41,220`). `collect` 는 seq·again 이 있으나 쓰기 세대가 없다(`panel-poll.js:446-475`).

| 항목 | 확정 |
|------|------|
| `writeGen` | 관측기(저장소 단위, 칸 공유)에 둔다. 동기 쓰기 POST 시작, 잡 시작(`{job}` 수신), 잡 완료(`done` 수신 — 성공·실패·취소·결과 미상 모두)가 각각 +1 |
| status 적용 | `collect` 는 보낼 때의 `writeGen` 을 기억하고, 도착 시 값이 다르면 적용하지 않고 `collect` 를 한 번 더 한다(`_again`) |
| 큐 | stage/unstage/discard 는 관측기의 FIFO 큐로 직렬 전송한다. 버튼은 비활성하지 않는다. 큐 깊이 상한 32, 넘으면 넘친 요청을 버리고 사유 표시 |
| 409 | `job_busy`·`repo_busy`·`index_locked` 를 받으면 큐를 멈추고 01 의 사유 표시(및 `index_locked` 의 lock 버튼)를 쓰며 남은 항목은 버린다(사용자가 다시 누른다) |
| 그 밖 무음 | `_writing` 에 걸린 그 밖의 동기 쓰기 조작은 무음 반환 대신 사유를 표시한다 |
| F-4.3 | 파일 단위 쓰기 성공 뒤 그 경로의 Diff 가 열려 있으면 hunk 경로와 같은 재적재 함수를 부른다 |

### §3A-6 관측 동일성·행 서명·커밋 입력 (F-5, F-6, F-7)
사실: `_notRepo` 는 패널(칸)마다(`panel-poll.js:619`, `panel-changes.js:30`). draft 는 워크스페이스(서버 동기)에 저장(`commit.js:109-127` → `app.save()`), 300ms 디바운스 후 저장소 전환 시 `_reset` 이 타이머를 취소(`commit.js:149`).

| 항목 | 확정 |
|------|------|
| F-5.1 | Diff 본문이 바뀐 회차(`onChanged`)에 hunk 목록과 diffId 를 함께 무효화하고 다시 받는다. 본문과 hunk 가 같은 diffId 가 아니면 툴바 비활성 |
| F-5.2 | 작업 트리 Blame 은 그 파일의 문서 저장·`git_changed`·새로고침 때 다시 받는다. 실패는 재시도 버튼과 사유 |
| F-6.1 mark | status 적용 시 (저장소, `mark`) 가 직전 적용분과 같으면 Changes 재조정을 건너뛴다. `mark:""` 는 비교하지 않는다(항상 적용) |
| F-6.1 서명 | 행 서명은 행을 그리는 데 쓰는 필드 목록 상수 하나에서 파생한다(서브모듈 상태 `sub` 포함). 표시 코드와 서명 코드가 그 상수를 공유 |
| F-6.2 | `_notRepo` 를 관측기로 옮긴다(`_writing` 과 같은 자리). notRepo 면 워치독은 폴링을 되살리지 않고, `git init` 성공·루트 변경만 해제한다 |
| F-7.1 | preflight 는 커밋 직전, 그리고 관측의 HEAD oid·branch·detached 가 바뀐 회차마다 다시 받는다 |
| F-7.2 | amend 슬롯은 메모리에만 둔다 — 워크스페이스 저장·동기화에 싣지 않는다. amend 해제·커밋 성공·새로고침 시 draft 슬롯을 보인다 |
| F-7.3 | amend 메시지 조회는 (저장소, 요청 시 입력 값) 토큰을 잡고, 도착 시 입력이 그 사이 바뀌었으면 넣지 않는다 |
| F-7.4 | 커밋 잡을 시작할 때 저장소 키를 기억한다. `done` 이 성공(`exitCode===0`)이면 그 저장소의 draft 를 비우고, 지금 화면이 그 저장소일 때만 입력칸을 비운다. 실패·취소·결과 미상이면 draft 를 유지한다 |
| F-7.5 | `_reset` 은 대기 중 draft 저장 타이머를 취소하지 않고 즉시 실행(flush)한 뒤 전환한다 |
| F-7.6 | Reset soft/mixed 다이얼로그는 요청 완료까지 버튼을 진행 표시로 두고, 실패 시 닫지 않고 서버 사유를 표시한다 |

### §3A-7 History·브랜치·원격 (F-8, F-9)
사실: 스트림 재연결 시 작업이 보존 기간을 넘겨 사라졌으면 서버는 `{id, done:true}` 만 준다(`handlers_git_remote.go:299-306` `gitJobFinal`). 실제 Job 은 `exitCode` 를 항상 싣는다(`jobs/job.go:99`, omitempty 아님). 클라 판정은 `!exitCode&&!err` 라 성공으로 칠한다(`remote.js:206,217`). "Stash 후 checkout" 은 `branches-ops.js:21-40`(stash push → `afterStashWrite` → `_send`).

| 항목 | 확정 |
|------|------|
| F-8.1 | 저장된 ref 필터가 refs 목록에 없으면 필터와 저장값을 지우고 사유를 1회 표시 |
| F-8.2 | 검색어를 해시·ref 로 해석한 요청은 `grep` 파라미터를 싣지 않는다 |
| F-8.3 | reload 후 `compareMark` 가 로드 범위에 있으면 표시를 다시 입힌다 |
| F-8.4 | 부모 해시가 로드 범위 밖이면 `_jumpTo` 로 그 커밋까지 추가 로드 후 이동. 펼친 상세 높이를 스크롤 계산에 포함 |
| F-9.1 | stash push 실패 → 사유 표시, checkout 미시작. stash 성공 후 checkout 이 실행 전 거부(4xx·409)되거나 잡이 실패·취소·결과 미상 → 조작한 화면에 "변경은 stash 목록 맨 위(메시지 `GIT_STASH_BEFORE_MSG`)에 남아 있다" 안내 + stash 목록 재수집. 잡 결과 문구 자체는 01 UI |
| F-9.2 | 잡 진행 중인 저장소에서 메뉴 항목의 `disabled:` 는 01 §3B-2 행렬로 판정한다 — index 잡 진행 중: 잡 시작 항목과 동기 쓰기 항목 모두 비활성, 비-index 잡 진행 중: 잡 시작 항목만 비활성. 사유 문구는 `job_busy` 의 사용자 문구(메뉴 틀의 사유 표시 사용) |
| F-9.3 | 확인창·다이얼로그가 열려 있으면 새 요청은 기존 창을 앞으로 가져와 포커스한다. 정책 조회 중 두 번째 호출은 첫 호출의 Promise 를 공유한다 |
| F-9.4 | `done` 판정: `canceled` 참 → 취소. `exitCode` 가 숫자이고 0 이며 `err` 없음 → 성공. `exitCode` 가 0 이 아니거나 `err` 있음 → 실패. `exitCode` 키가 없음 → **결과 미상**: 중립 문구("작업이 끝났지만 결과를 알 수 없다 — 보관 기간 5분이 지났다. 상태를 확인하라") + status·stash·원격 목록 재수집 + `writeGen` +1. 성공 후처리(undo 토스트·draft 비우기)는 하지 않는다 |
| F-9.5 | 이름 검증은 입력마다 `nameGen` +1, 응답은 gen 이 같을 때만 실행 버튼 상태에 반영 |
| 추적 | 스펙 산출물로 "감사 # ↔ 요구 ID ↔ 테스트 ID" 표를 싣는다(X8) |

### §3A-8 구현 중 정정·추적표 (구현 완료 2026-09-24)

구현 중 정정:
- F-1 Clean: 서버(`/api/git/uncommitted/clean`)는 대상 목록을 받지 않고 그 순간의 untracked 전부를 지운다. 서버 변경 금지(§1)라 클라이언트가 확인 뒤 목록이 바뀌었으면 보내지 않고 사유를 보인다. **남은 틈(플래그)**: 클라이언트의 마지막 관측과 서버의 실행 시점 사이에 생긴 untracked 는 보인 적 없이 지워질 수 있다 — 막으려면 서버가 `paths` 를 받아 그것만 지워야 한다(별도 결정 필요). → **해소(마무리 후속, 사용자 결정 "paths 필수 + 집합 검사")**: 서버가 `paths` 를 필수로 받아 실행 직전 status 의 untracked 와 집합이 다르면 409 `stale_observation`, 같으면 그 경로만 지운다(GIT_ACTIONS_SRS FR-GIT-277 개정). 클라이언트는 확인창 목록을 `paths` 로 싣는다.
- F-1 대상이 확정 객체(`t`)에서 오는 항목(drop·stash drop·checkout·tag·rebase)은 실행이 그 객체를 쓰고 선택 상태를 다시 읽지 않으므로 바꾸지 않았다. 선택을 읽던 셋(로컬 Delete·Delete both·Clean)만 확인창 배열로 실행한다.
- F-2 문서 저장은 FileEditor 안에 있었다 — `app.edDocSave(path, ui)`(대기 1건 포함)·`edDocWrite`·`edConfirmConflict` 로 문서 단위로 올렸고 FileEditor·Diff 뷰가 같은 것을 부른다. Diff 뷰는 문서 레지스트리에 자신이 아니라 대상마다의 작은 뷰 객체(`_docViewOf`)로 든다 — 레지스트리는 `_editor.setModel(model)` 을 부르는데 diff 에디터는 모델 둘을 받기 때문이다(`gazeEditor`·`onDocMoved`·`onDocReadOnly` 로 대신한다).
- F-2 닫기·창 닫기의 확인은 "그 뷰가 떠나면 편집을 잃는가"(마지막 뷰)로 묻고, 탭 ● 는 문서 dirty 로 묻는다 — `viewDirty(view, closing)` 로 둘을 나눴다. 앱 전체 dirty(`edAnyDirty`, 떠남 확인)는 문서를 먼저 본다(Diff 만 연 문서).
- F-2 dirty 중에도 Diff 는 다시 받는다 — 작업 트리 쪽이 문서 모델이라 원본 쪽만 바뀐다(이전의 "편집 중 다시 읽지 않음" 가드는 걷었다). 바깥 변경은 라이브 리로드 표식 폴링이 나르며, Diff 탭의 문서도 그 대상에 넣었다(`_gitDiffDocPaths`, 회귀 수정 `a719bc25`).
- F-2 비범위로 남긴 것: 옛 Git 창에서 저장소를 바꾸면 Diff 뷰가 `clear` 되며 마지막 뷰인 dirty 문서가 확인 없이 버려진다(이 작업 이전에도 같았다). → **도달 불가로 판정(마무리 후속)**: 옛 Git 창은 로드(`app.js` `_migrateGitWindow`)와 매 동기화(`app-cmd.js`)에서 `migrateGitWindows` 가 지우고 만드는 경로가 없다. `setRepo` 의 호출은 `setRepo(null)` 둘(소실 핀 제거·not_a_git_repo)뿐이며 둘 다 그 창 전용이다 — 코드를 더하지 않는다.
- F-3 `_prefixOf`(탐색기)·`edDdPrefix`(변경 표시)가 같은 함수 두 벌이었다 — `core/git-path.js` 의 `gitRepoPrefix` 하나로 모으고 어휘적 최상위 `gitLexicalTop` 을 곁에 뒀다(helpers.js 는 최대 파일이라 따로 둔다). 중첩 저장소·서브모듈 진입점(`_dirEntryActs`)도 같은 결함이라 함께 고쳤다.
- F-4 잡 시작·완료 통지 자리는 `GitRemote._attach`·`_finish` 한 줄씩이다. 큐는 stage/unstage/discard 만 탄다 — resolve(ours/theirs)·ignore·uncommitted reset/clean·hunk 는 큐 밖의 동기 쓰기이고, 막혔을 때 무음 대신 `repo_busy` 사유를 보인다.
- F-5.1 diff-content 응답에는 diffId 가 없다(서버 변경 금지) — "본문과 hunk 가 같은 diffId" 는 **본문 회차**로 대신한다: 본문이 바뀐 회차에 조각 목록을 버리고 곧바로 다시 받으며, 받는 동안 `_hunks` 가 비어 동작이 서지 않는다. 그 사이 디스크가 또 바뀌면 서버의 diffId 409 가 마지막 방어다.
- F-6.1 쓰기 응답에는 mark 가 없어 `adopt` 는 근거를 비운다 — 쓰기 뒤 첫 관측이 한 번 더 칠한다(행은 reconcileList 라 싸다).
- F-7.4 결과 미상 판정이 필요해 `panel._jobRes` 의 성공을 `gitJobOutcome(jb)==='ok'` 로 먼저 바꿨다(F-9.4 와 한 함수).
- F-8.3 Compare 기준 표시는 바의 한 줄(`_note`)이라 로드 범위와 무관하게 유지한다.
- F-9.2 (정정) 01 §6.4 "진행 중 잠금" 표가 기준이다 — index 칸이 돌면 동기 쓰기·index 잡 시작, common 칸이 돌면 **비-index 잡 시작만** 막는다(본문의 "비-index 잡 중 잡 시작 항목 전부" 는 01 행렬·"push 중 commit 허용" 결정과 어긋난다). 항목마다 `busy`(잡 키 또는 'write')를 선언하고 `GitMenu._why` 가 `gitJobSlotsOf` 로 판정한다. 사유 문구는 `job_busy` 의 사용자 문구.
- F-9.3 (정정) "정책 조회 중 두 번째 호출은 첫 호출의 Promise 를 공유" 는 이중 실행을 만든다(메뉴는 답을 받은 뒤 스스로 실행한다) — 두 번째 호출은 창을 띄우지 않고 열린 창을 앞으로 가져온 뒤 `false`(실행 안 함)다.
- F-9.5 세대는 요청 때만 올랐다 — 입력마다 올린다(echo 는 같은 이름의 응답이라 막지 못했다).

추적표 (감사 # ↔ 요구 ↔ 테스트):

| 감사 # | 요구 | 테스트 | 커밋 |
|---|---|---|---|
| #1 | F-1 | `web/js/test/git-menu-targets.test.mjs` (파괴적·경고 항목 전수 열거) | `50de3c10` |
| #2 #4 N4 X2 P2(Cmd+S) | F-2 | `e2e/git-diff-doc.spec.ts` S1~S7 | `afe856ee` `a719bc25` |
| #6 #43 | F-3 | `web/js/test/git-top.test.mjs`, `e2e/git-subroot.spec.ts` | `37a2ce04` |
| #40 #41 P2(discard 후 Diff) | F-4 | `e2e/git-write-order.spec.ts` Q1·Q2·W1·D1 | `9e33a09f` |
| #44 P2(blame) | F-5 | `web/js/test/git-hunk-fresh.test.mjs`, `e2e/git-blame-fresh.spec.ts` | `7cb95605` |
| #42 P2(_notRepo·워치독·init) | F-6 | `web/js/test/git-row-sig.test.mjs`, `e2e/git-not-repo.spec.ts` | `200ff7e2` |
| #33 #34 #35 N3 P2(300ms·Reset) | F-7 | `e2e/git-commit-slots.spec.ts` C1~C8 | `501af931` |
| #36 #37 P2(Compare·부모 해시) | F-8 | `e2e/git-history-fresh.spec.ts` H1~H5 | `af3157b1` |
| #38 #39 N5 P2(job 오표시·이름 검증) | F-9 | `web/js/test/git-job-outcome.test.mjs`, `web/js/test/git-feedback.test.mjs`, `e2e/git-feedback.spec.ts` | `b5a7f7ef` |

## 4. 제약
- `make gates lint typecheck unit test` 통과. 영향 e2e(`e2e/git-*.spec.ts` 전체, `repo-tab*`, Diff 편집이 편집기 문서와 공유되므로 `e2e/editor-*.spec.ts` 중 저장·dirty 관련) 회귀 없음. 새 동작에는 e2e 또는 node:test.
- 01·03·04 에서 만든 공통 장치(잡 UI, 문서 레지스트리·저장·토큰, status `mark`)를 재사용하고 같은 목적의 새 장치를 만들지 않는다.
- 커밋 메시지·문서에 AI 서명 금지.

## 5. 인수 기준
- F-* 재현 시나리오가 테스트로 존재하고 구현 후 통과(§3A-7 추적표로 대응).
- e2e: 같은 파일을 편집기 탭과 Diff 뷰에 열고 한쪽 입력이 다른 쪽에 보이며 한 번 저장으로 둘 다 dirty 가 풀림. CP949 파일을 Diff 뷰에서 편집·저장 후 바이트가 CP949(서버 단위 테스트와 짝). Diff 뷰에서 저장 왕복 중 입력 보존. 결과 미상 `done`(`{id, done:true}`)이 성공으로 표시되지 않음. 잡 시작·완료 사이 출발한 status 가 적용되지 않음.
