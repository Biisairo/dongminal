// 묶음 A — 편집기 코드 탐색의 서버 계층이다 (EDITOR_LSP_SRS §3.1).
//
// **여기에는 LSP 가 없다.** 프로토콜과 언어 서버 프로세스는 도메인 패키지의 것이며
// (D-4), 이 파일은 요청을 그 표면(`LSPService`)으로 옮기고 결과를 JSON 으로 낸다.
// 방향은 샌드박스와 같다 — httpapi 는 컨테이너 런타임을 알지 않는다.
package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
)

// lspMaxBody 는 상태·설치 요청 본문의 상한이다. 절대경로 표 몇 줄이 들어올 자리이며,
// 상한이 없으면 아무 크기나 읽는 종단이 된다.
const lspMaxBody = 64 << 10

// lspReady 는 배선을 지킨다. LSP 를 쓰지 않는 서버에서 nil 을 좇지 않고 503 을
// 내며, **그 밖의 동작에는 영향이 없다** — 코드 탐색이 없는 편집기는 종전의
// 편집기다 (NFR-RUN-1 과 같은 근거).
func (s *Server) lspReady(w http.ResponseWriter) bool {
	if s.LSP == nil {
		writeToolIOError(w, http.StatusServiceUnavailable, "language server support unavailable")
		return false
	}
	return true
}

// lspStatusReq 는 조회의 본문이다.
//
// 조회인데 POST 인 것은 본문이 필요하기 때문이다 — 절대경로 표를 질의문자열에
// 실으면 경로가 길고 로그에 그대로 남는다. `/api/fs/stamp` 가 같은 이유로 POST 다.
type lspStatusReq struct {
	// Overrides 는 화면이 실어 보낸 서술자 id → 절대경로 표다 (FR-LSP-4b).
	// 설정 블롭은 서버가 해석하지 않으므로 서버가 그것을 읽을 자리가 없다.
	Overrides map[string]string `json:"overrides"`
}

type lspInstallReq struct {
	ID string `json:"id"`
}

// apiLSPStatus 는 서술자마다 한 줄의 관측을 낸다 (FR-LSP-5·46·47).
func (s *Server) apiLSPStatus(w http.ResponseWriter, r *http.Request) {
	if !s.lspReady(w) {
		return
	}
	var req lspStatusReq
	// 빈 본문도 받는다 — 절대경로 표가 없는 것이 정상이다.
	if body, err := io.ReadAll(io.LimitReader(r.Body, lspMaxBody)); err == nil && len(body) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			writeToolIOError(w, http.StatusBadRequest, "bad request")
			return
		}
	}
	writeJSON(w, map[string]any{"servers": s.LSP.Status(req.Overrides)})
}

// apiLSPInstall 은 서술자 하나를 받는다 (FR-LSP-8·10).
//
// **실패도 200 이다.** 사유를 실은 결과가 이 종단의 산출이며(FR-LSP-10 / D-9),
// 상태 코드로 실패를 알리면 화면은 "왜" 를 말할 수 없다. 400 은 요청이 형식을
// 갖추지 못한 경우에만 쓴다.
func (s *Server) apiLSPInstall(w http.ResponseWriter, r *http.Request) {
	if !s.lspReady(w) {
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, lspMaxBody))
	if err != nil {
		writeToolIOError(w, http.StatusBadRequest, "bad request")
		return
	}
	var req lspInstallReq
	if err := json.Unmarshal(body, &req); err != nil || req.ID == "" {
		writeToolIOError(w, http.StatusBadRequest, "id required")
		return
	}
	writeJSON(w, s.LSP.Install(r.Context(), req.ID))
}
