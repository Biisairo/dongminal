package httpapi

import (
	"net/http"
	"os"
	"strconv"
)

// POST /api/fs/stamp — 겹이 바뀌었는지만 값싸게 답한다
// (NOTES_LIVE_EXPLORER_SRS 묶음 L, FR-FSL-1~5).
//
// **왜 list 가 아닌가.** 탐색기가 "바뀌었나" 를 알려면 지금은 겹 전체를 다시 받는
// 수밖에 없다 — 펼친 폴더가 열 개면 주기마다 열 번의 목록 조회다. 이 종단은 그
// 물음을 한 번의 요청으로 접는다: 클라이언트는 답을 견주어 **달라진 겹만** 다시
// 읽으므로 요청 수가 겹 수가 아니라 **변경 수**에 비례한다 (D-5).
//
// **왜 mtime 인가.** 겹의 mtime 은 그 안의 항목이 더해지거나 지워지거나 이름이
// 바뀔 때 반드시 움직인다 — 목록이 바뀌는 경우의 전부다. 파일 **내용**만 바뀐
// 것은 겹의 mtime 을 움직이지 않지만 그때는 목록도 그대로이므로 다시 읽을 이유가
// 없다 (그 변화는 git 색이 말한다).
//
// 루트 가드는 조회·조작과 같다 (FR-EDT-112·113). 새 가드는 새 구멍이다.

// fsStampMax 는 한 요청이 볼 수 있는 겹의 수다 (FR-FSL-5). 화면에 펼쳐진 폴더의
// 수이므로 현실적으로는 수십이며, 상한은 그 꼬리를 자르는 자리다 — 없으면 한
// 요청이 서버에서 무한정 stat 한다.
const fsStampMax = 512

type fsStampReq struct {
	Root string   `json:"root"`
	Dirs []string `json:"dirs"`
}

// fsStampOf 는 한 겹의 스탬프다. **문자열**인 이유는 JSON 의 수가 float64 로
// 오가기 때문이다 — 나노초가 정밀도를 잃으면, 클라이언트가 같은지만 보는
// 값(FR-FSL-2)이 그 손실로 같아져 변경을 통째로 놓친다.
//
// `apiFSList` 도 이것을 쓴다 (FR-FSL-10). 두 종단이 **같은 함수**를 지나야 조회로
// 기억한 값과 폴링으로 견주는 값이 어긋나지 않는다 — 갈라지면 매 주기가 변경으로
// 읽혀 목록을 끝없이 다시 읽는다.
func fsStampOf(st os.FileInfo) string {
	return strconv.FormatInt(st.ModTime().UnixNano(), 10)
}

func (s *Server) apiFSStamp(w http.ResponseWriter, r *http.Request) {
	var req fsStampReq
	if !fsDecode(w, r, &req) {
		return
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return
	}
	if len(req.Dirs) > fsStampMax {
		fsFail(w, fsErrBadRequest, "dirs 가 너무 많다")
		return
	}
	stamps := make(map[string]string, len(req.Dirs))
	for _, d := range req.Dirs {
		// 루트 밖·사라진 겹·파일은 **빠진다.** 오류가 아니다 — 한 겹의 사정이
		// 나머지 겹의 답을 막지 않는다 (FR-EDT-63 과 같은 근거).
		target, err := fsResolveExisting(root, d)
		if err != nil {
			continue
		}
		st, err := os.Stat(target)
		if err != nil || !st.IsDir() {
			continue
		}
		// 키는 **클라이언트가 보낸 경로 그대로**다. 해석된 경로로 답하면
		// 심볼릭 링크를 지난 겹에서 키가 어긋나 클라이언트가 자기 캐시와
		// 짝지을 수 없다.
		stamps[d] = fsStampOf(st)
	}
	fsJSON(w, http.StatusOK, map[string]any{"stamps": stamps})
}
