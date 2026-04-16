# Remote Terminal — TODO

## 기능 구현 목록

### 1. 터미널 검색 (Terminal Search) ✅
- [x] xterm.js `@xterm/addon-search` 연동
- [x] Ctrl+F / Cmd+F → 검색 바 UI 표시
- [x] 이전/다음 매치 이동 (Enter/Shift+Enter)
- [x] 대소문자 구분 토글
- [x] ESC / ✕ 버튼으로 검색 바 종료
- [x] 검색 시 터미널 크기 자동 조정

### 2. 파일 업로드 / 다운로드
- [ ] **업로드**: 브라우저 → 서버
  - 드래그앤드롭 또는 파일 선택 버튼
  - 서버에 POST `/api/upload` 로 파일 전송
  - 현재 작업 디렉토리에 저장
  - 업로드 진행률 표시
- [ ] **다운로드**: 서버 → 브라우저
  - 터미널에서 특수 명령어 `download <path>` 지원
  - 또는 파일 경로 우클릭 → 다운로드
  - GET `/api/download?path=<path>` 엔드포인트
  - 다운로드 진행률 표시

### 3. 자동 재연결 (Auto Reconnect)
- [ ] WebSocket 연결 끊기 감지 (onclose / onerror)
- [ ] 지수 백오프로 재연결 시도 (1s → 2s → 4s → ... → max 30s)
- [ ] 재연결 중 "연결 끊김" 오버레이 표시
- [ ] 재연결 성공 시 PTY 버퍼 리플레이 → 터미널 복원
- [ ] 네트워크 복구 후 자동으로 이어서 작업 가능

### 4. 상태 표시줄 (Status Bar)
- [ ] 하단 고정 상태 바 UI
- [ ] 서버 정보: 호스트명, OS
- [ ] 시스템: CPU 사용률, 메모리 사용률
- [ ] 연결 상태: latency (ping/pong)
- [ ] 현재 세션/탭 정보
- [ ] GET `/api/stats` 엔드포인트 (Go에서 시스템 정보 수집)

### 5. 링크 열기 (Link Handling)
- [ ] xterm.js `@xterm/addon-web-links` 연동 (이미 CDN에 있음)
- [ ] URL 클릭 시 새 브라우저 탭에서 열기
- [ ] 파일 경로 감지 (선택사항)

### 6. 레이아웃 프리셋 (Layout Presets)
- [ ] 현재 레이아웃(분할 + 탭 수)을 프리셋으로 저장
- [ ] 프리셋 목록 UI (설정 또는 사이드바)
- [ ] 프리셋 로드 → 새 세션에 해당 레이아웃 적용
- [ ] 프리셋 삭제 / 이름 변경
- [ ] settings.json에 프리셋 데이터 저장
