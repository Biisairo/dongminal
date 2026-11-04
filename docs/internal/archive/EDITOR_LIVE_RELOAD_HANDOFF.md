# 인계: 밖에서 바뀐 파일이 열린 편집기·Diff 탭에 반영되지 않는다 (2차) — 닫혔다 (2026-11-04)

> **이 작업은 `4e45a65c` 로 끝났다.** 아래 본문은 조사 당시의 기록이다.
>
> - **원인**: 반영이 안 되는 결함이 아니라 **지연**이었다. 사용자가 "갱신은 되지만 늦다"고 다시 알렸고,
>   사용자 구성을 그대로 세운 격리 서버에서 지연이 폴링 주기(`gitReposInterval` 3초) 그대로임을 쟀다
>   (0.4~2.1초, 12회). 근거는 [`./EDITOR_LIVE_RELOAD_SRS.md`](./EDITOR_LIVE_RELOAD_SRS.md) §2.7 이다.
> - **해결**: 서버 파일 감시(fsnotify, 비재귀)와 SSE `fs_changed` 를 더했다 — 같은 SRS 의 묶음 W·C·G
>   (`FR-ELR-50`~`76`). 열린 문서·Diff 문서·탐색기 목록·git 색이 감시로 곧바로 반영되고, 폴링은
>   안전망으로 남는다. 워크트리 회차 간격은 설정 `gitWorktreeInterval` 로 바꿀 수 있다.
> - **남은 것**: 없다. §4 의 후보 B·D 는 원인이 아니었다. §5-3 의 진단 통로는 만들지 않았다.
>
> 다음에 이 영역을 다루는 세션은 이 문서가 아니라 SRS 에서 시작한다.

- 작성: 2026-11-04. 1차 조사 세션이 이 문서를 다시 썼다.
- 직전 커밋: `e26139ef` (1차 세션의 결함 수정). 이 문서를 고친 커밋이 그 뒤에 하나 있다.
- 1차 문서는 `git show 4aefca8d:docs/internal/EDITOR_LIVE_RELOAD_HANDOFF.md` 로 볼 수 있다.

---

## 1. 착수 블록 — 이번 세션의 지시 전부

1. **사용자 보고(2026-11-03)**: 파일 탭이나 Diff 탭이 열린 상태에서 그 파일이 밖에서 바뀌면 화면이 갱신되지 않는다.
   편집하지 않은 깨끗한 상태다. 탭을 닫고 다시 열어야 바뀐다. "Editor 창의 파일 탭, Repo 창의 Diff 탭 둘 중 하나거나 둘 다".
2. **이 문제를 새롭게 시작한다** (사용자 지시, 2026-11-04). 1차 세션은 증상을 재현하지 못했다. §3 의 "확인한 것"을 다시 하지
   말고, §5 의 새 방향에서 시작한다. §5 를 따를 의무는 없다 — 더 나은 방향이 보이면 근거와 함께 사용자에게 제안한다.
3. **사용자는 측정할 시간이 없다.** 콘솔 확인·재현 절차를 부탁하지 않는다. 직접 재현하거나 코드·기록으로 찾는다.
4. 원인을 근거로 확정한 뒤에 고친다. 근거 없는 방어 코드를 더하지 않는다.
5. 중규모 이상이면 스펙(IEEE 29148) → 테스트(RED) → 구현 순서다. 스펙은 `docs/internal/archive/EDITOR_LIVE_RELOAD_SRS.md`
   (묶음 F 까지 있다)를 개정하는 형태로 쓴다.
6. 커밋은 사용자 확인 뒤에만 한다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다.

---

## 2. 먼저 읽을 것

| 경로 | 무엇 |
|---|---|
| `docs/internal/archive/EDITOR_LIVE_RELOAD_SRS.md` §3·§3.6 | 실시간 반영 요구사항. §3.6(묶음 F)이 1차 세션의 수정이다 |
| `web/js/core/app-editor-open.js` `_edVisibleDocPaths` · `_edLiveDocs` · `_edDocStampsBegin/End` · `edStampTick` | 무엇을 묻는가 (질의 목록) |
| `web/js/core/app-editor-pane.js` `_edTick` | 틱 (`visiblePoll(gitReposInterval)`, 3초) |
| `web/js/core/app-editor-doc.js` `edDocRefresh` · `_edDocReplace` · `edDocDirtySync` | 읽고 넣기 |
| `web/js/ui/cm-buffer.js` `EdBuffer.replace` | 모든 칸에 넣기 |
| `web/js/core/app-slots.js` `windowVisible` | 창이 보이는가의 판정 |
| `web/js/core/app-git.js` `_gitDiffDocPaths` · `web/js/git/diff-view-doc.js` `docPath` | Diff 탭 문서가 질의 목록에 드는 길 |

---

## 3. 이미 확인한 것 (다시 하지 않는다)

### 3.1 재현되지 않은 조건 (격리 e2e 서버, 모두 2~3초 안에 갱신)

사용자 설정(`editorWordWrap: true`, `editorMinimap: true`)과 marksman LSP(`PATH=/tmp/marksman-dl:$PATH`)를 맞춘 상태다.
CodeMirror 상태와 실제 DOM(`contentDOM.textContent`)을 모두 쟀다.

- Editor 창 + `.md` 단독, git 저장소 Changes 사이드에서 Diff 탭 + Editor 탭 함께
- Diff 를 A→B→A 로 옮김, 나란히↔인라인, 변경 없는 줄 접기 켬/끔, 사이드 Explorer↔Changes
- 200줄 문서: 줄 수 같음·감소·증가·빈 문서, Diff 커서를 문서 끝에 둠
- 비활성 탭에서 바뀐 뒤 활성화, Diff 를 보는 동안 숨은 편집기 탭
- 바깥 작업 공간 변경(`/api/editors/add` → `workspace_changed`), SSE 재연결(`app.bus.reconnect()`)
- 쓰기 방식: 일반 쓰기, 원자적 쓰기(임시 파일 → rename) — 1차 이전 세션이 잼

### 3.2 코드로 배제한 것

- 파괴된 칸에 보낸 `dispatch` 는 예외가 없다 (`@codemirror/view` 6.43.15 `index.js:8026`, `update` 가 `destroyed` 면 바로 돌아간다).
  리스너·플러그인 예외는 `logException` 이 삼킨다.
- 서버 읽기(`apiFileRead` → `fileReadDecoded`)는 `Stat` 을 내용 읽기 **전에** 한다. 경합이 나도 "새 내용 + 옛 표식"이 되어
  다음 회차가 다시 읽는다. 표식 함수는 읽기와 `fileStampsIn` 이 같다. 응답 열쇠는 요청 경로 그대로다.
- `_edStampsOff` 로 굳는 길: `server.log` 의 `fs/stamps` 64,042건이 모두 200, `request denied`(gateDeny 기록) 0건.
- `d.loading` 은 버퍼가 생기기 전 첫 적재에만 쓴다. `docTokenValid` 도 굳는 길이 아니다.
- 프로그램이 문서를 바꾸는 곳(`changes:`)은 사용자 동작(dirty-diff 되돌리기, 찾아 바꾸기)뿐이다. LSP 는 편집을 적용하지 않는다.
- 렌더 탭(DocRender)은 버튼으로만 연다. 사용자 작업 공간에 렌더 탭은 없다.

### 3.3 1차 세션이 고친 것 (`e26139ef`, 증상의 원인으로 확정한 것은 아니다)

- FR-ELR-35 칸별 격리 · FR-ELR-36 반영 중 일시적 dirty 제거 · FR-ELR-37 표식은 반영 뒤 · FR-ELR-38 Diff 칸 누수.
- 사용자가 이 수정 뒤에도 증상을 보면, 원인은 반영 단계가 아니라 **질의 목록 쪽**일 가능성이 더 크다.

### 3.4 서버 기록에서 나온 단서 (가장 중요)

`~/.dongminal/server.log` 는 요청의 쿼리를 남기지 않는다. 그래서 어느 파일인지는 모른다. 시각만 대조했다.

- 사용자 작업 공간(`~/.dongminal/workspace.json`)의 dongminal 창(사이드 `changes`)에 Diff 탭과 `.md` 탭 셋이 있다.
  `CODEMIRROR_MIGRATION_SRS.md` 가 2026-11-04 07:52:36, `EDITOR_LINK_LSP_SRS.md` 가 08:00:09 에 바뀌었다.
- `GET /api/file/read` 는 07:46:04 다음이 08:04:57 이다. 그 사이 읽기가 없다.
- 07:50~08:01 에는 `fs/stamps` 가 없다 — 편집기 창이 화면에 없었던 것으로 본다(설계대로).
- 08:01:31 에 git status·diff-content 묶음이 나간 뒤, 08:02:43 까지 3초마다 `fs/stamps` 가 나갔다. 그래도 읽기가 따라오지 않았다.
- **해석**: 후보 A(반영 실패)라면 읽기 요청이 먼저 나가야 한다. 그 시간에 dongminal 창이 보였다면, 그 문서가 질의 목록에 없었거나
  표식이 같다고 판정됐다. 다만 그때 보인 창이 dongminal 창인지는 기록으로 확정할 수 없다.
- 그 밖: 접속 기기가 둘이다(로컬 `[::1]`, 원격 `100.117.248.111`). 서버는 07:34:56 에 재시작했고 페이지는 07:34:57 에 다시 실렸다.
  `/api/file/stamps` 는 터미널 링크 검사(`bare-link.js`)의 것이라 편집기와 무관하다.

### 3.5 사용자 환경 (실측)

- `workspace.json`: 창 15개, Editor 창 10개, 대부분 사이드 `changes`. 문제의 탭 다수가 `preview: true` 다.
- `settings.json`: `gitReposInterval: 3000`, `editorWordWrap: true`, `editorMinimap: true`, `diffMinimap: false`.
  Diff 접기(`hideUnchanged`)는 브라우저 localStorage 값이라 모른다.
- 밖에서 파일을 바꾸는 주체는 같은 작업 공간의 에이전트(Claude Code)와 훅(session-ledger)이다.

---

## 4. 원인 후보 (남은 것)

### B. 질문 목록에서 빠진다 — 기록이 가리키는 쪽

`_edLiveDocs` 는 `d.dirty` · `!d.buf` · `!d.stamp` · `!seen.has(path)` 를 거른다. `seen` 은 `_edVisibleDocPaths` 가
**보이는 Editor 창**(`windowVisible`)의 탭에서 만든다. 1차 세션은 코드 읽기로 빠지는 길을 찾지 못했다. 격리 e2e 는 창 하나·탭 몇 개라서,
**창이 많고 슬롯을 쓰는 사용자 구성**에서만 서는 길이 남아 있을 수 있다.

- 슬롯 모드에서 `_slots.windows` 와 실제 화면의 어긋남, 다른 기기(원격 접속)의 조작으로 `activeWindow` 가 바뀌는 경우
- `tab.filePath` 와 `_edDocs` 열쇠의 표기 차이 (심볼릭 링크, NFC/NFD 한글 파일 이름)
- `!d.stamp`: 표식이 빈 문서가 생기는 길(저장·이동·다시 열기 경로)

### D. 문서는 갱신됐는데 화면이 낡은 채다

1차 세션의 DOM 측정은 단순한 구성에서만 했다. 미니맵·줄 바꿈·여러 칸 분할·슬롯 전환 뒤 다시 붙은 편집기에서 DOM 이 다시 그려지지 않는
경우는 재지 않았다.

---

## 5. 새 방향 (권장 순서)

1. **사용자 구성을 그대로 세운다.** 격리 e2e 서버에 사용자 `workspace.json` 의 구조(창 15개, Editor 창 10개, 사이드 `changes`,
   Diff 탭, `preview` 탭, 슬롯)를 세우고, 밖에서 파일을 바꾼 뒤 `_edLiveDocs()` 의 결과와 실제 요청 본문(`page.on('request')`)을 잰다.
   개인 경로는 임시 디렉터리의 같은 모양 경로로 바꾼다.
2. **요청 본문을 재는 것이 핵심이다.** "그 파일이 `paths` 에 들어 있었는가"가 B 와 D 를 가른다.
3. 재현이 안 되면, 진단을 남기는 길을 사용자에게 **제안한다** (새 기능이므로 결정이 필요하다). 예: 실시간 반영이 건너뛴 문서와 그 사유를
   서버 기록에 남기는 가벼운 통로. 지금은 클라이언트 → 서버 기록 통로가 없다.

---

## 6. 값을 치르고 배운 것

- **e2e 기본값과 사용자 설정이 다르면 재현되지 않는다.** `settings.json` 과 `workspace.json` 의 실제 값으로 조건을 맞춘다.
- 실행 중인 사용자 서버(포트 58146)에 브라우저를 붙이지 않는다 — 작업 공간 상태를 바꾼다. 격리 e2e 서버(58147~)로 잰다.
  사용자 서버의 **기록(`server.log`)과 설정 파일은 읽어도 된다** — 1차 세션의 가장 쓸모 있는 단서가 거기서 나왔다.
- 탐침은 `e2e/zz-*.spec.ts` 로 만들고 바로 지운다. `e2e/git-diff-doc.spec.ts` 의 `enter`·`openDiff` 를 머리로 잘라 붙이면 빠르다.
  고정 대기(`waitForTimeout`)가 남은 스펙은 `scripts/check-e2e-waits.mjs` 게이트에 걸린다.
- 탐침에서 클래스 전역은 `window` 에 없다 — `(0, eval)('EdBuffer')` 로 꺼낸다. 이벤트 버스는 `app.bus` 다.
- macOS 에는 `timeout` 명령이 없다.
- `pgrep -fl` 은 프로세스 환경 변수까지 찍는다 — 비밀값이 대화에 남는다. 프로세스는 `ps -Ao pid,etime,comm` 으로 본다.
- e2e 전체 묶음은 메모리를 많이 쓴다. 관련 스펙만 골라 돌린다.
- Serena 는 `activate_project` 에 세션 id 가 필요하다 — `initial_instructions` 를 먼저 부른다.

---

## 7. 변하지 않는 규약

- 검사: `npm run -s lint` · `npx tsc --noEmit -p e2e` · `npm run -s unit` · `make gates` · `go vet`(Go 를 고쳤을 때) · 관련 e2e.
- 사용자 전역 지침(`~/.claude/CLAUDE.md`): 심볼 탐색은 LSP → Serena → grep 순, 중·대 규모는 스펙 → 테스트 → 구현, 추측 금지·가정 명시,
  최소·국소 변경, 커밋은 사용자 확인 뒤, AI 서명 금지.
- 문서 산출물은 ASD-STE100 을 80% 정도로 완화하고, 한국어 문장이 자연스럽게 읽히도록 쓴다. SRS 는 IEEE 29148 이 우선이다.

---

## 8. 아직 유효한 사용자 결정

- 미니맵은 완벽하다 (2026-11-04). 손대지 않는다.
- 측정을 사용자에게 부탁하지 않는다. 직접 재현하거나 코드·기록으로 찾는다.
- 이 문제를 새 세션에서 새롭게 시작한다 (2026-11-04).
