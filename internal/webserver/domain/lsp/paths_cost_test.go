package lsp

import (
	"errors"
	"sync/atomic"
	"testing"
)

// FR-OPT-6-4 (DOM-12): 경로 표 저장은 아는 id 를 얻으려 탐색하지 않는다.
func TestPaths_SetDoesNotLocate(t *testing.T) {
	var looks atomic.Int32
	svc := svcWith(t, nil, nil)
	svc.Ext.LookPath = func(string) (string, error) {
		looks.Add(1)
		return "", errors.New("not found")
	}
	if _, err := svc.SetPaths(map[string]string{"gopls/gopls": "/opt/gopls"}); err != nil {
		t.Fatal(err)
	}
	if got := looks.Load(); got != 0 {
		t.Fatalf("LookPath %d 번 — 이전 동작은 서버마다 탐색했다", got)
	}
}
