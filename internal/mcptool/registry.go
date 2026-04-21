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

// Textf is a shortcut for TextResult(fmt.Sprintf(format, a...)).
func Textf(format string, a ...any) Result {
	return TextResult(fmt.Sprintf(format, a...))
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

// ── generic tool registration ────────────────────────

type genericTool[A any] struct {
	name string
	spec map[string]any
	fn   func(ctx context.Context, a A) (Result, error)
}

func (g genericTool[A]) Name() string         { return g.name }
func (g genericTool[A]) Spec() map[string]any { return g.spec }

func (g genericTool[A]) Call(ctx context.Context, raw json.RawMessage) (Result, error) {
	var a A
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &a); err != nil {
			return ErrorResult("잘못된 인자: %v", err), nil
		}
	}
	return g.fn(ctx, a)
}

// Register is a generic ergonomics helper: it wraps fn in a genericTool[A] that
// auto-unmarshals args into A before invocation. spec is the tools/list schema
// payload (kept external so the Tool interface stays unchanged).
func Register[A any](r *Registry, name string, spec map[string]any, fn func(ctx context.Context, a A) (Result, error)) {
	r.tools[name] = genericTool[A]{name: name, spec: spec, fn: fn}
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
