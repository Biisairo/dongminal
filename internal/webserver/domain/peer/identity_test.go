package peer

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
)

// FR-PNW-1: 처음이면 만든다 — ECDSA P-256, 자기 서명, 10년, 키 0600.
func TestLoadOrCreateIdentityCreates(t *testing.T) {
	dir := t.TempDir()
	id, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatalf("LoadOrCreateIdentity: %v", err)
	}
	leaf, err := x509.ParseCertificate(id.Certificate.Certificate[0])
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	pub, ok := leaf.PublicKey.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("공개키가 ECDSA P-256 이 아니다: %T", leaf.PublicKey)
	}
	if err := leaf.CheckSignature(leaf.SignatureAlgorithm, leaf.RawTBSCertificate, leaf.Signature); err != nil {
		t.Fatalf("자기 서명이 아니다: %v", err)
	}
	if string(leaf.RawIssuer) != string(leaf.RawSubject) {
		t.Fatal("발급자와 주체가 다르다")
	}
	life := leaf.NotAfter.Sub(leaf.NotBefore)
	if life < CertValidity-24*time.Hour || life > CertValidity+24*time.Hour {
		t.Fatalf("유효 기간 %v, 기대 %v", life, CertValidity)
	}
	st, err := os.Stat(filepath.Join(dir, dmenv.NodeKeyFile))
	if err != nil {
		t.Fatalf("키 파일: %v", err)
	}
	if perm := st.Mode().Perm(); testpath.PermChecked() && perm != 0o600 {
		t.Fatalf("키 파일 권한 %o, 기대 600", perm)
	}
	if _, err := os.Stat(filepath.Join(dir, dmenv.NodeCertFile)); err != nil {
		t.Fatalf("인증서 파일: %v", err)
	}
}

// 지문은 SPKI 의 SHA-256 소문자 16진수다 (§1.4).
func TestFingerprintIsSPKISHA256(t *testing.T) {
	id, err := LoadOrCreateIdentity(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(id.Certificate.Certificate[0])
	sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
	want := hex.EncodeToString(sum[:])
	if got := FingerprintOf(leaf); got != want {
		t.Fatalf("FingerprintOf = %q, 기대 %q", got, want)
	}
	if id.Fingerprint != want {
		t.Fatalf("Identity.Fingerprint = %q, 기대 %q", id.Fingerprint, want)
	}
}

// FR-PNW-1: 이미 있으면 다시 만들지 않는다 — 지문이 같아야 한다.
func TestLoadOrCreateIdentityReuses(t *testing.T) {
	dir := t.TempDir()
	first, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	keyBefore, _ := os.ReadFile(filepath.Join(dir, dmenv.NodeKeyFile))
	second, err := LoadOrCreateIdentity(dir)
	if err != nil {
		t.Fatal(err)
	}
	if first.Fingerprint != second.Fingerprint {
		t.Fatalf("지문이 바뀌었다: %s → %s", first.Fingerprint, second.Fingerprint)
	}
	keyAfter, _ := os.ReadFile(filepath.Join(dir, dmenv.NodeKeyFile))
	if string(keyBefore) != string(keyAfter) {
		t.Fatal("키 파일을 다시 썼다")
	}
}

// 신원을 조용히 바꾸지 않는다 — 망가진 키를 덮어쓰면 모든 짝이 끊긴다.
func TestLoadOrCreateIdentityCorruptFails(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreateIdentity(dir); err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(dir, dmenv.NodeKeyFile)
	if err := os.WriteFile(keyPath, []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateIdentity(dir); err == nil {
		t.Fatal("망가진 키에 오류가 없다")
	}
	got, _ := os.ReadFile(keyPath)
	if string(got) != "garbage" {
		t.Fatal("망가진 키 파일을 덮어썼다")
	}
}

// 둘 중 하나만 있으면 오류다 — 한쪽을 새로 만들면 짝이 아는 신원과 갈린다.
func TestLoadOrCreateIdentityPartialFails(t *testing.T) {
	dir := t.TempDir()
	if _, err := LoadOrCreateIdentity(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, dmenv.NodeCertFile)); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateIdentity(dir); err == nil {
		t.Fatal("인증서만 없는데 오류가 없다")
	}
	if _, err := os.Stat(filepath.Join(dir, dmenv.NodeCertFile)); err == nil {
		t.Fatal("인증서를 새로 만들었다")
	}
}
