package claudeacct

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"dongminal/internal/shared/platform"
)

const oauthAccountKey = "oauthAccount"

// OAuthAccount 는 `~/.claude.json` 의 `oauthAccount` 다. Raw 가 원문이다.
type OAuthAccount struct {
	Raw              json.RawMessage
	EmailAddress     string `json:"emailAddress"`
	OrganizationUUID string `json:"organizationUuid"`
	AccountUUID      string `json:"accountUuid"`
	OrganizationName string `json:"organizationName"`
}

var errConfigCorrupt = errors.New("Claude 설정 파일을 읽을 수 없습니다")

func readConfigMap(path string) (map[string]json.RawMessage, bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil || m == nil {
		return nil, false, errConfigCorrupt
	}
	return m, true, nil
}

// ReadOAuthAccount 는 설정 파일의 `oauthAccount` 다. 파일이나 키가 없으면 (_, false, nil) 이다.
func ReadOAuthAccount(path string) (OAuthAccount, bool, error) {
	m, ok, err := readConfigMap(path)
	if err != nil || !ok {
		return OAuthAccount{}, false, err
	}
	raw, ok := m[oauthAccountKey]
	if !ok || string(raw) == "null" {
		return OAuthAccount{}, false, nil
	}
	var a OAuthAccount
	if err := json.Unmarshal(raw, &a); err != nil {
		return OAuthAccount{}, false, errConfigCorrupt
	}
	a.Raw = raw
	return a, true, nil
}

// SpliceOAuthAccount 는 `oauthAccount` 키만 acct 로 바꾸고 직전 값을 돌려준다. 다른 키는
// 그대로 둔다. 읽을 수 없는 파일은 덮어쓰지 않는다 (FR-CAC-30 ⑥).
func SpliceOAuthAccount(path string, acct json.RawMessage) (json.RawMessage, error) {
	m, ok, err := readConfigMap(path)
	if err != nil {
		return nil, err
	}
	if !ok {
		m = map[string]json.RawMessage{}
	}
	prev := m[oauthAccountKey]
	if acct == nil {
		delete(m, oauthAccountKey)
	} else {
		m[oauthAccountKey] = acct
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("claude config: %w", err)
	}
	if err := platform.WriteFileAtomic(path, b, fileMode); err != nil {
		return nil, err
	}
	return prev, nil
}
