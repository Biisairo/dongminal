package main

// 외부 CLI/스크립트에서 실행 중인 브라우저에 명령을 전달하기 위한 SSE 브로드캐스트 채널.
//   - POST /api/commands         : {action, args} 를 받아 모든 구독자에게 브로드캐스트
//   - GET  /api/commands/sse     : 브라우저가 구독 (EventSource)
//
// 서버는 워크스페이스 상태를 해석하지 않고 단지 명령을 전달한다. 실제 세션/탭/분할/포커스
// 동작은 app.js 의 executeAction() 및 _focusLocation() 이 수행한다 (기존 코드 재사용).

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"time"
)

type cmdSub struct {
	ch   chan []byte
	done chan struct{}
	once sync.Once
}

var (
	cmdSubs   = map[*cmdSub]struct{}{}
	cmdSubsMu sync.Mutex
)

func addCmdSub() *cmdSub {
	s := &cmdSub{ch: make(chan []byte, 16), done: make(chan struct{})}
	cmdSubsMu.Lock()
	cmdSubs[s] = struct{}{}
	cmdSubsMu.Unlock()
	return s
}

func removeCmdSub(s *cmdSub) {
	s.once.Do(func() { close(s.done) })
	cmdSubsMu.Lock()
	delete(cmdSubs, s)
	cmdSubsMu.Unlock()
}

func broadcastCmd(payload []byte) int {
	cmdSubsMu.Lock()
	defer cmdSubsMu.Unlock()
	n := 0
	for s := range cmdSubs {
		select {
		case s.ch <- payload:
			n++
		default:
			log.Printf("[cmd] subscriber channel full, dropping")
		}
	}
	return n
}

func handleCommandSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	sub := addCmdSub()
	defer removeCmdSub(sub)

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	keep := time.NewTicker(15 * time.Second)
	defer keep.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-sub.done:
			return
		case msg := <-sub.ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-keep.C:
			fmt.Fprint(w, ": keep\n\n")
			flusher.Flush()
		}
	}
}

var allowedCmdActions = map[string]bool{
	"newSession":   true,
	"newTab":       true,
	"splitH":       true,
	"splitV":       true,
	"focus":        true,
	"closeTab":     true,
	"closeSession": true,
	"sessionNext":  true,
	"sessionPrev":  true,
	"tabNext":      true,
	"tabPrev":      true,
	"paneUp":       true,
	"paneDown":     true,
	"paneLeft":     true,
	"paneRight":    true,
}

func handleCommandPost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var req struct {
		Action string          `json:"action"`
		Args   json.RawMessage `json:"args,omitempty"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !allowedCmdActions[req.Action] {
		http.Error(w, "unknown action: "+req.Action, http.StatusBadRequest)
		return
	}
	payload, _ := json.Marshal(req)
	n := broadcastCmd(payload)
	log.Printf("[cmd] action=%s delivered=%d", req.Action, n)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":        true,
		"delivered": n,
	})
}
