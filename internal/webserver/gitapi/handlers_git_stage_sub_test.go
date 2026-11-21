package gitapi

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/query"
)

// REFACTOR3_FE_REST1_SRS FU-17 (사용자 결정 Q3): 서브모듈 stage 금지를 서버가 판정한다.

// gitSubStatus 는 안쪽만 바뀐 서브모듈 `sub`(상태 B)·커밋 몫이 있는 `subc`(상태 C)·파일 `x.txt` 가
// 바뀐 출력이다.
func gitSubStatus() string {
	oid := strings.Repeat("b", 40)
	return gitCleanStatus() +
		"1 .M S..U 160000 160000 160000 " + oid + " " + oid + " sub\x00" +
		"1 .M SC.U 160000 160000 160000 " + oid + " " + oid + " subc\x00" +
		"1 .M N... 100644 100644 100644 " + oid + " " + oid + " x.txt\x00"
}

// TC-FR1-4: 판정 함수의 표 시험. 요청 경로가 **모두** 상태 B 일 때만 거절한다 (D-FR1-3).
func TestStageAnswer(t *testing.T) {
	st, err := query.ParseStatusV2(gitSubStatus())
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		paths []string
		deny  bool
	}{
		{"경로 없음", nil, false},
		{"상태 B 하나", []string{"sub"}, true},
		{"상태 B · 끝 슬래시", []string{"sub/"}, true},
		{"상태 B + 파일", []string{"sub", "x.txt"}, false},
		{"상태 C", []string{"subc"}, false},
		{"파일", []string{"x.txt"}, false},
		{"status 에 없는 경로", []string{"nope"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := stageAnswer(st, c.paths)
			if a.OK == c.deny {
				t.Fatalf("answer = %+v, want deny=%v", a, c.deny)
			}
			if !c.deny {
				return
			}
			if a.Why != apierr.CodeSubmoduleInnerOnly || a.Status != http.StatusConflict {
				t.Fatalf("answer = %+v, want 409 %s", a, apierr.CodeSubmoduleInnerOnly)
			}
			if !action.Catalog.MayGive(action.GitStage, a.Why) {
				t.Fatalf("동작 목록에 %s 가 없다", a.Why)
			}
		})
	}
}

// TC-FR1-5 (FR-FR1-8): status 응답의 rowActions 는 서브모듈 행마다 git.stage 답을 싣는다.
func TestStatusRowActions_Submodule(t *testing.T) {
	f := newGitM5Fake(t)
	f.status = gitSubStatus()
	s := gitM5Server(t, f)
	out, _ := statusActions(t, s, "")
	rows, _ := out["rowActions"].(map[string]any)
	if rows == nil {
		t.Fatalf("rowActions 가 없다: %v", out)
	}
	ans := func(p string) map[string]any {
		r, _ := rows[p].(map[string]any)
		a, _ := r[action.GitStage].(map[string]any)
		return a
	}
	if a := ans("sub"); a == nil || a["ok"] != false || a["why"] != apierr.CodeSubmoduleInnerOnly {
		t.Fatalf("sub = %v, want 거절", a)
	}
	if a := ans("subc"); a == nil || a["ok"] != true {
		t.Fatalf("subc = %v, want 허용", a)
	}
	if _, has := rows["x.txt"]; has {
		t.Fatalf("서브모듈이 아닌 행은 싣지 않는다: %v", rows)
	}
}

// TC-FR1-5 (FR-FR1-7): 답이 거짓이면 실행이 같은 코드로 거절되고, 섞인 요청은 실행된다.
func TestStageRejectsSubmoduleInnerOnly(t *testing.T) {
	f := newGitM5Fake(t)
	f.status = gitSubStatus()
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", `{"repo":`+qWorkRepo+`,"paths":["sub"]}`)
	if code != http.StatusConflict || out["error"] != apierr.CodeSubmoduleInnerOnly {
		t.Fatalf("stage sub = %d %v, want 409 %s", code, out, apierr.CodeSubmoduleInnerOnly)
	}
	if _, has := out["message"]; has {
		t.Fatalf("서버가 문구를 실었다 (D-SDA-5): %v", out["message"])
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("실행됐다: %v", f.wrote())
	}
	code, out = gitReq(t, s, http.MethodPost, "/api/git/stage", `{"repo":`+qWorkRepo+`,"paths":["sub","x.txt"]}`)
	if code != http.StatusOK {
		t.Fatalf("섞인 요청 = %d %v, want 200", code, out)
	}
	if w := f.wrote(); len(w) == 0 || w[len(w)-1][0] != "add" {
		t.Fatalf("add 가 실행되지 않았다: %v", w)
	}
}

// TC-FR1-5: 실제 git — 서브모듈 안에 파일만 더하면 stage 는 409 이고, 행 답도 거짓이다.
func TestStageSubmoduleInnerOnly_RealGit(t *testing.T) {
	s, repo := submoduleTestServer(t)
	inner := wtTempRepo(t)
	wtGitRun(t, repo, "-c", "protocol.file.allow=always", "submodule", "add", inner, "sub")
	wtGitRun(t, repo, "commit", "-m", "add submodule")
	if err := os.WriteFile(filepath.Join(repo, "sub", "new.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := wtReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(repo), "")
	rows, _ := out["rowActions"].(map[string]any)
	row, _ := rows["sub"].(map[string]any)
	a, _ := row[action.GitStage].(map[string]any)
	if code != http.StatusOK || a == nil || a["why"] != apierr.CodeSubmoduleInnerOnly {
		t.Fatalf("status = %d rowActions=%v", code, out["rowActions"])
	}
	code, out = wtReq(t, s, http.MethodPost, "/api/git/stage", `{"repo":`+jsonStr(repo)+`,"paths":["sub"]}`)
	if code != http.StatusConflict || out["error"] != apierr.CodeSubmoduleInnerOnly {
		t.Fatalf("stage = %d %v", code, out)
	}
	if got := wtGitRun(t, repo, "diff", "--cached", "--name-only"); strings.TrimSpace(got) != "" {
		t.Fatalf("index 가 바뀌었다: %q", got)
	}
}
