# Remote Terminal

Browser → WebSocket → PTY. 단일 터미널.

## 실행

```bash
./start.sh    # 빌드 + 실행 (port 58146)
./stop.sh     # 중지
```

## 아키텍처

```
Browser (xterm.js) ← Binary WebSocket → Go Server (PTY) → Shell
```



`terminal.example.com` → `localhost:58146`
