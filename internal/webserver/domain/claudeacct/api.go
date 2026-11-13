package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultAPIBase 는 Anthropic API 주소다. 시험은 가짜 서버로 바꾼다.
const DefaultAPIBase = "https://api.anthropic.com"

const (
	profilePath    = "/api/oauth/profile"
	profileTimeout = 5 * time.Second
	maxAPIBody     = 1 << 20
)

// Identity 는 토큰 주인이다 (FR-CAC-33).
type Identity struct {
	AccountUUID string
	Email       string
	OrgUUID     string
}

// ProfileLookup 은 토큰의 주인을 묻는다.
type ProfileLookup interface {
	Profile(ctx context.Context, accessToken string) (Identity, error)
}

// HTTPStatusError 는 2xx 가 아닌 응답이다. 본문은 싣지 않는다.
type HTTPStatusError struct {
	Status     int
	RetryAfter string
}

func (e *HTTPStatusError) Error() string { return fmt.Sprintf("anthropic api: status %d", e.Status) }

var errProfileShape = errors.New("profile 응답에 account.uuid 가 없습니다")

// Client 는 Anthropic OAuth API 를 부른다. 토큰은 헤더로만 보내고 어디에도 남기지 않는다.
type Client struct {
	Base string
	// TokenBase 는 OAuth 토큰 엔드포인트 주소다. 비면 DefaultTokenBase.
	TokenBase string
	HC        *http.Client
	UserAgent string
}

func (c Client) base() string {
	if c.Base != "" {
		return strings.TrimRight(c.Base, "/")
	}
	return DefaultAPIBase
}

func (c Client) client() *http.Client {
	if c.HC != nil {
		return c.HC
	}
	return http.DefaultClient
}

// get 은 Bearer 토큰으로 GET 해서 본문을 돌려준다.
func (c Client) get(ctx context.Context, path, token string, timeout time.Duration, extra map[string]string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base()+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", c.UserAgent)
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	resp, err := c.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIBody))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return body, &HTTPStatusError{Status: resp.StatusCode, RetryAfter: resp.Header.Get("Retry-After")}
	}
	return body, nil
}

// Profile 은 `GET /api/oauth/profile` 이다. `account.uuid` 가 없으면 오류다.
func (c Client) Profile(ctx context.Context, token string) (Identity, error) {
	body, err := c.get(ctx, profilePath, token, profileTimeout, nil)
	if err != nil {
		return Identity{}, err
	}
	var v struct {
		Account *struct {
			UUID  string `json:"uuid"`
			Email string `json:"email"`
		} `json:"account"`
		Organization *struct {
			UUID string `json:"uuid"`
		} `json:"organization"`
	}
	if err := json.Unmarshal(body, &v); err != nil || v.Account == nil || strings.TrimSpace(v.Account.UUID) == "" {
		return Identity{}, errProfileShape
	}
	id := Identity{AccountUUID: strings.TrimSpace(v.Account.UUID), Email: v.Account.Email}
	if v.Organization != nil {
		id.OrgUUID = v.Organization.UUID
	}
	return id, nil
}
