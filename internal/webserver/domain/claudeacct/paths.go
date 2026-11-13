package claudeacct

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"

	"golang.org/x/text/unicode/norm"
)

const (
	keychainServiceBase = "Claude Code-credentials"
	credentialsFileName = ".credentials.json"
	globalConfigName    = ".claude.json"
	legacyConfigName    = ".config.json"
)

// ClaudePaths 는 Claude Code 설정 폴더 하나가 쓰는 자리다. Claude Code 의 규칙을 따른다
// (cswap `paths.py`).
type ClaudePaths struct {
	ConfigHome      string
	GlobalConfig    string
	Credentials     string
	KeychainService string
}

// DefaultClaudePaths 는 기본 프로필(`~/.claude`)의 자리다. `CLAUDE_CONFIG_DIR` 은 보지
// 않는다 — 활성 저장소는 늘 기본 프로필이다.
func DefaultClaudePaths(userHome string) ClaudePaths {
	ch := filepath.Join(userHome, ".claude")
	return ClaudePaths{
		ConfigHome:      ch,
		GlobalConfig:    pickGlobalConfig(filepath.Join(ch, legacyConfigName), filepath.Join(userHome, globalConfigName)),
		Credentials:     filepath.Join(ch, credentialsFileName),
		KeychainService: keychainServiceBase,
	}
}

// ProfileClaudePaths 는 `CLAUDE_CONFIG_DIR=dir` 로 실행한 Claude Code 의 자리다 (FR-CAC-82).
func ProfileClaudePaths(dir string) ClaudePaths {
	return ClaudePaths{
		ConfigHome:      dir,
		GlobalConfig:    pickGlobalConfig(filepath.Join(dir, legacyConfigName), filepath.Join(dir, globalConfigName)),
		Credentials:     filepath.Join(dir, credentialsFileName),
		KeychainService: keychainServiceBase + "-" + profileHash(dir),
	}
}

// profileHash 는 `CLAUDE_CONFIG_DIR` 원문(NFC)의 SHA-256 앞 8자다. Claude Code 가 프로필의
// 키체인 항목 이름을 이렇게 만든다.
func profileHash(dir string) string {
	sum := sha256.Sum256([]byte(norm.NFC.String(dir)))
	return hex.EncodeToString(sum[:])[:8]
}

// pickGlobalConfig 은 Claude Code 2.1.299 의 선택이다. 옛 `.config.json` 이 일반 파일이고
// 비어 있지 않거나, 비어 있어도 쓸 수 있고 `.claude.json` 이 없으면 옛 파일을 쓴다.
func pickGlobalConfig(legacy, global string) string {
	st, err := os.Stat(legacy)
	if err != nil || !st.Mode().IsRegular() {
		return global
	}
	if st.Size() > 0 {
		return legacy
	}
	if st.Mode().Perm()&0o222 != 0 {
		if _, err := os.Stat(global); os.IsNotExist(err) {
			return legacy
		}
	}
	return global
}

// CredLockDirs 는 Claude Code 가 토큰을 갱신할 때 잡는 두 락이다. 순서가 계약이다.
func (p ClaudePaths) CredLockDirs() []string {
	return []string{
		filepath.Join(p.ConfigHome, ".oauth_refresh.lock"),
		filepath.Join(filepath.Dir(p.ConfigHome), filepath.Base(p.ConfigHome)+".lock"),
	}
}

// ConfigLockDir 은 전역 설정 파일의 락이다.
func (p ClaudePaths) ConfigLockDir() string { return p.GlobalConfig + ".lock" }
