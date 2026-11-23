// gopeer 는 Rust 간선 계층과의 상호 운용 시험(RUST_PORT_SRS FR-RSP-23)에 쓰는 Go 노드 둘이다.
// g1 과 g2 를 메모리 연결로 잇고, g1 이 127.0.0.1:-port 로 들어오는 연결 하나를 -peer 지문의
// 간선으로 붙인다. 표준 입력의 명령에 답하고 사건을 표준 출력에 한 줄씩 적는다.
//
//	go build -o rust/target/go-ref/meshpeer ./rust/crates/shared/edgemesh/testdata/gopeer
package main

import (
	"bufio"
	"flag"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgemesh"
)

var outMu sync.Mutex

func say(format string, a ...any) {
	outMu.Lock()
	defer outMu.Unlock()
	fmt.Printf(format+"\n", a...)
}

func newNode(who, name, dir string) (*edgemesh.Mesh, edge.Identity) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		say("fatal %v", err)
		os.Exit(1)
	}
	id, err := edge.LoadOrCreateIdentity(dir)
	if err != nil {
		say("fatal %v", err)
		os.Exit(1)
	}
	m := edgemesh.New(edgemesh.Options{
		Identity: id,
		Name:     func() string { return name },
		Hello:    func() edgemesh.Hello { return edgemesh.Hello{Name: name, Addr: "10.9.9.9", Port: 7777} },
		OnHello: func(fp string, h edgemesh.Hello, _ string) {
			say("hello %s %s %q %s %d", who, fp, h.Name, h.Addr, h.Port)
		},
		OnInvite: func(inv edgemesh.Invite) {
			say("invite %s %s %q %s", who, inv.From, inv.Name, inv.Code)
		},
	})
	return m, id
}

func main() {
	port := flag.Int("port", 0, "들을 포트")
	peer := flag.String("peer", "", "붙일 상대 지문")
	dir := flag.String("dir", "", "신원 디렉터리")
	flag.Parse()

	g1, id1 := newNode("g1", "g1<&>", *dir+"/g1")
	g2, id2 := newNode("g2", "g2", *dir+"/g2")
	p1, p2 := net.Pipe()
	g1.Attach(id2.Fingerprint, p1, true)
	g2.Attach(id1.Fingerprint, p2, false)
	nodes := map[string]*edgemesh.Mesh{"g1": g1, "g2": g2}
	ids := map[string]edge.Identity{"g1": id1, "g2": id2}

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", *port))
	if err != nil {
		say("fatal %v", err)
		os.Exit(1)
	}
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		g1.Attach(*peer, c, false)
	}()
	say("ready %s %s", id1.Fingerprint, id2.Fingerprint)

	sc := bufio.NewScanner(os.Stdin)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "nodes":
			var parts []string
			for _, n := range nodes[f[1]].Nodes() {
				parts = append(parts, fmt.Sprintf("%s=%q/%v", n.FP, n.Name, n.Online))
			}
			say("nodes %s %s", f[1], strings.Join(parts, " "))
		case "invite":
			from, to := f[1], f[2]
			code := edge.EncodeInvite(edge.InviteCode{Addr: "10.0.0.2", Port: 7002, Fingerprint: ids[from].Fingerprint, Token: "gotok"})
			err := nodes[from].SendInvite(to, code, time.Now().Add(edge.InviteTTL))
			say("sent %s %v %s", from, err, code)
		}
	}
	g1.Close()
	g2.Close()
}
