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

func (m *memPersister) Read() ([]byte, error)  { return append([]byte(nil), m.data...), nil }
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
	resp, err := http.Post(ts.URL+"/api/commands", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
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

	// 4단계: 이전 라벨 S2 로 호출 → 에러 (S2 가 더 이상 존재하지 않음).
	resp, err := http.Post(ts.URL+"/api/commands", "application/json",
		strings.NewReader(`{"action":"focus","args":{"location":"S2.P1.T1"}}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	// label 은 CoordinateOf 의 non-UUID 분기로 pass-through 되어 broadcast 됨.
	// 브라우저는 S2 좌표를 받아 무시하거나 노옵 (broadcast 자체는 성공).
	// 핵심은: uuid 는 stable, label 은 stale 가능 — 이 테스트가 양쪽을
	// 명확히 분리해 보여준다.
	if resp.StatusCode != 200 {
		t.Errorf("label pass-through should not error at /api/commands: status=%d", resp.StatusCode)
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
