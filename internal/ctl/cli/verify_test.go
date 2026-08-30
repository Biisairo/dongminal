package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
)

// ── 격리 가드 (FR-E2G-1/2) ───────────────────────────────────────────
//
// 가드는 순수 함수다. 그래서 위험한 조합을 **프로세스를 하나도 띄우지 않고**
// 전부 막을 수 있다. 이 테스트가 세 대상 모두에서 돈다.

func TestGuardIsolated_AcceptsIsolatedTarget(t *testing.T) {
	home := testpath.Abs("tmp", isolatedHomePrefix+"abc123")
	if err := guardIsolated(home, "51234", testpath.Abs("home", "u")); err != nil {
		t.Fatalf("격리 대상을 거부했다: %v", err)
	}
}

func TestGuardIsolated_RejectsDangerousTargets(t *testing.T) {
	userHome := testpath.Abs("home", "u")
	iso := testpath.Abs("tmp", isolatedHomePrefix+"abc123")

	cases := []struct {
		name string
		home string
		port string
		want string
	}{
		{"빈 홈", "", "51234", "격리 홈이 비어"},
		{"빈 포트", iso, "", "포트가 비어"},
		{"격리 표지 없는 홈", testpath.Abs("tmp", "something"), "51234", "격리 홈이 아닙니다"},
		{"사용자 기본 홈", filepath.Join(userHome, dmenv.DefaultHomeDir), "51234", "격리 홈이 아닙니다"},
		{"기본 포트", iso, dmenv.DefaultPort, "기본 포트"},
		{"접두사가 중간에만 있는 홈", testpath.Abs("tmp", "x-"+isolatedHomePrefix+"y"), "51234", "격리 홈이 아닙니다"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := guardIsolated(c.home, c.port, userHome)
			if err == nil {
				t.Fatalf("통과시켰다 — home=%q port=%q", c.home, c.port)
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("이유가 다르다: %v (want ~%q)", err, c.want)
			}
		})
	}
}

// userHome 을 알아내지 못해도 나머지 조항은 살아 있어야 한다. 홈을 모른다는
// 것이 가드 전체를 무르게 하는 근거가 될 수는 없다.
func TestGuardIsolated_UnknownUserHomeKeepsOtherClauses(t *testing.T) {
	iso := testpath.Abs("tmp", isolatedHomePrefix+"abc")
	if err := guardIsolated(iso, dmenv.DefaultPort, ""); err == nil {
		t.Fatal("userHome 이 비었다고 기본 포트를 통과시켰다")
	}
	if err := guardIsolated(testpath.Abs("tmp", "plain"), "51234", ""); err == nil {
		t.Fatal("userHome 이 비었다고 비격리 홈을 통과시켰다")
	}
}

// resolveStartTarget 이 만드는 홈이 가드를 실제로 통과해야 한다. 두 상수가
// 갈라지면 가드가 조용히 무력해지므로, 그 일치를 테스트가 붙든다.
func TestGuardIsolated_AcceptsWhatResolveStartTargetMakes(t *testing.T) {
	home, port, err := resolveStartTarget(StartOpts{Isolated: true})
	if err != nil {
		t.Fatalf("격리 대상 준비 실패: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	if err := guardIsolated(home, port, userHomeDir()); err != nil {
		t.Fatalf("resolveStartTarget 의 산물을 가드가 거부했다: %v", err)
	}
}

// ── 옵션 (FR-E2C-2/3/5) ──────────────────────────────────────────────

func TestParseVerify_RejectsPortAndHome(t *testing.T) {
	for _, arg := range []string{"--port", "--home"} {
		t.Run(arg, func(t *testing.T) {
			_, err := ParseVerify([]string{arg, "58146"})
			if err == nil {
				t.Fatal("받아들였다 — verify 는 격리 전용이다")
			}
			if !strings.Contains(err.Error(), "격리 인스턴스") {
				t.Fatalf("이유가 설명되지 않는다: %v", err)
			}
		})
	}
}

func TestParseVerify_Repo(t *testing.T) {
	for _, args := range [][]string{{"--repo", "/x/y"}, {"--repo=/x/y"}} {
		o, err := ParseVerify(args)
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if o.Repo != "/x/y" {
			t.Fatalf("%v: Repo=%q", args, o.Repo)
		}
	}
	if _, err := ParseVerify([]string{"--repo"}); err == nil {
		t.Fatal("값 없는 --repo 를 받아들였다")
	}
}

func TestParseVerify_HelpAndUnknown(t *testing.T) {
	if _, err := ParseVerify([]string{"--help"}); !errors.Is(err, ErrHelp) {
		t.Fatalf("--help 가 ErrHelp 가 아니다: %v", err)
	}
	if _, err := ParseVerify([]string{"--nope"}); err == nil {
		t.Fatal("모르는 옵션을 받아들였다")
	}
}

func TestVerifyActionIsListed(t *testing.T) {
	var found bool
	for _, a := range Actions {
		if a == "verify" {
			found = true
		}
	}
	if !found {
		t.Fatal("Actions 에 verify 가 없다")
	}
	if u := Usage("verify"); !strings.Contains(u, "dongminal verify") {
		t.Fatalf("Usage(verify) 가 비었다: %q", u)
	}
}

// ── 검사 목록 (FR-E2K-1 · FR-E2I-6) ──────────────────────────────────
//
// 목록을 골든으로 고정한다. 이관 중 항목이 조용히 빠지는 것이 이 트랙의 R-5 이고,
// 이 테스트가 그 자물쇠다.

var verifyGolden = []string{
	"기동 표면|서버 프로세스 생존",
	"기동 표면|데몬 종단 생성 (paned.sock)",
	"기동 표면|/api/ping",
	"도구 — PTY + IPC 왕복|도구 생성",
	"도구 — PTY + IPC 왕복|/api/state 에 도구가 보인다",
	"도구 — PTY + IPC 왕복|busy 조회",
	"도구 — PTY + IPC 왕복|도구 출력 조회",
	"도구 — PTY + IPC 왕복|입력→출력 왕복",
	"워크스페이스·설정|/api/workspace",
	"워크스페이스·설정|/api/stats",
	"워크스페이스·설정|/api/settings",
	"git 읽기 표면|git status",
	"git 읽기 표면|git log",
	"git 읽기 표면|git refs",
	"git 읽기 표면|git signature",
	"git 읽기 표면|git stash",
	"git 읽기 표면|git records",
	"git 읽기 표면|git policy",
	"git 읽기 표면|git jobs",
	"git 읽기 표면|없는 git 경로 404",
	"정적 자산|index.html 의 script 전량 200",
	"정적 자산|구 평면 경로 /js/app.js 404",
}

func TestVerifyChecks_Golden(t *testing.T) {
	got := verifyChecks()
	if len(got) != len(verifyGolden) {
		t.Fatalf("검사 수가 %d 다 (want %d) — 항목이 빠졌거나 늘었다", len(got), len(verifyGolden))
	}
	for i, c := range got {
		if line := c.Section + "|" + c.Name; line != verifyGolden[i] {
			t.Errorf("%d: %q (want %q)", i, line, verifyGolden[i])
		}
	}
}

func TestVerifyChecks_EveryCheckIsRunnable(t *testing.T) {
	for _, c := range verifyChecks() {
		if c.Name == "" || c.Section == "" {
			t.Errorf("이름·구획이 빈 검사가 있다: %+v", c)
		}
		if c.Run == nil {
			t.Errorf("%s: Run 이 없다", c.Name)
		}
	}
}

// 구획은 이어져 있어야 한다 — 흩어지면 보고서에 같은 머리말이 두 번 찍힌다.
func TestVerifyChecks_SectionsAreContiguous(t *testing.T) {
	seen := map[string]bool{}
	prev := ""
	for _, c := range verifyChecks() {
		if c.Section == prev {
			continue
		}
		if seen[c.Section] {
			t.Fatalf("구획 %q 가 흩어져 있다", c.Section)
		}
		seen[c.Section] = true
		prev = c.Section
	}
}

// ── 능력 질의 (FR-E2S-3/4) ───────────────────────────────────────────

func TestNeedGitRepo_ReportsWhy(t *testing.T) {
	cases := []struct {
		name string
		caps verifyCaps
		want string
	}{
		{"git 없음", verifyCaps{}, "PATH 에 없다"},
		{"저장소 아님", verifyCaps{GitBin: true}, "git 저장소가 아니다"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ok, why := needGitRepo(&verifySession{caps: c.caps, repo: testpath.Abs("x")})
			if ok {
				t.Fatal("돌 수 있다고 답했다")
			}
			if !strings.Contains(why, c.want) {
				t.Fatalf("이유가 다르다: %q (want ~%q)", why, c.want)
			}
		})
	}
	if ok, _ := needGitRepo(&verifySession{caps: verifyCaps{GitBin: true, GitRepo: true}}); !ok {
		t.Fatal("갖춰진 호스트에서 건너뛰었다")
	}
}

func TestNeedTool_SkipsWhenCreationFailed(t *testing.T) {
	ok, why := needTool(&verifySession{})
	if ok {
		t.Fatal("도구 id 없이 돌 수 있다고 답했다")
	}
	if !strings.Contains(why, "도구 생성") {
		t.Fatalf("이유가 다르다: %q", why)
	}
	if ok, _ := needTool(&verifySession{toolID: "t1"}); !ok {
		t.Fatal("id 가 있는데 건너뛰었다")
	}
}

// 검사 목록에 **OS 를 근거로 한 조건이 하나도 없어야 한다** (FR-E2S-2).
// 능력 질의는 verifyCaps 만 본다 — 그 구조체에 OS 를 뜻하는 필드가 없다는 것이
// 이 조항의 구조적 보증이다.
func TestVerifyChecks_NoOSDrivenSkips(t *testing.T) {
	full := verifyCaps{GitBin: true, GitRepo: true}
	s := &verifySession{caps: full, toolID: "t1", repo: testpath.Abs("r")}
	for _, c := range verifyChecks() {
		if c.Need == nil {
			continue
		}
		if ok, why := c.Need(s); !ok {
			t.Errorf("%s: 갖춰진 호스트인데 건너뛴다 — %s", c.Name, why)
		}
	}
}

// ── 정적 자산 추출 (FR-E2K-3) ────────────────────────────────────────

func TestExtractScriptSrcs(t *testing.T) {
	html := `<!doctype html><html><head>
<script src="js/core/app.js"></script>
<script type="module" src="js/git/panel.js"></script>
<script src="js/core/app.js"></script>
<script src="https://cdn.example.com/x.js"></script>
<script>inline()</script>
</head></html>`
	got := extractScriptSrcs(html)
	want := []string{"js/core/app.js", "js/git/panel.js"}
	if len(got) != len(want) {
		t.Fatalf("%d개를 뽑았다 (want %d): %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%d: %q (want %q)", i, got[i], want[i])
		}
	}
}

func TestExtractScriptSrcs_Empty(t *testing.T) {
	if got := extractScriptSrcs("<html></html>"); len(got) != 0 {
		t.Fatalf("빈 문서에서 %v 를 뽑았다", got)
	}
}

// ── JSON 도우미 ──────────────────────────────────────────────────────

func TestJSONQuote_EscapesBackslash(t *testing.T) {
	// Windows 경로를 날것으로 끼우면 `\U` 가 유효하지 않은 이스케이프가 되어
	// 본문이 통째로 깨진다.
	got := jsonQuote(`C:\Users\me`)
	if got != `"C:\\Users\\me"` {
		t.Fatalf("got %s", got)
	}
	if q := jsonQuote(`a"b`); q != `"a\"b"` {
		t.Fatalf("got %s", q)
	}
}

func TestJSONStringField(t *testing.T) {
	blob := `{"ok":true,"id":"t-42","name":"a\"b"}`
	if got := jsonStringField(blob, "id"); got != "t-42" {
		t.Fatalf("id=%q", got)
	}
	if got := jsonStringField(blob, "없음"); got != "" {
		t.Fatalf("없는 필드에 %q 를 냈다", got)
	}
}

// ── 보고자 (FR-E2R-2/4) ──────────────────────────────────────────────

func TestCheckReport_SkipIsNotFailure(t *testing.T) {
	var buf strings.Builder
	r := &checkReport{out: &buf}
	r.ok("통과")
	r.skipped("건너뛴 것", "이유가 있다")
	if r.fail != 0 {
		t.Fatalf("건너뜀이 실패로 셌다: fail=%d", r.fail)
	}
	if r.skip != 1 {
		t.Fatalf("skip=%d", r.skip)
	}
	out := buf.String()
	if !strings.Contains(out, "건너뛴 것") || !strings.Contains(out, "이유가 있다") {
		t.Fatalf("건너뜀이 보고서에 남지 않았다:\n%s", out)
	}
}

func TestVerifySummary_SkipOnlyExitsZero(t *testing.T) {
	var buf strings.Builder
	r := &checkReport{out: &buf}
	r.skipped("a", "이유")
	if code := verifySummary(r, 3, &buf, t.TempDir(), ""); code != 0 {
		t.Fatalf("건너뜀만 있는데 %d 를 냈다", code)
	}
	if code := verifySummary(&checkReport{out: &buf, fail: 1}, 0, &buf, t.TempDir(), ""); code != 1 {
		t.Fatal("실패가 있는데 0 을 냈다")
	}
	if !strings.Contains(buf.String(), "건너뜀 1건") {
		t.Fatalf("요약에 건너뜀 수가 없다:\n%s", buf.String())
	}
}
