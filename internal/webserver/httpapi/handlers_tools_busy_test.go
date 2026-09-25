package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-4 — GET /api/tools/busy?ids= 일괄 종단 (HTTP-M1).

func busyBatch(t *testing.T, hub *fakePaneHub, query string) (int, string) {
	t.Helper()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp := mustGet(t, ts.URL+"/api/tools/busy"+query)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, strings.TrimSpace(string(body))
}

// 도구 N개: HTTP N번·데몬 RPC N번 → HTTP 1번·BusyMany 1번.
func TestToolsBusyBatch(t *testing.T) {
	hub := newFakePaneHub()
	hub.seed("p1", "a")
	hub.seed("p2", "b")
	hub.setBusy("p2", true)
	code, body := busyBatch(t, hub, "?ids=p1,p2,gone")
	if code != http.StatusOK || body != `{"busy":{"gone":false,"p1":false,"p2":true}}` {
		t.Fatalf("status=%d body=%s", code, body)
	}
	if hub.busyManyCalls != 1 {
		t.Fatalf("BusyMany calls=%d want 1", hub.busyManyCalls)
	}
}

// ids 가 없거나 비면 빈 답이고 묻지 않는다. 빈 조각은 건너뛴다.
func TestToolsBusyBatchEmpty(t *testing.T) {
	for _, q := range []string{"", "?ids=", "?ids=,,"} {
		hub := newFakePaneHub()
		code, body := busyBatch(t, hub, q)
		if code != http.StatusOK || body != `{"busy":{}}` {
			t.Fatalf("%q: status=%d body=%s", q, code, body)
		}
		if hub.busyManyCalls != 0 {
			t.Fatalf("%q: 빈 ids 로 %d번 물었다", q, hub.busyManyCalls)
		}
	}
}

// 모르는 답(데몬 RPC 오류)을 "바쁘지 않음" 으로 내지 않는다 (IPC-M2).
func TestToolsBusyBatchUnknown(t *testing.T) {
	hub := newFakePaneHub()
	hub.busyUnknown = true
	if code, body := busyBatch(t, hub, "?ids=p1"); code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s want 503", code, body)
	}
}

// 상한을 넘는 ids 는 400 이다.
func TestToolsBusyBatchTooMany(t *testing.T) {
	ids := make([]string, maxBusyIDs+1)
	for i := range ids {
		ids[i] = "x"
	}
	hub := newFakePaneHub()
	if code, _ := busyBatch(t, hub, "?ids="+strings.Join(ids, ",")); code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", code)
	}
	if hub.busyManyCalls != 0 {
		t.Fatalf("상한을 넘었는데 %d번 물었다", hub.busyManyCalls)
	}
}

// 단건 종단은 그대로다 — /api/tools/busy 가 id "busy" 의 단건으로 읽히지 않는다.
func TestToolsBusySingleUnchanged(t *testing.T) {
	hub := newFakePaneHub()
	hub.seed("busy", "x")
	hub.setBusy("busy", true)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp := mustGet(t, ts.URL+"/api/tools/busy/busy")
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if strings.TrimSpace(string(body)) != `{"busy":true}` {
		t.Fatalf("body=%s", body)
	}
}

// waitToolsIdle 는 틱마다 도구 수만큼이 아니라 BusyMany 한 번을 부른다 (HTTP-2).
func TestWaitToolsIdleOneProbePerTick(t *testing.T) {
	hub := newFakePaneHub()
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	srv.waitToolsIdle(context.Background(), []string{"a", "b", "c"})
	if hub.busyManyCalls != 1 {
		t.Fatalf("BusyMany calls=%d want 1", hub.busyManyCalls)
	}
}

// 모르는 답은 "셸로 돌아왔다" 가 아니다 — 기다림을 이어간다 (IPC-M2).
func TestWaitToolsIdleUnknownKeepsWaiting(t *testing.T) {
	hub := newFakePaneHub()
	hub.busyUnknown = true
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: hub})
	ctx, cancel := context.WithTimeout(context.Background(), 3*exitPollInterval)
	defer cancel()
	srv.waitToolsIdle(ctx, []string{"a"})
	if hub.busyManyCalls < 2 {
		t.Fatalf("BusyMany calls=%d — 모르는 답에 기다림을 멈췄다", hub.busyManyCalls)
	}
}
