package toolclient

import (
	"encoding/json"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-1 — 데몬 생존 확인.
//
// 정상 상태에 서버→데몬 RPC 가 없으므로, 소켓은 받되 답하지 않는 데몬(hung)은 RPC
// 시한으로 드러나지 않는다. supervisor 가 주기마다 hello 를 보내고 시한 안에 답이
// 없으면 연결을 끊어 재접속한다. hello 는 모든 판의 데몬이 받는 메서드다.

// hangAfterHelloFake 는 첫 연결의 hello 에만 답하고 그 뒤로는 읽기만 하는 데몬이다.
// 다음 연결부터는 모든 요청에 답한다. hellos 는 받은 hello 수다.
func hangAfterHelloFake(t *testing.T, hellos *atomic.Int64) string {
	t.Helper()
	sock := t.TempDir() + "/s"
	ln, err := platform.Current().IPC.Listen(sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for n := 0; ; n++ {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(n int) {
				defer conn.Close()
				dec := json.NewDecoder(conn)
				enc := json.NewEncoder(conn)
				for {
					var req toolipc.PanedRequest
					if dec.Decode(&req) != nil {
						return
					}
					if req.Method == toolipc.MethodHello {
						hellos.Add(1)
					}
					if n == 0 && req.Method == toolipc.MethodHello && req.ID == 0 {
						// 이 뒤로는 무엇에도 답하지 않는다 — 옛 데몬이 읽기 루프 안에서
						// 오래 걸리는 create 를 돌리는 동안의 모양이기도 하다.
						enc.Encode(toolipc.PanedResponse{ID: req.ID, Result: toolipc.HelloResult{Version: toolipc.ProtocolVersion}})
						_, _ = io.Copy(io.Discard, conn)
						return
					}
					if n > 0 {
						enc.Encode(toolipc.PanedResponse{ID: req.ID, Result: toolipc.HelloResult{Version: toolipc.ProtocolVersion}})
					}
				}
			}(n)
		}
	}()
	return sock
}

var testBeat = heartbeat{every: 20 * time.Millisecond, within: 100 * time.Millisecond}

func TestHeartbeatReconnectsHungDaemon(t *testing.T) {
	var hellos atomic.Int64
	pc, err := dialToolClient(hangAfterHelloFake(t, &hellos), nil, testBeat)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	// 주기 + 시한 + 첫 재접속 백오프(1 s) 안에 되살아나야 한다.
	deadline := time.Now().Add(testBeat.every + testBeat.within + 3*time.Second)
	for pc.Reconnects() == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("답하지 않는 데몬에서 재접속하지 않았다 (hello %d회)", hellos.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 진행 중인 호출이 있으면 생존 확인을 건너뛴다 — 그 호출이 자기 시한으로 잡는다. 옛
// 데몬은 create 를 읽기 루프 안에서 돌리므로(FR-OPT-2-3 이전) 그동안 hello 에도 답하지
// 않고, 이때 끊으면 샌드박스 생성이 기본 시한에서 잘린다.
func TestHeartbeatSkipsWhileCallPending(t *testing.T) {
	var hellos atomic.Int64
	pc, err := dialToolClient(hangAfterHelloFake(t, &hellos), nil, testBeat)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	within := 10 * (testBeat.every + testBeat.within)
	_, err = pc.callWithin(toolipc.MethodCreate, toolipc.CreateParams{}, within)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("err=%v — 생존 확인이 끊지 않고 호출이 자기 시한에 닿아야 한다", err)
	}
	if n := hellos.Load(); n != 1 {
		t.Fatalf("호출이 진행 중인 동안 hello %d회 — 접속 1회뿐이어야 한다", n)
	}
}

// 답하는 데몬은 끊지 않는다 — 생존 확인이 연결을 흔들지 않는다.
func TestHeartbeatKeepsLiveDaemon(t *testing.T) {
	sock, lines := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := dialToolClient(sock, nil, testBeat)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	// 접속 hello 하나 뒤로 생존 확인 hello 가 셋 오기를 기다린다. 인자는 접속 때와
	// 같다 — 데몬은 hello 마다 서버의 기능을 다시 적는다.
	var first string
	for i := 0; i < 4; i++ {
		select {
		case line := <-lines:
			var req toolipc.PanedRequest
			if json.Unmarshal([]byte(line), &req) != nil || req.Method != toolipc.MethodHello {
				t.Fatalf("생존 확인 줄=%s — hello 여야 한다", line)
			}
			if i == 0 {
				first = string(req.Params)
			} else if string(req.Params) != first {
				t.Fatalf("생존 확인 인자=%s — 접속 hello 와 같아야 한다 (%s)", req.Params, first)
			}
		case <-time.After(3 * time.Second):
			t.Fatalf("생존 확인 hello 가 %d번째에서 오지 않았다", i)
		}
	}
	if n := pc.Reconnects(); n != 0 {
		t.Fatalf("답하는 데몬에서 %d회 재접속했다", n)
	}
}
