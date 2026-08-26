package hub

import (
	"sync"
	"testing"
	"time"
)

// TC-L5-1: CommandHub concurrent add/remove/Broadcast must be race-clean.
func TestCommandHub_AddRemoveBroadcastRace(t *testing.T) {
	h := NewCommandHub()
	const subscribers = 16
	var wg sync.WaitGroup
	stop := make(chan struct{})

	for i := 0; i < subscribers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				s := h.Add()
				select {
				case <-s.ch:
				default:
				}
				h.Remove(s)
			}
		}()
	}

	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			payload := []byte("event")
			for {
				select {
				case <-stop:
					return
				default:
				}
				h.Broadcast(payload)
			}
		}()
	}

	time.Sleep(200 * time.Millisecond)
	close(stop)
	wg.Wait()
}
