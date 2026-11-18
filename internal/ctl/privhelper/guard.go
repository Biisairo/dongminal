package privhelper

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/hex"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/humancmd"
)

// 잠금이다 (FR-PCH-75, D-PCH-34).
const (
	maxFails = 5
	lockFor  = 5 * time.Minute
)

// guard 는 코드 확인과 잠금이다. 잠금·마지막 칸은 메모리에만 둔다. 쓴 복구 코드는 save 로 남긴다.
type guard struct {
	mu       sync.Mutex
	sec      *Secret
	totp     []byte
	now      func() time.Time
	save     func(Secret) error
	fails    int
	until    time.Time
	lastStep int64
}

func newGuard(sec *Secret, now func() time.Time, save func(Secret) error) (*guard, error) {
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(sec.TOTP)
	if err != nil {
		return nil, err
	}
	return &guard{sec: sec, totp: raw, now: now, save: save, lastStep: -1}, nil
}

// lockedUntil 은 잠겼으면 풀리는 시각, 아니면 0 이다. 잠금이 지났으면 횟수를 0 부터 센다.
func (g *guard) lockedUntil() time.Time {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.lockLocked(g.now())
}

func (g *guard) lockLocked(now time.Time) time.Time {
	if g.until.IsZero() {
		return time.Time{}
	}
	if now.Before(g.until) {
		return g.until
	}
	g.until, g.fails = time.Time{}, 0
	return time.Time{}
}

// check 는 코드 하나를 확인한다. 맞으면 nil, 아니면 bad_code 나 locked 다.
func (g *guard) check(code string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	if u := g.lockLocked(now); !u.IsZero() {
		return &humancmd.Error{Code: humancmd.CodeLocked, Until: u.UnixMilli()}
	}
	if g.totpLocked(code, now) {
		g.fails = 0
		return nil
	}
	switch g.recoveryLocked(code) {
	case recoveryOK:
		g.fails = 0
		return nil
	case recoveryUnsaved:
		// 코드는 맞았다 — 틀린 횟수에 넣지 않는다 (§3.12a R-5).
		return &humancmd.Error{Code: humancmd.CodeUnavailable}
	}
	g.fails++
	if g.fails >= maxFails {
		g.until = now.Add(lockFor)
		return &humancmd.Error{Code: humancmd.CodeLocked, Until: g.until.UnixMilli()}
	}
	return &humancmd.Error{Code: humancmd.CodeBadCode}
}

// totpLocked 는 앞뒤 한 칸 안의 코드인지 본다. 이미 쓴 칸과 그 앞 칸은 받지 않는다.
func (g *guard) totpLocked(code string, now time.Time) bool {
	if len(code) != digits {
		return false
	}
	step := stepOf(now)
	for d := int64(-skew); d <= skew; d++ {
		s := step + d
		if s <= g.lastStep || s < 0 {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(hotp(g.totp, uint64(s), digits)), []byte(code)) == 1 {
			g.lastStep = s
			return true
		}
	}
	return false
}

type recoveryResult int

const (
	recoveryNo recoveryResult = iota
	recoveryOK
	recoveryUnsaved
)

// recoveryLocked 는 쓰지 않은 복구 코드인지 본다. 맞으면 쓴 것으로 저장한다. 저장하지 못하면
// 쓴 것으로 치지 않고 recoveryUnsaved 다.
func (g *guard) recoveryLocked(code string) recoveryResult {
	c := normalizeRecovery(code)
	if c == "" {
		return recoveryNo
	}
	h := hashRecovery(c)
	for _, u := range g.sec.Used {
		if u == h {
			return recoveryNo
		}
	}
	for _, r := range g.sec.Recovery {
		if subtle.ConstantTimeCompare([]byte(r), []byte(h)) == 1 {
			next := *g.sec
			next.Used = append(append([]string{}, g.sec.Used...), h)
			if g.save(next) != nil {
				return recoveryUnsaved
			}
			*g.sec = next
			return recoveryOK
		}
	}
	return recoveryNo
}

// normalizeRecovery 는 복구 코드 모양(`xxxxx-xxxxx`, 소문자 base32)이면 그 값을, 아니면 빈 값이다.
func normalizeRecovery(code string) string {
	c := strings.ToLower(strings.TrimSpace(code))
	if len(c) != 11 || c[5] != '-' {
		return ""
	}
	for i, r := range c {
		if i == 5 {
			continue
		}
		if !(r >= 'a' && r <= 'z' || r >= '2' && r <= '7') {
			return ""
		}
	}
	return c
}

func hashRecovery(c string) string {
	sum := sha256.Sum256([]byte(c))
	return hex.EncodeToString(sum[:])
}
