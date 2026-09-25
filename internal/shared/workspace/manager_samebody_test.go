package workspace

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-5-1 (FEC-1): raw 바이트가 같은 저장은 **무동작**이다.
//
// rev 를 올리지 않고, 디스크에 쓰지 않고, 인덱스 훅도 부르지 않는다. 포커스·창
// 전환만 바뀐 PUT 이 rev 를 올리면 다른 화면의 대기 저장이 409 를 맞는다.
func TestSaveSameRawIsNoop(t *testing.T) {
	store := &memPersister{empty: true}
	m, err := New(newFakeLive("10", "11", "12"), store)
	if err != nil {
		t.Fatal(err)
	}
	hooks := 0
	m.OnIndexUpdate = func() { hooks++ }

	rev, err := m.Save([]byte(sampleWS), "0")
	if err != nil || rev != 1 {
		t.Fatalf("첫 저장 rev=%d err=%v", rev, err)
	}
	rev, err = m.Save([]byte(sampleWS), "1")
	if err != nil {
		t.Fatal(err)
	}
	if rev != 1 {
		t.Fatalf("같은 본문 저장이 rev 를 %d 로 올렸다 (want 1)", rev)
	}
	if hooks != 1 {
		t.Fatalf("훅 %d회 want 1 — 같은 본문이 재색인을 일으켰다", hooks)
	}
	if err := m.Close(); err != nil {
		t.Fatal(err)
	}
	if store.wrote != 1 {
		t.Fatalf("디스크 쓰기 %d회 want 1", store.wrote)
	}

	// 같은 본문이어도 조건 검사는 먼저다 — 낡은 rev 는 409 다.
	if _, err := m.Save([]byte(sampleWS), "0"); !errors.Is(err, ErrStale) {
		t.Fatalf("낡은 If-Match 가 같은 본문이라고 통과했다: %v", err)
	}
}

// variantWS 는 ws 와 색인은 같고 바이트만 다른 본문이다. 같은 바이트의 저장은
// 무동작이므로(FR-OPT-5-1) 저장이 실제로 도는 것을 재는 검사가 이것을 쓴다.
func variantWS(ws string, n int) []byte {
	return []byte(strings.Replace(ws, "{", fmt.Sprintf(`{"_n":%d,`, n), 1))
}
