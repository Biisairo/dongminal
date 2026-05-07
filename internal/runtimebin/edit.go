package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
)

const editHelp = `사용법:
  edit <path>              해당 경로로 새 code-server 열기
  edit -l, --list          열린 code-server 목록 (URL 클릭 → 열기)
  edit -s, --stop <id|all> 인스턴스 종료 (id 또는 all)
  edit -h, --help, ?       이 도움말
`

func runEdit(args []string, stdout, stderr io.Writer) int {
	base := baseURL() + "/api/code-server"

	if len(args) == 0 {
		fmt.Fprint(stdout, editHelp)
		return 0
	}
	switch args[0] {
	case "-h", "--help", "?":
		fmt.Fprint(stdout, editHelp)
		return 0
	case "-l", "--list":
		status, body, err := httpGet(base)
		if err != nil || status >= 400 {
			fmt.Fprintf(stderr, "edit: 서버 연결 실패 (port=%s)\n", currentPort())
			return 1
		}
		fmt.Fprintf(stdout, "\033]777;CodeServerList;%s\007", body)
		return 0
	case "-s", "--stop":
		if len(args) < 2 || args[1] == "" {
			fmt.Fprintln(stderr, "사용법: edit -s <id|all>")
			return 1
		}
		target := args[1]
		if target == "all" {
			status, body, err := httpGet(base)
			if err != nil || status >= 400 {
				fmt.Fprintf(stderr, "edit: 서버 연결 실패 (port=%s)\n", currentPort())
				return 1
			}
			ids := extractCodeServerIDs(body)
			if len(ids) == 0 {
				fmt.Fprintln(stdout, "열린 인스턴스 없음")
				return 0
			}
			rc := 0
			for _, id := range ids {
				st, _, err := httpPostEmpty(base + "/stop?id=" + url.QueryEscape(id))
				if err != nil || st >= 400 {
					fmt.Fprintf(stderr, "edit: 실패 (%s)\n", id)
					rc = 1
					continue
				}
				fmt.Fprintf(stdout, "stopped %s\n", id)
			}
			return rc
		}
		st, _, err := httpPostEmpty(base + "/stop?id=" + url.QueryEscape(target))
		if err != nil || st >= 400 {
			fmt.Fprintf(stderr, "edit: 실패 (%s)\n", target)
			return 1
		}
		fmt.Fprintf(stdout, "stopped %s\n", target)
		return 0
	}
	if len(args[0]) > 0 && args[0][0] == '-' {
		fmt.Fprintf(stderr, "edit: 알 수 없는 옵션: %s\n", args[0])
		fmt.Fprint(stderr, editHelp)
		return 1
	}

	target := args[0]
	if _, err := os.Stat(target); err != nil {
		fmt.Fprintf(stderr, "edit: 경로 없음: %s\n", target)
		return 1
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		fmt.Fprintf(stderr, "edit: 경로 변환 실패: %v\n", err)
		return 1
	}

	st, body, err := httpPostEmpty(base + "?path=" + url.QueryEscape(abs))
	if err != nil || st >= 400 || len(body) == 0 {
		fmt.Fprintf(stderr, "edit: 서버에 연결할 수 없음 (port=%s)\n", currentPort())
		return 1
	}
	var resp struct {
		ID     string `json:"id"`
		Path   string `json:"path"`
		Folder string `json:"folder"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.ID == "" || resp.Path == "" {
		fmt.Fprintf(stderr, "edit: 실패 — %s\n", body)
		return 1
	}
	fmt.Fprintf(stdout, "\033]777;OpenCodeServer;%s|%s|%s\007", resp.ID, resp.Path, resp.Folder)
	fmt.Fprintf(stdout, "VSCode(code-server) 열기: %s (folder=%s)\n", resp.Path, resp.Folder)
	return 0
}

// extractCodeServerIDs는 GET /api/code-server 응답에서 모든 id 값을 뽑는다.
// 응답 형식이 배열/오브젝트 어떤 형태든 안전하게 동작하도록 일반 JSON 으로 파싱.
func extractCodeServerIDs(body []byte) []string {
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil
	}
	var ids []string
	walkJSON(v, func(node map[string]any) {
		if id, ok := node["id"].(string); ok && id != "" {
			ids = append(ids, id)
		}
	})
	return ids
}

func walkJSON(v any, visit func(map[string]any)) {
	switch t := v.(type) {
	case map[string]any:
		visit(t)
		for _, child := range t {
			walkJSON(child, visit)
		}
	case []any:
		for _, child := range t {
			walkJSON(child, visit)
		}
	}
}
