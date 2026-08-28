package toolhub

import (
	"sync"
	"testing"
)

// ATTENTION_LIFECYCLE_GIT_OBSERVE_SRS V-ATL-1 (FR-ATL-1·2): 도구가 죽으면 주의도
// 해제된다. `kill()` 은 활동을 `ended` 로 내리면서 주의는 그대로 두었고, 그것이
// 닫은 탭의 알람이 배지에 남던 이유다 (A1). NFR-PAN-8 이 요구하던 정리다.
func TestTool_Kill_ClearsAttention(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	p.SignalAttention("done")
	if !p.Attention() {
		t.Fatalf("주의가 서지 않았다")
	}

	p.kill()

	if p.Attention() {
		t.Fatalf("kill 후에도 주의가 남았다")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(clear) != 1 || clear[0] != "1" {
		t.Fatalf("해제 통지가 정확히 1회여야 한다: %v", clear)
	}
}

// V-ATL-2: 에지다 — 주의가 없던 도구를 죽여도 해제를 발행하지 않는다 (NFR-PAN-3).
func TestTool_Kill_AttentionClearIsEdge(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)

	p.kill()

	mu.Lock()
	defer mu.Unlock()
	if len(clear) != 0 {
		t.Fatalf("주의가 없었는데 해제를 발행했다: %v", clear)
	}
}

// kill 은 두 번 불려도 한 번만 동작한다 (sync.Once). 해제도 마찬가지여야 한다.
func TestTool_Kill_TwiceClearsOnce(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	p.SignalAttention("done")

	p.kill()
	p.kill()

	mu.Lock()
	defer mu.Unlock()
	if len(clear) != 1 {
		t.Fatalf("해제가 %d 회다", len(clear))
	}
}

// 죽은 도구는 idle 로도 다시 깨어나지 않는다 — armed 가 내려가야 한다.
func TestTool_Kill_DisarmsIdle(t *testing.T) {
	defer func(orig func(*Tool) bool) { attnBusyProbe = orig }(attnBusyProbe)
	attnBusyProbe = func(*Tool) bool { return true }
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("1", &mu, &attn, &clear)
	p.observeOutputAt([]byte("x"), 0)

	p.kill()
	p.maybeIdle(10_000, 1_000)

	mu.Lock()
	defer mu.Unlock()
	if len(attn) != 0 {
		t.Fatalf("죽은 도구가 idle 알람을 냈다: %v", attn)
	}
}
