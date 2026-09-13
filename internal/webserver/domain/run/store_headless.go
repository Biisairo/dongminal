// 묶음 H — 헤드리스 멤버의 저장소 절반이다 (ORCHESTRATION_V2_SRS §3.2.2).
//
// store.go 가 아니라 이 파일에 있는 이유는 소유권이다 — store.go 는 여러
// 워크스트림이 함께 딛는 파일이고, 같은 패키지이므로 메서드는 여기서 붙여도
// 동등하다.
package run

import (
	"errors"

	"dongminal/internal/shared/runfile"
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

// HeadlessToolIDs 는 runs.json 을 직접 읽어 **디스크에서 열린** Run 의 headless
// 도구 id 를 돌려준다 (FR-HLM-3). 본체는 `shared/runfile` 이다 — 데몬(②)도 같은
// 물음을 묻는데 데몬에는 Store 가 없고 이 패키지는 ③ 의 것이라, 둘이 실행하는
// 리더는 shared 에 산다 (M8 `GO-4`). 왜 Store 를 거치지 않는지는 그쪽 주석에 있다.
// 이 패키지가 스키마의 주인이므로 그 리더가 Store 가 쓴 파일을 같게 읽는지는 이
// 패키지의 테스트가 지킨다.
func HeadlessToolIDs(dir string) map[string]struct{} { return runfile.HeadlessToolIDs(dir) }
