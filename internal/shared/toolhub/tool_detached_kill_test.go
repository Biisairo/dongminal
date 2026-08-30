package toolhub

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// NewDetachedTool 로 만든 Tool 은 PTY 도 프로세스도 없고 done 채널도 없다.
// kill() 이 close(p.done) 을 무조건 부르면 close(nil chan) 으로 패닉한다.
//
// 이 경로는 데몬 모드가 원격 도구를 대리할 때와 테스트가 밟는다. WS-8 이
// 백그라운드 종료를 만들며 재현했고, 같은 경로를 DELETE /api/tools/{id} 도 쓴다.
// 고친 것은 한 줄이지만 되돌아오기 쉬운 종류라 동작으로 고정한다.
func TestDetachedTool_KillDoesNotPanic(t *testing.T) {
	p := NewDetachedTool("synthetic", nil)
	if p.done != nil {
		t.Fatal("전제가 깨졌다: NewDetachedTool 이 done 을 만들고 있다")
	}
	// 패닉하면 테스트가 실패한다.
	p.kill()
	// 두 번 불러도 안전해야 한다 (once.Do).
	p.kill()
}

// Delete 는 kill 을 지난다. 매니저 경로에서도 같은 것을 고정한다.
func TestToolManager_DeleteDetachedToolDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	m := NewToolManager(dir, func(string) {})
	t.Cleanup(m.StopSaving)
	p := NewDetachedTool("synthetic-2", nil)
	m.Adopt(p)
	if !m.IsLive("synthetic-2") {
		t.Fatal("Adopt 후 도구가 살아 있어야 한다")
	}
	m.Delete("synthetic-2")
	if m.IsLive("synthetic-2") {
		t.Fatal("Delete 후 도구가 남아 있다")
	}

	// Delete 는 `go m.SaveAll()` 로 **비동기** 쓰기를 띄운다. 그 고루틴이
	// t.TempDir() 정리보다 늦게 끝나면 정리가 "directory not empty" 로 실패하고,
	// 테스트가 제품 결함처럼 보이는 플레이크로 깨진다 (실측: 전량 실행 3회 중 1회).
	//
	// SaveAll 은 dirty 를 내리지 않아 상태로는 완료를 알 수 없다. 그러나 쓰기의
	// 결과물이 곧 완료 신호이므로 파일의 등장으로 동기화한다.
	waitFile(t, filepath.Join(dir, "tools.json"))
}

// waitFile 은 경로가 나타날 때까지 기다린다. 비동기 쓰기를 띄우는 API 를 부른
// 테스트가 TempDir 정리와 경합하지 않게 하는 용도다.
func waitFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	// 실패로 만들지 않는다 — 이 대기는 테스트의 관심사가 아니라 정리를 위한
	// 것이고, 파일이 끝내 안 생겨도 검증 대상(패닉 없음)은 이미 통과했다.
	t.Logf("waitFile: %s 가 3초 안에 나타나지 않았다 (정리 경합 가능)", path)
}
