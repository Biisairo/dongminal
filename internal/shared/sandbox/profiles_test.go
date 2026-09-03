package sandbox

import (
	"io/fs"
	"strings"
	"testing"
)

func readerOf(blob string, err error) func(string) ([]byte, error) {
	return func(string) ([]byte, error) {
		if err != nil {
			return nil, err
		}
		return []byte(blob), nil
	}
}

// FR-SBX-4: 정의 파일이 없으면 scratch 만 쓸 수 있다. 부재는 오류가 아니다 —
// 샌드박스를 쓰지 않는 사용자가 대부분이다.
func TestLoadProfiles_MissingFileYieldsScratchOnly(t *testing.T) {
	got, err := LoadProfiles("x.json", readerOf("", fs.ErrNotExist))
	if err != nil {
		t.Fatalf("파일 부재가 오류가 됐다: %v", err)
	}
	if _, ok := got[ProfileScratch]; !ok {
		t.Error("scratch 가 없다")
	}
	if len(got) != 1 {
		t.Errorf("scratch 말고 다른 것이 생겼다: %+v", got)
	}
}

func TestLoadProfiles_ReadsImageAndPorts(t *testing.T) {
	got, err := LoadProfiles("x.json", readerOf(`{
	  "dev":   {"image":"node:22","ports":[3000,"5173-5180"]},
	  "agent": {"image":"my-agent:latest"}
	}`, nil))
	if err != nil {
		t.Fatalf("LoadProfiles: %v", err)
	}
	dev := got["dev"]
	if dev.Image != "node:22" {
		t.Errorf("이미지가 다르다: %q", dev.Image)
	}
	if len(dev.Ports) != 2 || dev.Ports[0] != "3000" || dev.Ports[1] != "5173-5180" {
		t.Errorf("포트가 다르다: %v", dev.Ports)
	}
	// FR-SBX-1: dev·agent 는 cwd 를 마운트하고 네트워크를 연다. 그 정책은 파일이
	// 아니라 프로파일 종류가 정한다 — 사용자가 실수로 끌 수 있으면 안 된다.
	if !dev.Mount || dev.Network != "bridge" || !dev.Helper {
		t.Errorf("dev 정책이 다르다: %+v", dev)
	}
	if a := got["agent"]; !a.Mount || a.Network != "bridge" || !a.Helper {
		t.Errorf("agent 정책이 다르다: %+v", a)
	}
}

// FR-SBX-3: dev·agent 는 이미지가 없으면 성립하지 않는다.
func TestLoadProfiles_RejectsMissingImage(t *testing.T) {
	_, err := LoadProfiles("x.json", readerOf(`{"dev":{"ports":[3000]}}`, nil))
	if err == nil {
		t.Fatal("이미지 없는 dev 가 통과했다")
	}
	if !strings.Contains(err.Error(), "이미지") {
		t.Errorf("사유가 이미지를 가리키지 않는다: %v", err)
	}
}

// scratch 는 유일한 격리 경계다(§3.3). 설정 파일이 그 정책을 덮으면 —
// 네트워크를 열거나 헬퍼를 넣으면 — 경계가 조용히 사라진다.
func TestLoadProfiles_CannotRedefineScratch(t *testing.T) {
	_, err := LoadProfiles("x.json", readerOf(`{"scratch":{"image":"alpine"}}`, nil))
	if err == nil {
		t.Fatal("scratch 재정의가 통과했다 — 격리 경계가 설정으로 무너진다")
	}
}

func TestLoadProfiles_RejectsUnknownName(t *testing.T) {
	if _, err := LoadProfiles("x.json", readerOf(`{"nope":{"image":"alpine"}}`, nil)); err == nil {
		t.Fatal("알 수 없는 프로파일 이름이 통과했다")
	}
}

func TestLoadProfiles_BrokenJSONFails(t *testing.T) {
	// 깨진 파일을 "정의 없음" 으로 넘기면 사용자는 자기 설정이 무시된 줄 모른다.
	if _, err := LoadProfiles("x.json", readerOf(`{`, nil)); err == nil {
		t.Fatal("깨진 JSON 이 통과했다")
	}
}

// FR-SBX-23: 격리 등급은 정책에서 파생된다 — 헬퍼가 있거나 네트워크가 열려
// 있으면 경계가 아니다. 등급을 손으로 적으면 정책과 어긋나는 순간이 온다.
func TestProfileInfo_IsolationGradeFollowsPolicy(t *testing.T) {
	if got := Scratch().Info(); !got.Isolated {
		t.Errorf("scratch 가 경계로 보고되지 않았다: %+v", got)
	}
	dev := Profile{Name: ProfileDev, Image: "node:22", Network: "bridge", Helper: true, Mount: true}
	if got := dev.Info(); got.Isolated {
		t.Errorf("헬퍼가 있는데 경계로 보고됐다: %+v", got)
	}
	// 헬퍼가 없어도 네트워크가 열려 있으면 경계라 말할 수 없다.
	netOnly := Profile{Name: "x", Image: "alpine", Network: "bridge"}
	if netOnly.Info().Isolated {
		t.Error("네트워크가 열렸는데 경계로 보고됐다")
	}
}
