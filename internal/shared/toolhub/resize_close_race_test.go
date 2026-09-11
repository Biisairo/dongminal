package toolhub

import (
	"sync"
	"testing"
)

// 크기 변경과 종료가 같은 fd 를 두고 겹친다.
//
// `Resize` 는 `pty.Setsize` → `os.File.Fd()` 를 지난다. `Fd()` 는 `os.File` 의
// **참조 계수를 우회해** 원시 fd 를 읽으므로, 그 사이에 `Close` 가 들어오면
// 닫힌 fd 에 ioctl 을 건다. `Read`·`Write` 와 달리 이 경로만 보호가 없다.
//
// 이 검사는 `TERMINAL_RESUME_SRS` 작업 중에 드러났다. `TestHandleWS_OpResize` 가
// 응답을 500ms 기다리다 타임아웃하는 동안 크기 변경이 끝나 있었고, 서버가
// 좌표 프레임(`OpSeq`)을 하나 더 보내면서 그 대기가 사라지자 매번 났다.
// **대기가 덮고 있었을 뿐 결함은 그 전에도 있었다.**
func TestResizeDuringDelete_NoRace(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	p, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			// 오류는 정상이다 — 도구가 사라진 뒤의 요청이 거절되는 것이 규약이다.
			_ = p.resize(uint16(80+i%10), 24)
		}
	}()

	_ = m.Delete(p.ID)
	close(stop)
	wg.Wait()
}
