package peer

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"time"
)

// 짝맞춤의 시간·횟수 (FR-PNW-20·24·25).
const (
	InviteTTL        = 10 * time.Minute
	PendingTTL       = 10 * time.Minute
	MaxTokenFailures = 5
	// InvitePrefix 는 초대 코드의 접두어다 (FR-PNW-21).
	InvitePrefix = "dmpeer1:"
	tokenBytes   = 16
	maxHostLen   = 253
	maxLabelLen  = 63
	idBytes      = 8
)

var (
	ErrNoInvite      = errors.New("살아 있는 초대가 없습니다")
	ErrBadToken      = errors.New("초대 토큰이 맞지 않습니다")
	ErrInvalidInvite = errors.New("초대 코드의 모양이 틀렸습니다")
)

// Pending 은 승인 대기 하나다 (FR-PNW-25).
type Pending struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Addr        string    `json:"addr"`
	Port        int       `json:"port"`
	Fingerprint string    `json:"fp"`
	Expires     time.Time `json:"expires"`
}

type invite struct {
	token    string
	expires  time.Time
	failures int
}

// Pairing 은 초대와 승인 대기다. 메모리에만 둔다 — 둘 다 10분짜리다.
type Pairing struct {
	mu      sync.Mutex
	now     func() time.Time
	invite  *invite
	pending map[string]Pending
}

// NewPairing 은 now 를 시계로 쓴다.
func NewPairing(now func() time.Time) *Pairing {
	return &Pairing{now: now, pending: map[string]Pending{}}
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewInvite 는 새 초대를 만든다. 이전 초대는 사라진다 (FR-PNW-20).
func (p *Pairing) NewInvite() (token string, expires time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	inv := &invite{token: randomHex(tokenBytes), expires: p.now().Add(InviteTTL)}
	p.invite = inv
	return inv.token, inv.expires
}

// liveInviteLocked 는 만료되지 않은 초대다. 만료됐으면 지운다.
func (p *Pairing) liveInviteLocked() *invite {
	if p.invite != nil && !p.now().Before(p.invite.expires) {
		p.invite = nil
	}
	return p.invite
}

// HasInvite 는 살아 있는 초대가 있는가다.
func (p *Pairing) HasInvite() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.liveInviteLocked() != nil
}

// InviteExpires 는 살아 있는 초대의 만료 시각이다. 없으면 ok 가 거짓이다.
func (p *Pairing) InviteExpires() (time.Time, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	inv := p.liveInviteLocked()
	if inv == nil {
		return time.Time{}, false
	}
	return inv.expires, true
}

// Consume 은 토큰을 대조해 맞으면 초대를 쓴다. 틀린 토큰이 MaxTokenFailures 번
// 오면 초대를 폐기한다 (FR-PNW-24).
func (p *Pairing) Consume(token string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	inv := p.liveInviteLocked()
	if inv == nil {
		return ErrNoInvite
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(inv.token)) != 1 {
		inv.failures++
		if inv.failures >= MaxTokenFailures {
			p.invite = nil
		}
		return ErrBadToken
	}
	p.invite = nil
	return nil
}

// AddPending 은 승인 대기를 더한다. 같은 지문의 이전 항목은 갈아 끼운다.
func (p *Pairing) AddPending(in Pending) Pending {
	p.mu.Lock()
	defer p.mu.Unlock()
	for id, old := range p.pending {
		if old.Fingerprint == in.Fingerprint {
			delete(p.pending, id)
		}
	}
	in.ID = randomHex(idBytes)
	in.Expires = p.now().Add(PendingTTL)
	p.pending[in.ID] = in
	return in
}

func (p *Pairing) pruneLocked() {
	now := p.now()
	for id, e := range p.pending {
		if !now.Before(e.Expires) {
			delete(p.pending, id)
		}
	}
}

// Pending 은 살아 있는 승인 대기 목록이다. 만료 순이다.
func (p *Pairing) Pending() []Pending {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneLocked()
	out := make([]Pending, 0, len(p.pending))
	for _, e := range p.pending {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Expires.Before(out[j].Expires) })
	return out
}

// TakePending 은 승인 대기 하나를 꺼낸다.
func (p *Pairing) TakePending(id string) (Pending, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneLocked()
	e, ok := p.pending[id]
	if ok {
		delete(p.pending, id)
	}
	return e, ok
}

// PutBack 은 꺼낸 승인 대기를 그대로 돌려놓는다 (승인이 이름 충돌로 멈춘 경우).
// 그 사이 같은 지문의 새 대기가 들어왔으면 새 것이 이긴다 (AddPending 과 같은 규칙).
func (p *Pairing) PutBack(e Pending) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, cur := range p.pending {
		if cur.Fingerprint == e.Fingerprint {
			return
		}
	}
	p.pending[e.ID] = e
}

// InviteCode 는 초대 코드의 내용이다 (FR-PNW-21).
type InviteCode struct {
	Addr        string `json:"addr"`
	Port        int    `json:"port"`
	Fingerprint string `json:"fp"`
	Token       string `json:"token"`
}

// EncodeInvite 는 `dmpeer1:` + base64url(JSON) 이다.
func EncodeInvite(c InviteCode) string {
	raw, _ := json.Marshal(c)
	return InvitePrefix + base64.RawURLEncoding.EncodeToString(raw)
}

// DecodeInvite 는 EncodeInvite 의 역이다. 앞뒤 공백은 무시한다.
func DecodeInvite(s string) (InviteCode, error) {
	s = strings.TrimSpace(s)
	if !strings.HasPrefix(s, InvitePrefix) {
		return InviteCode{}, ErrInvalidInvite
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(s, InvitePrefix))
	if err != nil {
		return InviteCode{}, ErrInvalidInvite
	}
	var c InviteCode
	if err := json.Unmarshal(raw, &c); err != nil {
		return InviteCode{}, ErrInvalidInvite
	}
	if !ValidAddr(c.Addr) || !validPort(c.Port) || !validFingerprint(c.Fingerprint) || c.Token == "" {
		return InviteCode{}, ErrInvalidInvite
	}
	return c, nil
}

// ValidAddr 는 IP 주소이거나 LDH 규칙의 호스트 이름인가다. 허용 목록이다 —
// 제어 문자·비 ASCII·포트·경로를 받지 않는다. 이 값은 화면과 터미널에 찍힌다.
func ValidAddr(a string) bool {
	if ip, err := netip.ParseAddr(a); err == nil {
		// zone(`fe80::1%eth0`)은 받지 않는다 — `%` 뒤는 아무 글자나 올 수 있다.
		return ip.Zone() == ""
	}
	if a == "" || len(a) > maxHostLen {
		return false
	}
	for _, label := range strings.Split(a, ".") {
		if !validLabel(label) {
			return false
		}
	}
	return true
}

// validLabel 은 DNS 레이블 하나다: 영문·숫자·`-`, 1~63자, `-` 로 시작·끝나지 않는다.
func validLabel(l string) bool {
	if l == "" || len(l) > maxLabelLen || l[0] == '-' || l[len(l)-1] == '-' {
		return false
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func validPort(p int) bool { return p >= 1 && p <= maxPort }

func validFingerprint(fp string) bool {
	if len(fp) != 64 {
		return false
	}
	_, err := hex.DecodeString(fp)
	return err == nil && strings.ToLower(fp) == fp
}
