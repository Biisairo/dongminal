# Remote Terminal

웹 브라우저에서 서버 터미널에 접속하는 서비스.


## 실행

```bash
# 기본 (포트 8080)
go run .

# 포트 변경
PORT=9090 go run .

# 빌드
go build -o remote-terminal .
./remote-terminal
```

## 아키텍처

```
Browser (xterm.js) ←── Binary WebSocket ──→ Go Server (PTY) ──→ Shell
                           ↑

```

### 로컬 터미널과 동일한 경험을 위한 설계

| 항목 | 구현 |
|------|------|
| 셸 환경 | 로그인 쉘(`-l`), `TERM=xterm-256color`, `COLORTERM=truecolor` |
| 터미널 렌더링 | xterm.js v5 (256컬러, 트루컬러, 스크롤백 50000줄) |
| 마우스 | xterm.js 마우스 이벤트 → TUI 프로그램(vim, htop 등) 동작 |
| IME (한글 등) | xterm.js composition event 지원 |
| 스크롤 | 50000줄 스크롤백 + 빠른 스크롤(Alt+스크롤) |
| 리사이즈 | Viewport 자동 감지 → PTY 크기 동기화 |
| 붙여넣기 | 브라켓 페이스트 모드 지원 |
| 단축키 | 모든 터미널 단축키(Ctrl+C/Z/D, 방향키 등) 전달 |
| 재연결 | 연결 끊김 시 자동 재시도 (최대 30초 간격) |

### 바이너리 프로토콜

Client → Server:
- `[0x00] + data` → 터미널 입력 (UTF-8)
- `[0x01] + cols(u16 BE) + rows(u16 BE)` → 리사이즈

Server → Client:
- `[0x00] + data` → 터미널 출력 (raw bytes)
- `[0x01] + message` → 에러 메시지
- `[0x02]` → 프로세스 종료

## 향후 계획

- [ ] 다중 터미널 (pane 분할)
- [ ] 탭 관리
- [ ] 터미널 설정 UI (폰트, 테마)
- [ ] 세션 공유
