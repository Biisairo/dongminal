// Package uuid implements UUID v7 (RFC 9562) generation and parsing for
// dongminal internal entity identity. See docs/internal/UUID_IDENTITY_SRS.md.
package uuid

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"
)

// UUID is a 128-bit identifier in RFC 9562 layout.
type UUID [16]byte

// Generator emits UUID v7 values. Within a single millisecond, successive
// values are strictly monotonic via a 12-bit counter in rand_a (RFC 9562
// §6.2 method 1). When the counter exhausts, the synthetic timestamp is
// advanced by 1 ms; backwards clock movement is absorbed by the same path.
type Generator struct {
	nowFn func() time.Time

	mu        sync.Mutex
	lastMs    uint64
	lastRandA uint16
}

const counterMax uint16 = 0x0FFF

// New returns a Generator using the wall clock.
func New() *Generator {
	return &Generator{nowFn: time.Now}
}

// newWithClock is an internal constructor used by tests to inject time.
func newWithClock(now func() time.Time) *Generator {
	return &Generator{nowFn: now}
}

// Generate returns the next UUID v7. Safe for concurrent use.
func (g *Generator) Generate() (UUID, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	ms := uint64(g.nowFn().UnixMilli())
	var randA uint16

	if ms > g.lastMs {
		randA = 0
		g.lastMs = ms
	} else {
		ms = g.lastMs
		if g.lastRandA >= counterMax {
			ms++
			g.lastMs = ms
			randA = 0
		} else {
			randA = g.lastRandA + 1
		}
	}
	g.lastRandA = randA

	var u UUID
	u[0] = byte(ms >> 40)
	u[1] = byte(ms >> 32)
	u[2] = byte(ms >> 24)
	u[3] = byte(ms >> 16)
	u[4] = byte(ms >> 8)
	u[5] = byte(ms)
	u[6] = 0x70 | byte((randA>>8)&0x0F)
	u[7] = byte(randA)

	var randB [8]byte
	if _, err := rand.Read(randB[:]); err != nil {
		return UUID{}, fmt.Errorf("uuid: rand_b: %w", err)
	}
	u[8] = 0x80 | (randB[0] & 0x3F)
	u[9] = randB[1]
	u[10] = randB[2]
	u[11] = randB[3]
	u[12] = randB[4]
	u[13] = randB[5]
	u[14] = randB[6]
	u[15] = randB[7]

	return u, nil
}

// String returns the canonical 8-4-4-4-12 hex form.
func (u UUID) String() string {
	var buf [36]byte
	hex.Encode(buf[0:8], u[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], u[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], u[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], u[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], u[10:16])
	return string(buf[:])
}

// ShortCode returns the first 8 hex chars (prefix 4 bytes). Used for log
// readability per SRS NFR-UID-4; never relied on for unique matching.
func (u UUID) ShortCode() string {
	return hex.EncodeToString(u[:4])
}

// Version returns the UUID version nibble (7 for v7).
func (u UUID) Version() int {
	return int(u[6] >> 4)
}

// Parse decodes the canonical 8-4-4-4-12 hex form.
func Parse(s string) (UUID, error) {
	if len(s) != 36 {
		return UUID{}, errors.New("uuid: invalid length")
	}
	if s[8] != '-' || s[13] != '-' || s[18] != '-' || s[23] != '-' {
		return UUID{}, errors.New("uuid: invalid format")
	}
	var u UUID
	segments := [...]struct {
		srcLo, srcHi int
		dstLo, dstHi int
	}{
		{0, 8, 0, 4},
		{9, 13, 4, 6},
		{14, 18, 6, 8},
		{19, 23, 8, 10},
		{24, 36, 10, 16},
	}
	for _, seg := range segments {
		if _, err := hex.Decode(u[seg.dstLo:seg.dstHi], []byte(s[seg.srcLo:seg.srcHi])); err != nil {
			return UUID{}, fmt.Errorf("uuid: %w", err)
		}
	}
	return u, nil
}
