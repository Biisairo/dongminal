package cli

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// `dongminal verify` 의 경계 검사 (M2, 2026-09-11 사용자 판정).
//
// **왜 여기인가.** 유닛 테스트는 가짜 배선에서 돌고, e2e 는 브라우저를 지난다.
// 그 둘 사이에 "설치된 실물 서버에서 이 경계가 실제로 서 있는가" 를 묻는 자리가
// 없었다 — M2 가 세운 게이트는 대부분 그 자리에서만 확인된다.
//
// §2.12 의 정정을 지킨다: verify 는 **런타임 종단간** 검사이며 정적 검사의 자리가
// 아니다. 아래 다섯은 전부 실제로 뜬 서버(또는 실제로 돌린 기동)를 두드린다.

// verifyOutsidePath 는 어떤 허용 루트에도 들 수 없는 절대경로다.
//
// **OS 갈래를 만들지 않는다** (FR-E2S-0). 볼륨 루트 바로 아래의 이름 하나면
// 어디서나 홈 밖이고, 실재하지 않아도 판정은 같다 — 경계는 "루트 안인가" 를 먼저
// 묻고 그 답이 아니오이기 때문이다.
func verifyOutsidePath(home string) string {
	vol := filepath.VolumeName(home)
	return filepath.Join(vol+string(filepath.Separator), "dongminal-verify-outside", "x.txt")
}

// registerRepo 는 검사 대상 저장소를 **워크스페이스에 등록한다**
// (FILE_API_BOUNDARY_SRS FR-FAB-14c).
//
// `repo` 인자도 이제 경계를 지난다 — 워크스페이스가 모르는 저장소는 403 이다.
// 제품의 UI 흐름은 `openGitWindow` 가 열기 전에 등록하므로(`FR-RTU-72`) 이 계약을
// 이미 지키고, 이 검사만 그 걸음을 건너뛰고 있었다.
//
// **격리 홈에서는 이 걸음이 필수다.** 검사는 자기 홈을 새로 잡고 대상 저장소는
// 체크아웃 자리에 있다 — 리눅스 러너에서는 둘 다 `/home/runner` 아래라 우연히
// 통과하지만, Windows 러너는 체크아웃이 `D:\` 이고 홈이 `C:\` 다. 우연에 기대면
// 한쪽 러너에서만 빨개진다.
func (s *verifySession) registerRepo() (string, error) {
	body := strings.NewReader(`{"path":` + strconv.Quote(s.repo) + `}`)
	resp, err := s.http.Post(s.base+"/api/editors/add", "application/json", body)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("editors/add → %d", resp.StatusCode)
	}
	return s.repo, nil
}

func (s *verifySession) fileOutsideRootIs403() (string, error) {
	p := verifyOutsidePath(s.home)
	code, err := s.status("/api/file/read?path=" + url.QueryEscape(p))
	if err != nil {
		return "", err
	}
	if code != http.StatusForbidden {
		return "", fmt.Errorf("%s → %d, want 403 — 경계가 서 있지 않다", p, code)
	}
	return p, nil
}

// 상한 초과는 **실제 파일**로 확인한다. sparse 로 만들어 디스크를 쓰지 않는다 —
// 크기는 `Stat` 이 답하므로 내용이 필요 없다.
func (s *verifySession) fileOverLimitIs413() (string, error) {
	const over = 10<<20 + 1
	p := filepath.Join(s.home, "verify-too-large.bin")
	f, err := os.Create(p)
	if err != nil {
		return "", fmt.Errorf("큰 파일을 만들지 못했다: %w", err)
	}
	if err := f.Truncate(over); err != nil {
		f.Close()
		return "", fmt.Errorf("크기를 잡지 못했다: %w", err)
	}
	f.Close()
	defer os.Remove(p)

	code, err := s.status("/api/file/read?path=" + url.QueryEscape(p))
	if err != nil {
		return "", err
	}
	if code != http.StatusRequestEntityTooLarge {
		return "", fmt.Errorf("%d바이트 읽기 → %d, want 413", over, code)
	}
	return "10MiB 초과 → 413", nil
}

func (s *verifySession) staticSecurityHeaders() (string, error) {
	resp, err := s.http.Get(s.base + "/")
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options"} {
		if resp.Header.Get(h) == "" {
			return "", fmt.Errorf("%s 가 없다", h)
		}
	}
	return "CSP · X-Frame-Options · nosniff", nil
}

// exposeGateBlocks 는 **실제 기동을 돌려** 노출 게이트를 확인한다
// (REQUEST_GATE_SRS FR-RQG-20).
//
// 격리 홈을 새로 하나 더 잡는다 — 그 자리에는 `access.json` 이 없으므로 거부가
// 정답이다. 거부되면 아무것도 뜨지 않는다. 만에 하나 통과하면 그때는 LAN 에 무인증
// 서버가 선 것이므로, 실패로 적기 **전에** 정리부터 한다.
func (s *verifySession) exposeGateBlocks() (string, error) {
	home, port, err := resolveStartTarget(StartOpts{Isolated: true})
	if err != nil {
		return "", fmt.Errorf("격리 대상 준비 실패: %w", err)
	}
	if err := guardIsolated(home, port, userHomeDir()); err != nil {
		return "", fmt.Errorf("격리 가드: %w", err)
	}
	defer os.RemoveAll(home)

	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("실행 파일 경로 확인 실패: %w", err)
	}
	cmd := exec.Command(exe, "start", "--expose", "--home", home, "--port", port)
	cmd.Env = append(os.Environ(), EnvHome+"="+home, EnvPort+"="+port)
	out, runErr := cmd.CombinedOutput()
	if runErr == nil {
		// 떴다는 뜻이다. 남겨 두면 이 검사가 곧 사고가 된다.
		if pid, alive := daemonPID(home); alive {
			stopVerifyPID(pid)
		}
		return "", fmt.Errorf("허용 목록이 없는데 노출 기동이 통과했다: %s", out)
	}
	return "허용 목록 없이 노출 기동 → 거부", nil
}
