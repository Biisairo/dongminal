# 인계: 편집기 엔진 교체 (Monaco → CodeMirror 6) — M3 마무리부터

> 작성: 2026-11-02 · 브랜치 `codemirror-migration` · 근거 SRS `docs/internal/CODEMIRROR_MIGRATION_SRS.md`

## 착수 블록 (이번 세션의 지시 전부)

1. 이 문서를 끝까지 읽는다. 그다음 SRS 의 §3(요구사항)·§3.16(동작 변경)·§7(마일스톤·§7.1 브랜치 규칙·§7.2 실패 표)·§11.1(M3 설계)을 읽는다.
2. `git status` 와 `git log --oneline -5` 로 출발점을 확인한다. 브랜치는 `codemirror-migration` 이어야 한다.
3. **M3 미해결 2건부터 고친다** (아래 "남은 일" 1·2). 고친 뒤 편집기 관련 e2e 를 다시 돌려 §7.2 표와 비교한다.
4. M3 를 닫는 커밋을 만든다. **커밋 전에 사용자에게 확인을 받는다** (CLAUDE.md). 커밋 메시지에 AI 서명을 넣지 않는다.
5. 그다음 M4 → M5 → … 순서로 진행한다. 마일스톤마다 Spec → Test → Code 순서이고, 끝에 e2e 를 돌려 §7.2 를 갱신한다.

## 어디까지 왔나

| 마일스톤 | 상태 | 근거 |
|---|---|---|
| M1 벤더 묶음·로더 | 완료 | 커밋 `6633910c` |
| M2 e2e 편집기 접근 계층 | 완료 | 커밋 `a81a3920` (옮기기 전후 e2e 531 → 534 통과, 실패 0) |
| M3 편집기 코어·찾기 | **진행 중 — 이 인계에 WIP 커밋으로 남긴다** | 아래 "M3 에서 한 일" |

`main` 은 `c121f107` 이다(원격 `origin/main` 보다 1개 앞선 사용자 커밋). 단계 A 가 끝나 e2e 전체가 통과할 때까지 `main` 에 합치지 않는다 (SRS §7.1).

### M3 에서 한 일

- 새 파일
  - `web/js/ui/cm-buffer.js` — `EdBuffer`. 문서 하나의 내용과 칸(sink) 사이 전달. 표식 `REMOTE`·`FLUSH`, Compartment `HISTORY` 는 지연 getter 다(페이지 로드 때 `CM` 이 없다)
  - `web/js/ui/cm-find.js` — `edFindHits`(순수), `edFindMarks()`(일치 표시 StateField), `edFindEngineCm`
  - `web/js/ui/cm-setup.js` — `CM_LANG`·`edCmLangName`·`edCmLangLoad`·`edCmPos`·`edCmLineCol`·`edCmExtensions`(Compartment: wrap·font·ro·lang)·테마(CSS 변수)·괄호 쌍 색·선택 영역 공백 표시
  - 단위 테스트 `web/js/test/cm-{harness,buffer,find,setup}.test.mjs` — 커밋된 벤더 묶음을 풀어 Node 에서 `import` 한다
- 바꾼 파일
  - `web/js/ui/file-editor.js` — `FileEditor` 는 `_view`(EditorView)·`_buf`·`_cmp` 를 든다. `_editor` 필드는 없다. `_onUpdate` 가 dirty·미리보기 고정·찾기 재실행을 맡는다. 위쪽의 `monaco*`·`MONACO_*` 도우미는 Git Diff 뷰가 M6 까지 쓰므로 남겼다
  - `web/js/ui/file-editor-find.js` — 패널이 편집기에 닿는 자리를 엔진 객체로 갈랐다(`_findEngine`). Diff 뷰용 `edFindEngineMonaco` 는 M6 에서 걷는다
  - `web/js/core/app-editor-doc.js`·`app-editor-open.js` — 문서 레코드 `d.model` → `d.buf`, `savedAltVer` → `savedDoc`, dirty 는 `!d.buf.doc.eq(d.savedDoc)`
  - `web/js/core/doc-token.js` — 토큰은 버퍼 동일성과 `version` 을 본다 (테스트 함께 수정)
  - `web/js/ui/doc-render.js`·`web/js/core/app-docrender.js` — 버퍼 구독, 스크롤 동기화는 `scrollDOM` + `lineBlockAtHeight`
  - `web/js/core/app-edsearch.js`·`app-statusbar-enc.js` — `_view`·`_findEngine` 기준
  - `web/js/git/diff-view-doc.js` + `constants-git-diff.js` 의 `GIT_DIFF_SHARES_DOC=false` — Diff 뷰는 M6 까지 문서를 나누지 않는다(읽기 전용 비교)
  - `web/index.html`(새 스크립트 셋, `file-editor.js` 앞) · `web/style.css`(`.cm-editor` 선택 허용)
  - `scripts/test/codemirror-vendor.test.mjs` — "앱이 쓰는 `CM.*` 이름이 묶음에 전부 있다" 검사 추가
  - `e2e/editor.ts` — 어댑터가 두 엔진을 받는다. 편집기 칸의 핸들은 `FileEditor` 자체, Diff 쪽은 Monaco 편집기다
  - SRS — §3.16 동작 변경 3줄, §7.1·§7.2, §11.1 설계 메모

### 마지막 측정 (M3 작업 트리)

- 단위 테스트: `npm run unit` 전체 통과 (cm-buffer 14 · cm-find 11 · cm-setup 7 · doc-token 4 포함)
- lint·typecheck·`check-load-order`·`check-html` 통과
- 편집기 관련 e2e 43개 파일: 534건 중 통과 484 · 실패 50. 분류는 SRS §7.2 에 있다 — 48건은 뒤 마일스톤(M5·M6·M8)의 것이고 **2건이 M3 회귀**다

## 남은 일 (순서대로)

1. **`e2e/editor-replace-seed.spec.ts` "모두 바꾸기 뒤 undo 한 번에 전부 돌아온다"** (FR-CMR-33). `edFindEngineCm.replace` 는 변경 전부를 트랜잭션 하나로 보내고 `isolateHistory.of('full')` 를 단다. 그런데 실행 취소 한 번에 전부 돌아오지 않는다. 의심: 바꾸기 직전 질의 입력이나 다른 편집과 한 묶음이 되었거나, 실행 취소 키가 편집기에 닿지 않았다. 스펙이 어떤 키·순서로 재는지부터 읽는다
2. **`e2e/editor-doc-registry.spec.ts` "CRLF 파일은 편집하지 않으면 변경 표시가 없다"**. 의심: `EdBuffer` 가 `split('\n')` 으로 줄을 나눠 `\r` 이 줄 끝에 남는다. CodeMirror 상태가 그 `\r` 을 다르게 다루면(줄 구분자 처리) 열자마자 문서가 달라져 dirty 가 선다. 서버가 `decode=1` 로 무엇을 주는지(CRLF 를 그대로 주는지)와, 저장 때 CRLF 를 되살리는지 함께 확인한다. 고칠 때 단위 테스트(`cm-buffer.test.mjs`)에 CRLF 경우를 먼저 넣는다
3. M3 커밋 (사용자 확인 후)
4. **M4 (묶음 P)** — 같은 파일 여러 칸. 버퍼 전달은 이미 M3 에 들어 있다(`EdBuffer`). 남은 것: FR-CMR-23(lsp-client 용 사용자 정의 Workspace — M8 과 함께 볼 수 있다), FR-CMR-24 확인, NFR-CMR-4(칸 셋 동시 입력 1프레임) 측정, `slot-view-state` 의 TC-SVS-30~32 가 통과하는지 확인
5. **M5 (묶음 R·M·D)** — overview ruler 직접 구현, `@replit/codemirror-minimap` 0.5.2 를 `scripts/codemirror/minimap/` 으로 포크(`fill` 좌표계 + 찾기 일치 층), dirty diff 를 CodeMirror gutter·block widget 으로. e2e 어댑터의 `marks`·`lineMarks`·`option('minimap…')`·`minimapLeft/Width` 갈래도 함께 채운다
6. M6 (Diff 뷰 → `@codemirror/merge`, `GIT_DIFF_SHARES_DOC` 와 Monaco 도우미·`edFindEngineMonaco` 제거) → M7 (sticky scroll) → M8 (LSP 통로·`lsp-client`) → M9 (Monaco 제거·문서 개정)

## 먼저 읽을 것

- SRS `docs/internal/CODEMIRROR_MIGRATION_SRS.md` — §3, §3.16, §7, §7.1, §7.2, §8, §11.1
- `e2e/editor.ts` — 어댑터. 엔진을 아는 e2e 코드는 이 파일 하나다 (FR-CMR-121, `scripts/test/e2e-editor-boundary.test.mjs` 가 지킨다)
- `web/js/ui/cm-buffer.js`·`cm-setup.js`·`cm-find.js`·`file-editor.js`

## 이 세션이 값을 치르고 배운 것

- **e2e 를 두 벌 동시에 돌릴 때는 `DM_E2E_KEEP_PEERS=1` 이 필요하다.** 없으면 `global-setup`/`teardown` 이 다른 실행의 `/tmp/dongminal-e2e-*` 를 지워 `spawn … ENOENT` 로 전부 실패한다. 기준선과 비교 실행을 같이 돌리면 포트도 갈라야 한다(`E2E_PORT_BASE=59300`)
- **기준선은 git worktree 로 만든다.** 실행 중에 작업 트리를 고치면 Playwright 워커가 고친 파일을 읽어 기준선이 오염된다. `git worktree add /tmp/dm-base <커밋>` 뒤 `node_modules` 를 심볼릭 링크로 두고 그 안에서 돌린다. 끝나면 링크를 지우고 `git worktree remove`
- **zsh 는 `$files` 를 단어로 나누지 않는다.** 파일 목록은 `xargs` 로 넘긴다
- **`web/vendor/*` 는 통째로 바이너리에 들어간다** (`web/embed.go`). 빌드 입력은 `scripts/codemirror/` 에 둔다
- **`CM` 은 편집기를 처음 열 때 온다.** 클래식 스크립트의 최상위에서 `CM.*` 를 부르면 페이지 로드가 깨진다 — 지연 getter·함수로 둔다 (`cm-setup.test.mjs` 의 마지막 검사가 지킨다)
- **`export *` 끼리 이름이 겹치면 조용히 빠진다.** 새 `CM.*` 이름을 쓰면 `scripts/test/codemirror-vendor.test.mjs` 가 잡는다. 묶음에 없으면 `scripts/codemirror/entry.js` 에 더하고 `node scripts/build-codemirror.mjs` 로 다시 묶은 뒤 `VENDOR_VERSIONS.md` 의 집계 해시·파일 수를 고친다
- **SRS 상태 값은 enum 이다** (`check-srs-status.sh`): `승인·구현중` 이면 바로 아래 `> **남은 것**:` 줄이 있어야 한다 (`check-srs-progress.sh`)
- **Serena 는 이 프로젝트에서 Go 만 띄운다.** `.serena/project.yml` 에 `typescript` 를 더해 두었으나 MCP 를 다시 붙여야(`/mcp` → serena Reconnect) 반영된다. JS 심볼 탐색은 Claude Code 의 LSP 도구가 동작한다. Serena 가 안 되면 Edit 으로 폴백한다
- 편집기 관련 e2e 43개 파일 전체는 약 19분 걸린다(`--reporter=json` 으로 받아 테스트 단위로 비교했다). 파일 목록은 `grep -rlIE "monaco|_editor\b|_editor\.|\.view-lines|\.minimap|getModifiedEditor|getEditors|decorationsOverviewRuler|margin-view" e2e --include='*.spec.ts'` 에 `git-subroot`·`git-write-order`·`codemirror-load` 를 더한 것이다

## 변하지 않는 규약

- CLAUDE.md: 중·대 규모는 Spec → Test → Code. 테스트는 구현 전에 실패를 확인한다. 커밋은 사용자 확인 후에만, AI 서명 금지
- 도구 우선순위: 심볼은 LSP → Serena → grep. 수정은 Serena → Edit
- 게이트: `npm run unit` · `npm run -s typecheck` · `npx eslint .` · `.github/workflows/verify.yml` 의 `scripts/check-*` 전부
- e2e 는 엔진에 직접 닿지 않는다 — `e2e/editor.ts` 의 `edT`·`ED_SEL` 만 쓴다
- §7.2 에 없는 e2e 실패는 회귀로 본다. 마일스톤을 커밋할 때 표를 갱신한다
- 동작이 바뀌면 SRS §3.16 에 이전 동작 / 새 동작 / 이유를 적는다

## 아직 유효한 사용자 결정

- 대상은 CodeMirror 6. 단계 A(1:1 이전) 먼저, 단계 B(기능 추가)는 그 뒤
- 우클릭 메뉴·F1 명령 팔레트·Bat 강조는 넣지 않는다. sticky scroll 은 단계 A 에 넣는다(직접 구현)
- 일부러 설정한 기능은 CodeMirror 에 없어도 직접 구현해 유지한다
- LSP 는 `@codemirror/lsp-client` + WebSocket 통로. 연결마다 언어 서버 하나. Monaco 시절의 REST·서버 문서 동기화는 걷는다
- 열리지 않은 파일의 변경은 통로가 `didChangeWatchedFiles` 로 끼워 넣는다 — 파일 저장 + git 변화 모두
- 묶음은 스크립트로 만들어 커밋한다. 미니맵은 포크해서 쓴다. Diff 공백 무시는 `diffConfig.override` 로 줄 단위 정규화
- 같은 파일 여러 칸의 실행 취소는 칸마다 따로다
- 단계 A 는 `codemirror-migration` 브랜치에서 하고, 끝난 뒤 `main` 에 합친다
- §8 의 B 단계 질문 5건은 B 착수 전에 묻는다
