package ipc

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"
)

// FR-OPT-2-6 (IPC-13): 데몬이 output 청크 하나를 와이어에 싣는 비용.
func BenchmarkPushOutputData(b *testing.B) {
	chunk := bytes.Repeat([]byte("x\x1b[31m"), 8192/6)
	pc := &panedConn{encoder: json.NewEncoder(io.Discard)}
	b.SetBytes(int64(len(chunk)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		pc.pushOutputData("t1", chunk, int64(i))
	}
}
