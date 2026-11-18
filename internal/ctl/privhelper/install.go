// Package privhelper 는 사람 명령의 도우미다 (PEER_CHAT_SRS §3.12, FR-PCH-72~79). 관리자 권한으로
// 돌며 TOTP 를 확인하고 사람 명령 묶음에 서명한다. `dongminal helper` 하위 명령이다 (D-PCH-38).
package privhelper

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/humancmd"
	"dongminal/internal/shared/platform"
)

// 자리다 (FR-PCH-72).
const (
	Label      = "com.dongminal.helper"
	binPath    = "/Library/PrivilegedHelperTools/" + Label
	plistPath  = "/Library/LaunchDaemons/" + Label + ".plist"
	secretDir  = "/Library/Application Support/" + Label
	secretPath = secretDir + "/secret.json"
	logPath    = "/var/log/" + Label + ".log"
)

// Usage 는 `dongminal helper --help` 다.
const Usage = `사용법: dongminal helper <install|uninstall|run|status>

  install    (sudo) 도우미를 관리자 자리에 복사하고 LaunchDaemon 으로 등록한다.
             처음이면 TOTP 비밀과 복구 코드를 한 번만 보인다.
  uninstall  (sudo) 등록을 내리고 프로그램과 비밀 파일을 지운다.
  run        LaunchDaemon 이 부른다. 직접 부르지 않는다.
  status     도우미가 떠 있는지와 공개키 지문을 보인다.

install 은 dongminal 탭이 아닌 OS 기본 터미널 앱에서 실행한다 — dongminal 탭의 화면은
에이전트가 읽을 수 있다. 지금은 macOS 만 된다.
`

// Main 은 `dongminal helper` 를 실행한다.
func Main(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, Usage)
		return 2
	}
	switch args[0] {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, Usage)
		return 0
	case "status":
		return status(stdout)
	case "install", "uninstall", "run":
	default:
		fmt.Fprintf(stderr, "알 수 없는 하위 명령: %s\n%s", args[0], Usage)
		return 2
	}
	if !supported {
		fmt.Fprintln(stderr, "도우미는 아직 macOS 만 된다 (FR-PCH-79)")
		return 1
	}
	switch args[0] {
	case "install":
		return fail(stderr, install(stdout, stderr))
	case "uninstall":
		return fail(stderr, uninstall(stdout))
	}
	return fail(stderr, run())
}

func fail(stderr io.Writer, err error) int {
	if err == nil {
		return 0
	}
	fmt.Fprintln(stderr, "dongminal helper:", err)
	return 1
}

func status(stdout io.Writer) int {
	info, err := humancmd.Client{Path: humancmd.SocketPath, Timeout: 2 * time.Second}.Info()
	if err != nil {
		fmt.Fprintln(stdout, "도우미가 없거나 닿지 않는다")
		return 1
	}
	fmt.Fprintf(stdout, "도우미가 떠 있다. 공개키 %s\n", info.Key)
	if info.LockedUntil != 0 {
		fmt.Fprintf(stdout, "잠김: %s 까지\n", time.UnixMilli(info.LockedUntil).Format(time.RFC3339))
	}
	return 0
}

var errNotRoot = errors.New("sudo 로 실행한다")

// installer 는 sudo 를 부른 사용자다.
func installer() (int, string, error) {
	if os.Geteuid() != 0 {
		return 0, "", errNotRoot
	}
	uid, err := strconv.Atoi(os.Getenv("SUDO_UID"))
	if err != nil || uid == 0 {
		return 0, "", errors.New("SUDO_UID 가 없다 — 보통 사용자로 sudo 를 거쳐 실행한다")
	}
	return uid, os.Getenv("SUDO_USER"), nil
}

func install(stdout, stderr io.Writer) error {
	uid, user, err := installer()
	if err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return err
	}
	return runInstall(installEnv{
		uid: uid, user: user, self: self,
		binDir: filepath.Dir(binPath), bin: binPath, plist: plistPath, secret: secretPath,
		out: stdout, errw: stderr,
		own: func(p string) error { return os.Chown(p, 0, 0) },
		launch: func() error {
			_ = exec.Command("launchctl", "bootout", "system/"+Label).Run()
			if out, err := exec.Command("launchctl", "bootstrap", "system", plistPath).CombinedOutput(); err != nil {
				return fmt.Errorf("launchctl bootstrap: %v: %s", err, strings.TrimSpace(string(out)))
			}
			return nil
		},
		nopasswd: func() bool {
			if user == "" {
				return false
			}
			out, _ := exec.Command("sudo", "-l", "-U", user).Output()
			return strings.Contains(string(out), "NOPASSWD")
		},
	})
}

// installEnv 는 설치 한 번의 자리와 바깥 동작이다. 시험이 바꿔 끼운다.
type installEnv struct {
	uid                        int
	user, self                 string
	binDir, bin, plist, secret string
	out, errw                  io.Writer
	own                        func(path string) error
	launch                     func() error
	nopasswd                   func() bool
}

// runInstall 의 순서 (§3.12a R-1·R-8): 비밀 확인(다른 사용자면 멈춤) → 처음이면 비밀을 만들어
// 저장하고 바로 보임 → 프로그램 폴더를 만들고 복사 → plist → launchctl.
func runInstall(e installEnv) error {
	sec, err := loadSecret(e.secret)
	switch {
	case err == nil:
		if sec.UID != e.uid {
			return fmt.Errorf("다른 사용자(uid %d)로 등록되어 있다 — uninstall 뒤 다시 설치한다", sec.UID)
		}
		fmt.Fprintln(e.out, "이미 등록되어 있다. 비밀과 서명 키는 그대로 두고 프로그램만 바꾼다.")
	case os.IsNotExist(err):
		s, codes, err := newSecret(e.uid)
		if err != nil {
			return err
		}
		if err := saveSecret(e.secret, s); err != nil {
			return fmt.Errorf("비밀 파일: %w", err)
		}
		printEnrollment(e.out, s, codes, e.user)
	default:
		return fmt.Errorf("비밀 파일: %w", err)
	}
	if err := os.MkdirAll(e.binDir, 0o755); err != nil {
		return err
	}
	if err := copyFile(e.self, e.bin, 0o755, e.own); err != nil {
		return fmt.Errorf("프로그램 복사: %w", err)
	}
	if err := os.WriteFile(e.plist, []byte(plist(e.bin)), 0o644); err != nil {
		return err
	}
	if err := e.launch(); err != nil {
		return err
	}
	if e.nopasswd() {
		fmt.Fprintln(e.errw, "경고: 이 사용자의 sudo 에 NOPASSWD 가 있다. 에이전트가 암호 없이 관리자 권한을 얻으면 도우미를 지킬 수 없다.")
	}
	fmt.Fprintln(e.out, "도우미를 등록했다.")
	return nil
}

// printEnrollment 는 OTP 앱에 넣을 값과 복구 코드를 한 번만 보인다 (FR-PCH-76·77).
func printEnrollment(w io.Writer, sec Secret, codes []string, user string) {
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "아래 값은 지금 한 번만 보인다. 이 창은 dongminal 탭이 아닌 OS 기본 터미널이어야 한다.")
	fmt.Fprintln(w, "휴대폰 OTP 앱(Ente Auth 권장)에 '직접 입력'으로 넣는다.")
	fmt.Fprintln(w, "")
	fmt.Fprintf(w, "  계정 이름  dongminal (%s)\n", user)
	fmt.Fprintf(w, "  비밀       %s\n", groupBy4(sec.TOTP))
	fmt.Fprintln(w, "  방식       TOTP · SHA1 · 6자리 · 30초")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "복구 코드 (휴대폰을 잃었을 때 코드 대신 한 번씩 쓴다. 따로 적어 둔다):")
	for _, c := range codes {
		fmt.Fprintf(w, "  %s\n", c)
	}
	fmt.Fprintln(w, "")
}

func groupBy4(s string) string {
	var b strings.Builder
	for i, r := range s {
		if i > 0 && i%4 == 0 {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func uninstall(stdout io.Writer) error {
	if _, _, err := installer(); err != nil {
		return err
	}
	_ = exec.Command("launchctl", "bootout", "system/"+Label).Run()
	for _, p := range []string{plistPath, binPath, humancmd.SocketPath} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := os.RemoveAll(secretDir); err != nil {
		return err
	}
	fmt.Fprintln(stdout, "도우미를 지웠다.")
	return nil
}

// run 은 LaunchDaemon 이 부른다. 비밀을 읽고 소켓을 열어 설치한 사용자에게 넘긴다.
func run() error {
	if os.Geteuid() != 0 {
		return errNotRoot
	}
	sec, err := loadSecret(secretPath)
	if err != nil {
		return err
	}
	srv, err := NewServer(&sec, time.Now, func(s Secret) error { return saveSecret(secretPath, s) })
	if err != nil {
		return err
	}
	ipc := platform.Current().IPC
	_ = ipc.Remove(humancmd.SocketPath)
	ln, err := ipc.Listen(humancmd.SocketPath)
	if err != nil {
		return err
	}
	if err := os.Chown(humancmd.SocketPath, sec.UID, -1); err != nil {
		ln.Close()
		return err
	}
	return srv.Serve(ln)
}

func copyFile(src, dst string, mode os.FileMode, own func(string) error) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := own(tmp); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// plist 는 LaunchDaemon 정의다. root 로 `helper run` 을 띄우고 죽으면 다시 띄운다.
func plist(bin string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + Label + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + bin + `</string>
    <string>helper</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>` + logPath + `</string>
</dict>
</plist>
`
}
