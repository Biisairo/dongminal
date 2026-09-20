package run

import (
	"strings"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `store.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **읽기**다 — 잠금을 쥐고 복사본을 돌려주는 조회들과, 그 위에 선
// 짧은 파생(`Short`·`PathSlug`). 쓰기와 갈라 두면 "이 함수가 상태를 바꾸는가" 를
// 파일 이름이 먼저 답한다.

// Get returns a Run by id.
func (s *Store) Get(runID string) (Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.indexOf(runID); i >= 0 {
		return cloneRun(s.runs[i]), true
	}
	return Record{}, false
}

// List returns every Run, newest first.
func (s *Store) List() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneRuns(s.runs)
}

// MemberByTool resolves a tool to its member in an open Run. This is the
// authority check behind Report (FR-PRE-5).
func (s *Store) MemberByTool(toolID string) (Member, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ri, mi, ok := s.findByTool(toolID)
	if !ok {
		return Member{}, false
	}
	return cloneMember(s.runs[ri].Members[mi]), true
}

// FindMember resolves a member id to its Run and member row, across every Run
// regardless of state. This is what makes a preamble re-derivable: a
// coordinator that lost its context can still recover what a member was told
// (FR-PRE-1), and a closed Run stays inspectable.
func (s *Store) FindMember(memberID string) (Record, Member, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if memberID == "" {
		return Record{}, Member{}, false
	}
	for ri := range s.runs {
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ID == memberID {
				return cloneRun(s.runs[ri]), cloneMember(s.runs[ri].Members[mi]), true
			}
		}
	}
	return Record{}, Member{}, false
}

// findByTool locates a tool's member among OPEN runs only. Callers hold s.mu.
// Closed Runs keep their member rows for the record, but those tools are no
// longer claimed — the tool may be reused by a later Run.
func (s *Store) findByTool(toolID string) (runIdx, memberIdx int, ok bool) {
	if toolID == "" {
		return 0, 0, false
	}
	for ri := range s.runs {
		if s.runs[ri].State != Open {
			continue
		}
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ToolID == toolID {
				return ri, mi, true
			}
		}
	}
	return 0, 0, false
}

// wasMemberOfClosedRun reports whether the tool belonged to a Run that has
// since ended. Callers hold s.mu.
func (s *Store) wasMemberOfClosedRun(toolID string) bool {
	if toolID == "" {
		return false
	}
	for ri := range s.runs {
		if s.runs[ri].State == Open {
			continue
		}
		for mi := range s.runs[ri].Members {
			if s.runs[ri].Members[mi].ToolID == toolID {
				return true
			}
		}
	}
	return false
}

// indexOf finds a Run by id. Callers hold s.mu.
func (s *Store) indexOf(runID string) int {
	for i := range s.runs {
		if s.runs[i].ID == runID {
			return i
		}
	}
	return -1
}

// Short is the log/path-friendly alias — the first 8 chars of the uuid, the
// same rule workspace labels already use. worktree 경로·브랜치가 이 값에서
// 파생되므로(FR-WKT-3) 호출자도 같은 규칙을 쓸 수 있어야 한다.
func Short(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// PathSlug 는 uuid 에서 **충돌하지 않는** 경로·브랜치 조각을 만든다 (FR-WKT-3/4).
//
// short 만으로는 부족하다 — uuid v7 의 앞 48비트는 밀리초 타임스탬프이고, 그
// 상위 32비트(=앞 8자)는 49일에 한 번 바뀐다. 즉 **같은 기간에 열린 Run·Member 는
// 전부 같은 short 를 갖는다.** 실측으로 확인했다: 연속으로 만든 Run 두 개가
// 01a0370c 로 같았고, short 로 만든 경로가 그대로 겹쳤다. 뒤 8자는 난수 구간이라
// 여기에 붙여 유일성을 회복한다. 경로 재사용은 남의 대화 이력을 물려주는 것이므로
// (FR-WKT-4) 이 유일성은 편의가 아니라 요구사항이다.
func PathSlug(id string) string {
	clean := strings.ReplaceAll(id, "-", "")
	if len(clean) < 16 {
		return Short(id)
	}
	return Short(id) + "-" + clean[len(clean)-8:]
}
