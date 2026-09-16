package ipc

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolhub"

	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `paned.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **유닉스 소켓 서버**다 — 듣고, 받고, 닫는다. 위쪽의 연결 하나가
// 무엇을 하는지와는 다른 층이다.

// ── Unix socket server ──────────────────────────────────────────────────

type PanedServer struct {
	pm       *toolhub.ToolManager
	sockPath string
	pidPath  string
	// buildVersion 은 `hello` 가 싣는 빌드 판이다 (FR-VHL-1). `mu` 아래 둔다 —
	// 연결 수락과 같은 잠금이다.
	buildVersion string

	mu       sync.Mutex
	listener net.Listener
	currConn *panedConn
}

// dialProbeTimeout 은 "이미 살아 있는 데몬이 있는가" 를 묻는 시도의 상한이다.
// 로컬 종단이므로 응답은 즉시 오거나 오지 않는다.
const dialProbeTimeout = 2 * time.Second

// SetBuildVersion 은 이 데몬의 빌드 판을 새긴다 (FR-VHL-1).
//
// 값을 **주입받는** 이유는 층 때문이다. 판의 단일 출처는 `internal/ctl/cli.Version`
// 이고(빌드 때 ldflags 로 새겨진다) 데몬 층이 그것을 import 하면 아래에서 위를
// 보게 된다. `boot.Run(home, version)` 이 이미 그 값을 들고 있으므로 여기까지
// 잇기만 하면 된다.
//
// 새기지 않으면 **빈 값**이다. 빈 것은 "모른다" 이지 불일치가 아니다 (FR-VHL-5).
func (ps *PanedServer) SetBuildVersion(v string) {
	ps.mu.Lock()
	ps.buildVersion = v
	ps.mu.Unlock()
}

func NewPanedServer(pm *toolhub.ToolManager, sockPath, pidPath string) *PanedServer {
	ps := &PanedServer{pm: pm, sockPath: sockPath, pidPath: pidPath}
	// PTY 를 소유한 것은 데몬이므로 전경 조회도 여기서 일어난다 (FR-TAN-7).
	// 값은 list 응답에도 실리고, 바뀐 순간에는 이 push 로도 나간다 — 어느
	// 연결이 현재인지는 wireTool 과 같이 호출 시점에 푼다.
	pm.SetForegroundNotifier(func(toolID, name string) {
		ps.mu.Lock()
		c := ps.currConn
		ps.mu.Unlock()
		if c != nil {
			c.pushForeground(toolID, name)
		}
	})
	// PTY 를 소유한 것이 데몬이므로 크기가 바뀐 것을 아는 자리도 여기다
	// (FR-M9-3 ②). 직접 모드에서는 이 배선이 없고 `Tool.broadcast` 가 같은
	// 일을 그 프로세스 안에서 끝낸다 — **두 모드가 같은 바이트를 낸다**.
	pm.SetResizeNotifier(func(toolID string, cols, rows uint16) {
		ps.mu.Lock()
		c := ps.currConn
		ps.mu.Unlock()
		if c != nil {
			c.pushSize(toolID, cols, rows)
		}
	})
	return ps
}

func (ps *PanedServer) Listen() error {
	// Guard against clobbering a live daemon's socket (concurrent cold starts).
	// If the existing socket still answers, another dongminald owns it — abort
	// rather than removing it and stealing its tools. A stale socket (dial
	// fails) is safe to remove.
	transport := platform.Current().IPC
	if conn, err := transport.Dial(ps.sockPath, dialProbeTimeout); err == nil {
		conn.Close()
		return fmt.Errorf("paned: %s already served by a live daemon", ps.sockPath)
	}
	transport.Remove(ps.sockPath)
	// 04-secops P1-6: 소켓이 사는 자리는 0700 이다.
	if err := os.MkdirAll(filepath.Dir(ps.sockPath), 0o700); err != nil {
		return err
	}
	ln, err := transport.Listen(ps.sockPath)
	if err != nil {
		return err
	}
	ps.listener = ln
	if ps.pidPath != "" {
		// `GO-36`: **반환값을 버리지 않는다.** pidfile 이 쓰이지 않으면 `stop` 이
		// 이 데몬을 찾지 못해 정지도 재접속도 못 하는 고아가 된다 — 그 사실이
		// 기록 없이 지나가면 원인을 찾을 수 없다. 기동을 막지는 않는다: 소켓은
		// 이미 열렸고, pidfile 은 편의이지 기동의 조건이 아니다.
		if err := os.WriteFile(ps.pidPath, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
			dmlog.Errorf(nil, "paned: pidfile 쓰기 실패 %s: %v", ps.pidPath, err)
		}
	}
	return nil
}

func (ps *PanedServer) Accept() error {
	conn, err := ps.listener.Accept()
	if err != nil {
		return err
	}

	ps.mu.Lock()
	// Close previous connection
	if ps.currConn != nil {
		ps.currConn.stop()
	}

	pc := newPanedConn(conn, ps.pm)
	// FR-VHL-1: 연결마다 빌드 판을 내린다.
	//
	// **여기서 다시 잠그지 마라** — 이 함수는 위에서 이미 `ps.mu` 를 쥐고 있고,
	// `sync.Mutex` 는 재진입이 아니다. 한 번 그렇게 걸었더니 hello 가 영영
	// 답하지 않았고, 증상은 "연결이 그냥 실패한다" 였다 (2026-09-11).
	pc.build = ps.buildVersion

	// Wire output/exit from each tool through whichever dongminal connection
	// is current. The closures resolve ps.currConn dynamically, so a tool only
	// needs to be wired ONCE for its lifetime — reconnects reuse the same
	// closures and just swap currConn. `p.wired` guards against re-wiring
	// (which would nest exit handlers and re-trigger pushes). (FR-12)
	pc.wireTool = func(p *toolhub.Tool) {
		p.WireRelayOnce(func(baseExit func(string)) (func(string, []byte, int64), func(string)) {
			return func(toolID string, data []byte, end int64) {
					ps.mu.Lock()
					c := ps.currConn
					ps.mu.Unlock()
					if c != nil {
						c.pushOutputData(toolID, data, end)
					}
				}, func(toolID string) {
					ps.mu.Lock()
					c := ps.currConn
					ps.mu.Unlock()
					if c != nil {
						c.pushExit(toolID, p.ExitInfo())
					}
					if baseExit != nil {
						baseExit(toolID)
					}
				}
		})
	}
	for _, p := range ps.pm.Snapshot() {
		pc.wireTool(p)
	}
	ps.currConn = pc
	ps.mu.Unlock()

	return pc.handle()
}

func (ps *PanedServer) Close() error {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	if ps.currConn != nil {
		ps.currConn.stop()
	}
	if ps.listener != nil {
		ps.listener.Close()
	}
	platform.Current().IPC.Remove(ps.sockPath)
	if ps.pidPath != "" {
		os.Remove(ps.pidPath)
	}
	return nil
}
