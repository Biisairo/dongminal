package edgenode

import (
	"context"
	"errors"
	"net"
	"net/http"
	"slices"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgemesh"
)

// 간선 계층 배선과 그 연산 (EDGE_MESH_SRS).

const (
	// maxInvites 는 받은 간선 초대의 상한이다 (FR-EGM-34).
	maxInvites = 16
	// maxRejected 는 거절한 초대 id 를 기억하는 상한이다. 만료되면 잊는다.
	maxRejected = 256
)

func (n *Node) newMesh() *edgemesh.Mesh {
	return edgemesh.New(edgemesh.Options{
		Identity: n.id,
		Name:     func() string { return n.store.Config().Name },
		Hello:    n.connectHello,
		Edges:    func() []edge.Edge { return n.store.Config().Edges },
		Dial: func(ctx context.Context, t edge.Target) (net.Conn, error) {
			return n.client.Upgrade(ctx, t, edgemesh.Path, edgemesh.Proto)
		},
		OnHello:     n.onHello,
		OnHelloSent: n.onHelloSent,
		OnInvite:    n.onInvite,
		OnNotEdge:   n.Forget,
		OnChanged:   func() { n.changed(Change{}) },
		Now:         n.opts.Now,
	})
}

// Mesh 는 간선 계층이다. 간선 계층을 세우지 않은 노드는 nil 이다.
func (n *Node) Mesh() *edgemesh.Mesh { return n.mesh }

// Run 은 간선 연결을 유지한다. 간선 계층이 없으면 곧 돌아온다.
func (n *Node) Run(ctx context.Context) {
	if n.mesh != nil {
		n.mesh.Run(ctx)
	}
}

// Close 는 간선 연결을 모두 닫는다.
func (n *Node) Close() {
	if n.mesh != nil {
		n.mesh.Close()
	}
}

func (n *Node) dropLink(fp string) {
	if n.mesh != nil {
		n.mesh.Drop(fp)
	}
}

// connectHello 는 연결이 열릴 때 보내는 직접 정보다. 노드 포트가 켜져 있고 듣는 중일 때만
// 주소·포트를 싣는다 (FR-EGM-20).
func (n *Node) connectHello() edgemesh.Hello {
	cfg := n.store.Config()
	h := edgemesh.Hello{Name: cfg.Name}
	if cfg.Enabled && n.portStatus().Listening {
		h.Addr, h.Port = cfg.Advertise, cfg.Port
	}
	return h
}

func (n *Node) onHello(fp string, h edgemesh.Hello, remoteHost string) {
	changed, err := n.store.ApplyHello(fp, h.Name, h.Addr, h.Port, remoteHost)
	if err != nil && !errors.Is(err, edge.ErrEdgeNotFound) {
		dmlog.Infof(nil, "edge hello: %v", err)
	}
	if changed {
		n.changed(Change{})
	}
}

func (n *Node) onHelloSent(fp string) {
	if changed, _ := n.store.SetPending(fp, false); changed {
		n.changed(Change{})
	}
}

// announceChange 는 직접 정보가 바뀌었으면 모든 간선을 알림 대기로 두고, 열린 연결마다 새
// hello 를 한 번 보낸다 (FR-EGM-22·23). 노드 포트를 끄기만 한 것은 알리지 않는다.
func (n *Node) announceChange(before, after edge.Config) {
	if n.mesh == nil {
		return
	}
	renamed := before.Name != after.Name
	moved := after.Enabled && (!before.Enabled || before.Port != after.Port || before.Advertise != after.Advertise)
	if !renamed && !moved {
		return
	}
	if err := n.store.SetPendingAll(); err != nil {
		dmlog.Infof(nil, "edge pending: %v", err)
	}
	if renamed {
		n.mesh.Announce()
	}
	h := edgemesh.Hello{Name: after.Name}
	if after.Enabled {
		h.Addr, h.Port = after.Advertise, after.Port
	}
	n.mesh.HelloAll(h, edgemesh.HelloWait)
	n.changed(Change{})
}

func meshUnavailable() Response {
	return fail(http.StatusServiceUnavailable, edge.CodeUnavailable, "edge link unavailable")
}

// opNotify 는 간선 하나에 지금 직접 정보를 알린다 (FR-EGM-26).
func (n *Node) opNotify(ctx context.Context, req Request) Response {
	var in struct {
		FP string `json:"fp"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	if n.mesh == nil {
		return meshUnavailable()
	}
	e, err := n.store.Resolve(in.FP)
	if err != nil {
		return storeFail(err)
	}
	switch err := n.mesh.Notify(ctx, e.Fingerprint); {
	case err == nil:
	case errors.Is(err, edgemesh.ErrAddrUnknown):
		return fail(http.StatusConflict, edge.CodeAddrUnknown, err.Error())
	case errors.Is(err, edgemesh.ErrOutdated):
		return fail(http.StatusBadGateway, edge.CodePeerOutdated, err.Error())
	default:
		audit("out", e.Name, "notify", http.StatusBadGateway)
		return callFail(err)
	}
	audit("out", e.Name, "notify", http.StatusOK)
	return ok(map[string]any{"fp": e.Fingerprint, "name": e.Name, "tag": edge.Tag(e.Fingerprint), "notified": true})
}

// meshNode·meshView 는 get 의 망 그림이다 (§3.7).
type meshNode struct {
	FP     string `json:"fp"`
	Name   string `json:"name"`
	Tag    string `json:"tag"`
	Online bool   `json:"online"`
	Self   bool   `json:"self"`
	Edge   bool   `json:"edge"`
}

type meshView struct {
	Nodes []meshNode  `json:"nodes"`
	Links [][2]string `json:"links"`
}

func (n *Node) meshView() *meshView {
	if n.mesh == nil {
		return nil
	}
	mv := n.mesh.View()
	v := &meshView{Nodes: make([]meshNode, 0, len(mv.Nodes)), Links: mv.Links}
	if v.Links == nil {
		v.Links = [][2]string{}
	}
	for _, x := range mv.Nodes {
		v.Nodes = append(v.Nodes, meshNode{FP: x.FP, Name: x.Name, Tag: edge.Tag(x.FP), Online: x.Online, Self: x.Self,
			Edge: !x.Self && n.store.IsEdge(x.FP)})
	}
	return v
}

// invitedRow 는 받은 간선 초대 한 줄이다. 코드는 싣지 않는다 (FR-EGM-34).
type invitedRow struct {
	ID      string    `json:"id"`
	From    string    `json:"from"`
	Name    string    `json:"name"`
	Tag     string    `json:"tag"`
	Expires time.Time `json:"expires"`
}

func (n *Node) liveInvitesLocked() {
	now := n.opts.Now()
	n.invites = slices.DeleteFunc(n.invites, func(inv edgemesh.Invite) bool { return !now.Before(inv.Expires) })
	for id, exp := range n.rejected {
		if !now.Before(exp) {
			delete(n.rejected, id)
		}
	}
}

func (n *Node) invitedRows() []invitedRow {
	n.invMu.Lock()
	defer n.invMu.Unlock()
	n.liveInvitesLocked()
	out := make([]invitedRow, 0, len(n.invites))
	for _, inv := range n.invites {
		out = append(out, invitedRow{ID: inv.ID, From: inv.From, Name: inv.Name, Tag: edge.Tag(inv.From), Expires: inv.Expires})
	}
	return out
}

// onInvite 는 이 노드에게 온 간선 초대를 받은 초대 목록에 둔다 (FR-EGM-34). 같은 노드의 앞 초대는
// 새 것이 대신하고, 이미 간선인 노드의 초대는 버린다.
func (n *Node) onInvite(inv edgemesh.Invite) {
	if n.store.IsEdge(inv.From) {
		return
	}
	n.invMu.Lock()
	n.liveInvitesLocked()
	if _, gone := n.rejected[inv.ID]; gone {
		n.invMu.Unlock()
		return
	}
	n.invites = slices.DeleteFunc(n.invites, func(x edgemesh.Invite) bool { return x.From == inv.From })
	if len(n.invites) >= maxInvites {
		n.invites = n.invites[1:]
	}
	n.invites = append(n.invites, inv)
	n.invMu.Unlock()
	n.changed(Change{Invited: &Ref{FP: inv.From, Name: inv.Name}})
}

// takeInvite 는 받은 초대 id 를 꺼낸다. remove 면 목록에서 지운다.
func (n *Node) takeInvite(id string, remove bool) (edgemesh.Invite, bool) {
	n.invMu.Lock()
	defer n.invMu.Unlock()
	n.liveInvitesLocked()
	for i, inv := range n.invites {
		if inv.ID == id {
			if remove {
				n.invites = slices.Delete(n.invites, i, i+1)
			}
			return inv, true
		}
	}
	return edgemesh.Invite{}, false
}

// opInviteSend 는 망 이웃 to 에게 그 지문에 묶인 간선 초대를 보낸다 (FR-EGM-30~33).
func (n *Node) opInviteSend(req Request) Response {
	var in struct {
		To string `json:"to"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	if n.mesh == nil {
		return meshUnavailable()
	}
	if in.To == n.id.Fingerprint {
		return fail(http.StatusBadRequest, CodeBadRequest, "cannot invite this node")
	}
	var target *edgemesh.NodeInfo
	for _, x := range n.mesh.Nodes() {
		if x.FP == in.To && x.Online {
			target = &x
		}
	}
	if target == nil {
		return fail(http.StatusNotFound, edge.CodeNotFound, "no such online node")
	}
	if n.store.IsEdge(in.To) {
		return fail(http.StatusConflict, edge.CodeAlreadyEdge, "already an edge")
	}
	if !n.portStatus().Listening {
		return fail(http.StatusConflict, edge.CodePortClosed, "node port is not listening")
	}
	cfg := n.store.Config()
	if cfg.Advertise == "" {
		return fail(http.StatusBadRequest, edge.CodeAddrRequired, "addr required")
	}
	token, expires := n.pairing.NewBoundInvite(in.To)
	code := edge.EncodeInvite(edge.InviteCode{Addr: cfg.Advertise, Port: cfg.Port, Fingerprint: n.id.Fingerprint, Token: token})
	if err := n.mesh.SendInvite(in.To, code, expires); err != nil {
		if errors.Is(err, edgemesh.ErrUnknownNode) {
			return fail(http.StatusNotFound, edge.CodeNotFound, err.Error())
		}
		if errors.Is(err, edgemesh.ErrInviteFull) {
			return fail(http.StatusTooManyRequests, edge.CodeRateLimited, err.Error())
		}
		return fail(http.StatusInternalServerError, CodeInternal, err.Error())
	}
	audit("out", target.Name, "invite", http.StatusOK)
	return ok(map[string]any{"to": in.To, "name": target.Name, "tag": edge.Tag(in.To), "expires": expires})
}

// opInviteAccept 는 받은 초대의 코드로 맺는다. 성공하면 그 초대를 지운다 (FR-EGM-35).
func (n *Node) opInviteAccept(ctx context.Context, req Request) Response {
	var in struct {
		ID string `json:"id"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	inv, found := n.takeInvite(in.ID, false)
	if !found {
		return fail(http.StatusNotFound, edge.CodeNotFound, "no such invite")
	}
	r := n.addCode(ctx, inv.Code)
	if r.Code == "" {
		n.takeInvite(in.ID, true)
		n.changed(Change{})
	}
	return r
}

// opInviteReject 는 받은 초대를 목록에서 지운다. 보낸 쪽에 알리지 않는다 (FR-EGM-35).
func (n *Node) opInviteReject(req Request) Response {
	var in struct {
		ID string `json:"id"`
	}
	if r := decode(req.Args, &in); r != nil {
		return *r
	}
	inv, found := n.takeInvite(in.ID, true)
	if !found {
		return fail(http.StatusNotFound, edge.CodeNotFound, "no such invite")
	}
	n.invMu.Lock()
	if n.rejected == nil {
		n.rejected = map[string]time.Time{}
	}
	if len(n.rejected) < maxRejected {
		n.rejected[inv.ID] = inv.Expires
	}
	n.invMu.Unlock()
	n.changed(Change{})
	return ok(map[string]any{})
}
