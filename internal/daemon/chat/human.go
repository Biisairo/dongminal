package chat

import (
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/humancmd"
)

// PEER_CHAT_SRS §3.12 — 사람 명령(강제 삭제·강퇴). 도우미가 서명한 묶음을 `cmd` 프레임으로 퍼뜨리고,
// 받은 노드는 그 노드의 도우미 키를 믿을 때만 자기 참가자에게 적용한다.

const (
	// cmdWindow 는 명령 시각과 받는 노드 시각의 허용 차이다.
	cmdWindow = 5 * time.Minute
	// cmdSeenFor 는 본 명령 id 를 기억하는 시간, maxSeenCmds 는 그 수의 상한이다.
	cmdSeenFor  = 10 * time.Minute
	maxSeenCmds = 4096
	// maxHelperKey 는 도우미 공개키(Ed25519 base64) 문자열의 상한이다.
	maxHelperKey = 64
)

// Node 는 이 노드의 지문이다.
func (s *Service) Node() string { return s.id.Fingerprint }

// SetHelper 는 이 노드의 도우미 공개키를 싣는다. 빈 값은 도우미가 없다는 뜻이다. 바뀌면 상태를
// 다시 알린다.
func (s *Service) SetHelper(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.helperKey == key {
		return
	}
	s.helperKey = key
	s.changedLocked()
}

// HelperKey 는 이 노드의 도우미 공개키다. 없으면 빈 값이다.
func (s *Service) HelperKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.helperKey
}

// Command 는 이 노드의 도우미가 서명한 명령을 자기에게 적용하고 모든 연결로 낸다.
func (s *Service) Command(sg humancmd.Signed) error {
	b, err := humancmd.Open(sg)
	if err != nil {
		return fail(CodeBadRequest, "human command signature")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.helperKey == "" || b.Key != s.helperKey || b.Node != s.id.Fingerprint {
		return fail(CodeBadRequest, "not signed by this node's helper")
	}
	if !s.freshLocked(b) {
		return fail(CodeBadRequest, "stale human command")
	}
	s.markCmdLocked(b.ID)
	s.applyCmdLocked(b)
	s.broadcastLocked(frame{T: frameCmd, B: sg.B, S: sg.S}, nil)
	s.changedLocked()
	return nil
}

// acceptCmdLocked 는 믿는 도우미 키로 서명된 처음 보는 명령을 적용한다. 받았으면 참이다.
func (s *Service) acceptCmdLocked(fr frame) bool {
	b, err := humancmd.Open(humancmd.Signed{B: fr.B, S: fr.S})
	if err != nil || b.Node == s.id.Fingerprint {
		return false
	}
	key, ok := s.trustedKeyLocked(b.Node)
	if !ok || key != b.Key || !s.freshLocked(b) {
		return false
	}
	s.markCmdLocked(b.ID)
	s.applyCmdLocked(b)
	return true
}

func (s *Service) freshLocked(b humancmd.Body) bool {
	now, at := s.now(), time.UnixMilli(b.At)
	if at.Before(now.Add(-cmdWindow)) || at.After(now.Add(cmdWindow)) {
		return false
	}
	_, seen := s.cmds[b.ID]
	return !seen
}

func (s *Service) markCmdLocked(id string) {
	now := s.now()
	oldest := ""
	for k, at := range s.cmds {
		if now.Sub(at) > cmdSeenFor {
			delete(s.cmds, k)
			continue
		}
		if oldest == "" || at.Before(s.cmds[oldest]) {
			oldest = k
		}
	}
	if len(s.cmds) >= maxSeenCmds {
		delete(s.cmds, oldest)
	}
	s.cmds[id] = now
}

// applyCmdLocked 는 명령을 이 노드의 참가자에게만 적용한다 (FR-PCH-20·70). 기록을 남기지 않는다.
func (s *Service) applyCmdLocked(b humancmd.Body) {
	switch b.Op {
	case humancmd.OpKill:
		for _, id := range b.Rooms {
			for _, p := range s.parts {
				if p.rooms[id] {
					s.leaveLocked(p, id)
				}
			}
		}
	case humancmd.OpKick:
		for _, k := range b.Kicks {
			if p, ok := s.parts[k.Participant]; ok && p.rooms[k.Room] {
				s.leaveLocked(p, k.Room)
			}
		}
	}
}

// trustedKeyLocked 는 노드 node 의 믿는 도우미 키다 (FR-PCH-74, D-PCH-39). 자기는 자기 도우미 키,
// 간선 상대는 고정한 키, 망 이웃은 닿는 노드들이 알린 고정값이 모두 같을 때 그 키다.
func (s *Service) trustedKeyLocked(node string) (string, bool) {
	if node == s.id.Fingerprint {
		return s.helperKey, s.helperKey != ""
	}
	if e, ok := s.edgeLocked(node); ok {
		return e.HelperKey, e.HelperKey != ""
	}
	reach := s.reachableLocked()
	var pins []string
	for fp, r := range s.nodes {
		if fp == node || !reach[fp] {
			continue
		}
		if k, ok := r.st.Pins[node]; ok {
			pins = append(pins, k)
		}
	}
	return agreed(pins)
}

// agreed 는 고정값이 하나 이상이고 모두 같을 때 그 값이다.
func agreed(pins []string) (string, bool) {
	if len(pins) == 0 {
		return "", false
	}
	for _, k := range pins[1:] {
		if k != pins[0] {
			return "", false
		}
	}
	return pins[0], true
}

func (s *Service) edgeLocked(fp string) (edge.Edge, bool) {
	if s.opts.Edges == nil {
		return edge.Edge{}, false
	}
	for _, e := range s.opts.Edges() {
		if e.Fingerprint == fp && e.State == edge.StatePaired {
			return e, true
		}
	}
	return edge.Edge{}, false
}

// pinsLocked 는 상태 알림에 싣는 간선 상대의 고정값이다.
func (s *Service) pinsLocked() map[string]string {
	if s.opts.Edges == nil {
		return nil
	}
	var out map[string]string
	for _, e := range s.opts.Edges() {
		if e.State != edge.StatePaired || e.HelperKey == "" {
			continue
		}
		if out == nil {
			out = map[string]string{}
		}
		out[e.Fingerprint] = e.HelperKey
	}
	return out
}

// pinLocked 는 간선 상대 자신이 그 연결로 보낸 상태에 도우미 키가 있고 아직 고정하지 않았으면,
// 잠금 밖에서 부를 고정 함수를 돌려준다. 고정한 값과 다르면 바꾸지 않고 한 번 경고한다.
func (s *Service) pinLocked(from *peerLink, fp string) func() {
	if from == nil || from.fp != fp || s.opts.Pin == nil {
		return nil
	}
	r, ok := s.nodes[fp]
	if !ok || r.st.Helper == "" {
		return nil
	}
	e, ok := s.edgeLocked(fp)
	key := r.st.Helper
	switch {
	case !ok || e.HelperKey == key:
		return nil
	case e.HelperKey != "":
		if s.warned[fp] != key {
			s.warned[fp] = key
			dmlog.Warnf(nil, "chat: 간선 상대 %s 의 도우미 키가 고정한 값과 다르다 — 그 노드의 사람 명령을 받지 않는다. 다시 고정하려면 간선을 다시 맺는다", short(fp))
		}
		return nil
	}
	return func() {
		s.opts.Pin(fp, key)
		s.mu.Lock()
		s.announceLocked()
		s.mu.Unlock()
	}
}
