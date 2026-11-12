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

// 틀린 시도가 PairMaxFails 번이면 코드를 폐기한다. 6자리는 대입에 약하다.
func TestPairKillsCodeAfterFailures(t *testing.T) {
	p := NewPairing(time.Now)
	code, _ := p.Issue()
	for i := 0; i < PairMaxFails; i++ {
		if p.Redeem("x") {
			t.Fatal("틀린 코드를 받았다")
		}
	}
	if p.Redeem(code) {
		t.Fatal("실패가 쌓였는데 코드가 살아 있다")
	}
}

// 설정 화면이 남은 시간을 보이려면 살아 있는 코드의 만료가 필요하다. 코드 자체는 내주지 않는다.
func TestPairPending(t *testing.T) {
	now := time.Unix(1000, 0)
	p := NewPairing(func() time.Time { return now })
	if _, ok := p.Pending(); ok {
		t.Fatal("코드가 없는데 진행 중이다")
	}
	code, exp := p.Issue()
	if got, ok := p.Pending(); !ok || !got.Equal(exp) {
		t.Fatalf("Pending=%v,%v want %v", got, ok, exp)
	}
	p.Redeem(code)
	if _, ok := p.Pending(); ok {
		t.Fatal("쓴 코드가 진행 중이다")
	}
	p.Issue()
	now = now.Add(PairTTL)
	if _, ok := p.Pending(); ok {
		t.Fatal("만료된 코드가 진행 중이다")
	}
}

// 해제는 살아 있는 코드도 죽인다.
func TestPairCancel(t *testing.T) {
	p := NewPairing(time.Now)
	code, _ := p.Issue()
	p.Cancel()
	if _, ok := p.Pending(); ok || p.Redeem(code) {
		t.Fatal("취소한 코드가 살아 있다")
	}
}
