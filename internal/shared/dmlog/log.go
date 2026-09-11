// Package dmlog 는 이 제품의 로그가 지나는 **한 자리**다
// (OBSERVABILITY_SRS 묶음 L·R).
//
// 종전에는 표준 `log` 를 172곳에서 직접 불렀다. 그래서 셋이 없었다 —
// **수준**(치명과 잡음이 같은 무게로 섞인다) · **요청 ID**(한 요청이 남긴 줄을
// 시각으로 짐작해 묶는다) · **붙일 자리**(모두가 전역을 직접 부르므로 가운데가 없다).
//
// `log/slog` 를 쓴다. **의존성을 더하지 않는다** — 표준 라이브러리다 (FR-OBS-1).
//
// 서식 있는 호출(`Warnf`)을 남긴 것은 D-OBS-1 이다. 172곳을 키-값으로 옮기는
// 위험 대비 이득이 없다 — 얻으려던 수준·시각·요청 ID 는 서식을 유지한 채 얻는다.
// **새로 쓰는 곳은 키-값**(`Info(ctx, msg, "k", v)`)을 쓴다.
package dmlog

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"log/slog"
	"os"
	"strings"
	"sync/atomic"
)

// ReqIDHeader 는 요청 ID 를 주고받는 헤더다.
const ReqIDHeader = "X-Request-Id"

// reqIDMax 는 받아들일 최대 길이다. 로그에 실리는 값이라 길이를 묶는다.
const reqIDMax = 64

// Options 는 Init 의 입력이다.
type Options struct {
	// Level 은 `debug`·`info`·`warn`·`error`. 알 수 없는 값은 `info` 다
	// (FR-OBS-2) — 로그 설정 하나가 기동을 시끄럽게 만들 이유가 없다.
	Level string
	// Out 이 비면 stderr 다.
	Out io.Writer
}

var (
	current  atomic.Pointer[slog.Logger]
	levelStr atomic.Pointer[string]
)

// Init 은 로그 계층을 세운다. 기동에서 한 번 부른다.
//
// **표준 `log` 의 출력도 여기로 돌린다.** 제품 코드에서는 `log.Printf` 를 쓰지
// 않지만(FR-OBS-5), 표준 라이브러리와 제3자가 그것을 부를 수 있다 — 그 줄이
// 형식 밖으로 새면 로그 파일이 두 형식이 된다.
func Init(o Options) {
	out := o.Out
	if out == nil {
		out = os.Stderr
	}
	lvl, name := parseLevel(o.Level)
	h := slog.NewTextHandler(out, &slog.HandlerOptions{Level: lvl})
	lg := slog.New(h)
	current.Store(lg)
	levelStr.Store(&name)
	slog.SetDefault(lg)
	log.SetOutput(bridgeWriter{lg})
	log.SetFlags(0) // 시각은 slog 가 싣는다 — 두 번 찍지 않는다
}

// Reset 은 검사가 쓰는 되돌리기다.
func Reset() {
	Init(Options{})
}

// bridgeWriter 는 표준 `log` 로 들어온 줄을 slog 로 옮긴다.
type bridgeWriter struct{ lg *slog.Logger }

func (b bridgeWriter) Write(p []byte) (int, error) {
	b.lg.Info(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

func parseLevel(s string) (slog.Level, string) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, "debug"
	case "warn", "warning":
		return slog.LevelWarn, "warn"
	case "error":
		return slog.LevelError, "error"
	default:
		// 빈 값도 알 수 없는 값도 여기로 온다 — 둘 다 "정하지 않았다" 이다.
		return slog.LevelInfo, "info"
	}
}

// Level 은 지금 하한의 이름이다. `config show` 와 진단이 읽는다.
func Level() string {
	if p := levelStr.Load(); p != nil {
		return *p
	}
	return "info"
}

func logger() *slog.Logger {
	if lg := current.Load(); lg != nil {
		return lg
	}
	// Init 을 부르지 않은 경로(검사·초기화 순서)도 죽지 않아야 한다.
	return slog.Default()
}

// ── 요청 ID ────────────────────────────────────────────────

type ctxKey struct{}

// WithReqID 는 요청 ID 를 컨텍스트에 싣는다.
func WithReqID(ctx context.Context, id string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if id == "" {
		return ctx
	}
	return context.WithValue(ctx, ctxKey{}, id)
}

// ReqID 는 컨텍스트의 요청 ID 다. 없으면 빈 문자열.
func ReqID(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	s, _ := ctx.Value(ctxKey{}).(string)
	return s
}

// SanitizeReqID 는 밖에서 온 값을 받아들일지 판정한다 (FR-OBS-7).
//
// **빈 문자열이 거절이다.** 부르는 쪽은 그때 새로 만든다. 값을 고쳐서 쓰지
// 않는 이유는 위조 때문이다 — 줄바꿈을 지운 값은 보낸 쪽이 의도한 값도 아니고
// 우리가 만든 값도 아니어서, 그 ID 로 무언가를 추적하면 거짓 실마리가 된다.
func SanitizeReqID(s string) string {
	if s == "" || len(s) > reqIDMax {
		return ""
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		ok := c == '-' || c == '_' ||
			(c >= '0' && c <= '9') ||
			(c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z')
		if !ok {
			return ""
		}
	}
	return s
}

// NewReqID 는 새 요청 ID 다. 짧고, 로그에서 눈으로 견줄 수 있어야 한다.
func NewReqID() string {
	var b [9]byte
	if _, err := rand.Read(b[:]); err != nil {
		// 엔트로피가 없어도 로그는 계속돼야 한다. 겹칠 수 있으나 그것이
		// 로그가 멎는 것보다 낫다.
		return fmt.Sprintf("seq%d", counter.Add(1))
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

var counter atomic.Int64

// ── 내는 자리 ──────────────────────────────────────────────

// with 는 요청 ID 가 있으면 그것을 단 손잡이를 준다.
//
// 없으면 **필드를 달지 않는다** — 빈 값을 실으면 로그가 넓어지기만 한다.
func with(ctx context.Context) *slog.Logger {
	lg := logger()
	if id := ReqID(ctx); id != "" {
		return lg.With("reqId", id)
	}
	return lg
}

func Debug(ctx context.Context, msg string, args ...any) { with(ctx).Debug(msg, args...) }
func Info(ctx context.Context, msg string, args ...any)  { with(ctx).Info(msg, args...) }
func Warn(ctx context.Context, msg string, args ...any)  { with(ctx).Warn(msg, args...) }
func Error(ctx context.Context, msg string, args ...any) { with(ctx).Error(msg, args...) }

// Debugf~Errorf 는 옛 `log.Printf` 가 옮겨 앉는 자리다 (D-OBS-1).
func Debugf(ctx context.Context, format string, a ...any) {
	with(ctx).Debug(fmt.Sprintf(format, a...))
}
func Infof(ctx context.Context, format string, a ...any) {
	with(ctx).Info(fmt.Sprintf(format, a...))
}
func Warnf(ctx context.Context, format string, a ...any) {
	with(ctx).Warn(fmt.Sprintf(format, a...))
}
func Errorf(ctx context.Context, format string, a ...any) {
	with(ctx).Error(fmt.Sprintf(format, a...))
}
