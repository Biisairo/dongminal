package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
)

// snapshotParts 는 `GET /api/snapshot` 이 싣는 조각과 그 조각을 만드는 종단이다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-4-5).
//
// 조각은 **그 종단의 본문 그대로**다. 새 모양을 만들지 않는 이유는 받는 쪽의 복원
// 함수가 한 벌로 남기 때문이다 — 조각을 받든 종단을 직접 부르든 같은 본문을 읽는다.
var snapshotParts = map[string]func(*Server, http.ResponseWriter, *http.Request){
	"attention":  (*Server).apiToolsAttention,
	"activity":   (*Server).apiToolsActivity,
	"background": (*Server).apiToolsBackground,
	"settings":   (*Server).apiSettingsGet,
	"update":     (*Server).apiUpdateGet,
	"focus":      (*Server).apiFocusGet,
}

// partRecorder 는 조각 하나의 응답을 받아 두는 ResponseWriter 다.
type partRecorder struct {
	header http.Header
	code   int
	buf    bytes.Buffer
}

func (p *partRecorder) Header() http.Header         { return p.header }
func (p *partRecorder) Write(b []byte) (int, error) { return p.buf.Write(b) }
func (p *partRecorder) WriteHeader(code int)        { p.code = code }

/*
apiSnapshot 은 SSE 구독이 열릴 때의 복원을 **요청 하나**로 준다 (FR-OPT-4-5 · IPC-6 ·
FEC-11).

	이전 동작: 구독이 열릴 때마다 상태마다 자기 GET 을 냈다 (재연결 한 번에 7~8건)
	새  동작: `?parts=attention,activity,...` 로 고른 조각을 한 본문에 싣는다
	이유:     원격(RTT 80ms 이상)에서 재연결할 때마다 왕복 여럿이 한꺼번에 나갔고,
	          서버가 다시 뜨면 브라우저 수 × 그 묶음이 몰렸다

200 이 아닌 조각(판 확인이 없는 서버의 `update` 는 503)과 모르는 이름은 싣지 않는다 —
받는 쪽은 조각이 없으면 그 종단이 실패한 것과 같이 다룬다. 비행·병합 규약은 받는
쪽(`state-registry`)이 그대로 든다.
*/
func (s *Server) apiSnapshot(w http.ResponseWriter, r *http.Request) {
	out := map[string]json.RawMessage{}
	for _, name := range strings.Split(r.URL.Query().Get("parts"), ",") {
		h, ok := snapshotParts[name]
		if !ok {
			continue
		}
		if _, dup := out[name]; dup {
			continue
		}
		rec := &partRecorder{header: http.Header{}, code: http.StatusOK}
		h(s, rec, r)
		b := bytes.TrimSpace(rec.buf.Bytes())
		if rec.code != http.StatusOK || !json.Valid(b) {
			continue
		}
		out[name] = b
	}
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	// 설정 blob 은 브라우저가 보낸 그대로다 — `<`·`&` 를 바꾸지 않는다.
	enc.SetEscapeHTML(false)
	enc.Encode(out)
}
