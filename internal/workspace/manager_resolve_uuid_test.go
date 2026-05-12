package workspace

import (
	"strings"
	"testing"
)

type liveSet map[string]struct{}

func (l liveSet) IsLive(paneID string) bool {
	_, ok := l[paneID]
	return ok
}

func newManagerWithBlob(t *testing.T, live Liveness, blob string) *Manager {
	t.Helper()
	m, err := New(live, &errorPersister{err: nil})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if blob != "" {
		if _, err := m.Save([]byte(blob), ""); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

// FR-UID-8: Resolve 는 동일 입력 필드에서 label, paneId, full uuid 를 모두
// 수용한다. 셋 다 동일 paneId 를 반환해야 한다.
func TestResolve_AcceptsLabelPaneIdAndUUID(t *testing.T) {
	tabUUID := "550e8400-e29b-41d4-a716-446655440003"
	blob := `{"activeSession":"550e8400-e29b-41d4-a716-446655440001","sessions":[{"id":"550e8400-e29b-41d4-a716-446655440001","name":"Main","focusedRegion":"550e8400-e29b-41d4-a716-446655440002","layout":{"type":"region","id":"550e8400-e29b-41d4-a716-446655440002","activeTab":"` + tabUUID + `","tabs":[{"id":"` + tabUUID + `","name":"Shell","paneId":"1"}]}}]}`
	m := newManagerWithBlob(t, liveSet{"1": {}}, blob)

	cases := []struct {
		name, input string
	}{
		{"label", "S1.P1.T1"},
		{"paneId", "1"},
		{"uuid", tabUUID},
		{"uuid uppercase", strings.ToUpper(tabUUID)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := m.Resolve(c.input)
			if err != nil {
				t.Fatalf("Resolve(%q): %v", c.input, err)
			}
			if got != "1" {
				t.Errorf("Resolve(%q)=%q want %q", c.input, got, "1")
			}
		})
	}
}

// TC-UID-2: 라벨 reflow 후에도 uuid 는 동일 paneId 를 유지한다.
func TestResolve_UUIDStableAcrossLabelReflow(t *testing.T) {
	tabA := "550e8400-e29b-41d4-a716-446655440aaa"
	tabB := "550e8400-e29b-41d4-a716-446655440bbb"
	// 처음: 세션 둘. A 가 S1, B 가 S2.
	blob1 := `{"activeSession":"sa","sessions":[
		{"id":"sa","name":"A","focusedRegion":"ra","layout":{"type":"region","id":"ra","activeTab":"` + tabA + `","tabs":[{"id":"` + tabA + `","name":"a","paneId":"10"}]}},
		{"id":"sb","name":"B","focusedRegion":"rb","layout":{"type":"region","id":"rb","activeTab":"` + tabB + `","tabs":[{"id":"` + tabB + `","name":"b","paneId":"20"}]}}
	]}`
	m := newManagerWithBlob(t, liveSet{"10": {}, "20": {}}, blob1)

	if pid, _ := m.Resolve(tabB); pid != "20" {
		t.Fatalf("before reflow: Resolve(B uuid)=%q want %q", pid, "20")
	}
	if pid, _ := m.Resolve("S2.P1.T1"); pid != "20" {
		t.Fatalf("before reflow: Resolve(S2 label)=%q want %q", pid, "20")
	}

	// 세션 A 종료. B 의 위치 라벨이 S2 → S1 로 reflow.
	blob2 := `{"activeSession":"sb","sessions":[
		{"id":"sb","name":"B","focusedRegion":"rb","layout":{"type":"region","id":"rb","activeTab":"` + tabB + `","tabs":[{"id":"` + tabB + `","name":"b","paneId":"20"}]}}
	]}`
	if _, err := m.Save([]byte(blob2), "1"); err != nil {
		t.Fatalf("Save reflow: %v", err)
	}

	// label 은 S1 로 옮겨졌고, uuid 는 변함없이 같은 paneId.
	if pid, _ := m.Resolve("S1.P1.T1"); pid != "20" {
		t.Errorf("after reflow: Resolve(S1 label)=%q want %q (B is now S1)", pid, "20")
	}
	if pid, _ := m.Resolve(tabB); pid != "20" {
		t.Errorf("after reflow: Resolve(B uuid)=%q want %q (uuid stable)", pid, "20")
	}
	if _, err := m.Resolve(tabA); err == nil {
		t.Errorf("after reflow: Resolve(A uuid) should fail — A removed")
	}
}

// NFR-UID-4: short code 8자만으로 resolve 시도하면 거부 (full uuid 만 권한).
func TestResolve_RejectsShortCode(t *testing.T) {
	tabUUID := "550e8400-e29b-41d4-a716-446655440003"
	blob := `{"activeSession":"s","sessions":[{"id":"s","name":"x","focusedRegion":"r","layout":{"type":"region","id":"r","activeTab":"` + tabUUID + `","tabs":[{"id":"` + tabUUID + `","name":"a","paneId":"1"}]}}]}`
	m := newManagerWithBlob(t, liveSet{"1": {}}, blob)
	if _, err := m.Resolve("550e8400"); err == nil {
		t.Errorf("short-code resolve should fail per NFR-UID-4")
	}
}

// FR-UID-12 (broadcast 경로): CoordinateOf 는 uuid 만 좌표로 변환한다.
// coordinate / paneId / label / 빈문자는 그대로 통과 — 행위 보존.
func TestCoordinateOf_PassThroughAndTranslate(t *testing.T) {
	tabUUID := "550e8400-e29b-41d4-a716-446655440003"
	blob := `{"activeSession":"s","sessions":[{"id":"s","name":"x","focusedRegion":"r","layout":{"type":"region","id":"r","activeTab":"` + tabUUID + `","tabs":[{"id":"` + tabUUID + `","name":"a","paneId":"7"}]}}]}`
	m := newManagerWithBlob(t, liveSet{"7": {}}, blob)

	cases := []struct {
		name, in, want string
	}{
		{"empty", "", ""},
		{"coordinate dotted", "4.1.1", "4.1.1"},
		{"coordinate prefixed", "S4.P1.T1", "S4.P1.T1"},
		{"paneId numeric", "7", "7"},
		{"uuid translates", tabUUID, "S1.P1.T1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := m.CoordinateOf(c.in)
			if err != nil {
				t.Fatalf("CoordinateOf(%q): %v", c.in, err)
			}
			if got != c.want {
				t.Errorf("CoordinateOf(%q)=%q want %q", c.in, got, c.want)
			}
		})
	}
}

func TestCoordinateOf_UnknownUUID(t *testing.T) {
	blob := `{"activeSession":"s","sessions":[{"id":"s","name":"x","focusedRegion":"r","layout":{"type":"region","id":"r","activeTab":"t","tabs":[{"id":"t","name":"a","paneId":"1"}]}}]}`
	m := newManagerWithBlob(t, liveSet{"1": {}}, blob)
	if _, err := m.CoordinateOf("ffffffff-ffff-7fff-bfff-ffffffffffff"); err == nil {
		t.Errorf("expected error for unknown uuid")
	}
}

// NFR-UID-0: uuid 입력이 인덱스에 없으면 친절한 오류, 기존 label 경로는 무회귀.
func TestResolve_UUIDNotFoundIsDistinctError(t *testing.T) {
	blob := `{"activeSession":"s","sessions":[{"id":"s","name":"x","focusedRegion":"r","layout":{"type":"region","id":"r","activeTab":"t","tabs":[{"id":"t","name":"a","paneId":"1"}]}}]}`
	m := newManagerWithBlob(t, liveSet{"1": {}}, blob)
	bogus := "ffffffff-ffff-7fff-bfff-ffffffffffff"
	_, err := m.Resolve(bogus)
	if err == nil {
		t.Fatalf("expected error for unknown uuid")
	}
	if !strings.Contains(err.Error(), bogus) {
		t.Errorf("error should mention input: %v", err)
	}
}
