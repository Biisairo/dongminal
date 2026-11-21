package httpapi

import "sync"

// pathLocks 는 경로마다 잠금 하나다 (REFACTOR3_DEFECTS_SRS FR-RD3-20·22).
//
// 쓰는 동안만 항목을 두고 다 풀면 지운다 — 열어 본 경로 수만큼 쌓이지 않는다.
// 서버 전역 `fsOps` 를 쓰지 않는 이유는 D-RD3-3 이다: 그 잠금은 큰 복사·삭제 전
// 구간을 잡으므로 편집기 저장이 그 뒤에 줄 선다.
type pathLocks struct {
	mu sync.Mutex
	m  map[string]*pathLockEntry
}

type pathLockEntry struct {
	mu sync.Mutex
	n  int
}

// lock 은 path 의 잠금을 얻고, 푸는 함수를 돌려준다.
func (p *pathLocks) lock(path string) func() {
	p.mu.Lock()
	if p.m == nil {
		p.m = map[string]*pathLockEntry{}
	}
	e := p.m[path]
	if e == nil {
		e = &pathLockEntry{}
		p.m[path] = e
	}
	e.n++
	p.mu.Unlock()

	e.mu.Lock()
	return func() {
		e.mu.Unlock()
		p.mu.Lock()
		e.n--
		if e.n == 0 {
			delete(p.m, path)
		}
		p.mu.Unlock()
	}
}

func (p *pathLocks) size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.m)
}
