package telegram

import (
	"regexp"
	"testing"
	"time"
)

// TELEGRAM_BRIDGE_SRS TC-TGB-10 — 짝맞춤 코드 (FR-TGB-10·11).

func TestPairCodeShapeAndSingleUse(t *testing.T) {
	now := time.Unix(1000, 0)
	p := NewPairing(func() time.Time { return now })
	code, exp := p.Issue()
	if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code) {
		t.Fatalf("코드 모양이 틀렸다: %q", code)
	}
	if !exp.Equal(now.Add(PairTTL)) {
		t.Fatalf("만료 %v, 기대 %v", exp, now.Add(PairTTL))
	}
	if p.Redeem("000000x") {
		t.Fatal("틀린 코드를 받았다")
	}
	if !p.Redeem(code) {
		t.Fatal("맞는 코드를 거절했다")
	}
	if p.Redeem(code) {
		t.Fatal("같은 코드를 두 번 받았다")
	}
}

func TestPairCodeExpires(t *testing.T) {
	now := time.Unix(1000, 0)
	p := NewPairing(func() time.Time { return now })
	code, _ := p.Issue()
	now = now.Add(PairTTL + time.Second)
	if p.Redeem(code) {
		t.Fatal("만료된 코드를 받았다")
	}
}

// 새 코드를 내면 이전 코드는 죽는다.
func TestPairReissueKillsOld(t *testing.T) {
	now := time.Unix(1000, 0)
	p := NewPairing(func() time.Time { return now })
	old, _ := p.Issue()
	fresh, _ := p.Issue()
	if old != fresh && p.Redeem(old) {
		t.Fatal("이전 코드가 살아 있다")
	}
	if !p.Redeem(fresh) {
		t.Fatal("새 코드를 거절했다")
	}
}

func TestPairNoCodeRejects(t *testing.T) {
	p := NewPairing(time.Now)
	if p.Redeem("") || p.Redeem("123456") {
		t.Fatal("코드를 내지 않았는데 받았다")
	}
}
