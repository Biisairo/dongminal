package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/wsentry"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-4 (GH-17): 복사·삭제의 세기(최대 1만 항목)는 서버
// 전역 파일 조작 잠금 **밖에서** 돈다. 세는 동안 다른 루트의 mkdir·이름 바꾸기가
// 기다리지 않는다.
//
//	이전: 세는 동안 잠금이 잡혀 있었다 — 세기 중 TryLock 실패
//	새:   세기 중 TryLock 성공
func TestFSCountRunsOutsideOpsLock(t *testing.T) {
	cases := []struct {
		name string
		call func(s *Server, root, target, dst string) int
	}{
		{"copy", func(s *Server, root, target, dst string) int {
			code, _ := copyReq(t, s, root, target, root, dst)
			return code
		}},
		{"delete", func(s *Server, root, target, _ string) int {
			code, _ := fsReq(t, s, http.MethodPost, "/api/fs/delete",
				`{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(target)+`}`)
			return code
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, ws, _ := fsTestServer(t)
			root := wsentry.NormalizePath(t.TempDir())
			seedRoot(t, ws, root)
			target := filepath.Join(root, "tree")
			dst := filepath.Join(root, "dst")
			for _, d := range []string{filepath.Join(target, "sub"), dst} {
				if err := os.MkdirAll(d, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			counted, heldWhileCounting := 0, 0
			orig := fsCount
			fsCount = func(p string, max int) (int, error) {
				counted++
				if !s.fs.ops.TryLock() {
					heldWhileCounting++
				} else {
					s.fs.ops.Unlock()
				}
				return orig(p, max)
			}
			t.Cleanup(func() { fsCount = orig })

			if code := c.call(s, root, target, dst); code != http.StatusOK {
				t.Fatalf("code=%d", code)
			}
			if counted == 0 {
				t.Fatal("세기가 불리지 않았다")
			}
			if heldWhileCounting != 0 {
				t.Fatalf("세는 동안 파일 조작 잠금이 잡혀 있었다 (%d/%d회)", heldWhileCounting, counted)
			}
		})
	}
}
