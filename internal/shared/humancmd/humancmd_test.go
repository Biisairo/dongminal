package humancmd

import (
	"crypto/ed25519"
	"crypto/rand"
	"testing"
	"time"
)

// PEER_CHAT_SRS §3.12a R-10 — 서명은 정규 base64 표기만 받는다.

func signed(t *testing.T) Signed {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := Sign(priv, Body{ID: NewID(), Node: "n", Op: OpKill, Rooms: []string{"r"}, At: time.Now().UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// nonCanonical 는 같은 서명 바이트를 다른 표기로 바꾼다: 마지막 글자의 남는 비트를 켜거나, 줄바꿈을 넣는다.
func nonCanonical(s string) []string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	i := len(s) - 3 // 64바이트 서명은 "..XY==" 로 끝나고 Y 의 아래 4비트가 남는다.
	idx := 0
	for j := range alphabet {
		if alphabet[j] == s[i] {
			idx = j
		}
	}
	bits := s[:i] + string(alphabet[idx|1]) + s[i+1:]
	return []string{bits, s[:10] + "\n" + s[10:], s[:len(s)-2]}
}

func TestOpenAcceptsCanonical(t *testing.T) {
	if _, err := Open(signed(t)); err != nil {
		t.Fatal(err)
	}
}

func TestOpenRejectsNonCanonicalSignature(t *testing.T) {
	s := signed(t)
	for _, alt := range nonCanonical(s.S) {
		if alt == s.S {
			t.Fatalf("변형이 원본과 같다: %q", alt)
		}
		if _, err := Open(Signed{B: s.B, S: alt}); err == nil {
			t.Fatalf("비정규 표기 %q 를 받았다", alt)
		}
	}
}
