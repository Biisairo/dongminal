package browser

import (
	"context"
	"testing"
)

func TestRealDefaultContextKnown(t *testing.T) {
	m, _ := realManager(t)
	b, err := m.browserFor(context.Background(), DefaultProfile)
	if err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	d := b.defaultCtx
	b.mu.Unlock()
	if d == "" {
		t.Fatal("defaultBrowserContextId 를 받지 못했다")
	}
}
