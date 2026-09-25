package httpapi

import (
	"errors"
	"net/http"
	"os"
	"strconv"

	"dongminal/internal/shared/dmlog"
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

// fsStampsTreesMax 는 `/api/fs/stamps` 한 요청이 볼 수 있는 루트 수다. 화면에 선
// 탐색기의 루트이므로 현실적으로는 한 자리 수다 — 상한은 루트마다 `fsStampMax` 겹을
// 곱해 한 요청이 무한정 stat 하지 않게 하는 자리다.
const fsStampsTreesMax = 16

type fsStampsReq struct {
	Trees []fsStampReq `json:"trees"`
	Paths []string     `json:"paths"`
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
	fsJSON(w, http.StatusOK, map[string]any{"stamps": fsStampsIn(root, req.Dirs)})
}

// fsStampsIn 은 확정된 root 아래 겹들의 스탬프다. `/api/fs/stamp` 와
// `/api/fs/stamps` 가 같은 함수를 지난다 (FR-FSL-10 과 같은 근거).
func fsStampsIn(root string, dirs []string) map[string]string {
	stamps := make(map[string]string, len(dirs))
	for _, d := range dirs {
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
	return stamps
}

// POST /api/fs/stamps — 겹 스탬프와 파일 표식을 **한 요청**으로 묻는다
// (OPTIMIZE_REFACTOR_SRS FR-OPT-4-2 · IPC-8).
//
//	이전 동작: 편집기 틱마다 보이는 루트당 `/api/fs/stamp` 하나 + `/api/file/stamps` 하나
//	새  동작: 틱당 이 요청 하나. 두 옛 종단은 그대로 둔다 — 옛 화면이 부른다
//	이유:     둘은 같은 틱의 같은 물음("바뀌었나")이고 답의 비용은 stat 몇 번이다
//
// 루트마다 판정이 따로다 — 한 루트가 거부돼도 다른 루트와 파일의 답은 나간다. 거부는
// 그 루트의 자리에 `{code, status}` 로 실린다. 옛 종단이 상태 코드로 말하던 것과 같은
// 값이라 클라이언트가 같은 규칙(4xx 는 굳힌다, FR-FSL-12)을 적용한다.
func (s *Server) apiFSStamps(w http.ResponseWriter, r *http.Request) {
	var req fsStampsReq
	if !fsDecode(w, r, &req) {
		return
	}
	if len(req.Trees) > fsStampsTreesMax {
		fsFail(w, fsErrBadRequest, "trees 가 너무 많다")
		return
	}
	if len(req.Paths) > fileStampsMax {
		fsFail(w, fsErrBadRequest, "paths 가 너무 많다")
		return
	}
	trees := make(map[string]any, len(req.Trees))
	for _, t := range req.Trees {
		trees[t.Root] = s.fsStampsTree(t)
	}
	fsJSON(w, http.StatusOK, map[string]any{"trees": trees, "paths": s.fileStampsIn(req.Paths)})
}

func (s *Server) fsStampsTree(t fsStampReq) map[string]any {
	if len(t.Dirs) > fsStampMax {
		return fsStampsDenied(fsErrBadRequest)
	}
	root, err := s.fsRootOf(t.Root)
	if err != nil {
		var fe fsError
		if !errors.As(err, &fe) {
			dmlog.Infof(nil, "fs 오류 %s: %v", fsErrIO, err)
			return fsStampsDenied(fsErrIO)
		}
		return fsStampsDenied(fe.code)
	}
	return map[string]any{"stamps": fsStampsIn(root, t.Dirs)}
}

func fsStampsDenied(code string) map[string]any {
	return map[string]any{"code": code, "status": fsStatus(code)}
}
