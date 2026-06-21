package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// echoWSHandler upgrades to WS and reads/discards messages so client-side
// writes don't block. Used to obtain real *websocket.Conn for invariant tests
// without the full pane handler stack.
func echoWSHandler() http.HandlerFunc {
	up := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		go func() {
			defer c.Close()
			for {
				if _, _, err := c.ReadMessage(); err != nil {
					return
				}
			}
		}()
	}
}

// dialEcho returns a client-side *websocket.Conn pointed at the test server.
func dialEcho(t *testing.T, ts *httptest.Server) *websocket.Conn {
	t.Helper()
	url := strings.Replace(ts.URL, "http://", "ws://", 1)
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("ws dial: %v", err)
	}
	return c
}

// TC-L3-1: addClient on exited Pane must reject and not register.
func TestPane_AddClientRejectedAfterExit(t *testing.T) {
	p, err := StartPane("t-exit", "test", "", 80, 24, nil, nil)
	if err != nil {
		t.Fatalf("StartPane: %v", err)
	}
	p.kill()
	<-p.Wait()

	ts := httptest.NewServer(echoWSHandler())
	defer ts.Close()

	conn := dialEcho(t, ts)
	defer conn.Close()
	sc := newSafeConn(conn)

	if ok := p.addClient(sc); ok {
		t.Fatalf("addClient returned true for exited pane")
	}
	p.cmu.Lock()
	n := len(p.cls)
	p.cmu.Unlock()
	if n != 0 {
		t.Fatalf("cls=%d want 0 after rejected add", n)
	}
}

// TC-L3-2: concurrent broadcast/addClient/removeClient must be race-clean.
func TestPane_BroadcastAddRemoveRace(t *testing.T) {
	p, err := StartPane("t-race", "race", "", 80, 24, nil, nil)
	if err != nil {
		t.Fatalf("StartPane: %v", err)
	}
	defer p.kill()

	ts := httptest.NewServer(echoWSHandler())
	defer ts.Close()

	const workers = 16
	var wg sync.WaitGroup
	stop := make(chan struct{})

	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := dialEcho(t, ts)
			defer c.Close()
			sc := newSafeConn(c)
			for {
				select {
				case <-stop:
					return
				default:
				}
				if p.addClient(sc) {
					p.removeClient(sc)
				}
			}
		}()
	}

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			msg := []byte{OpOutput, 'x'}
			for {
				select {
				case <-stop:
					return
				default:
				}
				p.broadcast(msg)
			}
		}()
	}

	time.Sleep(200 * time.Millisecond)
	close(stop)
	wg.Wait()
}

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
				s := h.add()
				select {
				case <-s.ch:
				default:
				}
				h.remove(s)
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
