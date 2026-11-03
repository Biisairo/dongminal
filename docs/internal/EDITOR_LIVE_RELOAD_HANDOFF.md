# 인계: 밖에서 바뀐 파일이 열린 편집기·Diff 탭에 반영되지 않는다

- 작성: 2026-11-04. 넘기는 세션은 `EDITOR_LINK_LSP_SRS` 작업(링크·표식·미니맵·marksman)을 끝냈다.
- 직전 커밋: `b01cfaca` (편집기) · `de17c6e5` (marksman). 이 문서를 더한 커밋이 그 뒤에 하나 있다.

---

## 1. 착수 블록 — 이번 세션의 지시 전부

1. **사용자 보고(2026-11-03)**: 파일 탭이나 Diff 탭이 열린 상태에서 그 파일이 밖에서 바뀌면 화면이 갱신되지 않는다.
   편집하지 않은 깨끗한 상태다. 탭을 닫고 다시 열어야 바뀐다. 사용자는 "Editor 창의 파일 탭, Repo 창의 Diff 탭 둘 중 하나거나
   둘 다"라고 답했다.
2. **사용자는 측정할 시간이 없다.** 콘솔 확인을 부탁하지 말고, 직접 재현하거나 코드 분석으로 원인을 찾는다 (사용자 지시).
3. 원인을 근거로 확정한 뒤에 고친다. 근거 없이 방어 코드만 더하지 않는다. 다만 §4 의 결함 후보 A 는 코드만으로도 결함이다 —
   증상과 같은지 확인한 뒤 고친다.
4. 중규모 이상이면 스펙(IEEE 29148) → 테스트(RED) → 구현 순서다. 기존 스펙은 `docs/internal/archive/EDITOR_LIVE_RELOAD_SRS.md`
   와 `docs/internal/EDITOR_EXTERNAL_CHANGE_SRS.md` 다. 새 조항은 그 둘을 개정하는 형태로 쓴다.
5. 커밋은 사용자 확인 뒤에만 한다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다.

---

## 2. 먼저 읽을 것

| 경로 | 무엇 |
|---|---|
| `web/js/core/app-editor-open.js:160~290` | 실시간 반영 폴링 — `_edVisibleDocPaths` · `_edLiveDocs` · `_edDocStampsBegin/End` · `edStampTick` |
| `web/js/core/app-editor-pane.js:25~50` | 폴링 틱 `_edTick` (`visiblePoll(gitReposInterval)`, 기본 3초) |
| `web/js/core/app-editor-doc.js:80~120` | `edDocRefresh` · `_edDocReplace` · `edDocDirtySync` |
| `web/js/ui/cm-buffer.js:74~99` | `EdBuffer.replace` — 모든 칸(sink)에 트랜잭션을 보낸다 |
| `web/js/git/diff-view-doc.js` | Diff 탭의 작업 트리 쪽이 문서 버퍼의 칸으로 붙는 자리 (`docPath`) |
| `web/js/core/app-git.js:166` | `_gitDiffDocPaths` — Diff 탭의 문서 경로를 폴링 목록에 넣는다 |
| `e2e/editor-live-reload.spec.ts` | 기존 회귀 (V-ELR-5~12) |
| `e2e/git-diff-doc.spec.ts` | Diff 탭이 편집기 문서를 공유하는 회귀. 아래 재현 탐침의 바탕 |

---

## 3. 이미 확인한 것 (다시 하지 않는다)

### 3.1 서버 쪽은 정상이다

- 실행 중인 서버 기록 `~/.dongminal/server.log`(+`.1`)의 `POST /api/fs/stamps` 63,227건이 **모두 200** 이다. 4xx 로
  `_edStampsOff` 가 굳는 길은 아니다.
- `curl -X POST http://127.0.0.1:58146/api/fs/stamps -d '{"trees":[],"paths":["<abs>"]}'` 는 바뀐 파일의 표식을 낸다. 없는 파일은 응답에서 빠진다.
- 브라우저는 3초마다 이 요청을 보내고 있다(기록의 간격). 단, 같은 요청에 탐색기 트리 관측이 함께 실리므로, 이 기록만으로는
  **파일 경로가 요청에 들어 있었는지** 알 수 없다.
- `apiPost`(`web/js/core/api.js:105`)는 예외를 던지지 않는다 → `_edStampsBusy` 가 예외로 굳는 길도 아니다
  (fetch 가 영원히 끝나지 않는 경우는 남는다. 다만 그러면 트리 관측도 함께 멎어 3초 간격 기록이 끊겨야 한다).

### 3.2 격리 e2e 서버에서는 재현되지 않는다 (모두 2초 안에 갱신)

임시 탐침(`e2e/zz-*.spec.ts`, 지웠다)으로 잰 조건:

| 조건 | 결과 |
|---|---|
| Editor 창 + `doc.md` (enterDocRoot) | 갱신 |
| git 저장소, Changes 사이드, Diff 탭과 Editor 탭을 함께 연 상태 (`git-diff-doc.spec.ts` 의 `enter`·`openDiff` 를 그대로 씀) | 둘 다 갱신 |
| 쓰기 방식: 일반 쓰기 · 원자적 쓰기(임시 파일 → rename) | 둘 다 갱신 |
| `.md` + marksman LSP 연결 (`PATH=/tmp/marksman-dl:$PATH npx playwright test …`) | 갱신, 콘솔 오류 없음 |
| 슬롯 관련 기존 스펙 45건 (`slot-live-refresh` · `slot-view-state` · `editor-multi-slot`) | 통과 |

탐침이 찍은 상태(`_edLiveDocs`·`_edVisibleDocPaths`·문서의 `dirty/stamp/buf/loading/views`)는 모두 정상이었다.

### 3.3 사용자 환경 (실측)

- `~/.dongminal/workspace.json`: 창 15개, Editor 창 10개. Editor 창 대부분의 사이드가 `changes` 다.
  열린 탭 예: `/Users/dykim/personal/dongminal` 창에 `git history` · `git diff` · md 3개, `/Users/dykim/.session-ledger` 창에
  `2026-11-03.md` + `git diff`, `/Users/dykim/TIL` 창에 `03 업무일지.md`(한글 파일 이름), `/Users/dykim` 루트 창(explorer)에 `import.log`.
- 갱신이 안 된다는 파일은 대부분 `.md` 다. 밖에서 바꾸는 주체는 같은 작업 공간의 에이전트(Claude Code)나 훅(session-ledger)일 가능성이 크다.
- `~/.dongminal/settings.json`: `gitReposInterval: 3000`, `editorWordWrap: true`, `editorMinimap: true`, 테마 `Cobalt²`, 슬롯 단축키 설정 있음.
- marksman 이 설치돼 있다 (`~/.dongminal/ext/plugins/marksman/`). `.md` 탭에는 LSP 가 붙는다.
- 서버 기록에 `GET /api/git/diff-content 404` 가 473건 있다(시간대가 흩어져 있다). 새 파일(HEAD 에 없음)의 Diff 에서 나는 정상 응답일
  가능성이 크지만 확인하지 않았다.
- 페이지는 오래 열려 있다(몇 시간·서버 재시작 여러 번). e2e 는 매번 새 페이지다 — **오래 산 페이지의 상태**가 차이일 수 있다.

---

## 4. 원인 후보 (코드 분석)

### A. 버퍼 교체가 칸 하나에서 실패하면 다시 시도하지 않는다 — 가장 유력

`edDocRefresh` → `_edDocRead` → `_edDocReplace(d, r)` 의 순서:

1. `_edDocMeta(d, r)` 가 **먼저** `d.stamp` 를 새 표식으로 바꾼다.
2. `d.buf.replace(r.text)` 가 버퍼의 `_doc` 를 바꾼 뒤 칸마다 `sink.dispatch(...)` 를 두 번 부른다 (`cm-buffer.js:83~96`).
3. 칸 하나의 `dispatch` 가 예외를 내면 나머지 칸은 갱신되지 않고, `_bump` · `d.savedDoc` · `edDocDirtySync` 도 실행되지 않는다.
4. 예외는 `edDocRefresh` 의 `.catch` 가 `console.error('[edDoc] refresh error:', e)` 로만 남긴다.
5. 다음 폴링에서는 `d.stamp === now` 라 **다시 읽지 않는다.** 그래서 탭을 다시 열어야만 바뀐다 — 사용자 증상과 같다.

어느 칸이 왜 예외를 내는지는 확정하지 못했다. 의심 자리:

- 갱신 도중의 `dispatch` — "Calls to EditorView.update are not allowed while an update is in progress".
  폴링 콜백이 다른 칸의 갱신 안에서 불리는 경로가 있는가.
- 이미 파괴된(`destroy`) 뷰가 sink 집합에 남아 있는 경우 — 닫힌 Diff·창 전환·슬롯 변경 뒤. sink 해제(`detach`) 경로를 본다.
- LSP 플러그인(`cm-lsp.js` 의 `EdLspWorkspace.syncFiles`)이 같은 파일을 연 여러 칸에서 문서 판을 맞출 때.
- 측정 중 레이아웃 읽기 금지 위반("Reading the editor layout isn't allowed during an update") — 이번 작업에서 미니맵이 실제로 이 예외로
  플러그인을 죽인 적이 있다(고쳤다). 다른 플러그인에도 같은 꼴이 있을 수 있다.

### B. 질문 목록에서 빠진다

`_edLiveDocs` 는 `d.dirty` · `!d.buf` · `!d.stamp` · `!seen.has(path)` 를 거른다.

- `seen` 은 `tab.filePath` 로 만들고 `_edDocs` 의 열쇠는 문서 경로다. 둘의 표기가 다르면(심볼릭 링크, `/tmp`↔`/private/tmp`,
  **한글 파일 이름의 NFC/NFD**) 빠진다. `03 업무일지.md` 가 의심된다. 다만 사용자는 ASCII 이름 파일도 그렇다고 했다.
- 보이지 않는 dirty — 문서를 연 뒤 무언가가 버퍼를 바꿨다면 dirty 가 되어 빠진다. 탭 라벨에 표시가 있었는지는 모른다.

### C. 폴링이 멎는다

- `_edStampsBusy` 가 true 로 굳는다 — fetch 가 끝나지 않는 경우뿐이다(§3.1).
- `_edStampsOff` — 4xx 기록이 없다(§3.1).

---

## 5. 권장 순서

1. **후보 A 를 코드로 확정한다.** `EdBuffer.replace` 의 sink 순회에서 예외가 날 수 있는 경로를 실제로 만들어 본다.
   예: 파일을 연 뒤 Diff 를 닫거나 창·슬롯을 바꿔 sink 가 남게 한 다음 밖에서 파일을 바꾼다. 같은 파일을 편집기 탭과 Diff 탭에서
   함께 연 상태, marksman 이 붙은 상태에서도 잰다.
2. 재현되면 스펙(기존 `EDITOR_LIVE_RELOAD` 계열 SRS 개정 또는 새 조항) → RED → 수정. 수정의 방향 후보:
   칸 하나가 실패해도 나머지 칸을 갱신한다 · 교체가 끝나기 전에는 `d.stamp` 를 바꾸지 않는다(실패하면 다음 폴링이 다시 시도한다) ·
   예외를 조용히 삼키지 않고 원인 칸을 기록한다.
3. 재현되지 않으면 후보 B(경로 표기 · 보이지 않는 dirty)를 같은 방식으로 잰다.
4. 오래 산 페이지를 흉내 낸다 — 같은 페이지에서 서버를 재시작(e2e 서버를 내렸다 올림)한 뒤 갱신이 되는지.

---

## 6. 값을 치르고 배운 것

- **e2e 기본값과 사용자 설정이 다르면 재현되지 않는다.** 미니맵 지연은 사용자 설정 `editorWordWrap: true` 에서만 났다.
  재현이 안 되면 `~/.dongminal/settings.json` 과 `workspace.json` 의 실제 값으로 조건을 맞춘다.
- 실행 중인 사용자 서버(포트 58146)에 브라우저를 붙이지 않는다 — 작업 공간 상태(활성 창 등)를 바꾼다. 격리 e2e 서버(58147~)로 잰다.
- 탐침은 `e2e/zz-*.spec.ts` 로 만들고 바로 지운다. `e2e/editor-link-marks.spec.ts` 의 앞부분(`start`·`inDoc`)을 머리로 잘라 붙이면 빠르다.
  고정 대기(`waitForTimeout`)가 남은 스펙은 `scripts/check-e2e-waits.mjs` 게이트에 걸린다.
- `pgrep -fl` 은 macOS 에서 프로세스 환경 변수까지 찍는다 — 비밀값이 대화에 남았다. 프로세스는 `ps -Ao pid,etime,comm` 으로 본다.
- 벤더(`scripts/codemirror/`)를 고치면 `node scripts/build-codemirror.mjs` 뒤 `docs/internal/VENDOR_VERSIONS.md` 의 해시를
  `scripts/check-vendor.sh` 가 낸 값으로 고친다.
- e2e 전체 묶음은 메모리를 많이 쓴다. 사용자가 램 부족을 말한 적이 있다 — 관련 스펙만 골라 돌린다.

---

## 7. 변하지 않는 규약

- 검사: `npm run -s lint` · `npx tsc --noEmit -p e2e` · `npm run -s unit` · `make gates` · `go vet` · 관련 e2e.
- 사용자 전역 지침(`~/.claude/CLAUDE.md`): 심볼 탐색은 LSP → Serena → grep 순, 중·대 규모는 스펙 → 테스트 → 구현, 추측 금지·가정 명시,
  최소·국소 변경, 커밋은 사용자 확인 뒤, AI 서명 금지.
- 문서 산출물은 ASD-STE100 을 80% 정도로 완화하고, 한국어 문장이 자연스럽게 읽히도록 쓴다. SRS 는 IEEE 29148 이 우선이다.

---

## 8. 아직 유효한 사용자 결정

- 미니맵은 완벽하다 (2026-11-04). 손대지 않는다.
- 측정을 사용자에게 부탁하지 않는다. 직접 재현하거나 코드로 찾는다.
- 정의·참조가 없을 때 아무것도 표시하지 않는다, 오류는 테마만 입힌 라이브러리 대화상자로 보인다 (`EDITOR_LINK_LSP_SRS`).
