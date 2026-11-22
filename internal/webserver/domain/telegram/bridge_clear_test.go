package telegram

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// QUALITY_GO_SRS TC-QG-20: 버튼 걷기는 상한 있는 병렬이다 (FR-QG-20 · D-QG-6).
//
// 가짜 Telegram 이 요청마다 100ms 를 쓴다. 버튼 32개(탭 하나의 상한)를 걷는 벽시계 시간과
// 동시에 떠 있던 요청 수의 최댓값을 잰다.
//
//	이전(순차): 32 × 100ms ≈ 3.2s, 동시 1
//	새(상한 4): 32 / 4 × 100ms ≈ 0.8s, 동시 ≤ 4
func TestBridge_ClearButtonsBoundedParallel(t *testing.T) {
	const delay = 100 * time.Millisecond
	var mu sync.Mutex
	inFlight, peak, calls := 0, 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		inFlight++
		calls++
		peak = max(peak, inFlight)
		mu.Unlock()
		time.Sleep(delay)
		mu.Lock()
		inFlight--
		mu.Unlock()
		_, _ = io.WriteString(w, `{"ok":true,"result":true}`)
	}))
	defer srv.Close()
	st := OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	_ = st.SetToken(testToken, "office_bot")
	_ = st.SetUser(me)
	_ = st.SetEnabled(true)
	b := NewBridge(st, &fakeHost{lastIn: map[string]time.Time{}}, srv.URL, time.Now)
	for i := range maxButtonsPerTab {
		b.buttons[tabA] = append(b.buttons[tabA], int64(i+1))
	}

	start := time.Now()
	b.clearButtons(st.Config(), tabA)
	took := time.Since(start)
	t.Logf("버튼 %d개 걷기 %v, 동시 최대 %d (요청당 %v)", maxButtonsPerTab, took, peak, delay)

	if calls != maxButtonsPerTab {
		t.Fatalf("걷기 요청 %d, want %d", calls, maxButtonsPerTab)
	}
	if peak > clearButtonsParallel {
		t.Fatalf("동시 요청 %d 가 상한 %d 를 넘었다", peak, clearButtonsParallel)
	}
	// 순차면 32 × 100ms. 상한 병렬이면 그 1/상한 언저리다 — 기계 부하를 넉넉히 둔다.
	if limit := time.Duration(maxButtonsPerTab) * delay / 2; took >= limit {
		t.Fatalf("걷기 %v — 순차와 다르지 않다(한계 %v)", took, limit)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.buttons[tabA]; ok {
		t.Fatal("걷은 탭의 목록이 남았다")
	}
}
