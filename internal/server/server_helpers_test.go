package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShouldLogRequest(t *testing.T) {
	tests := []struct {
		path   string
		status int
		want   bool
	}{
		{"/api/ping", 200, false},
		{"/api/stats", 200, false},
		{"/api/workspace", 200, false},
		{"/api/workspace/xyz", 200, false},
		{"/api/panes", 200, false},
		{"/api/panes/1", 200, false},
		{"/api/ping", 500, true},
		{"/api/workspace", 409, true},
		{"/", 200, true},
		{"/ws", 200, true},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("%s_%d", tt.path, tt.status), func(t *testing.T) {
			got := shouldLogRequest(tt.path, tt.status)
			if got != tt.want {
				t.Errorf("shouldLogRequest(%q, %d)=%v want %v", tt.path, tt.status, got, tt.want)
			}
		})
	}
}

func TestResponseWriter_WriteHeader(t *testing.T) {
	rec := httptest.NewRecorder()
	rw := &responseWriter{ResponseWriter: rec, status: 200}
	rw.WriteHeader(404)
	if rw.status != 404 {
		t.Fatalf("status=%d want 404", rw.status)
	}
	if rec.Code != 404 {
		t.Fatalf("recorder code=%d want 404", rec.Code)
	}
}

func TestResponseWriter_Flush(t *testing.T) {
	rec := httptest.NewRecorder()
	rw := &responseWriter{ResponseWriter: rec, status: 200}
	// httptest.ResponseWriter implements Flusher; should not panic.
	rw.Flush()
}

func TestLoggingMiddleware(t *testing.T) {
	called := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(418)
		w.Write([]byte("tea"))
	})
	mux := http.NewServeMux()
	mux.Handle("/test/", handler)
	wrapped := loggingMiddleware(mux)

	req := httptest.NewRequest("GET", "/test/path", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	if !called {
		t.Fatal("handler not called")
	}
	if rec.Code != 418 {
		t.Fatalf("status=%d want 418", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "tea") {
		t.Fatalf("body=%q", body)
	}
}
