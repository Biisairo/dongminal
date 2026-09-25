package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// M3 DoD — **디스크 쓰기가 실패하면 `PUT /api/settings` 가 500 이다.**
//
// 종전에는 `save()` 가 오류를 로그로 삼켰고 핸들러는 언제나 200 을 돌려줬다.
// 사용자는 설정이 바뀐 줄 알고 다음 기동에서 옛 값을 만난다 — `FE-7` 의 서버 쪽
// 짝이며, 클라이언트가 `res.ok` 를 보게 된 지금 그 값이 진실이어야 한다.

func TestSettingsPutReportsWriteFailure(t *testing.T) {
	dir := t.TempDir()
	// 쓰기가 반드시 실패하도록 자리를 **디렉터리**로 막는다.
	p := filepath.Join(dir, "settings.json")
	if err := os.Mkdir(p, 0o755); err != nil {
		t.Fatal(err)
	}
	s := &Server{Deps: Deps{Settings: newSettingsStore(p)}}

	rec := httptest.NewRecorder()
	s.apiSettingsPut(rec, apiTestRequest(http.MethodPut, "/api/settings",
		strings.NewReader(`{"a":1}`)))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500 — 쓰지 못했는데 성공이라 답했다", rec.Code)
	}
}

// 정상 경로는 종전대로 200 이다 (회귀).
func TestSettingsPutStillOK(t *testing.T) {
	dir := t.TempDir()
	s := &Server{Deps: Deps{Settings: newSettingsStore(filepath.Join(dir, "settings.json"))}}

	rec := httptest.NewRecorder()
	s.apiSettingsPut(rec, apiTestRequest(http.MethodPut, "/api/settings",
		strings.NewReader(`{"a":1}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d want 200", rec.Code)
	}
}

// OPTIMIZE_REFACTOR_SRS FR-OPT-5-2 (FEC-M3): PUT 이 `?clientId=` 를 실으면 방송의
// `args.origin` 에 그 값이 실린다. 보낸 창이 자기 방송의 GET 을 건너뛰는 근거다.
// 싣지 않으면(옛 클라이언트) 방송 바이트는 종전과 같다 (FR-OPT-0-3).
func TestSettingsPutBroadcastOrigin(t *testing.T) {
	cases := []struct {
		name, target, want string
	}{
		{"with-client", "/api/settings?clientId=c-1", `{"action":"settings_changed","args":{"origin":"c-1"}}`},
		{"legacy", "/api/settings", `{"action":"settings_changed","args":{}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cb := &fakeCommandBroker{}
			s := &Server{Deps: Deps{
				Settings: newSettingsStore(filepath.Join(t.TempDir(), "settings.json")),
				Commands: cb,
			}}
			rec := httptest.NewRecorder()
			s.apiSettingsPut(rec, apiTestRequest(http.MethodPut, tc.target, strings.NewReader(`{"a":1}`)))
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d", rec.Code)
			}
			if len(cb.published) != 1 || string(cb.published[0]) != tc.want {
				t.Fatalf("published=%q want %s", cb.published, tc.want)
			}
		})
	}
}
