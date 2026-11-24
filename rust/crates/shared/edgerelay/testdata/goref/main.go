// relayref 는 Rust edgerelay 의 상호 운용 시험(tests/go_interop.rs)이 부르는 Go 참조 프로그램이다.
//
//	relayref dialsrv <sock>          발신 소켓을 연다
//	relayref node <sock>             노드 소켓을 열고 연결 하나를 받아 "remote <주소>" 를 찍고 한 줄을 되돌린다
//	relayref port <nodesock> <port>  노드 포트를 연다
//	relayref dial <sock> <addr>      발신 소켓으로 addr 에 붙어 "ping" 을 보내고 답을 찍는다
package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strconv"

	"dongminal/internal/shared/edgerelay"
)

func main() {
	switch os.Args[1] {
	case "dialsrv":
		ln, err := edgerelay.ListenDial(os.Args[2])
		if err != nil {
			fmt.Println("err", err)
			return
		}
		fmt.Println("ready")
		edgerelay.ServeDial(ln)
	case "node":
		ln, err := edgerelay.ListenNode(os.Args[2])
		if err != nil {
			fmt.Println("err", err)
			return
		}
		fmt.Println("ready")
		c, err := ln.Accept()
		if err != nil {
			fmt.Println("err", err)
			return
		}
		fmt.Println("remote", c.RemoteAddr().String())
		line, _ := bufio.NewReader(c).ReadString('\n')
		_, _ = c.Write([]byte(line))
		select {}
	case "port":
		p := edgerelay.NewPort(os.Args[2])
		port, _ := strconv.Atoi(os.Args[3])
		p.Apply(true, "127.0.0.1", port)
		fmt.Println("ready", p.Status().Listening)
		select {}
	case "dial":
		c, err := edgerelay.Dialer(os.Args[2])(context.Background(), "tcp", os.Args[3])
		if err != nil {
			fmt.Println("err", err)
			return
		}
		_, _ = c.Write([]byte("ping\n"))
		line, _ := bufio.NewReader(c).ReadString('\n')
		fmt.Print("got ", line)
	}
}
