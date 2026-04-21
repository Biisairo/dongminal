package main

import (
	"testing"
	"time"
)

// startPane에 주입한 onExit 콜백이 셸 종료 시 호출되고,
// Wait() 채널이 닫히는지 검증한다.
func TestPaneOnExitAndWait(t *testing.T) {
	called := make(chan string, 1)
	p, err := startPane("t1", "test", "", 80, 24, func(id string) {
		called <- id
	})
	if err != nil {
		t.Fatalf("startPane: %v", err)
	}

	// 셸에 exit 명령을 주입한다.
	if _, err := p.ptmx.Write([]byte("exit\n")); err != nil {
		t.Fatalf("write exit: %v", err)
	}

	select {
	case <-p.Wait():
	case <-time.After(5 * time.Second):
		t.Fatal("Wait() channel did not close within 5s")
	}

	select {
	case id := <-called:
		if id != "t1" {
			t.Fatalf("onExit id=%q want t1", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("onExit callback not invoked within 5s")
	}
}
