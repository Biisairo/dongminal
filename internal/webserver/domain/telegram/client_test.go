package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-2 — 클라이언트. Telegram 은 가짜 HTTP 서버로 바꾼다 (§5).

func fakeAPI(t *testing.T, h func(method string, body map[string]any) (int, string)) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(r.URL.Path, "/")
		method := parts[len(parts)-1]
		if !strings.HasPrefix(parts[1], "bot") {
			t.Errorf("경로에 bot 접두가 없다: %s", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		code, out := h(method, body)
		w.WriteHeader(code)
		_, _ = io.WriteString(w, out)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestClientGetMe(t *testing.T) {
	srv := fakeAPI(t, func(m string, _ map[string]any) (int, string) {
		if m != "getMe" {
			t.Errorf("method %s", m)
		}
		return 200, `{"ok":true,"result":{"id":9,"is_bot":true,"username":"office_bot","has_topics_enabled":true}}`
	})
	me, err := NewClient(srv.URL, testToken, nil).GetMe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if me.Username != "office_bot" || !me.IsBot {
		t.Fatalf("getMe 값이 틀렸다: %+v", me)
	}
}

func TestClientAPIErrorAndRetryAfter(t *testing.T) {
	srv := fakeAPI(t, func(string, map[string]any) (int, string) {
		return 429, `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 3","parameters":{"retry_after":3}}`
	})
	err := NewClient(srv.URL, testToken, nil).Call(context.Background(), "sendMessage", map[string]any{"chat_id": 1}, nil)
	var ae *APIError
	if !errors.As(err, &ae) || ae.Code != 429 || ae.RetryAfter != 3 {
		t.Fatalf("APIError 가 아니다: %v", err)
	}
}

// 오류 문구에 token 이 섞이지 않는다 (FR-TGB-3). net/http 의 오류는 URL 을 싣는다.
func TestClientErrorNeverLeaksToken(t *testing.T) {
	c := NewClient("http://127.0.0.1:1", testToken, nil)
	err := c.Call(context.Background(), "getMe", nil, nil)
	if err == nil {
		t.Fatal("닿지 않는 주소인데 오류가 없다")
	}
	if strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("오류에 token 이 실렸다: %v", err)
	}
}

func TestClientSendsJSONParams(t *testing.T) {
	var got map[string]any
	srv := fakeAPI(t, func(_ string, b map[string]any) (int, string) {
		got = b
		return 200, `{"ok":true,"result":{"message_id":5}}`
	})
	var out struct {
		MessageID int64 `json:"message_id"`
	}
	err := NewClient(srv.URL, testToken, nil).Call(context.Background(), "sendMessage",
		map[string]any{"chat_id": int64(7), "message_thread_id": int64(9), "text": "안녕"}, &out)
	if err != nil {
		t.Fatal(err)
	}
	if out.MessageID != 5 || got["text"] != "안녕" || got["message_thread_id"].(float64) != 9 {
		t.Fatalf("보낸 값이나 받은 값이 틀렸다: out=%+v got=%v", out, got)
	}
}

func TestClientGetUpdatesParses(t *testing.T) {
	srv := fakeAPI(t, func(string, map[string]any) (int, string) {
		return 200, `{"ok":true,"result":[
			{"update_id":10,"message":{"message_id":1,"from":{"id":42},"chat":{"id":42,"type":"private"},"message_thread_id":263,"text":"hi"}},
			{"update_id":11,"callback_query":{"id":"cb1","from":{"id":42},"data":"k:1","message":{"message_id":3,"chat":{"id":42,"type":"private"},"message_thread_id":263}}}]}`
	})
	ups, err := NewClient(srv.URL, testToken, nil).GetUpdates(context.Background(), 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 2 || ups[0].Message.Text != "hi" || ups[0].Message.From.ID != 42 || ups[0].Message.Chat.ID != 42 {
		t.Fatalf("message 해석이 틀렸다: %+v", ups)
	}
	cb := ups[1].CallbackQuery
	if cb == nil || cb.Data != "k:1" || cb.ID != "cb1" || cb.From.ID != 42 {
		t.Fatalf("callback 해석이 틀렸다: %+v", cb)
	}
}
