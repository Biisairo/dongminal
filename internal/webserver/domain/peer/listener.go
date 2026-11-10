package peer

import (
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
)

// 노드 포트의 `http.Server` 시한. UI 리스너와 같은 근거다 (REQUEST_GATE_SRS FR-RQG-18).
const (
	readHeaderTimeout = 10 * time.Second
	idleTimeout       = 120 * time.Second
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
	status  Status
	gen     uint64
}

// NewListener 는 id 를 서버 인증서로 쓰고, isPeer 가 참인 클라이언트 인증서만 받는
// 리스너를 만든다. Apply 전에는 아무것도 듣지 않는다.
func NewListener(id Identity, isPeer func(fp string) bool, h http.Handler) *Listener {
	return &Listener{
		handler: requirePeer(isPeer, h),
		tlsCfg: &tls.Config{
			MinVersion:   tls.VersionTLS13,
			Certificates: []tls.Certificate{id.Certificate},
			ClientAuth:   tls.RequireAnyClientCert,
			// VerifyConnection 은 세션 재개에서도 돈다. VerifyPeerCertificate 는 돌지
			// 않으므로, 거기 두면 해제한 짝이 재개로 들어온다 (FR-PNW-31).
			VerifyConnection: func(cs tls.ConnectionState) error {
				return checkPeer(isPeer, cs)
			},
		},
	}
}

func checkPeer(isPeer func(string) bool, cs tls.ConnectionState) error {
	if len(cs.PeerCertificates) == 0 {
		return errNoClientCert
	}
	if !isPeer(FingerprintOf(cs.PeerCertificates[0])) {
		return errNotPeer
	}
	return nil
}

// requirePeer 는 요청마다 짝인지 다시 본다. 짝을 해제한 뒤에도 열려 있던
// keep-alive 연결이 핸들러에 닿지 않게 한다 (FR-PNW-31).
func requirePeer(isPeer func(string) bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || checkPeer(isPeer, *r.TLS) != nil {
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
	if l.applied && key == l.key && l.status.Listening == key.enabled {
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
		IdleTimeout:       idleTimeout,
	}
	l.srv = srv
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

// Close 는 리스너를 닫는다. 여러 번 불러도 된다.
func (l *Listener) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.closeLocked()
	l.applied = false
}

func (l *Listener) closeLocked() {
	if l.srv != nil {
		_ = l.srv.Close()
		l.srv = nil
	}
	l.status = Status{}
}
