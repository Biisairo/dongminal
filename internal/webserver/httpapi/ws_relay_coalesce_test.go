package httpapi

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/toolclient"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-7 (HTTP-6) — 채널에 쌓인 연속 출력은 relayCoalesceMax
// 안에서 한 프레임으로 합친다. 크기 조각 앞에서는 먼저 내보내 순서를 지킨다.

// 1 KiB 조각 100개(100 KiB)가 쌓여 있으면 프레임은 2개다 (64 KiB 상한). 종전은 100개.
func TestRelayOutput_CoalescesBacklog(t *testing.T) {
	srvConn, cli, cleanup := wsPair(t)
	defer cleanup()

	const n, size = 100, 1 << 10
	out := make(chan toolclient.OutChunk, n)
	var want []byte
	for i := 0; i < n; i++ {
		d := bytes.Repeat([]byte{byte('a' + i%26)}, size)
		want = append(want, d...)
		out <- toolclient.OutChunk{Data: d, End: int64((i + 1) * size)}
	}
	exit := make(chan struct{})
	done := make(chan struct{})
	fin := make(chan struct{})
	go func() { relayOutput(srvConn, "t1", out, exit, done, 0); close(fin) }()

	var got []byte
	frames := 0
	for len(got) < len(want) {
		cli.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, msg, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("read after %d frames (%d bytes): %v", frames, len(got), err)
		}
		if msg[0] != toolhub.OpOutput {
			t.Fatalf("op=0x%02x", msg[0])
		}
		if len(msg)-1 > relayCoalesceMax {
			t.Fatalf("프레임 %d 바이트 — 상한 %d 를 넘었다", len(msg)-1, relayCoalesceMax)
		}
		got = append(got, msg[1:]...)
		frames++
	}
	if !bytes.Equal(got, want) {
		t.Fatal("합친 바이트가 원본과 다르다")
	}
	if frames != 2 {
		t.Fatalf("프레임 %d개 — 2 여야 한다 (100 KiB / 64 KiB)", frames)
	}
	close(done)
	<-fin
}

// 크기 조각은 합치지 않고, 그 앞의 출력을 먼저 내보낸다.
func TestRelayOutput_FlushesBeforeSize(t *testing.T) {
	srvConn, cli, cleanup := wsPair(t)
	defer cleanup()

	out := make(chan toolclient.OutChunk, 8)
	out <- toolclient.OutChunk{Data: []byte("ab"), End: 2}
	out <- toolclient.OutChunk{Data: []byte("cd"), End: 4}
	out <- toolclient.OutChunk{Size: &toolhub.TermSize{Cols: 90, Rows: 20}}
	out <- toolclient.OutChunk{Data: []byte("ef"), End: 6}
	exit := make(chan struct{})
	done := make(chan struct{})
	fin := make(chan struct{})
	go func() { relayOutput(srvConn, "t1", out, exit, done, 0); close(fin) }()

	read := func() []byte {
		cli.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, msg, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		return msg
	}
	if m := read(); m[0] != toolhub.OpOutput || string(m[1:]) != "abcd" {
		t.Fatalf("첫 프레임=%q want abcd", m)
	}
	if m := read(); m[0] != toolhub.OpSize || binary.BigEndian.Uint16(m[1:3]) != 90 {
		t.Fatalf("둘째 프레임=%q want size 90x20", m)
	}
	if m := read(); m[0] != toolhub.OpOutput || string(m[1:]) != "ef" {
		t.Fatalf("셋째 프레임=%q want ef", m)
	}
	close(done)
	<-fin
}

// 합치는 중에 구멍을 만나면 앞부분만 내보내고 닫는다 — 구멍 뒤는 나가지 않는다.
func TestRelayOutput_CoalesceStopsAtGap(t *testing.T) {
	srvConn, cli, cleanup := wsPair(t)
	defer cleanup()

	out := make(chan toolclient.OutChunk, 4)
	out <- toolclient.OutChunk{Data: []byte("ab"), End: 2}
	out <- toolclient.OutChunk{Data: []byte("cd"), End: 4}
	out <- toolclient.OutChunk{Data: []byte("yz"), End: 9}
	exit := make(chan struct{})
	done := make(chan struct{})
	defer close(done)
	fin := make(chan struct{})
	go func() { relayOutput(srvConn, "t1", out, exit, done, 0); close(fin) }()

	cli.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, msg, err := cli.ReadMessage()
	if err != nil || msg[0] != toolhub.OpOutput || string(msg[1:]) != "abcd" {
		t.Fatalf("첫 프레임=%q err=%v", msg, err)
	}
	if _, msg, err := cli.ReadMessage(); err == nil {
		t.Fatalf("구멍 뒤의 조각이 나갔다: %q", msg)
	}
	select {
	case <-fin:
	case <-time.After(3 * time.Second):
		t.Fatal("구멍을 보고도 릴레이가 끝나지 않았다")
	}
}
