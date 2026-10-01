package httpapi

import (
	"net"
	"net/http"
	"net/netip"
	"sync"
	"time"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpresp"
)

// 한 컴퓨터에서 한 번 (ATTENTION_FIRING_SRS 묶음 D).
//
// 알람은 모든 창에 방송되고, 창마다 배너·소리를 내면 창 수만큼 운다 (§1.13). 서버가
// 담당을 미리 지명하지 않는 이유는 지명된 창이 낼 수 없는 상태일 때 **아무도 울리지
// 않기** 때문이다 (D-10). 그래서 알람을 받고 실제로 낼 수 있는 창이 손을 들고,
// 컴퓨터마다 처음 든 손 하나만 승낙한다.

// attnClaimTTL 은 승낙 기록의 수명이다 (FR-ATD-6). 같은 알람의 청구는 방송 직후
// 수 밀리초 안에 모이므로, 재연결로 늦게 닿는 창까지 덮을 만큼만 둔다.
const attnClaimTTL = time.Minute

// attnClaimSelfHost 는 "이 기계" 의 컴퓨터 키다 (FR-ATD-5).
const attnClaimSelfHost = "self"

// attnClaimKinds 는 맡을 수 있는 종류다 (FR-ATD-3).
var attnClaimKinds = map[string]bool{"banner": true, "sound": true}

type attnClaimRec struct {
	at      time.Time
	granted map[string]bool // 컴퓨터 + "\x00" + 종류
}

type attnClaims struct {
	mu    sync.Mutex
	bySeq map[uint64]*attnClaimRec
	now   func() time.Time
}

func newAttnClaims() *attnClaims {
	return &attnClaims{bySeq: map[uint64]*attnClaimRec{}, now: time.Now}
}

// claim 은 이 컴퓨터가 seq 알람의 kinds 중 무엇을 맡는지 답한다. 이미 다른 창이 맡은
// 종류와 모르는 종류는 빠진다. 지난 기록은 이 자리에서 치운다 — 타이머를 두지 않는다.
func (c *attnClaims) claim(seq uint64, host string, kinds []string) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, r := range c.bySeq {
		if now.Sub(r.at) > attnClaimTTL {
			delete(c.bySeq, k)
		}
	}
	rec := c.bySeq[seq]
	if rec == nil {
		rec = &attnClaimRec{at: now, granted: map[string]bool{}}
		c.bySeq[seq] = rec
	}
	granted := []string{}
	for _, kind := range kinds {
		key := host + "\x00" + kind
		if !attnClaimKinds[kind] || rec.granted[key] {
			continue
		}
		rec.granted[key] = true
		granted = append(granted, kind)
	}
	return granted
}

// claimHost 는 청구의 출발지를 컴퓨터 키로 바꾼다 (FR-ATD-5). loopback 과 이 기계의
// 인터페이스 주소는 모두 "이 기계" 다. 주소를 못 읽으면 원문을 그대로 키로 쓴다.
func (s *Server) claimHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	addr = addr.Unmap()
	if addr.IsLoopback() || (s.Access != nil && s.Access.isSelf(addr)) {
		return attnClaimSelfHost
	}
	return addr.String()
}

func (s *Server) attnClaimReg() *attnClaims {
	s.attnClaimsOnce.Do(func() { s.attnClaims = newAttnClaims() })
	return s.attnClaims
}

// apiToolAttentionClaim 은 창이 알람의 배너·소리를 맡겠다는 청구다 (FR-ATD-4).
// Body: {"seq":N,"kinds":["banner","sound"]} → {"granted":[...]}. 서버는 seq 의
// 출처를 검증하지 않는다 (FR-ATD-9).
func (s *Server) apiToolAttentionClaim(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Seq   uint64   `json:"seq"`
		Kinds []string `json:"kinds"`
	}
	ok, answered := readBodyHTTP(w, r, &req)
	if answered {
		return
	}
	if !ok {
		httpErr(w, "bad request", http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	if req.Seq == 0 {
		httpErr(w, "seq required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	granted := s.attnClaimReg().claim(req.Seq, s.claimHost(r.RemoteAddr), req.Kinds)
	httpresp.JSON(w, http.StatusOK, map[string]any{"granted": granted})
}
