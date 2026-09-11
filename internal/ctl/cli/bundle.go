package cli

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	gitcore "dongminal/internal/webserver/domain/git/core"

	"dongminal/internal/shared/platform"
)

// `G2-3`(PRODUCTION_ROADMAP §M3) — 진단 번들.
//
// 사용자가 문제를 신고할 때 우리가 묻는 것은 언제나 같다: 판·OS·홈에 무엇이
// 있는지·로그의 끝·설정. 그것을 매번 손으로 모으게 하면 신고가 오지 않는다.
//
// **비밀이 새면 번들 자체가 위험이다.** 담는 것을 좁히고, 담는 것은 마스킹을
// 지난다. 마스킹은 이 저장소의 **유일한 규칙**(`SanitizeRemote`)을 재사용한다 —
// 두 벌로 두면 새 URL 형태가 나왔을 때 한쪽만 고쳐지고, 고쳐지지 않은 쪽이 유출
// 경로가 된다.

// bundleLogTail 은 로그마다 담는 끝부분의 크기다. 사고 직후에 필요한 것은 그
// 직전 기록이며, 전문을 담으면 번들이 수십 MB 가 되고 비밀이 들어갈 면도 넓어진다.
const bundleLogTail = 64 << 10

// bundleSettings 는 그대로 담는 설정 파일들이다. 사용자가 만든 값이고 비밀이
// 들어갈 자리가 아니다 — `access.json` 은 **허용 출발지 목록**이지 자격이 아니다.
var bundleSettings = []string{"settings.json", "access.json"}

// RunDoctorBundle 은 `dongminal doctor --bundle <파일>` 이다.
func RunDoctorBundle(o DoctorOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	f, err := os.Create(o.Bundle)
	if err != nil {
		fmt.Fprintf(stderr, "번들을 만들 수 없습니다: %v\n", err)
		return 1
	}
	defer f.Close()
	z := zip.NewWriter(f)

	add := func(name, body string) {
		w, err := z.Create(name)
		if err != nil {
			return
		}
		// **모든 항목이 마스킹을 지난다.** 자리마다 고르면 새로 더한 자리가 빠진다.
		io.WriteString(w, gitcore.SanitizeRemote(body))
	}

	add("about.txt", bundleAbout(home))
	add("home-files.txt", bundleHomeListing(home))
	for _, n := range bundleSettings {
		if blob, err := os.ReadFile(filepath.Join(home, n)); err == nil {
			add(n, string(blob))
		}
	}
	for _, n := range homeLogs {
		if body := tailOf(filepath.Join(home, n), bundleLogTail); body != "" {
			add("logs/"+n, body)
		}
	}
	if err := z.Close(); err != nil {
		fmt.Fprintf(stderr, "번들을 닫지 못했습니다: %v\n", err)
		return 1
	}
	fmt.Fprintf(stdout, "✅ 진단 번들: %s\n", o.Bundle)
	fmt.Fprintln(stdout, "   붙이기 전에 한 번 열어 확인해 주세요 — 담는 것을 좁혔지만 최종 판단은 보내는 분의 것입니다.")
	return 0
}

// bundleAbout 은 "무엇을 받았는가" 다. 첫 질문이 늘 이것이다.
func bundleAbout(home string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "version: %s\n", Version)
	fmt.Fprintf(&b, "target: %s\n", platform.BuildTarget())
	fmt.Fprintf(&b, "go: %s\n", runtime.Version())
	// 홈의 **경로**는 담지 않는다 — 사용자 이름이 들어간다. 있는지만 말한다.
	st, err := os.Stat(home)
	fmt.Fprintf(&b, "home-exists: %v\n", err == nil && st.IsDir())
	// OBSERVABILITY_SRS FR-OBS-17: 마지막 종료가 정상이었는지 (M5 `G2-6`).
	//
	// **새 수집기를 만들지 않는다** — 번들은 이미 있고 마스킹도 `SanitizeRemote`
	// 한 벌이다 (D-OBS-6). 워크스페이스 손상과 강제 종료는 증상이 같고 조치가
	// 다르므로, 신고를 받을 때 가장 먼저 보는 값이다.
	le := platform.ReadLastExit(home)
	switch {
	case le.First:
		fmt.Fprintln(&b, "last-exit: unknown (마커 없음 — 첫 기동이거나 지워졌습니다)")
	case le.Crashed:
		fmt.Fprintln(&b, "last-exit: CRASH (정상 종료 경로를 지나지 않았습니다)")
	default:
		fmt.Fprintf(&b, "last-exit: %s\n", le.Raw)
	}
	return b.String()
}

// bundleHomeListing 은 홈에 **무엇이 있는가** 다 — 이름과 크기이지 내용이 아니다.
// "그 파일이 있는가·비었는가" 가 진단의 절반이고, 내용은 그 다음 질문이다.
func bundleHomeListing(home string) string {
	ents, err := os.ReadDir(home)
	if err != nil {
		return "(홈을 읽을 수 없습니다)\n"
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		info, err := e.Info()
		if err != nil {
			continue
		}
		kind := "file"
		if e.IsDir() {
			kind = "dir"
		}
		names = append(names, fmt.Sprintf("%-40s %-5s %d", e.Name(), kind, info.Size()))
	}
	sort.Strings(names)
	return strings.Join(names, "\n") + "\n"
}

// tailOf 는 파일의 끝 n 바이트다. 없으면 빈 문자열이다.
func tailOf(path string, n int64) string {
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	if st.Size() > n {
		if _, err := f.Seek(st.Size()-n, io.SeekStart); err != nil {
			return ""
		}
	}
	blob, err := io.ReadAll(f)
	if err != nil {
		return ""
	}
	return string(blob)
}
