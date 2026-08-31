package httpapi

import (
	"dongminal/internal/webserver/apierr"

	"bytes"
	"context"
	"net/http"
	"os/exec"
	"strings"
	"time"
)

// POST /api/fs/ignored — 탐색기의 한 겹에서 무시된 이름을 가른다
// (EXPLORER_TRANSFER_IGNORE_SRS 묶음 A, FR-ETR-1~4).
//
// **왜 status 가 아니라 check-ignore 인가.** `/api/git/status` 는 `--ignored` 를
// 일부러 주지 않는다(그 argv 를 고정한 테스트가 있다). 거기에 무시를 얹으면 3초
// 폴링이 큰 저장소에서 무거워지고, 화면에 보이지도 않는 겹까지 판정하게 된다.
// 이쪽은 **보고 있는 겹의 이름만** 묻는다 — 비용이 화면에 비례한다 (D-1).
//
// 루트 가드는 조회·조작과 같다 (FR-EDT-112·113). 새 가드는 새 구멍이다.

// fsErrNotRepo 는 "이 경로로는 무시 여부를 물을 수 없다" 는 답이다. 404 로
// 나가야 하며(fsStatus 의 표), 그것은 클라이언트가 **4xx 를 판정으로 굳히기**
// 때문이다 — 5xx 로 새면 3초마다 영영 다시 묻는다 (FR-ETR-4).
const fsErrNotRepo = apierr.CodeFSNotRepo

// checkIgnoreTimeout 은 판정 하나에 허용하는 시간이다. 탐색기가 겹을 펼칠 때마다
// 도는 경로이므로 멈춘 git 하나가 화면을 붙잡지 않아야 한다.
const checkIgnoreTimeout = 10 * time.Second

// git 의 종료 코드. `check-ignore` 는 **1 을 "무시된 것 없음" 으로 쓴다** —
// 실패가 아니다 (FR-ETR-3). 이것을 모르면 정상이 오류가 된다.
const (
	checkIgnoreFound = 0
	checkIgnoreNone  = 1
)

type fsIgnoredReq struct {
	Root  string   `json:"root"`
	Dir   string   `json:"dir"`
	Names []string `json:"names"`
}

func (s *Server) apiFSIgnored(w http.ResponseWriter, r *http.Request) {
	var req fsIgnoredReq
	if !fsDecode(w, r, &req) {
		return
	}
	root, ok := s.fsRoot(w, req.Root)
	if !ok {
		return
	}
	dir, err := fsResolveExisting(root, req.Dir)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	// FR-ETR-1: 받는 것은 **한 겹의 이름**이지 경로가 아니다. 경로를 받으면 dir
	// 밖을 판정하게 되고, 그것은 루트 가드를 지나지 않은 판정이다.
	for _, n := range req.Names {
		if n == "" || n == "." || n == ".." ||
			strings.ContainsAny(n, `/\`) {
			fsFail(w, fsErrBadRequest, "names 는 한 겹의 이름이어야 한다")
			return
		}
	}
	// 빈 stdin 에 대한 check-ignore 의 답을 해석하지 않는다 — 물을 것이 없으면
	// 답도 없다.
	if len(req.Names) == 0 {
		fsJSON(w, http.StatusOK, map[string]any{"ignored": []string{}})
		return
	}
	ignored, err := checkIgnore(r.Context(), dir, req.Names)
	if err != nil {
		fsFailErr(w, err)
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{"ignored": ignored})
}

// checkIgnore 는 `git -C <dir> check-ignore -z --stdin` 한 번으로 겹 전체를
// 판정한다 (FR-ETR-2).
//
// `--no-index` 를 **주지 않는다.** 기본 판정은 추적 중인 파일을 무시로 보지
// 않으며, 그것이 VS Code 의 표시와 같다 (D-3) — 요구가 "VS Code 와 동일" 이다.
//
// 이름은 인자가 아니라 stdin 으로 간다. 인자로 넘기면 겹 하나가 수천 개일 때
// argv 길이 한계에 걸리고, `-` 로 시작하는 이름이 옵션으로 읽힌다.
func checkIgnore(ctx context.Context, dir string, names []string) ([]string, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		// git 이 없으면 무시 여부를 알 수 없다. 색을 못 칠할 뿐이므로 조회
		// 자체를 죽이지 않고 "저장소가 아니다" 와 같은 답을 준다 — 클라이언트는
		// 둘 다 "다시 묻지 않는다" 로 처리한다 (FR-ETR-4).
		return nil, fsError{fsErrNotRepo, "git 을 찾을 수 없다"}
	}
	ctx, cancel := context.WithTimeout(ctx, checkIgnoreTimeout)
	defer cancel()

	var in bytes.Buffer
	for _, n := range names {
		in.WriteString(n)
		in.WriteByte(0)
	}
	cmd := exec.CommandContext(ctx, bin, "check-ignore", "-z", "--stdin")
	cmd.Dir = dir
	cmd.Stdin = &in
	var out, errBuf bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errBuf

	runErr := cmd.Run()
	if ctx.Err() != nil {
		return nil, fsError{fsErrIO, "check-ignore 가 시간 안에 끝나지 않았다"}
	}
	switch code := exitCodeOf(runErr); code {
	case checkIgnoreFound:
		return splitNUL(out.String()), nil
	case checkIgnoreNone:
		// FR-ETR-3: 무시된 것이 하나도 없다는 **답**이다.
		return []string{}, nil
	default:
		// 128 은 저장소가 아니거나 그 밖의 치명적 실패다. 사유를 그대로 싣지
		// 않는다 — stderr 에 서버의 절대경로가 실린다 (FR-FTR-3 과 같은 근거).
		return nil, fsError{fsErrNotRepo, "저장소가 아니거나 무시 여부를 물을 수 없다"}
	}
}

// exitCodeOf 는 종료 코드를 꺼낸다. 실행 자체가 실패한 것(바이너리 없음 등)은
// 128 로 접는다 — 호출자에게는 "치명적 실패" 로 같다.
func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return 128
}

// splitNUL 은 NUL 로 끝나는 레코드들을 가른다. `-z` 의 출력은 마지막 레코드
// **뒤에도** NUL 이 붙으므로 마지막 빈 조각을 버린다.
func splitNUL(s string) []string {
	parts := strings.Split(s, "\x00")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
