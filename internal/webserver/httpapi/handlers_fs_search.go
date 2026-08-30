package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// /api/fs/{find,grep} — Editor 창의 파일 이름 찾기와 전체 내용 찾기
// (EDITOR_GIT_UX_SRS 묶음 F·G).
//
// 루트 가드는 `fsRoot` 를 그대로 딛는다 (FR-EQO-2 · FR-EGS-2, D-3). Editor
// 목록에 등록된 루트만 통과하므로 경로 이탈 방어를 새로 쓰지 않는다 — 새 가드는
// 새 구멍이다.

const (
	// 이름 찾기와 내용 찾기의 기본 상한. 화면에 뿌릴 수 있는 양을 넘으면
	// 사용자가 질의를 좁히는 편이 빠르다.
	fsFindLimit = 300
	fsGrepLimit = 500

	// FR-EGS-5: 이보다 큰 파일은 훑지 않는다. 한 파일이 응답 전체를 잡아먹지
	// 않게 하는 상한이다.
	fsGrepMaxBytes = 2 << 20

	// 한 줄이 이보다 길면 잘라서 싣는다. 압축된 번들 한 줄이 수 MB 인 경우가 있다.
	fsGrepMaxLine = 400
)

// 어느 구현으로 훑었는지 (FR-EGS-3). 결과 차이 — 특히 ripgrep 의 .gitignore
// 존중 — 를 사용자가 설명할 수 있어야 한다.
const (
	grepEngineRipgrep = "ripgrep"
	grepEngineGo      = "go"
)

// fsSkipDirs 는 이름 찾기와 내용 찾기가 **함께** 딛는 제외 목록이다 (D-5).
// 두 벌로 두면 한쪽만 바뀌고, 그 어긋남은 "왜 이름으로는 찾히는데 내용으로는
// 안 찾히는가"로 나타난다.
var fsSkipDirs = map[string]bool{
	".git":         true,
	".hg":          true,
	".svn":         true,
	"node_modules": true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
	"target":       true,
	".next":        true,
	".venv":        true,
	"__pycache__":  true,
	".idea":        true,
	".DS_Store":    true,
}

// fsSearchQuery 는 두 종단이 공유하는 인자 해석이다. 빈 질의를 거부하는 것이
// 핵심이다 — 그것을 통과시키면 저장소 전체를 뱉는 요청이 된다.
func (s *Server) fsSearchQuery(w http.ResponseWriter, r *http.Request, defLimit int) (root, q string, limit int, ok bool) {
	root, ok = s.fsRoot(w, r.URL.Query().Get("root"))
	if !ok {
		return "", "", 0, false
	}
	q = r.URL.Query().Get("q")
	if q == "" {
		fsFail(w, fsErrBadRequest, "q 가 없다")
		return "", "", 0, false
	}
	limit = defLimit
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < defLimit {
			limit = n
		}
	}
	return root, q, limit, true
}

// GET /api/fs/find — 이름이 q 에 맞는 파일의 상대경로 (FR-EQO-1).
func (s *Server) apiFSFind(w http.ResponseWriter, r *http.Request) {
	root, q, limit, ok := s.fsSearchQuery(w, r, fsFindLimit)
	if !ok {
		return
	}
	files, truncated, err := findFiles(r.Context(), root, q, limit)
	if err != nil {
		fsFailErr(w, fsFromOS(err))
		return
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"root": root, "files": files, "truncated": truncated,
	})
}

type fsFindHit struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// findFiles 는 root 아래를 훑어 상대경로가 q 를 품는 파일을 모은다.
//
// 심링크를 따라가지 않는다 (FR-EQO-6). `filepath.WalkDir` 은 심링크를 열지 않고
// 항목으로만 보므로 순환이 성립하지 않는다 — 이것이 `filepath.Walk` 대신
// `WalkDir` 을 쓰는 이유의 절반이고, 나머지 절반은 Lstat 를 아끼는 것이다.
func findFiles(ctx context.Context, root, q string, limit int) ([]fsFindHit, bool, error) {
	needle := strings.ToLower(filepath.ToSlash(q))
	out := make([]fsFindHit, 0, 32)
	truncated := false

	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// 읽을 수 없는 가지는 건너뛴다 — 권한 없는 디렉터리 하나가 검색
			// 전체를 실패시키지 않는다.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() {
			if p != root && fsSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		// 심링크는 따라가지 않는다. 가리키는 것이 파일이어도 마찬가지다 —
		// 같은 파일이 두 경로로 나오면 결과가 헷갈린다.
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if !strings.Contains(strings.ToLower(rel), needle) {
			return nil
		}
		if len(out) >= limit {
			truncated = true
			return fs.SkipAll
		}
		out = append(out, fsFindHit{Path: rel, Name: d.Name()})
		return nil
	})
	if err != nil && ctx.Err() != nil {
		return nil, false, err
	}
	return out, truncated, nil
}

// grepMatch 는 두 구현이 함께 내는 결과 형태다 (FR-EGS-4). 부르는 쪽이 어느
// 구현인지 몰라도 되게 한다.
type grepMatch struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
	Text string `json:"text"`
}

// GET /api/fs/grep — 내용이 q 에 맞는 줄 (FR-EGS-1).
func (s *Server) apiFSGrep(w http.ResponseWriter, r *http.Request) {
	root, q, limit, ok := s.fsSearchQuery(w, r, fsGrepLimit)
	if !ok {
		return
	}
	engine := grepEngineGo
	var matches []grepMatch
	var truncated bool
	var err error

	// FR-EGS-3: ripgrep 이 있으면 그것을 쓴다. 실패하면 Go 로 물러선다 —
	// 외부 도구의 사정으로 기능이 서지 않는 것보다 느린 편이 낫다.
	if rg := lookRipgrep(); rg != "" {
		matches, truncated, err = grepWithRipgrep(r.Context(), rg, root, q, limit)
		if err == nil {
			engine = grepEngineRipgrep
		}
	}
	if engine == grepEngineGo {
		matches, truncated, err = grepWithGo(r.Context(), root, q, limit)
		if err != nil {
			fsFailErr(w, fsFromOS(err))
			return
		}
	}
	fsJSON(w, http.StatusOK, map[string]any{
		"root": root, "matches": matches, "truncated": truncated, "engine": engine,
	})
}

// lookRipgrep 은 PATH 의 rg 다. 없으면 빈 문자열이다.
func lookRipgrep() string {
	p, err := exec.LookPath("rg")
	if err != nil {
		return ""
	}
	return p
}

// grepWithRipgrep 은 rg 의 JSON 출력을 읽는다.
//
// 질의는 **인자로만** 넘어간다 (FR-EGS-9, D-4). 셸을 거치지 않으므로 질의에 든
// 메타문자가 명령이 되지 않는다. `--fixed-strings` 로 정규식 해석도 끈다 —
// 사용자가 친 것은 찾을 문자열이지 패턴이 아니다.
func grepWithRipgrep(ctx context.Context, rg, root, q string, limit int) ([]grepMatch, bool, error) {
	args := []string{
		"--json", "--fixed-strings", "--ignore-case",
		"--max-filesize", strconv.Itoa(fsGrepMaxBytes),
		// FR-EGS-7: 제외 목록은 find 와 같은 한 벌에서 온다.
		"--no-follow",
	}
	for name := range fsSkipDirs {
		args = append(args, "--glob", "!"+name+"/")
	}
	args = append(args, "--", q, root)

	cmd := exec.CommandContext(ctx, rg, args...)
	out, err := cmd.Output()
	// rg 는 "찾은 것 없음"에 1 을 낸다. 그것은 오류가 아니다.
	if err != nil && len(out) == 0 {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		if ee, ok := err.(*exec.ExitError); !ok || ee.ExitCode() != 1 {
			return nil, false, err
		}
	}
	return parseRipgrepJSON(out, root, limit)
}

// parseRipgrepJSON 은 rg --json 의 줄 단위 이벤트에서 match 만 골라 담는다.
func parseRipgrepJSON(out []byte, root string, limit int) ([]grepMatch, bool, error) {
	matches := make([]grepMatch, 0, 32)
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64*1024), 4<<20)
	for sc.Scan() {
		var ev struct {
			Type string `json:"type"`
			Data struct {
				Path struct {
					Text string `json:"text"`
				} `json:"path"`
				Lines struct {
					Text string `json:"text"`
				} `json:"lines"`
				LineNumber int `json:"line_number"`
				Submatches []struct {
					Start int `json:"start"`
				} `json:"submatches"`
			} `json:"data"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil || ev.Type != "match" {
			continue
		}
		if len(matches) >= limit {
			return matches, true, nil
		}
		rel, err := filepath.Rel(root, ev.Data.Path.Text)
		if err != nil {
			continue
		}
		col := 1
		if len(ev.Data.Submatches) > 0 {
			col = ev.Data.Submatches[0].Start + 1
		}
		matches = append(matches, grepMatch{
			Path: filepath.ToSlash(rel),
			Line: ev.Data.LineNumber,
			Col:  col,
			Text: clipLine(strings.TrimRight(ev.Data.Lines.Text, "\r\n")),
		})
	}
	return matches, false, nil
}

// grepWithGo 는 ripgrep 이 없을 때의 폴백이다 (FR-EGS-3). 형태는 같다.
func grepWithGo(ctx context.Context, root, q string, limit int) ([]grepMatch, bool, error) {
	needle := strings.ToLower(q)
	matches := make([]grepMatch, 0, 32)
	truncated := false

	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() {
			if p != root && fsSkipDirs[d.Name()] {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil || info.Size() > fsGrepMaxBytes {
			return nil
		}
		blob, rerr := os.ReadFile(p)
		if rerr != nil || isBinary(blob) {
			return nil
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		for i, line := range strings.Split(string(blob), "\n") {
			idx := strings.Index(strings.ToLower(line), needle)
			if idx < 0 {
				continue
			}
			if len(matches) >= limit {
				truncated = true
				return fs.SkipAll
			}
			matches = append(matches, grepMatch{
				Path: rel,
				Line: i + 1,
				Col:  idx + 1,
				Text: clipLine(strings.TrimRight(line, "\r")),
			})
		}
		return nil
	})
	if err != nil && ctx.Err() != nil {
		return nil, false, err
	}
	return matches, truncated, nil
}

// isBinary 는 앞부분에 NUL 이 있으면 이진으로 본다 — git 과 같은 판정이다
// (FR-EGS-5).
func isBinary(blob []byte) bool {
	head := blob
	if len(head) > 8000 {
		head = head[:8000]
	}
	return bytes.IndexByte(head, 0) >= 0
}

// clipLine 은 화면에 실을 수 있는 만큼만 남긴다. 압축된 번들 한 줄이 수 MB 다.
func clipLine(s string) string {
	if len(s) <= fsGrepMaxLine {
		return s
	}
	return s[:fsGrepMaxLine]
}

// itoaGrep 은 테스트가 결과를 키로 묶을 때 쓴다.
func itoaGrep(n int) string { return strconv.Itoa(n) }
