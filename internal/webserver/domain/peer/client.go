package peer

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"time"
)

// 보내는 쪽의 시간 한도 (FR-PNW-44)와 응답 상한.
const (
	DialTimeout      = 5 * time.Second
	RequestTimeout   = 15 * time.Second
	maxResponseBytes = 1 << 20
)

var (
	// ErrUnreachable 은 상대에 닿지 못했다는 뜻이다 (FR-PNW-74).
	ErrUnreachable = errors.New("상대 노드에 닿지 못했습니다")
	// ErrFingerprintMismatch 는 상대 서버 인증서의 지문이 기대와 다르다는 뜻이다 (FR-PNW-22).
	ErrFingerprintMismatch = errors.New("상대 노드의 지문이 기대와 다릅니다")
	// ErrRejected 는 상대가 이 노드를 받지 않았다는 뜻이다 (짝이 아님·해제됨).
	ErrRejected = errors.New("상대 노드가 이 노드를 받지 않았습니다")
)

// Target 은 부를 상대 하나다. Fingerprint 가 그 신원이다.
type Target struct {
	Addr        string
	Port        int
	Fingerprint string
}

// RemoteError 는 상대가 돌려준 `{code,message}` 다 (FR-PNW-42).
type RemoteError struct {
	Status  int
	Code    string
	Message string
}

func (e *RemoteError) Error() string {
	return fmt.Sprintf("상대 노드가 거절했습니다 (%d %s): %s", e.Status, e.Code, e.Message)
}

// Client 는 이 노드의 인증서를 내밀고 상대의 지문을 고정해 부른다 (D-3).
type Client struct {
	id Identity
}

// NewClient 는 id 를 클라이언트 인증서로 쓴다.
func NewClient(id Identity) *Client { return &Client{id: id} }

// Call 은 t 의 path 에 in 을 JSON 으로 POST 하고, 성공이면 응답을 out 에 푼다.
// out 이 nil 이면 응답 본문을 버린다.
func (c *Client) Call(ctx context.Context, t Target, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	url := "https://" + net.JoinHostPort(t.Addr, strconv.Itoa(t.Port)) + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.httpClient(t.Fingerprint).Do(req)
	if err != nil {
		return classify(err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var e struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &e) != nil || e.Code == "" {
			if resp.StatusCode == http.StatusForbidden {
				return ErrRejected
			}
			return &RemoteError{Status: resp.StatusCode, Code: "", Message: string(raw)}
		}
		return &RemoteError{Status: resp.StatusCode, Code: e.Code, Message: e.Message}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func (c *Client) httpClient(fp string) *http.Client {
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{c.id.Certificate},
		// 노드 인증서는 자기 서명이라 체인을 볼 것이 없다. 신원은 지문이다 (D-3).
		InsecureSkipVerify: true, //nolint:gosec // 체인 대신 VerifyConnection 이 지문을 대조한다
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 || FingerprintOf(cs.PeerCertificates[0]) != fp {
				return ErrFingerprintMismatch
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: RequestTimeout,
		Transport: &http.Transport{
			DialContext:         (&net.Dialer{Timeout: DialTimeout}).DialContext,
			TLSClientConfig:     cfg,
			TLSHandshakeTimeout: DialTimeout,
			DisableKeepAlives:   true,
		},
	}
}

// classify 는 전송 실패를 셋으로 가른다: 지문 불일치, 상대의 거절, 닿지 못함.
func classify(err error) error {
	if errors.Is(err, ErrFingerprintMismatch) {
		return ErrFingerprintMismatch
	}
	// TLS 1.3 에서 상대가 클라이언트 인증서를 거절하면 핸드셰이크 뒤 첫 읽기에서
	// 경보(alert)로 온다. 그 자리는 "remote error" 다.
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "remote error" {
		return ErrRejected
	}
	return fmt.Errorf("%w: %v", ErrUnreachable, err)
}
