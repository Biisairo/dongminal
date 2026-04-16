# Remote Terminal — TODO

## 기능 구현 목록

### 1. 터미널 검색 (Terminal Search) ✅
- [x] xterm.js `@xterm/addon-search` 연동
- [x] Ctrl+F / Cmd+F → 검색 바 UI 표시
- [x] 이전/다음 매치 이동 (Enter/Shift+Enter)
- [x] 대소문자 구분 토글
- [x] ESC / ✕ 버튼으로 검색 바 종료
- [x] 검색 시 터미널 크기 자동 조정

### 2. 파일 업로드 / 다운로드 ✅
- [x] **업로드**: 브라우저 → 서버
  - 드래그앤드롭으로 터미널에 파일 드롭
  - POST `/api/upload` 로 파일 전송
  - 터미널의 현재 작업 디렉토리에 저장
  - 업로드 결과 터미널에 표시
- [x] **다운로드**: 서버 → 브라우저
  - 터미널에서 `download <path>` 명령어
  - GET `/api/download?path=<path>` 엔드포인트
  - 브라우저 다운로드로 파일 저장

### 3. 자동 재연결 (Auto Reconnect) ✅
- [x] WebSocket 연결 끊기 감지 (onclose / onerror)
- [x] 지수 백오프로 재연결 시도 (1s → 1.5s → 2.25s → ... → max 30s)
- [x] 재연결 중 오버레이 표시 ("연결 끊김 / 재연결 중...")
- [x] 재연결 성공 시 PTY 버퍼 리플레이 → 터미널 복원
- [x] 네트워크 복구 후 자동으로 이어서 작업 가능

### 4. 상태 표시줄 (Status Bar) ✅
- [x] 하단 상태 바 UI
- [x] 연결 상태 (🟢/🔴 + 연결됨/끊김)
- [x] 레이턴시 (ping ms)
- [x] 현재 디렉토리
- [x] 메모리 사용량
- [x] CPU 사용률
- [x] 호스트명
- [x] 디스크 사용률
- [x] 세션/탭 정보
- [x] 터미널 크기
- [x] 업타임
- [x] 설정 → Status Bar 탭에서 항목 토글
- [x] 기본값: 연결상태, 레이턴시, 현재디렉토리, 메모리
- [x] settings.json에 저장

### 5. 링크 열기 (Link Handling) ✅
- [x] xterm.js `@xterm/addon-web-links` 연동 (이미 CDN에 있음)
- [x] URL 클릭 시 새 브라우저 탭에서 열기

### 6. 레이아웃 프리셋 (Layout Presets) ✅
- [x] 현재 레이아웃(분할 + 탭 수)을 프리셋으로 저장
- [x] 프리셋 목록 UI (설정 → Presets 탭)
- [x] 프리셋 로드 → 새 세션에 해당 레이아웃 적용
- [x] 프리셋 삭제
- [x] 더블클릭으로 프리셋 이름 변경
- [x] settings.json에 프리셋 데이터 저장
