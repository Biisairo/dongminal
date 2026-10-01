package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// ATTENTION_FIRING_SRS 묶음 D — 한 컴퓨터에서 한 번 (FR-ATD-4~6·9).

// V-ATD-1: (seq, 컴퓨터, 종류)마다 처음 온 청구 하나만 승낙된다.
func TestAttnClaims_FirstClaimPerSeqHostKind(t *testing.T) {
	c := newAttnClaims()

	if got := c.claim(1, "self", []string{"banner", "sound"}); !slices.Equal(got, []string{"banner", "sound"}) {
		t.Fatalf("첫 청구가 승낙되지 않았다: %v", got)
	}
	if got := c.claim(1, "self", []string{"banner", "sound"}); len(got) != 0 {
		t.Fatalf("같은 컴퓨터의 두 번째 청구가 승낙되었다: %v", got)
	}
	if got := c.claim(1, "100.64.0.9", []string{"banner"}); !slices.Equal(got, []string{"banner"}) {
		t.Fatalf("다른 컴퓨터의 청구가 거절되었다: %v", got)
	}
	if got := c.claim(2, "self", []string{"sound"}); !slices.Equal(got, []string{"sound"}) {
		t.Fatalf("다음 알람의 청구가 거절되었다: %v", got)
	}
}

// V-ATD-1: 종류는 서로 독립이다 — 배너를 못 내는 창이 소리만 맡고, 다른 창이
// 배너를 맡을 수 있어야 한다 (FR-ATD-3).
func TestAttnClaims_KindsAreIndependent(t *testing.T) {
	c := newAttnClaims()

	if got := c.claim(7, "self", []string{"sound"}); !slices.Equal(got, []string{"sound"}) {
		t.Fatalf("소리 청구가 거절되었다: %v", got)
	}
	if got := c.claim(7, "self", []string{"banner", "sound"}); !slices.Equal(got, []string{"banner"}) {
		t.Fatalf("남은 배너만 승낙되어야 한다: %v", got)
	}
}

// 모르는 종류는 승낙 목록에 오르지 않는다.
func TestAttnClaims_UnknownKindIgnored(t *testing.T) {
	c := newAttnClaims()
	if got := c.claim(1, "self", []string{"vibrate", "banner"}); !slices.Equal(got, []string{"banner"}) {
		t.Fatalf("모르는 종류가 걸러지지 않았다: %v", got)
	}
}

// V-ATD-3: 기록은 attnClaimTTL 동안만 산다. 지난 기록은 다음 청구가 치운다 (FR-ATD-6).
func TestAttnClaims_ExpireAfterTTL(t *testing.T) {
	c := newAttnClaims()
	now := time.Unix(1000, 0)
	c.now = func() time.Time { return now }

	c.claim(1, "self", []string{"banner"})
	now = now.Add(attnClaimTTL + time.Second)
	c.claim(2, "self", []string{"banner"}) // 치우기는 청구가 온 김에 한다
	if _, ok := c.bySeq[1]; ok {
		t.Fatal("지난 기록이 치워지지 않았다")
	}
	if got := c.claim(1, "self", []string{"banner"}); !slices.Equal(got, []string{"banner"}) {
		t.Fatalf("치워진 뒤의 청구가 거절되었다: %v", got)
	}
}

// V-ATD-2: loopback 과 이 기계의 인터페이스 주소는 하나의 "이 기계" 다 (FR-ATD-5).
func TestClaimHost_SelfAddressesAreOneComputer(t *testing.T) {
	st := newAccessStoreAt(t, filepath.Join(t.TempDir(), "access.json"))
	self := netip.MustParseAddr("100.64.0.1")
	st.interfaceAddrs = func() ([]netip.Addr, error) { return []netip.Addr{self}, nil }
	st.refresh()
	s := &Server{Access: st}

	for _, ra := range []string{"127.0.0.1:5000", "[::1]:5001", "100.64.0.1:5002", "[::ffff:127.0.0.1]:5003"} {
		if got := s.claimHost(ra); got != attnClaimSelfHost {
			t.Errorf("%s → %q, want 이 기계", ra, got)
		}
	}
	if a, b := s.claimHost("100.64.0.9:1"), s.claimHost("100.64.0.9:2"); a != b || a == attnClaimSelfHost {
		t.Errorf("다른 기기의 두 연결이 한 컴퓨터로 묶이지 않았다: %q %q", a, b)
	}
	if s.claimHost("100.64.0.9:1") == s.claimHost("100.64.0.10:1") {
		t.Error("다른 두 기기가 한 컴퓨터로 묶였다")
	}
}

func postClaim(s *Server, remote, body string) *httptest.ResponseRecorder {
	req := apiTestRequest(http.MethodPost, "/api/tools/attention/claim", strings.NewReader(body))
	req.RemoteAddr = remote
	rec := httptest.NewRecorder()
	s.apiToolAttentionClaim(rec, req)
	return rec
}

// FR-ATD-4: 종단은 같은 컴퓨터의 두 창 중 처음 하나만 승낙한다.
func TestApiToolAttentionClaim_GrantsOncePerComputer(t *testing.T) {
	s := &Server{}
	decode := func(rec *httptest.ResponseRecorder) []string {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
		}
		var got struct {
			Granted []string `json:"granted"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		return got.Granted
	}

	first := decode(postClaim(s, "127.0.0.1:4000", `{"seq":5,"kinds":["banner","sound"]}`))
	second := decode(postClaim(s, "[::1]:4001", `{"seq":5,"kinds":["banner","sound"]}`))
	if !slices.Equal(first, []string{"banner", "sound"}) || len(second) != 0 {
		t.Fatalf("first=%v second=%v", first, second)
	}
}

func TestApiToolAttentionClaim_RejectsMissingSeq(t *testing.T) {
	s := &Server{}
	for _, body := range []string{`{}`, `{"seq":0,"kinds":["banner"]}`, `not json`} {
		if got := postClaim(s, "127.0.0.1:1", body).Code; got != http.StatusBadRequest {
			t.Errorf("body=%q status=%d, want 400", body, got)
		}
	}
}
