package toolhub

import (
	"context"
	"errors"
	"sync"
	"time"

	"dongminal/internal/shared/pollwait"

	"dongminal/internal/shared/platform"
)

// 데몬 교체 전의 멈춤 (DAEMON_SESSION_KEEP_SRS FR-DSK-13 2·NFR-DSK-2).
//
// 멈춘 도구의 읽기 루프는 제자리에서 기다리고, 그동안의 출력은 커널 버퍼에 남는다. 그래서
// 인계 상태에 담은 스트림 뒤로 잃는 바이트가 없다.

type freezeState struct {
	mu   sync.Mutex
	cond *sync.Cond
	// frozen 은 멈춤 요청이다. parked 는 읽기 루프가 실제로 멈췄다는 사실이고, readDone 은
	// 읽기 루프가 끝났다는 사실이다 — 둘 중 하나여야 Freeze 가 돌아온다.
	frozen   bool
	parked   bool
	readDone bool
}

func (f *freezeState) init() {
	f.mu.Lock()
	if f.cond == nil {
		f.cond = sync.NewCond(&f.mu)
	}
	f.mu.Unlock()
}

// Freeze 는 이 도구의 읽기를 멈추고, 읽기 루프가 멈출 때까지 기다린다. 터미널이 멈춤을
// 모르면(Windows, 합성 도구) 거짓이다.
func (p *Tool) Freeze() bool {
	h, ok := p.term.(platform.Handover)
	if !ok {
		return false
	}
	f := &p.frz
	f.init()
	f.mu.Lock()
	f.frozen = true
	f.mu.Unlock()
	h.Freeze()
	f.mu.Lock()
	for !f.parked && !f.readDone {
		f.cond.Wait()
	}
	f.mu.Unlock()
	return true
}

// Thaw 는 Freeze 를 되돌린다.
func (p *Tool) Thaw() {
	h, ok := p.term.(platform.Handover)
	if !ok {
		return
	}
	f := &p.frz
	f.init()
	f.mu.Lock()
	f.frozen = false
	f.mu.Unlock()
	h.Thaw()
	f.mu.Lock()
	f.cond.Broadcast()
	f.mu.Unlock()
}

// parkWhileFrozen 은 읽기 루프가 멈춤 요청 동안 머무는 자리다.
func (p *Tool) parkWhileFrozen() {
	f := &p.frz
	f.init()
	f.mu.Lock()
	f.parked = true
	f.cond.Broadcast()
	for f.frozen {
		f.cond.Wait()
	}
	f.parked = false
	f.mu.Unlock()
}

// markReadDone 은 읽기 루프가 끝났음을 적는다. 기다리던 Freeze 를 풀어 준다.
func (p *Tool) markReadDone() {
	f := &p.frz
	f.init()
	f.mu.Lock()
	f.readDone = true
	f.cond.Broadcast()
	f.mu.Unlock()
}

// ErrSealed 는 데몬 교체 중에 도구를 만들려 한 경우다 (FR-DSK-13).
var ErrSealed = errors.New("데몬 교체 중이라 도구를 만들 수 없다")

// sealWait 는 봉인 뒤 띄우는 중인 도구(pending)가 등록되기를 기다리는 상한이다.
const sealWait = 5 * time.Second

// FreezeAll 은 도구 생성을 봉인하고 살아 있는 모든 도구를 멈춘다. 하나라도 멈추지 못하면
// 되돌리고 거짓이다 — 일부만 넘기는 교체는 하지 않는다.
func (m *ToolManager) FreezeAll() bool {
	if !m.seal() {
		return false
	}
	tools := m.Snapshot()
	frozen := make([]*Tool, 0, len(tools))
	for _, p := range tools {
		if !p.Freeze() {
			for _, q := range frozen {
				q.Thaw()
			}
			m.unseal()
			return false
		}
		frozen = append(frozen, p)
	}
	return true
}

// ThawAll 은 모든 도구의 멈춤과 생성 봉인을 푼다.
func (m *ToolManager) ThawAll() {
	for _, p := range m.Snapshot() {
		p.Thaw()
	}
	m.unseal()
}

// seal 은 생성을 막고, 이미 띄우는 중인 도구가 등록될 때까지 기다린다.
func (m *ToolManager) seal() bool {
	m.mu.Lock()
	m.sealed = true
	m.mu.Unlock()
	err := pollwait.Until(context.Background(), sealWait, 10*time.Millisecond, func() bool {
		m.mu.RLock()
		defer m.mu.RUnlock()
		return m.pending == 0
	})
	if err != nil {
		m.unseal()
		return false
	}
	return true
}

func (m *ToolManager) unseal() {
	m.mu.Lock()
	m.sealed = false
	m.mu.Unlock()
}
