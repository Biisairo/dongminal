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
	pathPrefix  = "/edge/v1/"
	pairPath    = pathPrefix + "pair"
	confirmPath = pathPrefix + "pair/confirm"
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
	// Notify 는 간선·초대·승인 대기·노드 설정이 바뀐 **뒤에** 부른다. paired 는 이
	// 노드가 승인해 간선 맺기를 마친 이름이다 (FR-PNW-81·82, FR-PDM-27).
	Notify func(paired string)
	Now    func() time.Time
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

func (n *Node) changed(paired string) {
	if n.opts.Notify != nil {
		n.opts.Notify(paired)
	}
}

// Admission 은 노드 포트의 두 단계 판정이다 (I-1, FR-PNW-24·27·41).
func (n *Node) Admission() edge.Admission {
	return edge.Admission{
		TLS: func(fp string) bool {
			return n.store.IsEdge(fp) || n.store.IsPendingOut(fp) || n.pairing.HasInvite()
		},
		Request: func(fp, path string) bool {
			switch path {
			case pairPath:
				// 간선이 아닌 상대는 초대가 살아 있을 때만이다. 초대가 있을 때 연 keep-alive
				// 연결로 그 뒤에도 닿지 못하게 한다. 간선·대기는 만료 안내(edge_no_invite)를 받는다.
				return n.pairing.HasInvite() || n.store.IsEdge(fp) || n.store.IsPendingOut(fp)
			case confirmPath:
				return n.store.IsEdge(fp) || n.store.IsPendingOut(fp)
			}
			return n.store.IsEdge(fp)
		},
	}
}

// Handler 는 노드 포트의 핸들러다. 짝맞춤 경로 둘 밖은 전부 404 다
// (FR-PNW-6, FR-PDM-60).
func (n *Node) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+pairPath, n.pair)
	mux.HandleFunc("POST "+confirmPath, n.pairConfirm)
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

// pair 는 B 쪽 등록 요청이다 (FR-PNW-23~25).
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
	if in.Port < 1 || in.Port > 65535 {
		writeFail(w, http.StatusBadRequest, CodeBadRequest, "port")
		return
	}
	// I-4: A 가 알릴 주소를 정하지 않았으면 이 연결의 출발지를 쓴다.
	addr := in.Addr
	if !edge.ValidAddr(addr) {
		addr = host
	}
	// 승인할 때 쓸 수 없는 주소(zone 이 붙은 link-local 등)면 초대를 쓰기 전에 거절한다.
	// 받아 두면 그 대기는 승인되지 않고 초대만 사라진다 (리뷰 C-15).
	if !edge.ValidAddr(addr) {
		audit("in", "-", "pair", http.StatusBadRequest)
		writeFail(w, http.StatusBadRequest, edge.CodeConfigInvalid, "addr: set advertise on the requesting node")
		return
	}
	switch err := n.pairing.Consume(in.Token); err {
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
	name := in.Name
	if edge.ValidName(name) != nil {
		name = edge.DefaultName(name)
	}
	n.pairing.AddPending(edge.Pending{Name: name, Addr: addr, Port: in.Port, Fingerprint: edge.ClientFingerprint(r)})
	audit("in", name, "pair", http.StatusOK)
	n.changed("")
	httpresp.JSON(w, http.StatusOK, map[string]any{"status": "pending", "name": n.store.Config().Name})
}

// pairConfirm 은 A 쪽 승인 통지다 (FR-PNW-27).
func (n *Node) pairConfirm(w http.ResponseWriter, r *http.Request) {
	fp := edge.ClientFingerprint(r)
	err := n.store.Promote(fp)
	switch {
	case err == nil, errors.Is(err, edge.ErrAlreadyPaired):
	case errors.Is(err, edge.ErrNotPending):
		audit("in", "-", "pair.confirm", http.StatusForbidden)
		writeFail(w, http.StatusForbidden, edge.CodeRejected, "not pending")
		return
	default:
		// pending-out 인데 바꾸지 못했으면 저장 실패다 (L-6).
		audit("in", "-", "pair.confirm", http.StatusInternalServerError)
		writeFail(w, http.StatusInternalServerError, CodeSaveFailed, "save failed")
		return
	}
	name, _ := n.store.NameOf(fp)
	audit("in", name, "pair.confirm", http.StatusOK)
	// I-24: 이미 간선이었으면 바뀐 것이 없다.
	if err == nil {
		n.changed("")
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"paired": true})
}

// Pairing 은 초대·승인 대기 상태다.
func (n *Node) Pairing() *edge.Pairing { return n.pairing }
