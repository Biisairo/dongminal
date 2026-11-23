// gotoolclient 는 Go toolclient 가 Rust 데몬의 paned 소켓에 붙어 도구 하나를 다루는지 본다
// (dm-daemon-ipc 의 tests::go_toolclient_interop 가 격리 환경에서 실행한다).
//
//	gotoolclient <paned 소켓> <cwd>
package main

import (
	"bytes"
	"fmt"
	"os"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/toolclient"
)

func main() {
	if err := run(os.Args[1], os.Args[2]); err != nil {
		fmt.Println("FAIL:", err)
		os.Exit(1)
	}
	fmt.Println("OK")
}

func run(sock, cwd string) error {
	pc, err := toolclient.DialToolClient(sock)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	if !pc.Connected() {
		return fmt.Errorf("연결되지 않았다")
	}
	got := make(chan []byte, 64)
	pc.SetOnOutput(func(_ string, data []byte, _ int64) { got <- append([]byte(nil), data...) })
	t, err := pc.Create(cwd, 80, 24, toolhub.Placement{})
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if pc.Get(t.ID) == nil {
		return fmt.Errorf("목록에 새 도구 %s 가 없다", t.ID)
	}
	if err := pc.Write(t.ID, []byte("echo go-$((40+2))\n")); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		s, err := pc.SnapshotTool(t.ID)
		if err != nil {
			return fmt.Errorf("snapshot: %w", err)
		}
		if bytes.Contains(s.Data, []byte("go-42")) {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("셸 출력이 오지 않는다: %q", s.Data)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := pc.Resize(t.ID, 100, 30); err != nil {
		return fmt.Errorf("resize: %w", err)
	}
	if _, ok := pc.BusyMany([]string{t.ID}); !ok {
		return fmt.Errorf("busymany 가 실패했다")
	}
	if err := pc.Delete(t.ID); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	if pc.IsLive(t.ID) {
		return fmt.Errorf("지운 도구가 살아 있다")
	}
	select {
	case <-got:
	default:
		return fmt.Errorf("output push 를 받지 못했다")
	}
	return nil
}
