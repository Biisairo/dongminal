package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime/debug"
	"time"

	"dongminal/internal/mcptool"
)

type jsonRPCReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRPCResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  interface{}     `json:"result,omitempty"`
	Error   *jsonRPCErr     `json:"error,omitempty"`
}

type jsonRPCErr struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

func (s *Server) handleMCPSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)

	sess := s.MCP.New()
	sess.RemoteAddr = r.RemoteAddr
	defer s.MCP.Close(sess)

	endpoint := fmt.Sprintf("/mcp/message?sessionId=%s", sess.ID)
	fmt.Fprintf(w, "event: endpoint\ndata: %s\n\n", endpoint)
	flusher.Flush()
	log.Printf("[mcp %s] SSE opened addr=%s", sess.ID, r.RemoteAddr)

	keep := time.NewTicker(15 * time.Second)
	defer keep.Stop()

	for {
		select {
		case <-r.Context().Done():
			log.Printf("[mcp %s] client disconnected", sess.ID)
			return
		case <-sess.Done:
			return
		case msg := <-sess.Ch:
			fmt.Fprintf(w, "event: message\ndata: %s\n\n", msg)
			flusher.Flush()
		case <-keep.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) handleMCPMessage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	sid := r.URL.Query().Get("sessionId")
	sess := s.MCP.Get(sid)
	if sess == nil {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	var req jsonRPCReq
	if err := json.Unmarshal(body, &req); err != nil {
		log.Printf("[mcp %s] invalid json: %v body=%s", sid, err, string(body))
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[mcp %s] handler panic: %v\n%s", sid, rec, debug.Stack())
			}
		}()
		s.handleMCPRequest(sess, &req)
	}()
	w.WriteHeader(http.StatusAccepted)
}

func (s *Server) handleMCPRequest(sess *MCPSession, req *jsonRPCReq) {
	if len(req.ID) == 0 || string(req.ID) == "null" {
		log.Printf("[mcp %s] notify: %s", sess.ID, req.Method)
		return
	}

	resp := jsonRPCResp{JSONRPC: "2.0", ID: req.ID}

	switch req.Method {
	case "initialize":
		resp.Result = map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities": map[string]interface{}{
				"tools": map[string]interface{}{},
			},
			"serverInfo": map[string]interface{}{
				"name":    "dongminal",
				"version": "0.1.0",
			},
		}
	case "tools/list":
		if s.Tools != nil {
			resp.Result = map[string]interface{}{"tools": s.Tools.List()}
		} else {
			resp.Result = map[string]interface{}{"tools": []any{}}
		}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			resp.Error = &jsonRPCErr{Code: -32602, Message: err.Error()}
		} else if s.Tools == nil {
			resp.Error = &jsonRPCErr{Code: -32601, Message: "no tool registry"}
		} else {
			ctx := mcptool.WithRemoteAddr(context.Background(), sess.RemoteAddr)
			result, err := s.Tools.Dispatch(ctx, p.Name, p.Arguments)
			switch {
			case errors.Is(err, mcptool.ErrUnknownTool):
				resp.Error = &jsonRPCErr{Code: -32601, Message: err.Error()}
			case err != nil:
				resp.Result = map[string]interface{}{
					"content": []map[string]interface{}{
						{"type": "text", "text": "오류: " + err.Error()},
					},
					"isError": true,
				}
			default:
				resp.Result = result
			}
		}
	case "ping":
		resp.Result = map[string]interface{}{}
	default:
		resp.Error = &jsonRPCErr{Code: -32601, Message: "method not found: " + req.Method}
	}

	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("[mcp %s] marshal error: %v", sess.ID, err)
		return
	}
	select {
	case sess.Ch <- data:
	case <-sess.Done:
	case <-time.After(5 * time.Second):
		log.Printf("[mcp %s] send timeout method=%s", sess.ID, req.Method)
	}
}
