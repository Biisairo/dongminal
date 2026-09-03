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

	"dongminal/internal/webserver/domain/lsp"
)

// lspMaxBody 는 상태·설치 요청 본문의 상한이다. 절대경로 표 몇 줄이 들어올 자리이며,
// 상한이 없으면 아무 크기나 읽는 종단이 된다.
const lspMaxBody = 64 << 10

// lspAskMaxBody 는 정의·참조 요청의 상한이다. 파일 텍스트가 실리므로(D-3) 훨씬
// 크다 — 도메인 계층의 `MaxTextBytes` 와 짝이며, 그쪽이 실제 판정을 한다.
const lspAskMaxBody = lsp.MaxTextBytes + (64 << 10)

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

// lspAskReq 는 정의·참조가 공유하는 입력이다 (FR-LSP-21~23).
//
// `Text` 가 있는 것이 이 설계의 핵심이다 (D-3) — 저장 전 편집은 브라우저에만
// 있으므로(§2.8) 디스크만 보는 서버는 방금 쓴 함수를 모른다. 저장을 강제하면
// "정의를 보려면 저장하라" 가 되어 요구를 이루지 못한다.
type lspAskReq struct {
	Root string `json:"root"`
	Path string `json:"path"`
	Text string `json:"text"`
	// 줄·열은 **1 부터**다. 편집기가 그렇게 세고, 도메인 계층이 LSP 의 0-기준으로
	// 옮긴다 — 경계가 한 곳이어야 한 줄 위로 뛰는 어긋남이 생기지 않는다.
	Line int `json:"line"`
	Col  int `json:"col"`
	// IncludeDeclaration 은 참조에서만 쓴다 (FR-LSP-22).
	IncludeDeclaration bool `json:"includeDeclaration"`
}

// lspAsk 는 두 종단의 공통 앞부분이다 — 본문을 읽고 루트 가드를 지난다.
//
// 가드가 `fsRoot` 인 것이 규칙이다 (FR-LSP-24·49 / §2.7). 새로 쓰면 두 벌이 되고
// 한쪽만 고쳐진다.
func (s *Server) lspAsk(w http.ResponseWriter, r *http.Request) (lspAskReq, string, bool) {
	var req lspAskReq
	if !s.lspReady(w) {
		return req, "", false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, lspAskMaxBody))
	if err != nil {
		writeToolIOError(w, http.StatusBadRequest, "bad request")
		return req, "", false
	}
	if err := json.Unmarshal(body, &req); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "bad request")
		return req, "", false
	}
	if req.Path == "" {
		writeToolIOError(w, http.StatusBadRequest, "path required")
		return req, "", false
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return req, "", false
	}
	return req, root, true
}

// apiLSPDefinition 은 그 자리의 정의들이다 (FR-LSP-21).
//
// **답하지 못한 이유가 실린다** (FR-LSP-28 / D-9). 침묵은 고장과 구별되지 않으므로,
// 세션이 없거나 서버가 답하지 않은 경우도 200 에 사유를 담아 보낸다 — 화면이
// "왜 아무 일도 안 일어났는가" 를 말할 수 있어야 한다.
func (s *Server) apiLSPDefinition(w http.ResponseWriter, r *http.Request) {
	req, root, ok := s.lspAsk(w, r)
	if !ok {
		return
	}
	locs, err := s.LSP.Definition(r.Context(), root, req.Path, req.Text, req.Line, req.Col)
	writeJSON(w, lspLocsResult(locs, err))
}

// apiLSPReferences 는 그 자리의 참조들이다 (FR-LSP-22).
func (s *Server) apiLSPReferences(w http.ResponseWriter, r *http.Request) {
	req, root, ok := s.lspAsk(w, r)
	if !ok {
		return
	}
	locs, err := s.LSP.References(r.Context(), root, req.Path, req.Text, req.Line, req.Col,
		req.IncludeDeclaration)
	writeJSON(w, lspLocsResult(locs, err))
}

// lspLocsResult 는 두 종단의 응답 모양이다.
//
// 오류를 상태 코드로 알리지 않는 이유는 설치 종단과 같다 — 화면이 사유를 읽어
// 보여야 하고, 그 사유가 곧 이 기능의 절반이다 (D-9).
func lspLocsResult(locs []lsp.Location, err error) map[string]any {
	out := map[string]any{"locations": locs}
	if locs == nil {
		out["locations"] = []lsp.Location{}
	}
	if err != nil {
		out["reason"] = err.Error()
	}
	return out
}
