package privhelper

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/binary"
	"fmt"
	"time"
)

// RFC 6238 TOTP: HMAC-SHA1, 30초, 6자리 (PEER_CHAT_SRS §3.12, NFR-PCH-4).
const (
	period = 30
	digits = 6
	// skew 는 앞뒤로 받는 칸 수다. 휴대폰과 PC 의 시계 어긋남을 덮는다.
	skew = 1
)

// stepOf 는 t 의 시간 칸이다.
func stepOf(t time.Time) int64 { return t.Unix() / period }

// hotp 는 RFC 4226 의 코드다.
func hotp(secret []byte, counter uint64, n int) string {
	var msg [8]byte
	binary.BigEndian.PutUint64(msg[:], counter)
	m := hmac.New(sha1.New, secret)
	m.Write(msg[:])
	sum := m.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	v := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	mod := uint32(1)
	for range n {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", n, v%mod)
}
