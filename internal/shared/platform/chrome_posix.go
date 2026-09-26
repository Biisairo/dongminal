//go:build !windows

package platform

import (
	"io"
	"os"
	"os/exec"
	"sync"
)

// startPipedPosix 는 `ExtraFiles` 로 fd 3·4 를 잇는다 (FR-BRT-5). 새 세션으로 띄워
// Kill 이 자손(렌더러·GPU 프로세스)까지 닿는다.
func startPipedPosix(spec PipedSpec) (*PipedProcess, error) {
	childR, parentW, err := os.Pipe() // 자식의 fd 3
	if err != nil {
		return nil, err
	}
	parentR, childW, err := os.Pipe() // 자식의 fd 4
	if err != nil {
		childR.Close()
		parentW.Close()
		return nil, err
	}
	cmd := exec.Command(spec.Path, spec.Args...)
	cmd.Env = spec.Env
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if spec.Stderr != nil {
		cmd.Stderr = spec.Stderr
	}
	cmd.ExtraFiles = []*os.File{childR, childW}
	g := posixProcess{}.NewGroup(cmd)
	if err := cmd.Start(); err != nil {
		childR.Close()
		childW.Close()
		parentW.Close()
		parentR.Close()
		return nil, err
	}
	// 자식 쪽 끝은 자식이 가졌다. 부모가 들고 있으면 자식이 끝나도 EOF 가 오지 않는다.
	childR.Close()
	childW.Close()
	_ = g.Bind()
	var once sync.Once
	var werr error
	done := make(chan struct{})
	wait := func() error {
		once.Do(func() {
			werr = cmd.Wait()
			close(done)
		})
		<-done
		return werr
	}
	kill := func() error {
		err := g.Kill()
		parentW.Close()
		return err
	}
	return &PipedProcess{ToChild: parentW, FromChild: parentR, Pid: cmd.Process.Pid, wait: wait, kill: kill}, nil
}
