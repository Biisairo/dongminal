package toolhub

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-7 (IPC-25) — Send 가 op 바이트를 붙이려고 payload 를
// 새로 할당·복사하지 않는다. 전후 allocs/op·B/op 를 이 벤치로 잰다.
func BenchmarkSafeConnSend(b *testing.B) {
	got := make(chan *websocket.Conn, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := Upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		got <- c
	}))
	defer ts.Close()
	cli, _, err := websocket.DefaultDialer.Dial(strings.Replace(ts.URL, "http://", "ws://", 1), nil)
	if err != nil {
		b.Fatal(err)
	}
	defer cli.Close()
	go func() {
		for {
			if _, _, err := cli.NextReader(); err != nil {
				return
			}
		}
	}()
	sc := NewSafeConn(<-got)
	defer sc.Close()
	payload := make([]byte, 8<<10)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := sc.Send(OpOutput, payload); err != nil {
			b.Fatal(err)
		}
	}
}
