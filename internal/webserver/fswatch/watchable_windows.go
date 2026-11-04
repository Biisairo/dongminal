package fswatch

// watchable 은 Windows 에서 늘 거짓이다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-55, D-8).
//
// ReadDirectoryChangesW 는 디렉터리마다 핸들을 열고, 그 핸들이 열린 동안 그 디렉터리와 조상의
// 이름 변경·이동이 ERROR_ACCESS_DENIED 로 막힌다 — 우리 앱도, git 도, 다른 편집기도. 감시하지
// 않은 디렉터리는 폴링이 맡는다.
func watchable(string) bool { return false }
