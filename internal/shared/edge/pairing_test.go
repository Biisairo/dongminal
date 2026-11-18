package edge

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"
)

// fakeClock 은 테스트가 움직이는 시계다.
type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newFakeClock() *fakeClock { return &fakeClock{t: time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)} }

// FR-PNW-20: 토큰은 128비트 난수이고 10분 산다.
func TestInviteTokenAndExpiry(t *testing.T) {
	clk := newFakeClock()
	p := NewPairing(clk.now)
	if p.HasInvite() {
		t.Fatal("처음부터 초대가 있다")
	}
	token, expires := p.NewInvite()
	if len(token) != 32 || strings.Trim(token, "0123456789abcdef") != "" {
		t.Fatalf("토큰 %q 는 128비트 16진수가 아니다", token)
	}
	if !expires.Equal(clk.t.Add(InviteTTL)) || InviteTTL != 10*time.Minute {
		t.Fatalf("만료 %v", expires)
	}
	clk.advance(InviteTTL - time.Second)
	if !p.HasInvite() {
		t.Fatal("만료 전에 사라졌다")
	}
	clk.advance(2 * time.Second)
	if p.HasInvite() {
		t.Fatal("만료 뒤에도 남았다")
	}
	if err := p.Redeem(token, fpOf("aa")); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("만료된 초대 Redeem = %v", err)
	}
}

// FR-PNW-20: 한 번 쓰면 사라진다.
func TestInviteOneTime(t *testing.T) {
	p := NewPairing(newFakeClock().now)
	token, _ := p.NewInvite()
	if err := p.Redeem(token, fpOf("aa")); err != nil {
		t.Fatalf("Redeem: %v", err)
	}
	if p.HasInvite() {
		t.Fatal("쓴 뒤에도 초대가 남았다")
	}
	if err := p.Redeem(token, fpOf("bb")); !errors.Is(err, ErrNoInvite) {
		t.Fatalf("다른 지문의 두 번째 Redeem = %v", err)
	}
}

// FR-PNW-20: 살아 있는 초대는 하나다. 새로 만들면 이전 것은 사라진다.
func TestInviteReplaces(t *testing.T) {
	p := NewPairing(newFakeClock().now)
	old, _ := p.NewInvite()
	fresh, _ := p.NewInvite()
	if old == fresh {
		t.Fatal("같은 토큰이 나왔다")
	}
	if err := p.Redeem(old, fpOf("aa")); !errors.Is(err, ErrBadToken) {
		t.Fatalf("이전 토큰 Redeem = %v", err)
	}
	if err := p.Redeem(fresh, fpOf("aa")); err != nil {
		t.Fatalf("새 토큰 Redeem = %v", err)
	}
}

// FR-PNW-24 (L-9): 틀린 토큰은 그 요청만 거절한다. 몇 번이 와도 초대는 남는다 — 남이
// 틀린 토큰으로 정상 사용자의 초대를 없앨 수 없다.
func TestInviteSurvivesBadTokens(t *testing.T) {
	p := NewPairing(newFakeClock().now)
	token, _ := p.NewInvite()
	for i := 0; i < 100; i++ {
		if err := p.Redeem("bad", fpOf("aa")); !errors.Is(err, ErrBadToken) {
			t.Fatalf("%d번째: %v", i+1, err)
		}
	}
	if err := p.Redeem(token, fpOf("aa")); err != nil {
		t.Fatalf("틀린 토큰 뒤 맞는 토큰 = %v", err)
	}
}

// FR-PNW-21, FR-PDM-70: `dmedge1:` + base64url(JSON).
func TestInviteCodeRoundTrip(t *testing.T) {
	in := InviteCode{Addr: "office.example", Port: 58147, Fingerprint: strings.Repeat("ab", 32), Token: strings.Repeat("0f", 16)}
	code := EncodeInvite(in)
	if !strings.HasPrefix(code, InvitePrefix) || InvitePrefix != "dmedge1:" {
		t.Fatalf("접두어: %q", code)
	}
	if _, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(code, InvitePrefix)); err != nil {
		t.Fatalf("base64url 이 아니다: %v", err)
	}
	out, err := DecodeInvite("  " + code + "\n")
	if err != nil {
		t.Fatalf("DecodeInvite: %v", err)
	}
	if out != in {
		t.Fatalf("왕복이 다르다: %+v", out)
	}
}

func TestDecodeInviteRejects(t *testing.T) {
	enc := func(s string) string { return InvitePrefix + base64.RawURLEncoding.EncodeToString([]byte(s)) }
	fp := strings.Repeat("ab", 32)
	tok := strings.Repeat("0f", 16)
	bad := []string{
		"",
		"dmedge2:abc",
		"dmedge1:!!!",
		// D-PDM-17: 옛 머리는 받지 않는다.
		"dmpeer1:" + base64.RawURLEncoding.EncodeToString([]byte(`{"addr":"h","port":58147,"fp":"`+fp+`","token":"`+tok+`"}`)),
		enc("{"),
		enc(`{"port":58147,"fp":"` + fp + `","token":"` + tok + `"}`),              // addr 없음
		enc(`{"addr":"h","port":0,"fp":"` + fp + `","token":"` + tok + `"}`),       // 포트
		enc(`{"addr":"h","port":58147,"fp":"zz","token":"` + tok + `"}`),           // 지문
		enc(`{"addr":"h","port":58147,"fp":"` + fp + `","token":""}`),              // 토큰
		enc(`{"addr":"h/x","port":58147,"fp":"` + fp + `","token":"` + tok + `"}`), // 주소에 구분자
	}
	for _, c := range bad {
		if _, err := DecodeInvite(c); !errors.Is(err, ErrInvalidInvite) {
			t.Errorf("DecodeInvite(%q) = %v, 기대 ErrInvalidInvite", c, err)
		}
	}
}

// 주소는 허용 목록이다 — IP 이거나 LDH 호스트 이름만 받는다.
func TestValidAddr(t *testing.T) {
	ok := []string{"10.0.0.1", "::1", "fe80::1", "office", "office.example.com", "a-b.c-d", "host.local"}
	for _, a := range ok {
		if !ValidAddr(a) {
			t.Errorf("ValidAddr(%q) = false", a)
		}
	}
	bad := []string{"", "a b", "a/b", "a\x1b[31m", "fe80::1%eth0", "fe80::1%\x1b[2J", "한글.com", "-a.com", "a-.com", "a..b", "a_b.com",
		"user@h", "h:80", strings.Repeat("a", 64) + ".com", strings.Repeat("a.", 127) + "aa"}
	for _, a := range bad {
		if ValidAddr(a) {
			t.Errorf("ValidAddr(%q) = true", a)
		}
	}
}
