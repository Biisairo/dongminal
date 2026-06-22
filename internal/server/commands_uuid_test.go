package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/workspace"
)

type liveSet map[string]struct{}

func (l liveSet) IsLive(paneID string) bool {
	_, ok := l[paneID]
	return ok
}

type memPersister struct{ data []byte }

func (m *memPersister) Read() ([]byte, error)   { return append([]byte(nil), m.data...), nil }
func (m *memPersister) Write(data []byte) error { m.data = append([]byte(nil), data...); return nil }

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

// FR-DMC-9 (정책 강화): 좌표는 더 이상 pass-through 되지 않고 400 거부.
// uuid 만 받는다. (이전 NFR-UID-0 의 coordinate pass-through 는 의도적으로 폐기)
func TestHandleCommandPost_CoordinateRejected(t *testing.T) {
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	sub := hub.add()
	defer hub.remove(sub)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"action":"focus","args":{"location":"S4.P1.T1"}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("status=%d want 400 (coordinate must be rejected)", resp.StatusCode)
	}
	select {
	case <-sub.ch:
		t.Fatal("coordinate input should not have been broadcast")
	default:
	}
}

// 풀스택 회귀 — 실제 workspace.Manager 와 함께 /api/commands 가 uuid 를
// 받아 좌표로 변환해 broadcast 함을 검증. 라벨 reflow 후에도 uuid 가 같은
// pane 을 가리키는 점도 한 테스트로 묶어 확인 (TC-UID-2 풀스택).
func TestHandleCommandPost_FullStackUUID_ReflowSafety(t *testing.T) {
	tabA := "550e8400-e29b-41d4-a716-446655440aaa"
	tabB := "550e8400-e29b-41d4-a716-446655440bbb"
	blob1 := `{"activeSession":"sa","sessions":[
		{"id":"sa","name":"A","focusedRegion":"ra","layout":{"type":"region","id":"ra","activeTab":"` + tabA + `","tabs":[{"id":"` + tabA + `","name":"a","paneId":"10"}]}},
		{"id":"sb","name":"B","focusedRegion":"rb","layout":{"type":"region","id":"rb","activeTab":"` + tabB + `","tabs":[{"id":"` + tabB + `","name":"b","paneId":"20"}]}}
	]}`
	ws, err := workspace.New(liveSet{"10": {}, "20": {}}, &memPersister{})
	if err != nil {
		t.Fatalf("workspace.New: %v", err)
	}
	defer ws.Close()
	if _, err := ws.Save([]byte(blob1), ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	hub := NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	sub := hub.add()
	defer hub.remove(sub)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// 1단계: B 의 uuid 로 focus → broadcast 페이로드의 location 이 S2.P1.T1.
	post := func(body string) []byte {
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
		case p := <-sub.ch:
			return p
		default:
			t.Fatal("no broadcast")
			return nil
		}
	}
	payload := post(`{"action":"focus","args":{"location":"` + tabB + `"}}`)
	if !strings.Contains(string(payload), `"location":"S2.P1.T1"`) {
		t.Errorf("uuid B should resolve to S2.P1.T1, got: %s", payload)
	}

	// 2단계: 세션 A 종료. B 의 라벨이 S2 → S1 로 reflow.
	blob2 := `{"activeSession":"sb","sessions":[
		{"id":"sb","name":"B","focusedRegion":"rb","layout":{"type":"region","id":"rb","activeTab":"` + tabB + `","tabs":[{"id":"` + tabB + `","name":"b","paneId":"20"}]}}
	]}`
	if _, err := ws.Save([]byte(blob2), "1"); err != nil {
		t.Fatalf("Save reflow: %v", err)
	}

	// 3단계: 같은 uuid 로 focus → 이제 S1.P1.T1 (라벨 reflow 후) 가리킴.
	payload = post(`{"action":"focus","args":{"location":"` + tabB + `"}}`)
	if !strings.Contains(string(payload), `"location":"S1.P1.T1"`) {
		t.Errorf("after reflow, uuid B should now resolve to S1.P1.T1, got: %s", payload)
	}

	// 4단계: 라벨 형식 입력은 FR-DMC-9 로 거부. uuid 만 허용 정책의 핵심.
	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"focus","args":{"location":"S2.P1.T1"}}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 {
		t.Errorf("label input must be rejected (FR-DMC-9): status=%d", resp.StatusCode)
	}
}

// TC-DMC-5/8: uuid 변환 시 /api/commands 응답에 action/location/requestedLocation
// 신규 필드 노출 + 기존 ok/delivered 무변화 (NFR-DMC-0).
func TestHandleCommandPost_ResponseExposesTranslation(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	ws.coordMap = map[string]string{uuid: "S2.P1.T1"}

	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
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
	respBody, _ := io.ReadAll(resp.Body)
	var got map[string]any
	if err := json.Unmarshal(respBody, &got); err != nil {
		t.Fatalf("unmarshal: %v body=%s", err, respBody)
	}
	if got["ok"] != true {
		t.Errorf("ok=%v want true", got["ok"])
	}
	if _, isFloat := got["delivered"].(float64); !isFloat {
		t.Errorf("delivered missing/not number: %v", got["delivered"])
	}
	if got["action"] != "focus" {
		t.Errorf("action=%v want focus", got["action"])
	}
	if got["location"] != "S2.P1.T1" {
		t.Errorf("location=%v want S2.P1.T1", got["location"])
	}
	if got["requestedLocation"] != uuid {
		t.Errorf("requestedLocation=%v want %q", got["requestedLocation"], uuid)
	}
}

// TC-DMC-13 (FR-DMC-9): 좌표 입력은 400 거부, broadcast 없음.
func TestHandleCommandPost_ResponseCoordinateRejected(t *testing.T) {
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	sub := hub.add()
	defer hub.remove(sub)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	for _, badLoc := range []string{"S4.P1.T1", "4.1.1", "303"} {
		body := `{"action":"focus","args":{"location":"` + badLoc + `"}}`
		resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST(%s): %v", badLoc, err)
		}
		respBody, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Errorf("loc=%q status=%d body=%s want 400", badLoc, resp.StatusCode, respBody)
		}
	}
	select {
	case <-sub.ch:
		t.Fatal("rejected inputs should not be broadcast")
	default:
	}
}

// TC-DMC-7: location 없는 액션은 빈 문자열로 채움.
func TestHandleCommandPost_ResponseNoLocation(t *testing.T) {
	hub := NewCommandHub()
	ws := newFakeWorkspaceStore()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub, Work: ws})
	sub := hub.add()
	defer hub.remove(sub)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"action":"newSession","args":{}}`
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	var got map[string]any
	if err := json.Unmarshal(respBody, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := got["location"]; !ok {
		t.Errorf("location key missing (should be present as empty string): %s", respBody)
	}
	if got["location"] != "" || got["requestedLocation"] != "" {
		t.Errorf("location=%v requestedLocation=%v want both empty", got["location"], got["requestedLocation"])
	}
	if got["action"] != "newSession" {
		t.Errorf("action=%v", got["action"])
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
