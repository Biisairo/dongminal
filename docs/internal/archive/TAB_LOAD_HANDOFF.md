# 인계: 탭을 열 때 불러오기 실패(하얀 화면·지연) 결함

> **문서 상태**: 착수 문서 (2026-11-12, 세션 `UX_BATCH12-5` → `TAB-LOAD`)

## 착수 블록 — 다음 세션의 지시 전부

1. **결함**: 사용자 보고 원문 — *"사용 중이던 탭을 열었을 때 탭을 불러오는 것이 실패하여 하얀 화면이 뜨거나 오래 걸리는 경우가 생겼다. 확인해 봐."*
2. **먼저 재현 조건을 좁힌다.** 아직 아무것도 조사하지 않았다. 좁힐 축:
   - 탭 종류: 터미널 / 편집기 / Diff / git 뷰(History·Branches·Stash·Console·Worktrees·Submodules) / Run
   - 계기: 다른 창에 갔다 돌아오기, 슬롯 전환, 새로고침(소프트·하드), 서버 재시작, 오래 둔 뒤
   - "하얀 화면" 은 이 앱의 어두운 테마에서는 비정상이다 — 빈 `iframe`·문서 렌더·CodeMirror 미생성·`.tp` 미부착 등 무엇이 하얀지 먼저 본다
   - 범위가 불명확하면 사용자에게 **한 번에 하나씩** 묻는다(어떤 탭에서, 어떤 동작 뒤에)
3. 규모를 판단한다. 중·대면 SRS(IEEE 29148) → 테스트(RED 확인) → 수정. 소면 "작업 이해 1줄 + 가정 + 검증 계획".
4. 관련 e2e 만 돌린다(전체 e2e 는 오래 걸린다 — 사용자 규약).
5. **커밋은 사용자 확인 뒤**에만 한다. 커밋 메시지에 AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.

## 어디까지 왔나

직전 세션은 UI 다듬기를 마쳤다. 이 결함과 직접 관련된 변경은 없지만, 화면 쪽을 넓게 건드렸으므로 **최근 커밋이 원인 후보인지 먼저 배제**한다.

| 커밋 | 내용 |
|---|---|
| `56a3d48d` | 화면 다듬기 (UI_POLISH_SRS FR-UIP-1~24) — 터미널 본문 여백 `.tp{padding:4px 8px}`, 사이드바 기본 200px, 빈 편집 영역 안내(`renderer-layout.js` `_paintEdEmpty`), 설정 세로 목록·검색, 저장소 경로 후보(`ui/path-suggest.js`), 커밋 사유 줄 등 |
| `acb2028c` | hunk 툴바 단위를 화면이 칠한 덩어리로(FR-UIP-25), 뒤로·앞으로 툴팁 영어 |
| `7520d5c6` | Stash·Worktrees·Submodules 전용 아이콘, git 패널 아이콘은 키트 비율 규칙 |

**의심해 볼 만한 자리** (확인 안 함, 가설일 뿐):
- `.tp` 의 여백 변경 → xterm FitAddon 이 0 크기로 재는 경우(숨은 칸에서 붙을 때)
- `_paintEdEmpty` 가 매 render 에 불리며 `edSideOf(s)` 를 부름 — `s` 가 없을 때
- 위 셋과 무관할 가능성도 크다(사용자는 "생겼다" 고만 했다). `git stash` 로 이전 코드와 비교해 회귀인지 가른다

## 먼저 읽을 것

- `docs/internal/UI_POLISH_SRS.md` — 직전 작업 전체(§3, 대장 §0)
- `docs/internal/VIEW_SCROLL_RESTORE_SRS.md`, `docs/internal/RELOAD_CONTINUITY_SRS.md` — 탭을 떼었다 다시 붙이는 경로
- `web/js/ui/renderer-layout.js`, `web/js/ui/renderer-pane-wire.js`, `web/js/ui/term-pane.js` 류 — 탭 본문 부착

## 값을 치르고 배운 것

- **격리 인스턴스로 재현한다.** 사용자의 실제 dongminal 을 건드리지 않는다:
  ```
  go build -o /tmp/dm-unslop/dm ./cmd/dongminal
  PORT=58990 DONGMINAL_HOME=/tmp/dm-unslop/home DONGMINAL_TOOL_HOME=/tmp/dm-unslop/tool-home /tmp/dm-unslop/dm start --foreground
  ```
  웹 자산은 바이너리에 들어 있으므로 **고칠 때마다 다시 빌드·재시작**한다. 데모 저장소는 `/tmp/dm-unslop/notes-app`.
- e2e 는 `npx playwright test e2e/<파일>.spec.ts --reporter=line --retries=0`. 회귀인지 볼 때는 `git stash push -u` 로 이전 코드에서 같은 시험을 돌리고 `git stash pop` 으로 되돌린다.
- e2e 는 `app.testing.<이름>` 계약만 쓴다(게이트 `check` 가 막는다). 이름은 내부 이름에서 앞의 `_` 를 뗀 것이고, 새 이름은 `web/js/core/app-testing.js` 에 먼저 등록한다.
- 화면 문구는 카탈로그(`web/js/i18n/ko.js`·`en.js`)를 거치고, 툴팁(`title`)은 영어다(FR-TIP-2). 조사는 마커(`{으로로}` 등)로 쓴다 — 게이트가 잡는다.
- 레이아웃 기준선(`e2e/baseline/ui-layout.*.json`)을 바꿔야 하면 전체를 갈아 쓰지 말고 **바뀐 키만** 반영한다(darwin 에서 잰 값을 linux·win32 에 그대로).
- 기존 실패 e2e(무관): `git-history.spec.ts` H5, `ux-batch10.spec.ts:428`. 간헐: `editor-ops.spec.ts` O7.

## 변하지 않는 규약

- `make gates` · `make lint` · `npm run -s unit` · `npm run -s typecheck` 가 통과해야 끝이다.
- 동작이 바뀌면 이전 동작 / 새 동작 / 이유를 SRS 에 적는다. 다른 SRS 의 요구를 뒤집으면 그 자리에 개정 표시를 단다.
- CHANGELOG `[Unreleased]` 에 사용자에게 보이는 변화를 적는다.

## 사용자 결정 중 유효한 것

- UI 아이콘 크기는 고정값이 아니라 키트 비율 규칙(버튼 높이 × `--ui-icon-ratio`, FR-UIK-3)이다.
- 일반 버튼 라벨은 한국어, git 고유 용어·설정 탭 이름·툴팁은 영어다.
