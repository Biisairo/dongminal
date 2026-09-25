package toolhub

import (
	"bytes"
	"testing"

	"dongminal/internal/shared/outbuf"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-3-2 (SHR-3 · SHR-4) — readPTY 청크 하나의 비용.
// 전후 allocs/op 를 이 벤치로 잰다.

// hotpathTUIChunk 는 TUI 에이전트 출력의 모양이다 — 색·커서 이동 CSI 가 줄마다 있고
// 모드 설정 하나와 OSC 하나가 섞인다.
func hotpathTUIChunk() []byte {
	var b bytes.Buffer
	b.WriteString("\x1b[?2004h\x1b]0;title\x07")
	for b.Len() < 8<<10-64 {
		b.WriteString("\x1b[38;5;244m│\x1b[0m some agent output text \x1b[K\r\n")
	}
	return b.Bytes()
}

func hotpathPlainChunk() []byte { return bytes.Repeat([]byte("plain output line\r\n"), 8<<10/19) }

func newHotpathTool(relay bool) *Tool {
	p := NewDetachedTool("bench", &ToolHooks{OnAttention: func(string, string) {}})
	p.stream = outbuf.NewStream(bufMax)
	if relay {
		p.relay.Store(&toolRelay{onOutput: func(string, []byte, int64) {}})
	}
	return p
}

func benchHandleChunk(b *testing.B, relay bool, chunk []byte) {
	p := newHotpathTool(relay)
	b.ReportAllocs()
	b.SetBytes(int64(len(chunk)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		p.handleChunk(chunk)
	}
}

func BenchmarkHandleChunkPlainNoClients(b *testing.B) {
	benchHandleChunk(b, false, hotpathPlainChunk())
}
func BenchmarkHandleChunkPlainRelay(b *testing.B)   { benchHandleChunk(b, true, hotpathPlainChunk()) }
func BenchmarkHandleChunkTUINoClients(b *testing.B) { benchHandleChunk(b, false, hotpathTUIChunk()) }
func BenchmarkHandleChunkTUIRelay(b *testing.B)     { benchHandleChunk(b, true, hotpathTUIChunk()) }

// hotpathColorChunk 는 색·커서 CSI 만 있는 청크다 — TUI 출력의 대부분이 이 모양이다.
func hotpathColorChunk() []byte {
	return bytes.TrimPrefix(hotpathTUIChunk(), []byte("\x1b[?2004h\x1b]0;title\x07"))
}

func BenchmarkHandleChunkColorNoClients(b *testing.B) {
	benchHandleChunk(b, false, hotpathColorChunk())
}
