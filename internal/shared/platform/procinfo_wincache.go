package platform

import (
	"sync"
	"time"
)

// procEntry 는 프로세스 스냅샷 한 줄이다.
//
// build tag 가 없는 자리에 사는 이유는 아래 캐시 때문이다 — 캐시의 판단은 OS
// API 가 아니므로 어느 호스트에서도 검증되어야 한다 (이 패키지 머리말 §4.2).
type procEntry struct {
	pid, ppid int
	name      string
}

// winSnapTTL 은 스냅샷 캐시의 수명이다. 전경 조회의 주기(`fgRefreshInterval`)와
// **같은 값**이어야 한다 — 다르면 두 조회가 서로 다른 시점의 세상을 본다
// (HOST_PARITY_SRS D-6).
const winSnapTTL = 2 * time.Second

// snapCache 는 프로세스 스냅샷의 짧은 수명 캐시다 (HOST_PARITY_SRS FR-HPR-12·13).
//
// 없을 때 무슨 일이 일어났는지가 이 타입의 존재 이유다. `HasChildren` 은 부를
// 때마다 전체 프로세스를 열거했고, 유휴 감시가 1초마다 도구 수만큼 부른다 —
// 도구 20개면 초당 20회 전수 열거였다. 같은 파일의 `Names` 는 처음부터 일괄
// 조회로 설계되어 있었으므로(NFR-XP-4), 이 경로만 그 규약 밖에 있었다.
type snapCache struct {
	ttl  time.Duration
	now  func() time.Time
	load func() ([]procEntry, error)

	mu   sync.Mutex
	at   time.Time
	data []procEntry
}

// get 은 수명 안이면 캐시를, 아니면 새로 뜬 스냅샷을 낸다.
//
// **잠금을 쥔 채로 뜬다** — 그것이 single-flight 다 (FR-HPR-13). 동시에 들어온
// 조회 여럿이 스냅샷을 겹쳐 뜨면 캐시를 두는 뜻이 없다. 조회는 toolhelp 한 번이라
// 잠금을 쥐는 시간이 길지 않다.
//
// **실패는 캐시하지 않는다.** 한 번의 실패를 수명 내내 물려주면 그동안 모든
// 판정이 "자식 없음" 으로 굳는다.
func (c *snapCache) get() ([]procEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if c.data != nil && now.Sub(c.at) < c.ttl {
		return c.data, nil
	}
	data, err := c.load()
	if err != nil {
		return nil, err
	}
	c.data, c.at = data, now
	return data, nil
}
