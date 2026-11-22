# 인계: main 에서 원래 실패하던 e2e 7건 고치기

이 문서는 다음 세션이 바로 착수할 수 있도록 지금 상태를 적는다.

## 1. 작업 위치와 규칙

- 워크트리: `/Users/dykim/personal/dongminal/.claude/worktrees/claude-accounts`
- 브랜치: `fix/e2e-main7`. 출발점은 `e506e094`(main = origin/main, Claude 다중 계정 기능을 합친 커밋)이다.
- 커밋은 사용자가 확인한 뒤에만 한다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다.
- 끝나면 사용자 확인을 받고 main 에 합친다. main 체크아웃(`/Users/dykim/personal/dongminal`)은 `git -C … merge --ff-only fix/e2e-main7` 로 빨리감기한 뒤 `git -C … push origin main` 한다(이번 세션이 그렇게 했다). main 이 그 사이 앞서 나갔으면 먼저 브랜치에 main 을 합치고 시험한다.
- 고치는 순서는 고정이다: 원인 확인 → (동작을 바꾸면) 해당 SRS 개정 → 시험 → 구현 → `make gates`·`golangci-lint`·eslint·typecheck → 고친 시험과 그 주변 e2e.
- **제품 동작을 바꿀지, 시험의 기대를 바꿀지 갈리는 건은 사용자에게 하나씩, 권장 답과 함께 묻는다.** 질문 안에 용어 설명을 넣는다(사용자는 설명 없는 용어를 싫어한다).

## 2. 고칠 것 (7건) — 모두 `710d0ec9`(이전 main)에서도 실패함을 대조로 확인했다

단독 실행(`--retries=0`)에서도 매번 실패한다. 오류는 이번 세션이 2026-11-13 에 본 그대로다.

| # | 시험 | 오류 |
|---|---|---|
| 1 | `e2e/git-history.spec.ts:193` H5 (V50·FR-GIT-125) 폭이 줄면 Commit → Date → Author 순으로 숨는다 | 199행 `expect(cls()).not.toMatch(/hide-hash/)` — 받은 값 `"git-hist-list ui-scroll hide-hash"`. 넓은 폭에서도 `hide-hash` 가 남는다 |
| 2 | `e2e/git-observe-revive.spec.ts:170` TC-GOR-5 딸린 패널 전부가 조건 거짓이면 멈춘다 | 181행 `pollOn` 기대 false, 받은 값 true — "아무도 보지 않는데 폴링이 남았다" |
| 3 | `e2e/git-ui-metrics.spec.ts:163` V81 (FR-GIT-199) 모바일 폭에서도 하한이 지켜진다 | 180행 `#area .pn-body` 가 hidden (15초 대기) |
| 4 | `e2e/git-ui-metrics.spec.ts:191` V82 (FR-GIT-200·201) Git 표면의 버튼 라벨에 한글이 없다 | 205행 한글 라벨 `나란히`·`통합` 이 있다. **주의**: 이 둘은 `UI_POLISH_SRS`(2026-11-11)가 Diff 툴바의 선택 묶음 라벨로 일부러 넣은 한국어다(그 세션 보고: "일반 버튼 라벨을 한국어로, git 용어와 설정 탭 이름은 영어로"). FR-GIT-200·201 과 UI_POLISH 의 결정이 부딪친다 — 어느 쪽을 따를지 사용자에게 묻는다 |
| 5 | `e2e/git-remote.spec.ts:263` R15 (V44 / FR-GIT-105·106) 거부되면 force 가 기본 제안이 아니다 | 300행 `input[type="password"]` 가 1개 남는다(기대 0) |
| 6 | `e2e/ux-batch10.spec.ts:428` diff 나란히 보기에서 원본 쪽 포커스면 찾기가 원본을 찾는다 | 437행 `.git-diff-cm` 에 `side-by-side` 클래스가 없다. 받은 값 `"git-diff-cm"` — 나란히 보기로 바뀌지 않았다. 4번과 같은 Diff 툴바(나란히·통합 선택 묶음 개편)와 관련됐을 수 있다 |
| 7 | `e2e/steady-traffic.spec.ts:57` 30초 동안 ping·stats 와 안전망만 남는다 | 68행 `/api/tools/activity` 6회(기대 0). 같이 센 값: `/api/runs` 6 · `/api/tools/background` 6 · `/api/claude-accounts` 1 · `/api/claude-accounts/mappings` 1 · `/api/git/repos` 1. 5초마다 도는 activity·runs·background 는 상태 등록부(`web/js/core/state-registry.js`)의 `when:(app)=>app._agentsPanelShown()` 이 참일 때만 돈다 — **유휴 화면에서 Activity 패널이 보이는 것으로 판정되는 것이 원인으로 보인다**(확인 안 함). claude-accounts 두 요청도 같은 판정(`claude.accounts` 항목, 30초 주기)에서 나온다. 패널 판정을 고치면 함께 사라져야 한다. 그래도 남으면 시험의 `other` 계산(ping·stats·repos 밖은 0)과 계정 기능의 정상 동작이 부딪치는 것이니 사용자에게 묻는다 |

이전 세션 기록(hippo)에 따르면 1번(H5)과 6번(`ux-batch10:428`)은 UI_POLISH 작업(2026-11-11) 때 이미 "이전부터 실패하던 시험" 으로 남았다.

## 3. 먼저 읽을 것

- 이 문서 §2 의 표.
- 각 시험 파일의 해당 행과 그 시험의 SRS 근거(`docs/internal/` 에서 시험 ID·FR 번호로 찾는다. 예: `grep -rn "FR-GIT-200" docs/internal`).
- 4·6번은 `docs/internal/UI_POLISH_SRS.md` 의 Diff 툴바 결정(FR-UIP-*)과 `git-ui-metrics` 의 FR-GIT-200~202.
- 7번은 `web/js/core/state-registry.js`(`when`·`every`)와 `_agentsPanelShown` 의 정의.

## 4. 이 세션이 값을 치르고 배운 것

- 워크트리에 `node_modules` 가 없다. e2e·eslint·typecheck 는 메인 체크아웃의 것을 잠시 심링크해 돌리고 끝나면 지운다(커밋에 넣지 않는다):
  `ln -s /Users/dykim/personal/dongminal/node_modules node_modules` → `E2E_PORT_BASE=60500 ./node_modules/.bin/playwright test <파일:행> --retries=0 --reporter=line` → `rm node_modules`.
- 포트 뿌리 `E2E_PORT_BASE` 를 바꿔야 다른 실행(사용자 dongminal, 다른 대조 실행)과 부딪치지 않는다. 두 실행을 동시에 돌리면 서로 다른 값을 준다(예: 60500·61500).
- e2e 전량은 `make e2e E2E_PORT_BASE=60500` 이고 10분을 넘는다. Bash 의 `run_in_background` 로 돌리고 끝나는 알림을 기다린다. 결과 로그의 색 코드는 `LC_ALL=C sed 's/\x1b\[[0-9;]*[A-Za-z]//g'` 로 걷는다(그냥 `sed` 는 한글에서 "illegal byte sequence" 로 멈춘다). 실패 목록은 `grep -aE "[0-9]+\) \[chromium\]"`.
- 원래 있던 실패인지 가릴 때는 대조용 작업 트리를 따로 만든다: `git worktree add --detach /tmp/<이름> <커밋>` → 거기서 같은 시험 → `git worktree remove --force /tmp/<이름>`.
- 전량에서만 한 번 실패하고 단독으로는 통과하는 시험이 있다(이번에는 `ui-polish` TC-UIP-5, `editor-ops` O7). 단독 반복(`--repeat-each=4`)으로 가린다.
- macOS `sed` 는 `\b` 를 모른다. 낱말 경계 치환은 `perl -pi -e`.
- `ui/`·`git/` 은 App 의 `_` 메서드를 부를 수 없다(`make gates` 의 프론트 계층 검사). 화면이 부를 메서드는 `_` 없이 만든다.
- `web/js/ui/file-tree-paint.js` 는 모듈 크기 기준선(최대 975줄)에 걸려 있다. 줄을 더하면 다른 줄을 접어야 한다. 기준선은 근거 없이 옮기지 않는다.
- i18n 키는 `t('리터럴')` 로만 쓴다. 조립한 키(`'prefix.'+x`)는 `check-i18n.mjs` 가 못 보고 "쓰이지 않는 키" 로 멈춘다(동적 접두는 그 표에 사유와 함께 등록).
- SRS 의 결정(D-…)을 고치면 `go run ./scripts/gen-decisions` 를 돌린다(생성물, gates 가 대조).
- 워크트리 세션에서는 `cd ... && cat > 파일 <<EOF` 같은 복합 셸 명령이 거절될 수 있다. 파일은 Write/Edit 도구로 쓴다.

## 5. 변하지 않는 규약

- `make gates` 를 느슨하게 만들어 통과시키지 않는다.
- 동작이 바뀌면 해당 SRS 머리에 개정(이전 동작 / 새 동작 / 이유)을 적는다.
- 시험의 기대를 바꿀 때는 그 시험의 SRS 근거와 맞는지 먼저 본다. SRS 와 다르면 플래그를 올리고 사용자에게 묻는다.

## 6. 유효한 사용자 결정

- 7건은 main 쪽 작업으로 고친다(2026-11-13). Claude 다중 계정 기능은 끝났고 main 에 합쳐 push 했다(`e506e094`).
- 계정 기능의 실제 계정 확인(TC-CAC-28)은 사용자가 직접 한다. 이 세션의 일이 아니다.
