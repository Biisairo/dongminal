package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/hub"
)

// TAB_NAME_DELIVERY_SRS 묶음 S.

func postRenameCommand(t *testing.T, action, uuid string, known bool) (*http.Response, map[string]any, *hub.CmdSub, func()) {
	t.Helper()
	cmdHub := hub.NewCommandHub()
	ws := newFakeWorkspaceStore()
	if known {
		ws.coordMap = map[string]string{uuid: "W16.P1.T6"}
	}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: cmdHub, Work: ws})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	sub := cmdHub.Add()
	ts := httptest.NewServer(srv.Handler())
	body := `{"action":"` + action + `","args":{"location":` + testpath.JSONQuote(uuid) + `,"name":"ccr#32›91"}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	var out map[string]any
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	json.Unmarshal(b, &out)
	return resp, out, sub, func() { cmdHub.Remove(sub); ts.Close() }
}

// V-TND-1: renameTab·renameWindow 는 uuid 를 그대로 방송한다. 응답 location 은 좌표다.
func TestHandleCommandPost_RenameKeepsUUID(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-4466554400d1"
	for _, action := range []string{"renameTab", "renameWindow"} {
		t.Run(action, func(t *testing.T) {
			resp, out, sub, done := postRenameCommand(t, action, uuid, true)
			defer done()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status=%d", resp.StatusCode)
			}
			if out["location"] != "W16.P1.T6" || out["requestedLocation"] != uuid {
				t.Fatalf("응답 location=%v requestedLocation=%v", out["location"], out["requestedLocation"])
			}
			select {
			case payload := <-sub.Messages():
				var got struct {
					Args map[string]any `json:"args"`
				}
				if err := json.Unmarshal(payload, &got); err != nil {
					t.Fatalf("payload: %v", err)
				}
				if got.Args["location"] != uuid {
					t.Fatalf("방송 location=%v, uuid %q 여야 한다", got.Args["location"], uuid)
				}
			default:
				t.Fatal("방송이 없다")
			}
		})
	}
}

// V-TND-2: 모르는 uuid 는 종전대로 400 이고 방송하지 않는다.
func TestHandleCommandPost_RenameUnknownUUIDRejected(t *testing.T) {
	resp, _, sub, done := postRenameCommand(t, "renameTab", "550e8400-e29b-41d4-a716-4466554400d2", false)
	defer done()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", resp.StatusCode)
	}
	select {
	case <-sub.Messages():
		t.Fatal("모르는 uuid 를 방송했다")
	default:
	}
}
