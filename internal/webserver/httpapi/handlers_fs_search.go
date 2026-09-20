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
// fsWalkFiles 는 두 검색 구현이 공유하는 순회다 (DRIFT_RECLAIM_SRS FR-DRC-11).
//
// 정책이 여기 하나로 있다: 읽을 수 없는 가지는 건너뛰고, 취소는 즉시 올리고,
// `fsSkipDirs` 는 통째로 자르고, 심링크는 따라가지 않는다. 이전에는 이 다섯이
// `findFiles` 와 `grepWithGo` 에 각각 적혀 있었고 — **한쪽에만 새 스킵 규칙이
// 들어가면 파일 찾기와 내용 찾기가 서로 다른 트리를 보게 된다.**
//
// visit 은 일반 파일 하나마다 불린다. `rel` 은 root 기준의 슬래시 경로이며 —
// 구분자 규칙을 두 벌로 두면 Windows 에서 어긋난다 — 순회가 계산해 넘긴다.
// visit 이 false 를 돌려주면 거기서 끝낸다 (한도 도달).
func fsWalkFiles(ctx context.Context, root string, visit func(path, rel string, d fs.DirEntry) bool) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
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
		if visit(p, filepath.ToSlash(rel), d) {
			return nil
		}
		return fs.SkipAll
	})
}

func findFiles(ctx context.Context, root, q string, limit int) ([]fsFindHit, bool, error) {
	needle := strings.ToLower(filepath.ToSlash(q))
	out := make([]fsFindHit, 0, 32)
	truncated := false

	err := fsWalkFiles(ctx, root, func(_, rel string, d fs.DirEntry) bool {
		if !strings.Contains(strings.ToLower(rel), needle) {
			return true
		}
		if len(out) >= limit {
			truncated = true
			return false
		}
		out = append(out, fsFindHit{Path: rel, Name: d.Name()})
		return true
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

// grepReadBuf 는 줄 단위로 훑을 때의 읽기 버퍼다. 한 줄이 이보다 길면
// `bufio` 가 알아서 늘린다 — 파일 자체가 `fsGrepMaxBytes` 이하이므로 상한은 그것이다.
const grepReadBuf = 64 << 10

// grepWithGo 는 ripgrep 이 없을 때의 폴백이다 (FR-EGS-3). 형태는 같다.
//
// PERFORMANCE_HARDENING_SRS FR-PRF-58~60 (`AUDIT-go-http.md` P-4):
//
//	이전 동작: 파일당 ① `os.ReadFile` 로 최대 2MiB ② `string(blob)` 로 같은 크기
//	          한 번 더 ③ `strings.Split` 로 줄 수만큼의 string 헤더
//	새  동작: `os.Open` + 줄 단위. 상주 메모리가 O(파일크기) → O(줄길이)
//	이유:     ripgrep 이 없는 환경의 **기본 경로**다 (Windows·최소 컨테이너).
//	          파일 5,000개 트리를 훑으면 GB 단위 할당이 GC 를 때렸다
//
// **이진 판정이 전량 읽기보다 앞선다.** 종전에는 앞 8,000바이트만 보는 판정을
// 하려고 파일 전체를 먼저 읽었다 — 이진 파일일수록 헛일이 컸다. `Peek` 은 버퍼가
// 채워진 만큼만 본다.
//
// **조각 내는 규칙은 한 글자도 바뀌지 않았다.** `\n` 이 구분자이므로 마지막 개행
// 뒤에도 (빈) 조각이 하나 있고, 빈 파일도 조각 하나다 — `strings.Split` 과 같다.
// `Col` 은 `\r` 을 떼기 **전** 줄에서의 자리이며 그것도 그대로다 (FR-PRF-59).
//
//	이전 동작: 읽다 실패하면 그 파일의 결과가 **하나도** 없었다 (`ReadFile` 이 실패)
//	새  동작: 그때까지 찾은 것은 남는다
//	이유:     줄 단위로 읽으면 앞부분은 이미 정확히 읽은 것이다. 버리면 "찾았는데
//	          안 보인다" 가 되고, 그 사실을 알릴 자리도 이 종단에는 없다
func grepWithGo(ctx context.Context, root, q string, limit int) ([]grepMatch, bool, error) {
	needle := strings.ToLower(q)
	matches := make([]grepMatch, 0, 32)
	truncated := false
	// 되쓰는 버퍼 둘. **줄마다 새로 잡으면 바이트는 줄어도 할당 수가 폭발한다** —
	// 첫 판이 정확히 그랬다 (538 → 160,419 allocs/op, §8 의 기록).
	var lower, long []byte

	err := fsWalkFiles(ctx, root, func(p, rel string, d fs.DirEntry) bool {
		info, ierr := d.Info()
		if ierr != nil || info.Size() > fsGrepMaxBytes {
			return true
		}
		f, oerr := os.Open(p)
		if oerr != nil {
			return true
		}
		defer f.Close()
		br := bufio.NewReaderSize(f, grepReadBuf)
		// 짧은 파일은 `Peek` 이 오류와 함께 있는 만큼을 준다 — 그것이 정상이다.
		head, _ := br.Peek(8000)
		if isBinary(head) {
			return true
		}
		// **오류를 따로 보지 않는다.** `ReadSlice` 가 구분자 없이 돌아오는 경우는
		// 버퍼가 찼거나(긴 줄) EOF 이거나 읽기 오류이고, 앞의 하나만 이어 붙이면
		// 나머지 둘은 *"이것이 마지막 조각이다"* 로 같다.
		for lineNo := 1; ; lineNo++ {
			line, rerr := br.ReadSlice('\n')
			for rerr == bufio.ErrBufferFull {
				long = append(long[:0], line...)
				for rerr == bufio.ErrBufferFull {
					line, rerr = br.ReadSlice('\n')
					long = append(long, line...)
				}
				line = long
			}
			nl := len(line) > 0 && line[len(line)-1] == '\n'
			if nl {
				line = line[:len(line)-1]
			}
			if idx := grepIndexFold(line, needle, &lower); idx >= 0 {
				if len(matches) >= limit {
					truncated = true
					return false
				}
				matches = append(matches, grepMatch{
					Path: rel,
					Line: lineNo,
					Col:  idx + 1,
					Text: clipLine(strings.TrimRight(string(line), "\r")),
				})
			}
			// 개행 없이 끝난 조각이 마지막이다. 그 앞에서 멎으면 `strings.Split` 이
			// 내던 마지막 (빈) 조각이 사라진다.
			if !nl {
				break
			}
		}
		return true
	})
	if err != nil && ctx.Err() != nil {
		return nil, false, err
	}
	return matches, truncated, nil
}

// grepIndexFold 는 `strings.Index(strings.ToLower(string(line)), needle)` 와
// **같은 답**을 내되, 줄마다 사본을 만들지 않는다 (FR-PRF-60).
//
// 줄이 순수 ASCII 면 소문자화가 바이트 길이를 바꾸지 않으므로, 되쓰는 버퍼에
// 접어 넣고 `bytes.Index` 를 쓴다 — 자리도 길이도 같다.
//
// **ASCII 가 아니면 종전 경로로 물러선다.** 유니코드 소문자화는 길이를 바꿀 수
// 있고(`İ` → 두 룬), 그러면 `Col` 이 달라진다. 그 자리의 동작이 옳은지는 이
// 묶음의 물음이 아니다 — **바꾸지 않는 것**이 물음이다 (FR-PRF-8).
func grepIndexFold(line []byte, needle string, buf *[]byte) int {
	ascii := true
	for _, c := range line {
		if c >= 0x80 {
			ascii = false
			break
		}
	}
	if !ascii {
		return strings.Index(strings.ToLower(string(line)), needle)
	}
	b := append((*buf)[:0], line...)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + ('a' - 'A')
		}
	}
	*buf = b
	return bytes.Index(b, []byte(needle))
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
