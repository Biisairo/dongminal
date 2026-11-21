package httpapi

import (
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/webserver/domain/ext"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-1: `New`·`apiServerBind` 에서 뗀 판정 함수.

func TestDataDirLayout(t *testing.T) {
	cases := []struct {
		name, dir, notes, plugins string
	}{
		{"자리가 없으면 둘 다 빈다", "", "", ""},
		{"데이터 디렉터리 아래", "/d", filepath.Join("/d", dmenv.NotesDir), ext.PluginsDir(ext.RootIn("/d"))},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			notes, plugins := dataDirLayout(c.dir)
			if notes != c.notes || plugins != c.plugins {
				t.Fatalf("got (%q, %q), want (%q, %q)", notes, plugins, c.notes, c.plugins)
			}
		})
	}
}

func TestBindPortValid(t *testing.T) {
	p := func(n int) *int { return &n }
	cases := []struct {
		name string
		port *int
		want bool
	}{
		{"없음", nil, true},
		{"하한", p(bindPortMin), true},
		{"상한", p(bindPortMax), true},
		{"하한 아래", p(bindPortMin - 1), false},
		{"상한 위", p(bindPortMax + 1), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := bindPortValid(c.port); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestBindTarget(t *testing.T) {
	p := func(n int) *int { return &n }
	b := func(v bool) *bool { return &v }
	cases := []struct {
		name               string
		curHost, curPort   string
		in                 bindReq
		wantHost, wantPort string
	}{
		{"빈 요청은 그대로", dmenv.DefaultHost, "1", bindReq{}, dmenv.DefaultHost, "1"},
		{"노출을 켠다", dmenv.DefaultHost, "1", bindReq{Expose: b(true)}, exposeHost, "1"},
		{"노출을 끈다", exposeHost, "1", bindReq{Expose: b(false)}, dmenv.DefaultHost, "1"},
		{"노출이 아니면 끄기는 무동작", dmenv.DefaultHost, "1", bindReq{Expose: b(false)}, dmenv.DefaultHost, "1"},
		{"포트만", dmenv.DefaultHost, "1", bindReq{Port: p(2000)}, dmenv.DefaultHost, "2000"},
		{"둘 다", dmenv.DefaultHost, "1", bindReq{Port: p(2000), Expose: b(true)}, exposeHost, "2000"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, port := bindTarget(c.curHost, c.curPort, c.in)
			if h != c.wantHost || port != c.wantPort {
				t.Fatalf("got (%q, %q), want (%q, %q)", h, port, c.wantHost, c.wantPort)
			}
		})
	}
}

func TestBindReason(t *testing.T) {
	cases := []struct{ cur, next, want string }{
		{"1", "1", "expose"},
		{"1", "2", "port"},
	}
	for _, c := range cases {
		if got := bindReason(c.cur, c.next); got != c.want {
			t.Fatalf("(%q,%q): got %q, want %q", c.cur, c.next, got, c.want)
		}
	}
}
