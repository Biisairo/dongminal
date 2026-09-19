package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"
	"net/http"
	"path/filepath"
)

// `/api/file/*` 의 입력 계약 (FILE_API_BOUNDARY_SRS).
//
// **경계는 없다** (2026-09-20, 사용자 결정). 이 파일의 이름이 말하던 일 — 허용 루트
// 대조 · 홈 쓰기 금지 · git `repo` 검사 — 은 전부 폐기됐고, 남은 것은 입력 형식
// 검사와 상한값뿐이다.
//
// 종전에는 이렇게 적혀 있었다: *"`requestGate` 가 그 요청의 호출을 닫는다. 여기는
// 닿는 범위를 닫는다. 게이트 하나에 전부 걸면, 게이트가 언젠가 새는 날 파일시스템
// 전체가 함께 샌다."* **그 배치를 걷어냈다** — 이제 게이트가 새면 파일시스템
// 전체가 함께 샌다. 그 사실은 `SECURITY.md` §4-5 에 적혀 있다.

// fileReadMaxBytes 는 `/api/file/{read,raw}` 가 내보내는 한 파일의 상한이다
// (FR-FAB-8). **10 MiB** 다 — Monaco 가 실용적으로 다루는 상한선이며, 그 위의
// 파일에는 터미널과 다운로드라는 길이 이미 있다.
//
// 값을 클라이언트가 따로 들고 있지 않다. `/api/file/probe` 가 이 값을 실어 보내고
// 편집기는 그것으로 판정한다 (FR-FAB-9) — 상수가 두 벌이면 언젠가 한쪽만 고쳐지고,
// 그때 사용자는 "열린다고 했는데 안 열린다" 를 만난다.
//
// var 인 것은 테스트가 낮춰 쓰기 위해서다 (`zipMaxBytes` 와 같은 관례).
var fileReadMaxBytes int64 = 10 << 20

// fileDenial 은 판정이 거절한 까닭이다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-8).
//
// **응답을 쓰지 않는다.** 경로가 여럿인 종단은 한 경로의 거절로 요청 전체를 무르게
// 할 수 없고(FR-ELR-5), 그러려면 판정과 응답이 갈려 있어야 한다.
type fileDenial struct {
	status int
	code   string
	msg    string
	// log 가 비어 있지 않으면 요청 정보와 함께 기록한다.
	//
	// **지금 이것을 채우는 자리는 없다.** 경계가 사라지면서 기록할 거절도 함께
	// 사라졌다 — 남은 둘(빈 경로·상대경로)은 형식 오류라 사후 추적의 대상이
	// 아니다. 통로를 남겨 두는 것은 `fileGuard` 의 모양을 지키기 위해서다.
	log string
}

// fileAllow 는 경로를 받아 그대로 돌려준다 — **경계가 없다** (2026-09-20).
//
// 종전에는 허용 루트 대조 · 홈 쓰기 금지 · `fileApiUnrestricted` 스위치가 여기
// 있었다. 사용자 결정으로 전부 폐기했다 (FILE_API_BOUNDARY_SRS 머리, 묶음 B·W·O).
// 접수한 말 그대로다: *"그냥 파일에 대한 가드를 없애자. 없던걸로."*
//
// **남은 둘은 경계가 아니라 계약이다.** 빈 경로와 상대경로는 이 종단이 해석할 수
// 없는 입력이므로 400 이다 — 거절이 아니라 형식 오류이고, 그래서 남는다.
//
// 이 함수가 서 있는 이유도 그것뿐이다. 호출처 넷(`probe`·`read`·`raw`·`write`)이
// 같은 형식 검사를 각자 적지 않게 한다.
func (s *Server) fileAllow(p string, _ bool) (string, *fileDenial) {
	if p == "" {
		return "", &fileDenial{http.StatusBadRequest, apierr.CodeMissingArg, "missing path", ""}
	}
	if !filepath.IsAbs(p) {
		return "", &fileDenial{http.StatusBadRequest, apierr.CodeAbsPathNeeded, "path must be absolute", ""}
	}
	return p, nil
}

// fileGuard 는 `fileAllow` 의 판정에 **응답까지** 붙인 꼴이다. 종단 넷이 같은
// 형식 검사와 같은 오류 응답을 각자 적지 않게 한다.
func (s *Server) fileGuard(w http.ResponseWriter, r *http.Request, p string, forWrite bool) (string, bool) {
	got, den := s.fileAllow(p, forWrite)
	if den == nil {
		return got, true
	}
	if den.log != "" {
		dmlog.Infof(nil, "file %s addr=%s %s path=%q", den.log, r.RemoteAddr, r.Method, p)
	}
	httpErr(w, den.msg, den.status, den.code)
	return "", false
}
