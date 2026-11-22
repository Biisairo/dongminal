package httpapi

import (
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"fmt"
	"net/http"

	"dongminal/internal/shared/httpreq"
	"os"

	"dongminal/internal/shared/httpresp"
)

// 파일 종단의 표식 — 저장 경합을 가르는 X-File-Stamp 와 여러 파일의 표식 조회.

// EDITOR_EXTERNAL_CHANGE_SRS FR-EXC-11 — 저장의 경합을 가릴 **표식**.
//
// 클라이언트에게는 **불투명한 문자열**이다. 읽기가 헤더로 주고 저장이 본문으로
// 되돌려 보내며, 견주는 것은 서버뿐이다 (FR-EXC-6) — 판정을 클라이언트에 두면 두
// 창이 같은 파일을 볼 때 서로 다른 답을 갖는다.
//
// 지금의 재료는 mtime(나노초)+크기이고 `os.Stat` 한 번이라 싸다. 정밀도가 모자란
// 파일시스템이 문제가 되면 내용 해시로 바꾼다 — **그때 클라이언트는 한 줄도 바뀌지
// 않는다.** 불투명하게 두는 값이 그것이다.
const fileStampHeader = "X-File-Stamp"

func fileStamp(fi os.FileInfo) string {
	return fmt.Sprintf("%x-%x", fi.ModTime().UnixNano(), fi.Size())
}

// stampOfPath 는 지금 디스크의 표식이다. 파일이 없으면 빈 문자열이며, 그것은
// **경합이 아니다** (FR-EXC-10a) — 덮어쓸 상대가 없다.
func stampOfPath(p string) string {
	fi, err := os.Stat(p)
	if err != nil || fi.IsDir() {
		return ""
	}
	return fileStamp(fi)
}

// EDITOR_LIVE_RELOAD_SRS 묶음 E — 열어 둔 파일들이 바뀌었는지 **한 번에** 묻는다
// (FR-ELR-1~7).
//
// **왜 read 가 아닌가.** 편집기가 "밖에서 바뀌었나" 를 알려면 지금은 파일을 통째로
// 다시 받는 수밖에 없다 — 열린 탭이 열이면 주기마다 열 번의 전문 전송이다. 이
// 종단은 그 물음을 요청 하나로 접고, 클라이언트는 답을 자기가 든 표식과 견주어
// **달라진 파일만** 다시 읽는다. 변화가 없는 회차의 비용은 `os.Stat` 몇 번이다.
//
// **왜 `/api/fs/stamp` 로는 안 되는가.** 그쪽은 **겹**의 것이고, 그 파일의 머리말이
// 적어 두었다 — *"파일 내용만 바뀐 것은 겹의 mtime 을 움직이지 않는다."* 편집기가
// 보는 것이 바로 그 내용이다.
//
// 표식은 `/api/file/read` 와 **같은 함수**에서 나온다 (FR-ELR-2). 갈리면 읽을 때
// 기억한 값과 여기서 견주는 값이 어긋나 매 회차가 변경으로 읽힌다.

// fileStampsMax 는 한 요청이 볼 수 있는 파일 수다 (FR-ELR-6). 열어 둔 탭의 수이므로
// 현실적으로는 수십이며, 상한은 그 꼬리를 자르는 자리다 — 없으면 한 요청이
// 서버에서 무한정 stat 한다. 값이 `fsStampMax` 와 같은 것은 우연이 아니다: 같은
// 성질의 상한이다.
const fileStampsMax = 512

type fileStampsReq struct {
	Paths []string `json:"paths"`
}

func (s *Server) apiFileStamps(w http.ResponseWriter, r *http.Request) {
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		httpErr(w, "read body", httpreq.Status(err), apierr.BodyReadCode(err))
		return
	}
	var req fileStampsReq
	if err := json.Unmarshal(body, &req); err != nil {
		httpErr(w, httpreq.Message(r, "invalid json", err), http.StatusBadRequest, apierr.CodeInvalidJSON)
		return
	}
	if len(req.Paths) > fileStampsMax {
		httpErr(w, fmt.Sprintf("too many paths (max %d)", fileStampsMax), http.StatusBadRequest, apierr.CodeBadRequest)
		return
	}
	httpresp.JSON(w, http.StatusOK, map[string]any{"stamps": s.fileStampsIn(req.Paths)})
}

// fileStampsIn 은 파일들의 표식이다. `/api/file/stamps` 와 `/api/fs/stamps` 가 같은
// 함수를 지난다 (FR-ELR-2 와 같은 근거).
func (s *Server) fileStampsIn(paths []string) map[string]string {
	stamps := make(map[string]string, len(paths))
	for _, p := range paths {
		// FR-ELR-4: 판정은 **읽기와 같다.** 읽을 수 없는 파일의 표식도 줄 수 없다 —
		// 그것도 그 파일이 언제 바뀌었는지를 말한다.
		//
		// FR-ELR-5: 통과하지 못한 경로·없는 파일·디렉터리는 **빠진다.** 오류가
		// 아니다 — 한 경로의 사정이 나머지의 답을 막으면, 루트 밖의 파일 하나를
		// 열어 둔 것만으로 열린 파일 전부의 관측이 멎는다.
		target, den := s.fileAllow(p)
		if den != nil {
			continue
		}
		if st := stampOfPath(target); st != "" {
			// FR-ELR-3: 키는 **클라이언트가 보낸 경로 그대로**다. 해석된 경로로
			// 답하면 심링크를 지난 파일에서 짝지을 수 없다.
			stamps[p] = st
		}
	}
	return stamps
}
