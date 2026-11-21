package edge

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/httpresp"
)

// 오래 사는 연결은 노드 포트 위의 HTTP/1.1 Upgrade 로 연다 (PEER_CHAT_SRS FR-PCH-8, §3.9).
// TLS·지문 고정·판정은 Call 과 같다. 101 뒤의 바이트는 부르는 쪽이 정한 프로토콜이다.

// Upgrade 는 t 의 path 에 proto 로 Upgrade 를 보내고, 101 을 받으면 그 연결을 돌려준다.
// 돌려준 연결에는 시한이 없다. 실패는 Call 과 같은 오류로 가른다.
func (c *Client) Upgrade(ctx context.Context, t Target, path, proto string) (net.Conn, error) {
	addr := net.JoinHostPort(t.Addr, strconv.Itoa(t.Port))
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	raw, err := c.dial(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	conn := tls.Client(raw, c.tlsConfig(t.Fingerprint))
	if d, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(d)
	}
	br, err := upgradeHandshake(ctx, conn, addr, path, proto)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	_ = conn.SetDeadline(time.Time{})
	return &bufferedConn{Conn: conn, r: br}, nil
}

func upgradeHandshake(ctx context.Context, conn *tls.Conn, addr, path, proto string) (*bufio.Reader, error) {
	if err := conn.HandshakeContext(ctx); err != nil {
		return nil, classify(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+addr+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", proto)
	if err := req.Write(conn); err != nil {
		return nil, classify(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, req)
	if err != nil {
		return nil, classify(err)
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
		_ = resp.Body.Close()
		return nil, remoteFailure(resp.StatusCode, body)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), proto) {
		return nil, fmt.Errorf("%w: upgrade %q", ErrUnreachable, resp.Header.Get("Upgrade"))
	}
	return br, nil
}

// AcceptUpgrade 는 proto 로의 Upgrade 요청을 넘겨받는다. 성공하면 101 을 쓴 연결을
// 돌려준다 — http.Server 가 걸어 둔 시한은 지운다. Upgrade 요청이 아니면 400 으로 답하고
// 거짓이다.
func AcceptUpgrade(w http.ResponseWriter, r *http.Request, proto string) (net.Conn, bool) {
	if r.Method != http.MethodGet || !headerHasToken(r.Header, "Connection", "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), proto) {
		w.Header().Set("Connection", "close")
		upgradeFail(w, http.StatusBadRequest, "bad_request", "upgrade required")
		return nil, false
	}
	conn, brw, err := http.NewResponseController(w).Hijack()
	if err != nil {
		upgradeFail(w, http.StatusInternalServerError, "internal_error", "hijack")
		return nil, false
	}
	_ = conn.SetDeadline(time.Time{})
	_, _ = brw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: " + proto + "\r\n\r\n")
	if err := brw.Flush(); err != nil {
		_ = conn.Close()
		return nil, false
	}
	return &bufferedConn{Conn: conn, r: brw.Reader}, true
}

// upgradeFail 은 노드 포트의 오류 방언 `{code,message}` 로 답한다 (FR-PNW-42).
func upgradeFail(w http.ResponseWriter, status int, code, msg string) {
	httpresp.FailCode(w, status, code, msg)
}

func headerHasToken(h http.Header, key, token string) bool {
	for _, v := range h.Values(key) {
		for _, part := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// bufferedConn 은 머리를 읽으며 버퍼에 먼저 들어온 바이트를 잃지 않는 연결이다.
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }
