# HTTP & WebSocket API

외부 통합용 공개 엔드포인트 정리. 내부 구현 세부는 [docs/internal/architecture.md](../internal/architecture.md) 참고.

용어는 [features.md](./features.md) 와 같다 — 창(Window) ▸ 분할 칸(Pane) ▸ 탭(Tab) ▸ 도구(Tool).

## REST

### 상태

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/state` | `{ tools, workspace }` 스냅샷. 응답 헤더 `ETag: <rev>` 포함 |
| GET | `/api/whoami?toolId=<id>` | 요청자의 도구 식별 정보. `toolId` 생략 시 remoteAddr → PID 부모 체인으로 역추적 |
| GET | `/api/workspace` | workspace.json raw (`schemaVersion: 2`). ETag 헤더 포함 |
| PUT | `/api/workspace` | workspace 저장. `If-Match: <rev>` 로 낙관적 동시성 제어. stale 시 409 + 최신 `ETag` 반환 |
| GET | `/api/settings` | 설정 조회 |
| PUT | `/api/settings` | 설정 저장 (`settings.json` 즉시 영속화) |
| GET | `/api/stats` | `{ hostname, cpu, memUsed, memTotal, diskPct, sysUptime, srvUptime }` |
| GET | `/api/ping` | `"ok"` (레이턴시 측정용) |

### 도구

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/tools?cols=&rows=&cwd=&cwdTool=` | 새 PTY 생성. `cwd` 또는 `cwdTool`(참조 도구 id) 중 하나로 시작 디렉터리 지정 |
| DELETE | `/api/tools/<id>` | PTY 종료 |
| GET | `/api/tools/<id>/busy` | `{ busy: bool }` — foreground process 여부 |
| GET | `/api/cwd?tool=<id>` | 해당 도구의 현재 작업 디렉터리. 응답 `{cwd, source}` — `source` 는 `tool`(도구의 것) 또는 `server`(폴백한 서버 프로세스 cwd). `tool` 생략·미상이면 폴백한다 |

### 에이전트 접합면

`dmctl read-screen`/`read-output`/`send-input`/`msg` 의 백엔드다. 개념과 사용법은
[agent-orchestration.md](./agent-orchestration.md).

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/output?id=&bytes=&strip=` | 도구의 스크롤백. `strip=1` 이면 ANSI 제거. `bytes<=0`/생략이면 전체 (기본값 판단은 `dmctl` 몫). `{ toolId, text, dropped }` |
| POST | `/api/tools/input` | `{ id, text, execute }` — bracketed paste 로 주입, `execute` 면 자동 엔터 |
| POST | `/api/tools/message` | `{ to, from, message }` — 신뢰 봉투로 감싸 주입 + 자동 엔터. `from` 이 비면 `unknown`. 봉투 헤더와 응답의 `from`/`to` 는 **uuid** 뿐 |

`id`/`to`/`from` 은 tab uuid·`toolId` 만 받는다. `W?.P?.T?` 좌표 라벨은 400, 대상이
없으면 404 `{ "error": … }`.

### 주의 알림 · 활동

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/attention` | 주의 상태인 도구 목록 |
| POST | `/api/tools/attention/set` | 주의 상태 설정 (`dmctl notify` 가 사용) |
| POST | `/api/tools/attention/clear` | 도구 하나의 주의 상태 해제 |
| POST | `/api/tools/attention/clear-all` | 전체 해제 |
| GET | `/api/tools/activity` | 도구별 현재 활동 상태 (도구당 최신 1건) |
| POST | `/api/tools/activity/set` | 활동 상태 보고 (`dmctl activity` 가 사용) |

### 백그라운드 도구

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/tools/background` | `{ background: [{toolId, name, cwd, since}] }` — 어느 탭에도 매이지 않고 도는 도구 |
| POST | `/api/tools/background/set` | 바디 `{toolId, background}`. 도구를 백그라운드로 보내거나 복귀시킨다. 미지 `toolId` 는 404. 목록이 바뀌면 `tools_background_changed` 를 방송한다 |
| POST | `/api/tools/headless` | 바디 `{cwd, command}`. 탭 없는 도구를 만들어 백그라운드에 등록한다. `command` 가 있으면 **그 명령이 도구의 프로세스**이며 끝나면 도구가 죽는다. 비면 로그인 셸 |

백그라운드 도구는 데몬 재시작을 넘기지 않는다 — `tools.json` 에는 탭이 참조하는 도구만 기록된다.

### 창 포커스 소유권

한 Window 를 어느 클라이언트가 보고 있는지를 서버가 들고 있다. 이 상태는 dim 표시와
**PTY 리사이즈 권한**을 함께 결정한다 — 소유자만 그 Window 의 PTY 크기를 정한다.

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/api/focus` | `{ owners: { "<windowId>": "<clientId>" } }` — 현재 소유권 스냅샷 |
| POST | `/api/focus/claim` | 바디 `{clientId, windowId}`. 그 클라이언트를 소유자로 만든다. 둘 중 하나라도 비면 400 |

- **last-focus-wins**: 기존 소유자는 협상 없이 밀려난다. 한 클라이언트는 동시에 한 Window 만 소유한다
- **in-memory**: 영속화하지 않는다. 서버 재시작이면 전원 해제다
- **해제**: `/api/commands/sse?clientId=<id>` 구독이 끊기면 그 클라이언트의 소유권을 **즉시** 해제한다. grace period 는 없다. 같은 `clientId` 의 더 새로운 구독이 있으면 옛 구독의 종료는 해제하지 않는다
- 소유권이 없는 Window 는 모두에게 밝게 보이고 모두가 리사이즈할 수 있다

### 파일

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/upload?dir=<path>` | multipart 업로드 (`file` 필드, 선택 `relPath`). 중복 파일은 `(1)`, `(2)` suffix. `relPath` 가 있으면 `dir` **아래로** 구조를 세운다(중간 디렉터리는 만들되 `dir` 자신은 만들지 않는다) — 터미널에 폴더를 끌어다 놓는 길이다. 개명은 **마지막 조각에만** 걸린다. `{ name, size, path }` 반환. 본문 상한 512MiB(초과 413), `dir` 은 실재하는 디렉터리여야 한다(아니면 400) |
| GET | `/api/download?path=<path>` | 파일 다운로드. 이름은 `filename` + `filename*`(RFC 5987) 두 벌로 나간다. 디렉터리는 400 |
| GET | `/api/file/read?path=<abs>` | 편집기 탭이 파일을 읽는 경로. 절대경로만 허용 |
| POST | `/api/file/write` | 바디 `{path, content}`. 편집기 탭의 저장 |
| GET | `/api/fs/list?root=<abs>&path=<abs>&offset=<n>` | 탐색기 한 겹 조회. dot 항목 포함, 정렬은 서버가 한다. 응답 `{path, entries:[{name,dir,link,linkDir}], offset, total, truncated, stamp}`. 한 번에 최대 10,000개이며 `truncated` 는 "이 응답 뒤에 더 있다" 는 뜻이다. `offset`(기본 0, 음수·정수 아님은 0)으로 그 다음 쪽을 받아 **이어 붙인다** — 같은 `offset` 이 같은 자리를 가리키는 것은 순서가 서버의 것이기 때문이다. `offset >= total` 은 오류가 아니라 빈 배열이다. `stamp` 는 **이 응답과 같은 관측**의 변경 표식이다 (아래 `/api/fs/stamp` 와 같은 값) |
| POST | `/api/fs/stamp` | 겹이 바뀌었는지만 값싸게 묻는다. 본문 `{root, dirs:[<abs>…]}` → `{stamps:{<abs>: "<문자열>"}}`. 값은 그 디렉터리의 mtime 이며 **해석하지 않고 같은지만 본다.** 읽을 수 없거나 루트 밖이거나 디렉터리가 아닌 겹은 오류가 아니라 응답에서 **빠진다.** `dirs` 는 512개까지 |
| POST | `/api/fs/create` | 바디 `{root, path, dir}` |
| POST | `/api/fs/rename` | 바디 `{root, from, to}`. 이동도 이 종단 |
| POST | `/api/fs/delete` | 바디 `{root, path}`. **영구 삭제** |
| GET | `/api/fs/download?root=<abs>&path=<abs>` | 탐색기 다운로드. `/api/download` 와 같은 헤더를 쓰되 루트 아래로 제한. **파일만** — 디렉터리는 400 |
| GET | `/api/fs/download-dir?root=<abs>&path=<abs>` | 폴더를 zip 으로 스트리밍. 이름은 `<폴더>.zip`. 항목 5만·2GiB 를 넘으면 **본문을 하나도 쓰기 전에** 400. 심볼릭 링크는 담기지 않는다 |
| POST | `/api/fs/upload?root=<abs>&dir=<abs>` | 탐색기 업로드 (`file` 필드, 선택 `relPath`). `relPath` 가 있으면 `dir` **아래로** 구조를 세운다(중간 디렉터리는 만들되 `dir` 자신은 만들지 않는다). **같은 이름이 있으면 409** — 덮어쓰지도 개명하지도 않는다 |
| POST | `/api/fs/ignored` | 한 겹에서 무시된 이름. 본문 `{root, dir, names:[…]}` → `{ignored:[…]}`. 저장소가 아니면 404 `not_repo`. 추적 중인 파일은 패턴에 맞아도 무시로 보고하지 않는다 |
| GET | `/api/editors` | `{home, notes, list}` — root 행의 경로, 메모 루트, 일반 행 목록. `home`·`notes` 는 `list` 에 들어 있지 않다. 메모 루트를 쓸 수 없으면 `notes` 키가 **빠진다** (그때는 메모장 행만 없고 나머지는 그대로 선다) |
| POST | `/api/editors/add` | 바디 `{path}`. 응답 `{list, pinned}` — git 핀이 함께 바뀔 수 있다 |
| POST | `/api/editors/remove` | 바디 `{path}`. 응답 `{list, pinned}` |
| POST | `/api/editors/reorder` | 바디 `{src, target, before}` |

`/api/fs/*` 는 전부 `root` 를 함께 받아 **그 아래로만** 동작합니다. `root` 는 서버가 신뢰하지 않고 `editors.list`·홈·메모 루트 중 하나에 실재하는지 대조합니다 — 그 셋이 `Roots()` 의 전부이며, 메모장이 파일 조작을 얻는 것도 메모 루트가 그 목록에 들기 때문입니다. 오류는 `{code, message}` 이며 코드는 `bad_request`(400) · `outside_root`·`permission_denied`(403) · `not_found`(404) · `exists`(409) · `too_large`(413) · `io_failed`(500) 입니다.

### 원격 제어

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/commands` | 워크스페이스 action 브로드캐스트. 바디 `{action, args?, reqId?}` — `dmctl`·`edit`·`detach` 가 사용 |
| GET | `/api/commands/sse` | Server-Sent Events. 브라우저가 구독해 다른 도구의 명령을 수신 |
| POST | `/api/command-result` | 브라우저가 생성 결과(`newWindows`/`newPanes`/`newTabs`)를 `reqId` 로 되돌려주는 경로 |

#### `/api/commands` 허용 action

20개. 그 외는 400.

| 분류 | action |
|------|--------|
| 생성 | `newWindow`, `newTab`, `splitH`, `splitV`, `openEditorTab` |
| 이동 | `focus`, `windowNext`, `windowPrev`, `tabNext`, `tabPrev`, `paneUp`, `paneDown`, `paneLeft`, `paneRight` |
| 종료 | `closeTab`, `closeWindow` |
| 이름 | `renameTab`, `renameWindow` |
| 백그라운드 | `detachTab`, `restoreTool` |

`args` 스키마 (전부 선택):

```json
{ "location": "<탭 uuid>", "count": 3, "keepFocus": true, "name": "worker-1",
  "filePath": "/abs/path", "toolId": "12" }
```

`location` 은 **uuid 만 허용**한다 — `dmctl list-workspace` 의 `uuid=` 컬럼 값. 좌표(`W4.P1.T1`)·라벨·`toolId` 는 400 으로 거부된다. 다른 창이 닫히면 좌표가 reflow 되어 엉뚱한 탭을 가리키기 때문이다. 서버가 broadcast 직전에 uuid → 좌표로 변환한다.

`detachTab` 은 `location` 이 아니라 `toolId` 를 받는다 — `toolId` 만으로 대상이 완전히 결정되므로 대상 지정 수단이 필요 없다. `restoreTool` 은 `toolId` 에 더해 `location`(선택)을 받는다: 지정하면 그 탭이 **속한 분할 칸**에 복귀하고(탭 성분은 무시), 그 분할 칸이 사라졌으면 복귀하지 않는다(도구는 백그라운드 목록에 남는다). `location` 을 생략하면 브라우저가 현재 포커스한 분할 칸에 복귀하며, 포커스가 해소되지 않으면 활성 창의 첫 분할 칸으로 폴백한다 — 생략 경로는 조용히 무효가 되지 않는다.

둘 다 `dmctl` 의 레이아웃 서브커맨드로는 호출할 수 없다 — `detach` CLI 전용 경로다.

## REST — 나머지 표면 (M5 `DOC-4`)

> 착수 시 이 문서는 실제 HTTP 표면의 **절반 이상을 빠뜨리고** 있었다 — Git 74개와
> Run 11개가 통째로 없었다. 문서가 절반만 적는 것보다 나쁜 것은 **그것이 절반인
> 줄 모르는 것**이다. 이제 `scripts/check-api-docs.sh` 가 양방향으로 대조하며,
> 종단을 더하고 여기를 잊으면 CI 가 멎는다.
>
> **모든 오류 응답은 `X-Error-Code` 헤더에 코드를 싣는다.** 본문의 모양은 표면마다
> 다르지만(방언 다섯) 헤더는 어디서나 같다 — 분기는 헤더로 하고, 코드의 뜻은
> [`errors.md`](./errors.md) 에 있다. 함께 실리는 `X-Request-Id` 는 그 요청 하나의
> 식별자이며, 신고에 적으면 서버 로그에서 그 요청이 남긴 줄 전부를 찾을 수 있다.

### 진단·상태

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | 사람이 읽는 상태. 판·가동 시간·도구 수·데몬 연결과 **판 불일치**·워크스페이스 rev·마지막 적재/영속 실패. 어긋난 것이 있어도 200 이며 사실은 본문에 있다 |
| GET | `/api/diag` | 기계가 읽는 집계. `tools`·`ws`·`goroutines`·`allocMB`·`persistErr`·`gate.{access,request}`(게이트별 거절 수)·`reconnects`·`uptime`·`version`·`logLevel`. **개별 식별 정보를 싣지 않는다** — 주소·경로·도구 이름이 없다 |
| GET | `/api/access` | 접속 허용 목록(ACL)의 현재 설정 |
| ANY | `/api/open-url/where` | URL 을 **어디서** 열지의 판정만 낸다 (부작용 없음) |

### 워크스페이스 되돌리기

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/workspace/revisions` | 되돌릴 수 있는 세대 목록. `{rev, generations:[{gen,bytes,modified}]}` |
| POST | `/api/workspace/revert` | `{gen}` 세대를 현재 판으로 올린다. 직전 판이 세대 사슬의 맨 앞으로 들어가므로 **되돌리기도 되돌릴 수 있다**. 범위 밖이면 400, 그 세대가 없으면 404, 깨졌으면 409 |

### 파일·탐색

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/file/probe` | 파일의 성격만 본다 — 크기·텍스트 여부·MIME. 내용을 읽지 않는다 |
| GET | `/api/file/raw` | 파일 바이트 그대로. 이미지·이진 파일의 자리 |
| POST | `/api/fs/copy` | 복사·이동 |
| GET | `/api/fs/find` | 파일 **이름** 검색 |
| GET | `/api/fs/grep` | 파일 **내용** 검색 (`rg` 가 있으면 그것을 쓴다) |

### 도구 — 나머지

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/tools/activity/get` | 도구 하나의 현재 활동 상태 |
| GET | `/api/tools/activity/wait` | 그 상태가 바뀔 때까지 **기다린다** (long-poll). 폴링 루프를 짜지 마세요 |
| POST | `/api/tools/kill` | 도구의 전경 프로세스를 정지시킨다 |

### 언어 서버 (LSP)

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/lsp/status` | 그 언어의 서버가 설치·기동돼 있는가 |
| POST | `/api/lsp/install` | 그 언어의 서버를 설치한다 |
| POST | `/api/lsp/definition` | 정의로 이동 |
| POST | `/api/lsp/references` | 참조 찾기 |
| POST | `/api/lsp/hover` | 호버 정보 |

### 샌드박스

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/sandbox/profiles` | 정의된 프로파일 목록 |
| GET | `/api/sandbox/config` | 샌드박스 설정 |
| GET | `/api/sandbox/runtime` | 컨테이너 런타임의 상태 — `ok`·`missing`·`stopped`. 셋은 사용자가 할 일이 다르다 |
| POST | `/api/sandbox/runtime/start` | 멎어 있는 런타임을 띄운다 |

### Run (오케스트레이션)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/runs` | Run 목록·상세 (`?id=`) |
| GET | `/api/runs/graph` | Run 하나의 팀 구조 — 누가 누구를 조정하는가 |
| POST | `/api/runs/members` | Run 에 팀원을 등록한다 |
| GET | `/api/runs/preamble` | 그 팀원의 기동 프리앰블 |
| GET | `/api/runs/peers` | 같은 Run 의 다른 팀원들 |
| POST | `/api/runs/context` | 세션에 상시 주입할 컨텍스트 |
| POST | `/api/runs/attach` · `/api/runs/detach` | 도구를 Run 에 붙이고 뗀다 |
| POST | `/api/runs/handoff` | 팀원 자리를 넘긴다 |
| POST | `/api/runs/report` | 팀원이 자기 몫의 결과를 보고한다 |
| POST | `/api/runs/succeed` | Run 을 성공으로 닫는다 |
| POST | `/api/runs/close` | Run 을 닫는다 |

### Git — 저장소·상태

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/git/repos` | 핀 목록과 각 배지. `?observe=1` 이면 응답 전에 핀 전부를 관측한다 |
| GET | `/api/git/repo-at` | 그 경로가 저장소인가 (또는 어느 저장소에 속하는가) |
| POST | `/api/git/init` | 그 자리를 저장소로 만든다 |
| POST | `/api/git/repos/pin` · `/api/git/repos/unpin` | 핀을 더하고 뺀다 |
| POST | `/api/git/repos/reorder` | 핀 순서. **서버가 권위**다 |
| GET | `/api/git/status` | 변경 목록 |
| GET | `/api/git/signature` | 저장소의 변화 서명 — 바뀌었을 때만 알리기 위한 값 |
| GET | `/api/git/policy` | 이 저장소에서 허용되는 동작 |
| GET | `/api/git/preflight` | 그 동작이 지금 가능한가 (사전 점검) |
| GET | `/api/git/recovery` | 중단된 작업에서 돌아오는 길 |

### Git — 변경·커밋

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/git/stage` · `/api/git/unstage` | 스테이지에 올리고 내린다 |
| POST | `/api/git/patch` | **부분 스테이징.** 화면이 본 내용과 디스크가 어긋나면 거절한다 |
| GET | `/api/git/hunks` | 변경 덩어리 목록 |
| POST | `/api/git/discard` | 변경을 버린다 |
| POST | `/api/git/commit` | 커밋 |
| POST | `/api/git/undo-last` | 마지막 커밋 되돌리기 (창이 지나면 거절) |
| GET | `/api/git/diff-content` | diff 본문 |
| GET | `/api/git/file-head` | HEAD 판의 파일 내용 |
| GET | `/api/git/blame` | 줄별 마지막 변경자 |
| GET | `/api/git/log` | 커밋 기록 |
| GET | `/api/git/commit-range` | 두 지점 사이의 커밋들 |
| POST | `/api/git/uncommitted/reset` · `/api/git/uncommitted/clean` | 미커밋 변경을 되돌리고, 추적되지 않는 파일을 지운다 |
| POST | `/api/git/ignore` | `.gitignore` 에 더한다 |

### Git — 브랜치·태그

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/git/refs` | 브랜치·태그 목록 |
| GET | `/api/git/branch/validate` · `/api/git/tag/validate` | 이름이 git 규칙에 맞는가 |
| POST | `/api/git/branch` · `/api/git/tag` | 만든다 |
| POST | `/api/git/branch/rename` | 이름을 바꾼다 |
| POST | `/api/git/branch/delete` · `/api/git/tag/delete` | 지운다 |
| POST | `/api/git/branch/delete-remote` · `/api/git/tag/delete-remote` | 원격의 것을 지운다 |
| POST | `/api/git/checkout` | 그 ref 로 옮긴다 |
| POST | `/api/git/branch/upstream` | 추적 대상을 정한다 |
| POST | `/api/git/branch/merge` · `/api/git/branch/rebase` | 합친다 |
| GET | `/api/git/branch/merge-preview` | 합치면 무엇이 바뀌는가 (실행하지 않는다) |
| POST | `/api/git/branch/push` · `/api/git/branch/fetch` | 그 브랜치만 밀고 받는다 |
| POST | `/api/git/tag/push` | 태그를 민다 |
| POST | `/api/git/cherry-pick` · `/api/git/revert` | 커밋 하나를 가져오고 되돌린다 |
| POST | `/api/git/reset` | `soft`·`mixed`·`hard` |
| POST | `/api/git/operation` | 진행 중인 작업(merge·rebase…)을 잇거나 중단한다 |
| POST | `/api/git/resolve` | 충돌을 해결한 것으로 표시한다 |

### Git — 원격·동기화

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/git/remotes` | 원격 목록 |
| POST | `/api/git/remote/add` · `/api/git/remote/remove` | 원격을 더하고 뺀다 |
| POST | `/api/git/fetch` · `/api/git/pull` · `/api/git/push` | 받고 당기고 민다 |
| GET | `/api/git/jobs` | 도는 작업 목록 |
| GET | `/api/git/job/events` | 그 작업의 진행 (SSE) |
| POST | `/api/git/job/cancel` | 작업을 취소한다 |

### Git — stash·worktree·submodule

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/git/stash` | stash 목록 |
| GET | `/api/git/stash/show` | 그 stash 의 내용 |
| POST | `/api/git/stash/push` | 지금 변경을 치워 둔다 |
| POST | `/api/git/stash/apply` · `/api/git/stash/pop` | 되돌린다. `pop` 은 성공하면 목록에서 뺀다 |
| POST | `/api/git/stash/branch` | 그 stash 로 브랜치를 만든다 |
| POST | `/api/git/stash/drop` | 버린다 |
| GET | `/api/git/worktrees` | worktree 목록 |
| POST | `/api/git/worktrees/create` · `/api/git/worktrees/remove` | 만들고 지운다 |
| GET | `/api/git/submodules` | 서브모듈 목록 |
| POST | `/api/git/submodules/sync` · `/api/git/submodules/update` | 동기화하고 갱신한다 |

### Git — 기록

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/git/records` | 이 앱이 실행한 git 명령의 기록 (Git ▸ 콘솔 탭) |
| POST | `/api/git/records/replay` | 그중 하나를 다시 실행한다 |
| POST | `/api/git/drop` | 기록 하나를 지운다 |

## WebSocket: `/ws?tool=<id>&cols=&rows=&since=`

Binary 프로토콜. 첫 바이트가 opcode.

| Opcode | 방향 | 페이로드 |
|--------|------|----------|
| `0x00` | S→C | 터미널 출력 (UTF-8 바이트) |
| `0x00` | C→S | 터미널 입력 |
| `0x01` | C→S | 리사이즈: `cols uint16 BE + rows uint16 BE` |
| `0x01` | S→C | 에러 메시지 (UTF-8) |
| `0x02` | S→C | 프로세스 종료 알림 |
| `0x03` | S→C | 도구 id 할당 (문자열). 연결 직후 서버가 보내고 브라우저가 `dataset.toolid` 에 반영 |
| `0x04` | S→C | 좌표 통보: `offset uint64 BE + full uint8`. 재생이 끝난 자리를 알린다 |

서버는 `gorilla/websocket` ping/pong 으로 keep-alive (pong 60s, ping 54s). 모든 쓰기는 `safeConn` mutex 로 직렬화.

### 재접속 (`since`)

`since=<offset>` 은 **클라이언트가 마지막으로 본 바이트 오프셋**이다. 도구가 켜진 뒤
PTY 가 낸 누적 바이트 수이며, 서버의 `0x04` 통보에서 받은 값에 그 뒤로 받은 `0x00`
페이로드의 바이트 길이를 더해 유지한다.

| 요청 | 서버가 보내는 것 |
|---|---|
| `since` 없음 | **전량 재생** — 터미널 모드 초기화 + 화면·스크롤백 클리어 + 보유 스크롤백 |
| `since` 가 보유 창 안 | **델타 재개** — 그 뒤의 바이트만. 화면을 지우지 않는다 |
| `since` 가 보유 창 밖 | 전량 재생으로 조용히 강등 (오류가 아니다) |

두 갈래 모두 마지막에 `0x04` 로 새 좌표를 통보한다. `full=1` 이면 전량 재생이었다는
뜻이고, 그때 클라이언트는 TUI 가 스스로 전체를 다시 그리도록 `0x01` 리사이즈를 한 행
줄였다 되돌린다.

`since` 를 보내지 않는 클라이언트는 종전과 같이 전량 재생을 받는다. `0x04` 를 모르는
클라이언트는 그 프레임을 무시하면 된다 — 기존 opcode 의 뜻과 형식은 바뀌지 않았다.

## SSE: `/api/commands/sse`

`/api/commands` 로 들어온 action 을 구독 중인 모든 브라우저에 브로드캐스트. 15s 주기 keep-alive 주석. 브라우저가 여러 탭으로 열려 있으면 모두 동일 action 을 수행.

`?clientId=<id>` 를 붙이면 서버가 그 구독을 클라이언트와 결선한다 — 구독이 끊길 때 창 포커스 소유권을 해제하기 위한 것이다. 생략해도 스트림은 정상 동작한다 (소유권 결선만 없다).

서버가 자체적으로 발행하는 이벤트도 같은 스트림을 쓴다:

| 이벤트 | 의미 |
|--------|------|
| `workspace_changed` | 다른 클라이언트가 워크스페이스를 바꿨다 |
| `tool_attention` | 도구가 주의를 요구한다 |
| `tool_attention_clear` | 주의 상태 해제 |
| `tool_activity` | 도구의 활동 상태 갱신 |
| `window_focus` | 창 포커스 소유권이 바뀌었다. `args.owners` 는 **전체 맵**이다 (증분이 아니다) |

## OSC 777 커스텀 이스케이프

PTY 출력에서 브라우저로 특수 명령 전달. 형식은 `ESC ] 777 ; <cmd> ; <payload> BEL`.

| 시퀀스 | 발신자 | 설명 |
|--------|--------|------|
| `ESC]777;Download;<path>BEL` | `download` 헬퍼 | 브라우저 다운로드 트리거 (`/api/download`) |
| `ESC]777;Cwd;<path>BEL` | zsh/bash 훅 | 현재 디렉터리 실시간 보고 |
| `ESC]777;notify;<body>BEL` | 임의의 CLI·에이전트 | 주의 알림. 서버가 관찰해 `tool_attention` 으로 전환 |

서버는 스냅샷을 재생할 때 이 사설 시퀀스를 제거한다 (`stripOSC777`) — 새로고침 때 다운로드가 다시 트리거되는 것을 막기 위함이다.

## OSC 52 클립보드

표준 시퀀스이며 **브라우저가 처리한다** — 서버는 지나가게 둘 뿐이다.
형식은 `ESC ] 52 ; <targets> ; <base64> BEL`.

| 방향 | 동작 |
|---|---|
| 쓰기 (`<base64>`) | 클립보드에 넣는다. `navigator.clipboard` → `execCommand` → 복사창 순으로 내려간다 — 앞의 둘은 secure context 와 사용자 제스처를 요구하므로 환경에 따라 없다 |
| 읽기 (`?`) | **응답하지 않는다.** 원격의 셸에 사용자 클립보드를 넘기는 통로를 열지 않는다 |

대상(`c`·`p`·`s`)은 가르지 않는다 — 브라우저에는 클립보드가 하나뿐이다. 페이로드
상한은 1 MiB 이며, 넘으면 무시한다.
