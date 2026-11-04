package fswatch

import (
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/text/unicode/norm"
)

const (
	// ChangesDelay 는 원시 이벤트를 모으는 시간이다 (VS Code `FILE_CHANGES_HANDLER_DELAY`).
	ChangesDelay = 75 * time.Millisecond
	// DeleteRecheckDelay 는 Remove·Rename 뒤 존재를 다시 보기까지의 시간이다
	// (VS Code `FILE_DELETE_HANDLER_DELAY`). 원자적 저장을 UPDATED 로 읽는다.
	DeleteRecheckDelay = 100 * time.Millisecond
	// ChunkSize·ChunkPause·MaxBuffered 는 내보내는 양의 조절이다
	// (VS Code 비재귀 감시자의 `ThrottledWorker` 설정).
	ChunkSize   = 100
	ChunkPause  = 200 * time.Millisecond
	MaxBuffered = 10000
)

// Op 는 백엔드가 준 원시 이벤트의 종류다. 값은 fsnotify 의 비트와 같다.
type Op uint32

const (
	OpCreate Op = 1 << iota
	OpWrite
	OpRemove
	OpRename
	OpChmod
)

// RawEvent 는 백엔드가 준 원시 이벤트다. Name 은 실제 경로다.
type RawEvent struct {
	Name string
	Op   Op
}

// Clock 은 시간을 주입하는 자리다. 검사는 가짜 시계로 시간을 결정론적으로 돌린다.
type Clock interface {
	AfterFunc(d time.Duration, f func()) (stop func() bool)
}

type realClock struct{}

func (realClock) AfterFunc(d time.Duration, f func()) func() bool {
	return time.AfterFunc(d, f).Stop
}

// PipelineOptions 는 `NewPipeline` 의 입력이다.
type PipelineOptions struct {
	Clock         Clock
	Exists        func(path string) bool
	CaseSensitive bool
	NFC           bool
	Out           func(changes []Change, overflow bool)
}

// Pipeline 은 원시 이벤트를 해석하고(FR-ELR-56) 모아 병합한 뒤(FR-ELR-57) 양을 조절해
// 내보낸다(FR-ELR-58).
type Pipeline struct {
	opt PipelineOptions

	mu        sync.Mutex
	pending   []Change
	flushing  bool
	queue     []Change
	draining  bool
	overflown bool

	outMu sync.Mutex
}

func NewPipeline(opt PipelineOptions) *Pipeline {
	if opt.Clock == nil {
		opt.Clock = realClock{}
	}
	return &Pipeline{opt: opt}
}

// Push 는 원시 이벤트 하나를 받는다.
func (p *Pipeline) Push(e RawEvent) {
	name := e.Name
	if p.opt.NFC {
		name = filepath.Join(filepath.Dir(name), norm.NFC.String(filepath.Base(name)))
	}
	switch {
	case e.Op&(OpRemove|OpRename) != 0:
		p.opt.Clock.AfterFunc(DeleteRecheckDelay, func() {
			if p.opt.Exists(name) {
				p.add(Change{name, Updated})
			} else {
				p.add(Change{name, Deleted})
			}
		})
	case e.Op&OpCreate != 0:
		p.add(Change{name, Added})
	case e.Op&OpWrite != 0:
		p.add(Change{name, Updated})
	}
}

func (p *Pipeline) add(c Change) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pending = append(p.pending, c)
	if p.flushing {
		return
	}
	p.flushing = true
	p.opt.Clock.AfterFunc(ChangesDelay, p.flush)
}

func (p *Pipeline) flush() {
	p.mu.Lock()
	batch := Coalesce(p.pending, p.opt.CaseSensitive)
	p.pending = nil
	p.flushing = false
	overflow := false
	room := MaxBuffered - len(p.queue)
	if len(batch) > room {
		batch = batch[:max(room, 0)]
		if !p.overflown {
			p.overflown = true
			overflow = true
		}
	}
	p.queue = append(p.queue, batch...)
	start := !p.draining && len(p.queue) > 0
	if start {
		p.draining = true
	}
	p.mu.Unlock()
	if overflow {
		p.emit(nil, true)
	}
	if start {
		p.drain()
	}
}

// drain 은 묶음 하나를 내보내고, 남았으면 쉰 뒤 다시 부른다.
func (p *Pipeline) drain() {
	p.mu.Lock()
	n := min(ChunkSize, len(p.queue))
	chunk := append([]Change(nil), p.queue[:n]...)
	p.queue = p.queue[n:]
	more := len(p.queue) > 0
	if !more {
		p.draining = false
		p.overflown = false
	}
	p.mu.Unlock()
	if len(chunk) > 0 {
		p.emit(chunk, false)
	}
	if more {
		p.opt.Clock.AfterFunc(ChunkPause, p.drain)
	}
}

func (p *Pipeline) emit(c []Change, overflow bool) {
	p.outMu.Lock()
	defer p.outMu.Unlock()
	p.opt.Out(c, overflow)
}
