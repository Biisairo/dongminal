//go:build windows

package platform

import (
	"bufio"
	"os"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TC-BRT-6: `lpReserved2` 로 띄운 자식이 fd 3 을 읽고 fd 4 에 쓴다. 자식은 이 시험
// 바이너리 자신이며, 자기 STARTUPINFO 에서 표를 되읽어 핸들을 찾는다.
func TestPipedChildReadsFD3WritesFD4(t *testing.T) {
	if os.Getenv("DM_PIPE_HELPER") == "1" {
		pipeHelperChild()
		return
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	p, err := startPipedWindows(PipedSpec{Path: exe,
		Args: []string{"-test.run=^TestPipedChildReadsFD3WritesFD4$"},
		Env:  append(os.Environ(), "DM_PIPE_HELPER=1")})
	if err != nil {
		t.Fatalf("startPipedWindows: %v", err)
	}
	defer p.Kill()
	if _, err := p.ToChild.Write([]byte("ping\x00")); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := make(chan string, 1)
	go func() {
		s, _ := bufio.NewReader(p.FromChild).ReadString(0)
		got <- s
	}()
	select {
	case s := <-got:
		if s != "pong:ping\x00" {
			t.Fatalf("got %q", s)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("자식이 답하지 않았다")
	}
}

func pipeHelperChild() {
	var si windows.StartupInfo
	windows.GetStartupInfo(&si)
	crt := (*startupInfoCRT)(unsafe.Pointer(&si))
	if crt.LpReserved2 == nil {
		os.Exit(3)
	}
	buf := unsafe.Slice(crt.LpReserved2, int(crt.CbReserved2))
	hs, _, err := decodeCRTFDs(buf, int(unsafe.Sizeof(uintptr(0))))
	if err != nil || len(hs) < 5 {
		os.Exit(4)
	}
	in := os.NewFile(uintptr(hs[3]), "fd3")
	out := os.NewFile(uintptr(hs[4]), "fd4")
	s, err := bufio.NewReader(in).ReadString(0)
	if err != nil {
		os.Exit(5)
	}
	out.Write([]byte("pong:" + s))
	out.Close()
	os.Exit(0)
}
