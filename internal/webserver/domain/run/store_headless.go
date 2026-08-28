// 묶음 H — 헤드리스 멤버의 저장소 절반이다 (ORCHESTRATION_V2_SRS §3.2.2).
//
// store.go 가 아니라 이 파일에 있는 이유는 소유권이다 — store.go 는 여러
// 워크스트림이 함께 딛는 파일이고, 같은 패키지이므로 메서드는 여기서 붙여도
// 동등하다.
package run

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// 부착·분리의 거부 사유다. 뭉뚱그리지 않는 이유는 다른 곳과 같다 (FR-PRE-6) —
// "이미 화면에 있다"와 "화면에 없다"는 조정자가 다르게 대응해야 하는 사실이다.
var (
	ErrMemberAttached    = errors.New("member_attached")
	ErrMemberNotAttached = errors.New("member_not_attached")
)

// Attach binds a member's tool to a tab (FR-HLM-6).
//
// **State·Outcome·컨텍스트 관측을 건드리지 않는다** (FR-HLM-8). 바뀌는 것은
// TabID 와 Headless 둘뿐이다 — 관찰 행위가 관찰 대상을 바꾸지 않는다.
//
// Run 의 상태를 보지 않는다. 끝난 Run 에 남은 헤드리스 도구(FR-HLM-5 의 고아)를
// 들여다보는 것이 부착의 정당한 쓰임이고, 그것을 막으면 고아를 진단할 길이
// 없어진다.
func (s *Store) Attach(memberID, tabID string) (Record, Member, error) {
	if tabID == "" {
		return Record{}, Member{}, ErrInvalidArgument
	}
	return s.mutateMember(memberID, func(m *Member) error {
		if m.TabID != "" {
			return ErrMemberAttached
		}
		m.TabID = tabID
		m.Headless = false
		return nil
	})
}

// Detach returns a member's tool to the background (FR-HLM-7).
//
// 에이전트 프로세스는 여기서도, 호출자 쪽에서도 죽지 않는다 — 그것이 detach 의
// 정의다. 이 함수가 하는 일은 기록을 그 사실에 맞추는 것뿐이다.
//
// 처음부터 탭에 붙어 태어난 멤버(`--at`)에도 쓸 수 있다. 막을 근거가 없고,
// 막으면 "화면이 모자라 지금 떼고 싶다"는 정당한 요구에 답이 없어진다.
func (s *Store) Detach(memberID string) (Record, Member, error) {
	return s.mutateMember(memberID, func(m *Member) error {
		if m.TabID == "" {
			return ErrMemberNotAttached
		}
		m.TabID = ""
		m.Headless = true
		return nil
	})
}

// mutateMember applies fn to a member row and persists. fn 이 오류를 내면
// 기록은 그대로다 — 거부된 변경이 절반만 남는 일이 없어야 한다.
func (s *Store) mutateMember(memberID string, fn func(*Member) error) (Record, Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if memberID == "" {
		return Record{}, Member{}, ErrUnknownMember
	}
	for ri := range s.runs {
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ID != memberID {
				continue
			}
			before := s.runs[ri].Members[mi]
			if err := fn(&s.runs[ri].Members[mi]); err != nil {
				s.runs[ri].Members[mi] = before
				return Record{}, Member{}, err
			}
			if err := s.save(); err != nil {
				s.runs[ri].Members[mi] = before
				return Record{}, Member{}, err
			}
			return s.runs[ri], s.runs[ri].Members[mi], nil
		}
	}
	return Record{}, Member{}, ErrUnknownMember
}

// HeadlessTool reports whether this member owns a tool that no tab shows
// (FR-HLM-4/5).
//
// 세 조건을 함께 보는 이유가 각각 있다. Headless 는 의도이고, TabID 가 빈 것은
// 지금의 사실이며(부착 중이면 채워진다), ToolID 가 있어야 거둘 것이 있다.
// 화면에 있는 멤버가 빠지는 것이 요점이다 — 사용자가 보고 있는 도구를 서버가
// 말없이 죽이지 않는다.
func (m Member) HeadlessTool() bool {
	return m.Headless && m.TabID == "" && m.ToolID != ""
}

// HeadlessToolIDs reads runs.json directly and returns the tool ids of headless
// members belonging to Runs that are **open on disk** (FR-HLM-3).
//
// 왜 Store 를 거치지 않고 파일을 직접 읽나 — 두 가지가 다르기 때문이다.
//
//  1. 부팅 시 이 값이 필요한 시점은 `Store.Load` 가 **펜싱하기 전**이다.
//     Load 는 이전 세대가 열어 둔 Run 을 aborted 로 확정하므로(FR-RUN-5), 그
//     뒤에 물으면 "열린 Run" 이 하나도 없다. 되살릴지 말지는 **지난 세대가
//     끝날 때의 사실**로 정해야 한다.
//  2. 이 질문의 소비자는 도구 계층(toolhub)과 부팅 배선이며, 둘 다 Store 의
//     수명주기 밖에 있다. 특히 데몬 모드의 dongminald 에는 Store 자체가 없다.
//
// 열린 Run 으로 한정하는 이유: 끝난 Run 의 도구는 FR-HLM-5 의 **고아**이고,
// 고아를 부팅마다 되살리면 영원히 쌓인다. 정리는 close 의 몫이지 부팅의 몫이
// 아니다.
//
// 실패는 빈 집합이다. 되살리지 못하는 것보다 닿을 수 없는 셸을 늘리는 쪽이
// 나쁘다 — workspace 참조 해석이 같은 판단을 한다 (FR-EM-14).
func HeadlessToolIDs(dir string) map[string]struct{} {
	out := map[string]struct{}{}
	blob, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		return out
	}
	var body fileBody
	if err := json.Unmarshal(blob, &body); err != nil {
		return out
	}
	for _, rec := range body.Runs {
		if rec.State != Open {
			continue
		}
		for _, m := range rec.Members {
			if m.HeadlessTool() {
				out[m.ToolID] = struct{}{}
			}
		}
	}
	return out
}
