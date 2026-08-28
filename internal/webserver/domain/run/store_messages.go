// 묶음 V — 메시지 로그의 저장소 절반이다 (ORCHESTRATION_V2_SRS FR-RVZ-14).
//
// store.go 가 아니라 이 파일에 있는 이유는 store_headless.go 와 같다 — store.go 는
// 여러 워크스트림이 함께 딛는 파일이고, 같은 패키지이므로 메서드는 여기서 붙여도
// 동등하다. MsgEvent·Record.Messages 의 정의는 store.go 에 이미 있다.
package run

import "errors"

// MaxMessages 는 Run 하나가 보관하는 메시지 사실의 상한이다 (FR-RVZ-14).
//
// 상한이 있는 이유는 그래프가 최근을 그리기 때문이다. 오래된 엣지는 굵기에만
// 기여하고 그 대가로 runs.json 이 무한히 자란다 — 저장소는 매 변경마다 전체를
// 다시 쓰므로 그 비용이 팀 통신 속도에 그대로 실린다.
const MaxMessages = 500

// CoordinatorParty 는 메시지 로그에서 조정자를 가리키는 이름이다 (FR-RVZ-14).
// 조정자는 멤버가 아니어서 uuid 가 없다 — 그래프의 노드 이름이 곧 정체다.
const CoordinatorParty = "coordinator"

// MsgKindAgent 는 신뢰 채널(`dmctl msg`)을 지나는 팀 통신이다 (FR-RVZ-14 의 Kind).
//
// SRS 는 server-alert 도 열거하지만 상수를 두지 않는다 — 그 값을 쓸 기록 지점이
// 아직 없고(FR-CBG-6 의 통지는 handlers_runs_context.go 소관), 쓰이지 않는 이름은
// 있지도 않은 경로가 있는 것처럼 보이게 한다.
const MsgKindAgent = "agent"

// ErrNotRunParticipant 는 발신·수신 중 어느 쪽도 그 Run 의 멤버가 아니라 기록을
// 거부한 경우다 (FR-RVZ-14). 팀 밖 통신은 Run 의 관심사가 아니다.
//
// 별도 오류인 이유는 FR-PRE-6 의 규칙과 같다 — "그런 Run 이 없다"와 "그 Run 과
// 무관한 통신이다"는 다른 사실이고, 호출자가 다르게 다룰 수 있어야 한다.
var ErrNotRunParticipant = errors.New("not_run_participant")

// AppendMessage records one delivered trust-channel message (FR-RVZ-14).
//
// **본문을 받지 않는다.** 인자에 본문이 없으므로 실수로도 새지 않는다 —
// NFR-RVZ-3 을 규율이 아니라 서명으로 지킨다.
//
// ev.At 이 비어 있으면 저장소의 시계로 채운다. 호출자가 시각을 정할 수 있게
// 열어 두는 이유는 테스트의 결정성이다 (WithClock 과 같은 근거).
func (s *Store) AppendMessage(runID string, ev MsgEvent) error {
	if ev.From == "" || ev.To == "" {
		return ErrInvalidArgument
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	idx := s.indexOf(runID)
	if idx < 0 {
		return ErrUnknownRun
	}
	rec := &s.runs[idx]
	if !rec.hasMember(ev.From) && !rec.hasMember(ev.To) {
		return ErrNotRunParticipant
	}
	if ev.At == 0 {
		ev.At = s.now()
	}

	msgs := append(rec.Messages, ev)
	if len(msgs) > MaxMessages {
		// 자리를 앞으로 당기지 않고 **새 배열로 옮긴다.** Get·List 가 돌려준
		// Record 는 이 슬라이스의 배열을 공유하므로, 제자리에서 밀면 이미 나간
		// 복사본의 내용이 뒤에서 바뀐다 — 읽는 쪽이 잠금 밖이라 데이터 레이스다.
		msgs = append([]MsgEvent(nil), msgs[len(msgs)-MaxMessages:]...)
	}
	rec.Messages = msgs
	return s.save()
}

// hasMember reports whether id names a member row of this Run. Callers hold
// s.mu (or own the copy).
//
// 조정자는 여기서 **거짓**이다 — 조정자는 멤버가 아니다. 그래도 조정자→멤버는
// 기록된다: 규칙이 "어느 쪽도 멤버가 아니면" 이지 "양쪽 다 멤버여야" 가 아니기
// 때문이다 (FR-RVZ-14). 반대로 조정자↔조정자는 멤버가 하나도 없어 걸러진다.
func (r Record) hasMember(id string) bool {
	if id == "" {
		return false
	}
	for _, m := range r.Members {
		if m.ID == id {
			return true
		}
	}
	return false
}
