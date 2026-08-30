package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/webserver/domain/git/core"
)

// verify 는 **종단간** 검증이다 — 서버를 데몬 모드로 띄우고 그 위의 HTTP 표면을
// 실제로 두드린다. doctor 와 겹치지 않는다: doctor 는 서버 **없이** 플랫폼 계층을
// in-process 로 보고, verify 는 프로세스 경계를 넘은 뒤를 본다
// (E2E_UNIFICATION_SRS §5-2).
//
// 세 대상이 **같은 목록**을 돈다. OS 마다 갈리는 것은 platform 인터페이스 아래에서
// 이미 흡수되므로, 이 파일에는 대상별 갈래가 하나도 없다 (FR-E2S-0/2). 본보기는
// 검사 2다 — Windows 의 AF_UNIX 종단은 소켓 비트가 서지 않지만 호출부는 그 사실을
// 모른 채 socketExists 하나를 부른다.

const (
	verifyReadyTries    = 40
	verifyReadyInterval = 500 * time.Millisecond
	verifyHTTPTimeout   = 15 * time.Second
	verifyCols          = 120
	verifyRows          = 40
	// verifyMarker 는 왕복 검사가 셸에 시키고 되받을 표시다. 현행 CI 와 같은 값을
	// 승계한다 (D-5).
	verifyMarker = "dongminal-e2e-ok"
	// verifyShellWait·verifyShellQuiet 는 "셸이 프롬프트를 그렸다" 로 볼 조건이다.
	// 고정 대기를 쓰지 않는다 — 대상마다 셸 기동 시간이 다르고, 고정 대기가 실제로
	// 플레이크를 냈다 (FR-E2K-2).
	verifyShellWait  = 20 * time.Second
	verifyShellQuiet = 700 * time.Millisecond
	verifyPollEvery  = 100 * time.Millisecond
	verifyRoundTrip  = 30 * time.Second
	// verifyTermGrace 는 정중한 종료를 기다리는 시간이다.
	verifyTermGrace = 3 * time.Second
	verifyLogTail   = 40
	// verifyCapsTimeout 은 능력 실측 하나의 상한이다.
	verifyCapsTimeout = 10 * time.Second
)

// newVerifyClient 는 검사가 쓰는 HTTP 클라이언트다.
func newVerifyClient() *http.Client { return &http.Client{Timeout: verifyHTTPTimeout} }

// ── 격리 가드 ────────────────────────────────────────────────────────
//
// verify-isolated.sh 에만 있던 가드를 Go 로 옮긴 것이다. 옮기면 세 대상이 그
// 가드를 공유한다 (§2.2 D-4).

// guardIsolated 는 대상이 격리 인스턴스인지 판정한다 (FR-E2G-1).
//
// **순수 함수다** — 프로세스도 파일시스템도 건드리지 않는다. 그래서 위험한 조합을
// 프로세스를 하나도 띄우지 않고 단위테스트로 전부 막을 수 있다. 이 판정을
// 통과하기 전에 verify 는 아무것도 띄우지 않고 아무것도 지우지 않는다 (FR-E2G-2).
//
// userHome 이 비면 그 조항만 건너뛴다 — 홈을 알아내지 못한 것이 가드 전체를
// 무르게 하는 근거가 될 수는 없다.
func guardIsolated(home, port, userHome string) error {
	switch {
	case home == "":
		return errors.New("격리 홈이 비어 있습니다")
	case port == "":
		return errors.New("포트가 비어 있습니다")
	case !strings.HasPrefix(filepath.Base(home), isolatedHomePrefix):
		return fmt.Errorf("홈이 격리 홈이 아닙니다: %s", home)
	case userHome != "" && filepath.Clean(home) == filepath.Join(userHome, dmenv.DefaultHomeDir):
		return fmt.Errorf("홈이 사용자 기본 홈입니다: %s", home)
	case port == dmenv.DefaultPort:
		return fmt.Errorf("포트가 기본 포트 %s 입니다 — 운영 인스턴스일 수 있습니다", port)
	}
	return nil
}

// ── 능력 질의 ────────────────────────────────────────────────────────

// verifyCaps 는 **호스트 환경**이 무엇을 갖췄는지다. OS 의 능력이 아니다 — OS
// 차이는 platform 인터페이스 아래에서 흡수되므로 여기 올라오지 않는다 (FR-E2S-3).
type verifyCaps struct {
	// GitBin 은 git 이 PATH 에 있는지다.
	GitBin bool
	// GitRepo 는 검사 대상 디렉터리가 git 저장소인지다.
	GitRepo bool
}

// probeCaps 는 호스트의 능력을 실측한다.
//
// git 을 직접 실행하지 않는다 — 실행은 webserver/domain/git 안에서만 한다
// (FR-GIT-1). 저장소 판정도 그 도메인의 것을 딛는다: "저장소인가" 의 답이 검사와
// 서버에서 갈리면 건너뜀 판정이 서버 응답과 어긋나, 정당한 404 를 결함으로
// 읽거나 그 반대가 된다 (FR-E2K-4).
func probeCaps(repo string) verifyCaps {
	ctx, cancel := context.WithTimeout(context.Background(), verifyCapsTimeout)
	defer cancel()
	_, err := core.New().RepoRoot(ctx, repo)
	switch {
	case err == nil:
		return verifyCaps{GitBin: true, GitRepo: true}
	case errors.Is(err, core.ErrGitMissing):
		return verifyCaps{}
	default:
		return verifyCaps{GitBin: true}
	}
}

// ── 검사 정의 ────────────────────────────────────────────────────────

// verifySession 은 검사가 딛는 상태다.
type verifySession struct {
	base string
	home string
	repo string
	pid  int
	caps verifyCaps
	http *http.Client
	// toolID 는 검사 4가 채운다. 비어 있으면 뒤따르는 도구 검사가 선행 실패로
	// 건너뛴다 (FR-E2K-6).
	toolID string
}

// verifyCheck 는 검사 하나의 정의다.
//
// **데이터로 적는다** (NFR-E2E-4). 절차로 흩어 적으면 목록을 세는 일이 불가능해지고,
// 그러면 "세 대상이 같은 목록을 돈다" 를 확인할 수단이 사라진다 (FR-E2I-6).
type verifyCheck struct {
	Section string
	Name    string
	// Need 는 이 검사가 돌 수 있는 조건이다. nil 이면 언제나 돈다. 돌 수 없으면
	// 이유를 내며, 그 이유는 보고서에 남는다 (FR-E2S-4).
	Need func(*verifySession) (bool, string)
	// Run 은 통과했을 때 보고서에 덧붙일 상세를 함께 낸다. 비면 이름만 찍는다.
	//
	// 상세가 있는 이유는 "통과했다" 만으로는 드러나지 않는 것이 있기 때문이다 —
	// 자산이 49개에서 3개로 줄어도 전량 200 이면 검사는 통과한다. 수를 남기면
	// 그 후퇴가 로그에서 보인다.
	Run func(*verifySession) (string, error)
}

func needTool(s *verifySession) (bool, string) {
	if s.toolID == "" {
		return false, "도구 생성이 실패해 물을 것이 없다"
	}
	return true, ""
}

func needGitRepo(s *verifySession) (bool, string) {
	if !s.caps.GitBin {
		return false, "git 이 PATH 에 없다"
	}
	if !s.caps.GitRepo {
		// 비-git 디렉터리는 ErrNotRepo 로 **정당하게** 404 라서 라우팅 누락과
		// 구별되지 않는다. 그러면 이 검사가 아무것도 보증하지 않는다 (FR-E2K-4).
		return false, fmt.Sprintf("대상이 git 저장소가 아니다: %s", s.repo)
	}
	return true, ""
}

// wantStatus 는 경로를 두드려 기대 코드인지 본다.
func wantStatus(want int, path func(*verifySession) string) func(*verifySession) (string, error) {
	return func(s *verifySession) (string, error) {
		p := path(s)
		code, err := s.status(p)
		if err != nil {
			return "", fmt.Errorf("%s: %w", p, err)
		}
		if code != want {
			return "", fmt.Errorf("want %d, got %d [%s]", want, code, p)
		}
		return "", nil
	}
}

func at(p string) func(*verifySession) string {
	return func(*verifySession) string { return p }
}

func gitAt(endpoint string) func(*verifySession) string {
	return func(s *verifySession) string {
		return "/api/git/" + endpoint + "?repo=" + url.QueryEscape(s.repo)
	}
}

// verifyChecks 는 검사 전량이다 — 현행 세 하네스(darwin 21항목 · CI 종단간
// 5단계)의 **합집합**이며, 세 대상이 이 한 목록을 돈다 (FR-E2K-1).
func verifyChecks() []verifyCheck {
	checks := []verifyCheck{
		// ── 기동 표면 ──
		{Section: "기동 표면", Name: "서버 프로세스 생존", Run: func(s *verifySession) (string, error) {
			if !procCtl().Alive(s.pid) {
				return "", fmt.Errorf("pid %d 가 살아 있지 않다", s.pid)
			}
			return "", nil
		}},
		{Section: "기동 표면", Name: "데몬 종단 생성 (paned.sock)", Run: func(s *verifySession) (string, error) {
			if !socketExists(s.home) {
				return "", fmt.Errorf("종단이 없다: %s", s.home)
			}
			return "", nil
		}},
		{Section: "기동 표면", Name: "/api/ping", Run: wantStatus(http.StatusOK, at("/api/ping"))},

		// ── 도구 — PTY + IPC 왕복 ──
		{Section: "도구 — PTY + IPC 왕복", Name: "도구 생성", Run: (*verifySession).createTool},
		{Section: "도구 — PTY + IPC 왕복", Name: "/api/state 에 도구가 보인다", Need: needTool, Run: (*verifySession).toolInState},
		{Section: "도구 — PTY + IPC 왕복", Name: "busy 조회", Need: needTool, Run: func(s *verifySession) (string, error) {
			return wantStatus(http.StatusOK, at("/api/tools/"+s.toolID+"/busy"))(s)
		}},
		{Section: "도구 — PTY + IPC 왕복", Name: "도구 출력 조회", Need: needTool, Run: func(s *verifySession) (string, error) {
			return wantStatus(http.StatusOK, at("/api/tools/output?id="+url.QueryEscape(s.toolID)+"&bytes=1024"))(s)
		}},
		{Section: "도구 — PTY + IPC 왕복", Name: "입력→출력 왕복", Need: needTool, Run: (*verifySession).roundTrip},

		// ── 워크스페이스·설정 ──
		{Section: "워크스페이스·설정", Name: "/api/workspace", Run: wantStatus(http.StatusOK, at("/api/workspace"))},
		{Section: "워크스페이스·설정", Name: "/api/stats", Run: wantStatus(http.StatusOK, at("/api/stats"))},
		{Section: "워크스페이스·설정", Name: "/api/settings", Run: wantStatus(http.StatusOK, at("/api/settings"))},
	}

	// ── git 읽기 표면 ──
	// repo 인자를 받는 것만 저장소를 요구한다. policy·jobs 는 인자가 없으므로
	// 언제나 돈다 (FR-E2S-3).
	for _, e := range []string{"status", "log", "refs", "signature", "stash", "records"} {
		checks = append(checks, verifyCheck{
			Section: "git 읽기 표면",
			Name:    "git " + e,
			Need:    needGitRepo,
			Run:     wantStatus(http.StatusOK, gitAt(e)),
		})
	}
	checks = append(checks,
		verifyCheck{Section: "git 읽기 표면", Name: "git policy", Run: wantStatus(http.StatusOK, at("/api/git/policy"))},
		verifyCheck{Section: "git 읽기 표면", Name: "git jobs", Run: wantStatus(http.StatusOK, at("/api/git/jobs"))},
		verifyCheck{Section: "git 읽기 표면", Name: "없는 git 경로 404", Run: wantStatus(http.StatusNotFound, at("/api/git/no-such-endpoint"))},

		// ── 정적 자산 ──
		verifyCheck{Section: "정적 자산", Name: "index.html 의 script 전량 200", Run: (*verifySession).staticAssets},
		verifyCheck{Section: "정적 자산", Name: "구 평면 경로 /js/app.js 404", Run: wantStatus(http.StatusNotFound, at("/js/app.js"))},
	)
	return checks
}

// ── 검사 구현 ────────────────────────────────────────────────────────

func (s *verifySession) status(path string) (int, error) {
	resp, err := s.http.Get(s.base + path)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode, nil
}

func (s *verifySession) body(path string) (string, error) {
	resp, err := s.http.Get(s.base + path)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	blob, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("want 200, got %d [%s]", resp.StatusCode, path)
	}
	return string(blob), nil
}

// createTool 은 도구를 만든다. cwd·cols·rows 는 쿼리 파라미터로 간다 (바디 아님).
// cols·rows 에 0 을 주면 Windows 의 CreatePseudoConsole 이 E_INVALIDARG 로 실패한다.
func (s *verifySession) createTool() (string, error) {
	q := fmt.Sprintf("/api/tools?cwd=%s&cols=%d&rows=%d", url.QueryEscape(s.repo), verifyCols, verifyRows)
	resp, err := s.http.Post(s.base+q, "application/json", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	blob, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("want 200, got %d — %s", resp.StatusCode, strings.TrimSpace(string(blob)))
	}
	id := jsonStringField(string(blob), "id")
	if id == "" {
		return "", fmt.Errorf("도구 id 를 받지 못했다 — %s", strings.TrimSpace(string(blob)))
	}
	s.toolID = id
	return "id=" + id, nil
}

func (s *verifySession) toolInState() (string, error) {
	body, err := s.body("/api/state")
	if err != nil {
		return "", err
	}
	if !strings.Contains(body, s.toolID) {
		return "", fmt.Errorf("/api/state 에 %s 가 없다", s.toolID)
	}
	return "", nil
}

// roundTrip 은 셸에 명령을 넣고 그 출력에서 표시를 되받는다. 데몬 안의 의사
// 터미널이 실제로 입출력을 왕복해야만 통과한다 — 이 트랙이 겨누는 결함이 정확히
// 그 자리에서 났다 (CROSS_PLATFORM_SRS §11.6).
func (s *verifySession) roundTrip() (string, error) {
	if err := s.waitToolQuiet(verifyShellWait, verifyShellQuiet); err != nil {
		return "", err
	}
	body := fmt.Sprintf(`{"id":%s,"text":%s,"execute":true}`,
		jsonQuote(s.toolID), jsonQuote("echo "+verifyMarker))
	resp, err := s.http.Post(s.base+"/api/tools/input", "application/json", strings.NewReader(body))
	if err != nil {
		return "", err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("입력 전송 실패: %d", resp.StatusCode)
	}

	deadline := time.Now().Add(verifyRoundTrip)
	var seen string
	for time.Now().Before(deadline) {
		time.Sleep(verifyPollEvery)
		out, err := s.toolOutput()
		if err != nil {
			continue
		}
		seen = out
		// 표시를 두 번 본다 — 한 번은 타이핑된 명령 자체이고, 두 번째가 셸이
		// 실행해 낸 출력이다. 한 번만 보고 통과시키면 에코만으로 통과한다.
		if strings.Count(seen, verifyMarker) >= 2 {
			return fmt.Sprintf("%d바이트", len(seen)), nil
		}
	}
	// 몇 번 보였는지를 함께 남긴다. 0 이면 셸이 명령을 받지 못한 것이고, 1 이면
	// 에코만 보이고 **실행 결과가 없는** 것이다 — 그 둘은 원인이 전혀 다르다.
	return "", fmt.Errorf("출력에서 %s 를 %d번 보았다 (2번이어야 한다: 에코 + 실행 결과, 받은 %d바이트)",
		verifyMarker, strings.Count(seen, verifyMarker), len(seen))
}

func (s *verifySession) toolOutput() (string, error) {
	return s.body("/api/tools/output?id=" + url.QueryEscape(s.toolID) + "&strip=1")
}

// waitToolQuiet 는 셸이 무언가를 그리고 **조용해질 때까지** 기다린다. doctor 가
// 쓰는 것과 같은 판정이며, 고정 대기를 쓰지 않는 이유는 FR-E2K-2 다.
func (s *verifySession) waitToolQuiet(limit, quiet time.Duration) error {
	deadline := time.Now().Add(limit)
	var last string
	var lastChange time.Time
	for time.Now().Before(deadline) {
		out, err := s.toolOutput()
		if err == nil {
			switch {
			case out != last:
				last, lastChange = out, time.Now()
			case last != "" && time.Since(lastChange) >= quiet:
				return nil
			}
		}
		time.Sleep(verifyPollEvery)
	}
	if last != "" {
		// 계속 변하고 있다 — 그린 것은 있으므로 진행한다.
		return nil
	}
	return errors.New("셸이 아무 것도 그리지 않았다")
}

// staticAssets 는 index.html 이 **실제로 참조하는** script 전량을 두드린다.
// 목록을 손으로 적지 않는다 — 적는 순간 index.html 과 갈라진다 (FR-E2K-3).
func (s *verifySession) staticAssets() (string, error) {
	index, err := s.body("/")
	if err != nil {
		return "", err
	}
	srcs := extractScriptSrcs(index)
	if len(srcs) == 0 {
		return "", errors.New("index.html 에서 script src 를 하나도 찾지 못했다")
	}
	var bad []string
	for _, src := range srcs {
		code, err := s.status("/" + strings.TrimPrefix(src, "/"))
		if err != nil {
			bad = append(bad, fmt.Sprintf("%s (%v)", src, err))
			continue
		}
		if code != http.StatusOK {
			bad = append(bad, fmt.Sprintf("%s → %d", src, code))
		}
	}
	if len(bad) > 0 {
		return "", fmt.Errorf("%d/%d 실패: %s", len(bad), len(srcs), strings.Join(bad, ", "))
	}
	return fmt.Sprintf("%d개", len(srcs)), nil
}

var scriptSrcRe = regexp.MustCompile(`<script[^>]*\bsrc="([^"]+)"`)

// extractScriptSrcs 는 HTML 에서 script 의 src 를 뽑는다. 순수 함수라 모든
// 대상에서 단위테스트가 돈다.
func extractScriptSrcs(html string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range scriptSrcRe.FindAllStringSubmatch(html, -1) {
		src := m[1]
		if src == "" || strings.Contains(src, "://") || seen[src] {
			continue
		}
		seen[src] = true
		out = append(out, src)
	}
	return out
}

// jsonQuote 는 값을 JSON 문자열 리터럴로 만든다 — 바깥 따옴표를 포함한다.
// Windows 경로를 날것으로 끼우면 `\U` 가 유효하지 않은 이스케이프가 되어 본문이
// 통째로 깨진다 (WINDOWS_TEST_PARITY_SRS FR-WTP-20 과 같은 이유).
func jsonQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

var jsonFieldRe = regexp.MustCompile(`"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"`)

// jsonStringField 는 평평한 JSON 에서 문자열 필드를 꺼낸다. 응답에서 id 하나를
// 얻으려고 모델을 만들지 않는다.
func jsonStringField(blob, field string) string {
	for _, m := range jsonFieldRe.FindAllStringSubmatch(blob, -1) {
		if m[1] == field {
			return m[2]
		}
	}
	return ""
}
