package httpapi

import (
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"os"
)

// VIEWER_URL_OPEN_SRS — 쉘이 띄우려는 URL 을 **보고 있는 기기**에서 연다.
//
// 판정은 하나다: 지금 워크스페이스를 보고 있는 클라이언트가 서버와 같은
// 컴퓨터인가. 같으면 부른 쉘이 직접 열고(FR-VUO-2), 다르면 그 클라이언트에게
// 넘긴다 (FR-VUO-3). 판정은 열기 요청마다 새로 한다 — 기억하지 않는다
// (FR-VUO-5).

const (
	// OpenURLAction 은 뷰어에게 URL 을 넘기는 브로드캐스트 액션이다.
	OpenURLAction = "openUrl"

	whereLocal  = "local"
	whereRemote = "remote"

	// envURLOpen 은 판정을 강제하는 손잡이다 (FR-VUO-6). `ssh -L` 터널로 붙으면
	// 구독의 원격 주소가 loopback 이라 원격 뷰어를 로컬로 오판하는데, 그때
	// 사용자가 빠져나갈 유일한 길이다.
	envURLOpen = "DONGMINAL_URL_OPEN"
)

// openURLTarget 은 args 에서 URL 을 꺼내 열어도 되는 것인지 본다 (FR-VUO-18).
// `javascript:`·`file:`·`data:` 를 뷰어의 브라우저에 실어 보내지 않는다.
func openURLTarget(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("openUrl: args.url 필수")
	}
	var args struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", errors.New("openUrl: args 파싱 실패")
	}
	if args.URL == "" {
		return "", errors.New("openUrl: args.url 필수")
	}
	u, err := url.Parse(args.URL)
	if err != nil {
		return "", errors.New("openUrl: URL 파싱 실패")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("openUrl: http/https 만 허용: " + args.URL)
	}
	if u.Host == "" {
		return "", errors.New("openUrl: host 없음: " + args.URL)
	}
	return args.URL, nil
}

// openURLWhere 는 어디서 열지와, 뷰어에서 열 경우 누구를 지명할지 낸다.
//
// 뷰어가 없으면 언제나 로컬이다 (FR-VUO-4) — 열기 요청은 소실되지 않는다.
// `viewer` 강제도 이것을 뒤집지 못한다: 열 곳이 없으면 강제할 대상도 없다.
func (s *Server) openURLWhere() (where, execClientID string) {
	if s.Focus == nil {
		return whereLocal, ""
	}
	cid, addr := s.Focus.ExecutorAddr()
	if cid == "" {
		return whereLocal, ""
	}
	switch os.Getenv(envURLOpen) {
	case whereLocal:
		return whereLocal, ""
	case "viewer":
		return whereRemote, cid
	}
	if isLoopbackAddr(addr) {
		return whereLocal, ""
	}
	return whereRemote, cid
}

// isLoopbackAddr 은 이 구독이 서버와 같은 컴퓨터에서 왔는지 본다. 주소를 모르면
// (Attach 로 붙은 구독) 원격으로 본다 — 확인을 한 번 더 묻는 쪽이 안전하다.
func isLoopbackAddr(addr string) bool {
	if addr == "" {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return host == "localhost"
}

// handleOpenURLWhere 는 **판정만** 낸다 (FR-VUO-19). 열지 않고 브로드캐스트도
// 하지 않는다.
//
// 이 종단이 없으면 사용자는 자기 환경이 R1 의 오판 상태인지 알 방법이 없다 —
// 판정이 실행에 붙어 있어 "지금 열면 어디서 열리는가" 를 물으려면 실제로
// 열어 봐야 하고, 오판일 때 그 창은 사용자가 볼 수 없는 곳에 뜬다.
func (s *Server) handleOpenURLWhere(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpErr(w, "method not allowed", http.StatusMethodNotAllowed, apierr.CodeNotAllowed)
		return
	}
	where, cid := s.openURLWhere()
	viewer, addr := "", ""
	subs := 0
	if s.Focus != nil {
		viewer, addr = s.Focus.ExecutorAddr()
		subs = s.Focus.LiveCount()
	}
	out := map[string]any{
		"where":       where,
		"viewer":      viewer,
		"viewerAddr":  addr,
		"subscribers": subs,
		// 강제 중이라는 사실은 진단의 절반이다 — 자동 판정과 구별되어야
		// "왜 이렇게 나오는가" 에 답할 수 있다.
		"forced":   os.Getenv(envURLOpen),
		"loopback": isLoopbackAddr(addr),
	}
	_ = cid
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
