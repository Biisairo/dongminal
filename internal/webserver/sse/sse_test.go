package sse

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type countRec struct {
	*httptest.ResponseRecorder
	flushes int
}

func (c *countRec) Flush() { c.flushes++; c.ResponseRecorder.Flush() }

func TestStream_FramesAndOneFlush(t *testing.T) {
	rec := &countRec{ResponseRecorder: httptest.NewRecorder()}
	s := Start(rec, 0)
	if rec.Header().Get("Content-Type") != "text/event-stream" || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("헤더 = %v", rec.Header())
	}
	s.Comment("connected")
	s.Data([]byte(`{"a":1}`))
	s.Event("line", []byte(`{"b":2}`))
	if !s.Flush() {
		t.Fatal("Flush 실패")
	}
	want := ": connected\n\ndata: {\"a\":1}\n\nevent: line\ndata: {\"b\":2}\n\n"
	if rec.Body.String() != want {
		t.Fatalf("본문 = %q, want %q", rec.Body.String(), want)
	}
	if rec.flushes != 1 {
		t.Fatalf("flush = %d, want 1", rec.flushes)
	}
	// 빈 버퍼는 쓰지 않는다.
	if !s.Flush() || rec.flushes != 1 {
		t.Fatalf("빈 Flush 가 썼다 (flush=%d)", rec.flushes)
	}
}

func TestStream_DrainStopsAtEmptyAndCap(t *testing.T) {
	rec := httptest.NewRecorder()
	s := Start(rec, 0)
	ch := make(chan []byte, 8)
	for i := 0; i < 3; i++ {
		ch <- []byte("x")
	}
	s.DrainData(ch)
	if len(ch) != 0 {
		t.Fatalf("남은 것 = %d", len(ch))
	}
	s.Flush()
	if got := strings.Count(rec.Body.String(), "data: x\n\n"); got != 3 {
		t.Fatalf("프레임 = %d", got)
	}

	big := bytes.Repeat([]byte("y"), MaxBatchBytes/2)
	for i := 0; i < 4; i++ {
		ch <- big
	}
	s.DrainData(ch)
	if len(ch) == 0 || !s.Full() {
		t.Fatalf("상한에서 멈추지 않았다 (남음 %d, full=%v)", len(ch), s.Full())
	}
}

func TestSupported(t *testing.T) {
	if !Supported(httptest.NewRecorder()) {
		t.Fatal("Recorder 는 Flusher 다")
	}
	if Supported(struct{ http.ResponseWriter }{httptest.NewRecorder()}) {
		t.Fatal("Flusher 가 아닌 것을 지원한다고 했다")
	}
}

// 읽지 않는 클라이언트: 쓰기 시한이 지나면 Flush 가 false 로 돌아온다 (HTTP-10 — job
// events 에는 이 시한이 없었다).
func TestStream_WriteDeadlineOnStuckClient(t *testing.T) {
	res := make(chan bool, 1)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := Start(w, 150*time.Millisecond)
		big := bytes.Repeat([]byte("z"), 1<<20)
		for i := 0; i < 64; i++ {
			s.Data(big)
			if !s.Flush() {
				res <- false
				return
			}
		}
		res <- true
	}))
	defer ts.Close()
	resp, err := http.Get(ts.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	select {
	case ok := <-res:
		if ok {
			t.Fatal("읽지 않는 클라이언트에 64 MiB 를 다 썼다 — 시한이 걸리지 않았다")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("막힌 쓰기에서 돌아오지 않았다")
	}
}
