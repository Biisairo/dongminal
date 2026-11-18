package chat

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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
	// edgeCacheFor 는 간선 목록 캐시를 믿는 시간이다.
	edgeCacheFor = time.Second
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

// Command 는 이 노드의 도우미가 서명한 명령을 자기에게 적용하고 모든 연결로 낸다. 서명 본문의 키를
// 이 노드의 도우미 키로 싣는다 — 부르는 쪽(chatsock)이 root 가 만든 도우미 소켓에서 받은 서명이다.
// 키 싣기와 적용을 한 잠금 안에서 해 도우미 확인 루프와 엇갈리지 않는다 (§3.12a R-3).
func (s *Service) Command(sg humancmd.Signed) error {
	b, err := humancmd.Open(sg)
	if err != nil {
		return fail(CodeBadRequest, "human command signature")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if b.Node != s.id.Fingerprint {
		return fail(CodeBadRequest, "not this node's command")
	}
	h := cmdHash(sg.B, sg.S)
	if _, seen := s.cmds[h]; seen || !inWindow(s.now(), b.At) {
		return fail(CodeBadRequest, "stale human command")
	}
	s.helperKey = b.Key
	remember(s.cmds, h, s.now())
	s.applyCmdLocked(b)
	s.broadcastLocked(frame{T: frameCmd, B: sg.B, S: sg.S}, "")
	s.changedLocked()
	return nil
}

// acceptCmdLocked 는 서명이 맞고 시각 안의 처음 보는 명령이면 넘기라고(참) 답한다. 적용은 이 노드가
// 그 노드의 도우미 키를 믿을 때만 한다 — 믿지 못하는 노드가 중간에 있어도 너머에 닿는다 (§3.12a R-10).
// 본 것은 id 가 아니라 서명된 프레임 전체의 해시로 기억한다. 같은 id 를 단 가짜가 먼저 와도 진짜를
// 막지 못한다. 믿지 못해 넘기기만 한 것은 따로 기억해, 적용한 것의 기억을 밀어내지 못한다.
func (s *Service) acceptCmdLocked(fr frame) bool {
	b, err := humancmd.Open(humancmd.Signed{B: fr.B, S: fr.S})
	if err != nil || b.Node == s.id.Fingerprint || !inWindow(s.now(), b.At) {
		return false
	}
	h := cmdHash(fr.B, fr.S)
	if _, seen := s.cmds[h]; seen {
		return false
	}
	if _, seen := s.relayed[h]; seen {
		return false
	}
	if key, ok := s.trustedKeyLocked(b.Node); ok && key == b.Key {
		remember(s.cmds, h, s.now())
		s.applyCmdLocked(b)
		return true
	}
	remember(s.relayed, h, s.now())
	return true
}

func cmdHash(b json.RawMessage, sig string) string {
	sum := sha256.Sum256(append(append([]byte{}, b...), sig...))
	return hex.EncodeToString(sum[:])
}

func inWindow(now time.Time, atMs int64) bool {
	at := time.UnixMilli(atMs)
	return !at.Before(now.Add(-cmdWindow)) && !at.After(now.Add(cmdWindow))
}

// remember 는 본 것 하나를 기억한다. cmdSeenFor 가 지난 것은 잊고, 상한을 넘으면 가장 오래된 것을 잊는다.
func remember(m map[string]time.Time, k string, now time.Time) {
	oldest := ""
	for x, at := range m {
		if now.Sub(at) > cmdSeenFor {
			delete(m, x)
			continue
		}
		if oldest == "" || at.Before(m[oldest]) {
			oldest = x
		}
	}
	if len(m) >= maxSeenCmds {
		delete(m, oldest)
	}
	m[k] = now
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
// 간선 상대는 고정한 키다. 망 이웃은 그 노드와 서로 이어진(양쪽의 서명된 망 정보 links 에 서로
// 있는, EDGE_MESH_SRS FR-EGM-43) 닿는 노드들, 곧 그 노드의 간선 상대들이 알린 고정값이 모두 같고
// 그 노드 자신이 알린 helper 와도 같을 때 그 키다. 간선이 아닌 노드의 고정값은 세지 않는다.
func (s *Service) trustedKeyLocked(node string) (string, bool) {
	if node == s.id.Fingerprint {
		return s.helperKey, s.helperKey != ""
	}
	if e, ok := s.edgeLocked(node); ok {
		return e.HelperKey, e.HelperKey != ""
	}
	target, ok := s.nodes[node]
	if !ok || target.st.Helper == "" {
		return "", false
	}
	reach := s.reachableLocked()
	var pins []string
	for fp, r := range s.nodes {
		if fp == node || !reach[fp] || !s.mutualLocked(fp, node) {
			continue
		}
		if k, ok := r.st.Pins[node]; ok {
			pins = append(pins, k)
		}
	}
	k, ok := agreed(pins)
	return k, ok && k == target.st.Helper
}

// validHelperKey 는 빈 값이거나 32바이트 Ed25519 공개키의 base64 인지 본다.
func validHelperKey(k string) bool {
	if k == "" {
		return true
	}
	raw, err := base64.StdEncoding.DecodeString(k)
	return err == nil && len(raw) == ed25519.PublicKeySize
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

// edgesLocked 는 간선 목록의 캐시다. 상태를 받을 때마다 간선 설정을 복사하지 않도록, 1초가 넘은
// 캐시만 다시 읽는다. 고정한 뒤에는 바로 다시 읽는다 (§3.12a R-9).
func (s *Service) edgesLocked() []edge.Edge {
	if s.opts.Edges == nil {
		return nil
	}
	if now := s.now(); s.edgeCache == nil || now.Sub(s.edgeAt) > edgeCacheFor {
		s.edgeCache, s.edgeAt = s.opts.Edges(), now
		if s.edgeCache == nil {
			s.edgeCache = []edge.Edge{}
		}
	}
	return s.edgeCache
}

func (s *Service) edgeLocked(fp string) (edge.Edge, bool) {
	for _, e := range s.edgesLocked() {
		if e.Fingerprint == fp {
			return e, true
		}
	}
	return edge.Edge{}, false
}

// pinsLocked 는 상태 알림에 싣는 간선 상대의 고정값이다.
func (s *Service) pinsLocked() map[string]string {
	var out map[string]string
	for _, e := range s.edgesLocked() {
		if e.HelperKey == "" {
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
func (s *Service) pinLocked(fp string) func() {
	if fp == "" || s.opts.Pin == nil {
		return nil
	}
	r, ok := s.nodes[fp]
	if !ok || r.st.Helper == "" {
		return nil
	}
	e, ok := s.edgeLocked(fp)
	if !ok {
		// 자기 연결로 상태를 보낸 상대는 간선이다 — 없다면 캐시가 그 간선보다 낡았다. 간선 계층이 Linked(캐시
		// 비우기)와 읽기 루프를 따로 띄우므로 이 상태가 먼저 올 수 있다. 한 번 새로 읽는다.
		s.edgeCache = nil
		e, ok = s.edgeLocked(fp)
	}
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
		s.edgeCache = nil
		s.announceLocked()
		s.mu.Unlock()
	}
}
