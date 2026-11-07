package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS X-d · TC-SDA-9 — 저장하려는 목록이 지금 출발지를 잠그는가.
// 판정은 게이트의 `allowed` 와 같은 판정기로 한다 — IPv6·별칭·자기 주소가 화면과 갈리던 자리다.

const checkSelf = "192.168.7.7"

// checkStore 는 자기 주소 하나와, 해석된 호스트명 둘(box.lan → fd00::5, far.lan → 10.9.9.9)을
// 가진 저장소다. 호스트명은 저장된 목록에 있어야 해석 기록이 생긴다.
func checkStore(t *testing.T) *accessStore {
	t.Helper()
	st := newTestAccessStore(t)
	st.interfaceAddrs = func() ([]netip.Addr, error) { return []netip.Addr{netip.MustParseAddr(checkSelf)}, nil }
	st.lookupHost = func(h string) ([]string, error) {
		switch h {
		case "box.lan":
			return []string{"fd00::5"}, nil
		case "far.lan":
			return []string{"10.9.9.9"}, nil
		}
		return nil, &fakeDNSErr{h}
	}
	mustSetConfig(t, st, accessConfig{Entries: []accessEntry{entry("box.lan"), entry("far.lan"), entry("gone.lan")}})
	return st
}

type fakeDNSErr struct{ h string }

func (e *fakeDNSErr) Error() string { return "no such host " + e.h }

func on(vals ...string) accessConfig {
	cfg := accessConfig{Enabled: true}
	for _, v := range vals {
		cfg.Entries = append(cfg.Entries, entry(v))
	}
	return cfg
}

func TestAccessCheckSave(t *testing.T) {
	disabled := entry("10.0.0.0/8")
	disabled.Enabled = false
	cases := []struct {
		name string
		cfg  accessConfig
		you  string
		ok   bool
	}{
		{"목록을 끄면 잠기지 않는다", accessConfig{Enabled: false}, "10.0.0.5", true},
		{"IPv4 대역이 품는다", on("10.0.0.0/8"), "10.0.0.5", true},
		{"IPv4 대역 밖", on("10.0.0.0/8"), "172.16.0.5", false},
		{"IPv4 주소 그대로", on("172.16.0.5"), "172.16.0.5", true},
		{"IPv6 대역이 품는다", on("fd00::/8"), "fd00::42", true},
		{"IPv6 대역 밖 — 화면은 '모른다' 로 통과시켰다", on("fd00::/8"), "2001:db8::1", false},
		{"IPv4 대역은 IPv6 출발지를 품지 않는다", on("10.0.0.0/8"), "fd00::42", false},
		{"IPv4-mapped 출발지는 IPv4 로 본다", on("10.0.0.0/8"), "::ffff:10.0.0.5", true},
		{"loopback 은 자기다", on("10.0.0.0/8"), "127.0.0.1", true},
		{"이 기계의 인터페이스 주소는 자기다", on("10.0.0.0/8"), checkSelf, true},
		{"별칭(해석된 호스트명)이 품는다", on("box.lan"), "fd00::5", true},
		{"해석된 호스트명이 품지 않는다", on("far.lan"), "fd00::5", false},
		{"해석에 실패한 호스트명은 품지 않는다", on("gone.lan"), "fd00::5", false},
		{"해석 기록이 없는 새 이름은 모른다 — 경고하지 않는다", on("new.lan"), "fd00::5", true},
		{"꺼진 항목은 세지 않는다", accessConfig{Enabled: true, Entries: []accessEntry{disabled}}, "10.0.0.5", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			st := checkStore(t)
			a, err := st.checkSave(c.cfg, netip.MustParseAddr(c.you))
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if a.OK != c.ok {
				t.Fatalf("ok = %v, want %v (%+v)", a.OK, c.ok, a)
			}
			if !a.OK {
				if a.Why != apierr.CodeLocksYouOut || a.Args["you"] != netip.MustParseAddr(c.you).Unmap().String() {
					t.Fatalf("answer = %+v, want locks_you_out with you", a)
				}
				if !action.Catalog.MayGive(action.AccessSave, a.Why) {
					t.Fatalf("%s 의 사유 %q 가 Catalog 에 없다", action.AccessSave, a.Why)
				}
			}
		})
	}
}

// 묻기는 저장하지 않는다 — 지금의 게이트는 그대로다.
func TestAccessCheckDoesNotSave(t *testing.T) {
	st := checkStore(t)
	if _, err := st.checkSave(on("10.0.0.0/8"), netip.MustParseAddr("10.0.0.5")); err != nil {
		t.Fatal(err)
	}
	if st.config().Enabled || !st.allowed(netip.MustParseAddr("172.16.0.5")) {
		t.Fatal("묻기가 설정이나 판정기를 바꿨다")
	}
}

// 검증은 저장과 같다 — 같은 값을 PUT 해도 같은 사유로 거절된다.
func TestAccessCheckValidatesLikeSave(t *testing.T) {
	st := checkStore(t)
	bad := on("10.0.0.300")
	_, checkErr := st.checkSave(bad, netip.MustParseAddr("10.0.0.5"))
	putErr := st.setConfig(bad)
	if checkErr == nil || putErr == nil || checkErr.Error() != putErr.Error() {
		t.Fatalf("check err = %v, put err = %v — 같아야 한다", checkErr, putErr)
	}
}

func TestAccessCheckEndpoint(t *testing.T) {
	srv := &Server{Access: checkStore(t)}
	body, _ := json.Marshal(on("10.0.0.0/8"))
	req := apiTestRequest(http.MethodPost, "/api/access/check", bytes.NewReader(body))
	req.RemoteAddr = "172.16.0.5:5555"
	rec := httptest.NewRecorder()
	srv.apiAccessCheck(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Actions map[string]action.Answer `json:"actions"`
		You     string                   `json:"you"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	a := got.Actions[action.AccessSave]
	if a.OK || a.Why != apierr.CodeLocksYouOut || got.You != "172.16.0.5" {
		t.Fatalf("got = %+v", got)
	}

	req = apiTestRequest(http.MethodPost, "/api/access/check", bytes.NewReader([]byte(`{"enabled":true,"entries":[{"value":"nope!"}]}`)))
	req.RemoteAddr = "172.16.0.5:5555"
	rec = httptest.NewRecorder()
	srv.apiAccessCheck(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("잘못된 값의 묻기 = %d, want 400 (PUT 과 같다)", rec.Code)
	}
}
