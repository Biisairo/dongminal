package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/hub"
)

// SERVER_DRIVEN_ACTIONS_SRS 묶음 F-4 (FR-SDA-54): 창·탭·그룹 이름의 길이 상한은 서버가 정하고,
// dmctl 이 지나는 `/api/commands` 에서 거절한다. workspace 저장은 막지 않는다(사용자 결정).

func TestEntityNameAnswer(t *testing.T) {
	cases := []struct {
		name string
		ok   bool
	}{
		{strings.Repeat("a", entityNameMax), true},
		{strings.Repeat("a", entityNameMax+1), false},
		{strings.Repeat("가", entityNameMax), true},
		// 화면의 `slice` 와 같은 단위(UTF-16)로 센다 — 이모지 하나는 둘이다.
		{strings.Repeat("😀", entityNameMax/2), true},
		{strings.Repeat("😀", entityNameMax/2+1), false},
		{"", true},
	}
	for _, c := range cases {
		a := entityNameAnswer(c.name)
		if a.OK != c.ok {
			t.Errorf("entityNameAnswer(len=%d) = %+v, want ok=%v", len(c.name), a, c.ok)
			continue
		}
		if !a.OK {
			if a.Why != apierr.CodeNameTooLong || a.Status != http.StatusBadRequest || a.Args["max"] != entityNameMax {
				t.Errorf("deny = %+v", a)
			}
			if !action.Catalog.MayGive(action.EntityName, a.Why) {
				t.Errorf("%s 의 사유 %s 가 action.Catalog 에 없다", action.EntityName, a.Why)
			}
		}
	}
}

func TestCommandPostRejectsLongName(t *testing.T) {
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub.NewCommandHub(), Work: newFakeWorkspaceStore()})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	post := func(action, name string) *http.Response {
		t.Helper()
		args, _ := json.Marshal(map[string]any{"name": name})
		body := `{"action":"` + action + `","args":` + string(args) + `}`
		resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp
	}
	long := strings.Repeat("x", entityNameMax+1)
	for _, a := range []string{"newWindow", "newTab", "renameTab", "renameWindow", "newGroup", "renameGroup", "openEditorTab"} {
		resp := post(a, long)
		if resp.StatusCode != http.StatusBadRequest || resp.Header.Get(apierr.CodeHeader) != apierr.CodeNameTooLong {
			t.Errorf("%s: status=%d code=%q, want 400 name_too_long", a, resp.StatusCode, resp.Header.Get(apierr.CodeHeader))
		}
	}
	if resp := post("renameTab", strings.Repeat("x", entityNameMax)); resp.StatusCode == http.StatusBadRequest {
		t.Errorf("상한 길이의 이름이 거절됐다: %d", resp.StatusCode)
	}
}

func TestMetaEndpoint(t *testing.T) {
	s, _, _ := fsTestServer(t)
	code, out := fsReq(t, s, http.MethodGet, "/api/meta", "")
	if code != http.StatusOK || out["entityNameMax"] != float64(entityNameMax) {
		t.Fatalf("code=%d body=%v", code, out)
	}
}
