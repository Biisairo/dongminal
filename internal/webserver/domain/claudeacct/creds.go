// Package claudeacct 는 Claude 다중 계정의 도메인이다 (CLAUDE_ACCOUNTS_SRS).
//
// 계정마다 자격증명을 백업하고, Claude Code 가 읽는 활성 저장소를 바꿔 끼워 계정을
// 전환한다. 토큰 값은 이 패키지 밖으로 나가지 않는다 (FR-CAC-9) — 비교와 로그에는
// 지문(Fingerprint)만 쓴다.
package claudeacct

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

const oauthKey = "claudeAiOauth"

// sharedKeys 는 계정이 아니라 기계에 속하는 최상위 필드다 (FR-CAC-8).
var sharedKeys = []string{"mcpOAuth", "mcpOAuthClientConfig", "mcpXaaIdp", "mcpXaaIdpConfig", "pluginSecrets"}

var errNotObject = errors.New("자격증명이 JSON 객체가 아닙니다")

// Credential 은 Claude Code 의 자격증명 JSON 이다. 모르는 필드는 원문 그대로 지닌다 (FR-CAC-7).
type Credential struct {
	top   map[string]json.RawMessage
	oauth map[string]json.RawMessage
}

// ParseCredential 은 자격증명 JSON 을 읽는다. 객체가 아니면 오류다.
func ParseCredential(b []byte) (Credential, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(b, &top); err != nil || top == nil {
		return Credential{}, errNotObject
	}
	c := Credential{top: top}
	if raw, ok := top[oauthKey]; ok {
		if err := json.Unmarshal(raw, &c.oauth); err != nil {
			return Credential{}, errNotObject
		}
	}
	return c, nil
}

// Marshal 은 자격증명을 JSON 으로 낸다.
func (c Credential) Marshal() ([]byte, error) {
	top := c.cloneTop()
	if c.oauth != nil {
		raw, err := json.Marshal(c.oauth)
		if err != nil {
			return nil, err
		}
		top[oauthKey] = raw
	}
	return json.Marshal(top)
}

func (c Credential) cloneTop() map[string]json.RawMessage {
	top := make(map[string]json.RawMessage, len(c.top))
	for k, v := range c.top {
		top[k] = v
	}
	return top
}

func (c Credential) str(key string) string {
	var s string
	if raw, ok := c.oauth[key]; ok {
		_ = json.Unmarshal(raw, &s)
	}
	return s
}

func (c Credential) num(key string) int64 {
	var f float64
	if raw, ok := c.oauth[key]; ok {
		_ = json.Unmarshal(raw, &f)
	}
	return int64(f)
}

func (c Credential) AccessToken() string  { return c.str("accessToken") }
func (c Credential) RefreshToken() string { return c.str("refreshToken") }

// ExpiresAt 은 access token 의 만료 시각(ms)이다.
func (c Credential) ExpiresAt() int64 { return c.num("expiresAt") }

// RefreshTokenExpiresAt 은 로그인 만료 시각(ms)이다. 없으면 0 이다 (FR-CAC-45).
func (c Credential) RefreshTokenExpiresAt() int64 { return c.num("refreshTokenExpiresAt") }

// IsEmpty 는 쓸 수 있는 토큰이 하나도 없다는 뜻이다.
func (c Credential) IsEmpty() bool { return c.AccessToken() == "" && c.RefreshToken() == "" }

// Fingerprint 는 refresh token(없으면 access token)의 SHA-256 앞 12자리다 (FR-CAC-9).
func (c Credential) Fingerprint() string {
	t := c.RefreshToken()
	if t == "" {
		t = c.AccessToken()
	}
	if t == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(t))
	return hex.EncodeToString(sum[:])[:12]
}

// WithShared 는 c 의 기계 공유 필드를 live 의 것으로 바꾼 사본이다. live 에 없는 공유 필드는
// 지운다. 그 밖의 필드는 c 의 것 그대로다 (FR-CAC-8).
func (c Credential) WithShared(live Credential) Credential {
	top := c.cloneTop()
	for _, k := range sharedKeys {
		if v, ok := live.top[k]; ok {
			top[k] = v
		} else {
			delete(top, k)
		}
	}
	return Credential{top: top, oauth: c.oauth}
}
