package run

import (
	"bytes"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-5-4 (DOM-3) — runs.json 쓰기 경로.

func readRunsFile(t *testing.T, s *Store) []byte {
	t.Helper()
	b, err := os.ReadFile(s.path())
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// ContextAt 만 바뀐 관측은 디스크에 닿지 않는다 — 훅마다 runs.json 전체를 쓰지 않는다.
func TestObserveContext_ContextAtOnlySkipsSave(t *testing.T) {
	s := storeWithMember(t, "t1")
	obs := ContextObservation{Tokens: 1000, HasTokens: true, Model: "claude-opus-5", Agent: "claude"}
	s.ObserveContext("t1", obs, DefaultContextPolicy())
	s.ObserveContext("coord", obs, DefaultContextPolicy())
	before := readRunsFile(t, s)

	m, _, _ := s.ObserveContext("t1", obs, DefaultContextPolicy())
	s.ObserveContext("coord", obs, DefaultContextPolicy())
	if got := readRunsFile(t, s); !bytes.Equal(got, before) {
		t.Fatal("ContextAt 만 바뀐 관측이 runs.json 을 다시 썼다")
	}
	// 메모리에는 반영된다 — 화면의 '마지막 관측' 은 최신이어야 한다.
	_, got, _ := s.FindMember(m.ID)
	if got.ContextAt != m.ContextAt || m.ContextAt == 0 {
		t.Fatalf("메모리 ContextAt=%d want %d", got.ContextAt, m.ContextAt)
	}

	// 값이 바뀐 관측은 종전대로 쓴다.
	obs.Tokens = 2000
	s.ObserveContext("t1", obs, DefaultContextPolicy())
	if bytes.Equal(readRunsFile(t, s), before) {
		t.Fatal("토큰이 바뀐 관측이 저장되지 않았다")
	}
}

// 쓰기는 s.mu 밖에서 한다 — 느린 디스크가 조회를 막지 않는다.
func TestSave_WriteDoesNotHoldStoreLock(t *testing.T) {
	s := storeWithMember(t, "t1")
	rec := s.List()[0]
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	orig := s.write
	s.write = func(path string, data []byte, perm os.FileMode) error {
		once.Do(func() { close(entered); <-release })
		return orig(path, data, perm)
	}
	done := make(chan error, 1)
	go func() {
		done <- s.AppendMessage(rec.ID, MsgEvent{From: "coordinator", To: rec.Members[0].ID, Kind: "agent", Size: 1})
	}()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("저장이 s.write 를 지나지 않았다")
	}

	listed := make(chan struct{})
	go func() { s.List(); close(listed) }()
	select {
	case <-listed:
	case <-time.After(2 * time.Second):
		close(release)
		<-done
		t.Fatal("쓰기 동안 List 가 막혔다 — 쓰기가 s.mu 안에 있다")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// 쓰기가 잠금 밖으로 나가도 디스크 도착 순서는 변경 순서다 — 마지막 판이 이긴다.
func TestSave_ConcurrentWritesLandInOrder(t *testing.T) {
	s := storeWithMember(t, "t1")
	rec := s.List()[0]
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.AppendMessage(rec.ID, MsgEvent{From: "coordinator", To: rec.Members[0].ID, Kind: "agent", Size: 1}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	var body fileBody
	if err := json.Unmarshal(readRunsFile(t, s), &body); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(rec.ID)
	if len(body.Runs) != 1 || len(body.Runs[0].Messages) != len(got.Messages) {
		t.Fatalf("디스크 메시지 %d개, 메모리 %d개 — 낡은 판이 나중에 도착했다", len(body.Runs[0].Messages), len(got.Messages))
	}
}
