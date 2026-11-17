// Package peer 는 노드 간 통신의 노드 쪽 상태다 (PEER_NETWORK_SRS).
//
// 노드 신원(인증서·키), `peers.json`(노드 설정과 짝 목록), 노드 전용 리스너를
// 갖는다. HTTP 핸들러는 `httpapi` 가 짓고 여기에 넘긴다.
package peer

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// CertValidity 는 노드 인증서의 유효 기간이다 (FR-PNW-1).
const CertValidity = 10 * 365 * 24 * time.Hour

const (
	keyFilePerm  = 0o600
	certFilePerm = 0o644
)

// Identity 는 이 노드의 인증서와 그 지문이다.
type Identity struct {
	Certificate tls.Certificate
	Fingerprint string
}

// FingerprintOf 는 인증서 공개키(SPKI)의 SHA-256 소문자 16진수다 (§1.4).
func FingerprintOf(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(sum[:])
}

// LoadOrCreateIdentity 는 dir 의 노드 인증서를 읽고, 둘 다 없으면 만든다 (FR-PNW-1).
//
// 하나만 있거나 읽지 못하면 오류다. 새로 만들면 지문이 바뀌고, 그러면 짝들이 이
// 노드를 거절한다. 신원은 조용히 바꾸지 않는다.
func LoadOrCreateIdentity(dir string) (Identity, error) {
	certPath := filepath.Join(dir, dmenv.NodeCertFile)
	keyPath := filepath.Join(dir, dmenv.NodeKeyFile)
	certExists, err := fileExists(certPath)
	if err != nil {
		return Identity{}, err
	}
	keyExists, err := fileExists(keyPath)
	if err != nil {
		return Identity{}, err
	}
	switch {
	case certExists && keyExists:
		return loadIdentity(certPath, keyPath)
	case certExists || keyExists:
		return Identity{}, fmt.Errorf("노드 인증서와 키 중 하나만 있습니다 (%s, %s) — 둘 다 지우면 새 신원을 만듭니다", certPath, keyPath)
	}
	certPEM, keyPEM, err := generate()
	if err != nil {
		return Identity{}, err
	}
	if err := writeIdentityFile(keyPath, keyPEM, keyFilePerm); err != nil {
		return Identity{}, fmt.Errorf("노드 키 저장: %w", err)
	}
	if err := writeIdentityFile(certPath, certPEM, certFilePerm); err != nil {
		// 키만 남으면 다음 기동마다 "하나만 있다" 로 멈춘다. 방금 만든 키를 거둔다.
		_ = os.Remove(keyPath)
		return Identity{}, fmt.Errorf("노드 인증서 저장: %w", err)
	}
	return parseIdentity(certPEM, keyPEM)
}

// writeIdentityFile 은 신원 파일을 쓴다. 테스트가 인증서 쓰기 실패를 만들 자리다.
var writeIdentityFile = platform.WriteFileAtomic

func fileExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

func loadIdentity(certPath, keyPath string) (Identity, error) {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return Identity{}, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return Identity{}, err
	}
	return parseIdentity(certPEM, keyPEM)
}

func parseIdentity(certPEM, keyPEM []byte) (Identity, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return Identity{}, fmt.Errorf("노드 인증서를 읽지 못했습니다: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return Identity{}, fmt.Errorf("노드 인증서를 읽지 못했습니다: %w", err)
	}
	pair.Leaf = leaf
	return Identity{Certificate: pair, Fingerprint: FingerprintOf(leaf)}, nil
}

func generate() (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "dongminal node"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(-time.Hour).Add(CertValidity),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}
