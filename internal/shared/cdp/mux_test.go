package cdp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeChrome 은 os.Pipe 대신 io.Pipe 로 선 가짜 피어다 (NFR-BRT-Q1). 받은 요청을
// 기록하고, reply 가 정한 대로 답한다.
type fakeChrome struct {
	t     *testing.T
	toMux *io.PipeWriter
	mux   *Mux
	mu    sync.Mutex
	got   []Message
	reply func(m Message) []Message
}

func newFake(t *testing.T, reply func(m Message) []Message) *fakeChrome {
	t.Helper()
	muxR, fakeW := io.Pipe() // Chrome → mux
	fakeR, muxW := io.Pipe() // mux → Chrome
	f := &fakeChrome{t: t, toMux: fakeW, reply: reply}
	f.mux = NewMux(muxW)
	go f.mux.Run(muxR)
	go func() {
		br := bufio.NewReader(fakeR)
		for {
			b, err := br.ReadBytes(0)
			if err != nil {
				return
			}
			var m Message
			json.Unmarshal(b[:len(b)-1], &m)
			f.mu.Lock()
			f.got = append(f.got, m)
			f.mu.Unlock()
			if f.reply != nil {
				for _, r := range f.reply(m) {
					f.emit(r)
				}
			}
		}
	}()
	t.Cleanup(func() { fakeW.Close(); muxW.Close() })
	return f
}

func (f *fakeChrome) emit(m Message) {
	b, _ := json.Marshal(m)
	f.toMux.Write(append(b, 0))
}

func (f *fakeChrome) methods() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.got {
		out = append(out, m.Method)
	}
	return out
}

func echo(m Message) []Message {
	return []Message{{ID: m.ID, Result: json.RawMessage(`{"method":"` + m.Method + `"}`)}}
}

// TC-BRT-5: NUL 구분·부분 읽기·큰 메시지(>1MiB 프레임).
func TestFramingLargeAndPartial(t *testing.T) {
	big := strings.Repeat("A", 3<<20)
	f := newFake(t, func(m Message) []Message {
		return []Message{{ID: m.ID, Result: json.RawMessage(`{"data":"` + big + `"}`)}}
	})
	c := NewClient(f.mux, nil)
	res, err := c.Call(context.Background(), "", "Page.captureScreenshot", nil)
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	var r struct{ Data string }
	json.Unmarshal(res, &r)
	if len(r.Data) != len(big) {
		t.Fatalf("큰 메시지가 잘렸다: %d", len(r.Data))
	}
}

func TestFramingPartialWrites(t *testing.T) {
	muxR, fakeW := io.Pipe()
	m := NewMux(io.Discard)
	got := make(chan *Message, 1)
	c := m.Open(ConnOptions{Sink: func(msg *Message) { got <- msg }})
	c.domains["Page"] = struct{}{}
	go m.Run(muxR)
	msg := []byte(`{"method":"Page.loadEventFired","params":{}}` + "\x00")
	for _, b := range msg {
		fakeW.Write([]byte{b}) // 한 바이트씩
	}
	select {
	case e := <-got:
		if e.Method != "Page.loadEventFired" {
			t.Fatalf("method=%q", e.Method)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("조각난 메시지를 잇지 못했다")
	}
	fakeW.Close()
}

// TC-BRT-20: 두 클라이언트가 같은 id 를 보내도 응답이 섞이지 않는다.
func TestMuxRenumbersIDs(t *testing.T) {
	f := newFake(t, echo)
	type rx struct {
		id     int64
		method string
	}
	a, b := make(chan rx, 1), make(chan rx, 1)
	ca := f.mux.Open(ConnOptions{Sink: func(m *Message) {
		var r struct{ Method string }
		json.Unmarshal(m.Result, &r)
		a <- rx{m.ID, r.Method}
	}})
	cb := f.mux.Open(ConnOptions{Sink: func(m *Message) {
		var r struct{ Method string }
		json.Unmarshal(m.Result, &r)
		b <- rx{m.ID, r.Method}
	}})
	ca.Send(&Message{ID: 1, Method: "A.one"})
	cb.Send(&Message{ID: 1, Method: "B.one"})
	ga, gb := <-a, <-b
	if ga.id != 1 || ga.method != "A.one" || gb.id != 1 || gb.method != "B.one" {
		t.Fatalf("응답이 섞였다: a=%+v b=%+v", ga, gb)
	}
	f.mu.Lock()
	ids := map[int64]bool{}
	for _, m := range f.got {
		ids[m.ID] = true
	}
	f.mu.Unlock()
	if len(ids) != 2 {
		t.Fatalf("Chrome 에 간 id 가 겹쳤다: %v", ids)
	}
}

// TC-BRT-21: 세션 이벤트는 그 세션을 붙인 클라이언트에만 간다.
func TestMuxRoutesSessionEvents(t *testing.T) {
	f := newFake(t, func(m Message) []Message {
		if m.Method == "Target.attachToTarget" {
			return []Message{{ID: m.ID, Result: json.RawMessage(`{"sessionId":"S1"}`)}}
		}
		return echo(m)
	})
	var mu sync.Mutex
	gotA, gotB := []string{}, []string{}
	a := NewClient(f.mux, func(m *Message) { mu.Lock(); gotA = append(gotA, m.Method); mu.Unlock() })
	b := NewClient(f.mux, func(m *Message) { mu.Lock(); gotB = append(gotB, m.Method); mu.Unlock() })
	if _, err := a.Call(context.Background(), "", "Target.attachToTarget", map[string]any{"targetId": "T"}); err != nil {
		t.Fatal(err)
	}
	b.Call(context.Background(), "", "Browser.getVersion", nil)
	f.emit(Message{Method: "Page.loadEventFired", SessionID: "S1", Params: json.RawMessage(`{}`)})
	f.emit(Message{Method: "Page.loadEventFired", SessionID: "S2", Params: json.RawMessage(`{}`)})
	// 브라우저 수준 이벤트는 그 도메인을 부른 쪽에만 (b 는 Browser, a 는 Target).
	f.emit(Message{Method: "Target.targetCreated", Params: json.RawMessage(`{}`)})
	b.Call(context.Background(), "", "Browser.getVersion", nil) // 위 이벤트들이 지나간 뒤를 기다린다
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(gotA, ",") != "Page.loadEventFired,Target.targetCreated" {
		t.Fatalf("a=%v", gotA)
	}
	if len(gotB) != 0 {
		t.Fatalf("b 가 남의 세션 이벤트를 받았다: %v", gotB)
	}
}

// 자동 부착으로 생긴 세션의 이벤트도 부착 이벤트를 받은 클라이언트에 간다.
func TestMuxAutoAttachedSessionOwner(t *testing.T) {
	f := newFake(t, echo)
	got := make(chan string, 4)
	a := NewClient(f.mux, func(m *Message) { got <- m.Method + "@" + m.SessionID })
	a.Call(context.Background(), "", "Target.setAutoAttach", map[string]any{"autoAttach": true, "flatten": true})
	f.emit(Message{Method: "Target.attachedToTarget", Params: json.RawMessage(`{"sessionId":"C1"}`)})
	f.emit(Message{Method: "Runtime.consoleAPICalled", SessionID: "C1", Params: json.RawMessage(`{}`)})
	want := []string{"Target.attachedToTarget@", "Runtime.consoleAPICalled@C1"}
	for _, w := range want {
		select {
		case g := <-got:
			if g != w {
				t.Fatalf("got %q want %q", g, w)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%q 가 오지 않았다", w)
		}
	}
}

// TC-BRT-22: 거절 메서드 표 전부 Chrome 에 가지 않는다. 수명·남의 컨텍스트는 오류로,
// 다운로드 경로·파일 선택 끄기는 빈 성공으로 답한다 (Playwright 가 실패를 견디지 못한다).
func TestExternalFilterRejects(t *testing.T) {
	f := newFake(t, echo)
	got := make(chan *Message, 16)
	c := f.mux.Open(ConnOptions{Filter: ExternalFilter, Sink: func(m *Message) { got <- m }})
	cases := []struct {
		m       Message
		wantErr bool
	}{
		{Message{ID: 1, Method: "Browser.close"}, true},
		{Message{ID: 2, Method: "Browser.crash"}, true},
		{Message{ID: 3, Method: "Browser.crashGpuProcess"}, true},
		{Message{ID: 4, Method: "Browser.setDownloadBehavior", Params: json.RawMessage(`{"behavior":"deny"}`)}, false},
		{Message{ID: 5, Method: "Page.setInterceptFileChooserDialog", SessionID: "S", Params: json.RawMessage(`{"enabled":false}`)}, false},
		{Message{ID: 6, Method: "Target.disposeBrowserContext", Params: json.RawMessage(`{"browserContextId":"someone-else"}`)}, true},
	}
	for i := range cases {
		c.Send(&cases[i].m)
		m := <-got
		if (m.Error != nil) != cases[i].wantErr {
			t.Fatalf("%s: error=%v want err=%v", cases[i].m.Method, m.Error, cases[i].wantErr)
		}
	}
	if got := f.methods(); len(got) != 0 {
		t.Fatalf("거절 메서드가 Chrome 에 갔다: %v", got)
	}
	// 켜는 쪽은 통과한다.
	c.Send(&Message{ID: 7, Method: "Page.setInterceptFileChooserDialog", SessionID: "S", Params: json.RawMessage(`{"enabled":true}`)})
	if m := <-got; m.Error != nil {
		t.Fatalf("enabled:true 가 거절됐다: %v", m.Error)
	}
	if got := f.methods(); len(got) != 1 {
		t.Fatalf("enabled:true 가 Chrome 에 가지 않았다: %v", got)
	}
}

// FR-BRT-22: 외부 도구는 자기 브라우저 세션을 갖는다 — 세션 없는 요청은 그 세션으로
// 가고, 그 세션의 소식은 세션을 떼고 돌아온다. 도구가 만든 target 을 알린다.
func TestProxyBrowserSession(t *testing.T) {
	f := newFake(t, func(m Message) []Message {
		switch m.Method {
		case "Target.attachToBrowserTarget":
			return []Message{{ID: m.ID, Result: json.RawMessage(`{"sessionId":"B1"}`)}}
		case "Target.createTarget":
			return []Message{{ID: m.ID, SessionID: m.SessionID, Result: json.RawMessage(`{"targetId":"T9"}`)},
				{Method: "Target.targetCreated", SessionID: "B1", Params: json.RawMessage(`{}`)}}
		}
		return []Message{{ID: m.ID, SessionID: m.SessionID, Result: json.RawMessage(`{}`)}}
	})
	out := make(chan string, 8)
	created := make(chan string, 1)
	p, err := f.mux.OpenProxy(context.Background(), func(b []byte) { out <- string(b) }, func(id string) { created <- id })
	if err != nil {
		t.Fatal(err)
	}
	if p.Session() != "B1" {
		t.Fatalf("session=%q", p.Session())
	}
	p.Send([]byte(`{"id":1,"method":"Target.createTarget","params":{"url":"about:blank"}}`))
	a, b := <-out, <-out
	if !strings.Contains(a+b, `"id":1`) || strings.Contains(a+b, `"B1"`) {
		t.Fatalf("세션이 떼어지지 않았다: %s | %s", a, b)
	}
	select {
	case id := <-created:
		if id != "T9" {
			t.Fatalf("created=%q", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("만든 target 을 알리지 않았다")
	}
	f.mu.Lock()
	last := f.got[len(f.got)-1]
	f.mu.Unlock()
	if last.Method != "Target.createTarget" || last.SessionID != "B1" {
		t.Fatalf("세션 없는 요청이 브라우저 세션으로 가지 않았다: %+v", last)
	}
	// 루트 연결의 브라우저 수준 소식(매니저의 부착)은 도구에 새지 않는다.
	f.emit(Message{Method: "Target.attachedToTarget", Params: json.RawMessage(`{"sessionId":"M1"}`)})
	f.emit(Message{Method: "Target.detachedFromTarget", SessionID: "B1", Params: json.RawMessage(`{}`)})
	select {
	case m := <-out:
		if strings.Contains(m, "M1") {
			t.Fatalf("매니저의 부착이 도구에 샜다: %s", m)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("도구 세션의 소식이 오지 않았다")
	}
}

func TestExternalFilterOwnContext(t *testing.T) {
	f := newFake(t, func(m Message) []Message {
		if m.Method == "Target.createBrowserContext" {
			return []Message{{ID: m.ID, Result: json.RawMessage(`{"browserContextId":"CTX"}`)}}
		}
		return echo(m)
	})
	got := make(chan *Message, 4)
	c := f.mux.Open(ConnOptions{Filter: ExternalFilter, Sink: func(m *Message) { got <- m }})
	c.Send(&Message{ID: 1, Method: "Target.createBrowserContext"})
	<-got
	c.Send(&Message{ID: 2, Method: "Target.disposeBrowserContext", Params: json.RawMessage(`{"browserContextId":"CTX"}`)})
	if m := <-got; m.Error != nil {
		t.Fatalf("자기 컨텍스트를 없애지 못했다: %v", m.Error)
	}
}

// 요청별 제한 시간과 끊김 (FR-BRT-20).
func TestClientTimeoutAndClose(t *testing.T) {
	f := newFake(t, nil) // 답하지 않는다
	c := NewClient(f.mux, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := c.Call(ctx, "", "Browser.getVersion", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("제한 시간: %v", err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := c.Call(context.Background(), "", "Browser.getVersion", nil)
		done <- err
	}()
	time.Sleep(20 * time.Millisecond)
	f.toMux.Close()
	select {
	case err := <-done:
		if !errors.Is(err, ErrClosed) {
			t.Fatalf("끊김: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("끊겨도 대기가 풀리지 않았다")
	}
	if _, err := c.Call(context.Background(), "", "X.y", nil); !errors.Is(err, ErrClosed) {
		t.Fatalf("끊긴 뒤 호출: %v", err)
	}
}
