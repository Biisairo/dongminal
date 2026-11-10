package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/peer"
)

// FR-PNW-6: 노드 포트는 `/peer/v1/*` 만 받는다. 나머지는 404 다.
func TestPeerHandlerOnlyPeerPaths(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir(), StaticFS: os.DirFS(t.TempDir())}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	h := srv.peerHandler()
	for _, p := range []string{"/", "/index.html", "/api/tools", "/api/peers", "/ws", "/peer", "/peer/v2/node.info"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: code %d, 기대 404", p, rec.Code)
		}
	}
}

// FR-PNW-42: 모르는 명령은 404 와 `{code, message}` 다.
func TestPeerHandlerUnknownCommand(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	srv.peerHandler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/peer/v1/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code %d, 기대 404", rec.Code)
	}
	var body struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("본문이 JSON 이 아니다: %q", rec.Body.String())
	}
	if body.Code != apierr.CodeNotFound || body.Message == "" {
		t.Fatalf("본문 %+v", body)
	}
}

// FR-PNW-1: 서버를 만들면 노드 신원이 생긴다.
func TestNewCreatesNodeIdentity(t *testing.T) {
	home := t.TempDir()
	if _, err := New(Config{DataDir: home}, Deps{}); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(home, dmenv.NodeKeyFile))
	if err != nil {
		t.Fatalf("키 파일: %v", err)
	}
	if testpath.PermChecked() && st.Mode().Perm() != 0o600 {
		t.Fatalf("키 권한 %o", st.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(home, dmenv.NodeCertFile)); err != nil {
		t.Fatalf("인증서 파일: %v", err)
	}
	// NFR-PNW-1: 손대지 않은 설정 파일은 만들지 않는다.
	if _, err := os.Stat(filepath.Join(home, dmenv.PeersFile)); !os.IsNotExist(err) {
		t.Fatalf("peers.json 이 생겼다: %v", err)
	}
}

// NFR-PNW-1 · FR-PNW-4: 기본(꺼짐)이면 StartPeer 가 아무것도 열지 않는다.
func TestStartPeerDisabledByDefault(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	srv.StartPeer(stop)
	if st := srv.peerStatus(); st.Listening {
		t.Fatalf("꺼짐인데 듣는다: %+v", st)
	}
}

// FR-PNW-4: 켜져 있으면 StartPeer 가 열고, stop 이 닫는다.
func TestStartPeerEnabled(t *testing.T) {
	home := t.TempDir()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	cfg := peer.Config{Enabled: true, Port: port, Bind: "127.0.0.1", Name: "node-a"}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.PeersFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	done := srv.StartPeer(stop)
	st := srv.peerStatus()
	if !st.Listening {
		t.Fatalf("켜짐인데 듣지 않는다: %+v", st)
	}
	close(stop)
	<-done
	if c, err := net.Dial("tcp", st.Addr); err == nil {
		_ = c.Close()
		t.Fatal("stop 뒤에도 포트가 열려 있다")
	}
}

// 직접 지은 Server(신원 없음)에서도 패닉하지 않는다.
func TestStartPeerWithoutStore(t *testing.T) {
	srv := &Server{}
	stop := make(chan struct{})
	close(stop)
	<-srv.StartPeer(stop)
	if st := srv.peerStatus(); st.Listening {
		t.Fatalf("상태 %+v", st)
	}
}
