package sandbox

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"strconv"
)

// ProfilesFileName 은 프로파일 정의 파일이다. 인스턴스 홈에 놓인다.
const ProfilesFileName = "sandbox.json"

// ContainerWorkdir 은 마운트한 작업 디렉터리가 컨테이너 안에서 갖는 자리다.
//
// 호스트 경로를 그대로 쓰지 않는 것은 이식성 때문이다. `C:\src\app` 이나
// `/Users/…` 는 리눅스 컨테이너 안에서 의미가 없고, 게스트가 항상 리눅스라는
// 전제(NFR-SBX-1)가 여기서 한 자리를 고정할 수 있게 해 준다.
const ContainerWorkdir = "/work"

// profileFile 은 정의 파일의 한 항목이다.
type profileFile struct {
	Image string `json:"image"`
	// Ports 는 숫자와 문자열이 섞인다 — 3000 과 "5173-5180" 을 한 목록에 쓰는
	// 것이 자연스럽다.
	Ports []any `json:"ports"`
}

// LoadProfiles 는 사용할 수 있는 프로파일을 낸다 (FR-SBX-4).
func LoadProfiles(path string, read func(string) ([]byte, error)) (map[string]Profile, error) {
	return loadProfiles(path, read, os.UserHomeDir)
}

// loadProfiles 는 사용자 홈 해석까지 주입받는 안쪽이다.
//
// 파일이 없는 것은 오류가 아니다 — 샌드박스를 쓰지 않는 것이 기본이다. 그러나
// 있는데 깨진 것은 오류다. 그것을 "정의 없음" 으로 넘기면 사용자는 자기 설정이
// 무시된 줄 모른 채 프로파일이 없다는 말만 듣는다.
func loadProfiles(path string, read func(string) ([]byte, error),
	home func() (string, error)) (map[string]Profile, error) {

	blob, err := read(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[string]Profile{ProfileScratch: Scratch()}, nil
		}
		return nil, fmt.Errorf("샌드박스 프로파일 정의를 읽을 수 없습니다(%s): %w", path, err)
	}
	cfg, err := ParseConfig(blob, home)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return cfg.Profiles(), nil
}

// normalizePorts 는 숫자와 문자열이 섞인 목록을 문자열로 고른다.
func normalizePorts(profile string, in []any) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, v := range in {
		switch t := v.(type) {
		case float64:
			if t != math.Trunc(t) || t < 1 || t > 65535 {
				return nil, fmt.Errorf("%q 프로파일의 포트가 범위를 벗어났습니다: %v", profile, t)
			}
			out = append(out, strconv.Itoa(int(t)))
		case string:
			if t == "" {
				return nil, fmt.Errorf("%q 프로파일에 빈 포트가 있습니다", profile)
			}
			out = append(out, t)
		default:
			return nil, fmt.Errorf("%q 프로파일의 포트를 해석할 수 없습니다: %v", profile, v)
		}
	}
	return out, nil
}

// ProfileInfo 는 화면에 보일 프로파일 요약이다.
type ProfileInfo struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	// Isolated 는 이 프로파일이 격리 **경계**인가다 (FR-SBX-23).
	Isolated bool `json:"isolated"`
	Helper   bool `json:"helper"`
	// Workspace 는 이 프로파일이 동적 마운트(작업 폴더)를 받는가다 —
	// 화면이 폴더를 물어야 할지 판단하는 근거다 (FR-SBX-40).
	Workspace bool     `json:"workspace"`
	Ports     []string `json:"ports,omitempty"`
}

// Info 는 표시용 요약을 낸다.
//
// 격리 등급을 **정책에서 파생**하는 것이 요점이다. 손으로 적어 두면 정책이
// 바뀔 때 표기가 따라오지 않고, 그 어긋남은 "격리된 줄 알았다" 로 끝난다
// (FR-SBX-24).
func (p Profile) Info() ProfileInfo {
	return ProfileInfo{
		Name: p.Name, Image: p.Image,
		// 마운트가 하나라도 있으면 경계가 아니다. 읽기 전용이어도 그 폴더의
		// 내용은 유출되며, "여기서 무슨 일이 나도 호스트는 무사하다" 가 경계라는
		// 말이 사용자에게 뜻하는 바다 (FR-SBX-39b).
		Isolated:  !p.Helper && p.Network == "none" && !p.Workspace && len(p.BaseMounts) == 0,
		Helper:    p.Helper,
		Workspace: p.Workspace,
		Ports:     p.Ports,
	}
}
