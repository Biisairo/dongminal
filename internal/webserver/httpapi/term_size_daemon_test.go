package httpapi

import (
	"os"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/toolclient"
)

// V-M9-3a (daemon) — 크기 통보는 **프로세스 경계를 건넌다** (M9_SRS FR-M9-3).
//
// direct 모드만 고치면 그 자리가 다음 결함이 된다 (M8 D-A-16 의 교훈). 여기서
// 재는 것은 IPC 경계 둘이다: ① snapshot 응답이 크기를 실어 오는가 ② PTY 크기가
// 바뀌면 `size` push 가 구독자에게 닿는가.

// daemonPair 는 데몬(PanedServer)과 웹서버 쪽 손잡이(ToolClient)를 세운다.
func daemonPair(t *testing.T) (*toolhub.ToolManager, *toolclient.ToolClient) {
	t.Helper()
	dir := toolTempDir(t)
	sockPath := dir + "/s"
	dataDir := dir + "/d"
	os.MkdirAll(dataDir, 0o755)

	pm := toolhub.NewToolManager(dataDir, nil)
	t.Cleanup(pm.StopSaving)
	ps := ipc.NewPanedServer(pm, sockPath, "")
	if err := ps.Listen(); err != nil {
		t.Fatalf("Listen: %v", err)
	}
	t.Cleanup(func() { ps.Close() })
	go func() { ps.Accept() }()

	pc, err := toolclient.DialToolClient(sockPath)
	if err != nil {
		t.Fatalf("DialToolClient: %v", err)
	}
	t.Cleanup(pc.Close)
	return pm, pc
}

// V-M9-3a: 데몬의 snapshot 이 **지금 PTY 의 크기**를 실어 온다 (FR-M9-3 ①).
//
// 데몬 모드에서 `Get(id)` 이 주는 것은 크기를 모르는 합성 Tool 이므로, 접속 직후의
// 통보가 딛는 값은 이 응답 하나뿐이다.
func TestDaemonSnapshotCarriesSize(t *testing.T) {
	pm, pc := daemonPair(t)

	p, err := pm.Create("/tmp", 91, 27, toolhub.Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer pm.Delete(p.ID)

	snap, err := pc.SnapshotToolSince(p.ID, -1)
	if err != nil {
		t.Fatalf("SnapshotToolSince: %v", err)
	}
	if snap.Cols != 91 || snap.Rows != 27 {
		t.Errorf("snapshot 크기=%dx%d want 91x27", snap.Cols, snap.Rows)
	}
}

// V-M9-3a: PTY 크기가 바뀌면 `size` push 가 구독자에게 닿는다 (FR-M9-3 ②).
//
// 조각은 **출력과 같은 채널**로 온다 — 순서 때문이며, 그래서 여기서도 같은
// 채널에서 기다린다 (hub.go 의 `OutChunk.Size`).
func TestDaemonResizePushesSizeToSubscriber(t *testing.T) {
	pm, pc := daemonPair(t)

	p, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer pm.Delete(p.ID)

	ch := make(chan toolhub.OutChunk, 64)
	_, unsub := pc.Subscribe(p.ID, ch)
	defer unsub()

	if err := pm.Resize(p.ID, 143, 37); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	deadline := time.After(5 * time.Second)
	for {
		select {
		case chunk := <-ch:
			if chunk.Size == nil {
				continue // 출력 조각은 건너뛴다
			}
			if chunk.Size.Cols != 143 || chunk.Size.Rows != 37 {
				t.Fatalf("push 된 크기=%dx%d want 143x37", chunk.Size.Cols, chunk.Size.Rows)
			}
			return
		case <-deadline:
			t.Fatal("크기가 바뀌었는데 size push 가 구독자에게 오지 않았다")
		}
	}
}

// V-M9-3a: 같은 크기를 다시 주면 push 하지 않는다 — 두 모드가 같은 규약이다.
func TestDaemonResizeUnchangedIsSilent(t *testing.T) {
	pm, pc := daemonPair(t)

	p, err := pm.Create("/tmp", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer pm.Delete(p.ID)

	ch := make(chan toolhub.OutChunk, 64)
	_, unsub := pc.Subscribe(p.ID, ch)
	defer unsub()

	if err := pm.Resize(p.ID, 80, 24); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	deadline := time.After(700 * time.Millisecond)
	for {
		select {
		case chunk := <-ch:
			if chunk.Size != nil {
				t.Fatalf("바뀌지 않았는데 size push 가 왔다: %dx%d", chunk.Size.Cols, chunk.Size.Rows)
			}
		case <-deadline:
			return
		}
	}
}
