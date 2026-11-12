package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// DefaultBaseURL 은 Bot API 의 주소다. 시험은 가짜 서버로 바꾼다 (§5).
const DefaultBaseURL = "https://api.telegram.org"

// maxResponse 는 응답 본문의 상한이다.
const maxResponse = 4 << 20

// APIError 는 Bot API 가 ok=false 로 답한 것이다.
type APIError struct {
	Code        int
	Description string
	// RetryAfter 는 429 의 기다릴 초다.
	RetryAfter int
}

func (e *APIError) Error() string {
	return fmt.Sprintf("telegram %d: %s", e.Code, e.Description)
}

// Client 는 Bot API 호출이다. 오류 문구에 token 을 싣지 않는다 (FR-TGB-3).
type Client struct {
	base  string
	token string
	hc    *http.Client
}

func NewClient(base, token string, hc *http.Client) *Client {
	if base == "" {
		base = DefaultBaseURL
	}
	if hc == nil {
		hc = &http.Client{Timeout: 70 * time.Second}
	}
	return &Client{base: base, token: token, hc: hc}
}

// Call 은 method 를 JSON 본문으로 부르고 result 를 out 에 읽는다. out 이 nil 이면 버린다.
func (c *Client) Call(ctx context.Context, method string, params map[string]any, out any) error {
	if params == nil {
		params = map[string]any{}
	}
	body, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("telegram %s: %w", method, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/bot"+c.token+"/"+method, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("telegram %s: 요청을 만들지 못했다", method)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.hc.Do(req)
	if err != nil {
		// url.Error 는 URL(=token)을 싣는다. 안쪽 오류만 남긴다.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return fmt.Errorf("telegram %s: %w", method, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxResponse))
	if err != nil {
		return fmt.Errorf("telegram %s: 응답을 읽지 못했다: %w", method, err)
	}
	var env struct {
		OK          bool            `json:"ok"`
		Result      json.RawMessage `json:"result"`
		ErrorCode   int             `json:"error_code"`
		Description string          `json:"description"`
		Parameters  struct {
			RetryAfter int `json:"retry_after"`
		} `json:"parameters"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return fmt.Errorf("telegram %s: 응답이 JSON 이 아니다 (HTTP %d)", method, res.StatusCode)
	}
	if !env.OK {
		code := env.ErrorCode
		if code == 0 {
			code = res.StatusCode
		}
		return &APIError{Code: code, Description: env.Description, RetryAfter: env.Parameters.RetryAfter}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(env.Result, out); err != nil {
		return fmt.Errorf("telegram %s: 결과를 읽지 못했다: %w", method, err)
	}
	return nil
}

// User 는 Bot API 의 User 중 쓰는 것이다.
type User struct {
	ID               int64  `json:"id"`
	IsBot            bool   `json:"is_bot"`
	Username         string `json:"username"`
	HasTopicsEnabled bool   `json:"has_topics_enabled"`
}

type Chat struct {
	ID   int64  `json:"id"`
	Type string `json:"type"`
}

// Message 는 Bot API 의 Message 중 쓰는 것이다.
type Message struct {
	MessageID int64  `json:"message_id"`
	From      *User  `json:"from"`
	Chat      Chat   `json:"chat"`
	ThreadID  int64  `json:"message_thread_id"`
	Text      string `json:"text"`
}

type CallbackQuery struct {
	ID      string   `json:"id"`
	From    User     `json:"from"`
	Message *Message `json:"message"`
	Data    string   `json:"data"`
}

type Update struct {
	UpdateID      int64          `json:"update_id"`
	Message       *Message       `json:"message"`
	CallbackQuery *CallbackQuery `json:"callback_query"`
}

func (c *Client) GetMe(ctx context.Context) (User, error) {
	var u User
	err := c.Call(ctx, "getMe", nil, &u)
	return u, err
}

// GetUpdates 는 long polling 이다 (NFR-TGB-3). timeoutSec 이 0 이면 바로 돌아온다.
func (c *Client) GetUpdates(ctx context.Context, offset int64, timeoutSec int) ([]Update, error) {
	var ups []Update
	err := c.Call(ctx, "getUpdates", map[string]any{"offset": offset, "timeout": timeoutSec,
		"allowed_updates": []string{"message", "callback_query"}}, &ups)
	return ups, err
}
