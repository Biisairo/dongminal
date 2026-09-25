package gitapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-5 (HTTP-12): branch·tag 이름 검사는 한 절차를 딛는다.
// 응답은 **바이트 그대로**다 (FR-OPT-0-3) — 모은 뒤의 본문을 모으기 전의 본문으로
// 못박는다. 저장소 경로만 자리표시로 바꾼다 (OS 마다 다르다).
func TestAPIGitNameValidate_BodiesByteCompatible(t *testing.T) {
	f := newGitM5Fake(t)
	f.branches["taken"] = true
	bs := gitM5Server(t, f)
	ts := gitTagServer(t, newGitTagFake(t), nil)
	repo, _ := json.Marshal(absWorkRepo)
	const kinds = `"kinds":["","annotated","signed"],`
	cases := []struct {
		s          *GitServer
		kind, name string
		want       string
	}{
		{bs, "branch", "feat/a", `{"exists":false,"ok":true,"reason":"","repo":R,"requested":{"name":"feat/a","repo":R}}`},
		{bs, "branch", "bad name", `{"exists":false,"ok":false,"reason":"ref_name_invalid: \"bad name\" 는 git 의 브랜치 이름 규칙을 어긴다","repo":R,"requested":{"name":"bad name","repo":R}}`},
		{bs, "branch", "-lead", `{"exists":false,"ok":false,"reason":"ref_name_invalid: name 는 - 로 시작할 수 없다: \"-lead\"","repo":R,"requested":{"name":"-lead","repo":R}}`},
		{bs, "branch", "taken", `{"exists":true,"ok":true,"reason":"","repo":R,"requested":{"name":"taken","repo":R}}`},
		{ts, "tag", "v9.0", `{"exists":false,` + kinds + `"ok":true,"reason":"","repo":R,"requested":{"name":"v9.0","repo":R}}`},
		{ts, "tag", "v1.0", `{"exists":true,` + kinds + `"ok":true,"reason":"","repo":R,"requested":{"name":"v1.0","repo":R}}`},
		{ts, "tag", "bad name", `{"exists":false,` + kinds + `"ok":false,"reason":"ref_name_invalid: \"bad name\" 는 git 의 태그 이름 규칙을 어긴다","repo":R,"requested":{"name":"bad name","repo":R}}`},
		{ts, "tag", "-x", `{"exists":false,` + kinds + `"ok":false,"reason":"ref_name_invalid: name 는 - 로 시작할 수 없다: \"-x\"","repo":R,"requested":{"name":"-x","repo":R}}`},
	}
	for _, c := range cases {
		t.Run(c.kind+"/"+c.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/git/"+c.kind+"/validate?repo="+url.QueryEscape(absWorkRepo)+"&name="+url.QueryEscape(c.name), nil)
			rec := httptest.NewRecorder()
			c.s.handler().ServeHTTP(rec, r)
			want := strings.ReplaceAll(c.want, "R", string(repo))
			if got := strings.TrimRight(rec.Body.String(), "\n"); rec.Code != http.StatusOK || got != want {
				t.Fatalf("code=%d\n got %s\nwant %s", rec.Code, got, want)
			}
		})
	}
}
