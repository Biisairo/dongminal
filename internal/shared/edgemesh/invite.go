package edgemesh

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"dongminal/internal/shared/edge"
)

const (
	// maxSeenInvites 는 본 초대 id 를 기억하는 수다 (FR-EGM-33).
	maxSeenInvites = 1024
	// inviteSkew 는 초대 시각이 지금보다 앞설 수 있는 상한이다.
	inviteSkew = 5 * time.Minute
	// inviteInfo 는 초대 상자 키의 HKDF info 머리다 (FR-EGM-32).
	inviteInfo    = "dmlink1 invite"
	inviteIDBytes = 16
	gcmNonceBytes = 12
)

// inviteBody 는 간선 초대 프레임의 본문이다 (FR-EGM-33). Box 는 받을 노드만 연다.
type inviteBody struct {
	ID   string `json:"id"`
	From string `json:"from"`
	To   string `json:"to"`
	At   int64  `json:"at"`
	Exp  int64  `json:"exp"`
	Box  string `json:"box"`
}

// Invite 는 이 노드에게 온, 열린 간선 초대다 (FR-EGM-34).
type Invite struct {
	ID      string
	From    string
	Name    string
	Code    string
	Expires time.Time
}

// inviteState 는 본 초대 id 와 그 만료다. Mesh.mu 가 지킨다.
type inviteState struct {
	seen map[string]time.Time
}

func newInviteState() inviteState { return inviteState{seen: map[string]time.Time{}} }

// SendInvite 는 망 이웃 to 에게 간선 초대 코드를 보낸다 (FR-EGM-32·33). 코드는 to 의 노드
// 공개키로만 열린다. to 를 모르면 ErrUnknownNode, 초대 기억이 가득 찼으면 ErrInviteFull 이다.
func (m *Mesh) SendInvite(to, code string, exp time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.nodes[to]
	if !ok {
		return ErrUnknownNode
	}
	id := randomHex(inviteIDBytes)
	box, err := seal(m.id, r.st.Key, id, m.id.Fingerprint, to, []byte(code))
	if err != nil {
		return err
	}
	body := inviteBody{ID: id, From: m.id.Fingerprint, To: to, At: m.now().UnixMilli(), Exp: exp.UnixMilli(), Box: box}
	fr, err := SignFrame(m.id, FrameInvite, body)
	if err != nil {
		return err
	}
	if !m.rememberInviteLocked(id, exp) {
		return ErrInviteFull
	}
	m.broadcastLocked(Encode(fr), nil)
	return nil
}

// acceptInviteLocked 는 바르고 처음 보는 초대면 넘기라고(참) 답한다. 이 노드에게 온 것이면 연
// 초대도 돌려준다 (FR-EGM-33·34).
func (m *Mesh) acceptInviteLocked(fr Frame) (*Invite, bool) {
	var b inviteBody
	if json.Unmarshal(fr.B, &b) != nil || b.From == m.id.Fingerprint || !validInviteID(b.ID) {
		return nil, false
	}
	if _, seen := m.seen[b.ID]; seen {
		return nil, false
	}
	now := m.now()
	at, exp := time.UnixMilli(b.At), time.UnixMilli(b.Exp)
	if !exp.After(now) || exp.Sub(at) > edge.InviteTTL || at.After(now.Add(inviteSkew)) {
		return nil, false
	}
	r, ok := m.nodes[b.From]
	if !ok || !Verify(r.key, FrameInvite, fr.B, fr.S) {
		return nil, false
	}
	if !m.rememberInviteLocked(b.ID, exp) {
		return nil, false
	}
	if b.To != m.id.Fingerprint {
		return nil, true
	}
	plain, ok := open(m.id, r.st.Key, b.ID, b.From, b.To, b.Box)
	if !ok {
		return nil, true
	}
	ic, err := edge.DecodeInvite(string(plain))
	if err != nil || ic.Fingerprint != b.From {
		return nil, true
	}
	return &Invite{ID: b.ID, From: b.From, Name: r.st.Name, Code: string(plain), Expires: exp}, true
}

func validInviteID(id string) bool {
	raw, err := hex.DecodeString(id)
	return err == nil && len(raw) == inviteIDBytes
}

// rememberInviteLocked 는 본 초대 id 를 만료까지 기억한다. 넘치면 만료된 것을 잊고, 그래도 넘치면
// 기억하지 않고 거짓을 돌려준다 — 만료 전 항목을 밀어내면 옛 초대가 다시 뜬다 (FR-ATF-51).
func (m *Mesh) rememberInviteLocked(id string, exp time.Time) bool {
	if len(m.seen) >= maxSeenInvites {
		now := m.now()
		for k, e := range m.seen {
			if !e.After(now) {
				delete(m.seen, k)
			}
		}
		if len(m.seen) >= maxSeenInvites {
			return false
		}
	}
	m.seen[id] = exp
	return true
}

var errBadKey = errors.New("노드 키가 아니다")

// boxKey 는 내 노드 키와 상대 노드 공개키의 ECDH 로 만든 상자 키다 (FR-EGM-32).
func boxKey(id edge.Identity, peerKey, inviteID, from, to string) ([]byte, error) {
	priv, ok := id.Certificate.PrivateKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, errBadKey
	}
	der, err := base64.StdEncoding.DecodeString(peerKey)
	if err != nil {
		return nil, errBadKey
	}
	sum := sha256.Sum256(der)
	pub, ok := ParseKey(hex.EncodeToString(sum[:]), peerKey)
	if !ok {
		return nil, errBadKey
	}
	ep, err := priv.ECDH()
	if err != nil {
		return nil, err
	}
	epub, err := pub.ECDH()
	if err != nil {
		return nil, err
	}
	secret, err := ep.ECDH(epub)
	if err != nil {
		return nil, err
	}
	return hkdf.Key(sha256.New, secret, []byte(inviteID), inviteInfo+from+to, 32)
}

func boxCipher(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// seal 은 plain 을 상대 peerKey 만 열 수 있게 잠근다. 돌려준 값은 base64(nonce ‖ 암호문)이다.
func seal(id edge.Identity, peerKey, inviteID, from, to string, plain []byte) (string, error) {
	key, err := boxKey(id, peerKey, inviteID, from, to)
	if err != nil {
		return "", err
	}
	aead, err := boxCipher(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcmNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := aead.Seal(nonce, nonce, plain, []byte(inviteID+from+to))
	return base64.StdEncoding.EncodeToString(out), nil
}

// open 은 seal 의 역이다. 보낸 노드의 공개키 senderKey 로 연다.
func open(id edge.Identity, senderKey, inviteID, from, to, box string) ([]byte, bool) {
	raw, err := base64.StdEncoding.DecodeString(box)
	if err != nil || len(raw) < gcmNonceBytes {
		return nil, false
	}
	key, err := boxKey(id, senderKey, inviteID, from, to)
	if err != nil {
		return nil, false
	}
	aead, err := boxCipher(key)
	if err != nil {
		return nil, false
	}
	plain, err := aead.Open(nil, raw[:gcmNonceBytes], raw[gcmNonceBytes:], []byte(inviteID+from+to))
	if err != nil {
		return nil, false
	}
	return plain, true
}
