# 인계: 사용자 보고 오류 5건 (2026-11-10)

> **상태: 완료 (2026-11-10).** 아래 본문은 착수 때의 기록이다.
>
> | 항목 | 결과 |
> |---|---|
> | 3-1 `fs/watch` 400 | `1d3233a1` — 부팅의 첫 등록이 SSE 구독보다 먼저 나갔다 |
> | 3-2 이름 편집이 끝나지 않음 | `547ee922` — 이름이 그대로면 행이 다시 만들어지지 않아 편집칸이 남았다 |
> | 3-3 hover 떨림 | 코드 수정 없음 — 사용자가 OS 쪽 문제로 확인했다 |
> | 3-4 이슈 트리 포커스 튐 | `2df58776` — 지목한 원격 닫기가 시선을 옮겼다. 사용자 결정: 이슈 트리의 조작은 포커스를 옮기지 않는다 |
> | 3-5 다른 탭 반영 | `8dc64723` — 다른 탭의 변경을 받지 않았고, 비교를 저장소 값과 했다 |

## 1. 착수 블록 (이번 세션의 지시 전부)

- **할 일**: 사용자가 새 빌드를 올린 뒤 보고한 오류 5건(§3)을 조사하고 고친다.
- **순서**: §3 의 순서대로 한다. 원인이 서로 이어져 보이면 묶어서 고친다.
  - 예: 3-1(`/api/fs/watch` 400)과 3-5(다른 브라우저 탭에 반영 안 됨)는 둘 다 탭 사이 동기화와 저장 경로에 걸쳐 있을 수 있다.
- **방식**:
  - 결함마다 **먼저 재현한다.** 재현하는 테스트(단위 또는 e2e)를 쓰고 실패를 확인한다(RED). 그다음 고친다(GREEN).
  - 고친 뒤에는 수정을 잠시 되돌려 그 테스트가 실패하는지 본다(변이 확인).
  - 원인을 모르는 채로 고치지 않는다. 추정이면 추정이라고 적는다.
  - 규모가 커지거나(다중 모듈, 구조 변경) 설계 결정이 필요하면 사용자에게 묻는다. 한 번에 하나씩, 권장안과 함께 묻는다.
- **질문**: 사용자는 쉽고 자세한 설명을 원한다. 미사여구 없이 본론만 쓴다.
- **커밋**: 사용자 확인 뒤에만 한다. AI 서명(`Co-Authored-By` 등)을 넣지 않는다. push 하지 않는다.
- **금지**: 사용자의 dongminal 을 재시작하지 않는다. 재현은 격리된 e2e 서버(playwright)나 단위 테스트로 한다.
- **완료 조건(묶음마다)**: `make gates`, `make lint`, `go test ./...`, `npm run -s unit`, `npm run -s typecheck`, `GOOS=windows go build ./...`, 그리고 바꾼 화면에 관련된 e2e.

## 2. 어디까지 왔나

- 직전 작업(노드 간 통신 리뷰 수정)은 끝났다. 마지막 커밋은 `7fd68beb` 이다. 작업 트리는 깨끗하다.
  - `docs/internal/PEER_NETWORK_REVIEW_HANDOFF.md` 는 이미 끝난 작업의 문서다. 이번 일과 관계없다.
- 사용자는 그 상태로 새로 빌드해 올렸다. 아래 오류는 그 빌드에서 확인한 것이다.
- 5건 모두 아직 조사하지 않았다.

## 3. 오류 5건 (사용자 보고 원문 기준)

### 3-1. `PUT /api/fs/watch` 가 400 (원인 모름)

- 콘솔에 아래 두 줄이 나온다.
  - `Failed to load resource: the server responded with a status of 400 (Bad Request)`
  - 호출 스택:

    ```
    api.js:113        PUT http://localhost:58146/api/fs/watch 400 (Bad Request)
    apiSend           api.js:113
    apiPut            api.js:176
    _edWatchSend      app-editor-watch.js:48
    TIMERS.frame.owner app-editor-watch.js:32
    (anonymous)       timer-hub.js:271
    requestAnimationFrame
    frame             timer-hub.js:271
    edWatchSync       app-editor-watch.js:32
    render            app.js:709
    init              app.js:164
    (anonymous)       main.js:33
    ```

- 페이지를 처음 띄울 때(`init` → `render` → `edWatchSync`) 일어난다.
- 볼 것: `web/js/core/app-editor-watch.js` 가 보내는 본문, 서버의 `/api/fs/watch` 처리기가 400 을 내는 조건(오류 코드 본문을 읽는다). 감시할 경로가 비어 있거나 아직 정해지지 않은 상태에서 보내는지 확인한다.

### 3-2. windows 패널에서 window·group 이름을 바꾼 뒤 편집 모드가 풀리지 않음

- 이름을 바꾼 뒤 **다른 window 를 클릭하지 않으면** 편집 모드가 풀리지 않는다.
- 참고: 비슷한 결함을 전에 고친 적이 있다(그룹이 있을 때 window 이름이 확정되지 않던 결함, 그룹 이름을 고칠 수 없던 결함).
  - `git log --oneline --grep "window 이름"` 이나 `--grep sidebar` 로 그 커밋을 찾아 무엇을 고쳤는지 먼저 본다.
  - 그때 원인은 둘이었다. 하나는 워크스페이스를 다시 받을 때 창 객체가 복사본으로 바뀌어 옛 객체를 고친 것, 다른 하나는 더블클릭의 첫 클릭이 행을 다시 그린 것이다.
  - 이번 증상이 같은 원인의 다른 갈래인지 확인한다.
- Enter, 바깥 클릭, Esc, 포커스 이동에서 각각 편집이 끝나는지 본다.

### 3-3. hover 효과가 있는 요소에서 떨림

- hover 시 오버레이나 버튼이 뜨는 요소가 있다. 그 위에서 마우스를 움직이면 깜빡깜빡 거린다.
- 흔한 원인 후보(추정이다, 확인 필요):
  - hover 로 뜬 요소가 마우스 아래를 덮어 원래 요소의 hover 가 풀리고, 다시 뜨기를 되풀이한다.
  - hover 처리가 다시 그리기(render)를 불러 DOM 이 바뀐다.
- 어느 요소들인지 사용자에게 예를 묻기 전에, 코드에서 hover 로 무언가를 띄우는 곳을 먼저 찾는다(CSS `:hover` 로 띄우는 요소와 JS `mouseenter`·`mouseover` 처리기).

### 3-4. 이슈 트리 동작 중 포커스가 튐

- 이슈 트리에서 탭을 만들고, 세션을 열고, 탭을 닫는 동작을 할 때 포커스가 튀는 경우가 있다.
- 사용자 요청: **코드를 자세히 확인**할 것.
- 볼 것:
  - `newTab`·`newWindow`·`closeTab` 명령의 `keepFocus` 처리(`web/js/core/app-cmd.js`).
  - `dmctl new-tab -n` 이 실제로 포커스를 지키는지.
  - 탭을 닫은 뒤 포커스가 어디로 가는지.
  - 단일 실행자(`execClientId`, `IsSingleExecutorAction`)와 여러 브라우저 사이의 포커스 소유.
- 이슈 트리 명령의 절차 문서는 플러그인 `dongminal:issue-tree` 와 `docs/` 아래 issue-tree 관련 SRS 에 있다.

### 3-5. 좌우 패널을 고치면 같은 PC 의 다른 브라우저 탭에 제대로 반영되지 않음

- 좌우 패널을 한 번 고치면, 같은 컴퓨터의 다른 브라우저 탭에 제대로 반영되지 않는 경우가 있다.
- 그 상태에서는 **다시 고쳐도 먹히지 않는다.** 새로고침하면 반영되고 오류도 풀린다.
- 볼 것: 패널 상태가 어디에 저장되는지(서버 설정인지 localStorage 인지), 다른 탭에 무엇으로 알리는지(SSE 방송, `storage` 이벤트), 받은 쪽이 지역 상태를 덮는지. "다시 고쳐도 안 먹힌다"는 받은 쪽의 지역 상태와 서버 값이 어긋난 채 남는다는 뜻일 수 있다.

## 4. 먼저 읽을 것

- `CLAUDE.md`(저장소 루트, 있으면)와 `docs/internal/README.md`(문서 색인).
- 3-1: `web/js/core/app-editor-watch.js`, 서버의 fs watch 처리기(`grep -rn "fs/watch" internal`).
- 3-2: windows 패널(사이드바) 코드, 위의 이전 수정 커밋.
- 3-4: `web/js/core/app-cmd.js`, issue-tree 관련 SRS.
- 3-5: 패널 상태를 저장하고 방송하는 코드.

## 5. 배운 것 (같은 값을 다시 치르지 않게)

- **시간 게이트**: `web/js` 에서 `setTimeout`·`setInterval`·`requestAnimationFrame` 을 직접 쓰면 `make gates` 가 막는다(`scripts/check-timers.sh`). `this.timers.after(ms, fn, {owner, label})` 와 `this.timers.cancel(h)` 를 쓴다.
- **프론트 단위 테스트**: 클래식 스크립트를 `web/js/test/harness.mjs` 의 `load([...], {globals})` 로 불러 시험한다. 예: `web/js/test/peers-notice.test.mjs`.
- **변이 확인**: 고친 줄을 잠시 되돌려(`cp` 로 백업 → `perl -0pi` 로 변이 → 테스트 → 복원) 테스트가 실패하는지 본다. 복원한 뒤에는 `git diff --stat` 으로 확인한다.
- **흔들리는 테스트**: 테스트에서 `sleep` 으로 순서를 맞추지 않는다. "그 상태에 들어갔음"을 신호나 폴링으로 확인한 뒤 다음으로 간다. 동시성 테스트는 `-race -count=N` 으로 반복해 본다.
- **원래 흔들리거나 실패하는 테스트(무관)**: `e2e/event-timer-hub-contract` 의 T-1·T-1b, `web/js/test/cm-sticky.test.mjs`, `git-sidebar.spec.ts` 의 S7.
- **셸**: zsh heredoc 은 `‮` 같은 이스케이프를 실제 바이트로 바꾼다. 파일 수정은 python 이 안전하다. macOS sed 는 `\b` 를 모른다. `perl -pi -e` 를 쓴다.
- **오류 코드 추가**: `internal/webserver/apierr/codes_*.go` 와 `codes_doc.go` 를 함께 고치고 `go run ./scripts/gen-errors` 를 돌린다.
- **Markdown 표**: 표 안의 `|` 는 백틱 안이어도 `\|` 로 쓴다.

## 6. 변하지 않는 규약

- 사용자의 dongminal 을 재시작하지 않는다. push 하지 않는다. 커밋은 사용자 확인 뒤, AI 서명 없이.
- 문서와 코드가 충돌하면 코드를 우선한다. 충돌은 끝에 보고하고, 사용자 선택에 따라 문서를 고친다.
- 동작이 바뀌면 이전 동작, 새 동작, 이유를 적는다.
- 문서는 ASD-STE100 을 80% 정도로 적용하고, 한국어는 자연스럽게 쓴다.
