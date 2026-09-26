// Package sse 는 서버가 내보내는 SSE 스트림의 작성기와 방송 본문의 봉투다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-8-1).
//
// 종전에는 `/api/commands/sse` 와 `/api/git/job/events` 가 헤더·프레임 조립·
// flush 를 따로 적었고, 뒤쪽에는 쓰기 시한이 없어 멎은 클라이언트 하나가 구독
// 고루틴을 붙들었다 (HTTP-10). 그리고 둘 다 프레임마다 flush 했다 (HTTP-M2 ·
// IPC-12). 여기서는 프레임을 버퍼에 모으고, 쌓인 것을 한 번에 쓰고 한 번 flush 한다.
package sse

import (
	"bytes"
	"errors"
	"net/http"
	"time"
)

// WriteTimeout 은 flush 하나(쓰기+Flush)의 시한이다 (REPO_FIX 02 §3A-2). 읽지 않는
// 클라이언트에서 쓰기가 막혀도 핸들러가 돌아가 구독 정리가 돈다.
const WriteTimeout = 10 * time.Second

// MaxBatchBytes 는 한 번에 모아 쓰는 양의 상한이다. 넘으면 모으기를 멈추고 쓴다 —
// 버스트가 버퍼 하나를 끝없이 키우지 않게 한다.
const MaxBatchBytes = 64 << 10

// Stream 은 SSE 응답 하나다. 고루틴 하나(핸들러)만 쓴다.
type Stream struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration
	buf     bytes.Buffer
}

// Supported 는 w 가 스트리밍을 할 수 있는지 본다. 헤더를 쓰기 전에 묻는다 —
// 못 하면 호출자가 오류 본문으로 답할 수 있어야 한다.
func Supported(w http.ResponseWriter) bool {
	_, ok := w.(http.Flusher)
	return ok
}

// Start 는 SSE 헤더와 200 을 쓴다. timeout 이 0 이하이면 WriteTimeout 이다.
func Start(w http.ResponseWriter, timeout time.Duration) *Stream {
	if timeout <= 0 {
		timeout = WriteTimeout
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	return &Stream{w: w, rc: http.NewResponseController(w), timeout: timeout}
}

// Comment 는 `: text` 주석 프레임을 버퍼에 더한다.
func (s *Stream) Comment(text string) {
	s.buf.WriteString(": ")
	s.buf.WriteString(text)
	s.buf.WriteString("\n\n")
}

// Data 는 이름 없는 `data:` 프레임을 버퍼에 더한다.
func (s *Stream) Data(payload []byte) {
	s.buf.WriteString("data: ")
	s.buf.Write(payload)
	s.buf.WriteString("\n\n")
}

// Event 는 이름 있는 프레임을 버퍼에 더한다.
func (s *Stream) Event(name string, payload []byte) {
	s.buf.WriteString("event: ")
	s.buf.WriteString(name)
	s.buf.WriteString("\n")
	s.Data(payload)
}

// Full 은 버퍼가 MaxBatchBytes 에 닿았는지 본다. 모으는 쪽이 멈출 때를 안다.
func (s *Stream) Full() bool { return s.buf.Len() >= MaxBatchBytes }

// DrainData 는 ch 에 이미 쌓인 payload 를 기다리지 않고 꺼내 Data 로 더한다.
// 버퍼가 차거나 채널이 비면 멈춘다.
func (s *Stream) DrainData(ch <-chan []byte) {
	for !s.Full() {
		select {
		case p := <-ch:
			s.Data(p)
		default:
			return
		}
	}
}

// Flush 는 버퍼를 한 번 쓰고 한 번 flush 한다. 시한을 걸 수 없는 응답(테스트의
// Recorder)은 시한 없이 쓴다. 실패하면 false — 호출자는 핸들러를 끝낸다.
func (s *Stream) Flush() bool {
	if s.buf.Len() == 0 {
		return true
	}
	defer s.buf.Reset()
	if err := s.rc.SetWriteDeadline(time.Now().Add(s.timeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		return false
	}
	if _, err := s.w.Write(s.buf.Bytes()); err != nil {
		return false
	}
	return s.rc.Flush() == nil
}
