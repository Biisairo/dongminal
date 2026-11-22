package httpapi

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// QUALITY_FLAKY_SRS FR-FLK-3 — 구독이 열리면 도구마다 지금의 전경 이름을 한 번 싣는다.
// 화면은 부팅 조회(`/api/state`)와 구독 사이에 바뀐 이름을 받을 길이 없었다.

// fgListHub 는 목록에 전경 이름을 싣는 도구 허브다.
type fgListHub struct {
	*fakePaneHub
	list  []toolhub.ToolInfo
	known bool
}

func (h *fgListHub) ListOK() ([]toolhub.ToolInfo, bool) { return h.list, h.known }

func fgSSEServer(t *testing.T, h *fgListHub) *httptest.Server {
	t.Helper()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub.NewCommandHub(), Tools: h})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// sseLines 는 n 줄의 `data:` 를 읽는다. 시한 안에 다 오지 않으면 읽은 것까지 돌려준다.
func sseLines(t *testing.T, url string, n int) []string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	out := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			if l := sc.Text(); strings.HasPrefix(l, "data: ") {
				out <- strings.TrimPrefix(l, "data: ")
			}
		}
		close(out)
	}()
	var got []string
	deadline := time.After(2 * time.Second)
	for len(got) < n {
		select {
		case l, ok := <-out:
			if !ok {
				return got
			}
			got = append(got, l)
		case <-deadline:
			return got
		}
	}
	return got
}

func TestSSE_ForegroundOnConnect(t *testing.T) {
	h := &fgListHub{fakePaneHub: newFakePaneHub(), known: true, list: []toolhub.ToolInfo{
		{ID: "t1", FgName: "~"},
		{ID: "t2", FgName: ""},
	}}
	ts := fgSSEServer(t, h)
	got := sseLines(t, ts.URL+"/api/commands/sse", 3)
	if len(got) != 3 || !strings.Contains(got[0], `"server_hello"`) {
		t.Fatalf("인사 뒤에 도구마다 전경 이름이 와야 한다: %q", got)
	}
	want := map[string]bool{
		`{"action":"tool_foreground","args":{"name":"~","toolId":"t1"}}`: true,
		`{"action":"tool_foreground","args":{"name":"","toolId":"t2"}}`:  true,
	}
	for _, l := range got[1:] {
		if !want[l] {
			t.Fatalf("뜻밖의 줄 %q (전체 %q)", l, got)
		}
		delete(want, l)
	}
}

// 목록을 모르면 아무것도 싣지 않는다 — 모르는 목록의 빈 이름이 화면의 이름을 지우면 안 된다.
func TestSSE_ForegroundOnConnect_UnknownList(t *testing.T) {
	h := &fgListHub{fakePaneHub: newFakePaneHub(), known: false}
	ts := fgSSEServer(t, h)
	if got := sseLines(t, ts.URL+"/api/commands/sse", 2); len(got) != 1 {
		t.Fatalf("모르는 목록인데 인사 말고 %d 줄이 왔다: %q", len(got)-1, got)
	}
}

// 칸 구독(presence)은 방송을 받지 않으므로 이름도 싣지 않는다 (FR-OPT-4-12).
func TestSSE_ForegroundOnConnect_PresenceSkips(t *testing.T) {
	h := &fgListHub{fakePaneHub: newFakePaneHub(), known: true, list: []toolhub.ToolInfo{{ID: "t1", FgName: "~"}}}
	ts := fgSSEServer(t, h)
	if got := sseLines(t, ts.URL+"/api/commands/sse?presence=1", 2); len(got) != 1 {
		t.Fatalf("칸 구독에 인사 말고 %d 줄이 왔다: %q", len(got)-1, got)
	}
}
