package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// VERSION_HEALTH_SRS 묶음 H — `GET /api/health` (V-VHL-5~8).
//
// 지금 이 인스턴스에 **무엇이 어긋나 있는가** 를 한 번에 답하는 자리다. 생존만
// 묻는 `/api/ping` 과 다르다 — M3 의 나머지(손상 감지·백업 복원)가 사실을 실어
// 보낼 자리가 여기다.

func getHealth(t *testing.T, s *Server) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.apiHealth(rec, apiTestRequest(http.MethodGet, "/api/health", nil))
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("헬스 응답이 JSON 이 아니다: %q (%v)", rec.Body.String(), err)
	}
	return rec.Code, m
}

// V-VHL-5: 필드가 선다.
func TestHealthShape(t *testing.T) {
	m, mHub := daemonPairAt(t, "")
	t.Cleanup(m.StopSaving)
	m.Adopt(&toolhub.Tool{ID: "1"})
	s := &Server{Deps: Deps{Tools: mHub, Work: newFakeWorkspaceStore()}}

	code, body := getHealth(t, s)
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200", code)
	}
	for _, k := range []string{"version", "uptime", "daemon", "workspace", "tools"} {
		if _, ok := body[k]; !ok {
			t.Errorf("헬스에 %q 가 없다 (FR-VHL-10)", k)
		}
	}
	if n, _ := body["tools"].(float64); n != 1 {
		t.Errorf("tools=%v want 1", body["tools"])
	}
	d, _ := body["daemon"].(map[string]any)
	if d == nil {
		t.Fatal("daemon 객체가 없다")
	}
	for _, k := range []string{"connected", "protocol", "build", "mismatch"} {
		if _, ok := d[k]; !ok {
			t.Errorf("daemon 에 %q 가 없다", k)
		}
	}
	if d["connected"] != true {
		t.Errorf("connected=%v — 데몬에 붙은 서버다", d["connected"])
	}
	if d["mismatch"] != false {
		t.Errorf("mismatch=%v — 데몬이 빌드를 말하지 않았다 (FR-VHL-11)", d["mismatch"])
	}
	ws, _ := body["workspace"].(map[string]any)
	if ws == nil {
		t.Fatal("workspace 객체가 없다")
	}
	if _, ok := ws["rev"]; !ok {
		t.Error("workspace.rev 가 없다")
	}
	// FR-VHL-10 / D-4: `lastPersistErr` 는 **자리만** 만든다. 채우는 것은 GO-10
	// 이며 M3 의 뒤 묶음이다 — 자리가 먼저 있어야 그때 한 줄로 끝난다.
	if _, ok := ws["lastPersistErr"]; !ok {
		t.Error("workspace.lastPersistErr 자리가 없다")
	}
}

// infoHub 는 데몬이 hello 에서 말한 판을 정해 둔 가짜 허브다.
type infoHub struct {
	*fakePaneHub
	info toolhub.DaemonInfo
}

func (h infoHub) DaemonInfo() toolhub.DaemonInfo { return h.info }

// V-VHL-6: 어긋남은 **양쪽 빌드를 알고 다를 때만**이다 (FR-VHL-11 · FR-CBG-5).
func TestHealthMismatch(t *testing.T) {
	cases := []struct {
		name, ours, theirs string
		want               bool
	}{
		{"같다", "v1", "v1", false},
		{"다르다", "v1", "v2", true},
		{"데몬이 판을 말하지 않는다", "v1", "", false},
		{"우리 판을 모른다", "", "v2", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := infoHub{fakePaneHub: newFakePaneHub(), info: toolhub.DaemonInfo{Build: tc.theirs}}
			s := &Server{cfg: Config{Version: tc.ours}, Deps: Deps{Tools: h}}
			_, body := getHealth(t, s)
			d := body["daemon"].(map[string]any)
			if d["mismatch"] != tc.want {
				t.Fatalf("mismatch=%v want %v", d["mismatch"], tc.want)
			}
		})
	}
}

// V-VHL-7: **어긋난 것이 있어도 200 이다** (FR-VHL-12).
//
// 503 으로 답하면 그 뒤의 필드를 아무도 읽지 않고 "왜" 가 사라진다. 생존 판정이
// 필요한 쪽은 `/api/ping` 을 그대로 쓴다.
func TestHealthAlwaysOK(t *testing.T) {
	s := &Server{Deps: Deps{}} // 아무것도 없는 서버 — 가장 나쁜 상태다
	code, _ := getHealth(t, s)
	if code != http.StatusOK {
		t.Fatalf("status=%d want 200 — 헬스는 상태 코드로 판정하지 않는다", code)
	}
}

// V-VHL-8: 몸통에 **경로·명령·자격이 없다** (FR-VHL-14).
//
// 카나리아다. 담는 것은 숫자와 판과 불리언뿐이며, 늘리는 사람이 무심코 경로를
// 실으면 여기서 걸린다.
func TestHealthCarriesNoSecrets(t *testing.T) {
	m, mHub := daemonPairAt(t, "")
	t.Cleanup(m.StopSaving)
	s := &Server{Deps: Deps{Tools: mHub, Work: newFakeWorkspaceStore()}}

	rec := httptest.NewRecorder()
	s.apiHealth(rec, apiTestRequest(http.MethodGet, "/api/health", nil))
	raw := rec.Body.String()
	for _, bad := range []string{"/Users/", "/home/", "C:\\", "token", "password", "secret"} {
		if strings.Contains(strings.ToLower(raw), strings.ToLower(bad)) {
			t.Fatalf("헬스 몸통에 %q 가 실렸다 (FR-VHL-14):\n%s", bad, raw)
		}
	}
}
