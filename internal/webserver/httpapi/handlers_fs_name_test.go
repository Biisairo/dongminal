package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
)

// SERVER_DRIVEN_ACTIONS_SRS 묶음 F-2 (FR-SDA-52·53 · TC-SDA-1·7).

// F-i: 이름 판정.
func TestFSNameAnswer(t *testing.T) {
	cases := []struct{ name, want string }{
		{"a.txt", ""},
		{" spaced ", ""},
		{"", apierr.CodeEmptyName},
		{"   ", apierr.CodeEmptyName},
		{"a/b", apierr.CodeNameHasSeparator},
		{"/", apierr.CodeNameHasSeparator},
		{".", apierr.CodeNameReserved},
		{"..", apierr.CodeNameReserved},
		{" .. ", apierr.CodeNameReserved},
		{"..a", ""},
	}
	if filepath.Separator == '\\' {
		cases = append(cases, struct{ name, want string }{`a\b`, apierr.CodeNameHasSeparator})
	} else {
		// 이 OS 에서 `\` 는 이름에 쓸 수 있는 글자다.
		cases = append(cases, struct{ name, want string }{`a\b`, ""})
	}
	for _, c := range cases {
		a := fsNameAnswer(c.name)
		if a.Why != c.want || a.OK != (c.want == "") {
			t.Errorf("fsNameAnswer(%q) = %+v, want why=%q", c.name, a, c.want)
		}
		if !a.OK {
			if a.Status != http.StatusBadRequest {
				t.Errorf("fsNameAnswer(%q) status = %d, want 400", c.name, a.Status)
			}
			if !action.Catalog.MayGive(action.FSName, a.Why) {
				t.Errorf("%s 의 사유 %s 가 action.Catalog 에 없다", action.FSName, a.Why)
			}
		}
	}
}

func TestFSValidateName(t *testing.T) {
	s, _, _ := fsTestServer(t)
	code, out := fsReq(t, s, http.MethodPost, "/api/fs/validate-name", `{"name":"a/b"}`)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	wantFSAnswer(t, out, action.FSName, apierr.CodeNameHasSeparator)
	_, out = fsReq(t, s, http.MethodPost, "/api/fs/validate-name", `{"name":"ok.txt"}`)
	wantFSAnswer(t, out, action.FSName, "")
}

// F-j: 이름을 받는 만들기·이름 바꾸기는 같은 판정으로 거절한다 (TC-SDA-7).
func TestFSCreateAndRenameByName(t *testing.T) {
	s, _, root := fsActionsTree(t)
	q := testpath.JSONQuote
	reject := func(path, body, why string) {
		t.Helper()
		code, out := fsReq(t, s, http.MethodPost, path, body)
		if code != http.StatusBadRequest || out["code"] != why {
			t.Fatalf("%s %s: code=%d body=%v, want 400 %s", path, body, code, out, why)
		}
		if _, has := out["message"]; has {
			t.Fatalf("%s: 거절에 서버 문구가 실렸다: %v", path, out)
		}
	}
	tree := filepath.Join(root, "tree")

	// `a/b` 는 폴더 `tree/sub` 가 있어도 이름으로 받으면 거절이다.
	reject("/api/fs/create", `{"root":`+q(root)+`,"parent":`+q(tree)+`,"name":"sub/new","dir":false}`,
		apierr.CodeNameHasSeparator)
	if _, err := os.Stat(filepath.Join(tree, "sub", "new")); !os.IsNotExist(err) {
		t.Fatalf("다른 폴더에 파일이 생겼다: %v", err)
	}
	reject("/api/fs/create", `{"root":`+q(root)+`,"parent":`+q(tree)+`,"name":"..","dir":true}`, apierr.CodeNameReserved)

	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create",
		`{"root":`+q(root)+`,"parent":`+q(tree)+`,"name":"made.txt","dir":false}`); code != 200 {
		t.Fatalf("만들기: code=%d body=%v", code, out)
	}
	if _, err := os.Stat(filepath.Join(tree, "made.txt")); err != nil {
		t.Fatalf("만들어지지 않았다: %v", err)
	}

	a := filepath.Join(tree, "a")
	reject("/api/fs/rename", `{"root":`+q(root)+`,"from":`+q(a)+`,"name":"sub/a"}`, apierr.CodeNameHasSeparator)
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/rename",
		`{"root":`+q(root)+`,"from":`+q(a)+`,"name":"renamed"}`); code != 200 {
		t.Fatalf("이름 바꾸기: code=%d body=%v", code, out)
	}
	if _, err := os.Stat(filepath.Join(tree, "renamed")); err != nil {
		t.Fatalf("이름이 바뀌지 않았다: %v", err)
	}

	// 경로를 뜻하는 기존 모양은 그대로 받는다 (R-3).
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create",
		`{"root":`+q(root)+`,"path":`+q(filepath.Join(tree, "sub", "deep.txt"))+`,"dir":false}`); code != 200 {
		t.Fatalf("path 모양: code=%d body=%v", code, out)
	}
}

// F-l: 자기 하위로 옮기기·복사는 `into_self` 이고 서버 문구를 싣지 않는다.
func TestFSIntoSelf(t *testing.T) {
	s, _, root := fsActionsTree(t)
	q := testpath.JSONQuote
	tree := filepath.Join(root, "tree")
	sub := filepath.Join(tree, "sub")
	for _, c := range []struct{ path, body string }{
		{"/api/fs/rename", `{"root":` + q(root) + `,"from":` + q(tree) + `,"to":` + q(filepath.Join(sub, "tree")) + `}`},
		{"/api/fs/copy", `{"srcRoot":` + q(root) + `,"src":` + q(tree) + `,"dstRoot":` + q(root) + `,"dstDir":` + q(sub) + `}`},
	} {
		code, out := fsReq(t, s, http.MethodPost, c.path, c.body)
		if code != http.StatusBadRequest || out["code"] != apierr.CodeIntoSelf {
			t.Fatalf("%s: code=%d body=%v, want 400 into_self", c.path, code, out)
		}
		if _, has := out["message"]; has {
			t.Fatalf("%s: 거절에 서버 문구가 실렸다: %v", c.path, out)
		}
	}
}

func TestFSValidateNameRouteRegistered(t *testing.T) {
	for _, rt := range apiRoutes {
		if rt.Method == http.MethodPost && rt.Match("/api/fs/validate-name") {
			return
		}
	}
	t.Fatal("POST /api/fs/validate-name 가 apiRoutes 에 없다")
}
