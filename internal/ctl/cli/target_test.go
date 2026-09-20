package cli

import (
	"strings"
	"testing"
)

// STRUCTURE_CLEANUP_SRS 묶음 B · TC-STR-6·7.
//
// **재는 것은 "겨누는 명령이 `start` 와 같은 서버를 보는가" 하나다.**
//
// 종전에는 `health`·`window`·`stop`·`migrate` 가 `Common.ResolvePort` 의 3계층에
// 머물러 `server.json` 을 보지 못했다. 그 결과 `{"port":"9000"}` 한 줄이 다섯
// 명령을 갈랐고, `stop` 은 `killPort` 로 **남의 프로세스를 죽였다.**

// TC-STR-6: 파일 계층이 실제로 닿는다 — 겨누는 명령 넷이 같은 타입을 지나므로
// 이 하나가 넷을 잠근다. "그 타입을 지나는가" 는 `check-server-target.sh` 가 센다.
func TestResolveTargetReadsServerJSON(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{"host":"192.168.1.5","port":"9000"}`)
	isolateEnv(t, home)

	tgt, err := Common{}.ResolveTarget()
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if tgt.Port != "9000" {
		t.Errorf("Port = %q, want 9000 — server.json 이 안 닿는다", tgt.Port)
	}
	if tgt.Host != "192.168.1.5" {
		t.Errorf("Host = %q, want 192.168.1.5", tgt.Host)
	}
	// 두드릴 주소는 조립까지 끝나 있어야 한다 — 부르는 쪽이 다시 잇지 않는다.
	if tgt.URL != "http://192.168.1.5:9000" {
		t.Errorf("URL = %q", tgt.URL)
	}
	if tgt.Home != home {
		t.Errorf("Home = %q, want %q", tgt.Home, home)
	}
}

// TC-STR-6: `start` 와 값이 **같다.** 두 해석이 갈리면 띄운 자리와 겨누는 자리가
// 어긋나고, 그것이 이 묶음이 고친 결함이다.
func TestResolveTargetMatchesStart(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{"host":"0.0.0.0","port":"9000"}`)
	isolateEnv(t, home)

	tgt, err := Common{}.ResolveTarget()
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	// `start` 가 쓰는 조립. 미지정 주소는 바인드 대상이지 접속 대상이 아니므로
	// 두 자리 모두 loopback 으로 두드려야 한다.
	if want := ServerURL("0.0.0.0", "9000"); tgt.URL != want {
		t.Errorf("URL = %q, start 는 %q", tgt.URL, want)
	}
}

// TC-STR-7: 계층 순서는 그대로다 — 플래그가 파일을 이긴다 (FR-CFG-13).
func TestResolveTargetFlagBeatsFile(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{"port":"9000"}`)
	isolateEnv(t, home)

	tgt, err := Common{Port: "7777"}.ResolveTarget()
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if tgt.Port != "7777" {
		t.Errorf("Port = %q, want 7777 — 플래그가 파일에 졌다", tgt.Port)
	}
}

// TC-STR-7: 환경변수가 파일을 이긴다.
func TestResolveTargetEnvBeatsFile(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{"port":"9000"}`)
	isolateEnv(t, home)
	t.Setenv("PORT", "8888")

	tgt, err := Common{}.ResolveTarget()
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if tgt.Port != "8888" {
		t.Errorf("Port = %q, want 8888", tgt.Port)
	}
}

// 잘못된 포트는 **두드리기 전에** 잡는다 (FR-CFG-19 와 같은 이유). 종전에는
// 그 값으로 ping 해서 "응답 없음" 이 나왔고, 그 문구에는 어느 값이 잘못됐는지가
// 없었다.
func TestResolveTargetRejectsBadPort(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{"port":"abc"}`)
	isolateEnv(t, home)

	if _, err := (Common{}).ResolveTarget(); err == nil {
		t.Fatal("잘못된 포트가 그대로 지나간다")
	} else if !strings.Contains(err.Error(), "abc") {
		t.Fatalf("어느 값이 잘못됐는지 말하지 않는다: %v", err)
	}
}

// 깨진 `server.json` 은 **막지 않는다** (FR-CFG-15 / D-CFG-3) — 경고를 나르되
// 기본값으로 답한다. 설정 파일 하나가 `stop` 을 못 돌게 만들면 사용자는 그것을
// 고칠 자리에 닿을 수 없다.
func TestResolveTargetCarriesWarnings(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{not json`)
	isolateEnv(t, home)

	tgt, err := Common{}.ResolveTarget()
	if err != nil {
		t.Fatalf("깨진 파일이 명령을 막았다: %v", err)
	}
	if len(tgt.Warnings) == 0 {
		t.Error("경고를 버렸다 — 사용자는 파일이 무시된 것을 모른다")
	}
	if tgt.Port != DefaultPort {
		t.Errorf("Port = %q, want 기본값 %q", tgt.Port, DefaultPort)
	}
}
