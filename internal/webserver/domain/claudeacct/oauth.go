package claudeacct

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	// DefaultTokenBase 는 OAuth 토큰 엔드포인트의 주소다.
	DefaultTokenBase = "https://platform.claude.com"
	tokenPath        = "/v1/oauth/token"
	// oauthClientID 는 Claude Code 의 공개 OAuth 클라이언트 식별자다. 비밀이 아니다.
	oauthClientID  = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	refreshTimeout = 10 * time.Second
	// expirySkew 는 만료 판정의 여유다 (FR-CAC-42).
	expirySkew = 5 * time.Minute
)

// ErrReloginRequired 는 서버가 갱신 토큰을 거절했다는 뜻이다. 다시 로그인해 추가해야 한다 (FR-CAC-41).
var ErrReloginRequired = errors.New("다시 로그인해야 합니다")

// TokenResult 는 갱신 응답이다.
type TokenResult struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int64
	Scopes       []string
}

func (c Client) tokenBase() string {
	if c.TokenBase != "" {
		return strings.TrimRight(c.TokenBase, "/")
	}
	return DefaultTokenBase
}

// Refresh 는 refresh token 으로 새 access token 을 받는다 (FR-CAC-40). 400·401·403 이고 본문의
// `error` 가 `invalid_grant`·`invalid_client` 일 때만 영구 실패(ErrReloginRequired)다.
func (c Client) Refresh(ctx context.Context, refreshToken string) (TokenResult, error) {
	ctx, cancel := context.WithTimeout(ctx, refreshTimeout)
	defer cancel()
	body, _ := json.Marshal(map[string]string{
		"grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": oauthClientID,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenBase()+tokenPath, bytes.NewReader(body))
	if err != nil {
		return TokenResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	resp, err := c.client().Do(req)
	if err != nil {
		return TokenResult{}, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIBody))
	if err != nil {
		return TokenResult{}, err
	}
	if resp.StatusCode != http.StatusOK {
		if resp.StatusCode == 400 || resp.StatusCode == 401 || resp.StatusCode == 403 {
			var e struct {
				Error string `json:"error"`
			}
			if json.Unmarshal(raw, &e) == nil && (e.Error == "invalid_grant" || e.Error == "invalid_client") {
				return TokenResult{}, fmt.Errorf("%w (%s)", ErrReloginRequired, e.Error)
			}
		}
		return TokenResult{}, &HTTPStatusError{Status: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After")}
	}
	var v struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Scope        string `json:"scope"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || v.AccessToken == "" {
		return TokenResult{}, errors.New("token 응답을 읽을 수 없습니다")
	}
	return TokenResult{AccessToken: v.AccessToken, RefreshToken: v.RefreshToken, ExpiresIn: v.ExpiresIn, Scopes: strings.Fields(v.Scope)}, nil
}

// WithTokens 는 갱신 결과를 담은 사본이다. refresh token 은 응답에 있을 때만 바꾼다.
func (c Credential) WithTokens(tr TokenResult, nowMs int64) Credential {
	o := make(map[string]json.RawMessage, len(c.oauth)+3)
	for k, v := range c.oauth {
		o[k] = v
	}
	set := func(k string, v any) {
		b, _ := json.Marshal(v)
		o[k] = b
	}
	set("accessToken", tr.AccessToken)
	set("expiresAt", nowMs+tr.ExpiresIn*1000)
	if tr.RefreshToken != "" {
		set("refreshToken", tr.RefreshToken)
	}
	if len(tr.Scopes) > 0 {
		set("scopes", tr.Scopes)
	}
	return Credential{top: c.cloneTop(), oauth: o}
}

// expired 는 access token 이 now 기준 5분 안에 만료되는가다 (FR-CAC-42).
func (c Credential) expired(now time.Time) bool {
	return now.Add(expirySkew).UnixMilli() >= c.ExpiresAt()
}
