package agentsess

import (
	"io"
	"os"
	"strings"
	"time"

	"dongminal/internal/shared/agentadapter"
)

// M9_SRS FR-M9-41 (M9-B23) — **올린 세션은 기록을 그대로 띄운다.**
//
// 접수한 말: *"세션 기록이 그대로 넘어가야하는데 아무것도 안보인다. 처음키는것과
// 같다."* 화면은 우리 이벤트 로그를 재생하는데(`Session.Replay`) 올리기는 **새
// `toolId`** 라 그 로그가 비어 있었다. 세션 자체는 이어진다 — 비는 것은 그릴 재료다.
//
// **에이전트는 이 일을 해주지 않는다** (실측 2026-09-14): `--resume` 한 세션은
// 과거를 알지만("암호가 뭐였지?" 에 답한다) 스트림에 재생하지 않는다(새 턴 7줄뿐).
// 그래서 기록은 우리가 읽는다.
//
// 층은 셋이다. 파일을 열고 꼬리를 자르는 것이 여기, 한 줄의 뜻은 어댑터
// (`ParseHistory`), 그리는 것은 **기존 재생 경로 그대로**다 — 화면에 새 길을 내지
// 않는다.

// HistoryTailMax 는 전사본에서 되읽을 꼬리의 상한이다 (FR-M9-41).
//
// 전사본은 크다 (실측 2026-09-14: 4.1MB · 2191줄, 한 줄이 26KB 인 것도 있다).
// 전부 읽어 이벤트로 펴면 로그 상한(`DefaultLogCap`)이 어차피 앞을 버리므로,
// 버릴 것을 만들지 않는 쪽이 싸다. 잘린 사실은 `truncated` 로 말한다.
const HistoryTailMax = 1 << 20

// 기록을 물었는가와 그 답 (State.History).
const (
	// HistoryLoaded 는 읽었다는 뜻이다. 기록이 비어 있어도 그것은 "빈 대화" 다.
	HistoryLoaded = "loaded"
	// HistoryUnavailable 은 **묻고 못 읽었다**는 뜻이다. 화면은 그때 빈 채로 열되
	// 그 사실을 문장으로 말한다 (FR-APS-4) — 조용히 비면 사용자는 세션이 이어지지
	// 않은 줄 안다. 빈 문자열은 셋째 값이다: 묻지 않았다(재개가 아니다).
	HistoryUnavailable = "unavailable"
)

// History 는 읽어 온 기록이다. OK 가 거짓이면 Events 는 비어 있고 그 사실이 곧 값이다.
type History struct {
	Events []agentadapter.Event
	// Truncated 는 앞을 잘랐다는 뜻이다 — 상한 안에 파일이 다 들어오지 않았다.
	Truncated bool
	// Asked 는 **물었다**는 뜻이다. OK 와 따로 있는 이유: 묻지 않은 것(재개가 아닌
	// 새 세션)과 묻고 못 읽은 것은 화면에서 다른 뜻이다. `LoadHistory` 를 부르는
	// 것이 곧 묻는 것이므로 그 함수는 어느 갈래에서도 이것을 세운다.
	Asked bool
	OK    bool
}

// LoadHistory 는 전사본 꼬리를 읽어 이벤트로 옮긴다 (FR-M9-41).
//
// 분업은 `transcriptUsage` 와 같다 (FR-AAC-11): 뒤에서부터 읽는 것은 **파일 다루는
// 법**이라 여기 남고, 한 줄의 뜻은 어댑터가 안다. 읽지 않는 어댑터의 전사본은
// **열지도 않는다** (FR-AAC-13).
//
// 실패는 오류가 아니라 **모름**이다. 세션은 기록 없이도 서야 하고, 기록을 읽지
// 못한 것이 도구를 못 여는 이유가 되면 안 된다.
func LoadHistory(ad agentadapter.Adapter, path string, tailMax int64) History {
	if ad.ParseHistory == nil || path == "" {
		return History{Asked: true}
	}
	if tailMax <= 0 {
		tailMax = HistoryTailMax
	}
	f, err := os.Open(path)
	if err != nil {
		return History{Asked: true}
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return History{Asked: true}
	}
	off, n := int64(0), st.Size()
	if n > tailMax {
		off, n = st.Size()-tailMax, tailMax
	}
	buf := make([]byte, n)
	if _, err := f.ReadAt(buf, off); err != nil && err != io.EOF {
		return History{Asked: true}
	}
	lines := strings.Split(string(buf), "\n")
	h := History{Asked: true, OK: true}
	// 처음부터 읽지 않았으면 첫 조각은 반 토막 난 줄이다 — 해석하면 없는 내용이 된다.
	if off > 0 && len(lines) > 0 {
		lines, h.Truncated = lines[1:], true
	}
	for _, line := range lines {
		evs, ok := ad.ParseHistory(line)
		if !ok {
			continue
		}
		h.Events = append(h.Events, evs...)
	}
	return h
}

// seedHistory 는 기록을 로그의 맨 앞에 심는다. s.mu 아래, 핸드셰이크 **전에** 부른다.
//
// `emit` 을 쓰지 않는 이유가 셋이다.
//
//	① **활동을 파생하지 않는다.** 지난 턴이 지금의 상태를 덮으면 사용자는 끝난 일을
//	   도는 중으로 본다. 알람도 같은 이유로 울리면 안 된다
//	② **status·usage 를 합치지 않는다** (`merge`). 과거의 모델·토큰이 현재를 덮으면
//	   하단 대시보드가 지난 값을 지금으로 말한다
//	③ **싱크로 내보내지 않는다.** 이 시점에 붙어 있는 브라우저가 없고, 붙으면
//	   재생으로 받는다 — 같은 것을 두 번 보내지 않는다
//
// 링과 스냅샷은 그대로 쓴다 (D-C-13). 상한을 넘는 기록은 기존 장치가 접고, 그
// 사실은 `Replay` 의 `truncated` 로 나간다 — 새 장치를 만들지 않는다.
func (s *Session) seedHistory(h History) {
	if h.OK {
		s.history = HistoryLoaded
	} else {
		s.history = HistoryUnavailable
	}
	s.histTruncated = h.Truncated
	at := time.Now().UnixMilli()
	for _, ev := range h.Events {
		s.nextSeq++
		le := Logged{Seq: s.nextSeq, At: at, Ev: ev}
		s.log = append(s.log, le)
		s.appendLog(le)
	}
	if over := len(s.log) - s.mgr.deps.LogCap; over > 0 {
		if s.snap == nil {
			s.snap = &Snapshot{}
		}
		for _, d := range s.log[:over] {
			s.snap.fold(d)
		}
		s.droppedSinceCompact += over
		s.log = append([]Logged(nil), s.log[over:]...)
		s.firstSeq = s.log[0].Seq
	}
}
