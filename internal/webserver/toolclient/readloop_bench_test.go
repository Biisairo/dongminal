package toolclient

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net"
	"testing"
)

// FR-OPT-2-6 (IPC-13): output push 한 건을 받는 비용. 청크(8 KiB)마다 도는 가장
// 뜨거운 수신 경로다 — 전후 allocs/op 를 이 벤치로 잰다.
func BenchmarkReadLoopOutputPush(b *testing.B) {
	chunk := bytes.Repeat([]byte("x\x1b[31m"), 8192/6)
	line, _ := json.Marshal(map[string]interface{}{
		"event": "output", "tool": "t1",
		"data": base64.StdEncoding.EncodeToString(chunk), "end": 8192,
	})
	line = append(line, '\n')

	pc := &ToolClient{subbers: map[string]map[chan OutChunk]chan struct{}{}}
	pc.SetOnOutput(func(string, []byte, int64) {})
	client, server := net.Pipe()
	cd := make(chan struct{})
	done := make(chan struct{})
	go func() { pc.readLoop(client, cd); close(done) }()

	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := server.Write(line); err != nil {
			b.Fatal(err)
		}
	}
	pc.stopped.Store(true)
	server.Close()
	<-done
}
