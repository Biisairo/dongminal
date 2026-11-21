package edgenode

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/termtext"
)

// 로컬 API 연산 (PEER_NETWORK_SRS FR-PNW-70, PEER_DAEMON_SRS FR-PDM-30).
//
// `/api/edges/*` 하나가 연산 하나다. 서버는 요청 본문을 Args 로 넘기고, 답의 상태·본문·
// 오류 코드·ETag 를 그대로 쓴다. 데몬 모드에서는 IPC 메서드 `edge` 가 이것을 나른다.

// Request 는 연산 하나다. Args 는 JSON 본문이고 비어 있으면 `{}` 다.
type Request struct {
	Op      string
	Args    json.RawMessage
	IfMatch string
}

// Response 는 연산의 답이다. Code 가 비지 않으면 오류이고 Body 는 없다.
type Response struct {
	Status  int
	Code    string
	Message string
	Body    json.RawMessage
	ETag    string
}

func fail(status int, code, msg string) Response {
	return Response{Status: status, Code: code, Message: msg}
}

func ok(v any) Response {
	raw, err := json.Marshal(v)
	if err != nil {
		return fail(http.StatusInternalServerError, CodeInternal, "encode")
	}
	return Response{Status: http.StatusOK, Body: raw}
}

// decode 는 Args 를 v 에 푼다. 틀렸으면 400 invalid_json 답이다.
func decode(raw json.RawMessage, v any) *Response {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		r := fail(http.StatusBadRequest, CodeInvalidJSON, "invalid json")
		return &r
	}
	return nil
}

// tag 는 노드 설정의 지문이다 (UX_BATCH12 FR-LIV-1). 실행 중에 정해지는 값(노드 포트 상태,
// 간선의 알림 대기 등)은 넣지 않는다 — 그것이 바뀌었다고 저장이 낡은 것은 아니다.
func tag(c edge.Config) string {
	c.Edges = append([]edge.Edge{}, c.Edges...)
	for i := range c.Edges {
		c.Edges[i].Pending = false
	}
	b, err := json.Marshal(c)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// Do 는 연산 하나를 처리한다. 상대 노드를 부르는 연산은 ctx 로 끊는다.
func (n *Node) Do(ctx context.Context, req Request) Response {
	switch req.Op {
	case "get":
		r := ok(n.view())
		r.ETag = tag(n.store.Config())
		return r
	case "node":
		return n.opNode(req)
	case "profile":
		r := ok(n.profile())
		r.ETag = tag(n.store.Config())
		return r
	case "profile_name":
		return n.opProfileName(req)
	case "invite":
		return n.opInvite(req)
	case "add":
		return n.opAdd(ctx, req)
	case "remove":
		return n.opRemove(ctx, req)
	case "address":
		return n.opAddress(req)
	case "notify":
		return n.opNotify(ctx, req)
	case "invite_send":
		return n.opInviteSend(req)
	case "invite_accept":
		return n.opInviteAccept(ctx, req)
	case "invite_reject":
		return n.opInviteReject(req)
	}
	return fail(http.StatusNotFound, CodeNotFound, "unknown op")
}

// nodeView 는 이 노드의 설정과 노드 포트 상태다 (FR-PNW-80 "이 노드").
type nodeView struct {
	Enabled     bool   `json:"enabled"`
	Port        int    `json:"port"`
	Bind        string `json:"bind"`
	Name        string `json:"name"`
	Tag         string `json:"tag"`
	Advertise   string `json:"advertise"`
	Fingerprint string `json:"fingerprint"`
	Listening   bool   `json:"listening"`
	Addr        string `json:"addr,omitempty"`
	Error       string `json:"error,omitempty"`
}

type inviteView struct {
	Expires time.Time `json:"expires"`
}

// edgeView 는 간선에 번호와 간선 연결 상태를 얹은 응답 모양이다 (PROFILE_NAME_SRS FR-PFN-23,
// EDGE_MESH_SRS §3.7).
type edgeView struct {
	edge.Edge
	Tag      string `json:"tag"`
	Linked   bool   `json:"linked"`
	Outdated bool   `json:"outdated"`
}

// view 는 get 의 본문이다. 초대 토큰과 받은 초대의 코드는 싣지 않는다 (FR-PNW-95, I-3).
type view struct {
	Node    nodeView     `json:"node"`
	Edges   []edgeView   `json:"edges"`
	Invite  *inviteView  `json:"invite"`
	Mesh    *meshView    `json:"mesh"`
	Invites []invitedRow `json:"invites"`
}

// profileView 는 profile 의 본문이다 (PROFILE_NAME_SRS §3.2).
type profileView struct {
	Name        string `json:"name"`
	Tag         string `json:"tag"`
	Handle      string `json:"handle"`
	Fingerprint string `json:"fingerprint"`
}

func (n *Node) profile() profileView {
	name, fp := n.store.Config().Name, n.id.Fingerprint
	return profileView{Name: name, Tag: edge.Tag(fp), Handle: edge.Handle(name, fp), Fingerprint: fp}
}

// Handle 은 이 노드의 `이름#번호` 다 (PROFILE_NAME_SRS FR-PFN-21).
func (n *Node) Handle() string { return n.profile().Handle }

func (n *Node) view() view {
	cfg := n.store.Config()
	st := n.portStatus()
	v := view{
		Node: nodeView{
			Enabled: cfg.Enabled, Port: cfg.Port, Bind: cfg.Bind, Name: cfg.Name, Tag: edge.Tag(n.id.Fingerprint),
			Advertise: cfg.Advertise, Fingerprint: n.id.Fingerprint,
			Listening: st.Listening, Addr: st.Addr, Error: st.Err,
		},
		Edges: make([]edgeView, 0, len(cfg.Edges)),
	}
	for _, e := range cfg.Edges {
		ev := edgeView{Edge: e, Tag: edge.Tag(e.Fingerprint)}
		if n.mesh != nil {
			ev.Linked, ev.Outdated = n.mesh.Linked(e.Fingerprint), n.mesh.Outdated(e.Fingerprint)
		}
		v.Edges = append(v.Edges, ev)
	}
	if exp, has := n.pairing.InviteExpires(); has {
		v.Invite = &inviteView{Expires: exp}
	}
	v.Mesh = n.meshView()
	v.Invites = n.invitedRows()
	return v
}

// opNode 는 노드 설정을 바꾸고 노드 포트에 바로 적용한다 (FR-PNW-8, I-8).
func (n *Node) opNode(req Request) Response {
	var in edge.Config
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	n.mu.Lock()
	if cur := tag(n.store.Config()); req.IfMatch != "" && req.IfMatch != cur {
		n.mu.Unlock()
		r := fail(http.StatusConflict, CodeStaleRev, "stale revision")
		r.ETag = cur
		return r
	}
	before := n.store.Config()
	if err := n.store.SetNode(in); err != nil {
		n.mu.Unlock()
		if errors.Is(err, edge.ErrSaveFailed) {
			return fail(http.StatusInternalServerError, CodeSaveFailed, err.Error())
		}
		return fail(http.StatusBadRequest, edge.CodeConfigInvalid, err.Error())
	}
	cfg := n.store.Config()
	n.mu.Unlock()
	// FR-EGM-23: 바뀐 직접 정보는 새 노드 포트를 적용하기 전에 보낸다.
	n.announceChange(before, cfg)
	if n.opts.OnConfig != nil {
		n.opts.OnConfig(cfg)
	}
	n.changed(Change{})
	r := ok(n.view())
	r.ETag = tag(cfg)
	return r
}

// opProfileName 은 이름만 바꾼다. 낡은 If-Match 는 409 다 (PROFILE_NAME_SRS FR-PFN-11·13).
func (n *Node) opProfileName(req Request) Response {
	var in struct {
		Name string `json:"name"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	n.mu.Lock()
	if cur := tag(n.store.Config()); req.IfMatch != "" && req.IfMatch != cur {
		n.mu.Unlock()
		r := fail(http.StatusConflict, CodeStaleRev, "stale revision")
		r.ETag = cur
		return r
	}
	before := n.store.Config()
	if err := n.store.SetName(in.Name); err != nil {
		n.mu.Unlock()
		if errors.Is(err, edge.ErrSaveFailed) {
			return fail(http.StatusInternalServerError, CodeSaveFailed, err.Error())
		}
		return fail(http.StatusBadRequest, edge.CodeConfigInvalid, err.Error())
	}
	cfg := n.store.Config()
	n.mu.Unlock()
	n.announceChange(before, cfg)
	n.changed(Change{})
	r := ok(n.profile())
	r.ETag = tag(cfg)
	return r
}

// opInvite 는 초대 코드를 만든다 (FR-PNW-20·21, I-6).
func (n *Node) opInvite(req Request) Response {
	var in struct {
		Addr string `json:"addr"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	if !n.portStatus().Listening {
		return fail(http.StatusConflict, edge.CodePortClosed, "node port is not listening")
	}
	cfg := n.store.Config()
	addr := in.Addr
	if addr == "" {
		addr = cfg.Advertise
	}
	if addr == "" {
		return fail(http.StatusBadRequest, edge.CodeAddrRequired, "addr required")
	}
	if !edge.ValidAddr(addr) {
		return fail(http.StatusBadRequest, edge.CodeConfigInvalid, "addr")
	}
	token, expires := n.pairing.NewInvite()
	code := edge.EncodeInvite(edge.InviteCode{Addr: addr, Port: cfg.Port, Fingerprint: n.id.Fingerprint, Token: token})
	n.changed(Change{})
	return ok(map[string]any{"code": code, "expires": expires})
}

// callFail 은 상대 호출의 실패를 이쪽 답으로 옮긴다 (FR-PNW-71·74).
func callFail(err error) Response {
	var re *edge.RemoteError
	switch {
	case errors.Is(err, edge.ErrFingerprintMismatch):
		return fail(http.StatusBadGateway, edge.CodeFPMismatch, err.Error())
	case errors.Is(err, edge.ErrRejected):
		return fail(http.StatusBadGateway, edge.CodeRejected, err.Error())
	case errors.As(err, &re) && re.Code != "":
		return fail(remoteStatus(re.Status), remoteCode(re.Code), cleanRemoteText(re.Message))
	}
	return fail(http.StatusBadGateway, edge.CodeUnreachable, err.Error())
}

// unpairTimeout 은 지울 때 상대에게 알리는 시한이다 (FR-EPR-20).
const unpairTimeout = 3 * time.Second

// opAdd 는 초대 코드로 상대와 간선을 맺는다 (FR-EPR-2·4·5). 이 노드의 노드 포트가 열려
// 있을 때만 주소를 알린다. 200 이면 맺기는 끝이다.
func (n *Node) opAdd(ctx context.Context, req Request) Response {
	var in struct {
		Code string `json:"code"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	return n.addCode(ctx, in.Code)
}

// addCode 는 초대 코드 하나로 맺는다. 사람이 붙여 넣은 코드와 받은 간선 초대가 함께 쓴다.
func (n *Node) addCode(ctx context.Context, code string) Response {
	ic, err := edge.DecodeInvite(code)
	if err != nil {
		return fail(http.StatusBadRequest, edge.CodeInviteInvalid, err.Error())
	}
	cfg := n.store.Config()
	body := map[string]any{"token": ic.Token, "name": cfg.Name, "proto": proto}
	if cfg.Enabled && n.portStatus().Listening {
		body["addr"], body["port"] = cfg.Advertise, cfg.Port
	}
	var resp struct {
		Name string `json:"name"`
	}
	tgt := edge.Target{Addr: ic.Addr, Port: ic.Port, Fingerprint: ic.Fingerprint}
	if err := n.client.Call(ctx, tgt, pairPath, body, &resp); err != nil {
		audit("out", "-", "pair", http.StatusBadGateway)
		return callFail(err)
	}
	name := edge.DisplayName(resp.Name)
	if err := n.store.AddEdge(edge.Edge{Name: name, Addr: ic.Addr, Port: ic.Port, Fingerprint: ic.Fingerprint}); err != nil {
		return storeFail(err)
	}
	audit("out", name, "pair", http.StatusOK)
	n.changed(Change{Paired: &Ref{FP: ic.Fingerprint, Name: name}})
	return ok(map[string]any{"fp": ic.Fingerprint, "name": name, "tag": edge.Tag(ic.Fingerprint)})
}

// storeFail 은 간선 목록 조작의 실패를 옮긴다.
func storeFail(err error) Response {
	switch {
	case errors.Is(err, edge.ErrEdgeNotFound):
		return fail(http.StatusNotFound, edge.CodeNotFound, err.Error())
	case errors.Is(err, edge.ErrAmbiguous):
		return fail(http.StatusBadRequest, edge.CodeAmbiguous, err.Error())
	case errors.Is(err, edge.ErrSaveFailed):
		return fail(http.StatusInternalServerError, CodeSaveFailed, err.Error())
	}
	return fail(http.StatusBadRequest, edge.CodeConfigInvalid, err.Error())
}

// opRemove 는 간선을 끊는다 (FR-EPR-20·23·30). 상대에게 먼저 알리고, 알렸든 못 알렸든 이쪽
// 간선을 지운다. 주소를 모르는 간선은 알리지 못한다. 열린 연결은 다음 요청에서 끊긴다.
func (n *Node) opRemove(ctx context.Context, req Request) Response {
	var in struct {
		FP string `json:"fp"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	e, err := n.store.Resolve(in.FP)
	if err != nil {
		return storeFail(err)
	}
	notified := false
	if e.Addr != "" {
		cctx, cancel := context.WithTimeout(ctx, unpairTimeout)
		err := n.client.Call(cctx, edge.Target{Addr: e.Addr, Port: e.Port, Fingerprint: e.Fingerprint}, unpairPath, map[string]any{}, nil)
		cancel()
		notified = err == nil
	}
	status := http.StatusOK
	if !notified {
		status = http.StatusBadGateway
	}
	audit("out", e.Name, "unpair", status)
	if err := n.store.Remove(e.Fingerprint); err != nil {
		return storeFail(err)
	}
	n.pairing.Revoke(e.Fingerprint)
	n.dropLink(e.Fingerprint)
	n.changed(Change{Removed: &Ref{FP: e.Fingerprint, Name: e.Name}})
	return ok(map[string]any{"fp": e.Fingerprint, "name": e.Name, "notified": notified})
}

// opAddress 는 간선의 주소를 고친다 (FR-EPR-30·52).
func (n *Node) opAddress(req Request) Response {
	var in struct {
		FP   string `json:"fp"`
		Addr string `json:"addr"`
		Port int    `json:"port"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	e, err := n.store.Resolve(in.FP)
	if err != nil {
		return storeFail(err)
	}
	if err := n.store.SetAddress(e.Fingerprint, in.Addr, in.Port); err != nil {
		return storeFail(err)
	}
	n.changed(Change{})
	return ok(map[string]any{"fp": e.Fingerprint, "name": e.Name, "addr": in.Addr, "port": in.Port})
}

// remoteTextMax 는 상대가 보낸 문구를 옮길 때의 상한(바이트)이다.
const remoteTextMax = 512

// remoteStatus 는 상대의 상태를 옮긴다. 요청의 잘못(4xx)만 그대로 두고 나머지는 502 다 —
// 상대의 5xx·3xx 는 이쪽 노드의 사정이 아니다.
func remoteStatus(st int) int {
	if st >= 400 && st < 500 {
		return st
	}
	return http.StatusBadGateway
}

// remoteCode 는 노드가 아는 코드만 옮긴다. 모르는 코드는 edge_rejected 다.
func remoteCode(code string) string {
	if slices.Contains(Codes(), code) {
		return code
	}
	return edge.CodeRejected
}

// cleanRemoteText 는 제어 문자를 지우고 길이를 자른다. 이 문구는 터미널에 찍힌다.
func cleanRemoteText(s string) string {
	return termtext.Cut(termtext.Strip(s), remoteTextMax)
}
