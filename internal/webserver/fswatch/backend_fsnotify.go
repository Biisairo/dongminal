package fswatch

import "github.com/fsnotify/fsnotify"

// fsnBackend 는 fsnotify 위의 `Backend` 다 (FR-ELR-50).
type fsnBackend struct {
	w  *fsnotify.Watcher
	ev chan RawEvent
}

func newFSNotifyBackend() (Backend, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	b := &fsnBackend{w: w, ev: make(chan RawEvent, 64)}
	go func() {
		defer close(b.ev)
		for e := range w.Events {
			op := Op(e.Op) & (OpCreate | OpWrite | OpRemove | OpRename | OpChmod)
			b.ev <- RawEvent{Name: e.Name, Op: op}
		}
	}()
	return b, nil
}

func (b *fsnBackend) Add(p string) error      { return b.w.Add(p) }
func (b *fsnBackend) Remove(p string) error   { return b.w.Remove(p) }
func (b *fsnBackend) Events() <-chan RawEvent { return b.ev }
func (b *fsnBackend) Errors() <-chan error    { return b.w.Errors }
func (b *fsnBackend) Close() error            { return b.w.Close() }
