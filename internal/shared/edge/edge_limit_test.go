package edge

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// ATTIC_FIX_SRS TC-ATF-80 (FR-ATF-80 · AT-ECFG-3): 간선 수 상한.

func nthFP(i int) string { return fmt.Sprintf("%064x", i+1) }

func nthEdge(i int) Edge {
	return Edge{Name: fmt.Sprintf("n%d", i), Addr: "10.0.0.2", Port: DefaultPort, Fingerprint: nthFP(i)}
}

func TestAddEdgeRejectsBeyondMax(t *testing.T) {
	s := newTestStore(t)
	for i := range MaxEdges {
		if err := s.AddEdge(nthEdge(i)); err != nil {
			t.Fatalf("%d 번째 간선: %v", i+1, err)
		}
	}
	if err := s.CanAdd(nthFP(MaxEdges)); !errors.Is(err, ErrEdgeLimit) {
		t.Fatalf("CanAdd 65번째 = %v, want ErrEdgeLimit", err)
	}
	if err := s.AddEdge(nthEdge(MaxEdges)); !errors.Is(err, ErrEdgeLimit) {
		t.Fatalf("65번째 간선 = %v, want ErrEdgeLimit", err)
	}
	if n := len(s.Config().Edges); n != MaxEdges {
		t.Fatalf("간선 %d 개, want %d", n, MaxEdges)
	}
	// 이미 있는 간선을 다시 맺는 것은 추가가 아니다.
	again := nthEdge(3)
	again.Name = "renamed"
	if err := s.CanAdd(again.Fingerprint); err != nil {
		t.Fatalf("CanAdd 있는 간선 = %v", err)
	}
	if err := s.AddEdge(again); err != nil {
		t.Fatalf("있는 간선 다시 맺기 = %v", err)
	}
}

// 파일에 이미 상한을 넘게 있으면 지우지 않고 읽는다. 추가만 막고 다른 저장은 막지 않는다.
func TestOpenStoreKeepsEdgesBeyondMax(t *testing.T) {
	path := filepath.Join(t.TempDir(), dmenv.EdgesFile)
	over := MaxEdges + 6
	c := defaultConfig("host-a")
	for i := range over {
		c.Edges = append(c.Edges, nthEdge(i))
	}
	raw, _ := json.Marshal(c)
	if err := os.WriteFile(path, raw, fileMode); err != nil {
		t.Fatal(err)
	}
	s := OpenStore(path, "host-a")
	if n := len(s.Config().Edges); n != over {
		t.Fatalf("읽은 간선 %d 개, want %d", n, over)
	}
	if err := s.AddEdge(nthEdge(over)); !errors.Is(err, ErrEdgeLimit) {
		t.Fatalf("상한 넘은 파일에 추가 = %v, want ErrEdgeLimit", err)
	}
	if err := s.SetName("office"); err != nil {
		t.Fatalf("상한 넘은 파일의 이름 바꾸기 = %v", err)
	}
	if err := s.Remove(nthFP(0)); err != nil {
		t.Fatalf("상한 넘은 파일의 간선 지우기 = %v", err)
	}
	if n := len(OpenStore(path, "host-a").Config().Edges); n != over-1 {
		t.Fatalf("다시 읽은 간선 %d 개, want %d", n, over-1)
	}
}
