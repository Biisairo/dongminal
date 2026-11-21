package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/editorlimit"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"dongminal/internal/shared/httpreq"
	"os"
	"path/filepath"

	"dongminal/internal/shared/httpresp"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/textenc"
	"dongminal/internal/webserver/domain/lsp"
)

// 파일 종단의 읽기·쓰기 (/api/file/{read,write}) 와 그 동작 답.

func (s *Server) apiFileRead(w http.ResponseWriter, r *http.Request) {
	// FR-FAB-11: 읽기도 같은 판정이다. 쓰기만 막고 읽기를 열어 두면 SSH 개인키나
	// 클라우드 자격 파일이 그대로 나간다 — 이쪽은 응답을 돌려주므로 오히려 더
	// 직접적이다.
	fp, ok := s.fileGuard(w, r.URL.Query().Get("path"))
	if !ok {
		return
	}
	f, err := os.Open(fp)
	if err != nil {
		httpErr(w, "file not found", http.StatusNotFound, apierr.CodeNotFound)
		return
	}
	defer f.Close()
	// 열렸다고 잴 수 있는 것은 아니다 — 네트워크 파일시스템·경합으로 지워진
	// 파일·EIO 에서 Stat 은 실패한다. 종전에는 오류를 버리고 nil 을 역참조해
	// 패닉했다 (FR-CAF-4).
	stat, err := f.Stat()
	if err != nil {
		dmlog.Errorf(nil, "file stat error: %v", err)
		httpErr(w, "stat failed", http.StatusInternalServerError, apierr.CodeIO)
		return
	}
	if stat.IsDir() {
		httpErr(w, "not a file", http.StatusBadRequest, apierr.CodeNotAFile)
		return
	}
	// FR-FAB-8: 상한을 넘으면 **413** 이고 실제 크기를 실어 보낸다. 클라이언트는
	// 그 숫자로 안내를 만든다 — "너무 큽니다" 만으로는 얼마나 큰지 말할 수 없다.
	if stat.Size() > fileReadMaxBytes {
		httpErrf(w, apierr.CodeTooLarge, fmt.Sprintf("file too large: %d bytes (max %d)", stat.Size(), fileReadMaxBytes),
			http.StatusRequestEntityTooLarge)
		return
	}
	// REPO_FIX 03 §3A-1: `decode=1` 이면 판별해 UTF-8 로 바꿔 보낸다. 없으면 원문이다
	// (FR-CAPI-11 하위호환 — 옛 클라이언트·CLI).
	if r.URL.Query().Get("decode") == "1" {
		s.fileReadDecoded(w, r, f, stat)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	// FR-EXC-11: 표식은 **헤더**로 간다. 본문은 파일 원문이므로(FR-CAPI-11) 실을
	// 자리가 여기뿐이다. `ETag` 를 쓰지 않는 것은 브라우저의 조건부 GET 이 끼어들어
	// 304 를 만들 수 있어서다 — 편집기는 언제나 본문을 받아야 한다.
	w.Header().Set(fileStampHeader, fileStamp(stat))
	// GO-38: **복사의 결과를 버리지 않는다.** 여기서 실패하면 헤더는 이미 나갔으므로
	// 상태 코드를 바꿀 수 없다 — 그래서 할 수 있는 일은 **기록**뿐이고, 기록이
	// 없으면 "파일이 잘려서 왔다" 는 신고에 대고 아무것도 말할 수 없다.
	//
	// 판정 뒤에도 `LimitReader` 를 지난다. `Stat` 과 `Copy` 사이에 파일이 자라는
	// 경우가 있고, 판정만으로는 그 틈이 닫히지 않는다.
	if _, err := io.Copy(w, io.LimitReader(f, fileReadMaxBytes)); err != nil {
		dmlog.Infof(nil, "file read: copy %s: %v", fp, err)
	}
}

type fileWriteReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// REPO_FIX 03 §3A-2: 문서의 인코딩·BOM. Encoding 이 비면 UTF-8 원문 그대로다
	// (하위호환). 편집기 문서 저장은 둘을 언제나 싣는다.
	Encoding string `json:"encoding"`
	BOM      bool   `json:"bom"`
	// FR-EXC-11: 읽을 때 받은 표식. **비어 있으면 검사하지 않는다** (FR-EXC-6a) —
	// 옛 클라이언트와, 확인창에서 사용자가 승인한 덮어쓰기가 그 길로 온다.
	Stamp string `json:"stamp"`
	// X-e · D-SDA-10: UTF-8 변환이면 문서를 연 인코딩이다. 서버가 디스크 바이트로 변환을
	// 판정한다(`convertUTF8Answer`). 비면 일반 저장이다.
	ConvertFrom string `json:"convertFrom"`
}

func (s *Server) apiFileWrite(w http.ResponseWriter, r *http.Request) {
	// OPTIMIZE_REFACTOR_SRS FR-OPT-15-2: 읽을 수 있는 파일은 저장할 수 있어야 한다.
	//	이전 동작: 본문 상한이 `httpreq.DefaultLimit`(1 MiB) — 1~10 MiB 파일은 열리고
	//	          고쳐지지만 저장이 413 이었다
	//	새  동작: 파일 상한을 JSON 문자열로 실은 최악의 크기 (`editorlimit.BodyMaxBytes`)
	body, err := httpreq.Read(w, r, editorlimit.BodyMaxBytes(fileReadMaxBytes))
	if err != nil {
		httpErr(w, "read body", httpreq.Status(err), apierr.BodyReadCode(err))
		return
	}
	var req fileWriteReq
	if err := json.Unmarshal(body, &req); err != nil {
		httpErr(w, "invalid json: "+err.Error(), http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	// FILE_API_BOUNDARY_SRS FR-FAB-1: 허용 루트 아래여야 한다.
	//
	// 종전에는 `IsAbs` 하나만 봤고, 그래서 `~/.ssh/authorized_keys` 를 요청 하나로
	// 덮을 수 있었다 — 응답을 읽을 필요조차 없다.
	target, ok := s.fileGuard(w, req.Path)
	if !ok {
		return
	}
	// REPO_FIX 03 §3A-4: 심링크는 따라가 **대상**에 쓴다 — 링크는 그대로 남는다.
	target = writeTarget(target)
	if req.Encoding != "" && !textenc.Valid(req.Encoding) {
		httpErr(w, "unknown encoding: "+req.Encoding, http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	// REFACTOR3_DEFECTS_SRS FR-RD3-20: 표식 검사부터 새 표식까지 같은 경로는 한 번에 하나다.
	//	이전: 검사와 쓰기 사이에 잠금이 없어, 같은 표식의 저장 여럿이 다 통과하고 뒤가 앞을 덮었다
	defer s.fileWrites.lock(target)()
	// EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-5·7: 우리가 읽은 뒤 디스크가 바뀌었으면
	// 덮지 않는다. 종전에는 **마지막에 저장한 쪽이 이겼다.**
	//
	// 파일이 없을 때는 검사하지 않는다 — 삭제는 경합이 아니라 부재이고, 그때의
	// 저장은 새로 만드는 것이다 (FR-EXC-10a).
	if req.Stamp != "" {
		if cur := stampOfPath(target); cur != "" && cur != req.Stamp {
			httpErr(w, "file changed on disk", http.StatusConflict, apierr.CodeFileChanged)
			return
		}
	}
	// X-e: 변환은 디스크의 바이트로 판정한다. 파일이 없거나 읽지 못하면 판정하지 않는다 —
	// 일반 저장과 같은 길이다.
	if req.ConvertFrom != "" {
		if raw, err := os.ReadFile(target); err == nil {
			if a := convertUTF8Answer(raw, req.ConvertFrom); !a.OK {
				httpErr(w, a.Why, a.Status, a.Why)
				return
			}
		}
	}
	data, perm, un, err := fileWriteBytes(target, req)
	if err != nil {
		httpErr(w, "encode failed: "+err.Error(), http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	if un != nil {
		// §3A-2: 조용한 손실 금지 — 첫 위치를 싣고 아무것도 쓰지 않는다.
		httpresp.Fail(w, http.StatusUnprocessableEntity, apierr.CodeEncodingUnmappable, map[string]any{
			"error": apierr.CodeEncodingUnmappable, "line": un.Line, "col": un.Col, "char": un.Char,
		})
		return
	}
	// 읽기와 같은 상한이다 — 넘는 파일을 쓰게 두면 방금 저장한 파일을 다시 열 수 없다.
	if int64(len(data)) > fileReadMaxBytes {
		httpErrf(w, apierr.CodeTooLarge, fmt.Sprintf("file too large: %d bytes (max %d)", len(data), fileReadMaxBytes),
			http.StatusRequestEntityTooLarge)
		return
	}
	// CODEMIRROR_MIGRATION_SRS FR-CMR-110: 열리지 않은 파일의 변경 알림은 새 파일과 있던 파일을 가른다.
	_, statErr := os.Stat(target)
	existed := statErr == nil
	// 원자적으로 쓴다 (FR-CAF-11). 여기서 잘리는 것은 우리 상태 파일이 아니라
	// **사용자가 쓰던 원본**이다 — 편집기의 저장이 이 종단이다.
	if err := platform.WriteFileAtomic(target, data, perm); err != nil {
		dmlog.Errorf(nil, "file write error: %v", err)
		httpErr(w, "write failed", http.StatusInternalServerError, apierr.CodeIO)
		return
	}
	if s.LSP != nil {
		typ := lsp.WatchCreated
		if existed {
			typ = lsp.WatchChanged
		}
		// FR-CMR-110: 그 경로가 루트 아래인 통로에 알린다. 통로의 줄에 넣을 뿐 기다리지 않는다.
		s.LSP.NotifyFiles([]lsp.FileEvent{{Path: target, Type: typ}})
	}
	// FR-EXC-11: **새 표식을 함께 준다.** 없으면 클라이언트가 든 표식이 방금 쓴
	// 내용보다 낡아서, 다음 저장이 제 손으로 만든 변경에 걸려 409 가 된다 —
	// 한 번 저장하면 그 뒤로 아무것도 저장되지 않는다는 뜻이다.
	// X-e: 방금 쓴 바이트의 답을 함께 준다 — 변환 뒤 메뉴가 낡지 않는다.
	httpresp.JSON(w, http.StatusOK, map[string]any{"ok": true, "stamp": stampOfPath(target),
		"actions": fileActions(data, req.Encoding)})
}

// fileReadDecoded 는 §3A-1 의 판별·변환 읽기다. `encoding=` 이 있으면 그것으로 엄격
// 디코드하고, 실패하면 422 encoding_undecodable 이다(파일·문서는 그대로).
func (s *Server) fileReadDecoded(w http.ResponseWriter, r *http.Request, f *os.File, stat os.FileInfo) {
	raw, err := io.ReadAll(io.LimitReader(f, fileReadMaxBytes))
	if err != nil {
		dmlog.Errorf(nil, "file read error: %v", err)
		httpErr(w, "read failed", http.StatusInternalServerError, apierr.CodeIO)
		return
	}
	var d textenc.Decoded
	if want := r.URL.Query().Get("encoding"); want != "" {
		got, ok := textenc.DecodeAs(raw, want)
		if !ok {
			httpErr(w, "cannot decode as "+want, http.StatusUnprocessableEntity, apierr.CodeEncodingUndecodable)
			return
		}
		d = got
	} else {
		d = textenc.Detect(raw)
	}
	h := w.Header()
	h.Set("Content-Type", "text/plain; charset=utf-8")
	h.Set(fileStampHeader, fileStamp(stat))
	h.Set("X-File-Encoding", d.Enc)
	h.Set("X-File-BOM", boolFlag(d.BOM))
	h.Set("X-File-Decodable", boolFlag(d.Decodable))
	h.Set(fileActionsHeader, fileActionsJSON(raw, d.Enc))
	_, _ = io.WriteString(w, d.Text)
}

// fileActionsHeader 는 읽기 응답이 문서의 동작 답을 싣는 헤더다 (SERVER_DRIVEN_ACTIONS_SRS X-e).
// 본문은 문서 내용이므로 실을 자리가 헤더뿐이다.
const fileActionsHeader = "X-File-Actions"

// convertUTF8Answer 는 UTF-8 변환의 판정이다 (X-e · D-SDA-10). 디스크 바이트를 문서를 연
// 인코딩(`from`)으로 엄격 디코드한다 — 해독하지 못한 문서를 저장하면 치환 문자가 그대로 쓰인다.
// 읽기·저장 응답의 답과 `convertFrom` 저장의 거절이 이 함수 하나를 부른다.
func convertUTF8Answer(raw []byte, from string) action.Answer {
	d, ok := textenc.DecodeAs(raw, from)
	if !ok {
		return action.Deny(http.StatusUnprocessableEntity, apierr.CodeEncodingUndecodable, nil)
	}
	if d.Enc == textenc.UTF8 && !d.BOM {
		return action.Deny(http.StatusConflict, apierr.CodeAlreadyUTF8, nil)
	}
	return action.Allow()
}

// fileActions 는 문서 하나의 동작 답이다.
func fileActions(raw []byte, enc string) map[string]action.Answer {
	if enc == "" {
		enc = textenc.UTF8
	}
	return map[string]action.Answer{action.FileConvertUTF8: convertUTF8Answer(raw, enc)}
}

func fileActionsJSON(raw []byte, enc string) string {
	b, _ := json.Marshal(fileActions(raw, enc))
	return string(b)
}

func boolFlag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// writeTarget 은 쓰기 대상이다 (§3A-4). 심링크면 대상 파일, 끊어진 링크면 링크가
// 가리키는 경로(상대면 링크 디렉터리 기준)다. 경계는 쓰기 종단과 같다 — 절대경로면
// 허용한다(허용 루트 가드는 없다, 이전 동작 = 새 동작).
func writeTarget(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		return real
	}
	fi, err := os.Lstat(p)
	if err != nil || fi.Mode()&os.ModeSymlink == 0 {
		return p
	}
	dest, err := os.Readlink(p)
	if err != nil {
		return p
	}
	if !filepath.IsAbs(dest) {
		dest = filepath.Join(filepath.Dir(p), dest)
	}
	return filepath.Clean(dest)
}

// fileWriteBytes 는 쓸 바이트와 권한이다 (§3A-2·3A-4). 기존 파일은 그 권한 비트를
// 보존하고 문서의 인코딩으로 되돌려 쓴다. 새 파일은 0644·UTF-8·BOM 없음이다.
//
//	이전 동작: 언제나 0644·UTF-8 원문 — 실행 비트·0600 이 사라졌고 CP949·UTF-16
//	          파일이 UTF-8 로 바뀌었으며, 심링크는 일반 파일로 대체됐다
//	새  동작: 권한·인코딩·BOM·링크 보존, 표현할 수 없으면 거절
//	이유:     저장 한 번이 파일의 성질을 조용히 바꿨다 (#7 #8)
func fileWriteBytes(target string, req fileWriteReq) ([]byte, os.FileMode, *textenc.Unmappable, error) {
	st, err := os.Stat(target)
	if err != nil {
		return []byte(req.Content), 0o644, nil, nil
	}
	perm := st.Mode().Perm()
	if req.Encoding == "" {
		return []byte(req.Content), perm, nil, nil
	}
	data, un, err := textenc.Encode(req.Content, req.Encoding, req.BOM)
	return data, perm, un, err
}
