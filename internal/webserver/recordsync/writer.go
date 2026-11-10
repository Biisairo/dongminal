// Package recordsync 는 서버가 에이전트 기록을 데몬에 쓰는 큐다
// (AGENT_RECORD_DAEMON_SRS FR-ARD-11, §3.1a).
//
// 쓰기는 부르는 쪽을 막지 않는다. 서버의 알람 판정은 toolclient 읽기 루프 안에서
// 돌고, 그 자리에서 데몬 응답을 기다리면 응답을 읽을 고루틴이 자기 자신이다.
package recordsync

import (
	"encoding/json"
	"errors"
	"sync"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolipc"
)

// Sender 는 기록 하나를 데몬에 보낸다 (toolclient.ToolClient.RecordSet).
type Sender func(kind, tool string, v json.RawMessage) error

type key struct{ kind, tool string }

// Writer 는 (kind, tool) 마다 마지막 값 하나를 두고 보낸다.
//   - 연결 오류로 실패한 값은 남겨 두었다가 다음 Put·Flush 때 다시 보낸다
//   - 데몬이 거절한 값(*toolipc.RPCError)은 버린다
//
// nil Writer 는 아무것도 하지 않는다 — 옛 데몬이나 직접 모드다 (FR-ARD-14).
type Writer struct {
	send Sender
	kick chan struct{}

	mu      sync.Mutex
	pending map[key]json.RawMessage

	// sendMu 는 보내기를 한 줄로 세운다 — 배경 고루틴과 Flush 가 겹치지 않는다.
	sendMu sync.Mutex
}

func New(send Sender) *Writer {
	return &Writer{send: send, kick: make(chan struct{}, 1), pending: map[key]json.RawMessage{}}
}

// Start 는 Put 을 받아 보내는 고루틴을 띄운다. stop 이 닫히면 멈춘다.
func (w *Writer) Start(stop <-chan struct{}) {
	if w == nil {
		return
	}
	go func() {
		for {
			select {
			case <-w.kick:
				w.Flush()
			case <-stop:
				return
			}
		}
	}()
}

// Put 은 v 를 JSON 으로 바꿔 줄에 넣는다. v 가 nil 이면 그 기록을 지우는 쓰기다.
func (w *Writer) Put(kind, tool string, v any) {
	if w == nil {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		dmlog.Errorf(nil, "recordsync: %s/%s 부호화 실패: %v", kind, tool, err)
		return
	}
	w.mu.Lock()
	w.pending[key{kind, tool}] = raw
	w.mu.Unlock()
	select {
	case w.kick <- struct{}{}:
	default:
	}
}

// Flush 는 줄에 있는 값을 지금 보낸다. 연결 오류가 나면 그 값을 남기고 멈춘다.
func (w *Writer) Flush() {
	if w == nil {
		return
	}
	w.sendMu.Lock()
	defer w.sendMu.Unlock()
	for {
		k, v, ok := w.take()
		if !ok {
			return
		}
		err := w.send(k.kind, k.tool, v)
		if err == nil {
			continue
		}
		var rpc *toolipc.RPCError
		if errors.As(err, &rpc) {
			// 끝난 도구의 쓰기(종료 때의 ended 활동)는 데몬이 이미 지운 뒤라 없다고 답한다.
			// 정상이므로 남기지 않는다.
			if rpc.Code != toolipc.CodeNotFound {
				dmlog.Warnf(nil, "recordsync: 데몬이 %s/%s 를 거절했다 — 거울에만 남는다: %v", k.kind, k.tool, err)
			}
			continue
		}
		w.restore(k, v)
		return
	}
}

func (w *Writer) take() (key, json.RawMessage, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for k, v := range w.pending {
		delete(w.pending, k)
		return k, v, true
	}
	return key{}, nil, false
}

// restore 는 보내지 못한 값을 되돌린다. 그사이 새 값이 왔으면 새 값을 둔다.
func (w *Writer) restore(k key, v json.RawMessage) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, newer := w.pending[k]; !newer {
		w.pending[k] = v
	}
}
