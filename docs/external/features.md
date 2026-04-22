# 기능

## 세션 & 레이아웃

| 기능 | 설명 |
|------|------|
| 세션 관리 | 사이드바에서 세션 생성/삭제/전환, 더블클릭으로 이름 변경 |
| 탭 관리 | 각 Pane 마다 독립 탭 바, 탭 추가/삭제/전환 |
| 분할 Pane | 가로/세로 분할, 드래그로 크기 조절, 비율 유지 |
| 레이아웃 프리셋 | 현재 분할 구조를 저장 → 설정에서 관리, 기본 프리셋 지정 → 사이드바 ★ 버튼으로 원클릭 생성 |

분할·삭제 시 낙관적 UI 적용: 키 입력 → 레이아웃 즉시 반영 → 서버 상태 동기화는 백그라운드. 로컬호스트에서 체감 지연이 거의 없습니다.

## 터미널

| 기능 | 설명 |
|------|------|
| 한국어 IME | xterm.js Unicode11 addon, 로케일 설정 |
| TUI 프로그램 | vim, htop, tmux 등 완벽 동작 |
| 터미널 검색 | `Ctrl+F` / `Cmd+F` → 검색 바, Enter/Shift+Enter 이동, 대소문자 구분 토글 |
| 링크 열기 | URL 자동 감지, 클릭 시 새 탭에서 열기 |
| 파일 업로드 | 터미널에 파일 드래그앤드롭 → 현재 작업 디렉터리에 저장, 중복 시 `(1)`, `(2)` 자동 넘버링 |
| 파일 다운로드 | `download <path>` 명령 → 브라우저 다운로드 |
| 자동 재연결 | 연결 끊김 시 지수 백오프(1s→30s), 오버레이 표시, 복원 시 버퍼 리플레이 |

## 상태 표시줄

하단 상태 바에서 실시간 정보 표시. 설정에서 항목 토글·갱신 주기 변경 가능.

| 항목 | 설명 | 기본 |
|------|------|------|
| 연결 상태 | 🟢/🔴 + 연결됨/끊김 | ✅ |
| 레이턴시 | `/api/ping` RTT (ms) | ✅ |
| 현재 디렉터리 | 셸 훅으로 실시간 감지 | ✅ |
| 메모리 | 사용량/전체 | ✅ |
| CPU | 서버 CPU 사용률 | ❌ |
| 호스트명 | 서버 이름 | ❌ |
| 디스크 | 루트 볼륨 사용률 | ❌ |
| 터미널 크기 | cols × rows | ❌ |
| 업타임 | 시스템 + 서버 프로그램 | ❌ |

## 테마

21 개 프리셋 + 커스텀 테마 편집기.

Tokyo Night, Dracula, One Dark, Nord, Catppuccin, Solarized Dark, Monokai, GitHub Dark, Material Ocean, Material Palenight, Ayu Dark, Gruvbox Dark, Rosé Pine, Night Owl, Cobalt², Shades of Purple, Horizon, Doom One, Everforest, Kanagawa, Synthwave '84.

커스텀 테마: UI 10색 + 터미널 20색을 컬러 피커로 개별 조정. 모든 UI 요소(사이드바, 탭, 검색 바, 상태 표시줄)에 CSS 변수 기반 일괄 적용.

## 파일 영속성

`DONGMINAL_HOME` (기본 `~/.dongminal`) 아래에 저장:

| 파일 | 설명 | 재시작 시 |
|------|------|-----------|
| `settings.json` | 테마·단축키·프리셋·상태 바 | 유지 |
| `workspace.json` | 세션/탭/분할 구조 | 유지 (비동기 쓰기, 지연 손실 리스크 낮음) |
| `panes/<id>.json` | 각 pane 의 cwd 스냅샷 | 유지 |

PTY 프로세스 자체는 서버 메모리에만 존재 → 서버 재시작 시 초기화. 브라우저 새로고침은 서버 버퍼로부터 복원.

## 부가 CLI (자동 배포)

서버 시작 시 `./bin/` 아래 자동 생성:

| 파일 | 용도 |
|------|------|
| `bin/download` | `download <path>` → OSC 777 로 브라우저 다운로드 트리거 |
| `bin/edit` | `edit <path>` → code-server 인스턴스 열기 |
| `bin/zdotdir/.zshrc` | zsh cwd 훅 (상태 바의 현재 디렉터리용) |
| `bin/bash-hook.sh` | bash cwd 훅 |

`PATH` 에 `./bin` 을 추가하거나 zsh 을 `ZDOTDIR=./bin/zdotdir` 로 띄우면 됩니다. `start.sh` 는 자동으로 설정.
