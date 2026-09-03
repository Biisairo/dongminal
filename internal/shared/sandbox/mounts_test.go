package sandbox

import (
	"io/fs"
	"strings"
	"testing"
)

func homeOf(h string) func() (string, error) {
	return func() (string, error) { return h, nil }
}

// 간편 형식은 docker -v 관용구 그대로다 — 새 문법을 배우지 않아도 된다.
func TestParseMount_ShorthandForms(t *testing.T) {
	cases := []struct {
		in   string
		want Mount
	}{
		{"/a:/b", Mount{Host: "/a", Container: "/b"}},
		{"/a:/b:ro", Mount{Host: "/a", Container: "/b", ReadOnly: true}},
		{"/a:/b:rw", Mount{Host: "/a", Container: "/b"}},
		// 호스트 경로에 콜론이 들어가는 Windows 를 견뎌야 한다. 컨테이너 경로는
		// 게스트가 리눅스이므로 언제나 "/" 로 시작한다 — 그것이 갈림점이다.
		{`C:\src\app:/work`, Mount{Host: `C:\src\app`, Container: "/work"}},
		{`C:\src\app:/work:ro`, Mount{Host: `C:\src\app`, Container: "/work", ReadOnly: true}},
	}
	for _, c := range cases {
		got, err := ParseMount(c.in, homeOf("/home/u"))
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		if got.Host != c.want.Host || got.Container != c.want.Container || got.ReadOnly != c.want.ReadOnly {
			t.Errorf("%q → %+v, want %+v", c.in, got, c.want)
		}
	}
}

// FR-SBX-39: ~ 는 사용자 홈으로 편다.
func TestParseMount_ExpandsTilde(t *testing.T) {
	got, err := ParseMount("~/.ssh:/root/.ssh:ro", homeOf("/home/u"))
	if err != nil {
		t.Fatalf("ParseMount: %v", err)
	}
	if got.Host != "/home/u/.ssh" {
		t.Errorf("~ 가 펴지지 않았다: %q", got.Host)
	}
	if !got.ReadOnly {
		t.Error("읽기 전용이 아니다")
	}
}

func TestParseMount_RejectsMalformed(t *testing.T) {
	for _, in := range []string{"", "/onlyhost", "/a:relative", ":/b", "/a:"} {
		if got, err := ParseMount(in, homeOf("/home/u")); err == nil {
			t.Errorf("%q 가 통과했다: %+v", in, got)
		}
	}
}

// 세부 형식은 scratch 적용 여부까지 적는다 (FR-SBX-39b).
func TestLoadProfiles_ReadsBaseMounts(t *testing.T) {
	got, err := loadProfiles("x.json", readerOf(`{
	  "mounts": [
	    "~/.claude:/root/.claude",
	    {"host":"~/.ssh","container":"/root/.ssh","readonly":true},
	    {"host":"/shared","container":"/shared","scratch":true}
	  ],
	  "dev": {"image":"node:22"}
	}`, nil), homeOf("/home/u"))
	if err != nil {
		t.Fatalf("loadProfiles: %v", err)
	}

	dev := got[ProfileDev]
	if len(dev.BaseMounts) != 3 {
		t.Fatalf("dev 의 기본 마운트가 %d 개다: %+v", len(dev.BaseMounts), dev.BaseMounts)
	}
	if dev.BaseMounts[0].Host != "/home/u/.claude" {
		t.Errorf("~ 가 펴지지 않았다: %+v", dev.BaseMounts[0])
	}
	if !dev.BaseMounts[1].ReadOnly {
		t.Errorf("읽기 전용이 반영되지 않았다: %+v", dev.BaseMounts[1])
	}

	// FR-SBX-39a: scratch 는 기본적으로 비어 있고, 표식이 붙은 항목만 들어간다.
	scratch := got[ProfileScratch]
	if len(scratch.BaseMounts) != 1 || scratch.BaseMounts[0].Container != "/shared" {
		t.Fatalf("scratch 의 기본 마운트가 다르다: %+v", scratch.BaseMounts)
	}
}

// FR-SBX-39a: 표식 없는 항목만 있으면 scratch 는 비어 있다.
func TestLoadProfiles_ScratchStaysEmptyByDefault(t *testing.T) {
	got, err := loadProfiles("x.json", readerOf(`{
	  "mounts": ["~/.ssh:/root/.ssh:ro"],
	  "dev": {"image":"node:22"}
	}`, nil), homeOf("/home/u"))
	if err != nil {
		t.Fatalf("loadProfiles: %v", err)
	}
	if len(got[ProfileScratch].BaseMounts) != 0 {
		t.Fatalf("scratch 에 기본 마운트가 붙었다: %+v", got[ProfileScratch].BaseMounts)
	}
}

// FR-SBX-39b: scratch 에 마운트가 붙으면 그 창은 격리 경계가 아니다. 등급이
// 정책에서 파생되므로 표기가 저절로 따라온다 (FR-SBX-37).
func TestProfileInfo_ScratchWithMountIsNotABoundary(t *testing.T) {
	p := Scratch()
	if !p.Info().Isolated {
		t.Fatal("빈 scratch 가 경계가 아니라고 나온다")
	}
	p.BaseMounts = []Mount{{Host: "/shared", Container: "/shared", ReadOnly: true}}
	if p.Info().Isolated {
		t.Fatal("마운트가 붙었는데 경계라고 나온다 — 읽기 전용이어도 내용은 유출된다")
	}
}

func TestLoadProfiles_RejectsBadMount(t *testing.T) {
	if _, err := loadProfiles("x.json", readerOf(`{"mounts":["nonsense"]}`, nil), homeOf("/h")); err == nil {
		t.Fatal("깨진 마운트가 통과했다")
	}
}

// ── FR-SBX-39: 기본 마운트가 컨테이너에 붙는다 ──

func TestEnsure_AppliesBaseMounts(t *testing.T) {
	f := &fakeDocker{reply: stateReply("")}
	p := devProfile()
	p.BaseMounts = []Mount{
		{Host: "/home/u/.claude", Container: "/root/.claude"},
		{Host: "/home/u/.ssh", Container: "/root/.ssh", ReadOnly: true},
	}
	if err := newMgr(f).Ensure("w1", p, RunSpec{HostDir: "/proj"}); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	got := joined(f.call("run"))
	for _, want := range []string{
		"-v /proj:" + ContainerWorkdir,
		"-v /home/u/.claude:/root/.claude",
		"-v /home/u/.ssh:/root/.ssh:ro",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("%q 가 없다: %s", want, got)
		}
	}
}

// ── FR-SBX-39/41: 원본 검증 ──

func statOf(present map[string]bool) func(string) error {
	return func(p string) error {
		if present[p] {
			return nil
		}
		return fs.ErrNotExist
	}
}

// 사용자가 직접 적은 경로는 오타를 알려야 한다.
func TestVerifyMounts_MissingSourceIsAnError(t *testing.T) {
	ms := []Mount{{Host: "/nope", Container: "/x"}}
	err := VerifyMounts(ms, statOf(map[string]bool{}))
	if err == nil {
		t.Fatal("없는 원본이 통과했다")
	}
	if !strings.Contains(err.Error(), "/nope") {
		t.Errorf("어느 경로인지 말하지 않는다: %v", err)
	}
}

func TestVerifyMounts_PresentSourcesPass(t *testing.T) {
	ms := []Mount{{Host: "/a", Container: "/x"}, {Host: "/b", Container: "/y"}}
	if err := VerifyMounts(ms, statOf(map[string]bool{"/a": true, "/b": true})); err != nil {
		t.Fatalf("실재하는 원본이 막혔다: %v", err)
	}
}
