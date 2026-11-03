package lsp

import (
	"context"
	"io"
	"os/exec"
)

// Starter 는 언어 서버 프로세스를 세운다.
//
// 주입받는 이유는 검사다 — 실제 프로세스에 매이면 gopls 가 없는 기계에서는 통로
// 계층을 하나도 잴 수 없다.
type Starter func(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error)

// StartProcess 는 실제 프로세스를 stdio 로 세운다.
func StartProcess(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	stop := func() {
		// stdin 을 닫는 것이 LSP 서버에게 "끝났다" 를 말하는 관용이다. 그래도
		// 남으면 죽인다 — 안 죽이면 idle 정리가 아무것도 정리하지 않는다.
		_ = in.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}
	return rwPipes{r: out, w: in}, stop, nil
}

type rwPipes struct {
	r io.ReadCloser
	w io.WriteCloser
}

func (p rwPipes) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p rwPipes) Write(b []byte) (int, error) { return p.w.Write(b) }
func (p rwPipes) Close() error {
	_ = p.w.Close()
	return p.r.Close()
}
