package workspace

import (
	"errors"
	"testing"
	"time"
)

// `GO-10`(PRODUCTION_ROADMAP §M3) — **영속 실패가 성공으로 보이지 않는다.**
//
// 저장은 요청 경로를 막지 않으려고 고루틴으로 떨어진다. 그래서 디스크 쓰기가
// 실패해도 `Save` 는 이미 200 을 돌려준 뒤다 — 사용자는 저장된 줄 안다. 그 사실을
// 기억해 헬스에 싣는다 (VERSION_HEALTH_SRS FR-VHL-10 의 `lastPersistErr`).

type failingStore struct {
	blob []byte
	fail bool
}

func (f *failingStore) Read() ([]byte, error) { return f.blob, nil }
func (f *failingStore) Write(b []byte) error {
	if f.fail {
		return errors.New("disk full")
	}
	f.blob = append([]byte(nil), b...)
	return nil
}

func waitPersist(t *testing.T, cond func() bool) bool {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

// 쓰기가 실패하면 그 사실이 남는다.
func TestPersistErrIsRemembered(t *testing.T) {
	st := &failingStore{blob: []byte(goodWS), fail: true}
	m, err := New(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	if _, err := m.Save([]byte(goodWS), ""); err != nil {
		t.Fatal(err)
	}
	if !waitPersist(t, func() bool { return m.PersistErr() != "" }) {
		t.Fatal("쓰기가 실패했는데 아무 사실도 남지 않았다 (GO-10)")
	}
}

// 성공하면 사실이 **걷힌다** — 한 번의 실패가 영원히 빨갛게 남으면 그것은
// 상태가 아니라 흉터다.
func TestPersistErrClearsOnSuccess(t *testing.T) {
	st := &failingStore{blob: []byte(goodWS), fail: true}
	m, err := New(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	m.Save([]byte(goodWS), "")
	if !waitPersist(t, func() bool { return m.PersistErr() != "" }) {
		t.Fatal("실패가 기록되지 않았다")
	}
	st.fail = false
	m.Save([]byte(goodWS), "")
	if !waitPersist(t, func() bool { return m.PersistErr() == "" }) {
		t.Fatal("다시 성공했는데 실패 사실이 남아 있다")
	}
}

// 사유는 **분류**이며 경로를 담지 않는다 (FR-VHL-14).
func TestPersistErrCarriesNoPath(t *testing.T) {
	st := &failingStore{blob: []byte(goodWS), fail: true}
	m, err := New(nil, st)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close() })

	m.Save([]byte(goodWS), "")
	waitPersist(t, func() bool { return m.PersistErr() != "" })
	if got := m.PersistErr(); got != PersistFailed {
		t.Fatalf("PersistErr=%q want %q — 분류여야 한다", got, PersistFailed)
	}
}
