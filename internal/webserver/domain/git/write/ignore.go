package write

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// `.gitignore` 추가 (GIT_ACTIONS_SRS §3.6 FR-GIT-273, 검증 V200).
//
// **이것은 git 실행이 아니라 파일 쓰기다.** 그래서 이 파일의 함수는 `core.Service`
// 를 받지 않고 `ExecWrite` 를 지나지 않는다 — 지나갈 argv 자체가 없다.
//
// 그 대신 두 가지를 스스로 세운다:
//
//   - **대상은 저장소 루트의 `.gitignore` 하나뿐이다.** 하위 디렉터리의 것을 고르게
//     하면 어느 파일이 바뀌었는지 사용자가 알 수 없다.
//   - **경로를 저장소 안으로 가둔다.** 클라이언트만 막으면 API 직접 호출이 우회해
//     저장소 밖의 경로가 패턴으로 들어간다 (FR-GIT-250.3 의 정신).

// IgnoreFileName 은 대상 파일의 이름이다. 호출 지점마다 문자열이 흩어지면 대상이
// 하나라는 사실을 한 자리에서 볼 수 없다.
const IgnoreFileName = ".gitignore"

// ignorePerm 은 새로 만들 때의 권한이다. 이미 있으면 그 권한을 유지한다.
const ignorePerm = 0o644

// ErrIgnorePath 는 `.gitignore` 에 넣을 수 없는 경로다 — 저장소 밖이거나, 비었거나,
// 저장소 루트 자신이다.
var ErrIgnorePath = errors.New("unsafe_ignore_path")

// IgnoreResult 는 추가 한 번의 사실이다.
//
// Skipped 가 따로 있는 이유는 **이미 있던 줄과 새로 넣은 줄이 다른 사실**이기
// 때문이다 (FR-GIT-273). 둘을 뭉개면 화면이 "추가했습니다" 라고 말한 것이 실제로는
// 아무 일도 아니었을 수 있다.
type IgnoreResult struct {
	File    string   `json:"file"`    // 절대경로. 어느 파일이 바뀌었는지 보인다
	Added   []string `json:"added"`   // 새로 넣은 패턴
	Skipped []string `json:"skipped"` // 이미 있어서 넣지 않은 패턴
}

// IgnoreFile 은 저장소 루트의 `.gitignore` 절대경로다. **하나뿐이다.**
func IgnoreFile(root string) string { return filepath.Join(root, IgnoreFileName) }

// IgnorePattern 은 경로 하나를 `.gitignore` 한 줄로 옮긴다. **파일을 건드리지
// 않는 순수 함수다** — 서버가 잘못된 요청을 쓰기 **전에** 400 으로 답할 수 있어야
// 하고, 테스트가 "무엇을 쓰지 않았는가"를 볼 수 있어야 한다 (FR-GIT-250 의 ① 과
// 같은 정신이며, 여기서는 argv 대신 줄이 결과물이다).
//
// 절대경로도 받는다 — 클라이언트가 `repo + '/' + path` 를 쥐고 있기 때문이다
// (`GitPanel.absPath`). 다만 그것이 루트 안일 때만이다.
//
// 결과에 `/` 를 앞세워 **루트에 고정한다.** 고정하지 않으면 `a.txt` 한 줄이 하위
// 디렉터리의 같은 이름까지 모두 무시하게 되어, 사용자가 고른 파일보다 넓게 걸린다.
func IgnorePattern(root, p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("%w: 경로가 비었다", ErrIgnorePath)
	}
	rel := p
	if filepath.IsAbs(p) {
		r, err := filepath.Rel(root, p)
		if err != nil {
			return "", fmt.Errorf("%w: %q 는 %s 안의 경로가 아니다", ErrIgnorePath, p, root)
		}
		rel = filepath.ToSlash(r)
	}
	// 나머지 판정(부모 참조·NUL·정규화·절대경로)은 diff 가 쓰는 것과 같은 검사다 —
	// 경로 규칙을 두 벌로 두면 한쪽만 고쳐진다.
	rel, err := core.RelPath(rel, ErrIgnorePath)
	if err != nil {
		return "", err
	}
	if rel == "." {
		return "", fmt.Errorf("%w: 저장소 루트 자신은 무시할 수 없다", ErrIgnorePath)
	}
	return "/" + rel, nil
}

// IgnoreAdd 는 경로들을 저장소 루트의 `.gitignore` 에 덧붙인다 (FR-GIT-273).
//
// **하나라도 이탈이면 아무것도 쓰지 않는다** — 일부만 쓰고 실패하면 사용자는
// 무엇이 들어갔는지 알 수 없다. 그래서 검증을 먼저 전부 끝낸다.
//
// **이미 있는 줄은 더하지 않는다** (V200). 파일 끝에 개행이 없으면 보정한다 —
// 보정하지 않으면 새 줄이 마지막 줄에 붙어 두 패턴이 하나가 된다.
func IgnoreAdd(root string, paths []string) (IgnoreResult, error) {
	res := IgnoreResult{File: IgnoreFile(root), Added: []string{}, Skipped: []string{}}
	if len(paths) == 0 {
		return res, fmt.Errorf("%w: 대상 경로가 없다", ErrIgnorePath)
	}
	// 쓰기 **전에** 전부 검증한다.
	want := make([]string, 0, len(paths))
	for _, p := range paths {
		pat, err := IgnorePattern(root, p)
		if err != nil {
			return IgnoreResult{}, err
		}
		want = append(want, pat)
	}

	body, err := os.ReadFile(res.File)
	if err != nil && !os.IsNotExist(err) {
		return IgnoreResult{}, fmt.Errorf("%s 를 읽지 못했다: %w", res.File, err)
	}
	have := ignoreLines(string(body))

	add := ""
	for _, pat := range want {
		if have[pat] {
			// 같은 요청 안의 중복도 여기서 걸린다 — 넣은 것을 have 에 바로 담는다.
			res.Skipped = append(res.Skipped, pat)
			continue
		}
		have[pat] = true
		res.Added = append(res.Added, pat)
		add += pat + "\n"
	}
	if add == "" {
		return res, nil
	}

	out := string(body)
	// 파일 끝의 개행을 보정한다. 빈 파일에는 붙이지 않는다 — 첫 줄이 빈 줄이 된다.
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	if err := os.WriteFile(res.File, []byte(out+add), ignorePerm); err != nil {
		return IgnoreResult{}, fmt.Errorf("%s 를 쓰지 못했다: %w", res.File, err)
	}
	return res, nil
}

// ignoreLines 는 이미 있는 패턴의 집합이다.
//
// 고정된 것(`/a.txt`)과 고정되지 않은 것(`a.txt`)을 **같은 것으로 본다** — 다른
// 도구나 사람이 넣어 둔 `a.txt` 가 이미 그 파일을 무시하고 있는데 `/a.txt` 를 또
// 넣으면 중복이다 (V200). 주석과 빈 줄은 패턴이 아니다.
func ignoreLines(body string) map[string]bool {
	out := map[string]bool{}
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "#") {
			continue
		}
		if !strings.HasPrefix(l, "/") {
			l = "/" + l
		}
		out[l] = true
	}
	return out
}
