package edge

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// 간선 맺기의 시간 (FR-PNW-20, EDGE_PAIRING_SRS FR-EPR-1).
const (
	InviteTTL = 10 * time.Minute
	// InvitePrefix 는 초대 코드의 접두어다 (FR-PNW-21).
	InvitePrefix = "dmedge1:"
	tokenBytes   = 16
	maxHostLen   = 253
	maxLabelLen  = 63
	// maxBoundInvites 는 지문에 묶인 초대의 상한이다 (EDGE_MESH_SRS FR-EGM-31).
	maxBoundInvites = 32
)

var (
	ErrNoInvite      = errors.New("살아 있는 초대가 없습니다")
	ErrBadToken      = errors.New("초대 토큰이 맞지 않습니다")
	ErrInvalidInvite = errors.New("초대 코드의 모양이 틀렸습니다")
)

type invite struct {
	token   string
	expires time.Time
	// fp 는 이 초대를 쓸 수 있는 지문이다. 비면 누구나 쓴다 (FR-EGM-31).
	fp string
}

// redeemed 는 쓴 초대다. 응답이 끊긴 쪽의 다시 시도를 그 초대의 만료까지 받는다 (FR-EPR-6).
type redeemed struct {
	token   string
	fp      string
	expires time.Time
}

// Pairing 은 사람이 만든 초대 하나, 지문에 묶인 초대들, 마지막으로 쓴 초대다. 메모리에만
// 둔다 — 10분짜리다.
type Pairing struct {
	mu     sync.Mutex
	now    func() time.Time
	invite *invite
	bound  []*invite
	used   *redeemed
}

// NewPairing 은 now 를 시계로 쓴다.
func NewPairing(now func() time.Time) *Pairing {
	return &Pairing{now: now}
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewInvite 는 새 초대를 만든다. 이전 초대와 그 다시 시도 기억은 사라진다 (FR-PNW-20).
func (p *Pairing) NewInvite() (token string, expires time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	inv := &invite{token: randomHex(tokenBytes), expires: p.now().Add(InviteTTL)}
	p.invite, p.used = inv, nil
	return inv.token, inv.expires
}

// NewBoundInvite 는 지문 fp 만 쓸 수 있는 초대를 만든다 (FR-EGM-31). 사람이 만든 초대와 따로
// 두어 서로 밀어내지 않는다. 상한을 넘으면 가장 오래된 것을 버린다.
func (p *Pairing) NewBoundInvite(fp string) (token string, expires time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	inv := &invite{token: randomHex(tokenBytes), expires: p.now().Add(InviteTTL), fp: fp}
	p.liveBoundLocked()
	if len(p.bound) >= maxBoundInvites {
		p.bound = p.bound[1:]
	}
	p.bound = append(p.bound, inv)
	return inv.token, inv.expires
}

// liveBoundLocked 는 만료된 묶인 초대를 지운다.
func (p *Pairing) liveBoundLocked() {
	now := p.now()
	live := p.bound[:0]
	for _, inv := range p.bound {
		if now.Before(inv.expires) {
			live = append(live, inv)
		}
	}
	p.bound = live
}

// Revoke 는 지문 fp 가 쓴 초대의 다시 시도 기억을 지운다. 간선을 지울 때 부른다 — 지운
// 간선이 쓴 토큰으로 다시 맺지 못하게 한다(보안 검토).
func (p *Pairing) Revoke(fp string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.used != nil && p.used.fp == fp {
		p.used = nil
	}
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

func sameToken(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// Redeem 은 지문 fp 의 노드가 낸 토큰을 대조한다 (FR-EPR-3·6). 살아 있는 초대와 맞으면
// 쓰고 (토큰, 지문, 만료)를 기억한다. 같은 지문이 같은 토큰으로 다시 오면 초대 만료까지
// 성공이다. 살아 있는 초대에 틀린 토큰은 ErrBadToken 이고 그 요청만 거절한다 — 128비트
// 토큰은 10분 안에 맞힐 수 없고, 횟수로 폐기하면 남이 초대를 없앨 수 있다 (I-39).
// 그 밖은 ErrNoInvite 다.
func (p *Pairing) Redeem(token, fp string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if u := p.used; u != nil && p.now().Before(u.expires) && u.fp == fp && sameToken(token, u.token) {
		return nil
	}
	p.liveBoundLocked()
	for i, b := range p.bound {
		if !sameToken(token, b.token) {
			continue
		}
		if b.fp != fp {
			return ErrBadToken
		}
		p.bound = append(p.bound[:i], p.bound[i+1:]...)
		p.used = &redeemed{token: b.token, fp: fp, expires: b.expires}
		return nil
	}
	inv := p.liveInviteLocked()
	if inv == nil {
		return ErrNoInvite
	}
	if !sameToken(token, inv.token) {
		return ErrBadToken
	}
	p.invite = nil
	p.used = &redeemed{token: inv.token, fp: fp, expires: inv.expires}
	return nil
}

// InviteCode 는 초대 코드의 내용이다 (FR-PNW-21).
type InviteCode struct {
	Addr        string `json:"addr"`
	Port        int    `json:"port"`
	Fingerprint string `json:"fp"`
	Token       string `json:"token"`
}

// EncodeInvite 는 `dmedge1:` + base64url(JSON) 이다.
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
