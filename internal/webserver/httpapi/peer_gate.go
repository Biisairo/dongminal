package httpapi

import (
	"context"
	"errors"
	"sync"
)

// 원격 글의 도구별 전달 상태 (PEER_NETWORK_SRS I-59·I-70·I-73).
//
// 한 도구에는 원격 전달이 동시에 1건이다. 넘친 요청은 기다리지 않고 거절한다 — 데몬은
// 같은 도구의 paste 를 한 줄로 돌리므로(I-68), 줄이 길어지면 연결 시한을 넘는다.
// agent.close 는 그 도구를 "닫는 중" 으로 세우고 진행 중인 전달이 끝나기를 기다린다.
// 다른 도구의 전달은 기다리지 않는다.

var (
	errPeerToolBusy    = errors.New("그 도구에 원격 글을 넣는 중이다")
	errPeerToolClosing = errors.New("그 도구를 닫는 중이다")
)

type peerGate struct {
	mu sync.Mutex
	m  map[string]*peerGateState
}

type peerGateState struct {
	busy bool
	// closing 은 그 도구를 닫는 중인 close 의 수다. 겹친 close 가 모두 끝나야 풀린다.
	closing int
	// idle 은 진행 중인 전달이 끝나면 닫힌다. 기다리는 쪽(close·enterWait)이 있을 때만 있다.
	idle chan struct{}
}

func (g *peerGate) state(id string) *peerGateState {
	if g.m == nil {
		g.m = map[string]*peerGateState{}
	}
	st := g.m[id]
	if st == nil {
		st = &peerGateState{}
		g.m[id] = st
	}
	return st
}

// forgetIfIdle 은 쓰이지 않는 상태를 지운다. 맵에 있는 것이 그 상태일 때만 지운다 — 지난
// 상태의 정리가 새로 생긴 상태를 지우지 않게 한다.
func (g *peerGate) forgetIfIdle(id string, st *peerGateState) {
	if !st.busy && st.closing == 0 && g.m[id] == st {
		delete(g.m, id)
	}
}

// enterLocked 는 g.mu 를 쥔 채 자리를 연다.
func (g *peerGate) enterLocked(id string, st *peerGateState) (leave func(), err error) {
	switch {
	case st.closing > 0:
		g.forgetIfIdle(id, st)
		return nil, errPeerToolClosing
	case st.busy:
		return nil, errPeerToolBusy
	}
	st.busy = true
	return func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		st.busy = false
		if st.idle != nil {
			close(st.idle)
			st.idle = nil
		}
		g.forgetIfIdle(id, st)
	}, nil
}

// enter 는 id 에 전달 하나를 연다. 닫는 중이면 errPeerToolClosing, 이미 넣는 중이면
// errPeerToolBusy 다. 열었으면 끝날 때 leave 를 부른다.
func (g *peerGate) enter(id string) (leave func(), err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.enterLocked(id, g.state(id))
}

// enterWait 는 enter 와 같되, 넣는 중이면 ctx 안에서 자리가 빌 때까지 기다린다. 확인과
// 들어가기는 한 잠금 안에서 한다. spawn 첫 프롬프트용이다 — 다른 짝의 message.send 가
// 자리를 쥐었다고 띄운 쪽의 프롬프트를 버리지 않는다.
func (g *peerGate) enterWait(ctx context.Context, id string) (leave func(), err error) {
	for {
		g.mu.Lock()
		st := g.state(id)
		if !st.busy || st.closing > 0 {
			leave, err = g.enterLocked(id, st)
			g.mu.Unlock()
			return leave, err
		}
		if st.idle == nil {
			st.idle = make(chan struct{})
		}
		wait := st.idle
		g.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// close 는 id 를 닫는 중으로 세우고 진행 중인 전달이 끝나기를 ctx 안에서 기다린다. 돌려준
// 함수가 표시를 거둔다. 기다리다 ctx 가 끝나도 표시는 선 채로 돌려준다.
func (g *peerGate) close(ctx context.Context, id string) (done func()) {
	g.mu.Lock()
	st := g.state(id)
	st.closing++
	var wait chan struct{}
	if st.busy {
		if st.idle == nil {
			st.idle = make(chan struct{})
		}
		wait = st.idle
	}
	g.mu.Unlock()
	if wait != nil {
		select {
		case <-wait:
		case <-ctx.Done():
		}
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			st.closing--
			g.forgetIfIdle(id, st)
		})
	}
}
