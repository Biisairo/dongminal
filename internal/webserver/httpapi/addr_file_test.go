package httpapi

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"

	"dongminal/internal/shared/serverconf"
)

// TC-HRB-4 (HOT_REBIND_SRS FR-HRB-10): 리슨에 성공하면 주소 파일을 쓰고, 정상 종료 때 지운다.
func TestRunWritesAndRemovesAddrFile(t *testing.T) {
	home := t.TempDir()
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)
	_ = ln.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx, net.JoinHostPort("127.0.0.1", port)) }()

	deadline := time.Now().Add(3 * time.Second)
	for {
		if h, p, ok := serverconf.ReadAddr(home); ok {
			if h != "127.0.0.1" || p != port {
				t.Fatalf("주소 파일 = %s:%s want 127.0.0.1:%s", h, p, port)
			}
			break
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("주소 파일이 써지지 않았다")
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, _, ok := serverconf.ReadAddr(home); ok {
		t.Error("정상 종료 뒤에도 주소 파일이 남았다")
	}
}

// 리슨에 실패하면 주소 파일을 쓰지 않는다.
func TestRunListenFailureWritesNoAddr(t *testing.T) {
	home := t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	srv, err := New(Config{DataDir: home}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.Run(context.Background(), ln.Addr().String()); err == nil {
		t.Fatal("쓰이는 포트에서 Run 이 성공했다")
	}
	if _, _, ok := serverconf.ReadAddr(home); ok {
		t.Error("리슨 실패인데 주소 파일을 썼다")
	}
}
