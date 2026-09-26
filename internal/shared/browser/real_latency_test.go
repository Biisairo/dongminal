package browser

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"
)

// NFR-BRT-P1: 입력 → 화면. 뷰어의 입력이 매니저에 닿은 때부터 그 결과가 담긴 screencast
// 프레임이 나올 때까지를 잰다(네트워크 구간은 빼고 서버 쪽 몫만). 목표는 p50 ≤ 100ms 다.
func TestRealInputToFrameLatency(t *testing.T) {
	m, _ := realManager(t)
	var mu sync.Mutex
	var frames []time.Time
	m.SetSink(func(e Event) {
		if e.Kind == EvFrame && e.Tab == "t" {
			mu.Lock()
			frames = append(frames, time.Now())
			mu.Unlock()
		}
	})
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`<!doctype html><title>lat</title><body style="margin:0"><div id=n style="font:48px sans-serif">0</div>
<script>let c=0;addEventListener('mousedown',()=>{document.getElementById('n').textContent=++c})</script>`))
	}))
	t.Cleanup(site.Close)
	ctx := context.Background()
	if err := m.Open(ctx, OpenReq{Tab: "t", URL: site.URL}); err != nil {
		t.Fatal(err)
	}
	waitEval(t, m, "t", `document.title`, `"lat"`)
	if _, err := m.Call(ctx, "viewport", map[string]any{"tab": "t", "w": 800, "h": 600, "dpr": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Call(ctx, "watch", map[string]any{"tab": "t", "on": true}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	var lat []time.Duration
	for i := 0; i < 20; i++ {
		mu.Lock()
		n := len(frames)
		mu.Unlock()
		t0 := time.Now()
		for _, typ := range []string{"mousePressed", "mouseReleased"} {
			if _, err := m.Call(ctx, "input", map[string]any{"tab": "t", "t": "mouse", "type": typ, "x": 50, "y": 30, "button": "left", "clickCount": 1}); err != nil {
				t.Fatal(err)
			}
		}
		for end := t0.Add(2 * time.Second); ; time.Sleep(time.Millisecond) {
			mu.Lock()
			got := len(frames) > n
			var at time.Time
			if got {
				at = frames[n]
			}
			mu.Unlock()
			if got {
				lat = append(lat, at.Sub(t0))
				break
			}
			if time.Now().After(end) {
				t.Fatalf("%d 번째 입력 뒤 프레임이 오지 않는다", i)
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	p50, p90 := lat[len(lat)/2], lat[len(lat)*9/10]
	t.Logf("입력→프레임 p50=%v p90=%v (n=%d)", p50, p90, len(lat))
	if p50 > 100*time.Millisecond {
		t.Fatalf("p50 %v > 100ms (NFR-BRT-P1)", p50)
	}
}
