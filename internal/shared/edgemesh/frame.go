// Package edgemesh 는 간선 계층의 간선 연결과 망 정보다 (EDGE_MESH_SRS).
//
// 간선마다 계속 열어 두는 연결 하나를 갖고, 그 연결로 망 정보(`net`)·직접 정보(`hello`)·
// 간선 초대(`invite`)·생존 확인(`ping`)을 주고받는다. 그 밖의 프레임은 위층(채팅)에 넘긴다.
// 데몬 모드에서만 선다 (FR-EGM-1).
package edgemesh

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

	"dongminal/internal/shared/edge"
)

// 간선 계층이 처리하는 프레임 종류다 (FR-EGM-4). 그 밖의 종류는 위층의 것이다.
const (
	FramePing   = "ping"
	FrameHello  = "hello"
	FrameNet    = "net"
	FrameInvite = "invite"
)

// Frame 은 간선 연결의 한 줄이다. B 는 본문 원문이고, S 는 그 원문에 한 서명이다.
type Frame struct {
	T string          `json:"t"`
	B json.RawMessage `json:"b,omitempty"`
	S string          `json:"s,omitempty"`
}

// Encode 는 프레임 한 줄(끝에 줄바꿈)이다.
func Encode(fr Frame) []byte {
	raw, _ := json.Marshal(fr)
	return append(raw, '\n')
}

var errNoSigner = errors.New("노드 키로 서명할 수 없다")

func digest(kind string, body []byte) []byte {
	h := sha256.New()
	h.Write([]byte(kind))
	h.Write([]byte{0})
	h.Write(body)
	return h.Sum(nil)
}

// Sign 은 노드 키로 `SHA-256(종류 ‖ 0x00 ‖ 본문)` 에 서명한다 (PEER_CHAT_SRS FR-PCH-5).
func Sign(id edge.Identity, kind string, body []byte) (string, error) {
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

// Verify 는 Sign 의 서명을 확인한다.
func Verify(pub *ecdsa.PublicKey, kind string, body []byte, sig string) bool {
	raw, err := base64.StdEncoding.DecodeString(sig)
	if err != nil {
		return false
	}
	return ecdsa.VerifyASN1(pub, digest(kind, body), raw)
}

// SignFrame 은 v 를 본문으로 한 서명된 프레임이다.
func SignFrame(id edge.Identity, kind string, v any) (Frame, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return Frame{}, err
	}
	s, err := Sign(id, kind, body)
	if err != nil {
		return Frame{}, err
	}
	return Frame{T: kind, B: body, S: s}, nil
}

// PublicKey 는 노드 공개키(SPKI DER)의 base64 다. 그 SHA-256 이 노드 지문이다.
func PublicKey(id edge.Identity) string {
	if len(id.Certificate.Certificate) == 0 {
		return ""
	}
	cert, err := x509.ParseCertificate(id.Certificate.Certificate[0])
	if err != nil {
		return ""
	}
	return base64.StdEncoding.EncodeToString(cert.RawSubjectPublicKeyInfo)
}

// ParseKey 는 key 가 지문 node 의 공개키일 때만 그 키를 돌려준다.
func ParseKey(node, key string) (*ecdsa.PublicKey, bool) {
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

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
