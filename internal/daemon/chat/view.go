package chat

import "sort"

// reachableLocked 는 자기에게서 닿는 노드다. 간선 A-B 는 A·B 의 최신 상태가 서로를 담을
// 때만 이어진 것으로 본다 (FR-PCH-10a). 자기의 간선은 지금 열린 연결이다.
func (s *Service) reachableLocked() map[string]bool {
	self := s.id.Fingerprint
	linksOf := func(fp string) []string {
		if fp == self {
			out := make([]string, 0, len(s.links))
			for l := range s.links {
				out = append(out, l)
			}
			return out
		}
		if r, ok := s.nodes[fp]; ok {
			return r.st.Links
		}
		return nil
	}
	lists := func(a, b string) bool {
		for _, x := range linksOf(a) {
			if x == b {
				return true
			}
		}
		return false
	}
	seen := map[string]bool{self: true}
	queue := []string{self}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, next := range linksOf(cur) {
			if !seen[next] && lists(next, cur) {
				seen[next] = true
				queue = append(queue, next)
			}
		}
	}
	return seen
}

// Online 은 온라인 목록이다. 닿지 않는 노드와 그 참가자는 Online 이 거짓이다 (FR-PCH-3·30).
func (s *Service) Online() OnlineView {
	s.mu.Lock()
	defer s.mu.Unlock()
	reach := s.reachableLocked()
	v := OnlineView{Nodes: []NodeInfo{{FP: s.id.Fingerprint, Name: s.name(), Online: true, Self: true}}}
	for _, p := range s.parts {
		v.Participants = append(v.Participants, Member{ID: p.ID, Label: p.Label, Kind: p.Kind, Node: s.id.Fingerprint, Online: true})
	}
	for fp, r := range s.nodes {
		v.Nodes = append(v.Nodes, NodeInfo{FP: fp, Name: r.st.Name, Online: reach[fp]})
		for _, sp := range r.st.Parts {
			v.Participants = append(v.Participants, Member{ID: sp.ID, Label: sp.Label, Kind: sp.Kind, Node: fp, Online: reach[fp]})
		}
	}
	sort.Slice(v.Nodes[1:], func(i, j int) bool {
		a, b := v.Nodes[1+i], v.Nodes[1+j]
		return a.Name < b.Name || a.Name == b.Name && a.FP < b.FP
	})
	sortMembers(v.Participants)
	return v
}

// Rooms 는 pid 에게 보이는 방이다. 방은 이 노드의 참가자나 닿는 노드의 참가자가 들어 있다고
// 말할 때만 있다(FR-PCH-21). 개인채팅은 두 참가자에게만 보인다(FR-PCH-15).
func (s *Service) Rooms(pid string) []RoomInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.parts[pid]; !ok {
		return nil
	}
	var out []RoomInfo
	for id := range s.claimedLocked() {
		if _, ok := s.visibleRoomLocked(pid, id); ok {
			out = append(out, s.roomInfoLocked(pid, id))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name || out[i].Name == out[j].Name && out[i].ID < out[j].ID
	})
	return out
}

// claimedLocked 는 지금 있는 방과 그 생성 기록이다.
func (s *Service) claimedLocked() map[string]room {
	out := map[string]room{}
	for id, r := range s.rooms {
		out[id] = r
	}
	reach := s.reachableLocked()
	for fp, r := range s.nodes {
		if !reach[fp] {
			continue
		}
		for _, sp := range r.st.Parts {
			for _, id := range sp.Rooms {
				if _, ok := out[id]; ok {
					continue
				}
				if rm, ok := s.recordLocked(id); ok {
					out[id] = rm
				}
			}
		}
	}
	return out
}

// recordLocked 는 방의 생성 기록을 이 노드나 아는 노드의 상태에서 찾는다.
func (s *Service) recordLocked(id string) (room, bool) {
	if r, ok := s.rooms[id]; ok {
		return r, true
	}
	for _, n := range s.nodes {
		if r, ok := n.rooms[id]; ok {
			return r, true
		}
	}
	return room{}, false
}

func (s *Service) visibleRoomLocked(pid, id string) (room, bool) {
	r, ok := s.claimedLocked()[id]
	if !ok {
		return room{}, false
	}
	if r.body.Kind == KindDirect && pid != r.body.Owner && pid != r.body.Peer {
		return room{}, false
	}
	if r.body.Kind == KindDirect && s.parts[pid] != nil && s.parts[pid].left[id] {
		return room{}, false
	}
	return r, true
}

func (s *Service) roomInfoLocked(pid, id string) RoomInfo {
	r, _ := s.recordLocked(id)
	info := RoomInfo{ID: id, Kind: r.body.Kind, Name: r.body.Name, Purpose: r.body.Purpose, Creator: r.body.Creator}
	if r.body.Creator == s.id.Fingerprint {
		info.CreatorName = s.name()
	} else if n, ok := s.nodes[r.body.Creator]; ok {
		info.CreatorName = n.st.Name
	}
	if p, ok := s.parts[pid]; ok {
		info.Joined = p.rooms[id]
	}
	for _, p := range s.parts {
		if p.rooms[id] {
			info.Members = append(info.Members, Member{ID: p.ID, Label: p.Label, Kind: p.Kind, Node: s.id.Fingerprint, Online: true})
		}
	}
	reach := s.reachableLocked()
	for fp, n := range s.nodes {
		for _, sp := range n.st.Parts {
			if partInRoom(n.st, sp.ID, id) {
				info.Members = append(info.Members, Member{ID: sp.ID, Label: sp.Label, Kind: sp.Kind, Node: fp, Online: reach[fp]})
			}
		}
	}
	sortMembers(info.Members)
	return info
}

func sortMembers(ms []Member) {
	sort.Slice(ms, func(i, j int) bool {
		return ms[i].Label < ms[j].Label || ms[i].Label == ms[j].Label && ms[i].ID < ms[j].ID
	})
}

// recordOf 와 아래 둘은 시험이 안을 보는 자리다.
func (s *Service) recordOf(id string) signedRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, _ := s.recordLocked(id)
	return r.rec
}

func (s *Service) recordCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.rooms)
}

func (s *Service) linkCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.links)
}
