package telegram

import (
	"crypto/rand"
	"crypto/subtle"
	"fmt"
	"math/big"
	"sync"
	"time"
)

// PairTTL 은 짝맞춤 코드의 수명이다 (FR-TGB-10).
const PairTTL = 10 * time.Minute

// PairMaxFails 는 코드를 폐기하는 틀린 시도 수다 (FR-TGB-10a). 6자리는 대입에 약하다.
const PairMaxFails = 5

// Pairing 은 짝맞춤 코드 하나다. 새 코드를 내면 이전 코드는 죽고, 한 번 쓰면 죽는다.
type Pairing struct {
	mu    sync.Mutex
	code  string
	exp   time.Time
	fails int
	now   func() time.Time
}

func NewPairing(now func() time.Time) *Pairing { return &Pairing{now: now} }

// Issue 는 6자리 코드를 낸다.
func (p *Pairing) Issue() (string, time.Time) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		// crypto/rand 가 실패하면 코드를 낼 수 없다. 빈 코드는 Redeem 이 늘 거절한다.
		return "", time.Time{}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.code = fmt.Sprintf("%06d", n.Int64())
	p.exp = p.now().Add(PairTTL)
	p.fails = 0
	return p.code, p.exp
}

// Redeem 은 코드가 맞고 살아 있으면 참이고, 그 코드를 죽인다.
func (p *Pairing) Redeem(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.code == "" || !p.now().Before(p.exp) {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(code), []byte(p.code)) != 1 {
		p.fails++
		if p.fails >= PairMaxFails {
			p.code = ""
		}
		return false
	}
	p.code = ""
	return true
}
