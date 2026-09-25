package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http/httptest"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-4-5 (IPC-6 · FEC-10 · FEC-11): 구독이 열릴 때의 복원을
// 요청 하나로 받는다. 조각은 **그 종단의 본문 그대로**다 — 받는 쪽의 복원 함수가 한 벌로
// 남는다. 200 이 아닌 조각과 모르는 이름은 싣지 않는다.
func TestSnapshot_PartsAreEndpointBodies(t *testing.T) {
	fs := &fakeSettingsStore{blob: []byte(`{"pageTitle":"<a&b>","n":1.5,"k":"한글"}`)}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Settings: fs})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := func(path string) (int, []byte) {
		resp := mustGet(t, ts.URL+path)
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, b
	}
	code, raw := body("/api/snapshot?parts=attention,activity,background,settings,update,focus,bogus")
	if code != 200 {
		t.Fatalf("status=%d body=%s", code, raw)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	want := map[string]string{
		"attention":  "/api/tools/attention",
		"activity":   "/api/tools/activity",
		"background": "/api/tools/background",
		"settings":   "/api/settings",
		"focus":      "/api/focus",
	}
	for part, path := range want {
		c, b := body(path)
		if c != 200 {
			t.Fatalf("%s status=%d", path, c)
		}
		var exp bytes.Buffer
		if err := json.Compact(&exp, b); err != nil {
			t.Fatal(err)
		}
		if string(got[part]) != exp.String() {
			t.Errorf("%s = %s, want %s", part, got[part], exp.String())
		}
	}
	// 판 확인이 없는 서버의 /api/update 는 503 이다 — 조각이 없다.
	if _, ok := got["update"]; ok {
		t.Errorf("503 조각이 실렸다: %s", got["update"])
	}
	if _, ok := got["bogus"]; ok {
		t.Error("모르는 조각이 실렸다")
	}
	if len(got) != len(want) {
		t.Errorf("조각 %d, want %d: %s", len(got), len(want), raw)
	}
}

func TestSnapshot_NoPartsIsEmpty(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp := mustGet(t, ts.URL+"/api/snapshot")
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(bytes.TrimSpace(b)) != "{}" {
		t.Fatalf("status=%d body=%q", resp.StatusCode, b)
	}
}
