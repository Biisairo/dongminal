package runtimebin

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/serverconf"
)

// HOT_REBIND_SRS 묶음 D — 헬퍼의 서버 주소 찾기 (FR-HRB-12·13·14).

// addrHome 은 사용 중인 홈이 아닌 임시 홈을 DONGMINAL_HOME 으로 세운다.
func addrHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if real, err := os.UserHomeDir(); err == nil && filepath.Dir(home) == filepath.Join(real, dmenv.DefaultHomeDir) {
		t.Fatalf("임시 홈이 사용 중인 홈 아래다: %s", home)
	}
	t.Setenv(dmenv.EnvHome, home)
	t.Setenv(dmenv.EnvHost, "")
	t.Setenv(dmenv.EnvPort, "")
	return home
}

// TC-HRB-5: 주소 파일이 먼저다. 옛 셸의 DONGMINAL_PORT·HOST 는 읽지 않는다. 0.0.0.0 은 127.0.0.1 로 붙는다.
func TestServerAddrPrefersAddrFile(t *testing.T) {
	home := addrHome(t)
	if err := serverconf.WriteAddr(home, "0.0.0.0:9400"); err != nil {
		t.Fatal(err)
	}
	t.Setenv(dmenv.EnvPort, "1111")
	t.Setenv(dmenv.EnvHost, "127.0.0.1")
	if got, want := baseURL(), "http://127.0.0.1:9400"; got != want {
		t.Errorf("baseURL = %q want %q", got, want)
	}
	if got := currentPort(); got != "9400" {
		t.Errorf("currentPort = %q", got)
	}
}

// TC-HRB-5: 요청마다 다시 읽는다 — 리바인드 뒤 같은 프로세스가 새 주소로 간다.
func TestServerAddrRereadsEachCall(t *testing.T) {
	home := addrHome(t)
	if err := serverconf.WriteAddr(home, "127.0.0.1:9401"); err != nil {
		t.Fatal(err)
	}
	_ = baseURL()
	if err := serverconf.WriteAddr(home, "127.0.0.1:9402"); err != nil {
		t.Fatal(err)
	}
	if got := baseURL(); got != "http://127.0.0.1:9402" {
		t.Errorf("baseURL = %q", got)
	}
}

// TC-HRB-5: 주소 파일이 없으면 server.json, 그것도 없으면 기본값.
func TestServerAddrFallsBack(t *testing.T) {
	home := addrHome(t)
	t.Setenv(dmenv.EnvPort, "1111")
	if got := baseURL(); got != dmenv.BaseURL(dmenv.DefaultHost, dmenv.DefaultPort) {
		t.Errorf("기본값이 아니다: %q", got)
	}
	if err := serverconf.SetBind(home, "", "9403"); err != nil {
		t.Fatal(err)
	}
	if got := baseURL(); got != "http://127.0.0.1:9403" {
		t.Errorf("server.json 이 아니다: %q", got)
	}
}

// TC-HRB-6 (FR-HRB-13): 컨테이너 안(호스트가 게이트웨이)에서는 마운트한 주소 파일의
// 포트를 쓰고, 없으면 기동 때의 포트(DONGMINAL_PORT)를 쓴다.
func TestServerAddrInContainer(t *testing.T) {
	addrHome(t)
	dir := t.TempDir()
	prev := containerAddrFile
	containerAddrFile = filepath.Join(dir, serverconf.AddrFileName)
	t.Cleanup(func() { containerAddrFile = prev })
	t.Setenv(dmenv.EnvHost, dmenv.ContainerHost)
	t.Setenv(dmenv.EnvPort, "9500")

	if got, want := baseURL(), "http://"+dmenv.ContainerHost+":9500"; got != want {
		t.Errorf("파일 없음: %q want %q", got, want)
	}
	if err := os.WriteFile(containerAddrFile, []byte("0.0.0.0:9501\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, want := baseURL(), "http://"+dmenv.ContainerHost+":9501"; got != want {
		t.Errorf("파일 있음: %q want %q", got, want)
	}
}

// pointedAddr 는 마지막 pointAt 의 주소다. 시험이 홈을 바꾸면 setTestHome 이 새 홈에 옮겨 쓴다.
var pointedAddr string

// pointAt 은 헬퍼가 host:port 의 서버를 찾게 한다. 물러설 홈(fallbackHome)을 새 임시
// 폴더로 바꿔 거기에 주소 파일을 쓰고, 이미 세운 임시 홈이 있으면 그 홈에도 쓴다.
// 사용 중인 홈에는 쓰지 않는다.
func pointAt(t *testing.T, host, port string) {
	t.Helper()
	addr := net.JoinHostPort(host, port)
	fb := t.TempDir()
	prevFB, prevAddr := fallbackHome, pointedAddr
	fallbackHome = func() string { return fb }
	pointedAddr = addr
	t.Cleanup(func() { fallbackHome, pointedAddr = prevFB, prevAddr })
	if err := serverconf.WriteAddr(fb, addr); err != nil {
		t.Fatal(err)
	}
	if home := os.Getenv(dmenv.EnvHome); home != "" {
		if !strings.HasPrefix(home, os.TempDir()) {
			t.Fatalf("임시 홈이 아니다: %s", home)
		}
		if err := serverconf.WriteAddr(home, addr); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(dmenv.EnvHost, "")
	t.Setenv(dmenv.EnvPort, "")
}

// setTestHome 은 DONGMINAL_HOME 을 home 으로 세우고, pointAt 한 주소가 있으면 그 홈에도 쓴다.
func setTestHome(t *testing.T, home string) {
	t.Helper()
	t.Setenv(dmenv.EnvHome, home)
	if pointedAddr != "" {
		if err := serverconf.WriteAddr(home, pointedAddr); err != nil {
			t.Fatal(err)
		}
	}
}
