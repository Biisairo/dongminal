package boot

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgerelay"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"
)

// PEER_DAEMON_SRS FR-PDM-20~22: 데몬이 노드를 세운다 — 신원을 만들고, 켜진 설정이면 노드 소켓을
// 듣는다. 돌려준 함수가 노드 소켓을 닫는다. 서버 시험의 데몬 노드 픽스처는 이 배선을 따로 짜므로
// 프로덕션 배선은 여기서 잰다.
func TestStartEdge_IdentityAndNodeSocket(t *testing.T) {
	home, err := os.MkdirTemp("", "be")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	raw, _ := json.Marshal(edge.Config{Enabled: true, Name: "bnode"})
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	ps := ipc.NewPanedServer(pm, filepath.Join(home, "s"), "")

	closeEdge := startEdge(home, ps, pm)
	closed := false
	t.Cleanup(func() {
		if !closed {
			closeEdge()
		}
	})

	if _, err := os.Stat(filepath.Join(home, dmenv.EdgeKeyFile)); err != nil {
		t.Fatalf("노드 신원이 없다: %v", err)
	}
	sock := edgerelay.NodeSocketPath(home)
	c, err := platform.Current().IPC.Dial(sock, time.Second)
	if err != nil {
		t.Fatalf("켜진 설정인데 노드 소켓을 듣지 않는다: %v", err)
	}
	_ = c.Close()

	closeEdge()
	closed = true
	if c, err := platform.Current().IPC.Dial(sock, time.Second); err == nil {
		_ = c.Close()
		t.Fatal("닫은 뒤에도 노드 소켓이 열려 있다")
	}
}
