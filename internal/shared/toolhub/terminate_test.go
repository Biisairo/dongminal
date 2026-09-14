package toolhub

import (
	"testing"
	"time"
)

// FR-BGK-7 의 유예 반쪽 — 정중한 종료와 강제 종료 사이 (M8 FBE-05/12 로 httpapi
// 에서 이 패키지로 내려왔다: 유예는 도구가 있는 프로세스에서 기다린다).

// SIGTERM 을 받고 바로 죽는 프로세스는 유예를 다 쓰지 않는다 — 유예는 상한이지
// 대기 시간이 아니다.
func TestTerminateWait_ReturnsEarlyOnExit(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	tl, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer m.Delete(tl.ID)

	go func() {
		// ④ 자극 — 종료가 **대기 중에** 들어오게 하는 지연이다.
		time.Sleep(50 * time.Millisecond)
		m.Delete(tl.ID) // 도구가 스스로 끝난 것과 같은 자리 — done 이 닫힌다
	}()
	start := time.Now()
	tl.terminateWait(5 * time.Second)
	if elapsed := time.Since(start); elapsed >= 5*time.Second {
		t.Errorf("소요=%v — 종료를 감지하지 못하고 유예를 다 썼다", elapsed)
	}
}

// 프로세스 없는 합성 Tool 에서는 할 일이 없고, 무엇보다 매달리지 않는다
// (done 채널이 nil 이다).
func TestTerminateWait_NoProcessIsNoop(t *testing.T) {
	start := time.Now()
	NewDetachedTool("d1", nil).terminateWait(time.Hour)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("소요=%v — pid 없는 도구에서 매달렸다", elapsed)
	}
}

// Terminate 는 없는 도구에 ErrToolNotFound 다 — IPC 경계가 그것을 실패로 옮긴다.
func TestToolManager_TerminateUnknownIsNotFound(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	if err := m.Terminate("nope", time.Second); err != ErrToolNotFound {
		t.Fatalf("err=%v want ErrToolNotFound", err)
	}
}
