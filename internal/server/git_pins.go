package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"dongminal/internal/workspace"
)

// 핀 목록은 workspace.json 최상위 `git.pinned[]` 에 산다 (FR-GIT-11, O1). 창
// 트리 안이 아닌 이유는 핀이 창과 무관하게 워크스페이스 하나에 하나이기 때문이다.
const (
	gitKey           = "git"
	gitPinnedKey     = "pinned"
	gitPinsSchemaVer = 2
	gitPinsSchemaKey = "schemaVersion"
	gitPinsSaveTries = 2 // 낙관적 동시성 경합 시 한 번 다시 읽어 재시도한다
)

// gitPinsRead 는 workspace.json 의 git.pinned[] 를 읽는다. 없으면 빈 목록이다.
func (s *Server) gitPinsRead() ([]string, error) {
	if s.Work == nil {
		return nil, errors.New("workspace unavailable")
	}
	raw, _ := s.Work.Snapshot()
	_, pins, err := gitPinsParse(raw)
	return pins, err
}

// gitPinsMutate 는 git.pinned[] **만** 고쳐 저장한다. 다른 키는 건드리지 않는다 —
// 핀 하나를 더하다가 창 배치를 잃으면 안 된다.
//
// 낙관적 동시성으로 저장하고, 경합(ErrStale)이면 한 번 다시 읽어 재시도한다.
func (s *Server) gitPinsMutate(fn func([]string) []string) ([]string, error) {
	if s.Work == nil {
		return nil, errors.New("workspace unavailable")
	}
	var lastErr error
	for try := 0; try < gitPinsSaveTries; try++ {
		raw, rev := s.Work.Snapshot()
		doc, pins, err := gitPinsParse(raw)
		if err != nil {
			return nil, err
		}
		next := fn(pins)
		if next == nil {
			next = []string{}
		}
		// git 하위의 다른 키(M2 의 drafts, M5 의 favorites)를 보존한다 —
		// git 객체를 통째로 갈아치우면 핀 하나를 더하다 draft 를 잃는다.
		g, _ := doc[gitKey].(map[string]any)
		if g == nil {
			g = map[string]any{}
		}
		g[gitPinnedKey] = next
		doc[gitKey] = g
		blob, err := json.Marshal(doc)
		if err != nil {
			return nil, err
		}
		newRev, err := s.Work.Save(blob, strconv.FormatUint(rev, 10))
		if errors.Is(err, workspace.ErrStale) {
			lastErr = err
			continue
		}
		if err != nil {
			return nil, err
		}
		// 다른 브라우저 창이 같은 목록을 보고 있다 (FR-GIT-31).
		s.broadcastWorkspaceChanged(newRev)
		return next, nil
	}
	return nil, lastErr
}

// gitPinsParse 는 블롭을 map 으로 풀어 문서와 핀 목록을 준다. 나머지 키
// (schemaVersion·windows 등)는 그대로 지나간다.
func gitPinsParse(raw []byte) (map[string]any, []string, error) {
	doc := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, nil, fmt.Errorf("workspace 파싱: %w", err)
		}
	}
	if len(doc) == 0 {
		// 블롭이 비었으면 최소 문서를 기반으로 만든다. schemaVersion 이 없는
		// 블롭은 Save 가 거부한다 (FR-EM-2a).
		doc[gitPinsSchemaKey] = gitPinsSchemaVer
	}
	g, _ := doc[gitKey].(map[string]any)
	arr, _ := g[gitPinnedKey].([]any)
	pins := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok && s != "" {
			pins = append(pins, s)
		}
	}
	return doc, pins, nil
}

// broadcastWorkspaceChanged 는 apiWorkspacePut 과 같은 알림을 보낸다. 핀 변경도
// 워크스페이스 변경이므로 클라이언트가 두 경로를 구분할 이유가 없다.
func (s *Server) broadcastWorkspaceChanged(rev uint64) {
	if s.Commands == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"action": "workspace_changed",
		"args":   map[string]any{"rev": rev},
	})
	s.Commands.Broadcast(payload)
}
