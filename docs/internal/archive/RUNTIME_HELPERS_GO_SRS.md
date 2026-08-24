# Runtime Helpers — Go Rewrite SRS

> Conforms to IEEE 29148. Single source of truth for replacing the embedded
> shell helpers (`dmctl`, `edit`, `download`, `mdview`) with Go code shipped
> as the same `dongminal` binary (multi-call / busybox style).

## 1. Introduction

### 1.1 Purpose
`internal/runtime/scripts/` 의 헬퍼 CLI 들을 POSIX shell 에서 Go 로 재작성하여
- `sh`, `curl`, `sed`, `python3` 등 외부 의존성 제거
- 단일 `dongminal` 바이너리 일관성 확보
- JSON/HTTP/OSC 처리 정확성 향상 (이스케이프 누락, sed 파싱 한계 제거)

### 1.2 Scope
재작성 대상: `dmctl`, `edit`, `download`, `mdview`.
**범위 외**: `bash-hook.sh`, `zdotdir/.zshrc` — shell 의 `PROMPT_COMMAND` /
`precmd` hook 메커니즘은 shell 문법이 필수이므로 임베드된 shell 파일로 유지.

### 1.3 Definitions
- **Multi-call binary**: 동일 실행 파일이 `os.Args[0]` basename 으로 다른 동작을
  수행하는 형태 (busybox, git 등).
- **OSC**: ANSI Operating System Command. 프론트엔드와 통신용 escape sequence
  `ESC ] 777 ; <kind> ; <payload> BEL`.

## 2. Overall Description

### 2.1 Product Perspective
`dongminal` 서버 바이너리 자체가 헬퍼 CLI 도 겸한다. 부팅 시 `Install()` 가
`$DONGMINAL_HOME/bin/{dmctl,edit,download,mdview}` 를 자기 자신을 가리키는
symlink 로 생성한다. shell hook (`bash-hook.sh`, `zdotdir/.zshrc`) 만 파일로
풀어둔다.

### 2.2 Product Functions
- F-1 `dispatch`: `os.Args[0]` basename 이 helper 이름과 일치하면 helper 모드로
  실행하고 종료.
- F-2 `dmctl`: 기존 shell `dmctl` 의 모든 sub-command/flag 동등.
- F-3 `edit`: 기존 shell `edit` 의 list/stop/open 동등.
- F-4 `download`: 입력 경로의 절대경로 해석 후 OSC `Download` 출력.
- F-5 `mdview`: `openMdTab` 액션 POST.
- F-6 `Install`: helper symlink 생성 + shell hook 파일 쓰기.

### 2.3 Constraints
- Go 표준 라이브러리만 사용 (`net/http`, `encoding/json`, `os` 등). 새 의존성
  금지.
- 기존 shell 인터페이스(서브명령, flag, 환경변수, exit code, OSC payload
  포맷)와 100% 동등. 사용자 가시 동작 변경 금지.
- Symlink 가 실패하는 환경(예: 일부 Windows) 에서는 바이너리 복사로 fallback.

## 3. Specific Requirements

### 3.1 Functional Requirements

#### REQ-1 dispatch
- 입력: `os.Args[0]`.
- 처리: `filepath.Base()` 결과가 {`dmctl`, `edit`, `download`, `mdview`}
  중 하나면 해당 helper `Run([]string)` 호출 후 그 exit code 로 `os.Exit`.
- 그 외(=`dongminal`, 또는 `dongminal-*` 포함 임의의 다른 이름)는 서버 main
  로직 진입.

#### 공통 환경변수
모든 helper 는 `DONGMINAL_HOST` (기본 `127.0.0.1`), `DONGMINAL_PORT` (기본
`58146`) 를 우선 읽는다. 정상 경로에서는 server 가 자식 프로세스에 항상 두
변수를 주입하므로 fallback 은 단지 안전망이다. 기존 shell 의 dmctl=58146,
edit/mdview=8080 분기는 제거하고 **단일 기본값 58146** 으로 통일한다.

#### REQ-2 dmctl
서브커맨드: `new-session`, `new-tab`, `split-h [N]`, `split-v [N]`,
`focus <loc>`, `close-tab`, `close-session`, `session-next/prev`,
`tab-next/prev`, `pane-up/down/left/right`, `send <action> [json-args]`,
`-h|--help|help`.
공통 플래그: `--at|-l <loc>` (`=` form 포함), `--no-focus|-n`, `--`.
- POST `${BASE}/api/commands` body: `{"action":"<action>","args":<json>}`.
- `args` 객체에 `location`, `count`, `keepFocus` 가 옵션으로 들어감.
- `split-h/split-v` 의 `count` 는 ≥2 양의 정수, 아니면 exit 2.
- `focus` 는 location 없으면 exit 2.
- `send` 는 raw, 두 번째 인자가 JSON. 비어있으면 `{}`.
- 모든 응답은 stdout 에 그대로 출력 후 개행.

#### REQ-3 edit
서브커맨드: 인자 없음/`-h`/`--help`/`?` → help, `-l|--list`, `-s|--stop <id|all>`,
그 외 path → open.
- list: `GET ${BASE}/api/code-server` → OSC `CodeServerList;<resp_body>`.
- stop: `POST ${BASE}/api/code-server/stop?id=<id>` (`all` 이면 list 응답에서
  모든 id 추출 후 각각 stop).
- open: 경로 존재 확인 → 절대경로 → query encode → `POST ${BASE}/api/code-server?path=<enc>`
  → 응답 JSON 에서 `id`,`path`,`folder` 추출 → OSC `OpenCodeServer;<id>|<path>|<folder>`
  + 사용자 메시지 출력.

#### REQ-4 download
- 인자 1개 path. `filepath.Abs` 가능하면 절대경로로, 실패시 입력 그대로.
- OSC `Download;<path>` 출력. 인자 없으면 빈 path 그대로 (현재 shell 동작 보존).

#### REQ-5 mdview
- `-h|--help` 또는 인자 없음 → help, exit 0.
- 파일 존재 확인 후 절대경로 해석 → `openMdTab` 액션 POST,
  args `{"name":"<basename>","filePath":"<abs>"}` (JSON encoder 가
  안전하게 escape).
- 응답 stdout 출력. 연결 실패시 exit 1.

#### REQ-6 Install
- `$DONGMINAL_HOME/bin/` 디렉터리 생성.
- shell hook 파일 두 개를 임베드된 내용으로 write:
  - `bash-hook.sh` (mode 0755), `zdotdir/.zshrc` (mode 0644).
- helper 4개 (`dmctl`, `edit`, `download`, `mdview`) 에 대해:
  1. `os.Executable()` 의 절대경로 확인.
  2. 기존 entry 가 있으면 `os.Remove`.
  3. `os.Symlink(self, dst)` 시도. 실패 시 바이너리 복사 (mode 0755) 로
     fallback.

### 3.2 Non-Functional Requirements
- NFR-1: helper 모드 진입은 `<10ms` 부가 지연 (서버 import 그래프가 무거우므로
  cold-start 비용이 일부 있음 — 기능 요구는 아님).
- NFR-2: 모든 helper 가 `-h`/`--help` 시 stdout, exit 0.
- NFR-3: HTTP 실패 시 stderr 에 `<cmd>: <에러>` 메시지, non-zero exit.

### 3.3 Verification (Test Plan)
- T-1 `dispatch_test.go`: `Dispatch("dmctl", ...)`, `"edit"`, `"download"`,
  `"mdview"`, `"dongminal"`, `"unknown"` 분기. mocked HTTP 서버.
- T-2 `dmctl_test.go`: build_args (location/count/keepFocus 조합), split count
  validation, focus 인자 검증, send raw, 알 수 없는 flag.
- T-3 `edit_test.go`: list/stop/open path, all stop, missing path exit 1.
- T-4 `download_test.go`: 절대경로 변환, OSC payload.
- T-5 `mdview_test.go`: missing file, JSON 이스케이프 (따옴표·역슬래시 포함
  파일명).
- T-6 `install_test.go`: symlink 가 self 를 가리키는지, 권한, fallback 시
  파일 존재.

## 4. Backward Compatibility & Migration
- 기존 사용자의 `$DONGMINAL_HOME/bin/` 에 남아있는 shell `dmctl` 등은 다음
  서버 부팅 시 `Install()` 가 덮어쓴다 (Remove → Symlink).
- 외부 인터페이스(서브명령, OSC payload, HTTP body) 변경 없음 — 프론트엔드
  / 사용자 스크립트 호환.

## 5. Open Items
없음.
