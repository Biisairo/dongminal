package mcptool

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

var ErrUnknownTool = errors.New("mcptool: unknown tool")

type Result = map[string]any

type Tool interface {
	Name() string
	Spec() map[string]any
	Call(ctx context.Context, args json.RawMessage) (Result, error)
}

type Registry struct {
	tools map[string]Tool
}

func NewRegistry() *Registry {
	return &Registry{tools: map[string]Tool{}}
}

func (r *Registry) Register(t Tool) {
	r.tools[t.Name()] = t
}

func (r *Registry) Names() []string {
	out := make([]string, 0, len(r.tools))
	for n := range r.tools {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

func (r *Registry) Dispatch(ctx context.Context, name string, args json.RawMessage) (Result, error) {
	t, ok := r.tools[name]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
	return t.Call(ctx, args)
}

// List returns the tool schema list for MCP tools/list. Order is by name.
func (r *Registry) List() []map[string]any {
	names := r.Names()
	out := make([]map[string]any, 0, len(names))
	for _, n := range names {
		out = append(out, r.tools[n].Spec())
	}
	return out
}

// TextResult builds the standard content envelope with a single text block.
func TextResult(text string) Result {
	return Result{
		"content": []map[string]any{
			{"type": "text", "text": text},
		},
	}
}

// ErrorResult builds an isError response with formatted message.
func ErrorResult(format string, a ...any) Result {
	return Result{
		"isError": true,
		"content": []map[string]any{
			{"type": "text", "text": fmt.Sprintf(format, a...)},
		},
	}
}

// ── request-scoped context ───────────────────────────

type ctxKey int

const remoteAddrKey ctxKey = iota

func WithRemoteAddr(ctx context.Context, addr string) context.Context {
	return context.WithValue(ctx, remoteAddrKey, addr)
}

func RemoteAddrFromContext(ctx context.Context) string {
	v, _ := ctx.Value(remoteAddrKey).(string)
	return v
}
