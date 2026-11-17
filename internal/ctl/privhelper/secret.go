package privhelper

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const (
	totpBytes     = 20
	recoveryCount = 8
)

// Secret 은 도우미의 비밀 파일이다 (NFR-PCH-2). root 만 읽는다.
type Secret struct {
	UID int `json:"uid"`
	// TOTP 는 base32(패딩 없음) 비밀이다.
	TOTP string `json:"totp"`
	// Key 는 사람 명령 서명 키(Ed25519 시드)의 base64 다.
	Key string `json:"key"`
	// Recovery 는 복구 코드의 SHA-256 hex, Used 는 쓴 것이다.
	Recovery []string `json:"recovery"`
	Used     []string `json:"used,omitempty"`
}

// newSecret 은 새 비밀과 복구 코드 원문을 만든다. 원문은 한 번만 보인다.
func newSecret(uid int) (Secret, []string, error) {
	raw := make([]byte, totpBytes)
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(raw); err != nil {
		return Secret{}, nil, err
	}
	if _, err := rand.Read(seed); err != nil {
		return Secret{}, nil, err
	}
	s := Secret{
		UID:  uid,
		TOTP: base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw),
		Key:  base64.StdEncoding.EncodeToString(seed),
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding)
	codes := make([]string, 0, recoveryCount)
	for range recoveryCount {
		b := make([]byte, 7)
		if _, err := rand.Read(b); err != nil {
			return Secret{}, nil, err
		}
		c := strings.ToLower(enc.EncodeToString(b))[:10]
		c = c[:5] + "-" + c[5:]
		codes = append(codes, c)
		s.Recovery = append(s.Recovery, hashRecovery(c))
	}
	return s, codes, nil
}

var errBadKey = errors.New("privhelper: 서명 키가 틀렸다")

func decodeKey(k string) ([]byte, error) {
	seed, err := base64.StdEncoding.DecodeString(k)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errBadKey
	}
	return seed, nil
}

// loadSecret 은 비밀 파일을 읽는다.
func loadSecret(path string) (Secret, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Secret{}, err
	}
	var s Secret
	if err := json.Unmarshal(raw, &s); err != nil {
		return Secret{}, err
	}
	return s, nil
}

// saveSecret 은 비밀 파일을 0700 폴더의 0600 파일로 쓴다. 임시 파일에 쓴 뒤 바꿔 넣는다.
func saveSecret(path string, s Secret) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
