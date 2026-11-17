package chat

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
	"unicode"
	"unicode/utf8"

	"dongminal/internal/shared/edge"
)

// 프레임 종류다 (§3.9). 기록 서명은 프레임이 아니지만 같은 서명 방식을 쓴다.
const (
	frameState = "state"
	frameMsg   = "msg"
	framePing  = "ping"
	signRecord = "room"
)

// frame 은 채팅 연결의 한 줄이다. B 는 본문 원문이고, S 는 그 원문에 한 서명이다.
type frame struct {
	T string          `json:"t"`
	B json.RawMessage `json:"b,omitempty"`
	S string          `json:"s,omitempty"`
}

// statePart 는 노드 상태 알림의 참가자 하나다.
type statePart struct {
	ID    string   `json:"id"`
	Label string   `json:"label"`
	Kind  string   `json:"kind"`
	Rooms []string `json:"rooms,omitempty"`
}

// stateBody 는 노드 상태 알림이다 (FR-PCH-9). 노드는 자기에 대해서만 말한다.
type stateBody struct {
	Node  string         `json:"node"`
	Key   string         `json:"key"`
	Name  string         `json:"name"`
	Epoch int64          `json:"epoch"`
	Seq   uint64         `json:"seq"`
	Links []string       `json:"links,omitempty"`
	Parts []statePart    `json:"parts,omitempty"`
	Rooms []signedRecord `json:"rooms,omitempty"`
}

// msgBody 는 글 하나다. (Epoch, Seq) 가 보낸 노드 안의 순서다 (FR-PCH-32).
type msgBody struct {
	ID    string    `json:"id"`
	Node  string    `json:"node"`
	Epoch int64     `json:"epoch"`
	Seq   uint64    `json:"seq"`
	Room  string    `json:"room"`
	From  string    `json:"from"`
	Text  string    `json:"text"`
	At    time.Time `json:"at"`
}

// recordBody 는 방의 생성 기록이다 (FR-PCH-10·14). Key 는 만든 노드의 공개키라서, 만든
// 노드를 모르는 노드도 기록 하나로 서명을 확인한다.
type recordBody struct {
	Kind    string `json:"kind"`
	Creator string `json:"creator"`
	Key     string `json:"key"`
	Owner   string `json:"owner,omitempty"`
	Peer    string `json:"peer,omitempty"`
	// PeerNode 는 개인채팅 상대가 있는 노드다. 두 참가자를 각자의 노드에 묶는다.
	PeerNode string    `json:"peerNode,omitempty"`
	Name     string    `json:"name,omitempty"`
	Purpose  string    `json:"purpose,omitempty"`
	Created  time.Time `json:"created"`
	Nonce    string    `json:"nonce"`
}

// signedRecord 는 생성 기록 원문과 서명이다.
type signedRecord struct {
	B json.RawMessage `json:"b"`
	S string          `json:"s"`
}

// id 는 방 id — 생성 기록 원문의 SHA-256 이다 (FR-PCH-10).
func (r signedRecord) id() string {
	sum := sha256.Sum256(r.B)
	return hex.EncodeToString(sum[:])
}

var errNoSigner = errors.New("노드 키로 서명할 수 없다")

func digest(kind string, body []byte) []byte {
	h := sha256.New()
	h.Write([]byte(kind))
	h.Write([]byte{0})
	h.Write(body)
	return h.Sum(nil)
}

func sign(id edge.Identity, kind string, body []byte) (string, error) {
	signer, ok := id.Certificate.PrivateKey.(crypto.Signer)
	if !ok {
		return "", errNoSigner
	}
	sig, err := signer.Sign(rand.Reader, digest(kind, body), crypto.SHA256)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sig), nil
}

func verify(pub *ecdsa.PublicKey, kind string, body []byte, sig string) bool {
	raw, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		return false
	}
	return ecdsa.VerifyASN1(pub, digest(kind, body), raw)
}

func signFrame(id edge.Identity, kind string, v any) (frame, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return frame{}, err
	}
	s, err := sign(id, kind, body)
	if err != nil {
		return frame{}, err
	}
	return frame{T: kind, B: body, S: s}, nil
}

// publicKeyOf 는 노드 공개키(SPKI DER)의 base64 다. 그 SHA-256 이 노드 지문이다.
func publicKeyOf(id edge.Identity) string {
	if len(id.Certificate.Certificate) == 0 {
		return ""
	}
	cert, err := x509.ParseCertificate(id.Certificate.Certificate[0])
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(cert.RawSubjectPublicKeyInfo)
}

// parseKey 는 key 가 지문 node 의 공개키일 때만 그 키를 돌려준다 (FR-PCH-5).
func parseKey(node, key string) (*ecdsa.PublicKey, bool) {
	der, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return nil, false
	}
	sum := sha256.Sum256(der)
	if hex.EncodeToString(sum[:]) != node {
		return nil, false
	}
	pk, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, false
	}
	ec, ok := pk.(*ecdsa.PublicKey)
	return ec, ok
}

// newRecord 는 id 의 노드가 서명한 생성 기록이다. 만든 노드와 키는 id 로 채운다.
func newRecord(id edge.Identity, b recordBody) (signedRecord, error) {
	b.Creator = id.Fingerprint
	b.Key = publicKeyOf(id)
	body, err := json.Marshal(b)
	if err != nil {
		return signedRecord{}, err
	}
	s, err := sign(id, signRecord, body)
	if err != nil {
		return signedRecord{}, err
	}
	return signedRecord{B: body, S: s}, nil
}

// openRecord 는 서명과 내용이 바른 생성 기록을 푼다 (FR-PCH-10·11).
func openRecord(r signedRecord) (recordBody, bool) {
	var b recordBody
	if json.Unmarshal(r.B, &b) != nil {
		return recordBody{}, false
	}
	pub, ok := parseKey(b.Creator, b.Key)
	if !ok || !verify(pub, signRecord, r.B, r.S) {
		return recordBody{}, false
	}
	switch b.Kind {
	case KindGroup:
		ok = validText(b.Name, maxName) && b.Name != "" && b.Peer == ""
	case KindDirect:
		ok = b.Owner != "" && b.Peer != "" && b.Owner != b.Peer && b.PeerNode != "" && validID(b.PeerNode)
	default:
		ok = false
	}
	return b, ok && validText(b.Purpose, maxPurpose) && validID(b.Owner) && validID(b.Peer)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// validText 는 화면·터미널에 찍을 한 줄 문자열인지 본다. 제어 문자를 받지 않는다.
func validText(s string, max int) bool {
	if len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// validBody 는 글 본문인지 본다. 줄바꿈과 탭만 받고 다른 제어 문자는 받지 않는다 — 본문은
// 도구 결과와 화면에 찍힌다.
func validBody(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r == '\n' || r == '\t' {
			continue
		}
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// validID 는 참가자·글 id 모양(짧은 hex 같은 값)인지 본다. 빈 값도 받는다.
func validID(s string) bool {
	if len(s) > maxID {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
