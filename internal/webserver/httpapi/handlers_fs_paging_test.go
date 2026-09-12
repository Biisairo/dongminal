package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// 잘린 폴더의 나머지에 닿는 길 (FS_LIST_PAGING_SRS §4.1).
//
// `offset` 이 뜻을 갖는 것은 **순서가 서버의 것이기 때문**이다 (FR-EDT-61) —
// 그 전제가 깨지면 쪽의 경계가 요청마다 밀린다. 그래서 TC-FSP-5 가 "이어 붙이면
// 한 번에 다 읽은 것과 같다" 를 못박는다.

func listPage(t *testing.T, s *Server, root, dir string, offset int) (int, map[string]any) {
	t.Helper()
	u := "/api/fs/list?root=" + url.QueryEscape(root) + "&path=" + url.QueryEscape(dir)
	if offset >= 0 {
		u += "&offset=" + fmt.Sprint(offset)
	}
	r := apiTestRequest(http.MethodGet, u, nil)
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func listRaw(t *testing.T, s *Server, root, dir, offsetRaw string) (int, map[string]any) {
	t.Helper()
	u := "/api/fs/list?root=" + url.QueryEscape(root) + "&path=" + url.QueryEscape(dir) +
		"&offset=" + url.QueryEscape(offsetRaw)
	r := apiTestRequest(http.MethodGet, u, nil)
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func names(out map[string]any) []string {
	raw, _ := out["entries"].([]any)
	got := make([]string, 0, len(raw))
	for _, e := range raw {
		m, _ := e.(map[string]any)
		n, _ := m["name"].(string)
		got = append(got, n)
	}
	return got
}

// n 개의 파일을 만든다. 이름은 정렬 순서가 자명하도록 0 채움이다.
func mkFlat(t *testing.T, n int) string {
	t.Helper()
	dir := uploadRoot(t)
	for i := 0; i < n; i++ {
		p := filepath.Join(dir, fmt.Sprintf("f%04d.txt", i))
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// TC-FSP-1: `offset` 이 없으면 0 쪽이고 `total` 이 실린다.
func TestFSList_TotalAndDefaultOffset(t *testing.T) {
	dir := mkFlat(t, 5)
	srv := transferSrv(t, dir)

	code, out := listPage(t, srv, dir, dir, -1)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if got := len(names(out)); got != 5 {
		t.Fatalf("entries=%d", got)
	}
	if total, _ := out["total"].(float64); int(total) != 5 {
		t.Fatalf("total=%v", out["total"])
	}
	if off, _ := out["offset"].(float64); int(off) != 0 {
		t.Fatalf("offset=%v", out["offset"])
	}
	if tr, _ := out["truncated"].(bool); tr {
		t.Fatal("truncated 가 참이다")
	}
}

// TC-FSP-2·5: 쪽을 이어 붙이면 **한 번에 다 읽은 것과 순서까지 같다.**
// 겹치지도 빠뜨리지도 않는다는 진술이 이것 하나에 들어 있다.
func TestFSList_PagesConcatenateExactly(t *testing.T) {
	dir := mkFlat(t, 7)
	srv := transferSrv(t, dir)

	_, whole := listPage(t, srv, dir, dir, 0)
	want := names(whole)
	if len(want) != 7 {
		t.Fatalf("전량 entries=%d", len(want))
	}

	// 쪽 크기를 줄일 수는 없으므로(fsListMax 는 상수) offset 을 옮겨 가며
	// **꼬리가 정확히 이어지는지**를 본다.
	for off := 0; off <= 7; off++ {
		_, page := listPage(t, srv, dir, dir, off)
		got := names(page)
		if len(got) != len(want)-off {
			t.Fatalf("offset=%d entries=%d, 기대 %d", off, len(got), len(want)-off)
		}
		for i := range got {
			if got[i] != want[off+i] {
				t.Fatalf("offset=%d [%d] = %q, 기대 %q", off, i, got[i], want[off+i])
			}
		}
	}
}

// TC-FSP-3: `offset >= total` 은 빈 배열 · `truncated:false` · **200** 이다.
// 폴더가 줄어든 뒤의 요청이 그 꼴이고, 그때 볼 것은 오류가 아니라 "더는 없다" 다.
func TestFSList_OffsetBeyondTotalIsEmptyNotError(t *testing.T) {
	dir := mkFlat(t, 3)
	srv := transferSrv(t, dir)

	for _, off := range []int{3, 4, 1000} {
		code, out := listPage(t, srv, dir, dir, off)
		if code != http.StatusOK {
			t.Fatalf("offset=%d code=%d body=%v", off, code, out)
		}
		if got := names(out); len(got) != 0 {
			t.Fatalf("offset=%d entries=%v", off, got)
		}
		if tr, _ := out["truncated"].(bool); tr {
			t.Fatalf("offset=%d 에서 truncated 가 참이다", off)
		}
		if total, _ := out["total"].(float64); int(total) != 3 {
			t.Fatalf("offset=%d total=%v", off, out["total"])
		}
	}
}

// TC-FSP-4: 음수·정수 아님은 `0` 으로 떨어진다 — 손으로 고친 URL 하나가 오류
// 화면이 되지 않는다.
func TestFSList_BadOffsetFallsBackToZero(t *testing.T) {
	dir := mkFlat(t, 4)
	srv := transferSrv(t, dir)

	for _, raw := range []string{"-1", "abc", "", "1.5", "99999999999999999999"} {
		code, out := listRaw(t, srv, dir, dir, raw)
		if code != http.StatusOK {
			t.Fatalf("offset=%q code=%d body=%v", raw, code, out)
		}
		if got := len(names(out)); got != 4 {
			t.Fatalf("offset=%q entries=%d — 0 으로 떨어지지 않았다", raw, got)
		}
		if off, _ := out["offset"].(float64); int(off) != 0 {
			t.Fatalf("offset=%q 응답 offset=%v", raw, out["offset"])
		}
	}
}

// `stamp` 는 쪽마다 함께 온다 (FR-FSP-5) — 폴링이 그것을 딛는다.
func TestFSList_StampTravelsWithEveryPage(t *testing.T) {
	dir := mkFlat(t, 3)
	srv := transferSrv(t, dir)

	for _, off := range []int{0, 2, 5} {
		_, out := listPage(t, srv, dir, dir, off)
		if st, _ := out["stamp"].(string); st == "" {
			t.Fatalf("offset=%d 에 stamp 가 없다", off)
		}
	}
}
