package platform

import (
	"path/filepath"
	"testing"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-42: 형제 소켓은 IPC 종단과 같은 폴더에 산다.
func TestSiblingSocket(t *testing.T) {
	home := t.TempDir()
	want := filepath.Join(filepath.Dir(Current().IPC.Endpoint(home)), "x.sock")
	if got := SiblingSocket(home, "x.sock"); got != want {
		t.Fatalf("SiblingSocket=%q want %q", got, want)
	}
}
