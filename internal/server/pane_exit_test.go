package server

import (
	"testing"
	"time"
)

func TestPaneOnExitAndWait(t *testing.T) {
	called := make(chan string, 1)
	p, err := StartPane("t1", "test", "", 80, 24, func(id string) {
		called <- id
	})
	if err != nil {
		t.Fatalf("StartPane: %v", err)
	}

	if _, err := p.PTMX().Write([]byte("exit\n")); err != nil {
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
