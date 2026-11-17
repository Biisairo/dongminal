// Package edgenode 는 노드 하나의 상태와 연산이다 (PEER_DAEMON_SRS FR-PDM-2, §3.5a).
//
// 신원·`edges.json`·짝맞춤 상태·속도 제한을 갖고, 노드 포트의 판정과 짝맞춤 경로 둘,
// 로컬 API 연산(Do)을 처리한다. 데몬과 직접 모드의 서버가 같은 코드를 쓴다 — 판정을
// 두 벌 두지 않는다 (D-PDM-15). webserver 축을 가져오지 않는다.
package edgenode

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/httpreq"
	"dongminal/internal/shared/httpresp"
)

const (
	// pathPrefix 는 노드 포트가 받는 유일한 경로다 (FR-PNW-6).
	pathPrefix = "/edge/v1/"
	pairPath   = pathPrefix + "pair"
	unpairPath = pathPrefix + "unpair"
	chatPath   = pathPrefix + "chat"
	// pairRateKey 는 등록 요청 상한의 키 머리다. 간선의 지문 키와 섞이지 않는다.
	pairRateKey = "pair-addr:"
	// proto 는 이 노드가 말하는 프로토콜 판이다. 등록 요청에 싣는다 (FR-PNW-50).
	proto = 1
	// legacySpawnsFile 은 원격 기동 기록의 옛 파일이다. 노드가 설 때 지운다 (FR-PDM-64).
	legacySpawnsFile = "peer-spawns.json"
	// bodyLimit 은 노드 포트 요청 본문의 상한이다 (FR-PNW-43).
	bodyLimit = 64 << 10
)

// 노드가 내는 일반 오류 코드. 값은 apierr 카탈로그의 것과 같다 — httpapi 시험이 지킨다.
const (
	CodeBadRequest  = "bad_request"
	CodeNotFound    = "not_found"
	CodeInternal    = "internal_error"
	CodeInvalidJSON = "invalid_json"
	CodeBodyTooBig  = "body_too_large"
	CodeStaleRev    = "stale_revision"
	CodeSaveFailed  = "save_failed"
)

// codeHeader 는 오류 코드를 싣는 응답 헤더다. apierr.CodeHeader 와 같다.
const codeHeader = "X-Error-Code"

// Codes 는 노드가 낼 수 있는 코드 전부다. 상대가 보낸 코드는 이 안에 있을 때만 옮긴다.
func Codes() []string {
	return append([]string{CodeBadRequest, CodeNotFound, CodeInternal, CodeInvalidJSON,
		CodeBodyTooBig, CodeStaleRev, CodeSaveFailed}, edge.Codes...)
}

// Options 는 노드를 세우는 값이다.
type Options struct {
	Home     string
	Hostname string
	// Dial 은 발신 연결이다. nil 이면 TCP 다. 데몬은 발신 소켓을 지난다 (FR-PDM-22).
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
	// PortStatus 는 노드 포트의 지금 상태다. nil 이면 닫혀 있다.
	PortStatus func() edge.Status
	// OnConfig 는 노드 설정이 저장된 뒤 부른다. 노드 포트에 바로 적용한다.
	OnConfig func(edge.Config)
	// Notify 는 간선·초대·노드 설정이 바뀐 **뒤에** 부른다. 간선을 맺거나 지웠으면 그
	// 간선을 싣는다 (EDGE_PAIRING_SRS FR-EPR-5·23, FR-PDM-27).
	Notify func(Change)
	// Chat 은 채팅 연결 경로의 핸들러다. nil 이면 그 경로는 404 다 (PEER_CHAT_SRS §3.9).
	Chat http.Handler
	Now  func() time.Time
}

// Ref 는 맺거나 지운 간선 하나다.
type Ref struct {
	FP   string `json:"fp"`
	Name string `json:"name"`
}

// Change 는 Notify 의 값이다. 둘 다 nil 이면 초대·노드 설정·주소만 바뀌었다.
type Change struct {
	Paired  *Ref `json:"paired,omitempty"`
	Removed *Ref `json:"removed,omitempty"`
}

// Node 는 노드 하나다.
type Node struct {
	opts    Options
	store   *edge.Store
	id      edge.Identity
	client  *edge.Client
	pairing *edge.Pairing
	limiter *edge.RateLimiter
	// mu 는 ETag 검사와 노드 설정 저장을 한 덩이로 묶는다.
	mu sync.Mutex
}

// New 는 노드를 세운다. 옛 홈 파일을 정리하고 저장소와 신원을 연다. 신원을 읽지
// 못하면 오류다 — 부르는 쪽은 노드 기능 없이 계속 선다.
func New(o Options) (*Node, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if err := edge.MigrateLegacyFiles(o.Home); err != nil {
		dmlog.Infof(nil, "edge config: 옛 홈 파일을 정리하지 못했다: %v", err)
	}
	if err := os.Remove(filepath.Join(o.Home, legacySpawnsFile)); err != nil && !os.IsNotExist(err) {
		dmlog.Infof(nil, "peer-spawns.json 을 지우지 못했다: %v", err)
	}
	store := edge.OpenStore(filepath.Join(o.Home, dmenv.EdgesFile), o.Hostname)
	id, err := edge.LoadOrCreateIdentity(o.Home)
	if err != nil {
		return nil, err
	}
	client := edge.NewClient(id)
	if o.Dial != nil {
		client = edge.NewClientVia(id, o.Dial)
	}
	return &Node{
		opts: o, store: store, id: id, client: client,
		pairing: edge.NewPairing(o.Now), limiter: edge.NewRateLimiter(o.Now),
	}, nil
}

// Identity 는 노드 신원이다.
func (n *Node) Identity() edge.Identity { return n.id }

// Config 는 노드 설정이다.
func (n *Node) Config() edge.Config { return n.store.Config() }

// Store 는 간선 저장소다.
func (n *Node) Store() *edge.Store { return n.store }

func (n *Node) portStatus() edge.Status {
	if n.opts.PortStatus == nil {
		return edge.Status{}
	}
	return n.opts.PortStatus()
}

func (n *Node) changed(c Change) {
	if n.opts.Notify != nil {
		n.opts.Notify(c)
	}
}

// Admission 은 노드 포트의 두 단계 판정이다 (EDGE_PAIRING_SRS FR-EPR-41, D-EPR-4). TLS 는
// 클라이언트 인증서가 있으면 받는다 — 간선이 아닌 상대에게도 "간선이 아니다"를 말하려면
// TLS 를 마쳐야 한다. 요청 단계에서 pair 는 누구나 닿고 처리기가 초대·토큰·횟수를 본다.
// 그 밖의 경로는 간선만 닿고, 아니면 403 edge_not_edge 다.
func (n *Node) Admission() edge.Admission {
	return edge.Admission{
		TLS: func(string) bool { return true },
		Request: func(fp, path string) bool {
			return path == pairPath || n.store.IsEdge(fp)
		},
	}
}

// IsNotEdge 는 상대가 이 노드를 간선이 아니라고 답했는가다 (FR-EPR-22).
func IsNotEdge(err error) bool {
	var re *edge.RemoteError
	return errors.As(err, &re) && re.Code == edge.CodeNotEdge
}

// Handler 는 노드 포트의 핸들러다. 맺기·지우기 경로와 채팅 연결 경로 밖은 전부 404 다
// (FR-EPR-40, FR-PDM-60, PEER_CHAT_SRS §3.9).
func (n *Node) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+pairPath, n.pair)
	mux.HandleFunc("POST "+unpairPath, n.unpair)
	if n.opts.Chat != nil {
		mux.Handle(chatPath, n.opts.Chat)
	}
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeFail(w, http.StatusNotFound, CodeNotFound, "not found")
	})
	return recoverHandler(mux)
}

// recoverHandler 는 핸들러의 panic 을 500 으로 바꾼다. 노드 포트 하나의 요청이 프로세스를
// 내리지 않게 한다.
func recoverHandler(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				dmlog.Infof(nil, "edge handler panic: %v", v)
				writeFail(w, http.StatusInternalServerError, CodeInternal, "internal error")
			}
		}()
		h.ServeHTTP(w, r)
	})
}

// writeFail 은 오류 하나다 — fs 방언 `{code,message}` (FR-PNW-42, I-7).
func writeFail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set(codeHeader, code)
	httpresp.JSON(w, status, map[string]string{"code": code, "message": msg})
}

// readBody 는 본문을 상한 안에서 읽는다. 실패하면 답하고 nil, 거짓이다.
func readBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	raw, err := httpreq.Read(w, r, bodyLimit)
	if err != nil {
		code := CodeBadRequest
		if errors.Is(err, httpreq.ErrTooLarge) {
			code = CodeBodyTooBig
		}
		writeFail(w, httpreq.Status(err), code, "read body")
		return nil, false
	}
	return raw, true
}

// audit 는 짝맞춤 요청 한 줄이다. 본문·토큰은 남기지 않는다 (FR-PNW-94·95, FR-PDM-26).
func audit(dir, name, op string, status int) {
	if name == "" {
		name = "-"
	}
	dmlog.Infof(nil, "edge audit dir=%s edge=%s op=%s status=%d", dir, name, op, status)
}

// pair 는 B 쪽 맺기 요청이다 (FR-EPR-2·3·6·8). 토큰이 맞으면 A 의 지문을 바로 간선으로
// 저장한다. A 가 노드 포트를 알렸을 때만 A 의 주소를 저장한다 — 비어 있으면 B 는 걸지 않는다.
func (n *Node) pair(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Token string `json:"token"`
		Name  string `json:"name"`
		Addr  string `json:"addr"`
		Port  int    `json:"port"`
		Proto int    `json:"proto"`
	}
	// S9: 간선이 아닌 상대도 닿는 경로다. 지문은 상대가 연결마다 바꿀 수 있으므로 출발지
	// 주소마다 센다(IPv6 는 /64). 넘은 요청은 감사 로그에 남기지 않는다 — 실패마다 쌓이면
	// 로그가 공격 대상이 된다.
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if !n.limiter.Allow(pairRateKey + edge.AddrRateKey(host)) {
		writeFail(w, http.StatusTooManyRequests, edge.CodeRateLimited, "rate limited")
		return
	}
	raw, ok := readBody(w, r)
	if !ok {
		return
	}
	if res := decode(raw, &in); res != nil {
		writeFail(w, res.Status, res.Code, res.Message)
		return
	}
	addr, port := "", 0
	if in.Port != 0 {
		if in.Port < 1 || in.Port > 65535 {
			writeFail(w, http.StatusBadRequest, CodeBadRequest, "port")
			return
		}
		// I-4: A 가 알릴 주소를 정하지 않았으면 이 연결의 출발지를 쓴다.
		addr, port = in.Addr, in.Port
		if !edge.ValidAddr(addr) {
			addr = host
		}
		// 저장할 수 없는 주소(zone 이 붙은 link-local 등)면 초대를 쓰기 전에 거절한다 (리뷰 C-15).
		if !edge.ValidAddr(addr) {
			audit("in", "-", "pair", http.StatusBadRequest)
			writeFail(w, http.StatusBadRequest, edge.CodeConfigInvalid, "addr: set advertise on the requesting node")
			return
		}
	}
	fp := edge.ClientFingerprint(r)
	switch err := n.pairing.Redeem(in.Token, fp); err {
	case nil:
	case edge.ErrNoInvite:
		audit("in", "-", "pair", http.StatusForbidden)
		writeFail(w, http.StatusForbidden, edge.CodeNoInvite, err.Error())
		return
	default:
		audit("in", "-", "pair", http.StatusForbidden)
		writeFail(w, http.StatusForbidden, edge.CodeTokenInvalid, err.Error())
		return
	}
	name := edge.DisplayName(in.Name)
	if err := n.store.AddEdge(edge.Edge{Name: name, Addr: addr, Port: port, Fingerprint: fp}); err != nil {
		audit("in", name, "pair", http.StatusInternalServerError)
		writeFail(w, http.StatusInternalServerError, CodeSaveFailed, "save failed")
		return
	}
	audit("in", name, "pair", http.StatusOK)
	n.changed(Change{Paired: &Ref{FP: fp, Name: name}})
	httpresp.JSON(w, http.StatusOK, map[string]any{"name": n.store.Config().Name})
}

// unpair 는 상대가 간선을 지웠다는 알림이다 (FR-EPR-21). 출입 판정이 간선만 들인다.
func (n *Node) unpair(w http.ResponseWriter, r *http.Request) {
	fp := edge.ClientFingerprint(r)
	e, err := n.store.Resolve(fp)
	if err == nil {
		err = n.store.Remove(fp)
	}
	switch {
	case err == nil:
	case errors.Is(err, edge.ErrEdgeNotFound):
		// 판정과 지우기 사이에 이쪽에서 먼저 지웠다.
		writeFail(w, http.StatusForbidden, edge.CodeNotEdge, "not an edge")
		return
	default:
		audit("in", e.Name, "unpair", http.StatusInternalServerError)
		writeFail(w, http.StatusInternalServerError, CodeSaveFailed, "save failed")
		return
	}
	audit("in", e.Name, "unpair", http.StatusOK)
	n.changed(Change{Removed: &Ref{FP: fp, Name: e.Name}})
	httpresp.JSON(w, http.StatusOK, map[string]any{})
}

// Forget 은 상대가 이미 지운 간선을 이쪽에서도 지운다. 채팅이 상대에게서 edge_not_edge 를
// 받았을 때 부른다 (FR-EPR-22). 간선이 아니면 아무것도 하지 않는다.
func (n *Node) Forget(fp string) {
	e, err := n.store.Resolve(fp)
	if err != nil || e.Fingerprint != fp {
		return
	}
	if err := n.store.Remove(fp); err != nil {
		dmlog.Infof(nil, "edge forget: %v", err)
		return
	}
	audit("out", e.Name, "forget", http.StatusOK)
	n.changed(Change{Removed: &Ref{FP: fp, Name: e.Name}})
}

// Pairing 은 초대 상태다.
func (n *Node) Pairing() *edge.Pairing { return n.pairing }
