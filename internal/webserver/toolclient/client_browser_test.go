package toolclient

import (
	"context"
	"errors"
	"testing"
)

// TC-BRT-8: browser 기능을 말하지 않는 옛 데몬과 붙으면 데몬을 다시 시작하라고 안내한다.
func TestBrowserCallOldDaemon(t *testing.T) {
	pc := &ToolClient{}
	if _, err := pc.Call(context.Background(), "tabs", map[string]any{}); !errors.Is(err, ErrDaemonNoBrowser) {
		t.Fatalf("err=%v", err)
	}
}
