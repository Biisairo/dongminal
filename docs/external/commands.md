# 터미널 내부 CLI (`dmctl`, `edit`, `download`, `detach`)

Dongminal 서버는 기동 시 `$DONGMINAL_HOME/bin/` 에 헬퍼를 설치하고, 각 터미널 도구의 shell 은 이 디렉터리를 `PATH` 에 자동 주입받습니다. 즉 터미널에서 바로 아래 명령을 쓸 수 있습니다.

헬퍼는 dongminal 바이너리를 가리키는 symlink 입니다 (multi-call CLI) — 서버와 헬퍼의 버전이 어긋날 수 없습니다.

공통 환경 변수 (서버가 자동 주입):

- `DONGMINAL_PORT` — 서버 포트 (기본 58146 또는 `PORT` 값)
- `DONGMINAL_HOST` — 기본 `127.0.0.1`
- `DONGMINAL_TOOL_ID` — 그 셸이 속한 도구 id (`detach` 가 사용)

## `dmctl` — 워크스페이스 원격 제어

실행 중인 브라우저(들)에게 `/api/commands` 로 명령을 브로드캐스트합니다. SSE (`/api/commands/sse`) 로 구독 중인 모든 탭이 동일한 동작을 수행합니다.

### 서브커맨드

| 명령 | 설명 |
|------|------|
| `dmctl new-window [--name <이름>] [-n]` | 새 창 생성. `--name` 으로 잡 이름 지정, `-n` 이면 백그라운드 생성 (사용자 포커스·화면 무변화 — 사이드바에만 추가) |
| `dmctl new-tab [--name <이름>] [-n] [--at <uuid>]` | 새 탭. `--at` 으로 다른 분할 칸 대상 지정 가능. `-n` 이면 대상 분할 칸의 활성 탭도 유지한 채 백그라운드 추가 |
| `dmctl split-h [N]` | 가로 분할. N 지정 시 N 개로 균등 분할 (기본 2) |
| `dmctl split-v [N]` | 세로 분할. 동일 |
| `dmctl focus <uuid>` | 특정 탭으로 포커스. **uuid 만 허용** (`list-workspace` 의 `uuid=` 컬럼). 좌표/라벨/toolId 는 400 거부 |
| `dmctl close-tab` | 현재 탭 닫기 |
| `dmctl close-window` | 현재 창 닫기 |
| `dmctl window-next` / `window-prev` | 창 이동 |
| `dmctl tab-next` / `tab-prev` | 탭 이동 |
| `dmctl tool-up` / `tool-down` / `tool-left` / `tool-right` | 방향키식 분할 칸 포커스 이동 (action 은 `paneUp`/`paneDown`/`paneLeft`/`paneRight`) |
| `dmctl rename-tab --at <uuid> <이름>` | 탭 표시 이름 변경 (예: 팀 도구에 역할명). 포커스 무영향. `--name <이름>` 플래그도 동등 |
| `dmctl rename-window --at <uuid> <이름>` | 그 탭이 **속한 창**의 이름 변경. 포커스 무영향 |
| `dmctl list-workspace [--json] [--window <substr>] [--tab <substr>]` | 열린 도구 목록 조회. 표준 KEY=VALUE 라인 (아래 박스). ▶ 표시는 현재 포커스. `--window`/`--tab` 으로 이름 필터 (부분 일치·대소문자 무시, AND, 0건이면 rc=1). `--json` 시 JSON 배열 |
| `dmctl who-am-i [--json]` | 현재 쉘이 속한 탭의 식별 정보. 같은 표준 라인 한 줄. 스크립트에서 `UUID=$(dmctl who-am-i --json \| jq -r .uuid)` 패턴으로 자기 식별 |
| `dmctl send <action> [json]` | 원시 action 전송 (확장용) |

#### 표준 라인 포맷 (list-workspace / who-am-i 공통)

```
{▶|  } label=W1.P1.T1  uuid=<36자>  short=<8자>  toolId=<n>  shellPid=<n>  size=<W>x<H>  window="<이름>"  tab="<이름>"  window_uuid=<36자>  pane_uuid=<36자>
```

- 모든 컬럼 KEY=VALUE, 두 칸 공백 구분. `awk` / `grep` 으로 컬럼 단위 파싱 가능.
- `▶` = 사용자 브라우저 포커스 일치. 비포커스는 두 칸 공백.
- 빈 값(uuid/short/windowUuid/paneUuid 미지정, size=0x0)은 해당 컬럼 통째 생략.
- `window` / `tab` 은 Go `%q` 이스케이프.
- `--json` 의 키는 lowerCamelCase (`toolId`, `shellPid`, `sizeCols`, `sizeRows`, `windowUuid`, `paneUuid`, `focused`).

### 공통 플래그

| 플래그 | 설명 |
|--------|------|
| `--at <uuid>` / `-l <uuid>` | 대상 탭 지정. 미지정 시 현재 포커스. **uuid 만 허용** — `list-workspace` 의 `uuid=` 컬럼 값. 좌표/라벨/toolId 는 거부 |
| `--no-focus` / `-n` | 실행 전후로 사용자 포커스를 옮기지 않음. `split-h/v` 후 새 분할 칸으로 포커스가 튀지 않음. `close-tab` 등에도 동일 적용 |
| `-h` / `--help` | 도움말 |

### 위치 식별자 — uuid 만 허용

`/api/commands` 의 `args.location` 인자는 **`list-workspace` 가 노출하는 `uuid=` 컬럼 값만** 받는다. 좌표(`4.1.1`/`W4.P1.T1`), 라벨, toolId 는 400 거부 — 다른 창 닫힘 시 reflow 되어 다른 탭을 가리키는 사고를 차단하기 위함.

사이드바 라벨 `📍 W1.P2.T1` 은 사람용 표시; 명령에는 같은 행의 `uuid=` 값을 쓴다.

### 예

```bash
dmctl list-workspace                                # 안정 식별자 확인
UUID=$(dmctl list-workspace --json | jq -r '.[0].uuid')
dmctl focus "$UUID"                             # uuid 로 이동
dmctl split-h 3 --at "$UUID"                    # uuid 위치에 가로 3 분할
dmctl new-tab --at "$UUID" -n                   # 포커스 변경 없이 탭 추가
dmctl split-v --no-focus                        # 현재 포커스 유지하며 분할
dmctl send splitH '{"count":2}'                 # raw API 호출
SELF=$(dmctl who-am-i --json | jq -r .uuid)     # 자기 자신 uuid (스크립트 자기 식별)
NEW=$(dmctl split-v --at "$UUID" -n | jq -r '.newTabs[0].uuid')  # 새로 생긴 tab uuid
```

### 생성 명령의 결과 (새 엔터티 uuid 반환)

`splitH`/`splitV`/`newTab`/`newWindow` 은 **생성 명령**이다. 응답에 그 명령으로 새로 생긴 엔터티가 포함된다 (브라우저가 처리 후 echo → 서버가 long-poll 로 상관 → 한 번의 요청-응답):

```json
{ "ok": true, "delivered": 1, "action": "splitV",
  "newWindows": [], "newPanes": ["r110"],
  "newTabs": [ {"uuid": "t139", "toolId": "439"} ],
  "timedOut": false }
```

- `newTabs` 각 원소는 `{uuid, toolId}` — uuid→toolId 재조회 불필요.
- `newWindow` 은 `newWindows`/`newPanes`/`newTabs` 각 1개.
- 구독 브라우저가 없거나(`delivered=0`) 응답이 늦으면 `timedOut: true` + 빈 배열 — 명령 자체는 broadcast 됨. 이 경우 `list-workspace` 로 확인.
- 비생성 명령(`focus`/`close*`/`rename*`/`tool-*` 등)은 이 필드들이 없다 (기존 응답 그대로).

### 허용된 action (서버 화이트리스트)

`newWindow`, `newTab`, `splitH`, `splitV`, `openEditorTab`, `focus`, `closeTab`, `closeWindow`, `windowNext`, `windowPrev`, `tabNext`, `tabPrev`, `paneUp`, `paneDown`, `paneLeft`, `paneRight`, `renameTab`, `renameWindow`, `detachTab`, `restoreTool`.

그 외 action 은 서버가 400 으로 거절. `openEditorTab` 은 `edit`, `detachTab`/`restoreTool` 은 `detach` 가 사용합니다.

## `edit` — 내장 편집기로 파일 열기

```
edit <path>          # 그 경로에 연결된 Editor 창에서 열기
edit -h, --help      # 도움말
```

동작: `POST /api/commands` 로 `openEditorTab` 을 브로드캐스트하고, 브라우저가 그 탭에 Monaco Editor 를 띄운 뒤 `GET /api/file/read` 로 내용을 읽습니다. 저장은 `POST /api/file/write`.

**어느 창에서 열리는가.** 편집기는 일반 창에 열리지 않습니다. 파일 경로를 자기 루트 아래에 포함하는 **Editor 창**(좌측 패널 `Editor` 탭의 행)에서 열리며, 그런 창이 둘 이상이면 루트가 가장 깊은 것이 이깁니다. 하나도 없으면 `~` 의 root 에디터에서 열립니다.

- 상대경로는 절대경로로 변환됩니다. 파일이 없거나 디렉터리면 rc=1.
- 구독 중인 브라우저가 없으면 `delivered=0` — 페이지를 새로고침해야 합니다.

과거에는 `code-server`(원격 VSCode) 프로세스를 띄우고 `/cs/<id>/` 로 프록시했으나 내장 편집기로 대체되며 제거됐습니다. `edit -l` / `edit -s` 도 함께 사라졌습니다.

## `detach` — 도구를 백그라운드로

탭을 닫아도 도구가 계속 돌게 합니다. 이름이 `bg` 가 아닌 이유는 `bg` 가 zsh/bash 의 작업 제어 빌트인이기 때문입니다.

```
detach                   # 현재 탭의 도구를 백그라운드로 (탭은 닫힘)
detach --list, -l        # 백그라운드 도구 목록
detach --restore <id>    # 백그라운드 도구를 현재 분할 칸의 새 탭으로 복귀
detach --restore <id> --at <uuid>   # 지정한 탭이 속한 분할 칸으로 복귀
detach -h, --help        # 도움말
```

`--at` 은 `dmctl list-workspace` 의 uuid 를 받습니다. 복귀는 분할 칸 단위이므로 좌표의 탭 성분은 무시됩니다 — 그 탭이 **속한 분할 칸**이 대상입니다 (`newTab`·`splitH` 와 같은 해석). `--at` 없이 쓰면 브라우저가 현재 포커스한 분할 칸으로 복귀합니다. `dmctl` 은 `-l` 을 `--at` 의 단축으로 쓰지만 `detach` 에서 `-l` 은 `--list` 이므로 그 단축은 제공하지 않습니다. `--at` 은 `--restore` 와 함께만 유효합니다.

동작: `DONGMINAL_TOOL_ID` 로 자기 도구를 식별해 `POST /api/commands` 로 `detachTab` 을 보냅니다. 전환과 탭 닫기를 **하나의 명령**으로 처리하는 이유는, 두 단계로 나누면 그 사이에 탭이 닫혀 도구가 종료될 수 있기 때문입니다. `--list` 는 `GET /api/tools/background` 를 직접 조회합니다.

- `DONGMINAL_TOOL_ID` 가 없으면(dongminal 터미널 밖) rc=1.
- 터미널 도구만 대상입니다. 편집기 탭은 `backgroundCapable=false` 라 브라우저가 무시합니다 (Editor 창에만 존재합니다).
- **데몬을 재시작하면 백그라운드 도구는 복원되지 않습니다** — 복원해도 돌던 작업이 아니라 같은 cwd 의 빈 셸이 되살아날 뿐입니다.

상태 바의 `⏻ <개수>` 배지를 클릭해도 같은 목록·복귀 경로를 쓸 수 있습니다.

## `download` — 파일을 브라우저로 내려받기

```bash
download <path>
```

OSC 777 `Download;<abs-path>` 시퀀스를 출력해 브라우저가 `/api/download?path=<abs>` 로 실제 다운로드를 트리거합니다. 상대경로는 `realpath` 로 절대경로 변환. 파일이 없으면 서버 측에서 404.

반대 방향(업로드)은 터미널에 파일을 드래그앤드롭 → 해당 도구의 `cwd` 에 저장 (중복 시 `(1)`, `(2)` 자동 넘버링). 업로드가 끝나도 **셸에 엔터를 보내지 않는다** — 그 순간 도는 것이 셸이 아니면 그 프로그램이 엔터를 받는다.

폴더째 주고받으려면 Editor 탭의 탐색기를 쓴다 — 우클릭 다운로드가 폴더면 zip 으로
오고, 폴더를 끌어다 놓으면 하위 구조가 그대로 올라간다
([features.md](./features.md#파일-편집기)).

## cwd 훅

`zdotdir/.zshrc` 와 `bash-hook.sh` 는 `PROMPT_COMMAND` / `precmd` / `chpwd` 훅으로 OSC 777 `Cwd;<path>` 를 매 프롬프트마다 발신합니다. 프론트엔드가 수신해서 상태 바의 "현재 디렉터리" 와 파일 드래그앤드롭 업로드 타깃 디렉터리에 사용. 이 훅은 기존 `~/.zshrc` / `~/.bashrc` 를 먼저 `source` 한 뒤 추가되므로 사용자 설정과 충돌하지 않습니다.
