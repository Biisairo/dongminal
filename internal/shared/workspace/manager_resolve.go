package workspace

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `manager.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **식별자를 해석하는 일**이다 (`ORCHESTRATION_V2_SRS` 묶음 I).
// 라벨을 받을지 말지, 어느 사다리를 어느 순서로 타는지가 전부 여기 있다 — 그
// 규칙이 한 자리에 있어야 `Resolve` 와 `ResolveStrict` 가 조용히 갈리지 않는다.

// Resolve translates an identifier into a live toolId. Per FR-UNI-10 the kind of
// identifier is decided by lookup result, never by its shape — toolId is a uuid
// since 묶음 U, so a numeric/36-char test would reject live tools (SRS §2.7).
//
// 순서: 살아있는 toolId → 엔터티 uuid 인덱스 → 좌표 라벨 인덱스 → 실패.
func (m *Manager) Resolve(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(errEmptyID)
	}
	ix := m.idx.Load()
	// 1·2) 살아있는 toolId → 엔터티 uuid. 두 해석기가 공유한다.
	if pid, done, err := m.resolveEntity(ix, id); done {
		return pid, err
	}
	// 3) 좌표 라벨인가.
	if ix != nil {
		norm := strings.ToUpper(id)
		if pid, ok := ix.labelToID[norm]; ok {
			if !m.live.IsLive(pid) {
				return "", fmt.Errorf(errDanglingLabel, norm, pid)
			}
			return pid, nil
		}
	}
	return "", unresolvedError(ix, id)
}

// ResolveStrict translates an identifier into a live toolId **without accepting
// coordinate labels** (ORCHESTRATION_V2_SRS FR-IDU-1).
//
// Resolve 와 갈라지는 이유: 라벨(W1.P2.T1)은 창·분할 칸이 닫히면 다시 계산되므로,
// 에이전트가 라벨로 팀원을 부르면 사용자가 창 하나를 닫는 순간 **다른 도구에게**
// 메시지가 간다. 레이아웃 명령은 화면 위치가 곧 대상이라 라벨이 자연스럽지만,
// 접합면(read-screen·send-input·msg·status·wait)은 그렇지 않다.
//
// 순서: 살아있는 toolId → 엔터티 uuid 인덱스 → 실패. 라벨 형태의 입력은
// ErrLabelIdentifier 를 감싼 전용 진단으로 갈린다 (FR-IDU-2). 그 밖의 실패
// 문안은 Resolve 와 같다 (FR-IDU-3 행위 보존).
func (m *Manager) ResolveStrict(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", errors.New(errEmptyID)
	}
	ix := m.idx.Load()
	// 1·2) 살아있는 toolId → 엔터티 uuid. Resolve 와 같은 사다리다.
	if pid, done, err := m.resolveEntity(ix, id); done {
		return pid, err
	}
	// 라벨 인덱스는 조회하지 않는다. 형태 판정이 조회 뒤에 오므로 라벨과 같은
	// 문자열의 uuid·toolId 가 있으면 그쪽이 이긴다 (FR-UNI-10 보존).
	if isLabelForm(id) {
		return "", fmt.Errorf(errLabelRejected, id, ErrLabelIdentifier)
	}
	return "", unresolvedError(ix, id)
}

// 해석 실패 문안이다. Resolve 와 ResolveStrict 가 같은 문안을 내야 하는데
// (FR-IDU-3 행위 보존), 복제로 지키면 한쪽만 고쳐도 컴파일이 통과하고 그때
// 조용히 갈라진다. 한 자리에 모아 그 가능성을 없앤다.
const (
	errEmptyID       = "빈 id"
	errDanglingTabID = "tab id %s 은 toolId=%s 가리키지만 도구가 존재하지 않음"
	errDanglingLabel = "라벨 %s 은 toolId=%s 가리키지만 도구가 존재하지 않음"
	errUnknownToolID = "toolId=%s 존재하지 않음"
	errUnresolvedID  = "id 해석 실패: %s (list_workspace 로 확인)"
	errLabelRejected = "좌표 라벨(%s)은 이 명령에서 쓸 수 없다 — uuid 를 쓴다.\n" +
		"라벨은 창·분할 칸이 닫히면 다시 계산돼 다른 탭을 가리킨다.\n%w"
)

// resolveEntity 는 두 해석기가 공유하는 사다리 1·2단계다 — 살아있는 toolId 인가,
// 아니면 엔터티(창·분할 칸·탭) uuid 인가. 형태는 보지 않고 조회 결과가 정한다
// (FR-UNI-10).
//
// done=true 면 (toolID, err) 가 최종 결과다. false 면 이 단계에서 답이 나오지
// 않았다는 뜻이며, 그 뒤는 해석기마다 갈린다.
func (m *Manager) resolveEntity(ix *index, id string) (string, bool, error) {
	if m.live.IsLive(id) {
		return id, true, nil
	}
	if ix != nil {
		if pid, ok := ix.uuidToID[strings.ToLower(id)]; ok {
			if !m.live.IsLive(pid) {
				return "", true, fmt.Errorf(errDanglingTabID, id, pid)
			}
			return pid, true, nil
		}
	}
	return "", false, nil
}

// unresolvedError 는 사다리를 다 내려온 뒤의 진단이다. 인덱스에 toolId 로 보이면
// "없어진 도구"이고, 그렇지 않으면 아예 알 수 없는 id 다 (FR-UNI-12).
func unresolvedError(ix *index, id string) error {
	if isKnownToolID(ix, id) {
		return fmt.Errorf(errUnknownToolID, id)
	}
	return fmt.Errorf(errUnresolvedID, id)
}

// labelForm 은 좌표 라벨의 형태다 (FR-IDU-2). 대소문자를 가리지 않는다.
var labelForm = regexp.MustCompile(`(?i)^W\d+\.P\d+\.T\d+$`)

// isLabelForm 은 ResolveStrict 의 진단 메시지를 고르는 데에만 쓴다. 해석에 쓰면
// FR-UNI-10(해석은 조회 결과가 정한다)이 깨진다.
func isLabelForm(s string) bool { return labelForm.MatchString(s) }

// isKnownToolID reports whether id appears as a tab's toolId in the current
// tree. FR-UNI-12: 형태가 아니라 인덱스로 판정하며, 진단 메시지에만 쓴다.
func isKnownToolID(ix *index, id string) bool {
	if ix == nil {
		return false
	}
	for _, pid := range ix.uuidToID {
		if pid == id {
			return true
		}
	}
	return false
}

// CoordinateOf translates an identifier into the canonical positional
// coordinate "W{n}.P{n}.T{n}" that the browser command pipeline parses. Only
// UUID inputs are rewritten — coordinate, toolId, label, and empty inputs are
// returned unchanged (NFR-UID-0 행위 보존). Used by /api/commands and
// workspace_command so dmctl and MCP accept UUID anywhere a location is
// expected.
func (m *Manager) CoordinateOf(id string) (string, error) {
	if id == "" {
		return id, nil
	}
	ix := m.idx.Load()
	var toolID string
	if ix != nil {
		if pid, ok := ix.uuidToID[strings.ToLower(id)]; ok {
			toolID = pid
		}
	}
	if toolID == "" {
		// FR-UNI-11 2번: 살아있는 toolId 는 pass-through 다. toolId 가 uuid 가 된
		// 뒤로는 이 분기가 없으면 아래 stale 판정에 걸려 location=<toolId> 가
		// 전부 거절된다 (SRS §2.7).
		if m.live.IsLive(id) {
			return id, nil
		}
		if isUUIDForm(id) {
			// 36자 UUID 형식인데 인덱스에도 없고 살아있는 도구도 아니면 stale
			// uuid — 명시적 에러. FR-UNI-12: 형태 검사는 여기(진단)에만 남는다.
			return "", fmt.Errorf("id 해석 실패: %s (list_workspace 로 확인)", id)
		}
		// 좌표/라벨/구 정수 toolId/그 외 식별자는 pass-through (NFR-UID-0 행위 보존).
		return id, nil
	}
	if !m.live.IsLive(toolID) {
		return "", fmt.Errorf("tab id %s 은 toolId=%s 가리키지만 도구가 존재하지 않음", id, toolID)
	}
	if label, ok := ix.labels[toolID]; ok {
		return label, nil
	}
	return "", fmt.Errorf("tab id %s 은 toolId=%s 가리키지만 label 매핑 없음", id, toolID)
}

// IsKnownTabID reports whether id matches a tab.id present in the current
// workspace index (case-insensitive). Used by API entry points to enforce the
// "location must be a list-workspace uuid" policy (FR-DMC-9/10).
func (m *Manager) IsKnownTabID(id string) bool {
	if id == "" {
		return false
	}
	ix := m.idx.Load()
	if ix == nil {
		return false
	}
	_, ok := ix.uuidToID[strings.ToLower(id)]
	return ok
}

// isUUIDForm checks the canonical 8-4-4-4-12 hex shape without validating that
// every character is hex — Resolve will fail on lookup anyway, and a strict
// hex check here would block legitimate non-UUID inputs that happen to share
// the length (rare in practice but the looser check stays composable).
func isUUIDForm(s string) bool {
	if len(s) != 36 {
		return false
	}
	return s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}

func (m *Manager) Labels() map[string]string {
	ix := m.idx.Load()
	if ix == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(ix.labels))
	for k, v := range ix.labels {
		out[k] = v
	}
	return out
}

// TabIDs returns the set of tab ids currently present in the workspace.
// Returned map is a copy; safe to mutate.
func (m *Manager) TabIDs() map[string]struct{} {
	ix := m.idx.Load()
	if ix == nil {
		return map[string]struct{}{}
	}
	out := make(map[string]struct{}, len(ix.tabIDs))
	for k := range ix.tabIDs {
		out[k] = struct{}{}
	}
	return out
}
