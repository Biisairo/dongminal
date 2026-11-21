package edgemesh

import (
	"crypto/ecdsa"
	"encoding/json"
	"slices"
	"sort"
	"time"

	"dongminal/internal/shared/termtext"
)

const (
	// maxNodes 는 아는 노드의 상한이다. 넘으면 닿지 않는 노드부터 잊는다 (FR-EGM-13).
	maxNodes = 256
	// maxMarks 는 잊은 노드의 마지막 번호를 기억하는 수다.
	maxMarks = 4096
	// maxName 은 이름의 바이트 상한이다 (FR-EGM-11).
	maxName = 64 * 4
)

// netBody 는 망 정보다 (FR-EGM-10). 노드는 자기에 대해서만 말한다.
type netBody struct {
	Node  string   `json:"node"`
	Key   string   `json:"key"`
	Name  string   `json:"name"`
	Epoch int64    `json:"epoch"`
	Seq   uint64   `json:"seq"`
	Links []string `json:"links,omitempty"`
}

type remote struct {
	st  netBody
	key *ecdsa.PublicKey
	raw Frame
	// at 은 이 노드의 망 정보를 마지막으로 받은 때다.
	at time.Time
}

type mark struct {
	epoch int64
	seq   uint64
	at    time.Time
}

// netState 는 망 정보다. Mesh.mu 가 지킨다.
type netState struct {
	epoch      int64
	seq        uint64
	own        Frame
	ownContent string
	nodes      map[string]*remote
	marks      map[string]mark
	// reach 는 온라인 판정의 캐시다. 바뀔 때 새 맵으로 갈아 끼운다 — 내준 맵은 바꾸지 않는다.
	reach map[string]bool
}

func newNetState(now func() time.Time) netState {
	return netState{epoch: now().UnixNano(), nodes: map[string]*remote{}, marks: map[string]mark{}}
}

// NodeInfo 는 망의 노드 하나다.
type NodeInfo struct {
	FP     string
	Name   string
	Online bool
	Self   bool
}

// View 는 망 그림이다. Links 는 서로 이어진 두 노드의 쌍이다 (FR-EGM-61).
type View struct {
	Nodes []NodeInfo
	Links [][2]string
}

// announceLocked 는 자기 망 정보의 내용이 바뀌었을 때만 새 net 을 만들어 skip 을 뺀 모든
// 연결로 보낸다 (FR-EGM-10).
func (m *Mesh) announceLocked(skip *link) {
	st := netBody{Node: m.id.Fingerprint, Key: m.key, Name: m.name(), Links: m.openLinksLocked()}
	content, _ := json.Marshal(st)
	if m.own.T != "" && string(content) == m.ownContent {
		return
	}
	m.ownContent = string(content)
	m.seq++
	st.Epoch, st.Seq = m.epoch, m.seq
	fr, err := SignFrame(m.id, FrameNet, st)
	if err != nil {
		return
	}
	m.own = fr
	m.broadcastLocked(Encode(fr), skip)
	m.topologyLocked()
}

// Announce 는 이름이 바뀌었을 때 부른다. 바뀌었으면 새 net 을 퍼뜨린다.
func (m *Mesh) Announce() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.announceLocked(nil)
}

// topologyLocked 는 온라인 캐시를 버리고 바뀜을 알린다.
func (m *Mesh) topologyLocked() {
	m.reach = nil
	m.pokeLocked()
}

// acceptNetLocked 는 바르고 더 새로운 망 정보만 받는다 (FR-EGM-11·13).
func (m *Mesh) acceptNetLocked(fr Frame) bool {
	var st netBody
	if json.Unmarshal(fr.B, &st) != nil || st.Node == m.id.Fingerprint {
		return false
	}
	pub, ok := ParseKey(st.Node, st.Key)
	if !ok || !Verify(pub, FrameNet, fr.B, fr.S) || !validNet(st) {
		return false
	}
	if old, ok := m.nodes[st.Node]; ok {
		if !newer(st, old.st.Epoch, old.st.Seq) {
			return false
		}
	} else {
		mk, marked := m.marks[st.Node]
		if marked && !newer(st, mk.epoch, mk.seq) {
			return false
		}
		if len(m.nodes) >= m.maxNodes && !m.evictLocked() {
			return false
		}
		delete(m.marks, st.Node)
	}
	m.nodes[st.Node] = &remote{st: st, key: pub, raw: fr, at: m.now()}
	return true
}

func newer(st netBody, epoch int64, seq uint64) bool {
	return st.Epoch > epoch || st.Epoch == epoch && st.Seq > seq
}

func validNet(st netBody) bool {
	return len(st.Links) <= maxNodes && termtext.Line(st.Name, maxName)
}

// evictLocked 는 닿지 않는 노드 가운데 가장 오래 소식이 없는 것을 잊고 그 마지막 번호를 남긴다.
// 잊을 것이 없으면 거짓이다.
func (m *Mesh) evictLocked() bool {
	reach := m.reachableLocked()
	victim := ""
	var at time.Time
	for fp, r := range m.nodes {
		if reach[fp] {
			continue
		}
		if victim == "" || r.at.Before(at) {
			victim, at = fp, r.at
		}
	}
	if victim == "" {
		return false
	}
	r := m.nodes[victim]
	if len(m.marks) >= maxMarks {
		oldest := ""
		for k, v := range m.marks {
			if oldest == "" || v.at.Before(m.marks[oldest].at) {
				oldest = k
			}
		}
		delete(m.marks, oldest)
	}
	m.marks[victim] = mark{epoch: r.st.Epoch, seq: r.st.Seq, at: m.now()}
	delete(m.nodes, victim)
	m.reach = nil
	return true
}

// openLinksLocked 는 위층이 연 연결의 상대다. 열기 전의 연결은 망 정보와 온라인 판정에 넣지
// 않는다 — 온라인으로 보이면 위층의 글이 그 연결로 간다 (FR-EGM-6).
func (m *Mesh) openLinksLocked() []string {
	out := make([]string, 0, len(m.links))
	for _, fp := range sortedKeys(m.links) {
		if m.links[fp].open {
			out = append(out, fp)
		}
	}
	return out
}

func (m *Mesh) linksOfLocked(fp string) []string {
	if fp == m.id.Fingerprint {
		return m.openLinksLocked()
	}
	if r, ok := m.nodes[fp]; ok {
		return r.st.Links
	}
	return nil
}

// mutualLocked 는 a·b 가 서로를 자기 links 에 담는가다 (FR-EGM-12).
func (m *Mesh) mutualLocked(a, b string) bool {
	return slices.Contains(m.linksOfLocked(a), b) && slices.Contains(m.linksOfLocked(b), a)
}

// reachableLocked 는 자기에게서 서로 이어진 간선으로 닿는 노드다 (FR-EGM-12).
func (m *Mesh) reachableLocked() map[string]bool {
	if m.reach != nil {
		return m.reach
	}
	self := m.id.Fingerprint
	seen := map[string]bool{self: true}
	queue := []string{self}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, next := range m.linksOfLocked(cur) {
			if !seen[next] && slices.Contains(m.linksOfLocked(next), cur) {
				seen[next] = true
				queue = append(queue, next)
			}
		}
	}
	m.reach = seen
	return seen
}

// Reachable 은 온라인 노드(자기 포함)다. 돌려준 맵은 바꾸지 않는다.
func (m *Mesh) Reachable() map[string]bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reachableLocked()
}

// Mutual 은 a·b 가 서로 이어졌는가다 (FR-EGM-12, FR-EGM-43).
func (m *Mesh) Mutual(a, b string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mutualLocked(a, b)
}

// NameOf 는 노드 fp 의 이름이다. 모르면 거짓이다.
func (m *Mesh) NameOf(fp string) (string, bool) {
	if fp == m.id.Fingerprint {
		return m.name(), true
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.nodes[fp]
	if !ok {
		return "", false
	}
	return r.st.Name, true
}

// Nodes 는 아는 노드다. 자기가 맨 앞이고 나머지는 이름·지문 순이다.
func (m *Mesh) Nodes() []NodeInfo {
	name := m.name()
	m.mu.Lock()
	defer m.mu.Unlock()
	reach := m.reachableLocked()
	out := []NodeInfo{{FP: m.id.Fingerprint, Name: name, Online: true, Self: true}}
	for fp, r := range m.nodes {
		out = append(out, NodeInfo{FP: fp, Name: r.st.Name, Online: reach[fp]})
	}
	sort.Slice(out[1:], func(i, j int) bool {
		a, b := out[1+i], out[1+j]
		return a.Name < b.Name || a.Name == b.Name && a.FP < b.FP
	})
	return out
}

// View 는 망 그림이다. 연결 끊김 노드의 마지막 망 정보도 쓴다 (FR-EGM-61).
func (m *Mesh) View() View {
	v := View{Nodes: m.Nodes()}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, a := range v.Nodes {
		for _, b := range v.Nodes[i+1:] {
			if m.mutualLocked(a.FP, b.FP) {
				p := [2]string{a.FP, b.FP}
				if p[1] < p[0] {
					p[0], p[1] = p[1], p[0]
				}
				v.Links = append(v.Links, p)
			}
		}
	}
	sort.Slice(v.Links, func(i, j int) bool {
		return v.Links[i][0] < v.Links[j][0] || v.Links[i][0] == v.Links[j][0] && v.Links[i][1] < v.Links[j][1]
	})
	return v
}
