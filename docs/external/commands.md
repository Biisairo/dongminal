# Pane 내부 CLI (`dmctl`, `edit`, `download`)

Dongminal 서버는 기동 시 `$DONGMINAL_HOME/bin/` 에 헬퍼 스크립트를 풀어내고, 각 pane 의 shell 은 이 디렉터리를 `PATH` 에 자동 주입받습니다. 즉 터미널에서 바로 아래 명령을 쓸 수 있습니다.

공통 환경 변수 (서버가 자동 주입):

- `DONGMINAL_PORT` — 서버 포트 (기본 58146 또는 `PORT` 값)
- `DONGMINAL_HOST` — 기본 `127.0.0.1`

## `dmctl` — 워크스페이스 원격 제어

실행 중인 브라우저(들)에게 `/api/commands` 로 명령을 브로드캐스트합니다. SSE (`/api/commands/sse`) 로 구독 중인 모든 탭이 동일한 동작을 수행합니다.

### 서브커맨드

| 명령 | 설명 |
|------|------|
| `dmctl new-session` | 새 세션 생성 |
| `dmctl new-tab` | 현재 pane 에 새 탭 |
| `dmctl split-h [N]` | 가로 분할. N 지정 시 N 개로 균등 분할 (기본 2) |
| `dmctl split-v [N]` | 세로 분할. 동일 |
| `dmctl focus <loc>` | 특정 위치에 포커스. `4.1.1` 또는 `S4.P1.T1` 형식 |
| `dmctl close-tab` | 현재 탭 닫기 |
| `dmctl close-session` | 현재 세션 닫기 |
| `dmctl session-next` / `session-prev` | 세션 이동 |
| `dmctl tab-next` / `tab-prev` | 탭 이동 |
| `dmctl pane-up` / `pane-down` / `pane-left` / `pane-right` | 방향키식 pane 포커스 이동 |
| `dmctl send <action> [json]` | 원시 action 전송 (확장용) |

### 공통 플래그

| 플래그 | 설명 |
|--------|------|
| `--at <loc>` / `-l <loc>` | 대상 위치 지정. 미지정 시 현재 포커스. 형식은 `focus` 와 동일 (`4.1.1` 또는 `S4.P1.T1`) |
| `--no-focus` / `-n` | 실행 전후로 사용자 포커스를 옮기지 않음. `split-h/v` 후 새 영역으로 포커스가 튀지 않음. `close-tab` 등에도 동일 적용 |
| `-h` / `--help` | 도움말 |

### 위치 포맷

`S<세션>.P<Pane>.T<탭>` (1-base). 점 표기 `4.1.1` 도 허용. 사이드바 하단의 `📍 S1.P2.T1` 라벨과 동일 체계.

### 예

```bash
dmctl split-h 3                      # 가로 3 분할
dmctl split-v --no-focus             # 세로 분할하되 포커스 유지
dmctl focus 1.2.1                    # S1.P2.T1 로 이동
dmctl new-tab --at 2.1.1 -n          # S2.P1 에 탭만 추가, 포커스 변경 없음
dmctl send splitH '{"count":2}'      # raw API 호출
```

### 허용된 action (서버 화이트리스트)

`newSession`, `newTab`, `splitH`, `splitV`, `focus`, `closeTab`, `closeSession`, `sessionNext`, `sessionPrev`, `tabNext`, `tabPrev`, `paneUp`, `paneDown`, `paneLeft`, `paneRight`.

그 외 action 은 서버가 400 으로 거절.

## `edit` — code-server 런처 (원격 VSCode)

pane 에서 경로를 열면 서버가 `code-server` 프로세스를 Unix 소켓 모드로 띄우고, 브라우저가 `/cs/<id>/` 리버스 프록시를 새 창으로 오픈합니다.

```
edit <path>              # 해당 경로로 새 code-server 인스턴스 열기
edit -l, --list          # 현재 열린 인스턴스 목록
edit -s, --stop <id|all> # 인스턴스 종료 (id 또는 all)
edit -h, --help, ?       # 도움말
```

`<path>` 가 파일이면 상위 디렉터리가 `folder` 로 열리고 해당 파일이 자동으로 에디터에 로드됩니다. 상대 경로는 절대 경로로 변환.

동작:

1. `POST /api/code-server?path=<abs>` → 서버가 `code-server` 를 스폰, id/folder/path 반환.
2. OSC 777 `OpenCodeServer;<id>|<path>|<folder>` 가 터미널을 통해 프론트엔드로 전달.
3. 브라우저가 `window.open('/cs/<id>/...')` 로 새 창을 열고 10s 주기 하트비트, 1s 주기 창 존재 확인.
4. 창이 닫히면 자동으로 `/api/code-server/stop?id=<id>` 호출. 팝업 차단 시 터미널의 URL 링크 클릭으로 폴백.

요구: 서버 호스트에 `code-server` 가 `PATH` 상에 설치되어 있어야 합니다. 없으면 `edit` 는 서버에서 500 응답을 받고 실패 메시지를 출력합니다.

## `download` — 파일을 브라우저로 내려받기

```bash
download <path>
```

OSC 777 `Download;<abs-path>` 시퀀스를 출력해 브라우저가 `/api/download?path=<abs>` 로 실제 다운로드를 트리거합니다. 상대경로는 `realpath` 로 절대경로 변환. 파일이 없으면 서버 측에서 404.

반대 방향(업로드)은 터미널에 파일을 드래그앤드롭 → 해당 pane 의 `cwd` 에 저장 (중복 시 `(1)`, `(2)` 자동 넘버링).

## cwd 훅

`zdotdir/.zshrc` 와 `bash-hook.sh` 는 `PROMPT_COMMAND` / `precmd` / `chpwd` 훅으로 OSC 777 `Cwd;<path>` 를 매 프롬프트마다 발신합니다. 프론트엔드가 수신해서 상태 바의 "현재 디렉터리" 와 파일 드래그앤드롭 업로드 타깃 디렉터리에 사용. 이 훅은 기존 `~/.zshrc` / `~/.bashrc` 를 먼저 `source` 한 뒤 추가되므로 사용자 설정과 충돌하지 않습니다.
