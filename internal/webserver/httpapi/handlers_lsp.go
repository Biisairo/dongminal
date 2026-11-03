// 묶음 A — 편집기 코드 탐색의 서버 계층이다 (EDITOR_LSP_SRS §3.1).
//
// **여기에는 LSP 가 없다.** 프로토콜과 언어 서버 프로세스는 도메인 패키지의 것이며
// (D-4), 이 파일은 요청을 그 표면(`LSPService`)으로 옮기고 결과를 JSON 으로 낸다.
// 방향은 샌드박스와 같다 — httpapi 는 컨테이너 런타임을 알지 않는다.
package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/lsp"
)

// lspMaxBody 는 상태·설치 요청 본문의 상한이다. 절대경로 표 몇 줄이 들어올 자리이며,
// 상한이 없으면 아무 크기나 읽는 종단이 된다.
const lspMaxBody = 64 << 10

// lspReadBody 는 본문을 상한까지 읽는다. 실패하면 답하고 false 다.
//
// **한 바이트 더 읽어 초과를 가린다** (OPTIMIZE_REFACTOR_SRS FR-OPT-1-10).
// 종전에는 `LimitReader(r.Body, max)` 가 조용히 잘라, 상한을 넘은 본문이 잘린
// JSON 이 되어 400 'bad request' 로 나갔다. 상한값과 이 표면이 `httpreq` 를
// 지나지 않는다는 결정(`httpreq/body.go`)은 그대로다 — 바뀐 것은 초과의 보고뿐이다.
func lspReadBody(w http.ResponseWriter, r *http.Request, max int64) ([]byte, bool) {
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		writeToolIOError(w, http.StatusBadRequest, "bad request")
		return nil, false
	}
	if int64(len(body)) > max {
		writeToolIOError(w, http.StatusRequestEntityTooLarge, "body too large")
		return nil, false
	}
	return body, true
}

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

// lspInstallReq 의 ID 는 **팩**이다 (FR-EXT-31) — 조달의 단위가 그것이다.
type lspInstallReq struct {
	ID string `json:"id"`
}

// apiLSPStatus 는 서술자마다 한 줄의 관측을 낸다 (FR-LSP-5·46·47).
func (s *Server) apiLSPStatus(w http.ResponseWriter, r *http.Request) {
	if !s.lspReady(w) {
		return
	}
	// REPO_FIX 02 §3A-3: 요청은 경로를 싣지 않는다(FR-LSP-4b 개정) — 서버가 보관한
	// 경로 표로 해석한다. 본문은 읽지 않는다(옛 화면이 보내도 무시된다).
	//	이전 동작: 본문의 overrides(브라우저 localStorage)로 조회했다
	//	새  동작: 서버 표 — 세션 기동과 같은 값
	servers, problems := s.LSP.Status()
	out := map[string]any{"servers": servers}
	// FR-EXT-8: 읽지 못한 선언이 있으면 그 사실을 싣는다. 조용히 빠지면 사용자는
	// 자기가 고친 파일이 무시된 이유를 알 수 없다.
	if len(problems) > 0 {
		out["problems"] = problems
	}
	writeJSON(w, out)
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
	body, ok := lspReadBody(w, r, lspMaxBody)
	if !ok {
		return
	}
	var req lspInstallReq
	if err := json.Unmarshal(body, &req); err != nil || req.ID == "" {
		writeToolIOError(w, http.StatusBadRequest, "id required")
		return
	}
	writeJSON(w, s.LSP.Install(r.Context(), req.ID))
}

// lspPathsBody 는 경로 표의 조회·저장 본문이다 (REPO_FIX 02 §3A-3).
type lspPathsBody struct {
	Paths map[string]string `json:"paths"`
}

// apiLSPPathsGet 은 서버가 보관한 실행 파일 경로 표다 — 없으면 빈 객체다.
func (s *Server) apiLSPPathsGet(w http.ResponseWriter, r *http.Request) {
	if !s.lspReady(w) {
		return
	}
	p := s.LSP.Paths()
	if p == nil {
		p = map[string]string{}
	}
	writeJSON(w, lspPathsBody{Paths: p})
}

// apiLSPPathsPut 은 경로 표 전체를 바꾼다. 값이 바뀐 서술자의 세션·실패 기억은
// 서비스가 무효화한다. 거부는 코드로 가른다 — 화면이 그 행에 사유를 보인다.
func (s *Server) apiLSPPathsPut(w http.ResponseWriter, r *http.Request) {
	if !s.lspReady(w) {
		return
	}
	body, ok := lspReadBody(w, r, lspMaxBody)
	if !ok {
		return
	}
	var req lspPathsBody
	if json.Unmarshal(body, &req) != nil {
		lspFail(w, http.StatusBadRequest, apierr.CodeBadRequest, "bad request")
		return
	}
	out, err := s.LSP.SetPaths(req.Paths)
	switch {
	case errors.Is(err, lsp.ErrUnknownServer):
		lspFail(w, http.StatusBadRequest, apierr.CodeBadRequest, err.Error())
	case errors.Is(err, lsp.ErrPathNotAbsolute):
		lspFail(w, http.StatusBadRequest, apierr.CodeAbsPathNeeded, err.Error())
	case err != nil:
		dmlog.Errorf(nil, "[lsp] 경로 표 저장 실패: %v", err)
		lspFail(w, http.StatusInternalServerError, apierr.CodeSaveFailed, "경로 표를 저장하지 못했다")
	default:
		writeJSON(w, lspPathsBody{Paths: out})
	}
}

// lspFail 은 이 표면의 단문 방언(`{"error": 문구}`)에 코드를 헤더로 싣는다 —
// 상태에서 코드를 고르면 path_must_be_absolute 가 bad_request 로 뭉개진다.
func lspFail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set(apierr.CodeHeader, code)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
