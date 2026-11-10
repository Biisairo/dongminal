package peer

import (
	"crypto/tls"
	"errors"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
)

// 노드 포트의 `http.Server` 시한. UI 리스너와 같은 근거다 (REQUEST_GATE_SRS FR-RQG-18).
//
// UI 리스너와 달리 읽기·쓰기 시한을 둔다. 노드 포트에는 SSE·WebSocket 같은 오래 사는
// 응답이 없고, 보내는 쪽이 RequestTimeout 뒤에는 어차피 끊는다. 시한이 없으면 본문을
// 느리게 흘리는 연결이 고루틴과 fd 를 무기한 쥔다 (리뷰 S-4).
const (
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
	readTimeout       = RequestTimeout
	writeTimeout      = RequestTimeout + 5*time.Second
	maxHeaderBytes    = 16 << 10
)

var (
	errNoClientCert = errors.New("클라이언트 인증서가 없습니다")
	errNotPeer      = errors.New("짝이 아닌 노드입니다")
)

// Status 는 노드 포트의 지금 상태다 (FR-PNW-9). Err 는 열지 못한 사유다.
type Status struct {
	Listening bool   `json:"listening"`
	Addr      string `json:"addr,omitempty"`
	Err       string `json:"error,omitempty"`
	// Generation 은 연 횟수다. 같은 값이면 같은 리스너다.
	Generation uint64 `json:"-"`
}

// listenKey 는 리스너를 다시 열지 가르는 값이다 (FR-PNW-8).
type listenKey struct {
	enabled bool
	bind    string
	port    int
}

// Listener 는 노드 전용 리스너다. UI 리스너와 따로 열고 닫는다.
type Listener struct {
	mu      sync.Mutex
	tlsCfg  *tls.Config
	handler http.Handler
	applied bool
	key     listenKey
	srv     *http.Server
	// raw 는 srv 가 듣는 TCP 리스너다. Serve 는 고루틴에서 시작하므로, 그 전에 닫으면
	// srv.Close 가 이 리스너를 모른다 — 그래서 직접 닫는다.
	raw    net.Listener
	status Status
	gen    uint64
	// closed 는 Close 뒤다. 그 뒤의 Apply 는 아무것도 열지 않는다 (서버 종료 중).
	closed bool
	// errLog 는 노드 포트 서버의 오류 기록이다. 핸드셰이크 실패는 모아 남긴다 (I-71).
	errLog *log.Logger
}

// Admission 은 누가 노드 포트에 들어오는가다. TLS 는 핸드셰이크에서 지문만 보고,
// Request 는 요청마다 지문과 경로를 함께 본다 (I-1). TLS 단계는 경로를 모른다.
type Admission struct {
	TLS     func(fp string) bool
	Request func(fp, path string) bool
}

// PeersOnly 는 두 단계 모두 isPeer 하나로 거르는 Admission 이다.
func PeersOnly(isPeer func(fp string) bool) Admission {
	return Admission{TLS: isPeer, Request: func(fp, _ string) bool { return isPeer(fp) }}
}

// NewListener 는 id 를 서버 인증서로 쓰고 adm 이 받는 클라이언트만 들이는 리스너를
// 만든다. Apply 전에는 아무것도 듣지 않는다.
func NewListener(id Identity, adm Admission, h http.Handler) *Listener {
	return &Listener{
		errLog:  log.New(newHandshakeLog(afterFunc), "", 0),
		handler: requireAdmission(adm.Request, h),
		tlsCfg: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			Certificates: []tls.Certificate{id.Certificate},
			ClientAuth:   tls.RequireAnyClientCert,
			// VerifyConnection 은 세션 재개에서도 돈다. VerifyPeerCertificate 는 돌지
			// 않으므로, 거기 두면 해제한 짝이 재개로 들어온다 (FR-PNW-31).
			VerifyConnection: func(cs tls.ConnectionState) error {
				fp, err := clientFingerprint(cs)
				if err != nil {
					return err
				}
				if !adm.TLS(fp) {
					return errNotPeer
				}
				return nil
			},
		},
	}
}

func clientFingerprint(cs tls.ConnectionState) (string, error) {
	if len(cs.PeerCertificates) == 0 {
		return "", errNoClientCert
	}
	return FingerprintOf(cs.PeerCertificates[0]), nil
}

// ClientFingerprint 는 요청을 보낸 노드의 지문이다. 노드 포트 밖의 요청이면 빈 값이다.
func ClientFingerprint(r *http.Request) string {
	if r.TLS == nil {
		return ""
	}
	fp, _ := clientFingerprint(*r.TLS)
	return fp
}

// requireAdmission 은 요청마다 다시 거른다. 짝을 해제한 뒤에도 열려 있던 keep-alive
// 연결이 핸들러에 닿지 않게 한다 (FR-PNW-31).
func requireAdmission(admit func(fp, path string) bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fp := ClientFingerprint(r)
		if fp == "" || !admit(fp, r.URL.Path) {
			w.Header().Set("Connection", "close")
			w.WriteHeader(http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Apply 는 c 의 enabled·bind·port 에 맞춰 연다·닫는다·다시 연다 (FR-PNW-4·8).
// 그 셋이 같고 지금 상태가 그 값과 맞으면 아무것도 하지 않는다. 열지 못하면 사유를
// Status 에 남긴다 (FR-PNW-9).
func (l *Listener) Apply(c Config) {
	key := listenKey{enabled: c.Enabled, bind: c.Bind, port: c.Port}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || (l.applied && key == l.key && l.status.Listening == key.enabled) {
		return
	}
	l.closeLocked()
	l.applied = true
	l.key = key
	if !key.enabled {
		return
	}
	raw, err := net.Listen("tcp", net.JoinHostPort(key.bind, strconv.Itoa(key.port)))
	if err != nil {
		dmlog.Infof(nil, "peer listener: %v", err)
		l.status = Status{Err: err.Error()}
		return
	}
	l.gen++
	srv := &http.Server{
		Handler:           l.handler,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		ErrorLog:          l.errLog,
	}
	l.srv, l.raw = srv, raw
	l.status = Status{Listening: true, Addr: raw.Addr().String(), Generation: l.gen}
	go func() {
		if err := srv.Serve(tls.NewListener(raw, l.tlsCfg)); err != nil && !errors.Is(err, http.ErrServerClosed) {
			dmlog.Infof(nil, "peer listener: %v", err)
		}
	}()
	dmlog.Infof(nil, "peer listener on %s", raw.Addr())
}

// Status 는 지금 상태의 사본이다.
func (l *Listener) Status() Status {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.status
}

// Close 는 리스너를 닫는다. 여러 번 불러도 된다. 닫은 뒤에는 Apply 가 다시 열지 않는다.
func (l *Listener) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeLocked()
	l.applied = false
	l.closed = true
}

func (l *Listener) closeLocked() {
	if l.srv != nil {
		_ = l.srv.Close()
		l.srv = nil
	}
	if l.raw != nil {
		_ = l.raw.Close()
		l.raw = nil
	}
	l.status = Status{}
}

// handshakeAggregate 는 핸드셰이크 실패를 모아 한 줄로 남기는 주기다.
const handshakeAggregate = time.Minute

// handshakeLog 는 노드 포트 http.Server 의 오류 기록이다. 짝이 아닌 누구나 핸드셰이크를
// 실패시킬 수 있으므로, 그 실패는 창(1분)마다 묶는다. 창의 첫 실패는 바로 한 줄로 남기고,
// 창이 끝나면 그 사이의 나머지 건수를 한 줄로 남긴다. 실패마다 남기면 로그 상한이 감사
// 기록을 밀어낸다 (I-71). 다른 오류는 그대로 남긴다.
type handshakeLog struct {
	mu    sync.Mutex
	after func(d time.Duration, f func())
	open  bool
	n     int
	last  string
}

func newHandshakeLog(after func(d time.Duration, f func())) *handshakeLog {
	return &handshakeLog{after: after}
}

func afterFunc(d time.Duration, f func()) { time.AfterFunc(d, f) }

func (h *handshakeLog) Write(p []byte) (int, error) {
	line := strings.TrimSpace(string(p))
	if !strings.Contains(line, "TLS handshake error") {
		dmlog.Infof(nil, "peer listener: %s", line)
		return len(p), nil
	}
	h.mu.Lock()
	if h.open {
		h.n++
		h.last = line
		h.mu.Unlock()
		return len(p), nil
	}
	h.open = true
	h.mu.Unlock()
	dmlog.Infof(nil, "peer listener: TLS handshake failure count=1 (%s)", line)
	h.after(handshakeAggregate, h.flush)
	return len(p), nil
}

// flush 는 창을 닫고, 창의 첫 실패 뒤에 온 건수를 남긴다.
func (h *handshakeLog) flush() {
	h.mu.Lock()
	n, last := h.n, h.last
	h.open, h.n, h.last = false, 0, ""
	h.mu.Unlock()
	if n > 0 {
		dmlog.Infof(nil, "peer listener: TLS handshake failure count=%d within %s (최근: %s)", n, handshakeAggregate, last)
	}
}
