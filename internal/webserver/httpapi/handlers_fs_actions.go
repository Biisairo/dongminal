package httpapi

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// 파일 트리 메뉴의 답 (SERVER_DRIVEN_ACTIONS_SRS 묶음 F-1 · FR-SDA-50·51).
//
// 답과 실행 거절은 같은 함수를 부른다 (D-SDA-6). 삭제는 `fsDeleteAnswer`, 이름 바꾸기·
// 이동은 `fsMoveAnswer` 로 거절한다.

type fsActionsReq struct {
	Root  string   `json:"root"`
	Paths []string `json:"paths"`
}

// POST /api/fs/actions — `paths[0]` 은 메뉴를 연 행이다. 이름 바꾸기·옮기기·복사는 그
// 행 하나를, 삭제는 `paths` 전부를 판정한다 (F-a). `count` 는 대상 폴더들 안의 항목 수다
// (F-b) — 참인 답은 `args` 를 싣지 않으므로(FR-SDA-1) 답 밖에 싣는다.
func (s *Server) apiFSActions(w http.ResponseWriter, r *http.Request) {
	var req fsActionsReq
	if !fsDecode(w, r, &req) {
		return
	}
	if len(req.Paths) == 0 {
		fsFail(w, fsErrBadRequest, "paths 가 비었다")
		return
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return
	}
	targets := make([]string, 0, len(req.Paths))
	for _, p := range req.Paths {
		target, ok := fsTargetIn(w, root, p)
		if !ok {
			return
		}
		targets = append(targets, target)
	}
	del, count := s.fsDeleteAnswer(root, targets, s.limits.fsDelete)
	move := s.fsMoveAnswer(root, targets[0])
	fsJSON(w, http.StatusOK, map[string]any{
		"actions": map[string]action.Answer{
			action.FSRename: move,
			action.FSMove:   move,
			action.FSCopy:   fsCopyAnswer(targets[0]),
			action.FSDelete: del,
		},
		"count": count,
	})
}

// fsProtectAnswer 는 루트 자신·다른 Editor 루트·홈·파일시스템 루트를 거절한다
// (FR-EDT-114 · FR-SDA-51). 지워지거나 옮겨지면 되돌릴 수 없는 자리다.
func (s *Server) fsProtectAnswer(root, target string) action.Answer {
	if target == root {
		return fsDeny(apierr.CodeEditorRootProtected, nil)
	}
	if filepath.Dir(target) == target {
		return fsDeny(apierr.CodeFilesystemRootProtected, nil)
	}
	if s.Entries == nil {
		return action.Allow()
	}
	if home, err := s.Entries.Home(); err == nil && target == home {
		return fsDeny(apierr.CodeHomeProtected, nil)
	}
	// **다른** Editor 루트도 대상이 아니다. 중첩된 행(`/a` 와 `/a/b`)이 있을 때 `root=/a`
	// 로 `/a/b` 를 지우면, 사용자가 지운 적 없는 행의 창과 그 아래 전부가 사라진다.
	if roots, err := s.Entries.Roots(); err == nil {
		for _, r := range roots {
			if r == target {
				return fsDeny(apierr.CodeEditorRootProtected, nil)
			}
		}
	}
	return action.Allow()
}

// fsMoveAnswer 는 이름 바꾸기·옮기기의 출발지 판정이다: 보호 → 있는가.
func (s *Server) fsMoveAnswer(root, target string) action.Answer {
	return action.First(s.fsProtectAnswer(root, target), fsCopyAnswer(target))
}

// fsCopyAnswer 는 원본이 있는가다. 링크는 따라가지 않는다 — 링크 자체를 다룬다.
func fsCopyAnswer(target string) action.Answer {
	if _, err := os.Lstat(target); err != nil {
		return fsErrAnswer(fsFromOS(err))
	}
	return action.Allow()
}

// fsDeleteAnswer 는 대상마다 보호 → 항목 수를 본다. 수는 대상마다 max+1 에서 멈춘다.
// 둘째 값은 대상들 **안의** 항목 수의 합이다(대상 자신은 세지 않는다).
func (s *Server) fsDeleteAnswer(root string, targets []string, max int) (action.Answer, int) {
	total := 0
	for _, target := range targets {
		if a := s.fsProtectAnswer(root, target); !a.OK {
			return a, 0
		}
		n, err := fsCountEntries(target, max)
		if err != nil {
			return fsErrAnswer(err), 0
		}
		if n > max {
			return fsTooMany(max), 0
		}
		total += n - 1
	}
	return action.Allow(), total
}

func fsTooMany(max int) action.Answer {
	return fsDeny(apierr.CodeTooManyEntries, map[string]any{"max": max})
}

// fsErrAnswer 는 파일 표면의 오류를 답으로 옮긴다. 코드와 상태는 그 표면의 표를 따른다.
func fsErrAnswer(err error) action.Answer {
	code := fsErrIO
	var fe fsError
	if errors.As(err, &fe) {
		code = fe.code
	}
	return fsDeny(code, nil)
}

// fsDeny 는 파일 표면의 거짓인 답이다. 상태는 코드의 표(`apierr.FSStatus`)가 정한다 —
// 답의 상태와 거절의 상태가 한 자리에서 나온다.
func fsDeny(code string, args map[string]any) action.Answer {
	return action.Deny(fsStatus(code), code, args)
}

// fsRejectAnswer 는 거짓인 답으로 실행 요청을 거절한다 (F-e). 파일 표면의 방언(`code`)을
// 지키되 서버 문구(`message`)는 싣지 않는다 (D-SDA-5).
func fsRejectAnswer(w http.ResponseWriter, a action.Answer) {
	body := map[string]any{"code": a.Why}
	if a.Args != nil {
		body["args"] = a.Args
	}
	fsFailBody(w, a.Why, body)
}

type fsNameReq struct {
	Name string `json:"name"`
}

// POST /api/fs/validate-name — 만들기·이름 바꾸기의 이름 하나를 판정한다 (F-i · FR-SDA-53).
func (s *Server) apiFSValidateName(w http.ResponseWriter, r *http.Request) {
	var req fsNameReq
	if !fsDecode(w, r, &req) {
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"actions": map[string]action.Answer{action.FSName: fsNameAnswer(req.Name)},
	})
}

// fsNameAnswer 는 이름 하나의 판정이다. 앞뒤 공백을 지운 뒤 본다. 경로 구분자는 `/` 와
// 이 OS 의 구분자다 — 다른 OS 에서 `\` 는 이름에 쓸 수 있는 글자다.
//
//	이전 동작: 서버는 경로만 받아 `a/b` 를 다른 폴더의 파일로 만들었다 (F-B1)
func fsNameAnswer(name string) action.Answer {
	n := strings.TrimSpace(name)
	switch {
	case n == "":
		return fsDeny(apierr.CodeEmptyName, nil)
	case strings.ContainsRune(n, '/') || strings.ContainsRune(n, filepath.Separator):
		return fsDeny(apierr.CodeNameHasSeparator, nil)
	case n == "." || n == "..":
		return fsDeny(apierr.CodeNameReserved, nil)
	}
	return action.Allow()
}

// fsIntoSelfAnswer 는 디렉터리를 자기 자신이나 자기 하위로 옮기거나 복사하는 것을 막는다
// (FR-EDT-85 · FR-SDA-52). 심볼릭 링크를 푼 실제 경로로 비교한다. 링크는 대상이 아니다 —
// 링크 자체를 다루므로 재귀가 없다.
//
// **서버가 막아야 하는 자리다.** 복사는 막지 않으면 자기가 만든 것을 다시 복사하며
// **무한 재귀**로 디스크를 채운다. 끌어 놓는 동안 화면은 판정하지 않는다 (D-SDA-7).
func fsIntoSelfAnswer(src, dstDir string, st os.FileInfo) action.Answer {
	if !st.IsDir() {
		return action.Allow()
	}
	real, err := filepath.EvalSymlinks(src)
	if err != nil {
		return fsErrAnswer(fsResolveErr(err))
	}
	rel, err := filepath.Rel(real, dstDir)
	if err != nil {
		// 볼륨이 다르면 하위일 수 없다.
		return action.Allow()
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return action.Allow()
	}
	return fsDeny(apierr.CodeIntoSelf, nil)
}
