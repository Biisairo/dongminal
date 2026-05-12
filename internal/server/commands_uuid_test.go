package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// FR-UID-12 / dmctl: /api/commands 가 args.location 에 uuid 가 오면 좌표로
// 번역한 뒤 broadcast 한다. coordinate 형식 (`4.1.1` / `S4.P1.T1`) 은 그대로
// 통과한다 (NFR-UID-0 행위 보존).
func TestHandleCommandPost_TranslatesUUIDLocation(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	ws.coordMap = map[string]string{uuid: "S2.P1.T1"}

	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// SSE 구독자 추가 — broadcast 결과를 받기 위함.
	sub := hub.add()
	defer hub.remove(sub)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"action":"focus","args":{"location":"` + uuid + `"}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status=%d body=%s", resp.StatusCode, b)
	}

	select {
	case payload := <-sub.ch:
		var got struct {
			Action string          `json:"action"`
			Args   json.RawMessage `json:"args"`
		}
		if err := json.Unmarshal(payload, &got); err != nil {
			t.Fatalf("payload unmarshal: %v (raw=%s)", err, payload)
		}
		var args map[string]any
		if err := json.Unmarshal(got.Args, &args); err != nil {
			t.Fatalf("args unmarshal: %v (raw=%s)", err, got.Args)
		}
		if args["location"] != "S2.P1.T1" {
			t.Errorf("location=%v want %q (uuid should be translated)", args["location"], "S2.P1.T1")
		}
	default:
		t.Fatal("no broadcast received")
	}
}

// NFR-UID-0: coordinate 가 들어오면 그대로 통과.
func TestHandleCommandPost_CoordinatePassThrough(t *testing.T) {
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	sub := hub.add()
	defer hub.remove(sub)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"action":"focus","args":{"location":"S4.P1.T1"}}`
	resp, _ := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	defer resp.Body.Close()

	select {
	case payload := <-sub.ch:
		if !strings.Contains(string(payload), `"location":"S4.P1.T1"`) {
			t.Errorf("coordinate should pass through unchanged: %s", payload)
		}
	default:
		t.Fatal("no broadcast received")
	}
}

func TestHandleCommandPost_UnknownUUIDReturns400(t *testing.T) {
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	uuid := "ffffffff-ffff-7fff-bfff-ffffffffffff"
	ws.coordErr = map[string]error{uuid: errors.New("unknown uuid")}

	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"action":"focus","args":{"location":"` + uuid + `"}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("status=%d want 400 for unknown uuid", resp.StatusCode)
	}
}
