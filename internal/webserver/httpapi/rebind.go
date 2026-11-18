package httpapi

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/httpresp"
	"dongminal/internal/shared/serverconf"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/sse"
)

// HOT_REBIND_SRS 묶음 R — 서버를 끄지 않고 바인드를 바꾼다.

const (
	// defaultBindGrace 는 포트를 옮긴 뒤 옛 리스너를 남겨 두는 시간이다 (FR-HRB-23 ⑧).
	defaultBindGrace = 30 * time.Second
	bindPortMin      = 1024
	bindPortMax      = 65535
	exposeHost       = "0.0.0.0"
	// exposeWarning 은 expose 를 켤 때 응답과 로그에 싣는 경고다 (FR-HRB-29).
	exposeWarning = "인증이 없습니다 — 같은 망의 누구나 셸을 얻습니다. Settings ▸ Access 에서 허용 목록을 켜세요"
)

// rebinder 는 Run 이 돌리는 http.Server 와 그 리스너들이다. http.Server 하나가 여러
// 리스너를 서빙하므로, 갈아 끼우기는 리스너를 더하고 닫는 일이다.
type rebinder struct {
	srv   *http.Server
	home  string
	errCh chan error
	conns *connSet

	mu         sync.Mutex
	busy       bool
	host, port string
	ln         net.Listener
	// grace 는 유예 중인 옛 리스너다. 키는 포트다.
	grace map[string]graceEntry
}

// graceEntry 는 유예 중인 옛 리스너와 그것이 묶인 호스트다. 호스트를 들고 있어야 expose 를
// 끌 때 노출된 것만 골라 닫을 수 있다 (FR-HRB-32).
type graceEntry struct {
	ln   net.Listener
	host string
}

// revokeExposure 는 노출을 거둔다 (FR-HRB-32). 노출된 유예 리스너를 먼저 닫아 새 연결을 막고,
// 그다음 같은 망에서 이미 맺은 연결을 끊는다.
func (b *rebinder) revokeExposure() {
	b.mu.Lock()
	for port, g := range b.grace {
		if dmenv.IsExposedHost(g.host) {
			delete(b.grace, port)
			_ = g.ln.Close()
		}
	}
	b.mu.Unlock()
	b.conns.revokeRemote()
}

func (b *rebinder) addr() string { return net.JoinHostPort(b.host, b.port) }

// serve 는 리스너 하나를 서빙한다. 일부러 닫은 리스너의 끝은 서버의 끝이 아니다.
func (b *rebinder) serve(ln net.Listener) {
	go func() {
		err := b.srv.Serve(trackedListener{Listener: ln, set: b.conns})
		if errors.Is(err, net.ErrClosed) {
			return
		}
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		select {
		case b.errCh <- err:
		default:
		}
	}()
}

// movedFrom 은 요청이 유예 중인 옛 리스너로 왔으면 지금 포트를 준다.
func (b *rebinder) movedFrom(r *http.Request) (string, bool) {
	local, ok := r.Context().Value(http.LocalAddrContextKey).(*net.TCPAddr)
	if !ok {
		return "", false
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, in := b.grace[strconv.Itoa(local.Port)]; in {
		return b.port, true
	}
	return "", false
}

// graceRedirect 는 유예 중인 옛 주소의 문서 요청을 같은 호스트 이름의 새 포트로 보낸다
// (FR-HRB-23 ⑧). API 와 WebSocket 은 그대로 서빙한다.
func (s *Server) graceRedirect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if b := s.bind; b != nil && r.Method == http.MethodGet && r.URL.Path == "/" {
			if port, moved := b.movedFrom(r); moved {
				name := r.Host
				if h, _, err := net.SplitHostPort(r.Host); err == nil {
					name = h
				}
				scheme := "http"
				if r.TLS != nil {
					scheme = "https"
				}
				to := url.URL{Scheme: scheme, Host: net.JoinHostPort(name, port), Path: "/", RawQuery: r.URL.RawQuery}
				http.Redirect(w, r, to.String(), http.StatusTemporaryRedirect)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// bindView 는 리바인드 응답이다.
type bindView struct {
	Host    string `json:"host"`
	Port    string `json:"port"`
	Expose  bool   `json:"expose"`
	URL     string `json:"url"`
	Warning string `json:"warning,omitempty"`
}

func viewOf(host, port string) bindView {
	return bindView{Host: host, Port: port, Expose: dmenv.IsExposedHost(host), URL: dmenv.BaseURL(host, port)}
}

// apiServerBindGet 은 `GET /api/server/bind` 다 — Settings 의 Server 구역이 읽는다 (FR-HRB-40).
// 지금 바인드, server.json 값의 출처(file·default), 이 요청이 루프백인지(local)를 준다.
// Run 밖에서 만든 서버는 server.json 의 값을 지금 바인드로 보인다.
func (s *Server) apiServerBindGet(w http.ResponseWriter, r *http.Request) {
	conf := serverconf.Resolve(serverconf.Inputs{Home: s.cfg.DataDir})
	host, port := conf.Host.Value, conf.Port.Value
	if b := s.bind; b != nil {
		b.mu.Lock()
		host, port = b.host, b.port
		b.mu.Unlock()
	}
	httpresp.JSON(w, http.StatusOK, struct {
		bindView
		Local  bool              `json:"local"`
		Source map[string]string `json:"source"`
	}{viewOf(host, port), isLoopbackAddr(r.RemoteAddr),
		map[string]string{"host": string(conf.Host.Source), "port": string(conf.Port.Source)}})
}

// apiServerBind 는 `POST /api/server/bind` 다 (FR-HRB-20~31).
func (s *Server) apiServerBind(w http.ResponseWriter, r *http.Request) {
	if !isLoopbackAddr(r.RemoteAddr) {
		codeFail(w, http.StatusForbidden, apierr.CodeBindLocalOnly, "bind is local only")
		return
	}
	b := s.bind
	if b == nil {
		codeFail(w, http.StatusServiceUnavailable, apierr.CodeBindUnavailable, "rebind unavailable")
		return
	}
	var in struct {
		Port   *int  `json:"port"`
		Expose *bool `json:"expose"`
	}
	if !readJSONBody(w, r, &in) {
		return
	}
	if in.Port != nil && (*in.Port < bindPortMin || *in.Port > bindPortMax) {
		codeFail(w, http.StatusBadRequest, apierr.CodeBindPortInvalid, "port out of range")
		return
	}

	b.mu.Lock()
	if b.busy {
		b.mu.Unlock()
		codeFail(w, http.StatusConflict, apierr.CodeBindBusy, "rebind in progress")
		return
	}
	b.busy = true
	curHost, curPort := b.host, b.port
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.busy = false
		b.mu.Unlock()
	}()

	newHost, newPort := curHost, curPort
	if in.Expose != nil {
		switch {
		case *in.Expose:
			newHost = exposeHost
		case dmenv.IsExposedHost(curHost):
			newHost = dmenv.DefaultHost
		}
	}
	if in.Port != nil {
		newPort = strconv.Itoa(*in.Port)
	}
	if newHost == curHost && newPort == curPort {
		httpresp.JSON(w, http.StatusOK, viewOf(curHost, curPort))
		return
	}

	var status int
	var code string
	if newPort != curPort {
		status, code = s.movePort(b, newHost, newPort)
	} else {
		status, code = s.swapHost(b, newHost)
	}
	if code != "" {
		codeFail(w, status, code, "rebind failed")
		return
	}
	if dmenv.IsExposedHost(curHost) && !dmenv.IsExposedHost(newHost) {
		// FR-HRB-32: expose 를 껐으면 노출된 유예 리스너와 같은 망에서 맺은 연결을 거둔다.
		b.revokeExposure()
	}
	view := viewOf(newHost, newPort)
	reason := "port"
	if newPort == curPort {
		reason = "expose"
	}
	dmlog.Infof(nil, "[bind] %s → %s (%s)", net.JoinHostPort(curHost, curPort), net.JoinHostPort(newHost, newPort), reason)
	if view.Expose && !dmenv.IsExposedHost(curHost) {
		view.Warning = exposeWarning
		dmlog.Warnf(nil, "[bind] %s", exposeWarning)
	}
	httpresp.JSON(w, http.StatusOK, view)
}

// saveBind 는 server.json 과 주소 파일을 새 바인드로 쓴다 (FR-HRB-23 ④).
func saveBind(home, host, port string) error {
	if err := serverconf.SetBind(home, host, port); err != nil {
		return err
	}
	return serverconf.WriteAddr(home, net.JoinHostPort(host, port))
}

// movePort 는 포트를 옮긴다 (FR-HRB-23·25). 실패하면 옛 바인드가 그대로다.
func (s *Server) movePort(b *rebinder, host, port string) (int, string) {
	b.mu.Lock()
	if old, in := b.grace[port]; in {
		// 유예 중인 옛 포트로 되돌린다 — 그 리스너가 포트를 쥐고 있다.
		delete(b.grace, port)
		_ = old.ln.Close()
	}
	b.mu.Unlock()

	ln, err := s.bindListen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		dmlog.Infof(nil, "[bind] %s 에 리슨하지 못했습니다: %v", net.JoinHostPort(host, port), err)
		return http.StatusConflict, apierr.CodeBindPortInUse
	}
	if err := saveBind(b.home, host, port); err != nil {
		_ = ln.Close()
		b.mu.Lock()
		_ = saveBind(b.home, b.host, b.port)
		b.mu.Unlock()
		dmlog.Warnf(nil, "[bind] 저장 실패: %v", err)
		return http.StatusInternalServerError, apierr.CodeSaveFailed
	}

	b.mu.Lock()
	old, oldHost, oldPort := b.ln, b.host, b.port
	b.ln, b.host, b.port = ln, host, port
	// FR-HRB-32: 노출을 끄며 옮기면 노출된 옛 리스너를 유예로 남기지 않는다.
	keep := !dmenv.IsExposedHost(oldHost) || dmenv.IsExposedHost(host)
	if keep {
		b.grace[oldPort] = graceEntry{ln: old, host: oldHost}
	}
	b.mu.Unlock()
	if !keep {
		_ = old.Close()
	}
	b.serve(ln)

	s.Commands.Broadcast(sse.Payload("server_moving", map[string]any{"port": port}))
	time.AfterFunc(s.bindGrace, func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if g, in := b.grace[oldPort]; in && g.ln == old {
			delete(b.grace, oldPort)
			_ = g.ln.Close()
		}
	})
	return 0, ""
}

// swapHost 는 같은 포트를 다른 호스트로 다시 묶는다 (FR-HRB-24 / D-HRB-8). 새 리슨이
// 실패하면 옛 호스트로 다시 리슨한다.
func (s *Server) swapHost(b *rebinder, host string) (int, string) {
	b.mu.Lock()
	old, oldHost, port := b.ln, b.host, b.port
	b.mu.Unlock()

	_ = old.Close()
	ln, err := s.bindListen("tcp", net.JoinHostPort(host, port))
	if err == nil {
		if serr := saveBind(b.home, host, port); serr != nil {
			_ = ln.Close()
			_ = saveBind(b.home, oldHost, port)
			err = serr
		}
	}
	if err != nil {
		dmlog.Warnf(nil, "[bind] %s 로 다시 리슨하지 못했습니다: %v", net.JoinHostPort(host, port), err)
		back, berr := s.bindListen("tcp", net.JoinHostPort(oldHost, port))
		if berr != nil {
			dmlog.Errorf(nil, "[bind] 옛 바인드 %s 로도 돌아가지 못했습니다: %v", net.JoinHostPort(oldHost, port), berr)
			return http.StatusInternalServerError, apierr.CodeBindRebindFailed
		}
		b.mu.Lock()
		b.ln = back
		b.mu.Unlock()
		b.serve(back)
		return http.StatusConflict, apierr.CodeBindRebindFailed
	}
	b.mu.Lock()
	b.ln, b.host = ln, host
	b.mu.Unlock()
	b.serve(ln)
	return 0, ""
}
