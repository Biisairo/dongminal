package workspace

import "testing"

// WORKSPACE_IDENTITY_SRS §4 묶음 U — 해석은 형태가 아니라 조회 결과로 판별한다
// (FR-UNI-10~13).
//
// 이전: Resolve 가 strconv.Atoi(id) 성공을 "toolId 다"의 근거로 썼고, CoordinateOf 는
// UUID 형식인데 탭 uuid 인덱스에 없으면 stale 로 판정했다. toolId 가 uuid 가 되면
// 살아있는 도구가 두 곳 모두에서 거절된다 (SRS §2.7).

const (
	uWindow  = "550e8400-e29b-41d4-a716-4466554400a1"
	uPane    = "550e8400-e29b-41d4-a716-4466554400a2"
	uTab     = "550e8400-e29b-41d4-a716-4466554400a3"
	uToolID  = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f" // uuid 형식 toolId
	legacyID = "267"                                  // 구 정수 toolId
)

func blobWithTool(toolID string) string {
	return `{"activeWindow":"` + uWindow + `","schemaVersion":2,"windows":[{"id":"` + uWindow +
		`","name":"Main","focusedPane":"` + uPane + `","layout":{"type":"pane","id":"` + uPane +
		`","activeTab":"` + uTab + `","tabs":[{"id":"` + uTab + `","name":"Shell","toolId":"` + toolID + `"}]}}]}`
}

// TC-UNI-9: uuid 형식 toolId 를 Resolve 가 그대로 해석한다.
func TestResolve_UUIDFormToolID(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{uToolID: {}}, blobWithTool(uToolID))

	got, err := m.Resolve(uToolID)
	if err != nil {
		t.Fatalf("Resolve(uuid toolId): %v", err)
	}
	if got != uToolID {
		t.Errorf("Resolve=%q want %q", got, uToolID)
	}
}

// TC-UNI-10: 구 정수 toolId·탭 uuid·좌표 라벨의 해석 결과가 전환 전과 같다.
func TestResolve_LegacyInputsUnchanged(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{legacyID: {}}, blobWithTool(legacyID))

	for _, c := range []struct{ name, input string }{
		{"구 정수 toolId", legacyID},
		{"탭 uuid", uTab},
		{"좌표 라벨", "W1.P1.T1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := m.Resolve(c.input)
			if err != nil {
				t.Fatalf("Resolve(%q): %v", c.input, err)
			}
			if got != legacyID {
				t.Errorf("Resolve(%q)=%q want %q", c.input, got, legacyID)
			}
		})
	}

	if _, err := m.Resolve(""); err == nil {
		t.Error("빈 입력이 에러가 아니다")
	}
}

// TC-UNI-11: 죽은 toolId 와 인덱스에 없는 uuid 는 각각 에러다.
func TestResolve_DeadAndUnknown(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{}, blobWithTool(uToolID))

	for _, c := range []struct{ name, input string }{
		{"죽은 uuid toolId", uToolID},
		{"죽은 구 정수 toolId", legacyID},
		{"인덱스에 없는 uuid", "550e8400-e29b-41d4-a716-4466554400ff"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got, err := m.Resolve(c.input); err == nil {
				t.Errorf("Resolve(%q)=%q, 에러를 기대했다", c.input, got)
			}
		})
	}
}

// TC-UNI-12: 살아있는 uuid toolId 는 CoordinateOf 를 pass-through 한다.
func TestCoordinateOf_UUIDFormToolIDPassesThrough(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{uToolID: {}}, blobWithTool(uToolID))

	got, err := m.CoordinateOf(uToolID)
	if err != nil {
		t.Fatalf("CoordinateOf(uuid toolId): %v", err)
	}
	if got != uToolID {
		t.Errorf("CoordinateOf=%q want pass-through %q", got, uToolID)
	}
}

// TC-UNI-13: 탭 uuid·좌표·구 정수 toolId·빈 값의 CoordinateOf 결과가 전환 전과 같다.
func TestCoordinateOf_LegacyInputsUnchanged(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{legacyID: {}}, blobWithTool(legacyID))

	got, err := m.CoordinateOf(uTab)
	if err != nil {
		t.Fatalf("CoordinateOf(탭 uuid): %v", err)
	}
	if got != "W1.P1.T1" {
		t.Errorf("CoordinateOf(탭 uuid)=%q want %q", got, "W1.P1.T1")
	}

	for _, c := range []struct{ name, input string }{
		{"좌표", "W1.P1.T1"},
		{"구 정수 toolId", legacyID},
		{"빈 값", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := m.CoordinateOf(c.input)
			if err != nil {
				t.Fatalf("CoordinateOf(%q): %v", c.input, err)
			}
			if got != c.input {
				t.Errorf("CoordinateOf(%q)=%q want pass-through", c.input, got)
			}
		})
	}

	if _, err := m.CoordinateOf("550e8400-e29b-41d4-a716-4466554400ff"); err == nil {
		t.Error("인덱스에 없는 uuid 가 에러가 아니다 (FR-UNI-11 3번)")
	}
}
