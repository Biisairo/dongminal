package wsentry

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"dongminal/internal/shared/workspace"
)

// 두 목록은 workspace.json 최상위에 산다 — 창 트리 밖이다 (FR-EDT-19, FR-GIT-11).
const (
	gitKey       = "git"
	pinnedKey    = "pinned"
	editorsKey   = "editors"
	listKey      = "list"
	schemaKey    = "schemaVersion"
	schemaVer    = 2
	saveTries    = 2 // 낙관적 동시성 경합 시 한 번 다시 읽어 재시도한다 (FR-EDT-22)
	broadcastAct = "workspace_changed"
)

// Mutate 는 두 목록을 **한 번의** read-modify-write 로 바꾼다 (FR-EDT-22·35).
// 다른 키는 건드리지 않는다 — 핀 하나를 더하다가 창 배치를 잃으면 안 된다.
//
// 경합(ErrStale)이면 한 번 다시 읽어 재시도하고, 성공하면 workspace_changed 를
// 한 번 브로드캐스트한다.
func (s *Store) Mutate(fn func(Lists) Lists) (Lists, error) {
	if s.Work == nil {
		return Lists{}, ErrUnavailable
	}
	var lastErr error
	for try := 0; try < saveTries; try++ {
		raw, rev := s.Work.Snapshot()
		doc, cur, err := parse(raw)
		if err != nil {
			return Lists{}, err
		}
		next := fn(cur)
		if next.Pinned == nil {
			next.Pinned = []string{}
		}
		if next.Editors == nil {
			next.Editors = []string{}
		}
		// 바뀐 것이 없으면 저장하지 않는다 (FR-EDT-27·38a). rev 를 올리면
		// `workspace_changed` 가 모든 브라우저에 나가 재조정을 돌린다 —
		// 목록이 그대로인데 그 비용을 치를 이유가 없다.
		if sameLists(cur, next) {
			return next, nil
		}
		write(doc, next)
		blob, err := json.Marshal(doc)
		if err != nil {
			return Lists{}, err
		}
		newRev, err := s.Work.Save(blob, strconv.FormatUint(rev, 10))
		if errors.Is(err, workspace.ErrStale) {
			lastErr = err
			continue
		}
		if err != nil {
			return Lists{}, err
		}
		// 다른 브라우저 창이 같은 목록을 보고 있다 (FR-GIT-31, FR-EDT-22).
		s.broadcast(newRev)
		return next, nil
	}
	return Lists{}, lastErr
}

// parse 는 블롭을 map 으로 풀어 문서와 두 목록을 준다. 나머지 키
// (schemaVersion·windows 등)는 그대로 지나간다.
func parse(raw []byte) (map[string]any, Lists, error) {
	doc := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &doc); err != nil {
			return nil, Lists{}, fmt.Errorf("workspace 파싱: %w", err)
		}
	}
	// JSON `null` 은 Unmarshal 이 map 을 **nil 로 만든다.** 이어지는 쓰기가
	// "assignment to entry in nil map" 으로 패닉하므로 여기서 되살린다
	// (FR-EDT-30).
	if doc == nil {
		doc = map[string]any{}
	}
	if len(doc) == 0 {
		// 블롭이 비었으면 최소 문서를 기반으로 만든다. schemaVersion 이 없는
		// 블롭은 Save 가 거부한다 (FR-EM-2a).
		doc[schemaKey] = schemaVer
	}
	return doc, Lists{
		Pinned:  strList(doc, gitKey, pinnedKey),
		Editors: strList(doc, editorsKey, listKey),
	}, nil
}

// strList 는 doc[outer][inner] 의 문자열 배열을 꺼낸다. 배열이 아니거나 항목이
// 문자열이 아니면 **조용히 버린다** — 손상된 워크스페이스가 종단 전체를 죽이지
// 않는다 (FR-EDT-30).
func strList(doc map[string]any, outer, inner string) []string {
	m, _ := doc[outer].(map[string]any)
	arr, _ := m[inner].([]any)
	out := make([]string, 0, len(arr))
	for _, v := range arr {
		if s, ok := v.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

// write 는 두 목록을 문서에 되쓴다. 각 상위 객체의 다른 키(git 의 drafts·favorites)는
// 보존한다 — 핀 하나를 더하다 draft 를 잃으면 안 된다.
//
// editors 키는 목록이 비었고 원래도 없었다면 만들지 않는다 — Editor 행을 한 번도
// 쓴 적 없는 워크스페이스에 빈 키를 남기지 않는다.
func write(doc map[string]any, next Lists) {
	g, _ := doc[gitKey].(map[string]any)
	if g == nil {
		g = map[string]any{}
	}
	g[pinnedKey] = next.Pinned
	doc[gitKey] = g

	_, present := doc[editorsKey]
	if len(next.Editors) == 0 && !present {
		return
	}
	e, _ := doc[editorsKey].(map[string]any)
	if e == nil {
		e = map[string]any{}
	}
	e[listKey] = next.Editors
	doc[editorsKey] = e
}

func (s *Store) broadcast(rev uint64) {
	if s.Commands == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"action": broadcastAct,
		"args":   map[string]any{"rev": rev},
	})
	s.Commands.Broadcast(payload)
}

// sameLists 는 두 목록이 순서까지 같은지 본다. 저장을 건너뛸지 판단하는 유일한
// 근거다.
func sameLists(a, b Lists) bool {
	return sameSlice(a.Pinned, b.Pinned) && sameSlice(a.Editors, b.Editors)
}

func sameSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
