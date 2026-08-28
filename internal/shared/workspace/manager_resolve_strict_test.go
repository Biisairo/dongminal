package workspace

import (
	"errors"
	"strings"
	"testing"
)

// ORCHESTRATION_V2_SRS 묶음 I — 접합면은 uuid 만 받는다 (FR-IDU-1~3).
// 검증 표 V-IDU-1·3·6·7 의 단위 절반이며, HTTP 절반은
// internal/webserver/httpapi/handlers_toolio_test.go 에 있다.

// V-IDU-2 단위: 살아있는 toolId 와 엔터티 uuid 는 Resolve 와 똑같이 해석된다.
func TestResolveStrict_AcceptsToolIDAndUUID(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{uToolID: {}}, blobWithTool(uToolID))

	for _, c := range []struct{ name, input string }{
		{"살아있는 toolId", uToolID},
		{"탭 uuid", uTab},
		{"대문자 uuid", strings.ToUpper(uTab)},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := m.ResolveStrict(c.input)
			if err != nil {
				t.Fatalf("ResolveStrict(%q): %v", c.input, err)
			}
			if got != uToolID {
				t.Errorf("ResolveStrict(%q)=%q want %q", c.input, got, uToolID)
			}
		})
	}
}

// V-IDU-1/3 단위 (FR-IDU-2): 라벨 형태는 다른 실패와 구분되는 전용 진단으로 거절된다.
func TestResolveStrict_RejectsCoordinateLabel(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{uToolID: {}}, blobWithTool(uToolID))

	// Resolve 가 실제로 해석해 주는 라벨이라야 "좁히는 변경"임이 드러난다.
	if pid, err := m.Resolve("W1.P1.T1"); err != nil || pid != uToolID {
		t.Fatalf("전제 실패: Resolve(W1.P1.T1)=%q err=%v", pid, err)
	}

	for _, input := range []string{"W1.P1.T1", "w1.p1.t1", "W1.p1.T1", "W12.P3.T45"} {
		t.Run(input, func(t *testing.T) {
			got, err := m.ResolveStrict(input)
			if err == nil {
				t.Fatalf("ResolveStrict(%q)=%q, 거절을 기대했다", input, got)
			}
			if !errors.Is(err, ErrLabelIdentifier) {
				t.Fatalf("err=%v, ErrLabelIdentifier 로 갈리지 않는다", err)
			}
			for _, want := range []string{
				"좌표 라벨(" + input + ")은 이 명령에서 쓸 수 없다 — uuid 를 쓴다.",
				"라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다.",
				"uuid 는 `dmctl list-workspace` 의 uuid= 컬럼",
			} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("진단에 %q 가 없다:\n%s", want, err.Error())
				}
			}
		})
	}
}

// FR-IDU-3: 라벨 형태가 아닌 실패는 Resolve 와 같은 문안을 유지하고,
// ErrLabelIdentifier 로 갈리지 않는다 (호출자가 400 과 404 를 가르는 근거).
func TestResolveStrict_NonLabelFailuresUnchanged(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{}, blobWithTool(uToolID))

	for _, c := range []struct{ name, input, want string }{
		{"죽은 toolId", uToolID, "toolId=" + uToolID + " 존재하지 않음"},
		{"인덱스에 없는 uuid", "550e8400-e29b-41d4-a716-4466554400ff", "id 해석 실패"},
		{"아무 문자열", "nope", "id 해석 실패"},
		{"좌표", "4.1.1", "id 해석 실패"},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := m.ResolveStrict(c.input)
			if err == nil {
				t.Fatal("에러를 기대했다")
			}
			if errors.Is(err, ErrLabelIdentifier) {
				t.Fatalf("라벨 진단으로 갈렸다: %v", err)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Errorf("err=%q want contains %q", err.Error(), c.want)
			}
			if resolveErr := resolveFailure(t, m, c.input); resolveErr != err.Error() {
				t.Errorf("Resolve 와 문안이 갈렸다:\nstrict=%q\nresolve=%q", err.Error(), resolveErr)
			}
		})
	}

	if _, err := m.ResolveStrict("   "); err == nil {
		t.Error("빈 입력이 에러가 아니다")
	}
}

// FR-IDU-2 의 단서: 형태 판정은 오류 메시지를 고르는 데에만 쓴다. 라벨과 같은
// 문자열의 살아있는 toolId 는 조회가 먼저 이기므로 해석된다 (FR-UNI-10 보존).
func TestResolveStrict_LookupBeatsShape(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{"W1.P1.T1": {}}, blobWithTool("W1.P1.T1"))

	got, err := m.ResolveStrict("W1.P1.T1")
	if err != nil {
		t.Fatalf("살아있는 toolId 가 형태 때문에 거절됐다: %v", err)
	}
	if got != "W1.P1.T1" {
		t.Errorf("ResolveStrict=%q want W1.P1.T1", got)
	}
}

// V-IDU-7: Resolve 의 3단계는 그대로다 — 레이아웃·호환 경로가 딛고 있다.
func TestResolve_LabelStageSurvives(t *testing.T) {
	m := newManagerWithBlob(t, liveSet{legacyID: {}}, blobWithTool(legacyID))

	for _, input := range []string{legacyID, uTab, "W1.P1.T1", "w1.p1.t1"} {
		got, err := m.Resolve(input)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", input, err)
		}
		if got != legacyID {
			t.Errorf("Resolve(%q)=%q want %q", input, got, legacyID)
		}
	}
}

// resolveFailure 는 같은 입력에 대한 Resolve 의 실패 문안을 돌려준다. 라벨이
// 아닌 입력은 두 함수의 문안이 같아야 한다 (FR-IDU-3).
func resolveFailure(t *testing.T, m *Manager, input string) string {
	t.Helper()
	_, err := m.Resolve(input)
	if err == nil {
		t.Fatalf("Resolve(%q) 가 성공했다 — 라벨이 아닌 입력은 두 함수가 같이 실패해야 한다", input)
	}
	return err.Error()
}
